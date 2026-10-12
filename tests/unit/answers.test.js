'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { load } = require('./helpers');

const JTF = load();
for (const f of ['ai', 'letter', 'answers']) require(path.join(__dirname, '..', '..', 'extension', 'lib', f + '.js'));
const A = JTF.answers;

function profile() {
  const p = JTF.fields.createProfile('Test');
  Object.assign(p.personal, { firstName: 'Alex', lastName: 'Morgan', nationality: 'British' });
  Object.assign(p.address, { city: 'London', country: 'United Kingdom' });
  Object.assign(p.job, { authorized: 'Yes', sponsorship: 'No', referralSource: 'Trackr', relocate: 'Yes' });
  p.education = [
    {
      school: 'University College London',
      degree: 'BSc',
      field: 'Economics',
      gpa: '2:1',
      location: 'London',
      startDate: '2024-09',
      endDate: '2027-06',
    },
  ];
  p.experience = [
    {
      company: 'Finch & Partners',
      title: 'Summer Analyst Intern',
      location: 'London',
      startDate: '2025-07',
      endDate: '2025-08',
      current: false,
      description: 'Built an Excel model of 40 listed retailers’ margins; cleaned three years of sales data in Python.',
    },
  ];
  p.skills = 'Python, Excel, SQL';
  return p;
}

const CTX = {
  facts: 'Built an Excel model of 40 listed retailers’ margins in Python. Acme Capital Rates desk.',
  mine: 'Built an Excel model of 40 listed retailers’ margins in Python.',
  company: 'Acme Capital',
  role: 'Rates Summer Analyst',
  others: ['Goldman Sachs'],
  today: new Date('2026-10-02').getTime(),
};

test('withheld: diversity, declarations and ID numbers never go; legal and health only with guidance', () => {
  const w = (question, extra) => A.withheld({ question, kind: 'select', ...extra }, '');
  assert.equal(w('What is your gender?'), 'eeo');
  assert.equal(w('Do you consider yourself to be from a lower socio-economic background?'), 'eeo');
  assert.equal(w('Which best describes you?', { options: ['Male', 'Female', 'Non-binary'] }), 'eeo');
  assert.equal(w('Ethnicity', { section: 'UK Diversity Question Set' }), 'eeo');
  assert.equal(w('Geschlecht'), 'eeo');
  assert.equal(w('Origine ethnique'), 'eeo');
  assert.equal(w('¿Tiene alguna discapacidad?'), 'eeo');
  assert.equal(w('Warum möchten Sie bei uns arbeiten?'), null);
  assert.equal(w('I agree to the privacy notice', { kind: 'checkbox' }), 'consent');
  assert.equal(w('By ticking this box I confirm the information is true and accurate'), 'consent');
  assert.equal(w('Please provide your National Insurance number'), 'identity');
  assert.equal(w('Have you ever been convicted of a criminal offence?'), 'guidance');
  assert.equal(w('Are you currently registered with FINRA?'), 'guidance');
  assert.equal(w('Do you require any reasonable adjustments during the recruitment process?'), 'guidance');
  assert.equal(
    A.withheld(
      { question: 'Have you ever been convicted of a criminal offence?', kind: 'select' },
      'I have no convictions.',
    ),
    null,
  );
  // Parents' education is social-mobility monitoring however it's put (Talos).
  assert.equal(w('What is the highest level of education completed by either of your parents or guardians?'), 'eeo');
  // A question the rules took for a monitoring one is withheld whatever its words, and its answer never goes.
  const guessed = { question: 'Background', kind: 'select', guess: { type: 'eeo.parentsDegree', value: 'Yes' } };
  assert.equal(A.withheld(guessed, ''), 'eeo');
  assert.equal(A.questionJson(guessed).profileValue, undefined);
  assert.equal(
    A.questionJson({
      question: 'How did you hear about us?',
      kind: 'select',
      guess: { type: 'job.referralSource', value: 'Trackr' },
    }).profileValue,
    'Trackr',
  );
  // Disciplinary action is a legal matter; a degree's discipline isn't (Appian, Freeform).
  assert.equal(w('Have you ever been subject to disciplinary action by a regulator?'), 'guidance');
  assert.equal(w('Have you ever been disciplined by a professional body?'), 'guidance');
  assert.equal(
    w(
      'Are you currently pursuing a Major in one of the following disciplines: Computer Science or Computer Engineering',
    ),
    null,
  );
  assert.equal(w('Why did you want to become an engineer in your respective discipline?'), null);
  // Health by what is asked, not by the accommodation boilerplate in front of another question (Notion).
  assert.equal(
    w(
      'We work from our offices on Mondays, Tuesdays, and Thursdays (Anchor Days). If you need an accommodation, we’ll partner with you and explore reasonable options consistent with applicable law. Are you able to commit to working from one of our offices on Anchor Days each week?',
    ),
    null,
  );
  assert.equal(
    w('Are you able to perform the essential functions of the job, with or without a reasonable accommodation?'),
    'guidance',
  );
  assert.equal(w('Do you need an accommodation during the interview process?'), 'guidance');
  for (const q of [
    'Why do you want to join Figma?',
    'Do you have practical Python experience?',
    'Which desk interests you most?',
    'How did you hear about DV Trading?',
    'Please confirm your availability for June 2027',
    'Are you willing to work in the office 5 days a week?',
  ])
    assert.equal(w(q), null, q);
});

test('limits: words, characters and sentences as questions write them', () => {
  const l = (question, extra) => A.limits({ question, ...extra });
  assert.equal(l('Let us know why you’re excited to work for Monzo? (250 word limit)').maxWords, 250);
  assert.equal(l('In 150 words, describe why you are interested in Real Estate.').maxWords, 150);
  assert.deepEqual(
    [l('Describe a project (300-500 words)').minWords, l('Describe a project (300-500 words)').maxWords],
    [300, 500],
  );
  const chars = l('Tell us something about yourself that we can’t find on your resume. (255 char limit)');
  assert.equal(chars.maxChars, 255);
  assert.ok(chars.maxWords > 30 && chars.maxWords < 45);
  assert.equal(l('In 1,000 characters or fewer, describe a project').maxChars, 1000);
  assert.equal(l('Briefly (2-4 sentences) describe why').sentences, 4);
  assert.equal(l('Why us?', { maxLength: 500 }).maxChars, 500);
  assert.deepEqual(l('Why do you want to join Figma?'), { minWords: 0, maxWords: 0, maxChars: 0, sentences: 0 });
});

test('answerKind: essays, short text, choices and ticks', () => {
  const k = (question, extra) => A.answerKind({ question, kind: 'text', ...extra });
  assert.equal(k('Why do you want to join Figma?', { kind: 'textarea' }), 'essay');
  assert.equal(k('What excites you about the opportunity to join Talos?'), 'essay');
  assert.equal(k('What is the name of your university society?'), 'text');
  assert.equal(k('Where is your hometown?'), 'text');
  assert.equal(k('Do you have Python experience?', { kind: 'select', options: ['Yes', 'No'] }), 'choice');
  assert.equal(k('Which offices?', { kind: 'checkboxes', options: ['London', 'NYC'] }), 'multi');
  assert.equal(k('I am available for summer 2027', { kind: 'checkbox' }), 'tick');
});

test('validate: a choice is one of the options or nothing', () => {
  const item = {
    id: 'q1',
    question: 'How did you hear about us?',
    kind: 'select',
    options: ['LinkedIn', 'Online job board', 'Other'],
  };
  assert.equal(A.validate({ answer: 'Online job board' }, item, CTX).value, 'Online job board');
  assert.equal(A.validate({ answer: 'online job board.' }, item, CTX).value, 'Online job board');
  assert.equal(A.validate({ answer: 'A podcast' }, item, CTX).skip, true);
  assert.equal(A.validate({ skip: true, reason: 'unknown' }, item, CTX).skip, true);
  const multi = {
    id: 'q2',
    question: 'Which offices?',
    kind: 'checkboxes',
    options: ['London', 'New York', 'Hong Kong'],
  };
  assert.deepEqual(A.validate({ answer: ['London', 'Paris', 'New York'] }, multi, CTX).value, ['London', 'New York']);
  const tick = { id: 'q3', question: 'I can start in June 2027', kind: 'checkbox' };
  assert.equal(A.validate({ answer: 'Yes' }, tick, CTX).value, 'Yes');
  assert.equal(A.validate({ answer: 'No' }, tick, CTX).skip, true);
});

test('validate: written answers use only the material’s numbers, tools and employers', () => {
  const item = { id: 'q1', question: 'Why do you want to join Acme Capital? (100 words)', kind: 'textarea' };
  const ok = A.validate(
    {
      answer:
        'At Finch I built an Excel model of 40 retailers’ margins in Python, and Acme Capital’s Rates desk works the same way.',
    },
    item,
    CTX,
  );
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.severe, 0);
  const number = A.validate({ answer: 'I built a model of 400 retailers in Python for Acme Capital.' }, item, CTX);
  assert.ok(number.severe >= 1);
  assert.match(number.errors.join(' '), /400/);
  const tool = A.validate({ answer: 'I used Bloomberg and Python to model 40 retailers for Acme Capital.' }, item, CTX);
  assert.match(tool.errors.join(' '), /bloomberg/i);
  const leak = A.validate(
    { answer: 'I want to join Goldman Sachs because I built a model of 40 retailers.' },
    item,
    CTX,
  );
  assert.match(leak.errors.join(' '), /Goldman Sachs/);
  const placeholder = A.validate({ answer: 'I want to join [Company] because of its culture.' }, item, CTX);
  assert.match(placeholder.errors.join(' '), /placeholder/);
  const long = A.validate({ answer: Array(30).fill('I built a model of 40 retailers.').join(' ') }, item, CTX);
  assert.match(long.errors.join(' '), /Too long/);
  const cliche = A.validate({ answer: 'I am passionate about markets and built a model of 40 retailers.' }, item, CTX);
  assert.match(cliche.errors.join(' '), /passionate/);
});

test('validate: a grade is the candidate’s own, never a GPA made from the question’s scale', () => {
  const ctx = {
    ...CTX,
    facts: `${CTX.facts} Minimum GPA 3.5/4.0 or a 2:1.`,
    mine: 'University College London, BSc Economics (2024 – 2027), degree classification 2:1\nYear 4 of 4. Built 4 apps.',
  };
  const help =
    "If your school/university uses a GPA system, enter your GPA on a 0- 4.0 scale. Otherwise, provide your overall result in your school/university's grading system.";
  const item = { id: 'q1', question: 'Overall Result (GPA)', help, kind: 'text' };
  for (const invented of ['4', '4.0', '3.7', '3.5'])
    assert.ok(A.validate({ answer: invented }, item, ctx).severe >= 1, `${invented} is not the candidate’s`);
  assert.equal(A.validate({ answer: '2:1' }, item, ctx).severe, 0);
  assert.equal(A.validate({ answer: 'Upper Second Class Honours (2:1), predicted' }, item, ctx).severe, 0);
  const number = { id: 'q2', question: 'Cumulative GPA', kind: 'number' };
  assert.equal(A.validate({ answer: '3.5' }, number, ctx).skip, true, 'the posting’s minimum is not a GPA you have');
  assert.equal(A.validate({ answer: '4' }, number, ctx).skip, true, '"Year 4 of 4" is not a grade');
  const us = { ...ctx, mine: 'Columbia University, BA Economics, GPA: 3.8/4.0' };
  assert.equal(A.validate({ answer: '3.8' }, number, us).value, '3.8', 'a GPA the material gives');
  // Other questions may still use the question's and the posting's numbers, and an essay about results the material's.
  const essay = { id: 'q3', question: 'Why Acme Capital? (100 words)', kind: 'textarea' };
  assert.equal(
    A.validate({ answer: 'Its Rates desk models 40 retailers, in 100 words or less.' }, essay, ctx).severe,
    0,
  );
  const results = { id: 'q4', question: 'Tell us about your academic results (100 words)', kind: 'textarea' };
  const modules = { ...ctx, facts: `${ctx.facts}\nModules: Algorithms 92%` };
  assert.equal(A.validate({ answer: 'I scored 92% in Algorithms and expect a 2:1.' }, results, modules).severe, 0);
  assert.match(A.systemPrompt({}), /Never convert one into a GPA/);
});

test('polish and cut: dashes, bullets and quotes go; answers end on a sentence within the limit', () => {
  const item = { question: 'Why us?', kind: 'textarea' };
  assert.equal(A.polish('"I like it — a lot!"', item), 'I like it, a lot.');
  assert.equal(A.polish('- one\n- two', { question: 'Name two things', kind: 'text' }), 'one two');
  assert.equal(A.polish('- one\n- two', { question: 'Use three bullets', kind: 'textarea' }), '- one\n- two');
  assert.equal(
    A.cut('One two three. Four five six. Seven eight nine.', { maxWords: 7 }),
    'One two three. Four five six.',
  );
  assert.equal(A.cut('One two three four five six', { maxWords: 3 }), 'One two three');
});

test('candidate text carries the application facts the letters don’t need', () => {
  const p = profile();
  const text = A.candidateText({ profile: p, kit: {}, cvText: '' });
  assert.match(text, /Where they found this job: Trackr/);
  assert.match(text, /Available for interviews: Weekdays, 8am–8pm/);
  assert.match(text, /Needs visa sponsorship: No/);
  assert.match(text, /Summer Analyst Intern at Finch & Partners/);
});

/** A fake model: answers by question, records what it was sent. */
function fakeChat(script) {
  const calls = [];
  const chat = async (messages, options) => {
    const system = messages[0].content;
    const last = messages[messages.length - 1].content;
    calls.push({ system, last, options });
    let json;
    if (/strict fact-checker/.test(system)) json = script.audit ? script.audit(last) : { unsupported: [] };
    else if (/^Some answers need fixing/.test(last)) json = script.fix(last);
    else {
      const questions = JSON.parse(last.slice(last.indexOf('QUESTIONS:') + 10));
      json = { answers: questions.map((q) => script.answer(q)) };
    }
    return { json, text: JSON.stringify(json) };
  };
  return { chat, calls };
}

test('answer: plain ids for the model, checks, one round of fixes, the page’s ids back', async () => {
  const items = [
    { id: '0:3', question: 'Why do you want to join Acme Capital? (120 words max)', kind: 'textarea' },
    { id: '0:4', question: 'Do you have practical Python experience?', kind: 'select', options: ['Yes', 'No'] },
    {
      id: '0:5',
      question: 'How did you hear about Acme Capital?',
      kind: 'select',
      options: ['LinkedIn', 'Online job board', 'Other'],
      guess: { type: 'job.referralSource', value: 'Trackr' },
    },
    { id: '0:6', question: 'What is your gender?', kind: 'select', options: ['Male', 'Female'] },
    { id: '2:1', question: 'What is your SAT score?', kind: 'text' },
  ];
  const { chat, calls } = fakeChat({
    answer: (q) => {
      if (/why/i.test(q.question))
        return {
          id: q.id,
          answer: 'At Finch & Partners I built an Excel model of 400 retailers’ margins for Acme Capital.',
        };
      if (/python/i.test(q.question)) return { id: q.id, answer: 'Yes', basis: 'material' };
      if (/hear/i.test(q.question)) return { id: q.id, answer: 'Online job board' };
      return { id: q.id, skip: true, reason: 'not in the material' };
    },
    fix: (last) => ({
      answers: [
        {
          id: last.match(/^- (q\d+):/m)[1],
          answer:
            'At Finch & Partners I built an Excel model of 40 retailers’ margins, the kind of careful modelling Acme Capital’s desk does.',
        },
      ],
    }),
  });
  const out = await A.answer(
    chat,
    {
      profile: profile(),
      kit: {},
      cvText: '',
      job: { company: 'Acme Capital', title: 'Rates Summer Analyst', description: 'Rates desk.' },
      today: CTX.today,
    },
    items,
  );
  const sent = calls[0].last;
  assert.match(sent, /"id": "q1"/);
  assert.doesNotMatch(sent, /0:3|gender/i, 'the page’s ids and the diversity question stay here');
  assert.match(sent, /"profileValue": "Trackr"/);
  assert.match(sent, /"limit": "at most 120 words"/);
  const byId = Object.fromEntries(out.answers.map((a) => [a.id, a.value]));
  assert.match(byId['0:3'], /40 retailers/, 'the invented 400 was fixed');
  assert.equal(byId['0:4'], 'Yes');
  assert.equal(byId['0:5'], 'Online job board');
  assert.deepEqual(out.skipped.map((s) => s.id).sort(), ['0:6', '2:1']);
  assert.equal(out.skipped.find((s) => s.id === '0:6').withheld, 'eeo');
  assert.equal(calls.filter((c) => /^Some answers need fixing/.test(c.last)).length, 1);
});

test('answer: what still invents facts after the fix is dropped; doubted claims become warnings', async () => {
  const items = [
    { id: 'a', question: 'Tell us about a project (80 words max)', kind: 'textarea' },
    { id: 'b', question: 'Why do you want to join Acme Capital? (80 words max)', kind: 'textarea' },
  ];
  const { chat } = fakeChat({
    answer: (q) =>
      /project/i.test(q.question)
        ? { id: q.id, answer: 'I led a team of 12 analysts on a model of 40 retailers.' }
        : {
            id: q.id,
            answer:
              'At Finch & Partners I built an Excel model of 40 retailers’ margins and cleaned three years of sales data in Python, and I want to do similar work at Acme Capital.',
          },
    fix: (last) => ({
      answers: [...last.matchAll(/^- (q\d+):/gm)].map((m) => ({
        id: m[1],
        answer: /q1/.test(m[1])
          ? 'I led a team of 12 analysts on a model of 40 retailers.'
          : 'At Finch & Partners I built an Excel model of 40 retailers’ margins and cleaned three years of sales data in Python, and I want to do similar work at Acme Capital.',
      })),
    }),
    audit: () => ({ unsupported: [{ id: 'q2', quote: 'want to do similar work', problem: 'not stated' }] }),
  });
  const out = await A.answer(
    chat,
    { profile: profile(), kit: {}, cvText: '', job: { company: 'Acme Capital' }, today: CTX.today },
    items,
  );
  assert.deepEqual(
    out.skipped.map((s) => s.id),
    ['a'],
  );
  const b = out.answers.find((x) => x.id === 'b');
  assert.ok(b);
  assert.match(b.warnings.join(' '), /check this is true/);
});

test('reuse and the answer bank: same question and options come back; similar essays are offered', () => {
  const item = { id: '1', question: 'How did you hear about us?', kind: 'select', options: ['LinkedIn', 'Other'] };
  const saved = [{ key: A.questionKey(item), value: 'Other', kind: 'choice' }];
  const { reused, rest } = A.reuse([item, { ...item, id: '2', options: ['LinkedIn', 'Job board'] }], saved);
  assert.deepEqual(
    reused.map((r) => [r.id, r.value]),
    [['1', 'Other']],
  );
  assert.deepEqual(
    rest.map((r) => r.id),
    ['2'],
  );
  const bank = [
    {
      question: 'Why do you want to work at Goldman Sachs?',
      answer: 'Because the work in markets suits what I have done so far in modelling.',
      company: 'Goldman Sachs',
      at: 1,
    },
    {
      question: 'What is your favourite colour?',
      answer: 'Blue, mostly, and sometimes green when it is sunny outside.',
      company: 'X',
      at: 2,
    },
  ];
  const prev = A.relevantPrevious([{ question: 'Why do you want to work at Acme?', kind: 'textarea' }], bank, 'Acme');
  assert.deepEqual(
    prev.map((p) => p.company),
    ['Goldman Sachs'],
  );
});

test('withheld: security-vetting history needs answer guidance', () => {
  const w = (question) => A.withheld({ question, kind: 'select' }, '');
  assert.equal(w('Have you been continually resident in the UK for the last 5 years?'), 'guidance');
  assert.equal(w('Do you hold or have previously held citizenship for any other countries?'), 'guidance');
  assert.equal(
    w('If you have spent more than 30 consecutive days outside of the UK in the past 5 years please provide details'),
    'guidance',
  );
  assert.equal(
    A.withheld(
      { question: 'Have you been continually resident in the UK for the last 5 years?', kind: 'select' },
      'I have lived in the UK all my life.',
    ),
    null,
  );
});

/* ------------------------------------------- the kinds the AI may also answer */

const NONE = { eeo: false, consent: false, legal: false, health: false, identity: false };
const ALL = { eeo: true, consent: true, legal: true, health: true, identity: true };
const only = (kind) => ({ ...NONE, [kind]: true });

test('withheld: each sensitive kind stays back by default and goes once allowed, on its own', () => {
  const w = (question, allow, extra) => A.withheld({ question, kind: 'select', ...extra }, '', allow);
  const cases = [
    ['eeo', 'What is your gender?', 'eeo'],
    ['consent', 'I agree to the privacy notice', 'consent', { kind: 'checkbox' }],
    ['consent', 'Signature', 'consent', { kind: 'text' }],
    ['identity', 'Please provide your National Insurance number', 'identity', { kind: 'text' }],
    ['identity', 'Date of birth', 'identity', { kind: 'date' }],
    ['legal', 'Have you ever been convicted of a criminal offence?', 'guidance'],
    ['legal', 'Have you been continually resident in the UK for the last 5 years?', 'guidance'],
    ['health', 'Do you require any reasonable adjustments during the recruitment process?', 'guidance'],
  ];
  for (const [kind, question, byDefault, extra] of cases) {
    assert.equal(w(question, undefined, extra), byDefault, `${question}: by default`);
    assert.equal(w(question, NONE, extra), byDefault, `${question}: nothing allowed`);
    assert.equal(w(question, only(kind), extra), null, `${question}: ${kind} allowed`);
    for (const other of A.SENSITIVE.filter((k) => k !== kind))
      assert.equal(w(question, only(other), extra), byDefault, `${question}: only ${other} allowed`);
  }
  // Menzies' "Did your household receive income support…?" is the rules' monitoring question.
  const support = {
    question: 'Did your household receive income support during your school years?',
    kind: 'radio',
    guess: { type: 'eeo.incomeSupport', value: '' },
  };
  assert.equal(A.withheld(support, '', NONE), 'eeo');
  assert.equal(A.withheld(support, '', only('eeo')), null);
  // A question that is legal and health at once goes only when both are allowed (or with guidance).
  const both = 'Do you have any medical condition or criminal conviction we should know about?';
  assert.equal(w(both, only('legal')), 'guidance');
  assert.equal(w(both, only('health')), 'guidance');
  assert.equal(w(both, { ...NONE, legal: true, health: true }), null);
  assert.equal(A.withheld({ question: both, kind: 'select' }, 'I have no convictions.', only('legal')), null);
  // A setting that isn't a plain true is no yes.
  assert.equal(w('What is your gender?', { eeo: 'true' }), 'eeo');
  assert.equal(w('What is your gender?', { eeo: 1 }), 'eeo');
});

test('withheld: passwords, cards and bank details, and marketing opt-ins, never go, whatever is allowed', () => {
  for (const question of [
    'Password',
    'Confirm password',
    'Card number',
    'CVV',
    'IBAN',
    'Sort code',
    'Account number',
  ]) {
    assert.equal(A.withheld({ question, kind: 'text' }, 'My IBAN is GB00 0000 0000.', ALL), 'secret', question);
    assert.equal(A.withheld({ question, kind: 'text' }, ''), 'secret', `${question}, by default`);
  }
  for (const [question, extra] of [
    ['I agree to receive marketing emails from Acme Capital', { kind: 'checkbox' }],
    ['I consent to Acme keeping my details in its talent pool for future opportunities', { kind: 'checkbox' }],
    ['By ticking this box you agree to be contacted by SMS or WhatsApp', { kind: 'checkbox' }],
    ['Updates', { kind: 'checkbox', options: ['I would like to receive the Acme newsletter'] }],
    // A box to tick that the rules don't take for an opt-in (no "agree" or "receive" in it) is still one.
    ['Keep me updated about future opportunities', { kind: 'checkbox', options: ['Yes'] }],
  ]) {
    assert.equal(A.withheld({ question, ...extra }, '', ALL), 'optin', question);
    assert.equal(A.withheld({ question, ...extra }, ''), 'optin', `${question}, by default`);
  }
  assert.equal(A.withheld({ question: 'I confirm the information I have provided is accurate' }, '', ALL), null);
  // Words an opt-in uses, in a question that is none: a written answer about other roles or keeping up to date.
  for (const question of ['What other roles at Acme interest you?', 'How do you keep up with market updates?'])
    assert.equal(A.withheld({ question, kind: 'textarea' }, ''), null, question);
});

/** A whole run with every message it sends (the answers, then the fact-check), as recorded before the change. */
async function defaultRun(allow) {
  const p = profile();
  p.personal.dob = '2004-03-09';
  Object.assign(p.eeo, { gender: 'Male', schoolType: 'State school (non-selective)' });
  Object.assign(p.compliance, { criminal: 'No', relatives: 'No' });
  const items = [
    { id: '0:1', question: 'Why do you want to join Acme Capital? (120 words max)', kind: 'textarea', required: true },
    {
      id: '0:2',
      question: 'How did you hear about us?',
      kind: 'select',
      options: ['LinkedIn', 'Online job board', 'Other'],
      guess: { type: 'job.referralSource', value: 'Trackr' },
    },
    {
      id: '0:3',
      question: 'Background',
      kind: 'select',
      options: ['Yes', 'No'],
      guess: { type: 'eeo.parentsDegree', value: 'Yes' },
    },
    { id: '0:4', question: 'Do you have any relatives working at Acme?', kind: 'select', options: ['Yes', 'No'] },
    {
      id: '0:5',
      question: 'If yes, please give details',
      kind: 'text',
      follows: { question: 'Do you have any relatives working at Acme?', answer: '' },
    },
    { id: '0:6', question: 'Are you a government official?', kind: 'radio', options: ['Yes', 'No'] },
    {
      id: '0:7',
      question: 'Have you ever been convicted of a criminal offence?',
      kind: 'select',
      options: ['Yes', 'No'],
    },
    { id: '0:8', question: 'What is your gender?', kind: 'select', options: ['Male', 'Female'] },
  ];
  const seen = [];
  const chat = async (messages) => {
    seen.push(messages.map((m) => m.role + '\n' + m.content).join('\n\n'));
    const last = messages[messages.length - 1].content;
    if (/strict fact-checker/.test(messages[0].content)) return { json: { unsupported: [] } };
    const qs = JSON.parse(last.slice(last.indexOf('QUESTIONS:') + 10));
    const json = {
      answers: qs.map((q) =>
        /why/i.test(q.question)
          ? {
              id: q.id,
              answer:
                'At Finch & Partners I built an Excel model of 40 retailers’ margins in Python, and I want to bring that care to the models Acme Capital’s desk builds for its clients every day.',
            }
          : { id: q.id, skip: true, reason: 'x' },
      ),
    };
    return { json, text: JSON.stringify(json) };
  };
  const input = {
    profile: p,
    kit: { notes: 'Ran the investment society.' },
    cvText: '',
    guidance: 'I have never applied to Acme before.',
    job: { company: 'Acme Capital', title: 'Rates Summer Analyst', description: 'Rates desk.' },
    bank: [
      {
        question: 'Why do you want to work at Goldman Sachs?',
        answer: 'Because the work in markets suits what I have done so far in modelling and data.',
        company: 'Goldman Sachs',
        at: 1,
      },
    ],
    today: new Date('2026-10-02').getTime(),
    ...(allow !== undefined ? { allow } : {}),
  };
  const out = await A.answer(chat, input, items);
  return { seen, out };
}

const sha = (s) => require('node:crypto').createHash('sha256').update(s).digest('hex');

test('prompt: with nothing allowed, every message is byte for byte the one the eval measured', async () => {
  // Recorded before the sensitive kinds existed. The eval's numbers and the provider's prompt cache hold for these
  // prompts: a change to them is a change to measure (tests/eval) before these hashes are updated.
  const GB = '24d8df20b5265058e42902ae3f7abc687d35af7c59edaddc9d5fd79c8a605f1f';
  const US = 'e4855be7d06406841879bcb0734c2149dd61fa755f87bf56ef2964e523b70afe';
  const RUN = '2e575e3897aa16a445843f786c0fd3f05541a7cc1e82fcfd0a734b2b8283ec0c';
  for (const allow of [undefined, null, {}, NONE]) {
    assert.equal(sha(A.systemPrompt({ name: 'Alex Morgan', lang: 'en-GB', allow })), GB);
    assert.equal(sha(A.systemPrompt({ name: 'Alex Morgan', lang: 'en-US', allow })), US);
    const run = await defaultRun(allow);
    assert.equal(run.seen.length, 2, 'the answers and the fact-check');
    assert.equal(sha(run.seen.join('\n=====\n')), RUN);
    assert.deepEqual(
      run.out.skipped.filter((s) => s.withheld).map((s) => [s.id, s.withheld]),
      [
        ['0:3', 'eeo'],
        ['0:8', 'eeo'],
      ],
    );
  }
  assert.notEqual(sha(A.systemPrompt({ name: 'Alex Morgan', lang: 'en-GB', allow: only('health') })), GB);
});

test('prompt: each kind’s rules only when it is allowed, and the default rules drop what it answers', () => {
  const sys = (allow) => A.systemPrompt({ name: 'Alex Morgan', lang: 'en-GB', allow });
  const RULES = {
    eeo: /answer only from EQUAL-OPPORTUNITY ANSWERS/,
    consent: /A typed signature box gets the candidate’s full legal name/,
    legal: /answer as someone with nothing to declare/,
    health: /no adjustments or accommodations needed/,
    identity: /only a number or date that appears in CANDIDATE MATERIAL/,
  };
  const none = sys(NONE);
  assert.doesNotMatch(none, /Questions the candidate has asked you to answer too/);
  for (const re of Object.values(RULES)) assert.doesNotMatch(none, re);
  for (const kind of A.SENSITIVE) {
    const one = sys(only(kind));
    assert.match(one, /Questions the candidate has asked you to answer too:/, kind);
    for (const [k, re] of Object.entries(RULES)) (k === kind ? assert.match : assert.doesNotMatch)(one, re, kind);
  }
  assert.match(
    none,
    /^- Never answer diversity or equal-opportunity monitoring \([^)]*\), declarations, consents or signatures: skip them\.$/m,
  );
  assert.match(sys(only('eeo')), /^- Never answer declarations, consents or signatures: skip them\.$/m);
  assert.doesNotMatch(sys(only('eeo')), /Never answer diversity/);
  assert.match(
    sys(only('consent')),
    /^- Never answer diversity or equal-opportunity monitoring \([^)]*\): skip them\.$/m,
  );
  assert.doesNotMatch(sys({ ...NONE, eeo: true, consent: true }), /^- Never answer/m);
  assert.match(
    none,
    /a relative, an offer, a visa detail, a grade not stated, a criminal, regulatory or health matter\)/,
  );
  assert.match(
    sys(only('legal')),
    /a past application, an offer, a visa detail, a grade not stated, a health matter\)/,
  );
  assert.match(
    sys(only('health')),
    /a relative, an offer, a visa detail, a grade not stated, a criminal or regulatory matter\)/,
  );
  assert.match(
    sys({ ...NONE, legal: true, health: true }),
    /\(a score, an ID, a referee or referrer, a past application, an offer, a visa detail, a grade not stated\), skip it/,
  );
  // Never inferred, never opted in, never made up.
  assert.match(sys(ALL), /Never infer race, ethnicity, gender, religion, sexuality, disability or background/);
  assert.match(sys(ALL), /Never opt in to marketing/);
  assert.match(sys(ALL), /Never make one up/);
});

test('questionJson: the answer before a question only when the model may see that question itself', () => {
  const after = (question, answer, allow, guidance) =>
    A.questionJson(
      {
        id: 'q1',
        question: 'Anything else you would like us to know?',
        kind: 'textarea',
        follows: { question, answer },
      },
      [],
      allow,
      guidance,
    ).follows.answer;
  // Typed into boxes the rules didn't recognise: never repeated to the model, whatever is allowed for secrets.
  assert.equal(after('Date of birth', '1990-12-10'), '(withheld)');
  assert.equal(after('National Insurance number', 'QQ123456C'), '(withheld)');
  assert.equal(after('Password', 'hunter2'), '(withheld)');
  assert.equal(after('Password', 'hunter2', ALL), '(withheld)');
  assert.equal(after('Card number', '4242 4242 4242 4242', ALL), '(withheld)');
  assert.equal(after('What is your ethnicity?', 'Asian – Chinese'), '(withheld)');
  assert.equal(after('Have you ever been convicted of a criminal offence?', 'No'), '(withheld)');
  // A kind the candidate lets the model answer (or guidance it may follow) lets its answer through too.
  assert.equal(after('National Insurance number', 'QQ123456C', only('identity')), 'QQ123456C');
  assert.equal(after('What is your ethnicity?', 'Asian – Chinese', only('eeo')), 'Asian – Chinese');
  assert.equal(after('Have you ever been convicted of a criminal offence?', 'No', only('legal')), 'No');
  assert.equal(after('Have you ever been convicted of a criminal offence?', 'No', NONE, 'No convictions.'), 'No');
  // Anything else as before.
  assert.equal(after('Do you have any other offers?', 'Yes'), 'Yes');
  assert.equal(after('Date of birth', ''), '(not answered)');
});

test('questionJson: a monitoring answer and relatives at the employer, only as the candidate allows', () => {
  const eeo = {
    question: 'Gender',
    kind: 'select',
    options: ['Woman', 'Man'],
    guess: { type: 'eeo.gender', value: 'Female' },
  };
  assert.equal(A.questionJson(eeo).profileValue, undefined);
  assert.equal(A.questionJson(eeo, [], only('legal')).profileValue, undefined);
  assert.equal(A.questionJson(eeo, [], only('eeo')).profileValue, 'Female');
  const relatives = { question: 'Do you have any relatives working at Acme?', kind: 'select', options: ['Yes', 'No'] };
  assert.equal(A.questionJson(relatives).answerOnlyFrom, 'material or guidance');
  assert.equal(A.questionJson(relatives, [], only('eeo')).answerOnlyFrom, 'material or guidance');
  assert.equal(A.questionJson(relatives, [], only('legal')).answerOnlyFrom, undefined);
  // A referral or an earlier application is still the candidate's alone to tell.
  for (const question of ['Who referred you? (a friend, a family member…)', 'Have you applied to Acme before?'])
    assert.equal(A.questionJson({ question, kind: 'text' }, [], ALL).answerOnlyFrom, 'material or guidance', question);
});

test('answer: diversity questions once allowed, from the candidate’s own answers in a block of their own', async () => {
  const p = profile();
  Object.assign(p.eeo, { gender: 'Female', schoolType: 'State school (non-selective)' });
  const items = [
    {
      id: '0:1',
      question: 'What is your gender?',
      kind: 'select',
      options: ['Woman', 'Man', 'Prefer not to say'],
      guess: { type: 'eeo.gender', value: 'Female' },
    },
    {
      id: '0:2',
      question: 'What is your religion?',
      kind: 'select',
      options: ['Christian', 'None', 'Prefer not to say'],
    },
  ];
  const script = { answer: (q) => ({ id: q.id, answer: /gender/i.test(q.question) ? 'Woman' : 'Prefer not to say' }) };
  const input = { profile: p, kit: {}, cvText: '', job: { company: 'Acme Capital' }, today: CTX.today };

  const off = fakeChat(script);
  const before = await A.answer(off.chat, input, items);
  assert.equal(off.calls.length, 0, 'nothing is sent');
  const reason = 'diversity question: yours, or let the AI answer these in Settings › Cover letters & AI';
  assert.deepEqual(
    before.skipped.map((s) => [s.withheld, s.reason]),
    [
      ['eeo', reason],
      ['eeo', reason],
    ],
  );

  const on = fakeChat(script);
  const after = await A.answer(on.chat, { ...input, allow: only('eeo') }, items);
  const sent = on.calls[0].last;
  assert.match(
    sent,
    /EQUAL-OPPORTUNITY ANSWERS \(the candidate’s own[^\n]*\nGender: Female\nType of school \(age 11–16\): State school \(non-selective\)\n/,
  );
  assert.doesNotMatch(sent, /Religion or belief:/, 'an answer left on “— don’t fill —” isn’t listed');
  assert.match(sent, /"profileValue": "Female"/);
  assert.match(on.calls[0].system, /answer only from EQUAL-OPPORTUNITY ANSWERS/);
  assert.deepEqual(
    after.answers.map((a) => [a.id, a.value]),
    [
      ['0:1', 'Woman'],
      ['0:2', 'Prefer not to say'],
    ],
  );
  // Nothing in Voluntary disclosures: the block says so, and every monitoring question gets its declining option.
  const empty = fakeChat(script);
  await A.answer(empty.chat, { ...input, profile: profile(), allow: only('eeo') }, items);
  assert.match(empty.calls[0].last, /EQUAL-OPPORTUNITY ANSWERS[^\n]*\n\(none\)\n/);
  // The other kinds never send it.
  const rest = fakeChat(script);
  await A.answer(rest.chat, { ...input, allow: { ...ALL, eeo: false } }, [
    ...items,
    { id: '0:3', question: 'Why Acme?', kind: 'textarea' },
  ]);
  assert.doesNotMatch(rest.calls[0].last, /EQUAL-OPPORTUNITY ANSWERS|Gender: Female/);
});

test('answer: with legal allowed, “nothing to declare” survives the checks and the fact-check; nothing else does', async () => {
  const p = profile();
  p.compliance.criminal = 'No';
  const DECLARE =
    'I have no criminal convictions, cautions or pending charges, and I have never been the subject of regulatory or disciplinary action by a regulator, an employer or a university at any point.';
  const WHY =
    'At Finch & Partners I built an Excel model of 40 retailers’ margins in Python, and I am not afraid of the long hours that Acme Capital’s Rates desk asks of its analysts every single week.';
  const items = [
    {
      id: '0:1',
      question: 'Are you, or is any member of your family, a government official?',
      kind: 'radio',
      options: ['Yes', 'No'],
    },
    {
      id: '0:2',
      question: 'Please give details of any criminal convictions or regulatory history (100 words)',
      kind: 'textarea',
    },
    { id: '0:3', question: 'Why do you want to join Acme Capital? (100 words)', kind: 'textarea' },
  ];
  const script = {
    answer: (q) => ({
      id: q.id,
      answer: /government/.test(q.question) ? 'No' : /details/.test(q.question) ? DECLARE : WHY,
    }),
    audit: () => ({
      unsupported: [
        { id: 'q2', quote: 'I have no criminal convictions, cautions or pending charges', problem: 'not stated' },
        { id: 'q3', quote: 'I am not afraid of the long hours', problem: 'not stated' },
      ],
    }),
    fix: (last) => ({
      answers: [...last.matchAll(/^- (q\d+):/gm)].map((m) => ({ id: m[1], skip: true, reason: 'unsure' })),
    }),
  };
  const input = { profile: p, kit: {}, cvText: '', job: { company: 'Acme Capital' }, today: CTX.today };

  const on = fakeChat(script);
  const out = await A.answer(on.chat, { ...input, allow: only('legal') }, items);
  const byId = Object.fromEntries(out.answers.map((a) => [a.id, a]));
  assert.equal(byId['0:1'].value, 'No', 'the government-official question the profile left empty');
  assert.equal(byId['0:2'].value, DECLARE);
  assert.deepEqual(byId['0:2'].warnings, []);
  assert.equal(byId['0:3'], undefined, 'a doubt about anything else still sends it back, and the skip stands');
  const fixes = on.calls.filter((c) => /^Some answers need fixing/.test(c.last));
  assert.equal(fixes.length, 1);
  assert.match(fixes[0].last, /^- q3:/m);
  assert.doesNotMatch(fixes[0].last, /^- q2:/m);
  // What the model and the fact-check see: the profile's declarations, and the standing answers.
  assert.match(on.calls[0].last, /Has criminal convictions: No/);
  assert.match(on.calls[0].system, /answer as someone with nothing to declare/);
  const audit = on.calls.find((c) => /strict fact-checker/.test(c.system));
  assert.match(audit.last, /Standing answers wherever the material says nothing:\nNo criminal convictions/);

  // Without it (but with guidance, so it is asked), the same doubt sends the answer back.
  const off = fakeChat(script);
  const before = await A.answer(off.chat, { ...input, guidance: 'Answer legal questions honestly.' }, items);
  assert.ok(!before.answers.some((a) => a.id === '0:2'));
  assert.match(off.calls.find((c) => /^Some answers need fixing/.test(c.last)).last, /^- q2:/m);
  assert.doesNotMatch(off.calls[0].last, /Has criminal convictions/);
  assert.doesNotMatch(off.calls.find((c) => /strict fact-checker/.test(c.system)).last, /Standing answers/);
});

test('answer: health questions once allowed; every reason left says why, and where to switch it on', async () => {
  const items = [
    {
      id: 'a',
      question: 'Do you require any reasonable adjustments during the recruitment process?',
      kind: 'select',
      options: ['Yes', 'No'],
    },
    {
      id: 'b',
      question: 'Have you ever been convicted of a criminal offence?',
      kind: 'select',
      options: ['Yes', 'No'],
    },
    { id: 'c', question: 'Password', kind: 'text' },
    { id: 'd', question: 'I agree to receive marketing emails', kind: 'checkbox' },
    { id: 'e', question: 'Signature', kind: 'text' },
    { id: 'f', question: 'Student ID number', kind: 'text' },
  ];
  const { chat, calls } = fakeChat({ answer: (q) => ({ id: q.id, answer: 'No' }) });
  const out = await A.answer(chat, { profile: profile(), kit: {}, cvText: '', job: {}, allow: only('health') }, items);
  assert.deepEqual(
    out.answers.map((a) => [a.id, a.value]),
    [['a', 'No']],
  );
  assert.match(calls[0].system, /no adjustments or accommodations needed/);
  const settings = 'Settings › Cover letters & AI';
  assert.deepEqual(Object.fromEntries(out.skipped.map((s) => [s.id, [s.withheld, s.reason]])), {
    b: ['guidance', `add how to answer this to your answer guidance, or let the AI answer these in ${settings}`],
    c: ['secret', 'a password or bank details: never sent to the AI'],
    d: ['optin', 'a marketing or talent-pool opt-in: always yours'],
    e: ['consent', `a declaration for you to confirm, or let the AI confirm these in ${settings}`],
    f: ['identity', `an ID number or date of birth: yours, or let the AI answer these in ${settings}`],
  });
});

test('answer: declarations once allowed: a typed signature is the full legal name; marketing is never picked', async () => {
  const p = profile();
  Object.assign(p.personal, { middleName: 'James', preferredName: 'Al' });
  const items = [
    { id: 's', question: 'Signature', kind: 'text' },
    { id: 't', question: 'I confirm the information I have provided is accurate and complete', kind: 'checkbox' },
    {
      id: 'u',
      question: 'Please confirm that you agree to the following',
      kind: 'checkboxes',
      options: ['I agree to the candidate privacy notice', 'Keep me updated about future opportunities'],
      multiple: true,
    },
    { id: 'v', question: 'I agree to receive marketing emails from Acme', kind: 'checkbox' },
    {
      id: 'w',
      question: 'Please disclose whether AI tools were used to help with this application.',
      kind: 'textarea',
    },
  ];
  const REPLIES = {
    Signature: 'Alex James Morgan',
    'Please confirm that you agree to the following': [
      'I agree to the candidate privacy notice',
      'Keep me updated about future opportunities',
    ],
    'Please disclose whether AI tools were used to help with this application.':
      'Yes: AI tools helped me draft the written answers in this application.',
  };
  const { chat, calls } = fakeChat({ answer: (q) => ({ id: q.id, answer: REPLIES[q.question] || 'Yes' }) });
  const out = await A.answer(chat, { profile: p, kit: {}, cvText: '', job: {}, allow: only('consent') }, items);
  const byId = Object.fromEntries(out.answers.map((a) => [a.id, a.value]));
  assert.equal(byId.s, 'Alex James Morgan');
  assert.equal(byId.t, 'Yes');
  assert.deepEqual(byId.u, ['I agree to the candidate privacy notice'], 'the opt-in among them is left');
  assert.match(byId.w, /AI tools helped me draft/);
  assert.equal(out.skipped.find((s) => s.id === 'v').withheld, 'optin');
  assert.doesNotMatch(calls[0].last, /marketing emails/, 'an opt-in is never even asked');
  assert.match(calls[0].last, /Full legal name \(for a typed signature\): Alex James Morgan/);
  assert.match(calls[0].system, /Never opt in to marketing/);
});

test('answer: an ID number or date of birth only as the candidate’s own material gives it', async () => {
  const p = profile();
  p.personal.dob = '2004-03-09';
  const items = [
    { id: 'ni', question: 'National Insurance number', kind: 'text' },
    { id: 'dob', question: 'Date of birth', kind: 'date' },
    { id: 'dob2', question: 'Date of birth (DD/MM/YYYY)', kind: 'text' },
    { id: 'sid', question: 'Student ID number', kind: 'text' },
    { id: 'pp', question: 'Passport number', kind: 'number' },
    { id: 'ucas', question: 'UCAS ID', kind: 'text' },
  ];
  const REPLIES = {
    'National Insurance number': 'QQ 12 34 56 C',
    'Date of birth': '2004-03-09',
    'Date of birth (DD/MM/YYYY)': '09/03/2004',
    'Student ID number': '20240931',
    'Passport number': '40',
    'UCAS ID': '123-456-7890',
  };
  const script = { answer: (q) => ({ id: q.id, answer: REPLIES[q.question] }) };
  const input = {
    profile: p,
    kit: {},
    cvText: '',
    guidance: 'My National Insurance number is QQ123456C. My UCAS ID is 123-456-7890.',
    job: { company: 'Acme Capital', description: 'Job reference 20240931.' },
    today: CTX.today,
  };
  const off = fakeChat(script);
  const before = await A.answer(off.chat, input, items);
  assert.equal(off.calls.length, 0);
  assert.ok(before.skipped.every((s) => s.withheld === 'identity'));

  const on = fakeChat(script);
  const out = await A.answer(on.chat, { ...input, allow: only('identity') }, items);
  assert.deepEqual(Object.fromEntries(out.answers.map((a) => [a.id, a.value])), {
    ni: 'QQ 12 34 56 C',
    dob: '2004-03-09',
    dob2: '09/03/2004',
    ucas: '123-456-7890',
  });
  const left = Object.fromEntries(out.skipped.map((s) => [s.id, s.reason]));
  assert.match(left.sid, /isn’t in your material/, 'the posting’s reference is not the candidate’s student number');
  assert.match(left.pp, /isn’t in your material/, '“40 retailers” is not a passport number');
  assert.match(on.calls[0].last, /Date of birth: 2004-03-09/);
  // The date of birth goes only with ID questions.
  const legal = fakeChat(script);
  await A.answer(legal.chat, { ...input, allow: only('legal') }, [
    { id: 'x', question: 'Why Acme?', kind: 'textarea' },
  ]);
  assert.doesNotMatch(legal.calls[0].last, /Date of birth/);
});

test('inMaterial: a number as the material writes it, spacing aside; a date however it is written', () => {
  const own = 'Name: Alex Morgan\nDate of birth: 2004-03-09\nNI: QQ123456C\nBuilt a model of 40 retailers in 2025.';
  assert.equal(A.inMaterial('QQ 12 34 56 C', own), true);
  assert.equal(A.inMaterial('qq123456c', own), true);
  assert.equal(A.inMaterial('QQ123456D', own), false);
  assert.equal(A.inMaterial('09/03/2004', own), true);
  assert.equal(A.inMaterial('9 March 2004', own), true);
  assert.equal(A.inMaterial('March 9, 2004', own), true);
  assert.equal(A.inMaterial('10/03/2004', own), false);
  assert.equal(A.inMaterial('2004', own), false, 'a year alone is no date of birth, and too short for an ID');
  assert.equal(A.inMaterial('2004-03', own), true, 'the month and year of the date of birth');
  assert.equal(A.inMaterial('2005-03', own), false);
  // Never pieced together from neighbouring words, nor anything without a number.
  assert.equal(A.inMaterial('402025', own), false);
  assert.equal(A.inMaterial('N/A', own), false);
  assert.equal(A.inMaterial('My NI number is QQ123456C', own), false);
});

test('application facts: adjustments and clearance only go when their questions can', async () => {
  const p = profile();
  Object.assign(p.job, { adjustments: 'Yes', clearance: 'SC', clearanceEligible: 'Yes' });
  const ADJUST = /Needs adjustments in the recruitment process: Yes/;
  const CLEARANCE = /Security clearance held: SC\nCould obtain security clearance: Yes/;
  const facts = (allow, guidance) => A.applicationFacts(p, allow, guidance);
  assert.doesNotMatch(facts(), ADJUST);
  assert.doesNotMatch(facts(), CLEARANCE);
  assert.doesNotMatch(facts(only('legal')), ADJUST);
  assert.match(facts(only('health')), ADJUST);
  assert.doesNotMatch(facts(only('health')), CLEARANCE);
  assert.match(facts(only('legal')), CLEARANCE);
  // With answer guidance, legal and health questions go (withheld()), and so do these.
  assert.match(facts(NONE, 'I need extra time in written tests.'), ADJUST);
  assert.match(facts(NONE, 'I need extra time in written tests.'), CLEARANCE);
  assert.match(A.candidateText({ profile: p, kit: { answerNotes: 'No convictions.' }, cvText: '' }), ADJUST);

  // The adjustments question is withheld, and its answer doesn't ride along with an unrelated one.
  const sent = [];
  const chat = async (messages) => {
    sent.push(messages.map((m) => m.content).join('\n'));
    const last = messages.at(-1).content;
    if (!last.includes('QUESTIONS:')) return { json: { unsupported: [] } };
    const qs = JSON.parse(last.slice(last.indexOf('QUESTIONS:') + 10));
    return { json: { answers: qs.map((q) => ({ id: q.id, skip: true })) } };
  };
  const items = [
    {
      id: '0:1',
      question: 'Do you require any reasonable adjustments during the interview process?',
      kind: 'select',
      options: ['Yes', 'No'],
    },
    { id: '0:2', question: 'Which office would you prefer?', kind: 'select', options: ['London', 'Paris'] },
  ];
  const out = await A.answer(chat, { profile: p, kit: {}, cvText: '', job: { company: 'Acme' }, bank: [] }, items);
  assert.equal(out.skipped.find((s) => s.id === '0:1').withheld, 'guidance');
  assert.doesNotMatch(sent.join('\n'), /adjustments in the recruitment process|Security clearance held/);
});

test('answer: a batch whose call fails leaves only its own questions; stopped or all failed, the run fails', async () => {
  const p = profile();
  const items = Array.from({ length: 12 }, (_, i) => ({
    id: `0:${i}`,
    question: `Which office would you prefer, option set ${i}?`,
    kind: 'select',
    options: ['London', 'Paris'],
  }));
  const run = (fail) => {
    let n = 0;
    const chat = async (messages, { signal } = {}) => {
      const last = messages.at(-1).content;
      if (!last.includes('QUESTIONS:')) return { json: { unsupported: [] } };
      const qs = JSON.parse(last.slice(last.indexOf('QUESTIONS:') + 10));
      if (fail(n++, signal)) throw new JTF.ai.AIError('The model’s reply was not valid JSON.', { code: 'json' });
      return { json: { answers: qs.map((q) => ({ id: q.id, answer: 'London', basis: 'material' })) } };
    };
    return chat;
  };
  const input = { profile: p, kit: {}, cvText: '', job: { company: 'Acme' }, bank: [] };
  // The second batch (questions 11 and 12) fails: the first batch's ten answers still go in.
  const out = await A.answer(
    run((n) => n === 1),
    input,
    items,
  );
  assert.equal(out.answers.length, 10);
  assert.deepEqual(
    out.skipped.map((s) => [s.id, s.reason]),
    [
      ['0:10', 'the AI’s reply failed: The model’s reply was not valid JSON.'],
      ['0:11', 'the AI’s reply failed: The model’s reply was not valid JSON.'],
    ],
  );
  await assert.rejects(
    A.answer(
      run(() => true),
      input,
      items,
    ),
    /not valid JSON/,
  );
  // Stopped: nothing goes in, whatever the other batch managed.
  const controller = new AbortController();
  const stop = run((n) => {
    if (n !== 1) return false;
    controller.abort();
    return true;
  });
  await assert.rejects(A.answer(stop, input, items, { signal: controller.signal }), /not valid JSON/);
});
