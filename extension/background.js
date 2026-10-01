/*
 * JobToFill — background (service worker in Chromium, event page in Firefox).
 * Owns everything that needs privileges: injecting the content scripts on
 * demand, running a fill across all frames, handing out vault secrets (only to
 * the frame being filled, only over HTTPS), the keyboard shortcut, context
 * menus, vault auto-lock and the automatic backup file.
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

// tabId -> { count, expires, email, letter }. Secrets and documents are only served while a fill runs.
const activeFills = new Map();

function beginFill(tabId, email, letter) {
  const current = activeFills.get(tabId) || { count: 0 };
  activeFills.set(tabId, { count: current.count + 1, expires: Date.now() + 120000, email, letter });
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

const docMeta = (d) => (d ? { name: d.name, size: d.size, type: d.type, updatedAt: d.updatedAt } : null);

/**
 * What a fill puts on the page: the active profile, plus the cover letter (and tailored CV) written
 * for the application open in this tab, which take the place of the stored ones.
 */
async function fillPayload(tabId) {
  const { profile, settings } = await store.getActive();
  const tab = await api.tabs.get(tabId).catch(() => null);
  const letter = await store.letterFor({ tabId, url: tab && tab.url });
  const docs = await store.docInfo(profile.id);
  let filled = profile;
  if (letter && letter.profileId === profile.id) {
    filled = { ...profile, coverLetter: letter.text || profile.coverLetter };
    docs.coverLetter = docMeta(letter.pdf) || docs.coverLetter;
    if (letter.useCv && letter.cv) docs.resume = docMeta(letter.cv);
  }
  const mine = letter && letter.profileId === profile.id ? letter : null;
  return { payload: { profile: filled, settings, docs, vault: await vault.status() }, letter: mine };
}

async function fillTab(tabId, options) {
  const opts = { toast: false, ...options };
  const { payload, letter } = await fillPayload(tabId);
  const { profile, settings } = payload;
  if (opts.only) Object.assign(payload, { only: opts.only, force: true });

  let frames;
  beginFill(tabId, profile.contact.email, letter && letter.id);
  try {
    frames = await callFrames(tabId, 'fill', [payload]);
  } catch (err) {
    return { error: await explainError(err, tabId) };
  } finally {
    endFill(tabId);
  }

  const summary = mergeReports(frames);
  summary.letter = letter ? { id: letter.id, company: letter.posting && letter.posting.company } : null;
  const top = frames.find((f) => f.frameId === 0);
  if (summary.jobContext && !opts.only && settings.logApplications !== false && top && top.url) {
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
    consents: 0,
    missing: [],
    missingTypes: [],
    unmatched: [],
    notes: [],
    frames: frames.length,
    undoable: false,
    jobContext: false,
    wantsLetter: false,
  };
  for (const f of frames) {
    if (typeof f.filled !== 'number') continue;
    for (const key of ['filled', 'detected', 'skipped', 'failed', 'unknown', 'consents', 'restored'])
      summary[key] = (summary[key] || 0) + (f[key] || 0);
    for (const key of ['missing', 'missingTypes', 'unmatched', 'notes']) summary[key].push(...(f[key] || []));
    summary.undoable = summary.undoable || !!f.undoable;
    summary.jobContext = summary.jobContext || (f.jobContext && f.filled > 0);
    summary.wantsLetter = summary.wantsLetter || !!f.wantsLetter;
  }
  for (const key of ['missing', 'missingTypes', 'unmatched', 'notes']) summary[key] = [...new Set(summary[key])];
  return summary;
}

function consentText(n) {
  return `${n === 1 ? 'One acknowledgement box is' : `${n} acknowledgement boxes are`} left for you to tick.`;
}

function summaryText(s) {
  if (s.error) return s.error;
  if (!s.detected) return 'No fillable fields found on this page.';
  const lines = [`Filled ${s.filled} field${s.filled === 1 ? '' : 's'}.`];
  if (s.missing.length)
    lines.push(`Add to your profile: ${s.missing.slice(0, 5).join(', ')}${s.missing.length > 5 ? '…' : ''}`);
  if (s.consents) lines.push(consentText(s.consents));
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
  const fill = fillInProgress(sender);
  if (!fill) return { error: 'No fill in progress.' };
  if (fill.letter) {
    const letter = (await store.getLetters()).find((l) => l.id === fill.letter);
    const doc = letter && (msg.which === 'coverLetter' ? letter.pdf : letter.useCv ? letter.cv : null);
    if (doc) return { name: doc.name, type: doc.type, dataUrl: doc.dataUrl };
  }
  const { profile } = await store.getActive();
  const doc = await store.getDoc(profile.id, msg.which);
  return doc ? { name: doc.name, type: doc.type, dataUrl: doc.dataUrl } : { error: 'No document' };
}

/* --------------------------------------------------------------- backups */

// Extension storage is deleted when an extension is removed, and Firefox removes temporary add-ons
// every time it restarts. So a copy of everything (the vault still encrypted) is kept in
// Downloads/JobToFill, rewritten shortly after each change, and offered back when JobToFill
// starts out empty.
const BACKUP_FILE = 'JobToFill/jobtofill-backup.json';
const BACKUP_KEYS = /^(profiles|profileOrder|settings|vault|doc:.+|kit:.+)$/;

api.storage.onChanged.addListener((changes, areaName) => {
  // Re-created on every change, so the file is written once things have been quiet for half a minute.
  if (areaName === 'local' && Object.keys(changes).some((k) => BACKUP_KEYS.test(k)))
    api.alarms.create('jtf-backup', { delayInMinutes: 0.5 });
});

/** Firefox's background page can make blob URLs; Chromium's service worker can't, so it gets a data URL. */
function jsonUrl(json) {
  if (typeof URL.createObjectURL === 'function')
    return URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return 'data:application/json;base64,' + btoa(bin);
}

async function finishedDownload(id) {
  for (let i = 0; i < 150; i++) {
    const [item] = await api.downloads.search({ id });
    if (!item || item.state !== 'in_progress') return item || null;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}

/** Earlier writes of the backup file, newest first (the browser's download list outlives the extension). */
async function backupDownloads() {
  return (await api.downloads.search({ orderBy: ['-startTime'] })).filter(store.isBackupDownload);
}

/**
 * Write the backup file. Skipped while automatic backups are off or a restore is pending, unless
 * `force` (the "Back up now" button), and always when there is nothing to back up yet.
 */
async function writeBackup(options) {
  const force = !!(options && options.force);
  const [settings, info] = await Promise.all([store.getSettings(), store.getBackupInfo()]);
  if (!force && settings.autoBackup === false) return { skipped: 'off' };
  if (!force && info.paused) return { skipped: 'restore pending' };
  if (!(await store.hasData())) return { skipped: 'nothing to back up yet' };

  const url = jsonUrl(JSON.stringify(await store.exportData()));
  try {
    const id = await api.downloads.download({ url, filename: BACKUP_FILE, conflictAction: 'overwrite', saveAs: false });
    const item = await finishedDownload(id);
    if (!item || item.state !== 'complete') throw new Error((item && item.error) || 'The backup file was not written.');
    // Keep the download list to one entry for the backup file.
    for (const old of await backupDownloads()) if (old.id !== id) await api.downloads.erase({ id: old.id });
    await store.setBackupInfo({ at: Date.now(), path: item.filename, error: null, paused: false });
    return { ok: true, path: item.filename };
  } catch (err) {
    const error = String((err && err.message) || err);
    await store.setBackupInfo({ error, errorAt: Date.now() });
    return { error };
  } finally {
    if (url.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}

/**
 * On a fresh install, look for a backup an earlier install wrote. If there is one, hold automatic
 * backups (so the empty new profile can't replace it) until the person restores it or starts fresh.
 */
async function lookForPreviousBackup() {
  if (await store.hasData()) return null;
  const [found] = (await backupDownloads()).filter((item) => item.exists !== false);
  if (!found) return null;
  const previous = { path: found.filename, at: Date.parse(found.endTime || found.startTime) || null };
  await store.setBackupInfo({ previous, paused: true, dismissed: false });
  return previous;
}

/* ---------------------------------------------------------- cover letters */

// Only needed for cover letters, so it isn't injected with every fill.
const JOB_FILE = 'lib/jobpage.js';

/** Call the in-page jobContext() in each frame, adding the job page reader where it's missing. */
async function readJobPages(tabId, frameIds) {
  await ensureInjected(tabId, frameIds);
  const probe = await execute(tabId, frameIds, { func: () => !!(globalThis.JTF && globalThis.JTF.jobpage) });
  const missing = probe.filter((r) => !r.result).map((r) => r.frameId);
  if (missing.length) await execute(tabId, missing, { files: [JOB_FILE] });
  return callFrames(tabId, 'jobContext', [], frameIds);
}

/**
 * What the application open in a tab says about the job. The top frame describes the page; a frame
 * (iCIMS, embedded Greenhouse boards) may hold the actual posting.
 */
async function jobContext(tabId) {
  const frames = await readJobPages(tabId);
  const top = frames.find((f) => f.frameId === 0 && f.url) || frames.find((f) => f.url);
  if (!top) throw new Error(CANT_RUN);
  const context = { ...top };
  const best = (f) => (f.posting && f.posting.description ? f.posting.description.length : 0);
  const framed = frames.filter((f) => f !== top && best(f) > best(top)).sort((a, b) => best(b) - best(a))[0];
  if (framed && best(framed) > 400) {
    context.posting = framed.posting;
    context.framePosting = framed.url;
  }
  for (const f of frames) if (f !== top && f.title && !context.title) context.title = f.title;
  context.frames = frames.map((f) => f.url).filter(Boolean);
  return context;
}

function waitForTab(tabId, timeout) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      api.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id, info) => id === tabId && info.status === 'complete' && done();
    const timer = setTimeout(done, timeout);
    api.tabs.onUpdated.addListener(listener);
    api.tabs.get(tabId).then((t) => t.status === 'complete' && done(), done);
  });
}

/**
 * Some job pages are built entirely by scripts (Workday, SuccessFactors, Oracle, Phenom), so fetching
 * them returns an empty shell. Open such a page in a background tab, read it, and close it again.
 */
async function scrapeInTab(url) {
  if (!/^https?:\/\//.test(url || '')) return { error: 'Not a web page.' };
  const tab = await api.tabs.create({ url, active: false });
  try {
    await waitForTab(tab.id, 20000);
    let context = null;
    for (let i = 0; i < 6; i++) {
      // Script-built pages keep rendering after "complete"; wait until the description shows up.
      await new Promise((r) => setTimeout(r, i ? 1500 : 1200));
      context = (await readJobPages(tab.id, [0]))[0];
      if (context && context.posting && context.posting.description && context.posting.description.length > 600) break;
    }
    return context || { error: 'The page could not be read.' };
  } finally {
    api.tabs.remove(tab.id).catch(() => {});
  }
}

/** "Use for this application": remember the letter for this tab and put it into the form now. */
async function attachLetter(tabId, letterId) {
  const tab = await api.tabs.get(tabId).catch(() => null);
  const letter = (await store.getLetters()).find((l) => l.id === letterId);
  if (!letter) return { error: 'That letter no longer exists.' };
  await store.saveLetter({ id: letterId, tabId, attachedAt: Date.now(), url: (tab && tab.url) || letter.url });
  if (!tab) return { saved: true, filled: 0 };
  const only = ['file.coverLetter', 'coverLetter', ...(letter.useCv && letter.cv ? ['file.resume'] : [])];
  const summary = await fillTab(tabId, { only });
  if (summary.error) return { saved: true, error: summary.error };
  return { saved: true, filled: summary.filled, detected: summary.detected };
}

/* -------------------------------------------------------------- messages */

const sum = (frames, key) => frames.reduce((n, f) => n + (f[key] || 0), 0);

const HANDLERS = {
  // From the popup and settings page.
  'jtf:fill': (msg) => fillTab(msg.tabId, { toast: !!msg.toast }),
  'jtf:undo': async (msg) => ({ undone: sum(await callFrames(msg.tabId, 'undo'), 'undone') }),
  'jtf:inspect': async (msg) => {
    const { profile, settings } = await store.getActive();
    const frames = await callFrames(msg.tabId, 'inspect', [
      { profile, settings, docs: await store.docInfo(profile.id) },
    ]);
    return { on: frames.some((f) => f.on), detected: sum(frames, 'detected') };
  },
  'jtf:backup': () => writeBackup({ force: true }),
  'jtf:job-context': (msg) => jobContext(msg.tabId),
  'jtf:scrape': (msg) => scrapeInTab(msg.url),
  'jtf:attach': (msg) => attachLetter(msg.tabId, msg.letterId),
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
  if (alarm.name === 'jtf-autolock') await vault.autoLock((await store.getSettings()).autoLockMinutes);
  else if (alarm.name === 'jtf-backup') await writeBackup();
});

api.runtime.onInstalled.addListener(async (details) => {
  await createMenus();
  await ensureAlarm();
  await store.loadAll();
  if (details.reason === 'install') {
    await lookForPreviousBackup().catch((err) => console.warn('JobToFill: could not look for a backup:', err));
    api.runtime.openOptionsPage();
  }
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
  writeBackup,
  lookForPreviousBackup,
  handlers: HANDLERS,
};
