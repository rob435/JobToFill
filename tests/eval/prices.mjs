// What a model call costs. OpenRouter reports each call's cost (usage.cost, in dollars); otherwise it's the tokens
// times this table: dollars per million tokens, uncached input / output / cache reads / cache writes. Prices from
// OpenRouter's model list and Anthropic's price list, October 2026; null where unknown (shown as "?").
export const PRICES = {
  'deepseek-v4.1-flash': { input: 0.3, output: 1.2, cacheRead: 0.006 },
  // DeepSeek's own API: prices not confirmed.
  'deepseek-chat': null,
  'deepseek-reasoner': null,
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  // Up to 100K-token prompts (the eval's are far shorter).
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

/** The table's key for a model id: "anthropic/claude-opus-5.5" and "claude-opus-5-5-20260901" are claude-opus-5-5. */
export function modelKey(model) {
  let k = String(model || '')
    .trim()
    .toLowerCase()
    .replace(/^[\w.-]+\//, '')
    .replace(/:.*$/, '')
    .replace(/-\d{8}$/, '');
  if (/^claude-/.test(k)) k = k.replace(/(\d)\.(\d)/g, '$1-$2');
  return k;
}

export const priceOf = (model) => PRICES[modelKey(model)] || null;

/**
 * Token counts from any of the usage shapes: OpenAI-compatible (prompt_tokens, with cached tokens in
 * prompt_tokens_details or DeepSeek's prompt_cache_hit_tokens) or Anthropic's (input_tokens, cache_read_…).
 */
export function tokens(usage) {
  const u = usage || {};
  if (u.input_tokens != null || u.output_tokens != null)
    return {
      input: u.input_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
      cacheWrite: u.cache_creation_input_tokens || 0,
      output: u.output_tokens || 0,
    };
  const cached = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || u.prompt_cache_hit_tokens || 0;
  return {
    input: Math.max(0, (u.prompt_tokens || 0) - cached),
    cacheRead: cached,
    cacheWrite: 0,
    output: u.completion_tokens || 0,
  };
}

/** A call's cost in dollars: { cost, source: 'reported' | 'table' }, or { cost: null } when there's no telling. */
export function callCost(usage, model) {
  if (usage && typeof usage.cost === 'number') return { cost: usage.cost, source: 'reported' };
  const p = priceOf(model);
  if (!p || !usage) return { cost: null, source: null };
  const t = tokens(usage);
  const cost =
    (t.input * p.input +
      t.cacheRead * (p.cacheRead != null ? p.cacheRead : p.input) +
      t.cacheWrite * (p.cacheWrite != null ? p.cacheWrite : p.input) +
      t.output * p.output) /
    1e6;
  return { cost, source: 'table' };
}
