'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, desc, opts } = require('./helpers');

const { decide, fields } = load();
const score = import('../bench/score.mjs');

test('bench: keys survive a re-read, a question asked twice is told apart', async () => {
  const { keysOf } = await score;
  assert.deepEqual(
    keysOf([{ question: 'Start date' }, { question: ' start  DATE ' }, { question: '', kind: 'file' }]),
    ['start date', 'start date#2', '(file)'],
  );
});

test('bench: a wrong value is worse than a field left empty, and the AI or you is only a routing slip', async () => {
  const { verdict } = await score;
  const fill = (text) => ({ outcome: 'fill', text });
  assert.equal(verdict({ fill: 'University College London' }, fill('university  college london')), 'right');
  assert.equal(verdict({ fill: ['+44 7700 900123', '07700 900123'] }, fill('07700 900123')), 'right');
  assert.equal(verdict({ fill: 'London' }, fill('Walsall')), 'wrong');
  assert.equal(verdict({ empty: true }, fill('Yes')), 'wrong');
  assert.equal(verdict({ fill: 'London' }, { outcome: 'ai' }), 'missed');
  assert.equal(verdict({ ai: true }, { outcome: 'empty' }), 'routed');
  assert.equal(verdict({ blank: true }, { outcome: 'empty' }), 'right');
  assert.equal(verdict({ skip: true }, fill('x')), 'unscored');
  assert.equal(verdict(null, fill('x')), 'unscored');
});

test('bench: a form scored from the rules’ own decisions, and what changed since a run before', async () => {
  const { outcomeOf, scoreForm, total, compare } = await score;
  const p = fields.createProfile('Test');
  Object.assign(p.personal, { firstName: 'Alex', lastName: 'Morgan' });
  p.job.sponsorship = 'No';
  const descs = [
    desc('First Name'),
    desc({ question: 'Do you require sponsorship?' }, { kind: 'radio', options: opts('Yes', 'No') }),
    desc('Why us?', { kind: 'textarea' }),
  ];
  const got = decide.page(descs, p).map((e, i) => ({
    question: descs[i].signals.label || descs[i].signals.question,
    kind: descs[i].kind,
    got: outcomeOf(e),
  }));
  const expected = [
    { key: 'first name', expect: { fill: 'Alex' } },
    { key: 'do you require sponsorship?', expect: { fill: 'Yes' } },
    { key: 'why us?', expect: { ai: true } },
    { key: 'gone', expect: { fill: 'x' } },
  ];
  const form = scoreForm(got, expected);
  assert.deepEqual(form.counts, { right: 2, wrong: 1, missed: 0, routed: 0, unscored: 0 });
  assert.deepEqual(form.lost, ['gone']);
  assert.equal(total([form]).score, 2 / 3);
  const before = { forms: [{ id: 'a', ...form }] };
  const fixed = scoreForm(
    got,
    expected.map((e) => (e.key === 'do you require sponsorship?' ? { ...e, expect: { fill: 'No' } } : e)),
  );
  const d = compare(before, { forms: [{ id: 'a', ...fixed }] });
  assert.deepEqual([d.better.length, d.worse.length], [1, 0]);
});
