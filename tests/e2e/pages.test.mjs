// End-to-end: the extension's own pages (settings, popup) in Chromium or Firefox.
// Everything runs inside the page through `call`, so it works the same in both browsers.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PROFILE, launch, until, value } from './harness.mjs';

let h;

before(async () => {
  h = await launch();
  await h.setProfile(PROFILE);
});

after(() => h.close());

test('every settings section renders', async () => {
  const settings = await h.extPage('options/options.html');
  const sections = await until(settings.call, () => {
    const links = [...document.querySelectorAll('#nav a')].map((a) => a.hash.slice(1));
    return document.querySelector('#sections h1') && links;
  });
  assert.equal(sections.length, 15);
  for (const section of sections) {
    const title = await until(
      settings.call,
      (name) => {
        if (location.hash !== '#' + name) location.hash = name;
        const container = document.querySelector('#sections');
        const current = document.querySelector('#nav a[aria-current="page"]');
        return (
          container.dataset.section === name &&
          current &&
          current.hash === '#' + name &&
          container.querySelector('h1').textContent
        );
      },
      section,
    );
    assert.ok(title, section);
  }
  await settings.close();
});

test('month/year pickers save YYYY-MM', async () => {
  const settings = await h.extPage('options/options.html#experience');
  await until(settings.call, () => document.querySelector('select[name="startDate-month"]'));
  const shown = await settings.call(() => {
    const month = document.querySelector('select[name="startDate-month"]');
    const year = document.querySelector('input[name="startDate-year"]');
    const before = [month.value, year.value];
    month.value = '7';
    month.dispatchEvent(new Event('change'));
    year.value = '2021';
    year.dispatchEvent(new Event('input'));
    return before;
  });
  assert.deepEqual(shown, ['3', '2020'], 'shows the stored 2020-03');
  const saved = await until(h.bg, async () => {
    const { profile } = await globalThis.JTF.store.getActive();
    return profile.experience[0].startDate === '2021-07' && profile.experience[0].startDate;
  });
  assert.equal(saved, '2021-07');
  await settings.close();
});

test('passwords left in an old encrypted vault move over once from the settings page', async () => {
  // What an older version left behind: its vault, AES-256-GCM with a PBKDF2-SHA256 key from the master password.
  await h.bg(async (master) => {
    const { subtle } = globalThis.crypto;
    const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const base = await subtle.importKey('raw', new TextEncoder().encode(master), 'PBKDF2', false, ['deriveKey']);
    const key = await subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 2000, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt'],
    );
    const login = { id: 'o1', host: 'acme.wd5.myworkdayjobs.com', username: 'ada@example.com', password: 'Acme-1' };
    const plain = { version: 1, defaultPassword: '', credentials: [login], cards: [], defaultCardId: null };
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(plain)));
    const kdf = { name: 'PBKDF2', hash: 'SHA-256', iterations: 2000, salt: b64(salt) };
    await globalThis.JTF.api.storage.local.set({ vault: { version: 1, kdf, data: { iv: b64(iv), ct: b64(ct) } } });
  }, 'my long master password');

  // Old links to "#vault" land on Passwords & cards.
  const settings = await h.extPage('options/options.html#vault');
  await until(settings.call, () => location.hash === '#passwords' && !!document.querySelector('[name="legacyMaster"]'));
  const submit = (master) => {
    const input = document.querySelector('[name="legacyMaster"]');
    input.value = master;
    input.form.requestSubmit();
  };
  await settings.call(submit, 'wrong password');
  await until(settings.call, () =>
    [...document.querySelectorAll('#sections .error')].some((e) => e.textContent === 'Wrong master password.'),
  );
  await settings.call(submit, 'my long master password');
  await until(
    settings.call,
    () =>
      document.querySelector('#sections').textContent.includes('Saved logins (1)') &&
      !document.querySelector('[name="legacyMaster"]'),
  );
  const moved = await h.bg(async () => {
    const { passwords } = globalThis.JTF;
    return [await passwords.legacy(), (await passwords.read()).credentials.map((c) => c.password)];
  });
  assert.deepEqual(moved, [false, ['Acme-1']]);
  await h.bg(() => globalThis.JTF.passwords.update((d) => (d.credentials = [])));
  await settings.close();
});

test('the popup fills the page it points at', async () => {
  const form = await h.open('greenhouse.html');
  const tabId = await h.tabId(form);
  const popup = await h.extPage(`popup/popup.html?tab=${tabId}`);
  const access = await until(
    popup.call,
    () => document.querySelector('#version').textContent && document.querySelector('#access').hidden,
  );
  assert.equal(access, true, 'site access is granted, so no “Allow” prompt');

  await popup.call(() => document.querySelector('#fill').click());
  const count = await until(popup.call, () => {
    const el = document.querySelector('#result .count');
    return el && Number(el.textContent);
  });
  assert.ok(count >= 20, `filled ${count}`);
  const summary = await popup.call(() => document.querySelector('#result').textContent);
  assert.match(summary, /Missing from your profile:/);
  assert.doesNotMatch(summary, /null|undefined/);
  assert.equal(await value(form, '#first_name'), 'Ada');

  await popup.call(() =>
    [...document.querySelectorAll('#result button')].find((b) => b.textContent === 'Undo').click(),
  );
  await until(popup.call, () => /Restored \d+ fields?/.test(document.querySelector('#result').textContent));
  assert.equal(await value(form, '#first_name'), '');
  await popup.close();
  await form.close();
});
