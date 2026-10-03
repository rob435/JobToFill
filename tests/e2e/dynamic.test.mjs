// End-to-end: forms that change under the fill: lists whose options follow an earlier answer, and a form drawn
// only after the page has loaded.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PROFILE, launch, selectedText, value } from './harness.mjs';

let h;

before(async () => {
  h = await launch();
  await h.setProfile(PROFILE);
});

after(() => h.close());

test('a list fetched once an earlier answer is in is filled when its options arrive', async () => {
  const page = await h.open('cascade.html');
  const r = await h.fill(page);
  assert.equal(r.error, undefined);
  assert.equal(await selectedText(page, '#school-country'), 'United Kingdom');
  assert.equal(await selectedText(page, '#school'), 'University of Cambridge');
  assert.equal(await selectedText(page, '#level'), "Bachelor's");
  assert.equal(await selectedText(page, '#discipline'), 'Mathematics');
  assert.deepEqual(r.unmatched, [], 'nothing left unmatched once the lists filled in');
  assert.equal(r.failed, 0);
});

test('a form drawn after the page loads is waited for', async () => {
  const page = await h.open('late-form.html');
  const r = await h.fill(page);
  assert.equal(r.error, undefined);
  assert.equal(await value(page, '#first'), 'Ada');
  assert.equal(await value(page, '#last'), 'Lovelace');
  assert.equal(await value(page, '#email'), 'ada@example.com');
});
