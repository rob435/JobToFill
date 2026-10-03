/*
 * JobToFill — in-page half of the AI field assist. Adds collectUnfilled() and applyAnswers() to the API
 * that content/main.js defines. Collecting only describes fields (label, type, options); nothing else on
 * the page is read. Answers are written with the same machinery as a normal fill and join its undo history.
 */
(function (root) {
  'use strict';
  const api = root.__jtf;
  if (!api || api.collectUnfilled) return;
  const JTF = root.JTF;
  const U = JTF.util;
  const A = JTF.assist;

  const pending = new Map();

  /**
   * Fields still empty that the rules engine couldn't answer: no type, a type whose option didn't match,
   * or a compliance question the profile leaves blank (the AI may answer it from the extra details).
   */
  function collectUnfilled(payload) {
    const { profile } = payload;
    pending.clear();
    const fields = JTF.dom.collect(document);
    const planned = JTF.matcher.plan(
      fields.map((f) => f.desc),
      profile,
    );
    const out = [];
    fields.forEach((field, i) => {
      if (out.length >= A.MAX_FIELDS) return;
      const r = planned.results[i];
      const def = r && r.type ? JTF.fields.DEFS[r.type] : null;
      if (r && r.type === 'custom') return;
      if (def && (def.secret || def.file || def.consent)) return;
      if (JTF.fill.hasValue(field)) return;
      const desc = field.desc;
      const question = U.normalize(JTF.matcher.questionText(desc));
      if (def) {
        const v = JTF.fields.resolve(
          r.type,
          profile,
          Object.assign({}, planned.context, {
            index: r.index || 0,
            part: r.part,
            kind: field.kind,
            answer: r.answer,
            question,
          }),
        );
        if (!v && !r.type.startsWith('compliance.')) return;
      }
      const s = desc.signals || {};
      const target = field.members && field.members[0] ? field.members[0] : field.el;
      const item = {
        id: String(i),
        kind: field.kind,
        inputType: desc.inputType,
        autocomplete: desc.autocomplete,
        label: JTF.matcher.questionText(desc),
        name: s.name || '',
        htmlId: s.id || '',
        required: !!(target && (target.required || target.getAttribute('aria-required') === 'true')),
        maxLength: desc.maxLength || 0,
        options: desc.options
          ? desc.options
              .filter((o) => o && !o.disabled && !JTF.matcher.isPlaceholder(U.normalize(o.text)))
              .map((o) => String(o.text).trim())
          : null,
      };
      if (A.skipReason(item)) return;
      pending.set(item.id, field);
      out.push(item);
    });
    return { fields: out };
  }

  /** Write { id: { answer } } into the fields collectUnfilled() returned; one undo covers them all. */
  async function applyAnswers(answers, settings) {
    const history = [];
    const items = [];
    for (const [id, entry] of Object.entries(answers || {})) {
      const field = pending.get(id);
      if (!field || !field.el.isConnected || !entry || typeof entry.answer !== 'string') continue;
      const label = U.cleanLabel(JTF.matcher.questionText(field.desc), 60) || field.kind;
      const v = JTF.fields.val(entry.answer);
      if (!v) continue;
      const res = await JTF.fill.apply(field, v, {
        overwrite: false,
        comboboxes: !settings || settings.comboboxes !== false,
        history,
      });
      if (res.status === 'filled') {
        if (!settings || settings.highlight !== false) JTF.fill.highlight(res.target || field.el);
        items.push({ label, answer: entry.answer.slice(0, 120) });
      }
    }
    api.appendHistory(history);
    pending.clear();
    return { filled: items.length, items, undoable: history.length > 0 };
  }

  api.collectUnfilled = collectUnfilled;
  api.applyAnswers = applyAnswers;
})(typeof globalThis !== 'undefined' ? globalThis : this);
