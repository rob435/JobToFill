'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, desc, opts } = require('./helpers');

const { matcher, fields } = load();

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
  assert.equal(fields.resolve('name.preferred', p).text, 'Ada', 'falls back to first name');
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
