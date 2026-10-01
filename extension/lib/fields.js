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
        startDate: '',
        referralSource: '',
      },
      eeo: { gender: '', race: '', hispanic: '', veteran: '', disability: '' },
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

  function numberVal(text) {
    if (U.isBlank(text)) return null;
    const m = String(text)
      .replace(/,/g, '')
      .match(/(\d+(?:\.\d+)?)\s*(k)?/i);
    const number = m ? parseFloat(m[1]) * (m[2] ? 1000 : 1) : null;
    return val(text, { kind: 'number', number });
  }

  function dateVal(raw, part) {
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
      return val(String(d.year), {
        kind: 'year',
        part,
        date: d,
        candidates: [String(d.year), String(d.year).slice(2)],
      });
    }
    if (part === 'day') {
      if (!d.day) return null;
      return val(String(d.day), { kind: 'day', part, date: d, candidates: [U.pad2(d.day), String(d.day)] });
    }
    return val(raw, { kind: 'date', date: d });
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

  function cardExp(card) {
    if (!card || !card.expMonth || !card.expYear) return null;
    const year = String(card.expYear).length === 2 ? '20' + card.expYear : String(card.expYear);
    return `${year}-${U.pad2(card.expMonth)}`;
  }

  /* -------------------------------------------------------------- definitions */

  const at = (path, wrap) => (p) => (wrap || val)(U.getPath(p, path));
  const simple = (label, path, wrap) => ({ label, path, get: at(path, wrap) });

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
        const e = (p[list] || [])[i];
        if (!e) return null;
        if (kind === 'date') {
          if (key === 'endDate' && e.current) return null;
          return dateVal(e[key], ctx.part);
        }
        if (kind === 'bool') return val(e[key] ? 'Yes' : 'No');
        if (kind === 'degree') return degreeVal(e[key]);
        if (kind === 'number') return numberVal(e[key]);
        return val(e[key]);
      },
    };
  }

  const DEFS = {
    'name.full': { label: 'Full name', get: (p) => val(fullName(p)) },
    'name.first': simple('First name', 'personal.firstName'),
    'name.middle': simple('Middle name', 'personal.middleName'),
    'name.last': simple('Last name', 'personal.lastName'),
    'name.preferred': {
      label: 'Preferred name',
      path: 'personal.preferredName',
      get: (p) => val(p.personal.preferredName || p.personal.firstName),
    },
    'name.prefix': simple('Title (Mr/Ms)', 'personal.prefix'),
    pronouns: simple('Pronouns', 'personal.pronouns'),
    dob: { label: 'Date of birth', path: 'personal.dob', get: (p, ctx) => dateVal(p.personal.dob, ctx.part) },
    nationality: simple('Nationality', 'personal.nationality', countryVal),

    email: simple('Email', 'contact.email'),
    phone: {
      label: 'Phone',
      path: 'contact.phone',
      get(p, ctx) {
        const num = String(p.contact.phone || '').trim();
        if (!num) return null;
        const cc = phoneCode(p);
        const full = cc && !ctx.hasCountryCodeField && !num.startsWith('+') ? `${cc} ${num}` : num;
        return val(full, { kind: 'phone', national: num });
      },
    },
    'phone.national': simple('Phone (national)', 'contact.phone'),
    'phone.countryCode': {
      label: 'Phone country code',
      path: 'contact.phoneCountryCode',
      get(p) {
        const code = phoneCode(p);
        if (!code) return null;
        const country = JTF.geo.findCountry(p.address.country);
        return val(code, {
          kind: 'phoneCode',
          code: code.slice(1),
          countries: country ? JTF.geo.countryCandidates(p.address.country) : [],
          search: country ? country[2] : code,
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
        // Location autocompletes list "London, Greater London, England, UK": the city alone matches best.
        const candidates = [parts.join(', ')].concat(a.city && parts.length > 1 ? [a.city] : []);
        return val(parts.join(', '), { kind: 'location', candidates, search: a.city || parts[0] });
      },
    },

    'links.linkedin': simple('LinkedIn', 'links.linkedin'),
    'links.github': simple('GitHub', 'links.github'),
    'links.portfolio': {
      label: 'Portfolio',
      path: 'links.portfolio',
      get: (p) => val(p.links.portfolio || p.links.website),
    },
    'links.website': { label: 'Website', path: 'links.website', get: (p) => val(p.links.website || p.links.portfolio) },
    'links.twitter': simple('Twitter / X', 'links.twitter'),

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
    'job.authorized': simple('Authorized to work', 'job.authorized'),
    'job.sponsorship': simple('Requires sponsorship', 'job.sponsorship'),
    'job.relocate': simple('Willing to relocate', 'job.relocate'),
    'job.over18': simple('Over 18', 'job.over18'),
    'job.salary': simple('Salary expectation', 'job.salary', numberVal),
    'job.noticePeriod': simple('Notice period', 'job.noticePeriod'),
    'job.startDate': {
      label: 'Available start date',
      path: 'job.startDate',
      get: (p, ctx) => dateVal(p.job.startDate, ctx.part),
    },
    'job.referralSource': simple('How you heard about the job', 'job.referralSource'),

    'eeo.gender': simple('Gender', 'eeo.gender'),
    'eeo.race': simple('Race / ethnicity', 'eeo.race'),
    'eeo.hispanic': simple('Hispanic / Latino', 'eeo.hispanic'),
    'eeo.veteran': simple('Veteran status', 'eeo.veteran'),
    'eeo.disability': simple('Disability status', 'eeo.disability'),

    'edu.level': { label: 'Highest education', get: (p) => degreeVal(((p.education || [])[0] || {}).degree) },
    'edu.school': entry('School / university', 'education', 'school'),
    'edu.degree': entry('Degree', 'education', 'degree', 'degree'),
    'edu.field': entry('Field of study', 'education', 'field'),
    'edu.gpa': entry('GPA', 'education', 'gpa'),
    'edu.location': entry('School location', 'education', 'location'),
    'edu.start': entry('Education start date', 'education', 'startDate', 'date'),
    'edu.end': entry('Graduation date', 'education', 'endDate', 'date'),

    'exp.company': entry('Company', 'experience', 'company'),
    'exp.title': entry('Job title', 'experience', 'title'),
    'exp.location': entry('Job location', 'experience', 'location'),
    'exp.start': entry('Job start date', 'experience', 'startDate', 'date'),
    'exp.end': entry('Job end date', 'experience', 'endDate', 'date'),
    'exp.current': entry('Currently work here', 'experience', 'current', 'bool'),
    'exp.description': entry('Job description', 'experience', 'description'),

    skills: simple('Skills', 'skills'),
    languages: simple('Languages', 'languages'),
    summary: simple('Summary', 'summary'),
    coverLetter: simple('Cover letter', 'coverLetter'),

    'file.resume': { label: 'Resume file', file: 'resume', get: () => null },
    'file.coverLetter': { label: 'Cover letter file', file: 'coverLetter', get: () => null },

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
    'interviewer', 'employee', 'department', 'title', 'legal entity', 'brand', 'campaign', 'store',
  ].join('|'));

  const R = (type, re, opts) => Object.assign({ type, re }, opts || {});

  // Expiry dates of passports, visas and licences are not card expiry dates.
  const NOT_ID_DOCUMENT = /passport|visa|permit|licen[cs]e|certif|document|\bid\b/;

  // Order matters only for ties: put specific rules (and long questions that
  // mention other keywords, like "authorized to work in the country…") first.
  const RULES = [
    // Documents
    R(
      'file.coverLetter',
      /cover ?letter|motivation(al)? letter|letter of motivation|anschreiben|lettre de motivation/,
      { kinds: ['file'] },
    ),
    R('file.resume', /resume|\bcv\b|curriculum|lebenslauf|attach|upload|document|\bfile\b/, {
      kinds: ['file'],
      not: /photo|picture|image|avatar|headshot|transcript|portfolio|certificat|passport|\bid\b|writing sample|cover/,
    }),

    // Passwords
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
      { not: /type|name|holder|expir|exp date|cvv|cvc|security|zip|postal|brand|phone|gift/ },
    ),
    R('cc.type', /card ?(type|brand|network)|type of card/, { kinds: CHOICE }),

    // Screening questions (long sentences that mention other keywords)
    R(
      'job.authorized',
      /without (the )?(need for |requiring |needing |requirement of |any )?(employer |visa |company |immigration )?sponsor/,
    ),
    R(
      'job.sponsorship',
      /sponsor|visa (status|support|required|transfer|requirement)|\bh ?1 ?b\b|immigration (support|sponsorship|assistance)|require (a )?(work )?visa/,
    ),
    R(
      'job.authorized',
      /(authori[sz]ed|eligible|entitled|permitted|allowed|able) to (lawfully |legally )?work|work (authori[sz]ation|permit|eligibility)|employment (authori[sz]ation|eligibility)|eligib(le|ility) (for|to) (employment|work)|authori[sz]ation to work|right to work|legal right to|legally (work|employed)/,
    ),
    R('job.relocate', /relocat/),
    R(
      'job.over18',
      /\b(18|eighteen)\b.*\b(years|older|age)\b|\b(at least|over|above|older than) (the age of )?(18|eighteen)\b|legal (working )?age|age of majority/,
    ),
    R(
      'job.referralSource',
      /how did you (hear|find|learn|come across|discover|get to know)|where did you (hear|find|learn|see|discover|come across)|hear(d)? about (us|this|the)|learn(ed)? about (us|this|the)|source of (application|referral|hire|candidate)|referral source|^source$|how were you referred|found (us|this|the job)/,
    ),
    R(
      'job.salary',
      /salary|compensation|pay (expectation|range|requirement)|desired (pay|rate|wage)|expected (pay|wage|rate|ctc)|\bctc\b|remuneration|\bwage\b|rate expectation|hourly rate|base pay/,
    ),
    R('job.noticePeriod', /notice ?period|notice (required|do you need)|how much notice|weeks notice/),
    R(
      'job.startDate',
      /when (can|could|would) you (start|begin|join)|available (start|to start|to begin|from)|\bavailability\b|earliest (possible )?(start|date)|date (you are )?available|desired start|expected start|join(ing)? date|how soon/,
    ),
    R(
      'job.yearsExperience',
      /years (of )?(relevant |professional |total |work |industry )?experience|how many years|experience in years|total experience|\byrs\b/,
    ),
    R(
      'job.currentCompany',
      /current (company|employer|organi[sz]ation|workplace)|present (company|employer)|most recent (company|employer)|^org$|latest employer/,
    ),
    R(
      'job.currentTitle',
      /current (job )?(title|position|role|designation|occupation)|present (title|position|role)|most recent (job )?(title|position|role)|^headline$|professional headline/,
    ),

    // Voluntary self-identification
    R('eeo.hispanic', /hispanic|latin[oax]\b/, { kinds: CHOICE }),
    R('eeo.race', /\brace\b|ethnic/, { kinds: CHOICE }),
    R('eeo.veteran', /veteran|military (service|status)|armed forces|served in the/, { kinds: CHOICE }),
    R('eeo.disability', /disabilit|disabled|handicap|impairment/, { kinds: CHOICE }),
    R('eeo.gender', /\bgender\b|\bsex\b|geschlecht|\bgenre\b|\bsexo\b/, { not: /orientation|transgender/ }),
    R('pronouns', /pronoun/),
    R(
      'dob',
      /birth ?(date|day)|date of birth|\bdob\b|\bbday\b|birthday|geburtsdatum|fecha de nacimiento|date de naissance/,
      { not: /place|city|country|town/ },
    ),

    // Links (before names and websites)
    R('links.linkedin', /linked ?in/),
    R('links.github', /git ?hub/),
    R('links.twitter', /twitter|\bx com\b|\bx (handle|profile|username)\b/),
    R('links.portfolio', /portfolio|dribbble|behance|work samples?/),
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
      /highest (level of )?(education|degree|qualification|academic)|education(al)? (level|attainment|background|qualification)|level of (education|study|degree)/,
    ),
    R(
      'edu.end',
      /graduat(ion|ed|e|ing)\b|expected graduation|completion (date|year)|year of (graduation|completion|passing)|class of|passing year|year (graduated|completed)/,
      {
        not: /did you|have you|are you|post ?grad|graduate (degree|school|program|student)|undergrad/,
      },
    ),
    R(
      'edu.school',
      /\bschool\b|universit|college|institut(e|ion)|alma mater|academy|hochschule|\becole\b|universidad/,
      {
        not: /high school (diploma|graduate|completion)|degree|major|gpa|\byear\b|\bdate\b|\bstart|\bend\b|graduat|\blocation\b|\bcity\b|\bstate\b|country|did you|have you|are you|do you|e ?mail|address|transcript|currently (attend|enrolled)/,
      },
    ),
    R('edu.degree', /\bdegree\b|qualification|diploma|\baward\b/, {
      not: /major|field|subject|discipline|\byear\b|\bdate\b|level of|highest|degree of|\bdid you|have you|do you|are you|minimum|equivalent/,
    }),
    R(
      'edu.field',
      /field of study|\bmajor\b|discipline|concentration|area of study|speciali[sz]ation|course of study|program(me)? of study|\bsubject\b|study (field|area)|\bfield\b|course name/,
      {
        not: /minor|\bdid\b|field (sales|service|work|engineer|marketing|operations)|form ?field|field ?(set|label|wrapper|group|container|row|section|input)/,
      },
    ),
    R(
      'edu.gpa',
      /\bgpa\b|grade point|\bcgpa\b|cumulative (grade|average)|grade average|\bgrades?\b|degree classification|class of degree|\bhonou?rs\b/,
      { not: /test score|credit score/ },
    ),

    // Names
    R('name.prefix', /salutation|honorific|\bprefix\b|anrede|civilit|\btitle\b/, {
      test: (desc, text) => hasHonorificOptions(desc) || /salutation|honorific|prefix|anrede|civilit/.test(text),
    }),
    R(
      'name.preferred',
      /preferred (first |given )?name|nick ?name|\bgoes by\b|known as|chosen name|name you (go by|prefer)/,
    ),
    R(
      'name.first',
      /\bfirst ?name|\bgiven ?names?\b|\bforenames?\b|\bfname\b|\bfirst$|^first\b(?! (time|choice|language|line|day|week|month|year|job))|\bvorname|\bprenom|\bnombre\b|\bnome\b/,
      {
        not: /last|sur ?name|family|middle|company|school|business|card|preferred|nick|employer|organi|user|father|mother|spouse|emergency|reference|referr|manager|contact person/,
      },
    ),
    R('name.middle', /\bmiddle ?(name|initial)s?\b|\bmname\b|^mi$|\bmiddle$|second (given )?name|segundo nombre/, {
      not: /last|family/,
    }),
    R(
      'name.last',
      /\blast ?name|\bsur ?names?\b|\bfamily ?names?\b|\blname\b|\blast$|^last\b(?! (time|day|week|month|year|job|employer|position|company))|\bnachname|\bapellidos?\b|\bnom de famille|\bcognome\b|^nom$/,
      {
        not: /first|company|school|card|preferred|employer|father|mother|spouse|emergency|reference|referr|manager|maiden|previous|former|other/,
      },
    ),
    R('name.full', /\bfull ?name|\byour name\b|\blegal name\b|\bname\b|\bnom complet|\bnombre completo|\bvoller name/, {
      not: NAME_NOT,
      yieldsTo: ['name.first', 'name.last', 'name.middle', 'name.preferred'],
    }),

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
      /country ?(phone )?(calling )?code|dial(l)?(ing)? ?code|calling ?code|phone.*country|country.*phone|\bisd\b|(phone|tel|mobile) ?prefix|country ?prefix|international code/,
    ),
    R(
      'phone',
      /phone|mobile|\bcell\b|cellular|telephone|\btel\b|contact (number|no)|telefon|telefono|\bportable\b|\bhandy\b|whats ?app|\bmob\b/,
      {
        not: /type|\bext\b|extension|country|code|fax|device|prefix|emergency|referr|reference|manager|supervisor/,
        yieldsTo: ['phone.countryCode', 'phone.type'],
      },
    ),

    // Address
    R(
      'address.line2',
      /address ?(line)? ?(2|two|ii)\b|\baddr(ess)? ?2\b|street ?(address)? ?2|\bapt\b|apartment|\bsuite\b|\bunit\b|\bbuilding\b|\bfloor\b|\bflat\b|address ?(complement|additional|cont)|complemento|adresszusatz/,
      {
        not: /line ?(1|one)|business unit/,
      },
    ),
    R(
      'address.line1',
      /address ?(line)? ?(1|one|i)\b|\baddr(ess)? ?1\b|\bstreet\b|\baddress\b|\baddr\b|strasse|direccion|\badresse\b|indirizzo|\bmorada\b|house ?(number|name|no)/,
      {
        not: /e ?mail|\bip\b|\bweb\b|\burl\b|line ?(2|two|3|three)|\bcity\b|\bstate\b|zip|postal|country|same as|wallet|mac address|crypto/,
        yieldsTo: ['address.line2', 'address.city', 'address.postalCode'],
      },
    ),
    R(
      'location',
      /\blocation\b|city ?(and|&)? ?(state|country)|where are you (currently )?(based|located|living)|current (city|location|residence)|based in|place of residence|city of residence|where do you live|^residence$/,
      {
        not: /preferred|desired|willing|relocat|office|prefer|which location|work location|job location|interested|position location|hope|want|open to/,
      },
    ),
    R(
      'address.city',
      /\bcity\b|\btown\b|\bsuburb\b|\blocality\b|\bort\b|\bstadt\b|\bciudad\b|\bville\b|\bcitta\b|municipality|\bwohnort\b|address level 2/,
      { not: /\bstate\b|zip|postal|birth/ },
    ),
    R(
      'address.state',
      /\bstate\b|\bprovince\b|\bregion\b|\bcounty\b|\bterritory\b|prefecture|bundesland|\bestado\b|\bprovincia\b|address level 1/,
      { not: /united states|state your|marital/ },
    ),
    R(
      'address.postalCode',
      /\bzip\b|zip ?code|\bzipcode|postal|post ?code|postcode|\bpin ?code\b|\bplz\b|postleitzahl|codigo postal|code postal|\bcap\b|\bcep\b/,
    ),
    R(
      'nationality',
      /nationality|citizenship|citizen of|country of (citizenship|nationality)|staatsangehorigkeit|nacionalidad/,
    ),
    R('address.country', /\bcountr(y|ies)\b|\bnation\b|\bland\b|\bpais\b|\bpays\b/, {
      not: /code|phone|dial|calling|region|citizen|nationality|birth|issu|passport|origin|visa|other than|which countries|\btax\b/,
    }),

    // Work experience (gen.* become edu.* / exp.* from the surrounding section)
    R(
      'exp.current',
      /currently (work|employed|working)|current(ly)? (job|role|position|employer)|i (currently )?work here|\bpresent\b|still (work|employed)|\bongoing\b|current$/,
      { kinds: ['checkbox'] },
    ),
    R(
      'gen.start',
      /^(start|from|begin|started|since)( date| month| year)?$|\bstart ?date\b|\bstart (month|year)\b|\bdate (from|started|joined|of joining)\b|\bfrom (date|month|year)\b|\bstarted\b|\bbegin date\b|\bdate from\b/,
      {
        not: /when (can|could|would) you|availab|earliest|desired|expected|can you start/,
      },
    ),
    R(
      'gen.end',
      /^(end|to|until|finish|till)( date| month| year)?$|\bend ?date\b|\bend (month|year)\b|\bdate (to|left|ended|of leaving)\b|\bto (date|month|year)\b|\bended\b|\bfinish date\b|\bdate to\b|\bleaving date\b/,
    ),
    R(
      'exp.company',
      /\bcompany\b|employer|organi[sz]ation|\bfirm\b|business name|workplace|unternehmen|\bempresa\b|entreprise/,
      {
        not: /current|present|most recent|size|industry|website|\btype\b|e ?mail|phone|address|why|how|referr|recruit|agency|\burl\b|linked ?in|do you|have you|are you|did you|related|know anyone|anyone at|family|relative|this company|our company|the company|interest/,
      },
    ),
    R(
      'exp.title',
      /job ?title|\btitle\b|\bposition\b|\brole\b|designation|occupation|job name|berufsbezeichnung|\bpuesto\b|\bposte\b|job ?function/,
      {
        not: /appl(y|ied|ying)|current|present|most recent|interest|desired|preferred|seeking|looking|\blevel\b|\btype\b|salary|why|how|which|what|referr|for this|\bopen\b|vacancy|\bdo you\b|have you|are you|did you|\bcourse\b|book|song|thesis|project|paper|publication|prefix|salutation|honorific|description|summary|responsibilit|duties/,
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
        not: /linked ?in|url|link|git|photo|picture|image|\bname\b|role summary|job summary/,
        kinds: LONG_TEXT,
      },
    ),
    R('skills', /\bskills?\b|technologies|tech(nical)? stack|competenc|expertise|\btools\b|proficienc(y|ies)/, {
      not: /language|\bdo you\b|have you|rate your|years/,
    }),
    R(
      'languages',
      /languages? (spoken|you speak|proficienc|known)|which languages|spoken languages|^languages?$|language skills|languages do you speak/,
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

  /** Resolve a field type to a value object (or null when the profile has nothing for it). */
  function resolve(type, profile, ctx) {
    ctx = ctx || {};
    if (type === 'custom') return val(ctx.answer, { custom: true });
    const def = DEFS[type];
    if (!def || !profile) return null;
    try {
      return def.get(profile, ctx) || null;
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
    cardBrand,
    val,
  };
  JTF.fields = fields;
  if (typeof module === 'object' && module.exports) module.exports = fields;
})(typeof globalThis !== 'undefined' ? globalThis : this);
