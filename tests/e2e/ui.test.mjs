// End-to-end, Chromium only: detailed Playwright interactions with the settings page and the popup.
// (pages.test.mjs covers the same pages in both browsers.)
import { test as base, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isFirefox, launch } from './harness.mjs';

const test = (name, fn) => base(name, { skip: isFirefox && 'uses Playwright page APIs' }, fn);

let h;
const errors = [];

before(async () => {
  if (!isFirefox) h = await launch();
});

after(async () => {
  if (h) await h.close();
});

async function openExt(path) {
  const page = await h.context.newPage();
  page.on('pageerror', (e) => errors.push(`${path}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${path}: ${m.text()}`);
  });
  await page.goto(h.extUrl(path));
  return page;
}

const profile = () => h.bg(async () => (await globalThis.JTF.store.getActive()).profile);

test('every settings section renders without errors', async () => {
  const page = await openExt('options/options.html');
  const sections = await page.$$eval('#nav a', (as) => as.map((a) => a.getAttribute('href').slice(1)));
  assert.ok(sections.length >= 12);
  for (const s of sections) {
    await page.click(`#nav a[href="#${s}"]`);
    await page.waitForFunction(
      (name) => document.querySelector('#sections').dataset.section === name && document.querySelector('#sections h1'),
      s,
    );
    assert.equal(await page.getAttribute(`#nav a[href="#${s}"]`, 'aria-current'), 'page');
  }
  assert.deepEqual(errors, []);
  await page.close();
});

test('profile edits autosave, including list entries and custom answers', async () => {
  const page = await openExt('options/options.html#personal');
  await page.fill('input[name="personal.firstName"]', 'Grace');
  await page.fill('input[name="contact.email"]', 'grace@example.com');
  await page.selectOption('select[name="contact.phoneType"]', 'Work');
  await page.waitForSelector('#save-state.saved');
  let p = await profile();
  assert.equal(p.personal.firstName, 'Grace');
  assert.equal(p.contact.email, 'grace@example.com');
  assert.equal(p.contact.phoneType, 'Work');

  await page.click('#nav a[href="#education"]');
  await page.click('text=+ Add education');
  const schools = page.locator('input[name="school"]');
  assert.equal(await schools.count(), 2);
  await schools.nth(1).fill('Yale');
  await page.click('#nav a[href="#answers"]');
  await page.click('text=+ Add answer');
  await page.fill('input[name="question"]', 'clearance');
  await page.fill('textarea[name="answer"]', 'No');
  await page.waitForSelector('#save-state.saved');
  await page.waitForTimeout(500);
  p = await profile();
  assert.equal(p.education.length, 2);
  assert.equal(p.education[1].school, 'Yale');
  assert.equal(p.customAnswers.at(-1).question, 'clearance');
  assert.equal(p.customAnswers.at(-1).answer, 'No');
  assert.deepEqual(errors, []);
  await page.close();
});

test('multiple profiles: create, switch, delete', async () => {
  const page = await openExt('options/options.html#personal');
  page.once('dialog', (d) => d.accept('Shopping'));
  await page.click('#profile-new');
  await page.waitForFunction(
    () => document.querySelector('#profile-select').selectedOptions[0]?.textContent === 'Shopping',
  );
  assert.equal((await profile()).name, 'Shopping');
  page.once('dialog', (d) => d.accept());
  await page.click('#profile-delete');
  await page.waitForFunction(() => document.querySelector('#profile-select').options.length === 1);
  assert.equal((await profile()).personal.firstName, 'Grace');
  await page.close();
});

test('resume upload is stored per profile', async () => {
  const page = await openExt('options/options.html#documents');
  await page.setInputFiles('input[name="doc-resume"]', {
    name: 'Grace_CV.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4 test'),
  });
  await page.waitForSelector('text=Grace_CV.pdf');
  const info = await h.bg(async () => {
    const { profile } = await globalThis.JTF.store.getActive();
    return globalThis.JTF.store.docInfo(profile.id);
  });
  assert.equal(info.resume.name, 'Grace_CV.pdf');
  await page.close();
});

test('vault: create, add a card and a login, lock and unlock from the settings page', async () => {
  const page = await openExt('options/options.html#vault');
  await page.fill('input[name=master]', 'my long master password');
  await page.fill('input[name=master2]', 'my long master password');
  await page.click('text=Create vault');
  await page.waitForSelector('text=Saved logins (0)');
  assert.equal(await h.bg(() => globalThis.JTF.vault.status()), 'unlocked');

  await page.fill('input[name=cardNumber]', '4242 4242 4242 4242');
  await page.fill('input[name=cardExpMonth]', '7');
  await page.fill('input[name=cardExpYear]', '2030');
  await page.click('text=Add card');
  await page.waitForSelector('text=•••• 4242');

  await page.fill('input[name=newHost]', 'https://acme.wd5.myworkdayjobs.com/en-US/careers');
  await page.fill('input[name=newPass]', 'S3cret-pass!');
  await page.click('text=Add login');
  await page.waitForSelector('text=acme.wd5.myworkdayjobs.com');

  const data = await h.bg(() => globalThis.JTF.vault.read());
  assert.equal(data.cards[0].number, '4242424242424242');
  assert.equal(data.cards[0].expMonth, 7);
  assert.equal(data.credentials[0].host, 'acme.wd5.myworkdayjobs.com');
  assert.equal(data.credentials[0].username, 'grace@example.com');

  await page.click('text=Lock now');
  await page.waitForSelector('text=Vault locked');
  await page.fill('input[name=master]', 'wrong password');
  await page.click('button:has-text("Unlock")');
  await page.waitForSelector('text=Wrong master password.');
  await page.fill('input[name=master]', 'my long master password');
  await page.click('button:has-text("Unlock")');
  await page.waitForSelector('text=Saved logins (1)');
  assert.deepEqual(errors, []);
  await page.close();
});

test('settings toggles persist', async () => {
  const page = await openExt('options/options.html#settings');
  await page.check('input[name=overwrite]');
  await page.selectOption('select[name=autoLockMinutes]', '5');
  await page.waitForTimeout(200);
  const s = await h.bg(() => globalThis.JTF.store.getSettings());
  assert.equal(s.overwrite, true);
  assert.equal(s.autoLockMinutes, 5);
  await page.uncheck('input[name=overwrite]');
  await page.close();
});

test('backup downloads a JobToFill JSON file', async () => {
  const page = await openExt('options/options.html#backup');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('text=Download backup')]);
  const file = await download.path();
  const data = JSON.parse(await (await import('node:fs/promises')).readFile(file, 'utf8'));
  assert.equal(data.app, 'JobToFill');
  assert.ok(data.vault && data.vault.data.ct, 'vault is included, encrypted');
  assert.ok(!JSON.stringify(data).includes('4242424242424242'), 'no plain-text card number in the backup');
  await page.close();
});

test('popup fills the page it points at and shows a summary', async () => {
  const form = await h.open('greenhouse.html');
  const tabId = await h.tabId(form);
  const popup = await openExt(`popup/popup.html?tab=${tabId}`);
  await popup.waitForSelector('#vault-lock');
  await popup.click('#fill');
  await popup.waitForSelector('#result .count');
  // This profile only has a name and email, so the summary should also list what is missing.
  const count = Number(await popup.textContent('#result .count'));
  assert.ok(count >= 2, `filled ${count}`);
  assert.match(await popup.textContent('#result'), /Missing from your profile:.*Last name/);
  assert.equal(await form.inputValue('#first_name'), 'Grace');

  await popup.click('text=Undo');
  await popup.waitForSelector('text=/Restored \\d+ field/');
  assert.equal(await form.inputValue('#first_name'), '');

  await form.fill('#q_why', 'Because of the mission.');
  await popup.click('#learn');
  await popup.waitForSelector('#learn-list li');
  assert.ok((await popup.textContent('#learn-list')).includes('Because of the mission.'));
  await popup.click('#learn-save');
  await popup.waitForSelector('text=/Saved \\d+ item/');
  const p = await profile();
  assert.ok(p.customAnswers.some((a) => a.answer === 'Because of the mission.'));

  await popup.click('#vault-lock');
  await popup.waitForSelector('#vault-password');
  assert.deepEqual(errors, []);
  await Promise.all([form.close(), popup.close()]);
});

test('popup offers to tick acknowledgement boxes, then does', async () => {
  const form = await h.open('greenhouse-remix.html');
  await form.waitForSelector('#first_name');
  const tabId = await h.tabId(form);
  const popup = await openExt(`popup/popup.html?tab=${tabId}`);
  await popup.click('#fill');
  await popup.waitForSelector('text=/acknowledgement box is left for you/');
  assert.equal(await form.isChecked('input[name="question_1004[]"]'), false);
  await popup.click('text=Always tick these');
  await form.waitForFunction(() => document.querySelector('input[name="question_1004[]"]').checked);
  assert.equal((await h.bg(() => globalThis.JTF.store.getSettings())).consents, true);
  await h.bg(() => globalThis.JTF.store.saveSettings({ consents: false }));
  assert.deepEqual(errors, []);
  await Promise.all([form.close(), popup.close()]);
});

test('popup: "Last quick apply" only shows while a result is kept; Quick apply without an AI key opens the normal studio', async () => {
  const form = await h.open('letters/apply.html');
  const tabId = await h.tabId(form);
  const popup = await openExt(`popup/popup.html?tab=${tabId}`);
  await popup.waitForSelector('#quick-apply');
  assert.equal(await popup.isVisible('#quick-last'), false);
  await h.bg(() =>
    globalThis.JTF.store.saveQuickApply({ company: 'Acme', letter: { text: 'x', pdf: '', name: 'l.pdf' } }),
  );
  await popup.waitForSelector('#quick-last', { state: 'visible' });
  await h.bg(() => globalThis.JTF.store.clearQuickApply());
  await popup.waitForSelector('#quick-last', { state: 'hidden' });

  // No key set up: the studio opens as usual (not in quick mode) so its setup card can ask.
  const opened = h.context.waitForEvent('page');
  await popup.click('#quick-apply');
  const studio = await opened;
  await studio.waitForSelector('#setup:not([hidden])');
  assert.ok(!studio.url().includes('quick=1'));
  await Promise.all([studio.close(), form.close(), popup.close()]);
});

test('backup section: "Back up now" writes the file and shows where', async () => {
  await h.bg(async () => {
    const { profile } = await globalThis.JTF.store.getActive();
    profile.personal.lastName = 'Hopper';
    await globalThis.JTF.store.saveProfile(profile);
  });
  const page = await openExt('options/options.html#backup');
  await page.waitForSelector('#backup-status');
  await page.click('text=Back up now');
  await page.waitForSelector('#backup-status:has-text("Last saved")');
  assert.equal(await page.isVisible('text=Show file'), true);
  assert.deepEqual(errors, []);
  await page.close();
});

test('after JobToFill is removed and added again, the settings page restores the backup file', async () => {
  const data = await h.bg(async () => {
    const { profile } = await globalThis.JTF.store.getActive();
    profile.personal.lastName = 'Hopper';
    await globalThis.JTF.store.saveProfile(profile);
    return globalThis.JTF.store.exportData();
  });
  const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'jtf-restore-')), 'jobtofill-backup.json');
  await writeFile(file, JSON.stringify(data));
  // Removing the extension leaves its storage empty; the install check found the old file.
  await h.bg(async () => {
    await globalThis.JTF.api.storage.local.clear();
    await globalThis.JTF.store.loadAll();
    await globalThis.JTF.store.setBackupInfo({
      previous: { path: '/home/me/Downloads/JobToFill/jobtofill-backup.json', at: Date.now() },
      paused: true,
    });
  });
  assert.equal((await profile()).personal.lastName, '');
  const popup = await openExt('popup/popup.html');
  await popup.waitForSelector('#restore:not([hidden])');
  await popup.close();

  const page = await openExt('options/options.html');
  await page.waitForSelector('#restore:not([hidden])');
  assert.match(await page.textContent('#restore'), /Downloads\/JobToFill\/jobtofill-backup\.json/);
  await Promise.all([page.waitForEvent('load'), page.setInputFiles('#restore-file', file)]);
  await page.waitForSelector('#restore', { state: 'hidden' });
  assert.equal((await profile()).personal.lastName, 'Hopper');
  const info = await h.bg(() => globalThis.JTF.store.getBackupInfo());
  assert.equal(info.paused, false, 'automatic backups resume');
  assert.deepEqual(errors, []);
  await page.close();
});

test('Discover lists registry firms, and watched firms’ new programmes show on the toolbar button', async () => {
  // Trackr's list comes from the cache, so the search needs no network.
  await h.bg(() =>
    globalThis.JTF.store.setDiscoverCache({
      trackr: { names: ['man group', 'man'], domains: ['man.com'], at: Date.now(), answered: 1 },
    }),
  );
  const popup = await openExt('popup/popup.html');
  assert.equal(await popup.textContent('#discover span'), 'Discover internships');
  await popup.close();

  const pageErrors = [];
  const page = await h.context.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(h.extUrl('discover/discover.html'));
  await page.waitForFunction(() => /firms in the registry/.test(document.querySelector('#registry-info').textContent));
  await page.selectOption('#place', 'any');
  await page.selectOption('#size', 'any');
  await page.click('#search');
  await page.waitForSelector('#results .firm');
  assert.ok((await page.$$('#results .firm')).length >= 10);
  assert.match(await page.textContent('#status'), /firms? match/);
  assert.ok(!(await page.textContent('#results')).includes('Man Group'), 'Trackr’s firms are left out');

  // A watched firm whose careers page gains a programme.
  const careers = h.url('discover-careers.html');
  await h.bg(async (url) => {
    const { store } = globalThis.JTF;
    const firm = { id: 'd:quiet.example', name: 'Quiet Capital', aliases: [], cities: ['London'], tags: [] };
    await store.saveWatch({ id: firm.id, firm, boards: [], pages: [url], emails: [] });
    // Watched before the programme was posted: nothing seen yet.
    await store.setWatchState(firm.id, { seen: [], fresh: [] });
  }, careers);
  const r = await h.bg(() => globalThis.JTFBackground.checkWatchlist());
  assert.equal(r.checked, 1);
  assert.ok(r.fresh >= 1);
  assert.equal(await h.bg(() => globalThis.JTF.api.action.getBadgeText({})), String(r.fresh));
  await page.click('#tab-watch');
  await page.reload();
  await page.waitForSelector('#watchlist .firm');
  assert.match(await page.textContent('#watchlist'), /2027 Summer Internship Programme/);
  await page.click('#watch-seen');
  await page.waitForFunction(() => !document.querySelector('#watchlist .new'));
  assert.equal(await h.bg(() => globalThis.JTF.api.action.getBadgeText({})), '');
  // A second check finds nothing new.
  assert.equal((await h.bg(() => globalThis.JTFBackground.checkWatchlist())).fresh, 0);
  assert.deepEqual(pageErrors, []);
  await page.close();
});
