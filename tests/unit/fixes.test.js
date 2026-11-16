'use strict';
// What a fix writes when a page turns a value down: the ways of writing the profile's value that the page's message
// asks for (matcher.messageVariants, fromTemplate), and what the AI is told when it answers again (answers.js:
// pageError and rejected only when there are some, one more rule in the system prompt only then).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { load, desc } = require('./helpers');

const JTF = load();
for (const f of ['ai', 'letter', 'answers']) require(path.join(__dirname, '..', '..', 'extension', 'lib', f + '.js'));
const { matcher, fields } = JTF;
const A = JTF.answers;

/** The fictional profile the fixes write from. */
function profile() {
  const p = fields.createProfile('Test');
  Object.assign(p.personal, { firstName: 'Ada', lastName: 'Lovelace' });
  Object.assign(p.contact, { email: 'ada@example.com', phoneCountryCode: '+1', phone: '415 555 0100' });
  Object.assign(p.links, { linkedin: 'https://www.linkedin.com/in/ada' });
  Object.assign(p.job, { startDate: '2026-11-02' });
  return p;
}

/** The profile's value for a field type, and the box it goes in, as a fill works them out. */
function valueOf(type, label) {
  const d = desc({ label });
  return { v: fields.resolve(type, profile(), { index: 0, kind: d.kind }), d };
}

/** messageVariants for a type, a message and the value the page turned down. */
const ways = (type, label, message, rejected) => {
  const { v, d } = valueOf(type, label);
  return matcher.messageVariants(v, d, message, rejected);
};

test('fromTemplate: a date written to the template a page spells out', () => {
  const date = { year: 2026, month: 11, day: 2 };
  assert.equal(matcher.fromTemplate(date, 'MM/YYYY'), '11/2026');
  assert.equal(matcher.fromTemplate(date, 'DD/MM/YYYY'), '02/11/2026');
  assert.equal(matcher.fromTemplate(date, 'mm/dd/yyyy'), '11/02/2026');
  assert.equal(matcher.fromTemplate(date, 'YYYY-MM-DD'), '2026-11-02');
  assert.equal(matcher.fromTemplate(date, 'DD.MM.YY'), '02.11.26');
  assert.equal(matcher.fromTemplate({ year: 2026, month: 3, day: 7 }, 'M/D/YYYY'), '3/7/2026');
  // A month alone ("2026-03") is its first day.
  assert.equal(matcher.fromTemplate({ year: 2026, month: 3 }, 'DD/MM/YYYY'), '01/03/2026');
});

test('messageVariants: the way the page’s message asks for comes first', () => {
  // Workday's "Phone Number must contain only numbers": the digits alone.
  assert.equal(
    ways('phone', 'Phone Number', 'Error: Phone Number must contain only numbers.', '+1 415 555 0100')[0],
    '4155550100',
  );
  assert.match(ways('phone', 'Phone Number', 'Numbers only, no spaces', '+1 415 555 0100')[0], /^\d{10,}$/);
  // "Enter a date in the format MM/YYYY": the date so, whatever way it was written before.
  assert.equal(
    ways('job.startDate', 'Preferred Start Date', 'Error: Enter a date in the format MM/YYYY.', '2 November 2026')[0],
    '11/2026',
  );
  assert.equal(ways('job.startDate', 'Preferred Start Date', 'Please use DD/MM/YYYY', '11/02/2026')[0], '02/11/2026');
  // A LinkedIn address the page wants in full, and one it wants without its scheme.
  assert.equal(
    ways(
      'links.linkedin',
      'LinkedIn',
      'Error: Enter a LinkedIn profile address (https://www.linkedin.com/in/…).',
      'linkedin.com/in/ada',
    )[0],
    'https://www.linkedin.com/in/ada',
  );
  assert.equal(
    ways('links.linkedin', 'LinkedIn', 'Remove https:// from the link', 'https://www.linkedin.com/in/ada')[0],
    'www.linkedin.com/in/ada',
  );
  // "Starting with your country code": the international ways.
  assert.match(
    ways('phone', 'Phone Number', 'Please enter a number starting with your country code', '415 555 0100')[0],
    /^\+1/,
  );
});

test('messageVariants: a message that names nothing gets the box’s next way, never the one turned down', () => {
  const { v, d } = valueOf('phone', 'Phone Number');
  const all = matcher.textVariants(v, d);
  const next = matcher.messageVariants(v, d, '', all[0]);
  assert.equal(next[0], all[1], 'the way after the one turned down');
  assert.ok(!next.includes(all[0]));
  // Every way tried, then round to the start: all of them but the one turned down.
  assert.deepEqual([...next].sort(), all.slice(1).sort());
  const middle = matcher.messageVariants(v, d, 'marked invalid', all[3]);
  assert.equal(middle[0], all[4]);
  assert.ok(!middle.includes(all[3]));
});

test('messageVariants: never a value other than the profile’s', () => {
  const messages = [
    'Error: Phone Number must contain only numbers.',
    'Please enter a number starting with your country code',
    'Enter a date in the format MM/YYYY',
    'Use a full URL starting with https://',
    'Remove https:// from the link',
    'no more than 10 characters',
    'at least 12 characters',
    '',
  ];
  for (const [type, label] of [
    ['phone', 'Phone Number'],
    ['job.startDate', 'Preferred Start Date'],
    ['links.linkedin', 'LinkedIn'],
  ]) {
    const { v, d } = valueOf(type, label);
    const known = new Set([
      ...matcher.textVariants(v, d),
      ...matcher.textVariants(v, d).map((s) => s.replace(/\D/g, '')),
      ...(v.date ? ['MM/YYYY'].map((t) => matcher.fromTemplate(v.date, t)) : []),
    ]);
    for (const message of messages)
      for (const s of matcher.messageVariants(v, d, message, '')) assert.ok(known.has(s), `${type}: “${s}”`);
  }
  // No value: nothing to write.
  assert.deepEqual(matcher.messageVariants(null, {}, 'must contain only numbers', 'x'), []);
});

test('messageVariants: “no more than 10 characters” puts a way that fits first', () => {
  const got = ways('phone', 'Phone Number', 'Phone: no more than 10 characters', '+1 415 555 0100');
  assert.ok(got[0].length <= 10, `“${got[0]}”`);
  assert.equal(got[0], '4155550100');
});

/* ------------------------------------------------------------------ answers */

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const ESSAY = { id: 'q1', question: 'Why do you want to join Ada & Co? (at least 150 characters)', kind: 'textarea' };
const FIX_RULE = /^Answers the form turned down:$/m;

test('questionJson: pageError and rejected only when the form turned an answer down', () => {
  const plain = A.questionJson(ESSAY, [], null);
  assert.ok(!('pageError' in plain) && !('rejected' in plain));
  const fixing = A.questionJson(
    { ...ESSAY, pageError: 'Error: Enter at least 150 characters.', rejected: 'I like engines.' },
    [],
    null,
  );
  assert.equal(fixing.pageError, 'Error: Enter at least 150 characters.');
  assert.equal(fixing.rejected, 'I like engines.');
  // A message with nothing turned down (the box was empty): no "rejected".
  const empty = A.questionJson(
    { ...ESSAY, pageError: 'Error: Enter at least 150 characters.', rejected: '' },
    [],
    null,
  );
  assert.equal(empty.pageError, 'Error: Enter at least 150 characters.');
  assert.ok(!('rejected' in empty));
  // A refused value with no message to go with it is not sent.
  assert.ok(!('rejected' in A.questionJson({ ...ESSAY, rejected: 'I like engines.' }, [], null)));
  // A long message is cut to size.
  assert.ok(A.questionJson({ ...ESSAY, pageError: 'x '.repeat(400) }, [], null).pageError.length <= 200);
});

test('systemPrompt: the rule about answers the form turned down only when one is being fixed', () => {
  const GB = '24d8df20b5265058e42902ae3f7abc687d35af7c59edaddc9d5fd79c8a605f1f';
  assert.equal(sha(A.systemPrompt({ name: 'Alex Morgan', lang: 'en-GB' })), GB);
  assert.equal(sha(A.systemPrompt({ name: 'Alex Morgan', lang: 'en-GB', fixing: false })), GB);
  const fixing = A.systemPrompt({ name: 'Alex Morgan', lang: 'en-GB', fixing: true });
  assert.match(fixing, FIX_RULE);
  assert.match(fixing, /A question with "pageError" was answered before and the form refused that answer/);
  // Only one block more: the rest is the prompt as measured.
  const base = A.systemPrompt({ name: 'Alex Morgan', lang: 'en-GB' });
  assert.equal(fixing.replace(/Answers the form turned down:\n[^\n]*\n\n/, ''), base);
});

/** Run answer() over `items` with a model that skips everything, and return what it was sent. */
async function sent(items) {
  const seen = [];
  const chat = async (messages) => {
    seen.push(messages);
    if (/strict fact-checker/.test(messages[0].content)) return { json: { unsupported: [] } };
    const last = messages[messages.length - 1].content;
    const qs = JSON.parse(last.slice(last.indexOf('QUESTIONS:') + 10));
    const json = { answers: qs.map((q) => ({ id: q.id, skip: true, reason: 'x' })) };
    return { json, text: JSON.stringify(json) };
  };
  const input = {
    profile: profile(),
    kit: { notes: 'Built a reconciliation tool in Python.' },
    cvText: '',
    guidance: '',
    job: { company: 'Ada & Co', title: 'Summer Analyst', description: 'Reconcile trades.' },
    bank: [],
    today: new Date('2026-10-02').getTime(),
  };
  await A.answer(chat, input, items);
  const first = seen[0];
  const user = first[first.length - 1].content;
  return { system: first[0].content, questions: JSON.parse(user.slice(user.indexOf('QUESTIONS:') + 10)) };
}

test('answer: a batch with an answer the form turned down tells the model what it said; one without doesn’t', async () => {
  const other = { id: 'q2', question: 'What is your favourite programming language?', kind: 'text' };
  const plain = await sent([ESSAY, other]);
  assert.doesNotMatch(plain.system, FIX_RULE);
  assert.ok(plain.questions.every((q) => !('pageError' in q) && !('rejected' in q)));

  const fix = await sent([
    { ...ESSAY, pageError: 'Error: Enter at least 150 characters.', rejected: 'I like engines.' },
    other,
  ]);
  assert.match(fix.system, FIX_RULE);
  const [essay, language] = fix.questions;
  assert.equal(essay.pageError, 'Error: Enter at least 150 characters.');
  assert.equal(essay.rejected, 'I like engines.');
  assert.ok(!('pageError' in language) && !('rejected' in language), 'only the question that was turned down');
});

test('answer: a withheld question the form turned down is still never asked, and adds no rule', async () => {
  const gender = {
    id: 'q3',
    question: 'What is your gender?',
    kind: 'select',
    options: ['Male', 'Female', 'I do not wish to answer'],
    pageError: 'Error: The field Gender is required and must have a value.',
  };
  const out = await sent([gender, ESSAY]);
  assert.deepEqual(
    out.questions.map((q) => q.question),
    [ESSAY.question],
  );
  assert.doesNotMatch(out.system, FIX_RULE);
});
