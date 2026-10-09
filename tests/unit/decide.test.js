'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, desc, opts } = require('./helpers');

const { fields, decide } = load();

/** A UCL economics student with a CV, as the survey applicant. */
function student() {
  const p = fields.createProfile('Test');
  Object.assign(p.personal, { firstName: 'Alex', lastName: 'Morgan', nationality: 'British' });
  Object.assign(p.contact, { email: 'alex@example.com', phoneCountryCode: '+44', phone: '7700 900123' });
  Object.assign(p.address, {
    line1: '12 Gower Street',
    city: 'London',
    postalCode: 'WC1E 6BT',
    country: 'United Kingdom',
  });
  Object.assign(p.job, { authorized: 'Yes', sponsorship: 'No', startDate: '2027-06-28', referralSource: 'Trackr' });
  p.education = [
    {
      school: 'University College London',
      degree: 'BSc',
      field: 'Economics',
      gpa: '2:1',
      location: 'London, UK',
      startDate: '2024-09',
      endDate: '2027-06',
    },
  ];
  return p;
}

const radios = (q, ...options) => desc({ question: q }, { kind: 'radio', options: opts(...options) });
const DOCS = { 'file.resume': true };

test('page: what a fill puts in each field, which option, and what it leaves', () => {
  const page = decide.page(
    [
      desc('First Name'),
      desc('Email', { kind: 'email', inputType: 'email' }),
      radios('Do you require sponsorship to work in the UK?', 'Yes', 'No'),
      desc({ label: 'University' }, { kind: 'select', options: opts('Select…', 'King’s College London', 'UCL') }),
      desc({ label: 'Resume' }, { kind: 'file' }),
      desc({ label: 'Cover letter' }, { kind: 'file' }),
      desc('Salary expectations'),
      desc('Why do you want to join us?', { kind: 'textarea' }),
      desc({ label: 'I agree to receive marketing emails' }, { kind: 'checkbox', options: opts('I agree') }),
    ],
    student(),
    { docs: DOCS },
  );
  const brief = page.map((e) => [e.type, e.action, e.text || '', !!e.ai]);
  assert.deepEqual(brief, [
    ['name.first', 'fill', 'Alex', false],
    ['email', 'fill', 'alex@example.com', false],
    ['job.sponsorship', 'fill', 'No', false],
    ['edu.school', 'fill', 'UCL', false],
    ['file.resume', 'upload', 'file.resume', false],
    ['file.coverLetter', 'missing', '', false],
    ['job.salary', 'missing', '', false],
    [null, 'none', '', true],
    ['optIn', 'leave', '', false],
  ]);
  assert.deepEqual(page[2].picked, [1]);
});

test('page: a list none of whose options is yours goes to the AI with the rules’ guess', () => {
  const [e] = decide.page(
    [radios('Preferred office location', 'Paris', 'Madrid')],
    Object.assign(student(), { job: Object.assign(student().job, { locations: 'London' }) }),
  );
  assert.equal(e.action, 'nomatch');
  assert.equal(e.ai, true);
  assert.equal(e.guess, 'London');
});

test('field: "…or write N/A" is N/A until its list is on "Other", then yours to write', () => {
  const p = student();
  const na = { type: 'na', part: null };
  const box = desc('If you selected ‘Other’, please specify or write N/A');
  assert.equal(decide.field(box, na, p, {}, { followed: 'Economics' }).action, 'fill');
  assert.equal(decide.field(box, na, p, {}, { followed: 'Other' }).action, 'skip');
  assert.equal(decide.field(box, na, p, {}, { followed: '' }).action, 'skip');
});

test('field: acknowledgements are left unless they may be ticked; what the profile lacks is missing', () => {
  const p = student();
  const terms = desc({ label: 'I agree to the privacy policy' }, { kind: 'checkbox', options: opts('I agree') });
  assert.equal(decide.field(terms, { type: 'consent' }, p, {}).action, 'consent');
  assert.equal(decide.field(terms, { type: 'consent' }, p, {}, { ctx: { consents: true } }).action, 'fill');
  const salary = decide.field(desc('Salary expectations'), { type: 'job.salary' }, p, {});
  assert.deepEqual([salary.action, salary.unresolved], ['missing', true]);
});

test('picks: a checklist takes each of a list, a lone checkbox a yes, a select its one match', () => {
  const offices = desc({ question: 'Offices' }, { kind: 'checkboxes', options: opts('London', 'Paris', 'New York') });
  assert.deepEqual(decide.picks(offices, fields.val('London, New York')), [0]);
  assert.deepEqual(
    decide.picks(offices, { text: 'London, New York', kind: 'list', items: ['London', 'New York'] }),
    [0, 2],
  );
  const box = desc({ label: 'I am over 18' }, { kind: 'checkbox', options: opts('I am over 18') });
  assert.deepEqual(decide.picks(box, { text: 'Yes', canonical: 'yes' }), [0]);
  assert.deepEqual(decide.picks(box, { text: 'No', canonical: 'no' }), []);
  assert.equal(decide.picks(desc('First name'), fields.val('Alex')), null);
});

test('forAi: never contact details, diversity answers or what is left empty on purpose', () => {
  const p = student();
  assert.equal(decide.forAi(desc('Email', { kind: 'email' }), null, p, {}), null);
  assert.equal(decide.forAi(radios('Gender', 'Male', 'Female'), { type: 'eeo.gender' }, p, {}), null);
  assert.deepEqual(decide.forAi(desc('Why us?', { kind: 'textarea' }), null, p, {}), { guess: null });
  // "If other, please specify" after a diversity question belongs to it.
  assert.equal(decide.forAi(desc('If other, please specify'), null, p, {}, 'eeo.race'), null);
});
