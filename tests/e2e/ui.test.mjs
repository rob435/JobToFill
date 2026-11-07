// End-to-end, Chromium only: detailed Playwright interactions with the settings page and the popup.
// (pages.test.mjs covers the same pages in both browsers.)
import { test as base, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isFirefox, launch, until } from './harness.mjs';

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

// What the stand-in AI drafts on the Discover page: the body only (the greeting and sign-off are added there).
const DRAFT = {
  subject: 'Summer internship enquiry',
  body: [
    'I am a final-year student writing to ask whether your firm takes interns this summer.',
    'I built a reconciliation tool in Python that checks 40,000 trades a night, and I would like to learn how a small investment firm works.',
    'Would you consider me for a summer internship or other work experience? My CV is attached. Thank you for your time.',
  ].join('\n\n'),
};

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
  await page.click('#profile-new');
  await page.fill('#profile-name', 'Shopping');
  await page.press('#profile-name', 'Enter');
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

test('passwords & cards: add a card and a login, edit and delete them from the settings page', async () => {
  const page = await openExt('options/options.html#passwords');
  await page.waitForSelector('text=Saved logins (0)');
  assert.equal(await page.$('[name=legacyMaster]'), null, 'nothing to set up or unlock');

  await page.fill('input[name=cardNumber]', '4242 4242 4242 4242');
  await page.fill('input[name=cardExpMonth]', '7');
  await page.fill('input[name=cardExpYear]', '2030');
  await page.click('text=Add card');
  await page.waitForSelector('text=•••• 4242');

  await page.fill('input[name=newHost]', 'https://acme.wd5.myworkdayjobs.com/en-US/careers');
  await page.fill('input[name=newPass]', 'S3cret-pass!');
  await page.click('text=Add login');
  await page.waitForSelector('text=acme.wd5.myworkdayjobs.com');

  const data = await h.bg(() => globalThis.JTF.passwords.read());
  assert.equal(data.cards[0].number, '4242424242424242');
  assert.equal(data.cards[0].expMonth, 7);
  assert.equal(data.credentials[0].host, 'acme.wd5.myworkdayjobs.com');
  assert.equal(data.credentials[0].username, 'grace@example.com');

  // Edited in place, then deleted.
  const row = 'tbody tr:has(td:text-is("acme.wd5.myworkdayjobs.com"))';
  await page.fill(`${row} input[aria-label^="Username"]`, 'grace.h@example.com');
  await page.press(`${row} input[aria-label^="Username"]`, 'Tab');
  await page.waitForTimeout(300);
  await page.fill(`${row} .secret input`, 'N3w-pass!');
  await page.press(`${row} .secret input`, 'Tab');
  await page.waitForTimeout(300);
  const login = await h.bg(async () => (await globalThis.JTF.passwords.read()).credentials[0]);
  assert.equal(login.username, 'grace.h@example.com');
  assert.equal(login.password, 'N3w-pass!');
  page.once('dialog', (d) => d.accept());
  await page.click(`${row} button:has-text("Delete")`);
  await page.waitForSelector('text=Saved logins (0)');
  assert.deepEqual(errors, []);
  await page.close();
});

test('settings toggles persist', async () => {
  const page = await openExt('options/options.html#settings');
  await page.check('input[name=overwrite]');
  await page.waitForTimeout(200);
  const s = await h.bg(() => globalThis.JTF.store.getSettings());
  assert.equal(s.overwrite, true);
  await page.uncheck('input[name=overwrite]');
  await page.close();
});

test('questions the AI may also answer: each switch saves, and “All of them” switches all five (mixed when some)', async () => {
  const sensitive = async () => (await h.bg(() => globalThis.JTF.store.getSettings())).aiSensitive;
  const NONE = { eeo: false, consent: false, legal: false, health: false, identity: false };
  const page = await openExt('options/options.html#letters');
  await page.waitForSelector('input[name="ai-sensitive-all"]');
  const all = 'input[name="ai-sensitive-all"]';
  const mixed = () => page.$eval(all, (box) => box.indeterminate);
  assert.deepEqual(await sensitive(), NONE, 'all off by default');
  assert.equal(await page.isChecked(all), false);
  assert.equal(await mixed(), false);
  for (const text of [
    'Diversity and equal opportunity',
    'Declarations and consents',
    'Government, legal and security vetting',
    'Health and adjustments',
    'ID numbers and date of birth',
    'Only switch this on if that’s true of you.',
  ])
    assert.ok(await page.getByText(text).count(), text);

  await page.check('input[name="ai-sensitive-legal"]');
  await page.waitForFunction(() => document.querySelector('input[name="ai-sensitive-all"]').indeterminate);
  await page.waitForTimeout(200);
  assert.deepEqual(await sensitive(), { ...NONE, legal: true });
  assert.equal(await page.isChecked(all), false);

  await page.check(all);
  await page.waitForTimeout(200);
  assert.deepEqual(await sensitive(), { eeo: true, consent: true, legal: true, health: true, identity: true });
  assert.equal(await mixed(), false);
  for (const k of Object.keys(NONE)) assert.equal(await page.isChecked(`input[name="ai-sensitive-${k}"]`), true, k);

  // Kept when the page is opened again.
  await page.reload();
  await page.waitForSelector('input[name="ai-sensitive-identity"]');
  assert.equal(await page.isChecked('input[name="ai-sensitive-identity"]'), true);
  assert.equal(await page.isChecked(all), true);
  await page.uncheck('input[name="ai-sensitive-eeo"]');
  await page.waitForTimeout(200);
  assert.equal(await mixed(), true);
  assert.deepEqual(await sensitive(), { eeo: false, consent: true, legal: true, health: true, identity: true });

  // From mixed, "All of them" switches every one on; again, every one off.
  await page.check(all);
  await page.waitForTimeout(200);
  assert.deepEqual(await sensitive(), { eeo: true, consent: true, legal: true, health: true, identity: true });
  await page.uncheck(all);
  await page.waitForTimeout(200);
  assert.deepEqual(await sensitive(), NONE);
  for (const k of Object.keys(NONE)) assert.equal(await page.isChecked(`input[name="ai-sensitive-${k}"]`), false, k);
  assert.deepEqual(errors, []);
  await page.close();
});

test('backup downloads a JobToFill JSON file, with passwords and cards unless left out', async () => {
  const { readFile } = await import('node:fs/promises');
  const page = await openExt('options/options.html#backup');
  const backup = async () => {
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('text=Download backup')]);
    return JSON.parse(await readFile(await download.path(), 'utf8'));
  };
  const data = await backup();
  assert.equal(data.app, 'JobToFill');
  assert.equal(data.passwords.cards[0].number, '4242424242424242', 'as they are, like the API keys');
  await page.uncheck('text=Include passwords and cards');
  assert.equal((await backup()).passwords, undefined);
  await page.close();
});

test('popup fills the page it points at and shows a summary', async () => {
  const form = await h.open('greenhouse.html');
  const tabId = await h.tabId(form);
  const popup = await openExt(`popup/popup.html?tab=${tabId}`);
  await popup.waitForSelector('#profile option', { state: 'attached' });
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
  // Trackr's and Simplify's lists come from the cache, so the search needs no network.
  await h.bg(() =>
    globalThis.JTF.store.setDiscoverCache({
      trackr: { names: ['man group', 'man'], domains: ['man.com'], at: Date.now(), answered: 1 },
      listed: { names: [], domains: [], roles: [], at: Date.now(), answered: 1, asked: 1 },
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
  // A hedge fund search fetches only Trackr's list, but Simplify's kept copy counts too.
  assert.match(await page.textContent('#results .firm .badges'), /Not on Trackr or Simplify/);

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

test('Discover: Tech kinds, a model of its own, who to email at a checked firm, the email drawer and the outreach list', async () => {
  await h.bg(() =>
    globalThis.JTF.store.setDiscoverCache({
      trackr: { names: [], domains: [], at: Date.now(), answered: 1 },
      listed: { names: [], domains: [], roles: [], at: Date.now(), answered: 1, asked: 1 },
    }),
  );
  const page = await openExt('discover/discover.html');
  const ready = () =>
    page.waitForFunction(() => /firms in the registry/.test(document.querySelector('#registry-info').textContent));
  await ready();

  // Kinds of firm in two groups; hedge funds chosen as before.
  assert.deepEqual(await page.$$eval('#niches .niche-head', (hs) => hs.map((x) => x.textContent)), ['Finance', 'Tech']);
  assert.ok(await page.$('#niches [data-group="tech"] input[value="software"]'));
  assert.deepEqual(await page.$$eval('#niches input:checked', (is) => is.map((i) => i.value)), ['hedge']);
  assert.ok(await page.$('#place option[value="remote"]'), 'new places appear by themselves');
  assert.equal(await page.isChecked('#use-hn'), false);

  // The page's own AI: "Same as Settings" first; the effort chosen is kept.
  await page.click('#ai-box summary');
  assert.match(
    await page.$eval('#discover-provider option', (o) => o.textContent),
    /^Same as Settings \(no key yet\)$/,
  );
  await page.selectOption('#discover-effort', 'thorough');
  await until(
    h.bg,
    async () => (await globalThis.JTF.store.getSettings()).discoverAi.effort === 'thorough',
    null,
    5000,
  );
  await page.reload();
  await ready();
  assert.equal(await page.inputValue('#discover-effort'), 'thorough');
  assert.equal(await page.isDisabled('#use-ai'), true, 'no AI key here');

  // A firm whose team page names its Head of Talent: the real checks run on the fixtures, served as its website.
  await page.selectOption('#place', 'any');
  await page.selectOption('#size', 'any');
  await page.click('#search');
  await page.waitForSelector('#results .firm');
  const id = await page.$eval('#results .firm', (li) => li.dataset.id);
  const found = await page.evaluate(
    async ([home, base]) => {
      const { discover: D, discoverContacts: C } = globalThis.JTF;
      // quiet.example's home page is the fixture, which links to its team and careers pages; any other address is
      // missing (answered here, so the console stays clean).
      const fetchFn = (u, init) => {
        const url = new URL(u);
        if (/(^|\.)quiet\.example$/.test(url.hostname) && url.pathname === '/') return fetch(home, init);
        if (/^discover-(home|team|careers)\.html$/.test(url.pathname.slice(1)) && u.startsWith(base))
          return fetch(u, init);
        return Promise.resolve(new Response('Not found', { status: 404 }));
      };
      const firm = {
        id: 'x',
        name: 'Quiet Capital',
        aliases: [],
        domain: 'quiet.example',
        site: 'https://quiet.example',
        cities: ['London'],
        tags: [],
      };
      const result = await D.careers(firm, { fetch: fetchFn, guess: false });
      const contacts = await C.findContacts(firm, { fetch: fetchFn, pages: result.pages });
      return { result, contacts };
    },
    [h.url('discover-home.html'), h.url('')],
  );
  const best = found.contacts.best.map((b) => b.address);
  assert.ok(best.includes('jane.doe@quiet.example'), JSON.stringify(found.contacts.best));
  assert.ok(!best.includes('press@quiet.example'), 'never the press office');
  await h.bg(
    async ([firmId, f]) => {
      const { store } = globalThis.JTF;
      await store.setDiscoverCache({
        careers: { [firmId]: { at: Date.now(), result: f.result } },
        contacts: { [firmId]: { at: Date.now(), result: f.contacts } },
      });
      await store.setOutreach(firmId, {
        firm: { id: firmId, name: 'Quiet Capital', domain: 'quiet.example', site: 'https://quiet.example' },
        status: 'sent',
        to: 'jane.doe@quiet.example',
        subject: 'Summer internship',
        contact: { name: 'Jane Doe', title: 'Head of Talent', email: 'jane.doe@quiet.example', guessed: false },
      });
    },
    [id, found],
  );
  await page.reload();
  await ready();
  await page.selectOption('#place', 'any');
  await page.selectOption('#size', 'any');
  await page.click('#search');
  const card = `#results .firm[data-id="${id}"]`;
  await page.waitForSelector(`${card} .contacts`);
  const text = await page.textContent(card);
  assert.match(text, /Who to email/);
  assert.match(text, /Best way in: Programme page/);
  assert.match(text, /Jane Doe, Head of Talent/);
  assert.match(text, /Addresses here follow first\.last@quiet\.example \(2 seen\)/);
  assert.ok(await page.$(`${card} .contacts a[href="mailto:jane.doe@quiet.example"]`));
  assert.ok(await page.$(`${card} .contacts .pill.ok:text-is("Listed")`));
  assert.match(await page.textContent(`${card} .outreach-pill`), /^Sent \d+ \w+/);
  assert.equal(await page.textContent(`${card} button.check`), 'Check again');
  assert.equal(await page.isDisabled(`${card} button.draft`), true, 'drafting needs an AI key');
  await page.check('#sort-way');
  assert.equal(await page.$eval('#results .firm', (li) => li.dataset.id), id, 'the checked firm comes first');

  // Hacker News posts (from the cache: no network) join a tech search, never a finance-only one.
  await h.bg(() =>
    globalThis.JTF.store.setDiscoverCache({
      hn: {
        posts: [
          {
            company: 'Tinyco',
            domain: 'tinyco.example',
            site: 'https://tinyco.example',
            urls: [],
            // "NY, SF, London, UK & Toronto": a post's country is its first location's, yet it names London.
            locations: ['New York', 'London'],
            remote: true,
            text: 'Tinyco builds lab software.',
            hnUrl: 'https://news.ycombinator.com/item?id=1',
            month: 'November 2026',
            roles: ['Software Engineering Intern'],
            emails: ['jobs@tinyco.example'],
            kinds: ['intern'],
            postedAt: '2026-11-02',
            boards: [],
          },
        ],
        threads: [],
        at: Date.now(),
        answered: 1,
        asked: 1,
      },
    }),
  );
  const searched = async () => {
    await page.click('#search');
    await page.waitForFunction(() => !document.querySelector('#search').disabled);
  };
  const hnCard = '#results .firm[data-id="hn:tinyco.example"]';
  await page.check('#use-hn');
  await searched();
  assert.equal(await page.$(hnCard), null, 'hedge funds only');
  assert.match(await page.textContent('#status'), /Hacker News posts are tech: tick a Tech kind of firm to see them\./);
  await page.uncheck('#niches input[value="hedge"]');
  await page.check('#niches input[value="software"]');
  await page.selectOption('#place', 'remote');
  await searched();
  const hnText = await page.textContent(hnCard);
  assert.match(hnText, /Software Engineering Intern/);
  assert.match(hnText, /Apply by email: jobs@tinyco\.example/);
  assert.match(hnText, /Remote/);
  assert.equal(await page.getAttribute(`${hnCard} a.pill.hn`, 'href'), 'https://news.ycombinator.com/item?id=1');
  assert.ok(await page.$(`${hnCard} button.draft`), 'its address is someone to write to');
  assert.match(await page.textContent('#status'), /1 Hacker News post among them/);
  // A London search finds it by the city it names, whatever country its first location gave it.
  await page.selectOption('#place', 'london');
  await searched();
  assert.ok(await page.$(hnCard), 'a post naming London fits a London search');
  await page.selectOption('#place', 'paris');
  await searched();
  assert.equal(await page.$(hnCard), null, 'not a Paris one');

  // The outreach tab lists the record, with its status, and exports it.
  await page.click('#tab-outreach');
  assert.equal(await page.textContent('#outreach-count'), '1');
  const row = `#outreach .outreach-item[data-id="${id}"]`;
  assert.match(await page.textContent(row), /Quiet Capital[\s\S]*Jane Doe, Head of Talent jane\.doe@quiet\.example/);
  assert.equal(await page.inputValue(`${row} select`), 'sent');
  await page.selectOption(`${row} select`, 'replied');
  await until(h.bg, async (i) => (await globalThis.JTF.store.getOutreach())[i].status === 'replied', id, 5000);
  await page.fill(`${row} textarea`, 'Call back in January');
  await until(
    h.bg,
    async (i) => (await globalThis.JTF.store.getOutreach())[i].notes === 'Call back in January',
    id,
    5000,
  );
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#outreach-export')]);
  assert.match(download.suggestedFilename(), /^jobtofill-outreach-\d{4}-\d\d-\d\d\.csv$/);
  const csv = await readFile(await download.path(), 'utf8');
  assert.match(csv, /^\ufeffFirm,Website,Contact name,Title,Email,Guessed,Status,Date,Subject,Notes,Best way in\r\n/);
  assert.match(
    csv,
    /Quiet Capital,https:\/\/quiet\.example,Jane Doe,Head of Talent,jane\.doe@quiet\.example,no,Replied,/,
  );
  assert.match(csv, /Summer internship,Call back in January,Programme page\r\n$/);

  await h.bg((i) => globalThis.JTF.store.removeOutreach(i), id);

  // With an AI (a stand-in provider, answered here) and Claude's key for the page's own model.
  await h.context.route('https://ai.test/**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        model: 'mock',
        choices: [{ message: { content: JSON.stringify(DRAFT) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      }),
    }),
  );
  await h.context.route('https://api.anthropic.com/**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [{ id: 'claude-e2e' }] }) }),
  );
  const before = await h.bg(async () => {
    const { store } = globalThis.JTF;
    const { profile } = await store.getActive();
    const was = { ai: (await store.getSettings()).ai, personal: { ...profile.personal } };
    was.notes = (await store.getKit(profile.id)).notes || '';
    profile.personal.firstName = 'Ada';
    profile.personal.lastName = 'Lovelace';
    await store.saveProfile(profile);
    await store.saveKit(profile.id, {
      notes: 'Built a reconciliation tool in Python that checks 40,000 trades a night.',
    });
    await store.setAiKey('sk-ant-e2e', 'anthropic');
    await store.setAiKey('test-key', 'custom');
    await store.saveAiSettings({ provider: 'custom', baseUrl: 'https://ai.test/v1', model: 'mock' });
    return was;
  });
  await page.reload();
  await ready();
  await page.click('#tab-find');

  // “Another model…” stays chosen while its id is typed.
  await page.click('#ai-box summary');
  await page.selectOption('#discover-provider', 'anthropic');
  const choice = 'select[name="discover-model-choice"]';
  await page.waitForSelector(choice);
  await page.$eval('#ai-saved', (s) => (s.textContent = ''));
  await page.selectOption(choice, '\u0000another');
  await page.waitForFunction(() => document.querySelector('#ai-saved').textContent === 'Saved.');
  assert.equal(await page.inputValue(choice), '\u0000another');
  await page.fill('input[name="discover-model"]', 'claude-e2e');
  await page.press('input[name="discover-model"]', 'Tab');
  await until(
    h.bg,
    async () => (await globalThis.JTF.store.getSettings()).discoverAi.model === 'claude-e2e',
    null,
    5000,
  );
  assert.equal(await page.inputValue(choice), '\u0000another');
  assert.equal(await page.inputValue('input[name="discover-model"]'), 'claude-e2e');
  await page.selectOption('#discover-provider', '');

  // Thorough mode says on the check buttons that a page may go to the AI.
  await page.selectOption('#place', 'any');
  await page.selectOption('#size', 'any');
  await searched();
  assert.match(await page.getAttribute(`${card} button.check`, 'title'), /^In Thorough mode a careers page the rules/);
  assert.match(await page.getAttribute('#check-top', 'title'), /also read by your AI model \(one call each\)\.$/);

  // A draft to the first address; another “To” greets them instead, and Mark as sent records them.
  await page.click(`${card} button.draft`);
  const to = `${card} select[name="contact"]`;
  const body = `${card} textarea[name="body"]`;
  assert.equal(await page.inputValue(to), 'internships@quiet.example');
  await page.click(`${card} button.draft-go`);
  await page.waitForSelector(body);
  assert.match(await page.inputValue(body), /^Dear .+ recruiting team,\n\nI am a final-year/);
  assert.equal(await page.isVisible(`${card} .redraft`), false);
  await page.selectOption(to, 'jane.doe@quiet.example');
  assert.match(await page.inputValue(body), /^Dear Jane,\n\nI am a final-year/);
  assert.equal(
    await page.textContent(`${card} .redraft`),
    'Drafted for internships@quiet.example; press Draft again to write it for Jane Doe.',
  );
  assert.match(await page.getAttribute(`${card} a.open-mail`, 'href'), /^mailto:jane\.doe@quiet\.example\?subject=/);
  await page.click(`${card} button.mark-sent`);
  const record = await until(
    h.bg,
    async (i) => {
      const r = (await globalThis.JTF.store.getOutreach())[i];
      return r && r.status === 'sent' && r;
    },
    id,
    5000,
  );
  assert.deepEqual([record.to, record.contact.name], ['jane.doe@quiet.example', 'Jane Doe']);

  await h.context.unroute('https://ai.test/**');
  await h.context.unroute('https://api.anthropic.com/**');
  await h.bg(
    async ([i, was]) => {
      const { store } = globalThis.JTF;
      await store.removeOutreach(i);
      await store.saveDiscoverAi({ provider: '', effort: 'quick' });
      await store.setAiKey('', 'anthropic');
      await store.setAiKey('', 'custom');
      await store.saveSettings({ ai: was.ai });
      const { profile } = await store.getActive();
      profile.personal = was.personal;
      await store.saveProfile(profile);
      await store.saveKit(profile.id, { notes: was.notes });
    },
    [id, before],
  );
  assert.deepEqual(errors, []);
  await page.close();
});

test('settings: what Learn from this page saves while the page is open stays, through edits made there', async () => {
  const page = await openExt('options/options.html#personal');
  await page.waitForSelector('input[name="contact.phone"]');
  // Popup › Learn from this page › Save, as saveLearned writes it: skills and a custom answer.
  const learn = (skills, id) =>
    h.bg(
      async ([s, i]) => {
        const { profile } = await globalThis.JTF.store.getActive();
        profile.skills = s;
        profile.customAnswers.push({ id: i, question: `learned ${i}`, answer: 'Analytical' });
        await globalThis.JTF.store.saveProfile(profile);
      },
      [skills, id],
    );
  const stored = (fn, arg) => until(h.bg, fn, arg, 5000);
  // The person last clicked into a box here, then went to the application's tab: the box still has focus.
  await page.focus('input[name="contact.phone"]');
  await learn('Python, SQL, Haskell', 'learned1');
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => document.activeElement.name), 'contact.phone', 'the box keeps its focus');
  // One edit here later doesn't write the page's old copy over it.
  await page.fill('input[name="personal.middleName"]', 'Augusta');
  await page.waitForSelector('#save-state.saved');
  await page.waitForTimeout(300);
  let p = await profile();
  assert.equal(p.personal.middleName, 'Augusta');
  assert.equal(p.skills, 'Python, SQL, Haskell');
  assert.ok(p.customAnswers.some((a) => a.id === 'learned1'));

  // In the middle of typing: what is typed is saved beside the change, and typing carries on where it was.
  await page.fill('input[name="personal.preferredName"]', 'Ada');
  await learn('Python, SQL, Haskell, OCaml', 'learned2');
  await stored(async () => (await globalThis.JTF.store.getActive()).profile.personal.preferredName === 'Ada');
  await page.keyboard.type(' L');
  await page.waitForSelector('#save-state.saved');
  await page.waitForTimeout(300);
  assert.equal(await page.inputValue('input[name="personal.preferredName"]'), 'Ada L');
  p = await profile();
  assert.equal(p.personal.preferredName, 'Ada L');
  assert.equal(p.skills, 'Python, SQL, Haskell, OCaml');
  assert.deepEqual(
    p.customAnswers.filter((a) => /^learned/.test(a.id)).map((a) => a.id),
    ['learned1', 'learned2'],
  );
  // And the page shows it.
  await page.click('#nav a[href="#writing"]');
  assert.equal(await page.inputValue('textarea[name="skills"]'), 'Python, SQL, Haskell, OCaml');

  // Typed just before the tab is closed: saved all the same.
  await page.click('#nav a[href="#personal"]');
  await page.fill('input[name="personal.pronouns"]', 'she/they');
  await page.close();
  await stored(async () => (await globalThis.JTF.store.getActive()).profile.personal.pronouns === 'she/they');
  p = await profile();
  assert.equal(p.skills, 'Python, SQL, Haskell, OCaml');
  assert.deepEqual(errors, []);
});

test('passwords: a saved login’s username and password are saved as typed, also when the tab closes straight after', async () => {
  await h.bg(() =>
    globalThis.JTF.passwords.update((d) => {
      d.credentials.push({
        id: 'typed1',
        host: 'typed.example.com',
        username: 'old@example.com',
        password: 'Old-pass1!',
        createdAt: 1,
        updatedAt: 1,
      });
    }),
  );
  // Polled in the background until the saved login holds `value` in `key`.
  const saved = (key, value) =>
    until(
      h.bg,
      async ([k, v]) => (await globalThis.JTF.passwords.read()).credentials.find((c) => c.id === 'typed1')[k] === v,
      [key, value],
      5000,
    );
  const page = await openExt('options/options.html#passwords');
  const row = 'tbody tr:has(td:text-is("typed.example.com"))';
  await page.waitForSelector(row);
  // Typed, still in the box: saved after a pause, and the section isn't drawn again under the cursor.
  await page.fill(`${row} input[aria-label^="Username"]`, 'new@example.com');
  await saved('username', 'new@example.com');
  assert.equal(
    await page.evaluate(() => document.activeElement.getAttribute('aria-label')),
    'Username for typed.example.com',
  );
  // Typed, then the tab closed at once: no "change" ever comes.
  await page.fill(`${row} .secret input`, 'New-pass2!');
  await page.close();
  await saved('password', 'New-pass2!');
  await h.bg(() =>
    globalThis.JTF.passwords.update((d) => (d.credentials = d.credentials.filter((c) => c.id !== 'typed1'))),
  );
  assert.deepEqual(errors, []);
});
