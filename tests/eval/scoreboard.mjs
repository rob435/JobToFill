// The eval's runs side by side: one line per run and suite, from each run's summary.json.
//
//   node tests/eval/scoreboard.mjs [runDir…] [--split train|test]     default: every run in tests/eval/runs
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'runs');

const pct = (x) => (x == null ? '-' : `${Math.round(x * 100)}%`);
const num = (x) => (x == null ? '-' : String(x));
const money = (x, unpriced) => (x == null ? '?' : `$${x < 0.1 ? x.toFixed(4) : x.toFixed(2)}${unpriced ? '+?' : ''}`);

function judgeText(j) {
  if (!j) return '-';
  const scores = [j.answersQuestion, j.specificity, j.voice, j.structure, j.fit]
    .filter((x) => x != null)
    .map((x) => x.toFixed(1));
  return `${pct(j.supportedRate)} ${scores.join('/')}${j.unavailable ? ` (${j.unavailable} n/a)` : ''}`;
}

/** Table rows for runs ({ dir, summary }), for the run's own split or, from its per-split numbers, `split`. */
export function scoreboardRows(runs, { split } = {}) {
  const rows = [];
  for (const { summary } of runs) {
    const run = summary.run || {};
    const name = `${run.label || run.model}${run.fast && !run.label ? ' (fast)' : ''}`;
    for (const [suite, all] of Object.entries(summary.suites || {})) {
      const s = split && split !== run.split ? all.bySplit && all.bySplit[split] : all;
      if (!s) continue;
      const answers = suite === 'answers';
      const cost = s.cost || {};
      rows.push({
        run: `${name}${run.replayOf ? ' (replay)' : ''}${summary.partial ? ' (partial)' : ''}`,
        suite,
        split: split || run.split,
        // Rows are cases × reps.
        cases: `${run.reps > 1 ? `${Math.ceil(s.cases / run.reps)}×${run.reps}` : s.cases}${s.errors ? ` (${s.errors} err)` : ''}`,
        coverage: answers ? pct(s.coverage) : '-',
        safe: answers ? pct(s.safeRate) : '-',
        violations: answers ? `${s.violations} (${pct(s.violationRate)})` : '-',
        misses: answers ? num(s.misses) : '-',
        dropped: answers ? num(s.dropped) : '-',
        pass: answers ? '-' : pct(s.passRate),
        judge: judgeText(s.judge),
        cost: money(cost.cost, cost.unpriced),
        perCase: money(cost.costPerCase, cost.unpriced),
        latency: cost.meanMs == null ? '-' : `${(cost.meanMs / 1000).toFixed(1)}s`,
      });
    }
  }
  return rows;
}

const COLUMNS = [
  ['run', 'run'],
  ['suite', 'suite'],
  ['split', 'split'],
  ['cases', 'cases'],
  ['coverage', 'cover'],
  ['safe', 'safe'],
  ['violations', 'violations'],
  ['misses', 'miss'],
  ['dropped', 'drop'],
  ['pass', 'letters'],
  ['judge', 'judge sup q/spec/voice[/struct/fit]'],
  ['cost', 'cost'],
  ['perCase', '$/case'],
  ['latency', 'mean'],
];

export function formatScoreboard(rows) {
  if (!rows.length) return 'No runs yet.';
  const width = COLUMNS.map(([k, title]) => Math.max(title.length, ...rows.map((r) => String(r[k]).length)));
  const line = (cells) =>
    cells
      .map((c, i) => (i < 3 ? String(c).padEnd(width[i]) : String(c).padStart(width[i])))
      .join('  ')
      .trimEnd();
  return [line(COLUMNS.map(([, t]) => t)), ...rows.map((r) => line(COLUMNS.map(([k]) => r[k])))].join('\n');
}

export async function readRun(dir) {
  const summary = await readFile(path.join(dir, 'summary.json'), 'utf8').then(JSON.parse, () => null);
  return summary && { dir, summary };
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--split');
  const split = at >= 0 ? args[at + 1] : undefined;
  let dirs = args.filter((a, i) => !a.startsWith('--') && !(at >= 0 && i === at + 1));
  if (!dirs.length)
    dirs = (await readdir(RUNS, { withFileTypes: true }).catch(() => []))
      .filter((d) => d.isDirectory())
      .map((d) => path.join(RUNS, d.name))
      .sort();
  const runs = (await Promise.all(dirs.map(readRun))).filter(Boolean);
  console.log(formatScoreboard(scoreboardRows(runs, { split })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
