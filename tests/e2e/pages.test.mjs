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
  assert.equal(sections.length, 14);
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

test('the vault can be created and locked from the settings page', async () => {
  const settings = await h.extPage('options/options.html#vault');
  await until(settings.call, () => document.querySelector('input[name="master2"]'));
  await settings.call(() => {
    document.querySelector('input[name="master"]').value = 'my long master password';
    document.querySelector('input[name="master2"]').value = 'my long master password';
    document.querySelector('#sections form').requestSubmit();
  });
  await until(settings.call, () => document.querySelector('#sections').textContent.includes('Saved logins (0)'));
  assert.equal(await h.bg(() => globalThis.JTF.vault.status()), 'unlocked');

  await settings.call(() =>
    [...document.querySelectorAll('#sections button')].find((b) => b.textContent === 'Lock now').click(),
  );
  await until(settings.call, () => document.querySelector('#sections').textContent.includes('Vault locked'));
  assert.equal(await h.bg(() => globalThis.JTF.vault.status()), 'locked');
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
