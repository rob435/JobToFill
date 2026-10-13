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
import { mergeEdits, same } from './edits.js';
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
// The stored profile this page's copy last matched (read, written, or changed elsewhere and taken in): where the
// copy differs from it is what this page has to save, and nothing else is written. `origins`: where each list
// entry of the copy was in it, so an education entry moved here keeps a change made to it elsewhere.
let base = null;
let origins = new WeakMap();
// Every profile as last seen stored, and whether a write of this page's is on its way: for the write made as the
// page closes, which can't wait for a read (see flushOnHide).
let stored = null;
let writing = false;
// Boxes typed in since they were drawn: one drawn again keeps what it shows (see redraw).
const typed = new WeakSet();

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

/** The page's copy of the profile is what is stored now: remember it, and where each list entry is in it. */
function inStep() {
  const next = new WeakMap();
  const tag = (value) => {
    if (Array.isArray(value))
      value.forEach((x, i) => {
        if (x && typeof x === 'object') next.set(x, i);
        tag(x);
      });
    else if (value && typeof value === 'object') Object.values(value).forEach(tag);
  };
  tag(state.profile);
  base = structuredClone(state.profile);
  origins = next;
}

const originOf = (entry) => origins.get(entry);
const unsaved = () => !!state.profile && !!base && !same(state.profile, base);

// Saves, and changes made elsewhere being taken in, one at a time.
let turn = Promise.resolve();
function inTurn(fn) {
  const run = turn.then(fn);
  turn = run.catch(() => {});
  return run;
}

/** Write the page's copy; from then on only what is typed after it differs from the stored profile. */
async function write() {
  const before = { base, origins };
  inStep();
  stored = { ...stored, [state.profile.id]: base };
  writing = true;
  try {
    await store.saveProfile(structuredClone(base));
  } catch (err) {
    ({ base, origins } = before);
    throw err;
  } finally {
    writing = false;
  }
}

/**
 * Save what this page changed onto the profile as it is stored now: what Popup › Learn from this page or another
 * Settings tab saved meanwhile stays (a stale copy of the whole profile used to be written over it).
 */
async function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  await inTurn(async () => {
    const latest = (await store.loadAll()).profiles[state.profile.id];
    // Deleted in another tab: the page moves to the profile now active (takeIn).
    if (!latest) return;
    if (!same(latest, base)) await adopt(mergeEdits(base, state.profile, latest, originOf));
    if (same(state.profile, latest)) inStep();
    else await write();
  });
  if (!saveTimer) setSaveState('All changes saved', true);
}

/**
 * The page is going away (its tab closed): what isn't saved yet is put onto the profile as last seen stored and
 * kept. A save that reads storage first never lands, as the page is gone before the read comes back: Chromium takes
 * one write of the profiles, Firefox (which drops that) a message to the background (keepEdits).
 */
function flushOnHide() {
  const latest = stored && state.profile && stored[state.profile.id];
  if (!latest || !(writing || unsaved())) return;
  const profile = mergeEdits(base, state.profile, latest, originOf);
  api.storage.local.set({ profiles: { ...stored, [profile.id]: profile } }).catch(() => {});
  api.runtime.sendMessage({ type: 'jtf:keep', profile }).catch(() => {});
}

/** Show a profile changed elsewhere (with this page's edits on it), in place of the page's copy. */
async function adopt(profile) {
  state.profile = structuredClone(profile);
  state.all.profiles[profile.id] = state.profile;
  renderSetup();
  if (PROFILE_SECTIONS[state.section]) await redraw();
}

/**
 * Draw the section again, the box that had focus focused again (found by its name and place) with its caret, and
 * what was typed into it kept: a year half typed isn't in the profile yet.
 */
async function redraw() {
  const container = $('#sections');
  const active = container.contains(document.activeElement) ? document.activeElement : null;
  const named = (name) => Array.from(container.querySelectorAll(`[name="${CSS.escape(name)}"]`));
  const spot = active && active.name ? { el: active, index: named(active.name).indexOf(active) } : null;
  const { scrollX, scrollY } = window;
  await show(state.section);
  window.scrollTo(scrollX, scrollY);
  const again = spot && named(spot.el.name)[spot.index];
  if (!again) return;
  const text = again.matches('textarea, input:not([type="checkbox"]):not([type="radio"])');
  if (text && typed.has(spot.el) && again.value !== spot.el.value) {
    again.value = spot.el.value;
    again.dispatchEvent(new Event('input', { bubbles: true }));
  }
  again.focus({ preventScroll: true });
  if (!text) return;
  again.scrollTop = spot.el.scrollTop;
  try {
    again.setSelectionRange(spot.el.selectionStart, spot.el.selectionEnd);
  } catch (err) {
    /* a box without a caret (email, number, date) */
  }
}

/**
 * Another context changed the profiles (Popup › Learn from this page, another Settings tab, a restore): its
 * changes come in at once, and this page's edits stay on top of them, also in the box being typed in. Edits not
 * saved yet are saved with them, so the page is in step with storage again.
 */
async function takeIn() {
  if (!state.profile) return;
  const all = await store.loadAll();
  const latest = all.profiles[state.profile.id];
  if (!latest) return load();
  state.all = all;
  all.profiles[state.profile.id] = state.profile;
  if (!same(latest, base)) {
    const edited = unsaved();
    await adopt(mergeEdits(base, state.profile, latest, originOf));
    if (edited && !same(state.profile, latest)) {
      clearTimeout(saveTimer);
      saveTimer = null;
      await write();
      setSaveState('All changes saved', true);
    } else inStep();
  }
  renderProfilePicker();
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
  stored = structuredClone(state.all.profiles);
  state.profile = state.all.profiles[state.all.settings.activeProfileId];
  inStep();
  renderProfilePicker();
  await show(location.hash.slice(1) || state.section);
  await readSetupFacts();
}

async function switchTo(id) {
  // A name half typed belonged to the profile being left.
  $('#profile-form').hidden = true;
  $('.profile-actions').hidden = false;
  if (unsaved()) await saveNow();
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
  if (changes.profiles) stored = changes.profiles.newValue || {};
  if (changes.profiles || changes.profileOrder) inTurn(takeIn).catch(() => {});
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
  // Another tab brought forward: saved now rather than after the pause. The tab closing: see flushOnHide.
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && unsaved() && saveNow());
  window.addEventListener('pagehide', flushOnHide);
  document.addEventListener('input', (e) => typed.add(e.target), true);
  $('#profile-select').addEventListener('change', (e) => switchTo(e.target.value));
  for (const [action, run] of Object.entries(PROFILE_ACTIONS)) $('#profile-' + action).addEventListener('click', run);
  api.storage.onChanged.addListener(onStorageChanged);

  await renderAccessBanner();
  await renderRestoreBanner();
  await load();
}

init();
