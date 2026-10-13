// AI answers end to end, with a scripted stand-in for the AI provider: the questions a fill leaves empty go to
// the model with the job's description (read from the page), the answers are checked (an invented number goes
// back to be fixed), filled in and remembered, so filling the page again doesn't ask the model twice.
// Diversity questions, declarations and legal questions without answer guidance never reach the model, unless the
// person lets the AI answer that kind (Settings › Cover letters & AI); passwords and opt-ins never do.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PROFILE, checked, launch, selectedText, until, value } from './harness.mjs';

const ESSAY = (n) =>
  `I want to join Acme Capital’s Rates desk because the work is building pricing and risk tools in Python that traders use every day. I built a reconciliation tool in Python that checks ${n} trades a night, and explaining breaks to traders is how I learnt that a tool is only useful when people trust it.`;

/**
 * What a model makes of the sensitive questions (tests/fixtures/ai-sensitive.html): answered only where the system
 * prompt has the rules for their kind (Settings › Cover letters & AI), skipped as the default rules say otherwise.
 */
function sensitive(q, system) {
  const may = (re) => re.test(system);
  if (/sexual orientation/i.test(q.question) && may(/EQUAL-OPPORTUNITY ANSWERS/))
    return { id: q.id, answer: 'I don’t wish to answer' };
  if (/government official|convicted/i.test(q.question) && may(/nothing to declare/)) return { id: q.id, answer: 'No' };
  if (/adjustments/i.test(q.question) && may(/no adjustments or accommodations needed/))
    return { id: q.id, answer: 'No' };
  if (/^signature$/i.test(q.question)) return { id: q.id, answer: 'Ada Lovelace' };
  if (/national insurance/i.test(q.question)) return { id: q.id, answer: 'QQ 12 34 56 C' };
  if (/passport/i.test(q.question)) return { id: q.id, answer: '123456789' };
  if (/keep me updated/i.test(q.question)) return { id: q.id, answer: 'Yes' };
  return null;
}

/**
 * An OpenAI-compatible endpoint that answers application questions by their wording, and records every call. `delay`
 * (ms, changeable) holds each reply back, as a slow model would.
 */
function mockAi() {
  const calls = [];
  const state = { delay: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => setTimeout(() => respond(body), state.delay));
    function respond(body) {
      if (res.destroyed) return;
      const json = JSON.parse(body || '{}');
      const system = (json.messages && json.messages[0] && json.messages[0].content) || '';
      const last = json.messages.at(-1).content;
      calls.push({ json, system, last });
      let reply = { ok: true };
      if (/strict fact-checker for job application answers/.test(system)) reply = { unsupported: [] };
      else if (/answer job application form questions/.test(system)) {
        if (/^Some answers need fixing/.test(last)) {
          const id = last.match(/^- ([^:]+):/m)[1];
          reply = { answers: [{ id, answer: ESSAY('40,000'), basis: 'material' }] };
        } else {
          const questions = JSON.parse(last.slice(last.indexOf('QUESTIONS:') + 'QUESTIONS:'.length));
          reply = {
            answers: questions.map((q) => {
              const kept = sensitive(q, system);
              if (kept) return kept;
              if (/^why/i.test(q.question)) return { id: q.id, answer: ESSAY('90,000'), basis: 'material' };
              if (/python/i.test(q.question)) return { id: q.id, answer: 'Yes', basis: 'material' };
              if (/product/i.test(q.question)) return { id: q.id, answer: 'Rates and inflation', basis: 'posting' };
              if (/hear about/i.test(q.question)) return { id: q.id, answer: 'Online job board', basis: 'material' };
              if (/sat/i.test(q.question)) return { id: q.id, answer: 'Did not take', basis: 'inferred' };
              if (/internship at a financial firm/i.test(q.question)) return { id: q.id, answer: 'Yes' };
              if (/^if yes, which firm/i.test(q.question))
                return { id: q.id, answer: 'Analytical Engines Inc, where I built a reconciliation tool in Python.' };
              return { id: q.id, skip: true, reason: 'not in the material' };
            }),
          };
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'mock',
          choices: [{ message: { content: JSON.stringify(reply) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.0001 },
        }),
      );
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, state })));
}

let h;
let ai;

before(async () => {
  h = await launch();
  ai = await mockAi();
  const profileId = await h.setProfile({ ...PROFILE, job: { ...PROFILE.job, referralSource: 'Trackr' } });
  await h.bg(
    async ([id, base]) => {
      const { store } = globalThis.JTF;
      await store.saveSettings({ ai: { provider: 'custom', baseUrl: base, model: 'mock' } });
      await store.setAiKey('test-key');
      await store.saveKit(id, {
        notes: 'Built a reconciliation tool in Python that checks 40,000 trades a night. Explained breaks to traders.',
      });
    },
    [profileId, `http://127.0.0.1:${ai.server.address().port}/v1`],
  );
});

after(async () => {
  await h.close();
  ai.server.close();
});

const fillAndWait = async (page) =>
  h.bg((id) => globalThis.JTFBackground.fillTab(id, { waitAi: true }), await h.tabId(page));
const answerCalls = () => ai.calls.filter((c) => /answer job application form questions/.test(c.system));

test('the questions a fill leaves empty are answered by the AI, checked, filled in and remembered', async () => {
  const page = await h.open('ai-questions.html');
  const r = await fillAndWait(page);
  assert.equal(r.error, undefined);
  assert.equal(await value(page, '#first_name'), 'Ada');
  assert.equal(r.ai.status, 'done', JSON.stringify(r.ai));

  assert.equal(await value(page, '#why'), ESSAY('40,000'), 'the invented 90,000 was sent back and fixed');
  assert.equal(await selectedText(page, '#python'), 'Yes');
  assert.equal(await checked(page, 'input[value="rates"]'), true);
  // "Trackr" isn't an option: the rules take its kind of option, so the model isn't asked.
  assert.equal(await selectedText(page, '#hear'), 'Online job board');
  assert.equal(await selectedText(page, '#sat'), 'Did not take');
  assert.equal(r.ai.filled, 4, JSON.stringify(r.ai.items));

  // Never sent: a diversity question, a declaration, and a legal question there's no answer guidance for.
  const sent = answerCalls()
    .map((c) => c.last)
    .join('\n');
  assert.doesNotMatch(sent, /socio-economic|privacy notice|convicted/i);
  const asked = answerCalls()
    .filter((c) => c.last.includes('QUESTIONS:'))
    .flatMap((c) => JSON.parse(c.last.slice(c.last.indexOf('QUESTIONS:') + 10)).map((q) => q.question));
  assert.ok(!asked.some((q) => /how did you hear/i.test(q)), asked.join(' | '));
  // "…a lower socio-economic background?" is No by rule when the profile doesn't say otherwise.
  assert.equal(await selectedText(page, '#ses'), 'No');
  assert.equal(await selectedText(page, '#convicted'), 'Select...');
  assert.equal(await checked(page, '#privacy'), false);
  const left = r.ai.skipped.map((s) => s.question).join(' | ');
  assert.match(left, /convicted/, 'the legal question is listed as left for you');
  // The job's description (JSON-LD on the page) went with the questions, and so did where the job was found.
  assert.match(sent, /Rates desk makes markets in government bonds/);
  assert.match(sent, /Where they found this job: Trackr/);
  const fixes = answerCalls().filter((c) => /^Some answers need fixing/.test(c.last));
  assert.equal(fixes.length, 1);
  assert.match(fixes[0].last, /90000/);

  // Remembered for this application, and offered to the model next time as the candidate's own words.
  const saved = await h.bg(() => globalThis.JTF.store.getAnswers());
  assert.equal(saved.length, 1);
  assert.equal(saved[0].company, 'Acme Capital');
  assert.equal(saved[0].items.length, 4);

  // "Learn from this page" doesn't offer the AI's answers as custom answers (they name this employer).
  const learnt = await h.handler('jtf:learn', page);
  assert.ok(!learnt.suggestions.some((x) => /why do you want/i.test(x.question || '')), JSON.stringify(learnt));

  // Undo takes the AI's answers back along with the rest of the fill.
  const undone = await h.handler('jtf:undo', page);
  assert.ok(undone.undone >= 8, JSON.stringify(undone));
  assert.equal(await selectedText(page, '#hear'), 'Select...');
  assert.equal(await value(page, '#why'), '');
  assert.equal(await selectedText(page, '#python'), 'Select...');
  await page.close();
});

test('filling the same application again reuses the answers without asking the model', async () => {
  const before = answerCalls().length;
  const page = await h.open('ai-questions.html');
  const r = await fillAndWait(page);
  assert.equal(r.ai.status, 'done');
  assert.equal(answerCalls().length, before, 'no new calls');
  assert.equal(await value(page, '#why'), ESSAY('40,000'));
  assert.equal(await selectedText(page, '#hear'), 'Online job board');
  assert.ok(r.ai.items.every((i) => i.reused));
  await page.close();
});

test('with AI answers switched off, the fill says how many questions are left and asks nothing', async () => {
  await h.setSettings({ aiAnswers: false });
  await h.bg(() => globalThis.JTF.api.storage.local.set({ answers: [] }));
  const before = ai.calls.length;
  const page = await h.open('ai-questions.html');
  const r = await fillAndWait(page);
  assert.equal(r.ai.status, 'off');
  assert.ok(r.ai.asked >= 5, JSON.stringify(r.ai));
  assert.equal(ai.calls.length, before);
  assert.equal(await value(page, '#why'), '');

  // "Answer them with AI" in the popup still works for this page.
  const run = await h.bg((id) => globalThis.JTFBackground.answerPage(id, { wait: true }), await h.tabId(page));
  assert.equal(run.status, 'done', JSON.stringify(run));
  assert.equal(await selectedText(page, '#python'), 'Yes');
  await h.setSettings({ aiAnswers: true });
  await page.close();
});

test('the popup shows the AI step as it runs, then what it answered and what it left', async () => {
  await h.bg(() => globalThis.JTF.api.storage.local.set({ answers: [] }));
  const page = await h.open('ai-questions.html');
  const tabId = await h.tabId(page);
  const popup = await h.extPage(`popup/popup.html?tab=${tabId}`);
  // The page is reachable before its script has run: wait for the popup to start.
  await until(popup.call, () => document.querySelector('#version').textContent);
  await popup.call(() => document.querySelector('#fill').click());
  const text = await until(
    popup.call,
    () => {
      const box = document.querySelector('#ai');
      return box && !box.hidden && /AI answered/.test(box.textContent) ? box.textContent : null;
    },
    null,
    20000,
  );
  assert.match(text, /AI answered 4 questions/);
  assert.match(text, /Do you have practical Python experience\?/);
  assert.match(text, /Rates and inflation/);
  // The socio-economic question is a profile answer now (from the household earner's job), left blank here.
  assert.match(text, /1 question left for you/);
  assert.match(text, /convicted/);
  assert.equal(await selectedText(page, '#python'), 'Yes');
  await popup.close();
  await page.close();
});

test('a page that isn’t a job application (a checkout) never goes to the AI', async () => {
  const before = ai.calls.length;
  const page = await h.open('checkout.html');
  const r = await fillAndWait(page);
  assert.ok(r.filled > 0);
  assert.equal(r.pending, 0);
  assert.equal(r.ai, undefined);
  assert.equal(ai.calls.length, before);
  await page.close();
});

test('a question an AI answer brings up ("If yes, which firm…") is answered in a second round', async () => {
  const page = await h.open('ai-reveal.html');
  const r = await fillAndWait(page);
  assert.equal(r.ai.status, 'done', JSON.stringify(r.ai));
  assert.equal(await selectedText(page, '#internship'), 'Yes');
  assert.equal(await value(page, '#details'), 'Analytical Engines Inc, where I built a reconciliation tool in Python.');
  assert.equal(r.ai.filled, 2, JSON.stringify(r.ai.items));
  await page.close();
});

test('the job behind an application is found for the AI on a linked HTML page (offscreen document in Chromium)', async () => {
  const page = await h.open('letters/apply.html?job=R-1234');
  const job = await h.bg((id) => globalThis.JTFBackground.jobFor(id), await h.tabId(page));
  assert.equal(job.company, 'Acme Capital');
  assert.match(job.title, /Operations Analyst/);
  assert.match(job.description, /Reconcile trades and positions every day/);
  // Remembered for the next step of the same application.
  const cached = await h.bg((id) => globalThis.JTF.store.getTabJob(id), await h.tabId(page));
  assert.match(cached.job.description, /Reconcile trades/);
  await page.close();
});

const NONE = { eeo: false, consent: false, legal: false, health: false, identity: false };
const ALL = { eeo: true, consent: true, legal: true, health: true, identity: true };
/** The questions the model was asked in these calls. */
const askedIn = (calls) =>
  calls
    .filter((c) => c.last.includes('QUESTIONS:'))
    .flatMap((c) => JSON.parse(c.last.slice(c.last.indexOf('QUESTIONS:') + 10)).map((q) => q.question));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('sensitive questions stay back until switched on; then each kind is answered by its own rules', async () => {
  const profileId = await h.bg(async () => (await globalThis.JTF.store.getActive()).profile.id);
  const notes = 'Built a reconciliation tool in Python that checks 40,000 trades a night. Explained breaks to traders.';
  const setNotes = (text) => h.bg(([id, n]) => globalThis.JTF.store.saveKit(id, { notes: n }), [profileId, text]);
  await setNotes(`${notes}\nNational Insurance number: QQ123456C.`);
  try {
    // The default: what was always asked still is, nothing sensitive goes, and the date of birth filled just before
    // "Why…?" isn't passed on as the question before it.
    await h.bg(() => globalThis.JTF.api.storage.local.set({ answers: [] }));
    let from = ai.calls.length;
    let page = await h.open('ai-sensitive.html');
    let r = await fillAndWait(page);
    assert.equal(r.ai.status, 'done', JSON.stringify(r.ai));
    assert.notEqual(await value(page, '#dob'), '', 'the rules fill the date of birth');
    let asked = askedIn(ai.calls.slice(from));
    assert.ok(asked.some((q) => /^Why/.test(q)));
    assert.ok(
      asked.some((q) => /government official/.test(q)),
      'asked as before, and skipped without the legal rules',
    );
    for (const re of [
      /convicted/,
      /adjustments/,
      /National Insurance/,
      /Passport/,
      /sexual orientation/,
      /^Signature$/,
    ])
      assert.ok(!asked.some((q) => re.test(q)), String(re));
    assert.ok(!asked.some((q) => /Keep me updated/.test(q)));
    const sent = ai.calls
      .slice(from)
      .map((c) => c.last)
      .join('\n');
    assert.doesNotMatch(sent, /1990/, 'never the date of birth');
    assert.match(sent, /"question": "Date of birth",\s*"answer": "\(not answered\)"/);
    for (const sel of ['#official', '#convicted', '#adjustments', '#orientation'])
      assert.equal(await selectedText(page, sel), 'Select...', sel);
    for (const sel of ['#ni', '#passport', '#signature']) assert.equal(await value(page, sel), '', sel);
    assert.equal(await checked(page, '#updates'), false);
    assert.match(r.ai.skipped.map((s) => s.reason).join(' | '), /in Settings › Cover letters & AI/);
    await page.close();

    // Every kind switched on.
    await h.setSettings({ aiSensitive: ALL });
    await h.bg(() => globalThis.JTF.api.storage.local.set({ answers: [] }));
    from = ai.calls.length;
    page = await h.open('ai-sensitive.html');
    r = await fillAndWait(page);
    assert.equal(r.ai.status, 'done', JSON.stringify(r.ai));
    assert.equal(await selectedText(page, '#orientation'), 'I don’t wish to answer'.replace('’', "'"));
    assert.equal(await selectedText(page, '#official'), 'No', 'a government official question the profile left open');
    assert.equal(await selectedText(page, '#convicted'), 'No');
    assert.equal(await selectedText(page, '#adjustments'), 'No');
    assert.equal(await value(page, '#signature'), 'Ada Lovelace');
    assert.equal(await value(page, '#ni'), 'QQ 12 34 56 C', 'the number the candidate’s notes give');
    assert.equal(await value(page, '#passport'), '', 'a passport number nothing gives is never made up');
    assert.equal(await checked(page, '#updates'), false);
    asked = askedIn(ai.calls.slice(from));
    assert.ok(!asked.some((q) => /Keep me updated/.test(q)), 'an opt-in is never even asked');
    const calls = ai.calls.slice(from).filter((c) => /answer job application form questions/.test(c.system));
    assert.match(calls[0].system, /Questions the candidate has asked you to answer too:/);
    assert.match(calls[0].last, /EQUAL-OPPORTUNITY ANSWERS[^\n]*\nGender: Female/);
    await page.close();
  } finally {
    await h.setSettings({ aiSensitive: NONE });
    await setNotes(notes);
  }
});

test('an AI answer goes into the question it was written for, whatever the page did while it was written', async () => {
  let page = await h.open('ai-questions-grow.html');
  let tabId = await h.tabId(page);
  // What a fill hands the AI (the questions it left, each with an id), and the AI's answers coming back.
  const pending = () =>
    h.bg(async (id) => {
      const { profile, settings } = await globalThis.JTF.store.getActive();
      return (await globalThis.JTFBackground.callFrames(id, 'pending', [{ profile, settings, ai: false }], [0]))[0]
        .items;
    }, tabId);
  const apply = (list) =>
    h.bg(
      ([id, answers]) =>
        globalThis.JTFBackground.callFrames(id, 'applyAnswers', [answers, { settings: {} }], [0]).then((f) => f[0]),
      [tabId, list],
    );
  const answer = (item, text) => ({ id: item.id, question: item.question, value: text, kind: 'text' });
  const boxes = () => page.$$eval('textarea', (list) => Object.fromEntries(list.map((t) => [t.id, t.value])));

  // A question appears above them (a CV parse, a follow-up an answer revealed) and the page is read again before
  // the answers are back (Quick apply's second fill, Fill pressed while the AI writes).
  const project = (await pending()).find((i) => /project you are proud of/.test(i.question));
  await page.$eval('#slot', (slot) => {
    slot.innerHTML =
      '<div class="field"><label for="q0">Why do you want an internship?</label><textarea id="q0"></textarea></div>';
  });
  const again = await pending();
  assert.ok(!again.some((i) => i.id === project.id), 'an id is never handed out again');
  const r = await apply([answer(project, 'The difference engine.')]);
  assert.equal(r.filled, 1, JSON.stringify(r));
  assert.deepEqual(await boxes(), { q0: '', qa: '', qb: 'The difference engine.', qc: '' });

  // The same boxes re-rendered one question further down (a list keyed by position): the box the id was given to
  // now asks something else, so the answer goes to the box that asks its question now.
  await page.close();
  page = await h.open('ai-questions-grow.html?shifted');
  tabId = await h.tabId(page);
  const team = (await pending()).find((i) => /which team/i.test(i.question));
  await page.$eval('#questions', (list) => {
    const labels = Array.from(list.querySelectorAll('label'));
    const texts = labels.map((l) => l.textContent);
    labels.forEach((l, i) => (l.textContent = i ? texts[i - 1] : 'Why do you want an internship?'));
    const last = document.createElement('div');
    last.className = 'field';
    last.innerHTML = '<label for="qd"></label><textarea id="qd"></textarea>';
    last.querySelector('label').textContent = texts[texts.length - 1];
    list.append(last);
  });
  const moved = await apply([answer(team, 'The engine team.')]);
  assert.equal(moved.filled, 1, JSON.stringify(moved));
  assert.deepEqual(await boxes(), { qa: '', qb: '', qc: '', qd: 'The engine team.' });
  // And nowhere when no box asks its question any more.
  const gone = await apply([{ ...answer(team, 'Again.'), question: 'Which office would you like to work in?' }]);
  assert.deepEqual(gone.results, [{ id: team.id, status: 'gone' }]);
  await page.close();
});

test('pressed again while the AI is still writing: the new run keeps the page awake and alone speaks for the tab', async () => {
  await h.bg(() => {
    globalThis.JTF.api.storage.local.set({ answers: [] });
    // The keep-alive ports the page opens while the AI works.
    globalThis.__holds = { open: 0 };
    globalThis.JTF.api.runtime.onConnect.addListener((port) => {
      if (port.name !== 'jtf-hold') return;
      globalThis.__holds.open++;
      port.onDisconnect.addListener(() => globalThis.__holds.open--);
    });
  });
  const watcher = await h.extPage('options/options.html');
  await watcher.call(() => {
    window.__seen = [];
    (globalThis.browser || globalThis.chrome).runtime.onMessage.addListener((m) => {
      if (m && m.type === 'jtf:ai-progress') window.__seen.push(m.run.status);
    });
  });
  ai.state.delay = 3000;
  try {
    const page = await h.open('ai-questions.html');
    const tabId = await h.tabId(page);
    await h.bg((id) => globalThis.JTFBackground.answerPage(id, {}), tabId);
    await until(h.bg, () => globalThis.__holds.open === 1, null, 10000);
    const second = await h.bg((id) => globalThis.JTFBackground.answerPage(id, {}), tabId);
    assert.equal(second.status, 'running');
    // The first run has stopped by now: its end neither closes the keep-alive nor tells the popup "Stopped.".
    await sleep(1500);
    assert.equal(await h.bg(() => globalThis.__holds.open), 1, 'the page still keeps the background awake');
    const status = (id) => globalThis.JTFBackground.handlers['jtf:ai-status']({ tabId: id }).run.status;
    assert.equal(await h.bg(status, tabId), 'running');
    assert.ok(!(await watcher.call(() => window.__seen)).includes('error'), 'no “Stopped.” for the run going on');
    // The second run finishes, and lets go.
    await until(
      h.bg,
      (id) => globalThis.JTFBackground.handlers['jtf:ai-status']({ tabId: id }).run.status === 'done',
      tabId,
      30000,
    );
    await until(h.bg, () => globalThis.__holds.open === 0, null, 5000);
    assert.ok(!(await watcher.call(() => window.__seen)).includes('error'));
    await page.close();
  } finally {
    ai.state.delay = 0;
    await watcher.close();
  }
});

test('a tab closed while the AI is writing stops the run: no more calls on the person’s key', async () => {
  ai.state.delay = 3000;
  try {
    const before = ai.calls.length;
    const page = await h.open('ai-questions.html');
    const tabId = await h.tabId(page);
    await h.bg((id) => globalThis.JTFBackground.answerPage(id, {}), tabId);
    const status = (id) => (globalThis.JTFBackground.handlers['jtf:ai-status']({ tabId: id }).run || {}).status;
    await until(h.bg, status, tabId, 10000);
    // The question round is with the model now; closing the tab aborts it, so it never comes back to be checked.
    await sleep(500);
    await page.close();
    await sleep(4500);
    assert.equal(ai.calls.length, before, 'the request in flight was dropped, and nothing was asked after it');
  } finally {
    ai.state.delay = 0;
  }
});
