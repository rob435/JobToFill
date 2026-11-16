// Presses the popup's three buttons on live application forms, the way a person would: Fill this page (your details,
// the AI's answers, then the check), Fill + letter & CV (Quick apply, then the check) and Apply for me (everything, on
// every step, up to the one that submits). For each form and button: how the run ended, what it filled, what the AI
// answered, what the check put right and what it left, what the page still wants, and a full-page screenshot.
//
// Nothing is ever sent. JobToFill never submits; on top of that every request that leaves this machine and isn't a
// read (GET, HEAD, OPTIONS) is aborted at the browser, and counted. The few reads some boards make as POSTs (Ashby's
// GraphQL queries, Phenom's widgets) go through only when they carry none of the applicant's details. Presses of
// buttons that read like Submit, form submissions and pages that look like a confirmation are flagged.
//
//   NODE_USE_ENV_PROXY=1 node tests/live/buttons.mjs [--buttons fill,quick,auto] [--urls a,b] [--from list.txt]
//                         [--limit N] [--out report.json] [--md report.md] [--shots dir] [--append]
//
// The AI is the stand-in provider (tests/e2e/mock-ai.mjs). The applicant is the survey's fictional one.
// --from takes a file of URLs (one per line, # for comments) or a TSV whose last column is the URL. HEADED=1 shows
// the browser.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../e2e/harness.mjs';
import { mockAi } from '../e2e/mock-ai.mjs';
import { SURVEY_PROFILE } from './profile.mjs';
import { controlCount, cvPdf, reachForm, tabIdOf } from './survey.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => {
    if (!a.startsWith('--')) return [];
    const [k, v] = a.slice(2).split('=');
    const next = all[i + 1];
    return [k, v != null ? v : next && !next.startsWith('--') ? next : true];
  }),
);
const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = args.out || path.join(here, 'buttons-report.json');
const MD = args.md || OUT.replace(/\.json$/, '') + '.md';
const SHOTS = args.shots || path.join(here, 'buttons-shots');
const BUTTONS = String(args.buttons || 'fill,quick,auto').split(',');
const LIMIT = +args.limit || 1000;
// The longest each button's run is waited for.
const TIMEOUT = { fill: 3 * 60e3, quick: 6 * 60e3, auto: 10 * 60e3 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ the guard */

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);
const LOCAL = /^(127\.0\.0\.1|localhost|\[::1\])$/;
// The applicant's details: a request that carries any of them is never let through.
const PERSONAL = [
  SURVEY_PROFILE.contact.email,
  SURVEY_PROFILE.contact.phone,
  SURVEY_PROFILE.contact.phone.replace(/\D/g, ''),
  SURVEY_PROFILE.address.line1,
  SURVEY_PROFILE.links.linkedin.split('/in/')[1],
].map((s) => s.toLowerCase());
const CONFIRMATION = /thank-?you|thanks|submitted|confirmation|application-?(received|complete)|\/success\b/i;
const SUBMITS = /^\s*(submit|send|finish|complete)\b|submit (my |your )?application|^\s*apply( now)?\s*$/i;

/** Does a request carry any of the applicant's details? */
function personal(req) {
  const body = (req.postData() || '').toLowerCase();
  const url = req.url().toLowerCase();
  return PERSONAL.some((p) => body.includes(p) || url.includes(encodeURIComponent(p)) || url.includes(p));
}

/** A read some boards send as a POST: a GraphQL query (Ashby's posting), Phenom's widgets and its lists. */
function readPost(req) {
  const url = new URL(req.url());
  const body = req.postData() || '';
  const json = () => {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  };
  if (/graphql/i.test(url.pathname)) {
    const ops = [].concat(json() || []);
    return (
      ops.length > 0 &&
      ops.every((op) => op && typeof op.query === 'string' && /^\s*(query\b|\{)/.test(op.query)) &&
      !/\bmutation\b/.test(body)
    );
  }
  if (/^\/widgets\/?$/.test(url.pathname)) return true;
  if (/\/applySubmit\/?$/.test(url.pathname)) return /^apply(Get|Fetch)/i.test((json() || {}).ddoKey || '');
  return false;
}

/** Abort every request off this machine that isn't a read; `tally()` is the current run's record of them. */
async function guard(context, tally) {
  await context.route('**/*', async (route) => {
    const req = route.request();
    let url;
    try {
      url = new URL(req.url());
    } catch {
      return route.continue().catch(() => {});
    }
    const t = tally();
    const op = url.searchParams.get('op') || '';
    const line = `${req.method()} ${url.host}${url.pathname}${op ? `?op=${op}` : ''}`.slice(0, 160);
    if (!/^https?:$/.test(url.protocol) || LOCAL.test(url.hostname)) return route.continue().catch(() => {});
    if (READS.has(req.method())) {
      if (req.isNavigationRequest() && CONFIRMATION.test(url.pathname + url.search)) t.confirmations.push(req.url());
      return route.continue().catch(() => {});
    }
    if (!personal(req) && readPost(req)) {
      t.reads.push(line);
      return route.continue().catch(() => {});
    }
    t.blocked.push(line + (personal(req) ? ' [applicant data]' : ''));
    return route.abort('blockedbyclient').catch(() => {});
  });
}

/** Record, in every frame's page world, each press of a button or link and each form sent (read by `presses`). */
function watchPresses() {
  if (window.__jtfPresses) return;
  const log = (window.__jtfPresses = []);
  const name = (el) =>
    String(el.innerText || el.value || el.getAttribute('aria-label') || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
  addEventListener(
    'click',
    (e) => {
      const el = e.target && e.target.closest && e.target.closest('button, a, [role=button], input[type=submit]');
      if (el) log.push({ at: Date.now(), what: 'click', text: name(el), type: el.type || '', href: el.href || '' });
    },
    true,
  );
  addEventListener(
    'submit',
    (e) => log.push({ at: Date.now(), what: 'submit', text: String(e.target.action || '') }),
    true,
  );
}

/** The presses recorded in a page's frames since `since`. */
export async function presses(page, since) {
  const out = [];
  for (const f of page.frames())
    out.push(...(await f.evaluate((t) => (window.__jtfPresses || []).filter((p) => p.at >= t), since).catch(() => [])));
  return out;
}

/* ------------------------------------------------------------- targets */

/** The forms to run: --urls, or --from (a URL list or the Trackr TSV), else the list verified reachable. */
async function targets() {
  const tsv = await readFile(args.tsv || path.join(path.dirname(OUT), 'live-form-urls.tsv'), 'utf8').catch(() => '');
  const known = tsv
    .split('\n')
    .map((l) => l.split('\t'))
    .filter((c) => c.length >= 4)
    .map(([ats, company, type, url]) => ({ ats, company, type, url }));
  const base = (u) =>
    String(u)
      .replace(/[?#].*$/, '')
      .replace(/\/+$/, '');
  const lines = args.urls
    ? String(args.urls).split(',')
    : (await readFile(args.from || path.join(path.dirname(OUT), 'live-reachable.txt'), 'utf8'))
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => l.split('\t').pop());
  return lines.slice(0, LIMIT).map((url) => {
    const hit = known.find((k) => base(k.url) === base(url)) || {};
    return { url, company: hit.company || '', listedAts: hit.ats || '' };
  });
}

/* ------------------------------------------------------------- the runs */

/** In each frame's content-script world: every field, whether it holds a value, is required, was the AI's. */
export function fieldsNow(h, tabId) {
  return h.bg(async (id) => {
    const results = await globalThis.JTF.api.scripting
      .executeScript({
        target: { tabId: id, allFrames: true },
        func: () => {
          const J = globalThis.JTF;
          if (!J || !J.dom || !J.fill) return null;
          return J.dom.collect(document).map((f) => ({
            visible: J.dom.isVisible(f.el),
            kind: f.kind,
            q: J.util.cleanLabel(J.matcher.questionText(f.desc), 100),
            filled: J.fill.hasValue(f),
            required: !!J.dom.isRequired(f),
            ai:
              /dashed/.test(f.el.style.outline || '') ||
              /dashed/.test((f.el.parentElement || f.el).style.outline || ''),
          }));
        },
      })
      .catch(() => []);
    return results.flatMap((r) => r.result || []);
  }, tabId);
}

/** What the page still wants at the end, as the check reads it: required boxes empty, boxes it turned down. */
export function problemsNow(h, tabId) {
  return h.bg(async (id) => {
    const { profile, settings } = await globalThis.JTF.store.getActive();
    const frames = await globalThis.JTFBackground.callFrames(id, 'problems', [
      { profile, settings: { ...settings, consents: true } },
    ]).catch(() => []);
    const items = frames.flatMap((f) => (f && f.items) || []);
    return {
      items: items.map((it) => ({ question: it.question || it.label, message: it.message, fix: it.fix, why: it.why })),
      requiredEmpty: items.filter((it) => it.required && it.empty).length,
      flagged: items.filter((it) => !it.empty).length,
      errors: [...new Set(frames.flatMap((f) => (f && f.errors) || []))],
    };
  }, tabId);
}

/** The run in a tab, once it has ended (null while it runs or before it starts). */
const runEnded = (h, tabId) =>
  h.bg(async (id) => {
    const r = await globalThis.JTFBackground.runStatus(id);
    return r && r.state !== 'running' ? r : null;
  }, tabId);
const runNow = (h, tabId) => h.bg((id) => globalThis.JTFBackground.runStatus(id), tabId);
const handler = (h, type, msg) => h.bg(([t, m]) => globalThis.JTFBackground.handlers[t](m, {}), [type, msg]);

/** Wait for a tab's run to end, saying on the console what it is doing; on time out it is stopped. */
async function waitRun(h, tabId, deadline, label, kind) {
  let said = '';
  for (;;) {
    const run = await runNow(h, tabId).catch(() => null);
    if (run && (!kind || run.kind === kind)) {
      const now = `${run.stage}: ${run.message}`;
      if (now !== said) console.log(`    ${label} ${now.slice(0, 150)}`);
      said = now;
      if (run.state !== 'running') return run;
    }
    if (Date.now() > deadline) {
      await handler(h, 'jtf:run-stop', { tabId }).catch(() => {});
      for (let i = 0; i < 30; i++) {
        const r = await runEnded(h, tabId).catch(() => null);
        if (r) return { ...r, timedOut: true };
        await sleep(1000);
      }
      return { ...(run || {}), state: 'timeout', timedOut: true };
    }
    await sleep(1000);
  }
}

/** Press one of the three buttons in a tab, and wait for its run to end. */
export async function press(h, button, tabId, started) {
  const deadline = started + TIMEOUT[button];
  if (button === 'fill') {
    const summary = await handler(h, 'jtf:fill', { tabId, toast: true, check: true });
    const fill = summary && {
      filled: summary.filled,
      detected: summary.detected,
      pending: summary.pending,
      ai: summary.ai && summary.ai.status,
      error: summary.error,
      checking: summary.checking,
      notes: (summary.notes || []).slice(0, 5),
    };
    if (!summary || summary.error || !summary.checking)
      return { run: { state: 'no-run', message: (summary && summary.error) || 'no check started' }, fill };
    return { run: await waitRun(h, tabId, deadline, 'fill', 'fill'), fill };
  }
  if (button === 'quick') {
    const start = await handler(h, 'jtf:quick-start', { tabId });
    if (!start || start.error) return { run: { state: 'error', message: (start && start.error) || 'no start' } };
    let quick = null;
    let said = '';
    while (Date.now() < deadline) {
      quick = await h.bg(() => globalThis.JTF.store.getQuickStatus()).catch(() => null);
      if (quick && quick.message !== said)
        console.log(`    quick ${quick.state}: ${String(quick.message).slice(0, 150)}`);
      said = quick && quick.message;
      if (quick && quick.state !== 'running') break;
      await sleep(1500);
    }
    // The check starts with the fill the letter's arrival makes; a Quick apply that failed may never start one.
    for (let i = 0; i < 20 && !(await runNow(h, tabId)); i++) await sleep(1000);
    const run = (await runNow(h, tabId))
      ? await waitRun(h, tabId, deadline, 'quick', 'quick')
      : { state: quick && quick.state === 'error' ? 'error' : 'no-run', message: quick && quick.message };
    return { run, quick: quick && { state: quick.state, message: quick.message } };
  }
  const r = await handler(h, 'jtf:autopilot', { tabId });
  if (!r || r.error) return { run: { state: 'error', message: (r && r.error) || 'no start' } };
  return { run: await waitRun(h, tabId, deadline, 'auto', 'auto') };
}

/** Forget what the last run left behind: Quick apply's result, the letters and AI answers kept for applications. */
export async function cleanSlate(h) {
  await h.bg(async () => {
    const { store, api } = globalThis.JTF;
    await store.clearQuickApply();
    await api.storage.local.set({ letters: [], answers: [] });
    for (const t of await api.tabs.query({})) if (/studio\/studio\.html/.test(t.url || '')) await api.tabs.remove(t.id);
  });
}

const slug = (s) =>
  String(s)
    .replace(/^https?:\/\/(www\.)?/, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .slice(0, 60);

/** One button on one form, from a freshly loaded page. */
export async function runOne(h, ai, target, button, tally, n) {
  const entry = { url: target.url, company: target.company, button, at: new Date().toISOString() };
  const t0 = Date.now();
  await cleanSlate(h);
  let page = await h.newPage();
  const record = { blocked: [], reads: [], confirmations: [] };
  tally.current = record;
  try {
    page = await reachForm(page, target.url);
    // A posting whose Apply link wasn't there yet (Phenom draws it late): once more, from the start.
    if ((await controlCount(page)) < 5) {
      for (const p of h.context.pages()) if (p !== page) await p.close().catch(() => {});
      page = await reachForm(page, target.url);
    }
    entry.formUrl = page.url();
    entry.controls = await controlCount(page);
    if (entry.controls < 5) throw new Error(`no application form reached (${entry.controls} controls)`);
    const tabId = await tabIdOf(h, page);
    if (tabId == null) throw new Error('tab not found');
    const where = await h.bg((u) => globalThis.JTF.jobpage.ats(u), entry.formUrl);
    entry.ats = (where && where.name) || target.listedAts || new URL(entry.formUrl).hostname;
    entry.company = entry.company || (where && where.company) || '';
    await h.bg((id) => globalThis.JTFBackground.ensureInjected(id), tabId).catch(() => {});
    const before = await fieldsNow(h, tabId);
    entry.detectedBefore = before.length;
    const calls = ai.calls.length;
    const started = Date.now();
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame() && CONFIRMATION.test(new URL(f.url()).pathname)) record.confirmations.push(f.url());
    });
    const out = await press(h, button, tabId, started);
    await sleep(2500);
    const run = out.run || {};
    Object.assign(entry, {
      state: run.state,
      timedOut: !!run.timedOut,
      message: run.message || '',
      steps: run.steps || 0,
      step: run.step || null,
      total: run.total || null,
      final: !!run.final,
      runFilled: run.filled || 0,
      runAi: run.ai || 0,
      fixed: run.fixed || 0,
      left: (run.left || []).map((x) => ({ question: x.question, message: x.message, why: x.why })),
      runProblems: (run.problems || []).map((p) => ({ question: p.question, message: p.message, fix: p.fix })),
      lines: run.lines || [],
      fill: out.fill || null,
      quick: out.quick || null,
      seconds: Math.round((Date.now() - started) / 1000),
    });
    entry.endUrl = page.url();
    const fields = await fieldsNow(h, tabId);
    entry.detected = fields.length;
    entry.filledNow = fields.filter((f) => f.filled).length;
    entry.aiOutlined = fields.filter((f) => f.ai).length;
    entry.visibleFields = fields.filter((f) => f.visible).length;
    entry.emptyRequired = fields
      .filter((f) => f.required && !f.filled)
      .map((f) => `${f.kind}: ${f.q}${f.visible ? '' : ' (hidden)'}`);
    entry.finalProblems = await problemsNow(h, tabId);
    entry.aiCalls = {};
    for (const c of ai.calls.slice(calls)) entry.aiCalls[c.kind] = (entry.aiCalls[c.kind] || 0) + 1;
    const pressed = await presses(page, started);
    entry.presses = pressed.map((p) => `${p.what}:${p.text}`).slice(0, 30);
    entry.submitPresses = pressed.filter((p) => p.what === 'submit' || SUBMITS.test(p.text)).map((p) => p.text);
    await mkdir(SHOTS, { recursive: true });
    entry.shot = path.join(SHOTS, `${String(n).padStart(2, '0')}-${button}-${slug(target.company || target.url)}.jpg`);
    await page
      .screenshot({ path: entry.shot, fullPage: true, type: 'jpeg', quality: 55, timeout: 30000 })
      .catch((err) => (entry.shot = `screenshot failed: ${err.message.split('\n')[0]}`));
  } catch (err) {
    entry.state = entry.state || 'unreached';
    entry.error = String(err.message || err).split('\n')[0];
  }
  entry.blocked = record.blocked.length;
  entry.blockedList = [...new Set(record.blocked)].slice(0, 20);
  entry.applicantDataBlocked = record.blocked.filter((b) => b.endsWith('[applicant data]')).length;
  entry.readPosts = record.reads.length;
  entry.confirmations = [...new Set(record.confirmations)];
  entry.duration = Math.round((Date.now() - t0) / 1000);
  await forgetSites(h);
  for (const p of h.context.pages()) await p.close().catch(() => {});
  return entry;
}

/** What the sites kept of the run (Breezy restores a draft from local storage): gone, so the next run starts clean. */
async function forgetSites(h) {
  for (const p of h.context.pages())
    for (const f of p.frames())
      if (/^https?:/.test(f.url()))
        await f
          .evaluate(() => {
            try {
              localStorage.clear();
              sessionStorage.clear();
            } catch {
              // A frame whose storage is blocked keeps nothing either.
            }
          })
          .catch(() => {});
  await h.context.clearCookies().catch(() => {});
}

/* -------------------------------------------------------------- report */

const cell = (s) =>
  String(s == null ? '' : s)
    .replace(/\|/g, '/')
    .replace(/\s+/g, ' ')
    .trim();

/** The report as a Markdown table, one row per form and button, with the totals per button. */
function markdown(report) {
  const rows = [
    '| # | Company | ATS | Button | State | Steps | Filled/detected | AI | Fixed | Left | Empty req. | Blocked | Secs | Message |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  report.forEach((e, i) => {
    const steps =
      e.button === 'auto' ? `${e.steps}${e.total ? ` (${e.step}/${e.total})` : ''}${e.final ? ' final' : ''}` : '';
    const ai = e.aiCalls ? e.aiCalls.answers || 0 : 0;
    rows.push(
      `| ${i + 1} | ${cell(e.company)} | ${cell(e.ats)} | ${e.button} | ${cell(e.state)}${e.timedOut ? ' (timeout)' : ''} | ${steps} | ${e.filledNow != null ? `${e.filledNow}/${e.detected}` : ''} | ${e.aiOutlined != null ? `${e.aiOutlined} (${ai} req)` : ''} | ${e.fixed || 0} | ${(e.left || []).length} | ${e.finalProblems ? e.finalProblems.requiredEmpty : ''} | ${e.blocked}${e.submitPresses && e.submitPresses.length ? ' SUBMIT?' : ''}${e.confirmations && e.confirmations.length ? ' CONFIRM?' : ''} | ${e.seconds != null ? e.seconds : e.duration} | ${cell(e.error || e.message).slice(0, 220)} |`,
    );
  });
  rows.push('', '| Button | Runs | done | stopped | error | other |', '|---|---|---|---|---|---|');
  for (const b of BUTTONS) {
    const of = report.filter((e) => e.button === b);
    const n = (s) => of.filter((e) => e.state === s).length;
    rows.push(
      `| ${b} | ${of.length} | ${n('done')} | ${n('stopped')} | ${n('error')} | ${of.length - n('done') - n('stopped') - n('error')} |`,
    );
  }
  return rows.join('\n') + '\n';
}

/**
 * The browser, guarded, with the fictional applicant, their CV and the stand-in AI set up. Returns { h, ai, tally }:
 * set `tally.current` to a run's record ({ blocked, reads, confirmations }) to count what it would have sent.
 */
export async function setUp() {
  const ai = await mockAi();
  const tally = { current: { blocked: [], reads: [], confirmations: [] } };
  const h = await launch();
  await guard(h.context, () => tally.current);
  await h.context.addInitScript(watchPresses);
  const profileId = await h.setProfile(SURVEY_PROFILE);
  const dataUrl = await cvPdf();
  await h.bg(
    async ([id, d, base]) => {
      const { store } = globalThis.JTF;
      await store.setDoc(id, 'resume', { name: 'Alex_Morgan_CV.pdf', type: 'application/pdf', size: 3000, dataUrl: d });
      await store.saveSettings({
        consents: false,
        logApplications: false,
        ai: { provider: 'custom', baseUrl: base, model: 'mock' },
      });
      await store.setAiKey('test-key');
      await store.saveKit(id, { minWords: 80 });
    },
    [profileId, dataUrl, ai.url],
  );
  return { h, ai, tally };
}

async function main() {
  const list = await targets();
  console.log(`${list.length} forms × ${BUTTONS.join(', ')}`);
  const { h, ai, tally } = await setUp();
  const report = args.append ? JSON.parse(await readFile(OUT, 'utf8').catch(() => '[]')) : [];
  let n = report.length;
  for (const target of list)
    for (const button of BUTTONS) {
      n++;
      console.log(`[${n}] ${button} ${target.company || ''} ${target.url}`);
      const entry = await runOne(h, ai, target, button, tally, n);
      console.log(
        `  → ${entry.state}${entry.timedOut ? ' (timeout)' : ''} ${entry.filledNow != null ? `${entry.filledNow}/${entry.detected} filled` : ''}` +
          ` fixed ${entry.fixed || 0}, left ${(entry.left || []).length}, empty required ${entry.finalProblems ? entry.finalProblems.requiredEmpty : '?'}` +
          `, blocked ${entry.blocked}, ${entry.seconds || entry.duration}s: ${String(entry.error || entry.message).slice(0, 200)}`,
      );
      if (entry.submitPresses && entry.submitPresses.length)
        console.log(`  !! submit-like presses: ${entry.submitPresses}`);
      if (entry.confirmations.length) console.log(`  !! confirmation-like pages: ${entry.confirmations}`);
      report.push(entry);
      await writeFile(OUT, JSON.stringify(report, null, 1));
      await writeFile(MD, markdown(report));
    }
  await h.close();
  await ai.close();
  console.log(markdown(report));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
