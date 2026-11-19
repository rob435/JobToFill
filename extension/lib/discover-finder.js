/*
 * JobToFill — Discover's address checks. Whether a firm's domain takes email at all (its MX records, looked up through
 * DNS over HTTPS: free, no key, and only the domain's name is sent), and, with the person's own Hunter.io key, the
 * addresses Hunter has seen on the web for a domain (with the pages it saw them on and the firm's address format), the
 * likeliest address for a named person, and a mailbox check of one address (does the mail server say it exists?).
 * Pure logic plus fetches through an injected fetch: it runs in extension pages and in Node tests.
 *
 *   mx(domain, { fetch })                         → { ok, hosts: [host], error? }   (ok: the domain takes mail)
 *   hunter.domain(key, domain, { fetch, departments }) → { pattern, acceptAll, organization, emails: [{ address,
 *                                                     name, title, department, seniority, confidence, kind, sources,
 *                                                     status }] }
 *   hunter.find(key, { domain, name }, { fetch })  → { address, score, status, sources } or null
 *   hunter.verify(key, address, { fetch })         → { status: 'valid'|'invalid'|'accept_all'|'unknown'|…, score }
 *   hunter.account(key, { fetch })                 → { searches: { used, available }, verifications: { … } }
 *   verdict({ listed, mx, check, guessed })         → { level: 'verified'|'listed'|'likely'|'unconfirmed'|'bad', text }
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});

  const TIMEOUT = 15000;
  const DOH = [
    (d) => `https://dns.google/resolve?name=${encodeURIComponent(d)}&type=MX`,
    (d) => `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(d)}&type=MX`,
  ];
  const HUNTER = 'https://api.hunter.io/v2';

  class FinderError extends Error {
    constructor(message, { status, code } = {}) {
      super(message);
      this.name = 'FinderError';
      this.status = status;
      this.code = code || null;
    }
  }

  /** GET a JSON document with a time limit: { ok, status, data } (data null when it isn't JSON). */
  async function getJson(fetchFn, url, headers) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    try {
      const res = await (fetchFn || root.fetch.bind(root))(url, {
        headers: { Accept: 'application/json', ...(headers || {}) },
        credentials: 'omit',
        signal: controller.signal,
      });
      const raw = await res.text();
      let data = null;
      try {
        data = raw ? JSON.parse(raw) : null;
      } catch (err) {
        data = null;
      }
      return { ok: res.ok, status: res.status, data };
    } catch (err) {
      return { ok: false, status: 0, data: null, error: (err && err.message) || String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  /* -------------------------------------------------------------------- MX */

  const mxCache = new Map();

  /**
   * Does the domain take email? Its MX records through DNS over HTTPS (Google's resolver, then Cloudflare's).
   * { ok: true, hosts } when it has a mail server; { ok: false, hosts: [] } when it has none (a dead or parked
   * domain: an address there bounces); { ok: null, error } when neither resolver answered.
   */
  async function mx(domain, { fetch: fetchFn } = {}) {
    const d = String(domain || '')
      .toLowerCase()
      .replace(/^.*@/, '')
      .replace(/^www\./, '')
      .trim();
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) return { ok: false, hosts: [], error: 'not a domain' };
    if (mxCache.has(d)) return mxCache.get(d);
    let last = '';
    for (const url of DOH) {
      const r = await getJson(fetchFn, url(d), { Accept: 'application/dns-json' });
      if (!r.ok || !r.data || typeof r.data.Status !== 'number') {
        last = r.error || `status ${r.status}`;
        continue;
      }
      // NXDOMAIN (3): the domain doesn't exist. A domain with no MX takes mail at its A record only in theory.
      const hosts = (r.data.Answer || [])
        .filter((a) => a.type === 15)
        .map((a) =>
          String(a.data || '')
            .split(/\s+/)
            .pop()
            .replace(/\.$/, ''),
        )
        // "0 ." is a null MX: the domain says it takes no mail.
        .filter((h) => h && h !== '.');
      const out = { ok: hosts.length > 0, hosts };
      mxCache.set(d, out);
      return out;
    }
    return { ok: null, hosts: [], error: last };
  }

  /* ---------------------------------------------------------------- Hunter */

  /** What went wrong with Hunter, in words a person can act on. */
  function hunterError(r) {
    const e = (r.data && r.data.errors && r.data.errors[0]) || {};
    const said = String(e.details || e.code || '').slice(0, 160);
    if (r.status === 401) return new FinderError('Hunter rejected the API key.', { status: 401, code: 'key' });
    if (r.status === 429)
      return new FinderError('Hunter says this month’s free searches or checks are used up (or too many at once).', {
        status: 429,
        code: 'quota',
      });
    if (r.status === 451)
      return new FinderError('Hunter won’t look this person up (they asked to be left out).', {
        status: 451,
        code: 'claimed',
      });
    if (!r.status) return new FinderError(`Couldn’t reach Hunter (${r.error || 'network'}).`, { code: 'network' });
    return new FinderError(`Hunter returned an error (${r.status})${said ? `: ${said}` : ''}`, { status: r.status });
  }

  async function hunterGet(key, path, params, fetchFn) {
    if (!String(key || '').trim()) throw new FinderError('Add your Hunter API key first.', { code: 'setup' });
    const url = new URL(HUNTER + path);
    for (const [k, v] of Object.entries(params || {})) if (v != null && v !== '') url.searchParams.set(k, String(v));
    // The key goes in a header, not the address, so it never sits in a log of URLs.
    const r = await getJson(fetchFn, url.href, { 'X-API-KEY': String(key).trim() });
    if (!r.ok) throw hunterError(r);
    return Object.assign((r.data && r.data.data) || {}, { _status: r.status });
  }

  /** Hunter's "{first}.{last}" as discover-contacts' 'first.last' ('' for one it doesn't spell the same way). */
  function patternFrom(p) {
    const s = String(p || '')
      .toLowerCase()
      .replace(/\s+/g, '');
    const map = {
      '{first}.{last}': 'first.last',
      '{first}': 'first',
      '{f}{last}': 'flast',
      '{first}{l}': 'firstl',
      '{first}_{last}': 'first_last',
      '{f}.{last}': 'f.last',
      '{last}': 'last',
      '{first}-{last}': 'first-last',
    };
    return map[s] || '';
  }

  const sourcesOf = (list) =>
    (list || [])
      .slice(0, 5)
      .map((s) => ({ url: s.uri || '', domain: s.domain || '', seen: s.last_seen_on || '', still: !!s.still_on_page }));
  const fullName = (e) => [e.first_name, e.last_name].filter(Boolean).join(' ');
  const statusOf = (v) => (v && v.status) || '';

  /**
   * The addresses Hunter has seen on the web for a domain, people's first (each with the pages it was seen on), and
   * the domain's format. departments: Hunter's names ('executive', 'hr', 'it', 'management', 'finance'…), all when
   * empty. Hunter's free plan has 50 credits a month and charges by addresses returned, so five at most by default.
   */
  async function hunterDomain(key, domain, { fetch: fetchFn, departments = [], limit = 5 } = {}) {
    const data = await hunterGet(
      key,
      '/domain-search',
      { domain, limit, department: departments.join(','), type: '' },
      fetchFn,
    );
    return {
      domain: data.domain || domain,
      pattern: patternFrom(data.pattern),
      rawPattern: data.pattern || '',
      acceptAll: !!data.accept_all,
      organization: data.organization || '',
      emails: (data.emails || []).map((e) => ({
        address: String(e.value || '').toLowerCase(),
        name: fullName(e),
        title: e.position || '',
        department: e.department || '',
        seniority: e.seniority || '',
        confidence: e.confidence || 0,
        kind: e.type === 'generic' ? 'mailbox' : 'person',
        linkedin: e.linkedin || '',
        sources: sourcesOf(e.sources),
        status: statusOf(e.verification),
      })),
    };
  }

  /** The likeliest address for a named person at a domain (Hunter's email finder): null when it has none. */
  async function hunterFind(key, { domain, name, first, last }, { fetch: fetchFn } = {}) {
    const params = { domain };
    if (first && last) Object.assign(params, { first_name: first, last_name: last });
    else params.full_name = name;
    const data = await hunterGet(key, '/email-finder', params, fetchFn);
    if (!data.email) return null;
    return {
      address: String(data.email).toLowerCase(),
      score: data.score || 0,
      acceptAll: !!data.accept_all,
      status: statusOf(data.verification),
      sources: sourcesOf(data.sources),
    };
  }

  /**
   * A mailbox check of one address: Hunter asks the firm's mail server, among other things. A slow server answers 202
   * (still checking): asked again a few seconds later, twice at most.
   */
  async function hunterVerify(key, address, { fetch: fetchFn, wait = 3000 } = {}) {
    let data = await hunterGet(key, '/email-verifier', { email: address }, fetchFn);
    for (let i = 0; i < 2 && data._status === 202; i++) {
      await new Promise((r) => setTimeout(r, wait));
      data = await hunterGet(key, '/email-verifier', { email: address }, fetchFn);
    }
    return {
      status: data.status || 'unknown',
      result: data.result || '',
      score: data.score || 0,
      acceptAll: !!data.accept_all,
      smtp: !!data.smtp_check,
      sources: sourcesOf(data.sources),
    };
  }

  /** What's left of this month's Hunter allowance. */
  async function hunterAccount(key, { fetch: fetchFn } = {}) {
    const data = await hunterGet(key, '/account', {}, fetchFn);
    const req = data.requests || {};
    return {
      email: data.email || '',
      plan: data.plan_name || '',
      searches: req.searches || { used: 0, available: 0 },
      verifications: req.verifications || { used: 0, available: 0 },
    };
  }

  /* --------------------------------------------------------------- verdict */

  /**
   * How far an address can be trusted, in one word and a line for the card:
   *   bad         its domain takes no mail, or a mailbox check says it doesn't exist;
   *   verified    a mailbox check says it exists;
   *   listed      printed on the firm's site or another page (and the domain takes mail);
   *   likely      made from a confirmed format, on a domain that takes mail (a server that takes every address can't
   *               say more);
   *   unconfirmed anything else.
   * listed: the page it's printed on, or ''; mx: mx(); check: hunter.verify() or null; guessed: made from a format.
   */
  function verdict({ listed, mx: m, check, guessed } = {}) {
    if (m && m.ok === false) return { level: 'bad', text: 'The domain takes no email' };
    if (check && check.status === 'invalid') return { level: 'bad', text: 'Mailbox check: no such address' };
    if (check && check.status === 'valid') return { level: 'verified', text: 'Mailbox check: it exists' };
    if (listed) return { level: 'listed', text: m && m.ok ? 'Published, and the domain takes email' : 'Published' };
    const acceptAll = check && check.status === 'accept_all';
    if (guessed && m && m.ok)
      return {
        level: 'likely',
        text: acceptAll
          ? 'From the firm’s format; its server accepts every address, so a check can’t say more'
          : 'From the firm’s format, and the domain takes email',
      };
    return { level: 'unconfirmed', text: 'Not confirmed' };
  }

  const hunter = { domain: hunterDomain, find: hunterFind, verify: hunterVerify, account: hunterAccount, patternFrom };
  const discoverFinder = { FinderError, mx, hunter, verdict };
  JTF.discoverFinder = discoverFinder;
  if (typeof module === 'object' && module.exports) module.exports = discoverFinder;
})(typeof globalThis !== 'undefined' ? globalThis : this);
