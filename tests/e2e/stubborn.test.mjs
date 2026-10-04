// End-to-end: boxes that don't simply keep what is set from script. The fill reads back what it wrote once the page
// has settled, writes it again another way where it didn't hold, and lists what the page still turns down.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PROFILE, launch, value } from './harness.mjs';

let h;

before(async () => {
  h = await launch();
  await h.setProfile(PROFILE);
});

after(() => h.close());

test('typed, pasted, reformatted, re-made and refused boxes', async () => {
  const page = await h.open('stubborn.html');
  const r = await h.fill(page);
  assert.equal(r.error, undefined);
  const state = JSON.parse(await page.$eval('#state', (el) => el.textContent));
  assert.equal(state.first, 'Ada', 'a box that only keeps keys gets them');
  assert.equal(state.last, 'Lovelace', 'a box that only takes a paste gets one');
  assert.equal(state.mobile, '4155550100', 'digits only, as its pattern says');
  assert.equal(await page.$eval('#mobile', (el) => el.validity.valid), true);
  assert.equal(state.dob, '1990-12-10', 'the date written the way its message asks');
  assert.equal(await page.$eval('#dob', (el) => el.getAttribute('aria-invalid')), 'false');
  assert.equal(state.city, 'San Francisco', 'the re-made box gets its answer again');
  assert.equal(state.zip, '94105', 'the emptied box gets its answer again');
  assert.match(state.linkedin, /^(www\.)?linkedin\.com\/in\/ada$/, 'the link without its scheme');
  assert.equal(state.source, 'LinkedIn', 'the select put back is chosen again');
  assert.equal(state.start, '11/02/2026');
  assert.equal(
    await page.$eval('#calendar', (el) => el.style.display),
    'none',
    'a calendar that fades in from nothing is closed again',
  );
  assert.equal(await value(page, '#source'), 'LinkedIn');
  // Nothing in a US profile satisfies "UK numbers only": that one is left to check, with what the page says.
  assert.deepEqual(r.check, ['Phone (“Please enter a UK mobile number starting with +44”)']);
  assert.ok(r.repaired >= 4, `repaired ${r.repaired}`);
  assert.match(
    await page.$eval('#phone2', (el) => el.style.outline),
    /220, 38, 38/,
    'the box to check is outlined in red',
  );
});
