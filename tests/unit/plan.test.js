'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, desc, opts } = require('./helpers');

const { matcher, fields, util } = load();

function sample() {
  const p = fields.createProfile('Test');
  Object.assign(p.personal, { firstName: 'Ada', lastName: 'Lovelace' });
  Object.assign(p.contact, { email: 'ada@example.com', phoneCountryCode: '+44', phone: '20 7946 0958' });
  Object.assign(p.address, {
    line1: '12 St James Square',
    city: 'London',
    state: '',
    postalCode: 'SW1Y 4JH',
    country: 'United Kingdom',
  });
  p.education = [
    {
      school: 'University of London',
      degree: 'BSc',
      field: 'Mathematics',
      gpa: '3.9',
      location: 'London',
      startDate: '2015-09',
      endDate: '2019-06',
    },
    {
      school: 'Cambridge',
      degree: 'MSc',
      field: 'Computing',
      gpa: '',
      location: 'Cambridge',
      startDate: '2019-10',
      endDate: '2020-07',
    },
  ];
  p.experience = [
    {
      company: 'Analytical Engines',
      title: 'Engineer',
      location: 'London',
      startDate: '2020-08',
      endDate: '',
      current: true,
      description: 'Built engines.',
    },
    {
      company: 'Babbage & Co',
      title: 'Intern',
      location: 'London',
      startDate: '2019-06',
      endDate: '2019-09',
      current: false,
      description: 'Interned.',
    },
  ];
  return p;
}

const types = (plan) =>
  plan.results.map((r) =>
    r && r.type ? r.type + (r.index != null ? '#' + r.index : '') + (r.part ? ':' + r.part : '') : null,
  );

test('repeated sections map to successive entries; generic boxes take their section', () => {
  const page = [
    desc('First name'),
    desc('Email', { kind: 'email' }),
    desc('Job title'),
    desc('Company'),
    desc('Location'),
    desc('I currently work here', { kind: 'checkbox' }),
    desc({ label: 'From', placeholder: 'MM' }),
    desc({ placeholder: 'YYYY', name: 'from_year' }),
    desc('Role description', { kind: 'textarea' }),
    desc('Job title'),
    desc('Company'),
    desc('Location'),
    desc('School'),
    desc('Degree', { kind: 'select', options: opts('BS', 'MS') }),
    desc('Start date'),
    desc('End date'),
    desc('School'),
    desc('Start date'),
  ];
  const plan = matcher.plan(page, sample());
  assert.deepEqual(types(plan), [
    'name.first',
    'email',
    'exp.title#0',
    'exp.company#0',
    'exp.location#0',
    'exp.current#0',
    'exp.start#0:month',
    'exp.start#0:year',
    'exp.description#0',
    'exp.title#1',
    'exp.company#1',
    'exp.location#1',
    'edu.school#0',
    'edu.degree#0',
    'edu.start#0',
    'edu.end#0',
    'edu.school#1',
    'edu.start#1',
  ]);
  assert.equal(plan.context.jobContext, true);
});

test('generic date boxes with no section are dropped, and a top-level Location stays yours', () => {
  const plan = matcher.plan([desc('Location'), desc('Start date'), desc('City')], sample());
  assert.deepEqual(types(plan), ['location', null, 'address.city']);
});

test('custom answers override and use the question text', () => {
  const p = sample();
  p.customAnswers = [
    { id: 'a1', question: 'why do you want to work', answer: 'Because engines.' },
    { id: 'a2', question: '/previously (worked|been employed)/', answer: 'No' },
    { id: 'a3', question: 'unused', answer: '' },
  ];
  const plan = matcher.plan(
    [
      desc('Why do you want to work at Acme?', { kind: 'textarea' }),
      desc({ question: 'Have you previously worked for Acme?' }, { kind: 'radio', options: opts('Yes', 'No') }),
      desc('First name'),
    ],
    p,
  );
  assert.equal(plan.results[0].type, 'custom');
  assert.equal(plan.results[0].answer, 'Because engines.');
  assert.equal(plan.results[1].answer, 'No');
  assert.equal(plan.results[2].type, 'name.first');
  const v = fields.resolve('custom', p, { answer: plan.results[1].answer });
  assert.equal(matcher.matchOption(opts('Yes', 'No'), v), 1);
});

test('sign-up detection', () => {
  const p = sample();
  assert.equal(
    matcher.plan([desc('Email', { kind: 'email' }), desc('Password', { kind: 'password' })], p).context.signup,
    false,
  );
  assert.equal(
    matcher.plan([desc('Password', { kind: 'password' }), desc('Confirm password', { kind: 'password' })], p).context
      .signup,
    true,
  );
  assert.equal(
    matcher.plan([desc('Password', { kind: 'password', autocomplete: 'new-password' })], p).context.signup,
    true,
  );
});

test('company on a checkout form is not your employer', () => {
  const p = sample();
  const checkout = matcher.plan([desc('First name'), desc('Company (optional)'), desc('Address'), desc('City')], p);
  assert.equal(checkout.context.jobContext, false);
  const r = checkout.results[1];
  assert.equal(r.type, 'exp.company');
  assert.equal(fields.resolve(r.type, p, Object.assign({}, checkout.context, { index: 0 })), null);
  p.address.organization = 'Lovelace Ltd';
  assert.equal(fields.resolve(r.type, p, Object.assign({}, checkout.context, { index: 0 })).text, 'Lovelace Ltd');
});

test('value resolution', () => {
  const p = sample();
  const ctx = (extra) => Object.assign({ jobContext: true, index: 0 }, extra);
  assert.equal(fields.resolve('name.full', p).text, 'Ada Lovelace');
  assert.equal(fields.resolve('name.preferred', p).text, 'Ada Lovelace', 'full legal name by default');
  assert.equal(fields.resolve('phone', p, ctx()).text, '+44 20 7946 0958');
  assert.equal(fields.resolve('phone', p, ctx({ hasCountryCodeField: true })).text, '20 7946 0958');
  assert.equal(fields.resolve('location', p).text, 'London, United Kingdom');
  assert.equal(
    fields.resolve('address.line1', p, ctx({ kind: 'textarea' })).text,
    '12 St James Square\nLondon, SW1Y 4JH\nUnited Kingdom',
  );
  assert.equal(fields.resolve('job.currentCompany', p).text, 'Analytical Engines');
  assert.equal(fields.resolve('exp.end', p, ctx({ index: 0 })), null, 'no end date for a current job');
  assert.equal(fields.resolve('exp.end', p, ctx({ index: 1, part: 'year' })).text, '2019');
  assert.equal(fields.resolve('exp.current', p, ctx({ index: 0 })).canonical, 'yes');
  assert.equal(fields.resolve('edu.school', p, ctx({ index: 1 })).text, 'Cambridge');
  assert.equal(fields.resolve('edu.school', p, ctx({ index: 5 })), null);
  assert.equal(fields.resolve('job.authorized', p), null, 'unanswered questions are skipped');
  assert.equal(fields.resolve('account.password', p, ctx()), null, 'no password unless the background sent one');
  assert.equal(
    fields.resolve('cc.number', p, ctx({ secrets: { card: { number: '4242 4242 4242 4242' } } })).text,
    '4242424242424242',
  );
  assert.equal(
    fields.resolve('cc.type', p, ctx({ secrets: { card: { number: '5555555555554444' } } })).text,
    'Mastercard',
  );
});

test('formatting for text boxes', () => {
  const p = sample();
  const f = (type, extra, d) =>
    matcher.formatForText(
      fields.resolve(type, p, Object.assign({ jobContext: true, index: 0 }, extra)),
      Object.assign({ inputType: 'text', maxLength: 0, placeholderRaw: '' }, d),
    );
  assert.equal(f('edu.start', {}, {}), '09/2015');
  // A box that opens a calendar takes a whole date, in the page's order.
  assert.equal(f('edu.start', {}, { popup: 'dialog', lang: 'en-GB' }), '01/09/2015');
  assert.equal(f('edu.start', {}, { popup: 'dialog' }), '09/01/2015');
  const asked = { signals: { label: 'When did you start this degree?' }, lang: 'en-GB' };
  assert.equal(f('edu.start', {}, asked), 'September 2015');
  assert.equal(f('edu.start', {}, { ...asked, popup: 'dialog' }), '01/09/2015');
  assert.equal(f('edu.start', {}, { inputType: 'month' }), '2015-09');
  assert.equal(f('edu.start', {}, { inputType: 'date' }), '2015-09-01');
  assert.equal(f('edu.start', {}, { placeholderRaw: 'YYYY-MM' }), '2015-09');
  assert.equal(f('edu.start', {}, { placeholderRaw: 'MM/YY' }), '09/15');
  assert.equal(f('edu.start', { part: 'month' }, { placeholderRaw: 'MM' }), '09');
  assert.equal(f('edu.start', { part: 'year' }, { maxLength: 2 }), '15');
  p.personal.dob = '1815-12-10';
  assert.equal(f('dob', {}, { placeholderRaw: 'DD/MM/YYYY' }), '10/12/1815');
  assert.equal(f('dob', {}, { placeholderRaw: 'mm-dd-yyyy' }), '12-10-1815');
  assert.equal(f('dob', {}, {}), '12/10/1815');
  p.address.country = 'United States';
  p.address.state = 'California';
  assert.equal(f('address.state', {}, { maxLength: 2 }), 'CA');
  assert.equal(f('address.country', {}, { maxLength: 2 }), 'US');
  assert.equal(f('address.country', {}, { maxLength: 3 }), 'USA');
  p.job.salary = '$120k';
  assert.equal(f('job.salary', {}, { inputType: 'number' }), '120000');
  const card = { secrets: { card: { expMonth: 4, expYear: 2029 } } };
  assert.equal(f('cc.exp', card, {}), '04/29');
  assert.equal(f('cc.exp', card, { placeholderRaw: 'MM / YYYY' }), '04/2029');
  assert.equal(f('cc.exp', card, { inputType: 'month' }), '2029-04');
});

function student() {
  const p = fields.createProfile('Student');
  Object.assign(p.address, { city: 'San Francisco', state: 'CA', country: 'United States' });
  p.education = [
    { school: 'UCL', degree: 'BSc', field: 'Mathematics', gpa: '3.9', startDate: '2024-09', endDate: '2027-06' },
  ];
  p.skills = 'Python, SQL, Excel';
  p.languages = 'English, French, German';
  return p;
}
const ask = (p, type, question, extra) =>
  fields.resolve(type, p, Object.assign({ jobContext: true, index: 0, question: util.normalize(question) }, extra));

test('grades: a GPA picks its band, a UK class picks its option by name', () => {
  const p = student();
  const gpa = ask(p, 'edu.gpa', 'GPA');
  assert.equal(gpa.number, 3.9);
  assert.equal(matcher.matchOption(opts('Below 3.0', '3.00 - 3.49', '3.50 - 3.79', '3.80 - 4.00'), gpa), 3);
  p.education[0].gpa = '3.9/4.0';
  assert.equal(ask(p, 'edu.gpa', 'GPA').number, 3.9);
  p.education[0].gpa = '2:1';
  const uk = ask(p, 'edu.gpa', 'Predicted degree classification');
  assert.equal(uk.number, undefined);
  assert.equal(matcher.matchOption(opts('First', '2:1 (Upper Second)', '2:2', 'Third'), uk), 1);
});

test('"Will you graduate between X and Y?" is answered from your graduation date', () => {
  const p = student(); // graduates June 2027
  const grad = (q) => {
    const v = ask(p, 'edu.end', q);
    return v && v.canonical ? v.text : v && v.text;
  };
  assert.equal(grad('Will you graduate between December 2026 and July 2027?'), 'Yes');
  assert.equal(grad('Will you graduate between December 2028 and July 2029?'), 'No');
  assert.equal(grad('I confirm that my graduation date will be either Spring 2027 or Summer 2027'), 'Yes');
  assert.equal(grad('I confirm that my graduation date will be either Fall 2026 or Spring 2027'), 'No');
  assert.equal(grad('Will you graduate before 2028?'), 'Yes');
  assert.equal(grad('Will you graduate by 2027?'), 'Yes');
  assert.equal(grad('Will you graduate after 2027?'), 'No');
  assert.equal(grad('Will you graduate in 2027?'), 'Yes');
  assert.equal(grad('Are you graduating in 2026?'), 'No');
  assert.equal(grad('What is your expected graduation date?'), '2027-06', 'a plain question gets the date');
});

test('year of study is worked out from the course dates', () => {
  const p = student(); // Sep 2024 – Jun 2027
  const year = (y, m) => fields.resolve('edu.year', p, { today: new Date(y, m - 1, 1) });
  assert.equal(year(2024, 6), null, 'before the course starts');
  assert.equal(year(2024, 10).text, '1st year');
  assert.ok(year(2024, 10).candidates.includes('Freshman'));
  const third = year(2026, 10);
  assert.equal(third.text, '3rd year');
  assert.ok(third.candidates.includes('Final year'));
  assert.equal(matcher.matchOption(opts('First year', 'Second year', 'Final year'), third), 2);
  assert.equal(matcher.matchOption(opts('Year 1', 'Year 2', 'Year 3', 'Year 4'), third), 2);
  assert.equal(year(2027, 10).text, 'Graduated');
  // A year-of-study question sits among education fields without starting a new entry.
  const plan = matcher.plan(
    [
      desc('School'),
      desc('Year of study', { kind: 'select', options: opts('1st year', 'Final year') }),
      desc('Degree'),
      desc('School'),
    ],
    p,
  );
  assert.deepEqual(types(plan), ['edu.school#0', 'edu.year', 'edu.degree#0', 'edu.school#1']);
});

test('degree, location, skills and languages adapt to the question', () => {
  const p = student();
  assert.equal(
    ask(p, 'edu.degree', 'What degree course are you studying?', { kind: 'text' }).text,
    'BSc in Mathematics',
  );
  assert.equal(ask(p, 'edu.degree', 'Degree', { kind: 'text' }).text, 'BSc');
  assert.equal(ask(p, 'edu.degree', 'What degree course are you studying?', { kind: 'select' }).text, 'BSc');

  const loc = ask(p, 'location', 'Location');
  assert.ok(loc.candidates.includes('San Francisco, California, United States'));
  assert.equal(
    matcher.matchOption(
      opts('San Francisco, Cebu, Philippines', 'San Francisco, California, United States', 'San Francisco de Macorís'),
      loc,
    ),
    1,
    'the option naming your state wins',
  );

  assert.deepEqual(ask(p, 'skills', 'Skills', { kind: 'text' }).items, ['Python', 'SQL', 'Excel']);
  assert.deepEqual(
    matcher.matchAll(
      opts('Java', 'Python', 'SQL', 'R'),
      ask(p, 'skills', 'Which tools do you use?', { kind: 'select' }),
    ),
    [1, 2],
  );
  assert.deepEqual(ask(p, 'languages', 'Which languages are you fluent in other than English?').items, [
    'French',
    'German',
  ]);
  assert.equal(ask(p, 'languages', 'Languages').text, 'English, French, German');
  p.languages = 'English';
  assert.equal(ask(p, 'languages', 'Which languages are you fluent in other than English?'), null);
});

test('a question asked again among the screening questions is about your first entry', () => {
  const p = student();
  const term = desc(
    { question: 'Which term matches your graduation date?' },
    { kind: 'select', options: opts('Spring 2027', 'Summer 2027') },
  );
  const again = matcher.plan(
    [
      desc('School'),
      desc('Degree'),
      desc('Graduation date'),
      desc('First name'),
      desc('Email', { kind: 'email' }),
      term,
      desc('Phone'),
    ],
    p,
  );
  assert.deepEqual(types(again), [
    'edu.school#0',
    'edu.degree#0',
    'edu.end#0',
    'name.first',
    'email',
    'edu.end#0',
    'phone',
  ]);
  // A full second entry still starts a new one.
  const second = matcher.plan(
    [
      desc('School'),
      desc('Degree'),
      desc('Graduation date'),
      desc('First name'),
      desc('School'),
      desc('Degree'),
      desc('Graduation date'),
    ],
    p,
  );
  assert.deepEqual(types(second), [
    'edu.school#0',
    'edu.degree#0',
    'edu.end#0',
    'name.first',
    'edu.school#1',
    'edu.degree#1',
    'edu.end#1',
  ]);
});

test('date formats spelled out in the label', () => {
  const p = student();
  const f = (label, d) =>
    matcher.formatForText(
      fields.resolve('edu.end', p, { jobContext: true, index: 0 }),
      Object.assign({ inputType: 'text', maxLength: 0, placeholderRaw: '', signals: { label } }, d),
    );
  assert.equal(f('Graduation date (MM/YYYY)'), '06/2027');
  assert.equal(f('Graduation date, dd-mm-yyyy'), '01-06-2027');
  assert.equal(f('When do you graduate (Month and Year)?'), 'June 2027');
  assert.equal(f('When do you graduate (Month and Year)?', { inputType: 'textarea' }), 'June 2027');
  assert.equal(f('Graduation date (MM/YYYY)', { placeholderRaw: 'YYYY-MM' }), '2027-06', 'the placeholder wins');
});

test('UK degree classes match however the form spells them', () => {
  const p = student();
  const pick = (gpa, ...options) => {
    p.education[0].gpa = gpa;
    const i = matcher.matchOption(opts(...options), ask(p, 'edu.gpa', 'Degree classification'));
    return i < 0 ? null : options[i];
  };
  assert.equal(
    pick(
      '2:1',
      '1st Class, equivalent to US 3.7-4.0 GPA',
      'Upper Second Class, equivalent to US 3.3-3.6 GPA',
      'Lower Second Class, equivalent to US 3.0-3.2 GPA',
    ),
    'Upper Second Class, equivalent to US 3.3-3.6 GPA',
  );
  assert.equal(
    pick('2:1', 'First Class', 'Upper-Second Class', 'Lower-Second Class', 'Third Class'),
    'Upper-Second Class',
  );
  assert.equal(
    pick(
      '2:1',
      "I'd rather not disclose",
      '50-59% - Second class honours: Grade 2',
      '60-69% - Second class honours: Grade 1',
      '70%+ - First class honours',
    ),
    '60-69% - Second class honours: Grade 1',
  );
  assert.equal(pick('First', 'First / 1st', '2:1', '2:2', 'Third'), 'First / 1st');
  assert.equal(pick('1st', '< 3.0', '3.5 - 3.9', '4.0 - 4.4', 'First-Class Honours'), 'First-Class Honours');
  assert.equal(pick('2:2', 'First', '2.1', '2.2', 'Third'), '2.2');
  assert.equal(pick('2:1', 'Over 3.9', '3.8 - 3.89', '3.7 - 3.79'), null, 'a class is not a GPA');
});

test('nationality written as a demonym matches a list of countries', () => {
  const p = student();
  p.personal.nationality = 'British';
  const v = fields.resolve('nationality', p, { jobContext: true });
  assert.equal(matcher.matchOption(opts('Afghanistan', 'United Kingdom', 'United States'), v), 1);
  assert.equal(matcher.matchOption(opts('American', 'British', 'Irish'), v), 1);
  p.personal.nationality = 'United States';
  assert.equal(
    matcher.matchOption(opts('American', 'British', 'Irish'), fields.resolve('nationality', p, { jobContext: true })),
    0,
  );
});

test('age bands come from the date of birth', () => {
  const p = student();
  p.personal.dob = '2004-12-10';
  const age = fields.resolve('age', p, { today: new Date(2026, 9, 1) });
  assert.equal(age.text, '21');
  assert.equal(matcher.matchOption(opts('16 - 17', '18 - 21', '22 - 30', '31 - 40'), age), 1);
  assert.equal(fields.resolve('age', p, { today: new Date(2026, 11, 10) }).text, '22', 'on the birthday');
  p.personal.dob = '';
  assert.equal(fields.resolve('age', p, {}), null);
});

test('work authorization options that talk about sponsorship', () => {
  const p = student();
  Object.assign(p.job, { authorized: 'Yes', sponsorship: 'No' });
  const auth = fields.resolve('job.authorized', p, { jobContext: true });
  const spons = fields.resolve('job.sponsorship', p, { jobContext: true });
  const status = opts('Yes, will require firm sponsorship', 'No. already has permanent work authorization');
  assert.equal(matcher.matchOption(status, auth), 1);
  assert.equal(matcher.matchOption(status, spons), 1);
  const statements = opts(
    'I am authorized to work in the United States for any employer',
    'I am authorized to work in the United States but will require sponsorship in the future',
    'I am not authorized to work in the United States',
  );
  assert.equal(matcher.matchOption(statements, auth), 0);
  assert.equal(matcher.matchOption(opts('Yes', 'No'), auth), 0);
  assert.equal(matcher.matchOption(opts('Yes', 'No'), spons), 1);
  p.job.sponsorship = 'Yes';
  assert.equal(matcher.matchOption(statements, fields.resolve('job.authorized', p, { jobContext: true })), 1);
});

test('a GitHub username question gets the username', () => {
  const p = student();
  p.links.github = 'https://github.com/ada-l/';
  assert.equal(ask(p, 'links.github', 'What is your Github username?').text, 'ada-l');
  assert.equal(ask(p, 'links.github', 'GitHub').text, 'https://github.com/ada-l/');
});

test('"Which country do you live in?" after the education section is still yours', () => {
  const p = student();
  const country = (label) => desc({ label }, { kind: 'select', options: opts('United Kingdom', 'United States') });
  const plan = matcher.plan(
    [
      desc('School'),
      desc('Degree'),
      country('Country'),
      desc('Field of study'),
      country('What country do you currently reside in?'),
      desc({ label: 'If applicable, which US state do you reside in?' }, { kind: 'select', options: opts('Alabama') }),
      desc('Where are you currently based?'),
    ],
    p,
  );
  assert.deepEqual(types(plan), [
    'edu.school#0',
    'edu.degree#0',
    'edu.country#0',
    'edu.field#0',
    'address.country',
    'address.state',
    'location',
  ]);
});

test('a "Summary" box inside a work-history entry describes that job', () => {
  const plan = matcher.plan(
    [
      desc('Company'),
      desc('Title'),
      desc('Summary', { kind: 'textarea' }),
      desc('Start date', { kind: 'date', inputType: 'date' }),
      desc('School'),
      desc('Field of Study'),
      desc('Summary', { kind: 'textarea' }),
      desc('Start date', { kind: 'date', inputType: 'date' }),
      desc('Professional summary', { kind: 'textarea' }),
    ],
    sample(),
  );
  assert.deepEqual(types(plan), [
    'exp.company#0',
    'exp.title#0',
    'exp.description#0',
    'exp.start#0',
    'edu.school#0',
    'edu.field#0',
    null,
    'edu.start#0',
    'summary',
  ]);
});

test('UK social mobility questions', () => {
  const p = student();
  Object.assign(p.eeo, {
    schoolType: 'State school (non-selective)',
    freeSchoolMeals: 'Yes',
    parentsDegree: 'No',
    parentOccupation: 'Routine / semi-routine',
  });
  const classify = (label, ...options) =>
    matcher.classify(desc({ label }, { kind: 'select', options: opts(...options) }));
  const answer = (label, ...options) => {
    const r = classify(label, ...options);
    assert.ok(r && r.type, label);
    const v = fields.resolve(r.type, p, { jobContext: true, question: util.normalize(label) });
    const i = matcher.matchOption(opts(...options), v);
    return i < 0 ? null : options[i];
  };
  assert.equal(
    answer(
      'What type of school did you mainly attend between the ages of 11 and 16?',
      'A state-run or state-funded school - selective on academic, faith or other grounds',
      'A state-run or state-funded school - non-selective',
      'Independent or fee-paying school',
      'Independent or fee-paying school, where I received a means-tested bursary covering 90% or more of the total cost',
      'Attended school outside the UK',
      'Prefer not to say',
    ),
    'A state-run or state-funded school - non-selective',
  );
  assert.equal(
    answer(
      'If you finished school after 1980, were you eligible for Free School Meals at any point during your school years?',
      'Yes',
      'No',
      'Not applicable (finished school before 1980 or went to school overseas)',
      "I don't know",
      'Prefer not to say',
    ),
    'Yes',
  );
  assert.equal(answer('Did either of your parents attend university?', 'Yes', 'No'), 'No');
  assert.equal(answer('Are you the first in your family to go to university?', 'Yes', 'No'), 'Yes');
  assert.equal(
    answer(
      'What is the highest level of qualifications achieved by either of your parent(s) or guardian(s) by the time you were 18?',
      'At least one has a degree level qualification',
      'Qualifications below degree level',
      'No formal qualifications',
      "Don't know",
    ),
    'Qualifications below degree level',
  );
  assert.equal(
    answer(
      'What was the occupation of your main household earner when you were aged 14?',
      'Modern professional and traditional professional occupations such as: teacher, nurse',
      'Senior, middle or junior managers or administrators such as: finance manager',
      'Clerical and intermediate occupations such as: secretary',
      'Technical and craft occupations such as: motor mechanic',
      'Routine, semi-routine manual and service occupations such as: postal worker',
      'Long-term unemployed (claimed Jobseeker’s Allowance or earlier unemployment benefit for more than a year)',
    ),
    'Routine, semi-routine manual and service occupations such as: postal worker',
  );
  // Left blank in the profile: nothing is chosen.
  p.eeo.freeSchoolMeals = '';
  assert.equal(answer('Were you eligible for free school meals?', 'Yes', 'No'), null);
});

test('a question naming a level of study answers from that degree', () => {
  const p = sample(); // BSc at University of London, then MSc at Cambridge
  const q = (type, question) => {
    const v = fields.resolve(type, p, { jobContext: true, index: 0, question: util.normalize(question) });
    return v && v.text;
  };
  assert.equal(q('edu.gpa', 'Undergraduate GPA'), '3.9');
  assert.equal(q('edu.gpa', 'GPA (Graduate)'), null, 'the MSc has no GPA');
  assert.equal(q('edu.school', 'Which university did you attend for your Masters?'), 'Cambridge');
  assert.equal(q('edu.gpa', 'GPA (Doctorate)'), null);
  assert.equal(q('edu.school', 'Name of Secondary/Academy School Attended'), null, 'no school-level entry');
  assert.equal(
    q('edu.school', 'Undergraduate or graduate school'),
    'University of London',
    'two levels: no preference',
  );
  assert.equal(
    q('edu.school', 'Which university? This includes any studies not yet started, e.g. a Masters'),
    'University of London',
    'an example is not the level asked about',
  );
  p.education.push({
    school: 'Eton College',
    degree: 'A levels',
    field: 'Maths, Physics',
    startDate: '2008-09',
    endDate: '2015-06',
  });
  assert.equal(q('edu.school', 'Name of Secondary/Academy School Attended'), 'Eton College');
  // Level questions don't start new entries in the education section.
  const plan = matcher.plan(
    [
      desc('Name of Secondary/Academy School Attended'),
      desc('Secondary/Academy School Dates Attended'),
      desc('What University did you Attend'),
      desc('University Dates Attended', { kind: 'textarea' }),
      desc('Degree Subject'),
      desc('Expected/Achieved Final Degree Classification'),
      desc('Expected Year of Graduation'),
    ],
    p,
  );
  assert.deepEqual(types(plan), [
    'edu.school#0',
    null,
    'edu.school#0',
    null,
    'edu.field#0',
    'edu.classification#0',
    'edu.end#0:year',
  ]);
});

test('"Are you available to start from <date>?" is answered from your start date', () => {
  const p = student();
  p.job.startDate = '2027-06-28';
  const avail = (question) => {
    const v = ask(p, 'job.startDate', question);
    return v && v.canonical ? v.text : v && v.text;
  };
  assert.equal(avail('Are you available to start full time from Monday 6th September 2027?'), 'Yes');
  assert.equal(avail('Will you be available to start full-time from 6th September 2027?'), 'Yes');
  assert.equal(avail('Are you available from 21st June to 20th August 2027?'), 'No', 'starts a week too late');
  assert.equal(avail('Are you available from 1st July to 20th August 2027?'), 'Yes');
  assert.equal(avail('I confirm my availability for a Summer 2027 (June/July starts) internship'), 'Yes');
  assert.equal(avail('Will you be ready for full-time employment in 2028?'), 'Yes');
  assert.equal(avail('Are you available to start in January 2027?'), 'No');
  assert.equal(avail('When can you start?'), '2027-06-28', 'a plain question gets the date');
  const classify = (label) => matcher.classify(desc({ label }, { kind: 'select', options: opts('Yes', 'No') }));
  assert.equal(classify('Are you available to start full time from Monday 6th September 2027?').type, 'job.startDate');
  assert.equal(classify('Will you be ready for full-time employment in 2028?').type, 'job.startDate');
  assert.equal(
    classify('I confirm my availability for a Summer 2027 (June/July starts) internship').type,
    'job.startDate',
  );
});

test('"Is this your current employer?" in a work-history entry is answered for that entry', () => {
  const yn = opts('Yes', 'No');
  const plan = matcher.plan(
    [
      desc('1. Employer Name'),
      desc({ question: 'Is this your current employer?' }, { kind: 'radio', options: yn }),
      desc('Job Title'),
      desc('2. Employer Name'),
      desc({ question: 'Is this your current employer?' }, { kind: 'radio', options: yn }),
      desc('Job Title'),
    ],
    sample(),
  );
  assert.deepEqual(types(plan), [
    'exp.company#0',
    'exp.current#0',
    'exp.title#0',
    'exp.company#1',
    'exp.current#1',
    'exp.title#1',
  ]);
  const p = sample();
  assert.equal(fields.resolve('exp.current', p, { jobContext: true, index: 0 }).canonical, 'yes');
  assert.equal(fields.resolve('exp.current', p, { jobContext: true, index: 1 }).canonical, 'no');
});

test('"If your institution is not listed above" does not start a second education entry', () => {
  const plan = matcher.plan(
    [
      desc(
        { label: 'Please select the college or university you currently attend or previously attended:' },
        { kind: 'combobox' },
      ),
      desc('If your institution is not listed above, please specify below:'),
      desc({ label: 'Indicate your expected graduation date:' }, { kind: 'combobox' }),
      desc({ label: 'Of the following options, please select your declared major:' }, { kind: 'combobox' }),
      desc('What is your cumulative GPA?'),
    ],
    sample(),
  );
  assert.deepEqual(types(plan), ['edu.school#0', null, 'edu.end#0', 'edu.field#0', 'edu.gpa#0']);
});

test('"If yes, tell us more" boxes stay empty after a No, in every fill pass', () => {
  const p = student();
  const more = (question) =>
    fields.resolve('job.otherOffers', p, { jobContext: true, question: util.normalize(question) });
  p.job.otherOffers = 'No';
  assert.equal(more('If you said yes above, please tell us about your offers and deadlines.'), null);
  assert.equal(more('Do you have other offers?').text, 'No');
  p.job.otherOffers = 'Yes, Jane Street, deadline 1 November';
  assert.equal(more('If yes, please tell us about your offers').text, 'Yes, Jane Street, deadline 1 November');
  p.job.sponsorship = 'No';
  assert.equal(
    fields.resolve('job.sponsorship', p, {
      question: util.normalize('If yes, what type of sponsorship will you require?'),
    }),
    null,
  );
});

test('"Are you a student who will graduate Fall of 2027 or Spring 2028?" is answered from your date', () => {
  const p = student(); // June 2027
  const v = ask(p, 'edu.end', 'Are you currently a university student who will graduate Fall of 2027 or Spring 2028?');
  assert.equal(v.text, 'No');
  p.education[0].endDate = '2028-05';
  assert.equal(
    ask(p, 'edu.end', 'Are you currently a university student who will graduate Fall of 2027 or Spring 2028?').text,
    'Yes',
  );
});

test('round 2: graduation terms, past graduations, "Are you fluent in French?", availability after the facts', () => {
  const p = student(); // BSc ending June 2027, languages English, French, German
  // A year box whose options are terms: June is summer, not spring.
  const year = ask(p, 'edu.end', 'Undergraduate Graduation Year', { part: 'year' });
  assert.equal(matcher.matchOption(opts('Spring 2027', 'Summer 2027', 'Fall 2027'), year), 1);
  assert.equal(matcher.matchOption(opts('2026', '2027', '2028'), year), 1);
  // "Winter 2026/ Spring 2027" is December 2026 to May 2027: the nearest for a June 2027 graduation.
  const end = ask(p, 'edu.end', 'What is your graduation date?');
  assert.equal(
    matcher.matchOption(
      opts('Winter 2025/ Spring 2026', 'Winter 2026/ Spring 2027', 'Winter 2027/ Spring 2028', 'Other'),
      end,
    ),
    1,
  );
  assert.deepEqual(matcher.optionSpan('Winter 2026/ Spring 2027'), [2026 * 12 + 11, 2027 * 12 + 4]);
  assert.deepEqual(matcher.optionSpan('Fall/Winter 2026'), [2026 * 12 + 8, 2027 * 12 + 1]);
  // Graduated already: "I am not currently enrolled".
  const grad = student();
  grad.education[0].endDate = '2016-06';
  const past = ask(grad, 'edu.end', 'If you are currently enrolled, what is your expected graduation date?');
  assert.equal(matcher.matchOption(opts('Spring 2027', 'Fall 2027', 'Other', 'I am not currently enrolled'), past), 3);
  assert.equal(matcher.matchOption(opts('Spring 2027', 'Fall 2027'), past), -1);
  assert.equal(matcher.matchOption(opts('Spring 2027', 'Summer 2027', 'Graduated'), end), 1);
  // Languages asked one at a time.
  const yn = opts('Yes', 'No');
  assert.equal(ask(p, 'languages', 'Are you fluent in French? (Please note this is a requirement)').text, 'Yes');
  assert.equal(ask(p, 'languages', 'Do you speak Mandarin?'), null);
  assert.equal(matcher.matchOption(yn, ask(p, 'languages', 'Can you speak German or Dutch?')), 0);
  assert.equal(ask(p, 'languages', 'Additional languages').kind, 'list');
  // William Blair: the dates first, the question after.
  const start = Object.assign(student(), {});
  start.job.startDate = '2027-06-28';
  const q =
    'The internship is a 3 month placement running from 1 July to 30 September 2027. Can you confirm that you are available to work on a full-time basis for the duration of the internship?';
  assert.equal(ask(start, 'job.startDate', q).text, 'Yes');
  start.job.startDate = '2027-09-01';
  assert.equal(ask(start, 'job.startDate', q).text, 'No');
});

test('live survey (Glasgow undergraduate): start-date options to the day, a year for each date, dated "suitable" checks', () => {
  const today = new Date('2026-10-03');
  const p = student();
  p.job.startDate = '2027-06-28';
  const pick = (question, list) => {
    const options = opts(...list);
    const i = matcher.matchOption(options, ask(p, 'job.startDate', question, { today }));
    return i < 0 ? null : options[i].text;
  };
  // Base Power: a season, then its own dates with their own year (not January 2028).
  const base = ['Spring 2027 (January 11th - April 30th, 2027)', 'Summer 2027 (May 10th - August 20th, 2027)'];
  assert.deepEqual([...matcher.optionSpan(base[0])], [2027 * 12, 2027 * 12 + 4]);
  assert.equal(matcher.optionSpan(base[0]).day, 11);
  assert.deepEqual([...matcher.optionSpan('Spring (January - April) 2027')], [2027 * 12, 2027 * 12 + 4]);
  assert.equal(pick('Work Term Availability', base), base[1]);
  // Monzo: the first start you can make, to the day.
  const monzo = ['Start 1st June, finish 20th August 2027', 'Start 30th June, finish 17th September 2027'];
  assert.equal(pick('Please select your preferred start date and end date for the internship', monzo), monzo[1]);
  assert.equal(pick('Preferred start date', ['7th June 2027', '5th July 2027']), '5th July 2027');
  assert.equal(
    pick('Preferred start date', ['Monday 7 June 2027', 'Monday 28 June 2027', 'Monday 5 July 2027']),
    'Monday 28 June 2027',
  );
  assert.equal(pick('What is the earliest you could start?', ['May 2027', 'July 2027', 'September 2027']), 'July 2027');
  // Terms still cover the date.
  assert.equal(
    pick('When are you available for a 12 week internship?', ['Fall 2026', 'Spring 2027', 'Summer 2027']),
    'Summer 2027',
  );
  p.job.startDate = '2027-06-01';
  assert.equal(pick('Please select your preferred start date and end date for the internship', monzo), monzo[0]);

  // Marshall Wace: "I confirm that the listed dates are suitable for me" asks about your start date, with no year.
  const mw = (dates) => `I confirm that the listed dates are suitable for me; ${dates}`;
  const yn = opts('Yes', 'No');
  const classify = (label, kind = 'select', options = yn) =>
    (matcher.classify(desc(label, { kind, options })) || {}).type;
  assert.equal(classify(mw('14th June – 22nd August')), 'job.startDate');
  assert.equal(classify(mw('14th June – 22nd August'), 'radio'), 'job.startDate');
  const answer = (dates, at) => ask(p, 'job.startDate', mw(dates), { today: at || today }).text;
  p.job.startDate = '2027-06-28';
  assert.equal(answer('14th June – 22nd August'), 'No');
  assert.equal(answer('28th June – 3rd September'), 'Yes');
  assert.equal(
    answer('14th June – 22nd August', new Date('2027-07-10')),
    'Yes',
    'next year’s dates once these are past',
  );
  p.job.startDate = '2027-06-01';
  assert.equal(answer('14th June – 22nd August'), 'Yes');
  // As a box to tick (acknowledgements on): only when you can make the dates.
  p.job.startDate = '2027-06-28';
  const tick = (q) => fields.resolve('consent', p, { consents: true, question: util.normalize(q), today });
  assert.equal(classify(mw('14th June – 22nd August'), 'checkbox', null), 'consent');
  assert.equal(tick(mw('14th June – 22nd August')), null);
  assert.equal(tick(mw('28th June – 3rd September')).text, 'Yes');
  // Without dates it is an acknowledgement as before, and interview dates are job.availability's to judge.
  assert.equal(classify('I confirm that the internship dates are suitable for me'), 'consent');
  assert.equal(tick('I confirm that I have read the privacy notice').text, 'Yes');
  assert.equal(tick('I confirm I am available for the interview on 14th October').text, 'Yes');
  assert.equal(
    classify('Please select ALL dates/times for which you are available', 'checkboxes', opts('Mon 12th Oct AM')),
    'job.availability',
  );
  assert.notEqual(
    classify('Please confirm the interview dates (13th–14th October 2026) are suitable for you'),
    'job.startDate',
  );
  // Other start-date questions that name no year.
  assert.equal(ask(p, 'job.startDate', 'Are you available to start on 6th September?', { today }).text, 'Yes');
  assert.equal(ask(p, 'job.startDate', 'Are you available to start on 1st June?', { today }).text, 'No');
  assert.equal(
    classify('What month will you be able to start your internship?', 'select', opts('May', 'June')),
    'job.startDate',
  );
  const box = desc('Earliest date you could start (DD/MM/YYYY)');
  assert.equal(classify(box.signals.label, 'text', null), 'job.startDate');
  assert.equal(matcher.formatForText(ask(p, 'job.startDate', box.signals.label, { today }), box), '28/06/2027');
});

test('status lists: never "not authorized" when you are, your citizenship when it is listed', () => {
  const p = student();
  p.job.authorized = 'Yes';
  p.job.sponsorship = 'No';
  // Base Power (Ashby): no option says plainly "No"; the one with a "not" is the wrong status, not the answer.
  const base = opts(
    'I am not currently authorized to work in the U.S.',
    'I require another type of visa sponsorship to work for Base now',
    'I require initial H-1B sponsorship to work for Base now',
    'I am a U.S. citizen or permanent resident (Green Card holder)',
    'I currently hold OPT and will require H-1B sponsorship in the future',
  );
  const q = 'Will you require sponsorship for employment now or in the future?';
  assert.equal(matcher.matchOption(base, ask(p, 'job.sponsorship', q)), -1);
  p.personal.nationality = 'American';
  assert.equal(matcher.matchOption(base, ask(p, 'job.sponsorship', q)), 3);
  // William Blair: "Please specify your eligibility to work in Germany."
  const de = opts('German Citizen', 'European Citizen', 'I Hold a Student Visa', 'I Require Sponsorship');
  const eligibility = 'Please specify your eligibility to work in Germany.';
  p.personal.nationality = 'German';
  assert.equal(matcher.matchOption(de, ask(p, 'job.authorized', eligibility)), 0);
  p.personal.nationality = 'France';
  assert.equal(matcher.matchOption(de, ask(p, 'job.authorized', eligibility)), 1);
  // British (after Brexit): no right to work in Germany, so the truthful option is the sponsorship one.
  p.personal.nationality = 'British';
  assert.equal(matcher.matchOption(de, ask(p, 'job.authorized', eligibility)), 3);
  // A negated status is never yours.
  p.personal.nationality = 'United States';
  const yn = opts('No, I am not a U.S. citizen', 'Yes, I am a U.S. citizen');
  assert.equal(matcher.matchOption(yn, ask(p, 'job.authorized', 'Are you a U.S. citizen?')), 1);
  // Plain Yes / No questions are unchanged.
  assert.equal(matcher.matchOption(opts('Yes', 'No'), ask(p, 'job.sponsorship', q)), 1);
});

test('acknowledgement statements: consents yes, opt-ins and refusals no', () => {
  assert.equal(fields.isAcknowledgement('By clicking this box, you consent to our Applicant Privacy Statement.'), true);
  assert.equal(fields.isAcknowledgement('I have read and understood the candidate privacy notice.'), true);
  assert.equal(fields.isAcknowledgement('I do not consent to the privacy notice'), false);
  assert.equal(fields.isAcknowledgement('Keep my details and contact me about future opportunities'), false);
  assert.equal(fields.isAcknowledgement('LinkedIn'), false);
  const p = student();
  assert.equal(fields.resolve('consent', p, { consents: false }), null);
  assert.equal(fields.resolve('consent', p, { consents: true }).consent, true);
});

test('round 2: right-to-work options that mention sponsorship, notice periods in ranges, Month/Year boxes', () => {
  const p = student();
  p.job.authorized = 'Yes';
  p.job.sponsorship = 'No';
  const bh = opts(
    'Yes - I have the permanent right to work and do not need sponsorship',
    'No - I do not have the permanent right to work and will require sponsorship either now or in the future',
  );
  assert.equal(
    matcher.matchOption(bh, ask(p, 'job.authorized', 'Do you currently have the right to work in the UK?')),
    0,
  );
  assert.equal(matcher.matchOption(bh, ask(p, 'job.sponsorship', 'Will you require sponsorship?')), 0);
  p.job.sponsorship = 'Yes';
  p.job.authorized = 'No';
  assert.equal(matcher.matchOption(bh, ask(p, 'job.sponsorship', 'Will you require sponsorship?')), 1);
  const both = opts('Yes, I will require sponsorship', 'No, I will not require sponsorship', 'No sponsorship required');
  assert.equal(matcher.matchOption(both, ask(p, 'job.sponsorship', 'Sponsorship?')), 0);
  // Notice periods.
  const man = opts('< 1 Month', '1-2 Months', '2-3 Months', '> 3 Months');
  p.job.noticePeriod = 'None';
  assert.equal(matcher.matchOption(man, ask(p, 'job.noticePeriod', 'Current Notice Period')), 0);
  p.job.noticePeriod = '2 weeks';
  assert.equal(matcher.matchOption(man, ask(p, 'job.noticePeriod', 'Current Notice Period')), 0);
  p.job.noticePeriod = '6 weeks';
  assert.equal(matcher.matchOption(man, ask(p, 'job.noticePeriod', 'Current Notice Period')), 1);
  p.job.noticePeriod = '3 months';
  assert.equal(matcher.matchOption(man, ask(p, 'job.noticePeriod', 'Current Notice Period')), 2);
  p.job.noticePeriod = 'None';
  assert.equal(
    matcher.matchOption(opts('1 month', 'Immediately available', '3 months'), ask(p, 'job.noticePeriod', 'Notice')),
    1,
  );
  // "(Month/Year)" without spaces.
  p.job.startDate = '2027-06-28';
  const d = desc('When would you like to start your internship? (Month/Year)');
  assert.equal(
    matcher.formatForText(ask(p, 'job.startDate', 'When would you like to start your internship?'), d),
    'June 2027',
  );
});

test('ranges written with signs: ">=3.7", "<2.5", "> 3 Months"', () => {
  const p = student(); // GPA 3.9
  const gpa = opts('-- No answer --', '>=3.7', '3.5 - 3.7', '3.0-3.4', '2.5-3.0', '<2.5');
  assert.equal(matcher.matchOption(gpa, ask(p, 'edu.gpa', 'Undergraduate degree GPA')), 1);
  p.education[0].gpa = '3.8';
  assert.equal(matcher.matchOption(gpa, ask(p, 'edu.gpa', 'Undergraduate degree GPA')), 1);
  p.education[0].gpa = '2.1';
  assert.equal(matcher.matchOption(gpa, ask(p, 'edu.gpa', 'Undergraduate degree GPA')), 5);
});

test('a sign is part of the option: "<3.7" is not 3.7', () => {
  const p = student();
  p.education[0].gpa = '3.7';
  const v = ask(p, 'edu.gpa', 'GPA');
  assert.equal(matcher.matchOption(opts('<3.7', '3.7-4.0'), v), 1);
  assert.equal(matcher.matchOption(opts('>=3.7', '3.0-3.69'), v), 0);
});

test('UK law-firm forms: boxes under a school heading ask about school; "Title" before names is Mr / Ms', () => {
  const p = sample(); // two university entries, no school entry
  const page = [
    desc({ label: 'Title', id: 'title', section: 'Personal details' }),
    desc({ label: 'Forename(s)', section: 'Personal details' }),
    desc({ label: 'Surname', section: 'Personal details' }),
    desc({ label: 'School/college name', section: 'Secondary education' }),
    desc({ label: 'Postcode', section: 'Secondary education' }),
    desc({ label: 'Start date', section: 'Secondary education' }),
    desc({ label: 'Subject', section: 'A-levels (or equivalent)' }),
    desc({ label: 'Grade', section: 'A-levels (or equivalent)' }),
    desc({ label: 'University', section: 'University education' }),
    desc({ label: 'Subject', section: 'University education' }),
    desc({ label: 'Module title', id: 'mod_title_1', section: 'University education' }),
    desc({ label: 'Overall percentage to date', section: 'University education' }),
  ];
  const plan = matcher.plan(page, p);
  assert.deepEqual(types(plan), [
    'name.prefix',
    'name.first',
    'name.last',
    'edu.school#0',
    null,
    'edu.start#0',
    'edu.field#0',
    'edu.gpa#0',
    'edu.school#0',
    'edu.field#0',
    null,
    null,
  ]);
  assert.equal(matcher.questionText(page[6]), 'A-levels (or equivalent): Subject');
  assert.equal(matcher.questionText(page[9]), 'Subject', 'a university heading changes nothing');
  assert.equal(matcher.questionText(desc({ label: 'Subject', section: 'Select a level' })), 'Subject');
  assert.equal(matcher.questionText(desc({ label: 'Grade', section: 'A Level results' })), 'A Level results: Grade');
  // School-level questions are answered from a school entry, and there is none.
  const q = (i) => util.normalize(matcher.questionText(page[i]));
  for (const i of [3, 5, 6, 7]) {
    const r = plan.results[i];
    assert.equal(
      fields.resolve(r.type, p, { jobContext: true, index: r.index, question: q(i) }),
      null,
      page[i].signals.label,
    );
  }
  assert.equal(
    fields.resolve('edu.school', p, { jobContext: true, index: 0, question: q(8) }).text,
    'University of London',
  );
  // With a school entry, they get the school's answers.
  p.education.push({ school: 'Camden School', degree: 'A Levels', field: 'Maths, Physics', gpa: 'A*AA' });
  assert.equal(fields.resolve('edu.school', p, { jobContext: true, index: 0, question: q(3) }).text, 'Camden School');
  assert.equal(fields.resolve('edu.gpa', p, { jobContext: true, index: 0, question: q(7) }).text, 'A*AA');
  // "September 2029 / March 2030" is a list of dates, not of months.
  const tc = matcher.classify(
    desc('When would you like to start your training contract?', {
      kind: 'select',
      options: opts('Please select', 'September 2029', 'March 2030', 'September 2030'),
    }),
  );
  assert.equal(tc.type, 'job.startDate');
  assert.equal(tc.part, null);
  assert.equal(matcher.classify(desc('Number of GCSEs at grade 9-7 (A*-A)')), null);
  assert.equal(matcher.classify(desc('Module name')), null);
  assert.equal(matcher.classify(desc('Title (e.g. Mr, Mrs, Ms)')).type, 'name.prefix');
});

test('security clearance and citizenship answers', () => {
  const p = student();
  const yn = opts('Yes', 'No');
  const held = 'Do you currently hold an active security clearance?';
  assert.equal(ask(p, 'job.clearance', held), null, 'nothing in the profile: left for you');
  p.job.clearance = 'None';
  assert.equal(matcher.matchOption(yn, ask(p, 'job.clearance', held)), 1);
  p.job.clearanceEligible = 'Yes';
  assert.equal(matcher.matchOption(yn, ask(p, 'job.clearanceEligible', 'Are you willing to undergo SC clearance?')), 0);
  p.job.clearance = 'SC';
  p.job.clearanceEligible = '';
  assert.equal(matcher.matchOption(yn, ask(p, 'job.clearance', held)), 0);
  assert.equal(matcher.matchOption(yn, ask(p, 'job.clearanceEligible', 'Are you eligible for DV clearance?')), 0);
  const levels = opts('None', 'BPSS', 'Counter-Terrorist Check (CTC)', 'Security Check (SC)', 'Developed Vetting (DV)');
  assert.equal(matcher.matchOption(levels, ask(p, 'job.clearance', 'Current clearance level')), 3);
  // Citizenship from nationality.
  const us = 'Are you a US citizen or lawful permanent resident (green card holder)?';
  assert.equal(ask(p, 'citizen', us), null, 'no nationality');
  p.personal.nationality = 'American';
  assert.equal(ask(p, 'citizen', us).text, 'Yes');
  p.personal.nationality = 'British';
  assert.equal(ask(p, 'citizen', us), null, 'could still be a permanent resident');
  assert.equal(ask(p, 'citizen', 'Are you a U.S. citizen?').text, 'No');
  assert.equal(ask(p, 'citizen', 'Are you a British citizen?').text, 'Yes');
  p.personal.nationality = 'Irish';
  assert.equal(ask(p, 'citizen', 'Are you an EU citizen?').text, 'Yes');
});

test('"Right to work / Visa status" in a text box gets a sentence; yes/no questions keep Yes / No', () => {
  const p = student();
  p.job.authorized = 'Yes';
  p.job.sponsorship = 'No';
  const text = (q, kind) => ask(p, 'job.sponsorship', q, { kind }).text;
  assert.equal(text('Right to work/Visa Status', 'text'), 'I have the right to work and do not need visa sponsorship.');
  assert.equal(text('Do you require visa sponsorship?', 'text'), 'No');
  assert.equal(text('Right to work/Visa Status', 'select'), 'No');
  p.job.sponsorship = 'Yes';
  assert.equal(
    ask(p, 'job.authorized', 'Work authorisation status', { kind: 'textarea' }).text,
    'I have the right to work now but will need visa sponsorship.',
  );
});

/* ---------------------------------------------------------------- ethnicity */

const ETH = {
  // US EEO (Greenhouse, Jensen Hughes)
  us: [
    'Decline To Self Identify',
    'Two or More Races',
    'Native Hawaiian or Other Pacific Islander',
    'White',
    'Hispanic or Latino',
    'Black or African American',
    'Asian',
    'American Indian or Alaskan Native',
  ],
  // UK 2011-style (Charles River Associates): Chinese is its own group, not under Asian.
  cra: [
    'White - British - English, Scottish or Welsh',
    'White - Irish',
    'White - Other White background',
    'Mixed Race - White and Black Caribbean',
    'Mixed Race - White and Black African',
    'Mixed Race - White and Asian',
    'Mixed Race - Other Mixed background',
    'Asian or Asian British - Indian',
    'Asian or Asian British - Pakistani',
    'Asian or Asian British - Bangladeshi',
    'Asian or Asian British - Other Asian background',
    'Black or Black British - Caribbean',
    'Black or Black British - African',
    'Black or Black British - Other Black background',
    'Chinese - Chinese',
    'Other Ethnic group',
    'Prefer not to say',
  ],
  // ONS 2021, flat (Marshall Wace)
  ons: [
    'Indian',
    'Pakistani',
    'Bangladeshi',
    'Chinese',
    'Any other Asian background',
    'African',
    'Caribbean',
    'Any other Black, Black British, or Caribbean background',
    'White and Black Caribbean',
    'White and Black African',
    'White and Asian',
    'Any other Mixed or multiple ethnic background',
    'English',
    'Welsh',
    'Scottish',
    'Northern Irish',
    'Irish',
    'British',
    'Roma',
    'Any other white background',
    'Arab',
    'Prefer not to say',
    'Other (not specified)',
  ],
  // Maven: no dashes, misspellings, a truncated mix
  maven: [
    'Asian Bangladeshi',
    'Asian Chinese',
    'Asian Indian',
    'Asian Pakastani',
    'Any other Asian background',
    'Black African',
    'Black African American',
    'Black Carribean',
    'Any other Black background',
    'Hispanic, Latino or Spanish Origin',
    'White and Asian',
    'White and Black ',
    'Any other mixed/multiple ethnic background',
    'White United Kingdom',
    'White Romani',
    'Any other White background',
    'Arab',
    'Any other ethnic group',
    'Prefer not to say',
  ],
  // Point72: US categories with "(Not Hispanic or Latinx)"
  p72: [
    'African American or Black (Not Hispanic or Latinx)',
    'Asian (Not Hispanic or Latinx)',
    'Hispanic or Latinx',
    'Multiracial',
    'Native American Indian or Alaska Native (Not Hispanic or Latinx)',
    'Other Pacific Islander (Not Hispanic or Latinx)',
    'White or Caucasian',
    'I choose not to provide this information',
  ],
  // Regions (Bot Auto)
  regions: [
    'Black or of African descent',
    'East Asian',
    'Hispanic, Latinx or of Spanish Origin',
    'Indigenous, American Indian or Alaska Native',
    'Middle Eastern or North African',
    'Native Hawaiian or Pacific Islander',
    'South Asian',
    'Southeast Asian',
    'White or European',
    "I don't wish to answer",
  ],
  // Step one of a two-step form: just the groups.
  groups: [
    'Asian or Asian British',
    'Black, Black British, Caribbean or African',
    'Mixed or multiple ethnic groups',
    'White',
    'Other ethnic group',
    'Prefer not to say',
  ],
};

function race(answer, list) {
  const p = student();
  p.eeo.race = answer;
  const options = Array.isArray(list) ? opts(...list) : list;
  const i = matcher.matchOption(options, fields.resolve('eeo.race', p, {}));
  return i < 0 ? null : options[i].text;
}

test('ethnicity: the most specific option offered, then up the hierarchy', () => {
  const chinese = 'Asian – Chinese';
  assert.equal(race(chinese, ETH.cra), 'Chinese - Chinese', 'never "Other Asian background"');
  assert.equal(race(chinese, ETH.ons), 'Chinese');
  assert.equal(race(chinese, ETH.maven), 'Asian Chinese');
  assert.equal(race(chinese, ETH.regions), 'East Asian');
  assert.equal(race(chinese, ETH.groups), 'Asian or Asian British');
  assert.equal(race(chinese, ETH.us), 'Asian');
  assert.equal(race(chinese, ETH.p72), 'Asian (Not Hispanic or Latinx)');
  assert.equal(
    race(chinese, ['Asian or Asian British – Chinese', 'Asian - Chinese', 'Chinese']),
    'Asian or Asian British – Chinese',
  );
  assert.equal(race(chinese, ['Chinese', 'East Asian', 'Asian']), 'Chinese');
  assert.equal(race(chinese, ['Asian/Pacific Islander', 'White']), 'Asian/Pacific Islander');
  // Not listed: "Any other Asian background"; a region still beats it.
  assert.equal(race('Asian – Filipino', ETH.cra), 'Asian or Asian British - Other Asian background');
  assert.equal(race('Asian – Filipino', ETH.regions), 'Southeast Asian');
  assert.equal(race('Asian – Indian', ETH.regions), 'South Asian');
  assert.equal(race('Asian – Indian', ETH.maven), 'Asian Indian');
  assert.equal(race('Asian – Pakistani', ETH.maven), 'Asian Pakastani');
  // Black, Mixed, White, Arab, Indigenous.
  assert.equal(race('Black – Caribbean', ETH.maven), 'Black Carribean');
  assert.equal(race('Black – Caribbean', ETH.groups), 'Black, Black British, Caribbean or African');
  assert.equal(race('Black – African', ETH.us), 'Black or African American');
  assert.equal(race('Black – African American', ETH.cra), 'Black or Black British - Other Black background');
  assert.equal(race('Mixed – White and Black African', ETH.maven), 'White and Black ');
  assert.equal(race('Mixed – White and Asian', ETH.us), 'Two or More Races');
  assert.equal(race('Mixed – White and Asian', ETH.p72), 'Multiracial');
  const british = 'White – British (English / Welsh / Scottish / Northern Irish)';
  assert.equal(race(british, ETH.ons), 'British');
  assert.equal(race(british, ETH.cra), 'White - British - English, Scottish or Welsh');
  assert.equal(race(british, ETH.maven), 'White United Kingdom');
  assert.equal(race('White – Irish', ETH.ons), 'Irish', 'not Northern Irish');
  assert.equal(race('White – Irish', ETH.maven), 'Any other White background');
  assert.equal(race('White – Roma', ETH.maven), 'White Romani');
  assert.equal(race('Middle Eastern – Arab', ETH.ons), 'Arab');
  assert.equal(race('Middle Eastern – Arab', ETH.regions), 'Middle Eastern or North African');
  assert.equal(race('Indigenous – Māori', ETH.us), null, 'never another indigenous people');
  assert.equal(
    race('Indigenous – American Indian or Alaska Native', ETH.p72),
    'Native American Indian or Alaska Native (Not Hispanic or Latinx)',
  );
  assert.equal(race('Hispanic – Mexican', ETH.us), 'Hispanic or Latino');
  assert.equal(race('Hispanic – Mexican', ETH.cra), null);
  assert.equal(race('Any other ethnic group', ETH.cra), 'Other Ethnic group');
  assert.equal(race('Prefer not to say', ETH.cra), 'Prefer not to say');
  assert.equal(race('Prefer not to say', ETH.p72), 'I choose not to provide this information');
  // <optgroup>s name the group of a bare "Other".
  const grouped = [
    { text: 'Chinese', value: 'c', group: 'Asian or Asian British' },
    { text: 'Other', value: 'ao', group: 'Asian or Asian British' },
    { text: 'African', value: 'b', group: 'Black or Black British' },
    { text: 'Other', value: 'bo', group: 'Black or Black British' },
  ];
  const p = student();
  p.eeo.race = 'Black – African American';
  assert.equal(matcher.matchOption(grouped, fields.resolve('eeo.race', p, {})), 3);
});

test('ethnicity: old broad answers keep filling as before', () => {
  assert.equal(race('Asian', ETH.us), 'Asian');
  assert.equal(race('White', ETH.us), 'White');
  assert.equal(race('Two or More Races', ETH.us), 'Two or More Races');
  assert.equal(race('Black or African American', ETH.us), 'Black or African American');
  assert.equal(race('Hispanic or Latino', ETH.us), 'Hispanic or Latino');
  assert.equal(race('American Indian or Alaska Native', ETH.us), 'American Indian or Alaskan Native');
  assert.equal(race('Native Hawaiian or Other Pacific Islander', ETH.us), 'Native Hawaiian or Other Pacific Islander');
  assert.equal(race('Decline to answer', ETH.us), 'Decline To Self Identify');
  assert.equal(race('Asian', ETH.groups), 'Asian or Asian British');
  assert.equal(race('White', ETH.p72), 'White or Caucasian');
  // A broad answer never guesses a subgroup.
  assert.equal(race('Asian', ETH.cra), null);
  assert.equal(race('Asian', ETH.ons), null);
});

test('a Hispanic / Latino ethnicity answers the separate Hispanic question', () => {
  const p = student();
  p.eeo.race = 'Hispanic – Mexican';
  assert.equal(fields.resolve('eeo.hispanic', p, {}).text, 'Yes');
  p.eeo.hispanic = 'No';
  assert.equal(fields.resolve('eeo.hispanic', p, {}).text, 'No', 'an explicit answer wins');
  p.eeo.hispanic = '';
  p.eeo.race = 'Asian – Chinese';
  assert.equal(fields.resolve('eeo.hispanic', p, {}), null);
});

test('settings offer every detailed ethnicity, grouped', () => {
  const groups = fields.ETHNICITY_CHOICES;
  const labels = groups.map((g) => g.label);
  for (const l of [
    'Asian / Asian British',
    'White',
    'Mixed / Multiple ethnic groups',
    'Indigenous',
    'Hispanic / Latino',
  ])
    assert.ok(labels.includes(l), l);
  const all = groups.flatMap((g) => g.items);
  for (const v of [
    'Asian – Chinese',
    'Asian – Nepali',
    'White – Gypsy or Irish Traveller',
    'Indigenous – Māori',
    'Any other ethnic group',
  ])
    assert.ok(all.includes(v), v);
  // Every choice reads back as its own group.
  for (const g of groups) for (const v of g.items) assert.ok(fields.parseEthnicity(v), v);
});

test('diversity answers pick the right option, with polarity ("I am not a carer")', () => {
  const p = student();
  Object.assign(p.eeo, {
    freeSchoolMeals: 'Not applicable',
    carer: 'No',
    careLeaver: 'Yes',
    religion: 'No religion or belief',
    sexualOrientation: 'Bisexual',
    genderIdentitySame: 'Yes',
    neurodivergent: 'Prefer not to say',
  });
  const pick = (type, q, list) => {
    const options = opts(...list);
    const i = matcher.matchOption(options, ask(p, type, q));
    return i < 0 ? null : options[i].text;
  };
  const fsm = [
    'Yes',
    'No',
    'Not applicable (finished school before 1980 or went to school outside of the United Kingdom)',
    "I don't know",
    'Prefer not to say',
  ];
  assert.equal(pick('eeo.freeSchoolMeals', 'Were you eligible for free school meals?', fsm), fsm[2]);
  p.eeo.freeSchoolMeals = 'I don’t know';
  assert.equal(pick('eeo.freeSchoolMeals', 'Were you eligible for free school meals?', fsm), "I don't know");
  assert.equal(pick('eeo.carer', 'Are you a carer?', ['I am a carer', 'I am not a carer']), 'I am not a carer');
  assert.equal(
    pick('eeo.careLeaver', 'Have you been in care?', ['I have been in care', 'I have not been in care']),
    'I have been in care',
  );
  const religions = [
    'No religion or belief/Atheist',
    'Buddhist',
    'Christian',
    'Any other religion or belief',
    'Prefer not to say',
  ];
  assert.equal(pick('eeo.religion', 'What is your religion or belief?', religions), religions[0]);
  assert.equal(
    pick('eeo.sexualOrientation', 'What is your sexual orientation?', ['Bi', 'Gay/Lesbian', 'Heterosexual/straight']),
    'Bi',
  );
  assert.equal(
    pick('eeo.genderIdentitySame', 'Is your gender identity the same as the sex registered at birth?', ['Yes', 'No']),
    'Yes',
  );
  assert.equal(pick('eeo.genderIdentitySame', 'Do you identify as transgender?', ['Yes', 'No']), 'No');
  assert.equal(pick('eeo.lgbt', 'Do you identify as LGBTQIA?', ['Yes', 'No', 'Prefer not to say']), 'Yes');
  assert.equal(pick('eeo.neurodivergent', 'Neurodivergent?', ['Yes', 'No', 'Prefer not to say']), 'Prefer not to say');
  p.eeo.postcodeAt14 = 'M1 1AA';
  assert.equal(ask(p, 'eeo.postcodeAt14', 'Postcode at 14').text, 'M1 1AA');
});

test('conflicts of interest: you, your family or both; details only after a Yes', () => {
  const p = student();
  const combined =
    'Are you, or is any immediate family member, a current or former government official, public official, or employee of a state-owned entity?';
  assert.equal(ask(p, 'compliance.government', combined), null, 'nothing answered: left for you');
  p.compliance.governmentOfficial = 'No';
  assert.equal(ask(p, 'compliance.government', combined), null, 'family unknown');
  p.compliance.familyGovernmentOfficial = 'No';
  assert.equal(ask(p, 'compliance.government', combined).text, 'No');
  assert.equal(ask(p, 'compliance.government', 'Are you a politically exposed person (PEP)?').text, 'No');
  p.compliance.familyGovernmentOfficial = 'Yes';
  p.compliance.governmentDetails = 'My father is a local councillor.';
  assert.equal(ask(p, 'compliance.government', combined).text, 'Yes');
  assert.equal(ask(p, 'compliance.government', 'Are you a politically exposed person?').text, 'No', 'about you only');
  assert.equal(ask(p, 'compliance.government', 'Were your parents involved in government?').text, 'Yes');
  assert.equal(
    ask(p, 'compliance.government', 'Do you or a family member have a government connection? If yes, explain', {
      kind: 'textarea',
    }).text,
    'My father is a local councillor.',
  );
  // "If yes, please give details" after the question.
  const page = [
    desc({ question: combined }, { kind: 'radio', options: opts('Yes', 'No') }),
    desc('If yes, please give details', { kind: 'textarea' }),
    desc({ question: 'Do you have any relatives working for us?' }, { kind: 'radio', options: opts('Yes', 'No') }),
    desc('If yes, please provide their name and relationship'),
  ];
  const plan = matcher.plan(page, p);
  assert.deepEqual(
    plan.results.map((r) => r && r.type),
    ['compliance.government', 'compliance.governmentDetails', 'compliance.relatives', 'compliance.relativesDetails'],
  );
  const q = (i) => util.normalize(matcher.questionText(page[i]));
  assert.equal(
    fields.resolve('compliance.governmentDetails', p, { question: q(1) }).text,
    'My father is a local councillor.',
  );
  p.compliance.relatives = 'No';
  p.compliance.relativesDetails = 'Should not appear';
  assert.equal(fields.resolve('compliance.relativesDetails', p, { question: q(3) }), null, 'stays empty after a No');
  assert.equal(fields.resolve('compliance.relatives', p, { question: q(2), kind: 'text' }).text, 'No');
});

test('round 2 (Maven / CRA): "If you selected …" boxes, first of your family, spelled-out dates in question boxes', () => {
  const p = student();
  assert.equal(
    matcher.classify(desc("If you selected 'A friend or relative', please put their full name below.")),
    null,
    'never your own name',
  );
  assert.equal(matcher.classify(desc('If you selected yes, please tell us more', { kind: 'textarea' })), null);
  const firstGen = matcher.classify(
    desc(
      {
        question:
          'If you went to university (college in the USA) or home country equivalent, were you the first of your family to do so',
      },
      { kind: 'select', options: opts('Yes', 'No', 'Prefer not to say') },
    ),
  );
  assert.equal(firstGen.type, 'eeo.parentsDegree');
  p.eeo.parentsDegree = 'Yes';
  assert.equal(
    ask(p, 'eeo.parentsDegree', 'If you went to university, were you the first of your family to do so').text,
    'No',
    'a parent has a degree, so not the first',
  );
  assert.equal(
    matcher.classify(
      desc(
        {
          question:
            'Do you have a disability or long-term health condition including, but not limited to: neurodiversity?',
        },
        { kind: 'select', options: opts('Yes', 'No') },
      ),
    ).type,
    'eeo.disability',
  );
  // CRA "Earliest availability to start at CRA (not binding)": no placeholder, a sentence.
  p.job.startDate = '2027-06-28';
  const v = ask(p, 'job.startDate', 'Earliest availability to start at CRA (not binding)');
  assert.equal(matcher.formatForText(v, desc('Earliest availability to start at CRA (not binding)')), '28 June 2027');
  assert.equal(matcher.formatForText(v, desc({ label: 'Start date', placeholder: 'Pick date...' })), '06/28/2027');
  assert.equal(matcher.formatForText(v, desc({ label: 'When can you start? (DD/MM/YYYY)' })), '28/06/2027');
  assert.equal(matcher.formatForText(v, desc('Available from')), '06/28/2027', 'a short label keeps the usual format');
  // No format on the page: its language or country decides day or month first (Personio on a German site).
  const on = (extra) => ({ ...desc('Available from'), ...extra });
  assert.equal(matcher.formatForText(v, on({ lang: 'de', host: 'acme.jobs.personio.de' })), '28.06.2027');
  assert.equal(matcher.formatForText(v, on({ lang: '', host: 'acme.jobs.personio.de' })), '28.06.2027');
  assert.equal(matcher.formatForText(v, on({ lang: 'en-GB', host: 'careers.example.com' })), '28/06/2027');
  assert.equal(matcher.formatForText(v, on({ lang: 'en', host: 'job-boards.eu.greenhouse.io' })), '28/06/2027');
  assert.equal(matcher.formatForText(v, on({ lang: 'en-US', host: 'acme.co.uk' })), '06/28/2027', 'the page says US');
  assert.equal(matcher.formatForText(v, on({ lang: 'en', host: 'jobs.lever.co' })), '06/28/2027');
  assert.equal(matcher.formatForText(v, on({ lang: 'ja', host: 'example.jp' })), '2027-06-28');
});

test('Greenhouse education block, then screening questions asking about it again (DV Trading, Schonfeld)', () => {
  const p = student();
  const page = [
    desc('First Name'),
    desc('School', { kind: 'combobox' }),
    desc('Degree', { kind: 'combobox' }),
    desc('Discipline', { kind: 'combobox' }),
    desc('End date year', { kind: 'number' }),
    desc('LinkedIn Profile'),
    desc('Website'),
    desc('Please re-confirm the university you currently attend', { kind: 'combobox' }),
    desc('What is your expected graduation date?', { kind: 'combobox' }),
    desc('What degree are you currently pursuing?', { kind: 'combobox' }),
  ];
  const t = types(matcher.plan(page, p));
  assert.deepEqual(
    t.slice(7),
    ['edu.school#0', 'edu.end#0', 'edu.degree#0'],
    'about the first entry, not a second one',
  );
  // A real second entry still starts one.
  const two = types(
    matcher.plan(
      [desc('School'), desc('Degree'), desc('End date'), desc('Website'), desc('School'), desc('Degree')],
      p,
    ),
  );
  assert.deepEqual(two, ['edu.school#0', 'edu.degree#0', 'edu.end#0', 'links.website', 'edu.school#1', 'edu.degree#1']);
  // Putnam: a long Yes/No question ending "If so, please provide agency name" is not your name.
  assert.equal(
    matcher.classify(
      desc(
        'Inizio offers a full suite of advisory, medical, marketing, and engagement services. To your knowledge, have you actively interviewed with another Inizio agency in the past 12 months? If so, please provide agency name.',
        { kind: 'combobox' },
      ),
    ),
    null,
  );
  assert.equal(matcher.classify(desc('Please enter your full name as it appears on your passport')).type, 'name.full');
});

test('enrolment status from your education dates (SpaceX, Cloover)', () => {
  const today = new Date(2026, 9, 2);
  const spacex = opts(
    'I will be enrolled in a bachelor’s degree program by the start of employment',
    'I will be enrolled in a graduate degree program by the start of employment',
    'None of the above',
  );
  const p = student(); // BSc to June 2027
  const v = fields.resolve('edu.enrolled', p, { question: 'please select your enrollment status', today });
  assert.equal(matcher.matchOption(spacex, v), 0);
  assert.equal(matcher.matchOption(opts('Bachelor', 'Master', 'Graduated'), v), 0);
  assert.equal(matcher.matchOption(opts('Yes', 'No'), v), 0);
  p.education[0].degree = 'MSc';
  assert.equal(matcher.matchOption(spacex, fields.resolve('edu.enrolled', p, { today })), 1);
  p.education[0].endDate = '2016-06';
  assert.equal(matcher.matchOption(spacex, fields.resolve('edu.enrolled', p, { today })), 2, 'graduated');
  assert.equal(
    matcher.classify(desc({ question: 'Please select your enrollment status:' }, { kind: 'select', options: spacex }))
      .type,
    'edu.enrolled',
  );
  assert.equal(
    matcher.classify(
      desc('If you are currently enrolled in university, what is your expected graduation date?', { kind: 'combobox' }),
    ).type,
    'edu.end',
  );
});

test('round 3 (live Trackr forms): right to work by country, job sites, number boxes, programming languages', () => {
  const p = student();
  Object.assign(p.address, { city: 'London', state: '', country: 'United Kingdom' });
  p.personal.nationality = 'British';
  p.job.authorized = 'Yes';
  p.job.sponsorship = 'No';
  const yn = opts('Yes', 'No');
  const pick = (type, q, o = yn) => {
    const v = ask(p, type, q, { kind: 'select' });
    const i = matcher.matchOption(o, v);
    return i < 0 ? null : o[i].text;
  };
  // A British student: the UK and Ireland yes; the US and the Netherlands no, with sponsorship needed.
  assert.equal(pick('job.authorized', 'Are you legally authorized to work in the United States?'), 'No');
  assert.equal(
    pick('job.sponsorship', 'Will you now or in the future require sponsorship to work in the U.S.?'),
    'Yes',
  );
  assert.equal(pick('job.authorized', 'Do you have the right to work in the UK?'), 'Yes');
  assert.equal(pick('job.sponsorship', 'Do you require visa sponsorship to work in the UK?'), 'No');
  assert.equal(pick('job.authorized', 'Are you authorized to work in Ireland?'), 'Yes');
  assert.equal(pick('job.authorized', 'Do you have the right to work in the Netherlands?'), 'No');
  assert.equal(pick('job.authorized', 'Are you eligible to work in the UK or the US?'), 'Yes');
  assert.equal(pick('job.authorized', 'Are you authorized to work in the country where this job is located?'), 'Yes');
  const us = opts(
    'I am authorized to work in the United States for any employer',
    'I require sponsorship to work in the United States',
  );
  assert.equal(pick('job.authorized', 'Are you legally authorized to work in the United States?', us), us[1].text);
  assert.match(
    ask(p, 'job.sponsorship', 'Please describe your US work authorization status', { kind: 'textarea' }).text,
    /don’t have the right to work in the United States/,
  );
  // EU citizens: the whole EU; the listed countries win over the nationality.
  p.personal.nationality = 'French';
  assert.equal(pick('job.authorized', 'Do you have the right to work in the Netherlands?'), 'Yes');
  p.job.workCountries = 'United Kingdom, United States';
  assert.equal(pick('job.authorized', 'Are you legally authorized to work in the United States?'), 'Yes');
  assert.equal(pick('job.authorized', 'Do you have the right to work in Germany?'), 'No');
  // Without a nationality or a list, the answers stand for wherever you apply, as before.
  p.job.workCountries = '';
  p.personal.nationality = '';
  assert.equal(pick('job.authorized', 'Are you legally authorized to work in the United States?'), 'Yes');
  // "Will you in the future require authorization to work in the US?" is a sponsorship question.
  const q = 'Will you in the future require authorization to legally work in the United States?';
  assert.equal(matcher.classify(desc(q, { kind: 'select', options: yn })).type, 'job.sponsorship');

  // A job site the form doesn't list: its kind of option, never a campus board or the firm's own site; else Other.
  p.job.referralSource = 'Trackr';
  const hear = (...o) => pick('job.referralSource', 'How did you hear about us?', opts(...o));
  assert.equal(hear('LinkedIn', 'Online job board', 'Careers fair', 'Other'), 'Online job board');
  assert.equal(hear('LinkedIn', 'DV Website', 'Campus Event', 'Other'), 'Other');
  assert.equal(
    hear('School job board (Handshake, Target Connect etc.)', 'Other (please state in next box)'),
    'Other (please state in next box)',
  );
  assert.equal(hear('LinkedIn', 'Glassdoor', 'Other Online Job Board'), 'Other Online Job Board');
  assert.equal(hear('LinkedIn', 'Indeed', 'Internet forum (Reddit/Hacker News/etc.)'), null);
  p.job.referralSource = 'Handshake';
  assert.equal(hear('LinkedIn', 'Handshake', 'Other'), 'Handshake');

  // Number boxes: a UK class isn't a number; a phone number is its digits.
  p.education[0].gpa = '2:1';
  const gpa = ask(p, 'edu.gpa', 'Please list your GPA');
  assert.equal(matcher.formatForText(gpa, desc('GPA', { inputType: 'number' })), '');
  p.education[0].gpa = '3.8/4.0';
  assert.equal(matcher.formatForText(ask(p, 'edu.gpa', 'GPA'), desc('GPA', { inputType: 'number' })), '3.8');
  p.contact = { phoneCountryCode: '+44', phone: '7700 900123' };
  const phone = ask(p, 'phone', 'Phone Number');
  assert.equal(matcher.formatForText(phone, desc('Phone', { inputType: 'number' })), '447700900123');

  // "Top 3 programming languages" lists programming languages, not every skill.
  p.skills = 'Python, Excel, SQL, Financial modelling, Bloomberg, C++, R';
  assert.equal(ask(p, 'skills', 'Top 3 programming languages', { kind: 'textarea' }).text, 'Python, SQL, C++');
  assert.equal(ask(p, 'skills', 'Skills', { kind: 'textarea' }).items.length, 7);
});

test('round 3: new questions get their own profile answers', () => {
  const type = (q, kind = 'select', o = ['Yes', 'No']) =>
    (matcher.classify(desc(q, { kind, options: o ? opts(...o) : null })) || {}).type || null;
  assert.equal(type('Are you willing to work in the office 5 days a week?'), 'job.onsite');
  assert.equal(type('Are you able to work from our NYC office at least three days per week?'), 'job.onsite');
  assert.equal(type('Are you able to commute into our London office?'), 'location.commute');
  assert.equal(
    type('Have you applied to Marshall Wace before?', 'select', ['Yes - in a previous year', 'Yes- this year', 'No']),
    'compliance.previouslyApplied',
  );
  assert.equal(type('Do you have any upcoming offer deadlines?'), 'job.otherOffers');
  assert.equal(type('First and Last Name', 'text', null), 'name.full');
  assert.equal(type('Do you speak English at a Fluent or Native level?'), 'languages');
  assert.equal(type('If yes, please list each company and its corresponding deadline.', 'textarea', null), null);
  assert.equal(type("Tell us something about yourself that we can't find on your resume.", 'textarea', null), null);
  assert.equal(type('Please upload a copy of your most recent transcript.', 'file', null), 'file.transcript');
  const p = student();
  p.job.onsite = 'Yes';
  p.compliance.previouslyApplied = 'No';
  const choices = opts('Yes - in a previous year', 'Yes- this year', 'No');
  assert.equal(matcher.matchOption(choices, ask(p, 'compliance.previouslyApplied', 'Have you applied before?')), 2);
  assert.equal(ask(p, 'job.onsite', 'Are you willing to work in the office 5 days a week?').text, 'Yes');
});

test('round 3: "If yes" yes/no questions, citizenship-status lists, agreements with past employers', () => {
  const p = student();
  p.personal.nationality = 'British';
  Object.assign(p.address, { country: 'United Kingdom' });
  p.job.authorized = 'Yes';
  p.job.sponsorship = 'No';
  p.job.nonCompete = 'No';
  const yn = opts('Yes', 'No');
  // A yes/no question after "If yes" takes a No; a details box after "If yes" doesn't.
  const q = 'If yes, will you now or in the future require Appian to file a petition for employment-based visa status?';
  const sel = ask(p, 'job.sponsorship', q, { kind: 'select' });
  assert.equal(yn[matcher.matchOption(yn, sel)].text, 'No');
  assert.equal(
    ask(p, 'job.sponsorship', 'If yes, please give details of the visa you need', { kind: 'textarea' }),
    null,
  );
  // A US citizenship-status list for a British applicant: "Other (please explain)".
  const status = opts(
    '1) U.S. citizen or national of the United States',
    '2) U.S. lawful permanent resident (green card holder)',
    '3) Refugee under 8 U.S.C 1157',
    '6) Other (please explain)',
  );
  assert.equal(matcher.matchOption(status, ask(p, 'nationality', 'Citizenship Status')), 3);
  assert.equal(matcher.matchOption(opts('France', 'United Kingdom', 'Other'), ask(p, 'nationality', 'Nationality')), 1);
  // "Do you have any agreements with prior employers (for example, non-compete…)?"
  const agreements = desc(
    'Do you have any agreements with prior employers or other entities (for example, non-compete, non-solicitation, or confidentiality agreements) that may restrict your ability to work for us?',
    { kind: 'select', options: opts('Yes', 'No', 'Not Known') },
  );
  assert.equal(matcher.classify(agreements).type, 'job.nonCompete');
});

test('nickname-style boxes always get the legal name, never the profile preferredName', () => {
  const p = sample();
  p.personal.preferredName = 'Countess';
  const name = (question) => fields.resolve('name.preferred', p, { question: util.normalize(question) }).text;
  assert.equal(name('Preferred name'), 'Ada Lovelace');
  assert.equal(name('Preferred full name'), 'Ada Lovelace');
  assert.equal(name('Display name'), 'Ada Lovelace');
  assert.equal(name('Preferred first name'), 'Ada');
  assert.equal(name('Nickname'), 'Ada');
  assert.equal(name('Name you go by (first name)'), 'Ada');
});

test('phone numbers and dialling codes for a separate "Country/Region Code" list', () => {
  const p = sample();
  const code = (profile, list) => {
    const options = opts(...list);
    const i = matcher.matchOption(options, fields.resolve('phone.countryCode', profile, {}));
    return i < 0 ? null : options[i].text;
  };
  // SuccessFactors: "UNITED KINGDOM (+44)" with ISO values, beside the Isle of Man, Jersey and Guernsey.
  const sf = [
    ['- Select -', ''],
    ['CANADA (+1)', 'CA'],
    ['GUERNSEY (+44)', 'GG'],
    ['ISLE OF MAN (+44)', 'IM'],
    ['JERSEY (+44)', 'JE'],
    ['UNITED KINGDOM (+44)', 'GB'],
    ['UNITED STATES (+1)', 'US'],
    ['UNITED STATES MINOR OUTLYING ISLANDS (+340)', 'UM'],
    ['VIRGIN ISLANDS, U.S. (+1)', 'VI'],
  ];
  assert.equal(code(p, sf), 'UNITED KINGDOM (+44)');
  const us = sample();
  Object.assign(us.contact, { phoneCountryCode: '+1', phone: '415 555 0100' });
  us.address.country = 'United States';
  assert.equal(code(us, sf), 'UNITED STATES (+1)', 'not Canada or the US Virgin Islands');
  us.address.country = 'Canada';
  assert.equal(code(us, sf), 'CANADA (+1)', '+1 in Canada is Canada');
  us.address.country = 'United Kingdom';
  assert.equal(code(us, sf), 'UNITED STATES (+1)', 'a US number held by someone in the UK');
  p.address.country = '';
  assert.equal(code(p, sf), 'UNITED KINGDOM (+44)', '+44 alone is the UK');
  // Other spellings of the same list.
  for (const list of [
    ['+33 France', '+44 United Kingdom', '+1 United States'],
    ['FR +33', 'GB +44', 'US +1'],
    ['33', '44', '1'],
    [
      ['France', '33'],
      ['United Kingdom', '44'],
    ],
  ])
    assert.match(code(sample(), list), /44|United Kingdom/, JSON.stringify(list));
  // No code in the profile: the one the number starts with, else the country's.
  const bare = sample();
  Object.assign(bare.contact, { phoneCountryCode: '', phone: '+44 7700 900123' });
  assert.equal(code(bare, sf), 'UNITED KINGDOM (+44)');
  assert.equal(fields.resolve('phone', bare, { hasCountryCodeField: true }).text, '7700 900123');
  assert.equal(fields.resolve('phone', bare, {}).text, '+44 7700 900123');
  bare.contact.phone = '07700 900123';
  assert.equal(code(bare, sf), 'UNITED KINGDOM (+44)', 'from the country you live in');
  // With its code, a number written the way it is dialled at home loses its trunk zero; an Italian one keeps it.
  const home = sample();
  Object.assign(home.contact, { phoneCountryCode: '+44', phone: '07386 526574' });
  assert.equal(fields.resolve('phone', home, {}).text, '+44 7386 526574');
  assert.equal(fields.resolve('phone', home, { hasCountryCodeField: true }).text, '07386 526574');
  Object.assign(home.contact, { phoneCountryCode: '+39', phone: '06 1234 5678' });
  assert.equal(fields.resolve('phone', home, {}).text, '+39 06 1234 5678');
  // A number written with its code drops it when the code has a box of its own.
  const both = sample();
  Object.assign(both.contact, { phoneCountryCode: '+44', phone: '+44 (0)20 7946 0958' });
  assert.equal(fields.resolve('phone', both, { hasCountryCodeField: true }).text, '20 7946 0958');
});

test('a number written as at home loses its trunk 0 after the country code (but not in Italy)', () => {
  const p = sample();
  const phone = (code, number, ctx = {}) => {
    Object.assign(p.contact, { phoneCountryCode: code, phone: number });
    return fields.resolve('phone', p, ctx).text;
  };
  assert.equal(phone('+44', '07386 526574'), '+44 7386 526574');
  assert.equal(phone('+44', '07386 526574', { hasCountryCodeField: true }), '07386 526574', 'a national box keeps it');
  assert.equal(phone('+44', '(0)20 7946 0958'), '+44 20 7946 0958');
  assert.equal(phone('+33', '06 12 34 56 78'), '+33 6 12 34 56 78');
  assert.equal(phone('+39', '06 6988 3145'), '+39 06 6988 3145', 'Italian numbers keep their 0');
  assert.equal(phone('+1', '415 555 0100'), '+1 415 555 0100');
  assert.equal(phone('+44', '+44 7386 526574'), '+44 7386 526574');
});

test('a SuccessFactors sign-up page is a sign-up page with a country-code box', () => {
  const page = [
    desc('Email Address:*'),
    desc('Retype Email Address:*'),
    desc('Choose Password:*', { kind: 'password', inputType: 'password' }),
    desc('Retype Password:*', { kind: 'password', inputType: 'password' }),
    desc('First Name:*'),
    desc('Last Name:*'),
    desc('Country/Region Code:*', { kind: 'select', options: opts('- Select -', ['UNITED KINGDOM (+44)', 'GB']) }),
    desc({ label: 'Phone Number:*', title: 'Please enter phone number' }),
    desc('Country/Region of Residence:*', { kind: 'select', options: opts('- Select -', ['UNITED KINGDOM', 'GB']) }),
  ];
  const { results, context } = matcher.plan(page, sample());
  assert.deepEqual(
    results.map((r) => r && r.type),
    [
      'email',
      'email',
      'account.password',
      'account.passwordConfirm',
      'name.first',
      'name.last',
      'phone.countryCode',
      'phone',
      'address.country',
    ],
  );
  assert.equal(context.signup, true);
  assert.equal(context.hasCountryCodeField, true);
  assert.equal(context.jobContext, false);
  const p = sample();
  assert.equal(fields.resolve('phone', p, context).text, '20 7946 0958', 'the national number');
  assert.equal(matcher.matchOption(page[8].options, fields.resolve('address.country', p, context)), 1);
});

test('live survey (Glasgow undergraduate): a whole-number phone box gets the international number, written its way', () => {
  const p = sample();
  Object.assign(p.contact, { phoneCountryCode: '+44', phone: '7700 900123' });
  const fill = (signals, extra) => {
    const d = desc(signals, extra);
    const { results, context } = matcher.plan([d], p);
    const v = fields.resolve(results[0].type, p, Object.assign({}, context, { kind: d.kind, index: 0 }));
    return matcher.formatForText(v, d);
  };
  assert.equal(fill('Mobile number (inc. country code)', { kind: 'tel', inputType: 'tel' }), '+44 7700 900123');
  assert.equal(fill('Telephone number (with international dialling code)'), '+44 7700 900123');
  assert.equal(fill('Phone number (country code first)'), '+44 7700 900123');
  assert.equal(fill('Mobile Number (+CountryCode)'), '+44 7700 900123');
  assert.equal(fill('Mobile (incl. dialling code)', { kind: 'number', inputType: 'number' }), '447700900123');
  // An example without spaces (or E.164): none in the number either.
  assert.equal(
    fill({ label: 'Phone', placeholder: '+447700900000' }, { placeholderRaw: '+447700900000' }),
    '+447700900123',
  );
  assert.equal(fill('Mobile number (e.g. +447700900000)'), '+447700900123');
  assert.equal(fill('Mobile number in E.164 format'), '+447700900123');
  assert.equal(
    fill({ label: 'Phone', placeholder: '+44 7700 900000' }, { placeholderRaw: '+44 7700 900000' }),
    '+44 7700 900123',
  );
  assert.equal(fill({ label: 'Phone', placeholder: '+44…' }, { placeholderRaw: '+44…' }), '+44 7700 900123');
  // Too long for the box: the national number, then without its spaces (never cut short).
  assert.equal(fill('Phone', { maxLength: 11 }), '7700 900123');
  assert.equal(fill('Phone', { maxLength: 10 }), '7700900123');
  // A real code box beside it still takes the code, and the number goes in without it.
  const page = [
    desc('Country code', { kind: 'select', options: opts('+1 United States', '+44 United Kingdom') }),
    desc('Mobile number'),
  ];
  const { results, context } = matcher.plan(page, p);
  assert.deepEqual(
    results.map((r) => r.type),
    ['phone.countryCode', 'phone'],
  );
  assert.equal(matcher.matchOption(page[0].options, fields.resolve('phone.countryCode', p, context)), 1);
  assert.equal(fields.resolve('phone', p, context).text, '7700 900123');
  // Only the number box beside the code box: another phone box further down takes the whole number.
  const long = [
    desc('Phone number'),
    desc('Email'),
    desc('First name'),
    desc('Last name'),
    desc('Phone number country', { kind: 'select', options: opts('Italy', 'United Kingdom', 'United States') }),
    desc('Mobile phone number', { kind: 'tel', inputType: 'tel' }),
  ];
  const planned = matcher.plan(long, p);
  assert.deepEqual(
    planned.results.map((r) => r.type),
    ['phone', 'email', 'name.first', 'name.last', 'phone.countryCode', 'phone'],
  );
  const phoneAt = (i) =>
    fields.resolve('phone', p, Object.assign({}, planned.context, { part: planned.results[i].part })).text;
  assert.equal(phoneAt(0), '+44 7700 900123');
  assert.equal(phoneAt(5), '7700 900123');
});

/** A University of Glasgow undergraduate expecting a 2:1 in 2027, living in Glasgow. */
function glasgow() {
  const p = fields.createProfile('Glasgow');
  Object.assign(p.address, { city: 'Glasgow', country: 'United Kingdom' });
  p.education = [
    Object.assign(fields.blankEducation(), {
      school: 'University of Glasgow',
      degree: 'BSc (Hons)',
      field: 'Computer Science',
      classification: '2:1',
      startDate: '2023-09',
      endDate: '2027-06',
    }),
  ];
  return p;
}
const TODAY = new Date('2026-10-03');

test('degree classification: your class, else a class kept as the GPA; GPA questions keep to GPAs', () => {
  const p = glasgow();
  const q = (type, question, extra) => ask(p, type, question, Object.assign({ today: TODAY }, extra));
  const cls = q('edu.classification', 'Expected/Achieved Degree Classification');
  assert.equal(cls.text, '2:1', 'a free-text box gets it as written');
  assert.equal(cls.cls, 'upper');
  assert.equal(cls.expected, true, 'still studying: predicted');
  assert.equal(q('edu.gpa', 'GPA'), null, 'a class is not a GPA');
  assert.equal(q('edu.gpa', 'Grade').text, '2:1', 'a plain "Grade" box with no GPA takes the class');
  assert.equal(q('edu.gpa', 'GPA / grade').text, '2:1');
  assert.equal(q('edu.gpa', 'Grade point average'), null);
  assert.equal(
    q('edu.classification', 'Degree result', { today: new Date('2028-01-01') }).expected,
    false,
    'graduated',
  );
  // The class kept in the GPA box ("2:1") answers both, except a question that wants a number.
  p.education[0].classification = '';
  p.education[0].gpa = '2:1';
  assert.equal(q('edu.classification', 'Predicted degree classification').cls, 'upper');
  assert.equal(q('edu.gpa', 'GPA').text, '2:1', 'as before: all there is');
  assert.equal(q('edu.gpa', 'Cumulative GPA (out of 4.0)'), null);
  assert.equal(q('edu.gpa', 'GPA', { kind: 'number' }), null);
  // A numeric GPA stays a GPA, and is what a classification box gets when there's nothing else.
  p.education[0].gpa = '3.8/4.0';
  assert.equal(q('edu.gpa', 'GPA (out of 4.0)').number, 3.8);
  assert.equal(q('edu.classification', 'Final degree grade (or predicted)').text, '3.8/4.0');
  assert.equal(
    matcher.matchOption(opts('1st', '2:1', '2:2'), q('edu.classification', 'Degree classification')),
    -1,
    'never a class for a GPA',
  );
  p.education[0].gpa = '';
  assert.equal(q('edu.classification', 'Degree classification'), null);
  // A school-level question is answered from a school entry: A-level grades never get the degree class.
  p.education[0].classification = 'First';
  assert.equal(q('edu.gpa', 'A-level grades'), null);
  assert.equal(q('edu.classification', 'Final grade obtained in School Graduation (Abitur or equivalent)'), null);
});

test('degree classes pick their option however the list spells them, predicted or achieved', () => {
  const p = glasgow();
  const pick = (classification, ...options) => {
    p.education[0].classification = classification;
    const v = ask(p, 'edu.classification', 'Expected/Achieved Degree Classification', { today: TODAY });
    const i = matcher.matchOption(opts(...options), v);
    return i < 0 ? null : options[i];
  };
  const alloyed = ['1st', '2:1', '2:2', 'Pass', 'Merit', 'Distinction', 'Other'];
  assert.equal(pick('2:1', ...alloyed), '2:1');
  assert.equal(pick('First', ...alloyed), '1st');
  assert.equal(pick('Distinction', ...alloyed), 'Distinction');
  const long = [
    'First Class Honours (1st)',
    'Upper Second Class Honours (2:1)',
    'Lower Second Class Honours (2:2)',
    'Third Class Honours',
    'Ordinary/Pass',
    'Other',
    'N/A – not yet known',
  ];
  assert.equal(pick('2:1', ...long), 'Upper Second Class Honours (2:1)');
  assert.equal(pick('Upper second', ...long), 'Upper Second Class Honours (2:1)');
  assert.equal(pick('2:2', ...long), 'Lower Second Class Honours (2:2)');
  assert.equal(pick('Third', ...long), 'Third Class Honours');
  assert.equal(pick('Pass', ...long), 'Ordinary/Pass');
  assert.equal(pick('2:1', 'First', '2(i)', '2(ii)', 'Third'), '2(i)');
  assert.equal(pick('2:2', 'First', '2i', '2ii', 'Third'), '2ii');
  assert.equal(pick('2:1', 'First', '2.1', '2.2', 'Third'), '2.1');
  assert.equal(pick('Merit', ...long), null, 'never "Other" or a wrong class');
  const both = ['Upper Second (2:1) – achieved', 'Upper Second (2:1) – predicted', 'Lower Second (2:2) – predicted'];
  assert.equal(pick('2:1', ...both), 'Upper Second (2:1) – predicted', 'still studying');
  p.education[0].endDate = '2025-06';
  assert.equal(pick('2:1', ...both), 'Upper Second (2:1) – achieved', 'graduated');
  assert.equal(
    pick('2:1', 'Upper Second (2:1) – predicted', 'First (1st) – predicted'),
    'Upper Second (2:1) – predicted',
  );
  assert.equal(pick('2:1', '3.00 - 3.49', '3.50 - 4.00'), null, 'GPA bands');
});

test('a school picks the same institution from a list, never a similarly named one', () => {
  const p = glasgow();
  const pick = (school, ...options) => {
    p.education[0].school = school;
    const i = matcher.matchOption(opts(...options), ask(p, 'edu.school', 'University'));
    return i < 0 ? null : options[i];
  };
  const confusers = [
    'Glasgow Caledonian University',
    'Glasgow School of Art',
    'University of Strathclyde (Glasgow)',
    'Royal Conservatoire of Scotland (Glasgow)',
    'University of the West of Scotland',
  ];
  for (const spelling of [
    'The University of Glasgow',
    'Glasgow, University of',
    'University of Glasgow (UofG)',
    'Glasgow University',
    'University of Glasgow',
  ])
    assert.equal(pick('University of Glasgow', ...confusers, spelling), spelling, spelling);
  assert.equal(pick('University of Glasgow', ...confusers), null, 'the wrong Glasgow never wins');
  assert.equal(
    pick('Glasgow University', 'Glasgow Caledonian University', 'University of Glasgow'),
    'University of Glasgow',
  );
  assert.equal(pick('Glasgow Caledonian University', 'University of Glasgow', 'Glasgow School of Art'), null);
  assert.equal(pick('Queen Mary University of London', 'University of London', 'King’s College London'), null);
  assert.equal(
    pick("King's College London", 'Imperial College London', 'King’s College London'),
    'King’s College London',
  );
  assert.equal(
    pick('Imperial College London', 'Imperial College', 'University College London (UCL)'),
    'Imperial College',
  );
  assert.equal(
    pick(
      'University of the West of England',
      'University of the West of Scotland',
      'UWE Bristol (University of the West of England)',
    ),
    'UWE Bristol (University of the West of England)',
  );
  assert.equal(
    pick('UCL', 'University College London (UCL)', 'University of London'),
    'University College London (UCL)',
  );
  assert.equal(
    pick('London School of Economics', 'London School of Economics and Political Science', 'London Business School'),
    'London School of Economics and Political Science',
  );
});

test('"Degree Type" (Alloyed): an MEng is an integrated master’s, an MSc a master’s, a Scottish MA (Hons) a bachelor’s', () => {
  const p = glasgow();
  const kinds = ['Bachelors Degree', 'Integrated Masters Degree', 'Masters Degree', 'PhD', 'Other'];
  const pick = (degree) => {
    p.education[0].degree = degree;
    const i = matcher.matchOption(opts(...kinds), ask(p, 'edu.degree', 'Degree Type'));
    return i < 0 ? null : kinds[i];
  };
  assert.equal(pick('BSc (Hons) Computer Science'), 'Bachelors Degree');
  assert.equal(pick('MEng Electronic Engineering'), 'Integrated Masters Degree');
  assert.equal(pick('MSc Data Science'), 'Masters Degree');
  assert.equal(pick('MA (Hons) Economics'), 'Bachelors Degree');
  assert.equal(pick('PhD'), 'PhD');
});

test('transcript uploads only for a level of study you have an entry at (Databricks on Greenhouse)', () => {
  const p = glasgow(); // a BSc
  const applies = (question) => fields.uploadApplies('file.transcript', p, util.normalize(question));
  assert.equal(applies('Please provide a recent transcript of your undergraduate studies.'), true);
  assert.equal(applies('If applicable, please provide a recent transcript of your graduate studies.'), false);
  for (const q of ['Postgraduate transcript', 'Master’s transcript', 'Graduate school transcript (if applicable)'])
    assert.equal(applies(q), false, q);
  assert.equal(applies('Graduate transcript'), false);
  assert.equal(applies('High school transcript'), false, 'no school entry');
  for (const q of [
    'University transcript',
    'Transcript of your most recent degree',
    'Academic transcripts (undergraduate and postgraduate)',
    'Transcript',
  ])
    assert.equal(applies(q), true, q);
  assert.equal(fields.uploadApplies('file.resume', p, util.normalize('Graduate CV')), true, 'only level-bound uploads');
  // A master's student has both; an integrated master's (MEng) is the undergraduate course too; a Scottish MA (Hons)
  // is a first degree.
  p.education.unshift(Object.assign(fields.blankEducation(), { school: 'University of Edinburgh', degree: 'MSc' }));
  assert.equal(applies('If applicable, please provide a recent transcript of your graduate studies.'), true);
  p.education = [Object.assign(fields.blankEducation(), { school: 'Imperial College London', degree: 'MEng' })];
  assert.equal(applies('Undergraduate transcript'), true);
  assert.equal(applies('Graduate transcript'), true);
  p.education = [
    Object.assign(fields.blankEducation(), { school: 'University of Glasgow', degree: 'MA (Hons) Economics' }),
  ];
  assert.equal(applies('Undergraduate transcript'), true);
  assert.equal(applies('Graduate transcript'), false);
  // A degree with no level ("Computer Science") rules nothing out.
  p.education = [
    Object.assign(fields.blankEducation(), { school: 'University of Glasgow', degree: 'Computer Science' }),
  ];
  assert.equal(applies('Graduate transcript'), true);
});

test('"Country of School" / "Country of Employer": from the entry’s location, else your home town', () => {
  const p = glasgow();
  const country = (location, type = 'edu.country') => {
    (type === 'edu.country' ? p.education : p.experience)[0].location = location;
    const v = ask(p, type, 'Country');
    return v ? v.iso2 : null;
  };
  assert.equal(country('Glasgow, Scotland'), 'GB');
  assert.equal(country('Edinburgh, UK'), 'GB');
  assert.equal(country('Cambridge, MA'), 'US', 'a state code, not Morocco');
  assert.equal(country('San Francisco, CA'), 'US', 'California, not Canada');
  assert.equal(country('Toronto, ON'), 'CA');
  assert.equal(country('Munich, Germany'), 'DE');
  assert.equal(country('Glasgow'), 'GB', 'your town: the country you live in');
  assert.equal(country(''), 'GB', '"University of Glasgow" for someone living in Glasgow');
  assert.equal(country('Paris'), null, 'not worked out');
  p.education[0].school = 'Harvard University';
  assert.equal(country(''), null);
  p.experience = [Object.assign(fields.blankExperience(), { company: 'Acme', location: 'London, United Kingdom' })];
  assert.equal(country('London, United Kingdom', 'exp.country'), 'GB');
  assert.equal(country('Dublin, Ireland', 'exp.country'), 'IE');
  const v = ask(p, 'edu.country', 'Country of School');
  assert.equal(v, null);
  p.education[0].location = 'Glasgow, Scotland';
  const pick = matcher.matchOption(
    opts('No Selection', 'France', 'United Kingdom'),
    ask(p, 'edu.country', 'Country of School'),
  );
  assert.equal(pick, 2);
});

test('SuccessFactors: a "From Date" that starts the education block after the work history is the degree’s', () => {
  const date = (label) => desc({ label, placeholder: 'MM/DD/YYYY' });
  const countries = { kind: 'select', options: opts('No Selection', 'France', 'United Kingdom') };
  const page = [
    desc('First Name'),
    date('From Date'),
    date('End Date'),
    desc('Employer'),
    desc('Job Title'),
    desc('Country of Employer', countries),
    date('From Date'),
    date('Expected or Completed Graduation'),
    desc('School (Please use the full name, for example, University of Connecticut)'),
    desc('Country of School', countries),
    desc('State/City/Region of School'),
    desc('Major'),
    desc('* Degree', { kind: 'select', options: opts('No Selection', "Bachelor's Degree") }),
    desc('* Highest Level of Education', { kind: 'select', options: opts('No Selection', "Bachelor's") }),
  ];
  assert.deepEqual(types(matcher.plan(page, sample())), [
    'name.first',
    'exp.start#0',
    'exp.end#0',
    'exp.company#0',
    'exp.title#0',
    'exp.country#0',
    'edu.start#0',
    'edu.end#0',
    'edu.school#0',
    'edu.country#0',
    'edu.location#0',
    'edu.field#0',
    'edu.degree#0',
    'edu.level',
  ]);
  // Without dates in the work history, "From Date" then "…Graduation" still pair up; with an education heading too.
  assert.deepEqual(
    types(
      matcher.plan(
        [desc('Employer'), desc('Job Title'), date('From Date'), date('Graduation Date'), desc('School')],
        sample(),
      ),
    ),
    ['exp.company#0', 'exp.title#0', 'edu.start#0', 'edu.end#0', 'edu.school#0'],
  );
  assert.deepEqual(
    types(
      matcher.plan(
        [desc('Employer'), desc('Job Title'), desc({ label: 'From', section: 'Education' }), desc('School')],
        sample(),
      ),
    ),
    ['exp.company#0', 'exp.title#0', 'edu.start#0', 'edu.school#0'],
  );
  // A second education block ("+ Add") is the second entry.
  const second = [date('From Date'), date('Expected or Completed Graduation'), desc('School')];
  assert.deepEqual(types(matcher.plan(second.concat(second), sample())), [
    'edu.start#0',
    'edu.end#0',
    'edu.school#0',
    'edu.start#1',
    'edu.end#1',
    'edu.school#1',
  ]);
  const p = sample();
  const v = fields.resolve('edu.start', p, { jobContext: true, index: 0 });
  assert.equal(matcher.formatForText(v, desc({ label: 'From Date', placeholder: 'MM/DD/YYYY' })), '09/01/2015');
});

test('Teamtailor: "Start Date" after the graduation year and degree class is not when the degree started', () => {
  const radios = (label, ...options) => desc({ question: label }, { kind: 'radio', options: opts(...options) });
  const plan = matcher.plan(
    [
      desc('University: Required', { kind: 'combo' }),
      desc('University Course Required'),
      radios('Gender Required', 'Male', 'Female'),
      radios('Degree Type Required', 'Bachelors Degree', 'Masters Degree'),
      radios('Year of Graduation Required', '2025', '2026', 'Other', '2027', '2028', '2029'),
      desc('Expected/Achieved Degree Classification Required', { kind: 'combo' }),
      desc('Start Date Required', { kind: 'date', inputType: 'date' }),
    ],
    glasgow(),
  );
  assert.deepEqual(types(plan), [
    'edu.school#0',
    'edu.field#0',
    'eeo.gender',
    'edu.degree#0',
    'edu.end#0:year',
    'edu.classification#0',
    null,
  ]);
});

/* ------------------------------------------- live survey: a British student in Glasgow */

function glaswegian() {
  const p = student();
  p.personal.nationality = 'British';
  Object.assign(p.address, { city: 'Glasgow', state: 'Scotland', postalCode: 'G12 8RS', country: 'United Kingdom' });
  Object.assign(p.job, { authorized: 'Yes', sponsorship: 'No', relocate: 'Yes', onsite: 'Yes' });
  return p;
}

/** The option a fill picks: the question goes through resolve with its options, as content/main.js does. */
function choose(p, type, question, list, extra) {
  const options = opts(...list);
  const v = ask(p, type, question, Object.assign({ kind: 'select', options }, extra));
  const i = v ? matcher.matchOption(options, v) : -1;
  return i < 0 ? null : options[i].text;
}

test('live survey: US work questions that name no country by name — visa words, options, the job, the form', () => {
  const p = glaswegian();
  const yn = ['Yes', 'No'];
  // Visa words name the country: H-1B, OPT, F-1… are the US; Tier 4, settled status… the UK.
  const h1b = 'Will you now or in the future require sponsorship for employment visa status (e.g., H-1B visa status)?';
  assert.equal(choose(p, 'job.sponsorship', h1b, yn), 'Yes');
  const imc =
    'Will you require immigration sponsorship to begin working for IMC? Examples of sponsorship would include (but is not limited to) F-1 OPT, H-1B, H-4 EAD, L-1, L-2, TN, O-1';
  assert.equal(choose(p, 'job.sponsorship', imc, ['Yes', 'No', 'Maybe/I don’t know']), 'Yes');
  const { geo } = globalThis.JTF;
  assert.deepEqual(geo.visaCountries('Do you have settled status or a BRP?'), ['GB']);
  assert.deepEqual(geo.visaCountries('Do you hold an EU Blue Card?'), ['EU']);
  assert.deepEqual(geo.visaCountries('Opt in to text messages about your application'), []);
  // Countries named in the options (CTC: "…to work in the US" / "…in the United States with no restrictions").
  const ctc = (country) => [
    `Now or at any point the future, I will require visa sponsorship to work in the ${country}. For example, if I were to start full time in the future with CTC I will need visa sponsorship at some point.`,
    `Now or at any point in the future, I am eligible to work in the ${country === 'US' ? 'United States' : country} with no restrictions and will not require sponsorship.`,
  ];
  const statements = 'Please select one of the following statements based on your work authorization:';
  assert.match(choose(p, 'job.authorized', statements, ctc('US')), /will require visa sponsorship/);
  assert.match(choose(p, 'job.authorized', statements, ctc('United Kingdom')), /eligible to work/);
  // Maven's Amsterdam programme: a British citizen has no right to work in the Netherlands.
  const maven = [
    'I am a Netherlands citizen',
    'I am an EU citizen',
    'Other Netherlands right to work holder',
    'I do not have the right to work in the Netherlands',
  ];
  assert.equal(choose(p, 'job.authorized', 'What is your current right to work status?', maven), maven[3]);
  // Notion's list of US visa types: not "None"; the AI picks one.
  const notion =
    'Will you now or at any time in the future require sponsorship for employment visa status (e.g. H1B, OPT)?';
  assert.equal(choose(p, 'job.sponsorship', notion, ['OPT', 'H1B', 'TN', 'None', 'Other']), null);
  // "…the country where this role is based?": where the job is, when that is known; else your home answers.
  const based = 'Are you legally authorized to work in the country where this role is based?';
  assert.equal(choose(p, 'job.authorized', based, yn, { jobLocation: 'New York, NY' }), 'No');
  assert.equal(choose(p, 'job.authorized', based, yn, { jobLocation: 'Chicago, Illinois, United States' }), 'No');
  assert.equal(choose(p, 'job.authorized', based, yn, { jobLocation: 'London, England, United Kingdom' }), 'Yes');
  assert.equal(choose(p, 'job.authorized', based, yn, { jobLocation: 'Dublin, Ireland' }), 'Yes');
  assert.equal(choose(p, 'job.authorized', based, yn), 'Yes');
  // Bain: the US visas are only examples; the country is the office's.
  const bain =
    'Will you now or at any point in the future require sponsorship for employer-based work authorization in the country of any office you selected? (For example: H-1B, TN, O-1, or other employment-based visas.)';
  assert.equal(choose(p, 'job.sponsorship', bain, yn), 'No');
  assert.equal(choose(p, 'job.sponsorship', bain, yn, { jobLocation: 'London' }), 'No');
  assert.equal(choose(p, 'job.sponsorship', bain, yn, { jobLocation: 'Boston, MA' }), 'Yes');
  const dv = [
    'Yes, I am authorized to work in this country for any employer',
    'No, I am not authorized to work in this country for any employer',
    'I am authorized to work in this country for my present employer only',
  ];
  assert.equal(choose(p, 'job.authorized', based, dv, { jobLocation: 'New York' }), dv[1]);
  const visa = 'Will you require any Visa sponsorship now or in the future?';
  assert.equal(choose(p, 'job.sponsorship', visa, yn, { jobLocation: 'Chicago' }), 'Yes');
  assert.equal(choose(p, 'job.sponsorship', visa, yn, { jobLocation: 'Amsterdam, North Holland, Netherlands' }), 'Yes');
  // A job in London or New York: the London answer stands.
  assert.equal(choose(p, 'job.sponsorship', visa, yn, { jobLocation: 'London, New York' }), 'No');
  assert.equal(choose(p, 'job.sponsorship', visa, yn), 'No');
  // "…the country you live in" is about home, wherever the job is.
  const home = 'Are you authorized to work in the country where you live?';
  assert.equal(choose(p, 'job.authorized', home, yn, { jobLocation: 'New York, NY' }), 'Yes');
  // UK and EU answers never flip for a UK or EU job, nor for an EU citizen in the EU.
  p.personal.nationality = 'French';
  assert.equal(choose(p, 'job.sponsorship', visa, yn, { jobLocation: 'Amsterdam' }), 'No');
});

test('live survey: a form asking about one country answers its countryless questions for it', () => {
  const p = glaswegian();
  const yn = opts('Yes', 'No');
  const select = (label) => desc(label, { kind: 'select', options: yn });
  const fill = (...labels) => {
    const descs = labels.map(select);
    const { results, context } = matcher.plan(descs, p);
    return descs.map((d, i) => {
      const v = fields.resolve(results[i].type, p, {
        ...context,
        index: 0,
        kind: 'select',
        question: util.normalize(matcher.questionText(d)),
        options: d.options,
      });
      return yn[matcher.matchOption(yn, v)].text;
    });
  };
  const generic = 'Will you now or in the future require sponsorship for employment visa status?';
  // Five Rings (New York) and Five Rings (London) ask the same second question.
  assert.deepEqual(fill('Are you legally eligible to work in the United States?', generic), ['No', 'Yes']);
  assert.deepEqual(fill('Are you legally eligible to work in the United Kingdom?', generic), ['Yes', 'No']);
  // Both countries on one form: the second question is anyone's guess, so your home answer.
  assert.deepEqual(
    fill('Are you authorized to work in the United States?', 'Are you authorized to work in the UK?', generic),
    ['No', 'Yes', 'No'],
  );
  // The Netherlands and "an EU citizen" in the options are one country.
  const { context } = matcher.plan(
    [
      desc('What is your current right to work status?', {
        kind: 'select',
        options: opts(
          'I am a Netherlands citizen',
          'I am an EU citizen',
          'I do not have the right to work in the Netherlands',
        ),
      }),
      select('Will you require visa sponsorship to join the programme?'),
    ],
    p,
  );
  assert.deepEqual(context.formCountries, ['NL']);
});

test('live survey: authorization options that contradict each other, and text boxes that want a sentence', () => {
  const p = glaswegian();
  // circleback: "Yes, but I will need visa sponsorship" is a Yes to being authorized, which a British student isn't.
  const circleback = [
    'Yes, but I will need visa sponsorship in the future',
    'Yes, but I will need a visa transfer',
    'Yes',
    "No, I can't legally work in the US yet",
  ];
  const q = 'Are you authorized to work in the United States?';
  assert.equal(choose(p, 'job.authorized', q, circleback), circleback[3]);
  // The same from your own answers (no nationality to go by): not authorized, sponsorship needed.
  const own = student();
  Object.assign(own.job, { authorized: 'No', sponsorship: 'Yes' });
  assert.equal(choose(own, 'job.authorized', q, circleback), circleback[3]);
  // Authorized now, sponsorship later: the sponsorship one is yours.
  own.job.authorized = 'Yes';
  assert.equal(choose(own, 'job.authorized', q, circleback.slice(0, 2).concat(circleback[3])), circleback[0]);
  // IMC's context box and DRW's "If yes, please explain": a sentence, never a bare Yes.
  assert.equal(
    ask(
      p,
      'job.sponsorship',
      'Is there any other context you’d like to share about your U.S. Immigration sponsorship needs?',
      {
        kind: 'textarea',
      },
    ).text,
    'I don’t have the right to work in the United States and would need visa sponsorship.',
  );
  assert.match(
    ask(
      p,
      'job.sponsorship',
      'Will you now or in the future require sponsorship for employment visa status (e.g. H-1B visa status)? If yes, please explain.',
      { kind: 'text' },
    ).text,
    /don’t have the right to work in the United States/,
  );
  assert.equal(
    ask(p, 'job.sponsorship', 'Is there any other context you’d like to share about your sponsorship needs?', {
      kind: 'textarea',
    }).text,
    'I have the right to work and do not need visa sponsorship.',
  );
  assert.equal(
    ask(p, 'job.sponsorship', 'Do you require visa sponsorship to work in the US?', { kind: 'text' }).text,
    'Yes',
  );
});

test('live survey: "Are you located in London?", commuting and working somewhere, from your address', () => {
  const p = glaswegian();
  const yes = (type, q, extra) => {
    const v = ask(p, type, q, Object.assign({ kind: 'select' }, extra));
    return v ? v.text : null;
  };
  // Glasgow is in the UK and Scotland, not London or England.
  assert.equal(yes('location.in', 'Are you located in London?'), 'No');
  assert.equal(yes('location.in', 'Are you based in the UK?'), 'Yes');
  assert.equal(yes('location.in', 'Are you currently living in the UK?'), 'Yes');
  assert.equal(yes('location.in', 'Are you based in Scotland?'), 'Yes');
  assert.equal(yes('location.in', 'Are you based in England?'), 'No');
  assert.equal(yes('location.in', 'Are you located in the United States?'), 'No');
  // Commuting is the same metro area.
  assert.equal(yes('location.commute', 'Are you able to commute into our London office?'), 'No');
  assert.equal(yes('location.commute', 'Do you live within commuting distance of our London office?'), 'No');
  assert.equal(
    yes('location.commute', 'Are you able to commute into our Rowayton, CT and/or New York, NY offices?'),
    'No',
  );
  assert.equal(yes('location.commute', 'Are you able to commute to our office?', { jobLocation: 'Edinburgh' }), 'No');
  assert.equal(yes('location.commute', 'Are you able to commute to our office?', { jobLocation: 'Glasgow' }), 'Yes');
  assert.equal(yes('location.commute', 'Are you able to commute to our office?'), null);
  // Willing to work there: yes where you live or will relocate to; with "onsite 5 days a week", your on-site answer too.
  assert.equal(yes('job.workIn', 'Willing to work in London?'), 'Yes');
  assert.equal(yes('job.workIn', 'Would you be willing to be based in our London office?'), 'Yes');
  assert.equal(yes('job.workIn', 'Are you willing to work onsite at our London office 5 days a week?'), 'Yes');
  p.job.onsite = 'No';
  assert.equal(yes('job.workIn', 'Are you willing to work onsite at our London office 5 days a week?'), 'No');
  p.job.onsite = '';
  assert.equal(yes('job.workIn', 'Are you willing to work onsite at our London office 5 days a week?'), null);
  p.job.relocate = 'No';
  assert.equal(yes('job.workIn', 'Willing to work in London?'), 'No');
  assert.equal(yes('job.workIn', 'Willing to work in Glasgow?'), 'Yes');
  p.job.relocate = '';
  assert.equal(yes('job.workIn', 'Willing to work in London?'), null);
  // A Londoner (a borough counts); a town the list doesn't know can't be told apart from London.
  Object.assign(p.address, { city: 'Croydon', state: '', country: 'United Kingdom' });
  assert.equal(yes('location.in', 'Are you located in London?'), 'Yes');
  assert.equal(yes('location.commute', 'Are you able to commute into our London office?'), 'Yes');
  assert.equal(yes('location.in', 'Are you based in Scotland?'), 'No');
  Object.assign(p.address, { city: 'Slough' });
  assert.equal(yes('location.in', 'Are you located in London?'), null);
  assert.equal(yes('location.commute', 'Are you able to commute into our London office?'), null);
  assert.equal(yes('location.in', 'Are you based in the UK?'), 'Yes');
  assert.equal(yes('location.commute', 'Are you able to commute into our New York office?'), 'No');
});

test('live survey: UK visas, immigration status and citizenship for a British citizen, and for others', () => {
  const p = glaswegian();
  const yn = ['Yes', 'No'];
  // A citizen holds no visa: "Not applicable – British/Irish citizen" when offered, else No.
  assert.equal(choose(p, 'job.visa', 'Do you hold a valid UK visa?', yn), 'No');
  const held = ['Yes – Skilled Worker visa', 'Yes – Student visa', 'No', 'Not applicable – British/Irish citizen'];
  assert.equal(choose(p, 'job.visa', 'Do you currently hold a UK visa?', held), held[3]);
  assert.equal(choose(p, 'job.visa', 'Do you currently hold a valid U.S. visa?', yn), 'No');
  // An Irish citizen needs no UK visa either; a French one in Paris has none; a French one living and working in
  // Glasgow might have settled status or a visa, so that is left alone.
  p.personal.nationality = 'Irish';
  assert.equal(choose(p, 'job.visa', 'Do you currently hold a UK visa?', held), held[3]);
  p.personal.nationality = 'French';
  assert.equal(choose(p, 'job.visa', 'Do you hold a valid UK visa?', yn), null);
  Object.assign(p.address, { city: 'Paris', state: '', country: 'France' });
  assert.equal(choose(p, 'job.visa', 'Do you hold a valid UK visa?', yn), 'No');
  assert.equal(
    choose(p, 'job.visa', 'Do you currently hold a UK visa?', held),
    'No',
    'never the British/Irish citizen option',
  );
  // Immigration status lists and citizenship yes/no questions.
  const uk = glaswegian();
  const status = [
    'British citizen',
    'Settled status',
    'Pre-settled status',
    'Skilled Worker visa',
    'Student visa',
    'Other',
  ];
  assert.equal(choose(uk, 'job.authorized', 'What is your immigration status in the UK?', status), 'British citizen');
  assert.equal(choose(uk, 'citizen', 'Do you hold British citizenship?', yn), 'Yes');
  assert.equal(choose(uk, 'citizen', 'Do you hold US citizenship?', yn), 'No');
  const where = 'Are you a citizen of the country where this job is located?';
  assert.equal(choose(uk, 'citizen', where, yn, { jobLocation: 'London, UK' }), 'Yes');
  assert.equal(choose(uk, 'citizen', where, yn, { jobLocation: 'New York, NY' }), 'No');
  assert.equal(choose(uk, 'citizen', where, yn), null);
});

test('geo: places in sentences and job locations', () => {
  const { geo } = globalThis.JTF;
  const countries = (s) => geo.countriesIn(s);
  assert.deepEqual(countries('New York, NY'), ['US']);
  assert.deepEqual(countries('Chicago, IL'), ['US']);
  assert.deepEqual(countries('Indianapolis, IN'), ['US']);
  assert.deepEqual(countries('Mumbai, IN'), ['IN']);
  assert.deepEqual(countries('Berlin, DE'), ['DE']);
  assert.deepEqual(countries('Remote - US'), ['US']);
  assert.deepEqual(countries('USA - Remote'), ['US']);
  assert.deepEqual(countries('London'), ['GB']);
  assert.deepEqual(countries('Glasgow, Scotland'), ['GB']);
  assert.deepEqual(countries('Amsterdam, North Holland, Netherlands'), ['NL']);
  assert.deepEqual(countries('London, England, New York, New York').sort(), ['GB', 'US']);
  assert.deepEqual(countries('San Francisco, California / New York, New York'), ['US']);
  assert.deepEqual(countries('Hybrid'), []);
  // A longer name wins: New York is not York, Northern Ireland not Ireland.
  assert.deepEqual(
    geo.placesNamed('Do you have the right to work in Northern Ireland?').map((pl) => pl.country),
    ['GB'],
  );
  assert.deepEqual(
    geo.placesNamed('Are you able to commute to our HQ in the South Bay Area of Los Angeles?').map((pl) => pl.metro),
    ['los angeles'],
  );
  assert.deepEqual(geo.whereIs({ city: 'Glasgow', state: 'Scotland', country: 'United Kingdom' }), {
    country: 'GB',
    region: 'Scotland',
    metro: 'glasgow',
  });
  assert.deepEqual(geo.whereIs({ city: 'Brooklyn', state: 'NY', country: 'United States' }), {
    country: 'US',
    region: 'NY',
    metro: 'new york',
  });
  // Two Cambridges, told apart by the country.
  assert.equal(geo.whereIs({ city: 'Cambridge', state: 'MA', country: 'United States' }).metro, 'boston');
  assert.equal(geo.whereIs({ city: 'Cambridge', country: 'UK' }).metro, 'cambridge');
  assert.equal(geo.whereIs({ city: 'Greenwich', country: 'United Kingdom' }).metro, '');
});

/* --------------------------- live survey: a Glasgow Computing Science student with a Scottish school entry */

/** The survey's applicant: University of Glasgow BSc Computing Science (2:1 expected, June 2027), then Hillhead High. */
function computingScientist() {
  const p = glaswegian();
  p.education = [
    Object.assign(fields.blankEducation(), {
      school: 'University of Glasgow',
      degree: 'BSc',
      field: 'Computing Science',
      gpa: '2:1',
      location: 'Glasgow, UK',
      startDate: '2023-09',
      endDate: '2027-06',
    }),
    Object.assign(fields.blankEducation(), {
      school: 'Hillhead High School',
      degree: 'Advanced Highers',
      field: 'Mathematics, Physics, Computing Science',
      gpa: 'AAB',
      location: 'Glasgow, UK',
      startDate: '2017-08',
      endDate: '2023-06',
    }),
  ];
  return p;
}

/** What a fill puts in each box of a page: the option picked, the text typed, or null. */
function fillPage(page, p) {
  const { results, context } = matcher.plan(page, p);
  return page.map((d, i) => {
    const r = results[i];
    if (!r || !r.type) return null;
    const v = fields.resolve(r.type, p, {
      ...context,
      index: r.index || 0,
      part: r.part,
      kind: d.kind,
      question: util.normalize(matcher.questionText(d)),
      options: d.options,
      today: TODAY,
    });
    if (!v) return null;
    if (!d.options) return matcher.formatForText(v, d);
    const k = matcher.matchOption(d.options, v);
    return k < 0 ? null : d.options[k].text;
  });
}

test('IMC: "If … is not listed, please specify." boxes are for answers the list lacks, never a second entry', () => {
  const p = computingScientist();
  const select = (label, ...options) => desc({ label }, { kind: 'select', options: opts(...options) });
  const years = select('When is your expected year of graduation?', '2023', '2024', '2025', '2026', '2027', '2028');
  const page = [
    years,
    desc('If your year of graduation is not listed, please specify.'),
    select('When is your expected graduation month?', 'January', 'February', 'May', 'June', 'July', 'December'),
    select(
      'What is your latest field of study?',
      'Mathematics',
      'Statistics',
      'Computer Science',
      'Economics',
      'Natural Science',
      'Physics',
      'Engineering (various disciplines)',
      'Informatics/Information Technology',
      'Other',
    ),
    desc('If latest field of study is not listed, please specify.'),
    select(
      'What is the current year of your studies?',
      "3rd year undergraduate (Bachelor's)",
      "4th year undergraduate (Bachelor's)",
      "1st year postgraduate (Master's)",
      'Other',
    ),
    desc('If current year of studies is not listed, please specify.'),
    select(
      'What is your current academic performance rating?',
      '90–100% | 9.0–10.0 average | First Class',
      '80–89% | 8.0–8.9 average | First Class',
      '70–79% | 7.0–7.9 average | First Class',
      '60–69% | 6.0–6.9 average | Upper Second',
      '50–59% | 5.0–5.9 average | Lower Second',
      '40–49% | 4.0–4.9 average | Third Class',
      'Below 40% | Below 4.0 average | Fail',
    ),
    desc('If residing in another country, please specify.'),
  ];
  assert.deepEqual(types(matcher.plan(page, p)), [
    'edu.end#0:year',
    null,
    'edu.end#0:month',
    'edu.field#0',
    null,
    'edu.year',
    null,
    'edu.classification#0',
    null,
  ]);
  assert.deepEqual(fillPage(page, p), [
    '2027',
    null,
    'June',
    'Computer Science',
    null,
    "4th year undergraduate (Bachelor's)",
    null,
    '60–69% | 6.0–6.9 average | Upper Second',
    null,
  ]);
  // Asked again in other words right after the list (a native select, or Greenhouse's react-select), it is still the
  // list's "other" box; a second block of the same fields is the second entry.
  assert.deepEqual(types(matcher.plan([years, desc('Graduation year')], p)), ['edu.end#0:year', null]);
  const search = desc({ label: 'When is your expected year of graduation?' }, { kind: 'combobox' });
  assert.deepEqual(types(matcher.plan([search, desc('Graduation year')], p)), ['edu.end#0:year', null]);
  const block = [desc('School'), years];
  assert.deepEqual(types(matcher.plan(block.concat(block), p)), [
    'edu.school#0',
    'edu.end#0:year',
    'edu.school#1',
    'edu.end#1:year',
  ]);
  for (const label of [
    'If your university does not appear in the above options, please select one of the "Other" options and enter it here.',
    'If your subject isn’t listed, please type it here',
    'If your degree is not in the list, please enter it',
  ])
    assert.equal(matcher.classify(desc(label)), null, label);
});

test('degree subjects: "Computing Science" is "Computer Science", never "Science"; categories by what they list', () => {
  const p = computingScientist();
  const subject = (question, ...options) => choose(p, 'edu.field', question, options);
  const rothesay = [
    'Biology',
    'Business',
    'Chemistry',
    'Computer Science',
    'Economics',
    'Engineering',
    'Mathematics',
    'Physical Sciences',
    'Physics',
    'Science',
    'Social Sciences',
    'Other',
  ];
  assert.equal(subject('What is your Degree discipline?', ...rothesay), 'Computer Science');
  const maven = [
    'Accounting',
    'Business & Management Studies',
    'Computer Science',
    'Data Science',
    'Engineering',
    'Mathematics & Statistics',
    'Physics & Astronomy',
    'Software Engineering',
    'Other',
  ];
  assert.equal(
    subject('Which degree subject are you currently studying/have most recently studied?', ...maven),
    'Computer Science',
  );
  const talos = [
    'STEM (Science, Technology/Computer Science, Engineering, Mathematics)',
    'Finance (Accounting, Risk, Investment, Corporate Finance, Banking)',
    'Economics ',
    'Humanities (History, Geography, Religious Education (RE), English Literature and Language, Philosophy, Classics, and Modern Languages)',
    'Law ',
    'Business',
    'Other',
    'Not Applicable/I do not hold an undergraduate degree',
  ];
  assert.equal(subject('Field of Study in your Undergraduate degree', ...talos), talos[0]);
  assert.equal(subject('Field of Study in your Postgraduate degree', ...talos), null, 'no postgraduate entry');
  assert.equal(
    subject('What is your major?', 'Business/Finance', 'Economics', 'Mathematics', 'Computer Science', 'Engineering'),
    'Computer Science',
  );
  // Other names both ways, and the catch-all only when nothing more telling is offered.
  const pick = (field, ...options) => {
    p.education[0].field = field;
    return subject('Degree subject', ...options);
  };
  assert.equal(pick('Maths', 'Mathematics & Statistics', 'Economics'), 'Mathematics & Statistics');
  assert.equal(pick('Mathematics', 'Maths', 'Physics'), 'Maths');
  assert.equal(pick('Econ', 'Econometrics', 'Economics'), 'Economics');
  assert.equal(pick('PPE', 'Politics, Philosophy and Economics', 'Philosophy'), 'Politics, Philosophy and Economics');
  assert.equal(pick('Philosophy, Politics and Economics', 'PPE', 'Economics'), 'PPE');
  assert.equal(pick('LLB Law', 'Accounting', 'Law (LLB)', 'Linguistics'), 'Law (LLB)');
  assert.equal(pick('Natural Sciences', 'Natural Science', 'Science'), 'Natural Science');
  assert.equal(pick('Business Management', 'Business', 'Management Science'), 'Business');
  assert.equal(
    pick('Electrical and Electronic Engineering', 'Electrical Engineering', 'Engineering'),
    'Electrical Engineering',
  );
  assert.equal(pick('Mechanical Engineering', 'Science', 'Engineering', 'Arts'), 'Engineering');
  const stem = 'STEM (Science, Technology, Engineering, Maths)';
  assert.equal(pick('Physics', stem, 'Humanities', 'Business'), stem);
  assert.equal(pick('Computer Science', 'Science', 'Computer Engineering', 'Arts'), 'Science', 'only a catch-all fits');
  assert.equal(pick('History', 'Mathematics', 'Science', 'Other'), null, 'never "Other" or a wrong subject');
  // A text box gets the subject as written.
  p.education[0].field = 'Computing Science';
  assert.equal(ask(p, 'edu.field', 'Degree subject', { kind: 'text' }).text, 'Computing Science');
});

test('Scottish school qualifications: secondary-school questions answer from the Advanced Highers entry', () => {
  const p = computingScientist();
  const text = (type, question) => {
    const v = ask(p, type, question, { kind: 'text', today: TODAY });
    return v && v.text;
  };
  assert.equal(text('edu.gpa', 'What grades did you achieve in your secondary education?'), 'AAB');
  assert.equal(text('edu.gpa', 'What A Level grades (or International Equivalent) did you achieve?'), 'AAB');
  assert.equal(text('edu.gpa', 'Scottish Highers grades'), 'AAB');
  assert.equal(text('edu.gpa', 'Highers / Advanced Highers results'), 'AAB');
  assert.equal(text('edu.school', 'Name of secondary school'), 'Hillhead High School');
  assert.equal(text('edu.gpa', 'Maths GCSE grade'), null, 'GCSE grades are not Advanced Highers');
  assert.equal(text('edu.gpa', 'A-level grades'), null, 'nor A-levels, unless the question takes an equivalent');
  assert.equal(text('edu.school', 'Name of post-secondary institution'), 'University of Glasgow');
  for (const degree of ['Advanced Highers', 'Scottish Highers', 'IB Diploma', 'International Baccalaureate', 'BTEC'])
    assert.equal(matcher.degreeGroup(util.normalize(degree)), 'highschool', degree);
  assert.equal(matcher.degreeGroup(util.normalize('Baccalaureate degree')), null, 'a US bachelor’s, not a school');
});

test('high-school graduation years come from the school entry, never the degree', () => {
  const p = computingScientist();
  const select = (label, ...options) => desc({ label }, { kind: 'select', options: opts(...options) });
  const page = [
    desc('What year did you graduate from high school?'),
    select('What year did you graduate high school?', '2022', '2023', '2024'),
    select('When did you graduate from High School?', '2021', '2023', '2025'),
    desc('Year of completion of A-levels'),
    desc('Year you finished secondary school'),
    select('Expected graduation year', '2026', '2027', '2028'),
  ];
  assert.deepEqual(fillPage(page, p), ['2023', '2023', '2023', '2023', '2023', '2027']);
  assert.deepEqual(types(matcher.plan(page, p)).slice(-1), ['edu.end#0:year'], 'not a second entry');
  p.education.pop();
  assert.deepEqual(fillPage(page, p), [null, null, null, null, null, '2027']);
  assert.equal(matcher.classify(select('Are you a high school graduate?', 'Yes', 'No')), null);
});

test('Workday education dates: "From (Actual)", "To (Actual or Expected)", "End Date (or expected)"', () => {
  const p = computingScientist();
  const month = (label) => desc({ label, placeholder: 'MM/YYYY' });
  const page = [
    desc('School or University'),
    desc('Degree'),
    month('From (Actual)'),
    month('To (Actual or Expected)'),
    desc('Overall Result (GPA)'),
    desc({ label: 'GPA Scale' }, { kind: 'select', options: opts('4.0', '5.0', '10', 'UK degree classification') }),
    desc('Employer'),
    month('From'),
    month('End Date (or expected)'),
  ];
  assert.deepEqual(types(matcher.plan(page, p)), [
    'edu.school#0',
    'edu.degree#0',
    'edu.start#0',
    'edu.end#0',
    'edu.gpa#0',
    'edu.gpaScale#0',
    'exp.company#0',
    'exp.start#0',
    'exp.end#0',
  ]);
  assert.deepEqual(fillPage(page, p).slice(2, 6), ['09/2023', '06/2027', '2:1', 'UK degree classification']);
  assert.equal(matcher.classify(desc('Expected start date')).type, 'job.startDate', 'still the job’s start');
});

// Shell's Workday "My Experience": the instructions under "Education", above every entry.
const SHELL_HELP =
  "If your school/university uses a GPA system, enter your GPA on a 0- 4.0 scale. Otherwise, provide your overall result in your school/university's grading system. If you haven't graduated, enter your predicted result.";

/** What a fill puts in each box, with the help the page gives each one (content/main.js passes it as ctx.help). */
function fillWithHelp(page, p, today = TODAY) {
  const { results, context } = matcher.plan(page, p);
  return page.map((d, i) => {
    const r = results[i];
    if (!r || !r.type) return null;
    const v = fields.resolve(r.type, p, {
      ...context,
      index: r.index || 0,
      part: r.part,
      kind: d.kind,
      question: util.normalize(matcher.questionText(d)),
      help: util.normalize(matcher.helpText(d)),
      options: d.options,
      today,
    });
    if (!v) return null;
    if (!d.options) return matcher.formatForText(v, d);
    const k = matcher.matchOption(d.options, v);
    return k < 0 ? null : d.options[k].text;
  });
}

test('Workday (Shell): year-only "From" / "To (Actual or Expected)" boxes are the degree’s years', () => {
  const p = glasgow(); // 2023-09 → 2027-06
  const box = (signals) =>
    desc({ section: 'Education 1', sectionHelp: SHELL_HELP, ...signals }, { placeholderRaw: 'YYYY' });
  const variants = {
    'label without for: the text around it': [
      box({
        nearby: 'From*',
        placeholder: 'YYYY',
        attrs: 'dateSectionYear-input',
        ancestors: 'dateInputWrapper formField-startDate education-1',
      }),
      box({
        nearby: 'To (Actual or Expected)*',
        placeholder: 'YYYY',
        attrs: 'dateSectionYear-input',
        ancestors: 'dateInputWrapper formField-endDate education-1',
      }),
    ],
    'aria-label "Year": the wrapper’s id': [
      box({
        aria: 'Year',
        placeholder: 'YYYY',
        attrs: 'dateSectionYear-input',
        ancestors: 'dateInputWrapper formField-startDate education-1',
      }),
      box({
        aria: 'Year',
        placeholder: 'YYYY',
        attrs: 'dateSectionYear-input',
        ancestors: 'dateInputWrapper formField-endDate education-1',
      }),
    ],
    'a group labelled by the date’s label': [
      box({ aria: 'Year', group: 'From', placeholder: 'YYYY', ancestors: 'dateInputWrapper formField-startDate' }),
      box({
        aria: 'Year',
        group: 'To (Actual or Expected)',
        placeholder: 'YYYY',
        ancestors: 'dateInputWrapper formField-endDate',
      }),
    ],
    'a proper label': [
      box({ label: 'From', placeholder: 'YYYY' }),
      box({ label: 'To (Actual or Expected)', placeholder: 'YYYY' }),
    ],
  };
  const entry = (s) => desc({ section: 'Education 1', sectionHelp: SHELL_HELP, ...s });
  for (const [name, [from, to]] of Object.entries(variants)) {
    const page = [
      desc({ label: 'Job Title', section: 'Work Experience 1' }),
      desc({ label: 'Company', section: 'Work Experience 1' }),
      desc({ label: 'From', aria: 'Month', placeholder: 'MM', ancestors: 'dateInputWrapper formField-startDate' }),
      desc({ label: 'From', aria: 'Year', placeholder: 'YYYY', ancestors: 'dateInputWrapper formField-startDate' }),
      entry({ label: 'School or University' }),
      desc({ label: 'Degree', section: 'Education 1' }, { kind: 'combo' }),
      entry({ label: 'Field of Study' }),
      entry({ label: 'Overall Result (GPA)' }),
      from,
      to,
    ];
    assert.deepEqual(
      types(matcher.plan(page, p)).slice(4),
      ['edu.school#0', 'edu.degree#0', 'edu.field#0', 'edu.gpa#0', 'edu.start#0:year', 'edu.end#0:year'],
      name,
    );
    assert.deepEqual(
      fillWithHelp(page, p).slice(4),
      ['University of Glasgow', 'BSc (Hons)', 'Computer Science', '2:1', '2023', '2027'],
      name,
    );
  }
  // A four-digit box keeps the whole year; a two-digit one gets "27".
  const year = (extra) =>
    matcher.formatForText(fields.resolve('edu.end', p, { index: 0, part: 'year', jobContext: true }), {
      ...variants['a proper label'][1],
      ...extra,
    });
  assert.equal(year({ maxLength: 4 }), '2027');
  assert.equal(year({ maxLength: 2, placeholderRaw: 'YY' }), '27');
});

test('"Overall Result (GPA)": your class when the page takes your own grading system; a GPA box that wants a number stays empty', () => {
  const p = glasgow(); // a 2:1, still studying, no GPA
  const gpa = (question, help, extra) =>
    ask(p, 'edu.gpa', question, Object.assign({ kind: 'text', today: TODAY, help: util.normalize(help || '') }, extra));
  const shell = gpa('Overall Result (GPA)', SHELL_HELP);
  assert.equal(shell.text, '2:1', 'the class as written, never a number');
  assert.equal(shell.cls, 'upper');
  assert.equal(shell.expected, true, 'predicted while studying');
  // The same instructions in the label, or in a help text the box points to.
  assert.equal(gpa(`Overall Result (GPA) ${SHELL_HELP}`).text, '2:1');
  assert.equal(gpa('GPA', SHELL_HELP).text, '2:1', 'the page says another system is fine');
  assert.equal(gpa('GPA', 'If your university does not use GPA, enter your degree classification').text, '2:1');
  assert.equal(gpa('Overall Result (GPA)').text, '2:1', 'as before, with nothing else said');
  // Boxes that want a GPA number never get "2:1" or a converted number.
  assert.equal(gpa('GPA'), null);
  assert.equal(gpa('Cumulative GPA (out of 4.0)'), null);
  assert.equal(gpa('Overall Result (GPA)', 'Enter your GPA on a 0-4.0 scale.'), null, 'only a GPA on that scale');
  assert.equal(gpa('Overall Result (GPA)', SHELL_HELP, { kind: 'number' }), null, 'a number box');
  // Graduated: the class achieved; a GPA you have stays your GPA.
  assert.equal(gpa('Overall Result (GPA)', SHELL_HELP, { today: new Date('2028-01-01') }).expected, false);
  p.education[0].classification = '';
  p.education[0].gpa = '2:1';
  assert.equal(gpa('Overall Result (GPA)', SHELL_HELP).text, '2:1', 'a class kept as the GPA');
  assert.equal(gpa('GPA (out of 4.0)'), null);
  p.education[0].gpa = '3.8/4.0';
  assert.equal(gpa('Overall Result (GPA)', SHELL_HELP).number, 3.8);
  p.education[0].gpa = '';
  assert.equal(gpa('Overall Result (GPA)', SHELL_HELP), null, 'nothing to give');
});

test('a grade your profile holds never goes to the AI; school and subject come from the entry under Shell’s help', () => {
  const p = glasgow();
  const held = (type, question) => fields.gradeHeld(type, p, { index: 0, question: util.normalize(question) });
  assert.equal(held('edu.gpa', 'GPA'), true, 'a GPA box left empty for a UK class stays empty');
  assert.equal(held('edu.gpa', 'Overall Result (GPA)'), true);
  assert.equal(held('edu.classification', 'Degree classification'), true);
  assert.equal(held('edu.gpaScale', 'GPA Scale'), true);
  assert.equal(held('edu.classAtLeast', 'Do you have a 2:1 or above?'), true);
  assert.equal(held('edu.school', 'School or University'), false, 'not a grade');
  const scientist = computingScientist(); // a BSc (gpa "2:1") and Advanced Highers ("AAB")
  const school = (question) => fields.gradeHeld('edu.gpa', scientist, { index: 0, question: util.normalize(question) });
  assert.equal(school('Highers / Advanced Highers results'), true);
  assert.equal(school('Maths GCSE grade'), false, 'GCSEs aren’t in the profile: the AI may find them in the CV');
  p.education[0].classification = '';
  assert.equal(held('edu.gpa', 'GPA'), false, 'no grade at all: the AI may find one in the CV');
  // "School or University" and "Field of Study" under the help text are still the school and the subject.
  const page = [
    desc({ label: 'School or University', section: 'Education 1', sectionHelp: SHELL_HELP }),
    desc({ label: 'Field of Study', section: 'Education 1', sectionHelp: SHELL_HELP }),
  ];
  assert.deepEqual(types(matcher.plan(page, scientist)), ['edu.school#0', 'edu.field#0']);
  assert.deepEqual(fillWithHelp(page, scientist), ['University of Glasgow', 'Computing Science']);
  const subject = fields.resolve('edu.field', scientist, { index: 0, jobContext: true, question: 'field of study' });
  assert.ok(subject.candidates.includes('Computer Science'), 'a list offers "Computer Science" for it');
});

test('your CV’s upload, when it takes several files, also takes your letter and transcript', () => {
  const p = glasgow();
  const also = (label, opt) =>
    fields.uploadAlso(util.normalize(label), Object.assign({ multiple: true, profile: p, separate: new Set() }, opt));
  assert.deepEqual(also('Resume/CV/Transcripts Upload a file (5MB max)'), ['file.coverLetter', 'file.transcript']);
  assert.deepEqual(also('Resume, cover letter and transcripts'), ['file.coverLetter', 'file.transcript']);
  assert.deepEqual(also('CV and cover letter'), ['file.coverLetter']);
  assert.deepEqual(also('Resume/CV'), ['file.coverLetter'], 'no letter upload of its own on the form');
  assert.deepEqual(also('Resume/CV/Transcripts', { separate: new Set(['file.coverLetter']) }), ['file.transcript']);
  assert.deepEqual(also('Resume/CV/Transcripts', { multiple: false }), [], 'one file: just the CV');
  assert.deepEqual(also('Resume / graduate transcript'), ['file.coverLetter'], 'no graduate studies, no transcript');
});

test('a parent’s highest qualification: only an option your answer settles', () => {
  const p = computingScientist();
  const talos = [
    'Primary school or below',
    'Secondary school (High school)',
    'Vocational, technical, or professional certificate',
    "Bachelor's degree (University undergraduate degree)",
    "Master's, doctoral, or professional degree (e.g., PhD, MD, JD)",
    "Don't know",
    'Prefer not to say',
  ];
  const q = 'What is the highest level of education completed by either of your parents or guardians?';
  const pick = (answer, list) => {
    p.eeo.parentsDegree = answer;
    return choose(p, 'eeo.parentsDegree', q, list);
  };
  // "Yes" doesn't say bachelor's or master's; "No" doesn't say which school level (and is never "Don't know").
  assert.equal(pick('Yes', talos), null);
  assert.equal(pick('No', talos), null);
  const orHigher = "Bachelor's degree or higher";
  assert.equal(pick('Yes', ['Below degree level', orHigher, 'Prefer not to say']), orHigher);
  assert.equal(pick('Yes', ['GCSEs or equivalent', 'A-levels or equivalent', "Master's degree or above"]), null);
  assert.equal(pick('No', ['Degree or above', 'Below degree level', 'No formal qualifications']), 'Below degree level');
  assert.equal(pick('No', ['Yes', 'No', "Don't know"]), 'No');
  const atLeastOne = 'Yes, at least one has a bachelor’s degree';
  assert.equal(pick('Yes', [atLeastOne, 'No']), atLeastOne);
});

test('undergraduate, final-year and penultimate-year questions; Netcraft’s results box is not your year', () => {
  const p = computingScientist(); // 4th year of 4 on 3 October 2026
  const yn = ['Yes', 'No'];
  const yes = (label) => {
    const r = matcher.classify(desc({ label }, { kind: 'select', options: opts(...yn) }));
    assert.ok(r, label);
    return choose(p, r.type, label, yn, { today: TODAY });
  };
  assert.equal(yes('Are you currently an undergraduate student?'), 'Yes');
  assert.equal(yes('Are you a postgraduate student?'), 'No');
  assert.equal(yes('Are you a final year student?'), 'Yes');
  assert.equal(yes('Are you a penultimate year student?'), 'No');
  assert.equal(yes('Are you in your first year?'), 'No');
  assert.equal(
    yes("Are you in your penultimate year of your master's or bachelor's degree, and graduating in 2028?"),
    'No',
    'Man Group: a graduation date question',
  );
  p.education[0].degree = 'MSc';
  assert.equal(yes('Are you currently an undergraduate student?'), 'No');
  assert.equal(
    matcher.classify(
      desc("If you are in your first year of studies and yet to receive your results, please type 'N/A'"),
    ),
    null,
  );
});

test('GPA lists and scales for a UK class: never "2:1" where a number or a scale is asked for', () => {
  const p = computingScientist();
  const gpa = (question, ...options) => choose(p, 'edu.gpa', question, options, { today: TODAY });
  assert.equal(gpa('What is your GPA?', '>4.0', '4.0+', '3.7+', '3.5+', '3.2+', '3.0+', '<3.0'), null);
  assert.equal(
    gpa('What is your current cumulative GPA on a 4.0 scale?', '3.7 or Higher', '3.5 - 3.6', '3.0 - 3.4', '2.5 - 2.9'),
    null,
  );
  const scale = (question, ...options) => choose(p, 'edu.gpaScale', question, options, { today: TODAY });
  const fiveRings = 'Please specify the grading scale used by your current school.';
  assert.equal(scale('GPA Scale', '4.0', '5.0', '10', 'UK degree classification'), 'UK degree classification');
  assert.equal(scale(fiveRings, '4.0 Scale', '5.0 Scale', 'UK Grading System', 'Other'), 'UK Grading System');
  assert.equal(scale('GPA Scale', '4.0', '5.0', '10'), null);
  assert.equal(ask(p, 'edu.gpaScale', 'GPA Scale', { kind: 'text' }), null);
  // A GPA out of 4.0 gives its scale.
  p.education[0].gpa = '3.8/4.0';
  assert.equal(scale('GPA Scale', '4.0', '5.0', '10'), '4.0');
  assert.equal(scale(fiveRings, '4.0 Scale', '5.0 Scale'), '4.0 Scale');
});

test('"Do you have a 2:1 or above?" and "Do you expect to graduate with honours?" are answered from your class', () => {
  const p = computingScientist();
  const yn = ['Yes', 'No'];
  const yesNo = (label) => desc({ label }, { kind: 'select', options: opts(...yn) });
  const yes = (label) => {
    const r = matcher.classify(yesNo(label));
    assert.equal(r && r.type, 'edu.classAtLeast', label);
    return choose(p, r.type, label, yn, { today: TODAY });
  };
  const questions = [
    'Do you have a 2:1 or above (or equivalent)?',
    'Are you predicted at least a 2:1?',
    'Have you achieved or are you on track for a First or 2:1?',
    'Minimum 2:1 required — do you meet this?',
    'Do you have a 2:1 or above in a relevant undergraduate or master’s degree?',
  ];
  for (const q of questions) assert.equal(yes(q), 'Yes', q);
  assert.equal(yes('Are you predicted a First?'), 'No');
  assert.equal(yes('Do you expect to graduate with honours?'), 'Yes');
  p.education[0].gpa = '2:2';
  for (const q of questions) assert.equal(yes(q), 'No', q);
  assert.equal(yes('Do you have a 2:2 or above?'), 'Yes');
  p.education[0].gpa = 'Distinction';
  assert.equal(yes('Are you predicted at least a 2:1?'), 'Yes', 'a master’s Distinction');
  p.education[0].gpa = '3.7';
  assert.equal(yes('Do you have a 2:1 or above (or equivalent)?'), null, 'a GPA is never converted');
  assert.equal(matcher.classify(yesNo('Have you completed a first aid course?')), null);
  assert.equal(matcher.classify(yesNo('Are you 21 or older?')), null);
});

test('school short names: UCL, LSE, KCL, UC Berkeley, MIT, NYU, UofG — and never the other Glasgow', () => {
  const p = computingScientist();
  const pick = (school, ...options) => {
    p.education[0].school = school;
    return choose(p, 'edu.school', 'University', options);
  };
  const lse = 'London School of Economics and Political Science';
  const berkeley = 'University of California, Berkeley';
  const mit = 'Massachusetts Institute of Technology';
  assert.equal(pick('UCL', 'King’s College London', 'University College London'), 'University College London');
  assert.equal(pick('University College London', 'UCL', 'KCL', 'LSE'), 'UCL');
  assert.equal(pick('LSE', 'London Business School', lse), lse);
  assert.equal(pick('KCL', 'Imperial College London', "King's College London"), "King's College London");
  assert.equal(pick('Imperial', 'University College London', 'Imperial College London'), 'Imperial College London');
  assert.equal(pick('Oxford', 'Oxford Brookes University', 'University of Oxford'), 'University of Oxford');
  assert.equal(pick('University of Cambridge', 'Anglia Ruskin University', 'Cambridge'), 'Cambridge');
  assert.equal(pick('UC Berkeley', 'Berkeley College', berkeley), berkeley);
  assert.equal(pick(berkeley, 'UCLA', 'UC Berkeley'), 'UC Berkeley');
  assert.equal(pick('MIT', 'Harvard University', mit), mit);
  assert.equal(pick('NYU', 'Columbia University', 'New York University'), 'New York University');
  assert.equal(pick('University of Glasgow', 'Glasgow Caledonian University', 'UofG'), 'UofG');
  assert.equal(pick('University of Glasgow', 'Glasgow Caledonian University', 'GU'), 'GU');
  assert.equal(pick('UofG', 'Glasgow Caledonian University', 'University of Glasgow'), 'University of Glasgow');
  assert.equal(pick('Glasgow', 'Glasgow Caledonian University', 'Glasgow School of Art'), null);
  // "GU" is Glasgow and Georgetown: written in a profile, it picks neither by that name alone.
  assert.equal(pick('GU', 'University of Glasgow', 'Georgetown University'), null);
});

test('"Perth, WA" is Western Australia; "Seattle, WA" is still Washington', () => {
  const { geo } = globalThis.JTF;
  assert.equal(fields.placeCountry('Perth, WA')[0], 'AU');
  assert.equal(fields.placeCountry('Darwin, NT')[0], 'AU');
  assert.equal(fields.placeCountry('Seattle, WA')[0], 'US');
  assert.equal(fields.placeCountry('Spokane, WA')[0], 'US');
  assert.equal(fields.placeCountry('Yellowknife, NT')[0], 'CA');
  assert.deepEqual(geo.countriesIn('Perth, WA'), ['AU']);
  assert.deepEqual(geo.countriesIn('Seattle, WA'), ['US']);
  const p = computingScientist();
  Object.assign(p.address, { city: 'Perth', state: 'WA', country: '' });
  assert.equal(ask(p, 'address.state', 'State').search, 'Western Australia');
  assert.ok(ask(p, 'location', 'Location').candidates.includes('Perth, Western Australia'));
  Object.assign(p.address, { city: 'Seattle' });
  assert.equal(ask(p, 'address.state', 'State').search, 'Washington');
});

test('round-up from the survey: code samples, AI disclosures, ranked lists, relocation, background, city, US states', () => {
  const p = computingScientist();
  Object.assign(p.job, { locations: 'London, Glasgow, Edinburgh' });
  const type = (label, kind, options) => {
    const r = matcher.classify(desc({ label }, { kind: kind || 'text', options: options ? opts(...options) : null }));
    return r && r.type;
  };
  // Not the skills list, not the CV.
  assert.equal(
    type(
      'Please disclose below whether AI tools were used to generate all or a significant portion of the submitted code sample.',
    ),
    null,
  );
  assert.equal(
    type(
      "We have multiple technology teams hiring, and your responses to the following questions will help determine which teams may be the best fit based on your skill set and interests. Please feel free to use this space if there is anything else you'd like to note in terms of your interests that this form does not cover.",
      'textarea',
    ),
    null,
  );
  assert.equal(type('Which tools do you use?'), 'skills', 'a real skills question still is one');
  for (const label of [
    'If you would like to share a file of your code sample, please upload here. You can upload your sample as a .zip file. Please do not submit code samples in pdf or docs files.',
    'Application Requirement: Write a program in C++ that takes in a file as input and reverses every line and puts it in a different file. Try to do this with as little memory footprint as possible and as fast as possible. Attach the file as a .txt below.',
  ])
    assert.equal(type(label, 'file'), null, label);
  assert.equal(type('Please upload your CV and, optionally, a code sample', 'file'), 'file.resume');
  // A text box that names its own places: only the ones you prefer, else nothing.
  const rank =
    'Please rank your location preference in order of most to least preferred: Austin, Chicago, Greenwich, Houston, New York. If you are not open to a location, do not rank it.';
  assert.equal(type(rank, 'textarea'), 'job.locations');
  assert.equal(ask(p, 'job.locations', rank, { kind: 'textarea' }), null);
  p.job.locations = 'London, NYC, Chicago';
  assert.equal(ask(p, 'job.locations', rank, { kind: 'textarea' }).text, 'NYC, Chicago');
  assert.equal(ask(p, 'job.locations', 'Preferred locations', { kind: 'textarea' }).text, 'London, NYC, Chicago');
  // Notion: relocating to the listed offices is a relocation question.
  const notion =
    'This role requires that you are willing to relocate to one of the following locations New York, NY, USA or San Francisco, CA, USA. Please confirm that you are willing to relocate for this role?';
  assert.equal(type(notion, 'radio', ['Yes', 'No']), 'job.relocate');
  // Socio-economic background from the household earner's job; "…a lower socio-economic background?" is No unless
  // that job or free school meals say otherwise.
  const classes = ['Professional', 'Intermediate', 'Working class', 'Prefer not to say'];
  const ynp = ['Yes', 'No', 'Prefer not to say'];
  const lower =
    'Compared to people in general, would you describe yourself as coming from a lower socio-economic background?';
  const which = 'Which socio-economic background do you identify with?';
  assert.equal(type(which, 'select', classes), 'eeo.socioEconomic');
  assert.equal(type(lower, 'select', ynp), 'eeo.socioEconomic');
  assert.equal(choose(p, 'eeo.socioEconomic', which, classes), null, 'blank: never filled');
  assert.equal(choose(p, 'eeo.socioEconomic', lower, ynp), 'No', 'blank: No');
  p.eeo.freeSchoolMeals = 'Yes';
  assert.equal(choose(p, 'eeo.socioEconomic', lower, ynp), 'Yes', 'free school meals');
  p.eeo.freeSchoolMeals = '';
  p.eeo.parentOccupation = 'Manager / administrator';
  assert.equal(choose(p, 'eeo.socioEconomic', which, classes), 'Professional');
  assert.equal(choose(p, 'eeo.socioEconomic', lower, ynp), 'No');
  p.eeo.parentOccupation = 'Routine / semi-routine';
  assert.equal(choose(p, 'eeo.socioEconomic', which, classes), 'Working class');
  assert.equal(choose(p, 'eeo.socioEconomic', lower, ynp), 'Yes');
  p.eeo.parentOccupation = 'Clerical / intermediate';
  assert.equal(choose(p, 'eeo.socioEconomic', which, classes), 'Intermediate');
  assert.equal(choose(p, 'eeo.socioEconomic', lower, ynp), 'No', 'not lower');
  p.eeo.parentOccupation = 'Decline to answer';
  assert.equal(choose(p, 'eeo.socioEconomic', which, classes), 'Prefer not to say');
  assert.equal(choose(p, 'eeo.socioEconomic', lower, ynp), 'Prefer not to say');
  // The city alone where only the city is asked.
  for (const label of ['Current city', 'Which city are you based in?'])
    assert.equal(ask(p, type(label), label, { kind: 'text' }).text, 'Glasgow', label);
  assert.equal(ask(p, 'location', 'Current location', { kind: 'text' }).text, 'Glasgow, Scotland');
  // "State (If N/A, Select Other)" on a US list for someone in Scotland.
  const states = ['AL', 'AK', 'AZ', 'CA', 'NY', 'TX', 'WA', 'Other'];
  const na = 'State (If N/A, Select Other)';
  assert.equal(type(na, 'select', states), 'address.state');
  assert.equal(choose(p, 'address.state', na, states), 'Other');
  assert.equal(choose(p, 'address.state', 'Region', ['Lanarkshire', 'Glasgow City', 'Other']), null);
  p.address.state = '';
  assert.equal(choose(p, 'address.state', na, states), 'Other');
  Object.assign(p.address, { city: 'Austin', state: 'TX', country: 'United States' });
  assert.equal(choose(p, 'address.state', na, states), 'TX');
});

test('other ways to write an answer, for a box that turns the first one down', () => {
  const p = sample();
  p.personal.dob = '1990-12-10';
  p.links.linkedin = 'https://www.linkedin.com/in/ada';
  const ways = (type, d, extra) =>
    matcher.textVariants(
      fields.resolve(type, p, Object.assign({ jobContext: true, index: 0 }, extra)),
      Object.assign({ inputType: 'text', maxLength: 0, placeholderRaw: '', signals: {} }, d),
    );
  const phone = ways('phone');
  assert.equal(phone[0], matcher.formatForText(fields.resolve('phone', p, { jobContext: true }), { signals: {} }));
  for (const d of ['+442079460958', '2079460958', '02079460958', '020 7946 0958'])
    assert.ok(phone.includes(d), `${d} in ${phone.join(' | ')}`);
  assert.ok(
    ways('phone', { maxLength: 10 }).every((s) => s.length <= 10),
    'nothing longer than the box',
  );

  // The page's own order first, ISO right after, then the other order and words.
  const dob = ways('dob', { lang: 'en-GB' });
  assert.deepEqual(dob.slice(0, 4), ['10/12/1990', '10-12-1990', '10.12.1990', '1990-12-10']);
  assert.ok(dob.includes('12/10/1990') && dob.includes('10 December 1990'));
  const us = ways('dob', { lang: 'en-US' });
  assert.deepEqual(us.slice(0, 2), ['12/10/1990', '12-10-1990']);

  const link = ways('links.linkedin');
  assert.deepEqual(link.slice(0, 3), [
    'https://www.linkedin.com/in/ada',
    'www.linkedin.com/in/ada',
    'linkedin.com/in/ada',
  ]);
});

test('other ways to write a postcode and a number', () => {
  const v = (text) => fields.val(text);
  const d = { inputType: 'text', maxLength: 0, placeholderRaw: '', signals: {} };
  assert.deepEqual(matcher.textVariants(v('sw1a1aa'), d), ['sw1a1aa', 'SW1A 1AA', 'SW1A1AA']);
  assert.deepEqual(matcher.textVariants(v('£45,000'), d), ['£45,000', '45000']);
});

test('Ant Design forms: date pickers by their prompts, "Start month" under the role, the phone "prefix"', () => {
  const p = student();
  p.job.startDate = '2027-06-14';
  const plan = (page) => types(matcher.plan(page, p));
  const picker = (signals) =>
    desc(signals, { placeholderRaw: signals.placeholder, lang: 'en-GB', host: 'careers.example.com' });
  // A month-only graduation date in a "Select date" picker (format DD/MM/YYYY, page in en-GB): the 1st of the month.
  const grad = ask(p, 'edu.end', 'Expected graduation date');
  const gradBox = picker({ label: 'Expected graduation date', placeholder: 'Select date' });
  assert.equal(matcher.formatForText(grad, gradBox), '01/06/2027');
  assert.equal(matcher.formatForText(grad, picker({ placeholder: 'End date' })), '01/06/2027');
  assert.equal(matcher.formatForText(grad, desc('Expected graduation date')), '06/2027', 'a plain box: no day made up');
  // A month picker ("Select month") under "The role" is when you could start: the month of the year, as
  // <input type="month"> takes it.
  const month = picker({ label: 'Start month', placeholder: 'Select month', section: 'The role' });
  assert.deepEqual(plan([desc({ label: 'Expected salary', section: 'The role' }), month]), [
    'job.salary',
    'job.startDate',
  ]);
  assert.equal(matcher.formatForText(ask(p, 'job.startDate', 'Start month'), month), '2027-06');
  // Without the picker's prompt "Start month" is just the month; in a job's entry, that job's start.
  assert.deepEqual(plan([desc({ label: 'Start month', section: 'The role' })]), ['job.startDate:month']);
  assert.deepEqual(plan([desc('Job title'), desc('Company'), desc('Start month')])[2], 'exp.start#0:month');
  // The docs' "prefix" Select beside the number under "Phone number" is the dial code, not "Mr / Ms".
  const phone = [
    desc({ id: 'register_prefix', group: 'Phone number' }, { kind: 'combobox' }),
    desc({ id: 'register_phone', group: 'Phone number' }),
  ];
  // The number beside it is the number without its code.
  assert.deepEqual(plan(phone), ['phone.countryCode', 'phone:national']);
  assert.deepEqual(plan([desc('Prefix', { kind: 'select', options: opts('Mr', 'Ms', 'Dr') })]), ['name.prefix']);
});

test('Bain’s diversity questions: Asian "inclusive of" every region, LGBTQ+, first in family, organisations', () => {
  const p = glaswegian();
  const ynp = ['Yes', 'No', 'Prefer not to say'];
  const type = (q, kind, list) => (matcher.classify(desc(q, { kind, options: opts(...list) })) || {}).type;
  const race = [
    'Asian (inclusive of Northeast Asian, Southeast Asian, Southern and Central Asian)',
    'Black (inclusive of the full diaspora across all continents)',
    'Middle Eastern or North African',
    'White',
    'Prefer to self-describe',
    'Prefer not to say',
  ];
  const ethnic = 'To which racial or ethnic group(s) do you most identify? Select all that apply.';
  // An option naming several Asian regions is the whole group, whichever region yours is.
  for (const answer of ['Asian – Chinese', 'Asian – Indian', 'Asian – Filipino', 'Asian'])
    assert.equal(
      choose(Object.assign(p, { eeo: { ...p.eeo, race: answer } }), 'eeo.race', ethnic, race),
      race[0],
      answer,
    );
  // So is the US definition naming the Far East, Southeast Asia and the Indian subcontinent.
  assert.equal(
    fields.parseEthnicity(
      'Asian: A person having origins in any of the original peoples of the Far East, Southeast Asia, or the Indian subcontinent',
    ).region,
    null,
  );
  assert.equal(fields.parseEthnicity('Southeast Asian').region, 'southeast');
  // A mixed answer on a list without a mixed option ticks both groups (a single choice takes neither).
  p.eeo.race = 'Mixed – White and Asian';
  const mixed = ask(p, 'eeo.race', ethnic, { kind: 'checkboxes', options: opts(...race) });
  assert.equal(matcher.matchOption(opts(...race), mixed), -1);
  assert.deepEqual(matcher.matchAll(opts(...race), mixed), [3, 0]);

  // LGBTQ+: from your orientation and gender identity, else No; "Prefer not to say" stays yours.
  const lgbt = 'Do you consider yourself a member of the LGBTQ+ community?';
  assert.equal(type(lgbt, 'radio', ynp), 'eeo.lgbt');
  assert.equal(choose(p, 'eeo.lgbt', lgbt, ynp), 'No', 'blank');
  p.eeo.sexualOrientation = 'Heterosexual / straight';
  assert.equal(choose(p, 'eeo.lgbt', lgbt, ynp), 'No');
  p.eeo.genderIdentitySame = 'No';
  assert.equal(choose(p, 'eeo.lgbt', lgbt, ynp), 'Yes');
  p.eeo.genderIdentitySame = '';
  p.eeo.sexualOrientation = 'Bisexual';
  assert.equal(choose(p, 'eeo.lgbt', lgbt, ynp), 'Yes');
  p.eeo.sexualOrientation = 'Decline to answer';
  assert.equal(choose(p, 'eeo.lgbt', lgbt, ynp), 'Prefer not to say');

  // The first in your family at university: the opposite of a parent's degree, else No.
  const first = 'Are you the first member of your immediate family to attend university?';
  assert.equal(type(first, 'radio', ynp), 'eeo.parentsDegree');
  assert.equal(choose(p, 'eeo.parentsDegree', first, ynp), 'No', 'blank');
  p.eeo.parentsDegree = 'No';
  assert.equal(choose(p, 'eeo.parentsDegree', first, ynp), 'Yes');
  p.eeo.parentsDegree = 'Decline to answer';
  assert.equal(choose(p, 'eeo.parentsDegree', first, ynp), 'Prefer not to say');
  // "Did a parent go to university?" is still left alone when you haven't said.
  p.eeo.parentsDegree = '';
  assert.equal(choose(p, 'eeo.parentsDegree', 'Did either of your parents attend university?', ynp), null);

  // Diversity organisations: those your CV names, else "None of the above", else "Prefer not to say".
  const orgs = 'Have you participated in the following organizations? Select all that apply';
  const list = [
    'AfroTech Conference',
    'Association of Latino Professionals For America (ALPFA)',
    'MLT Career Prep',
    'Out for Undergrad Business Conference (O4U)',
    'Prefer not to say',
  ];
  assert.equal(type(orgs, 'checkboxes', list), 'eeo.organisations');
  const picks = (l) =>
    matcher.matchAll(opts(...l), ask(p, 'eeo.organisations', orgs, { kind: 'checkboxes', options: opts(...l) }));
  const one = (l) =>
    matcher.matchOption(opts(...l), ask(p, 'eeo.organisations', orgs, { kind: 'checkboxes', options: opts(...l) }));
  assert.equal(one(list), 4);
  assert.equal(one([...list.slice(0, 4), 'None of the above', 'Prefer not to say']), 4);
  assert.equal(one(['Yes', 'No']), 1);
  p.experience[0].description = 'MLT Career Prep fellow; ALPFA chapter member.';
  assert.deepEqual(picks(list), [1, 2]);
  assert.equal(type('Have you participated in any of our virtual events?', 'checkboxes', list), undefined);
});

test('Jane Street: when the degree began, full-time start, a second major, interviews, visitor visas, school email', () => {
  const p = glaswegian();
  const yn = ['Yes', 'No'];
  const type = (q, kind = 'radio', list = yn) =>
    (matcher.classify(desc(q, { kind, options: list ? opts(...list) : null })) || {}).type;
  const today = new Date(2026, 9, 4);

  const began = "What year did you begin your undergraduate (e.g. Bachelor's) degree?";
  const years = Array.from({ length: 21 }, (_, i) => String(2006 + i));
  assert.equal(type(began, 'combo', years), 'edu.start');
  assert.equal(
    choose(p, 'edu.start', began, years, { part: 'year' }),
    String(util.parseDate(p.education[0].startDate).year),
  );

  // Full-time work starts once the degree you are on ends, or from your start date when that is later.
  const ft = 'Approximately when do you expect to begin full time employment?';
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September'];
  assert.equal(type(ft, 'select', months), 'job.fullTimeStart');
  p.education[0].endDate = '2027-06';
  p.job.startDate = '2026-11-02';
  assert.equal(choose(p, 'job.fullTimeStart', ft, months, { part: 'month', today }), 'June');
  assert.equal(choose(p, 'job.fullTimeStart', ft, ['2026', '2027', '2028'], { part: 'year', today }), '2027');
  p.job.startDate = '2027-09-01';
  assert.equal(choose(p, 'job.fullTimeStart', ft, months, { part: 'month', today }), 'September');
  p.education[0].endDate = '2020-06';
  p.job.startDate = '2026-11-02';
  assert.equal(choose(p, 'job.fullTimeStart', ft, ['2026', '2027'], { part: 'year', today }), '2026', 'graduated');
  // "When can you start?" is still the start date.
  assert.equal(type('When can you start?', 'text', null), 'job.startDate');

  // A second major is not your first one again.
  const majors = ['Mathematics', 'Physics', 'Other'];
  assert.equal(type('Major / Field of study', 'combo', majors), 'edu.field');
  assert.equal(type('Secondary Major / Field of study', 'combo', majors), undefined);

  // "Have you interviewed with Jane Street before?": No when you never applied; left when you did.
  const interviewed = 'Have you interviewed with Jane Street before?';
  assert.equal(type(interviewed), 'compliance.previouslyApplied');
  p.compliance.previouslyApplied = 'No';
  assert.equal(choose(p, 'compliance.previouslyApplied', interviewed, yn), 'No');
  p.compliance.previouslyApplied = 'Yes';
  assert.equal(choose(p, 'compliance.previouslyApplied', interviewed, yn), null);
  assert.equal(choose(p, 'compliance.previouslyApplied', 'Have you applied to us before?', yn), 'Yes');

  // A visitor visa for the interviews is a visit, not sponsorship: No for a citizen with the right to work there.
  const visa =
    'Do you require a visitor visa to enter the UK for your interviews? Yes: Require a Standard Visitor visa No: May enter with an electronic travel authorisation (ETA) or no visa required';
  assert.equal(type(visa), 'job.visitorVisa');
  assert.equal(choose(p, 'job.visitorVisa', visa, yn), 'No');
  p.personal.nationality = 'Irish';
  assert.equal(choose(p, 'job.visitorVisa', visa, yn), 'No', 'the Common Travel Area');
  for (const nationality of ['French', 'American']) {
    p.personal.nationality = nationality;
    assert.equal(choose(p, 'job.visitorVisa', visa, yn), null, `${nationality}: left for you`);
  }
  p.personal.nationality = 'British';

  // Recruiting timelines are deadlines.
  assert.equal(type('Do you have any recruiting timelines we should be aware of?'), 'job.otherOffers');

  // The school email is never your personal one.
  const school = 'Your primary college/university/school email We may use this email to verify your enrollment.';
  assert.equal(type(school, 'email', null), 'email.school');
  assert.equal(type('Email', 'email', null), 'email');
  p.contact.email = 'ada@example.com';
  p.contact.schoolEmail = '';
  assert.equal(ask(p, 'email.school', school), null);
  p.contact.email = 'ada.lovelace.24@ucl.ac.uk';
  assert.equal(ask(p, 'email.school', school).text, 'ada.lovelace.24@ucl.ac.uk');
  p.contact.schoolEmail = 'a.lovelace@student.gla.ac.uk';
  assert.equal(ask(p, 'email.school', school).text, 'a.lovelace@student.gla.ac.uk');

  // A dial-code picker with no label of its own.
  const codes = ['Canada (+1)', 'Guernsey (+44)', 'Isle of Man (+44)', 'Jersey (+44)', 'United Kingdom (+44)'];
  assert.equal(type('', 'combo', codes), 'phone.countryCode');
  assert.equal(type('Phone', 'combo', codes), 'phone.countryCode');
});

test('Phenom (Marsh): Workday’s degree and subject lists, a spring week’s dates, "How did you hear" for Trackr', () => {
  const { DEGREES, FIELDS, SOURCES } = require('../fixtures/src/phenom-data.mjs');
  const p = computingScientist();
  const list = (rows) => rows.map(([text, value]) => ({ text, value }));
  const pick = (type, question, rows, index) => {
    const options = list(rows);
    const v = ask(p, type, question, { kind: 'select', options, index });
    const i = v ? matcher.matchOption(options, v) : -1;
    return i < 0 ? null : options[i].text;
  };
  assert.equal(pick('edu.degree', 'Degree', DEGREES, 0), 'Bachelor of Science');
  // "Computer and Information Science" (there is no "Computer Science"), never the catch-all "Science" beside it.
  assert.equal(pick('edu.field', 'Field of study', FIELDS, 0), 'Computer and Information Science');
  // The school entry: "High School Graduate", never "Baccalaureat" (the French one) for Advanced Highers.
  assert.equal(pick('edu.degree', 'Degree', DEGREES, 1), 'High School Graduate');
  const school = (degree, ...options) => {
    p.education[1].degree = degree;
    return pick(
      'edu.degree',
      'Degree',
      options.map((o) => [o, o]),
      1,
    );
  };
  assert.equal(school('A-levels', 'GED', 'GCSE', 'High School Diploma', 'Bachelor of Arts'), 'High School Diploma');
  assert.equal(school('A-levels', 'International Baccalaureate', 'A-Levels', 'High School'), 'A-Levels');
  assert.equal(school('Baccalauréat', 'Baccalaureat', 'High School Graduate'), 'Baccalaureat');
  assert.equal(school('IB Diploma', 'Baccalaureat', 'International Baccalaureate'), 'International Baccalaureate');

  // A job site the list doesn't name is left for you: "Referral- Client/Vendor/Other" is a referral, not "Other".
  p.job.referralSource = 'Trackr';
  assert.equal(
    pick(
      'job.referralSource',
      'How did you hear about us?',
      SOURCES.map((s) => [s, s]),
    ),
    null,
  );
  p.job.referralSource = '';
  assert.equal(
    pick(
      'job.referralSource',
      'How did you hear about us?',
      SOURCES.map((s) => [s, s]),
    ),
    'LinkedIn',
  );

  // A spring week (March to March) ends the month after: forms turn down a "To" that isn't after "From".
  p.experience = [
    Object.assign(fields.blankExperience(), {
      company: 'Barclays',
      title: 'Technology Developer Spring Week',
      startDate: '2026-03',
      endDate: '2026-03',
    }),
    Object.assign(fields.blankExperience(), {
      company: 'Glasgow Uni Esports',
      startDate: '2025-12',
      endDate: '2025-12',
    }),
    Object.assign(fields.blankExperience(), { company: 'Tesco', startDate: '2024-06', endDate: '2024-09' }),
  ];
  const end = (index, part) => {
    const v = ask(p, 'exp.end', 'To', { index, part });
    return part ? v.text : matcher.formatForText(v, desc({ label: 'To', placeholder: 'MM/YYYY' }));
  };
  assert.equal(end(0), '04/2026');
  assert.equal(end(0, 'month'), '4');
  assert.equal(end(1), '01/2026', 'December ends in January');
  assert.equal(end(2), '09/2024', 'a longer stint keeps its end');
  assert.equal(ask(p, 'exp.start', 'From', { index: 0 }).text, '2026-03');
});

test('an upload that only says how to upload takes its meaning from the text before it (Phenom’s attachments)', () => {
  const file = (signals) => {
    const r = matcher.classify(desc(signals, { kind: 'file', inputType: 'file' }));
    return r ? r.type : null;
  };
  const how = { label: 'Select file', question: 'Upload either DOC, DOCX, RTF, PDF, or TXT file types (1MB max)' };
  assert.equal(
    file({
      ...how,
      nearby: 'An optional cover letter (or any other documents relevant to your application) can be uploaded here.',
    }),
    'file.coverLetter',
  );
  assert.equal(file({ ...how, nearby: 'Additional documents' }), null, 'other documents are never the CV’s');
  assert.equal(file(how), 'file.resume', 'nothing said: the CV, as before');
});

test('Phenom (Marsh): its questionnaire after the entries — local-scale GPA, N/A for no Master’s, fluency, interviews', () => {
  const p = computingScientist(); // a 2:1, and Advanced Highers at school
  p.languages = 'English, French';
  p.job.adjustments = 'No';
  const area = (question) => desc({ label: question }, { kind: 'textarea', inputType: 'textarea' });
  const page = [
    desc('School or University'),
    desc('School or University'),
    desc({ label: 'Select file', nearby: 'Please upload a copy of your cover letter.' }, { kind: 'file' }),
    desc(
      'What year will you / did you graduate from your most recent study? Please use the following format: MM/YYYY (e.g. 09/2025)',
      { inputType: 'date' },
    ),
    area('What is your cumulative undergraduate (Bachelor) GPA on the scale used by your local school/university?'),
    area(
      'What is your cumulative graduate (Master) GPA on the scale used by your local school/university?  Please indicate N/A if you do not have a graduate GPA.',
    ),
    desc(
      { label: 'Please list any languages in which you have native or business level fluency.' },
      { kind: 'checkboxes', options: opts('Danish', 'English', 'French', 'German', 'Other') },
    ),
    area('Do you require any special requirements if you are invited to attend an interview?'),
  ];
  const filled = fillPage(page, p);
  assert.deepEqual(filled.slice(0, 2), ['University of Glasgow', 'Hillhead High School']);
  assert.equal(matcher.plan(page, p).results[2].type, 'file.coverLetter');
  // Your degree's date, not the school entry's above: a question of its own after the entries is your first entry's.
  assert.equal(filled[3], '2027-06-01');
  assert.match(filled[4], /^2:1\b/, 'the class on your own scale, never a GPA made up from it');
  assert.equal(filled[5], 'N/A', 'no Master’s');
  assert.deepEqual(matcher.plan(page, p).results[6].type, 'languages');
  assert.equal(filled[7], 'No');
  // What the GPA scale is (a list) stays a question about the scale.
  assert.equal(matcher.classify(desc('What GPA scale is used by your university?')).type, 'edu.gpaScale');
  assert.equal(matcher.classify(area('Please state any reasonable adjustments you require')), null, 'what they are');
});

test('live survey (niche forms): referrer boxes that ask for N/A, "applied before? If yes…" boxes, connections', () => {
  const p = computingScientist();
  p.job.referralSource = 'Trackr';
  p.job.otherOffers = 'No';
  Object.assign(p.compliance, { previouslyApplied: 'No', relatives: 'No' });
  const text = (question) => {
    const r = matcher.classify(desc(question));
    const v = r && ask(p, r.type, question, { kind: 'text' });
    return v ? v.text : null;
  };
  assert.equal(
    text('Please provide the name and team of your referrer. if you haven’t been referred please state n/a'),
    'N/A',
  );
  assert.equal(
    text('If you were referred by a Graham Capital employee, please enter their name. If not, write N/A.'),
    'N/A',
  );
  assert.equal(text('Referrer’s name'), null, 'no word to give for "not referred"');
  p.job.referralSource = 'Employee referral';
  assert.equal(text('If you were referred by an employee, please enter their name. If not, write N/A.'), null, 'yours');
  assert.equal(
    text('Have you ever applied for Graham employment before? If yes, please list dates and position.'),
    'No',
  );
  assert.equal(matcher.classify(desc('If yes, when did you apply?')), null, 'its follow-up');
  assert.equal(text('Other Processes/Offers/Timelines'), 'No');
  const connected = opts(
    'Work - Former Co-Worker',
    'School/University',
    'Friend',
    'Other (please specify)',
    'Not Applicable',
  );
  const q = 'Are you connected to any current employees of Rothesay? If yes, please confirm how you are connected.';
  const v = ask(p, matcher.classify(desc(q, { kind: 'select', options: connected })).type, q, { kind: 'select' });
  assert.equal(connected[matcher.matchOption(connected, v)].text, 'Not Applicable');
});

test('niche-form dry runs: uploads that name nothing never get the CV a second time; CV readers are no uploads', () => {
  const p = computingScientist();
  const file = (signals) => desc(signals, { kind: 'file', inputType: 'file' });
  const page = [
    file({ label: 'Cover letter', aria: 'Upload Cover letter', id: 'doc-input-cover-letter' }),
    file({ label: 'CV', aria: 'Upload CV', id: 'doc-input-cv' }),
    file({ label: 'Employment reference ( Optional )', aria: 'Upload Employment reference' }),
    file({ label: 'Other ( Optional )', aria: 'Upload Other' }),
    file({ label: 'Attach', id: 'additional_upload' }),
  ];
  assert.deepEqual(
    matcher.plan(page, p).results.map((r) => r && r.type),
    ['file.coverLetter', 'file.resume', null, null, null],
  );
  // Dayforce's CV box says "Attachment", its id "…_files_resume": still the CV's.
  const dayforce = [file({ label: 'Attachment', id: 'jobPostingApplication_files_resume' }), file({ label: 'Resume' })];
  assert.deepEqual(
    matcher.plan(dayforce, p).results.map((r) => r && r.type),
    ['file.resume', 'file.resume'],
  );
  // CharlieHR's "AUTOFILL FOR SPEED, save time by uploading your cv" box (named "user_cv") reads the CV into the form.
  const charlie = file({
    label: 'From Device',
    name: 'user_cv',
    nearby: 'AUTOFILL FOR SPEED save time by uploading your cv',
  });
  assert.equal(matcher.classify(charlie), null);
  assert.equal(
    matcher.classify(file({ label: 'from Device', name: 'user_cv', nearby: 'Upload CV *' })).type,
    'file.resume',
  );
});

test('niche-form dry runs: statements by country, a requirement said back, US clearances and US persons, religion', () => {
  const p = computingScientist(); // British
  // DN Capital: the UK statement (whatever its brackets say), never Germany's.
  const where = [
    'I have the right to work in the UK (post-Brexit does not apply automatically for EU-citizens)',
    'I have the right to work in Germany',
    'Neither - I require support with getting the visa (we can help but your preferred start date might need to be 6 months out)',
  ];
  const q = 'Where do you have the right to work? (Select all that apply)';
  const v = ask(p, 'job.authorized', q, { kind: 'checkboxes', options: opts(...where) });
  assert.deepEqual(matcher.matchAll(opts(...where), v), [0]);
  p.personal.nationality = 'Indian';
  p.job.workCountries = 'India';
  assert.deepEqual(
    matcher.matchAll(opts(...where), ask(p, 'job.authorized', q, { kind: 'checkboxes', options: opts(...where) })),
    [2],
  );
  p.personal.nationality = 'British';
  p.job.workCountries = '';
  // Capgemini: eligible for clearance is the statement that meets the requirement, not the one that fails it.
  p.job.clearanceEligible = 'Yes';
  const lived = [
    'I have lived in the UK for the last 5 years and have not spent more than 6 months (consecutively or in total) outside of the UK',
    'I have lived in the UK for the last 5 years but have spent more than 6 months (consecutively or in total) outside of the UK.',
    'I have not lived in the UK for the last 5 years but have not spent more than 6 months (consecutively or in total) outside of the UK.',
    'I have not lived in the UK for the last 5 years and have spent more than 6 months (consecutively or in total) outside of the UK.',
  ];
  const sc =
    'Security Clearance Eligibility Some of our roles require security clearance. To meet the eligibility requirements, you must have lived in the UK for the last 5 years and not have spent more than 6 months (either consecutively or in total) outside of the UK during that period.';
  assert.equal(choose(p, 'job.clearanceEligible', sc, lived), lived[0]);
  // A US clearance needs US citizenship; eligible is never "I hold an active one".
  const us =
    'Clearance Eligibility - Do you presently hold an active U.S. security clearance, or are you eligible to obtain one?';
  const usOptions = ['Yes, I hold an active U.S. security clearance', 'Yes, I’m eligible to obtain one', 'No'];
  assert.equal(choose(p, 'job.clearanceEligible', us, usOptions), 'No');
  assert.equal(
    choose(p, 'job.clearanceEligible', 'Are you eligible for SC clearance?', usOptions),
    'Yes, I’m eligible to obtain one',
  );
  // "…subject to U.S. export controls": which kind of US person, from your nationality.
  const persons = [
    'A person lawfully admitted for permanent residence of the United States (i.e. Green Card holder)',
    'A person admitted as a refugee to the United States under 8 U.S.C. 1157',
    'A United States citizen or national',
    'None of the above',
  ];
  const exportQ =
    'This position requires access to information and technology that is subject to U.S. export controls. Your responses to the questions below will be used solely to determine your eligibility';
  assert.equal(
    matcher.classify(desc({ question: exportQ }, { kind: 'radio', options: opts(...persons) })).type,
    'nationality',
  );
  assert.equal(choose(p, 'nationality', exportQ, persons, { kind: 'radio' }), 'None of the above');
  p.personal.nationality = 'American';
  assert.equal(choose(p, 'nationality', exportQ, persons, { kind: 'radio' }), 'A United States citizen or national');
  // "No religion or belief" is "Non Religious", never "Not Specified".
  p.eeo.religion = 'No religion or belief';
  assert.equal(
    choose(p, 'eeo.religion', 'Religion', ['Atheism', 'Christianity', 'Non Religious', 'Not Specified']),
    'Non Religious',
  );
  assert.equal(choose(p, 'eeo.religion', 'Religion', ['Christianity', 'Not Specified', 'Other']), null);
});

test('niche-form dry runs: "How did you hear?" — no rival site, examples in brackets, "Which One?", "Please specify"', () => {
  const p = computingScientist();
  p.job.referralSource = 'Trackr';
  const hear = (...o) => choose(p, 'job.referralSource', 'How did you hear about us?', o);
  // Chicago Trading Co: another site's own posting is never Trackr's.
  assert.equal(hear('LinkedIn Job Posting', 'Handshake Job Posting', 'Company Website', 'Other'), 'Other');
  // Aurora: an example in brackets names no site.
  assert.equal(
    hear('LinkedIn', 'Other Job Board (e.g. University Job Board, etc.)', 'Friend', 'Other'),
    'Other Job Board (e.g. University Job Board, etc.)',
  );
  assert.equal(hear('LinkedIn', 'Job Board (Indeed, LinkedIn, etc.)', 'Other'), 'Job Board (Indeed, LinkedIn, etc.)');
  p.job.referralSource = 'Bright Network';
  assert.equal(hear('LinkedIn', 'Bright Network Job Posting', 'Other'), 'Bright Network Job Posting');
  p.job.referralSource = 'Trackr';
  // The follow-ups: "Please specify" (where you heard, once "Other" is chosen), "Which One?" the same question.
  const page = [
    desc({ label: 'How did you hear about us?' }, { kind: 'select', options: opts('LinkedIn', 'Job Board', 'Other') }),
    desc('Please specify'),
    desc({ label: 'Which One?' }, { kind: 'select', options: opts('Google for Jobs', 'Indeed', 'Milkround', 'Other') }),
    desc("If you selected 'A friend or relative', please put their full name below."),
  ];
  const { results } = matcher.plan(page, p);
  assert.deepEqual(
    results.map((r) => r && r.type && r.type + (r.part ? ':' + r.part : '')),
    ['job.referralSource', 'job.referralSource:specify', 'job.referralSource', null],
  );
  assert.equal(results[1].follows, 0);
  assert.equal(ask(p, 'job.referralSource', 'Please specify', { part: 'specify' }).text, 'Trackr');
  assert.deepEqual(fillPage(page, p).slice(0, 3), ['Job Board', 'Trackr', 'Other']);
});
