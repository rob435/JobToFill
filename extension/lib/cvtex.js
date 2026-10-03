/*
 * JobToFill — the CV as LaTeX.
 *
 *   cvtex.parse(tex)       → { cv, warnings }   a restricted, forgiving LaTeX → CV model reader; never throws
 *   cvtex.render(cv)       → string             the CV model as a .tex file (compiles in Overleaf)
 *   cvtex.normalize(cv)    → cv                 canonical shape (strings trimmed, empty fields dropped)
 *   cvtex.summarize(cv)    → string[]           one line per section, for showing what was understood
 *   cvtex.escape(text)     → string             plain text → LaTeX text
 *
 * The CV model (the one pdfdoc.cv() draws and letter.tailor() edits):
 *
 *   cv = { name, contact: [item], sections: [section] }
 *   item    = "07386 526574" | "me@example.com" | { text, href }       (emails and bare domains link by themselves)
 *   section = { title, entryGap?, entries: [entry], lines: [{ label?, text }] }
 *   entry   = { heading?, tagline?, right?, subheading?, subright?, text?, bullets?: [string] }
 *
 *   \noindent \textbf{heading} -- tagline \hfill \textit{right} \\
 *   subheading \hfill \textit{subright}
 *   \begin{itemize} \item bullets... \end{itemize}
 *
 * `lines` are the "\noindent \textbf{Label:} text \\" rows of Achievements and Skills. entryGap is the
 * \vspace (pt) between a section's entries (default 4). The template (PREAMBLE) is the user's own LaTeX
 * style: 11pt A4 article, Latin Modern, 0.65in margins, ruled uppercase section titles. Pure JS, no
 * network and no LaTeX install; runs in extension pages and in Node.
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});

  const PREAMBLE = [
    '\\documentclass[11pt,a4paper]{article}',
    '\\usepackage[T1]{fontenc}',
    '\\usepackage{lmodern}',
    '\\usepackage[margin=0.65in]{geometry}',
    '\\usepackage{titlesec}',
    '\\usepackage{enumitem}',
    '\\usepackage[hidelinks]{hyperref}',
    '\\usepackage{microtype}',
    '\\pagenumbering{gobble}',
    '\\titleformat{\\section}{\\large\\bfseries}{}{0pt}{\\MakeUppercase}[\\titlerule]',
    '\\titlespacing{\\section}{0pt}{10pt}{5pt}',
    '\\setlist[itemize]{leftmargin=*, itemsep=1pt, topsep=1pt, parsep=0pt, partopsep=0pt}',
  ].join('\n');

  const DEFAULT_ENTRY_GAP = 4;

  /* ------------------------------------------------------------ shared bits */

  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const DOMAIN = /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i;

  /** The address a contact item links to by itself (an email, a bare domain), or null. */
  function linkFor(item) {
    const s = String(item || '').trim();
    if (EMAIL.test(s)) return `mailto:${s}`;
    if (DOMAIN.test(s) && /[a-z]/i.test(s)) return /^https?:\/\//i.test(s) ? s : `https://${s}`;
    return null;
  }

  const str = (v) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();

  /** Canonical shape: trimmed strings, empty fields dropped, every section with `entries` and `lines`. */
  function normalize(input) {
    const cv = input && typeof input === 'object' ? input : {};
    const item = (c) => {
      if (c && typeof c === 'object') {
        const text = str(c.text);
        const href = str(c.href);
        if (!text) return null;
        return href && href !== linkFor(text) ? { text, href } : text;
      }
      return str(c) || null;
    };
    const entry = (e) => {
      const out = {};
      for (const k of ['heading', 'tagline', 'right', 'subheading', 'subright', 'text']) {
        const v = str(e && e[k]);
        if (v) out[k] = v;
      }
      const bullets = (Array.isArray(e && e.bullets) ? e.bullets : []).map(str).filter(Boolean);
      if (bullets.length) out.bullets = bullets;
      return out;
    };
    const sections = (Array.isArray(cv.sections) ? cv.sections : [])
      .map((s) => {
        const out = { title: str(s && s.title) };
        const gap = s && s.entryGap != null && s.entryGap !== '' ? Number(s.entryGap) : NaN;
        if (Number.isFinite(gap) && gap >= 0 && gap <= 40) out.entryGap = Math.round(gap * 100) / 100;
        out.entries = (Array.isArray(s && s.entries) ? s.entries : []).map(entry).filter((e) => Object.keys(e).length);
        out.lines = (Array.isArray(s && s.lines) ? s.lines : [])
          .map((l) => {
            const text = str(typeof l === 'string' ? l : l && l.text);
            const label = typeof l === 'string' ? '' : str(l && l.label).replace(/:$/, '');
            return label ? { label, text } : { text };
          })
          .filter((l) => l.text);
        return out;
      })
      .filter((s) => s.title || s.entries.length || s.lines.length);
    return {
      name: str(cv.name),
      contact: (Array.isArray(cv.contact) ? cv.contact : []).map(item).filter(Boolean),
      sections,
    };
  }

  /* ----------------------------------------------------------------- parse */

  const ACCENTS = { "'": '́', '`': '̀', '^': '̂', '"': '̈', '~': '̃', '=': '̄', '.': '̇' };
  // prettier-ignore
  const SYMBOLS = {
    textbar: '|', vert: '|', textbullet: '•', bullet: '•', textendash: '–', textemdash: '—', textasciitilde: '~',
    textasciicircum: '^', textbackslash: '\\', textless: '<', textgreater: '>', ldots: '…', dots: '…',
    textellipsis: '…', LaTeX: 'LaTeX', TeX: 'TeX', times: '×', texttimes: '×', cdot: '·', pm: '±', to: '→',
    rightarrow: '→', leftarrow: '←', approx: '≈', geq: '≥', leq: '≤', sim: '~', copyright: '©',
    pounds: '£', textsterling: '£', euro: '€', texteuro: '€', textdegree: '°', textregistered: '®',
    texttrademark: '™', S: '§', ss: 'ß', o: 'ø', O: 'Ø', aa: 'å', AA: 'Å', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ',
    i: 'i', j: 'j', l: 'ł', L: 'Ł', quad: ' ', qquad: ' ', enspace: ' ', space: ' ', thinspace: ' ',
  };
  // Commands that take arguments we throw away.
  // prettier-ignore
  const DROP_ARGS = {
    fontsize: 2, setlength: 2, addtolength: 2, setcounter: 2, rule: 2, textcolor: 1, color: 1, pagecolor: 1,
    thispagestyle: 1, pagestyle: 1, label: 1, ref: 1, pageref: 1, cite: 1, phantom: 1, vphantom: 1, hphantom: 1,
    raisebox: 1, pagenumbering: 1,
  };
  // Layout commands with no effect on the text.
  const IGNORED = new Set(
    (
      'Huge huge LARGE Large large normalsize small footnotesize scriptsize tiny centering raggedright raggedleft ' +
      'relax protect ignorespaces strut null titlerule hrule hline vfill newpage clearpage ' +
      'hyphenpenalty sloppy fussy allowbreak nobreak nolinebreak nopagebreak scshape sffamily ttfamily selectfont'
    ).split(' '),
  );
  const KNOWN_ENVS = new Set(['document', 'center', 'flushleft', 'flushright', 'minipage', 'samepage']);
  const LIST_ENVS = new Set(['itemize', 'enumerate', 'description']);
  const STYLE_ARG = {
    textbf: { b: true },
    textit: { i: true },
    emph: { i: true },
    textsl: { i: true },
    textsc: {},
    textrm: {},
    textsf: {},
    texttt: {},
    textnormal: {},
    textmd: {},
    underline: {},
    mbox: {},
    hbox: {},
    text: {},
    textup: {},
  };

  const DIM = { pt: 1, bp: 1.00375, mm: 2.84526, cm: 28.4526, in: 72.27, pc: 12, em: 10.95, ex: 4.5 };
  /** "4pt", "1mm", "0.5em" → points (null when it isn't a plain length). */
  function parseDim(s) {
    const m = /^\s*(-?\d*\.?\d+)\s*(pt|bp|mm|cm|in|pc|em|ex)?\s*(?:plus.*)?$/i.exec(String(s));
    if (!m) return null;
    return Math.round(parseFloat(m[1]) * DIM[(m[2] || 'pt').toLowerCase()] * 100) / 100;
  }

  /** Text between the braces of the group starting at s[i] === '{'. */
  function group(s, i) {
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (c === '\\') j++;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return { body: s.slice(i + 1, j), end: j + 1 };
    }
    return { body: s.slice(i + 1), end: s.length };
  }

  function stripComments(tex) {
    return String(tex)
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => {
        for (let i = 0, slashes = 0; i < line.length; i++) {
          const c = line[i];
          if (c === '\\') slashes++;
          else {
            if (c === '%' && slashes % 2 === 0) return line.slice(0, i);
            slashes = 0;
          }
        }
        return line;
      })
      .join('\n');
  }

  const SPACE_AFTER_COMMAND = /[ \t]*(?:\n(?![ \t]*\n))?[ \t]*/y;

  /** LaTeX source → flat tokens: text runs with their style, and the structure commands. */
  function lex(src, style, ctx, math, depth) {
    const out = [];
    const st = { ...style };
    const s = String(src);
    let buf = '';
    let i = 0;

    const text = (value) => {
      if (value) out.push({ t: 'text', s: value, b: !!st.b, i: !!st.i, href: st.href || '' });
    };
    const flush = () => {
      if (!buf) return;
      const raw = buf;
      buf = '';
      if (math) return text(raw.replace(/\s+/g, ''));
      raw.split(/\n[ \t]*(?:\n[ \t]*)+/).forEach((part, k) => {
        if (k) out.push({ t: 'par' });
        text(
          part
            .replace(/---/g, '—')
            .replace(/--/g, '–')
            .replace(/``/g, '“')
            .replace(/''/g, '”')
            .replace(/`/g, '‘')
            .replace(/'/g, '’')
            .replace(/~/g, ' ')
            .replace(/\s+/g, ' '),
        );
      });
    };
    const tok = (t) => {
      flush();
      out.push(t);
    };
    const literal = (value) => {
      flush();
      text(value);
    };
    const nested = (body, extra) => {
      flush();
      if (depth > 40) return text(String(body));
      out.push(...lex(body, { ...st, ...extra }, ctx, math, depth + 1));
    };
    const skipSpace = () => {
      SPACE_AFTER_COMMAND.lastIndex = i;
      SPACE_AFTER_COMMAND.test(s);
      i = SPACE_AFTER_COMMAND.lastIndex;
    };
    const arg = () => {
      skipSpace();
      if (s[i] !== '{') return null;
      const g = group(s, i);
      i = g.end;
      return g.body;
    };
    const optional = () => {
      if (s[i] === '[') {
        const end = s.indexOf(']', i);
        if (end > 0) i = end + 1;
      }
    };
    const warn = (msg) => ctx.warnings.add(msg);

    while (i < s.length) {
      const c = s[i];
      if (c === '\\') {
        const d = s[i + 1];
        if (d === undefined) break;
        if (/[A-Za-z]/.test(d)) {
          let j = i + 1;
          while (j < s.length && /[A-Za-z]/.test(s[j])) j++;
          const name = s.slice(i + 1, j);
          i = j;
          if (s[i] === '*' && /^(section|subsection|subsubsection|vspace|hspace)$/.test(name)) i++;
          skipSpace();
          command(name);
        } else {
          i += 2;
          if (d === '\\') {
            if (s[i] === '*') i++;
            optional();
            tok({ t: 'br' });
          } else if ('&%$#_{}'.includes(d)) literal(d);
          else if (d === ' ' || d === '\n' || d === ',' || d === ';' || d === ':' || d === '>') literal(' ');
          else if (d === '|') literal('‖');
          else if (ACCENTS[d]) {
            let base = '';
            if (s[i] === '{') {
              const g = group(s, i);
              i = g.end;
              base = g.body.replace(/^\\([ij])$/, '$1');
            } else if (/[A-Za-z]/.test(s[i] || '')) base = s[i++];
            if (base && d === '~' && !/[A-Za-z]/.test(base)) literal('~');
            else if (base) literal((base + ACCENTS[d]).normalize('NFC'));
            else if (d === '~' || d === '^') literal(d);
          }
          // \- (hyphenation hints), \/ and \! are dropped.
        }
        continue;
      }
      if (c === '{') {
        const g = group(s, i);
        i = g.end;
        nested(g.body, {});
        continue;
      }
      if (c === '}') {
        i++;
        continue;
      }
      if (c === '$' && !math) {
        const double = s[i + 1] === '$';
        const open = i + (double ? 2 : 1);
        let end = open;
        while (end < s.length && !(s[end] === '$' && s[end - 1] !== '\\')) end++;
        if (end >= s.length) {
          buf += c;
          i++;
          continue;
        }
        flush();
        out.push(...lex(s.slice(open, end), st, ctx, true, depth + 1));
        i = end + (double ? 2 : 1);
        continue;
      }
      if (math && (c === '^' || c === '_')) {
        i++;
        continue;
      }
      buf += c;
      i++;
    }
    flush();
    return out;

    /** A \command (its name read, spaces after it skipped). */
    function command(name) {
      if (name === 'section' || name === 'subsection' || name === 'subsubsection') {
        optional();
        const title = arg();
        if (title != null) {
          const inner = lex(title, {}, ctx, false, depth + 1);
          tok({ t: 'section', title: str(inner.map((x) => (x.t === 'text' ? x.s : ' ')).join('')) });
        }
      } else if (name === 'begin' || name === 'end') {
        const env = str(arg());
        if (LIST_ENVS.has(env)) {
          if (name === 'begin') {
            optional();
            tok({ t: 'begin' });
          } else tok({ t: 'end' });
        } else if (!KNOWN_ENVS.has(env)) warn(`Unsupported environment “${env}” was ignored.`);
      } else if (name === 'item') {
        optional();
        tok({ t: 'item' });
      } else if (name === 'noindent') tok({ t: 'noindent' });
      else if (name === 'par') tok({ t: 'par' });
      else if (name === 'newline' || name === 'linebreak') {
        optional();
        tok({ t: 'br' });
      } else if (name === 'hfill' || name === 'hfil' || name === 'dotfill' || name === 'hrulefill') tok({ t: 'hfill' });
      else if (name === 'hspace') {
        const a = arg() || '';
        if (/\\fill/.test(a)) tok({ t: 'hfill' });
        else literal(' ');
      } else if (name === 'vspace' || name === 'vskip') {
        let a = arg();
        if (a == null) {
          const m = /^[^\\\n]*/.exec(s.slice(i));
          a = m ? m[0] : '';
          i += a.length;
        }
        const pt = parseDim(a);
        if (pt == null) warn(`Couldn’t read the spacing “${str(a)}”; ignored.`);
        tok({ t: 'vspace', pt: pt == null ? 0 : pt });
      } else if (name === 'smallskip') tok({ t: 'vspace', pt: 3 });
      else if (name === 'medskip') tok({ t: 'vspace', pt: 6 });
      else if (name === 'bigskip') tok({ t: 'vspace', pt: 12 });
      else if (name === 'href') {
        const url = arg();
        const label = arg();
        if (url == null) return;
        const href = str(url.replace(/\\([%#&_~{}$])/g, '$1'));
        if (label == null) literal(href);
        else nested(label, { href });
      } else if (name === 'url') {
        const url = arg();
        if (url == null) return;
        const href = str(url.replace(/\\([%#&_~{}$])/g, '$1'));
        flush();
        out.push({ t: 'text', s: href, b: !!st.b, i: !!st.i, href });
      } else if (name === 'MakeUppercase' || name === 'uppercase') {
        const body = arg();
        if (body != null) {
          flush();
          out.push(
            ...lex(body, st, ctx, math, depth + 1).map((x) => (x.t === 'text' ? { ...x, s: x.s.toUpperCase() } : x)),
          );
        }
      } else if (STYLE_ARG[name]) {
        const body = arg();
        if (body != null) nested(body, STYLE_ARG[name]);
      } else if (name === 'bfseries') st.b = true;
      else if (name === 'itshape' || name === 'em' || name === 'slshape') st.i = true;
      else if (name === 'normalfont' || name === 'mdseries' || name === 'upshape' || name === 'rmfamily') {
        st.b = false;
        st.i = false;
      } else if (name in SYMBOLS) literal(SYMBOLS[name]);
      else if (name in DROP_ARGS) for (let k = 0; k < DROP_ARGS[name]; k++) arg();
      else if (IGNORED.has(name)) {
        /* no effect on the text */
      } else if (!math) warn(`Unsupported command \\${name} was ignored.`);
    }
  }

  const plain = (runs) => str(runs.map((r) => r.s).join(''));

  /** Tokens → lines, lists, gaps and section starts. */
  function structure(tokens, warnings) {
    const elements = [];
    let cur = { left: [], right: [], hfill: false, noindent: false, afterBr: false };
    let listDepth = 0;
    let list = null;
    let item = null;

    const empty = () => !plain(cur.left) && !plain(cur.right);
    const reset = (afterBr) => {
      cur = { left: [], right: [], hfill: false, noindent: false, afterBr };
    };
    const flushLine = (endedBr) => {
      if (empty()) {
        if (cur.hfill && cur.right.length === 0) cur.hfill = false;
        return false;
      }
      elements.push({ kind: 'line', ...cur, endedBr });
      reset(endedBr);
      return true;
    };
    const boundary = () => {
      flushLine(false);
      cur.afterBr = false;
    };

    for (const t of tokens) {
      if (listDepth > 0) {
        if (t.t === 'begin') {
          listDepth++;
          warnings.add('Nested lists were flattened into one list of bullets.');
        } else if (t.t === 'end') {
          listDepth--;
          if (listDepth === 0) {
            elements.push({ kind: 'list', items: list.map((r) => plain(r)).filter(Boolean) });
            list = null;
            reset(false);
          }
        } else if (t.t === 'item') {
          item = [];
          list.push(item);
        } else if (t.t === 'text') {
          if (item) item.push(t);
          else if (t.s.trim()) {
            item = [t];
            list.push(item);
          }
        } else if (t.t === 'br' || t.t === 'hfill' || t.t === 'par') {
          if (item) item.push({ t: 'text', s: ' ' });
        } else if (t.t === 'section') {
          // A \section inside an unclosed list ends the list.
          listDepth = 0;
          elements.push({ kind: 'list', items: list.map((r) => plain(r)).filter(Boolean) });
          list = null;
          elements.push({ kind: 'section', title: t.title });
          reset(false);
        }
        continue;
      }
      switch (t.t) {
        case 'text':
          (cur.hfill ? cur.right : cur.left).push(t);
          break;
        case 'hfill':
          if (!cur.hfill) cur.hfill = true;
          break;
        case 'br':
          if (!flushLine(true)) cur.afterBr = true;
          break;
        case 'noindent':
          if (!empty()) flushLine(false);
          cur.noindent = true;
          break;
        case 'par':
          boundary();
          break;
        case 'vspace':
          boundary();
          elements.push({ kind: 'gap', pt: t.pt });
          break;
        case 'begin':
          boundary();
          listDepth = 1;
          list = [];
          item = null;
          break;
        case 'item':
          warnings.add('An \\item outside a list was ignored.');
          break;
        case 'section':
          boundary();
          elements.push({ kind: 'section', title: t.title });
          break;
        default:
      }
    }
    if (list) elements.push({ kind: 'list', items: list.map((r) => plain(r)).filter(Boolean) });
    boundary();
    return elements;
  }

  /** A line's bold lead-in and what follows it. */
  function splitBold(runs) {
    let k = 0;
    while (k < runs.length && !plain([runs[k]])) k++;
    let end = k;
    while (end < runs.length && runs[end].b) end++;
    return end > k ? { bold: plain(runs.slice(k, end)), rest: runs.slice(end) } : { bold: '', rest: runs };
  }

  function sectionFrom(title, elements, warnings) {
    const entries = [];
    const lines = [];
    const gaps = [];
    let entry = null;
    let stage = 0; // 0: heading line read, 1: subheading line read
    let pending = null;
    let order = '';
    const startEntry = () => {
      if (entries.length) gaps.push(pending == null ? 0 : pending);
      pending = null;
      entry = {};
      stage = 0;
      entries.push(entry);
      if (!order.endsWith('e')) order += 'e';
    };
    for (const el of elements) {
      if (el.kind === 'gap') {
        pending = el.pt;
      } else if (el.kind === 'list') {
        if (!entry) startEntry();
        entry.bullets = [...(entry.bullets || []), ...el.items];
        stage = 2;
      } else if (el.kind === 'line') {
        const { bold, rest } = splitBold(el.left);
        const label =
          !el.hfill && bold && (/:$/.test(bold) || /^\s*:/.test(plain(rest)))
            ? { label: bold.replace(/:$/, '').trim(), text: plain(rest).replace(/^:\s*/, '') }
            : null;
        const continuing = el.afterBr && !el.noindent && entry && !label;
        if (label) {
          lines.push(label);
          entry = null;
          pending = null;
          if (!order.endsWith('l')) order += 'l';
        } else if (continuing && stage === 0 && !entry.text) {
          const left = plain(el.left);
          if (left) entry.subheading = left;
          if (el.hfill) entry.subright = plain(el.right);
          stage = 1;
        } else if (continuing) {
          const more = [plain(el.left), plain(el.right)].filter(Boolean).join(' ');
          entry.text = [entry.text, more].filter(Boolean).join(' ');
        } else if (el.hfill || bold) {
          startEntry();
          if (bold) {
            entry.heading = bold;
            const tag = plain(rest).replace(/^[\s–—-]+/, '');
            if (tag) {
              entry.tagline = tag;
              if (!/^\s*[–—-]/.test(plain(rest)))
                warnings.add(`Text after the bold heading “${bold}” was kept as its tagline.`);
            }
          } else entry.heading = plain(el.left);
          if (el.hfill) entry.right = plain(el.right);
        } else {
          startEntry();
          entry.text = plain(el.left);
          stage = 1;
        }
      }
    }
    const section = { title, entries, lines };
    if (gaps.length) {
      section.entryGap = gaps[0];
      if (gaps.some((g) => g !== gaps[0]))
        warnings.add(`Section “${title}” spaces its entries unevenly; one spacing (${gaps[0]}pt) is used.`);
    }
    if (order === 'lel' || order === 'le')
      warnings.add(`Section “${title}” mixes rows and entries; entries come first.`);
    return section;
  }

  /** LaTeX → { cv, warnings }. Anything it doesn't understand degrades to plain text (with a warning). */
  function parse(tex) {
    const warnings = new Set();
    let cv = { name: '', contact: [], sections: [] };
    try {
      let body = stripComments(tex);
      const start = body.search(/\\begin\s*\{document\}/);
      if (start >= 0) body = body.slice(start).replace(/^\\begin\s*\{document\}/, '');
      body = body.replace(/\\end\s*\{document\}[\s\S]*$/, '');
      if (!body.trim()) {
        warnings.add('There is no CV text in it.');
        return { cv, warnings: [...warnings] };
      }
      const elements = structure(lex(body, {}, { warnings }, false, 0), warnings);
      const first = elements.findIndex((e) => e.kind === 'section');
      const head = elements.slice(0, first < 0 ? elements.length : first).filter((e) => e.kind === 'line');
      if (head.length) {
        cv.name = plain([...head[0].left, ...head[0].right]);
        const runs = head
          .slice(1)
          .flatMap((l) => [...l.left, { t: 'text', s: ' | ' }, ...l.right, { t: 'text', s: ' | ' }]);
        const contact = [];
        let segment = [];
        const close = () => {
          const text = plain(segment);
          if (text) {
            const link = segment.find((r) => r.href);
            contact.push(link && link.href !== linkFor(text) ? { text, href: link.href } : text);
          }
          segment = [];
        };
        for (const r of runs)
          r.s.split(/\|/).forEach((piece, k) => {
            if (k) close();
            if (piece) segment.push({ ...r, s: piece });
          });
        close();
        cv.contact = contact;
      } else warnings.add('No name was found at the top.');
      if (first < 0) warnings.add('No \\section was found, so the CV has no sections.');
      else {
        const marks = elements.map((e, k) => (e.kind === 'section' ? k : -1)).filter((k) => k >= 0);
        marks.forEach((at, k) => {
          const slice = elements.slice(at + 1, k + 1 < marks.length ? marks[k + 1] : elements.length);
          cv.sections.push(sectionFrom(elements[at].title, slice, warnings));
        });
      }
      for (const el of elements.slice(0, first < 0 ? 0 : first))
        if (el.kind === 'list') warnings.add('A list before the first section was ignored.');
      cv = normalize(cv);
      if (!cv.sections.length && first >= 0) warnings.add('The sections are empty.');
    } catch (err) {
      warnings.add(`Couldn’t fully read it (${err.message}).`);
      cv = normalize(cv);
    }
    return { cv, warnings: [...warnings] };
  }

  /* ---------------------------------------------------------------- render */

  /** Plain text → LaTeX text. */
  function escape(value) {
    return String(value == null ? '' : value)
      .replace(/\\/g, '\uE000')
      .replace(/[&%$#_{}]/g, (c) => `\\${c}`)
      .replace(/~/g, '\\textasciitilde{}')
      .replace(/\^/g, '\\textasciicircum{}')
      .replace(/\uE000/g, '\\textbackslash{}')
      .replace(/-(?=-)/g, '-{}')
      .replace(/\u2014/g, '---')
      .replace(/\u2013/g, '--')
      .replace(/\u201c/g, '``')
      .replace(/\u201d/g, "''")
      .replace(/\u2018/g, '`')
      .replace(/\u2019/g, "'")
      .replace(/\u00a0/g, '~')
      .replace(/\s+/g, ' ')
      .trim();
  }
  const escUrl = (u) => String(u).replace(/[%#&{}]/g, (c) => `\\${c}`);
  const lead = (s) => (/^[[*]/.test(s) ? `{}${s}` : s);

  function renderEntry(e) {
    const left = [];
    if (e.heading) left.push(`\\textbf{${escape(e.heading)}}`);
    if (e.tagline) left.push(`${e.heading ? '-- ' : ''}${escape(e.tagline)}`);
    const rows = [];
    if (left.length || e.right)
      rows.push(
        `\\noindent ${[left.join(' '), e.right ? `\\hfill \\textit{${escape(e.right)}}` : ''].filter(Boolean).join(' ')}`,
      );
    if (e.subheading || e.subright) {
      const row = [lead(escape(e.subheading || '')), e.subright ? `\\hfill \\textit{${escape(e.subright)}}` : '']
        .filter(Boolean)
        .join(' ');
      rows.push(rows.length ? row : `\\noindent ${row}`);
    }
    if (e.text) rows.push(rows.length ? lead(escape(e.text)) : `\\noindent ${escape(e.text)}`);
    const out = [rows.join(' \\\\\n')];
    if (e.bullets && e.bullets.length)
      out.push('\\begin{itemize}', ...e.bullets.map((b) => `    \\item ${lead(escape(b))}`), '\\end{itemize}');
    return out.filter(Boolean).join('\n');
  }

  /** The CV model as a complete .tex file. */
  function render(input) {
    const cv = normalize(input);
    const out = [PREAMBLE, '\\begin{document}', '\\noindent'];
    out.push(`{\\Huge \\textbf{${escape(cv.name)}}}${cv.contact.length ? ' \\\\[3pt]' : ''}`);
    if (cv.contact.length)
      out.push(
        cv.contact
          .map((c) => {
            const text = typeof c === 'string' ? c : c.text;
            const href = typeof c === 'string' ? linkFor(c) : c.href;
            return href ? `\\href{${escUrl(href)}}{${escape(text)}}` : escape(text);
          })
          .join(' \\ $|$ \\ '),
      );
    for (const s of cv.sections) {
      out.push(`\\section{${escape(s.title)}}`);
      const gap = s.entryGap == null ? DEFAULT_ENTRY_GAP : s.entryGap;
      s.entries.forEach((e, k) => {
        if (k && gap > 0) out.push(`\\vspace{${gap}pt}`);
        out.push(renderEntry(e));
      });
      if (s.lines.length)
        out.push(
          s.lines
            .map((l) => `\\noindent ${l.label ? `\\textbf{${escape(l.label)}:} ` : ''}${escape(l.text)}`)
            .join(' \\\\\n'),
        );
    }
    out.push('\\end{document}');
    return out.join('\n') + '\n';
  }

  /** What was understood, one line per part, for showing next to the pasted LaTeX. */
  function summarize(input) {
    const cv = normalize(input);
    const out = [];
    out.push(`Name: ${cv.name || '(none found)'}`);
    out.push(`Contact: ${cv.contact.map((c) => (typeof c === 'string' ? c : c.text)).join(' | ') || '(none found)'}`);
    for (const s of cv.sections) {
      const bullets = s.entries.reduce((n, e) => n + (e.bullets ? e.bullets.length : 0), 0);
      const parts = [];
      if (s.entries.length) parts.push(`${s.entries.length} ${s.entries.length === 1 ? 'entry' : 'entries'}`);
      if (bullets) parts.push(`${bullets} bullet${bullets === 1 ? '' : 's'}`);
      if (s.lines.length) parts.push(`${s.lines.length} row${s.lines.length === 1 ? '' : 's'}`);
      out.push(`${s.title}: ${parts.join(', ') || 'empty'}`);
    }
    return out;
  }

  const cvtex = { PREAMBLE, DEFAULT_ENTRY_GAP, parse, render, normalize, summarize, escape, linkFor };
  JTF.cvtex = cvtex;
  if (typeof module === 'object' && module.exports) module.exports = cvtex;
})(typeof globalThis !== 'undefined' ? globalThis : this);
