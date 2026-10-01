/* JobToFill settings — application log, settings and backup sections. */
import { download, el, fillShortcut, isFirefox, openShortcutSettings, plural } from '../ui/common.js';
import { group, sectionHead, table } from './controls.js';

const { store } = globalThis.JTF;

/* ------------------------------------------------------------ history */

function toCsv(history) {
  const cell = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const header = ['Date', 'Title', 'URL', 'Site', 'Fields filled', 'Profile'];
  const rows = history.map((h) => [new Date(h.date).toISOString(), h.title, h.url, h.host, h.filled, h.profile]);
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\n');
}

export async function renderHistory({ refresh }) {
  const history = await store.getHistory();
  const rows = history.map((h) =>
    el(
      'tr',
      {},
      el('td', { textContent: new Date(h.date).toLocaleString() }),
      el(
        'td',
        {},
        /^https?:\/\//.test(h.url || '')
          ? el('a', { href: h.url, target: '_blank', rel: 'noopener', textContent: h.title || h.url })
          : h.title || '',
      ),
      el('td', { className: 'mono', textContent: h.host }),
      el('td', { textContent: String(h.filled) }),
      el('td', { textContent: h.profile || '' }),
    ),
  );
  const clear = async () => {
    if (!confirm('Clear the application log?')) return;
    await store.clearHistory();
    refresh();
  };
  return [
    sectionHead(
      'Application log',
      'Every job application page you filled, so you can keep track of where you applied. Stored only in this browser.',
    ),
    group(
      plural(history.length, 'application'),
      null,
      rows.length
        ? table(['When', 'Page', 'Site', 'Fields', 'Profile'], rows)
        : el('p', { className: 'empty', textContent: 'Nothing yet. Fill a job application and it will show up here.' }),
      el(
        'div',
        { className: 'row spaced' },
        el('button', {
          type: 'button',
          textContent: 'Export CSV',
          disabled: !rows.length,
          onclick: () => download(new Blob([toCsv(history)], { type: 'text/csv' }), 'jobtofill-applications.csv'),
        }),
        el('button', {
          type: 'button',
          className: 'danger',
          textContent: 'Clear log',
          disabled: !rows.length,
          onclick: clear,
        }),
      ),
    ),
  ];
}

/* ----------------------------------------------------------- settings */

const TOGGLES = [
  [
    'overwrite',
    'Overwrite fields that already have a value',
    'Off: only empty fields are filled, so nothing you typed gets replaced.',
  ],
  ['highlight', 'Highlight filled fields', 'Outlines each field JobToFill filled until you click into it.'],
  ['toast', 'Show a summary on the page', 'After filling with the keyboard shortcut or right-click menu.'],
  [
    'comboboxes',
    'Operate custom dropdowns',
    'Opens searchable dropdowns (Workday, Greenhouse, react-select…) and picks the matching option.',
  ],
  [
    'consents',
    'Tick acknowledgement boxes',
    'Privacy-notice and “I confirm” checkboxes. Marketing and talent-pool opt-ins are never ticked. Off: they are left for you.',
  ],
  ['logApplications', 'Keep an application log', 'Remember each job application page you filled.'],
];

// prettier-ignore
const LOCK_AFTER = [
  [5, '5 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 hour'], [240, '4 hours'], [0, 'Only when the browser closes'],
];

export async function renderSettings() {
  const settings = await store.getSettings();
  const toggle = ([key, label, hint]) =>
    el(
      'label',
      { className: 'check top' },
      el('input', {
        type: 'checkbox',
        name: key,
        checked: !!settings[key],
        onchange: (e) => store.saveSettings({ [key]: e.target.checked }),
      }),
      el(
        'span',
        {},
        el('strong', { textContent: label }),
        el('br'),
        el('span', { className: 'muted', textContent: hint }),
      ),
    );
  const lock = el(
    'select',
    { name: 'autoLockMinutes', onchange: (e) => store.saveSettings({ autoLockMinutes: +e.target.value }) },
    LOCK_AFTER.map(([value, label]) =>
      el('option', { value: String(value), textContent: label, selected: settings.autoLockMinutes === value }),
    ),
  );
  const shortcut = (await fillShortcut()) || 'not set';
  const where = isFirefox ? 'about:addons → ⚙ → Manage Extension Shortcuts' : 'chrome://extensions/shortcuts';

  return [
    sectionHead('Settings'),
    group('Filling', null, el('div', { className: 'stack' }, TOGGLES.map(toggle))),
    group(
      'Vault',
      null,
      el('label', { className: 'field narrow' }, el('span', { textContent: 'Lock the vault after inactivity' }), lock),
    ),
    group(
      'Keyboard shortcut',
      null,
      el(
        'p',
        {},
        'Fill the current page: ',
        el('kbd', { textContent: shortcut }),
        ' — ',
        el('button', {
          type: 'button',
          className: 'link',
          textContent: 'change shortcut',
          title: where,
          onclick: openShortcutSettings,
        }),
      ),
      el(
        'p',
        { className: 'muted' },
        'You can also right-click any page or field: “Fill this page”, “Insert from profile” and “Generate strong password”.',
      ),
    ),
  ];
}

/* ------------------------------------------------------------- backup */

export function renderBackup({ saveNow, reload }) {
  const include = { documents: true, vault: true, history: true };
  const check = (key, label) =>
    el(
      'label',
      { className: 'check' },
      el('input', { type: 'checkbox', checked: true, onchange: (e) => (include[key] = e.target.checked) }),
      label,
    );
  const message = el('p');
  const picker = el('input', { type: 'file', accept: 'application/json,.json', hidden: true, name: 'import' });

  picker.addEventListener('change', async () => {
    const file = picker.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!confirm('Replace your current profiles and settings with this backup?')) return;
      await store.importData(data);
      await reload();
    } catch (err) {
      message.className = 'error';
      message.textContent = err.message;
    }
  });

  const exportBackup = async () => {
    await saveNow();
    const data = await store.exportData(include);
    const name = `jobtofill-backup-${new Date().toISOString().slice(0, 10)}.json`;
    download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), name);
  };

  return [
    sectionHead(
      'Backup & restore',
      'Move your profiles to another browser or keep a copy. Backups are plain JSON; the vault inside stays encrypted with your master password.',
    ),
    group(
      'Export',
      null,
      el(
        'div',
        { className: 'stack' },
        check('documents', 'Include resume and cover-letter files'),
        check('vault', 'Include the encrypted vault'),
        check('history', 'Include the application log'),
        el(
          'div',
          { className: 'row' },
          el('button', { type: 'button', className: 'primary', textContent: 'Download backup', onclick: exportBackup }),
        ),
      ),
    ),
    group(
      'Restore',
      'Replaces all profiles and settings in this browser.',
      el('button', { type: 'button', textContent: 'Choose backup file…', onclick: () => picker.click() }),
      picker,
      message,
    ),
  ];
}
