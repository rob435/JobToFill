/*
 * JobToFill — Discover's live sources beyond the registry, both public and key-free: Hacker News's monthly
 * "Ask HN: Who is hiring?" threads (small tech companies, and who to email there) through Algolia's HN API, and
 * SimplifyJobs' internship and new-grad listings on GitHub (more companies the big trackers already show, to leave
 * out alongside Trackr's). Requests carry nothing personal. Fetches go through an injected fetch and
 * JTF.discover.get, so nothing here throws and it all runs in Node tests. Uses JTF.util and JTF.discover.
 *
 *   hnThreads({ fetch, now })         → [{ id, title, month, createdAt }]  this month's and last month's threads
 *   hnPosts(thread, { fetch })        → [{ id, author, createdAt, html, url, thread, month }]  top-level comments
 *   parsePost(post)                   → { company, yc, header, segments, roles, locations, remote, onsite, kinds,
 *                                         student, emails, urls, site, domain, boards, text, hnUrl, postedAt, … }
 *   hnHiring({ fetch, now, cache })   → { posts, threads, at, answered, asked }  student posts, one per company
 *   hnFirm(post)                      → a Discover firm (source 'hn') for the search results
 *   simplifyUrls(now)                 → the listings.json addresses to try, newest season first, then new grad
 *   simplifyListings({ fetch, now })  → { names, domains, roles, at, answered, asked }  everyone Simplify lists
 *   listedSet(...lists)               → { names, domains, at }  Trackr's and Simplify's lists as one, for onList()
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});
  const U = JTF.util;
  const D = JTF.discover;

  const HN_API = 'https://hn.algolia.com/api/v1';
  const HN_ITEM = 'https://news.ycombinator.com/item?id=';
  const HOUR = 3600e3;
  const DAY = 24 * HOUR;
  // A thread's comments are read again after this; the current month's thread grows for weeks.
  const CACHE_FOR = 12 * HOUR;
  const REQUEST = { json: true, timeout: 15000, retries: 1 };
  // Simplify's listings.json files are about 13 MB each.
  const BIG_REQUEST = { json: true, timeout: 45000, retries: 1 };
  // Algolia's largest page, and also the most hits it returns for one query (later pages come back empty).
  const PAGE = 1000;

  /** One counted request: stats.asked always, stats.answered when JSON came back. */
  async function ask(fetchFn, url, stats, opts = REQUEST) {
    const r = await D.get(fetchFn, url, opts);
    if (stats) {
      stats.asked++;
      if (r.ok && r.json != null) stats.answered++;
    }
    return r;
  }

  /* ---------------------------------------------------------------- text */

  // prettier-ignore
  const ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
    lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', pound: '£', euro: '€',
  };

  /** HN's escaped text as typed: "doesn&#x27;t" → "doesn't", "https:&#x2F;&#x2F;" → "https://". */
  function unescape(s) {
    return String(s || '').replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] !== '#') return ENTITIES[e.toLowerCase()] || m;
      const code = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    });
  }

  /** Plain text of HN's HTML (only <p>, <a>, <i>, <pre> and <code>): a line per paragraph, entities decoded. */
  function plain(html) {
    return unescape(
      String(html || '')
        .replace(/<p>/gi, '\n')
        .replace(/<[^>]*>/g, ''),
    )
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .trim();
  }

  /** At most `max` characters, cut at a word with "…". */
  function clip(s, max) {
    const t = String(s || '').trim();
    if (t.length <= max) return t;
    const cut = t.slice(0, max - 1);
    return cut.slice(0, Math.max(cut.lastIndexOf(' '), max * 0.6)).replace(/[\s,;:.–—-]+$/, '') + '…';
  }

  /* -------------------------------------------------------------- places */

  // Places a header names often enough to recognise ("London, UK", "NYC", "SF Bay", "REMOTE (Europe)").
  // prettier-ignore
  const PLACE_NAMES = [
    'remote', 'global', 'worldwide', 'anywhere', 'europe', 'emea', 'eu', 'americas', 'north america', 'latam', 'apac',
    'asia', 'uk', 'united kingdom', 'england', 'scotland', 'wales', 'ireland', 'us', 'usa', 'united states', 'canada',
    'mexico', 'brazil', 'germany', 'france', 'netherlands', 'belgium', 'switzerland', 'austria', 'sweden', 'norway',
    'denmark', 'finland', 'spain', 'portugal', 'italy', 'poland', 'czechia', 'estonia', 'greece', 'israel', 'india',
    'singapore', 'japan', 'korea', 'australia', 'new zealand', 'uae', 'dubai', 'london', 'cambridge', 'oxford',
    'manchester', 'edinburgh', 'glasgow', 'bristol', 'leeds', 'birmingham', 'belfast', 'dublin', 'paris', 'berlin',
    'munich', 'hamburg', 'frankfurt', 'amsterdam', 'rotterdam', 'brussels', 'zurich', 'zürich', 'geneva', 'lausanne',
    'vienna', 'stockholm', 'copenhagen', 'oslo', 'helsinki', 'madrid', 'barcelona', 'lisbon', 'milan', 'rome',
    'prague', 'warsaw', 'krakow', 'tallinn', 'tel aviv', 'new york', 'nyc', 'ny', 'sf', 'san francisco', 'bay area',
    'silicon valley', 'palo alto', 'mountain view', 'menlo park', 'redwood city', 'san mateo', 'san jose', 'oakland',
    'berkeley', 'seattle', 'boston', 'chicago', 'austin', 'denver', 'boulder', 'los angeles', 'la', 'san diego',
    'miami', 'atlanta', 'washington', 'dc', 'philadelphia', 'pittsburgh', 'portland', 'salt lake city', 'toronto',
    'vancouver', 'montreal', 'waterloo', 'tokyo', 'sydney', 'melbourne', 'bangalore', 'bengaluru', 'hong kong',
  ];
  const PLACE = new RegExp(`(^|[^\\p{L}])(${PLACE_NAMES.join('|')})(?![\\p{L}])`, 'iu');
  // "Tempe, AZ", "Gainesville, FL": a town and a state or country code.
  const TOWN_CODE = /\p{Lu}[\p{L}.'’-]+,\s*[A-Z]{2}\b/u;
  // Words a place may have that aren't capitalised: "Norrköping or Stockholm", "near Brussels", "Frankfurt am Main".
  const FILLER =
    /^(or|and|near|only|area|metro|greater|based|in|the|of|de|del|della|di|da|du|la|le|am|an|upon|on|sur|und|et|y|e)$/i;
  // Header parts with capitalised words that aren't places ("Training & Consulting", "All Roles").
  const NOT_PLACE =
    /engineer|developer|scientist|analyst|designer|research|\bintern|graduate|manager|\blead\b|\bhead\b|director|founder|sales|product|marketing|operations|support|success|consult|training|equity|salary|visa|sponsor|stack|platform|backend|frontend|devops|security|software|hardware|\broles?\b|positions?|\bteam\b|hiring|series|\bseed\b|startup|company/i;
  // How a header says where the work happens.
  const MODE =
    /\b(?:fully |100% |partially |mostly )?(?:remote|on[- ]?site|hybrid|in[- ]person|in[- ]office|office)\b(?:[- ](?:first|friendly|ok|possible|only|available))?/gi;
  const REMOTE = /remote/i;
  const NOT_REMOTE = /\b(?:no|not|non)[- ](?:fully )?remote\b/gi;
  const ONSITE = /on[- ]?site|hybrid|in[- ]person|in[- ]office/i;
  // Header parts about the terms, not the role or the place.
  const TERMS =
    /full[- ]?time|part[- ]?time|\bcontract|freelance|permanent|\bvisa\b|sponsor|equity|salary|[$£€]\s?\d|\d+\s?k\b|\bseed\b|series [a-f]\b|\bw-?2\b|no agencies|relocation/i;

  /** Is this short text a place ("London, UK", "Berlin, Freiburg, NYC", "Europe, Norrköping or Stockholm")? */
  function isPlace(text) {
    const t = placeText(text);
    if (!t || t.length > 80 || /\d|[$£€@]|:\/\//.test(t) || NOT_PLACE.test(t)) return false;
    const words = t.split(/[\s,/&;+·]+/).filter(Boolean);
    if (!words.length || !words.every((w) => /^\p{Lu}/u.test(w) || FILLER.test(w))) return false;
    return PLACE.test(t) || TOWN_CODE.test(t);
  }

  /** A place as written, tidied: "London (UK)" → "London, UK", "US only" → "US", "(In-Person)" dropped. */
  function placeText(text, depth = 0) {
    return String(text || '')
      .replace(/\(([^()]*)\)/g, (m, inner) => (depth < 1 && isPlaceAt(inner, depth + 1) ? ', ' + inner : ' '))
      .replace(/\bonly\b|-based\b|\b(based|located) in\b|^\s*(in|at)\s/gi, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\s*,(\s*,)+/g, ',')
      .replace(/\s+,/g, ',')
      .replace(/^[\s,;/&·.:–—-]+|[\s,;/&·.:–—-]+$/g, '');
  }

  /** isPlace for a parenthetical (one level deep). */
  function isPlaceAt(text, depth) {
    const t = placeText(text, depth);
    return !!t && t.length <= 80 && !/\d/.test(t) && !NOT_PLACE.test(t) && (PLACE.test(t) || TOWN_CODE.test(t));
  }

  // prettier-ignore
  const CITY_ALIAS = {
    nyc: 'New York', ny: 'New York', 'new york city': 'New York', manhattan: 'New York', sf: 'San Francisco',
    'sf bay': 'San Francisco', 'sf bay area': 'San Francisco', 'bay area': 'San Francisco',
    'san francisco bay area': 'San Francisco', la: 'Los Angeles', dc: 'Washington', 'washington dc': 'Washington',
    zürich: 'Zurich',
  };
  // Regions and countries, which aren't cities.
  const NOT_CITY =
    /^(remote|global|worldwide|anywhere|europe|emea|eu|americas|north america|latam|apac|asia|uk|united kingdom|england|scotland|wales|ireland|northern ireland|us|usa|united states|canada|mexico|brazil|germany|france|netherlands|belgium|switzerland|austria|sweden|norway|denmark|finland|spain|portugal|italy|poland|czechia|estonia|greece|israel|india|singapore|japan|korea|australia|new zealand|uae|[a-z]{2})$/i;
  const REGION = /\b(remote|global|worldwide|anywhere|timezones?|time zones?)\b/i;
  // Countries by their names and best-known cities, in any case ("BERLIN, GERMANY"). Cambridge is in both England
  // and Massachusetts, so it names neither; "New England", "New South Wales" and "New Mexico" aren't the countries.
  // prettier-ignore
  const COUNTRIES = {
    GB: [
      'United Kingdom|Great Britain|Britain|(?<!New )England|Scotland|(?<!South )Wales|Northern Ireland',
      'London|Manchester|Edinburgh|Glasgow|Bristol|Leeds|Birmingham|Oxford|Belfast|Cardiff|Liverpool|Sheffield|' +
        'Nottingham|Brighton',
    ],
    US: [
      'United States',
      'New York|San Francisco|Bay Area|Silicon Valley|Palo Alto|Mountain View|Menlo Park|Redwood City|San Jose|' +
        'Oakland|Berkeley|Seattle|Boston|Chicago|Austin|Denver|Los Angeles|San Diego|Miami|Atlanta|Washington DC|' +
        'Philadelphia|Pittsburgh',
    ],
    IE: ['Ireland', 'Dublin|Cork|Galway|Limerick'],
    CA: ['Canada', 'Toronto|Vancouver|Montreal|Montréal|Waterloo|Ottawa|Calgary|Kitchener|Edmonton'],
    FR: ['France', 'Paris|Lyon|Marseille|Toulouse|Grenoble|Bordeaux|Lille'],
    DE: [
      'Germany|Deutschland',
      'Berlin|Munich|München|Hamburg|Frankfurt|Cologne|Köln|Stuttgart|Düsseldorf|Dusseldorf|Leipzig|Dresden|Heidelberg',
    ],
    NL: ['Netherlands', 'Amsterdam|Rotterdam|Utrecht|Eindhoven|The Hague|Delft'],
    IL: ['Israel', 'Tel Aviv|Tel-Aviv|Jerusalem|Haifa|Herzliya'],
    CH: ['Switzerland', 'Zurich|Zürich|Geneva|Genève|Lausanne|Basel|Bern|Zug'],
    SG: ['Singapore', ''],
    HK: ['Hong Kong', ''],
    AU: ['Australia', 'Sydney|Melbourne|Brisbane|Canberra|Adelaide'],
    ES: ['Spain|España', 'Madrid|Barcelona|Valencia|Seville|Sevilla|Málaga|Malaga|Bilbao'],
    IT: ['Italy|Italia', 'Milan|Milano|Rome|Roma|Turin|Torino|Bologna'],
    SE: ['Sweden', 'Stockholm|Gothenburg|Göteborg|Malmö|Malmo|Uppsala'],
    DK: ['Denmark', 'Copenhagen|København|Aarhus'],
    NO: ['Norway', 'Oslo|Bergen|Trondheim'],
    FI: ['Finland', 'Helsinki|Espoo|Tampere'],
    BE: ['Belgium', 'Brussels|Bruxelles|Antwerp|Ghent|Leuven'],
    AT: ['Austria', 'Vienna|Wien|Graz|Linz|Salzburg'],
    PT: ['Portugal', 'Lisbon|Lisboa|Porto'],
    PL: ['Poland', 'Warsaw|Warszawa|Krakow|Kraków|Wroclaw|Wrocław|Gdansk|Gdańsk'],
    CZ: ['Czechia|Czech Republic', 'Prague|Praha|Brno'],
    IN: ['India', 'Bangalore|Bengaluru|Mumbai|New Delhi|Delhi|Hyderabad|Pune|Chennai|Gurgaon|Gurugram|Noida'],
    JP: ['Japan', 'Tokyo|Osaka|Kyoto'],
    BR: ['Brazil|Brasil', 'São Paulo|Sao Paulo|Rio de Janeiro'],
    MX: ['(?<!New )Mexico|México', 'Mexico City|Ciudad de México|Guadalajara|Monterrey'],
  };
  const placeRe = (alts) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts})(?![\\p{L}\\p{N}])`, 'giu');
  const COUNTRY_RES = Object.entries(COUNTRIES).flatMap(([code, [names, cities]]) =>
    [names && { re: placeRe(names), code, city: false }, cities && { re: placeRe(cities), code, city: true }].filter(
      Boolean,
    ),
  );
  // Codes, in capitals only ("US", not "us"); after a comma also a US state's, a Canadian province's or a
  // country's ("Tempe, AZ", "London, ON", "Berlin, DE").
  const CODE = /(?<![\p{L}\p{N}.])(U\.K\.|U\.S\.A\.?|U\.S\.|USA|UK|US|NYC|NY|SF|HK)(?![\p{L}\p{N}])/gu;
  const CODE_COUNTRY = { 'U.K.': 'GB', UK: 'GB', HK: 'HK' };
  const AFTER_COMMA = /(?<=,\s*)([A-Z]{2})(?![\p{L}\p{N}])/gu;
  const US_STATES =
    /^(A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])$/;
  const PROVINCES = /^(AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT)$/;

  /** What a two-letter code after a comma may mean, likeliest first: "CA" is California, else Canada. */
  function codeCountries(code) {
    const iso = code === 'UK' ? 'GB' : COUNTRIES[code] ? code : '';
    if (US_STATES.test(code)) return iso ? ['US', iso] : ['US'];
    return [iso, PROVINCES.test(code) && 'CA'].filter(Boolean);
  }

  /** Every country a place names, as [{ at, end, codes, city }] in the order written. */
  function countryHits(s) {
    const hits = [];
    const add = (m, codes, city) => codes.length && hits.push({ at: m.index, end: m.index + m[0].length, codes, city });
    for (const { re, code, city } of COUNTRY_RES) for (const m of s.matchAll(re)) add(m, [code], city);
    for (const m of s.matchAll(CODE)) add(m, [CODE_COUNTRY[m[1]] || 'US'], false);
    for (const m of s.matchAll(AFTER_COMMA)) add(m, codeCountries(m[1]), false);
    return hits.sort((a, b) => a.at - b.at || b.end - a.end);
  }

  /** The cities a post's places name: "London, UK" → London, "Berlin, Freiburg, NYC" → Berlin, Freiburg, New York. */
  function citiesOf(locations) {
    const out = [];
    for (const loc of locations || [])
      for (const raw of String(loc).split(/\s*(?:,|\/|&|\bor\b|\band\b)\s*/)) {
        const part = raw
          .replace(/^(greater|near|central)\s+|\s+(metro(politan)?\s+)?area$/i, '')
          .replace(/\s+/g, ' ')
          .trim();
        // "ALMOST ANYWHERE", "Remote within Europe" aren't cities.
        if (REGION.test(part)) continue;
        const alias = CITY_ALIAS[part.toLowerCase()] || CITY_ALIAS[raw.trim().toLowerCase()];
        const city = alias || (part.length > 1 && !NOT_CITY.test(part) ? part : '');
        if (city && !out.includes(city)) out.push(city);
      }
    return out;
  }

  /**
   * The country the places name first, as a code ('GB', 'US', 'DE'…): "London, UK", "NY, SF, London…" (US),
   * "Tempe, AZ", "Munich" (DE); a city takes what follows it, so "Dublin, CA" is California's and "London, ON"
   * Ontario's. '' when none is named.
   */
  function countryOf(locations) {
    for (const loc of locations || []) {
      const s = String(loc);
      const hits = countryHits(s);
      if (!hits.length) continue;
      const first = hits[0];
      if (first.city) {
        const next = first.end + /^\s*,?\s*/.exec(s.slice(first.end))[0].length;
        const then = hits.find((h) => !h.city && h.at === next);
        // "Toronto, CA" is Canada's, "Berlin, DE" Germany's: the city's own country when the code can mean it.
        if (then) return then.codes.includes(first.codes[0]) ? first.codes[0] : then.codes[0];
      }
      return first.codes[0];
    }
    return '';
  }

  /* --------------------------------------------------------------- roles */

  // Header parts that name a role (roleKind() covers the student ones).
  const ROLE =
    /engineer|developer|scientist|analyst|designer|researcher|\bintern(ship)?s?\b|graduate|\bswe\b|\bsde\b|programmer|architect|new grads?\b|apprentice/i;
  // Anything for students, in the header: "INTERNS", "New grads who’ve shipped…", "Gainesville, FL (UF students)".
  const STUDENT_HEAD =
    /\bintern(ship)?s?\b|new[- ]grads?\b|\bgraduates?\b|entry[- ]level|\bjuniors?\b|\bco-?op\b|\bstudents?\b|working student|placement/i;
  // In the body only the phrases that are about hiring them ("graduate degree", "our students" aren't).
  const STUDENT_BODY =
    /\bintern(ship)?s?\b|\bnew[- ]grads?\b|\b(recent|new|fresh) graduates?\b|\bgraduate (roles?|positions?|programmes?|programs?|schemes?|engineers?|developers?|hires?|opportunit)|\bgraduates? (are )?(welcome|encouraged)|\bentry[- ]level\b|\bjuniors?\b|\bco-?op\b|\b(current|university|college|phd|undergrad(uate)?|masters?|master’s|master's|grad) students?\b|\bstudents? (are )?(welcome|encouraged|may apply|can apply)|\bworking students?\b|\b(industrial|year[- ]long|summer) placements?\b|\bplacement (year|students?)\b/i;
  // "No interns or new grads this cycle, sorry", "not hiring juniors" (but "no internship experience needed" is fine).
  const NO_STUDENT =
    /\bno (interns?|internships?|juniors?|junior (roles?|positions?|engineers?|developers?)|new grads?|entry[- ]level( roles?)?|students|graduates)\b(?! (experience|required|needed|necessary|background))|\bnot (hiring|accepting|looking for|considering|taking|offering|able to (hire|take|consider)) (any )?(interns?|internships?|juniors?|junior \w+|new grads?|entry[- ]level|students|graduates)\b|\b(interns?|internships?|juniors?|new grads?) (are|is) not\b|\bsenior[- ]only\b/i;
  const INTERN_WORDS = /\bintern(ship)?s?\b|\bco-?op\b|\bstudents?\b|working student|placement|apprentice/i;
  const GRAD_WORDS = /new[- ]grads?\b|\bgraduates?\b|\bjuniors?\b|entry[- ]level|early[- ]career/i;

  /** Is this header part a role title? */
  function isRole(text) {
    return text.length <= 120 && (ROLE.test(text) || !!D.roleKind(text));
  }

  /** A role title without the terms around it: "Full-time + INTERNS" → "INTERNS". */
  function roleTitle(text) {
    return text
      .replace(/\b(full|part)[- ]?time\b\s*[+&,/]?\s*/gi, '')
      .replace(/\s+/g, ' ')
      .replace(/^[\s+&,/·–—-]+|[\s+&,/·–—-]+$/g, '')
      .slice(0, 120);
  }

  /** Split at commas outside brackets: "Junior SWE ($300k + equity), Research Engineer" → two parts. */
  function commaParts(text) {
    const out = [];
    let depth = 0;
    let cur = '';
    for (const c of String(text)) {
      if (c === '(' || c === '[') depth++;
      else if ((c === ')' || c === ']') && depth) depth--;
      if ((c === ',' || c === ';') && !depth) {
        out.push(cur.trim());
        cur = '';
      } else cur += c;
    }
    out.push(cur.trim());
    return out.filter(Boolean);
  }

  const YC = /[([]\s*YC[\s-]*([WSFX])\s*'?(\d{2}|\d{4})\s*[)\]]/i;
  const LINKY = /:\/\/|^(www\.)?[a-z\d-]+(\.[a-z\d-]+)*\.[a-z]{2,}(\/\S*)?$/i;

  /** What a header part says: 'role', 'place', 'mode' (remote / onsite), 'terms', 'link' or '' (something else). */
  function partKind(text) {
    const t = text.trim();
    if (LINKY.test(t)) return 'link';
    if (YC.test(t) && !t.replace(YC, '').trim()) return 'terms';
    const rest = placeText(t.replace(MODE, ' '));
    if (!rest) return 'mode';
    if (isRole(rest)) return 'role';
    if (TERMS.test(rest)) return 'terms';
    if (isPlace(rest)) return 'place';
    return '';
  }

  /* --------------------------------------------------------------- posts */

  /** The post's first line (its "Company | Place | Role | ONSITE | Full-time" header) and the rest, as HTML. */
  function splitHeader(html) {
    const s = String(html || '');
    const p = s.search(/<p>/i);
    let head = p < 0 ? s : s.slice(0, p);
    let body = p < 0 ? '' : s.slice(p);
    const nl = head.indexOf('\n');
    if (nl > 0 && /[|｜]/.test(head.slice(0, nl))) {
      body = head.slice(nl) + body;
      head = head.slice(0, nl);
    }
    return { head, body };
  }

  /** The header's parts, as { html, text }: split at "|", or at " - " / " – " when it has no pipe. */
  function segmentsOf(head) {
    let parts = head.split(/\s*[|｜]\s*/);
    if (parts.length < 2) parts = head.split(/\s+[-–—·]\s+/);
    return parts.map((h) => ({ html: h, text: plain(h).replace(/\s+/g, ' ') })).filter((s) => s.text);
  }

  /** The company from the header's first part: "MixRank (YC S11)" → MixRank, yc 'S11'; links and colons dropped. */
  function companyOf(seg, alone) {
    let s = plain(String(seg.html || '').replace(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi, ' ')).replace(/\s+/g, ' ');
    // "<a>acme.ai</a> | London | …": the link is the name.
    if (!s.trim())
      s = seg.text
        .replace(/^https?:\/\/(www\.)?/i, '')
        .replace(/\/.*$/, '')
        .trim();
    let yc = null;
    const m = s.match(YC);
    if (m) {
      yc = (m[1] + m[2].slice(-2)).toUpperCase();
      s = s.replace(YC, ' ');
    }
    // "Column (<link>)": the link's brackets stay behind.
    s = s.replace(/\(\s*\)|\[\s*\]/g, ' ');
    s = s.replace(/\s+/g, ' ').replace(/^[\s:;,–—-]+|[\s:;,(–—-]+$/g, '');
    // A header with no separators is either just the name or a sentence: "Duranta (<link>) is hiring a computer
    // vision engineer…" names it, "Hi HN, I'm Nathan, CTO at …" doesn't.
    if (alone && s.length > 60) s = (s.match(/^(.{2,60}?)\s*(?:\(|\b(?:is|are) (?:hiring|looking)\b)/) || ['', ''])[1];
    else if (s.length > 60) s = s.split(/[,.;:]|\s(?:is|are|-|–)\s/)[0].trim();
    // "Location: Dorset, UK" and "Remote: Yes" are someone looking for work, posted in the wrong thread.
    if (s.length > 60 || !/[\p{L}\p{N}]/u.test(s) || /^(location|remote|willing to relocate|technologies)\s*:/i.test(s))
      s = '';
    return { name: s.trim(), yc };
  }

  // Hosts that aren't a company's own site: social networks, job boards, ATSs, HN itself, forms, video, blogs.
  // prettier-ignore
  const NOT_SITE_HOSTS = [
    'linkedin.com', 'lnkd.in', 'twitter.com', 'x.com', 't.co', 'facebook.com', 'instagram.com', 'github.com',
    'github.io', 'gitlab.com', 'ycombinator.com', 'workatastartup.com', 'hn.algolia.com', 'angel.co', 'wellfound.com',
    'glassdoor.com', 'glassdoor.co.uk', 'indeed.com', 'crunchbase.com', 'notion.site', 'notion.so', 'docs.google.com',
    'forms.google.com', 'drive.google.com', 'sites.google.com', 'forms.gle', 'goo.gl', 'bit.ly', 'calendly.com',
    'cal.com', 'youtube.com', 'youtu.be', 'vimeo.com', 'medium.com', 'substack.com', 'loom.com', 'typeform.com',
    'tally.so', 'airtable.com', 'discord.gg', 'discord.com', 'reddit.com', 'wikipedia.org', 'arxiv.org',
    'techcrunch.com', 'bloomberg.com', 'greenhouse.io', 'lever.co', 'ashbyhq.com', 'workable.com', 'myworkdayjobs.com',
    'myworkdaysite.com', 'smartrecruiters.com', 'recruitee.com', 'teamtailor.com', 'personio.de', 'personio.com',
    'bamboohr.com', 'icims.com', 'taleo.net', 'successfactors.com', 'successfactors.eu', 'oraclecloud.com',
    'hibob.com', 'pinpointhq.com', 'jobvite.com', 'rippling.com', 'breezy.hr', 'applytojob.com', 'eightfold.ai',
    'avature.net', 'jibeapply.com', 'paylocity.com', 'ultipro.com', 'dayforcehcm.com', 'careerpuck.com', 'yello.co',
    'jobs.deel.com', 'app.deel.com', 'simplify.jobs', 'otta.com', 'welcometothejungle.com', 'builtin.com', 'dice.com',
    'levels.fyi', 'remoteok.com', 'weworkremotely.com', 'gethnjobs.com', 'hnhiring.com', 'join.com', 'beapplied.com',
    'grnh.se', 'jobs.gem.com', 'app.dover.com', 'hire.withgoogle.com', 'polymer.co', 'forms.office.com',
    'tinyurl.com', 'brassring.com', 'tal.net', 'csod.com', 'paycomonline.net', 'phenompeople.com', 'jazzhr.com', 'applicantpro.com',
  ];
  const WEBMAIL =
    /(^|\.)(gmail|googlemail|yahoo|ymail|outlook|hotmail|live|msn|aol|protonmail|proton|pm|icloud|me|mac|hey|gmx|fastmail|tutanota|yandex|mail|qq|163)\.[a-z.]+$/i;
  // An own-domain page about jobs ("/careers/internships", "/join-us").
  const CAREERS =
    /career|\bjobs?\b|join|hiring|open-?(roles|positions)|positions|vacanc|work-with-us|intern|students?|graduates?|apply/i;

  /** The host of an address, lowercase without "www.", or ''. */
  function hostOf(url) {
    try {
      return new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(url) ? url : 'https://' + url).hostname
        .toLowerCase()
        .replace(/^www\d?\./, '');
    } catch (err) {
      return '';
    }
  }

  /** Is this address on a job board, a social network or another host that isn't the company's own? */
  function notOwn(url) {
    const h = hostOf(url);
    return !h || NOT_SITE_HOSTS.some((s) => h === s || h.endsWith('.' + s));
  }

  // "careers@acme.com", "[careers@markerlearning.com]", "brent+hn@silkline.ai"
  const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,24}\b/gi;
  // "marius[at]goareo.com", "jobs [at] studyturtle.com", "jobs @ acme.io", "julian.berman at quantumrise.com",
  // "careers at x dot com"; a full stop or comma may end the sentence ("Write to sam at foolabs.com.").
  const AT_EMAIL =
    /([\w.+-]+)(\s*(?:\[at\]|\(at\)|\{at\}|<at>)\s*|\s+@\s+|\s+at\s+)([\w-]+(?:(?:\.|\s*\[dot\]\s*|\s*\(dot\)\s*|\s+dot\s+)[\w-]+)+)(?![\w/@-]|\.[\w-])/gi;
  // Words before " at " in a sentence, not mailboxes ("reach me at acme.com", "engineers at stripe.com").
  const NOT_LOCAL =
    /^(me|us|we|you|him|her|them|it|is|are|was|be|work|works|working|worked|engineers?|developers?|team|teams|people|someone|anyone|everyone|out|here|there|look|looking|apply|available|based|built|live|found|located|roles?|positions?|openings|more|info|details|this|that|our|now|today|home|launched|scale|offices?|interns?|students?|us\.)$/i;
  // Jobs and the words around them: "previously CTO at stripe.com", "our founder at acme.io", "the team lead at
  // quux.de" say where someone works, even on the company's own domain.
  const ROLE_WORD =
    /^(cto|ceo|cfo|coo|cpo|vp|svp|evp|founders?|co-?founders?|leads?|heads?|engineers?|developers?|scientists?|designers?|researchers?|analysts?|managers?|directors?|interns?|partners?|staff|employees?|members?|work|works|worked|working|previously|formerly|now|currently|am|was|were|is|are|be|been|team|teams|job|jobs|role|roles|position|positions|hiring)$/i;

  /**
   * Every address in a post, HN's escaping and "name [at] domain dot com" spellings undone. A bare "name at
   * domain.com" counts only on a domain owns() accepts (the company's own), after a word that isn't a job.
   */
  function emailsIn(html, owns = () => false) {
    const text = plain(html);
    const found = [...text.matchAll(EMAIL)].map((m) => [m.index, m[0]]);
    for (const m of text.matchAll(AT_EMAIL)) {
      const bracketed = /[[({<]/.test(m[2]);
      const domain = m[3].replace(/\s*\[dot\]\s*|\s*\(dot\)\s*|\s+dot\s+/gi, '.');
      if (!bracketed && (NOT_LOCAL.test(m[1]) || !/\.[a-z]{2,24}$/i.test(domain))) continue;
      // " at " with the domain written out ("careers at lumengrid dot com") is an address; with a plain domain it
      // is as often a sentence ("previously CTO at stripe.com").
      const bare = /^\s+at\s+$/i.test(m[2]) && !/\s+dot\s+/i.test(m[3]);
      if (bare && (!owns(domain) || ROLE_WORD.test(m[1]))) continue;
      found.push([m.index, `${m[1]}@${domain}`]);
    }
    // In the order the post gives them, then any only in a mailto: link.
    const all = found.sort((a, b) => a[0] - b[0]).map((f) => f[1]);
    for (const m of unescape(html).matchAll(/mailto:([^"'?\s>]+)/gi)) all.push(m[1]);
    const out = [];
    for (const e of all) {
      const v = e.toLowerCase().replace(/\.+$/, '');
      if (!/^[\w.+-]+@[\w-]+(\.[\w-]+)*\.[a-z]{2,24}$/.test(v) || /\.(png|jpe?g|gif|svg|webp)$/.test(v)) continue;
      if (!out.includes(v)) out.push(v);
    }
    return out;
  }

  // Words too common in names to tie a domain to one company (Zephyr Labs isn't labs.google).
  const COMMON_WORD =
    /^(the|and|labs?|tech|technologies|technology|systems|software|data|health|bio|robotics|studios?|games|cloud|apps?|hq|solutions|digital|media|analytics|research|energy|networks?|ventures|capital|group|company|inc)$/;

  /**
   * Does a domain (or address) spell the company's name? Its first label is some of the name's words run together
   * ("kestrel.dev" for Kestrel Robotics, "lumengrid.com" for Lumen Grid), or the whole name with a little more
   * ("tidewellhq.com"); not just part of a word ("gate.io" for Northgate Labs).
   */
  function spellsName(domain, company) {
    const words = U.normalize(company).split(' ').filter(Boolean);
    const key = words.join('');
    const label = (D.domainOf(domain).split('.')[0] || '').replace(/-/g, '');
    if (key.length < 3 || label.length < 3) return false;
    if (key.length >= 4 && (label.startsWith(key) || label.endsWith(key))) return true;
    for (let i = 0; i < words.length; i++)
      for (let j = i + 1; j <= words.length; j++)
        if (words.slice(i, j).join('') === label && (j - i > 1 || !COMMON_WORD.test(label))) return true;
    return false;
  }

  /**
   * The company's own site (https origin): a link, else an address, whose domain spells its name; else the header's
   * first own link (Qualcomm's post links the LLVM Foundation further down) or its email's domain. Never just any
   * link in the text: Zephyr Labs "featured in the NYT" isn't nytimes.com. '' when there is none.
   */
  function siteFrom(headUrls, bodyUrls, emails, company) {
    const own = (urls) =>
      urls
        .filter((u) => !notOwn(u))
        .map((u) => D.siteOf(u))
        .filter(Boolean);
    const mail = emails
      .map((e) => e.split('@')[1])
      .filter((d) => d && !WEBMAIL.test(d) && !notOwn(d))
      .map((d) => D.siteOf(D.domainOf(d)))
      .filter(Boolean);
    const head = own(headUrls);
    return [...head, ...own(bodyUrls), ...mail].find((s) => spellsName(s, company)) || [...head, ...mail][0] || '';
  }

  // Sentences that mention interns without being a role ("We hire interns every summer").
  const NOT_ROLE_LINE =
    /\b(we|our|you|your|i|they|is|are|was|were|will|can|have|has|hire|hiring|looking|welcome|encouraged)\b/i;

  /** A post's own lines that name a student role: "- Machine Learning Intern: <link>", "Working Student (Backend)". */
  function bodyRoles(bodyHtml) {
    const out = [];
    for (const line of plain(bodyHtml).split('\n')) {
      const t = line
        .replace(/^\s*[-*•·]\s*/, '')
        .split(/:\s|\s[-–—]\s|https?:\/\//)[0]
        .replace(/\s*\($/, '')
        .trim();
      if (t.length < 4 || t.length > 70 || !/^\p{Lu}/u.test(t)) continue;
      const kind = D.roleKind(t);
      if (kind && !NOT_ROLE_LINE.test(t)) out.push({ title: t, kind });
    }
    return out;
  }

  /**
   * One "Who is hiring?" comment, read: company (and YC batch), roles, places, remote / onsite, whether it is for
   * students and which kinds, emails, links, the company's own site and the job boards it links to.
   */
  function parsePost(post) {
    const p = post || {};
    const html = String(p.html || '');
    const { head, body } = splitHeader(html);
    const segs = segmentsOf(head);
    const { name: company, yc } = segs.length ? companyOf(segs[0], segs.length < 2) : { name: '', yc: null };
    const roles = [];
    const locations = [];
    const prose = [];
    let remote = false;
    let onsite = false;
    let student = false;
    for (const seg of segs.slice(1)) {
      const t = seg.text;
      // MixRank's header runs into its description: "… | Full-Time MixRank processes petabytes…".
      if (t.length > 120) {
        prose.push(t);
        continue;
      }
      if (REMOTE.test(t.replace(NOT_REMOTE, ' '))) remote = true;
      if (ONSITE.test(t)) onsite = true;
      if (STUDENT_HEAD.test(t)) student = true;
      if (LINKY.test(t)) continue;
      const parts = commaParts(t);
      const what = parts.map(partKind);
      if (parts.length > 1 && what.every(Boolean)) {
        // "INTERNS , HYBRID/REMOTE, Zurich, Switzerland": each part on its own; neighbouring places make one.
        let run = [];
        for (let i = 0; i <= parts.length; i++) {
          if (what[i] === 'place') {
            run.push(placeText(parts[i].replace(MODE, ' ')));
            continue;
          }
          if (run.length) locations.push(run.join(', '));
          run = [];
          if (what[i] === 'role') roles.push({ title: roleTitle(parts[i]), kind: D.roleKind(parts[i]) });
        }
        continue;
      }
      const rest = placeText(t.replace(MODE, ' '));
      if (isRole(rest)) roles.push({ title: roleTitle(t), kind: D.roleKind(t) });
      else if (isPlace(rest)) locations.push(placeText(rest));
      else
        for (const part of rest.split(/\s*[,;]\s*|\s+[-–—]\s+|\.\s+/))
          if (isPlace(part)) locations.push(placeText(part));
    }
    const bodyText = [...prose, plain(body)].join('\n');
    for (const r of bodyRoles(body))
      if (!roles.some((x) => U.normalize(x.title) === U.normalize(r.title))) roles.push(r);
    if (STUDENT_BODY.test(bodyText)) student = true;
    if (NO_STUDENT.test(plain(html))) student = false;
    let kinds = [...new Set(roles.map((r) => r.kind).filter(Boolean))];
    if (!kinds.length) {
      const all = segs
        .slice(1)
        .map((s) => s.text)
        .concat(bodyText)
        .join('\n');
      if (INTERN_WORDS.test(all)) kinds.push('internship');
      if (GRAD_WORDS.test(all)) kinds.push('graduate');
    }
    if (!student) kinds = [];
    const bare = segs
      .slice(1)
      .map((s) => s.text)
      .filter((t) => LINKY.test(t) && !/\s/.test(t))
      .map((t) => (/^https?:\/\//i.test(t) ? t : 'https://' + t));
    const headUrls = [...D.links(head, HN_ITEM).map((l) => l.url), ...bare];
    const bodyUrls = D.links(body, HN_ITEM).map((l) => l.url);
    const urls = [...new Set([...headUrls, ...bodyUrls])];
    // The site from the links and the addresses written as such, then "sam at foolabs.com" on that domain or its name's.
    const own = D.domainOf(siteFrom(headUrls, bodyUrls, emailsIn(html), company));
    const emails = emailsIn(html, (d) => spellsName(d, company) || (!!own && D.domainOf(d) === own));
    const site = siteFrom(headUrls, bodyUrls, emails, company);
    const text = clip((plain(body) || plain(head)).replace(/\s+/g, ' '), 600);
    return {
      id: p.id ? String(p.id) : '',
      author: p.author || '',
      thread: p.thread ? String(p.thread) : '',
      month: p.month || '',
      company,
      yc,
      header: segs.map((s) => s.text).join(' | '),
      segments: segs.map((s) => s.text),
      roles,
      locations: [...new Set(locations.filter(Boolean))],
      remote,
      onsite,
      kinds,
      student,
      emails,
      urls,
      site,
      domain: D.domainOf(site),
      boards: D.detectBoards(unescape(html), p.url || null),
      text,
      hnUrl: p.url || (p.id ? HN_ITEM + p.id : ''),
      postedAt: p.createdAt || '',
    };
  }

  /* -------------------------------------------------------------- threads */

  /** "November 2026" from the title "Ask HN: Who is hiring? (November 2026)", else from when it was posted. */
  function monthOf(hit) {
    const m = String(hit.title || '').match(/\(([A-Z][a-z]+ \d{4})\)/);
    if (m) return m[1];
    const d = new Date(hit.created_at || 0);
    if (isNaN(d)) return '';
    const name = U.monthName(d.getUTCMonth() + 1);
    return name[0].toUpperCase() + name.slice(1) + ' ' + d.getUTCFullYear();
  }

  /**
   * The latest "Ask HN: Who is hiring?" threads, this month's and last month's (not "Who wants to be hired?" nor
   * "Freelancer? Seeking freelancer?", which the same account posts), newest first.
   */
  async function hnThreads({ fetch: fetchFn, now = Date.now(), base = HN_API, stats } = {}) {
    const url = `${base}/search_by_date?tags=story,author_whoishiring&query=%22who%20is%20hiring%22&hitsPerPage=6`;
    const r = await ask(fetchFn, url, stats);
    const hits = r.ok && r.json && Array.isArray(r.json.hits) ? r.json.hits : [];
    return (
      hits
        .filter((h) => h && h.objectID && /^Ask HN: Who is hiring\?/i.test(h.title || ''))
        // A thread from over two months ago is stale, whatever the index says.
        .filter((h) => !(now - Date.parse(h.created_at) > 70 * DAY))
        .sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0))
        .slice(0, 2)
        .map((h) => ({ id: String(h.objectID), title: h.title, month: monthOf(h), createdAt: h.created_at || '' }))
    );
  }

  /** Every top-level comment of a thread (replies dropped): one post per company, as HN asks. */
  async function hnPosts(thread, { fetch: fetchFn, base = HN_API, stats } = {}) {
    const id = String((thread && thread.id) || '');
    if (!/^\d+$/.test(id)) return [];
    const out = [];
    const seen = new Set();
    let page = 0;
    let before = null;
    for (let n = 0; n < 4; n++) {
      const filter = before == null ? '' : `&numericFilters=${encodeURIComponent('created_at_i<=' + before)}`;
      const url = `${base}/search_by_date?tags=comment,story_${id}&hitsPerPage=${PAGE}&page=${page}${filter}`;
      const r = await ask(fetchFn, url, stats);
      const json = r.ok && r.json;
      if (!json || !Array.isArray(json.hits)) break;
      for (const h of json.hits) {
        if (!h || seen.has(String(h.objectID))) continue;
        seen.add(String(h.objectID));
        if (String(h.parent_id) !== id || !h.comment_text) continue;
        out.push({
          id: String(h.objectID),
          author: h.author || '',
          createdAt: h.created_at || '',
          html: h.comment_text,
          url: HN_ITEM + h.objectID,
          thread: id,
          month: (thread && thread.month) || '',
        });
      }
      if (page + 1 < (json.nbPages || 0)) page++;
      else if (json.hits.length >= PAGE) {
        // Algolia stops at 1,000 hits a query: the older comments come from asking for those before the oldest.
        const oldest = Math.min(...json.hits.map((h) => h && h.created_at_i).filter(Number.isFinite));
        if (!Number.isFinite(oldest) || oldest === before) break;
        before = oldest;
        page = 0;
      } else break;
    }
    return out;
  }

  /**
   * This month's and last month's "Who is hiring?" posts that are for students (interns, new grads, juniors),
   * one per company (the newer). cache: the previous result; a thread read under 12 hours ago isn't read again,
   * and one that doesn't load keeps what the cache had.
   */
  async function hnHiring({ fetch: fetchFn, now = Date.now(), base = HN_API, cache } = {}) {
    const stats = { asked: 0, answered: 0 };
    const old = cache && Array.isArray(cache.threads) ? cache : null;
    const cached = (t) => (old ? old.threads.find((x) => String(x.id) === String(t.id)) : null);
    const fresh = (t) => {
      const c = cached(t);
      const at = c && (c.at || old.at);
      return !!at && now - at < CACHE_FOR;
    };
    const fromCache = (t) => (old.posts || []).filter((p) => String(p.thread) === String(t.id));
    let threads = await hnThreads({ fetch: fetchFn, now, base, stats });
    // The thread list didn't load: what the cache read recently still stands.
    if (!threads.length && old) threads = old.threads.filter(fresh);
    const posts = [];
    const read = [];
    for (const t of threads) {
      const entry = { id: String(t.id), title: t.title || '', month: t.month || '' };
      if (fresh(t)) {
        posts.push(...fromCache(t));
        read.push({ ...entry, at: cached(t).at || old.at });
        continue;
      }
      const answered = stats.answered;
      const list = await hnPosts(t, { fetch: fetchFn, base, stats });
      if (stats.answered === answered) {
        if (cached(t)) {
          posts.push(...fromCache(t));
          read.push({ ...entry, at: cached(t).at || old.at });
        }
        continue;
      }
      read.push({ ...entry, at: now });
      for (const raw of list) {
        const parsed = parsePost(raw);
        if (parsed.student && parsed.company) posts.push(parsed);
      }
    }
    // One post per company, by name or by domain: the newest.
    const keep = [];
    const seen = new Set();
    for (const p of posts.sort((a, b) => String(b.postedAt).localeCompare(String(a.postedAt)))) {
      const keys = [D.normName(p.company), p.domain].filter(Boolean);
      if (keys.some((k) => seen.has(k))) continue;
      keys.forEach((k) => seen.add(k));
      keep.push(p);
    }
    return { posts: keep, threads: read, at: now, answered: stats.answered, asked: stats.asked };
  }

  /** A firm for Discover's results from a parsed post (source 'hn'; no registry facts, so those are null). */
  function hnFirm(post) {
    const p = post || {};
    const name = p.company || '';
    const domain = p.domain || '';
    const pages = (p.urls || []).filter((u) => {
      if (!domain || D.domainOf(u) !== domain) return false;
      try {
        return CAREERS.test(new URL(u).pathname);
      } catch (err) {
        return false;
      }
    });
    return {
      id: 'hn:' + (domain || D.normName(name).replace(/ /g, '-')),
      name,
      aliases: [],
      domain,
      site: p.site || '',
      cities: citiesOf(p.locations),
      country: countryOf(p.locations),
      employees: null,
      aum: null,
      funds: null,
      crd: null,
      wiki: null,
      qid: null,
      tags: ['tech'],
      source: 'hn',
      yc: p.yc || null,
      remote: !!p.remote,
      about: clip(p.text || '', 160),
      hn: {
        url: p.hnUrl || '',
        month: p.month || '',
        roles: p.roles || [],
        emails: p.emails || [],
        kinds: p.kinds || [],
        postedAt: p.postedAt || '',
      },
      boards: p.boards || [],
      pages,
    };
  }

  /* ------------------------------------------------------------- Simplify */

  const SIMPLIFY_REPOS = { intern: 'SimplifyJobs/Summer{YEAR}-Internships', grad: 'SimplifyJobs/New-Grad-Positions' };
  const SIMPLIFY_FILE = 'dev/.github/scripts/listings.json';
  const rawUrl = (repo) => `https://raw.githubusercontent.com/${repo}/${SIMPLIFY_FILE}`;

  /**
   * Simplify's listings to try: next summer's internships, then this summer's (a season's repository appears the
   * autumn before; last season's is renamed to the new one), then the new-grad list.
   */
  function simplifyUrls(now = Date.now()) {
    const year = new Date(now).getFullYear();
    return [year + 1, year]
      .map((y) => rawUrl(SIMPLIFY_REPOS.intern.replace('{YEAR}', y)))
      .concat(rawUrl(SIMPLIFY_REPOS.grad));
  }

  /** A Simplify listing's posting date (unix seconds) as YYYY-MM-DD, or null. */
  function postedOn(seconds) {
    return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString().slice(0, 10) : null;
  }

  /**
   * Every company Simplify's internship and new-grad lists show (names as trackrCompanies() gives them, and own
   * domains), and their open roles, newest first (at most 3,000). Failures just make the lists shorter.
   */
  async function simplifyListings({ fetch: fetchFn, now = Date.now() } = {}) {
    const stats = { asked: 0, answered: 0 };
    const urls = simplifyUrls(now);
    const gradUrl = urls.pop();
    const interns = async () => {
      for (const url of urls) {
        const r = await ask(fetchFn, url, stats, BIG_REQUEST);
        if (r.ok && Array.isArray(r.json)) return r.json;
      }
      return [];
    };
    const grads = async () => {
      const r = await ask(fetchFn, gradUrl, stats, BIG_REQUEST);
      return r.ok && Array.isArray(r.json) ? r.json : [];
    };
    const [intern, grad] = await Promise.all([interns(), grads()]);
    const names = new Set();
    const domains = new Set();
    const roles = [];
    for (const [list, kind] of [
      [intern, 'internship'],
      [grad, 'graduate'],
    ])
      for (const l of list) {
        if (!l || l.is_visible === false || !l.company_name) continue;
        const company = String(l.company_name);
        names.add(D.normName(company));
        // A short core is someone else's as often as not: "Capital One" → "one" would hide One Investment Management.
        const core = D.coreName(company);
        if (core.length >= 4 || core.includes(' ')) names.add(core);
        // company_url is Simplify's own page for the company ("simplify.jobs/c/CACI"), and most urls an ATS's.
        for (const link of [l.company_url, l.url]) if (link && !notOwn(link)) domains.add(D.domainOf(link));
        if (l.active !== true) continue;
        roles.push({
          company,
          title: String(l.title || '').trim(),
          url: String(l.url || ''),
          locations: Array.isArray(l.locations) ? l.locations.map(String) : [],
          posted: postedOn(l.date_posted),
          kind,
          sponsorship: l.sponsorship || '',
          active: true,
          terms: Array.isArray(l.terms) ? l.terms.map(String) : [],
        });
      }
    names.delete('');
    domains.delete('');
    roles.sort((a, b) => String(b.posted || '').localeCompare(String(a.posted || '')));
    return {
      names: [...names],
      domains: [...domains],
      roles: roles.slice(0, 3000),
      at: now,
      answered: stats.answered,
      asked: stats.asked,
    };
  }

  /** Several { names, domains } lists (Trackr's, Simplify's; null skipped) as one that JTF.discover.onList() takes. */
  function listedSet(...lists) {
    const names = new Set();
    const domains = new Set();
    let at = null;
    for (const l of lists) {
      if (!l) continue;
      for (const n of l.names || []) if (n) names.add(n);
      for (const d of l.domains || []) if (d) domains.add(d);
      if (Number.isFinite(l.at) && (at == null || l.at > at)) at = l.at;
    }
    return { names: [...names], domains: [...domains], at };
  }

  const discoverSources = {
    HN_API,
    hnThreads,
    hnPosts,
    parsePost,
    hnHiring,
    hnFirm,
    SIMPLIFY_REPOS,
    simplifyUrls,
    simplifyListings,
    listedSet,
  };
  JTF.discoverSources = discoverSources;
  if (typeof module === 'object' && module.exports) module.exports = discoverSources;
})(typeof globalThis !== 'undefined' ? globalThis : this);
