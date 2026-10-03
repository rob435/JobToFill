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
  // Answers the AI wrote: a different colour, so they stand out for review.
  const AI_HIGHLIGHT = 'rgba(234, 145, 12, 0.95)';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* --------------------------------------------------------------- events */

  function fire(el, type) {
    el.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
  }

  const KEY_CODES = { Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38, Backspace: 8, Tab: 9 };

  /** What a key press says about itself, legacy keyCode included (widgets that still read e.keyCode === 13). */
  function keyInit(k) {
    const code = KEY_CODES[k] ? k : /^\d$/.test(k) ? 'Digit' + k : /^[a-z]$/i.test(k) ? 'Key' + k.toUpperCase() : '';
    const keyCode = KEY_CODES[k] || (/^[a-z\d]$/i.test(k) ? k.toUpperCase().charCodeAt(0) : 0);
    return { key: k, code, keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true };
  }

  function key(el, k) {
    for (const type of ['keydown', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, keyInit(k)));
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

  /**
   * A box that only takes keys: Workday's date spin buttons ("YYYY") put back a value set from script, and a date in
   * parts that aren't inputs (MUI X's and React Aria's "MM/DD/YYYY" spans) has no value to set at all.
   */
  const takesKeys = (el) =>
    el.getAttribute('role') === 'spinbutton' ||
    /^dateSection/.test(el.getAttribute('data-automation-id') || '') ||
    !!datePartsOf(el);

  const datePartsOf = (el) => (el.localName === 'input' || el.localName === 'textarea' ? null : dom().dateSegments(el));

  // A date being typed into its parts, by field: closePopups waits for it (typeKeys can't be awaited by its callers).
  const typing = new WeakMap();

  /** One key into a contenteditable part: the widget takes it itself (React Aria, on beforeinput), else it is typed in. */
  function typeChar(target, ch) {
    const doc = target.ownerDocument;
    const init = keyInit(ch);
    const down = new KeyboardEvent('keydown', init);
    target.dispatchEvent(down);
    if (!down.defaultPrevented) {
      target.dispatchEvent(new KeyboardEvent('keypress', Object.assign({}, init, { charCode: ch.charCodeAt(0) })));
      const before = new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        composed: true,
        inputType: 'insertText',
        data: ch,
      });
      if (target.dispatchEvent(before)) {
        // Over what the part shows ("MM"), which the widget selects when the part gets focus.
        const range = doc.createRange();
        range.selectNodeContents(target);
        doc.getSelection().removeAllRanges();
        doc.getSelection().addRange(range);
        if (!doc.execCommand('insertText', false, ch)) {
          target.textContent = ch;
          target.dispatchEvent(
            new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: ch }),
          );
        }
      }
    }
    target.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  /**
   * Type a date into its parts like a person: focus each part ("MM", "DD", "YYYY") and type its digits, giving the
   * widget time to re-render between keys: an MUI X field keeps which part is being typed, and the keys typed so far,
   * in React state, so keys sent back to back would all be read against the state before the first. `text` is the
   * date written in the parts' order ("06/14/2027", dom.js gives the field that format). Resolves to whether every part
   * shows what was typed.
   */
  async function typeParts({ box, parts }, text) {
    const runs = String(text)
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean);
    if (runs.length !== parts.length) return false;
    const doc = box.ownerDocument;
    for (let i = 0; i < parts.length; i++) {
      parts[i].focus({ preventScroll: true });
      await sleep(20);
      for (const ch of runs[i]) {
        // Keys go where the focus is: a widget that moves on to the next part by itself has it there.
        const active = dom().deepActiveElement(doc);
        typeChar(active && parts.includes(active) ? active : parts[i], ch);
        await sleep(20);
      }
    }
    const active = dom().deepActiveElement(doc);
    if (active && box.contains(active)) active.blur();
    await sleep(20);
    return parts.every((p, i) => p.textContent.trim() === runs[i]);
  }

  /** What a date in parts shows ("06/14/2027"), '' while each part shows its placeholder ("MM"), null for other boxes. */
  function partsValue(el) {
    const found = datePartsOf(el);
    if (!found) return null;
    const filled = (p) =>
      /\d/.test(p.textContent) ||
      (p.hasAttribute('aria-valuenow') && !/^empty$/i.test(p.getAttribute('aria-valuetext') || ''));
    return found.parts.some(filled) ? found.parts.map((p) => p.textContent.trim()).join('/') : '';
  }

  /**
   * Type `text` key by key: each key goes to the widget first, and only when it doesn't take the key itself is the
   * character inserted the way the browser does. Falls back to typeValue when the box still disagrees. A date in parts
   * is typed part by part (typeParts), which takes a while: that returns a promise.
   */
  function typeKeys(el, text) {
    const found = datePartsOf(el);
    if (found) {
      const done = typeParts(found, text);
      typing.set(el, done);
      return done;
    }
    const doc = el.ownerDocument;
    el.focus({ preventScroll: true });
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }));
    if (el.select) el.select();
    for (const ch of text) {
      const init = keyInit(ch);
      const down = new KeyboardEvent('keydown', init);
      el.dispatchEvent(down);
      if (!down.defaultPrevented) {
        el.dispatchEvent(new KeyboardEvent('keypress', Object.assign({}, init, { charCode: ch.charCodeAt(0) })));
        if (!doc.execCommand('insertText', false, ch)) {
          setNativeValue(el, el.value + ch);
          el.dispatchEvent(
            new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: ch }),
          );
        }
      }
      el.dispatchEvent(new KeyboardEvent('keyup', init));
    }
    if (el.value !== text) return typeValue(el, text);
    fire(el, 'change');
    el.blur();
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
    // What the button shows: the choice, not a placeholder kept for screen readers or hidden once chosen.
    return dom().visibleText(el) || '';
  }

  const CHIP =
    '[class*="singleValue"], [class*="single-value"], [class*="selected-value"], [class*="multiValue"], [class*="multi-value"], [class*="MuiChip-root"], [data-automation-id="selectedItem"]';

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
        const shown = partsValue(el);
        if (shown != null) return !!shown;
        // A bare scheme or a dial code the widget put there ("+33" in react-phone-number-input) is still empty.
        const v = (el.value || '').trim();
        return !!v && !/^https?:\/\/$/.test(v) && !/^\+\d{1,4}$/.test(v);
      }
    }
  }

  /**
   * Does what the control already shows say the same as `v`? A country the site picked from where your connection
   * seems to be ("Italy" on Workday, a chip "Italy (+39)") doesn't, for a profile in the United Kingdom.
   */
  function agrees(field, v) {
    const { el, kind } = field;
    if (kind === 'select') return M().matchOption(field.desc.options, v) === el.selectedIndex;
    if (kind !== 'combo' && kind !== 'combobox') return true;
    const shown =
      kind === 'combo' ? [comboText(el)] : el.value.trim() ? [el.value] : chipsOf(el).map((c) => dom().textOf(c));
    return shown.some((text) => text && M().matchOption([{ text, value: '' }], v) === 0);
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
      default: {
        const shown = partsValue(el);
        return shown != null ? shown : (el.value || '').trim();
      }
    }
  }

  /* ---------------------------------------------------- custom dropdowns */

  const OPEN_WAIT = 600;
  const SEARCH_WAIT = 2500;

  const LISTBOX_LIKE =
    '[role="listbox"], ul[class*="listbox" i], ul[class*="result" i], ul[class*="option" i], ul[class*="dropdown" i], ul[class*="suggest" i], ul[class*="autocomplete" i], [class*="listbox-results" i], [class*="listbox-drop" i], [class*="dropdown-menu" i], [class*="select-menu" i], [class*="cx-select" i][class*="list" i], [class*="select__menu" i]';

  /** The row of chips a Workday prompt shows for what was picked ("Italy (+39)"): a listbox, but nobody's menu. */
  const isChipList = (lb) =>
    lb.matches('[data-automation-id="selectedItemList"]') || !!lb.querySelector('[data-automation-id="selectedItem"]');

  /** Workday's search prompts look up what was typed when Enter is pressed. */
  const searchesOnEnter = (el) => el.getAttribute('data-uxi-widget-type') === 'selectinput';

  /** Are `a` and `b` parts of one widget (a box and its toggle button): nothing else to fill around them? */
  function sameWidget(a, b) {
    if (a === b || a.contains(b) || b.contains(a)) return true;
    let common = a.parentElement;
    while (common && !common.contains(b)) common = common.parentElement;
    if (!common) return false;
    const others = common.querySelectorAll('input:not([type="hidden"]), select, textarea, [role="combobox"]');
    return !Array.from(others).some(
      (c) => c.getAttribute('aria-hidden') !== 'true' && ![a, b].some((x) => x.contains(c) || c.contains(x)),
    );
  }

  /**
   * Is this list another dropdown's (another field's control names it in aria-controls / aria-owns)? The menu of a
   * Select left open is not the one this field opens: reading it as ours would choose in the wrong field.
   */
  function ownedElsewhere(lb, el) {
    if (!lb.id) return false;
    const id = lb.id.replace(/["\\]/g, '\\$&');
    const owners = lb.ownerDocument.querySelectorAll(`[aria-controls~="${id}"], [aria-owns~="${id}"]`);
    return owners.length > 0 && !Array.from(owners).some((o) => sameWidget(o, el));
  }

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
      if (lb && dom().isVisible(lb) && !isChipList(lb)) return lb;
    }
    const comboLike =
      el.getAttribute('role') === 'combobox' ||
      el.hasAttribute('aria-haspopup') ||
      el.hasAttribute('aria-autocomplete') ||
      el.getAttribute('aria-expanded') === 'true' ||
      !!el.closest(
        '[role="combobox"], [class*="select" i], [class*="combobox" i], [class*="dropdown" i], [class*="listbox" i]',
      );
    const selector = comboLike ? LISTBOX_LIKE : '[role="listbox"]';
    const all = Array.from(rootNode.querySelectorAll(selector));
    if (rootNode !== doc) all.push(...doc.querySelectorAll(selector));
    // Nested matches (ul inside div.oj-listbox-drop): keep the outermost.
    const cands = all.filter(
      (lb) =>
        dom().isVisible(lb) &&
        !lb.closest('[data-jtf-ui]') &&
        !lb.contains(el) &&
        !isChipList(lb) &&
        !ownedElsewhere(lb, el),
    );
    const visible = cands.filter((lb) => !cands.some((o) => o !== lb && o.contains(lb)));
    if (!visible.length) return null;
    for (let a = el.parentElement, i = 0; a && i < 6; a = a.parentElement, i++) {
      const near = visible.find((lb) => a.contains(lb));
      if (near) return near;
    }
    return visible[visible.length - 1]; // portals are usually appended last
  }

  const OPTION_ROLES = '[role="option"]';
  const MENUITEM_ROLES = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="treeitem"]';
  const OPTION_CLASSES =
    '[class*="option" i], [class*="result" i], [class*="item" i], [class*="suggest" i], [class*="cx-select" i]';
  const NO_RESULTS =
    /^(no (results?|matches|options|items|data)( found)?|nothing found|loading|searching|type to search)/i;

  /** The rows of a list, however the widget marks them up (ARIA roles first, then <li>, then class names). */
  function optionsIn(lb) {
    const usable = (nodes) =>
      nodes.filter((o) => {
        const t = (dom().textOf(o) || o.getAttribute('aria-label') || '').trim();
        return t && !NO_RESULTS.test(t);
      });
    for (const sel of [OPTION_ROLES, MENUITEM_ROLES]) {
      const found = Array.from(lb.querySelectorAll(sel));
      if (found.length) return usable(found);
    }
    const lis = usable(Array.from(lb.querySelectorAll('li')));
    if (lis.length) return lis;
    const classed = Array.from(lb.querySelectorAll(OPTION_CLASSES)).filter(
      (o) => !/group|header|title|label-text/i.test(o.className),
    );
    // Innermost rows only: "oj-listbox-result" wraps "oj-listbox-result-label".
    const leaves = usable(classed.filter((o) => !classed.some((x) => x !== o && o.contains(x))));
    if (leaves.length) return leaves;
    return usable(Array.from(lb.children).filter((c) => !c.querySelector('input, textarea')));
  }

  function currentOptions(el) {
    const lb = listboxFor(el);
    let opts = lb ? optionsIn(lb) : [];
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
  async function waitForOptions(el, timeout, previous, staleList) {
    const start = Date.now();
    let lastKey = null;
    let stable = 0;
    let empty = 0;
    let opts = [];
    while (Date.now() - start < timeout) {
      opts = currentOptions(el);
      // An empty menu that has stopped loading ("No options") won't fill up later. A Workday prompt's search
      // answers with a list of its own ("No Items."): that one is final at once.
      if (!opts.length && Date.now() - start > 900 && !isLoading(el)) return opts;
      const list = staleList !== undefined && !opts.length ? listboxFor(el) : null;
      if (list && list !== staleList && !isLoading(el) && ++empty >= 2) return opts;
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

  /**
   * Words to type into a searchable dropdown, best first: "University of Glasgow", then "Glasgow". Countries
   * also try their short spellings ("UK"). `narrow` is a last-resort single word, only worth typing when the
   * full queries showed no options at all.
   */
  function searchQueries(v) {
    const out = [];
    const add = (q) => {
      q = String(q || '').trim();
      if (q && !out.some((x) => x.toLowerCase() === q.toLowerCase())) out.push(q);
    };
    if (v.kind === 'list') (v.items || []).slice(0, 3).forEach(add);
    add(v.search);
    add(v.text.length <= 60 ? v.text : '');
    // "Computing Science" is listed as "Computer Science" more often than not.
    if (v.kind === 'subject') (v.candidates || []).slice(1, 3).forEach(add);
    if (v.kind === 'country') {
      for (const c of v.candidates || [])
        if (c.length >= 2 && c.length <= 24 && !/[.,]/.test(c) && !/^[A-Z]{3}$/.test(c)) add(c);
      return { full: out.slice(0, 4), narrow: null };
    }
    const words = JTF.util
      .tokens(v.search || v.text)
      .filter((w) => w.length > 3 && !/^(university|college|school|institute|of|the)$/.test(w));
    return { full: out.slice(0, 3), narrow: words.length > 1 ? words.sort((a, b) => b.length - a.length)[0] : null };
  }

  /** Did picking `text` register: a chip, the input's own value, or a closed menu showing it? */
  function selectionShows(el, text, typed) {
    const want = JTF.util.normalize(text);
    if (!want) return true;
    const have = JTF.util.normalize(el.value);
    if (have === want) return true;
    // Widgets that show a shorter form of the option ("United Kingdom" for "United Kingdom (GB)").
    if (have.length >= 3 && have !== JTF.util.normalize(typed || '') && (want.includes(have) || have.includes(want)))
      return true;
    if (chipsOf(el).some((c) => JTF.util.normalize(dom().textOf(c)).includes(want))) return true;
    const own = el.localName === 'input' ? '' : JTF.util.normalize(dom().textOf(el));
    return !!own && own.includes(want);
  }

  const ACTIVE_ROW =
    /\b(active|highlight(ed)?|focus(ed)?|hover(ed)?|selected|current)\b|--(active|focused|highlighted)/i;
  function isActiveRow(el, option) {
    const id = el.getAttribute('aria-activedescendant');
    if (id && option.id === id) return true;
    for (let n = option, i = 0; n && i < 3; n = n.parentElement, i++) {
      if (n.getAttribute('aria-selected') === 'true' || ACTIVE_ROW.test(String(n.className || ''))) return true;
    }
    return false;
  }

  /** Walk the highlight down with ArrowDown until `option` is the active row, then press Enter. */
  async function chooseByKeyboard(el, option) {
    const list = currentOptions(el);
    const idx = list.indexOf(option);
    if (idx < 0) return;
    el.focus({ preventScroll: true });
    key(el, 'ArrowDown');
    await sleep(30);
    if (!list.some((o) => isActiveRow(el, o))) {
      // No visible highlight to follow: the first press lands on the first row.
      for (let i = 0; i < idx; i++) key(el, 'ArrowDown');
    } else {
      for (let i = 0; i < list.length && !isActiveRow(el, option); i++) {
        key(el, 'ArrowDown');
        await sleep(20);
      }
    }
    await sleep(20);
    key(el, 'Enter');
    await sleep(40);
  }

  /** A role="menuitemcheckbox" / "menuitemradio" that is ticked. */
  const isTicked = (option) => option.isConnected && option.getAttribute('aria-checked') === 'true';

  async function choose(el, option) {
    const text = dom().textOf(option);
    const typed = el.localName === 'input' ? el.value : '';
    if (option.scrollIntoView) option.scrollIntoView({ block: 'nearest' });
    for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove']) {
      const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      option.dispatchEvent(new Ctor(type, { bubbles: true, composed: true }));
    }
    const before = currentOptions(el);
    pointerClick(option);
    // Registered once the value shows, or the menu closes behind the click (slow re-renders included). A category
    // that opens its own options instead (Workday's "Social Media" > "LinkedIn") says so.
    for (let waited = 0; waited < 300; waited += 30) {
      await sleep(30);
      // A menu that stays open ticks the item itself (Teamtailor shows "a, b, c, +2" once there are more than three).
      if (selectionShows(el, text, typed) || !listboxFor(el) || isTicked(option)) return text;
      const now = currentOptions(el);
      if (!option.isConnected && now.length && optionsKey(now) !== optionsKey(before)) return { drilled: true };
    }
    // Some widgets only take the keyboard: highlight the option, then press Enter.
    if (option.isConnected && el.localName === 'input') {
      await chooseByKeyboard(el, option);
      for (let waited = 0; waited < 150; waited += 30) {
        if (selectionShows(el, text, typed) || !listboxFor(el)) return text;
        await sleep(30);
      }
    }
    return null;
  }

  /**
   * Wait while a menu the widget already calls closed (aria-expanded="false") is still on screen: an MUI Select's menu
   * fades out for ~200 ms after a pick or Escape. Clicking the widget then would open it again, and the next dropdown
   * would find it still open.
   */
  async function menuGone(el) {
    for (let waited = 0; waited < 500 && el.getAttribute('aria-expanded') === 'false' && listboxFor(el); waited += 40)
      await sleep(40);
    return !listboxFor(el);
  }

  async function closeMenu(el) {
    if (await menuGone(el)) return;
    key(el.localName === 'input' ? el : el.ownerDocument.activeElement || el, 'Escape');
    await sleep(40);
    if (!(await menuGone(el)) && el.localName !== 'input') pointerClick(el);
  }

  /**
   * Pick one option for `v` in an open (or openable) dropdown, skipping options already chosen.
   * Returns { chosen: text | null, opts, multi } — `multi` is read while the menu is open.
   */
  async function pickOne(el, v, searchable, already) {
    // A Workday prompt lists nothing worth reading before a search: go straight to typing (not for checklists).
    const straight = searchable && searchesOnEnter(el) && !v.many;
    if (straight) el.focus({ preventScroll: true });
    let opts = straight ? [] : await openMenu(el, searchable);
    const multi = isMulti(el);
    const pick = () => {
      const listed = describeOptions(opts);
      // A multi-select takes every slot or statement that fits, one per call, judged with the ones it took already
      // (react-select hides those): "None of these dates work" is never added to them. One ticked already stays.
      const list =
        v.many && multi
          ? M().matchAll([...listed, ...already.map((t) => ({ text: t, value: '' }))], v)
          : [M().matchOption(listed, v)];
      const idx = list.find(
        (i) => i >= 0 && i < opts.length && !already.includes(dom().textOf(opts[i])) && !(multi && isTicked(opts[i])),
      );
      return idx == null ? -1 : idx;
    };
    let idx = pick();
    // Statements and slots are judged against the whole list as it opened: typing would only hide some.
    if (idx < 0 && searchable && !v.many) {
      const { full, narrow } = searchQueries(v);
      let sawAny = false;
      for (const query of narrow ? [...full, narrow] : full) {
        // A single word is a last resort: when the full spelling already listed options, they were all
        // judged above, and a vaguer query would only invite the wrong pick.
        if (query === narrow && sawAny) break;
        const before = optionsKey(opts);
        const shown = searchesOnEnter(el) ? listboxFor(el) : undefined;
        typeQuery(el, query);
        if (searchesOnEnter(el)) key(el, 'Enter');
        opts = await waitForOptions(el, SEARCH_WAIT, before, shown);
        if (opts.length) sawAny = true;
        idx = pick();
        if (idx >= 0) break;
        if (!opts.length && !listboxFor(el)) break; // no suggestions at all: not a dropdown
      }
    }
    if (idx < 0) return { chosen: null, opts, multi };
    let chosen = await choose(el, opts[idx]);
    // A two-level list (Workday's "Social Media" > "LinkedIn"): the category opened its own options; pick from those.
    for (let depth = 0; chosen && chosen.drilled && depth < 2; depth++) {
      opts = currentOptions(el);
      idx = pick();
      chosen = idx >= 0 ? await choose(el, opts[idx]) : null;
    }
    return { chosen: chosen && chosen.drilled ? null : chosen, opts, multi };
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
      if (!multi && r.multi && v.many) multi = true;
      // Every slot or statement that fits: ask again until none is left.
      if (multi && v.many && r.chosen && chosen.length < 40) queue.push(v);
      if (!multi) break;
    }

    // A prompt only keeps a picked suggestion: typed text would be wiped as soon as the box loses focus.
    if (!chosen.length && searchable && !sawOptions && !v.many && !searchesOnEnter(el)) {
      // A plain text box whose suggestions never appeared: type the full value and see if it sticks.
      const full = M().formatForText(v, field.desc) || v.text;
      typeQuery(el, full);
      fire(el, 'change');
      el.blur();
      await sleep(60);
      if (el.value === full) return { status: 'filled', value: full, typed: true };
      return { status: 'nomatch' };
    }

    await closeMenu(el);
    if (isInput) el.blur();
    return chosen.length ? { status: 'filled', value: chosen.join(', ') } : { status: 'nomatch' };
  }

  /**
   * The options a custom dropdown offers, read by opening it and closing it again without choosing anything:
   * { options: [text], multi }. A searchable box that only lists matches for what's typed gives no options.
   */
  async function peekOptions(field) {
    const el = field.el;
    if (field.kind !== 'combo' && field.kind !== 'combobox') return null;
    const isInput = el.localName === 'input';
    const searchable =
      isInput && !el.readOnly && el.getAttribute('aria-readonly') !== 'true' && el.getAttribute('inputmode') !== 'none';
    try {
      const opts = await openMenu(el, searchable);
      const multi = isMulti(el);
      const options = describeOptions(opts)
        .map((o) => JTF.util.cleanLabel(o.text, 200))
        .filter((t) => t && !M().isPlaceholder(JTF.util.normalize(t)) && !/^no (options|results)/i.test(t));
      return { options: [...new Set(options)], multi };
    } finally {
      await closeMenu(el);
      if (isInput) el.blur();
    }
  }

  function isMulti(el) {
    const lb = listboxFor(el);
    if (lb && lb.getAttribute('aria-multiselectable') === 'true') return true;
    // A menu of ticks ("How did you hear about us?" on Teamtailor) takes several.
    if (lb && lb.querySelector('[role="menuitemcheckbox"]')) return true;
    if (el.getAttribute('aria-multiselectable') === 'true') return true;
    return !!el.closest('[class*="is-multi" i], [class*="isMulti" i], [class*="--multi" i]');
  }

  /* ------------------------------------------------------------ popups */

  const POPUP =
    '[role="listbox"], [role="dialog"], [role="grid"], .react-datepicker-popper, .flatpickr-calendar.open, .ui-datepicker, [class*="datepicker" i][class*="popper" i], [class*="DayPicker" i]';

  function openPopups(doc) {
    return Array.from(doc.querySelectorAll(POPUP)).filter((p) => !p.closest('[data-jtf-ui]') && dom().isVisible(p));
  }

  /**
   * A date picker or suggestion list that typing opened (react-datepicker's calendar on Ashby) is closed again:
   * Escape, then a click outside. Popups that were open before (an application in a modal) are left alone.
   */
  async function closePopups(el, before) {
    // A date still being typed in parts (typeKeys) is finished first.
    const pending = typing.get(el);
    if (pending) {
      typing.delete(el);
      await pending;
    }
    const doc = el.ownerDocument;
    const fresh = () => openPopups(doc).filter((p) => !before.includes(p) && !p.contains(el));
    // Widgets open on focus synchronously: nothing new now means nothing to close (and no time lost per box).
    if (!fresh().length) return;
    // Escape or a click outside would also close a modal the form itself sits in: leave those alone.
    const modal = '[role="dialog"], [aria-modal="true"]';
    if (el.closest(modal) || before.some((p) => p.matches(modal))) return;
    const active = dom().deepActiveElement(doc);
    if (active && active !== el && active !== doc.body) key(active, 'Escape');
    key(el, 'Escape');
    await sleep(30);
    if (!fresh().length) return;
    for (const type of ['mousedown', 'mouseup', 'click'])
      doc.body.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: doc.defaultView }));
    await sleep(30);
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

  /**
   * Put one document or several (in that order) into a file box. `keep`: after the files it already holds, but for
   * those named in `keep.except` and those of the same name as a new one, which give way to the new ones.
   */
  function setFile(el, docs, keep) {
    const files = [].concat(docs).map(dataUrlToFile);
    const gone = new Set([...files.map((f) => f.name), ...((keep && keep.except) || [])]);
    const dt = new DataTransfer();
    if (keep) for (const f of Array.from(el.files || [])) if (!gone.has(f.name)) dt.items.add(f);
    for (const f of files) dt.items.add(f);
    el.files = dt.files;
    fire(el, 'input');
    fire(el, 'change');
  }

  /* ------------------------------------------------------ upload menus */

  // Upload tiles whose file box only exists once you choose where the file comes from: SuccessFactors' "Upload a
  // Resume" (its N:_attachIcon) opens "Upload from Device / Upload from Dropbox / Sign in with Google", and only
  // the box that "Upload from Device" makes uploads anything (a file put straight into an earlier one stays
  // "Uploading…" for ever). Phenom, iCIMS and others have the same kind of menu.
  const UPLOAD_TRIGGER =
    /^(upload|attach|add|choose|select|browse|import)( a| an| your| my| new)? (resume|cv|curriculum vitae|cover letter|letter|document|file|attachment|transcript)s?\b/;
  const DEVICE_OPTION =
    /^(upload|select|choose|browse|pick|attach|add)?( a)?( file)?( from)?( my| this| your| the| local)? ?(device|computer|desktop|pc|mac|local (drive|disk|files?)|files?|hard drive)$|^(choose|select|browse for) (a )?files?$|\bvon (meinem |diesem )?gerat\b|\bdepuis (l |mon |votre )?(appareil|ordinateur)\b|\bdesde (el |mi |su )?(dispositivo|equipo|ordenador)\b/;
  // Never chosen: anything that signs in to or fetches from another service.
  const CLOUD_OPTION =
    /dropbox|google|drive|one ?drive|\bbox\b|icloud|linked ?in|indeed|seek|\burl\b|\blink\b|paste|sign ?in|log ?in|cloud|camera|photo|scan/;
  const TRIGGERS = 'button, a, [role="button"], [role="link"], [id$=":_attachIcon"], [tabindex]:not([tabindex="-1"])';
  const MENU_ITEMS = '[role="menuitem"], [role="option"], [role="button"], button, a, li, label';

  const triggerText = (el) =>
    JTF.util.normalize(dom().textOf(el) || el.getAttribute('aria-label') || el.getAttribute('title') || '');

  /**
   * The upload tiles on a page that have no file box yet: [{ el, box, desc }], `desc` being what to classify it
   * by (its own wording and the label of its row: "* Resume", "Additional Documents (References…)").
   */
  function uploadTriggers(doc) {
    const found = Array.from(doc.querySelectorAll(TRIGGERS)).filter((el) => {
      if (!dom().isVisible(el) || el.closest('[data-jtf-ui]') || el.disabled) return false;
      // Never a link that leaves the page or a button that submits its form.
      if (el.localName === 'a' && !/^(#|javascript:|$)/i.test((el.getAttribute('href') || '').trim())) return false;
      if (el.form && el.matches('button:not([type="button"]):not([type="reset"]), input[type="submit"]')) return false;
      return /:_attachIcon$/.test(el.id) || UPLOAD_TRIGGER.test(triggerText(el));
    });
    // The innermost of nested candidates (a link inside a focusable tile).
    const list = found.filter((el) => !found.some((o) => o !== el && el.contains(o)));
    const out = [];
    for (const el of list) {
      let box = el;
      for (let a = el.parentElement; a && a !== doc.body; a = a.parentElement) {
        if (list.some((o) => o !== el && a.contains(o))) break;
        if (a.querySelector('input:not([type="hidden"]):not([type="file"]), select, textarea')) break;
        box = a;
      }
      // A box that already has its file input is filled like any other, unless it is SuccessFactors' own, which
      // only uploads once "Upload from Device" has made it.
      const input = box.querySelector('input[type="file"]');
      if (input && !/:_file$/.test(input.id)) continue;
      const own = JTF.util.cleanLabel(dom().textOf(el) || el.getAttribute('aria-label') || '', 120);
      let row = JTF.util.cleanLabel(dom().textOf(box), 300);
      if (own && row.startsWith(own)) row = row.slice(own.length).trim();
      else if (own) row = row.replace(own, ' ').trim();
      const desc = {
        kind: 'file',
        inputType: 'file',
        autocomplete: '',
        maxLength: 0,
        placeholderRaw: '',
        options: null,
        signals: { label: own, question: row, id: el.id || '', title: el.getAttribute('title') || '' },
      };
      out.push({ el, box, desc });
    }
    return out;
  }

  /** The "Upload from Device" choice a tile's menu or dialog just showed (never Dropbox, Google…). */
  function deviceOption(doc, trigger, before) {
    return (
      Array.from(doc.querySelectorAll(MENU_ITEMS)).find((el) => {
        if (before.has(el) || trigger.contains(el) || el.closest('[data-jtf-ui]') || !dom().isVisible(el)) return false;
        const t = triggerText(el);
        return t.length <= 60 && DEVICE_OPTION.test(t) && !CLOUD_OPTION.test(t);
      }) || null
    );
  }

  /**
   * Put `doc` into an upload tile: click the tile, choose "Upload from Device" if it asks where the file comes
   * from, and give the file box that makes the file. The page's own click on that box (which would open the file
   * picker) is caught and cancelled, so no dialog opens. Returns { status: 'filled', confirmed } once the file is
   * in (confirmed: the tile shows its name), or { status: 'nomatch' } when no file box turned up.
   */
  async function attachVia(trigger, doc, opts) {
    const page = trigger.el.ownerDocument;
    const visibleItems = new Set(Array.from(page.querySelectorAll(MENU_ITEMS)).filter((el) => dom().isVisible(el)));
    const earlier = new Set(page.querySelectorAll('input[type="file"]'));
    let input = null;
    const catchPicker = (e) => {
      const t = e.composedPath ? e.composedPath()[0] : e.target;
      if (t && t.localName === 'input' && t.type === 'file') {
        input = t;
        e.preventDefault(); // the file picker stays shut
      }
    };
    page.addEventListener('click', catchPicker, true);
    let chose = null;
    try {
      pointerClick(trigger.el);
      for (let waited = 0; waited < 2500 && !input; waited += 50) {
        await sleep(50);
        if (chose) continue;
        chose = deviceOption(page, trigger.el, visibleItems);
        if (chose) pointerClick(chose);
      }
      // A file box made but never clicked.
      if (!input && chose) {
        const fresh = Array.from(page.querySelectorAll('input[type="file"]')).filter((el) => !earlier.has(el));
        input = fresh[fresh.length - 1] || null;
      }
    } finally {
      page.removeEventListener('click', catchPicker, true);
    }
    if (!input) {
      // Close a menu that offered nothing usable.
      if (Array.from(page.querySelectorAll(MENU_ITEMS)).some((el) => !visibleItems.has(el) && dom().isVisible(el)))
        key(page.activeElement || page.body, 'Escape');
      return { status: 'nomatch' };
    }
    opts.history.push({ el: input, kind: 'file', prev: input.files });
    setFile(input, doc);
    // The tile shows the file's name (or says it uploaded) once it has.
    const name = JTF.util.normalize(doc.name.replace(/\.[a-z0-9]+$/i, ''));
    const shows = () => {
      const text = JTF.util.normalize(trigger.box.isConnected ? trigger.box.textContent : page.body.textContent);
      return (
        (!!name && text.includes(name)) ||
        /\b(uploaded|upload (complete|successful)|erfolgreich hochgeladen)\b/.test(text)
      );
    };
    for (let waited = 0; waited < 8000 && !shows(); waited += 200) await sleep(200);
    return { status: 'filled', confirmed: shows(), target: trigger.box };
  }

  /* ------------------------------------------------------------- apply */

  /**
   * Fill one scanned field with resolved value `v`.
   * Returns { status: 'filled' | 'skipped' | 'nomatch' | 'error', reason? }.
   */
  async function apply(field, v, opts) {
    const { el, kind, members, desc } = field;
    const history = opts.history;
    // `correct`: what the site chose for you is replaced when it isn't yours (a country taken from your IP address).
    const had = hasValue(field);
    const correcting = had && !opts.overwrite && !!opts.correct && !agrees(field, v);
    if (had && !opts.overwrite && !correcting) return { status: 'skipped', reason: 'has value' };
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
          // A list ("London, New York") ticks every match; a single answer ticks its one option; an
          // acknowledgement ticks each statement you agree to ("…you consent to our privacy statement").
          // Sanctions statements and interview slots tick each one that is true of you (or "None of the above").
          let picks = v.kind === 'list' || v.many ? M().matchAll(desc.options, v) : [];
          if (v.consent)
            picks = desc.options.map((o, i) => (JTF.fields.isAcknowledgement(o.text) ? i : -1)).filter((i) => i >= 0);
          if (!picks.length && !v.many) {
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
          const tick = v.kind === 'list' || v.many ? M().matchAll(desc.options, v).length > 0 : v.canonical === 'yes';
          if (!tick) return { status: 'skipped', reason: 'not one of your answers' };
          history.push({ el, kind, prev: isChecked(el) });
          setChecked(el, true);
          return { status: 'filled' };
        }
        case 'file': {
          // A box that takes several files gets them in one go ("Resume/CV/Transcripts": CV, letter, transcript).
          const docs = v.documents || (v.document ? [v.document] : []);
          if (!docs.length) return { status: 'nomatch' };
          history.push({ el, kind, prev: el.files });
          setFile(el, docs, v.keep);
          return { status: 'filled' };
        }
        case 'combo':
        case 'combobox': {
          if (opts.comboboxes) {
            const prev = el.value;
            // The site's chip ("Italy (+39)") goes first, or the right one would only join it.
            if (correcting && kind === 'combobox' && chipsOf(el).length) {
              if (!clearPicked(el)) return { status: 'skipped', reason: 'has value' };
              await sleep(150);
              key(el, 'Escape'); // clearing can pop the menu open again
            }
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
          let text = M().formatForText(v, desc);
          // The box already shows a dial code: type the whole international number, so the widget's own
          // country picker follows it ("+33" -> "+44 7700 900123").
          if (v.kind === 'phone' && v.international && /^\+\d{1,4}$/.test((el.value || '').trim()))
            text = M().formatForText(Object.assign({}, v, { text: v.international }), desc);
          if (!text) return { status: 'nomatch' };
          history.push({ el, kind, prev: el.value });
          const before = openPopups(el.ownerDocument);
          if (takesKeys(el)) typeKeys(el, text);
          else typeValue(el, text);
          await closePopups(el, before);
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
        '[class*="multi-value__remove"], [class*="multiValueRemove"], [aria-label^="Remove" i], [data-automation-id="DELETE_charm"]',
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

  function highlight(el, ai) {
    const target =
      el.type === 'radio' || el.type === 'checkbox'
        ? (el.labels && el.labels[0]) || el
        : el.type === 'file'
          ? el.parentElement || el
          : el;
    if (!target || !target.style || highlighted.some((h) => h.target === target)) return;
    highlighted.push({ target, outline: target.style.outline, offset: target.style.outlineOffset });
    target.style.outline = `2px ${ai ? 'dashed' : 'solid'} ${ai ? AI_HIGHLIGHT : HIGHLIGHT}`;
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

  JTF.fill = {
    apply,
    undo,
    hasValue,
    currentValue,
    highlight,
    clearHighlights,
    typeValue,
    peekOptions,
    uploadTriggers,
    attachVia,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
