/* JobToFill settings — the "Passwords & cards" section. */
import { api, el } from '../ui/common.js';
import { grid, group, sectionHead, secretInput, table } from './controls.js';

const { store, passwords, util, fields } = globalThis.JTF;

const INTRO =
  'Kept in this browser’s extension storage and in your backup file, unencrypted, like your AI keys. ' +
  'They are only filled on HTTPS pages, only into visible fields, and only when you start a fill.';

const labelled = (label, ...controls) =>
  el('label', { className: 'field' }, el('span', { textContent: label }), ...controls);
const last4 = (number) =>
  String(number || '')
    .replace(/\D/g, '')
    .slice(-4);
const masked = (number) => (last4(number) ? '•••• ' + last4(number) : '');

/* ---------------------------------------------------------- typed edits */

// What is typed into a saved login or the default password is saved as you type, not only when the box loses focus
// (a "change" never comes when the tab is closed straight after typing), and without drawing the section again
// under your cursor. `typed`: the edits not written yet, by credential id (DEFAULT for the default password).
const DEFAULT = Symbol('default password');
const typed = new Map();
let typingTimer = null;
// The passwords as last seen stored, for the write made as the page closes (see flushOnHide).
let stored = null;

/** Put typed edits into passwords data `d`. */
function applyTyped(d, edits) {
  for (const [id, patch] of edits) {
    if (id === DEFAULT) Object.assign(d, patch);
    else {
      const target = (d.credentials || []).find((x) => x.id === id);
      if (target) Object.assign(target, patch, { updatedAt: Date.now() });
    }
  }
}

/** Write what was typed; a box typed in again meanwhile is written next time. */
async function writeTyped() {
  clearTimeout(typingTimer);
  const edits = [...typed];
  if (!edits.length) return;
  await passwords.update((d) => applyTyped(d, edits));
  for (const [id, patch] of edits) if (typed.get(id) === patch) typed.delete(id);
}

/** Note an edit as it is typed, written half a second after the last key. */
function onType(id, patch) {
  typed.set(id, { ...typed.get(id), ...patch });
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => writeTyped().catch(() => {}), 500);
}

/**
 * The page closing: edits not written yet are kept. A write that reads storage first never lands, as the page is
 * gone before the read comes back: Chromium takes one write onto the passwords as last seen stored, Firefox (which
 * drops that) a message to the background (keepEdits).
 */
function flushOnHide() {
  if (!typed.size) return;
  const edits = [...typed];
  typed.clear();
  if (stored) {
    const d = structuredClone(stored);
    applyTyped(d, edits);
    passwords.write(d).catch(() => {});
  }
  const logins = edits.filter(([id]) => id !== DEFAULT).map(([id, patch]) => ({ id, ...patch }));
  const fallback = edits.find(([id]) => id === DEFAULT);
  api.runtime
    .sendMessage({ type: 'jtf:keep', logins, ...(fallback ? { defaultPassword: fallback[1].defaultPassword } : {}) })
    .catch(() => {});
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') writeTyped().catch(() => {});
});
window.addEventListener('pagehide', flushOnHide);
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.passwords) stored = changes.passwords.newValue || null;
});

/** Passwords an older version kept in its encrypted vault: moved over once, with that vault's master password. */
function legacyGroup(refresh) {
  const pw = el('input', { type: 'password', name: 'legacyMaster', autocomplete: 'current-password' });
  const error = el('p', { className: 'error' });
  const move = el('button', { className: 'primary', type: 'submit', textContent: 'Move them over' });
  const submit = async (e) => {
    e.preventDefault();
    error.textContent = '';
    move.disabled = true;
    try {
      await passwords.importLegacy(pw.value);
      refresh();
    } catch (err) {
      error.textContent = err.message;
      pw.select();
    } finally {
      move.disabled = false;
    }
  };
  const discard = async () => {
    if (!confirm('Delete the old vault and every password and card still in it? This cannot be undone.')) return;
    await passwords.discardLegacy();
    refresh();
  };
  return group(
    null,
    null,
    el(
      'form',
      { className: 'callout warn stack', onsubmit: submit },
      el('span', {
        textContent:
          'Your passwords are still in the old encrypted vault. Enter its master password once to move them over.',
      }),
      el(
        'div',
        { className: 'inline-form' },
        labelled('Master password', pw),
        move,
        el('button', { type: 'button', textContent: 'Discard old vault', onclick: discard }),
      ),
      error,
    ),
  );
}

function signupGroup(data, settings, save) {
  const strategies = [
    ['generate', 'Generate a unique password for every site and save it here (recommended)'],
    ['default', 'Use my default password everywhere'],
  ];
  const strategy = el(
    'div',
    { className: 'stack' },
    strategies.map(([value, label]) =>
      el(
        'label',
        { className: 'check' },
        el('input', {
          type: 'radio',
          name: 'passwordStrategy',
          value,
          checked: settings.passwordStrategy === value,
          onchange: () => store.saveSettings({ passwordStrategy: value }),
        }),
        label,
      ),
    ),
  );
  const fallback = secretInput(data.defaultPassword, (v) => save((d) => (d.defaultPassword = v)), 'defaultPassword');
  fallback.input.addEventListener('input', () => onType(DEFAULT, { defaultPassword: fallback.input.value }));
  fallback.row.append(
    el('button', {
      type: 'button',
      className: 'small',
      textContent: 'Generate',
      onclick: () => {
        fallback.input.value = passwords.generatePassword();
        fallback.input.type = 'text';
        fallback.input.dispatchEvent(new Event('change'));
      },
    }),
  );
  return group(
    'Sign-up forms',
    'Job portals like Workday make you create an account for every employer. JobToFill fills “create password” and “confirm password” boxes for you.',
    strategy,
    el(
      'label',
      { className: 'field spaced' },
      el('span', { textContent: 'Default password' }),
      fallback.row,
      el('small', { textContent: 'Only used when “Use my default password everywhere” is chosen.' }),
    ),
  );
}

function loginsGroup(data, profile, save) {
  const rows = data.credentials
    .slice()
    .sort((a, b) => a.host.localeCompare(b.host))
    .map((c) => {
      const edit = (patch) =>
        save((d) => {
          const target = d.credentials.find((x) => x.id === c.id);
          if (target) Object.assign(target, patch, { updatedAt: Date.now() });
        });
      const secret = secretInput(c.password, (password) => edit({ password }), '', `Password for ${c.host}`);
      secret.input.addEventListener('input', () => onType(c.id, { password: secret.input.value }));
      const user = el('input', {
        value: c.username || '',
        autocomplete: 'off',
        attrs: { 'aria-label': `Username for ${c.host}` },
        onchange: () => edit({ username: user.value.trim() }),
        oninput: () => onType(c.id, { username: user.value.trim() }),
      });
      const remove = () => {
        if (confirm(`Delete the saved password for ${c.host}?`))
          save((d) => (d.credentials = d.credentials.filter((x) => x.id !== c.id)));
      };
      return el(
        'tr',
        {},
        el('td', { className: 'mono', textContent: c.host }),
        el('td', {}, user),
        el('td', {}, secret.row),
        el(
          'td',
          {},
          el('button', {
            type: 'button',
            className: 'small danger',
            textContent: 'Delete',
            attrs: { 'aria-label': `Delete the login for ${c.host}` },
            onclick: remove,
          }),
        ),
      );
    });

  const host = el('input', { name: 'newHost', placeholder: 'careers.example.com' });
  const user = el('input', { name: 'newUser', placeholder: profile.contact.email || 'you@example.com' });
  const pass = secretInput('', null, 'newPass');
  pass.row.append(
    el('button', {
      type: 'button',
      className: 'small',
      textContent: 'Generate',
      onclick: () => {
        pass.input.value = passwords.generatePassword();
        pass.input.type = 'text';
      },
    }),
  );
  const add = (e) => {
    e.preventDefault();
    const site = host.value
      .trim()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '');
    if (!site || !pass.input.value) return;
    const now = Date.now();
    save((d) => {
      d.credentials.push({
        id: util.uid(),
        host: site,
        username: user.value.trim() || profile.contact.email,
        password: pass.input.value,
        createdAt: now,
        updatedAt: now,
      });
    });
  };

  return group(
    `Saved logins (${data.credentials.length})`,
    'Filled on login pages for the matching site. A saved “example.com” also matches “careers.example.com”.',
    rows.length
      ? table(['Site', 'Username', 'Password', ''], rows)
      : el('p', { className: 'empty', textContent: 'No saved logins yet.' }),
    el(
      'form',
      { className: 'inline-form spaced', onsubmit: add },
      labelled('Site', host),
      labelled('Username / email', user),
      labelled('Password', pass.row),
      el('button', { type: 'submit', textContent: 'Add login' }),
    ),
  );
}

function cardsGroup(data, profile, save) {
  const selected = data.defaultCardId || (data.cards[0] && data.cards[0].id);
  const rows = data.cards.map((c) => {
    const remove = () => {
      if (!confirm('Delete this card?')) return;
      save((d) => {
        d.cards = d.cards.filter((x) => x.id !== c.id);
        if (d.defaultCardId === c.id) d.defaultCardId = null;
      });
    };
    return el(
      'tr',
      {},
      el(
        'td',
        {},
        el('input', {
          type: 'radio',
          name: 'defaultCard',
          checked: selected === c.id,
          title: 'Use this card',
          attrs: {
            'aria-label': `Use ${c.label || fields.cardBrand(c.number) || 'the card'} ending ${last4(c.number)}`,
          },
          onchange: () => save((d) => (d.defaultCardId = c.id)),
        }),
      ),
      el('td', { textContent: c.label || fields.cardBrand(c.number) || 'Card' }),
      el('td', { textContent: c.name }),
      el('td', { className: 'mono', textContent: masked(c.number) }),
      el('td', { className: 'mono', textContent: `${util.pad2(c.expMonth)}/${String(c.expYear).slice(-2)}` }),
      el(
        'td',
        {},
        el('button', {
          type: 'button',
          className: 'small danger',
          textContent: 'Delete',
          attrs: { 'aria-label': `Delete the card ending ${last4(c.number)}` },
          onclick: remove,
        }),
      ),
    );
  });

  const input = (name, props) => el('input', { name, autocomplete: 'off', ...props });
  const card = {
    label: input('cardLabel', { placeholder: 'Personal Visa' }),
    name: input('cardName', {
      value: [profile.personal.firstName, profile.personal.lastName].filter(Boolean).join(' '),
    }),
    number: input('cardNumber', { inputMode: 'numeric', placeholder: '4242 4242 4242 4242' }),
    expMonth: input('cardExpMonth', { inputMode: 'numeric', placeholder: 'MM', maxLength: 2 }),
    expYear: input('cardExpYear', { inputMode: 'numeric', placeholder: 'YYYY', maxLength: 4 }),
    cvc: input('cardCvc', { inputMode: 'numeric', placeholder: 'Optional', maxLength: 4 }),
  };
  const error = el('p', { className: 'error' });
  const add = (e) => {
    e.preventDefault();
    const number = card.number.value.replace(/\D/g, '');
    const expMonth = parseInt(card.expMonth.value, 10);
    let expYear = parseInt(card.expYear.value, 10);
    if (expYear < 100) expYear += 2000;
    if (number.length < 12 || !(expMonth >= 1 && expMonth <= 12) || !(expYear >= 2000)) {
      error.textContent = 'Check the card number and expiry.';
      return;
    }
    save((d) => {
      const id = util.uid();
      d.cards.push({
        id,
        label: card.label.value.trim(),
        name: card.name.value.trim(),
        number,
        expMonth,
        expYear,
        cvc: card.cvc.value.trim(),
      });
      if (!d.defaultCardId) d.defaultCardId = id;
    });
  };
  const labels = {
    label: 'Nickname',
    name: 'Name on card',
    number: 'Card number',
    expMonth: 'Expiry month',
    expYear: 'Expiry year',
    cvc: 'Security code',
  };

  return group(
    `Payment cards (${data.cards.length})`,
    'The selected card fills checkout forms, including card fields inside payment providers’ secure frames (Stripe, Adyen, Braintree…).',
    rows.length
      ? table(['Use', 'Card', 'Name', 'Number', 'Expires', ''], rows)
      : el('p', { className: 'empty', textContent: 'No cards yet.' }),
    el(
      'form',
      { className: 'stack spaced', onsubmit: add },
      grid(Object.entries(labels).map(([key, label]) => labelled(label, card[key]))),
      error,
      el('div', { className: 'row' }, el('button', { type: 'submit', textContent: 'Add card' })),
    ),
  );
}

export async function renderPasswords({ state, refresh }) {
  const data = await passwords.read();
  stored = structuredClone(data);
  const settings = await store.getSettings();
  const save = async (fn) => {
    await passwords.update(fn);
    refresh();
  };
  return [
    sectionHead('Passwords & cards', INTRO),
    (await passwords.legacy()) ? legacyGroup(refresh) : null,
    signupGroup(data, settings, save),
    loginsGroup(data, state.profile, save),
    cardsGroup(data, state.profile, save),
  ];
}
