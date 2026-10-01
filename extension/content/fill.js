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

  function setChecked(el, checked) {
    if (el.checked === checked) return;
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

  const CHIP = '[class*="singleValue"], [class*="single-value"], [class*="selected-value"]';

  /** The selected-value element of a react-select style widget, looking only inside its own container. */
  function selectedChip(el) {
    let a = el.parentElement;
    for (let i = 0; a && i < 5; i++, a = a.parentElement) {
      const others = Array.from(
        a.querySelectorAll('input:not([type="hidden"]), select, textarea, [role="combobox"]'),
      ).filter((c) => c !== el && !c.contains(el));
      if (others.length) return null;
      const chip = a.querySelector(CHIP);
      if (chip) return chip;
    }
    return null;
  }

  /** Does this control already hold something the user (or site) put there? */
  function hasValue(field) {
    const { el, kind, members } = field;
    switch (kind) {
      case 'select':
        return !isUntouchedSelect(el);
      case 'radio':
        return members.some((m) => m.checked && !m.defaultChecked);
      case 'checkboxes':
        return members.some((m) => m.checked !== m.defaultChecked);
      case 'checkbox':
        return el.checked;
      case 'file':
        return el.files && el.files.length > 0;
      case 'combo': {
        const t = comboText(el);
        return !!t && !M().isPlaceholder(JTF.util.normalize(t));
      }
      case 'combobox':
        return !!el.value.trim() || !!selectedChip(el);
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
        const m = members.find((x) => x.checked);
        return m ? field.desc.options[members.indexOf(m)].text : '';
      }
      case 'checkboxes':
        return members
          .filter((m) => m.checked)
          .map((m) => field.desc.options[members.indexOf(m)].text)
          .join(', ');
      case 'checkbox':
        return el.checked ? 'Yes' : '';
      case 'file':
      case 'password':
        return '';
      case 'combo': {
        const t = comboText(el);
        return M().isPlaceholder(JTF.util.normalize(t)) ? '' : t;
      }
      case 'combobox': {
        if (el.value.trim()) return el.value.trim();
        const chip = selectedChip(el);
        return chip ? dom().textOf(chip) : '';
      }
      default:
        return (el.value || '').trim();
    }
  }

  /* ---------------------------------------------------- custom dropdowns */

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
    if (!opts.length && el.id) {
      // react-select without ARIA roles: <input id="react-select-3-input"> -> #react-select-3-option-0…
      const m = el.id.match(/^(.*)-input$/);
      if (m) opts = Array.from(el.ownerDocument.querySelectorAll(`[id^="${CSS.escape(m[1])}-option-"]`));
    }
    return opts.filter((o) => o.getAttribute('aria-disabled') !== 'true' && dom().isVisible(o));
  }

  async function waitForOptions(el, timeout) {
    const start = Date.now();
    let last = -1;
    let stable = 0;
    let opts = [];
    while (Date.now() - start < timeout) {
      opts = currentOptions(el);
      if (opts.length && opts.length === last) {
        if (++stable >= 2) return opts;
      } else stable = 0;
      last = opts.length;
      await sleep(60);
    }
    return opts;
  }

  function pickOption(opts, v) {
    const described = opts.map((o) => ({
      text: dom().textOf(o) || o.getAttribute('aria-label') || '',
      value: o.getAttribute('data-value') || o.getAttribute('value') || '',
    }));
    return M().matchOption(described, v);
  }

  async function fillCombo(field, v) {
    const el = field.el;
    const isInput = el.localName === 'input';
    const searchable = isInput && !el.readOnly;
    let typed = false;

    if (isInput) {
      el.focus({ preventScroll: true });
      key(el, 'ArrowDown');
    } else {
      pointerClick(el);
    }
    let opts = await waitForOptions(el, 700);
    let idx = pickOption(opts, v);

    if (idx < 0 && searchable) {
      const query = v.search || v.text;
      setNativeValue(el, query);
      el.dispatchEvent(
        new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: query }),
      );
      typed = true;
      opts = await waitForOptions(el, 2000);
      idx = pickOption(opts, v);
      if (idx < 0 && !opts.length && !listboxFor(el)) {
        // A plain text box whose suggestions never appeared: leave the full value in it.
        const full = M().formatForText(v, field.desc) || query;
        if (full !== query) {
          setNativeValue(el, full);
          el.dispatchEvent(
            new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: full }),
          );
        }
        fire(el, 'change');
        el.blur();
        return { status: 'filled', value: full };
      }
    }

    if (idx >= 0) {
      const option = opts[idx];
      const text = dom().textOf(option);
      if (option.scrollIntoView) option.scrollIntoView({ block: 'nearest' });
      pointerClick(option);
      await sleep(80);
      if (isInput) el.blur();
      return { status: 'filled', value: text };
    }

    if (typed) {
      setNativeValue(el, '');
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward' }));
    }
    key(isInput ? el : el.ownerDocument.activeElement || el, 'Escape');
    if (!isInput && listboxFor(el)) pointerClick(el); // close it again
    if (isInput) el.blur();
    return { status: 'nomatch' };
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
          history.push({ el, kind, members, prev: members.map((m) => m.checked) });
          setChecked(members[idx], true);
          return { status: 'filled', target: members[idx] };
        }
        case 'checkboxes': {
          const wanted = String(v.text)
            .split(/\s*[,;\n]\s*/)
            .filter(Boolean);
          const picks = new Set();
          for (const w of wanted) {
            const idx = M().matchOption(desc.options, JTF.fields.val(w));
            if (idx >= 0) picks.add(idx);
          }
          if (!picks.size) return { status: 'nomatch' };
          history.push({ el, kind, members, prev: members.map((m) => m.checked) });
          for (const i of picks) setChecked(members[i], true);
          return { status: 'filled', target: members[[...picks][0]] };
        }
        case 'checkbox': {
          if (v.canonical !== 'yes') return { status: 'skipped', reason: 'answer is not yes' };
          history.push({ el, kind, prev: el.checked });
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
            if (kind === 'combobox') history.push({ el, kind, prev: el.value });
            return await fillCombo(field, v);
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

  function undo(history) {
    let n = 0;
    for (const h of history.slice().reverse()) {
      try {
        if (!h.el.isConnected) continue;
        if (h.kind === 'select') {
          h.el.selectedIndex = h.prev;
          fire(h.el, 'change');
        } else if (h.kind === 'radio' || h.kind === 'checkboxes') {
          h.members.forEach((m, i) => {
            if (m.checked !== h.prev[i]) setChecked(m, h.prev[i]);
          });
        } else if (h.kind === 'checkbox') {
          setChecked(h.el, h.prev);
        } else if (h.kind === 'file') {
          const dt = new DataTransfer();
          for (const f of h.prev || []) dt.items.add(f);
          h.el.files = dt.files;
          fire(h.el, 'change');
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
