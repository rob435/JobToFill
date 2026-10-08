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
