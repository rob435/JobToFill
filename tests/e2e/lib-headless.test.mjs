// End-to-end: unstyled React widget libraries that custom career sites (Next.js / Tailwind) are built from, used as
// their docs show. lib-headless.html: Headless UI v2 (a Listbox and a Combobox whose options are portalled and anchored,
// a virtual Combobox that only renders the rows in view, a multiple Listbox, Checkbox, Switch, RadioGroup) and
// Downshift (an async useCombobox, useSelect, useMultipleSelection with chips). lib-radix.html: Radix Select in its
// item-aligned position (a long list scrolled inside its viewport) and as a popper, Radix Checkbox and RadioGroup.
// Every assertion reads the form's own React state (#state), not what the DOM shows.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PROFILE, launch } from './harness.mjs';

let h;

const US = { ...PROFILE, job: { ...PROFILE.job, locations: 'New York, San Francisco' } };

// A student in Glasgow (as in workday.test.mjs).
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
  job: { ...PROFILE.job, locations: 'London' },
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
  // "I agree to the terms" and "I consent to the privacy notice" are ticked like any acknowledgement.
  await h.setSettings({ consents: true });
});

after(() => h && h.close());

/** The form's React state, as the page prints it. */
const stateOf = (page) => page.$eval('#state', (el) => JSON.parse(el.textContent));

async function fillPage(file, profile) {
  await h.setProfile(profile);
  const page = await h.open(file);
  await page.waitForSelector('#state:not(:empty)');
  const r = await h.fill(page);
  assert.equal(r.error, undefined);
  return { page, r };
}

/** No menu, listbox or popup is left open. */
const openLists = (page) =>
  page.$$eval(
    '[role="listbox"]',
    (list) =>
      list.filter((el) => el.getBoundingClientRect().height > 0 && getComputedStyle(el).display !== 'none').length,
  );

test('Headless UI and Downshift (US profile): anchored lists, a virtual combobox, chips, async search', async () => {
  const { page, r } = await fillPage('lib-headless.html', US);
  const s = await stateOf(page);
  assert.equal(s.firstName, 'Ada');
  assert.equal(s.lastName, 'Lovelace');
  assert.equal(s.email, 'ada@example.com');
  assert.equal(s.phone, '+1 415 555 0100');
  assert.equal(s.linkedin, 'https://www.linkedin.com/in/ada');
  // Headless UI Combobox, filtered by what is typed; its options are portalled to <body> (anchor="bottom").
  assert.deepEqual(s.country, { id: 68, name: 'United States' });
  // The virtual Combobox renders a handful of its 2,466 schools: the right one only exists once searched for.
  assert.equal(s.school, 'University of Cambridge');
  // Headless UI Listbox: a button, its options portalled and anchored.
  assert.deepEqual(s.degree, { id: 3, name: 'Bachelor’s Degree' });
  // Downshift useCombobox whose results come 300 ms after typing; useSelect.
  assert.equal(s.fieldOfStudy, 'Mathematics');
  assert.equal(s.graduationYear, '2016');
  // Headless UI Listbox `multiple`: both places, the menu staying open between them.
  assert.deepEqual(s.locations, ['New York', 'San Francisco']);
  // Downshift's multiple selection: a menu that stays open and drops each pick, chips without class names.
  assert.deepEqual(s.skills, ['Python', 'SQL']);
  // Headless UI Switch, RadioGroup, Checkbox.
  assert.equal(s.relocation, true);
  assert.equal(s.sponsorship, 'No');
  assert.equal(s.terms, true);
  assert.equal(r.failed, 0, `unmatched: ${r.unmatched}`);
  assert.equal(r.pending, 0, 'nothing left over for the AI: the skills it picked count as an answer');
  assert.equal(await openLists(page), 0);
  await page.close();
});

test('Headless UI and Downshift (UK student): the class of degree, a subject by another name, a later year', async () => {
  const { page, r } = await fillPage('lib-headless.html', STUDENT);
  const s = await stateOf(page);
  assert.equal(s.firstName, 'Robin');
  assert.equal(s.lastName, 'Li');
  assert.equal(s.email, 'robin@example.com');
  assert.match(s.phone, /7386 526574$/);
  assert.deepEqual(s.country, { id: 67, name: 'United Kingdom' });
  assert.equal(s.school, 'University of Glasgow');
  assert.deepEqual(s.degree, { id: 3, name: 'Bachelor’s Degree' }, 'a BSc');
  assert.equal(s.fieldOfStudy, 'Computer Science', 'for Computing Science');
  assert.equal(s.graduationYear, '2027');
  assert.deepEqual(s.locations, ['London']);
  assert.deepEqual(s.skills, ['Python', 'SQL']);
  assert.equal(s.relocation, true);
  assert.equal(s.sponsorship, 'No');
  assert.equal(s.terms, true);
  assert.equal(r.failed, 0, `unmatched: ${r.unmatched}`);
  assert.equal(await openLists(page), 0);
  await page.close();
});

test('Headless UI and Downshift: filling again (Overwrite on) keeps the multi-select picks as they are', async () => {
  const { page } = await fillPage('lib-headless.html', US);
  const first = await stateOf(page);
  await h.setSettings({ overwrite: true });
  try {
    await h.fill(page);
  } finally {
    await h.setSettings({ overwrite: false });
  }
  const s = await stateOf(page);
  // Clicking a selected option of a multiple Listbox again would take it away.
  assert.deepEqual(s.locations, ['New York', 'San Francisco']);
  // Leaving Downshift's box while its first row is highlighted would add that row ("C++").
  assert.deepEqual(s.skills, ['Python', 'SQL']);
  assert.deepEqual(s, first);
  await page.close();
});

test('Radix (US profile): item-aligned and popper Selects, Checkbox and RadioGroup over hidden inputs', async () => {
  const { page, r } = await fillPage('lib-radix.html', US);
  const s = await stateOf(page);
  assert.equal(s.fullName, 'Ada Lovelace');
  assert.equal(s.email, 'ada@example.com');
  assert.equal(s.phone, '+1 415 555 0100');
  assert.equal(s.linkedin, 'https://www.linkedin.com/in/ada');
  // Item-aligned: the list opens around its first item, United States far below what is in view.
  assert.equal(s.country, 'United States');
  assert.equal(s.source, 'LinkedIn');
  assert.equal(s.over18, 'Yes');
  assert.equal(s.privacy, true);
  // The hidden native <select> Radix keeps for the form agrees.
  assert.equal(await page.$eval('select[name="country"]', (el) => el.value), 'United States');
  assert.equal(r.failed, 0, `unmatched: ${r.unmatched}`);
  assert.equal(await openLists(page), 0);
  await page.close();
});

test('Radix (UK student): United Kingdom from the bottom of a 70-country item-aligned Select', async () => {
  const { page, r } = await fillPage('lib-radix.html', STUDENT);
  const s = await stateOf(page);
  assert.equal(s.fullName, 'Robin Li');
  assert.equal(s.email, 'robin@example.com');
  assert.equal(s.country, 'United Kingdom');
  assert.equal(s.source, 'LinkedIn');
  assert.equal(s.over18, 'Yes');
  assert.equal(s.privacy, true);
  assert.equal(r.failed, 0, `unmatched: ${r.unmatched}`);
  assert.equal(await openLists(page), 0);
  await page.close();
});

// Answers none of the dropdowns offer: each menu must be closed again with nothing picked, and the page left usable.
const UNOFFERED = {
  ...PROFILE,
  address: { ...PROFILE.address, country: 'Kazakhstan' },
  job: { ...PROFILE.job, locations: 'Paris' },
  skills: 'COBOL, Fortran',
  education: [
    {
      school: 'Hogwarts School of Witchcraft',
      degree: 'Certificate of Higher Education',
      field: 'Underwater Basket Weaving',
      startDate: '2031-09',
      endDate: '2035-06',
    },
  ],
};

/** Is anything left aria-hidden, inert or unclickable by a modal menu that stayed open? */
const blocked = (page) =>
  page.evaluate(
    () =>
      document.body.style.pointerEvents === 'none' ||
      !!document.querySelector('#root[aria-hidden="true"], #root [aria-hidden="true"] input, [inert] input'),
  );

test('Headless UI and Downshift: answers no list offers leave every menu closed and nothing picked', async () => {
  const { page } = await fillPage('lib-headless.html', UNOFFERED);
  const s = await stateOf(page);
  assert.equal(s.firstName, 'Ada');
  assert.equal(s.country, null);
  assert.equal(s.school, null);
  assert.equal(s.degree, null);
  assert.equal(s.fieldOfStudy, null);
  assert.equal(s.graduationYear, null);
  assert.deepEqual(s.locations, []);
  assert.deepEqual(s.skills, [], 'nothing the menu happened to highlight');
  assert.equal(s.sponsorship, 'No');
  assert.equal(s.terms, true);
  assert.equal(await openLists(page), 0);
  assert.equal(await blocked(page), false);
  await page.close();
});

test('Radix: a Select with no option for the answer is closed again, and the fields after it still fill', async () => {
  const { page, r } = await fillPage('lib-radix.html', UNOFFERED);
  const s = await stateOf(page);
  assert.equal(s.country, '');
  assert.deepEqual(r.unmatched, ['Country']);
  // An open Radix Select hides the rest of the page from the next fields (aria-hidden, pointer-events: none).
  assert.equal(await openLists(page), 0);
  assert.equal(await blocked(page), false);
  assert.equal(s.source, 'LinkedIn');
  assert.equal(s.over18, 'Yes');
  assert.equal(s.privacy, true);
  await page.close();
});

test(
  'A UK number in a plain phone box is written +44 7386 526574 or 07386 526574',
  { todo: 'fields.js phone: the international form keeps the trunk 0 ("+44 07386 526574")' },
  async () => {
    const { page } = await fillPage('lib-radix.html', STUDENT);
    const s = await stateOf(page);
    assert.match(s.phone, /^(\+44 7386 526574|07386 526574)$/);
    await page.close();
  },
);
