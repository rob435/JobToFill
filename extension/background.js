/*
 * JobToFill — background (service worker in Chromium, event page in Firefox).
 * Owns everything that needs privileges: injecting the content scripts on
 * demand, running a fill across all frames, handing out vault secrets (only to
 * the frame being filled, only over HTTPS), the keyboard shortcut, context
 * menus and vault auto-lock.
 */
// Chromium loads the libraries here; Firefox lists them in manifest.json "background.scripts".
if (typeof importScripts === 'function') {
  importScripts('lib/util.js', 'lib/geo.js', 'lib/fields.js', 'lib/matcher.js', 'lib/vault.js', 'lib/store.js');
}

const { store, vault, util, fields } = globalThis.JTF;
const api = globalThis.JTF.api;

const CONTENT_FILES = [
  'lib/util.js',
  'lib/geo.js',
  'lib/fields.js',
  'lib/matcher.js',
  'content/dom.js',
  'content/fill.js',
  'content/main.js',
];

// Right-click → "Insert from profile" entries.
// prettier-ignore
const INSERT_TYPES = [
  'name.full', 'name.first', 'name.last', 'email', 'phone',
  'address.line1', 'address.city', 'address.state', 'address.postalCode', 'address.country',
  'links.linkedin', 'links.github', 'links.website',
  'edu.school', 'edu.degree', 'edu.field', 'job.currentCompany', 'job.currentTitle',
  'summary', 'coverLetter',
];

/* ---------------------------------------------------------- active fills */

// tabId -> { count, expires, email }. Secrets and documents are only served while a fill runs.
const activeFills = new Map();

function beginFill(tabId, email) {
  const current = activeFills.get(tabId) || { count: 0 };
  activeFills.set(tabId, { count: current.count + 1, expires: Date.now() + 120000, email });
}

function endFill(tabId) {
  const current = activeFills.get(tabId);
  if (!current || current.count <= 1) activeFills.delete(tabId);
  else current.count--;
}

function fillInProgress(sender) {
  const current = sender.tab && activeFills.get(sender.tab.id);
  return current && current.expires > Date.now() ? current : null;
}

/* ------------------------------------------------------------- injection */

/**
 * Run a script injection in every frame of a tab (or the given frames). Firefox rejects the
 * whole call when any frame is off-limits, so fall back to the top frame in that case.
 */
async function execute(tabId, frameIds, details) {
  if (frameIds) return api.scripting.executeScript({ ...details, target: { tabId, frameIds } });
  try {
    return await api.scripting.executeScript({ ...details, target: { tabId, allFrames: true } });
  } catch (err) {
    return api.scripting.executeScript({ ...details, target: { tabId } });
  }
}

async function ensureInjected(tabId, frameIds) {
  const probe = await execute(tabId, frameIds, { func: () => !!globalThis.__jtf });
  const missing = probe.filter((r) => !r.result).map((r) => r.frameId);
  if (missing.length) await execute(tabId, missing, { files: CONTENT_FILES });
}

/** Call globalThis.__jtf[method](...args) in the content script of each frame. */
async function callFrames(tabId, method, args, frameIds) {
  await ensureInjected(tabId, frameIds);
  const results = await execute(tabId, frameIds, {
    func: (name, params) => globalThis.__jtf && globalThis.__jtf[name](...params),
    args: [method, args || []],
  });
  return results.map((r) => ({ frameId: r.frameId, ...(r.result || {}) }));
}

const CANT_RUN = 'JobToFill can’t run on this page (browser pages and add-on stores are off-limits).';
const NEEDS_ACCESS =
  'JobToFill doesn’t have access to this site yet. Open the JobToFill toolbar popup and click “Allow”.';

/**
 * Turn an injection error into something a person can act on. Firefox reports both restricted
 * pages and a missing permission as "Missing host permission", so check which one it is.
 */
async function explainError(err, tabId) {
  const msg = String((err && err.message) || err);
  if (/cannot access|cannot be scripted|extensions gallery|webstore|privileged/i.test(msg)) return CANT_RUN;
  if (!/permission/i.test(msg)) return msg;
  const tab = tabId == null ? null : await api.tabs.get(tabId).catch(() => null);
  if (!tab || !/^(https?|file):/.test(tab.url || '')) return CANT_RUN;
  return (await api.permissions.contains({ origins: ['<all_urls>'] })) ? CANT_RUN : NEEDS_ACCESS;
}

/* ------------------------------------------------------------------ fill */

async function fillTab(tabId, options) {
  const opts = { toast: false, ...options };
  const { profile, settings } = await store.getActive();
  const payload = {
    profile,
    settings,
    docs: await store.docInfo(profile.id),
    vault: await vault.status(),
  };

  let frames;
  beginFill(tabId, profile.contact.email);
  try {
    frames = await callFrames(tabId, 'fill', [payload]);
  } catch (err) {
    return { error: await explainError(err, tabId) };
  } finally {
    endFill(tabId);
  }

  const summary = mergeReports(frames);
  const top = frames.find((f) => f.frameId === 0);
  if (summary.jobContext && settings.logApplications !== false && top && top.url) {
    await store.addHistory({
      url: top.url,
      host: top.host,
      title: top.title,
      filled: summary.filled,
      profile: profile.name,
    });
  }
  if (opts.toast && settings.toast !== false) await showToast(tabId, summaryText(summary), { undo: summary.undoable });
  return summary;
}

function mergeReports(frames) {
  const summary = {
    filled: 0,
    detected: 0,
    skipped: 0,
    failed: 0,
    unknown: 0,
    missing: [],
    missingTypes: [],
    unmatched: [],
    notes: [],
    frames: frames.length,
    undoable: false,
    jobContext: false,
  };
  for (const f of frames) {
    if (typeof f.filled !== 'number') continue;
    for (const key of ['filled', 'detected', 'skipped', 'failed', 'unknown']) summary[key] += f[key] || 0;
    for (const key of ['missing', 'missingTypes', 'unmatched', 'notes']) summary[key].push(...(f[key] || []));
    summary.undoable = summary.undoable || !!f.undoable;
    summary.jobContext = summary.jobContext || (f.jobContext && f.filled > 0);
  }
  for (const key of ['missing', 'missingTypes', 'unmatched', 'notes']) summary[key] = [...new Set(summary[key])];
  return summary;
}

function summaryText(s) {
  if (s.error) return s.error;
  if (!s.detected) return 'No fillable fields found on this page.';
  const lines = [`Filled ${s.filled} field${s.filled === 1 ? '' : 's'}.`];
  if (s.missing.length)
    lines.push(`Add to your profile: ${s.missing.slice(0, 5).join(', ')}${s.missing.length > 5 ? '…' : ''}`);
  lines.push(...s.notes.slice(0, 2));
  return lines.join('\n');
}

async function showToast(tabId, message, opts, frameIds) {
  try {
    await callFrames(tabId, 'toast', [message, opts || {}], frameIds || [0]);
  } catch (err) {
    /* the page can't be scripted */
  }
}

async function activeTabId() {
  const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true });
  return tab && tab.id;
}

/* --------------------------------------------------------------- secrets */

function isSecureUrl(url) {
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

// Card fields often live in a payment provider's iframe. Cards go to the top page, frames on the
// same site, or these processors only — never to an arbitrary third-party frame (ads, widgets).
// prettier-ignore
const PAYMENT_HOSTS = [
  'stripe.com', 'stripe.network', 'braintreegateway.com', 'braintree-api.com', 'adyen.com', 'adyenpayments.com',
  'paypal.com', 'checkout.com', 'squareup.com', 'squarecdn.com', 'recurly.com', 'chargify.com', 'shopifycs.com',
  'shopifyinc.com', 'authorize.net', 'worldpay.com', 'mollie.com', 'klarna.com', 'cybersource.com', 'globalpay.com',
  'paddle.com', 'chargebee.com',
];

/** Good enough for "same site": the last two labels (three for co.uk-style domains). */
function siteOf(host) {
  const parts = host.toLowerCase().split('.');
  const n = parts.length > 2 && parts[parts.length - 2].length <= 3 && parts[parts.length - 1].length === 2 ? 3 : 2;
  return parts.slice(-n).join('.');
}

function cardAllowedIn(sender) {
  if (sender.frameId === 0) return true;
  const frameHost = new URL(sender.url).hostname;
  const topHost = sender.tab && sender.tab.url ? new URL(sender.tab.url).hostname : '';
  if (topHost && siteOf(frameHost) === siteOf(topHost)) return true;
  return PAYMENT_HOSTS.some((h) => util.hostMatches(frameHost, h));
}

function newCredential(host, username, password) {
  const now = Date.now();
  return { id: util.uid(), host, username, password, createdAt: now, updatedAt: now, note: 'Generated by JobToFill' };
}

async function secretsFor(msg, sender) {
  const fill = fillInProgress(sender);
  if (!fill) return { error: 'No fill in progress.' };
  const url = new URL(sender.url);
  if (!isSecureUrl(url))
    return { error: `Passwords and cards are only filled on secure (https) pages — skipped ${url.hostname}.` };
  if ((await vault.status()) !== 'unlocked')
    return { error: 'The vault is locked, so passwords and cards were skipped.' };

  const data = await vault.read();
  const settings = await store.getSettings();
  const out = { notes: [] };

  if (msg.password) {
    let cred = vault.findCredential(data, url.hostname);
    if (!cred && msg.password === 'signup' && settings.passwordStrategy === 'generate') {
      cred = newCredential(url.hostname, fill.email || '', vault.generatePassword());
      data.credentials.push(cred);
      await vault.write(data);
      out.notes.push(`Generated a new password for ${url.hostname} and saved it in your vault.`);
    }
    if (!cred && settings.passwordStrategy === 'default' && data.defaultPassword) {
      cred = { username: fill.email || '', password: data.defaultPassword };
    }
    if (cred) out.credential = { username: cred.username || fill.email || '', password: cred.password };
    else out.notes.push(`No saved password for ${url.hostname}.`);
  }

  if (msg.card) {
    const card = vault.defaultCard(data);
    if (!cardAllowedIn(sender)) out.notes.push(`Card not filled into a frame from ${url.hostname}.`);
    else if (!card) out.notes.push('No card saved in the vault.');
    else
      out.card = {
        name: card.name,
        number: card.number,
        expMonth: card.expMonth,
        expYear: card.expYear,
        cvc: card.cvc,
      };
  }

  await vault.touch();
  return out;
}

async function documentFor(msg, sender) {
  if (!fillInProgress(sender)) return { error: 'No fill in progress.' };
  const { profile } = await store.getActive();
  const doc = await store.getDoc(profile.id, msg.which);
  return doc ? { name: doc.name, type: doc.type, dataUrl: doc.dataUrl } : { error: 'No document' };
}

/* -------------------------------------------------------------- messages */

const sum = (frames, key) => frames.reduce((n, f) => n + (f[key] || 0), 0);

const HANDLERS = {
  // From the popup and settings page.
  'jtf:fill': (msg) => fillTab(msg.tabId, { toast: !!msg.toast }),
  'jtf:undo': async (msg) => ({ undone: sum(await callFrames(msg.tabId, 'undo'), 'undone') }),
  'jtf:inspect': async (msg) => {
    const { profile } = await store.getActive();
    const frames = await callFrames(msg.tabId, 'inspect', [{ profile, docs: await store.docInfo(profile.id) }]);
    return { on: frames.some((f) => f.on), detected: sum(frames, 'detected') };
  },
  'jtf:learn': async (msg) => {
    const { profile } = await store.getActive();
    const frames = await callFrames(msg.tabId, 'learn', [{ profile }]);
    return { suggestions: frames.flatMap((f) => f.suggestions || []) };
  },
  // From content scripts, during a fill.
  'jtf:secrets': secretsFor,
  'jtf:document': documentFor,
};

const CONTENT_ONLY = new Set(['jtf:secrets', 'jtf:document']);
const isExtensionPage = (sender) => !!sender.url && sender.url.startsWith(api.runtime.getURL(''));
const isContentScript = (sender) => !!sender.tab && !isExtensionPage(sender);

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = msg && HANDLERS[msg.type];
  if (!handler || sender.id !== api.runtime.id) return false;
  const allowed = CONTENT_ONLY.has(msg.type) ? isContentScript(sender) : isExtensionPage(sender);
  if (!allowed) return false;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then(sendResponse, async (err) => sendResponse({ error: await explainError(err, msg.tabId) }));
  return true;
});

/* --------------------------------------------------- shortcuts and menus */

api.commands.onCommand.addListener(async (command) => {
  const tabId = await activeTabId();
  if (tabId != null && command === 'fill-page') await fillTab(tabId, { toast: true });
});

async function createMenus() {
  await api.contextMenus.removeAll();
  const add = (props) => api.contextMenus.create(props);
  add({ id: 'jtf-fill', title: 'Fill this page', contexts: ['page', 'editable', 'frame'] });
  add({ id: 'jtf-insert', title: 'Insert from profile', contexts: ['editable'] });
  for (const type of INSERT_TYPES) {
    add({ id: 'jtf-insert:' + type, parentId: 'jtf-insert', title: fields.labelOf(type), contexts: ['editable'] });
  }
  add({ id: 'jtf-genpass', title: 'Generate strong password', contexts: ['editable'] });
}

api.contextMenus.onClicked.addListener((info, tab) => {
  handleMenuClick(info, tab).catch((err) => console.warn('JobToFill menu action failed:', err));
});

async function handleMenuClick(info, tab) {
  if (!tab || tab.id == null) return;
  const frameIds = [info.frameId || 0];
  const id = String(info.menuItemId);

  if (id === 'jtf-fill') {
    await fillTab(tab.id, { toast: true });
  } else if (id.startsWith('jtf-insert:')) {
    const { profile, settings } = await store.getActive();
    await callFrames(tab.id, 'fillActive', [id.slice('jtf-insert:'.length), { profile, settings }], frameIds);
  } else if (id === 'jtf-genpass') {
    await generatePasswordInto(tab, info, frameIds);
  }
}

async function generatePasswordInto(tab, info, frameIds) {
  const status = await vault.status();
  if (status !== 'unlocked') {
    const message =
      status === 'none'
        ? 'Set up the JobToFill vault first so generated passwords are saved.'
        : 'Unlock JobToFill (click the toolbar icon) so the new password can be saved.';
    await showToast(tab.id, message, {}, frameIds);
    return;
  }
  const host = new URL(info.frameUrl || info.pageUrl || tab.url).hostname;
  const { profile } = await store.getActive();
  const password = vault.generatePassword();
  await vault.update((data) => {
    const existing = vault.findCredential(data, host);
    if (existing && existing.host === host) {
      existing.previousPassword = existing.password;
      existing.password = password;
      existing.updatedAt = Date.now();
    } else {
      data.credentials.push(newCredential(host, profile.contact.email || '', password));
    }
  });
  await callFrames(tab.id, 'insertPassword', [password], frameIds);
  await showToast(tab.id, `Generated a strong password and saved it for ${host}.`, {}, frameIds);
}

/* ------------------------------------------------------------- lifecycle */

async function ensureAlarm() {
  if (!(await api.alarms.get('jtf-autolock'))) api.alarms.create('jtf-autolock', { periodInMinutes: 1 });
}

api.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'jtf-autolock') return;
  await vault.autoLock((await store.getSettings()).autoLockMinutes);
});

api.runtime.onInstalled.addListener(async (details) => {
  await createMenus();
  await ensureAlarm();
  await store.loadAll();
  if (details.reason === 'install') api.runtime.openOptionsPage();
});

api.runtime.onStartup.addListener(async () => {
  await createMenus();
  await ensureAlarm();
});

// For debugging from the background console, and for the end-to-end tests.
globalThis.JTFBackground = {
  fillTab,
  callFrames,
  ensureInjected,
  handleMenuClick,
  secretsFor,
  summaryText,
  cardAllowedIn,
  siteOf,
  handlers: HANDLERS,
};
