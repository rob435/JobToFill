// End-to-end: Bain's Avature portal. The "Upload Resume: From Device" step, whose hidden file box only counts once the
// button has opened it, and the application's sponsorship and diversity questions.
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

test('Avature’s "From Device": the CV goes in through the button, so the page shows it and Continue takes it', async () => {
  const page = await h.open('avature-resume.html');
  const r = await h.fill(page);
  assert.equal(r.error, undefined);
  assert.equal(await page.$eval('#resumeFile', (el) => el.files[0] && el.files[0].name), 'ada_cv.pdf');
  assert.equal((await state(page)).opened, 1, 'opened once, through its button');
  assert.equal(await text(page, '#fileNameContainer'), 'ada_cv.pdf');
  assert.ok(await page.$eval('#methodButton--fileFieldSetContainer', (el) => el.style.display !== 'none'));
  // A second fill leaves it be.
  await h.fill(page);
  assert.equal((await state(page)).opened, 1);
  await page.click('#checkBoxfile');
  await page.click('#uploadFileResume');
  assert.equal((await state(page)).mode, 'file');
  await page.close();
});

test('Bain’s application: sponsorship for the office’s country, and diversity answers defaulting to No', async () => {
  const original = await h.profile();
  // A British student in London who left the diversity questions blank, apart from an Asian ethnicity.
  await h.setProfile({
    personal: { nationality: 'British' },
    address: { city: 'London', state: '', postalCode: 'SW1A 1AA', country: 'United Kingdom' },
    eeo: { race: 'Asian – Chinese', sexualOrientation: '', parentsDegree: '', parentOccupation: '' },
  });
  try {
    const page = await h.open('avature-eeo.html');
    const r = await h.fill(page);
    assert.equal(r.error, undefined);
    const s = await state(page);
    assert.deepEqual(s.sponsorship, ['No'], 'the visas are examples; the office is in London');
    assert.deepEqual(s.ethnicity, [
      'Asian (inclusive of Northeast Asian, Southeast Asian, Southern and Central Asian)',
    ]);
    assert.deepEqual(s.lgbt, ['No']);
    assert.deepEqual(s.firstGen, ['No']);
    assert.deepEqual(s.lowerSes, ['No']);
    assert.deepEqual(s.organisations, ['Prefer not to say']);
    await page.close();

    // Mixed heritage on a "select all that apply" list without a mixed option: both groups.
    await h.setProfile({ eeo: { race: 'Mixed – White and Asian' } });
    const mixed = await h.open('avature-eeo.html');
    await h.fill(mixed);
    assert.deepEqual((await state(mixed)).ethnicity, [
      'Asian (inclusive of Northeast Asian, Southeast Asian, Southern and Central Asian)',
      'White',
    ]);
    await mixed.close();
  } finally {
    await h.setProfile({ personal: original.personal, address: original.address, eeo: original.eeo });
  }
});
