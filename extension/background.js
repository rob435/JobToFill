/*
 * JobToFill — service worker. Owns everything that needs privileges:
 * injecting the content scripts on demand, running a fill across all frames,
 * handing out vault secrets (only to the frame being filled, only over HTTPS),
 * keyboard shortcut, context menus and vault auto-lock.
 */
if (typeof importScripts === 'function') {
  importScripts('lib/util.js', 'lib/geo.js', 'lib/fields.js', 'lib/matcher.js', 'lib/vault.js', 'lib/store.js');
}

const { store, vault } = globalThis.JTF;

const CONTENT_FILES = [
  'lib/util.js', 'lib/geo.js', 'lib/fields.js', 'lib/matcher.js',
  'content/dom.js', 'content/fill.js', 'content/main.js',
];

const INSERT_ITEMS = [
  ['name.full', 'Full name'], ['name.first', 'First name'], ['name.last', 'Last name'],
  ['email', 'Email'], ['phone', 'Phone'], ['address.line1', 'Street address'], ['address.city', 'City'],
  ['address.state', 'State / province'], ['address.postalCode', 'Postal code'], ['address.country', 'Country'],
  ['links.linkedin', 'LinkedIn'], ['links.github', 'GitHub'], ['links.website', 'Website'],
  ['edu.school', 'University / school'], ['edu.degree', 'Degree'], ['edu.field', 'Field of study'],
  ['job.currentCompany', 'Current company'], ['job.currentTitle', 'Current title'],
  ['summary', 'Summary'], ['coverLetter', 'Cover letter'],
];

// tabId -> { count, expires, email }: secrets and documents are only served while a fill runs.
const activeFills = new Map();

function beginFill(tabId, email) {
  const f = activeFills.get(tabId) || { count: 0 };
  activeFills.set(tabId, { count: f.count + 1, expires: Date.now() + 120000, email });
}

function endFill(tabId) {
  const f = activeFills.get(tabId);
  if (!f || f.count <= 1) activeFills.delete(tabId);
  else f.count--;
}

// Card fields often live in a payment provider's iframe. Cards go to the top page, frames on the
// same site, or these processors only, never to an arbitrary third-party frame (ads, widgets).
const PAYMENT_HOSTS = [
  'stripe.com', 'stripe.network', 'braintreegateway.com', 'braintree-api.com', 'adyen.com', 'adyenpayments.com', 'paypal.com',
  'checkout.com', 'squareup.com', 'squarecdn.com', 'recurly.com', 'chargify.com', 'shopifycs.com', 'shopifyinc.com', 'authorize.net',
  'worldpay.com', 'mollie.com', 'klarna.com', 'cybersource.com', 'globalpay.com', 'paddle.com', 'chargebee.com',
];

function siteOf(host) {
  // Good enough for "same site": the last two labels (three for co.uk-style domains).
  const parts = host.toLowerCase().split('.');
  const n = parts.length > 2 && parts[parts.length - 2].length <= 3 && parts[parts.length - 1].length === 2 ? 3 : 2;
  return parts.slice(-n).join('.');
}

function cardAllowedIn(sender) {
  if (sender.frameId === 0) return true;
  const frameHost = new URL(sender.url).hostname;
  const topHost = sender.tab && sender.tab.url ? new URL(sender.tab.url).hostname : '';
  if (topHost && siteOf(frameHost) === siteOf(topHost)) return true;
  return PAYMENT_HOSTS.some((h) => globalThis.JTF.util.hostMatches(frameHost, h));
}

/* ------------------------------------------------------------- injection */

async function ensureInjected(tabId, frameIds) {
  const target = frameIds ? { tabId, frameIds } : { tabId, allFrames: true };
  const probe = await chrome.scripting.executeScript({ target, func: () => !!globalThis.__jtf });
  const missing = probe.filter((r) => !r.result).map((r) => r.frameId);
  if (missing.length) {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: missing }, files: CONTENT_FILES });
  }
}

async function runInFrames(tabId, func, args, frameIds) {
  const target = frameIds ? { tabId, frameIds } : { tabId, allFrames: true };
  const results = await chrome.scripting.executeScript({ target, func, args: args || [] });
  return results.map((r) => Object.assign({ frameId: r.frameId }, r.result || {}));
}

function friendlyError(err) {
  const msg = String((err && err.message) || err);
  if (/cannot access|cannot be scripted|chrome:\/\/|extensions gallery|webstore/i.test(msg)) {
    return 'JobToFill can’t run on this page (browser pages and the extension store are off-limits).';
  }
  return msg;
}

/* ------------------------------------------------------------------ fill */

async function fillTab(tabId, options) {
  const opts = Object.assign({ toast: false }, options || {});
  const { profile, settings } = await store.getActive();
  const payload = {
    profile, settings,
    docs: await store.docInfo(profile.id),
    vault: await vault.status(),
  };
  beginFill(tabId, profile.contact.email);
  let frames;
  try {
    await ensureInjected(tabId);
    frames = await runInFrames(tabId, (p) => globalThis.__jtf && globalThis.__jtf.fill(p), [payload]);
  } catch (err) {
    return { error: friendlyError(err) };
  } finally {
    endFill(tabId);
  }

  const summary = { filled: 0, detected: 0, skipped: 0, failed: 0, unknown: 0, missing: [], missingTypes: [], unmatched: [], notes: [], frames: frames.length, undoable: false };
  let top = null;
  let jobContext = false;
  for (const f of frames) {
    if (f.frameId === 0) top = f;
    if (typeof f.filled !== 'number') continue;
    for (const k of ['filled', 'detected', 'skipped', 'failed', 'unknown']) summary[k] += f[k] || 0;
    summary.missing.push(...(f.missing || []));
    summary.missingTypes.push(...(f.missingTypes || []));
    summary.unmatched.push(...(f.unmatched || []));
    summary.notes.push(...(f.notes || []));
    summary.undoable = summary.undoable || !!f.undoable;
    jobContext = jobContext || (f.jobContext && f.filled > 0);
  }
  summary.missing = [...new Set(summary.missing)];
  summary.missingTypes = [...new Set(summary.missingTypes)];
  summary.unmatched = [...new Set(summary.unmatched)];
  summary.notes = [...new Set(summary.notes)];

  if (jobContext && settings.logApplications !== false && top && top.url) {
    await store.addHistory({ url: top.url, host: top.host, title: top.title, filled: summary.filled, profile: profile.name });
  }
  if (opts.toast && settings.toast !== false) {
    await showToast(tabId, summaryText(summary), { undo: summary.undoable });
  }
  return summary;
}

function summaryText(s) {
  if (s.error) return s.error;
  if (!s.detected) return 'No fillable fields found on this page.';
  const lines = [`Filled ${s.filled} field${s.filled === 1 ? '' : 's'}.`];
  if (s.missing.length) lines.push(`Add to your profile: ${s.missing.slice(0, 5).join(', ')}${s.missing.length > 5 ? '…' : ''}`);
  if (s.notes.length) lines.push(...s.notes.slice(0, 2));
  return lines.join('\n');
}

async function showToast(tabId, message, opts) {
  try {
    await ensureInjected(tabId, [0]);
    await runInFrames(tabId, (m, o) => globalThis.__jtf && { shown: globalThis.__jtf.toast(m, o) }, [message, opts || {}], [0]);
  } catch (err) {
    /* page can't be scripted */
  }
}

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab && tab.id;
}

/* --------------------------------------------------------------- secrets */

function isSecureUrl(url) {
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

async function secretsFor(msg, sender) {
  const fill = sender.tab && activeFills.get(sender.tab.id);
  if (!fill || fill.expires < Date.now()) return { error: 'No fill in progress.' };
  const url = new URL(sender.url);
  if (!isSecureUrl(url)) return { error: `Passwords and cards are only filled on secure (https) pages — skipped ${url.hostname}.` };
  if ((await vault.status()) !== 'unlocked') return { error: 'The vault is locked, so passwords and cards were skipped.' };

  const data = await vault.read();
  const settings = await store.getSettings();
  const out = { notes: [] };
  if (msg.password) {
    let cred = vault.findCredential(data, url.hostname);
    if (!cred && msg.password === 'signup' && settings.passwordStrategy === 'generate') {
      cred = {
        id: globalThis.JTF.util.uid(), host: url.hostname, username: fill.email || '',
        password: vault.generatePassword(), createdAt: Date.now(), updatedAt: Date.now(), note: 'Generated by JobToFill',
      };
      data.credentials.push(cred);
      await vault.write(data);
      out.notes.push(`Generated a new password for ${url.hostname} and saved it in your vault.`);
    }
    if (!cred && settings.passwordStrategy === 'default' && data.defaultPassword) cred = { username: fill.email || '', password: data.defaultPassword };
    if (cred) out.credential = { username: cred.username || fill.email || '', password: cred.password };
    else out.notes.push(`No saved password for ${url.hostname}.`);
  }
  if (msg.card && !cardAllowedIn(sender)) {
    out.notes.push(`Card not filled into a frame from ${url.hostname}.`);
  } else if (msg.card) {
    const card = vault.defaultCard(data);
    if (card) out.card = { name: card.name, number: card.number, expMonth: card.expMonth, expYear: card.expYear, cvc: card.cvc };
    else out.notes.push('No card saved in the vault.');
  }
  await vault.touch();
  return out;
}

async function documentFor(msg, sender) {
  const fill = sender.tab && activeFills.get(sender.tab.id);
  if (!fill || fill.expires < Date.now()) return { error: 'No fill in progress.' };
  const { profile } = await store.getActive();
  const doc = await store.getDoc(profile.id, msg.which);
  return doc ? { name: doc.name, type: doc.type, dataUrl: doc.dataUrl } : { error: 'No document' };
}

/* -------------------------------------------------------------- messages */

const isExtensionPage = (sender) => !!sender.url && sender.url.startsWith(chrome.runtime.getURL(''));
const isContentScript = (sender) => !!sender.tab && !isExtensionPage(sender);

const HANDLERS = {
  // From the popup / options page.
  'jtf:fill': (msg) => fillTab(msg.tabId, { toast: !!msg.toast }),
  'jtf:undo': async (msg) => {
    await ensureInjected(msg.tabId);
    const frames = await runInFrames(msg.tabId, () => globalThis.__jtf && globalThis.__jtf.undo());
    return { undone: frames.reduce((n, f) => n + (f.undone || 0), 0) };
  },
  'jtf:inspect': async (msg) => {
    const { profile } = await store.getActive();
    const payload = { profile, docs: await store.docInfo(profile.id) };
    await ensureInjected(msg.tabId);
    const frames = await runInFrames(msg.tabId, (p) => globalThis.__jtf && globalThis.__jtf.inspect(p), [payload]);
    return { on: frames.some((f) => f.on), detected: frames.reduce((n, f) => n + (f.detected || 0), 0) };
  },
  'jtf:learn': async (msg) => {
    const { profile } = await store.getActive();
    await ensureInjected(msg.tabId);
    const frames = await runInFrames(msg.tabId, (p) => globalThis.__jtf && globalThis.__jtf.learn(p), [{ profile }]);
    return { suggestions: frames.flatMap((f) => f.suggestions || []) };
  },
  // From content scripts during a fill.
  'jtf:secrets': secretsFor,
  'jtf:document': documentFor,
};

const CONTENT_ONLY = new Set(['jtf:secrets', 'jtf:document']);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = msg && HANDLERS[msg.type];
  if (!handler || sender.id !== chrome.runtime.id) return false;
  const allowed = CONTENT_ONLY.has(msg.type) ? isContentScript(sender) : isExtensionPage(sender);
  if (!allowed) return false;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then(sendResponse, (err) => sendResponse({ error: friendlyError(err) }));
  return true;
});

/* --------------------------------------------------- shortcuts and menus */

chrome.commands.onCommand.addListener(async (command) => {
  const tabId = await activeTabId();
  if (!tabId) return;
  if (command === 'fill-page') await fillTab(tabId, { toast: true });
});

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'jtf-fill', title: 'Fill this page', contexts: ['page', 'editable', 'frame'] });
    chrome.contextMenus.create({ id: 'jtf-insert', title: 'Insert from profile', contexts: ['editable'] });
    for (const [type, title] of INSERT_ITEMS) {
      chrome.contextMenus.create({ id: 'jtf-insert:' + type, parentId: 'jtf-insert', title, contexts: ['editable'] });
    }
    chrome.contextMenus.create({ id: 'jtf-genpass', title: 'Generate strong password', contexts: ['editable'] });
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  handleMenuClick(info, tab).catch((err) => console.warn('JobToFill menu action failed:', err));
});

async function handleMenuClick(info, tab) {
  if (!tab || tab.id == null) return;
  const frameIds = [info.frameId || 0];
  if (info.menuItemId === 'jtf-fill') {
    await fillTab(tab.id, { toast: true });
    return;
  }
  if (String(info.menuItemId).startsWith('jtf-insert:')) {
    const type = String(info.menuItemId).slice('jtf-insert:'.length);
    const { profile, settings } = await store.getActive();
    await ensureInjected(tab.id, frameIds);
    await runInFrames(tab.id, (t, p) => globalThis.__jtf && globalThis.__jtf.fillActive(t, p), [type, { profile, settings }], frameIds);
    return;
  }
  if (info.menuItemId === 'jtf-genpass') {
    await ensureInjected(tab.id, frameIds);
    const status = await vault.status();
    if (status !== 'unlocked') {
      await runInFrames(tab.id, (m) => globalThis.__jtf && { shown: globalThis.__jtf.toast(m) },
        [status === 'none' ? 'Set up the JobToFill vault first so generated passwords are saved.' : 'Unlock JobToFill (click the toolbar icon) so the new password can be saved.'], frameIds);
      return;
    }
    const url = new URL(info.frameUrl || info.pageUrl || tab.url);
    const { profile } = await store.getActive();
    const password = vault.generatePassword();
    await vault.update((data) => {
      const existing = vault.findCredential(data, url.hostname);
      if (existing && existing.host === url.hostname) {
        existing.previousPassword = existing.password;
        existing.password = password;
        existing.updatedAt = Date.now();
      } else {
        data.credentials.push({
          id: globalThis.JTF.util.uid(), host: url.hostname, username: profile.contact.email || '', password,
          createdAt: Date.now(), updatedAt: Date.now(), note: 'Generated by JobToFill',
        });
      }
    });
    await runInFrames(tab.id, (pw, host) => {
      if (!globalThis.__jtf) return {};
      const res = globalThis.__jtf.insertPassword(pw);
      globalThis.__jtf.toast(`Generated a strong password and saved it for ${host}.`);
      return res;
    }, [password, url.hostname], frameIds);
  }
}

/* ------------------------------------------------------------- lifecycle */

async function ensureAlarm() {
  if (!(await chrome.alarms.get('jtf-autolock'))) chrome.alarms.create('jtf-autolock', { periodInMinutes: 1 });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'jtf-autolock') return;
  const settings = await store.getSettings();
  await vault.autoLock(settings.autoLockMinutes);
});

chrome.runtime.onInstalled.addListener(async (details) => {
  createMenus();
  await ensureAlarm();
  await store.loadAll();
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(() => {
  createMenus();
  ensureAlarm();
});

// Exposed for debugging from the service-worker console and for the E2E tests.
globalThis.JTFBackground = { fillTab, ensureInjected, runInFrames, handleMenuClick, secretsFor, summaryText, cardAllowedIn, siteOf, handlers: HANDLERS };
