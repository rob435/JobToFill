/*
 * JobToFill — "Save a snapshot for a bug report": a copy of the form in this frame that a developer can open and
 * turn into a test fixture, without the person in it. Typed values are left out, personal details anywhere in the
 * page become placeholders (lib/redact.js), and scripts and anything else that could run or load the page's
 * content are taken out. What is ticked and picked stays (it shows what a fill chose), except in equal-opportunity
 * questions. Also keeps a trace of what the last fills here did, never the values.
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});
  if (JTF.snapshot) return;
  const U = JTF.util;

  /* ------------------------------------------------------------ fill trace */

  // The outcome of each JTF.fill.apply call in this frame, newest last: question, field kind, the kind of value
  // (text, date, list…), status and reason. Never the value.
  const TRACE_MAX = 300;
  const trace = [];

  function note(entry) {
    trace.push(entry);
    if (trace.length > TRACE_MAX) trace.splice(0, trace.length - TRACE_MAX);
  }

  /**
   * Wraps JTF.fill.apply to note what each call did. Transparent: same arguments and `this`, the very promise
   * apply returns (its rejection reaches the caller untouched), a synchronous throw passes straight through, and
   * nothing the trace does can break a fill.
   * TODO(lead): replace with a proper hook in fill()/apply() once the rewrite lands.
   */
  function traced(apply) {
    const wrapper = function (field, v) {
      let entry = null;
      try {
        entry = {
          at: Date.now(),
          question: U.cleanLabel(JTF.matcher.questionText(field.desc), 200),
          kind: field.kind,
          type: (v && v.kind) || null,
          path: pathOf(field.el),
          status: null,
          reason: null,
        };
      } catch (err) {
        entry = null;
      }
      const result = apply.apply(this, arguments);
      const done = (status, reason) => {
        if (!entry) return;
        try {
          note(Object.assign(entry, { status, reason: reason || null, ms: Date.now() - entry.at }));
        } catch (err) {
          /* never in the way of a fill */
        }
      };
      if (result && typeof result.then === 'function')
        result.then(
          (res) => done(res && res.status, res && res.reason),
          (err) => done('threw', String((err && err.message) || err)),
        );
      else done(result && result.status, result && result.reason);
      return result;
    };
    wrapper.traced = true;
    return wrapper;
  }

  if (JTF.fill && typeof JTF.fill.apply === 'function' && !JTF.fill.apply.traced)
    JTF.fill.apply = traced(JTF.fill.apply);

  /* ------------------------------------------------------------- the copy */

  const HTML_NS = 'http://www.w3.org/1999/xhtml';
  const isHtml = (el) => !el.namespaceURI || el.namespaceURI === HTML_NS;
  // prettier-ignore
  const VOID = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr',
    'basefont', 'bgsound', 'frame', 'keygen', 'param',
  ]);
  // Never copied: what runs or loads content (plugins, the page's own <base>), and the obsolete elements whose
  // text would swallow the rest of the file (<plaintext>).
  // prettier-ignore
  const SKIP = new Set([
    'script', 'noscript', 'object', 'embed', 'applet', 'portal', 'fencedframe', 'base', 'xmp', 'plaintext',
    'noembed', 'noframes',
  ]);
  // Inputs whose value attribute is part of the page (an option's value, a button's text), not something typed.
  const KEEP_VALUE = new Set(['checkbox', 'radio', 'submit', 'button', 'reset', 'image']);
  // prettier-ignore
  const URL_ATTRS = new Set([
    'href', 'xlink:href', 'src', 'action', 'formaction', 'cite', 'background', 'poster', 'srcset', 'imagesrcset',
    'ping', 'manifest', 'longdesc', 'codebase', 'data',
  ]);
  const NO_URL = new Set(['srcset', 'imagesrcset', 'ping', 'poster', 'manifest', 'longdesc', 'codebase', 'data']);
  // Images, media and frames load nothing from the copy (frames are copied on their own).
  // prettier-ignore
  const MEDIA = new Set(['img', 'image', 'source', 'video', 'audio', 'track', 'iframe', 'frame', 'picture']);
  // Attributes that name things rather than say them: a name in them is only a whole token, and placeholders have no
  // spaces (aria-labelledby lists stay lists).
  // prettier-ignore
  const IDENT_ATTRS = new Set([
    'class', 'id', 'for', 'name', 'slot', 'part', 'form', 'list', 'headers', 'role', 'type', 'autocomplete',
    'inputmode', 'lang', 'dir', 'itemprop', 'itemtype', 'aria-labelledby', 'aria-describedby', 'aria-controls',
    'aria-owns', 'aria-activedescendant', 'aria-details', 'aria-errormessage', 'aria-flowto',
  ]);
  const DROP_ATTRS = new Set(['srcdoc', 'nonce']);
  const ATTR_NAME = /^[^\s"'>/=<\p{Cc}]+$/u;
  const TAG_NAME = /^[a-z][^\s/>"'=<]*$/i;
  // The copy runs nothing and sends nothing even if something slipped through, and its forms can't be submitted to
  // the real site. The extension's own content scripts are not bound by it, so it can still fill the copy.
  const CSP =
    "script-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; connect-src 'none'; form-action 'none'";

  // Equal-opportunity answers (gender, ethnicity, disability…), pronouns, title, date of birth, age and adjustments
  // are personal even as a picked option: which one is picked is left out.
  const PRIVATE_CHOICE = /^(eeo\.|pronouns$|name\.prefix$|dob$|age$|job\.adjustments$)/;
  // Inside such a question only text, controls and their roles stay: ARIA states read "false", and the classes,
  // inline styles, data-* markers and textless ornaments widgets show the picked option with go (a hashed CSS-in-JS
  // class that differs on the checked radio, Radix's indicator rendered only inside it, MUI's scaled dot).
  const STATE_ARIA = new Set(['aria-checked', 'aria-pressed', 'aria-selected']);
  const CONTROLISH = 'input, select, textarea, button, option, label, [role]';
  const KEEP_DATA = new Set([
    'data-automation-id',
    'data-testid',
    'data-test',
    'data-qa',
    'data-cy',
    'data-field',
    'data-name',
  ]);
  // …and where a custom dropdown shows the answer itself, its text and the attributes that repeat it (but not the
  // options' own text).
  const SHOWN_VALUE_ATTRS = new Set(['aria-label', 'title', 'aria-valuetext', 'aria-description', 'value']);
  const OPTION_TEXT = 'option, optgroup, [role="option"], [role="listbox"]';

  const escText = (s) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/\u00a0/g, '&nbsp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  const escAttr = (s) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/\u00a0/g, '&nbsp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

  /** A path segment that looks like a token or an id (a magic link's "8f3a9c…", a UUID), not a word. */
  const isToken = (seg) => seg.length >= 20 && /\d/.test(seg) && /[a-z]/i.test(seg) && !/\.[a-z0-9]{2,5}$/i.test(seg);
  const tokenless = (path) =>
    path
      .split('/')
      .map((seg) => (isToken(seg) ? '[id]' : seg))
      .join('/');

  /** A page or frame address as origin and path only: query strings and fragments carry tokens and emails. */
  function cleanUrl(href) {
    try {
      const u = new URL(href);
      if (/^(https?|file|ftp):$/.test(u.protocol)) return `${u.protocol}//${u.host}${tokenless(u.pathname)}`;
      return u.protocol;
    } catch (err) {
      return '';
    }
  }

  /** A URL attribute without its query (and fragment, except SVG's "icons.svg#check"). */
  function cleanHref(value, keepFragment) {
    const v = value.trim();
    const cut = v.search(/[?#]/);
    const path = tokenless(cut < 0 ? v : v.slice(0, cut));
    const fragment = keepFragment ? (v.match(/#[^?]*$/) || [''])[0] : '';
    return path + fragment;
  }

  /**
   * CSS without data:, blob: and script URLs (fonts and icons inlined into it, or anything worse), redacted. Names
   * only where CSS holds text (strings, url()): elsewhere "white" and "grid" are keywords, not Ms White.
   */
  function cleanCss(css, ctx) {
    const out = css.replace(
      /url\(\s*(?:"((?:[^"\\]|\\[\s\S])*)"|'((?:[^'\\]|\\[\s\S])*)'|([^)'"]*))\s*\)/gi,
      (m, a, b, c) => {
        const u = String(a != null ? a : b != null ? b : c || '')
          .replace(/[\s\\]/g, '')
          .toLowerCase();
        return /^(data|blob|javascript|vbscript|filesystem):/.test(u) ? 'url("")' : m;
      },
    );
    return ctx.r
      .strict(out)
      .replace(/"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|url\([^)]*\)/g, (m) => ctx.r.ident(m));
  }

  /** The rules of a style sheet the page built through the CSSOM (CSS-in-JS libraries leave the <style> empty). */
  function rulesOf(sheet) {
    try {
      return sheet && sheet.cssRules ? Array.from(sheet.cssRules, (rule) => rule.cssText).join('\n') : '';
    } catch (err) {
      return ''; // another origin's sheet
    }
  }

  // In a <style>'s raw text a "<" could end it early ("</style><img onerror=…>"): CSS spells it "\3c ".
  const rawCss = (css) => css.replace(/</g, '\\3c ');

  /** Style sheets adopted by a document or shadow root (web components keep their styles there). */
  function adoptedStyles(rootNode, ctx) {
    let sheets;
    try {
      sheets = rootNode.adoptedStyleSheets;
    } catch (err) {
      return '';
    }
    const css = sheets && sheets.length ? Array.from(sheets, rulesOf).join('\n') : '';
    return css.trim() ? `<style data-jtf-adopted="">${rawCss(cleanCss(css, ctx))}</style>` : '';
  }

  const isStylesheet = (el) => /(^|\s)stylesheet(\s|$)/i.test(el.getAttribute('rel') || '');

  /** The element where typing in a rich-text editor happens (its whole content is what the person wrote). */
  function editingHost(el) {
    if (el.isContentEditable) return !(el.parentElement && el.parentElement.isContentEditable);
    return el.getAttribute('role') === 'textbox' && !/^(input|textarea)$/.test(el.localName);
  }

  function setAttr(attrs, name, value) {
    const i = attrs.findIndex(([n]) => n.toLowerCase() === name);
    if (i >= 0) attrs.splice(i, 1);
    if (value != null) attrs.push([name, value]);
  }

  /** An element's attributes for the copy: [[name, value]], cleaned and redacted. */
  function attributes(el, ctx) {
    const out = [];
    const html = isHtml(el);
    for (const a of Array.from(el.attributes)) {
      const key = a.name;
      const lower = key.toLowerCase();
      if (!ATTR_NAME.test(key) || lower.startsWith('on') || DROP_ATTRS.has(lower)) continue;
      let value = a.value;
      // Browsers skip spaces and control characters in a URL's scheme ("java&#9;script:").
      const squashed = value.replace(/[\s\p{Cc}]+/gu, '').toLowerCase();
      if (/(?:java|vb)script:/.test(squashed) || /^(?:data|blob|filesystem):/.test(squashed)) continue;
      // App state a server rendered into the page (data-props='{"candidate":…}'): it can hold a whole application.
      if (lower.startsWith('data-') && value.length > 40 && /^\s*[{[]/.test(value)) continue;
      if (ctx.hide) {
        if (STATE_ARIA.has(lower)) value = 'false';
        else if (
          ['class', 'style', 'aria-current'].includes(lower) ||
          (lower.startsWith('data-') && !KEEP_DATA.has(lower))
        )
          continue;
      }
      if (ctx.blank && SHOWN_VALUE_ATTRS.has(lower) && !el.closest(OPTION_TEXT)) continue;
      if (URL_ATTRS.has(lower)) {
        if (NO_URL.has(lower) || MEDIA.has(el.localName) || (el.localName === 'input' && lower === 'src')) continue;
        const v = value.trim();
        if (v.startsWith('#')) value = ctx.r.ident(v);
        // Style sheets keep their query (usually a version), so they still load.
        else if (el.localName === 'link') value = ctx.r.text(v);
        else value = ctx.r.text(cleanHref(v, !html));
      } else if (lower === 'style') value = cleanCss(value, ctx);
      else if (IDENT_ATTRS.has(lower)) value = ctx.r.ident(value);
      else value = ctx.r.text(value);
      out.push([key, value]);
    }
    return out;
  }

  function serializeNode(node, ctx, out) {
    if (node.nodeType === 1) serializeElement(node, ctx, out);
    else if (node.nodeType === 3 || node.nodeType === 4) {
      const parent = node.parentElement;
      // A custom dropdown's shown answer goes; its options (native or in a listbox) are the list itself and stay.
      if (ctx.blank && !(parent && parent.closest(OPTION_TEXT))) return;
      const data = node.data || '';
      out.push(escText(/\S/.test(data) ? ctx.r.text(data) : data));
    }
    // Comments (server templates leave all sorts in them), processing instructions: left out.
  }

  function serializeChildren(list, ctx, out) {
    for (const child of Array.from(list || [])) serializeNode(child, ctx, out);
  }

  function serializeElement(el, ctx, out) {
    const name = el.localName;
    if (!name || !TAG_NAME.test(name) || SKIP.has(name) || el.hasAttribute('data-jtf-ui')) return;
    const html = isHtml(el);
    if (html && name === 'meta' && !/^viewport$/i.test(el.getAttribute('name') || '')) return;
    if (html && name === 'link' && !isStylesheet(el)) return;
    const root = ctx.withheld.state.has(el) || ctx.withheld.blank.has(el);
    if (ctx.hide && !root && !el.matches(CONTROLISH) && !el.querySelector(CONTROLISH) && !/\S/.test(el.textContent))
      return;
    const saved = [ctx.hide, ctx.blank];
    if (ctx.withheld.state.has(el)) ctx.hide = true;
    if (ctx.withheld.blank.has(el)) ctx.hide = ctx.blank = true;
    try {
      const attrs = attributes(el, ctx);
      let children = name === 'template' && el.content ? el.content.childNodes : el.childNodes;
      if (html && name === 'input') {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        setAttr(attrs, 'checked', null);
        if (type === 'checkbox' || type === 'radio') {
          if (!ctx.hide && el.checked) setAttr(attrs, 'checked', '');
        } else if (!KEEP_VALUE.has(type)) {
          setAttr(attrs, 'value', null);
          if (String(el.value || '').trim()) setAttr(attrs, 'data-jtf-had-value', '');
        }
      } else if (html && name === 'option') {
        setAttr(attrs, 'selected', null);
        if (!ctx.hide && el.selected) setAttr(attrs, 'selected', '');
      } else if (html && name === 'textarea') {
        if (String(el.value || '').trim()) setAttr(attrs, 'data-jtf-had-value', '');
        children = null;
      } else if (html && (name === 'iframe' || name === 'frame')) {
        // Its own copy follows the page's, in a <template data-frame-url> with this address.
        const src = cleanUrl(el.src || el.getAttribute('src') || '');
        if (src) setAttr(attrs, 'data-frame-url', ctx.r.text(src));
        children = null;
      } else if (html && editingHost(el)) {
        if ((el.textContent || '').trim()) setAttr(attrs, 'data-jtf-had-value', '');
        children = null;
      }
      out.push(`<${name}${attrs.map(([n, v]) => ` ${n}="${escAttr(v)}"`).join('')}>`);
      if (!ctx.headDone && (el === ctx.doc.head || (el === ctx.doc.documentElement && !ctx.doc.head))) {
        ctx.headDone = true;
        out.push(ctx.headStart);
      }
      if (html && VOID.has(name)) return;
      // An open shadow root, as declarative shadow DOM: the copy shows it when opened, as getHTML() writes it.
      const shadow = el.shadowRoot;
      if (shadow && shadow.mode !== 'closed') {
        out.push('<template shadowrootmode="open">', adoptedStyles(shadow, ctx));
        serializeChildren(shadow.childNodes, ctx, out);
        out.push('</template>');
      }
      if (name === 'style') {
        // CSS-in-JS libraries (emotion, styled-components) insert their rules through the CSSOM, leaving it empty.
        let css = el.textContent || '';
        if (!css.trim()) css = rulesOf(el.sheet);
        css = cleanCss(css, ctx);
        out.push(html ? rawCss(css) : escText(css));
      } else if (children) serializeChildren(children, ctx, out);
      out.push(`</${name}>`);
    } finally {
      [ctx.hide, ctx.blank] = saved;
    }
  }

  /** The smallest element holding all of a question's options. */
  function commonAncestor(nodes) {
    let a = nodes[0] && nodes[0].parentElement;
    while (a && !nodes.every((n) => a.contains(n))) a = a.parentElement;
    return a;
  }

  const LABELISH = 'label, legend, h1, h2, h3, h4, h5, h6, [role="heading"]';

  /**
   * Where a dropdown shows its answer: its own box (the control and react-select's single value beside its input),
   * grown up to where its question, a heading or another field starts; and, inside the wrapper that holds its
   * label, the box's other siblings (select2's rendered choice after a hidden <select>), never the label itself.
   */
  function shownAnswer(field, others) {
    const q = U.normalize(JTF.matcher.questionText(field.desc));
    const foreign = (node) => others.some((o) => o !== field.el && node.contains(o));
    const asks = (node) => !!q && U.normalize(node.textContent).includes(q);
    let box = field.el;
    let a = field.el.parentElement;
    for (let n = 0; a && n < 5; a = a.parentElement, n++) {
      if (a === a.ownerDocument.body || a.matches('form, fieldset, label, [role="group"], [role="radiogroup"]'))
        return [box];
      if (foreign(a)) return [box];
      if (a.querySelector(LABELISH) || asks(a)) break;
      box = a;
    }
    if (!a) return [box];
    const beside = Array.from(a.children).filter(
      (c) => c !== box && !c.matches(LABELISH) && !c.querySelector(LABELISH) && !foreign(c) && !asks(c),
    );
    return [box, ...beside];
  }

  /** Which elements' picked state (and, for custom dropdowns, shown text) the copy leaves out. */
  function privateChoices(doc, fields, results) {
    const state = new Set();
    const blank = new Set();
    const els = fields.flatMap((f) => f.members);
    fields.forEach((f, i) => {
      const r = results[i];
      if (!r || !r.type || !PRIVATE_CHOICE.test(r.type)) return;
      for (const m of f.members) state.add(m);
      if (f.kind === 'radio' || f.kind === 'checkboxes') {
        const group = commonAncestor(f.members);
        if (group && !els.some((o) => !f.members.includes(o) && group.contains(o))) state.add(group);
      } else if (f.kind !== 'checkbox') {
        // A dropdown shows its answer: as its own text, or (select2, react-select) in an element beside it.
        for (const box of shownAnswer(f, els)) blank.add(box);
        // An open menu marks the picked option.
        const ids = `${f.el.getAttribute('aria-controls') || ''} ${f.el.getAttribute('aria-owns') || ''}`;
        for (const id of ids.split(/\s+/).filter(Boolean)) {
          const scope = f.el.getRootNode ? f.el.getRootNode() : doc;
          const list = (scope.getElementById && scope.getElementById(id)) || doc.getElementById(id);
          if (list) state.add(list);
        }
      }
    });
    return { state, blank };
  }

  /**
   * Where an element is, as a CSS-ish path from the nearest ancestor with an id ("form#apply > div:nth-of-type(3) >
   * input"); " >>> " steps into a shadow root.
   */
  function pathOf(el) {
    const scopes = [];
    for (let node = el; node && node.nodeType === 1;) {
      const segs = [];
      for (let n = node; n; n = n.parentElement) {
        const id = n.getAttribute('id');
        if (id && /^[A-Za-z][\w-]*$/.test(id)) {
          segs.unshift(`${n.localName}#${id}`);
          break;
        }
        const parent = n.parentElement || n.parentNode;
        const same =
          parent && parent.children ? Array.from(parent.children).filter((c) => c.localName === n.localName) : [];
        segs.unshift(same.length > 1 ? `${n.localName}:nth-of-type(${same.indexOf(n) + 1})` : n.localName);
      }
      scopes.unshift(segs.join(' > '));
      const scope = node.getRootNode ? node.getRootNode() : null;
      node = scope && scope.host ? scope.host : null;
    }
    return scopes.join(' >>> ');
  }

  // Validation messages can quote what was typed ("'adaexample.com' is missing an '@'").
  const unquote = (s) => String(s || '').replace(/(["'“‘«])[^"'”’»]*(["'”’»])/g, '$1[value]$2');
  // prettier-ignore
  const VALIDITY = [
    'valueMissing', 'typeMismatch', 'patternMismatch', 'tooLong', 'tooShort', 'rangeUnderflow', 'rangeOverflow',
    'stepMismatch', 'badInput', 'customError',
  ];

  /** What the developer needs to know about one field: never its value, only whether it has one. */
  function fieldInfo(field, res, r) {
    const { el, desc } = field;
    const s = desc.signals || {};
    const attr = (m, a) => (m.getAttribute && m.getAttribute(a)) || '';
    let hasValue = null;
    try {
      hasValue = !!JTF.fill.hasValue(field);
    } catch (err) {
      /* a widget that went away */
    }
    const options = desc.options ? desc.options.map((o) => r.text(U.cleanLabel(o.text, 200))) : null;
    return {
      kind: field.kind,
      question: r.text(U.cleanLabel(JTF.matcher.questionText(desc), 300)),
      section: r.text(U.cleanLabel(s.section || '', 120)),
      type: (res && res.type) || null,
      index: (res && res.index) || 0,
      part: (res && res.part) || null,
      inputType: desc.inputType,
      autocomplete: desc.autocomplete || '',
      options: options ? options.slice(0, 50) : null,
      optionCount: options ? options.length : null,
      hasValue,
      // required, aria-required, or a label that ends in "*" ("First Name *").
      required:
        field.members.some((m) => m.required || attr(m, 'aria-required') === 'true') ||
        !!(el.closest && el.closest('[aria-required="true"]')) ||
        /\*\s*$/.test(s.label || s.question || '') ||
        Array.from(el.labels || []).some((l) => /\*\s*$/.test(l.textContent || '')),
      invalid: field.members.some((m) => !/^(|false)$/.test(attr(m, 'aria-invalid'))),
      validity: el.validity ? VALIDITY.filter((k) => el.validity[k]) : [],
      validationMessage: r.text(unquote(el.validationMessage)),
      path: r.ident(pathOf(el)),
    };
  }

  /**
   * The redacted copy of `doc`, as HTML from <html> to </html>, with a <meta charset>, the CSP above and a <base>
   * pointing at the page (so its style sheets load when the file is opened) at the top of its <head>.
   * opts: { profile, files: [{ which, name }] } — what to redact; fields/results from a scan (else none withheld).
   */
  function serialize(doc, opts) {
    const r = opts.redact || JTF.redact.redactor(opts.profile, { files: opts.files });
    const href = opts.url || doc.baseURI || doc.URL || '';
    const base = /^(https?|file|ftp):/.test(href) ? r.text(cleanUrl(href)) : '';
    const ctx = {
      doc,
      r,
      hide: false,
      blank: false,
      headDone: false,
      withheld: opts.fields
        ? privateChoices(doc, opts.fields, opts.results || [])
        : { state: new Set(), blank: new Set() },
      headStart: '',
    };
    ctx.headStart =
      '<meta charset="utf-8">' +
      `<meta http-equiv="Content-Security-Policy" content="${escAttr(CSP)}">` +
      (base ? `<base href="${escAttr(base)}">` : '') +
      adoptedStyles(doc, ctx);
    const out = [];
    if (doc.documentElement) serializeElement(doc.documentElement, ctx, out);
    return out.join('');
  }

  /**
   * Everything a bug report needs from this frame: { url, host, title, html, fields, fillTrace }. `host` is for
   * the background to find saved logins to redact; it isn't written to the file.
   * payload: { profile, files: [{ which, name }] }.
   */
  function capture(doc, payload) {
    const { profile, files } = payload || {};
    const r = JTF.redact.redactor(profile, { files });
    let fields = [];
    let results = [];
    let scanError = null;
    try {
      fields = JTF.dom.collect(doc);
      results = JTF.matcher.plan(
        fields.map((f) => f.desc),
        profile,
      ).results;
    } catch (err) {
      scanError = String((err && err.message) || err);
    }
    const view = doc.defaultView || root;
    const href = (view.location && view.location.href) || doc.URL || '';
    const out = {
      url: r.text(cleanUrl(href)),
      host: (view.location && view.location.hostname) || '',
      title: r.text(U.cleanLabel(doc.title || '', 300)),
      html: serialize(doc, { redact: r, fields, results }),
      fields: fields.map((f, i) => fieldInfo(f, results[i], r)),
      fillTrace: trace.map((t) =>
        Object.assign({}, t, {
          at: new Date(t.at).toISOString(),
          question: r.text(t.question),
          reason: t.reason ? r.text(unquote(t.reason)) : null,
          path: r.ident(t.path),
        }),
      ),
    };
    if (scanError) out.scanError = scanError;
    return out;
  }

  JTF.snapshot = { capture, serialize, cleanUrl, pathOf, traced, trace };
})(typeof globalThis !== 'undefined' ? globalThis : this);
