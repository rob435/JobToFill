// Page maps (lib/pagemap.js): frames' own maps merged into one page, and the text outline written within a budget,
// on hand-built maps.
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers');

load();
require('../../extension/lib/jobpage.js');
const pagemap = require('../../extension/lib/pagemap.js');
const { merge, render, labels, intentOf } = pagemap;

const FRAME_URL = 'https://boards.greenhouse.io/embed/job_app';

function field(ref, extra) {
  return Object.assign(
    {
      ref,
      kind: 'text',
      inputType: 'text',
      question: `Question ${ref}`,
      hasValue: false,
      required: false,
      invalid: false,
      visible: true,
      rules: { type: null, status: 'unknown' },
    },
    extra,
  );
}

/** A careers page with a Greenhouse embed, an advert frame and an empty frame, as the background gets them. */
function frames() {
  return [
    {
      frameId: 4,
      url: 'about:',
      outline: [],
      fields: [],
      actions: [],
      iframes: [],
    },
    {
      frameId: 7,
      url: FRAME_URL,
      title: 'Job application',
      values: 'state',
      hasFocus: true,
      focus: 'f2',
      viewport: { width: 600, height: 800 },
      outline: [
        { t: 'h', level: 2, text: 'Personal information' },
        { t: 'field', ref: 'f1' },
        { t: 'field', ref: 'f2' },
        { t: 'action', ref: 'b1' },
      ],
      fields: [
        field('f1', { question: 'First Name', required: true, rules: { type: 'name.first', status: 'ok' } }),
        field('f2', { kind: 'email', inputType: 'email', question: 'Email', rules: { type: 'email', status: 'ok' } }),
      ],
      actions: [{ ref: 'b1', text: 'Submit application', type: 'submit', intent: 'submit' }],
      iframes: [],
      counts: { fields: 2, required: 1, filled: 0, invalid: 0, actions: 1 },
      alerts: ['Please complete all required fields.'],
    },
    {
      frameId: 0,
      isTop: true,
      url: 'https://careers.acme.test/jobs/42',
      title: 'Engineer – Acme',
      lang: 'en',
      values: 'state',
      hasFocus: true,
      focus: 'i1',
      outline: [
        { t: 'h', level: 1, text: 'Engineer' },
        { t: 'text', text: 'Join the engine team.' },
        { t: 'landmark', role: 'form', name: 'Job alerts', children: [{ t: 'field', ref: 'f1' }] },
        { t: 'frame', ref: 'i1' },
        { t: 'frame', ref: 'i2' },
      ],
      fields: [field('f1', { kind: 'email', inputType: 'email', question: 'Get job alerts by email' })],
      actions: [],
      iframes: [
        { ref: 'i1', src: FRAME_URL, rect: { x: 0, y: 300, w: 600, h: 800 } },
        { ref: 'i2', src: 'https://ads.example/slot', rect: { x: 0, y: 0, w: 300, h: 50 } },
      ],
      widgets: { 'react-select': 2 },
      counts: { fields: 1, required: 0, filled: 0, invalid: 0, actions: 0 },
    },
    {
      frameId: 9,
      url: 'https://tracker.example/pixel',
      outline: [{ t: 'text', text: 'Advert' }],
      fields: [],
      actions: [],
      iframes: [],
    },
  ];
}

test('merge: each frame under the iframe that shows it, refs numbered across the page', () => {
  const map = merge(frames());
  assert.deepEqual(
    map.frames.map((f) => [f.index, f.frameId, f.placed, f.parent]),
    [
      [0, 0, true, null],
      [1, 7, true, { frame: 0, ref: 'i1' }],
      [2, 4, false, null],
      [3, 9, false, null],
    ],
  );
  assert.deepEqual(
    map.fields.map((f) => [f.ref, f.local, f.frame, f.question]),
    [
      ['f1', 'f1', 0, 'Get job alerts by email'],
      ['f2', 'f1', 1, 'First Name'],
      ['f3', 'f2', 1, 'Email'],
    ],
  );
  assert.deepEqual(
    map.actions.map((a) => [a.ref, a.local, a.frame]),
    [['b1', 'b1', 1]],
  );
  assert.equal(map.iframes[0].child, 1);
  assert.equal(map.iframes[1].child, undefined);
  // The outline's refs are the page's.
  assert.deepEqual(map.frames[1].outline.slice(1), [
    { t: 'field', ref: 'f2' },
    { t: 'field', ref: 'f3' },
    { t: 'action', ref: 'b1' },
  ]);
  // The caret is in the embedded form's email box; the page is the top frame's; the ATS is the frame's host's.
  assert.equal(map.focus, 'f3');
  assert.equal(map.url, 'https://careers.acme.test/jobs/42');
  assert.equal(map.platform, 'greenhouse');
  assert.deepEqual(map.alerts, [{ text: 'Please complete all required fields.', frame: 1 }]);
  assert.deepEqual(map.widgets, { 'react-select': 2 });
  assert.equal(map.counts.fields, 3);
  assert.equal(map.counts.required, 1);
  assert.equal(map.counts.frames, 4);
  assert.deepEqual(labels(map, 1), { f1: 'f2', f2: 'f3', b1: 'b1' });
});

test('merge: two frames at one address go to the iframe of their size', () => {
  const top = {
    frameId: 0,
    isTop: true,
    url: 'https://a.test/',
    outline: [
      { t: 'frame', ref: 'i1' },
      { t: 'frame', ref: 'i2' },
    ],
    iframes: [
      { ref: 'i1', src: 'https://b.test/form', rect: { x: 0, y: 0, w: 300, h: 200 } },
      { ref: 'i2', src: 'https://b.test/form', rect: { x: 0, y: 300, w: 800, h: 900 } },
    ],
  };
  const big = { frameId: 5, url: 'https://b.test/form', viewport: { width: 800, height: 900 }, outline: [] };
  const small = { frameId: 6, url: 'https://b.test/form', viewport: { width: 300, height: 200 }, outline: [] };
  const map = merge([top, big, small]);
  assert.deepEqual(
    map.frames.map((f) => [f.frameId, f.parent && f.parent.ref]),
    [
      [0, null],
      [6, 'i1'],
      [5, 'i2'],
    ],
  );
});

test('render: the page, its frames in place, and what was left out', () => {
  const text = render(merge(frames()));
  assert.equal(
    text,
    [
      'PAGE "Engineer – Acme" https://careers.acme.test/jobs/42  lang=en  platform=greenhouse  widgets=react-select×2',
      'FIELDS 3 (1 required, 0 filled, 0 invalid)  ACTIONS 1  FRAMES 4  FOCUS f3',
      'ALERT "Please complete all required fields." (frame 1)',
      '# Engineer',
      '"Join the engine team."',
      '[form "Job alerts"]',
      '  f1 email "Get job alerts by email" empty → (none)',
      `i1 frame ${FRAME_URL} → FRAME 1`,
      'i2 frame https://ads.example/slot (not mapped)',
      `FRAME 1 ${FRAME_URL} (under i1) "Job application"`,
      '  ## Personal information',
      '  f2 text* "First Name" empty → name.first ✓',
      '  f3 email "Email" empty → email ✓',
      '  b1 submit "Submit application" (submit)',
      'FRAME 3 https://tracker.example/pixel (not placed)',
      '  "Advert"',
      '… 1 empty frame not shown',
    ].join('\n'),
  );
});

test('render: the same map gives the same text, however the frames came in', () => {
  const list = frames();
  const once = render(merge(list));
  assert.equal(render(merge(list)), once);
  assert.equal(render(JSON.parse(JSON.stringify(merge(list)))), once);
  assert.equal(render(merge(list.slice().reverse())), once);
  assert.equal(render(merge([list[2], list[0], list[3], list[1]])), once);
});

/** A long page: navigation, a job description far from the form, help near it, a country list, ten fields. */
function longPage() {
  const description = Array.from({ length: 30 }, (_, i) => ({
    t: 'text',
    text: `Paragraph ${i + 1} of the job description, about the team and what you will do there each day.`,
  }));
  const countries = Array.from({ length: 200 }, (_, i) => ({ text: `Country ${i + 1}` }));
  const fields = Array.from({ length: 10 }, (_, i) =>
    field(`f${i + 1}`, i === 3 ? { kind: 'select', options: countries, optionCount: 200 } : {}),
  );
  const form = [];
  fields.forEach((f, i) => {
    form.push({ t: 'text', text: `Hint for question ${i + 1}.` });
    form.push({ t: 'field', ref: f.ref });
  });
  form.push({ t: 'action', ref: 'b1' }, { t: 'action', ref: 'b2' });
  return {
    frameId: 0,
    isTop: true,
    url: 'https://careers.acme.test/apply',
    title: 'Apply',
    outline: [
      {
        t: 'landmark',
        role: 'nav',
        name: 'Main',
        links: 14,
        sample: ['Jobs', 'Teams', 'Students', 'About us', 'Blog', 'Contact', 'Locations', 'Benefits'],
      },
      { t: 'landmark', role: 'main', children: [{ t: 'h', level: 1, text: 'Engineer' }, ...description] },
      { t: 'h', level: 2, text: 'Your application' },
      { t: 'landmark', role: 'form', children: form },
    ],
    fields,
    actions: [
      { ref: 'b1', text: 'Back', type: 'button', intent: 'back' },
      { ref: 'b2', text: 'Next', type: 'submit', intent: 'next' },
    ],
    iframes: [],
  };
}

const lines = (text) => text.split('\n');
const has = (text, s) => text.includes(s);
const fieldAndActionLines = (text) => lines(text).filter((l) => /^\s*[fb]\d+ /.test(l));

test('render: over budget, page text farthest from the form goes first', () => {
  const map = merge([longPage()]);
  const whole = render(map, { maxChars: 1e6 });
  assert.ok(!/elided|cut short|left out/.test(whole), 'nothing left out');
  assert.ok(has(whole, 'Paragraph 1 of the job description') && has(whole, '(200 options: Country 1 | Country 2'));

  const a = render(map, { maxChars: whole.length - 500 });
  assert.ok(a.length <= whole.length - 500);
  // The description's first paragraphs are farthest from any field: they go; the hints beside fields stay.
  assert.ok(!has(a, 'Paragraph 1 of'));
  assert.ok(has(a, 'Paragraph 30 of'), 'the paragraph nearest the form stays longest');
  assert.ok(has(a, '"Hint for question 1."') && has(a, '"Hint for question 10."'));
  assert.ok(has(a, 'Country 40'), 'option lists are only cut once the text is gone');
  assert.match(lines(a).pop(), /^… \d[\d,]* chars of page text elided \(\d+ blocks\)$/);

  // Then the long option list is cut short; then the navigation's links.
  const textChars = lines(whole)
    .filter((l) => /^\s*"/.test(l))
    .reduce((n, l) => n + l.length + 1, 0);
  const b = render(map, { maxChars: whole.length - textChars - 200 });
  assert.ok(!has(b, 'Paragraph') && !has(b, 'Hint for'));
  assert.ok(has(b, '(200 options: Country 1 | Country 2') && !has(b, 'Country 13 '));
  assert.ok(has(b, '[nav "Main"] 14 links: Jobs · Teams'));
  assert.match(lines(b).pop(), /1 option list cut short/);

  const c = render(map, { maxChars: 200 });
  assert.ok(has(c, '[nav "Main"] 14 links') && !has(c, 'Jobs · Teams'));
  assert.match(lines(c).pop(), /1 link list left out/);
  assert.match(lines(c).pop(), /headings? elided/);
  // Never a field or a button.
  assert.deepEqual(
    fieldAndActionLines(c).map((l) => l.trim().split(' ')[0]),
    ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'b1', 'b2'],
  );
  assert.deepEqual(fieldAndActionLines(c), fieldAndActionLines(b));
});

test('render: what fields hold, and what they never show', () => {
  const top = {
    frameId: 0,
    isTop: true,
    url: 'https://a.test/',
    values: 'state',
    outline: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7'].map((ref) => ({ t: 'field', ref })),
    fields: [
      field('f1', {
        question: 'Full name',
        hasValue: true,
        value: 'Ada Lovelace',
        rules: { type: 'name.full', status: 'ok' },
      }),
      field('f2', {
        kind: 'password',
        inputType: 'password',
        question: 'Password',
        hasValue: true,
        value: 'Engine&1843!',
      }),
      field('f3', {
        kind: 'radio',
        question: 'Are you authorized to work in the UK?',
        options: [{ text: 'Yes', chosen: true }, { text: 'No' }],
        chosen: ['Yes'],
        hasValue: true,
        invalid: true,
        error: 'This field is required',
      }),
      field('f4', {
        kind: 'select',
        question: 'Gender',
        options: [{ text: 'Please select', placeholder: true }, { text: 'Female' }, { text: 'Male' }],
        optionCount: 3,
        hasValue: true,
        withheld: true,
        rules: { type: 'eeo.gender', status: 'ok' },
      }),
      field('f5', {
        kind: 'checkbox',
        question: 'I agree to the terms',
        checked: true,
        rules: { type: 'consent', status: 'consent' },
      }),
      field('f6', {
        kind: 'file',
        inputType: 'file',
        question: 'Resume',
        hasValue: true,
        value: 'Ada_Lovelace_CV.pdf',
      }),
      field('f7', {
        kind: 'textarea',
        question: 'Why us?',
        help: 'Tell us in 250 words or fewer',
        maxLength: 1500,
        forAi: true,
        fill: { status: 'filled' },
        aiFilled: true,
        hasValue: true,
        value: 'Because of the engines.',
      }),
    ],
  };
  const state = render(top);
  assert.deepEqual(lines(state).slice(2), [
    'f1 text "Full name" filled → name.full ✓',
    'f2 password "Password" filled → (none)',
    'f3 radio "Are you authorized to work in the UK?" [Yes | No] chosen "Yes" → (none) INVALID "This field is required"',
    'f4 select "Gender" [Female | Male] filled (answer withheld) → eeo.gender ✓',
    'f5 checkbox "I agree to the terms" ticked → consent (left for you)',
    'f6 file "Resume" file attached → (none)',
    'f7 textarea "Why us?" help "Tell us in 250 words or fewer" max=1500 filled → (none: for AI) (AI answer) fill=filled',
  ]);
  for (const values of ['state', 'redacted']) {
    const text = render(Object.assign({}, top, { values }));
    assert.ok(!/Ada|Lovelace|Engine|engines/.test(text), values);
  }
  // values: 'full' shows what is typed, but never a password or a file's name.
  const full = render(Object.assign({}, top, { values: 'full' }));
  assert.ok(has(full, 'f1 text "Full name" = "Ada Lovelace"'));
  assert.ok(
    has(full, 'f7 textarea "Why us?" help "Tell us in 250 words or fewer" max=1500 = "Because of the engines."'),
  );
  assert.ok(!/Engine&|Lovelace_CV/.test(full));
});

test('intentOf: what a button does, from its words', () => {
  const cases = [
    ['Submit application', 'submit'],
    ['Send', 'submit'],
    ['Next', 'next'],
    ['Save and Continue', 'next'],
    ['Continue', 'next'],
    ['Back', 'back'],
    ['Previous step', 'back'],
    ['Apply now', 'apply'],
    ['Apply for this job', 'apply'],
    ['Save draft', 'save'],
    ['Save', 'save'],
    ['Add another', 'add'],
    ['+ Add', 'add'],
    ['Remove', 'remove'],
    ['Delete file', 'remove'],
    ['Upload resume', 'upload'],
    ['Attach', 'upload'],
    ['Sign in', 'signin'],
    ['Already have an account? Sign in', 'signin'],
    ['Create account', 'signup'],
    ['Accept all cookies', 'accept-cookies'],
    ['Close', 'close'],
    ['×', 'close'],
    ['No thanks', 'close'],
    ['Learn more', 'other'],
    ['', 'other'],
  ];
  for (const [text, want] of cases) assert.equal(intentOf(text), want, text);
  // Inside a cookie banner, "Accept" and "Allow all" take the cookies.
  assert.equal(intentOf('Accept', { cookie: true }), 'accept-cookies');
  assert.equal(intentOf('Allow all', { cookie: true }), 'accept-cookies');
  assert.equal(intentOf('Accept', {}), 'other');
  assert.equal(intentOf('Reject all', { cookie: true }), 'reject-cookies');
  assert.equal(intentOf('Necessary cookies only'), 'reject-cookies');
  assert.equal(intentOf('Reject all', {}), 'other');
});
