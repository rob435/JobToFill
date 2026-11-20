// End-to-end, Chromium only: the application tracker. A job application is filled (the log keeps the employer and the
// role), then Nylas is mocked by routing the service worker's requests to api.us.nylas.com: the inbox holds Jane
// Street's rejection, a job alert and a newsletter, and the tracker page puts the rejection on the application.
import { after, before, test as base } from 'node:test';
import assert from 'node:assert/strict';
import { isFirefox, launch, until } from './harness.mjs';

// Playwright only routes requests made by service workers with this switched on (read at launch).
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

const test = (name, fn) => base(name, { skip: isFirefox && 'needs Chromium service-worker routing' }, fn);
const NYLAS = { apiKey: 'nyk_test_key', region: 'us', grantId: 'grant-123', email: 'ada@example.com' };

let h;
let requests = [];
const DAY = 86400000;
const now = Math.floor(Date.now() / 1000);

// The inbox: what Nylas lists (no bodies), and each message as it reads one in full.
const MAIL = [
  {
    id: 'm-reject',
    subject: 'Your application to Jane Street',
    from: [{ name: 'Jane Street Recruiting', email: 'no-reply@us.greenhouse-mail.io' }],
    date: now - 3600,
    snippet: 'Thank you for your interest in Jane Street…',
    body: '<p>Dear Ada,</p><p>Thank you for your interest in Jane Street. Unfortunately, after careful consideration, we will not be moving forward with your application at this time.</p><p>Jane Street Recruiting</p>',
  },
  {
    id: 'm-alert',
    subject: 'New jobs for you: Software Engineer',
    from: [{ name: 'LinkedIn Job Alerts', email: 'jobalerts-noreply@linkedin.com' }],
    date: now - 7200,
    snippet: 'Jobs you may be interested in',
    body: '<p>Jobs you may be interested in: Software Engineer at Jane Street.</p>',
  },
  {
    id: 'm-news',
    subject: 'Your weekly digest',
    from: [{ name: 'The Economist', email: 'news@economist.com' }],
    date: now - 9000,
    snippet: 'This week…',
    body: '<p>This week…</p>',
  },
];

before(async () => {
  if (isFirefox) return;
  h = await launch();
  await h.context.route('https://api.us.nylas.com/**', (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    const one = url.pathname.match(/\/messages\/([^/]+)$/);
    const pick = (m) => (one ? m : { id: m.id, subject: m.subject, from: m.from, date: m.date, snippet: m.snippet });
    const data = one ? pick(MAIL.find((m) => m.id === one[1])) : MAIL.map(pick);
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ request_id: 'r', data }) });
  });
  await h.bg((config) => globalThis.JTF.store.setNylas(config), NYLAS);
});

after(() => h && h.close());

const errors = [];

/** An extension page, with its errors kept. */
async function openExt(path) {
  const page = await h.context.newPage();
  page.on('pageerror', (e) => errors.push(`${path}: ${e.message}`));
  await page.goto(h.extUrl(path));
  return page;
}

test('the log keeps the employer and role, and the tracker puts Jane Street’s rejection on that application', async () => {
  await h.bg(() => globalThis.JTF.store.clearHistory());
  // Two weeks ago, through Greenhouse: an entry as the fill writes it (the e2e fill test checks the fill writes one).
  await h.bg(
    (at) =>
      globalThis.JTF.api.storage.local.set({
        history: [
          {
            id: 'app-js',
            date: at,
            updatedAt: at,
            url: 'https://job-boards.greenhouse.io/janestreet/jobs/7012/apply',
            host: 'job-boards.greenhouse.io',
            title: 'Job Application for Software Engineer Intern at Jane Street',
            filled: 14,
            company: 'Jane Street',
            role: 'Software Engineer Intern',
            ats: 'greenhouse',
            stage: 'filled',
          },
          {
            id: 'app-other',
            date: at,
            updatedAt: at,
            url: 'https://jobs.lever.co/palantir/1b2c',
            host: 'jobs.lever.co',
            title: 'Palantir - Forward Deployed Engineer',
            filled: 9,
            company: 'Palantir',
            role: 'Forward Deployed Engineer',
            stage: 'filled',
          },
        ],
        tracker: { checkedAt: 0, seen: [], unsorted: [] },
      }),
    Date.now() - 14 * DAY,
  );
  await h.setSettings({ trackApplications: true });
  requests = [];

  // Opening the page looks at the inbox by itself.
  const page = await openExt('tracker/tracker.html');
  await page.waitForSelector('#apps tr[data-id="app-js"] .pill.bad');
  assert.equal(await page.textContent('#apps tr[data-id="app-js"] .pill'), 'Rejected at the CV screen');
  assert.equal(await page.textContent('#apps tr[data-id="app-other"] .pill'), 'Filled');
  assert.match(
    await page.textContent('#status-text'),
    /3 new emails, 1 read in full · 1 update \(1 put on applications\)/,
  );
  assert.match(
    await page.textContent('#rejections'),
    /Rejected: 1 at the CV screen · 0 after a test · 0 after an interview/,
  );

  // Only the listing and the one from a recruiting system were asked for; the alert and the newsletter never in full.
  const read = requests.filter((u) => /\/messages\/[^/]+$/.test(u.pathname)).map((u) => u.pathname.split('/').pop());
  assert.deepEqual(read, ['m-reject']);
  const list = requests.find((u) => /\/messages$/.test(u.pathname));
  assert.equal(list.searchParams.get('select'), 'id,subject,from,date,snippet');
  assert.ok(+list.searchParams.get('received_after') > 0, 'only mail since the applications');

  // Its words, on opening the row.
  await page.click('#apps tr[data-id="app-js"] button[aria-expanded]');
  assert.match(await page.textContent('tr.detail'), /we will not be moving forward with your application at this time/);

  // A stage set by hand wins, and is said to be yours.
  await page.selectOption('#apps tr[data-for="app-js"] select', 'interview');
  await page.waitForSelector('#apps tr[data-id="app-js"] .yours');
  const stored = await h.bg(async () => (await globalThis.JTF.store.getHistory()).find((a) => a.id === 'app-js'));
  assert.equal(stored.stage, 'interview');
  assert.equal(stored.manual.stage, 'interview');

  // A second look reads nothing twice.
  requests = [];
  const again = await h.bg(() => globalThis.JTFBackground.checkApplications());
  assert.equal(again.looked, 0);
  assert.equal((await h.bg(async () => (await globalThis.JTF.store.getHistory())[0].events.length)) || 0, 1);
  await page.close();
});

test('with the tracker off, the page explains it and asks; Settings › Application log has the switch and the stage', async () => {
  await h.setSettings({ trackApplications: false });
  const page = await openExt('tracker/tracker.html');
  await page.waitForSelector('#setup:not([hidden])');
  assert.equal(await page.isChecked('#track'), false);
  assert.ok(await page.isHidden('#status'));
  await page.close();

  const settings = await openExt('options/options.html#history');
  await settings.waitForSelector('#sections[data-section="history"] input[name="trackApplications"]');
  assert.match(await settings.textContent('#sections table'), /Jane Street.*Software Engineer Intern/);
  await settings.check('input[name="trackApplications"]');
  await until(h.bg, async () => (await globalThis.JTF.store.getSettings()).trackApplications === true);
  await settings.close();
  assert.deepEqual(errors, []);
});
