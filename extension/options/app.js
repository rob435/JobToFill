/* JobToFill settings — application log, settings and backup sections. */
import { api, download, el, fillShortcut, isFirefox, openShortcutSettings, plural } from '../ui/common.js';
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
    'Privacy-notice, “I confirm” and “I agree with the terms and conditions” checkboxes. Marketing and talent-pool opt-ins are never ticked. Off: they are left for you.',
  ],
  ['logApplications', 'Keep an application log', 'Remember each job application page you filled.'],
  [
    'accountFlow',
    'Sign in and create job-portal accounts for me',
    'On a sign-in or sign-up page you fill, JobToFill clicks the page’s own “Sign in” or “Create account” (ticking the sign-up form’s terms box), waits for you to solve any “I’m not a robot” check, and fills the code emailed to you. It never submits a job application.',
  ],
  [
    'autoAdvance',
    'Move through multi-step applications for me',
    'On an application in steps (Workday, Oracle, Phenom…), JobToFill clicks the step’s own “Next” or “Save and Continue” once everything on it is filled, then fills the next step. It stops at anything left for you (a required box, the terms, an error) and before the step that submits: that is always yours. Each step is saved with the employer’s site as you go, as when you click “Next” yourself.',
  ],
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
  const shortcut = (await fillShortcut()) || 'not set';
  const where = isFirefox ? 'about:addons → ⚙ → Manage Extension Shortcuts' : 'chrome://extensions/shortcuts';

  return [
    sectionHead('Settings'),
    group('Filling', null, el('div', { className: 'stack' }, TOGGLES.map(toggle))),
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

/** Automatic backup: the file the background keeps in Downloads/JobToFill, and its status. */
async function autoBackupGroup(saveNow) {
  const settings = await store.getSettings();
  const status = el('p', { className: 'muted', id: 'backup-status' });
  const show = el('button', { type: 'button', className: 'small ghost', textContent: 'Show file', hidden: true });

  const describe = async () => {
    const info = await store.getBackupInfo();
    if (info.error && (!info.at || info.errorAt > info.at)) {
      status.className = 'error';
      status.textContent = `The last backup failed: ${info.error}`;
    } else if (info.at) {
      status.className = 'muted';
      status.textContent = `Last saved ${new Date(info.at).toLocaleString()} to ${info.path}`;
    } else {
      status.className = 'muted';
      status.textContent = 'Nothing saved yet: the file is written once your profile has something in it.';
    }
    show.hidden = !info.at;
  };
  show.onclick = async () => {
    const [item] = (await api.downloads.search({ orderBy: ['-startTime'] })).filter(store.isBackupDownload);
    if (item) api.downloads.show(item.id);
  };
  const now = el('button', {
    type: 'button',
    className: 'small',
    textContent: 'Back up now',
    onclick: async () => {
      await saveNow();
      status.className = 'muted';
      status.textContent = 'Saving…';
      const r = await api.runtime.sendMessage({ type: 'jtf:backup' });
      if (r && r.skipped) status.textContent = 'Nothing to back up yet: fill in your profile first.';
      else await describe();
    },
  });
  await describe();

  return group(
    'Automatic backup',
    'Removing JobToFill from the browser deletes everything it stored (and Firefox removes temporary add-ons when it restarts). With this on, a copy is kept up to date in your Downloads folder, and JobToFill offers to restore it when it starts out empty.',
    el(
      'div',
      { className: 'stack' },
      el(
        'label',
        { className: 'check top' },
        el('input', {
          type: 'checkbox',
          name: 'autoBackup',
          checked: settings.autoBackup !== false,
          onchange: (e) => store.saveSettings({ autoBackup: e.target.checked }),
        }),
        el(
          'span',
          {},
          el('strong', { textContent: 'Keep a backup file up to date' }),
          el('br'),
          el('span', {
            className: 'muted',
            textContent:
              'Downloads › JobToFill › jobtofill-backup.json, saved half a minute after a change. It holds your passwords and cards too, unencrypted.',
          }),
        ),
      ),
      status,
      el('div', { className: 'row' }, now, show),
    ),
  );
}

export async function renderBackup({ saveNow, reload }) {
  const include = { documents: true, passwords: true, history: true };
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
      await store.setBackupInfo({ paused: false, dismissed: true, previous: null });
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
      'Keep your details safe when JobToFill is removed or re-added, or move them to another browser. Backups are plain JSON, passwords and cards included: keep the file somewhere only you can open.',
    ),
    await autoBackupGroup(saveNow),
    group(
      'Export',
      null,
      el(
        'div',
        { className: 'stack' },
        check('documents', 'Include resume and cover-letter files'),
        check('passwords', 'Include passwords and cards'),
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
