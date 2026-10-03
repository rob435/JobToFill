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

  const state = { history: [], overlay: null, ui: null };

  function send(message) {
    return JTF.api.runtime.sendMessage(message).catch((err) => ({ error: String((err && err.message) || err) }));
  }

  function scan(profile) {
    const fields = JTF.dom.collect(document);
    const planned = JTF.matcher.plan(
      fields.map((f) => f.desc),
      profile,
    );
    return { fields, results: planned.results, context: planned.context };
  }

  // "If you said yes above, please tell us more": only worth filling when the answer was yes.
  const FOLLOW_UP = /^if (yes|so|you (said|answered|selected|chose|checked|ticked) yes)\b/;

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
  const TAG_COLORS = { ok: '#16a34a', empty: '#d97706', vault: '#7c3aed', unknown: '#6b7280' };

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
    // A fill that changes nothing keeps the previous one undoable.
    const history = [];
    const { fields, results, context } = scan(profile);

    // A username box alone doesn't need the vault; password and card boxes do.
    const needs = {
      password: results.some((r) => r && r.type && r.type.startsWith('account.pass')),
      card: results.some((r) => r && r.type && r.type.startsWith('cc.')),
    };
    const notes = [];
    let secrets = null;
    if (needs.password || needs.card) {
      if (payload.vault === 'unlocked') {
        secrets = await send({
          type: 'jtf:secrets',
          password: needs.password ? (context.signup ? 'signup' : 'login') : null,
          card: needs.card,
        });
        if (secrets && secrets.error) notes.push(secrets.error);
        if (secrets && secrets.notes) notes.push(...secrets.notes);
      } else {
        notes.push(
          payload.vault === 'none'
            ? 'Passwords and cards need the vault: set it up in JobToFill settings.'
            : 'The vault is locked, so passwords and cards were skipped.',
        );
      }
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
      wantsLetter: false,
    };
    // Attaching a cover letter fills just those fields, replacing whatever is in them.
    const only = payload.only ? new Set(payload.only) : null;
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
          consents: !!settings.consents,
        }),
      );
    };
    // Files first: sites like Breezy and Lever read an uploaded CV and rewrite the form, which would
    // wipe answers filled before it. The rest is filled once the page has settled.
    const order = fields.map((f, i) => i).sort((a, b) => (fields[b].kind === 'file') - (fields[a].kind === 'file'));
    let uploaded = false;
    let settled = false;
    // Exactly which fields were filled (a follow-up box can share its type with the question it follows).
    const filledKeys = new Set();
    const keyOf = (r, question) => [r.type, r.index || 0, r.part || '', question].join('|');
    /** Fill one field from the profile; `count` adds what it asks about to the report's lists. */
    const fillOne = async (field, r, { count = true } = {}) => {
      if (!r || !r.type) {
        if (count) report.unknown++;
        return null;
      }
      if (r.type === 'file.coverLetter' || r.type === 'coverLetter') report.wantsLetter = true;
      if (only && !only.has(r.type)) return null;
      report.detected++;
      const def = JTF.fields.DEFS[r.type];
      const label = labelFor(field, r);
      const question = U.normalize(JTF.matcher.questionText(field.desc));
      if (def && def.consent && !settings.consents) {
        if (!JTF.fill.hasValue(field)) report.consents++;
        return null;
      }
      if (uploaded && !settled && field.kind !== 'file') {
        await settle();
        settled = true;
      }
      const v = await valueFor(field, r, def, question);
      if (v && r.type !== 'custom' && FOLLOW_UP.test(question) && v.canonical !== 'yes') return null;
      if (!v) {
        if (count && !(def && def.secret)) {
          report.missing.push(label);
          report.missingTypes.push(r.type);
        }
        return null;
      }
      const res = await JTF.fill.apply(field, v, {
        overwrite: settings.overwrite || !!payload.force,
        comboboxes: settings.comboboxes !== false,
        history,
      });
      if (res.status === 'filled') {
        report.filled++;
        if (field.kind === 'file') uploaded = true;
        else filledKeys.add(keyOf(r, question));
        if (settings.highlight !== false) JTF.fill.highlight(res.target || field.el);
      } else if (res.status === 'skipped') {
        report.skipped++;
      } else {
        report.failed++;
        report.unmatched.push(label);
      }
      return res.status;
    };
    for (const i of order) await fillOne(fields[i], results[i]);

    // A late CV parse can still clear or re-render fields after they were filled: fill those again.
    if (uploaded && filledKeys.size) {
      await settle();
      const again = scan(profile);
      for (let i = 0; i < again.fields.length; i++) {
        const field = again.fields[i];
        const r = again.results[i];
        if (!r || !r.type || field.kind === 'file' || JTF.fill.hasValue(field)) continue;
        const question = U.normalize(JTF.matcher.questionText(field.desc));
        if (!filledKeys.has(keyOf(r, question))) continue;
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
    for (let round = 0; round < 2 && filledKeys.size; round++) {
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
      report.revealed = (report.revealed || 0) + added;
      if (!added) break;
    }
    report.missing = [...new Set(report.missing)];
    report.missingTypes = [...new Set(report.missingTypes)];
    report.unmatched = [...new Set(report.unmatched)];
    if (history.length) state.history = history;
    report.undoable = state.history.length > 0;
    return report;
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
        if (!path && def.list && (profile[def.list] || [])[r.index || 0] && def.key !== 'current')
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
        if (def.file) status = payload.docs && payload.docs[def.file] ? 'ok' : 'empty';
        else if (def.secret) status = 'vault';
        else if (def.consent) status = payload.settings && payload.settings.consents ? 'ok' : 'unknown';
        else {
          const ctx = Object.assign({}, context, {
            index: r.index || 0,
            part: r.part,
            kind: field.kind,
            answer: r.answer,
            question: U.normalize(JTF.matcher.questionText(field.desc)),
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

  const api = {
    version: 1,
    fill,
    learn,
    jobContext,
    inspect,
    toast,
    fillActive,
    insertPassword,
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
