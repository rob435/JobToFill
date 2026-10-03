// End-to-end: the form-state and input libraries application forms are built from. lib-forms.html (React):
// react-hook-form, Formik + Yup, react-imask masks, react-phone-number-input preset to the wrong country, and HTML
// constraint validation. lib-vue.html: Vue 3 + Element Plus (el-form rules, el-select in its variants, a date
// picker that shows DD/MM/YYYY). Both pages print the library's own state into #state: a value only the DOM shows,
// or one left with a validation error, is not filled.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PROFILE, launch } from './harness.mjs';

let h;

// A student in Glasgow, as they write their own details: a UK mobile with its leading 0, the code apart.
const STUDENT = {
  ...PROFILE,
  personal: { firstName: 'Robin', lastName: 'Li', pronouns: '', nationality: 'British', dob: '2004-03-15' },
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
  job: { ...PROFILE.job, salary: '32000', locations: 'London, Edinburgh' },
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
// The harness's US profile, with the keys the student has (profiles are merged into, not replaced).
const US = { ...PROFILE, personal: { ...PROFILE.personal, nationality: '' }, job: { ...PROFILE.job, locations: '' } };

before(async () => {
  h = await launch();
  await h.setSettings({ consents: true });
});

after(() => h && h.close());

const state = (page) => page.$eval('#state', (el) => JSON.parse(el.textContent));
const digits = (s) => String(s || '').replace(/\D/g, '');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Press the form's own "Continue" (its full validation), then wait for what `read` takes from the state. */
async function submit(page, button, read) {
  await page.$eval(button, (el) => el.click());
  for (let i = 0; i < 50; i++) {
    const got = read(await state(page));
    if (got != null && got !== false) return got;
    await sleep(100);
  }
  return read(await state(page));
}

/** Open `file` for `profile`, fill it, and return the fill report and the page's own state. */
async function fillPage(file, profile, ready = '#state') {
  await h.setProfile(profile);
  const page = await h.open(file);
  await page.waitForSelector(ready);
  const report = await h.fill(page);
  assert.equal(report.error, undefined);
  return { page, report, s: await state(page) };
}

/* ------------------------------------------------------------------ lib-forms.html */

test('react-hook-form: registered inputs validated on blur, a Controller, a salary kept as a number', async () => {
  const { page, report, s } = await fillPage('lib-forms.html?section=rhf', STUDENT, '#rhf-firstName');
  assert.deepEqual(s.rhf.values, {
    firstName: 'Robin',
    lastName: 'Li',
    email: 'robin@example.com',
    linkedin: 'https://www.linkedin.com/in/robin-li',
    preferredName: 'Robin Li',
    salary: 32000,
  });
  assert.deepEqual(s.rhf.errors, {});
  assert.deepEqual(s.rhf.touched, ['email', 'firstName', 'lastName', 'linkedin', 'preferredName', 'salary']);
  assert.deepEqual(await page.$$eval('#rhf [aria-invalid="true"], #rhf [role="alert"]', (l) => l.length), 0);
  assert.deepEqual(report.unmatched, []);
  assert.equal(await submit(page, '#rhf button[type="submit"]', (x) => x.rhf.submit), 'valid');
  await page.close();
});

test('Formik + Yup: the phone and date of birth pass the schema’s patterns, the degree is picked', async () => {
  const { page, report, s } = await fillPage('lib-forms.html?section=formik', STUDENT, '#fk-phone');
  const { values, errors, touched } = s.formik;
  assert.equal(digits(values.phone), '447386526574', values.phone);
  assert.match(values.phone, /^\+?[0-9 ]{10,15}$/);
  assert.equal(values.email, 'robin@example.com');
  assert.equal(values.dob, '15/03/2004');
  assert.equal(values.degree, 'Bachelor’s degree (BA, BSc, BEng)');
  for (const name of Object.keys(touched)) assert.equal(errors[name], undefined, `${name}: ${errors[name]}`);
  assert.deepEqual(await page.$$eval('#formik [role="alert"]', (l) => l.map((e) => e.textContent)), []);
  assert.deepEqual(report.unmatched, []);
  // The whole schema passes: Formik submits.
  assert.equal(await submit(page, '#formik button[type="submit"]', (x) => x.formik.submitted), true);
  assert.deepEqual((await state(page)).formik.errors, {});
  await page.close();
});

test(
  'Formik validated on blur only: the picked degree leaves no stale “Select your degree” behind',
  { todo: 'apply() changes a <select> without focusing and blurring it, so blur validation never runs' },
  async () => {
    const { page, s } = await fillPage('lib-forms.html?section=formik', STUDENT, '#fk-phone');
    assert.deepEqual(s.formik.errors, {});
    await page.close();
  },
);

test('react-imask (UK): +{44} 0000 000000, a DD/MM/YYYY date showing its empty slots, a postcode', async () => {
  const { page, report, s } = await fillPage('lib-forms.html?section=imask', STUDENT, '#im-phone');
  assert.equal(s.imask.phone, '+44 7386 526574', 'the trunk 0 is not dialled after +44');
  assert.equal(s.imask.phoneUnmasked, '447386526574');
  assert.equal(s.imask.dob, '15/03/2004', '"__/__/____" is an empty box, not an answer');
  assert.equal(s.imask.dobComplete, true);
  assert.equal(s.imask.postcode, 'G12 8QQ');
  assert.deepEqual(report.unmatched, []);
  await page.close();
});

test(
  'react-imask (US): (000) 000-0000 takes the national number',
  { todo: 'the mask reshapes "+1 415 555 0100" into "(141) 555-5010": needs format negotiation in apply()' },
  async () => {
    const { page, s } = await fillPage('lib-forms.html?section=imask&us', US, '#im-phone');
    assert.equal(s.imask.phone, '(415) 555-0100');
    await page.close();
  },
);

test('react-imask (US): an MM/DD/YYYY date and a ZIP code', async () => {
  const { page, s } = await fillPage('lib-forms.html?section=imask&us', US, '#im-phone');
  assert.equal(s.imask.dob, '12/10/1990');
  assert.equal(s.imask.postcode, '94105');
  await page.close();
});

test('react-phone-number-input preset to Italy: the number goes in as +44 and the country follows', async () => {
  const { page, report, s } = await fillPage('lib-forms.html?section=phone', STUDENT, '#mobile');
  assert.deepEqual(s.phone, { value: '+447386526574', country: 'GB' });
  assert.deepEqual(report.unmatched, []);
  await page.close();
  const us = await fillPage('lib-forms.html?section=phone', US, '#mobile');
  assert.deepEqual(us.s.phone, { value: '+14155550100', country: 'US' });
  await us.page.close();
});

test('HTML constraint validation: digits-only pattern with maxlength, email, url and date boxes are valid', async () => {
  for (const [profile, mobile, email, linkedin] of [
    [STUDENT, '07386526574', 'robin@example.com', 'https://www.linkedin.com/in/robin-li'],
    [US, '4155550100', 'ada@example.com', 'https://www.linkedin.com/in/ada'],
  ]) {
    const { page, s } = await fillPage('lib-forms.html?section=native', profile, '#nat-mobile');
    assert.deepEqual(s.native, {
      mobile: { value: mobile, valid: true },
      email: { value: email, valid: true },
      linkedin: { value: linkedin, valid: true },
      start: { value: '2026-11-02', valid: true },
    });
    assert.equal(await page.$eval('#native form', (f) => f.checkValidity()), true);
    await page.close();
  }
});

test('all of lib-forms.html at once: one phone format per box', async () => {
  const { page, report, s } = await fillPage('lib-forms.html', STUDENT, '#rhf-firstName');
  assert.equal(s.rhf.values.email, 'robin@example.com');
  assert.equal(digits(s.formik.values.phone), '447386526574');
  assert.equal(s.imask.phone, '+44 7386 526574');
  assert.equal(s.imask.dob, '15/03/2004');
  assert.deepEqual(s.phone, { value: '+447386526574', country: 'GB' });
  assert.equal(s.native.mobile.value, '07386526574');
  assert.deepEqual(report.unmatched, []);
  await page.close();
});

/* -------------------------------------------------------------------- lib-vue.html */

/** Element Plus marks a field that failed its rule with .is-error and shows the message under it. */
const shownErrors = (page) =>
  page.$$eval('.el-form-item.is-error', (items) =>
    items.map((i) => `${i.querySelector('label').textContent}: ${i.querySelector('.el-form-item__error').textContent}`),
  );

test('Element Plus (UK student): inputs, read-only / filterable / remote / multiple selects, radios, date', async () => {
  const { page, report, s } = await fillPage('lib-vue.html', STUDENT, '.el-form');
  const { form, validation } = s;
  assert.equal(form.firstName, 'Robin');
  assert.equal(form.lastName, 'Li');
  assert.equal(form.email, 'robin@example.com');
  assert.equal(digits(form.phone), '447386526574', form.phone);
  assert.equal(form.country, 'United Kingdom', 'filterable el-select');
  assert.equal(form.university, 'University of Glasgow', 'remote el-select (300 ms search)');
  assert.equal(form.degree, 'Bachelor’s degree', 'el-select whose input is read-only');
  assert.equal(form.graduation, '2027-06-01', 'el-date-picker: DD/MM/YYYY typed, YYYY-MM-DD kept');
  assert.deepEqual(form.locations, ['London', 'Edinburgh'], 'multiple el-select');
  assert.equal(form.sponsorship, 'No');
  assert.equal(form.relocate, 'Yes', 'el-radio-button');
  assert.equal(form.salary, 32000, 'el-input-number');
  assert.equal(form.privacy, true);
  for (const [prop, result] of Object.entries(validation)) assert.equal(result, true, `${prop}: ${result}`);
  assert.deepEqual(await shownErrors(page), []);
  assert.deepEqual(report.unmatched, []);
  // Every dropdown and the date panel are closed again.
  assert.equal(
    await page.$$eval('.el-popper', (l) => l.filter((p) => p.offsetParent && p.style.display !== 'none').length),
    0,
  );

  // Filling again changes nothing: a select's input stays empty, but its list marks the choice and its box shows it
  // (clicking "London" again would take it out of the multi-select). el-radio writes its checked attribute, so
  // the chosen "No" looks like the page's default and is "filled" again: a no-op, as it is already checked.
  const refill = await h.fill(page);
  assert.ok(refill.filled <= 1 && refill.failed === 0, JSON.stringify(refill));
  assert.deepEqual((await state(page)).form, form);
  // The form's own validation of every rule passes.
  assert.equal(await submit(page, '.el-form > .el-button', (x) => x.review), 'valid');
  await page.close();
});

test('Element Plus (US profile): the same form', async () => {
  const { page, report, s } = await fillPage('lib-vue.html', US, '.el-form');
  const { form, validation } = s;
  assert.equal(form.firstName, 'Ada');
  assert.equal(digits(form.phone), '14155550100');
  assert.equal(form.country, 'United States');
  assert.equal(form.university, 'University of Cambridge');
  assert.equal(form.degree, 'Bachelor’s degree');
  assert.equal(form.graduation, '2016-06-01');
  assert.equal(form.salary, 130000);
  for (const [prop, result] of Object.entries(validation)) assert.equal(result, true, `${prop}: ${result}`);
  assert.deepEqual(await shownErrors(page), []);
  assert.deepEqual(report.unmatched, []);
  // Only the question this profile has no answer for fails the form's own validation.
  assert.deepEqual(await submit(page, '.el-form > .el-button', (x) => x.review), ['locations']);
  await page.close();
});
