// End-to-end: Oracle Recruiting Cloud's application steps as BNY's internship form has them (oracle-questions.html,
// built from the Candidate Experience app's own markup): Yes / No pills, a list of declarations whose "None of these
// apply to me" is a toggle button in a list, "How did you first hear about BNY?" and the list that follows it, the
// Degree pills and "Educator", and the diversity step's veteran date and Northern Ireland workplace postcode, which
// are never yours to fill from the profile.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PROFILE, launch, text } from './harness.mjs';

let h;

// A British student in St Andrews who answered the conflicts-of-interest questions in settings.
const STUDENT = {
  ...PROFILE,
  personal: { firstName: 'Robin', lastName: 'Li', nationality: 'British' },
  contact: { email: 'robin@example.com', phoneCountryCode: '+44', phone: '07386 526574', phoneType: 'Mobile' },
  address: {
    line1: '1 North Street',
    line2: '',
    city: 'St Andrews',
    state: 'Fife',
    postalCode: 'KY15 5DH',
    country: 'United Kingdom',
    organization: '',
  },
  job: { ...PROFILE.job, authorized: 'Yes', sponsorship: 'No', salary: '55000', referralSource: '' },
  eeo: { gender: 'Male', race: '', hispanic: '', veteran: 'No', disability: '' },
  compliance: {
    previouslyEmployed: 'No',
    previouslyApplied: 'No',
    relatives: 'No',
    relativesDetails: '',
    governmentOfficial: 'No',
    familyGovernmentOfficial: 'No',
    governmentDetails: '',
    criminal: 'No',
    regulatory: 'No',
  },
  education: [
    {
      school: 'University of St Andrews',
      degree: 'BSc (Hons)',
      field: 'Computing Science',
      gpa: '',
      classification: '',
      location: 'St Andrews, Scotland',
      startDate: '2025-09',
      endDate: '2028-06',
    },
  ],
  experience: [],
};

before(async () => {
  h = await launch();
  await h.setProfile(STUDENT);
});

after(() => h && h.close());

const state = async (page) => JSON.parse(await text(page, '#state'));

test('Oracle (BNY): pills, a declarations list, the source that follows "How did you hear", dates left alone', async () => {
  const page = await h.open('oracle-questions.html');
  const r = await h.fill(page);
  assert.equal(r.error, undefined);
  const s = await state(page);

  // Yes / No pills (role="radio" buttons in a radiogroup).
  assert.equal(s.sponsorship, 'No');
  assert.equal(s.eligible, 'Yes');
  assert.equal(s.previouslyEmployed, 'No');
  assert.equal(s.relatives, 'No');
  assert.equal(s.associates, 'No');
  // Regulatory history, from the profile's declaration.
  assert.equal(s.pcaob, 'No', 'suspended or barred by the PCAOB');
  assert.equal(s.regulatory, 'No', 'regulatory charges, fines, a licence revoked');
  // Each statement is a No, so "None of these apply to me" (a toggle button that had no aria-pressed yet).
  assert.deepEqual(s.declarations, ['None of these apply to me']);

  // LinkedIn by default: "Social Media", then the list that appears after it.
  assert.equal(s.heard, 'Social Media');
  assert.equal(s.specificSource, 'LinkedIn');

  // Education: the Degree pills, the major, the dates, and "Educator" (the university).
  assert.equal(s.degree, "Bachelor's Degree");
  assert.equal(s.major, 'Computing Science');
  assert.deepEqual(s.eduStart, { month: 'September', year: '2025' });
  assert.deepEqual(s.eduEnd, { month: 'June', year: '2028' });
  assert.equal(s.educator, 'University of St Andrews');
  assert.equal(s.completed, '');

  // Diversity step: the gender is yours; a veteran's civilian start date and a workplace postcode are not.
  assert.equal(s.gender, 'Male');
  // Before, the veteran answer "No" was typed into its Day, Month and Year lists, where Oracle's Month list narrows "No"
  // to November.
  assert.equal(s.veteranDate, null, 'no "November" from a veteran answer of No');
  assert.deepEqual(r.unmatched, [], 'nothing typed that no option took');
  assert.equal(r.failed, 0);
  assert.equal(s.niPostcode, '', 'the home postcode is not a Northern Ireland workplace postcode');
  assert.equal(s.tps, '');
  assert.equal(await page.$eval('#optin', (el) => el.checked), false, 'job alerts are never opted into');
  await page.close();
});

test('Oracle (BNY): a declaration the profile can’t answer is left for you, and the list too', async () => {
  const original = await h.profile();
  await h.setProfile({ compliance: { ...original.compliance, regulatory: '', governmentOfficial: '' } });
  try {
    const page = await h.open('oracle-questions.html');
    const r = await h.fill(page);
    assert.equal(r.error, undefined);
    const s = await state(page);
    assert.equal(s.pcaob, null);
    assert.equal(s.regulatory, null);
    assert.equal(s.declarations, null, 'a government statement the profile can’t answer: nothing is picked');
    assert.equal(s.relatives, 'No');
    await page.close();
  } finally {
    await h.setProfile({ compliance: original.compliance });
  }
});
