// End-to-end: the popup's three buttons, with a stand-in AI provider (mock-ai.mjs). "Fill this page" fills, has the AI
// answer what the rules leave, then checks the page and puts right what it still wants (a run of kind 'fill'); "Fill +
// letter & CV" is Quick apply with the same check (kind 'quick'); "Apply for me" does everything on every step: the
// letter and tailored CV, your details, the AI's answers, the step's own "Save and Continue", what the page says when
// it turns a step down, until the step that submits (kind 'auto'). Nothing is ever submitted, and what you typed is
// never written over. Chromium; the tests that type as a person or open the popup use Playwright's page APIs and are
// skipped in Firefox.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { PROFILE, isFirefox, launch, text, typeInto, until, value } from './harness.mjs';
import { mockAi } from './mock-ai.mjs';

const playwright = { skip: isFirefox && 'uses Playwright page APIs' };

const CV_LINES = [
  'Ada Lovelace',
  'Education: University of Cambridge, BSc Mathematics, 2012 - 2016',
  'Experience: Analytical Engines Inc, Senior Engineer, 2020 - present',
  '- Built a reconciliation tool in Python that checks 40,000 trades a night',
  '- Cut manual checks for the operations team from 3 hours to 20 minutes',
  'Babbage Labs, Engineer, 2016 - 2020',
  '- Wrote data quality tests for the settlement pipeline in SQL',
  '- Explained breaks to traders and engineers every morning',
  'Skills: Python, SQL, Mathematics',
];

/** A real CV, as a PDF the letter writer can read (more than 60 words, so there is enough to write from). */
async function cvPdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  CV_LINES.forEach((line, i) => page.drawText(line, { x: 50, y: 790 - i * 18, size: 11, font }));
  return 'data:application/pdf;base64,' + Buffer.from(await doc.save()).toString('base64');
}

let h;
let ai;
// Every request that isn't a plain page load, from a page or the extension, other than to a stand-in AI (Chromium).
const posts = [];
const aiOrigins = new Set();

before(async () => {
  h = await launch();
  ai = await mockAi();
  const profileId = await h.setProfile(PROFILE);
  await h.bg(
    async ([id, url, base]) => {
      const { store } = globalThis.JTF;
      await store.setDoc(id, 'resume', { name: 'ada_cv.pdf', type: 'application/pdf', size: url.length, dataUrl: url });
      await store.saveSettings({ ai: { provider: 'custom', baseUrl: base, model: 'mock' } });
      await store.setAiKey('test-key');
      await store.saveKit(id, { minWords: 80 });
    },
    [profileId, await cvPdf(), ai.url],
  );
  aiOrigins.add(new URL(ai.url).origin);
  if (h.context)
    h.context.on('request', (req) => {
      const url = req.url();
      if (req.method() !== 'GET' && !aiOrigins.has(new URL(url).origin) && !/^(chrome-extension|data|blob):/.test(url))
        posts.push(`${req.method()} ${url}`);
    });
});

after(async () => {
  await h.close();
  await ai.close();
});

/* ------------------------------------------------------------------ helpers */

const state = async (page) => JSON.parse(await text(page, '#state'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** From now on, a form sent from the page, or a press of anything that says Submit, Apply or Send, is kept on it. */
const guard = (page) =>
  page.$eval('html', (root) => {
    const note = (what) => (root.dataset.sent = JSON.stringify([...JSON.parse(root.dataset.sent || '[]'), what]));
    document.addEventListener('submit', (e) => note(`submit ${e.target.id || 'a form'}`), true);
    document.addEventListener(
      'click',
      (e) => {
        const el = e.target.closest('button, input, a, [role="button"]');
        const label = el ? (el.getAttribute('aria-label') || el.value || el.textContent || '').trim() : '';
        if (/^(submit|apply|send)\b/i.test(label)) note(`press ${label}`);
      },
      true,
    );
  });

/** Nothing was sent: no form submitted or Submit pressed on the page, and no request but page loads (Chromium). */
async function nothingSent(page) {
  assert.deepEqual(await page.$eval('html', (el) => JSON.parse(el.dataset.sent || '[]')), [], 'nothing pressed');
  assert.deepEqual(posts.splice(0), [], 'no request but page loads left the browser');
}

/** Open a fixture with the submit guard on. */
async function open(file) {
  const page = await h.open(file);
  await guard(page);
  return page;
}

/** The latest run on the page's tab, as the popup reads it (null when there is none). */
const runOf = async (page) => h.bg((id) => globalThis.JTFBackground.runStatus(id), await h.tabId(page));

/** Wait for the run on the page's tab (of `kind`, when given) to end, and return it. */
async function runEnds(page, kind, timeout = 180000) {
  const id = await h.tabId(page);
  return until(
    h.bg,
    async ([tab, k]) => {
      const r = await globalThis.JTFBackground.runStatus(tab);
      return r && r.state !== 'running' && (!k || r.kind === k) ? r : null;
    },
    [id, kind],
    timeout,
  );
}

/** Wait for the run on the page's tab to say something that matches `re`, and return it. */
async function runSays(page, re, timeout = 60000) {
  const id = await h.tabId(page);
  return until(
    h.bg,
    async ([tab, source]) => {
      const r = await globalThis.JTFBackground.runStatus(tab);
      return r && new RegExp(source).test(r.message) ? r : null;
    },
    [id, re.source],
    timeout,
  );
}

/** Press Apply for me as the popup does: it answers at once, then runs on in the background. */
async function startPilot(page) {
  const started = await h.handler('jtf:autopilot', page);
  assert.deepEqual(started, { ok: true });
}

/** Press Apply for me and wait for its run to end. */
async function applyForMe(page, timeout) {
  await startPilot(page);
  return runEnds(page, 'auto', timeout);
}

/** Press Fill this page as the popup does: the fill's summary at once, the check in the background. */
const fillThisPage = (page) => h.handler('jtf:fill', page, { check: true });

/** Quick apply (started by a button) is no longer writing, and its working tabs are closed. */
async function quickIdle() {
  await until(
    h.bg,
    async () => {
      const s = await globalThis.JTF.store.getQuickStatus();
      return !s || s.state !== 'running';
    },
    null,
    120000,
  );
  await h.bg(async () => {
    const tabs = await globalThis.JTF.api.tabs.query({});
    for (const t of tabs) if (/studio\/studio\.html/.test(t.url)) await globalThis.JTF.api.tabs.remove(t.id);
  });
}

/** Forget the answers the AI wrote (they are used again on the same application), so the next are written afresh. */
const forgetAnswers = () => h.bg(() => globalThis.JTF.api.storage.local.set({ answers: [] }));

/** The name of the file in an upload box ('' when there is none). */
const fileName = (page, sel) => page.$eval(sel, (el) => (el.files[0] ? el.files[0].name : ''));

/** The questions the AI was asked since `from` calls, by their words. */
const askedSince = (from) =>
  ai.calls
    .slice(from)
    .filter((c) => c.kind === 'answers')
    .flatMap((c) => {
      const user = (c.json.messages || []).find((m) => m.role === 'user');
      try {
        return JSON.parse(String(user.content).split('QUESTIONS:\n')[1]);
      } catch {
        return [];
      }
    });

/** What a run says, for an assertion's message. */
const told = (run) => JSON.stringify({ state: run.state, message: run.message, left: run.left }, null, 1);

/** The rules fill contact details, dates, links, diversity and consent questions: the AI never sees those. */
function rulesOnly(asked) {
  const words = asked.map((q) => q.question).join(' | ');
  assert.doesNotMatch(words, /phone|start date|linkedin|e-?mail/i, 'contact details, dates and links are the rules’');
  assert.doesNotMatch(words, /gender|veteran|consent/i, 'diversity and consent questions are never the AI’s');
}

/* ------------------------------------------------------------ Apply for me */

test('Apply for me: every step of a Workday application that checks each one, up to Review, never Submit', async () => {
  const from = ai.calls.length;
  const page = await open('workday-validate.html?t=a');
  const run = await applyForMe(page);
  const s = await state(page);
  assert.equal(run.kind, 'auto');
  assert.equal(run.state, 'done', told(run));
  assert.equal(run.final, true);
  assert.match(run.message, /^Ready to submit \(step 5 of 5\)/);
  assert.match(run.message, /press Submit yourself/);
  assert.deepEqual([run.step, run.total, run.steps], [5, 5, 4]);
  assert.deepEqual(run.left, []);
  assert.ok(run.fixed >= 2, `fixed ${run.fixed}`);
  assert.ok(run.ai >= 1, `ai ${run.ai}`);

  // On Review, and never sent.
  assert.equal(s.step, 5);
  assert.equal(s.submitted, false);
  assert.equal(s.presses[5], undefined, 'Submit never pressed');
  // My Information was turned down once (the phone's spaces, the start date nobody marked required), then put right
  // by the rules; every other step went through at the first press.
  assert.deepEqual(s.refused, { 1: 1 });
  assert.deepEqual(s.presses, { 1: 2, 2: 1, 3: 1, 4: 1 });
  assert.equal(s.values.phone, '4155550100');
  assert.equal(s.values.start, '11/2026');
  assert.equal(s.values.linkedin, 'https://www.linkedin.com/in/ada');
  assert.equal(s.values.first, 'Ada');
  assert.equal(s.experience, 2, 'an entry for each job');
  assert.equal(s.education, 1);
  // The AI wrote the essay, long enough the first time; the profile answered the rest.
  assert.ok(s.values.why.length >= 150, `${s.values.why.length} characters`);
  assert.equal(s.values.auth, 'Yes');
  assert.equal(s.values.spons, 'No');
  assert.equal(s.values.relative, 'No');
  assert.equal(s.values.gender, 'Female');
  assert.equal(s.values.consent, true, 'the data consent ticked');
  const asked = askedSince(from);
  assert.ok(
    asked.some((q) => /Why do you want to join/.test(q.question)),
    JSON.stringify(asked.map((q) => q.question)),
  );
  rulesOnly(asked);
  // The tailored CV went into My Experience's Resume/CV, not the usual one.
  assert.notEqual(s.values.resume, 'ada_cv.pdf');
  assert.match(s.values.resume, /^ada_lovelace_cv[\w]*\.pdf$/);
  await nothingSent(page);
  await quickIdle();
  await page.close();
});

test('Apply for me: a question drawn only once it is scrolled into view is answered too', async () => {
  const page = await open('workday-validate.html?lazy=1');
  const run = await applyForMe(page);
  const s = await state(page);
  assert.equal(run.state, 'done', told(run));
  assert.equal(run.final, true);
  assert.equal(s.step, 5);
  assert.equal(s.submitted, false);
  // The sweep scrolled Application Questions' last question into view before the fill: it went through at once.
  assert.equal(s.values.relative, 'No');
  assert.equal(s.refused[3], undefined, 'Application Questions went through at the first press');
  await nothingSent(page);
  await quickIdle();
  await page.close();
});

test('Apply for me: the step with the CV upload waits for the tailored CV, then gets it, not your usual one', async () => {
  let release;
  ai.gate.letter = new Promise((resolve) => (release = resolve));
  const page = await open('workday-validate.html?t=c');
  try {
    await startPilot(page);
    // My Information goes through while the letter is written; My Experience, with the Resume/CV, waits.
    const waiting = await runSays(page, /waiting for your cover letter and tailored CV/);
    assert.equal(waiting.state, 'running');
    assert.equal(waiting.stage, 'letters');
    await sleep(2500);
    let s = await state(page);
    assert.equal(s.step, 2);
    assert.equal(s.presses[2], undefined, 'Save and Continue not pressed while the CV is coming');
    assert.equal(await fileName(page, '#resume'), '', 'the usual CV doesn’t take its place meanwhile');
    assert.equal((await runOf(page)).state, 'running');

    release();
    const run = await runEnds(page, 'auto');
    s = await state(page);
    assert.equal(run.state, 'done', told(run));
    assert.equal(run.final, true);
    assert.equal(s.submitted, false);
    assert.notEqual(s.values.resume, 'ada_cv.pdf');
    assert.match(s.values.resume, /^ada_lovelace_cv[\w]*\.pdf$/);
    assert.doesNotMatch(run.message, /usual CV|No cover letter/);
    // The letter and CV it wrote are kept for "Last quick apply".
    const record = await h.bg(() => globalThis.JTF.store.getQuickApply());
    assert.match(record.cv.pdf, /^data:application\/pdf;base64,/);
    assert.match(record.letter.text, /^Dear /);
    await nothingSent(page);
  } finally {
    ai.gate.letter = null;
    if (release) release();
    await quickIdle();
    await page.close();
  }
});

// The page's message, read as the box's help too, repeats "at least 150 characters": answers.limits() takes the second
// for a ceiling ("at most 150 characters, at least 150 characters"), so the answer written again is cut short again.
// Once a bug: limits() reads a floor said twice as a ceiling too (answers.js FLOOR replaces only the first).

test('Apply for me: a step its essay doesn’t pass is pressed again once the AI has written it as the page asks', async () => {
  const terse = await mockAi({ terse: true });
  aiOrigins.add(new URL(terse.url).origin);
  // The essay the AI wrote on this site before would be used again: this one is written afresh.
  await forgetAnswers();
  await h.bg(
    (url) => globalThis.JTF.store.saveSettings({ ai: { provider: 'custom', baseUrl: url, model: 'mock' } }),
    terse.url,
  );
  const page = await open('workday-validate.html?start=3');
  try {
    const run = await applyForMe(page);
    const s = await state(page);
    assert.equal(run.state, 'done', told(run));
    assert.equal(run.final, true);
    assert.equal(s.step, 5);
    assert.equal(s.submitted, false);
    // The first answer was one sentence: the page turned the step down ("Enter at least 150 characters"), the AI was
    // told what it said and what it refused, and its second answer went in in place of the first.
    assert.equal(s.refused[3], 1);
    assert.ok(s.values.why.length >= 150, `${s.values.why.length} characters`);
    const fixes = terse.asked().filter((q) => q.pageError);
    assert.ok(fixes.length >= 1, JSON.stringify(terse.asked()));
    assert.match(fixes[0].question, /Why do you want to join/);
    assert.match(fixes[0].pageError, /at least 150 characters/);
    assert.ok(fixes[0].rejected && fixes[0].rejected.length < 150, 'told the answer it refused');
    assert.notEqual(s.values.why, fixes[0].rejected);
    rulesOnly(terse.asked());
    await nothingSent(page);
  } finally {
    await h.bg(
      (url) => globalThis.JTF.store.saveSettings({ ai: { provider: 'custom', baseUrl: url, model: 'mock' } }),
      ai.url,
    );
    await terse.close();
    await forgetAnswers();
    await quickIdle();
    await page.close();
  }
});

test('Apply for me: a Workday application whose essay no profile answers reaches Review with the AI’s', async () => {
  const page = await open('workday-steps.html?values=1');
  const run = await applyForMe(page);
  const s = await state(page);
  assert.equal(run.state, 'done', told(run));
  assert.equal(run.final, true);
  assert.deepEqual([run.step, run.total], [4, 4]);
  assert.equal(s.step, 4);
  assert.equal(s.submitted, false);
  assert.ok(s.values.values.length > 80, s.values.values);
  assert.equal(s.experience, 2);
  await nothingSent(page);
  await quickIdle();
  await page.close();
});

test('Apply for me: a value you typed that the page turns down is never written over', playwright, async () => {
  // Typed before JobToFill ever looked at the page, and typed over what a Fill put there.
  const before = await open('workday-validate.html?t=e1');
  await before.fill('#phone', '415-555-0199');
  const over = await open('workday-validate.html?t=e2');
  await h.fill(over);
  assert.equal(await value(over, '#phone'), '+1 415 555 0100');
  await over.fill('#phone', '415-555-0199');
  for (const page of [before, over]) {
    const run = await applyForMe(page);
    const s = await state(page);
    assert.equal(run.state, 'stopped', told(run));
    assert.equal(await value(page, '#phone'), '415-555-0199', 'what you typed is still there');
    assert.equal(s.step, 1);
    assert.equal(s.submitted, false);
    const phone = run.left.find((x) => /Phone Number/.test(x.question));
    assert.ok(phone, told(run));
    assert.match(phone.why, /you typed this yourself/);
    assert.match(run.message, /Phone Number/);
    // The start date wasn't yours: that one was put right.
    assert.equal(s.values.start, '11/2026');
    await nothingSent(page);
    await quickIdle();
    await page.close();
  }
});

test('Stop: Apply for me ends where it is, and nothing is pressed afterwards', async () => {
  let release;
  ai.gate.letter = new Promise((resolve) => (release = resolve));
  const page = await open('workday-validate.html?t=f');
  try {
    await startPilot(page);
    await runSays(page, /waiting for your cover letter and tailored CV/);
    const stopped = await h.handler('jtf:run-stop', page);
    assert.deepEqual(stopped, { stopped: true });
    const run = await runEnds(page, 'auto', 20000);
    assert.equal(run.state, 'stopped', told(run));
    assert.match(run.message, /^Stopped/);
    const at = await state(page);
    assert.equal(at.step, 2);
    // The letter it was waiting for arrives afterwards: still nothing is pressed.
    release();
    await quickIdle();
    await sleep(3000);
    const s = await state(page);
    assert.deepEqual(s.presses, at.presses);
    assert.equal(s.step, 2);
    assert.equal(s.submitted, false);
    assert.deepEqual(await h.handler('jtf:run-stop', page), { stopped: false }, 'nothing left running');
    await nothingSent(page);
  } finally {
    ai.gate.letter = null;
    if (release) release();
    await quickIdle();
    await page.close();
  }
});

// When Apply for me stops while its letter is still being written, the letter's own fill still runs once it is ready
// (quickFill: the run's entry in `pilots` is gone), and with auto-advance on, that fill presses the step's Next.
// Once a bug: after Stop, Quick apply’s late fill runs as if alone, and auto-advance presses Next.

test('Stop with “Move through multi-step applications for me” on: the letter arriving later presses nothing', async () => {
  await h.setSettings({ autoAdvance: true });
  let release;
  ai.gate.letter = new Promise((resolve) => (release = resolve));
  const page = await open('workday-validate.html?t=f2');
  try {
    await startPilot(page);
    await runSays(page, /waiting for your cover letter and tailored CV/);
    await h.handler('jtf:run-stop', page);
    const run = await runEnds(page, 'auto', 20000);
    const at = await state(page);
    release();
    await quickIdle();
    await sleep(6000);
    const s = await state(page);
    assert.deepEqual(s.presses, at.presses, 'nothing pressed after Stop');
    assert.equal(s.step, at.step);
    assert.equal(s.submitted, false);
    assert.doesNotMatch(run.message, /took too long/, 'it was stopped, not slow');
  } finally {
    await h.setSettings({ autoAdvance: false });
    ai.gate.letter = null;
    if (release) release();
    await quickIdle();
    await page.close();
  }
});

test(
  'Apply for me: what you type while the AI rewrites an answer the page turned down is what stays',
  playwright,
  async () => {
    const slow = await mockAi({ terse: true, delay: 2500 });
    aiOrigins.add(new URL(slow.url).origin);
    await forgetAnswers();
    await h.bg(
      (url) => globalThis.JTF.store.saveSettings({ ai: { provider: 'custom', baseUrl: url, model: 'mock' } }),
      slow.url,
    );
    const mine =
      'I want to join Ada & Co because reconciling trades and chasing breaks is the work I did at Analytical Engines, ' +
      'and I would like to do it on a trading desk in London.';
    const page = await open('workday-validate.html?start=3&t=race');
    try {
      await startPilot(page);
      // The page turned the one-sentence essay down; while the AI writes it again, the person types their own.
      await until(async () => slow.asked().some((q) => q.pageError), null, null, 90000);
      await page.fill('#why', mine);
      const run = await runEnds(page, 'auto');
      const s = await state(page);
      assert.equal(s.values.why, mine, told(run));
      assert.equal(s.submitted, false);
      assert.equal(run.state, 'done', told(run));
      assert.equal(s.step, 5);
      await nothingSent(page);
    } finally {
      await h.bg(
        (url) => globalThis.JTF.store.saveSettings({ ai: { provider: 'custom', baseUrl: url, model: 'mock' } }),
        ai.url,
      );
      await slow.close();
      await forgetAnswers();
      await quickIdle();
      await page.close();
    }
  },
);

test('Apply for me on one-page forms: filled, letter and tailored CV in, and left for you to submit', async () => {
  for (const file of ['greenhouse.html', 'lever.html', 'ashby.html', 'letters/apply.html?job=R-1234']) {
    const from = ai.calls.length;
    const page = await open(file);
    const run = await applyForMe(page);
    assert.equal(run.kind, 'auto');
    assert.ok(['done', 'stopped'].includes(run.state), `${file}: ${told(run)}`);
    if (run.state === 'done') {
      assert.match(run.message, /submit it yourself|press Submit yourself/, file);
      assert.deepEqual(run.left, [], file);
    } else {
      assert.ok(run.left.length, `${file}: a stop says what is left`);
      assert.ok(run.message.includes(run.left[0].question), `${file}: ${told(run)}`);
    }
    if (run.final) assert.match(run.message, /^Ready to submit/, file);
    assert.equal(run.steps, 0, `${file}: one page, nothing pressed`);
    assert.ok(run.filled > 3, `${file}: filled ${run.filled}`);
    // Each upload with a file has the tailored CV or the letter: never the usual CV in the tailored one's place.
    const files = await page.$$eval('input[type="file"]', (els) => els.map((el) => (el.files[0] || {}).name || ''));
    assert.ok(
      files.some((n) => /^ada_lovelace_cv/.test(n)),
      `${file}: ${files}`,
    );
    assert.ok(!files.includes('ada_cv.pdf'), `${file}: ${files}`);
    rulesOnly(askedSince(from));
    await nothingSent(page);
    await quickIdle();
    await page.close();
  }
  // Greenhouse's form is taken for the last step: ready to submit.
  const page = await open('greenhouse.html?again=1');
  const run = await applyForMe(page);
  assert.equal(run.final, true, told(run));
  await quickIdle();
  await page.close();
});

test('Apply for me without an AI key: the profile’s answers, the rules’ fixes, and a stop at the essay', async () => {
  const calls = ai.calls.length;
  await h.bg(() => globalThis.JTF.store.setAiKey(''));
  const page = await open('workday-validate.html?t=j');
  try {
    const run = await applyForMe(page);
    const s = await state(page);
    assert.equal(run.state, 'stopped', told(run));
    assert.match(run.message, /No AI is set up \(Settings › Cover letters & AI\)/);
    assert.equal(run.ai, 0);
    assert.equal(ai.calls.length, calls, 'no request to any AI');
    // My Information turned down once and put right by the rules alone; My Experience with your usual CV.
    assert.deepEqual(s.refused, { 1: 1 });
    assert.equal(s.values.phone, '4155550100');
    assert.equal(s.values.start, '11/2026');
    assert.equal(s.values.resume, 'ada_cv.pdf');
    // Application Questions' essay is yours: not pressed with it empty.
    assert.equal(s.step, 3);
    assert.equal(s.presses[3], undefined);
    assert.equal(s.submitted, false);
    assert.ok(
      run.left.some((x) => /Why do you want to join/.test(x.question)),
      told(run),
    );
    assert.match(run.message, /Why do you want to join/);
    await nothingSent(page);
  } finally {
    await h.bg(() => globalThis.JTF.store.setAiKey('test-key'));
    await quickIdle();
    await page.close();
  }
});

test('Apply for me without an AI key: what is left says no AI is set up, not that the AI couldn’t answer', async () => {
  await h.bg(() => globalThis.JTF.store.setAiKey(''));
  const page = await open('workday-validate.html?start=3&t=j2');
  try {
    const run = await applyForMe(page);
    assert.equal(run.state, 'stopped', told(run));
    const essay = run.left.find((x) => /Why do you want to join/.test(x.question));
    assert.ok(essay, told(run));
    assert.doesNotMatch(essay.why, /the AI couldn’t answer/);
    assert.match(essay.why, /no AI|AI is set up|yours/i);
  } finally {
    await h.bg(() => globalThis.JTF.store.setAiKey('test-key'));
    await quickIdle();
    await page.close();
  }
});

test('Apply for me on a sign-in page stops and says so, with nothing pressed', async () => {
  // With the account flow on (the default) and no saved login, and with it off.
  for (const accountFlow of [true, false]) {
    await h.setSettings({ accountFlow });
    const page = await open(`login.html?flow=${accountFlow}`);
    try {
      const run = await applyForMe(page);
      assert.equal(run.state, 'stopped', told(run));
      assert.match(run.message, accountFlow ? /sign in yourself/ : /^This is a sign-in page: sign in/);
      assert.equal(await value(page, '#pw'), '');
      assert.equal(run.steps, 0);
      await nothingSent(page);
    } finally {
      await h.setSettings({ accountFlow: true });
      await quickIdle();
      await page.close();
    }
  }
});

/* --------------------------------------------------------- Fill this page */

test('Fill this page: the AI’s answers, then a check of the page (a run of kind “fill”), and no step pressed', async () => {
  await forgetAnswers();
  const from = ai.calls.length;
  const page = await open('workday-validate.html?start=3&t=h1');
  const summary = await fillThisPage(page);
  assert.equal(summary.error, undefined);
  assert.ok(summary.detected >= 2, JSON.stringify(summary));
  assert.ok(summary.pending >= 1, 'the essay goes to the AI');
  assert.equal(summary.checking, true);
  const run = await runEnds(page, 'fill');
  const s = await state(page);
  assert.equal(run.state, 'done', told(run));
  assert.match(run.message, /Everything the page asks for is in/);
  assert.ok((await value(page, '#why')).length >= 150, 'the AI’s answer to the essay');
  assert.equal(await value(page, '#auth'), 'Yes');
  assert.ok(askedSince(from).some((q) => /Why do you want to join/.test(q.question)));
  rulesOnly(askedSince(from));
  assert.deepEqual(s.presses, {}, 'one page only: Save and Continue is the person’s');
  await nothingSent(page);
  await page.close();
});

test('Fill this page: a page with nothing to fill starts no check', async () => {
  const page = await open('letters/posting.html');
  const summary = await fillThisPage(page);
  assert.ok(!summary.checking);
  await sleep(500);
  assert.equal(await runOf(page), null);
  await page.close();
});

test('Fill this page: what the page turned down at Save and Continue is put right by the rules', async () => {
  const page = await open('workday-validate.html?t=h2');
  await h.fill(page);
  // A Last Name cleared (not by a person's own typing: as a site's script would), then Save and Continue pressed.
  await typeInto(page, '#last', '');
  await page.$eval('#filter', (el) => el.click());
  let s = await state(page);
  assert.equal(s.refused[1], 1);
  const summary = await fillThisPage(page);
  assert.equal(summary.checking, true, JSON.stringify(summary));
  const run = await runEnds(page, 'fill');
  assert.equal(run.state, 'done', told(run));
  assert.match(run.message, /^Put right \d+ fields? the page still wanted/);
  assert.equal(await value(page, '#last'), 'Lovelace');
  assert.equal(await value(page, '#phone'), '4155550100');
  assert.equal(await value(page, '#start'), '11/2026');
  s = await state(page);
  assert.equal(s.step, 1, 'not pressed');
  // The person presses Save and Continue: now it goes through.
  await page.$eval('#filter', (el) => el.click());
  await until(
    (fn, arg) => page.$eval('#state', fn, arg),
    (el) => JSON.parse(el.textContent).step === 2,
    null,
    10000,
  );
  await nothingSent(page);
  await page.close();
});

test('Fill this page: a value you typed that the page turned down is listed, never rewritten', playwright, async () => {
  const page = await open('workday-validate.html?t=h5');
  await h.fill(page);
  await page.fill('#phone', '415-555-0199');
  await typeInto(page, '#last', '');
  await page.$eval('#filter', (el) => el.click());
  assert.equal((await state(page)).refused[1], 1);
  const summary = await fillThisPage(page);
  assert.equal(summary.checking, true, JSON.stringify(summary));
  const run = await runEnds(page, 'fill');
  assert.equal(await value(page, '#phone'), '415-555-0199', 'what you typed is still there');
  assert.equal(await value(page, '#start'), '11/2026', 'what JobToFill wrote is put right');
  assert.equal(run.state, 'stopped', told(run));
  const phone = run.left.find((x) => /Phone Number/.test(x.question));
  assert.ok(phone, told(run));
  assert.match(phone.why, /you typed this yourself/);
  assert.equal((await state(page)).step, 1);
  await nothingSent(page);
  await page.close();
});

test('Fill this page: pressed again on a step the page turned down, it puts right what it said', async () => {
  const page = await open('workday-validate.html?t=h3');
  await h.fill(page);
  await page.$eval('#filter', (el) => el.click());
  assert.equal((await state(page)).refused[1], 1);
  const summary = await fillThisPage(page);
  try {
    assert.equal(summary.checking, true, 'a check starts');
    const run = await runEnds(page, 'fill', 30000);
    assert.equal(run.state, 'done', told(run));
    assert.equal(await value(page, '#phone'), '4155550100');
    assert.equal(await value(page, '#start'), '11/2026');
  } finally {
    await page.close();
  }
});

test('Fill this page: a box the page still turns down after the fixes is listed, never called done', async () => {
  const page = await open('stubborn.html?t=h4');
  try {
    const summary = await fillThisPage(page);
    assert.equal(summary.checking, true);
    const run = await runEnds(page, 'fill');
    assert.equal(run.kind, 'fill');
    // Nothing in a US profile satisfies "Please enter a UK mobile number starting with +44".
    assert.equal(
      await page.$eval('#phone2-error', (el) => el.textContent),
      'Please enter a UK mobile number starting with +44',
    );
    assert.equal(run.state, 'stopped', told(run));
    assert.ok(
      run.left.some((x) => /Mobile \(UK numbers only\)/.test(x.question)),
      told(run),
    );
    assert.doesNotMatch(run.message, /Everything the page asks for is in/);
  } finally {
    await page.close();
  }
});

// JobToFill types key by key where a box keeps nothing else (execCommand), and the browser marks those input events,
// and the change on blur, as trusted, as it does a person's: main.js `touched` then takes its own answer for yours.
// Once a bug: JobToFill’s own typing fires trusted events, so `touched` takes its answer for the person’s.

test('the check: what JobToFill typed key by key is still its own, not “you typed this yourself”', async () => {
  const page = await open('stubborn.html?t=typed');
  try {
    await h.fill(page);
    assert.equal(await value(page, '#first'), 'Ada');
    // The page turns the first name down afterwards, as a server would.
    await page.$eval('#first', (el) => {
      el.setAttribute('aria-invalid', 'true');
      el.insertAdjacentHTML('afterend', '<span class="error">Error: First name must not contain spaces.</span>');
    });
    const check = await h.bg((id) => globalThis.JTFBackground.checkAndFix(id, {}), await h.tabId(page));
    const first = check.items.find((it) => /First name/.test(it.question));
    assert.ok(first, JSON.stringify(check.items));
    assert.equal(first.mine, true, 'JobToFill put “Ada” there');
    assert.notEqual(first.why, 'typed');
  } finally {
    await page.close();
  }
});

/* --------------------------------------------------- Fill + letter & CV */

test('Fill + letter & CV: the letter and tailored CV go in, then the page is checked (a run of kind “quick”)', async () => {
  const page = await open('letters/apply.html?job=R-1234&t=i');
  const started = await h.handler('jtf:quick-start', page);
  assert.equal(started.error, undefined);
  await quickIdle();
  const status = await h.bg(() => globalThis.JTF.store.getQuickStatus());
  assert.equal(status.state, 'done', status.message);
  const run = await runEnds(page, 'quick');
  assert.equal(run.state, 'done', told(run));
  assert.match(run.message, /Everything the page asks for is in/);
  assert.match(await fileName(page, '#resume'), /^ada_lovelace_cv_acme_capital\.pdf$/);
  assert.match(await fileName(page, '#cover'), /^ada_lovelace_cover_letter_acme_capital\.pdf$/);
  assert.equal(await value(page, '#first'), 'Ada');
  await nothingSent(page);
  await page.close();
});

test('Fill + letter & CV on a step with nothing left for its second fill still checks the page', async () => {
  const page = await open('workday-validate.html?t=i2');
  try {
    await h.handler('jtf:quick-start', page);
    await quickIdle();
    const run = await runEnds(page, 'quick', 20000);
    assert.equal(run.kind, 'quick');
  } finally {
    await page.close();
  }
});

/* ------------------------------------------------------------------ popup */

test(
  'popup: the three buttons, and the run card while Apply for me runs and once it has ended',
  playwright,
  async () => {
    const form = await open('greenhouse.html?t=l');
    const tabId = await h.tabId(form);
    const popup = await h.context.newPage();
    await popup.goto(h.extUrl(`popup/popup.html?tab=${tabId}`));
    await popup.waitForSelector('#profile option', { state: 'attached' });
    assert.match(await popup.textContent('#fill'), /Fill this page/);
    assert.equal((await popup.textContent('#quick-apply')).trim(), 'Fill + letter & CV');
    assert.equal((await popup.textContent('#autopilot')).trim(), 'Apply for me');
    assert.equal(await popup.isVisible('#run'), false, 'no run yet');

    await popup.click('#autopilot');
    await popup.waitForSelector('#run:not([hidden])');
    await popup.waitForSelector('#run .pill', { timeout: 120000 });
    assert.equal((await popup.textContent('#run .pill')).trim(), 'Ready to submit');
    assert.match(await popup.textContent('#run .run-head'), /^Apply for me/);
    assert.match(
      await popup.textContent('#run .run-msg'),
      /Ready to submit: every field the page asks for is filled in/,
    );
    assert.equal(await popup.isVisible('#run button'), false, 'no Stop once it has ended');
    assert.equal(await popup.isDisabled('#autopilot'), false);
    await quickIdle();

    // Opened again later, it shows the run that ended.
    await popup.reload();
    await popup.waitForSelector('#run .pill');
    assert.equal((await popup.textContent('#run .pill')).trim(), 'Ready to submit');
    await nothingSent(form);
    await Promise.all([popup.close(), form.close()]);
  },
);

test('popup: a run that stopped lists what is left for you, and why', playwright, async () => {
  await h.bg(() => globalThis.JTF.store.setAiKey(''));
  const form = await open('workday-validate.html?t=l2');
  try {
    const run = await applyForMe(form);
    assert.equal(run.state, 'stopped');
    const popup = await h.context.newPage();
    await popup.goto(h.extUrl(`popup/popup.html?tab=${await h.tabId(form)}`));
    await popup.waitForSelector('#run .pill');
    assert.equal((await popup.textContent('#run .pill')).trim(), 'Needs you');
    assert.match(await popup.textContent('#run .run-head'), /^Apply for me · step 3 of 5/);
    assert.match(await popup.textContent('#run .run-msg'), /No AI is set up/);
    await popup.close();
  } finally {
    await h.bg(() => globalThis.JTF.store.setAiKey('test-key'));
    await quickIdle();
    await form.close();
  }
});
