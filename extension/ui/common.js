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

/* ---------------------------------------------------------- AI models */

const ANOTHER = '\u0000another';

/**
 * The model chooser of the AI settings and the letter studio: the provider's suggested models in a list, with a line
 * on what the chosen one is good for ("Claude Haiku 5.5: fast and the cheapest…"), and "Another model…" for any id
 * the provider offers, typed with the provider's own list (`list(provider)` → ids, fetched when the box is first
 * used). A provider without suggestions ("Other") just gets the box. `onChange(id)` follows every choice.
 * Returns { parts (the elements, for a .field), set(provider, model), value }.
 */
export function modelPicker({ name = 'ai-model', list = async () => [], onChange = () => {} } = {}) {
  const { ai } = globalThis.JTF;
  const choice = el('select', { name: `${name}-choice`, attrs: { 'aria-label': 'Model' } });
  const box = el('input', { type: 'text', name, autocomplete: 'off', spellcheck: false });
  const ids = el('datalist', { id: `${name}-list` });
  box.setAttribute('list', ids.id);
  box.setAttribute('aria-label', 'Model id');
  const note = el('small', { className: 'model-note' });
  let provider = '';
  let listed = null;
  const typed = () => choice.hidden || choice.value === ANOTHER;
  const value = () => (typed() ? box.value.trim() : choice.value);
  const show = () => {
    box.hidden = !typed();
    note.textContent =
      ai.describe(provider, value()) || (typed() && ai.suggestions(provider).length ? 'Any model id it offers.' : '');
  };
  function set(id, model) {
    provider = id;
    const p = ai.PROVIDERS[id] || {};
    const suggested = ai.suggestions(id);
    const wanted = String(model || '').trim();
    const current = wanted || p.model || '';
    choice.replaceChildren(
      ...suggested.map((m) =>
        el('option', { value: m.id, textContent: m.id === p.model ? `${m.name} (default)` : m.name }),
      ),
      el('option', { value: ANOTHER, textContent: 'Another model…' }),
    );
    choice.hidden = !suggested.length;
    const known = suggested.some((m) => m.id === current);
    choice.value = known ? current : ANOTHER;
    box.value = known ? '' : wanted;
    box.placeholder = p.model || 'model id';
    ids.replaceChildren();
    listed = null;
    show();
  }
  choice.addEventListener('change', () => {
    show();
    if (typed()) box.focus();
    onChange(value());
  });
  box.addEventListener('input', show);
  box.addEventListener('change', () => onChange(value()));
  // The provider's full list only when someone goes to type one: it may need the key, and it's long.
  box.addEventListener('focus', async () => {
    if (listed === provider) return;
    listed = provider;
    const offered = await list(provider).catch(() => []);
    const known = new Set(ai.suggestions(provider).map((m) => m.id));
    ids.replaceChildren(
      ...offered
        .filter((x) => !known.has(x))
        .slice(0, 400)
        .map((x) => el('option', { value: x })),
    );
  });
  return {
    parts: [choice, box, ids, note],
    set,
    get value() {
      return value();
    },
  };
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
