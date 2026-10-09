/*
 * JobToFill — field rules, work and screening: right to work country by country, visas and clearance, where you live
 * and would work, start dates, notice, and where you heard of the job. One of the parts lib/fields.js puts together
 * (loaded before it, in the order background.js lists them).
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});
  const U = JTF.util;
  const P = (JTF.fieldParts = JTF.fieldParts || {});
  const {
    CHOICE,
    LONG_TEXT,
    availableAnswer,
    dateVal,
    listVal,
    notApplicable,
    numberVal,
    optionTexts,
    otherwiseVal,
    simple,
    val,
    wantsSentence,
    withSpellings,
  } = P;

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
   * "Where do you have the right to work? (Select all that apply)" over statements that each name a country ("I have
   * the right to work in the UK (post-Brexit does not apply automatically for EU-citizens)", "…in Germany", "Neither…"):
   * every statement about a country you have the right to work in (matcher.rightsPicks), never another's.
   */
  const US_CLEARANCE = /\b(u s|us|united states|american)( government)? (security )?clearances?\b/;
  // The levels of a US clearance, as a list names them.
  const US_LEVELS = /\b(public trust|top secret|ts sci)\b/;
  const RIGHT_IN = /\b(right|rights|authori[sz]ed|eligible|entitled|permitted|allowed) to work in\b/;

  function rightsStatements(p, ctx) {
    const named = (ctx.options || [])
      .map((o) => U.normalize(String(o && typeof o === 'object' ? o.text : o).replace(/\([^)]*\)/g, ' ')))
      .filter((t) => RIGHT_IN.test(t) && !/^(no|not|neither|none)\b|^i (do not|don t|am not|have no)\b/.test(t))
      .map((t) => JTF.geo.countriesNamed(t))
      .filter((codes) => codes.length === 1);
    if (named.length < 2 || new Set(named.map((c) => c[0])).size < 2) return null;
    const mine = workCountries(p);
    if (!mine.length) return null;
    return val('Yes', { kind: 'rights', rights: [...JTF.geo.workRights(mine)], many: ctx.kind === 'checkboxes' });
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
    // "If no, type N/A" when you need no visa; but Peel Hunt's "If you do require a visa or are currently on a visa,
    // please provide details… If you do not require a visa, please type N/A" wants a visa's details from anyone on one:
    // N/A only for a citizen. Arma's "…please confirm what visa type you have…": "British citizen (no visa needed)".
    const q = ctx.question || '';
    const citizen = rightType(p, ctx);
    const instead = sponsor === 'no' && otherwiseVal(ctx);
    if (instead && (citizen || !/\b(currently )?on a visa\b|\b(hold|have) a visa\b/.test(q))) return instead;
    if (citizen && /\bvisa type\b|\btype of visa\b/.test(q)) return citizen;
    // Sentences, not a "No": a box's "If you do not require a visa, please type N/A" is for citizens only (above).
    const say = (text) => val(text, { canonical: null });
    if (ok === 'yes' && sponsor === 'no') return say('I have the right to work and do not need visa sponsorship.');
    if (ok === 'yes' && sponsor === 'yes') return say('I have the right to work now but will need visa sponsorship.');
    if (ok === 'no' || sponsor === 'yes') return say('I will need visa sponsorship to work in this role.');
    return null;
  }

  /**
   * "What type of right to work in the UK do you hold?" [Citizenship/Nationality/Permanent Residency | … Visa | …]:
   * the citizenship one for a citizen of the country asked (or the job's); a text box gets "British citizen (no visa
   * needed)". Nothing for anyone else: which visa or status you hold isn't in the profile.
   */
  function rightType(p, ctx) {
    if (/^if (yes|so)\b/.test(ctx.question || '')) return null;
    let { codes } = countriesAsked(ctx.question, null);
    if (!codes.length) codes = jobCountries(ctx);
    // Peel Hunt's visa box names no country, nor does the page: the country you live in.
    if (!codes.length) codes = JTF.geo.countriesIn(p.address.country || '');
    const rows = JTF.geo.nationalities(p.personal.nationality).filter(Boolean);
    if (codes.length !== 1 || !rows.some((row) => row[0] === codes[0])) return null;
    const row = rows.find((r) => r[0] === codes[0]);
    const demonym = (JTF.geo.demonyms(row[0])[0] || row[1]).replace(/^./, (c) => c.toUpperCase());
    const named = /\bcitizen(ship)?s?\b|\bnationality\b|\bnational\b|\bpassport\b/;
    if (CHOICE.includes(ctx.kind))
      return val(`${demonym} citizen`, { named, candidates: [`${demonym} citizen`, 'Citizen'] });
    return val(`${demonym} citizen (no visa needed)`);
  }

  /**
   * "Do you hold dual nationality?", "Do you currently hold any other (dual) nationality or citizenships?": Yes with
   * two in your profile ("British, Irish"), else No. A text box gets the others. Citizenships held before aren't in it.
   */
  function dualNationality(p, ctx) {
    const q = ctx.question || '';
    if (/\b(previously|formerly|ever|in the past)\b/.test(q)) return null;
    const rows = JTF.geo.nationalities(p.personal.nationality).filter(Boolean);
    if (!rows.length) return null;
    if (rows.length < 2) return val('No');
    return LONG_TEXT.includes(ctx.kind) && !/^(do|does|are|is|have)\b/.test(q)
      ? val(rows.map((r) => r[1]).join(', '))
      : val('Yes');
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

  // What each type of field is filled with.
  Object.assign((P.DEFS = P.DEFS || {}), {
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
    // Both carry whether you need sponsorship, for options like "Yes, will require sponsorship".
    // A question naming a country you can't work in gets "No" / "Yes, I'd need sponsorship", whatever you said for home.
    // A question naming no country is about the job's ("…in the country where this role is based?").
    'job.authorized': {
      label: 'Authorized to work',
      path: 'job.authorized',
      get: (p, ctx) =>
        rightsStatements(p, ctx) ||
        elsewhere(p, ctx, 'authorized') ||
        workStatus(p, ctx) ||
        sponsorAware(val(p.job.authorized), p, 'authorized'),
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
    'job.rightType': { label: 'Type of right to work', get: rightType, derived: true },
    'personal.dualNationality': { label: 'Dual nationality (yes/no)', get: dualNationality, derived: true },
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
        let v = listVal(p.job.locations);
        // Ashton Fire's "Please indicate your first / second choice office location": that one of yours, or nothing.
        const nth = ['first', 'second', 'third', 'fourth'].findIndex((w, i) =>
          new RegExp(`\\b(${w}|${i + 1}(st|nd|rd|th)) (choice|preference)\\b`).test(ctx.question || ''),
        );
        if (v && nth >= 0) v = v.items[nth] ? listVal(v.items[nth]) : null;
        // FDM's "Which FDM Location…?" [Canada | Ireland | UK | USA | None]: London's country when the list has no
        // city of yours (its own nation only: never "Scotland" for London).
        if (v && CHOICE.includes(ctx.kind)) {
          const places = v.items.flatMap((item) => JTF.geo.placesNamed(item)).filter((pl) => pl.type === 'metro');
          const nations = /^(England|Scotland|Wales|Northern Ireland)$/;
          v.fallback = [
            ...new Set(
              places.flatMap((pl) => [
                ...(pl.region && !/^[A-Z]{2}$/.test(pl.region) ? [pl.region] : []),
                ...JTF.geo.countryCandidates(pl.country).filter((c) => !nations.test(c) && c !== pl.country),
              ]),
            ),
          ];
        }
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
        // Clarity's "Current clearance level" [Non-clearable / Clearable / Public Trust / Secret / Top Secret / TS/SCI]:
        // US levels, which take US citizenship, so "Non-clearable" for anyone else who holds none.
        const options = ctx.options || [];
        const levels = options.map((o) => U.normalize(o.text)).join(' | ');
        const nations = JTF.geo.nationalities(p.personal.nationality).map((row) => row[0]);
        const unclearable = options.find((o) => /^(non|not) ?clearable\b/.test(U.normalize(o.text)));
        if (none && unclearable && US_LEVELS.test(levels) && nations.length && !nations.includes('US'))
          return val(unclearable.text);
        return withSpellings(none ? 'None' : held, CLEARANCES);
      },
    },
    'job.clearanceEligible': {
      label: 'Eligible for security clearance',
      path: 'job.clearanceEligible',
      get(p, ctx) {
        const q = (ctx && ctx.question) || '';
        // A US clearance takes US citizenship: "Do you presently hold an active U.S. security clearance, or are you
        // eligible to obtain one?" is No for a British student.
        const nations = JTF.geo.nationalities(p.personal.nationality).map((row) => row[0]);
        if (US_CLEARANCE.test(q) && nations.length && !nations.includes('US')) return val('No');
        // Holding one already answers "Do you hold, or are you willing to obtain, SC clearance?".
        const held = String(p.job.clearance || '').trim();
        const holds = !!held && !/^(none|no|n\/?a|not applicable|nil)$/i.test(held);
        const v = holds ? val('Yes') : val(p.job.clearanceEligible);
        if (!v) return v;
        // Eligible, not holding one: "Yes, I'm eligible…", never "Yes, I hold an active … clearance".
        if (!holds)
          v.avoid = (o) =>
            /\b(hold|holds|have|has) (an? )?(active|current|valid)\b|\b(currently|already) hold/.test(o.n);
        // "To meet the eligibility requirements, you must have lived in the UK for the last 5 years and not have spent
        // more than 6 months… outside of the UK": the statement that says it back (matcher.agreeing).
        if (/\b(must|required to|requirements?|eligib\w*)\b/.test(q)) v.requirement = q;
        return v;
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
      get(p, ctx) {
        const raw = String(p.job.referralSource || '').trim();
        if (/^[-–—]+$/.test(raw)) return null;
        // The "Please specify" box after its list: where you heard, as you wrote it.
        if (ctx && ctx.part === 'specify') return val(raw || 'LinkedIn');
        const v = val(raw || 'LinkedIn');
        const words = U.normalize(v.text).split(' ');
        const kind = SOURCE_KINDS.find(([re]) => re.test(words.join(' ')));
        v.candidates = [v.text, ...(kind ? kind[1] : [])];
        // Another job site's own option ("LinkedIn Job Posting", "Handshake Job Posting") is never yours; examples in
        // brackets name no site ("Other Job Board (e.g. University Job Board, etc.)", "Job Board (Indeed, LinkedIn…)").
        if (kind && kind[1] === JOB_SITE) {
          const mine = SOURCE_KINDS[0][0].exec(words.join(' '));
          v.avoid = (o) => {
            const bare = U.normalize(String(o.text).replace(/\([^)]*\)|\b(e\.?g\.?|such as|i\.?e\.?)\b.*$/gi, ' '));
            const site = SOURCE_KINDS[0][0].exec(bare) || /\blinked ?in\b/.exec(bare);
            return (
              NOT_A_JOB_SITE.test(bare) ||
              (!!site && !/^job ?(board|site)$/.test(site[0]) && (!mine || site[0] !== mine[0]))
            );
          };
        }
        // An option that names it wins over broader ones: "Job Board / LinkedIn", "Social Media (LinkedIn, …)".
        if (words.length <= 3) v.named = new RegExp(`\\b${words.join(' ?')}\\b`);
        v.fallback = ['Other', 'Other (please specify)', 'Others', 'Something else'];
        return v;
      },
    },
    // Cambridge Consultants' "University event / society details" [NA / University of Bath, Careers and Placements Fair
    // 2026 / … / University Society]: the event you heard about the job at, so its N/A when you heard elsewhere.
    'job.referralEvent': {
      label: 'Event where you heard about the job',
      derived: true,
      get(p, ctx) {
        const source = U.normalize(p.job.referralSource || '');
        if (
          /\b(events?|fairs?|societ(y|ies)|campus|universit(y|ies)|careers? (service|office)|presentations?)\b/.test(
            source,
          )
        )
          return null;
        return notApplicable(ctx);
      },
    },
    // "Were you referred by a current Cirrus Logic employee?": from where you heard of the job.
    'job.referred': {
      label: 'Referred by an employee (yes/no)',
      get(p) {
        const source = U.normalize(p.job.referralSource || '');
        if (!source) return null;
        return val(/\b(referr\w*|refer|employee|friend|colleague|relative|family)\b/.test(source) ? 'Yes' : 'No');
      },
      derived: true,
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
  });

  Object.assign(P, { countriesAsked, workCountries });
})(typeof globalThis !== 'undefined' ? globalThis : this);
