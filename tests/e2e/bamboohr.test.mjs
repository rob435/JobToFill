// End-to-end: a BambooHR application form (bamboohr.html, Eastdil Secured's and Ashton Fire's). Its dropdowns are
// Fabric menu buttons ("Country United States", aria-haspopup="true") over a hidden <select> that holds only the
// chosen id; the menu of role="menuitem" rows is made when the button is clicked. The County list only appears once
// the country is the United Kingdom. The uploads say what they are for in the text before them; the A-level questions
// ask for each subject and grade in a box of its own. #state is what the form would send.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PROFILE, RESUME_PDF, launch } from './harness.mjs';

let h;
let profileId;

// A Glasgow student with three A-levels.
const ROBIN = {
  ...PROFILE,
  personal: { firstName: 'Robin', lastName: 'Li', nationality: 'British' },
  contact: { email: 'robin@example.com', phoneCountryCode: '+44', phone: '07386 526574', phoneType: 'Mobile' },
  address: {
    line1: '10 University Avenue',
    line2: '',
    city: 'Glasgow',
    state: 'Glasgow City',
    postalCode: 'G12 8QQ',
    country: 'United Kingdom',
    organization: '',
  },
  links: { ...PROFILE.links, linkedin: 'https://www.linkedin.com/in/robin-li' },
  job: { ...PROFILE.job, referralSource: 'Trackr', startDate: '2027-06-28' },
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
      school: 'Highbury Grove School',
      degree: 'A-Levels',
      field: 'Mathematics, Further Mathematics, Economics',
      gpa: 'A*A*A',
      location: 'London, UK',
      startDate: '2022-09',
      endDate: '2024-06',
    },
  ],
  experience: [],
};

const doc = (name) => ({ name, type: 'application/pdf', size: 60, dataUrl: RESUME_PDF });

before(async () => {
  h = await launch();
  profileId = await h.setProfile(ROBIN);
  await h.bg(([pid, d]) => globalThis.JTF.store.setDoc(pid, 'resume', d), [profileId, doc('robin_li_cv.pdf')]);
  await h.bg(([pid, d]) => globalThis.JTF.store.setDoc(pid, 'coverLetter', d), [profileId, doc('Robin_Li_Letter.pdf')]);
});

after(() => h && h.close());

const stateOf = (page) => page.$eval('#state', (el) => JSON.parse(el.textContent));

async function fill(query = '') {
  const page = await h.open('bamboohr.html' + query);
  await page.waitForSelector('#state:not(:empty)');
  const r = await h.fill(page);
  assert.equal(r.error, undefined);
  return { page, r, s: await stateOf(page) };
}

test('BambooHR: menu-button dropdowns, the County that appears for the UK, each A-level in its own box', async () => {
  const { page, r, s } = await fill();
  assert.deepEqual(s, {
    firstName: 'Robin',
    lastName: 'Li',
    email: 'robin@example.com',
    phone: '+44 7386 526574',
    streetAddress: '10 University Avenue',
    city: 'Glasgow',
    // The United States the form starts with, put right; then the County list it shows for the UK.
    country: 'United Kingdom',
    state: 'Glasgow City',
    zip: 'G12 8QQ',
    coverLetter: 'Robin_Li_Letter.pdf',
    resume: 'robin_li_cv.pdf',
    dateAvailable: '06/28/2027',
    linkedinUrl: 'https://www.linkedin.com/in/robin-li',
    // A BSc is a Bachelor of Science, never the "College - Bachelor of Arts" listed first.
    educationLevel: 'College - Bachelor of Science',
    educationInstitutionName: 'University of Glasgow',
    undergraduateUniversity: 'University of Glasgow',
    undergraduateDegree: 'BSc',
    graduation: '06/2028',
    aLevels: 'Yes',
    subject1: 'Mathematics',
    grade1: 'A*',
    subject2: 'Further Mathematics',
    grade2: 'A*',
    subject3: 'Economics',
    grade3: 'A', // not the A* above it
    subject4: '', // three A-levels: the fourth left empty, not missing from the profile
    grade4: '',
    equivalent: '', // "If you didn't complete UK A-levels…": you did
    heard: 'Trackr',
    rightToWork: 'Yes',
    open: 0,
  });
  assert.equal(s.honeypot, undefined, 'the hidden "Please leave this field blank" stays blank');
  assert.deepEqual(r.missing, []);
  // The dropdowns' questions are their labels, not the label and the choice the button is named after.
  const labels = await h.bg(
    async (id) => {
      const [res] = await globalThis.JTF.api.scripting.executeScript({
        target: { tabId: id },
        func: () =>
          globalThis.JTF.dom
            .collect(document)
            .filter((f) => f.el.localName === 'button')
            .map((f) => [f.kind, f.desc.signals.label, f.desc.signals.aria]),
      });
      return res.result;
    },
    await h.tabId(page),
  );
  assert.deepEqual(labels, [
    ['combo', 'County', 'County'],
    ['combo', 'Country', 'Country'],
    ['combo', 'Highest Education Obtained', 'Highest Education Obtained'],
  ]);
  // Filling again changes nothing.
  const again = await h.fill(page);
  assert.equal(again.filled, 0, JSON.stringify(again));
  assert.deepEqual(await stateOf(page), s);
  await page.close();
});

test('BambooHR: a US profile keeps the United States and picks its State', async () => {
  await h.setProfile({ ...PROFILE });
  try {
    const { page, s } = await fill();
    assert.equal(s.country, 'United States');
    assert.equal(s.state, 'California');
    assert.equal(s.educationLevel, 'College - Bachelor of Science');
    assert.equal(s.open, 0);
    await page.close();
  } finally {
    await h.setProfile(ROBIN);
  }
});

test('BambooHR: Advanced Highers answer "No" to UK A-levels and go in the box for an equivalent', async () => {
  const highers = {
    ...ROBIN.education[1],
    school: 'Madras College',
    degree: 'Advanced Highers',
    field: 'Mathematics, Physics',
    gpa: 'AA',
  };
  await h.setProfile({ ...ROBIN, education: [ROBIN.education[0], highers] });
  try {
    const { page, r, s } = await fill('?blank');
    assert.equal(s.country, 'United Kingdom', 'chosen from a form that starts with none');
    assert.equal(s.aLevels, 'No');
    // The A-level boxes aren't yours to fill: left empty, and nothing reported missing from your profile.
    assert.deepEqual([s.subject1, s.grade1, s.subject2, s.grade2], ['', '', '', '']);
    assert.deepEqual(r.missing, []);
    assert.equal(s.equivalent, 'Advanced Highers in Mathematics, Physics – AA');
    await page.close();
  } finally {
    await h.setProfile(ROBIN);
  }
});
