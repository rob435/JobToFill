// Quick apply end to end, with a scripted stand-in for the AI provider: one request from the popup's
// button writes the letter, tailors the CV, fills the whole form in the application tab, keeps one
// temporary result for the "Last quick apply" page, and closes its working tab.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { PROFILE, launch, until } from './harness.mjs';

const CV_LINES = [
  'Ada Lovelace',
  'Education: University of Cambridge, BSc Mathematics, 2012 – 2016',
  'Experience: Analytical Engines Inc, Senior Engineer, 2020 – present',
  '• Built a reconciliation tool in Python that checks 40,000 trades a night',
  '• Cut manual checks for the operations team from 3 hours to 20 minutes',
  'Babbage Labs, Engineer, 2016 – 2020',
  '• Wrote data quality tests for the settlement pipeline in SQL',
  '• Explained breaks to traders and engineers every morning',
  'Skills: Python, SQL, Mathematics',
];

const LETTER = (number) => ({
  salutation: 'Dear Acme Capital Recruitment Team,',
  paragraphs: [
    'I am applying for the Operations Analyst role in London. I am a Senior Engineer at Analytical Engines Inc.',
    `At Analytical Engines I built a reconciliation tool in Python that checks ${number} trades a night, and I cut the operations team’s manual checks from 3 hours to 20 minutes. Getting the details right before they cause losses is the work I enjoy.`,
    'At Babbage Labs I wrote data quality tests for the settlement pipeline in SQL and explained breaks to traders and engineers every morning, so clear communication about what went wrong is part of how I work.',
    'I would welcome the chance to join Acme Capital in London. Thank you for considering my application.',
  ],
  closing: 'Yours sincerely,',
});

const CV = {
  name: 'Ada Lovelace',
  contact: [],
  sections: [
    {
      title: 'Experience',
      entries: [
        {
          heading: 'Analytical Engines Inc',
          right: '2020 – present',
          subheading: 'Senior Engineer',
          bullets: ['Built a trade reconciliation tool in Python that checks 40,000 trades a night'],
        },
      ],
    },
    { title: 'Skills', lines: [{ label: 'Skills', text: 'Python, SQL, Mathematics' }] },
  ],
  changes: ['Experience: “reconciliation tool” → “trade reconciliation tool” to match “reconcile trades”'],
};

/** An OpenAI-compatible endpoint that answers by prompt type and records every request. */
function mockAi() {
  const calls = [];
  // Set `fail.status` to answer every request with that HTTP error instead.
  const fail = { status: 0 };
  // Set `gate.letter` to a promise to hold the cover letter's reply until it settles.
  const gate = { letter: null };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const json = JSON.parse(body || '{}');
      const system = (json.messages && json.messages[0] && json.messages[0].content) || '';
      calls.push({ path: req.url, auth: req.headers.authorization, json });
      if (fail.status) {
        res.writeHead(fail.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'No auth credentials found', code: fail.status } }));
        return;
      }
      let reply;
      if (/extract facts from a job posting/.test(system))
        reply = {
          company: 'Acme Capital',
          role: 'Operations Analyst',
          location: 'London',
          keywords: ['reconcile trades', 'breaks', 'Python', 'data quality', 'VBA'],
          requirements: ['Python or SQL'],
        };
      else if (/write job application cover letters/.test(system)) {
        if (gate.letter) await gate.letter;
        reply = LETTER('40,000');
      } else if (/strict fact-checker/.test(system)) reply = { unsupported: [] };
      else if (/compare an application page/.test(system))
        reply = { same: true, confidence: 0.9, reason: 'same title' };
      else if (/tailor a candidate’s CV/.test(system)) reply = CV;
      else reply = { ok: true };
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
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, fail, gate })));
}

async function cvPdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  CV_LINES.forEach((line, i) => page.drawText(line.replace('•', '-'), { x: 50, y: 790 - i * 18, size: 11, font }));
  return 'data:application/pdf;base64,' + Buffer.from(await doc.save()).toString('base64');
}

let h;
let ai;

before(async () => {
  h = await launch();
  ai = await mockAi();
  const profileId = await h.setProfile(PROFILE);
  const dataUrl = await cvPdf();
  await h.bg(
    async ([id, url, base]) => {
      const { store } = globalThis.JTF;
      await store.setDoc(id, 'resume', { name: 'ada_cv.pdf', type: 'application/pdf', size: url.length, dataUrl: url });
      await store.saveSettings({ ai: { provider: 'custom', baseUrl: base, model: 'mock' } });
      await store.setAiKey('test-key');
      await store.saveKit(id, { minWords: 80 });
    },
    [profileId, dataUrl, `http://127.0.0.1:${ai.server.address().port}/v1`],
  );
});

after(async () => {
  await h.close();
  ai.server.close();
});

const status = () => h.bg(() => globalThis.JTF.store.getQuickStatus());

/** Start Quick apply for the page the way the popup does. */
async function quickStart(page) {
  const started = await h.handler('jtf:quick-start', page);
  assert.equal(started.error, undefined);
  assert.ok(started.studioTabId != null);
  return started;
}

/** Wait for the Quick apply that is running to finish. */
async function quickDone() {
  await until(
    h.bg,
    async () => {
      const s = await globalThis.JTF.store.getQuickStatus();
      return s && s.state !== 'running';
    },
    null,
    60000,
  );
  return status();
}

/** Start Quick apply for the page the way the popup does, and wait for it to finish. */
async function quickApply(page) {
  await quickStart(page);
  return quickDone();
}

const fileName = (page, sel) => page.$eval(sel, (el) => (el.files[0] ? el.files[0].name : ''));

async function closeStudios() {
  await h.bg(async () => {
    const tabs = await globalThis.JTF.api.tabs.query({});
    for (const t of tabs) if (/studio\/studio\.html/.test(t.url)) await globalThis.JTF.api.tabs.remove(t.id);
  });
}

test('quick apply: letter, tailored CV and the form are done in one go, and kept only until the next one', async () => {
  const apply = await h.open('letters/apply.html?job=R-1234');
  const done = await quickApply(apply);
  assert.equal(done.state, 'done', done.message);

  // The form got the letter (file and pasted text), the tailored CV and the plain profile fields.
  assert.match(await apply.$eval('#cover', (el) => el.files[0].name), /^ada_lovelace_cover_letter_acme_capital\.pdf$/);
  assert.match(await apply.$eval('#resume', (el) => el.files[0].name), /^ada_lovelace_cv_acme_capital\.pdf$/);
  assert.match(await apply.$eval('#cover-text', (el) => el.value), /^Dear Acme Capital Recruitment Team,/);
  assert.equal(await apply.$eval('#first', (el) => el.value), 'Ada');

  // The working tab closed itself.
  const studios = await h.bg(
    async () => (await globalThis.JTF.api.tabs.query({})).filter((t) => /studio\/studio\.html/.test(t.url)).length,
  );
  assert.equal(studios, 0);

  // One temporary record, in session memory, with the letter and CV.
  const record = await h.bg(() => globalThis.JTF.store.getQuickApply());
  assert.equal(record.company, 'Acme Capital');
  assert.equal(record.role, 'Operations Analyst');
  assert.match(record.letter.text, /checks 40,000 trades a night/);
  assert.match(record.letter.pdf, /^data:application\/pdf;base64,/);
  assert.match(record.cv.pdf, /^data:application\/pdf;base64,/);
  assert.match(record.cv.tex, /documentclass/);
  assert.ok(record.cv.changes.length);
  const local = await h.bg(() => globalThis.JTF.api.storage.local.get(null));
  assert.ok(!('quickApply' in local), 'not written to disk');
  const backup = await h.bg(async () => JSON.stringify(await globalThis.JTF.store.exportData()));
  assert.ok(!backup.includes('before they cause losses') && !backup.includes('quickApply'), 'not in the backup');

  // The viewer shows both, with downloads, and Clear forgets them.
  const view = await h.extPage('quick/quick.html');
  await until(view.call, () => !document.querySelector('#result').hidden);
  assert.match(await view.call(() => document.querySelector('#job').textContent), /Operations Analyst at Acme Capital/);
  assert.ok(await view.call(() => document.querySelector('#preview').src.startsWith('blob:')));
  assert.equal(await view.call(() => document.querySelector('#download-tex').hidden), true);
  await view.call(() => document.querySelector('#tab-cv').click());
  assert.equal(await view.call(() => document.querySelector('#download-tex').hidden), false);
  assert.equal(await view.call(() => document.querySelector('#tab-cv').getAttribute('aria-selected')), 'true');
  assert.ok(await view.call(() => document.querySelector('#changes-list').children.length > 0));

  // A second quick apply replaces the first: still one record and one kept letter.
  const apply2 = await h.open('letters/apply.html?job=R-1234&again=1');
  assert.equal((await quickApply(apply2)).state, 'done');
  const again = await h.bg(async () => ({
    record: await globalThis.JTF.store.getQuickApply(),
    kept: (await globalThis.JTF.store.getLetters()).filter((l) => l.quick).length,
  }));
  assert.ok(again.record.createdAt > record.createdAt);
  assert.equal(again.kept, 1);
  await until(view.call, () => !document.querySelector('#result').hidden);

  await view.call(() => document.querySelector('#clear').click());
  await until(view.call, () => !document.querySelector('#empty').hidden);
  assert.match(await view.call(() => document.querySelector('#empty').textContent), /Nothing stored/);
  const cleared = await h.bg(async () => ({
    record: await globalThis.JTF.store.getQuickApply(),
    kept: (await globalThis.JTF.store.getLetters()).filter((l) => l.quick).length,
  }));
  assert.deepEqual(cleared, { record: null, kept: 0 });
  await view.close();
  await apply.close();
  await apply2.close();
});

test('quick apply: a page with no job on it stops with a clear error and keeps nothing', async () => {
  const page = await h.open('signup.html');
  const done = await quickApply(page);
  assert.equal(done.state, 'error');
  assert.match(done.message, /couldn’t find this job’s description/);
  assert.equal(await h.bg(() => globalThis.JTF.store.getQuickApply()), null);
  await closeStudios(); // the tab it left open for the details
  await page.close();
});

test('quick apply: your details go in at once, a Fill meanwhile leaves the CV to it, the tailored CV and letter follow', async () => {
  assert.equal((await h.bg(() => globalThis.JTF.store.getSettings())).consents, false);
  let release;
  ai.gate.letter = new Promise((resolve) => (release = resolve));
  const page = await h.open('letters/apply-full.html?job=R-1234');
  try {
    await quickStart(page);
    // Before the letter is written: the details are in, the privacy notice acknowledged (whatever the setting
    // says), the job-alerts opt-in left alone, and the CV and letter fields kept free for what's coming.
    await until(page.evaluate.bind(page), () => document.querySelector('#first').value === 'Ada');
    assert.equal(await page.$eval('#email', (el) => el.value), 'ada@example.com');
    assert.ok(await page.$eval('#phone', (el) => el.value));
    assert.equal(await page.$eval('#privacy', (el) => el.checked), true);
    assert.equal(await page.$eval('#alerts', (el) => el.checked), false);
    assert.equal(await fileName(page, '#resume'), '');
    assert.equal(await fileName(page, '#cover'), '');
    assert.equal(await page.$eval('#cover-text', (el) => el.value), '');
    assert.equal((await status()).state, 'running');

    // Pressing Fill while it writes doesn't put the usual CV where the tailored one is going.
    const meanwhile = await h.fill(page);
    assert.ok(meanwhile.held >= 3, `held ${meanwhile.held}`);
    assert.match(meanwhile.notes.join(' '), /still writing your cover letter/);
    assert.equal(await fileName(page, '#resume'), '');

    release();
    const done = await quickDone();
    assert.equal(done.state, 'done', done.message);
    assert.equal(done.message, 'done', 'nothing left to attach by hand');
    assert.equal(await fileName(page, '#resume'), 'ada_lovelace_cv_acme_capital.pdf');
    assert.equal(await fileName(page, '#cover'), 'ada_lovelace_cover_letter_acme_capital.pdf');
    assert.match(await page.$eval('#cover-text', (el) => el.value), /^Dear Acme Capital Recruitment Team,/);
    // The page cleared the phone box when the CV went in: it was put back.
    await until(page.evaluate.bind(page), () => !!document.querySelector('#phone').value);
    assert.equal(await page.$eval('#privacy', (el) => el.checked), true);
    assert.equal(await page.$eval('#alerts', (el) => el.checked), false);
    // The setting itself is untouched: a plain Fill still leaves acknowledgements to you.
    assert.equal((await h.bg(() => globalThis.JTF.store.getSettings())).consents, false);
  } finally {
    ai.gate.letter = null;
    if (release) release();
    await page.close();
  }
});

test('quick apply: the tailored CV takes the place of the usual one a Fill attached before', async () => {
  await h.bg(() => globalThis.JTF.store.clearQuickApply()); // the last test's letter is for this job too
  const page = await h.open('letters/apply.html?job=R-1234&filled=1');
  await h.fill(page);
  assert.equal(await fileName(page, '#resume'), 'ada_cv.pdf');
  const done = await quickApply(page);
  assert.equal(done.state, 'done', done.message);
  assert.equal(done.message, 'done');
  assert.equal(await fileName(page, '#resume'), 'ada_lovelace_cv_acme_capital.pdf');
  assert.equal(await fileName(page, '#cover'), 'ada_lovelace_cover_letter_acme_capital.pdf');
  await page.close();
});

test('quick apply: when the AI fails, the form still gets your details and your usual CV', async () => {
  ai.fail.status = 401;
  const page = await h.open('letters/apply-full.html?job=R-1234&fails=1');
  try {
    const done = await quickApply(page);
    assert.equal(done.state, 'error');
    await until(page.evaluate.bind(page), () => !!document.querySelector('#resume').files.length);
    assert.equal(await fileName(page, '#resume'), 'ada_cv.pdf');
    assert.equal(await page.$eval('#first', (el) => el.value), 'Ada');
    assert.equal(await page.$eval('#privacy', (el) => el.checked), true);
  } finally {
    ai.fail.status = 0;
    await closeStudios();
    await page.close();
  }
});
