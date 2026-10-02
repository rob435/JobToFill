/*
 * JobToFill — page scanner. Finds fillable controls (including inside open
 * shadow roots), groups radio buttons / checkbox lists, and builds the plain
 * descriptor objects that lib/matcher.js classifies.
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});
  const U = JTF.util;

  // Choices built from ARIA widgets instead of <input>s: Radix/Headless UI radios, toggle-button
  // groups like Ashby's Yes/No, custom checkboxes and switches.
  const ARIA_CHOICE = '[role="radio"], [role="checkbox"], [role="switch"], button[aria-pressed]';
  const CONTROL_SELECTOR = `input, select, textarea, [role="combobox"], [aria-haspopup="listbox"], ${ARIA_CHOICE}`;
  const COUNTED_SELECTOR = `input:not([type="hidden"]), select, textarea, [role="combobox"], [aria-haspopup="listbox"], ${ARIA_CHOICE}`;
  const SKIP_INPUT_TYPES = new Set([
    'hidden',
    'submit',
    'button',
    'reset',
    'image',
    'range',
    'color',
    'search',
    'time',
    'week',
    'datetime-local',
  ]);
  const PASS_THROUGH_TYPES = new Set([
    'email',
    'tel',
    'url',
    'number',
    'date',
    'month',
    'password',
    'file',
    'checkbox',
    'radio',
  ]);
  const SKIP_TEXT_TAGS = new Set([
    'script',
    'style',
    'noscript',
    'template',
    'select',
    'option',
    'textarea',
    'input',
    'button',
    'svg',
  ]);
  const ATTR_HINTS = [
    'data-automation-id',
    'data-testid',
    'data-test',
    'data-qa',
    'data-field',
    'data-name',
    'formcontrolname',
    'ng-model',
    'data-cy',
  ];
  const PLACEHOLDERISH = /^(select|choose|please select|search|type to search|start typing|-+)\b/i;
  // A drop zone's instructions ("Click to upload or drag and drop here", "PDF, max 5MB") say nothing about
  // what the upload is for: the label is further out.
  const UPLOAD_WORDS = new Set(
    'click tap here to or and upload uploads attach browse choose select add drag drop your a an the files file document documents max maximum size mb kb limit up of pdf doc docx txt rtf odt accepted formats types supported only'.split(
      ' ',
    ),
  );
  const isUploadBoilerplate = (t) =>
    U.normalize(t)
      .split(' ')
      .every((w) => !w || UPLOAD_WORDS.has(w) || /^\d+$/.test(w));

  /* ------------------------------------------------------------ visibility */

  function isVisible(el, opts) {
    if (!el || !el.isConnected) return false;
    const checkOpacity = !(opts && opts.ignoreOpacity);
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity, checkVisibilityCSS: true }))
      return false;
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
        if (
          SKIP_TEXT_TAGS.has(n.localName) ||
          n.hidden ||
          n.getAttribute('aria-hidden') === 'true' ||
          (n.style && n.style.display === 'none') ||
          (skip && skip(n))
        )
          return NodeFilter.FILTER_REJECT;
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

  /** Hidden helper inputs (react-select's required shim, the checkbox behind ARIA buttons) aren't fields. */
  function isShim(c) {
    if (c.localName !== 'input') return false;
    if (c.getAttribute('aria-hidden') === 'true') return true;
    return c.tabIndex < 0 && !!c.parentElement && !!c.parentElement.querySelector(ARIA_CHOICE);
  }

  function foreignControls(container, members) {
    let n = 0;
    for (const c of container.querySelectorAll(COUNTED_SELECTOR)) {
      if (members.has(c) || isShim(c)) continue;
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
    let boilerplate = '';
    for (let depth = 0; depth < 6; depth++) {
      const parent = node.parentElement;
      if (!parent || parent === node.ownerDocument.body) break;
      if (foreignControls(parent, members) > 0) return previousText(node) || boilerplate;
      const t = textOf(parent, skip);
      if (t && !PLACEHOLDERISH.test(t)) {
        if (!isUploadBoilerplate(t)) return U.cleanLabel(t, 200);
        boilerplate = boilerplate || U.cleanLabel(t, 200);
      }
      node = parent;
    }
    return previousText(node) || boilerplate;
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
    const set = new Set(members);
    // A fieldset around just this group; one around a whole page section ("3. Questions") is not the question.
    const fieldset = first.closest('fieldset');
    if (fieldset && members.every((m) => fieldset.contains(m)) && foreignControls(fieldset, set) === 0) {
      const t = fieldsetTitle(fieldset);
      if (t) return U.cleanLabel(t);
    }
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

  /** A fieldset's question: its <legend>, or a leading label or heading that is not an option's label. */
  function fieldsetTitle(fieldset) {
    const legend = Array.from(fieldset.children).find((c) => c.localName === 'legend');
    if (legend) return textOf(legend);
    for (const c of fieldset.children) {
      if (c.matches(CONTROL_SELECTOR) || c.querySelector(CONTROL_SELECTOR)) break;
      if (/^(label|h[1-6]|p|div|span)$/.test(c.localName) && !(c.control && fieldset.contains(c.control))) {
        const t = textOf(c);
        if (t) return t;
      }
    }
    return '';
  }

  function optionLabel(el) {
    const own = el.localName === 'input' ? '' : textOf(el);
    // The visible <label for> ("Yes") over an aria-labelledby that repeats the question ("Do you have… yes").
    const visible = U.cleanLabel(
      labelsOf(el)
        .map((l) => textOf(l))
        .join(' '),
    );
    return visible || explicitLabel(el) || el.getAttribute('aria-label') || own || nextText(el) || el.value || '';
  }

  const optionValue = (el) =>
    el.localName === 'input'
      ? el.value
      : el.getAttribute('data-option') || el.getAttribute('data-value') || el.getAttribute('value') || '';

  function describedBy(el) {
    return (el.getAttribute('aria-describedby') || '')
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => {
        const ref = byId(el, id);
        return ref ? textOf(ref) : '';
      })
      .join(' ')
      .slice(0, 200);
  }

  /**
   * The legend of the small fieldset or ARIA group a control sits in: "Phone" around a
   * country picker and a number box, "Cover Letter" around an "Attach" button, or the
   * question above a lone "Acknowledge/Confirm" checkbox. Big sections don't count.
   */
  function groupLabel(el) {
    const group = el.closest('fieldset, [role="group"], [role="radiogroup"]');
    if (!group || group.querySelectorAll(COUNTED_SELECTOR).length > 4) return '';
    let t = '';
    if (group.localName === 'fieldset') t = fieldsetTitle(group);
    if (!t) t = explicitLabel(group) || group.getAttribute('aria-label') || '';
    return U.cleanLabel(t, 200);
  }

  /**
   * Jobvite only: each upload's "Select" button opens a popup (#attachmentDropdown) that is appended to
   * <body> in button order, and the file input inside is labelled just "File". The button says what the
   * upload is for ("Resume", "Cover Letter").
   */
  function jobviteUploadLabel(el) {
    const pop = el.closest('#attachmentDropdown');
    if (!pop || pop.parentElement !== el.ownerDocument.body) return '';
    const pops = Array.from(el.ownerDocument.querySelectorAll('body > #attachmentDropdown'));
    const buttons = Array.from(el.ownerDocument.querySelectorAll('button[jv-add-attachment]'));
    const button = pops.length === buttons.length ? buttons[pops.indexOf(pop)] : null;
    return button ? U.cleanLabel(button.getAttribute('attachment-label') || explicitLabel(button)) : '';
  }

  const HEADING = 'h2, h3, h4, h5, h6, legend, [role="heading"]';

  /**
   * The heading of the section a control sits in ("Secondary education", "A-levels"): the last heading before it
   * among the children of one of its ancestors. A box labelled just "Subject" or "Grade" under "A-levels" asks
   * about A-levels, not your degree.
   */
  function sectionHeading(el) {
    let node = el;
    for (let i = 0; i < 8; i++) {
      const parent = node.parentElement;
      if (!parent || parent === el.ownerDocument.body) break;
      let found = null;
      for (const c of parent.children) {
        if (c === node) break;
        if (c.matches(HEADING)) found = c;
        else if (!c.querySelector(CONTROL_SELECTOR)) found = c.querySelector(HEADING) || found;
      }
      const t = found ? U.cleanLabel(textOf(found), 120) : '';
      if (t) return t;
      node = parent;
    }
    return '';
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

  const isAriaChoice = (el) => el.localName !== 'input' && el.matches(ARIA_CHOICE);

  /** Toggle buttons only count as a choice when they come in a group: "Yes" "No". */
  function pressedGroup(el) {
    const parent = el.parentElement;
    // Bold / Italic in an editor toolbar are not an answer.
    if (!parent || el.closest('[role="toolbar"], [role="menubar"], [role="tablist"], [contenteditable]')) return [];
    const list = Array.from(parent.children).filter((c) => c.matches('button[aria-pressed]'));
    return list.length >= 2 && list.length <= 12 ? list : [];
  }

  function kindOf(el) {
    const tag = el.localName;
    if (isAriaChoice(el)) {
      // A wrapper around a real input is handled through the input.
      if (el.querySelector('input[type="radio"], input[type="checkbox"]')) return null;
      if (el.matches('button[aria-pressed]')) return pressedGroup(el).length ? 'radio' : null;
      return el.getAttribute('role') === 'radio' ? 'radio' : 'checkbox';
    }
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
      // The hidden input behind an ARIA widget (Radix, Ashby's Yes/No) is a shim: use the widget.
      if (!isAriaChoice(el) && isShim(el) && el.parentElement.querySelector(ARIA_CHOICE)) return false;
      return (
        isVisible(el, { ignoreOpacity: true }) || labelsOf(el).some((l) => isVisible(l)) || isVisible(el.parentElement)
      );
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

  function ariaMembers(el, kind) {
    let list;
    if (el.matches('button[aria-pressed]')) list = pressedGroup(el);
    else {
      const role = el.getAttribute('role');
      const group = el.closest(role === 'radio' ? '[role="radiogroup"]' : '[role="group"], fieldset');
      const scope = group || el.parentElement;
      list = scope ? Array.from(scope.querySelectorAll(`[role="${role}"]`)) : [el];
      if (!group && list.length > 12) list = [el];
    }
    return list.filter((m) => isUsable(m, kind));
  }

  /** Radios with no name (Gem's React forms): the group is the smallest wrapper holding several of them. */
  function namelessRadios(el) {
    let a = el.parentElement;
    for (let i = 0; a && i < 5; i++, a = a.parentElement) {
      const list = Array.from(a.querySelectorAll('input[type="radio"]:not([name])'));
      if (list.length > 1) return list.filter((m) => isUsable(m, 'radio'));
    }
    return [el];
  }

  /**
   * Checkboxes each named after their option (Ashby: name="LinkedIn", name="Glassdoor") inside one titled
   * <fieldset> are one checklist. Long labels are separate statements ("I agree…"), so those stay single;
   * one longish option ("Job Board (e.g., Indeed, Built In, AngelList, …)") doesn't make a list statements.
   */
  function fieldsetCheckboxes(el) {
    const fs = el.closest('fieldset');
    if (!fs || !fieldsetTitle(fs)) return null;
    const controls = Array.from(fs.querySelectorAll(COUNTED_SELECTOR)).filter((c) => !isShim(c));
    if (controls.length < 2 || !controls.every((c) => c.localName === 'input' && c.type === 'checkbox')) return null;
    const lengths = controls.map((c) => optionLabel(c).length);
    if (lengths.some((n) => n > 120) || lengths.filter((n) => n > 60).length * 2 >= lengths.length) return null;
    return controls.filter((m) => isUsable(m, 'checkbox'));
  }

  function groupMembers(el) {
    if (isAriaChoice(el)) return ariaMembers(el, el.matches('button[aria-pressed]') ? 'radio' : kindOf(el));
    if (el.type === 'radio' && !el.hasAttribute('name')) return namelessRadios(el);
    const scope = el.form || el.getRootNode();
    const type = el.type;
    const selector = `input[type="${type}"][name="${CSS.escape(el.name)}"]`;
    const named = Array.from(scope.querySelectorAll(selector)).filter(
      (m) => (m.form || null) === (el.form || null) && isUsable(m, type),
    );
    if (type === 'checkbox' && named.length <= 1) return fieldsetCheckboxes(el) || named;
    return named;
  }

  function describe(el, kind, members) {
    const s = {};
    const desc = {
      kind,
      inputType: el.localName === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : el.localName,
      autocomplete: (el.getAttribute('autocomplete') || '').toLowerCase(),
      maxLength: el.maxLength > 0 ? el.maxLength : 0,
      placeholderRaw: el.getAttribute('placeholder') || '',
      // The page's language and site, for formats it doesn't spell out (day or month first).
      lang: ((el.closest && el.closest('[lang]')) || document.documentElement).getAttribute('lang') || '',
      host: location.hostname,
      options: null,
      signals: s,
    };
    if (kind === 'radio' || kind === 'checkboxes') {
      s.question = groupQuestion(members);
      s.name = el.getAttribute('name') || '';
      desc.options = members.map((m) => ({ text: U.cleanLabel(optionLabel(m), 200), value: optionValue(m) }));
    } else {
      s.label = explicitLabel(el);
      s.aria = el.getAttribute('aria-label') || '';
      s.placeholder = el.getAttribute('placeholder') || '';
      s.name = el.getAttribute('name') || '';
      s.id = el.id || '';
      s.title = el.getAttribute('title') || '';
      if (kind === 'checkbox' && !s.label) s.label = nextText(el);
      if (!s.label && !s.aria) s.nearby = contextLabel(el, new Set([el]));
      const group = groupLabel(el) || (kind === 'file' ? jobviteUploadLabel(el) : '');
      if (group && U.normalize(group) !== U.normalize(s.label || s.aria)) {
        // For an upload or a lone checkbox the group's legend is the question; elsewhere it is context.
        if (kind === 'file' || kind === 'checkbox') s.question = group;
        else s.group = group;
      }
      if (kind === 'checkbox') {
        if (!s.label && isAriaChoice(el)) s.label = U.cleanLabel(textOf(el));
        desc.options = [{ text: s.label || s.aria || '', value: optionValue(el) }];
      }
      if (kind === 'select')
        desc.options = Array.from(el.options).map((o) => ({
          text: o.text,
          value: o.value,
          disabled: o.disabled,
          // <optgroup label="Asian or Asian British"><option>Other</option>: which "Other" this is.
          group: o.parentElement && o.parentElement.localName === 'optgroup' ? o.parentElement.label : '',
        }));
    }
    s.section = sectionHeading(el);
    s.attrs = ATTR_HINTS.map((a) => el.getAttribute(a))
      .filter(Boolean)
      .join(' ');
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
      if ((kind === 'radio' || kind === 'checkbox') && (el.name || isAriaChoice(el) || kind === 'radio')) {
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

  JTF.dom = { collect, describe, kindOf, isVisible, textOf, deepActiveElement };
})(typeof globalThis !== 'undefined' ? globalThis : this);
