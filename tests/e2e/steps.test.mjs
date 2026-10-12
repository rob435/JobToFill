// End-to-end: applications in steps (Workday's My Information → My Experience → Application Questions → Review): a
// section's own "Add" for each of your entries, and (Settings › "Move through multi-step applications for me") the
// step's own "Save and Continue" once it is done, never the Review step's "Submit". Chromium or Firefox.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PROFILE, RESUME_PDF, launch, text, typeInto, until, value } from './harness.mjs';

let h;

before(async () => {
  h = await launch();
  await h.setProfile(PROFILE);
});

after(() => h.close());

const state = async (page) => JSON.parse(await text(page, '#state'));
/** Wait for the application to reach step `n` (a fill moves on by itself, in the background). */
const reaches = (page, n) =>
  until(
    (fn, arg) => page.$eval('#state', fn, arg),
    (el, k) => JSON.parse(el.textContent).step === k,
    n,
    30000,
  );

/** From now on, every toast JobToFill shows on the page is also kept in <html data-toasts> (from its content script). */
async function recordToasts(page) {
  await h.bg(
    async (id) => {
      await globalThis.JTFBackground.ensureInjected(id);
      await globalThis.JTF.api.scripting.executeScript({
        target: { tabId: id, frameIds: [0] },
        func: () => {
          const api = globalThis.__jtf;
          const show = api.toast;
          api.toast = (message, opts) => {
            const root = document.documentElement;
            root.dataset.toasts = JSON.stringify([...JSON.parse(root.dataset.toasts || '[]'), message]);
            return show(message, opts);
          };
        },
      });
    },
    await h.tabId(page),
  );
}
const toasts = (page) => page.$eval('html', (el) => JSON.parse(el.dataset.toasts || '[]'));
/** Wait for a toast that says `re`, and return it. */
const toastSays = (page, re, timeout = 15000) =>
  until(
    (fn, arg) => page.$eval('html', fn, arg),
    (el, source) => JSON.parse(el.dataset.toasts || '[]').find((t) => new RegExp(source).test(t)),
    re.source,
    timeout,
  );
const uploads = (page) => page.$eval('html', (el) => JSON.parse(el.dataset.uploads || '[]'));
/** Alt+Shift+F (or the menu's "Fill this page"). */
const shortcut = async (page) =>
  h.bg((id) => globalThis.JTFBackground.fillTab(id, { toast: true, flow: true }), await h.tabId(page));

test('auto-advance is off unless switched on: the step is filled, nothing is clicked', async () => {
  const page = await h.open('workday-steps.html');
  const r = await h.fill(page);
  assert.equal(r.error, undefined);
  assert.equal(await value(page, '#first'), 'Ada');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const s = await state(page);
  assert.equal(s.step, 1, 'still on My Information');
  assert.equal(s.submitted, false);
  await page.close();
});

test('My Experience: a section’s own "Add" once per entry of yours, then each entry filled', async () => {
  const page = await h.open('workday-steps.html?start=2');
  const r = await h.fill(page);
  assert.equal(r.error, undefined);
  const s = await state(page);
  assert.equal(s.experience, 2, 'two jobs in the profile: two entries');
  assert.equal(s.education, 1, 'one school: one entry');
  assert.equal(await value(page, '#we-1-company'), 'Analytical Engines Inc');
  assert.equal(await value(page, '#we-2-company'), 'Babbage Labs');
  assert.equal(await value(page, '#ed-1-school'), 'University of Cambridge');
  // Filled again, nothing more is added.
  await h.fill(page);
  assert.deepEqual([(await state(page)).experience, (await state(page)).education], [2, 1]);
  await page.close();
});

test('with it on: each step filled and continued, up to the Review step, which is never submitted', async () => {
  await h.setSettings({ autoAdvance: true });
  try {
    const page = await h.open('workday-steps.html');
    await recordToasts(page);
    const r = await h.fill(page);
    assert.equal(r.error, undefined);
    assert.ok(
      r.notes.some((n) => /Clicking “Save and Continue”/.test(n)),
      JSON.stringify(r.notes),
    );
    await reaches(page, 4);
    // The Review step has no questions: it is still taken for the next step (not "The page didn't move on…"), and its
    // own fill says it is the last.
    assert.equal(
      await toastSays(page, /That’s the last step/),
      'That’s the last step (step 4 of 4): check your application and submit it yourself.',
    );
    // Give it a moment to be sure nothing presses "Submit".
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const said = await toasts(page);
    assert.ok(!said.some((t) => /didn’t move on|couldn’t click/.test(t)), JSON.stringify(said));
    const s = await state(page);
    assert.equal(s.step, 4);
    assert.equal(s.submitted, false, 'the application is never submitted');
    assert.equal(s.values.first, 'Ada');
    assert.equal(s.values.source, 'LinkedIn');
    assert.equal(s.values['we-2-company'], 'Babbage Labs');
    assert.equal(s.values['ed-1-school'], 'University of Cambridge');
    assert.equal(s.values.auth, 'Yes');
    assert.equal(s.values.spons, 'No');
    await page.close();
  } finally {
    await h.setSettings({ autoAdvance: false });
  }
});

test('with it on: a required question left empty stops it on that step', async () => {
  await h.setSettings({ autoAdvance: true });
  try {
    const page = await h.open('workday-steps.html?values=1');
    await recordToasts(page);
    // The shortcut: each step's fill says what it filled, and the one that stops says why, in the same toast.
    await shortcut(page);
    await reaches(page, 3);
    const said = await toastSays(page, /then press Fill to carry on/);
    assert.match(said, /^Filled 2 fields\.\n/);
    assert.match(
      said,
      /\nFill in “Which of our five values resonates most with you, and why\?”, then press Fill to carry on\.$/,
    );
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const s = await state(page);
    assert.equal(s.step, 3, 'stopped at Application Questions');
    assert.equal(await page.$eval('#errors', (e) => e.textContent), '', 'never pressed with the essay empty');
    assert.equal(await value(page, '#auth'), 'Yes', 'the rest of the step is filled');
    assert.equal(s.submitted, false);
    await page.close();
  } finally {
    await h.setSettings({ autoAdvance: false });
  }
});

test('with it on: a step the site has filled already (a returning candidate’s My Information) is continued too', async () => {
  await h.setSettings({ autoAdvance: true });
  try {
    const page = await h.open('workday-steps.html');
    for (const [sel, v] of [
      ['#first', 'Ada'],
      ['#last', 'Lovelace'],
      ['#email', 'ada@example.com'],
      ['#phone', '+1 415 555 0100'],
    ])
      await typeInto(page, sel, v);
    await page.$eval('#source', (el) => {
      el.value = 'LinkedIn';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const r = await shortcut(page);
    assert.equal(r.filled, 0, 'nothing for this fill to do here');
    assert.ok(
      r.notes.some((n) => /Clicking “Save and Continue” for the next step \(step 1 of 4\)/.test(n)),
      JSON.stringify(r.notes),
    );
    await reaches(page, 4);
    const s = await state(page);
    assert.equal(s.values.first, 'Ada');
    assert.equal(s.values['we-1-company'], 'Analytical Engines Inc');
    assert.equal(s.submitted, false);
    await page.close();
  } finally {
    await h.setSettings({ autoAdvance: false });
  }
});

test('with it on: a step whose CV Quick apply is still tailoring waits for it, then carries on once it is in', async () => {
  await h.setSettings({ autoAdvance: true });
  const page = await h.open('workday-steps.html?start=2');
  const tabId = await h.tabId(page);
  try {
    await recordToasts(page);
    // The files the page's uploads were given, as the page saw them.
    await page.$eval('html', (root) => {
      root.dataset.uploads = '[]';
      document.addEventListener('change', (e) => {
        if (e.target.type !== 'file') return;
        root.dataset.uploads = JSON.stringify([...JSON.parse(root.dataset.uploads), e.target.files[0].name]);
      });
    });
    await h.bg(
      (id) =>
        globalThis.JTF.store.setQuickStatus({ state: 'running', message: 'writing', tabId: id, studioTabId: null }),
      tabId,
    );
    // Fill pressed while Quick apply writes: the step is filled, its CV upload left for Quick apply, and not left.
    const r = await shortcut(page);
    assert.equal(r.held, 1, JSON.stringify(r));
    assert.match(
      await toastSays(page, /carries on/),
      /\nJobToFill carries on to the next step once your cover letter and CV are in\.$/,
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));
    assert.equal((await state(page)).step, 2, 'still on My Experience');
    assert.deepEqual(await uploads(page), []);

    // Quick apply is done: its tailored CV goes in, and the application carries on from there.
    await h.bg(
      async ([id, url, pdf]) => {
        const { store } = globalThis.JTF;
        const { profile } = await store.getActive();
        const doc = (name) => ({ name, type: 'application/pdf', size: 60, dataUrl: pdf });
        await store.saveLetter({
          id: 'quick-steps',
          profileId: profile.id,
          url,
          text: 'Dear Ada & Co…',
          pdf: doc('Ada_Lovelace_letter.pdf'),
          cv: doc('Ada_Lovelace_CV_tailored.pdf'),
          useCv: true,
        });
        await store.setQuickStatus({ state: 'done', message: 'done', tabId: id });
      },
      [tabId, page.url(), RESUME_PDF],
    );
    const done = await h.bg(([id]) => globalThis.JTFBackground.quickFill(id, 'quick-steps', { cv: true }), [tabId]);
    assert.equal(done.error, undefined);
    assert.equal(done.cv, true);
    assert.match(await toastSays(page, /Quick apply done/), /\nClicking “Save and Continue” for the next step/);
    await reaches(page, 4);
    assert.deepEqual(await uploads(page), ['Ada_Lovelace_CV_tailored.pdf']);
    assert.equal((await state(page)).submitted, false);
  } finally {
    await page.close();
    await h.bg(() => globalThis.JTF.store.clearQuickApply());
    await h.bg(() => globalThis.JTF.store.removeLetter('quick-steps'));
    await h.setSettings({ autoAdvance: false });
  }
});
