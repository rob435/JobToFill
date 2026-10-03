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

  // lastFill: what the latest fill changed (AI answers are added to it, so one Undo takes both back);
  // pending: the questions it left empty, by id, for the AI's answers; hold: keeps the background awake.
  // aiFilled: field -> the answer the AI put there (remembered with the application, so not "learnt" again).
  // attached: upload -> the file names a fill put there, by type (a new letter takes the place of the one before).
  const state = {
    history: [],
    lastFill: [],
    overlay: null,
    ui: null,
    pending: new Map(),
    hold: null,
    aiFilled: new WeakMap(),
    attached: new WeakMap(),
  };

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

  /** Does the question take several answers: a checklist, a <select multiple>, a widget standing in for one? */
  const takesSeveral = (field) =>
    field.kind === 'checkboxes' ||
    (field.kind === 'select' && !!field.el.multiple) ||
    (field.kind !== 'file' && !!field.desc.multiple);

  /** A custom answer as the list it names, when every item is one of the question's options (or none are known). */
  function listAnswer(v, field) {
    const items = String(v.text || '')
      .split(/\s*[,;\n]\s*/)
      .filter(Boolean);
    if (items.length < 2) return null;
    const options = (field.desc.options || []).filter((o) => !o.disabled);
    if (options.length && !items.every((t) => JTF.matcher.matchOption(options, JTF.fields.val(t)) >= 0)) return null;
    return { text: items.join(', '), kind: 'list', items, candidates: items, canonical: null };
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

  /**
   * Where the job is, for "Are you authorized to work in the country where this role is based?": what the extension
   * already knew about the job in this tab, else the location line on the application page itself.
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
    } catch (err) {
      /* nothing to go by */
    }
    return '';
  }

  // "If you said yes above, please tell us more": only worth filling when the answer was yes.
  const FOLLOW_UP = /^if (yes|so|you (said|answered|selected|chose|checked|ticked) yes)\b/;
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
      maxWidth: '340px',
      display: 'flex',
      gap: '10px',
      alignItems: 'flex-start',
      padding: '12px 14px',
      borderRadius: '12px',
      background: '#17142b',
      color: '#f4f2ff',
      font: FONT,
      boxShadow: '0 10px 30px rgba(0, 0, 0, 0.25)',
      opacity: '0',
      transform: 'translateY(8px)',
      transition: 'opacity 0.18s, transform 0.18s',
    },
    dot: { flex: 'none', width: '10px', height: '10px', marginTop: '4px', borderRadius: '50%', background: '#8b74ff' },
    message: { flex: '1', whiteSpace: 'pre-line' },
    button: { all: 'unset', cursor: 'pointer', color: '#b9abff', fontWeight: '600', marginLeft: '4px', font: FONT },
    tag: {
      position: 'absolute',
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

  let toastTimer = null;
  function toast(message, opts) {
    const view = ui();
    if (view.toast) view.toast.remove();
    const box = make('div', STYLES.toast);
    box.setAttribute('role', 'status');
    box.append(make('span', STYLES.dot), make('span', STYLES.message, message));
    if (opts && opts.undo && state.history.length) {
      const undo = make('button', STYLES.button, 'Undo');
      undo.addEventListener('click', () => {
        api.undo();
        box.remove();
      });
      box.append(undo);
    }
    view.shadow.append(box);
    view.toast = box;
    requestAnimationFrame(() => Object.assign(box.style, { opacity: '1', transform: 'none' }));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => box.remove(), (opts && opts.duration) || 6000);
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

  async function fill(payload) {
    const { profile, settings } = payload;
    state.profile = profile;
    // A CAPTCHA's own frame (reCAPTCHA's "I'm not a robot" box): nothing in it is ever touched.
    if (JTF.accounts.isCaptchaFrame(location.href))
      return { url: location.href, frame: 'captcha', filled: 0, detected: 0 };
    // A fill that changes nothing keeps the previous one undoable.
    const history = [];
    const { fields, results, context } = await scanWhenDrawn(profile);
    context.jobLocation = jobLocation(payload);
    // On a pure sign-up page in an account flow, the sign-up form's own terms box is part of creating the account.
    const page = JTF.flow.analyze({ fields, results });
    const accountTerms = !!payload.accountFlow && page.kind === 'signup' && page.pure;

    // A username box alone needs nothing more; password and card boxes ask the background for theirs.
    const needs = {
      password: results.some((r) => r && r.type && r.type.startsWith('account.pass')),
      card: results.some((r) => r && r.type && r.type.startsWith('cc.')),
    };
    const notes = [];
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
      top: root === root.top,
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
    const docCache = {};
    const valueFor = async (field, r, def, question) => {
      if (def && def.file) return documentValue(r.type, payload, docCache);
      return JTF.fields.resolve(
        r.type,
        profile,
        Object.assign({}, context, {
          index: r.index || 0,
          part: r.part,
          kind: field.kind,
          secrets,
          answer: r.answer,
          question,
          help: U.normalize(JTF.matcher.helpText(field.desc)),
          options: field.desc.options,
          consents: !!settings.consents || accountTerms,
          // How the page writes "03/11" (interview slots).
          dateOrder: JTF.matcher.dateOrder(field.desc),
        }),
      );
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
    /**
     * The documents an upload takes, its own first: your CV's upload, when it takes several files, also takes your
     * letter and transcript (fields.uploadAlso), those you have.
     */
    const carriedBy = (field, r) => {
      if (r.type !== 'file.resume' || field.kind !== 'file' || !field.desc.multiple) return [r.type];
      const s = field.desc.signals;
      const text = U.normalize([s.question, s.label, s.aria, s.nearby, s.group, s.section].filter(Boolean).join(' '));
      const also = JTF.fields.uploadAlso(text, { multiple: true, profile, separate: uploadTypes });
      return [r.type, ...also.filter((t) => payload.docs && payload.docs[JTF.fields.DEFS[t].file])];
    };
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
      const label = JTF.fields.labelOf(r.type);
      const v = await documentValue(r.type, payload, docCache);
      if (!v) {
        report.missing.push(label);
        report.missingTypes.push(r.type);
        continue;
      }
      const res = await JTF.fill.attachVia(tile, v.document, { history });
      report.docs[r.type] = res.status === 'filled' ? 'filled' : report.docs[r.type] || res.status;
      if (res.status === 'filled') {
        report.filled++;
        uploaded = true;
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
      // Asked for anew by this fill (the letter Quick apply or the studio just wrote, a tailored CV), or by Overwrite.
      const asked = (t) => !!((payload.force && only && only.has(t)) || (replace && replace.has(t)));
      const renew = have.filter((t) => settings.overwrite || asked(t));
      const el = field.el;
      const kept = (el.files && el.files.length) || 0;
      const text = uploadBox(el).textContent || '';
      let put = have;
      let keep = false;
      if (kept || FILE_NAME.test(text)) {
        if (kept) {
          put = renew.includes('file.resume') ? have : renew;
          keep = !renew.includes('file.resume');
        } else put = renew.filter((t) => asked(t) || !shows(text, docs[t]));
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
      const res = await JTF.fill.apply(field, v, {
        overwrite: true,
        comboboxes: settings.comboboxes !== false,
        history,
      });
      for (const t of put) report.docs[t] = res.status === 'filled' ? 'filled' : report.docs[t] || res.status;
      if (res.status === 'filled') {
        state.attached.set(el, Object.assign({}, before, ...put.map((t) => ({ [t]: docs[t].name }))));
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
      const question = U.normalize(JTF.matcher.questionText(field.desc));
      // "If applicable, please provide a recent transcript of your graduate studies.": not for a level you haven't
      // studied at, and nothing missing from your profile either.
      if (def && def.file && !JTF.fields.uploadApplies(r.type, profile, question)) return null;
      if (def && def.consent && !settings.consents && !accountTerms) {
        if (!JTF.fill.hasValue(field)) report.consents++;
        return null;
      }
      // "I'm not a robot" is only ticked when no CAPTCHA stands behind it.
      if (r.type === 'human' && JTF.flow.captcha(document)) return null;
      if (uploaded && !settled && field.kind !== 'file') {
        await settle();
        settled = true;
      }
      let v = await valueFor(field, r, def, question);
      if (v && r.type !== 'custom' && FOLLOW_UP.test(question) && !JTF.fields.followUpAnswer(v, field.kind))
        return null;
      // A custom answer naming several of the options ("Technology, Quantitative Research") picks each of them where
      // the question takes several.
      if (v && r.type === 'custom' && takesSeveral(field)) v = listAnswer(v, field) || v;
      // A box that holds part of a number (see splitBoxes) gets its part, or nothing when the number doesn't fit.
      if (v && r.segment) {
        v = segmentValue(v, r.segment);
        if (!v || !v.text) return null;
      }
      if (!v) {
        if (count && !(def && def.secret)) {
          report.missing.push(label);
          report.missingTypes.push(r.type);
        }
        return null;
      }
      const res = await JTF.fill.apply(field, v, {
        overwrite: settings.overwrite || !!payload.force || !!(replace && replace.has(r.type)),
        correct: CORRECTED.has(r.type),
        comboboxes: settings.comboboxes !== false,
        history,
      });
      if ((def && def.file) || r.type === 'coverLetter')
        report.docs[r.type] = res.status === 'filled' ? 'filled' : report.docs[r.type] || res.status;
      if (res.status === 'filled') {
        report.filled++;
        if (def && def.consent) report.ticked++;
        if (field.kind === 'file') uploaded = true;
        else filledKeys.add(keyOf(r, question));
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
      const again = scan(profile);
      const known = new Set(fields.map((f) => f.el));
      fields.push(...again.fields.filter((field) => !known.has(field.el)));
      todo = again.fields
        .map((field, i) => [field, again.results[i]])
        .sort(([a], [b]) => (b.kind === 'file') - (a.kind === 'file'));
    }
    for (const [field, r] of todo) if (!done.has(field.el)) await fillOne(field, r);

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
        const v = await valueFor(field, r, JTF.fields.DEFS[r.type], question);
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
    if (history.length) state.history = history;
    state.lastFill = history;
    report.undoable = state.history.length > 0;
    // Only a job application's leftovers go to the AI (never a checkout's gift message or a sign-up page).
    if (!only && context.jobContext) report.pending = await pendingQuestions(profile, context, { peek: !!payload.ai });
    // What kind of page this is now (sign-in, sign-up, emailed code…), for signing in and creating accounts.
    report.account = JTF.flow.analyze(scan(profile));
    return report;
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
    if (found.fields.length || root !== root.top || !stillDrawing()) return found;
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

  // Never for the AI: what only the profile knows or the person decides (contact details, diversity answers,
  // declarations), secrets, uploads, and a cover letter (the letter writer does those).
  // Sanctions declarations and interview slots too: left for you when your profile can't tell.
  const NOT_FOR_AI =
    /^(name\.|email$|phone|address\.|links\.|dob$|age$|pronouns$|account\.|otp$|human$|cc\.|file\.|consent$|eeo\.|coverLetter$|job\.salary$|compliance\.sanctions$|job\.availability$)/;
  const FOLLOW_ON = /^(if|please (specify|explain|state|give|provide)|other\b|specify)\b/;
  const MAX_PENDING = 40;

  /**
   * The questions the fill left empty, for the AI to answer: ones nothing recognised, recognised ones the
   * profile has nothing for, and choices none of whose options matched the profile's answer (`guess`). Each
   * comes with its options (a custom dropdown is opened to read them when `peek`) and the question before it.
   */
  async function pendingQuestions(profile, context, { peek }) {
    const { fields, results } = scan(profile);
    state.pending = new Map();
    const items = [];
    const prevOf = (i) => (i > 0 ? { field: fields[i - 1], r: results[i - 1] } : null);
    for (let i = 0; i < fields.length && items.length < MAX_PENDING; i++) {
      const field = fields[i];
      const r = results[i];
      if (['file', 'password', 'email', 'tel', 'url'].includes(field.kind) || JTF.fill.hasValue(field)) continue;
      const question = JTF.matcher.questionText(field.desc);
      const q = U.normalize(question);
      if (q.length < 3) continue;
      let guess = null;
      if (r && r.type === 'custom') guess = { type: 'custom', value: r.answer };
      else if (r && r.type) {
        const def = JTF.fields.DEFS[r.type];
        if (NOT_FOR_AI.test(r.type) || !def || def.consent || def.secret || def.file) continue;
        const ctx = {
          ...context,
          index: r.index || 0,
          part: r.part,
          kind: field.kind,
          question: q,
          help: U.normalize(JTF.matcher.helpText(field.desc)),
          options: field.desc.options,
        };
        // A grade your profile holds is the rules' to give (or to leave, as a class in a GPA box that wants a
        // number): the AI never turns a 2:1 into a GPA.
        if (JTF.fields.gradeHeld(r.type, profile, ctx)) continue;
        const v = JTF.fields.resolve(r.type, profile, ctx);
        // A follow-up after a "No" ("If yes, give details") or a box the profile said no to stays empty.
        if (v && (field.kind === 'checkbox' || (FOLLOW_UP.test(q) && !JTF.fields.followUpAnswer(v, field.kind))))
          continue;
        if (v) guess = { type: r.type, value: v.text };
      }
      const prev = prevOf(i);
      const prevType = prev && prev.r && prev.r.type;
      // "If other, please specify" after a diversity or password question belongs to it.
      if (prevType && /^(eeo\.|account\.|cc\.)/.test(prevType) && FOLLOW_ON.test(q)) continue;
      let options = null;
      let multiple = field.kind === 'checkboxes' || !!field.desc.multiple;
      if (field.desc.options && field.kind !== 'checkbox')
        options = field.desc.options
          .filter((o) => !o.disabled)
          .map((o) => U.cleanLabel(o.text, 200))
          .filter((t) => t && !JTF.matcher.isPlaceholder(U.normalize(t)));
      else if (peek && (field.kind === 'combo' || field.kind === 'combobox')) {
        const seen = await JTF.fill.peekOptions(field).catch(() => null);
        // A long list (countries, universities) is searched by typing the answer.
        if (seen && seen.options.length && seen.options.length <= 150) options = seen.options;
        if (seen && seen.multi) multiple = true;
      }
      const id = String(i);
      state.pending.set(id, field);
      items.push({
        id,
        question: U.cleanLabel(question, 600),
        help: U.cleanLabel(field.desc.signals.describedby || '', 300),
        kind: field.kind,
        options: options && options.length ? options : null,
        multiple,
        maxLength: field.desc.maxLength || 0,
        required: !!(
          field.el.required ||
          field.el.getAttribute('aria-required') === 'true' ||
          /\*\s*$/.test(field.desc.signals.label || field.desc.signals.question || '')
        ),
        section: U.cleanLabel(field.desc.signals.section || '', 120),
        placeholder: U.cleanLabel(field.desc.placeholderRaw || '', 120),
        follows: prev
          ? {
              question: U.cleanLabel(JTF.matcher.questionText(prev.field.desc), 200),
              answer:
                prevType && /^(eeo\.|account\.|cc\.)/.test(prevType)
                  ? ''
                  : JTF.fill.currentValue(prev.field).slice(0, 200),
            }
          : null,
        guess,
      });
    }
    return items;
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

  /** Put the AI's answers into the fields they're for (found again if the page re-rendered them). */
  async function applyAnswers(list, payload) {
    const settings = (payload && payload.settings) || {};
    const history = state.lastFill || [];
    let filled = 0;
    let fresh = null;
    const results = [];
    const written = [];
    for (const a of list || []) {
      let field = state.pending.get(String(a.id));
      if (!field || !field.el.isConnected) {
        fresh = fresh || JTF.dom.collect(document);
        const want = U.normalize(a.question);
        field = fresh.find((f) => U.normalize(JTF.matcher.questionText(f.desc)) === want) || null;
      }
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
      const res = await JTF.fill.apply(field, v, {
        overwrite: false,
        comboboxes: settings.comboboxes !== false,
        history,
      });
      if (res.status === 'filled') {
        filled++;
        state.aiFilled.set(field.el, JTF.fill.currentValue(field));
        if (settings.highlight !== false) JTF.fill.highlight(res.target || field.el, true);
        if (res.check) written.push({ field, v, check: res.check, label: U.cleanLabel(a.question, 60), key: null });
      }
      results.push({ id: a.id, status: res.status });
    }
    const checked = await recheck(written, { profile: state.profile, settings, history });
    if (history.length) state.history = history;
    state.lastFill = history;
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
    state.history = [];
    const res = await JTF.fill.apply(field, v, { overwrite: true, comboboxes: true, history: state.history });
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
    const out = { url: location.href, top: root === root.top, title: document.title };
    try {
      return Object.assign(out, JTF.jobpage.applicationContext(document, location.href));
    } catch (err) {
      out.error = String((err && err.message) || err);
      return out;
    }
  }

  /* ------------------------------------------------- sign-in and sign-up */

  // The background drives signing in and creating accounts (and checks every step); these read the page and
  // click its own controls. Clicks only happen through JTF.flow.click(), which re-checks everything.
  const accountScan = (payload) => scan((payload && payload.profile) || state.profile || null);

  const api = {
    version: 1,
    fill,
    applyAnswers,
    accountState: (payload) => JTF.flow.analyze(accountScan(payload)),
    accountClick(which, payload) {
      const res = JTF.flow.click(which, accountScan(payload));
      return Object.assign({}, res, { state: res.state ? { kind: res.state.kind, ready: res.state.ready } : null });
    },
    accountWait: (token, payload) =>
      JTF.flow.wait(token, () => accountScan(payload), (payload && payload.timeout) || 5 * 60e3),
    accountStop: () => JTF.flow.stopWait(),
    async pending(payload) {
      const { context } = scan(payload.profile);
      context.jobLocation = jobLocation(payload);
      return { items: await pendingQuestions(payload.profile, context, { peek: !!payload.ai }) };
    },
    hold,
    release() {
      if (state.hold) state.hold();
      return true;
    },
    learn,
    jobContext,
    inspect,
    toast,
    fillActive,
    insertPassword,
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
    /** Entries from another part of the content script (the AI assist) join the undoable fill. */
    appendHistory(entries) {
      if (entries && entries.length) state.history = state.history.concat(entries);
    },
    undo() {
      const n = JTF.fill.undo(state.history);
      JTF.fill.clearHighlights();
      return { undone: n };
    },
  };
  Object.defineProperty(root, '__jtf', { value: api, configurable: true });
})(typeof globalThis !== 'undefined' ? globalThis : this);
