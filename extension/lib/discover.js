/*
 * JobToFill — Discover: reputable but low-profile employers (small hedge funds, quant shops, boutique
 * advisers…) that the big internship trackers don't list, and the internships on their own careers pages.
 * Pure logic plus fetches through an injected fetch (no extension APIs); runs in extension pages, the
 * background (watchlist checks) and Node tests. Uses JTF.util, and JTF.jobpage when it is loaded.
 *
 * Nothing here trusts a single source. A firm comes from a registry (SEC Form ADV, Wikipedia; bundled as
 * data/firms.json) or, when the AI suggests it, only after a live check proves it exists. A job board counts
 * when the firm's own site links to it, or when its board name matches the firm. A role counts when its
 * title says internship, summer analyst, off-cycle, insight, graduate…
 *
 *   loadFirms(json)                        → [firm]  (firms.json's short keys expanded; see firmFrom)
 *   search(firms, query, { trackr })       → [{ firm, score, reasons, flags }] best first
 *   similarTo(firms, seeds)                → [{ firm, score, reasons }] registry neighbours of the seed firms
 *   wikiSimilar(seeds, { fetch })          → [{ title, qid, shared: [category] }] firms sharing Wikipedia categories
 *   trackrCompanies({ fetch, now })        → { names: [normalised], domains: [], at }  everyone Trackr lists
 *   careers(firm, { fetch, now })          → { status, pages, boards, roles, programmes, log }
 *   check(entry, { fetch, now })           → { roles, programmes, keys, fresh: [key], status, log }  (watchlist)
 *   suggest(chat, query, firms, { fetch }) → { found: [result], rejected: [{ name, why }] }  AI ideas, verified
 *
 * A firm is { id, name, aliases, domain, site, cities, country, employees, aum (USD bn), funds, crd, wiki,
 * qid, tags, source }. A role is { title, url, location, posted, ats, kind: 'internship'|'graduate'|'insight' }.
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});
  const U = JTF.util;

  const TIMEOUT = 20000;
  const JSON_HEADERS = { Accept: 'application/json' };

  /* ------------------------------------------------------------- niches */

  // What the search form offers, and the firms.json tags each one covers.
  const NICHES = {
    hedge: { label: 'Hedge funds', tags: ['hedge'], wiki: /hedge fund|tiger cub|alternative investment/i },
    quant: { label: 'Quant and systematic', tags: ['quant'], wiki: /quantitative|hedge fund|derivative trading/i },
    trading: { label: 'Prop trading and market making', tags: ['trading'], wiki: /trading|market mak/i },
    asset: { label: 'Asset managers', tags: ['asset'], wiki: /investment management|asset management/i },
    credit: { label: 'Credit and distressed', tags: ['credit'], wiki: /credit|hedge fund/i },
    pe: { label: 'Private equity', tags: ['pe'], wiki: /private equity/i },
    ib: { label: 'Boutique advisory banks', tags: ['ib'], wiki: /investment bank/i },
    family: { label: 'Family offices', tags: ['family'], wiki: /family office/i },
    vc: { label: 'Venture capital', tags: ['vc'], wiki: /venture capital/i },
  };

  // prettier-ignore
  const SIZES = {
    boutique: { label: 'Boutique (under 100 staff)', max: 100 },
    small: { label: 'Small (under 300)', max: 300 },
    mid: { label: 'Mid-sized (under 1,000)', max: 1000 },
    any: { label: 'Any size', max: Infinity },
  };

  // Places people search for, with what the registry calls them.
  // prettier-ignore
  const PLACES = {
    london: { label: 'London', cities: ['london'], country: 'GB' },
    uk: { label: 'United Kingdom', country: 'GB' },
    nyc: { label: 'New York', cities: ['new york', 'new york city', 'nyc', 'manhattan'], country: 'US' },
    greenwich: { label: 'Greenwich and Stamford', cities: ['greenwich', 'stamford', 'westport', 'old greenwich', 'darien', 'norwalk'], country: 'US' },
    boston: { label: 'Boston', cities: ['boston', 'cambridge'], country: 'US' },
    chicago: { label: 'Chicago', cities: ['chicago'], country: 'US' },
    sf: { label: 'San Francisco Bay Area', cities: ['san francisco', 'menlo park', 'palo alto', 'san mateo', 'redwood city', 'mountain view', 'oakland', 'burlingame'], country: 'US' },
    texas: { label: 'Texas', cities: ['dallas', 'houston', 'austin', 'fort worth', 'san antonio'], country: 'US' },
    us: { label: 'United States', country: 'US' },
    hk: { label: 'Hong Kong', country: 'HK' },
    sg: { label: 'Singapore', country: 'SG' },
    ch: { label: 'Switzerland', country: 'CH' },
    europe: { label: 'Europe', countries: ['GB', 'IE', 'FR', 'DE', 'NL', 'CH', 'LU', 'SE', 'DK', 'NO', 'FI', 'IT', 'ES', 'BE', 'AT', 'JE', 'GG', 'MC'] },
    any: { label: 'Anywhere' },
  };

  /* -------------------------------------------------------------- roles */

  // Titles of student roles, in the languages the trackers cover. "Internal", "International" and
  // "Internet" are not internships.
  const INTERN =
    /\b(interns?\b|internships?\b|summer (analyst|associate|programme|program|intern|placement|school)|off[- ]?cycle|industrial placement|placement (year|student|programme|program)|year in industry|co-?op\b|working student|werkstudent|praktik(um|ant)|stagiaire|stage (de|d’|d')|tirocin|práctica|becario)/i;
  const GRADUATE =
    /\b(graduate (programme|program|analyst|scheme|trader|researcher|developer|engineer|role|associate|software)|new grad|campus hire|class of 20\d\d|analyst (programme|program)|grad(uate)? 20\d\d|20\d\d graduate|entry[- ]level|early careers?|junior (analyst|trader|quant|researcher)|,\s*graduates?$|^graduates?\b)/i;
  const INSIGHT =
    /\b(insight (day|week|programme|program|event|evening)s?|spring (week|insight|programme|program|internship)|discovery (day|week|programme|program)|open day|taster|virtual (information|experience)|information session|informationals?|women in (trading|finance|technology|investing|quant)|diversity (programme|program|insight|fellowship)|fellowship|bootcamp)/i;
  const NOT_STUDENT =
    /\b(vp|principal|senior|sr|lead|staff engineer|manager|coordinator|recruiter|recruitment|officer|\d+\+? years)\b/i;

  /** 'internship', 'graduate', 'insight' or null: is this job title a student role? */
  function roleKind(title) {
    const t = String(title || '').replace(/\b(internal|international|internet)\b/gi, ' ');
    if (!t.trim() || /\b(vice president|director|head of|managing director)\b/i.test(t)) return null;
    if (INTERN.test(t)) return 'internship';
    if (INSIGHT.test(t)) return 'insight';
    if (GRADUATE.test(t) && !NOT_STUDENT.test(t.replace(GRADUATE, ' '))) return 'graduate';
    return null;
  }

  /* --------------------------------------------------------- names, hosts */

  const LEGAL =
    /\b(l[. ]?l[. ]?p|l[. ]?p|l[. ]?l[. ]?c|ltd|limited|inc|incorporated|plc|corp|corporation|co|company|gmbh|ag|sa|sarl|s\.?a\.?r\.?l|pte|pty|bv|nv|ab|as|oy|kk|holdings?|group|the|uk|us|usa|u\.s|u\.k|north america|europe|international|global|asia|hong kong|singapore|london|new york)\b/gi;
  const GENERIC =
    /\b(capital|management|asset|assets|investment|investments|investors|advisors|advisers|advisory|partners|partnership|fund|funds|associates|securities|trading|markets|global|financial|finance|research|technologies|technology|llc|lp)\b/gi;

  /** Comparable form of a firm name: "LANSDOWNE PARTNERS (UK) LLP" → "lansdowne partners". */
  function normName(s) {
    return U.normalize(
      String(s || '')
        .replace(/&/g, ' and ')
        .replace(/\([^)]*\)/g, ' '),
    )
      .replace(LEGAL, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** The distinctive part of a name: "HBK Capital Management" → "hbk", "Lansdowne Partners" → "lansdowne". */
  function coreName(s) {
    const n = normName(s);
    const core = n
      .replace(GENERIC, ' ')
      .replace(/\b(and|of|for)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return core || n;
  }

  /**
   * Strict: the same firm? Full names equal, or the distinctive parts are equal and long enough not to be a
   * coincidence ("GSA Capital" ↔ "GSA Capital Partners LLP" yes; "Man Group" ↔ "Man Investments" yes, by core
   * "man" only when both full names agree on the rest; "Capital Group" ↔ "Capula" no).
   */
  function sameFirm(a, b) {
    const na = normName(a);
    const nb = normName(b);
    if (!na || !nb) return false;
    if (na === nb || na.replace(/ /g, '') === nb.replace(/ /g, '')) return true;
    const ca = coreName(a);
    const cb = coreName(b);
    if (!ca || !cb) return false;
    if (ca === cb) {
      if (ca.length >= 4 || ca.includes(' ')) return true;
      // "GSA Capital" ↔ "GSA Capital Partners": a short core needs the longer names to agree too.
      const [x, y] = na.length <= nb.length ? [na, nb] : [nb, na];
      return x.includes(' ') && y.startsWith(x + ' ');
    }
    // "Davidson Kempner Capital Management" ↔ "Davidson Kempner"
    const short = ca.length <= cb.length ? ca : cb;
    const long = short === ca ? cb : ca;
    return short.length >= 6 && short.includes(' ') && (long.startsWith(short + ' ') || long.endsWith(' ' + short));
  }

  function parseUrl(url, base) {
    try {
      return new URL(url, base);
    } catch (err) {
      return null;
    }
  }

  /** The registrable-ish domain of a host or address: "careers.hbk.com" → "hbk.com", "x.co.uk" kept. */
  function domainOf(input) {
    const s = String(input || '').trim();
    if (!s) return '';
    const u = /^[a-z][a-z\d+.-]*:\/\//i.test(s) ? parseUrl(s) : parseUrl('https://' + s);
    if (!u) return '';
    const labels = u.hostname
      .toLowerCase()
      .replace(/^www\d?\./, '')
      .split('.')
      .filter(Boolean);
    if (labels.length <= 2) return labels.join('.');
    const sld = labels[labels.length - 2];
    const two = labels[labels.length - 1].length === 2 && /^(co|com|org|net|ac|gov|ltd|plc|edu)$/.test(sld);
    return labels.slice(two ? -3 : -2).join('.');
  }

  const SOCIAL =
    /(^|\.)(linkedin|twitter|x|facebook|instagram|youtube|bloomberg|crunchbase|wikipedia|medium|github|about|google|sec|adviserinfo|businesswire|prnewswire)\.(com|org|me|gov)$/i;

  /** A usable company website (https origin), or ''. */
  function siteOf(input) {
    const s = String(input || '').trim();
    if (!s) return '';
    const u = /^[a-z][a-z\d+.-]*:\/\//i.test(s) ? parseUrl(s) : parseUrl('https://' + s);
    if (!u || !/^https?:$/.test(u.protocol) || !u.hostname.includes('.') || SOCIAL.test(u.hostname)) return '';
    return 'https://' + u.hostname.toLowerCase();
  }

  /* ------------------------------------------------------------ registry */

  /** firms.json's compact record ({ n, a, d, s, c, k, e, m, f, r, w, q, t }) as a firm. */
  function firmFrom(r) {
    if (!r || !r.n) return null;
    const domain = domainOf(r.d || '');
    return {
      id: r.r ? 'crd:' + r.r : r.q ? 'wd:' + r.q : domain ? 'd:' + domain : 'n:' + normName(r.n).replace(/ /g, '-'),
      name: String(r.n),
      aliases: Array.isArray(r.a) ? r.a.map(String) : [],
      domain,
      site: siteOf(r.s || r.d || ''),
      cities: Array.isArray(r.c) ? r.c.map(String) : [],
      country: r.k ? String(r.k).toUpperCase() : '',
      employees: Number.isFinite(r.e) ? r.e : null,
      aum: Number.isFinite(r.m) ? r.m : null,
      funds: Number.isFinite(r.f) ? r.f : null,
      crd: r.r || null,
      wiki: r.w ? String(r.w) : null,
      qid: r.q ? String(r.q) : null,
      tags: Array.isArray(r.t) ? r.t.map(String) : [],
      source: 'registry',
    };
  }

  function loadFirms(json) {
    const list = json && Array.isArray(json.firms) ? json.firms : Array.isArray(json) ? json : [];
    return list.map(firmFrom).filter(Boolean);
  }

  /** The registry's firm for a name or website, if there is one. */
  function lookup(firms, nameOrSite) {
    const s = String(nameOrSite || '').trim();
    if (!s) return null;
    const d = /\.[a-z]{2,}(\/|$)/i.test(s) && !/\s/.test(s) ? domainOf(s) : '';
    if (d) {
      const byDomain = firms.find((f) => f.domain === d);
      if (byDomain) return byDomain;
    }
    const n = normName(s);
    return (
      firms.find((f) => normName(f.name) === n) ||
      firms.find((f) => f.aliases.some((a) => normName(a) === n)) ||
      firms.find((f) => sameFirm(f.name, s) || f.aliases.some((a) => sameFirm(a, s))) ||
      // Typed as people say it: "HBK" for HBK Capital Management.
      (n.length >= 3 ? firms.find((f) => coreName(f.name) === n) : null) ||
      null
    );
  }

  /* --------------------------------------------------------- reputation */

  /**
   * Why this firm can be trusted (regulated, sizeable, written about) and how low its profile is.
   * reputation 0..1, humble 0..1, reasons: short phrases for the result card.
   */
  function standing(firm, { trackr } = {}) {
    const reasons = [];
    let rep = 0;
    if (firm.crd) {
      rep += 0.4;
      reasons.push('SEC-registered adviser');
    }
    if (firm.aum != null && firm.aum > 0) {
      rep += Math.min(0.3, Math.log10(1 + firm.aum) * 0.15);
      reasons.push(`$${firm.aum >= 10 ? Math.round(firm.aum) : firm.aum.toFixed(1)}bn under management`);
    }
    if (firm.wiki) {
      rep += 0.25;
      reasons.push('Wikipedia article');
    }
    if (firm.qid && !firm.wiki) rep += 0.1;
    if (firm.funds) rep += Math.min(0.1, firm.funds / 100);
    if (firm.verified && firm.verified.length) {
      rep += 0.15 * firm.verified.length;
      reasons.push(...firm.verified);
    }
    let humble = 0.5;
    const e = firm.employees;
    if (e != null) {
      humble = e <= 50 ? 1 : e <= 150 ? 0.85 : e <= 400 ? 0.65 : e <= 1000 ? 0.4 : e <= 3000 ? 0.15 : 0;
      reasons.push(`${e.toLocaleString('en-GB')} staff`);
    }
    const onTrackr = !!(trackr && onList(trackr, firm));
    if (onTrackr) humble *= 0.3;
    return { reputation: Math.min(1, rep), humble, onTrackr, reasons };
  }

  /** Is the firm on Trackr's lists ({ names, domains } from trackrCompanies)? */
  function onList(list, firm) {
    if (!list) return false;
    if (firm.domain && (list.domains || []).includes(firm.domain)) return true;
    const names = [firm.name, ...(firm.aliases || [])];
    const set = list.nameSet || (list.nameSet = new Set(list.names || []));
    if (names.some((n) => set.has(normName(n)) || set.has(coreName(n)))) return true;
    return false;
  }

  /* --------------------------------------------------------------- search */

  function placeMatch(firm, place) {
    const p = PLACES[place];
    if (!p || place === 'any') return true;
    const cities = firm.cities.map((c) => U.normalize(c));
    if (p.cities) return firm.country === p.country && cities.some((c) => p.cities.includes(c));
    if (p.countries) return p.countries.includes(firm.country);
    return firm.country === p.country;
  }

  /**
   * Registry firms that fit the query, ranked: a good name (regulated, sizeable, written about) with a low
   * profile (small team, not on Trackr). query: { niches: [], place, size, text, hideTrackr, seeds: [firm] }.
   */
  function search(firms, query, { trackr } = {}) {
    const q = query || {};
    const tags = new Set((q.niches || []).flatMap((n) => (NICHES[n] ? NICHES[n].tags : [n])));
    const max = (SIZES[q.size] || SIZES.any).max;
    const text = normName(q.text || '');
    const near = q.seeds && q.seeds.length ? new Map(similarTo(firms, q.seeds).map((s) => [s.firm.id, s])) : null;
    const out = [];
    for (const firm of firms) {
      if (tags.size && !firm.tags.some((t) => tags.has(t))) continue;
      if (!placeMatch(firm, q.place)) continue;
      if (firm.employees != null && firm.employees > max) continue;
      if (text && !normName([firm.name, ...firm.aliases].join(' ')).includes(text)) continue;
      if (q.seeds && q.seeds.some((s) => s.id === firm.id)) continue;
      const st = standing(firm, { trackr });
      if (q.hideTrackr && st.onTrackr) continue;
      const sim = near && near.get(firm.id);
      // Firms with nothing to go on (no website, no article) can't be checked, so they sink.
      const reachable = firm.site || firm.wiki ? 1 : 0.4;
      const score = (0.45 * st.reputation + 0.35 * st.humble + (sim ? 0.4 * sim.score : 0)) * reachable;
      out.push({
        firm,
        score: Math.round(score * 1000) / 1000,
        reasons: [...(sim ? sim.reasons : []), ...st.reasons],
        flags: { onTrackr: st.onTrackr, similar: !!sim },
      });
    }
    return out.sort((a, b) => b.score - a.score || a.firm.name.localeCompare(b.firm.name));
  }

  /** Registry neighbours of the seed firms: same niche, same city, a similar size. */
  function similarTo(firms, seeds) {
    const out = new Map();
    for (const seed of seeds || []) {
      if (!seed) continue;
      const seedCities = new Set(seed.cities.map((c) => U.normalize(c)));
      for (const f of firms) {
        if (f.id === seed.id) continue;
        let score = 0;
        const why = [];
        const shared = f.tags.filter((t) => seed.tags.includes(t));
        if (shared.length) score += 0.4;
        if (f.cities.some((c) => seedCities.has(U.normalize(c)))) score += 0.25;
        else if (f.country && f.country === seed.country) score += 0.1;
        if (f.employees && seed.employees) {
          const r = Math.max(f.employees, seed.employees) / Math.min(f.employees, seed.employees);
          if (r <= 3) score += 0.2;
          else if (r <= 8) score += 0.1;
        }
        if (f.aum && seed.aum) {
          const r = Math.max(f.aum, seed.aum) / Math.min(f.aum, seed.aum);
          if (r <= 4) score += 0.15;
        }
        if (score < 0.6 || !shared.length) continue;
        why.push(`Like ${seed.name}`);
        const prev = out.get(f.id);
        if (!prev || prev.score < score) out.set(f.id, { firm: f, score: Math.min(1, score), reasons: why });
      }
    }
    return [...out.values()].sort((a, b) => b.score - a.score);
  }

  /* ---------------------------------------------------------------- fetch */

  const UNSAFE =
    /logout|log-out|signout|sign-out|unsubscribe|delete|remove|withdraw|cancel|confirm|verify|activate|reset|token=|password/i;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * One request with a timeout and a retry on 429/5xx. Returns { ok, status, url, text, json, blocked } and
   * never throws (failures come back as { ok: false, error }). A tiny 202 page is a bot check, not content.
   */
  async function get(fetchFn, url, { method = 'GET', headers, body, timeout = TIMEOUT, retries = 1, json } = {}) {
    // Never open an address that might do something (sign out, unsubscribe…); job board APIs are fine.
    if (UNSAFE.test(url) && !json) return { ok: false, status: 0, url, text: '', error: 'skipped' };
    let last = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), timeout) : null;
      try {
        const res = await fetchFn(url, {
          method,
          headers: headers || (json ? JSON_HEADERS : { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' }),
          body: body == null ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
          credentials: 'omit',
          redirect: 'follow',
          signal: ctrl ? ctrl.signal : undefined,
        });
        const text = await res.text();
        last = { ok: res.ok, status: res.status, url: res.url || url, text };
        if (res.status === 202 && text.length < 2000) last.blocked = true;
        if (/^(429|5\d\d)$/.test(String(res.status)) && attempt < retries) {
          await sleep(2000 * 2 ** attempt);
          continue;
        }
        if (json && res.ok) {
          try {
            last.json = JSON.parse(text);
          } catch (err) {
            last.ok = false;
            last.error = 'not JSON';
          }
        }
        return last;
      } catch (err) {
        last = {
          ok: false,
          status: 0,
          url,
          text: '',
          error: (err && err.name === 'AbortError' && 'timed out') || String((err && err.message) || err),
        };
        if (attempt < retries) await sleep(1000);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    return last;
  }

  /** Run tasks with at most `limit` at once; results in order. */
  async function pool(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        try {
          out[i] = await fn(items[i], i);
        } catch (err) {
          out[i] = null;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
  }

  /* --------------------------------------------------------------- Trackr */

  const TRACKR_API = 'https://api.the-trackr.com/programmes';
  const TRACKR_TYPES = ['summer-internships', 'off-cycle-internships', 'spring-weeks', 'graduate-programmes'];
  const TRACKR_REGIONS = ['UK', 'US', 'EU', 'Hong Kong'];

  /**
   * Every company Trackr's finance and tech trackers list this season and next (normalised names and website
   * domains), so Discover can leave them out. Failures just make the list shorter.
   */
  async function trackrCompanies({
    fetch: fetchFn,
    now = Date.now(),
    regions = TRACKR_REGIONS,
    base = TRACKR_API,
  } = {}) {
    const year = new Date(now).getFullYear();
    const requests = [];
    for (const region of regions)
      for (const industry of ['Finance', 'Tech'])
        for (const season of [year, year + 1])
          for (const type of TRACKR_TYPES)
            requests.push(
              `${base}?region=${encodeURIComponent(region)}&industry=${industry}&season=${season}&type=${type}`,
            );
    const names = new Set();
    const domains = new Set();
    let answered = 0;
    await pool(requests, 6, async (url) => {
      const r = await get(fetchFn, url, { json: true, timeout: 15000 });
      if (!r.ok || !r.json || !Array.isArray(r.json.programmes)) return;
      answered++;
      for (const p of r.json.programmes) {
        const c = p && p.company;
        const name = (c && c.name) || '';
        if (name) {
          names.add(normName(name));
          names.add(coreName(name));
        }
        for (const link of [c && c.careersSite, p && p.url]) {
          const d = domainOf(link || '');
          // Job boards (greenhouse.io…) are shared by everyone, so only the firm's own domain counts.
          if (d && !ATS_DOMAIN.test(d)) domains.add(d);
        }
      }
    });
    names.delete('');
    return { names: [...names], domains: [...domains], at: now, answered, asked: requests.length };
  }

  /* ----------------------------------------------------------- Wikipedia */

  const WIKI_API = 'https://en.wikipedia.org/w/api.php';
  // Wikimedia asks API users to say who they are.
  const WIKI_HEADERS = {
    Accept: 'application/json',
    'Api-User-Agent': 'JobToFill (https://github.com/rob435/JobToFill)',
  };
  // Categories that say nothing about what a firm does.
  const WIKI_NOISE =
    /established in|establishments|disestablish|stubs|mergers and acquisitions|initial public offerings|companies formerly|privately held|companies based in (the )?(city of westminster|mayfair|manhattan)|^\d{4}|articles|pages|wikidata|cs1|webarchive|short description|use (dmy|mdy)|all /i;

  function wikiUrl(params) {
    const p = Object.assign({ action: 'query', format: 'json', formatversion: '2', origin: '*' }, params);
    return WIKI_API + '?' + new URLSearchParams(p).toString();
  }

  /**
   * Firms that share Wikipedia categories with the seeds ("Hedge fund firms in the United Kingdom", "Tiger Cub
   * firms"…), most shared first. seeds: Wikipedia titles.
   */
  async function wikiSimilar(seeds, { fetch: fetchFn, limit = 60 } = {}) {
    const titles = (seeds || []).filter(Boolean).slice(0, 10);
    if (!titles.length) return [];
    const r = await get(
      fetchFn,
      wikiUrl({ titles: titles.join('|'), redirects: '1', prop: 'categories', clshow: '!hidden', cllimit: 'max' }),
      { json: true, retries: 2, headers: WIKI_HEADERS },
    );
    if (!r.ok || !r.json || !r.json.query) return [];
    const cats = new Set();
    for (const p of r.json.query.pages || [])
      for (const c of p.categories || []) if (!WIKI_NOISE.test(c.title.replace(/^Category:/, ''))) cats.add(c.title);
    const seedTitles = new Set((r.json.query.pages || []).map((p) => p.title));
    const counts = new Map();
    await pool([...cats].slice(0, 12), 3, async (cat) => {
      const m = await get(
        fetchFn,
        wikiUrl({
          generator: 'categorymembers',
          gcmtitle: cat,
          gcmtype: 'page',
          gcmlimit: '200',
          prop: 'pageprops',
          ppprop: 'wikibase_item',
        }),
        { json: true, retries: 2, headers: WIKI_HEADERS },
      );
      for (const p of (m.ok && m.json && m.json.query && m.json.query.pages) || []) {
        if (seedTitles.has(p.title) || /^List of /i.test(p.title)) continue;
        const e = counts.get(p.title) || {
          title: p.title,
          qid: (p.pageprops && p.pageprops.wikibase_item) || null,
          shared: [],
        };
        e.shared.push(cat.replace(/^Category:/, ''));
        counts.set(p.title, e);
      }
    });
    return [...counts.values()].sort((a, b) => b.shared.length - a.shared.length).slice(0, limit);
  }

  /** The official website Wikidata records for an item (P856), or ''. */
  async function wikidataSite(qid, { fetch: fetchFn } = {}) {
    if (!/^Q\d+$/.test(String(qid || ''))) return '';
    const r = await get(
      fetchFn,
      `https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&origin=*&props=claims&ids=${qid}`,
      { json: true, retries: 2, headers: WIKI_HEADERS },
    );
    const e = r.ok && r.json && r.json.entities && r.json.entities[qid];
    const claim = e && e.claims && e.claims.P856 && e.claims.P856[0];
    const v = claim && claim.mainsnak && claim.mainsnak.datavalue && claim.mainsnak.datavalue.value;
    return siteOf(v || '');
  }

  /** A Wikipedia article whose title is this firm, or null: { title, qid, description }. */
  async function wikiFind(name, { fetch: fetchFn } = {}) {
    const r = await get(
      fetchFn,
      wikiUrl({
        generator: 'search',
        gsrsearch: name,
        gsrlimit: '5',
        prop: 'pageprops|description',
        ppprop: 'wikibase_item',
      }),
      { json: true, retries: 2, headers: WIKI_HEADERS },
    );
    const pages = (r.ok && r.json && r.json.query && r.json.query.pages) || [];
    const hit = pages
      .sort((a, b) => (a.index || 0) - (b.index || 0))
      .find((p) => sameFirm(p.title.replace(/\s*\([^)]*\)$/, ''), name));
    if (!hit) return null;
    const desc = String(hit.description || '');
    // An article about a person or a fund of the same name doesn't vouch for the firm.
    if (
      desc &&
      !/compan|firm|fund|manager|management|bank|investment|financial|trading|advis|capital|office|partnership|private equity/i.test(
        desc,
      )
    )
      return null;
    return { title: hit.title, qid: (hit.pageprops && hit.pageprops.wikibase_item) || null, description: desc };
  }

  /* ------------------------------------------------------- SEC adviser data */

  /** Is there an active SEC-registered adviser by this name? { name, crd, city, country } or null. */
  async function secFind(name, { fetch: fetchFn } = {}) {
    const r = await get(
      fetchFn,
      `https://api.adviserinfo.sec.gov/search/firm?query=${encodeURIComponent(name)}&nrows=5&start=0&wt=json`,
      { json: true, retries: 1 },
    );
    const hits = (r.ok && r.json && r.json.hits && r.json.hits.hits) || [];
    for (const h of hits) {
      const s = h && h._source;
      if (!s || !s.firm_name) continue;
      const names = [s.firm_name, ...(s.firm_other_names || [])];
      if (!names.some((n) => sameFirm(n, name))) continue;
      if (s.firm_ia_scope && !/active/i.test(s.firm_ia_scope)) continue;
      let city = '';
      let country = '';
      try {
        const a = JSON.parse(s.firm_ia_address_details || '{}').officeAddress || {};
        city = a.city || '';
        country = a.country || '';
      } catch (err) {
        // The address is optional.
      }
      return { name: s.firm_name, crd: s.firm_source_id || null, city, country };
    }
    return null;
  }

  /* --------------------------------------------------------- careers pages */

  const CAREER_LINK =
    /career|\bjobs?\b|join[- ]?(us|our|the team)|opportunit|work(ing)?[- ](with|for|at)[- ]|working[- ]here|vacanc|recruit|graduate|early[- ]careers|students?\b|campus|intern|life[- ]at|people[- ]and[- ]culture|join\b|open (roles|positions)|openings|positions/i;
  const NOT_CAREER =
    /\/(people|team|our-team|leadership|fund|funds|news|insights|press|media|contact|legal|privacy|cookie|investor|portfolio)(\/|$)|\.(pdf|jpg|png|zip)$|^mailto:|^tel:|^javascript:/i;
  const CAREER_PATHS = [
    '/careers/',
    '/careers',
    '/career/',
    '/join-us/',
    '/jobs/',
    '/opportunities/',
    '/students/',
    '/early-careers/',
    '/graduates/',
    '/internships/',
  ];
  // Hosts that belong to job boards rather than to the firm.
  const ATS_DOMAIN =
    /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|myworkdayjobs\.com|myworkdaysite\.com|smartrecruiters\.com|recruitee\.com|teamtailor\.com|personio\.(de|com)|bamboohr\.com|icims\.com|taleo\.net|successfactors\.(com|eu)|oraclecloud\.com|tal\.net|hibob\.com|pinpointhq\.com|jobvite\.com|rippling\.com|dayforcehcm\.com|beapplied\.com|eightfold\.ai|avature\.net|phenompeople\.com|jobs\.net|applytojob\.com|breezy\.hr|comeet\.(co|com)|workforcenow\.adp\.com)$/i;

  /** The page's links: [{ url, text }] (absolute, deduplicated). Regex-based so it also runs in a service worker. */
  function links(html, base) {
    const out = [];
    const seen = new Set();
    const re = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
    let m;
    while ((m = re.exec(String(html || '')))) {
      const href = (m[1].match(/\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i) || [])[0];
      if (!href) continue;
      const raw = href.replace(/^href\s*=\s*/i, '').replace(/^["']|["']$/g, '');
      const u = parseUrl(decode(raw), base);
      if (!u || !/^https?:$/.test(u.protocol)) continue;
      u.hash = '';
      if (seen.has(u.href)) continue;
      seen.add(u.href);
      const text = textOf(m[2]).slice(0, 120);
      const title = (m[1].match(/\b(?:title|aria-label)\s*=\s*"([^"]*)"/i) || [])[1] || '';
      out.push({ url: u.href, text: text || decode(title) });
    }
    return out;
  }

  function decode(s) {
    return String(s || '')
      .replace(/&amp;/g, '&')
      .replace(/&#0?38;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#x2F;/gi, '/')
      .replace(/&#0?39;|&apos;/g, "'");
  }

  /** Plain text of an HTML fragment (jobpage's converter when it's loaded). */
  function textOf(html) {
    if (JTF.jobpage && JTF.jobpage.htmlToText) return JTF.jobpage.htmlToText(html).replace(/\s+/g, ' ').trim();
    return decode(String(html || '').replace(/<[^>]*>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Readable text of a whole page, one block per line (for programme sentences). */
  function pageText(html) {
    const body = String(html || '').replace(/<(nav|header|footer)\b[\s\S]*?<\/\1\s*>/gi, ' ');
    if (JTF.jobpage && JTF.jobpage.htmlToText) return JTF.jobpage.htmlToText(body);
    return decode(
      body
        .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
        .replace(/<\/?(p|div|li|h\d|br|section|tr)\b[^>]*>/gi, '\n')
        .replace(/<[^>]*>/g, ' '),
    );
  }

  /** Links on the firm's own pages that lead to its careers pages, likeliest first. */
  function careerLinks(html, base, domain) {
    const own = domain || domainOf(base);
    return links(html, base)
      .filter((l) => {
        const d = domainOf(l.url);
        if (d !== own && !ATS_DOMAIN.test(d)) return false;
        const u = parseUrl(l.url);
        const path = u.pathname + u.search;
        if (NOT_CAREER.test(path) && !CAREER_LINK.test(l.text)) return false;
        return CAREER_LINK.test(l.text) || CAREER_LINK.test(path.replace(/[-_/]/g, ' '));
      })
      .map((l) => {
        const t = (l.text + ' ' + l.url).toLowerCase();
        let w = 0;
        if (/intern|student|graduate|campus|early/.test(t)) w += 3;
        if (/career|job|vacanc|opening|opportunit|position|join/.test(t)) w += 2;
        if (ATS_DOMAIN.test(domainOf(l.url))) w += 2;
        return { ...l, weight: w };
      })
      .sort((a, b) => b.weight - a.weight);
  }

  // Job boards embedded in or linked from a careers page. Each gives { ats, slug, host?, site?, url }.
  const BOARD_PATTERNS = [
    [
      /(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/[\w/]+\?(?:[^"'\s<>]*?&(?:amp;)?)?for=)?([\w-]+)/gi,
      (m) => ({ ats: 'greenhouse', slug: m[1] }),
    ],
    [/boards-api\.greenhouse\.io\/v1\/boards\/([\w-]+)/gi, (m) => ({ ats: 'greenhouse', slug: m[1] })],
    [/jobs\.(eu\.)?lever\.co\/([\w.-]+)/gi, (m) => ({ ats: 'lever', slug: m[2], host: m[1] ? 'eu' : '' })],
    [/jobs\.ashbyhq\.com\/([\w.%-]+)/gi, (m) => ({ ats: 'ashby', slug: decodeURIComponent(m[1]) })],
    [
      /apply\.workable\.com\/(?:api\/v\d\/(?:widget\/)?accounts\/)?([\w-]+)/gi,
      (m) => ({ ats: 'workable', slug: m[1] }),
    ],
    [/\b([\w-]+)\.workable\.com/gi, (m) => ({ ats: 'workable', slug: m[1] })],
    [
      /\b([\w-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([\w-]+)/g,
      (m) => ({ ats: 'workday', slug: m[1], host: `${m[1]}.${m[2]}.myworkdayjobs.com`, site: m[3] }),
    ],
    [
      /\b(wd\d+)\.myworkdaysite\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?recruiting\/([\w-]+)\/([\w-]+)/g,
      (m) => ({ ats: 'workday', slug: m[2], host: `${m[1]}.myworkdaysite.com`, site: m[3] }),
    ],
    [/(?:careers|jobs)\.smartrecruiters\.com\/([\w-]+)/gi, (m) => ({ ats: 'smartrecruiters', slug: m[1] })],
    [/\b([\w-]+)\.recruitee\.com/gi, (m) => ({ ats: 'recruitee', slug: m[1] })],
    [/\b([\w-]+)\.tal\.net/gi, (m) => ({ ats: 'oleeo', slug: m[1], host: `${m[1]}.tal.net` })],
    [/cdn\.phenompeople\.com\/CareerConnectResources\/(\w+)/gi, (m) => ({ ats: 'phenom', slug: m[1] })],
    [/\b([\w-]+)\.careers\.hibob\.com/gi, (m) => ({ ats: 'hibob', slug: m[1] })],
    [/\b([\w-]+)\.pinpointhq\.com/gi, (m) => ({ ats: 'pinpoint', slug: m[1] })],
    [/\b([\w-]+)\.teamtailor\.com/gi, (m) => ({ ats: 'teamtailor', slug: m[1] })],
    [/\b([\w-]+)\.jobs\.personio\.(?:de|com)/gi, (m) => ({ ats: 'personio', slug: m[1] })],
    [/\b([\w-]+)\.bamboohr\.com\/(?:careers|jobs)/gi, (m) => ({ ats: 'bamboohr', slug: m[1] })],
    [/\b([\w-]+)\.icims\.com/gi, (m) => ({ ats: 'icims', slug: m[1] })],
    [/jobs\.jobvite\.com\/([\w-]+)/gi, (m) => ({ ats: 'jobvite', slug: m[1] })],
    [/\b([\w-]+)\.beapplied\.com/gi, (m) => ({ ats: 'applied', slug: m[1] })],
  ];
  // Slugs that are parts of the boards' own addresses, not employers.
  const NOT_SLUG =
    /^(www|api|embed|jobs|boards|job-boards|apply|app|help|support|cdn|static|assets|careers|v\d|js|css|static\d*|images?|widget|accounts|login|signin|j|en|en-us|en-gb|static-assets)$/i;

  /** Job boards a page embeds or links to (deduplicated). */
  function detectBoards(html, pageUrl) {
    const s = String(html || '').replace(/\\\//g, '/');
    const out = [];
    const seen = new Set();
    for (const [re, make] of BOARD_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(s))) {
        const b = make(m);
        if (!b.slug || NOT_SLUG.test(b.slug)) continue;
        const key = `${b.ats}:${b.slug.toLowerCase()}:${b.site || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ ...b, url: pageUrl || null, found: 'linked' });
      }
    }
    // A firm-domain proxy of a Greenhouse board ("/careers/gh/?gh_jid=123") without the board's name.
    if (!out.some((b) => b.ats === 'greenhouse') && /[?&]gh_jid=\d+/.test(s))
      out.push({ ats: 'greenhouse', slug: null, url: pageUrl, found: 'linked' });
    // Phenom career sites list their jobs on the same host.
    for (const b of out) if (b.ats === 'phenom' && pageUrl) b.host = parseUrl(pageUrl).host;
    return out;
  }

  /** The request that lists a board's jobs. */
  function boardRequest(b) {
    if (!b || (!b.slug && b.ats !== 'phenom')) return null;
    const slug = encodeURIComponent(b.slug || '');
    switch (b.ats) {
      case 'greenhouse':
        return { url: `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`, json: true };
      case 'lever':
        return { url: `https://api.${b.host === 'eu' ? 'eu.' : ''}lever.co/v0/postings/${slug}?mode=json`, json: true };
      case 'ashby':
        return { url: `https://api.ashbyhq.com/posting-api/job-board/${slug}`, json: true };
      case 'workable':
        return { url: `https://apply.workable.com/api/v1/widget/accounts/${slug}`, json: true };
      case 'smartrecruiters':
        return { url: `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100`, json: true };
      case 'recruitee':
        return { url: `https://${slug}.recruitee.com/api/offers`, json: true };
      case 'workday':
        if (!b.host || !b.site) return null;
        return {
          url: `https://${b.host}/wday/cxs/${slug}/${encodeURIComponent(b.site)}/jobs`,
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: { appliedFacets: {}, limit: 20, offset: 0, searchText: '' },
          json: true,
          // Student roles hide among hundreds of jobs at bigger firms, so these searches go too.
          searches: ['intern', 'summer', 'graduate', 'analyst'],
        };
      case 'phenom':
        if (!b.host) return null;
        return { url: `https://${b.host}${b.locale || ''}/search-results?keywords=intern`, json: false };
      case 'oleeo':
        return b.url && /tal\.net/.test(b.url) ? { url: b.url, json: false } : null;
      default:
        return null;
    }
  }

  /** The board's own name for its company, when the API says (for checking a guessed slug). */
  function boardName(b, json) {
    if (!json) return '';
    if (b.ats === 'workable') return json.name || '';
    if (b.ats === 'smartrecruiters') {
      const c = (json.content || [])[0];
      return (c && c.company && c.company.name) || '';
    }
    if (b.ats === 'greenhouse') {
      const j = (json.jobs || [])[0];
      return (j && j.company_name) || '';
    }
    if (b.ats === 'recruitee') {
      const o = (json.offers || [])[0];
      return (o && o.company_name) || '';
    }
    return '';
  }

  /** A board's jobs as roles (every job, student or not; the caller filters). */
  function parseBoard(b, res) {
    const json = res && res.json;
    const jobs = [];
    const add = (title, url, location, posted) => {
      if (!title || !url) return;
      jobs.push({
        title: String(title).replace(/\s+/g, ' ').trim().slice(0, 200),
        url: String(url),
        location: String(location || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120),
        posted: posted ? String(posted).slice(0, 10) : null,
        ats: b.ats,
      });
    };
    switch (b.ats) {
      case 'greenhouse':
        for (const j of (json && json.jobs) || [])
          add(j.title, j.absolute_url, j.location && j.location.name, j.first_published || j.updated_at);
        break;
      case 'lever':
        for (const j of Array.isArray(json) ? json : [])
          add(
            j.text,
            j.hostedUrl,
            j.categories && j.categories.location,
            j.createdAt ? new Date(j.createdAt).toISOString() : null,
          );
        break;
      case 'ashby':
        for (const j of (json && json.jobs) || [])
          if (j.isListed !== false) add(j.title, j.jobUrl, j.location, j.publishedAt);
        break;
      case 'workable':
        for (const j of (json && json.jobs) || [])
          add(
            j.title,
            j.url || j.shortlink || (j.shortcode && `https://apply.workable.com/${b.slug}/j/${j.shortcode}/`),
            [j.city, j.country].filter(Boolean).join(', '),
            j.published_on || j.created_at,
          );
        break;
      case 'smartrecruiters':
        for (const j of (json && json.content) || [])
          add(
            j.name,
            `https://jobs.smartrecruiters.com/${b.slug}/${j.id}`,
            j.location && [j.location.city, j.location.country].filter(Boolean).join(', '),
            j.releasedDate,
          );
        break;
      case 'recruitee':
        for (const j of (json && json.offers) || []) add(j.title, j.careers_url, j.location, j.published_at);
        break;
      case 'workday':
        for (const j of (json && json.jobPostings) || [])
          add(
            j.title,
            j.externalPath
              ? `https://${b.host}/${/myworkdaysite/.test(b.host) ? `recruiting/${b.slug}/` : ''}${b.site}${j.externalPath}`
              : null,
            j.locationsText,
            null,
          );
        break;
      case 'phenom': {
        const ddo = phenomData(res && res.text);
        const list =
          (ddo && ddo.eagerLoadRefineSearch && ddo.eagerLoadRefineSearch.data && ddo.eagerLoadRefineSearch.data.jobs) ||
          [];
        for (const j of list) {
          const url = j.applyUrl || (j.jobSeqNo && `https://${b.host}${b.locale || ''}/job/${j.jobSeqNo}`);
          add(j.title, url, [j.city, j.country].filter(Boolean).join(', '), j.postedDate);
        }
        break;
      }
      case 'oleeo':
        for (const l of links(res && res.text, res && res.url))
          if (/\/opp\/\d+/.test(l.url)) add(l.text, l.url, '', null);
        break;
      default:
        break;
    }
    return jobs;
  }

  /** Phenom career sites put their search results in `phApp.ddo = {…};`. */
  function phenomData(html) {
    const s = String(html || '');
    const i = s.indexOf('phApp.ddo');
    if (i < 0) return null;
    const start = s.indexOf('{', i);
    if (start < 0) return null;
    let depth = 0;
    let inStr = false;
    for (let j = start; j < s.length && j - start < 3e6; j++) {
      const c = s[j];
      if (inStr) {
        if (c === '\\') j++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try {
          return JSON.parse(s.slice(start, j + 1));
        } catch (err) {
          return null;
        }
      }
    }
    return null;
  }

  /** Board slugs worth trying for a firm whose site doesn't say ("GSA Capital" → gsacapital, gsa-capital…). */
  function guessSlugs(firm) {
    const full = normName(firm.name);
    const core = coreName(firm.name);
    const words = full.split(' ').filter(Boolean);
    const out = [words.join(''), words.join('-')];
    // "GSA Capital Partners" → gsacapital: boards are often named without the last word or two.
    for (let k = words.length - 1; k >= 2; k--) out.push(words.slice(0, k).join(''));
    out.push(core.replace(/ /g, ''), (firm.domain || '').split('.')[0]);
    // A guess shorter than 5 letters is somebody else's board more often than not ("gsa", "man").
    return [...new Set(out)].filter((s) => s && s.length >= 5).slice(0, 5);
  }

  // Boards that answer for any name, so a guess there proves nothing.
  const GUESSABLE = ['greenhouse', 'lever', 'ashby', 'workable'];

  /** Does a board (reached by guessing its slug) belong to the firm? */
  function boardIsFirm(b, res, firm) {
    const name = boardName(b, res && res.json);
    if (name) return sameFirm(name, firm.name) || firm.aliases.some((a) => sameFirm(name, a));
    // No name to compare: the slug must spell the whole name (not just its first word).
    const whole = normName(firm.name).replace(/ /g, '');
    const slug = String(b.slug || '')
      .toLowerCase()
      .replace(/[-_]/g, '');
    return slug.length >= 8 && (slug === whole || slug === U.normalize(firm.name).replace(/ /g, ''));
  }

  /* ------------------------------------------------------ programme pages */

  const MONTHS =
    'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
  const DATE = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTHS})\\.?(?:,?\\s+(20\\d\\d))?\\b|\\b(${MONTHS})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d\\d))?\\b`,
    'i',
  );
  const DEADLINE =
    /\b(deadline|closing date|closes?|apply by|applications? (close|due|must be received)|by (mon|tues|wednes|thurs|fri|satur|sun)day|no later than|submit[^.]{0,80}\bby\b)/i;
  const PROGRAMME =
    /\b(intern(ship)?s?|summer (analyst|associate|programme|program)|off[- ]cycle|insight (day|week|programme|program)|spring (week|programme|program)|graduate (programme|program|scheme|role)|placement)\b/i;

  /** A deadline in a sentence as YYYY-MM-DD (the next such date after `now` when no year is given), or null. */
  function deadlineIn(sentence, now) {
    const m = String(sentence).match(DATE);
    if (!m) return null;
    const day = +(m[1] || m[5]);
    const monName = (m[2] || m[4]).slice(0, 3).toLowerCase();
    const month = 'janfebmaraprmayjunjulaugsepoctnovdec'.indexOf(monName) / 3 + 1;
    if (!month || day < 1 || day > 31) return null;
    let year = +(m[3] || m[6]) || 0;
    const today = new Date(now);
    if (!year) {
      year = today.getFullYear();
      if (
        new Date(Date.UTC(year, month - 1, day)) <
        new Date(Date.UTC(year, today.getMonth(), today.getDate()) - 864e5 * 30)
      )
        year++;
    }
    return `${year}-${U.pad2(month)}-${U.pad2(day)}`;
  }

  /**
   * What a plain careers page says about student programmes (for firms without a job board, like a
   * "2027 Summer Internship Programme… email your CV by Friday 6th November" page): sentences that name a
   * programme and either a current or next year or a deadline. [{ text, deadline, year }]
   */
  function programmesFromText(text, now = Date.now()) {
    const year = new Date(now).getFullYear();
    const sentences = String(text || '')
      .split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9“"])|\s•\s/)
      .map((x) => x.replace(/\s+/g, ' ').replace(/^•\s*/, ''));
    const out = [];
    const seen = new Set();
    for (const raw of sentences) {
      const s = raw.trim();
      if (s.length < 20 || s.length > 400 || !PROGRAMME.test(s)) continue;
      if (
        /\binternal\b|\binternational\b/i.test(s) &&
        !/\bintern(ship)?s?\b/i.test(s.replace(/internal|international/gi, ''))
      )
        continue;
      const years = (s.match(/\b20\d\d\b/g) || []).map(Number);
      const current = years.some((y) => y >= year && y <= year + 2);
      const deadline = DEADLINE.test(s) ? deadlineIn(s, now) : null;
      const past = years.length && years.every((y) => y < year);
      if (past || !(current || deadline)) continue;
      const key = s.toLowerCase().slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ text: s, deadline, year: years.find((y) => y >= year) || null });
    }
    // "Send your CV to … by Friday 6th November" rarely names the programme, but it is the deadline for it.
    if (out.length && !out.some((p) => p.deadline)) {
      for (const raw of sentences) {
        const s = raw.trim();
        if (s.length > 400 || !DEADLINE.test(s)) continue;
        const deadline = deadlineIn(s, now);
        if (deadline && deadline >= new Date(now).toISOString().slice(0, 10)) {
          out.unshift({ text: s, deadline, year: +deadline.slice(0, 4) });
          break;
        }
      }
    }
    return out.slice(0, 8);
  }

  /** Addresses for applying by email, Cloudflare's hidden ones decoded ("/cdn-cgi/l/email-protection#…"). */
  function emails(html) {
    const out = new Set();
    const s = String(html || '');
    for (const m of decode(s).matchAll(/mailto:([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/gi)) out.add(m[1].toLowerCase());
    for (const m of s.matchAll(/(?:data-cfemail="|email-protection#)([\da-f]{8,})/gi)) {
      const hex = m[1];
      const key = parseInt(hex.slice(0, 2), 16);
      let e = '';
      for (let i = 2; i < hex.length; i += 2) e += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
      if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(e)) out.add(e.toLowerCase());
    }
    return [...out]
      .filter((e) => /career|recruit|job|grad|intern|hr|people|talent|student|apply|join/i.test(e))
      .slice(0, 3);
  }

  /** Does a page look like this firm's, not a parked domain or someone else's? */
  function pageIsFirm(html, firm) {
    const s = String(html || '');
    if (s.length < 300) return false;
    if (
      /domain (is )?for sale|buy this domain|parked (free|domain)|this domain may be for sale|sedoparking|hugedomains/i.test(
        s,
      )
    )
      return false;
    const title = textOf((s.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
    const head = normName(title + ' ' + textOf(s.slice(0, 200000)).slice(0, 20000));
    const core = coreName(firm.name);
    if (!core) return false;
    return core
      .split(' ')
      .every((w) => w.length < 2 || new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(head));
  }

  /**
   * Everything the firm's careers pages show for students: boards found on its site (or guessed and proved to
   * be its), the student roles on them, and programme sentences on plain pages.
   * status: 'roles' (student roles open) · 'programme' (a programme page, no board) · 'board' (a board, no
   * student roles now) · 'page' (a careers page, nothing for students) · 'none' (no careers page found) ·
   * 'blocked' (the site turns robots away) · 'unreachable'.
   */
  async function careers(firm, { fetch: fetchFn, now = Date.now(), guess = true, all = false } = {}) {
    const log = [];
    const result = {
      status: 'none',
      site: firm.site || '',
      pages: [],
      boards: [],
      roles: [],
      other: 0,
      programmes: [],
      emails: [],
      log,
    };
    let site = firm.site;
    if (!site && firm.qid) site = await wikidataSite(firm.qid, { fetch: fetchFn });
    result.site = site || '';
    const boards = [];
    const addBoards = (list) => {
      for (const b of list) {
        // A Phenom site is one board, however many of its resources a page loads.
        const same = (x) =>
          x.ats === b.ats && (b.ats === 'phenom' || (x.slug === b.slug && (x.site || '') === (b.site || '')));
        if (!boards.some(same)) boards.push(b);
      }
    };
    const pageTexts = [];
    if (site) {
      let home = await get(fetchFn, site + '/');
      // Some firms only answer on www. (or only without it).
      if (!home.ok && !home.blocked) {
        const u = parseUrl(site);
        const other = u.hostname.startsWith('www.') ? u.hostname.slice(4) : 'www.' + u.hostname;
        const again = await get(fetchFn, `https://${other}/`, { retries: 0 });
        if (again.ok) home = again;
      }
      log.push({
        url: site + '/',
        outcome: home.ok ? 'home page' : home.blocked ? 'blocked' : `failed: ${home.status || home.error}`,
      });
      if (home.blocked) result.status = 'blocked';
      else if (!home.ok) result.status = 'unreachable';
      let candidates = [];
      if (home.ok) {
        if (!pageIsFirm(home.text, firm)) log.push({ url: home.url, outcome: 'doesn’t name the firm' });
        addBoards(detectBoards(home.text, home.url));
        candidates = careerLinks(home.text, home.url, domainOf(home.url) || firm.domain).map((l) => l.url);
      }
      // Sites without a careers link (or a menu built by script) usually still have /careers/.
      if (home.ok || home.status === 404) {
        const origin = parseUrl(home.url || site).origin;
        for (const p of CAREER_PATHS) candidates.push(origin + p);
      }
      const visited = new Set();
      const queue = [...new Set(candidates)];
      let fetched = 0;
      while (queue.length && fetched < 6) {
        const url = queue.shift();
        const key = url.replace(/\/+$/, '').toLowerCase();
        if (visited.has(key)) continue;
        visited.add(key);
        // A link to a job board names the board: no need to load it.
        const linked = detectBoards(url, url).filter((b) => boardRequest(b));
        if (ATS_DOMAIN.test(domainOf(url)) && linked.length) {
          addBoards(linked);
          continue;
        }
        const guessed = CAREER_PATHS.some((p) => url.endsWith(p));
        // Guessed paths only until one answers.
        if (guessed && result.pages.length) continue;
        fetched++;
        const r = await get(fetchFn, url, { retries: 0, timeout: 15000 });
        if (!r.ok || r.blocked) {
          if (!guessed) log.push({ url, outcome: r.blocked ? 'blocked' : `failed: ${r.status || r.error}` });
          continue;
        }
        // A guessed path that lands back on the home page isn't a careers page.
        if (guessed && parseUrl(r.url) && parseUrl(r.url).pathname.replace(/\/+$/, '') === '') continue;
        log.push({ url: r.url, outcome: 'careers page' });
        result.pages.push(r.url);
        addBoards(detectBoards(r.text, r.url));
        result.emails.push(...emails(r.text));
        pageTexts.push(pageText(r.text));
        // One level deeper: "Students", "Internships", "Open positions".
        if (!ATS_DOMAIN.test(domainOf(r.url))) {
          for (const l of careerLinks(r.text, r.url, domainOf(r.url) || firm.domain).slice(0, 4))
            if (!visited.has(l.url.replace(/\/+$/, '').toLowerCase())) queue.push(l.url);
        }
      }
    }
    // Pages on a board's own host (careers.brevanhoward.com) are the board.
    for (const b of boards) {
      if (b.ats === 'phenom' && b.url) {
        const u = parseUrl(b.url);
        b.host = u.host;
        b.locale = (u.pathname.match(/^\/[a-z]{2}\/[a-z]{2}(?=\/|$)/) || [''])[0];
      }
      if (b.ats === 'oleeo' && b.url && !/tal\.net/.test(b.url)) {
        const page = result.pages.find(Boolean);
        b.url = page && /tal\.net/.test(page) ? page : `https://${b.host}/vx/candidate/jobboard/vacancy/1/adv/`;
      }
    }
    // Nothing on the site: try the boards most firms like these use, and keep a board only if it is the firm's.
    if (guess && !boards.some((b) => boardRequest(b))) {
      for (const slug of guessSlugs(firm)) {
        for (const ats of GUESSABLE) {
          const b = { ats, slug, found: 'guessed' };
          const req = boardRequest(b);
          const r = await get(fetchFn, req.url, { json: true, retries: 0, timeout: 12000 });
          if (!r.ok || !r.json) continue;
          if (!boardIsFirm(b, r, firm)) {
            log.push({ url: req.url, outcome: 'someone else’s board' });
            continue;
          }
          log.push({ url: req.url, outcome: `${ats} board (by name)` });
          b.cached = r;
          boards.push(b);
          break;
        }
        if (boards.length) break;
      }
    }
    // List each board that has an API.
    let jobs = [];
    for (const b of boards) {
      const req = boardRequest(b);
      if (!req) continue;
      const responses = [];
      if (b.cached) responses.push(b.cached);
      else if (req.searches) {
        for (const searchText of req.searches) {
          const r = await get(fetchFn, req.url, { ...req, body: { ...req.body, searchText }, retries: 1 });
          if (r.ok) responses.push(r);
        }
      } else {
        const r = await get(fetchFn, req.url, { ...req, retries: 1 });
        if (r.ok) responses.push(r);
        else log.push({ url: req.url, outcome: `board failed: ${r.status || r.error}` });
      }
      delete b.cached;
      b.jobs = 0;
      for (const r of responses) {
        const list = parseBoard(b, r);
        b.jobs += list.length;
        jobs.push(...list);
      }
      if (responses.length) log.push({ url: req.url, outcome: `${b.ats}: ${b.jobs} job${b.jobs === 1 ? '' : 's'}` });
    }
    const seen = new Set();
    jobs = jobs.filter((j) => !seen.has(j.url) && seen.add(j.url));
    result.boards = boards.map(({ ats, slug, host, site: s, locale, url, found, jobs: n }) => ({
      ats,
      slug,
      host,
      site: s,
      locale,
      url,
      found,
      jobs: n,
    }));
    result.roles = jobs.map((j) => ({ ...j, kind: roleKind(j.title) })).filter((j) => all || j.kind);
    result.other = jobs.length - result.roles.filter((r) => r.kind).length;
    result.emails = [...new Set(result.emails)];
    result.programmes = programmesFromText(pageTexts.join(' \n '), now).map((p) => ({
      ...p,
      text: p.text.replace(/\[email(?:\s|&#160;|&nbsp;)+protected\]/gi, result.emails[0] || 'the address on the page'),
    }));
    if (result.roles.length) result.status = 'roles';
    else if (result.programmes.length) result.status = 'programme';
    else if (boards.length) result.status = 'board';
    else if (result.pages.length) result.status = 'page';
    return result;
  }

  /* ------------------------------------------------------------ watchlist */

  /** A stable key for a role or programme, for telling new ones from ones already seen. */
  function itemKey(item) {
    if (item.url && item.title) return 'r:' + item.url.replace(/[?#].*$/, '').toLowerCase();
    return 'p:' + U.normalize(item.text || '').slice(0, 120);
  }

  /**
   * Re-check a watched firm. entry: { firm, boards, pages, seen: [key] }. The known boards and pages are
   * fetched directly (no crawl), so a check is a handful of requests. fresh: keys not in entry.seen.
   */
  async function check(entry, { fetch: fetchFn, now = Date.now() } = {}) {
    const firm = entry.firm;
    const known = (entry.boards || []).filter((b) => boardRequest(b));
    let res;
    if (known.length || (entry.pages || []).length) {
      res = { status: 'none', roles: [], programmes: [], log: [] };
      for (const b of known) {
        const req = boardRequest(b);
        const searches = req.searches || [null];
        for (const searchText of searches) {
          const r = await get(fetchFn, req.url, {
            ...req,
            body: req.body ? { ...req.body, searchText: searchText || '' } : undefined,
            retries: 1,
          });
          res.log.push({ url: req.url, outcome: r.ok ? 'ok' : `failed: ${r.status || r.error}` });
          if (r.ok)
            res.roles.push(
              ...parseBoard(b, r)
                .map((j) => ({ ...j, kind: roleKind(j.title) }))
                .filter((j) => j.kind),
            );
        }
      }
      const texts = [];
      for (const url of (entry.pages || []).slice(0, 3)) {
        const r = await get(fetchFn, url, { retries: 1 });
        res.log.push({ url, outcome: r.ok ? 'ok' : `failed: ${r.status || r.error}` });
        if (r.ok) texts.push(pageText(r.text));
      }
      res.programmes = programmesFromText(texts.join(' \n '), now);
      const failed = res.log.every((l) => l.outcome !== 'ok');
      res.status = failed ? 'unreachable' : res.roles.length ? 'roles' : res.programmes.length ? 'programme' : 'quiet';
    } else {
      res = await careers(firm, { fetch: fetchFn, now });
    }
    const seenRole = new Set();
    res.roles = res.roles.filter((r) => !seenRole.has(r.url) && seenRole.add(r.url));
    const keys = [...res.roles.map(itemKey), ...res.programmes.map(itemKey)];
    const seen = new Set(entry.seen || []);
    // The first check sets the baseline: nothing is "new" on the day you start watching.
    const fresh = entry.seen ? keys.filter((k) => !seen.has(k)) : [];
    return { ...res, keys, fresh, checkedAt: now };
  }

  /* ------------------------------------------------------------------ AI */

  /**
   * Ask the AI for more firms like the query, then keep only those that check out: in the registry, or with
   * a website that names them plus an SEC registration or a Wikipedia article. chat: (messages, options) →
   * { json }. Returns { found: [{ firm, reasons, why }], rejected: [{ name, why }] }.
   */
  async function suggest(chat, query, firms, { fetch: fetchFn, exclude = [], signal, max = 20 } = {}) {
    const q = query || {};
    const niches = (q.niches || []).map((n) => (NICHES[n] ? NICHES[n].label : n)).join(', ') || 'finance';
    const place = (PLACES[q.place] || PLACES.any).label;
    const size = (SIZES[q.size] || SIZES.any).label;
    const seeds = (q.seedNames || []).join(', ');
    const { json } = await chat(
      [
        {
          role: 'system',
          content:
            'You help a student find internships at reputable but low-profile firms: well-regarded, regulated, often decades old, but small and rarely advertised (think HBK, Lansdowne Partners, Egerton Capital, Robey Warshaw, not Goldman Sachs or Citadel). ' +
            'Only name firms you are confident exist today, with their real website domain. Never invent a firm or a domain; fewer, real names are better. ' +
            'Leave out household names and anyone listed in "already known". ' +
            'Reply with JSON only: {"firms":[{"name":"","website":"example.com","city":"","why":"under 15 words"}]}',
        },
        {
          role: 'user',
          content:
            `Kind of firm: ${niches}\nWhere: ${place}\nSize: ${size}\n` +
            (seeds ? `Similar to: ${seeds}\n` : '') +
            (q.text ? `Also: ${q.text}\n` : '') +
            `Already known (don't repeat): ${exclude.slice(0, 80).join('; ')}\n` +
            `Up to ${max} firms.`,
        },
      ],
      { json: true, temperature: 0.3, maxTokens: 2500, signal },
    );
    const ideas = (json && Array.isArray(json.firms) ? json.firms : []).slice(0, max);
    const found = [];
    const rejected = [];
    await pool(ideas, 3, async (idea) => {
      const name = String((idea && idea.name) || '')
        .trim()
        .slice(0, 120);
      if (!name) return;
      const why = String(idea.why || '').slice(0, 160);
      const known = lookup(firms, idea.website) || lookup(firms, name);
      if (known) {
        found.push({ firm: known, reasons: ['In the registry'], why });
        return;
      }
      const v = await verify({ name, website: idea.website, city: idea.city }, { fetch: fetchFn });
      if (v.firm) found.push({ firm: v.firm, reasons: v.reasons, why });
      else rejected.push({ name, why: v.why });
    });
    return { found, rejected };
  }

  /**
   * Prove a firm the registry doesn't know exists: its website must load and name it, and an independent
   * record (an active SEC registration or a Wikipedia article about a firm) must agree. { firm, reasons } or { why }.
   */
  async function verify(idea, { fetch: fetchFn } = {}) {
    const site = siteOf(idea.website || '');
    const stub = {
      name: idea.name,
      aliases: [],
      domain: domainOf(site),
      site,
      cities: idea.city ? [idea.city] : [],
      country: '',
      tags: [],
    };
    const [home, sec, wiki] = await Promise.all([
      site ? get(fetchFn, site + '/', { retries: 1 }) : Promise.resolve(null),
      secFind(idea.name, { fetch: fetchFn }).catch(() => null),
      wikiFind(idea.name, { fetch: fetchFn }).catch(() => null),
    ]);
    const reasons = [];
    const siteOk = !!(home && home.ok && pageIsFirm(home.text, stub));
    if (siteOk) reasons.push(`${stub.domain} names the firm`);
    if (sec) reasons.push(`SEC-registered (${[sec.city, sec.country].filter(Boolean).join(', ') || 'active'})`);
    if (wiki) reasons.push('Wikipedia article');
    let finalSite = siteOk ? site : '';
    if (!finalSite && wiki && wiki.qid) finalSite = await wikidataSite(wiki.qid, { fetch: fetchFn });
    if (!(sec || wiki))
      return {
        why:
          site && !siteOk
            ? `${stub.domain || 'its website'} doesn’t load or doesn’t name it, and no registry knows it`
            : 'no SEC registration or Wikipedia article found',
      };
    if (!finalSite) return { why: 'no working website found' };
    if (!siteOk && finalSite) reasons.push('website from Wikidata');
    return {
      firm: {
        ...stub,
        id: sec && sec.crd ? 'crd:' + sec.crd : wiki && wiki.qid ? 'wd:' + wiki.qid : 'd:' + domainOf(finalSite),
        site: finalSite,
        domain: domainOf(finalSite),
        crd: (sec && sec.crd) || null,
        wiki: wiki ? wiki.title : null,
        qid: wiki ? wiki.qid : null,
        employees: null,
        aum: null,
        funds: null,
        source: 'ai',
        verified: reasons,
      },
      reasons,
    };
  }

  const discover = {
    NICHES,
    SIZES,
    PLACES,
    TRACKR_API,
    roleKind,
    normName,
    coreName,
    sameFirm,
    domainOf,
    siteOf,
    firmFrom,
    loadFirms,
    lookup,
    standing,
    onList,
    search,
    similarTo,
    get,
    pool,
    trackrCompanies,
    wikiSimilar,
    wikiFind,
    wikidataSite,
    secFind,
    links,
    careerLinks,
    detectBoards,
    boardRequest,
    parseBoard,
    phenomData,
    guessSlugs,
    boardIsFirm,
    programmesFromText,
    deadlineIn,
    emails,
    pageIsFirm,
    careers,
    itemKey,
    check,
    suggest,
    verify,
  };
  JTF.discover = discover;
  if (typeof module === 'object' && module.exports) module.exports = discover;
})(typeof globalThis !== 'undefined' ? globalThis : this);
