// Surveys the career sites JobToFill has no rules for: the programmes open on Trackr whose job page is on a site
// `jobpage.ats()` doesn't know (an employer's own site: Meta Careers, Talentsoft, GTI…), up to two per site. In the
// real extension in Chromium, each job page is read as the letter studio reads it, Apply is clicked (only "Apply"-like
// links and buttons, never one in a form), and on the page that opens it reports the controls the scanner missed,
// the fields no rule recognises, and whether the job is still found from there. Nothing is filled or submitted.
//
//   node tests/live/survey-sites.mjs [--limit 60] [--out report.json] [--shard 0/3] [--region UK,US]
//                                     [--industry Finance,Tech] [--urls a,b,c]
//   node tests/live/survey-sites.mjs --from report.json      the summary of a survey run before
//
// Sites behind a bot check (Cloudflare's "Just a moment…") are listed as such: they need a person's browser.
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

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : [])),
);
const OUT = args.out || path.join(path.dirname(fileURLToPath(import.meta.url)), 'survey-sites-report.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timed = (p, ms, what) =>
  Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms))]);

// Everything a person could type into or pick.
const CONTROLS =
  'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]):not([type=reset]), select, textarea, [role=combobox], [role=radio], [role=checkbox], [role=switch], [role=textbox], [contenteditable=""], [contenteditable=true]';
const WALL =
  /security verification|just a moment|access denied|attention required|checking your browser|^403 forbidden|unusual traffic/i;

/* --------------------------------------------------------------- targets */

/** Open programmes on sites with no rules, at most two per site. */
async function targets() {
  if (args.urls)
    return String(args.urls)
      .split(',')
      .map((url) => ({ url, host: new URL(url).hostname, company: new URL(url).hostname }));
  const all = await trackrTargets({
    regions: args.region ? String(args.region).split(',') : undefined,
    industries: args.industry ? String(args.industry).split(',') : undefined,
    hosts: [''],
  });
  const per = new Map();
  const out = [];
  for (const t of all) {
    const host = new URL(t.url).hostname.replace(/^www\./, '');
    // Trackr's own pages, LinkedIn and Y Combinator's board want an account before anything shows.
    if (jp.ats(t.url).name || /^(app\.the-trackr\.com|linkedin\.com|workatastartup\.com)$/.test(host)) continue;
    const n = per.get(host) || 0;
    if (n >= 2) continue;
    per.set(host, n + 1);
    out.push({ ...t, host });
  }
  return out;
}

/* -------------------------------------------------------------- the page */

/** In every frame's content-script world: the controls shown, the fields collected, and which were missed. */
function scan(h, tabId) {
  return h.bg(
    async ([id, profile, selector]) => {
      const results = await globalThis.JTF.api.scripting.executeScript({
        target: { tabId: id, allFrames: true },
        func: (prof, sel) => {
          const J = globalThis.JTF;
          if (!J || !J.dom) return null;
          const seen = (e) =>
            e.getClientRects().length > 0 &&
            (typeof e.checkVisibility !== 'function' || e.checkVisibility({ checkVisibilityCSS: true }));
          const labelOf = (e) =>
            String(
              (e.labels && e.labels[0] && e.labels[0].innerText) ||
                e.getAttribute('aria-label') ||
                e.getAttribute('placeholder') ||
                e.name ||
                e.id ||
                '',
            )
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 80);
          const fields = J.dom.collect(document);
          const plan = J.matcher.plan(
            fields.map((f) => f.desc),
            prof,
          );
          const covered = fields.flatMap((f) => [f.el, ...f.members]);
          const shown = Array.from(document.querySelectorAll(sel)).filter(
            (e) => seen(e) || (/^(radio|checkbox)$/.test(e.type) && e.labels && Array.from(e.labels).some(seen)),
          );
          return {
            url: location.href,
            title: document.title,
            text: ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').slice(0, 300),
            shown: shown.length,
            fields: fields.map((f, i) => ({
              kind: f.kind,
              q: J.matcher.questionText(f.desc).slice(0, 140),
              type: (plan.results[i] || {}).type || null,
            })),
            missed: shown
              .filter((e) => !covered.some((c) => c === e || c.contains(e) || e.contains(c)))
              .map((e) => ({
                control: `${e.localName}${e.type ? ':' + e.type : ''}${e.getAttribute('role') ? '[' + e.getAttribute('role') + ']' : ''}`,
                label: labelOf(e),
                ariaHidden: !!e.closest('[aria-hidden="true"]'),
              })),
          };
        },
        args: [profile, selector],
      });
      return results.map((r) => r.result).filter(Boolean);
    },
    [tabId, SURVEY_PROFILE, CONTROLS],
  );
}

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
          /^\s*(apply|apply now|apply for (this )?(job|role|position|opportunity)|apply here|apply online|apply today|start (your )?application|begin application|i('|’)?m interested|continue to application|apply to (this )?(job|role|position)|bewerben|jetzt bewerben|postuler|candidater)\s*[›>→]?\s*$/i;
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

/* ------------------------------------------------------------- the job */

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
  const found = await jp.find(context, { fetch: extensionFetch(h), now: Date.now() });
  if (!found.posting || found.verdict === 'different') {
    const shells = (found.tried || [])
      .filter((t) => /empty|no posting|shell|script|HTTP (400|401|403|429|5\d\d)|timed out|failed:/i.test(t.outcome))
      .filter((t) => /^https?:/.test(t.url) && !/\/api\/|graphql|\.json(\?|$)/i.test(t.url))
      .slice(0, 2);
    for (const t of shells) {
      const got = await timed(h.handler('jtf:scrape', null, { url: t.url }), 60000, 'background tab').catch(() => null);
      const v = got && got.posting && jp.compare(context, got.posting);
      if (v && v.verdict !== 'different') {
        Object.assign(found, { posting: got.posting, verdict: v.verdict, reasons: v.reasons, source: t.url });
        break;
      }
    }
  }
  const p = found.posting;
  return {
    title: context.title,
    company: context.company,
    jobIds: context.jobIds,
    verdict: found.verdict,
    source: found.source,
    posting: p && { title: p.title, company: p.company, words: String(p.description || '').split(/\s+/).length },
    tried: (found.tried || []).slice(0, 6),
  };
}

async function surveyOne(h, t) {
  const entry = { company: t.company, name: t.name, url: t.url, host: t.host };
  let page = await h.newPage();
  try {
    await page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await settle(page);
    await h.bg((id) => globalThis.JTFBackground.ensureInjected(id), await tabIdOf(h, page));
    entry.job = await timed(findJob(h, page), 90000, 'job finding').catch((err) => ({ error: err.message }));
    let frames = await scan(h, await tabIdOf(h, page));
    for (let hop = 0; hop < 2 && frames.reduce((n, f) => n + f.shown, 0) < 4; hop++) {
      const next = await clickApply(page);
      if (!next) break;
      page = next;
      await settle(page);
      await h.bg((id) => globalThis.JTFBackground.ensureInjected(id), await tabIdOf(h, page)).catch(() => {});
      frames = await scan(h, await tabIdOf(h, page));
      entry.applied = page.url();
    }
    entry.frames = frames;
    entry.wall = frames.some((f) => WALL.test(f.title) || WALL.test(f.text));
    if (entry.applied)
      entry.appliedJob = await timed(findJob(h, page), 90000, 'job finding').catch((err) => ({ error: err.message }));
  } catch (err) {
    entry.error = String(err.message || err).split('\n')[0];
  }
  for (const p of h.context.pages()) await p.close().catch(() => {});
  return entry;
}

/* -------------------------------------------------------------- summary */

const short = (s, n = 90) =>
  String(s || '')
    .replace(/\s+/g, ' ')
    .slice(0, n);
const jobLine = (j) =>
  !j
    ? '-'
    : j.error
      ? `error: ${short(j.error, 80)}`
      : `${j.verdict || 'none'}: "${short(j.title, 50)}" at "${short(j.company, 30)}"` +
        (j.posting ? `, ${j.posting.words} words of "${short(j.posting.title, 40)}"` : ', no description');

function summarise(report) {
  const walls = report.filter((e) => e.wall);
  console.log(
    `\n${report.length} pages; ${walls.length} behind a bot check: ${walls.map((e) => e.company).join(', ')}`,
  );
  console.log('\nControls the scanner missed (not shims marked aria-hidden):');
  for (const e of report)
    for (const f of e.frames || []) {
      const missed = f.missed.filter((m) => !m.ariaHidden);
      if (missed.length)
        console.log(
          `  ${e.company} ${short(f.url, 70)}: ${missed.map((m) => `${m.control} "${m.label}"`).join(' | ')}`,
        );
    }
  const unknown = new Map();
  for (const e of report)
    for (const f of e.frames || [])
      for (const x of f.fields.filter((y) => !y.type)) {
        const key = `${x.kind} | ${short(x.q, 100)}`;
        unknown.set(key, [...(unknown.get(key) || []), e.company]);
      }
  console.log('\nFields no rule recognises, most common first:');
  for (const [k, cs] of [...unknown].sort((a, b) => b[1].length - a[1].length).slice(0, 60))
    console.log(`  ${String(cs.length).padStart(3)} ${k} (${[...new Set(cs)].slice(0, 3).join(', ')})`);
  console.log('\nThe job, read on its page and found again from the page Apply opens:');
  for (const e of report.filter((x) => !x.wall && !x.error))
    console.log(`  ${e.company}: ${jobLine(e.job)}${e.appliedJob ? ` | after Apply: ${jobLine(e.appliedJob)}` : ''}`);
}

async function main() {
  if (args.from) return summarise(JSON.parse(await readFile(args.from, 'utf8')));
  const list = await targets();
  const [k, n] = String(args.shard || '0/1')
    .split('/')
    .map(Number);
  const mine = list.filter((_, i) => i % n === k).slice(0, +args.limit || 60);
  console.log(`${list.length} open programmes on sites without rules; surveying ${mine.length}`);
  const h = await launch();
  await h.setProfile(SURVEY_PROFILE);
  await h.setSettings({ consents: false, logApplications: false, aiAnswers: false });
  const report = [];
  for (const t of mine) {
    const e = await timed(surveyOne(h, t), 240000, 'site').catch((err) => ({ ...t, error: err.message }));
    report.push(e);
    await writeFile(OUT, JSON.stringify(report, null, 1));
    console.log(`${e.error ? '✗' : e.wall ? '⊘' : '✓'} ${t.company} ${t.host}${e.error ? ': ' + e.error : ''}`);
  }
  await h.close();
  summarise(report);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
