// End-to-end: the real extension filling realistic application pages, in Chromium or Firefox.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PROFILE, RESUME_PDF, checked, frameWith, launch, selectedText, text, typeInto, value } from './harness.mjs';

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

const fileName = (page, selector) => page.$eval(selector, (input) => (input.files[0] ? input.files[0].name : ''));

test('Greenhouse-style form: text, files, selects, EEO, education dates, custom answer', async () => {
  const page = await h.open('greenhouse.html');
  const r = await h.fill(page);
  assert.equal(r.error, undefined);
  assert.equal(await value(page, '#first_name'), 'Ada');
  assert.equal(await value(page, '#last_name'), 'Lovelace');
  assert.equal(await value(page, '#email'), 'ada@example.com');
  assert.equal(await value(page, '#phone'), '+1 415 555 0100');
  assert.equal(await value(page, '#job_application_location'), 'San Francisco, CA');
  assert.equal(await fileName(page, '#resume'), 'Ada_Lovelace_CV.pdf');
  assert.equal(await fileName(page, '#cover_letter'), '', 'no cover letter file in the profile');
  assert.equal(await value(page, '#q_linkedin'), 'https://www.linkedin.com/in/ada');
  assert.equal(await value(page, '#q_website'), 'https://ada.dev');
  assert.equal(await selectedText(page, '#q_source'), 'LinkedIn');
  assert.equal(await selectedText(page, '#q_auth'), 'Yes');
  assert.equal(await selectedText(page, '#q_sponsor'), 'No');
  assert.equal(await value(page, '#q_why'), 'I love engines.');
  assert.equal(await value(page, '#school'), 'University of Cambridge');
  assert.equal(await selectedText(page, '#degree'), "Bachelor's Degree");
  assert.equal(await selectedText(page, '#discipline'), 'Mathematics');
  assert.equal(await value(page, '#edu_start_month'), '09');
  assert.equal(await value(page, '#edu_start_year'), '2012');
  assert.equal(await value(page, '#edu_end_month'), '06');
  assert.equal(await value(page, '#edu_end_year'), '2016');
  assert.equal(await selectedText(page, '#gender'), 'Female');
  assert.equal(await selectedText(page, '#hispanic'), 'No');
  assert.equal(await selectedText(page, '#veteran'), 'I am not a protected veteran');
  assert.equal(await selectedText(page, '#disability'), "I don't wish to answer");
  assert.ok(r.missing.includes('Cover letter file'), JSON.stringify(r.missing));
  await page.close();
});

test('Workday-style form: listbox buttons, automation ids, two work-history entries, radio question', async () => {
  const page = await h.open('workday.html');
  const r = await h.fill(page);
  assert.equal(r.error, undefined);
  assert.equal(await text(page, '#btn-country'), 'United States of America');
  assert.equal(await value(page, '#input-1'), 'Ada');
  assert.equal(await value(page, '#input-2'), 'Lovelace');
  assert.equal(await value(page, '#input-3'), '1 Market St');
  assert.equal(await value(page, '#input-4'), 'San Francisco');
  assert.equal(await text(page, '#btn-region'), 'California');
  assert.equal(await value(page, '#input-5'), '94105');
  assert.equal(await text(page, '#btn-pdt'), 'Mobile');
  assert.equal(await value(page, '#input-7'), 'ada@example.com');
  assert.equal(await checked(page, '#prev-no'), true, 'custom answer for “previously worked for”');

  assert.equal(await value(page, '#we1-title'), 'Senior Engineer');
  assert.equal(await value(page, '#we1-company'), 'Analytical Engines Inc');
  assert.equal(await value(page, '#we1-loc'), 'San Francisco, CA');
  assert.equal(await checked(page, '#we1-current'), true);
  assert.equal(await value(page, '#we1-from-m'), '03');
  assert.equal(await value(page, '#we1-from-y'), '2020');
  assert.equal(await value(page, '#we1-to-y'), '', 'a current job has no end date');
  assert.equal(await value(page, '#we1-desc'), 'Leading the engine team.');

  assert.equal(await value(page, '#we2-title'), 'Engineer');
  assert.equal(await value(page, '#we2-company'), 'Babbage Labs');
  assert.equal(await checked(page, '#we2-current'), false);
  assert.equal(await value(page, '#we2-from-m'), '08');
  assert.equal(await value(page, '#we2-from-y'), '2016');
  assert.equal(await value(page, '#we2-to-m'), '02');
  assert.equal(await value(page, '#we2-to-y'), '2020');

  assert.equal(await value(page, '#ed1-school'), 'University of Cambridge');
  assert.equal(await text(page, '#btn-degree'), 'Bachelor of Science');
  assert.equal(await value(page, '#ed1-field'), 'Mathematics');
  assert.equal(await page.$$eval('ul[role=listbox]', (lists) => lists.length), 0, 'dropdowns are closed again');
  await page.close();
});

test('Lever-style form: div labels, url fields, radio custom question, EEO', async () => {
  const page = await h.open('lever.html');
  await h.fill(page);
  assert.equal(await value(page, 'input[name=name]'), 'Ada Lovelace');
  assert.equal(await value(page, 'input[name=email]'), 'ada@example.com');
  assert.equal(await value(page, 'input[name=org]'), 'Analytical Engines Inc');
  assert.equal(await value(page, 'input[name="urls[LinkedIn]"]'), 'https://www.linkedin.com/in/ada');
  assert.equal(await value(page, 'input[name="urls[GitHub]"]'), 'https://github.com/ada');
  assert.equal(await value(page, 'input[name="urls[Portfolio]"]'), 'https://ada.dev');
  assert.equal(await checked(page, 'input[name="cards[abc][field0]"][value=Yes]'), true);
  assert.equal(
    await value(page, 'textarea[name=comments]'),
    PROFILE.coverLetter,
    'Lever’s box says “Add a cover letter…”',
  );
  assert.equal(await selectedText(page, 'select[name="eeo[gender]"]'), 'Female');
  assert.equal(await selectedText(page, 'select[name="eeo[race]"]'), 'Decline to self-identify');
  assert.equal(await selectedText(page, 'select[name="eeo[veteran]"]'), 'I am not a veteran');
  assert.equal(await fileName(page, '#resume-upload-input'), 'Ada_Lovelace_CV.pdf');
  await page.close();
});

test('searchable dropdowns: react-select style, async search, free-text autocomplete', async () => {
  const page = await h.open('combobox.html');
  const r = await h.fill(page);
  const chip = (id) =>
    page.$eval(`#${id}`, (input) => {
      const selected = input.closest('.field').querySelector('.select__single-value');
      return selected ? selected.textContent : '';
    });
  assert.equal(await value(page, '#first_name'), 'Ada');
  assert.equal(await chip('country'), 'United States');
  assert.equal(await chip('auth'), 'Yes');
  assert.equal(await chip('school'), 'University of Cambridge');
  assert.equal(await value(page, '#location'), 'San Francisco, CA', 'kept typed text when no suggestion matched');
  assert.equal(await value(page, '#office_pref'), '', '“preferred office” is not your location');
  assert.equal(r.failed, 0, JSON.stringify(r));
  await page.close();
});

/** The replica's own React state: what the site registered, not just what the DOM shows. */
const reactState = async (page) => JSON.parse(await text(page, '#state'));

test('Greenhouse job board with real react-select: terms, multi-select, checklists, uploads, consent', async () => {
  const original = await h.profile();
  await h.setProfile({
    education: [
      {
        school: 'University of Glasgow',
        degree: 'BSc Computer Science',
        field: 'Computer Science',
        gpa: '',
        location: 'Glasgow',
        startDate: '2023-09',
        endDate: '2027-05',
      },
    ],
    job: { locations: 'London, New York', otherOffers: 'No', nonCompete: 'None' },
    links: { linkedin: 'https://www.linkedin.com/in/ada/?isSelfProfile=true' },
  });
  try {
    const page = await h.open('greenhouse-remix.html');
    await page.waitForSelector('#first_name');
    const r = await h.fill(page);
    assert.equal(r.error, undefined);
    const s = await reactState(page);
    assert.equal(s.first, 'Ada');
    assert.equal(s.email, 'ada@example.com');
    assert.equal(s.country, 'United States +1', 'the country picker in the Phone group is the dialling code');
    assert.equal(s.phone, '415 555 0100');
    assert.equal(s.location, 'San Francisco, California, United States');
    assert.equal(s.resume, 'Ada_Lovelace_CV.pdf');
    assert.equal(s.coverLetter, undefined, 'the cover letter "Attach" button does not get the resume');
    assert.equal(s.linkedin, 'https://www.linkedin.com/in/ada/');
    assert.equal(s.nonCompete, 'None. Notice period: 2 weeks');
    assert.equal(s.sponsorship, 'No');
    assert.equal(s.school, 'University of Glasgow', 'picked from 2,466 options');
    assert.deepEqual(s.degree, ['Bachelor’s']);
    assert.equal(s.graduation, 'Spring/Summer 2027');
    assert.equal(s.offers, 'No');
    assert.equal(s.offerDetails, undefined, '"If you said yes above" stays empty after a No');
    assert.deepEqual(s.relocation.sort(), ['London', 'New York']);
    assert.deepEqual(s.offices, ['London', 'New York'], 'every preferred location in a multi-select');
    assert.equal(s.source, 'Social Media (e.g., LinkedIn, Reddit, Discord, Facebook, X, Instagram)');
    assert.deepEqual(s.notice, [], 'acknowledgements are left for you by default');
    assert.equal(r.consents, 1);
    assert.deepEqual(r.unmatched, []);
    assert.ok(r.missing.includes('Cover letter file'), JSON.stringify(r.missing));
    assert.equal(await page.$$eval('#question_1007', (els) => els[0].value), '', 'no stray search text');

    // Filling again changes nothing: every widget type reports the answer it already has.
    const refill = await h.fill(page);
    assert.equal(refill.filled, 0, JSON.stringify(refill));
    assert.deepEqual(await reactState(page), s);

    // "Learn from this page" reads react-select choices, single and multi.
    const edu = (await h.profile()).education[0];
    await h.setProfile({ education: [{ ...edu, school: '', degree: '' }] });
    const { suggestions } = await h.handler('jtf:learn', page);
    const learned = Object.fromEntries(suggestions.filter((x) => x.kind === 'profile').map((x) => [x.path, x.value]));
    assert.equal(learned['education.0.school'], 'University of Glasgow');
    assert.equal(learned['education.0.degree'], 'Bachelor’s');
    await h.setProfile({ education: [edu] });

    await h.handler('jtf:undo', page);
    const undone = await reactState(page);
    assert.equal(undone.first, '');
    assert.equal(undone.school, null, 'clearable dropdowns are cleared');
    assert.deepEqual(undone.degree, []);
    assert.deepEqual(undone.relocation, []);
    await page.close();

    await h.setSettings({ consents: true });
    const again = await h.open('greenhouse-remix.html');
    await again.waitForSelector('#first_name');
    const r2 = await h.fill(again);
    assert.equal(r2.consents, 0);
    assert.equal((await reactState(again)).notice.length, 1, 'ticked once the setting is on');
    await again.close();
  } finally {
    await h.setSettings({ consents: false });
    await h.setProfile({ education: original.education, job: original.job, links: original.links });
  }
});

test('Ashby-style form: Yes/No toggle buttons, ARIA radios and checkboxes, label-titled fieldsets', async () => {
  const page = await h.open('ashby.html');
  const r = await h.fill(page);
  assert.equal(r.error, undefined);
  const s = JSON.parse(await text(page, '#state'));
  assert.equal(await value(page, '#_systemfield_name'), 'Ada Lovelace');
  assert.equal(await value(page, '#_systemfield_email'), 'ada@example.com');
  assert.equal(await value(page, '#loc'), 'San Francisco, CA', 'label points nowhere: the question text is used');
  assert.equal(await value(page, '#start'), '11/02/2026');
  assert.equal(s.auth, 'yes', 'toggle button pressed, not the hidden checkbox');
  assert.equal(s.sponsor, 'no', 'the question, not its description, decides');
  assert.equal(s.tz, 'no', 'an answer already given is left alone');
  assert.equal(s.relocate, 'yes', 'role="radio" buttons');
  assert.equal(s.adult, true, 'role="checkbox" button');
  assert.equal(s.news, undefined, 'marketing opt-in left alone');
  assert.equal(await checked(page, '#g2'), true, 'radio group titled by a <label> inside the fieldset');
  assert.equal(await checked(page, '#arb'), false, 'acknowledgements are left for you by default');
  assert.equal(r.consents, 1);
  assert.equal(await page.$$eval('.bubble:checked', (els) => els.length), 0, 'hidden bubble inputs untouched');
  await page.close();
});

test('cross-origin iframe (embedded application) is filled', async () => {
  const page = await h.open('embed.html');
  const frame = await frameWith(page, '127.0.0.1', '#first_name');
  const r = await h.fill(page);
  assert.equal(await value(frame, '#first_name'), 'Ada');
  assert.equal(await value(frame, '#email'), 'ada@example.com');
  assert.equal(await selectedText(frame, '#q_auth'), 'Yes');
  assert.ok(r.frames >= 2);
  await page.close();
});

test('shadow DOM web components are filled', async () => {
  const page = await h.open('shadow.html');
  await h.fill(page);
  const shadowValue = (name) =>
    page.$eval(
      'apply-form',
      (form, n) => {
        for (const field of form.shadowRoot.querySelectorAll('apply-field')) {
          const input = field.shadowRoot.querySelector(`input[name="${n}"]`);
          if (input) return input.value;
        }
        return null;
      },
      name,
    );
  assert.equal(await shadowValue('firstName'), 'Ada');
  assert.equal(await shadowValue('lastName'), 'Lovelace');
  assert.equal(await shadowValue('email'), 'ada@example.com');
  assert.equal(await shadowValue('linkedin'), 'https://www.linkedin.com/in/ada');
  await page.close();
});

test('strict Content-Security-Policy pages fill and show the toast', async () => {
  const page = await h.open('csp-form.html');
  const r = await h.bg((id) => globalThis.JTFBackground.fillTab(id, { toast: true }), await h.tabId(page));
  assert.equal(await value(page, '#first'), 'Ada');
  assert.equal(await value(page, '#email'), 'ada@example.com');
  assert.equal(r.filled, 2);
  assert.equal(await page.$$eval('jobtofill-ui', (hosts) => hosts.length), 1, 'toast host is in the page');
  await page.close();
});

test('tricky page: honeypots, existing values, custom radios, checkbox lists, ranges, dates', async () => {
  const page = await h.open('tricky.html');
  const r = await h.fill(page);
  assert.equal(await value(page, '#pre'), 'Augusta', 'existing values are not overwritten');
  assert.equal(await value(page, '#lastname'), 'Lovelace');
  assert.equal(await value(page, '#hp'), '', 'off-screen honeypot left empty');
  assert.equal(await value(page, '#hidden_email'), '', 'hidden field left empty');
  assert.equal(await value(page, '#realemail'), 'ada@example.com');
  assert.equal(await checked(page, 'input[name=age][value=y]'), true);
  assert.equal(await checked(page, 'input[name=langs][value=en]'), true);
  assert.equal(await checked(page, 'input[name=langs][value=fr]'), true);
  assert.equal(await checked(page, 'input[name=langs][value=es]'), false);
  assert.equal(await checked(page, '#auth'), true);
  assert.equal(await checked(page, '#terms'), false, 'never agrees to terms for you');
  assert.equal(await value(page, '#table_zip'), '94105');
  assert.equal(await value(page, '#inline_city'), 'San Francisco');
  assert.equal(await value(page, '#inline_state'), 'CA');
  assert.equal(
    await selectedText(page, '#country_default'),
    'United States',
    'a pre-selected default is not a user choice',
  );
  assert.equal(await selectedText(page, '#salary'), '$120k-$160k');
  assert.equal(await selectedText(page, '#yoe'), '5-10');
  assert.equal(await value(page, '#dob'), '1990-12-10');
  assert.equal(await value(page, '#start'), '2026-11-02');
  assert.equal(await value(page, '#fav'), '');
  assert.ok(r.skipped >= 1);
  assert.ok(r.missing.includes('Twitter / X'));

  // Undo restores what was there before.
  const undone = await h.handler('jtf:undo', page);
  assert.ok(undone.undone > 5);
  assert.equal(await value(page, '#lastname'), '');
  assert.equal(await checked(page, '#auth'), false);
  assert.equal(await selectedText(page, '#country_default'), 'Canada');
  assert.equal(await value(page, '#pre'), 'Augusta');
  await page.close();
});

test('overwrite setting replaces existing values', async () => {
  await h.setSettings({ overwrite: true });
  const page = await h.open('tricky.html');
  await h.fill(page);
  assert.equal(await value(page, '#pre'), 'Ada');
  await h.setSettings({ overwrite: false });
  await page.close();
});

test('learn from page suggests profile values and custom answers', async () => {
  const page = await h.open('tricky.html');
  await typeInto(page, '#fav', 'Rust');
  await typeInto(page, '#tw', 'https://x.com/ada');
  await typeInto(page, '#lastname', 'Lovelace');
  const { suggestions } = await h.handler('jtf:learn', page);
  const custom = suggestions.find((s) => s.kind === 'custom' && /favourite programming language/i.test(s.question));
  assert.ok(custom, JSON.stringify(suggestions));
  assert.equal(custom.value, 'Rust');
  const twitter = suggestions.find((s) => s.kind === 'profile' && s.path === 'links.twitter');
  assert.ok(twitter);
  assert.equal(twitter.value, 'https://x.com/ada');
  assert.ok(!suggestions.some((s) => s.path === 'personal.lastName'), 'already in the profile');
  await page.close();
});

test('inspect overlay toggles', async () => {
  const page = await h.open('greenhouse.html');
  const on = await h.handler('jtf:inspect', page);
  assert.equal(on.on, true);
  assert.ok(on.detected > 20);
  assert.equal(await page.$$eval('jobtofill-ui', (hosts) => hosts.length), 1);
  const off = await h.handler('jtf:inspect', page);
  assert.equal(off.on, false);
  await page.close();
});

test('right-click “Insert from profile” fills the focused field', async () => {
  const page = await h.open('tricky.html');
  await page.focus('#fav');
  await h.menu(page, 'jtf-insert:links.github');
  assert.equal(await value(page, '#fav'), 'https://github.com/ada');
  await page.close();
});

test('vault locked or missing: passwords and cards are skipped with a note', async () => {
  const page = await h.open('checkout.html');
  const r = await h.fill(page);
  assert.equal(await value(page, '#fn'), 'Ada');
  assert.equal(await value(page, '#ccnum'), '');
  assert.ok(
    r.notes.some((n) => /vault/i.test(n)),
    JSON.stringify(r.notes),
  );
  await page.close();
});

test('checkout: address with codes, company stays empty, card from the vault', async () => {
  await h.bg(async () => {
    const { vault } = globalThis.JTF;
    await vault.setup('correct horse battery', { iterations: 2000 });
    await vault.update((d) => {
      d.cards.push({
        id: 'k1',
        label: 'Visa',
        name: 'Ada Lovelace',
        number: '4242424242424242',
        expMonth: 4,
        expYear: 2029,
        cvc: '123',
      });
      d.defaultCardId = 'k1';
    });
  });
  const page = await h.open('checkout.html');
  await h.fill(page);
  assert.equal(await value(page, '#email'), 'ada@example.com');
  assert.equal(await value(page, '#country'), 'US');
  assert.equal(await value(page, '#fn'), 'Ada');
  assert.equal(await value(page, '#ln'), 'Lovelace');
  assert.equal(await value(page, '#company'), '', 'your employer is not put on a shipping label');
  assert.equal(await value(page, '#a1'), '1 Market St');
  assert.equal(await value(page, '#a2'), 'Apt 5');
  assert.equal(await value(page, '#city'), 'San Francisco');
  assert.equal(await value(page, '#state'), 'CA');
  assert.equal(await value(page, '#zip'), '94105');
  assert.equal(await value(page, '#phone'), '+1 415 555 0100');
  assert.equal(await value(page, '#ccnum'), '4242424242424242');
  assert.equal(await value(page, '#ccname'), 'Ada Lovelace');
  assert.equal(await value(page, '#expm'), '04');
  assert.equal(await value(page, '#expy'), '2029');
  assert.equal(await value(page, '#cvc'), '123');
  assert.equal(await value(page, '#exp2'), '04/29');
  await page.close();
});

test('cards are not handed to a third-party iframe', async () => {
  const page = await h.open('third-party-frame.html');
  const frame = await frameWith(page, 'card-fields', '#ccnum');
  const r = await h.fill(page);
  assert.equal(await value(page, '#name'), 'Ada Lovelace', 'the top page gets the card');
  assert.equal(await value(frame, '#ccnum'), '');
  assert.ok(
    r.notes.some((n) => /Card not filled into a frame/.test(n)),
    JSON.stringify(r.notes),
  );
  const allowed = await h.bg(() => {
    const { cardAllowedIn, siteOf } = globalThis.JTFBackground;
    const tab = { url: 'https://shop.example/checkout' };
    return [
      cardAllowedIn({ frameId: 3, url: 'https://js.stripe.com/v3/elements', tab }),
      cardAllowedIn({
        frameId: 3,
        url: 'https://pay.shop.example/frame',
        tab: { url: 'https://www.shop.example/checkout' },
      }),
      cardAllowedIn({ frameId: 3, url: 'https://ads.tracker.example/x', tab }),
      siteOf('checkout.shop.co.uk'),
    ];
  });
  assert.deepEqual(allowed, [true, true, false, 'shop.co.uk']);
  await page.close();
});

test('sign-up generates and saves a password; login fills it back', async () => {
  const signup = await h.open('signup.html');
  const r = await h.fill(signup);
  const password = await value(signup, '#password');
  assert.equal(password.length, 20);
  assert.equal(await value(signup, '#password2'), password);
  assert.equal(await value(signup, '#email'), 'ada@example.com');
  assert.equal(await checked(signup, '#terms'), false);
  assert.ok(
    r.notes.some((n) => /Generated a new password for localhost/.test(n)),
    JSON.stringify(r.notes),
  );
  const saved = await h.bg(async () =>
    (await globalThis.JTF.vault.read()).credentials.map((c) => [c.host, c.username, c.password]),
  );
  assert.deepEqual(saved, [['localhost', 'ada@example.com', password]]);

  // Filling the sign-up page again reuses the saved password rather than making another.
  const again = await h.open('signup.html');
  await h.fill(again);
  assert.equal(await value(again, '#password'), password);

  const login = await h.open('login.html');
  await h.fill(login);
  assert.equal(await value(login, '#user'), 'ada@example.com');
  assert.equal(await value(login, '#pw'), password);
  await Promise.all([signup.close(), again.close(), login.close()]);
});

test('the default password is only used when that strategy is chosen', async () => {
  await h.bg(() =>
    globalThis.JTF.vault.update((d) => {
      d.defaultPassword = 'Default-Pass-123!';
    }),
  );
  const login = await h.open('login.html', '127.0.0.1');
  const r = await h.fill(login);
  assert.equal(await value(login, '#pw'), '', 'no saved login for 127.0.0.1 and the strategy is “generate”');
  assert.ok(
    r.notes.some((n) => /No saved password for 127\.0\.0\.1/.test(n)),
    JSON.stringify(r.notes),
  );
  await h.setSettings({ passwordStrategy: 'default' });
  await login.reload();
  await h.fill(login);
  assert.equal(await value(login, '#pw'), 'Default-Pass-123!');
  await h.setSettings({ passwordStrategy: 'generate' });
  await login.close();
});

test('passwords are not handed to insecure origins', async () => {
  // Any non-local http:// origin will do; *.localhost resolves to this machine in both browsers.
  const page = await h.open('login.html', 'insecure.localhost');
  const r = await h.fill(page);
  assert.equal(await value(page, '#pw'), '');
  assert.ok(
    r.notes.some((n) => /secure \(https\)/.test(n)),
    JSON.stringify(r.notes),
  );
  await page.close();
});

test('right-click “Generate strong password” fills and saves it', async () => {
  await h.bg(() =>
    globalThis.JTF.vault.update((d) => {
      d.credentials = [];
    }),
  );
  const page = await h.open('signup.html');
  await page.focus('#password');
  await h.menu(page, 'jtf-genpass');
  const password = await value(page, '#password');
  assert.equal(password.length, 20);
  assert.equal(await value(page, '#password2'), password);
  const saved = await h.bg(async () => (await globalThis.JTF.vault.read()).credentials.map((c) => c.password));
  assert.deepEqual(saved, [password]);
  await page.close();
});

test('application log records filled job applications only', async () => {
  const titles = (await h.bg(() => globalThis.JTF.store.getHistory())).map((entry) => entry.title);
  assert.ok(
    titles.some((t) => /Greenhouse-style/.test(t)),
    JSON.stringify(titles),
  );
  assert.ok(!titles.some((t) => /Checkout/.test(t)), 'checkout pages are not job applications');
});

test('restricted pages report a friendly error', async () => {
  const settings = await h.extPage('options/options.html');
  const tabId = await settings.call(() => globalThis.JTF.api.tabs.getCurrent().then((t) => t.id));
  const r = await h.bg((id) => globalThis.JTFBackground.fillTab(id), tabId);
  assert.match(r.error, /can’t run on this page/);
  await settings.close();
});
