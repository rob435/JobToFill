/*
 * JobToFill — your email through Nylas (https://www.nylas.com), with your own API key and the grant (connected
 * inbox) you choose, on the Nylas v3 API. For verification codes it only reads: the last few messages, never moving
 * or marking anything. Discover's outreach can also save an email you wrote to your mailbox's drafts or send it,
 * your CV attached, but only when you press that button for that one email. A send can wait for a time (Nylas holds
 * it until then and it can be taken back until 10 seconds before), and a follow-up goes into the first email's thread.
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

  function explain(status, body, writing, path) {
    const detail = String((body && body.error && (body.error.message || body.error.type)) || '').slice(0, 200);
    // A key that reads mail but can't send it: the inbox was connected with read-only access.
    if (writing && (status === 403 || (status === 400 && SCOPE.test(detail))) && SCOPE.test(detail || 'forbidden'))
      return new NylasError(
        'Your inbox is connected to Nylas for reading only. Connect it again with permission to send and draft mail (Settings › Email codes).',
        { status, code: 'scope' },
      );
    // A time Nylas won't hold an email for: "send_at must be at least 1 minute in the future".
    if (writing && status === 400 && /send_?at|send time|schedul/i.test(detail))
      return new NylasError(
        'Nylas wouldn’t schedule this email: it sends at a time from one minute to 30 days ahead. Send it now, or choose another time.',
        { status, code: 'schedule' },
      );
    if (status === 401 || status === 403)
      return new NylasError('Nylas rejected the API key (or it belongs to the other region).', { status, code: 'key' });
    // A schedule Nylas no longer has: the email went (its record lasts 72 hours after), or it was taken back already.
    if (status === 404 && /\/messages\/schedules\//.test(path || '') && !/grant/i.test(detail))
      return new NylasError('Nylas no longer has that email waiting: it has gone already, or was taken back.', {
        status,
        code: 'gone',
      });
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
    if (!res.ok) throw explain(res.status, data, method !== 'GET', path);
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
  // Nylas holds a scheduled email from one minute to 30 days ahead. Under two minutes away (a card made ready on
  // Sunday night and sent at "08:09" on Monday) it goes now: Nylas would refuse it, and its moment has come.
  const MIN_LEAD = 2 * 60 * 1000;
  const MAX_AHEAD = 30 * 24 * 3600 * 1000;
  // Nylas can take a scheduled email back until 10 seconds before it goes.
  const CANCEL_BY = 10 * 1000;

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
   * content_type, content (base64), size }], reply_to_message_id? }. email: { to (an address, or [{ email, name }]),
   * name, subject, text, attachments: [{ name, dataUrl } | { name, type, base64 }], replyTo? (the Nylas id of the
   * message this answers: Nylas adds In-Reply-To and References, so a follow-up lands in the first email's thread) }.
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
    const replyTo = String(e.replyTo || '').trim();
    return {
      subject: String(e.subject || ''),
      body: htmlOf(e.text),
      to,
      attachments,
      ...(replyTo ? { reply_to_message_id: replyTo } : {}),
    };
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

  /** POST a message (with `extra` fields) to `path`, as JSON or, past Nylas's JSON limit, as multipart: its `data`. */
  async function write(config, path, email, fetchImpl, extra) {
    if (!config || !config.grantId) throw new NylasError('Choose which inbox to use first.', { code: 'setup' });
    const message = { ...messageOf(email), ...extra };
    const size = JSON.stringify(message).length;
    const opts = { method: 'POST', timeout: SEND_TIMEOUT };
    if (size < JSON_LIMIT) opts.body = message;
    else opts.form = formOf(message);
    const data = await request(config, `/v3/grants/${encodeURIComponent(config.grantId)}${path}`, opts, fetchImpl);
    return (data && data.data) || {};
  }

  /** A message or draft as Nylas gave it back: { id, threadId, date } (date in seconds, as Nylas gives it). */
  const made = (d) => ({ id: d.id || '', threadId: d.thread_id || '', date: d.date || 0 });

  /** Save the email in the connected mailbox's drafts (Gmail's Drafts folder): { id, threadId }. Drafts can't wait. */
  const saveDraft = async (config, email, { fetch: fetchImpl } = {}) =>
    made(await write(config, '/drafts', email, fetchImpl));

  /** `email.sendAt` (ms) as Nylas's `send_at` (Unix seconds); null to send now, a time too close or already past. */
  function sendAtOf(sendAt, now) {
    if (sendAt == null || sendAt === '') return null;
    const at = Number(sendAt);
    if (!Number.isFinite(at)) throw new NylasError('Couldn’t read when to send this email.', { code: 'schedule' });
    if (at - now < MIN_LEAD) return null;
    if (at - now > MAX_AHEAD)
      throw new NylasError('Nylas holds an email for at most 30 days. Choose an earlier time, or send it now.', {
        code: 'schedule',
      });
    return Math.ceil(at / 1000);
  }

  /**
   * Send the email from the connected mailbox; it lands in Sent like one written there: { id, threadId, date }. With
   * `email.sendAt` (ms) Nylas holds it and sends it then: { id: '', threadId: '', date: 0, scheduleId, sendAt (ms) }:
   * the message has no id until it goes (sentMessage() finds it then), and cancelScheduled() takes it back. A time
   * under two minutes away or past sends now, so a result without `scheduleId` has gone.
   */
  async function send(config, email, { fetch: fetchImpl, now = Date.now() } = {}) {
    const at = sendAtOf(email && email.sendAt, now);
    const d = await write(config, '/messages/send', email, fetchImpl, at ? { send_at: at } : {});
    if (!at) return made(d);
    return { ...made(d), scheduleId: String(d.schedule_id || ''), sendAt: (Number(d.send_at) || at) * 1000 };
  }

  /**
   * Take back an email Nylas is holding to send later (the page's Undo): it's deleted unsent. Given `sendAt` (ms), a
   * try within 10 seconds of it says it's too late rather than racing the send. → { scheduleId, cancelled: true }
   */
  async function cancelScheduled(config, scheduleId, { sendAt, now = Date.now(), fetch: fetchImpl } = {}) {
    if (!config || !config.grantId) throw new NylasError('Choose which inbox to use first.', { code: 'setup' });
    const id = String(scheduleId || '').trim();
    if (!id) throw new NylasError('There’s no scheduled email to take back.', { code: 'setup' });
    if (sendAt && now > Number(sendAt) - CANCEL_BY)
      throw new NylasError('It’s too late to take that email back: it’s going now.', { code: 'late' });
    const path = `/v3/grants/${encodeURIComponent(config.grantId)}/messages/schedules/${encodeURIComponent(id)}`;
    await request(config, path, { method: 'DELETE' }, fetchImpl);
    return { scheduleId: id, cancelled: true };
  }

  /**
   * Where a scheduled email is: { scheduleId, status ('pending', 'success' or 'failed', as Nylas says), description,
   * closedAt (ms it went or failed, or 0) }. Nylas's docs show the object bare; other v3 replies wrap it in `data`.
   */
  async function scheduled(config, scheduleId, { fetch: fetchImpl } = {}) {
    if (!config || !config.grantId) throw new NylasError('Choose which inbox to use first.', { code: 'setup' });
    const id = String(scheduleId || '').trim();
    // Without an id the path would be the list of every schedule.
    if (!id) throw new NylasError('There’s no scheduled email to look up.', { code: 'setup' });
    const path = `/v3/grants/${encodeURIComponent(config.grantId)}/messages/schedules/${encodeURIComponent(id)}`;
    const data = await get(config, path, {}, fetchImpl);
    const d = data.data && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data : data;
    const st = d.status && typeof d.status === 'object' ? d.status : d;
    return {
      scheduleId: String(d.schedule_id || scheduleId || ''),
      status: String(st.code || (typeof d.status === 'string' ? d.status : '')),
      description: String(st.description || ''),
      closedAt: (Number(d.close_time) || 0) * 1000,
    };
  }

  /**
   * The message a scheduled email became once it went, to follow up in its thread and watch it for replies: the
   * earliest from the person to `to` with exactly `subject`, dated from a minute before `after` (ms, its send time).
   * → { id, threadId, date } or null while it hasn't gone.
   */
  async function sentMessage(config, { to, subject, after, me, fetch: fetchImpl } = {}) {
    const want = String(subject || '').trim();
    const addr = String(to || '')
      .trim()
      .toLowerCase();
    if (!config || !config.grantId || !want || !addr) return null;
    const data = await get(
      config,
      `/v3/grants/${encodeURIComponent(config.grantId)}/messages`,
      { subject: want, limit: 20, received_after: after ? Math.floor(after / 1000) - 60 : null },
      fetchImpl,
    );
    const mine = String(me || config.email || '').toLowerCase();
    const has = (list, email) => (list || []).some((r) => String((r && r.email) || '').toLowerCase() === email);
    const hit = (data.data || [])
      .filter((m) => String(m.subject || '').trim() === want && has(m.to, addr) && (!mine || has(m.from, mine)))
      .sort((a, b) => (a.date || 0) - (b.date || 0))[0];
    return hit ? made(hit) : null;
  }

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

  const nylas = {
    REGIONS,
    problem,
    grants,
    messages,
    htmlOf,
    messageOf,
    saveDraft,
    send,
    cancelScheduled,
    scheduled,
    sentMessage,
    replies,
    abilities,
  };
  JTF.nylas = nylas;
  if (typeof module === 'object' && module.exports) module.exports = nylas;
})(typeof globalThis !== 'undefined' ? globalThis : this);
