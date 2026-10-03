'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers');

const JTF = load();
require('../../extension/lib/ai.js');
require('../../extension/lib/assist.js');
const { assist, fields, store } = JTF;

const profile = fields.upgradeProfile({
  personal: { firstName: 'Ada', lastName: 'Lovelace' },
  contact: { email: 'ada@example.com' },
  extraDetails: 'I have no involvement with any government, political party or public office. Notice period: none.',
});
profile.vault = { password: 'hunter2-secret' };
profile.cc = { number: '4111111111111111' };

const F = (id, label, extra) => ({ id, kind: 'text', inputType: 'text', label, ...extra });
const fieldsList = [
  F('0', 'Are you or a close relative a politically exposed person?', {
    kind: 'radio',
    inputType: 'radio',
    options: ['Yes', 'No'],
  }),
  F('1', 'Password', { inputType: 'password' }),
  F('2', 'Card number', { name: 'cardnumber' }),
  F('3', 'I agree to the terms and conditions', { kind: 'radio', options: ['Yes', 'No'] }),
  F('4', 'Preferred contact method', { kind: 'select', inputType: 'select', options: ['Email', 'Phone'] }),
  F('5', 'Social security number'),
  F('6', 'Personal website', { inputType: 'url' }),
  F('7', 'Subscribe to our newsletter?', { kind: 'radio', options: ['Yes', 'No'] }),
];

test('prompt includes extra details and the eligible fields only, never secrets', () => {
  const req = assist.buildRequest(fieldsList, profile);
  assert.deepEqual(req.ids, ['0', '4', '6']);
  const text = req.messages.map((m) => m.content).join('\n');
  assert.match(text, /no involvement with any government/);
  assert.match(text, /politically exposed/);
  for (const secret of ['hunter2', '4111', 'Password', 'Card number', 'Social security', 'newsletter'])
    assert.ok(!text.includes(secret), secret);
  assert.match(text, /"email":"ada@example.com"/);
});

test('nothing to ask means no request', () => {
  assert.equal(assist.buildRequest([fieldsList[1], fieldsList[2]], profile), null);
});

test('answers are validated: invalid options, low confidence, shape and length', async () => {
  const sent = [];
  const chat = async (config, opts) => {
    sent.push(opts);
    return {
      json: {
        0: { answer: 'no', confidence: 0.9, source: 'extraDetails' },
        4: { answer: 'Carrier pigeon', confidence: 0.95, source: 'x' },
        6: { answer: 'not a url', confidence: 0.9, source: 'x' },
        1: { answer: 'hunter2', confidence: 1, source: 'x' },
      },
    };
  };
  const out = await assist.run({ fields: fieldsList, profile, config: {}, chat });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].json, true);
  assert.deepEqual(Object.keys(out.answers), ['0']);
  assert.equal(out.answers['0'].answer, 'No');
  const reasons = Object.fromEntries(out.dropped.map((d) => [d.id, d.reason]));
  assert.equal(reasons['4'], 'not an offered option');
  assert.equal(reasons['6'], 'not a URL');
});

test('null, low-confidence and over-long answers are dropped', () => {
  const t = F('9', 'Short bio', { maxLength: 10 });
  assert.ok(assist.validate(t, { answer: null, confidence: 1 }).drop);
  assert.ok(assist.validate(t, { answer: 'hello', confidence: 0.3 }).drop);
  assert.ok(assist.validate(t, { answer: 'far too long for the box', confidence: 1 }).drop);
  assert.equal(assist.validate(t, { answer: 'hello', confidence: 0.8 }).answer, 'hello');
  assert.ok(assist.validate(F('a', 'Email', { inputType: 'email' }), { answer: 'nope', confidence: 1 }).drop);
});

test('a batch is capped', () => {
  const many = Array.from({ length: 60 }, (_, i) => F(String(i), `Question ${i}`));
  assert.equal(assist.buildRequest(many, profile).ids.length, assist.MAX_FIELDS);
});

test('extraDetails survives save, export and import', async () => {
  const { profile: p } = await store.getActive();
  p.extraDetails = 'No criminal convictions.';
  await store.saveProfile(p);
  const exported = await store.exportData();
  assert.equal(exported.profiles[p.id].extraDetails, 'No criminal convictions.');
  await store.importData(JSON.parse(JSON.stringify(exported)));
  assert.equal((await store.getActive()).profile.extraDetails, 'No criminal convictions.');
});
