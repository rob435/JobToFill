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
        title: 'Education',
        entries: [{ heading: 'University of Leeds', right: '2024 – 2027', subheading: 'BSc Mathematics', bullets: [] }],
      },
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

test('ai: a model that sets its own temperature is asked again without one', async () => {
  const fetch = fakeFetch([
    { status: 400, body: { error: { message: '`temperature` is not supported for this model.' } } },
    reply('{"ok":true}'),
  ]);
  const r = await ai.chat(
    { provider: 'openrouter', apiKey: 'k', model: 'anthropic/claude-opus-5.5' },
    { messages: [], json: true, temperature: 0.4, fetch },
  );
  assert.deepEqual(r.json, { ok: true });
  // A model the provider doesn't have is still said as much, and not asked again.
  await assert.rejects(
    ai.chat(cfg, {
      messages: [],
      fetch: fakeFetch([{ status: 400, body: { error: { message: 'The model `x/y` does not exist' } } }]),
    }),
    (err) => err.code === 'model' && /doesn’t offer the model/.test(err.message),
  );
  assert.equal(fetch.seen[0].body.temperature, 0.4);
  assert.equal('temperature' in fetch.seen[1].body, false);
  assert.equal(fetch.seen.length, 2);
});

test('ai: custom providers need an https address', () => {
  assert.match(ai.problem({ provider: 'custom', apiKey: 'k', model: 'm', baseUrl: 'ftp://x' }), /API address/);
  assert.equal(ai.problem({ provider: 'custom', apiKey: 'k', model: 'm', baseUrl: 'https://x.example/v1/' }), null);
  assert.equal(
    ai.resolve({ provider: 'custom', baseUrl: 'https://x.example/v1/chat/completions' }).base,
    'https://x.example/v1',
  );
});

test('letter: a tailored CV may not drop a school or employer', () => {
  const cvText = 'University of Leeds, BSc Mathematics, 2024 – 2027\nNorthwind, Data intern, 2025\nSkills: Python';
  const tailored = {
    sections: [{ title: 'Experience', entries: [{ heading: 'Northwind', bullets: ['Data work in Python'] }] }],
  };
  const check = L.checkCv(tailored, {
    cvText,
    sources: '',
    orgs: ['University of Leeds', 'Northwind', 'Acme (not in the CV)'],
  });
  assert.match(check.errors.join('\n'), /missing: University of Leeds\./);
});

test('letter: odd reply shapes still give a letter', () => {
  const defaults = { salutation: 'Dear X,', closing: 'Yours sincerely,' };
  const nested = L.cleanLetter({ letter: { Salutation: 'Dear Acme Team,', Paragraphs: ['One.', 'Two.'] } }, defaults);
  assert.deepEqual([nested.salutation, nested.paragraphs], ['Dear Acme Team,', ['One.', 'Two.']]);
  const asString = L.cleanLetter({ paragraphs: 'First paragraph.\n\nSecond paragraph.' }, defaults);
  assert.deepEqual(asString.paragraphs, ['First paragraph.', 'Second paragraph.']);
  const asObjects = L.cleanLetter({ paragraphs: [{ text: 'A.' }, { content: 'B.' }] }, defaults);
  assert.deepEqual(asObjects.paragraphs, ['A.', 'B.']);
  assert.deepEqual(L.cleanLetter(['not', 'an', 'object'], defaults).paragraphs, []);
});

test('letter: the candidate’s own instructions count as facts; a failed audit is reported', async () => {
  const told = structuredClone(good);
  told.paragraphs[2] = 'I am also fluent in French, which I used for 2 years as a volunteer translator.';
  let calls = 0;
  const chat = async (messages) => {
    calls++;
    if (/strict fact-checker/.test(messages[0].content)) throw new Error('provider down');
    return { json: told };
  };
  const analysis = L.cleanAnalysis({ company: 'Acme Capital', role: 'Operations Summer Analyst' }, posting, {});
  const result = await L.write(chat, {
    profile,
    kit,
    cvText: '',
    posting,
    analysis,
    today: Date.parse('2025-10-01'),
    instructions: 'Mention that I am fluent in French and volunteered as a translator for 2 years.',
  });
  assert.deepEqual(result.check.errors, [], 'the 2 years come from the instruction');
  assert.match(result.check.warnings.join(), /second fact check couldn’t run/);
  assert.equal(calls, 2, 'one draft, one (failed) audit');
});

test('letter: postings in other languages are recognised', () => {
  assert.equal(L.postingLanguage(posting.description), 'en');
  const de =
    'Wir suchen für unser Team in Frankfurt eine Praktikantin oder einen Praktikanten. Ihre Aufgaben: Sie unterstützen das Team bei der Analyse und Sie arbeiten mit unseren Kunden. Das bringen Sie mit: ein Studium der Wirtschaftswissenschaften und Freude an der Arbeit mit Zahlen. Wir bieten Ihnen eine spannende Aufgabe und die Möglichkeit, Verantwortung zu übernehmen.';
  assert.equal(L.postingLanguage(de), 'de');
  const fr =
    'Nous recherchons pour notre équipe à Paris un stagiaire. Vos missions : vous participez à l’analyse des données et vous travaillez avec les équipes de nos clients. Votre profil : une formation en finance et le goût du travail en équipe. Nous vous offrons un environnement stimulant et des responsabilités dès votre arrivée dans les bureaux.';
  assert.equal(L.postingLanguage(fr), 'fr');
});

test('ai: JSON after thinking text, with trailing commas, still parses', () => {
  assert.deepEqual(ai.parseJson('<think>maybe {a:1}</think>\n{"ok": true, "list": [1, 2,],}'), {
    ok: true,
    list: [1, 2],
  });
  assert.deepEqual(ai.parseJson('Here you go:\n```json\n{"a": "b"}\n```'), { a: 'b' });
  assert.throws(() => ai.parseJson('no json here'), /not valid JSON/);
});

test('ai: a rate limit waits for Retry-After before trying again', async () => {
  let n = 0;
  const started = Date.now();
  const fetch = async () => {
    n++;
    if (n === 1)
      return {
        ok: false,
        status: 429,
        headers: { get: (h) => (h === 'retry-after' ? '1' : null) },
        text: async () => '{}',
      };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }),
    };
  };
  const r = await ai.chat(cfg, { messages: [], json: true, fetch });
  assert.deepEqual(r.json, { ok: true });
  assert.ok(Date.now() - started >= 950, 'waited about a second');
});

test('letter: HTML entities from pages never reach the letter', () => {
  assert.equal(
    L.decodeEntities('FICC &amp; Equities, Sales &amp;amp; Trading &#8211; London&nbsp;'),
    'FICC & Equities, Sales & Trading – London ',
  );
  assert.equal(L.tidy('Investors&#39; money &amp; markets'), 'Investors’ money & markets');
  const a = L.cleanAnalysis({}, { title: '2027 | FICC &amp; Equities', company: 'Goldman Sachs &amp; Co.' }, {});
  assert.equal(a.role, '2027 | FICC & Equities');
  assert.equal(a.company, 'Goldman Sachs & Co.');
});

test('letter: analysis says when the text is not a job posting', async () => {
  const chat = async () => ({ json: { isPosting: false, company: 'Verition', role: 'Your Privacy' } });
  const notJob = { title: 'Your Privacy', company: 'Verition', description: 'We use cookies. '.repeat(30) };
  assert.equal((await L.analyse(chat, notJob, {})).isPosting, false);
  const yes = async () => ({ json: { company: 'Acme', role: 'Analyst' } });
  assert.equal((await L.analyse(yes, posting, {})).isPosting, true, 'missing means yes');
  const banner = { ...posting, title: 'Your Privacy' };
  assert.equal((await L.analyse(async () => ({ json: { company: 'Acme' } }), banner, {})).role, '', 'not a role');
  assert.equal((await L.analyse(yes, banner, {})).role, 'Analyst');
});

test('letter: finance terms and training programmes are not stock phrases or invented qualifications', () => {
  const finance = {
    ...ctx,
    role: 'Graduate Programme 2027 - ACA Deal Advisory',
    posting: 'Our team works on leveraged loans, dynamic hedging and the ACA qualification, which we sponsor.',
  };
  const say = (sentence) => {
    const draft = structuredClone(good);
    draft.paragraphs[2] = sentence;
    return L.checkLetter(draft, finance).errors.join('\n');
  };
  assert.doesNotMatch(say('I want to understand how leveraged loans are priced.'), /stock phrases/);
  assert.doesNotMatch(say('I am curious about dynamic hedging.'), /stock phrases/);
  assert.doesNotMatch(say('I read about market dynamics every week.'), /stock phrases/);
  assert.match(say('I would leverage my skills.'), /“leverage”/);
  assert.match(say('I am leveraging my chess.'), /“leverage”/);
  assert.match(say('I thrive in a dynamic team.'), /“dynamic”/);
  assert.doesNotMatch(say('I would like to join while working towards the ACA qualification.'), /aca/i);
  assert.doesNotMatch(say('I am applying for the 2027 ACA Graduate Programme in Deal Advisory.'), /aca/i);
  assert.match(say('I am ACA qualified.'), /doesn’t mention aca/);
});

test('letter: a letter a few words under the target is a warning, far under is an error', () => {
  const count = L.checkLetter(good, ctx).words;
  const check = L.checkLetter(good, { ...ctx, minWords: count + 10 });
  assert.ok(!check.errors.some((e) => /short/i.test(e)));
  assert.ok(check.warnings.some((w) => /A little short/.test(w)));
  assert.ok(L.checkLetter(good, { ...ctx, minWords: count + 60 }).errors.some((e) => /Too short/.test(e)));
});

test('ai: another provider stands in when one is out of credit or down, not when the key is wrong', async () => {
  const both = {
    provider: 'openrouter',
    apiKey: 'sk-or',
    fallback: { provider: 'deepseek', apiKey: 'sk-ds', model: '' },
  };
  let fetch = fakeFetch([{ status: 402, body: {} }, reply('{"a":1}')]);
  let r = await ai.chat(both, { messages: [], json: true, fetch });
  assert.deepEqual(r.json, { a: 1 });
  assert.equal(fetch.seen[1].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(fetch.seen[1].body.model, 'deepseek-chat', 'its own model, not OpenRouter’s');
  assert.equal(fetch.seen[1].headers.Authorization, 'Bearer sk-ds');
  assert.equal(fetch.seen[1].body.reasoning, undefined, 'OpenRouter’s reasoning setting stays with OpenRouter');
  assert.deepEqual([r.fallback.from, r.fallback.to], ['OpenRouter', 'DeepSeek']);
  assert.match(r.fallback.reason, /out of credit/);

  // Down after its retries.
  fetch = fakeFetch([{ status: 503, body: {} }, { status: 503, body: {} }, { status: 503, body: {} }, reply('ok')]);
  r = await ai.chat(both, { messages: [], fetch });
  assert.equal(r.text, 'ok');
  assert.equal(fetch.seen.length, 4);

  // A rejected key is the person's to fix: no stand-in hides it.
  fetch = fakeFetch([{ status: 401, body: {} }, reply('ok')]);
  await assert.rejects(ai.chat(both, { messages: [], fetch }), /rejected the API key/);
  assert.equal(fetch.seen.length, 1);
});

test('ai: DeepSeek’s own API gets replies it accepts', async () => {
  const ds = { provider: 'deepseek', apiKey: 'sk-ds' };
  const cut = { status: 200, body: { model: 'm', choices: [{ message: { content: '' }, finish_reason: 'length' }] } };
  const fetch = fakeFetch([cut, structuredClone(cut), reply('x')]);
  const r = await ai.chat(ds, { messages: [], maxTokens: 6000, fetch });
  assert.equal(r.text, 'x');
  assert.deepEqual(
    fetch.seen.map((s) => s.body.max_tokens),
    [6000, 8192, 8192],
    'never above its 8,192 limit',
  );
  assert.equal(fetch.seen[0].body.model, 'deepseek-chat');
  assert.equal(fetch.seen[0].url, 'https://api.deepseek.com/chat/completions');
});

/* ------------------------------------------------------------ master CV */

const fs = require('node:fs');
const path = require('node:path');
require('../../extension/lib/cvtex.js');
const { cvtex } = JTF;
const MASTER = cvtex.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cv', 'robin-li.tex'), 'utf8')).cv;

test('letter: extra details from the profile reach the candidate material', () => {
  const withExtra = { ...profile, extraDetails: 'Won the 2024 regional robotics cup with a team of six.' };
  assert.match(
    L.materials(withExtra, kit, ''),
    /Extra details from the candidate:\nWon the 2024 regional robotics cup/,
  );
  assert.doesNotMatch(L.materials(profile, kit, ''), /Extra details/);
  assert.doesNotMatch(L.materials({ ...profile, extraDetails: undefined }, kit, ''), /Extra details/);
});

test('letter: enforceCv restores every frozen field of the master, whatever the model writes', () => {
  const evil = structuredClone(MASTER);
  evil.name = 'Someone Else';
  evil.contact = ['evil@example.com'];
  evil.sections[0].entries[0].heading = 'Harvard University';
  evil.sections[0].entries[0].subright = 'Sep 2020 – Jun 2024';
  evil.sections[1].entries[0].subheading = 'Senior Technology Developer';
  evil.sections[1].entries[0].right = 'London, England';
  evil.sections[1].entries[0].bullets = ['Reworded a bullet.'];
  evil.sections[2].entries[0].right = 'Rust, Go, Kubernetes'; // a tech list may be reordered, not changed
  evil.sections[2].entries[1].right = 'Systemd, Linux, WebSockets, Python'; // a reordering is fine
  evil.sections[3].lines[0].text = 'World Chess Champion';
  evil.sections[4].lines[2].text = 'French (Native)';
  evil.sections[4].lines[0].text = 'NumPy, Python, pandas, SQL, Bash'; // reordered skills are fine
  evil.sections[4].lines[1].text = 'Git, Rust'; // new skill: no
  evil.sections.splice(0, 1); // dropping a whole section: no
  const { cv, restored } = L.enforceCv(MASTER, evil);
  assert.deepEqual(L.frozenDiffs(MASTER, cv), []);
  assert.equal(cv.name, 'Robin Li');
  assert.deepEqual(cv.contact, MASTER.contact);
  assert.equal(cv.sections.length, MASTER.sections.length, 'no section is lost');
  const byTitle = (t) => cv.sections.find((s) => s.title === t);
  assert.equal(byTitle('Education').entries[0].heading, 'University of Glasgow');
  assert.equal(byTitle('Experience').entries[0].subheading, 'Technology Developer Spring Week');
  assert.equal(byTitle('Experience').entries[0].right, 'Glasgow, Scotland');
  assert.deepEqual(
    byTitle('Experience').entries[0].bullets,
    ['Reworded a bullet.'],
    'bullets are the model’s to reword',
  );
  assert.equal(byTitle('Projects').entries[0].right, 'Python, eBay API, SQLite, Telegram');
  assert.equal(byTitle('Projects').entries[1].right, 'Systemd, Linux, WebSockets, Python');
  assert.deepEqual(byTitle('Achievements').lines, MASTER.sections[3].lines);
  assert.equal(byTitle('Skills').lines[2].text, 'English (Native), Mandarin (Proficient), Spanish (Conversational)');
  assert.equal(byTitle('Skills').lines[0].text, 'NumPy, Python, pandas, SQL, Bash');
  assert.equal(byTitle('Skills').lines[1].text, MASTER.sections[4].lines[1].text);
  assert.ok(restored.length >= 5);
  // A malformed reply still gives the whole master back.
  assert.deepEqual(L.enforceCv(MASTER, { sections: 'nonsense' }).cv, MASTER);
});

test('letter: tailor() edits the master CV, keeps frozen fields byte-identical and still fact-checks', async () => {
  const withExtra = { ...profile, extraDetails: 'Maintains an open-source CLI used by 40 people.' };
  const reply = (bullets, extraSkill) => {
    const cv = structuredClone(MASTER);
    cv.name = 'Robin L.';
    cv.sections[1].entries[0].heading = 'Barclays Capital';
    cv.sections[1].entries[0].subright = 'Mar 2027';
    cv.sections[1].entries[0].bullets = bullets;
    cv.sections[2].entries.reverse();
    cv.sections[4].lines[0].text += extraSkill;
    return { ...cv, changes: ['Projects: Market Tape first for data pipeline work'] };
  };
  const { chat, calls } = scripted([
    reply(['Built dashboards used by 900 analysts in Rust.'], ''), // invented number and skill
    reply(
      [
        'Built a personal finance dashboard in Python with a team of four in a 24-hour hackathon.',
        'Cleaned around 5,000 transactions with pandas and wrote regex rules to categorise them.',
      ],
      '',
    ),
  ]);
  const analysis = {
    company: 'Acme',
    role: 'Analyst',
    keywords: ['Python', 'data pipeline', 'Kafka'],
    requirements: [],
  };
  const result = await L.tailor(
    chat,
    { profile: withExtra, kit: { ...kit, cvMaster: MASTER }, cvText: '', analysis },
    {},
  );
  assert.equal(calls.length, 2, 'the first reply invented facts and was sent back');
  assert.match(calls[0].messages[1].content, /"heading":"Barclays"/, 'the model sees the master as JSON');
  assert.match(calls[0].messages[1].content, /Extra details from the candidate:\nMaintains an open-source CLI/);
  assert.doesNotMatch(calls[0].messages[1].content, /Barclays Capital/);
  assert.deepEqual(result.check.errors, []);
  assert.deepEqual(L.frozenDiffs(MASTER, result.cv), []);
  assert.equal(result.cv.name, 'Robin Li');
  assert.equal(result.cv.sections[1].entries[0].subright, 'Mar 2026');
  assert.equal(result.cv.sections[2].entries[0].heading, 'Market Tape', 'entries may be reordered');
  assert.equal(result.cv.sections[1].entries[0].bullets.length, 2);
  assert.ok(result.restored.length > 0);
  assert.deepEqual(result.after.missing, ['data pipeline', 'Kafka']);
  // The tailored CV renders as LaTeX and parses back to the same thing.
  assert.deepEqual(cvtex.parse(cvtex.render(result.cv)).cv, cvtex.normalize(result.cv));
});

test('letter: tailor() without a master still rebuilds the CV from the file text', async () => {
  const cvText = 'Ada Lovelace\n'.repeat(1) + 'Skills: Python, SQL, Excel\n'.repeat(30);
  const { chat, calls } = scripted([
    { sections: [{ title: 'Skills', lines: [{ label: 'Tools', text: 'Python, SQL' }] }] },
  ]);
  const result = await L.tailor(chat, { profile, kit, cvText, analysis: { keywords: ['Python'], requirements: [] } });
  assert.equal(result.cv.name, 'Ada Lovelace');
  assert.match(calls[0].messages[1].content, /text extracted from their file/);
});

test('letter: a CV rebuilt from text has no tech list under a project’s name, and label rows, whatever the model sent', () => {
  const reply = {
    sections: [
      {
        title: 'Projects',
        entries: [
          // A tech list under the name: it goes (the technologies are in the bullets and Skills).
          {
            heading: 'eBaySpy',
            tagline: 'eBay deal detector',
            subheading: 'Python, eBay API, SQLite, Telegram',
            bullets: ['Built a bot that flags underpriced eBay listings.'],
          },
          // …or beside it, or in a field of its own.
          {
            heading: 'Market Tape',
            tagline: 'crypto market-data recorder',
            right: 'Python, WebSockets, Linux, systemd',
            tech: ['Python', 'WebSockets'],
            bullets: ['Records every trade for around 500 markets.'],
          },
        ],
      },
      {
        title: 'Education',
        entries: [
          {
            heading: 'University of Glasgow',
            right: 'Sep 2025 – Jun 2028',
            subheading: 'BSc Computing Science',
            subright: 'Glasgow, Scotland',
          },
        ],
      },
      {
        title: 'Achievements',
        entries: [
          { heading: 'Chess: University of Glasgow Chess Champion; 2000+ Rapid rating on Chess.com' },
          { heading: 'Mathematics:', text: 'UKMT Gold Award' },
          { heading: 'Duke of Edinburgh Silver Award' },
        ],
      },
      { title: 'Skills', lines: [{ text: 'Programming/Data: Python, SQL, Bash' }] },
    ],
  };
  const cv = L.tidyCvLayout(L.cleanCv(reply, { name: 'Robin Li', contact: [] }));
  const [proj, edu, ach, skills] = cv.sections;
  assert.deepEqual(proj.entries[0], {
    heading: 'eBaySpy',
    tagline: 'eBay deal detector',
    bullets: ['Built a bot that flags underpriced eBay listings.'],
  });
  assert.deepEqual(proj.entries[1], {
    heading: 'Market Tape',
    tagline: 'crypto market-data recorder',
    bullets: ['Records every trade for around 500 markets.'],
  });
  // A place or a date is never mistaken for a tech list.
  assert.equal(edu.entries[0].subright, 'Glasgow, Scotland');
  assert.equal(edu.entries[0].right, 'Sep 2025 – Jun 2028');
  // Achievements are rows with a bold label, not bold headings.
  assert.deepEqual(ach.entries, []);
  assert.deepEqual(ach.lines, [
    { label: 'Chess', text: 'University of Glasgow Chess Champion; 2000+ Rapid rating on Chess.com' },
    { label: 'Mathematics', text: 'UKMT Gold Award' },
    { text: 'Duke of Edinburgh Silver Award' },
  ]);
  assert.deepEqual(skills.lines, [{ label: 'Programming/Data', text: 'Python, SQL, Bash' }]);
  assert.equal(L.looksLikeTech('Glasgow, Scotland'), false);
  assert.equal(L.looksLikeTech('Sep 2025 – Jun 2028'), false);
  assert.equal(L.looksLikeTech('Python, WebSockets'), true);
  // It renders as LaTeX that reads back the same.
  const back = cvtex.parse(cvtex.render(cv)).cv;
  assert.deepEqual(back.sections[0].entries, proj.entries);
  assert.deepEqual(back.sections[2].lines, ach.lines);
  assert.deepEqual(back.sections[3].lines, skills.lines);
});

test('letter: tailor() without a master asks for no tech list and for label rows, and tidies the reply', async () => {
  const cvText = [
    'Robin Li',
    'Projects: eBaySpy, eBay deal detector. Python, eBay API, SQLite, Telegram.',
    'Built a bot that flags underpriced eBay listings and sends alerts to Telegram.',
    'Achievements: Chess: University of Glasgow Chess Champion.',
    'Skills: Python, SQL, Bash, pandas, NumPy, Git, Linux, systemd, pytest, WebSockets.',
  ]
    .join('\n')
    .concat('\nBuilt and tested data tools in Python with SQL and pandas.'.repeat(8));
  const { chat, calls } = scripted([
    {
      sections: [
        {
          title: 'Projects',
          entries: [
            {
              heading: 'eBaySpy',
              tagline: 'eBay deal detector',
              subheading: 'Python, eBay API, SQLite, Telegram',
              bullets: ['Built a bot that flags underpriced eBay listings and sends alerts to Telegram.'],
            },
          ],
        },
        { title: 'Achievements', entries: [{ heading: 'Chess: University of Glasgow Chess Champion' }] },
      ],
    },
  ]);
  const result = await L.tailor(chat, { profile, kit, cvText, analysis: { keywords: ['Python'], requirements: [] } });
  assert.match(calls[0].messages[0].content, /don’t list its technologies under or beside its name/);
  assert.doesNotMatch(calls[0].messages[0].content, /"tech"/);
  assert.match(calls[0].messages[0].content, /rows in "lines"/);
  assert.equal(result.cv.sections[0].entries[0].subheading, undefined);
  assert.equal(result.cv.sections[0].entries[0].tagline, 'eBay deal detector');
  assert.deepEqual(result.cv.sections[1].lines, [{ label: 'Chess', text: 'University of Glasgow Chess Champion' }]);
});
