'use strict';
// The settings page's "Get started" checklist (extension/options/setup.js, an ES module).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./helpers');

const { fields } = load();
// Imported from its source, as a data: URL is always an ES module (the file's own URL would make Node guess).
const source = fs.readFileSync(path.join(__dirname, '../../extension/options/setup.js'), 'utf8');
const setup = () => import('data:text/javascript,' + encodeURIComponent(source));
const doneOf = (steps) => Object.fromEntries(steps.map((s) => [s.id, s.done]));

test('a new profile has every step left, the AI key and inbox optional', async () => {
  const { setupSteps, setupComplete } = await setup();
  const steps = setupSteps({ profile: fields.createProfile('Me'), pinned: false });
  assert.deepEqual(
    steps.map((s) => s.id),
    ['contact', 'cv', 'education', 'ai', 'inbox', 'toolbar'],
  );
  assert.ok(steps.every((s) => !s.done));
  assert.deepEqual(
    steps.filter((s) => s.optional).map((s) => s.id),
    ['ai', 'inbox'],
  );
  assert.ok(steps.filter((s) => s.href).every((s) => /^#[a-z]+$/.test(s.href)));
  assert.equal(setupComplete(steps), false);
});

test('steps are done as the profile and settings fill in', async () => {
  const { setupSteps, setupComplete } = await setup();
  const profile = fields.createProfile('Me');
  profile.personal.firstName = 'Ada';
  profile.contact.email = 'ada@example.com';
  assert.equal(doneOf(setupSteps({ profile })).contact, false, 'a last name is needed too');
  profile.personal.lastName = 'Lovelace';
  profile.education = [fields.blankEducation(), { ...fields.blankEducation(), school: 'University of Glasgow' }];
  let steps = setupSteps({ profile, resume: true, pinned: true });
  assert.deepEqual(doneOf(steps), { contact: true, cv: true, education: true, ai: false, inbox: false, toolbar: true });
  assert.equal(setupComplete(steps), true, 'the optional steps can wait');
  steps = setupSteps({ profile, resume: true, aiKey: true, inbox: true, pinned: true });
  assert.ok(steps.every((s) => s.done));
  profile.personal.firstName = '   ';
  assert.equal(doneOf(setupSteps({ profile })).contact, false, 'blank is not filled in');
});

test('when the browser can’t tell whether the button is pinned, that step doesn’t hold the list open', async () => {
  const { setupSteps, setupComplete } = await setup();
  const profile = fields.createProfile('Me');
  Object.assign(profile.personal, { firstName: 'Ada', lastName: 'Lovelace' });
  profile.contact.email = 'ada@example.com';
  profile.education = [{ ...fields.blankEducation(), school: 'Cambridge' }];
  assert.equal(setupComplete(setupSteps({ profile, resume: true, pinned: false })), false);
  const unknown = setupSteps({ profile, resume: true, pinned: null });
  assert.equal(unknown.find((s) => s.id === 'toolbar').optional, true);
  assert.equal(setupComplete(unknown), true);
  assert.equal(setupComplete(setupSteps({})), false, 'nothing loaded yet');
});
