/*
 * JobToFill — Discover: who to email at a firm. Reads the firm's own public pages (home, team, about, contact and the
 * careers pages Discover found) for its mailboxes ("careers@", "info@"), the people it names with their titles and the
 * shape of its addresses ("jane.smith@"), and ranks who a student should write to. Pure logic plus fetches through an
 * injected fetch and JTF.discover (load lib/discover.js first); regex-based, so it also runs in a service worker and
 * in Node tests. It only reads public pages of the firm the person chose, and nothing leaves the browser. A guessed
 * address is only ever made from an address the firm's own site lists, and always says it is a guess.
 *
 *   kindOf(address)                  → 'recruiting' | 'general' | 'person' | 'other'
 *   emailsIn(html, { domain, name }) → [{ address, kind, name, source }]  (kind 'other' left out; the firm's name)
 *   peopleIn(html, { domain, name }) → [{ name, title, email, linkedin, role: 'recruiting'|'leadership'|'other' }]
 *   patternOf(emails, people)        → { pattern: 'first.last'|…|null, examples, sample, domain }
 *   guess(person, pattern, domain)   → 'jane.smith@firm.com' or ''
 *   linkKind({ url, text }, domain)  → 'contact page' | 'about page' | 'team page', or '' (a link not followed)
 *   contacts(firm, pages)            → { emails, people, pattern,
 *                                        best: [{ address, name, title, kind, role?, why, guessed, page }] }
 *   findContacts(firm, { fetch, pages, now }) → contacts(…) plus { log, status: 'found'|'none'|'unreachable' }
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});
  /** Discover's helpers, looked up when used so the two scripts can load in either order. */
  const D = () => JTF.discover;

  // Guessed only until two answer, like discover.js's CAREER_PATHS, and each kind early: Egerton Capital's home page
  // is a terms gate, and its /contact/ (a general mailbox, the only way in) came ninth, past the 8 fetches.
  const CONTACT_PATHS = [
    '/team',
    '/contact',
    '/about',
    '/team/',
    '/people',
    '/contact-us',
    '/about-us',
    '/our-team',
    '/our-people',
    '/leadership',
    '/careers/contact',
  ];
  const MAX_FETCHES = 8;
  const TIMEOUT = 15000;

  /* -------------------------------------------------------------- mailboxes */

  const words = (lines) => new Set(lines.join(' ').split(' '));
  const RECRUITING = words([
    'careers career recruiting recruitment recruit jobs job talent hr people campus graduates',
    'graduate grads internships internship interns intern students student earlycareers apply',
    'applications application hiring join joinus work resourcing humanresources candidates cv cvs',
    'hrteam peopleteam peopleops',
  ]);
  const RECRUITING_STEM =
    /recruit|career|talent|internship|interns?$|graduat|campus|hiring|resourcing|candidate|student|humanresource|^(join|work)(us|withus|forus|theteam|ourteam)$/;
  // An office's mailbox: "info@", "london@", "info.uk@".
  const GENERAL = words([
    'info information international contact contactus hello hi enquiries enquiry inquiries inquiry office offices',
    'admin general mail team reception london newyork nyc paris dublin edinburgh glasgow singapore',
    'hongkong geneva zurich boston chicago sanfrancisco dallas austin toronto sydney tokyo munich',
    'frankfurt berlin amsterdam stockholm luxembourg jersey guernsey miami greenwich stamford',
  ]);
  const GENERAL_STEM = /^(info|contact|hello|enquir|inquir|office|reception)/;
  const REGION = words(['uk us usa gb eu emea apac europe americas asia global ny hq']);
  const OTHER = words([
    'press media ir investors investor investorrelations compliance legal privacy dpo gdpr',
    'dataprotection abuse support help helpdesk sales marketing billing accounts accounting finance',
    'invoices invoice payments payables noreply donotreply unsubscribe security webmaster postmaster',
    'hostmaster mailerdaemon newsletter news events feedback complaints partnerships sponsorship',
    'bounce bounces example test email name yourname firstname lastname firstnamelastname firstlast',
    'user username you your me someone operations ops trading research it tech data service services',
    'orders booking bookings membership members subscriptions editor editorial communications comms',
    'pr whistleblowing ethics procurement suppliers licensing copyright dmca root',
    'workday greenhouse taleo icims workable successfactors smartrecruiters bamboohr teamtailor personio jobvite',
  ]);
  // A mailbox no one reads, wherever it sits in the address: "jobs-noreply@", "careers-no-reply@", "talent.alerts@".
  const UNREAD = /noreply|donotreply|notif|mailerdaemon|bounce|unsubscribe|autoreply|alert/;
  // Words departments, mailboxes and headings are made of but no one is named ("internal@", "Machine Learning").
  const COMMON = words([
    'machine learning customer customers success team teams investment investments equity asset assets management',
    'research trading operations technology engineering product products sales marketing finance legal compliance',
    'risk data cloud platform growth people talent careers about contact our the and services solutions group',
    'capital partners partner advisory global europe london york internal external business new support science',
    'sciences infrastructure security design strategy development digital innovation analytics quantitative',
    'systematic macro credit private public corporate commercial retail wealth venture ventures impact applied',
    'artificial intelligence software hardware mobile web reliability quality assurance user experience brand',
    'content communications community partnerships enablement revenue supply chain logistics facilities workplace',
    'tax audit treasury payments lending healthcare climate staff employees everyone general enquiries requests',
    'deals dealflow submissions proposals founders startups portfolio companies accounts payroll admin human',
    'resources department division desk executive committee board leadership office offices markets fixed income',
    'structured systems devops frontend backend stack ai ml recruiting recruitment hiring mail inbox',
  ]);
  const OFFICE = new Set([...GENERAL, ...REGION]);

  /** Are most of these words ones departments and headings are made of ("customer success"), so no one's name? */
  function wordy(list, also) {
    const long = list.filter((w) => w.length > 1);
    const common = long.filter((w) => COMMON.has(w) || (also && also.has(w)));
    return long.length > 0 && common.length * 2 > long.length;
  }

  /** What an address is for, from its local part: a recruiting or general mailbox, a person, or neither. */
  function kindOf(address) {
    const local = String(address || '')
      .toLowerCase()
      .split('@')[0]
      .split('+')[0];
    const tokens = local
      .replace(/\d+/g, ' ')
      .split(/[\s._-]+/)
      .filter(Boolean);
    const joined = tokens.join('');
    if (!joined || UNREAD.test(joined) || OTHER.has(joined)) return 'other';
    // "internships2027", "campus.recruiting", "uk-careers", "workwithus".
    if (RECRUITING.has(joined) || tokens.some((t) => RECRUITING.has(t)) || RECRUITING_STEM.test(joined))
      return 'recruiting';
    if (tokens.some((t) => OTHER.has(t))) return 'other';
    if (GENERAL.has(joined) || GENERAL_STEM.test(joined) || tokens.every((t) => GENERAL.has(t) || REGION.has(t)))
      return 'general';
    // "internal@", "partners@", "new.business@": a department, not a name ("jack.london@" is one).
    if (wordy(tokens, OFFICE)) return 'other';
    // "jane.smith", "jsmith", "j.smith", "jane": a word that could be a name, or two with one separator.
    if (/^[a-z]{3,20}$/.test(local) || (local.length <= 40 && /^[a-z]+[._-][a-z]+$/.test(local))) return 'person';
    return 'other';
  }

  /* ---------------------------------------------------------------- text */

  // prettier-ignore
  const NAMED = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', commat: '@', period: '.', lowbar: '_', hyphen: '-',
    dash: '-', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', szlig: 'ß', aelig: 'æ', oslash: 'ø', zwj: '', zwnj: '',
    shy: '',
  };
  const MARKS = { acute: '\u0301', grave: '\u0300', circ: '\u0302', uml: '\u0308', tilde: '\u0303', cedil: '\u0327' };
  // Characters a page slips into an address to hide it from robots.
  const INVISIBLE = /[\u00ad\u200b-\u200f\u2060\ufeff]/g;

  /** Every HTML entity decoded: "jane&#64;firm.com", "Ren&eacute;e". */
  function decodeHtml(s) {
    return String(s || '').replace(/&(#x[\da-f]+|#\d+|[a-z][a-z\d]{1,8});?/gi, (m, e) => {
      if (e[0] === '#') {
        const code = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      }
      if (Object.prototype.hasOwnProperty.call(NAMED, e)) return NAMED[e];
      const a = e.match(/^([a-z])(acute|grave|circ|uml|tilde|cedil)$/i);
      return a ? (a[1] + MARKS[a[2].toLowerCase()]).normalize('NFC') : m;
    });
  }

  /** A page's markup without what never shows: comments, scripts, styles, icons. */
  function visible(html) {
    return String(html || '')
      .slice(0, 1500000)
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  }

  /** Plain one-line text of a fragment: tags dropped, entities decoded, hidden characters removed. */
  function plain(html) {
    return decodeHtml(String(html || '').replace(/<[^>]*>/g, ' '))
      .replace(INVISIBLE, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** A name as an address would spell it: "Renée O'Neil-Smith" → "renee oneilsmith". */
  function asciiName(s) {
    return String(s || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/ß/g, 'ss')
      .replace(/ø/g, 'o')
      .replace(/æ/g, 'ae')
      .replace(/ł/g, 'l')
      .replace(/['’‘-]/g, '')
      .replace(/[^a-z]+/g, ' ')
      .trim();
  }

  /* ------------------------------------------------------------- addresses */

  const ADDRESS = /[a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;
  const SHAPE = /^[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9_])?@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
  // "logo@2x.png" and the like, and the addresses of templates, trackers and examples.
  const FILE_END = /\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|json|xml|pdf|zip|mp4|webm|woff2?|ttf)$/;
  const JUNK_DOMAIN =
    /(^|\.)(example\.(com|org|net)|domain\.com|yourdomain\.com|yourcompany\.com|company\.com|email\.com|test\.com|sentry\.io|sentry-next\.wixpress\.com|wixpress\.com)$/;

  /** A real-looking address in lower case, or ''. */
  function clean(raw) {
    let a = String(raw || '')
      .replace(/^mailto:/i, '')
      .split('?')[0]
      .trim()
      .toLowerCase();
    try {
      a = decodeURIComponent(a);
    } catch (err) {
      // Left as it was.
    }
    if (!SHAPE.test(a) || /\.\./.test(a) || FILE_END.test(a) || JUNK_DOMAIN.test(a.split('@')[1])) return '';
    return a;
  }

  /**
   * Is a domain's label the firm's name cut short, word by word from the first: each word's first three letters or
   * more (all of a shorter word), "egercap" for Egerton Capital; a single word only whole ("egerton", not "eger").
   */
  function shortFor(label, name) {
    const list = asciiName(name).replace(/^the /, '').split(' ').filter(Boolean);
    const s = String(label || '').replace(/-/g, '');
    const fits = (rest, i, pieces) => {
      if (!rest) return pieces > 1;
      const w = list[i] || '';
      for (let n = Math.min(w.length, rest.length); n > 0 && n >= Math.min(3, w.length); n--)
        if (rest.startsWith(w.slice(0, n)) && fits(rest.slice(n), i + 1, pieces + 1)) return true;
      return false;
    };
    return s.length >= 4 && list.length > 0 && (s === list[0] || fits(s, 0, 0));
  }

  /**
   * Is the address the firm's: on its domain or a subdomain, the same name under another ending (acme.co.uk), or its
   * name cut short (Egerton Capital's site lists "info@egercap.co.uk")?
   */
  function ownDomain(address, { domain, name } = {}) {
    const d = address.split('@')[1] || '';
    const firm = String(domain || '')
      .toLowerCase()
      .replace(/^www\./, '');
    if (d === firm || d.endsWith('.' + firm)) return true;
    const label = (x) => D().domainOf(x).split('.')[0];
    const a = label(d);
    return (a.length >= 4 && a === label(firm)) || shortFor(a, name);
  }

  /** Should an address found on the firm's page be offered? Another domain's only as a recruiting mailbox. */
  function wanted(address, kind, own = {}) {
    if (kind === 'other') return false;
    return !own.domain || ownDomain(address, own) || kind === 'recruiting';
  }

  /** The written-out forms: "jane [at] firm [dot] com", "jane (at) firm (dot) com", "jane at firm dot com". */
  function unobfuscate(text) {
    return text
      .replace(/\s*[[({<]\s*(?:at|@)\s*[\])}>]\s*/gi, '@')
      .replace(/\s*[[({<]\s*(?:dot|\.)\s*[\])}>]\s*/gi, '.')
      .replace(
        /\b([a-z0-9][a-z0-9._-]*(?:\s+dot\s+[a-z0-9_-]+)*)\s+at\s+([a-z0-9-]+(?:\s+dot\s+[a-z0-9-]+)+)\b/gi,
        (m, local, host) =>
          // "Meet us at Acme dot com" isn't an address.
          /^(us|me|you|him|her|them|it|we|one|look|apply|email|write|online|here)$/i.test(local)
            ? m
            : `${local.replace(/\s+dot\s+/gi, '.')}@${host.replace(/\s+dot\s+/gi, '.')}`,
      );
  }

  /** The page's JSON-LD flattened: [{ type, name, title, email, links }] for each Person and anything with an email. */
  function jsonLd(html) {
    const out = [];
    const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi;
    for (const m of String(html || '').matchAll(re)) {
      try {
        walk(JSON.parse(m[1].replace(/^\s*(<!--|\/\/\s*<!\[CDATA\[)|(-->|\/\/\s*\]\]>)\s*$/g, '')), out, 0);
      } catch (err) {
        // A broken block says nothing.
      }
    }
    return out;
  }

  const str = (v) => (typeof v === 'string' ? v : v && typeof v.name === 'string' ? v.name : '');

  /** Collect people and addresses from a JSON-LD value (an Organization's employees and founders included). */
  function walk(v, out, depth) {
    if (!v || typeof v !== 'object' || depth > 8) return;
    if (Array.isArray(v)) {
      for (const x of v.slice(0, 200)) walk(x, out, depth + 1);
      return;
    }
    const type = [].concat(v['@type'] || []).join(' ');
    if (v.email || /\bPerson\b/.test(type))
      out.push({
        type,
        name: plain(str(v.name)),
        title: plain(str(v.jobTitle)),
        email: str(v.email),
        links: [].concat(v.sameAs || [], v.url || []).filter((x) => typeof x === 'string'),
      });
    for (const k of Object.keys(v)) if (v[k] && typeof v[k] === 'object') walk(v[k], out, depth + 1);
  }

  /**
   * Every address on a page: [{ address, kind, name, source }], first find first. Kind 'other' (press@, legal@…)
   * is left out, and so is an address on another domain unless it is a recruiting mailbox (a fund whose hiring goes
   * through "recruiting@acmerecruiting.com"): a law firm's or an advertiser's address on the page is not the firm's.
   * own: { domain, name }, the firm's domain and name.
   */
  function emailsIn(html, own = {}) {
    const raw = String(html || '');
    const lower = raw.toLowerCase();
    const seen = new Map();
    const add = (candidate, source, hint) => {
      const address = clean(candidate);
      if (!address) return;
      const had = seen.get(address);
      const kind = kindOf(address);
      if (had) {
        if (!had.name && kind === 'person') had.name = nameFor(address, hint);
        return;
      }
      if (!wanted(address, kind, own)) return;
      seen.set(address, { address, kind, name: kind === 'person' ? nameFor(address, hint) : '', source });
    };
    for (const p of jsonLd(raw)) if (p.email) add(p.email, 'jsonld', /\bPerson\b/.test(p.type) ? p.name : '');
    const shown = visible(raw);
    for (const m of shown.matchAll(/<a\b[^>]*href\s*=\s*["']?\s*mailto:([^"'\s>]+)[^>]*>([\s\S]*?)<\/a\s*>/gi))
      add(decodeHtml(m[1]).replace(INVISIBLE, ''), 'mailto', plain(m[2]));
    for (const m of decodeHtml(shown).matchAll(/mailto:([^"'\s<>?]+)/gi)) add(m[1].replace(INVISIBLE, ''), 'mailto');
    for (const m of raw.matchAll(/(?:data-cfemail\s*=\s*["']?|email-protection#)([\da-f]{8,})/gi))
      add(D().cfEmail(m[1]), 'cloudflare');
    const text = plain(shown);
    // Spelt out in the page's text, or only after its entities and hidden characters are undone ("jane&#64;firm.com").
    for (const m of text.matchAll(ADDRESS)) add(m[0], lower.includes(m[0].toLowerCase()) ? 'text' : 'obfuscated');
    for (const m of unobfuscate(text).matchAll(ADDRESS)) add(m[0], 'obfuscated');
    return [...seen.values()];
  }

  /* --------------------------------------------------------------- people */

  // Words in headings that two capitalised words can be but a person's name isn't ("Asset Management", "Our Team").
  const NOT_NAME = words([
    'capital partners management ltd limited llp llc inc plc group holdings fund funds investment',
    'investments investing investors advisors advisers advisory associates securities trading',
    'technologies technology bank banking asset assets equity ventures labs lab systems solutions',
    'services software consulting research analytics markets global international financial finance',
    'foundation trust company corporation studio studios games media data quant credit income estate',
    'real property properties insurance energy health our the a an and of for to in on at with by',
    'from meet team teams contact us get touch news latest more about who we are what do how why join',
    'view see all careers career jobs people leadership board directors values culture history',
    'mission vision offices office locations location privacy cookie cookies terms policy notice menu',
    'home search open back next previous apply now learn sign log login follow share email phone call',
    'linkedin twitter profile bio portfolio insights approach strategy overview welcome hello thank',
    'thanks you your my featured facts events press release opportunities internship internships',
    'graduate graduates programme program programmes programs students student roles positions',
    'vacancies openings benefits life working work here early spring week insight diversity inclusion',
    'sustainability responsible governance disclosures legal regulatory important information client',
    'clients investor relations documents reports report performance expertise sectors sector',
    'industries platform products product study studies street road square avenue house place court',
    'floor building tower row way gardens wharf new york hong kong san los south east america united',
    'kingdom states london',
  ]);
  const PARTICLE = /^(van|von|de|der|den|du|da|di|la|le|del|della|dos|das|bin|al|ter)$/i;
  const NAME_WORD = /^\p{Lu}[\p{Ll}'’]+(?:\p{Lu}[\p{Ll}'’]+)?(?:-\p{Lu}[\p{Ll}'’]+)*$/u;
  const POSTNOMINAL = /,?\s+(CFA|PhD|MBA|CPA|ACA|FCA|ACCA|OBE|MBE|CBE|KBE|FRS|Jr|Sr|II|III|IV)\b\.?/g;
  const HONORIFIC = /^(Dr|Mr|Mrs|Ms|Miss|Mx|Prof|Professor|Sir|Dame|Lord|Lady)\.?\s+/i;
  // What a person's title says: anyone with one of these words in the line under their name.
  const ROLE =
    /\b(co-?founder|founder|partner|ceo|coo|cfo|cto|cio|cro|chief|president|chair(man|woman|person)?|director|principal|head|manager|managing|lead|officer|counsel|vp|analyst|associate|engineer|developer|researcher|scientist|trader|portfolio|strategist|economist|recruit\w*|talent|people|hr|human resources|campus|early careers|graduate|university relations|student|hiring|coordinator|specialist|advis[oe]r|consultant|assistant|executive|secretary|administrator|accountant|controller|treasurer|designer|architect|operations|business development)\b/i;
  const RECRUITING_ROLE =
    /recruit|talent|\bpeople\b|\bhr\b|human resources|campus|early careers|graduate recruitment|university relations|student|hiring/i;
  const LEADERSHIP_ROLE =
    /founder|managing partner|\bpartner\b|\b(ceo|coo|cfo|cto|cio)\b|\bchief\b|(?<!vice )\bpresident\b|managing director|head of|\bdirector\b|\bprincipal\b|general manager/i;
  const LINKEDIN = /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[\w%-]+\/?/i;

  /** A person's name as written, without "Dr" or ", CFA"; capitals restored for "JANE SMITH". */
  function tidyName(text) {
    let t = plain(text).replace(POSTNOMINAL, '').replace(HONORIFIC, '').replace(/[,.]$/, '').trim();
    if (t === t.toUpperCase() && /\p{Lu}{2}/u.test(t))
      t = t
        .toLowerCase()
        .replace(/(^|[\s'’-])(\p{Ll})/gu, (m, a, b) => a + b.toUpperCase())
        .replace(/(?<=\s)\S+(?=\s)/g, (w) => (PARTICLE.test(w) ? w.toLowerCase() : w));
    return t;
  }

  /** Does this text look like a person's name: 2–4 capitalised words (initials, Mc/Mac, van/de allowed), no more? */
  function isName(text) {
    const t = tidyName(text);
    if (t.length < 4 || t.length > 50 || /[\d@/|:;!?()&+=#"“”]/.test(t) || ROLE.test(t)) return false;
    const list = t.split(' ');
    if (list.length < 2 || list.length > 4 || PARTICLE.test(list[0])) return false;
    let full = 0;
    for (const w of list) {
      if (PARTICLE.test(w) || /^\p{Lu}\.?$/u.test(w)) continue;
      if (NOT_NAME.has(w.toLowerCase().replace(/[.,]/g, '')) || !NAME_WORD.test(w)) return false;
      full++;
    }
    return full >= 1;
  }

  /** 'recruiting', 'leadership' or 'other', from a person's title. */
  function roleOf(title) {
    if (RECRUITING_ROLE.test(title || '')) return 'recruiting';
    if (LEADERSHIP_ROLE.test(title || '')) return 'leadership';
    return 'other';
  }

  const ROLE_RANK = { recruiting: 0, leadership: 1, other: 2 };

  // Words a title joins its parts with: "Head of Talent", "Founder & CEO".
  const JOINER = /^(of|and|the|for|at|in|on|to|with|de|la|des|du|[^\p{L}\d]*)$/iu;

  /**
   * A line of text that reads as a job title ("Head of Talent", "Partner, Credit"): short, mostly capitalised or role
   * words, not a sentence ("Lead by our CTO, the team builds models."), and not the heading's own words again ("Head of
   * Customer Success" under "Customer Success" makes that a section, not a person).
   */
  function isTitle(s, name) {
    if (!ROLE.test(s) || s.length > 80 || /@/.test(s) || isName(s) || /\b\p{Ll}{3,}[.!?](\s|$)/u.test(s)) return false;
    const list = s.split(' ');
    if (list.length > 8 || (name && ` ${asciiName(s)} `.includes(` ${asciiName(name)} `))) return false;
    const content = list.map((w) => w.replace(/^[^\p{L}\d]+|[^\p{L}\d]+$/gu, '')).filter((w) => !JOINER.test(w));
    return content.filter((w) => /^[\p{Lu}\d]/u.test(w) || ROLE.test(w)).length * 2 >= content.length;
  }

  /** Add a person, or fill in what an earlier mention of them lacked. */
  function addPerson(map, p) {
    const key = asciiName(p.name);
    const had = map.get(key);
    if (!had) return map.set(key, { ...p });
    for (const k of ['title', 'email', 'linkedin']) if (!had[k] && p[k]) had[k] = p[k];
    had.role = roleOf(had.title);
    return map;
  }

  /** Does a link's wording name this person, by first or last name ("Email Anna", aria-label "Write to Jane Smith")? */
  function namesPerson(text, name) {
    const said = ` ${asciiName(text)} `;
    const list = asciiName(tidyName(name))
      .split(' ')
      .filter((w) => w.length > 1);
    return list.length > 0 && [list[0], list[list.length - 1]].some((w) => said.includes(` ${w} `));
  }

  /** An attribute's text from a tag's attributes ('' when it has none). */
  function attr(attrs, name) {
    const m = attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
    return m ? plain(m[1] || m[2] || '') : '';
  }

  /**
   * The address in a person's card that is theirs: one that spells their name ("jane.smith", "jsmith"), or a mailto
   * near the name whose words or aria-label name them ("Email Anna"). Never just the nearest: the last card runs to the
   * end of the page, where "Internal enquiries: internal@acme.com" is nobody's.
   */
  function ownAddress(card, near, name, own) {
    const spelt = emailsIn(card, own).find((e) => e.kind === 'person' && namesMatch(e.address, name));
    if (spelt) return spelt.address;
    for (const m of near.matchAll(/<a\b([^>]*?\bhref\s*=\s*["']?\s*mailto:([^"'\s>]+)[^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
      const address = clean(decodeHtml(m[2]).replace(INVISIBLE, ''));
      const label = [plain(m[3]), attr(m[1], 'aria-label'), attr(m[1], 'title')].join(' ');
      if (!address || kindOf(address) !== 'person' || !wanted(address, 'person', own)) continue;
      if (namesPerson(label, name)) return address;
    }
    return '';
  }

  /**
   * People a team, leadership or contact page names: [{ name, title, email, linkedin, role }], recruiting first, at
   * most 40. From JSON-LD Persons, then "cards": a name in a heading, <strong>, <b>, an element whose class says
   * name/member/profile…, or a photo's alt text, followed within its card by a line that reads as a title. A name in
   * a heading needs more to count: their photo, LinkedIn or own address, a JSON-LD Person, or a partner's or a
   * recruiter's title; and words a heading is made of ("Machine Learning") are no one's name, whatever is beside them.
   */
  function peopleIn(html, own = {}) {
    const raw = String(html || '');
    const map = new Map();
    for (const p of jsonLd(raw)) {
      if (!/\bPerson\b/.test(p.type) || !isName(p.name)) continue;
      const email = clean(p.email);
      addPerson(map, {
        name: tidyName(p.name),
        title: p.title.slice(0, 120),
        email: email && kindOf(email) === 'person' && wanted(email, 'person', own) ? email : '',
        linkedin: (p.links.find((l) => LINKEDIN.test(l)) || '').replace(/[?#].*$/, ''),
        role: roleOf(p.title),
      });
    }
    const body = visible(raw);
    const found = [];
    const take = (re, textAt, photo = false) => {
      // Matches may nest (a member's card around the element with their name), so each search starts one on.
      for (let m = re.exec(body); m; re.lastIndex = m.index + 1, m = re.exec(body)) {
        const name = tidyName(textAt(m));
        if (isName(name)) found.push({ start: m.index, end: m.index + m[0].length, name, key: asciiName(name), photo });
      }
    };
    take(/<(h[2-6]|strong|b)\b[^>]*>([\s\S]{1,300}?)<\/\1\s*>/gi, (m) => m[2]);
    take(
      /<([a-z][\w-]*)\b[^>]*?\b(?:class|id)\s*=\s*["'][^"']*?(?:name|member|person|profile|bio|staff|title)[^"']*["'][^>]*>([\s\S]{1,300}?)<\/\1\s*>/gi,
      (m) => m[2],
    );
    take(
      /<img\b[^>]*?\balt\s*=\s*(?:"([^"]{3,100})"|'([^']{3,100})')[^>]*>/gi,
      (m) =>
        (m[1] || m[2]).replace(
          /^(photo|picture|portrait|image|headshot)( of)?\s+|\s+(photo|headshot|portrait|image)$/gi,
          '',
        ),
      true,
    );
    found.sort((a, b) => a.start - b.start);
    for (const [i, c] of found.entries()) {
      // A card runs until the next person's name (≈ 400 characters at most for the title).
      const next = found.slice(i + 1).find((n) => n.start >= c.end && n.key !== c.key);
      const stop = next ? next.start : body.length;
      const near = body.slice(c.end, Math.min(stop, c.end + 400));
      const lines = near
        .split(/<[^>]*>/)
        .map((s) => plain(s).replace(/^[\s,–—|:•·-]+|[\s,–—|:•·-]+$/g, ''))
        .filter(Boolean)
        .slice(0, 4);
      const title = lines.find((l) => isTitle(l, c.name));
      if (!title || wordy(asciiName(c.name).split(' '))) continue;
      const card = body.slice(c.end, Math.min(stop, c.end + 800));
      const email = ownAddress(card, near, c.name, own);
      const linkedin = (decodeHtml(card).match(LINKEDIN) || [''])[0];
      const role = roleOf(title);
      const photo = found.some((f) => f.photo && f.key === c.key);
      if (!photo && !linkedin && !email && !map.has(c.key) && role === 'other') continue;
      addPerson(map, { name: c.name, title, email, linkedin, role });
    }
    return [...map.values()].sort((a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role]).slice(0, 40);
  }

  /* ------------------------------------------------------------- patterns */

  const PATTERNS = ['first.last', 'first', 'flast', 'firstl', 'first_last', 'f.last', 'last', 'first-last'];

  /** First and last name as an address spells them: "Jane A. van der Berg" → { first: 'jane', last: 'vanderberg' }. */
  function nameParts(name) {
    const list = asciiName(tidyName(name)).split(' ').filter(Boolean);
    const rest = list.slice(1).filter((w) => w.length > 1);
    return { first: list[0] || '', last: rest.join(''), words: list.length };
  }

  /** A local part in a pattern ('' when the name lacks what it needs). */
  function build(pattern, { first: f, last: l }) {
    if (!f || (pattern !== 'first' && !l)) return '';
    // prettier-ignore
    switch (pattern) {
      case 'first.last': return `${f}.${l}`;
      case 'first': return f;
      case 'flast': return f[0] + l;
      case 'firstl': return f + l[0];
      case 'first_last': return `${f}_${l}`;
      case 'f.last': return `${f[0]}.${l}`;
      case 'last': return l;
      case 'first-last': return `${f}-${l}`;
      default: return '';
    }
  }

  const localOf = (address) =>
    String(address || '')
      .toLowerCase()
      .split('@')[0]
      .split('+')[0];

  /** Could this address be this person's, in any of the patterns ("jsmith" for Jane Smith)? */
  function namesMatch(address, name) {
    const local = localOf(address);
    const parts = nameParts(name);
    return PATTERNS.some((p) => build(p, parts) === local);
  }

  /** Could two written names be one person's ("Tom O'Neil" and "Tom Oneil", "Jan van der Berg" or "Jan Vanderberg")? */
  function samePerson(a, b) {
    const x = nameParts(a);
    const y = nameParts(b);
    return x.first === y.first && (x.last.endsWith(y.last) || y.last.endsWith(x.last));
  }

  /** Is this address listed for someone other than this person: another person's own, or linked under their name? */
  function someoneElses(address, person, people, listedAs) {
    if (people.some((q) => q !== person && q.email === address)) return true;
    return !!listedAs && !!listedAs.name && !samePerson(listedAs.name, person.name);
  }

  /** A person-kind address's owner: a name beside it that the address spells, else "jane.smith" → "Jane Smith". */
  function nameFor(address, hint) {
    if (hint && isName(hint) && namesMatch(address, hint)) return tidyName(hint);
    const m = localOf(address).match(/^([a-z]{2,})[._-]([a-z]{2,})$/);
    const cap = (w) => w[0].toUpperCase() + w.slice(1);
    return m ? `${cap(m[1])} ${cap(m[2])}` : '';
  }

  /**
   * The firm's address pattern, from its person addresses matched to people's names (or, with no name to match,
   * from shapes that can only be one thing: "a.b" first.last, "a_b", "a-b", "j.smith"): { pattern, examples, sample }.
   */
  function patternOf(emails, people) {
    const list = (emails || [])
      .map((e) => (typeof e === 'string' ? { address: e.toLowerCase(), kind: kindOf(e), name: '' } : e))
      .filter((e) => e && e.address && e.kind === 'person');
    const names = [
      ...new Set([...(people || []).map((p) => (typeof p === 'string' ? p : p && p.name)), ...list.map((e) => e.name)]),
    ]
      .filter(Boolean)
      .map(nameParts)
      .filter((n) => n.first && n.last);
    const tally = (votes) => {
      let best = null;
      for (const p of PATTERNS) if (votes.has(p) && (!best || votes.get(p).length > votes.get(best).length)) best = p;
      if (!best) return null;
      const sample = votes.get(best)[0];
      return { pattern: best, examples: votes.get(best).length, sample, domain: sample.split('@')[1] };
    };
    const vote = (votes, p, address) => votes.set(p, [...(votes.get(p) || []), address]);
    const byName = new Map();
    for (const e of list) {
      const local = localOf(e.address);
      const hits = new Set();
      for (const n of names) for (const p of PATTERNS) if (build(p, n) === local) hits.add(p);
      for (const p of hits) vote(byName, p, e.address);
    }
    const named = tally(byName);
    if (named) return named;
    // "jsmith" could be J. Smith or Jsmith; "jane" a first name or a surname: those prove nothing.
    const byShape = new Map();
    for (const e of list) {
      const m = localOf(e.address).match(/^([a-z]+)([._-])([a-z]+)$/);
      if (!m || m[3].length < 2) continue;
      if (m[1].length >= 2) vote(byShape, { '.': 'first.last', _: 'first_last', '-': 'first-last' }[m[2]], e.address);
      else if (m[2] === '.') vote(byShape, 'f.last', e.address);
    }
    return tally(byShape) || { pattern: null, examples: 0, sample: '', domain: '' };
  }

  /** A person's address in the firm's pattern, or '' (a name of one word only fits 'first'). */
  function guess(person, pattern, domain) {
    const p = typeof pattern === 'string' ? pattern : pattern && pattern.pattern;
    const name = typeof person === 'string' ? person : person && person.name;
    let d = String(domain || '').toLowerCase();
    if (/[/:]/.test(d)) d = D().domainOf(d);
    d = d.replace(/^.*@/, '').replace(/^www\./, '');
    if (!PATTERNS.includes(p) || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) return '';
    const parts = nameParts(name);
    // "Machine Learning" is a section, and machine.learning@ no one's.
    if ((p !== 'first' && parts.words < 2) || wordy(asciiName(name).split(' '))) return '';
    // An initial isn't a first name: "J. Smith" can't be first.last.
    if (/^(first\.last|first|firstl|first_last|first-last)$/.test(p) && parts.first.length < 2) return '';
    const local = build(p, parts);
    return local ? `${local}@${d}` : '';
  }

  /* -------------------------------------------------------------- ranking */

  const CAREERS_PAGE =
    /career|\bjobs?\b|join|vacanc|recruit|graduate|intern|student|early-careers|opportunit|work-with-us|working-here/i;

  const pathOf = (url) => {
    try {
      return new URL(url).pathname.replace(/\/+$/, '');
    } catch (err) {
      return '';
    }
  };

  /** What a page is, for the card: "careers page", "team page", "contact page"… */
  function pageName(url) {
    const path = pathOf(url).toLowerCase();
    if (!path) return 'home page';
    if (CAREERS_PAGE.test(path)) return 'careers page';
    if (/contact/.test(path)) return 'contact page';
    if (/team|people|leadership|partners|staff|who-we-are/.test(path)) return 'team page';
    if (/about/.test(path)) return 'about page';
    // Darktrace's "About Us" is /company.
    if (/(^|\/)company$/.test(path)) return 'company page';
    return 'website';
  }

  /** The domain the firm's addresses are on, as far as its site says. */
  function firmDomain(firm, pages) {
    const d = D();
    return (
      (firm && (firm.domain || d.domainOf(firm.site || ''))) ||
      d.domainOf(((pages || []).find((p) => p && p.url) || {}).url || '')
    );
  }

  /**
   * Everything the pages say about whom to write to, merged, and the best (at most 5) ranked: recruiting mailboxes
   * (on a careers page first), named recruiters with a listed address, then with a guessed one (only from a pattern
   * the site shows), a general mailbox, and at a small firm (150 staff or fewer, or unknown) its leaders. pages:
   * [{ url, html, careers?: bool, isFirm?: bool, kind?: 'contact page'… }]; a page that isn't the firm's (isFirm
   * false) gives no person's address and no people; kind names a page by what it was read as (Darktrace's /company
   * its about page).
   */
  function contacts(firm, pages) {
    const domain = firmDomain(firm, pages);
    const owner = { domain, name: (firm && firm.name) || '' };
    const emails = new Map();
    const people = new Map();
    const kinds = new Map();
    const nameOf = (url) => kinds.get(url) || pageName(url);
    for (const page of pages || []) {
      if (!page || !page.html) continue;
      const url = page.url || '';
      if (page.kind && !kinds.has(url)) kinds.set(url, page.kind);
      const careersPage = page.careers === true || CAREERS_PAGE.test(pathOf(url));
      const trusted = page.isFirm !== false;
      for (const e of emailsIn(page.html, owner)) {
        if (!trusted && e.kind === 'person') continue;
        const had = emails.get(e.address);
        if (!had) emails.set(e.address, { ...e, page: url, careersPage });
        else {
          if (!had.name && e.name) had.name = e.name;
          if (careersPage && !had.careersPage) Object.assign(had, { page: url, careersPage });
        }
      }
      if (!trusted) continue;
      for (const p of peopleIn(page.html, owner)) addPerson(people, { ...p, page: url });
    }
    const emailList = [...emails.values()];
    const personal = emailList.filter((e) => e.kind === 'person');
    const peopleList = [...people.values()].sort((a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role]).slice(0, 40);
    // An address listed anywhere on the site is a person's own when it spells their name and no one else's: not
    // another listed person's ("jsmith" for Jane or John Smith), nor one a link names someone else for.
    for (const p of peopleList) {
      const own = personal.find(
        (e) =>
          namesMatch(e.address, p.name) &&
          !someoneElses(e.address, p, peopleList, e) &&
          !peopleList.some((q) => q !== p && namesMatch(e.address, q.name)),
      );
      if (!own) continue;
      if (!p.email) p.email = own.address;
      if (!own.name) own.name = p.name;
    }
    const pattern = patternOf(emailList, peopleList);
    const at = pattern.domain || domain;
    const best = [];
    const add = (entry) => {
      if (best.length < 5 && entry.address && !best.some((b) => b.address === entry.address)) best.push(entry);
    };
    const student = (e) => (/intern|grad|campus|student|early/.test(e.address) ? 1 : 0);
    const mailboxes = emailList
      .filter((e) => e.kind === 'recruiting')
      .sort((a, b) => b.careersPage - a.careersPage || student(b) - student(a));
    for (const e of mailboxes)
      add({
        address: e.address,
        name: '',
        title: '',
        kind: 'recruiting',
        why: `Listed on its ${e.careersPage ? 'careers page' : nameOf(e.page)}`,
        guessed: false,
        page: e.page,
      });
    const listed = (p) => ({
      address: p.email,
      name: p.name,
      title: p.title,
      kind: 'person',
      role: p.role,
      why: `${p.title ? `${p.title}, listed` : 'Listed'} on the ${nameOf(p.page)}`,
      guessed: false,
      page: p.page || '',
    });
    const n = pattern.examples;
    const guessed = (p) => {
      const address = pattern.pattern && n >= 1 ? guess(p, pattern, at) : '';
      if (!address) return {};
      const on = emails.get(address);
      // Jane Smith's "jsmith@" guess is John Smith's own when the site lists it as his: not hers, guessed or listed.
      if (someoneElses(address, p, peopleList, on)) return {};
      if (on) return listed({ ...p, email: address });
      return {
        address,
        name: p.name,
        title: p.title,
        kind: 'person',
        role: p.role,
        why: `Guessed from the firm’s pattern (${n} ${n === 1 ? 'address on its site is' : 'addresses on its site are'} ${pattern.pattern}@)`,
        guessed: true,
        page: p.page || '',
      };
    };
    const recruiters = peopleList.filter((p) => p.role === 'recruiting');
    for (const p of recruiters) if (p.email) add(listed(p));
    for (const p of recruiters) if (!p.email) add(guessed(p));
    const general = emailList
      .filter((e) => e.kind === 'general')
      .sort(
        (a, b) =>
          b.careersPage - a.careersPage ||
          /^(info|contact|hello|enquir|inquir)/.test(b.address) - /^(info|contact|hello|enquir|inquir)/.test(a.address),
      )[0];
    if (general)
      add({
        address: general.address,
        name: '',
        title: '',
        kind: 'general',
        why: 'General mailbox',
        guessed: false,
        page: general.page,
      });
    // At a small firm the partners read their own email, and often hire themselves.
    if (!firm || firm.employees == null || firm.employees <= 150) {
      const leaders = peopleList.filter((p) => p.role === 'leadership');
      for (const p of leaders) if (p.email) add(listed(p));
      for (const p of leaders) if (!p.email) add(guessed(p));
    }
    return { emails: emailList, people: peopleList, pattern, best };
  }

  /* ----------------------------------------------------------------- fetch */

  /** Each phrase of a list mapped to the kind of page it names. */
  const kindsOf = (groups) =>
    new Map(Object.entries(groups).flatMap(([kind, list]) => list.split(', ').map((w) => [w, kind])));
  // A home page's link is followed when all its words are one of these ("Contact us", not "Contact sales")…
  const LINK_TEXT = kindsOf({
    'contact page': 'contact, contact us, get in touch',
    'about page': 'about, about us, who we are, our story',
    'team page': 'team, our team, people, our people, leadership, meet the team, management team, partners, founders',
  });
  // … or its address ends in one of these ("/company/team", "/about/us").
  const LINK_PATH = kindsOf({
    'contact page': 'contact, contact-us',
    'about page': 'about, about-us, who-we-are',
    'team page': 'team, our-team, people, our-people, leadership, meet-the-team, management, partners, founders',
  });
  // Pages that only look like one, wherever a link or a guess lands: Speechmatics'
  // "/use-cases/contact-center-solutions", FreeAgent's "/blog/why-has-hmrc-written-to-me-about-mtd/",
  // "help.synthesia.io", Capula's "/login/?loginredirect=/about-us/team".
  const SIGN_IN_PATH = /\/(log-?in|sign-?in|sign[-_]?up|register)(?![a-z])/i;
  const OFF_HOST = /^(help|support|docs|community|shop|store|status|app)\./i;
  const POST_PATH = /\/(blogs?|posts?|news|articles?|hc|use-cases|products?|solutions)(\/|$)/i;

  /** Why a page can't be a team or contact page whatever it's called ('sign-in page', 'help site'…), or ''. */
  function offPage(url) {
    let u;
    try {
      u = new URL(url);
    } catch (err) {
      return 'not a page';
    }
    if (SIGN_IN_PATH.test(u.pathname)) return 'sign-in page';
    if (OFF_HOST.test(u.hostname)) return `${u.hostname.split('.')[0]} site`;
    if (POST_PATH.test(u.pathname)) return 'post or product page';
    return '';
  }

  /** What a home page's link is followed as ('contact page', 'about page', 'team page'), or '' when it isn't. */
  function linkKind(link, domain) {
    const url = (link && link.url) || '';
    const path = pathOf(url).toLowerCase();
    if (!path || D().domainOf(url) !== domain || /\.(pdf|jpe?g|png|zip)$/.test(path) || offPage(url)) return '';
    const said = LINK_TEXT.get(asciiName((link && link.text) || ''));
    if (said) return said;
    const parts = path.split('/').filter((x) => x && !/^index\.\w+$/.test(x));
    const last = (parts[parts.length - 1] || '').replace(/\.(html?|php|aspx?)$/, '');
    return LINK_PATH.get(last) || (parts.length > 1 && LINK_PATH.get(`${parts[parts.length - 2]}-${last}`)) || '';
  }

  /**
   * Read the firm's home page, the links on it to its team, about and contact pages, the usual paths for those
   * (guessed until two answer; 8 fetches in all) and the careers pages Discover found (`pages`: URLs, or
   * { url, html } already loaded), then rank contacts(). A page that doesn't name the firm gives no person's address.
   */
  async function findContacts(firm, { fetch: fetchFn, pages = [], now = Date.now() } = {}) {
    const d = D();
    const log = [];
    const got = [];
    const tried = new Set();
    const answered = new Set();
    const key = (u) =>
      String(u || '')
        .replace(/[?#].*$/, '')
        .replace(/\/+$/, '')
        .toLowerCase();
    let budget = MAX_FETCHES;
    const load = async (url, opts = {}) => {
      tried.add(url.toLowerCase());
      if (!opts.free) budget--;
      return d.get(fetchFn, url, { retries: 0, timeout: TIMEOUT });
    };
    // kind: what the page was read as, whatever its address says (PostHog's /contact lands on "/talk-to-a-human").
    const keep = (r, careers, kind) => {
      answered.add(key(r.url));
      const isFirm = d.pageIsFirm(r.text, firm);
      const named = careers ? 'careers page' : kind || pageName(r.url);
      log.push({ url: r.url, outcome: isFirm ? named : 'doesn’t name the firm' });
      got.push({ url: r.url, html: r.text, careers, isFirm, kind: named });
    };
    // A link or a guess that lands somewhere no one is named: Capula's /team asks for a sign-in.
    const landed = (r) => {
      const off = offPage(r.url);
      if (!off) return true;
      if (!answered.has(key(r.url))) log.push({ url: r.url, outcome: `${off}, skipped` });
      answered.add(key(r.url));
      return false;
    };
    const failed = (url, r) => log.push({ url, outcome: r.blocked ? 'blocked' : `failed: ${r.status || r.error}` });
    const site = firm.site || (firm.domain ? 'https://' + firm.domain : '');
    let home = null;
    if (site) {
      home = await load(site + '/');
      // Some firms only answer on www. (or only without it).
      if (!home.ok && !home.blocked) {
        const host = new URL(site).hostname;
        const again = await load(`https://${host.startsWith('www.') ? host.slice(4) : 'www.' + host}/`);
        if (again.ok) home = again;
      }
      if (home.ok && !home.blocked) keep(home, false);
      else failed(site + '/', home);
    }
    const homeOk = home && home.ok && !home.blocked;
    const own = homeOk ? d.domainOf(home.url) || firm.domain : firm.domain;
    const linked = homeOk
      ? d
          .links(home.text, home.url)
          .map((l) => ({ url: l.url, kind: linkKind(l, own) }))
          .filter((l) => l.kind)
          // Contact and team pages name people and addresses more often than about pages.
          .sort((a, b) => (a.kind === 'about page') - (b.kind === 'about page'))
          .slice(0, 5)
      : [];
    const given = (pages || []).map((p) => (typeof p === 'string' ? { url: p } : p)).filter((p) => p && p.url);
    for (const p of given) if (p.html) keep({ url: p.url, text: p.html }, true);
    const toFetch = [
      ...linked.map((l) => ({ ...l, careers: false })),
      ...given.filter((p) => !p.html).map((p) => ({ url: p.url, careers: true, free: true })),
    ].filter((t, i, all) => !answered.has(key(t.url)) && all.findIndex((x) => key(x.url) === key(t.url)) === i);
    const results = await d.pool(toFetch, 3, async (t) =>
      t.free || budget > 0 ? { t, r: await load(t.url, t) } : null,
    );
    for (const x of results) {
      if (!x) continue;
      if (!x.r.ok || x.r.blocked) failed(x.t.url, x.r);
      else if (x.t.careers || landed(x.r)) keep(x.r, x.t.careers, x.t.kind);
    }
    // The usual paths, until two of them answer: a menu built by script hides its links from a fetch. A kind of page
    // already read isn't guessed again (a linked /company/contact makes /contact a waste of a fetch).
    const origin = homeOk ? new URL(home.url).origin : site ? new URL(site).origin : '';
    const read = new Set(got.filter((g) => g.isFirm && !g.careers).map((g) => g.kind));
    let hits = 0;
    for (const p of origin ? CONTACT_PATHS : []) {
      if (hits >= 2 || budget <= 0) break;
      const url = origin + p;
      if (read.has(pageName(url)) || tried.has(url.toLowerCase()) || answered.has(key(url))) continue;
      const r = await load(url);
      // A path that lands back on the home page isn't the page it was guessed to be.
      if (!r.ok || r.blocked || !pathOf(r.url) || answered.has(key(r.url)) || !landed(r)) continue;
      hits++;
      keep(r, false, pageName(url));
      if (got[got.length - 1].isFirm) read.add(pageName(url));
    }
    const res = contacts(firm, got);
    // The pattern alone helps: at a big firm whose leaders aren't offered, for someone found on LinkedIn.
    const found = res.best.length || res.people.length || res.pattern.pattern;
    const status = !got.length ? 'unreachable' : found ? 'found' : 'none';
    return { ...res, log, status, checkedAt: now };
  }

  const discoverContacts = {
    CONTACT_PATHS,
    kindOf,
    emailsIn,
    peopleIn,
    patternOf,
    guess,
    linkKind,
    contacts,
    findContacts,
  };
  JTF.discoverContacts = discoverContacts;
  if (typeof module === 'object' && module.exports) module.exports = discoverContacts;
})(typeof globalThis !== 'undefined' ? globalThis : this);
