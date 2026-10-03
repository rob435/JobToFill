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
  assert.equal(fields.resolve('account.password', p, ctx()), null, 'no secrets without the vault');
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
    null,
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
    'edu.gpa#0',
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
  assert.equal(type('Are you able to commute into our London office?'), null);
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
