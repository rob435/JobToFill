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

test('hidesAnswer: the field before a question for the AI never passes on a private answer or a secret', () => {
  for (const type of [
    'dob',
    'age',
    'pronouns',
    'name.prefix',
    'job.adjustments',
    'eeo.gender',
    'eeo.race',
    'account.password',
    'account.username',
    'cc.number',
    'cc.cvc',
    'otp',
  ]) {
    assert.equal(decide.hidesAnswer(type), true, type);
    // A diversity answer passes once the AI answers those itself (it has them in its own block); nothing else does.
    const ALL = { eeo: true, consent: true, legal: true, health: true, identity: true };
    assert.equal(decide.hidesAnswer(type, ALL), !/^eeo\./.test(type), `${type}, everything allowed`);
  }
  for (const type of [null, undefined, '', 'job.otherOffers', 'compliance.relatives', 'edu.school', 'custom'])
    assert.equal(decide.hidesAnswer(type), false, String(type));
});

test('forAi: what the rules leave empty goes to the AI for the kinds the candidate allows, and only those', () => {
  const p = student();
  const ALL = { eeo: true, consent: true, legal: true, health: true, identity: true };
  const NONE = { eeo: false, consent: false, legal: false, health: false, identity: false };
  const ai = (d, type, allow, extra = {}) =>
    decide.forAi(d, type ? { type, ...extra } : null, p, {}, extra.prev || null, null, allow);
  const gender = radios('Gender', 'Woman', 'Man', 'Prefer not to say');
  // A diversity answer left on "— don't fill —", one no option matches, Menzies' income-support question.
  assert.equal(ai(gender, 'eeo.gender', NONE), null);
  assert.equal(ai(gender, 'eeo.gender', undefined), null);
  assert.equal(ai(gender, 'eeo.gender', { ...ALL, eeo: false }), null);
  assert.deepEqual(ai(gender, 'eeo.gender', { eeo: true }), { guess: null });
  p.eeo.gender = 'Female';
  assert.deepEqual(ai(gender, 'eeo.gender', { eeo: true }), { guess: { type: 'eeo.gender', value: 'Female' } });
  const support = radios('Did your household receive income support during your school years?', 'Yes', 'No');
  assert.equal(ai(support, 'eeo.incomeSupport', NONE), null);
  assert.deepEqual(ai(support, 'eeo.incomeSupport', { eeo: true }), { guess: null });
  // Northern Ireland's community background, the rules' to leave whatever the job: the AI's to decline once allowed.
  const community = radios('Community background', 'Protestant community', 'Roman Catholic community', 'Neither');
  assert.equal(ai(community, 'eeo.community', NONE), null);
  assert.deepEqual(ai(community, 'eeo.community', { eeo: true }), { guess: null });
  // "If other, please specify" after a diversity question, once those are the AI's too.
  const specify = desc('If other, please specify');
  assert.equal(ai(specify, null, NONE, { prev: 'eeo.race' }), null);
  assert.deepEqual(ai(specify, null, { eeo: true }, { prev: 'eeo.race' }), { guess: null });
  assert.equal(ai(specify, null, ALL, { prev: 'cc.number' }), null, 'never after a card');
  // Sanctions statements the profile can't settle, without the rules' "It depends".
  const sanctions = radios('Are you a citizen or resident of Cuba, Iran, North Korea or Syria?', 'Yes', 'No');
  assert.equal(ai(sanctions, 'compliance.sanctions', NONE), null);
  assert.deepEqual(ai(sanctions, 'compliance.sanctions', { legal: true }), { guess: null });
  // A government-official question the profile leaves empty goes either way: legal allowed only changes the answer.
  const official = radios('Are you a current or former government official?', 'Yes', 'No');
  assert.deepEqual(ai(official, 'compliance.government', NONE), { guess: null });
  assert.deepEqual(ai(official, 'compliance.government', { legal: true }), { guess: null });
  // A date of birth in one box, never its day, month or year boxes apart.
  const dob = desc('Date of birth', { kind: 'date' });
  assert.equal(ai(dob, 'dob', NONE), null);
  assert.deepEqual(ai(dob, 'dob', { identity: true }), { guess: null });
  assert.equal(ai(desc('Day'), 'dob', { identity: true }, { part: 'day' }), null);
  // Never, whatever is allowed: acknowledgements (the rules' setting), opt-ins, referees, fax numbers, the page's own
  // search box, other people's email, secrets, uploads, passwords, the CAPTCHA.
  const box = (q) => desc({ label: q }, { kind: 'checkbox', options: opts(q) });
  for (const [d, type] of [
    [box('I have read the privacy notice'), 'consent'],
    [box('Keep me updated about future opportunities'), 'optIn'],
    [desc('Referee name'), 'referee'],
    [desc('Fax'), 'contact.other'],
    [desc('Search jobs'), 'page'],
    [desc('Referrer email', { kind: 'email' }), 'email'],
    [desc('Card number'), 'cc.number'],
    [desc('Password', { kind: 'password' }), 'account.password'],
    [desc('CV', { kind: 'file' }), 'file.resume'],
    [box('I am not a robot'), 'human'],
  ])
    assert.equal(ai(d, type, ALL), null, type);
});
