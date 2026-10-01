/* JobToFill — toolbar popup. */
import { $, $$, api, el, fillShortcut, hasSiteAccess, plural, requestSiteAccess } from '../ui/common.js';

const { store, vault, util } = globalThis.JTF;

let tab = null;
let suggestions = [];

const send = (message) => api.runtime.sendMessage({ tabId: tab.id, ...message });

function openOptions(section) {
  api.tabs.create({ url: api.runtime.getURL('options/options.html') + (section ? '#' + section : '') });
  window.close();
}

/** The settings section that holds the data for a field type. */
function sectionFor(type) {
  if (!type) return 'personal';
  const prefixes = {
    'links.': 'links',
    'job.': 'work',
    'edu.': 'education',
    'exp.': 'experience',
    'eeo.': 'eeo',
    'file.': 'documents',
  };
  for (const [prefix, section] of Object.entries(prefixes)) if (type.startsWith(prefix)) return section;
  return ['skills', 'languages', 'summary', 'coverLetter'].includes(type) ? 'writing' : 'personal';
}

/* ------------------------------------------------------------- profiles */

async function renderProfiles() {
  const { profiles, order, settings } = await store.loadAll();
  const select = $('#profile');
  select.replaceChildren(
    ...order.map((id) =>
      el('option', { value: id, textContent: profiles[id].name, selected: id === settings.activeProfileId }),
    ),
  );
  select.hidden = order.length < 2;
}

/* ----------------------------------------------------------------- fill */

function showResult(...nodes) {
  const box = $('#result');
  box.hidden = false;
  box.replaceChildren(...nodes.filter(Boolean));
}

const resultLine = (label, items) =>
  el(
    'p',
    { className: 'result-list' },
    el('b', { textContent: label + ' ' }),
    items.slice(0, 8).join(', ') + (items.length > 8 ? '…' : ''),
  );

function renderResult(r) {
  if (r.error)
    return showResult(
      el('div', { className: 'result-head' }, el('span', { className: 'pill bad', textContent: 'Can’t fill' })),
      el('p', { className: 'result-list', textContent: r.error }),
    );
  if (!r.detected)
    return showResult(el('div', { className: 'result-head', textContent: 'No form fields found on this page.' }));

  const skipped = r.skipped
    ? el('span', {
        className: 'pill',
        textContent: `${r.skipped} already set`,
        title: 'Fields that already had a value were left alone. Turn on “Overwrite” in settings to replace them.',
      })
    : null;
  const actions = el(
    'div',
    { className: 'result-actions' },
    r.undoable ? el('button', { className: 'small', type: 'button', textContent: 'Undo', onclick: undo }) : null,
    r.missing.length
      ? el('button', {
          className: 'small ghost',
          type: 'button',
          textContent: 'Complete profile',
          onclick: () => openOptions(sectionFor(r.missingTypes[0])),
        })
      : null,
  );
  showResult(
    el(
      'div',
      { className: 'result-head' },
      el('span', { className: 'count', textContent: String(r.filled) }),
      el('span', { textContent: r.filled === 1 ? 'field filled' : 'fields filled' }),
      skipped,
    ),
    r.missing.length ? resultLine('Missing from your profile:', r.missing) : null,
    r.unmatched.length ? resultLine('No matching option:', r.unmatched) : null,
    ...r.notes.map((note) => el('p', { className: 'result-list', textContent: note })),
    actions.children.length ? actions : null,
  );
}

async function fill() {
  const button = $('#fill');
  const label = button.firstElementChild;
  button.disabled = true;
  label.textContent = 'Filling…';
  try {
    renderResult(await send({ type: 'jtf:fill' }));
  } catch (err) {
    renderResult({ error: String(err.message || err) });
  } finally {
    button.disabled = false;
    label.textContent = 'Fill this page';
  }
}

async function undo() {
  const r = await send({ type: 'jtf:undo' });
  showResult(el('p', { className: 'result-list', textContent: r.error || `Restored ${plural(r.undone, 'field')}.` }));
}

async function inspect() {
  const r = await send({ type: 'jtf:inspect' });
  if (r.error) return renderResult(r);
  const button = $('#inspect');
  button.setAttribute('aria-pressed', String(!!r.on));
  button.querySelector('span').textContent = r.on ? `Hide labels (${r.detected} found)` : 'Show detected fields';
}

/* ---------------------------------------------------------------- learn */

async function learn() {
  const r = await send({ type: 'jtf:learn' });
  if (r.error) return renderResult(r);
  suggestions = r.suggestions || [];
  $('#learn-panel').hidden = false;
  $('#learn-empty').hidden = suggestions.length > 0;
  $('#learn-save').hidden = suggestions.length === 0;
  $('#learn-list').replaceChildren(
    ...suggestions.map((s, i) =>
      el(
        'li',
        {},
        el(
          'label',
          {},
          el('input', { type: 'checkbox', checked: true, dataset: { index: String(i) } }),
          el(
            'span',
            {},
            el('div', { className: 'learn-q', textContent: s.kind === 'profile' ? s.label : s.question }),
            el('div', { className: 'learn-a', textContent: s.value }),
          ),
        ),
      ),
    ),
  );
}

async function saveLearned() {
  const picked = $$('#learn-list input:checked').map((input) => suggestions[+input.dataset.index]);
  if (!picked.length) return;
  const { profile } = await store.getActive();
  for (const s of picked) {
    const existing = s.replaces && profile.customAnswers.find((a) => a.id === s.replaces);
    if (s.kind === 'profile') util.setPath(profile, s.path, s.value);
    else if (existing) existing.answer = s.value;
    else profile.customAnswers.push({ id: util.uid(), question: s.question, answer: s.value });
  }
  await store.saveProfile(profile);
  $('#learn-list').replaceChildren();
  $('#learn-save').hidden = true;
  $('#learn-empty').hidden = false;
  $('#learn-empty').textContent = `Saved ${plural(picked.length, 'item')} to “${profile.name}”.`;
}

/* ---------------------------------------------------------------- vault */

async function renderVault() {
  const status = await vault.status();
  for (const row of $$('#vault [data-state]')) row.hidden = row.dataset.state !== status;
  $('#vault-error').hidden = true;
}

async function unlock(e) {
  e.preventDefault();
  const input = $('#vault-password');
  const button = e.target.querySelector('button');
  button.disabled = true;
  try {
    await vault.unlock(input.value);
    input.value = '';
    await renderVault();
  } catch (err) {
    $('#vault-error').textContent = err.message;
    $('#vault-error').hidden = false;
    input.select();
  } finally {
    button.disabled = false;
  }
}

/* --------------------------------------------------------------- access */

async function renderAccess() {
  $('#access').hidden = await hasSiteAccess();
}

async function allowAccess() {
  // requestSiteAccess() must run before any await so Firefox still sees the click.
  if (await requestSiteAccess()) $('#access').hidden = true;
}

/* ----------------------------------------------------------------- init */

async function init() {
  // popup.html?tab=<id> targets a specific tab (useful when the popup is opened as a page for debugging).
  const forced = new URLSearchParams(location.search).get('tab');
  tab = forced ? await api.tabs.get(+forced) : (await api.tabs.query({ active: true, currentWindow: true }))[0];

  $('#version').textContent = 'v' + api.runtime.getManifest().version;
  const shortcut = await fillShortcut();
  $('#shortcut').textContent = shortcut;
  $('#shortcut').hidden = !shortcut;

  if (!tab || !/^(https?|file):/.test(tab.url || '')) {
    for (const id of ['#fill', '#inspect', '#learn']) $(id).disabled = true;
    $('#page-note').hidden = false;
  }

  $('#fill').addEventListener('click', fill);
  $('#inspect').addEventListener('click', inspect);
  $('#learn').addEventListener('click', learn);
  $('#learn-save').addEventListener('click', saveLearned);
  $('#learn-close').addEventListener('click', () => ($('#learn-panel').hidden = true));
  $('#open-options').addEventListener('click', () => openOptions());
  $('#vault-setup').addEventListener('click', () => openOptions('vault'));
  $('#vault-lock').addEventListener('click', async () => (await vault.lock(), renderVault()));
  $('#vault [data-state="locked"]').addEventListener('submit', unlock);
  $('#access-allow').addEventListener('click', allowAccess);
  $('#profile').addEventListener('change', async (e) => {
    await store.setActive(e.target.value);
    $('#result').hidden = true;
  });

  await Promise.all([renderProfiles(), renderVault(), renderAccess()]);
}

init();
