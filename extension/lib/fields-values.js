/*
 * JobToFill — field rules, values: the shapes a profile answer takes (val(), a country, a list, a link, a date, "N/A"
 * for what doesn't apply), the kinds of box and the decisions that need no profile (an opt-in, a referee's details,
 * the page's own controls). One of the parts lib/fields.js puts together (loaded before it, in the order background.js
 * lists them).
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});
  const U = JTF.util;
  const P = (JTF.fieldParts = JTF.fieldParts || {});

  /**
   * A resolved value. `text` is what goes into a text box; `candidates` are
   * alternative spellings for matching <select>/radio options; `canonical`
   * (yes/no/decline/male/…) lets "No" match "I am not a protected veteran".
   */
  function val(text, extra) {
    if (U.isBlank(text)) return null;
    const t = String(text).trim();
    const v = Object.assign({ text: t, kind: 'text' }, extra || {});
    if (!v.candidates) v.candidates = [t];
    if (v.canonical === undefined) v.canonical = JTF.matcher ? JTF.matcher.canonicalOf(t) : null;
    return v;
  }

  function countryVal(text) {
    if (U.isBlank(text)) return null;
    const row = JTF.geo.findCountry(text);
    return val(text, {
      kind: 'country',
      candidates: JTF.geo.countryCandidates(text),
      search: row ? row[2] : text,
      iso2: row ? row[0] : '',
      iso3: row ? row[1] : '',
    });
  }

  function regionVal(text, country) {
    if (U.isBlank(text)) return null;
    const region = JTF.geo.findRegion(text, country);
    return val(text, {
      kind: 'region',
      candidates: JTF.geo.regionCandidates(text, country),
      search: region ? region[1] : text,
      code: region ? region[0] : '',
    });
  }

  /** "London, New York; Remote" -> a value whose items are tried in order of preference. */
  function listVal(text) {
    if (U.isBlank(text)) return null;
    const items = String(text)
      .split(/\s*(?:[,;\n]|\s\/\s)\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
    return val(text, { kind: 'list', items, canonical: null });
  }

  /** Links as forms expect them: a scheme, and no LinkedIn tracking parameters. */
  function linkVal(text) {
    if (U.isBlank(text)) return null;
    let url = String(text).trim();
    if (!/^[a-z][a-z\d+.-]*:/i.test(url) && /^[\w-]+(\.[\w-]+)+(\/|$)/.test(url)) url = 'https://' + url;
    if (/^https?:\/\/([\w-]+\.)*linkedin\.com\//i.test(url)) url = url.replace(/[?#].*$/, '');
    return val(url);
  }

  /** A settings-page answer plus the longer ways forms spell it. */
  /**
   * A named answer and its other spellings. "No religion or belief" names a category: it is no "No" that a "Not
   * Specified" would answer (a bare "No" still is).
   */
  function withSpellings(text, table) {
    const v = val(text);
    if (v && table[v.text]) v.candidates = [v.text, ...table[v.text]];
    if (v && table[v.text] && v.canonical === 'no' && !/^no$/i.test(v.text.trim())) v.canonical = null;
    return v;
  }

  const optionTexts = (ctx) => (ctx.options || []).map((o) => U.normalize(o && typeof o === 'object' ? o.text : o));

  // "Is there any other context you'd like to share about your U.S. Immigration sponsorship needs?" or "…? If yes,
  // please explain." in a text box wants a sentence, never a bare Yes or No.
  const YES_NO_START = /^(do|does|are|is|will|would|have|has|can|could|shall)\b/;
  const WANTS_DETAILS =
    /\b(context|details?|explain|elaborate|describe|specify|tell us|share|provide|more information|anything else)\b/;
  const wantsSentence = (ctx) =>
    LONG_TEXT.includes(ctx.kind) && (!YES_NO_START.test(ctx.question || '') || WANTS_DETAILS.test(ctx.question || ''));

  /** "Are you related to anyone working here? If yes, give their name" in a text box: "No", or the details. */
  function yesWithDetails(answer, details, ctx) {
    const v = val(answer);
    if (!v || v.canonical !== 'yes' || !LONG_TEXT.includes(ctx.kind) || U.isBlank(details)) return v;
    return val(String(details).trim(), { canonical: 'yes' });
  }

  /**
   * The "If yes, please give details" box after one of those questions: filled only after a Yes, or with the word
   * it asks for otherwise ("…Otherwise, enter N/A") after a No.
   */
  function detailsIfYes(answer, details, ctx) {
    const v = JTF.matcher ? JTF.matcher.canonicalOf(answer) : null;
    if (v === 'yes' && !U.isBlank(details)) return val(String(details).trim(), { canonical: 'yes' });
    return v === 'no' && ctx ? otherwiseVal(ctx) : null;
  }

  function numberVal(text) {
    if (U.isBlank(text)) return null;
    const m = String(text)
      .replace(/,/g, '')
      .match(/(\d+(?:\.\d+)?)\s*(k)?/i);
    const number = m ? parseFloat(m[1]) * (m[2] ? 1000 : 1) : null;
    return val(text, { kind: 'number', number });
  }

  /**
   * A date, or one part of it. `typicalMonth` stands in for a missing month when the
   * date has to be matched against terms like "Spring 2027" (June for an end date).
   */
  function dateVal(raw, part, typicalMonth) {
    if (U.isBlank(raw)) return null;
    const d = U.parseDate(raw);
    if (!d) return part ? null : val(raw);
    if (part === 'month') {
      if (!d.month) return null;
      return val(String(d.month), {
        kind: 'month',
        part,
        date: d,
        candidates: [U.pad2(d.month), String(d.month), U.monthName(d.month), U.monthName(d.month, true)],
        search: U.monthName(d.month),
      });
    }
    if (part === 'year') {
      // The month still matters when the options are terms: "Summer 2027", not "Spring 2027", for June.
      return val(String(d.year), {
        kind: 'year',
        part,
        date: d,
        typicalMonth: typicalMonth || null,
        candidates: [String(d.year), String(d.year).slice(2)],
      });
    }
    if (part === 'day') {
      if (!d.day) return null;
      return val(String(d.day), { kind: 'day', part, date: d, candidates: [U.pad2(d.day), String(d.day)] });
    }
    const month = d.month ? U.monthName(d.month) : '';
    const words = month ? [`${month} ${d.year}`, `${month.slice(0, 3)} ${d.year}`] : [];
    const numeric = d.month ? [`${U.pad2(d.month)}/${d.year}`, `${d.year}-${U.pad2(d.month)}`] : [];
    return val(raw, {
      kind: 'date',
      date: d,
      typicalMonth: typicalMonth || null,
      candidates: [raw, ...words, ...numeric, String(d.year)],
      search: String(d.year),
    });
  }

  /**
   * "Will you graduate between December 2028 and July 2029?" or "I confirm that my graduation date will
   * be either Fall 2026 or Spring 2027" is a yes/no question about a date: answer it from the date
   * instead of offering the date itself. Null when it isn't one.
   */
  function windowAnswer(raw, question, typicalMonth) {
    const q = question || '';
    if (!/^((will|do|are|is|have|did|would|can) (you|your)|(i|please|can you) (can )?confirm|confirm)\b/.test(q))
      return null;
    const d = U.parseDate(raw);
    if (!d) return null;
    const at = d.year * 12 + (d.month || typicalMonth) - 1;
    const span = (text) => JTF.matcher.optionSpan(text);
    let m =
      q.match(/\bbetween (.+?) and (.+)$/) ||
      q.match(/\beither (.+?) or (.+)$/) ||
      q.match(/\bgraduat\w* (?:in )?(.+?(?:19|20)\d{2}) or (.+?(?:19|20)\d{2})$/);
    let range = null;
    if (m) {
      const a = span(m[1]);
      const b = span(m[2]);
      if (a && b) range = [Math.min(a[0], b[0]), Math.max(a[1], b[1])];
    } else if ((m = q.match(/\b(before|by|after|in) ((?:[a-z]+ )?(?:19|20)\d{2})\b/))) {
      const a = span(m[2]);
      if (a)
        range =
          m[1] === 'after' ? [a[1] + 1, Infinity] : m[1] === 'in' ? a : [-Infinity, m[1] === 'by' ? a[1] : a[0] - 1];
    }
    if (!range) return null;
    return val(at >= range[0] && at <= range[1] ? 'Yes' : 'No');
  }

  const MONTH_RE =
    'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
  const DAY_MONTH = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)? (${MONTH_RE})\\b|\\b(${MONTH_RE}) (\\d{1,2})(?:st|nd|rd|th)?\\b`,
  );

  /**
   * "Are you available to start from 6th September 2027?", "Are you available from 21st June to 20th August
   * 2027?", "I confirm my availability for a Summer 2027 internship": yes when your earliest start date is
   * on or before the date asked about (the start of a range, the end of a season). "I confirm that the listed dates
   * are suitable for me; 14th June – 22nd August" names no year: the next 14th June. Interview dates are not start
   * dates (job.availability). Null when it isn't one.
   */
  function availableAnswer(raw, question, today) {
    // "7. Are you available to start…": the question's number is not part of it.
    const q = (question || '').replace(/^\d{1,2} /, '');
    // The question can follow the facts: "The internship runs from 1 July to 30 September 2027. Can you confirm…";
    // "Please confirm that if you receive an offer…, you will be able to work as of 22 February 2027".
    if (
      !/^((are|will|would|can|could|do) you|(i |please )?confirm)\b|\b(are|will|would|can|could) you (confirm|be available|be able)\b|\byou (will|would|can) be (able|available)\b|\b(are|will) you (able|free|ready|available) to\b/.test(
        q,
      )
    )
      return null;
    if (
      !/\bavailab|\bstart|\bready\b|\bcommence|\bjoin|\bsuit(s|able)?\b|\bconvenient\b|\bwork for (me|you)\b|\bable to work\b|\bfree to\b/.test(
        q,
      )
    )
      return null;
    if (INTERVIEW_SLOTS.test(q)) return null;
    const start = U.parseDate(raw);
    if (!start || !start.month) return null;
    const at = start.year * 12 + start.month - 1;
    // The first date mentioned, up to its year: "6th September 2027", "21st June" (year from later on), "Summer 2027".
    const year = q.match(/\b(?:19|20)\d{2}\b/);
    if (!year) {
      const dm = q.match(DAY_MONTH);
      if (!dm) return null;
      const day = +(dm[1] || dm[4]);
      const month = 'janfebmaraprmayjunjulaugsepoctnovdec'.indexOf((dm[2] || dm[3]).slice(0, 3)) / 3 + 1;
      const now = today ? new Date(today) : new Date();
      const past = month * 100 + day < (now.getMonth() + 1) * 100 + now.getDate();
      const from = (now.getFullYear() + (past ? 1 : 0)) * 12 + month - 1;
      return val(at < from || (at === from && (!start.day || start.day <= day)) ? 'Yes' : 'No');
    }
    const head = q.slice(0, year.index + 4);
    const range = q.match(/\bfrom (.+?) (?:to|until|till|through) /);
    const phrase = range
      ? range[1] + ' ' + year[0]
      : head.replace(/^.*?\b(from|on|by|in|for|around|before|as of)\b /, '');
    const span = JTF.matcher.optionSpan(
      phrase.replace(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/g, ''),
    );
    if (!span) return null;
    let ok = at <= (range ? span[0] : span[1]);
    const dm = phrase.match(DAY_MONTH);
    if (ok && dm && start.day && span[0] === span[1] && at === span[0]) ok = start.day <= +(dm[1] || dm[4]);
    return val(ok ? 'Yes' : 'No');
  }

  const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'];
  const SUFFIX = (n) => (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th');

  /**
   * Does your profile name this option ("MLT Career Prep", "ALPFA" from "Association of Latino Professionals For
   * America (ALPFA)") in an experience or education entry, your summary or skills? Never "None" or "Prefer not to say".
   */
  function namedInProfile(p, text) {
    const name = U.normalize(String(text || '').replace(/\([^)]*\)/g, ' '));
    const short = (String(text || '').match(/\(([A-Z][A-Za-z0-9]{2,})\)/) || [])[1];
    if (!name || (JTF.matcher && (JTF.matcher.NONE_OPTION.test(name) || JTF.matcher.canonicalOf(name)))) return false;
    const entries = [...(p.experience || []), ...(p.education || [])].flatMap((e) => Object.values(e || {}));
    const said =
      ' ' + U.normalize([p.summary, p.skills, ...entries].filter((x) => typeof x === 'string').join(' . ')) + ' ';
    return said.includes(' ' + name + ' ') || (!!short && said.includes(' ' + U.normalize(short) + ' '));
  }

  // "…Otherwise, enter N/A.", "If not, please write 'None'", "(enter N/A if not applicable)": a box's word for No.
  const OTHERWISE =
    /\bor (?:just )?(?:enter|write|type|put|input),? (n a|na|none|not applicable|nil|nothing)$|\b(?:otherwise|if (?:not|no|none|not applicable|you (?:answered|selected|said|chose) no|(?:you )?(?:haven t|have not|were not|weren t|are not|aren t|did not|didn t|do not|don t)(?: \w+){1,3}))\b,? (?:please )?(?:enter|write|type|put|input|insert|state|answer|fill in)(?: in)? (n a|na|none|not applicable|nil|no|nothing|0)\b|\b(?:enter|write|type|put|input|insert|indicate|state|answer) (n a|na|none|not applicable|nil) (?:if|where|when) (?:not applicable|it does not apply|this does not apply|not|no|none|n a|you (?:answered|selected|said) no|you (?:do not|don t) have)\b/;
  const OTHERWISE_WORDS = {
    'n a': 'N/A',
    na: 'NA',
    none: 'None',
    'not applicable': 'Not applicable',
    nil: 'Nil',
    no: 'No',
    nothing: 'Nothing',
    0: '0',
  };

  /** The word a box asks for when the answer is No ("Otherwise, enter N/A" -> "N/A"), or null. */
  function otherwiseVal(ctx) {
    const m = LONG_TEXT.includes(ctx.kind) && String(ctx.question || '').match(OTHERWISE);
    return m ? val(OTHERWISE_WORDS[m[1] || m[2] || m[3]], { otherwise: true, canonical: null }) : null;
  }

  /** "N/A" for a text box that asks only "if applicable" ("Postgraduate Degree (if applicable)"), or null. */
  // An option saying the question doesn't apply: SpaceX's "Other/Not Applicable", "Not applicable/Do not recall".
  const NA_OPTION = /\bnot applicable\b|^n ?a\b|\bdoes not apply\b|\bdoesn t apply\b/;
  /** "N/A" for what doesn't apply to you: a box that says "if applicable", or a list's own N/A option. */
  function notApplicable(ctx) {
    if (LONG_TEXT.includes(ctx.kind) && /\bif (applicable|any|relevant)\b/.test(ctx.question || ''))
      return val('N/A', { otherwise: true, canonical: null });
    // Never one about another level (Talos' "Not Applicable/I do not hold an undergraduate degree" under a question
    // about your postgraduate degree).
    const asked = P.eduLevelOf(ctx.question || '');
    const na =
      CHOICE.includes(ctx.kind) &&
      optionTexts(ctx).find((t) => {
        const n = U.normalize(t);
        const level = P.eduLevelOf(n);
        return (
          NA_OPTION.test(n) &&
          !/\b(complete|completed|graduated|achieved|finished)\b/.test(n) &&
          (!level || level === asked)
        );
      });
    return na ? val(na, { otherwise: true, canonical: null, candidates: [na] }) : null;
  }

  const at = (path, wrap) => (p) => (wrap || val)(U.getPath(p, path));
  const simple = (label, path, wrap) => ({ label, path, get: at(path, wrap) });

  /**
   * The country a place names: "Glasgow, Scotland" and "Edinburgh, UK" -> United Kingdom, "Cambridge, MA" -> United
   * States (a state code after a town is the state, not a country), "Perth, WA" -> Australia, "Paris" -> null.
   */
  function placeCountry(text) {
    const parts = String(text || '')
      .split(/\s*[,;|/]\s*|\s+[-–]\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (let k = parts.length - 1; k >= 0; k--) {
      const part = parts[k];
      const short = part.replace(/\./g, '').length <= 3;
      const region = (k > 0 || !short) && JTF.geo.regionCountry(part, parts[k - 1]);
      if (region && short) return JTF.geo.findCountry(region);
      const row = JTF.geo.findCountry(part);
      if (row) return row;
      if (region) return JTF.geo.findCountry(region);
    }
    const named = JTF.geo.countriesNamed(text).filter((c) => c !== 'EU');
    return named.length === 1 ? JTF.geo.findCountry(named[0]) : null;
  }

  // Control kinds produced by the DOM scanner.
  const TEXTISH = ['text', 'email', 'tel', 'url', 'number', 'date', 'month', 'textarea', 'combobox'];
  const CHOICE = ['select', 'radio', 'checkboxes', 'combo', 'combobox'];
  const DEFAULT_KINDS = TEXTISH.concat(CHOICE);
  const LONG_TEXT = ['text', 'textarea'];

  function hasYesNoOptions(desc) {
    const opts = (desc.options || []).filter((o) => !JTF.matcher.isPlaceholder(U.normalize(o.text)));
    return opts.length > 0 && opts.length <= 3 && opts.every((o) => JTF.matcher.canonicalOf(o.text));
  }

  // "1st Stage Video Interview Availability — Please select ALL dates/times for which you are available", "Which of
  // these slots work for you?", "Assessment centre dates", "Select your preferred interview slot(s)".
  const INTERVIEW_SLOTS =
    /\b(interview|assessment|video (call|interview)|phone screen|superday|assessment cent(re|er)|call)s? (availability|slots?|dates?|times?|sessions?)\b|\bavailab\w* (for|to (attend|do|join|take part in)) (an |the |a |your |our )?(\w+ ){0,2}(interviews?|assessments?|assessment cent(re|er)s?|calls?|superdays?)\b|\b(dates?|times?|slots?|days?)( (and |or )?(dates?|times?))? (for which|when|that|on which) you (are|re|would be|will be|can be) (available|free)\b|\bwhich (of (these|the following) )?(dates?|times?|days?|slots?|sessions?)( (and |or )?(dates?|times?|slots?))? (work|suit|are you available|would you be available|can you (make|attend|do))\b|\bpreferred (interview |assessment )?(time ?)?(slots?|sessions?)\b|\b(select|choose|pick|book) (your |a |an |all )?(preferred )?(interview |assessment )?(time ?)?slots?\b/;

  // What each type of field is filled with.
  Object.assign((P.DEFS = P.DEFS || {}), {
    // Never ticked or chosen for you, nor counted missing, nor sent to the AI.
    optIn: { label: 'Opt-in', get: () => null, leave: true, derived: true },
    // A referee's name, email or phone: not in your profile, and never yours.
    referee: { label: 'Referee details', get: () => null, leave: true, derived: true },
    // The site's own search box or language switcher (matcher.classify): nothing of yours goes in, nor the AI's.
    page: { label: 'The page’s own control', get: () => null, leave: true, derived: true },
    // A box for the answer a list above didn't have, "or write N/A if you selected another answer" (see matcher.plan).
    na: { label: 'N/A for another answer', get: () => val('N/A', { otherwise: true, canonical: null }), derived: true },

    // Ticked only when "Tick acknowledgement boxes" is on in settings; otherwise left for you.
    consent: {
      label: 'Acknowledgement',
      consent: true,
      get(p, ctx) {
        if (!ctx.consents) return null;
        // "I confirm that the listed dates are suitable for me; 14th June – 22nd August" as a box to tick: not when
        // you can only start later.
        const dates = availableAnswer((p.job || {}).startDate, ctx.question, ctx.today);
        return dates && dates.text === 'No' ? null : val('Yes', { consent: true });
      },
    },
  });

  Object.assign(P, {
    CHOICE,
    DAY_MONTH,
    DEFAULT_KINDS,
    INTERVIEW_SLOTS,
    LONG_TEXT,
    MONTH_RE,
    ORDINALS,
    SUFFIX,
    TEXTISH,
    availableAnswer,
    countryVal,
    dateVal,
    detailsIfYes,
    hasYesNoOptions,
    linkVal,
    listVal,
    namedInProfile,
    notApplicable,
    numberVal,
    optionTexts,
    otherwiseVal,
    placeCountry,
    regionVal,
    simple,
    val,
    wantsSentence,
    windowAnswer,
    withSpellings,
    yesWithDetails,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
