// End-to-end: long answers in rich-text editors (Quill, TipTap/ProseMirror, Lexical, a bare contenteditable box).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PROFILE, launch } from './harness.mjs';

let h;

before(async () => {
  h = await launch();
  await h.setProfile({
    ...PROFILE,
    coverLetter: 'Dear hiring team,\n\nI would love to join your analyst programme.\n\nAda Lovelace',
  });
});

after(() => h.close());

const state = async (page) => JSON.parse(await page.$eval('#state', (el) => el.textContent));

test('editors get their answers, paragraphs kept, and Undo takes them back', async () => {
  const page = await h.open('editors.html');
  const r = await h.fill(page);
  assert.equal(r.error, undefined);
  const s = await state(page);
  assert.equal(s.name, 'Ada Lovelace');
  assert.match(s.coverLetter, /^Dear hiring team,\n+I would love to join your analyst programme\.\n+Ada Lovelace$/);
  assert.equal(
    await page.$eval('#quill .ql-editor', (el) => el.querySelectorAll('p').length >= 3),
    true,
    'paragraphs stay paragraphs',
  );
  assert.equal(s.why, 'I love engines.');
  assert.equal(s.summary, 'Engineer and mathematician.');
  assert.equal(s.skills, 'Python, SQL, Mathematics');
  assert.deepEqual(r.check, []);

  await h.handler('jtf:undo', page);
  const after = await state(page);
  assert.equal(after.coverLetter, '');
  assert.equal(after.why, '');
  assert.equal(after.summary, '');
});
