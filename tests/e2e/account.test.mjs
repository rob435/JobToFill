// End-to-end: job-portal accounts on SuccessFactors-style pages (reduced from the real Moody's career site):
// classification and dropdowns on the sign-up page, default and rule-fitting passwords, the "I'm not a robot"
// box and CAPTCHAs, signing in and creating accounts for you (with the emailed code from a mocked Nylas), the
// deny-list, saved logins going straight in and SuccessFactors' document tiles. Chromium: the Nylas mock routes the
// service worker's requests, which only Playwright/Chromium can do.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { PROFILE, RESUME_PDF, checked, isFirefox, launch, selectedText, value } from './harness.mjs';

// Playwright only routes requests made by service workers with this switched on (read at launch).
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

const NYLAS = { apiKey: 'nyk_test_key', region: 'us', grantId: 'grant-123', email: 'ada@example.com' };
const DEFAULT_PASSWORD = 'Moodys-Pass-24';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const skip = isFirefox && 'needs Chromium service-worker routing';

let h;
let mailbox = [];

async function eventually(fn, timeout = 15000, what = String(fn)) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const result = await fn().catch(() => null);
    if (result) return result;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(150);
  }
}

const stored = (page, key) => page.evaluate((k) => sessionStorage.getItem(k), key).catch(() => null);
const credentials = () => h.bg(async () => (await globalThis.JTF.passwords.read()).credentials);
const flowFill = async (page) =>
  h.bg((id) => globalThis.JTFBackground.fillTab(id, { toast: true, flow: true }), await h.tabId(page));
const flowOf = (tabId) => h.bg((id) => globalThis.JTFBackground.getFlow(id), tabId);

function codeMail(code) {
  return {
    id: `msg-${code}-${Date.now()}`,
    grant_id: NYLAS.grantId,
    subject: 'Your one-time passcode',
    from: [{ name: 'Moody’s Careers', email: 'careers@localhost' }],
    to: [{ email: NYLAS.email }],
    date: Math.floor(Date.now() / 1000),
    snippet: `Your passcode is ${code}`,
    body: `<p>Dear Ada,</p><p>Your one-time passcode is:</p><p><b>${code}</b></p><p>It expires in 10 minutes.</p>`,
  };
}

before(async () => {
  if (isFirefox) return;
  h = await launch();
  await h.context.route('https://api.us.nylas.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ request_id: 'r', data: mailbox }),
    }),
  );
  const id = await h.setProfile(PROFILE);
  await h.bg(
    ([pid, dataUrl]) =>
      globalThis.JTF.store.setDoc(pid, 'resume', {
        name: 'Ada_Lovelace_CV.pdf',
        type: 'application/pdf',
        size: 60,
        dataUrl,
      }),
    [id, RESUME_PDF],
  );
});

after(() => h && h.close());

beforeEach(async () => {
  if (isFirefox) return;
  mailbox = [];
  // Each test starts without saved logins or a default password, the "generate" strategy and no Nylas.
  await h.bg(async () => {
    const { passwords, store } = globalThis.JTF;
    await passwords.update((d) => {
      d.credentials = [];
      d.defaultPassword = '';
    });
    await store.saveSettings({ passwordStrategy: 'generate', accountFlow: true, otp: { auto: true, links: true } });
    await store.setNylas(null);
  });
});

test(
  'SuccessFactors sign-up: Country/Region Code and of Residence, national phone, retype email',
  { skip },
  async () => {
    const page = await h.open('successfactors-signup.html?company=MoodysProd&dpcs=0');
    await sleep(100); // the password policy arrives after the page
    const r = await h.fill(page);
    assert.equal(await value(page, '#fbclc_userName'), 'ada@example.com');
    assert.equal(await value(page, '#fbclc_emailConf'), 'ada@example.com');
    assert.equal(await value(page, '#fbclc_fName'), 'Ada');
    assert.equal(await value(page, '#fbclc_lName'), 'Lovelace');
    assert.equal(await selectedText(page, '#fbclc_ituCode'), 'UNITED STATES (+1)', 'not Canada or another +1 country');
    assert.equal(await value(page, '#fbclc_phoneNumber'), '415 555 0100', 'the code is in its own box');
    assert.equal(await selectedText(page, '#fbclc_country'), 'UNITED STATES', 'a country, not the state');
    assert.equal(await checked(page, '#fbclc_emailEnabled'), false, 'job alerts are never ticked');
    // A new password, saved for this site, that fits the policy the page states (8 to 18 characters…).
    const password = await value(page, '#fbclc_pwd');
    assert.equal(await value(page, '#fbclc_pwdConf'), password);
    assert.ok(password.length >= 8 && password.length <= 18, password);
    assert.match(password, /[A-Z]/);
    assert.match(password, /[a-z]/);
    assert.match(password, /[\d\p{P}\p{S}]/u);
    assert.doesNotMatch(password, /\s/);
    const saved = await credentials();
    assert.deepEqual(
      saved.map((c) => [c.host, c.portal, c.password]),
      [['localhost', 'company:moodysprod', password]],
    );
    assert.ok(r.filled >= 9, JSON.stringify(r));
    await page.close();

    // A British number written with its code, and no separate code in the profile.
    await h.setProfile({
      contact: { phoneCountryCode: '', phone: '+44 7700 900123' },
      address: { country: 'United Kingdom' },
    });
    const uk = await h.open('successfactors-signup.html?company=MoodysProd&dpcs=0');
    await h.fill(uk);
    assert.equal(
      await selectedText(uk, '#fbclc_ituCode'),
      'UNITED KINGDOM (+44)',
      'not the Isle of Man, Jersey or Guernsey',
    );
    assert.equal(await value(uk, '#fbclc_phoneNumber'), '7700 900123');
    assert.equal(await selectedText(uk, '#fbclc_country'), 'UNITED KINGDOM');
    await h.setProfile({ contact: PROFILE.contact, address: PROFILE.address });
    await uk.close();
  },
);

test('the default password goes into a SuccessFactors sign-in page with no saved login', { skip }, async () => {
  await h.setSettings({ passwordStrategy: 'default' });
  await h.bg((pw) => globalThis.JTF.passwords.update((d) => (d.defaultPassword = pw)), DEFAULT_PASSWORD);
  const page = await h.open('successfactors-login.html?company=MoodysProd');
  const r = await h.fill(page);
  assert.equal(await value(page, '#username'), 'ada@example.com');
  assert.equal(await value(page, '#password'), DEFAULT_PASSWORD);
  assert.equal(r.passwordSource, 'default');
  assert.equal(await stored(page, 'untrustedCaptcha'), null, 'the reCAPTCHA is never clicked');
  assert.equal(await page.$eval('.recaptcha-checkbox', (el) => el.getAttribute('aria-checked')), 'false');
  await page.close();
});

test(
  'a default password the sign-up page would refuse is replaced by one that fits, saved for that site',
  { skip },
  async () => {
    await h.setSettings({ passwordStrategy: 'default' });
    await h.bg(() =>
      globalThis.JTF.passwords.update((d) => (d.defaultPassword = 'Default-Password-Far-Too-Long-2024')),
    );
    const page = await h.open('successfactors-signup.html?company=MoodysProd&dpcs=0');
    await sleep(100);
    const r = await h.fill(page);
    const password = await value(page, '#fbclc_pwd');
    assert.notEqual(password, 'Default-Password-Far-Too-Long-2024');
    assert.ok(password.length <= 18 && /[A-Z]/.test(password) && /[a-z]/.test(password), password);
    assert.ok(
      r.notes.some((n) => /default password doesn’t meet localhost’s rules \(longer than 18 characters\)/.test(n)),
      JSON.stringify(r.notes),
    );
    const saved = await credentials();
    assert.deepEqual(
      saved.map((c) => [c.host, c.portal, c.password]),
      [['localhost', 'company:moodysprod', password]],
    );

    // A default password that fits goes in as it is.
    await h.bg(
      (pw) => globalThis.JTF.passwords.update((d) => ((d.defaultPassword = pw), (d.credentials = []))),
      DEFAULT_PASSWORD,
    );
    await page.reload();
    await sleep(100);
    const again = await h.fill(page);
    assert.equal(await value(page, '#fbclc_pwd'), DEFAULT_PASSWORD);
    assert.equal(again.passwordSource, 'default');
    await page.close();
  },
);

test(
  'a plain “I’m not a robot” box is ticked, and the sign-up form’s own button creates the account',
  { skip },
  async () => {
    const page = await h.open('account-robot.html');
    const r = await flowFill(page);
    assert.equal(await checked(page, '#robot'), true);
    assert.equal(await checked(page, '#terms'), true, 'the sign-up form’s terms are part of creating the account');
    assert.equal(await checked(page, '#news'), false, 'marketing is never ticked');
    const created = JSON.parse(await eventually(() => stored(page, 'created'), 5000, 'the account to be created'));
    assert.equal(created.email, 'ada@example.com');
    assert.ok(created.password.length >= 10 && created.password.length <= 16, created.password);
    assert.match(created.password, /^[A-Za-z0-9!@#$%]+$/, 'only the special characters the page lists');
    assert.ok(
      r.account.lines.some((l) => /clicking “Create Account”/.test(l)),
      JSON.stringify(r.account),
    );
    assert.equal(await stored(page, 'other'), null, 'neither “Cancel” nor “Sign up with LinkedIn”');
    await page.close();
  },
);

test('a CAPTCHA on the sign-in page is left to you; signing in follows once it is solved', { skip }, async () => {
  await h.bg(() =>
    globalThis.JTF.passwords.update((d) =>
      d.credentials.push({
        id: 'sf',
        host: 'localhost',
        portal: 'company:moodysprod',
        username: 'ada@example.com',
        password: 'Saved-Pass-77',
      }),
    ),
  );
  const page = await h.open('successfactors-login.html?company=MoodysProd');
  const tabId = await h.tabId(page);
  const r = await flowFill(page);
  assert.equal(await value(page, '#password'), 'Saved-Pass-77');
  assert.ok(
    r.account.lines.some((l) => /Complete the “I’m not a robot” check: JobToFill then signs you in/.test(l)),
    JSON.stringify(r.account),
  );
  await sleep(1500);
  assert.equal(await stored(page, 'signedIn'), null, 'nothing is clicked while the CAPTCHA waits');
  assert.equal(await stored(page, 'untrustedCaptcha'), null, 'the CAPTCHA is never clicked by JobToFill');
  assert.ok((await flowOf(tabId)).waiting, 'the flow waits for it');

  await page.click('.recaptcha-checkbox'); // the person solves it
  await page.waitForURL(/successfactors-apply\.html/, { timeout: 15000 });
  const signedIn = JSON.parse(await stored(page, 'signedIn'));
  assert.deepEqual(signedIn, { username: 'ada@example.com', password: 'Saved-Pass-77' });
  // The application page is filled (never submitted), and the flow is over.
  await eventually(
    async () => (await value(page, '[id="13:_input"]')) === 'Ada',
    15000,
    'the application to be filled',
  );
  assert.equal(await stored(page, 'applied'), null);
  assert.equal(await stored(page, 'sso'), null, '“Sign in with Google” is never clicked');
  assert.equal(await stored(page, 'forgot'), null, '“Forgot your password?” is never clicked');
  await eventually(async () => !(await flowOf(tabId)), 10000, 'the flow to end');
  await page.close();
});

test('no account yet: create it, type the emailed code, and land on the application', { skip }, async () => {
  await h.setSettings({ passwordStrategy: 'default' });
  await h.bg((pw) => globalThis.JTF.passwords.update((d) => (d.defaultPassword = pw)), DEFAULT_PASSWORD);
  await h.bg((config) => globalThis.JTF.store.setNylas(config), NYLAS);
  mailbox = [codeMail('482913')];
  const page = await h.open('successfactors-login.html?company=MoodysProd');
  const tabId = await h.tabId(page);
  const r = await flowFill(page);
  assert.ok(
    r.account.lines.some((l) => /No account for localhost in JobToFill yet: opening “Create your account”/.test(l)),
    JSON.stringify(r.account),
  );
  // The sign-up page opens in the same tab and is filled by itself; it waits for the Terms of Use.
  await page.waitForURL(/successfactors-signup\.html/, { timeout: 15000 });
  await eventually(
    async () => (await value(page, '#fbclc_pwdConf')) === DEFAULT_PASSWORD,
    15000,
    'the sign-up page to be filled',
  );
  assert.equal(await selectedText(page, '#fbclc_ituCode'), 'UNITED STATES (+1)');
  assert.equal(await selectedText(page, '#fbclc_country'), 'UNITED STATES');
  await eventually(async () => (await flowOf(tabId)).waiting, 10000, 'the flow to wait for the terms');
  assert.equal(await stored(page, 'createClicked'), null, 'not before the terms are accepted');

  await page.click('#dataPrivacyId'); // the person reads and accepts the data privacy statement
  await page.click('#dpcsAccept');
  // Then: "Create Account", the passcode from the email, "Continue", and the application.
  await page.waitForURL(/successfactors-apply\.html/, { timeout: 30000 });
  const account = JSON.parse(await stored(page, 'account'));
  assert.equal(account.password, DEFAULT_PASSWORD);
  assert.equal(account.code, 'US');
  await eventually(
    async () => (await value(page, '[id="13:_input"]')) === 'Ada',
    15000,
    'the application to be filled',
  );
  assert.equal(await stored(page, 'applied'), null, 'the application is never submitted');
  // The account made with the default password is remembered for this employer.
  const saved = await credentials();
  assert.deepEqual(
    saved.map((c) => [c.host, c.portal, c.password, c.note]),
    [['localhost', 'company:moodysprod', DEFAULT_PASSWORD, 'Created with your default password']],
  );
  await page.close();
});

test('an account that already exists: back to sign in, with the default password', { skip }, async () => {
  await h.setSettings({ passwordStrategy: 'default' });
  await h.bg((pw) => globalThis.JTF.passwords.update((d) => (d.defaultPassword = pw)), DEFAULT_PASSWORD);
  const page = await h.open('successfactors-signup.html?company=MoodysProd&dpcs=0&exists=1');
  await sleep(100);
  await flowFill(page);
  // "Create Account" -> "An account with this email address already exists. Sign in" -> sign-in page -> signed in.
  await page.waitForURL(/successfactors-apply\.html/, { timeout: 30000 });
  assert.deepEqual(JSON.parse(await stored(page, 'signedIn')), {
    username: 'ada@example.com',
    password: DEFAULT_PASSWORD,
  });
  await page.close();
});

test('a job application is never submitted, even with a password box on it', { skip }, async () => {
  const mixed = await h.open('application-signup.html');
  const r = await flowFill(mixed);
  assert.ok(r.filled >= 3, JSON.stringify(r));
  await sleep(1000);
  assert.equal(await stored(mixed, 'clicked'), null, 'neither “Create account and submit application” nor “Register”');
  assert.equal(r.account, null);
  await mixed.close();

  const apply = await h.open('successfactors-apply.html?company=MoodysProd');
  await flowFill(apply);
  await sleep(1000);
  assert.equal(await stored(apply, 'applied'), null, 'not “Apply”, “Save Draft” or “Withdraw”');
  await apply.close();

  // With the setting off, a sign-up page is only filled.
  await h.setSettings({ accountFlow: false });
  const off = await h.open('account-robot.html');
  await flowFill(off);
  await sleep(800);
  assert.equal(await stored(off, 'created'), null);
  assert.equal(await checked(off, '#terms'), false, 'terms are left for you without the setting');
  await off.close();
});

test('a saved login goes straight in on the first fill, with nothing to unlock', { skip }, async () => {
  await h.bg(() =>
    globalThis.JTF.passwords.update((d) =>
      d.credentials.push({ id: 'l', host: 'localhost', username: 'ada@example.com', password: 'Login-Pass-1' }),
    ),
  );
  const page = await h.open('login.html');
  // As Quick apply fills: acknowledgements ticked, the toast on the page.
  const r = await h.bg(
    (id) => globalThis.JTFBackground.fillTab(id, { toast: true, consents: true, quick: true }),
    await h.tabId(page),
  );
  assert.equal(await value(page, '#user'), 'ada@example.com');
  assert.equal(await value(page, '#pw'), 'Login-Pass-1');
  assert.equal(r.passwordSource, 'saved');
  assert.ok(!r.notes.some((n) => /password|card/i.test(n)), JSON.stringify(r.notes));
  await page.close();
});

test(
  'SuccessFactors document tiles: the CV goes in through “Upload from Device”, never Dropbox or Google',
  { skip },
  async () => {
    const page = await h.open('successfactors-apply.html?company=MoodysProd');
    const r = await h.fill(page);
    assert.equal(await stored(page, 'uploaded:47:_attachIcon'), 'Ada_Lovelace_CV.pdf');
    assert.match(
      await page.$eval('#resumeRow', (el) => el.textContent),
      /Ada_Lovelace_CV\.pdf\s+File is uploaded successfully/,
    );
    assert.equal(await stored(page, 'cloud'), null, 'Dropbox and Google are never chosen');
    assert.equal(await stored(page, 'uploaded:49:_attachIcon'), null, 'Additional Documents is not the CV');
    assert.match(await page.$eval('#otherRow', (el) => el.textContent), /Upload a Document/);
    assert.equal(r.docs['file.resume'], 'filled');
    assert.equal(await value(page, '[id="13:_input"]'), 'Ada');
    assert.equal(await selectedText(page, '[id="16:_input"]'), 'LinkedIn');
    await page.close();
  },
);

test(
  'Workday “Create Account”: the terms box is ticked and the click lands on its click filter',
  { skip },
  async () => {
    const page = await h.open('workday-account.html');
    const r = await flowFill(page);
    const password = await value(page, '#input-5');
    assert.equal(await value(page, '#input-6'), password, 'Verify New Password');
    assert.equal(await checked(page, '#input-7'), true);
    const created = JSON.parse(await eventually(() => stored(page, 'created'), 5000, 'the account to be created'));
    assert.deepEqual(created, { email: 'ada@example.com', password });
    assert.equal(await stored(page, 'underneath'), null, 'clicked like a person: on what is on top');
    assert.ok(r.ticked >= 1, JSON.stringify(r));
    await page.close();
  },
);
