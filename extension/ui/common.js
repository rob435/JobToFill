/* JobToFill — helpers shared by the popup and the settings page (ES module). */
const { util } = globalThis.JTF;
export const api = globalThis.JTF.api;

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

/**
 * Create an element. `props` are assigned as properties, except:
 *   dataset: {…}  ->  data-* attributes
 *   attrs: {…}    ->  setAttribute
 *   onclick etc.  ->  addEventListener
 */
export function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'attrs') for (const [name, v] of Object.entries(value)) node.setAttribute(name, v);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node[key] = value;
  }
  for (const child of children.flat()) if (child != null && child !== false) node.append(child);
  return node;
}

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/* ------------------------------------------------------------ site access */

// Firefox treats host permissions as optional, so the user may need to grant them once.
const ALL_SITES = { origins: ['<all_urls>'] };

export function hasSiteAccess() {
  return api.permissions.contains(ALL_SITES);
}

/** Must be called straight from a click handler (no await before it) or Firefox refuses. */
export function requestSiteAccess() {
  return api.permissions.request(ALL_SITES);
}

/* ------------------------------------------------------------ AI consent */

// Firefox asks before an add-on sends personal data anywhere. The cover letter writer sends your CV,
// profile and the job page's text to the AI provider you chose, so it asks once, from a click.
const AI_DATA = { data_collection: ['personallyIdentifyingInfo', 'websiteContent'] };

export async function hasAiConsent() {
  if (!util.isFirefox()) return true;
  try {
    return await api.permissions.contains(AI_DATA);
  } catch (err) {
    return true; // a Firefox without data-collection permissions doesn't ask
  }
}

/** Must be called straight from a click handler (no await before it) or Firefox refuses. */
export function requestAiConsent() {
  if (!util.isFirefox()) return Promise.resolve(true);
  try {
    return api.permissions.request(AI_DATA).catch(() => false);
  } catch (err) {
    return Promise.resolve(true);
  }
}

/* -------------------------------------------------------------- shortcuts */

export async function fillShortcut() {
  try {
    const command = (await api.commands.getAll()).find((c) => c.name === 'fill-page');
    return (command && command.shortcut) || '';
  } catch (err) {
    return '';
  }
}

export function openShortcutSettings() {
  if (api.commands.openShortcutSettings) return api.commands.openShortcutSettings();
  return api.tabs.create({ url: 'chrome://extensions/shortcuts' });
}

export const isFirefox = util.isFirefox();
