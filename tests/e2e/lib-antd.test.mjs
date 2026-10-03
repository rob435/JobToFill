// End-to-end: an application form built with Ant Design (antd v6) the way its docs build one. The form's own state
// (form.getFieldsValue(true)) and validation errors are what is checked: a value that only shows in the page is not
// filled. Hard parts: virtual lists (only the rows in view are in the page, beside a 0×0 listbox for screen readers),
// a dial-code picker and a country preselected from the visitor's IP address (Italy, +39), a university list loaded
// from the server as you type, and date pickers that only take a date typed in their own format.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PROFILE, launch, text } from './harness.mjs';

let h;

// A student in Glasgow, applying from a VPS in Italy.
const STUDENT = {
  ...PROFILE,
  personal: { firstName: 'Robin', lastName: 'Li', nationality: 'British' },
  contact: { email: 'robin@example.com', phoneCountryCode: '+44', phone: '07386 526574', phoneType: 'Mobile' },
  address: {
    line1: '10 University Avenue',
    line2: 'Flat 2',
    city: 'Glasgow',
    state: 'Glasgow City',
    postalCode: 'G12 8QQ',
    country: 'United Kingdom',
    organization: '',
  },
  links: { ...PROFILE.links, linkedin: 'https://www.linkedin.com/in/robin-li' },
  job: { ...PROFILE.job, locations: 'London, New York', salary: '35000', startDate: '2027-06-14' },
  education: [
    {
      school: 'University of Glasgow',
      degree: 'BSc',
      field: 'Computing Science',
      gpa: '',
      classification: '2:1',
      location: 'Glasgow, Scotland',
      startDate: '2023-09',
      endDate: '2027-06',
    },
  ],
};

before(async () => {
  h = await launch();
});

after(() => h && h.close());

/** What the form registered: its values (dates as YYYY-MM-DD) and the errors its rules report. */
const formState = async (page) => JSON.parse(await text(page, '#state'));

async function open(query = '') {
  const page = await h.open('lib-antd.html' + query);
  await page.waitForSelector('#apply_firstName');
  return page;
}

/** Nothing left marked invalid or open: no field with aria-invalid="true", no dropdown still expanded. */
async function clean(page) {
  assert.deepEqual(
    await page.$$eval('[aria-invalid="true"]', (els) => els.map((el) => el.id || el.outerHTML.slice(0, 80))),
    [],
  );
  assert.equal(await page.$$eval('[aria-expanded="true"]', (els) => els.length), 0, 'every dropdown closed');
}

const COVER_LETTER = PROFILE.coverLetter;

test('antd form, UK student: virtual lists, the IP-chosen Italy and +39 put right, remote search, dates', async () => {
  await h.setProfile(STUDENT);
  const page = await open();
  const r = await h.fill(page);
  assert.equal(r.error, undefined);
  const s = await formState(page);
  assert.deepEqual(s.values, {
    prefix: 'GB', // "United Kingdom (+44)", found by scrolling a virtual list nothing can be typed into
    country: 'GB', // typed into the search: "United Kingdom" is not among the rows in view
    firstName: 'Robin',
    lastName: 'Li',
    email: 'robin@example.com',
    phone: '07386 526574', // without the code: the picker beside it has that
    city: 'Glasgow',
    linkedin: 'https://www.linkedin.com/in/robin-li',
    university: 'University of Glasgow', // options loaded 400 ms after each search, a Spin meanwhile
    degree: 'Bachelor’s degree (BA, BSc, BEng)',
    graduationDate: '2027-06-01', // typed as 01/06/2027 into a DD/MM/YYYY picker
    offices: ['London', 'New York'],
    officesConsidered: ['London', 'New York'],
    startMonth: '2027-06-01', // a month picker: 2027-06
    salary: 35000,
    sponsorship: 'no',
    over18: 'yes',
    source: 'LinkedIn',
    coverLetter: COVER_LETTER,
  });
  assert.deepEqual(s.errors, {});
  await clean(page);
  assert.equal(r.consents, 1, 'the privacy notice is left for you by default');
  assert.deepEqual(r.unmatched, []);
  assert.deepEqual(r.missing, []);

  // Filling again changes nothing: every widget shows the answer it already has.
  const again = await h.fill(page);
  assert.equal(again.filled, 0, JSON.stringify(again));
  assert.deepEqual(await formState(page), s);
  await page.close();

  await h.setSettings({ consents: true });
  try {
    const ticked = await open();
    await h.fill(ticked);
    const t = await formState(ticked);
    assert.equal(t.values.privacy, true, 'ticked once the setting is on');
    assert.deepEqual(t.errors, {});
    await ticked.close();
  } finally {
    await h.setSettings({ consents: false });
  }
});

test('antd form, US profile: +1 and the United States, then the State question that appears for it', async () => {
  await h.setProfile({ ...PROFILE, job: { ...PROFILE.job, locations: 'New York' } });
  const page = await open();
  const r = await h.fill(page);
  assert.equal(r.error, undefined);
  const s = await formState(page);
  assert.deepEqual(s.values, {
    prefix: 'US',
    country: 'US',
    state: 'California', // only shown once the country is the United States
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com',
    phone: '415 555 0100',
    city: 'San Francisco',
    linkedin: 'https://www.linkedin.com/in/ada',
    university: 'University of Cambridge',
    degree: 'Bachelor’s degree (BA, BSc, BEng)',
    graduationDate: '2016-06-01',
    offices: ['New York'],
    officesConsidered: ['New York'],
    startMonth: '2026-11-01',
    salary: 130000,
    sponsorship: 'no',
    over18: 'yes',
    source: 'LinkedIn',
    coverLetter: COVER_LETTER,
  });
  assert.deepEqual(s.errors, {});
  await clean(page);
  await page.close();
});

test('antd RangePicker: the dates of study go into its start and end boxes', async () => {
  await h.setProfile(STUDENT);
  const page = await open('?range');
  const r = await h.fill(page);
  assert.equal(r.error, undefined);
  const s = await formState(page);
  assert.deepEqual(s.values.studyDates, ['2023-09-01', '2027-06-01']);
  assert.equal(s.values.graduationDate, undefined);
  assert.deepEqual(s.errors, {});
  await clean(page);
  await page.close();
});

test('antd DatePicker (DD/MM/YYYY) on a page that only says lang="en": the day and month are not swapped', async () => {
  await h.setProfile(STUDENT);
  const page = await open('?lang=en');
  await h.fill(page);
  const s = await formState(page);
  assert.equal(s.values.graduationDate, '2027-06-01');
  await page.close();
});
