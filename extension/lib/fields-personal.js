/*
 * JobToFill — field rules, personal details: your name, contact details, address, links, languages, cards and
 * accounts. One of the parts lib/fields.js puts together (loaded before it, in the order background.js lists them).
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});
  const U = JTF.util;
  const P = (JTF.fieldParts = JTF.fieldParts || {});
  const { LONG_TEXT, countryVal, dateVal, linkVal, listVal, optionTexts, regionVal, simple, val, withSpellings } = P;

  // A university's or school's address: name@ucl.ac.uk, name@mit.edu, name@student.unimelb.edu.au.
  const ACADEMIC_EMAIL =
    /@([a-z0-9-]+\.)*[a-z0-9-]+\.(ac|edu)(\.[a-z]{2})?$|@([a-z0-9-]+\.)*(student|students|stud|alumni)\./i;

  /** A list of US states ("AL / AK / … / WY / Other"). */
  function usStates(ctx) {
    const texts = optionTexts(ctx).filter((t) => t && !JTF.matcher.isPlaceholder(t));
    const states = texts.filter((t) => JTF.geo.findRegion(t, 'US'));
    return texts.length >= 5 && states.length / texts.length >= 0.6;
  }

  function fullName(p) {
    return [p.personal.firstName, p.personal.lastName].filter((s) => !U.isBlank(s)).join(' ');
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
    /^(are|do|can|could|would|is|have) (you|your)\b|^(fluent|fluency|proficient|proficiency) in\b|^(please )?confirm (that )?you (speak|are fluent|can speak)\b/;

  /** The languages a question names: "Are you fluent in French or German?" -> ["french", "german"]. */
  function languagesNamed(question) {
    return [...new Set(String(question || '').match(LANGUAGE_RE) || [])];
  }

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

  /**
   * An address for a suggestions list: searched as line 1 and the city (no flat number: "Apt 5" is in no suggestion),
   * matched on line 1, and preferring options that name your city, postcode, region or country (matcher.bestText).
   */
  function nearHome(v, p) {
    if (!v) return v;
    const a = p.address;
    v.near = [a.city, a.postalCode, a.state, a.country].filter((t) => !U.isBlank(t));
    if (!U.isBlank(a.line1)) {
      v.candidates = [...new Set([v.text, a.line1])];
      v.search = [a.line1, a.city].filter((t) => !U.isBlank(t)).join(', ');
    }
    return v;
  }

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

  const HONORIFIC = /^(mr|mrs|ms|miss|mx|dr|prof|sir|madam|herr|frau|mme|mlle)\b/;
  function hasHonorificOptions(desc) {
    return (desc.options || []).filter((o) => HONORIFIC.test(U.normalize(o.text))).length >= 2;
  }

  // What each type of field is filled with.
  Object.assign((P.DEFS = P.DEFS || {}), {
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
        // OC&C's "Known As": the name you go by, so your first name.
        // Isio's "Do you have a name you would prefer to use?" too.
        const first =
          /\b(first|given|short|nick ?name|forename|known as|goes by|go by|would prefer|prefer to (use|be called)|prenom|vorname|nombre|nome)\b/.test(
            q,
          );
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
        // A US citizenship-status list ("U.S. citizen / green card holder / … / Other (please explain)"): your
        // citizenship when it is listed (never a green card "of the United States" for an American), else Other.
        if (v) v.fallback = ['Other', 'Other (please explain)', 'Other (please specify)', 'None of the above'];
        if (v) v.citizen = JTF.geo.citizenWords(p.personal.nationality);
        return v;
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
      get(p, ctx) {
        if (ctx.kind === 'textarea') return P.DEFS['address.full'].get(p, ctx);
        // The only address box on the form (see matcher.plan): all of it on one line, or up to the postcode when the
        // form asks for the region and country apart.
        if (ctx.part === 'oneLine') {
          const v = P.DEFS['address.full'].get(p, ctx);
          return v && val(v.text.split('\n').join(', '));
        }
        if (ctx.part === 'withCity') {
          const a = p.address;
          return val(
            [a.line1, a.line2, [a.city, a.postalCode].filter(Boolean).join(' ')]
              .filter((t) => !U.isBlank(t))
              .join(', '),
          );
        }
        return nearHome(val(p.address.line1), p);
      },
    },
    'address.line2': simple('Address line 2', 'address.line2'),
    'address.street': {
      label: 'Street address',
      // An address search (Teamtailor's) lists every "12 Gower Street": the one in your city, postcode or country.
      get: (p) => nearHome(val([p.address.line1, p.address.line2].filter((s) => !U.isBlank(s)).join(', ')), p),
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
        // DV Trading's "If applicable, which US state do you reside in?" for someone in London: nothing to say.
        if (
          home &&
          home[0] !== 'US' &&
          /\b(us|u s|united states|american) states?\b/.test(ctx.question || '') &&
          !usStates(ctx)
        )
          return null;
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
      get(p, ctx) {
        const own = linkVal(p.links.portfolio || p.links.website);
        if (own) return own;
        // XY Capital's "Link to Portfolio" ("Portfolio link on linkedin/ Github etc"): the profile it names instead.
        // So does what the box is called ("/candidate/socialMediaGitHub" there).
        const said = `${ctx.question || ''} ${ctx.help || ''} ${ctx.names || ''}`;
        if (/git ?hub/.test(said)) return linkVal(p.links.github);
        if (/linked ?in/.test(said)) return linkVal(p.links.linkedin);
        return null;
      },
    },
    'links.website': {
      label: 'Website',
      path: 'links.website',
      get: (p) => linkVal(p.links.website || p.links.portfolio),
    },
    'links.twitter': simple('Twitter / X', 'links.twitter', linkVal),
    // Dayforce's "Fax" and "Pager", Chicago Trading Co's "Alternate Email": contact details beyond your own, yours to add.
    'contact.other': { label: 'Other contact details', get: () => null, leave: true, derived: true },
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
        // Cambridge Consultants' "Is English your primary language?", "What is your first language?": the first you list.
        if (/\b(first|primary|native|main|mother) (language|tongue)\b/.test(q)) {
          const items = listVal(p.languages) ? listVal(p.languages).items : [];
          if (!items.length) return null;
          const named = languagesNamed(q);
          return named.length ? val(named.includes(U.normalize(items[0])) ? 'Yes' : 'No') : val(items[0]);
        }
        // "Are you fluent in French?": yes when you listed it (left for you when you didn't).
        const asked = !other && YES_NO_LANGUAGE.test(q) ? languagesNamed(q) : [];
        if (asked.length) {
          const mine = listVal(text) ? listVal(text).items.map(U.normalize) : [];
          return asked.some((l) => mine.some((m) => m === l || m.split(' ').includes(l))) ? val('Yes') : null;
        }
        // Aurora's "Do you speak any non-European languages…? Please select 'None' if you do not.": "None" when the
        // list has none of yours.
        const v = listVal(text);
        if (v && /\bnone\b/.test(q)) v.fallback = ['None', 'None of the above', 'N/A'];
        return v;
      },
    },
    summary: simple('Summary', 'summary'),

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
  });

  Object.assign(P, { cardBrand, hasHonorificOptions, languagesNamed });
})(typeof globalThis !== 'undefined' ? globalThis : this);
