// End-to-end: verification codes from email. Nylas is mocked by routing the service worker's requests to
// api.us.nylas.com; the fixture pages are served on localhost, so mail "from this site" is sent from
// codes@localhost. Chromium only: routing a service worker's fetches is a Playwright/Chromium feature.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { isFirefox, launch, value } from './harness.mjs';

// Playwright only routes requests made by service workers with this switched on (read at launch).
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

const NYLAS = { apiKey: 'nyk_test_key', region: 'us', grantId: 'grant-123', email: 'ada@example.com' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let h;
let mailbox = [];
let requests = [];
let seq = 0;

/** A message as the Nylas v3 API returns it, received just now. */
function mail({ from, name = 'Careers', subject = 'Your verification code', body }) {
  return {
    id: `msg-${++seq}`,
    grant_id: NYLAS.grantId,
    subject,
    from: [{ name, email: from }],
    to: [{ email: NYLAS.email }],
    date: Math.floor(Date.now() / 1000),
    snippet: body.replace(/<[^>]+>/g, ' ').slice(0, 100),
    body,
  };
}

const codeMail = (code, from = 'codes@localhost', extra = {}) =>
  mail({
    from,
    body: `<p>Hi Ada,</p><p>Your verification code is:</p><p style="font-size:28px"><b>${code}</b></p><p>It expires in 10 minutes.</p>`,
    ...extra,
  });

/** Poll `fn` (in Node) until it returns something truthy. */
async function eventually(fn, timeout = 15000, what = String(fn)) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const result = await fn();
    if (result) return result;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(150);
  }
}

const boxes = (page) => page.$$eval('.boxes input', (list) => list.map((el) => el.value).join(''));

/** Whether the tab's content-script world (where content/otp.js lives) has the watcher, and what it sees. */
async function watcher(page) {
  return h.bg(
    async (id) => {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: id },
        func: () => (globalThis.__jtfOtp ? { target: globalThis.__jtfOtp.findTarget() } : null),
      });
      return r && r.result;
    },
    await h.tabId(page),
  );
}

/** Click a button inside a closed shadow root (the "Use it" toast): CDP can see through it. */
async function clickInShadow(page, label) {
  const cdp = await h.context.newCDPSession(page);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const find = (node) => {
      if (
        node.nodeName === 'BUTTON' &&
        (node.children || []).some((c) => c.nodeType === 3 && c.nodeValue.trim() === label)
      )
        return node;
      for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) {
        const hit = find(child);
        if (hit) return hit;
      }
      return null;
    };
    const button = find(root);
    if (!button) return false;
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: button.backendNodeId });
    await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: 'function () { this.click(); }',
    });
    return true;
  } finally {
    await cdp.detach();
  }
}

before(async () => {
  if (isFirefox) return;
  h = await launch();
  await h.context.route('https://api.us.nylas.com/**', (route) => {
    const req = route.request();
    requests.push({ url: req.url(), auth: req.headers().authorization });
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ request_id: 'r', data: mailbox }),
    });
  });
  await h.bg((config) => globalThis.JTF.store.setNylas(config), NYLAS);
});

after(() => h && h.close());

beforeEach(() => {
  mailbox = [];
  requests = [];
});

const skip = isFirefox && 'needs Chromium service-worker routing';

test('six React digit boxes are filled from the site’s email as soon as the page loads', { skip }, async () => {
  mailbox = [codeMail('482913')];
  const page = await h.open('otp-boxes.html');
  await eventually(async () => (await boxes(page)) === '482913', 15000, 'the boxes to be filled');
  assert.equal(await page.$eval('#state', (el) => el.textContent), '482913', 'React registered the code');
  assert.equal(await page.$eval('button', (el) => el.disabled), false);

  const req = requests[0];
  assert.ok(req, 'Nylas was asked');
  const url = new URL(req.url);
  assert.equal(url.pathname, `/v3/grants/${NYLAS.grantId}/messages`);
  assert.equal(req.auth, `Bearer ${NYLAS.apiKey}`);
  assert.ok(+url.searchParams.get('received_after') > 0, 'only recent mail is listed');
  await page.close();
});

test('Oracle’s six pin boxes without a maxlength get the whole code, not just its first digit', { skip }, async () => {
  mailbox = [codeMail('938804')];
  const page = await h.open('otp-oracle.html');
  const pins = () => page.$$eval('.pin-code-input__input', (list) => list.map((el) => el.value).join(''));
  await eventually(async () => (await pins()) === '938804', 15000, 'the six boxes to be filled');
  assert.equal(await page.$eval('#state', (el) => el.textContent), '938804', 'the page registered the code');
  await page.close();
});

test('a single one-time-code box is filled, and the code waits for the email to arrive', { skip }, async () => {
  const page = await h.open('otp-single.html');
  await eventually(() => requests.length >= 1, 10000, 'the first poll');
  assert.equal(await value(page, '#code'), '', 'nothing to fill yet');
  // The email arrives a moment later; the watcher's next poll picks it up.
  mailbox = [codeMail('735204')];
  await eventually(async () => (await value(page, '#code')) === '735204', 15000, 'the box to be filled');
  await page.close();
});

test('a code from an unrelated sender is not filled', { skip }, async () => {
  mailbox = [codeMail('118822', 'security@bank.example', { name: 'Example Bank', subject: 'Your login code' })];
  const page = await h.open('otp-single.html');
  // Let the watcher see the email at least twice (first poll is immediate, then every 3.5 s).
  await eventually(() => requests.length >= 2, 15000, 'two polls');
  await sleep(300);
  assert.equal(await value(page, '#code'), '', 'never filled on its own');
  const claims = await h.bg(async () => (await chrome.storage.session.get('otpClaims')).otpClaims || {});
  assert.ok(!Object.values(claims).some((c) => c.code === '118822'), 'not even offered: nothing ties it to the site');
  await page.close();
});

test('a code from a sender that only mentions the site is offered with “Use it”, not filled', { skip }, async () => {
  mailbox = [
    codeMail('660517', 'no-reply@mailer.example', {
      name: 'Mailer',
      subject: 'Your localhost verification code',
    }),
  ];
  const page = await h.open('otp-single.html');
  const tabId = await h.tabId(page);
  const claim = await eventually(
    () =>
      h.bg(async () => {
        const claims = (await chrome.storage.session.get('otpClaims')).otpClaims || {};
        return Object.values(claims).find((c) => c.code === '660517') || null;
      }),
    15000,
    'the code to be offered',
  );
  assert.equal(claim.tabId, tabId, 'offered to this tab only');
  assert.equal(await value(page, '#code'), '', 'not filled until the person says so');

  assert.ok(await eventually(() => clickInShadow(page, 'Use it'), 5000, 'the “Use it” toast'));
  await eventually(async () => (await value(page, '#code')) === '660517', 5000, 'the claimed code to be filled');
  await page.close();
});

test('a coupon box (and a gift card PIN row) is left alone', { skip }, async () => {
  mailbox = [codeMail('904417')];
  const page = await h.open('coupon.html');
  const seen = await eventually(() => watcher(page), 10000, 'the watcher to be injected');
  assert.equal(seen.target, null, 'no code box found');
  await sleep(1500);
  assert.equal(await value(page, '#promo'), '');
  assert.deepEqual(await page.$$eval('.gift input', (list) => list.map((el) => el.value)), ['', '', '', '']);
  assert.equal(requests.length, 0, 'the inbox is never read for this page');
  await page.close();
});
