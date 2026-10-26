/*
 * JobToFill — in-page API, injected on demand into every frame of a tab.
 * The service worker calls globalThis.__jtf.<method>() through
 * scripting.executeScript; nothing runs until you ask for it.
 */
(function (root) {
  'use strict';
  if (root.__jtf) return;
  const JTF = root.JTF;
  const U = JTF.util;

  // history: what fills and the AI's answers changed since the last Undo, each field once (see remember);
  // pending: the questions left empty for the AI, by an id never given to another (see pendingQuestions), and
  // `asked` how many ids were handed out; hold: keeps the background awake.
  // aiFilled: field -> the answer the AI put there (remembered with the application, so not "learnt" again).
  // attached: upload -> the file names a fill put there, by type (a new letter takes the place of the one before).
  const state = {
    history: [],
    overlay: null,
    ui: null,
    pending: new Map(),
    asked: 0,
    hold: null,
    aiFilled: new WeakMap(),
    attached: new WeakMap(),
  };

  // This copy of the script's own mark on the ids it hands out: one injected after the page changed doesn't reuse
  // an earlier copy's.
  const RUN = Math.random().toString(36).slice(2, 8);

  /**
   * Add what a fill or the AI changed to what Undo takes back: everything since the last Undo, each field to what it
   * held before it was first changed. A second fill (Fill pressed again, Quick apply's second fill) adds to the
   * first's instead of taking its place, and a field both changed goes back to what the person had.
   */
  function remember(entries) {
    // Boxes gone from the page (a step of a multi-step application left behind) have nothing to put back.
    state.history = state.history.filter((h) => h.el.isConnected);
    const known = new Set(state.history.map((h) => h.el));
    for (const h of entries) {
      if (known.has(h.el) || !h.el.isConnected) continue;
      known.add(h.el);
      state.history.push(h);
    }
  }

  // Fills, the AI's answers, Undo and clicks on the page's own buttons take turns in this frame: Fill pressed again
  // while the first is still typing (or Quick apply's second fill while the AI writes) waits for it rather than
  // filling the same boxes at once. One stuck for two minutes stops holding up the next.
  const TURN_WAIT = 120000;
  let turn = Promise.resolve();

  /** `fn`, run once every earlier call made through serial() has finished (or TURN_WAIT has passed). */
  function serial(fn) {
    return (...args) => {
      const before = turn;
      const run = new Promise((resolve) => {
        const timer = setTimeout(resolve, TURN_WAIT);
        before.then(() => {
          clearTimeout(timer);
          resolve();
        });
      }).then(() => fn(...args));
      turn = run.catch(() => {});
      return run;
    };
  }

  function send(message) {
    return JTF.api.runtime.sendMessage(message).catch((err) => ({ error: String((err && err.message) || err) }));
  }

  function scan(profile) {
    const fields = JTF.dom.collect(document);
    const planned = JTF.matcher.plan(
      fields.map((f) => f.desc),
      profile,
    );
    splitBoxes(fields, planned.results);
    // A follow-up box knows the list it follows ("Please specify" after "How did you hear about us?").
    for (const r of planned.results) if (r && r.follows != null) r.followsField = fields[r.follows];
    return { fields, results: planned.results, context: planned.context };
  }

  // Numbers written over several short boxes, by what the first box asks for.
  const PHONE_PART = /^phone(\.national)?$/;
  const SPLIT_FAMILIES = [PHONE_PART, /^cc\.number$/, /^address\.postalCode$/];
  const SHORT_BOXES = new Set(['text', 'tel', 'number']);

  // A part that is one piece of a date (month, year…); a phone's "whole" or "national" says which number, not a piece.
  const datePart = (r) => !!r.part && r.part !== 'whole' && r.part !== 'national';

  /** Do two boxes sit in the same small row: a common ancestor within three levels of both? */
  function sameRow(a, b) {
    for (let x = a.parentElement, i = 0; x && i < 3; x = x.parentElement, i++) {
      if (!x.contains(b)) continue;
      for (let y = b.parentElement, j = 0; y && j < 3; y = y.parentElement, j++) if (y === x) return true;
      return false;
    }
    return false;
  }

  /**
   * A number split over short boxes in one row: "(___) ___-____" for a US phone, a card number in fours, a ZIP code
   * and its +4. The first box is recognised, the next are short boxes beside it that ask for nothing else (or for
   * part of the same: "Prefix" in a phone row); each gets `segment`: its place and every box's length.
   */
  function splitBoxes(fields, results) {
    for (let i = 0; i < fields.length; i++) {
      const r = results[i];
      const family = r && r.type && !datePart(r) && SPLIT_FAMILIES.find((re) => re.test(r.type));
      const short = (k) => SHORT_BOXES.has(fields[k].kind) && fields[k].el.maxLength > 0 && fields[k].el.maxLength <= 5;
      if (!family || !short(i)) continue;
      // A box beside it with no label of its own is part of the same answer, whatever its screen-reader name makes
      // it look like ("Prefix", the middle three digits of a US number, reads like Mr or Ms).
      const joins = (k) => {
        const other = results[k];
        if (!other || !other.type) return true;
        if (datePart(other)) return false;
        return (
          family.test(other.type) ||
          (family === PHONE_PART && /^phone/.test(other.type)) ||
          !fields[k].desc.signals.label
        );
      };
      const group = [i];
      for (let j = i + 1; j < fields.length && group.length < 8 && short(j); j++) {
        if (!joins(j)) break;
        if (!sameRow(fields[j - 1].el, fields[j].el)) break;
        group.push(j);
      }
      if (group.length < 2) continue;
      const lengths = group.map((k) => fields[k].el.maxLength);
      group.forEach((k, index) => (results[k] = Object.assign({}, r, { segment: { index, lengths } })));
      i = group[group.length - 1];
    }
  }

  /**
   * One box's slice of a number split over several (see splitBoxes): the digits that fill exactly the first boxes
   * (all of them, or the first ones: a ZIP code without its +4), a phone number's taken without its country code
   * or leading 0 when that is what fits. Null when no way of writing it fits the boxes.
   */
  function segmentValue(v, segment) {
    const digits = (t) => String(t || '').replace(/\D/g, '');
    // Letters too, but for a phone number: a Dutch postcode is "1234" and "AB".
    const ways = [v.kind === 'phone' ? digits(v.text) : String(v.text || '').replace(/[^\p{L}\p{N}]/gu, '')];
    if (v.kind === 'phone') {
      const nat = digits(v.national);
      const code = (String(v.international || '').match(/^\+(\d{1,3})/) || [])[1] || '';
      ways.push(nat, nat.replace(/^0/, ''), digits(v.international));
      if (code) ways.push(digits(v.international).slice(code.length));
    }
    const { index, lengths } = segment;
    for (const d of ways) {
      let at = 0;
      let k = 0;
      for (; k < lengths.length && at < d.length; k++) at += lengths[k];
      if (at !== d.length) continue;
      const start = lengths.slice(0, index).reduce((a, b) => a + b, 0);
      const text = d.slice(start, start + lengths[index]);
      return Object.assign({}, v, { text, kind: 'text', candidates: [text], international: null, national: null });
    }
    return null;
  }

  // Where application pages show the job's location: Greenhouse (new and old boards), Lever, Workday.
  const LOCATION_LINES = [
    '.job__location',
    '#header .location',
    '.posting-categories .location',
    '.posting-header .posting-categories > :first-child',
    '[data-automation-id="locations"] dd',
  ];

  // "This role is based in our Birmingham office.", "The internship will be based in London, UK": the place, in capitals.
  const BASED_IN =
    /\b(?:role|position|job|internship|placement|vacancy|opportunity) (?:is|will be) based (?:in|at|out of|from) (?:our |the )?((?:[A-Z][\w'’-]*,?\s*){1,4})/;

  /**
   * Where the job is, for "Are you authorized to work in the country where this role is based?": what the extension
   * already knew about the job in this tab, else the location line on the application page itself, else its own words.
   */
  function jobLocation(payload) {
    if (payload && payload.jobLocation) return payload.jobLocation;
    try {
      for (const selector of LOCATION_LINES) {
        const el = document.querySelector(selector);
        if (el && el.textContent.trim()) return U.cleanLabel(el.textContent, 200);
      }
      // Ashby: "Location" over it in the side pane.
      for (const h of document.querySelectorAll('.ashby-job-posting-left-pane h2'))
        if (/^location$/i.test(h.textContent.trim()) && h.nextElementSibling)
          return U.cleanLabel(h.nextElementSibling.textContent, 200);
      // A JobPosting's jobLocation in the page's JSON-LD.
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        const block = (s.textContent.match(/"jobLocation"[\s\S]{0,600}/) || [''])[0];
        const part = (key) =>
          (block.match(new RegExp(`"${key}"\\s*:\\s*(?:\\{[^}]*?"name"\\s*:\\s*)?"([^"]+)"`)) || [])[1];
        const where = ['addressLocality', 'addressRegion', 'addressCountry'].map(part).filter(Boolean).join(', ');
        if (where) return where;
      }
      // The posting's own words: "This role is based in our Birmingham office." (Isio, on Teamtailor).
      const said = ((document.body && document.body.textContent) || '').match(BASED_IN);
      const where = said && said[1].replace(/[\s,]+$/, '');
      if (where && JTF.geo.placesNamed(where).length) return where;
    } catch (err) {
      /* nothing to go by */
    }
    return '';
  }

  // Sites choose these for you (Workday, from where your connection seems to be): one that isn't yours is put right.
  const CORRECTED = new Set(['address.country', 'phone.countryCode']);

  function labelFor(field, r) {
    if (r && r.type === 'custom') return U.cleanLabel(JTF.matcher.questionText(field.desc), 60);
    if (r && r.type) return JTF.fields.labelOf(r.type);
    return U.cleanLabel(JTF.matcher.questionText(field.desc), 60) || field.kind;
  }

  /* ------------------------------------------------------------------- UI */

  // Styled through the CSSOM (element.style) rather than <style> tags, so a page's
  // Content-Security-Policy can't strip the toast or the inspect labels.
  const FONT = '13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const STYLES = {
    host: { all: 'initial', position: 'absolute', top: '0', left: '0', width: '0', height: '0', zIndex: '2147483647' },
    toast: {
      position: 'fixed',
      right: '16px',
      bottom: '16px',
      // Never wider than a phone's screen, less its margins.
      maxWidth: 'min(360px, calc(100vw - 32px))',
      boxSizing: 'border-box',
      display: 'flex',
      gap: '10px',
      alignItems: 'flex-start',
      padding: '12px 10px 12px 14px',
      borderRadius: '12px',
      // The light edge keeps it apart from a dark page.
      border: '1px solid rgba(255, 255, 255, 0.16)',
      background: '#17142b',
      color: '#f4f2ff',
      font: FONT,
      textAlign: 'left',
      overflowWrap: 'anywhere',
      boxShadow: '0 10px 30px rgba(0, 0, 0, 0.3)',
      opacity: '0',
      transform: 'translateY(8px)',
      transition: 'opacity 0.18s, transform 0.18s',
    },
    dot: { flex: 'none', width: '10px', height: '10px', marginTop: '4px', borderRadius: '50%', background: '#8b74ff' },
    message: { flex: '1', minWidth: '0', whiteSpace: 'pre-line' },
    button: {
      all: 'unset',
      flex: 'none',
      cursor: 'pointer',
      color: '#c9bfff',
      fontWeight: '600',
      marginLeft: '4px',
      padding: '0 2px',
      borderRadius: '4px',
      font: FONT,
    },
    close: {
      all: 'unset',
      flex: 'none',
      cursor: 'pointer',
      width: '20px',
      height: '20px',
      marginTop: '-1px',
      borderRadius: '4px',
      color: '#c9c4e0',
      font: '18px/20px system-ui, sans-serif',
      textAlign: 'center',
    },
    tag: {
      position: 'absolute',
      maxWidth: '260px',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      padding: '1px 6px',
      borderRadius: '6px',
      font: '600 11px/16px system-ui, sans-serif',
      color: '#fff',
      whiteSpace: 'nowrap',
      pointerEvents: 'none',
      boxShadow: '0 1px 3px rgba(0, 0, 0, 0.3)',
    },
  };
  const TAG_COLORS = { ok: '#16a34a', empty: '#d97706', secret: '#7c3aed', unknown: '#6b7280' };

  function make(tag, style, text) {
    const node = document.createElement(tag);
    Object.assign(node.style, style);
    if (text != null) node.textContent = text;
    return node;
  }

  function ui() {
    if (state.ui && state.ui.host.isConnected) return state.ui;
    const host = make('jobtofill-ui', STYLES.host);
    host.setAttribute('data-jtf-ui', '');
    const shadow = host.attachShadow({ mode: 'closed' });
    const layer = make('div', {});
    shadow.append(layer);
    (document.body || document.documentElement).append(host);
    state.ui = { host, shadow, layer, toast: null };
    return state.ui;
  }

  /** A toast button the keyboard can see: the page's CSS can't reach in here, so the ring is drawn by hand. */
  function toastButton(style, text, label, onClick) {
    const button = make('button', style, text);
    button.type = 'button';
    if (label) button.setAttribute('aria-label', label);
    if (label) button.title = label;
    button.addEventListener('click', onClick);
    button.addEventListener('focus', () => Object.assign(button.style, { outline: '2px solid #c9bfff' }));
    button.addEventListener('blur', () => Object.assign(button.style, { outline: 'none' }));
    button.addEventListener('mouseenter', () => Object.assign(button.style, { color: '#ffffff' }));
    button.addEventListener('mouseleave', () => Object.assign(button.style, { color: style.color }));
    return button;
  }

  function toast(message, opts) {
    const view = ui();
    if (view.toast) view.toast.remove();
    const box = make('div', STYLES.toast);
    box.setAttribute('role', 'status');
    box.append(make('span', STYLES.dot), make('span', STYLES.message, message));
    // Each toast its own timer: one that was replaced only ever removes itself.
    let timer = null;
    const close = () => {
      clearTimeout(timer);
      box.remove();
    };
    if (opts && opts.undo && state.history.length)
      box.append(
        toastButton(STYLES.button, 'Undo', null, () => {
          api.undo();
          close();
        }),
      );
    // It can sit over the page's own buttons (Workday's "Next" bar), or stay up for minutes while the AI works.
    box.append(toastButton(STYLES.close, '×', 'Dismiss', close));
    view.shadow.append(box);
    view.toast = box;
    requestAnimationFrame(() => Object.assign(box.style, { opacity: '1', transform: 'none' }));
    // Held while the pointer or focus is on it, so there's time to read it and reach Undo.
    let left = (opts && opts.duration) || 6000;
    let since = 0;
    const arm = () => {
      if (timer || box.matches(':hover, :focus-within')) return;
      since = Date.now();
      timer = setTimeout(close, left);
    };
    const hold = () => {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
      left = Math.max(2500, left - (Date.now() - since));
    };
    box.addEventListener('mouseenter', hold);
    box.addEventListener('focusin', hold);
    // After the event, when :hover and :focus-within have caught up.
    box.addEventListener('mouseleave', () => setTimeout(arm));
    box.addEventListener('focusout', () => setTimeout(arm));
    arm();
    return true;
  }

  /* ----------------------------------------------------------------- fill */

  async function documentValue(type, payload, cache) {
    const which = JTF.fields.DEFS[type].file;
    if (!payload.docs || !payload.docs[which]) return null;
    if (!(which in cache)) {
      const res = await send({ type: 'jtf:document', which });
      cache[which] = res && res.dataUrl ? res : null;
    }
    return cache[which] ? { text: cache[which].name, kind: 'file', document: cache[which], candidates: [] } : null;
  }

  // A file the page lists as taken ("Ada_Lovelace_CV.pdf Successfully Uploaded!").
  const FILE_NAME = /[\w)\]-]\.(pdf|docx?|rtf|odt|txt|pages)\b/i;

  /** An upload's container (its drop zone, label and the files it lists): up to where other fields start. */
  function uploadBox(el) {
    let box = el.parentElement || el;
    for (let a = box, n = 0; a && a !== document.body && n < 6; a = a.parentElement, n++) {
      const others = a.querySelectorAll('input:not([type="hidden"]), select, textarea');
      if (Array.from(others).some((c) => c !== el)) break;
      box = a;
    }
    return box;
  }

  /** Does an upload's box show this document as taken (by its name, as a drop zone lists what it uploaded)? */
  function shows(text, doc) {
    const name = U.normalize(String(doc.name || '').replace(/\.[a-z0-9]+$/i, ''));
    return !!name && U.normalize(text).includes(name);
  }

  /** Wait until the page stops changing (an uploaded CV being parsed), for at most `max` ms. */
  function settle(max = 2500, quiet = 500) {
    return new Promise((resolve) => {
      let timer = null;
      let cap = null;
      const observer = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(done, quiet);
      });
      function done() {
        observer.disconnect();
        clearTimeout(timer);
        clearTimeout(cap);
        resolve();
      }
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      timer = setTimeout(done, quiet);
      cap = setTimeout(done, max);
    });
  }

  /**
   * Watch for this page going away once a fill has put a document in (iCIMS's résumé box sends the whole profile form
   * the moment a file is chosen, to read the CV): the background is told at once, with the documents put in
   * (`attached`, by type), so it fills the page that comes back; `gone()` is what it was told, null till then.
   * Unhooked by fill().
   */
  function leaveWatch(attached) {
    let gone = null;
    const onLeave = () => {
      if (gone || !attached.size) return;
      // This page's own start, so the background tells the one that comes back from it.
      gone = { docs: [...attached], loadedAt: performance.timeOrigin };
      send({ type: 'jtf:reloading', ...gone });
    };
    window.addEventListener('beforeunload', onLeave);
    window.addEventListener('pagehide', onLeave);
    state.leave = () => {
      window.removeEventListener('beforeunload', onLeave);
      window.removeEventListener('pagehide', onLeave);
    };
    return { gone: () => gone };
  }

  /**
   * The form's education, job and language entries past those your profile lists that hold something already (iCIMS's
   * reading of a CV of one degree and a school made three education entries): said, as yours to check or remove.
   */
  function extraEntries(fields, results, profile) {
    const out = [];
    for (const [g, mine, one, many] of [
      ['edu.', (profile.education || []).length, 'Education entry', 'Education entries'],
      ['exp.', (profile.experience || []).length, 'Job entry', 'Job entries'],
      ['lang.', JTF.fields.languageEntries(profile).length, 'Language entry', 'Language entries'],
    ]) {
      const held = new Set();
      results.forEach((r, i) => {
        if (r && r.entry && r.type && r.type.startsWith(g) && (r.index || 0) >= mine && JTF.fill.hasValue(fields[i]))
          held.add((r.index || 0) + 1);
      });
      if (!mine || !held.size) continue;
      const nums = [...held].sort((a, b) => a - b);
      const last = nums.pop();
      out.push(
        nums.length
          ? `${many} ${nums.join(', ')} and ${last} aren’t in your profile: check what they hold, or remove them.`
          : `${one} ${last} isn’t in your profile: check what it holds, or remove it.`,
      );
    }
    return out;
  }

  /** Fill the page; what it changed joins what Undo takes back, even when it stops part-way with an error. */
  async function fill(payload) {
    const history = [];
    try {
      return await fillPage(payload, history);
    } finally {
      remember(history);
      if (state.leave) state.leave();
      state.leave = null;
    }
  }

  async function fillPage(payload, history) {
    const { profile, settings } = payload;
    state.profile = profile;
    // A CAPTCHA's own frame (reCAPTCHA's "I'm not a robot" box): nothing in it is ever touched.
    if (JTF.accounts.isCaptchaFrame(location.href))
      return { url: location.href, frame: 'captcha', filled: 0, detected: 0 };
    // A page the account flow landed on after one of its clicks (the application after signing in) is still drawing
    // its form: it is filled once it has gone quiet.
    if (payload.settleFirst) await settle(4000, 800);
    let scanned = await scanWhenDrawn(profile);
    // Room for each of your education and job entries first: a section's own "Add" (Workday's My Experience starts
    // with none), then the page is read again.
    if (!payload.only && scanned.context.jobContext && (await JTF.flow.addEntries(profile, () => scan(profile)))) {
      await settle(1500, 300);
      scanned = scan(profile);
    }
    const { fields, results, context } = scanned;
    context.jobLocation = jobLocation(payload);
    const hosts = { applicationHosts: payload.applicationHosts };
    const page = JTF.flow.analyze({ fields, results }, hosts);
    // A step of nothing the rules know, on an application's address (iCIMS's "Job Specific Questions"): its questions
    // are the job's, for the AI.
    if (page.byAddress) context.jobContext = true;
    // On a pure sign-up page in an account flow, the sign-up form's own terms box is part of creating the account.
    const accountTerms = !!payload.accountFlow && page.kind === 'signup' && page.pure;

    // A username box alone needs nothing more; password and card boxes ask the background for theirs.
    const needs = {
      password: results.some((r) => r && r.type && r.type.startsWith('account.pass')),
      card: results.some((r) => r && r.type && r.type.startsWith('cc.')),
    };
    const notes = extraEntries(fields, results, profile);
    let secrets = null;
    if (needs.password || needs.card) {
      secrets = await send({
        type: 'jtf:secrets',
        password: needs.password ? (context.signup ? 'signup' : 'login') : null,
        card: needs.card,
        // What the sign-up page says its password must be, so a new one fits it.
        rules: needs.password && context.signup ? passwordRules(fields, results) : null,
        portal: JTF.flow.portal(),
      });
      if (secrets && secrets.error) notes.push(secrets.error);
      if (secrets && secrets.notes) notes.push(...secrets.notes);
    }

    const report = {
      url: location.href,
      host: location.hostname,
      title: document.title,
      top: isTop(),
      jobContext: context.jobContext,
      detected: 0,
      filled: 0,
      skipped: 0,
      failed: 0,
      missing: [],
      missingTypes: [],
      unmatched: [],
      notes,
      unknown: 0,
      consents: 0,
      ticked: 0,
      held: 0,
      docs: {},
      wantsLetter: false,
      passwordSource: (secrets && secrets.credential && secrets.credential.source) || null,
    };
    // Attaching a cover letter fills just those fields, replacing whatever is in them.
    const only = payload.only ? new Set(payload.only) : null;
    // Quick apply: `hold` leaves the CV and letter for later (they are still being written); `replace` puts
    // the tailored ones in place of whatever an earlier fill or the person attached.
    const hold = payload.hold ? new Set(payload.hold) : null;
    const replace = payload.replace ? new Set(payload.replace) : null;
    // A document asked for anew by this fill (the letter Quick apply or the studio just wrote, a tailored CV).
    const askedAnew = (t) => !!((payload.force && only && only.has(t)) || (replace && replace.has(t)));
    // The documents put in before the page sent itself away to read them (iCIMS's résumé box): never a second time.
    const attachedBefore = new Set(payload.attached || []);
    // What this fill puts in; an upload that sends the page away stops the fill (see leaveWatch).
    const attached = new Set();
    const leave = leaveWatch(attached);
    const docCache = {};
    // What the fill decides with besides the page: the passwords and cards it was given, and whether it ticks
    // acknowledgements (a sign-up page's own terms box, in an account flow).
    const extra = { secrets, consents: !!settings.consents || accountTerms };
    const valueFor = async (field, r, def) => {
      if (def && def.file) return documentValue(r.type, payload, docCache);
      return JTF.fields.resolve(r.type, profile, JTF.decide.contextOf(field.desc, r, context, extra));
    };
    // Files first: sites like Breezy and Lever read an uploaded CV and rewrite the form, which would
    // wipe answers filled before it. The rest is filled once the page has settled.
    const order = fields.map((f, i) => i).sort((a, b) => (fields[b].kind === 'file') - (fields[a].kind === 'file'));
    let uploaded = false;
    let settled = false;

    // Upload tiles that make their file box only once "Upload from Device" is chosen (SuccessFactors): first too.
    const tiles = JTF.fill.uploadTriggers(document).map((tile) => ({ tile, r: JTF.matcher.classify(tile.desc) }));
    // The uploads the form has, by type: your letter goes into your CV's upload only when the form has no letter upload.
    const uploadTypes = new Set(
      [...results, ...tiles.map((t) => t.r)]
        .filter((r) => r && r.type && JTF.fields.DEFS[r.type] && JTF.fields.DEFS[r.type].file)
        .map((r) => r.type),
    );
    const carriedBy = (field, r) =>
      JTF.decide.carriedBy(
        field.desc,
        r,
        profile,
        uploadTypes,
        (t) => !!(payload.docs && payload.docs[JTF.fields.DEFS[t].file]),
      );
    for (const { tile, r } of tiles) {
      const def = r && JTF.fields.DEFS[r.type];
      if (!def || !def.file) continue;
      if (r.type === 'file.coverLetter') report.wantsLetter = true;
      if (only && !only.has(r.type)) continue;
      if (hold && hold.has(r.type)) {
        report.held++;
        continue;
      }
      report.detected++;
      if (attachedBefore.has(r.type)) {
        report.skipped++;
        continue;
      }
      const label = JTF.fields.labelOf(r.type);
      const v = await documentValue(r.type, payload, docCache);
      if (!v) {
        report.missing.push(label);
        report.missingTypes.push(r.type);
        continue;
      }
      const started = Date.now();
      const res = await JTF.fill.attachVia(tile, v.document, { history });
      traceStep({ el: tile.el, kind: 'file', desc: tile.desc }, r, v, res, started, 'upload menu');
      report.docs[r.type] = res.status === 'filled' ? 'filled' : report.docs[r.type] || res.status;
      if (res.status === 'filled') {
        report.filled++;
        uploaded = true;
        attached.add(r.type);
        if (settings.highlight !== false) JTF.fill.highlight(res.target);
        if (!res.confirmed) notes.push(`Check that your ${label.toLowerCase()} finished uploading.`);
      } else {
        report.failed++;
        report.unmatched.push(label);
        notes.push(`Couldn’t put your ${label.toLowerCase()} into its upload box: attach it by hand.`);
      }
    }
    // Exactly which fields were filled (a follow-up box can share its type with the question it follows), and
    // which already had an answer (an earlier fill's): a CV parse that clears either gets them put back.
    const filledKeys = new Set();
    const keptKeys = new Set();
    // What went in, to read back once the page has settled (see recheck).
    const written = [];
    // Lists that had nothing for you, perhaps because their options follow an earlier answer (see below).
    const waiting = [];
    /**
     * Your CV's upload that takes several files (`types`: the CV, then your letter and transcript): an empty box gets
     * them all in one go. One that already has files only gets what must go in anew (the letter just written, a
     * tailored CV: `only`, `replace`, Overwrite), never your CV a second time: a drop zone that uploads and empties
     * its file box (Workday) gets just the new files, a plain file box keeps what it holds beside them (or, for a new
     * CV, takes the whole set again).
     */
    const fillUpload = async (field, types, label) => {
      if (attachedBefore.has('file.resume')) {
        report.skipped++;
        return 'skipped';
      }
      const docs = {};
      for (const t of types) {
        const v = await documentValue(t, payload, docCache);
        if (v) docs[t] = v.document;
      }
      if (!docs['file.resume']) {
        report.missing.push(label);
        report.missingTypes.push('file.resume');
        return null;
      }
      const have = types.filter((t) => docs[t]);
      // Asked for anew by this fill, or by Overwrite.
      const renew = have.filter((t) => settings.overwrite || askedAnew(t));
      const el = field.el;
      const kept = (el.files && el.files.length) || 0;
      const text = uploadBox(el).textContent || '';
      let put = have;
      let keep = false;
      if (kept || FILE_NAME.test(text)) {
        if (kept) {
          put = renew.includes('file.resume') ? have : renew;
          keep = !renew.includes('file.resume');
        } else put = renew.filter((t) => askedAnew(t) || !shows(text, docs[t]));
        if (!put.length) {
          report.skipped++;
          return 'skipped';
        }
      }
      // A plain file box keeps what it holds, but the letter a fill put there before gives way to the new one.
      const before = state.attached.get(el) || {};
      const v = {
        text: put.map((t) => docs[t].name).join(', '),
        kind: 'file',
        documents: put.map((t) => docs[t]),
        keep: keep ? { except: put.map((t) => before[t]).filter(Boolean) } : null,
      };
      const started = Date.now();
      const res = await JTF.fill.apply(field, v, {
        overwrite: true,
        comboboxes: settings.comboboxes !== false,
        history,
      });
      traceStep(field, { type: types.join('+') }, v, res, started, 'fill');
      for (const t of put) report.docs[t] = res.status === 'filled' ? 'filled' : report.docs[t] || res.status;
      if (res.status === 'filled') {
        state.attached.set(el, Object.assign({}, before, ...put.map((t) => ({ [t]: docs[t].name }))));
        put.forEach((t) => attached.add(t));
        report.filled++;
        uploaded = true;
        if (settings.highlight !== false) JTF.fill.highlight(res.target || el);
      } else {
        report.failed++;
        report.unmatched.push(label);
      }
      return res.status;
    };
    /** Fill one field from the profile; `count` adds what it asks about to the report's lists. */
    const fillOne = async (field, r, { count = true } = {}) => {
      // The page is on its way out (an upload sent it to be read): the one it comes back as is filled instead.
      if (leave.gone()) return null;
      if (!r || !r.type) {
        if (count) report.unknown++;
        return null;
      }
      if (r.type === 'file.coverLetter' || r.type === 'coverLetter') report.wantsLetter = true;
      // Your CV's upload that takes your letter too is in a fill of just the letter, and held with either.
      const carried = carriedBy(field, r);
      if (only && !carried.some((t) => only.has(t))) return null;
      if (hold && carried.some((t) => hold.has(t))) {
        report.held++;
        return null;
      }
      report.detected++;
      const def = JTF.fields.DEFS[r.type];
      const label = labelFor(field, r);
      if (carried.length > 1) return fillUpload(field, carried, label);
      if (field.kind === 'file' && attachedBefore.has(r.type)) {
        report.skipped++;
        return 'skipped';
      }
      const question = U.normalize(JTF.matcher.questionText(field.desc));
      // "I'm not a robot" is only ticked when no CAPTCHA stands behind it.
      if (r.type === 'human' && JTF.flow.captcha(document)) return null;
      if (uploaded && !settled && field.kind !== 'file') {
        await settle();
        settled = true;
        if (leave.gone()) return null;
      }
      const followed = r.followsField ? JTF.fill.currentValue(r.followsField) : null;
      const d = JTF.decide.field(field.desc, r, profile, context, { ctx: extra, followed });
      if (d.action === 'consent') {
        if (!JTF.fill.hasValue(field)) report.consents++;
        return null;
      }
      // An upload for a level you haven't studied at, an opt-in, a follow-up that isn't for you: nothing to do.
      if (!d.unresolved && (d.action === 'skip' || d.action === 'leave')) return null;
      let v = d.action === 'upload' ? await valueFor(field, r, def) : d.value;
      // A box that holds part of a number (see splitBoxes) gets its part, or nothing when the number doesn't fit.
      if (v && r.segment) {
        v = segmentValue(v, r.segment);
        if (!v || !v.text) return null;
      }
      if (!v) {
        // A document you haven't added is missing too; what the profile leaves empty on purpose isn't.
        if (count && d.action !== 'leave') {
          report.missing.push(label);
          report.missingTypes.push(r.type);
        }
        traceStep(field, r, null, { status: 'nothing to put' }, 0, 'fill');
        return null;
      }
      // An upload that lists this very file as taken (iCIMS shows the CV it read, its file box empty again): not again,
      // unless asked for anew.
      if (
        field.kind === 'file' &&
        v.document &&
        !askedAnew(r.type) &&
        shows(uploadBox(field.el).textContent || '', v.document)
      ) {
        report.skipped++;
        return 'skipped';
      }
      const started = Date.now();
      const res = await JTF.fill.apply(field, v, {
        overwrite: settings.overwrite || !!payload.force || !!(replace && replace.has(r.type)),
        correct: CORRECTED.has(r.type),
        comboboxes: settings.comboboxes !== false,
        history,
      });
      traceStep(field, r, v, res, started, 'fill');
      if ((def && def.file) || r.type === 'coverLetter')
        report.docs[r.type] = res.status === 'filled' ? 'filled' : report.docs[r.type] || res.status;
      if (res.status === 'filled') {
        report.filled++;
        if (def && def.consent) report.ticked++;
        if (field.kind === 'file') {
          uploaded = true;
          attached.add(r.type);
        } else filledKeys.add(keyOf(r, question));
        if (res.check) written.push({ field, v, check: res.check, label, key: keyOf(r, question) });
        if (settings.highlight !== false) JTF.fill.highlight(res.target || field.el);
      } else if (res.status === 'skipped') {
        report.skipped++;
        if (field.kind !== 'file' && res.reason === 'has value') keptKeys.add(keyOf(r, question));
      } else {
        report.failed++;
        report.unmatched.push(label);
        if (res.status === 'nomatch' && field.kind === 'select')
          waiting.push({ field, r, label, options: optionsKey(field) });
      }
      return res.status;
    };
    // The country goes in first, and the page is read again once it has: the address fields below it follow the
    // country (Workday shows "Province" and "City (Comune)" for Italy, "County" and "City" for the United Kingdom).
    let todo = order.map((i) => [fields[i], results[i]]);
    const countries = todo.filter(([, r]) => r && r.type === 'address.country');
    const done = new Set(countries.map(([field]) => field.el));
    let moved = false;
    for (const [field, r] of countries) if ((await fillOne(field, r)) === 'filled') moved = true;
    if (moved) {
      await settle(2500, 400);
      let again = scan(profile);
      // Workday hides the whole form for a moment while it draws the new country's address fields: read it once it
      // is back.
      for (let waited = 0; again.fields.length < fields.length / 2 && waited < 8000; waited += 300) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        again = scan(profile);
      }
      if (again.fields.length < fields.length / 2) await settle(1500, 300);
      const known = new Set(fields.map((f) => f.el));
      fields.push(...again.fields.filter((field) => !known.has(field.el)));
      todo = again.fields
        .map((field, i) => [field, again.results[i]])
        .sort(([a], [b]) => (b.kind === 'file') - (a.kind === 'file'));
    }
    for (const [field, r] of todo) if (!done.has(field.el)) await fillOne(field, r);
    // An upload sent the page away to be read (iCIMS's résumé box): the background fills the page it comes back as.
    if (leave.gone()) return Object.assign(report, { reloading: leave.gone(), undoable: false });

    // A late CV parse can still clear or re-render fields after they were filled (by this fill or an earlier
    // one, as Quick apply's details go in before its CV): fill those again.
    if (uploaded && (filledKeys.size || keptKeys.size)) {
      await settle();
      const again = scan(profile);
      for (let i = 0; i < again.fields.length; i++) {
        const field = again.fields[i];
        const r = again.results[i];
        if (!r || !r.type || field.kind === 'file' || JTF.fill.hasValue(field)) continue;
        if (hold && hold.has(r.type)) continue;
        const question = U.normalize(JTF.matcher.questionText(field.desc));
        const key = keyOf(r, question);
        if (!filledKeys.has(key) && !keptKeys.has(key)) continue;
        const def = JTF.fields.DEFS[r.type];
        if (def && def.consent && !settings.consents) continue;
        const v = await valueFor(field, r, JTF.fields.DEFS[r.type]);
        if (!v) continue;
        const res = await JTF.fill.apply(field, v, {
          overwrite: false,
          comboboxes: settings.comboboxes !== false,
          history,
        });
        if (res.status === 'filled') {
          report.restored = (report.restored || 0) + 1;
          if (settings.highlight !== false) JTF.fill.highlight(res.target || field.el);
        }
      }
    }
    // Answers can reveal more questions: the ethnicity subgroup once the group is picked, "If yes,
    // please give details", the country once "Yes, I need sponsorship" is chosen. Fill fields that
    // weren't on the page before, a couple of rounds at most.
    const seen = new Set(fields.map((f) => f.el));
    for (let round = 0; round < 2 && (filledKeys.size || uploaded || waiting.length); round++) {
      await settle(1500, 300);
      const next = scan(profile);
      const fresh = next.fields
        .map((field, i) => [field, next.results[i]])
        .filter(([field]) => !seen.has(field.el) && field.kind !== 'file' && !JTF.fill.hasValue(field));
      next.fields.forEach((f) => seen.add(f.el));
      let added = 0;
      for (const [field, r] of fresh) {
        if ((await fillOne(field, r, { count: false })) === 'filled') added++;
      }
      // A list whose options come from an earlier answer (the universities of the country you studied in, a
      // degree's subjects) had none of yours when it was reached: once its options have changed, it is tried again.
      for (const w of waiting.splice(0)) {
        const field = next.fields.find((f) => f.el === w.field.el);
        if (!field || JTF.fill.hasValue(field)) continue;
        if (optionsKey(field) === w.options) {
          waiting.push(w);
          continue;
        }
        const before = { detected: report.detected, failed: report.failed, unmatched: report.unmatched.length };
        const status = await fillOne(field, w.r, { count: false });
        Object.assign(report, { detected: before.detected, failed: before.failed });
        report.unmatched.length = before.unmatched;
        if (status !== 'filled') continue;
        report.failed--;
        report.unmatched.splice(report.unmatched.indexOf(w.label), 1);
        added++;
      }
      report.revealed = (report.revealed || 0) + added;
      if (!added) break;
    }
    const checked = await recheck(written, { profile, settings, history });
    report.check = checked.check;
    if (checked.repaired) report.repaired = checked.repaired;
    if (checked.restored) report.restored = (report.restored || 0) + checked.restored;
    report.missing = [...new Set(report.missing)];
    report.missingTypes = [...new Set(report.missingTypes)];
    report.unmatched = [...new Set(report.unmatched)];
    remember(history);
    report.undoable = state.history.length > 0;
    // Only a job application's leftovers go to the AI (never a checkout's gift message or a sign-up page).
    if (!only && context.jobContext)
      report.pending = await pendingQuestions(profile, context, { peek: !!payload.ai, settings });
    // What kind of page this is now (sign-in, sign-up, emailed code…), for signing in and creating accounts.
    report.account = JTF.flow.analyze(scan(profile), { ignore: payload.accountIgnore, ...hosts });
    return report;
  }

  /** Note what the fill did with a field, for a bug report's snapshot (content/snapshot.js). Never the value. */
  function traceStep(field, r, v, res, started, step) {
    if (!JTF.snapshot || !JTF.snapshot.note) return;
    JTF.snapshot.note(field, {
      step,
      type: (r && r.type) || null,
      source: (r && r.source) || null,
      valueKind: (v && v.kind) || null,
      status: (res && res.status) || null,
      reason: (res && res.reason) || null,
      ms: started ? Date.now() - started : null,
    });
  }

  /**
   * Is this the tab's top frame? Asked of the page's window: in Firefox a content script's global is a sandbox of
   * its own, never the same object as `top`.
   */
  function isTop() {
    try {
      return window.self === window.top;
    } catch (err) {
      return false;
    }
  }

  /** A field's options, to tell when they change. */
  const optionsKey = (field) => (field.desc.options || []).map((o) => o.text).join('|');

  /** Does the page look like it is still drawing itself: loading, a spinner or skeleton showing, next to no text? */
  function stillDrawing() {
    if (document.readyState !== 'complete') return true;
    const busy = document.querySelector(
      '[aria-busy="true"], [role="progressbar"], [class*="spinner" i], [class*="skeleton" i], [class*="loading" i], [class*="loader" i]',
    );
    if (busy && JTF.dom.isVisible(busy)) return true;
    return !document.body || document.body.innerText.trim().length < 200;
  }

  /**
   * Scan the page, but one still drawing its form (a single-page application fetching its questions when Fill is
   * pressed) first gets a few seconds to show it, and a moment more to finish once fields appear.
   */
  async function scanWhenDrawn(profile) {
    let found = scan(profile);
    if (found.fields.length || !isTop() || !stillDrawing()) return found;
    for (let waited = 0; waited < 4000 && !found.fields.length && stillDrawing(); waited += 200) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      found = scan(profile);
    }
    if (!found.fields.length) return found;
    await settle(1200, 250);
    return scan(profile);
  }

  // One question's identity across re-renders: what it asks for and how it is worded.
  const keyOf = (r, question) =>
    [r.type, r.index || 0, r.part || '', r.segment ? r.segment.index : '', question].join('|');

  /**
   * Read back what a fill wrote (`written`: { field, v, check, label, key }) once the page has settled, and put right
   * what didn't hold: a box a re-render made anew gets its answer again, one emptied or put back gets it typed or
   * pasted, one whose rules or messages turn it down ("Please enter a valid phone number") gets it written another
   * way. What is still wrong is outlined in red and listed (`check`), with what the page says when it says something.
   */
  async function recheck(written, { profile, settings, history }) {
    const out = { check: [], repaired: 0, restored: 0 };
    if (!written.length) return out;
    await settle(1200, 150);
    const opts = { comboboxes: settings.comboboxes !== false, history };
    let fresh = null;
    for (const w of written) {
      let field = w.field;
      let res = await JTF.fill.repair(field, w.v, w.check, opts).catch(() => ({ ok: true }));
      if (res.gone) {
        // Made anew (a re-render, a CV parse): the same question, found again, gets the answer if it lost it.
        fresh = fresh || scan(profile);
        const i = fresh.fields.findIndex(
          (f, k) =>
            fresh.results[k] &&
            fresh.results[k].type &&
            keyOf(fresh.results[k], U.normalize(JTF.matcher.questionText(f.desc))) === w.key,
        );
        if (i < 0 || JTF.fill.hasValue(fresh.fields[i])) continue;
        field = fresh.fields[i];
        const again = await JTF.fill.apply(field, w.v, Object.assign({ overwrite: false }, opts));
        if (again.status !== 'filled') continue;
        out.restored++;
        if (settings.highlight !== false) JTF.fill.highlight(again.target || field.el);
        if (!again.check) continue;
        await settle(600, 120);
        res = await JTF.fill.repair(field, w.v, again.check, opts).catch(() => ({ ok: true }));
      }
      if (res.fixed || !res.ok)
        traceStep(
          field,
          null,
          w.v,
          { status: res.ok ? 'repaired' : 'check', reason: res.refused || (res.lost ? 'not kept' : null) },
          0,
          'read back',
        );
      if (res.ok) {
        if (res.fixed) out.repaired++;
        continue;
      }
      if (res.gone) continue;
      const said = res.refused && !/^(marked invalid|not accepted)$/.test(res.refused) ? res.refused : '';
      out.check.push(said ? `${w.label} (“${U.cleanLabel(said, 80)}”)` : w.label);
      if (settings.highlight !== false) JTF.fill.highlight(w.check.targets ? w.check.targets[0] : field.el, 'check');
    }
    return out;
  }

  /**
   * What a sign-up page says about passwords: the help text the box points to, the text of its row, any
   * requirements list in its form, and its minlength / maxlength / pattern.
   */
  function passwordRules(fields, results) {
    const i = results.findIndex((r) => r && r.type === 'account.password');
    if (i < 0) return null;
    const el = fields[i].el;
    const parts = [];
    const text = (n) => (n && (n.innerText || n.textContent)) || '';
    const rootNode = el.getRootNode();
    for (const id of (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean))
      parts.push(text((rootNode.getElementById && rootNode.getElementById(id)) || document.getElementById(id)));
    // The box's own row, up to where other kinds of field start.
    let box = el.parentElement;
    for (let a = el.parentElement, n = 0; a && a !== document.body && n < 6; a = a.parentElement, n++) {
      const others = a.querySelectorAll(
        'input:not([type="hidden"]):not([type="button"]):not([type="submit"]), select, textarea',
      );
      if (Array.from(others).some((o) => o.type !== 'password')) break;
      box = a;
    }
    parts.push(text(box));
    // Requirement lists and "Password must…" sentences anywhere in the form.
    const scope = el.form || document;
    const RULE_TEXT =
      /\bpasswords? (must|should|needs?|requirements?|rules?|criteria|policy|has to|have to)\b|\b(must|should) (be|contain|include|have) at least\b|\bat least \d+ characters\b|\bminimum (of )?\d+ characters\b/i;
    const seen = [];
    for (const n of scope.querySelectorAll('p, li, ul, ol, div, span, small, section')) {
      if (n.querySelector('input, select, textarea') || n.querySelectorAll('*').length > 30) continue;
      if (seen.some((s) => s.contains(n))) continue;
      const t = text(n);
      if (t.length < 600 && RULE_TEXT.test(t)) {
        seen.push(n);
        parts.push(t);
      }
    }
    return {
      text: [...new Set(parts.map((t) => t.trim()).filter(Boolean))].join('\n').slice(0, 4000),
      minLength: el.minLength > 0 ? el.minLength : 0,
      maxLength: el.maxLength > 0 ? el.maxLength : 0,
      pattern: el.getAttribute('pattern') || '',
    };
  }

  /* ----------------------------------------------------------- AI answers */

  const MAX_PENDING = 40;
  // Questions kept for answers still to come: several reads' worth (Quick apply's second fill, the AI's second
  // round), the oldest let go first.
  const KEPT_PENDING = MAX_PENDING * 8;

  /** What a field asks, as the AI was given it (decide.aiItem), to tell one question from another. */
  const askedOf = (field) => U.normalize(U.cleanLabel(JTF.matcher.questionText(field.desc), 600));

  /**
   * The questions the fill left empty, for the AI to answer: ones nothing recognised, recognised ones the
   * profile has nothing for, and choices none of whose options matched the profile's answer (`guess`). Each
   * comes with its options (a custom dropdown is opened to read them when `peek`) and the question before it.
   * `settings.aiSensitive` lets the kinds of question the candidate allows through (decide.forAi).
   * Each gets an id of its own that no later read hands out again: the page can grow a question above it (a CV
   * parse, a revealed follow-up) and be read again before the AI's answers come back, and an answer still goes to
   * the question it was written for.
   */
  async function pendingQuestions(profile, context, { peek, settings }) {
    const { fields, results } = scan(profile);
    const allow = (settings && settings.aiSensitive) || null;
    const items = [];
    const prevOf = (i) => (i > 0 ? { field: fields[i - 1], r: results[i - 1] } : null);
    for (let i = 0; i < fields.length && items.length < MAX_PENDING; i++) {
      const field = fields[i];
      const r = results[i];
      if (JTF.fill.hasValue(field)) continue;
      const prev = prevOf(i);
      const prevType = prev && prev.r && prev.r.type;
      const on = JTF.decide.conditionOn(r, i);
      const before = fields[on] ? JTF.decide.beforeOf(fields[on].desc, JTF.fill.currentValue(fields[on])) : null;
      const asked = JTF.decide.forAi(field.desc, r, profile, context, prevType, before, allow);
      if (!asked) continue;
      const item = JTF.decide.aiItem(field.desc, asked.guess);
      if (!field.desc.options && peek && (field.kind === 'combo' || field.kind === 'combobox')) {
        const seen = await JTF.fill.peekOptions(field).catch(() => null);
        // A long list (countries, universities) is searched by typing the answer.
        if (seen && seen.options.length && seen.options.length <= 150) item.options = seen.options;
        if (seen && seen.multi) item.multiple = true;
      }
      const id = `${RUN}-${++state.asked}`;
      state.pending.set(id, { field, question: U.normalize(item.question) });
      items.push({
        id,
        ...item,
        required: JTF.dom.isRequired(field),
        follows: prev
          ? {
              question: U.cleanLabel(JTF.matcher.questionText(prev.field.desc), 200),
              // Never a date of birth, a password or a diversity answer the AI isn't answering itself.
              answer: JTF.decide.hidesAnswer(prevType, allow) ? '' : JTF.fill.currentValue(prev.field).slice(0, 200),
            }
          : null,
      });
    }
    for (const id of state.pending.keys()) {
      if (state.pending.size <= KEPT_PENDING) break;
      state.pending.delete(id);
    }
    return items;
  }

  /**
   * The field an AI answer is for: the one its id was given to, while it is on the page and still asks that
   * question; else the field on the page now that asks it (a re-render made it anew).
   */
  function answerField(a, fresh) {
    const want = U.normalize(a.question);
    const kept = state.pending.get(String(a.id));
    if (kept && kept.field.el.isConnected && kept.question === want) {
      const { el, kind, members } = kept.field;
      if (askedOf({ desc: JTF.dom.describe(el, kind, members) }) === want) return kept.field;
    }
    return fresh().find((f) => askedOf(f) === want) || null;
  }

  /** The value object JTF.fill.apply takes for an AI answer. */
  function answerValue(a) {
    const F = JTF.fields;
    if (Array.isArray(a.value))
      return {
        text: a.value.join(', '),
        kind: 'list',
        items: a.value.slice(),
        candidates: a.value.slice(),
        canonical: null,
      };
    if (a.kind === 'date') {
      const date = U.parseDate(a.value);
      if (date) return F.val(a.value, { kind: 'date', date, candidates: [a.value] });
    }
    if (a.kind === 'number') return F.val(a.value, { kind: 'number', number: parseFloat(a.value) });
    // A choice is the option the AI named, and only that one.
    const v = F.val(a.value, { candidates: [a.value], search: String(a.value).slice(0, 60) });
    if (a.kind === 'essay' || a.kind === 'text') v.canonical = null;
    return v;
  }

  /**
   * Put the AI's answers into the fields they're for (found again if the page re-rendered them). Undo takes them
   * back with the fill, even when this stops part-way.
   */
  async function applyAnswers(list, payload) {
    const history = [];
    try {
      return await putAnswers(list, payload, history);
    } finally {
      remember(history);
    }
  }

  async function putAnswers(list, payload, history) {
    const settings = (payload && payload.settings) || {};
    let filled = 0;
    let collected = null;
    const fresh = () => (collected = collected || JTF.dom.collect(document));
    const results = [];
    const written = [];
    for (const a of list || []) {
      const field = answerField(a, fresh);
      if (!field) {
        results.push({ id: a.id, status: 'gone' });
        continue;
      }
      // Something typed in the meantime is the person's answer.
      if (JTF.fill.hasValue(field)) {
        results.push({ id: a.id, status: 'skipped' });
        continue;
      }
      const v = answerValue(a);
      const started = Date.now();
      const res = await JTF.fill.apply(field, v, {
        overwrite: false,
        comboboxes: settings.comboboxes !== false,
        history,
      });
      traceStep(field, { type: 'ai' }, v, res, started, 'AI answer');
      if (res.status === 'filled') {
        filled++;
        state.aiFilled.set(field.el, JTF.fill.currentValue(field));
        if (settings.highlight !== false) JTF.fill.highlight(res.target || field.el, true);
        if (res.check) written.push({ field, v, check: res.check, label: U.cleanLabel(a.question, 60), key: null });
      }
      results.push({ id: a.id, status: res.status });
    }
    const checked = await recheck(written, { profile: state.profile, settings, history });
    remember(history);
    return { filled, results, check: checked.check, undoable: state.history.length > 0 };
  }

  /**
   * Keep the extension's background awake while the AI writes (an open port does that in every browser):
   * until release() or `ms` pass.
   */
  function hold(ms) {
    if (state.hold) return true;
    let port;
    try {
      port = JTF.api.runtime.connect({ name: 'jtf-hold' });
    } catch (err) {
      return false;
    }
    const ping = setInterval(() => {
      try {
        port.postMessage({ at: Date.now() });
      } catch (err) {
        stop();
      }
    }, 10000);
    const cap = setTimeout(() => stop(), ms || 180000);
    function stop() {
      clearInterval(ping);
      clearTimeout(cap);
      if (state.hold === stop) state.hold = null;
      try {
        port.disconnect();
      } catch (err) {
        /* already closed */
      }
    }
    port.onDisconnect.addListener(stop);
    state.hold = stop;
    return true;
  }

  /* ---------------------------------------------------------------- learn */

  /** Suggest profile values and custom answers from what is typed on this page. */
  function learn(payload) {
    const { profile } = payload;
    const { fields, results } = scan(profile);
    const out = [];
    const seen = new Set();
    fields.forEach((field, i) => {
      if (field.kind === 'password' || field.kind === 'file') return;
      const r = results[i];
      const value = JTF.fill.currentValue(field);
      if (U.isBlank(value) || value.length > 4000) return;
      // The AI's answers are kept for this application already, and often name this employer: not custom answers.
      if (state.aiFilled.get(field.el) === value) return;
      const question = JTF.matcher.questionText(field.desc);
      if (r && r.type === 'custom') {
        if (U.normalize(r.answer) !== U.normalize(value))
          out.push({ kind: 'custom', question, value, replaces: r.answerId });
        return;
      }
      const def = r && r.type ? JTF.fields.DEFS[r.type] : null;
      if (def) {
        if (def.secret || JTF.fields.DATE_TYPES.has(r.type) || r.part) return;
        let path = def.path;
        if (!path && def.list && (profile[def.list] || [])[r.index || 0] && def.key !== 'current' && !def.derived)
          path = `${def.list}.${r.index || 0}.${def.key}`;
        if (!path || !U.isBlank(U.getPath(profile, path))) return;
        if (seen.has(path)) return;
        seen.add(path);
        out.push({ kind: 'profile', path, label: def.label, value, question });
        return;
      }
      if (!question || question.length < 3) return;
      const key = U.normalize(question);
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ kind: 'custom', question, value });
    });
    return { url: location.href, suggestions: out };
  }

  /* -------------------------------------------------------------- inspect */

  function inspect(payload) {
    if (state.overlay) {
      state.overlay.forEach((t) => t.remove());
      state.overlay = null;
      JTF.fill.clearHighlights();
      return { on: false };
    }
    const { profile } = payload;
    const { fields, results, context } = scan(profile);
    context.jobLocation = jobLocation(payload);
    const { layer } = ui();
    state.overlay = [];
    let detected = 0;
    // A label by a field at the right edge stays on the page instead of widening it (a sideways scroll on a phone).
    const pageWidth = document.documentElement.scrollWidth;
    fields.forEach((field, i) => {
      const r = results[i];
      const def = r && r.type ? JTF.fields.DEFS[r.type] : null;
      let status = 'unknown';
      let text = '?  ' + (U.cleanLabel(JTF.matcher.questionText(field.desc), 28) || field.kind);
      if (def) {
        detected++;
        text = labelFor(field, r) + (r.index ? ` #${r.index + 1}` : '') + (r.part ? ` (${r.part})` : '');
        const question = U.normalize(JTF.matcher.questionText(field.desc));
        if (def.file)
          status =
            payload.docs && payload.docs[def.file] && JTF.fields.uploadApplies(r.type, profile, question)
              ? 'ok'
              : 'empty';
        else if (def.secret) status = 'secret';
        else if (def.consent) status = payload.settings && payload.settings.consents ? 'ok' : 'unknown';
        else {
          const ctx = Object.assign({}, context, {
            index: r.index || 0,
            part: r.part,
            kind: field.kind,
            answer: r.answer,
            question,
            help: U.normalize(JTF.matcher.helpText(field.desc)),
            options: field.desc.options,
          });
          status = JTF.fields.resolve(r.type, profile, ctx) ? 'ok' : 'empty';
        }
      } else if (r && r.type === 'custom') {
        detected++;
        text = labelFor(field, r);
        status = 'ok';
      }
      const target = field.kind === 'radio' || field.kind === 'checkboxes' ? field.members[0] : field.el;
      const anchor = JTF.dom.isVisible(target, { ignoreOpacity: true }) ? target : target.parentElement || target;
      const rect = anchor.getBoundingClientRect();
      const tag = make('div', STYLES.tag, text);
      Object.assign(tag.style, {
        background: TAG_COLORS[status],
        left: Math.max(0, rect.left + scrollX) + 'px',
        top: Math.max(0, rect.top + scrollY - 17) + 'px',
      });
      layer.append(tag);
      state.overlay.push(tag);
    });
    // All read, then all moved: one layout, however many fields.
    const widths = state.overlay.map((tag) => tag.offsetWidth);
    state.overlay.forEach((tag, i) => {
      const over = parseFloat(tag.style.left) + widths[i] - pageWidth;
      if (over > 0) tag.style.left = Math.max(0, parseFloat(tag.style.left) - over) + 'px';
    });
    return { on: true, detected, total: fields.length };
  }

  /* ------------------------------------------------- single-field inserts */

  function fieldForElement(el) {
    if (!el || el === document.body) return null;
    const kind = JTF.dom.kindOf(el);
    if (!kind) return null;
    return { el, kind, members: [el], desc: JTF.dom.describe(el, kind, [el]) };
  }

  /** Context menu "Insert …": put one profile value into the focused field. */
  async function fillActive(type, payload) {
    const field = fieldForElement(JTF.dom.deepActiveElement(document));
    if (!field) return { ok: false, reason: 'no field' };
    const v = JTF.fields.resolve(type, payload.profile, { index: 0, kind: field.kind, jobContext: true });
    if (!v) {
      toast(`Your profile has no ${JTF.fields.labelOf(type)} yet.`);
      return { ok: false, reason: 'missing' };
    }
    const history = [];
    const res = await JTF.fill
      .apply(field, v, { overwrite: true, comboboxes: true, history })
      .finally(() => remember(history));
    if (res.status === 'filled' && payload.settings.highlight !== false) JTF.fill.highlight(field.el);
    return { ok: res.status === 'filled' };
  }

  /** Context menu "Generate strong password": fill the focused box and empty password boxes next to it. */
  function insertPassword(password) {
    const active = JTF.dom.deepActiveElement(document);
    const scope = (active && active.form) || document;
    const targets = Array.from(scope.querySelectorAll('input[type="password"]')).filter(
      (el) => el === active || (!el.value && JTF.dom.isVisible(el)),
    );
    if (active && active.localName === 'input' && !targets.includes(active)) targets.unshift(active);
    targets.forEach((el) => {
      JTF.fill.typeValue(el, password);
      JTF.fill.highlight(el);
    });
    return { filled: targets.length };
  }

  /* --------------------------------------------------------- job context */

  /** What this page says about the job being applied for (see JTF.jobpage.applicationContext). */
  function jobContext() {
    const out = { url: location.href, top: isTop(), title: document.title };
    try {
      return Object.assign(out, JTF.jobpage.applicationContext(document, location.href));
    } catch (err) {
      out.error = String((err && err.message) || err);
      return out;
    }
  }

  /* ------------------------------------------------- sign-in and sign-up */

  // The background drives signing in, creating accounts and moving through an application's steps (and checks
  // every step); these read the page and click its own controls. Every click goes through JTF.flow (click() on
  // sign-in and sign-up pages, advance() for a step's "Next", addEntries() for a section's "Add"), which reads the
  // button's words again and never clicks one that submits.
  const accountScan = (payload) => scan((payload && payload.profile) || state.profile || null);

  // Everything that changes the page (or opens its menus to read them) takes its turn through serial(); reading it
  // (accountState, a bug report's snapshot) and waiting on it (accountWait) don't wait for a fill.
  const api = {
    version: 1,
    fill: serial(fill),
    applyAnswers: serial(applyAnswers),
    accountState: (payload) => JTF.flow.analyze(accountScan(payload), { ignore: payload && payload.ignore }),
    accountClick: serial((which, payload) => {
      const res = JTF.flow.click(which, accountScan(payload), { ignore: payload && payload.ignore });
      return Object.assign({}, res, { state: res.state ? { kind: res.state.kind, ready: res.state.ready } : null });
    }),
    accountWait: (token, payload) =>
      JTF.flow.wait(token, () => accountScan(payload), (payload && payload.timeout) || 5 * 60e3),
    /** Stop watching for the CAPTCHA or terms the flow waited on: the flow has ended (background.js endFlow). */
    accountStop: () => JTF.flow.stopWait(),
    // A multi-step application's step (Settings › "Move through multi-step applications for me"): what stands
    // between it and its next, and its own "Next" clicked when nothing does.
    stepState: (payload) =>
      JTF.flow.stepState(accountScan(payload), { applicationHosts: payload && payload.applicationHosts }),
    advance: serial((label, payload) => {
      const res = JTF.flow.advance(accountScan(payload), label, {
        applicationHosts: payload && payload.applicationHosts,
      });
      return { clicked: res.clicked || '', refused: res.refused || '' };
    }),
    pending: serial(async (payload) => {
      const { context } = scan(payload.profile);
      context.jobLocation = jobLocation(payload);
      return {
        items: await pendingQuestions(payload.profile, context, { peek: !!payload.ai, settings: payload.settings }),
      };
    }),
    hold,
    release() {
      if (state.hold) state.hold();
      return true;
    },
    learn: serial(learn),
    jobContext,
    /** Where the job is, as a fill reads it from this page (for the detection benchmark's reading of a saved page). */
    jobLocation: () => ({ jobLocation: jobLocation(null) }),
    inspect,
    toast,
    fillActive: serial(fillActive),
    insertPassword: serial(insertPassword),
    /**
     * A redacted copy of this frame's form for a bug report, with what the last fills here did (content/snapshot.js).
     * A CAPTCHA's frame is left out.
     */
    snapshot(payload) {
      if (JTF.accounts.isCaptchaFrame(location.href))
        return { url: JTF.snapshot.cleanUrl(location.href), skipped: 'captcha' };
      try {
        return JTF.snapshot.capture(document, payload);
      } catch (err) {
        return { url: JTF.snapshot.cleanUrl(location.href), error: String((err && err.message) || err) };
      }
    },
    /** Does this field still hold the answer the AI put there (for the page map)? */
    aiFilled: (field) => state.aiFilled.has(field.el) && state.aiFilled.get(field.el) === JTF.fill.currentValue(field),
    /** Put back what every fill and AI answer changed since the last Undo, once the one under way has finished. */
    undo: serial(() => {
      const n = JTF.fill.undo(state.history);
      JTF.fill.clearHighlights();
      return { undone: n };
    }),
  };
  Object.defineProperty(root, '__jtf', { value: api, configurable: true });
})(typeof globalThis !== 'undefined' ? globalThis : this);
