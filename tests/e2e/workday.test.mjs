// End-to-end: Workday's own widgets as a live application has them (tests/fixtures/workday-prompts.html): a country
// preselected from the visitor's IP address, an address section rebuilt per country, search prompts with chips,
// year spin buttons that only take keys, and an upload that takes several files.
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
  assert.equal(await page.$$eval('[data-automation-id="activeListContainer"], ul.menu', (l) => l.length), 0);
  assert.ok(took < 20000, `the fill took ${took} ms`);
  await page.close();
});
