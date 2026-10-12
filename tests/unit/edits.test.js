'use strict';
// The settings page saves only its own edits, onto the profile as stored now (extension/options/edits.js, an ES module).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./helpers');

const { fields } = load();
// Imported from its source, as a data: URL is always an ES module (the file's own URL would make Node guess).
const source = fs.readFileSync(path.join(__dirname, '../../extension/options/edits.js'), 'utf8');
const edits = () => import('data:text/javascript,' + encodeURIComponent(source));

/** A profile with two education entries and two custom answers, as the settings page read it. */
function stored() {
  const p = fields.createProfile('Me');
  p.personal.firstName = 'Ada';
  p.skills = 'Python';
  p.education = [
    { ...fields.blankEducation(), school: 'University of Cambridge', degree: 'BSc' },
    { ...fields.blankEducation(), school: 'Imperial College London', degree: 'MSc' },
  ];
  p.customAnswers = [
    { id: 'a1', question: 'clearance', answer: 'No' },
    { id: 'a2', question: 'weekends', answer: 'Yes' },
  ];
  return p;
}

test('a value edited here goes onto what was saved elsewhere meanwhile, which stays', async () => {
  const { mergeEdits } = await edits();
  const base = stored();
  // Settings: a middle name. Popup › Learn from this page, meanwhile: skills and a new custom answer.
  const mine = structuredClone(base);
  mine.personal.middleName = 'Augusta';
  const theirs = structuredClone(base);
  theirs.skills = 'Python, Haskell';
  theirs.customAnswers.push({ id: 'learned', question: 'favourite engine', answer: 'Analytical' });
  const out = mergeEdits(base, mine, theirs);
  assert.equal(out.personal.middleName, 'Augusta');
  assert.equal(out.personal.firstName, 'Ada');
  assert.equal(out.skills, 'Python, Haskell');
  assert.deepEqual(
    out.customAnswers.map((a) => a.id),
    ['a1', 'a2', 'learned'],
  );
  // Nothing edited here: exactly what is stored. Nothing changed there: exactly the page's copy.
  assert.equal(mergeEdits(base, structuredClone(base), theirs), theirs);
  assert.equal(mergeEdits(base, mine, structuredClone(base)), mine);
});

test('a value both changed is this page’s, the one the person sees', async () => {
  const { mergeEdits } = await edits();
  const base = stored();
  const mine = structuredClone(base);
  mine.skills = 'Python, SQL';
  const theirs = structuredClone(base);
  theirs.skills = 'Python, Haskell';
  theirs.personal.lastName = 'Lovelace';
  const out = mergeEdits(base, mine, theirs);
  assert.equal(out.skills, 'Python, SQL');
  assert.equal(out.personal.lastName, 'Lovelace');
});

test('custom answers go by id: removed, edited and added on either side', async () => {
  const { mergeEdits } = await edits();
  const base = stored();
  // Here: "clearance" removed, "weekends" reworded, one added.
  const mine = structuredClone(base);
  mine.customAnswers.splice(0, 1);
  mine.customAnswers[0].answer = 'Yes, most weekends';
  mine.customAnswers.push({ id: 'mine', question: 'notice', answer: 'Two weeks' });
  // Elsewhere: "clearance" answered anew (Learn's "replaces"), "weekends"' question changed, one added.
  const theirs = structuredClone(base);
  theirs.customAnswers[0].answer = 'SC';
  theirs.customAnswers[1].question = 'weekends | saturdays';
  theirs.customAnswers.push({ id: 'theirs', question: 'relocate', answer: 'Yes' });
  const out = mergeEdits(base, mine, theirs);
  assert.deepEqual(out.customAnswers, [
    { id: 'a2', question: 'weekends | saturdays', answer: 'Yes, most weekends' },
    { id: 'mine', question: 'notice', answer: 'Two weeks' },
    { id: 'theirs', question: 'relocate', answer: 'Yes' },
  ]);
  // An answer removed elsewhere stays removed unless this page changed it.
  const gone = structuredClone(base);
  gone.customAnswers.splice(1, 1);
  const edited = structuredClone(base);
  edited.personal.firstName = 'Augusta Ada';
  assert.deepEqual(
    mergeEdits(base, edited, gone).customAnswers.map((a) => a.id),
    ['a1'],
  );
});

test('education entries moved here keep what was filled in elsewhere, by where each one came from', async () => {
  const { mergeEdits } = await edits();
  const base = stored();
  // Here: the two entries swapped (↑ on the second). The page knows where each entry object came from.
  const mine = structuredClone(base);
  const from = new Map([
    [mine.education[0], 0],
    [mine.education[1], 1],
  ]);
  mine.education.reverse();
  // Elsewhere (Learn from this page): Cambridge's empty location filled in.
  const theirs = structuredClone(base);
  theirs.education[0].location = 'Cambridge, UK';
  const out = mergeEdits(base, mine, theirs, (entry) => from.get(entry));
  assert.deepEqual(
    out.education.map((e) => [e.school, e.location]),
    [
      ['Imperial College London', ''],
      ['University of Cambridge', 'Cambridge, UK'],
    ],
  );
  // An entry added here is kept as it is, beside an edit made elsewhere to one already there.
  const added = structuredClone(base);
  added.education.push({ ...fields.blankEducation(), school: 'Open University' });
  const out2 = mergeEdits(base, added, theirs);
  assert.deepEqual(
    out2.education.map((e) => e.school),
    ['University of Cambridge', 'Imperial College London', 'Open University'],
  );
  assert.equal(out2.education[0].location, '', 'without where each entry came from, the page’s list as it is');
  // Edited in place here, by place: both edits land.
  const inPlace = structuredClone(base);
  inPlace.education[1].gpa = 'Distinction';
  const out3 = mergeEdits(base, inPlace, theirs);
  assert.deepEqual(
    out3.education.map((e) => [e.location, e.gpa]),
    [
      ['Cambridge, UK', ''],
      ['', 'Distinction'],
    ],
  );
});

test('same() compares stored values, not object identity or key order', async () => {
  const { same } = await edits();
  assert.ok(same({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }));
  assert.ok(same({ a: 1, gone: undefined }, { a: 1 }));
  assert.ok(!same({ a: 1 }, { a: '1' }));
  assert.ok(!same([1, 2], [2, 1]));
  assert.ok(!same(null, {}));
});
