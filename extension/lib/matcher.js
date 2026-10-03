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
    /^(name\.|edu\.(school|degree|field|gpa|location|start|end)|exp\.(company|title|location)|address\.|location$|email$|phone|links\.|nationality$|pronouns$|job\.(currentCompany|currentTitle|salary|yearsExperience|startDate|referralSource)$)/;
  // Types a Yes/No question never asks for ("Has a bonding company ever denied you?" is not your employer).
  const NEVER_YES_NO =
    /^(name\.|edu\.(school|degree|field|gpa|location)|exp\.(company|title|location)|address\.|location$|email$|phone|links\.|nationality$|pronouns$|account\.|job\.current(Company|Title)$)/;
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
  // "Please specify if you selected Other": the box for an answer you chose not to give.
  const OTHER_FOLLOW_UP =
    /^(if|when) (you )?(selected|chose|answered|picked|ticked|checked) other\b|^(if|when) you (have )?(selected|chose|picked|ticked|checked) (?!yes\b)|\bif (you (selected|chose|answered|picked|ticked|checked) )?other\b.*\b(specify|state|tell|describe|provide|enter|give)|\b(specify|state|describe)\b.*\bif (you )?(selected|chose|answered|picked) other\b|^other please specify$|^if other\b|\bif (it|yours|your \w+( \w+)?) (is|was) not (listed|shown|in the list|found|available)\b|\bnot listed (above|below)\b.*\b(specify|enter|type|provide|state)\b/;
  const EMAIL_TYPES = new Set(['email', 'account.username']);
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
  ]);

  // "…outside of the classroom? For example: student clubs, partner organisations…": the examples don't say
  // what the question asks for.
  const EXAMPLES = /\b(for example|for instance|e g|such as)\b.*$/;

  function signalTexts(desc) {
    const out = [];
    const s = desc.signals || {};
    for (const key of Object.keys(WEIGHTS)) {
      if (!s[key]) continue;
      let text = norm(String(s[key]).slice(0, 300));
      const m = text.match(EXAMPLES);
      if (m && text.slice(0, m.index).split(' ').length > 6) text = text.slice(0, m.index).trim();
      if (text) out.push({ key, text, weight: WEIGHTS[key] });
    }
    return out;
  }

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
    // "Which university…? Please select "Other" if yours is not listed" is the question, not its follow-up box.
    const asked = String(s.question || s.label || s.aria || s.nearby || '');
    const head = asked.split('?')[0];
    if (OTHER_FOLLOW_UP.test(norm(head.split(' ').length >= 4 ? head : asked))) return null;
    // A Yes/No question is never answered with a name, a school or a link.
    const yesNoAsked = YES_NO_QUESTION.test(norm(s.question || s.label || s.aria || ''));
    const yesNo = yesNoOptions(desc) || yesNoAsked;
    const byType = new Map();
    let best = null;
    for (const rule of F().RULES) {
      if (!kindAllowed(rule, desc)) continue;
      // A strong signal naming something else ("cover letter" on an "Attach" button) rules this type out.
      if (rule.notAny && signals.some((s) => s.weight >= 0.6 && rule.notAny.test(s.text))) continue;
      let score = 0;
      let hits = 0;
      let hitText = '';
      for (const s of signals) {
        if (!rule.re.test(s.text) || (rule.not && rule.not.test(s.text))) continue;
        hits++;
        if (s.weight > score) {
          score = s.weight;
          hitText = s.text;
        }
      }
      if (!hits) continue;
      if (rule.test && !rule.test(desc, hitText)) continue;
      // An essay box ("Do you have coding experience? … GitHub links welcomed", "Think of something in
      // your academic life…") wants an answer, not a name, school or URL.
      if (desc.kind === 'textarea' && SHORT_VALUE.test(rule.type) && hitText.split(' ').length > 12) continue;
      // "Inizio offers a full suite of services… have you interviewed with another agency? If so, provide agency
      // name" is never your name, whatever the box.
      if (/^name\./.test(rule.type) && hitText.split(' ').length > 14) continue;
      // "…please outline your current right to work status, visa type and expiry date" wants more than "No".
      if (desc.kind === 'textarea' && YES_NO_TYPES.test(rule.type) && EXPLAIN.test(hitText)) continue;
      const linkBox = LINK_TYPE.test(rule.type) && !desc.options && LINK_KINDS.includes(desc.kind);
      if (yesNo && NEVER_YES_NO.test(rule.type) && !linkBox) continue;
      // "AI policy … our tools" with Yes / No options is not a list of skills; "Are you fluent in French?" is.
      if (rule.type === 'skills' && yesNoOptions(desc)) continue;
      if (rule.type === 'languages' && yesNoOptions(desc) && !F().languagesNamed(hitText).length) continue;
      score += 0.05 * (hits - 1);
      const candidate = { type: rule.type, part: rule.part || null, score, source: 'rule', rule };
      const prev = byType.get(rule.type);
      if (!prev || score > prev.score) byType.set(rule.type, candidate);
      if (!best || score > best.score + 1e-9) best = candidate;
    }
    // A word in the help text or a wrapper's id alone ("…your university's policy…") is not enough.
    if (!best || best.score < MIN_SCORE || (best.score < ANCESTOR_ONLY && !F().DATE_TYPES.has(best.type)))
      return refine(fromOptions(desc) || fallback(desc), desc);
    // "What did you receive in your undergraduate degree? First / Upper second / …" asks for the grade.
    if ((best.type === 'edu.degree' || best.type === 'edu.level') && looksLikeDegreeClasses(desc.options))
      return refine({ type: 'edu.gpa', part: null, score: best.score, source: 'options' }, desc);

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

  // UK degree classes and their usual spellings.
  const DEGREE_CLASS =
    /^(first|1st|upper second|lower second|second|2 ?[1i]|2 ?2|2 ?ii|third|3rd|distinction|merit|pass)\b|\b(first|second|third) class\b|\bclass honours\b/;

  function looksLikeDegreeClasses(options) {
    const opts = (options || []).filter((o) => !isPlaceholder(norm(o.text)));
    return opts.length >= 2 && opts.filter((o) => DEGREE_CLASS.test(norm(o.text))).length / opts.length >= 0.5;
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
    if (looksLikeDegreeClasses(opts)) return make('edu.gpa');
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
    if (
      (r.type === 'address.country' || r.type === 'nationality') &&
      (looksLikePhoneCodes(desc.options) ||
        /\b(phone|mobile|tel|telephone|cell)\b/.test(norm((desc.signals || {}).group)))
    )
      r.type = 'phone.countryCode';
    if (desc.kind === 'email' && !EMAIL_TYPES.has(r.type)) r.type = 'email';
    if (desc.kind === 'password' && !r.type.startsWith('account.pass')) r.type = 'account.password';
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
    if (type.startsWith('edu.') && type !== 'edu.level' && type !== 'edu.year') return 'edu';
    if (type.startsWith('exp.')) return 'exp';
    return null;
  }

  const DETAILS_OF = {
    'compliance.government': 'compliance.governmentDetails',
    'compliance.relatives': 'compliance.relativesDetails',
  };
  const PLACE_TYPES = ['location', 'address.city'];
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
      if (!/^(if (yes|so|applicable|you answered yes)|please (give|provide|list) (details|more|their|the))\b/.test(q))
        return;
      for (let j = i - 1; j >= Math.max(0, i - 2); j--) {
        const prev = results[j] && DETAILS_OF[results[j].type];
        if (prev) {
          results[i] = { type: prev, part: null, score: 1, source: 'follow-up' };
          return;
        }
      }
    });

    const state = { edu: { index: -1, seen: new Set() }, exp: { index: -1, seen: new Set() } };
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
        const target = prev && (r.type !== 'gen.description' || prev === 'exp') ? prev + r.type.slice(3) : null;
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
      } else if (prev && ['address.state', 'address.country', 'address.postalCode'].includes(r.type)) {
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
      if (prev !== g) detached = null;
      // Back after other questions with something this section already had: a new entry only when
      // it starts the way the first one did and goes on for more than one field.
      // "Please re-confirm the university you currently attend" among the screening questions is about the same
      // entry; a second "School" box starts the next one.
      const sameLabel =
        norm(questionText(descs[i])) === st.leadLabel || norm(questionText(descs[i])).split(' ').length <= 3;
      if (
        !detached &&
        prev !== g &&
        st.seen.has(key) &&
        (key !== st.lead || runLength(results, i, g) < 2 || !sameLabel)
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
        if (st.index === 0) {
          st.lead = key;
          st.leadLabel = norm(questionText(descs[i]));
        }
      }
      st.seen.add(key);
      r.index = st.index;
      prev = g;
    }

    const types = results.filter((r) => r && r.type).map((r) => r.type);
    const passwordFields = descs.filter((d) => d.kind === 'password').length;
    const context = {
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

  function isPlaceholder(n) {
    return (
      !n ||
      /^(select|choose|please (select|choose|specify)|pick (one|an option)|none selected|click to select)\b/.test(n)
    );
  }

  const DECLINE =
    /\bdecline|prefer not|not (wish|want) to|(don t|do not|does not) wish|(don t|do not) want to|rather not|not to (say|answer|disclose|self identify|specify|provide|state|respond)|choose not|not disclose|undisclosed|wish not to/;

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
    ['highschool', /high school|secondary|\bged\b|a levels?|gcse/],
  ];

  function degreeGroup(n) {
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
    const primary = U.tokens(cands[0] || '');
    const near = (v.near || []).map(norm).filter(Boolean);
    let best = null;
    for (const o of opts) {
      let score = 0;
      for (const c of cands) score = Math.max(score, textScore(o, c));
      if (wantDegree && degreeGroup(o.n) === wantDegree) score = Math.max(score, 75 + score * 0.2);
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

  function bestPhoneCode(opts, v) {
    const re = new RegExp('(^|[^\\d])\\+?\\s?' + v.code + '(?!\\d)');
    const countries = (v.countries || []).map(norm).filter(Boolean);
    let best = null;
    for (const o of opts) {
      let s = 0;
      if (re.test(o.text) || re.test(o.value)) s += 60;
      const hay = ' ' + o.n + ' ' + o.nv + ' ';
      if (countries.some((c) => hay.includes(' ' + c + ' '))) s += 40;
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
   * "2026-27", "2029 or later". Null when the option isn't a date.
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
    if (words.some((w) => /^\d+$/.test(w) && w.length !== 4 && !(+w >= 1 && +w <= 12))) return null;
    const units = [];
    let year = null;
    let numericMonth = null;
    for (const w of words) {
      let range = null;
      if (/^(19|20)\d{2}$/.test(w)) {
        const y = +w;
        const open = units.filter((u) => u.year == null);
        open.forEach((u) => (u.year = y));
        if (numericMonth && !open.length) units.push({ from: numericMonth, to: numericMonth, year: y });
        if (!open.length && !numericMonth) units.push({ from: 1, to: 12, year: y, wholeYear: true });
        year = y;
        numericMonth = null;
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
        units.push({ from: 1, to: 2, year: null, winter: true });
        continue;
      }
      if (TERMS[w]) range = TERMS[w];
      else if (PERIODS[w]) range = PERIODS[w];
      else if (MONTH_TOKEN.test(w)) range = [MONTH_NUMBER[w.slice(0, 3)], MONTH_NUMBER[w.slice(0, 3)]];
      else if (/^q[1-4]$/.test(w)) range = [+w[1] * 3 - 2, +w[1] * 3];
      else if (/^h[12]$/.test(w)) range = w === 'h1' ? [1, 6] : [7, 12];
      if (range) units.push({ from: range[0], to: range[1], year: null });
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
    let prev = null;
    for (const u of units) {
      const y = u.year != null ? u.year : year;
      let from = u.from;
      let to = u.to;
      // "Fall/Winter 2026": the winter after that fall.
      if (prev && prev.year === u.year && from < prev.from && u.year != null && !prev.wholeYear) {
        from += 12;
        to += 12;
      }
      start = Math.min(start, y * 12 + from - 1);
      end = Math.max(end, y * 12 + to - 1);
      prev = u;
    }
    if (/\b(or|and) (later|after|beyond|above)\b|\bonwards?\b|\bbeyond\b|\+/.test(t + (/\+/.test(raw) ? ' +' : '')))
      end = Infinity;
    else if (/\bafter\b/.test(t)) [start, end] = [end + 1, Infinity];
    if (/\b(or|and) (earlier|before|prior)\b|\bearlier\b/.test(t)) start = -Infinity;
    else if (/\b(before|prior to)\b/.test(t)) [start, end] = [-Infinity, start - 1];
    return [start, end];
  }

  const DOES_NOT_NEED =
    /\b(not|never|no longer|won t|don t|doesn t|dont|wont|without) (\w+ )?(require|need|requiring|needing)\b|\bwithout (\w+ )?sponsor|\bno (\w+ )?sponsor\w* (is |will be )?(required|needed)|\bsponsor\w* (is |will be )?not (required|needed)/;
  const NOT_AUTHORIZED =
    /\b(not|no longer|un) ?(currently |yet |legally )*(authori[sz]ed|eligible|permitted|entitled|allowed)\b|\bno (current )?(work|employment) authori[sz]ation\b|\b(do not|don t) (currently )?have (the |a )?(\w+ )?(right|authori[sz]ation|permission) to work\b/;
  const GRADUATED =
    /\b(not|no longer) (currently )?(enrolled|a (current )?student|in (school|education|university|college)|studying)\b|\b(already )?graduated\b|\balumn/;

  /** The option whose term or period best covers date value `v`, or -1. Null when no option is a date. */
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
      const width = Math.min(span[1] - span[0] + 1, 240);
      const overlap = Math.min(target[1], span[1]) - Math.max(target[0], span[0]) + 1;
      let score;
      if (overlap > 0) score = 100 + (50 * overlap) / (target[1] - target[0] + 1) - width / 4;
      else {
        const gap = span[0] > target[1] ? span[0] - target[1] : target[0] - span[1];
        if (gap > 2) continue;
        score = 50 - 15 * gap - width / 10;
      }
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

  /** Every option a list value ("London, New York") picks, in the list's order. */
  /** Which country an option spells: "United Kingdom (GB)", "UK - United Kingdom", "United Kingdom +44", "GB". */
  function countryOfOption(text) {
    const geo = JTF.geo;
    const t = String(text || '').trim();
    if (!t || !geo) return null;
    const tries = [t, t.replace(/\([^)]*\)/g, ' '), t.replace(/\+\s*\d[\d\s-]*/g, ' ')];
    for (const m of t.matchAll(/\(([^)]+)\)/g)) tries.push(m[1]);
    tries.push(t.replace(/\([^)]*\)/g, ' ').replace(/\+\s*\d[\d\s-]*/g, ' '));
    tries.push(...t.split(/\s+[-–—|:\/]\s+|\s*[|\/]\s*/));
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
    const items =
      v.items ||
      String(v.text)
        .split(/\s*[,;\n]\s*/)
        .filter(Boolean);
    const picks = [];
    for (const item of items) {
      const idx = matchOption(options, F().val(item));
      if (idx >= 0 && !picks.includes(idx)) picks.push(idx);
    }
    return picks;
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
    const opts = [];
    options.forEach((o, i) => {
      if (!o || o.disabled) return;
      const text = String(o.text || '').trim();
      const value = String(o.value == null ? '' : o.value).trim();
      const n = norm(text);
      if (isPlaceholder(n)) return;
      // "<3.7" and "> 3 Months" lose their sign when normalised: never an exact spelling of "3.7".
      opts.push({ i, text, value, n, nv: norm(value), signed: /[<>≤≥]/.test(text) });
    });
    if (!opts.length) return -1;

    if (v.kind === 'phoneCode') return bestPhoneCode(opts, v);

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
      const kept = opts.filter((o) => needs(o.n) === (v.sponsor === 'yes'));
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
    return best && best.score >= 45 ? best.i : -1;
  }

  /* --------------------------------------------------------------- formatting */

  // A format spelled out in the label: "Start date (MM/YYYY)", "Date of birth, dd-mm-yyyy".
  const DATE_PATTERN = /\b(dd|mm|yyyy|yy)(\s*[/.-]\s*(dd|mm|yyyy|yy)){1,2}\b/i;

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
    // "What date are you available (Month and Year)?" wants "November 2026", not a day.
    if (
      v.kind === 'date' &&
      d.month &&
      (type === 'text' || type === 'textarea') &&
      /\bmonth\s*(and|&|\/)\s*year\b/i.test(label) &&
      !DATE_PATTERN.test(hint)
    )
      return `${U.monthName(d.month).replace(/^./, (c) => c.toUpperCase())} ${y}`;

    // A question in a plain text box with no format hint ("Earliest availability to start at CRA (not binding)")
    // reads best spelled out: "28 June 2027", which nobody takes for 6 February. Date pickers have a placeholder.
    const question = U.cleanLabel(s.label || s.question || s.aria || '');
    if (
      v.kind === 'date' &&
      d.month &&
      (type === 'text' || type === 'textarea') &&
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
    if (d.day) {
      if (order === 'ymd') return [y, mm, dd].join('-');
      if (order === 'dmy.') return [dd, mm, y].join('.');
      return order === 'dmy' ? [dd, mm, y].join('/') : [mm, dd, y].join('/');
    }
    if (d.month) return order === 'ymd' ? [y, mm].join('-') : [mm, y].join(order === 'dmy.' ? '.' : '/');
    return y;
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
    else if (v.kind === 'phone' && max && out.length > max) out = v.national;
    if (desc.inputType === 'number') {
      const n = v.number != null ? v.number : parseFloat(String(out).replace(/[^\d.]/g, ''));
      out = Number.isFinite(n) ? String(n) : '';
    }
    if (max && out.length > max) out = out.slice(0, max);
    return out;
  }

  const matcher = {
    classify,
    plan,
    questionText,
    canonicalOf,
    matchOption,
    matchAll,
    optionSpan,
    degreeGroup,
    formatForText,
    isPlaceholder,
  };
  JTF.matcher = matcher;
  if (typeof module === 'object' && module.exports) module.exports = matcher;
})(typeof globalThis !== 'undefined' ? globalThis : this);
