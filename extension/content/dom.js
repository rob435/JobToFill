/*
 * JobToFill — page scanner. Finds fillable controls (including inside open
 * shadow roots), groups radio buttons / checkbox lists, and builds the plain
 * descriptor objects that lib/matcher.js classifies.
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});
  const U = JTF.util;

  const CONTROL_SELECTOR = 'input, select, textarea, [role="combobox"], [aria-haspopup="listbox"]';
  const COUNTED_SELECTOR = 'input:not([type="hidden"]), select, textarea, [role="combobox"], [aria-haspopup="listbox"]';
  const SKIP_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'range', 'color', 'search', 'time', 'week', 'datetime-local']);
  const PASS_THROUGH_TYPES = new Set(['email', 'tel', 'url', 'number', 'date', 'month', 'password', 'file', 'checkbox', 'radio']);
  const SKIP_TEXT_TAGS = new Set(['script', 'style', 'noscript', 'template', 'select', 'option', 'textarea', 'input', 'button', 'svg']);
  const ATTR_HINTS = ['data-automation-id', 'data-testid', 'data-test', 'data-qa', 'data-field', 'data-name', 'formcontrolname', 'ng-model', 'data-cy'];
  const PLACEHOLDERISH = /^(select|choose|please select|search|type to search|start typing|-+)\b/i;

  /* ------------------------------------------------------------ visibility */

  function isVisible(el, opts) {
    if (!el || !el.isConnected) return false;
    const checkOpacity = !(opts && opts.ignoreOpacity);
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity, checkVisibilityCSS: true })) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const win = el.ownerDocument.defaultView;
    // Parked far off-screen: a honeypot or a hidden harvesting field.
    if (rect.right + win.scrollX < 0 || rect.bottom + win.scrollY < 0) return false;
    const style = win.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (checkOpacity && parseFloat(style.opacity) === 0) return false;
    return true;
  }

  function labelsOf(el) {
    try {
      return el.labels ? Array.from(el.labels) : [];
    } catch (err) {
      return [];
    }
  }

  /* --------------------------------------------------------------- text */

  function textOf(node, skip) {
    if (!node) return '';
    if (node.nodeType === 3) return node.nodeValue.replace(/\s+/g, ' ').trim();
    const doc = node.ownerDocument || document;
    const walker = doc.createTreeWalker(node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === 3) return NodeFilter.FILTER_ACCEPT;
        if (SKIP_TEXT_TAGS.has(n.localName) || n.hidden || n.getAttribute('aria-hidden') === 'true' ||
          (n.style && n.style.display === 'none') || (skip && skip(n))) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_SKIP;
      },
    });
    let out = '';
    for (let t = walker.nextNode(); t; t = walker.nextNode()) out += t.nodeValue + ' ';
    return out.replace(/\s+/g, ' ').trim();
  }

  function byId(el, id) {
    const rootNode = el.getRootNode();
    return (rootNode.getElementById && rootNode.getElementById(id)) || el.ownerDocument.getElementById(id);
  }

  function explicitLabel(el) {
    const parts = [];
    for (const id of (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)) {
      const ref = byId(el, id);
      if (ref && ref !== el) parts.push(textOf(ref));
    }
    if (!parts.length) for (const l of labelsOf(el)) parts.push(textOf(l));
    return U.cleanLabel(parts.filter(Boolean).join(' '));
  }

  function nextText(el) {
    let sib = el.nextSibling;
    for (let i = 0; sib && i < 3; i++, sib = sib.nextSibling) {
      if (sib.nodeType === 3 && sib.nodeValue.trim()) return U.cleanLabel(sib.nodeValue);
      if (sib.nodeType === 1) {
        if (sib.matches(CONTROL_SELECTOR)) return '';
        const t = textOf(sib);
        if (t) return U.cleanLabel(t);
      }
    }
    return '';
  }

  function previousText(node) {
    let sib = node.previousSibling;
    for (let i = 0; sib && i < 4; i++, sib = sib.previousSibling) {
      if (sib.nodeType === 3) {
        const t = sib.nodeValue.trim();
        if (t) return U.cleanLabel(t, 200);
      } else if (sib.nodeType === 1) {
        if (sib.matches(CONTROL_SELECTOR) || sib.querySelector(CONTROL_SELECTOR)) return '';
        const t = textOf(sib);
        if (t) return U.cleanLabel(t, 200);
      }
    }
    return '';
  }

  function foreignControls(container, members) {
    let n = 0;
    for (const c of container.querySelectorAll(COUNTED_SELECTOR)) {
      if (members.has(c)) continue;
      if ([...members].some((m) => m.contains(c) || c.contains(m))) continue;
      n++;
    }
    return n;
  }

  /**
   * Label for a control without a proper <label>: walk up to the largest
   * ancestor that contains no other control and use its text, else the text
   * just before it. Labels belonging to `members` (radio options) are ignored.
   */
  function contextLabel(start, members) {
    const skip = (n) => members.has(n) || (n.localName === 'label' && n.control && members.has(n.control));
    let node = start;
    for (let depth = 0; depth < 6; depth++) {
      const parent = node.parentElement;
      if (!parent || parent === node.ownerDocument.body) break;
      if (foreignControls(parent, members) > 0) return previousText(node);
      const t = textOf(parent, skip);
      if (t && !PLACEHOLDERISH.test(t)) return U.cleanLabel(t, 200);
      node = parent;
    }
    return previousText(node);
  }

  function commonAncestor(nodes) {
    let a = nodes[0].parentElement;
    while (a && !nodes.every((n) => a.contains(n))) a = a.parentElement;
    return a;
  }

  function groupQuestion(members) {
    const first = members[0];
    const group = first.closest('[role="radiogroup"], [role="group"]');
    if (group && members.every((m) => group.contains(m))) {
      const l = explicitLabel(group) || group.getAttribute('aria-label');
      if (l) return U.cleanLabel(l);
    }
    const fieldset = first.closest('fieldset');
    if (fieldset && members.every((m) => fieldset.contains(m))) {
      const legend = fieldset.querySelector('legend');
      const t = legend && textOf(legend);
      if (t) return U.cleanLabel(t);
    }
    const set = new Set(members);
    const start = members.length > 1 ? commonAncestor(members) : first;
    if (!start) return '';
    const skip = (n) => set.has(n) || (n.localName === 'label' && n.control && set.has(n.control));
    if (members.length > 1 && foreignControls(start, set) === 0) {
      // Text inside the group container that is not an option label, e.g. a heading.
      const own = textOf(start, skip);
      const optionText = members.map(optionLabel).join(' ');
      if (own && U.normalize(own) !== U.normalize(optionText)) return U.cleanLabel(own, 200);
    }
    return contextLabel(start, set);
  }

  function optionLabel(el) {
    return explicitLabel(el) || el.getAttribute('aria-label') || nextText(el) || el.value || '';
  }

  function describedBy(el) {
    return (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean)
      .map((id) => { const ref = byId(el, id); return ref ? textOf(ref) : ''; })
      .join(' ').slice(0, 200);
  }

  function ancestorHints(el) {
    const out = [];
    let a = el.parentElement;
    for (let i = 0; a && i < 4; i++, a = a.parentElement) {
      for (const attr of ['data-automation-id', 'data-testid', 'data-qa', 'id']) {
        const v = a.getAttribute(attr);
        if (v && v.length < 80) out.push(v);
      }
    }
    return out.join(' ');
  }

  /* --------------------------------------------------------------- scan */

  function isComboInput(el) {
    const role = el.getAttribute('role');
    const ac = (el.getAttribute('aria-autocomplete') || '').toLowerCase();
    return role === 'combobox' || ac === 'list' || ac === 'both' || el.getAttribute('aria-haspopup') === 'listbox';
  }

  function kindOf(el) {
    const tag = el.localName;
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textarea';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (SKIP_INPUT_TYPES.has(type)) return null;
      if (PASS_THROUGH_TYPES.has(type)) return type;
      return isComboInput(el) ? 'combobox' : 'text';
    }
    if (el.isContentEditable) return null;
    // A custom dropdown (button / div). Wrappers around a real input are handled via the input.
    if (el.querySelector('input:not([type="hidden"]), select, textarea')) return null;
    return 'combo';
  }

  function isUsable(el, kind) {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    if (el.closest('fieldset[disabled]')) return false;
    if (el.closest('[data-jtf-ui]')) return false;
    if (kind === 'file') return true;
    if (kind === 'radio' || kind === 'checkbox') {
      return isVisible(el, { ignoreOpacity: true }) || labelsOf(el).some((l) => isVisible(l)) || isVisible(el.parentElement);
    }
    if (kind === 'combobox') return isVisible(el, { ignoreOpacity: true }) || isVisible(el.parentElement);
    if (el.readOnly) return false;
    if (el.closest('[aria-hidden="true"]')) return false;
    return isVisible(el);
  }

  function collectControls(rootNode, out) {
    const doc = rootNode.ownerDocument || rootNode;
    const walker = doc.createTreeWalker(rootNode, NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.matches(CONTROL_SELECTOR)) out.push(n);
      if (n.shadowRoot) collectControls(n.shadowRoot, out);
    }
    return out;
  }

  function groupMembers(el) {
    const scope = el.form || el.getRootNode();
    const type = el.type;
    const selector = `input[type="${type}"][name="${CSS.escape(el.name)}"]`;
    return Array.from(scope.querySelectorAll(selector)).filter((m) => (m.form || null) === (el.form || null) && isUsable(m, type));
  }

  function describe(el, kind, members) {
    const s = {};
    const desc = {
      kind,
      inputType: el.localName === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : el.localName,
      autocomplete: (el.getAttribute('autocomplete') || '').toLowerCase(),
      maxLength: el.maxLength > 0 ? el.maxLength : 0,
      placeholderRaw: el.getAttribute('placeholder') || '',
      options: null,
      signals: s,
    };
    if (kind === 'radio' || kind === 'checkboxes') {
      s.question = groupQuestion(members);
      s.name = el.getAttribute('name') || '';
      desc.options = members.map((m) => ({ text: optionLabel(m), value: m.value }));
    } else {
      s.label = explicitLabel(el);
      s.aria = el.getAttribute('aria-label') || '';
      s.placeholder = el.getAttribute('placeholder') || '';
      s.name = el.getAttribute('name') || '';
      s.id = el.id || '';
      s.title = el.getAttribute('title') || '';
      if (kind === 'checkbox' && !s.label) s.label = nextText(el);
      if (!s.label && !s.aria) s.nearby = contextLabel(el, new Set([el]));
      if (kind === 'select') desc.options = Array.from(el.options).map((o) => ({ text: o.text, value: o.value, disabled: o.disabled }));
    }
    s.attrs = ATTR_HINTS.map((a) => el.getAttribute(a)).filter(Boolean).join(' ');
    s.ancestors = ancestorHints(el);
    s.describedby = describedBy(el);
    return desc;
  }

  /** Scan a document: [{ el, kind, members, desc }] in document order. */
  function collect(doc) {
    const fields = [];
    const seen = new Set();
    for (const el of collectControls(doc || document, [])) {
      if (seen.has(el)) continue;
      const kind = kindOf(el);
      if (!kind || !isUsable(el, kind)) continue;
      if ((kind === 'radio' || kind === 'checkbox') && el.name) {
        const members = groupMembers(el);
        members.forEach((m) => seen.add(m));
        if (kind === 'radio' || members.length > 1) {
          const groupKind = kind === 'radio' ? 'radio' : 'checkboxes';
          const list = members.length ? members : [el];
          fields.push({ el: list[0], kind: groupKind, members: list, desc: describe(list[0], groupKind, list) });
          continue;
        }
      }
      seen.add(el);
      fields.push({ el, kind, members: [el], desc: describe(el, kind, [el]) });
    }
    return fields;
  }

  /** The element that really has focus, looking through shadow roots. */
  function deepActiveElement(doc) {
    let a = (doc || document).activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  JTF.dom = { collect, describe, kindOf, isVisible, textOf, explicitLabel, deepActiveElement, CONTROL_SELECTOR };
})(typeof globalThis !== 'undefined' ? globalThis : this);
