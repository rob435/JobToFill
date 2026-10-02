/*
 * JobToFill — background (service worker in Chromium, event page in Firefox).
 * Owns everything that needs privileges: injecting the content scripts on
 * demand, running a fill across all frames, handing out vault secrets (only to
 * the frame being filled, only over HTTPS), the keyboard shortcut, context
 * menus, vault auto-lock and the automatic backup file.
 */
// Chromium loads the libraries here; Firefox lists them in manifest.json "background.scripts".
if (typeof importScripts === 'function') {
  importScripts(
    'lib/util.js',
    'lib/geo.js',
    'lib/fields.js',
    'lib/matcher.js',
    'lib/vault.js',
    'lib/store.js',
    'lib/ai.js',
    'lib/letter.js',
    'lib/answers.js',
    'lib/jobpage.js',
    'lib/doctext.js',
  );
}

const { store, vault, util, fields, answers, jobpage, doctext } = globalThis.JTF;
const llm = globalThis.JTF.ai;
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

async function fillTab(tabId, options) {
  const opts = { toast: false, ...options };
  const { payload, letter } = await fillPayload(tabId);
  const { profile, settings } = payload;
  if (opts.only) Object.assign(payload, { only: opts.only, force: true });
  // With AI answers on, the page opens custom dropdowns it left empty to read their options for the model.
  const aiReady = opts.only ? { ok: false } : await aiAvailable(settings);
  payload.ai = aiReady.ok;

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
  // What the rules left empty goes to the AI, in the background: the fill doesn't wait for it.
  const pending = frames.flatMap((f) => (f.pending || []).map((item) => ({ ...item, frameId: f.frameId })));
  summary.pending = pending.length;
  if (pending.length && !opts.only) {
    if (aiReady.ok) {
      summary.ai = { status: 'running', stage: 'job', asked: pending.length };
      const run = answerWithAi(tabId, pending, { toast: opts.toast && settings.toast !== false });
      if (opts.waitAi) summary.ai = await run;
    } else summary.ai = { status: aiReady.reason, asked: pending.length };
  }
  if (opts.toast && settings.toast !== false)
    await showToast(tabId, summaryText(summary), {
      undo: summary.undoable,
      duration: summary.ai && summary.ai.status === 'running' ? 120000 : undefined,
    });
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
    for (const key of ['filled', 'detected', 'skipped', 'failed', 'unknown', 'consents', 'restored', 'revealed'])
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
const BACKUP_KEYS = /^(profiles|profileOrder|settings|vault|aiKeys|answers|doc:.+|kit:.+)$/;

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
    written = await answers.answer(chat, { profile, kit, cvText, job: ctx.job, bank, today: Date.now() }, rest, {
      signal: controller.signal,
      onProgress: (stage) => report({ stage }),
    });
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
    if (opts.toast) await showToast(tabId, aiSummaryText(run), { undo: total.filled > 0 });
    return runView(run);
  } catch (err) {
    const error = err && err.name === 'AbortError' ? 'Stopped.' : String((err && err.message) || err);
    report({ status: 'error', stage: 'done', error });
    if (opts.toast && error !== 'Stopped.') await showToast(tabId, aiSummaryText(run));
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
  answerWithAi,
  answerPage,
  jobFor,
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
