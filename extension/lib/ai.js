/*
 * JobToFill — chat client for the cover letter and CV writer.
 * Speaks the OpenAI-compatible chat completions API that OpenRouter, DeepSeek and most other
 * providers offer. Calls are made from the extension's own pages (no service worker time limits),
 * with the person's own API key; nothing goes anywhere else.
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});

  const PROVIDERS = {
    openrouter: {
      label: 'OpenRouter',
      base: 'https://openrouter.ai/api/v1',
      model: 'deepseek/deepseek-v4.1-flash',
      keyUrl: 'https://openrouter.ai/settings/keys',
      keyHint: 'sk-or-…',
    },
    deepseek: {
      label: 'DeepSeek',
      base: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      keyUrl: 'https://platform.deepseek.com/api_keys',
      keyHint: 'sk-…',
    },
    custom: {
      label: 'Other (OpenAI-compatible)',
      base: '',
      model: '',
      keyUrl: '',
      keyHint: '',
    },
  };

  const DEFAULT_CONFIG = { provider: 'openrouter', model: '', baseUrl: '' };
  const TIMEOUT = 120000;
  const RETRY_DELAYS = [1500, 4000];

  class AIError extends Error {
    constructor(message, { status, retry, code } = {}) {
      super(message);
      this.name = 'AIError';
      this.status = status;
      this.retry = !!retry;
      this.code = code || null;
    }
  }

  /** Provider, base URL and model with the defaults filled in. */
  function resolve(config) {
    const c = Object.assign({}, DEFAULT_CONFIG, config || {});
    const p = PROVIDERS[c.provider] || PROVIDERS.custom;
    const base = String(c.provider === 'custom' ? c.baseUrl || '' : c.baseUrl || p.base)
      .trim()
      .replace(/\/+$/, '')
      .replace(/\/chat\/completions$/, '');
    return { ...c, base, model: String(c.model || p.model || '').trim(), label: p.label };
  }

  function problem(config) {
    const c = resolve(config);
    if (!c.apiKey || !String(c.apiKey).trim()) return 'Add your API key first.';
    if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(c.base))
      return 'Set the provider’s API address (https://…).';
    if (!c.model) return 'Choose a model.';
    return null;
  }

  function headers(c) {
    const h = { 'Content-Type': 'application/json', Authorization: `Bearer ${String(c.apiKey).trim()}` };
    // OpenRouter's optional app attribution.
    if (/openrouter\.ai/.test(c.base))
      Object.assign(h, { 'HTTP-Referer': 'https://github.com/rob435/JobToFill', 'X-Title': 'JobToFill' });
    return h;
  }

  /** What went wrong, in words a person can act on. */
  function explain(status, body, c) {
    const detail = String((body && body.error && (body.error.message || body.error)) || body || '').slice(0, 300);
    if (status === 401 || status === 403)
      return new AIError(`${c.label} rejected the API key. Check it in Settings › Cover letters.`, {
        status,
        code: 'key',
      });
    if (status === 402)
      return new AIError(`Your ${c.label} account is out of credit. Top it up, then try again.`, {
        status,
        code: 'credit',
      });
    if (status === 404 || (status === 400 && /model/i.test(detail) && /not|invalid|exist|support/i.test(detail)))
      return new AIError(
        `${c.label} doesn’t offer the model “${c.model}”. Pick another one in Settings › Cover letters.`,
        {
          status,
          code: 'model',
        },
      );
    if (status === 429)
      return new AIError(`${c.label} is rate-limiting requests. Try again in a minute.`, { status, retry: true });
    if (status >= 500)
      return new AIError(`${c.label} had a problem (${status}). Try again shortly.`, { status, retry: true });
    return new AIError(`${c.label} returned an error (${status})${detail ? ': ' + detail : ''}`, { status });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Pull a JSON object out of a reply that may be wrapped in a code fence or chatter. */
  function parseJson(text) {
    if (text == null) throw new AIError('The model returned nothing.', { retry: true });
    const s = String(text)
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    try {
      return JSON.parse(s);
    } catch (err) {
      const start = s.indexOf('{');
      const end = s.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(s.slice(start, end + 1));
        } catch (err2) {
          /* fall through */
        }
      }
      throw new AIError('The model’s reply was not valid JSON.', { retry: true, code: 'json' });
    }
  }

  async function post(c, body, signal, fetchImpl) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new AIError('The model took too long to answer.', { retry: true })),
      TIMEOUT,
    );
    const onAbort = () => controller.abort(signal.reason);
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      let res;
      try {
        res = await fetchImpl(`${c.base}/chat/completions`, {
          method: 'POST',
          headers: headers(c),
          body: JSON.stringify(body),
          signal: controller.signal,
          credentials: 'omit',
        });
      } catch (err) {
        if (signal && signal.aborted) throw signal.reason || err;
        if (controller.signal.aborted && controller.signal.reason instanceof AIError) throw controller.signal.reason;
        throw new AIError(`Couldn’t reach ${c.label} (${err.message || err}).`, { retry: true, code: 'network' });
      }
      const raw = await res.text();
      let data = null;
      try {
        data = raw ? JSON.parse(raw) : null;
      } catch (err) {
        data = raw;
      }
      if (!res.ok) throw explain(res.status, data, c);
      // OpenRouter reports upstream failures inside a 200 response.
      if (data && data.error) throw explain(data.error.code || 502, data, c);
      return data;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * One chat completion. With `json: true` the reply is parsed (and asked for again once if it
   * isn't valid JSON). Returns { text, json, usage, model }.
   */
  async function chat(
    config,
    { messages, json = false, temperature = 0.4, maxTokens = 4000, reasoning, signal, fetch: fetchImpl },
  ) {
    const c = resolve(config);
    const bad = problem(c);
    if (bad) throw new AIError(bad, { code: 'setup' });
    const doFetch = fetchImpl || root.fetch.bind(root);
    const body = { model: c.model, messages, temperature, max_tokens: maxTokens };
    if (json) body.response_format = { type: 'json_object' };
    // Reasoning models think before answering. Extraction needs none (it only costs time); writing
    // can ask for a little. Only OpenRouter takes this setting; other providers pick by model.
    if (/openrouter\.ai/.test(c.base))
      body.reasoning = !reasoning || reasoning === 'none' ? { enabled: false } : { effort: reasoning, exclude: true };

    let lastErr;
    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      try {
        const data = await post(c, body, signal, doFetch);
        const choice = (data && data.choices && data.choices[0]) || {};
        const text = (choice.message && choice.message.content) || '';
        const usage = data && data.usage;
        if (!text.trim()) {
          // Thinking used up the token budget: give it more room and ask again.
          if (choice.finish_reason === 'length') body.max_tokens = Math.min(body.max_tokens * 2, 16000);
          throw new AIError('The model returned an empty reply.', { retry: true });
        }
        if (!json) return { text: text.trim(), usage, model: data.model || c.model };
        try {
          return { text, json: parseJson(text), usage, model: data.model || c.model };
        } catch (err) {
          if (choice.finish_reason === 'length') body.max_tokens = Math.min(body.max_tokens * 2, 16000);
          throw err;
        }
      } catch (err) {
        lastErr = err;
        if (signal && signal.aborted) throw err;
        // Some providers don't support JSON mode; the prompt asks for JSON anyway.
        if (err.status === 400 && body.response_format && /response_format|json/i.test(err.message)) {
          delete body.response_format;
          attempt--;
          continue;
        }
        if (err.status === 400 && body.reasoning && /reasoning/i.test(err.message)) {
          delete body.reasoning;
          attempt--;
          continue;
        }
        if (!(err instanceof AIError) || !err.retry || attempt === RETRY_DELAYS.length) throw err;
        await sleep(RETRY_DELAYS[attempt]);
      }
    }
    throw lastErr;
  }

  /** A tiny request that proves the key, address and model all work. */
  async function test(config, options) {
    const started = Date.now();
    const r = await chat(config, {
      ...options,
      messages: [{ role: 'user', content: 'Reply with this JSON and nothing else: {"ok": true}' }],
      json: true,
      maxTokens: 400,
      temperature: 0,
    });
    if (!r.json || r.json.ok !== true) throw new AIError('The model answered, but not as expected.');
    return { ok: true, model: r.model, ms: Date.now() - started };
  }

  /** Model ids the provider offers (OpenRouter lists them without a key). */
  async function models(config, { fetch: fetchImpl } = {}) {
    const c = resolve(config);
    const doFetch = fetchImpl || root.fetch.bind(root);
    const res = await doFetch(`${c.base}/models`, {
      headers: c.apiKey ? headers(c) : {},
      credentials: 'omit',
    });
    if (!res.ok) throw explain(res.status, await res.text().catch(() => ''), c);
    const data = await res.json();
    return (data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean);
  }

  const ai = { PROVIDERS, DEFAULT_CONFIG, AIError, resolve, problem, chat, test, models, parseJson };
  JTF.ai = ai;
  if (typeof module === 'object' && module.exports) module.exports = ai;
})(typeof globalThis !== 'undefined' ? globalThis : this);
