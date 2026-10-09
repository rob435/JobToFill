/*
 * JobToFill — field rules, diversity and social mobility: equal-opportunity and social-mobility monitoring: the
 * answers you gave, in the words each form uses (never sent to the AI). One of the parts lib/fields.js puts together
 * (loaded before it, in the order background.js lists them).
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});
  const U = JTF.util;
  const P = (JTF.fieldParts = JTF.fieldParts || {});
  const { namedInProfile, simple, val, withSpellings } = P;

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

  const RELIGIONS = {
    'No religion or belief': [
      'No religion or belief',
      'No religion',
      'Non Religious',
      'Non-religious',
      'Not religious',
      'Atheist',
      'Atheism',
      'None',
      'No religion / atheist',
    ],
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

  // What each type of field is filled with.
  Object.assign((P.DEFS = P.DEFS || {}), {
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
    // Isio's "Community Background Data (Belfast, Northern Ireland applications)… [I am a member of the Roman Catholic
    // Community / … / Please select if you are not applying for a role based in Northern Ireland]": that last one when
    // the job is elsewhere.
    'eeo.community': {
      label: 'Community background (Northern Ireland)',
      derived: true,
      get(p, ctx) {
        const away = (ctx.options || []).find((o) =>
          /\bnot (applying|based)\b.*\bnorthern ireland\b/.test(U.normalize(o.text)),
        );
        const places = JTF.geo.placesNamed(ctx.jobLocation || '');
        if (!away || !places.length || places.some((pl) => pl.region === 'Northern Ireland')) return null;
        return val(away.text, { canonical: null });
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

    'eeo.schoolType': {
      label: 'Type of school (age 11–16)',
      path: 'eeo.schoolType',
      get: (p) => withSpellings(p.eeo.schoolType, SCHOOL_TYPES),
    },
    'eeo.freeSchoolMeals': simple('Free school meals', 'eeo.freeSchoolMeals'),
    // Menzies' "Did your household receive income support during your school years?": not in your profile, so yours.
    'eeo.incomeSupport': { label: 'Household income support', get: () => null, leave: true, derived: true },
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
  });

  Object.assign(P, { ETHNICITY_CHOICES, parseEthnicity });
})(typeof globalThis !== 'undefined' ? globalThis : this);
