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
    return {
      school: '',
      degree: '',
      field: '',
      gpa: '',
      // UK degree class, expected or achieved: "2:1", "First"; "Distinction" or "Merit" for a master's.
      classification: '',
      location: '',
      startDate: '',
      endDate: '',
    };
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
      contact: {
        email: '',
        // A university or school address, for "Your primary college/university/school email".
        schoolEmail: '',
        phoneCountryCode: '',
        phone: '',
        phoneType: 'Mobile',
        preferredContact: 'Email',
      },
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
        // A blank one counts as LinkedIn too (see DEFS['job.referralSource']).
        referralSource: 'LinkedIn',
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
        // Declarations: a criminal conviction; regulatory or disciplinary action (fined, suspended, barred, a licence
        // revoked, charges pending)
        criminal: '',
        regulatory: '',
      },
      // Interview and assessment slots you can do: weekdays, hours, and dates you can't ("12–23 January 2027").
      availability: { days: 'Mon, Tue, Wed, Thu, Fri', from: '08:00', to: '20:00', unavailable: '' },
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
    Yes: [
      'Yes',
      'degree or above',
      'degree or higher',
      'at least one has a degree',
      'degree level',
      'university degree',
    ],
    No: ['No', 'qualifications below degree level', 'below degree level', 'no degree'],
  };
  // "What is the highest level of education completed by either of your parents?" with levels for options: Yes says
  // a parent has a degree but not which (never "Bachelor's degree" or "Master's, doctoral…" on its own, when the parent
  // may hold the other), No says below degree level but not which ("Secondary school", "Vocational certificate"). Only
  // an option that says that much ("Degree or above", "Qualifications below degree level") is taken.
  const PARENT_LEVEL_UNSETTLED = {
    yes: (n) =>
      !/^yes\b/.test(n) &&
      (/\b(master\w*|doctor\w*|phd|post ?grad\w*|below|no formal)\b/.test(n) ||
        (/\b(bachelor\w*|undergrad\w*)\b/.test(n) && !/\bor (above|higher|more)\b/.test(n))),
    no: (n) =>
      !/^no\b(?! formal)|\bbelow (degree|university)\b|\bno (university )?degree\b/.test(n) &&
      /\b(primary|secondary|high school|gcses?|a levels?|vocational|technical|apprenticeship|no formal|certificate|diploma|school|(don t|do not) know|not sure|unsure|unknown)\b/.test(
        n,
      ),
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

  // The Social Mobility Commission's three backgrounds, from the main household earner's job at 14: professional
  // (professional and managerial jobs), intermediate (clerical, small business owners) and working class (technical and
  // craft, routine and semi-routine, long-term unemployed).
  const BACKGROUND_OF = {
    Professional: 'professional',
    'Manager / administrator': 'professional',
    'Clerical / intermediate': 'intermediate',
    'Small business owner': 'intermediate',
    'Technical / craft': 'working',
    'Routine / semi-routine': 'working',
    'Long-term unemployed': 'working',
  };
  const BACKGROUNDS = {
    professional: [
      'Professional',
      'Professional background',
      'Higher socio-economic background',
      'Professional or managerial',
    ],
    intermediate: ['Intermediate', 'Intermediate background'],
    working: ['Working class', 'Working class background', 'Lower socio-economic background'],
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

  // A university's or school's address: name@ucl.ac.uk, name@mit.edu, name@student.unimelb.edu.au.
  const ACADEMIC_EMAIL =
    /@([a-z0-9-]+\.)*[a-z0-9-]+\.(ac|edu)(\.[a-z]{2})?$|@([a-z0-9-]+\.)*(student|students|stud|alumni)\./i;

  function sponsorAware(v, p, about) {
    const canon = (t) => (JTF.matcher ? JTF.matcher.canonicalOf(t) : null);
    const need = canon(p.job.sponsorship);
    // Which question this answers: a "Yes, but I will need sponsorship" is a Yes to being authorized, not to needing one.
    if (v) v.about = about;
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
    // Dual nationals ("British, Irish") have both.
    const out = JTF.geo.nationalities(p.personal.nationality).map((row) => row[0]);
    if (!out.length) return [];
    const home = JTF.geo.findCountry(p.address.country);
    if (home && JTF.matcher && JTF.matcher.canonicalOf(p.job.authorized) === 'yes') out.push(home[0]);
    return [...new Set(out)];
  }

  const optionTexts = (ctx) => (ctx.options || []).map((o) => U.normalize(o && typeof o === 'object' ? o.text : o));

  // "…in the country of any office you selected?", "…in the country where this role is based?": the job's country.
  const JOB_COUNTRY =
    /\bcountr(y|ies) (of|for|where|in which) (any|the|each|every|this|that|your|all)( of the)? (selected |chosen )?(offices?|locations?|roles?|jobs?|positions?|vacanc(y|ies)|opportunit(y|ies))\b|\b(offices?|locations?|countr(y|ies)) (that )?you (have )?(selected|chosen|chose|picked|applied)\b/;

  /**
   * The countries a work-authorisation question is about: the places it names ("…in London" is the UK) and whether
   * it needs all of them ("…in the UK and the US?") or one ("…in the UK or the US?"); else the country its visa words
   * name ("(e.g., H-1B visa status)"), or its options ("…eligible to work in the United States with no restrictions").
   * Visa words are only examples in a question about the job's own country (Bain: "…in the country of any office you
   * selected? (For example: H-1B, TN, O-1…)").
   */
  function countriesAsked(question, options) {
    const q = question || '';
    // Countries and states first: "…in the UK? Our offices are in London and New York" is about the UK.
    const places = JTF.geo.placesNamed(q);
    const wide = places.filter((pl) => pl.type !== 'metro');
    const named = [...new Set((wide.length ? wide : places).map((pl) => pl.country))];
    if (named.length) return { codes: named, all: !/\bor\b/.test(q) };
    let codes = JOB_COUNTRY.test(q) ? [] : JTF.geo.visaCountries(q);
    if (!codes.length) {
      const texts = optionTexts({ options });
      codes = [...new Set(texts.flatMap((t) => [...JTF.geo.countriesNamed(t), ...JTF.geo.visaCountries(t)]))];
    }
    return { codes, all: false };
  }

  /**
   * A question that names no country ("…in the country where this role is based?", "Will you require sponsorship?")
   * is about where the job is: its location when known, else the one country the form's other work questions name.
   * Never for "the country you live in".
   */
  function jobCountries(ctx) {
    if (
      /\b(you|your) (live|reside|currently live|home country|country of (residence|citizenship))\b/.test(
        ctx.question || '',
      )
    )
      return [];
    const there = JTF.geo.countriesIn(ctx.jobLocation || '');
    const form = ctx.formCountries || [];
    // A job in "Dallas, TX / London" whose form asks "…the right to work in the United States?": the US.
    return !there.length || (there.length > 1 && form.length && there.includes(form[0])) ? form : there;
  }

  /**
   * A work-authorisation question about a country you have no right to work in ("Are you authorized to work in
   * the United States?" for a British student): the country it names, else null.
   */
  function noRightIn(p, ctx) {
    const { codes, all } = countriesAsked(ctx.question, ctx.options);
    const asked = codes.length ? codes : jobCountries(ctx);
    if (!asked.length) return null;
    const mine = workCountries(p);
    if (!mine.length) return null;
    const rights = JTF.geo.workRights(mine);
    const ok = all ? asked.every((c) => rights.has(c)) : asked.some((c) => rights.has(c));
    if (ok) return null;
    const code = asked.find((c) => !rights.has(c));
    const row = code === 'EU' ? null : JTF.geo.COUNTRIES.find((r) => r[0] === code);
    return {
      code,
      name: code === 'EU' ? 'the EU' : row ? (code === 'US' || code === 'GB' ? 'the ' : '') + row[2] : 'that country',
    };
  }

  // "Is there any other context you'd like to share about your U.S. Immigration sponsorship needs?" or "…? If yes,
  // please explain." in a text box wants a sentence, never a bare Yes or No.
  const YES_NO_START = /^(do|does|are|is|will|would|have|has|can|could|shall)\b/;
  const WANTS_DETAILS =
    /\b(context|details?|explain|elaborate|describe|specify|tell us|share|provide|more information|anything else)\b/;
  const wantsSentence = (ctx) =>
    LONG_TEXT.includes(ctx.kind) && (!YES_NO_START.test(ctx.question || '') || WANTS_DETAILS.test(ctx.question || ''));

  /** Not authorised there, so sponsorship needed: for options like "No, I will require sponsorship" too. */
  function elsewhere(p, ctx, which) {
    const where = noRightIn(p, ctx);
    if (!where) return null;
    if (wantsSentence(ctx))
      return val(`I don’t have the right to work in ${where.name} and would need visa sponsorship.`);
    const v = val(which === 'authorized' ? 'No' : 'Yes');
    return Object.assign(v, { sponsor: 'yes', authorized: 'no', citizen: [], about: which });
  }

  /**
   * "Right to work / Visa status" in a text box wants a sentence, not "No": written from your two answers.
   * Null for yes/no questions ("Do you require sponsorship?") and choice controls.
   */
  function workStatus(p, ctx) {
    if (!wantsSentence(ctx)) return null;
    const canon = (t) => (JTF.matcher ? JTF.matcher.canonicalOf(t) : null);
    const ok = canon(p.job.authorized);
    const sponsor = canon(p.job.sponsorship);
    if (ok === 'yes' && sponsor === 'no') return val('I have the right to work and do not need visa sponsorship.');
    if (ok === 'yes' && sponsor === 'yes') return val('I have the right to work now but will need visa sponsorship.');
    if (ok === 'no' || sponsor === 'yes') return val('I will need visa sponsorship to work in this role.');
    return null;
  }

  /**
   * "Do you hold a valid UK visa?": a citizen there (or an Irish or EU citizen with free movement) needs none, so
   * "Not applicable – British/Irish citizen" when offered, else No; No too where you have no right to work. Left
   * alone where you have the right to work some other way (a visa, settled status).
   */
  function visaHeld(p, ctx) {
    let { codes } = countriesAsked(ctx.question, null);
    if (!codes.length) codes = jobCountries(ctx);
    if (codes.length !== 1) return null;
    const nations = JTF.geo.nationalities(p.personal.nationality).map((row) => row[0]);
    if (nations.length && JTF.geo.workRights(nations).has(codes[0])) {
      const mine = JTF.geo.citizenWords(p.personal.nationality);
      const ours = (n) => mine.some((w) => (' ' + n + ' ').includes(' ' + w + ' '));
      const i = optionTexts(ctx).findIndex(
        (n) =>
          (/\bnot applicable\b|^n ?a\b|\bno visa (is )?(needed|required)\b|\b(do not|don t) (need|require) a visa\b/.test(
            n,
          ) &&
            (!/\b(citizen|national)s?\b/.test(n) || ours(n))) ||
          (/\b(citizen|national)s?\b/.test(n) && !/\b(not|non)\b/.test(n) && ours(n)),
      );
      return i >= 0 ? val(ctx.options[i].text || String(ctx.options[i])) : val('No');
    }
    const rights = workCountries(p);
    return rights.length && !JTF.geo.workRights(rights).has(codes[0]) ? val('No') : null;
  }

  /** A list of US states ("AL / AK / … / WY / Other"). */
  function usStates(ctx) {
    const texts = optionTexts(ctx).filter((t) => t && !JTF.matcher.isPlaceholder(t));
    const states = texts.filter((t) => JTF.geo.findRegion(t, 'US'));
    return texts.length >= 5 && states.length / texts.length >= 0.6;
  }

  /** Is your address in any of `places`? true, false, or null when it can't tell (a town that isn't listed). */
  function livesIn(p, places, metroOnly) {
    const home = JTF.geo.whereIs(p.address);
    // "Commute to our New Jersey office": only a city says how far it is, though another country is too far.
    const hits = places.map((pl) => {
      const there = JTF.geo.within(pl, home);
      return metroOnly && pl.type !== 'metro' && there !== false ? null : there;
    });
    if (hits.includes(true)) return true;
    return hits.length && hits.every((h) => h === false) ? false : null;
  }

  /** The places a question names, else (for "our office") where the job is. */
  function placesAsked(ctx) {
    const named = JTF.geo.placesNamed(ctx.question || '');
    return named.length ? named : JTF.geo.placesNamed(ctx.jobLocation || '');
  }

  const ONSITE_DAYS =
    /\b(\d|two|three|four|five) days (a|per|each) week\b|\bon ?site\b|\bin person\b|\bfull ?time in\b/;

  /**
   * "Would you be willing to be based in our London office?": yes where you live, else your relocation answer; with
   * "…onsite… 5 days a week" your on-site answer too.
   */
  function workThere(p, ctx) {
    const canon = (t) => (JTF.matcher ? JTF.matcher.canonicalOf(t) : null);
    const here = livesIn(p, placesAsked(ctx));
    const move = canon(p.job.relocate);
    let ok = here === true || move === 'yes' ? 'yes' : here === false && move === 'no' ? 'no' : null;
    if (ok && ONSITE_DAYS.test(ctx.question || '')) {
      const onsite = canon(p.job.onsite);
      if (onsite === 'no') ok = 'no';
      else if (onsite !== 'yes' && ok === 'yes') ok = null;
    }
    return ok ? val(ok === 'yes' ? 'Yes' : 'No') : null;
  }

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

  // UK degree classes (and a master's Distinction / Merit) and the ways forms spell them.
  const DEGREE_CLASSES = {
    first: ['First', '1st', 'First Class', 'First Class Honours', '1st Class', 'First / 1st'],
    upper: [
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
    lower: [
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
    third: ['Third', '3rd', 'Third Class', 'Third Class Honours', '3rd Class'],
    pass: ['Pass', 'Ordinary', 'Ordinary degree', 'Pass degree'],
    distinction: ['Distinction', 'Pass with Distinction'],
    merit: ['Merit', 'Pass with Merit'],
  };

  /**
   * The class an answer or option names: "Upper Second Class Honours (2:1)", "2(i)", "2.1" or "Second class honours:
   * Grade 1" -> 'upper'; also 'first', 'lower', 'third', 'pass', 'distinction', 'merit'. Null for anything else,
   * GPA bands ("3.00 - 3.49") included.
   */
  function degreeClassOf(text) {
    const raw = String(text || '');
    if (/\d\.\d+\s*(-|–|—|to)\s*\d/.test(raw) && !/class|honou?r|first|second|third|division/i.test(raw)) return null;
    const t = U.normalize(raw.replace(/\b2\s*\(\s*(i{1,2})\s*\)/gi, '2$1'));
    if (!t || t.length > 120) return null;
    if (
      /\b(2 ?1|2 ?i|upper second|second (class )?upper|upper (second )?division)\b|\bsecond class( honou?rs)?( grade| division)? (1|i|one|upper)\b/.test(
        t,
      )
    )
      return 'upper';
    if (
      /\b(2 ?2|2 ?ii|lower second|second (class )?lower|lower (second )?division)\b|\bsecond class( honou?rs)?( grade| division)? (2|ii|two|lower)\b/.test(
        t,
      )
    )
      return 'lower';
    if (/\bdistinction\b/.test(t)) return 'distinction';
    if (/\bmerit\b/.test(t)) return 'merit';
    if (/^(first|1st)\b(?! (name|half|year|time|choice|language|semester|term))|^1$|\b(first|1st) class\b/.test(t))
      return 'first';
    if (/^(third|3rd)\b(?! (party|year))|^3$|\b(third|3rd) class\b/.test(t)) return 'third';
    if (/^(pass|ordinary|unclassified)\b|\b(pass|ordinary) (degree|honou?rs)\b/.test(t)) return 'pass';
    return null;
  }

  // "Upper Second (2:1) – predicted", "2:1 (expected)": a class you are on course for, not one you have.
  const EXPECTED_CLASS = /\b(predicted|expected|anticipated|projected|forecast|on track|working towards)\b/;

  /** A degree class: "2:1" also picks "Upper Second Class Honours (2:1)", "2(i)" or "Second class honours: Grade 1". */
  function classVal(text, expected) {
    const v = val(text);
    const cls = v && degreeClassOf(v.text);
    if (!cls) return v;
    return Object.assign(v, {
      kind: 'class',
      cls,
      expected: !!expected,
      candidates: [...new Set([v.text, ...DEGREE_CLASSES[cls]])],
    });
  }

  /** "3.9" or "3.9/4.0" also matches ranges like "3.80 - 4.00"; "2:1" or "First" matches its spellings. */
  function gpaVal(text) {
    const m = String(text || '').match(/^\s*(\d(?:\.\d+)?)\s*(?:\/\s*\d(?:\.\d+)?)?\s*$/);
    if (m && !/:/.test(text)) return val(text, { kind: 'number', number: parseFloat(m[1]) });
    return classVal(text);
  }

  // "GPA (out of 4.0)", "Cumulative GPA", "Grade point average": a number, never "2:1".
  const NUMERIC_GPA = /\b(4 0|4 point|5 0|10 0|out of|scale|grade point|cumulative|cgpa|numeric|decimal)\b/;
  // "If your school/university uses a GPA system, enter your GPA on a 0- 4.0 scale. Otherwise, provide your overall
  // result in your school/university's grading system" (Shell's Workday): a result in your own grading system is
  // welcome too, whatever scale the GPA is on.
  const OWN_SYSTEM =
    /\botherwise\b.{0,80}\b(results?|grades?|marks?|class(es|ification)?)\b|\b(own|local|national|home|equivalent|(school|university|college|institution|country)( s)?) (grading|marking|grade|assessment) (system|scale)\b|\b(does not|doesn t|do not|don t) use (a |the )?(gpa|grade point)\b|\bscale (used|of|at) (by |at |in )?(your )?(own |local |home )?(school|university|college|institution|country)\b/;

  /**
   * A GPA question: your GPA (a class written there too, unless the question wants a number). With no GPA, a "Grade"
   * or "GPA / grade" box takes your degree classification; one that only asks for a GPA, or for one on a scale, doesn't
   * (a class is never turned into a number). A box whose page also takes a result in your own grading system
   * ("Overall Result (GPA)" on Workday: "…Otherwise, provide your overall result in your school/university's grading
   * system") takes the class as written ("2:1"). `ctx.help`: what the page says about the box, normalised.
   */
  function gpaFor(e, ctx) {
    const q = ctx.question || '';
    const help = ctx.help || '';
    const ownSystem = OWN_SYSTEM.test(q) || OWN_SYSTEM.test(help);
    const scaled = NUMERIC_GPA.test(q) || (/\b(gpa|grade point)\b/.test(help) && NUMERIC_GPA.test(help));
    const numeric = ctx.kind === 'number' || (scaled && !ownSystem);
    if (!U.isBlank(e.gpa)) {
      const v = gpaVal(e.gpa);
      return numeric && v && v.kind === 'class' ? null : v;
    }
    const gpaOnly = /\bgpa\b/.test(q) && !/\b(grades?|class|classification|results?)\b/.test(q) && !ownSystem;
    return numeric || gpaOnly ? null : classFor(e, ctx);
  }

  /**
   * "Expected/Achieved Degree Classification", "Predicted grade", "Degree result": your classification, else a class
   * written as your GPA ("2:1"), else the GPA as it is (a free-text box on a UK form takes a US student's "3.8").
   * Predicted while the course is still running, or when you wrote so ("2:1 (predicted)").
   */
  function classFor(e, ctx) {
    const own = !U.isBlank(e.classification) ? e.classification : degreeClassOf(e.gpa) ? e.gpa : '';
    if (U.isBlank(own)) return U.isBlank(e.gpa) ? null : gpaVal(e.gpa);
    const end = U.parseDate(e.endDate);
    const now = ctx.today || new Date();
    const studying = !!end && end.year * 12 + (end.month || 6) - 1 >= now.getFullYear() * 12 + now.getMonth();
    return classVal(own, studying || EXPECTED_CLASS.test(U.normalize(own)));
  }

  /**
   * "GPA Scale", "Please specify the grading scale used by your current school" [4.0 Scale / 5.0 Scale / UK Grading
   * System]: what your GPA is out of ("3.8/4.0"), or for a UK degree class the UK option of a list; never "2:1" itself.
   */
  function gpaScale(e, ctx) {
    const out = String(e.gpa || '').match(/\/\s*(\d+(?:\.\d+)?)\s*$/);
    if (out)
      return val(out[1], { kind: 'number', number: parseFloat(out[1]), candidates: [out[1], `${out[1]} scale`] });
    if ((U.isBlank(e.classification) && !degreeClassOf(e.gpa)) || !CHOICE.includes(ctx.kind)) return null;
    return val('UK degree classification', {
      candidates: [
        'UK degree classification',
        'UK grading system',
        'UK honours classification',
        'UK classification',
        'UK',
      ],
    });
  }

  const CLASS_RANK = { first: 4, distinction: 4, upper: 3, merit: 3, lower: 2, third: 1, pass: 0 };
  // The classes a question names: "a First or 2:1" (never "first year" or "your first degree").
  const CLASS_NAMED = [
    ['upper', /\b2 (1|i)\b|\bupper second\b/],
    ['lower', /\b2 (2|ii)\b|\blower second\b/],
    [
      'first',
      /\bfirst class\b|\b(predicted|achieve|achieved|expect) (a )?(first|1st)\b(?! (year|degree|time))|\b(first|1st) or\b|\bor (a )?(first|1st)\b/,
    ],
    ['third', /\bthird class\b/],
  ];

  /**
   * "Do you have a 2:1 or above (or equivalent)?", "Have you achieved or are you on track for a First or 2:1?": yes when
   * your class (predicted or achieved; First > 2:1 > 2:2 > Third > Pass, a master's Distinction and Merit level with a
   * First and a 2:1) is at least the lowest one named. "Do you expect to graduate with honours?": yes for an honours
   * degree or class. Null without a class (a GPA is never converted).
   */
  function classAtLeast(p, ctx) {
    const q = ctx.question || '';
    const level = eduLevelOf(q);
    const list = p.education || [];
    const e = level ? list.find((x) => JTF.matcher.degreeGroup(U.normalize(x.degree)) === level) : list[0];
    if (!e) return null;
    const own = classFor(e, ctx);
    const cls = own && own.cls;
    const named = CLASS_NAMED.filter(([, re]) => re.test(q)).map(([c]) => c);
    if (named.length) {
      if (!cls) return null;
      return val(CLASS_RANK[cls] >= Math.min(...named.map((c) => CLASS_RANK[c])) ? 'Yes' : 'No');
    }
    if (!/\bhonou?rs\b/.test(q)) return null;
    if (/\b(hons|honou?rs)\b/.test(U.normalize(e.degree)) || ['first', 'upper', 'lower', 'third'].includes(cls))
      return val('Yes');
    return cls === 'pass' ? val('No') : null;
  }

  // Degree subjects and the other names lists give them ("Computing Science" is "Computer Science", "Maths"
  // "Mathematics", "LLB" "Law"): [names, STEM?]. The usual name comes first.
  // prettier-ignore
  const SUBJECTS = [
    [['Computer Science', 'Computing Science', 'Computer Sciences', 'Computing', 'Comp Sci', 'CompSci', 'CS',
      'Computer Studies', 'Informatics'], true],
    [['Software Engineering', 'Software Development'], true],
    [['Computer Engineering', 'Computer Systems Engineering', 'Electrical/Computer Engineering'], true],
    [['Electrical Engineering', 'Electrical and Electronic Engineering', 'Electronic Engineering',
      'Electronic and Electrical Engineering', 'EEE', 'Electronics'], true],
    [['Mechanical Engineering', 'MechEng'], true],
    [['Aerospace Engineering', 'Aeronautical Engineering', 'Aeronautical & Aerospace Engineering',
      'Aerospace and Aeronautical Engineering'], true],
    [['Engineering', 'General Engineering', 'Engineering (various disciplines)'], true],
    [['Mathematics', 'Maths', 'Math', 'Mathematical Sciences', 'Mathematical Science'], true],
    [['Statistics', 'Stats', 'Statistical Science'], true],
    [['Data Science', 'Data Sciences'], true],
    [['Physics', 'Physical Science'], true],
    [['Chemistry', 'Chemical Sciences'], true],
    [['Biology', 'Biological Sciences', 'Biosciences', 'Life Sciences'], true],
    [['Natural Sciences', 'Natural Science', 'NatSci', 'Nat Sci'], true],
    [['Economics', 'Econ', 'Economic Sciences', 'Economics & Econometrics'], false],
    [['Philosophy, Politics and Economics', 'PPE', 'Politics, Philosophy and Economics'], false],
    [['Business', 'Business Administration', 'Business Management', 'Business Studies', 'Management',
      'Business & Management Studies', 'Business and Management'], false],
    [['Finance', 'Banking and Finance', 'Financial Management'], false],
    [['Accounting', 'Accountancy', 'Accounting and Finance'], false],
    [['Law', 'LLB', 'Laws', 'Legal Studies', 'Jurisprudence'], false],
    [['Politics', 'Political Science', 'Government'], false],
    [['Modern Languages', 'Languages', 'Modern Foreign Languages'], false],
  ].map(([names, stem]) => ({ names, stem, keys: names.map(U.normalize) }));

  /**
   * A degree subject: its other names too ("Computing Science" also tries "Computer Science"), for each subject it
   * names, in the order it names them ("Mathematics and Computer Science").
   */
  function subjectVal(text) {
    const v = val(text);
    if (!v) return v;
    const t = ' ' + U.normalize(v.text) + ' ';
    const hits = [];
    for (const row of SUBJECTS) {
      const at = row.keys.map((k) => t.indexOf(' ' + k + ' ')).filter((i) => i >= 0);
      if (at.length) hits.push([Math.min(...at), row]);
    }
    hits.sort((a, b) => a[0] - b[0]);
    return Object.assign(v, {
      kind: 'subject',
      candidates: [...new Set([v.text, ...hits.flatMap(([, row]) => row.names)])],
      stem: hits.some(([, row]) => row.stem),
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
    const q = question || '';
    // The question can follow the facts: "The internship runs from 1 July to 30 September 2027. Can you confirm…"
    if (
      !/^((are|will|would|can|could|do) you|(i )?confirm)\b|\b(are|will|would|can|could) you (confirm|be available|be able)\b/.test(
        q,
      )
    )
      return null;
    if (!/\bavailab|\bstart|\bready\b|\bcommence|\bjoin|\bsuit(s|able)?\b|\bconvenient\b|\bwork for (me|you)\b/.test(q))
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
    const phrase = range ? range[1] + ' ' + year[0] : head.replace(/^.*?\b(from|on|by|in|for|around|before)\b /, '');
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

  // "Are you a final year student?", "Are you in your penultimate year?": yes or no from your year of study.
  const YEAR_ASKED =
    /^(are|is) you\b.*?\b(first|second|third|fourth|fifth|final|penultimate|pre ?final|1st|2nd|3rd|4th|5th) year\b/;

  function yearAnswer(p, ctx) {
    const m = (ctx.question || '').match(YEAR_ASKED);
    const y = studyYear(p, ctx.today);
    if (!y) return null;
    const want = m[2].replace(/^pre ?final$/, 'penultimate');
    return val(y.candidates.some((c) => [want, want + ' year'].includes(U.normalize(c))) ? 'Yes' : 'No');
  }

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
        [
          'indian',
          'Indian',
          /(?<!\b(american|west|east|north american|alaskan?) )\bindian\b(?! subcontinent)/,
          'south',
        ],
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
  // Asian regions no option stands for alone.
  const MORE_ASIAN = /\b(north ?east(ern)?|central|west(ern)?) asian?\b|\bfar east\b|\bindian subcontinent\b/;
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
      // Bain's "Asian (inclusive of Northeast Asian, Southeast Asian, Southern and Central Asian)" and the US "…the Far
      // East, Southeast Asia, or the Indian subcontinent" name several regions: the whole group, not one.
      const regions = ASIAN_REGIONS.filter(([, re]) => re.test(all));
      if (regions.length === 1 && !MORE_ASIAN.test(all)) region = regions[0][0];
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

  // A mixed answer's two groups.
  const MIXED_PARTS = {
    whiteasian: ['White', 'Asian'],
    whiteblackafrican: ['White', 'Black – African'],
    whiteblackcaribbean: ['White', 'Black – Caribbean'],
  };

  /** An ethnicity answer: matched against an option list by parseEthnicity, most specific option first. */
  function ethnicityVal(text) {
    const v = val(text);
    const eth = v ? parseEthnicity(v.text) : null;
    if (eth) Object.assign(v, { kind: 'ethnicity', eth });
    // "Select all that apply" without a mixed option: both groups ("White" and "Asian").
    const both = eth && MIXED_PARTS[eth.sub];
    if (both) v.items = both.map(ethnicityVal);
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
  function enrolment(p, today, question) {
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
    // "Are you currently an undergraduate student?": yes at that level only (an MEng counts as both).
    const asked = question && /^(are|were|is) you\b/.test(question) ? levelsOf(question) : [];
    const held = asked.length && JTF.matcher ? entryLevels(current) : [];
    if (held.length) return val(asked.some((l) => held.includes(l)) ? 'Yes' : 'No');
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
    [
      /\blinked ?in\b/,
      [
        'Linkedin',
        'LinkedIn Jobs',
        'LinkedIn job posting',
        'LinkedIn job post',
        'LinkedIn advert',
        'Social media',
        'Social network',
        'Social networking',
        ...JOB_SITE,
      ],
    ],
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

  // The ways forms spell a contact method ("E-mail", "Text message (SMS)").
  const CONTACT_METHODS = {
    Email: ['Email', 'E-mail', 'Email address', 'By email'],
    Phone: ['Phone', 'Phone call', 'Telephone', 'Call', 'Mobile', 'Mobile phone', 'By phone'],
    'Text message': ['Text message', 'Text', 'SMS', 'Text (SMS)', 'SMS / text message'],
    WhatsApp: ['WhatsApp'],
  };

  /* ---------------------------------------------------------------- sanctions */

  // Places named in sanctions statements; two in one sentence make it one ("…of Cuba, Iran, North Korea, or Syria").
  const SANCTIONED_PLACE =
    '(cuban?|iran(ian)?|north korean?|syrian?|crimean?|donetsk|lu[hg]ansk|zapor[io]z?h\\w*|kherson|sevastopol)';
  const TWO_SANCTIONED_PLACES = new RegExp(`\\b${SANCTIONED_PLACE}\\b.*\\b${SANCTIONED_PLACE}\\b`);
  // "If you selected a response to the prior question other than "none of the above," please confirm…"
  const SANCTIONS_FOLLOW_UP =
    /\bother than (the )?none of (the above|these|them)\b|\b(if|where) (you|any) (selected|ticked|chose|checked|answered|picked)\b(?! (yes|no)\b).*\b(prior|previous|above|preceding|first) question\b/;
  const CITIZEN_WORDS = /\b(citizen\w*|nationals?|nationality|passports?)\b/;
  const PERMANENT_RESIDENT = /\bpermanent(ly)? residen\w*|\bgreen card\b/;
  const RESIDENT_WORDS = /\b(residen\w*|reside|resided|residing|live|lives|lived|living|located|based|domiciled)\b/;
  // "…a comprehensively sanctioned country", "subject to US embargo (E:1/E:2 countries)": the usual list.
  const ANY_SANCTIONED = /\bsanction\w*|\bembargo\w*|\bofac\b|\be [12]\b|\bcountry group e\b/;
  // The US as the authority ("U.S. sanctions", "subject to US embargo"), not a place you could be from.
  const SANCTIONING =
    /\b(u ?s( a)?|united states( of america)?|american)( government| treasury| department of \w+)? (sanction\w*|embargo\w*|export\w*|laws?|regulations?|government|treasury|department|ofac|trade)\b/g;

  const or3 = (list) => (list.includes(true) ? true : list.includes(null) ? null : false);
  const and3 = (a, b) => (a === false || b === false ? false : a === true && b === true ? true : null);

  /** What sanctions statements are judged by: your nationalities, where you live (and its region), relocation. */
  function sanctionFacts(p) {
    const nations = JTF.geo.nationalities(p.personal.nationality).map((row) => row[0]);
    const home = JTF.geo.findCountry(p.address.country);
    const area = [p.address.state, p.address.city].filter((s) => !U.isBlank(s)).join(' ');
    return {
      nations: nations.length ? nations : null,
      home: home ? home[0] : null,
      // The occupied regions of Ukraine your region or city names; null when the address doesn't say.
      regions: area ? JTF.geo.occupiedRegions(area) : null,
      relocate: JTF.matcher ? JTF.matcher.canonicalOf(p.job.relocate) : null,
    };
  }

  /** Nothing a sanctions list could ask about applies to you: "none of the above" even with its statements unseen. */
  function sanctionsClear(f) {
    const watch = JTF.geo.SANCTIONS_WATCH;
    if (!f.nations || !f.home || f.nations.some((c) => watch.has(c)) || watch.has(f.home)) return false;
    if (f.regions && f.regions.length) return false;
    return f.home !== 'UA' || f.regions != null;
  }

  /**
   * Is a sanctions statement true of you? "Citizen or permanent resident of Cuba, Iran, North Korea, or Syria" from
   * your nationalities; "Ordinarily a resident of … the Crimea, Donetsk… regions of Ukraine" from your country and
   * region; "…of Russia or Belarus and not willing to relocate" from your relocation answer too. A question that
   * names no place ("…a comprehensively sanctioned country?") means the usual ones. true / false; null when your
   * profile can't tell; undefined when it isn't such a statement ("None of the above").
   */
  function sanctionsApplies(text, f) {
    const all = U.normalize(text);
    let t = ' ' + all.replace(SANCTIONING, ' ') + ' ';
    // "…and not willing to relocate for a Databricks role" is a condition, not a denial.
    let relocation = null;
    t = t.replace(/\b(and |but )?(not |un)(willing|able|prepared|open) to relocate\b.*$/, () => {
      relocation = 'no';
      return ' ';
    });
    t = t.replace(/\b(and |but )?(willing|able|prepared|open) to relocate\b.*$/, () => {
      relocation = relocation || 'yes';
      return ' ';
    });
    // "Individual granted citizenship in a country other than Cuba, Iran…": any other one.
    const other = t.match(/\bother than\b(.*)$/);
    const head = other ? t.slice(0, other.index) : t;
    const scope = other ? other[1] : t;
    const regions = JTF.geo.occupiedRegions(scope);
    // Countries or their people ("Cuban, Iranian… nationality").
    let countries = JTF.geo.nationalitiesNamed(scope);
    // "North Korea" isn't South Korea (alias "Korea"); "the Crimea… regions of Ukraine" isn't all of Ukraine.
    if (countries.includes('KP') && !/\bsouth korea/.test(scope)) countries = countries.filter((c) => c !== 'KR');
    if (regions.length) countries = countries.filter((c) => c !== 'UA');
    if (!countries.length && !regions.length) {
      if (other || !ANY_SANCTIONED.test(all)) return undefined;
      countries = JTF.geo.SANCTIONED;
      regions.push(...JTF.geo.OCCUPIED.map(([name]) => name));
    }
    // "Have you ever lived in…?" asks about the past, which the profile doesn't know.
    const past = /\b(ever|previously|formerly|in the past|lived|resided)\b/.test(head);
    const lives = () => {
      if (other) return null;
      if (f.home && countries.includes(f.home)) return true;
      if (regions.length && f.regions && f.regions.some((r) => regions.includes(r))) return true;
      if (past || !f.home || (f.home === 'UA' && regions.length && f.regions == null)) return null;
      return false;
    };
    const citizen = () => {
      if (!f.nations) return null;
      return other ? f.nations.some((c) => !countries.includes(c)) : f.nations.some((c) => countries.includes(c));
    };
    const tests = [];
    const isCitizen = CITIZEN_WORDS.test(head);
    const isPermanent = PERMANENT_RESIDENT.test(head);
    const isResident = RESIDENT_WORDS.test(head.replace(PERMANENT_RESIDENT, ' '));
    if (isCitizen || (!isPermanent && !isResident)) tests.push(citizen());
    if (isResident || (!isCitizen && !isPermanent)) tests.push(lives());
    // A permanent residency elsewhere than you live is unlikely; where you live it can't be told.
    if (isPermanent) tests.push(citizen() || (lives() === false ? false : null));
    // "Are you, or is any member of your family, a national of…?": your family's isn't known.
    if (/\b(family|relatives?|parents?|spouse|household)\b/.test(head)) tests.push(null);
    let result = or3(tests);
    if (relocation) result = and3(result, f.relocate === relocation ? true : f.relocate ? false : null);
    if (/\b(not|never|neither|nor)\b/.test(head)) result = result == null ? null : !result;
    return result;
  }

  /* ------------------------------------------------------------- availability */

  const WEEKDAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  // "Mon", "Tues", "Wednesday", "Thurs", "Saturdays".
  const WEEKDAY = '(sun|mon|tue|wed|thu|fri|sat)(?:s|r|rs)?(?:day|nesday|sday|urday)?s?';
  const SLOT_NONE =
    /\bnone\b|\bnot available\b|\bunavailable\b|\b(cannot|can ?t|can not|unable to) (make|attend|do)\b|\bdo(es)? ?n[o']?t (work|suit)\b|\bother (dates?|times?)\b|\balternative (dates?|times?|slots?)\b/;
  const SLOT_ANY =
    /\bany ?time\b|\bany (day|date|slot)s?\b|\bflexible\b|\ball (of the above|dates|times|slots)\b|\bwhenever\b|\bno preference\b|\bavailable (at )?all times\b/;
  const PARTS_OF_DAY = [
    [/\bmornings?\b/, [9 * 60, 12 * 60]],
    [/\blunch ?(time)?\b/, [12 * 60, 14 * 60]],
    [/\bafternoons?\b/, [12 * 60, 17 * 60]],
    [/\bevenings?\b/, [17 * 60, 20 * 60]],
    [/\b(all|full|whole) day\b/, [9 * 60, 17 * 60]],
  ];

  const dayNumber = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / 864e5);
  const weekdayOf = (n) => (((n + 4) % 7) + 7) % 7; // 1 January 1970 was a Thursday
  const todayNumber = (today) => {
    const now = today || new Date();
    return dayNumber(now.getFullYear(), now.getMonth() + 1, now.getDate());
  };

  /** "08:00", "8am", "20:00" -> minutes after midnight; `fallback` when blank. */
  function clockMinutes(text, fallback) {
    const m = String(text || '')
      .toLowerCase()
      .match(/(\d{1,2})(?:[:.h](\d{2}))?\s*(am|pm)?/);
    if (!m) return fallback;
    const h = +m[1] % 24;
    return (m[3] ? (h % 12) + (m[3] === 'pm' ? 12 : 0) : h) * 60 + (+m[2] || 0);
  }

  /** "Mon, Tue, Wed", "Mon–Fri", "Weekdays", "Every day" -> [1, 2, 3] (0 is Sunday). */
  function dayList(text) {
    const t = String(text || '')
      .toLowerCase()
      .replace(/[–—]/g, '-');
    if (/\b(every ?day|any ?day|all (days|week)|daily|7 days)\b/.test(t)) return [0, 1, 2, 3, 4, 5, 6];
    const days = new Set();
    if (/\bweekdays?\b/.test(t)) [1, 2, 3, 4, 5].forEach((d) => days.add(d));
    if (/\bweekends?\b/.test(t)) [0, 6].forEach((d) => days.add(d));
    const rest = t.replace(new RegExp(`\\b${WEEKDAY} ?(?:-|to|until|through|thru) ?${WEEKDAY}\\b`, 'g'), (s, a, b) => {
      for (let d = WEEKDAY_NAMES.indexOf(a); ; d = (d + 1) % 7) {
        days.add(d);
        if (d === WEEKDAY_NAMES.indexOf(b)) break;
      }
      return ' ';
    });
    for (const m of rest.matchAll(new RegExp(`\\b${WEEKDAY}\\b`, 'g'))) days.add(WEEKDAY_NAMES.indexOf(m[1]));
    return [...days].sort();
  }

  /**
   * The year of a date given without one: the next time it comes round (from today); when the option names its
   * weekday ("Monday 13th October"), the nearest year in which it falls on that day.
   */
  function slotYear(m, d, weekday, today) {
    const now = new Date(today * 864e5).getUTCFullYear();
    if (weekday != null) {
      const fits = [now - 1, now, now + 1].filter((y) => weekdayOf(dayNumber(y, m, d)) === weekday);
      if (fits.length)
        return fits.sort((a, b) => Math.abs(dayNumber(a, m, d) - today) - Math.abs(dayNumber(b, m, d) - today))[0];
    }
    return dayNumber(now, m, d) >= today ? now : now + 1;
  }

  const to24 = (h, mer) => (mer ? (h % 12) + (mer[0] === 'p' ? 12 : 0) : h);

  /**
   * One interview slot as forms write them: "Monday 13th October – 10:00-11:00", "Tue 14/10 AM", "Wednesday 15
   * October 2026 (2pm - 4pm)", "w/c 20th October", "Morning (9am-12pm)", "Any time", "None of these dates work for
   * me". Returns { ranges: [[firstDay, lastDay]…] (day numbers), weekdays, time: [from, to] (minutes), any, none,
   * agrees (a named weekday matches the date) }; `order` reads "03/11" as 'dmy' or 'mdy'.
   */
  function parseSlot(raw, today, order) {
    let t =
      ' ' +
      String(raw || '')
        .toLowerCase()
        .replace(/[–—−]/g, '-')
        .replace(/(\d)(st|nd|rd|th)\b/g, '$1')
        .replace(/\b(noon|midday)\b/g, '12pm')
        .replace(/\bmidnight\b/g, '12am')
        .replace(/\s+/g, ' ') +
      ' ';
    if (SLOT_NONE.test(t)) return { none: true };
    const slot = { ranges: [], weekdays: null, time: null };
    const week = /\b(w ?\/ ?[cb]|wc|week (commencing|beginning|starting|of))\b/.test(t);
    // Weekdays: "Mon-Fri", "Tuesday", "weekdays".
    const named = [];
    t = t.replace(new RegExp(`\\b${WEEKDAY} ?(?:-|to|until|through|thru) ?${WEEKDAY}\\b(?! ?\\d)`, 'g'), (s, a, b) => {
      for (let d = WEEKDAY_NAMES.indexOf(a); ; d = (d + 1) % 7) {
        named.push(d);
        if (d === WEEKDAY_NAMES.indexOf(b)) break;
      }
      return ' ';
    });
    t = t
      .replace(new RegExp(`\\b${WEEKDAY}\\b`, 'g'), (s, d) => (named.push(WEEKDAY_NAMES.indexOf(d)), ' '))
      .replace(/\s+/g, ' ');
    if (/\bweekdays\b/.test(t)) named.push(1, 2, 3, 4, 5);
    if (/\bweekends?\b/.test(t)) named.push(0, 6);
    // Dates: "2026-10-14", "14/10(/2026)", "14.10.2026", "13 October (2026)", "13-17 Oct", "October 13(, 2026)".
    const dates = [];
    const add = (y, m, d) => {
      if (m >= 1 && m <= 12 && d >= 1 && d <= 31) dates.push({ y: y ? (+y < 100 ? 2000 + +y : +y) : null, m, d });
      return ' @ ';
    };
    const M = MONTH_RE;
    const month = (s) => U.MONTHS.findIndex((name) => name.startsWith(s.slice(0, 3))) + 1;
    t = t.replace(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g, (s, y, m, d) => add(y, +m, +d));
    t = t.replace(/\b(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})\b/g, (s, d, m, y) => add(y, +m, +d));
    t = t.replace(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?\b/g, (s, a, b, y) => {
      let [d, m] = order === 'mdy' ? [+b, +a] : [+a, +b];
      if (m > 12) [d, m] = [m, d];
      return add(y, m, d);
    });
    const END = '(?![:.]\\d|\\d| ?[ap]\\.?m\\b)';
    t = t.replace(
      new RegExp(`\\b(\\d{1,2})(?: ?- ?(\\d{1,2})${END})? (?:of )?(${M})\\b\\.?(?:,? (20\\d{2}))?`, 'g'),
      (s, d1, d2, mon, y) =>
        d2 ? (add(y, month(mon), +d1), add(y, month(mon), +d2), ' @-@ ') : add(y, month(mon), +d1),
    );
    t = t.replace(
      new RegExp(`\\b(${M})\\b\\.? (\\d{1,2})(?: ?- ?(\\d{1,2}))?${END}(?:,? (20\\d{2}))?`, 'g'),
      (s, mon, d1, d2, y) =>
        d2 ? (add(y, month(mon), +d1), add(y, month(mon), +d2), ' @-@ ') : add(y, month(mon), +d1),
    );
    // A whole month ("May 2027"), for the dates you can't do.
    let wholeMonth = null;
    if (!dates.length)
      t = t.replace(new RegExp(`\\b(${M})\\b\\.? (20\\d{2})\\b`), (s, mon, y) => {
        wholeMonth = { y: +y, m: month(mon) };
        return ' ';
      });
    const days = dates.map((x, k) => {
      const next = x.y || slotYear(x.m, x.d, null, today);
      if (k === 0 && named.length) slot.agrees = weekdayOf(dayNumber(next, x.m, x.d)) === named[0];
      const y = x.y || slotYear(x.m, x.d, k === 0 && named.length === 1 ? named[0] : null, today);
      return dayNumber(y, x.m, x.d);
    });
    if (wholeMonth) {
      const first = dayNumber(wholeMonth.y, wholeMonth.m, 1);
      slot.ranges.push([first, dayNumber(wholeMonth.y, wholeMonth.m + 1, 1) - 1]);
    } else if (days.length === 2 && /@ ?(-|to|until|till|through|thru) ?@/.test(t)) {
      slot.ranges.push([Math.min(...days), Math.max(...days)]);
    } else for (const n of days) slot.ranges.push(week ? [n, n + 6] : [n, n]);
    if (!slot.ranges.length && named.length) slot.weekdays = [...new Set(named)];
    // Times: "10:00-11:00", "2pm - 4pm", "11-1pm", "14:30"; else "morning", "AM".
    const MER = '(am|pm|a\\.m\\.?|p\\.m\\.?)?';
    const range = t.match(
      new RegExp(
        `\\b(\\d{1,2})(?:[:.h](\\d{2}))? ?${MER} ?(?:-|to|until|till) ?(\\d{1,2})(?:[:.h](\\d{2}))? ?${MER}(?![\\w])`,
      ),
    );
    if (range && (range[2] || range[3] || range[5] || range[6]) && +range[1] <= 24 && +range[4] <= 24) {
      const [, h1, m1, a1, h2, m2, a2] = range;
      let from = to24(+h1, a1 || a2) * 60 + (+m1 || 0);
      let to = to24(+h2, a2 || a1) * 60 + (+m2 || 0);
      if (!a1 && a2 && from > to) from = to24(+h1, a2[0] === 'p' ? 'am' : 'pm') * 60 + (+m1 || 0);
      if (to <= from && to < 12 * 60) to += 12 * 60;
      slot.time = [from, to];
    } else {
      const one = t.match(
        new RegExp(`\\b(\\d{1,2})(?:[:.h](\\d{2}) ?${MER}|( ?)(am|pm|a\\.m\\.?|p\\.m\\.?))(?![\\w])`),
      );
      if (one && +one[1] <= 24) {
        const from = to24(+one[1], one[3] || one[5]) * 60 + (+one[2] || 0);
        slot.time = [from, from + 60];
      } else {
        const part = PARTS_OF_DAY.find(([re]) => re.test(t));
        if (part) slot.time = part[1];
        else if (slot.ranges.length || slot.weekdays) {
          if (/(?<!\bi )\b(am|a\.m\.)(?!\w)/.test(t)) slot.time = [9 * 60, 12 * 60];
          else if (/\b(pm|p\.m\.)(?!\w)/.test(t)) slot.time = [12 * 60, 17 * 60];
        }
      }
    }
    if (SLOT_ANY.test(t) && !slot.ranges.length && !slot.weekdays) slot.any = true;
    return slot;
  }

  /** Does a slot (parseSlot) suit you? undefined for "Any time", "None…" and options that name no day or time. */
  function slotFits(slot, a) {
    if (!slot || slot.none || slot.any) return undefined;
    if (!slot.ranges.length && !slot.weekdays && !slot.time) return undefined;
    if (slot.time && (slot.time[0] < a.from || slot.time[1] > a.to)) return false;
    if (slot.weekdays) return slot.weekdays.some((d) => a.days.includes(d));
    if (!slot.ranges.length) return a.days.length > 0;
    const free = (n) =>
      n >= a.today && a.days.includes(weekdayOf(n)) && !a.blocked.some(([from, to]) => n >= from && n <= to);
    return slot.ranges.some(([from, to]) => {
      for (let n = from; n <= Math.min(to, from + 62); n++) if (free(n)) return true;
      return false;
    });
  }

  /**
   * Every option of a slot list, parsed: "03/11" is read day first unless the list says otherwise (a "10/14", a
   * weekday that only fits month first, or a US page).
   */
  function parseSlots(texts, v) {
    const pairs = texts.flatMap((t) => [...String(t || '').matchAll(/\b(\d{1,2})\/(\d{1,2})\b/g)]);
    let order = pairs.some((m) => +m[1] > 12) ? 'dmy' : pairs.some((m) => +m[2] > 12) ? 'mdy' : null;
    if (!order && pairs.length) {
      const agree = (o) => texts.filter((t) => parseSlot(t, v.avail.today, o).agrees).length;
      const dmy = agree('dmy');
      const mdy = agree('mdy');
      order = mdy > dmy ? 'mdy' : dmy > mdy ? 'dmy' : v.dateOrder === 'mdy' ? 'mdy' : 'dmy';
    }
    return texts.map((t) => parseSlot(t, v.avail.today, order || 'dmy'));
  }

  /** Your interview availability from the profile, or null when no day is ticked (then it's left for you). */
  function availability(p, today) {
    const a = p.availability || {};
    const days = dayList(a.days);
    if (!days.length) return null;
    const now = todayNumber(today);
    const blocked = String(a.unavailable || '')
      .split(/\n|;/)
      .map((line) => parseSlot(line.replace(/\b(not available|unavailable|none)\b/gi, ' '), now, 'dmy'))
      .flatMap((s) => s.ranges || []);
    return { days, from: clockMinutes(a.from, 0), to: clockMinutes(a.to, 24 * 60) || 24 * 60, blocked, today: now };
  }

  const clockText = (n) => {
    const h = Math.floor(n / 60) % 24;
    const m = n % 60;
    if (n >= 24 * 60) return 'midnight';
    return `${h % 12 || 12}${m ? ':' + U.pad2(m) : ''}${h < 12 ? 'am' : 'pm'}`;
  };

  /** "Weekdays, 8am–8pm, except 12–23 January 2027", for a box that asks for your availability in words. */
  function availabilityText(a, p) {
    const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const order = a.days.map((d) => (d + 6) % 7).sort(); // Monday first
    const key = a.days.join(',');
    let days;
    if (a.days.length === 7) days = 'Any day';
    else if (key === '1,2,3,4,5') days = 'Weekdays';
    else if (key === '0,6') days = 'Weekends';
    else if (order.length >= 3 && order[order.length - 1] - order[0] === order.length - 1)
      days = `${labels[(order[0] + 1) % 7]}–${labels[(order[order.length - 1] + 1) % 7]}`;
    else {
      const names = order.map((i) => labels[(i + 1) % 7]);
      days = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
    }
    const hours = a.from <= 0 && a.to >= 24 * 60 ? 'any time' : `${clockText(a.from)}–${clockText(a.to)}`;
    const except = String((p.availability || {}).unavailable || '')
      .split(/\n|;/)
      .map((s) => s.replace(/\([^)]*\)/g, '').trim())
      .filter(Boolean);
    return `${days}, ${hours}` + (except.length ? `, except ${except.join(', ')}` : '');
  }

  /* ---------------------------------------------------------- "otherwise N/A" */

  // "…Otherwise, enter N/A.", "If not, please write 'None'", "(enter N/A if not applicable)": a box's word for No.
  const OTHERWISE =
    /\b(?:otherwise|if (?:not|no|none|not applicable|you (?:answered|selected|said|chose) no|(?:you )?(?:haven t|have not|were not|weren t|are not|aren t|did not|didn t|do not|don t)(?: \w+){1,3}))\b,? (?:please )?(?:enter|write|type|put|input|insert|state|answer|fill in)(?: in)? (n a|na|none|not applicable|nil|no|nothing|0)\b|\b(?:enter|write|type|put|input|insert|indicate|state|answer) (n a|na|none|not applicable|nil) (?:if|where|when) (?:not applicable|it does not apply|this does not apply|not|no|none|n a|you (?:answered|selected|said) no|you (?:do not|don t) have)\b/;
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
    return m ? val(OTHERWISE_WORDS[m[1] || m[2]], { otherwise: true, canonical: null }) : null;
  }

  /* -------------------------------------------------------------- definitions */

  const at = (path, wrap) => (p) => (wrap || val)(U.getPath(p, path));
  const simple = (label, path, wrap) => ({ label, path, get: at(path, wrap) });

  // "Undergraduate GPA", "GPA (Graduate)", "Name of secondary school": the entry at that level of study.
  const LEVEL_WORDS = [
    [
      'highschool',
      /\b(high school|(?<!\bpost )secondary( school)?|sixth form|a levels?|gcses?|academy school|abitur|baccalaureat|matura|leaving cert\w*|school graduation|school leaving|highers|international baccalaureate|ib diploma|btecs?)\b/,
    ],
    ['bachelor', /\b(undergrad\w*|bachelor\w*|bsc)\b/],
    // "Graduate studies" / "graduate transcript" is postgraduate (US usage); "undergraduate" never matches here.
    [
      'master',
      /\b(master\w*|msc|mba|post ?grad\w*|graduate (degree|school|program|programme|gpa|studies|study|student|level|transcripts?|records?|coursework))\b|\b(gpa|transcripts?) graduate\b/,
    ],
    ['doctorate', /\b(doctora\w*|ph ?d|dphil)\b/],
  ];

  /** Every level of study a question names: "academic transcripts (undergraduate and postgraduate)" names two. */
  function levelsOf(question) {
    // Examples don't count: "…graduate? This includes … studies e.g. a Masters".
    const q = String(question || '').replace(/\b(e g|eg|i e|such as|for example|including|includes|include)\b.*$/, '');
    return LEVEL_WORDS.filter(([, re]) => re.test(q)).map(([level]) => level);
  }

  // School qualifications that are not one another: GCSE grades are not A-level grades, nor Highers IB points.
  const SCHOOL_QUALS = [
    ['gcse', /\b(i ?)?gcses?\b|\bo levels?\b|\bnational 5s?\b|\bjunior cert\w*/],
    ['alevel', /\ba ?levels?\b|\bas levels?\b|\bpre ?u\b/],
    ['highers', /\b(advanced )?highers\b/],
    ['ib', /\bib\b|\binternational baccalaureate\b/],
    ['btec', /\bbtecs?\b/],
    ['leaving', /\bleaving cert\w*/],
    ['abitur', /\babitur\b/],
  ];
  const qualsOf = (text) => SCHOOL_QUALS.filter(([, re]) => re.test(text)).map(([q]) => q);

  /**
   * Is a school entry's qualification the one a question asks about? "Scottish Highers grades" for Advanced Highers,
   * "What A Level grades (or International Equivalent)…" for any; "Maths GCSE grade" never for A-levels.
   */
  function sameQualification(question, degree) {
    const asked = qualsOf(question);
    const held = qualsOf(U.normalize(degree));
    return !asked.length || !held.length || /\bequivalent\b/.test(question) || asked.some((q) => held.includes(q));
  }

  /** The one level of study a question names, or null (none, or several). */
  function eduLevelOf(question) {
    const hits = levelsOf(question);
    return hits.length === 1 ? hits[0] : null;
  }

  /**
   * The levels of study an education entry covers: a BSc (or a Scottish MA (Hons)) is 'bachelor', an integrated
   * master's (MEng, MSci…) both 'bachelor' and 'master'.
   */
  function entryLevels(e) {
    const d = U.normalize(e.degree);
    if (JTF.matcher.isIntegratedMasters(d)) return ['bachelor', 'master'];
    const level = JTF.matcher.degreeGroup(d);
    return level ? [level] : [];
  }

  // The documents an upload names: your CV, a cover letter, a transcript.
  const CV_NAMED = /\b(resumes?|cvs?|curriculum|lebenslauf)\b/;
  const LETTER_NAMED = /cover ?letter|motivation(al)? letter|letter of motivation|anschreiben|lettre de motivation/;
  const TRANSCRIPT_NAMED =
    /transcript|academic record|grade (report|sheet)|mark ?sheet|record of (marks|grades)|notenspiegel|releve de notes/;

  // Uploads that belong to one level of study: the transcript of your graduate studies is not your undergraduate one.
  const LEVEL_UPLOADS = new Set(['file.transcript']);

  /**
   * Does upload `type` take your file? "If applicable, please provide a recent transcript of your graduate studies."
   * (or "Master's transcript", "High school transcript") only when your education has an entry at that level;
   * "University transcript", "Transcript of your most recent degree" or "Academic transcripts (undergraduate and
   * postgraduate)" when you have any. An entry whose degree says no level ("Computer Science") can't rule one out.
   */
  function uploadApplies(type, profile, question) {
    if (!LEVEL_UPLOADS.has(type)) return true;
    const asked = levelsOf(question);
    if (!asked.length) return true;
    const entries = ((profile && profile.education) || []).filter((e) => !U.isBlank(e.school) || !U.isBlank(e.degree));
    const levels = entries.map(entryLevels);
    if (!levels.length || levels.some((l) => !l.length)) return true;
    return asked.some((level) => levels.some((l) => l.includes(level)));
  }

  /**
   * The other documents your CV's upload takes with it, in this order after the CV, when its box takes several files
   * (`multiple`): your cover letter when the form has no upload of its own for one (`separate`: the upload types the
   * form has), and your transcript when the upload or its heading names transcripts ("Resume/CV/Transcripts") and it
   * applies to your studies (uploadApplies). `text`: the upload's label, question and heading, normalised. A box that
   * takes one file takes just the CV.
   */
  function uploadAlso(text, { multiple, profile, separate }) {
    if (!multiple) return [];
    const out = [];
    if (!(separate && separate.has('file.coverLetter'))) out.push('file.coverLetter');
    if (TRANSCRIPT_NAMED.test(text) && uploadApplies('file.transcript', profile, text)) out.push('file.transcript');
    return out;
  }

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

  /**
   * "Country of School", "Country of Employer": from the entry's location, else the country you live in when the
   * entry is in your town ("Glasgow", or "University of Glasgow" with no location, for someone living in Glasgow).
   * Anything else is left: most students live where they study, but not all, and a wrong country is worse than none.
   */
  function entryCountry(e, p) {
    const row = placeCountry(e.location);
    if (row) return countryVal(row[2]);
    const city = U.normalize(p.address.city);
    const words = ' ' + U.normalize(U.isBlank(e.location) ? e.school || e.company : e.location) + ' ';
    if (city && words.includes(' ' + city + ' ') && JTF.geo.findCountry(p.address.country))
      return countryVal(p.address.country);
    return null;
  }

  /** The entry a question is about: the one at the level of study it names ("Undergraduate GPA"), else entry `index`. */
  function entryAt(p, list, ctx) {
    const level = list === 'education' ? eduLevelOf(ctx.question) : null;
    const e = level
      ? (p.education || []).find((x) => JTF.matcher.degreeGroup(U.normalize(x.degree)) === level)
      : (p[list] || [])[ctx.index || 0];
    return { e: e || null, level };
  }

  // Questions about your grades: answered from your profile, or left for you.
  const GRADE_TYPES = new Set(['edu.gpa', 'edu.classification', 'edu.gpaScale', 'edu.classAtLeast']);

  /**
   * Does your profile hold the grade a grade question is about (a GPA or class for that entry; for school grades, of
   * the qualification asked)? Then the rules answer it or leave it empty on purpose (a GPA box that wants a number,
   * for a UK class), and the AI never converts one grade into another.
   */
  function gradeHeld(type, p, ctx) {
    if (!GRADE_TYPES.has(type) || !p) return false;
    const { e, level } = entryAt(p, 'education', ctx || {});
    if (!e || (U.isBlank(e.gpa) && U.isBlank(e.classification))) return false;
    return level !== 'highschool' || sameQualification((ctx && ctx.question) || '', e.degree);
  }

  /**
   * An entry's end date for a form's "To" box: a stint that starts and ends in the same month (a spring week, an
   * insight day: "03/2026" to "03/2026") ends the month after, since forms turn down a "To" that isn't after "From".
   */
  function endAfterStart(e) {
    const start = U.parseDate(e.startDate);
    const end = U.parseDate(e.endDate);
    if (!start || !end || !start.month || end.day || start.year !== end.year || start.month !== end.month)
      return e.endDate;
    const next = start.year * 12 + start.month; // the month after, counted from January of year 0
    return `${Math.floor(next / 12)}-${U.pad2((next % 12) + 1)}`;
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
        const { e, level } = entryAt(p, list, ctx);
        // No studies at the level asked: "…graduate (Master) GPA? Please indicate N/A if you do not have one."
        if (!e) return level ? otherwiseVal(ctx) : null;
        if (
          level === 'highschool' &&
          ['gpa', 'class', 'subject'].includes(kind) &&
          !sameQualification(ctx.question, e.degree)
        )
          return null;
        if (kind === 'date') {
          if (key === 'endDate' && e.current) return null;
          const typical = key === 'endDate' ? 6 : 9;
          const raw = key === 'endDate' ? endAfterStart(e) : e[key];
          const v = windowAnswer(raw, ctx.question, typical) || dateVal(raw, ctx.part, typical);
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
        if (kind === 'gpa') return gpaFor(e, ctx);
        if (kind === 'class') return classFor(e, ctx);
        if (kind === 'school') return val(e[key], { kind: 'school' });
        if (kind === 'subject') return subjectVal(e[key]);
        if (kind === 'scale') return gpaScale(e, ctx);
        if (kind === 'country') return entryCountry(e, p);
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
        // Two nationalities ("British, Irish"): a text box gets both, a list the first.
        const rows = JTF.geo.nationalities(p.personal.nationality);
        const v =
          rows.length > 1
            ? Object.assign(countryVal(rows[0][2]), { text: String(p.personal.nationality).trim() })
            : countryVal(p.personal.nationality);
        // Lists of nationalities ("American", "British") as well as of countries.
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
        // "Are you a citizen of the country where this job is based?" asks about the job's country; a question that
        // names none and has no job country to go by stays unanswered.
        if (!JTF.geo.nationalitiesNamed(q).length) {
          const there = jobCountries(ctx);
          if (!there.length) return null;
          const mineCodes = JTF.geo.nationalities(p.personal.nationality).map((row) => row[0]);
          if (there.some((c) => mineCodes.includes(c))) return val('Yes');
        }
        return /permanent resident|green card|asylee|refugee|resident/.test(q) ? null : val('No');
      },
    },

    // "Please provide your university email address": yours only when it is a university's.
    email: {
      label: 'Email',
      path: 'contact.email',
      get(p, ctx) {
        const q = U.normalize((ctx && ctx.question) || '');
        const email = String(p.contact.email || '').trim();
        // "Email (university address preferred)" still takes yours.
        if (
          /\b(university|college|school|student|academic|institutional|edu) e ?mail\b/.test(q) &&
          !/\bprefer/.test(q) &&
          !ACADEMIC_EMAIL.test(email)
        )
          return val(p.contact.schoolEmail);
        return val(email);
      },
    },
    // "Your primary college/university/school email": the one you gave for it, or your email when it is a school's
    // (".ac.uk", ".edu"); never your personal address.
    'email.school': {
      label: 'University / school email',
      path: 'contact.schoolEmail',
      get(p) {
        const school = val(p.contact.schoolEmail);
        if (school) return school;
        return ACADEMIC_EMAIL.test(String(p.contact.email || '').trim()) ? val(p.contact.email) : null;
      },
    },
    phone: {
      label: 'Phone',
      path: 'contact.phone',
      get(p, ctx) {
        const num = String(p.contact.phone || '').trim();
        if (!num) return null;
        const cc = phoneCode(p);
        // "07386 526574" with +44 is "+44 7386 526574": the trunk 0 is not dialled after the code.
        const international = cc && !num.startsWith('+') ? `${cc} ${JTF.geo.afterCode(num, cc)}` : num;
        // "Country/Region Code" in a box of its own: the number goes in without it. The plan says which phone box
        // that box is beside (part "national"; "whole" for another one), else any such box on the page counts.
        const national = nationalNumber(num, cc);
        const own = ctx.part === 'national' || ctx.part === 'whole' ? ctx.part === 'national' : ctx.hasCountryCodeField;
        const full = own ? national : international;
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
    // "State (If N/A, Select Other)" on a US list, for someone who lives elsewhere: "Other".
    'address.state': {
      label: 'State / province',
      path: 'address.state',
      get(p, ctx) {
        const a = p.address;
        const v = regionVal(a.state, a.country || JTF.geo.regionCountry(a.state, a.city));
        const home = JTF.geo.findCountry(a.country);
        if (!home || home[0] === 'US' || !usStates(ctx)) return v;
        const other = ['Other', 'N/A', 'Not applicable', 'Outside the US', 'Non-US', 'International'];
        if (v) return Object.assign(v, { fallback: other });
        return /\bn ?a\b|\bnot applicable\b|\bother\b/.test(ctx.question || '')
          ? val('Other', { candidates: other })
          : null;
      },
    },
    'address.postalCode': simple('Postal code', 'address.postalCode'),
    'address.country': simple('Country', 'address.country', countryVal),
    location: {
      label: 'Location (city, state)',
      get(p, ctx) {
        const a = p.address;
        const parts = [a.city, a.state || a.country].filter((s) => !U.isBlank(s));
        if (!parts.length) return null;
        // Location autocompletes list "San Francisco, California, United States" next to
        // "San Francisco, Cebu, Philippines": spell the state and country out so the right one wins.
        const region = JTF.geo.findRegion(a.state, a.country || JTF.geo.regionCountry(a.state, a.city));
        const country = JTF.geo.findCountry(a.country);
        const state = region ? region[1] : a.state;
        const countryName = country ? country[2] : a.country;
        const spelled = [
          [a.city, state, countryName],
          [a.city, state],
          [a.city, countryName],
        ].map((list) => list.filter((s) => !U.isBlank(s)).join(', '));
        const candidates = [parts.join(', '), ...spelled].concat(a.city && parts.length > 1 ? [a.city] : []);
        // "Current city", "Which city are you based in?": the city alone.
        const q = (ctx && ctx.question) || '';
        const cityOnly = /\bcity\b/.test(q) && !/\b(state|country|region|province|county|location|address)\b/.test(q);
        // Words that tell two same-named cities apart.
        const near = [
          ...(region || [a.state]),
          ...(country ? JTF.geo.countryCandidates(a.country) : [a.country]),
        ].filter((s) => !U.isBlank(s));
        return val(cityOnly && a.city ? a.city : parts.join(', '), {
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
    // A question naming no country is about the job's ("…in the country where this role is based?").
    'job.authorized': {
      label: 'Authorized to work',
      path: 'job.authorized',
      get: (p, ctx) =>
        elsewhere(p, ctx, 'authorized') || workStatus(p, ctx) || sponsorAware(val(p.job.authorized), p, 'authorized'),
    },
    'job.sponsorship': {
      label: 'Requires sponsorship',
      path: 'job.sponsorship',
      get: (p, ctx) =>
        elsewhere(p, ctx, 'sponsorship') ||
        workStatus(p, ctx) ||
        sponsorAware(val(p.job.sponsorship), p, 'sponsorship'),
    },
    'job.visa': { label: 'Holds a visa (yes/no)', get: visaHeld },
    // "Are you located in London?" / "Are you based in the UK?": from your address (Glasgow is in the UK, not London).
    'location.in': {
      label: 'Lives in the place asked about',
      get(p, ctx) {
        const here = livesIn(p, JTF.geo.placesNamed(ctx.question || ''));
        return here == null ? null : val(here ? 'Yes' : 'No');
      },
    },
    // "Are you able to commute into our London office?": yes from the same city or the towns around it.
    'location.commute': {
      label: 'Can commute to the office',
      get(p, ctx) {
        const near = livesIn(p, placesAsked(ctx), true);
        return near == null ? null : val(near ? 'Yes' : 'No');
      },
    },
    'job.workIn': { label: 'Willing to work in the place asked about', get: workThere },
    'job.onsite': simple('Happy to work in the office / on site', 'job.onsite'),
    'job.adjustments': simple('Adjustments needed in the recruitment process', 'job.adjustments'),
    // "Have you applied to us before?"; "Have you interviewed with Jane Street before?" is No when you never applied.
    'compliance.previouslyApplied': {
      label: 'Applied here before',
      path: 'compliance.previouslyApplied',
      get(p, ctx) {
        const v = val(p.compliance.previouslyApplied);
        if (v && /\binterview/.test(ctx.question || '')) return v.canonical === 'no' ? v : null;
        return v;
      },
    },
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
    // "Please rank your location preference: Austin, Chicago, Greenwich, Houston, New York" in a text box names its own
    // list: only the places you prefer that it names, else nothing.
    'job.locations': {
      label: 'Preferred locations',
      path: 'job.locations',
      get(p, ctx) {
        const v = listVal(p.job.locations);
        const named = JTF.geo.placesNamed(ctx.question || '').filter((pl) => pl.type === 'metro');
        if (!v || !LONG_TEXT.includes(ctx.kind) || named.length < 2) return v;
        const q = ' ' + (ctx.question || '') + ' ';
        const listed = v.items.filter(
          (item) =>
            q.includes(' ' + U.normalize(item) + ' ') ||
            JTF.geo.placesNamed(item).some((pl) => pl.type === 'metro' && named.some((n) => n.metro === pl.metro)),
        );
        return listed.length ? listVal(listed.join(', ')) : null;
      },
    },
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
    // "Approximately when do you expect to begin full time employment?": once the degree you are on ends, or from the
    // start date you gave when that is later.
    'job.fullTimeStart': {
      label: 'Full-time employment start',
      get(p, ctx) {
        const now = ctx.today || new Date();
        const months = (d) => d.year * 12 + (d.month || 6) - 1;
        const nowM = now.getFullYear() * 12 + now.getMonth();
        const ends = (p.education || [])
          .map((e) => ({ raw: e.endDate, d: U.parseDate(e.endDate) }))
          .filter((x) => x.d && months(x.d) >= nowM)
          .sort((a, b) => months(b.d) - months(a.d));
        const start = U.parseDate(p.job.startDate);
        const raw = ends.length && !(start && months(start) > months(ends[0].d)) ? ends[0].raw : p.job.startDate;
        return dateVal(raw, ctx.part, 9);
      },
    },
    // "Do you require a visitor visa to enter the UK for your interviews?": No for a citizen of a country with the
    // right to work there (the UK, Ireland, the EU's free movement); otherwise left for you.
    'job.visitorVisa': {
      label: 'Visitor visa for interviews',
      get(p, ctx) {
        let { codes } = countriesAsked(ctx.question, null);
        if (!codes.length) codes = jobCountries(ctx);
        const nations = JTF.geo.nationalities(p.personal.nationality).map((row) => row[0]);
        if (codes.length !== 1 || !nations.length) return null;
        return JTF.geo.workRights(nations).has(codes[0]) ? val('No') : null;
      },
    },
    'job.startDate': {
      label: 'Available start date',
      path: 'job.startDate',
      get(p, ctx) {
        const answer = availableAnswer(p.job.startDate, ctx.question, ctx.today);
        if (answer) return answer;
        // The earliest you can start: never an option that starts before it (matcher.bestDate).
        const v = dateVal(p.job.startDate, ctx.part, 9);
        return v && v.date ? Object.assign(v, { earliest: true }) : v;
      },
    },
    // A job site the form doesn't list ("Trackr") still picks its kind ("Online job board"), else "Other". Left
    // blank it is LinkedIn; "-" leaves the question for you.
    'job.referralSource': {
      label: 'How you heard about the job',
      path: 'job.referralSource',
      get(p) {
        const raw = String(p.job.referralSource || '').trim();
        if (/^[-–—]+$/.test(raw)) return null;
        const v = val(raw || 'LinkedIn');
        const words = U.normalize(v.text).split(' ');
        const kind = SOURCE_KINDS.find(([re]) => re.test(words.join(' ')));
        v.candidates = [v.text, ...(kind ? kind[1] : [])];
        if (kind && kind[1] === JOB_SITE) v.avoid = NOT_A_JOB_SITE;
        // An option that names it wins over broader ones: "Job Board / LinkedIn", "Social Media (LinkedIn, …)".
        if (words.length <= 3) v.named = new RegExp(`\\b${words.join(' ?')}\\b`);
        v.fallback = ['Other', 'Other (please specify)', 'Others', 'Something else'];
        return v;
      },
    },
    // "Please provide the name and team of your referrer. If you haven't been referred please state n/a", "If you were
    // referred by a Graham Capital employee, please enter their name. If not, write N/A.": the word it asks for, when
    // where you heard about the job is no referral. A referral's name is yours to give.
    'job.referrer': {
      label: 'Who referred you',
      get(p, ctx) {
        const source = U.normalize(p.job.referralSource || '');
        return /\b(referr\w*|refer|employee|friend|colleague|relative|family)\b/.test(source)
          ? null
          : otherwiseVal(ctx);
      },
    },
    // "What is your communication preference?", "Preferred method of contact".
    'contact.preference': {
      label: 'Preferred contact method',
      path: 'contact.preferredContact',
      get(p) {
        const v = withSpellings(p.contact.preferredContact, CONTACT_METHODS);
        // Never a marketing opt-in offered in the same list ("Email me job alerts").
        if (v) v.avoid = /\b(marketing|newsletters?|promotions?|alerts?|updates|offers|news|subscribe)\b/;
        return v;
      },
    },
    // "Please confirm whether any of the below applies to you… U.S. sanctions and export controls": each statement
    // true of you (sanctionsApplies), else "None of the above"; its follow-up "Not applicable (I selected none of the
    // above)". Yes / No versions ("Are you a citizen or resident of Cuba, Iran…?") are answered the same way. Left for
    // you whenever your profile can't tell (no nationality, a region of Ukraine, Russia and relocating unknown).
    'compliance.sanctions': {
      label: 'Sanctions / export-control declaration',
      get(p, ctx) {
        const facts = sanctionFacts(p);
        if (!facts.nations && !facts.home) return null;
        const q = ctx.question || '';
        const followUp = SANCTIONS_FOLLOW_UP.test(q);
        const asked = followUp ? undefined : sanctionsApplies(q, facts);
        const answer = asked === true ? 'Yes' : asked === false ? 'No' : null;
        const clear = sanctionsClear(facts);
        return val(answer || (clear ? 'None of the above' : 'It depends'), {
          kind: 'sanctions',
          facts,
          followUp,
          clear,
          answer,
          many: true,
          canonical: answer ? answer.toLowerCase() : null,
        });
      },
    },
    // "Please select ALL dates/times for which you are available", "Which of these slots work for you?": every slot
    // your days, hours and free dates allow (one choice: the earliest); a text box gets "Weekdays, 8am–8pm".
    'job.availability': {
      label: 'Interview availability',
      get(p, ctx) {
        const a = availability(p, ctx.today);
        if (!a) return null;
        const text = availabilityText(a, p);
        if (LONG_TEXT.includes(ctx.kind)) return val(text, { canonical: null });
        return val(text, { kind: 'availability', avail: a, many: true, dateOrder: ctx.dateOrder, canonical: null });
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
    // "Do you identify as LGBTQIA+?": from your orientation and gender identity; No when neither says otherwise.
    'eeo.lgbt': {
      label: 'LGBTQ+',
      get(p) {
        const o = U.normalize(p.eeo.sexualOrientation);
        const canon = (t) => (JTF.matcher ? JTF.matcher.canonicalOf(t) : null);
        const same = canon(p.eeo.genderIdentitySame);
        if (same === 'no' || (o && !/^heterosexual|^straight|prefer not|decline/.test(o))) return val('Yes');
        if (canon(o) === 'decline' || (!o && same === 'decline')) return val('Prefer not to say');
        return val('No');
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
      get: (p, ctx) => detailsIfYes(p.compliance.relatives, p.compliance.relativesDetails, ctx),
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
        // "You, any member of your household, or any business partner…": a statement about you and them.
        const self =
          !family ||
          (/^you\b|\b(you or|you and|yourself|are you (a|an|currently|now|ever|or)|have you (ever )?(been|held|worked)|were you)\b/.test(
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
      get(p, ctx) {
        const canon = (t) => (JTF.matcher ? JTF.matcher.canonicalOf(t) : null);
        const answers = [p.compliance.governmentOfficial, p.compliance.familyGovernmentOfficial].map(canon);
        const answer = answers.includes('yes') ? 'Yes' : answers.every((x) => x === 'no') ? 'No' : '';
        return detailsIfYes(answer, p.compliance.governmentDetails, ctx);
      },
    },

    'compliance.criminal': simple('Criminal convictions', 'compliance.criminal'),
    'compliance.regulatory': simple('Regulatory or disciplinary action', 'compliance.regulatory'),
    // "Do any of the following apply to you?" over statements ("You are currently serving as a Government Official…",
    // "…subject to post-employment restrictions…") and "None of these apply to me": each statement is answered as the
    // Yes / No question it is (matcher.declarationList), "None…" only when every one is a No. Left for you when your
    // profile can't tell one of them.
    'compliance.declarations': {
      label: 'Declarations (government, relatives, regulatory)',
      get(p, ctx) {
        const list = JTF.matcher ? JTF.matcher.declarationList(ctx.options) : null;
        if (!list) return null;
        const yes = [];
        for (const st of list.statements) {
          const v = resolve(st.type, p, {
            ...ctx,
            question: U.normalize(st.text),
            kind: 'radio',
            options: [{ text: 'Yes' }, { text: 'No' }],
          });
          const answer = v && v.canonical;
          if (answer === 'yes') yes.push(st.text);
          else if (answer !== 'no') return null;
        }
        const items = yes.length ? yes : [list.none.text];
        return val(items.join('; '), { kind: 'list', items, candidates: items, canonical: null });
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
        // "Are you the first in your family to go to university?" asks the opposite; No when you haven't said.
        if (/\bfirst\b.*\b(family|generation)\b|\bfirst generation\b/.test(ctx.question || '')) {
          if (!v || v.canonical === 'yes') return val('No');
          if (v.canonical === 'no') return val('Yes');
        }
        const unsettled = v && PARENT_LEVEL_UNSETTLED[v.canonical];
        if (unsettled) v.avoid = (o) => unsettled(U.normalize(o.text.replace(/\([^)]*\)/g, ' ')));
        return v;
      },
    },
    'eeo.parentOccupation': {
      label: 'Main household earner’s job at 14',
      path: 'eeo.parentOccupation',
      get: (p) => withSpellings(p.eeo.parentOccupation, OCCUPATIONS),
    },
    // "Which socio-economic background do you identify with? [Professional / Intermediate / Working class]" and "…would
    // you describe yourself as coming from a lower socio-economic background?": from the household earner's job.
    'eeo.socioEconomic': {
      label: 'Socio-economic background (household earner’s job at 14)',
      get(p, ctx) {
        const v = val(p.eeo.parentOccupation);
        // Bain's "Do you identify with the experience of growing up in a lower socio-economic household?": Yes for
        // a working-class background or free school meals, else No.
        const lower = /\b(lower|low income|disadvantaged)\b/.test(ctx.question || '');
        if (lower && (!v || v.canonical !== 'decline')) {
          const meals = JTF.matcher ? JTF.matcher.canonicalOf(p.eeo.freeSchoolMeals) : null;
          return val(BACKGROUND_OF[v && v.text] === 'working' || meals === 'yes' ? 'Yes' : 'No');
        }
        if (!v || v.canonical === 'decline') return v;
        const bg = BACKGROUND_OF[v.text];
        if (!bg) return null;
        return val(BACKGROUNDS[bg][0], { candidates: BACKGROUNDS[bg] });
      },
    },
    // Bain's "Have you participated in the following organizations? [AfroTech, ALPFA, Forte, MLT…, Prefer not to say]":
    // the ones your CV entries name, else "None of the above" (or "Prefer not to say" where that's all there is).
    'eeo.organisations': {
      label: 'Diversity organisations taken part in',
      get(p, ctx) {
        const texts = (ctx.options || []).map((o) => (o && typeof o === 'object' ? o.text : String(o)));
        const mine = texts.filter((t) => namedInProfile(p, t));
        if (mine.length) return val(mine.join(', '), { kind: 'list', items: mine });
        if (!texts.length) return val('None');
        const none = texts.find((t) => JTF.matcher && JTF.matcher.NONE_OPTION.test(U.normalize(t)));
        const decline = texts.find((t) => JTF.matcher && JTF.matcher.canonicalOf(t) === 'decline');
        const no = texts.find((t) => U.normalize(t) === 'no');
        const pick = none || no || decline;
        return pick ? val(pick, { canonical: null }) : null;
      },
    },

    'edu.level': { label: 'Highest education', get: (p) => degreeVal(((p.education || [])[0] || {}).degree) },
    // A school is matched by the words that tell institutions apart: never "Glasgow Caledonian" for "Glasgow".
    'edu.school': entry('School / university', 'education', 'school', 'school'),
    'edu.degree': entry('Degree', 'education', 'degree', 'degree'),
    // "Computing Science" picks "Computer Science", or "STEM (… Computer Science …)"; "Science" only as a last resort.
    'edu.field': entry('Field of study', 'education', 'field', 'subject'),
    'edu.gpa': entry('GPA', 'education', 'gpa', 'gpa'),
    'edu.classification': entry('Degree classification', 'education', 'classification', 'class'),
    // Worked out from the GPA or class (never learnt into them).
    'edu.gpaScale': Object.assign(entry('GPA scale', 'education', 'gpa', 'scale'), { derived: true }),
    'edu.classAtLeast': { label: 'Degree class at least (yes/no)', get: classAtLeast },
    'edu.location': entry('School location', 'education', 'location'),
    // Worked out from the entry's location (never learnt into it).
    'edu.country': Object.assign(entry('Country of school', 'education', 'location', 'country'), { derived: true }),
    'edu.start': entry('Education start date', 'education', 'startDate', 'date'),
    'edu.end': entry('Graduation date', 'education', 'endDate', 'date'),
    'edu.year': {
      label: 'Year of study',
      get: (p, ctx) => (YEAR_ASKED.test(ctx.question || '') ? yearAnswer(p, ctx) : studyYear(p, ctx.today)),
    },
    'edu.enrolled': { label: 'Currently enrolled', get: (p, ctx) => enrolment(p, ctx.today, ctx.question) },

    'exp.company': entry('Company', 'experience', 'company'),
    'exp.title': entry('Job title', 'experience', 'title'),
    'exp.location': entry('Job location', 'experience', 'location'),
    'exp.country': Object.assign(entry('Country of employer', 'experience', 'location', 'country'), { derived: true }),
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
      get(p, ctx) {
        if (!ctx.consents) return null;
        // "I confirm that the listed dates are suitable for me; 14th June – 22nd August" as a box to tick: not when
        // you can only start later.
        const dates = availableAnswer((p.job || {}).startDate, ctx.question, ctx.today);
        return dates && dates.text === 'No' ? null : val('Yes', { consent: true });
      },
    },

    'file.resume': { label: 'Resume file', file: 'resume', get: () => null },
    'file.coverLetter': { label: 'Cover letter file', file: 'coverLetter', get: () => null },
    // Only for a level of study you have an entry at (uploadApplies): not "…of your graduate studies" for a BSc.
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
    'job.fullTimeStart',
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

  // "1st Stage Video Interview Availability — Please select ALL dates/times for which you are available", "Which of
  // these slots work for you?", "Assessment centre dates", "Select your preferred interview slot(s)".
  const INTERVIEW_SLOTS =
    /\b(interview|assessment|video (call|interview)|phone screen|superday|assessment cent(re|er)|call)s? (availability|slots?|dates?|times?|sessions?)\b|\bavailab\w* (for|to (attend|do|join|take part in)) (an |the |a |your |our )?(\w+ ){0,2}(interviews?|assessments?|assessment cent(re|er)s?|calls?|superdays?)\b|\b(dates?|times?|slots?|days?)( (and |or )?(dates?|times?))? (for which|when|that|on which) you (are|re|would be|will be|can be) (available|free)\b|\bwhich (of (these|the following) )?(dates?|times?|days?|slots?|sessions?)( (and |or )?(dates?|times?|slots?))? (work|suit|are you available|would you be available|can you (make|attend|do))\b|\bpreferred (interview |assessment )?(time ?)?(slots?|sessions?)\b|\b(select|choose|pick|book) (your |a |an |all )?(preferred )?(interview |assessment )?(time ?)?slots?\b/;

  // The whole number, its code included: "Mobile number (inc. country code)", "Telephone number (with international
  // dialling code)", "Phone number, including country and area code", "Mobile (incl. dialling code)", "Mobile phone
  // number (country code + number)", "Phone number (country code first)", "Mobile Number (+CountryCode)" (the matcher
  // reads that plus as a word), "…start with a + and then the country code".
  const WHOLE_NUMBER =
    /\b(start|begin)s? with\b|\b(inc|incl|including|include|with|plus|then|followed by) (the |your |a |an )?((country|international|dial(l)?ing|calling|area|and) )*code\b|\bcountry code (first|(and|plus|then|followed by) (your |the )?((phone|mobile|telephone) )?number)\b/;
  // Not the number: a code box ("Phone country", "Phone area code", "Enter the code sent to your mobile") unless the
  // code goes in with the number, an extension, fax, someone else's phone or a texting opt-in.
  const PHONE_NOT = new RegExp(
    `^(?!.*(${WHOLE_NUMBER.source})).*((?<!\\b(inc|incl|including|include|with|plus|then|the|your|a|by) )\\bcountry\\b|(?<!\\bcountry )\\bcode\\b)|` +
      /type|\bext\b|extension|fax|device|prefix|emergency|referr|reference|manager|supervisor|employer|company|business|organi[sz]ation|\bsms\b|text messag|consent/
        .source,
  );
  // "Alternative phone number", "Secondary phone", "WhatsApp number (if different)", "Landline": another number than
  // your mobile, which already goes in the form's main phone box. Left empty ("Phone (mobile or landline)" isn't).
  const OTHER_PHONE =
    /\b(alternat(e|ive)|alt|secondary|second|additional|other|another|backup|2nd) (phone|mobile|telephone|tel|cell|contact|number)\b|\bif (it is |its )?different\b|(?<!\b(mobile|cell|cellular) or )\bland ?line\b(?! or (mobile|cell))/;

  // Order matters only for ties: put specific rules (and long questions that
  // mention other keywords, like "authorized to work in the country…") first.
  const RULES = [
    // Documents
    // "Please attach your cover letter and resume in a single combined document" takes the CV, and so does an upload
    // that names the CV with other documents ("Resume/CV/Transcripts", "CV and cover letter"): see uploadAlso.
    R('file.coverLetter', LETTER_NAMED, { kinds: ['file'], not: CV_NAMED }),
    R('file.transcript', TRANSCRIPT_NAMED, {
      kinds: ['file'],
      not: /\bcover ?letter\b/,
      // "Resume/CV/Transcripts" over Workday's "(transcripts are required for all US applications)" is the CV's.
      notAny: CV_NAMED,
    }),
    R('file.resume', /resume|\bcv\b|curriculum|lebenslauf|attach|upload|document|\bfile\b/, {
      kinds: ['file'],
      // "Autofill from resume" / "Apply with resume" read the file and rewrite the form: not the resume upload.
      not: /photo|picture|image|avatar|headshot|^(?!.*\b(resume|cv)\b).*(\b(portfolio|cover)\b|transcript)|certificat|passport|\bid\b|writing sample|\b(other|additional|supporting|further) (\w+ )?(documents?|files?|attachments?|materials?)\b|auto ?fill|automatically fill|apply with (your )?(resume|cv)|pre ?fill|parse/,
      // An "Attach" button whose id or group says "cover letter" is not the resume upload.
      // So is a "Portfolio" upload, unless it also asks for the CV ("Resume / portfolio").
      // So is a code sample or a programming exercise ("If you would like to share a file of your code sample…",
      // "Write a program in C++ … Attach the file").
      notAny:
        /^(?!.*\b(resume|cv|curriculum)\b).*(cover ?letter|motivation(al)? letter|letter of motivation|anschreiben|lettre de motivation|\b(portfolio|work samples?)\b|\b(other|additional|supporting|further) (\w+ )?(documents?|files?|attachments?|materials?)\b|\bcode samples?\b|\bsamples? of (your )?code\b|\bwrite a (program|function|script)\b|\b(coding|programming) (exercise|task|assignment|challenge|test|question)\b|\bsource code\b|transcript)|writing sample|headshot|photo|passport/,
      // …unless what it says names the CV too: "Resume/CV/Transcripts" above a "(transcripts are required…)" note.
      unlessAny: CV_NAMED,
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
    // US sanctions and export controls: "Are you a citizen or resident of Cuba, Iran, North Korea, Syria, or the Crimea
    // region…?", "…ordinarily resident in a comprehensively sanctioned country or region?", "…a national of any country
    // subject to US embargo (E:1/E:2 countries)?". Never your nationality, a citizenship or a refugee question.
    R(
      'compliance.sanctions',
      new RegExp(
        `\\b(sanction(s|ed)?|embargo(ed|es)?)\\b.*\\b(countr(y|ies)|regions?|territor(y|ies)|jurisdictions?|citizen\\w*|nationals?|nationality|residen\\w*|located|live|living|lived|based|ordinarily)\\b|\\b(countr(y|ies)|regions?|territor(y|ies)|jurisdictions?|citizen\\w*|nationals?|nationality|residen\\w*|located|ordinarily)\\b.*\\b(sanction(s|ed)?|embargo(ed|es)?)\\b|\\bsanctions (and|&) export controls?\\b|\\bexport controls? (and|&) sanctions\\b|\\bofac\\b|\\bcountry group e ?[12]\\b|\\be 1 (and |or )?e 2\\b|${TWO_SANCTIONED_PLACES.source}`,
      ),
      {
        kinds: CHOICE,
        // Not where you'd work or have been ("Are you willing to travel to Cuba or Iran?"), nor an ethnicity, nor a
        // list of US visas ("…sponsorship would include F-1 OPT, H-1B, … E-1/E-2, and E-3": treaty visas, not E:1/E:2).
        not: /\b(disciplinary|regulatory|professional|criminal)\b|\bsponsor\w*|\bvisas?\b|\bh ?1 ?b\b|\bimmigration\b|\bconsent\b|\b(willing|happy|open|prepared) to\b|\btravel\w*|\bvisit\w*|\bdo(ing)? business\b|\bethnic\w*|\brace\b|\bheritage\b|\bancestr\w*|\bdescent\b|\blanguages?\b/,
        // A lone box is a statement about you ("I am not a citizen or resident of…") or its "None of the above",
        // never an acknowledgement that mentions sanctions.
        test: (desc, hit) =>
          desc.kind !== 'checkbox' ||
          /\b(citizen\w*|nationals?|nationality|residen\w*|located|live|living)\b/.test(hit) ||
          TWO_SANCTIONED_PLACES.test(hit) ||
          /^(none|not applicable)\b|\bnone of\b/.test(U.normalize(((desc.options || [])[0] || {}).text)),
      },
    ),
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
        not: /adjustments?\b|accommodat|\bvisitor visa\b|\bvisa to (enter|visit|travel)\b/,
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
      /\b(authori[sz]ed|eligible|entitled|permitted|allowed) to (lawfully |legally )?work|work (authori[sz]ation|permit|eligibility)|employment (authori[sz]ation|eligibility)|eligib(le|ility) (for|to) (employment|work)|authori[sz]ation to work|right to work|legal right to|legally (work|employed)|\bimmigration status\b/,
      // "Will you in the future require authorization to work in the US?" asks whether you need sponsoring.
      { not: /\b(require|need)\b.{0,30}\b(work )?authori[sz]ation\b/ },
    ),
    // "Are you able to work in the UK?" is about permission; "able to work on-site 5 days a week" is not.
    R('job.authorized', /\bable to (lawfully |legally )?work\b/, {
      not: /\bon ?site\b|in (the |our )?office|in person|days (a|per) week|\bcommute|\bhybrid\b|\bshifts?\b|weekends?|overtime|consecutive|full ?time for/,
    }),
    // "Do you hold a valid UK visa?" (never "a visa that allows you to work…", which asks for your right to work).
    R(
      'job.visa',
      /^(do|does) you (currently )?(hold|have|possess)( a| an| any)?( valid| current| active)? (\w+ ){0,2}visas?\b/,
      {
        kinds: CHOICE,
        not: /\bsponsor|\bor\b.*\b(citizen|right to work|settled|indefinite|permanent|passport|residen)|\bif (yes|so)\b|\b(type|expir\w*|number)\b|\b(allows?|permits?|entitles?|lets) you to\b|\bwork (in|for)\b/,
      },
    ),
    // "Are you able to commute into our London office?", "Do you live within commuting distance of our London office?"
    R(
      'location.commute',
      /\b(able|willing|happy|prepared) to commute\b|\bcommut\w* distance\b|\bcommutable\b|\b(can|could) you commute\b|\bcommute (in ?to|to) (our|the)\b/,
      { kinds: CHOICE.concat(['text']), not: /relocat/ },
    ),
    // "Are you located in London?", "Are you based in the UK?", "Are you currently living in the UK?"
    R(
      'location.in',
      /^(are|is) you (currently |presently |now )?(located|based|living|residing|resident|situated) (in|within|near|around|close to) |^do you (currently |presently )?(live|reside) (in|within|near|close to) /,
      {
        kinds: CHOICE.concat(['text']),
        not: /relocat|commut|willing/,
        test: (desc, hit) => JTF.geo.placesNamed(hit).length > 0,
      },
    ),
    // "Willing to work in London?", "Would you be willing to be based in our London office?", and "…onsite at our
    // Chicago office 5 days a week?" (job.onsite leaves offices somewhere in particular to this).
    R(
      'job.workIn',
      /\b(willing|happy|open|prepared) to (work|working|be based|be located|live|be)\b.*\b(in|at|from|out of|near)\b/,
      {
        kinds: CHOICE.concat(['text']),
        not: /relocat|commut|\bremote(ly)?\b/,
        test: (desc, hit) => JTF.geo.placesNamed(hit).length > 0,
      },
    ),
    R(
      'job.locations',
      /\blocations?\b.*\b(interested|prefer|willing|open to|relocat|consider|like to work|want to work)|\b(preferred|desired|target|ideal) (work |office |job |internship |role )?(locations?|offices?|cities)|\bwhich (other )?(offices?|locations?|cities)\b|\b(office|location|city) preferences?\b|where would you (like|prefer|want) to (work|be based)|\brelocat\w* (where|which (cities|locations|offices))\b|^where\b.*\brelocat/,
      // "…willing to relocate to one of the following locations New York… Please confirm" [Yes / No] is about relocating.
      { test: (desc) => !hasYesNoOptions(desc) },
    ),
    R('job.relocate', /relocat/, { not: /adjustments?\b|accommodat/ }),
    R(
      'job.over18',
      /\b(18|eighteen)\b.*\b(years|older|age)\b|\b(at least|over|above|older than) (the age of )?(18|eighteen)\b|legal (working )?age|age of majority/,
    ),
    R(
      'job.referralSource',
      /how did you (first )?(hear|find|learn|come across|discover|get to know|connect with)|where did you (first )?(hear|find|learn|see|discover|come across)|hear(d)? about (us|this|the)|learn(ed)? about (us|this|the)|source of (application|referral|hire|candidate)|referral source|^source$|how were you referred|found (us|this|the job)/,
    ),
    R(
      'job.referrer',
      /\b(name|names|details|team)\b.{0,40}\breferr(er|al)s?\b|\breferred (to us |to you )?by\b.{0,80}\b(name|names)\b|\breferr(er|al) s? (name|full name)\b/,
      { kinds: LONG_TEXT },
    ),
    // The list that follows "How did you first hear about BNY?" (Job Board → "Please select the specific source").
    R(
      'job.referralSource',
      /\b(specific|exact|detailed) source\b|\bsource (details?|name|specifics)\b|\bspecify (the |your )?source\b|\bwhich (job board|job site|jobs? website|social (media|network)( platform| site)?)\b/,
      { kinds: CHOICE },
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
      /\b(other|competing|outstanding|existing|pending) (job |internship |employment )?offers?\b|\boffers? (from|at|with) (other|another|any other) (firms?|compan|employers?|organi)|\boffers? (and|or|&) deadlines?|\bdeadlines? (we|that we) should\b|\bany (other )?(offers|deadlines)\b|\bexploding offer|\b(upcoming|pending|current|any) (offer )?deadlines?\b|\boffer deadlines?\b|\bdecision (deadlines?|timelines?)\b|\brecruiting timelines?\b|\btimelines? (we|that we) should\b|\baccepted an? (\w+ ){0,3}offer\b|\b(holding|hold) any (\w+ )?offers?\b|\b(other )?(processes|interviews) (and |or )?(offers|timelines)\b/,
      { not: /\bif (yes|so)\b|\bwhich (firm|company)\b|\bwhat (firm|company)\b/ },
    ),
    // "Have you applied to Marshall Wace before?"
    R(
      'compliance.previouslyApplied',
      /\b(previously|ever|already) applied\b|\bapplied (to|for|with|at)\b.{0,60}\b(before|previously|in the past|last year|this year)\b|\bhave you applied (to|for|with)\b|\b(have|did) you (ever |previously )?(been )?interview(ed)? (with|at|for)\b(?!.*\b(affiliates?|portfolio|subsidiar\w*|group compan\w*)\b)/,
      // "If yes, when?" after it is its follow-up; "Have you ever applied… before? If yes, please list dates and
      // position." in one box is the question.
      { kinds: CHOICE.concat(LONG_TEXT), not: /^if (yes|so)\b|\bwhen and\b/ },
    ),
    // "Do you require any reasonable adjustments to participate in the recruitment process?"
    R(
      'job.adjustments',
      /\breasonable adjustments?\b|\b(require|need|request)\b.{0,40}\b(adjustments?|accommodations?|support|(special|additional|access) (requirements?|arrangements?|needs|assistance))\b.{0,60}\b(recruitment|application|interview|assessment|selection|hiring)\b|\badjustments? (to|during|in|for) (the |our )?(recruitment|application|interview|assessment|selection)/,
      {
        // A text box asking it as a yes/no question ("Do you require any special requirements if you are invited to
        // attend an interview?" on Phenom) takes the answer too; one asking what they are is left for you.
        kinds: CHOICE.concat(LONG_TEXT),
        test: (desc, text) =>
          CHOICE.includes(desc.kind) || /^(do|does|will|would|are|is|have|has) (you|there)\b/.test(text),
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
    // Interview slots (see INTERVIEW_SLOTS), never an essay box or a working pattern ("Which days are you available to
    // work?").
    R('job.availability', INTERVIEW_SLOTS, {
      kinds: CHOICE.concat(LONG_TEXT),
      not: /\b(available|availability|dates?|start)\b.{0,20}\b(to|for) (the |this |our )?(work|start|begin|commence|join|intern(ship)?|placement|programme|program|employment|role|position)\b|\bshifts?\b|\bper week\b|\bhours per\b/,
    }),
    // "Approximately when do you expect to begin full time employment?" (Jane Street, of a student).
    R(
      'job.fullTimeStart',
      /\b(expect|plan|intend|anticipate|hope|looking|likely) to (begin|start|commence|enter|seek)\b.{0,30}\b(full ?time|permanent|graduate) (employment|work|job|role|position)s?\b|\b(begin|start|commence)\w* (full ?time|permanent) (employment|work)\b/,
      { kinds: CHOICE.concat(TEXTISH) },
    ),
    // "Do you require a visitor visa to enter the UK for your interviews?": a visit, not work sponsorship.
    R(
      'job.visitorVisa',
      /\bvisitor visa\b|\b(visa|eta|electronic travel authori[sz]ation) to (enter|visit|travel to)\b/,
      { kinds: CHOICE },
    ),
    R(
      'job.startDate',
      /when (can|could|would) you (like to |be able to )?(start|begin|join)|when (are|will) you (be )?(able|available) to (start|begin|join)|available (start|to start|to begin|from)|\bavailability\b|earliest (possible )?(start|date)|date (you are )?available|(desired|preferred) start|expected start|join(ing)? date|how soon|start (date|dates) (for|of) (the|this|your) (internship|placement|programme|program|role|position|job)|\bdate (that )?you (could|can|would|will) (start|begin|join)\b|\b(ready|available) for (full ?time )?(employment|work)\b|\beintritt\w*|\bdisponibilit[ea]\b|\bdate de debut\b|\b(will|would|could|can) (you )?be (able|available) to (start|begin|commence|join)\b|\b(what|which) date\b.*\bavailab|\bwhen (are|will|would) you (be )?available\b/,
      { not: INTERVIEW_SLOTS },
    ),
    // "The internship runs from 1 July to 30 September 2027. Can you confirm that you are available…?"
    R(
      'job.startDate',
      new RegExp(`\\bfrom (\\d{1,2}(st|nd|rd|th)? )?(${MONTH_RE})\\b.*\\b(to|until|till|through)\\b.*\\bavailab`),
      { not: INTERVIEW_SLOTS },
    ),
    // "I confirm that the listed dates are suitable for me; 14th June – 22nd August": dates to check your start date
    // against (availableAnswer), not an acknowledgement. Without dates it stays one.
    R('job.startDate', /\bdates?\b.*\b(suits?|suitable|convenient|work for (me|you))\b/, {
      kinds: CHOICE,
      not: INTERVIEW_SLOTS,
      test: (desc, text) => DAY_MONTH.test(text) || /\b(19|20)\d{2}\b/.test(text),
    }),
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
    // "I confirm that I will graduate in 2027" is a question about your date, answered from it, and so is "I confirm
    // that the listed dates are suitable for me; 14th June – 22nd August" (your start date).
    // A group of statements to tick ("you consent to our Applicant Privacy Statement" + "…to background checks")
    // too. Never an opt-in, even when only the name says "consent" (Ashby's SMS "communicationConsent").
    R('consent', CONSENT, {
      kinds: ['checkbox', 'checkboxes', 'select', 'combo', 'combobox', 'radio'],
      not: OPT_IN,
      notAny: OPT_IN,
      yieldsTo: ['edu.end', 'job.startDate'],
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
      /\bgovernment (official|employee|position|role|connection|body|agency|department|entity|minister)s?\b|\bgovernment (or regulatory )?authorit(y|ies)\b|\bpublic (official|office|servant)s?\b|\bpolitically exposed|\bpeps?\b|\bstate ?owned (entit|enterprise|compan|business)|\bforeign (government )?official|\bcivil servant|\binvolved (in|with) (the )?(government|politics)\b|\b(public|political|government) (office|position|appointment)s?\b|\bpublic (function|trust|role|post)s?\b|\bprominent public\b|\bsenior political figure/,
      {
        kinds: CHOICE.concat(LONG_TEXT),
        not: /\bengaged in enforcing\b|\benforcing (the )?laws?\b|\bequal (employment|opportunity)\b|\bfederal contractor|\bgovernment (contracts?|contractors?|funding|grants?)\b|\bvisa\b|\bsponsor/,
      },
    ),
    // Not about the company's auditors ("…employed by Ernst & Young, that engages in audit work?").
    R(
      'compliance.relatives',
      /\b(related to|relatives?|family members?|immediate family|spouse|domestic partner|close (personal )?relationship)\b.*\b(work|works|working|worked|employ|employed|employee|employees|staff)\b|\b(know|related to) any ?one (who )?(currently )?(works?|working|employed|at)\b|\b(personal|family|romantic|intimate|close) relationships? with\b.*\b(employees?|employed|staff|work\w*|current|affiliates?|subsidiar\w*|colleagues?)\b|\b(employees?|staff)\b.*\b(with whom )?you have (a |an |any )?(personal|family|romantic|close) relationship\b|\b(connected|connections?) (to|with) (any )?(current |existing )?(employees?|staff)\b/,
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
    // "Have you ever been convicted of a criminal offence?", "Do you have any unspent convictions?". Never a check you'd
    // agree to or undergo.
    R(
      'compliance.criminal',
      /\b(convicted|convictions?|criminal (record|offen[cs]es?|history|charges?|proceedings?|cases?)|unspent|(pleaded|pled) (guilty|no contest)|nolo contendere|felon(y|ies)|misdemeanou?rs?)\b/,
      {
        kinds: CHOICE,
        not: /\b(consent|willing|agree|authori[sz]e|undergo|happy to|prepared to|able to pass|background (check|screen)\w*|dbs check)\b/,
      },
    ),
    // "…any administrative or regulatory charges pending against you; been fined, or had a license revoked…", "Have you
    // ever been suspended or barred … by the Public Company Accounting Oversight Board?"
    R(
      'compliance.regulatory',
      /\b(regulatory|disciplinary|administrative|enforcement) (actions?|charges?|proceedings?|investigations?|sanctions?|history|matters?|complaints?|orders?|measures?)\b|\b(suspended|barred|expelled|censured|debarred|disqualified|struck off)\b.*\b(regulat\w*|oversight|authorit(y|ies)|exchanges?|finra|sec|fca|pra|pcaob|nfa|cftc|licen[cs]es?|registrations?|membership|professional body|association|issuer|entity)\b|\blicen[cs]es?\b.{0,40}\b(revoked|suspended|denied|withdrawn)\b|\b(revoked|suspended|denied|withdrawn|refused)\b.{0,40}\blicen[cs]es?\b|\bsubject to (an? |any )?(order|judge?ment|decree|sanction)s?\b.*\b(banking|securities|investment|financial|insurance|commodit\w*)\b|\bfined\b.*\b(regulat\w*|authorit\w*|exchange|finra|fca)\b/,
      { kinds: CHOICE, not: /\b(willing|happy to|prepared to|able to|consent|agree)\b|\bdriv(ing|er s?)\b/ },
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
    // Not a date a veteran gives (Oracle's "Veteran First Civilian Start Date" in Day / Month / Year lists, where "No"
    // would pick November).
    R('eeo.veteran', /veteran|military (service|status)|armed forces|served in the/, {
      kinds: CHOICE,
      not: /\bdates?\b|\bwhen\b/,
    }),
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
      /\bparents?\b.*\b(universit|degree|higher education|college|qualification)|\bguardians?\b.*\b(universit|degree|higher education|qualification)|\bfirst (person |member |one )?(in|of) (your|my) (immediate )?family\b.*\b(universit|college|higher education|degree)|\b(universit|college|higher education)\w*\b.*\bfirst (person |member |one )?(in|of) (your|my) (immediate )?family\b|\bfirst generation (student|university|college)|\b(qualifications?|degree|universit\w*|education)\b.*\b(parents?|guardians?)\b/,
      { kinds: CHOICE },
    ),
    R(
      'eeo.parentOccupation',
      /\b(main|highest) (household )?(income )?earner\b|\bhousehold earner\b|\boccupation of your (main )?(parent|household)|\bparents?\b.*\b(occupation|job)\b|\b(aged?|when you were) (about )?14\b/,
      { kinds: CHOICE },
    ),
    R('eeo.socioEconomic', /\bsocio ?economic\b|\bsocial (class|background)\b|\bworking class\b/, { kinds: CHOICE }),
    R(
      'eeo.organisations',
      /\b(participated|taken part|took part|been (involved|a member|part)|member of|involved (in|with)|affiliated)\b.*\b(following|these|any of the)\b.*\b(organi[sz]ations?|associations?|networks?)\b|\b(which|any) of (the following|these) (organi[sz]ations?|associations?|networks?)\b.*\b(participated|taken part|took part|involved|member|affiliated)\b/,
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
      /\bgraduat(ion|ed|e|ing)\b|expected graduation|completion (date|year)|year of (graduation|completion|passing)|class of|passing year|year (graduated|completed)|\b(course|degree|studies|programme|program) (finish|end|complete)s?\b|\b(finish|finishing|complete|completing|end|ending) (your |my |the )?(university |college |undergraduate |current |academic )?(course|degree|studies|programme|program)\b|\bend (date |year )?of (your |the )?(course|degree|studies)\b|\bleav(e|ing) (academia|university|full time education)\b|\b(finish|finished|complete|completed|leave|left) (high school|secondary school|secondary education|sixth form|(your )?a levels?)\b/,
      {
        // "undergraduate" no longer matches (\b), so "graduation year (undergraduate degrees…)" is still a date.
        // "Graduate Engineer / Summer Internship" is a job for graduates, not a date. "What year did you graduate from
        // high school?" is your school's date (eduLevelOf), "Do you expect to graduate with honours?" about the class.
        not: /^(did|have) you|^are you (a |an )?(recent |new |high school |college |university )?(graduate|grad|undergrad)|\binterested in\b|\bopportunit|post ?grad|\bgraduate (degree|school|program|student)|\bgraduate (engineer|analyst|scheme|role|position|job|programme|trainee|consultant|developer|intake|associate|internship)s?\b|\bgpa\b|\bgrades?\b|\bwith (first class )?(honou?rs|distinction|merit|a (first|2 ?1|2 ?2))\b/,
      },
    ),
    // "What year did you begin your undergraduate (e.g. Bachelor's) degree?", "When did you start your studies?".
    R(
      'edu.start',
      /\b(year|date|when)\b.*\b(did|do|will) you (begin|start|commence|enrol+|enter)\b.*\b(degree|studies|course|program(me)?|universit\w*|college|undergrad\w*|bachelor\w*|master\w*|ph ?d|doctora\w*)\b|\b(began|started|commenced) (your )?(\w+ )?(degree|studies|course|program(me)?)\b/,
      { not: /\b(job|employment|work|internship|placement|role|position)\b/ },
    ),
    R(
      'edu.enrolled',
      /\benrol+(ment|ed) status\b|\b(are|were) you (currently )?(enrol+ed|a (current )?student)\b|\bcurrent(ly)? (enrol+ed|study status|student status)\b|\b(study|student) status\b|^(are|were) you (currently |presently |now )?(a |an )?(current |full ?time )?(undergrad\w*|post ?grad\w*|graduate|masters?|phd|doctoral) student\b/,
      {
        kinds: CHOICE.concat(['textarea']),
        // "Are you currently an undergraduate student?" is about your level; "…expected graduation" is a date.
        not: /\bgraduat(?!e students?\b)|\byear\b|\bdegree subject\b|\bmajor\b|\b(which|what|name of (the|your)) (university|school|college|institution)\b/,
      },
    ),
    R('edu.year', YEAR_ASKED, { kinds: CHOICE, not: /graduat|\b(19|20)\d{2}\b|\bnext\b|\bwill be\b/ }),
    R(
      'edu.year',
      /\b(current |academic )?year of (study|studies|university|uni|college|degree|course|your (degree|course|studies|programme|program))\b|\b(what|which) year (of (your )?(study|studies|university|uni|degree|course|programme|program) )?are you (currently )?in\b|\bstudy year\b|\bcurrent year\b.*\b(study|studies|university|degree|course)\b|\byear in (school|university|college)\b|\bclass standing\b|\bacademic standing\b/,
      {
        // "If you are in your first year of studies and yet to receive your results, please type 'N/A'" asks for results.
        not: /graduat|\bstart|\bbegan|\bbegin|\bcomplet|\bfinish|\bentry|\bentered|high school|secondary|a levels?\b|gcse|\bresults?\b|\bgrades?\b|\bmarks\b/,
      },
    ),
    // "Which university are you enrolled in, or from which institution did you receive your most recent degree?"
    R(
      'edu.school',
      /^(which|what) (university|school|college|institution)\b|^name of (the |your )?(university|college)\b|^educator$|^educational (establishment|institution|provider)$/,
      {
        not: /\b(university|college) degree\b|\b(university|college|school) (course|programme|program|subject)s?\b|\bschool (type|diploma|grades?|did you attend)\b|type of school|\bgraduat\w* (year|date)|\byear\b|\bgpa\b|\bcity\b|\bcountry\b|\blocation\b/,
      },
    ),
    // "University Course" is what you study there, not the university.
    R(
      'edu.school',
      /\bschool\b|universit|college|institut(e|ion)|alma mater|academy|hochschule|\becole\b|universidad/,
      {
        not: /high school (diploma|graduate|completion)|degree|major|minor|gpa|\byear\b|\bdates?\b|\bstart|\bend\b|graduat|\blocation\b|\bcity\b|(?<!\b(please|kindly) )\bstate\b|country|^(did|have|has|are|do|does|were|was|will|would|can|is) you\b|e ?mail|address|transcript|meals|type of school|school type|kind of school|fee paying|state school|grammar school|grading|\bscale\b|\bcourses?\b/,
      },
    ),
    // "State/City/Region of School", "School Location", "City of university": where that school is.
    R(
      'edu.location',
      /\b(city|town|state|region|location|province|county|place)\b.*\b(school|universit\w*|college|institution|campus)\b|\b(school|universit\w*|college|institution|campus) (city|town|state|region|location|province|county)\b/,
      {
        kinds: TEXTISH.concat(CHOICE),
        not: /\bcountry\b|type of school|\bschool type\b|state (school|run|funded)|grammar|fee paying|independent|private|\b(14|fourteen|aged?)\b|post ?code|\bzip\b|^(are|do|did|have|were|was) you\b/,
      },
    ),
    // "Country of School", "Institution country", "Country where you obtained your degree"; "Country of Employer".
    R(
      'edu.country',
      /\bcountr(y|ies)\b.*\b(school|universit\w*|college|institution|campus|studies|studied|degree)\b|\b(school|universit\w*|college|institution|campus)\b.*\bcountr(y|ies)\b/,
      {
        not: /\b(want|wish|like|prefer\w*|plan|intend|interested)\b|citizen|nationalit|\bbirth\b|residen|\blive\b|\bwork\b|\bvisa\b|authori|\bphone\b|\bcode\b|which countries/,
      },
    ),
    R(
      'exp.country',
      /\bcountr(y|ies)\b.*\b(employer|company|organi[sz]ation|employment|workplace)\b|\b(employer|company|organi[sz]ation|employment|workplace)\b.*\bcountr(y|ies)\b/,
      {
        not: /\b(want|wish|like|prefer\w*|plan|intend|interested|seek\w*|looking|desired|apply\w*)\b|citizen|nationalit|\bbirth\b|residen|\blive\b|\bvisa\b|authori|\bphone\b|\bcode\b|which countries|headquarter|\bhq\b|\bthis (role|position|job)\b/,
      },
    ),
    // "Expected/Achieved Degree Classification", "Predicted degree class", "Degree result", "Final degree grade (or
    // predicted)": your class, never the degree. A-level grades, UCAS points and "role classification" are not, and
    // "Overall Result (GPA)" (Workday) asks for the GPA.
    R(
      'edu.classification',
      /\bclassification\b|\bclass of (your |the )?degree\b|\bdegree class\b|\bhonou?rs (class|classification|level|grade)\b|\bclass of honou?rs\b|\b(predicted|expected|achieved|anticipated|projected|final|actual|overall)( or (predicted|expected|achieved))? (degree )?(class(es)?|grades?|results?|outcomes?|honou?rs)\b|\bdegree (grade|result|outcome)s?\b|^honou?rs$/,
      {
        not: /\b(role|job|position|security|visa|employment|worker|tax|data|risk|occupation\w*|industry|product)\b classification|a levels?|\bas levels?\b|gcses?|ucas|highers|\bib\b|baccalaureat|btec|leaving cert|school|sixth form|\bmodules?\b|\bgpa\b|\bcgpa\b|grade point|^(do|are|have|will|did|would|can) you\b/,
      },
    ),
    // "What degree are you currently pursuing?" asks for a degree; "Are you pursuing a degree?" is yes/no.
    R(
      'edu.degree',
      /\b(what|which) (type of |kind of )?degree\b|\b(type|kind|name) of (the |your )?degree\b|\bdegree (type|name|title|program(me)?)\b|\bdegree (are you|you are|you re|will you be) (currently )?(pursuing|studying|completing|enrolled|working|seeking|undertaking|earning|obtaining)/,
      {
        not: /major|field|subject|discipline|\byear\b|\bdate\b|minimum|equivalent|\bclass\b|classification|\bgrades?\b|\bresults?\b/,
        test: (desc) => !hasYesNoOptions(desc),
      },
    ),
    R('edu.degree', /\bdegree\b|qualification|diploma|\baward\b/, {
      not: /major|field|subject|discipline|\byear\b|\bdate\b|level of|highest|degree of|\bdid you|have you|do you|are you|minimum|equivalent|\bclass\b|classification|\bgpa\b|\bgrades?\b|\bscore\b|\bresults?\b|\boutcome\b/,
      test: (desc) => !hasYesNoOptions(desc),
    }),
    R(
      'edu.field',
      /fields? of study|\bmajors?\b|\bdisciplines?\b|concentration|area of study|speciali[sz]ation|course of study|program(me)? of study|\bsubjects?\b|study (field|area)|^(your |main |academic )?field$|\bfield (studied|of expertise)\b|course name/,
      {
        not: /minor|\b(secondary|second|additional|double|joint|other) (major|field|subject|discipline)|\bdid\b|field (sales|service|work|engineer|marketing|operations)|form ?field|field ?(set|label|wrapper|group|container|row|section|input)|\bsubjects? to\b|export control/,
      },
    ),
    // "University Course", "Course", "Course title", "Course studied", "Name of course", "Programme name": what you
    // study. Not its dates, code, grade or provider, a list of courses or modules, or "the course of the internship".
    R(
      'edu.field',
      /\bcourse\b|\b(programme|program) (name|title)\b|\bname of (the |your )?(degree )?(programme|program)\b/,
      {
        not: /\bcourses\b|(?<!\b(name|title) )\bof course\b|\bthe course of\b|relevant|\bmodules?\b|\b(code|provider|leader|tutor|director|fees?|dates?|start\w*|end|ends|ending|finish\w*|complet\w*|graduat\w*|years?|months?|duration|length|type|mode|level|load|credits?|grades?|results?|marks?|score|classification|gpa|location|city|country|work)\b|full ?time|part ?time|\bappl(y|ying|ied)\b|\binterested\b|preference|\bjob\b|\brole\b|internship|placement|scheme|training|\bonline\b|certif/,
      },
    ),
    // "Do you have a 2:1 or above (or equivalent)?", "Minimum 2:1 required — do you meet this?", "Do you expect to
    // graduate with honours?" [Yes / No]: about your class, never the class itself.
    R(
      'edu.classAtLeast',
      /\b2 (1|i|2|ii)\b|\b(upper|lower) second\b|\bfirst class\b|\b(predicted|achieve|achieved|expect) (a )?(first|1st)\b(?! (year|degree|time))|\bwith (first class )?honou?rs\b/,
      { kinds: CHOICE, test: (desc) => hasYesNoOptions(desc) },
    ),
    // "GPA Scale", "Please specify the grading scale used by your current school", "the maximum possible score/GPA".
    R(
      'edu.gpaScale',
      /\b(gpa|grading|grade|marking) (scale|system)\b|\bscale (used|of your gpa)\b|\b(which|what) scale\b|\b(maximum|max|highest) possible (score|gpa|grade)\b/,
      // "What is your cumulative GPA on the scale used by your local school/university?" asks for the GPA.
      { not: /\bon an? \d|\bout of\b|\bnormali[sz]ed\b|\bon (the|a|your) (\w+ )?scale\b/ },
    ),
    R(
      'edu.gpa',
      /\bgpa\b|grade point|\bcgpa\b|cumulative (grade|average)|grade average|\bgrades?\b/,
      // "Number of GCSEs at grade 9-7" is a count, not your grade.
      {
        not: /test score|credit score|maximum|max possible|highest possible|grading scale|(?<!\bon (the|a|your) )scale used|\bgpa scale\b|\bnumber of\b|\bhow many\b/,
      },
    ),
    // "A-level results", "Highers / Advanced Highers results": a school entry's grades.
    R(
      'edu.gpa',
      /\b(a ?levels?|as levels?|(advanced )?highers|international baccalaureate|ib diploma|i?gcses?|btecs?|leaving cert\w*|abitur)\b.*\bresults?\b/,
      { not: /\bnumber of\b|\bhow many\b|\bucas\b|\bpoints\b/ },
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
        // "Legal First Name (if different from preferred name)" asks for the legal one.
        not: /user ?name|company|employer|school|business|card|organi|contact|\breferences?\b|\breferr|emergency|manager|screen ?name ?(on|in)|\bdifferent (from|to|than) (your |the )?pref(erred)? name\b/,
      },
    ),
    R(
      'name.first',
      /\bfirst ?name|\bgiven ?names?\b|\bforenames?\b|\bfname\b|\bfirst$|^first\b(?! (time|choice|language|line|day|week|month|year|job))|\bvorname|\bprenom|\bnombre\b|\bnome\b/,
      {
        // "Prénom et nom" / "Vor- und Nachname" / "Nombre y apellidos" is the whole name; "Phone number (country code
        // first)" is a phone number.
        not: /last|sur ?name|family|middle|company|school|business|card|preferred|nick|employer|organi|user|father|mother|spouse|emergency|reference|referr|manager|contact person|\bnom\b|nachname|apellido|cognome|\b(phone|mobile|telephone|number|code)\b/,
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
    // "What is your communication preference?", "Preferred method of contact", "How would you like us to contact you?"
    // (a choice of Email / Phone / Text message, never an SMS opt-in).
    R(
      'contact.preference',
      /\bcommunication preferences?\b|\bpreferred (method|means|mode|way|form|channel) of (contact|communication|correspondence)\b|\bpreferred (contact|communication) (method|channel|preference|type)?\b|\b(contact|communication) (preference|method|channel)s?\b|\bhow (would|do|should|can|may) (you like|you prefer|we) (us |to be )?(to )?(best )?(contact|reach|communicate with|get in touch with) you\b|\bbest way to (contact|reach) you\b/,
      {
        kinds: CHOICE,
        not: /marketing|newsletter|promotion|job alerts?|talent (community|network|pool)|subscribe|opt ?in|consent|emergency|\breferee|\breferences?\b|\bnumber\b|\baddress\b/,
      },
    ),
    // "Your primary college/university/school email", "Student email address": not your personal one.
    R(
      'email.school',
      /\b(school|universit\w*|college|student|academic|institution(al)?|\.edu)\b.{0,30}\be ?mail\b|\be ?mail\b.{0,20}\b(at|from|of|with) (your )?(school|universit\w*|college|institution)\b/,
      {
        kinds: ['email', 'text'],
        not: /referr|reference|recruiter|career(s)? (service|office|advis)|advis[eo]r|tutor|professor|lecturer|supervisor|\bcontact\b/,
      },
    ),
    // Not someone else's, nor a second address of yours ("Alternate Email": the same one again says nothing).
    R('email', /e ?mail|courriel|correo|\bmail\b/, {
      not: /referr|reference|recruiter|manager|supervisor|emergency|friend|hiring|newsletter|marketing|subscribe|\b(alternate|alternative|secondary|additional|backup|second) e ?mail\b/,
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
      // "Mobile number (inc. country code)" is the whole number (WHOLE_NUMBER).
      { not: WHOLE_NUMBER },
    ),
    R(
      'phone',
      /phone|mobile|\bmobil(nummer|telefon)?\b|\bcell\b|cellular|telephone|\btel\b|contact (number|no)|telefon|telefono|\bportable\b|\bhandy\b|whats ?app|\bmob\b/,
      { not: PHONE_NOT, notAny: OTHER_PHONE, yieldsTo: ['phone.countryCode', 'phone.type'] },
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
        // "State (If N/A, Select Other)" is the box; "State if you have…" asks you to say something. "Country/Region of
        // Residence" and "Country / Territory" are countries (Workday's "countryRegion" id is not).
        not: /united states|marital|\b(please|you|to) state\b|\bstate (your|which|whether|if(?! (n ?a|not applicable|applicable)\b)|why|how|what|the|any)\b|(?<!\bsection )\bcountr(y|ies) (or |and )?(region|territory|area)\b|\b(region|territory) (or |and )?countr(y|ies)\b/,
        yieldsTo: ['exp.location'], // "Employer Location (City, State, Zip)"
      },
    ),
    R(
      'address.postalCode',
      /\bzip\b|zip ?code|\bzipcode|postal|post ?code|postcode|\bpin ?code\b|\bplz\b|postleitzahl|codigo postal|code postal|\bcap\b|\bcep\b/,
      // Not where you work: Oracle's "Northern Ireland Workplace Postcode for SPBP due to miscarriage".
      {
        yieldsTo: ['exp.location'],
        not: /\bworkplace\b|\b(work|employer s?|company|office|branch) (post ?code|postcode|zip|postal)\b/,
      },
    ),
    R('citizen', /^(are|is) you (a |an )?(\w+ ){0,3}(citizen|national)s?\b/, {
      kinds: ['select', 'radio', 'combo', 'combobox'],
      not: /\b(dual|other|another|any other|former|previous)\b/,
    }),
    // "Do you hold British citizenship?", "Do you have a UK passport?" (never a list of sanctioned countries).
    R(
      'citizen',
      /^(do|does) you (currently )?(hold|have|possess)( a| an)?( valid| current)? (\w+ ){0,2}(citizenship|nationality|passport)\b/,
      {
        kinds: ['select', 'radio', 'combo', 'combobox'],
        not: /\b(dual|other|another|any other|former|previous|second)\b|\b(any|one) of the following\b|\bcuba\b|\biran\b|\bnorth korea\b|\bsyria\b|\bcrimea\b|\bsanction/,
      },
    ),
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
      /^(start|from|begin|started|since)( date| month| year)?( (or )?(actual|expected|anticipated)( or (actual|expected|anticipated))?)?$|\bstart ?date\b|\bstart (month|year)\b|\bdate (from|started|joined|of joining)\b|\bfrom (date|month|year)\b|\bstarted\b|\bbegin date\b|\bdate from\b/,
      {
        // "From (Actual)" (Workday) is an entry's date; "Expected start date" is when you could start the job. Oracle's
        // "Veteran First Civilian Start Date" is a veteran's own.
        not: /when (can|could|would) you|availab|earliest|desired|preferred|^expected|\bexpected (start|to start|from)\b|can you start|internship|placement|programme|program\b|\bveteran|\bmilitary\b|\bcivilian\b|\barmed forces\b|\bdischarge/,
      },
    ),
    R(
      'gen.end',
      /^(end|to|until|finish|till)( date| month| year)?( (or )?(actual|expected|anticipated)( or (actual|expected|anticipated))?)?$|\bend ?date\b|\bend (month|year)\b|\bdate (to|left|ended|of leaving)\b|\bto (date|month|year)\b|\bended\b|\bfinish date\b|\bdate to\b|\bleaving date\b/,
      {
        not: /open ended|\b(percentage|average|marks?|grades?|score|results?|gpa|total|overall)\b|\bveteran|\bmilitary\b|\bcivilian\b|\barmed forces\b|\bdischarge/,
      },
    ),
    R(
      'exp.company',
      /\bcompany\b|employer|organi[sz]ation|\bfirm\b|business name|workplace|unternehmen|\bempresa\b|entreprise/,
      {
        not: /current|present|most recent|size|industry|website|\btype\b|e ?mail|phone|address|why|how|referr|recruit|agency|\burl\b|linked ?in|do you|have you|are you|did you|related|know anyone|anyone at|family|relative|this company|our company|the company|interest|^if (yes|so|you)\b|deadlines?|\boffers?\b|post ?code|postal|\bzip\b/,
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
    // Not "Please disclose whether AI tools were used…" or "…which teams may be the best fit based on your skill set
    // … anything else you'd like to note".
    // Nor an essay that mentions them ("Describe a product you built… the tech stack used", "What unique skills would
    // you bring?") or a kind of them the list doesn't say ("What are some AI specific technologies…?"): the AI's.
    R('skills', /\bskills?\b|technologies|tech(nical)? stack|competenc|expertise|\btools\b|proficienc(y|ies)/, {
      not: /language|\bdo you\b|have you|rate your|years|\blevel\b|how (proficient|experienced|comfortable|much|long)|\bwhether\b|\bdisclose\b|\bai tools\b|\banything else\b|\bfeel free\b|\bbest fit\b|^(describe|tell (us|me)|explain|share|walk us through|give (us )?an example)\b|\bwould you bring\b|\bunique\b|\byou (built|developed|created|designed|made)\b|\b(ai|ml|machine learning|cloud|web|mobile|front ?end|back ?end|devops|security)( specific)? (technologies|tools|skills)\b/,
    }),
    R(
      'languages',
      /languages? (spoken|you speak|proficienc|known|fluency)|which languages?\b|spoken languages|^languages?$|language skill|languages do you speak|\blanguages?\b.*\b(fluent|fluency|speak|proficient)\b|\bfluent in\b|\b(additional|other|foreign) languages?\b|\b(do|can) you speak\b|\bspeak (\w+ )?(at a |to a )?(fluent|native|business|professional)\b/,
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
    return !!v && (!!v.otherwise || v.canonical === 'yes' || (v.canonical === 'no' && CHOICE.includes(kind)));
  }

  /** Resolve a field type to a value object (or null when the profile has nothing for it). */
  function resolve(type, profile, ctx) {
    ctx = ctx || {};
    if (type === 'custom') return val(ctx.answer, { custom: true });
    const def = DEFS[type];
    if (!def || !profile) return null;
    try {
      const v = def.get(profile, ctx) || null;
      // "If yes, give their name. Otherwise, enter N/A" in a text box, after a No: "N/A".
      const instead = v && v.canonical === 'no' && !v.otherwise ? otherwiseVal(ctx) : null;
      if (instead) return instead;
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
    countriesAsked,
    followUpAnswer,
    eduLevelOf,
    degreeClassOf,
    uploadApplies,
    uploadAlso,
    gradeHeld,
    placeCountry,
    languagesNamed,
    isAcknowledgement,
    parseEthnicity,
    sanctionsApplies,
    isSanctionsFollowUp: (question) => SANCTIONS_FOLLOW_UP.test(question || ''),
    TWO_SANCTIONED_PLACES,
    parseSlots,
    slotFits,
    ETHNICITY_CHOICES,
    cardBrand,
    val,
  };
  JTF.fields = fields;
  if (typeof module === 'object' && module.exports) module.exports = fields;
})(typeof globalThis !== 'undefined' ? globalThis : this);
