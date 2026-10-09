// End-to-end: the page map viewer (map/), opened from the popup's Page map: the outline of a tab's page with its refs
// and numbers, its filters, a line's field shown on the page, the refs drawn and taken off, what Copy and Save hand
// over (the redacted map), and what it says when it can't map. Only what both drivers share (harness.mjs).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PROFILE, RESUME_PDF, launch, until } from './harness.mjs';

let h;

before(async () => {
  h = await launch();
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

/** The viewer for a tab, once it has a map on it or has said why not. */
async function viewer(tabId) {
  const view = await h.extPage(`map/map.html?tab=${tabId}`);
  await until(
    view.call,
    () =>
      document.querySelector('#outline').getAttribute('aria-busy') === 'false' ||
      !document.querySelector('#problem').hidden,
  );
  return view;
}

/** The outline's lines as they show (indentation is the line's padding, not its text). */
const shownLines = (view) =>
  view.call(() => [...document.querySelectorAll('#outline .line')].filter((l) => !l.hidden).map((l) => l.textContent));
const click = (view, selector) => view.call((s) => document.querySelector(s).click(), selector);
const textOf = (view, selector) => view.call((s) => document.querySelector(s).textContent.trim(), selector);
const shown = (view, selector) => view.call((s) => !document.querySelector(s).hidden, selector);
const setFilter = (view, need, search) =>
  view.call(
    ([n, q]) => {
      const box = document.querySelector('#need');
      box.checked = n;
      box.dispatchEvent(new Event('change'));
      const input = document.querySelector('#search');
      input.value = q;
      input.dispatchEvent(new Event('input'));
    },
    [need, search],
  );
/** The tab showing one of the extension's own pages (tabs don't show their address without the "tabs" permission). */
const extensionTab = (file) =>
  h.bg(async (f) => {
    const { api } = globalThis.JTF;
    const url = api.runtime.getURL(f);
    const pages = await api.runtime.getContexts({ contextTypes: ['TAB'] });
    const hit = pages.filter((c) => c.documentUrl === url).pop();
    return hit ? hit.tabId : null;
  }, file);

test('the popup’s Page map opens the viewer beside the page; it is off on a page JobToFill can’t run on', async () => {
  const form = await h.open('greenhouse.html?popup');
  const tabId = await h.tabId(form);
  const popup = await h.extPage(`popup/popup.html?tab=${tabId}`);
  await until(popup.call, () => document.querySelector('#version').textContent);
  assert.deepEqual(
    await popup.call(() => {
      const b = document.querySelector('#pagemap');
      return [b.textContent.trim(), b.disabled, b.title];
    }),
    [
      'Page map',
      false,
      'See this page the way JobToFill and the AI see it: every field, what it’s taken for, and what’s missing',
    ],
  );
  // The popup closes itself once the tab is asked for: the click goes after this call has returned.
  await popup.call(() => setTimeout(() => document.querySelector('#pagemap').click(), 0));
  const viewerTab = await until(extensionTab, `map/map.html?tab=${tabId}`);
  const opened = await h.bg(
    async ([id, page]) => {
      const { api } = globalThis.JTF;
      const [tab, form] = await Promise.all([api.tabs.get(id), api.tabs.get(page)]);
      return {
        index: tab.index - form.index,
        window: tab.windowId === form.windowId,
        opener: tab.openerTabId === page,
      };
    },
    [viewerTab, tabId],
  );
  assert.deepEqual(opened, { index: 1, window: true, opener: true }, 'right after the page, opened from it');
  await h.bg((id) => globalThis.JTF.api.tabs.remove(id), viewerTab);
  await popup.close().catch(() => {});

  const settings = await h.extPage('options/options.html');
  const other = await h.extPage(`popup/popup.html?tab=${await extensionTab('options/options.html')}`);
  await until(other.call, () => document.querySelector('#version').textContent);
  assert.equal(await other.call(() => document.querySelector('#pagemap').disabled), true);
  await Promise.all([other.close(), settings.close(), form.close()]);
});

test('the outline: every line of the map, each field and button a line that shows it, the numbers above', async () => {
  const page = await h.open('greenhouse.html');
  await h.fill(page);
  const view = await viewer(await h.tabId(page));
  const { text } = await h.handler('jtf:pagemap', page, { maxChars: 60000 });
  assert.deepEqual(
    await shownLines(view),
    text.split('\n').map((l) => l.trimStart()),
    'the text map, line by line',
  );
  assert.equal(await textOf(view, '#page-title'), 'Senior Engineer at Acme - Greenhouse-style application');
  assert.match(await textOf(view, '#page-where'), /^localhost · Greenhouse · mapped at \d\d:\d\d$/);
  assert.deepEqual(await view.call(() => [...document.querySelectorAll('#counts li')].map((li) => li.textContent)), [
    '24 fields',
    '4 required',
    '23 filled',
    '0 invalid',
    '1 action',
    '1 needs something',
  ]);
  assert.equal(await shown(view, '#no-fields'), false);
  // Each field and the button is a button of its own; its badge coloured by what the rules make of it.
  const refs = await view.call(() =>
    [...document.querySelectorAll('#outline button.go')].map((b) => [b.dataset.ref, b.querySelector('.ref').className]),
  );
  assert.deepEqual(
    refs.map(([ref]) => ref),
    [...Array.from({ length: 24 }, (_, i) => `f${i + 1}`), 'b1'],
  );
  assert.deepEqual(
    [refs[0][1], refs[6][1], refs[24][1]],
    ['ref ok', 'ref empty', 'ref action'],
    'f1 ✓, f7 ✗ no value, b1',
  );
  assert.deepEqual(
    await view.call(() => [
      ...[...document.querySelectorAll('button.go[data-ref="f7"] [class^="tok-"]')].map(
        (s) => `${s.className}:${s.textContent}`,
      ),
    ]),
    [
      'tok-kind:file ',
      'tok-q:"Cover Letter"',
      'tok-rule:→ file.coverLetter',
      'tok-missing:✗ no value',
      'tok-fill-warn:fill=nothing to put',
    ],
  );
  assert.match(await view.call(() => document.querySelector('#outline').getAttribute('aria-label')), /^Page map of /);

  // Only fields that need something: the cover letter, under its heading and form.
  await setFilter(view, true, '');
  assert.deepEqual(await shownLines(view), [
    '# Apply for Senior Engineer',
    '[form]',
    'f7 file "Cover Letter" no file → file.coverLetter ✗ no value fill=nothing to put',
  ]);
  assert.deepEqual(
    await view.call(() => [...document.querySelectorAll('#outline .line.context')].map((l) => l.textContent)),
    ['# Apply for Senior Engineer', '[form]'],
  );
  assert.equal(await textOf(view, '#shown'), '1 of 24 fields need something.');
  // A search, on its own and with the filter.
  await setFilter(view, false, 'degree');
  assert.deepEqual(
    (await shownLines(view)).map((l) => l.slice(0, 20)),
    ['[form]', '## Education', 'f15 select "Degree" '],
  );
  assert.equal(await textOf(view, '#shown'), '1 line matches “degree”.');
  await setFilter(view, true, 'degree');
  assert.equal(await textOf(view, '#shown'), 'Nothing that needs something matches “degree”.');
  assert.deepEqual(await shownLines(view), []);
  await setFilter(view, false, '');
  assert.equal((await shownLines(view)).length, text.split('\n').length);
  assert.equal(await textOf(view, '#shown'), '');
  await Promise.all([view.close(), page.close()]);
});

test('a click on a line shows its field on the page, outlined for a moment; a field that went is said so', async () => {
  const page = await h.open('greenhouse.html?reveal');
  const tabId = await h.tabId(page);
  const view = await viewer(tabId);
  const inPage = (fn, arg) => page.$eval('html', fn, arg);

  // There, but nothing of it shows.
  await inPage(() => (document.querySelector('#last_name').style.display = 'none'));
  await click(view, 'button.go[data-ref="f2"]');
  await until(view.call, () => /nothing of it shows/.test(document.querySelector('#status').textContent));
  assert.equal(await inPage(() => !!document.querySelector('jobtofill-reveal')), false);
  // Gone from the page: the map is out of date, and a new one is offered.
  await inPage(() => document.querySelector('#first_name').remove());
  await click(view, 'button.go[data-ref="f1"]');
  await until(view.call, () => !document.querySelector('#stale').hidden);
  assert.equal(
    await textOf(view, '#stale-text'),
    'f1 isn’t on the page any more: it has changed since this map was made.',
  );
  await click(view, '#stale-refresh');
  await until(
    view.call,
    () => document.querySelector('#stale').hidden && /Updated/.test(document.querySelector('#status').textContent),
  );
  assert.ok(!(await shownLines(view)).some((l) => l.includes('"First Name"')));

  // The submit button, below the fold: scrolled into view, the tab in front, outlined, then not.
  const submit = () =>
    inPage(() => {
      const r = document.querySelector('button[type=submit]').getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight;
    });
  assert.equal(await submit(), false, 'starts out of view');
  const height = await inPage(() => document.documentElement.scrollHeight);
  await click(view, 'button.go[data-ref="b1"]');
  await until(view.call, () => document.querySelector('#status').textContent === 'Showed b1 on the page.');
  assert.equal(await inPage(() => !!document.querySelector('jobtofill-reveal[data-jtf-ui]')), true, 'outlined');
  await until(inPage, () => {
    const r = document.querySelector('button[type=submit]').getBoundingClientRect();
    return r.top >= 0 && r.bottom <= innerHeight;
  });
  assert.equal(await h.bg((id) => globalThis.JTF.api.tabs.get(id).then((t) => t.active), tabId), true);
  assert.equal(await inPage(() => document.documentElement.scrollHeight), height, 'nothing moved');
  await until(inPage, () => !document.querySelector('jobtofill-reveal'), null, 4000);
  await Promise.all([view.close(), page.close()]);
});

test('refs drawn on the page from the viewer, and taken off again', async () => {
  const page = await h.open('pagemap.html');
  const view = await viewer(await h.tabId(page));
  const marks = () => page.$$eval('jobtofill-marks', (list) => list.length);
  await click(view, '#marks');
  await until(view.call, () => document.querySelector('#marks').getAttribute('aria-pressed') === 'true');
  assert.equal(await textOf(view, '#marks'), 'Hide refs');
  assert.equal(await textOf(view, '#status'), '9 refs drawn on the page.', '3 fields and 6 buttons');
  assert.equal(await marks(), 1);
  await click(view, '#marks');
  await until(view.call, () => document.querySelector('#marks').getAttribute('aria-pressed') === 'false');
  assert.equal(await textOf(view, '#marks'), 'Show refs on the page');
  assert.equal(await marks(), 0);
  // The page's own numbers, and its alert, at the top of the outline.
  assert.deepEqual(await view.call(() => [...document.querySelectorAll('#counts li')].map((li) => li.textContent)), [
    '3 fields',
    '1 required',
    '0 filled',
    '1 invalid',
    '6 actions',
    '2 need something',
  ]);
  assert.match(await textOf(view, '#page-where'), /^localhost · Step 2 of 4: Education · mapped at/);
  assert.ok((await shownLines(view)).includes('ALERT "Please fix the 1 error below."'));
  await setFilter(view, true, '');
  assert.deepEqual(
    (await shownLines(view)).filter((l) => /^f\d/.test(l)),
    [
      'f1 text* "University" empty → edu.school ✓ INVALID "This field is required"',
      'f3 radio "Are you on a placement year?" [Yes | No] none chosen → (none: for AI)',
    ],
  );
  assert.equal(
    await view.call(() => document.querySelector('button.go[data-ref="f3"] .tok-ai').textContent),
    '→ (none: for AI)',
  );
  await Promise.all([view.close(), page.close()]);
});

test('Copy and Save hand over the redacted map: your details as placeholders, saved logins too', async () => {
  await h.bg(() =>
    globalThis.JTF.passwords.update((d) =>
      d.credentials.push({ id: 'map', host: 'localhost', username: 'adal_1815', password: 'Engine&1843!' }),
    ),
  );
  const page = await h.open('greenhouse.html?copy');
  await h.fill(page);
  await page.$eval('form', (form) => {
    const box = document.createElement('div');
    box.innerHTML = `<p>Welcome back, ADA LOVELACE (ada@example.com)</p>
      <p>Account adal_1815, password Engine&amp;1843!</p>`;
    form.before(box);
  });
  /** Nothing of the person in it. */
  const assertRedacted = (text) => {
    for (const leak of [/\bAda\b/i, /Lovelace/i, /ada@example\.com/i, /adal_1815/, /Engine&1843/, /415 555/])
      assert.doesNotMatch(text, leak);
    assert.ok(!text.includes('I love engines'));
  };
  const redacted = await h.handler('jtf:pagemap', page, { values: 'redacted', maxChars: 60000 });
  assert.equal(redacted.error, undefined, redacted.error);
  assertRedacted(redacted.text);
  assert.match(redacted.text, /\n"Welcome back, \[first name\] \[last name\] \(\[email\]\)"\n/);
  assert.match(redacted.text, /\n"Account \[username\], password \[password\]"\n/);
  assert.match(redacted.text, /\n {2}f1 text\* "First Name" filled → name\.first ✓ fill=filled\n/);

  const view = await viewer(await h.tabId(page));
  // What the page shows here is the person's own browser: their name is on it, as on the page.
  assert.ok((await shownLines(view)).includes('"Welcome back, ADA LOVELACE (ada@example.com)"'));
  assert.equal(
    await textOf(view, '.privacy'),
    'Shown as it is in your browser. Copy and Save replace your details with placeholders.',
  );
  await view.call(() => {
    window.copied = null;
    navigator.clipboard.writeText = (t) => ((window.copied = t), Promise.resolve());
  });
  await click(view, '#copy');
  const copied = await until(view.call, () => window.copied);
  assert.match(copied, /^JobToFill page map: this web page as text, the way the JobToFill extension sees it\. .*\n\n/);
  assert.equal(copied.split('\n\n').slice(1).join('\n\n'), redacted.text + '\n');
  assertRedacted(copied);
  assert.equal(await textOf(view, '#status'), 'Copied — your details are replaced with placeholders');

  // No clipboard (the page lost focus): the same text, to copy by hand.
  await view.call(() => (navigator.clipboard.writeText = () => Promise.reject(new Error('Document is not focused.'))));
  await click(view, '#copy');
  await until(view.call, () => !document.querySelector('#copy-box').hidden);
  assert.equal(await view.call(() => document.querySelector('#copy-text').value), copied);

  await view.call(() => {
    window.saved = null;
    HTMLAnchorElement.prototype.click = function () {
      const saved = (window.saved = { name: this.download, text: null });
      fetch(this.href)
        .then((r) => r.text())
        .then((t) => (saved.text = t));
    };
  });
  await click(view, '#save');
  const saved = await until(view.call, () => window.saved && window.saved.text != null && window.saved);
  assert.match(saved.name, /^jobtofill-pagemap-localhost-\d{8}-\d{4}\.txt$/);
  assert.equal(saved.text, copied);
  assert.match(await textOf(view, '#status'), /^Saved jobtofill-pagemap-localhost-.*\.txt — your details are replaced/);
  await Promise.all([view.close(), page.close()]);
  await h.bg(() =>
    globalThis.JTF.passwords.update((d) => (d.credentials = d.credentials.filter((c) => c.id !== 'map'))),
  );
});

test('what it says: a page without fields, a page it can’t run on, a closed tab; the legend as last left', async () => {
  const bare = await h.open('pagemap.html?bare');
  await bare.$eval('html', () => document.querySelectorAll('form, input, select, textarea').forEach((x) => x.remove()));
  const view = await viewer(await h.tabId(bare));
  assert.equal(await shown(view, '#no-fields'), true);
  assert.equal(await view.call(() => document.querySelector('#counts li').textContent), '0 fields');
  assert.ok((await shownLines(view)).includes('# Summer Analyst 2027'), 'the outline is still there');
  await setFilter(view, true, '');
  assert.equal(await textOf(view, '#shown'), 'There are no fields on this page.');
  // The legend: open the first time, then as it was left.
  await view.call(() => localStorage.setItem('jtf-pagemap-legend', 'seen'));
  await view.close();

  const settings = await h.extPage('options/options.html');
  const cant = await viewer(await extensionTab('options/options.html'));
  assert.equal(await textOf(cant, '#problem-title'), 'Can’t map this page');
  assert.match(await textOf(cant, '#problem-text'), /^JobToFill can’t run on this page/);
  assert.deepEqual(await Promise.all(['#outline-card', '#summary', '#problem-retry'].map((s) => shown(cant, s))), [
    false,
    false,
    true,
  ]);
  assert.equal(await cant.call(() => document.querySelector('#legend').open), false, 'closed after the first visit');
  await cant.call(() => localStorage.setItem('jtf-pagemap-legend', 'open'));
  await Promise.all([cant.close(), settings.close()]);

  const view2 = await viewer(await h.tabId(bare));
  assert.equal(await view2.call(() => document.querySelector('#legend').open), true, 'left open');
  await bare.close();
  await until(view2.call, () => !document.querySelector('#problem').hidden);
  assert.equal(await textOf(view2, '#problem-title'), 'This tab is closed.');
  assert.deepEqual(
    await view2.call(() => ['#refresh', '#marks', '#copy', '#save'].map((s) => document.querySelector(s).disabled)),
    [true, true, true, true],
  );
  await view2.close();
});
