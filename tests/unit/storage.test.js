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
  await chrome.storage.local.set({ vault: { version: 1 } });
  assert.equal(await store.hasData(), true, 'a vault');
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
