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
  // Rich-text editors (Quill, ProseMirror/TipTap, Lexical, CKEditor): the element that holds the contenteditable.
  const EDITOR = '[contenteditable]:not([contenteditable="false"])';
  // A date typed in parts that aren't inputs: MUI X's and React Aria's date fields show "MM" "DD" "YYYY" as
  // role="spinbutton" spans (contenteditable) in a role="group" that carries the question.
  const SEGMENT = '[role="spinbutton"]:not(input)';
  const CONTROL_SELECTOR = `input, select, textarea, [role="combobox"], [aria-haspopup="listbox"], ${ARIA_CHOICE}, ${SEGMENT}, ${EDITOR}`;
  const COUNTED_SELECTOR = `input:not([type="hidden"]), select, textarea, [role="combobox"], [aria-haspopup="listbox"], ${ARIA_CHOICE}, ${SEGMENT}, ${EDITOR}`;
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

  /** The root of a rich-text editor: editable itself, inside nothing editable (its paragraphs are not fields). */
  function isEditor(el) {
    if (!el.isContentEditable || el.getAttribute('contenteditable') === 'false') return false;
    if (!el.hasAttribute('contenteditable') || el.localName === 'body' || el.localName === 'html') return false;
    // The parts of a date typed in parts (MUI X's "MM" "DD" "YYYY") are editable too, but not editors.
    if (el.getAttribute('role') === 'spinbutton') return false;
    return !el.parentElement || !el.parentElement.isContentEditable;
  }

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
    // Clipped down to nothing: the "visually hidden" 1px <select> a dropdown widget keeps for the form (Tom Select).
    if (style.clip === 'rect(0px, 0px, 0px, 0px)' || /^inset\((50|100)%/.test(style.clipPath)) return false;
    return true;
  }

  /**
   * The native <select> a custom dropdown keeps for the form while showing itself in its place (select2, chosen,
   * Choices, Tom Select): hidden, right before the widget or inside it. It holds what the widget's value really is.
   */
  function isStandIn(c) {
    if (c.localName !== 'select' || (c.getAttribute('aria-hidden') !== 'true' && isVisible(c))) return false;
    const next = c.nextElementSibling;
    return (
      !!(c.parentElement && c.parentElement.closest('[role="combobox"]')) ||
      (!!next && !next.matches(CONTROL_SELECTOR) && !!next.querySelector(CONTROL_SELECTOR))
    );
  }

  /** The hidden native <select> the widget `el` belongs to stands in for (see isStandIn), if any. */
  function standsFor(el) {
    if (!el || el.localName === 'select') return null;
    const body = el.ownerDocument.body;
    for (let node = el, depth = 0; node && node !== body && depth < 6; node = node.parentElement, depth++) {
      // Climbed out of the widget: its container holds other fields.
      if (depth > 0) {
        const others = Array.from(node.querySelectorAll(COUNTED_SELECTOR)).some(
          (c) => c !== el && !el.contains(c) && !c.contains(el) && !isStandIn(c) && isVisible(c),
        );
        if (others) return null;
      }
      const inner = Array.from(node.querySelectorAll('select')).find(isStandIn);
      if (inner) return inner;
      // The widget comes right after the <select> it replaces (a bare box after one is just the next field).
      const prev = node.previousElementSibling;
      if (prev && (depth > 0 || el.getAttribute('role') === 'combobox') && isStandIn(prev)) return prev;
    }
    return null;
  }

  function labelsOf(el) {
    try {
      return el.labels ? Array.from(el.labels) : [];
    } catch (err) {
      return [];
    }
  }

  /* --------------------------------------------------------------- text */

  // A screen-reader-only "Required" after a label ("University:*Required" on Teamtailor) is not part of the question.
  const SR_ONLY = /\b(sr-only|visually-hidden|visuallyhidden|screen-reader-text|a11y-hidden)\b/;
  const isRequiredMarker = (n) =>
    SR_ONLY.test(n.getAttribute('class') || '') &&
    !n.firstElementChild &&
    /^\(?\s*(required|optional)\s*\)?[.:]?$/i.test(n.textContent.trim());

  function textOf(node, skip) {
    if (!node) return '';
    if (node.nodeType === 3) return node.nodeValue.replace(/\s+/g, ' ').trim();
    const doc = node.ownerDocument || document;
    const walker = doc.createTreeWalker(node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === 3) return NodeFilter.FILTER_ACCEPT;
        if (
          SKIP_TEXT_TAGS.has(n.localName) ||
          // What is written in an editor is an answer, not part of anyone's label.
          isEditor(n) ||
          n.hidden ||
          n.getAttribute('aria-hidden') === 'true' ||
          (n.style && n.style.display === 'none') ||
          isRequiredMarker(n) ||
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

  /**
   * The text a person sees: not what CSS hides ("Select an option" once a dropdown shows its choice) or keeps for
   * screen readers only (a 1px clipped "Select an option").
   */
  function visibleText(node) {
    const win = node.ownerDocument.defaultView;
    return textOf(node, (n) => {
      const style = win.getComputedStyle(n);
      if (style.display === 'none' || style.visibility === 'hidden') return true;
      const rect = n.getBoundingClientRect();
      return rect.width <= 1 && rect.height <= 1 && style.overflow === 'hidden';
    });
  }

  function byId(el, id) {
    const rootNode = el.getRootNode();
    return (rootNode.getElementById && rootNode.getElementById(id)) || el.ownerDocument.getElementById(id);
  }

  /** `outside`: only what lies outside the control: select2's combobox is "labelled" by its own selection ("Italy"). */
  function explicitLabel(el, outside) {
    const parts = [];
    for (const id of (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)) {
      const ref = byId(el, id);
      if (ref && ref !== el && !(outside && el.contains(ref))) parts.push(textOf(ref));
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
    // The hidden <select> behind a dropdown widget is the widget's, not a field beside it.
    if (c.localName === 'select') return isStandIn(c);
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

  /**
   * The instructions right under the heading of a section a control sits in: the text between that heading and the
   * section's first field ("If your school/university uses a GPA system, enter your GPA on a 0- 4.0 scale. Otherwise,
   * provide your overall result…" under Workday's "Education", above every entry). The nearest section that has any.
   */
  function sectionHelp(el) {
    let node = el;
    for (let i = 0; i < 8; i++) {
      const parent = node.parentElement;
      if (!parent || parent === el.ownerDocument.body) break;
      let parts = null; // the text after the last heading before `node`
      let open = false; // until a field or a field's label comes
      for (const c of parent.children) {
        if (c === node) break;
        const field = c.matches(CONTROL_SELECTOR) || !!c.querySelector(CONTROL_SELECTOR);
        const heading = c.matches(HEADING) ? c : field ? null : Array.from(c.querySelectorAll(HEADING)).pop();
        if (heading) {
          // A header block can hold the instructions after its heading.
          const all = textOf(c);
          const head = textOf(heading);
          parts = [head && all.includes(head) ? all.slice(all.lastIndexOf(head) + head.length) : ''];
          open = true;
        } else if (field || c.matches('label') || c.querySelector('label')) open = false;
        else if (open) parts.push(textOf(c));
      }
      const t = parts ? U.cleanLabel(parts.join(' '), 400) : '';
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
    return (
      role === 'combobox' ||
      ac === 'list' ||
      ac === 'both' ||
      el.getAttribute('aria-haspopup') === 'listbox' ||
      // Workday's search prompts ("School or University", "Country / Territory Phone Code"): a bare input whose
      // text is wiped unless a suggestion is picked.
      el.getAttribute('data-uxi-widget-type') === 'selectinput'
    );
  }

  const isAriaChoice = (el) => el.localName !== 'input' && el.matches(ARIA_CHOICE);

  // A date part's accessible name: "Month" (MUI X), "month" (React Aria), and a few languages' words for them.
  const PART_NAMES = [
    ['day', /\b(day|jour|tag|dia|giorno|dag|dzien)\b/],
    ['month', /\b(month|mois|monat|mes|mese|maand|miesiac)\b/],
    ['year', /\b(year|annee|jahr|ano|anno|jaar|rok)\b/],
  ];
  const NOT_A_DATE_PART = /\b(hours?|minutes?|seconds?|meridiem|am pm|week ?day|weekday)\b/;

  /** Which part of a date a role="spinbutton" holds: what it is called ("Month"), else its range (1–31, 1–12, 0–9999). */
  function dateUnit(el) {
    const name = U.normalize(el.getAttribute('aria-label') || '');
    const named = PART_NAMES.find(([, re]) => re.test(name));
    if (named) return named[0];
    if (NOT_A_DATE_PART.test(name)) return null;
    const max = parseInt(el.getAttribute('aria-valuemax'), 10);
    if (max >= 28 && max <= 31) return 'day';
    if (max === 12) return 'month';
    return max >= 1000 || max === 99 ? 'year' : null;
  }

  /** How a date in parts is written, in the order the parts come: "dd/mm/yyyy" for a DD/MM/YYYY field. */
  function partsFormat({ parts, units }) {
    const two = (el) => parseInt(el.getAttribute('aria-valuemax'), 10) === 99;
    return units.map((u, i) => (u === 'year' ? (two(parts[i]) ? 'yy' : 'yyyy') : u === 'day' ? 'dd' : 'mm')).join('/');
  }

  /**
   * A date typed in parts that aren't inputs (see SEGMENT): { box, parts, units } for one of its parts or the element
   * around them, `box` being its role="group" (which the question labels) or else the smallest element holding the
   * parts. Null for a time, a counter, or a range of two dates.
   */
  function dateSegments(el) {
    const first = el.matches(SEGMENT) ? el : el.querySelector(SEGMENT);
    if (!first) return null;
    let box = first.parentElement;
    for (let i = 0; box && i < 4 && box.querySelectorAll(SEGMENT).length < 2; i++) box = box.parentElement;
    if (!box) return null;
    const parts = Array.from(box.querySelectorAll(SEGMENT));
    const units = parts.map(dateUnit);
    if (parts.length < 2 || parts.length > 3 || units.some((u) => !u) || new Set(units).size < units.length)
      return null;
    // The group around just this date (its "Choose date" button and hidden value input aside) is what is labelled.
    const group = box.closest('[role="group"]');
    if (
      group &&
      group.querySelectorAll(SEGMENT).length === parts.length &&
      foreignControls(group, new Set(parts)) === 0
    )
      box = group;
    return { box, parts, units };
  }

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
    // One date in parts: the scan makes one field of all its parts (collect).
    if (el.matches(SEGMENT)) return dateSegments(el) ? 'date' : null;
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
      // A search box inside a combobox (ARIA 1.1's pattern: select2's and Choices' multi-selects) is the box that
      // dropdown is typed into, not a site search.
      if (type === 'search' && el.parentElement && el.parentElement.closest('[role="combobox"]')) return 'combobox';
      if (SKIP_INPUT_TYPES.has(type)) return null;
      if (PASS_THROUGH_TYPES.has(type)) return type;
      // chosen's box, which only searches the options of the <select> it stands in for, is a dropdown too.
      return isComboInput(el) || standsFor(el) ? 'combobox' : 'text';
    }
    // A rich-text editor is a text area (a cover letter, "Why do you want to join us?").
    if (el.isContentEditable) return isEditor(el) ? 'textarea' : null;
    // A custom dropdown (button / div). Wrappers around a real input are handled via the input; not the hidden
    // <select> a widget keeps for the form, nor the search box of its closed menu (Choices).
    const inner = el.querySelectorAll('input:not([type="hidden"]), select, textarea');
    if (Array.from(inner).some((c) => !isStandIn(c) && isVisible(c, { ignoreOpacity: true }))) return null;
    return 'combo';
  }

  function isUsable(el, kind) {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    if (el.closest('fieldset[disabled]')) return false;
    if (el.closest('[data-jtf-ui]')) return false;
    // A CAPTCHA (its "I'm not a robot" box, an image CAPTCHA's answer) is never filled.
    if (JTF.flow && JTF.flow.inCaptcha(el)) return false;
    if (kind === 'file') return true;
    if (kind === 'radio' || kind === 'checkbox') {
      // The hidden input behind an ARIA widget (Radix, Ashby's Yes/No) is a shim: use the widget.
      if (!isAriaChoice(el) && isShim(el) && el.parentElement.querySelector(ARIA_CHOICE)) return false;
      return (
        isVisible(el, { ignoreOpacity: true }) || labelsOf(el).some((l) => isVisible(l)) || isVisible(el.parentElement)
      );
    }
    if (kind === 'combobox') return isVisible(el, { ignoreOpacity: true }) || isVisible(el.parentElement);
    // An empty MUI X date keeps its "MM/DD/YYYY" see-through under the label until the field has focus.
    if (el.matches(SEGMENT)) return !el.closest('[aria-hidden="true"]') && isVisible(el, { ignoreOpacity: true });
    if (el.readOnly) return false;
    if (el.closest('[aria-hidden="true"]')) return false;
    return isVisible(el);
  }

  /**
   * A form's dropdown built as a menu button: "Select an option" opening role="menuitemradio" / "menuitemcheckbox"
   * choices (Teamtailor's University and Degree Classification questions, whose real radios are hidden). A site's
   * navigation or account menu is not one.
   */
  function isChoiceMenu(el) {
    if (el.getAttribute('aria-haspopup') !== 'menu' || !el.closest('form, fieldset')) return false;
    const ids = (el.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean);
    const menu = ids.map((id) => byId(el, id)).find(Boolean) || el.nextElementSibling;
    return (
      !!menu &&
      menu.matches('[role="menu"]') &&
      !!menu.querySelector('[role="menuitemradio"], [role="menuitemcheckbox"]')
    );
  }

  function collectControls(rootNode, out) {
    const doc = rootNode.ownerDocument || rootNode;
    const walker = doc.createTreeWalker(rootNode, NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.matches(CONTROL_SELECTOR) || isChoiceMenu(n)) out.push(n);
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
    const editor = isEditor(el);
    const desc = {
      kind,
      inputType:
        el.localName === 'input'
          ? (el.getAttribute('type') || 'text').toLowerCase()
          : editor
            ? 'textarea'
            : el.localName,
      autocomplete: (el.getAttribute('autocomplete') || '').toLowerCase(),
      maxLength: el.maxLength > 0 ? el.maxLength : 0,
      // Editors keep theirs in aria-placeholder or data-placeholder ("Tell us why you'd like to join").
      placeholderRaw:
        el.getAttribute('placeholder') ||
        (editor ? el.getAttribute('aria-placeholder') || el.getAttribute('data-placeholder') || '' : ''),
      // The page's language and site, for formats it doesn't spell out (day or month first).
      lang: ((el.closest && el.closest('[lang]')) || document.documentElement).getAttribute('lang') || '',
      host: location.hostname,
      options: null,
      signals: s,
    };
    // A date in parts takes them in its own order, whatever the page's language: its format stands in for a placeholder.
    const parts = kind === 'date' && el.localName !== 'input' ? dateSegments(el) : null;
    if (parts) desc.placeholderRaw = partsFormat(parts);
    if (kind === 'radio' || kind === 'checkboxes') {
      s.question = groupQuestion(members);
      s.name = el.getAttribute('name') || '';
      desc.options = members.map((m) => ({ text: U.cleanLabel(optionLabel(m), 200), value: optionValue(m) }));
    } else {
      const combo = kind === 'combo' || kind === 'combobox';
      const native = combo ? standsFor(el) : null;
      // A dropdown widget is labelled by the <label> of the <select> it stands in for (select2, chosen, Choices).
      s.label = explicitLabel(el, combo) || (native ? explicitLabel(native) : '');
      s.aria = el.getAttribute('aria-label') || '';
      s.placeholder = desc.placeholderRaw;
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
      // A dropdown widget offers the options of the <select> it stands in for (read without opening it), and takes
      // several when that one does.
      const list = kind === 'select' ? el : native && native.options.length ? native : null;
      if (kind === 'select' || native) desc.multiple = !!(native || el).multiple;
      if (list)
        desc.options = Array.from(list.options).map((o) => ({
          text: o.text,
          value: o.value,
          disabled: o.disabled,
          // <optgroup label="Asian or Asian British"><option>Other</option>: which "Other" this is.
          group: o.parentElement && o.parentElement.localName === 'optgroup' ? o.parentElement.label : '',
        }));
    }
    s.section = sectionHeading(el);
    s.sectionHelp = sectionHelp(el);
    // An upload that takes several files ("Resume/CV/Transcripts" on Workday) can take the letter and transcript too.
    if (kind === 'file') desc.multiple = !!el.multiple;
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
      if (el.matches(SEGMENT)) {
        // A date in parts is one field: the element around them, labelled by the question ("Graduation date").
        const { box, parts } = dateSegments(el);
        parts.forEach((m) => seen.add(m));
        if (parts.every((m) => m.getAttribute('aria-readonly') !== 'true'))
          fields.push({ el: box, kind, members: parts, desc: describe(box, kind, parts) });
        continue;
      }
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

  JTF.dom = {
    collect,
    describe,
    kindOf,
    isEditor,
    isVisible,
    textOf,
    visibleText,
    deepActiveElement,
    standsFor,
    dateSegments,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
