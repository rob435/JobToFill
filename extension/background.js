/*
 * JobToFill — background (service worker in Chromium, event page in Firefox).
 * Owns everything that needs privileges: injecting the content scripts on
 * demand, running a fill across all frames, handing out vault secrets (only to
 * the frame being filled, only over HTTPS), the keyboard shortcut, context
 * menus, vault auto-lock, the automatic backup file, verification codes from email and the Discover
 * watchlist checks.
 */
// Chromium loads the libraries here; Firefox lists them in manifest.json "background.scripts".
if (typeof importScripts === 'function') {
  importScripts(
    'lib/util.js',
    'lib/geo.js',
    'lib/fields.js',
    'lib/matcher.js',
    'lib/account.js',
    'lib/vault.js',
    'lib/store.js',
    'lib/ai.js',
    'lib/letter.js',
    'lib/answers.js',
    'lib/jobpage.js',
    'lib/doctext.js',
    'lib/otp.js',
    'lib/nylas.js',
    'lib/discover.js',
  );
}

const { store, vault, util, fields, answers, jobpage, doctext, otp, nylas } = globalThis.JTF;
const llm = globalThis.JTF.ai;
const api = globalThis.JTF.api;

const CONTENT_FILES = [
  'lib/util.js',
  'lib/geo.js',
  'lib/fields.js',
  'lib/matcher.js',
  'lib/account.js',
  'content/dom.js',
  'content/fill.js',
  'content/account.js',
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

// tabId -> { count, expires, email, names, letter }. Secrets and documents are only served while a fill runs.
const activeFills = new Map();

function beginFill(tabId, email, letter, names) {
  const current = activeFills.get(tabId) || { count: 0 };
  activeFills.set(tabId, { count: current.count + 1, expires: Date.now() + 120000, email, letter, names: names || [] });
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
  const letter = await store.letterFor({ tabId, url: tab && tab.url, trail: await readTrail(tabId) });
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

/**
 * Fill the form in a tab. Options: toast (say what happened on the page), only (just these field types,
 * replacing what is there unless force: false), hold (leave these types alone), replace (overwrite these
 * types even when they hold something), consents (tick acknowledgements whatever the setting says), ai
 * (false: no AI answers), aiToast (say on the page when the AI answers are in), waitAi, quick (a fill
 * Quick apply makes itself), flow (a fill the person started: on a sign-in or sign-up page it may sign in or
 * create the account, see accountStep).
 */
async function fillTab(tabId, options) {
  const opts = { toast: false, ...options };
  const { payload, letter } = await fillPayload(tabId);
  const { profile } = payload;
  if (opts.consents) payload.settings = { ...payload.settings, consents: true };
  const { settings } = payload;
  if (opts.only) Object.assign(payload, { only: opts.only, force: opts.force !== false });
  if (opts.replace) payload.replace = opts.replace;
  let hold = opts.hold || null;
  // Quick apply is still writing this application's letter and tailoring its CV: a Fill meanwhile leaves
  // those uploads to it, so the tailored CV doesn't find the usual one already in its place.
  if (!opts.quick && !opts.only && (await quickRunningFor(tabId))) {
    hold = [...new Set([...(hold || []), ...QUICK_DOCS])];
    payload.quickHeld = true;
  }
  if (hold) payload.hold = hold;
  // With AI answers on, the page opens custom dropdowns it left empty to read their options for the model.
  const aiReady = opts.only || opts.ai === false ? { ok: false, reason: 'off' } : await aiAvailable(settings);
  payload.ai = aiReady.ok;
  payload.accountFlow = !!opts.flow && !opts.only && settings.accountFlow !== false;

  let frames;
  const names = [profile.personal.firstName, profile.personal.lastName, profile.personal.preferredName];
  beginFill(tabId, profile.contact.email, letter && letter.id, names);
  try {
    frames = await callFrames(tabId, 'fill', [payload]);
  } catch (err) {
    return { error: await explainError(err, tabId) };
  } finally {
    endFill(tabId);
  }

  // A sign-in step that asks for an emailed code: look out for it even when automatic watching is off.
  const tab = await api.tabs.get(tabId).catch(() => null);
  if (!opts.only && tab && !tab.incognito && (await otpReady())) watchOtp(tabId).catch(() => {});

  const summary = mergeReports(frames);
  summary.letter = letter ? { id: letter.id, company: letter.posting && letter.posting.company } : null;
  summary.quickHeld = !!payload.quickHeld;
  if (payload.quickHeld && summary.held)
    summary.notes.unshift(
      'Quick apply is still writing your cover letter and tailoring your CV: it puts them in when they’re ready.',
    );
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
  // What the rules left empty goes to the AI, in the background: the fill doesn't wait for it.
  const pending = frames.flatMap((f) => (f.pending || []).map((item) => ({ ...item, frameId: f.frameId })));
  summary.pending = pending.length;
  if (pending.length && !opts.only && opts.ai !== false) {
    if (aiReady.ok) {
      summary.ai = { status: 'running', stage: 'job', asked: pending.length };
      const aiToast = opts.aiToast != null ? opts.aiToast : opts.toast;
      const run = answerWithAi(tabId, pending, { toast: aiToast && settings.toast !== false });
      if (opts.waitAi) summary.ai = await run;
    } else summary.ai = { status: aiReady.reason, asked: pending.length };
  }
  // Signing in and creating job-portal accounts (Settings › "Sign in and create job-portal accounts for me").
  const account = await accountStep(tabId, frames, settings, opts).catch((err) => ({
    lines: [`JobToFill couldn’t continue signing you in: ${String((err && err.message) || err)}`],
    end: true,
  }));
  const flowLines = (account && account.lines) || [];
  summary.account = account ? { lines: flowLines, clicked: account.clicked || [] } : null;
  // A locked vault: offer to unlock it, and fill the passwords (and carry on) once it is.
  const actions = [];
  if (summary.vaultNeeded === 'locked' && top && top.url) {
    waitForVault(tabId, top.url, opts);
    actions.push({ label: 'Unlock', action: 'unlock' });
  } else if (summary.vaultNeeded === 'none') actions.push({ label: 'Set up', action: 'setup-vault' });
  if (opts.toast && settings.toast !== false)
    await showToast(tabId, [summaryText(summary), ...flowLines].join('\n'), {
      undo: summary.undoable,
      actions,
      duration:
        summary.ai && summary.ai.status === 'running' ? 120000 : flowLines.length || actions.length ? 20000 : undefined,
    });
  else if (flowLines.length && settings.toast !== false)
    await showToast(tabId, flowLines.join('\n'), { actions, duration: 20000 });
  summary.notes.push(...flowLines);
  // The click (or the wait for a CAPTCHA) comes after the toast that announces it.
  if (account && account.act) await account.act().catch(() => {});
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
    ticked: 0,
    held: 0,
    vaultNeeded: null,
    passwordSource: null,
    // Upload fields by type: 'filled' when any frame put the document in, else how it went.
    docs: {},
  };
  for (const f of frames) {
    if (typeof f.filled !== 'number') continue;
    // prettier-ignore
    for (const key of ['filled', 'detected', 'skipped', 'failed', 'unknown', 'consents', 'restored', 'revealed', 'ticked', 'held'])
      summary[key] = (summary[key] || 0) + (f[key] || 0);
    for (const [type, status] of Object.entries(f.docs || {}))
      if (summary.docs[type] !== 'filled') summary.docs[type] = status;
    for (const key of ['missing', 'missingTypes', 'unmatched', 'notes']) summary[key].push(...(f[key] || []));
    summary.undoable = summary.undoable || !!f.undoable;
    summary.jobContext = summary.jobContext || (f.jobContext && f.filled > 0);
    summary.wantsLetter = summary.wantsLetter || !!f.wantsLetter;
    summary.vaultNeeded = summary.vaultNeeded || f.vaultNeeded || null;
    summary.passwordSource = summary.passwordSource || f.passwordSource || null;
  }
  for (const key of ['missing', 'missingTypes', 'unmatched', 'notes']) summary[key] = [...new Set(summary[key])];
  return summary;
}

function consentText(n) {
  return `${n === 1 ? 'One acknowledgement box is' : `${n} acknowledgement boxes are`} left for you to tick.`;
}

function tickedText(n) {
  return `Ticked ${n === 1 ? 'an acknowledgement box' : `${n} acknowledgement boxes`} (privacy notice, terms): untick any you don’t agree to.`;
}

function summaryText(s) {
  if (s.error) return s.error;
  if (!s.detected) return 'No fillable fields found on this page.';
  const lines = [`Filled ${s.filled} field${s.filled === 1 ? '' : 's'}.`];
  if (s.missing.length)
    lines.push(`Add to your profile: ${s.missing.slice(0, 5).join(', ')}${s.missing.length > 5 ? '…' : ''}`);
  if (s.consents) lines.push(consentText(s.consents));
  if (s.ticked) lines.push(tickedText(s.ticked));
  lines.push(...s.notes.slice(0, 2));
  if (s.ai && s.ai.status === 'running') lines.push(`Answering ${plural(s.ai.asked, 'more question')} with AI…`);
  else if (s.ai && s.ai.status === 'setup')
    lines.push(`${plural(s.ai.asked, 'question')} left: add an AI key in JobToFill settings to answer them.`);
  return lines.join('\n');
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

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

function newCredential(host, username, password, portal, note) {
  const now = Date.now();
  const cred = {
    id: util.uid(),
    host,
    username,
    password,
    createdAt: now,
    updatedAt: now,
    note: note || 'Generated by JobToFill',
  };
  if (portal) cred.portal = portal;
  return cred;
}

// tabId -> where the last password filled in that tab came from ({ source, host, portal, username }), so an account
// created with your default password can be remembered. Never the password itself.
const lastSecrets = new Map();

/** The password rules a sign-up page sent (its help text and attributes), as vault.parseRules reads them. */
function rulesFrom(msg) {
  const r = msg && msg.rules;
  if (!r || typeof r !== 'object') return null;
  return vault.parseRules({
    text: String(r.text || '').slice(0, 4000),
    minLength: +r.minLength || 0,
    maxLength: +r.maxLength || 0,
    pattern: String(r.pattern || '').slice(0, 500),
  });
}

/**
 * Passwords and cards for the frame being filled. A sign-up page gets the password saved for the site, else your
 * default password (strategy "default"), else a new one saved for the site; anything it hands a sign-up page fits
 * the rules the page states (length, kinds of character, banned characters, pattern). Your default password, when
 * the page wouldn't take it, is replaced by a fitting one saved for that site, and the fill says so. A login page
 * gets the saved password, else your default one (strategy "default").
 */
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
  const host = url.hostname;
  // Which employer on a shared portal host (SuccessFactors' "company:moodysprod"); passwords stay keyed to the host.
  const portal = typeof msg.portal === 'string' ? msg.portal.slice(0, 120) : '';

  if (msg.password) {
    const signup = msg.password === 'signup';
    const rules = signup ? rulesFrom(msg) : null;
    const personal = { email: fill.email, names: fill.names };
    const problems = (pw) => (rules ? vault.checkPassword(pw, rules, personal) : []);
    const fallback = settings.passwordStrategy === 'default' ? data.defaultPassword || '' : '';
    let cred = vault.findCredential(data, host, portal);
    let source = cred ? 'saved' : null;
    // A login saved for this host that this sign-up page wouldn't take (made for another employer here): a new one.
    if (cred && signup && problems(cred.password).length && cred.portal !== portal) cred = source = null;
    if (!cred && signup) {
      if (fallback && !problems(fallback).length) {
        cred = { username: fill.email || '', password: fallback };
        source = 'default';
      } else {
        cred = newCredential(host, fill.email || '', vault.generatePassword({ rules }), portal);
        data.credentials.push(cred);
        await vault.write(data);
        source = 'generated';
        if (fallback)
          out.notes.push(
            `Your default password doesn’t meet ${host}’s rules (${problems(fallback).join(', ')}), so JobToFill made one that does and saved it for this site.`,
          );
        else if (settings.passwordStrategy === 'default')
          out.notes.push(
            `No default password is set, so JobToFill made a password for ${host} and saved it in your vault.`,
          );
        else out.notes.push(`Generated a new password for ${host} and saved it in your vault.`);
      }
    }
    if (!cred && fallback) {
      cred = { username: fill.email || '', password: fallback };
      source = 'default';
    }
    if (cred) out.credential = { username: cred.username || fill.email || '', password: cred.password, source };
    else out.notes.push(`No saved password for ${host}.`);
    if (source && sender.tab)
      lastSecrets.set(sender.tab.id, { source, host, portal, username: (cred && cred.username) || fill.email || '' });
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

api.storage.onChanged.addListener((changes, areaName) => {
  // Re-created on every change, so the file is written once things have been quiet for half a minute.
  if (areaName === 'local' && Object.keys(changes).some(store.backsUp))
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

/*
 * The job pages each tab showed before, newest first. Many application sites drop the job from
 * their address (SuccessFactors sends everyone to apply.careers.hsbc.com/), so the job page the user
 * clicked "Apply" on is often the only way back to the posting, and this works without the history
 * permission. Only pages that look job related are kept, at most a dozen for a few hours, in session
 * storage: in memory only, gone when the browser closes, never sent anywhere.
 */
const TRAIL_MAX = 12;
const TRAIL_AGE = 3 * 3600e3;
const JOBBY =
  /job|career|vacanc|position|opening|role|intern|graduate|placement|apply|recruit|talent|hiring|posting|requisition|stellen|emploi|empleo|lavoro|vagas|greenhouse|lever\.co|ashby|workday|myworkday|icims|smartrecruiters|successfactors|taleo|oraclecloud|workable|teamtailor|recruitee|jobvite|bamboohr|breezy|pinpoint|eightfold|avature|phenom/i;
const trailKey = (tabId) => `trail:${tabId}`;
const trailArea = () => (api.storage && api.storage.session) || null;
const trailQueue = new Map();

async function readTrail(tabId) {
  const area = trailArea();
  if (!area || tabId == null) return [];
  const got = await area.get(trailKey(tabId)).catch(() => ({}));
  const now = Date.now();
  return (got[trailKey(tabId)] || []).filter((t) => t && t.url && now - t.at < TRAIL_AGE);
}

/** Changes to one tab's trail run one after another (a navigation fires several updates at once). */
function editTrail(tabId, change) {
  const area = trailArea();
  if (!area) return Promise.resolve();
  const run = () =>
    readTrail(tabId)
      .then((list) => {
        const next = change(list);
        return next && area.set({ [trailKey(tabId)]: next.slice(0, TRAIL_MAX) });
      })
      .catch(() => {});
  const done = (trailQueue.get(tabId) || Promise.resolve()).then(run);
  trailQueue.set(tabId, done);
  done.then(() => trailQueue.get(tabId) === done && trailQueue.delete(tabId));
  return done;
}

function noteVisit(tab, withTitle) {
  if (!tab || tab.incognito || !/^https?:\/\//.test(tab.url || '')) return;
  const url = tab.url.split('#')[0];
  const title = withTitle && tab.title && tab.title !== tab.url ? String(tab.title).slice(0, 200) : '';
  if (!JOBBY.test(url) && !JOBBY.test(title)) return;
  editTrail(tab.id, (list) => {
    const old = list.find((t) => t.url === url);
    if (old && old.title === (title || old.title) && Date.now() - old.at < 60e3 && list[0] === old) return null;
    const entry = { url, title: title || (old && old.title) || '', at: Date.now() };
    return [entry, ...list.filter((t) => t.url !== url)];
  });
}

api.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url) noteVisit(tab, false);
  else if (info.title || info.status === 'complete') noteVisit(tab, true);
});
// "Apply" often opens the form in a new tab: it starts with the trail of the tab it came from.
// (Chromium leaves openerTabId out of onCreated for some new tabs, so it's looked up again.)
api.tabs.onCreated.addListener(async (tab) => {
  if (tab.incognito) return;
  const opener = tab.openerTabId != null ? tab.openerTabId : (await api.tabs.get(tab.id).catch(() => ({}))).openerTabId;
  if (opener == null) return;
  const from = await readTrail(opener);
  if (from.length) editTrail(tab.id, (list) => [...list, ...from.filter((t) => !list.some((x) => x.url === t.url))]);
});
api.tabs.onRemoved.addListener((tabId) => {
  const area = trailArea();
  if (area) area.remove(trailKey(tabId)).catch(() => {});
});

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
  const here = (context.url || '').split('#')[0];
  // The tab that opened this one too, in case it opened before that tab's trail was copied.
  const tab = await api.tabs.get(tabId).catch(() => ({}));
  const own = await readTrail(tabId);
  const opened = tab.openerTabId != null ? await readTrail(tab.openerTabId) : [];
  context.trail = [...own, ...opened.filter((t) => !own.some((x) => x.url === t.url))].filter((t) => t.url !== here);
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

/* ------------------------------------------------------------ AI answers */

// Firefox asks before an add-on sends personal data anywhere (granted from the popup or settings).
const AI_DATA = { data_collection: ['personallyIdentifyingInfo', 'websiteContent'] };

async function aiConsent() {
  if (!util.isFirefox()) return true;
  try {
    return await api.permissions.contains(AI_DATA);
  } catch (err) {
    return true; // a Firefox without data-collection permissions doesn't ask
  }
}

/** Can a fill hand its leftover questions to the AI? { ok } or { ok: false, reason: off | setup | consent }. */
async function aiAvailable(settings, { force } = {}) {
  if (settings.aiAnswers === false && !force) return { ok: false, reason: 'off' };
  if (llm.problem(await store.aiConfig())) return { ok: false, reason: 'setup' };
  if (!(await aiConsent())) return { ok: false, reason: 'consent' };
  return { ok: true };
}

// tabId -> the latest AI run for that tab (what the popup shows), with its AbortController.
const aiRuns = new Map();

const runView = (run) => {
  const view = { ...run };
  delete view.controller;
  delete view.toast;
  return view;
};

function broadcast(tabId, run) {
  api.runtime.sendMessage({ type: 'jtf:ai-progress', tabId, run: runView(run) }).catch(() => {});
}

// Never fetch addresses that might do something when opened; GET only (or a JSON API's POST), no cookies.
const UNSAFE =
  /logout|log-out|signout|sign-out|unsubscribe|delete|remove|withdraw|cancel|confirm|verify|activate|reset|token=|password/i;

function safeFetch(url, init) {
  const method = ((init && init.method) || 'GET').toUpperCase();
  const isApi = !!(init && init.headers && /json/i.test(JSON.stringify(init.headers)));
  if (UNSAFE.test(url) && !isApi) return Promise.reject(new Error('skipped: looks like an action link'));
  if (method !== 'GET' && !(method === 'POST' && isApi)) return Promise.reject(new Error('skipped: not a page load'));
  return fetch(url, { credentials: 'omit', redirect: 'follow', ...init });
}

// Chromium's service worker has no DOMParser, which reading a job page's HTML needs: an offscreen document
// does that part. (Firefox's background page has one; job boards' JSON APIs need none.)
const OFFSCREEN = 'offscreen/offscreen.html';
let offscreenReady = null;

function ensureOffscreen() {
  if (!offscreenReady)
    offscreenReady = (async () => {
      const url = api.runtime.getURL(OFFSCREEN);
      const open = api.runtime.getContexts
        ? await api.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] })
        : [];
      if (!open.length)
        await api.offscreen
          .createDocument({
            url,
            reasons: ['DOM_PARSER'],
            justification: 'Read job postings from job sites to answer application questions about the job.',
          })
          .catch((err) => {
            if (!/single offscreen|already/i.test(String(err && err.message))) throw err;
          });
    })().catch((err) => {
      offscreenReady = null;
      throw err;
    });
  return offscreenReady;
}

/** The posting behind an application (jobpage.find), with HTML pages read where a DOMParser is. */
async function findPosting(context) {
  const opts = { fetch: safeFetch, now: Date.now(), budget: 6, timeout: 8000 };
  if (typeof DOMParser === 'undefined' && api.offscreen) {
    try {
      await ensureOffscreen();
      const r = await api.runtime.sendMessage({ type: 'jtf:offscreen-find', context });
      if (r && r.found) return r.found;
    } catch (err) {
      /* fall back to the board APIs, which need no DOMParser */
    }
  }
  return jobpage.find(context, opts);
}

/* ---------------------------------------------------- verification codes */

// The verification code watcher (content/otp.js) runs on its own: it is small, and once Nylas is connected
// it goes into every page as it loads, so a code box is filled without anyone pressing anything.
const OTP_FILES = ['content/otp.js'];
const OTP_EXPLICIT_LOOKBACK = 15 * 60e3;

/** Start the code watcher in a tab's frames. */
async function watchOtp(tabId, frameIds, options) {
  const probe = await execute(tabId, frameIds, { func: () => !!globalThis.__jtfOtp });
  const missing = probe.filter((r) => !r.result).map((r) => r.frameId);
  if (missing.length) await execute(tabId, missing, { files: OTP_FILES });
  const settings = store.otpSettings(await store.getSettings());
  return execute(tabId, frameIds, {
    func: (opts) => globalThis.__jtfOtp && globalThis.__jtfOtp.watch(opts),
    args: [{ links: settings.links !== false, ...(options || {}) }],
  });
}

async function otpReady() {
  const config = await store.getNylas();
  return config && config.grantId ? config : null;
}

api.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (
    info.status !== 'complete' ||
    !tab ||
    tab.incognito ||
    !/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(tab.url || '')
  )
    return;
  try {
    if (!(await otpReady()) || store.otpSettings(await store.getSettings()).auto === false) return;
    await watchOtp(tabId);
  } catch (err) {
    /* a page that can't be scripted */
  }
});

// Remembered in session storage (memory only, cleared when the browser closes): the emails whose code has
// been used, so one code isn't typed twice, and codes offered with "Use it" but not yet taken.
const memory = new Map();
const sessionArea = () =>
  (api.storage && api.storage.session) || {
    get: async (k) => (memory.has(k) ? { [k]: memory.get(k) } : {}),
    set: async (o) => Object.entries(o).forEach(([k, v]) => memory.set(k, v)),
    remove: async (keys) => [].concat(keys).forEach((k) => memory.delete(k)),
  };

async function sessionGet(key, fallback) {
  const got = await sessionArea()
    .get(key)
    .catch(() => ({}));
  return got[key] != null ? got[key] : fallback;
}

async function markUsed(id) {
  const used = await sessionGet('otpUsed', []);
  await sessionArea().set({ otpUsed: [id, ...used.filter((x) => x !== id)].slice(0, 100) });
}

// Every frame of a page polls on its own: one request to Nylas serves them all for a few seconds.
let mailCache = null;
async function recentMail(config, since) {
  const now = Date.now();
  if (mailCache && mailCache.grant === config.grantId && now - mailCache.at < 2500 && mailCache.since <= since)
    return mailCache.list;
  const list = await nylas.messages(config, { since, limit: 15 });
  mailCache = { grant: config.grantId, at: now, since, list };
  return list;
}

const sameSite = (a, b) => {
  const [x, y] = [otp.site(a), otp.site(b)];
  return x === y || (!!otp.familyOf(x) && otp.familyOf(x) === otp.familyOf(y));
};

const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch (err) {
    return '';
  }
};

/**
 * What the AI needs to know about the job behind the application in a tab: { company, title, location, url,
 * description, summary, companyNotes }. From the job found for this tab before, the letter written for this
 * application, the page itself, or the job site's listing (proved to be the same job).
 */
async function jobFor(tabId) {
  const tab = await api.tabs.get(tabId).catch(() => null);
  const url = (tab && tab.url) || '';
  const host = hostOf(url);
  // The job found for this tab before, unless the tab has moved on to another job (another job id in the address).
  const cached = await store.getTabJob(tabId);
  if (cached && cached.host === host && cached.job && !store.otherJob(cached.url, url)) return cached.job;

  let job;
  const letter = await store.letterFor({ tabId, url, trail: await readTrail(tabId) });
  if (letter && letter.analysis) {
    const a = letter.analysis;
    const p = letter.posting || {};
    const list = (label, xs) => (xs && xs.length ? `${label}: ${xs.join('; ')}` : '');
    job = {
      company: a.company || p.company || '',
      title: a.role || p.title || '',
      location: a.location || p.location || '',
      url: p.url || url,
      summary: [
        a.summary,
        a.team && `Team: ${a.team}`,
        list('Responsibilities', a.responsibilities),
        list('Requirements', a.requirements),
        list('Values', a.values),
        a.asks && `The employer asks applicants to cover: ${a.asks}`,
      ]
        .filter(Boolean)
        .join('\n'),
    };
  } else {
    const context = await jobContext(tabId);
    const found = await findPosting(context).catch(() => null);
    const sameCompany = (p) =>
      !!p &&
      !!p.company &&
      !!context.company &&
      util.normalize(p.company).split(' ')[0] === util.normalize(context.company).split(' ')[0];
    const ok =
      found &&
      found.posting &&
      (['same', 'likely'].includes(found.verdict) || (found.verdict === 'unsure' && sameCompany(found.posting)));
    const onPage =
      context.posting && String(context.posting.description || '').split(/\s+/).length > 120 ? context.posting : null;
    const posting = (ok && found.posting) || onPage;
    const hint = (found && found.hint) || null;
    job = {
      company: (posting && posting.company) || context.company || (hint && hint.company) || '',
      title: (posting && posting.title) || (hint && hint.programme) || context.title || '',
      location: (posting && posting.location) || context.location || ((hint && hint.locations) || []).join(', '),
      url: (posting && posting.url) || url,
      description: (posting && posting.description) || '',
      companyNotes: (hint && hint.about) || '',
    };
  }
  await store.setTabJob(tabId, { host, url, job });
  return job;
}

/** The text of the profile's CV, read once per file and kept with the cover letter material. */
async function cvTextFor(profile, kit) {
  const doc = await store.getDoc(profile.id, 'resume');
  if (!doc) return '';
  if (kit.cv && kit.cv.updatedAt === doc.updatedAt && kit.cv.name === doc.name) return kit.cv.text || '';
  try {
    const out = await doctext.fromDataUrl(doc.dataUrl, { type: doc.type, name: doc.name });
    await store.saveKit(profile.id, { cv: { name: doc.name, updatedAt: doc.updatedAt, text: out.text } });
    return out.text;
  } catch (err) {
    await store.saveKit(profile.id, { cv: { name: doc.name, updatedAt: doc.updatedAt, text: '', error: err.message } });
    return '';
  }
}

function aiSummaryText(run) {
  if (run.status === 'error') return `AI answers: ${run.error}`;
  if (!run.answered && !run.asked) return 'No questions left to answer.';
  const lines = [];
  if (run.filled)
    lines.push(`AI answered ${plural(run.filled, 'question')} (dashed orange outline). Read them before you submit.`);
  else if (run.answered) lines.push('The AI’s answers couldn’t be put into the form.');
  const left = run.asked - run.filled;
  if (left > 0) lines.push(`${plural(left, 'question')} left for you.`);
  return lines.join('\n');
}

/**
 * One round of AI answers: reuse what this application already has, write the rest, put them into the form,
 * save the new ones. `pending`: the frames' reports, each with its frameId. Returns what was answered.
 */
async function answerRound(tabId, pending, ctx) {
  const { profile, settings, config, controller, report, tab } = ctx;
  // Ids are per frame: the model gets them unique.
  const items = pending.map((p) => ({ ...p, id: `${p.frameId}:${p.id}` }));
  const byId = new Map(items.map((it) => [it.id, it]));
  const { reused, rest } = answers.reuse(items, await store.answersFor({ profileId: profile.id, tabId, url: tab.url }));
  let written = { answers: [], skipped: [], calls: 0 };
  if (rest.length) {
    if (!ctx.job) {
      report({ stage: 'job' });
      ctx.job = (await jobFor(tabId).catch(() => null)) || {};
    }
    report({ stage: 'writing', company: ctx.job.company || '' });
    const kit = await store.getKit(profile.id);
    const [cvText, bank] = await Promise.all([cvTextFor(profile, kit), store.answerBank(profile.id)]);
    const chat = async (messages, options) => {
      const r = await llm.chat(config, { messages, ...options, signal: controller.signal });
      if (r.usage && typeof r.usage.cost === 'number') ctx.cost = (ctx.cost || 0) + r.usage.cost;
      return r;
    };
    // The candidate's own rules for answers: the answer guidance in settings and the profile's extra details.
    const guidance = [kit.answerNotes, profile.extraDetails]
      .map((x) => String(x || '').trim())
      .filter(Boolean)
      .join('\n\n');
    written = await answers.answer(
      chat,
      { profile, kit, cvText, job: ctx.job, bank, guidance, today: Date.now() },
      rest,
      {
        signal: controller.signal,
        onProgress: (stage) => report({ stage }),
      },
    );
  }
  if (controller.signal.aborted) throw Object.assign(new Error('Stopped.'), { name: 'AbortError' });

  report({ stage: 'filling' });
  const all = [...reused, ...written.answers];
  const frameOf = (id) => id.split(':')[0];
  const localId = (id) => id.split(':').slice(1).join(':');
  const status = new Map();
  let filled = 0;
  for (const frameId of [...new Set(all.map((a) => frameOf(a.id)))]) {
    const list = all
      .filter((a) => frameOf(a.id) === frameId)
      .map((a) => ({ ...a, id: localId(a.id), question: byId.get(a.id).question }));
    const out = await callFrames(tabId, 'applyAnswers', [list, { settings }], [Number(frameId)]).catch(() => []);
    for (const f of out) {
      filled += f.filled || 0;
      for (const r of f.results || []) status.set(`${frameId}:${r.id}`, r.status);
    }
  }
  if (written.answers.length)
    await store.saveAnswers({
      profileId: profile.id,
      url: tab.url,
      host: hostOf(tab.url),
      tabId,
      company: ctx.job.company || '',
      role: ctx.job.title || '',
      items: written.answers.map((a) => {
        const it = byId.get(a.id);
        return {
          key: answers.questionKey(it),
          question: it.question,
          kind: a.kind,
          value: a.value,
          basis: a.basis,
          warnings: a.warnings,
        };
      }),
    });
  return {
    keys: items.map((it) => answers.questionKey(it)),
    answered: all.length,
    filled,
    items: all.map((a) => ({
      question: byId.get(a.id).question,
      value: a.value,
      basis: a.basis,
      warnings: a.warnings || [],
      reused: !!a.reused,
      filled: status.get(a.id) === 'filled',
    })),
    skipped: written.skipped.map((x) => ({
      question: (byId.get(x.id) || {}).question || '',
      reason: x.reason,
      withheld: x.withheld || null,
    })),
  };
}

/**
 * Answer the questions a fill left empty and put the answers into the form. An answer can bring up a question
 * of its own ("Other" → "Please specify"): those get one more round.
 */
async function answerWithAi(tabId, pending, opts = {}) {
  const prior = aiRuns.get(tabId);
  if (prior && prior.status === 'running') prior.controller.abort();
  const controller = new AbortController();
  const run = {
    status: 'running',
    stage: 'job',
    asked: pending.length,
    answered: 0,
    filled: 0,
    items: [],
    skipped: [],
    startedAt: Date.now(),
    controller,
    // Say on the page when it's done (Quick apply turns this on for a run it finds still going).
    toast: !!opts.toast,
  };
  aiRuns.set(tabId, run);
  const report = (patch) => {
    Object.assign(run, patch);
    broadcast(tabId, run);
  };
  await callFrames(tabId, 'hold', [240000], [0]).catch(() => {});
  try {
    const { profile, settings } = await store.getActive();
    const ctx = {
      profile,
      settings,
      config: await store.aiConfig(),
      controller,
      report,
      tab: await api.tabs.get(tabId),
      job: null,
      cost: 0,
    };
    const first = await answerRound(tabId, pending, ctx);
    const total = { ...first };
    if (first.filled) {
      // Give the page a moment to show what the answers revealed, then answer only questions not asked before.
      await new Promise((resolve) => setTimeout(resolve, 700));
      const frames = await callFrames(tabId, 'pending', [{ profile, settings, ai: true }]).catch(() => []);
      const seen = new Set(first.keys);
      const fresh = frames
        .flatMap((f) => (f.items || []).map((item) => ({ ...item, frameId: f.frameId })))
        .filter((item) => !seen.has(answers.questionKey(item)));
      if (fresh.length) {
        report({ asked: run.asked + fresh.length, items: first.items });
        const next = await answerRound(tabId, fresh, ctx);
        Object.assign(total, {
          answered: first.answered + next.answered,
          filled: first.filled + next.filled,
          items: [...first.items, ...next.items],
          skipped: [...first.skipped, ...next.skipped],
        });
      }
    }
    report({
      status: 'done',
      stage: 'done',
      answered: total.answered,
      filled: total.filled,
      items: total.items,
      skipped: total.skipped,
      company: (ctx.job && ctx.job.company) || '',
      cost: ctx.cost,
      finishedAt: Date.now(),
    });
    if (run.toast) await showToast(tabId, aiSummaryText(run), { undo: total.filled > 0 });
    return runView(run);
  } catch (err) {
    const error = err && err.name === 'AbortError' ? 'Stopped.' : String((err && err.message) || err);
    report({ status: 'error', stage: 'done', error });
    if (run.toast && error !== 'Stopped.') await showToast(tabId, aiSummaryText(run));
    return runView(run);
  } finally {
    callFrames(tabId, 'release', [], [0]).catch(() => {});
  }
}

/** "Answer with AI" from the popup: the questions on the page now, whatever the setting says. */
async function answerPage(tabId, opts = {}) {
  const { profile, settings } = await store.getActive();
  const ready = await aiAvailable(settings, { force: true });
  if (!ready.ok) return { status: ready.reason };
  const frames = await callFrames(tabId, 'pending', [{ profile, settings, ai: true }]);
  const pending = frames.flatMap((f) => (f.items || []).map((item) => ({ ...item, frameId: f.frameId })));
  if (!pending.length) return { status: 'done', asked: 0, answered: 0, filled: 0, items: [], skipped: [] };
  const run = answerWithAi(tabId, pending, { toast: !!opts.toast });
  return opts.wait ? run : { status: 'running', stage: 'job', asked: pending.length };
}

// The page keeps a port open while the AI works; each ping is an event, which keeps this worker awake.
api.runtime.onConnect.addListener((port) => {
  if (port.name === 'jtf-hold') port.onMessage.addListener(() => {});
});

/* ------------------------------------------------------------ quick apply */

const QUICK_STALE = 15 * 60e3;
// What Quick apply writes for the application: the CV and letter uploads and the pasted letter wait for it.
const QUICK_DOCS = ['file.resume', 'file.coverLetter', 'coverLetter'];
// tabId -> the fill Quick apply starts with (a promise of its summary). What it did is kept in session
// storage too (quickFirst:<tabId>), in case this worker is restarted while the letter is being written.
const quickFirst = new Map();
const quickFirstKey = (tabId) => `quickFirst:${tabId}`;

/** Is Quick apply still writing the letter and CV for the application in this tab? */
async function quickRunningFor(tabId) {
  const status = await store.getQuickStatus().catch(() => null);
  return !!status && status.state === 'running' && status.tabId === tabId && Date.now() - status.at < QUICK_STALE;
}

/**
 * "Quick apply": the whole letter, CV and form in one go. The form gets your details at once (everything
 * but the CV and letter, which it is about to write). The AI work runs in the studio page (long calls die in
 * the worker), opened here as a background tab next to the application with ?quick=1; it reports progress
 * through store.setQuickStatus and asks for the rest of the fill with 'jtf:quick-fill'.
 */
async function quickStart(tabId) {
  const tab = await api.tabs.get(tabId).catch(() => null);
  if (!tab || !/^(https?|file):/.test(tab.url || '')) return { error: CANT_RUN };
  const status = await store.getQuickStatus();
  if (status && status.state === 'running') {
    const fresh = Date.now() - status.at;
    const alive =
      status.studioTabId == null ? fresh < 60e3 : !!(await api.tabs.get(status.studioTabId).catch(() => null));
    if (alive && fresh < QUICK_STALE) return { error: 'Quick apply is already running.' };
  }
  await store.clearQuickApply(); // the previous result goes as soon as a new one is requested
  await sessionArea()
    .remove(quickFirstKey(tabId))
    .catch(() => {});
  await store.setQuickStatus({ state: 'running', message: 'filling in your details…', tabId, studioTabId: null });
  const url = api.runtime.getURL('studio/studio.html') + `?tab=${tabId}&quick=1`;
  const studio = await api.tabs.create({ url, active: false, windowId: tab.windowId, index: tab.index + 1 });
  const now = await store.getQuickStatus();
  if (now && now.state === 'running' && now.studioTabId == null)
    await store.setQuickStatus({ ...now, studioTabId: studio.id });
  quickFirst.set(tabId, quickFirstFill(tabId));
  return { ok: true, studioTabId: studio.id };
}

/** Quick apply's first fill: your details (acknowledgements ticked) while the letter and CV are written. */
async function quickFirstFill(tabId) {
  let summary;
  try {
    summary = await fillTab(tabId, { quick: true, hold: QUICK_DOCS, consents: true, aiToast: false, flow: true });
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
  if (summary.error) return summary;
  await sessionArea()
    .set({ [quickFirstKey(tabId)]: { filled: summary.filled, detected: summary.detected, ticked: summary.ticked } })
    .catch(() => {});
  // Unless the letter is already done and the last fill has said its piece.
  if (!(await quickRunningFor(tabId))) return summary;
  const lines = [];
  if (summary.filled) lines.push(`Quick apply: your details are in (${plural(summary.filled, 'field')}).`);
  if (summary.account && summary.account.lines.length) lines.push(...summary.account.lines);
  lines.push(
    summary.detected || summary.held
      ? 'Now writing your cover letter and tailoring your CV: they go in by themselves when ready (a minute or two), no need to press Fill.'
      : 'Quick apply is writing your cover letter and tailoring your CV.',
  );
  if (summary.ticked) lines.push(tickedText(summary.ticked));
  if (summary.ai && summary.ai.status === 'running')
    lines.push(`The AI is answering ${plural(summary.ai.asked, 'other question')}.`);
  await showToast(tabId, lines.join('\n'), { undo: summary.undoable, duration: 30000 });
  return summary;
}

/** What Quick apply's first fill did in this tab ({} when it didn't run), and forget it. */
async function takeQuickFirst(tabId) {
  const running = quickFirst.get(tabId);
  quickFirst.delete(tabId);
  if (running) await running.catch(() => null);
  const kept = await sessionGet(quickFirstKey(tabId), null);
  await sessionArea()
    .remove(quickFirstKey(tabId))
    .catch(() => {});
  return kept || {};
}

/**
 * The studio finished writing: attach its letter (and tailored CV) to this tab and fill the rest of the form.
 * The letter and tailored CV take the place of anything already in their fields (the usual CV a Fill put
 * there, say); everything else is only filled where it is still empty. Says what happened on the page.
 */
async function quickFill(tabId, letterId, options) {
  const tab = await api.tabs.get(tabId).catch(() => null);
  if (!tab) return { error: 'The application tab was closed.' };
  const letter = (await store.getLetters()).find((l) => l.id === letterId);
  if (!letter) return { error: 'The letter could not be found.' };
  await store.saveLetter({ id: letterId, tabId, attachedAt: Date.now(), url: tab.url });
  const first = await takeQuickFirst(tabId);
  const withCv = !!(options && options.cv);
  // AI answers the first fill started carry on (and say when they're in): a new run would start them over.
  const prior = aiRuns.get(tabId);
  const busy = !!prior && prior.status === 'running';
  const replace = ['file.coverLetter', 'coverLetter', ...(withCv ? ['file.resume'] : [])];
  const summary = await fillTab(tabId, { quick: true, consents: true, replace, ai: !busy, aiToast: true });
  if (summary.error) return { error: summary.error };
  if (busy) prior.toast = true;
  const run = summary.ai && summary.ai.status === 'running' ? summary.ai : aiRuns.get(tabId);
  const done = quickDoneText(summary, first, { withCv, run: run ? runView(run) : null });
  await showToast(tabId, done.text, { undo: summary.undoable, duration: 20000 });
  return {
    filled: summary.filled + (first.filled || 0),
    detected: summary.detected,
    ai: summary.ai && summary.ai.filled,
    letter: done.letter,
    cv: done.cv,
    ticked: summary.ticked + (first.ticked || 0),
  };
}

/** The toast at the end of a Quick apply: what went in, and anything left to do by hand. */
function quickDoneText(summary, first, { withCv, run }) {
  const docs = summary.docs || {};
  const letter = docs['file.coverLetter'] === 'filled' || docs.coverLetter === 'filled';
  const cv = docs['file.resume'] === 'filled';
  const lines = [];
  if (!summary.detected && !first.detected) {
    lines.push(
      'Quick apply wrote your cover letter and tailored your CV, but this page has no form. On the application form, press Fill: they go in with your details.',
    );
    return { text: lines.join('\n'), letter, cv };
  }
  const parts = [letter && 'cover letter', cv && (withCv ? 'tailored CV' : 'CV'), 'your details'].filter(Boolean);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  lines.push(`Quick apply done: ${list} are in.${withCv ? '' : ' (CV not tailored.)'} Review before submitting.`);
  if (withCv && !cv)
    lines.push(
      docs['file.resume']
        ? 'The tailored CV couldn’t go into the CV upload: attach it by hand (it’s under Last quick apply in the JobToFill popup).'
        : 'There’s no free CV upload here. If your usual CV is already attached, remove it and press Fill: the tailored one goes in (a later step gets it too).',
    );
  if (!letter)
    lines.push(
      summary.wantsLetter
        ? 'The cover letter couldn’t go in: attach it by hand (it’s under Last quick apply in the JobToFill popup).'
        : 'This page doesn’t ask for a cover letter; it’s under Last quick apply if you need it.',
    );
  const ticked = (summary.ticked || 0) + (first.ticked || 0);
  if (ticked) lines.push(tickedText(ticked));
  if (summary.missing.length)
    lines.push(
      `Add to your profile: ${summary.missing.slice(0, 5).join(', ')}${summary.missing.length > 5 ? '…' : ''}`,
    );
  if (run && run.status === 'running')
    lines.push(`The AI is still answering ${plural(run.asked, 'question')}: it says here when they’re in.`);
  else if (run && run.status === 'done' && run.filled)
    lines.push(`AI answered ${plural(run.filled, 'question')} (dashed orange outline): check them.`);
  return { text: lines.join('\n'), letter, cv };
}

/**
 * Quick apply stopped before the letter was ready: put in what its first fill held back (your usual CV and
 * letter, as a Fill would), so the form isn't left without them, and say why it stopped.
 */
async function quickRelease(tabId, message) {
  await takeQuickFirst(tabId);
  const tab = await api.tabs.get(tabId).catch(() => null);
  if (!tab) return { attached: false };
  const summary = await fillTab(tabId, { quick: true, only: QUICK_DOCS, force: false });
  const attached = !summary.error && (summary.docs || {})['file.resume'] === 'filled';
  if (message)
    await showToast(
      tabId,
      `Quick apply stopped: ${message}${attached ? '\nYour usual CV was attached instead.' : ''}`,
      { duration: 20000 },
    );
  return { attached };
}

api.tabs.onRemoved.addListener(async (tabId) => {
  const status = await store.getQuickStatus().catch(() => null);
  if (status && status.state === 'running' && status.studioTabId === tabId) {
    const message = 'its tab was closed.';
    await store.setQuickStatus({ ...status, state: 'error', message: `Quick apply stopped: ${message}` });
    if (status.tabId != null) await quickRelease(status.tabId, message).catch(() => {});
  }
});

/**
 * A content script asks for the code (or verify link) a page is waiting for. Only a code from an email
 * that clearly comes from this site is handed over; one from an unrecognised sender is only offered
 * ("Use it"), never filled by itself. Codes go to secure pages only.
 */
async function otpFor(msg, sender) {
  const config = await otpReady();
  if (!config) return { stop: true };
  let url;
  try {
    url = new URL(sender.url);
  } catch (err) {
    return { stop: true };
  }
  if (!isSecureUrl(url)) return { stop: true };
  const settings = store.otpSettings(await store.getSettings());
  if (msg.kind === 'link' && (settings.links === false || sender.frameId !== 0)) return { stop: true };
  // A framed form shares the top page's trust only when it is the same site (or the same tracking
  // system): an ad or widget frame on careers.acme.com doesn't get Acme's code.
  const top = hostOf(sender.tab && sender.tab.url);
  const hosts = [url.hostname];
  if (top && top !== url.hostname && sameSite(url.hostname, top)) hosts.push(top);
  const since = Math.max(Number(msg.since) || 0, Date.now() - 30 * 60e3);
  let list;
  try {
    list = await recentMail(config, since);
  } catch (err) {
    return { error: err.message, fatal: ['key', 'grant', 'setup'].includes(err.code) };
  }
  const want =
    msg.want && typeof msg.want === 'object' ? { length: +msg.want.length || 0, numeric: !!msg.want.numeric } : {};
  const found = otp.pick(list, {
    kind: msg.kind === 'link' ? 'link' : 'code',
    hosts,
    since,
    want,
    used: await sessionGet('otpUsed', []),
  });
  if (!found) return { waiting: true };
  const from = found.from || 'your inbox';

  if (msg.kind === 'link') {
    if (found.relevance !== 'strong') return { waiting: true };
    await markUsed(found.id);
    const tab = sender.tab || {};
    await api.tabs.create({
      url: found.link,
      active: false,
      index: tab.index != null ? tab.index + 1 : undefined,
      openerTabId: tab.id,
    });
    return { opened: true, from };
  }
  if (found.relevance === 'strong') {
    await markUsed(found.id);
    return { code: found.code, from, subject: found.subject };
  }
  // Not obviously from this site: offer it, and keep the code here until the person says yes.
  const token = util.uid();
  const claims = (await sessionGet('otpClaims', {})) || {};
  for (const [k, c] of Object.entries(claims)) if (c.expires < Date.now()) delete claims[k];
  claims[token] = {
    code: found.code,
    id: found.id,
    tabId: sender.tab && sender.tab.id,
    expires: Date.now() + 5 * 60e3,
  };
  await sessionArea().set({ otpClaims: claims });
  return { suggest: token, from, subject: found.subject };
}

async function otpClaim(msg, sender) {
  const claims = (await sessionGet('otpClaims', {})) || {};
  const claim = claims[msg.token];
  if (!claim || claim.expires < Date.now() || claim.tabId !== (sender.tab && sender.tab.id))
    return { error: 'That code has expired.' };
  delete claims[msg.token];
  await sessionArea().set({ otpClaims: claims });
  await markUsed(claim.id);
  return { code: claim.code };
}

/** Right-click → "Insert verification code from email": the newest code, into the box you clicked. */
async function insertOtp(tab, info, frameIds) {
  const config = await otpReady();
  if (!config) {
    await showToast(tab.id, 'Connect your inbox first: JobToFill settings › Email codes.', {}, frameIds);
    return;
  }
  let url = null;
  try {
    url = new URL(info.frameUrl || tab.url);
  } catch (err) {
    /* not a web page */
  }
  if (!url || !isSecureUrl(url) || tab.incognito) {
    await showToast(tab.id, 'Verification codes are only filled on secure (https) pages.', {}, frameIds);
    return;
  }
  const hosts = [url.hostname, hostOf(tab.url)].filter(Boolean);
  const since = Date.now() - OTP_EXPLICIT_LOOKBACK;
  let found;
  try {
    const list = await nylas.messages(config, { since, limit: 15 });
    found = otp.pick(list, { kind: 'code', hosts, since, explicit: true });
  } catch (err) {
    await showToast(tab.id, err.message, {}, frameIds);
    return;
  }
  if (!found) {
    await watchOtp(tab.id, frameIds);
    await showToast(
      tab.id,
      'No code in your inbox from the last 15 minutes yet. JobToFill will keep checking.',
      {},
      frameIds,
    );
    return;
  }
  await markUsed(found.id);
  await execute(tab.id, frameIds, { files: OTP_FILES });
  await execute(tab.id, frameIds, {
    func: (code) => globalThis.__jtfOtp && globalThis.__jtfOtp.fillFocused(code),
    args: [found.code],
  });
  await showToast(tab.id, `Inserted the code from ${found.from || 'your inbox'}.`, {}, frameIds);
}

/* ------------------------------------------------------ portal accounts */

/*
 * Signing in and creating job-portal accounts (Settings › "Sign in and create job-portal accounts for me", on by
 * default). After a fill the person started (button, shortcut, menu, Quick apply), on a secure page that is only
 * a sign-in or sign-up form (no job-application questions or uploads):
 *   - sign-in page, a login saved for this site (and employer): click its sign-in button;
 *   - sign-in page, no known account: click its "Create account" link, and fill the sign-up page that opens;
 *   - sign-up page: once everything is in and any CAPTCHA is solved by the person, click "Create account"; the
 *     code it emails is typed in by the code watcher, which then confirms that step;
 *   - "An account with this email already exists": go back to sign in, with the saved or default password.
 * One flow per tab, kept for minutes in session storage, at most FLOW_CLICKS clicks, only on the same site (and
 * employer), ended when the tab goes elsewhere. The page side (content/account.js) only clicks controls whose
 * wording passes JTF.accounts.intent(), and re-checks the page before each click.
 */
const FLOW_TTL = 10 * 60e3;
const FLOW_CLICKS = 6;
const FLOW_WAIT = 5 * 60e3; // how long a CAPTCHA or the terms are waited for
const flowKey = (tabId) => `flow:${tabId}`;

async function getFlow(tabId) {
  if (tabId == null) return null;
  const flow = await sessionGet(flowKey(tabId), null);
  if (flow && flow.expires < Date.now()) {
    await endFlow(tabId);
    return null;
  }
  return flow;
}

async function putFlow(flow) {
  await sessionArea()
    .set({ [flowKey(flow.tabId)]: flow })
    .catch(() => {});
}

async function endFlow(tabId) {
  await sessionArea()
    .remove(flowKey(tabId))
    .catch(() => {});
}

function flowPlace(url) {
  const host = hostOf(url);
  return { site: host ? siteOf(host) : '', family: (host && otp.familyOf(otp.site(host))) || '' };
}

/** Is `url` still the flow's site (or its tracking system) and employer? */
function sameFlowSite(flow, url, portal) {
  const place = flowPlace(url);
  if (!place.site || !(place.site === flow.site || (place.family && place.family === flow.family))) return false;
  return !(portal && flow.portal && portal !== flow.portal);
}

const quote = (list) => list.map((x) => `“${x}”`).join(', ');

function joinList(items) {
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : items[0] || '';
}

/** "Complete the “I’m not a robot” check and accept the Terms of Use". */
function waitText(waits) {
  const parts = [];
  if (waits.some((b) => b.kind === 'captcha')) parts.push('complete the “I’m not a robot” check');
  if (waits.some((b) => b.kind === 'robot')) parts.push('tick “I’m not a robot”');
  const terms = waits.filter((b) => b.kind === 'terms').map((b) => b.label);
  if (terms.length) parts.push(`accept ${joinList(terms.map((t) => `“${t}”`))}`);
  const text = joinList(parts);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Is there an account at this site (and employer) as far as the vault knows? */
async function accountKnown(page) {
  if ((await vault.status()) !== 'unlocked') return false;
  return !!vault.findCredential(await vault.read(), page.host, page.portal, true);
}

/**
 * An account created with your default password: remember it in the vault, so later sign-ins know it exists.
 * Returns the new login's id (taken back if the site then says the account already existed).
 */
async function rememberDefault(tabId, page) {
  const last = lastSecrets.get(tabId);
  if (!last || last.source !== 'default' || last.host !== page.host) return null;
  if ((await vault.status()) !== 'unlocked') return null;
  let id = null;
  await vault.update((data) => {
    if (!data.defaultPassword || vault.findCredential(data, page.host, last.portal, true)) return;
    const cred = newCredential(
      page.host,
      last.username,
      data.defaultPassword,
      last.portal,
      'Created with your default password',
    );
    data.credentials.push(cred);
    id = cred.id;
  });
  return id;
}

/** The site said the account already existed: it wasn't made with your default password after all. */
async function forgetRemembered(flow) {
  if (!flow.remembered || (await vault.status()) !== 'unlocked') return;
  const id = flow.remembered;
  flow.remembered = null;
  await vault.update((data) => (data.credentials = data.credentials.filter((c) => c.id !== id)));
}

/** Click one of the page's account controls (after the toast): record it, or end the flow and say why not. */
function clickStep(tabId, flow, page, which, line, after) {
  flow.clicks.push({
    which,
    label: which === 'to-signup' ? page.toSignup : which === 'to-signin' ? page.toSignin : page.submit,
    kind: page.kind,
    url: page.url,
    at: Date.now(),
  });
  if (after) Object.assign(flow, after);
  return {
    lines: [line],
    clicked: flow.clicks.map((c) => c.label),
    act: async () => {
      // The code it emails: watched for in this tab, whatever "Fill codes by themselves" says.
      if (which === 'submit' && page.kind === 'signup' && (await otpReady())) await watchOtp(tabId).catch(() => {});
      const { profile } = await store.getActive();
      const [res] = await callFrames(tabId, 'accountClick', [which, { profile }], [page.frameId]).catch(() => [null]);
      if (res && res.clicked) {
        if (which === 'submit' && page.kind === 'signup') {
          flow.remembered = await rememberDefault(tabId, page).catch(() => null);
          if (flow.remembered) await putFlow(flow);
        }
        return;
      }
      await endFlow(tabId);
      const why = { 'not ready': 'the page isn’t ready', covered: 'something covers it' }[res && res.refused];
      await showToast(
        tabId,
        `JobToFill didn’t click “${flow.clicks[flow.clicks.length - 1].label}”${why ? `: ${why}` : ''}. Finish here yourself.`,
        { duration: 12000 },
      );
    },
  };
}

/** The next step on a sign-in, sign-up or code page: { lines, act?, end? }. */
async function flowDecide(tabId, flow, page) {
  const host = page.host;
  const stop = (line) => ({ lines: [line], end: true, clicked: flow.clicks.map((c) => c.label) });
  if (page.kind === 'verify') {
    flow.stage = 'verify';
    if (await otpReady()) {
      await watchOtp(tabId).catch(() => {});
      return { lines: ['Waiting for the code emailed to you: JobToFill types it in and carries on.'] };
    }
    return stop(
      'Enter the code emailed to you (connect your inbox under JobToFill › Email codes to have it typed in).',
    );
  }
  if (flow.clicks.length >= FLOW_CLICKS)
    return stop(`JobToFill stopped after ${FLOW_CLICKS} steps: finish here yourself.`);
  if (page.kind === 'signup' && page.exists) {
    flow.accountExists = true;
    await forgetRemembered(flow).catch(() => {});
    if (page.toSignin)
      return clickStep(
        tabId,
        flow,
        page,
        'to-signin',
        `An account with your email already exists on ${host}: going to “${page.toSignin}”…`,
        { stage: 'to-signin' },
      );
    return stop(`An account with your email already exists on ${host}: sign in with your password.`);
  }
  if (page.kind === 'login' && page.badLogin)
    return stop(
      `Signing in to ${host} didn’t work. Check the password saved for it under JobToFill › Passwords & cards, or reset it on the site.`,
    );
  if (page.errors.length) return stop(`The page says: “${page.errors[0]}”. Fix that and press Fill again.`);
  const locked = (await vault.status()) !== 'unlocked';
  if (page.kind === 'login' && !locked && !flow.accountExists && !(await accountKnown(page))) {
    if (page.toSignup && flow.stage !== 'to-signin') {
      flow.stage = 'to-signup';
      return clickStep(
        tabId,
        flow,
        page,
        'to-signup',
        `No account for ${host} in JobToFill yet: opening “${page.toSignup}” to create one…`,
      );
    }
    if (!page.passwordFilled)
      return stop(`No login for ${host} saved in JobToFill: sign in yourself, or create an account.`);
  }
  if (!page.passwordFilled) {
    if (locked) return { lines: ['Unlock JobToFill: it then fills your password and carries on.'] };
    return stop(
      page.kind === 'signup'
        ? 'No password to create the account with: fill one in and press Fill again.'
        : `No password for ${host}: sign in yourself.`,
    );
  }
  const doing = page.kind === 'signup' ? 'creates the account' : 'signs you in';
  const typed = page.blockers.filter((b) => !b.wait);
  if (typed.length)
    return stop(`Fill in ${joinList(typed.map((b) => `“${b.label}”`))} and press Fill again: JobToFill then ${doing}.`);
  const waits = page.blockers.filter((b) => b.wait);
  if (waits.length) {
    flow.waiting = { token: util.uid(), frameId: page.frameId, since: Date.now() };
    flow.expires = Math.max(flow.expires, Date.now() + FLOW_WAIT + 60e3);
    const token = flow.waiting.token;
    return {
      lines: [`${waitText(waits)}: JobToFill then ${doing}.`],
      act: async () => {
        const { profile } = await store.getActive();
        await callFrames(tabId, 'accountWait', [token, { timeout: FLOW_WAIT, profile }], [page.frameId]).catch(
          () => {},
        );
      },
    };
  }
  if (!page.ready || !page.submit)
    return stop(`JobToFill couldn’t find the button that ${doing}: finish here yourself.`);
  if (page.kind === 'signup')
    return clickStep(tabId, flow, page, 'submit', `Creating your account on ${host} (clicking “${page.submit}”)…`, {
      stage: 'registered',
      accountExists: true,
    });
  return clickStep(tabId, flow, page, 'submit', `Signing you in to ${host} (clicking “${page.submit}”)…`, {
    stage: 'signin',
  });
}

/**
 * After a fill: start or continue the account flow for this tab. `frames` are the fill's frame reports, each
 * with the page's account state. Returns { lines, act?, clicked } or null.
 */
async function accountStep(tabId, frames, settings, opts) {
  if (opts.only) return null;
  let flow = await getFlow(tabId);
  if (settings.accountFlow === false) {
    if (flow) await endFlow(tabId);
    return null;
  }
  if (!opts.flow && !flow) return null;
  const states = frames.filter((f) => f.account).map((f) => ({ ...f.account, frameId: f.frameId }));
  const applying = states.some((s) => s.kind === 'application');
  const pick = (kind) => states.find((s) => s.kind === kind && s.pure);
  const page = applying ? null : pick('signup') || pick('login') || pick('verify');
  if (!page) {
    if (!flow) return null;
    await endFlow(tabId);
    // Landed on the application after signing in: say what was clicked on the way.
    if (applying && flow.clicks.length)
      return {
        lines: [`Signed in: JobToFill clicked ${quote(flow.clicks.map((c) => c.label))} on the way here.`],
        clicked: flow.clicks.map((c) => c.label),
      };
    return null;
  }
  let secure = false;
  try {
    secure = isSecureUrl(new URL(page.url));
  } catch (err) {
    /* not a web page */
  }
  if (!secure) return null;
  if (flow && !sameFlowSite(flow, page.url, page.portal)) {
    await endFlow(tabId);
    flow = null;
    if (!opts.flow) return null;
  }
  if (!flow)
    flow = {
      id: util.uid(),
      tabId,
      ...flowPlace(page.url),
      portal: page.portal || '',
      startedAt: Date.now(),
      expires: Date.now() + FLOW_TTL,
      clicks: [],
      stage: 'start',
      quick: !!opts.quick,
    };
  if (page.portal && !flow.portal) flow.portal = page.portal;
  flow.waiting = null;
  const step = await flowDecide(tabId, flow, page);
  if (step.end) await endFlow(tabId);
  else await putFlow(flow);
  return step;
}

/** A page in the flow finished loading after one of its clicks: fill it, which takes the flow on. */
const flowTimers = new Map();
function scheduleFlow(tabId, delay) {
  clearTimeout(flowTimers.get(tabId));
  flowTimers.set(
    tabId,
    setTimeout(() => {
      flowTimers.delete(tabId);
      continueFlow(tabId).catch(() => {});
    }, delay),
  );
}

async function continueFlow(tabId) {
  const flow = await getFlow(tabId);
  if (!flow || !flow.clicks.length || flow.waiting) return;
  // Pages built by scripts (Workday) show their form a moment after loading.
  for (let i = 0; i < 4; i++) {
    const summary = await fillTab(tabId, { toast: true, flow: true, consents: flow.quick || undefined, quick: false });
    if (summary.error || summary.detected || summary.account) return;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (!(await getFlow(tabId))) return;
  }
}

api.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!info.url && info.status !== 'complete') return;
  const flow = await getFlow(tabId).catch(() => null);
  if (!flow) return;
  // Gone to another site (or another employer on a shared portal): the flow ends.
  const url = info.url || (tab && tab.url) || '';
  let portal = '';
  try {
    portal = globalThis.JTF.accounts.portal(url);
  } catch (err) {
    /* not a web page */
  }
  if (url && !sameFlowSite(flow, url, portal)) {
    await endFlow(tabId);
    return;
  }
  if (info.status === 'complete') scheduleFlow(tabId, 700);
  else if (info.url && tab && tab.status === 'complete') scheduleFlow(tabId, 1500); // a script-made page change
});

api.tabs.onRemoved.addListener((tabId) => {
  endFlow(tabId);
  lastSecrets.delete(tabId);
  vaultWaits.delete(tabId);
});

/** The page's CAPTCHA was solved (or its terms accepted): check the page again and take the next step. */
async function flowReady(msg, sender) {
  const tabId = sender.tab && sender.tab.id;
  const flow = await getFlow(tabId);
  if (!flow || !flow.waiting || flow.waiting.token !== msg.token) return { ok: false };
  flow.waiting = null;
  await putFlow(flow);
  const settings = await store.getSettings();
  if (msg.timedOut || settings.accountFlow === false) {
    await endFlow(tabId);
    if (msg.timedOut)
      await showToast(tabId, 'JobToFill stopped waiting: finish signing in here yourself.', { duration: 10000 });
    return { ok: true };
  }
  const { profile } = await store.getActive();
  const [state] = await callFrames(tabId, 'accountState', [{ profile }], [sender.frameId]).catch(() => [null]);
  const page = state && { ...state, frameId: sender.frameId };
  if (!page || !page.pure || !['login', 'signup', 'verify'].includes(page.kind)) {
    await endFlow(tabId);
    return { ok: false };
  }
  const step = await flowDecide(tabId, flow, page);
  if (step.end) await endFlow(tabId);
  else await putFlow(flow);
  if (settings.toast !== false && step.lines.length) await showToast(tabId, step.lines.join('\n'), { duration: 15000 });
  if (step.act) await step.act().catch(() => {});
  return { ok: true };
}

/** The code watcher typed in the emailed code during a flow: confirm that step ("Continue", "Verify"). */
async function otpFilled(msg, sender) {
  const tabId = sender.tab && sender.tab.id;
  const flow = await getFlow(tabId);
  if (!flow || !['registered', 'signin', 'verify'].includes(flow.stage)) return { ok: false };
  const settings = await store.getSettings();
  if (settings.accountFlow === false) return { ok: false };
  await new Promise((resolve) => setTimeout(resolve, 600));
  const { profile } = await store.getActive();
  const [state] = await callFrames(tabId, 'accountState', [{ profile }], [sender.frameId]).catch(() => [null]);
  if (!state || state.kind !== 'verify' || !state.pure || !state.ready || flow.clicks.length >= FLOW_CLICKS)
    return { ok: false };
  const page = { ...state, frameId: sender.frameId };
  const step = clickStep(
    tabId,
    flow,
    page,
    'submit',
    `Entered the code from your email and clicked “${page.submit}”.`,
    { stage: 'verified' },
  );
  await putFlow(flow);
  if (settings.toast !== false) await showToast(tabId, step.lines.join('\n'), { duration: 10000 });
  await step.act();
  return { ok: true };
}

/* ----------------------------------------------------------- vault prompts */

// tabId -> a fill that skipped passwords because the vault was locked: { at, url, flow, quick }. When the vault is
// unlocked (from the toast's "Unlock", the toolbar popup or settings) within a few minutes, that page is filled
// again, which puts the passwords in and carries the account flow on.
const vaultWaits = new Map();
const VAULT_WAIT = 5 * 60e3;

function waitForVault(tabId, url, opts) {
  vaultWaits.set(tabId, { at: Date.now(), url: url.split('#')[0], flow: !!opts.flow, quick: !!opts.quick });
}

async function resumeAfterUnlock() {
  const waits = [...vaultWaits.entries()];
  vaultWaits.clear();
  let resumed = 0;
  for (const [tabId, w] of waits) {
    if (Date.now() - w.at > VAULT_WAIT) continue;
    const tab = await api.tabs.get(tabId).catch(() => null);
    if (!tab || (tab.url || '').split('#')[0] !== w.url) continue;
    resumed++;
    fillTab(tabId, { toast: true, flow: w.flow, consents: w.quick || undefined }).catch(() => {});
  }
  return { resumed };
}

api.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'session' && changes.vaultKey && changes.vaultKey.newValue && vaultWaits.size)
    resumeAfterUnlock().catch(() => {});
});

/**
 * The toast's "Unlock": the toolbar popup where the browser lets an extension open it (Chrome), else the same
 * page in a small window. The master password is only ever typed into JobToFill's own page, never the site's.
 */
async function openUnlock(tabId) {
  const tab = tabId == null ? null : await api.tabs.get(tabId).catch(() => null);
  try {
    if (api.action && api.action.openPopup) {
      await api.action.openPopup(tab ? { windowId: tab.windowId } : undefined);
      return { ok: true };
    }
  } catch (err) {
    /* needs a click on the browser's own UI (Firefox), or no focused window */
  }
  const url = api.runtime.getURL(`popup/popup.html?tab=${tabId}&unlock=1`);
  await api.windows.create({ url, type: 'popup', width: 380, height: 620, focused: true });
  return { ok: true };
}

/** A button on the page's toast (in the content script's closed shadow root). */
async function toastAction(msg, sender) {
  const tabId = sender.tab && sender.tab.id;
  if (msg.action === 'unlock') return openUnlock(tabId);
  if (msg.action === 'setup-vault') {
    await api.tabs.create({ url: api.runtime.getURL('options/options.html#vault') });
    return { ok: true };
  }
  return { error: 'Unknown action.' };
}

/* ------------------------------------------------------------- watchlist */

// Firms on the Discover watchlist are re-checked a few times a day; anything new shows as a number on the
// toolbar button until it's seen on the Discover page. Small firms post once a year, often quietly.
const WATCH_MINUTES = 360;
let watching = null;

function checkWatchlist() {
  // One run at a time: the alarm and "Check now" can coincide.
  if (!watching) watching = runWatchChecks().finally(() => (watching = null));
  return watching;
}

async function runWatchChecks() {
  const { discover } = globalThis.JTF;
  const list = await store.getWatchlist();
  const fetchFn = (url, init) => fetch(url, init);
  let fresh = 0;
  await discover.pool(list, 2, async (entry) => {
    const state = (await store.getWatchState(entry.id)) || {};
    const res = await discover.check({ ...entry, seen: state.seen }, { fetch: fetchFn });
    const items = [...res.roles, ...res.programmes];
    const added = items
      .filter((it) => res.fresh.includes(discover.itemKey(it)))
      .map((it) => ({ ...it, foundAt: Date.now() }));
    const next = await store.setWatchState(entry.id, {
      // A failed check keeps what was seen, so a firm's site being down doesn't make everything "new" later.
      seen: res.status === 'unreachable' ? state.seen || null : [...new Set([...(state.seen || []), ...res.keys])],
      fresh: [...added, ...((state && state.fresh) || [])],
      checkedAt: res.checkedAt,
      status: res.status,
      roles: res.roles.length,
      programmes: res.programmes.length,
    });
    fresh += next.fresh.length;
  });
  await updateBadge();
  return { checked: list.length, fresh };
}

/** The toolbar number: new roles and programmes on watched firms not yet seen. */
async function updateBadge() {
  const list = await store.getWatchlist();
  const states = await store.getWatchStates(list.map((w) => w.id));
  const n = Object.values(states).reduce((sum, st) => sum + ((st && st.fresh && st.fresh.length) || 0), 0);
  await api.action.setBadgeBackgroundColor({ color: '#2563eb' });
  await api.action.setBadgeText({ text: n ? String(Math.min(n, 99)) : '' });
  return n;
}

/* -------------------------------------------------------------- messages */

const sum = (frames, key) => frames.reduce((n, f) => n + (f[key] || 0), 0);

const HANDLERS = {
  // From the popup and settings page.
  'jtf:fill': (msg) => fillTab(msg.tabId, { toast: !!msg.toast, flow: true }),
  'jtf:vault-unlocked': () => resumeAfterUnlock(),
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
  'jtf:ai-status': (msg) => {
    const run = aiRuns.get(msg.tabId);
    return { run: run ? runView(run) : null };
  },
  'jtf:ai-answer': (msg) => answerPage(msg.tabId, { toast: !!msg.toast }),
  'jtf:ai-stop': (msg) => {
    const run = aiRuns.get(msg.tabId);
    if (run && run.status === 'running') run.controller.abort();
    return { stopped: !!run };
  },
  'jtf:quick-start': (msg) => quickStart(msg.tabId),
  'jtf:quick-fill': (msg) => quickFill(msg.tabId, msg.letterId, msg),
  'jtf:quick-release': (msg) => quickRelease(msg.tabId, msg.message ? String(msg.message) : ''),
  'jtf:toast': async (msg) => (
    await showToast(msg.tabId, String(msg.message || ''), { duration: 10000 }),
    { ok: true }
  ),
  'jtf:watch-check': () => checkWatchlist(),
  'jtf:watch-badge': async () => ({ fresh: await updateBadge() }),
  'jtf:learn': async (msg) => {
    const { profile } = await store.getActive();
    const frames = await callFrames(msg.tabId, 'learn', [{ profile }]);
    return { suggestions: frames.flatMap((f) => f.suggestions || []) };
  },
  // From content scripts, during a fill.
  'jtf:secrets': secretsFor,
  'jtf:document': documentFor,
  'jtf:otp': otpFor,
  'jtf:otp-claim': otpClaim,
  'jtf:otp-filled': otpFilled,
  'jtf:flow-ready': flowReady,
  'jtf:toast-action': toastAction,
};

// prettier-ignore
const CONTENT_ONLY = new Set([
  'jtf:secrets', 'jtf:document', 'jtf:otp', 'jtf:otp-claim', 'jtf:otp-filled', 'jtf:flow-ready', 'jtf:toast-action',
]);
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
  if (tabId != null && command === 'fill-page') await fillTab(tabId, { toast: true, flow: true });
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
  add({ id: 'jtf-otp', title: 'Insert verification code from email', contexts: ['editable'] });
}

api.contextMenus.onClicked.addListener((info, tab) => {
  handleMenuClick(info, tab).catch((err) => console.warn('JobToFill menu action failed:', err));
});

async function handleMenuClick(info, tab) {
  if (!tab || tab.id == null) return;
  const frameIds = [info.frameId || 0];
  const id = String(info.menuItemId);

  if (id === 'jtf-fill') {
    await fillTab(tab.id, { toast: true, flow: true });
  } else if (id.startsWith('jtf-insert:')) {
    const { profile, settings } = await store.getActive();
    await callFrames(tab.id, 'fillActive', [id.slice('jtf-insert:'.length), { profile, settings }], frameIds);
  } else if (id === 'jtf-genpass') {
    await generatePasswordInto(tab, info, frameIds);
  } else if (id === 'jtf-otp') {
    await insertOtp(tab, info, frameIds);
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
  if (!(await api.alarms.get('jtf-watch')))
    api.alarms.create('jtf-watch', { delayInMinutes: 5, periodInMinutes: WATCH_MINUTES });
}

api.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'jtf-autolock') await vault.autoLock((await store.getSettings()).autoLockMinutes);
  else if (alarm.name === 'jtf-backup') await writeBackup();
  else if (alarm.name === 'jtf-watch' && (await store.getWatchlist()).length) await checkWatchlist();
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
  await store.clearQuickApply().catch(() => {}); // a quick apply result only lasts until the browser closes
  await createMenus();
  await ensureAlarm();
});

// For debugging from the background console, and for the end-to-end tests.
globalThis.JTFBackground = {
  fillTab,
  answerWithAi,
  answerPage,
  jobFor,
  quickStart,
  quickFill,
  quickRelease,
  callFrames,
  ensureInjected,
  handleMenuClick,
  secretsFor,
  summaryText,
  cardAllowedIn,
  siteOf,
  writeBackup,
  lookForPreviousBackup,
  otpFor,
  watchOtp,
  getFlow,
  endFlow,
  resumeAfterUnlock,
  checkWatchlist,
  updateBadge,
  handlers: HANDLERS,
};
