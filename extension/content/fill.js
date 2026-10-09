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
  // What the page didn't keep or turned down, for you to look at.
  const CHECK_HIGHLIGHT = 'rgba(220, 38, 38, 0.95)';
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
    // As a mouse sends them: a click with no click count (detail 0) is what Enter on a button makes, and BambooHR's
    // menu buttons leave those to their keyboard handling.
    const pointer = { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    const mouse = { ...init, detail: 1 };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, buttons: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...mouse, buttons: 1 }));
    el.dispatchEvent(new PointerEvent('pointerup', pointer));
    el.dispatchEvent(new MouseEvent('mouseup', mouse));
    el.dispatchEvent(new MouseEvent('click', mouse));
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
    fitMask(el, value);
  }

  /**
   * A box with a fixed pattern (an input mask such as "(999) 999-9999") that kept only the first digits of an
   * international number ("(141) 555-5010" from "+1 415 555 0100") has room for the national number alone: it gets
   * the number's last digits, as many as it holds.
   */
  function fitMask(el, value) {
    if (el.localName !== 'input' || !/^\+\d[\d\s().-]*$/.test(value)) return;
    const typed = value.replace(/\D/g, '');
    const kept = String(el.value || '').replace(/\D/g, '');
    if (!kept || kept.length >= typed.length || !typed.startsWith(kept)) return;
    // Emptied first: a mask reads a new value as an edit of the one it shows.
    typeValue(el, '');
    typeValue(el, typed.slice(-kept.length));
  }

  /** Focus and leave a control the way a person's pick does: forms that check a field on blur check it then. */
  function focusIn(el) {
    el.dispatchEvent(new FocusEvent('focus'));
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }));
  }
  function focusOut(el) {
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
        // A mask that takes the key on keypress puts the character in itself (and says so by cancelling it).
        const press = new KeyboardEvent('keypress', Object.assign({}, init, { charCode: ch.charCodeAt(0) }));
        el.dispatchEvent(press);
        if (!press.defaultPrevented && !doc.execCommand('insertText', false, ch)) {
          setNativeValue(el, el.value + ch);
          el.dispatchEvent(
            new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: ch }),
          );
        }
      }
      el.dispatchEvent(new KeyboardEvent('keyup', init));
    }
    if (el.value !== text && !textTook(el, text)) return typeValue(el, text);
    fire(el, 'change');
    el.blur();
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }));
  }

  /**
   * A paste event carrying `data` ({ 'text/plain': …, 'text/html': … }). Firefox ignores the standard
   * `clipboardData` and takes its own `dataType` and `data` instead (one type only): it gets the plain text that way.
   */
  function pasteEvent(data) {
    const transfer = new DataTransfer();
    for (const [type, value] of Object.entries(data)) transfer.setData(type, value);
    const init = { clipboardData: transfer, bubbles: true, cancelable: true, composed: true };
    const event = new ClipboardEvent('paste', init);
    if (event.clipboardData && event.clipboardData.getData('text/plain') === data['text/plain']) return event;
    return new ClipboardEvent('paste', Object.assign(init, { dataType: 'text/plain', data: data['text/plain'] }));
  }

  /** Paste `text` over what the box holds: masks and editors that ignore a set value often take a paste. */
  function pasteText(el, text) {
    const doc = el.ownerDocument;
    el.focus({ preventScroll: true });
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }));
    if (el.select) el.select();
    const paste = pasteEvent({ 'text/plain': text });
    el.dispatchEvent(paste);
    // Nobody took the paste: the browser would insert it.
    if (!paste.defaultPrevented && !doc.execCommand('insertText', false, text)) {
      setNativeValue(el, text);
      el.dispatchEvent(
        new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertFromPaste', data: text }),
      );
    }
    fire(el, 'change');
    el.blur();
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }));
  }

  /* ------------------------------------------------------ rich-text editors */

  const isEditable = (el) => el.isContentEditable && el.localName !== 'input' && el.localName !== 'textarea';
  /** What a box holds: an input's value, an editor's text. */
  const textIn = (el) => {
    const parts = partsValue(el);
    if (parts != null) return parts;
    return isEditable(el) ? el.innerText || el.textContent || '' : el.value || '';
  };

  function selectAllIn(el) {
    el.focus({ preventScroll: true });
    const doc = el.ownerDocument;
    const range = doc.createRange();
    range.selectNodeContents(el);
    const selection = doc.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    // Editors follow the selection on selectionchange, which the browser only sends later: send it now, so what
    // comes next replaces everything rather than going in where the cursor was.
    doc.dispatchEvent(new Event('selectionchange'));
  }

  const escapeHtml = (t) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  /** Paste into an editor, paragraphs as paragraphs: Quill, ProseMirror, Lexical and CKEditor all read a paste. */
  function pasteRich(el, text) {
    selectAllIn(el);
    const html = text
      .split(/\n/)
      .map((line) => `<p>${escapeHtml(line) || '<br>'}</p>`)
      .join('');
    const paste = pasteEvent({ 'text/plain': text, 'text/html': html });
    el.dispatchEvent(paste);
    // A plain contenteditable ignores a paste from script: type it in instead.
    if (!paste.defaultPrevented) insertRich(el, text);
    else el.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }));
  }

  /** Type into an editor the way the browser does, a paragraph at a time (each one an input the editor sees). */
  function insertRich(el, text) {
    const doc = el.ownerDocument;
    selectAllIn(el);
    if (textIn(el).trim()) {
      // Editors clear a selection on Backspace (Lexical ignores the delete command); a bare box on delete.
      const back = new KeyboardEvent('keydown', keyInit('Backspace'));
      el.dispatchEvent(back);
      if (!back.defaultPrevented) doc.execCommand('delete');
    }
    text.split(/\n/).forEach((line, i) => {
      if (i) doc.execCommand('insertParagraph');
      if (line) doc.execCommand('insertText', false, line);
    });
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }));
  }

  // Letters and digits only: what a mask's spaces, brackets and dashes don't change.
  const bare = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '');

  /**
   * Did the box take `want`? Exactly, or reshaped by a mask ("+1 415 555 0100" shown as "(415) 555-0100"), or cut
   * to the box's length. A box left empty, put back as it was, or holding only the first key or two did not.
   */
  function textTook(el, want, strict) {
    const have = textIn(el);
    if (have === want) return true;
    if (strict) {
      // Every digit, or all but a dialling code the widget moved into its own country picker; never just the first.
      const a = have.replace(/\D/g, '');
      const b = want.replace(/\D/g, '');
      return a === b || (a.length >= 7 && b.endsWith(a));
    }
    const a = bare(have);
    const b = bare(want);
    if (!a || !b) return !a && !b;
    if (a === b) return true;
    // An editor may tidy what it took (quotes, spaces): the same start and about the same length, never twice over.
    if (isEditable(el)) return Math.abs(a.length - b.length) <= 0.1 * b.length && a.slice(0, 40) === b.slice(0, 40);
    return a.length >= 0.6 * b.length && (b.includes(a) || a.includes(b));
  }

  /**
   * The ways to write text into a box, the cheapest first: the value set from script (React, Vue, Angular all see
   * it), then real key presses (spin buttons, masks that build the value key by key), then a paste.
   */
  function writeWays(el) {
    // A date in parts only takes keys, one part after the other.
    if (datePartsOf(el)) return [typeKeys];
    if (isEditable(el)) return [pasteRich, insertRich];
    return takesKeys(el) ? [typeKeys, typeValue, pasteText] : [typeValue, typeKeys, pasteText];
  }

  /**
   * Write `text` the first way the box keeps it; resolves to that way's index, or -1 when none did. An editor that
   * applies a paste a moment later (Lexical) is given that moment before the next way is tried on top of it.
   */
  async function writeText(el, text, from, strict) {
    const ways = writeWays(el);
    for (let i = from || 0; i < ways.length; i++) {
      await ways[i](el, text);
      if (textTook(el, text, strict)) return i;
      if (isEditable(el)) for (let waited = 0; waited < 200 && !textTook(el, text); waited += 25) await sleep(25);
      if (textTook(el, text, strict)) return i;
    }
    return -1;
  }

  /* ------------------------------------------------------- will it pass? */

  const PATTERN_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password']);

  /**
   * Would the box's own rules accept `s`: its pattern, length limits and type? (The browser compiles a pattern with
   * the v flag and ignores one that doesn't compile; so does this.)
   */
  function fits(el, s) {
    if (el.localName !== 'input' && el.localName !== 'textarea') return true;
    if (el.maxLength > 0 && s.length > el.maxLength) return false;
    if (el.minLength > 0 && s.length < el.minLength) return false;
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (type === 'email' && !/^[^\s@]+@[^\s@]+$/.test(s)) return false;
    if (type === 'url' && !/^[a-z][a-z\d+.-]*:\S+$/i.test(s)) return false;
    if (type === 'number' && !Number.isFinite(Number(s))) return false;
    const pattern = el.getAttribute('pattern');
    if (pattern && PATTERN_TYPES.has(type)) {
      try {
        if (!new RegExp(`^(?:${pattern})$`, 'v').test(s)) return false;
      } catch (err) {
        /* not a pattern the browser would use either */
      }
    }
    return true;
  }

  const ERROR_TEXT =
    /\b(invalid|not valid|valid (\w+ )*(number|email|date|address|url|link|format|value|phone|postcode|zip)|format|must|should|required|please (enter|provide|use|select|choose|fill)|incorrect|not allowed|too (short|long)|at least|no more than|only (digits|numbers|letters)|enter a|doesn t match|does not match)\b/;
  const ERROR_CLASS =
    /\b(error|invalid|danger|is-invalid|has-error|feedback|validation|warning)\b|--error|__error|-error\b/i;

  /**
   * What the page says is wrong with a box, if anything: its own validity (pattern, type, length), else the error
   * message it points to (aria-errormessage, aria-describedby) or shows beside it ("Please enter a valid phone
   * number"). A form that only says "Required" before it is filled has nothing to say about what was written.
   */
  function complaint(el) {
    if (!el || !el.isConnected) return '';
    const v = el.validity;
    if (v && !v.valid && !v.valueMissing) return el.validationMessage || 'not accepted';
    const said = [];
    for (const attr of ['aria-errormessage', 'aria-describedby']) {
      for (const id of (el.getAttribute(attr) || '').split(/\s+/).filter(Boolean)) {
        const ref = (el.getRootNode().getElementById && el.getRootNode().getElementById(id)) || null;
        if (ref && dom().isVisible(ref)) said.push(dom().textOf(ref));
      }
    }
    // Error text in the box's own row: up to where other fields start.
    for (let a = el.parentElement, i = 0; a && i < 4; a = a.parentElement, i++) {
      if (Array.from(a.querySelectorAll('input:not([type="hidden"]), select, textarea')).some((c) => c !== el)) break;
      for (const n of a.querySelectorAll('[role="alert"], [aria-live="assertive"], [class]')) {
        if (n.contains(el) || (n.getAttribute('role') !== 'alert' && !ERROR_CLASS.test(n.getAttribute('class'))))
          continue;
        if (n.querySelector('input, select, textarea') || !dom().isVisible(n)) continue;
        said.push(dom().textOf(n));
      }
    }
    const text = said.map((t) => JTF.util.cleanLabel(t, 160)).find((t) => ERROR_TEXT.test(JTF.util.normalize(t)));
    if (text) return text;
    return el.getAttribute('aria-invalid') === 'true' ? 'marked invalid' : '';
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
    // A value list's choice is what its hidden input holds ("United States (+1)" behind "+1").
    const vl = dom().valueList(el);
    if (vl && vl.hidden.value.trim()) return vl.hidden.value.trim();
    // What the button shows: the choice, not a placeholder kept for screen readers or hidden once chosen.
    return dom().visibleText(el) || '';
  }

  const CHIP =
    '[class*="singleValue"], [class*="single-value"], [class*="selected-value"], [class*="multiValue"], [class*="multi-value"], [class*="MuiChip-root"], [data-automation-id="selectedItem"]';
  // The tags of a dropdown that takes several (Ant Design's "selection-item") carry no role or ARIA state: their class
  // is the only sign of them. Its one-choice dropdowns (antd v4/v5) use the class for the choice, which another
  // pick replaces: not a chip to clear first.
  const TAG = '[class*="selection-item"]';

  /**
   * The selected values ("chips") of a react-select style widget, looking only inside its own
   * container. Hidden helper inputs (react-select's required-field shim) don't count as neighbours.
   */
  function chipsOf(el) {
    const selector = isMulti(el) ? `${CHIP}, ${TAG}` : CHIP;
    let a = el.parentElement;
    for (let i = 0; a && i < 5; i++, a = a.parentElement) {
      const others = Array.from(
        a.querySelectorAll('input:not([type="hidden"]), select, textarea, [role="combobox"]'),
      ).filter((c) => c !== el && !c.contains(el) && c.getAttribute('aria-hidden') !== 'true' && c.tabIndex >= 0);
      if (others.length) return [];
      const all = Array.from(a.querySelectorAll(selector));
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

  // Picks a fill made that show only as chips without any class or role to know them by (Downshift's multiple
  // selection): remembered per box, so a later look (the questions left for the AI, a second fill) still sees them.
  const keptPicks = new WeakMap();

  /** The remembered picks that still show beside `el`. */
  function keptChips(el) {
    const picks = keptPicks.get(el);
    if (!picks || !picks.length) return [];
    const box = boxText(el);
    return picks.filter((t) => box.includes(' ' + JTF.util.normalize(t) + ' '));
  }

  /**
   * What the hidden <select> behind a dropdown widget holds (see dom.standsFor), as option texts: the widget's true
   * value. Its placeholder ("Select an Option", shown in chosen's box as the box's own value) is no value.
   */
  function nativePicks(native) {
    return Array.from(native.selectedOptions)
      .filter((o) => o.value !== '' && !M().isPlaceholder(JTF.util.normalize(o.text)))
      .map((o) => o.text);
  }

  /**
   * What a dropdown whose input stays empty has chosen: the options its own list (aria-controls) marks
   * aria-selected and its box shows. Element Plus keeps that list in the page while closed, and shows the choice
   * (or a tag per choice) beside the input. Both must agree: a list can mark a row it merely highlights.
   */
  function shownChoices(el) {
    const ids = (el.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean);
    const rootNode = el.getRootNode();
    const out = [];
    let box = null;
    for (const id of ids) {
      const lb = (rootNode.getElementById && rootNode.getElementById(id)) || el.ownerDocument.getElementById(id);
      if (!lb || lb.contains(el)) continue;
      for (const o of lb.querySelectorAll('[role="option"][aria-selected="true"]')) {
        const t = dom().textOf(o);
        if (box == null) box = boxText(el);
        if (t && box.includes(JTF.util.normalize(t))) out.push(t);
      }
    }
    return out;
  }

  /**
   * An input mask showing nothing but its empty slots and fixed characters: "__/__/____" (an IMask or Inputmask date
   * that shows its shape before anything is typed), "(___) ___-____", "+44 ____ ______".
   */
  const isEmptyMask = (v) => v.includes('_') && /^[\s_()/.:-]*$/.test(v.replace(/^\+\d{1,4}/, ''));

  /**
   * The choice a dropdown shows as bare text beside its search input (Ant Design's "Italy"). Not a chip: picking
   * another option replaces it, no clear button needed.
   */
  function besideText(el) {
    const shown = dom().shownValue(el);
    return shown ? shown.text : '';
  }

  /** Does this control already hold something the user (or site) put there? */
  function hasValue(field) {
    const { el, kind, members } = field;
    const native = (kind === 'combo' || kind === 'combobox') && dom().standsFor(el);
    if (native) return nativePicks(native).length > 0;
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
        return (
          !!el.value.trim() ||
          chipsOf(el).length > 0 ||
          keptChips(el).length > 0 ||
          shownChoices(el).length > 0 ||
          !!besideText(el)
        );
      default: {
        const shown = partsValue(el);
        if (shown != null) return !!shown;
        // A bare scheme or a dial code the widget put there ("+33" in react-phone-number-input) is still empty, and
        // so is a mask's row of empty slots.
        const v = textIn(el).trim();
        return !!v && !/^https?:\/\/$/.test(v) && !/^\+\d{1,4}$/.test(v) && !isEmptyMask(v);
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
    const native = dom().standsFor(el);
    const chips = kind === 'combobox' && !el.value.trim() ? chipsOf(el).map((c) => dom().textOf(c)) : [];
    const shown = native
      ? nativePicks(native)
      : kind === 'combo'
        ? [comboText(el)]
        : el.value.trim()
          ? [el.value]
          : [...chips, ...shownChoices(el), besideText(el)].filter(Boolean);
    return shown.some((text) => text && M().matchOption([{ text, value: '' }], v) === 0);
  }

  /** Current value as text (for "learn from this page"). */
  function currentValue(field) {
    const { el, kind, members } = field;
    const native = (kind === 'combo' || kind === 'combobox') && dom().standsFor(el);
    if (native) return nativePicks(native).join(', ');
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
            .join(', ') ||
          [...new Set([...keptChips(el), ...shownChoices(el), besideText(el)].filter(Boolean))].join(', ')
        );
      default: {
        const shown = partsValue(el);
        if (shown != null) return shown;
        const v = textIn(el).trim();
        return isEmptyMask(v) ? '' : v;
      }
    }
  }

  /* ---------------------------------------------------- custom dropdowns */

  const OPEN_WAIT = 600;
  const SEARCH_WAIT = 2500;

  const LISTBOX_LIKE =
    '[role="listbox"], ul[class*="listbox" i], ul[class*="result" i], ul[class*="option" i], ul[class*="dropdown" i], ul[class*="suggest" i], ul[class*="autocomplete" i], [class*="listbox-results" i], [class*="listbox-drop" i], [class*="dropdown-menu" i], [class*="select-menu" i], [class*="cx-select" i][class*="list" i], [class*="select__menu" i]';

  /**
   * The row of chips a Workday prompt shows for what was picked ("Italy (+39)"), or any list of nothing but picked
   * rows (Choices shows its value as a listbox holding one selected option): a listbox, but nobody's menu.
   */
  function isChipList(lb) {
    if (
      lb.matches('[data-automation-id="selectedItemList"]') ||
      lb.querySelector('[data-automation-id="selectedItem"]')
    )
      return true;
    const rows = lb.querySelectorAll('[role="option"]');
    return rows.length > 0 && Array.from(rows).every((o) => o.getAttribute('aria-selected') === 'true');
  }

  /** A closed menu kept in place but clipped to nothing (chosen's "chosen-drop": clip-path inset(100%)). */
  function clippedAway(lb) {
    for (let a = lb.parentElement, i = 0; a && i < 4; a = a.parentElement, i++) {
      const style = a.ownerDocument.defaultView.getComputedStyle(a);
      if (style.clip === 'rect(0px, 0px, 0px, 0px)' || /^inset\((50|100)%/.test(style.clipPath)) return true;
    }
    return false;
  }

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

  /**
   * An open combobox whose listbox is a 0×0 box kept for screen readers (Ant Design's virtual lists name only the
   * highlighted row and its neighbours there): the rows people see are in the popup around it. A listbox that is
   * hidden (display: none) belongs to a closed menu.
   */
  function popupAround(lb, el) {
    if (!lb.checkVisibility || !lb.checkVisibility({ checkVisibilityCSS: true })) return null;
    for (let a = lb.parentElement, i = 0; a && i < 3 && a !== a.ownerDocument.body; a = a.parentElement, i++) {
      if (a.contains(el)) return null;
      if (dom().isVisible(a)) return a;
    }
    return null;
  }

  function listboxFor(el) {
    // A value list's rows show once its box is clicked (see dom.valueList).
    const vl = dom().valueList(el);
    if (vl) return dom().isVisible(vl.list) ? vl.list : null;
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
      const around = lb && el.getAttribute('aria-expanded') === 'true' ? popupAround(lb, el) : null;
      if (around) return around;
    }
    const comboLike =
      el.getAttribute('role') === 'combobox' ||
      el.hasAttribute('aria-haspopup') ||
      el.hasAttribute('aria-autocomplete') ||
      el.getAttribute('aria-expanded') === 'true' ||
      !!el.closest(
        '[role="combobox"], [class*="select" i], [class*="combobox" i], [class*="dropdown" i], [class*="listbox" i]',
      ) ||
      !!dom().standsFor(el);
    // A menu button's menu (BambooHR's role="menu" of role="menuitem" rows, appended to <body> when it opens).
    const selector = comboLike
      ? /^(true|menu)$/.test(el.getAttribute('aria-haspopup') || '')
        ? `${LISTBOX_LIKE}, [role="menu"]`
        : LISTBOX_LIKE
      : '[role="listbox"]';
    const all = Array.from(rootNode.querySelectorAll(selector));
    if (rootNode !== doc) all.push(...doc.querySelectorAll(selector));
    // A list inside another combobox is that one's (Choices keeps its value and its menu inside its own).
    const theirs = (lb) => {
      const owner = lb.closest('[role="combobox"]');
      return !!owner && !owner.contains(el) && !el.contains(owner);
    };
    const cands = all.filter(
      (lb) =>
        dom().isVisible(lb) &&
        !lb.closest('[data-jtf-ui]') &&
        !lb.contains(el) &&
        !isChipList(lb) &&
        !clippedAway(lb) &&
        !theirs(lb) &&
        !ownedElsewhere(lb, el),
    );
    // Nested matches (ul inside div.oj-listbox-drop): keep the outermost.
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
    // A row announced to screen readers is a message ("Please enter 2 or more characters" in select2), not a choice.
    const usable = (nodes) =>
      nodes.filter((o) => {
        const t = (dom().textOf(o) || o.getAttribute('aria-label') || '').trim();
        return t && !NO_RESULTS.test(t) && !o.matches('[role="alert"], [role="status"], [aria-live]');
      });
    for (const sel of [OPTION_ROLES, MENUITEM_ROLES]) {
      const found = Array.from(lb.querySelectorAll(sel));
      // Rows kept for screen readers only, none of them on screen (Ant Design's 0×0 role="listbox" naming the
      // highlighted row and its neighbours): the rows people see and click are the other ones, whatever they carry.
      if (found.length && !found.some((o) => dom().isVisible(o))) continue;
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

  /**
   * The rows of an open value list, every one: those in collapsed groups too ("How did you hear about us?" keeps
   * "LinkedIn" under "Social media"), as the list takes a click on any row. Shown rows first, one per value.
   */
  function valueRows(lb) {
    const rows = Array.from(lb.querySelectorAll('li')).filter((r) => dom().rowValue(r));
    const shown = rows.filter((r) => dom().isVisible(r));
    const values = new Set(shown.map((r) => dom().rowValue(r)));
    return [...shown, ...rows.filter((r) => !values.has(dom().rowValue(r)) && !r.classList.contains('hidden'))];
  }

  function currentOptions(el) {
    const lb = listboxFor(el);
    if (lb && dom().valueList(el)) return valueRows(lb);
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
    const own = el.localName === 'input' ? JTF.util.normalize(besideText(el)) : JTF.util.normalize(dom().textOf(el));
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

  /**
   * A role="menuitemcheckbox" / "menuitemradio" that is ticked, or an option a multi-select listbox has selected
   * (Headless UI's Listbox `multiple`: aria-selected there is the choice; clicking it again would take it away). A
   * row only styled as the highlight is not, whatever its aria-selected says.
   */
  const HIGHLIGHT_ROW = /\b(highlight(ed)?|focus(ed)?|hover(ed)?|active)\b|--(active|focused|highlighted)/i;
  function isTicked(option, el) {
    if (!option.isConnected) return false;
    if (option.getAttribute('aria-checked') === 'true') return true;
    // A value list that takes several marks what it took ("selected").
    const vl = el && dom().valueList(el);
    if (vl) return vl.multiple && /\bselected\b/.test(String(option.className || ''));
    // The <select> a widget stands in for knows what is picked (choices.js marks its highlighted row aria-selected).
    const native = el && dom().standsFor(el);
    if (native) {
      const text = JTF.util.normalize(dom().textOf(option));
      return nativePicks(native).some((t) => JTF.util.normalize(t) === text);
    }
    return (
      option.getAttribute('aria-selected') === 'true' &&
      !!option.closest('[role="listbox"][aria-multiselectable="true"]') &&
      !HIGHLIGHT_ROW.test(String(option.className || ''))
    );
  }

  /**
   * The text of a dropdown's own box (the largest wrapper holding no other field), its menu left out, padded with
   * spaces: where a pick shows as a chip or tag. Downshift's multiple-selection recipe draws plain <span>s before its
   * input; Element Plus shows the choice (or a tag per choice) beside an input that stays empty.
   */
  function boxText(el) {
    let box = el;
    for (let a = el.parentElement, i = 0; a && i < 5 && a !== el.ownerDocument.body; a = a.parentElement, i++) {
      const others = Array.from(a.querySelectorAll('input:not([type="hidden"]), select, textarea, [role="combobox"]'));
      const own = (c) => c === el || c.contains(el) || c.getAttribute('aria-hidden') === 'true' || c.tabIndex < 0;
      if (others.some((c) => !own(c))) break;
      box = a;
    }
    const lb = listboxFor(el);
    const menu = (n) => n === lb || n.matches('[role="listbox"], [role="option"]');
    return ' ' + JTF.util.normalize(dom().textOf(box, menu)) + ' ';
  }

  /** Does `text` show in the box (`after`) more often than it did (`before`): a new chip for it? */
  function chipAdded(before, after, text) {
    const want = ' ' + JTF.util.normalize(text) + ' ';
    const count = (s) => s.split(want).length - 1;
    return want.trim() !== '' && count(after) > count(before);
  }

  /**
   * Did the <select> behind a widget take the row `text`: that option, or, for a row that makes a new one ("Add
   * Machine Learning…" in Tom Select), a new option it names? `before`: what it held before the click.
   */
  function nativeTook(native, text, before) {
    const want = JTF.util.normalize(text);
    return nativePicks(native)
      .map((t) => JTF.util.normalize(t))
      .some((t) => t === want || (!!t && !before.includes(t) && want.includes(t)));
  }

  // Dropdowns seen keeping their menu open after a pick registered: they take several.
  const takesSeveral = new WeakSet();

  async function choose(el, option) {
    const text = dom().textOf(option);
    const want = JTF.util.normalize(text);
    const typed = el.localName === 'input' ? el.value : '';
    if (option.scrollIntoView) option.scrollIntoView({ block: 'nearest' });
    for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove']) {
      const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      option.dispatchEvent(new Ctor(type, { bubbles: true, composed: true }));
    }
    const before = currentOptions(el);
    const box = boxText(el);
    const native = dom().standsFor(el);
    const held = native ? nativePicks(native).map((t) => JTF.util.normalize(t)) : [];
    pointerClick(option);
    // Registered once the value shows, or the menu closes behind the click (slow re-renders included). A category
    // that opens its own options instead (Workday's "Social Media" > "LinkedIn") says so.
    for (let waited = 0; waited < 300; waited += 30) {
      await sleep(30);
      // The <select> a widget stands in for has the option: registered, whatever the widget shows (chosen's menu
      // stays in place, clipped, once closed).
      if (native && nativeTook(native, text, held)) return text;
      // A menu that stays open ticks the item itself (Teamtailor shows "a, b, c, +2" once there are more than three).
      if (selectionShows(el, text, typed) || !listboxFor(el) || isTicked(option, el)) return text;
      // A chip beside the box while the menu stays open for the next pick, the row gone from it: a multi-select
      // (`kept`), though its list never said so.
      if (chipAdded(box, boxText(el), text)) {
        keptPicks.set(el, [...(keptPicks.get(el) || []), text]);
        return { text, kept: true };
      }
      // Or the box shows the pick (a tag) while the menu stays open: Element Plus's multiple el-select, whose menu
      // doesn't say aria-multiselectable. A single choice's menu is closing by now; one still open takes several.
      if (want && !box.includes(want) && boxText(el).includes(want)) {
        for (let w = 0; w < 300 && listboxFor(el); w += 30) await sleep(30);
        if (listboxFor(el)) takesSeveral.add(el);
        return text;
      }
      const now = currentOptions(el);
      if (!option.isConnected && now.length && optionsKey(now) !== optionsKey(before)) return { drilled: true };
    }
    // Some widgets only take the keyboard: highlight the option, then press Enter.
    if (option.isConnected && el.localName === 'input') {
      await chooseByKeyboard(el, option);
      for (let waited = 0; waited < 150; waited += 30) {
        if ((native && nativeTook(native, text, held)) || selectionShows(el, text, typed) || !listboxFor(el))
          return text;
        await sleep(30);
      }
    }
    return null;
  }

  /**
   * The search box an open dropdown's menu has (select2's, Choices'): where opening it put the cursor, inside the
   * widget or in the menu beside its list (select2's is appended to <body> with it).
   */
  function menuSearchBox(el) {
    const box = dom().deepActiveElement(el.ownerDocument);
    if (!box || box === el || box.localName !== 'input' || !/^(text|search)$/.test(box.type)) return null;
    if (box.readOnly || !dom().isVisible(box)) return null;
    if (el.contains(box)) return box;
    const vl = dom().valueList(el);
    if (vl) return vl.root.contains(box) ? box : null;
    const lb = listboxFor(el);
    if (!lb) return null;
    if (lb.id && (box.getAttribute('aria-controls') || '').split(/\s+/).includes(lb.id)) return box;
    for (let a = lb.parentElement, i = 0; a && i < 4; a = a.parentElement, i++)
      if (a.contains(box)) return a.contains(el) ? null : box;
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
    // The menu goes on the widget's next render (Radix Select) or fades out (MUI): clicking its button before that
    // would open it again, and an open Radix Select leaves the rest of the page aria-hidden and unclickable.
    for (let waited = 0; waited < 150 && listboxFor(el); waited += 30) await sleep(30);
    // A value list hides its box while open and closes on a click anywhere else.
    if (dom().valueList(el) && listboxFor(el)) pointerClick(el.ownerDocument.body);
    if (!(await menuGone(el)) && el.localName !== 'input') pointerClick(el);
  }

  /**
   * A list that only has the rows in view in the page (Ant Design's virtual lists show ~10 of 60 countries): the
   * element that scrolls it, when the rows it holds span much less than it scrolls through.
   */
  function virtualScroller(lb, opts) {
    if (!lb || opts.length < 2) return null;
    for (let n = opts[0].parentElement; n && n !== lb.parentElement; n = n.parentElement) {
      if (n.scrollHeight <= n.clientHeight + 4) continue;
      const span = opts[opts.length - 1].getBoundingClientRect().bottom - opts[0].getBoundingClientRect().top;
      return span < n.scrollHeight * 0.7 ? n : null;
    }
    return null;
  }

  /** Scroll a virtual list down from the top a screenful at a time, until `visit(rows in view)` says stop. */
  async function scrollThrough(el, box, visit) {
    for (let i = 0, top = 0; i < 100; i++) {
      const before = optionsKey(currentOptions(el));
      const from = box.scrollTop;
      box.scrollTop = top;
      // The list draws the rows now in view once it hears the scroll.
      for (let waited = 0; waited < 200 && box.scrollTop !== from; waited += 20) {
        await sleep(20);
        if (optionsKey(currentOptions(el)) !== before) break;
      }
      if (visit(currentOptions(el))) return true;
      if (box.scrollTop + box.clientHeight >= box.scrollHeight - 2) return false;
      top = box.scrollTop + Math.max(20, Math.floor(box.clientHeight * 0.8));
    }
    return false;
  }

  /** Every row of a virtual list, top to bottom, as describeOptions gives them. */
  async function readVirtualList(el, box) {
    const seen = [];
    await scrollThrough(el, box, (rows) => {
      for (const d of describeOptions(rows)) if (!seen.some((s) => s.text === d.text)) seen.push(d);
      return false;
    });
    return seen;
  }

  /**
   * In a virtual list nothing can be typed into, the row for `v`: every row is read by scrolling through the list,
   * the best one judged among them all (never the best of the ten in view), then scrolled back into view.
   * Returns { opts, idx } with idx -1 when none fits.
   */
  async function findInVirtualList(el, box, v, already) {
    const pool = (await readVirtualList(el, box)).filter((s) => !already.includes(s.text));
    const want = M().matchOption(pool, v);
    let opts = [];
    let idx = -1;
    if (want >= 0)
      await scrollThrough(el, box, (rows) => {
        opts = rows;
        idx = describeOptions(rows).findIndex((d) => d.text === pool[want].text);
        return idx >= 0;
      });
    return { opts, idx };
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
    // The menu offered options when it opened, though a search may find none later.
    const offered = opts.length > 0;
    const multi = isMulti(el);
    // A dropdown button whose menu has a search box of its own (select2, Choices): typing goes there.
    const box = searchable ? el : menuSearchBox(el);
    const pick = () => {
      const listed = describeOptions(opts);
      // A multi-select takes every slot or statement that fits, one per call, judged with the ones it took already
      // (react-select hides those): "None of these dates work" is never added to them. One ticked already stays.
      const list =
        v.many && multi
          ? M().matchAll([...listed, ...already.map((t) => ({ text: t, value: '' }))], v)
          : [M().matchOption(listed, v)];
      const idx = list.find(
        (i) =>
          i >= 0 && i < opts.length && !already.includes(dom().textOf(opts[i])) && !(multi && isTicked(opts[i], el)),
      );
      return idx == null ? -1 : idx;
    };
    let idx = pick();
    const virtual = idx < 0 && !searchable && !v.many ? virtualScroller(listboxFor(el), opts) : null;
    if (virtual) ({ opts, idx } = await findInVirtualList(el, virtual, v, already));
    // Statements and slots are judged against the whole list as it opened: typing would only hide some.
    if (idx < 0 && box && !v.many) {
      const { full, narrow } = searchQueries(v);
      let sawAny = false;
      for (const query of narrow ? [...full, narrow] : full) {
        // A single word is a last resort: when the full spelling already listed options, they were all
        // judged above, and a vaguer query would only invite the wrong pick.
        if (query === narrow && sawAny) break;
        const before = optionsKey(opts);
        const shown = searchesOnEnter(el) ? listboxFor(el) : undefined;
        typeQuery(box, query);
        if (searchesOnEnter(el)) key(el, 'Enter');
        opts = await waitForOptions(el, SEARCH_WAIT, before, shown);
        if (opts.length) sawAny = true;
        idx = pick();
        if (idx >= 0) break;
        if (!opts.length && !listboxFor(el)) break; // no suggestions at all: not a dropdown
      }
    }
    if (idx < 0) return { chosen: null, opts, multi, offered };
    let chosen = await choose(el, opts[idx]);
    // A two-level list (Workday's "Social Media" > "LinkedIn"): the category opened its own options; pick from those.
    for (let depth = 0; chosen && chosen.drilled && depth < 2; depth++) {
      opts = currentOptions(el);
      idx = pick();
      chosen = idx >= 0 ? await choose(el, opts[idx]) : null;
    }
    // A multi-select that only showed itself by keeping its menu open beside the new chip, or after a pick.
    const kept = !!(chosen && chosen.kept);
    if (kept) chosen = chosen.text;
    return { chosen: chosen && chosen.drilled ? null : chosen, opts, multi: multi || kept || isMulti(el), offered };
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
      if (r.opts.length || r.offered || listboxFor(el)) sawOptions = true;
      if (r.chosen) chosen.push(r.chosen);
      else if (isInput) {
        clearQuery(el);
        // Emptied, a filtering menu lists every option again on its next render, the first one highlighted (Downshift
        // picks that one when the box loses focus): let it render, so it is closed below rather than blurred.
        await sleep(30);
      }
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
      // A virtual list has only the rows in view in the page: scroll through it for the rest.
      const box = virtualScroller(listboxFor(el), opts);
      const options = (box ? await readVirtualList(el, box) : describeOptions(opts))
        .map((o) => JTF.util.cleanLabel(o.text, 200))
        .filter((t) => t && !M().isPlaceholder(JTF.util.normalize(t)) && !/^no (options|results)/i.test(t));
      return { options: [...new Set(options)], multi };
    } finally {
      await closeMenu(el);
      if (isInput) el.blur();
    }
  }

  function isMulti(el) {
    if (takesSeveral.has(el)) return true;
    const vl = dom().valueList(el);
    if (vl) return vl.multiple;
    // The <select> a widget stands in for says so itself (chosen's and Tom Select's lists don't).
    const native = dom().standsFor(el);
    if (native) return native.multiple;
    const lb = listboxFor(el);
    if (lb && lb.getAttribute('aria-multiselectable') === 'true') return true;
    // A menu of ticks ("How did you hear about us?" on Teamtailor) takes several.
    if (lb && lb.querySelector('[role="menuitemcheckbox"]')) return true;
    if (el.getAttribute('aria-multiselectable') === 'true') return true;
    // Ant Design's mode="multiple" says so only in its class ("ant-select-multiple"): no aria-multiselectable.
    return !!el.closest(
      '[class*="is-multi" i], [class*="isMulti" i], [class*="--multi" i], [class*="select-multiple" i]',
    );
  }

  /* ------------------------------------------------------------ popups */

  const POPUP =
    '[role="listbox"], [role="dialog"], [role="grid"], .react-datepicker-popper, .flatpickr-calendar.open, .ui-datepicker, [class*="datepicker" i][class*="popper" i], [class*="DayPicker" i]';

  /**
   * The popups on the page: `shown` (visible), and `present` (laid out, however transparent). A picker fading in
   * starts at opacity 0 (jQuery UI's datepicker), so one that has just appeared counts as open; one that sits there
   * transparent while closed was already present before.
   */
  function openPopups(doc) {
    const all = Array.from(doc.querySelectorAll(POPUP)).filter((p) => !p.closest('[data-jtf-ui]'));
    return {
      shown: all.filter((p) => dom().isVisible(p)),
      present: all.filter((p) => dom().isVisible(p, { ignoreOpacity: true })),
    };
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
    const fresh = () => {
      const now = openPopups(doc);
      const opened = [
        ...now.present.filter((p) => !before.present.includes(p)),
        ...now.shown.filter((p) => !before.shown.includes(p)),
      ];
      return opened.filter((p) => !p.contains(el));
    };
    // Widgets open on focus synchronously: nothing new now means nothing to close (and no time lost per box).
    if (!fresh().length) return;
    // Escape or a click outside would also close a modal the form itself sits in: leave those alone.
    const modal = '[role="dialog"], [aria-modal="true"]';
    if (el.closest(modal) || before.present.some((p) => p.matches(modal))) return;
    const active = dom().deepActiveElement(doc);
    if (active && active !== el && active !== doc.body) key(active, 'Escape');
    key(el, 'Escape');
    await sleep(30);
    if (!fresh().length) return;
    for (const type of ['mousedown', 'mouseup', 'click'])
      doc.body.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: doc.defaultView }));
    await sleep(30);
  }

  /* ---------------------------------------------------------- calendars */

  // react-datepicker (Phenom, Ashby and many React forms): the box sits in .react-datepicker__input-container, its
  // calendar (.react-datepicker) opens beside it, and each month, year or day is a cell ("Choose March 2026").
  const CALENDAR_INPUT = '.react-datepicker__input-container';
  const CALENDAR = '.react-datepicker';
  const isCalendarBox = (el) => el.localName === 'input' && !!el.closest(CALENDAR_INPUT);
  const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

  /** The calendar a box opened: the one beside it (react-datepicker puts it next to the box), else a new one. */
  function calendarOf(el, before) {
    const wrapper = el.closest('.react-datepicker-wrapper') || el.closest(CALENDAR_INPUT);
    const beside = wrapper.parentElement && wrapper.parentElement.querySelector(CALENDAR);
    if (beside && dom().isVisible(beside, { ignoreOpacity: true })) return beside;
    const fresh = openPopups(el.ownerDocument).present.filter((p) => !before.present.includes(p));
    return fresh.map((p) => (p.matches(CALENDAR) ? p : p.querySelector(CALENDAR))).find(Boolean) || null;
  }

  /** The year and month a calendar shows: "month 2026-10" (its month's label), else "October 2026" (its title). */
  function shownPeriod(cal) {
    const month = cal.querySelector('.react-datepicker__month');
    const m = month && /(\d{4})-(\d{2})/.exec(month.getAttribute('aria-label') || '');
    if (m) return { year: +m[1], month: +m[2] };
    const title = cal.querySelector('.react-datepicker__current-month, .react-datepicker-year-header');
    const t = JTF.util.normalize(title ? title.textContent : '');
    const y = /\b(\d{4})\b/.exec(t);
    if (!y) return null;
    const name = MONTH_NAMES.findIndex((n) => new RegExp(`\\b${n}`).test(t));
    return { year: +y[1], month: name >= 0 ? name + 1 : 1 };
  }

  /** Set a calendar's own year or month <select> (Phenom's header, dropdownMode="select") the way a pick does. */
  function chooseIn(select, index) {
    if (index < 0 || select.selectedIndex === index) return;
    setNativeValue(select, select.options[index].value);
    fire(select, 'change');
  }

  /**
   * Bring `want` ({ year, month }) into view: through the header's year and month lists when it has them, else its
   * arrows, a month (a year, for a month picker) at a time, until the calendar shows it or stops moving.
   */
  async function showPeriod(el, before, want, step) {
    const cal = () => calendarOf(el, before);
    if (!cal()) return;
    for (const select of cal().querySelectorAll('select')) {
      const opts = Array.from(select.options, (o) => JTF.util.normalize(o.text));
      if (opts.length && opts.every((t) => /^\d{4}$/.test(t))) chooseIn(select, opts.indexOf(String(want.year)));
      else if (opts.length === 12 && opts.every((t, i) => t.startsWith(MONTH_NAMES[i])))
        chooseIn(select, want.month - 1);
    }
    await sleep(30);
    const target = step === 'year' ? want.year : want.year * 12 + want.month;
    for (let i = 0; i < 400; i++) {
      const shown = cal() && shownPeriod(cal());
      if (!shown) return;
      const at = step === 'year' ? shown.year : shown.year * 12 + shown.month;
      if (at === target) return;
      const back = at > target;
      const arrow = Array.from(cal().querySelectorAll('button')).find((b) =>
        back
          ? /navigation--previous/.test(b.className) || /^previous\b/i.test(b.getAttribute('aria-label') || '')
          : /navigation--next/.test(b.className) || /^next\b/i.test(b.getAttribute('aria-label') || ''),
      );
      if (!arrow || arrow.disabled) return;
      pointerClick(arrow);
      await sleep(i % 12 === 11 ? 20 : 0);
      const now = cal() && shownPeriod(cal());
      if (!now || (step === 'year' ? now.year : now.year * 12 + now.month) === at) return;
    }
  }

  const cellOff = (c) => c.getAttribute('aria-disabled') === 'true' || /--disabled\b/.test(c.className);

  /**
   * Pick a date in its calendar as a person does, for a box that takes no typing: Phenom's month boxes blur
   * themselves on focus and drop what is typed, so "03/2026" only goes in as 2026 in the header's year list, then
   * "Mar". True when the box then holds a date; false when the date can't be picked there (greyed out: a "To" before
   * its "From"), the calendar closed again.
   */
  async function pickInCalendar(el, v) {
    const d = v.date;
    if (!d || !d.year || !isCalendarBox(el)) return false;
    const before = openPopups(el.ownerDocument);
    // Already open from the writes before? react-datepicker opens on a click and never closes on one.
    pointerClick(el);
    await sleep(60);
    const cal = calendarOf(el, before);
    if (!cal) return false;
    const mode = cal.querySelector('.react-datepicker__month-text')
      ? 'month'
      : cal.querySelector('.react-datepicker__year-text')
        ? 'year'
        : 'day';
    const want = { year: d.year, month: d.month || v.typicalMonth || 1, day: d.day || 1 };
    await showPeriod(el, before, want, mode === 'day' ? 'month' : 'year');
    const now = calendarOf(el, before);
    let cell = null;
    if (now && mode === 'month') {
      const cells = Array.from(now.querySelectorAll('.react-datepicker__month-text'));
      cell =
        cells.find((c) => c.classList.contains(`react-datepicker__month-${want.month - 1}`)) ||
        (cells.length === 12 ? cells[want.month - 1] : null);
    } else if (now && mode === 'year') {
      cell = Array.from(now.querySelectorAll('.react-datepicker__year-text')).find(
        (c) => c.textContent.trim() === String(want.year),
      );
    } else if (now) {
      cell = Array.from(now.querySelectorAll('.react-datepicker__day')).find(
        (c) => !/--outside-month/.test(c.className) && +c.textContent.trim() === want.day,
      );
    }
    if (cell && !cellOff(cell)) {
      pointerClick(cell);
      await sleep(60);
    }
    await closePopups(el, before);
    return !!(cell && !cellOff(cell) && textIn(el));
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
  // Avature's "Upload Resume: From Device" (Bain): its hidden file box only counts once the button has opened it.
  const RESUME_METHOD = '.uploadResumeTriggerFile, a[data-registermethod="file"]';
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
      return /:_attachIcon$/.test(el.id) || UPLOAD_TRIGGER.test(triggerText(el)) || el.matches(RESUME_METHOD);
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
      // Avature's file box, apart from its button, that has your CV already (an earlier fill's).
      const made = el.matches(RESUME_METHOD) && doc.getElementById('resumeFile');
      if (made && made.files && made.files.length) continue;
      const own = JTF.util.cleanLabel(dom().textOf(el) || el.getAttribute('aria-label') || '', 120);
      let row = JTF.util.cleanLabel(dom().textOf(box), 300);
      if (own && row.startsWith(own)) row = row.slice(own.length).trim();
      else if (own) row = row.replace(own, ' ').trim();
      if (el.matches(RESUME_METHOD)) row = `Resume ${row}`.trim();
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
    // Avature names it beside the file box, away from its button.
    const near = trigger.el.matches(RESUME_METHOD) ? input.closest('fieldset') : null;
    const shows = () => {
      const text = JTF.util.normalize(
        trigger.box.isConnected ? `${trigger.box.textContent} ${near ? near.textContent : ''}` : page.body.textContent,
      );
      return (
        (!!name && text.includes(name)) ||
        /\b(uploaded|upload (complete|successful)|erfolgreich hochgeladen)\b/.test(text)
      );
    };
    for (let waited = 0; waited < 8000 && !shows(); waited += 200) await sleep(200);
    return { status: 'filled', confirmed: shows(), target: trigger.box };
  }

  /* ------------------------------------------------------------- dates */

  /**
   * The day and month order of a date box that shows no format, on a page whose language doesn't settle it ("en",
   * no region): "06/01/2027" reads either way, so the box is asked. The same date on the 13th, which reads only one
   * way, goes in the page's order; turned down (a message, aria-invalid, the box emptied) and taken the other way
   * round, the other order it is. A box that takes either keeps the page's order.
   */
  async function dateOrderAsked(el, v, desc, text) {
    const m = /^(\d{1,2})([/.-])(\d{1,2})\2\d{4}$/.exec(text);
    if (el.localName !== 'input' || !m || +m[1] > 12 || +m[3] > 12 || m[1] === m[3]) return text;
    const lang = String(desc.lang || '').toLowerCase();
    if (/[-_]/.test(lang) || (lang && !/^en\b/.test(lang))) return text;
    const s = desc.signals || {};
    if (/\b(dd|mm)\b/i.test([desc.placeholderRaw, s.label, s.describedby].join(' '))) return text;
    const inOrder = (value, order) => M().formatForText(value, Object.assign({}, desc, { lang: order }));
    const us = inOrder(v, 'en-US');
    const gb = inOrder(v, 'en-GB');
    if (us === gb || (text !== us && text !== gb)) return text;
    const [mine, other] = text === us ? ['en-US', 'en-GB'] : ['en-GB', 'en-US'];
    const thirteenth = Object.assign({}, v, { date: Object.assign({}, v.date, { day: 13 }) });
    const said = complaint(el);
    const refused = async (order) => {
      const probe = inOrder(thirteenth, order);
      typeValue(el, probe);
      await sleep(80);
      const now = complaint(el);
      return (!!now && now !== said) || !textTook(el, probe);
    };
    const answer = !(await refused(mine)) || (await refused(other)) ? text : inOrder(v, other);
    typeValue(el, '');
    return answer;
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
          // A list that takes several (<select multiple>) gets every one of your answers it offers.
          if (el.multiple && (v.kind === 'list' || v.many)) {
            const picks = M().matchAll(desc.options, v);
            if (!picks.length) return { status: 'nomatch' };
            history.push({ el, kind, prev: el.selectedIndex, prevMany: Array.from(el.options, (o) => o.selected) });
            focusIn(el);
            picks.forEach((i) => (el.options[i].selected = true));
            fire(el, 'input');
            fire(el, 'change');
            focusOut(el);
            return { status: 'filled', check: { idx: el.selectedIndex, picks } };
          }
          const idx = M().matchOption(desc.options, v);
          if (idx < 0) return { status: 'nomatch' };
          history.push({ el, kind, prev: el.selectedIndex });
          // Picked as a person does, focused and left: a form that checks on blur (Formik, react-hook-form's
          // "onBlur") then drops its "Select your degree".
          focusIn(el);
          el.selectedIndex = idx;
          fire(el, 'input');
          fire(el, 'change');
          focusOut(el);
          return { status: 'filled', check: { idx } };
        }
        case 'radio': {
          const idx = M().matchOption(desc.options, v);
          if (idx < 0) return { status: 'nomatch' };
          // Already your answer (a page that writes the checked attribute makes every choice look like its default).
          if (isChecked(members[idx])) return { status: 'skipped', reason: 'has value' };
          history.push({ el, kind, members, prev: members.map(isChecked) });
          setChecked(members[idx], true);
          return { status: 'filled', target: members[idx], check: { targets: [members[idx]] } };
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
          return { status: 'filled', target: members[picks[0]], check: { targets: picks.map((i) => members[i]) } };
        }
        case 'checkbox': {
          // One option of a checklist ("London" under "Which offices…?"), or a yes/no box.
          const tick = v.kind === 'list' || v.many ? M().matchAll(desc.options, v).length > 0 : v.canonical === 'yes';
          if (!tick) return { status: 'skipped', reason: 'not one of your answers' };
          history.push({ el, kind, prev: isChecked(el) });
          setChecked(el, true);
          return { status: 'filled', check: { targets: [el] } };
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
              // A single choice is replaced by the next pick: only a list that takes several must be emptied first.
              if (!clearPicked(el) && isMulti(el)) return { status: 'skipped', reason: 'has value' };
              await sleep(150);
              key(el, 'Escape'); // clearing can pop the menu open again
            }
            const res = await fillCombo(field, v);
            // A picked option is undone with the widget's clear button; typed text by typing back.
            if (res.status === 'filled' && kind === 'combobox')
              history.push(res.typed ? { el, kind, prev } : { el, kind, prev: '', picked: true });
            // Read back later only when it can be read now: a widget that never shows its pick isn't picked again.
            if (res.status === 'filled') res.check = { had: hasValue(field) };
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
          history.push({ el, kind, prev: textIn(el) });
          const before = openPopups(el.ownerDocument);
          const said = complaint(el);
          if (v.date && v.kind === 'date') text = await dateOrderAsked(el, v, desc, text);
          // The other ways to write it, for a box that turns this one down: those its own rules (pattern, length,
          // type) accept go first, so "+44 7700 900123" never meets a box that only takes digits.
          const variants = [
            text,
            ...M()
              .textVariants(v, desc)
              .filter((s) => s !== text),
          ].slice(0, 12);
          const ways = [...variants.filter((s) => fits(el, s)), ...variants.filter((s) => !fits(el, s))];
          // A phone number must keep every digit: a mask that cut "+1 415 555 0100" to "(141) 555-5010" didn't take it.
          const strict = v.kind === 'phone';
          let wrote = ways[0];
          let way = await writeText(el, wrote, 0, strict);
          // Not kept, or rejected at once by its rules (a pattern or type the attributes didn't show): the next way of
          // writing it ("415 555 0100" for a US mask), and the first back when none does.
          const rejected = () => !!el.validity && !el.validity.valid && !el.validity.valueMissing;
          for (let i = 1; i < Math.min(ways.length, 8) && (way < 0 || rejected()); i++)
            way = await writeText(el, (wrote = ways[i]), 0, strict);
          if ((way < 0 || rejected()) && wrote !== ways[0]) way = await writeText(el, (wrote = ways[0]), 0, strict);
          await closePopups(el, before);
          // A date box that takes no typing at all (Phenom's month boxes) gets its date from its calendar.
          if (way < 0 && v.date && isCalendarBox(el) && (await pickInCalendar(el, v)))
            return { status: 'filled', check: { text: textIn(el), ways: [textIn(el)], way, said, calendar: true } };
          return { status: 'filled', check: { text: wrote, ways, way, said, strict } };
        }
      }
    } catch (err) {
      return { status: 'error', reason: String((err && err.message) || err) };
    }
  }

  /* ------------------------------------------------------ check and repair */

  /**
   * Is what `apply` wrote (its result's `check`) still there, and does the page take it? { ok }, or { gone } (the
   * box was re-made: find it again), { lost } (empty again, or put back as it was), { refused: what the page says }.
   */
  function verify(field, check) {
    const { el, kind } = field;
    if (!el.isConnected) return { gone: true };
    switch (kind) {
      case 'select':
        if (check.picks) return check.picks.every((i) => el.options[i].selected) ? { ok: true } : { lost: true };
        return el.selectedIndex === check.idx ? { ok: true } : { lost: true };
      case 'radio':
      case 'checkbox':
      case 'checkboxes':
        if (check.targets.some((t) => !t.isConnected)) return { gone: true };
        return check.targets.every(isChecked) ? { ok: true } : { lost: true };
      case 'combo':
      case 'combobox':
        return !check.had || hasValue(field) ? { ok: true } : { lost: true };
      case 'file':
        return { ok: true };
      default: {
        if (!textTook(el, check.text, check.strict)) return { lost: true };
        const said = complaint(el);
        return said && said !== check.said ? { refused: said } : { ok: true };
      }
    }
  }

  /** Tick a box that a click didn't tick: its label, the space bar, then its checked state with events. */
  async function tickHarder(el) {
    const label = el.localName === 'input' && el.labels && el.labels[0];
    const tries = [
      () => label && pointerClick(label),
      () => key(el, ' '),
      () => {
        if (el.localName !== 'input') return;
        el.checked = true;
        fire(el, 'input');
        fire(el, 'change');
      },
    ];
    for (const attempt of tries) {
      if (isChecked(el)) return;
      attempt();
      await sleep(60);
    }
  }

  /**
   * Put right what `verify` finds wrong, once the page has had its say. A box emptied or put back gets the text
   * again, the other ways first (key by key, a paste: the page undid what was set from script); one whose rules or
   * messages turn it down gets the other ways of writing it ("07700 900123", "30/06/2027", "linkedin.com/in/ada")
   * until one is taken, else the first back. Returns verify's verdict afterwards, `fixed` when it took a repair.
   */
  async function repair(field, v, check, opts) {
    const { el, kind } = field;
    const first = verify(field, check);
    if (first.ok || first.gone) return first;
    if (kind === 'select') {
      if (check.picks) check.picks.forEach((i) => (el.options[i].selected = true));
      else el.selectedIndex = check.idx;
      fire(el, 'input');
      fire(el, 'change');
    } else if (kind === 'radio' || kind === 'checkbox' || kind === 'checkboxes') {
      for (const t of check.targets) if (!isChecked(t)) await tickHarder(t);
    } else if (kind === 'combo' || kind === 'combobox') {
      if (opts && opts.comboboxes) await fillCombo(field, v);
    } else if (check.calendar) {
      // Picked from its calendar, and the calendar is still the only way in.
      if (await pickInCalendar(el, v)) check.text = textIn(el);
    } else if (first.lost) {
      const before = openPopups(el.ownerDocument);
      const ways = writeWays(el);
      const order = ways.map((w, i) => i).filter((i) => i !== check.way);
      if (check.way >= 0) order.push(check.way);
      for (const i of order) {
        await ways[i](el, check.text);
        await sleep(120);
        if (verify(field, check).ok) break;
      }
      // A calendar or suggestion list the writing opened is closed again, as after the first fill.
      await closePopups(el, before);
    } else {
      const before = openPopups(el.ownerDocument);
      let fixed = false;
      for (const text of check.ways.slice(0, 8)) {
        if (text === check.text) continue;
        if ((await writeText(el, text, 0, check.strict)) < 0) continue;
        await sleep(150);
        const said = complaint(el);
        if (!said || said === check.said) {
          check.text = text;
          fixed = true;
          break;
        }
      }
      if (!fixed) await writeText(el, check.ways[0], 0, check.strict);
      await closePopups(el, before);
    }
    const now = verify(field, check);
    return now.ok ? { ok: true, fixed: true } : now;
  }

  /**
   * Undo a dropdown pick with the widget's own clear (×) button, or each chip's remove button.
   * Returns false when the widget offers no way to clear it.
   */
  function clearPicked(el) {
    let a = el.parentElement;
    for (let i = 0; a && i < 5; i++, a = a.parentElement) {
      const clear = a.querySelector(
        '[class*="clear-indicator"], [class*="clearIndicator"], [aria-label="Clear" i], [aria-label*="clear selection" i], [title="Clear" i], [title^="Remove all" i], [title*="clear selection" i]',
      );
      if (clear) {
        pointerClick(clear);
        return true;
      }
      const removes = a.querySelectorAll(
        '[class*="multi-value__remove"], [class*="multiValueRemove"], [aria-label^="Remove" i], [title^="Remove" i], [data-automation-id="DELETE_charm"]',
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
          if (h.prevMany) h.prevMany.forEach((on, i) => h.el.options[i] && (h.el.options[i].selected = on));
          else h.el.selectedIndex = h.prev;
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
        } else if (isEditable(h.el)) {
          insertRich(h.el, h.prev || '');
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

  /** Outline a filled field: solid purple, dashed orange for the AI's answers (`how`: true or 'ai'), red to check. */
  function highlight(el, how) {
    const target =
      el.type === 'radio' || el.type === 'checkbox'
        ? (el.labels && el.labels[0]) || el
        : el.type === 'file'
          ? el.parentElement || el
          : el;
    if (!target || !target.style) return;
    // A field to check takes the place of its fill outline.
    if (how === 'check') clearOne(target);
    if (highlighted.some((h) => h.target === target)) return;
    const ai = how === true || how === 'ai';
    highlighted.push({ target, outline: target.style.outline, offset: target.style.outlineOffset });
    target.style.outline = `2px ${ai ? 'dashed' : 'solid'} ${how === 'check' ? CHECK_HIGHLIGHT : ai ? AI_HIGHLIGHT : HIGHLIGHT}`;
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
    verify,
    repair,
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
