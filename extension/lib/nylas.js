/*
 * JobToFill — reads your recent email through Nylas (https://www.nylas.com), so verification codes can
 * be filled in for you. Uses the Nylas v3 API with your own API key and the grant (connected inbox) you
 * choose. Read-only: it lists the last few messages and never sends, moves or marks anything.
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});

  const REGIONS = {
    us: { label: 'United States', base: 'https://api.us.nylas.com' },
    eu: { label: 'Europe', base: 'https://api.eu.nylas.com' },
  };
  const TIMEOUT = 20000;

  class NylasError extends Error {
    constructor(message, { status, code } = {}) {
      super(message);
      this.name = 'NylasError';
      this.status = status;
      this.code = code || null;
    }
  }

  const baseOf = (config) => (REGIONS[config && config.region] || REGIONS.us).base;

  function problem(config) {
    if (!config || !String(config.apiKey || '').trim()) return 'Add your Nylas API key first.';
    return null;
  }

  function explain(status, body) {
    const detail = String((body && body.error && (body.error.message || body.error.type)) || '').slice(0, 200);
    if (status === 401 || status === 403)
      return new NylasError('Nylas rejected the API key (or it belongs to the other region).', { status, code: 'key' });
    if (status === 404)
      return new NylasError('Nylas doesn’t know that inbox (grant). Connect again.', { status, code: 'grant' });
    if (status === 429)
      return new NylasError('Nylas is rate-limiting requests. Trying again shortly.', { status, code: 'rate' });
    if (status >= 500) return new NylasError(`Nylas had a problem (${status}).`, { status, code: 'server' });
    return new NylasError(`Nylas returned an error (${status})${detail ? ': ' + detail : ''}`, { status });
  }

  async function get(config, path, params, fetchImpl) {
    const bad = problem(config);
    if (bad) throw new NylasError(bad, { code: 'setup' });
    const url = new URL(baseOf(config) + path);
    for (const [k, v] of Object.entries(params || {})) if (v != null && v !== '') url.searchParams.set(k, String(v));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    let res;
    try {
      res = await (fetchImpl || root.fetch.bind(root))(url.href, {
        headers: { Authorization: `Bearer ${String(config.apiKey).trim()}`, Accept: 'application/json' },
        credentials: 'omit',
        signal: controller.signal,
      });
    } catch (err) {
      throw new NylasError(`Couldn’t reach Nylas (${(err && err.message) || err}).`, { code: 'network' });
    } finally {
      clearTimeout(timer);
    }
    const raw = await res.text();
    let data;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch (err) {
      data = null;
    }
    if (!res.ok) throw explain(res.status, data);
    return data || {};
  }

  /** The inboxes connected to this Nylas app: [{ id, email, provider, status }]. */
  async function grants(config, { fetch: fetchImpl } = {}) {
    const data = await get(config, '/v3/grants', { limit: 50 }, fetchImpl);
    return (data.data || []).map((g) => ({
      id: g.id,
      email: g.email || '',
      provider: g.provider || '',
      status: g.grant_status || '',
    }));
  }

  /**
   * Messages received since `since` (ms), newest first: [{ id, subject, from, date, body, snippet }].
   * `date` is in seconds, as Nylas gives it.
   */
  async function messages(config, { since, limit = 15, fetch: fetchImpl } = {}) {
    if (!config || !config.grantId) throw new NylasError('Choose which inbox to read first.', { code: 'setup' });
    const params = {
      limit,
      received_after: since ? Math.floor(since / 1000) : null,
      select: 'id,subject,from,date,body,snippet',
    };
    const path = `/v3/grants/${encodeURIComponent(config.grantId)}/messages`;
    let data;
    try {
      data = await get(config, path, params, fetchImpl);
    } catch (err) {
      // Older API versions don't take "select": ask again without it.
      if (!(err.status === 400 && /select/i.test(err.message))) throw err;
      delete params.select;
      data = await get(config, path, params, fetchImpl);
    }
    return (data.data || []).map((m) => ({
      id: m.id,
      subject: m.subject || '',
      from: m.from || [],
      date: m.date || 0,
      body: m.body || '',
      snippet: m.snippet || '',
    }));
  }

  const nylas = { REGIONS, NylasError, problem, grants, messages };
  JTF.nylas = nylas;
  if (typeof module === 'object' && module.exports) module.exports = nylas;
})(typeof globalThis !== 'undefined' ? globalThis : this);
