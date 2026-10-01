// Launches a browser with the unpacked extension and serves tests/fixtures.
//   BROWSER=chromium (default)  Playwright + Chromium; the background is the service worker.
//   BROWSER=firefox             Puppeteer (WebDriver BiDi) + Firefox; the background is reached
//                               through Firefox's remote debugging protocol. Needs Firefox 142+
//                               on PATH or in FIREFOX_BIN.
// Tests only use what both drivers share: page.goto/$eval/$$eval/focus/frames/reload/close.
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '../fixtures/serve.mjs';
import { RemoteDebugger } from './firefox-rdp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const EXTENSION = path.join(root, 'extension');
export const BROWSER = process.env.BROWSER || 'chromium';
export const isFirefox = BROWSER === 'firefox';

export const PROFILE = {
  personal: { firstName: 'Ada', lastName: 'Lovelace', pronouns: 'she/her', dob: '1990-12-10' },
  contact: { email: 'ada@example.com', phoneCountryCode: '+1', phone: '415 555 0100', phoneType: 'Mobile' },
  address: {
    line1: '1 Market St',
    line2: 'Apt 5',
    city: 'San Francisco',
    state: 'CA',
    postalCode: '94105',
    country: 'United States',
    organization: '',
  },
  links: {
    linkedin: 'https://www.linkedin.com/in/ada',
    github: 'https://github.com/ada',
    portfolio: 'https://ada.dev',
    website: 'https://ada.dev',
    twitter: '',
  },
  job: {
    yearsExperience: '6',
    authorized: 'Yes',
    sponsorship: 'No',
    relocate: 'Yes',
    over18: 'Yes',
    salary: '130000',
    noticePeriod: '2 weeks',
    startDate: '2026-11-02',
    referralSource: 'LinkedIn',
  },
  eeo: { gender: 'Female', race: 'Decline to answer', hispanic: 'No', veteran: 'No', disability: 'Decline to answer' },
  education: [
    {
      school: 'University of Cambridge',
      degree: 'Bachelor of Science',
      field: 'Mathematics',
      gpa: '3.9',
      location: 'Cambridge, UK',
      startDate: '2012-09',
      endDate: '2016-06',
    },
  ],
  experience: [
    {
      company: 'Analytical Engines Inc',
      title: 'Senior Engineer',
      location: 'San Francisco, CA',
      startDate: '2020-03',
      endDate: '',
      current: true,
      description: 'Leading the engine team.',
    },
    {
      company: 'Babbage Labs',
      title: 'Engineer',
      location: 'London',
      startDate: '2016-08',
      endDate: '2020-02',
      current: false,
      description: 'Built difference engines.',
    },
  ],
  skills: 'Python, SQL, Mathematics',
  languages: 'English, French',
  summary: 'Engineer and mathematician.',
  coverLetter: 'Dear hiring team, I would love to join.',
  customAnswers: [
    { id: 'c1', question: 'why do you want to work', answer: 'I love engines.' },
    { id: 'c2', question: 'previously worked for', answer: 'No' },
    { id: 'c3', question: 'nyc office', answer: 'Yes' },
  ],
};

// A tiny but valid PDF.
export const RESUME_PDF =
  'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n').toString('base64');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const headless = !process.env.HEADED;

/* ---------------------------------------------------------------- drivers */

async function chromiumDriver() {
  const { chromium } = await import('playwright');
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'jtf-e2e-'));
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless,
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const origin = `chrome-extension://${new URL(worker.url()).host}`; // URL#origin is "null" for this scheme
  return {
    context,
    extUrl: (file) => `${origin}/${file}`,
    bg: (fn, arg) => worker.evaluate(fn, arg),
    newPage: () => context.newPage(),
    async extPage(file) {
      const page = await context.newPage();
      await page.goto(`${origin}/${file}`);
      return { page, call: (fn, arg) => page.evaluate(fn, arg), close: () => page.close() };
    },
    async close() {
      await context.close();
      await rm(profileDir, { recursive: true, force: true });
    },
  };
}

function findFirefox() {
  if (process.env.FIREFOX_BIN) return process.env.FIREFOX_BIN;
  try {
    return execFileSync('which', ['firefox']).toString().trim();
  } catch {
    throw new Error('Firefox not found: install Firefox 142+ or set FIREFOX_BIN=/path/to/firefox');
  }
}

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function firefoxDriver() {
  const { default: puppeteer } = await import('puppeteer-core');
  const manifest = JSON.parse(await readFile(path.join(EXTENSION, 'manifest.json'), 'utf8'));
  const debuggerPort = await freePort();
  const browser = await puppeteer.launch({
    browser: 'firefox',
    executablePath: findFirefox(),
    headless,
    args: ['-start-debugger-server', String(debuggerPort)],
    extraPrefsFirefox: {
      'devtools.debugger.remote-enabled': true,
      'devtools.chrome.enabled': true,
      'devtools.debugger.prompt-connection': false,
    },
  });
  await browser.installExtension(EXTENSION);
  const rdp = await RemoteDebugger.connect(debuggerPort);
  const consoleFor = await rdp.watchExtension(manifest.browser_specific_settings.gecko.id);
  const background = await consoleFor('_generated_background_page');
  const bg = (fn, arg) => rdp.call(background, fn, arg);
  return {
    browser,
    bg,
    newPage: () => browser.newPage(),
    async extPage(file) {
      const url = await bg((f) => globalThis.JTF.api.runtime.getURL(f), file);
      const tab = await bg((u) => globalThis.JTF.api.tabs.create({ url: u }).then((t) => t.id), url);
      const target = await consoleFor(file);
      return {
        call: (fn, arg) => rdp.call(target, fn, arg),
        close: () => bg((id) => globalThis.JTF.api.tabs.remove(id), tab),
      };
    },
    async close() {
      rdp.close();
      await browser.close();
    },
  };
}

/* ---------------------------------------------------------------- harness */

export async function launch() {
  const server = await serve(0);
  const port = server.address().port;
  const driver = isFirefox ? await firefoxDriver() : await chromiumDriver();
  await driver.bg(() => globalThis.JTF.store.loadAll());

  const h = {
    ...driver,
    port,
    url: (file, host = 'localhost') => `http://${host}:${port}/${file}`,

    async open(file, host) {
      const page = await driver.newPage();
      await page.goto(h.url(file, host));
      return page;
    },

    tabId(page) {
      return driver.bg(async (url) => {
        const tabs = await globalThis.JTF.api.tabs.query({});
        const hit = tabs.filter((t) => t.url === url).pop();
        return hit ? hit.id : null;
      }, page.url());
    },

    async fill(page) {
      return driver.bg((id) => globalThis.JTFBackground.fillTab(id), await h.tabId(page));
    },

    /** Call a background message handler the way the popup does. */
    async handler(type, page, extra) {
      const tabId = page ? await h.tabId(page) : null;
      return driver.bg(([t, msg]) => globalThis.JTFBackground.handlers[t](msg, {}), [type, { tabId, ...extra }]);
    },

    /** Simulate a context-menu click on the focused element. */
    async menu(page, menuItemId) {
      const tabId = await h.tabId(page);
      return driver.bg(
        async ([id, item]) => {
          const tab = await globalThis.JTF.api.tabs.get(id);
          await globalThis.JTFBackground.handleMenuClick({ menuItemId: item, frameId: 0, pageUrl: tab.url }, tab);
          return null;
        },
        [tabId, menuItemId],
      );
    },

    /** Merge `patch` into the active profile (objects merge, arrays replace). Returns the profile id. */
    setProfile(patch) {
      return driver.bg(async (p) => {
        const { profile } = await globalThis.JTF.store.getActive();
        for (const [key, value] of Object.entries(p)) {
          if (value && typeof value === 'object' && !Array.isArray(value)) Object.assign(profile[key], value);
          else profile[key] = value;
        }
        await globalThis.JTF.store.saveProfile(profile);
        return profile.id;
      }, patch);
    },

    profile: () => driver.bg(async () => (await globalThis.JTF.store.getActive()).profile),
    settings: () => driver.bg(() => globalThis.JTF.store.getSettings()),
    setSettings: (patch) => driver.bg((p) => globalThis.JTF.store.saveSettings(p), patch),

    async close() {
      await driver.close();
      server.close();
    },
  };
  return h;
}

/* ------------------------------------------------------ page helpers (both) */

export const value = (page, selector) => page.$eval(selector, (el) => el.value);
export const checked = (page, selector) => page.$eval(selector, (el) => el.checked);
export const text = (page, selector) => page.$eval(selector, (el) => el.textContent.trim());
export const selectedText = (page, selector) => page.$eval(selector, (el) => el.options[el.selectedIndex].text);

/** Set a field's value the way typing does (input + change events). */
export const typeInto = (page, selector, v) =>
  page.$eval(
    selector,
    (el, next) => {
      el.focus();
      el.value = next;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    v,
  );

/** Wait for a (possibly cross-origin) frame whose URL contains `urlPart` and that has `selector`. */
export async function frameWith(page, urlPart, selector) {
  for (let i = 0; i < 100; i++) {
    const frame = page.frames().find((f) => f.url().includes(urlPart));
    if (frame && (await frame.$(selector).catch(() => null))) return frame;
    await sleep(100);
  }
  throw new Error(`No frame ${urlPart} with ${selector}`);
}

/** Poll `fn` (run in an extension page or the background) until it returns something truthy. */
export async function until(call, fn, arg, timeout = 10000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const result = await call(fn, arg);
    if (result) return result;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${fn}`);
    await sleep(100);
  }
}
