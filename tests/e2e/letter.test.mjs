// The cover letter studio end to end, with a scripted stand-in for the AI provider: find the job
// description from an application page, write and check a letter (the first draft invents a number
// and must be revised), lay out the PDF, attach it to the form, and tailor the CV.
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
  let drafts = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = JSON.parse(body || '{}');
      const system = (json.messages && json.messages[0] && json.messages[0].content) || '';
      calls.push({ path: req.url, auth: req.headers.authorization, json });
      let reply;
      if (/extract facts from a job posting/.test(system))
        reply = {
          company: 'Acme Capital',
          role: 'Operations Analyst',
          location: 'London',
          keywords: ['reconcile trades', 'breaks', 'Python', 'data quality', 'VBA'],
          requirements: ['Python or SQL'],
        };
      else if (/write job application cover letters/.test(system)) reply = LETTER(drafts++ === 0 ? '90,000' : '40,000');
      else if (/strict fact-checker/.test(system)) reply = { unsupported: [] };
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
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls })));
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
      // The scripted letters are short; a lower target keeps the length check out of the way.
      await store.saveKit(id, { minWords: 80 });
    },
    [profileId, dataUrl, `http://127.0.0.1:${ai.server.address().port}/v1`],
  );
});

after(async () => {
  await h.close();
  ai.server.close();
});

test('studio: finds the job, writes a checked letter, attaches it and a tailored CV', async () => {
  const apply = await h.open('letters/apply.html?job=R-1234');
  const tabId = await h.tabId(apply);
  const studio = await h.extPage(`studio/studio.html?tab=${tabId}`);
  const call = studio.call;

  // The letter appears once every step has run.
  await until(
    call,
    () => !document.querySelector('#editor').hidden || document.querySelector('#error').textContent,
    null,
    30000,
  );
  const error = await call(() =>
    document.querySelector('#error').hidden ? '' : document.querySelector('#error').textContent,
  );
  assert.equal(error, '');

  const job = await call(() => ({
    title: document.querySelector('.job-title').textContent,
    verdict: document.querySelector('#job-verdict').textContent,
    source: document.querySelector('#job-body a') && document.querySelector('#job-body a').href,
  }));
  assert.equal(job.title, 'Operations Analyst');
  assert.match(job.verdict, /same job/i);
  assert.match(job.source, /posting\.html/);

  // The invented "90,000" was sent back to the model and the revised draft kept the real figure.
  const letterCalls = ai.calls.filter((c) => /write job application cover letters/.test(c.json.messages[0].content));
  assert.equal(letterCalls.length, 2);
  assert.match(letterCalls[1].json.messages.at(-1).content, /90000/);
  assert.equal(ai.calls[0].auth, 'Bearer test-key');
  const cvSent = letterCalls[0].json.messages[1].content;
  assert.match(cvSent, /checks 40,000 trades a night/, 'the CV text was read from the PDF and sent');
  assert.match(cvSent, /Reconcile trades and positions every day/, 'and so was the job description');

  const body = await call(() => document.querySelector('#body').value);
  assert.match(body, /checks 40,000 trades a night/);
  const checks = await call(() =>
    [...document.querySelectorAll('#checks li')].map((li) => li.className + ': ' + li.textContent),
  );
  assert.ok(
    checks.some((c) => /^ok: Fits on one page/.test(c)),
    checks.join('\n'),
  );
  assert.ok(!checks.some((c) => c.startsWith('bad')), checks.join('\n'));
  assert.ok(await call(() => document.querySelector('#preview').src.startsWith('blob:')));

  // Editing re-checks the letter: a made-up number is flagged at once.
  await call(() => {
    const box = document.querySelector('#body');
    box.value = box.value.replace('40,000', '55,000');
    box.dispatchEvent(new Event('input'));
  });
  await until(call, () => [...document.querySelectorAll('#checks li.bad')].some((li) => /55000/.test(li.textContent)));
  await call(() => {
    const box = document.querySelector('#body');
    box.value = box.value.replace('55,000', '40,000');
    box.dispatchEvent(new Event('input'));
  });
  await until(call, () => !document.querySelector('#checks li.bad'));

  // Attach it to the open application.
  await call(() => document.querySelector('#use').click());
  await until(call, () => /Attached/.test(document.querySelector('#use-status').textContent), null, 15000);
  const attached = await apply.$eval(
    '#cover',
    (el) => el.files[0] && { name: el.files[0].name, type: el.files[0].type, size: el.files[0].size },
  );
  assert.match(attached.name, /^ada_lovelace_cover_letter_acme_capital\.pdf$/);
  assert.equal(attached.type, 'application/pdf');
  assert.ok(attached.size > 2000);
  const pasted = await apply.$eval('#cover-text', (el) => el.value);
  assert.match(pasted, /^Dear Acme Capital Recruitment Team,/);
  assert.match(pasted, /Yours sincerely,\nAda Lovelace$/);
  assert.equal(
    await apply.$eval('#resume', (el) => el.files.length),
    0,
    'attaching the letter leaves other fields alone',
  );

  // A normal fill of this application now uses the generated letter, not the stored one.
  const summary = await h.fill(apply);
  assert.equal(summary.letter && summary.letter.company, 'Acme Capital');
  assert.match(await apply.$eval('#cover', (el) => el.files[0].name), /cover_letter_acme_capital/);
  assert.equal(await apply.$eval('#resume', (el) => el.files[0].name), 'ada_cv.pdf');

  // Tailor the CV, choose it, and attach again: the resume field gets the tailored PDF.
  await call(() => document.querySelector('#cv-make').click());
  await until(call, () => !document.querySelector('#cv-result').hidden, null, 20000);
  const coverage = await call(() => document.querySelector('#cv-coverage').textContent);
  assert.match(coverage, /Keywords: \d+ → \d+ of 5/);
  assert.match(
    await call(() => document.querySelector('#cv-keywords').textContent),
    /VBA/,
    'a missing skill is reported, not added',
  );
  await call(() => {
    document.querySelector('#cv-use').checked = true;
    document.querySelector('#cv-use').dispatchEvent(new Event('change'));
    document.querySelector('#use').click();
  });
  await until(call, () => /Attached/.test(document.querySelector('#use-status').textContent), null, 15000);
  await until(() => apply.$eval('#resume', (el) => !!el.files[0] && /_cv_/.test(el.files[0].name)), null, null, 10000);
  assert.match(await apply.$eval('#resume', (el) => el.files[0].name), /^ada_lovelace_cv_acme_capital\.pdf$/);

  const saved = await h.bg(async () => (await globalThis.JTF.store.getLetters())[0]);
  assert.equal(saved.posting.company, 'Acme Capital');
  assert.ok(saved.attachedAt && saved.useCv && saved.cv);
  assert.deepEqual(saved.jobIds.includes('R-1234'), true);
  await studio.close();
  await apply.close();
});

test('studio: reopening the same application offers the letter already written', async () => {
  const apply = await h.open('letters/apply.html?job=R-1234');
  const studio = await h.extPage(`studio/studio.html?tab=${await h.tabId(apply)}`);
  const before = ai.calls.filter((c) => /write job application cover letters/.test(c.json.messages[0].content)).length;
  await until(studio.call, () => !!document.querySelector('#previous'), null, 30000);
  assert.match(
    await studio.call(() => document.querySelector('#previous').textContent),
    /You wrote a letter for this job/,
  );
  await studio.call(() =>
    [...document.querySelectorAll('#previous button')].find((b) => b.textContent === 'Open it').click(),
  );
  await until(studio.call, () => !document.querySelector('#editor').hidden, null, 15000);
  assert.match(await studio.call(() => document.querySelector('#body').value), /checks 40,000 trades a night/);
  const after = ai.calls.filter((c) => /write job application cover letters/.test(c.json.messages[0].content)).length;
  assert.equal(after, before, 'no new letter was written');
  assert.ok(await studio.call(() => document.querySelector('#preview').src.startsWith('blob:')));
  await studio.close();
  await apply.close();
});

test('studio: a job that cannot be found asks for the description', async () => {
  const page = await h.open('signup.html');
  const studio = await h.extPage(`studio/studio.html?tab=${await h.tabId(page)}`);
  await until(studio.call, () => !document.querySelector('#job-manual').hidden, null, 30000);
  const text = await studio.call(() => document.querySelector('#job-body').textContent);
  assert.match(text, /couldn’t find the description/);
  // Pasting it carries on with the letter.
  await studio.call(() => {
    document.querySelector('#job-manual-text').value =
      'Acme Capital is hiring an Operations Analyst in London to reconcile trades, investigate breaks with the trading desks and automate manual checks with Python. We look for attention to detail, data quality, Python or SQL, and clear communication with traders and engineers. The programme starts in September 2027 and includes training in our London office, with mentoring from senior analysts and a project you present at the end of the first year.';
    document.querySelector('#job-manual-use').click();
  });
  await until(studio.call, () => !document.querySelector('#editor').hidden, null, 30000);
  assert.match(await studio.call(() => document.querySelector('#job-verdict').textContent), /Your description/);
  await studio.close();
  await page.close();
});

test('job context: the job page a tab showed before is remembered, also in tabs it opens', async () => {
  const page = await h.open('letters/posting.html');
  const posting = page.url();
  // An application site that drops the job from its address.
  await page.goto(h.url('signup.html'));
  const trail = async (p) => (await h.handler('jtf:job-context', p)).trail || [];
  await until(async () => (await trail(page)).some((t) => t.url === posting), null, null, 10000);
  const first = (await trail(page))[0];
  assert.equal(first.url, posting);
  assert.ok(first.at <= Date.now());
  assert.ok(!(await trail(page)).some((t) => /signup/.test(t.url)), 'the page itself is left out');

  // "Apply" opening the form in a new tab: it starts with its opener's trail.
  const child = await h.bg(
    async ([url, opener]) => (await globalThis.JTF.api.tabs.create({ url, openerTabId: opener, active: false })).id,
    [h.url('signup.html?step=2'), await h.tabId(page)],
  );
  const childTrail = () =>
    h.bg(async (id) => (await globalThis.JTFBackground.handlers['jtf:job-context']({ tabId: id }, {})).trail, child);
  await until(
    async () => ((await childTrail().catch(() => [])) || []).some((t) => t.url === posting),
    null,
    null,
    15000,
  );
  await h.bg((id) => globalThis.JTF.api.tabs.remove(id), child);
  await page.close();
});

test('settings: example letters are read from PDFs and the company they were for is noted', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const lines = [
    'Dear Contoso Recruitment Team,',
    'I am applying for the Summer Internship in Leeds. I am a second-year Mathematics student at the',
    'University of Leeds. Last summer I built a stock tool for a food bank that matches donations',
    'against its stock list each night and flags anything that went missing between delivery and shelf.',
    'The volunteers now spend twenty minutes on the stock check instead of two hours, and the tool has',
    'run every night since without anyone looking after it. I would welcome the chance to bring the same',
    'care to your operations team next summer, where getting the details right matters every day.',
    'Thank you for considering my application.',
    'Yours sincerely,',
    'Ada Lovelace',
  ];
  lines.forEach((line, i) => page.drawText(line, { x: 60, y: 780 - i * 16, size: 11, font }));
  const bytes = Buffer.from(await doc.save());

  const settings = await h.extPage('options/options.html#letters');
  await until(settings.call, () => !!document.querySelector('input[type=file][accept*=".pdf"][multiple]'));
  await settings.call(async (b64) => {
    const input = document.querySelector('input[type=file][accept*=".pdf"][multiple]');
    const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([data], 'contoso_letter.pdf', { type: 'application/pdf' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
  }, bytes.toString('base64'));
  const row = await until(settings.call, () => {
    const cells = [...document.querySelectorAll('td')].map((td) => td.textContent);
    return cells.includes('contoso_letter.pdf') && cells.join(' | ');
  });
  assert.match(row, /contoso_letter\.pdf \| \d+ words \| Contoso/);
  const kit = await h.bg(async () => {
    const { store } = globalThis.JTF;
    return store.getKit((await store.getActive()).profile.id);
  });
  const sample = kit.samples.find((x) => x.name === 'contoso_letter.pdf');
  assert.match(sample.text, /food bank that matches donations/);
  await settings.close();
});
