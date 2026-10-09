'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, installChrome } = require('./helpers');

const JTF = load();
const { passwords, store, geo, util } = JTF;

test.beforeEach(() => installChrome());

test('passwords: plain JSON in storage, read with defaults, updated in place', async () => {
  assert.deepEqual(await passwords.read(), {
    version: 1,
    defaultPassword: '',
    credentials: [],
    cards: [],
    defaultCardId: null,
  });
  await passwords.update((d) => {
    d.credentials.push({ id: 'c1', host: 'acme.myworkdayjobs.com', username: 'ada', password: 'pw1' });
  });
  // Two saves at once both land.
  await Promise.all([
    passwords.update((d) => (d.defaultPassword = 'Default-1')),
    passwords.update((d) => d.cards.push({ id: 'k1', number: '4242424242424242' })),
  ]);
  const { passwords: stored } = await chrome.storage.local.get('passwords');
  assert.equal(stored.credentials[0].password, 'pw1', 'kept as it is, like the API keys');
  assert.equal(stored.defaultPassword, 'Default-1');
  assert.equal(stored.cards.length, 1);
  assert.equal(await passwords.legacy(), false);
});

// The encrypted vault older versions wrote: PBKDF2-SHA256 from the master password, AES-256-GCM.
async function oldVault(master, data) {
  const { subtle } = globalThis.crypto;
  const b64 = (bytes) => Buffer.from(bytes).toString('base64');
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const iterations = 1000;
  const base = await subtle.importKey('raw', new TextEncoder().encode(master), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(data)));
  return {
    blob: {
      version: 1,
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: b64(salt) },
      data: { iv: b64(iv), ct: b64(new Uint8Array(ct)) },
      createdAt: 1,
      updatedAt: 1,
    },
    rawKey: b64(new Uint8Array(await subtle.exportKey('raw', key))),
  };
}

const OLD = {
  version: 1,
  defaultPassword: 'Old-Default-1',
  credentials: [
    { id: 'o1', host: 'acme.wd5.myworkdayjobs.com', username: 'ada@example.com', password: 'Acme-Pass-1' },
    { id: 'o2', host: 'career8.successfactors.com', portal: 'company:moodysprod', username: 'ada', password: 'M-1' },
  ],
  cards: [{ id: 'k1', label: 'Visa', name: 'Ada Lovelace', number: '4242424242424242', expMonth: 4, expYear: 2029 }],
  defaultCardId: 'k1',
};

test('passwords: the old encrypted vault moves over once with its master password, without duplicates', async () => {
  const { blob } = await oldVault('my long master password', OLD);
  await chrome.storage.local.set({ vault: blob });
  // Saved since the update: one of the old logins again, and a new one.
  await passwords.update((d) => {
    d.defaultPassword = 'New-Default-2';
    d.credentials.push(
      { id: 'n1', host: 'acme.wd5.myworkdayjobs.com', username: 'ada@example.com', password: 'Acme-Pass-1' },
      { id: 'n2', host: 'globex.icims.com', username: 'ada@example.com', password: 'Globex-1' },
    );
  });
  assert.equal(await passwords.legacy(), true);

  await assert.rejects(passwords.importLegacy('wrong password'), /Wrong master password/);
  assert.equal(await passwords.legacy(), true, 'a wrong password changes nothing');
  assert.equal((await passwords.read()).credentials.length, 2);

  assert.deepEqual(await passwords.importLegacy('my long master password'), { credentials: 1, cards: 1 });
  const data = await passwords.read();
  assert.deepEqual(
    data.credentials.map((c) => [c.id, c.host, c.portal, c.password]),
    [
      ['n1', 'acme.wd5.myworkdayjobs.com', undefined, 'Acme-Pass-1'],
      ['n2', 'globex.icims.com', undefined, 'Globex-1'],
      ['o2', 'career8.successfactors.com', 'company:moodysprod', 'M-1'],
    ],
  );
  assert.equal(data.defaultPassword, 'New-Default-2', 'the default password set since is kept');
  assert.equal(passwords.defaultCard(data).number, '4242424242424242');
  assert.equal(data.defaultCardId, 'k1');
  assert.equal(await passwords.legacy(), false, 'the old vault is gone');
  assert.ok(!('vault' in chrome.storage.local._dump()));
  await assert.rejects(passwords.importLegacy('my long master password'), /no old vault/);

  // A backup from before brings it back: moving it over again adds nothing twice.
  await chrome.storage.local.set({ vault: blob });
  assert.deepEqual(await passwords.importLegacy('my long master password'), { credentials: 0, cards: 0 });
  assert.equal((await passwords.read()).credentials.length, 3);
});

test('passwords: an old vault still unlocked in memory moves over by itself; or it is discarded', async () => {
  const { blob, rawKey } = await oldVault('my long master password', OLD);
  await chrome.storage.local.set({ vault: blob });
  assert.equal(await passwords.importLegacySession(), null, 'no key in memory: it waits for the master password');
  assert.equal(await passwords.legacy(), true);
  await chrome.storage.session.set({ vaultKey: rawKey, vaultLastUsed: Date.now() });
  assert.deepEqual(await passwords.importLegacySession(), { credentials: 2, cards: 1 });
  const data = await passwords.read();
  assert.equal(data.defaultPassword, 'Old-Default-1');
  assert.equal(passwords.findCredential(data, 'acme.wd5.myworkdayjobs.com').password, 'Acme-Pass-1');
  assert.equal(await passwords.legacy(), false);
  assert.deepEqual(chrome.storage.session._dump(), {}, 'the old key is forgotten');

  await chrome.storage.local.set({ vault: blob });
  await passwords.discardLegacy();
  assert.equal(await passwords.legacy(), false);
  assert.equal((await passwords.read()).credentials.length, 2, 'discarding leaves the passwords alone');
});

test('passwords: credential lookup prefers the most specific host', () => {
  const data = {
    credentials: [
      { host: 'example.com', password: 'a' },
      { host: 'careers.example.com', password: 'b' },
      { host: 'other.com', password: 'c' },
    ],
  };
  assert.equal(passwords.findCredential(data, 'careers.example.com').password, 'b');
  assert.equal(passwords.findCredential(data, 'jobs.example.com').password, 'a');
  assert.equal(passwords.findCredential(data, 'www.other.com').password, 'c');
  assert.equal(passwords.findCredential(data, 'notexample.com'), null);
});

test('password generator', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const pw = passwords.generatePassword();
    assert.equal(pw.length, 20);
    assert.match(pw, /[a-z]/);
    assert.match(pw, /[A-Z]/);
    assert.match(pw, /[0-9]/);
    assert.match(pw, /[!@#$%^&*\-_=+?]/);
    seen.add(pw);
  }
  assert.equal(seen.size, 200);
  assert.doesNotMatch(passwords.generatePassword({ length: 32, symbols: false }), /[^A-Za-z0-9]/);
});

test('store: first profile is created once even with concurrent readers', async () => {
  await Promise.all([store.loadAll(), store.loadAll(), store.getActive()]);
  const { order, settings } = await store.loadAll();
  assert.equal(order.length, 1);
  assert.equal(settings.activeProfileId, order[0]);
});

test('store: acknowledgement boxes are ticked by default; older settings are switched on once, then left as set', async () => {
  assert.equal((await store.getSettings()).consents, true, 'a fresh install');
  await chrome.storage.local.set({ settings: { consents: false, overwrite: false } });
  const upgraded = await store.getSettings();
  assert.equal(upgraded.consents, true, 'settings saved before revision 2 had them off by default');
  assert.equal((await chrome.storage.local.get('settings')).settings.revision, 2);
  await store.saveSettings({ consents: false });
  assert.equal((await store.getSettings()).consents, false, 'switched off afterwards, it stays off');
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
  assert.equal(profile.education[0].classification, '', 'entries saved before the classification box get one');
  assert.deepEqual(profile.customAnswers, []);
});

test('store: a degree classification survives save, export and import; a class kept as the GPA is left there', async () => {
  installChrome();
  await chrome.storage.local.set({
    profiles: { old: { id: 'old', name: 'Old', education: [{ school: 'University of Glasgow', gpa: '2:1' }] } },
    profileOrder: ['old'],
  });
  const { profile: p } = await store.getActive();
  assert.equal(p.education[0].gpa, '2:1', 'user data is never moved about');
  assert.equal(p.education[0].classification, '');
  p.education[0].classification = 'First';
  await store.saveProfile(p);
  const exported = await store.exportData();
  assert.equal(exported.profiles[p.id].education[0].classification, 'First');
  delete exported.profiles[p.id].education[0].classification; // a backup from before the field existed
  await store.importData(JSON.parse(JSON.stringify(exported)));
  assert.equal((await store.getActive()).profile.education[0].classification, '');
  assert.equal((await store.getActive()).profile.education[0].gpa, '2:1');
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

test('store: hasData tells a fresh install from a filled-in one', async () => {
  assert.equal(await store.hasData(), false, 'one blank profile');
  const { profile } = await store.getActive();
  profile.name = 'Renamed';
  profile.contact.phoneType = 'Mobile';
  await store.saveProfile(profile);
  assert.equal(await store.hasData(), false, 'a profile name and default choices are not data');
  profile.education[0].school = 'University of Glasgow';
  await store.saveProfile(profile);
  assert.equal(await store.hasData(), true);

  installChrome();
  await store.createProfile('Second');
  assert.equal(await store.hasData(), true, 'more than one profile');
  installChrome();
  const blank = (await store.getActive()).profile;
  await store.setDoc(blank.id, 'resume', { name: 'cv.pdf', type: 'application/pdf', size: 3, dataUrl: 'data:,x' });
  assert.equal(await store.hasData(), true, 'a resume file');
  installChrome();
  await passwords.update(() => {});
  assert.equal(await store.hasData(), false, 'no passwords saved');
  await passwords.update((d) => d.credentials.push({ id: 'c', host: 'acme.com', password: 'x' }));
  assert.equal(await store.hasData(), true, 'a saved login');
  installChrome();
  await chrome.storage.local.set({ vault: { version: 1 } });
  assert.equal(await store.hasData(), true, 'an old encrypted vault');
  installChrome();
  await store.setAiKey('sk-only-a-key');
  assert.equal(await store.hasData(), true, 'an AI key alone');
});

test('store: every part of the backup file rewrites it when it changes; temporary things never do', async () => {
  installChrome();
  const { profile } = await store.getActive();
  profile.personal.firstName = 'Ada';
  await store.saveProfile(profile);
  await store.saveKit(profile.id, { notes: 'x' });
  await store.setDoc(profile.id, 'resume', { name: 'cv.pdf', type: 'application/pdf', size: 3, dataUrl: 'data:,x' });
  await store.setAiKey('sk-1');
  await store.setNylas({ apiKey: 'nyk_1', grantId: 'g1' });
  await passwords.update((d) => (d.defaultPassword = 'Default-1'));
  await chrome.storage.local.set({
    vault: { version: 1 },
    answers: [{ id: 'a' }],
    watchlist: [{ id: 'w', firm: 'Acme' }],
  });
  const backup = await store.exportData();
  const stored = Object.keys(await chrome.storage.local.get(null));
  // Everything the file carries (other than the application log) schedules a rewrite when it changes…
  for (const key of stored.filter((k) => k !== 'history'))
    if (JSON.stringify(backup).includes(`"${key}"`) || /^(doc|kit):/.test(key))
      assert.equal(store.backsUp(key), true, key);
  const kept = [
    'profiles',
    'profileOrder',
    'settings',
    'passwords',
    'vault',
    'aiKeys',
    'nylas',
    'answers',
    'watchlist',
  ];
  for (const key of kept) assert.equal(store.backsUp(key), true, key);
  // …and nothing temporary does.
  for (const key of ['letters', 'quickApply', 'quickStatus', 'discoverCache', 'backupInfo', 'history', 'watch:w'])
    assert.equal(store.backsUp(key), false, key);
});

test('store: backup info merges, and backup downloads are recognised', async () => {
  await store.setBackupInfo({ at: 1, path: '/d/JobToFill/jobtofill-backup.json' });
  await store.setBackupInfo({ paused: true });
  assert.deepEqual(await store.getBackupInfo(), { at: 1, path: '/d/JobToFill/jobtofill-backup.json', paused: true });
  const item = (filename, extra) => ({ state: 'complete', filename, mime: 'application/json', ...extra });
  assert.equal(store.isBackupDownload(item('C:\\Users\\me\\Downloads\\JobToFill\\jobtofill-backup.json')), true);
  assert.equal(store.isBackupDownload(item('/home/me/Downloads/jobtofill-backup-2026-10-01.json')), true);
  assert.equal(store.isBackupDownload(item('/tmp/0a1b2c', { byExtensionId: 'jobtofill-test' })), true, 'renamed');
  assert.equal(store.isBackupDownload(item('/tmp/0a1b2c', { byExtensionId: 'someone-else' })), false);
  assert.equal(store.isBackupDownload(item('/home/me/Downloads/report.json')), false);
  assert.equal(store.isBackupDownload(item('/x/jobtofill-backup.json', { state: 'interrupted' })), false);
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

test('store: passwords and cards go in the backup as they are, and come back from it', async () => {
  await passwords.update((d) => {
    d.defaultPassword = 'Default-1';
    d.credentials.push({ id: 'c1', host: 'acme.myworkdayjobs.com', username: 'ada', password: 'Acme-Pass-1' });
    d.cards.push({ id: 'k1', number: '4242424242424242', expMonth: 4, expYear: 2029 });
  });
  const backup = JSON.parse(JSON.stringify(await store.exportData()));
  assert.equal(backup.passwords.credentials[0].password, 'Acme-Pass-1');
  assert.equal(backup.vault, undefined);
  assert.equal((await store.exportData({ passwords: false })).passwords, undefined, 'unless left out');

  installChrome();
  await store.importData(backup);
  const data = await passwords.read();
  assert.equal(data.defaultPassword, 'Default-1');
  assert.equal(passwords.findCredential(data, 'acme.myworkdayjobs.com').password, 'Acme-Pass-1');
  assert.equal(passwords.defaultCard(data).number, '4242424242424242');

  // A backup from an older version holds an encrypted vault: it waits to be moved over, and the passwords stay.
  const old = { ...backup, passwords: undefined, vault: { kdf: { iterations: 1000, salt: 'AA==' }, data: {} } };
  await store.importData(JSON.parse(JSON.stringify(old)));
  assert.equal(await passwords.legacy(), true);
  assert.equal((await passwords.read()).credentials.length, 1);
});

test('store: cover letter material is per profile, exported, and the API key is not', async () => {
  const { profile } = await store.getActive();
  await store.saveKit(profile.id, { notes: 'Chess captain', samples: [{ id: 's1', name: 'a.pdf', text: 'Dear X' }] });
  await store.saveKit(profile.id, { closing: 'Kind regards,' });
  const kit = await store.getKit(profile.id);
  assert.equal(kit.notes, 'Chess captain');
  assert.equal(kit.closing, 'Kind regards,');
  assert.equal(kit.paper, 'a4', 'defaults fill the gaps');
  assert.equal(await store.hasData(), true, 'notes count as data worth backing up');

  await store.saveAiSettings({ provider: 'deepseek', model: '' });
  await store.setAiKey('  sk-secret ');
  assert.deepEqual(await store.aiConfig(), {
    provider: 'deepseek',
    model: '',
    baseUrl: '',
    apiKey: 'sk-secret',
  });
  const backup = JSON.parse(JSON.stringify(await store.exportData()));
  assert.deepEqual(backup.aiKeys, { deepseek: 'sk-secret' }, 'the key is kept in the backup file');
  assert.equal(backup.kits[`kit:${profile.id}`].notes, 'Chess captain');

  installChrome();
  await store.importData(backup);
  assert.equal((await store.getKit(profile.id)).notes, 'Chess captain');
  assert.equal(await store.getAiKey('deepseek'), 'sk-secret', 'and comes back after a reinstall');
  await store.setAiKey('');
  assert.equal(await store.getAiKey(), '');

  // Switched off: the backup has no keys.
  await store.setAiKey('sk-secret');
  await store.saveAiSettings({ backupKeys: false });
  assert.equal((await store.exportData()).aiKeys, undefined);
  assert.equal((await store.exportData({ keys: true })).aiKeys.deepseek, 'sk-secret');
});

test('store: the master CV (LaTeX source and parsed model) is kept per profile and travels in backups', async () => {
  installChrome();
  const { profile } = await store.getActive();
  assert.equal((await store.getKit(profile.id)).cvMaster, null, 'none by default');
  assert.equal((await store.getKit(profile.id)).cvTex, '');
  const cvMaster = {
    name: 'Ada Example',
    contact: ['ada@example.com'],
    sections: [{ title: 'Skills', entries: [], lines: [{ label: 'Tools', text: 'Python' }] }],
  };
  await store.saveKit(profile.id, { cvTex: '\\section{Skills}', cvMaster });
  await store.saveKit(profile.id, { notes: 'later edits keep it' });
  assert.deepEqual((await store.getKit(profile.id)).cvMaster, cvMaster);
  const backup = JSON.parse(JSON.stringify(await store.exportData()));
  assert.deepEqual(backup.kits[`kit:${profile.id}`].cvMaster, cvMaster);
  assert.equal(backup.kits[`kit:${profile.id}`].cvTex, '\\section{Skills}');
  installChrome();
  await store.importData(backup);
  assert.deepEqual((await store.getKit(profile.id)).cvMaster, cvMaster);
  await store.saveKit(profile.id, { cvTex: '', cvMaster: null });
  assert.equal((await store.getKit(profile.id)).cvMaster, null, 'and can be removed');
});

test('store: each AI provider keeps its own key and model; another key stands in when one fails', async () => {
  installChrome();
  // Older versions kept one key and one model, for the provider chosen then.
  await chrome.storage.local.set({
    aiKey: 'sk-or-old',
    settings: { ...store.DEFAULT_SETTINGS, ai: { provider: 'openrouter', model: 'deepseek/x', baseUrl: '' } },
  });
  assert.deepEqual(await store.getAiKeys(), { openrouter: 'sk-or-old' });
  assert.equal((await store.aiConfig()).model, 'deepseek/x');

  await store.saveAiSettings({ provider: 'deepseek' });
  let config = await store.aiConfig();
  assert.equal(config.provider, 'deepseek');
  assert.equal(config.model, '', 'the OpenRouter model doesn’t carry over');
  assert.equal(config.apiKey, '', 'nor its key');
  assert.deepEqual(config.fallback, { provider: 'openrouter', model: 'deepseek/x', baseUrl: '', apiKey: 'sk-or-old' });

  await store.setAiKey('sk-ds', 'deepseek');
  await store.saveAiSettings({ model: 'deepseek-reasoner' });
  config = await store.aiConfig();
  assert.equal(config.apiKey, 'sk-ds');
  assert.equal(config.model, 'deepseek-reasoner');
  assert.deepEqual(await store.getAiKeys(), { openrouter: 'sk-or-old', deepseek: 'sk-ds' });
  assert.equal((await chrome.storage.local.get('aiKey')).aiKey, undefined, 'the old single key is moved over');

  await store.saveAiSettings({ provider: 'openrouter' });
  config = await store.aiConfig();
  assert.equal(config.apiKey, 'sk-or-old', 'switching back finds the first key again');
  assert.equal(config.model, 'deepseek/x');
  assert.equal(config.fallback.provider, 'deepseek');
  assert.equal(config.fallback.model, 'deepseek-reasoner');

  await store.saveAiSettings({ fallback: false });
  assert.equal((await store.aiConfig()).fallback, undefined);

  // A Claude key is kept like the others, goes into the backup, and is the first to stand in.
  await store.saveAiSettings({ fallback: true });
  await store.setAiKey('sk-ant-test', 'anthropic');
  assert.equal(await store.getAiKey('anthropic'), 'sk-ant-test');
  assert.equal((await store.exportData({ keys: true })).aiKeys.anthropic, 'sk-ant-test');
  config = await store.aiConfig();
  assert.equal(config.fallback.provider, 'anthropic', 'Claude stands in for OpenRouter before DeepSeek');
  await store.saveAiSettings({ provider: 'anthropic', model: 'claude-haiku-5-5' });
  config = await store.aiConfig();
  assert.deepEqual(
    [config.provider, config.model, config.apiKey, config.baseUrl],
    ['anthropic', 'claude-haiku-5-5', 'sk-ant-test', ''],
  );
  assert.equal(config.fallback.provider, 'openrouter');
  assert.equal('fast' in config, false, 'fast mode is off unless switched on');

  // Fast mode travels with the config, the stand-in's too; ai.js uses it only for a Claude model that has it.
  await store.saveAiSettings({ fast: true });
  config = await store.aiConfig();
  assert.deepEqual([config.fast, config.fallback.fast], [true, true]);
  await store.saveAiSettings({ provider: 'openrouter' });
  assert.equal((await store.aiConfig()).fallback.model, 'claude-haiku-5-5', 'switching provider keeps it');
  await store.saveAiSettings({ fast: false });
  assert.equal('fast' in (await store.aiConfig()), false);
});

test('store: a chosen letter follows its application across pages, not to other jobs', async () => {
  const base = { profileId: 'p', pdf: { name: 'l.pdf' } };
  const unused = await store.saveLetter({
    ...base,
    url: 'https://acme.wd3.myworkdayjobs.com/x/job/London/Analyst_R-1234',
  });
  assert.equal(await store.letterFor({ tabId: 1, url: unused.url }), null, 'only letters chosen for the application');
  const chosen = await store.saveLetter({ id: unused.id, tabId: 7, attachedAt: Date.now(), jobIds: ['R-1234'] });
  assert.equal(chosen.pdf.name, 'l.pdf', 'saving by id updates the letter');
  assert.equal((await store.getLetters()).length, 1);

  const find = (tabId, url) => store.letterFor({ tabId, url }).then((l) => l && l.id);
  assert.equal(
    await find(9, 'https://acme.wd3.myworkdayjobs.com/x/job/London/Analyst_R-1234/'),
    chosen.id,
    'same page',
  );
  assert.equal(
    await find(9, 'https://acme.wd3.myworkdayjobs.com/x/job/Analyst_R-1234/apply/step2'),
    chosen.id,
    'job id',
  );
  assert.equal(await find(7, 'https://acme.wd3.myworkdayjobs.com/x/flow/review'), chosen.id, 'next step, same tab');
  assert.equal(await find(9, 'https://acme.wd3.myworkdayjobs.com/x/flow/review'), null, 'another tab, another job');
  assert.equal(await find(7, 'https://other.example/apply'), null, 'another site');

  await store.saveLetter({ id: chosen.id, attachedAt: Date.now() - 4 * 86400000 });
  assert.equal(await find(7, unused.url), null, 'old choices expire');
  await store.removeLetter(chosen.id);
  assert.deepEqual(await store.getLetters(), []);
});

test('store: one application address for every job (HSBC) never carries a letter to another job', async () => {
  const at = Date.now() - 60000;
  const a = await store.saveLetter({
    profileId: 'p',
    url: 'https://apply.careers.hsbc.com/',
    tabId: 3,
    attachedAt: at,
    jobIds: ['1373565757'],
    posting: { url: 'https://apply.careers.hsbc.com/emergingtalent/job/London-Relationship-Management/1373565757/' },
  });
  const find = (tabId, url, trail) => store.letterFor({ tabId, url, trail }).then((l) => l && l.id);
  const root = 'https://apply.careers.hsbc.com/';
  assert.equal(await find(3, root), a.id, 'the same tab, still on that application');
  assert.equal(await find(4, root), null, 'the same address in another tab is another job');
  const own = [
    { url: a.posting.url, at: at - 5000 },
    { url: `${root}step/2`, at: at + 1000 },
  ];
  assert.equal(await find(3, root, own), a.id, 'its own job page and later steps');
  const other = [
    ...own,
    { url: 'https://apply.careers.hsbc.com/emergingtalent/job/London-Markets/1373576757/', at: Date.now() },
  ];
  assert.equal(await find(3, root, other), null, 'the tab moved on to another job');
  await store.removeLetter(a.id);
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

test('AI answers are kept per application: never reused for another job in the same tab', async () => {
  const { store } = load();
  await chrome.storage.local.clear();
  const item = {
    key: 'why#',
    question: 'Why are you interested in this role?',
    kind: 'essay',
    value: 'Because of Figma.',
  };
  await store.saveAnswers({
    profileId: 'p',
    url: 'https://job-boards.greenhouse.io/figma/jobs/5555501',
    host: 'job-boards.greenhouse.io',
    tabId: 7,
    company: 'Figma',
    items: [item],
  });
  const at = (url, tabId = 7) => store.answersFor({ profileId: 'p', tabId, url });
  assert.equal((await at('https://job-boards.greenhouse.io/figma/jobs/5555501')).length, 1, 'the same page');
  assert.equal((await at('https://job-boards.greenhouse.io/figma/jobs/5555501/apply', 9)).length, 1, 'its apply step');
  assert.equal((await at('https://job-boards.greenhouse.io/figma/review')).length, 1, 'the next step, same tab');
  assert.equal((await at('https://job-boards.greenhouse.io/monzo/jobs/7777702')).length, 0, 'another job, same tab');
  assert.equal((await at('https://jobs.lever.co/figma/5555501')).length, 0, 'another site');
  // Saving again for the same application adds to it; the bank offers the written answers.
  await store.saveAnswers({
    profileId: 'p',
    url: 'https://job-boards.greenhouse.io/figma/jobs/5555501',
    host: 'job-boards.greenhouse.io',
    tabId: 7,
    company: 'Figma',
    items: [{ ...item, key: 'proj#', question: 'Describe a project', value: 'I built a tool.' }],
  });
  assert.equal((await store.getAnswers()).length, 1);
  assert.equal((await at('https://job-boards.greenhouse.io/figma/jobs/5555501')).length, 2);
  assert.deepEqual(
    (await store.answerBank('p')).map((b) => b.company),
    ['Figma', 'Figma'],
  );
});

test('store: quick apply keeps one temporary result, replaced each time, in session memory, never in a backup', async () => {
  assert.equal(await store.getQuickApply(), null);
  await store.saveQuickApply({
    company: 'Acme',
    letter: { text: 'one', pdf: 'data:application/pdf;base64,AA==', name: 'a.pdf' },
  });
  await store.saveQuickApply({
    company: 'Globex',
    letter: { text: 'two', pdf: 'data:application/pdf;base64,AA==', name: 'b.pdf' },
    cv: null,
  });
  const got = await store.getQuickApply();
  assert.equal(got.company, 'Globex', 'the second replaced the first');
  assert.equal(got.letter.text, 'two');
  assert.ok(got.createdAt > 0);
  assert.ok('quickApply' in chrome.storage.session._dump());
  assert.ok(!('quickApply' in chrome.storage.local._dump()), 'not written to disk');

  await store.setQuickStatus({ state: 'running', message: 'writing letter' });
  assert.equal((await store.getQuickStatus()).state, 'running');

  // A profile with data, so there is something to export.
  const { profile } = await store.getActive();
  profile.personal.firstName = 'Ada';
  await store.saveProfile(profile);
  const backup = JSON.stringify(await store.exportData());
  assert.ok(!backup.includes('Globex') && !backup.includes('quickApply') && !backup.includes('quickStatus'));

  // Clearing removes the record, the progress and the letter kept only for the form.
  await store.saveLetter({ id: 'q1', quick: true, text: 'x' });
  await store.saveLetter({ id: 'keep', text: 'mine' });
  await store.clearQuickApply();
  assert.equal(await store.getQuickApply(), null);
  assert.equal(await store.getQuickStatus(), null);
  assert.deepEqual(
    (await store.getLetters()).map((l) => l.id),
    ['keep'],
  );
});

test('store: quick apply falls back to local storage without session storage', async () => {
  const session = chrome.storage.session;
  delete chrome.storage.session;
  try {
    await store.saveQuickApply({ company: 'Acme' });
    await store.saveQuickApply({ company: 'Initech' });
    assert.equal((await store.getQuickApply()).company, 'Initech');
    await store.clearQuickApply();
    assert.equal(await store.getQuickApply(), null);
  } finally {
    chrome.storage.session = session;
  }
});

test('store: extraDetails survives save, export and import', async () => {
  const { profile: p } = await store.getActive();
  p.extraDetails = 'No criminal convictions.';
  await store.saveProfile(p);
  const exported = await store.exportData();
  assert.equal(exported.profiles[p.id].extraDetails, 'No criminal convictions.');
  await store.importData(JSON.parse(JSON.stringify(exported)));
  assert.equal((await store.getActive()).profile.extraDetails, 'No criminal convictions.');
});

test('store: interview availability and contact preference get their defaults, and travel in backups', async () => {
  await chrome.storage.local.set({
    profiles: { old: { id: 'old', name: 'Old', job: { referralSource: '' }, contact: { email: 'ada@example.com' } } },
    profileOrder: ['old'],
  });
  const { profile: p } = await store.getActive();
  assert.deepEqual(p.availability, { days: 'Mon, Tue, Wed, Thu, Fri', from: '08:00', to: '20:00', unavailable: '' });
  assert.equal(p.contact.preferredContact, 'Email');
  assert.equal(p.job.referralSource, '', 'a blank answer stays blank (and is filled in as LinkedIn)');
  Object.assign(p.availability, { days: 'Mon, Wed', from: '09:00', unavailable: '12–23 January 2027 (exams)' });
  await store.saveProfile(p);
  const exported = await store.exportData();
  installChrome();
  await store.importData(JSON.parse(JSON.stringify(exported)));
  assert.deepEqual((await store.getActive()).profile.availability, {
    days: 'Mon, Wed',
    from: '09:00',
    to: '20:00',
    unavailable: '12–23 January 2027 (exams)',
  });
  // The defaults alone are not data worth backing up.
  installChrome();
  assert.equal(await store.hasData(), false);
});
