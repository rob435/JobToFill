// "Save a snapshot for a bug report": the redaction (lib/redact.js) and the sanitized copy of a page
// (content/snapshot.js), on pages parsed by linkedom.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
const { load, desc } = require('./helpers');

const JTF = load();
require('../../extension/lib/redact.js');
require('../../extension/content/snapshot.js');
const { redactor } = JTF.redact;

const PROFILE = {
  personal: { firstName: 'Ada', lastName: 'Lovelace', preferredName: '', dob: '1990-12-10' },
  contact: { email: 'ada@example.com', phone: '415 555 0100', phoneCountryCode: '+1' },
  address: {
    line1: '1 Market St',
    line2: 'Apt 5',
    city: 'San Francisco',
    postalCode: '94105',
    country: 'United States',
  },
  links: {
    linkedin: 'https://www.linkedin.com/in/ada-lovelace',
    github: 'https://github.com/adal',
    website: 'https://ada.dev',
  },
  experience: [{ company: 'Analytical Engines Inc', description: 'Led the team that built the analytical engine.' }],
  education: [{ school: 'University of Cambridge', degree: 'Bachelor of Science' }],
  coverLetter: 'Dear hiring team,\nI would love to join your summer analyst programme in London.',
  customAnswers: [{ question: 'why', answer: 'Because the work is close to what I studied.' }],
};
const FILES = [{ which: 'resume', name: 'Ada_Lovelace_CV.pdf' }];
const r = redactor(PROFILE, { files: FILES });

/* ------------------------------------------------------------- redaction */

test('names in any case, as whole words only', () => {
  assert.equal(r.text('Welcome back, Ada Lovelace'), 'Welcome back, [first name] [last name]');
  assert.equal(
    r.text('ADA LOVELACE / ada lovelace / LoveLace'),
    '[first name] [last name] / [first name] [last name] / [last name]',
  );
  assert.equal(r.text("Lovelace's application"), "[last name]'s application");
  assert.equal(r.text('Ada-Lovelace and ada_lovelace'), '[first name]-[last name] and [first name]_[last name]');
  // Not inside other words: country lists and job ads keep their text.
  assert.equal(r.text('Canada, Adaptive, Nevada, Lovelaces'), 'Canada, Adaptive, Nevada, Lovelaces');
});

test('names with accents, apostrophes and several parts', () => {
  const x = redactor({ personal: { firstName: 'José', lastName: "O'Brien-Smith" } });
  assert.equal(x.text('JOSE O’BRIEN-SMITH'), '[first name] [last name]');
  assert.equal(x.text('José OBrien Smith'), '[first name] [last name]');
  assert.equal(x.text('Dear Mr Smith'), 'Dear Mr [last name]');
  const y = redactor({ personal: { lastName: 'van der Berg' } });
  assert.equal(y.text('Van der Berg, Berg; the van and der stay'), '[last name], [last name]; the van and der stay');
});

test('phone numbers in every format pages write them', () => {
  for (const s of [
    '415 555 0100',
    '(415) 555-0100',
    '415.555.0100',
    '4155550100',
    '+1 415-555-0100',
    '+14155550100',
    '001 415 555 0100',
    '1-415-555-0100',
  ])
    assert.equal(r.text(`Call ${s} today`), 'Call [phone] today', s);
  // A longer number that merely contains it is not the phone.
  assert.equal(r.text('Ref 9941555501009'), 'Ref 9941555501009');
  const uk = redactor({ contact: { phone: '07700 900123', phoneCountryCode: '+44' } });
  for (const s of [
    '07700 900123',
    '+44 7700 900123',
    '+44 (0)7700 900 123',
    '0044 7700-900-123',
    '447700900123',
    '7700900123',
  ])
    assert.equal(uk.text(`Tel: ${s}.`), 'Tel: [phone].', s);
  const stored = redactor({ contact: { phone: '+44 7700 900123' } });
  assert.equal(stored.text('07700 900123'), '[phone]', 'the national form of a number kept with its country code');
});

test('email, address, postcode, date of birth, links, files, employers and written answers', () => {
  assert.equal(r.text('Signed in as ADA@Example.com'), 'Signed in as [email]');
  assert.equal(r.text('mailto:ada%40example.com'), 'mailto:[email]');
  assert.equal(
    r.text('1 market  st., Apt 5, San Francisco 94105'),
    '[address], [address line 2], San Francisco [postcode]',
  );
  for (const s of [
    '1990-12-10',
    '10/12/1990',
    '12/10/1990',
    '10.12.1990',
    '10 December 1990',
    'December 10, 1990',
    'Dec 10th 1990',
  ])
    assert.equal(r.text(`Born ${s}`), 'Born [date of birth]', s);
  assert.equal(r.text('linkedin.com/in/ada-lovelace'), '[linkedin]');
  assert.equal(r.text('https://www.linkedin.com/in/ada-lovelace/'), '[linkedin]');
  assert.equal(r.text('GitHub: adal, site ada.dev'), 'GitHub: [github], site [website]');
  assert.equal(r.text('Ada_Lovelace_CV.pdf uploaded'), '[resume file] uploaded');
  assert.equal(r.text('Ada Lovelace CV.pdf'), '[resume file]');
  assert.equal(r.text('Analytical Engines Inc; Analytical Engines'), '[employer]; [employer]');
  assert.equal(r.text('I would love to join your summer analyst programme in London.'), '[your text]');
  // What a form lists as options stays.
  assert.equal(
    r.text('San Francisco, United States, University of Cambridge, Bachelor of Science'),
    'San Francisco, United States, University of Cambridge, Bachelor of Science',
  );
});

test('identifiers and CSS: a name only as a whole token, placeholders without spaces', () => {
  const max = redactor({ personal: { firstName: 'Max', lastName: 'Grid' } });
  assert.equal(max.ident('max-width: 10px; .max-w-lg; text-grid'), 'max-width: 10px; .max-w-lg; text-grid');
  assert.equal(max.ident('#max .grid'), '#redacted-first-name .redacted-last-name');
  assert.equal(max.text('Max Grid'), '[first name] [last name]');
  // The pass over serialized HTML leaves names (and so tags like <mark>) alone, and takes the rest.
  const mark = redactor({ personal: { firstName: 'Mark' }, contact: { email: 'mark@example.com' } });
  assert.equal(mark.strict('<mark class="x">mark@example.com</mark>'), '<mark class="x">[email]</mark>');
  // Saved logins: the password matched exactly, also as HTML escapes it.
  const secret = redactor({}, { secrets: ['p&ss<word>1'], usernames: ['adal_99'] });
  assert.equal(secret.strict('a p&amp;ss&lt;word&gt;1 b p&ss<word>1 adal_99'), 'a [password] b [password] [username]');
});

test('an empty profile redacts nothing', () => {
  const none = redactor({}, {});
  assert.equal(none.text('Ada Lovelace 415 555 0100'), 'Ada Lovelace 415 555 0100');
});

/* -------------------------------------------------------------- the copy */

const PAGE = `<!doctype html><html lang="en"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="csrf-token" content="tok123">
  <title>Ada Lovelace – Application</title>
  <base href="https://evil.example/">
  <link rel="stylesheet" href="/assets/app.css?v=3"><link rel="preload" as="script" href="/app.js"><link rel="icon" href="/f.ico">
  <style>.a{background:url("data:image/png;base64,AAAA")} .b{background:url(/img/b.png)} .w{color:white;display:grid}</style>
  <script>window.secret = 1</script>
</head><body onload="steal()">
  <noscript><img src="https://tracker.example/p.gif"></noscript>
  <!-- candidate: ada@example.com -->
  <div id="review" title="Signed in as ADA@EXAMPLE.COM" data-user="Ada Lovelace">Welcome back, Ada! Call (415) 555-0100.</div>
  <div id="app" data-props='{"candidate":{"id":"c-77","city":"Leeds","token":"s3ss10n"},"step":2}' data-step="2"></div>
  <a id="li" href="https://www.linkedin.com/in/ada-lovelace?trk=abc#top" onclick="x()">LinkedIn</a>
  <a id="js" href=" java&#9;script:alert(1)">bad</a>
  <a id="frag" href="#section">jump</a>
  <a id="token" href="/apply/continue/8f3a9c2b1d4e5f60a7b8c9d0?email=ada%40example.com">continue</a>
  <img id="photo" src="https://cdn.example/ada.jpg" srcset="a.jpg 1x" alt="Photo of Ada">
  <img id="inline" src="data:image/png;base64,AAAA" alt="logo">
  <iframe id="frame" src="https://forms.example/embed?token=abc" srcdoc="<script>alert(1)</script>"></iframe>
  <object data="movie.swf"></object>
  <svg viewBox="0 0 10 10"><use href="icons.svg#check"></use><a href="javascript:alert(1)"><text>x</text></a><script>alert(1)</script></svg>
  <form action="/submit?session=abc">
    <input type="hidden" name="authenticity_token" value="tok123">
    <label for="first">First name *</label><input id="first" name="first" value="Ada" placeholder="e.g. Ada">
    <input id="email" type="email" value="ada@example.com">
    <input id="pw" type="password" value="hunter2">
    <input id="empty" type="text">
    <textarea id="why">Because the work is close to what I studied.</textarea>
    <div id="editor" contenteditable="true"><p>Dear hiring team, I am Ada.</p></div>
    <input id="agree" type="checkbox" value="yes">
    <input id="news" type="checkbox" value="yes" checked>
    <fieldset><legend>Authorised to work?</legend>
      <input type="radio" name="auth" id="auth-yes" value="Yes"><label for="auth-yes">Yes</label>
      <input type="radio" name="auth" id="auth-no" value="No" checked><label for="auth-no">No</label>
    </fieldset>
    <select id="country"><option value="">Select…</option><option>Italy</option><option>United Kingdom</option><option selected>United States</option></select>
    <div class="field"><label for="gender">Gender</label>
      <select id="gender"><option value="">Please select</option><option>Male</option><option>Female</option></select></div>
    <fieldset id="pronouns"><legend>Pronouns</legend>
      <label class="opt css-9xq1 opt--checked"><input type="radio" name="pro" id="p1" value="she"><span class="dot" style="transform: scale(1)"><svg viewBox="0 0 2 2"><circle r="1"></circle></svg></span>She/her</label>
      <label class="opt css-2bc7"><input type="radio" name="pro" id="p2" value="he"><span class="dot" style="transform: scale(0)"></span>He/him</label></fieldset>
    <div class="field"><label id="eth-label">Ethnicity</label>
      <div class="rs"><div class="rs__control"><div class="rs__single-value">White British</div>
        <div class="rs__input"><input id="eth" role="combobox" aria-labelledby="eth-label" aria-controls="eth-menu" class="rs__input-is-active"></div></div></div>
      <div id="eth-menu" role="listbox"><div role="option" aria-selected="true" class="rs__option rs__option--is-selected" data-state="checked">White British</div><div role="option" aria-selected="false" class="rs__option">Asian</div></div>
    </div>
    <div class="field"><label for="dis">Disability</label>
      <select id="dis" class="hidden-accessible"><option value="">Choose</option><option value="y">Yes</option><option value="n">No</option></select>
      <span class="select2"><span class="select2-selection__rendered" title="No">No</span></span></div>
    <button type="submit" formaction="/go?x=1">Submit application</button>
  </form>
</body></html>`;

function page() {
  const { document } = parseHTML(PAGE);
  // Rules a script wrote into the page (as text, so the parser never saw them): a "<" can't close the sheet early.
  document.querySelector('style').textContent +=
    ' .c::after{content:"</style><img src=x onerror=alert(1)>"} .n::after{content:"Hi Ada"}';
  // What the person did after the page loaded: live state, not attributes.
  document.getElementById('agree').checked = true;
  document.getElementById('news').checked = false;
  document.getElementById('auth-yes').checked = true;
  document.getElementById('auth-no').checked = false;
  document.getElementById('country').options[2].selected = true;
  document.getElementById('gender').options[2].selected = true;
  document.getElementById('p1').checked = true;
  document.getElementById('dis').options[2].selected = true;
  return document;
}

/** The scan content/dom.js would make, with the classification lib/matcher.js would give, for the private questions. */
function scanOf(document) {
  const one = (id, kind, label) => {
    const el = document.getElementById(id);
    return { el, kind, members: [el], desc: desc({ label }, { kind }) };
  };
  const radios = ['p1', 'p2'].map((id) => document.getElementById(id));
  const fields = [
    one('gender', 'select', 'Gender'),
    { el: radios[0], kind: 'radio', members: radios, desc: desc({ question: 'Pronouns' }, { kind: 'radio' }) },
    one('eth', 'combobox', 'Ethnicity'),
    one('dis', 'select', 'Disability'),
    one('country', 'select', 'Country'),
  ];
  const results = [
    { type: 'eeo.gender' },
    { type: 'pronouns' },
    { type: 'eeo.race' },
    { type: 'eeo.disability' },
    { type: 'address.country' },
  ];
  return { fields, results };
}

function copyOf(document, withScan = true) {
  const html = JTF.snapshot.serialize(document, {
    profile: PROFILE,
    files: FILES,
    url: 'https://jobs.example/apply/8f3a9c2b1d4e5f60a7b8c9d0e1?ref=ada@example.com#x',
    ...(withScan ? scanOf(document) : {}),
  });
  return { html, doc: parseHTML(`<!doctype html>${html}`).document };
}

test('the copy has no scripts, handlers, script URLs, inline data, plugins or tracking', () => {
  const { html, doc } = copyOf(page());
  assert.equal(doc.querySelectorAll('script, noscript, object, embed').length, 0);
  assert.doesNotMatch(html, /<script/i);
  const handlers = [...doc.querySelectorAll('*')].flatMap((el) =>
    [...el.attributes].filter((a) => /^on/i.test(a.name)),
  );
  assert.deepEqual(handlers, [], 'no inline handlers');
  assert.doesNotMatch(html, /javascript:/i);
  assert.doesNotMatch(html, /data:image|blob:/i);
  assert.equal(doc.getElementById('js').hasAttribute('href'), false);
  assert.equal(doc.querySelector('svg a').hasAttribute('href'), false);
  assert.equal(doc.getElementById('frame').hasAttribute('srcdoc'), false);
  assert.equal(doc.getElementById('frame').hasAttribute('src'), false);
  assert.equal(doc.getElementById('frame').getAttribute('data-frame-url'), 'https://forms.example/embed');
  assert.equal(doc.getElementById('photo').hasAttribute('src'), false);
  assert.equal(doc.getElementById('photo').hasAttribute('srcset'), false);
  assert.equal(doc.getElementById('photo').getAttribute('alt'), 'Photo of [first name]', 'alt text kept, redacted');
  assert.equal(doc.getElementById('inline').hasAttribute('src'), false);
  assert.doesNotMatch(html, /<!--/, 'comments left out');
  assert.doesNotMatch(html, /tok123/, 'hidden tokens and meta tags left out');
  assert.doesNotMatch(html, /evil\.example/, 'the page’s own <base> replaced');
  // A "<" in a style sheet can't close it early.
  assert.equal(doc.querySelectorAll('img').length, 2);
  assert.match(html, /\\3c \/style>\\3c img/);
});

test('the copy keeps style sheets and points at the page so they load, and strips queries and tokens from links', () => {
  const { html, doc } = copyOf(page());
  const head = html.slice(0, html.indexOf('</head>'));
  assert.match(
    head,
    /^<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="script-src 'none';/,
  );
  assert.equal(doc.querySelector('base').getAttribute('href'), 'https://jobs.example/apply/[id]');
  assert.deepEqual(
    [...doc.querySelectorAll('link')].map((l) => l.getAttribute('href')),
    ['/assets/app.css?v=3'],
    'style sheets only, with their version query',
  );
  assert.deepEqual(
    [...doc.querySelectorAll('meta')].map(
      (m) => m.getAttribute('name') || m.getAttribute('charset') || m.getAttribute('http-equiv'),
    ),
    ['utf-8', 'Content-Security-Policy', 'viewport'],
  );
  const css = doc.querySelector('style').textContent;
  assert.match(css, /\.b\{background:url\(\/img\/b\.png\)\}/);
  assert.match(css, /\.w\{color:white;display:grid\}/, 'CSS keywords are not names');
  assert.match(css, /content:"Hi redacted-first-name"/, 'names in CSS text are');
  assert.equal(doc.getElementById('li').getAttribute('href'), '[linkedin]');
  assert.equal(doc.getElementById('frag').getAttribute('href'), '#section');
  assert.equal(doc.getElementById('token').getAttribute('href'), '/apply/continue/[id]');
  assert.equal(doc.querySelector('form').getAttribute('action'), '/submit');
  assert.equal(doc.querySelector('button').getAttribute('formaction'), '/go');
  assert.equal(doc.querySelector('use').getAttribute('href'), 'icons.svg#check', 'SVG sprites keep their fragment');
});

test('personal details are redacted in text and in every attribute', () => {
  const { html, doc } = copyOf(page());
  assert.equal(doc.querySelector('title').textContent, '[first name] [last name] – Application');
  assert.equal(doc.getElementById('review').textContent, 'Welcome back, [first name]! Call [phone].');
  assert.equal(doc.getElementById('review').getAttribute('title'), 'Signed in as [email]');
  assert.equal(doc.getElementById('review').getAttribute('data-user'), '[first name] [last name]');
  // State a server rendered into the page goes whole (it holds what no profile lists: ids, tokens).
  assert.equal(doc.getElementById('app').hasAttribute('data-props'), false);
  assert.equal(doc.getElementById('app').getAttribute('data-step'), '2');
  assert.equal(doc.getElementById('first').getAttribute('placeholder'), 'e.g. [first name]');
  assert.doesNotMatch(html, /\bada\b|lovelace|example\.com|555/i);
});

test('typed values are cleared; what is ticked and picked stays, from the live state', () => {
  const { doc } = copyOf(page());
  for (const id of ['first', 'email', 'pw']) {
    const el = doc.getElementById(id);
    assert.equal(el.hasAttribute('value'), false, id);
    assert.equal(el.hasAttribute('data-jtf-had-value'), true, id);
  }
  assert.equal(doc.getElementById('empty').hasAttribute('data-jtf-had-value'), false);
  assert.equal(doc.querySelector('input[type=hidden]').hasAttribute('value'), false);
  assert.equal(doc.getElementById('why').textContent, '');
  assert.equal(doc.getElementById('why').hasAttribute('data-jtf-had-value'), true);
  assert.equal(doc.getElementById('editor').innerHTML, '', 'a rich-text editor is emptied');
  assert.equal(doc.getElementById('agree').hasAttribute('checked'), true, 'ticked after the page loaded');
  assert.equal(doc.getElementById('news').hasAttribute('checked'), false, 'unticked after the page loaded');
  assert.equal(doc.getElementById('agree').getAttribute('value'), 'yes', "a checkbox's value is the page's");
  assert.equal(doc.getElementById('auth-yes').hasAttribute('checked'), true);
  assert.equal(doc.getElementById('auth-no').hasAttribute('checked'), false);
  assert.deepEqual(
    [...doc.querySelectorAll('#country option[selected]')].map((o) => o.textContent),
    ['United Kingdom'],
  );
  // Option texts and labels are the fixture: they stay.
  assert.equal(doc.querySelector('label[for=auth-no]').textContent, 'No');
  assert.equal(doc.querySelector('button').textContent, 'Submit application');
});

test('equal-opportunity answers: which option is picked is left out, the options stay', () => {
  const { doc } = copyOf(page());
  assert.equal(doc.querySelectorAll('#gender option[selected]').length, 0);
  assert.deepEqual(
    [...doc.querySelectorAll('#gender option')].map((o) => o.textContent),
    ['Please select', 'Male', 'Female'],
  );
  assert.equal(doc.querySelectorAll('#pronouns input[checked]').length, 0);
  // Nothing tells the picked radio apart: no classes, styles or indicator; the options' text stays.
  assert.equal(
    doc.getElementById('pronouns').innerHTML.replace(/\s+/g, ' '),
    '<legend>Pronouns</legend> <label><input type="radio" name="pro" id="p1" value="she">She/her</label> <label><input type="radio" name="pro" id="p2" value="he">He/him</label>',
  );
  // A custom dropdown's shown answer goes (once in the menu, no longer beside the input), and the open menu no
  // longer marks it.
  const eth = doc.querySelector('#eth-label').parentElement;
  assert.equal(eth.textContent.match(/White British/g).length, 1);
  assert.equal(doc.querySelector('#eth-label').textContent, 'Ethnicity');
  const picked = doc.querySelector('#eth-menu [role=option]');
  assert.equal(picked.getAttribute('aria-selected'), 'false');
  assert.equal(picked.hasAttribute('data-state'), false);
  assert.equal(picked.hasAttribute('class'), false);
  assert.equal(doc.getElementById('eth').hasAttribute('class'), false, 'classes go');
  assert.equal(doc.getElementById('eth').getAttribute('role'), 'combobox', 'roles stay');
  assert.equal(
    doc.querySelector('#eth-menu [role=option]').textContent,
    'White British',
    'the options themselves stay',
  );
  // select2-style: the rendered choice beside the hidden <select>.
  const dis = doc.querySelector('label[for=dis]').parentElement;
  assert.deepEqual(
    [...dis.querySelectorAll('span')].map((x) => [x.textContent, x.hasAttribute('title')]),
    [
      ['', false],
      ['', false],
    ],
  );
  assert.equal(doc.querySelectorAll('#dis option[selected]').length, 0);
  assert.deepEqual(
    [...doc.querySelectorAll('#dis option')].map((o) => o.textContent),
    ['Choose', 'Yes', 'No'],
  );
  assert.equal(doc.querySelector('label[for=dis]').textContent, 'Disability');
  // Without a scan nothing is withheld (and the country stays picked either way).
  const plain = copyOf(page(), false).doc;
  assert.equal(plain.querySelector('#gender option[selected]').textContent, 'Female');
  assert.equal(plain.querySelector('#country option[selected]').textContent, 'United Kingdom');
});

test('paths name where a field is', () => {
  const { document } = parseHTML(
    '<html><body><form id="f"><div><input></div><div><span></span><input></div></form></body></html>',
  );
  const inputs = document.querySelectorAll('input');
  assert.equal(JTF.snapshot.pathOf(inputs[1]), 'form#f > div:nth-of-type(2) > input');
  assert.equal(JTF.snapshot.cleanUrl('https://a.example/x/y?email=ada@example.com#frag'), 'https://a.example/x/y');
});

/* ------------------------------------------------------------- the trace */

test('the fill trace notes each step of a fill, capped, never a value', () => {
  const { document } = parseHTML('<html><body><label for="a">First name</label><input id="a"></body></html>');
  const el = document.getElementById('a');
  const field = { el, kind: 'text', members: [el], desc: desc('First name') };
  const before = JTF.snapshot.trace.length;
  JTF.snapshot.note(field, { step: 'fill', type: 'name.first', valueKind: 'text', status: 'filled', ms: 3 });
  JTF.snapshot.note(field, { step: 'read back', status: 'check', reason: 'Please enter a valid name' });
  const added = JTF.snapshot.trace.slice(before);
  assert.deepEqual(
    added.map((t) => [t.question, t.kind, t.step, t.type || null, t.status, t.reason || null, t.path]),
    [
      ['First name', 'text', 'fill', 'name.first', 'filled', null, 'input#a'],
      ['First name', 'text', 'read back', null, 'check', 'Please enter a valid name', 'input#a'],
    ],
  );
  // A field it can't describe never stops a fill.
  JTF.snapshot.note({ el: null, kind: 'text', desc: null }, { step: 'fill' });

  // Capped: the newest entries stay.
  for (let i = 0; i < 320; i++) JTF.snapshot.note(field, { step: 'fill', status: 'filled' });
  assert.equal(JTF.snapshot.trace.length, 300);
});
