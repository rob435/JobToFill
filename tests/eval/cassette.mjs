// Every model call a run makes, kept in the run's cassette.jsonl: the messages and options sent, the reply (or the
// error) and how long it took. A replay serves the recorded replies back to the same pipelines, call by call, so
// graders can change and runs can be re-scored without a provider, a key or a cent.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** On a reply or error served from a cassette: the time the recorded call took, which a replay reports. */
export const REPLAYED = Symbol('replayed');

export class ReplayError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReplayError';
  }
}

/** Options as recorded: all but the abort signal. */
export function recordable(options) {
  const rest = { ...options };
  delete rest.signal;
  return rest;
}

export function promptHash(messages, options) {
  return createHash('sha256')
    .update(JSON.stringify({ messages, options: recordable(options) }))
    .digest('hex')
    .slice(0, 16);
}

/**
 * `chat` for one case, recorded: calls are numbered in the order the pipeline makes them (deterministic, even
 * when it waits on several at once), and each goes to `sink` once it settles. The messages are copied when sent:
 * the pipelines append to the same array for the next round.
 */
export function recording(chat, key, sink) {
  let next = 0;
  const calls = [];
  const wrapped = async (messages, options) => {
    const call = {
      case: key,
      i: next++,
      hash: promptHash(messages, options),
      messages: structuredClone(messages),
      options: recordable(options),
    };
    const started = performance.now();
    const took = (x) => (x && x[REPLAYED] != null ? x[REPLAYED] : Math.round(performance.now() - started));
    try {
      const r = await chat(messages, options);
      call.ms = took(r);
      call.reply = {
        text: r.text == null ? '' : r.text,
        json: r.json === undefined ? null : r.json,
        usage: r.usage || null,
        model: r.model || null,
        ...(r.fallback ? { fallback: r.fallback } : {}),
      };
      return r;
    } catch (err) {
      call.ms = took(err);
      call.error = {
        name: (err && err.name) || 'Error',
        message: String((err && err.message) || err),
        ...(err && err.code ? { code: err.code } : {}),
        ...(err && err.status ? { status: err.status } : {}),
      };
      throw err;
    } finally {
      calls.push(call);
      sink(call);
    }
  };
  return { chat: wrapped, calls };
}

/** A run's cassette: Map case → { calls: [by number], ms } (lines an aborted run cut short are skipped). */
export async function readCassette(dir) {
  const text = await readFile(path.join(dir, 'cassette.jsonl'), 'utf8');
  const cases = new Map();
  for (const line of text.split('\n')) {
    let rec;
    try {
      rec = line.trim() ? JSON.parse(line) : null;
    } catch (err) {
      rec = null;
    }
    if (!rec || !rec.case) continue;
    const c = cases.get(rec.case) || { calls: [], ms: null };
    if (rec.done) c.ms = rec.ms;
    else c.calls[rec.i] = rec;
    cases.set(rec.case, c);
  }
  return cases;
}

/**
 * `chat` for one case, served from a cassette: the case's recorded replies in order. A prompt that differs from
 * the recording is an error (the pipeline or the data changed) unless `loose`; a recorded error is thrown again,
 * as `makeError(recorded)` builds it.
 */
export function replaying(tape, key, { loose = false, makeError = (e) => new Error(e.message) } = {}) {
  const recorded = tape.get(key);
  let next = 0;
  const chat = async (messages, options) => {
    const i = next++;
    const call = recorded && recorded.calls[i];
    if (!call) throw new ReplayError(`${key}: no recorded call ${i + 1}`);
    if (!loose && call.hash !== promptHash(messages, options))
      throw new ReplayError(`${key}: call ${i + 1} sends a different prompt than the recording (--replay-loose)`);
    if (call.error) throw Object.assign(makeError(call.error), { [REPLAYED]: call.ms });
    return { ...structuredClone(call.reply), [REPLAYED]: call.ms };
  };
  chat.used = () => next;
  chat.recorded = () => (recorded ? recorded.calls.length : 0);
  chat.ms = () => (recorded ? recorded.ms : null);
  return chat;
}
