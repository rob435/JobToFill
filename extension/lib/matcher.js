/*
 * JobToFill — the pure (DOM-free) half of the engine:
 *   classify(desc)          which field type is this control?
 *   plan(descs, profile)    classify a whole page, apply custom answers and
 *                           work out which education / job entry each box is for
 *   matchOption(opts, val)  pick the right <option>, radio or list item
 *   formatForText(val, d)   turn a value into the string a text box expects
 *
 * A "descriptor" is a plain object built by content/dom.js (or by a unit test):
 *   { kind, inputType, autocomplete, maxLength, placeholderRaw,
 *     options: [{ text, value }], signals: { label, question, aria, nearby,
 *     placeholder, attrs, name, id, title, group, ancestors, describedby } }
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});
  const U = JTF.util;
  const norm = U.normalize;
  const F = () => JTF.fields;

  // How much each piece of evidence counts. An explicit <label> beats a name attribute.
  const WEIGHTS = {
    label: 1,
    question: 1,
    aria: 0.95,
    nearby: 0.8,
    placeholder: 0.75,
    attrs: 0.7,
    name: 0.7,
    id: 0.65,
    title: 0.6,
    group: 0.45, // legend of a small fieldset around the control, e.g. "Phone" around a country picker
    ancestors: 0.35,
    describedby: 0.3,
  };

  const MIN_SCORE = 0.35;
  // An ancestor's id alone ("formField-startDate") only names a date box; "…_mobile_modal" is not a phone.
  const ANCESTOR_ONLY = 0.4;
  // Types whose value is a short phrase, never the answer to an essay question.
  const SHORT_VALUE =
    /^(name\.|edu\.(school|degree|field|gpa|classification|location|country|start|end)|exp\.(company|title|location|country)|address\.|location$|email$|phone|links\.|nationality$|pronouns$|job\.(currentCompany|currentTitle|salary|yearsExperience|startDate|referralSource)$)/;
  // Types a Yes/No question never asks for ("Has a bonding company ever denied you?" is not your employer).
  const NEVER_YES_NO =
    /^(name\.|edu\.(school|degree|field|gpa|classification|location|country)|exp\.(company|title|location|country)|address\.|location$|email$|phone|links\.|nationality$|pronouns$|account\.|job\.current(Company|Title)$)/;
  // "Are you related to anyone working here? If yes, list their name": a yes/no question, whatever the box.
  // "Could you please provide your degree classification?" is a request, not a yes/no question.
  const YES_NO_QUESTION =
    /^(are|do|does|did|have|has|had|is|was|were|will|would|can|could|should|may) (you|your|any|there|we|anyone|this|it)\b(?! (kindly |please )?(provide|tell|share|list|give|describe|explain|specify|enter|state|indicate|select|choose|upload|outline|advise|let us know|write|detail|name|identify|confirm (your|the|which|what|whether))\b)/;
  // "Do you have a GitHub? Please share the link" in a text box still wants the link.
  const LINK_TYPE = /^links\./;
  const YES_NO_TYPES = /^job\.(authorized|sponsorship|relocate|over18)$/;
  const EXPLAIN =
    /\b(outline|describe|explain|provide (details|information|more)|give (details|more)|tell us (about|more)|elaborate)\b/;
  const LINK_KINDS = ['text', 'url', 'textarea'];
  // "Please specify if you selected Other", "University (Other)", "School name (if not listed)", "If your year of
  // graduation is not listed, please specify.", "If latest field of study is not listed…" (IMC), "If residing in
  // another country, please specify.": the box for an answer the list didn't have.
  const OTHER_FOLLOW_UP =
    /^(if|when) (you )?(selected|chose|answered|picked|ticked|checked) other\b|^(if|when) you (have )?(selected|chose|picked|ticked|checked) (?!yes\b)|\bif (you (selected|chose|answered|picked|ticked|checked) )?other\b.*\b(specify|state|tell|describe|provide|enter|give)|\b(specify|state|describe)\b.*\bif (you )?(selected|chose|answered|picked) other\b|^other please specify$|^if other\b|\bif (it|yours|your \w+( \w+)?) (is|was) not (listed|shown|in the list|found|available)\b|\bif (\w+ ){1,6}?(is|are|was|were) not (listed|shown|in (the|this|our) (list|options|dropdown))\b|\bif (\w+ ){1,6}?(isn t|aren t|wasn t|weren t) (listed|shown|in (the|this) list)\b|\bif (\w+ ){1,6}?(does not|doesn t|do not|don t) (appear|show up)\b|\bif (\w+ ){1,6}?not in (the|this) list\b|\bif (residing|living|based|located|studying) (in |at )?(another|a different) \w+\b|\bnot listed (above|below)\b.*\b(specify|enter|type|provide|state)\b|\bif not (listed|shown|in the list|found|available)\b|^(any )?other (university|school|college|institution|degree|subject|major|course)\b|\b(university|school|college|institution|degree|subject|major|course) (name )?other$/;
  // A bare "Please specify" / "If other, please tell us where": the box for the answer a list above didn't have.
  const SPECIFY =
    /^(please )?(specify|explain|state)\b|^(if )?other\b|\bselected other\b|^(please )?(tell us|let us know) (where|which|more)\b/;
  const EMAIL_TYPES = new Set(['email', 'email.school', 'account.username']);
  // Field types a lone checkbox can answer: "I am authorized to work in the US", "I have read the
  // privacy notice", or one option of a checklist ("London" under "Which offices…?").
  const CHECKBOX_TYPES = new Set([
    'job.authorized',
    'job.sponsorship',
    'job.relocate',
    'job.over18',
    'exp.current',
    'consent',
    'edu.end', // "I confirm that I will graduate in 2027": ticked only when your date says so
    'job.locations',
    'skills',
    'languages',
    'human', // a plain "I'm not a robot" box
    'compliance.sanctions', // one statement of a sanctions list, or its "None of the above"
    'job.availability', // one interview slot
  ]);

  // "…outside of the classroom? For example: student clubs, partner organisations…": the examples don't say
  // what the question asks for.
  const EXAMPLES = /\b(for example|for instance|e g|such as)\b.*$/;

  // A paragraph's sentences: "…of any individual. We recognise that… If you are invited for an interview, are…".
  const SENTENCE_END = /(?<=[.?!])\s+(?=["'“(]?[A-Z0-9])/;
  const FOCUS_KEYS = new Set(['label', 'question', 'aria', 'nearby']);

  /**
   * The sentence a long, several-sentence question asks (its last question, else its last sentence), or ''. The rest
   * is preamble: "We are committed to ensuring that the firm removes any unnecessary barriers…" says nothing about
   * your employer.
   */
  function focusOf(raw) {
    const sentences = raw.split(SENTENCE_END).filter((t) => t.trim());
    if (sentences.length < 2 || raw.split(/\s+/).length < 20) return '';
    const asks = sentences.filter((t) => /\?\s*$/.test(t.trim()));
    return norm(asks.length ? asks[asks.length - 1] : sentences[sentences.length - 1]);
  }

  function signalTexts(desc) {
    const out = [];
    const s = desc.signals || {};
    for (const key of Object.keys(WEIGHTS)) {
      if (!s[key]) continue;
      // "Mobile Number (+CountryCode)", "(country code + number)": that plus is a word.
      const raw = String(s[key])
        .slice(0, 300)
        .replace(/\+\s*(?=country|((phone|mobile) )?number)/gi, ' plus ');
      let text = norm(raw);
      const m = text.match(EXAMPLES);
      if (m && text.slice(0, m.index).split(' ').length > 6) text = text.slice(0, m.index).trim();
      const focus = FOCUS_KEYS.has(key) ? focusOf(raw) : '';
      if (text) out.push({ key, text, weight: WEIGHTS[key], focus });
    }
    return out;
  }

  // Answers never asked in the preamble of a paragraph: a name, an employer, a school, a list of skills.
  const PREAMBLE_NEVER = (type) => SHORT_VALUE.test(type) || type === 'skills' || type === 'languages';

  function kindAllowed(rule, desc) {
    if (desc.kind === 'checkbox') return CHECKBOX_TYPES.has(rule.type);
    const kinds = rule.kinds || F().KINDS.DEFAULT_KINDS;
    if (!kinds.includes(desc.kind)) return false;
    if (desc.kind === 'email' && !EMAIL_TYPES.has(rule.type)) return false;
    return true;
  }

  function fromAutocomplete(desc) {
    if (!desc.autocomplete || ['radio', 'checkbox', 'checkboxes', 'file'].includes(desc.kind)) return null;
    const tokens = desc.autocomplete.toLowerCase().split(/\s+/);
    for (const token of tokens) {
      const hit = F().AUTOCOMPLETE[token];
      if (!hit) continue;
      const [type, part] = hit;
      // Sites stick autocomplete="new-password" on random boxes to stop browser autofill.
      if (type.startsWith('account.pass') && desc.kind !== 'password') return null;
      if (desc.kind === 'password' && !type.startsWith('account.pass')) return null;
      return { type, part: part || null, score: 2, source: 'autocomplete' };
    }
    return null;
  }

  function fallback(desc) {
    switch (desc.kind) {
      case 'email':
        return { type: 'email', part: null, score: 0.4, source: 'type' };
      case 'tel':
        return { type: 'phone', part: null, score: 0.4, source: 'type' };
      case 'password':
        return { type: 'account.password', part: null, score: 0.4, source: 'type' };
      case 'url':
        return { type: 'links.website', part: null, score: 0.3, source: 'type' };
      default:
        return null;
    }
  }

  /** Options that are all yes/no answers ("Yes", "No", "Prefer not to say"). */
  function yesNoOptions(desc) {
    const opts = (desc.options || []).filter((o) => !isPlaceholder(norm(o.text)));
    return opts.length > 0 && opts.length <= 3 && opts.every((o) => canonicalOf(o.text));
  }

  /** Classify one control. Returns { type, part, score, source } or null. */
  function classify(desc) {
    const ac = fromAutocomplete(desc);
    if (ac) return refine(ac, desc);

    const signals = signalTexts(desc);
    const s = desc.signals || {};
    // "Citizen or permanent resident of Cuba, Iran, North Korea, or Syria" among the options: a sanctions question,
    // whatever it says ("If you selected a response other than none of the above…" too).
    if (sanctionsOptions(desc)) return { type: 'compliance.sanctions', part: null, score: 1, source: 'options' };
    // "Do any of the following apply to you?" over declarations and a "None of these apply to me".
    if (DECLARATION_KINDS.includes(desc.kind) && declarationList(desc.options))
      return { type: 'compliance.declarations', part: null, score: 1, source: 'options' };
    // "Which university…? Please select "Other" if yours is not listed" is the question, not its follow-up box.
    const asked = String(s.question || s.label || s.aria || s.nearby || '');
    const head = asked.split('?')[0];
    if (OTHER_FOLLOW_UP.test(norm(head.split(' ').length >= 4 ? head : asked))) return null;
    // A Yes/No question is never answered with a name, a school or a link.
    const yesNoAsked = YES_NO_QUESTION.test(norm(s.question || s.label || s.aria || ''));
    const yesNo = yesNoOptions(desc) || yesNoAsked;
    const byType = new Map();
    const ruledOut = new Set();
    let best = null;
    for (const rule of F().RULES) {
      if (!kindAllowed(rule, desc)) continue;
      // A strong signal naming something else ("cover letter" on an "Attach" button) rules this type out, unless what
      // the control visibly says names this type too ("Resume/CV/Transcripts" over a note about transcripts).
      if (
        rule.notAny &&
        signals.some((s) => s.weight >= 0.6 && rule.notAny.test(s.text)) &&
        !(rule.unlessAny && signals.some((s) => s.weight >= 0.75 && rule.unlessAny.test(s.text)))
      ) {
        ruledOut.add(rule.type);
        continue;
      }
      let score = 0;
      let hits = 0;
      let hitText = '';
      for (const s of signals) {
        if (!rule.re.test(s.text) || (rule.not && rule.not.test(s.text))) continue;
        // Only in a long question's preamble, not in what it asks: half as telling, and never a short answer.
        const preamble = !!s.focus && !rule.re.test(s.focus);
        // A list's options settle it ("…U.S. export controls… A United States citizen or national / None…"); a box
        // has only the words.
        if (preamble && PREAMBLE_NEVER(rule.type) && !desc.options) continue;
        const weight = preamble ? s.weight / 2 : s.weight;
        hits++;
        if (weight > score) {
          score = weight;
          hitText = s.text;
        }
      }
      if (!hits) continue;
      if (rule.test && !rule.test(desc, hitText)) continue;
      // An essay box ("Do you have coding experience? … GitHub links welcomed", "Think of something in
      // your academic life…") wants an answer, not a name, school or URL.
      // A grade asked in full in a text area is still a grade ("What is your cumulative undergraduate (Bachelor) GPA on
      // the scale used by your local school/university?", Phenom's text questions).
      const gradeAsked =
        rule.type === 'edu.gpa' && /^(what (is|was) your|please (state|provide|enter)( your)?)\b/.test(hitText);
      if (desc.kind === 'textarea' && SHORT_VALUE.test(rule.type) && hitText.split(' ').length > 12 && !gradeAsked)
        continue;
      // "Inizio offers a full suite of services… have you interviewed with another agency? If so, provide agency
      // name" is never your name, whatever the box.
      if (/^name\./.test(rule.type) && hitText.split(' ').length > 14) continue;
      // "…please outline your current right to work status, visa type and expiry date" wants more than "No".
      if (desc.kind === 'textarea' && YES_NO_TYPES.test(rule.type) && EXPLAIN.test(hitText)) continue;
      const linkBox = LINK_TYPE.test(rule.type) && !desc.options && LINK_KINDS.includes(desc.kind);
      if (yesNo && NEVER_YES_NO.test(rule.type) && !linkBox) continue;
      // "AI policy … our tools" with Yes / No options is not a list of skills; "Are you fluent in French?" is.
      if (rule.type === 'skills' && yesNoOptions(desc)) continue;
      // "Are you available for an interview next week? Yes / No" names no slot to tick; "Is email OK?" no method.
      if ((rule.type === 'job.availability' || rule.type === 'contact.preference') && yesNoOptions(desc)) continue;
      if (rule.type === 'languages' && yesNoOptions(desc) && !F().languagesNamed(hitText).length) continue;
      score += 0.05 * (hits - 1);
      const candidate = { type: rule.type, part: rule.part || null, score, source: 'rule', rule };
      const prev = byType.get(rule.type);
      if (!prev || score > prev.score) byType.set(rule.type, candidate);
      if (!best || score > best.score + 1e-9) best = candidate;
    }
    // A word in the help text or a wrapper's id alone ("…your university's policy…") is not enough.
    // Nor is the box's own type when a strong signal ruled it out ("Alternative phone number" in a tel box).
    if (!best || best.score < MIN_SCORE || (best.score < ANCESTOR_ONLY && !F().DATE_TYPES.has(best.type))) {
      const fb = fallback(desc);
      return refine(fromOptions(desc) || (fb && !ruledOut.has(fb.type) ? fb : null), desc);
    }
    // "What did you receive in your undergraduate degree? First / Upper second / …" asks for the class.
    if (['edu.degree', 'edu.level', 'edu.gpa'].includes(best.type) && looksLikeDegreeClasses(desc.options))
      return refine({ type: 'edu.classification', part: null, score: best.score, source: 'options' }, desc);

    // "Name" labels a first/last pair more often than a full-name box: let specifics win.
    if (best.rule.yieldsTo) {
      for (const type of best.rule.yieldsTo) {
        const alt = byType.get(type);
        if (alt && alt.score >= 0.5) {
          best = alt;
          break;
        }
      }
    }
    return refine({ type: best.type, part: best.part, score: best.score, source: best.source }, desc);
  }

  // A statement about you ("Citizen or permanent resident of…"), never an ethnicity's "Middle Eastern (e.g. Iranian,
  // Syrian…)".
  const ABOUT_YOU_STATEMENT = /\b(citizen\w*|nationals?|nationality|residen\w*|located|live|living|passports?)\b/;

  // What a statement in a list of declarations can be ("You are currently serving as a Government Official…"): a Yes /
  // No question the profile answers.
  const DECLARATIONS = new Set([
    'compliance.government',
    'compliance.relatives',
    'compliance.previouslyEmployed',
    'compliance.previouslyApplied',
    'compliance.criminal',
    'compliance.regulatory',
  ]);
  const DECLARATION_KINDS = ['checkboxes', 'radio', 'select', 'combo', 'combobox'];
  const YES_NO = [
    { text: 'Yes', value: 'Yes' },
    { text: 'No', value: 'No' },
  ];

  /**
   * A list of declarations with its "None of these apply to me" (Oracle's "Do any of the following apply to you?"):
   * { statements: [{ i, text, type }], none: { i, text } }, every other option reading as one of DECLARATIONS when
   * asked as a Yes / No question. Null otherwise.
   */
  function declarationList(options) {
    const opts = (options || [])
      .map((o, i) => ({ i, text: String((o && o.text) || ''), n: norm(o && o.text) }))
      .filter((o) => o.n && !isPlaceholder(o.n));
    if (opts.length < 2 || opts.length > 12) return null;
    const nones = opts.filter((o) => NONE_OPTION.test(o.n));
    if (nones.length !== 1) return null;
    const statements = [];
    for (const o of opts) {
      if (o === nones[0]) continue;
      // "Yes", "Other", "Prefer not to say": answers, not statements.
      if (o.n.split(' ').length < 5) return null;
      const r = classify({
        kind: 'radio',
        inputType: 'radio',
        autocomplete: '',
        maxLength: 0,
        placeholderRaw: '',
        options: YES_NO,
        signals: { question: o.text },
      });
      if (!r || !DECLARATIONS.has(r.type)) return null;
      statements.push({ i: o.i, text: o.text, type: r.type });
    }
    return statements.length ? { statements, none: { i: nones[0].i, text: nones[0].text } } : null;
  }

  /** A choice whose options are sanctions statements (each names two sanctioned places, and who you are there). */
  function sanctionsOptions(desc) {
    if (!F().KINDS.CHOICE.includes(desc.kind) && desc.kind !== 'checkbox') return false;
    return (desc.options || []).some((o) => {
      const n = norm(o.text);
      return F().TWO_SANCTIONED_PLACES.test(n) && ABOUT_YOU_STATEMENT.test(n);
    });
  }

  // UK degree classes and their usual spellings.
  const DEGREE_CLASS =
    /^(first|1st|upper second|lower second|second|2 ?[1i]|2 ?2|2 ?ii|third|3rd|distinction|merit|pass)\b|\b(first|second|third) class\b|\bclass honours\b|\b(upper|lower) second$/;

  // Ordinals of something else: "1st June 2027", "First choice", "2nd preference", "Second year", "Third round".
  const OTHER_ORDINAL =
    /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?|choice|preference|priority|option|round|stage|week|half|quarter|term|semester|year|time|place|rank(ed|ing)?)\b/;

  function looksLikeDegreeClasses(options) {
    const opts = (options || []).filter((o) => !isPlaceholder(norm(o.text)));
    const isClass = (t) => DEGREE_CLASS.test(t) && !OTHER_ORDINAL.test(t);
    return opts.length >= 2 && opts.filter((o) => isClass(norm(o.text))).length / opts.length >= 0.5;
  }

  /**
   * A control no wording identified, recognised by what it offers: a single "I acknowledge"
   * (an acknowledgement), "Male / Female / …" (gender), "First / 2:1 / 2:2" (degree class).
   */
  function fromOptions(desc) {
    const opts = (desc.options || []).filter((o) => !isPlaceholder(norm(o.text)));
    if (!opts.length || desc.kind === 'checkbox') return null;
    const make = (type) => ({ type, part: null, score: 0.5, source: 'options' });
    if (opts.length === 1 && canonicalOf(opts[0].text) === 'yes') return make('consent');
    const canon = opts.map((o) => canonicalOf(o.text));
    if (canon.includes('male') && canon.includes('female')) return make('eeo.gender');
    // "United Kingdom (+44)", "United States (+1)"…: a dial code (Jane Street's picker beside the number has no label).
    if (looksLikePhoneCodes(opts)) return make('phone.countryCode');
    if (looksLikeDegreeClasses(opts)) return make('edu.classification');
    return null;
  }

  const MONTH_WORD = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/;

  /** For date-ish fields, is this box only the month, the year or the day? */
  function detectPart(desc) {
    const opts = (desc.options || []).filter((o) => !isPlaceholder(norm(o.text)));
    if (opts.length >= 3) {
      const texts = opts.map((o) => norm(o.text));
      const share = (re) => texts.filter((t) => re.test(t)).length / texts.length;
      if (share(/^(19|20)\d{2}$/) >= 0.8) return 'year';
      if (
        opts.length <= 13 &&
        texts.filter((t) => (MONTH_WORD.test(t) && !/\b(19|20)\d{2}\b/.test(t)) || /^(0?[1-9]|1[0-2])$/.test(t))
          .length /
          texts.length >=
          0.8
      )
        return 'month';
      if (opts.length >= 28 && share(/^(0?[1-9]|[12]\d|3[01])$/) >= 0.8) return 'day';
    }
    const s = desc.signals || {};
    // A month picker's box ("Start month", its prompt "Select month") takes the month of a year, not just the month.
    if (desc.kind === 'text' && MONTH_PROMPT.test(norm(desc.placeholderRaw || s.placeholder))) return null;
    // "A 3 month placement" or "2 years" is a duration, not a month or year box.
    const text = [s.label, s.aria, s.placeholder, s.name, s.id, s.attrs, s.nearby, s.title]
      .map((t) => norm(t).replace(/\b\d+ (months?|years?|days?)\b/g, ''))
      .join(' | ');
    const hasMonth = /\bmonth\b|\bmm\b|\bmonat\b|\bmes\b|\bmois\b/.test(text);
    const hasYear = /\byear\b|\byyyy\b|\byy\b|\bjahr\b|\bano\b|\bannee\b/.test(text);
    const hasDay = /\bday\b|\bdd\b/.test(text);
    if (hasMonth && !hasYear) return 'month';
    if (hasYear && !hasMonth) return 'year';
    if (hasDay && !hasMonth && !hasYear) return 'day';
    return null;
  }

  function looksLikePhoneCodes(options) {
    const opts = (options || []).filter((o) => !isPlaceholder(norm(o.text)));
    if (opts.length < 3) return false;
    return opts.filter((o) => /\+\s?\d{1,4}\b/.test(o.text)).length / opts.length >= 0.6;
  }

  function refine(r, desc) {
    if (!r) return null;
    if (F().DATE_TYPES.has(r.type) && !r.part) r.part = detectPart(desc);
    // A "prefix" picker beside the number under "Phone number" (Ant Design's docs name it "prefix") is the dial code,
    // not a title like "Mr".
    // A picker of dial codes beside the number box, under "Phone": the code, not the number.
    if (r.type === 'phone' && /^(select|combo|combobox)$/.test(desc.kind) && looksLikePhoneCodes(desc.options))
      r.type = 'phone.countryCode';
    if (
      (r.type === 'address.country' || r.type === 'nationality' || r.type === 'name.prefix') &&
      (looksLikePhoneCodes(desc.options) ||
        /\b(phone|mobile|tel|telephone|cell)\b/.test(norm((desc.signals || {}).group)))
    )
      r.type = 'phone.countryCode';
    // "Employment eligibility status" offering "Yes, will require firm sponsorship" / "No. already has permanent work
    // authorization" (Aquatic): its options answer whether you need sponsoring, whatever the label says. Not "Yes, but I
    // will need visa sponsorship in the future" beside a plain "No, I can't legally work in the US" (circleback).
    const said = (desc.options || []).map((o) => norm(o.text));
    if (
      r.type === 'job.authorized' &&
      said.some((t) => /^yes\b.*\b(require|need)\w*\b.*\bsponsor/.test(t)) &&
      said.some((t) =>
        /^no\b.*\b(already|have|has|hold|holds)\b.*\b(authori[sz]ation|authori[sz]ed|right to work|permit)\b/.test(t),
      )
    )
      r.type = 'job.sponsorship';
    if (desc.kind === 'email' && !EMAIL_TYPES.has(r.type)) r.type = 'email';
    // A "Passcode" box is often type="password" (SuccessFactors): the emailed code, not your password.
    if (desc.kind === 'password' && !r.type.startsWith('account.pass') && r.type !== 'otp') r.type = 'account.password';
    return r;
  }

  /* ----------------------------------------------------------- custom answers */

  // On the normalised heading; "A-level" only when written with a capital A ("Select a level" is not one).
  const SCHOOL_SECTION =
    /\b(high school|secondary (school|education|qualifications?)|sixth form|i?gcses?|highers|international baccalaureate|ib diploma|pre u)\b/;
  const A_LEVELS = /\bA[- ]?[Ll]evels?\b|\bA-?LEVELS?\b/;

  /**
   * The human question a control asks, for custom answers and the learn feature. A box under a school-level
   * heading asks about that level: "Subject" under "A-levels" is "A-levels: Subject".
   */
  function questionText(desc) {
    const s = desc.signals || {};
    const q = U.cleanLabel(s.question || s.label || s.aria || s.nearby || s.placeholder || s.title || '');
    if (s.section && (SCHOOL_SECTION.test(norm(s.section)) || A_LEVELS.test(s.section)) && !F().eduLevelOf(norm(q)))
      return U.cleanLabel(`${s.section}: ${q}`);
    return q;
  }

  /**
   * What the page says about a control besides its question: the help text it points to (aria-describedby) and the
   * instructions under its section's heading ("If your school/university uses a GPA system… Otherwise, provide your
   * overall result in your school/university's grading system" under Workday's "Education").
   */
  function helpText(desc) {
    const s = desc.signals || {};
    return U.cleanLabel([s.describedby, s.sectionHelp].filter(Boolean).join(' '), 600);
  }

  /** "how did you hear|referral" -> phrases; "/^why .* us\??$/i" -> RegExp. */
  function compilePattern(question) {
    const s = String(question || '').trim();
    if (!s) return null;
    const m = s.match(/^\/(.+)\/([a-z]*)$/i);
    if (m) {
      try {
        return { re: new RegExp(m[1], m[2].includes('i') ? m[2] : m[2] + 'i') };
      } catch (err) {
        return null;
      }
    }
    const phrases = s.split('|').map(norm).filter(Boolean);
    return phrases.length ? { phrases } : null;
  }

  function matchCustom(desc, compiled) {
    const raw = questionText(desc);
    if (!raw) return null;
    const padded = ' ' + norm(raw) + ' ';
    for (const { answer, pattern } of compiled) {
      if (pattern.re ? pattern.re.test(raw) : pattern.phrases.some((p) => padded.includes(' ' + p + ' ')))
        return answer;
    }
    return null;
  }

  /* --------------------------------------------------------------------- plan */

  function groupOf(type) {
    if (!type) return null;
    if (type.startsWith('edu.') && !['edu.level', 'edu.year', 'edu.classAtLeast'].includes(type)) return 'edu';
    if (type.startsWith('exp.')) return 'exp';
    return null;
  }

  const DETAILS_OF = {
    'compliance.government': 'compliance.governmentDetails',
    'compliance.relatives': 'compliance.relativesDetails',
  };
  const PLACE_TYPES = ['location', 'address.city'];
  // Controls that offer a list (a react-select search box too).
  const LIST_KINDS = ['select', 'radio', 'combo', 'combobox', 'checkboxes'];
  const ABOUT_YOU_TYPES = ['location', 'address.city', 'address.state', 'address.country', 'address.postalCode'];
  const ABOUT_YOU = /\b(you|your|yourself|reside|resident|residence|live|living|home|currently|current)\b/;
  const SECTION_ONLY = ['address.state', 'address.country', 'address.postalCode'];

  /** How many fields in a row, from results[i], belong to section `g` (generic boxes included). */
  function runLength(results, i, g) {
    let n = 0;
    for (let j = i; j < results.length; j++) {
      const r = results[j];
      if (!r || !r.type || SECTION_ONLY.includes(r.type)) continue;
      if (!(r.type.startsWith('gen.') || PLACE_TYPES.includes(r.type) || groupOf(r.type) === g)) break;
      n++;
    }
    return n;
  }

  const SECTION_HEADINGS = {
    edu: /\b(education|academic|school|universit\w*|college|qualifications?|degrees?|studies)\b/,
    exp: /\b(work|employment|experience|career|jobs?|professional|employers?)\b/,
  };
  // A section about the job applied for, not a history.
  const ROLE_SECTION =
    /\b(the|this|your) (role|position|job|vacancy|opportunity|internship|placement|programme|program)\b|\bavailability\b/;

  /**
   * A generic date that starts a block ("From Date / Expected or Completed Graduation / School…" after the work
   * history, SuccessFactors) belongs to the block it starts: the section of the next field that has one, when there
   * is no section yet, when the section before already has this box (it would start another entry of it), when it
   * pairs with that field ("From" then "Graduation") or when its heading names that section. Null: the section before.
   */
  function leadsInto(results, descs, i, prev, state) {
    const r = results[i];
    if (r.type !== 'gen.start' && r.type !== 'gen.end') return null;
    let next = null;
    let at = -1;
    for (let j = i + 1; j < Math.min(results.length, i + 4); j++) {
      const t = results[j] && results[j].type;
      if (!t || t.startsWith('gen.') || PLACE_TYPES.includes(t) || SECTION_ONLY.includes(t)) continue;
      next = groupOf(t);
      at = j;
      break;
    }
    if (!next || next === prev) return null;
    if (!prev) return next;
    if (state[prev].seen.has(prev + r.type.slice(3) + ':' + (r.part || ''))) return next;
    if (r.type === 'gen.start' && at === i + 1 && results[at].type === next + '.end') return next;
    const heading = norm((descs[i].signals || {}).section);
    return SECTION_HEADINGS[next].test(heading) && !SECTION_HEADINGS[prev].test(heading) ? next : null;
  }

  /**
   * Classify every control on a page, then use document order to decide which
   * education / work-history entry each box belongs to: a repeated type
   * ("School" again) starts the next entry, and generic boxes ("From", "To",
   * "Location") take the section of the field just before them. A question asked
   * again away from its section ("Which term matches your graduation date?" among
   * the screening questions) is about your first entry, not a new one.
   */
  function plan(descs, profile) {
    const compiled = ((profile && profile.customAnswers) || [])
      .filter((a) => a && !U.isBlank(a.answer))
      .map((a) => ({ answer: a, pattern: compilePattern(a.question) }))
      .filter((c) => c.pattern);

    const results = descs.map((desc) => {
      if (desc.kind !== 'file' && desc.kind !== 'password' && compiled.length) {
        const a = matchCustom(desc, compiled);
        if (a) return { type: 'custom', part: null, score: 3, source: 'custom', answer: a.answer, answerId: a.id };
      }
      return classify(desc);
    });

    // "Title" just before the name boxes is Mr / Ms, not a job title.
    results.forEach((r, i) => {
      if (!r || r.type !== 'exp.title' || norm(questionText(descs[i])) !== 'title') return;
      const next = results.slice(i + 1, i + 4).find((x) => x && x.type);
      if (next && /^name\.(first|last|full|middle)$/.test(next.type)) Object.assign(r, { type: 'name.prefix' });
    });

    // "If yes, please give details" right after a conflict-of-interest question: that question's details box.
    results.forEach((r, i) => {
      if (!['text', 'textarea'].includes(descs[i].kind)) return;
      const q = norm(questionText(descs[i]));
      if (
        !/^(if (yes|so|applicable|you (answered|selected|chose|said|ticked|checked) yes)|please (give|provide|list) (details|more|their|the))\b/.test(
          q,
        )
      )
        return;
      for (let j = i - 1; j >= Math.max(0, i - 2); j--) {
        const prev = results[j] && DETAILS_OF[results[j].type];
        if (prev) {
          results[i] = { type: prev, part: null, score: 1, source: 'follow-up' };
          return;
        }
      }
    });

    // "Please specify" / "If you have selected other, please tell us where" right after "How did you hear about us?":
    // where you heard, once that list's choice is "Other" (content/main.js checks it); "Which One?" right after it
    // (Eploy's "Job Board" → "Google for Jobs / Indeed / … / Other") is the same question.
    results.forEach((r, i) => {
      const prev = results.slice(Math.max(0, i - 2), i).findIndex((x) => x && x.type === 'job.referralSource');
      if (prev < 0 || (r && r.type)) return;
      const q = norm(questionText(descs[i]));
      const at = Math.max(0, i - 2) + prev;
      // Never the box for one named answer ("If you selected 'A friend or relative', please put their full name").
      const named =
        /\b(name|friend|relative|employee|referr\w*|colleague|event|which (event|university|school))\b/.test(q);
      if (
        ['text', 'textarea'].includes(descs[i].kind) &&
        !named &&
        (SPECIFY.test(q) || /^if (you (have )?(selected|chose|picked|ticked) )?other\b|^other\b/.test(q))
      )
        results[i] = { type: 'job.referralSource', part: 'specify', score: 1, source: 'follow-up', follows: at };
      else if (
        LIST_KINDS.includes(descs[i].kind) &&
        /^(which one|which|please (select|specify)|specify|source)$/.test(q)
      )
        results[i] = { type: 'job.referralSource', part: null, score: 1, source: 'follow-up' };
    });

    // "If you selected a response to the prior question other than "none of the above"…" right after a sanctions
    // question (its options unseen in a closed dropdown): that question's follow-up.
    results.forEach((r, i) => {
      if ((r && r.type) || !(F().KINDS.CHOICE.includes(descs[i].kind) || descs[i].kind === 'checkbox')) return;
      if (!F().isSanctionsFollowUp(norm(questionText(descs[i])))) return;
      if (results.slice(Math.max(0, i - 2), i).some((x) => x && x.type === 'compliance.sanctions'))
        results[i] = { type: 'compliance.sanctions', part: null, score: 1, source: 'follow-up' };
    });

    // An upload that says it is for your CV ("Resume*", "Upload CV") is where it goes: one that names it nowhere, not
    // even in its id ("file-input", "Other", "Additional Files"), never gets it a second time. Dayforce's "Attachment"
    // (id …_files_resume) is still the CV's.
    const namesCv = (d, weight) =>
      signalTexts(d).some((t) => t.weight >= weight && /\b(resumes?|cvs?|curriculum|lebenslauf)\b/.test(t.text));
    if (results.some((r, i) => r && r.type === 'file.resume' && namesCv(descs[i], 0.75)))
      results.forEach((r, i) => {
        if (r && r.type === 'file.resume' && !namesCv(descs[i], 0))
          Object.assign(r, { type: null, dropped: 'file.resume' });
      });

    const state = {
      edu: { index: -1, seen: new Set(), run: new Set() },
      exp: { index: -1, seen: new Set(), run: new Set() },
    };
    let prev = null;
    let detached = null; // the section of a run of one-off questions, all about the first entry
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (!r || !r.type) continue;
      if (r.type === 'custom') {
        prev = null;
        continue;
      }
      // Under "Secondary education" / "A-levels": dates are that school's, places and addresses not yours.
      if (F().eduLevelOf(norm(questionText(descs[i]))) === 'highschool') {
        if (r.type === 'gen.start' || r.type === 'gen.end') {
          Object.assign(r, { type: 'edu' + r.type.slice(3), index: 0 });
          prev = null;
          continue;
        }
        if (r.type.startsWith('gen.') || r.type.startsWith('address.') || r.type === 'location') {
          r.dropped = r.type;
          r.type = null;
          continue;
        }
      }
      // "Summary" between a job's dates and title describes that job (Breezy's work history).
      if (prev && r.type === 'summary' && /^(summary|description)$/.test(norm(questionText(descs[i])))) {
        if (prev === 'exp') r.type = 'exp.description';
        else {
          r.dropped = r.type;
          r.type = null;
          continue;
        }
      }
      if (r.type.startsWith('gen.')) {
        const lead = leadsInto(results, descs, i, prev, state);
        const into = lead || prev;
        let target = into && (r.type !== 'gen.description' || into === 'exp') ? into + r.type.slice(3) : null;
        // "Start Date" right after an entry's graduation date ("Year of Graduation, Degree Classification, Start Date"
        // on Teamtailor) is not that entry's start: entries give their start first.
        const run = into && !lead ? [...state[into].run] : [];
        if (
          r.type === 'gen.start' &&
          run.some((k) => k.startsWith(into + '.end:')) &&
          !run.some((k) => k.startsWith(into + '.start:'))
        )
          target = null;
        // "Start month" in no education or job entry, under a heading about the job ("The role", "Availability"):
        // when you could start.
        if (!into && r.type === 'gen.start' && ROLE_SECTION.test(norm((descs[i].signals || {}).section))) {
          r.type = 'job.startDate';
          prev = null;
          detached = null;
          continue;
        }
        if (!target) {
          r.dropped = r.type;
          r.type = null;
          continue;
        }
        r.type = target;
      } else if (prev && ABOUT_YOU_TYPES.includes(r.type) && ABOUT_YOU.test(norm(questionText(descs[i])))) {
        // "Which country do you live in?" right after the education section is still about you.
        prev = null;
        detached = null;
        continue;
      } else if (prev && (r.type === 'location' || r.type === 'address.city')) {
        r.type = prev + '.location';
      } else if (prev && r.type === 'address.country') {
        // "Country" in an education or job entry: the school's or employer's, from that entry's location.
        r.type = prev + '.country';
      } else if (prev && ['address.state', 'address.postalCode'].includes(r.type)) {
        // The school's or employer's state, not yours.
        r.dropped = r.type;
        r.type = null;
        continue;
      }
      const g = groupOf(r.type);
      // "Name of secondary school" or "Undergraduate GPA" is answered from the entry at that level, wherever it is.
      if (!g || (g === 'edu' && F().eduLevelOf(norm(questionText(descs[i]))))) {
        if (g) r.index = 0;
        prev = null;
        detached = null;
        continue;
      }
      const st = state[g];
      const key = r.type + ':' + (r.part || '');
      // "When is your expected year of graduation? [2023 … 2032]" then a box asking the same thing: the box is for an
      // answer the list didn't have, never the next entry.
      const before = results[i - 1];
      if (
        st.seen.has(key) &&
        before &&
        before.type === r.type &&
        LIST_KINDS.includes(descs[i - 1].kind) &&
        ['text', 'textarea'].includes(descs[i].kind)
      ) {
        r.dropped = r.type;
        r.type = null;
        continue;
      }
      if (prev !== g) {
        detached = null;
        st.run = new Set(); // what this stretch of the section has had
      }
      st.run.add(key);
      // Back after other questions with something this section already had: a new entry only when
      // it starts the way the first one did and goes on for more than one field.
      // "Please re-confirm the university you currently attend" among the screening questions is about the same
      // entry; a second "School" box starts the next one.
      const sameLabel =
        norm(questionText(descs[i])) === st.leadLabel || norm(questionText(descs[i])).split(' ').length <= 3;
      // So is a question of its own after the entries, even one the last entry hasn't had: "What year will you / did
      // you graduate from your most recent study?" among Phenom's screening questions is your degree's, not the school
      // entry's above them.
      const ownQuestion = st.index >= 0 && key !== st.lead && norm(questionText(descs[i])).split(' ').length >= 6;
      if (
        !detached &&
        prev !== g &&
        ((st.seen.has(key) && (key !== st.lead || runLength(results, i, g) < 2 || !sameLabel)) || ownQuestion)
      )
        detached = g;
      if (detached === g) {
        r.index = 0;
        prev = g;
        continue;
      }
      if (st.index < 0 || st.seen.has(key)) {
        st.index++;
        st.seen = new Set();
        st.run = new Set([key]);
        if (st.index === 0) {
          st.lead = key;
          st.leadLabel = norm(questionText(descs[i]));
        }
      }
      st.seen.add(key);
      r.index = st.index;
      prev = g;
    }

    // A country-code box speaks for the number box beside it (Workday's "Country Phone Code" then "Phone Number",
    // react-phone-number-input's country menu then its number box): that one takes the number without its code. A
    // phone box elsewhere on the page takes the whole number (a "+{44} 0000 000000" mask makes "07386…" a wrong one).
    const codeBoxes = results.map((r, i) => (r && r.type === 'phone.countryCode' ? i : -1)).filter((i) => i >= 0);
    if (codeBoxes.length)
      results.forEach((r, i) => {
        if (r && r.type === 'phone') r.part = codeBoxes.some((c) => Math.abs(c - i) <= 2) ? 'national' : 'whole';
      });

    const types = results.filter((r) => r && r.type).map((r) => r.type);
    const passwordFields = descs.filter((d) => d.kind === 'password').length;
    // "Are you legally authorized to work in the United States?" then "Will you require sponsorship for employment
    // visa status?": a work question that names no country is about the one the form's other work questions name.
    const asked = new Set();
    results.forEach((r, i) => {
      if (r && /^job\.(authorized|sponsorship|visa)$/.test(r.type))
        F()
          .countriesAsked(norm(questionText(descs[i])), descs[i].options)
          .codes.forEach((c) => asked.add(c));
    });
    let formCountries = [...asked];
    const members = formCountries.filter((c) => c !== 'EU');
    if (members.length && members.every((c) => JTF.geo.workRights([c]).has('EU'))) formCountries = members;
    const context = {
      formCountries: formCountries.length === 1 ? formCountries : [],
      jobContext: types.some((t) => F().JOB_TYPES.test(t)),
      hasCountryCodeField: types.includes('phone.countryCode'),
      passwordFields,
      signup:
        passwordFields >= 2 ||
        types.includes('account.passwordConfirm') ||
        descs.some((d) => /\bnew-password\b/.test(d.autocomplete || '')),
    };
    return { results, context };
  }

  /* ---------------------------------------------------------- option matching */

  // "No Selection" is SuccessFactors' empty choice (never the answer "No").
  function isPlaceholder(n) {
    return (
      !n ||
      /^(select|choose|please (select|choose|specify)|pick (one|an option)|none selected|no selection|nothing selected|click to select)\b/.test(
        n,
      )
    );
  }

  const DECLINE =
    /\bdecline|prefer not|\bnot (specified|disclosed|stated|declared)\b|not (wish|want) to|(don t|do not|does not) wish|(don t|do not) want to|rather not|not to (say|answer|disclose|self identify|specify|provide|state|respond)|choose not|not disclose|undisclosed|wish not to/;

  /** Map an answer or option to yes / no / decline / male / female / nonbinary, if it is one. */
  function canonicalOf(text) {
    const t = norm(text);
    if (!t || t.length > 160) return null;
    if (/^(yes|y|true|yep|yeah)\b/.test(t)) return 'yes';
    if (/^(no|n|false|nope)\b/.test(t)) return 'no';
    if (DECLINE.test(t)) return 'decline';
    if (/\bnon ?binary\b|genderqueer|gender ?(non|queer|fluid|nonconforming)|\bnon conforming\b/.test(t))
      return 'nonbinary';
    if (/^(f|female|woman|women)$|\bfemale\b|\bwoman\b/.test(t)) return 'female';
    if (/^(m|male|man|men)$|\bmale\b|^man\b|\bcis ?man\b/.test(t)) return 'male';
    if (
      /\bnot\b|\bdo not\b|\bdon t\b|\bdoes not\b|\bnone\b|\bnever\b|\bhaven t\b|\bwon t\b|\bcannot\b|\bcan t\b/.test(t)
    )
      return 'no';
    if (/\bi am\b|\bi have\b|\bi identify\b|\bi do\b|\bi will\b|\bi can\b|\bi m\b|\bi agree\b/.test(t)) return 'yes';
    // Acknowledgement answers: "I confirm", "Acknowledged", "I accept".
    // "Acknowledge/Confirm", "Acknowledge & agree", "Understood".
    if (
      /^i (confirm|acknowledge|accept|consent|understand|certify)\b|^(confirm(ed)?|acknowledged?|accept(ed)?|agreed?|understood|consent)( (and )?(confirm(ed)?|acknowledged?|accept(ed)?|agreed?|understood|consent))*$/.test(
        t,
      )
    )
      return 'yes';
    return null;
  }

  // An integrated master's (MEng, MSci, MPhys…) is a first degree as well as a master's.
  const INTEGRATED_MASTERS = /\bintegrated master|\bm ?(eng|sci|phys|math|maths|chem|comp|bio|biol|pharm|geol)\b/;
  const isIntegratedMasters = (n) => INTEGRATED_MASTERS.test(n);

  const DEGREE_GROUPS = [
    ['doctorate', /\bdoctor|\bph ?d\b|\bd ?phil\b|\bjd\b|\bmd\b|\bed ?d\b/],
    [
      'master',
      /\bmaster|\bm ?sc?\b|\bm ?a\b|\bm ?eng\b|\bmba\b|\bm ?tech\b|\bm ?phil\b|\bllm\b|\bmfa\b|post ?graduate|graduate degree/,
    ],
    [
      'bachelor',
      /\bbachelor|\bb ?sc?\b|\bb ?a\b|\bb ?eng\b|\bb ?tech\b|\bbba\b|\bb ?com\b|\bllb\b|\bbfa\b|undergraduate|\bab\b/,
    ],
    ['associate', /\bassociate|\baas\b/],
    // "Advanced Highers", "IB Diploma", "BTEC", "Leaving Certificate", "Abitur": school-leaving qualifications.
    [
      'highschool',
      /high school|(?<!\bpost )secondary|\bged\b|\ba ?levels?\b|\bas levels?\b|\b(i ?)?gcses?\b|\b(advanced )?highers\b|\bib( diploma)?\b|\b(international|european) baccalaureate\b|\bbaccalaureat\b|\bbtecs?\b|\bleaving cert\w*|\babitur\b|\bmatura\b|\bpre ?u\b/,
    ],
  ];

  // School-leaving qualifications that are not one another: Advanced Highers are never "Baccalaureat" (the French
  // one) nor A-levels "GED"; a plain "High School Graduate" or "Secondary School" fits any of them.
  const SCHOOL_QUALIFICATIONS = [
    ['alevel', /\ba ?levels?\b|\bas levels?\b|\bpre ?u\b/],
    ['highers', /\b(advanced )?highers\b/],
    ['ib', /\bib( diploma)?\b|\binternational baccalaureate\b/],
    ['eb', /\beuropean baccalaureate\b/],
    ['bac', /\bbaccalaureat\b|\bbac\b/],
    ['gcse', /\b(i ?)?gcses?\b/],
    ['btec', /\bbtecs?\b/],
    ['leaving', /\bleaving cert\w*/],
    ['abitur', /\babitur\b/],
    ['matura', /\bmatura\b/],
    ['ged', /\bged\b/],
  ];
  const schoolQualifications = (n) => SCHOOL_QUALIFICATIONS.filter(([, re]) => re.test(n)).map(([q]) => q);

  function degreeGroup(n) {
    // A Scottish "MA (Hons)" is a first degree.
    if (/\bm ?a\b/.test(n) && /\bhons\b|\bhonours\b/.test(n) && !/\bmaster/.test(n)) return 'bachelor';
    for (const [name, re] of DEGREE_GROUPS) if (re.test(n)) return name;
    return null;
  }

  function jaccard(a, b) {
    if (!a.length || !b.length) return 0;
    const sa = new Set(a);
    const sb = new Set(b);
    let inter = 0;
    for (const t of sa) if (sb.has(t)) inter++;
    return inter / (sa.size + sb.size - inter);
  }

  // "m b a" -> "mba", "ph d" -> "phd": acronyms survive punctuation stripping.
  const squash = (s) => s.replace(/\b([a-z]) (?=[a-z]\b)/g, '$1');

  function textScore(o, raw) {
    let best = 0;
    const c = squash(raw);
    for (const field of [o.n, o.nv]) {
      if (!field) continue;
      const s = squash(field);
      let sc;
      if (s === c || s.replace(/ /g, '') === c.replace(/ /g, '')) sc = 100;
      else if (s.startsWith(c + ' ') || c.startsWith(s + ' ')) sc = 80;
      else if ((' ' + s + ' ').includes(' ' + c + ' ')) sc = 70;
      else if (s.length >= 3 && (' ' + c + ' ').includes(' ' + s + ' ')) sc = 60;
      else sc = jaccard(U.tokens(s), U.tokens(c)) * 60;
      if (field === o.nv && field !== o.n) sc *= 0.9; // prefer the visible text
      if (sc > best) best = sc;
    }
    return best;
  }

  function bestText(opts, cands, v) {
    const wantDegree = v.kind === 'degree' ? degreeGroup(cands[0] || '') : null;
    const mine = wantDegree === 'highschool' ? schoolQualifications(cands[0] || '') : [];
    const primary = U.tokens(cands[0] || '');
    const near = (v.near || []).map(norm).filter(Boolean);
    let best = null;
    for (const o of opts) {
      let score = 0;
      for (const c of cands) score = Math.max(score, textScore(o, c));
      const theirs = mine.length ? schoolQualifications(o.n) : [];
      const otherQualification = theirs.length && !theirs.some((q) => mine.includes(q));
      if (wantDegree && degreeGroup(o.n) === wantDegree && !otherQualification)
        score = Math.max(score, 75 + score * 0.2);
      // "Integrated Masters Degree" for an MEng, "Masters Degree" for an MSc.
      if (wantDegree === 'master' && /\bintegrated\b/.test(o.n) !== isIntegratedMasters(cands[0] || '')) score -= 10;
      // Break ties toward the option that shares the most words with the main spelling.
      if (score > 0) score += jaccard(U.tokens(o.n), primary) * 5;
      // "San Francisco, California" rather than "San Francisco, Cebu": the option names your state or country.
      if (score > 0 && near.some((n) => (' ' + o.n + ' ').includes(' ' + n + ' '))) score += 8;
      if (!best || score > best.score) best = { i: o.i, score };
    }
    return best;
  }

  function parseRange(raw) {
    const t = String(raw)
      .toLowerCase()
      .replace(/[,$€£]/g, '')
      .replace(/(\d+(?:\.\d+)?)\s*k\b/g, (m, x) => String(parseFloat(x) * 1000));
    let m = t.match(/(\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?)/);
    if (m) return [+m[1], +m[2]];
    m =
      t.match(/(\d+(?:\.\d+)?)\s*(?:\+|or more|and (?:above|over|up)|plus)/) ||
      t.match(/(?:more than|over|above|at least|greater than)\s*(\d+(?:\.\d+)?)/);
    if (m) return [+m[1], Infinity];
    m = t.match(/(?:>=|≥|=>)\s*(\d+(?:\.\d+)?)/);
    if (m) return [+m[1], Infinity];
    m = t.match(/>\s*(\d+(?:\.\d+)?)/);
    if (m) return [+m[1] + 1e-9, Infinity];
    m = t.match(/(?:<=|≤|=<)\s*(\d+(?:\.\d+)?)/);
    if (m) return [0, +m[1]];
    m = t.match(/(?:less than|under|below|fewer than|<)\s*(\d+(?:\.\d+)?)/);
    if (m) return [0, +m[1] - 1e-9];
    m = t.match(/^\s*(\d+(?:\.\d+)?)\s*(?:years?|yrs?)?\s*$/);
    if (m) return [+m[1], +m[1]];
    return null;
  }

  function bestRange(opts, n) {
    let best = null;
    for (const o of opts) {
      const r = parseRange(o.text);
      if (!r || n < r[0] || n > r[1]) continue;
      const width = r[1] - r[0];
      if (!best || width < best.width) best = { i: o.i, width };
    }
    return best ? best.i : -1;
  }

  /**
   * A dialling code from a list: "UNITED KINGDOM (+44)", "+44 United Kingdom", "GB +44", "44", or a country list
   * whose values are codes. Many countries share a code (+1: the US, Canada, Jamaica…; +44: the UK, Jersey, the
   * Isle of Man), so the option must also be the country the code is for (v.iso2): "UNITED STATES (+1)", never
   * "CANADA (+1)" or "VIRGIN ISLANDS, U.S. (+1)".
   */
  function bestPhoneCode(opts, v) {
    const re = new RegExp('(^|[^\\d])\\+?\\s?' + v.code + '(?!\\d)');
    const countries = (v.countries || []).map(norm).filter(Boolean);
    let best = null;
    for (const o of opts) {
      let s = 0;
      if (re.test(o.text) || re.test(o.value)) s += 60;
      const row = countryOfOption(o.text) || (/^[A-Za-z]{2,3}$/.test(o.value) ? countryOfOption(o.value) : null);
      if (row && v.iso2) {
        if (row[0] === v.iso2) s += 45;
      } else {
        const hay = ' ' + o.n + ' ' + o.nv + ' ';
        if (countries.some((c) => hay.includes(' ' + c + ' '))) s += 40;
      }
      if (!best || s > best.s) best = { i: o.i, s };
    }
    return best && best.s >= 40 ? best.i : -1;
  }

  /* ------------------------------------------------------- dates against terms */

  // Months of the year each academic term covers. December graduations count as "Fall".
  const TERMS = { winter: [1, 2], spring: [3, 5], summer: [6, 8], fall: [9, 12], autumn: [9, 12] };
  const PERIODS = { early: [1, 4], mid: [5, 8], late: [9, 12] };
  const MONTH_NUMBER = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12,
  };
  const MONTH_TOKEN = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*$/;

  /**
   * The months an option stands for, as [first, last] counted in months from year 0:
   * "Spring/Summer 2027" -> March–August 2027, "Q4 2026", "May 2027", "2027", "Class of 2027",
   * "2026-27", "2029 or later". The day it starts on, when it names one ("Start 30th June, finish 17th
   * September 2027"), is the span's `day`. Null when the option isn't a date.
   */
  function optionSpan(text) {
    const raw = String(text || '')
      // "2026-27" is an academic year; "2027-05" is a month.
      .replace(/\b((?:19|20)\d{2})\s*[-–/]\s*(\d{2})\b(?![/.-]?\d)/g, (m, y, yy) =>
        +yy === (+y + 1) % 100 ? `sep ${y} to aug 20${yy}` : m,
      )
      .replace(/['’](\d{2})\b/g, ' 20$1');
    const t = norm(raw);
    if (!t || t.length > 60) return null;
    const words = t.split(' ');
    const isMonth = (k) => MONTH_TOKEN.test(words[k] || '');
    // "1st", "30th", or a number next to a month ("28 June", "June 28"): a day of the month.
    const isDay = (k) =>
      /^(0?[1-9]|[12]\d|3[01])(st|nd|rd|th)?$/.test(words[k]) &&
      (/\D$/.test(words[k]) || isMonth(k - 1) || isMonth(k + 1));
    if (words.some((w, k) => /^\d+$/.test(w) && w.length !== 4 && !(+w >= 1 && +w <= 12) && !isDay(k))) return null;
    const units = [];
    let year = null;
    let token = 0; // which written year a unit takes: "Spring 2027 (January 11th - April 30th, 2027)" has two
    let numericMonth = null;
    let day = null;
    for (const [k, w] of words.entries()) {
      let range = null;
      if (/^(19|20)\d{2}$/.test(w)) {
        const y = +w;
        token++;
        const open = units.filter((u) => u.year == null);
        open.forEach((u) => Object.assign(u, { year: y, token }));
        if (numericMonth && !open.length) units.push({ from: numericMonth, to: numericMonth, year: y, token });
        if (!open.length && !numericMonth) units.push({ from: 1, to: 12, year: y, token, wholeYear: true });
        year = y;
        numericMonth = null;
        continue;
      }
      if (isDay(k)) {
        // "June 1st" (the month before it) or "1st June" (the month after it).
        const last = units[units.length - 1];
        if (isMonth(k - 1) && last && last.month && last.day == null) last.day = parseInt(w, 10);
        else if (isMonth(k + 1)) day = parseInt(w, 10);
        continue;
      }
      if (/^\d{1,2}$/.test(w)) {
        if (year != null && units.length && units[units.length - 1].wholeYear) {
          const u = units[units.length - 1];
          Object.assign(u, { from: +w, to: +w, wholeYear: false });
        } else numericMonth = +w;
        continue;
      }
      if (w === 'winter') {
        units.push({ from: 1, to: 2, year: null, winter: true, term: true });
        continue;
      }
      if (MONTH_TOKEN.test(w)) {
        const m = MONTH_NUMBER[w.slice(0, 3)];
        units.push({ from: m, to: m, year: null, month: true, day });
        day = null;
        continue;
      }
      if (TERMS[w]) range = TERMS[w];
      else if (PERIODS[w]) range = PERIODS[w];
      else if (/^q[1-4]$/.test(w)) range = [+w[1] * 3 - 2, +w[1] * 3];
      else if (/^h[12]$/.test(w)) range = w === 'h1' ? [1, 6] : [7, 12];
      if (range) units.push({ from: range[0], to: range[1], year: null, term: !!TERMS[w] });
    }
    if (/\b(first|1st) half\b/.test(t)) units.push({ from: 1, to: 6, year: null });
    if (/\b(second|2nd) half\b/.test(t)) units.push({ from: 7, to: 12, year: null });
    if (!units.length || year == null) return null;
    // "Winter 2026/ Spring 2027": a winter graduation before the next spring is December's.
    units.forEach((u, k) => {
      const next = units[k + 1];
      if (u.winter && next && u.year != null && next.year === u.year + 1) Object.assign(u, { from: 12, to: 14 });
    });
    let start = Infinity;
    let end = -Infinity;
    let startDay = null;
    let prev = null;
    for (const u of units) {
      const y = u.year != null ? u.year : year;
      let from = u.from;
      let to = u.to;
      // "Fall/Winter 2026": the winter after that fall. Never past a year written for it ("Spring 2027 (January 11th -
      // April 30th, 2027)"), nor when months spell out the season before them ("Spring (January - April) 2027").
      const rolls = prev && prev.token === u.token && from < prev.from && !prev.wholeYear && !(prev.term && u.month);
      if (rolls && u.year != null) {
        from += 12;
        to += 12;
      }
      const first = y * 12 + from - 1;
      if (first < start || (first === start && startDay == null)) startDay = u.day || null;
      start = Math.min(start, first);
      end = Math.max(end, y * 12 + to - 1);
      prev = u;
    }
    const first = start;
    if (/\b(or|and) (later|after|beyond|above)\b|\bonwards?\b|\bbeyond\b|\+/.test(t + (/\+/.test(raw) ? ' +' : '')))
      end = Infinity;
    else if (/\bafter\b/.test(t)) [start, end] = [end + 1, Infinity];
    if (/\b(or|and) (earlier|before|prior)\b|\bearlier\b/.test(t)) start = -Infinity;
    else if (/\b(before|prior to)\b/.test(t)) [start, end] = [-Infinity, start - 1];
    const span = [start, end];
    if (startDay && start === first) span.day = startDay;
    return span;
  }

  const DOES_NOT_NEED =
    /\b(not|never|no longer|won t|don t|doesn t|dont|wont|without) (\w+ )?(require|need|requiring|needing)\b|\bwithout (\w+ )?sponsor|\bno (\w+ )?sponsor\w* (is |will be )?(required|needed)|\bsponsor\w* (is |will be )?not (required|needed)/;
  const NOT_AUTHORIZED =
    /\b(not|no longer|un) ?(currently |yet |legally )*(authori[sz]ed|eligible|permitted|entitled|allowed)\b|\bno (current )?(work|employment) authori[sz]ation\b|\b(do not|don t) (currently )?have (the |a )?(\w+ )?(right|authori[sz]ation|permission) to work\b/;
  const GRADUATED =
    /\b(not|no longer) (currently )?(enrolled|a (current )?student|in (school|education|university|college)|studying)\b|\b(already )?graduated\b|\balumn/;

  /**
   * The option whose term or period best covers date value `v`, or -1. Null when no option is a date. For the
   * earliest date you can start (`v.earliest`), an option that starts before it can't be made, to the day when both
   * name one ("Start 1st June" for 28 June): the first one you can make is picked ("Start 30th June").
   */
  function bestDate(opts, v) {
    const d = v.date;
    const month = d.month || v.typicalMonth;
    const target = month ? [d.year * 12 + month - 1, d.year * 12 + month - 1] : [d.year * 12, d.year * 12 + 11];
    let best = null;
    let dated = 0;
    for (const o of opts) {
      const span = optionSpan(o.text);
      if (!span) continue;
      dated++;
      const tooEarly = span[1] < target[0] || (span[0] === target[0] && span.day && d.day && span.day < d.day);
      if (v.earliest && d.month && tooEarly) continue;
      const width = Math.min(span[1] - span[0] + 1, 240);
      const overlap = Math.min(target[1], span[1]) - Math.max(target[0], span[0]) + 1;
      let score;
      if (overlap > 0) score = 100 + (50 * overlap) / (target[1] - target[0] + 1) - width / 4;
      else {
        const gap = span[0] > target[1] ? span[0] - target[1] : target[0] - span[1];
        if (gap > 2) continue;
        score = 50 - 15 * gap - width / 10;
      }
      // Of two that start the same month, the earlier day.
      if (v.earliest && span.day) score -= span.day / 1000;
      if (!best || score > best.score) best = { i: o.i, score };
    }
    if (!dated) return null;
    return best ? best.i : -1;
  }

  /**
   * The best option for ethnicity answer `want` (fields.parseEthnicity): its exact subgroup anywhere in the list
   * ("Chinese - Chinese" beats "Asian or Asian British - Other Asian background"), then its Asian region ("East
   * Asian"), then its group ("Asian or Asian British", US "Asian"), then "Any other <group> background". A broad
   * answer ("Asian") only takes a group option. -1 when nothing fits.
   */
  function bestEthnicity(opts, options, want) {
    let best = null;
    for (const o of opts) {
      // An <optgroup> names the group of a bare "Other" or "Chinese".
      const group = options[o.i] && options[o.i].group;
      const e = F().parseEthnicity(group && !/[:–—]|\s-\s/.test(o.text) ? `${group}: ${o.text}` : o.text);
      const score = e ? ethnicityScore(e, want, o.n) : 0;
      if (score > 0 && (!best || score > best.score)) best = { i: o.i, score };
    }
    return best ? best.i : -1;
  }

  function ethnicityScore(o, w, n) {
    if (w.group === 'other') return o.group === 'other' && !o.sub && !o.region ? 100 : 0;
    if (!o.groups.includes(w.group)) return 0;
    if (o.sub === 'whiteblack') return /^whiteblack/.test(w.sub || '') ? 85 : 0; // Maven's "White and Black "
    if (o.sub) {
      if (o.sub !== w.sub) return 0;
      // "Asian or Asian British – Chinese", then "Asian - Chinese", then "Chinese"; "British" before "English".
      const full = /\b(asian|black) british\b/.test(n) ? 1 : 0;
      return 100 + full + (o.named ? 0.5 : 0) + (w.sub === 'british' && /\b(british|united kingdom)\b/.test(n) ? 2 : 0);
    }
    if (o.region) {
      if (o.region !== w.region) return 0;
      if (o.other) return w.other && !w.sub ? 100 : 50;
      return w.other ? 70 : 80;
    }
    const broad = !w.sub && !w.region && !w.other;
    if (o.other) return w.other ? (w.region ? 70 : 100) : broad ? 0 : 40;
    return (broad ? 100 : 60) - (/\bpacific islander\b/.test(n) ? 5 : 0);
  }

  /**
   * The option naming your degree class ("Upper Second Class Honours (2:1)", "2(i)", "60-69% - Second class honours:
   * Grade 1"), predicted or achieved as yours is when the list has both. -1 when the list doesn't name your class,
   * whatever else it offers (GPA bands, "Other").
   */
  function bestClass(opts, v, cands) {
    const same = opts.filter((o) => F().degreeClassOf(o.text) === v.cls);
    if (!same.length) return -1;
    const expected = (o) => /\b(predicted|expected|anticipated|projected|forecast|on track)\b/.test(o.n);
    const achieved = (o) => /\b(achieved|awarded|obtained|actual|final|graduated)\b/.test(o.n);
    const kept = same.filter((o) => (v.expected ? !achieved(o) : !expected(o)));
    return bestText(kept.length ? kept : same, cands, v).i;
  }

  // Words most institution names share: they tell no two apart.
  const SCHOOL_WORDS = new Set(['the', 'of', 'and', 'at', 'in', 'for', 'university', 'univ', 'uni']);
  const INSTITUTION = /\b(universit|college|institut|school|academy|polytechnic|conservatoire)/i;

  /** What tells an institution apart: "University of Glasgow", "Glasgow, University of" and "Glasgow University" -> "glasgow". */
  function schoolKey(text) {
    const words = norm(text)
      .replace(/\b([a-z]+) s\b/g, '$1s') // "King's College" is "Kings College"
      .replace(/\bsaint\b/g, 'st')
      .split(' ')
      .filter((w) => w && !SCHOOL_WORDS.has(w));
    return [...new Set(words)].sort().join(' ');
  }

  const wordPrefix = (a, b) => (' ' + b + ' ').startsWith(' ' + a + ' ');

  // Short names of one institution ("UCL" is University College London, "UofG" the University of Glasgow). A short name
  // two of them share ("GU") is taken from a list for the school you wrote, never from your profile.
  // prettier-ignore
  const SCHOOL_ALIASES = [
    ['University College London', 'UCL'],
    ['London School of Economics and Political Science', 'London School of Economics', 'LSE'],
    ["King's College London", 'KCL'],
    ['Imperial College London', 'Imperial College', 'Imperial', 'ICL'],
    ['London Business School', 'LBS'],
    ['University of Oxford', 'Oxford University', 'Oxford'],
    ['University of Cambridge', 'Cambridge University', 'Cambridge'],
    ['University of Glasgow', 'Glasgow University', 'UofG', 'GU'],
    ['Georgetown University', 'GU'],
    ['University of California, Berkeley', 'UC Berkeley', 'Berkeley'],
    ['University of California, Los Angeles', 'UCLA'],
    ['Massachusetts Institute of Technology', 'MIT'],
    ['New York University', 'NYU'],
    ['Carnegie Mellon University', 'CMU'],
    ['California Institute of Technology', 'Caltech'],
  ];
  let aliasKeys = null;

  /** The keys (schoolKey) a school also goes by: its row of SCHOOL_ALIASES when only one row has it. */
  function schoolAliases(key) {
    if (!aliasKeys) aliasKeys = SCHOOL_ALIASES.map((row) => row.map(schoolKey));
    const rows = aliasKeys.filter((row) => row.includes(key));
    return new Set(rows.length === 1 ? rows[0] : [key]);
  }

  /**
   * A school from a list of schools. Names that differ only in the words every name shares ("The University of
   * Glasgow", "Glasgow, University of", "University of Glasgow (UofG)", "Glasgow University") are the same school. A
   * name with more telling words, or fewer, is another one ("Glasgow Caledonian University", "Glasgow School of Art";
   * "University of London" for Queen Mary), unless it only adds to the end ("Imperial College" for "Imperial College
   * London"). A bracket that names an institution is another name for it ("UWE Bristol (University of the West of
   * England)"); one holding a place or initials is not ("University of Strathclyde (Glasgow)"), except the initials
   * you wrote ("UCL"), and short names it is known by ("LSE", "UC Berkeley", "UofG": SCHOOL_ALIASES). Returns an
   * index, -1, or null when your school has no telling words (generic matching).
   */
  function bestSchool(opts, v, cands) {
    const mine = norm(v.text.replace(/\([^)]*\)/g, ' '));
    const want = schoolKey(mine);
    if (!want) return null;
    const wanted = want.split(' ');
    const aliases = schoolAliases(want);
    const initials = /^[A-Z][A-Za-z&]*[A-Z][A-Za-z]*$/.test(v.text.trim()) ? norm(v.text) : null;
    const same = [];
    const open = [];
    for (const o of opts) {
      const main = norm(o.text.replace(/\([^)]*\)/g, ' '));
      const keys = [schoolKey(main)];
      for (const m of o.text.matchAll(/\(([^)]+)\)/g)) {
        if (INSTITUTION.test(m[1])) keys.push(schoolKey(m[1]));
        else if (initials && norm(m[1]) === initials) keys.push(want);
      }
      if (keys.some((k) => aliases.has(k))) {
        same.push(o);
        continue;
      }
      const words = keys[0].split(' ').filter(Boolean);
      if (!words.length) continue; // "University", "Other": no school in particular
      const shared = words.filter((w) => wanted.includes(w)).length;
      const nested = shared && (shared === words.length || shared === wanted.length);
      // A school with known short names is only ever one of them: "Oxford" is never Oxford Brookes.
      if (nested && (aliases.size > 1 || (!wordPrefix(main, mine) && !wordPrefix(mine, main)))) continue;
      open.push(Object.assign({}, o, { n: main, nv: '' }));
    }
    if (same.length) return bestText(same, cands, v).i;
    const best = open.length ? bestText(open, cands, v) : null;
    return best && best.score >= 45 ? best.i : -1;
  }

  // One-word catch-alls in subject lists ("Science", "Engineering", "Other"): only when nothing more telling fits.
  const GENERIC_SUBJECT =
    /^(science|sciences|engineering|arts|humanities|studies|general studies|other|others|discipline unknown)$/;

  /**
   * A degree subject from a list (its other names were tried exactly already): an option holding it ("Mathematics &
   * Statistics" for Mathematics), a category listing it or, for a STEM subject, a STEM category ("STEM (Science,
   * Technology/Computer Science, Engineering, Mathematics)"); a catch-all such as "Science" only when nothing more
   * telling fits, so "Computing Science" is never "Science" next to "Computer Science". -1 when nothing fits.
   */
  function bestSubject(opts, v, cands) {
    const primary = U.tokens(cands[0] || '');
    const spellings = cands.map((c) => U.tokens(c)).filter((t) => t.length >= 2);
    let best = null;
    let generic = null;
    for (const o of opts) {
      let score = 0;
      for (const c of cands) score = Math.max(score, textScore(o, c));
      // Every word of a spelling, with others between: "Computer and Information Science" for Computer Science
      // (Workday's list has no "Computer Science"), never the catch-all "Science" beside it.
      const words = new Set(U.tokens(o.n));
      if (spellings.some((t) => t.every((w) => words.has(w)))) score = Math.max(score, 55);
      for (const m of o.text.matchAll(/\(([^)]+)\)/g))
        if (m[1].split(/\s*[,;/&]\s*|\s+and\s+/).some((part) => cands.includes(norm(part))))
          score = Math.max(score, 75);
      if (v.stem && /^stem\b/.test(o.n)) score = Math.max(score, 65);
      if (score < 45) continue;
      score += jaccard(U.tokens(o.n), primary) * 5;
      const pick = { i: o.i, score };
      if (GENERIC_SUBJECT.test(o.n)) {
        if (!generic || score > generic.score) generic = pick;
      } else if (!best || score > best.score) best = pick;
    }
    return (best || generic || { i: -1 }).i;
  }

  // Words that turn the next few around: "have not spent", "never lived".
  const NEGATOR = /^(not|never|no|without|neither|nor)$/;

  /**
   * The statement among several that agrees with a requirement: "you must have lived in the UK for the last 5 years
   * and not have spent more than 6 months… outside of the UK" is "I have lived in the UK for the last 5 years and have
   * not spent more than 6 months…", never "…but have spent…" or "I have not lived…". Each word both say counts for
   * when it is said the same way (negated or not) and against when it isn't. -1 unless one statement agrees best.
   */
  function agreeing(opts, requirement) {
    if (opts.length < 3 || !opts.every((o) => o.n.split(' ').length >= 8)) return -1;
    const polarity = (text) => {
      const words = norm(text).split(' ');
      const out = new Map();
      words.forEach((w, k) => {
        if (w.length < 4 || NEGATOR.test(w)) return;
        const negated = words.slice(Math.max(0, k - 3), k).some((x) => NEGATOR.test(x));
        if (!out.has(w)) out.set(w, negated);
      });
      return out;
    };
    const want = polarity(requirement);
    const scored = opts
      .map((o) => {
        let s = 0;
        for (const [w, negated] of polarity(o.text)) if (want.has(w)) s += want.get(w) === negated ? 1 : -1;
        return { i: o.i, s };
      })
      .sort((a, b) => b.s - a.s);
    return scored[0].s > scored[1].s ? scored[0].i : -1;
  }

  /** Every option a list value ("London, New York") picks, in the list's order. */
  /** Which country an option spells: "United Kingdom (GB)", "UK - United Kingdom", "United Kingdom +44", "GB". */
  function countryOfOption(text) {
    const geo = JTF.geo;
    const t = String(text || '').trim();
    if (!t || !geo) return null;
    const tries = [t, t.replace(/\([^)]*\)/g, ' '), t.replace(/\+\s*\d[\d\s-]*/g, ' ')];
    for (const m of t.matchAll(/\(([^)]+)\)/g)) tries.push(m[1]);
    tries.push(t.replace(/\([^)]*\)/g, ' ').replace(/\+\s*\d[\d\s-]*/g, ' '));
    tries.push(...t.split(/\s+[-–—|:/]\s+|\s*[|/]\s*/));
    const lead = t.match(/^([A-Za-z]{2,3})\s*[-–—:(]/);
    if (lead) tries.push(lead[1]);
    for (const x of tries) {
      const row = geo.findCountry(x.replace(/\s+/g, ' ').trim());
      if (row) return row;
    }
    return null;
  }

  /**
   * A country from a list of countries: the option that spells the same country (any alias or code), never a
   * different one. Returns an index, -1 (nothing safe) or null (not a country list: use generic matching).
   */
  function bestCountry(opts, v, cands) {
    const known = opts.map((o) => ({ o, row: countryOfOption(o.text) || countryOfOption(o.value) }));
    if (!known.some((k) => k.row)) return null;
    const same = known.filter((k) => k.row && k.row[0] === v.iso2);
    if (same.length) {
      // The plain spelling over decorated ones: "United Kingdom" before "United Kingdom of Great Britain (GB)".
      same.sort((a, b) => a.o.n.length - b.o.n.length);
      for (const want of [norm(v.text), norm(v.search), norm(JTF.geo.COUNTRIES.find((r) => r[0] === v.iso2)[2])]) {
        const hit = same.find((k) => k.o.n === want);
        if (hit) return hit.o.i;
      }
      const exact = same.find((k) => cands.includes(k.o.n));
      return (exact || same[0]).o.i;
    }
    const open = known.filter((k) => !k.row).map((k) => k.o);
    if (!open.length) return -1;
    const best = bestText(open, cands, v);
    return best && best.score >= 60 ? best.i : -1;
  }

  function matchAll(options, v) {
    if (!v) return [];
    if (JUDGED.has(v.kind)) return judgedPicks(optionList(options), v, true);
    const items =
      v.items ||
      String(v.text)
        .split(/\s*[,;\n]\s*/)
        .filter(Boolean);
    const picks = [];
    for (const item of items) {
      const idx = matchOption(options, typeof item === 'string' ? F().val(item) : item);
      if (idx >= 0 && !picks.includes(idx)) picks.push(idx);
    }
    return picks;
  }

  /* ------------------------------------------- statements and slots, one by one */

  // Values whose options are each judged against your profile: sanctions statements, interview slots.
  const JUDGED = new Set(['sanctions', 'availability', 'rights']);
  // "None of the above", "None of these apply to me", "Not applicable".
  const NONE_OPTION =
    /^(none|neither|n a|not applicable)\b|\bnone of (the above|these|the following|them)\b|\b(do(es)?|did) not apply\b|\bnot applicable\b/;
  // The follow-up's "Not applicable (i.e., I selected "none of the above" for the prior question)".
  const PRIOR_NONE =
    /\b(selected|chose|ticked|checked|answered|picked) none of the above\b|\bnone of the above (for|in|to|on) the (prior|previous|first|above|preceding) question\b/;

  /**
   * The options a sanctions answer takes: each statement true of you (fields.sanctionsApplies), else "None of the
   * above"; in the follow-up just "Not applicable (I selected none of the above)", when nothing could apply to you.
   * Yes / No options take the question's own answer. Empty when your profile can't tell.
   */
  function sanctionPicks(opts, v) {
    if (v.followUp || opts.some((o) => PRIOR_NONE.test(o.n))) {
      const na = opts.find((o) => PRIOR_NONE.test(o.n)) || opts.find((o) => /^(not applicable|n a)\b/.test(o.n));
      return v.clear && na ? [na.i] : [];
    }
    const judged = opts.map((o) => ({ o, applies: F().sanctionsApplies(o.text, v.facts) }));
    const statements = judged.filter((x) => x.applies !== undefined);
    if (statements.length) {
      if (statements.some((x) => x.applies === null)) return [];
      const yes = statements.filter((x) => x.applies).map((x) => x.o.i);
      if (yes.length) return yes;
      const rest = judged.filter((x) => x.applies === undefined).map((x) => x.o);
      const none = rest.find((o) => NONE_OPTION.test(o.n)) || rest.find((o) => canonicalOf(o.text) === 'no');
      return none ? [none.i] : [];
    }
    if (opts.some((o) => canonicalOf(o.text) === 'yes') && opts.some((o) => canonicalOf(o.text) === 'no')) {
      const hit = v.canonical ? opts.find((o) => canonicalOf(o.text) === v.canonical) : null;
      return hit ? [hit.i] : [];
    }
    // A lone "None of the above" box (its statements are separate boxes): only when nothing could apply.
    const none = opts.find((o) => NONE_OPTION.test(o.n));
    return none && v.clear ? [none.i] : [];
  }

  /**
   * The options interview availability takes: every slot that suits you (fields.slotFits), "Any time" when every
   * slot offered does, "None of these dates work for me" only when none does. One choice takes the earliest.
   */
  function slotPicks(opts, v, all) {
    const texts = opts.map((o) => o.text);
    const slots = F().parseSlots(texts, v);
    const judged = opts.map((o, k) => ({ o, slot: slots[k], fits: F().slotFits(slots[k], v.avail) }));
    const real = judged.filter((x) => x.fits !== undefined);
    const fitting = real.filter((x) => x.fits);
    const any = judged.find((x) => x.slot.any);
    const anyFits = any && real.length && real.every((x) => x.fits) ? any : null;
    const none = real.length && !fitting.length ? judged.find((x) => x.slot.none) : null;
    if (all) {
      const picks = (anyFits ? [...fitting, anyFits] : fitting).map((x) => x.o.i).sort((a, b) => a - b);
      return picks.length ? picks : none ? [none.o.i] : [];
    }
    const start = (x) =>
      Math.min(...x.slot.ranges.map(([from]) => Math.max(from, v.avail.today))) * 1440 +
      (x.slot.time ? x.slot.time[0] : 0);
    const dated = fitting.filter((x) => x.slot.ranges.length).sort((a, b) => start(a) - start(b));
    const pick = dated[0] || anyFits || fitting[0] || none;
    return pick ? [pick.o.i] : [];
  }

  /**
   * The statements of a right-to-work list each about a country ("I have the right to work in the UK (post-Brexit does
   * not apply…)", "…in Germany", "Neither…"): those about countries you have the right to work in, whatever words in
   * brackets say; else the one that says you have none.
   */
  function rightsPicks(opts, v, all) {
    const judged = opts.map((o) => ({
      o,
      codes: JTF.geo.countriesNamed(norm(o.text.replace(/\([^)]*\)/g, ' '))),
      negative: /^(no|not|neither|none)\b|^i (do not|don t|am not|have no|cannot|can t)\b/.test(o.n),
    }));
    const yes = judged.filter((x) => x.codes.length && !x.negative && x.codes.every((c) => v.rights.includes(c)));
    if (yes.length) return (all ? yes : yes.slice(0, 1)).map((x) => x.o.i);
    const none = judged.find((x) => x.negative && !x.codes.length) || judged.find((x) => NONE_OPTION.test(x.o.n));
    return none ? [none.o.i] : [];
  }

  function judgedPicks(opts, v, all) {
    if (!opts.length) return [];
    if (v.kind === 'availability') return slotPicks(opts, v, all);
    if (v.kind === 'rights') return rightsPicks(opts, v, all);
    const picks = sanctionPicks(opts, v);
    return all ? picks : picks.slice(0, 1);
  }

  /** The options worth matching: enabled, not a placeholder, with their normalised text and value. */
  function optionList(options) {
    const opts = [];
    (options || []).forEach((o, i) => {
      if (!o || o.disabled) return;
      const text = String(o.text || '').trim();
      const value = String(o.value == null ? '' : o.value).trim();
      const n = norm(text);
      if (isPlaceholder(n)) return;
      // "<3.7" and "> 3 Months" lose their sign when normalised: never an exact spelling of "3.7".
      opts.push({ i, text, value, n, nv: norm(value), signed: /[<>≤≥]/.test(text) });
    });
    return opts;
  }

  /**
   * Pick the option that best represents value `v`.
   * options: [{ text, value, disabled }]. Returns the index into `options`, or -1.
   */
  function matchOption(options, v) {
    if (!v || !options || !options.length) return -1;
    // A list ("London, New York") answers a single choice with its first item that is offered.
    if (v.kind === 'list') {
      for (const item of v.items) {
        const idx = matchOption(options, F().val(item));
        if (idx >= 0) return idx;
      }
      return -1;
    }
    const opts = optionList(options);
    if (!opts.length) return -1;

    if (v.kind === 'phoneCode') return bestPhoneCode(opts, v);
    // Sanctions statements and interview slots: each option judged on its own; one choice takes the first (earliest).
    if (JUDGED.has(v.kind)) {
      const picks = judgedPicks(opts, v, false);
      return picks.length ? picks[0] : -1;
    }

    // Notice periods against "< 1 Month" / "1-2 Months" / "4 weeks": compared in weeks (before spellings:
    // "> 3 Months" reads "3 months" once its sign is stripped).
    if (v.kind === 'notice' && v.weeks != null) {
      const unit = (text) => {
        const u = (norm(text).match(/\b(day|week|month)s?\b/) || [])[1];
        return u ? { day: 1 / 7, week: 1, month: 4.345 }[u] : null;
      };
      const scaled = opts
        .map((o) => {
          const r = parseRange(o.text);
          const k = unit(o.text);
          return r && k ? { i: o.i, text: `${r[0] * k}-${r[1] * k}`, r: [r[0] * k, r[1] * k] } : null;
        })
        .filter(Boolean);
      let best = null;
      for (const o of scaled)
        if (v.weeks >= o.r[0] - 1e-6 && v.weeks <= o.r[1] + 1e-6 && (!best || o.r[1] - o.r[0] < best.w))
          best = { i: o.i, w: o.r[1] - o.r[0] };
      if (best) return best.i;
    }

    // Ethnicity lists: the most specific option offered, never a fuzzy guess between subgroups.
    if (v.kind === 'ethnicity' && v.eth) return bestEthnicity(opts, options, v.eth);

    const cands = [...new Set((v.candidates || [v.text]).map(norm).filter(Boolean))];
    for (const c of cands) {
      const hit = opts.find((o) => o.n === c && !o.signed) || opts.find((o) => o.nv === c && !o.signed);
      if (hit) return hit.i;
    }
    // An option that names the value ("Job Board / LinkedIn", "Social Media (LinkedIn, Instagram…)") over broader ones.
    if (v.named) {
      const named = opts.filter((o) => v.named.test(o.n));
      if (named.length === 1) return named[0].i;
      if (named.length > 1) return bestText(named, cands, v).i;
    }
    // Options this value only takes when they name it exactly ("Campus job board" for another job site; a test of
    // the option itself for a parent's degree).
    if (v.avoid) {
      const avoid = typeof v.avoid === 'function' ? v.avoid : (o) => v.avoid.test(o.n);
      for (let k = opts.length - 1; k >= 0; k--) if (avoid(opts[k])) opts.splice(k, 1);
      if (!opts.length) return -1;
    }

    // A degree class against its spellings; a school never against a similarly named one.
    if (v.kind === 'class' && v.cls) return bestClass(opts, v, cands);
    if (v.kind === 'school') {
      const r = bestSchool(opts, v, cands);
      if (r !== null) return r;
    }
    if (v.kind === 'subject') return bestSubject(opts, v, cands);

    if (v.kind === 'country' && v.iso2) {
      const r = bestCountry(opts, v, cands);
      if (r !== null) return r;
    }

    if ((v.kind === 'date' || v.kind === 'year') && v.date) {
      // Terms and periods ("Spring/Summer 2027", "Q2 2027"): when the options are dates, never guess by text.
      const r = bestDate(opts, v);
      if (r !== null) {
        // Graduated already: "I am not currently enrolled" / "Already graduated".
        const done = r < 0 && v.past ? opts.find((o) => GRADUATED.test(o.n)) : null;
        return done ? done.i : r;
      }
    }

    if (v.kind === 'number' && v.number != null) {
      const r = bestRange(opts, v.number);
      if (r >= 0) return r;
    }

    // "Yes, will require sponsorship" / "No, already authorized": the options say whether you need a sponsor.
    let pool = opts;
    if (v.sponsor && opts.some((o) => /\bsponsor/.test(o.n))) {
      const needs = (n) => {
        if (!/\bsponsor/.test(n)) return false;
        // "No - I do not have the permanent right to work and will require sponsorship" needs it; "No, I will
        // not require sponsorship" and "No sponsorship required" don't.
        if (DOES_NOT_NEED.test(n)) return false;
        return (
          /\b(require[sd]?|requiring|need(s|ed|ing)?)\b/.test(n) ||
          !/\b(not|no|without|never|won t|don t|doesn t|dont)\b/.test(n)
        );
      };
      // "Are you authorized to work in the United States? Yes, but I will need visa sponsorship in the future" is a
      // Yes to being authorized: never the answer when you aren't.
      const claims = (n) => v.about === 'authorized' && v.authorized === 'no' && /^(yes|y)\b/.test(n);
      const kept = opts.filter((o) => needs(o.n) === (v.sponsor === 'yes') && !claims(o.n));
      if (kept.length === 1) return kept[0].i;
      if (kept.length) pool = kept;
    }

    // Status lists ("I am not currently authorized to work in the U.S." / "German Citizen" / "European Citizen"):
    // never the status you don't have; your citizenship when it is listed.
    if (v.authorized === 'yes' && pool.some((o) => NOT_AUTHORIZED.test(o.n))) {
      const kept = pool.filter((o) => !NOT_AUTHORIZED.test(o.n));
      if (kept.length) pool = kept;
    }
    if (v.citizen && v.citizen.length && v.authorized !== 'no') {
      const mine = pool.filter(
        (o) =>
          /\b(citizen|citizenship|national|passport)\b/.test(o.n) &&
          !/\b(not|non|neither|nor|other than|without)\b/.test(o.n) &&
          v.citizen.some((c) => (' ' + o.n + ' ').includes(' ' + c + ' ')),
      );
      if (mine.length) return mine[0].i;
    }

    // A Yes to a requirement the question spells out, over statements of what you have done: the one that says it back.
    if (v.requirement && v.canonical === 'yes') {
      const r = agreeing(pool, v.requirement);
      if (r >= 0) return r;
    }

    if (v.canonical) {
      const hits = pool.filter((o) => canonicalOf(o.text) === v.canonical);
      if (hits.length === 1) return hits[0].i;
      if (hits.length > 1) return bestText(hits, cands, v).i;
      // Two options, one of them clearly the opposite answer: take the other one.
      if (pool === opts && opts.length === 2 && (v.canonical === 'yes' || v.canonical === 'no')) {
        const opposite = v.canonical === 'yes' ? 'no' : 'yes';
        const other = opts.filter((o) => canonicalOf(o.text) !== opposite);
        if (other.length === 1 && canonicalOf(opts.find((o) => o !== other[0]).text) === opposite) return other[0].i;
      }
    }

    const best = bestText(opts, cands, v);
    if (best && best.score >= 45) return best.i;
    // Nothing fits: the value's own fallback ("Other" for a job site the list doesn't name), an option that is just
    // that: "Other (please specify)", never one that has it among other things ("Referral- Client/Vendor/Other").
    if (v.fallback && v.fallback.length) {
      const asIs = v.fallback.map(norm);
      // Numbered or lettered lists count: "6) Other (please explain)".
      const just = (o) => norm(o.text).replace(/^(\d{1,2}|[a-h]) /, '');
      const plain = options.map((o) => (asIs.some((f) => just(o).startsWith(f)) ? o : { text: '', value: '' }));
      return matchOption(
        plain,
        Object.assign({}, v, { candidates: v.fallback, fallback: null, kind: 'text', canonical: null }),
      );
    }
    return -1;
  }

  /* --------------------------------------------------------------- formatting */

  // A format spelled out in the label: "Start date (MM/YYYY)", "Date of birth, dd-mm-yyyy".
  const DATE_PATTERN = /\b(dd|mm|yyyy|yy)(\s*[/.-]\s*(dd|mm|yyyy|yy)){1,2}\b/i;
  // A date picker's own prompt in its box (Ant Design's "Select date" / "Select month", "Start date" / "End date").
  const DAY_PROMPT = /^(select|choose|pick|enter)( a)? (date|day)\b|^(start|end) date$/;
  const MONTH_PROMPT = /^(select|choose|pick|enter)( a)? month\b/;

  /**
   * How the page writes a date it doesn't describe: 'mdy' (US), 'ymd' (East Asia, Sweden), 'dmy.' (German and
   * other day.month.year countries) or 'dmy'. From the page's language, else the site's country domain; an
   * English page on a .com stays month first, as most US-built job sites expect.
   */
  function dateOrder(desc) {
    const lang = String(desc.lang || '').toLowerCase();
    const [code, region = ''] = lang.split(/[-_]/);
    if (region === 'us' || region === 'ph') return 'mdy';
    if (/^(ja|ko|sv|lt|hu)$/.test(code) || (code === 'zh' && region !== 'hk' && region !== 'sg')) return 'ymd';
    if (/^(de|ru|pl|cs|sk|fi|no|nb|nn|da|tr|uk|ro|hr|sl|sr|et|lv|bg|is)$/.test(code)) return 'dmy.';
    if (code && (code !== 'en' || region)) return 'dmy';
    const host = String(desc.host || '').toLowerCase();
    if (/\.(de|at|ch|pl|cz|sk|fi|no|dk|ru|tr)$/.test(host)) return 'dmy.';
    if (/\.(uk|ie|eu|fr|es|it|nl|be|pt|lu|au|nz|in|hk|sg|za|ae)$|\.eu\./.test(host)) return 'dmy';
    return 'mdy';
  }

  function formatDate(v, desc) {
    const d = v.date;
    const y = String(d.year);
    const mm = U.pad2(d.month || 1);
    const dd = U.pad2(d.day || 1);
    const type = desc.inputType || 'text';
    const s = desc.signals || {};
    let hint = String(desc.placeholderRaw || s.placeholder || '').toLowerCase();
    const label = [s.label, s.question, s.aria, s.describedby].filter(Boolean).join(' ');
    if (!DATE_PATTERN.test(hint) && DATE_PATTERN.test(label)) hint = label.match(DATE_PATTERN)[0].toLowerCase();
    const prompt = norm(desc.placeholderRaw || s.placeholder || '');
    // A month picker ("Select month") takes the year and month, written as <input type="month"> takes them: Ant
    // Design's and Element Plus's month pickers read "2027-06" and nothing else unless the site says otherwise.
    if (v.kind === 'date' && d.month && type === 'text' && MONTH_PROMPT.test(prompt) && !DATE_PATTERN.test(hint))
      return `${y}-${mm}`;
    // A day picker ("Select date") wants a whole date: a month-only date ("June 2027") goes in as its 1st, never as
    // "06/2027", which it turns down.
    const day = d.day || (v.kind === 'date' && d.month && DAY_PROMPT.test(prompt) ? 1 : 0);
    // "What date are you available (Month and Year)?" wants "November 2026", not a day.
    if (
      v.kind === 'date' &&
      d.month &&
      (type === 'text' || type === 'textarea') &&
      /\bmonth\s*(and|&|\/)\s*year\b/i.test(label) &&
      !DATE_PATTERN.test(hint)
    )
      return `${U.monthName(d.month).replace(/^./, (c) => c.toUpperCase())} ${y}`;

    // A date picker's box (it opens a calendar: Element Plus's "Pick a date") takes a whole date, in the page's
    // order: a month goes in as its first day ("01/06/2027"); "06/2027" is thrown away.
    const calendar = v.kind === 'date' && desc.popup === 'dialog';

    // A question in a plain text box with no format hint ("Earliest availability to start at CRA (not binding)")
    // reads best spelled out: "28 June 2027", which nobody takes for 6 February. Date pickers have a placeholder.
    const question = U.cleanLabel(s.label || s.question || s.aria || '');
    if (
      v.kind === 'date' &&
      d.month &&
      (type === 'text' || type === 'textarea') &&
      !calendar &&
      !hint &&
      !DATE_PATTERN.test(label) &&
      question.split(/\s+/).length >= 4
    ) {
      const month = U.monthName(d.month).replace(/^./, (c) => c.toUpperCase());
      return d.day ? `${d.day} ${month} ${y}` : `${month} ${y}`;
    }

    if (v.kind === 'month') return type === 'number' ? String(d.month) : mm;
    if (v.kind === 'year') return desc.maxLength === 2 || /^\s*yy\s*$/.test(hint) ? y.slice(2) : y;
    if (v.kind === 'day') return type === 'number' ? String(d.day) : dd;
    if (type === 'month') return `${y}-${mm}`;
    if (type === 'date') return `${y}-${mm}-${dd}`;

    const sep = (hint.match(/[/.-]/) || ['/'])[0];
    const S = '\\s*[/.\\-]\\s*';
    const yy4 = /y{4}/.test(hint);
    if (new RegExp('y{4}' + S + 'm{1,2}' + S + 'd{1,2}').test(hint)) return [y, mm, dd].join(sep);
    if (new RegExp('d{1,2}' + S + 'm{1,2}' + S + 'y{2,4}').test(hint)) return [dd, mm, yy4 ? y : y.slice(2)].join(sep);
    if (new RegExp('m{1,2}' + S + 'd{1,2}' + S + 'y{2,4}').test(hint)) return [mm, dd, yy4 ? y : y.slice(2)].join(sep);
    if (new RegExp('m{1,2}' + S + 'y{4}').test(hint)) return [mm, y].join(sep);
    if (new RegExp('m{1,2}' + S + 'y{2}').test(hint)) return [mm, y.slice(2)].join(sep);
    if (new RegExp('y{4}' + S + 'm{1,2}').test(hint)) return [y, mm].join(sep);
    if (/^\s*y{4}\s*$/.test(hint)) return y;
    if (v.defaultFormat === 'MM/YY')
      return desc.maxLength && desc.maxLength >= 7 ? `${mm}/${y}` : `${mm}/${y.slice(2)}`;
    const order = dateOrder(desc);
    if (day || (calendar && d.month)) {
      if (order === 'ymd') return [y, mm, dd].join('-');
      if (order === 'dmy.') return [dd, mm, y].join('.');
      return order === 'dmy' ? [dd, mm, y].join('/') : [mm, dd, y].join('/');
    }
    if (d.month) return order === 'ymd' ? [y, mm].join('-') : [mm, y].join(order === 'dmy.' ? '.' : '/');
    return y;
  }

  // An example number in the box or its label: "+447700900000", "e.g. +44 7700 900000".
  const PHONE_EXAMPLE = /\+?\d[\d ().-]{5,}\d/;

  /** A phone number written the way the box shows one ("+447…" or E.164: no spaces), and short enough for it. */
  function formatPhone(v, desc, max) {
    const s = desc.signals || {};
    const hints = [desc.placeholderRaw, s.placeholder, s.label, s.question, s.aria, s.describedby].map((h) =>
      String(h || ''),
    );
    const example = hints.map((h) => h.match(PHONE_EXAMPLE)).find(Boolean);
    const compact = (n) => String(n).replace(/(?!^\+)\D/g, '');
    let out = v.text;
    if ((example && !/[ ().-]/.test(example[0])) || hints.some((h) => /\bE\.?\s?164\b/i.test(h))) out = compact(out);
    if (max && out.length > max && v.national) out = v.national;
    if (max && out.length > max) out = compact(out);
    return out;
  }

  /** The string to type into a text-like control for value `v`. */
  function formatForText(v, desc) {
    if (!v) return '';
    const max = desc.maxLength > 0 ? desc.maxLength : 0;
    let out = v.text;
    if (v.date && ['date', 'month', 'year', 'day'].includes(v.kind)) out = formatDate(v, desc);
    else if (v.kind === 'country' && max && out.length > max)
      out = (max === 2 && v.iso2) || (max === 3 && v.iso3) || out;
    else if (v.kind === 'region' && max && out.length > max && v.code) out = v.code;
    else if (v.kind === 'phone') out = formatPhone(v, desc, max);
    if (desc.inputType === 'number') {
      // One number ("£45,000", "3.8", "3.8/4.0"), never digits run together from "2:1" or "06/2027".
      // A phone number in a number box is its digits.
      const plain = String(out).replace(/(\d),(\d{3})\b/g, '$1$2');
      const m = plain.match(/^[^\d-]*(-?\d+(?:\.\d+)?)(?:\s*\/\s*\d+(?:\.\d+)?)?[^\d:/]*$/);
      const n = v.number != null ? v.number : m ? parseFloat(m[1]) : NaN;
      if (v.kind === 'phone') out = String(out).replace(/\D/g, '');
      else out = Number.isFinite(n) ? String(n) : '';
    }
    if (max && out.length > max) out = out.slice(0, max);
    return out;
  }

  // A UK postcode, a Canadian one, or any short code with a space in the middle ("SW1A 1AA", "K1A 0B1").
  const POSTCODE = /^[a-z0-9]{2,4} ?[a-z0-9]{3}$/i;

  /**
   * Every way worth trying to write `v` in a text box, formatForText's first: what to try next when the box turns
   * one down (a pattern, a mask, "Please enter a valid phone number"). A phone number with and without its code,
   * spaces and leading 0; a date in each order and spelled out; a link with and without "https://"; a postcode
   * with and without its space; a number without its commas. Nothing longer than the box takes.
   */
  function textVariants(v, desc) {
    const out = [];
    const max = desc.maxLength > 0 ? desc.maxLength : 0;
    const add = (s) => {
      s = String(s == null ? '' : s).trim();
      if (s && (!max || s.length <= max) && !out.includes(s)) out.push(s);
    };
    const first = formatForText(v, desc);
    if (first) out.push(first);
    if (!v || !v.text) return out;
    const text = String(v.text).trim();
    if (v.kind === 'phone') {
      const compact = (n) => String(n || '').replace(/(?!^\+)\D/g, '');
      const intl = v.international || text;
      const nat = v.national || '';
      [intl, compact(intl), nat, compact(nat), compact(nat).replace(/^0/, '')].forEach(add);
      // Written at home with its trunk 0 ("020 7946 0958"), but for North American numbers, which have none.
      const code = (compact(intl).match(/^\+(\d{1,3})/) || [])[1];
      if (nat && code && code !== '1' && !/^0/.test(compact(nat))) ['0' + nat, '0' + compact(nat)].forEach(add);
      if (/^\+/.test(compact(intl))) [compact(intl).slice(1), '00' + compact(intl).slice(1)].forEach(add);
    } else if (v.date && v.kind === 'date' && v.date.month) {
      const d = v.date;
      const y = String(d.year);
      const mm = U.pad2(d.month);
      const month = U.monthName(d.month).replace(/^./, (c) => c.toUpperCase());
      if (d.day) {
        const dd = U.pad2(d.day);
        // The page's own order first, then ISO (which every parser takes), then the other order, then words.
        const us = dateOrder(desc) === 'mdy';
        const mine = us ? [mm, dd, y] : [dd, mm, y];
        const other = us ? [dd, mm, y] : [mm, dd, y];
        [mine.join('/'), mine.join('-'), mine.join('.'), `${y}-${mm}-${dd}`].forEach(add);
        [other.join('/'), other.join('-'), other.join('.'), `${y}/${mm}/${dd}`].forEach(add);
        [`${d.day} ${month} ${y}`, `${month} ${d.day}, ${y}`].forEach(add);
        add(`${d.day} ${month.slice(0, 3)} ${y}`);
      } else [`${mm}/${y}`, `${y}-${mm}`, `${month} ${y}`, `${mm}/${y.slice(2)}`, `${mm}-${y}`].forEach(add);
    } else if (/^https?:\/\//i.test(text)) {
      const host = text.replace(/^https?:\/\//i, '');
      [
        text,
        host,
        host.replace(/^www\./i, ''),
        'https://' + host.replace(/^www\./i, ''),
        text.replace(/\/+$/, ''),
      ].forEach(add);
    } else if (POSTCODE.test(text) && /\d/.test(text) && /[a-z]/i.test(text)) {
      const plain = text.replace(/\s+/g, '').toUpperCase();
      [plain.slice(0, -3) + ' ' + plain.slice(-3), plain].forEach(add);
    } else if (/^[£$€]?\s?\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) add(text.replace(/[^\d.]/g, ''));
    add(text);
    return out;
  }

  const matcher = {
    textVariants,
    classify,
    plan,
    questionText,
    helpText,
    canonicalOf,
    matchOption,
    matchAll,
    optionSpan,
    degreeGroup,
    isIntegratedMasters,
    formatForText,
    isPlaceholder,
    NONE_OPTION,
    dateOrder,
    declarationList,
  };
  JTF.matcher = matcher;
  if (typeof module === 'object' && module.exports) module.exports = matcher;
})(typeof globalThis !== 'undefined' ? globalThis : this);
