/* JobToFill settings page — shell: profile bar, navigation, autosave, Get started list, access and restore banners. */
import {
  $,
  $$,
  api,
  el,
  fillShortcut,
  hasSiteAccess,
  isFirefox,
  openShortcutSettings,
  requestSiteAccess,
  toolbarPinned,
} from '../ui/common.js';
import { renderBackup, renderHistory, renderSettings } from './app.js';
import { renderEmail } from './email.js';
import { renderLetters } from './letters.js';
import { renderPasswords } from './passwords.js';
import { CLASSIFICATIONS, DEGREES, PROFILE_SECTIONS } from './profile.js';
import { setupComplete, setupSteps } from './setup.js';

const { store, geo } = globalThis.JTF;

const SECTIONS = {
  ...PROFILE_SECTIONS,
  letters: renderLetters,
  passwords: renderPasswords,
  email: renderEmail,
  history: renderHistory,
  settings: renderSettings,
  backup: renderBackup,
};

const state = { all: null, profile: null, section: 'personal' };

/* ------------------------------------------------------------- autosave */

let saveTimer = null;

function setSaveState(text, saved) {
  const label = $('#save-state');
  // Only a change is written, so a screen reader hears "Saving…" once, not at every key.
  if (label.textContent !== text) label.textContent = text;
  label.classList.toggle('saved', !!saved);
}

function scheduleSave() {
  setSaveState('Saving…');
  renderSetup();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 350);
}

async function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  await store.saveProfile(state.profile);
  setSaveState('All changes saved', true);
}

/* -------------------------------------------------------------- routing */

const ctx = { state, scheduleSave, saveNow, refresh: () => show(state.section), reload: load };

// Links from older versions: "#vault" was the passwords section.
const RENAMED = { vault: 'passwords' };

/**
 * In a narrow window the sections are one bar that scrolls sideways: bring the current one into it. (Not with
 * scrollIntoView(), which in Chromium also moves where the next Tab starts from.)
 */
function revealLink(link) {
  const nav = $('#nav');
  if (nav.scrollWidth <= nav.clientWidth) return;
  const a = link.getBoundingClientRect();
  const n = nav.getBoundingClientRect();
  if (a.left < n.left + 16) nav.scrollLeft -= n.left + 16 - a.left;
  else if (a.right > n.right - 24) nav.scrollLeft += a.right - (n.right - 24);
}

async function show(section) {
  if (RENAMED[section]) {
    section = RENAMED[section];
    history.replaceState(null, '', '#' + section);
  }
  if (!SECTIONS[section]) section = 'personal';
  state.section = section;
  for (const link of $$('#nav a')) {
    if (link.getAttribute('href') !== '#' + section) link.removeAttribute('aria-current');
    else {
      link.setAttribute('aria-current', 'page');
      revealLink(link);
    }
  }
  const container = $('#sections');
  const nodes = await SECTIONS[section](ctx);
  container.replaceChildren(...nodes.filter(Boolean));
  container.dataset.section = section;
}

/* ------------------------------------------------------------- profiles */

function renderProfilePicker() {
  const { order, profiles } = state.all;
  $('#profile-select').replaceChildren(
    ...order.map((id) =>
      el('option', { value: id, textContent: profiles[id].name, selected: id === state.profile.id }),
    ),
  );
  $('#profile-delete').disabled = order.length < 2;
  $('#profile-delete').title = order.length < 2 ? 'Your only profile can’t be deleted' : '';
}

async function load() {
  state.all = await store.loadAll();
  state.profile = state.all.profiles[state.all.settings.activeProfileId];
  renderProfilePicker();
  await show(location.hash.slice(1) || state.section);
  await readSetupFacts();
}

async function switchTo(id) {
  // A name half typed belonged to the profile being left.
  $('#profile-form').hidden = true;
  $('.profile-actions').hidden = false;
  if (saveTimer) await saveNow();
  await store.setActive(id);
  await load();
}

// New, Duplicate and Rename ask for the name in the profile bar itself: { label, value, submit, run(name) }.
const NAMING = {
  new: {
    label: 'Name for the new profile',
    placeholder: 'e.g. Software engineer',
    value: () => '',
    submit: 'Create',
    run: async (name) => switchTo((await store.createProfile(name)).id),
  },
  dup: {
    label: 'Name for the copy',
    value: () => state.profile.name + ' (copy)',
    submit: 'Duplicate',
    async run(name) {
      await saveNow();
      await switchTo((await store.createProfile(name, state.profile)).id);
    },
  },
  rename: {
    label: 'New name',
    value: () => state.profile.name,
    submit: 'Rename',
    async run(name) {
      state.profile.name = name;
      await saveNow();
      await load();
    },
  },
};

/** Swap the profile buttons for a name box; Enter does it, Escape or Cancel puts the buttons back. */
function askName(kind, opener) {
  const spec = NAMING[kind];
  const form = $('#profile-form');
  const input = $('#profile-name');
  $('#profile-name-label').textContent = spec.label;
  $('#profile-submit').textContent = spec.submit;
  input.placeholder = spec.placeholder || '';
  input.value = spec.value();
  $('.profile-actions').hidden = true;
  form.hidden = false;
  input.focus();
  input.select();
  const close = () => {
    form.hidden = true;
    $('.profile-actions').hidden = false;
    opener.focus();
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) return input.focus();
    close();
    await spec.run(name);
  };
  $('#profile-cancel').onclick = close;
  input.onkeydown = (e) => {
    if (e.key === 'Escape') close();
  };
}

const PROFILE_ACTIONS = {
  new: (e) => askName('new', e.currentTarget),
  dup: (e) => askName('dup', e.currentTarget),
  rename: (e) => askName('rename', e.currentTarget),
  async delete() {
    if (!confirm(`Delete the profile “${state.profile.name}” and its files? This can’t be undone.`)) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    await store.deleteProfile(state.profile.id);
    await load();
  },
};

/* ---------------------------------------------------------- get started */

// What the checklist needs besides the profile, read again whenever one of them changes.
const setupFacts = { resume: false, aiKey: false, inbox: false, pinned: null, shortcut: '', dismissed: false };
let setupDrawn = '';

async function readSetupFacts() {
  if (!state.profile) return;
  const [docs, config, nylas, settings, shortcut, pinned] = await Promise.all([
    store.docInfo(state.profile.id),
    store.aiConfig(),
    store.getNylas(),
    store.getSettings(),
    fillShortcut(),
    toolbarPinned(),
  ]);
  Object.assign(setupFacts, {
    resume: !!docs.resume,
    aiKey: !!config.apiKey,
    inbox: !!(nylas && nylas.grantId),
    dismissed: !!settings.setupDismissed,
    shortcut,
    pinned,
  });
  renderSetup();
}

const PIN_HOW = isFirefox
  ? 'Puzzle-piece menu › ⚙ beside JobToFill › Pin to Toolbar. '
  : 'Puzzle-piece menu › the pin beside JobToFill. ';

/** How to pin the button, and the shortcut that fills a page without it. */
function pinHint() {
  const shortcut = setupFacts.shortcut;
  return el(
    'small',
    {},
    PIN_HOW,
    shortcut
      ? ['On an application, click it or press ', el('kbd', { textContent: shortcut }), '.']
      : [
          'On an application, click it, or ',
          el('button', {
            type: 'button',
            className: 'link',
            textContent: 'set a keyboard shortcut',
            onclick: openShortcutSettings,
          }),
          '.',
        ],
  );
}

/** The "Get started" card above every section, while setup is incomplete and the person hasn't hidden it. */
function renderSetup() {
  const card = $('#setup');
  if (!state.profile) return;
  const steps = setupSteps({ profile: state.profile, ...setupFacts });
  const hide = setupFacts.dismissed || setupComplete(steps);
  // Drawn again only when a step changes, not at every key typed.
  const drawn = hide ? 'hidden' : JSON.stringify([steps.map((s) => [s.done, s.optional]), setupFacts.shortcut]);
  if (drawn === setupDrawn) return;
  setupDrawn = drawn;
  card.hidden = hide;
  if (hide) return card.replaceChildren();
  const done = steps.filter((s) => s.done).length;
  const step = (s) =>
    el(
      'li',
      { className: s.done ? 'done' : '' },
      el('span', { className: 'setup-mark', textContent: s.done ? '✓' : '', attrs: { 'aria-hidden': 'true' } }),
      el(
        'div',
        {},
        el('span', { className: 'visually-hidden', textContent: s.done ? 'Done: ' : 'To do: ' }),
        s.href
          ? el('a', { href: s.href, textContent: s.text })
          : el('span', { className: 'setup-step', textContent: s.text }),
        s.optional && s.id !== 'toolbar' ? el('span', { className: 'pill', textContent: 'optional' }) : null,
        s.id === 'toolbar' ? pinHint() : null,
      ),
    );
  const bar = el('span');
  bar.style.width = `${Math.round((done / steps.length) * 100)}%`;
  card.replaceChildren(
    el(
      'div',
      { className: 'setup-head' },
      el('p', { className: 'setup-title', textContent: 'Get started' }),
      el('span', { className: 'setup-count', textContent: `${done} of ${steps.length} done` }),
      el('button', {
        type: 'button',
        className: 'small ghost',
        textContent: 'Hide',
        attrs: { 'aria-label': 'Hide the Get started list' },
        onclick: dismissSetup,
      }),
    ),
    el('div', { className: 'setup-bar', attrs: { 'aria-hidden': 'true' } }, bar),
    el('ol', { className: 'setup-steps' }, steps.map(step)),
  );
}

async function dismissSetup() {
  setupFacts.dismissed = true;
  renderSetup();
  $('#sections').focus({ preventScroll: true });
  await store.saveSettings({ setupDismissed: true });
}

/* ---------------------------------------------------------- site access */

async function renderAccessBanner() {
  const banner = $('#access');
  banner.hidden = await hasSiteAccess();
  banner.querySelector('button').onclick = async () => {
    if (await requestSiteAccess()) banner.hidden = true;
  };
}

/* -------------------------------------------------------------- restore */

/**
 * After JobToFill is removed and added again its storage starts empty. Offer the backup file the
 * background keeps in Downloads/JobToFill (and that an earlier install may have left behind).
 */
async function renderRestoreBanner() {
  const banner = $('#restore');
  const info = await store.getBackupInfo();
  banner.hidden = !info.paused && (info.dismissed || (await store.hasData()));
  if (banner.hidden) return;
  const where = info.previous
    ? `Your details were backed up to ${info.previous.path}${info.previous.at ? ` on ${new Date(info.previous.at).toLocaleDateString()}` : ''}. Restore them to carry on where you left off.`
    : 'Restore your details from the backup file JobToFill keeps in Downloads › JobToFill › jobtofill-backup.json.';
  $('#restore-text').textContent = where;
  const finish = async () => {
    await store.setBackupInfo({ paused: false, dismissed: true, previous: null });
    banner.hidden = true;
  };
  $('#restore-skip').onclick = finish;
  $('#restore-pick').onclick = () => $('#restore-file').click();
  $('#restore-file').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      await store.importData(JSON.parse(await file.text()));
    } catch (err) {
      $('#restore-text').textContent = `That file couldn’t be restored: ${err.message}`;
      return;
    }
    await finish();
    location.reload();
  };
}

/* ----------------------------------------------------------------- init */

function onStorageChanged(changes, area) {
  if (area !== 'local') return;
  // A CV uploaded, an AI key or inbox added, the checklist hidden: tick it off.
  if (Object.keys(changes).some((k) => /^(aiKeys|nylas|settings|doc:.+)$/.test(k))) readSetupFacts();
  // A backup was found, restored or written while this page is open.
  if (changes.backupInfo || changes.profiles) renderRestoreBanner();
  // The popup's "learn" feature or another tab changed the profile: reload unless mid-edit.
  if (saveTimer || !(changes.profiles || changes.profileOrder)) return;
  const next = changes.profiles && changes.profiles.newValue && changes.profiles.newValue[state.profile.id];
  if (next && JSON.stringify(next) === JSON.stringify(state.profile)) return;
  const active = document.activeElement;
  if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return;
  load();
}

async function init() {
  $('#countries').append(...geo.COUNTRIES.map((c) => el('option', { value: c[2] })));
  $('#degrees').append(...DEGREES.map((d) => el('option', { value: d })));
  $('#classifications').append(...CLASSIFICATIONS.map(([value, label]) => el('option', { value, label })));

  window.addEventListener('hashchange', () => show(location.hash.slice(1)).then(() => window.scrollTo(0, 0)));
  // Straight to the section's own content, without changing the address (which would change the section).
  $('.skip').addEventListener('click', (e) => {
    e.preventDefault();
    $('#sections').focus();
  });
  // Pinning the button happens outside the page: look again when the person comes back to it.
  window.addEventListener('focus', () => readSetupFacts());
  if (api.action && api.action.onUserSettingsChanged) api.action.onUserSettingsChanged.addListener(readSetupFacts);
  document.addEventListener('visibilitychange', () => saveTimer && saveNow());
  $('#profile-select').addEventListener('change', (e) => switchTo(e.target.value));
  for (const [action, run] of Object.entries(PROFILE_ACTIONS)) $('#profile-' + action).addEventListener('click', run);
  api.storage.onChanged.addListener(onStorageChanged);

  await renderAccessBanner();
  await renderRestoreBanner();
  await load();
}

init();
