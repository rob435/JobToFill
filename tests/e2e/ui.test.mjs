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

test('Discover: Find people searches the web, keeps what the results show, and Send goes from the inbox with the CV', async () => {
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
  await page.selectOption('#place', 'any');
  await page.selectOption('#size', 'any');
  await page.click('#search');
  await page.waitForSelector('#results .firm');
  const id = await page.$eval('#results .firm', (li) => li.dataset.id);
  const card = `#results .firm[data-id="${id}"]`;
  // Its site was checked already (the fixtures, as in the test above): no person in technology there.
  const found = await page.evaluate(
    async ([home, base]) => {
      const { discover: D, discoverContacts: C } = globalThis.JTF;
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

  // Claude searches the web (answered here): a LinkedIn result names the firm's head of engineering, a directory
  // states its format; the model also names someone no result shows.
  const asked = [];
  // The card is a registry firm whose site check came from the fixtures: the results name that firm.
  const name = (await page.textContent(`${card} .firm-name`)).trim();
  const SEARCH_REPLY = {
    model: 'claude-sonnet-5-5',
    stop_reason: 'end_turn',
    content: [
      { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: `${name} head of engineering` } },
      {
        type: 'web_search_tool_result',
        tool_use_id: 's1',
        content: [
          {
            type: 'web_search_result',
            url: 'https://uk.linkedin.com/in/tom-brown',
            title: `Tom Brown - Head of Engineering - ${name} | LinkedIn`,
            encrypted_content: 'x',
          },
        ],
      },
      {
        type: 'text',
        text: JSON.stringify({
          website: 'https://quiet.example',
          people: [
            {
              name: 'Tom Brown',
              title: 'Head of Engineering',
              group: 'technology',
              url: 'https://uk.linkedin.com/in/tom-brown',
            },
            { name: 'Made Up', title: 'CTO', url: 'https://uk.linkedin.com/in/made-up' },
          ],
          emails: [],
          format: { pattern: 'first.last' },
        }),
        citations: [
          {
            type: 'web_search_result_location',
            url: 'https://rocketreach.co/quiet-capital-email-format',
            title: 'Quiet Capital Email Format',
            cited_text:
              'The most common Quiet Capital email format is [first].[last] (ex. jane.doe@quiet.example), used 91% of the time.',
          },
        ],
      },
    ],
    usage: { input_tokens: 1200, output_tokens: 300, server_tool_use: { web_search_requests: 1 } },
  };
  await h.context.route('https://api.anthropic.com/**', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    asked.push(body);
    const reply = body.tools
      ? SEARCH_REPLY
      : {
          model: 'claude-sonnet-5-5',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: JSON.stringify(DRAFT) }],
          usage: { input_tokens: 10, output_tokens: 10 },
        };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(reply) });
  });
  // The website the model gives is read to confirm it: answered here with a page that names another firm.
  await h.context.route('https://quiet.example/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><title>Elsewhere</title><p>Another firm entirely.</p></html>',
    }),
  );
  await h.context.route('https://dns.google/**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ Status: 0, Answer: [{ type: 15, data: '10 mx.quiet.example.' }] }),
    }),
  );
  const sent = [];
  await h.context.route('https://api.us.nylas.com/**', async (route) => {
    const url = new URL(route.request().url());
    if (/\/messages\/send$/.test(url.pathname)) {
      sent.push(JSON.parse(route.request().postData()));
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ data: { id: 'm-1', thread_id: 't-1' } }),
      });
    }
    if (/\/grants\/g-1$/.test(url.pathname))
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          data: { id: 'g-1', provider: 'google', scope: ['https://www.googleapis.com/auth/gmail.compose'] },
        }),
      });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [] }) });
  });
  const before = await h.bg(
    async ([firmId, f]) => {
      const { store } = globalThis.JTF;
      await store.setDiscoverCache({
        careers: { [firmId]: { at: Date.now(), result: f.result } },
        contacts: { [firmId]: { at: Date.now(), result: f.contacts } },
      });
      const { profile } = await store.getActive();
      const was = { ai: (await store.getSettings()).ai, personal: { ...profile.personal } };
      profile.personal.firstName = 'Ada';
      profile.personal.lastName = 'Lovelace';
      await store.saveProfile(profile);
      await store.saveKit(profile.id, {
        notes: 'Built a reconciliation tool in Python that checks 40,000 trades a night.',
      });
      await store.setDoc(profile.id, 'resume', {
        name: 'Ada Lovelace CV.pdf',
        type: 'application/pdf',
        dataUrl: 'data:application/pdf;base64,' + btoa('%PDF-1.4 e2e'),
      });
      await store.setAiKey('sk-ant-e2e', 'anthropic');
      await store.saveAiSettings({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
      await store.setNylas({ apiKey: 'nyk_e2e', region: 'us', grantId: 'g-1', email: 'ada@example.org' });
      return was;
    },
    [id, found],
  );
  await page.reload();
  await ready();
  await page.selectOption('#place', 'any');
  await page.selectOption('#size', 'any');
  await page.click('#search');
  await page.waitForSelector(`${card} .contacts`);
  assert.match(await page.getAttribute(`${card} button.research-go`, 'title'), /nothing about you/);

  await page.click(`${card} button.research-go`);
  await page.waitForSelector(`${card} .research details`);
  // Recruiting first (the mailboxes, then the Head of Talent), then the head of engineering: shown with the rest.
  await page.click(`${card} .contacts button.link`);
  const search = asked.find((b) => b.tools);
  assert.equal(search.tools[0].name, 'web_search');
  assert.doesNotMatch(JSON.stringify(search.messages), /Ada|Lovelace|reconciliation/, 'nothing about the person');
  const who = await page.textContent(`${card} .contacts`);
  assert.match(who, /Tom Brown, Head of Engineering/);
  assert.ok(await page.$(`${card} .contacts a[href="mailto:tom.brown@quiet.example"]`));
  assert.ok(await page.$(`${card} .contacts .pill:text-is("Likely")`));
  assert.ok(await page.$(`${card} .contacts a.source:text-is("LinkedIn")`));
  assert.doesNotMatch(who, /Made Up/);
  assert.match(
    await page.textContent(`${card} .research details summary`),
    /^Left out: \d+ claims no source bore out$/,
  );
  assert.match(
    await page.textContent(`${card} .research details ul`),
    /Made Up, CTO: no source names them with the firm/,
  );
  assert.match(
    await page.textContent(`${card} .research`),
    /Address format: first\.last@quiet\.example \(2 addresses on its site\)/,
  );

  // The draft to Tom, sent from the connected inbox with the CV, after asking.
  await page.click(`${card} button.draft`);
  await page.selectOption(`${card} select[name="contact"]`, 'tom.brown@quiet.example');
  await page.click(`${card} button.draft-go`);
  await page.waitForSelector(`${card} textarea[name="body"]`);
  assert.match(await page.inputValue(`${card} textarea[name="body"]`), /^Dear Tom,\n\n/);
  assert.match(
    await page.textContent(`${card} .send`),
    /Attach my CV \(Ada Lovelace CV\.pdf\)[\s\S]*From ada@example\.org/,
  );
  let question = '';
  page.once('dialog', (d) => ((question = d.message()), d.accept()));
  await page.click(`${card} button.send-go`);
  await page.waitForSelector(`${card} .send .ok-text`);
  assert.match(
    question,
    /^Send this email to Tom Brown <tom\.brown@quiet\.example> from ada@example\.org, with Ada Lovelace CV\.pdf attached\?/,
  );
  assert.match(question, /isn’t confirmed: it may bounce/);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, [{ email: 'tom.brown@quiet.example', name: 'Tom Brown' }]);
  assert.match(sent[0].body, /^<p>Dear Tom,<\/p>/);
  assert.equal(sent[0].attachments[0].filename, 'Ada Lovelace CV.pdf');
  assert.equal(atob(sent[0].attachments[0].content), '%PDF-1.4 e2e');
  const record = await until(
    h.bg,
    async (i) => {
      const r = (await globalThis.JTF.store.getOutreach())[i];
      return r && r.status === 'sent' && r;
    },
    id,
    5000,
  );
  assert.deepEqual([record.to, record.via, record.threadId], ['tom.brown@quiet.example', 'nylas', 't-1']);
  assert.equal(await page.textContent(`${card} button.send-go`), 'Sent');

  await h.context.unroute('https://api.anthropic.com/**');
  await h.context.unroute('https://dns.google/**');
  await h.context.unroute('https://quiet.example/**');
  await h.context.unroute('https://api.us.nylas.com/**');
  await h.bg(
    async ([i, was]) => {
      const { store } = globalThis.JTF;
      await store.removeOutreach(i);
      await store.setAiKey('', 'anthropic');
      await store.saveSettings({ ai: was.ai });
      await store.setNylas(null);
      const { profile } = await store.getActive();
      profile.personal = was.personal;
      await store.saveProfile(profile);
      await store.removeDoc(profile.id, 'resume');
      await store.saveKit(profile.id, { notes: '' });
    },
    [id, before],
  );
  assert.deepEqual(errors, []);
  await page.close();
});

test('Discover: Review prepares a firm’s email by itself, shows it with big buttons and keys, sends it after five seconds, and offers a follow-up', async () => {
  await h.bg(() =>
    globalThis.JTF.store.setDiscoverCache({
      trackr: { names: [], domains: [], at: Date.now(), answered: 1 },
      listed: { names: [], domains: [], roles: [], at: Date.now(), answered: 1, asked: 1 },
    }),
  );
  let page = await openExt('discover/discover.html');
  const ready = () =>
    page.waitForFunction(() => /firms in the registry/.test(document.querySelector('#registry-info').textContent));
  await ready();
  await page.selectOption('#place', 'any');
  await page.selectOption('#size', 'any');
  await page.click('#search');
  await page.waitForSelector('#results .firm');
  const id = await page.$eval('#results .firm', (li) => li.dataset.id);
  const card = `#results .firm[data-id="${id}"]`;
  // The first firm's site was checked already (the fixtures, as above), so preparing it needs no network.
  const found = await page.evaluate(
    async ([home, base]) => {
      const { discover: D, discoverContacts: C } = globalThis.JTF;
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
      };
      const result = await D.careers({ ...firm, cities: ['London'], tags: [] }, { fetch: fetchFn, guess: false });
      const contacts = await C.findContacts(firm, { fetch: fetchFn, pages: result.pages });
      return { result, contacts };
    },
    [h.url('discover-home.html'), h.url('')],
  );
  const asked = [];
  await h.context.route('https://ai.test/**', (route) => {
    asked.push(JSON.parse(route.request().postData() || '{}'));
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        model: 'mock',
        choices: [{ message: { content: JSON.stringify(DRAFT) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      }),
    });
  });
  const sent = [];
  const cancelled = [];
  await h.context.route('https://api.us.nylas.com/**', async (route) => {
    const url = new URL(route.request().url());
    if (/\/messages\/send$/.test(url.pathname)) {
      const message = JSON.parse(route.request().postData());
      sent.push(message);
      // A scheduled send is accepted with a schedule id and no message yet, as Nylas answers it.
      const data = message.send_at
        ? { schedule_id: `s-${sent.length}`, send_at: message.send_at }
        : { id: `m-${sent.length}`, thread_id: 't-1' };
      return route.fulfill({
        status: message.send_at ? 202 : 200,
        contentType: 'application/json',
        body: JSON.stringify({ data }),
      });
    }
    const schedule = url.pathname.match(/\/messages\/schedules\/([^/]+)$/);
    if (schedule && route.request().method() === 'DELETE') {
      cancelled.push(schedule[1]);
      return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ data: {} }) });
    }
    if (/\/grants\/g-1$/.test(url.pathname))
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          data: { id: 'g-1', provider: 'google', scope: ['https://www.googleapis.com/auth/gmail.compose'] },
        }),
      });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [] }) });
  });
  const before = await h.bg(
    async ([firmId, f]) => {
      const { store } = globalThis.JTF;
      await store.setDiscoverCache({
        careers: { [firmId]: { at: Date.now(), result: f.result } },
        contacts: { [firmId]: { at: Date.now(), result: f.contacts } },
      });
      const { profile } = await store.getActive();
      const was = { ai: (await store.getSettings()).ai, personal: { ...profile.personal } };
      profile.personal.firstName = 'Ada';
      profile.personal.lastName = 'Lovelace';
      await store.saveProfile(profile);
      await store.saveKit(profile.id, {
        notes: 'Built a reconciliation tool in Python that checks 40,000 trades a night.',
      });
      await store.setDoc(profile.id, 'resume', {
        name: 'Ada Lovelace CV.pdf',
        type: 'application/pdf',
        dataUrl: 'data:application/pdf;base64,' + btoa('%PDF-1.4 e2e'),
      });
      await store.setAiKey('test-key', 'custom');
      await store.saveAiSettings({ provider: 'custom', baseUrl: 'https://ai.test/v1', model: 'mock' });
      await store.setNylas({ apiKey: 'nyk_e2e', region: 'us', grantId: 'g-1', email: 'ada@example.org' });
      return was;
    },
    [id, found],
  );
  await page.reload();
  await ready();
  await page.selectOption('#place', 'any');
  await page.selectOption('#size', 'any');
  await page.click('#search');
  await page.waitForSelector(`${card} .contacts`);
  assert.match(await page.textContent('#write-top'), /^Write to the top 10$/);

  // One press: the firm is checked (cached), its email drafted, and Review shows it with the big buttons.
  await page.click(`${card} button.write-go`);
  const box = '#review-card textarea.body';
  await page.waitForSelector(`#review-view:not([hidden]) ${box}`);
  assert.equal(await page.getAttribute('#tab-review', 'aria-selected'), 'true');
  assert.equal(
    (await page.textContent('#review-card h2')).trim(),
    (await page.textContent(`${card} .firm-name`)).trim(),
  );
  assert.match(await page.textContent('#review-progress'), /1 of 1/);
  assert.match(await page.inputValue(box), /^Dear .+ recruiting team,\n\nI am a final-year/);
  assert.match(await page.textContent('#review-card .to-line'), /internships@quiet\.example/);
  assert.match(await page.textContent('#review-card .reason'), /opens with what the firm does/, 'no web search here');
  assert.equal(await page.isVisible('#review-keys'), true);
  assert.equal(await page.textContent(`${card} button.write-go`), 'In Review');
  // Arriving in their morning depends on the hour: off here, so it sends now.
  await page.uncheck('#their-morning');
  await until(
    h.bg,
    async () => (await globalThis.JTF.store.getSettings()).discoverAi.theirMorning === false,
    null,
    5000,
  );
  // The card is drawn again once the page has read the setting back (at night in London it said "arrives…" until then).
  await page.waitForFunction(() => document.querySelector('#review-card .send-go').textContent === 'Send');

  // C: someone else, greeted by name; the email was written for the mailbox, so Send asks twice until R writes it again.
  for (let i = 0; i < 6 && !/jane\.doe@/.test(await page.textContent('#review-card .to-line')); i++)
    await page.keyboard.press('c');
  assert.match(
    await page.textContent('#review-card .to-line'),
    /Jane Doe, Head of Talent[\s\S]*jane\.doe@quiet\.example/,
  );
  assert.match(await page.inputValue(box), /^Dear Jane,\n\n/);
  // A press in a card's first moment is taken for the card before: a person reads first.
  await page.waitForTimeout(700);
  await page.keyboard.press('Control+Enter');
  await page.waitForSelector('#review-card .send-go.armed');
  assert.match(await page.textContent('#review-card .doubts'), /You changed who it goes to/);
  assert.equal(sent.length, 0);
  const drafts = asked.length;
  await page.keyboard.press('r');
  await until(
    async () => asked.length > drafts && !(await page.$('#review-card .steps')),
    () => true,
    null,
    10000,
  );
  await page.waitForSelector(box);
  assert.match(await page.inputValue(box), /^Dear Jane,\n\n/);
  assert.equal(await page.$('#review-card .send-go.armed'), null);

  /**
   * Ctrl+Enter, and again if the email has a doubt to accept (a check the stand-in's draft failed); `typed`: each
   * straight after typing at the end of the email, the cursor still in it.
   */
  const send = async (typed) => {
    const press = async () => {
      await page.waitForTimeout(700);
      if (typed) {
        await page.click(box);
        await page.keyboard.press('Control+End');
        await page.keyboard.type('.');
      }
      await page.keyboard.press('Control+Enter');
    };
    await press();
    await page.waitForFunction(
      () => document.querySelector('#review-card .send-go.armed') || /Sending to/.test(document.body.textContent),
    );
    if (await page.$('#review-card .send-go.armed')) await press();
    await page.waitForSelector('#review-view .toast');
  };
  // Sent in five seconds unless Undo: U takes it back, and nothing went. Pressed straight after sending from the email
  // box too: the card the person's own Ctrl+Enter drew away isn't typing drawn away under them, so U isn't swallowed.
  await send(true);
  assert.match(await page.textContent('#review-view .toast'), /^Sending to jane\.doe@quiet\.example…Undo/);
  await page.keyboard.press('u');
  await page.waitForSelector(box);
  assert.match(await page.textContent('#review-view .toast'), /Not sent to jane\.doe@quiet\.example\./);
  await page.waitForTimeout(5500);
  assert.equal(sent.length, 0, 'undone');

  await send();
  await until(
    async () => sent.length === 1,
    () => true,
    null,
    10000,
  );
  assert.deepEqual(sent[0].to, [{ email: 'jane.doe@quiet.example', name: 'Jane Doe' }]);
  assert.match(sent[0].body, /^<p>Dear Jane,<\/p>/);
  assert.equal(sent[0].attachments[0].filename, 'Ada Lovelace CV.pdf');
  assert.equal(sent[0].send_at, undefined, 'sent now');
  const record = await until(
    h.bg,
    async (i) => {
      const r = (await globalThis.JTF.store.getOutreach())[i];
      return r && r.status === 'sent' && r;
    },
    id,
    5000,
  );
  assert.deepEqual(
    [record.to, record.via, record.messageId, record.threadId],
    ['jane.doe@quiet.example', 'nylas', 'm-1', 't-1'],
  );
  assert.match(record.body, /^Dear Jane,\n\nI am a final-year/);
  await page.waitForFunction(() => /All read/.test(document.querySelector('#review-card').textContent));
  assert.match(await page.textContent('#review-card'), /1 sent/);

  // A week on without a reply: the queue offers a follow-up, written for the same thread, with no attachment.
  await h.bg((i) => globalThis.JTF.store.setOutreach(i, { sentAt: Date.now() - 9 * 864e5 }), id);
  await page.reload();
  await ready();
  await page.click('#tab-review');
  await page.waitForSelector('#follow-due:not([hidden])');
  assert.match(
    await page.textContent('#follow-due'),
    /^1 email sent from here has had no reply for five working days\./,
  );
  assert.match(await page.textContent('#review-card'), /All read[\s\S]*1 sent/, 'the queue as it was left');
  await page.click('#follow-due button');
  await page.waitForSelector(box);
  assert.match(await page.inputValue('#review-card input.subject'), /^Re: /);
  assert.match(await page.textContent('#review-card .review-head'), /Follow-up/);
  await send();
  await until(
    async () => sent.length === 2,
    () => true,
    null,
    10000,
  );
  assert.equal(sent[1].reply_to_message_id, 'm-1', 'in the same thread');
  assert.deepEqual(sent[1].attachments || [], []);
  await until(h.bg, async (i) => !!(await globalThis.JTF.store.getOutreach())[i].followedUpAt, id, 5000);
  assert.equal(await page.isVisible('#follow-due'), false);

  // On a Saturday, with Arrive at 8:10 their time on: the email waits at Nylas for Monday morning in the firm's city,
  // and Take it back deletes it there.
  const saturday = Date.parse('2026-11-21T12:00:00Z');
  // The page closed first: it stores its queue as it goes, so the queue is emptied after that. The firm's check is
  // dated that day, so it's still fresh then.
  await page.close();
  await h.bg(
    async ([i, f, at]) => {
      const { store } = globalThis.JTF;
      await store.removeOutreach(i);
      await store.setDiscoverCache({
        queue: { items: [], at: 0, savedAt: Date.now() },
        careers: { [i]: { at, result: f.result } },
        contacts: { [i]: { at, result: f.contacts } },
      });
    },
    [id, found, saturday],
  );
  // Saturday, with time running from there (a frozen clock would hold every card in its first moment).
  page = await h.context.newPage();
  page.on('pageerror', (e) => errors.push(`discover/discover.html: ${e.message}`));
  await page.clock.install({ time: saturday });
  await page.goto(h.extUrl('discover/discover.html#review'));
  await ready();
  await page.check('#their-morning');
  await until(h.bg, async () => (await globalThis.JTF.store.getSettings()).discoverAi.theirMorning, null, 5000);
  await page.click('#tab-find');
  await page.selectOption('#place', 'any');
  await page.selectOption('#size', 'any');
  await page.click('#search');
  await page.click(`${card} button.write-go`);
  await page.waitForSelector(box);
  assert.equal(await page.textContent('#review-card .send-go'), 'Send · arrives in their morning');
  assert.match(
    await page.textContent('#review-card'),
    /arrives Mon 08:10 in \w[\w ]*, as it’s outside their working day now/,
  );
  await send();
  await until(
    async () => sent.length === 3,
    () => true,
    null,
    10000,
  );
  assert.ok(sent[2].send_at * 1000 > Date.parse('2026-11-23T00:00:00Z'), 'Monday');
  const take = '#review-view .toast button:text-is("Take it back")';
  await page.waitForSelector(take);
  assert.match(
    await page.textContent('#review-view .toast'),
    /Arrives Mon 08:10 in [\s\S]*Until then it waits at Nylas\./,
  );
  const waiting = await h.bg(async (i) => (await globalThis.JTF.store.getOutreach())[i], id);
  assert.deepEqual([waiting.status, waiting.scheduleId, waiting.messageId], ['sent', 's-3', '']);
  await page.click(take);
  await until(h.bg, async (i) => (await globalThis.JTF.store.getOutreach())[i].status === 'drafted', id, 5000);
  assert.deepEqual(cancelled, ['s-3']);
  await page.waitForSelector(box);

  // Closed first: the page stores its queue as it goes (and leaves a copy in the extension's localStorage, dated by
  // the Saturday clock, which stays installed for the context: cleared too).
  await page.close();
  const blank = await openExt('options/options.html');
  await blank.evaluate(() => localStorage.clear());
  await blank.close();
  await h.context.unroute('https://ai.test/**');
  await h.context.unroute('https://api.us.nylas.com/**');
  await h.bg(
    async ([i, was]) => {
      const { store } = globalThis.JTF;
      await store.removeOutreach(i);
      await store.setDiscoverCache({ queue: { items: [], at: 0 } });
      await store.saveDiscoverAi({ theirMorning: true });
      await store.setAiKey('', 'custom');
      await store.saveSettings({ ai: was.ai });
      await store.setNylas(null);
      const { profile } = await store.getActive();
      profile.personal = was.personal;
      await store.saveProfile(profile);
      await store.removeDoc(profile.id, 'resume');
      await store.saveKit(profile.id, { notes: '' });
    },
    [id, before],
  );
  assert.deepEqual(errors, []);
});

test('Discover: Review works in one tab at a time, handed to the tab it’s asked for in, and kept through a reload', async () => {
  const items = ['Alpha', 'Beta'].map((name) => {
    const id = name.toLowerCase();
    return {
      id,
      firm: { id, name, domain: `${id}.example`, site: `https://${id}.example` },
      type: 'first',
      status: 'ready',
      step: '',
      hooks: [],
      hook: -1,
      to: `careers@${id}.example`,
      subject: 'Summer internship enquiry',
      body: `Dear ${name} recruiting team,\n\n${DRAFT.body}\n\nAda Lovelace`,
      result: { ok: true, checks: [] },
      draftedFor: { address: `careers@${id}.example`, hook: -1, ask: 'internship' },
    };
  });
  await h.bg(
    (queue) =>
      globalThis.JTF.store.setDiscoverCache({
        trackr: { names: [], domains: [], at: Date.now(), answered: 1 },
        listed: { names: [], domains: [], roles: [], at: Date.now(), answered: 1, asked: 1 },
        queue: { items: queue, at: 0, savedAt: Date.now() },
      }),
    items,
  );
  const heading = (page) => page.textContent('#review-card h2');
  const open = async () => {
    const page = await openExt('discover/discover.html#review');
    await page.waitForFunction(
      () => !/Opening/.test(document.querySelector('#review-card h2')?.textContent || 'Opening'),
    );
    return page;
  };
  const elsewhere = 'Review is open in another Discover tab';
  // A has the queue; B and C, opened after it, say it's open elsewhere and ignore the review keys.
  const a = await open();
  assert.equal(await heading(a), 'Alpha');
  const b = await open();
  const c = await open();
  assert.equal(await heading(b), elsewhere);
  assert.equal(await heading(c), elsewhere);
  await c.keyboard.press('ArrowRight');
  assert.equal(await heading(c), elsewhere);
  // Asked for in C, it goes to C, not to B (waiting for it longer).
  await c.bringToFront();
  await c.click('#review-card button:text-is("Review here instead")');
  await c.waitForFunction(() => document.querySelector('#review-card h2').textContent === 'Alpha');
  await a.waitForFunction((t) => document.querySelector('#review-card h2').textContent === t, elsewhere);
  assert.equal(await heading(b), elsewhere);
  await c.keyboard.press('ArrowRight');
  await c.waitForFunction(() => document.querySelector('#review-card h2').textContent === 'Beta');
  // Reloaded, C keeps it, on the card it was reading (B, waiting, would otherwise take it as the page reloads).
  await c.waitForTimeout(600);
  await c.reload();
  const seen = async () => Promise.all([a, b, c].map((p) => heading(p).catch(() => '?')));
  await until(
    async () => (await heading(c).catch(() => '')) === 'Beta',
    () => true,
    null,
    10000,
  ).catch(async () => assert.fail(`after the reload, A, B and C show ${JSON.stringify(await seen())}`));
  await b.waitForTimeout(500);
  assert.equal(await heading(b), elsewhere);
  assert.equal(await heading(a), elsewhere);
  // Closed, it goes to one of the others, as C left it.
  await c.close();
  await until(
    async () => [await heading(a), await heading(b)].filter((t) => t === 'Beta').length === 1,
    () => true,
    null,
    5000,
  );
  await h.bg(() => globalThis.JTF.store.setDiscoverCache({ queue: { items: [], at: 0 } }));
  await a.close();
  await b.close();
  assert.deepEqual(errors, []);
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
