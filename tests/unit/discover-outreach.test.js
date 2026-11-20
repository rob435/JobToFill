'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const JTF = require('./helpers').load();
require('../../extension/lib/letter.js');
require('../../extension/lib/jobpage.js');
require('../../extension/lib/discover.js');
const O = require('../../extension/lib/discover-outreach.js');

const profile = JTF.fields.upgradeProfile({
  personal: { firstName: 'Ada', lastName: 'Lovelace', dob: '2005-05-04' },
  contact: { email: 'ada@example.com', phone: '07700 900123' },
  links: { github: 'https://github.com/ada', linkedin: 'https://www.linkedin.com/in/ada-lovelace/' },
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
  eeo: { gender: 'Female', race: 'White British', disability: 'No' },
});
const kit = { notes: 'Captain of the university chess team.' };
const cvText = 'Ada Lovelace\nDate of birth: 4 May 2005\nUniversity of Leeds, BSc Mathematics\nChess captain.';

const firm = {
  name: 'Acme Capital LLP',
  aliases: [],
  cities: ['London'],
  country: 'GB',
  employees: 40,
  crd: 123456,
  tags: ['hedge'],
  about: 'Acme Capital is a discretionary macro fund that trades government bonds and currencies.',
};
const found = {
  roles: [
    {
      title: 'Quantitative Research Intern (Summer 2027)',
      url: 'https://boards.greenhouse.io/acme/jobs/1',
      location: 'London',
      kind: 'internship',
    },
  ],
  programmes: [
    { text: 'Our 2027 Summer Internship Programme is open to penultimate-year students.', deadline: '2026-11-06' },
  ],
  emails: ['careers@acme.com'],
  texts: [
    {
      url: 'https://acme.com/careers',
      text: 'We hire a handful of interns each summer to work alongside our portfolio managers.',
    },
  ],
};
const jane = { address: 'jane.smith@acme.com', name: 'Jane Smith', title: 'Head of Talent', kind: 'person' };
const mailbox = { address: 'careers@acme.com', name: '', title: '', kind: 'recruiting' };
const today = new Date(2026, 10, 6);

const good = {
  subject: 'Summer internship enquiry, Acme Capital',
  body: [
    'Your careers page says Acme Capital hires a handful of interns each summer to work alongside its portfolio managers. Seeing how a discretionary macro fund trades government bonds and currencies is the part of finance I most want to learn.',
    'I am a second-year Mathematics student at the University of Leeds, graduating in 2027. In summer 2025, as a data intern at Northwind, I cleaned 12,000 customer records in Python and SQL and cut duplicate invoices by 30%. I also captain the university chess team.',
    'Would Acme Capital consider me for a summer internship or an off-cycle placement in 2027? My CV is attached. Thank you for your time.',
  ].join('\n\n'),
};

/** A scripted model: each call returns the next reply (with usage); records what it was asked. */
function scripted(replies) {
  const calls = [];
  const chat = async (messages, opts) => {
    calls.push({ messages: structuredClone(messages), opts });
    const next = replies.shift();
    if (!next) throw new Error('unexpected call');
    return { json: next, usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.001 } };
  };
  return { chat, calls };
}

const failed = (r) => r.checks.filter((c) => !c.ok).map((c) => c.what);
const sha = (s) => require('node:crypto').createHash('sha256').update(s).digest('hex');

test('outreach: without a hook or an ask, draft()’s messages are byte for byte what they were', async () => {
  // Recorded before hooks and asks existed: both calls (the draft, then the fixes after an empty reply), so the
  // system prompt, the user message and every check's feedback are held. A change here is a change to measure.
  const run = async (input) => {
    const seen = [];
    const chat = async (messages) => {
      seen.push(messages.map((m) => m.content).join('\n-----\n'));
      return { json: {} };
    };
    await O.draft(chat, input);
    assert.equal(seen.length, 2);
    return sha(seen.join('\n=====\n'));
  };
  const GB = 'd37db65dc2eddbcbd90d16ac21ee305ce8c9f0f9a4108e0659466c04f68eabda';
  const US = '647d541505ab88c75afea0f4d8bf4bb00a797b17cf295645cdc0ee4c297a992b';
  const us = { ...firm, country: 'US' };
  for (const extra of [{}, { ask: 'internship', hook: null }, { ask: 'anything', hook: {} }]) {
    assert.equal(
      await run({ firm, found, contact: jane, profile, kit, cvText, kind: 'speculative', today, ...extra }),
      GB,
    );
    const role = { firm: us, found, contact: jane, profile, kit, cvText, kind: 'role', today };
    assert.equal(await run({ ...role, instruction: 'mention my chess', ...extra }), US);
  }
});

test('outreach: material() gives the CV and profile, never the disclosures or the date of birth', () => {
  const m = O.material({ profile, kit, cvText });
  assert.match(m.text, /Name: Ada Lovelace/);
  assert.match(m.text, /BSc in Mathematics, University of Leeds/);
  assert.match(m.text, /Cleaned 12,000 customer records/);
  assert.match(m.text, /Captain of the university chess team/);
  assert.match(m.text, /linkedin\.com\/in\/ada-lovelace/);
  assert.match(m.text, /Chess captain/);
  assert.doesNotMatch(m.text, /Female|White British|2005|Date of birth/);
  assert.deepEqual(m.ctx.emails, ['ada@example.com']);
  assert.equal(m.ctx.name, 'Ada Lovelace');
  assert.equal(m.ok, true);
  const long = O.material({ profile, kit, cvText: 'Built a trading simulator in Rust. '.repeat(600) });
  assert.ok(long.text.length <= 7000, `${long.text.length} characters`);
  assert.match(long.text, /Northwind/, 'the profile comes before the CV');
  assert.equal(O.material({ profile: JTF.fields.upgradeProfile({}), kit: {} }).ok, false);
});

test('outreach: Your story comes last in a room of its own, so the CV keeps its room', () => {
  const cv = 'Built a trading simulator in Rust. '.repeat(600);
  const without = O.material({ profile, kit, cvText: cv });
  const story = {
    projects: 'Wrote a deal finder for eBay. '.repeat(400),
    interests: 'Swimming. Date of birth: 4 May 2005',
  };
  const withStory = O.material({ profile: { ...profile, story }, kit, cvText: cv });
  assert.ok(withStory.text.startsWith(without.text), 'the profile and the CV as before');
  assert.match(withStory.text, /\n\nAbout the candidate, in their own words:\nProjects:\nWrote a deal finder/);
  assert.match(withStory.text, /\nOutside work:\nSwimming\./);
  assert.doesNotMatch(withStory.text, /2005|Date of birth/);
  assert.ok(withStory.text.length <= 7000 + 8200, `${withStory.text.length} characters`);
  assert.equal(withStory.ctx.sources, withStory.text, 'the checks accept what the story says');
});

test('outreach: with Your story, the draft and the follow-up are told to pick from it for this firm', async () => {
  const told = { ...profile, story: { ...profile.story, projects: 'A deal finder for eBay: 0.97 precision.' } };
  const system = async (p) => {
    const { chat, calls } = scripted([good]);
    await O.draft(chat, { firm, found, contact: jane, profile: p, kit, cvText, kind: 'speculative', today });
    return calls[0].messages[0].content;
  };
  const pick =
    /^ {3}Pick those things for this firm: go through the part of CANDIDATE MATERIAL headed “About the candidate, in their own words”[^\n]*never eager or pleading\.$/m;
  assert.doesNotMatch(await system(profile), pick);
  const withStory = await system(told);
  assert.match(withStory, pick);
  assert.equal(withStory.replace(/\n {3}Pick those things[^\n]*/, ''), await system(profile), 'only that line is new');
  const follow = [];
  const chat = async (messages) => {
    follow.push(messages[0].content);
    return { json: {} };
  };
  const rec = {
    firm,
    subject: 'Summer internship enquiry',
    sentAt: today - 7 * 864e5,
    body: 'Dear Jane,\n\nHello.',
    ask: 'internship',
  };
  await O.followUp(chat, { rec, contact: jane, profile: told, kit, cvText, today });
  assert.match(
    follow[0],
    /^ {3}Look for it first in the part of CANDIDATE MATERIAL headed “About the candidate, in their own words”/m,
  );
});

test('outreach: firmFacts() lists what the firm does, its roles, programmes, pages and the contact', () => {
  const f = O.firmFacts({ firm, found, contact: jane });
  assert.match(f.text, /^Firm: Acme Capital LLP\nAlso called: Acme Capital/);
  assert.match(f.text, /What it does: Acme Capital is a discretionary macro fund/);
  assert.match(f.text, /Kind of firm: Hedge funds/);
  assert.match(f.text, /Based in: London, United Kingdom/);
  assert.match(f.text, /Staff: about 40/);
  assert.match(f.text, /registered with the SEC/);
  assert.match(f.text, /- Quantitative Research Intern \(Summer 2027\) \(London\)/);
  assert.match(
    f.text,
    /“Our 2027 Summer Internship Programme is open to penultimate-year students\.” \(deadline 6 November 2026\)/,
  );
  assert.match(f.text, /We hire a handful of interns/);
  assert.match(f.text, /Writing to: Jane Smith, Head of Talent$/);
  for (const n of ['Acme Capital LLP', 'Acme Capital', 'Jane Smith', 'Quantitative Research Intern (Summer 2027)'])
    assert.ok(f.names.includes(n), n);
  assert.ok(f.names.includes('2027 Summer Internship Programme'));
  assert.ok(f.names.includes('London') && f.names.includes('United Kingdom'));
  assert.ok(f.numbers.includes('2027') && f.numbers.includes('40'));
  assert.match(O.firmFacts({ firm, found: {}, contact: mailbox }).text, /Writing to: the recruiting mailbox/);
  // A programme the page describes without a date (HBK's "Summer Intern Experience") is a fact to lean on too.
  const described = {
    mentions: [{ text: 'We annually offer a range of internship programmes across our teams.', kind: 'internship' }],
  };
  assert.match(
    O.firmFacts({ firm, found: described }).text,
    /From its careers pages:\n- “We annually offer a range of internship programmes across our teams\.”/,
  );
  const wordy = { texts: [1, 2, 3].map((i) => ({ url: `https://acme.com/${i}`, text: 'word '.repeat(400) })) };
  const pages = O.firmFacts({ firm, found: wordy }).text.split('Text of its careers pages:\n')[1];
  assert.ok(pages.replace(/https:\/\/acme\.com\/\d\n/g, '').length <= 1500 + 10, 'page text is clipped in all');
});

test('outreach: a good draft passes every check, with the greeting, sign-off and contact line around it', async () => {
  const { chat, calls } = scripted([good]);
  const r = await O.draft(chat, { firm, found, contact: jane, profile, kit, cvText, kind: 'speculative', today });
  assert.deepEqual(failed(r), []);
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 1);
  assert.equal(r.kind, 'speculative');
  assert.equal(r.greeting, 'Dear Jane,');
  assert.equal(r.signature, 'Kind regards,\nAda Lovelace\n07700 900123 | ada@example.com | github.com/ada');
  assert.equal(r.subject, 'Summer internship enquiry, Acme Capital');
  assert.ok(r.body.startsWith('Dear Jane,\n\nYour careers page says Acme Capital'));
  assert.ok(r.body.endsWith('\n\nKind regards,\nAda Lovelace\n07700 900123 | ada@example.com | github.com/ada'));
  assert.ok(r.checks.length >= 10);
  assert.deepEqual(r.usage, { tokens: 150, cost: 0.001 });
  const [system, user] = calls[0].messages;
  assert.match(system.content, /British English/);
  assert.match(system.content, /“Dear Jane,” goes above the body/);
  assert.match(user.content, /TODAY: 6 November 2026/);
  assert.match(user.content, /FIRM FACTS:\nFirm: Acme Capital LLP/);
  assert.doesNotMatch(user.content, /Female|White British|2005|Date of birth/, 'nothing withheld reaches the model');
  assert.equal(calls[0].opts.json, true);
});

test('outreach: an invented number and a placeholder fail, go back once, and the fixed draft wins', async () => {
  const bad = {
    subject: good.subject,
    body: good.body.replace(
      'I also captain the university chess team.',
      'At Northwind I also processed 50,000 trades. I study at [Your University].',
    ),
  };
  const { chat, calls } = scripted([bad, good]);
  const r = await O.draft(chat, { firm, found, contact: jane, profile, kit, cvText, today });
  assert.equal(calls.length, 2);
  const fix = calls[1].messages.at(-1);
  assert.equal(fix.role, 'user');
  assert.match(fix.content, /^Fix these problems/);
  assert.match(fix.content, /50,000/);
  assert.match(fix.content, /placeholder “\[Your University\]”/);
  assert.equal(calls[1].messages.at(-2).role, 'assistant');
  assert.equal(r.attempts, 2);
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.body, /50,000/);
  assert.deepEqual(r.usage, { tokens: 300, cost: 0.002 });

  // Both attempts bad: the less wrong one is returned, its failures listed.
  const worse = { subject: 'Hello', body: bad.body };
  const twice = scripted([worse, bad]);
  const r2 = await O.draft(twice.chat, { firm, found, contact: jane, profile, kit, cvText, today });
  assert.equal(r2.ok, false);
  assert.equal(r2.subject, good.subject, 'the attempt with fewer failures wins');
  assert.ok(failed(r2).some((w) => /50,000/.test(w)));
});

test('outreach: names, stock phrases, other people’s addresses and markdown are caught', async () => {
  const sloppy = {
    subject: '**Internship**',
    body: [
      'Dear Sir or Madam,',
      'I have long admired Acme Capital, a prestigious firm. Like my friend at Goldman Sachs, I want to join.',
      '- I cleaned 12,000 customer records at Northwind.',
      'Please reply to jane.smith@acme.com or call 020 7946 0000. Thank you for your time.',
    ].join('\n\n'),
  };
  const { chat } = scripted([sloppy, sloppy]);
  const r = await O.draft(chat, { firm, found, contact: jane, profile, kit, cvText, today });
  const all = failed(r).join('\n');
  assert.match(all, /long admired/);
  assert.match(all, /prestigious/);
  assert.match(all, /names aren’t in .*Goldman Sachs/);
  assert.match(all, /“jane\.smith@acme\.com”/);
  assert.match(all, /“020 7946 0000”/);
  assert.match(all, /No markdown/);
  assert.match(all, /subject/i);
  assert.ok(r.body.startsWith('Dear Jane,\n\nI have long admired'), 'the model’s own greeting is replaced');
});

test('outreach: a recruiting mailbox is greeted by the firm, anyone else with “Hello,”', async () => {
  const { chat, calls } = scripted([good]);
  const r = await O.draft(chat, { firm, found, contact: mailbox, profile, kit, cvText, today });
  assert.equal(r.greeting, 'Dear Acme Capital recruiting team,');
  assert.ok(r.body.startsWith('Dear Acme Capital recruiting team,\n\n'));
  assert.equal(r.ok, true);
  assert.match(calls[0].messages[0].content, /“Dear Acme Capital recruiting team,” goes above/);
  const general = await O.draft(scripted([good]).chat, {
    firm,
    found,
    contact: { address: 'info@acme.com', kind: 'general' },
    profile,
    kit,
    cvText,
    today,
  });
  assert.equal(general.greeting, 'Hello,');
  const doctor = await O.draft(scripted([good]).chat, {
    firm,
    found,
    contact: { name: 'Dr JANE SMITH', kind: 'person' },
    profile,
    kit: { ...kit, closing: 'Best wishes' },
    cvText,
    today,
  });
  assert.equal(doctor.greeting, 'Dear Jane,');
  assert.match(doctor.signature, /^Best wishes,\nAda Lovelace/);
});

test('outreach: a role email must name the role', async () => {
  const named = {
    subject: 'Quantitative Research Intern, Acme Capital',
    body: good.body.replace(
      'Would Acme Capital consider me for a summer internship or an off-cycle placement in 2027?',
      'I would like to be considered for the Quantitative Research Intern role at Acme Capital for summer 2027.',
    ),
  };
  const { chat, calls } = scripted([good, named]);
  const r = await O.draft(chat, { firm, found, contact: jane, profile, kit, cvText, kind: 'role', today });
  assert.equal(r.kind, 'role');
  assert.match(calls[0].messages[0].content, /ask to be considered for “Quantitative Research Intern \(Summer 2027\)”/);
  assert.match(calls[1].messages.at(-1).content, /Name the role you’re asking about/);
  assert.equal(r.attempts, 2);
  assert.equal(r.ok, true);
  assert.match(r.body, /Quantitative Research Intern role/);
  // Without a role or programme to point at, it is a speculative email.
  const none = await O.draft(scripted([good]).chat, {
    firm,
    found: {},
    contact: jane,
    profile,
    kit,
    cvText,
    kind: 'role',
    today,
  });
  assert.equal(none.kind, 'speculative');
  // A programme sentence gives the name to use.
  const prog = scripted([good]);
  await O.draft(prog.chat, {
    firm,
    found: { programmes: found.programmes },
    contact: jane,
    profile,
    kit,
    cvText,
    kind: 'role',
    today,
  });
  assert.match(prog.calls[0].messages[0].content, /considered for “2027 Summer Internship Programme”/);
});

test('outreach: a role email asks about the role the page shows, a Hacker News post’s too', async () => {
  const hn = { month: 'November 2026', roles: [{ title: 'Founding Engineer Intern', kind: 'internship' }, 'Backend'] };
  const asked = {
    subject: 'Founding Engineer Intern, Acme Capital',
    body: good.body.replace(
      'Would Acme Capital consider me for a summer internship or an off-cycle placement in 2027?',
      'I would like to be considered for the Founding Engineer Intern role at Acme Capital.',
    ),
  };
  // Only the Hacker News post lists a role: the email is about it, not a speculative one.
  const only = scripted([asked]);
  const r = await O.draft(only.chat, { firm, found: { hn }, contact: jane, profile, kit, cvText, kind: 'role', today });
  assert.equal(r.kind, 'role');
  assert.deepEqual(failed(r), []);
  assert.match(only.calls[0].messages[0].content, /considered for “Founding Engineer Intern”/);
  assert.match(
    only.calls[0].messages[1].content,
    /Roles in its Hacker News “Who is hiring” post \(November 2026\):\n- Founding Engineer Intern\n- Backend\n/,
  );

  // A careers-page programme and one the AI read: the email asks about the one the page shows, not the first found.
  const programmes = [
    found.programmes[0],
    { name: 'Spring Insight Week', quote: 'Our Spring Insight Week runs every April for first-year students.' },
  ];
  const both = scripted([good, good]);
  const r2 = await O.draft(both.chat, {
    firm,
    found: { programmes, hn },
    contact: jane,
    profile,
    kit,
    cvText,
    kind: 'role',
    role: 'Spring Insight Week',
    today,
  });
  assert.match(both.calls[0].messages[0].content, /considered for “Spring Insight Week”/);
  assert.ok(
    failed(r2).some((w) => /Name the role you’re asking about as the firm writes it: “Spring Insight Week”/.test(w)),
  );

  // The page's clipped programme sentence is asked about by the programme's name.
  const clipped = scripted([good, good]);
  await O.draft(clipped.chat, {
    firm,
    found: { programmes },
    contact: jane,
    profile,
    kit,
    cvText,
    kind: 'role',
    role: 'Our 2027 Summer Internship Programme is open to penultimate-yea…',
    today,
  });
  assert.match(clipped.calls[0].messages[0].content, /considered for “2027 Summer Internship Programme”/);

  // A role the lists don't name as written still reaches the firm facts, so the name check takes it.
  const f = O.firmFacts({ firm, found: {}, role: 'Trading Intern' });
  assert.match(f.text, /\n\nThe email asks about: Trading Intern$/m);
  assert.ok(f.names.includes('Trading Intern'));
  assert.doesNotMatch(O.firmFacts({ firm, found, role: found.roles[0].title }).text, /asks about/);
});

test('outreach: British spelling for a UK or Irish firm, American for a US one, else the setting', async () => {
  const lang = async (country, k = kit) => {
    const { chat, calls } = scripted([good]);
    const r = await O.draft(chat, { firm: { ...firm, country }, found, contact: jane, profile, kit: k, cvText, today });
    return [r.lang, /American English/.test(calls[0].messages[0].content) ? 'American' : 'British'];
  };
  assert.deepEqual(await lang('US'), ['en-US', 'American']);
  assert.deepEqual(await lang('GB'), ['en-GB', 'British']);
  assert.deepEqual(await lang('IE', { ...kit, spelling: 'en-US' }), ['en-GB', 'British']);
  assert.deepEqual(await lang('SG', { ...kit, spelling: 'en-US' }), ['en-US', 'American']);
  assert.deepEqual(await lang('SG', { ...kit, spelling: 'auto' }), ['en-GB', 'British']);
});

test('outreach: mailto() encodes with CRLF line breaks and shortens a long body at a paragraph', () => {
  const short = O.mailto({
    to: 'jane.smith@acme.com',
    subject: 'Internship enquiry & CV',
    body: 'Dear Jane,\n\nOne.\nTwo.',
  });
  assert.equal(
    short.href,
    'mailto:jane.smith@acme.com?subject=Internship%20enquiry%20%26%20CV&body=Dear%20Jane%2C%0D%0A%0D%0AOne.%0D%0ATwo.',
  );
  assert.equal(short.truncated, false);
  const paragraphs = [1, 2, 3, 4, 5, 6].map((i) => `Paragraph ${i}: ${'lorem '.repeat(60).trim()}.`);
  const long = O.mailto({ to: 'careers@acme.com', subject: 'Enquiry', body: paragraphs.join('\n\n') });
  assert.equal(long.truncated, true);
  assert.ok(long.href.length <= 1900, `${long.href.length} characters`);
  const body = decodeURIComponent(long.href.split('&body=')[1]);
  assert.ok(body.startsWith(`${paragraphs[0]}\r\n\r\n`));
  assert.ok(body.endsWith('\r\n\r\n[Email shortened — paste the rest from JobToFill]'));
  assert.doesNotMatch(body, /Paragraph 6/);
  const one = O.mailto({ to: 'a@b.com', subject: 'x', body: 'word '.repeat(800) });
  assert.ok(one.truncated && one.href.length <= 1900);
});

const page = [
  'Careers at Acme Capital',
  'We hire a handful of interns each summer. Our 2027 Summer Internship Programme is open to penultimate-year students studying a quantitative subject.',
  'To apply, send your CV and a short cover note to careers [at] acme [dot] com by Friday 6th November.',
  'For questions, contact Jane   Smith, Head of Talent (jane.smith@acme.com).',
].join('\n');
const reading = () => ({
  howToApply: 'Send your CV and a short cover note to careers@acme.com by Friday 6th November.',
  emails: ['careers@acme.com', 'internships@acme.com', 'not an address'],
  contacts: [
    { name: 'Jane Smith', title: 'Head of Talent', email: 'jane.smith@acme.com' },
    { name: 'John Doe', title: 'Recruiter', email: 'john.doe@acme.com' },
  ],
  programmes: [
    {
      name: '2027 Summer Internship Programme',
      quote: 'To apply, send your CV and a short cover note to careers [at] acme [dot] com by Friday 6th November.',
      deadline: '2026-11-05',
      eligibility: 'penultimate-year students studying a quantitative subject',
    },
    {
      name: 'Spring Week',
      quote: 'Our Spring Week runs every April for first-year students.',
      deadline: '2027-04-01',
      eligibility: '',
    },
  ],
  notes: 'Acme pays interns £5,000 a month and offers visa sponsorship.',
});

test('outreach: readPage() keeps what the page says and drops what it doesn’t', async () => {
  const { chat, calls } = scripted([reading()]);
  const now = new Date(2026, 9, 3).getTime();
  const r = await O.readPage(chat, { firm, url: 'https://acme.com/careers', text: page, now });
  assert.match(calls[0].messages[1].content, /Firm: Acme Capital LLP\nAddress: https:\/\/acme\.com\/careers/);
  assert.match(calls[0].messages[1].content, /Page:\nCareers at Acme Capital/);
  assert.deepEqual(r.emails, ['careers@acme.com'], 'the address spelt out with [at] and [dot] counts');
  assert.deepEqual(r.contacts, [{ name: 'Jane Smith', title: 'Head of Talent', email: 'jane.smith@acme.com' }]);
  assert.equal(r.programmes.length, 1);
  assert.equal(r.programmes[0].deadline, '2026-11-06', 'worked out from the quote, not the model');
  assert.equal(r.programmes[0].name, '2027 Summer Internship Programme');
  assert.equal(r.programmes[0].eligibility, 'penultimate-year students studying a quantitative subject');
  assert.match(r.howToApply, /^Send your CV/);
  assert.equal(r.notes, '');
  const why = Object.fromEntries(r.dropped.map((d) => [d.what, d.why]));
  assert.equal(why['internships@acme.com'], 'not on the page');
  assert.equal(why['not an address'], 'not an email address');
  assert.equal(why['John Doe'], 'name not on the page');
  assert.equal(why['deadline 2026-11-05'], 'the quote says 2026-11-06');
  assert.equal(why['Our Spring Week runs every April for first-year students.'], 'not quoted from the page');
  assert.ok(r.dropped.some((d) => /^notes:/.test(d.what)));
  assert.deepEqual(r.usage, { tokens: 150, cost: 0.001 });
});

test('outreach: readPage() drops an invented address in its prose and a contact’s address not on the page', async () => {
  const j = reading();
  j.howToApply = 'Send your CV to internships@acme.com by Friday 6th November.';
  j.contacts = [{ name: 'jane smith', title: 'Talent Partner', email: 'jsmith@acme.com' }];
  j.programmes = [];
  const r = await O.readPage(scripted([j]).chat, { firm, text: page, now: new Date(2026, 9, 3).getTime() });
  assert.equal(r.howToApply, '');
  assert.deepEqual(r.contacts, [{ name: 'jane smith', title: '', email: '' }]);
  assert.ok(r.dropped.some((d) => d.what === 'jane smith’s address jsmith@acme.com'));
});

test('outreach: without discover.js a deadline stands only when its day and month are on the page', async () => {
  const saved = JTF.discover;
  delete JTF.discover;
  try {
    const j = reading();
    j.programmes = [
      { name: 'Summer', quote: 'Our 2027 Summer Internship Programme is open', deadline: '2026-11-06' },
      { name: 'Summer', quote: 'We hire a handful of interns each summer.', deadline: '2026-12-25' },
    ];
    const r = await O.readPage(scripted([j]).chat, { firm, text: page, now: new Date(2026, 9, 3).getTime() });
    assert.deepEqual(
      r.programmes.map((p) => p.deadline),
      ['2026-11-06', null],
    );
  } finally {
    JTF.discover = saved;
  }
});

test('outreach: readPage() drops prose and programme names with a number or date the page doesn’t give', async () => {
  const now = new Date(2026, 9, 3).getTime();
  const j = reading();
  j.howToApply = 'Send your CV and a short cover note to careers@acme.com by 30 November 2026.';
  j.notes = 'Interns start in June each summer.';
  j.contacts = [];
  j.programmes = [
    {
      name: '2028 Summer Internship Programme',
      quote:
        'Our 2027 Summer Internship Programme is open to penultimate-year students studying a quantitative subject.',
      deadline: null,
      eligibility: 'penultimate-year students graduating in 2028',
    },
  ];
  const r = await O.readPage(scripted([j]).chat, { firm, text: page, now });
  assert.equal(r.howToApply, '');
  assert.equal(r.notes, '');
  assert.equal(r.programmes[0].name, '2027 Summer Internship Programme', 'the name from the verified quote');
  assert.equal(r.programmes[0].eligibility, '');
  const why = Object.fromEntries(r.dropped.map((d) => [d.what.replace(/:.*/, ''), d.why]));
  assert.equal(why['how to apply'], 'gives 30 November, 2026, which aren’t on the page');
  assert.equal(why.notes, 'gives June, which isn’t on the page');
  assert.equal(why['programme name “2028 Summer Internship Programme”'], 'gives 2028, which isn’t on the page');
  assert.equal(why.eligibility, 'gives 2028, which isn’t on the page');

  // The page's own date in other words stands, and so does a month that's only a verb ("may").
  const k = reading();
  k.howToApply = 'Send your CV and a short cover note to careers@acme.com by Friday, November 6.';
  k.notes = 'Penultimate-year students may apply to the 2027 Summer Internship Programme.';
  const kept = await O.readPage(scripted([k]).chat, { firm, text: page, now });
  assert.equal(kept.howToApply, k.howToApply);
  assert.equal(kept.notes, k.notes);
});

test('outreach: readPage() pairs a name with a title or address beside it, or an address made from it', async () => {
  const filler =
    'We hire a handful of interns each summer to work alongside our portfolio managers, who run a discretionary ' +
    'macro book in government bonds and currencies from our London office. Interns sit with a trader from the ' +
    'first day and present a trade idea to the investment committee at the end of the summer.';
  const team = [
    'Careers at Acme Capital',
    'For questions about internships, contact Jane Smith, Head of Talent, or Zoë Müller, Campus Recruiter.',
    filler,
    'Press enquiries: John Doe, Communications (john.doe@acme.com). Our recruiter, Priya Patel, reads every CV: write to recruiting@acme.com.',
    filler,
    'Contact: zmuller@acme.com, info@acme.com',
  ].join('\n');
  const j = reading();
  j.contacts = [
    { name: 'Jane Smith', title: 'Head of Talent', email: 'john.doe@acme.com' },
    { name: 'Zoë Müller', title: 'Campus Recruiter', email: 'zmuller@acme.com' },
    { name: 'Priya Patel', title: 'Head of Talent', email: 'recruiting@acme.com' },
  ];
  j.programmes = [];
  const r = await O.readPage(scripted([j]).chat, { firm, text: team, now: new Date(2026, 9, 3).getTime() });
  assert.deepEqual(r.contacts, [
    { name: 'Jane Smith', title: 'Head of Talent', email: '' },
    { name: 'Zoë Müller', title: 'Campus Recruiter', email: 'zmuller@acme.com' },
    { name: 'Priya Patel', title: '', email: 'recruiting@acme.com' },
  ]);
  const why = Object.fromEntries(r.dropped.map((d) => [d.what, d.why]));
  assert.equal(
    why['Jane Smith’s address john.doe@acme.com'],
    'on the page, but neither beside the name nor made from it',
  );
  assert.equal(why['Priya Patel’s title “Head of Talent”'], 'on the page, but not beside the name');
});

/* ------------------------------------------------------------- hooks and asks */

// A hook as discoverHooks.find() keeps one: checked against its source there, the quote the source's own words.
const leeds = {
  kind: 'common',
  about: 'Jane Smith',
  shared: 'University of Leeds',
  url: 'https://acme.com/team/jane-smith',
  quote: 'Jane Smith joined Acme Capital in 2019 after a BSc in Mathematics at the University of Leeds.',
  source: 'acme.com',
  label: 'Common ground: University of Leeds',
};
const [, brings, asks] = good.body.split('\n\n');
const hooked = {
  subject: good.subject,
  body: [
    'I saw that you also studied Mathematics at the University of Leeds before joining Acme Capital in 2019. I am in my second year of the same degree there, and I want to learn how a discretionary macro fund trades government bonds and currencies.',
    brings.replace('I am a second-year Mathematics student at the University of Leeds, graduating in 2027. ', ''),
    asks,
  ].join('\n\n'),
};
/** `fn` with JTF.discoverHooks set to `hooks` (or gone), as it was afterwards. */
async function withHooks(hooks, fn) {
  const saved = JTF.discoverHooks;
  if (hooks) JTF.discoverHooks = hooks;
  else delete JTF.discoverHooks;
  try {
    return await fn();
  } finally {
    if (saved) JTF.discoverHooks = saved;
    else delete JTF.discoverHooks;
  }
}

test('outreach: a hook opens the email, and its quote’s names and numbers count as the firm’s', async () => {
  await withHooks(null, async () => {
    const { chat, calls } = scripted([hooked]);
    const r = await O.draft(chat, { firm, found, contact: jane, profile, kit, cvText, hook: leeds, today });
    assert.deepEqual(failed(r), []);
    assert.equal(r.ok, true);
    assert.equal(r.hook, leeds);
    assert.equal(r.ask, 'internship');
    assert.ok(r.checks.some((c) => c.what === 'Opens with the reason to write'));
    const [system, user] = calls[0].messages;
    assert.match(system.content, /^1\. Why you’re writing: open with the reason to write in FIRM FACTS, .*own voice/m);
    assert.match(system.content, /never claiming more than its quote says/);
    assert.match(system.content, /Mention common ground once, lightly\./);
    assert.doesNotMatch(system.content, /1\. Why this firm/);
    assert.match(
      user.content,
      /\nWriting to: Jane Smith, Head of Talent\n\nReason to write \(checked; open with it\):\nReason to write, found on acme\.com: “Jane Smith joined Acme Capital in 2019 after a BSc in Mathematics at the University of Leeds\.” The candidate and Jane Smith share University of Leeds\.\nAbout: Jane Smith \(the person you’re writing to\)\n\nCANDIDATE MATERIAL:/,
    );
  });

  // Without the hook, 2019 is a number nobody gave.
  const bare = await O.draft(scripted([hooked, hooked]).chat, {
    firm,
    found,
    contact: jane,
    profile,
    kit,
    cvText,
    today,
  });
  assert.equal(bare.hook, null);
  assert.ok(failed(bare).some((w) => /numbers aren’t in .*: 2019$/.test(w)));

  // A draft that ignores the hook goes back once with it quoted, and the one that opens with it wins.
  const { chat, calls } = scripted([good, hooked]);
  const r = await O.draft(chat, { firm, found, contact: jane, profile, kit, cvText, hook: leeds, today });
  assert.match(
    calls[1].messages.at(-1).content,
    /^- Open with the reason to write from FIRM FACTS, .*“Jane Smith joined/m,
  );
  assert.equal(r.attempts, 2);
  assert.equal(r.ok, true);
  assert.match(r.body, /^Dear Jane,\n\nI saw that you also studied Mathematics/);
});

test('outreach: the hook’s line is discoverHooks.factLine()’s when that is loaded, else the same line made here', async () => {
  const work = {
    kind: 'work',
    about: 'Acme Capital',
    date: '2026-09',
    url: 'https://www.acme.com/news/fx-desk',
    quote: 'In September 2026 Acme Capital opened a systematic FX desk in its London office.',
    label: 'Their work, September 2026',
  };
  await withHooks(null, () => {
    const f = O.firmFacts({ firm, found: {}, contact: jane, hook: work });
    assert.match(
      f.text,
      /\n\nReason to write \(checked; open with it\):\nReason to write, found on acme\.com \(September 2026\): “In September 2026 Acme Capital opened a systematic FX desk in its London office\.”\nAbout: Acme Capital \(the firm, not the person you’re writing to\)$/,
    );
    assert.doesNotMatch(f.text, /share/);
    assert.ok(f.numbers.includes('2026'));
    assert.doesNotMatch(O.firmFacts({ firm, found: {}, hook: { kind: 'work', quote: '' } }).text, /Reason to write/);
  });
  await withHooks({ factLine: (h) => `From discoverHooks: ${h.label}` }, () => {
    assert.match(
      O.firmFacts({ firm, hook: work }).text,
      /open with it\):\nFrom discoverHooks: Their work, September 2026\nAbout: Acme Capital \(the firm, not the person you’re writing to\)$/,
    );
  });
});

const call = {
  subject: 'A 15-minute call about internships at Acme Capital',
  body: good.body.replace(
    asks,
    'Could we have a 15-minute call, so I can hear how Acme Capital takes on students? My CV is attached for context. Thank you for your time.',
  ),
};
const project = {
  subject: 'A short trial project for Acme Capital',
  body: good.body.replace(
    asks,
    'If there is something your team has not had time for, I would gladly do it as a short, unpaid trial task within 14 days, so you can see my work first. Would Acme Capital then consider me for an internship? My CV is attached. Thank you for your time.',
  ),
};

test('outreach: the ask can be a 15-minute call or a short trial project, its own numbers accepted for it only', async () => {
  const run = async (ask, reply, more = {}) => {
    const { chat, calls } = scripted([reply, reply]);
    const r = await O.draft(chat, { firm, found, contact: jane, profile, kit, cvText, ask, today, ...more });
    return { r, system: calls[0].messages[0].content };
  };
  const byCall = await run('call', call);
  assert.deepEqual(failed(byCall.r), []);
  assert.equal(byCall.r.ask, 'call');
  assert.match(byCall.system, /^3\. The ask: ask for a 15-minute call to hear how Acme Capital takes on students: /m);
  assert.match(byCall.system, /Say the CV is attached for context/);
  assert.match(byCall.system, /e\.g\. “A 15-minute call about internships at Acme Capital”\./);

  const byProject = await run('project', project);
  assert.deepEqual(failed(byProject.r), []);
  assert.equal(byProject.r.ask, 'project');
  assert.match(
    byProject.system,
    /^3\. The ask: offer to do a short, unpaid trial task on something the team hasn’t had/m,
  );
  assert.match(byProject.system, /done within a fortnight/);
  assert.match(byProject.system, /Then ask whether Acme Capital would consider the candidate for an internship\./);
  assert.match(byProject.system, /e\.g\. “A short trial project for Acme Capital”\./);

  // The ask's numbers are its own: a 15 asking about internships, or a 14 in a call, is invented.
  assert.ok(failed((await run('internship', call)).r).some((w) => /numbers aren’t in .*: 15$/.test(w)));
  assert.ok(failed((await run('call', project)).r).some((w) => /numbers aren’t in .*: 14$/.test(w)));

  // About a role, the call and the project still name it.
  const role = await run('call', call, { kind: 'role' });
  assert.match(role.system, /and about “Quantitative Research Intern \(Summer 2027\)” \(name it as written\)/);
  assert.match(role.system, /e\.g\. “A 15-minute call about Quantitative Research Intern \(Summer 2027\)”/);
  const trial = await run('project', project, { kind: 'role' });
  assert.match(trial.system, /consider the candidate for “Quantitative Research Intern \(Summer 2027\)” \(name it as/);
});

// The firm's own hook, about the firm (as discoverHooks.find() gives it: the registered name).
const fund = {
  kind: 'work',
  about: 'Acme Capital LLP',
  date: '2026-09',
  url: 'https://acme.com/news/credit',
  source: 'acme.com',
  quote: 'Acme Capital launched its first European credit fund in September 2026, run by a new team in London.',
};
/** Draft a three-paragraph email with this opening (twice: the fix gets the same reply) → the result. */
const opening = (first, input) => {
  const reply = { subject: good.subject, body: [first, brings, asks].join('\n\n') };
  return O.draft(scripted([reply, reply]).chat, { firm, found, contact: jane, profile, kit, cvText, today, ...input });
};

test('outreach: an opening that gives only the firm’s own facts doesn’t take up the hook', async () => {
  const opens = async (hook, first) =>
    (await opening(first, { hook })).checks.find((c) => /reason to write/.test(c.what)).what;
  // "fund" and "London" are in the quote, but FIRM FACTS said them already.
  const city =
    'Acme Capital is a discretionary macro fund in London that trades government bonds and currencies. Seeing how such a fund works is the part of finance I most want to learn.';
  const lse = {
    kind: 'common',
    about: 'Jane Smith',
    shared: 'London School of Economics',
    url: 'https://acme.com/team/jane-smith',
    source: 'acme.com',
    quote: 'Jane Smith studied Economics at the London School of Economics before joining Acme Capital.',
  };
  for (const hook of [fund, lse])
    assert.match(await opens(hook, city), /^Open with the reason to write from FIRM FACTS/);
  assert.equal(
    await opens(
      fund,
      'I read that Acme Capital launched its first European credit fund in September 2026. Credit is the part of finance I most want to learn.',
    ),
    'Opens with the reason to write',
  );
  assert.equal(
    await opens(
      lse,
      'I saw that you also went to the London School of Economics. Economics is the part of my degree I most enjoy.',
    ),
    'Opens with the reason to write',
  );
});

test('outreach: a hook about someone else says whose it is, and never gives it to the reader', async () => {
  const bob = {
    kind: 'common',
    about: 'Bob Jones',
    shared: 'University of Leeds',
    url: 'https://acme.com/team/bob-jones',
    source: 'acme.com',
    quote: 'Bob Jones joined Acme Capital in 2019 after a BSc in Mathematics at the University of Leeds.',
  };
  const piece = {
    kind: 'work',
    about: 'Bob Jones',
    date: '2026-09',
    url: 'https://bobjones.substack.com/p/rates',
    source: 'bobjones.substack.com',
    quote: 'We think short-dated gilt yields will fall faster than the market expects.',
  };
  // FIRM FACTS says whom it is about, factLine() or not: a work hook's quote needn't.
  for (const hooks of [null, { factLine: () => 'Reason to write, found on bobjones.substack.com: “…”' }])
    await withHooks(hooks, () => {
      assert.match(
        O.firmFacts({ firm, contact: jane, hook: piece }).text,
        /\nAbout: Bob Jones \(someone else at the firm, not the person you’re writing to\)$/,
      );
      assert.match(
        O.firmFacts({ firm, contact: jane, hook: leeds }).text,
        /\nAbout: Jane Smith \(the person you’re writing to\)$/,
      );
      assert.match(O.firmFacts({ firm, contact: jane, hook: fund }).text, /\nAbout: Acme Capital \(the firm, not/);
      const short = { ...fund, about: 'Acme' };
      assert.match(O.firmFacts({ firm, contact: jane, hook: short }).text, /\nAbout: Acme \(the firm, not/);
      assert.match(O.firmFacts({ firm, contact: mailbox, hook: leeds }).text, /\nAbout: Jane Smith \(someone else at/);
    });
  const whose = (r) => r.checks.find((c) => /whose it is/.test(c.what));
  const studied =
    'also studied Mathematics at the University of Leeds before joining Acme Capital in 2019. I am in my second year of the same degree there.';
  // Bob's university given to Jane, and the firm's fund given to her as her piece: false, so severe.
  const mine = await opening(`I saw that you ${studied}`, { hook: bob });
  assert.equal(mine.ok, false);
  assert.match(
    whose(mine).what,
    /^Say whose it is: the reason to write is about Bob Jones, not the person you’re writing to; name them/,
  );
  const hers = await opening(
    'I read your piece on launching Acme Capital’s first European credit fund in September 2026. Credit is the part of finance I most want to learn.',
    { hook: fund },
  );
  assert.match(whose(hers).what, /^Say whose it is: the reason to write is about Acme Capital, .*; name the firm/);
  // Named, it stands; a hook about the reader needs no such check.
  const named = await opening(`I saw that your colleague Bob Jones ${studied}`, { hook: bob });
  assert.equal(whose(named).what, 'Says whose it is: Bob Jones');
  assert.deepEqual(failed(named), []);
  assert.equal(whose(await opening(hooked.body.split('\n\n')[0], { hook: leeds })), undefined);
  const { chat, calls } = scripted([hooked, hooked]);
  await O.draft(chat, { firm, found, contact: jane, profile, kit, cvText, hook: bob, today });
  assert.match(
    calls[0].messages[0].content,
    /\(FIRM FACTS says whom it is about\), say who, and don’t write “you” or “your” for it\./,
  );
  assert.match(calls[0].messages[0].content, /The quote is about them, never about the candidate/);
});

test('outreach: a hook’s names and numbers stand in the opening, never in what the email says about the candidate', async () => {
  const imperial = {
    ...leeds,
    quote:
      'Jane Smith studied Mathematics at the University of Leeds and took her MSc at Imperial College London in 2019.',
  };
  const first =
    'I saw that you also studied Mathematics at the University of Leeds before your MSc at Imperial College London in 2019. I am in my second year of the same degree there.';
  const reply = (p2) => ({ subject: good.subject, body: [first, p2, asks].join('\n\n') });
  const run = (p2) =>
    O.draft(scripted([reply(p2), reply(p2)]).chat, {
      firm,
      found,
      contact: jane,
      profile,
      kit,
      cvText,
      hook: imperial,
      today,
    });
  const leak = await run(
    'I am a second-year Mathematics student at the University of Leeds and have an offer for an MSc at Imperial College London in 2019. At Northwind I cleaned 12,000 customer records in Python and SQL.',
  );
  const all = failed(leak).join('\n');
  assert.match(all, /numbers aren’t in .*: 2019$/m);
  assert.match(all, /names aren’t in .*: Imperial College London$/m);
  assert.deepEqual(failed(await run(brings)), [], 'in the opening, the quote’s 2019 and Imperial stand');
});

test('outreach: an ask’s own numbers pass only in the phrase that brings them', async () => {
  const run = async (ask, reply) =>
    failed(
      await O.draft(scripted([reply, reply]).chat, { firm, found, contact: jane, profile, kit, cvText, ask, today }),
    );
  const add = (reply, sentence) => ({
    ...reply,
    body: reply.body.replace('I also captain the university chess team.', sentence),
  });
  assert.ok(
    (await run('call', add(call, 'I also led a team of 15 in the university chess league.'))).some((w) =>
      /numbers aren’t in .*: 15$/.test(w),
    ),
  );
  assert.ok(
    (await run('project', add(project, 'I also came 2nd of 14 teams at the national maths modelling challenge.'))).some(
      (w) => /numbers aren’t in .*: 2, 14$/.test(w),
    ),
  );
  // As the ask says them, however it is written: "a 15 minute call", "within two weeks", "within 2 weeks".
  assert.deepEqual(await run('call', { ...call, body: call.body.replace('15-minute', '15 minute') }), []);
  assert.deepEqual(
    await run('project', { ...project, body: project.body.replace('within 14 days', 'within 2 weeks') }),
    [],
  );
});

/* ------------------------------------------------------------------ follow-ups */

// Thursday 12 November 2026, midday in London.
const sentAt = Date.UTC(2026, 10, 12, 12);
const rec = {
  firm: { id: 'acme', name: 'Acme Capital LLP', domain: 'acme.com', site: 'https://acme.com', country: 'GB' },
  status: 'sent',
  via: 'nylas',
  messageId: 'msg-1',
  threadId: 'thread-1',
  sentAt,
  to: 'jane.smith@acme.com',
  subject: good.subject,
  body: ['Dear Jane,', '', good.body, '', 'Kind regards,', 'Ada Lovelace'].join('\n'),
  contact: { name: 'Jane Smith', title: 'Head of Talent', email: 'jane.smith@acme.com' },
};
const nudge = {
  body: [
    'I am following up on my email of Thursday 12 November about a summer internship at Acme Capital. One thing I left out: as well as Python and SQL, I work in Excel.',
    'Would Acme Capital consider me for a summer internship or an off-cycle placement in 2027? Thank you for your time.',
  ].join('\n\n'),
};
const later = new Date(2026, 10, 19);

test('outreach: followUp() writes a short nudge for the same thread, with something new and the same ask', async () => {
  const { chat, calls } = scripted([nudge]);
  const r = await O.followUp(chat, { firm, rec, contact: jane, profile, kit, cvText, today: later });
  assert.deepEqual(failed(r), []);
  assert.equal(r.ok, true);
  assert.equal(r.subject, 'Re: Summer internship enquiry, Acme Capital');
  assert.equal(r.kind, 'follow-up');
  assert.equal(r.ask, 'internship');
  assert.equal(r.hook, null);
  assert.equal(r.lang, 'en-GB');
  assert.equal(r.greeting, 'Dear Jane,');
  assert.ok(r.body.startsWith('Dear Jane,\n\nI am following up on my email of Thursday 12 November'));
  assert.ok(r.body.endsWith('\n\nKind regards,\nAda Lovelace\n07700 900123 | ada@example.com | github.com/ada'));
  assert.ok(r.checks.some((c) => c.what === 'Adds something the first email didn’t say'));
  assert.ok(!r.checks.some((c) => /^Subject/.test(c.what)), 'the subject is the thread’s, not the model’s');
  const [system, user] = calls[0].messages;
  assert.match(system.content, /two short paragraphs, 40–90 words in all/);
  assert.match(system.content, /following up on your email of Thursday 12 November about internships at Acme Capital/);
  assert.match(system.content, /that the first email didn’t mention/);
  assert.match(system.content, /^2\. The same ask, in a sentence: ask again whether Acme Capital takes interns/m);
  assert.match(system.content, /just following up/);
  assert.match(
    user.content,
    /\n\nTHE FIRST EMAIL \(sent Thursday 12 November, subject “Summer internship enquiry, Acme Capital”\):\nDear Jane,\n\nYour careers page says/,
  );
  assert.match(user.content, /\n\nCANDIDATE MATERIAL:\nName: Ada Lovelace/);
  assert.doesNotMatch(user.content, /Female|White British|Date of birth/);
});

test('outreach: a follow-up that nags or only repeats the first email goes back once', async () => {
  const lazy = {
    subject: 'Following up',
    body: 'Just following up on my email below about a summer internship at Acme Capital. At Northwind I cleaned 12,000 customer records in Python and SQL.\n\nWould Acme Capital consider me? Thank you for your time.',
  };
  const { chat, calls } = scripted([lazy, nudge]);
  const r = await O.followUp(chat, { firm, rec, contact: jane, profile, kit, cvText, today: later });
  const fix = calls[1].messages.at(-1).content;
  assert.match(fix, /“just following up”/);
  assert.match(fix, /Add one concrete thing from CANDIDATE MATERIAL that the first email didn’t mention/);
  assert.equal(r.attempts, 2);
  assert.equal(r.ok, true);
  assert.equal(r.subject, 'Re: Summer internship enquiry, Acme Capital', 'the model’s own subject is not used');
  // Too long for a nudge.
  const long = { body: `${nudge.body}\n\n${good.body}` };
  const r2 = await O.followUp(scripted([long, long]).chat, {
    firm,
    rec,
    contact: jane,
    profile,
    kit,
    cvText,
    today: later,
  });
  assert.ok(failed(r2).some((w) => /^Too long: \d+ words; cut it to 90 or fewer$/.test(w)));
});

test('outreach: followUp() takes the firm, contact and ask from the record, and never says “Re: Re:”', async () => {
  const kept = { ...rec, subject: 'Re: Summer internship enquiry, Acme Capital', body: '', ask: 'call' };
  const callNudge = {
    body: nudge.body.replace(
      'Would Acme Capital consider me for a summer internship or an off-cycle placement in 2027?',
      'Could we have a 15-minute call, so I can hear how Acme Capital takes on students?',
    ),
  };
  const { chat, calls } = scripted([callNudge]);
  const r = await O.followUp(chat, { rec: kept, profile, kit, cvText, today: later });
  assert.equal(r.subject, 'Re: Summer internship enquiry, Acme Capital');
  assert.equal(r.greeting, 'Dear Jane,');
  assert.equal(r.ask, 'call');
  assert.deepEqual(failed(r), [], 'the call’s 15 and the day it went are numbers the follow-up may use');
  assert.ok(!r.checks.some((c) => /first email didn’t say/.test(c.what)), 'nothing to compare without its body');
  const [system, user] = calls[0].messages;
  assert.match(system.content, /about a 15-minute call, naming Acme Capital/);
  assert.match(system.content, /ask again for a 15-minute call to hear how Acme Capital takes on students\./);
  assert.match(
    user.content,
    /THE FIRST EMAIL \(sent Thursday 12 November, subject “Re: Summer internship enquiry, Acme Capital”\):\n\(Not kept/,
  );
  const shouted = await O.followUp(scripted([nudge]).chat, {
    rec: { ...rec, subject: 'RE: Internship' },
    profile,
    kit,
    cvText,
    today: later,
  });
  assert.equal(shouted.subject, 'RE: Internship');
});

test('outreach: a follow-up dates the first email by the firm’s calendar, wherever the candidate is', async () => {
  const prompts = async (f, iso) => {
    const { chat, calls } = scripted([nudge, nudge]);
    await O.followUp(chat, { firm: f, rec: { ...rec, sentAt: Date.parse(iso) }, profile, kit, cvText, today: later });
    return calls[0].messages.map((m) => m.content).join('\n');
  };
  // sendTime()'s 08:10 on Monday in Tokyo and Hong Kong is still Sunday in London and California.
  const tokyo = await prompts({ ...firm, country: 'JP', cities: ['Tokyo'] }, '2026-11-22T23:10:00Z');
  assert.match(tokyo, /following up on your email of Monday 23 November about internships/);
  assert.match(tokyo, /THE FIRST EMAIL \(sent Monday 23 November, subject/);
  assert.doesNotMatch(tokyo, /Sunday/);
  const hk = await prompts({ ...firm, country: 'HK', cities: ['Hong Kong'] }, '2026-11-23T00:10:00Z');
  assert.match(hk, /email of Monday 23 November about/);
  // 23:30 on Monday in New York, already Tuesday in London; American dates for a US firm.
  const ny = await prompts({ ...firm, country: 'US', cities: ['New York'] }, '2026-11-24T04:30:00Z');
  assert.match(ny, /email of Monday, November 23 about/);
  // The year by the firm's calendar too: New Year's Day in Tokyo is this year there.
  const newYear = await prompts({ ...firm, country: 'JP', cities: ['Tokyo'] }, '2025-12-31T16:00:00Z');
  assert.match(newYear, /email of Thursday 1 January about/);
});

test('outreach: a follow-up adds something only with a thing from the material, not its labels or filler', async () => {
  const lazy = (sentence) => ({
    body: `I am following up on my email of Thursday 12 November about internships at Acme Capital. ${sentence}\n\nWould Acme Capital consider me for a summer internship or an off-cycle placement in 2027? Thank you for your time.`,
  });
  // "Skills:", "Links:", "Contact:", "Notes from the candidate:" and "Education:" head the material's sections.
  for (const said of [
    'I would welcome the chance to put my skills to use on your team.',
    'My links, contact details and notes are on the attached CV.',
    'As a candidate, I hope my education and experience are a good match.',
  ]) {
    const r = await O.followUp(scripted([lazy(said), lazy(said)]).chat, {
      firm,
      rec,
      contact: jane,
      profile,
      kit,
      cvText,
      today: later,
    });
    assert.ok(
      failed(r).some((w) => /^Add one concrete thing from CANDIDATE MATERIAL/.test(w)),
      said,
    );
  }
  // A skill the first email didn't name is new.
  const r = await O.followUp(scripted([lazy('As well as Python and SQL, I work in Excel.')]).chat, {
    firm,
    rec,
    contact: jane,
    profile,
    kit,
    cvText,
    today: later,
  });
  assert.ok(r.checks.some((c) => c.what === 'Adds something the first email didn’t say'));
});

test('outreach: dueFollowUps() lists sent, unanswered Nylas emails five working days on, oldest first', () => {
  const at = (iso) => Date.parse(iso);
  const sent = (iso, more = {}) => ({ ...rec, sentAt: at(iso), ...more });
  const outreach = {
    monday: sent('2026-11-02T10:00:00Z'), // due Monday 9 November, 10:00
    friday: sent('2026-11-06T15:00:00Z'), // the weekend doesn't count: due Friday 13 November, 15:00
    wednesday: sent('2026-11-11T09:00:00Z'), // due Wednesday 18 November
    replied: sent('2026-10-01T10:00:00Z', { status: 'replied' }),
    closed: sent('2026-10-01T10:00:00Z', { status: 'closed' }),
    drafted: sent('2026-10-01T10:00:00Z', { status: 'drafted' }),
    mailto: sent('2026-10-01T10:00:00Z', { via: 'mailto' }),
    noId: sent('2026-10-01T10:00:00Z', { messageId: '' }),
    chased: sent('2026-10-01T10:00:00Z', { followedUpAt: at('2026-10-08T10:00:00Z') }),
    unsent: { ...rec, sentAt: undefined },
  };
  const due = (now, opts) =>
    O.dueFollowUps(outreach, at(now), opts).map((x) => [x.id, new Date(x.dueSince).toISOString()]);
  assert.deepEqual(due('2026-11-13T16:00:00Z'), [
    ['monday', '2026-11-09T10:00:00.000Z'],
    ['friday', '2026-11-13T15:00:00.000Z'],
  ]);
  assert.deepEqual(due('2026-11-13T14:00:00Z'), [['monday', '2026-11-09T10:00:00.000Z']]);
  assert.deepEqual(
    due('2026-11-12T16:00:00Z').map(([id]) => id),
    ['monday'],
    'six days on, but four working days',
  );
  assert.deepEqual(due('2026-11-13T16:00:00Z', { days: 10 }), []);
  assert.deepEqual(
    due('2026-11-30T00:00:00Z').map(([id]) => id),
    ['monday', 'friday', 'wednesday'],
  );
  const [one] = O.dueFollowUps(outreach, at('2026-11-10T00:00:00Z'));
  assert.equal(one.rec, outreach.monday);
  assert.deepEqual(O.dueFollowUps(null, Date.now()), []);
  assert.deepEqual(
    O.dueFollowUps([{ ...outreach.monday, id: 'acme' }], at('2026-11-10T00:00:00Z')).map((x) => x.id),
    ['acme'],
  );
});

test('outreach: dueFollowUps() starts a weekend email’s five working days on the Monday, oldest still first', () => {
  const sent = (iso) => ({ ...rec, sentAt: Date.parse(iso) });
  // sendTime() says "send now" to a firm whose zone isn't known, so a Saturday send happens.
  const outreach = {
    saturday: sent('2026-11-21T09:00:00Z'),
    friday: sent('2026-11-20T15:00:00Z'),
    early: sent('2026-11-21T00:01:00Z'),
    sunday: sent('2026-11-22T23:59:00Z'),
  };
  const due = (iso) => O.dueFollowUps(outreach, Date.parse(iso)).map((x) => [x.id, new Date(x.dueSince).toISOString()]);
  // By Friday night only Monday to Thursday have passed since the weekend.
  assert.deepEqual(due('2026-11-27T23:59:00Z'), [['friday', '2026-11-27T15:00:00.000Z']]);
  assert.deepEqual(due('2026-11-30T00:00:00Z'), [
    ['friday', '2026-11-27T15:00:00.000Z'],
    ['early', '2026-11-30T00:00:00.000Z'],
    ['saturday', '2026-11-30T00:00:00.000Z'],
    ['sunday', '2026-11-30T00:00:00.000Z'],
  ]);
});

test('outreach: sendTime() aims for 08:10 on a weekday, the firm’s time, across clock changes', () => {
  const when = (f, iso, opts) => {
    const r = O.sendTime(f, Date.parse(iso), opts);
    return [r.at && new Date(r.at).toISOString(), r.zone, r.local];
  };
  const london = { country: 'GB', cities: ['London'] };
  // British Summer Time ends at 02:00 on Sunday 25 October 2026.
  assert.deepEqual(when(london, '2026-10-22T20:00:00Z'), [
    '2026-10-23T07:10:00.000Z',
    'Europe/London',
    'Fri 08:10 in London',
  ]);
  assert.deepEqual(when(london, '2026-10-23T18:30:00Z'), [
    '2026-10-26T08:10:00.000Z',
    'Europe/London',
    'Mon 08:10 in London',
  ]);
  assert.deepEqual(when(london, '2026-10-24T12:00:00Z')[0], '2026-10-26T08:10:00.000Z', 'a Saturday waits for Monday');
  assert.deepEqual(when(london, '2026-10-26T07:00:00Z')[0], '2026-10-26T08:10:00.000Z', 'before 08:00: this morning');
  // And begins on Sunday 29 March 2026.
  assert.deepEqual(when(london, '2026-03-27T18:00:00Z')[0], '2026-03-30T07:10:00.000Z');
  // In working hours there: send now.
  assert.deepEqual(when(london, '2026-10-20T09:00:00Z'), [null, 'Europe/London', 'Tue 10:00 in London']);
  assert.deepEqual(when(london, '2026-10-20T15:59:00Z')[0], null);
  assert.deepEqual(when(london, '2026-10-20T16:00:00Z')[0], '2026-10-21T07:10:00.000Z', '17:00 there is too late');
  // A firm known only by its country is named by its zone's city.
  assert.deepEqual(when({ country: 'IE' }, '2026-10-20T15:30:00Z'), [null, 'Europe/Dublin', 'Tue 16:30 in Dublin']);

  // A US firm by its city: New York's clocks change a week after London's (Sunday 1 November 2026).
  const greenwich = { country: 'US', cities: ['Greenwich, CT'] };
  assert.deepEqual(when(greenwich, '2026-10-29T22:00:00Z'), [
    '2026-10-30T12:10:00.000Z',
    'America/New_York',
    'Fri 08:10 in Greenwich',
  ]);
  assert.deepEqual(when(greenwich, '2026-10-30T22:00:00Z')[0], '2026-11-02T13:10:00.000Z');
  assert.deepEqual(when(greenwich, '2026-10-28T09:00:00Z')[0], '2026-10-28T12:10:00.000Z', 'London’s morning is 05:00');
  assert.deepEqual(when({ country: 'US', cities: ['Menlo Park, CA'] }, '2026-10-28T12:10:00Z'), [
    '2026-10-28T15:10:00.000Z',
    'America/Los_Angeles',
    'Wed 08:10 in Menlo Park',
  ]);
  assert.deepEqual(when({ country: 'US', cities: ['Austin, TX'] }, '2026-11-21T03:00:00Z')[1], 'America/Chicago');
  assert.deepEqual(when({ cities: ['Bay Area'] }, '2026-11-21T03:00:00Z')[2], 'Mon 08:10 in the Bay Area');
  // A city in another country than the firm's doesn't decide.
  assert.deepEqual(when({ country: 'GB', cities: ['New York', 'London'] }, '2026-11-21T03:00:00Z')[1], 'Europe/London');
  assert.deepEqual(when({ country: 'HK' }, '2026-11-21T03:00:00Z'), [
    '2026-11-23T00:10:00.000Z',
    'Asia/Hong_Kong',
    'Mon 08:10 in Hong Kong',
  ]);
  assert.deepEqual(when({ country: 'CA', cities: ['Toronto'] }, '2026-11-21T03:00:00Z')[1], 'America/Toronto');
  assert.deepEqual(when(london, '2026-10-24T12:00:00Z', { hour: 9, minute: 0 })[0], '2026-10-26T09:00:00.000Z');

  // Unknown: a US firm without a city we know, a country not in the table, no firm.
  for (const f of [
    { country: 'US' },
    { country: 'US', cities: ['Omaha'] },
    { country: 'BR', cities: ['São Paulo'] },
    null,
  ])
    assert.deepEqual(O.sendTime(f, Date.parse('2026-11-21T03:00:00Z')), { at: null, zone: null, local: '' });
});

test('outreach: sendTime() keeps to Israel’s Sunday-to-Thursday week', () => {
  const when = (iso) => {
    const r = O.sendTime({ country: 'IL' }, Date.parse(iso));
    return [r.at && new Date(r.at).toISOString(), r.zone, r.local];
  };
  // Thursday 22:00 in Jerusalem: Friday and Saturday are the weekend there, so Sunday morning.
  assert.deepEqual(when('2026-11-19T20:00:00Z'), [
    '2026-11-22T06:10:00.000Z',
    'Asia/Jerusalem',
    'Sun 08:10 in Jerusalem',
  ]);
  assert.deepEqual(when('2026-11-20T08:00:00Z')[0], '2026-11-22T06:10:00.000Z', 'Friday 10:00 there waits');
  assert.deepEqual(when('2026-11-21T21:00:00Z')[0], '2026-11-22T06:10:00.000Z', 'Saturday night: Sunday, not Monday');
  // Sunday 10:00 there is a working morning: send now.
  assert.deepEqual(when('2026-11-22T08:00:00Z'), [null, 'Asia/Jerusalem', 'Sun 10:00 in Jerusalem']);
  // Everywhere else the week is still Monday to Friday.
  assert.deepEqual(O.sendTime({ country: 'GB' }, Date.parse('2026-11-22T08:00:00Z')).local, 'Mon 08:10 in London');
});

test('outreach: replyKind() tells a bounce, an out-of-office, a pointer to apply online, a no and a yes apart', () => {
  const kind = (
    snippet,
    from = [{ name: 'Jane Doe', email: 'jane@acme.example' }],
    subject = 'Re: Summer internship',
  ) => O.replyKind({ from, subject, snippet });
  // Gmail's bounce comes from the Mail Delivery Subsystem; Outlook's says "Undeliverable" in its subject.
  assert.equal(
    kind('Address not found. Your message wasn’t delivered to jane@acme.example', [
      { name: 'Mail Delivery Subsystem', email: 'mailer-daemon@googlemail.com' },
    ]),
    'bounced',
  );
  assert.equal(
    kind(
      'Delivery has failed to these recipients or groups',
      [{ email: 'postmaster@acme.example' }],
      'Undeliverable: Hi',
    ),
    'bounced',
  );
  // Out of the office: nobody has read it yet.
  assert.equal(kind('I am out of the office until 28 November with limited access to email.'), 'auto');
  assert.equal(kind('Thanks', undefined, 'Automatic reply: Summer internship enquiry'), 'auto');
  // Man Group's answer: no email applications, apply on the website.
  assert.equal(
    kind(
      'Dear Robin, Thank you for your interest in Man Group. Unfortunately, we are unable to accept applications via email. Please apply directly o',
    ),
    'apply',
  );
  assert.equal(
    kind('Unfortunately we have no internships available this year. We wish you the best of luck.'),
    'declined',
  );
  assert.equal(kind('Hi Robin, happy to have a chat. Are you free on Tuesday afternoon?'), 'positive');
  // A no now with a chat offered counts as a yes.
  assert.equal(kind('Unfortunately nothing formal this summer, but I would be happy to chat next week.'), 'positive');
  assert.equal(kind('Good afternoon Robin, Hope you are well? Thank you for reaching out.'), 'reply');
  assert.equal(O.replyKind(), 'reply');
  // A person back from leave, answering: not an out-of-office.
  assert.equal(
    kind(
      'Hi Robin, apologies for the slow reply, I was on annual leave last week. Happy to have a chat - are you free Thursday?',
    ),
    'positive',
  );
  // A delay is not a bounce: Gmail goes on trying, and the address may well work.
  assert.equal(
    kind(
      'Delivery incomplete. There was a temporary problem delivering your message to jane@acme.example. Gmail will retry for 47 more hours.',
      [{ name: 'Mail Delivery Subsystem', email: 'mailer-daemon@googlemail.com' }],
      'Delivery Status Notification (Delay)',
    ),
    'auto',
  );
  assert.equal(
    kind('Delivery to these recipients is delayed.', [{ email: 'postmaster@acme.example' }], 'Delivery delayed: Hi'),
    'auto',
  );
  // "does not exist" in a person's answer is no bounce.
  assert.notEqual(
    kind(
      'Hi Robin, our summer programme does not exist any more, but please send your CV to the address on our website.',
    ),
    'bounced',
  );
  assert.equal(kind('Unfortunately we are not interviewing for interns this year.'), 'declined');
  assert.equal(
    kind('Please apply online via our careers page; shortlisted candidates will be invited to interview in January.'),
    'apply',
  );
  assert.equal(
    kind('Unfortunately we have no vacancies at the moment but would be happy to keep your CV on file.'),
    'declined',
  );
  assert.equal(kind('We would like to invite you to an interview next Tuesday.'), 'positive');
});
