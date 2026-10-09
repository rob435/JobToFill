/*
 * JobToFill — page maps: a page as the extension sees it, for the AI and for developers. Each frame maps itself
 * (content/pagemap.js: landmarks, headings, text, every field the fill scans with its question, options, state and
 * what the rules take it for, the buttons that act on the form, and its frames). merge() makes one page of the
 * frames' maps, each frame under the <iframe> that shows it and refs numbered across the page (f1, b1, i1);
 * render() writes it as a compact outline for a prompt, cut to a budget without ever dropping a field or a button.
 * Pure: the background and the Node unit tests use it too.
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});
  const pagemap = (JTF.pagemap = JTF.pagemap || {});

  const VERSION = 1;
  // The text outline's budget in characters (about 6,000 tokens).
  const MAX_CHARS = 24000;
  // Options listed on a field's line: all of a short list, the first ones of a long one (fewer once over budget).
  const OPTIONS_SHOWN = 40;
  const OPTIONS_SHORT = 12;
  const ALERTS_SHOWN = 10;
  // Kinds whose answer is one or more of the options shown.
  const CHOICE_KINDS = new Set(['select', 'radio', 'checkboxes', 'combo', 'combobox']);
  const TYPED_KINDS = new Set(['text', 'textarea', 'email', 'tel', 'url', 'number']);

  const norm = (s) =>
    JTF.util
      ? JTF.util.normalize(s)
      : String(s || '')
          .toLowerCase()
          .replace(/[^\p{L}\p{N}]+/gu, ' ')
          .trim();
  const clip = (s, max) => {
    const t = String(s == null ? '' : s)
      .replace(/\s+/g, ' ')
      .trim();
    return t.length > max ? t.slice(0, max).trim() + '…' : t;
  };
  const q = (s) => `"${clip(s, 600)}"`;
  // 12345 -> "12,345", whatever the locale.
  const thousands = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  /* --------------------------------------------------------------- intents */

  // What pressing a button would do, by its words (normalised): the first that matches wins, so "Save and continue"
  // is next before it is save, and "Submit application" is submit before it is apply.
  const INTENTS = [
    ['submit', /^(submit|send|finish|complete|done)\b|\bsubmit\b|\bsend (my |your )?application\b/],
    ['next', /^(next|continue|proceed|review|save (and )?(continue|next|proceed)|go to (the )?next|start)\b/],
    ['back', /^(back|previous|prev|go back|return)\b/],
    ['apply', /\bapply\b|\b(start|begin) (your |my |an |the )?application\b|\bi m interested\b/],
    ['save', /^save\b|\bsave (as )?(a )?(draft|for later|progress)\b/],
    ['add', /^add\b|\badd (another|more|new|a|an)\b/],
    ['remove', /^(remove|delete|clear|discard)\b/],
    ['upload', /\b(upload|attach|browse|choose (a )?files?|select (a )?files?|drop files?)\b/],
    ['close', /^(close|dismiss|no thanks|not now|cancel|maybe later|skip)\b/],
  ];
  // Inside a cookie banner: the words that take the cookies.
  const ACCEPT = /^(accept|allow|agree|i agree|ok|okay|got it|i understand|yes)\b/;
  const COOKIES = /\bcookies?\b/;
  const REJECT =
    /^(reject|decline|refuse|deny|necessary( cookies)? only|only (strictly )?necessary|essential( cookies)? only|only essential)\b/;

  /**
   * What a button, submit or link-styled-as-a-button does, from its accessible name: next / back / submit / save /
   * add / remove / upload / signin / signup / apply / accept-cookies / reject-cookies / close / other. Sign-in and
   * sign-up wording is lib/account.js's own. ctx: { cookie (inside a cookie banner) }.
   */
  function intentOf(text, ctx) {
    const raw = String(text || '').trim();
    if (/^[×✕✖xX]$/.test(raw)) return 'close';
    const t = norm(raw).slice(0, 120);
    if (!t) return 'other';
    if ((ctx && ctx.cookie && ACCEPT.test(t)) || (COOKIES.test(t) && ACCEPT.test(t))) return 'accept-cookies';
    if ((ctx && ctx.cookie && REJECT.test(t)) || (COOKIES.test(t) && REJECT.test(t))) return 'reject-cookies';
    const account = JTF.accounts ? JTF.accounts.intent(t) : null;
    if (account === 'signin' || account === 'to-signin' || account === 'to-email') return 'signin';
    if (account === 'signup' || account === 'to-signup') return 'signup';
    const hit = INTENTS.find(([, re]) => re.test(t));
    return hit ? hit[0] : 'other';
  }

  /** The applicant tracking system an address belongs to (lib/jobpage.js knows the hosts, where it is loaded). */
  function platformOf(url) {
    if (!url || !JTF.jobpage || !JTF.jobpage.ats) return null;
    try {
      return JTF.jobpage.ats(url).name || null;
    } catch (err) {
      return null;
    }
  }

  /* ----------------------------------------------------------------- merge */

  /** Which of the frames not placed yet an <iframe> shows: the same address, then the same size. */
  function frameFor(node, candidates) {
    const same = candidates.filter((c) => c.url && c.url === node.src);
    if (same.length < 2 || !node.rect) return same[0] || null;
    const fits = (c) =>
      c.viewport && Math.abs(c.viewport.width - node.rect.w) <= 4 && Math.abs(c.viewport.height - node.rect.h) <= 4;
    return same.find(fits) || same[0];
  }

  /** Each outline node again, with its ref swapped for the page's. */
  function renumber(nodes, refs) {
    return (nodes || []).map((n) => {
      const out = Object.assign({}, n);
      if (n.ref) out.ref = refs[n.ref] || n.ref;
      if (n.children) out.children = renumber(n.children, refs);
      return out;
    });
  }

  const COUNT_KEYS = ['fields', 'required', 'filled', 'invalid', 'actions', 'textBlocks', 'textChars', 'textElided'];
  // Chromium hands a frame's map over with its keys sorted: the ones a reader looks for first go first again.
  // prettier-ignore
  const KEYS = [
    'ref', 'frame', 'local', 'kind', 'inputType', 'type', 'text', 'intent', 'question', 'label', 'aria', 'placeholder',
    'group', 'help', 'section', 'required', 'hasValue', 'chosen', 'withheld', 'checked', 'value', 'optionCount',
    'options', 'rules', 'forAi', 'aiFilled', 'fill', 'invalid', 'error', 'validity', 'validationMessage', 'disabled',
    'readOnly', 'src', 'name', 'title', 'child', 'captcha', 'visible', 'inViewport', 'rect',
  ];
  const ordered = (x) => Object.assign(Object.fromEntries(KEYS.filter((k) => k in x).map((k) => [k, x[k]])), x);

  /**
   * The frames' own maps ([{ frameId, …capture }], any order) as one page map: the top frame first, then each frame
   * where its <iframe> is met (matched by address), then the frames no <iframe> was found for. Refs are numbered
   * across the page (f1, f2… in that order); each field, button and frame keeps its frame's own ref as `local`.
   */
  function merge(list) {
    const frames = (list || [])
      .filter(Boolean)
      .map((f, i) => Object.assign({}, f, { frameId: f.frameId != null ? f.frameId : i }))
      .sort((a, b) => a.frameId - b.frameId);
    const top = frames.find((f) => f.isTop) || frames.find((f) => f.frameId === 0) || null;
    const waiting = frames.filter((f) => f !== top);
    const order = [];
    const parents = new Map();
    const place = (f) => {
      order.push(f);
      for (const node of f.iframes || []) {
        const child = frameFor(node, waiting);
        if (!child) continue;
        waiting.splice(waiting.indexOf(child), 1);
        parents.set(child, { frame: f, ref: node.ref });
        place(child);
      }
    };
    if (top) place(top);
    while (waiting.length) place(waiting.shift());

    const counter = { f: 0, b: 0, i: 0 };
    const refsOf = new Map(
      order.map((f) => {
        const refs = {};
        for (const key of ['fields', 'actions', 'iframes'])
          for (const x of f[key] || []) refs[x.ref] = x.ref[0] + ++counter[x.ref[0]];
        return [f, refs];
      }),
    );
    const out = {
      version: VERSION,
      values: (top || order[0] || {}).values || 'state',
      url: '',
      title: '',
      lang: '',
      host: '',
      platform: null,
      widgets: {},
      progress: null,
      alerts: [],
      overlays: [],
      focus: null,
      counts: Object.fromEntries(COUNT_KEYS.map((k) => [k, 0])),
      frames: [],
      fields: [],
      actions: [],
      iframes: [],
    };
    const head = top || order[0] || {};
    Object.assign(out, { url: head.url || '', title: head.title || '', lang: head.lang || '', host: head.host || '' });
    const widgets = {};
    const alerts = new Set();
    let focus = null;
    order.forEach((f, index) => {
      const refs = refsOf.get(f);
      const parent = parents.get(f);
      const frame = {
        index,
        frameId: f.frameId,
        url: f.url || '',
        title: f.title || '',
        isTop: f === top,
        parent: parent ? { frame: order.indexOf(parent.frame), ref: refsOf.get(parent.frame)[parent.ref] } : null,
        placed: f === top || !!parent,
        outline: renumber(f.outline, refs),
      };
      if (f.viewport) frame.viewport = f.viewport;
      const problem = f.problem || f.error || f.skipped;
      if (problem) frame.problem = String(problem);
      if (f.truncated) frame.truncated = f.truncated;
      out.frames.push(frame);
      const local = (x) => ordered(Object.assign({}, x, { ref: refs[x.ref], local: x.ref, frame: index }));
      out.fields.push(...(f.fields || []).map(local));
      out.actions.push(...(f.actions || []).map(local));
      out.iframes.push(...(f.iframes || []).map(local));
      if (!out.platform) out.platform = f.platform || platformOf(f.url);
      for (const [name, n] of Object.entries(f.widgets || {})) widgets[name] = (widgets[name] || 0) + n;
      if (!out.progress && f.progress) out.progress = Object.assign({ frame: index }, f.progress);
      for (const text of f.alerts || []) {
        if (alerts.has(text)) continue;
        alerts.add(text);
        out.alerts.push({ text, frame: index });
      }
      for (const o of f.overlays || []) out.overlays.push(Object.assign({ frame: index }, o));
      for (const k of COUNT_KEYS) out.counts[k] += (f.counts && f.counts[k]) || 0;
      // Where the caret is: the innermost frame that has focus and points at something of its own.
      const ref = f.focus && refs[f.focus];
      if (ref && (f.hasFocus || f === top) && !(focus && focus[0] !== 'i' && ref[0] === 'i')) focus = ref;
    });
    out.focus = focus;
    // The frame placed under each <iframe>.
    for (const frame of out.frames)
      if (frame.parent) {
        const node = out.iframes.find((x) => x.ref === frame.parent.ref);
        if (node) node.child = frame.index;
      }
    out.widgets = Object.fromEntries(
      Object.entries(widgets).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    );
    out.counts.frames = out.frames.length;
    return out;
  }

  /** A frame's refs as the page numbers them ({ f1: 'f12', b1: 'b3' }), for drawing them in that frame. */
  function labels(map, index) {
    const out = {};
    for (const x of [...map.fields, ...map.actions, ...map.iframes]) if (x.frame === index) out[x.local] = x.ref;
    return out;
  }

  /* ---------------------------------------------------------------- render */

  /** How a field is shown: its kind, or the type of box ("email", "date") when that says more. */
  function kindLabel(f) {
    let k = f.kind;
    if (k === 'text' && f.inputType && !['text', 'search'].includes(f.inputType)) k = f.inputType;
    if (f.multiple && f.kind !== 'checkboxes') k += ' multi';
    return k;
  }

  /** A field's options as one list ("[Yes | No]", "(240 options: Afghanistan | Albania | …)"). */
  function optionsText(f, shown) {
    const opts = (f.options || []).filter((o) => !o.placeholder && o.text);
    if (!opts.length) return '';
    const count = Math.max(opts.length, (f.optionCount || 0) - ((f.options || []).length - opts.length));
    const text = (o) => o.text + (o.disabled ? ' (disabled)' : '');
    if (count <= OPTIONS_SHORT) return `[${opts.map(text).join(' | ')}]`;
    const list = opts.slice(0, shown).map(text);
    return `(${count} options: ${list.join(' | ')}${count > list.length ? ' | …' : ''})`;
  }

  /** What a field holds: never typed text unless the map was made with values: 'full'. */
  function stateText(f, values) {
    const kind = f.kind;
    if (values === 'full' && f.value != null && f.value !== '' && kind !== 'password' && kind !== 'file')
      return `= ${q(clip(f.value, 200))}`;
    if (f.withheld) return f.hasValue ? 'filled (answer withheld)' : CHOICE_KINDS.has(kind) ? 'none chosen' : 'empty';
    if (kind === 'checkbox') return f.checked || (f.checked == null && f.hasValue) ? 'ticked' : 'unticked';
    if (kind === 'file') return f.hasValue ? 'file attached' : 'no file';
    if (f.chosen && f.chosen.length) return `chosen ${f.chosen.map((c) => q(clip(c, 120))).join(', ')}`;
    if (f.hasValue) return 'filled';
    return CHOICE_KINDS.has(kind) ? 'none chosen' : 'empty';
  }

  // What the rules' status means for the fill: the profile has the answer, hasn't, keeps it secret, it is a box
  // left for you to tick, or an upload.
  const STATUS = { ok: '✓', empty: '✗ no value', secret: '(secret)', consent: '(left for you)', file: '(upload)' };

  function rulesText(f) {
    const r = f.rules;
    if (!r || !r.type) return `→ (none${f.forAi ? ': for AI' : ''})`;
    const name = r.type === 'custom' ? 'custom answer' : r.type + (r.index ? `#${r.index + 1}` : '');
    const part = r.part && r.part !== 'whole' ? `:${r.part}` : '';
    const status = STATUS[r.status] || '';
    return `→ ${name}${part}${status ? ' ' + status : ''}`;
  }

  /** One field's line at a level of detail: 0 everything, 1 a long option list cut short, 2 also its help cut. */
  function fieldLine(f, map, extra, level) {
    const parts = [f.ref, kindLabel(f) + (f.required ? '*' : ''), f.question ? q(f.question) : '(no question)'];
    for (const key of ['label', 'aria', 'placeholder', 'group'])
      if (f[key]) parts.push(`${key} ${q(clip(f[key], level > 1 ? 60 : 160))}`);
    if (f.help && extra.help) parts.push(`help ${q(clip(f.help, level > 1 ? 60 : 240))}`);
    if (f.section && extra.section) parts.push(`section ${q(f.section)}`);
    const options = optionsText(f, level > 0 ? OPTIONS_SHORT : OPTIONS_SHOWN);
    if (options) parts.push(options);
    if (f.maxLength && TYPED_KINDS.has(f.kind)) parts.push(`max=${f.maxLength}`);
    parts.push(stateText(f, map.values));
    if (f.disabled) parts.push('disabled');
    if (f.readOnly) parts.push('readonly');
    if (f.visible === false) parts.push('hidden');
    parts.push(rulesText(f));
    if (f.aiFilled) parts.push('(AI answer)');
    if (f.fill && f.fill.status) parts.push(`fill=${f.fill.status}${f.fill.reason ? ` ${q(f.fill.reason)}` : ''}`);
    if (f.invalid) parts.push(f.error ? `INVALID ${q(f.error)}` : 'INVALID');
    const checks = (f.validity || []).filter((k) => k !== 'valueMissing');
    if (checks.length) parts.push(`validity=${checks.join(',')}`);
    return parts.join(' ');
  }

  function actionLine(a) {
    const name = a.text ? q(a.text) : '(no label)';
    return `${a.ref} ${a.type || 'button'} ${name} (${a.intent || 'other'})${a.disabled ? ' disabled' : ''}`;
  }

  function iframeLine(x) {
    const name = x.title || x.name;
    const into = x.child != null ? `→ FRAME ${x.child}` : x.captcha ? '(CAPTCHA, not mapped)' : '(not mapped)';
    return [x.ref, 'frame', name ? q(name) : '', x.src || '', into].filter(Boolean).join(' ');
  }

  /** A landmark's line: "[form "Apply"]", or a collapsed one's summary ("[nav "Main"] 14 links: Jobs · Teams · …"). */
  function landmarkLines(n) {
    const head = `[${n.role}${n.name ? ' ' + q(n.name) : ''}]`;
    if (n.links == null) return [head];
    const count = `${head} ${n.links} link${n.links === 1 ? '' : 's'}`;
    const sample = (n.sample || []).join(' · ');
    return sample ? [`${count}: ${sample}${n.links > n.sample.length ? ' · …' : ''}`, count] : [count];
  }

  /**
   * The page map as an indented outline, one line per node, within opts.maxChars (24,000 by default). Over budget
   * it leaves out, in turn: page text farthest from any field or button, the tail of long option lists, the links
   * listed for navigation and footers, headings, and help text; never a field, a button or a frame. Same map, same
   * text. Also takes one frame's own map.
   */
  function render(input, opts) {
    if (!input) return '';
    const map = input.frames ? input : merge([input]);
    const max = opts && opts.maxChars > 0 ? opts.maxChars : MAX_CHARS;
    const byRef = new Map([...map.fields, ...map.actions, ...map.iframes].map((x) => [x.ref, x]));
    const items = [];
    let emptyFrames = 0;

    // Help said once is not said again; a section a heading above already names is not repeated.
    const helpSeen = new Set();
    const headings = new Set();
    const push = (kind, depth, variants, frame, extra) =>
      items.push(Object.assign({ kind, depth, variants, v: 0, frame, index: items.length }, extra));
    const walk = (nodes, depth, frame) => {
      for (const n of nodes || []) {
        if (n.t === 'landmark') {
          // A landmark's name heads what is in it, as a heading would.
          if (n.name) headings.add(norm(n.name));
          push(n.links != null ? 'collapsed' : 'landmark', depth, landmarkLines(n), frame);
          walk(n.children, depth + 1, frame);
        } else if (n.t === 'h') {
          headings.add(norm(n.text));
          push('heading', depth, [`${'#'.repeat(Math.min(6, Math.max(1, n.level || 2)))} ${clip(n.text, 300)}`], frame);
        } else if (n.t === 'text') {
          push('text', depth, [q(n.text)], frame, { chars: n.text.length });
        } else if (n.t === 'field' && byRef.has(n.ref)) {
          const f = byRef.get(n.ref);
          const help = f.help && !helpSeen.has(norm(f.help));
          if (help) helpSeen.add(norm(f.help));
          const extra = { help, section: !!f.section && !headings.has(norm(f.section)) };
          push(
            'field',
            depth,
            [0, 1, 2].map((level) => fieldLine(f, map, extra, level)),
            frame,
          );
        } else if (n.t === 'action' && byRef.has(n.ref)) {
          push('action', depth, [actionLine(byRef.get(n.ref))], frame);
        } else if (n.t === 'frame' && byRef.has(n.ref)) {
          push('iframe', depth, [iframeLine(byRef.get(n.ref))], frame);
        }
      }
    };
    for (const frame of map.frames) {
      const empty = !frame.outline || !frame.outline.length;
      if (frame.isTop) {
        if (frame.problem) push('frame', 0, [`(this page couldn’t be mapped: ${clip(frame.problem, 200)})`], 0);
        walk(frame.outline, 0, frame.index);
        continue;
      }
      if (empty && !frame.placed && !frame.problem) {
        emptyFrames++;
        continue;
      }
      const where = frame.parent ? `(under ${frame.parent.ref})` : '(not placed)';
      const state = frame.problem ? ` (${clip(frame.problem, 120)})` : empty ? ' (empty)' : '';
      const title = frame.title ? ` ${q(frame.title)}` : '';
      push('frame', 0, [`FRAME ${frame.index} ${frame.url || '(no address)'} ${where}${title}${state}`], frame.index);
      walk(frame.outline, 1, frame.index);
    }

    // How far each text and heading is from the nearest field or button of its frame, in lines.
    const anchors = (it) => it.kind === 'field' || it.kind === 'action';
    for (const pass of [items, items.slice().reverse()]) {
      let last = null;
      for (const it of pass) {
        if (last && last.frame !== it.frame) last = null;
        if (anchors(it)) last = it;
        const d = last ? Math.abs(it.index - last.index) : Infinity;
        it.dist = Math.min(it.dist == null ? Infinity : it.dist, d);
      }
    }

    const head = headLines(map);
    const width = (it) => (it.drop ? 0 : it.depth * 2 + it.variants[it.v].length + 1);
    let total = head.reduce((n, l) => n + l.length + 1, 0) + items.reduce((n, it) => n + width(it), 0);
    const cut = { text: 0, blocks: 0, options: 0, links: 0, headings: 0, help: 0 };
    const farthest = (a, b) => b.dist - a.dist || b.variants[0].length - a.variants[0].length || b.index - a.index;
    const drop = (list, key, chars) => {
      for (const it of list) {
        if (total <= max) return;
        total -= width(it);
        it.drop = true;
        cut[key]++;
        if (chars) cut.text += it.chars || 0;
      }
    };
    const shorten = (list, key, v) => {
      for (const it of list) {
        if (total <= max) return;
        if (it.v >= v || it.variants.length <= v || it.variants[v] === it.variants[it.v]) continue;
        const before = width(it);
        it.v = v;
        total -= before - width(it);
        cut[key]++;
      }
    };
    if (total > max) {
      drop(items.filter((it) => it.kind === 'text').sort(farthest), 'blocks', true);
      const fields = items.filter((it) => it.kind === 'field');
      shorten(
        fields.slice().sort((a, b) => b.variants[0].length - a.variants[0].length || a.index - b.index),
        'options',
        1,
      );
      shorten(
        items.filter((it) => it.kind === 'collapsed'),
        'links',
        1,
      );
      drop(items.filter((it) => it.kind === 'heading').sort(farthest), 'headings', false);
      shorten(fields, 'help', 2);
      // A landmark all of whose contents went goes too (inner ones first).
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.kind !== 'landmark' || it.drop) continue;
        let j = i + 1;
        while (j < items.length && items[j].frame === it.frame && items[j].depth > it.depth && items[j].drop) j++;
        const inside = j < items.length && items[j].frame === it.frame && items[j].depth > it.depth;
        if (j > i + 1 && !inside) it.drop = true;
      }
    }

    const notes = [];
    if (cut.blocks) notes.push(`${thousands(cut.text)} chars of page text elided (${cut.blocks} blocks)`);
    if (cut.options) notes.push(`${cut.options} option list${cut.options === 1 ? '' : 's'} cut short`);
    if (cut.links) notes.push(`${cut.links} link list${cut.links === 1 ? '' : 's'} left out`);
    if (cut.headings) notes.push(`${cut.headings} heading${cut.headings === 1 ? '' : 's'} elided`);
    if (cut.help) notes.push(`help text cut on ${cut.help} field${cut.help === 1 ? '' : 's'}`);
    const counts = map.counts || {};
    if (counts.textElided) notes.push(`${thousands(counts.textElided)} chars of page text not mapped (limits)`);
    const stopped = map.frames.filter((f) => f.truncated).map((f) => `frame ${f.index} (${f.truncated})`);
    if (stopped.length) notes.push(`stopped early in ${stopped.join(', ')}: some of the page is not mapped`);
    if (emptyFrames) notes.push(`${emptyFrames} empty frame${emptyFrames === 1 ? '' : 's'} not shown`);

    const lines = head.slice();
    for (const it of items) if (!it.drop) lines.push('  '.repeat(it.depth) + it.variants[it.v]);
    if (notes.length) lines.push(`… ${notes.join('; ')}`);
    return lines.join('\n');
  }

  /** The lines above the outline: the page, its numbers, where it is in a multi-step form, alerts and overlays. */
  function headLines(map) {
    const out = [];
    const widgets = Object.entries(map.widgets || {}).map(([name, n]) => `${name}×${n}`);
    out.push(
      [
        `PAGE ${q(map.title || '')} ${map.url || ''}`.trim(),
        map.lang ? `lang=${map.lang}` : '',
        map.platform ? `platform=${map.platform}` : '',
        widgets.length ? `widgets=${widgets.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('  '),
    );
    const c = map.counts || {};
    const frames = map.frames.length;
    out.push(
      [
        `FIELDS ${map.fields.length} (${c.required || 0} required, ${c.filled || 0} filled, ${c.invalid || 0} invalid)`,
        `ACTIONS ${map.actions.length}`,
        frames > 1 ? `FRAMES ${frames}` : '',
        map.focus ? `FOCUS ${map.focus}` : '',
      ]
        .filter(Boolean)
        .join('  '),
    );
    const p = map.progress;
    if (p) {
      const where = p.step && p.total ? `step ${p.step} of ${p.total}` : p.text || '';
      out.push(`PROGRESS ${where}${p.label && norm(p.label) !== norm(where) ? ' ' + q(p.label) : ''}`.trim());
    }
    const frameOf = (x) => (x.frame ? ` (frame ${x.frame})` : '');
    for (const a of (map.alerts || []).slice(0, ALERTS_SHOWN)) out.push(`ALERT ${q(clip(a.text, 240))}${frameOf(a)}`);
    if ((map.alerts || []).length > ALERTS_SHOWN) out.push(`ALERT … ${map.alerts.length - ALERTS_SHOWN} more`);
    for (const o of map.overlays || [])
      out.push(`OVERLAY ${o.kind}${o.name ? ' ' + q(o.name) : ''}${o.modal ? ' (modal)' : ''}${frameOf(o)}`);
    return out;
  }

  Object.assign(pagemap, { VERSION, MAX_CHARS, merge, render, labels, intentOf, platformOf });
  if (typeof module === 'object' && module.exports) module.exports = pagemap;
})(typeof globalThis !== 'undefined' ? globalThis : this);
