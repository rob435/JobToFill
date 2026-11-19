/*
 * JobToFill — your email through Nylas (https://www.nylas.com), with your own API key and the grant (connected
 * inbox) you choose, on the Nylas v3 API. For verification codes it only reads: the last few messages, never moving
 * or marking anything. Discover's outreach can also save an email you wrote to your mailbox's drafts or send it,
 * your CV attached, but only when you press that button for that one email.
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

  // What Nylas (or Google and Microsoft behind it) says when the inbox was connected to read mail only.
  const SCOPE = /scope|permission|insufficient|not authori[sz]ed|forbidden|access_denied/i;

  function explain(status, body, writing) {
    const detail = String((body && body.error && (body.error.message || body.error.type)) || '').slice(0, 200);
    // A key that reads mail but can't send it: the inbox was connected with read-only access.
    if (writing && (status === 403 || (status === 400 && SCOPE.test(detail))) && SCOPE.test(detail || 'forbidden'))
      return new NylasError(
        'Your inbox is connected to Nylas for reading only. Connect it again with permission to send and draft mail (Settings › Email codes).',
        { status, code: 'scope' },
      );
    if (status === 401 || status === 403)
      return new NylasError('Nylas rejected the API key (or it belongs to the other region).', { status, code: 'key' });
    if (status === 404)
      return new NylasError('Nylas doesn’t know that inbox (grant). Connect again.', { status, code: 'grant' });
    if (status === 429)
      return new NylasError('Nylas is rate-limiting requests. Trying again shortly.', { status, code: 'rate' });
    if (status === 413)
      return new NylasError('The email and its attachment are too large for Nylas.', { status, code: 'size' });
    if (status >= 500) return new NylasError(`Nylas had a problem (${status}).`, { status, code: 'server' });
    return new NylasError(`Nylas returned an error (${status})${detail ? ': ' + detail : ''}`, { status });
  }

  /**
   * One call to Nylas: GET with query `params`, or POST with a JSON `body` or a multipart `form`. The time limit
   * covers the body too: a reply that stalls after its headers would otherwise hang the code watcher.
   */
  async function request(config, path, { method = 'GET', params, body, form, timeout = TIMEOUT } = {}, fetchImpl) {
    const bad = problem(config);
    if (bad) throw new NylasError(bad, { code: 'setup' });
    const url = new URL(baseOf(config) + path);
    for (const [k, v] of Object.entries(params || {})) if (v != null && v !== '') url.searchParams.set(k, String(v));
    const controller = new AbortController();
    let timer = null;
    const late = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('timed out'));
      }, timeout);
    });
    const headers = { Authorization: `Bearer ${String(config.apiKey).trim()}`, Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    let res;
    let raw;
    try {
      const read = async () => {
        res = await (fetchImpl || root.fetch.bind(root))(url.href, {
          method,
          headers,
          ...(body ? { body: JSON.stringify(body) } : form ? { body: form } : {}),
          credentials: 'omit',
          signal: controller.signal,
        });
        raw = await res.text();
      };
      await Promise.race([read(), late]);
    } catch (err) {
      throw new NylasError(`Couldn’t reach Nylas (${(err && err.message) || err}).`, { code: 'network' });
    } finally {
      clearTimeout(timer);
    }
    let data;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch (err) {
      data = null;
    }
    if (!res.ok) throw explain(res.status, data, method !== 'GET');
    return data || {};
  }

  const get = (config, path, params, fetchImpl) => request(config, path, { params }, fetchImpl);

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

  /* ------------------------------------------------------------ writing */

  // Nylas takes a JSON request up to 3 MB; anything bigger goes as multipart/form-data (up to 25 MB).
  const JSON_LIMIT = 3 * 1024 * 1024;
  const SEND_TIMEOUT = 60000;

  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  /**
   * Plain text as the HTML a mail program shows the way it was typed: a paragraph per blank line, a line break per
   * line ("Kind regards,\nAda Lovelace"), addresses and links left as text.
   */
  function htmlOf(text) {
    return String(text || '')
      .replace(/\r\n?/g, '\n')
      .trim()
      .split(/\n[ \t]*\n+/)
      .map((p) => `<p>${p.split('\n').map(escapeHtml).join('<br>')}</p>`)
      .join('\n');
  }

  /** A data: URL's bytes as base64 and its type: "data:application/pdf;base64,JVBER…" → { type, base64 }. */
  function fromDataUrl(dataUrl) {
    const m = String(dataUrl || '').match(/^data:([^;,]*)(;base64)?,([\s\S]*)$/);
    if (!m) return null;
    let base64 = m[3];
    if (!m[2]) {
      // A text data: URL ("data:text/plain,Hello%20there"): its UTF-8 bytes, as base64.
      let bin = '';
      for (const b of new root.TextEncoder().encode(decodeURIComponent(m[3]))) bin += String.fromCharCode(b);
      base64 = root.btoa(bin);
    }
    return { type: m[1] || 'application/octet-stream', base64 };
  }

  /** The decoded size of a base64 string, in bytes. */
  const bytesOf = (b64) => Math.floor((String(b64).replace(/=+$/, '').length * 3) / 4);

  /**
   * The message as Nylas takes it: { subject, body (HTML), to: [{ email, name }], attachments: [{ filename,
   * content_type, content (base64), size }] }. email: { to (an address, or [{ email, name }]), name, subject, text,
   * attachments: [{ name, dataUrl } | { name, type, base64 }] }.
   */
  function messageOf(email) {
    const e = email || {};
    const to = (Array.isArray(e.to) ? e.to : [{ email: e.to, name: e.name }])
      .map((r) => (typeof r === 'string' ? { email: r } : r))
      .map((r) => ({ email: String((r && r.email) || '').trim(), ...(r && r.name ? { name: String(r.name) } : {}) }))
      .filter((r) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email));
    if (!to.length) throw new NylasError('There’s no address to send this to.', { code: 'setup' });
    const attachments = (e.attachments || []).map((a) => {
      const data = a.base64 ? { type: a.type || 'application/octet-stream', base64: a.base64 } : fromDataUrl(a.dataUrl);
      if (!data) throw new NylasError(`Couldn’t read the attachment ${a.name || ''}.`, { code: 'attachment' });
      return {
        filename: a.name || 'attachment',
        content_type: data.type,
        content: data.base64,
        size: bytesOf(data.base64),
      };
    });
    return { subject: String(e.subject || ''), body: htmlOf(e.text), to, attachments };
  }

  /** The message as multipart/form-data: the JSON as "message", each attachment as a file of its own. */
  function formOf(message) {
    const form = new root.FormData();
    const { attachments, ...rest } = message;
    form.append('message', JSON.stringify(rest));
    attachments.forEach((a, i) => {
      const bin = root.atob(a.content);
      const bytes = new Uint8Array(bin.length);
      for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
      form.append(`file${i}`, new root.Blob([bytes], { type: a.content_type }), a.filename);
    });
    return form;
  }

  /** POST a message to `path`, as JSON or, past Nylas's JSON limit, as multipart. */
  async function write(config, path, email, fetchImpl) {
    if (!config || !config.grantId) throw new NylasError('Choose which inbox to use first.', { code: 'setup' });
    const message = messageOf(email);
    const size = JSON.stringify(message).length;
    const opts = { method: 'POST', timeout: SEND_TIMEOUT };
    if (size < JSON_LIMIT) opts.body = message;
    else opts.form = formOf(message);
    const data = await request(config, `/v3/grants/${encodeURIComponent(config.grantId)}${path}`, opts, fetchImpl);
    const d = (data && data.data) || {};
    return { id: d.id || '', threadId: d.thread_id || '', date: d.date || 0 };
  }

  /** Save the email in the connected mailbox's drafts (Gmail's Drafts folder): { id, threadId }. */
  const saveDraft = (config, email, { fetch: fetchImpl } = {}) => write(config, '/drafts', email, fetchImpl);

  /** Send the email from the connected mailbox; it lands in Sent like one written there: { id, threadId, date }. */
  const send = (config, email, { fetch: fetchImpl } = {}) => write(config, '/messages/send', email, fetchImpl);

  /**
   * Replies to an email that went out: messages in its thread received after it, from anyone but the sender.
   * → [{ id, subject, from, date, snippet }]
   */
  async function replies(config, { threadId, after, me, fetch: fetchImpl } = {}) {
    if (!config || !config.grantId || !threadId) return [];
    const data = await get(
      config,
      `/v3/grants/${encodeURIComponent(config.grantId)}/messages`,
      { thread_id: threadId, limit: 20, received_after: after ? Math.floor(after / 1000) : null },
      fetchImpl,
    );
    const mine = String(me || config.email || '').toLowerCase();
    return (data.data || [])
      .filter((m) => !(m.from || []).some((f) => String(f.email || '').toLowerCase() === mine))
      .map((m) => ({
        id: m.id,
        subject: m.subject || '',
        from: m.from || [],
        date: m.date || 0,
        snippet: m.snippet || '',
      }));
  }

  /**
   * What the connected inbox lets JobToFill do, from the grant's scopes: { draft, send, scopes, provider }. Google
   * needs gmail.compose for drafts (or gmail.send just to send); Microsoft Mail.ReadWrite, and Mail.Send to send. A
   * grant that lists no scopes is taken as able (Nylas leaves them out for some providers) and the send itself says.
   */
  async function abilities(config, { fetch: fetchImpl } = {}) {
    if (!config || !config.grantId) return { draft: false, send: false, scopes: [], provider: '' };
    const data = await get(config, `/v3/grants/${encodeURIComponent(config.grantId)}`, {}, fetchImpl);
    const g = (data && data.data) || {};
    const scopes = (Array.isArray(g.scope) ? g.scope : String(g.scope || '').split(/[\s,]+/)).filter(Boolean);
    const has = (re) => scopes.some((x) => re.test(x));
    if (!scopes.length) return { draft: true, send: true, scopes, provider: g.provider || '', unknown: true };
    const full = has(/mail\.google\.com\/?$|gmail\.modify/);
    const draft = full || has(/gmail\.compose|Mail\.ReadWrite/i);
    const sendOk = full || has(/gmail\.compose|gmail\.send|Mail\.Send/i);
    return { draft, send: sendOk, scopes, provider: g.provider || '' };
  }

  const nylas = { REGIONS, problem, grants, messages, htmlOf, messageOf, saveDraft, send, replies, abilities };
  JTF.nylas = nylas;
  if (typeof module === 'object' && module.exports) module.exports = nylas;
})(typeof globalThis !== 'undefined' ? globalThis : this);
