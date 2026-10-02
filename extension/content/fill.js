/*
 * JobToFill — writes values into the page in a way frameworks notice:
 * native value setters + input/change events (React, Vue, Angular), real
 * clicks for radios/checkboxes, DataTransfer for file inputs, and a
 * type-then-pick routine for custom dropdowns (react-select, Workday, …).
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});
  const M = () => JTF.matcher;
  const dom = () => JTF.dom;

  const HIGHLIGHT = 'rgba(124, 92, 255, 0.95)';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* --------------------------------------------------------------- events */

  function fire(el, type) {
    el.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
  }

  function key(el, k) {
    for (const type of ['keydown', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, { key: k, code: k, bubbles: true, cancelable: true, composed: true }));
    }
  }

  function pointerClick(el) {
    const view = el.ownerDocument.defaultView;
    const rect = el.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view,
      button: 0,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    el.dispatchEvent(new PointerEvent('pointerdown', init));
    el.dispatchEvent(new MouseEvent('mousedown', init));
    el.dispatchEvent(new PointerEvent('pointerup', init));
    el.dispatchEvent(new MouseEvent('mouseup', init));
    el.dispatchEvent(new MouseEvent('click', init));
  }

  function nativeSetter(el) {
    const view = el.ownerDocument.defaultView;
    const proto =
      el.localName === 'textarea'
        ? view.HTMLTextAreaElement.prototype
        : el.localName === 'select'
          ? view.HTMLSelectElement.prototype
          : view.HTMLInputElement.prototype;
    return Object.getOwnPropertyDescriptor(proto, 'value').set;
  }

  function setNativeValue(el, value) {
    nativeSetter(el).call(el, value);
  }

  function typeValue(el, value) {
    el.dispatchEvent(new FocusEvent('focus'));
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }));
    setNativeValue(el, value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
    fire(el, 'change');
    el.dispatchEvent(new FocusEvent('blur'));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }));
  }

  /** Checked state of a native radio/checkbox or an ARIA one (role="radio", aria-pressed buttons). */
  function isChecked(el) {
    if (el.localName === 'input') return el.checked;
    return el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true';
  }

  function setChecked(el, checked) {
    if (isChecked(el) === checked) return;
    if (el.localName !== 'input') {
      pointerClick(el);
      if (isChecked(el) !== checked) key(el, ' ');
      return;
    }
    el.click();
    if (el.checked !== checked) {
      el.checked = checked;
      fire(el, 'input');
      fire(el, 'change');
    }
  }

  /* ---------------------------------------------------------- has a value? */

  function isUntouchedSelect(el) {
    const opt = el.options[el.selectedIndex];
    if (!opt) return true;
    if (M().isPlaceholder(JTF.util.normalize(opt.text)) || opt.value === '') return true;
    const defaults = Array.from(el.options).filter((o) => o.defaultSelected);
    return defaults.length ? defaults.includes(opt) : el.selectedIndex === 0;
  }

  function comboText(el) {
    if (el.localName === 'input') return el.value.trim();
    return dom().textOf(el) || '';
  }

  const CHIP =
    '[class*="singleValue"], [class*="single-value"], [class*="selected-value"], [class*="multiValue"], [class*="multi-value"], [class*="MuiChip-root"]';

  /**
   * The selected values ("chips") of a react-select style widget, looking only inside its own
   * container. Hidden helper inputs (react-select's required-field shim) don't count as neighbours.
   */
  function chipsOf(el) {
    let a = el.parentElement;
    for (let i = 0; a && i < 5; i++, a = a.parentElement) {
      const others = Array.from(
        a.querySelectorAll('input:not([type="hidden"]), select, textarea, [role="combobox"]'),
      ).filter((c) => c !== el && !c.contains(el) && c.getAttribute('aria-hidden') !== 'true' && c.tabIndex >= 0);
      if (others.length) return [];
      const all = Array.from(a.querySelectorAll(CHIP));
      if (all.length) return all.filter((c) => !all.some((o) => o !== c && o.contains(c)));
    }
    return unnamedChips(el);
  }

  /**
   * react-select without readable class names: its input sits in a wrapper carrying data-value, and
   * the value container holds either the placeholder (id …-placeholder) or the chosen value(s).
   */
  function unnamedChips(el) {
    const wrapper = el.parentElement;
    const container = wrapper && wrapper.hasAttribute('data-value') ? wrapper.parentElement : null;
    if (!container) return [];
    return Array.from(container.children).filter(
      (c) => c !== wrapper && !/-placeholder$/.test(c.id) && !!dom().textOf(c),
    );
  }

  /** Does this control already hold something the user (or site) put there? */
  function hasValue(field) {
    const { el, kind, members } = field;
    switch (kind) {
      case 'select':
        return !isUntouchedSelect(el);
      case 'radio':
        return members.some((m) => isChecked(m) && !m.defaultChecked);
      case 'checkboxes':
        return members.some((m) => isChecked(m) !== !!m.defaultChecked);
      case 'checkbox':
        return isChecked(el);
      case 'file':
        return el.files && el.files.length > 0;
      case 'combo': {
        const t = comboText(el);
        return !!t && !M().isPlaceholder(JTF.util.normalize(t));
      }
      case 'combobox':
        return !!el.value.trim() || chipsOf(el).length > 0;
      default: {
        const v = (el.value || '').trim();
        return !!v && !/^https?:\/\/$/.test(v);
      }
    }
  }

  /** Current value as text (for "learn from this page"). */
  function currentValue(field) {
    const { el, kind, members } = field;
    switch (kind) {
      case 'select':
        return isUntouchedSelect(el) ? '' : (el.options[el.selectedIndex] || {}).text || '';
      case 'radio': {
        const m = members.find(isChecked);
        return m ? field.desc.options[members.indexOf(m)].text : '';
      }
      case 'checkboxes':
        return members
          .filter(isChecked)
          .map((m) => field.desc.options[members.indexOf(m)].text)
          .join(', ');
      case 'checkbox':
        return isChecked(el) ? 'Yes' : '';
      case 'file':
      case 'password':
        return '';
      case 'combo': {
        const t = comboText(el);
        return M().isPlaceholder(JTF.util.normalize(t)) ? '' : t;
      }
      case 'combobox':
        return (
          el.value.trim() ||
          chipsOf(el)
            .map((c) => dom().textOf(c))
            .filter(Boolean)
            .join(', ')
        );
      default:
        return (el.value || '').trim();
    }
  }

  /* ---------------------------------------------------- custom dropdowns */

  const OPEN_WAIT = 600;
  const SEARCH_WAIT = 2500;

  function listboxFor(el) {
    const rootNode = el.getRootNode();
    const doc = el.ownerDocument;
    const ids = [el.getAttribute('aria-controls'), el.getAttribute('aria-owns')]
      .filter(Boolean)
      .join(' ')
      .split(/\s+/)
      .filter(Boolean);
    for (const id of ids) {
      const lb = (rootNode.getElementById && rootNode.getElementById(id)) || doc.getElementById(id);
      if (lb && dom().isVisible(lb)) return lb;
    }
    const all = Array.from(rootNode.querySelectorAll('[role="listbox"]'));
    if (rootNode !== doc) all.push(...doc.querySelectorAll('[role="listbox"]'));
    const visible = all.filter((lb) => dom().isVisible(lb) && !lb.closest('[data-jtf-ui]'));
    if (!visible.length) return null;
    for (let a = el.parentElement, i = 0; a && i < 6; a = a.parentElement, i++) {
      const near = visible.find((lb) => a.contains(lb));
      if (near) return near;
    }
    return visible[visible.length - 1]; // portals are usually appended last
  }

  function currentOptions(el) {
    const lb = listboxFor(el);
    let opts = lb ? Array.from(lb.querySelectorAll('[role="option"]')) : [];
    if (!opts.length) {
      // react-select without ARIA roles: its ids share a prefix ("react-select-3-input", "-listbox",
      // "-placeholder") even when the site gives the input its own id -> #react-select-3-option-0…
      const ids = ['aria-controls', 'aria-owns', 'aria-describedby'].map((a) => el.getAttribute(a) || '');
      const m =
        ids.join(' ').match(/\b(react-select-[\w-]+?)-(listbox|placeholder|value)\b/) ||
        (el.id || '').match(/^(.*)-input$/);
      if (m) opts = Array.from(el.ownerDocument.querySelectorAll(`[id^="${CSS.escape(m[1])}-option-"]`));
    }
    return opts.filter((o) => o.getAttribute('aria-disabled') !== 'true' && dom().isVisible(o));
  }

  /** Is the dropdown still fetching results ("Loading…", aria-busy)? */
  function isLoading(el) {
    const lb = listboxFor(el);
    const menu = lb ? lb.parentElement || lb : null;
    if (lb && lb.getAttribute('aria-busy') === 'true') return true;
    return !!(menu && menu.querySelector('[class*="loading" i], [class*="spinner" i], [aria-busy="true"]'));
  }

  const optionsKey = (opts) =>
    opts.length +
    '|' +
    opts
      .slice(0, 3)
      .map((o) => o.textContent)
      .join('|');

  /** Wait until the options stop changing (async searches return in stages), up to `timeout` ms. */
  async function waitForOptions(el, timeout, previous) {
    const start = Date.now();
    let lastKey = null;
    let stable = 0;
    let opts = [];
    while (Date.now() - start < timeout) {
      opts = currentOptions(el);
      // An empty menu that has stopped loading ("No options") won't fill up later.
      if (!opts.length && Date.now() - start > 900 && !isLoading(el)) return opts;
      const key = optionsKey(opts);
      const fresh = previous == null || key !== previous;
      if (opts.length && key === lastKey && fresh && !isLoading(el)) {
        if (++stable >= 2) return opts;
      } else stable = 0;
      lastKey = key;
      await sleep(40);
    }
    return opts;
  }

  function describeOptions(opts) {
    return opts.map((o) => ({
      text: dom().textOf(o) || o.getAttribute('aria-label') || '',
      value: o.getAttribute('data-value') || o.getAttribute('value') || '',
    }));
  }

  /** Type like a person: key events around the input event, so widgets that open on keyup notice. */
  function typeQuery(el, query) {
    const last = query.slice(-1) || 'a';
    const code = /[a-z]/i.test(last) ? 'Key' + last.toUpperCase() : /\d/.test(last) ? 'Digit' + last : 'Space';
    const init = { key: last, code, bubbles: true, cancelable: true, composed: true };
    el.dispatchEvent(new KeyboardEvent('keydown', init));
    setNativeValue(el, query);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: query }));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  function clearQuery(el) {
    if (!el.value) return;
    setNativeValue(el, '');
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward' }));
  }

  async function openMenu(el, searchable) {
    let opts = currentOptions(el);
    if (opts.length) return opts;
    if (el.localName === 'input') {
      el.focus({ preventScroll: true });
      key(el, 'ArrowDown');
      opts = await waitForOptions(el, OPEN_WAIT);
      // A read-only picker that ignores the keyboard: click it like a person would.
      if (!opts.length && !searchable && !listboxFor(el)) {
        pointerClick(el);
        opts = await waitForOptions(el, OPEN_WAIT);
      }
    } else {
      pointerClick(el);
      opts = await waitForOptions(el, OPEN_WAIT);
      if (!opts.length && !listboxFor(el)) {
        el.focus({ preventScroll: true });
        key(el, 'ArrowDown');
        opts = await waitForOptions(el, OPEN_WAIT);
      }
    }
    return opts;
  }

  /** Words to type into a searchable dropdown, best first: "University of Glasgow", then "Glasgow". */
  function searchQueries(v) {
    const out = [];
    const add = (q) => {
      q = String(q || '').trim();
      if (q && !out.some((x) => x.toLowerCase() === q.toLowerCase())) out.push(q);
    };
    if (v.kind === 'list') (v.items || []).slice(0, 3).forEach(add);
    add(v.search);
    add(v.text.length <= 60 ? v.text : '');
    const words = JTF.util
      .tokens(v.search || v.text)
      .filter((w) => w.length > 3 && !/^(university|college|school|institute|of|the)$/.test(w));
    if (words.length > 1) add(words.sort((a, b) => b.length - a.length)[0]);
    return out.slice(0, 3);
  }

  /** Did picking `text` register: a chip, the input's own value, or a closed menu showing it? */
  function selectionShows(el, text) {
    const want = JTF.util.normalize(text);
    if (!want) return true;
    if (JTF.util.normalize(el.value) === want) return true;
    if (chipsOf(el).some((c) => JTF.util.normalize(dom().textOf(c)).includes(want))) return true;
    const own = el.localName === 'input' ? '' : JTF.util.normalize(dom().textOf(el));
    return !!own && own.includes(want);
  }

  async function choose(el, option) {
    const text = dom().textOf(option);
    if (option.scrollIntoView) option.scrollIntoView({ block: 'nearest' });
    option.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, composed: true }));
    option.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, composed: true }));
    pointerClick(option);
    // Registered once the value shows, or the menu closes behind the click (slow re-renders included).
    for (let waited = 0; waited < 300; waited += 30) {
      await sleep(30);
      if (selectionShows(el, text) || !listboxFor(el)) return text;
    }
    // Some widgets only take the keyboard: highlight the option, then press Enter.
    if (option.isConnected && el.localName === 'input') {
      option.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, composed: true }));
      key(el, 'Enter');
      await sleep(30);
      if (selectionShows(el, text)) return text;
    }
    return null;
  }

  function closeMenu(el) {
    if (!listboxFor(el)) return;
    key(el.localName === 'input' ? el : el.ownerDocument.activeElement || el, 'Escape');
    if (el.localName !== 'input' && listboxFor(el)) pointerClick(el);
  }

  /**
   * Pick one option for `v` in an open (or openable) dropdown, skipping options already chosen.
   * Returns { chosen: text | null, opts, multi } — `multi` is read while the menu is open.
   */
  async function pickOne(el, v, searchable, already) {
    let opts = await openMenu(el, searchable);
    const multi = isMulti(el);
    const pick = () => {
      const idx = M().matchOption(describeOptions(opts), v);
      return idx >= 0 && !already.includes(dom().textOf(opts[idx])) ? idx : -1;
    };
    let idx = pick();
    if (idx < 0 && searchable) {
      for (const query of searchQueries(v)) {
        const before = optionsKey(opts);
        typeQuery(el, query);
        opts = await waitForOptions(el, SEARCH_WAIT, before);
        idx = pick();
        if (idx >= 0) break;
        if (!opts.length && !listboxFor(el)) break; // no suggestions at all: not a dropdown
      }
    }
    if (idx < 0) return { chosen: null, opts, multi };
    return { chosen: await choose(el, opts[idx]), opts, multi };
  }

  async function fillCombo(field, v) {
    const el = field.el;
    const isInput = el.localName === 'input';
    // react-select's isSearchable={false} renders a read-only dummy input that ignores typing.
    const searchable =
      isInput && !el.readOnly && el.getAttribute('aria-readonly') !== 'true' && el.getAttribute('inputmode') !== 'none';
    const items = v.kind === 'list' ? v.items.map((item) => JTF.fields.val(item)) : null;
    const chosen = [];
    let sawOptions = false;
    let multi = isMulti(el);
    const queue = multi && items ? items.slice() : [v];

    while (queue.length) {
      const value = queue.shift();
      const r = await pickOne(el, value, searchable, chosen);
      if (r.opts.length || listboxFor(el)) sawOptions = true;
      if (r.chosen) chosen.push(r.chosen);
      else if (isInput) clearQuery(el);
      // A multi-select only shows itself once open: then take every listed item, not just the first.
      if (!multi && r.multi && items) {
        multi = true;
        queue.push(...items.filter((it) => !chosen.some((c) => M().matchOption([{ text: c }], it) === 0)));
      }
      if (!multi) break;
    }

    if (!chosen.length && searchable && !sawOptions) {
      // A plain text box whose suggestions never appeared: type the full value and see if it sticks.
      const full = M().formatForText(v, field.desc) || v.text;
      typeQuery(el, full);
      fire(el, 'change');
      el.blur();
      await sleep(60);
      if (el.value === full) return { status: 'filled', value: full, typed: true };
      return { status: 'nomatch' };
    }

    closeMenu(el);
    if (isInput) el.blur();
    return chosen.length ? { status: 'filled', value: chosen.join(', ') } : { status: 'nomatch' };
  }

  function isMulti(el) {
    const lb = listboxFor(el);
    if (lb && lb.getAttribute('aria-multiselectable') === 'true') return true;
    if (el.getAttribute('aria-multiselectable') === 'true') return true;
    return !!el.closest('[class*="is-multi" i], [class*="isMulti" i], [class*="--multi" i]');
  }

  /* ------------------------------------------------------------- files */

  function dataUrlToFile(doc) {
    const [, meta, data] = doc.dataUrl.match(/^data:([^,]*),(.*)$/s) || [];
    if (data == null) throw new Error('Bad document');
    const isB64 = /;base64$/.test(meta);
    const raw = isB64 ? atob(data) : decodeURIComponent(data);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return new File([bytes], doc.name, { type: doc.type || 'application/octet-stream', lastModified: Date.now() });
  }

  function setFile(el, doc) {
    const dt = new DataTransfer();
    dt.items.add(dataUrlToFile(doc));
    el.files = dt.files;
    fire(el, 'input');
    fire(el, 'change');
  }

  /* ------------------------------------------------------------- apply */

  /**
   * Fill one scanned field with resolved value `v`.
   * Returns { status: 'filled' | 'skipped' | 'nomatch' | 'error', reason? }.
   */
  async function apply(field, v, opts) {
    const { el, kind, members, desc } = field;
    const history = opts.history;
    if (!opts.overwrite && hasValue(field)) return { status: 'skipped', reason: 'has value' };
    try {
      switch (kind) {
        case 'select': {
          const idx = M().matchOption(desc.options, v);
          if (idx < 0) return { status: 'nomatch' };
          history.push({ el, kind, prev: el.selectedIndex });
          el.selectedIndex = idx;
          fire(el, 'input');
          fire(el, 'change');
          return { status: 'filled' };
        }
        case 'radio': {
          const idx = M().matchOption(desc.options, v);
          if (idx < 0) return { status: 'nomatch' };
          history.push({ el, kind, members, prev: members.map(isChecked) });
          setChecked(members[idx], true);
          return { status: 'filled', target: members[idx] };
        }
        case 'checkboxes': {
          // A list ("London, New York") ticks every match; a single answer ticks its one option.
          let picks = v.kind === 'list' ? M().matchAll(desc.options, v) : [];
          if (!picks.length) {
            const idx = M().matchOption(desc.options, v);
            picks = idx >= 0 ? [idx] : M().matchAll(desc.options, v);
          }
          if (!picks.length) return { status: 'nomatch' };
          history.push({ el, kind, members, prev: members.map(isChecked) });
          for (const i of picks) setChecked(members[i], true);
          return { status: 'filled', target: members[picks[0]] };
        }
        case 'checkbox': {
          // One option of a checklist ("London" under "Which offices…?"), or a yes/no box.
          const tick = v.kind === 'list' ? M().matchAll(desc.options, v).length > 0 : v.canonical === 'yes';
          if (!tick) return { status: 'skipped', reason: 'not one of your answers' };
          history.push({ el, kind, prev: isChecked(el) });
          setChecked(el, true);
          return { status: 'filled' };
        }
        case 'file': {
          if (!v.document) return { status: 'nomatch' };
          history.push({ el, kind, prev: el.files });
          setFile(el, v.document);
          return { status: 'filled' };
        }
        case 'combo':
        case 'combobox': {
          if (opts.comboboxes) {
            const prev = el.value;
            const res = await fillCombo(field, v);
            // A picked option is undone with the widget's clear button; typed text by typing back.
            if (res.status === 'filled' && kind === 'combobox')
              history.push(res.typed ? { el, kind, prev } : { el, kind, prev: '', picked: true });
            return res;
          }
          // Custom dropdown handling switched off: type into searchable ones, leave buttons alone.
          if (kind === 'combo') return { status: 'skipped', reason: 'custom dropdowns are switched off' };
          history.push({ el, kind, prev: el.value });
          typeValue(el, M().formatForText(v, desc));
          return { status: 'filled' };
        }
        default: {
          const text = M().formatForText(v, desc);
          if (!text) return { status: 'nomatch' };
          history.push({ el, kind, prev: el.value });
          typeValue(el, text);
          return { status: 'filled' };
        }
      }
    } catch (err) {
      return { status: 'error', reason: String((err && err.message) || err) };
    }
  }

  /**
   * Undo a dropdown pick with the widget's own clear (×) button, or each chip's remove button.
   * Returns false when the widget offers no way to clear it.
   */
  function clearPicked(el) {
    let a = el.parentElement;
    for (let i = 0; a && i < 5; i++, a = a.parentElement) {
      const clear = a.querySelector(
        '[class*="clear-indicator"], [class*="clearIndicator"], [aria-label="Clear" i], [aria-label*="clear selection" i]',
      );
      if (clear) {
        pointerClick(clear);
        return true;
      }
      const removes = a.querySelectorAll(
        '[class*="multi-value__remove"], [class*="multiValueRemove"], [aria-label^="Remove" i]',
      );
      if (removes.length && chipsOf(el).length) {
        Array.from(removes).forEach((r) => pointerClick(r));
        return true;
      }
    }
    return false;
  }

  function undo(history) {
    let n = 0;
    for (const h of history.slice().reverse()) {
      try {
        if (!h.el.isConnected) continue;
        if (h.kind === 'select') {
          h.el.selectedIndex = h.prev;
          fire(h.el, 'change');
        } else if (h.kind === 'radio' || h.kind === 'checkboxes') {
          h.members.forEach((m, i) => setChecked(m, h.prev[i]));
        } else if (h.kind === 'checkbox') {
          setChecked(h.el, h.prev);
        } else if (h.kind === 'file') {
          const dt = new DataTransfer();
          for (const f of h.prev || []) dt.items.add(f);
          h.el.files = dt.files;
          fire(h.el, 'change');
        } else if (h.picked) {
          if (!clearPicked(h.el)) continue;
          key(h.el, 'Escape'); // clearing can pop the menu open again
          h.el.blur();
        } else {
          typeValue(h.el, h.prev || '');
        }
        n++;
      } catch (err) {
        /* element went away or refused; keep going */
      }
    }
    history.length = 0;
    return n;
  }

  /* --------------------------------------------------------- highlight */

  const highlighted = [];

  function highlight(el) {
    const target =
      el.type === 'radio' || el.type === 'checkbox'
        ? (el.labels && el.labels[0]) || el
        : el.type === 'file'
          ? el.parentElement || el
          : el;
    if (!target || !target.style || highlighted.some((h) => h.target === target)) return;
    highlighted.push({ target, outline: target.style.outline, offset: target.style.outlineOffset });
    target.style.outline = `2px solid ${HIGHLIGHT}`;
    target.style.outlineOffset = '1px';
    const clear = () => clearOne(target);
    target.addEventListener('focus', clear, { once: true });
    target.addEventListener('mousedown', clear, { once: true });
  }

  function clearOne(target) {
    const i = highlighted.findIndex((h) => h.target === target);
    if (i < 0) return;
    const h = highlighted[i];
    h.target.style.outline = h.outline;
    h.target.style.outlineOffset = h.offset;
    highlighted.splice(i, 1);
  }

  function clearHighlights() {
    while (highlighted.length) clearOne(highlighted[0].target);
  }

  JTF.fill = { apply, undo, hasValue, currentValue, highlight, clearHighlights, typeValue };
})(typeof globalThis !== 'undefined' ? globalThis : this);
