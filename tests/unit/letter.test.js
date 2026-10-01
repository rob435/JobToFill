'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers');

const JTF = load();
require('../../extension/lib/ai.js');
require('../../extension/lib/letter.js');
const { ai, letter: L, fields } = JTF;

const profile = fields.upgradeProfile({
  personal: { firstName: 'Ada', lastName: 'Lovelace' },
  contact: { email: 'ada@example.com', phone: '07700 900123' },
  links: { github: 'https://github.com/ada' },
  education: [
    { school: 'University of Leeds', degree: 'BSc', field: 'Mathematics', startDate: '2024-09', endDate: '2027-06' },
  ],
  experience: [
    {
      company: 'Northwind',
      title: 'Data intern',
      startDate: '2025-06',
      endDate: '2025-08',
      description: 'Cleaned 12,000 customer records in Python and SQL; cut duplicate invoices by 30%.',
    },
  ],
  skills: 'Python, SQL, Excel',
});
const kit = {
  minWords: 80,
  notes: 'Captain of the university chess team.',
  samples: [
    {
      text: 'Dear Contoso Recruitment Team,\n\nI am applying for the Summer Internship. I built a dashboard used by 40 people.',
    },
  ],
};
const posting = {
  url: 'https://jobs.example.com/acme/123',
  title: 'Operations Summer Analyst',
  company: 'Acme Capital',
  location: 'London',
  description:
    'Acme Capital is hiring an Operations Summer Analyst in London for summer 2026. You will reconcile trades, investigate breaks and improve processes. We look for attention to detail, Excel and VBA, and clear communication. ' +
    'The team supports 3 trading desks.',
};
const ctx = {
  company: 'Acme Capital',
  role: 'Operations Summer Analyst',
  sources: L.materials(profile, kit, ''),
  posting: posting.description,
  samples: kit.samples,
  today: Date.parse('2025-10-01'),
  minWords: 40,
  maxWords: 400,
};
const good = {
  salutation: 'Dear Acme Capital Recruitment Team,',
  paragraphs: [
    'I am applying for the Operations Summer Analyst role in London. I am a second-year Mathematics student at the University of Leeds, graduating in June 2027.',
    'At Northwind I cleaned 12,000 customer records in Python and SQL, and cut duplicate invoices by 30%. Finding the cause of a break and fixing the process behind it is the part of operations I enjoy most.',
    'I am also captain of the university chess team, which is good practice at staying careful under a clock.',
    'I would welcome the chance to join Acme Capital next summer. Thank you for considering my application.',
  ],
  closing: 'Yours sincerely,',
};

test('letter: a faithful draft passes every check', () => {
  const check = L.checkLetter(good, ctx);
  assert.deepEqual(check.errors, []);
  assert.equal(check.severe, 0);
});

test('letter: invented numbers, unclaimed skills and the wrong company are caught', () => {
  const bad = structuredClone(good);
  bad.paragraphs[1] = 'At Northwind I cleaned 15,000 records with VBA and Excel for 4 years.';
  bad.paragraphs[2] = 'Like my letter to Contoso, I am keen on markets.';
  const check = L.checkLetter(bad, ctx);
  const all = check.errors.join('\n');
  assert.match(all, /15000/);
  assert.match(all, /\b4\b/);
  assert.match(all, /vba/i);
  const learning = structuredClone(good);
  learning.paragraphs[2] =
    'I want to build up my VBA skills next summer, and I am captain of the university chess team.';
  assert.doesNotMatch(L.checkLetter(learning, ctx).errors.join('\n'), /vba/i, 'wanting to learn it is not a claim');
  assert.doesNotMatch(all, /excel/i, 'Excel is in the profile');
  assert.match(all, /Contoso/);
  assert.ok(check.severe >= 3);
});

test('letter: placeholders, markdown, dashes, stock phrases and a missing company', () => {
  const bad = {
    salutation: 'Dear Hiring Team,',
    paragraphs: [
      'I am writing to express my passion for this role — truly!',
      '- one\n- two',
      '[One sentence on a market theme you follow.]',
    ],
    closing: 'Yours sincerely,',
  };
  const all = L.checkLetter(bad, ctx).errors.join('\n');
  for (const re of [
    /placeholder/,
    /markdown/,
    /dashes/,
    /exclamation/,
    /i am writing to express/,
    /Mention Acme Capital/,
  ])
    assert.match(all, re);
});

test('letter: describing the job advert instead of the candidate is flagged', () => {
  const meta = structuredClone(good);
  meta.paragraphs[1] =
    'The internship asks for Python and SQL. At Northwind I cleaned 12,000 customer records in Python and SQL.';
  assert.match(L.checkLetter(meta, ctx).errors.join('\n'), /job advert/);
});

test('letter: a letter must end with its own short closing paragraph', () => {
  const noClose = structuredClone(good);
  noClose.paragraphs = good.paragraphs.slice(0, 3);
  assert.match(L.checkLetter(noClose, ctx).errors.join('\n'), /closing paragraph/);
  assert.doesNotMatch(L.checkLetter(good, ctx).errors.join('\n'), /closing paragraph/);
});

test('letter: cleanLetter separates the greeting and sign-off and fixes typography', () => {
  const out = L.cleanLetter(
    {
      paragraphs: ['Dear Acme Team,', "I don't stop.", 'Thanks again. Yours sincerely,', 'Yours sincerely,'],
      closing: 'Yours sincerely,\nAda Lovelace',
    },
    { salutation: 'Dear X,', closing: 'Kind regards,' },
  );
  assert.equal(out.salutation, 'Dear Acme Team,');
  assert.deepEqual(out.paragraphs, ['I don’t stop.', 'Thanks again.']);
  assert.equal(out.closing, 'Yours sincerely,');
});

test('letter: contact line, date and companies from example letters', () => {
  assert.deepEqual(L.contactLine(profile, {}), ['07700 900123', 'ada@example.com', 'github.com/ada']);
  assert.deepEqual(L.contactLine(profile, { contact: 'a | b' }), ['a', 'b']);
  assert.equal(L.formatDate(new Date(2026, 9, 1)), '1 October 2026');
  assert.equal(L.formatDate(new Date(2026, 9, 1), 'en-US'), 'October 1, 2026');
  assert.deepEqual(L.sampleCompanies(kit.samples), ['Contoso']);
  assert.deepEqual(L.companyAliases('Jump Trading Group LLC'), ['Jump Trading Group LLC', 'Jump Trading']);
});

/** A scripted model: each call returns the next reply; records what it was asked. */
function scripted(replies) {
  const calls = [];
  const chat = async (messages, opts) => {
    calls.push({ messages: structuredClone(messages), opts });
    const next = replies.shift();
    if (!next) throw new Error('unexpected call');
    return { json: typeof next === 'function' ? next(messages) : next };
  };
  return { chat, calls };
}

test('letter: write() sends failed checks back, audits facts and keeps the best draft', async () => {
  const sloppy = structuredClone(good);
  sloppy.paragraphs[1] = 'At Northwind I cleaned 99,000 records.';
  const embellished = structuredClone(good);
  embellished.paragraphs[2] = 'I also deployed software daily as part of an Agile team.';
  const { chat, calls } = scripted([
    sloppy, // draft 1: invented number -> revise without auditing
    embellished, // draft 2: passes rules, audit doubts a claim -> revise
    { unsupported: [{ quote: 'I also deployed software daily', problem: 'not in the material' }] },
    good, // draft 3: clean
    { unsupported: [] },
  ]);
  const analysis = L.cleanAnalysis({ company: 'Acme Capital', role: 'Operations Summer Analyst' }, posting, {});
  const stages = [];
  const result = await L.write(
    chat,
    { profile, kit, cvText: '', posting, analysis, today: Date.parse('2025-10-01') },
    { onProgress: (s) => stages.push(s) },
  );
  assert.deepEqual(result.letter.paragraphs, good.paragraphs);
  assert.deepEqual(result.check.errors, []);
  assert.equal(result.attempts, 3);
  assert.deepEqual(stages, ['writing', 'checking', 'revising', 'auditing', 'checking', 'revising', 'auditing']);
  assert.match(calls[1].messages.at(-1).content, /99000/, 'the second draft is asked to fix the number');
  assert.match(calls[3].messages.at(-1).content, /deployed software daily/, 'and the third the unsupported claim');
  assert.equal(result.header.name, 'Ada Lovelace');
  assert.equal(result.header.date, '1 October 2025');
  assert.match(L.asText(result), /^Dear Acme Capital Recruitment Team,\n\nI am applying/);
});

test('letter: when every draft fails, the least wrong one is returned with what is left to check', async () => {
  const embellished = structuredClone(good);
  embellished.paragraphs[2] = 'I also deployed software daily as part of an Agile team.';
  const doubt = { unsupported: [{ quote: 'I also deployed software daily', problem: 'not in the material' }] };
  const { chat } = scripted([embellished, doubt, embellished, doubt, embellished, doubt]);
  const analysis = L.cleanAnalysis({ company: 'Acme Capital' }, posting, {});
  const result = await L.write(chat, { profile, kit, cvText: '', posting, analysis, today: Date.parse('2025-10-01') });
  assert.equal(result.check.errors.length, 0);
  assert.match(result.check.warnings.join(), /Check this is true: “I also deployed software daily”/);
});

test('letter: tailor() rejects invented facts in a CV', async () => {
  const cvText = [
    'Ada Lovelace',
    'Education: University of Leeds, BSc Mathematics, 2024 – 2027',
    'Experience: Northwind, Data intern, Jun 2025 – Aug 2025',
    '• Cleaned 12,000 customer records in Python and SQL',
    '• Cut duplicate invoices by 30%',
    'Skills: Python, SQL, Excel',
  ]
    .join('\n')
    .repeat(3);
  const cv = (bullets, skills, org = 'Northwind') => ({
    sections: [
      {
        title: 'Experience',
        entries: [{ heading: org, right: 'Jun 2025 – Aug 2025', subheading: 'Data intern', bullets }],
      },
      { title: 'Skills', lines: [{ label: 'Tools', text: skills }] },
    ],
    changes: ['Moved Excel first'],
  });
  const { chat } = scripted([
    cv(['Reconciled 50,000 records'], 'Excel, VBA, Python', 'Goldman Sachs'),
    cv(
      ['Cleaned and reconciled 12,000 customer records in Python and SQL', 'Cut duplicate invoices by 30%'],
      'Excel, Python, SQL',
    ),
  ]);
  const analysis = { company: 'Acme', role: 'Analyst', keywords: ['Excel', 'reconcile', 'VBA'], requirements: [] };
  const result = await L.tailor(chat, { profile, kit, cvText, analysis });
  assert.deepEqual(result.check.errors, []);
  assert.equal(result.cv.name, 'Ada Lovelace');
  assert.deepEqual(result.after.missing, ['VBA'], 'a keyword the candidate lacks is never added');
  const first = L.checkCv(cv(['Reconciled 50,000 records'], 'Excel, VBA', 'Goldman Sachs'), { cvText, sources: '' });
  assert.match(first.errors.join('\n'), /50000/);
  assert.match(first.errors.join('\n'), /vba/i);
  assert.match(first.errors.join('\n'), /Goldman Sachs/);
});

test('letter: keyword coverage tolerates plurals and verb forms', () => {
  const c = L.coverage(
    ['reconciliations', 'Excel', 'process improvement', 'VBA'],
    'I reconciliation trades in excel and improve the process.',
  );
  assert.deepEqual(c.matched, ['reconciliations', 'Excel']);
  assert.deepEqual(c.missing, ['process improvement', 'VBA']);
});

/* --------------------------------------------------------------------- ai */

function fakeFetch(responses) {
  const seen = [];
  const fn = async (url, init) => {
    seen.push({ url, body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.body) };
  };
  fn.seen = seen;
  return fn;
}

const reply = (content, extra) => ({
  status: 200,
  body: { model: 'm', choices: [{ message: { content }, finish_reason: 'stop' }], ...extra },
});
const cfg = { provider: 'openrouter', apiKey: ' sk-or-test ', model: '' };

test('ai: JSON replies are parsed, the default model and headers are used', async () => {
  const fetch = fakeFetch([reply('```json\n{"ok": true}\n```', { usage: { cost: 0.001 } })]);
  const r = await ai.chat(cfg, { messages: [{ role: 'user', content: 'hi' }], json: true, fetch });
  assert.deepEqual(r.json, { ok: true });
  assert.equal(r.usage.cost, 0.001);
  const sent = fetch.seen[0];
  assert.equal(sent.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(sent.body.model, 'deepseek/deepseek-v4.1-flash');
  assert.deepEqual(sent.body.response_format, { type: 'json_object' });
  assert.deepEqual(sent.body.reasoning, { enabled: false });
  assert.equal(sent.headers.Authorization, 'Bearer sk-or-test');
});

test('ai: retries server errors and bad JSON, explains key and credit problems', async () => {
  const fetch = fakeFetch([{ status: 503, body: {} }, reply('not json'), reply('{"a":1}')]);
  const r = await ai.chat(cfg, { messages: [], json: true, fetch });
  assert.deepEqual(r.json, { a: 1 });
  assert.equal(fetch.seen.length, 3);

  await assert.rejects(
    ai.chat(cfg, { messages: [], fetch: fakeFetch([{ status: 401, body: { error: { message: 'no' } } }]) }),
    /rejected the API key/,
  );
  await assert.rejects(ai.chat(cfg, { messages: [], fetch: fakeFetch([{ status: 402, body: {} }]) }), /out of credit/);
  await assert.rejects(ai.chat({ ...cfg, apiKey: '' }, { messages: [], fetch: fakeFetch([]) }), /API key/);
});

test('ai: a provider without JSON mode is asked again without it', async () => {
  const fetch = fakeFetch([
    { status: 400, body: { error: { message: 'response_format is not supported' } } },
    reply('{"ok":true}'),
  ]);
  const r = await ai.chat({ provider: 'deepseek', apiKey: 'k' }, { messages: [], json: true, fetch });
  assert.deepEqual(r.json, { ok: true });
  assert.equal(fetch.seen[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(fetch.seen[1].body.response_format, undefined);
  assert.equal(fetch.seen[0].body.reasoning, undefined, 'only OpenRouter gets the reasoning switch');
});

test('ai: custom providers need an https address', () => {
  assert.match(ai.problem({ provider: 'custom', apiKey: 'k', model: 'm', baseUrl: 'ftp://x' }), /API address/);
  assert.equal(ai.problem({ provider: 'custom', apiKey: 'k', model: 'm', baseUrl: 'https://x.example/v1/' }), null);
  assert.equal(
    ai.resolve({ provider: 'custom', baseUrl: 'https://x.example/v1/chat/completions' }).base,
    'https://x.example/v1',
  );
});
