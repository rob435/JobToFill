/* JobToFill settings — verification codes from email, read through Nylas. */
import { el } from '../ui/common.js';
import { grid, group, sectionHead } from './controls.js';

const { store, nylas } = globalThis.JTF;

async function connectionGroup(refresh) {
  const saved = (await store.getNylas()) || { region: 'us' };
  const status = el('span', { className: 'muted', attrs: { 'aria-live': 'polite' } });
  const key = el('input', {
    type: 'password',
    name: 'nylas-key',
    value: saved.apiKey || '',
    autocomplete: 'off',
    spellcheck: false,
    placeholder: 'nyk_v0_…',
  });
  const region = el(
    'select',
    { name: 'nylas-region' },
    Object.entries(nylas.REGIONS).map(([id, r]) => el('option', { value: id, textContent: r.label })),
  );
  region.value = saved.region || 'us';
  const inbox = el('select', { name: 'nylas-grant', hidden: true });
  const inboxField = el(
    'label',
    { className: 'field wide', hidden: true },
    el('span', { textContent: 'Inbox' }),
    inbox,
  );

  const describe = (n) =>
    n && n.grantId
      ? `Connected: codes are read from ${n.email || 'your inbox'}.`
      : n && n.apiKey
        ? 'Key saved. Click “Connect” to choose the inbox.'
        : '';
  status.textContent = describe(saved);

  /** Check the key, list the connected inboxes and keep the chosen (or only) one. */
  const connect = async () => {
    const apiKey = key.value.trim();
    if (!apiKey) {
      await store.setNylas(null);
      status.textContent = 'Removed.';
      inboxField.hidden = true;
      return;
    }
    status.textContent = 'Connecting…';
    let list;
    try {
      list = await nylas.grants({ apiKey, region: region.value });
    } catch (err) {
      // A key from the other region is rejected: try it there before giving up.
      const other = region.value === 'us' ? 'eu' : 'us';
      if (err.code !== 'key') return (status.textContent = err.message);
      try {
        list = await nylas.grants({ apiKey, region: other });
        region.value = other;
      } catch (err2) {
        return (status.textContent = err.message);
      }
    }
    const usable = list.filter((g) => !g.status || g.status === 'valid');
    if (!usable.length) {
      await store.setNylas({ apiKey, region: region.value, grantId: '', email: '' });
      status.textContent =
        'The key works, but no inbox is connected to this Nylas app yet. In the Nylas dashboard open Grants › Add test grant, sign in to your email, then click Connect again.';
      return;
    }
    const keep = usable.find((g) => g.id === saved.grantId) || usable[0];
    inbox.replaceChildren(...usable.map((g) => el('option', { value: g.id, textContent: g.email || g.id })));
    inbox.value = keep.id;
    inbox.hidden = inboxField.hidden = usable.length < 2;
    const next = await store.setNylas({ apiKey, region: region.value, grantId: keep.id, email: keep.email });
    Object.assign(saved, next);
    status.textContent = describe(next);
  };

  inbox.addEventListener('change', async () => {
    const email = inbox.selectedOptions[0] ? inbox.selectedOptions[0].textContent : '';
    const next = await store.setNylas({ grantId: inbox.value, email });
    status.textContent = describe(next);
  });
  key.addEventListener('change', connect);
  region.addEventListener('change', () => key.value.trim() && connect());

  const test = async () => {
    const n = await store.getNylas();
    if (!n || !n.grantId) return connect();
    status.textContent = 'Checking…';
    try {
      const list = await nylas.messages(n, { since: Date.now() - 7 * 86400e3, limit: 1 });
      status.textContent = `Works: read ${n.email || 'your inbox'}${list[0] ? ` (latest: “${list[0].subject || 'no subject'}”)` : ''}.`;
    } catch (err) {
      status.textContent = err.message;
    }
  };

  return group(
    'Connect your inbox',
    'Sites that email you a code each time you sign in or create an account get it typed in for you. JobToFill reads your newest emails through Nylas with your own API key; the key and the emails stay in this browser (and your own backup file).',
    el(
      'ol',
      { className: 'steps' },
      el(
        'li',
        {},
        'Sign up at ',
        el('a', {
          href: 'https://dashboard-v3.nylas.com',
          target: '_blank',
          rel: 'noopener',
          textContent: 'dashboard-v3.nylas.com',
        }),
        ' (free) and create an app.',
      ),
      el('li', { textContent: 'Grants › Add test grant: sign in to the email you apply with.' }),
      el('li', { textContent: 'API Keys › Generate new key, and paste it below.' }),
    ),
    grid(
      el('label', { className: 'field wide' }, el('span', { textContent: 'Nylas API key' }), key),
      el('label', { className: 'field' }, el('span', { textContent: 'Data region' }), region),
      inboxField,
    ),
    el(
      'div',
      { className: 'row spaced' },
      el('button', { type: 'button', textContent: 'Connect', onclick: connect }),
      el('button', { type: 'button', className: 'ghost', textContent: 'Test', onclick: test }),
      status,
    ),
  );
}

async function behaviourGroup() {
  const settings = await store.getSettings();
  const otp = store.otpSettings(settings);
  const toggle = (name, label, hint) =>
    el(
      'label',
      { className: 'check top' },
      el('input', {
        type: 'checkbox',
        name: 'otp-' + name,
        checked: otp[name] !== false,
        onchange: async (e) => {
          otp[name] = e.target.checked;
          await store.saveSettings({ otp: { ...otp } });
        },
      }),
      el(
        'span',
        {},
        el('strong', { textContent: label }),
        el('br'),
        el('span', { className: 'muted', textContent: hint }),
      ),
    );
  return group(
    'What it does',
    null,
    el(
      'div',
      { className: 'stack' },
      toggle(
        'auto',
        'Fill codes by themselves',
        'When a page asks for “the code we emailed you”, JobToFill waits for that email and types the code in. Otherwise it only looks when you fill the page or right-click the box › “Insert verification code from email”.',
      ),
      toggle(
        'links',
        'Open “verify your email” links',
        'When a page says it sent you a link to confirm your email, the link from that site’s email opens in a new tab.',
      ),
    ),
    el(
      'p',
      { className: 'muted' },
      'Codes are only filled from an email that clearly comes from the site asking (the same domain, the same job portal such as Workday, or an email that links back to it), and only on secure pages. A code from anyone else is offered with a “Use it” button instead, so a look-alike page can’t pick up a code meant for another account. Nothing is ever submitted for you.',
    ),
  );
}

export async function renderEmail({ refresh }) {
  return [
    sectionHead(
      'Email codes',
      'Job portals ask for an account, then for a code from your inbox, again and again. Connect your inbox once and those codes fill themselves.',
    ),
    await connectionGroup(refresh),
    await behaviourGroup(),
  ];
}
