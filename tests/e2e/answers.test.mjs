// AI answers end to end, with a scripted stand-in for the AI provider: the questions a fill leaves empty go to
// the model with the job's description (read from the page), the answers are checked (an invented number goes
// back to be fixed), filled in and remembered, so filling the page again doesn't ask the model twice.
// Diversity questions, declarations and legal questions without answer guidance never reach the model.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PROFILE, checked, launch, selectedText, until, value } from './harness.mjs';

const ESSAY = (n) =>
  `I want to join Acme Capital’s Rates desk because the work is building pricing and risk tools in Python that traders use every day. I built a reconciliation tool in Python that checks ${n} trades a night, and explaining breaks to traders is how I learnt that a tool is only useful when people trust it.`;

/** An OpenAI-compatible endpoint that answers application questions by their wording, and records every call. */
function mockAi() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
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
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls })));
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
  assert.equal(await selectedText(page, '#ses'), 'Select...');
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
  assert.match(text, /2 questions left for you/);
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
