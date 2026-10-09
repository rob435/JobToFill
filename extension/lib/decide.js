/*
 * JobToFill — what a fill does with each field, decided without the page (DOM-free). The fill (content/main.js), its
 * picks among a list's options (content/fill.js) and the detection benchmark (tests/bench) all decide here, so the
 * benchmark scores what the extension does:
 *   field(desc, r, profile, context, opts)   fill, upload, leave, skip, consent or missing, with the value
 *   picks(desc, v)                           the options a value picks in a list the page offers
 *   forAi(desc, r, profile, context, prev, before)  whether a field left empty goes to the AI, and the rules' guess
 *   page(descs, profile, opts)               every field of a page, as a fill would leave it
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});
  const U = JTF.util;
  const F = () => JTF.fields;
  const M = () => JTF.matcher;

  // "If you said yes above, please tell us more": only worth filling when the answer was yes.
  const FOLLOW_UP = /^if (yes|so|you (said|answered|selected|chose|checked|ticked) yes)\b/;
  // Never for the AI: what only the profile knows or the person decides (contact details, diversity answers,
  // declarations), secrets, uploads, and a cover letter (the letter writer does those).
  // Sanctions declarations and interview slots too: left for you when your profile can't tell.
  const NOT_FOR_AI =
    /^(name\.|email$|phone|address\.|links\.|dob$|age$|pronouns$|account\.|otp$|human$|cc\.|file\.|consent$|optIn$|referee$|page$|eeo\.|coverLetter$|job\.salary$|compliance\.sanctions$|job\.availability$)/;
  // Boxes the AI never writes in.
  const NO_AI_KINDS = new Set(['file', 'password', 'email', 'tel', 'url']);
  // "If other, please specify" after a diversity or password question belongs to it.
  const FOLLOW_ON = /^(if|please (specify|explain|state|give|provide)|other\b|specify)\b/;
  const PRIVATE_BEFORE = /^(eeo\.|account\.|cc\.)/;
  // A list on its catch-all: the box after it is for the answer the list lacks.
  const OTHER_CHOSEN = /\bother\b|\bnot listed\b|\bsomething else\b/;
  // A follow-up's condition on the choice before it: "If yes, please provide the applicable deadline", "If your answer
  // is yes to the above question…", "If no, …", "If other, please specify", "If your institution is not listed above,
  // please specify below", "If you selected 'A friend or relative', please put their full name below".
  const IF_YES =
    /^if (yes|so)\b|^if (you (have )?(answered|selected|said|chose|chosen|ticked|checked)|your answer (is|was)) yes\b/;
  const IF_NO = /^if (no|not)\b(?! (listed|shown|in the list))/;
  // MS Forms' "Other answer" box (Pharus) is one too.
  const IF_OTHER =
    /^if (you (have )?(selected|chose|chosen|answered|picked|ticked) )?other\b|^if (\w+ ){0,4}(is|are|was|were) not (listed|shown|in the list)\b|^other (answer|response)$/;
  const IF_PICKED = /^if you (have )?(selected|chose|chosen|answered|picked|ticked) ['"‘“]([^'"’”]{2,80})['"’”]/i;
  const SAID_NO =
    /^(no|none|n a|not applicable|never|i (do|did|have|am|was) not|i (don t|didn t|haven t|m not|wasn t))\b/;
  // Lists, whose answer the page shows as the option picked.
  const CHOICE_KINDS = new Set(['select', 'radio', 'checkbox', 'checkboxes', 'combo', 'combobox']);

  /** What a field's value is worked out from: the plan's entry and part, the question, the page's help, the options. */
  function contextOf(desc, r, context, extra) {
    return Object.assign(
      {},
      context,
      {
        index: r.index || 0,
        part: r.part,
        kind: desc.kind,
        answer: r.answer,
        question: U.normalize(M().questionText(desc)),
        // As written, for what normalising loses ("AAB or A*AA").
        asked: M().questionText(desc),
        help: U.normalize(M().helpText(desc)),
        // What the page calls the box, for what its words leave out ("/candidate/socialMediaGitHub").
        names: [desc.signals && desc.signals.name, desc.signals && desc.signals.id]
          .filter(Boolean)
          .join(' ')
          .toLowerCase(),
        options: desc.options,
        // How the page writes "03/11" (interview slots).
        dateOrder: M().dateOrder(desc),
      },
      extra,
    );
  }

  /** Does the question take several answers: a checklist, a <select multiple>, a widget standing in for one? */
  const takesSeveral = (desc) => desc.kind === 'checkboxes' || (desc.kind !== 'file' && !!desc.multiple);

  /** A custom answer as the list it names, when every item is one of the question's options (or none are known). */
  function listAnswer(v, desc) {
    const items = String(v.text || '')
      .split(/\s*[,;\n]\s*/)
      .filter(Boolean);
    if (items.length < 2) return null;
    const options = (desc.options || []).filter((o) => !o.disabled);
    if (options.length && !items.every((t) => M().matchOption(options, F().val(t)) >= 0)) return null;
    return { text: items.join(', '), kind: 'list', items, candidates: items, canonical: null };
  }

  /**
   * What the fill does with a recognised field (`r`, its entry in matcher.plan), before it touches the page:
   * { action, value }, the action one of
   *   'upload'   a document goes in (r.type names it; the fill fetches it)
   *   'skip'     not for you: an upload for a level you haven't studied at, "Please specify" while its list isn't on
   *              "Other", a follow-up after a "No"
   *   'consent'  an acknowledgement, left for you unless ctx.consents
   *   'leave'    yours to decide (an opt-in, a referee's details), empty on purpose ("A-Level Subject 4" for three
   *              A-levels) or a secret there is none of (`unresolved` when the rules came back empty)
   *   'missing'  the profile has nothing for it (`unresolved`)
   *   'fill'     `value` goes in
   * opts.ctx joins the context (secrets, consents); opts.followed is what the list a follow-up box follows holds now
   * ('' for nothing), when it follows one.
   */
  function field(desc, r, profile, context, opts = {}) {
    const def = F().DEFS[r.type];
    const ctx = contextOf(desc, r, context, opts.ctx);
    if (def && def.file) return { action: F().uploadApplies(r.type, profile, ctx.question) ? 'upload' : 'skip' };
    if (def && def.consent && !ctx.consents) return { action: 'consent' };
    // An opt-in is yours to decide.
    if (def && def.leave) return { action: 'leave' };
    // "Please specify" after a list is for the answer the list didn't have: only once "Other" is its choice. "…or
    // write N/A if you selected another answer" (r.type 'na') is N/A until then, and yours to write after.
    if ((r.part === 'specify' || r.type === 'na') && opts.followed != null) {
      const other = OTHER_CHOSEN.test(U.normalize(opts.followed));
      if (r.type === 'na' ? other || !opts.followed : !other) return { action: 'skip' };
    }
    let v = F().resolve(r.type, profile, ctx);
    if (v && r.type !== 'custom' && FOLLOW_UP.test(ctx.question) && !F().followUpAnswer(v, desc.kind))
      return { action: 'skip' };
    // A custom answer naming several of the options ("Technology, Quantitative Research") picks each of them where
    // the question takes several.
    if (v && r.type === 'custom' && takesSeveral(desc)) v = listAnswer(v, desc) || v;
    if (!v) {
      const meant = (def && def.secret) || F().leftEmpty(r.type, profile, ctx);
      return { action: meant ? 'leave' : 'missing', unresolved: true };
    }
    return { action: 'fill', value: v };
  }

  /**
   * The options value `v` picks in a list the page offers (desc.options): indexes, [] for none. A <select multiple> or
   * a checklist takes every match of a list ("London, New York"), a checklist of acknowledgements each statement you
   * agree to; a lone checkbox ([0]) is ticked for a yes or for one of a list's items. Null for a box without options.
   */
  function picks(desc, v) {
    const options = desc.options || [];
    const one = (i) => (i >= 0 ? [i] : []);
    const many = v.kind === 'list' || v.many;
    switch (desc.kind) {
      case 'select':
        return desc.multiple && many ? M().matchAll(options, v) : one(M().matchOption(options, v));
      case 'radio':
        return one(M().matchOption(options, v));
      case 'checkboxes': {
        let out = many ? M().matchAll(options, v) : [];
        if (v.consent) out = options.map((o, i) => (F().isAcknowledgement(o.text) ? i : -1)).filter((i) => i >= 0);
        if (!out.length && !v.many) {
          const i = M().matchOption(options, v);
          out = i >= 0 ? [i] : M().matchAll(options, v);
        }
        return out;
      }
      case 'checkbox':
        return (many ? M().matchAll(options, v).length > 0 : v.canonical === 'yes') ? [0] : [];
      default:
        return options.length ? one(M().matchOption(options, v)) : null;
    }
  }

  /**
   * Does a follow-up's condition fail on what the list before it holds (`before`: its answer as the page shows it, ''
   * for none, null when the field before is no list)? "If yes, please give details" after a "No" is no question for the
   * AI. Nothing chosen says nothing.
   */
  function conditionFails(desc, r, before) {
    const said = U.normalize(before || '');
    if (!said) return false;
    const asked = M().questionText(desc);
    const q = U.normalize(asked);
    // The plan's "Please specify" box for its list: only once the list is on "Other".
    if (r && r.part === 'specify') return !OTHER_CHOSEN.test(said);
    if (IF_YES.test(q)) return SAID_NO.test(said);
    if (IF_NO.test(q)) return /^yes\b/.test(said);
    if (IF_OTHER.test(q)) return !OTHER_CHOSEN.test(said);
    const picked = String(asked).trim().match(IF_PICKED);
    return !!picked && !said.includes(U.normalize(picked[3]));
  }

  /** What the list before a field holds, as conditionFails() takes it: null when the field before is no list. */
  const beforeOf = (desc, text) => (desc && CHOICE_KINDS.has(desc.kind) ? text || '' : null);

  /** The field a follow-up's condition is on: the list the plan says it follows, else the field before it. */
  const conditionOn = (r, i) => (r && r.follows != null ? r.follows : i - 1);

  /**
   * Does a field the fill left empty go to the AI? Null when not (an upload, contact details, diversity answers, what
   * the profile leaves empty on purpose, a follow-up whose condition the list before it rules out), else { guess }: what
   * the rules would have put there (a choice none of whose options matched it), or null. `prevType`: the type of the
   * field before it; `before`: what that field holds, when it is a list (beforeOf()).
   */
  function forAi(desc, r, profile, context, prevType, before = null) {
    if (NO_AI_KINDS.has(desc.kind)) return null;
    const q = U.normalize(M().questionText(desc));
    if (q.length < 3) return null;
    if (before != null && conditionFails(desc, r, before)) return null;
    let guess = null;
    if (r && r.type === 'custom') guess = { type: 'custom', value: r.answer };
    else if (r && r.type && r.type !== 'na') {
      const def = F().DEFS[r.type];
      if (NOT_FOR_AI.test(r.type) || !def || def.consent || def.secret || def.file || def.leave) return null;
      const ctx = contextOf(desc, r, context);
      // A grade your profile holds is the rules' to give (or to leave, as a class in a GPA box that wants a number):
      // the AI never turns a 2:1 into a GPA. Nor does it answer a box left empty on purpose.
      if (F().gradeHeld(r.type, profile, ctx) || F().leftEmpty(r.type, profile, ctx)) return null;
      const v = F().resolve(r.type, profile, ctx);
      if (v && (desc.kind === 'checkbox' || (FOLLOW_UP.test(q) && !F().followUpAnswer(v, desc.kind)))) return null;
      if (v) guess = { type: r.type, value: v.text };
    }
    if (prevType && PRIVATE_BEFORE.test(prevType) && FOLLOW_ON.test(q)) return null;
    return { guess };
  }

  /**
   * A question for the AI as the fill sends it (an item of answers.answer): its words, help, section and options, and
   * what the rules made of it (`guess`: { type, value }, from forAi()). The fill adds the rest (id, the question
   * before it, a menu's options once opened).
   */
  function aiItem(desc, guess) {
    const s = desc.signals || {};
    const options =
      desc.options && desc.kind !== 'checkbox'
        ? desc.options
            .filter((o) => !o.disabled)
            .map((o) => U.cleanLabel(o.text, 200))
            .filter((t) => t && !M().isPlaceholder(U.normalize(t)))
        : null;
    return {
      question: U.cleanLabel(M().questionText(desc), 600),
      help: U.cleanLabel(s.describedby || '', 300),
      kind: desc.kind,
      options: options && options.length ? options : null,
      multiple: desc.kind === 'checkboxes' || !!desc.multiple,
      maxLength: desc.maxLength || 0,
      section: U.cleanLabel(s.section || '', 120),
      placeholder: U.cleanLabel(desc.placeholderRaw || '', 120),
      guess: guess || null,
    };
  }

  /**
   * The documents an upload takes, its own first: your CV's upload, when it takes several files ("Resume/CV/
   * Transcripts" on Workday), also takes your letter and transcript, those you have (`has(type)`), unless the form
   * has a separate upload for one (`uploadTypes`).
   */
  function carriedBy(desc, r, profile, uploadTypes, has) {
    if (r.type !== 'file.resume' || desc.kind !== 'file' || !desc.multiple) return [r.type];
    const s = desc.signals || {};
    const text = U.normalize([s.question, s.label, s.aria, s.nearby, s.group, s.section].filter(Boolean).join(' '));
    const also = F().uploadAlso(text, { multiple: true, profile, separate: uploadTypes });
    return [r.type, ...also.filter(has)];
  }

  /** What a value looks like once in the field: the options it picks, or the text typed. */
  function shown(desc, v) {
    const p = picks(desc, v);
    if (p === null) return { text: M().formatForText(v, desc) || v.text || '' };
    return { picked: p, text: p.map((i) => desc.options[i].text).join(' | ') };
  }

  /**
   * Every field of a page as a fill would leave it, without the page: what the profile puts in each (and which of a
   * list's options), what is left for you or missing, and what goes to the AI. One entry per descriptor:
   * { type, index, part, action, text, picked, ai, guess, withheld }, the action as field() says, or 'nomatch' (a list
   * none of whose options is yours) or 'none' (nothing recognised). opts: { docs: the documents you have by type
   * ('file.resume'…), consents, context (joined to the plan's), withheld: (item) => why the AI never sees an
   * aiItem() (answers.withheld), or null }.
   */
  function page(descs, profile, opts = {}) {
    const { results, context } = M().plan(descs, profile);
    const ctx = Object.assign({}, context, opts.context);
    const docs = opts.docs || {};
    const uploadTypes = new Set(
      results.filter((r) => r && r.type && F().DEFS[r.type] && F().DEFS[r.type].file).map((r) => r.type),
    );
    const out = [];
    descs.forEach((desc, i) => {
      const r = results[i];
      const entry = { type: (r && r.type) || null, index: (r && r.index) || 0, part: (r && r.part) || null };
      if (!r || !r.type) entry.action = 'none';
      else {
        // What the list a follow-up box follows came to hold; unknown for a menu whose options weren't read (its
        // pick is the page's to make), as for a fill before the menu is opened.
        const list = r.follows != null ? descs[r.follows] : null;
        const known = list && (list.options || []).length && out[r.follows];
        const followed = known ? out[r.follows].text || '' : null;
        const d = field(desc, r, profile, ctx, { ctx: { consents: !!opts.consents }, followed });
        entry.action = d.action;
        if (d.action === 'upload') {
          const carried = carriedBy(desc, r, profile, uploadTypes, (t) => !!docs[t]);
          const have = carried.filter((t) => docs[t]);
          if (have.length) entry.text = have.join(' + ');
          else entry.action = 'missing';
        } else if (d.action === 'fill') {
          const seen = shown(desc, d.value);
          if (seen.picked && !seen.picked.length) entry.action = 'nomatch';
          else Object.assign(entry, seen);
        }
      }
      // What a fill leaves empty goes to the AI, when it may.
      if (!['fill', 'upload'].includes(entry.action)) {
        const prev = i > 0 && results[i - 1] ? results[i - 1].type : null;
        const on = conditionOn(r, i);
        const before = on >= 0 && out[on] ? beforeOf(descs[on], out[on].text) : null;
        const ai = forAi(desc, r, profile, ctx, prev, before);
        const why = ai && opts.withheld ? opts.withheld(aiItem(desc, ai.guess)) : null;
        if (why) entry.withheld = why;
        else if (ai) {
          entry.ai = true;
          if (ai.guess) entry.guess = ai.guess.value;
        }
      }
      out.push(entry);
    });
    return out;
  }

  const decide = { field, picks, forAi, aiItem, beforeOf, conditionOn, carriedBy, page, contextOf, FOLLOW_UP };
  JTF.decide = decide;
  if (typeof module === 'object' && module.exports) module.exports = decide;
})(typeof globalThis !== 'undefined' ? globalThis : this);
