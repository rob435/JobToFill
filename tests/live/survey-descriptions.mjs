// Surveys how well JobToFill finds the job description behind live job pages and the application pages their
// Apply opens: the open programmes listed on Trackr (one or two per site, across every kind of job board and
// employer's own site) and the boards Discover finds for its firms. In the real extension in Chromium, each page is
// read as the letter studio reads it (the page's own text, the job board's data, a background tab for pages built by
// scripts), and the description found is graded against what Trackr says the programme is. Nothing is filled or
// submitted: Apply is pressed only on "Apply"-like links and buttons outside a form.
//
//   node tests/live/survey-descriptions.mjs [--limit 60] [--per 1] [--out report.json] [--shard 0/3]
//                                           [--region UK,US] [--industry Finance,Tech] [--urls a,b,c] [--no-apply]
//                                           [--targets list.json]
//   node tests/live/survey-descriptions.mjs --from report.json      the tally of a survey run before
//
// Grades: good (the job's own description: 150+ words with the parts an advert has), thin (found, but short or
// without them: the employer wrote little), more (thin, with the same programme's other postings or the employer's
// own pages read beside it), wrong (another job or a page that isn't one), none (nothing found), wall (a bot check
// the cloud machine can't pass: a person's browser gets through).
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../e2e/harness.mjs';
import { SURVEY_PROFILE } from './profile.mjs';
import { trackrTargets } from './trackr.mjs';

const require = createRequire(import.meta.url);
const { parseHTML } = require('linkedom');
globalThis.DOMParser = class {
  parseFromString(html) {
    return parseHTML(String(html)).document;
  }
};
require('../../extension/lib/util.js');
const jp = require('../../extension/lib/jobpage.js');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const next = process.argv[i + 1];
  args[a.slice(2)] = next && !next.startsWith('--') ? (i++, next) : true;
}
const OUT = args.out || path.join(path.dirname(fileURLToPath(import.meta.url)), 'survey-descriptions-report.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timed = (p, ms, what) =>
  Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms))]);
const WALL =
  /security verification|just a moment|access denied|attention required|checking your browser|^403 forbidden|unusual traffic|request blocked|you have been blocked/i;
const CHALLENGE = /_Incapsula_Resource|\/cdn-cgi\/challenge-platform|captcha-delivery\.com|px-captcha|perimeterx/i;

/* --------------------------------------------------------------- targets */

/** A site's family: every Workday tenant is one family, as is every Avature, Oracle or tal.net site. */
function family(url) {
  const host = new URL(url).hostname.replace(/^www\./, '');
  const m = host.match(
    /(myworkdayjobs\.com|myworkdaysite\.com|avature\.net|oraclecloud\.com|icims\.com|tal\.net|pinpointhq\.com|teamtailor\.com|bamboohr\.com|breezy\.hr|successfactors\.\w+|eightfold\.ai|csod\.com|grad\.allhires\.com|candidats\.io|applytojob\.com|gtisolutions\.co\.uk|groupgti\.com)$/,
  );
  return m ? m[1] : host;
}

/** Open programmes on Trackr, at most `per` per site family (the first few families get up to two). */
async function targets() {
  if (args.urls)
    return String(args.urls)
      .split(',')
      .map((url) => ({ url, company: '', name: '' }));
  // (--targets: a list saved before, [{ url, company, name }]: Trackr's API takes seconds a list.)
  const all = args.targets
    ? JSON.parse(await readFile(args.targets, 'utf8'))
    : await trackrTargets({
        regions: args.region ? String(args.region).split(',') : ['UK', 'US'],
        industries: args.industry ? String(args.industry).split(',') : undefined,
        hosts: [''],
      });
  const per = new Map();
  const cap = +args.per || 1;
  const out = [];
  for (const t of all) {
    // (Trackr lists a few addresses that aren't any: "http://summer%20placement%202027.%201st%20release/".)
    if (!URL.canParse(t.url) || !/\.[a-z]{2,}$/i.test(new URL(t.url).hostname)) continue;
    const host = new URL(t.url).hostname.replace(/^www\./, '');
    // Trackr's own pages and LinkedIn want an account before anything shows.
    if (/^(app\.the-trackr\.com|linkedin\.com)$/.test(host)) continue;
    const f = family(t.url);
    const n = per.get(f) || 0;
    // The big boards (Workday, Greenhouse) differ by employer: two of each.
    if (n >= (/myworkdayjobs|greenhouse|oraclecloud|tal\.net|avature/.test(f) ? cap + 1 : cap)) continue;
    per.set(f, n + 1);
    out.push({ ...t, host });
  }
  return out;
}

/* -------------------------------------------------------------- the page */

function tabIdOf(h, page) {
  return h.bg(async (u) => {
    const tabs = await globalThis.JTF.api.tabs.query({});
    const hit = tabs.filter((t) => t.url === u).pop() || tabs.filter((t) => t.active).pop();
    return hit ? hit.id : null;
  }, page.url());
}

async function settle(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
  await sleep(2500);
}

/** Click an "Apply" link or button: never one that would submit a form. */
async function clickApply(page) {
  for (const f of page.frames()) {
    const handle = await f
      .evaluateHandle(() => {
        const RE =
          /^\s*(apply|apply now|apply for (this )?(job|role|position|opportunity|programme|program)|apply here|apply online|apply today|start (your )?application|begin application|i('|’)?m interested|continue to application|apply to (this )?(job|role|position)|bewerben|jetzt bewerben|postuler|candidater)\s*[›>→]?\s*$/i;
        const nodes = Array.from(document.querySelectorAll('a[href], button, [role=button]')).filter(
          (e) =>
            e.getClientRects().length &&
            RE.test(e.innerText || e.getAttribute('aria-label') || '') &&
            !(e.localName === 'button' && e.type === 'submit' && e.form),
        );
        return nodes.find((e) => e.localName === 'a') || nodes[0] || null;
      })
      .catch(() => null);
    const el = handle && handle.asElement();
    if (el) {
      const opened = page
        .context()
        .waitForEvent('page', { timeout: 6000 })
        .catch(() => null);
      await el.click({ timeout: 5000 }).catch(() => {});
      return (await opened) || page;
    }
  }
  return null;
}

/** The background's own fetch (the extension's headers and network), with the HTML parsed here. */
const extensionFetch =
  (h) =>
  async (url, init = {}) => {
    const { signal, ...rest } = init;
    void signal;
    const r = await h.bg(
      async ([u, i]) => {
        try {
          const res = await fetch(u, { credentials: 'omit', redirect: 'follow', ...i });
          return {
            ok: res.ok,
            status: res.status,
            url: res.url,
            type: res.headers.get('content-type'),
            text: await res.text(),
          };
        } catch (err) {
          return { error: String((err && err.message) || err) };
        }
      },
      [url, rest],
    );
    if (r.error) throw new Error(r.error);
    return { ok: r.ok, status: r.status, url: r.url, headers: { get: () => r.type }, text: async () => r.text };
  };

/** The job behind this tab, found as the letter studio finds it (without history or the AI's second opinion). */
async function findJob(h, page) {
  const context = await h.handler('jtf:job-context', page);
  if (!context || context.error) return { error: (context && context.error) || 'no context' };
  const started = Date.now();
  const found = await jp.find(context, { fetch: extensionFetch(h), now: Date.now() });
  const onlyThisPage = found.verdict === 'likely' && found.source === context.url;
  if (!found.posting || found.verdict === 'different' || onlyThisPage) {
    const shells = (found.tried || [])
      .filter((t) => /empty|no posting|shell|script|HTTP (400|401|403|429|5\d\d)|timed out|failed:/i.test(t.outcome))
      .filter((t) => /^https?:/.test(t.url) && !/\/api\/|\/wday\/cxs\/|graphql|\.json(\?|$)/i.test(t.url))
      .filter((t, i, list) => list.findIndex((x) => x.url === t.url) === i)
      .slice(0, 2);
    for (const t of shells) {
      const got = await timed(h.handler('jtf:scrape', null, { url: t.url }), 60000, 'background tab').catch(() => null);
      const v = got && got.posting && got.posting.description && jp.compare(context, got.posting);
      found.tried.push({ url: t.url, outcome: `read in a background tab: ${v ? v.verdict : 'nothing'}` });
      if (v && (onlyThisPage ? v.verdict === 'same' : v.verdict !== 'different')) {
        Object.assign(found, { posting: got.posting, verdict: v.verdict, reasons: v.reasons, source: t.url });
        break;
      }
    }
  }
  // As the studio: the application page itself, when it has a long enough text and isn't an application step.
  const step = !!(context.ats && context.ats.stage === 'application');
  if (!found.posting && !step && context.posting && jp.words(context.posting.description) > 120)
    Object.assign(found, { posting: context.posting, verdict: 'same', source: context.url, reasons: ['the page'] });
  const p = found.posting;
  return {
    url: context.url,
    title: context.title,
    company: context.company,
    pageWords: context.posting ? jp.words(context.posting.description) : 0,
    verdict: found.verdict,
    reasons: found.reasons,
    source: found.source,
    ms: Date.now() - started,
    posting: p && {
      title: p.title,
      company: p.company,
      source: p.source,
      words: jp.words(p.description),
      structure: jp.jobStructure(p.description),
      legal: jp.isLegalText(p.description),
      thin: !!(p.thin || (found.extra && found.extra.length)),
      start: String(p.description || '')
        .replace(/\s+/g, ' ')
        .slice(0, 160),
    },
    extra: (found.extra || []).map((x) => ({ url: x.url, words: jp.words(x.text), kind: x.kind, title: x.title })),
    trail: (context.trail || []).slice(0, 4).map((t) => t.url),
    text: p ? String(p.description || '') : '',
    tried: (found.tried || []).slice(0, 10),
  };
}

/** good | thin | wrong | none, for a job found from a page about `t` (Trackr's company and programme name). */
function grade(t, j) {
  if (!j || j.error) return 'error';
  if (!j.posting || j.verdict === 'different') return 'none';
  const p = j.posting;
  if (p.legal) return 'wrong';
  const company = t.company && p.company ? jp.companyMatch(t.company, p.company) : null;
  const title = t.name && p.title ? jp.titleSimilarity(t.name, p.title) : null;
  if (company === false && (title == null || title < 0.5)) return 'wrong';
  if (p.words >= 150 && p.structure >= 2) return 'good';
  // The employer wrote little, but the same programme's other postings or its own pages say more.
  return (j.extra || []).length ? 'more' : 'thin';
}

async function surveyOne(h, t) {
  const entry = { company: t.company, name: t.name, url: t.url, host: t.host || new URL(t.url).hostname };
  let page = await h.newPage();
  try {
    const res = await page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await settle(page);
    const tabId = await tabIdOf(h, page);
    await h.bg((id) => globalThis.JTFBackground.ensureInjected(id), tabId);
    const text = await page
      .evaluate(() => `${document.title} ${((document.body && document.body.innerText) || '').slice(0, 400)}`)
      .catch(() => '');
    // (Also a challenge that draws nothing, Incapsula's "_Incapsula_Resource" script, and a site that answers 403.)
    const html = await page.evaluate(() => document.documentElement.outerHTML.slice(0, 20000)).catch(() => '');
    entry.status = res ? res.status() : 0;
    entry.wall = WALL.test(text) || CHALLENGE.test(html) || [401, 403, 429].includes(entry.status);
    entry.landed = page.url();
    entry.job = await timed(findJob(h, page), 120000, 'job finding').catch((err) => ({ error: err.message }));
    entry.grade = entry.wall && grade(t, entry.job) !== 'good' ? 'wall' : grade(t, entry.job);
    if (!args['no-apply']) {
      const next = await clickApply(page);
      if (next) {
        page = next;
        await settle(page);
        if (page.url() !== entry.landed) {
          await h.bg((id) => globalThis.JTFBackground.ensureInjected(id), await tabIdOf(h, page)).catch(() => {});
          entry.applied = page.url();
          entry.appliedJob = await timed(findJob(h, page), 120000, 'job finding').catch((err) => ({
            error: err.message,
          }));
          entry.appliedGrade = grade(t, entry.appliedJob);
        }
      }
    }
  } catch (err) {
    entry.error = String(err.message || err).split('\n')[0];
    entry.grade = 'error';
  }
  for (const p of h.context.pages()) await p.close().catch(() => {});
  return entry;
}

/* -------------------------------------------------------------- the tally */

const short = (s, n = 90) =>
  String(s || '')
    .replace(/\s+/g, ' ')
    .slice(0, n);
const jobLine = (j) =>
  !j
    ? '-'
    : j.error
      ? `error: ${short(j.error, 80)}`
      : `${j.verdict || 'none'}` +
        (j.posting
          ? `, ${j.posting.words} words (${j.posting.structure}/4 parts) of “${short(j.posting.title, 50)}” via ${short(j.posting.source, 20)}`
          : `: ${short((j.reasons || []).join('; '), 100)}`);

function summarise(report) {
  const count = (key) => {
    const c = {};
    for (const e of report) if (e[key]) c[e[key]] = (c[e[key]] || 0) + 1;
    return c;
  };
  const g = count('grade');
  const a = count('appliedGrade');
  console.log(`\n${report.length} job pages`);
  console.log(`  on the job page: ${JSON.stringify(g)}`);
  console.log(`  after Apply:     ${JSON.stringify(a)} (of ${report.filter((e) => e.applied).length} that opened one)`);
  for (const kind of ['none', 'wrong', 'thin', 'more', 'error', 'wall']) {
    const list = report.filter((e) => e.grade === kind || e.appliedGrade === kind);
    if (!list.length) continue;
    console.log(`\n${kind}:`);
    for (const e of list)
      console.log(
        `  ${short(e.company, 28)} | ${short(e.name, 50)}\n    ${short(e.url, 140)}\n    page: ${e.grade} ${jobLine(e.job)}` +
          (e.applied ? `\n    apply: ${e.appliedGrade} ${jobLine(e.appliedJob)}\n    (${short(e.applied, 120)})` : ''),
      );
  }
}

async function main() {
  if (args.from) return summarise(JSON.parse(await readFile(args.from, 'utf8')));
  const list = await targets();
  const [k, n] = String(args.shard || '0/1')
    .split('/')
    .map(Number);
  const mine = list.filter((_, i) => i % n === k).slice(0, +args.limit || 60);
  console.log(`${list.length} open programmes on distinct sites; surveying ${mine.length}`);
  const h = await launch();
  await h.setProfile(SURVEY_PROFILE);
  await h.setSettings({ consents: false, logApplications: false, aiAnswers: false });
  const report = [];
  for (const t of mine) {
    const e = await timed(surveyOne(h, t), 300000, 'site').catch((err) => ({
      ...t,
      error: err.message,
      grade: 'error',
    }));
    report.push(e);
    await writeFile(OUT, JSON.stringify(report, null, 1));
    console.log(
      `${e.grade.padEnd(5)} ${e.appliedGrade ? `→ ${e.appliedGrade.padEnd(5)}` : '        '} ${t.company}  ${short(t.url, 90)}`,
    );
  }
  await h.close();
  summarise(report);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
