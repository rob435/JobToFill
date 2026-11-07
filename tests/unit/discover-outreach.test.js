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
