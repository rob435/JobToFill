/*
 * JobToFill — profile schema, field types, detection rules and value resolution.
 *
 * A "field type" (e.g. "name.first", "edu.school", "job.sponsorship") is what the
 * detector assigns to a form control. DEFS says where the value for each type
 * lives in the profile; RULES say how to recognise it from label text.
 * All rule regexes run against JTF.util.normalize()d text: lowercase, accents
 * stripped, punctuation collapsed to single spaces ("LinkedIn URL*" -> "linked in url").
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});
  const U = JTF.util;

  /* ------------------------------------------------------------------ profile */

  function blankEducation() {
    return { school: '', degree: '', field: '', gpa: '', location: '', startDate: '', endDate: '' };
  }

  function blankExperience() {
    return { company: '', title: '', location: '', startDate: '', endDate: '', current: false, description: '' };
  }

  function blankCustomAnswer() {
    return { id: U.uid(), question: '', answer: '' };
  }

  function createProfile(name) {
    return {
      id: U.uid(),
      name: name || 'My profile',
      personal: {
        prefix: '',
        firstName: '',
        middleName: '',
        lastName: '',
        preferredName: '',
        pronouns: '',
        dob: '',
        nationality: '',
      },
      contact: { email: '', phoneCountryCode: '', phone: '', phoneType: 'Mobile' },
      address: { line1: '', line2: '', city: '', state: '', postalCode: '', country: '', organization: '' },
      links: { linkedin: '', github: '', portfolio: '', website: '', twitter: '' },
      job: {
        yearsExperience: '',
        authorized: '',
        sponsorship: '',
        relocate: '',
        over18: '',
        salary: '',
        noticePeriod: '',
        nonCompete: '',
        startDate: '',
        referralSource: '',
        locations: '',
        otherOffers: '',
        // Countries you have the right to work in (blank: your nationality, and where you live if authorised).
        workCountries: '',
        // Happy to work in the office / on site full time; need adjustments in the recruitment process.
        onsite: '',
        adjustments: '',
        // Security clearance (defence / engineering): the level you hold, and whether you could get one.
        clearance: '',
        clearanceEligible: '',
      },
      eeo: {
        gender: '',
        race: '',
        hispanic: '',
        veteran: '',
        disability: '',
        sexualOrientation: '',
        genderIdentitySame: '',
        religion: '',
        neurodivergent: '',
        // UK social-mobility monitoring
        schoolType: '',
        freeSchoolMeals: '',
        parentsDegree: '',
        parentOccupation: '',
        postcodeAt14: '',
        careLeaver: '',
        carer: '',
        refugee: '',
        bursary: '',
      },
      // Conflicts of interest (banks and law firms ask these)
      compliance: {
        previouslyEmployed: '',
        previouslyApplied: '',
        relatives: '',
        relativesDetails: '',
        governmentOfficial: '',
        familyGovernmentOfficial: '',
        governmentDetails: '',
      },
      education: [blankEducation()],
      experience: [blankExperience()],
      skills: '',
      languages: '',
      summary: '',
      coverLetter: '',
      customAnswers: [],
    };
  }

  /** Bring a stored profile up to the current schema without touching user data. */
  function upgradeProfile(profile) {
    const template = createProfile();
    delete template.id;
    delete template.name;
    const p = U.mergeDefaults(profile || {}, template);
    if (!p.id) p.id = U.uid();
    if (!p.name) p.name = 'My profile';
    p.education = (Array.isArray(p.education) ? p.education : []).map((e) => U.mergeDefaults(e, blankEducation()));
    p.experience = (Array.isArray(p.experience) ? p.experience : []).map((e) => U.mergeDefaults(e, blankExperience()));
    p.customAnswers = (Array.isArray(p.customAnswers) ? p.customAnswers : []).map((a) =>
      U.mergeDefaults(a, blankCustomAnswer()),
    );
    return p;
  }

  /* ------------------------------------------------------------------- values */

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

  // The ways UK social-mobility questions word each answer the settings page offers.
  const SCHOOL_TYPES = {
    'State school (non-selective)': [
      'state run or state funded school non selective',
      'non selective state school',
      'state school non selective',
      'comprehensive',
      'state school',
      'state run or state funded school',
    ],
    'State school (selective)': [
      'state run or state funded school selective',
      'selective state school',
      'grammar school',
      'state school selective',
      'state school',
    ],
    'Independent / fee-paying school': [
      'independent or fee paying school',
      'independent school',
      'fee paying school',
      'private school',
    ],
    'Independent school with a 90%+ bursary': [
      'independent or fee paying school where i received a means tested bursary',
      'bursary',
      'independent or fee paying school',
    ],
    'School outside the UK': ['attended school outside the uk', 'school outside the uk', 'outside the uk', 'overseas'],
  };
  const PARENT_DEGREE = {
    Yes: ['Yes', 'degree or above', 'at least one has a degree', 'degree level', 'university degree'],
    No: ['No', 'qualifications below degree level', 'below degree level', 'no degree'],
  };
  const OCCUPATIONS = {
    Professional: ['modern professional and traditional professional occupations', 'professional occupations'],
    'Manager / administrator': ['senior middle or junior managers or administrators', 'managers or administrators'],
    'Clerical / intermediate': ['clerical and intermediate occupations', 'intermediate occupations'],
    'Technical / craft': ['technical and craft occupations'],
    'Routine / semi-routine': [
      'routine semi routine manual and service occupations',
      'routine manual and service occupations',
    ],
    'Long-term unemployed': ['long term unemployed'],
    'Small business owner': ['small business owners', 'self employed'],
    'Other / not applicable': [
      'other such as retired',
      'this question does not apply to me',
      'other',
      'not applicable',
    ],
  };

  // Clearance levels and their long names (UK NSV, US).
  const CLEARANCES = {
    None: ['None', 'No clearance', 'I do not hold a clearance', 'Not applicable'],
    BPSS: ['BPSS', 'Baseline Personnel Security Standard', 'Baseline'],
    CTC: ['CTC', 'Counter-Terrorist Check', 'Counter Terrorist Check'],
    SC: ['SC', 'Security Check', 'Security Check (SC)'],
    eDV: ['eDV', 'Enhanced Developed Vetting'],
    DV: ['DV', 'Developed Vetting', 'Developed Vetting (DV)'],
    'Public Trust': ['Public Trust'],
    Confidential: ['Confidential'],
    Secret: ['Secret'],
    'Top Secret': ['Top Secret', 'TS'],
    'TS/SCI': ['TS/SCI', 'Top Secret/SCI', 'Top Secret / SCI', 'TS SCI'],
  };

  const RELIGIONS = {
    'No religion or belief': ['No religion or belief', 'No religion', 'Atheist', 'None', 'No religion / atheist'],
    Agnostic: ['Agnostic'],
    Buddhist: ['Buddhist', 'Buddhism'],
    Christian: ['Christian', 'Christianity'],
    Hindu: ['Hindu', 'Hinduism'],
    Jewish: ['Jewish', 'Judaism'],
    Muslim: ['Muslim', 'Islam'],
    Sikh: ['Sikh', 'Sikhism'],
    'Any other religion or belief': ['Any other religion or belief', 'Other religion', 'Other'],
  };
  const ORIENTATIONS = {
    'Heterosexual / straight': ['Heterosexual / straight', 'Heterosexual', 'Straight'],
    Gay: ['Gay', 'Gay man', 'Gay / Lesbian', 'Gay or lesbian'],
    Lesbian: ['Lesbian', 'Gay woman', 'Gay / Lesbian', 'Gay or lesbian'],
    Bisexual: ['Bisexual', 'Bi', 'Bisexual and/or pansexual'],
    Pansexual: ['Pansexual', 'Bisexual and/or pansexual'],
    Asexual: ['Asexual'],
    Queer: ['Queer'],
    'Other sexual orientation': ['Other', 'I identify in another way', 'Prefer to self-describe'],
  };

  /** A settings-page answer plus the longer ways forms spell it. */
  function withSpellings(text, table) {
    const v = val(text);
    if (v && table[v.text]) v.candidates = [v.text, ...table[v.text]];
    return v;
  }

  function sponsorAware(v, p) {
    const canon = (t) => (JTF.matcher ? JTF.matcher.canonicalOf(t) : null);
    const need = canon(p.job.sponsorship);
    if (v && (need === 'yes' || need === 'no')) v.sponsor = need;
    // Options that describe your status ("German citizen", "I am not currently authorized…") need these too.
    const authorized = canon(p.job.authorized);
    if (v && (authorized === 'yes' || authorized === 'no')) v.authorized = authorized;
    if (v && JTF.geo && JTF.geo.citizenWords) v.citizen = JTF.geo.citizenWords(p.personal.nationality);
    return v;
  }

  /**
   * A notice period, also in weeks, for options like "< 1 Month" / "1-2 Months": "2 weeks", "1 month",
   * "None" or "Immediately" (0).
   */
  function noticeVal(text) {
    if (U.isBlank(text)) return null;
    const t = U.normalize(text);
    const m = t.match(/(\d+(?:\.\d+)?|one|two|three|four|six)\s*(day|week|month)s?/);
    const words = { one: 1, two: 2, three: 3, four: 4, six: 6 };
    const none = /^(none|no notice|nil|immediate(ly)?( available)?|0|zero|n a)$/.test(t);
    const weeks = none ? 0 : m ? (words[m[1]] || parseFloat(m[1])) * { day: 1 / 7, week: 1, month: 4.345 }[m[2]] : null;
    const extra = none ? ['None', 'Immediately', 'Immediate', 'Immediately available', 'No notice period', '0'] : [];
    return val(text, { kind: 'notice', weeks, candidates: [String(text).trim(), ...extra] });
  }

  /**
   * The countries you have the right to work in (ISO codes): as listed, else your nationality and, when you said
   * you're authorised, the country you live in. Without a nationality it isn't known: then nothing (your answers
   * stand for wherever you apply, as before).
   */
  function workCountries(p) {
    const listed = String(p.job.workCountries || '')
      .split(/\s*[,;\n]\s*|\s+(?:and|&)\s+/)
      .map((c) => JTF.geo.findCountry(c.trim()))
      .filter(Boolean)
      .map((row) => row[0]);
    if (listed.length) return listed;
    const out = [];
    const nation = JTF.geo.findCountry(p.personal.nationality);
    if (!nation) return [];
    out.push(nation[0]);
    const home = JTF.geo.findCountry(p.address.country);
    if (home && JTF.matcher && JTF.matcher.canonicalOf(p.job.authorized) === 'yes') out.push(home[0]);
    return [...new Set(out)];
  }

  /**
   * A work-authorisation question about a country you have no right to work in ("Are you authorized to work in
   * the United States?" for a British student): the country it names, else null.
   */
  function noRightIn(p, ctx) {
    const asked = JTF.geo.countriesNamed(ctx.question || '');
    if (!asked.length) return null;
    const mine = workCountries(p);
    if (!mine.length) return null;
    const rights = JTF.geo.workRights(mine);
    const either = /\bor\b/.test(ctx.question || '');
    const ok = either ? asked.some((c) => rights.has(c)) : asked.every((c) => rights.has(c));
    if (ok) return null;
    const code = asked.find((c) => !rights.has(c));
    const row = code === 'EU' ? null : JTF.geo.COUNTRIES.find((r) => r[0] === code);
    return {
      code,
      name: code === 'EU' ? 'the EU' : row ? (code === 'US' || code === 'GB' ? 'the ' : '') + row[2] : 'that country',
    };
  }

  /** Not authorised there, so sponsorship needed: for options like "No, I will require sponsorship" too. */
  function elsewhere(p, ctx, which) {
    const where = noRightIn(p, ctx);
    if (!where) return null;
    if (
      LONG_TEXT.includes(ctx.kind) &&
      !/^(do|does|are|is|will|would|have|has|can|could|shall)\b/.test(ctx.question || '')
    )
      return val(`I don’t have the right to work in ${where.name} and would need visa sponsorship.`);
    const v = val(which === 'authorized' ? 'No' : 'Yes');
    return Object.assign(v, { sponsor: 'yes', authorized: 'no', citizen: [] });
  }

  /**
   * "Right to work / Visa status" in a text box wants a sentence, not "No": written from your two answers.
   * Null for yes/no questions ("Do you require sponsorship?") and choice controls.
   */
  function workStatus(p, ctx) {
    if (
      !LONG_TEXT.includes(ctx.kind) ||
      /^(do|does|are|is|will|would|have|has|can|could|shall)\b/.test(ctx.question || '')
    )
      return null;
    const canon = (t) => (JTF.matcher ? JTF.matcher.canonicalOf(t) : null);
    const ok = canon(p.job.authorized);
    const sponsor = canon(p.job.sponsorship);
    if (ok === 'yes' && sponsor === 'no') return val('I have the right to work and do not need visa sponsorship.');
    if (ok === 'yes' && sponsor === 'yes') return val('I have the right to work now but will need visa sponsorship.');
    if (ok === 'no' || sponsor === 'yes') return val('I will need visa sponsorship to work in this role.');
    return null;
  }

  /** "Are you related to anyone working here? If yes, give their name" in a text box: "No", or the details. */
  function yesWithDetails(answer, details, ctx) {
    const v = val(answer);
    if (!v || v.canonical !== 'yes' || !LONG_TEXT.includes(ctx.kind) || U.isBlank(details)) return v;
    return val(String(details).trim(), { canonical: 'yes' });
  }

  /** The "If yes, please give details" box after one of those questions: filled only after a Yes. */
  function detailsIfYes(answer, details) {
    const v = JTF.matcher ? JTF.matcher.canonicalOf(answer) : null;
    return v === 'yes' && !U.isBlank(details) ? val(String(details).trim(), { canonical: 'yes' }) : null;
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

  // UK degree classes and the ways forms spell them ("Upper Second Class", "Second class honours: Grade 1").
  const DEGREE_CLASSES = [
    [
      /^(first|1st|1)( class)?( honours)?$/,
      ['First', '1st', 'First Class', 'First Class Honours', '1st Class', 'First / 1st'],
    ],
    [
      /^(2 ?1|2 ?i|upper second|2 1 upper second)( class)?( honours)?$/,
      [
        '2:1',
        '2.1',
        '2i',
        'Upper Second',
        'Upper Second Class',
        'Upper Second Class Honours',
        'Second Class Honours Grade 1',
        'Second Class Honours (Upper Division)',
        'Second Class Upper',
      ],
    ],
    [
      /^(2 ?2|2 ?ii|lower second)( class)?( honours)?$/,
      [
        '2:2',
        '2.2',
        '2ii',
        'Lower Second',
        'Lower Second Class',
        'Lower Second Class Honours',
        'Second Class Honours Grade 2',
        'Second Class Honours (Lower Division)',
        'Second Class Lower',
      ],
    ],
    [/^(third|3rd)( class)?( honours)?$/, ['Third', '3rd', 'Third Class', 'Third Class Honours', '3rd Class']],
  ];

  /** "3.9" or "3.9/4.0" also matches ranges like "3.80 - 4.00"; "2:1" or "First" matches its spellings. */
  function gpaVal(text) {
    const m = String(text || '').match(/^\s*(\d(?:\.\d+)?)\s*(?:\/\s*\d(?:\.\d+)?)?\s*$/);
    if (m && !/:/.test(text)) return val(text, { kind: 'number', number: parseFloat(m[1]) });
    const cls = DEGREE_CLASSES.find(([re]) => re.test(U.normalize(text)));
    return cls ? val(text, { candidates: [String(text).trim(), ...cls[1]] }) : val(text);
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
   * on or before the date asked about (the start of a range, the end of a season). Null when it isn't one.
   */
  function availableAnswer(raw, question) {
    const q = question || '';
    // The question can follow the facts: "The internship runs from 1 July to 30 September 2027. Can you confirm…"
    if (
      !/^((are|will|would|can|could|do) you|(i )?confirm)\b|\b(are|will|would|can|could) you (confirm|be available|be able)\b/.test(
        q,
      )
    )
      return null;
    if (!/\bavailab|\bstart|\bready\b|\bcommence|\bjoin/.test(q)) return null;
    const start = U.parseDate(raw);
    if (!start || !start.month) return null;
    // The first date mentioned, up to its year: "6th September 2027", "21st June" (year from later on), "Summer 2027".
    const year = q.match(/\b(?:19|20)\d{2}\b/);
    if (!year) return null;
    const head = q.slice(0, year.index + 4);
    const range = q.match(/\bfrom (.+?) (?:to|until|till|through) /);
    const phrase = range ? range[1] + ' ' + year[0] : head.replace(/^.*?\b(from|on|by|in|for|around|before)\b /, '');
    const span = JTF.matcher.optionSpan(
      phrase.replace(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/g, ''),
    );
    if (!span) return null;
    const at = start.year * 12 + start.month - 1;
    let ok = at <= (range ? span[0] : span[1]);
    const dm = phrase.match(DAY_MONTH);
    if (ok && dm && start.day && span[0] === span[1] && at === span[0]) ok = start.day <= +(dm[1] || dm[4]);
    return val(ok ? 'Yes' : 'No');
  }

  const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'];
  const SUFFIX = (n) => (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th');

  /**
   * "What year of study are you in?", worked out from the course you are on (the first education
   * entry that hasn't ended, else the first one): "3rd year", plus the words lists use for it
   * ("Final year", "Penultimate year", "Junior"). Null before the course starts.
   */
  function studyYear(p, today) {
    const now = today || new Date();
    const nowM = now.getFullYear() * 12 + now.getMonth();
    const month = (d, typical) => (d ? d.year * 12 + (d.month || typical) - 1 : null);
    const list = (p.education || []).map((e) => ({
      start: month(U.parseDate(e.startDate), 9),
      end: month(U.parseDate(e.endDate), 6),
    }));
    const e = list.find((x) => x.end != null && x.end >= nowM) || list[0];
    if (!e || e.start == null || e.end == null || nowM < e.start) return null;
    if (nowM > e.end)
      return val('Graduated', { candidates: ['Graduated', 'I have graduated', 'Already graduated', 'Alumni'] });
    const total = Math.max(1, Math.round((e.end - e.start) / 12));
    const year = Math.min(total, Math.floor((nowM - e.start) / 12) + 1);
    const n = `${year}${SUFFIX(year)}`;
    const word = ORDINALS[year - 1] || n;
    const extra = [];
    if (year === total) extra.push('Final year', 'Final', 'Senior');
    else if (year === total - 1) extra.push('Penultimate year', 'Penultimate');
    if (year === 1) extra.push('Freshman');
    else if (year === 2 && year !== total) extra.push('Sophomore');
    else if (year === 3 && year !== total) extra.push('Junior');
    return val(`${n} year`, { candidates: [`${n} year`, `Year ${year}`, `${word} year`, ...extra, n, String(year)] });
  }

  /* ---------------------------------------------------------------- ethnicity */

  // Ethnic groups and subgroups as UK (ONS 2001/2011/2021) and US (EEO) forms list them. `words` name the group
  // in an option; each subgroup is [key, settings label, words, Asian region]. A stored answer is free text
  // ("Asian – Chinese", or an older broad "Asian"): parseEthnicity reads answers and options the same way.
  const ETHNIC_GROUPS = [
    {
      key: 'asian',
      label: 'Asian / Asian British',
      words: /\basian\b/,
      subs: [
        ['chinese', 'Chinese', /\bchinese\b|\bhong kong(er)?\b|\btaiwanese\b/, 'east'],
        ['indian', 'Indian', /(?<!\b(american|west|east|north american|alaskan?) )\bindian\b/, 'south'],
        ['pakistani', 'Pakistani', /\bpak[ia]stan[ia]?\b/, 'south'],
        ['bangladeshi', 'Bangladeshi', /\bbangladesh[ia]?\b/, 'south'],
        ['japanese', 'Japanese', /\bjapanese\b/, 'east'],
        ['korean', 'Korean', /\bkorean\b/, 'east'],
        ['filipino', 'Filipino', /\bfilipin[oa]\b|\bphilippine\b/, 'southeast'],
        ['vietnamese', 'Vietnamese', /\bvietnamese\b/, 'southeast'],
        ['thai', 'Thai', /\bthai\b/, 'southeast'],
        ['malaysian', 'Malaysian', /\bmalaysian\b|\bmalay\b/, 'southeast'],
        ['indonesian', 'Indonesian', /\bindonesian\b/, 'southeast'],
        ['srilankan', 'Sri Lankan', /\bsri lankan?\b/, 'south'],
        ['nepali', 'Nepali', /\bnepal(i|ese)\b/, 'south'],
      ],
    },
    {
      key: 'black',
      label: 'Black / African / Caribbean / Black British',
      words: /\bblack\b|\bof african descent\b/,
      subs: [
        ['africanamerican', 'African American', /\bafrican american\b/],
        ['african', 'African', /(?<!\bnorth )\bafrican\b(?! (american|descent))/],
        ['caribbean', 'Caribbean', /\bcarr?ib+ean\b|\bwest indian\b/],
      ],
    },
    {
      key: 'mixed',
      label: 'Mixed / Multiple ethnic groups',
      words:
        /\bmixed\b|\bmultiple ethnic\b|\btwo or more\b|\bmulti ?racial\b|\bbi ?racial\b|\bwhite and (black|asian)\b|\b(black|asian) and white\b/,
      subs: [
        ['whiteasian', 'White and Asian', /\bwhite and asian\b|\basian and white\b/],
        ['whiteblackafrican', 'White and Black African', /\bwhite and black african\b|\bblack african and white\b/],
        [
          'whiteblackcaribbean',
          'White and Black Caribbean',
          /\bwhite and black carr?ib+ean\b|\bblack carr?ib+ean and white\b/,
        ],
        // Lists that stop at "White and Black": either of the two above (never offered in settings).
        ['whiteblack', 'White and Black', /\bwhite and black\b|\bblack and white\b/, null, true],
      ],
    },
    {
      key: 'white',
      label: 'White',
      words: /\bwhite\b|\bcaucasian\b|\beuropean\b/,
      subs: [
        [
          'british',
          'British (English / Welsh / Scottish / Northern Irish)',
          /\bbritish\b|\benglish\b|\bwelsh\b|\bscottish\b|\bnorthern irish\b|\bunited kingdom\b|\buk\b/,
        ],
        ['traveller', 'Gypsy or Irish Traveller', /\bgyps(y|ies)\b|\btravell?er\b/],
        ['irish', 'Irish', /(?<!\bnorthern )\birish\b(?! travell?er)/],
        ['roma', 'Roma', /\broma(ni)?\b/],
      ],
    },
    {
      key: 'hispanic',
      label: 'Hispanic / Latino',
      words: /\bhispanic\b|\blatin[aoxe]\b|\blatinx\b|\bspanish origin\b/,
      subs: [
        ['mexican', 'Mexican', /\bmexican\b|\bchican[oa]\b/],
        ['puertorican', 'Puerto Rican', /\bpuerto rican\b/],
        ['cuban', 'Cuban', /\bcuban\b/],
        ['latinamerican', 'Central / South American', /\b(central|south|latin) american\b/],
      ],
    },
    {
      key: 'mena',
      label: 'Middle Eastern / North African',
      words: /\bmiddle eastern\b|\bnorth african\b|\bmena\b|\bswana\b/,
      subs: [
        ['arab', 'Arab', /\barab(ic)?\b/],
        ['iranian', 'Iranian', /\biranian\b|\bpersian\b/],
        ['turkish', 'Turkish', /\bturkish\b/],
        ['kurdish', 'Kurdish', /\bkurd(ish)?\b/],
        ['northafrican', 'North African', /\bnorth african\b/],
      ],
    },
    {
      key: 'indigenous',
      label: 'Indigenous',
      words: /\bindigenous\b|\bfirst peoples\b/,
      subs: [
        ['aian', 'American Indian or Alaska Native', /\bamerican indian\b|\balaska\w* native\b|\bnative american\b/],
        ['nhpi', 'Native Hawaiian or Other Pacific Islander', /\bnative hawaiian\b|\bpacific islander\b/],
        ['aboriginal', 'Aboriginal and / or Torres Strait Islander', /\baboriginal\b|\btorres strait\b/],
        ['maori', 'Māori', /\bmaori\b/],
        ['firstnations', 'First Nations / Inuit / Métis', /\bfirst nations?\b|\binuit\b|\bmetis\b/],
      ],
    },
    {
      key: 'other',
      label: 'Other',
      words: /^(any )?other( ethnic(ity| group| background)?)?\b|\bother ethnic\b/,
      subs: [],
    },
  ];
  const ASIAN_REGIONS = [
    ['southeast', /\bsouth ?east(ern)? asian?\b/],
    ['south', /\bsouth asian?\b/],
    ['east', /(?<!\bsouth )\beast asian?\b/],
  ];
  // US EEO's broad categories: a group, whatever subgroup words they contain.
  const US_BROAD = /^(black or african american|african american or black|hispanic or latin[aox]+|white|asian)$/;

  /**
   * What an ethnicity answer or option names: { group, groups, sub, region, other } — "Asian or Asian British -
   * Other Asian background" is { group: 'asian', other: true }, "Chinese - Chinese" { group: 'asian', sub: 'chinese' },
   * "Asian (Not Hispanic or Latinx)" { group: 'asian' }. Null when it names no group (or declines).
   */
  function parseEthnicity(text) {
    // "(Not Hispanic or Latinx)" qualifies a US category; it names no second group.
    const raw = String(text || '').replace(
      /\(?\s*not\s+(hispanic|latin[a-z]*)(\s+or\s+(hispanic|latin[a-z]*))?\s*\)?/gi,
      ' ',
    );
    const all = U.normalize(raw);
    if (!all || (JTF.matcher && JTF.matcher.canonicalOf(all) === 'decline')) return null;
    const parts = raw.split(/\s*[:–—]\s*|\s+-\s+/).filter((x) => x.trim());
    const head = parts.length > 1 ? U.normalize(parts[0]) : all;
    const tail = parts.length > 1 ? U.normalize(parts.slice(1).join(' ')) : all;
    let groups = ETHNIC_GROUPS.filter((g) => g.words.test(head)).map((g) => g.key);
    if (groups.includes('mixed')) groups = ['mixed']; // "White and Black African" is one mixed group
    const other = /\b(any )?other\b|\bnot listed\b/.test(tail) && !/\bother pacific islander\b/.test(tail);
    let sub = null;
    let subGroup = null;
    let region = null;
    // "Any other Black, Black British or Caribbean background" names no subgroup.
    if (!US_BROAD.test(all) && !other) {
      // Subgroups of the groups the option names (any group when it names none: "Chinese", "Arab").
      const pool = ETHNIC_GROUPS.filter((g) => !groups.length || groups.includes(g.key) || groups.includes('other'));
      for (const g of pool) {
        // "Middle Eastern or North African" is the group's own name.
        const hits = g.subs.filter(
          ([key, , re]) => re.test(tail) && !(key === 'northafrican' && /\bmiddle eastern\b/.test(tail)),
        );
        if (!hits.length) continue;
        subGroup = g.key;
        // "Black, Black British, Caribbean or African" names the whole group, not one subgroup.
        if (hits.length === 1 || g.key === 'mixed') [sub, , , region] = hits[0];
        break;
      }
    }
    if (!sub && !US_BROAD.test(all) && (groups.includes('asian') || !groups.length)) {
      const r = ASIAN_REGIONS.find(([, re]) => re.test(all));
      if (r) region = r[0];
    }
    const group = subGroup || (region ? 'asian' : groups.find((g) => g !== 'other') || groups[0] || null);
    if (!group) return null;
    const named = groups.length > 0;
    return {
      group,
      groups: [...new Set([...groups, group])],
      named,
      sub,
      region: region || null,
      other: !sub && other,
    };
  }

  /** An ethnicity answer: matched against an option list by parseEthnicity, most specific option first. */
  function ethnicityVal(text) {
    const v = val(text);
    const eth = v ? parseEthnicity(v.text) : null;
    if (eth) Object.assign(v, { kind: 'ethnicity', eth });
    return v;
  }

  /** The settings page's choices: [{ label, items: [value…] }]. */
  const ETHNICITY_CHOICES = ETHNIC_GROUPS.map((g) => ({
    label: g.label,
    items:
      g.key === 'other'
        ? ['Any other ethnic group']
        : [
            ...g.subs.filter((x) => !x[4]).map(([, label]) => `${g.label.split(' / ')[0]} – ${label}`),
            ...(g.key === 'asian'
              ? [
                  'Asian – Any other East Asian background',
                  'Asian – Any other South Asian background',
                  'Asian – Any other Southeast Asian background',
                ]
              : []),
            `${g.label.split(' / ')[0]} – Any other ${g.key === 'mena' ? 'Middle Eastern or North African' : g.label.split(' / ')[0]} background`,
          ],
  }));

  /**
   * "Please select your enrollment status" / "Are you currently enrolled?": yes, at the level of the course you
   * are on (an education entry that hasn't ended), else no. Null without dated education.
   */
  function enrolment(p, today) {
    const now = today || new Date();
    const nowM = now.getFullYear() * 12 + now.getMonth();
    const dated = (p.education || []).filter((e) => U.parseDate(e.endDate));
    if (!dated.length) return null;
    const current = dated.find((e) => {
      const d = U.parseDate(e.endDate);
      return d.year * 12 + (d.month || 6) - 1 >= nowM;
    });
    if (!current)
      return val('No', {
        candidates: ['No', 'Not currently enrolled', 'Not enrolled', 'Graduated', 'None of the above'],
      });
    const level = JTF.matcher ? JTF.matcher.degreeGroup(U.normalize(current.degree)) : null;
    const words =
      {
        bachelor: ['Enrolled in a bachelor', 'Bachelor', 'Undergraduate'],
        master: ['Enrolled in a graduate', 'Graduate', 'Master', 'Postgraduate'],
        doctorate: ['Enrolled in a graduate', 'Doctorate', 'PhD', 'Graduate'],
        highschool: ['High school'],
      }[level] || [];
    // The level first: it decides between "enrolled in a bachelor's…" and "enrolled in a graduate…".
    return val('Yes', { candidates: [...words, 'Yes', 'Currently enrolled', 'Enrolled'] });
  }

  function degreeVal(text) {
    return val(text, { kind: 'degree' });
  }

  function fullName(p) {
    return [p.personal.firstName, p.personal.lastName].filter((s) => !U.isBlank(s)).join(' ');
  }

  function currentJob(p) {
    const list = p.experience || [];
    return list.find((e) => e.current) || list[0] || null;
  }

  function phoneCode(p) {
    const digits = String(p.contact.phoneCountryCode || '').replace(/[^\d]/g, '');
    return digits ? '+' + digits : '';
  }

  /**
   * The number without its dialling code, for a form that asks for the code in a box of its own:
   * "+44 7700 900123" -> "7700 900123". A number written without a code stays as it is.
   */
  function nationalNumber(num, cc) {
    const split = JTF.geo.splitPhone(num);
    if (!split) return num;
    const want = String(cc || '').replace(/\D/g, '');
    return !want || split.code === want ? split.national || num : num;
  }

  function cardExp(card) {
    if (!card || !card.expMonth || !card.expYear) return null;
    const year = String(card.expYear).length === 2 ? '20' + card.expYear : String(card.expYear);
    return `${year}-${U.pad2(card.expMonth)}`;
  }

  // prettier-ignore
  const LANGUAGE_NAMES = [
    'english', 'french', 'german', 'spanish', 'italian', 'portuguese', 'dutch', 'mandarin', 'cantonese', 'chinese',
    'japanese', 'korean', 'arabic', 'russian', 'polish', 'hindi', 'urdu', 'bengali', 'turkish', 'swedish', 'norwegian',
    'danish', 'finnish', 'greek', 'hebrew', 'czech', 'hungarian', 'romanian', 'vietnamese', 'thai', 'indonesian',
    'malay', 'tagalog', 'swahili', 'punjabi', 'tamil', 'gujarati', 'persian', 'farsi', 'ukrainian', 'flemish', 'welsh',
  ];
  const LANGUAGE_RE = new RegExp(`\\b(${LANGUAGE_NAMES.join('|')})\\b`, 'g');
  const YES_NO_LANGUAGE =
    /^(are|do|can|could|would|is|have) (you|your)\b|^(fluent|fluency|proficient|proficiency) in\b/;

  /** The languages a question names: "Are you fluent in French or German?" -> ["french", "german"]. */
  function languagesNamed(question) {
    return [...new Set(String(question || '').match(LANGUAGE_RE) || [])];
  }

  // Where people hear about jobs, and the broader options forms offer for each.
  const JOB_SITE = [
    'Job board',
    'Online job board',
    'Job site',
    'Jobs board',
    'Job website',
    'Job boards',
    'Online job site',
    'Graduate job website',
    'Job posting',
    'Job advert',
  ];
  // A job site is never the university's or the employer's own board ("School job board", "Acme Website").
  const NOT_A_JOB_SITE =
    /\b(school|campus|universit\w*|college|careers? (service|centre|center|office|fair)|society|club|forum|reddit|employee|website|careers? (site|page)|handshake|12 ?twenty|target ?connect|global)\b/;
  const SOURCE_KINDS = [
    [
      /\b(trackr|bright ?network|gradcracker|rate ?my ?(placement|apprenticeship)|targetjobs|target ?connect|prospects|milkround|handshake|indeed|glassdoor|monster|reed|totaljobs|efinancialcareers|otta|welcome to the jungle|wellfound|angel ?list|simplyhired|ziprecruiter|built ?in|the student room|gradireland|jobteaser|unitemps|careerjet|job ?board|job ?site)\b/,
      JOB_SITE,
    ],
    [/\blinked ?in\b/, ['Social media', 'Social network', 'Social networking', ...JOB_SITE]],
    [/\b(instagram|facebook|tiktok|twitter|x|youtube|reddit)\b/, ['Social media', 'Social network', 'Online']],
    [
      /\b(google|bing|search)\b/,
      ['Search engine', 'Internet search', 'Web search', 'Online search', 'Internet', 'Online'],
    ],
    [
      /\b(careers? fair|job fair|campus|university|society|event)\b/,
      [
        'Careers fair',
        'Career fair',
        'Campus event',
        'University event',
        'University careers service',
        'University',
        'Event',
      ],
    ],
    [
      /\b(friend|referr|colleague|employee|word of mouth|family)\b/,
      ['Referral', 'Employee referral', 'Friend', 'Word of mouth', 'Personal network'],
    ],
    [/\b(company|careers?) (website|site|page)\b/, ['Company website', 'Careers website', 'Careers page', 'Website']],
  ];

  // Programming languages, for "Which programming languages…?" when the skills list mixes them with other tools.
  const PROGRAMMING =
    /^(python|java|javascript|js|typescript|ts|c|c\+\+|cpp|c#|c sharp|go|golang|rust|scala|kotlin|swift|objective c|ruby|php|perl|r|matlab|julia|haskell|ocaml|f#|sql|t sql|pl sql|bash|shell|powershell|vba|sas|stata|lua|dart|elixir|erlang|clojure|fortran|cobol|assembly|solidity|q|kdb\+?|q kdb|verilog|vhdl|html|css|lisp|scheme|prolog|groovy|zig|nim|crystal)$/;
  const PROGRAMMING_QUESTION = /\b(programming|coding|scripting|computer|software) languages?\b/;

  /* -------------------------------------------------------------- definitions */

  const at = (path, wrap) => (p) => (wrap || val)(U.getPath(p, path));
  const simple = (label, path, wrap) => ({ label, path, get: at(path, wrap) });

  // "Undergraduate GPA", "GPA (Graduate)", "Name of secondary school": the entry at that level of study.
  const LEVEL_WORDS = [
    [
      'highschool',
      /\b(high school|secondary( school)?|sixth form|a levels?|gcses?|academy school|abitur|baccalaureat|matura|leaving cert\w*|school graduation|school leaving|highers|international baccalaureate|ib diploma)\b/,
    ],
    ['bachelor', /\b(undergrad\w*|bachelor\w*|bsc)\b/],
    [
      'master',
      /\b(master\w*|msc|mba|post ?grad\w*|graduate (degree|school|program|programme|gpa|studies|student|level))\b|\bgpa graduate\b/,
    ],
    ['doctorate', /\b(doctora\w*|ph ?d|dphil)\b/],
  ];

  /** The one level of study a question names, or null (none, or several). */
  function eduLevelOf(question) {
    // Examples don't count: "…graduate? This includes … studies e.g. a Masters".
    const q = String(question || '').replace(/\b(e g|eg|i e|such as|for example|including|includes|include)\b.*$/, '');
    const hits = LEVEL_WORDS.filter(([, re]) => re.test(q)).map(([level]) => level);
    return hits.length === 1 ? hits[0] : null;
  }

  function entry(label, list, key, kind) {
    return {
      label,
      list,
      key,
      group: list === 'education' ? 'edu' : 'exp',
      get(p, ctx) {
        const i = ctx.index || 0;
        if (list === 'experience' && !ctx.jobContext) {
          // A "Company" box on a checkout form is not your employer.
          return key === 'company' && i === 0 ? val(p.address.organization) : null;
        }
        const level = list === 'education' ? eduLevelOf(ctx.question) : null;
        const e = level
          ? (p.education || []).find((x) => JTF.matcher.degreeGroup(U.normalize(x.degree)) === level)
          : (p[list] || [])[i];
        if (!e) return null;
        if (kind === 'date') {
          if (key === 'endDate' && e.current) return null;
          const typical = key === 'endDate' ? 6 : 9;
          const v = windowAnswer(e[key], ctx.question, typical) || dateVal(e[key], ctx.part, typical);
          // Graduated already: "Expected graduation date: … / I am not currently enrolled" takes the last one.
          if (v && v.date && key === 'endDate' && list === 'education') {
            const now = ctx.today || new Date();
            if (v.date.year * 12 + (v.date.month || typical) - 1 < now.getFullYear() * 12 + now.getMonth())
              v.past = true;
          }
          return v;
        }
        if (kind === 'bool') return val(e[key] ? 'Yes' : 'No');
        if (kind === 'degree') {
          // "What degree course are you studying?" in a text box wants "BSc in Mathematics", not just "BSc".
          const withSubject =
            LONG_TEXT.includes(ctx.kind) &&
            /\b(course|subject|studying|major)\b/.test(ctx.question || '') &&
            !U.isBlank(e.degree) &&
            !U.isBlank(e.field) &&
            !U.normalize(e.degree).includes(U.normalize(e.field));
          return degreeVal(withSubject ? `${e.degree} in ${e.field}` : e[key]);
        }
        if (kind === 'number') return numberVal(e[key]);
        if (kind === 'gpa') return gpaVal(e[key]);
        return val(e[key]);
      },
    };
  }

  const DEFS = {
    'name.full': { label: 'Full name', get: (p) => val(fullName(p)) },
    'name.first': simple('First name', 'personal.firstName'),
    'name.middle': simple('Middle name', 'personal.middleName'),
    'name.last': simple('Last name', 'personal.lastName'),
    // Nickname-style boxes ("Preferred name", "Known as", "Display name") always get the LEGAL name: the first
    // name when the label says first / given / short / nick, otherwise the full legal name. The profile's
    // preferredName is never filled into forms.
    'name.preferred': {
      label: 'Preferred name',
      get(p, ctx) {
        const q = U.normalize((ctx && ctx.question) || '');
        const full =
          /\b(full|legal|complete|whole|entire|surname|passport|official|nom complet|nombre completo)\b/.test(q);
        const first = /\b(first|given|short|nick ?name|forename|prenom|vorname|nombre|nome)\b/.test(q);
        return val(first && !full ? p.personal.firstName : fullName(p));
      },
    },
    'name.prefix': simple('Title (Mr/Ms)', 'personal.prefix'),
    pronouns: simple('Pronouns', 'personal.pronouns'),
    dob: { label: 'Date of birth', path: 'personal.dob', get: (p, ctx) => dateVal(p.personal.dob, ctx.part) },
    // "Age: 18 - 21 / 22 - 30": worked out from the date of birth.
    age: {
      label: 'Age',
      get(p, ctx) {
        const d = U.parseDate(p.personal.dob);
        if (!d || !d.month) return null;
        const now = ctx.today || new Date();
        const had = now.getMonth() + 1 > d.month || (now.getMonth() + 1 === d.month && now.getDate() >= (d.day || 1));
        const years = now.getFullYear() - d.year - (had ? 0 : 1);
        return years > 0 && years < 120 ? val(String(years), { kind: 'number', number: years }) : null;
      },
    },
    nationality: {
      label: 'Nationality',
      path: 'personal.nationality',
      get(p) {
        // Lists of nationalities ("American", "British") as well as of countries.
        const v = countryVal(p.personal.nationality);
        if (v && v.iso2) v.candidates = [...new Set([...v.candidates, ...JTF.geo.demonyms(v.iso2)])];
        // A US citizenship-status list ("U.S. citizen / green card holder / … / Other (please explain)").
        if (v) v.fallback = ['Other', 'Other (please explain)', 'Other (please specify)', 'None of the above'];
        return v;
      },
    },

    // "Are you a US citizen (or lawful permanent resident)?": yes from your nationality; no when the
    // question names another country and nothing else; left for you when residency could still make it yes.
    citizen: {
      label: 'Citizenship (yes/no)',
      // No path: a "Yes" here must never be learnt as your nationality.
      get(p, ctx) {
        const mine = JTF.geo.citizenWords(p.personal.nationality);
        if (!mine.length) return null;
        const q = ' ' + (ctx.question || '') + ' ';
        if (mine.some((w) => q.includes(' ' + w + ' '))) return val('Yes');
        return /permanent resident|green card|asylee|refugee|resident/.test(q) ? null : val('No');
      },
    },

    email: simple('Email', 'contact.email'),
    phone: {
      label: 'Phone',
      path: 'contact.phone',
      get(p, ctx) {
        const num = String(p.contact.phone || '').trim();
        if (!num) return null;
        const cc = phoneCode(p);
        const international = cc && !num.startsWith('+') ? `${cc} ${num}` : num;
        // "Country/Region Code" in a box of its own: the number goes in without it.
        const national = nationalNumber(num, cc);
        const full = ctx.hasCountryCodeField ? national : international;
        return val(full, { kind: 'phone', national, international });
      },
    },
    'phone.national': {
      label: 'Phone (national)',
      path: 'contact.phone',
      get: (p) => val(nationalNumber(String(p.contact.phone || '').trim(), phoneCode(p))),
    },
    'phone.countryCode': {
      label: 'Phone country code',
      path: 'contact.phoneCountryCode',
      get(p) {
        // The code you gave, else the one your number starts with, else your country's.
        const split = JTF.geo.splitPhone(p.contact.phone);
        const code = phoneCode(p).slice(1) || (split && split.code) || JTF.geo.dialCode(p.address.country);
        if (!code) return null;
        // The country the code is for: where you live when its code is this one ("+1" in Canada is Canada),
        // else the country the code usually means ("+44" is the United Kingdom, not Jersey).
        const home = JTF.geo.findCountry(p.address.country);
        const iso2 = home && JTF.geo.dialCode(home[0]) === code ? home[0] : JTF.geo.countryOfDial(code);
        const row = iso2 ? JTF.geo.findCountry(iso2) : null;
        return val('+' + code, {
          kind: 'phoneCode',
          code,
          iso2,
          countries: row ? JTF.geo.countryCandidates(row[2]) : [],
          search: row ? row[2] : '+' + code,
        });
      },
    },
    'phone.type': simple('Phone type', 'contact.phoneType'),

    'address.line1': {
      label: 'Address line 1',
      path: 'address.line1',
      get: (p, ctx) => (ctx.kind === 'textarea' ? DEFS['address.full'].get(p, ctx) : val(p.address.line1)),
    },
    'address.line2': simple('Address line 2', 'address.line2'),
    'address.street': {
      label: 'Street address',
      get: (p) => val([p.address.line1, p.address.line2].filter((s) => !U.isBlank(s)).join(', ')),
    },
    'address.full': {
      label: 'Full address',
      get(p) {
        const a = p.address;
        const cityLine = [a.city, [a.state, a.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
        return val([a.line1, a.line2, cityLine, a.country].filter((s) => !U.isBlank(s)).join('\n'));
      },
    },
    'address.city': simple('City', 'address.city'),
    'address.state': {
      label: 'State / province',
      path: 'address.state',
      get: (p) => regionVal(p.address.state, p.address.country),
    },
    'address.postalCode': simple('Postal code', 'address.postalCode'),
    'address.country': simple('Country', 'address.country', countryVal),
    location: {
      label: 'Location (city, state)',
      get(p) {
        const a = p.address;
        const parts = [a.city, a.state || a.country].filter((s) => !U.isBlank(s));
        if (!parts.length) return null;
        // Location autocompletes list "San Francisco, California, United States" next to
        // "San Francisco, Cebu, Philippines": spell the state and country out so the right one wins.
        const region = JTF.geo.findRegion(a.state, a.country);
        const country = JTF.geo.findCountry(a.country);
        const state = region ? region[1] : a.state;
        const countryName = country ? country[2] : a.country;
        const spelled = [
          [a.city, state, countryName],
          [a.city, state],
          [a.city, countryName],
        ].map((list) => list.filter((s) => !U.isBlank(s)).join(', '));
        const candidates = [parts.join(', '), ...spelled].concat(a.city && parts.length > 1 ? [a.city] : []);
        // Words that tell two same-named cities apart.
        const near = [
          ...(region || [a.state]),
          ...(country ? JTF.geo.countryCandidates(a.country) : [a.country]),
        ].filter((s) => !U.isBlank(s));
        return val(parts.join(', '), {
          kind: 'location',
          candidates: [...new Set(candidates)],
          near,
          search: a.city || parts[0],
        });
      },
    },

    'links.linkedin': simple('LinkedIn', 'links.linkedin', linkVal),
    'links.github': {
      label: 'GitHub',
      path: 'links.github',
      get(p, ctx) {
        const v = linkVal(p.links.github);
        // "What is your GitHub username?" wants "ada", not the link.
        const user = v && /\b(user ?name|handle)\b/.test(ctx.question || '') && v.text.match(/github\.com\/([\w.-]+)/i);
        return user ? val(user[1]) : v;
      },
    },
    'links.portfolio': {
      label: 'Portfolio',
      path: 'links.portfolio',
      get: (p) => linkVal(p.links.portfolio || p.links.website),
    },
    'links.website': {
      label: 'Website',
      path: 'links.website',
      get: (p) => linkVal(p.links.website || p.links.portfolio),
    },
    'links.twitter': simple('Twitter / X', 'links.twitter', linkVal),

    'job.currentCompany': {
      label: 'Current company',
      get: (p) => {
        const j = currentJob(p);
        return j ? val(j.company) : null;
      },
    },
    'job.currentTitle': {
      label: 'Current title',
      get: (p) => {
        const j = currentJob(p);
        return j ? val(j.title) : null;
      },
    },
    'job.yearsExperience': simple('Years of experience', 'job.yearsExperience', numberVal),
    // Both carry whether you need sponsorship, for options like "Yes, will require sponsorship".
    // A question naming a country you can't work in gets "No" / "Yes, I'd need sponsorship", whatever you said for home.
    'job.authorized': {
      label: 'Authorized to work',
      path: 'job.authorized',
      get: (p, ctx) => elsewhere(p, ctx, 'authorized') || workStatus(p, ctx) || sponsorAware(val(p.job.authorized), p),
    },
    'job.sponsorship': {
      label: 'Requires sponsorship',
      path: 'job.sponsorship',
      get: (p, ctx) =>
        elsewhere(p, ctx, 'sponsorship') || workStatus(p, ctx) || sponsorAware(val(p.job.sponsorship), p),
    },
    'job.onsite': simple('Happy to work in the office / on site', 'job.onsite'),
    'job.adjustments': simple('Adjustments needed in the recruitment process', 'job.adjustments'),
    'compliance.previouslyApplied': simple('Applied here before', 'compliance.previouslyApplied'),
    'job.relocate': simple('Willing to relocate', 'job.relocate'),
    'job.over18': simple('Over 18', 'job.over18'),
    'job.salary': simple('Salary expectation', 'job.salary', numberVal),
    'job.noticePeriod': simple('Notice period', 'job.noticePeriod', noticeVal),
    'job.nonCompete': {
      label: 'Non-compete / notice period',
      path: 'job.nonCompete',
      get(p, ctx) {
        // "Non-compete/Notice period comments" asks for both in one box.
        const nonCompete = String(p.job.nonCompete || '').trim();
        const notice = /\bnotice\b/.test(ctx.question || '') ? String(p.job.noticePeriod || '').trim() : '';
        if (nonCompete && notice && LONG_TEXT.includes(ctx.kind))
          return val(`${nonCompete.replace(/[.\s]+$/, '')}. Notice period: ${notice}`);
        return val(nonCompete || notice);
      },
    },
    'job.locations': simple('Preferred locations', 'job.locations', listVal),
    'job.clearance': {
      label: 'Security clearance held',
      path: 'job.clearance',
      get(p, ctx) {
        const held = String(p.job.clearance || '').trim();
        if (!held) return null;
        const none = /^(none|no|n\/?a|not applicable|nil)$/i.test(held);
        // "Do you currently hold an active security clearance?" is yes / no.
        if (/^(do|are|have|is|does) (you|your)\b/.test(ctx.question || '')) return val(none ? 'No' : 'Yes');
        return withSpellings(none ? 'None' : held, CLEARANCES);
      },
    },
    'job.clearanceEligible': {
      label: 'Eligible for security clearance',
      path: 'job.clearanceEligible',
      get(p) {
        // Holding one already answers "Do you hold, or are you willing to obtain, SC clearance?".
        const held = String(p.job.clearance || '').trim();
        if (held && !/^(none|no|n\/?a|not applicable|nil)$/i.test(held)) return val('Yes');
        return val(p.job.clearanceEligible);
      },
    },
    'job.otherOffers': simple('Other offers / deadlines', 'job.otherOffers'),
    'job.startDate': {
      label: 'Available start date',
      path: 'job.startDate',
      get: (p, ctx) => availableAnswer(p.job.startDate, ctx.question) || dateVal(p.job.startDate, ctx.part, 9),
    },
    // A job site the form doesn't list ("Trackr") still picks its kind ("Online job board"), else "Other".
    'job.referralSource': {
      label: 'How you heard about the job',
      path: 'job.referralSource',
      get(p) {
        const v = val(p.job.referralSource);
        if (!v) return v;
        const kind = SOURCE_KINDS.find(([re]) => re.test(U.normalize(v.text)));
        v.candidates = [v.text, ...(kind ? kind[1] : [])];
        if (kind && kind[1] === JOB_SITE) v.avoid = NOT_A_JOB_SITE;
        v.fallback = ['Other', 'Other (please specify)', 'Others', 'Something else'];
        return v;
      },
    },

    'eeo.gender': simple('Gender', 'eeo.gender'),
    'eeo.race': { label: 'Race / ethnicity', path: 'eeo.race', get: (p) => ethnicityVal(p.eeo.race) },
    // A Hispanic / Latino ethnicity answers the separate US "Are you Hispanic or Latino?" question too.
    'eeo.hispanic': {
      label: 'Hispanic / Latino',
      path: 'eeo.hispanic',
      get(p) {
        const e = parseEthnicity(p.eeo.race);
        return val(p.eeo.hispanic) || (e && e.group === 'hispanic' ? val('Yes') : null);
      },
    },
    'eeo.veteran': simple('Veteran status', 'eeo.veteran'),
    'eeo.disability': simple('Disability status', 'eeo.disability'),
    'eeo.sexualOrientation': {
      label: 'Sexual orientation',
      path: 'eeo.sexualOrientation',
      get: (p) => withSpellings(p.eeo.sexualOrientation, ORIENTATIONS),
    },
    // "Is the gender you identify with the same as the sex registered at birth?"; "Are you trans?" asks the opposite.
    'eeo.genderIdentitySame': {
      label: 'Gender identity same as sex at birth',
      path: 'eeo.genderIdentitySame',
      get(p, ctx) {
        const v = val(p.eeo.genderIdentitySame);
        if (v && /\btrans(gender)?\b/.test(ctx.question || '') && !/\bsame\b/.test(ctx.question || ''))
          return v.canonical === 'yes' ? val('No') : v.canonical === 'no' ? val('Yes') : v;
        return v;
      },
    },
    // "Do you identify as LGBTQIA+?": from your orientation and gender identity.
    'eeo.lgbt': {
      label: 'LGBTQ+',
      get(p) {
        const o = U.normalize(p.eeo.sexualOrientation);
        const same = JTF.matcher ? JTF.matcher.canonicalOf(p.eeo.genderIdentitySame) : null;
        if (!o || /prefer not|decline/.test(o)) return null;
        if (!/^heterosexual|^straight/.test(o) || same === 'no') return val('Yes');
        return same === 'yes' ? val('No') : null;
      },
    },
    'eeo.religion': {
      label: 'Religion or belief',
      path: 'eeo.religion',
      get: (p) => withSpellings(p.eeo.religion, RELIGIONS),
    },
    'eeo.neurodivergent': simple('Neurodivergent', 'eeo.neurodivergent'),
    'eeo.postcodeAt14': simple('Home postcode at age 14', 'eeo.postcodeAt14'),
    'eeo.careLeaver': simple('Been in care', 'eeo.careLeaver'),
    'eeo.carer': simple('Carer', 'eeo.carer'),
    'eeo.refugee': simple('Refugee or asylum seeker', 'eeo.refugee'),
    'eeo.bursary': simple('Means-tested bursary or grant at university', 'eeo.bursary'),

    'compliance.previouslyEmployed': simple('Worked here before', 'compliance.previouslyEmployed'),
    'compliance.relatives': {
      label: 'Relatives working here',
      path: 'compliance.relatives',
      get: (p, ctx) => yesWithDetails(p.compliance.relatives, p.compliance.relativesDetails, ctx),
    },
    'compliance.relativesDetails': {
      label: 'Relatives working here: details',
      path: 'compliance.relativesDetails',
      get: (p) => detailsIfYes(p.compliance.relatives, p.compliance.relativesDetails),
    },
    // "Are you, or is any immediate family member, a current or former government official…?", "Are you a
    // politically exposed person?", "Were your parents involved in government?": you, your family, or both.
    'compliance.government': {
      label: 'Government official / PEP',
      get(p, ctx) {
        const q = ctx.question || '';
        const family =
          /\b(related to|family|relatives?|parents?|spouse|partner|siblings?|child(ren)?|household|close associates?)\b/.test(
            q,
          );
        const self =
          !family ||
          (/\b(you or|you and|yourself|are you (a|an|currently|now|ever|or)|have you (ever )?(been|held|worked)|were you)\b/.test(
            q,
          ) &&
            !/\bare you related\b/.test(q));
        const canon = (t) => (JTF.matcher ? JTF.matcher.canonicalOf(t) : null);
        const answers = [
          self && canon(p.compliance.governmentOfficial),
          family && canon(p.compliance.familyGovernmentOfficial),
        ].filter((x) => x !== false);
        let answer = null;
        if (answers.includes('yes')) answer = 'Yes';
        else if (answers.length && answers.every((x) => x === 'no')) answer = 'No';
        if (!answer) return null;
        return answer === 'Yes' ? yesWithDetails('Yes', p.compliance.governmentDetails, ctx) : val('No');
      },
    },
    'compliance.governmentDetails': {
      label: 'Government official / PEP: details',
      path: 'compliance.governmentDetails',
      get(p) {
        const canon = (t) => (JTF.matcher ? JTF.matcher.canonicalOf(t) : null);
        const yes = [p.compliance.governmentOfficial, p.compliance.familyGovernmentOfficial].some(
          (x) => canon(x) === 'yes',
        );
        return detailsIfYes(yes ? 'Yes' : 'No', p.compliance.governmentDetails);
      },
    },

    'eeo.schoolType': {
      label: 'Type of school (age 11–16)',
      path: 'eeo.schoolType',
      get: (p) => withSpellings(p.eeo.schoolType, SCHOOL_TYPES),
    },
    'eeo.freeSchoolMeals': simple('Free school meals', 'eeo.freeSchoolMeals'),
    'eeo.parentsDegree': {
      label: 'A parent has a degree',
      path: 'eeo.parentsDegree',
      get(p, ctx) {
        const v = withSpellings(p.eeo.parentsDegree, PARENT_DEGREE);
        // "Are you the first in your family to go to university?" asks the opposite.
        if (v && /\bfirst\b.*\b(family|generation)\b|\bfirst generation\b/.test(ctx.question || '')) {
          if (v.canonical === 'yes') return val('No');
          if (v.canonical === 'no') return val('Yes');
        }
        return v;
      },
    },
    'eeo.parentOccupation': {
      label: 'Main household earner’s job at 14',
      path: 'eeo.parentOccupation',
      get: (p) => withSpellings(p.eeo.parentOccupation, OCCUPATIONS),
    },

    'edu.level': { label: 'Highest education', get: (p) => degreeVal(((p.education || [])[0] || {}).degree) },
    'edu.school': entry('School / university', 'education', 'school'),
    'edu.degree': entry('Degree', 'education', 'degree', 'degree'),
    'edu.field': entry('Field of study', 'education', 'field'),
    'edu.gpa': entry('GPA', 'education', 'gpa', 'gpa'),
    'edu.location': entry('School location', 'education', 'location'),
    'edu.start': entry('Education start date', 'education', 'startDate', 'date'),
    'edu.end': entry('Graduation date', 'education', 'endDate', 'date'),
    'edu.year': { label: 'Year of study', get: (p, ctx) => studyYear(p, ctx.today) },
    'edu.enrolled': { label: 'Currently enrolled', get: (p, ctx) => enrolment(p, ctx.today) },

    'exp.company': entry('Company', 'experience', 'company'),
    'exp.title': entry('Job title', 'experience', 'title'),
    'exp.location': entry('Job location', 'experience', 'location'),
    'exp.start': entry('Job start date', 'experience', 'startDate', 'date'),
    'exp.end': entry('Job end date', 'experience', 'endDate', 'date'),
    'exp.current': entry('Currently work here', 'experience', 'current', 'bool'),
    'exp.description': entry('Job description', 'experience', 'description'),

    skills: {
      label: 'Skills',
      path: 'skills',
      // A list, so a checklist or multi-select ("Which of these do you know?") takes the skills one by one.
      // "Top 3 programming languages" in a text box gets three programming languages, not Excel and Bloomberg.
      get(p, ctx) {
        const v = listVal(p.skills);
        if (!v || !PROGRAMMING_QUESTION.test(ctx.question || '') || !LONG_TEXT.includes(ctx.kind)) return v;
        let items = v.items.filter((i) => PROGRAMMING.test(U.normalize(i).replace(/\s*\(.*\)$/, '')));
        const top = (ctx.question || '').match(/\btop (\d|two|three|four|five)\b/);
        if (top) items = items.slice(0, { two: 2, three: 3, four: 4, five: 5 }[top[1]] || +top[1]);
        return items.length ? listVal(items.join(', ')) : null;
      },
    },
    languages: {
      label: 'Languages',
      path: 'languages',
      get(p, ctx) {
        // "Which languages are you fluent in other than English?": leave English out.
        const q = ctx.question || '';
        const other = q.match(/\b(?:other than|besides|apart from|except|in addition to) ([a-z ]+)/);
        let text = p.languages;
        if (other && !U.isBlank(text)) {
          const kept = listVal(text).items.filter((l) => !other[1].split(' ').includes(U.normalize(l)));
          if (!kept.length) return null;
          text = kept.join(', ');
        }
        // "Are you fluent in French?": yes when you listed it (left for you when you didn't).
        const asked = !other && YES_NO_LANGUAGE.test(q) ? languagesNamed(q) : [];
        if (asked.length) {
          const mine = listVal(text) ? listVal(text).items.map(U.normalize) : [];
          return asked.some((l) => mine.some((m) => m === l || m.split(' ').includes(l))) ? val('Yes') : null;
        }
        return listVal(text);
      },
    },
    summary: simple('Summary', 'summary'),
    coverLetter: simple('Cover letter', 'coverLetter'),

    // Ticked only when "Tick acknowledgement boxes" is on in settings; otherwise left for you.
    consent: {
      label: 'Acknowledgement',
      consent: true,
      get: (p, ctx) => (ctx.consents ? val('Yes', { consent: true }) : null),
    },

    'file.resume': { label: 'Resume file', file: 'resume', get: () => null },
    'file.coverLetter': { label: 'Cover letter file', file: 'coverLetter', get: () => null },
    'file.transcript': { label: 'Transcript file', file: 'transcript', get: () => null },

    'account.username': {
      label: 'Username',
      secret: 'password',
      get: (p, ctx) =>
        val((ctx.secrets && ctx.secrets.credential && ctx.secrets.credential.username) || p.contact.email),
    },
    'account.password': {
      label: 'Password',
      secret: 'password',
      get: (p, ctx) =>
        val(ctx.secrets && ctx.secrets.credential && ctx.secrets.credential.password, { sensitive: true }),
    },
    'account.passwordConfirm': {
      label: 'Confirm password',
      secret: 'password',
      get: (p, ctx) =>
        val(ctx.secrets && ctx.secrets.credential && ctx.secrets.credential.password, { sensitive: true }),
    },
    // "Passcode", "Verification code": the code a site emails you. The code watcher (content/otp.js) types it in.
    otp: { label: 'Verification code', secret: 'otp', get: () => null },
    // A plain "I'm not a robot" checkbox (no CAPTCHA behind it): ticked like a person would.
    human: { label: 'I’m not a robot', get: () => val('Yes') },

    'cc.name': {
      label: 'Name on card',
      secret: 'card',
      get: (p, ctx) => {
        const c = ctx.secrets && ctx.secrets.card;
        return c ? val(c.name || fullName(p), { sensitive: true }) : null;
      },
    },
    'cc.number': {
      label: 'Card number',
      secret: 'card',
      get: (p, ctx) => {
        const c = ctx.secrets && ctx.secrets.card;
        return c ? val(String(c.number || '').replace(/\s+/g, ''), { sensitive: true }) : null;
      },
    },
    'cc.exp': {
      label: 'Card expiry',
      secret: 'card',
      get(p, ctx) {
        const exp = cardExp(ctx.secrets && ctx.secrets.card);
        const v = exp ? dateVal(exp, ctx.part) : null;
        if (v) Object.assign(v, { sensitive: true, defaultFormat: 'MM/YY' });
        return v;
      },
    },
    'cc.cvc': {
      label: 'Card security code',
      secret: 'card',
      get: (p, ctx) => {
        const c = ctx.secrets && ctx.secrets.card;
        return c ? val(c.cvc, { sensitive: true }) : null;
      },
    },
    'cc.type': {
      label: 'Card type',
      secret: 'card',
      get: (p, ctx) => {
        const c = ctx.secrets && ctx.secrets.card;
        return c ? val(cardBrand(c.number)) : null;
      },
    },
  };

  function cardBrand(number) {
    const n = String(number || '').replace(/\D/g, '');
    if (/^4/.test(n)) return 'Visa';
    if (/^(5[1-5]|2[2-7])/.test(n)) return 'Mastercard';
    if (/^3[47]/.test(n)) return 'American Express';
    if (/^6(011|5)/.test(n)) return 'Discover';
    if (/^35/.test(n)) return 'JCB';
    if (/^3(0[0-5]|[68])/.test(n)) return 'Diners Club';
    return '';
  }

  /** Types that only make sense on a job application; their presence switches on job context. */
  const JOB_TYPES =
    /^(edu\.|exp\.title|exp\.description|job\.|eeo\.|file\.|links\.(linkedin|github|portfolio)|coverLetter|skills|summary)/;

  /** Types whose value is a date and that may be split into month / year / day boxes. */
  const DATE_TYPES = new Set([
    'edu.start',
    'edu.end',
    'exp.start',
    'exp.end',
    'gen.start',
    'gen.end',
    'dob',
    'job.startDate',
    'cc.exp',
  ]);

  /* -------------------------------------------------------------------- rules */

  // Control kinds produced by the DOM scanner.
  const TEXTISH = ['text', 'email', 'tel', 'url', 'number', 'date', 'month', 'textarea', 'combobox'];
  const CHOICE = ['select', 'radio', 'checkboxes', 'combo', 'combobox'];
  const DEFAULT_KINDS = TEXTISH.concat(CHOICE);
  const LONG_TEXT = ['text', 'textarea'];

  const HONORIFIC = /^(mr|mrs|ms|miss|mx|dr|prof|sir|madam|herr|frau|mme|mlle)\b/;
  function hasHonorificOptions(desc) {
    return (desc.options || []).filter((o) => HONORIFIC.test(U.normalize(o.text))).length >= 2;
  }

  // prettier-ignore
  const NAME_NOT = new RegExp([
    'first', 'last', 'middle', 'sur ?name', 'family', 'given', 'company', 'school', 'employer', 'business', 'organi',
    'user ?name', 'file', 'card', 'account', 'domain', 'reference', 'referr', 'referee', 'manager', 'supervisor',
    'emergency', '\\bpet\\b', 'street', 'city', 'place', 'country', 'state', 'recruiter', 'event', 'project', 'team',
    'nick', 'preferred', 'universit', 'college', 'institution', '\\bjob\\b', 'position', '\\brole\\b', 'product', 'course',
    'degree', 'program', 'display', 'screen', 'host', 'server', 'maiden', 'father', 'mother', 'parent', 'spouse',
    'guardian', '\\bkin\\b', 'contact person', 'signature', 'holder', 'bank', 'club', 'award', 'certif', 'hiring',
    'interviewer', 'employee', 'department', 'title', 'legal entity', 'brand', 'campaign', 'store', 'pronounc',
    'pronunciation', 'phonetic', 'module', 'chinese', 'native', 'local language', 'characters', 'script', 'kanji',
    'katakana', 'cyrillic',
  ].join('|'));

  const R = (type, re, opts) => Object.assign({ type, re }, opts || {});

  const CONSENT =
    /acknowledg|\b(answer|applicant|candidate|application) certification\b|\b(allow|permit|authori[sz]e) (us|[a-z]+) to (process|store|hold|use|retain) (your|my) (personal )?(data|information|details)\b|\bcertification of (answers|application|accuracy)\b|\bi (have )?(read|reviewed|understood)\b|\bi (hereby )?(confirm|agree|accept|consent|certify|attest|declare|understand)\b|\bconsent\b|privacy (notice|policy|statement)|notice at collection|data (protection|privacy|processing) (notice|policy|statement)|terms (and|&) conditions|terms of (use|service)|\bgdpr\b|candidate (privacy|data) (notice|policy)|confidentiality (agreement|undertaking|notice|statement)|non ?disclosure (agreement|undertaking)|maintain (the )?(strict )?confidentiality/;
  const OPT_IN =
    /marketing|newsletter|promotion|(applicant|candidate|talent) (database|pool)|\bsms\b|text messages?|whats ?app|job alerts?|talent (community|network|pool)|future (opportunit|roles?|jobs?|vacanc|positions?|openings?)|other (roles|positions|opportunities|openings)|keep (me|my)|contact me|subscribe|\bupdates\b|share my (data|information|details) with/;

  const NEGATED = /\b(not|don t|do not|does not|decline|disagree|refuse|withdraw|object)\b/;

  /** One statement of an acknowledgement checklist: "I consent to…", never "I do not consent" or an opt-in. */
  function isAcknowledgement(text) {
    const t = U.normalize(text);
    return CONSENT.test(t) && !OPT_IN.test(t) && !NEGATED.test(t);
  }

  /** "US Dollar ($) / Euro (€)" or "Hourly / Monthly / Yearly": the units next to a salary, not the amount. */
  function looksLikeMoneyUnits(options) {
    const opts = (options || []).filter((o) => !JTF.matcher.isPlaceholder(U.normalize(o.text)));
    if (opts.length < 2) return false;
    const unit = (t) =>
      (!/\d/.test(t) &&
        /[$€£¥₹]|\b(dollars?|euros?|pounds?|yen|rupees?|francs?|usd|eur|gbp|chf|currency)\b/i.test(t)) ||
      /^(per )?(hour|hourly|day|daily|week|weekly|month|monthly|year|yearly|annual|annually|annum)$/i.test(t.trim());
    return opts.filter((o) => unit(o.text)).length / opts.length >= 0.6;
  }

  function hasYesNoOptions(desc) {
    const opts = (desc.options || []).filter((o) => !JTF.matcher.isPlaceholder(U.normalize(o.text)));
    return opts.length > 0 && opts.length <= 3 && opts.every((o) => JTF.matcher.canonicalOf(o.text));
  }

  // Expiry dates of passports, visas and licences are not card expiry dates.
  const NOT_ID_DOCUMENT = /passport|visa|permit|licen[cs]e|certif|document|\bid\b/;

  // Order matters only for ties: put specific rules (and long questions that
  // mention other keywords, like "authorized to work in the country…") first.
  const RULES = [
    // Documents
    // "Please attach your cover letter and resume in a single combined document" takes the CV.
    R(
      'file.coverLetter',
      /cover ?letter|motivation(al)? letter|letter of motivation|anschreiben|lettre de motivation/,
      { kinds: ['file'], not: /\b(resume|cv|curriculum|lebenslauf)\b/ },
    ),
    R(
      'file.transcript',
      /transcript|academic record|grade (report|sheet)|mark ?sheet|record of (marks|grades)|notenspiegel|releve de notes/,
      {
        kinds: ['file'],
        not: /\b(resume|cv)\b.*\b(and|&|or)\b.*\btranscript|\bcover ?letter\b/,
      },
    ),
    R('file.resume', /resume|\bcv\b|curriculum|lebenslauf|attach|upload|document|\bfile\b/, {
      kinds: ['file'],
      // "Autofill from resume" / "Apply with resume" read the file and rewrite the form: not the resume upload.
      not: /photo|picture|image|avatar|headshot|transcript|^(?!.*\b(resume|cv)\b).*\b(portfolio|cover)\b|certificat|passport|\bid\b|writing sample|\b(other|additional|supporting|further) (documents?|files?|attachments?|materials?)\b|auto ?fill|automatically fill|apply with (your )?(resume|cv)|pre ?fill|parse/,
      // An "Attach" button whose id or group says "cover letter" is not the resume upload.
      // So is a "Portfolio" upload, unless it also asks for the CV ("Resume / portfolio").
      notAny:
        /^(?!.*\b(resume|cv|curriculum)\b).*(cover ?letter|motivation(al)? letter|letter of motivation|anschreiben|lettre de motivation|\b(portfolio|work samples?)\b|\b(other|additional|supporting|further) (documents?|files?|attachments?|materials?)\b)|transcript|writing sample|headshot|photo|passport/,
    }),

    // Passwords. "Passcode" and "One-time password" are the emailed code, not your password.
    R(
      'otp',
      /\b(one ?time|verification|confirmation|access|auth\w*|e ?mail(ed)?|sms|login|sign ?in) (pass ?)?(code|pin|passcode|password)\b|\bpass ?code\b|\botp\b|\b\d digit (code|pin)\b|\benter (the |your )?(code|pin)\b/,
      {
        kinds: ['text', 'tel', 'number', 'password'],
        not: /promo|coupon|discount|voucher|gift|referral|invit|postal|zip|area code|country|card|cvv|cvc|tax/,
      },
    ),
    R(
      'account.passwordConfirm',
      /confirm|re ?enter|re ?type|repeat|again|verify|verification|password ?(2|two)|pass ?2|wiederholen|confirmation/,
      { kinds: ['password'] },
    ),
    R('account.password', /pass|pwd|kennwort|contrase|mot de passe|\bpin\b|secret/, { kinds: ['password'] }),

    // Payment cards
    R(
      'cc.name',
      /card ?holder|name on (the |your )?card|(card|cc) ?(owner|name)|name (as it )?(appears )?on (your )?card|karteninhaber|titular de la tarjeta|nom du titulaire/,
      { not: /green card|permanent resident/ },
    ),
    R(
      'cc.exp',
      /(exp|expir\w*|valid|card|cc)\b.*\b(month|mm)\b|\b(month|mm)\b.*\b(exp|expir\w*)\b|\b(cc|card)month\b/,
      { part: 'month', not: NOT_ID_DOCUMENT },
    ),
    R(
      'cc.exp',
      /(exp|expir\w*|valid|card|cc)\b.*\b(year|yy|yyyy)\b|\b(year|yy|yyyy)\b.*\b(exp|expir\w*)\b|\b(cc|card)year\b/,
      { part: 'year', not: NOT_ID_DOCUMENT },
    ),
    R(
      'cc.exp',
      /expir|\bexp ?date|\bexp\b|valid (thru|through|until)|\bmm ?yy\b|gueltig|gultig|ablaufdatum|vencimiento|date d expiration|scadenza/,
      { not: NOT_ID_DOCUMENT },
    ),
    R(
      'cc.cvc',
      /\b(cvv2?|cvc2?|csc|cvn|cvd|ccv)\b|security ?code|card ?(security|verification) ?(code|number|value)?|card code|verification (number|value)|\bcid\b/,
      { not: /postal|zip|promo|coupon|gift|discount/ },
    ),
    R(
      'cc.number',
      /(card|cc|kreditkarten|tarjeta|carte) ?(number|no|num|nummer|numero)|credit ?card|debit ?card|card ?#|\bccnum|\bcard$/,
      // An identity card (HKID), student or membership card is not a payment card.
      {
        not: /type|name|holder|expir|exp date|cvv|cvc|security|zip|postal|brand|phone|gift|identity|\bid\b|hkid|national|passport|student|membership|loyalty|library|insurance|health/,
      },
    ),
    R('cc.type', /card ?(type|brand|network)|type of card/, { kinds: CHOICE }),

    // Screening questions (long sentences that mention other keywords)
    // "This role requires SC clearance…", "Are you eligible to obtain / willing to undergo a security clearance?"
    R(
      'job.clearanceEligible',
      /\b(eligib\w*|able|willing|prepared|happy|agree)\b.*\b(obtain|hold|undergo|apply for|get|gain|be granted|achieve|pass|go through|complete)\b.*\b(clearance|vetting)\b|\b(clearance|vetting)\b.*\b(eligib\w*|willing|able to obtain)\b|\b(requires?|required|subject to|need to (obtain|pass|hold))\b.*\b(security )?(clearance|vetting)\b/,
      { kinds: CHOICE.concat(['text']) },
    ),
    // "Do you currently hold an active security clearance?", "Clearance level".
    R(
      'job.clearance',
      /\b(do|does|have|are) you (currently )?(hold|have|possess|been granted)\b.*\bclearance\b|\bclearance (level|status|held)\b|\b(current|active|existing) (security )?clearance\b|\bwhat (level of |type of )?(security )?clearance\b|^(security )?clearance$|\bnational security vetting\b/,
      { not: /\b(eligib|willing|prepared|obtain|undergo)/ },
    ),
    R(
      'job.authorized',
      /without (the )?(need for |requiring |needing |requirement of |any )?(employer |visa |company |immigration )?sponsor/,
    ),
    R(
      'job.sponsorship',
      /sponsor|visa (status|support|required|transfer|requirement)|\bh ?1 ?b\b|immigration (support|sponsorship|assistance)|require (a )?(work )?visa|\b(require|need)\b.{0,30}\b(work )?authori[sz]ation\b/,
      {
        not: /adjustments?\b|accommodat/,
        // "Do you have the right to work in the region? … Sponsorship is not available" and "This position does not
        // support visa sponsorship. Do you currently have the right to work in the UK?" ask for your right to work.
        test: (desc, hit) =>
          !/(^|\b(sponsor\w*|capacity|basis|available|offered|provided|possible) )(do|are) you (currently )?(have|hold|legally|lawfully)? ?(the )?(legal |permanent |full )?(right to work|authori[sz]ed|eligible|permitted|entitled)\b/.test(
            hit,
          ),
      },
    ),
    R(
      'job.authorized',
      /\b(authori[sz]ed|eligible|entitled|permitted|allowed) to (lawfully |legally )?work|work (authori[sz]ation|permit|eligibility)|employment (authori[sz]ation|eligibility)|eligib(le|ility) (for|to) (employment|work)|authori[sz]ation to work|right to work|legal right to|legally (work|employed)/,
      // "Will you in the future require authorization to work in the US?" asks whether you need sponsoring.
      { not: /\b(require|need)\b.{0,30}\b(work )?authori[sz]ation\b/ },
    ),
    // "Are you able to work in the UK?" is about permission; "able to work on-site 5 days a week" is not.
    R('job.authorized', /\bable to (lawfully |legally )?work\b/, {
      not: /\bon ?site\b|in (the |our )?office|in person|days (a|per) week|\bcommute|\bhybrid\b|\bshifts?\b|weekends?|overtime|consecutive|full ?time for/,
    }),
    R(
      'job.locations',
      /\blocations?\b.*\b(interested|prefer|willing|open to|relocat|consider|like to work|want to work)|\b(preferred|desired|target|ideal) (work |office |job |internship |role )?(locations?|offices?|cities)|\bwhich (other )?(offices?|locations?|cities)\b|\b(office|location|city) preferences?\b|where would you (like|prefer|want) to (work|be based)|\brelocat\w* (where|which (cities|locations|offices))\b|^where\b.*\brelocat/,
    ),
    R('job.relocate', /relocat/, { not: /adjustments?\b|accommodat/ }),
    R(
      'job.over18',
      /\b(18|eighteen)\b.*\b(years|older|age)\b|\b(at least|over|above|older than) (the age of )?(18|eighteen)\b|legal (working )?age|age of majority/,
    ),
    R(
      'job.referralSource',
      /how did you (hear|find|learn|come across|discover|get to know|connect with)|where did you (hear|find|learn|see|discover|come across)|hear(d)? about (us|this|the)|learn(ed)? about (us|this|the)|source of (application|referral|hire|candidate)|referral source|^source$|how were you referred|found (us|this|the job)/,
    ),
    R(
      'job.salary',
      /salary|salari(al|ale|ales|o)\b|\bgehalt|\bpretentions?\b|\bstipendio\b|\bretribuzione\b|compensation|pay (expectation|range|requirement)|desired (pay|rate|wage)|expected (pay|wage|rate|ctc)|\b(current|present|desired) ctc\b|^ctc$|remuneration|\bwage\b|rate expectation|hourly rate|base pay/,
      {
        // The currency and pay-period pickers next to the amount ("salaryCurrency", "Desired Salary Type").
        not: /currenc|\bperiod\b|frequency|\b(salary|pay) (type|basis|unit)\b/,
        test: (desc) => !looksLikeMoneyUnits(desc.options),
      },
    ),
    R(
      'job.nonCompete',
      /non ?compete|non ?solicit|restrictive (covenant|agreement|clause)|garden leave|\bagreements? with (any )?(prior|previous|former|current|past) employers?\b|\b(may |might |could |that )?restrict (your|my) ability to (work|join)\b/,
    ),
    R(
      'job.noticePeriod',
      /notice ?period|notice (required|do you need)|how much notice|weeks notice|kundigungsfrist|\bpreavis\b|\bpreavviso\b/,
    ),
    R(
      'job.otherOffers',
      /\b(other|competing|outstanding|existing|pending) (job |internship |employment )?offers?\b|\boffers? (from|at|with) (other|another|any other) (firms?|compan|employers?|organi)|\boffers? (and|or|&) deadlines?|\bdeadlines? (we|that we) should\b|\bany (other )?(offers|deadlines)\b|\bexploding offer|\b(upcoming|pending|current|any) (offer )?deadlines?\b|\boffer deadlines?\b|\bdecision (deadlines?|timelines?)\b|\baccepted an? (\w+ ){0,3}offer\b|\b(holding|hold) any (\w+ )?offers?\b/,
      { not: /\bif (yes|so)\b|\bwhich (firm|company)\b|\bwhat (firm|company)\b/ },
    ),
    // "Have you applied to Marshall Wace before?"
    R(
      'compliance.previouslyApplied',
      /\b(previously|ever|already) applied\b|\bapplied (to|for|with|at)\b.{0,60}\b(before|previously|in the past|last year|this year)\b|\bhave you applied (to|for|with)\b/,
      { kinds: CHOICE.concat(LONG_TEXT), not: /\bif (yes|so)\b|\bwhen and\b/ },
    ),
    // "Do you require any reasonable adjustments to participate in the recruitment process?"
    R(
      'job.adjustments',
      /\breasonable adjustments?\b|\b(require|need|request)\b.{0,40}\b(adjustments?|accommodations?|support)\b.{0,60}\b(recruitment|application|interview|assessment|selection|hiring)\b|\badjustments? (to|during|in|for) (the |our )?(recruitment|application|interview|assessment|selection)/,
      {
        kinds: CHOICE,
        not: /essential functions|housing|\bif (yes|so)\b|please (provide|give|tell)/,
      },
    ),
    // "Are you willing to work in the office 5 days a week?" (where it is is the AI's to weigh up)
    R(
      'job.onsite',
      /\b(\d|two|three|four|five) days (a|per|each) week\b|\bfully in ?person\b|\bin (the )?office (full ?time|every day|daily)\b|\b(willing|able|happy|comfortable|open) to (work|be) (on ?site|onsite|in (the |our )?office|in person)\b|\bhybrid (work(ing)? )?(model|policy|arrangement)\b/,
      // An office somewhere in particular ("at our Jupiter, FL office", "onsite in San Francisco") depends on where
      // you live: left for the AI, which weighs it against your location and relocation answer.
      {
        kinds: CHOICE,
        not: /\bcommut|\bremote(ly)? only\b|\b(at|in) (our|the) (?!office\b|offices\b)[a-z]+( [a-z]+){0,2} (office|offices|headquarters|hq|campus|location)\b|\bon ?site (in|at) (?!(the|our) office\b)[a-z]/,
      },
    ),
    R(
      'job.startDate',
      /when (can|could|would) you (like to |be able to )?(start|begin|join)|when (are|will) you (be )?(able|available) to (start|begin|join)|available (start|to start|to begin|from)|\bavailability\b|earliest (possible )?(start|date)|date (you are )?available|(desired|preferred) start|expected start|join(ing)? date|how soon|start (date|dates) (for|of) (the|this|your) (internship|placement|programme|program|role|position|job)|\bdate (that )?you (could|can|would|will) (start|begin|join)\b|\b(ready|available) for (full ?time )?(employment|work)\b|\beintritt\w*|\bdisponibilit[ea]\b|\bdate de debut\b|\b(will|would|could|can) be (able|available) to (start|begin|commence|join)\b|\b(what|which) date\b.*\bavailab|\bwhen (are|will|would) you (be )?available\b/,
    ),
    // "The internship runs from 1 July to 30 September 2027. Can you confirm that you are available…?"
    R(
      'job.startDate',
      new RegExp(`\\bfrom (\\d{1,2}(st|nd|rd|th)? )?(${MONTH_RE})\\b.*\\b(to|until|till|through)\\b.*\\bavailab`),
    ),
    R(
      'job.yearsExperience',
      /years (of )?(relevant |professional |total |work |industry )?experience|how many years|experience in years|total experience|\byrs\b/,
    ),
    R(
      'job.currentCompany',
      /current (company|employer|organi[sz]ation|workplace)|\b(which|what) (company|firm|organi[sz]ation|employer)\b.*\b(do you|you) (currently )?work (for|at)\b|present (company|employer)|most recent (company|employer)|^org$|latest employer|\b(employer|company|organi[sz]ation) (or (employer|company|organi[sz]ation) )?of your (most recent|current|latest)\b/,
    ),
    R(
      'job.currentTitle',
      /current (job )?(title|position|role|designation|occupation)|present (title|position|role)|most recent (job )?(title|position|role)|^headline$|professional headline|\b(title|position) of your (most recent|current|latest)\b/,
    ),

    // Acknowledgements ("I have read the privacy notice", "Acknowledge/Confirm"), never marketing opt-ins
    // A dropdown or Yes/No question can be an acknowledgement too ("…take a look at our privacy notice and confirm").
    // "I confirm that I will graduate in 2027" is a question about your date, answered from it.
    // A group of statements to tick ("you consent to our Applicant Privacy Statement" + "…to background checks")
    // too. Never an opt-in, even when only the name says "consent" (Ashby's SMS "communicationConsent").
    R('consent', CONSENT, {
      kinds: ['checkbox', 'checkboxes', 'select', 'combo', 'combobox', 'radio'],
      not: OPT_IN,
      notAny: OPT_IN,
      yieldsTo: ['edu.end'],
    }),
    // "I'm not a robot" as a plain <input type="checkbox">. A CAPTCHA widget's own box (role="checkbox" inside
    // reCAPTCHA's frame) is never one: those are left for you.
    R(
      'human',
      /\b(i m |i am )?not a (ro ?bot|bot)\b|\bi am (a )?human\b|\b(confirm|verify|prove) (that )?(you are|you re|i am|i m) (a )?human\b|\bhuman verification\b/,
      { kinds: ['checkbox'], test: (desc) => desc.inputType === 'checkbox' },
    ),

    // Conflicts of interest: government officials / PEPs (you, your family), relatives here, worked here before.
    // EEO notices ("Government officials engaged in enforcing laws…") are not questions.
    R(
      'compliance.government',
      /\bgovernment (official|employee|position|role|connection|body|agency|department|entity|minister)s?\b|\bpublic (official|office|servant)s?\b|\bpolitically exposed|\bpeps?\b|\bstate ?owned (entit|enterprise|compan|business)|\bforeign (government )?official|\bcivil servant|\binvolved (in|with) (the )?(government|politics)\b|\b(public|political|government) (office|position|appointment)s?\b|\bpublic (function|trust|role|post)s?\b|\bprominent public\b|\bsenior political figure/,
      {
        kinds: CHOICE.concat(LONG_TEXT),
        not: /\bengaged in enforcing\b|\benforcing (the )?laws?\b|\bequal (employment|opportunity)\b|\bfederal contractor|\bgovernment (contracts?|contractors?|funding|grants?)\b|\bvisa\b|\bsponsor/,
      },
    ),
    // Not about the company's auditors ("…employed by Ernst & Young, that engages in audit work?").
    R(
      'compliance.relatives',
      /\b(related to|relatives?|family members?|immediate family|spouse|domestic partner|close (personal )?relationship)\b.*\b(work|works|working|worked|employ|employed|employee|employees|staff)\b|\b(know|related to) any ?one (who )?(currently )?(works?|working|employed|at)\b/,
      {
        kinds: CHOICE.concat(LONG_TEXT),
        not: /government|public official|politically|referr|refer you|emergency|\b(ernst|ey|deloitte|pwc|pricewaterhouse\w*|kpmg|auditors?|audit)\b/,
      },
    ),
    R(
      'compliance.previouslyEmployed',
      /\b(previously|ever|formerly|before|in the past) (been )?(worked|employed|work|been employed|interned)\b.*\b(for|at|by|with)\b|\b(current or former|former|ex) (employee|staff member|intern)\b|\bhave you (ever )?worked (for|at|with) (us|our)\b|\bworked (for|at) [a-z ]+ (before|previously|in the past)\b/,
      {
        kinds: CHOICE.concat(LONG_TEXT),
        not: /\bapplied\b|\binterview|\brelated|famil|relative|\bin (finance|banking|consulting|the industry|a similar)|\b(ernst|ey|deloitte|pwc|pricewaterhouse\w*|kpmg|auditors?|audit)\b/,
      },
    ),

    // Voluntary self-identification
    // Sexual orientation, gender identity vs sex at birth, LGBTQ+, religion, neurodiversity.
    R('eeo.sexualOrientation', /\bsexual orientation\b|\bsexuality\b|\borientation\b/, { kinds: CHOICE }),
    R(
      'eeo.genderIdentitySame',
      /\b(same as|match(es)?|differ\w* from)\b.*\b(sex|gender)\b.*\b(registered|assigned|recorded) at birth\b|\b(registered|assigned) at birth\b|\bidentify as trans(gender)?\b|\bare you trans(gender)?\b|\btrans (history|experience)\b/,
      { kinds: CHOICE },
    ),
    R('eeo.lgbt', /\blgbt|\blgbq|\bidentify as (part of the )?(queer|lgb)/, { kinds: CHOICE }),
    R('eeo.religion', /\breligio|\bfaith\b|\bbelief\b/, { kinds: CHOICE }),
    R(
      'eeo.neurodivergent',
      /\bneuro ?(divergen|diverse|diversity|atypical)|\bneurodivergent\b|\bdyslexi|\badhd\b|\bautis|\bdyspraxi/,
      // "Do you have a disability or long-term health condition including … neurodiversity?" is the disability one.
      { kinds: CHOICE, not: /\bdisabilit|long ?term (health )?condition|\bimpairment/ },
    ),
    R('eeo.hispanic', /hispanic|latin[oax]\b/, { kinds: CHOICE }),
    R('eeo.race', /\brace\b|ethnic/, { kinds: CHOICE }),
    R('eeo.veteran', /veteran|military (service|status)|armed forces|served in the/, { kinds: CHOICE }),
    R('eeo.disability', /disabilit|disabled|handicap|impairment/, { kinds: CHOICE, not: /adjustments?\b|accommodat/ }),
    R('eeo.gender', /\bgender\b|\bsex\b|geschlecht|\bgenre\b|\bsexo\b/, {
      not: /orientation|transgender|same as|(registered|assigned) at birth|\bpronouns?\b/,
    }),
    // UK social-mobility monitoring
    // "Were you eligible for free school meals?", "…receive FSM", pupil premium, the US free or reduced-price lunch.
    R(
      'eeo.freeSchoolMeals',
      /free school (meals?|lunch(es)?)|\bfsm\b|pupil premium|free (or|and|\/) reduced( price| cost)? (school )?(lunch|meals?)|reduced (price )?(school )?lunch/,
      { kinds: CHOICE },
    ),
    R('eeo.postcodeAt14', /\bpost ?code\b.*\b(14|fourteen)\b|\b(14|fourteen)\b.*\bpost ?code\b/, { kinds: TEXTISH }),
    R(
      'eeo.careLeaver',
      /\bcare leaver\b|\b(been|grew up|lived|were you|spent time|time) in (local authority |foster |residential |social )?care\b|\blooked after (child|young person|by (a|the) local authority)|\bfoster(ed)? care\b|\blocal authority care\b|\bin the care system\b/,
      { kinds: CHOICE },
    ),
    R(
      'eeo.carer',
      /\b(young |unpaid |primary |family )?carer\b|\bcaring responsibilit|\bcare for (a|an|someone) (family member|relative|friend|disabled|ill|elderly)|\blook after (a|an|someone) (family member|relative|disabled|ill|elderly)/,
      { kinds: CHOICE },
    ),
    // A refugee diversity question, never the refugee / asylee lines of a work-authorisation list.
    R(
      'eeo.refugee',
      /\b(are|were) you (a |an )?(refugee|asylum seeker)|\brefugee (or|and|\/) asylum|\basylum seeker\b|\brefugee (status|background|experience)\b|\bcame to the uk as a refugee\b/,
      {
        kinds: CHOICE,
        not: /\bu ?s ?c\b|\b115[78]\b|\basylee\b|work authori|employment eligib|eligib\w* to work|lawful(ly)? permanent|green card|export|\bvisa\b|citizen/,
      },
    ),
    R(
      'eeo.bursary',
      /\bbursar(y|ies)\b|\bmaintenance (grant|loan)s?\b|\bmeans ?tested (grant|support|bursary|funding|financial)|\bfinancial (support|aid) (from|at) (your )?universit/,
      { kinds: CHOICE, not: /independent|fee paying|private school|school type|type of school|\bschool you\b/ },
    ),
    R(
      'eeo.schoolType',
      /\b(type|kind) of school\b|\bschool type\b|\bschool did you (mainly )?attend\b|\bstate (school|run|funded)\b.*\b(independent|private|fee)|\bfee paying\b/,
      { kinds: CHOICE },
    ),
    R(
      'eeo.parentsDegree',
      /\bparents?\b.*\b(universit|degree|higher education|college|qualification)|\bguardians?\b.*\b(universit|degree|higher education|qualification)|\bfirst (person )?in (your|my) (immediate )?family\b.*\b(universit|college|higher education|degree)|\b(universit|college|higher education)\w*\b.*\bfirst (person )?(in|of) (your|my) (immediate )?family\b|\bfirst generation (student|university|college)|\b(qualifications?|degree|universit\w*|education)\b.*\b(parents?|guardians?)\b/,
      { kinds: CHOICE },
    ),
    R(
      'eeo.parentOccupation',
      /\b(main|highest) (household )?(income )?earner\b|\bhousehold earner\b|\boccupation of your (main )?(parent|household)|\bparents?\b.*\b(occupation|job)\b|\b(aged?|when you were) (about )?14\b/,
      { kinds: CHOICE },
    ),
    R('pronouns', /\bpronouns?\b/), // not "how your name is pronounced"
    R(
      'dob',
      /birth ?(date|day)|date of birth|\bdob\b|\bbday\b|birthday|geburtsdatum|fecha de nacimiento|date de naissance|data di nascita/,
      { not: /place|city|country|town/ },
    ),
    R(
      'age',
      /^(your |current )?age\b(?! of)|\bwhat is your (current )?age\b|\bhow old are you\b|\bage (range|group|bracket|band)\b/,
      {
        not: /\b(18|eighteen|16|21)\b|\bover\b|at least|older|minimum|legal/,
      },
    ),

    // Links (before names and websites)
    R('links.linkedin', /linked ?in/),
    R('links.github', /git ?hub/),
    R('links.twitter', /twitter|\bx com\b|\bx (handle|profile|username)\b/),
    R('links.portfolio', /portfolio|dribbble|behance|work samples?/, {
      not: /portfolio (compan|firms?|businesses|manag|construct|optimi|investment)/,
    }),
    R(
      'links.website',
      /web ?site|web ?page|personal (site|page|url|link|blog)|home ?page|\bblog\b|\burls?\b|\blinks?\b|online (profile|presence)|other (website|link|url|profile)/,
      {
        not: /linked ?in|git ?hub|twitter|company|employer|referr/,
      },
    ),

    // Education
    R(
      'edu.level',
      /highest (level of )?(completed |finished |attained )?(education|degree|qualification|academic)|education(al)? (level|attainment|background|qualification)|level of (education|study|degree)/,
      { not: /fields? of study|\bsubjects?\b|\bmajors?\b|\bdisciplines?\b|\bparents?\b|guardian|mother|father/ },
    ),
    R(
      'edu.end',
      /\bgraduat(ion|ed|e|ing)\b|expected graduation|completion (date|year)|year of (graduation|completion|passing)|class of|passing year|year (graduated|completed)|\b(course|degree|studies|programme|program) (finish|end|complete)s?\b|\b(finish|finishing|complete|completing|end|ending) (your |my |the )?(university |college |undergraduate |current |academic )?(course|degree|studies|programme|program)\b|\bend (date |year )?of (your |the )?(course|degree|studies)\b|\bleav(e|ing) (academia|university|full time education)\b/,
      {
        // "undergraduate" no longer matches (\b), so "graduation year (undergraduate degrees…)" is still a date
        not: /^(did|have) you|^are you (a |an )?(recent |new )?(graduate|grad|undergrad)|\binterested in\b|\bopportunit|post ?grad|\bgraduate (degree|school|program|student)|high school|secondary school|sixth form|a levels?\b|\bgpa\b|\bgrades?\b/,
      },
    ),
    R(
      'edu.enrolled',
      /\benrol+(ment|ed) status\b|\b(are|were) you (currently )?(enrol+ed|a (current )?student)\b|\bcurrent(ly)? (enrol+ed|study status|student status)\b|\b(study|student) status\b/,
      {
        kinds: CHOICE.concat(['textarea']),
        not: /graduat|\byear\b|\bdegree subject\b|\bmajor\b|\b(which|what|name of (the|your)) (university|school|college|institution)\b/,
      },
    ),
    R(
      'edu.year',
      /\b(current |academic )?year of (study|studies|university|uni|college|degree|course|your (degree|course|studies|programme|program))\b|\b(what|which) year (of (your )?(study|studies|university|uni|degree|course|programme|program) )?are you (currently )?in\b|\bstudy year\b|\bcurrent year\b.*\b(study|studies|university|degree|course)\b|\byear in (school|university|college)\b|\bclass standing\b|\bacademic standing\b/,
      {
        not: /graduat|\bstart|\bbegan|\bbegin|\bcomplet|\bfinish|\bentry|\bentered|high school|secondary|a levels?\b|gcse/,
      },
    ),
    // "Which university are you enrolled in, or from which institution did you receive your most recent degree?"
    R(
      'edu.school',
      /^(which|what) (university|school|college|institution)\b|^name of (the |your )?(university|college)\b/,
      {
        not: /\b(university|college) degree\b|\bschool (type|diploma|grades?|did you attend)\b|type of school|\bgraduat\w* (year|date)|\byear\b|\bgpa\b|\bcity\b|\bcountry\b|\blocation\b/,
      },
    ),
    R(
      'edu.school',
      /\bschool\b|universit|college|institut(e|ion)|alma mater|academy|hochschule|\becole\b|universidad/,
      {
        not: /high school (diploma|graduate|completion)|degree|major|minor|gpa|\byear\b|\bdates?\b|\bstart|\bend\b|graduat|\blocation\b|\bcity\b|(?<!\b(please|kindly) )\bstate\b|country|^(did|have|has|are|do|does|were|was|will|would|can|is) you\b|e ?mail|address|transcript|meals|type of school|school type|kind of school|fee paying|state school|grammar school|grading|\bscale\b/,
      },
    ),
    // "What degree are you currently pursuing?" asks for a degree; "Are you pursuing a degree?" is yes/no.
    R(
      'edu.degree',
      /\b(what|which) (type of |kind of )?degree\b|\b(type|kind|name) of (the |your )?degree\b|\bdegree (type|name|title|program(me)?)\b|\bdegree (are you|you are|you re|will you be) (currently )?(pursuing|studying|completing|enrolled|working|seeking|undertaking|earning|obtaining)/,
      {
        not: /major|field|subject|discipline|\byear\b|\bdate\b|minimum|equivalent/,
        test: (desc) => !hasYesNoOptions(desc),
      },
    ),
    R('edu.degree', /\bdegree\b|qualification|diploma|\baward\b/, {
      not: /major|field|subject|discipline|\byear\b|\bdate\b|level of|highest|degree of|\bdid you|have you|do you|are you|minimum|equivalent|\bclass\b|classification|\bgpa\b|\bgrades?\b|\bscore\b/,
      test: (desc) => !hasYesNoOptions(desc),
    }),
    R(
      'edu.field',
      /fields? of study|\bmajors?\b|\bdisciplines?\b|concentration|area of study|speciali[sz]ation|course of study|program(me)? of study|\bsubjects?\b|study (field|area)|^(your |main |academic )?field$|\bfield (studied|of expertise)\b|course name/,
      {
        not: /minor|\bdid\b|field (sales|service|work|engineer|marketing|operations)|form ?field|field ?(set|label|wrapper|group|container|row|section|input)|\bsubjects? to\b|export control/,
      },
    ),
    R(
      'edu.gpa',
      /\bgpa\b|grade point|\bcgpa\b|cumulative (grade|average)|grade average|\bgrades?\b|degree classification|class of degree|\bdegree class\b|\bclassification\b|\bhonou?rs\b/,
      // "Number of GCSEs at grade 9-7" is a count, not your grade.
      {
        not: /test score|credit score|maximum|max possible|highest possible|grading scale|scale used|\bnumber of\b|\bhow many\b/,
      },
    ),

    // Names
    R('name.prefix', /salutation|honorific|\bprefix\b|anrede|civilit|\btitle\b/, {
      // "Title (e.g. Mr, Mrs, Ms)" in a text box too.
      test: (desc, text) =>
        hasHonorificOptions(desc) || /salutation|honorific|prefix|anrede|civilit|\b(mr|mrs|ms|miss|mx)\b/.test(text),
    }),
    R(
      'name.preferred',
      /\bpreferred (first |given |full |legal |short )?(name|forename)|\bpref(erred)? name|nick ?name|\bgoes by\b|\bgo by\b|\bknown as\b|\bchosen (first |full )?name|\bname you (go by|prefer|are known by|use|would like|like to (be called|go by))|\b(what|how) (should|do|can|may) (we|i) call you|\bcall you\b|\b(display|screen|short|common|informal|alias) name\b|\balias\b|\benglish (first |given |full )?name\b|\bspitzname|\brufname|\bbevorzugter (vor)?name|\bnom (d usage|usuel)|\bprenom usuel|\bsurnom\b|\bapodo\b|\bnombre (preferido|social)|\bsoprannome\b|\bnome (preferito|social)/,
      {
        not: /user ?name|company|employer|school|business|card|organi|contact|\breferences?\b|\breferr|emergency|manager|screen ?name ?(on|in)/,
      },
    ),
    R(
      'name.first',
      /\bfirst ?name|\bgiven ?names?\b|\bforenames?\b|\bfname\b|\bfirst$|^first\b(?! (time|choice|language|line|day|week|month|year|job))|\bvorname|\bprenom|\bnombre\b|\bnome\b/,
      {
        // "Prénom et nom" / "Vor- und Nachname" / "Nombre y apellidos" is the whole name.
        not: /last|sur ?name|family|middle|company|school|business|card|preferred|nick|employer|organi|user|father|mother|spouse|emergency|reference|referr|manager|contact person|\bnom\b|nachname|apellido|cognome/,
      },
    ),
    R('name.middle', /\bmiddle ?(name|initial)s?\b|\bmname\b|^mi$|\bmiddle$|second (given )?name|segundo nombre/, {
      not: /last|family/,
    }),
    R(
      'name.last',
      /\blast ?name|\bsur ?names?\b|\bfamily ?names?\b|\blname\b|\blast$|^last\b(?! (time|day|week|month|year|job|employer|position|company))|\bnachname|\bapellidos?\b|\bnom de famille|\bcognome\b|^nom$/,
      {
        not: /first|company|school|card|preferred|employer|father|mother|spouse|emergency|reference|referr|manager|maiden|previous|former|other|\bvor(name)? (und|&) nachname|\bnombre y apellido|\bprenom (et|&) nom\b|\bnom (et|&) prenom|\bnome (e|&) cognome/,
      },
    ),
    R('name.full', /\b(first|given) (name )?(and|&|\/) (last|sur|family) ?names?\b|\bfull legal name\b/),
    R(
      'name.full',
      /\bfull ?name|\byour name\b|\blegal name\b|\bname\b|\bnom complet|\bnombre completo|\bvoller name|\bvor(name)? (und|&) nachname|\bnombre y apellido|\bprenom (et|&) nom\b|\bnom (et|&) prenom|\bnome (e|&) cognome/,
      {
        not: NAME_NOT,
        yieldsTo: ['name.first', 'name.last', 'name.middle', 'name.preferred'],
      },
    ),

    // Contact
    R('email', /e ?mail|courriel|correo|\bmail\b/, {
      not: /referr|reference|recruiter|manager|supervisor|emergency|friend|hiring|newsletter|marketing|subscribe/,
    }),
    R(
      'account.username',
      /user ?(name|id)|\blogin\b|log in (id|name)|sign in (id|name)|\buid\b|account (name|id)|member (id|name)|benutzername/,
      {
        not: /e ?mail|twitter|git ?hub|linked ?in|instagram|telegram|skype|discord|slack|handle/,
      },
    ),
    R('phone.type', /phone ?(device )?type|type of (phone|number)|device type|phone ?kind|number type/, {
      kinds: CHOICE,
    }),
    R(
      'phone.countryCode',
      // SuccessFactors: "Country/Region Code:" next to "Phone Number:".
      /country ?(phone )?(calling )?code|\bcountr(y|ies) (or |and )?(region|territory) (phone |calling |dial(l)?(ing)? )?code\b|dial(l)?(ing)? ?code|calling ?code|phone.*country|country.*phone|\bisd\b|(phone|tel|mobile) ?prefix|country ?prefix|international code|\bindicatif\b|\b(lander)?vorwahl\b|\bprefijo\b|\bprefisso\b/,
      // "Mobile number (including country code)" is the whole number.
      {
        not: /\b(start|begin)s? with|\b(including|include|incl|with|plus|then|followed by) (the |your |a )?(country|dial(l)?ing|international) code\b/,
      },
    ),
    R(
      'phone',
      /phone|mobile|\bmobil(nummer|telefon)?\b|\bcell\b|cellular|telephone|\btel\b|contact (number|no)|telefon|telefono|\bportable\b|\bhandy\b|whats ?app|\bmob\b/,
      {
        // "…start with a + and then the country code" is help for the whole number.
        not: /type|\bext\b|extension|(?<!\b(including|include|incl|with|plus|then|the|your|a|by) )\bcountry\b|(?<!\bcountry )\bcode\b|fax|device|prefix|emergency|referr|reference|manager|supervisor|employer|company|business|organi[sz]ation|\bsms\b|text messag|consent/,
        yieldsTo: ['phone.countryCode', 'phone.type'],
      },
    ),

    // Address
    R(
      'address.line2',
      /address ?(line)? ?(2|two|ii)\b|\baddr(ess)? ?2\b|street ?(address)? ?2|\bapt\b|apartment|\bsuite\b|\bunit\b|\bbuilding\b|\bfloor\b|\bflat\b|address ?(complement|additional|cont)|complemento|adresszusatz/,
      {
        not: /line ?(1|one)|business unit/,
        kinds: TEXTISH,
        // "Which Building Services modules have you completed?" is not a flat number; "a full suite of services" is
        // not a suite.
        test: (desc, hit) => {
          const words = hit.split(' ').length;
          return (
            /\baddress\b|\baddr\b/.test(hit) ||
            words <= 5 ||
            (words <= 8 && /\bapt\b|apartment|suite|complement/.test(hit))
          );
        },
      },
    ),
    R(
      'address.line1',
      /address ?(line)? ?(1|one|i)\b|\baddr(ess)? ?1\b|\bstreet\b|\baddress\b|\baddr\b|strasse|straße|hausnummer|direccion|\badresse\b|indirizzo|\bmorada\b|house ?(number|name|no)/,
      {
        not: /e ?mail|\bip\b|\bweb\b|\burl\b|line ?(2|two|3|three)|\bcity\b|\bstate\b|zip|postal|country|same as|wallet|mac address|crypto/,
        kinds: TEXTISH,
        yieldsTo: ['address.line2', 'address.city', 'address.postalCode', 'exp.location'],
      },
    ),
    R(
      'location',
      /\blocation\b|city ?(and|&)? ?(state|country)|where are you (currently )?(based|located|living)|current (city|location|residence)|based in|place of residence|city of residence|where do you live|^residence$/,
      {
        not: /preferred|desired|willing|relocat|office|prefer|which location|work location|job location|interested|position location|hope|want|open to|employer|company|organi[sz]ation/,
      },
    ),
    R(
      'address.city',
      /\bcity\b|\btown\b|\bsuburb\b|\blocality\b|\bort\b|\bstadt\b|\bciudad\b|\bville\b|\bcitta\b|municipality|\bwohnort\b|address level 2/,
      { not: /\bstate\b|zip|postal|birth|employer|company|organi[sz]ation/ },
    ),
    R(
      'address.state',
      /\bstate\b|\bprovince\b|\bregion\b|\bcounty\b|\bterritory\b|prefecture|bundesland|\bestado\b|\bprovincia\b|address level 1/,
      {
        // "Country/Region of Residence" and "Country / Territory" are countries (Workday's "countryRegion" id is not).
        not: /united states|marital|\b(please|you|to) state\b|\bstate (your|which|whether|if|why|how|what|the|any)\b|(?<!\bsection )\bcountr(y|ies) (or |and )?(region|territory|area)\b|\b(region|territory) (or |and )?countr(y|ies)\b/,
        yieldsTo: ['exp.location'], // "Employer Location (City, State, Zip)"
      },
    ),
    R(
      'address.postalCode',
      /\bzip\b|zip ?code|\bzipcode|postal|post ?code|postcode|\bpin ?code\b|\bplz\b|postleitzahl|codigo postal|code postal|\bcap\b|\bcep\b/,
      { yieldsTo: ['exp.location'] },
    ),
    R('citizen', /^(are|is) you (a |an )?(\w+ ){0,3}(citizen|national)s?\b/, {
      kinds: ['select', 'radio', 'combo', 'combobox'],
      not: /\b(dual|other|another|any other|former|previous)\b/,
    }),
    R(
      'nationality',
      /nationality|citizenship|citizen of|country of (citizenship|nationality)|staatsangehorigkeit|nacionalidad|\bnationalite\b|\bnazionalita\b/,
      { not: /other (countr|nationalit|citizenship)|\bdual\b|previous|\bformer|second (nationality|citizenship)/ },
    ),
    R('address.country', /\bcountr(y|ies)\b|\bnation\b|\bland\b|\bpais\b|\bpays\b/, {
      not: /code|phone|dial|calling|(?<!\bcountr(y|ies) (or |and )?)\bregion\b|citizen|nationality|birth|issu|passport|origin|visa|other than|which countries|\btax\b/,
    }),

    // Work experience (gen.* become edu.* / exp.* from the surrounding section)
    R(
      'exp.current',
      /currently (work|employed|working)|current(ly)? (job|role|position|employer)|i (currently )?work here|\bpresent\b|still (work|employed)|\bongoing\b|current$/,
      { kinds: ['checkbox'] },
    ),
    // "Is this your current employer?" (Yes/No) inside a work-history entry.
    R(
      'exp.current',
      /\b(is|was) this (your|my) current (employer|job|position|role|company)\b|\bdo you (still|currently) work here\b/,
      {
        kinds: CHOICE,
      },
    ),
    R(
      'exp.start',
      /\b(employment|job|work|position|role) (start|from|begin)(ning)? (date|month|year)\b|\bdate (of )?(employment|hire) (start|began)/,
      { not: /preferred|desired|earliest|availab|expected|when (can|could|would)/ },
    ),
    R('exp.end', /\b(employment|job|work|position|role) (end|to|finish|leaving) (date|month|year)\b/),
    R(
      'exp.location',
      /\b(employer|company|organi[sz]ation)( s)? (location|city|address)\b|\blocation of (the )?(employer|company)\b/,
    ),
    R(
      'gen.start',
      /^(start|from|begin|started|since)( date| month| year)?$|\bstart ?date\b|\bstart (month|year)\b|\bdate (from|started|joined|of joining)\b|\bfrom (date|month|year)\b|\bstarted\b|\bbegin date\b|\bdate from\b/,
      {
        not: /when (can|could|would) you|availab|earliest|desired|preferred|expected|can you start|internship|placement|programme|program\b/,
      },
    ),
    R(
      'gen.end',
      /^(end|to|until|finish|till)( date| month| year)?$|\bend ?date\b|\bend (month|year)\b|\bdate (to|left|ended|of leaving)\b|\bto (date|month|year)\b|\bended\b|\bfinish date\b|\bdate to\b|\bleaving date\b/,
      { not: /open ended|\b(percentage|average|marks?|grades?|score|results?|gpa|total|overall)\b/ },
    ),
    R(
      'exp.company',
      /\bcompany\b|employer|organi[sz]ation|\bfirm\b|business name|workplace|unternehmen|\bempresa\b|entreprise/,
      {
        not: /current|present|most recent|size|industry|website|\btype\b|e ?mail|phone|address|why|how|referr|recruit|agency|\burl\b|linked ?in|do you|have you|are you|did you|related|know anyone|anyone at|family|relative|this company|our company|the company|interest|^if (yes|so|you)\b|deadlines?|\boffers?\b/,
      },
    ),
    R(
      'exp.title',
      /job ?title|\btitle\b|\bposition\b|\brole\b|designation|occupation|job name|berufsbezeichnung|\bpuesto\b|\bposte\b|job ?function/,
      {
        not: /appl(y|ied|ying)|current|present|most recent|interest|desired|preferred|seeking|looking|\blevel\b|\btype\b|salary|why|how|which|what|referr|for this|\bopen\b|vacancy|\bdo you\b|have you|are you|did you|\bcourse\b|book|song|thesis|project|paper|publication|prefix|salutation|honorific|description|summary|responsibilit|duties|\b(this|the) (position|role) (requires|involves|is|will|may)\b|export control|\bmodules?\b|\b(mr|mrs|ms|miss|mx)\b/,
        // "Module title" (id "mod_title_1"), "Dissertation title": not a job.
        notAny: /\bmodules?\b|\bdissertation\b|\bthesis\b/,
        test: (desc) => !hasHonorificOptions(desc),
      },
    ),
    R(
      'gen.description',
      /description|responsibilit|\bduties\b|achievement|accomplishment|what did you do|role summary|key (tasks|work)/,
      { kinds: LONG_TEXT },
    ),

    // Long-form text
    R('coverLetter', /cover ?letter|motivation(al)? letter|letter of motivation|anschreiben|lettre de motivation/, {
      kinds: LONG_TEXT,
    }),
    R(
      'summary',
      /\bsummary\b|about (you|yourself|me)\b|tell (us|me) (a (little|bit) )?about yourself|introduce yourself|\bbio\b|biography|personal statement|professional (profile|summary)|career (objective|summary)|\bobjective\b/,
      {
        // "Tell us something about yourself that we can't find on your resume" wants something new.
        not: /linked ?in|url|link|git|photo|picture|image|\bname\b|role summary|job summary|(not|can t|cannot|won t|isn t|wouldn t) (\w+ ){0,3}(on|in|from) (your |the )?(cv|resume)|\bbeyond (your |the )?(cv|resume)/,
        kinds: LONG_TEXT,
      },
    ),
    R(
      'skills',
      /\b(programming|coding|scripting|computer|software) languages?\b|\b(languages?|technologies|tools|frameworks) (and|or|&) (frameworks|tools|technologies|libraries)\b|\bwhich (of the following )?(technologies|tools|frameworks|programming)|\b(programming|coding) (experience|skills|knowledge) (with|in) (any of )?the following\b/,
      // "Which languages do you use?" wants the list; "your favourite language" wants one answer.
      {
        not: /\brate your|years|favou?rite|\bbest\b|primary|\bmain\b|strongest|\bmost\b|preferred|\blevel\b|how (proficient|experienced|comfortable|much|long)/,
      },
    ),
    R('skills', /\bskills?\b|technologies|tech(nical)? stack|competenc|expertise|\btools\b|proficienc(y|ies)/, {
      not: /language|\bdo you\b|have you|rate your|years|\blevel\b|how (proficient|experienced|comfortable|much|long)/,
    }),
    R(
      'languages',
      /languages? (spoken|you speak|proficienc|known|fluency)|which languages?\b|spoken languages|^languages?$|language skill|languages do you speak|\blanguages?\b.*\b(fluent|speak|proficient)\b|\bfluent in\b|\b(additional|other|foreign) languages?\b|\b(do|can) you speak\b|\bspeak (\w+ )?(at a |to a )?(fluent|native|business|professional)\b/,
      { not: /programming|coding|scripting|computer|software/ },
    ),
  ];

  // Standard HTML autocomplete tokens -> [type, part].
  // prettier-ignore
  const AUTOCOMPLETE = {
    name: ['name.full'], 'honorific-prefix': ['name.prefix'], 'given-name': ['name.first'],
    'additional-name': ['name.middle'], 'family-name': ['name.last'], nickname: ['name.preferred'],
    email: ['email'], username: ['account.username'],
    'new-password': ['account.password'], 'current-password': ['account.password'],
    'organization-title': ['job.currentTitle'], organization: ['exp.company'],
    'street-address': ['address.street'], 'address-line1': ['address.line1'], 'address-line2': ['address.line2'],
    'address-level2': ['address.city'], 'address-level1': ['address.state'],
    country: ['address.country'], 'country-name': ['address.country'], 'postal-code': ['address.postalCode'],
    'cc-name': ['cc.name'], 'cc-number': ['cc.number'], 'cc-exp': ['cc.exp'],
    'cc-exp-month': ['cc.exp', 'month'], 'cc-exp-year': ['cc.exp', 'year'], 'cc-csc': ['cc.cvc'], 'cc-type': ['cc.type'],
    bday: ['dob'], 'bday-day': ['dob', 'day'], 'bday-month': ['dob', 'month'], 'bday-year': ['dob', 'year'],
    sex: ['eeo.gender'], url: ['links.website'],
    tel: ['phone'], 'tel-national': ['phone.national'], 'tel-country-code': ['phone.countryCode'],
  };

  // "If yes, please tell us more": only answered when the answer to the question before was yes.
  const FOLLOW_UP = /^if (yes|so|you (said|answered|selected|chose|checked|ticked) yes)\b/;

  /**
   * Does an "If yes, …" question take this answer? A yes always; a no only as the answer to a yes/no choice ("If
   * yes, will you require Appian to file a visa petition? Yes / No"), never as the details a box asks for.
   */
  function followUpAnswer(v, kind) {
    return !!v && (v.canonical === 'yes' || (v.canonical === 'no' && CHOICE.includes(kind)));
  }

  /** Resolve a field type to a value object (or null when the profile has nothing for it). */
  function resolve(type, profile, ctx) {
    ctx = ctx || {};
    if (type === 'custom') return val(ctx.answer, { custom: true });
    const def = DEFS[type];
    if (!def || !profile) return null;
    try {
      const v = def.get(profile, ctx) || null;
      return v && FOLLOW_UP.test(ctx.question || '') && !followUpAnswer(v, ctx.kind) ? null : v;
    } catch (err) {
      return null;
    }
  }

  function labelOf(type) {
    return (DEFS[type] && DEFS[type].label) || type;
  }

  const fields = {
    createProfile,
    upgradeProfile,
    blankEducation,
    blankExperience,
    blankCustomAnswer,
    DEFS,
    RULES,
    AUTOCOMPLETE,
    JOB_TYPES,
    DATE_TYPES,
    KINDS: { TEXTISH, CHOICE, DEFAULT_KINDS },
    resolve,
    labelOf,
    workCountries,
    followUpAnswer,
    eduLevelOf,
    languagesNamed,
    isAcknowledgement,
    parseEthnicity,
    ETHNICITY_CHOICES,
    cardBrand,
    val,
  };
  JTF.fields = fields;
  if (typeof module === 'object' && module.exports) module.exports = fields;
})(typeof globalThis !== 'undefined' ? globalThis : this);
