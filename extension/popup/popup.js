/* JobToFill — toolbar popup. */
import {
  $,
  $$,
  api,
  el,
  fillShortcut,
  hasAiConsent,
  hasSiteAccess,
  plural,
  requestAiConsent,
  requestSiteAccess,
} from '../ui/common.js';

const { store, vault, util, ai } = globalThis.JTF;

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
    r.ai && r.ai.filled
      ? resultLine(
          `AI filled ${r.ai.filled} — check ${r.ai.filled === 1 ? 'it' : 'them'}:`,
          r.ai.items.map((i) => `${i.label} → ${i.answer}`),
        )
      : null,
    r.ai && r.ai.error ? el('p', { className: 'result-list', textContent: 'AI help: ' + r.ai.error }) : null,
    r.consents ? consentLine(r.consents) : null,
    r.letter
      ? el('p', {
          className: 'result-list',
          textContent: `Used the cover letter you wrote for ${r.letter.company || 'this job'}.`,
        })
      : r.wantsLetter
        ? el(
            'p',
            { className: 'result-list' },
            'This form asks for a cover letter. ',
            el('button', {
              className: 'link',
              type: 'button',
              textContent: 'Write one for this job',
              onclick: writeLetter,
            }),
          )
        : null,
    ...r.notes.map((note) => el('p', { className: 'result-list', textContent: note })),
    actions.children.length ? actions : null,
  );
}

/** "Privacy notice" style checkboxes are left alone unless the person opts in, right here or in settings. */
function consentLine(n) {
  return el(
    'p',
    { className: 'result-list' },
    `${n === 1 ? 'One acknowledgement box is' : `${n} acknowledgement boxes are`} left for you to tick. `,
    el('button', {
      className: 'link',
      type: 'button',
      textContent: 'Always tick these',
      title:
        'Tick privacy-notice and “I confirm” boxes from now on (never marketing opt-ins). You can turn this off in settings.',
      onclick: async () => {
        await store.saveSettings({ consents: true });
        await fill();
      },
    }),
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

/** The cover letter studio, for the application in this tab. */
function writeLetter() {
  api.tabs.create({ url: api.runtime.getURL('studio/studio.html') + '?tab=' + tab.id });
  window.close();
}

/* ---------------------------------------------------------- quick apply */

const QUICK_STALE = 15 * 60e3;

/** The status line under the buttons, and the small "Last quick apply" tab when a result is kept. */
async function renderQuick() {
  const [status, record] = await Promise.all([store.getQuickStatus(), store.getQuickApply()]);
  $('#quick-last').hidden = !record;
  const line = $('#quick-status');
  const mine = status && tab && status.tabId === tab.id && Date.now() - status.at < QUICK_STALE;
  line.hidden = !mine;
  line.classList.toggle('error', !!mine && status.state === 'error');
  if (mine)
    line.textContent =
      status.state === 'running'
        ? `Quick apply: ${status.message}`
        : status.state === 'done'
          ? `Quick apply ${status.message}. Review before submitting.`
          : status.message;
  $('#quick-apply').disabled = !!mine && status.state === 'running';
}

/**
 * Quick apply: everything the application needs, without stopping to ask. The AI work runs in a background
 * tab (the studio page) that the background opens. If the AI key, its consent or site access is missing, the
 * normal studio opens instead so its setup cards can ask. The consent prompt must come straight from the click.
 */
async function quickApply() {
  const consent = requestAiConsent();
  const line = $('#quick-status');
  line.hidden = false;
  line.classList.remove('error');
  line.textContent = 'Quick apply: starting…';
  const [granted, access, config] = await Promise.all([consent, hasSiteAccess(), store.aiConfig()]);
  if (!granted || !access || ai.problem(config) || !(await hasAiConsent())) return writeLetter();
  const r = await send({ type: 'jtf:quick-start' });
  if (r && r.error) {
    line.classList.add('error');
    line.textContent = r.error;
  } else await renderQuick();
}

function showQuickError(err) {
  const line = $('#quick-status');
  line.hidden = false;
  line.classList.add('error');
  line.textContent = String((err && err.message) || err);
}

function openLastQuick() {
  api.tabs.create({ url: api.runtime.getURL('quick/quick.html') });
  window.close();
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
    for (const id of ['#fill', '#inspect', '#learn', '#write-letter', '#quick-apply']) $(id).disabled = true;
    $('#page-note').hidden = false;
  }

  $('#fill').addEventListener('click', fill);
  const assistBox = $('#ai-assist');
  assistBox.checked = (await store.getSettings()).aiAssist !== false;
  assistBox.addEventListener('change', () => store.saveSettings({ aiAssist: assistBox.checked }));
  $('#write-letter').addEventListener('click', writeLetter);
  $('#quick-apply').addEventListener('click', () => quickApply().catch((err) => showQuickError(err)));
  $('#quick-last').addEventListener('click', openLastQuick);
  const onStorage = (changes) => (changes.quickStatus || changes.quickApply) && renderQuick();
  api.storage.onChanged.addListener(onStorage);
  $('#inspect').addEventListener('click', inspect);
  $('#learn').addEventListener('click', learn);
  $('#learn-save').addEventListener('click', saveLearned);
  $('#learn-close').addEventListener('click', () => ($('#learn-panel').hidden = true));
  $('#open-options').addEventListener('click', () => openOptions());
  $('#vault-setup').addEventListener('click', () => openOptions('vault'));
  $('#vault-lock').addEventListener('click', async () => (await vault.lock(), renderVault()));
  $('#vault [data-state="locked"]').addEventListener('submit', unlock);
  $('#access-allow').addEventListener('click', allowAccess);
  $('#restore-open').addEventListener('click', () => openOptions('backup'));
  $('#profile').addEventListener('change', async (e) => {
    await store.setActive(e.target.value);
    $('#result').hidden = true;
  });

  // After a re-add, the background found the old backup file and is waiting for a restore.
  $('#restore').hidden = !(await store.getBackupInfo()).paused;

  await Promise.all([renderProfiles(), renderVault(), renderAccess(), renderQuick()]);
}

init();
