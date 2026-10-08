/*
 * JobToFill — the page map of one frame (lib/pagemap.js merges the frames' maps and writes them out as text): what a
 * person sees here, in reading order and through open shadow roots. Landmarks, headings and text; every field the
 * fill scans (one entry per JTF.dom.collect() field, in its order) with its question, options, state, what the rules
 * take it for and what the last fill did; the buttons that act on the form; and the frames. Injected only when a map
 * is asked for, never with a fill, and it only reads the page: no clicks, focus, scrolling or menus opened. marks()
 * draws the refs on the page for a screenshot.
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});
  const PM = (JTF.pagemap = JTF.pagemap || {});
  // Injected again for another map: only make sure the in-page API (main.js) has it.
  if (PM.capture) {
    PM.register();
    return;
  }
  const U = JTF.util;
  const dom = () => JTF.dom;
  const snap = () => JTF.snapshot;

  // What a hostile or huge page may cost: elements visited, text blocks kept, characters per block, options kept per
  // field, alerts, and milliseconds for the walk.
  const LIMITS = { elements: 20000, texts: 300, text: 240, options: 500, alerts: 20, ms: 2500 };
  const VALUE_MODES = new Set(['state', 'redacted', 'full']);

  // Never read: what doesn't show as text (scripts, styles, templates, SVG, media) and a list's options.
  // prettier-ignore
  const NEVER = new Set([
    'script', 'style', 'noscript', 'template', 'svg', 'math', 'head', 'meta', 'link', 'title', 'base', 'option',
    'optgroup', 'datalist', 'img', 'picture', 'video', 'audio', 'canvas', 'object', 'embed', 'source', 'track',
    'map', 'area', 'br', 'wbr', 'hr', 'col', 'colgroup',
  ]);
  // Controls: what is inside them is their value, never page text.
  const CONTROLS = new Set(['input', 'select', 'textarea']);
  const BUTTON_INPUTS = new Set(['submit', 'button', 'reset', 'image']);
  // Landmarks by role, as the tag each stands for.
  // prettier-ignore
  const ROLES = {
    banner: 'header', navigation: 'nav', main: 'main', complementary: 'aside', contentinfo: 'footer', form: 'form',
    region: 'section', search: 'search', dialog: 'dialog', alertdialog: 'alertdialog',
  };
  const LANDMARK_TAGS = new Set(['header', 'nav', 'main', 'aside', 'footer', 'form', 'section', 'search', 'dialog']);
  // A header or footer inside an article or a section is that part's, not the page's.
  const SCOPED = 'article, aside, main, nav, section, [role="article"], [role="main"], [role="region"]';
  // Messages the page shows by itself: alerts, live status lines, error summaries.
  const ALERT =
    '[role="alert"], [role="status"], [aria-live="assertive"], .error-summary, [class*="error-summary" i], [class*="errorSummary"], .alert-danger, .alert-error, .alert-warning, [data-automation-id="errorMessage"]';
  // A field's own error message (as content/fill.js reads one after a fill), and where pages put it.
  const ERROR_TEXT =
    /\b(invalid|not valid|valid (\w+ )*(number|email|date|address|url|link|format|value|phone|postcode|zip)|format|must|should|required|please (enter|provide|use|select|choose|fill|complete|answer)|incorrect|not allowed|too (short|long)|at least|no more than|only (digits|numbers|letters)|enter a|doesn t match|does not match|can t be blank|cannot be blank)\b/;
  const ERROR_CLASS = /error|invalid|danger/i;
  const ERROR_NEAR =
    '[role="alert"], [aria-live="assertive"], [class*="error" i], [class*="invalid" i], [class*="danger" i]';
  // "Step 2 of 4", "Page 3/5".
  const STEP = /\b(?:step|page|stage|part)\s+(\d{1,2})\s*(?:of|\/|out of)\s*(\d{1,2})\b/i;
  const COOKIE_WORDS = /\bcookies?\b|\bconsent\b|\bgdpr\b|\btracking technolog/i;
  const BUTTONISH = /(^|[\s_-])(btn|button)([\s_-]|$)/i;
  const NOT_FOR_AI = new Set(['file', 'password', 'email', 'tel', 'url']);
  const TYPED = new Set(['text', 'textarea', 'email', 'tel', 'url', 'number', 'date', 'month', 'password']);
  // A document's name ("Ada_Lovelace_CV.pdf Successfully Uploaded!"), in any text the map gives: never on a map.
  const FILE_NAME = /[^\s"'<>]*[\w)\]-]\.(pdf|docx?|rtf|odt|txt|pages)\b/gi;

  // An applicant tracking system known by its markup, whatever host serves it (a careers site on the employer's own
  // domain); lib/pagemap.js falls back to the address.
  // prettier-ignore
  const PLATFORMS = [
    ['workday', '[data-automation-id^="formField-"], [data-uxi-widget-type], [data-automation-id="applyFlowPage"]'],
    ['greenhouse', '#grnhse_app, [name^="job_application["], .application--form, iframe[src*="greenhouse.io/embed"]'],
    ['lever', '.application-question, .posting-page, form[action*="lever.co"]'],
    ['ashby', '[class*="ashby-application"], [class*="ashby-job-posting"]'],
    ['icims', '[class*="iCIMS_"]'],
    ['successfactors', '[data-careersite-propertyid], input[name="career_company"], .rcmFieldLabel'],
    ['oracle', '.cx-select-pills-container, [class*="apply-flow-"]'],
    ['taleo', '#requisitionDescriptionInterface, [id*="reqTitleLinkAction"]'],
    ['jobvite', 'button[jv-add-attachment], [class*="jv-job-"], .jv-page-body'],
    ['workable', '[data-ui="application-form"], [data-ui="job-title"]'],
    ['teamtailor', '[data-controller*="careersite"], [data-forms--inputs--choice-target]'],
    ['avature', '.fieldSpec, [class*="avature" i]'],
  ];
  // Widget libraries, by their markup: each counted once per instance (its outermost element).
  // prettier-ignore
  const WIDGETS = [
    ['MUI', '.MuiFormControl-root, .MuiFormControlLabel-root, .MuiAutocomplete-root'],
    ['Ant Design', '.ant-form-item, .ant-select, .ant-input, .ant-input-number, .ant-picker, .ant-checkbox-wrapper, .ant-radio-group, .ant-cascader'],
    ['Headless UI', '[id^="headlessui-"][id*="-control-"], [id^="headlessui-combobox-input"], [id^="headlessui-listbox-button"], [id^="headlessui-radiogroup"], [id^="headlessui-switch"]'],
    ['Radix', '[aria-controls^="radix-"], [role="radiogroup"][data-orientation], button[role="checkbox"][data-state]'],
    ['react-select', '[id^="react-select-"][id$="-live-region"]'],
    ['Downshift', '[id^="downshift-"][id$="-menu"]'],
    ['select2', '.select2-selection'],
    ['chosen', '.chosen-container'],
    ['Choices.js', '.choices[data-type]'],
    ['Tom Select', '.ts-wrapper'],
    ['intl-tel-input', '.iti'],
    ['react-phone-number-input', '.PhoneInput'],
    ['jQuery UI', '.ui-autocomplete-input, .hasDatepicker, .ui-selectmenu-button'],
    ['Element Plus', '.el-form-item, .el-select, .el-input, .el-input-number, .el-date-editor, .el-radio-group, .el-checkbox, .el-cascader'],
    ['Vuetify', '.v-input'],
    ['Quill', '.ql-container'],
    ['ProseMirror/TipTap', '.ProseMirror'],
    ['Lexical', '[data-lexical-editor]'],
    ['CKEditor', '.ck-editor, .cke'],
    ['TinyMCE', '.tox-tinymce'],
    ['Flatpickr', '.flatpickr-input'],
    ['Workday', '[data-automation-id^="formField-"]'],
  ];

  const now = () => (root.performance ? root.performance.now() : Date.now());
  const ids = (el, attr) => (el.getAttribute(attr) || '').split(/\s+/).filter(Boolean);
  const top = (w) => w.stack[w.stack.length - 1];

  function byId(el, id) {
    const scope = el.getRootNode();
    return (scope.getElementById && scope.getElementById(id)) || el.ownerDocument.getElementById(id);
  }

  /** One step up the tree as it is shown: a slotted node's slot, an element's parent, a shadow root's host. */
  const up = (n) => n.assignedSlot || n.parentElement || (n.parentNode && n.parentNode.host) || null;

  /** What a node shows in its place: its open shadow tree, a slot's assigned nodes (else its fallback), its children. */
  function childrenOf(node) {
    if (node.shadowRoot) return node.shadowRoot.childNodes;
    if (node.localName === 'slot' && node.assignedNodes) {
      const assigned = node.assignedNodes();
      if (assigned.length) return assigned;
    }
    return node.childNodes;
  }

  function commonAncestor(nodes) {
    let a = nodes[0] && nodes[0].parentElement;
    while (a && !nodes.every((n) => a.contains(n))) a = a.parentElement;
    return a;
  }

  function isTop() {
    try {
      return window.self === window.top;
    } catch (err) {
      return false;
    }
  }

  function labelsOf(el) {
    try {
      return el.labels ? Array.from(el.labels) : [];
    } catch (err) {
      return [];
    }
  }

  /** An option that only asks for a choice ("--", "Please select"). */
  const isPlaceholder = (text) => !text || /^-+$/.test(text) || JTF.matcher.isPlaceholder(U.normalize(text));

  /** Checked state of a native radio or checkbox, or an ARIA one (role="radio", aria-pressed buttons). */
  const isChecked = (m) =>
    m.localName === 'input'
      ? !!m.checked
      : m.getAttribute('aria-checked') === 'true' || m.getAttribute('aria-pressed') === 'true';

  /* -------------------------------------------------------- fields' places */

  /**
   * Every field's controls, and for each element on the way up from them which fields it holds (two at most: enough
   * to tell "this field's" from "several fields'").
   */
  function index(w) {
    w.fields.forEach((f, fi) => {
      for (const el of [f.el, ...f.members]) {
        if (!w.controls.has(el)) w.controls.set(el, fi);
        for (let n = el, d = 0; n && d < 400; n = up(n), d++) {
          const held = w.anc.get(n);
          if (!held) w.anc.set(n, [fi]);
          else if (held.length >= 2) break;
          else if (held[0] !== fi) held.push(fi);
        }
      }
    });
  }

  const holdsOther = (w, node, fi) => (w.anc.get(node) || []).some((j) => j !== fi);

  /**
   * Can this element count as part of field `fi` (its label, its group, the box that shows its choice): it holds no
   * other field, and no form, heading or submit button of the page's.
   */
  function ownable(w, node, fi) {
    if (!node || node.nodeType !== 1 || /^(body|html|form|main|dialog)$/.test(node.localName)) return false;
    if (holdsOther(w, node, fi) || w.controls.has(node)) return false;
    return !node.querySelector(
      'form, h1, h2, h3, iframe, input[type="submit"], button[type="submit"], button:not([type]), [role="dialog"]',
    );
  }

  /** An upload's own box (its drop zone, label and the files it lists): up to where other fields start. */
  function uploadBox(w, f, fi) {
    let box = null;
    for (let a = f.el.parentElement, n = 0; a && n < 6 && !holdsOther(w, a, fi); a = a.parentElement, n++) box = a;
    return box;
  }

  /**
   * The elements that belong to a field besides its controls: its labels, what it is labelled and described by, its
   * options' group, the box where a dropdown shows its choice (snapshot.shownAnswer), an upload's drop zone. The walk
   * places the field where the first of them shows, and reads no page text inside them.
   */
  function own(w) {
    const others = w.fields.flatMap((f) => f.members);
    const add = (node, fi) => {
      if (node && !w.owned.has(node) && ownable(w, node, fi)) w.owned.set(node, fi);
    };
    w.fields.forEach((f, fi) => {
      for (const m of f.members) {
        for (const l of labelsOf(m)) add(l, fi);
        for (const attr of ['aria-labelledby', 'aria-describedby']) for (const id of ids(m, attr)) add(byId(m, id), fi);
      }
      if (f.el !== f.members[0]) for (const id of ids(f.el, 'aria-labelledby')) add(byId(f.el, id), fi);
      if (f.kind === 'radio' || f.kind === 'checkboxes') add(commonAncestor(f.members), fi);
      else if (f.kind === 'combo' || f.kind === 'combobox')
        for (const box of snap().shownAnswer(f, others)) add(box, fi);
      else if (f.kind === 'file') add(uploadBox(w, f, fi), fi);
    });
  }

  /**
   * The page's own message about a field ("This field is required", "Please enter a valid email"): what its
   * aria-errormessage points to, an error it is described by, or an error shown in its row. Its elements are noted so
   * the walk doesn't read them again as page text or alerts.
   */
  function errorOf(w, f, fi) {
    if (late(w)) return '';
    const said = [];
    const consider = (n, sure) => {
      if (!n || n.nodeType !== 1 || w.errors.has(n) || n.contains(f.el) || !dom().isVisible(n)) return;
      if (n.querySelector('input, select, textarea')) return;
      const text = U.cleanLabel(dom().textOf(n), 240);
      if (!text) return;
      const alert = n.getAttribute('role') === 'alert' || n.getAttribute('aria-live') === 'assertive';
      if (!sure && !((alert || ERROR_CLASS.test(n.getAttribute('class') || '')) && ERROR_TEXT.test(U.normalize(text))))
        return;
      w.errors.set(n, fi);
      if (!said.includes(text)) said.push(text);
    };
    for (const m of f.members) {
      for (const id of ids(m, 'aria-errormessage')) consider(byId(m, id), true);
      for (const id of ids(m, 'aria-describedby')) consider(byId(m, id), false);
    }
    const start = f.members.length > 1 ? commonAncestor(f.members) : f.el.parentElement;
    for (let a = start, i = 0; a && i < 4 && !holdsOther(w, a, fi); a = a.parentElement, i++)
      for (const n of a.querySelectorAll(ERROR_NEAR)) consider(n, false);
    // An error inside another (a message and its icon's wrapper) is said once.
    return said.filter((t) => !said.some((o) => o !== t && o.includes(t))).join(' ');
  }

  /* -------------------------------------------------------------- the walk */

  /** The computed style of an element a person can see, else null (a box with nothing showing is not seen). */
  function shown(w, el) {
    const style = w.win.getComputedStyle(el);
    if (!style || style.display === 'none') return null;
    if (style.display === 'contents') return style;
    if (
      typeof el.checkVisibility === 'function' &&
      !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    )
      return null;
    // Kept for screen readers only (a 1px clipped box), collapsed to nothing, or parked far off-screen.
    if (style.clip === 'rect(0px, 0px, 0px, 0px)' || /^inset\((50|100)%/.test(style.clipPath)) return null;
    const clips = style.overflowX !== 'visible' || style.overflowY !== 'visible';
    if (clips || style.position === 'absolute' || style.position === 'fixed') {
      const rect = el.getBoundingClientRect();
      if (clips && (rect.width < 2 || rect.height < 2)) return null;
      if (rect.right + w.win.scrollX < 0 || rect.bottom + w.win.scrollY < 0) return null;
    }
    return style;
  }

  function halt(w, why) {
    w.stop = why;
  }

  /** Past twice the time allowed (a page with thousands of fields): what each field holds and asks still, no more. */
  const late = (w) => now() - w.t0 > w.ms * 2;

  function walk(w, parent, ctx) {
    const kids = childrenOf(parent);
    for (let i = 0; i < kids.length && !w.stop; i++) {
      const n = kids[i];
      if (n.nodeType === 3) {
        if (!ctx.mute) w.buf.push(n.data);
      } else if (n.nodeType === 1) visit(w, n, ctx);
    }
  }

  /** Read a hidden element only for the fields inside it (they are on the map whatever shows). */
  function hidden(w, el, ctx) {
    if (w.anc.has(el)) walk(w, el, ctx.hidden ? ctx : Object.assign({}, ctx, { hidden: true, mute: true }));
  }

  function visit(w, el, ctx) {
    if (w.stop) return;
    if (++w.visited > LIMITS.elements) return halt(w, 'element limit');
    if ((w.visited & 127) === 0 && now() - w.t0 > w.ms) return halt(w, 'time limit');
    const tag = el.localName;
    if (NEVER.has(tag) || el.hasAttribute('data-jtf-ui')) return;
    const fi = w.controls.get(el);
    if (fi != null) return place(w, fi);
    if (ctx.hidden || el.getAttribute('aria-hidden') === 'true' || w.errors.has(el)) return hidden(w, el, ctx);
    const style = shown(w, el);
    if (!style) return hidden(w, el, ctx);
    if (CONTROLS.has(tag)) {
      if (tag === 'input' && BUTTON_INPUTS.has((el.getAttribute('type') || '').toLowerCase())) action(w, el, ctx);
      return;
    }
    const block = style.display !== 'contents' && !style.display.startsWith('inline');
    if (block) flush(w);
    inside(w, el, tag, style, ctx);
    if (block) flush(w);
  }

  /** A visible element that is not a control: what it is on the map, then what is inside it. */
  function inside(w, el, tag, style, ctx) {
    const owner = w.owned.get(el);
    if (owner != null) {
      place(w, owner);
      return walk(w, el, owner === ctx.owner ? ctx : Object.assign({}, ctx, { owner, mute: true }));
    }
    if (tag === 'iframe' || tag === 'frame') return frame(w, el);
    if (!ctx.mute) {
      if (el.getAttribute('aria-current') === 'step') w.progress.step = w.progress.step || stepOf(el);
      if (el.getAttribute('role') === 'progressbar') w.progress.bar = w.progress.bar || barOf(el);
      if (el.matches(ALERT)) return alert(w, el, ctx);
      if (/^h[1-6]$/.test(tag) || tag === 'legend' || el.getAttribute('role') === 'heading') {
        heading(w, el, tag);
        if (w.anc.has(el)) walk(w, el, Object.assign({}, ctx, { mute: true }));
        return;
      }
    }
    if (action(w, el, ctx)) {
      if (w.anc.has(el)) walk(w, el, Object.assign({}, ctx, { mute: true }));
      return;
    }
    if (!ctx.mute) {
      const role = landmarkRole(el, tag);
      if (role === 'dialog' || role === 'alertdialog') return dialog(w, el, role, ctx);
      if ((role === 'nav' || role === 'footer') && !w.anc.has(el) && collapsed(w, el, role)) return;
      if (role) return container(w, el, ctx, role, landmarkName(el, role), null);
      if (!ctx.overlay && (style.position === 'fixed' || style.position === 'sticky') && cookieBanner(w, el))
        return dialog(w, el, 'cookie banner', ctx);
    }
    walk(w, el, ctx);
  }

  /** Put field `fi` on the map here, if it isn't yet. */
  function place(w, fi) {
    if (w.placed.has(fi)) return;
    flush(w);
    w.placed.add(fi);
    top(w).push({ t: 'field', ref: `f${fi + 1}` });
  }

  /** The text read since the last block ended, as one text block: unless a field already says it, or it was said. */
  function flush(w) {
    if (!w.buf.length) return;
    const text = w.buf.join('').replace(/\s+/g, ' ').trim();
    w.buf = [];
    if (!/[\p{L}\p{N}]/u.test(text)) return;
    const n = U.normalize(text);
    if (!n || w.seen.has(n) || w.attached.has(n) || (n.length >= 40 && w.prefixes.has(n.slice(0, 40)))) return;
    w.seen.add(n);
    stepIn(w, text);
    if (w.texts >= LIMITS.texts) {
      w.counts.textElided += text.length;
      return;
    }
    w.texts++;
    const kept = text.length > LIMITS.text ? text.slice(0, LIMITS.text).trim() + '…' : text;
    w.counts.textElided += Math.max(0, text.length - LIMITS.text);
    w.counts.textChars += kept.length;
    top(w).push({ t: 'text', text: w.t(kept) });
  }

  /** "Step 2 of 4" in the page's text. */
  function stepIn(w, text) {
    if (w.progress.text) return;
    const m = text.match(STEP);
    if (m && +m[1] >= 1 && +m[1] <= +m[2]) w.progress.text = { step: +m[1], total: +m[2], text: U.cleanLabel(m[0]) };
  }

  /** A step list's current step (aria-current="step"): its place in the list, and its name. */
  function stepOf(el) {
    const label = U.cleanLabel(dom().textOf(el), 80);
    const list = el.closest('ol, ul, [role="list"], [role="tablist"]');
    const items = list ? Array.from(list.children).filter((c) => c.localName !== 'script') : [];
    const i = items.findIndex((c) => c === el || c.contains(el));
    return i >= 0 ? { step: i + 1, total: items.length, label } : { label };
  }

  /** A progress bar with a value ("40%", or its own "Step 2 of 5"). */
  function barOf(el) {
    const value = parseFloat(el.getAttribute('aria-valuenow'));
    if (!Number.isFinite(value)) return null;
    const max = parseFloat(el.getAttribute('aria-valuemax')) || 100;
    const said = U.cleanLabel(el.getAttribute('aria-valuetext') || '', 80);
    const m = said.match(STEP);
    if (m) return { step: +m[1], total: +m[2], text: said };
    return { text: said || `${Math.round((value / max) * 100)}% done` };
  }

  function heading(w, el, tag) {
    const text = U.cleanLabel(dom().visibleText(el), 300);
    const n = U.normalize(text);
    if (!n) return;
    stepIn(w, text);
    // A question set as a heading ("Are you authorized…" as a group's legend) is on its field's line, a dialog's
    // title on the dialog's.
    if (w.questions.has(n) || n === w.names[w.names.length - 1]) return;
    w.seen.add(n);
    const level = /^h[1-6]$/.test(tag)
      ? +tag[1]
      : tag === 'legend'
        ? 2
        : Math.min(6, Math.max(1, parseInt(el.getAttribute('aria-level'), 10) || 2));
    top(w).push({ t: 'h', level, text: w.t(text) });
  }

  function alert(w, el, ctx) {
    const text = U.cleanLabel(dom().visibleText(el), 240);
    if (text && w.alerts.length < LIMITS.alerts && !w.alerts.includes(w.t(text))) w.alerts.push(w.t(text));
    walk(w, el, Object.assign({}, ctx, { mute: true }));
  }

  /** A control's accessible name: what labels it, its own text, its image's alternative text, its title. */
  function nameOf(el) {
    const by = ids(el, 'aria-labelledby')
      .map((id) => byId(el, id))
      .filter(Boolean)
      .map((n) => dom().textOf(n))
      .join(' ');
    const type = (el.getAttribute('type') || '').toLowerCase();
    const input =
      el.localName === 'input'
        ? el.value || el.getAttribute('alt') || { submit: 'Submit', reset: 'Reset' }[type] || ''
        : '';
    let text = by || el.getAttribute('aria-label') || input || dom().textOf(el);
    if (!text) {
      const img = el.querySelector('img[alt], [title], svg title');
      text = img ? img.getAttribute('alt') || img.getAttribute('title') || img.textContent : '';
    }
    return U.cleanLabel(text || el.getAttribute('title') || '', 120);
  }

  /**
   * A button, a submit, or a link that acts like one (styled as a button, "#"/script links, or worded as an action:
   * "Apply now", "Next"): on the map as an action, unless it is a widget's own (a dropdown's toggle). False for a
   * plain link, whose text is read as page text.
   */
  function action(w, el, ctx) {
    const tag = el.localName;
    const role = el.getAttribute('role');
    let type = null;
    if (tag === 'button') type = el.type === 'submit' && el.form ? 'submit' : el.type === 'reset' ? 'reset' : 'button';
    else if (tag === 'input') type = { image: 'submit' }[el.type] || el.type;
    else if (role === 'button') type = 'button';
    else if ((tag === 'a' && el.hasAttribute('href')) || role === 'link') type = 'link';
    if (!type) return false;
    // Inside a field's own box (a dropdown's "Open", a date picker's calendar button): part of the field, except an
    // upload's "Attach".
    if (ctx.owner != null && w.fields[ctx.owner].kind !== 'file') return true;
    const text = nameOf(el);
    const intent = PM.intentOf(text, { cookie: ctx.overlay === 'cookie' });
    if (type === 'link' && intent === 'other') {
      const href = (el.getAttribute('href') || '').trim();
      if (!BUTTONISH.test(el.getAttribute('class') || '') && !/^(#|javascript:)/i.test(href)) return false;
    }
    flush(w);
    const ref = `b${w.actions.length + 1}`;
    const disabled = !!el.disabled || el.getAttribute('aria-disabled') === 'true' || !!el.closest('fieldset[disabled]');
    w.actions.push({ ref, text: w.t(text), type, intent, disabled, el });
    w.byEl.set(el, ref);
    top(w).push({ t: 'action', ref });
    return true;
  }

  function frame(w, el) {
    flush(w);
    const raw = el.hasAttribute('srcdoc') ? 'about:srcdoc' : el.src || el.getAttribute('src') || 'about:blank';
    const ref = `i${w.iframes.length + 1}`;
    w.iframes.push({
      ref,
      src: w.t(snap().cleanUrl(raw)),
      name: w.t(U.cleanLabel(el.getAttribute('name') || '', 80)),
      title: w.t(U.cleanLabel(el.getAttribute('title') || el.getAttribute('aria-label') || '', 120)),
      captcha: !!(JTF.accounts && JTF.accounts.isCaptchaFrame(raw)),
      el,
    });
    w.byEl.set(el, ref);
    top(w).push({ t: 'frame', ref });
  }

  /** The landmark an element is ("form", "nav", "dialog"…), or null. A section only counts when it is named. */
  function landmarkRole(el, tag) {
    const named = el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby');
    const role = el.getAttribute('role');
    if (role) {
      const as = ROLES[role] || null;
      return as === 'section' && !named ? null : as;
    }
    if (!LANDMARK_TAGS.has(tag)) return el.getAttribute('aria-modal') === 'true' ? 'dialog' : null;
    if ((tag === 'header' || tag === 'footer') && el.parentElement && el.parentElement.closest(SCOPED)) return null;
    if (tag === 'section' && !named) return null;
    return tag;
  }

  /** A landmark's name: what labels it; for a form, a dialog or a section, the heading it starts with. */
  function landmarkName(el, role) {
    const by = ids(el, 'aria-labelledby')
      .map((id) => byId(el, id))
      .filter(Boolean)
      .map((n) => dom().textOf(n))
      .join(' ');
    let name = by || el.getAttribute('aria-label') || '';
    if (!name && /^(form|dialog|alertdialog|section|cookie banner)$/.test(role)) {
      // A form's own title is a main heading; a dialog's or a section's, any.
      const h = el.querySelector(role === 'form' ? 'h1, h2' : 'h1, h2, h3, h4, legend, [role="heading"]');
      const first = el.querySelector('input:not([type="hidden"]), select, textarea, button');
      // Only a heading before the first field names it (not "Education" halfway down the form).
      if (h && (!first || h.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING)) name = dom().textOf(h);
    }
    return U.cleanLabel(name, 120);
  }

  /** A landmark and what is in it, as one node of the outline (left out when nothing in it shows). */
  function container(w, el, ctx, role, name, overlay) {
    flush(w);
    const node = { t: 'landmark', role, children: [] };
    if (name) node.name = w.t(name);
    w.stack.push(node.children);
    w.names.push(U.normalize(name));
    walk(w, el, overlay ? Object.assign({}, ctx, { overlay }) : ctx);
    flush(w);
    w.stack.pop();
    w.names.pop();
    if (node.children.length) top(w).push(node);
  }

  /** A dialog, alert dialog or cookie banner: an overlay of the page, and a landmark of the outline. */
  function dialog(w, el, role, ctx) {
    const name = landmarkName(el, role);
    const cookie = role === 'cookie banner' || COOKIE_WORDS.test(name || (el.textContent || '').slice(0, 600));
    const kind = cookie ? 'cookie banner' : role;
    let modal = el.getAttribute('aria-modal') === 'true';
    try {
      modal = modal || (el.localName === 'dialog' && el.matches(':modal'));
    } catch (err) {
      /* a browser without :modal */
    }
    const overlay = { kind, name: w.t(name) };
    if (modal) overlay.modal = true;
    w.overlays.push(overlay);
    container(w, el, ctx, kind, name, cookie ? 'cookie' : 'dialog');
  }

  /** A fixed or sticky box that asks about cookies and has something to press: a cookie banner. */
  function cookieBanner(w, el) {
    const rect = el.getBoundingClientRect();
    if (rect.width < w.win.innerWidth * 0.3 && rect.height < w.win.innerHeight * 0.2) return false;
    return (
      COOKIE_WORDS.test((el.textContent || '').slice(0, 3000)) &&
      !!el.querySelector('button, [role="button"], a[href], input[type="button"], input[type="submit"]')
    );
  }

  /** Navigation or a footer with no fields: one line, how many links and the first few ("nav: 14 links"). */
  function collapsed(w, el, role) {
    const links = Array.from(el.querySelectorAll('a[href]')).filter(
      (a) =>
        !a.closest('[aria-hidden="true"]') &&
        (typeof a.checkVisibility !== 'function' ||
          a.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })),
    );
    if (!links.length) return false;
    flush(w);
    const sample = [];
    for (const a of links) {
      const text = U.cleanLabel(dom().textOf(a) || a.getAttribute('aria-label') || '', 40);
      if (text && !sample.includes(w.t(text))) sample.push(w.t(text));
      if (sample.length >= 8) break;
    }
    const node = { t: 'landmark', role, links: links.length, sample };
    const name = landmarkName(el, role);
    if (name) node.name = w.t(name);
    top(w).push(node);
    return true;
  }

  /* ---------------------------------------------------------------- fields */

  /** The options a field offers: its own, else those of the list it controls that the page already holds. */
  function optionsOf(f) {
    if (f.kind === 'checkbox') return null;
    if (f.desc.options && f.desc.options.length) return f.desc.options;
    if (f.kind !== 'combo' && f.kind !== 'combobox') return null;
    for (const id of [...ids(f.el, 'aria-controls'), ...ids(f.el, 'aria-owns')]) {
      const list = byId(f.el, id);
      if (!list || list.contains(f.el)) continue;
      const rows = Array.from(list.querySelectorAll('[role="option"]')).slice(0, 1000);
      if (rows.length) return rows.map((o) => ({ text: U.cleanLabel(dom().textOf(o), 200), value: '' }));
    }
    return null;
  }

  /** Which options are picked (by index into `options`), and the picked texts. */
  function chosenOf(f, options, hasValue) {
    const picked = new Set();
    let texts = [];
    const { el, kind, members } = f;
    const native = kind === 'select' ? el : kind === 'combo' || kind === 'combobox' ? dom().standsFor(el) : null;
    if (kind === 'radio' || kind === 'checkboxes') members.forEach((m, i) => isChecked(m) && picked.add(i));
    else if (native && options === f.desc.options && native.options.length === options.length) {
      // What a list shows is a pick, even the one it starts on; its "Please select" is none.
      Array.from(native.options).forEach(
        (o, i) => o.selected && o.value !== '' && !isPlaceholder(o.text) && picked.add(i),
      );
    } else if (hasValue && (kind === 'combo' || kind === 'combobox')) {
      // A box typed into shows text, not a pick, unless that text is one of its options.
      const typed = kind === 'combobox' && el.localName === 'input' && !!el.value.trim();
      let shown = '';
      try {
        shown = typed ? el.value.trim() : JTF.fill.currentValue(f);
      } catch (err) {
        /* a widget that went away */
      }
      const n = U.normalize(shown);
      (options || []).forEach((o, i) => U.normalize(o.text) === n && picked.add(i));
      if (!picked.size && !typed && shown) texts = [U.cleanLabel(shown, 200)];
    }
    if (picked.size) texts = [...picked].map((i) => U.cleanLabel(options[i].text, 200));
    return { picked, texts };
  }

  /** The field's box on the page: its options' (a group's) or its own, else what shows for it (a label, a wrapper). */
  function anchorOf(f) {
    const targets = f.kind === 'radio' || f.kind === 'checkboxes' ? f.members : [f.el];
    const out = [];
    for (const m of targets) {
      const label = labelsOf(m)[0];
      const target = dom().isVisible(m, { ignoreOpacity: true })
        ? m
        : label && dom().isVisible(label)
          ? label
          : m.parentElement && dom().isVisible(m.parentElement, { ignoreOpacity: true })
            ? m.parentElement
            : null;
      if (target) out.push(target);
    }
    return out;
  }

  function geometry(w, els) {
    const rects = els.map((el) => el.getBoundingClientRect()).filter((r) => r.width || r.height);
    if (!rects.length) return { visible: false, inViewport: false };
    const left = Math.min(...rects.map((r) => r.left));
    const topY = Math.min(...rects.map((r) => r.top));
    const right = Math.max(...rects.map((r) => r.right));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    return {
      visible: true,
      inViewport: left < w.win.innerWidth && right > 0 && topY < w.win.innerHeight && bottom > 0,
      rect: {
        x: Math.round(left + w.win.scrollX),
        y: Math.round(topY + w.win.scrollY),
        w: Math.round(right - left),
        h: Math.round(bottom - topY),
      },
    };
  }

  /**
   * What the rules make of a field, as content/main.js inspect() shows it: ok (the profile has the answer), empty (it
   * hasn't), secret (a password or card), consent (a box left for you), file (an upload, when the documents aren't
   * known) or unknown.
   */
  function statusOf(w, f, r) {
    if (r.type === 'custom') return 'ok';
    const def = JTF.fields.DEFS[r.type];
    if (!def) return 'unknown';
    const { profile, docs, settings } = w.opts;
    const question = U.normalize(JTF.matcher.questionText(f.desc));
    if (def.file) {
      if (!docs) return 'file';
      return docs[def.file] && (!profile || JTF.fields.uploadApplies(r.type, profile, question)) ? 'ok' : 'empty';
    }
    if (def.secret) return 'secret';
    if (def.consent) return settings && settings.consents ? 'ok' : 'consent';
    if (!profile || late(w)) return 'unknown';
    const ctx = Object.assign({}, w.context, {
      index: r.index || 0,
      part: r.part,
      kind: f.kind,
      answer: r.answer,
      question,
      help: U.normalize(JTF.matcher.helpText(f.desc)),
      options: f.desc.options,
    });
    try {
      return JTF.fields.resolve(r.type, profile, ctx) ? 'ok' : 'empty';
    } catch (err) {
      return 'unknown';
    }
  }

  /** One field's entry: never what is typed in it (unless values: 'full'), never a password or a file's name. */
  function fieldEntry(w, f, fi, fills) {
    const { el, desc, kind } = f;
    const s = desc.signals || {};
    const r = w.results[fi] || null;
    const t = w.t;
    const full = w.values === 'full';
    const question = U.cleanLabel(JTF.matcher.questionText(desc), 300);
    const out = { ref: `f${fi + 1}`, kind, inputType: desc.inputType, question: t(question) };
    const error = w.errorText[fi];
    // What else the page says about it, once each, and only what the question doesn't already say.
    const said = [U.normalize(question)];
    const add = (key, text, max) => {
      const c = U.cleanLabel(text || '', max);
      const n = U.normalize(c);
      if (!n || said.some((x) => x === n || x.includes(n))) return;
      said.push(n);
      out[key] = t(c);
    };
    add('label', s.label, 200);
    add('aria', s.aria, 200);
    add('placeholder', desc.placeholderRaw, 120);
    const section = U.cleanLabel(s.section || '', 120);
    if (section && !said.some((x) => x.includes(U.normalize(section)))) {
      out.section = t(section);
      said.push(U.normalize(section));
    }
    add('group', s.group, 200);
    const help = JTF.matcher.helpText(desc);
    add('help', error && help.includes(error) ? help.replace(error, '') : help, 400);

    let hasValue = null;
    try {
      hasValue = !!JTF.fill.hasValue(f);
    } catch (err) {
      /* a widget that went away */
    }
    out.hasValue = hasValue;
    // Equal-opportunity answers, pronouns, title, date of birth: which one is picked stays out (as in a snapshot).
    const withheld = !full && !!(r && snap().isPrivate(r.type));
    const options = optionsOf(f);
    const { picked, texts } = withheld ? { picked: new Set(), texts: [] } : chosenOf(f, options || [], hasValue);
    if (options) {
      out.optionCount = options.length;
      out.options = options.slice(0, LIMITS.options).map((o, i) => {
        const text = U.cleanLabel(o.text, 200);
        const opt = { text: t(text) };
        if (o.value && o.value !== o.text) opt.value = t(String(o.value).slice(0, 200));
        if (o.disabled) opt.disabled = true;
        if (o.group) opt.group = t(o.group);
        if (isPlaceholder(text)) opt.placeholder = true;
        if (picked.has(i)) opt.chosen = true;
        return opt;
      });
    }
    if (withheld) out.withheld = true;
    else if (kind === 'checkbox') out.checked = isChecked(el);
    else if (texts.length) out.chosen = texts.map(t);
    if (full && kind !== 'password' && kind !== 'file' && desc.inputType !== 'password') {
      let v = '';
      try {
        v = JTF.fill.currentValue(f);
      } catch (err) {
        /* a widget that went away */
      }
      if (v) out.value = v.length > 200 ? v.slice(0, 200) + '…' : v;
    }

    out.required = snap().isRequired(f);
    if (el.disabled || el.getAttribute('aria-disabled') === 'true' || el.closest('fieldset[disabled]'))
      out.disabled = true;
    // A dropdown's search box is often read-only: you pick, not type. Only a box meant for typing counts.
    if ((TYPED.has(kind) && el.readOnly) || el.getAttribute('aria-readonly') === 'true') out.readOnly = true;
    out.invalid = snap().isInvalid(f) || !!error;
    const validity = snap().validityOf(el);
    if (validity.length) out.validity = validity;
    const quote = (text) => t(full ? text : snap().unquote(text));
    if (el.validationMessage && (out.invalid || validity.some((k) => k !== 'valueMissing')))
      out.validationMessage = quote(el.validationMessage);
    if (error) out.error = quote(error);
    if (desc.maxLength) out.maxLength = desc.maxLength;
    if (desc.multiple) out.multiple = true;
    if (desc.autocomplete) out.autocomplete = desc.autocomplete;

    const anchors = anchorOf(f);
    Object.assign(out, geometry(w, anchors));
    if (!r || !r.type) {
      out.rules = { type: null, status: 'unknown' };
      // The questions a fill leaves to the AI (content/main.js pendingQuestions): no rule, nothing in it yet.
      if (!NOT_FOR_AI.has(kind) && U.normalize(question).length >= 3 && !hasValue) out.forAi = true;
    } else {
      out.rules = { type: r.type };
      if (r.index) out.rules.index = r.index;
      if (r.part) out.rules.part = r.part;
      if (r.source) out.rules.source = r.source;
      out.rules.status = statusOf(w, f, r);
    }
    const api = root.__jtf;
    if (api && api.aiFilled && api.aiFilled(f)) out.aiFilled = true;
    const path = snap().pathOf(el);
    const last = fills.get(path);
    if (last) {
      out.fill = { step: last.step, status: last.status };
      if (last.reason) out.fill.reason = quote(String(last.reason));
    }
    out.path = w.ident(path);
    w.refs.set(out.ref, { anchor: anchors[0] || null, status: out.rules.status });
    return out;
  }

  /* --------------------------------------------------------------- capture */

  /** The tracking system the page's markup belongs to, if it says. */
  function platformIn(doc) {
    for (const [name, selector] of PLATFORMS) {
      try {
        if (doc.querySelector(selector)) return name;
      } catch (err) {
        /* a selector this browser doesn't know */
      }
    }
    return null;
  }

  /** Widget libraries on the page, with how many of each. */
  function widgetsIn(doc) {
    const out = {};
    for (const [name, selector] of WIDGETS) {
      let n = 0;
      try {
        for (const el of doc.querySelectorAll(selector))
          if (!el.parentElement || !el.parentElement.closest(selector)) n++;
      } catch (err) {
        /* a selector this browser doesn't know */
      }
      if (n) out[name] = n;
    }
    return out;
  }

  /**
   * The map of this frame. opts: { profile, settings, docs ({ resume: true }…), jobLocation, values ('state' by
   * default: what is picked, never what is typed; 'redacted': also every text through the snapshot's redactor;
   * 'full': typed values too, for developers), files (the documents' names, for the redactor), timeLimit }.
   */
  function capture(doc, opts) {
    const o = opts || {};
    const values = VALUE_MODES.has(o.values) ? o.values : 'state';
    const win = doc.defaultView || root;
    const r = values === 'redacted' ? JTF.redact.redactor(o.profile, { files: o.files }) : null;
    const href = (win.location && win.location.href) || doc.URL || '';
    const fields = dom().collect(doc);
    const planned = JTF.matcher.plan(
      fields.map((f) => f.desc),
      o.profile || null,
    );
    const w = {
      doc,
      win,
      values,
      opts: o,
      t: (s) => (s ? (r ? r.text(s) : s).replace(FILE_NAME, '[file]') : ''),
      ident: r ? (s) => r.ident(s) : (s) => s,
      t0: now(),
      ms: o.timeLimit > 0 ? o.timeLimit : LIMITS.ms,
      fields,
      results: planned.results,
      context: Object.assign({}, planned.context, { jobLocation: o.jobLocation || '' }),
      controls: new Map(),
      anc: new Map(),
      owned: new Map(),
      errors: new Map(),
      errorText: [],
      placed: new Set(),
      stack: [[]],
      names: [''],
      buf: [],
      seen: new Set(),
      attached: new Set(),
      prefixes: new Set(),
      questions: new Set(),
      actions: [],
      iframes: [],
      byEl: new Map(),
      refs: new Map(),
      alerts: [],
      overlays: [],
      progress: {},
      visited: 0,
      texts: 0,
      counts: { textChars: 0, textElided: 0 },
      stop: null,
    };
    index(w);
    w.fields.forEach((f, fi) => (w.errorText[fi] = errorOf(w, f, fi)));
    own(w);
    // What the fields already say: page text that only repeats it is left out.
    const attach = (text) => {
      const n = U.normalize(text);
      if (!n) return;
      w.attached.add(n);
      if (n.length >= 40) w.prefixes.add(n.slice(0, 40));
    };
    for (const [fi, f] of w.fields.entries()) {
      const s = f.desc.signals || {};
      for (const q of [JTF.matcher.questionText(f.desc), s.label, s.aria]) if (q) w.questions.add(U.normalize(q));
      [s.question, s.label, s.aria, s.nearby, s.placeholder, s.title, s.group, s.describedby, s.sectionHelp].forEach(
        attach,
      );
      attach(JTF.matcher.questionText(f.desc));
      attach(w.errorText[fi]);
      for (const opt of f.desc.options || []) attach(opt.text);
    }
    if (doc.body) walk(w, doc.body, { hidden: false, mute: false, owner: null, overlay: null });
    flush(w);
    // A field the walk didn't reach (it stopped early, or the field shows outside the body): at the end.
    w.fields.forEach((f, fi) => place(w, fi));

    const fills = new Map();
    for (const e of snap().trace) fills.set(e.path, e);
    const entries = w.fields.map((f, fi) => fieldEntry(w, f, fi, fills));
    const actions = w.actions.map(({ el, ...a }) => {
      const g = geometry(w, [el]);
      w.refs.set(a.ref, { anchor: el, status: 'action' });
      return Object.assign(a, g);
    });
    const iframes = w.iframes.map(({ el, ...x }) => {
      w.refs.set(x.ref, { anchor: el, status: 'frame' });
      return Object.assign(x, geometry(w, [el]));
    });
    const active = dom().deepActiveElement(doc);
    const focusField = active ? w.controls.get(active) : undefined;
    const scroller = doc.scrollingElement || doc.documentElement;
    const out = {
      url: w.t(snap().cleanUrl(href)),
      host: w.t((win.location && win.location.hostname) || ''),
      title: w.t(U.cleanLabel(doc.title || '', 300)),
      lang: (doc.documentElement && doc.documentElement.getAttribute('lang')) || '',
      isTop: isTop(),
      hasFocus: typeof doc.hasFocus === 'function' ? doc.hasFocus() : false,
      values,
      platform: platformIn(doc),
      widgets: widgetsIn(doc),
      progress: w.progress.step || w.progress.text || w.progress.bar || null,
      alerts: w.alerts,
      overlays: w.overlays,
      focus: focusField != null ? `f${focusField + 1}` : (active && w.byEl.get(active)) || null,
      viewport: {
        width: win.innerWidth,
        height: win.innerHeight,
        scrollX: Math.round(win.scrollX),
        scrollY: Math.round(win.scrollY),
        pageWidth: scroller ? scroller.scrollWidth : 0,
        pageHeight: scroller ? scroller.scrollHeight : 0,
      },
      counts: {
        fields: entries.length,
        required: entries.filter((f) => f.required).length,
        filled: entries.filter((f) => f.hasValue).length,
        invalid: entries.filter((f) => f.invalid).length,
        actions: actions.length,
        textBlocks: w.texts,
        textChars: w.counts.textChars,
        textElided: w.counts.textElided,
        elements: w.visited,
      },
      outline: w.stack[0],
      fields: entries,
      actions,
      iframes,
    };
    if (w.stop) out.truncated = w.stop;
    if (out.progress && out.progress.label) out.progress.label = w.t(out.progress.label);
    if (out.progress && out.progress.text) out.progress.text = w.t(out.progress.text);
    state.last = { doc, refs: w.refs };
    return out;
  }

  /* ----------------------------------------------------------------- marks */

  const state = { last: null, marks: null };
  // Set-of-marks tags: by what the rules make of a field (as the inspect labels), buttons and frames apart.
  // prettier-ignore
  const MARK_COLOURS = {
    ok: '#16a34a', empty: '#d97706', secret: '#7c3aed', consent: '#0891b2', file: '#0891b2', unknown: '#6b7280',
    action: '#2563eb', frame: '#db2777',
  };
  // Styled through the CSSOM, so a page's Content-Security-Policy can't strip them; nothing takes up room.
  const HOST = {
    all: 'initial',
    position: 'absolute',
    top: '0',
    left: '0',
    width: '0',
    height: '0',
    overflow: 'visible',
    pointerEvents: 'none',
    zIndex: '2147483647',
  };
  const TAG = {
    position: 'absolute',
    padding: '0 4px',
    borderRadius: '4px',
    font: '600 11px/15px system-ui, sans-serif',
    color: '#fff',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    boxShadow: '0 1px 3px rgba(0, 0, 0, 0.35)',
  };

  /**
   * Draw each ref of this frame's last map at the top left of its field, button or frame (`names`: the page's refs
   * for this frame's own, { f1: 'f12' }), or take them all off. Never moves anything on the page.
   */
  function marks(on, names) {
    if (state.marks) {
      state.marks.remove();
      state.marks = null;
    }
    if (!on || !state.last) return { on: false, marks: 0 };
    const doc = state.last.doc;
    const win = doc.defaultView;
    // Every box read first, then everything drawn: one layout.
    const boxes = [];
    for (const [ref, item] of state.last.refs) {
      const el = item.anchor;
      if (!el || !el.isConnected) continue;
      const rect = el.getBoundingClientRect();
      if (!rect.width && !rect.height) continue;
      const text = (names && names[ref]) || ref;
      let x = Math.max(0, Math.round(rect.left + win.scrollX));
      const y = Math.max(0, Math.round(rect.top + win.scrollY) - 8);
      // Two refs on one box (a hidden upload's label is its "Attach" button): the second goes beside the first.
      while (boxes.some((b) => Math.abs(b.y - y) < 12 && x >= b.x && x < b.x + b.width)) x += 4;
      boxes.push({ text, colour: MARK_COLOURS[item.status] || MARK_COLOURS.unknown, x, y, width: 8 + 7 * text.length });
    }
    const host = doc.createElement('jobtofill-marks');
    host.setAttribute('data-jtf-ui', '');
    Object.assign(host.style, HOST);
    const shadow = host.attachShadow({ mode: 'closed' });
    for (const b of boxes) {
      const tag = doc.createElement('div');
      Object.assign(tag.style, TAG, { background: b.colour, left: b.x + 'px', top: b.y + 'px' });
      tag.textContent = b.text;
      shadow.append(tag);
    }
    doc.documentElement.append(host);
    state.marks = host;
    return { on: true, marks: boxes.length };
  }

  /** The element a ref of this frame's last map stands for (a field's box, a button, a frame), if still there. */
  function element(ref) {
    const item = state.last && state.last.refs.get(ref);
    return item && item.anchor && item.anchor.isConnected ? item.anchor : null;
  }

  /** This frame's map for the background (a CAPTCHA's frame is left out). */
  function pageMap(opts) {
    const href = location.href;
    if (JTF.accounts && JTF.accounts.isCaptchaFrame(href))
      return { url: snap().cleanUrl(href), isTop: isTop(), skipped: 'captcha' };
    try {
      return capture(document, opts);
    } catch (err) {
      return { url: snap().cleanUrl(href), isTop: isTop(), error: String((err && err.message) || err) };
    }
  }

  /** Give the in-page API (content/main.js) the page map. */
  function register() {
    const api = root.__jtf;
    if (!api || api.pageMap) return;
    api.pageMap = pageMap;
    api.pageMapMarks = marks;
  }

  Object.assign(PM, { capture, marks, element, register });
  register();
})(typeof globalThis !== 'undefined' ? globalThis : this);
