// The AI eval: the extension's own answer and cover letter pipelines (answers.js, letter.js) on the frozen datasets,
// through the extension's own chat client (ai.js), every model call recorded. Writes tests/eval/runs/<stamp>-<name>/
// with config.json, cassette.jsonl (the calls), results.json (per case and question) and summary.json.
//
//   node tests/eval/run.mjs --suite answers|letters|all --provider openrouter|deepseek|custom --model <id>
//        [--base-url https://…] [--split train|test|all] [--cases N] [--reps N] [--concurrency 4] [--label name]
//        [--judge] [--out dir]
//   node tests/eval/run.mjs --replay <runDir> [--replay-loose] [--judge]   the recorded replies, no provider
//   node tests/eval/run.mjs --provider fake --model oracle|null            scripted replies: a harness check
//
// Keys come from the environment: OPENROUTER_API_KEY, DEEPSEEK_API_KEY, AI_API_KEY (custom); ANTHROPIC_API_KEY for
// the judge.
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEngine } from '../live/survey-api.mjs';
import { readCassette, recording, replaying, ReplayError } from './cassette.mjs';
import { candidate, DATA, loadCases, loadData, TODAY, TODAY_MS } from './dataset.mjs';
import { fakeChat } from './fake.mjs';
import * as grade from './grade.mjs';
import { callCost, tokens } from './prices.mjs';
import { formatScoreboard, scoreboardRows } from './scoreboard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const RUNS = path.join(here, 'runs');
export const KEYS = { openrouter: 'OPENROUTER_API_KEY', deepseek: 'DEEPSEEK_API_KEY', custom: 'AI_API_KEY' };
const SUITES = ['answers', 'letters'];
// ai.js's error codes every later case would hit too: a rejected key, no credit, an unknown model, no address.
const FATAL = new Set(['key', 'credit', 'model', 'setup']);

export function parseArgs(argv) {
  const out = {};
  argv.forEach((a, i) => {
    if (!a.startsWith('--')) return;
    const [k, v] = a.slice(2).split('=');
    const next = argv[i + 1];
    out[k] = v != null ? v : next != null && !next.startsWith('--') ? next : true;
  });
  return out;
}

/** The provider config the extension would build, with the key from the environment; throws what's missing. */
export function providerConfig(JTF, { provider, model, baseUrl }, env = process.env) {
  if (!KEYS[provider]) throw new Error(`Unknown provider “${provider}”: openrouter, deepseek, custom or fake.`);
  const label = JTF.ai.PROVIDERS[provider].label;
  const config = { provider, model: model || '', baseUrl: baseUrl || '', apiKey: env[KEYS[provider]] || '' };
  if (!config.apiKey.trim()) throw new Error(`Set ${KEYS[provider]} to run against ${label}.`);
  const bad = JTF.ai.problem(config);
  if (bad) throw new Error(`${label}: ${bad}${provider === 'custom' ? ' (--base-url, --model)' : ''}`);
  return config;
}

const slug = (s) =>
  String(s || 'run')
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

async function fileHash(name) {
  return createHash('sha256')
    .update(await readFile(path.join(DATA, `${name}.json`)))
    .digest('hex')
    .slice(0, 12);
}

/** Answer one form's leftover questions, as the extension does after a fill. */
async function runAnswers(JTF, form, chat, signal) {
  const { profile, kit, cvText } = candidate(JTF, form.kit);
  // As background.js gives it: the answer guidance in settings and the profile's extra details.
  const guidance = [kit.answerNotes, profile.extraDetails]
    .map((x) => String(x || '').trim())
    .filter(Boolean)
    .join('\n\n');
  const job = {
    company: form.company,
    title: form.title,
    location: form.location,
    url: form.url,
    description: form.description,
    companyNotes: form.companyNotes,
  };
  const items = form.items.map(({ label, ...item }) => item);
  const out = await JTF.answers.answer(
    chat,
    { profile, kit, cvText, job, bank: [], guidance, today: TODAY_MS },
    items,
    { signal },
  );
  return { questions: grade.gradeAnswers(form, out, (it) => JTF.answers.answerKind(it)) };
}

/** Read the posting and write the letter, as the studio does. */
async function runLetter(JTF, p, chat, signal) {
  const L = JTF.letter;
  const { profile, kit, cvText } = candidate(JTF, p.kit);
  const posting = { company: p.company, title: p.title, location: p.location, url: p.url, description: p.description };
  const context = { url: p.url, title: p.title, company: p.company };
  const analysis = await L.analyse(chat, posting, context, { signal });
  const seen = { isPosting: analysis.isPosting, company: analysis.company, role: analysis.role };
  if (!analysis.isPosting) return { analysis: seen, grade: grade.gradeLetter(analysis) };
  const result = await L.write(
    chat,
    { profile, kit, cvText, posting, analysis, context, instructions: '', today: TODAY_MS },
    { signal },
  );
  return {
    analysis: seen,
    letter: result.letter,
    check: { errors: result.check.errors, warnings: result.check.warnings, severe: result.check.severe || 0 },
    attempts: result.attempts,
    grade: grade.gradeLetter(analysis, result),
  };
}

/** A call as results.json keeps it (the full exchange is in the cassette). */
function callSummary(call, model) {
  const served = (call.reply && call.reply.model) || model;
  const c = call.reply ? callCost(call.reply.usage, served) : { cost: null };
  return {
    i: call.i,
    model: served,
    ms: call.ms,
    cost: c.cost,
    tokens: call.reply && call.reply.usage ? tokens(call.reply.usage) : null,
    ...(call.error ? { error: `${call.error.name}: ${call.error.message}` } : {}),
    ...(call.reply && call.reply.fallback ? { fallback: call.reply.fallback } : {}),
  };
}

/** Per-suite numbers for a set of rows: quality, cost and time, and the judge's grades. */
export function summarise(rows) {
  const out = {};
  for (const suite of SUITES) {
    const of = rows.filter((r) => r.suite === suite);
    if (!of.length) continue;
    const quality = suite === 'answers' ? grade.aggregateAnswers : grade.aggregateLetters;
    const judged = (list) => list.flatMap((r) => [r.judge, ...(r.questions || []).map((q) => q.judge)]).filter(Boolean);
    const numbers = (list) => ({
      ...quality(list),
      cost: grade.aggregateCost(list),
      judge: grade.aggregateJudge(judged(list)),
    });
    const bySplit = {};
    for (const split of ['train', 'test']) {
      const part = of.filter((r) => r.split === split);
      if (part.length) bySplit[split] = numbers(part);
    }
    out[suite] = { ...numbers(of), bySplit };
  }
  return out;
}

/**
 * Run the suites. Options: suite, split, cases (per suite), reps, concurrency, label, provider, model, baseUrl,
 * replay (a run directory), loose, judge, out (runs directory), chat (a stand-in model, for tests), judgeClient,
 * env, signal, log. Returns { dir, results, summary }.
 */
export async function runEval(opts = {}) {
  const log = opts.log || console.log;
  const env = opts.env || process.env;
  const JTF = loadEngine();
  const source = opts.replay ? JSON.parse(await readFile(path.join(opts.replay, 'config.json'), 'utf8')) : null;
  // A replay runs the recorded run's cases unless told otherwise (and judges only when asked to again).
  const recorded = source
    ? Object.fromEntries(['suite', 'split', 'cases', 'reps', 'concurrency', 'label'].map((k) => [k, source[k]]))
    : {};
  const o = { ...recorded, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) };
  const suites = !o.suite || o.suite === 'all' ? SUITES : [o.suite];
  if (suites.some((s) => !SUITES.includes(s))) throw new Error(`--suite is answers, letters or all, not “${o.suite}”.`);
  const split = o.split || 'all';
  const reps = Math.max(1, +o.reps || 1);

  let base = null;
  let model;
  let baseUrl = '';
  const forms = (await loadData('answers')).forms;
  if (source) model = source.model;
  else if (opts.chat) model = o.model || 'stand-in';
  else if (o.provider === 'fake') {
    model = `fake-${o.model || 'oracle'}`;
    base = fakeChat(o.model || 'oracle', { forms });
  } else {
    const config = providerConfig(
      JTF,
      { provider: o.provider || 'openrouter', model: o.model, baseUrl: o.baseUrl },
      env,
    );
    const resolved = JTF.ai.resolve(config);
    model = resolved.model;
    baseUrl = resolved.base;
    base = (messages, options) => JTF.ai.chat(config, { messages, ...options });
  }
  if (opts.chat) base = opts.chat;
  const tape = source ? await readCassette(opts.replay) : null;

  const name = opts.replay ? `replay-${slug(source.label || source.model)}` : slug(o.label || model);
  const dir = path.join(o.out || RUNS, `${new Date().toISOString().replace(/[:.]/g, '-')}-${name}`);
  await mkdir(dir, { recursive: true });
  const config = {
    suite: o.suite || 'all',
    split,
    cases: +o.cases || null,
    reps,
    concurrency: +o.concurrency || 4,
    provider: source ? source.provider : o.provider || (opts.chat ? 'stand-in' : 'openrouter'),
    model,
    baseUrl: source ? source.baseUrl : baseUrl,
    label: o.label || null,
    judge: !!o.judge,
    replayOf: opts.replay ? path.relative(process.cwd(), opts.replay) : null,
    loose: !!o.loose,
    today: TODAY,
    data: { answers: await fileHash('answers'), letters: await fileHash('letters') },
    started: new Date().toISOString(),
    node: process.version,
  };
  await writeFile(path.join(dir, 'config.json'), JSON.stringify(config, null, 1));

  const cassette = createWriteStream(path.join(dir, 'cassette.jsonl'), { flags: 'a' });
  const record = (rec) => cassette.write(JSON.stringify(rec) + '\n');
  const tasks = [];
  for (const suite of suites)
    for (const c of await loadCases(suite, { split, limit: +o.cases }))
      for (let rep = 1; rep <= reps; rep++) tasks.push({ ...c, rep, key: `${suite}/${c.id}#${rep}` });
  const byKey = new Map(tasks.map((t) => [`${t.suite}/${t.id}`, t.data]));

  const rows = [];
  let saving = Promise.resolve();
  const save = (partial) =>
    (saving = saving.then(() =>
      writeFile(path.join(dir, 'results.json'), JSON.stringify({ run: config, partial, cases: sorted(rows) }, null, 1)),
    ));
  const sorted = (list) =>
    [...list].sort((a, b) => a.suite.localeCompare(b.suite) || a.id.localeCompare(b.id) || a.rep - b.rep);

  async function runTask(t) {
    const chat = tape
      ? replaying(tape, t.key, { loose: o.loose, makeError: (e) => new JTF.ai.AIError(e.message, e) })
      : base;
    const rec = recording(chat, t.key, record);
    const started = performance.now();
    const row = { suite: t.suite, id: t.id, rep: t.rep, split: t.split, company: t.data.company, title: t.data.title };
    try {
      const run = t.suite === 'answers' ? runAnswers : runLetter;
      Object.assign(row, await run(JTF, t.data, rec.chat, opts.signal));
      row.error = null;
    } catch (err) {
      row.error = `${err.name || 'Error'}: ${err.message || err}`;
      // rate, credit, network, timeout, json, key, model (ai.js's codes), AbortError, …: plumbing or the model?
      row.errorCode = err.code || err.name || 'Error';
    }
    // A replay that strays from the recording fails the case, even where the pipeline shrugs off a failed call.
    const strayed = rec.calls.find((c) => c.error && c.error.name === ReplayError.name);
    if (strayed && !row.error) row.error = `ReplayError: ${strayed.error.message}`;
    if (tape && !row.error && chat.used() !== chat.recorded())
      row.error = `ReplayError: ${t.key}: used ${chat.used()} of ${chat.recorded()} recorded calls`;
    if (row.error && /^ReplayError/.test(row.error)) row.errorCode = 'ReplayError';
    row.ms = tape && chat.ms() != null ? chat.ms() : Math.round(performance.now() - started);
    row.calls = rec.calls.sort((a, b) => a.i - b.i).map((c) => callSummary(c, model));
    if (!row.error) record({ case: t.key, done: true, ms: row.ms });
    rows.push(row);
    await save(true);
    log(
      `${row.error ? '✗' : '✓'} ${t.key} ${(row.ms / 1000).toFixed(1)}s ${row.calls.length} calls${row.error ? ` ${row.error}` : ''}`,
    );
  }

  const began = performance.now();
  const queue = [...tasks];
  let fatal = null;
  const workers = Array.from({ length: Math.max(1, +o.concurrency || 4) }, async () => {
    while (queue.length && !fatal && !(opts.signal && opts.signal.aborted)) {
      await runTask(queue.shift());
      const last = rows[rows.length - 1];
      if (last && FATAL.has(last.errorCode) && !fatal) {
        fatal = last.error;
        log(`Stopping: ${fatal}`);
      }
    }
  });
  await Promise.all(workers);
  const partial = rows.length < tasks.length || !!(opts.signal && opts.signal.aborted);

  let judgeGrades = [];
  if (o.judge && partial) log('Judge skipped: the run stopped before every case was done.');
  if (o.judge && !partial) {
    const client = opts.judgeClient || (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN ? await anthropic() : null);
    if (!client) log('Judge skipped: set ANTHROPIC_API_KEY to grade written answers and letters with Claude.');
    else {
      const J = await import('./judge.mjs');
      const cache = new Map();
      if (opts.replay)
        for (const line of (await readFile(path.join(opts.replay, 'judge.jsonl'), 'utf8').catch(() => '')).split('\n'))
          if (line.trim()) {
            const { key, grade: g } = JSON.parse(line);
            cache.set(key, g);
          }
      const judged = createWriteStream(path.join(dir, 'judge.jsonl'), { flags: 'a' });
      const { profile, kit, cvText } = candidate(JTF);
      judgeGrades = await J.judgeRows(rows, {
        client,
        system: J.judgeSystem(JTF.answers.candidateText({ profile, kit, cvText })),
        jobs: (row) => byKey.get(`${row.suite}/${row.id}`),
        cache,
        sink: (r) => judged.write(JSON.stringify(r) + '\n'),
        concurrency: +o.concurrency || 4,
        log,
      });
      await new Promise((r) => judged.end(r));
    }
  }

  await new Promise((r) => cassette.end(r));
  const results = { run: config, partial, cases: sorted(rows) };
  await save(partial);
  await saving;
  const paid = judgeGrades.filter((g) => !g.cached);
  const sum = (f) => paid.reduce((a, g) => a + (f(g) || 0), 0);
  const summary = {
    run: { ...config, finished: new Date().toISOString(), ms: Math.round(performance.now() - began) },
    partial,
    suites: summarise(results.cases),
    // Apart from the runs' own cost: what grading them cost, and how much of the rubric came from the cache.
    judge: judgeGrades.length
      ? {
          model: 'claude-opus-5-5',
          grades: judgeGrades.length,
          calls: paid.length,
          cost: sum((g) => g.cost),
          inputTokens: sum((g) => g.usage && g.usage.input_tokens),
          cacheReadTokens: sum((g) => g.usage && g.usage.cache_read_input_tokens),
          outputTokens: sum((g) => g.usage && g.usage.output_tokens),
        }
      : null,
  };
  await writeFile(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 1));
  return { dir, results, summary };
}

async function anthropic() {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  return new Anthropic();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const controller = new AbortController();
  // Ctrl-C: stop starting cases, abandon the calls in flight, and still write what's done.
  process.once('SIGINT', () => {
    console.log('\nStopping: writing the results so far…');
    controller.abort(Object.assign(new Error('Stopped.'), { name: 'AbortError' }));
  });
  const { dir, summary } = await runEval({
    suite: args.suite,
    split: args.split,
    cases: args.cases,
    reps: args.reps,
    concurrency: args.concurrency,
    label: args.label && args.label !== true ? args.label : undefined,
    provider: args.provider,
    model: args.model && args.model !== true ? args.model : undefined,
    baseUrl: args['base-url'],
    replay: args.replay && args.replay !== true ? args.replay : undefined,
    loose: args['replay-loose'] ? true : undefined,
    judge: args.judge ? true : undefined,
    out: args.out,
    signal: controller.signal,
  });
  console.log();
  console.log(formatScoreboard(scoreboardRows([{ dir, summary }])));
  const served = new Set(Object.values(summary.suites).flatMap((s) => s.cost.models));
  served.delete(summary.run.model);
  if (served.size) console.log(`served by ${[...served].join(', ')} (asked for ${summary.run.model})`);
  const j = summary.judge;
  if (j)
    console.log(
      `judge (${j.model}): ${j.grades} grades, ${j.calls} calls, $${j.cost.toFixed(4)}, ${j.cacheReadTokens} cached input tokens`,
    );
  console.log(`${summary.partial ? 'Partial results' : 'Results'} in ${path.relative(process.cwd(), dir)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  await main().catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  });
