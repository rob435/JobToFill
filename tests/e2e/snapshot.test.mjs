// End-to-end: "Save a snapshot for a bug report" — the redacted copy of a filled form, with the trace of what the
// extension saw and did, as the developer would open it.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROFILE, RESUME_PDF, frameWith, isFirefox, launch } from './harness.mjs';

let h;
let dir;

before(async () => {
  h = await launch();
  dir = await mkdtemp(path.join(os.tmpdir(), 'jtf-snapshot-'));
  const profileId = await h.setProfile(PROFILE);
  await h.bg(
    ([id, dataUrl]) =>
      globalThis.JTF.store.setDoc(id, 'resume', {
        name: 'Ada_Lovelace_CV.pdf',
        type: 'application/pdf',
        size: 60,
        dataUrl,
      }),
    [profileId, RESUME_PDF],
  );
});

after(() => h.close());

async function snapshot(page) {
  const r = await h.handler('jtf:snapshot', page, { returnHtml: true });
  assert.equal(r.error, undefined, r.error);
  return r.html;
}

/** What must never be in a snapshot: the profile's identifying details, in any case or format. */
function assertNoPersonalData(html) {
  assert.doesNotMatch(html, /\bAda\b/i, 'first name');
  assert.doesNotMatch(html, /\bLovelace\b/i, 'last name');
  assert.ok(!/ada@example\.com|ada%40example/i.test(html), 'email');
  assert.ok(!html.replace(/[\s().\-+/]/g, '').includes('4155550100'), 'phone digits');
  assert.doesNotMatch(html, /1\s+Market\s+St/i, 'address line 1');
  assert.doesNotMatch(html, /Apt\s+5/i, 'address line 2');
  assert.ok(!html.includes('94105'), 'postcode');
  assert.ok(!/linkedin\.com\/in\/ada|github\.com\/ada|ada\.dev/i.test(html), 'links');
  assert.ok(!/Lovelace_CV/i.test(html), 'file name');
  assert.ok(!html.includes('I love engines'), 'typed answers');
}

/** Open the snapshot as the developer would: the file, from disk. */
async function open(html, name) {
  const file = path.join(dir, name);
  await writeFile(file, html);
  const page = await h.newPage();
  await page.goto(pathToFileURL(file).href);
  return page;
}

const trace = (page) => page.$eval('#jtf-trace', (s) => JSON.parse(s.textContent));

test('Greenhouse-style form: the copy keeps the form and what was picked, without the person', async () => {
  // A login saved for the site: its username and password are taken out too.
  await h.bg(() =>
    globalThis.JTF.passwords.update((d) =>
      d.credentials.push({ id: 'snap', host: 'localhost', username: 'adal_1815', password: 'Engine&1843!' }),
    ),
  );
  const page = await h.open('greenhouse.html');
  await h.fill(page);
  // Personal details the page shows by itself, a script, a handler and an image, as real pages have.
  await page.$eval('form', (form) => {
    const box = document.createElement('div');
    box.id = 'review';
    box.innerHTML = `<p id="hello" title="Signed in as ADA@EXAMPLE.COM">Welcome back, ADA LOVELACE</p>
      <p id="call" aria-label="Phone +1 (415) 555-0100">Call me on (415) 555-0100</p>
      <a id="li" href="https://www.linkedin.com/in/ada?trk=profile" onclick="steal()">My LinkedIn</a>
      <a id="bad" href="javascript:alert(1)">Bad</a>
      <img id="photo" src="https://example.com/avatar.png" alt="Profile photo">
      <address id="home">1 Market St, Apt 5, San Francisco 94105</address>
      <div id="editor" contenteditable="true">Dear hiring team, I am Ada.</div>
      <input type="hidden" name="csrf" value="secret-token-123">
      <p id="account" data-login="adal_1815">Account adal_1815, password Engine&amp;1843!</p>`;
    form.before(box);
    const s = document.createElement('script');
    s.textContent = 'window.pageScript = 1';
    document.body.append(s);
  });
  const html = await snapshot(page);
  assertNoPersonalData(html);
  assert.equal(html.match(/<script/gi).length, 1, 'one <script>: the trace');
  assert.match(html, /<script type="application\/json" id="jtf-trace">/);
  assert.doesNotMatch(html, /javascript:|secret-token-123|onclick|adal_1815|Engine&(amp;)?1843/i);
  assert.match(
    html,
    /^<!doctype html>\n<!--\n {2}Redacted snapshot made by JobToFill \d+\.\d+\.\d+ on \d{4}-\d\d-\d\d \d\d:\d\d: form values/,
  );

  const view = await open(html, 'greenhouse.html');
  const $ = (selector, fn) => view.$eval(selector, fn);
  // The form as it was: labels, options and what the fill picked.
  assert.equal(await $('label[for=first_name]', (l) => l.textContent.trim()), 'First Name *');
  assert.equal(
    await $('label[for=q_auth]', (l) => l.textContent),
    'Are you legally authorized to work in the United States?',
  );
  assert.equal(await $('#q_auth', (s) => s.options[s.selectedIndex].text), 'Yes');
  assert.equal(await $('#q_sponsor', (s) => s.options[s.selectedIndex].text), 'No');
  assert.equal(await $('#degree', (s) => s.options[s.selectedIndex].text), "Bachelor's Degree");
  assert.equal(await $('#q_source', (s) => s.options[s.selectedIndex].text), 'LinkedIn');
  // …but not equal-opportunity answers, and no typed value.
  assert.equal(await $('#gender', (s) => s.querySelectorAll('option[selected]').length), 0);
  assert.equal(await $('#gender', (s) => s.options.length), 4);
  for (const id of ['first_name', 'email', 'phone', 'q_linkedin', 'school'])
    assert.deepEqual(await $(`#${id}`, (i) => [i.value, i.hasAttribute('data-jtf-had-value')]), ['', true], id);
  assert.equal(await $('#q_why', (t) => t.value), '');
  assert.equal(await $('input[name=csrf]', (i) => i.value), '');
  // What the page showed, redacted; scripts, handlers and images gone.
  assert.equal(await $('#hello', (p) => p.textContent), 'Welcome back, [first name] [last name]');
  assert.equal(await $('#hello', (p) => p.title), 'Signed in as [email]');
  assert.equal(
    await $('#call', (p) => [p.getAttribute('aria-label'), p.textContent].join(' | ')),
    'Phone [phone] | Call me on [phone]',
  );
  assert.equal(await $('#home', (a) => a.textContent), '[address], [address line 2], San Francisco [postcode]');
  assert.equal(await $('#li', (a) => [a.getAttribute('href'), a.hasAttribute('onclick')].join()), '[linkedin],false');
  assert.equal(await $('#bad', (a) => a.hasAttribute('href')), false);
  assert.deepEqual(await $('#photo', (i) => [i.hasAttribute('src'), i.alt]), [false, 'Profile photo']);
  assert.equal(await $('#editor', (d) => d.textContent), '');
  assert.deepEqual(await $('#account', (p) => [p.textContent, p.dataset.login]), [
    'Account [username], password [password]',
    '[username]',
  ]);
  assert.equal(
    await view.$$eval('script', (list) => list.map((s) => `${s.type}#${s.id}`).join()),
    'application/json#jtf-trace',
  );
  assert.equal(
    await view.$$eval('*', (all) => all.filter((el) => [...el.attributes].some((a) => /^on/i.test(a.name))).length),
    0,
  );
  assert.equal(await $('base', (b) => b.getAttribute('href')), h.url('greenhouse.html'));
  assert.match(await $('meta[http-equiv="Content-Security-Policy"]', (m) => m.content), /script-src 'none'/);

  // The trace: what the extension saw and what the fill did, never a value.
  const t = await trace(view);
  assert.equal(t.url, h.url('greenhouse.html'));
  assert.equal(t.title, 'Senior Engineer at Acme - Greenhouse-style application');
  assert.match(t.version, /^\d+\.\d+\.\d+$/);
  assert.equal(t.frames.length, 1);
  const fields = t.frames[0].fields;
  const field = (q) => fields.find((f) => f.question === q);
  assert.deepEqual(
    (({ kind, type, hasValue, required, path: p }) => ({ kind, type, hasValue, required, path: p }))(
      field('First Name'),
    ),
    { kind: 'text', type: 'name.first', hasValue: true, required: true, path: 'input#first_name' },
  );
  assert.equal(field('Email').type, 'email');
  assert.equal(field('Gender').type, 'eeo.gender');
  assert.deepEqual(field('Are you legally authorized to work in the United States?').options, ['--', 'Yes', 'No']);
  assert.equal(field('Cover Letter').hasValue, false);
  assert.equal(field('School').section, 'Education');
  const fills = t.frames[0].fillTrace;
  assert.ok(fills.filter((f) => f.status === 'filled').length >= 15, JSON.stringify(fills));
  const first = fills.find((f) => f.question === 'First Name');
  assert.deepEqual([first.kind, first.type, first.status, first.path], ['text', 'text', 'filled', 'input#first_name']);
  assert.ok(fills.every((f) => !('value' in f) && !('text' in f)));
  assert.ok(
    fills.some((f) => f.question === 'Resume/CV' && f.type === 'file' && f.status === 'filled'),
    'the upload is in the trace',
  );
  await Promise.all([view.close(), page.close()]);
  await h.bg(() =>
    globalThis.JTF.passwords.update((d) => (d.credentials = d.credentials.filter((c) => c.id !== 'snap'))),
  );
});

test('web components: open shadow roots are kept as declarative shadow DOM, values out', async () => {
  const page = await h.open('shadow.html');
  await h.fill(page);
  const html = await snapshot(page);
  assertNoPersonalData(html);
  assert.equal(html.match(/<script/gi).length, 1);
  assert.match(html, /<apply-form><template shadowrootmode="open"><form>/);

  const view = await open(html, 'shadow.html');
  // Opened from disk, the shadow roots come back: the same inputs, labels and structure the extension scanned.
  const inside = await view.$eval('apply-form', (form) =>
    [...form.shadowRoot.querySelectorAll('apply-field')].map((f) => {
      const input = f.shadowRoot.querySelector('input');
      return [
        f.shadowRoot.querySelector('label').textContent,
        input.name,
        input.value,
        input.hasAttribute('data-jtf-had-value'),
      ];
    }),
  );
  assert.deepEqual(inside, [
    ['First name', 'firstName', '', true],
    ['Last name', 'lastName', '', true],
    ['Email', 'email', '', true],
    ['LinkedIn profile', 'linkedin', '', true],
  ]);
  const t = await trace(view);
  assert.deepEqual(
    t.frames[0].fields.map((f) => [f.question, f.type, f.path]),
    [
      [
        'First name',
        'name.first',
        'html > body > apply-form >>> form > apply-field:nth-of-type(1) >>> input#f-firstName',
      ],
      ['Last name', 'name.last', 'html > body > apply-form >>> form > apply-field:nth-of-type(2) >>> input#f-lastName'],
      ['Email', 'email', 'html > body > apply-form >>> form > apply-field:nth-of-type(3) >>> input#f-email'],
      [
        'LinkedIn profile',
        'links.linkedin',
        'html > body > apply-form >>> form > apply-field:nth-of-type(4) >>> input#f-linkedin',
      ],
    ],
  );
  assert.deepEqual(
    t.frames[0].fillTrace.map((f) => f.status),
    ['filled', 'filled', 'filled', 'filled'],
  );
  await Promise.all([view.close(), page.close()]);
});

test('a form in a cross-origin frame comes after the page, in a template named after the frame', async () => {
  const page = await h.open('embed.html');
  await frameWith(page, '127.0.0.1', '#first_name');
  await h.fill(page);
  const html = await snapshot(page);
  assertNoPersonalData(html);
  assert.equal(html.match(/<script/gi).length, 1);
  const frameUrl = h.url('greenhouse.html', '127.0.0.1');
  assert.ok(html.includes(`<iframe id="gh" data-frame-url="${frameUrl}">`), 'the frame, without its src');
  assert.ok(html.includes(`<template data-frame-url="${frameUrl}">`));

  const view = await open(html, 'embed.html');
  const inFrame = await view.$eval(`template[data-frame-url="${frameUrl}"]`, (t) => {
    const c = t.content;
    return [
      c.querySelector('label[for=first_name]').textContent.trim(),
      c.querySelector('#q_auth option[selected]').textContent,
    ];
  });
  assert.deepEqual(inFrame, ['First Name *', 'Yes']);
  const t = await trace(view);
  assert.deepEqual(
    t.frames.map((f) => f.url),
    [h.url('embed.html'), frameUrl],
  );
  assert.equal(t.frames[0].fields[0].question, 'Get job alerts by email');
  assert.ok(t.frames[1].fields.some((f) => f.question === 'First Name' && f.type === 'name.first' && f.hasValue));
  assert.ok(t.frames[1].fillTrace.some((f) => f.question === 'First Name' && f.status === 'filled'));
  await Promise.all([view.close(), page.close()]);
});

test('before any fill, and saved to Downloads as jobtofill-snapshot-<host>-<date>.html', async () => {
  const page = await h.open('greenhouse.html');
  const html = await snapshot(page);
  const view = await open(html, 'unfilled.html');
  const t = await trace(view);
  assert.ok(t.frames[0].fields.length >= 20);
  assert.ok(t.frames[0].fields.every((f) => f.hasValue === false));
  assert.deepEqual(t.frames[0].fillTrace, []);
  await view.close();

  const r = await h.handler('jtf:snapshot', page, { saveAs: false });
  assert.equal(r.error, undefined, r.error);
  assert.match(r.filename, /^jobtofill-snapshot-localhost-\d{8}-\d{4}\.html$/);
  const item = await h.bg(async (id) => {
    for (let i = 0; i < 50; i++) {
      const [d] = await globalThis.JTF.api.downloads.search({ id });
      if (d && d.state !== 'in_progress') return d;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  }, r.id);
  assert.equal(item && item.state, 'complete', JSON.stringify(item));
  // (Playwright keeps downloads under names of its own: the name asked for is checked above.)
  const saved = await readFile(item.filename, 'utf8');
  assert.ok(saved.startsWith('\ufeff<!doctype html>'), 'UTF-8 with a byte order mark');
  assert.match(saved, /<label for="q_auth">Are you legally authorized/);
  assertNoPersonalData(saved);
  await page.close();
});

test(
  'popup: "Save a snapshot for a bug report" saves the page it points at',
  { skip: isFirefox && 'Chromium popup' },
  async () => {
    const page = await h.open('greenhouse.html');
    const tabId = await h.tabId(page);
    const popup = await h.newPage();
    await popup.goto(h.extUrl(`popup/popup.html?tab=${tabId}`));
    await popup.click('#snapshot');
    await popup.waitForSelector('#snapshot-status:not([hidden])');
    await popup.waitForFunction(() => document.querySelector('#snapshot-status').textContent !== 'Saving…');
    assert.equal(await popup.textContent('#snapshot-status'), 'Snapshot saved');
    await Promise.all([popup.close(), page.close()]);
  },
);
