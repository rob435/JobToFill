// End-to-end: a Phenom application form (Marsh McLennan's, a Workday job behind it), its "My information" and "My
// experience" steps (phenom.html, built with the real react-datepicker). The work dates are month pickers that take
// no typing (the box blurs itself on focus, typing is thrown away), so a date only goes in through the calendar; the
// second upload is "An optional cover letter (or any other documents…)"; the degree and subject lists are Workday's.
// Every assertion reads the form's own React state (#state), as Phenom would submit it.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PROFILE, RESUME_PDF, launch } from './harness.mjs';

let h;
let profileId;

// A Glasgow student with a spring week that started and ended in March, and a school entry with Advanced Highers.
const ROBIN = {
  ...PROFILE,
  personal: { firstName: 'Robin', lastName: 'Li', nationality: 'British' },
  address: {
    ...PROFILE.address,
    city: 'Glasgow',
    state: 'Glasgow City',
    postalCode: 'G12 8QQ',
    country: 'United Kingdom',
  },
  job: { ...PROFILE.job, referralSource: 'Trackr', startDate: '2027-06-28', adjustments: 'No' },
  languages: 'English, French',
  skills: 'Python, Java, SQL',
  education: [
    {
      school: 'University of Glasgow',
      degree: 'BSc',
      field: 'Computing Science',
      gpa: '',
      classification: '2:1',
      location: 'Glasgow, UK',
      startDate: '2024-09',
      endDate: '2028-06',
    },
    {
      school: 'Madras College',
      degree: 'Advanced Highers',
      field: 'Mathematics, Physics, Computing Science',
      gpa: 'AAA',
      location: 'St Andrews, UK',
      startDate: '2018-08',
      endDate: '2024-06',
    },
  ],
  experience: [
    {
      company: 'Barclays',
      title: 'Technology Developer Spring Week',
      location: 'Glasgow',
      startDate: '2026-03',
      endDate: '2026-03',
      current: false,
      description: 'Spring Week',
    },
  ],
};

const LETTER = { name: 'Robin_Li_Cover_Letter.pdf', type: 'application/pdf', size: 60, dataUrl: RESUME_PDF };

before(async () => {
  h = await launch();
  profileId = await h.setProfile(ROBIN);
  await h.bg(
    ([pid, dataUrl]) =>
      globalThis.JTF.store.setDoc(pid, 'resume', {
        name: 'robin_li_cv.pdf',
        type: 'application/pdf',
        size: 60,
        dataUrl,
      }),
    [profileId, RESUME_PDF],
  );
});

after(() => h && h.close());

const stateOf = (page) => page.$eval('#state', (el) => JSON.parse(el.textContent));

async function fill(query = '') {
  const page = await h.open('phenom.html' + query);
  await page.waitForSelector('#state:not(:empty)');
  const r = await h.fill(page);
  assert.equal(r.error, undefined);
  return { page, r, s: await stateOf(page) };
}

test('Phenom: month pickers through their calendar, Workday’s lists, the CV and the letter each in its own upload', async () => {
  await h.bg(([pid, doc]) => globalThis.JTF.store.setDoc(pid, 'coverLetter', doc), [profileId, LETTER]);
  const { page, r, s } = await fill();
  const job = s.experienceData[0];
  assert.equal(job.title, 'Technology Developer Spring Week');
  assert.equal(job.companyName, 'Barclays');
  // March to March ends in April: a "To" that isn't after "From" is turned down.
  assert.deepEqual(job.fromTo, { startDate: '03/2026', endDate: '04/2026', currentlyWorkHere: false });
  assert.equal(s.open, 0, 'no calendar left open');
  assert.equal(await page.$$eval('.react-datepicker-popper', (l) => l.length), 0);
  assert.deepEqual(s.educationData, [
    { schoolName: 'University of Glasgow', degree: 'BSc', fieldOfStudy: 'Computer_and_Information_Science' },
    { schoolName: 'Madras College', degree: 'HS', fieldOfStudy: 'Mathematics' },
  ]);
  // The CV goes to "Upload resume" only; the optional cover letter to the attachments.
  assert.equal(s.resume, 'robin_li_cv.pdf');
  assert.deepEqual(s.attachments, ['Robin_Li_Cover_Letter.pdf']);
  // Trackr isn't on the list, and "Referral- Client/Vendor/Other" is a referral: left for you.
  assert.equal(s.applicantSource, '');
  assert.deepEqual(r.check, []);
  // The questionnaire: its letter upload gets the letter, "any other relevant documents" nothing; the graduation date
  // is the degree's (not the school entry's above it), the GPA a 2:1 on your own scale, N/A for no Master's.
  assert.deepEqual(s.questionnaire, {
    letter: ['Robin_Li_Cover_Letter.pdf'],
    graduation: '2028-06-01',
    penultimate: 'Yes',
    bachelorGpa: s.questionnaire.bachelorGpa,
    masterGpa: 'N/A',
    languages: ['English', 'French'],
    coding: ['Python', 'Java', 'SQL'],
    start: '2027-06-28',
    adjustments: 'No',
  });
  assert.match(s.questionnaire.bachelorGpa, /^2:1\b/);
  // The date boxes are "From" and "To" (their <label for>), not the live region they point to.
  const labels = await h.bg(
    async (id) => {
      const [res] = await globalThis.JTF.api.scripting.executeScript({
        target: { tabId: id },
        func: () =>
          globalThis.JTF.dom
            .collect(document)
            .filter((f) => /fromTo\.(start|end)Date$/.test(f.el.id))
            .map((f) => f.desc.signals.label),
      });
      return res.result;
    },
    await h.tabId(page),
  );
  assert.deepEqual(labels, ['From', 'To']);
});

test('Phenom: no cover letter leaves the attachments empty, never the CV again; "To" can’t be the same month', async () => {
  await h.bg((pid) => globalThis.JTF.store.removeDoc(pid, 'coverLetter'), profileId);
  // Phenom's durationDifference: "To" at least 31 days after "From", so March is greyed out in its calendar.
  const { s } = await fill('?gap=31');
  assert.equal(s.resume, 'robin_li_cv.pdf');
  assert.deepEqual(s.attachments, []);
  assert.equal(s.questionnaire.letter, undefined);
  assert.equal(s.questionnaire.other, undefined);
  assert.deepEqual(s.experienceData[0].fromTo, { startDate: '03/2026', endDate: '04/2026', currentlyWorkHere: false });
  assert.equal(s.open, 0);
});

test('Phenom: a year away is reached through the calendar’s year list; a current job leaves "To" empty', async () => {
  await h.setProfile({
    experience: [
      { ...ROBIN.experience[0], startDate: '2019-11', endDate: '2021-02' },
      { company: 'GUTS', title: 'Treasurer', location: 'Glasgow', startDate: '2025-09', endDate: '', current: true },
    ],
  });
  const page = await h.open('phenom.html');
  await page.waitForSelector('#state:not(:empty)');
  await page.click('.array-button-add');
  await page.waitForSelector('[id="experienceData[1].title"]');
  await h.fill(page);
  const s = await stateOf(page);
  assert.deepEqual(s.experienceData[0].fromTo, { startDate: '11/2019', endDate: '02/2021', currentlyWorkHere: false });
  assert.deepEqual(s.experienceData[1].fromTo, { startDate: '09/2025', endDate: '', currentlyWorkHere: true });
  assert.equal(s.open, 0);
  await h.setProfile({ experience: ROBIN.experience });
});
