// What JobToFill would answer on live application forms listed on Trackr, without a browser: each form's
// questions come from its job board's public API (forms.mjs) and go through the same classification, value
// resolution and option matching as a real fill. Prints the questions left unanswered, most common first.
//
//   node tests/live/survey-api.mjs [--limit 120] [--out report.json] [--region UK] [--industry Finance]
//   node tests/live/survey-api.mjs --from report.json      re-run the engine on forms fetched before
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveForm } from './forms.mjs';
import { SURVEY_PROFILE } from './profile.mjs';
import { trackrTargets } from './trackr.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

export function loadEngine() {
  const { load } = require('../unit/helpers.js');
  const JTF = load();
  for (const f of ['ai', 'letter', 'answers']) {
    try {
      require(path.join(here, '..', '..', 'extension', 'lib', f + '.js'));
    } catch (err) {
      if (err.code !== 'MODULE_NOT_FOUND') throw err;
    }
  }
  return JTF;
}

const FOLLOW_UP = /^if (yes|so|you (said|answered|selected|chose|checked|ticked) yes)\b/;
const CHOICE = new Set(['select', 'radio', 'combo', 'combobox']);

/**
 * What a fill would do with each question: { outcome, type, answer } where outcome is filled | missing |
 * nomatch | unknown | consent | skipped | file.
 */
export function simulate(JTF, descs, profile, settings = {}) {
  const { matcher, fields, util } = JTF;
  const { results, context } = matcher.plan(descs, profile);
  return descs.map((d, i) => {
    const r = results[i];
    const q = util.normalize(matcher.questionText(d));
    if (d.kind === 'file') return { outcome: r && r.type ? 'file' : 'unknown', type: r && r.type };
    if (!r || !r.type) return { outcome: 'unknown', type: null, dropped: r && r.dropped };
    const def = fields.DEFS[r.type];
    if (r.type !== 'custom' && def && def.consent && !settings.consents) return { outcome: 'consent', type: r.type };
    const v = fields.resolve(r.type, profile, {
      ...context,
      index: r.index || 0,
      part: r.part,
      kind: d.kind,
      answer: r.answer,
      question: q,
      consents: !!settings.consents,
      today: settings.today,
    });
    if (v && r.type !== 'custom' && FOLLOW_UP.test(q) && !fields.followUpAnswer(v, d.kind))
      return { outcome: 'skipped', type: r.type };
    if (!v) return { outcome: 'missing', type: r.type };
    const opts = d.options || [];
    if (CHOICE.has(d.kind) && opts.length) {
      const idx = matcher.matchOption(opts, v);
      return idx < 0
        ? { outcome: 'nomatch', type: r.type, value: v.text }
        : { outcome: 'filled', type: r.type, answer: opts[idx].text };
    }
    if (d.kind === 'checkboxes') {
      let picks = v.kind === 'list' ? matcher.matchAll(opts, v) : [];
      if (!picks.length) {
        const idx = matcher.matchOption(opts, v);
        picks = idx >= 0 ? [idx] : matcher.matchAll(opts, v);
      }
      return picks.length
        ? { outcome: 'filled', type: r.type, answer: picks.map((p) => opts[p].text).join('; ') }
        : { outcome: 'nomatch', type: r.type, value: v.text };
    }
    if (d.kind === 'checkbox') {
      const tick = v.kind === 'list' ? matcher.matchAll(opts, v).length > 0 : v.canonical === 'yes';
      return tick ? { outcome: 'filled', type: r.type, answer: 'ticked' } : { outcome: 'skipped', type: r.type };
    }
    const text = matcher.formatForText(v, d);
    return text ? { outcome: 'filled', type: r.type, answer: text } : { outcome: 'nomatch', type: r.type };
  });
}

function parseArgs() {
  return Object.fromEntries(
    process.argv.slice(2).map((a, i, all) => {
      if (!a.startsWith('--')) return [];
      const [k, v] = a.slice(2).split('=');
      const next = all[i + 1];
      return [k, v != null ? v : next && !next.startsWith('--') ? next : true];
    }),
  );
}

export async function fetchForms({ limit = 120, regions, industries, onForm } = {}) {
  const targets = await trackrTargets({
    regions,
    industries,
    hosts: ['greenhouse', 'grnh.se', 'ashbyhq', 'lever.co'],
  });
  const forms = [];
  // A few at a time: the boards' APIs are public but rate-limited.
  const queue = targets.slice(0, limit);
  async function worker() {
    while (queue.length) {
      const t = queue.shift();
      const form = await liveForm(t.url).catch((err) => ({ error: String(err.message || err) }));
      const entry = { ...t, ...(form || { error: 'no form' }) };
      forms.push(entry);
      if (onForm) onForm(entry);
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  return forms;
}

/** The questions a fill would leave empty, as the content script reports them for AI answers. */
export function leftovers(JTF, form) {
  const items = [];
  form.questions.forEach((q, i) => {
    const r = form.results[i];
    if (!['unknown', 'nomatch', 'missing'].includes(r.outcome) || q.kind === 'file') return;
    const options = (q.options || [])
      .map((o) => o.text)
      .filter((t) => t && !JTF.matcher.isPlaceholder(JTF.util.normalize(t)));
    const before = form.questions[i - 1];
    items.push({
      id: String(i),
      question: q.signals.label || q.signals.question || '',
      help: q.signals.describedby || '',
      kind: q.kind,
      options: options.length ? options : null,
      multiple: q.kind === 'checkboxes',
      maxLength: q.maxLength || 0,
      required: q.required,
      section: q.signals.section || '',
      follows: before
        ? { question: before.signals.label || before.signals.question || '', answer: form.results[i - 1].answer || '' }
        : null,
      guess: r.outcome === 'nomatch' ? { type: r.type, value: r.value } : null,
    });
  });
  return items;
}

async function answerForms(JTF, forms, args) {
  const { SURVEY_CV } = await import('./profile.mjs');
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('--ai needs OPENROUTER_API_KEY in the environment');
  const config = { provider: 'openrouter', apiKey, model: args.model && args.model !== true ? args.model : '' };
  let cost = 0;
  const chat = async (messages, options) => {
    const r = await JTF.ai.chat(config, { messages, ...options });
    if (r.usage && typeof r.usage.cost === 'number') cost += r.usage.cost;
    return r;
  };
  const profile = JTF.fields.upgradeProfile(structuredClone(SURVEY_PROFILE));
  const kit = { notes: '', samples: [], answerNotes: args.guidance && args.guidance !== true ? args.guidance : '' };
  const read = forms.filter((f) => f.results);
  const pick = read.slice(+args.skip || 0, (+args.skip || 0) + (+args.forms || 8));
  const tally = { asked: 0, answered: 0, skipped: 0, ms: 0 };
  for (const f of pick) {
    const items = leftovers(JTF, f);
    if (!items.length) continue;
    const started = Date.now();
    const out = await JTF.answers
      .answer(
        chat,
        {
          profile,
          kit,
          cvText: SURVEY_CV,
          job: {
            company: f.company,
            title: f.title || f.name,
            description: f.description,
            companyNotes: f.companyNotes,
          },
          today: new Date('2026-10-02').getTime(),
        },
        items,
      )
      .catch((err) => ({ error: err.message, answers: [], skipped: [] }));
    const ms = Date.now() - started;
    Object.assign(tally, {
      asked: tally.asked + items.length,
      answered: tally.answered + out.answers.length,
      skipped: tally.skipped + out.skipped.length,
      ms: tally.ms + ms,
    });
    f.ai = out;
    console.log(
      `\n=== ${f.company} — ${f.title || f.name} (${items.length} questions, ${(ms / 1000).toFixed(1)}s)${out.error ? ' ERROR ' + out.error : ''}`,
    );
    for (const it of items) {
      const a = out.answers.find((x) => x.id === it.id);
      const s = out.skipped.find((x) => x.id === it.id);
      console.log(
        `Q: ${it.question.slice(0, 160)}${it.options ? `  [${it.options.slice(0, 6).join(' / ')}${it.options.length > 6 ? ' …' : ''}]` : ''}`,
      );
      if (a)
        console.log(
          `A (${a.basis}${a.warnings.length ? '; ' + a.warnings.join('; ') : ''}): ${Array.isArray(a.value) ? a.value.join('; ') : a.value}`,
        );
      else console.log(`   skipped: ${s ? s.reason : '?'}`);
    }
  }
  console.log(
    `\nAI: ${tally.answered} answered, ${tally.skipped} skipped of ${tally.asked}; ${(tally.ms / 1000).toFixed(0)}s; $${cost.toFixed(4)}`,
  );
}

async function main() {
  const args = parseArgs();
  const JTF = loadEngine();
  const out = args.out || path.join(here, 'survey-api-report.json');
  const forms = args.from
    ? JSON.parse(await readFile(args.from, 'utf8'))
    : await fetchForms({
        limit: +args.limit || 120,
        regions: args.region ? String(args.region).split(',') : undefined,
        industries: args.industry ? String(args.industry).split(',') : undefined,
        onForm: (f) => process.stdout.write(f.questions ? '.' : 'x'),
      });
  console.log();
  const profile = JTF.fields.upgradeProfile(structuredClone(SURVEY_PROFILE));
  const tally = {};
  const empty = new Map();
  for (const f of forms) {
    if (!f.questions) continue;
    const sim = simulate(JTF, f.questions, profile, { today: new Date('2026-10-02') });
    f.results = sim;
    sim.forEach((s, i) => {
      tally[s.outcome] = (tally[s.outcome] || 0) + 1;
      if (!['unknown', 'missing', 'nomatch'].includes(s.outcome)) return;
      const q = f.questions[i];
      const label = q.signals.label || q.signals.question || '';
      const key = `${s.outcome} ${s.type || ''} | ${q.kind} | ${label.slice(0, 120)}`;
      const e = empty.get(key) || {
        n: 0,
        required: 0,
        options: q.options && q.options.map((o) => o.text).slice(0, 8),
        companies: [],
      };
      e.n++;
      if (q.required) e.required++;
      if (e.companies.length < 4) e.companies.push(f.company);
      empty.set(key, e);
    });
  }
  if (args.ai) await answerForms(JTF, forms, args);
  await writeFile(out, JSON.stringify(forms, null, 1));
  const read = forms.filter((f) => f.questions);
  console.log(
    `${read.length} forms read (${forms.length - read.length} not), ${read.reduce((n, f) => n + f.questions.length, 0)} questions`,
  );
  console.log(tally);
  for (const [k, e] of [...empty].sort((a, b) => b[1].n - a[1].n).slice(0, +args.top || 80))
    console.log(
      `${String(e.n).padStart(3)} (${e.required} req) ${k}${e.options ? '  [' + e.options.join(' / ') + ']' : ''}`,
    );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
