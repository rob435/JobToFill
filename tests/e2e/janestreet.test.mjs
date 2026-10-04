// End-to-end: Jane Street's application form (janestreet.html), whose dropdowns are plain divs over hidden inputs
// with no ARIA, whose "How did you hear about us?" keeps its choices in collapsed categories, and whose chosen
// selects carry a hidden <label for> that only names the field.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PROFILE, RESUME_PDF, launch, text } from './harness.mjs';

let h;

before(async () => {
  h = await launch();
  const id = await h.setProfile(PROFILE);
  await h.bg(
    ([pid, dataUrl]) =>
      globalThis.JTF.store.setDoc(pid, 'resume', { name: 'ada_cv.pdf', type: 'application/pdf', size: 60, dataUrl }),
    [id, RESUME_PDF],
  );
});

after(() => h.close());

const state = async (page) => JSON.parse(await text(page, '#state'));

test('Jane Street: dropdowns without ARIA, a collapsed "How did you hear", chosen selects with hidden labels', async () => {
  const original = await h.profile();
  // A British maths student at UCL, graduating in June 2027, who speaks French.
  await h.setProfile({
    personal: { nationality: 'British' },
    contact: { phoneCountryCode: '+44', phone: '7700 900123', schoolEmail: 'ada.lovelace.24@ucl.ac.uk' },
    address: { line1: '1 Gower St', city: 'London', state: '', postalCode: 'WC1E 6BT', country: 'United Kingdom' },
    job: { referralSource: 'LinkedIn', otherOffers: 'No' },
    compliance: { previouslyApplied: 'No' },
    education: [
      {
        school: 'University College London',
        degree: 'BSc',
        field: 'Mathematics',
        gpa: '',
        location: 'London',
        startDate: '2024-09',
        endDate: '2027-06',
      },
    ],
    languages: 'English, French',
  });
  try {
    const page = await h.open('janestreet.html');
    await page.waitForSelector('#education_level_chosen');
    const r = await h.fill(page);
    assert.equal(r.error, undefined);
    const s = await state(page);
    assert.equal(s.first_name, 'Ada');
    assert.equal(s.last_name, 'Lovelace');
    assert.equal(s.email, 'ada@example.com');
    assert.equal(s.email_confirmation, 'ada@example.com');
    assert.equal(s.phone_country_code, 'United Kingdom (+44)', 'not Guernsey, Jersey or the Isle of Man');
    assert.match(s.phone, /^\+44 ?7700 ?900123$/);
    assert.equal(s.source, 'LinkedIn', 'found under its collapsed "Social media"');
    assert.equal(s.source_details, '');
    assert.equal(s.recruiting_timelines, 'false', 'no other offers or deadlines');
    assert.equal(s.visitor_visa, 'false', 'a British citizen needs no visa to enter the UK');
    assert.equal(s.interviewed, 'false', 'never applied, so never interviewed');
    assert.equal(s.student, 'true');
    assert.equal(s.college, 'University College London');
    assert.equal(s.university_email, 'ada.lovelace.24@ucl.ac.uk');
    assert.equal(s.education_level, 'Undergraduate');
    assert.equal(s.major, 'Mathematics');
    assert.equal(s.secondary_major, '', 'a second major is not your first one again');
    assert.equal(s.high_school_grad_year, '2024', 'the year the degree began');
    assert.equal(s.ft_employment_start_month, 'June');
    assert.equal(s.ft_employment_start_year, '2027');
    assert.equal(s.languages_spoken, 'French');
    assert.equal(s.resume, 'ada_cv.pdf');
    // Every dropdown closed again.
    assert.equal(await page.$$eval('.standard-dropdown.open', (l) => l.length), 0);
    await page.close();
  } finally {
    await h.setProfile({
      personal: original.personal,
      contact: original.contact,
      address: original.address,
      job: original.job,
      compliance: original.compliance,
      education: original.education,
      languages: original.languages,
    });
  }
});
