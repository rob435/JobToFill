// End-to-end: Workday's and Oracle's own widgets as live applications have them. Workday (workday-prompts.html, with
// workday-widgets.js): a country preselected from the visitor's IP address, an address section rebuilt per country,
// Canvas Kit Selects that fade out, search prompts whose rows only take a click inside them, year spin buttons drawn by
// an aria-hidden "…-display", Skills that takes several, and an upload that takes several files.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PROFILE, RESUME_PDF, launch, text, value } from './harness.mjs';

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
  skills: 'Python, SQL, Stata',
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
  const id = await h.setProfile(STUDENT);
  await h.bg(
    ([profileId, dataUrl]) =>
      globalThis.JTF.store.setDoc(profileId, 'resume', {
        name: 'Robin_Li_CV.pdf',
        type: 'application/pdf',
        size: 60,
        dataUrl,
      }),
    [id, RESUME_PDF],
  );
});

after(() => h && h.close());

const chips = (page, field) =>
  page.$$eval(`[data-automation-id="${field}"] [data-automation-id="selectedItem"]`, (els) =>
    els.map((el) => el.textContent.replace('×', '').trim()),
  );

test('Workday: a country picked from the IP address is put right, then the address and phone code follow it', async () => {
  const page = await h.open('workday-prompts.html');
  const started = Date.now();
  const r = await h.fill(page);
  const took = Date.now() - started;
  assert.equal(r.error, undefined);
  assert.equal(await text(page, '#country--country'), 'United Kingdom');
  assert.equal(await page.$eval('#address', (el) => el.dataset.country), 'United Kingdom');
  assert.equal(await value(page, '#address--addressLine1'), '10 University Avenue');
  assert.equal(await value(page, '#address--addressLine2'), 'Flat 2');
  assert.equal(await value(page, '#address--city'), 'Glasgow');
  assert.equal(await value(page, '#address--postalCode'), 'G12 8QQ');
  assert.equal(await value(page, '#name--legalName--firstName'), 'Robin');
  assert.equal(await text(page, '#phoneNumber--phoneType'), 'Mobile');
  assert.deepEqual(await chips(page, 'formField-countryPhoneCode'), ['United Kingdom (+44)']);
  assert.equal(await value(page, '#phoneNumber--phoneNumber'), '07386 526574');

  // Education: search prompts pick a suggestion (a chip), year boxes take the years, the result is the class.
  assert.deepEqual(await chips(page, 'formField-schoolItem'), ['University of Glasgow']);
  assert.deepEqual(await chips(page, 'formField-fieldOfStudy'), ['Computer Science']);
  assert.equal(await text(page, '#education-1--degree'), 'Bachelors');
  assert.equal(await value(page, '#education-1--firstYearAttended-dateSectionYear-input'), '2023');
  assert.equal(await value(page, '#education-1--lastYearAttended-dateSectionYear-input'), '2027');
  assert.equal(await value(page, '#education-1--gradeAverage'), '2:1', 'the class, never a GPA made up from it');
  // Skills takes them one by one, each ticked in the list that stays open.
  assert.deepEqual(await chips(page, 'formField-skills'), ['Python', 'SQL', 'Stata']);
  // "Resume/CV/Transcripts" takes several files: the CV goes in (no transcript or letter saved here).
  assert.deepEqual(await page.$$eval('#uploaded li', (list) => list.map((li) => li.textContent)), ['Robin_Li_CV.pdf']);
  // Each Select opened once and closed again: one clicked while its menu fades out would open again, over the next field.
  assert.deepEqual(
    await page.$$eval('button[aria-haspopup="listbox"]', (list) => list.map((b) => [b.id, b.dataset.opened])),
    [
      ['country--country', '1'],
      ['phoneNumber--phoneType', '1'],
      ['education-1--degree', '1'],
    ],
  );
  assert.equal(await page.$$eval('[data-automation-id="activeListContainer"], .wd-menu', (l) => l.length), 0);
  assert.equal(await page.$$eval('button[aria-haspopup][aria-expanded="true"]', (l) => l.length), 0);
  assert.ok(took < 20000, `the fill took ${took} ms`);
  await page.close();
});

test('Oracle’s apply step: its hidden “I agree with the terms and conditions” box is ticked; job alerts are not', async () => {
  await h.setSettings({ consents: true });
  try {
    const page = await h.open('oracle-email.html');
    const r = await h.fill(page);
    assert.equal(r.error, undefined);
    assert.equal(await value(page, '#primary-email-0'), 'robin@example.com');
    assert.equal(await page.$eval('#legal-disclaimer-checkbox', (el) => el.checked), true);
    assert.equal(await text(page, '#accepted'), 'yes', 'the page saw the tick');
    assert.equal(await page.$eval('#job-alerts', (el) => el.checked), false);
    await page.close();
  } finally {
    await h.setSettings({ consents: false });
  }
});
