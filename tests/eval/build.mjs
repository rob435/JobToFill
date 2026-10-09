// Builds the eval's frozen datasets (tests/eval/data/) from live application forms: the questions a fill leaves
// for the AI on forms listed on Trackr, read through the job boards' public APIs with the survey's own code
// (tests/live/), and the postings behind them, read the way the extension reads them (jobpage.js). Labels are
// written by hand (see README.md); a rebuild keeps them for every question that hasn't changed.
//
//   node tests/eval/build.mjs [--forms 40] [--letters 12] [--limit 250] [--region UK,US] [--industry Finance]
//                             [--save raw.json]
//   node tests/eval/build.mjs --from a.json,b.json [--offline]
//                             forms fetched before (--save, or survey-api.mjs --out), merged; --offline: no
//                             network, so forms saved without their posting keep the board's description
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import * as prettier from 'prettier';
import { liveForm } from '../live/forms.mjs';
import { SURVEY_PROFILE } from '../live/profile.mjs';
import { leftovers, loadEngine, simulate } from '../live/survey-api.mjs';
import { trackrTargets } from '../live/trackr.mjs';
import { DATA, TODAY } from './dataset.mjs';

const require = createRequire(import.meta.url);
const DESCRIPTION_MAX = 12000;
const HOSTS = ['greenhouse', 'grnh.se', 'ashbyhq', 'lever.co'];

export const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const slug = (s) => norm(s).replace(/ /g, '-').slice(0, 40) || 'form';
const words = (s) => (String(s || '').match(/\S+/g) || []).length;

/** Train or test, by employer (~70% train), so one employer's forms never straddle the split. */
export function splitOf(company) {
  return parseInt(sha(norm(company)).slice(0, 8), 16) / 2 ** 32 < 0.7 ? 'train' : 'test';
}

/** The job's address without tracking parameters (utm_*, gh_src). */
export function canonicalUrl(url) {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()])
      if (/^(utm_|gh_src$|source$|ref$|lever-source$)/i.test(k)) u.searchParams.delete(k);
    return u.toString();
  } catch (err) {
    return String(url || '');
  }
}

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
const PHONE = /(\+\d{1,3}[\s.-]?)?(\(\d{2,5}\)\s?|\d{2,5}[\s.-])\d{3,4}[\s.-]?\d{3,4}\b/g;
/** Text as committed: no email addresses or phone numbers (a recruiter's, say). */
export function scrub(text) {
  return String(text || '')
    .replace(EMAIL, '(email address removed)')
    .replace(PHONE, (m) => (m.replace(/\D/g, '').length >= 9 ? '(phone number removed)' : m));
}

// The candidate's own details, which the rules put in the field before a follow-up question: never in the data.
const PRIVATE = [
  SURVEY_PROFILE.contact.email,
  SURVEY_PROFILE.contact.phone,
  SURVEY_PROFILE.address.line1,
  SURVEY_PROFILE.address.postalCode,
  SURVEY_PROFILE.personal.dob,
  SURVEY_PROFILE.eeo.postcodeAt14,
  ...Object.values(SURVEY_PROFILE.links),
]
  .filter(Boolean)
  .map(norm);
// What the rules filled from these profile sections (diversity answers, pronouns, contact details) stays out too.
const PRIVATE_TYPE =
  /^(eeo|links|name|email|phone|account|cc)\.|^(pronouns|dob|age|email|phone)$|^address\.(line|street|full|postal)/;
const isPrivate = (s) => {
  const n = norm(s);
  return !!n && (PRIVATE.some((p) => n.includes(p)) || /@/.test(s) || /\d{3}[\s.-]?\d{3}[\s.-]?\d{3}/.test(s));
};

function clip(s, n) {
  const t = String(s || '').trim();
  return t.length > n ? t.slice(0, n).replace(/\s+\S*$/, '') : t;
}

/** One form as the dataset keeps it, or null when the rules leave nothing for the AI. */
export function formRecord(JTF, profile, f) {
  if (!f.questions || !f.questions.length) return null;
  const results = simulate(JTF, f.questions, profile, { today: new Date(TODAY), jobLocation: f.location });
  const items = leftovers(JTF, { questions: f.questions, results }).map((it) => {
    const before = results[+it.id - 1];
    const hidden = (before && PRIVATE_TYPE.test(before.type || '')) || isPrivate(it.follows && it.follows.answer);
    return {
      ...it,
      question: scrub(it.question),
      help: scrub(it.help),
      section: scrub(it.section),
      options: it.options && it.options.map(scrub),
      follows: it.follows && { question: scrub(it.follows.question), answer: hidden ? '' : scrub(it.follows.answer) },
      guess: it.guess && !PRIVATE_TYPE.test(it.guess.type || '') && !isPrivate(it.guess.value) ? it.guess : null,
    };
  });
  if (!items.length) return null;
  const company = String(f.trackrCompany || f.company || '').trim();
  const url = canonicalUrl(f.resolved || f.url);
  const posting = f.posting || {};
  return {
    id: `${slug(company)}-${sha(url).slice(0, 8)}`,
    split: splitOf(company),
    company,
    title: String(f.title || posting.title || f.name || '').trim(),
    location: String(f.location || posting.location || '').trim(),
    url,
    ats: f.ats || '',
    region: f.region || '',
    industry: f.industry || '',
    type: f.type || '',
    companyNotes: scrub(f.companyNotes || ''),
    // The description the extension would find for the application (its ATS API reader), else the board's.
    description: scrub(clip(posting.description || f.description, DESCRIPTION_MAX)),
    items,
  };
}

const questionSet = (form) => new Set(form.items.map((it) => norm(it.question)));
function similar(a, b) {
  const x = questionSet(a);
  const y = questionSet(b);
  const shared = [...x].filter((q) => y.has(q)).length;
  return shared / Math.max(1, new Set([...x, ...y]).size);
}

/**
 * A diverse pick of n forms: near-identical ones dropped (same employer, mostly the same questions), at most
 * `perCompany` per employer, every employer's first form before any second one, round-robin over `group`
 * (region / industry / job board). Forms with a real description and more questions (up to 12) come first; forms
 * with more than `maxItems` (page after page of employment history) would swamp the rest and are left out.
 */
export function pick(
  forms,
  n,
  { perCompany = 2, maxItems = 30, group = (f) => `${f.region}/${f.industry}/${f.ats}` } = {},
) {
  const rank = (f) => (words(f.description) >= 150 ? 100 : 0) + Math.min(f.items.length, 12);
  const kept = [];
  const fit = forms.filter((f) => f.items.length <= maxItems);
  for (const f of fit.sort((a, b) => rank(b) - rank(a) || a.id.localeCompare(b.id))) {
    const same = kept.filter((k) => norm(k.form.company) === norm(f.company));
    if (kept.some((k) => k.form.id === f.id) || same.length >= perCompany) continue;
    if (same.some((k) => similar(k.form, f) >= 0.8)) continue;
    kept.push({ form: f, nth: same.length });
  }
  const out = [];
  for (let nth = 0; nth < perCompany; nth++) {
    const groups = new Map();
    for (const k of kept.filter((x) => x.nth === nth))
      groups.set(group(k.form), [...(groups.get(group(k.form)) || []), k.form]);
    const queues = [...groups.keys()].sort().map((key) => groups.get(key));
    while (out.length < n && queues.some((q) => q.length))
      for (const q of queues) if (q.length && out.length < n) out.push(q.shift());
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Labels from the dataset before, kept where the question and its options are word for word the same. */
export function mergeLabels(forms, previous) {
  const old = new Map();
  for (const f of (previous && previous.forms) || []) for (const it of f.items) old.set(`${f.id}/${it.id}`, it);
  let kept = 0;
  for (const f of forms)
    for (const it of f.items) {
      const was = old.get(`${f.id}/${it.id}`);
      const same =
        was &&
        was.label &&
        was.label.expect &&
        was.question === it.question &&
        JSON.stringify(was.options) === JSON.stringify(it.options);
      it.label = same ? was.label : { expect: null, why: '' };
      if (same) kept++;
    }
  return kept;
}

/** Cover letter cases: one posting per employer, ~30% from the test split, spread over region / industry / type. */
export function letterCases(forms, n) {
  const pool = forms.filter((f) => words(f.description) >= 250);
  const group = (f) => `${f.region}/${f.industry}/${f.type}`;
  const test = Math.round(n * 0.3);
  const train = pool.filter((f) => f.split === 'train');
  return [
    ...pick(train, n - test, { perCompany: 1, group }),
    ...pick(
      pool.filter((f) => f.split === 'test'),
      test,
      { perCompany: 1, group },
    ),
  ].map((f) => ({
    id: f.id,
    split: f.split,
    company: f.company,
    title: f.title,
    location: f.location,
    url: f.url,
    description: f.description,
  }));
}

export async function writeJson(file, data) {
  const options = (await prettier.resolveConfig(file)) || {};
  await writeFile(file, await prettier.format(JSON.stringify(data), { ...options, filepath: file }));
}

/** Where a Trackr link lands (grnh.se and apptrkr.io short links redirect to the board). */
async function resolveUrl(url) {
  if (!/grnh\.se|apptrkr\.io/.test(url)) return url;
  return fetch(url, { redirect: 'follow' }).then(
    (r) => r.url,
    () => url,
  );
}

/** The posting behind an application, as the extension reads it (jobpage.js): the board's API, else the page. */
async function postingFor(jp, url) {
  const found = (p) =>
    p && p.description && { title: p.title || '', location: p.location || '', description: p.description };
  for (const req of jp.apiRequests(url)) {
    const json = await fetch(req.url, { headers: req.headers })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    const p = found(json && jp.fromApi(req.kind, json, url));
    if (p) return p;
  }
  // Unlisted postings (Lever's API answers 404) are still on their page.
  globalThis.DOMParser = globalThis.DOMParser || DOMParser;
  for (const page of [url, ...jp.descriptionUrls(url).map((d) => d.url)]) {
    const html = await fetch(page)
      .then((r) => (r.ok ? r.text() : null))
      .catch(() => null);
    const p = found(html && jp.fromHtml(html, page));
    if (p) return p;
  }
  return null;
}

class DOMParser {
  parseFromString(html) {
    return parseHTML(String(html)).document;
  }
}

async function fetchLive({ limit, regions, industries }) {
  const targets = await trackrTargets({ regions, industries, hosts: HOSTS });
  // Round-robin over region / industry / board, so a limit still reads a spread of forms.
  const groups = new Map();
  for (const t of targets) {
    const key = `${t.region}/${t.industry}/${HOSTS.find((h) => t.url.includes(h))}`;
    groups.set(key, [...(groups.get(key) || []), t]);
  }
  const queue = [];
  const lists = [...groups.values()];
  while (lists.some((l) => l.length)) for (const l of lists) if (l.length) queue.push(l.shift());
  queue.splice(limit);
  const forms = [];
  async function worker() {
    while (queue.length) {
      const t = queue.shift();
      const resolved = await resolveUrl(t.url);
      const form = await liveForm(resolved).catch((err) => ({ error: String(err.message || err) }));
      forms.push({ ...t, trackrCompany: t.company, resolved, ...(form || { error: 'no form' }) });
      process.stdout.write(form && form.questions ? '.' : 'x');
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  process.stdout.write('\n');
  return forms;
}

function parseArgs(argv) {
  const out = {};
  argv.forEach((a, i) => {
    if (!a.startsWith('--')) return;
    const next = argv[i + 1];
    out[a.slice(2)] = next != null && !next.startsWith('--') ? next : true;
  });
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const list = (v) => (v && v !== true ? String(v).split(',') : undefined);
  // Several files merge (Trackr's lists sometimes come back empty for a region or an industry); the first wins.
  const raw = args.from
    ? [
        ...new Map(
          (await Promise.all(list(args.from).map(async (f) => JSON.parse(await readFile(f, 'utf8')))))
            .flat()
            .reverse()
            .map((f) => [canonicalUrl(f.url), f]),
        ).values(),
      ].reverse()
    : await fetchLive({ limit: +args.limit || 250, regions: list(args.region), industries: list(args.industry) });
  const JTF = loadEngine();
  if (!args.offline) {
    const jp = require('../../extension/lib/jobpage.js');
    const missing = raw.filter((f) => f.questions && f.posting === undefined);
    await Promise.all(
      [0, 1, 2, 3].map(async () => {
        while (missing.length) {
          const f = missing.shift();
          f.resolved = f.resolved || (await resolveUrl(f.url));
          f.posting = await postingFor(jp, f.resolved).catch(() => null);
        }
      }),
    );
  }
  if (args.save) await writeFile(args.save, JSON.stringify(raw, null, 1));
  const profile = JTF.fields.upgradeProfile(structuredClone(SURVEY_PROFILE));
  const all = raw.map((f) => formRecord(JTF, profile, f)).filter(Boolean);
  const forms = pick(all, +args.forms || 40);
  await mkdir(DATA, { recursive: true });
  const file = path.join(DATA, 'answers.json');
  const previous = await readFile(file, 'utf8').then(JSON.parse, () => null);
  const kept = mergeLabels(forms, previous);
  const about = {
    candidate: 'SURVEY_PROFILE and SURVEY_CV in tests/live/profile.mjs (fictional)',
    today: TODAY,
    fetched: new Date().toISOString().slice(0, 10),
  };
  await writeJson(file, { ...about, forms });
  const letters = letterCases(forms, +args.letters || 12);
  await writeJson(path.join(DATA, 'letters.json'), { ...about, cases: letters });

  const items = forms.flatMap((f) => f.items);
  const count = (xs, key) => xs.reduce((o, x) => ({ ...o, [key(x)]: (o[key(x)] || 0) + 1 }), {});
  console.log(
    `${raw.filter((f) => f.questions).length} forms read (${raw.length} tried), ${all.length} leave questions`,
  );
  console.log(`answers.json: ${forms.length} forms, ${items.length} questions (${kept} labels kept)`);
  console.log(
    ' split',
    count(forms, (f) => f.split),
    'board',
    count(forms, (f) => f.ats),
  );
  console.log(
    ' region/industry',
    count(forms, (f) => `${f.region}/${f.industry}`),
  );
  console.log(
    `letters.json: ${letters.length} postings`,
    count(letters, (f) => f.split),
  );
  const unlabelled = items.filter((it) => !it.label.expect).length;
  if (unlabelled) console.log(`${unlabelled} questions need a label (see tests/eval/README.md)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
