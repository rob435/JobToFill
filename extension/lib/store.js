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
    passwordStrategy: 'generate',
    autoLockMinutes: 30,
    logApplications: true,
  };

  const DOC_TYPES = ['resume', 'coverLetter'];
  const HISTORY_LIMIT = 500;
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
    await area().remove(DOC_TYPES.map((w) => docKey(id, w)));
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
    getHistory,
    addHistory,
    clearHistory,
    exportData,
    importData,
  };
  JTF.store = store;
  if (typeof module === 'object' && module.exports) module.exports = store;
})(typeof globalThis !== 'undefined' ? globalThis : this);
