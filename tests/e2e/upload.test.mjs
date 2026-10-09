// Sites that read an uploaded CV and rewrite the form afterwards (Breezy, Lever): the fill uploads
// first, waits for the page to settle, and fills back anything the parse cleared.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PROFILE, RESUME_PDF, launch, value } from './harness.mjs';

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

test('a CV parse that wipes the form afterwards does not lose the answers', async () => {
  const page = await h.open('cv-parse.html');
  const summary = await h.fill(page);
  assert.equal(await page.$eval('#status', (el) => el.textContent), 'Done', 'the parse ran');
  assert.equal(await page.$eval('#resume', (el) => el.files[0] && el.files[0].name), 'ada_cv.pdf');
  assert.equal(await value(page, '#first'), 'Ada');
  assert.equal(await value(page, '#last'), 'Lovelace');
  assert.equal(await value(page, '#email'), 'ada@example.com', 'the re-rendered box is filled too');
  assert.equal(await value(page, '#city'), 'San Francisco');
  assert.ok(summary.filled >= 5);
  await page.close();
});

test('Eploy: an "Upload CV" that opens a dialog with its own Upload File button is closed again, the form filled', async () => {
  const page = await h.open('eploy.html');
  const summary = await h.fill(page);
  assert.equal(summary.error, undefined);
  const s = JSON.parse(await page.$eval('#state', (el) => el.textContent));
  assert.deepEqual(s, {
    forenames: 'Ada',
    surname: 'Lovelace',
    email: 'ada@example.com',
    cv: 'No file uploaded', // never sent for you: its "Upload File" button is yours to press
    dialog: false, // and the dialog isn't left over the form
  });
  await page.close();
});
