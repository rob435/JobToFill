/*
 * JobToFill — chat client for the cover letter and CV writer and the AI answers.
 * Speaks Anthropic's Messages API (Claude) and the OpenAI-compatible chat completions API that OpenRouter,
 * DeepSeek and most other providers offer. Calls are made from the extension's own pages and background, with the
 * person's own API key; nothing goes anywhere else.
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});

  // What a letter costs, roughly: about 10k tokens in and 3k out over the analysis, the draft and the fact check
  // (tests/eval measures it). Shown beside each model so the choice is plain.
  const CLAUDE = {
    haiku: ['Claude Haiku 5.5', 'fast and the cheapest: well under 1¢ a letter'],
    sonnet: ['Claude Sonnet 5.5', 'the best letters and answers for the money: about 5¢ a letter'],
    opus: ['Claude Opus 5.5', 'the most capable, a little slower: about 10¢ a letter'],
  };

  const PROVIDERS = {
    anthropic: {
      label: 'Claude (Anthropic)',
      api: 'anthropic',
      base: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-5-5',
      keyUrl: 'https://console.anthropic.com/settings/keys',
      keyHint: 'sk-ant-…',
      suggest: [
        { id: 'claude-sonnet-5-5', name: CLAUDE.sonnet[0], note: CLAUDE.sonnet[1] },
        { id: 'claude-haiku-5-5', name: CLAUDE.haiku[0], note: CLAUDE.haiku[1] },
        { id: 'claude-opus-5-5', name: CLAUDE.opus[0], note: CLAUDE.opus[1] },
      ],
      // US dollars per million tokens: input, output, cache read (a cache write is 1.25× input).
      prices: {
        'claude-haiku-5-5': [0.1, 0.5, 0.01],
        'claude-sonnet-5-5': [2, 10, 0.2],
        'claude-opus-5-5': [4, 20, 0.2],
      },
      // Fast mode, a research preview: the same Opus writing up to 2.5× as fast, every token at twice the price.
      fast: { models: ['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8'], beta: 'fast-mode-2026-02-01', price: 2 },
      maxTokens: 32000,
    },
    openrouter: {
      label: 'OpenRouter',
      base: 'https://openrouter.ai/api/v1',
      model: 'deepseek/deepseek-v4.1-flash',
      keyUrl: 'https://openrouter.ai/settings/keys',
      keyHint: 'sk-or-…',
      suggest: [
        { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', note: 'cheap and quick: under 1¢ a letter' },
        { id: 'anthropic/claude-haiku-5.5', name: CLAUDE.haiku[0], note: CLAUDE.haiku[1] },
        { id: 'anthropic/claude-sonnet-5.5', name: CLAUDE.sonnet[0], note: CLAUDE.sonnet[1] },
        { id: 'anthropic/claude-opus-5.5', name: CLAUDE.opus[0], note: CLAUDE.opus[1] },
      ],
    },
    deepseek: {
      label: 'DeepSeek',
      base: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      keyUrl: 'https://platform.deepseek.com/api_keys',
      keyHint: 'sk-…',
      suggest: [
        { id: 'deepseek-chat', name: 'DeepSeek Chat', note: 'answers straight away' },
        { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', note: 'thinks first: slower and dearer' },
      ],
      // Longest reply the API accepts.
      maxTokens: 8192,
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
    constructor(message, { status, retry, code, detail } = {}) {
      super(message);
      this.name = 'AIError';
      this.status = status;
      this.retry = !!retry;
      this.code = code || null;
      // The provider's own words ("`temperature` is not supported for this model"), for deciding what to retry.
      this.detail = detail || '';
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
    // Errors name the provider; for a custom one, by its address ("api.example.com").
    let label = p.label;
    if (c.provider === 'custom' || !PROVIDERS[c.provider]) {
      try {
        label = new URL(base).hostname;
      } catch (err) {
        label = 'your AI provider';
      }
    }
    return { ...c, base, model: String(c.model || p.model || '').trim(), label };
  }

  function problem(config) {
    const c = resolve(config);
    if (!c.apiKey || !String(c.apiKey).trim()) return 'Add your API key first.';
    if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(c.base))
      return 'Set the provider’s API address (https://…).';
    if (!c.model) return 'Choose a model.';
    return null;
  }

  /** The model ids a provider suggests, each with its name and what it's good for (the settings' model list). */
  const suggestions = (provider) => (PROVIDERS[provider] && PROVIDERS[provider].suggest) || [];

  /** What a suggested model is good for, as a sentence ("Fast and the cheapest: …"), or '' for any other id. */
  function describe(provider, model) {
    const s = suggestions(provider).find((m) => m.id === String(model || '').trim());
    return s ? s.note.charAt(0).toUpperCase() + s.note.slice(1) + '.' : '';
  }

  /** Does this provider's model have a fast mode (Claude Opus 5.5 does; Sonnet and Haiku don't)? */
  function hasFastMode(provider, model) {
    const p = PROVIDERS[provider];
    return !!(p && p.fast) && p.fast.models.includes(String(model || '').trim() || p.model);
  }

  const apiOf = (c) => (PROVIDERS[c.provider] && PROVIDERS[c.provider].api) || 'openai';

  function headers(c, body) {
    const key = String(c.apiKey).trim();
    // Anthropic's API answers an extension page only when it says it calls from a browser on purpose.
    if (apiOf(c) === 'anthropic') {
      const h = {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      };
      // Fast mode is a beta: its header goes with the requests that ask for it, and only those.
      if (body && body.speed) h['anthropic-beta'] = PROVIDERS[c.provider].fast.beta;
      return h;
    }
    const h = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
    // OpenRouter's optional app attribution.
    if (/openrouter\.ai/.test(c.base))
      Object.assign(h, { 'HTTP-Referer': 'https://github.com/rob435/JobToFill', 'X-Title': 'JobToFill' });
    return h;
  }

  /** A call's cost in US dollars from the provider's price list (Claude, fast mode at its premium), or undefined. */
  function costOf(c, u) {
    const provider = PROVIDERS[c.provider];
    const p = provider && provider.prices && provider.prices[c.model];
    if (!p) return undefined;
    const [input, output, read] = p;
    const premium = u.speed === 'fast' && provider.fast ? provider.fast.price : 1;
    return (
      (premium *
        ((u.input_tokens || 0) * input +
          (u.cache_creation_input_tokens || 0) * input * 1.25 +
          (u.cache_read_input_tokens || 0) * read +
          (u.output_tokens || 0) * output)) /
      1e6
    );
  }

  // How much thinking a request asks for, as Claude's effort: extraction needs little, writing can take more.
  const EFFORT = { none: 'low', low: 'low', medium: 'medium', high: 'high' };
  // Room for Claude's thinking on top of the reply the caller budgets for.
  const THINKING_ROOM = 4000;

  /**
   * Thinking switched off, as each Claude model spells it, for requests that ask for no reasoning (extraction,
   * fact checks, the letter itself): thinking first only makes them slower, as on OpenRouter, where the same
   * models get `reasoning: { enabled: false }`. Sonnet 5.5 calls it "between_tools" (there are no tools here, so
   * it doesn't think at all); Opus 5.5, Fable and Mythos always think, so low effort is the least they do; other
   * models take "disabled". A model that spells it another way refuses it once and is asked without it after.
   */
  function thinkingOff(model) {
    if (/^claude-sonnet-5-5\b/.test(model)) return { type: 'between_tools' };
    if (/^claude-(opus-5-5|fable|mythos)\b/.test(model)) return null;
    return { type: 'disabled' };
  }

  /**
   * How each API is spoken: where a chat goes, the request body, and the reply as { text, length (cut off by the
   * token limit), usage, model }. OpenAI-compatible APIs and Anthropic's Messages API.
   */
  const WIRES = {
    openai: {
      path: '/chat/completions',
      request(c, { messages, json, temperature, maxTokens, reasoning, cap }) {
        const body = { model: c.model, messages, temperature, max_tokens: Math.min(maxTokens, cap) };
        if (json) body.response_format = { type: 'json_object' };
        // Reasoning models think before answering. Extraction needs none (it only costs time); writing
        // can ask for a little. Only OpenRouter takes this setting; other providers pick by model.
        if (/openrouter\.ai/.test(c.base))
          body.reasoning =
            !reasoning || reasoning === 'none' ? { enabled: false } : { effort: reasoning, exclude: true };
        return body;
      },
      reply(data, c) {
        const choice = (data && data.choices && data.choices[0]) || {};
        return {
          text: (choice.message && choice.message.content) || '',
          length: choice.finish_reason === 'length',
          usage: data && data.usage,
          model: (data && data.model) || c.model,
        };
      },
    },
    anthropic: {
      path: '/messages',
      // System messages become the system prompt, cached with the start of the conversation: the answers' batches,
      // fix rounds and a letter's drafts share it. Claude sets its own sampling, so there is no temperature, and
      // thinking is asked for as effort (or switched off). JSON is what every prompt here asks for in words.
      request(c, { messages, maxTokens, reasoning, cap }) {
        const system = messages
          .filter((m) => m.role === 'system')
          .map((m) => String(m.content))
          .join('\n\n');
        const body = {
          model: c.model,
          max_tokens: Math.min(maxTokens + THINKING_ROOM, cap),
          output_config: { effort: EFFORT[reasoning] || 'low' },
          cache_control: { type: 'ephemeral' },
          messages: messages
            .filter((m) => m.role !== 'system')
            .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content) })),
        };
        const off = !reasoning || reasoning === 'none' ? thinkingOff(c.model) : null;
        if (off) body.thinking = off;
        if (c.fast && hasFastMode(c.provider, c.model)) body.speed = 'fast';
        if (system) body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
        return body;
      },
      reply(data, c) {
        if (data && data.stop_reason === 'refusal')
          throw new AIError(`${c.label} declined to write this. Edit the request or try another model.`, {
            code: 'refusal',
          });
        const u = (data && data.usage) || {};
        const read = u.cache_read_input_tokens || 0;
        return {
          text: ((data && data.content) || [])
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join(''),
          length: !!data && data.stop_reason === 'max_tokens',
          usage: {
            prompt_tokens: (u.input_tokens || 0) + read + (u.cache_creation_input_tokens || 0),
            completion_tokens: u.output_tokens || 0,
            cached_tokens: read,
            cost: costOf(c, u),
            // "fast" when fast mode wrote it; "standard" when it was asked for but the key can't use it yet.
            ...(u.speed ? { speed: u.speed } : {}),
          },
          model: (data && data.model) || c.model,
        };
      },
    },
  };

  /** What went wrong, in words a person can act on (with the provider's own words kept as `detail`). */
  function explain(status, body, c) {
    const detail = String((body && body.error && (body.error.message || body.error)) || body || '').slice(0, 300);
    const err = (message, o = {}) => new AIError(message, { status, detail, ...o });
    if (status === 401 || status === 403)
      return err(`${c.label} rejected the API key. Check it in Settings › Cover letters.`, { code: 'key' });
    // Anthropic says so in a 400: "Your credit balance is too low to access the Anthropic API."
    if (status === 402 || (status === 400 && /credit balance/i.test(detail)))
      return err(`Your ${c.label} account is out of credit. Top it up, then try again.`, { code: 'credit' });
    // A setting the model won't take ("`temperature` is not supported for this model") isn't a missing model.
    const setting = /temperature|top_p|response_format|reasoning|max_tokens|thinking|effort|speed/i.test(detail);
    if (
      status === 404 ||
      (status === 400 && !setting && /model/i.test(detail) && /not|invalid|exist|support/i.test(detail))
    )
      return err(`${c.label} doesn’t offer the model “${c.model}”. Pick another one in Settings › Cover letters.`, {
        code: 'model',
      });
    if (status === 429)
      return err(`${c.label} is rate-limiting requests. Try again in a minute.`, { retry: true, code: 'rate' });
    if (status >= 500) return err(`${c.label} had a problem (${status}). Try again shortly.`, { retry: true });
    return err(`${c.label} returned an error (${status})${detail ? ': ' + detail : ''}`);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Pull a JSON object out of a reply that may be wrapped in a code fence or chatter. */
  /** Small, safe repairs for JSON that is almost right: trailing commas, curly quotes around keys. */
  function repairJson(s) {
    return s
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/[“”]([A-Za-z_]+)[“”]\s*:/g, '"$1":')
      .replace(/^\uFEFF/, '');
  }

  /**
   * Pull a JSON object out of a reply that may be wrapped in a code fence, preceded by the model's
   * thinking (<think>…</think>) or chatter, or carry a trailing comma.
   */
  function parseJson(text) {
    if (text == null) throw new AIError('The model returned nothing.', { retry: true });
    const s = String(text)
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    const tries = [s, start >= 0 && end > start ? s.slice(start, end + 1) : null].filter(Boolean);
    for (const t of tries)
      for (const candidate of [t, repairJson(t)]) {
        try {
          return JSON.parse(candidate);
        } catch (err) {
          /* next */
        }
      }
    throw new AIError('The model’s reply was not valid JSON.', { retry: true, code: 'json' });
  }

  async function post(c, body, signal, fetchImpl) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new AIError('The model took too long to answer.', { retry: true, code: 'timeout' })),
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
        res = await fetchImpl(`${c.base}${WIRES[apiOf(c)].path}`, {
          method: 'POST',
          headers: headers(c, body),
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
      if (!res.ok) {
        const err = explain(res.status, data, c);
        // Honour the provider's Retry-After (seconds), within reason.
        const after = res.headers && typeof res.headers.get === 'function' && Number(res.headers.get('retry-after'));
        if (after > 0) err.waitMs = Math.min(after * 1000, 20000);
        throw err;
      }
      // OpenRouter reports upstream failures inside a 200 response.
      if (data && data.error) throw explain(data.error.code || 502, data, c);
      return data;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  // Settings a model may refuse, each with what its 400 says ("`temperature` is not supported for this model",
  // "thinking.type.disabled is not supported for this model", no JSON mode, no effort on Haiku 4.5, no fast mode
  // for this key yet): it is asked again without that one. Thinking comes before effort, since its refusal names both.
  const OPTIONAL = [
    ['response_format', /response_format|json/i],
    ['reasoning', /reasoning/i],
    ['temperature', /temperature/i],
    ['thinking', /thinking/i],
    ['output_config', /effort|output_config/i],
    ['speed', /speed|fast/i],
  ];
  // What each model refused this session, so later calls leave it out instead of paying for the same 400 again.
  const refused = new Map();

  /** The setting a 400 (or, for fast mode, a 403) says the model won't take, if the request has it. */
  function refusedSetting(err, body) {
    if (!(err instanceof AIError) || (err.status !== 400 && err.status !== 403)) return null;
    const hit = OPTIONAL.find(([k, re]) => k in body && re.test(err.detail || err.message));
    return hit && (err.status === 400 || hit[0] === 'speed') ? hit[0] : null;
  }

  /** One chat completion from one provider (see chat()). */
  async function chatWith(
    config,
    { messages, json = false, temperature = 0.4, maxTokens = 4000, reasoning, signal, fetch: fetchImpl },
  ) {
    const c = resolve(config);
    const bad = problem(c);
    if (bad) throw new AIError(bad, { code: 'setup' });
    const doFetch = fetchImpl || root.fetch.bind(root);
    const cap = (PROVIDERS[c.provider] && PROVIDERS[c.provider].maxTokens) || 16000;
    const wire = WIRES[apiOf(c)];
    const body = wire.request(c, { messages, json, temperature, maxTokens, reasoning, cap });
    const id = `${c.base} ${c.model}`;
    for (const k of refused.get(id) || []) delete body[k];

    let lastErr;
    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      try {
        const { text, length, usage, model } = wire.reply(await post(c, body, signal, doFetch), c);
        if (!text.trim()) {
          // Thinking used up the token budget: give it more room and ask again.
          if (length) body.max_tokens = Math.min(body.max_tokens * 2, cap);
          throw new AIError('The model returned an empty reply.', { retry: true });
        }
        if (!json) return { text: text.trim(), usage, model };
        try {
          return { text, json: parseJson(text), usage, model };
        } catch (err) {
          if (length) body.max_tokens = Math.min(body.max_tokens * 2, cap);
          throw err;
        }
      } catch (err) {
        lastErr = err;
        if (signal && signal.aborted) throw err;
        const setting = refusedSetting(err, body);
        if (setting) {
          delete body[setting];
          refused.set(id, new Set(refused.get(id)).add(setting));
          attempt--;
          continue;
        }
        // Fast mode has a rate limit of its own: when it runs out, carry on at the usual speed rather than wait.
        if (err.code === 'rate' && body.speed) {
          delete body.speed;
          attempt--;
          continue;
        }
        if (!(err instanceof AIError) || !err.retry || attempt === RETRY_DELAYS.length) throw err;
        await sleep(err.waitMs || RETRY_DELAYS[attempt]);
      }
    }
    throw lastErr;
  }

  // Problems another provider doesn't share: out of credit, rate-limited, down, unreachable, too slow.
  const PROVIDER_TROUBLE = new Set(['credit', 'rate', 'network', 'timeout']);

  /**
   * One chat completion. With `json: true` the reply is parsed (and asked for again once if it isn't
   * valid JSON). Returns { text, json, usage, model }. When the provider has trouble of its own and
   * `config.fallback` names another provider with a key, that one answers instead, and the result says
   * so in `fallback: { from, to, reason }`.
   */
  async function chat(config, options) {
    try {
      return await chatWith(config, options);
    } catch (err) {
      const backup = config && config.fallback;
      const trouble = err instanceof AIError && (PROVIDER_TROUBLE.has(err.code) || err.status >= 500);
      if (!backup || !trouble || (options && options.signal && options.signal.aborted)) throw err;
      const r = await chatWith(backup, options);
      return { ...r, fallback: { from: resolve(config).label, to: resolve(backup).label, reason: err.message } };
    }
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
    // Whether fast mode wrote it: false when it was asked for but this key can't use it yet.
    const fast = !r.fallback && !!config.fast && hasFastMode(config.provider, resolve(config).model);
    return { ok: true, model: r.model, ms: Date.now() - started, ...(fast ? { fast: r.usage.speed === 'fast' } : {}) };
  }

  /** Model ids the provider offers (OpenRouter lists them without a key; Anthropic needs one). */
  async function models(config, { fetch: fetchImpl } = {}) {
    const c = resolve(config);
    const doFetch = fetchImpl || root.fetch.bind(root);
    const res = await doFetch(`${c.base}/models${apiOf(c) === 'anthropic' ? '?limit=100' : ''}`, {
      headers: c.apiKey ? headers(c) : {},
      credentials: 'omit',
    });
    if (!res.ok) throw explain(res.status, await res.text().catch(() => ''), c);
    const data = await res.json();
    return (data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean);
  }

  const ai = {
    PROVIDERS,
    DEFAULT_CONFIG,
    AIError,
    resolve,
    problem,
    chat,
    test,
    models,
    parseJson,
    suggestions,
    describe,
    hasFastMode,
  };
  JTF.ai = ai;
  if (typeof module === 'object' && module.exports) module.exports = ai;
})(typeof globalThis !== 'undefined' ? globalThis : this);
