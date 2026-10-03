/* JobToFill settings — the "Passwords & cards" section. */
import { el } from '../ui/common.js';
import { grid, group, sectionHead, secretInput, table } from './controls.js';

const { store, vault, util, fields } = globalThis.JTF;

const INTRO =
  'An encrypted vault (AES-256-GCM, key derived from your master password with PBKDF2). ' +
  'Secrets are only filled on HTTPS pages, only into visible fields, and only when you start a fill.';

const labelled = (label, ...controls) =>
  el('label', { className: 'field' }, el('span', { textContent: label }), ...controls);
const masked = (number) => {
  const digits = String(number || '').replace(/\D/g, '');
  return digits ? '•••• ' + digits.slice(-4) : '';
};

async function confirmReset(refresh) {
  if (!confirm('Delete every saved password and card? This cannot be undone.')) return;
  await vault.reset();
  refresh();
}

/* ------------------------------------------------------------ not set up */

function setupForm(refresh) {
  const pw = el('input', { type: 'password', name: 'master', autocomplete: 'new-password' });
  const pw2 = el('input', { type: 'password', name: 'master2', autocomplete: 'new-password' });
  const error = el('p', { className: 'error' });
  const submit = async (e) => {
    e.preventDefault();
    error.textContent = '';
    if (pw.value !== pw2.value) {
      error.textContent = 'The passwords don’t match.';
      return;
    }
    try {
      await vault.setup(pw.value);
      refresh();
    } catch (err) {
      error.textContent = err.message;
    }
  };
  const form = el(
    'form',
    { className: 'stack', onsubmit: submit },
    grid(labelled('Master password', pw), labelled('Repeat master password', pw2)),
    error,
    el(
      'div',
      { className: 'row' },
      el('button', { className: 'primary', type: 'submit', textContent: 'Create vault' }),
    ),
  );
  return group(
    'Create your vault',
    'Pick something long that you don’t use anywhere else. It can’t be recovered: if you forget it you can only reset the vault and start again.',
    form,
  );
}

/* ---------------------------------------------------------------- locked */

function unlockForm(refresh) {
  const pw = el('input', { type: 'password', name: 'master', autocomplete: 'current-password' });
  const error = el('p', { className: 'error' });
  const submit = async (e) => {
    e.preventDefault();
    try {
      await vault.unlock(pw.value);
      // A fill that skipped passwords for the locked vault carries on now.
      globalThis.JTF.api.runtime.sendMessage({ type: 'jtf:vault-unlocked' }).catch(() => {});
      refresh();
    } catch (err) {
      error.textContent = err.message;
      pw.select();
    }
  };
  setTimeout(() => pw.focus(), 0);
  return group(
    'Vault locked',
    null,
    el(
      'form',
      { className: 'inline-form', onsubmit: submit },
      labelled('Master password', pw),
      el('button', { className: 'primary', type: 'submit', textContent: 'Unlock' }),
    ),
    error,
    el(
      'p',
      { className: 'muted' },
      'Forgot it? ',
      el('button', {
        type: 'button',
        className: 'link',
        textContent: 'Reset the vault',
        onclick: () => confirmReset(refresh),
      }),
      ' (deletes all saved passwords and cards).',
    ),
  );
}

/* -------------------------------------------------------------- unlocked */

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
  fallback.row.append(
    el('button', {
      type: 'button',
      className: 'small',
      textContent: 'Generate',
      onclick: () => {
        fallback.input.value = vault.generatePassword();
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
      const secret = secretInput(c.password, (v) =>
        save((d) => {
          const target = d.credentials.find((x) => x.id === c.id);
          if (target) Object.assign(target, { password: v, updatedAt: Date.now() });
        }),
      );
      const remove = () => {
        if (confirm(`Delete the saved password for ${c.host}?`))
          save((d) => (d.credentials = d.credentials.filter((x) => x.id !== c.id)));
      };
      return el(
        'tr',
        {},
        el('td', { className: 'mono', textContent: c.host }),
        el('td', { textContent: c.username || '—' }),
        el('td', {}, secret.row),
        el(
          'td',
          {},
          el('button', { type: 'button', className: 'small danger', textContent: 'Delete', onclick: remove }),
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
        pass.input.value = vault.generatePassword();
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
          onchange: () => save((d) => (d.defaultCardId = c.id)),
        }),
      ),
      el('td', { textContent: c.label || fields.cardBrand(c.number) || 'Card' }),
      el('td', { textContent: c.name }),
      el('td', { className: 'mono', textContent: masked(c.number) }),
      el('td', { className: 'mono', textContent: `${util.pad2(c.expMonth)}/${String(c.expYear).slice(-2)}` }),
      el('td', {}, el('button', { type: 'button', className: 'small danger', textContent: 'Delete', onclick: remove })),
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

function manageGroup(refresh) {
  const next = el('input', { type: 'password', name: 'newMaster', autocomplete: 'new-password' });
  const message = el('span');
  const change = async (e) => {
    e.preventDefault();
    try {
      await vault.changePassword(next.value);
      next.value = '';
      message.className = 'success';
      message.textContent = 'Master password changed.';
    } catch (err) {
      message.className = 'error';
      message.textContent = err.message;
    }
  };
  const lock = async () => {
    await vault.lock();
    refresh();
  };
  return group(
    'Vault',
    null,
    el(
      'div',
      { className: 'row' },
      el('button', { type: 'button', textContent: 'Lock now', onclick: lock }),
      el('button', {
        type: 'button',
        className: 'danger',
        textContent: 'Reset vault',
        onclick: () => confirmReset(refresh),
      }),
    ),
    el(
      'form',
      { className: 'inline-form spaced', onsubmit: change },
      labelled('New master password', next),
      el('button', { type: 'submit', textContent: 'Change' }),
      message,
    ),
  );
}

export async function renderVault({ state, refresh }) {
  const head = sectionHead('Passwords & cards', INTRO);
  const status = await vault.status();
  if (status === 'none') return [head, setupForm(refresh)];
  if (status === 'locked') return [head, unlockForm(refresh)];

  const data = await vault.read();
  const settings = await store.getSettings();
  const save = async (fn) => {
    await vault.update(fn);
    refresh();
  };
  return [
    head,
    signupGroup(data, settings, save),
    loginsGroup(data, state.profile, save),
    cardsGroup(data, state.profile, save),
    manageGroup(refresh),
  ];
}
