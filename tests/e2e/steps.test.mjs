// End-to-end: applications in steps (Workday's My Information → My Experience → Application Questions → Review): a
// section's own "Add" for each of your entries, and (Settings › "Move through multi-step applications for me") the
// step's own "Save and Continue" once it is done, never the Review step's "Submit". Chromium or Firefox.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PROFILE, launch, text, until, value } from './harness.mjs';

let h;

before(async () => {
  h = await launch();
  await h.setProfile(PROFILE);
});

after(() => h.close());

const state = async (page) => JSON.parse(await text(page, '#state'));
/** Wait for the application to reach step `n` (a fill moves on by itself, in the background). */
const reaches = (page, n) =>
  until(
    (fn, arg) => page.$eval('#state', fn, arg),
    (el, k) => JSON.parse(el.textContent).step === k,
    n,
    30000,
  );

test('auto-advance is off unless switched on: the step is filled, nothing is clicked', async () => {
  const page = await h.open('workday-steps.html');
  const r = await h.fill(page);
  assert.equal(r.error, undefined);
  assert.equal(await value(page, '#first'), 'Ada');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const s = await state(page);
  assert.equal(s.step, 1, 'still on My Information');
  assert.equal(s.submitted, false);
  await page.close();
});

test('My Experience: a section’s own "Add" once per entry of yours, then each entry filled', async () => {
  const page = await h.open('workday-steps.html?start=2');
  const r = await h.fill(page);
  assert.equal(r.error, undefined);
  const s = await state(page);
  assert.equal(s.experience, 2, 'two jobs in the profile: two entries');
  assert.equal(s.education, 1, 'one school: one entry');
  assert.equal(await value(page, '#we-1-company'), 'Analytical Engines Inc');
  assert.equal(await value(page, '#we-2-company'), 'Babbage Labs');
  assert.equal(await value(page, '#ed-1-school'), 'University of Cambridge');
  // Filled again, nothing more is added.
  await h.fill(page);
  assert.deepEqual([(await state(page)).experience, (await state(page)).education], [2, 1]);
  await page.close();
});

test('with it on: each step filled and continued, up to the Review step, which is never submitted', async () => {
  await h.setSettings({ autoAdvance: true });
  try {
    const page = await h.open('workday-steps.html');
    const r = await h.fill(page);
    assert.equal(r.error, undefined);
    assert.ok(
      r.notes.some((n) => /Clicking “Save and Continue”/.test(n)),
      JSON.stringify(r.notes),
    );
    await reaches(page, 4);
    // The Review step's own fill reports it is the last; give it a moment to be sure nothing presses "Submit".
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const s = await state(page);
    assert.equal(s.step, 4);
    assert.equal(s.submitted, false, 'the application is never submitted');
    assert.equal(s.values.first, 'Ada');
    assert.equal(s.values.source, 'LinkedIn');
    assert.equal(s.values['we-2-company'], 'Babbage Labs');
    assert.equal(s.values['ed-1-school'], 'University of Cambridge');
    assert.equal(s.values.auth, 'Yes');
    assert.equal(s.values.spons, 'No');
    await page.close();
  } finally {
    await h.setSettings({ autoAdvance: false });
  }
});

test('with it on: a required question left empty stops it on that step', async () => {
  await h.setSettings({ autoAdvance: true });
  try {
    const page = await h.open('workday-steps.html?values=1');
    await h.fill(page);
    await reaches(page, 3);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const s = await state(page);
    assert.equal(s.step, 3, 'stopped at Application Questions');
    assert.equal(await page.$eval('#errors', (e) => e.textContent), '', 'never pressed with the essay empty');
    assert.equal(await value(page, '#auth'), 'Yes', 'the rest of the step is filled');
    assert.equal(s.submitted, false);
    await page.close();
  } finally {
    await h.setSettings({ autoAdvance: false });
  }
});
