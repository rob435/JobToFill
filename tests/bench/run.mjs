// The detection benchmark: real application forms (a private corpus, see README.md) decided field by field with the
// extension's own rules (lib/decide.js), as the survey applicant, and scored against the answer expected of each.
//
//   node tests/bench/run.mjs [--corpus DIR] [--pages] [--only 58-alloyed,82-eastdil] [--save run.json]
//                            [--baseline run.json] [--draft] [--all]
//
// --pages reads each saved page again in Chromium with the current content/dom.js (scripts stripped, nothing loaded
// from the network); without it the fields are those captured on the live site, so only the rules are measured.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SURVEY_PROFILE } from '../live/profile.mjs';
import { compare, keysOf, outcomeOf, scoreForm, total } from './score.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { load } = require('../unit/helpers.js');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const corpus = path.resolve(option('--corpus') || process.env.JTF_BENCH || path.join(here, '../../../JobToFill-bench'));
const only = option('--only') ? new Set(option('--only').split(',')) : null;
// The day the forms were captured: "graduating in the next 12 months" and the like are answered as on that day.
const TODAY = new Date('2026-10-09T12:00:00Z');
// The documents the applicant has: a CV and a cover letter (no transcript).
const DOCS = { 'file.resume': true, 'file.coverLetter': true };
// The live capture kept a list's first 120 options: a longer one (countries) is only scored when read again (--pages).
const CAPTURED_OPTIONS = 120;
// Dropdowns whose options only load when opened (react-select, Teamtailor's menus) were captured without them: what
// the fill types into one is scored, but not which option it would land on.
const MENU_KINDS = new Set(['combo', 'combobox']);

if (!existsSync(path.join(corpus, 'forms'))) {
  console.error(`No corpus at ${corpus}: clone the benchmark's corpus there, or pass --corpus DIR (README.md).`);
  process.exit(2);
}

const J = load();
const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch (err) {
    return '';
  }
};
const profile = J.fields.upgradeProfile(structuredClone(SURVEY_PROFILE));

/**
 * A descriptor as content/dom.js makes it, from one captured on the live site, with the page's language and site
 * (how it writes dates when it doesn't say) from the form's meta.json.
 */
const fromLive = (d, meta) => ({
  lang: meta.lang || '',
  host: hostOf(meta.formUrl || meta.url),
  kind: d.kind,
  inputType: d.inputType || '',
  autocomplete: '',
  maxLength: 0,
  placeholderRaw: '',
  multiple: !!d.multiple,
  options:
    d.options && d.options.length ? d.options.map((o) => (typeof o === 'string' ? { text: o, value: o } : o)) : null,
  signals: d.signals || {},
});

/**
 * Each field of a frame as a fill would leave it. `jobLocation`: where the job is, as the fill knows it from the
 * posting ("Are you authorized to work in the country where this role is based?").
 */
function decideFrame(descs, { partialLists, jobLocation }) {
  const context = { today: TODAY, jobContext: true, jobLocation: jobLocation || '' };
  const entries = J.decide.page(descs, profile, { docs: DOCS, context });
  return descs.map((desc, i) => ({
    question: J.matcher.questionText(desc),
    kind: desc.kind,
    options: (desc.options || []).map((o) => o.text),
    type: entries[i].type,
    got: outcomeOf(entries[i]),
    partial: partialLists && (desc.options || []).length >= CAPTURED_OPTIONS,
    unseen: MENU_KINDS.has(desc.kind) && !(desc.options || []).length,
  }));
}

/** The forms' frames read again from their saved pages, in Chromium with the extension's current content scripts. */
async function readPages(ids) {
  const { launch } = await import('../e2e/harness.mjs');
  const h = await launch();
  const pages = new Map();
  await h.context.route('**/*', async (route) => {
    const url = route.request().url();
    if (pages.has(url))
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: pages.get(url) });
    if (/^(chrome-extension|data|blob):/.test(url) || url.startsWith('http://localhost')) return route.continue();
    return route.abort(); // nothing is fetched from the live sites: stylesheets and images stay out too
  });
  const out = new Map();
  for (const id of ids) {
    const file = path.join(corpus, 'forms', id, 'form.html');
    if (!existsSync(file)) continue;
    // Scripts out: the saved page is the widgets' finished markup, and nothing of the site's may run.
    const html = readFileSync(file, 'utf8')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/\son\w+="[^"]*"/gi, '');
    const url = `https://bench.test/${id}/`;
    pages.set(url, html);
    const page = await h.newPage();
    await page.goto(url);
    const tabId = await h.tabId(page);
    await h.bg((t) => globalThis.JTFBackground.callFrames(t, 'jobContext', []), tabId);
    const frames = await h.bg(async (t) => {
      const results = await globalThis.JTF.api.scripting.executeScript({
        target: { tabId: t, allFrames: true },
        func: () => ({ url: location.href, descs: globalThis.JTF.dom.collect(document).map((f) => f.desc) }),
      });
      return results.map((r) => r.result).filter(Boolean);
    }, tabId);
    // Where the job is, as the fill reads it from the page (its location line, Ashby's pane, JSON-LD).
    const [where] = await h.bg((t) => globalThis.JTFBackground.callFrames(t, 'jobLocation', [], [0]), tabId);
    out.set(id, { frames, jobLocation: (where && where.jobLocation) || '' });
    await page.close();
  }
  await h.close();
  return out;
}

const ids = readdirSync(path.join(corpus, 'forms'))
  .filter((id) => !only || only.has(id))
  .sort();
const pagesMode = flag('--pages');
const read = pagesMode ? await readPages(ids) : null;

const forms = [];
for (const id of ids) {
  const dir = path.join(corpus, 'forms', id);
  const meta = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const page = pagesMode ? read.get(id) || { frames: [], jobLocation: '' } : null;
  // The page's own location line, where the corpus has none (--write-meta keeps it for the runs without --pages).
  if (page && page.jobLocation && !meta.jobLocation) {
    meta.jobLocation = page.jobLocation;
    if (flag('--write-meta')) writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 1) + '\n');
  }
  const frames = pagesMode
    ? page.frames.map((f) => decideFrame(f.descs, { partialLists: false, jobLocation: meta.jobLocation }))
    : JSON.parse(readFileSync(path.join(dir, 'live.json'), 'utf8')).frames.map((f) =>
        decideFrame(
          (f.fields || []).map((d) => fromLive(d, meta)),
          { partialLists: true, jobLocation: meta.jobLocation },
        ),
      );
  const fields = frames.flat();
  const expectedFile = path.join(dir, 'expected.json');
  const expected = existsSync(expectedFile) ? JSON.parse(readFileSync(expectedFile, 'utf8')).fields : [];
  const scored = scoreForm(fields, expected);
  // A list cut short by the capture is scored only when it came out right; a menu whose options weren't captured, only
  // on whether something goes in (not on which option it would land on).
  scored.rows.forEach((row, i) => {
    const unseen = fields[i].unseen && row.verdict === 'wrong' && row.got.outcome === 'fill' && row.expect.fill != null;
    if (!(fields[i].partial || unseen) || row.verdict === 'right' || row.verdict === 'unscored') return;
    scored.counts[row.verdict]--;
    scored.counts.unscored++;
    row.verdict = 'unscored';
  });
  forms.push({ id, company: meta.company, system: meta.system, ...scored, fields });
  // A first draft of the expected answers, from what the rules do now, for a person to correct (README.md).
  if (flag('--draft')) {
    const keys = keysOf(fields);
    const draft = fields.map((f, i) => ({
      key: keys[i],
      question: f.question.slice(0, 300),
      kind: f.kind,
      options: f.options,
      type: f.type,
      expect: f.got.outcome === 'fill' ? { fill: f.got.text } : { [f.got.outcome === 'ai' ? 'ai' : 'empty']: true },
    }));
    writeFileSync(path.join(dir, 'expected.draft.json'), JSON.stringify({ fields: draft }, null, 1) + '\n');
  }
}

/* ------------------------------------------------------------------ report */

const pct = (x) => `${(100 * x).toFixed(1)}%`;
const show = (got) =>
  got.outcome === 'fill' ? JSON.stringify(got.text) : `(${got.outcome}${got.why ? ': ' + got.why : ''})`;
const want = (e) =>
  !e ? '(none)' : e.fill != null ? JSON.stringify(e.fill) : e.ai ? '(ai)' : e.empty ? '(empty)' : '(not filled)';

console.log(`Benchmark: ${forms.length} forms, ${pagesMode ? 'read again from their pages' : 'as captured live'}`);
console.log('');
console.log('form'.padEnd(36) + 'system'.padEnd(14) + 'right  wrong  missed  routed  unscored  lost');
for (const f of forms) {
  const c = f.counts;
  console.log(
    f.id.slice(0, 35).padEnd(36) +
      String(f.system || '')
        .slice(0, 13)
        .padEnd(14) +
      [c.right, c.wrong, c.missed, c.routed, c.unscored, f.lost.length]
        .map((n, i) => String(n).padStart([5, 7, 8, 8, 10, 6][i]))
        .join(''),
  );
}
const t = total(forms);
console.log('');
console.log(
  `Right ${t.counts.right} of ${t.scored} scored (${pct(t.score)}): wrong ${t.counts.wrong}, missed ${t.counts.missed}, ` +
    `routed ${t.counts.routed}; unscored ${t.counts.unscored}; expected but not found ${t.lost}.`,
);

// What isn't right, wrong values first: every field with --all, else the wrong and missed ones.
const listed = flag('--all') ? ['wrong', 'missed', 'routed'] : ['wrong', 'missed'];
for (const v of listed) {
  const rows = forms.flatMap((f) => f.rows.filter((r) => r.verdict === v).map((r) => ({ f, r })));
  if (!rows.length) continue;
  console.log(`\n${v.toUpperCase()} (${rows.length})`);
  for (const { f, r } of rows)
    console.log(
      `  ${f.id}  ${r.key.slice(0, 70)}  → ${show(r.got)}  expected ${want(r.expect)}${r.type ? `  [${r.type}]` : ''}`,
    );
}

const result = {
  mode: pagesMode ? 'pages' : 'live',
  when: new Date().toISOString(),
  total: t,
  forms: forms.map((f) => ({ id: f.id, counts: f.counts, lost: f.lost, rows: f.rows })),
};
if (option('--baseline')) {
  const before = JSON.parse(readFileSync(option('--baseline'), 'utf8'));
  const d = compare(before, result);
  console.log(
    `\nSince ${option('--baseline')}: ${d.better.length} better, ${d.worse.length} worse, ${d.moved.length} changed.`,
  );
  for (const [name, rows] of [
    ['WORSE', d.worse],
    ['BETTER', d.better],
    ['CHANGED', d.moved],
  ]) {
    if (!rows.length) continue;
    console.log(name);
    for (const r of rows) console.log(`  ${r.form}  ${r.key.slice(0, 70)}  ${show(r.from.got)} → ${show(r.to.got)}`);
  }
  if (d.worse.length) process.exitCode = 1;
}
if (option('--save')) writeFileSync(option('--save'), JSON.stringify(result) + '\n');
