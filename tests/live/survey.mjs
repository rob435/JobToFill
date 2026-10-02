// Fills live application forms listed on Trackr (app.the-trackr.com) and reports every question left
// empty, so the next round of rules (and AI answers) can be aimed at what real forms ask.
// It never submits anything: JobToFill doesn't, and the only clicks made here are on "Apply" links
// before an application form is on the page.
//
//   node tests/live/survey.mjs [--limit 40] [--hosts greenhouse,ashby] [--out survey.json] [--ai]
//                              [--urls a,b,c] [--region UK,US] [--industry Finance,Tech]
//
// --ai answers the questions the rules leave with AI (OPENROUTER_API_KEY, or a mock with --ai=mock).
// HEADED=1 shows the browser.
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { launch } from '../e2e/harness.mjs';
import { SURVEY_CV, SURVEY_PROFILE } from './profile.mjs';
import { trackrTargets } from './trackr.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => {
    if (!a.startsWith('--')) return [];
    const [k, v] = a.slice(2).split('=');
    const next = all[i + 1];
    return [k, v != null ? v : next && !next.startsWith('--') ? next : true];
  }),
);
const LIMIT = +args.limit || 40;
const OUT = args.out || path.join(path.dirname(fileURLToPath(import.meta.url)), 'survey-report.json');
const HOSTS = args.hosts ? String(args.hosts).split(',') : null;

async function cvPdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  let y = 800;
  for (const line of SURVEY_CV.split('\n')) {
    page.drawText(
      line.replace(/[–’£•]/g, (c) => ({ '–': '-', '’': "'", '£': 'GBP ', '•': '-' })[c]),
      {
        x: 40,
        y,
        size: 10,
        font,
      },
    );
    y -= 15;
  }
  return 'data:application/pdf;base64,' + Buffer.from(await doc.save()).toString('base64');
}

/* ------------------------------------------------------------- targets */

/* ------------------------------------------------------------ browsing */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The application form's address on job boards that keep it on its own page. */
function formUrl(url) {
  const u = new URL(url);
  if (/jobs\.(eu\.)?lever\.co$/.test(u.hostname) && !/\/apply\/?$/.test(u.pathname))
    u.pathname = u.pathname.replace(/\/$/, '') + '/apply';
  else if (/jobs\.ashbyhq\.com$/.test(u.hostname) && !/\/application\/?$/.test(u.pathname))
    u.pathname = u.pathname.replace(/\/$/, '') + '/application';
  else if (/apply\.workable\.com$/.test(u.hostname) && /\/j\/[^/]+\/?$/.test(u.pathname))
    u.pathname = u.pathname.replace(/\/?$/, '/apply/');
  else return url;
  return u.href;
}

/** Count the visible form controls in every frame. */
async function controlCount(page) {
  let n = 0;
  for (const f of page.frames()) {
    n += await f
      .$$eval(
        'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=search]), select, textarea',
        (els) => els.filter((e) => e.getClientRects().length).length,
      )
      .catch(() => 0);
  }
  return n;
}

/** Click an "Apply" link or button (never one that submits a form). */
async function clickApply(page) {
  for (const f of page.frames()) {
    const handle = await f
      .evaluateHandle(() => {
        const RE =
          /^\s*(apply|apply now|apply for this (job|role|position)|apply here|apply online|start (your )?application|i('|’)?m interested|continue to application|bewerben|postuler)\s*$/i;
        const nodes = [...document.querySelectorAll('a[href], button, [role=button]')].filter(
          (e) =>
            e.getClientRects().length &&
            RE.test(e.textContent || e.getAttribute('aria-label') || '') &&
            !(e.localName === 'button' && e.type === 'submit' && e.form && e.form.querySelector('input[type=file]')),
        );
        return nodes.find((e) => e.localName === 'a') || nodes[0] || null;
      })
      .catch(() => null);
    const el = handle && handle.asElement();
    if (el) {
      const popup = page
        .context()
        .waitForEvent('page', { timeout: 6000 })
        .catch(() => null);
      await el.click({ timeout: 5000 }).catch(() => {});
      const opened = await popup;
      return opened || page;
    }
  }
  return null;
}

async function reachForm(page, url) {
  await page.goto(formUrl(url), { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
  await sleep(1500);
  for (let hop = 0; hop < 2 && (await controlCount(page)) < 5; hop++) {
    const next = await clickApply(page);
    if (!next) break;
    if (next !== page) page = next;
    await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
    await sleep(2000);
  }
  return page;
}

/* --------------------------------------------------------------- survey */

/** In each frame's content-script world: every field, what it was taken for, and whether it has a value. */
function surveyFrames(h, tabId, profile) {
  return h.bg(
    async ([id, p]) => {
      const results = await globalThis.JTF.api.scripting.executeScript({
        target: { tabId: id, allFrames: true },
        func: (prof) => {
          const J = globalThis.JTF;
          if (!J || !J.dom || !J.fill) return null;
          const fields = J.dom.collect(document);
          const plan = J.matcher.plan(
            fields.map((f) => f.desc),
            prof,
          );
          return {
            url: location.href,
            fields: fields.map((f, i) => {
              const r = plan.results[i] || {};
              const el = f.el;
              const q = J.matcher.questionText(f.desc);
              return {
                kind: f.kind,
                q,
                type: r.type || null,
                dropped: r.dropped || null,
                filled: J.fill.hasValue(f),
                required: !!(
                  el.required ||
                  el.getAttribute('aria-required') === 'true' ||
                  /\*\s*$/.test(f.desc.signals.label || f.desc.signals.question || '')
                ),
                options: (f.desc.options || []).slice(0, 15).map((o) => o.text),
                maxLength: f.desc.maxLength || 0,
                section: f.desc.signals.section || '',
              };
            }),
          };
        },
        args: [p],
      });
      return results.map((r) => r.result).filter(Boolean);
    },
    [tabId, profile],
  );
}

async function tabIdOf(h, page) {
  const url = page.url();
  return h.bg(async (u) => {
    const tabs = await globalThis.JTF.api.tabs.query({});
    const hit = tabs.filter((t) => t.url === u).pop() || tabs.filter((t) => t.active).pop();
    return hit ? hit.id : null;
  }, url);
}

async function main() {
  const targets = args.urls
    ? String(args.urls)
        .split(',')
        .map((url) => ({ url }))
    : await trackrTargets({
        regions: args.region ? String(args.region).split(',') : undefined,
        industries: args.industry ? String(args.industry).split(',') : undefined,
        hosts: HOSTS || undefined,
      });
  console.log(
    `${targets.length} open Trackr postings on fillable job boards; surveying ${Math.min(LIMIT, targets.length)}`,
  );
  const h = await launch();
  const profileId = await h.setProfile(SURVEY_PROFILE);
  const dataUrl = await cvPdf();
  await h.bg(
    ([id, d]) =>
      globalThis.JTF.store.setDoc(id, 'resume', {
        name: 'Alex_Morgan_CV.pdf',
        type: 'application/pdf',
        size: 3000,
        dataUrl: d,
      }),
    [profileId, dataUrl],
  );
  await h.setSettings({ consents: false, logApplications: false });
  if (args.ai) await setUpAi(h, profileId);

  const previous = args.append ? JSON.parse(await readFile(OUT, 'utf8').catch(() => '[]')) : [];
  const report = [...previous];
  for (const t of targets.slice(0, LIMIT)) {
    const started = Date.now();
    let page = await h.newPage();
    const entry = { ...t, at: new Date().toISOString() };
    try {
      page = await reachForm(page, t.url);
      entry.formUrl = page.url();
      entry.controls = await controlCount(page);
      if (entry.controls < 3) throw new Error('no application form reached');
      const tabId = await tabIdOf(h, page);
      entry.fill = await h.bg((id) => globalThis.JTFBackground.fillTab(id), tabId);
      if (args.ai) entry.ai = await h.bg((id) => globalThis.JTFBackground.answerWithAi(id, { wait: true }), tabId);
      await sleep(1500);
      const frames = await surveyFrames(h, tabId, SURVEY_PROFILE);
      entry.fields = frames.flatMap((f) => f.fields.map((x) => ({ ...x, frame: f.url })));
      const empty = entry.fields.filter((x) => !x.filled);
      console.log(
        `✓ ${t.company || ''} ${new URL(entry.formUrl).hostname}: ${entry.fill.filled} filled, ${empty.length} empty of ${entry.fields.length}` +
          (entry.ai ? `, AI ${entry.ai.filled || 0}/${entry.ai.asked || 0}` : '') +
          ` (${Math.round((Date.now() - started) / 1000)}s)`,
      );
    } catch (err) {
      entry.error = String(err.message || err).split('\n')[0];
      console.log(`✗ ${t.company || ''} ${t.url}: ${entry.error}`);
    }
    report.push(entry);
    await writeFile(OUT, JSON.stringify(report, null, 1));
    for (const p of h.context.pages()) if (p !== page) await p.close().catch(() => {});
    await page.close().catch(() => {});
  }
  await h.close();
  summarise(report);
}

async function setUpAi(h, profileId) {
  const key = process.env.OPENROUTER_API_KEY;
  if (args.ai === 'mock' || !key) throw new Error('--ai needs OPENROUTER_API_KEY');
  await h.bg(
    async ([k, cv, id]) => {
      const { store } = globalThis.JTF;
      await store.saveAiSettings({ provider: 'openrouter', model: '' });
      await store.setAiKey(k, 'openrouter');
      await store.saveKit(id, { cv: { name: 'Alex_Morgan_CV.pdf', updatedAt: 0, text: cv } });
      await store.saveSettings({ aiAnswers: true });
    },
    [key, SURVEY_CV, profileId],
  );
}

function summarise(report) {
  const ok = report.filter((r) => r.fields);
  const counts = new Map();
  for (const r of ok)
    for (const f of r.fields.filter((x) => !x.filled)) {
      const key = `${f.kind} | ${f.type || '?'} | ${(f.q || '').slice(0, 110)}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  console.log(`\n${ok.length} forms surveyed, ${report.length - ok.length} not reached`);
  console.log('Most common empty fields:');
  for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 60)) console.log(String(n).padStart(3), k);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
