// Launches Chromium with the unpacked extension and serves tests/fixtures.
import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '../fixtures/serve.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const EXTENSION = path.join(root, 'extension');

export const PROFILE = {
  personal: { firstName: 'Ada', lastName: 'Lovelace', pronouns: 'she/her', dob: '1990-12-10' },
  contact: { email: 'ada@example.com', phoneCountryCode: '+1', phone: '415 555 0100', phoneType: 'Mobile' },
  address: { line1: '1 Market St', line2: 'Apt 5', city: 'San Francisco', state: 'CA', postalCode: '94105', country: 'United States', organization: '' },
  links: { linkedin: 'https://www.linkedin.com/in/ada', github: 'https://github.com/ada', portfolio: 'https://ada.dev', website: 'https://ada.dev', twitter: '' },
  job: { yearsExperience: '6', authorized: 'Yes', sponsorship: 'No', relocate: 'Yes', over18: 'Yes', salary: '130000', noticePeriod: '2 weeks', startDate: '2026-11-02', referralSource: 'LinkedIn' },
  eeo: { gender: 'Female', race: 'Decline to answer', hispanic: 'No', veteran: 'No', disability: 'Decline to answer' },
  education: [
    { school: 'University of Cambridge', degree: 'Bachelor of Science', field: 'Mathematics', gpa: '3.9', location: 'Cambridge, UK', startDate: '2012-09', endDate: '2016-06' },
  ],
  experience: [
    { company: 'Analytical Engines Inc', title: 'Senior Engineer', location: 'San Francisco, CA', startDate: '2020-03', endDate: '', current: true, description: 'Leading the engine team.' },
    { company: 'Babbage Labs', title: 'Engineer', location: 'London', startDate: '2016-08', endDate: '2020-02', current: false, description: 'Built difference engines.' },
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
export const RESUME_PDF = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n').toString('base64');

export async function launch() {
  const server = await serve(0);
  const port = server.address().port;
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'jtf-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: !process.env.HEADED,
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });
  const sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(sw.url()).host;
  await sw.evaluate(() => globalThis.JTF.store.loadAll());

  const h = {
    port, context, sw, extensionId,
    url: (file, host = 'localhost') => `http://${host}:${port}/${file}`,
    extUrl: (p) => `chrome-extension://${extensionId}/${p}`,

    async open(file, host) {
      const page = await context.newPage();
      await page.goto(h.url(file, host));
      await page.waitForLoadState('load');
      return page;
    },

    async tabId(page) {
      const url = page.url();
      return sw.evaluate(async (u) => {
        const tabs = await chrome.tabs.query({});
        const hit = tabs.filter((t) => t.url === u).pop();
        return hit && hit.id;
      }, url);
    },

    async fill(page) {
      const id = await h.tabId(page);
      return sw.evaluate((tabId) => globalThis.JTFBackground.fillTab(tabId), id);
    },

    async handler(type, page, extra) {
      const id = page ? await h.tabId(page) : null;
      return sw.evaluate(([t, tabId, x]) => globalThis.JTFBackground.handlers[t](Object.assign({ tabId }, x || {}), {}), [type, id, extra || null]);
    },

    async menu(page, menuItemId) {
      const id = await h.tabId(page);
      return sw.evaluate(async ([tabId, item]) => {
        const tab = await chrome.tabs.get(tabId);
        return globalThis.JTFBackground.handleMenuClick({ menuItemId: item, frameId: 0, pageUrl: tab.url }, tab);
      }, [id, menuItemId]);
    },

    /** Merge `patch` into the active profile (objects merge, arrays replace). */
    async setProfile(patch) {
      return sw.evaluate(async (p) => {
        const { profile } = await globalThis.JTF.store.getActive();
        for (const [k, v] of Object.entries(p)) {
          if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(profile[k], v);
          else profile[k] = v;
        }
        await globalThis.JTF.store.saveProfile(profile);
        return profile.id;
      }, patch);
    },

    async setSettings(patch) {
      return sw.evaluate((p) => globalThis.JTF.store.saveSettings(p), patch);
    },

    async close() {
      await context.close();
      server.close();
      await rm(userDataDir, { recursive: true, force: true });
    },
  };
  return h;
}
