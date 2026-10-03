'use strict';
// Sanctions and export-control declarations, "How did you hear about us?", interview availability, contact
// preferences and "Otherwise, enter N/A" follow-ups: classification, values from the profile and option matching.
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, desc, opts } = require('./helpers');

const { matcher, fields, util } = load();

const TODAY = new Date(2026, 9, 3); // Saturday 3 October 2026
const typeOf = (q, kind = 'select', o = ['Yes', 'No']) =>
  (matcher.classify(desc(q, { kind, options: o ? opts(...o) : null })) || {}).type || null;

function british() {
  const p = fields.createProfile('Student');
  Object.assign(p.personal, { firstName: 'Ada', lastName: 'Lovelace', nationality: 'British' });
  Object.assign(p.address, { city: 'Glasgow', state: '', country: 'United Kingdom' });
  Object.assign(p.job, { authorized: 'Yes', sponsorship: 'No', relocate: '' });
  return p;
}
const ask = (p, type, question, extra) =>
  fields.resolve(
    type,
    p,
    Object.assign({ jobContext: true, index: 0, question: util.normalize(question), today: TODAY }, extra),
  );
/** The option texts a value picks: every one for a checklist or multi-select (`all`), else the one. */
const picks = (o, v, all) =>
  (all ? matcher.matchAll(o, v) : [matcher.matchOption(o, v)]).filter((i) => i >= 0).map((i) => o[i].text);

/* ------------------------------------------------------------------ sanctions */

// Databricks' Greenhouse form (boards-api.greenhouse.io/v1/boards/databricks/jobs/8133715002?questions=true).
const SANCTIONS_Q =
  'Please confirm whether any of the below applies to you.  Select all that apply.\n\nNote: This information will only be used to ensure compliance with U.S. sanctions and export controls.';
const SANCTIONS = opts(
  'Citizen or permanent resident of Cuba, Iran, North Korea, or Syria',
  'Ordinarily a resident of Cuba, Iran, North Korea, Syria or the Crimea, Donetsk, Luhansk, Zaporizhzhia, or Kherson regions of Ukraine',
  'Ordinarily a resident of Russia or Belarus and not willing to relocate for a Databricks role',
  'None of the above',
);
const FOLLOW_UP_Q =
  'If you selected a response to the prior question other than “none of the above,” please confirm whether any of the following also applies to you.  Select all that apply.';
const FOLLOW_UP = opts(
  'U.S. citizen',
  'U.S. non-citizen national',
  'U.S. permanent resident (Green Card holder)',
  'Individual granted asylum in the U.S.',
  'Individual granted refugee status in the U.S.',
  'Individual granted citizenship in a country other than Cuba, Iran, North Korea, or Syria',
  'Individual granted permanent residency in a country other than Cuba, Iran, North Korea, or Syria',
  'None of these apply to me',
  'Not applicable (i.e., I selected “none of the above” for the prior question)',
);
const YES_NO_SHAPES = [
  'Are you a citizen or resident of Cuba, Iran, North Korea, Syria, or the Crimea region of Ukraine?',
  'Are you located in or ordinarily resident in a comprehensively sanctioned country or region?',
  'Are you a national of any country subject to US embargo (E:1/E:2 countries)?',
];

test('sanctions: every shape of the question is recognised, never as nationality, citizenship or refugee', () => {
  assert.equal(typeOf(SANCTIONS_Q, 'combobox', null), 'compliance.sanctions', 'react-select multi, options unseen');
  assert.equal(
    typeOf(
      SANCTIONS_Q,
      'checkboxes',
      SANCTIONS.map((o) => o.text),
    ),
    'compliance.sanctions',
  );
  // The follow-up, by its options (a checklist) or by following the question (a closed dropdown, see plan below).
  assert.equal(
    typeOf(
      FOLLOW_UP_Q,
      'checkboxes',
      FOLLOW_UP.map((o) => o.text),
    ),
    'compliance.sanctions',
  );
  for (const q of YES_NO_SHAPES) {
    assert.equal(typeOf(q), 'compliance.sanctions', q);
    assert.equal(typeOf(q, 'radio'), 'compliance.sanctions', q);
  }
  assert.equal(
    typeOf('Are you a resident or citizen of any of the following countries/regions: Cuba, Iran, North Korea, Syria?'),
    'compliance.sanctions',
  );
  // One statement of a list of separately named boxes.
  assert.equal(
    typeOf('Citizen or permanent resident of Cuba, Iran, North Korea, or Syria', 'checkbox', ['x']),
    'compliance.sanctions',
  );
  const lone = desc(
    { label: SANCTIONS[0].text, question: SANCTIONS_Q },
    { kind: 'checkbox', options: opts(SANCTIONS[0].text) },
  );
  assert.equal(matcher.classify(lone).type, 'compliance.sanctions');

  // What it must leave alone.
  assert.equal(typeOf('Are you a US citizen?'), 'citizen');
  assert.equal(typeOf('Nationality', 'select', ['British', 'Cuban', 'Iranian', 'Syrian']), 'nationality');
  assert.equal(
    typeOf('Country', 'select', ['Cuba', 'Iran', 'North Korea', 'Syria', 'United Kingdom']),
    'address.country',
  );
  assert.equal(typeOf('Are you a refugee or asylum seeker?'), 'eeo.refugee');
  assert.equal(typeOf('Have you ever been subject to any regulatory sanctions or disciplinary action?'), null);
  assert.equal(
    typeOf('Do you consent to sanctions and background screening of your country of residence?'),
    'consent',
    'an acknowledgement, not a declaration',
  );
  assert.equal(
    typeOf('Are you legally authorized to work in the country in which you are applying?'),
    'job.authorized',
  );
});

test('sanctions: a British student gets "None of the above", then the follow-up’s "Not applicable"', () => {
  const p = british();
  assert.deepEqual(picks(SANCTIONS, ask(p, 'compliance.sanctions', SANCTIONS_Q, { kind: 'combobox' }), true), [
    'None of the above',
  ]);
  assert.deepEqual(picks(FOLLOW_UP, ask(p, 'compliance.sanctions', FOLLOW_UP_Q, { kind: 'combobox' }), true), [
    FOLLOW_UP[8].text,
  ]);
  for (const q of YES_NO_SHAPES)
    assert.deepEqual(picks(opts('Yes', 'No'), ask(p, 'compliance.sanctions', q)), ['No'], q);
  // Yes/No options worded as statements.
  const worded = opts(
    'Yes, I am a citizen or resident of one of these countries',
    'No, I am not a citizen or resident of any of these countries',
  );
  assert.deepEqual(picks(worded, ask(p, 'compliance.sanctions', YES_NO_SHAPES[0])), [worded[1].text]);
  // A checklist of separately named boxes: "None of the above" ticked, each statement left alone.
  const v = ask(p, 'compliance.sanctions', SANCTIONS_Q, { kind: 'checkbox' });
  assert.deepEqual(picks(opts('None of the above'), v, true), ['None of the above']);
  assert.deepEqual(picks(opts(SANCTIONS[0].text), v, true), []);
});

test('sanctions: what is true of you is ticked; what your profile can’t tell is left for you', () => {
  const p = british();
  const primary = () => picks(SANCTIONS, ask(p, 'compliance.sanctions', SANCTIONS_Q, { kind: 'checkboxes' }), true);
  const follow = () => picks(FOLLOW_UP, ask(p, 'compliance.sanctions', FOLLOW_UP_Q, { kind: 'checkboxes' }), true);
  const yesNo = (q) => picks(opts('Yes', 'No'), ask(p, 'compliance.sanctions', q))[0] || null;

  // A dual national: the citizenship statement, and the follow-up is yours (residency and asylum aren't known).
  p.personal.nationality = 'British, Iranian';
  assert.deepEqual(primary(), [SANCTIONS[0].text]);
  assert.deepEqual(follow(), []);
  assert.equal(yesNo(YES_NO_SHAPES[0]), 'Yes');
  assert.equal(yesNo(YES_NO_SHAPES[1]), 'No', 'lives in the UK');
  assert.equal(yesNo(YES_NO_SHAPES[2]), 'Yes');
  p.personal.nationality = 'British';

  // Living in Russia: whether you would relocate decides the Databricks statement.
  Object.assign(p.address, { country: 'Russia', city: 'Moscow' });
  assert.deepEqual(primary(), [], 'relocation unknown');
  p.job.relocate = 'Yes';
  assert.deepEqual(primary(), ['None of the above']);
  assert.deepEqual(follow(), [], 'other lists ask about Russia without the condition');
  p.job.relocate = 'No';
  assert.deepEqual(primary(), [SANCTIONS[2].text]);
  assert.equal(yesNo(YES_NO_SHAPES[1]), 'No', 'Russia is not comprehensively sanctioned');

  // Living in Ukraine: the region decides.
  Object.assign(p.address, { country: 'Ukraine', city: '', state: '' });
  assert.deepEqual(primary(), []);
  assert.equal(yesNo(YES_NO_SHAPES[1]), null);
  p.address.city = 'Kyiv';
  assert.deepEqual(primary(), ['None of the above']);
  assert.deepEqual(follow(), [FOLLOW_UP[8].text]);
  p.address.state = 'Kherson Oblast';
  assert.deepEqual(primary(), [SANCTIONS[1].text]);
  assert.equal(yesNo(YES_NO_SHAPES[0]), 'No', 'Kherson is not Crimea');
  assert.equal(yesNo(YES_NO_SHAPES[1]), 'Yes');

  // No nationality: citizenship can't be told (where you live still answers a residence question).
  Object.assign(p.address, { country: 'United Kingdom', city: 'Glasgow', state: '' });
  p.personal.nationality = '';
  assert.deepEqual(primary(), []);
  assert.deepEqual(follow(), []);
  assert.equal(yesNo(YES_NO_SHAPES[0]), null);
  assert.equal(yesNo(YES_NO_SHAPES[1]), 'No');
  p.address.country = '';
  assert.equal(ask(p, 'compliance.sanctions', SANCTIONS_Q, { kind: 'checkboxes' }), null);
});

test('sanctions: statements are read for who and where, "other than", and conditions', () => {
  const facts = { nations: ['GB', 'IR'], home: 'GB', regions: [], relocate: 'yes' };
  const applies = (text) => fields.sanctionsApplies(text, facts);
  assert.equal(applies('Citizen or permanent resident of Cuba, Iran, North Korea, or Syria'), true);
  assert.equal(applies('Ordinarily a resident of Cuba, Iran, North Korea, Syria or the Crimea region'), false);
  assert.equal(applies('Ordinarily a resident of Russia or Belarus and not willing to relocate'), false);
  assert.equal(
    applies('Individual granted citizenship in a country other than Cuba, Iran, North Korea, or Syria'),
    true,
  );
  assert.equal(applies('A national of North Korea'), false, 'North Korea is not South Korea');
  assert.equal(applies('I am not a citizen or resident of Cuba, Iran, North Korea or Syria'), false);
  assert.equal(applies('None of the above'), undefined);
  assert.equal(applies('Have you ever lived in Cuba, Iran, North Korea or Syria?'), null, 'the past isn’t known');
  const family = 'Are you, or is any member of your family, a national of Cuba, Iran, North Korea or Syria?';
  assert.equal(applies(family), true);
  assert.equal(fields.sanctionsApplies(family, { ...facts, nations: ['GB'] }), null, 'your family’s isn’t known');
  assert.equal(applies('U.S. sanctions apply to nationals of comprehensively sanctioned countries'), true);
});

test('sanctions: a lone box is a declaration about you, an acknowledgement that mentions sanctions is not', () => {
  const box = (label, question) =>
    (matcher.classify(desc({ label, question }, { kind: 'checkbox', options: opts(label) })) || {}).type;
  const declaration = 'I confirm that I am not a citizen or resident of Cuba, Iran, North Korea or Syria';
  assert.equal(box(declaration), 'compliance.sanctions');
  assert.equal(box('None of the above', SANCTIONS_Q), 'compliance.sanctions');
  assert.equal(
    box('I acknowledge this information is used to ensure compliance with U.S. sanctions and export controls'),
    'consent',
  );
  const v = ask(british(), 'compliance.sanctions', declaration, { kind: 'checkbox' });
  assert.deepEqual(picks(opts(declaration), v, true), [declaration], 'true of a British student: ticked');
});

test('sanctions: the follow-up of a closed dropdown is found by what it follows; dual nationality elsewhere', () => {
  const { results } = matcher.plan(
    [
      desc(SANCTIONS_Q, { kind: 'combobox' }),
      desc(FOLLOW_UP_Q, { kind: 'combobox' }),
      desc('If you selected any of the above, please explain', { kind: 'textarea' }),
    ],
    british(),
  );
  assert.deepEqual(
    results.map((r) => r && r.type),
    ['compliance.sanctions', 'compliance.sanctions', null],
  );
  // Dual nationals in the other answers: both countries' rights, either citizenship, a list gets the first.
  const p = british();
  p.personal.nationality = 'British, Irish';
  assert.deepEqual(fields.workCountries(p), ['GB', 'IE']);
  assert.equal(ask(p, 'citizen', 'Are you an Irish citizen?').text, 'Yes');
  const nation = ask(p, 'nationality', 'Nationality');
  assert.equal(nation.text, 'British, Irish');
  assert.equal(matcher.matchOption(opts('France', 'Ireland', 'United Kingdom'), nation), 2);
});

/* ------------------------------------------------------- how did you hear */

test('how did you hear: LinkedIn by default, matched however the form spells it', () => {
  const p = british();
  assert.equal(fields.createProfile().job.referralSource, 'LinkedIn', 'new profiles');
  p.job.referralSource = '';
  const hear = (...o) => picks(opts(...o), ask(p, 'job.referralSource', 'How did you hear about Alloyed?'))[0] || null;
  assert.equal(ask(p, 'job.referralSource', 'How did you hear about this job?', { kind: 'text' }).text, 'LinkedIn');
  assert.equal(hear('Indeed', 'Linkedin', 'Other'), 'Linkedin');
  assert.equal(hear('Glassdoor', 'LinkedIn Jobs', 'Other'), 'LinkedIn Jobs');
  assert.equal(hear('LinkedIn job posting', 'LinkedIn recruiter message'), 'LinkedIn job posting');
  assert.equal(
    hear('Social Media (Linkedin, Instagram…)', 'Job board (Indeed, Glassdoor…)', 'Other'),
    'Social Media (Linkedin, Instagram…)',
  );
  assert.equal(
    hear('Social Media (Facebook, Instagram…)', 'Job board (Linkedin, Indeed…)', 'Other'),
    'Job board (Linkedin, Indeed…)',
  );
  assert.equal(hear('Friend', 'Social media', 'Job board'), 'Social media');
  assert.equal(
    hear('Social Media > Facebook', 'Social Media > LinkedIn', 'Job Board / Indeed'),
    'Social Media > LinkedIn',
  );
  assert.equal(hear('Job Board / LinkedIn', 'Job Board / Indeed', 'Company website'), 'Job Board / LinkedIn');
  assert.equal(
    hear('Job Board', 'Social Media', 'Referral', 'Company Website'),
    'Social Media',
    'Workday’s first level',
  );
  assert.equal(hear('No Selection', 'Not Applicable', 'LinkedIn', 'Indeed'), 'LinkedIn', 'SuccessFactors');
  // Live Greenhouse lists (Datadog, Samsara): the job posting, not the company page or a recruiter's message.
  assert.equal(
    hear('Glassdoor', 'LinkedIn (Datadog Page)', 'LinkedIn (Job Posting)', 'Other'),
    'LinkedIn (Job Posting)',
  );
  assert.equal(
    hear('Samsara Careers Site', 'LinkedIn InMail / Message from a Recruiter', 'LinkedIn Jobs'),
    'LinkedIn Jobs',
  );
  // "Select all that apply": LinkedIn alone.
  const all = opts('Indeed', 'LinkedIn', 'Social media', 'Friend', 'Other');
  const v = ask(p, 'job.referralSource', 'How did you hear about us? Select all that apply', { kind: 'checkboxes' });
  assert.equal(all[matcher.matchOption(all, v)].text, 'LinkedIn');
  // "-" leaves it for you; anything else is used as written.
  p.job.referralSource = '-';
  assert.equal(ask(p, 'job.referralSource', 'How did you hear about us?'), null);
  p.job.referralSource = 'Bright Network';
  assert.equal(hear('LinkedIn', 'Bright Network', 'Other'), 'Bright Network');
  assert.equal(hear('LinkedIn', 'Online job board', 'Other'), 'Online job board');
});

/* ------------------------------------------------------- interview availability */

const SLOTS = opts(
  'Monday 12th October – 10:00-11:00',
  'Tue 13/10 AM',
  'Wednesday 14 October 2026 (2pm - 4pm)',
  'Thursday 15th October 6pm - 9pm',
  'Saturday 17th October 10am',
  'w/c 19th October',
  'Morning (9am-12pm)',
  'Any time',
  'None of these dates work for me',
);

test('availability: interview-slot questions are recognised; "when can you start?" stays the start date', () => {
  for (const q of [
    '1st Stage Video Interview Availability (Multiple Choice) Please select ALL dates/times for which you are available...',
    'Please select ALL dates/times for which you are available',
    'Interview availability',
    'Which of these slots work for you?',
    'Assessment centre dates',
    'Select your preferred interview slot(s)',
    'When are you available for a first-round interview?',
  ]) {
    assert.equal(typeOf(q, 'checkboxes', ['Mon 12 Oct 10:00', 'Tue 13 Oct 14:00']), 'job.availability', q);
    assert.equal(typeOf(q, 'combobox', null), 'job.availability', q);
  }
  assert.equal(typeOf('Interview availability', 'textarea', null), 'job.availability');
  for (const q of ['When are you available to start?', 'Availability', 'What is your earliest start date?'])
    assert.equal(typeOf(q, 'text', null), 'job.startDate', q);
  assert.equal(typeOf('Which days are you available to work?', 'checkboxes', ['Monday', 'Tuesday']), null);
  assert.equal(typeOf('Are you available for an interview in the week of 19 October?', 'radio'), null, 'Yes / No');
  assert.equal(typeOf('Please select all dates for which you are available for the internship', 'text', null), null);
});

test('availability: every slot that fits is ticked; one choice gets the earliest; a text box gets a sentence', () => {
  const p = british();
  assert.deepEqual(p.availability, { days: 'Mon, Tue, Wed, Thu, Fri', from: '08:00', to: '20:00', unavailable: '' });
  const v = ask(p, 'job.availability', 'Please select ALL dates/times for which you are available', {
    kind: 'combobox',
  });
  assert.deepEqual(picks(SLOTS, v, true), [
    'Monday 12th October – 10:00-11:00',
    'Tue 13/10 AM',
    'Wednesday 14 October 2026 (2pm - 4pm)',
    'w/c 19th October',
    'Morning (9am-12pm)',
  ]);
  const one = ask(p, 'job.availability', 'Select your preferred interview slot', { kind: 'radio' });
  assert.deepEqual(picks(opts(...SLOTS.slice(1, 6).map((o) => o.text)).reverse(), one), ['Tue 13/10 AM']);
  assert.equal(ask(p, 'job.availability', 'Interview availability', { kind: 'textarea' }).text, 'Weekdays, 8am–8pm');

  // Dates you can't do, other hours and days.
  p.availability.unavailable = '12–14 October 2026 (exams)\n19 Oct';
  assert.deepEqual(picks(SLOTS, ask(p, 'job.availability', 'Interview availability', { kind: 'checkboxes' }), true), [
    'w/c 19th October',
    'Morning (9am-12pm)',
  ]);
  Object.assign(p.availability, { days: 'Mon, Wed, Sat', from: '09:30', to: '17:00' });
  assert.equal(
    ask(p, 'job.availability', 'Interview availability', { kind: 'text' }).text,
    'Mon, Wed and Sat, 9:30am–5pm, except 12–14 October 2026, 19 Oct',
  );
  p.availability.unavailable = '';
  assert.deepEqual(picks(SLOTS, ask(p, 'job.availability', 'Interview availability', { kind: 'checkboxes' }), true), [
    'Monday 12th October – 10:00-11:00',
    'Wednesday 14 October 2026 (2pm - 4pm)',
    'Saturday 17th October 10am',
    'w/c 19th October',
  ]);
  // Nothing fits: "None of these dates work for me", never alone in a list of separate boxes.
  Object.assign(p.availability, { days: 'Mon, Tue, Wed, Thu, Fri', from: '08:00', to: '20:00' });
  const weekend = opts('Sat 17 Oct 10:00', 'Sun 18 Oct 10:00', 'None of these dates work for me');
  const w = ask(p, 'job.availability', 'Interview availability', { kind: 'checkboxes' });
  assert.deepEqual(picks(weekend, w, true), ['None of these dates work for me']);
  assert.deepEqual(picks(opts('None of these dates work for me'), w, true), []);
  // "Any time" when every slot offered suits you.
  assert.deepEqual(picks(opts('Mon 12 Oct 10:00', 'Tue 13 Oct 15:00', 'Any time'), w, true), [
    'Mon 12 Oct 10:00',
    'Tue 13 Oct 15:00',
    'Any time',
  ]);
  assert.deepEqual(
    picks(
      opts('Mornings', 'Afternoons', 'Any time'),
      ask(p, 'job.availability', 'Interview availability', { kind: 'radio' }),
    ),
    ['Any time'],
  );
  // A slot in the past is never offered as yours.
  assert.deepEqual(picks(opts('Thursday 1st October 10:00', 'Monday 12th October 10:00'), w, true), [
    'Monday 12th October 10:00',
  ]);
  // No day ticked: left for you.
  p.availability.days = '';
  assert.equal(ask(p, 'job.availability', 'Interview availability', { kind: 'checkboxes' }), null);
});

test('availability: UK and US date orders, 12 and 24 hour clocks, years left out', () => {
  const p = british();
  const at = (o, extra) =>
    picks(
      opts(...o),
      ask(p, 'job.availability', 'Interview availability', Object.assign({ kind: 'checkboxes' }, extra)),
      true,
    );
  // 13/10 is day first, 10/14 month first; the weekday settles 03/11 (Tuesday 3 November).
  assert.deepEqual(at(['13/10 09:00', '17/10 09:00']), ['13/10 09:00']);
  assert.deepEqual(at(['10/13 9am', '10/17 9am']), ['10/13 9am']);
  assert.deepEqual(at(['Tue 03/11 9am', 'Sat 07/11 9am']), ['Tue 03/11 9am']);
  assert.deepEqual(at(['Tue 11/03 9am', 'Sat 11/07 9am']), ['Tue 11/03 9am']);
  // Nothing to tell them apart: the page’s own order.
  assert.deepEqual(
    at(['11/07 9am', '11/09 9am'], { dateOrder: 'mdy' }),
    ['11/09 9am'],
    'Saturday 7, Monday 9 November',
  );
  assert.deepEqual(at(['11/07 9am', '11/09 9am']), [], 'day first: Sunday 11 July and Saturday 11 September 2027');
  // Clocks.
  assert.deepEqual(at(['Mon 12 Oct 7am - 9am', 'Mon 12 Oct 11-1pm', 'Mon 12 Oct 19:30-20:30', 'Mon 12 Oct 12 noon']), [
    'Mon 12 Oct 11-1pm',
    'Mon 12 Oct 12 noon',
  ]);
  // Missing years: the next time the date comes round (January is next year, a weekday that says otherwise wins).
  assert.deepEqual(at(['Tuesday 12 January 10:00', 'Monday 12 January 10:00']), ['Tuesday 12 January 10:00']);
  assert.deepEqual(at(['2026-10-12 10:00', '14.10.2026 10:00', 'October 16, 2026 10:00']), [
    '2026-10-12 10:00',
    '14.10.2026 10:00',
    'October 16, 2026 10:00',
  ]);
});

/* ------------------------------------- contact preference, relationships, N/A */

test('communication preference: Email by default, never a marketing opt-in', () => {
  assert.equal(
    typeOf('* What is your communication preference?', 'select', ['No Selection', 'Email', 'Phone', 'Text Message']),
    'contact.preference',
  );
  for (const q of [
    'Preferred method of contact',
    'Preferred method of communication',
    'How would you like us to contact you?',
    'Preferred contact method',
  ])
    assert.equal(typeOf(q, 'radio', ['Email', 'Phone', 'SMS', 'WhatsApp', 'Post']), 'contact.preference', q);
  assert.notEqual(typeOf('I would like to receive job alerts by SMS', 'checkbox', null), 'contact.preference');
  assert.equal(
    typeOf('Communication preferences: keep me updated about marketing', 'checkboxes', ['Email', 'SMS']),
    null,
  );
  const p = british();
  assert.equal(p.contact.preferredContact, 'Email');
  const v = ask(p, 'contact.preference', 'What is your communication preference?', { kind: 'select' });
  assert.deepEqual(picks(opts('No Selection', 'Phone', 'E-mail', 'Text Message'), v), ['E-mail']);
  assert.deepEqual(picks(opts('Email me job alerts', 'Phone', 'Email'), v), ['Email']);
  p.contact.preferredContact = 'Text message';
  assert.deepEqual(
    picks(opts('Email', 'Phone call', 'SMS'), ask(p, 'contact.preference', 'Preferred contact method')),
    ['SMS'],
  );
});

const MOODYS_RELATIONSHIP =
  "* Do you have a Personal Relationship with a current employee of Moody's or one of its affiliates or subsidiaries? Individuals in a Personal Relationship are defined as follows: relatives (through marriage, domestic partnership, or adoption); domestic partners; individuals cohabitating and sharing responsibilities; and/or individuals in a romantic and/or sexual relationship.";
const MOODYS_NAME =
  "* If you selected 'Yes' to the previous question, what is the name of the employee with whom you have a Personal Relationship? Otherwise, enter N/A.";

test('relationships with employees: long definitions, and "Otherwise, enter N/A" after a No', () => {
  const sf = ['No Selection', 'Yes', 'No'];
  assert.equal(typeOf(MOODYS_RELATIONSHIP, 'select', sf), 'compliance.relatives');
  assert.equal(
    typeOf(
      "Do you have a Personal Relationship with a current Moody's or one of its affiliates or subsidiaries?",
      'select',
      sf,
    ),
    'compliance.relatives',
  );
  assert.equal(
    typeOf('Are you related to or in a relationship with anyone currently employed by Acme?'),
    'compliance.relatives',
  );
  assert.equal(
    typeOf('Do you have any family or personal relationships with employees of Acme?'),
    'compliance.relatives',
  );

  const p = british();
  p.compliance.relatives = 'No';
  const { results } = matcher.plan(
    [desc(MOODYS_RELATIONSHIP, { kind: 'select', options: opts(...sf) }), desc(MOODYS_NAME, { kind: 'text' })],
    p,
  );
  assert.deepEqual(
    results.map((r) => r.type),
    ['compliance.relatives', 'compliance.relativesDetails'],
  );
  assert.deepEqual(picks(opts(...sf), ask(p, 'compliance.relatives', MOODYS_RELATIONSHIP, { kind: 'select' })), ['No']);
  assert.equal(ask(p, 'compliance.relativesDetails', MOODYS_NAME, { kind: 'text' }).text, 'N/A');
  assert.equal(ask(p, 'compliance.relatives', MOODYS_NAME, { kind: 'text' }).text, 'N/A', 'without its question');
  // The token as written; a plain "If yes, please give details" box stays empty after a No.
  assert.equal(
    ask(p, 'compliance.relativesDetails', "If yes, give their name. If not, please write 'None'.", { kind: 'textarea' })
      .text,
    'None',
  );
  assert.equal(
    ask(p, 'compliance.relativesDetails', 'Their name (enter N/A if not applicable)', { kind: 'text' }).text,
    'N/A',
  );
  assert.equal(ask(p, 'compliance.relativesDetails', 'If yes, please give details', { kind: 'textarea' }), null);
  assert.equal(
    ask(p, 'job.sponsorship', 'If yes, which visa do you need? If no, type N/A', { kind: 'text' }).text,
    'N/A',
  );
  // After a Yes: the details, never "N/A".
  Object.assign(p.compliance, { relatives: 'Yes', relativesDetails: 'Grace Hopper (aunt), Ratings' });
  assert.equal(
    ask(p, 'compliance.relativesDetails', MOODYS_NAME, { kind: 'text' }).text,
    'Grace Hopper (aunt), Ratings',
  );
  // Unanswered: nothing.
  p.compliance.relatives = '';
  assert.equal(ask(p, 'compliance.relativesDetails', MOODYS_NAME, { kind: 'text' }), null);
});

test('SuccessFactors’ "No Selection" is the empty choice, never a No', () => {
  assert.equal(matcher.isPlaceholder(util.normalize('No Selection')), true);
  const p = british();
  p.compliance.relatives = 'No';
  const choices = opts('No Selection', 'Yes', 'I do not have a personal relationship with an employee');
  assert.deepEqual(picks(choices, ask(p, 'compliance.relatives', MOODYS_RELATIONSHIP, { kind: 'select' })), [
    choices[2].text,
  ]);
});
