/* JobToFill settings page — shell: profile bar, navigation, autosave, site-access and restore banners. */
import { $, $$, api, el, hasSiteAccess, requestSiteAccess } from '../ui/common.js';
import { renderBackup, renderHistory, renderSettings } from './app.js';
import { DEGREES, PROFILE_SECTIONS } from './profile.js';
import { renderVault } from './vault.js';

const { store, geo } = globalThis.JTF;

const SECTIONS = {
  ...PROFILE_SECTIONS,
  vault: renderVault,
  history: renderHistory,
  settings: renderSettings,
  backup: renderBackup,
};

const state = { all: null, profile: null, section: 'personal' };

/* ------------------------------------------------------------- autosave */

let saveTimer = null;

function setSaveState(text, saved) {
  const label = $('#save-state');
  label.textContent = text;
  label.classList.toggle('saved', !!saved);
}

function scheduleSave() {
  setSaveState('Saving…');
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

async function show(section) {
  if (!SECTIONS[section]) section = 'personal';
  state.section = section;
  for (const link of $$('#nav a')) {
    if (link.getAttribute('href') === '#' + section) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
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
}

async function load() {
  state.all = await store.loadAll();
  state.profile = state.all.profiles[state.all.settings.activeProfileId];
  renderProfilePicker();
  await show(location.hash.slice(1) || state.section);
}

async function switchTo(id) {
  if (saveTimer) await saveNow();
  await store.setActive(id);
  await load();
}

const PROFILE_ACTIONS = {
  async new() {
    const name = prompt('Name for the new profile (e.g. “Software engineer”, “Personal shopping”)');
    if (name) await switchTo((await store.createProfile(name.trim())).id);
  },
  async dup() {
    const name = prompt('Name for the copy', state.profile.name + ' (copy)');
    if (!name) return;
    await saveNow();
    await switchTo((await store.createProfile(name.trim(), state.profile)).id);
  },
  async rename() {
    const name = prompt('Rename profile', state.profile.name);
    if (!name) return;
    state.profile.name = name.trim();
    await saveNow();
    await load();
  },
  async delete() {
    if (!confirm(`Delete the profile “${state.profile.name}” and its files?`)) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    await store.deleteProfile(state.profile.id);
    await load();
  },
};

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

  window.addEventListener('hashchange', () => show(location.hash.slice(1)).then(() => window.scrollTo(0, 0)));
  document.addEventListener('visibilitychange', () => saveTimer && saveNow());
  $('#profile-select').addEventListener('change', (e) => switchTo(e.target.value));
  for (const [action, run] of Object.entries(PROFILE_ACTIONS)) $('#profile-' + action).addEventListener('click', run);
  api.storage.onChanged.addListener(onStorageChanged);

  await renderAccessBanner();
  await renderRestoreBanner();
  await load();
}

init();
