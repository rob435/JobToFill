/*
 * JobToFill — what a fill does with each field, decided without the page (DOM-free). The fill (content/main.js), its
 * picks among a list's options (content/fill.js) and the detection benchmark (tests/bench) all decide here, so the
 * benchmark scores what the extension does:
 *   field(desc, r, profile, context, opts)   fill, upload, leave, skip, consent or missing, with the value
 *   picks(desc, v)                           the options a value picks in a list the page offers
 *   outcome(r, d, res)                       what the rules' turn left a field as (OUTCOMES): the fill records it
 *   forAi(desc, r, profile, context, prev, before, allow, tried)  whether a field left empty goes to the AI, and the
 *                                            rules' guess
 *   asks(question), forJob(text)             a question answered in your own words; a page that is part of applying
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
    /^(name\.|email(\.|$)|phone|address\.|links\.|dob$|age$|pronouns$|account\.|otp$|human$|cc\.|file\.|consent$|optIn$|referee$|page$|eeo\.|coverLetter$|job\.salary$|compliance\.sanctions$|job\.availability$)/;
  // Boxes the AI never writes in.
  const NO_AI_KINDS = new Set(['file', 'password', 'email', 'tel', 'url']);
  // "If other, please specify" after a diversity or password question belongs to it.
  const FOLLOW_ON = /^(if|please (specify|explain|state|give|provide)|other\b|specify)\b/;
  const PRIVATE_BEFORE = /^(eeo\.|account\.|cc\.)/;
  // What the rules leave empty that the AI may answer when the candidate lets it answer that kind of question
  // (settings.aiSensitive): diversity answers left on "— don't fill —" or matching no option, Menzies' "Did your
  // household receive income support…?", sanctions statements the profile can't settle, a date of birth the profile
  // lacks. Declarations stay the rules' (Settings › "Tick acknowledgement boxes"), opt-ins and secrets never go.
  const MAY_ALLOW = { eeo: /^eeo\./, legal: /^compliance\.sanctions$/, identity: /^dob$/ };
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

  /**
   * A field's life through a fill, spelt out: what the rules' turn can leave it as, and what each allows next.
   * The fill records one for every field it meets (content/main.js, by element) and each later stage reads it, rather
   * than working out again from the page what happened to it:
   *   reread  a closed list (a dropdown whose options exist only while it is open) left like this is opened and read
   *           once, and the rules look at it again with its options (a grade list of "1st | 2:1 | 2:2" is a class, a
   *           "Yes | No" under "…County Court Judgements…" no county)
   *   ai      it may then be the AI's (forAi() decides, with what may never be sent)
   *   yours   it is left for the person, and said so by name
   * Every field ends in exactly one of them; none ends empty without a word.
   */
  const OUTCOMES = {
    // It held something already: yours, the site's, an earlier fill's.
    kept: { reread: false, ai: false, yours: false },
    // The profile's answer went in.
    filled: { reread: false, ai: false, yours: false },
    // Yours to decide, by design: an acknowledgement with the setting off, an opt-in, a referee's details. The AI's
    // only where the candidate lets it answer that kind (forAi).
    left: { reread: false, ai: true, yours: true },
    // Not asked of you: a follow-up to an answer you didn't give, an upload for a level you haven't studied at.
    skipped: { reread: false, ai: true, yours: false },
    // Empty on purpose, as its words read ("A-Level Subject 4" for three A-levels, a GPA box for a 2:1).
    blank: { reread: true, ai: true, yours: false },
    // No rule knows the question.
    unknown: { reread: true, ai: true, yours: true },
    // Recognised, and the profile has nothing for it.
    missing: { reread: true, ai: true, yours: true },
    // A list none of whose options is the profile's answer.
    nomatch: { reread: true, ai: true, yours: true },
    // The page didn't take it.
    failed: { reread: false, ai: true, yours: true },
  };

  /**
   * What the rules' turn left a field as: one of OUTCOMES, from its plan entry `r`, what field() decided (`d`) and,
   * when a value was put, what the page made of it (`res`: fill.apply's { status, reason }).
   */
  function outcome(r, d, res) {
    if (!r || !r.type) return 'unknown';
    if (res) {
      if (res.status === 'filled') return 'filled';
      if (res.status === 'skipped') return res.reason === 'has value' ? 'kept' : 'skipped';
      return res.status === 'nomatch' ? 'nomatch' : 'failed';
    }
    if (!d) return 'unknown';
    if (d.action === 'consent') return 'left';
    if (d.action === 'skip') return 'skipped';
    if (d.action === 'leave') return d.unresolved ? 'blank' : 'left';
    return 'missing';
  }

  // A list's own prompt, with or without its "Required": what a dropdown is called when the page gives it no name
  // of its own. It asks nothing anyone can answer, and twenty of them on a page read the same.
  const PROMPT_ONLY =
    /^(please )?(select|choose|pick)( (one|an? (option|item|answer|value|response)|options?|from (the )?(list|options)))?( required| optional)?$/;
  // A question someone answers in their own words: one that opens by asking ("Do you have any hands-on experience
  // using SQL…"), says what to write ("Describe a scenario where…", "Tell us about…") or sets its length ("(Max 150
  // words)"), or ends with a question mark. Never a box's name ("Gift message", "Order notes", "Search").
  const ASKING =
    /^(why|how|what|which|when|where|who|whose|describe|tell (us|me)|explain|share|outline|summari[sz]e|walk us through|give (us )?an example|please (describe|explain|tell|share|outline|summari[sz]e|elaborate|provide|give|list|state|specify|indicate)|in (no more than |under |fewer than |less than )?\d+ words|(do|does|did|are|is|have|has|were|was|would|will|can|could) you)\b/;
  const LENGTH = /\b\d{1,4} ?(words?|characters?|chars?)\b|\bword (limit|count)\b/;

  /** Does a field's question (its words as the page shows them) ask something answered in your own words? */
  function asks(question) {
    const raw = String(question || '');
    const q = U.normalize(raw);
    if (q.split(' ').length < 4) return false;
    return /\?/.test(raw) || ASKING.test(q) || LENGTH.test(q);
  }

  // What a page says it is for when it is part of applying for a job, though none of its fields is an application's
  // (a recruiter's follow-up: "Addepar Internship Questionnaire", "Spring Week – Additional Questions",
  // "Candidate Questionnaire", "Graduate Programme: Video Interview Preferences").
  const JOB_PURPOSE =
    /\b(intern(ship)?s?|graduate (programmes?|programs?|schemes?|roles?|jobs?)|placements?|apprenticeships?|spring (weeks?|insights?)|insight (days?|weeks?|programmes?|programs?)|off ?cycle|candidates?|recruit(ment|ing)|hiring|interviews?|job applications?|vacanc(y|ies)|careers?|assessment cent(re|er)s?)\b/;

  /** Does a page's title and headings (`text`) say it is part of applying for a job? */
  const forJob = (text) => JOB_PURPOSE.test(U.normalize(text));

  // Contact details read into a question that isn't one: what a list none of whose options fits them hands back to
  // the AI as a question nobody recognised. Never a diversity question, a consent, an upload or a secret.
  const MISREAD = /^(name\.|address\.|phone|links\.)/;

  /** What a field's value is worked out from: the plan's entry and part, the question, the page's help, the options. */
  function contextOf(desc, r, context, extra) {
    return Object.assign(
      {},
      context,
      {
        index: r.index || 0,
        // A box of one education or job entry's block (iCIMS's "Did You Graduate?" in Education (2)), not a question of
        // its own about your studies.
        entry: !!r.entry,
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
    // iCIMS's "If your school is not listed, enter it here" after its School list: your school when the list took
    // nothing (it hasn't got it) or its "Other", never beside the one it took.
    if (r.unlisted && opts.followed && !OTHER_CHOSEN.test(U.normalize(opts.followed))) return { action: 'skip' };
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
    // The plan's "Please specify" box for its list, and its box for an answer the list lacks: only once the list is
    // on "Other".
    if (r && (r.part === 'specify' || r.unlisted)) return !OTHER_CHOSEN.test(said);
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

  /** Does `allow` (settings.aiSensitive) let the AI answer a field of this type the rules left empty? */
  const allows = (allow, type) =>
    !!allow && Object.keys(MAY_ALLOW).some((k) => allow[k] === true && MAY_ALLOW[k].test(type || ''));

  // Answers the AI never reads as "the question before" another (its `follows`): diversity answers, a date of birth
  // or an age, pronouns, a title, adjustments, logins and cards (as a redacted snapshot hides them).
  const PRIVATE_ANSWER = /^(eeo\.|pronouns$|name\.prefix$|dob$|age$|job\.adjustments$|account\.|cc\.)/;

  /**
   * Is what a field of this type holds kept from the AI when it is the field before a question? Every secret (a
   * password, a card, a code), the private types above; a diversity answer only while the candidate keeps those from
   * the AI (`allow`, settings.aiSensitive: then it is in the AI's own block of them anyway).
   */
  function hidesAnswer(type, allow) {
    if (!type) return false;
    const def = F().DEFS[type];
    if (def && def.secret) return true;
    if (/^eeo\./.test(type) && allows(allow, type)) return false;
    return PRIVATE_ANSWER.test(type);
  }

  /**
   * Does a field the fill left empty go to the AI? Null when not (an upload, contact details, diversity answers, what
   * the profile leaves empty on purpose, a follow-up whose condition the list before it rules out), else { guess }: what
   * the rules would have put there (a choice none of whose options matched it), or null. `prevType`: the type of the
   * field before it; `before`: what that field holds, when it is a list (beforeOf()); `allow`: settings.aiSensitive,
   * the kinds of question the candidate lets the AI answer too (MAY_ALLOW), none when left out; `tried`: what the
   * rules' turn left it as (outcome()), when they had one.
   */
  function forAi(desc, r, profile, context, prevType, before = null, allow = null, tried = null) {
    if (NO_AI_KINDS.has(desc.kind)) return null;
    if (tried && OUTCOMES[tried] && !OUTCOMES[tried].ai) return null;
    // A box the plan set aside as someone else's address (iCIMS's "Address" and "Postal Code" in a job entry: the
    // employer's) is nobody's to guess.
    if (r && !r.type && r.dropped && NOT_FOR_AI.test(r.dropped)) return null;
    const q = U.normalize(M().questionText(desc));
    if (q.length < 3 || PROMPT_ONLY.test(q)) return null;
    if (before != null && conditionFails(desc, r, before)) return null;
    let guess = null;
    if (r && r.type === 'custom') guess = { type: 'custom', value: r.answer };
    else if (r && r.type && r.type !== 'na') {
      const def = F().DEFS[r.type];
      // A date of birth in one box: its day, month and year boxes apart are no question to ask on their own.
      const allowed = allows(allow, r.type) && !(r.type === 'dob' && r.part);
      if (!def || def.consent || def.secret || def.file) return null;
      // A list the rules took for a contact detail, none of whose options is it (Lloyds' "Do you have four or more
      // County Court Judgements…?" read as a county, over Yes and No): they misread it, and it is the AI's as a
      // question nobody recognised, without their guess.
      if (tried === 'nomatch' && MISREAD.test(r.type) && (desc.options || []).length) return { guess: null };
      if (!allowed && (NOT_FOR_AI.test(r.type) || def.leave)) return null;
      const ctx = contextOf(desc, r, context);
      // A grade your profile holds is the rules' to give (or to leave, as a class in a GPA box that wants a number):
      // the AI never turns a 2:1 into a GPA. Nor does it answer a box left empty on purpose.
      if (F().gradeHeld(r.type, profile, ctx) || (!allowed && F().leftEmpty(r.type, profile, ctx))) return null;
      const v = F().resolve(r.type, profile, ctx);
      if (v && (desc.kind === 'checkbox' || (FOLLOW_UP.test(q) && !F().followUpAnswer(v, desc.kind)))) return null;
      // A sanctions answer the rules couldn't settle ("It depends") is no answer to pass on. Nor is a yes or no read
      // only from what stands around the field (a fieldset's legend, a wrapper's id): the question itself may ask the
      // opposite ("…legal right to work in the UK without requiring a visa or sponsorship?" under a paragraph on
      // sponsorship).
      const around = r.source === 'rule' && r.score < 0.6 && /^(yes|no)$/.test(v ? v.canonical || '' : '');
      if (v && v.kind !== 'sanctions' && !around) guess = { type: r.type, value: v.text };
    }
    // "Please specify" after a diversity question is the AI's too when diversity questions are.
    const ownBefore = allows(allow, 'eeo.') ? /^(account\.|cc\.)/ : PRIVATE_BEFORE;
    if (prevType && ownBefore.test(prevType) && FOLLOW_ON.test(q)) return null;
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
      // The rest of a long question read line by line: the paragraphs before what it asks, the notes after.
      context: U.cleanLabel(s.preamble || '', 900),
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
   * aiItem() (answers.withheld), or null, allow: settings.aiSensitive (forAi(); the benchmark leaves it out, as a
   * fill with the defaults) }.
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
      let d = null;
      if (!r || !r.type) entry.action = 'none';
      else {
        // What the list a follow-up box follows came to hold; unknown for a menu whose options weren't read (its
        // pick is the page's to make), as for a fill before the menu is opened.
        const list = r.follows != null ? descs[r.follows] : null;
        const known = list && (list.options || []).length && out[r.follows];
        const followed = known ? out[r.follows].text || '' : null;
        d = field(desc, r, profile, ctx, { ctx: { consents: !!opts.consents }, followed });
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
        const tried = outcome(r, d, entry.action === 'nomatch' ? { status: 'nomatch' } : null);
        const ai = forAi(desc, r, profile, ctx, prev, before, opts.allow, tried);
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

  const decide = {
    OUTCOMES,
    outcome,
    field,
    picks,
    forAi,
    aiItem,
    asks,
    forJob,
    hidesAnswer,
    beforeOf,
    conditionOn,
    carriedBy,
    page,
    contextOf,
    FOLLOW_UP,
  };
  JTF.decide = decide;
  if (typeof module === 'object' && module.exports) module.exports = decide;
})(typeof globalThis !== 'undefined' ? globalThis : this);
