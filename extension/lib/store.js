/*
 * JobToFill — profile, settings, document and history storage (storage.local).
 *
 * Layout:
 *   profiles      { [id]: profile }
 *   profileOrder  [id, ...]
 *   settings      see DEFAULT_SETTINGS
 *   doc:<id>:<which>  { name, type, size, dataUrl, updatedAt }   (resume / coverLetter files)
 *   history       [{ date, url, host, title, filled }]  newest first
 *   vault         encrypted blob, managed by vault.js
 *   backupInfo    { at, path, error, paused, previous, dismissed }  the automatic backup file (background.js)
 *   kit:<id>      cover letter material per profile: { notes, samples: [{ id, name, text }], contact, closing,
 *                 spelling, paper, cv: { updatedAt, text } (text read from the resume file) }
 *   aiKey         the AI provider's API key; never exported or backed up
 *   letters       generated letters, newest first (see saveLetter)
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});

  const DEFAULT_SETTINGS = {
    activeProfileId: null,
    overwrite: false,
    highlight: true,
    toast: true,
    comboboxes: true,
    consents: false,
    autoBackup: true,
    passwordStrategy: 'generate',
    autoLockMinutes: 30,
    logApplications: true,
    ai: { provider: 'openrouter', model: '', baseUrl: '' },
    searchHistory: false,
  };

  const DEFAULT_KIT = { notes: '', samples: [], contact: '', closing: '', spelling: 'auto', paper: 'a4', cv: null };

  const DOC_TYPES = ['resume', 'coverLetter'];
  const HISTORY_LIMIT = 500;
  const LETTER_LIMIT = 25;
  const area = () => JTF.api.storage.local;

  // Read-modify-write operations run one at a time within a context so they don't drop each other's changes.
  let queue = Promise.resolve();
  function exclusive(fn) {
    return (...args) => {
      const run = queue.then(() => fn(...args));
      queue = run.catch(() => {});
      return run;
    };
  }

  async function loadAll() {
    const data = await area().get(['profiles', 'profileOrder', 'settings']);
    let profiles = data.profiles || {};
    let order = (data.profileOrder || Object.keys(profiles)).filter((id) => profiles[id]);
    const settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
    let dirty = false;
    if (!order.length) {
      // Fixed id: several contexts (worker, popup, settings tab) may create the first profile at once.
      const p = JTF.fields.createProfile('My profile');
      p.id = 'default';
      profiles = { [p.id]: p };
      order = [p.id];
      dirty = true;
    }
    for (const id of order) profiles[id] = JTF.fields.upgradeProfile(profiles[id]);
    if (!profiles[settings.activeProfileId]) {
      settings.activeProfileId = order[0];
      dirty = true;
    }
    if (dirty) await area().set({ profiles, profileOrder: order, settings });
    return { profiles, order, settings };
  }

  async function getActive() {
    const all = await loadAll();
    return { profile: all.profiles[all.settings.activeProfileId], settings: all.settings, all };
  }

  async function getSettings() {
    return (await loadAll()).settings;
  }

  const saveSettings = exclusive(async function saveSettings(patch) {
    const settings = Object.assign(await getSettings(), patch);
    await area().set({ settings });
    return settings;
  });

  async function putProfile(profile) {
    const { profiles, order } = await loadAll();
    profiles[profile.id] = profile;
    if (!order.includes(profile.id)) order.push(profile.id);
    await area().set({ profiles, profileOrder: order });
    return profile;
  }

  const saveProfile = exclusive(putProfile);

  const createProfile = exclusive(async function createProfile(name, copyFrom) {
    const p = copyFrom
      ? Object.assign(structuredClone(copyFrom), { id: JTF.util.uid(), name })
      : JTF.fields.createProfile(name);
    return putProfile(p);
  });

  const deleteProfile = exclusive(async function deleteProfile(id) {
    const { profiles, order, settings } = await loadAll();
    if (order.length <= 1) throw new Error('You need at least one profile.');
    delete profiles[id];
    const nextOrder = order.filter((x) => x !== id);
    if (settings.activeProfileId === id) settings.activeProfileId = nextOrder[0];
    await area().set({ profiles, profileOrder: nextOrder, settings });
    await area().remove([...DOC_TYPES.map((w) => docKey(id, w)), kitKey(id)]);
  });

  async function setActive(id) {
    return saveSettings({ activeProfileId: id });
  }

  /* -------------------------------------------------------------- documents */

  const docKey = (profileId, which) => `doc:${profileId}:${which}`;

  async function getDoc(profileId, which) {
    const key = docKey(profileId, which);
    return (await area().get(key))[key] || null;
  }

  async function setDoc(profileId, which, doc) {
    if (!DOC_TYPES.includes(which)) throw new Error('Unknown document type');
    await area().set({ [docKey(profileId, which)]: Object.assign({ updatedAt: Date.now() }, doc) });
  }

  async function removeDoc(profileId, which) {
    await area().remove(docKey(profileId, which));
  }

  /** { resume: {name, size, type} | null, coverLetter: … } without the file bytes. */
  async function docInfo(profileId) {
    const keys = DOC_TYPES.map((w) => docKey(profileId, w));
    const got = await area().get(keys);
    const out = {};
    DOC_TYPES.forEach((w, i) => {
      const d = got[keys[i]];
      out[w] = d ? { name: d.name, size: d.size, type: d.type, updatedAt: d.updatedAt } : null;
    });
    return out;
  }

  /* ---------------------------------------------------------- cover letters */

  const kitKey = (profileId) => `kit:${profileId}`;

  async function getKit(profileId) {
    const key = kitKey(profileId);
    return Object.assign(structuredClone(DEFAULT_KIT), (await area().get(key))[key] || {});
  }

  const saveKit = exclusive(async function saveKit(profileId, patch) {
    const kit = Object.assign(await getKit(profileId), patch);
    await area().set({ [kitKey(profileId)]: kit });
    return kit;
  });

  async function getAiKey() {
    return (await area().get('aiKey')).aiKey || '';
  }

  async function setAiKey(key) {
    const value = String(key || '').trim();
    if (value) await area().set({ aiKey: value });
    else await area().remove('aiKey');
  }

  /** The AI settings with the key, ready for JTF.ai. */
  async function aiConfig() {
    const [settings, apiKey] = await Promise.all([getSettings(), getAiKey()]);
    return Object.assign({}, DEFAULT_SETTINGS.ai, settings.ai || {}, { apiKey });
  }

  async function getLetters() {
    return (await area().get('letters')).letters || [];
  }

  /**
   * Save (or update, by id) a generated letter: { id, profileId, createdAt, url, host, tabId, jobIds, posting,
   * letter, header, text, pdf: { name, type, size, dataUrl }, cv, useCv, attachedAt }.
   */
  const saveLetter = exclusive(async function saveLetter(entry) {
    const letters = await getLetters();
    const i = letters.findIndex((l) => l.id === entry.id);
    if (i >= 0) letters[i] = Object.assign(letters[i], entry);
    else letters.unshift(Object.assign({ id: JTF.util.uid(), createdAt: Date.now() }, entry));
    await area().set({ letters: letters.slice(0, LETTER_LIMIT) });
    return i >= 0 ? letters[i] : letters[0];
  });

  const removeLetter = exclusive(async function removeLetter(id) {
    await area().set({ letters: (await getLetters()).filter((l) => l.id !== id) });
  });

  const LETTER_TTL = 3 * 86400000;

  /**
   * The letter chosen for the application open in this tab: the same page, a page of the same job (its id is
   * in the address), or the next step of the same application (same tab and site, a few hours on).
   * Some sites send every applicant to one address (apply.careers.hsbc.com/), so an address that doesn't
   * name the job only counts in the same tab, and not once the tab has moved on to another job's page
   * (`trail`: the job pages the tab showed, with when).
   */
  async function letterFor({ tabId, url, trail }) {
    if (!url) return null;
    let u;
    try {
      u = new URL(url);
    } catch (err) {
      return null;
    }
    const now = Date.now();
    const path = (x) => x.replace(/[?#].*$/, '').replace(/\/+$/, '');
    const parse = (x) => {
      try {
        return new URL(x);
      } catch (err) {
        return null;
      }
    };
    const ID = /\d{5,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/gi;
    const named = (l) => {
      const p = (parse(l.url) || {}).pathname || '';
      const last = p.split('/').filter(Boolean).pop() || '';
      return (
        /\d{4,}|[0-9a-f]{8}-[0-9a-f]{4}/i.test(p) ||
        (l.jobIds || []).some((id) => id && id.length >= 4 && p.includes(id)) ||
        last.split(/[-_]+/).length >= 3
      );
    };
    // A job page with another job's id, opened in this tab after the letter was chosen.
    const movedOn = (l) =>
      (trail || []).some((t) => {
        if (!t || !t.url || t.at <= l.attachedAt || path(t.url) === path(l.url)) return false;
        const p = (parse(t.url) || {}).pathname || '';
        if (!/\/(jobs?|postings?|vacanc\w*|positions?|opportunit\w*|requisitions?|roles?)\b/i.test(p)) return false;
        const known = [...(l.jobIds || []), (l.posting && l.posting.url) || ''].join(' ');
        return (p.match(ID) || []).some((id) => !known.includes(id));
      });
    for (const l of await getLetters()) {
      if (!l.attachedAt || now - l.attachedAt > LETTER_TTL) continue;
      if (((parse(l.url) || {}).hostname || null) !== u.hostname) continue;
      if (path(l.url) === path(url) && named(l)) return l;
      if ((l.jobIds || []).some((id) => id && id.length >= 4 && url.includes(id))) return l;
      if (l.tabId === tabId && now - l.attachedAt < 6 * 3600000 && !movedOn(l)) return l;
    }
    return null;
  }

  /* ---------------------------------------------------------------- history */

  async function getHistory() {
    return (await area().get('history')).history || [];
  }

  /** Log an application. Re-filling the same page within an hour updates the entry. */
  const addHistory = exclusive(async function addHistory(entry) {
    const history = await getHistory();
    const now = Date.now();
    const recent = history.find((h) => h.url === entry.url && now - h.date < 3600000);
    if (recent) Object.assign(recent, entry, { date: now, filled: Math.max(recent.filled || 0, entry.filled || 0) });
    else history.unshift(Object.assign({ date: now }, entry));
    await area().set({ history: history.slice(0, HISTORY_LIMIT) });
  });

  async function clearHistory() {
    await area().set({ history: [] });
  }

  /* ---------------------------------------------------------------- backups */

  /** Is any leaf of `value` filled in, compared with the blank template `def`? */
  function filledIn(value, def) {
    if (Array.isArray(value)) return value.some((v) => filledIn(v, Array.isArray(def) ? def[0] : undefined));
    if (value && typeof value === 'object')
      return Object.keys(value).some(
        (k) => k !== 'id' && filledIn(value[k], def && typeof def === 'object' ? def[k] : undefined),
      );
    if (typeof value === 'string') return value.trim() !== '' && value !== def;
    if (typeof value === 'boolean') return value && value !== def;
    return value != null && value !== def;
  }

  /**
   * Has anything been entered that is worth backing up? A fresh install has one blank profile,
   * and its backup must never replace a real one.
   */
  async function hasData() {
    const { profiles, order } = await loadAll();
    const template = JTF.fields.createProfile();
    if (order.length > 1) return true;
    if (order.some((id) => filledIn({ ...profiles[id], id: undefined, name: undefined }, template))) return true;
    const all = await area().get(null);
    return !!all.vault || Object.keys(all).some((k) => k.startsWith('doc:') || k.startsWith('kit:'));
  }

  /**
   * Is this item from the browser's download list (which outlives the extension) a backup file?
   * Matched by name, or as JSON this extension saved itself in case the browser renamed it.
   */
  function isBackupDownload(item) {
    if (!item || item.state !== 'complete') return false;
    if (/jobtofill-backup[^/\\]*\.json$/.test(item.filename || '')) return true;
    return item.byExtensionId === JTF.api.runtime.id && item.mime === 'application/json';
  }

  async function getBackupInfo() {
    return (await area().get('backupInfo')).backupInfo || {};
  }

  const setBackupInfo = exclusive(async function setBackupInfo(patch) {
    const info = Object.assign(await getBackupInfo(), patch);
    await area().set({ backupInfo: info });
    return info;
  });

  /* ---------------------------------------------------------- import/export */

  async function exportData(options) {
    const opts = Object.assign({ documents: true, vault: true, history: true }, options || {});
    const all = await loadAll();
    const out = {
      app: 'JobToFill',
      format: 1,
      exportedAt: new Date().toISOString(),
      profiles: all.profiles,
      profileOrder: all.order,
      settings: all.settings,
    };
    if (opts.documents) {
      out.documents = {};
      for (const id of all.order) {
        for (const w of DOC_TYPES) {
          const d = await getDoc(id, w);
          if (d) out.documents[docKey(id, w)] = d;
        }
      }
    }
    out.kits = {};
    for (const id of all.order) {
      const key = kitKey(id);
      const kit = (await area().get(key))[key];
      if (kit) out.kits[key] = kit;
    }
    if (opts.vault) out.vault = (await area().get('vault')).vault || null;
    if (opts.history) out.history = await getHistory();
    return out;
  }

  const importData = exclusive(async function importData(data) {
    if (!data || data.app !== 'JobToFill' || !data.profiles) throw new Error('This is not a JobToFill backup file.');
    const order = (data.profileOrder || Object.keys(data.profiles)).filter((id) => data.profiles[id]);
    const profiles = {};
    for (const id of order) profiles[id] = JTF.fields.upgradeProfile(data.profiles[id]);
    const set = { profiles, profileOrder: order, settings: Object.assign({}, DEFAULT_SETTINGS, data.settings || {}) };
    if (data.history) set.history = data.history;
    if (data.vault) set.vault = data.vault;
    for (const [key, doc] of Object.entries(data.documents || {})) {
      if (/^doc:[^:]+:(resume|coverLetter)$/.test(key)) set[key] = doc;
    }
    for (const [key, kit] of Object.entries(data.kits || {})) {
      if (/^kit:[^:]+$/.test(key) && kit && typeof kit === 'object') set[key] = kit;
    }
    await area().set(set);
    if (data.vault && JTF.vault) await JTF.vault.lock();
  });

  const store = {
    DEFAULT_SETTINGS,
    DOC_TYPES,
    loadAll,
    getActive,
    getSettings,
    saveSettings,
    saveProfile,
    createProfile,
    deleteProfile,
    setActive,
    getDoc,
    setDoc,
    removeDoc,
    docInfo,
    getKit,
    saveKit,
    getAiKey,
    setAiKey,
    aiConfig,
    getLetters,
    saveLetter,
    removeLetter,
    letterFor,
    getHistory,
    addHistory,
    clearHistory,
    exportData,
    importData,
    hasData,
    isBackupDownload,
    getBackupInfo,
    setBackupInfo,
  };
  JTF.store = store;
  if (typeof module === 'object' && module.exports) module.exports = store;
})(typeof globalThis !== 'undefined' ? globalThis : this);
