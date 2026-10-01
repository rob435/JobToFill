'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, installChrome } = require('./helpers');

const JTF = load();
const { vault, store, geo, util } = JTF;

test.beforeEach(() => installChrome());

test('vault: encrypt / decrypt round trip, wrong key fails', async () => {
  const salt = new Uint8Array(16);
  const key = await vault.deriveKey('correct horse', salt, 1000);
  const blob = await vault.encryptJson(key, { hello: 'world' });
  assert.deepEqual(await vault.decryptJson(key, blob), { hello: 'world' });
  const wrong = await vault.deriveKey('wrong horse', salt, 1000);
  await assert.rejects(vault.decryptJson(wrong, blob));
  assert.ok(!JSON.stringify(blob).includes('world'));
});

test('vault: setup, lock, unlock, update, change password, reset', async () => {
  assert.equal(await vault.status(), 'none');
  await assert.rejects(vault.setup('short'), /at least 8/);
  await vault.setup('master password 1', { iterations: 1000 });
  assert.equal(await vault.status(), 'unlocked');
  await vault.update((d) => {
    d.credentials.push({ id: 'c1', host: 'acme.myworkdayjobs.com', username: 'ada', password: 'pw1' });
  });
  const stored = JSON.stringify(await chrome.storage.local.get('vault'));
  assert.ok(!stored.includes('pw1'), 'secrets are not stored in plain text');

  await vault.lock();
  assert.equal(await vault.status(), 'locked');
  await assert.rejects(vault.read(), /locked/);
  await assert.rejects(vault.unlock('nope'), /Wrong master password/);
  await vault.unlock('master password 1');
  assert.equal((await vault.read()).credentials[0].password, 'pw1');

  await vault.changePassword('master password 2');
  await vault.lock();
  await assert.rejects(vault.unlock('master password 1'));
  await vault.unlock('master password 2');
  assert.equal((await vault.read()).credentials.length, 1);

  await vault.reset();
  assert.equal(await vault.status(), 'none');
});

test('vault: auto-lock after inactivity', async () => {
  await vault.setup('master password 1', { iterations: 1000 });
  assert.equal(await vault.autoLock(30), false);
  await chrome.storage.session.set({ vaultLastUsed: Date.now() - 31 * 60000 });
  assert.equal(await vault.autoLock(0), false, '0 means never');
  assert.equal(await vault.autoLock(30), true);
  assert.equal(await vault.status(), 'locked');
});

test('vault: credential lookup prefers the most specific host', () => {
  const data = {
    credentials: [
      { host: 'example.com', password: 'a' },
      { host: 'careers.example.com', password: 'b' },
      { host: 'other.com', password: 'c' },
    ],
  };
  assert.equal(vault.findCredential(data, 'careers.example.com').password, 'b');
  assert.equal(vault.findCredential(data, 'jobs.example.com').password, 'a');
  assert.equal(vault.findCredential(data, 'www.other.com').password, 'c');
  assert.equal(vault.findCredential(data, 'notexample.com'), null);
});

test('password generator', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const pw = vault.generatePassword();
    assert.equal(pw.length, 20);
    assert.match(pw, /[a-z]/);
    assert.match(pw, /[A-Z]/);
    assert.match(pw, /[0-9]/);
    assert.match(pw, /[!@#$%^&*\-_=+?]/);
    seen.add(pw);
  }
  assert.equal(seen.size, 200);
  assert.doesNotMatch(vault.generatePassword({ length: 32, symbols: false }), /[^A-Za-z0-9]/);
});

test('store: first profile is created once even with concurrent readers', async () => {
  await Promise.all([store.loadAll(), store.loadAll(), store.getActive()]);
  const { order, settings } = await store.loadAll();
  assert.equal(order.length, 1);
  assert.equal(settings.activeProfileId, order[0]);
});

test('store: concurrent saves do not drop each other', async () => {
  const { profile } = await store.getActive();
  const b = await store.createProfile('Second');
  await Promise.all([
    store.saveProfile(Object.assign({}, profile, { skills: 'one' })),
    store.saveProfile(Object.assign({}, b, { skills: 'two' })),
  ]);
  const all = await store.loadAll();
  assert.equal(all.profiles[profile.id].skills, 'one');
  assert.equal(all.profiles[b.id].skills, 'two');
  await store.deleteProfile(b.id);
  await assert.rejects(store.deleteProfile(profile.id), /at least one/);
});

test('store: profiles are upgraded to the current schema', async () => {
  await chrome.storage.local.set({
    profiles: { old: { id: 'old', name: 'Old', personal: { firstName: 'Ada' }, education: [{ school: 'X' }] } },
    profileOrder: ['old'],
  });
  const { profile } = await store.getActive();
  assert.equal(profile.personal.firstName, 'Ada');
  assert.equal(profile.personal.lastName, '');
  assert.equal(profile.education[0].school, 'X');
  assert.equal(profile.education[0].degree, '');
  assert.deepEqual(profile.customAnswers, []);
});

test('store: history merges refills of the same page', async () => {
  await store.addHistory({ url: 'https://a.example/apply', host: 'a.example', title: 'A', filled: 5 });
  await store.addHistory({ url: 'https://a.example/apply', host: 'a.example', title: 'A', filled: 3 });
  await store.addHistory({ url: 'https://b.example/apply', host: 'b.example', title: 'B', filled: 7 });
  const h = await store.getHistory();
  assert.equal(h.length, 2);
  assert.equal(h[0].host, 'b.example');
  assert.equal(h[1].filled, 5);
});

test('store: export / import round trip with documents', async () => {
  const { profile } = await store.getActive();
  profile.personal.firstName = 'Grace';
  await store.saveProfile(profile);
  await store.setDoc(profile.id, 'resume', {
    name: 'cv.pdf',
    type: 'application/pdf',
    size: 3,
    dataUrl: 'data:application/pdf;base64,AAAA',
  });
  assert.deepEqual((await store.docInfo(profile.id)).resume.name, 'cv.pdf');
  const backup = JSON.parse(JSON.stringify(await store.exportData()));

  installChrome();
  await assert.rejects(store.importData({ nope: true }), /not a JobToFill backup/);
  await store.importData(backup);
  const { profile: restored } = await store.getActive();
  assert.equal(restored.personal.firstName, 'Grace');
  assert.equal((await store.getDoc(restored.id, 'resume')).name, 'cv.pdf');
});

test('geo and util helpers', () => {
  assert.equal(geo.findCountry('U.S.A.')[0], 'US');
  assert.equal(geo.findCountry('Deutschland')[0], 'DE');
  assert.equal(geo.findCountry('Atlantis'), null);
  assert.deepEqual(geo.regionCandidates('tx', 'US').slice(1), ['Texas', 'TX']);
  assert.equal(util.normalize('LinkedIn URL*'), 'linked in url');
  assert.equal(util.normalize('ZIPCode'), 'zip code');
  assert.equal(util.normalize('Prénom'), 'prenom');
  assert.deepEqual(util.parseDate('2020-05'), { year: 2020, month: 5, day: null });
  assert.deepEqual(util.parseDate('05/2020'), { year: 2020, month: 5, day: null });
  assert.equal(util.cleanLabel('  First   Name * '), 'First Name');
  assert.ok(util.hostMatches('boards.greenhouse.io', 'greenhouse.io'));
  assert.ok(!util.hostMatches('evilgreenhouse.io', 'greenhouse.io'));
});
