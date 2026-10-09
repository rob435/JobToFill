// End-to-end: the page map — a page as the extension sees it (lib/pagemap.js, content/pagemap.js): an outline of
// its text, every field the fill scans with its ref, question, state and classification, the buttons and the frames;
// and the refs drawn on the page for screenshots. Its walker is only injected when a map is asked for.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PROFILE, RESUME_PDF, frameWith, launch } from './harness.mjs';

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

async function pageMap(page, extra) {
  const r = await h.handler('jtf:pagemap', page, extra);
  assert.equal(r.error, undefined, r.error);
  return r;
}

/** What the extension's scripts in a tab's top frame have loaded (they share one world, apart from the page's). */
const loaded = async (page) =>
  h.bg(
    async (tabId) => {
      const [r] = await globalThis.JTF.api.scripting.executeScript({
        target: { tabId },
        func: () => ({ main: !!globalThis.__jtf, pagemap: !!(globalThis.JTF && globalThis.JTF.pagemap) }),
      });
      return r.result;
    },
    await h.tabId(page),
  );

/** How many fields the fill's own scan (JTF.dom.collect) finds in a tab's top frame. */
const collected = async (page) =>
  h.bg(
    async (tabId) => {
      const [r] = await globalThis.JTF.api.scripting.executeScript({
        target: { tabId },
        func: () => globalThis.JTF.dom.collect(document).length,
      });
      return r.result;
    },
    await h.tabId(page),
  );

/** The field and button refs that start a line of the text, in order. */
const refsIn = (text, kind) =>
  text
    .split('\n')
    .map((l) => (l.match(/^\s*([fbi]\d+) /) || [])[1])
    .filter((ref) => ref && ref[0] === kind);
const line = (text, ref) => text.split('\n').find((l) => l.trim().startsWith(ref + ' '));
const byQuestion = (map, q) => map.fields.find((f) => f.question === q);
const range = (n, prefix) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

test('lazy: the walker goes into a fresh tab only when a map is asked for, and a fill never loads it', async () => {
  const page = await h.open('greenhouse.html?fresh');
  assert.deepEqual(await loaded(page), { main: false, pagemap: false }, 'nothing injected yet');
  const r = await pageMap(page);
  assert.equal(r.map.fields.length, 24);
  assert.deepEqual(await loaded(page), { main: true, pagemap: true });
  // Asked again: the same walker, the same map.
  assert.equal((await pageMap(page)).text, r.text);

  const filled = await h.open('greenhouse.html?fill-only');
  await h.fill(filled);
  assert.deepEqual(await loaded(filled), { main: true, pagemap: false }, 'a fill leaves the walker out');
  await Promise.all([page.close(), filled.close()]);
});

test('Greenhouse-style form: every field once with its ref, its section, options, rules and the submit', async () => {
  const page = await h.open('greenhouse.html');
  const { map, text } = await pageMap(page);
  const count = await collected(page);
  assert.equal(map.fields.length, count);
  assert.deepEqual(
    map.fields.map((f) => f.ref),
    range(count, 'f'),
  );
  assert.deepEqual(refsIn(text, 'f'), range(count, 'f'), 'each field on one line of its own');
  assert.deepEqual(refsIn(text, 'b'), ['b1']);
  assert.match(
    text,
    /^PAGE "Senior Engineer at Acme - Greenhouse-style application" http:\/\/localhost:\d+\/greenhouse\.html {2}lang=en {2}platform=greenhouse\n/,
  );
  assert.match(text, /\nFIELDS 24 \(4 required, 0 filled, 0 invalid\) {2}ACTIONS 1\n/);

  const first = byQuestion(map, 'First Name');
  assert.deepEqual(
    [first.ref, first.kind, first.required, first.hasValue, first.rules.type, first.rules.status],
    ['f1', 'text', true, false, 'name.first', 'ok'],
  );
  assert.equal(line(text, 'f1'), '  f1 text* "First Name" empty → name.first ✓');
  assert.equal(byQuestion(map, 'School').section, 'Education');
  assert.match(text, /\n {2}## Education\n {2}f14 text "School" empty → edu\.school ✓\n/);
  const auth = byQuestion(map, 'Are you legally authorized to work in the United States?');
  assert.deepEqual(auth.options, [
    { text: '--', placeholder: true },
    { text: 'Yes', value: '1' },
    { text: 'No', value: '0' },
  ]);
  assert.match(
    line(text, auth.ref),
    /"Are you legally authorized to work in the United States\?" \[Yes \| No\] none chosen → job\.authorized ✓$/,
  );
  assert.equal(byQuestion(map, 'Resume/CV').rules.status, 'ok', 'the CV is in the profile');
  assert.equal(byQuestion(map, 'Cover Letter').rules.status, 'empty', 'no cover letter is');
  assert.deepEqual(byQuestion(map, 'Why do you want to work at Acme?').rules, {
    type: 'custom',
    source: 'custom',
    status: 'ok',
  });
  assert.equal(byQuestion(map, 'Gender').rules.type, 'eeo.gender');
  assert.deepEqual(
    map.actions.map(({ ref, text: name, type, intent, disabled, visible }) => ({
      ref,
      name,
      type,
      intent,
      disabled,
      visible,
    })),
    [{ ref: 'b1', name: 'Submit Application', type: 'submit', intent: 'submit', disabled: false, visible: true }],
  );
  assert.equal(line(text, 'b1'), '  b1 submit "Submit Application" (submit)');
  assert.ok(first.rect.w > 100 && first.rect.h > 10 && first.visible && first.inViewport);
  await page.close();
});

test('after a fill: what each field holds and what the fill did, never what was typed', async () => {
  const page = await h.open('greenhouse.html');
  await h.fill(page);
  const { map, text } = await pageMap(page);
  const first = byQuestion(map, 'First Name');
  assert.deepEqual([first.hasValue, first.fill.status, 'value' in first], [true, 'filled', false]);
  assert.equal(line(text, first.ref), '  f1 text* "First Name" filled → name.first ✓ fill=filled');
  const auth = byQuestion(map, 'Are you legally authorized to work in the United States?');
  assert.deepEqual(auth.chosen, ['Yes']);
  assert.deepEqual(
    auth.options.filter((o) => o.chosen).map((o) => o.text),
    ['Yes'],
  );
  assert.match(line(text, auth.ref), /\[Yes \| No\] chosen "Yes" → job\.authorized ✓ fill=filled$/);
  // An equal-opportunity answer: filled, but which option is not said.
  const gender = byQuestion(map, 'Gender');
  assert.deepEqual([gender.hasValue, gender.withheld, gender.chosen], [true, true, undefined]);
  assert.ok(gender.options.every((o) => !o.chosen));
  assert.match(
    line(text, gender.ref),
    /"Gender" \[Male \| Female \| Decline To Self Identify\] filled \(answer withheld\)/,
  );
  assert.equal(byQuestion(map, 'Cover Letter').fill.status, 'nothing to put');
  assert.match(text, /\nFIELDS 24 \(4 required, 23 filled, 0 invalid\)/);
  for (const typed of ['Ada', 'Lovelace', 'ada@example.com', '415 555', 'I love engines', 'linkedin.com/in/ada'])
    assert.ok(!text.includes(typed) && !JSON.stringify(map).includes(typed), typed);

  // values: 'full' (the developers' CLI) shows what is typed, never a file's name.
  const full = await pageMap(page, { values: 'full' });
  assert.equal(byQuestion(full.map, 'First Name').value, 'Ada');
  assert.equal(line(full.text, 'f1'), '  f1 text* "First Name" = "Ada" → name.first ✓ fill=filled');
  assert.equal(byQuestion(full.map, 'Gender').value, 'Female');
  assert.ok(!('value' in byQuestion(full.map, 'Resume/CV')) && !full.text.includes('Lovelace_CV'));
  await page.close();
});

test('web components: the fields inside open shadow roots are on the map', async () => {
  const page = await h.open('shadow.html');
  const { map, text } = await pageMap(page);
  assert.deepEqual(
    map.fields.map((f) => [f.ref, f.question, f.rules.type]),
    [
      ['f1', 'First name', 'name.first'],
      ['f2', 'Last name', 'name.last'],
      ['f3', 'Email', 'email'],
      ['f4', 'LinkedIn profile', 'links.linkedin'],
    ],
  );
  assert.match(text, /\n# Apply \(web components\)\n\[form\]\n {2}f1 text "First name" empty → name\.first ✓\n/);
  await page.close();
});

test('frames: an embedded form is placed under its iframe, refs numbered across the page', async () => {
  const page = await h.open('embed.html');
  await frameWith(page, '127.0.0.1', '#first_name');
  const { map, text } = await pageMap(page);
  const frameUrl = h.url('greenhouse.html', '127.0.0.1');
  assert.deepEqual(
    map.frames.map((f) => [f.index, f.url, f.parent]),
    [
      [0, h.url('embed.html'), null],
      [1, frameUrl, { frame: 0, ref: 'i1' }],
    ],
  );
  assert.deepEqual(
    map.iframes.map((x) => [x.ref, x.src, x.child]),
    [['i1', frameUrl, 1]],
  );
  assert.deepEqual(
    map.fields.slice(0, 3).map((f) => [f.ref, f.local, f.frame, f.question]),
    [
      ['f1', 'f1', 0, 'Get job alerts by email'],
      ['f2', 'f1', 1, 'First Name'],
      ['f3', 'f2', 1, 'Last Name'],
    ],
  );
  assert.equal(map.fields.length, 25);
  assert.equal(map.platform, 'greenhouse');
  assert.ok(text.includes(`\ni1 frame ${frameUrl} → FRAME 1\nFRAME 1 ${frameUrl} (under i1) "Senior Engineer at Acme`));
  assert.ok(text.includes('\n  [form]\n    f2 text* "First Name" empty → name.first ✓\n'));
  assert.deepEqual(refsIn(text, 'f'), range(25, 'f'));
  await page.close();
});

test('widget libraries are named and counted', async () => {
  const antd = await h.open('lib-antd.html');
  await antd.waitForSelector('#apply_firstName');
  const a = await pageMap(antd);
  assert.equal(a.map.widgets['Ant Design'], 20);
  assert.match(a.text.split('\n')[0], /widgets=Ant Design×20$/);
  assert.equal(a.map.fields.length, 20);
  await antd.close();

  const jquery = await h.open('lib-jquery.html');
  await jquery.waitForFunction(() => document.getElementById('state').textContent.length > 2);
  const j = await pageMap(jquery);
  assert.deepEqual(j.map.widgets, {
    select2: 3,
    'Choices.js': 2,
    'Tom Select': 2,
    chosen: 2,
    'jQuery UI': 2,
    'intl-tel-input': 1,
  });
  // A select2 dropdown shows its choice; the country list it stands in for gives its options.
  const country = byQuestion(j.map, 'Country');
  assert.deepEqual([country.kind, country.chosen, country.optionCount], ['combo', ['Italy'], 69]);
  assert.match(line(j.text, country.ref), /"Country" \(68 options: Argentina \| Australia \|.* \| …\) chosen "Italy"/);
  await jquery.close();
});

test('steps, alerts, dialogs and cookie banners; navigation collapsed; nothing hidden on the map', async () => {
  const page = await h.open('pagemap.html');
  const { map, text } = await pageMap(page);
  assert.deepEqual(map.progress, { frame: 0, step: 2, total: 4, label: 'Education' });
  assert.deepEqual(map.alerts, [{ text: 'Please fix the 1 error below.', frame: 0 }]);
  assert.deepEqual(map.overlays, [
    { frame: 0, kind: 'cookie banner', name: '' },
    { frame: 0, kind: 'dialog', name: 'Before you continue', modal: true },
  ]);
  assert.equal(map.focus, 'f1');
  const school = byQuestion(map, 'University');
  assert.deepEqual(
    [school.required, school.invalid, school.error, school.validity],
    [true, true, 'This field is required', ['valueMissing']],
  );
  const degree = byQuestion(map, 'Degree');
  assert.deepEqual(
    degree.options.map((o) => [o.text, !!o.placeholder, !!o.disabled]),
    [
      ['Please select', true, false],
      ['BSc', false, false],
      ['BA', false, false],
      ['PhD', false, true],
    ],
  );
  assert.deepEqual(
    map.actions.map((a) => [a.text, a.type, a.intent]),
    [
      ['Back', 'button', 'back'],
      ['Save and continue', 'submit', 'next'],
      ['Save for later', 'link', 'save'],
      ['Accept all', 'button', 'accept-cookies'],
      ['Reject all', 'button', 'reject-cookies'],
      ['Close', 'button', 'close'],
    ],
  );
  assert.equal(
    text,
    [
      `PAGE "Apply – Northbridge Capital" ${h.url('pagemap.html')}  lang=en-GB`,
      'FIELDS 3 (1 required, 0 filled, 1 invalid)  ACTIONS 6  FOCUS f1',
      'PROGRESS step 2 of 4 "Education"',
      'ALERT "Please fix the 1 error below."',
      'OVERLAY cookie banner',
      'OVERLAY dialog "Before you continue" (modal)',
      '[header]',
      '  "Northbridge Capital"',
      '  [nav "Main"] 4 links: Jobs · Teams · Students · About us',
      '[main]',
      '  # Summer Analyst 2027',
      '  "Your details"',
      '  "Education"',
      '  "Questions"',
      '  "Review"',
      '  "We read every application. Tell us where you study and what you are studying."',
      '  "Your CV: [file] (uploaded on step 1)"',
      '  [form "Application"]',
      '    ## Education',
      '    f1 text* "University" empty → edu.school ✓ INVALID "This field is required"',
      '    f2 select "Degree" [BSc | BA | PhD (disabled)] none chosen → edu.degree ✓',
      '    f3 radio "Are you on a placement year?" [Yes | No] none chosen → (none: for AI)',
      '    b1 button "Back" (back)',
      '    b2 submit "Save and continue" (next)',
      '    b3 link "Save for later" (save)',
      '[footer] 3 links: Privacy · Terms · Cookies',
      '[cookie banner]',
      '  "We use cookies to understand how you use our site."',
      '  b4 button "Accept all" (accept-cookies)',
      '  b5 button "Reject all" (reject-cookies)',
      '  "Cookie settings"',
      '[dialog "Before you continue"]',
      '  "Your answers are saved as you go."',
      '  b6 button "Close" (close)',
    ].join('\n'),
  );
  assert.equal(map.fields.length, await collected(page));
  const json = JSON.stringify(map);
  for (const hidden of [
    'Hidden paragraph',
    'Decorative text',
    'Screen-reader-only',
    'Parked off-screen',
    'Hidden link',
    'Hidden field',
    'Leave this empty',
    'tok-123',
    'Lovelace_CV',
  ])
    assert.ok(!text.includes(hidden) && !json.includes(hidden), hidden);
  await page.close();
});

test('marks: each ref drawn on its field, button or frame, then taken off; nothing on the page moves or changes', async () => {
  const page = await h.open('embed.html');
  const frame = await frameWith(page, '127.0.0.1', '#first_name');
  await h.fill(page);
  /** Where everything is, and what every control holds, in the page and its frame. */
  const layout = async () =>
    Promise.all(
      [page, frame].map((f) =>
        f.$$eval('body *', (all) => [
          document.documentElement.scrollWidth,
          document.documentElement.scrollHeight,
          ...all.map((el) => {
            const r = el.getBoundingClientRect();
            return `${el.localName} ${r.x},${r.y},${r.width},${r.height} ${'value' in el ? el.value : ''}`;
          }),
        ]),
      ),
    );
  const marksIn = (f) => f.$$eval('jobtofill-marks', (list) => list.map((m) => m.hasAttribute('data-jtf-ui')));
  const before = await layout();

  const on = await h.handler('jtf:pagemap-marks', page, { on: true });
  assert.equal(on.error, undefined, on.error);
  const { map } = on;
  assert.equal(on.marks, map.fields.length + map.actions.length + map.iframes.length);
  assert.deepEqual([await marksIn(page), await marksIn(frame)], [[true], [true]]);
  assert.deepEqual(await layout(), before, 'nothing moved, nothing changed');
  // The page's refs, not each frame's own: the embedded form's "First Name" is f2.
  const names = await h.bg(([m, index]) => globalThis.JTF.pagemap.labels(m, index), [map, 1]);
  assert.equal(names.f1, 'f2');

  const off = await h.handler('jtf:pagemap-marks', page, { on: false });
  assert.deepEqual(off, { on: false });
  assert.deepEqual([await marksIn(page), await marksIn(frame)], [[], []]);
  assert.deepEqual(await layout(), before);
  await page.close();
});
