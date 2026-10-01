/*
 * JobToFill — text extraction from the user's CV (PDF, DOCX, ODT, plain text).
 * Classic script with no dependencies: runs in extension pages and Node tests.
 * Only standard web APIs are used (DecompressionStream, TextDecoder, crypto.subtle).
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});

  // Hard caps so a hostile or broken file can never hang the page.
  const MAX_OBJECTS = 200000;
  const MAX_OPS = 3000000;
  const MAX_XOBJ_DEPTH = 8;
  const MAX_PAGES = 400;

  const fail = (msg) => {
    const e = new Error(msg);
    e.userFacing = true;
    return e;
  };
  const MSG = {
    corrupt: 'This file appears to be damaged and could not be read.',
    doc: 'Old Word .doc files are not supported. Please save it as .docx or PDF and upload that instead.',
    scanned:
      'This PDF has no text layer (it looks scanned or image-only). Please upload a PDF exported from your editor, or a .docx.',
    password: 'This PDF is password-protected. Please remove the password and upload it again.',
    unsupported: 'Unsupported file type. Please upload a PDF, .docx, .odt or plain-text file.',
    empty: 'This file is empty.',
  };

  // ---------------------------------------------------------------- bytes

  function toBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    throw fail(MSG.corrupt);
  }

  function concat(chunks, total) {
    if (chunks.length === 1) return chunks[0];
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }

  /** Binary string (one char per byte) for regex scans and PDF strings. */
  function bin(bytes, start = 0, end = bytes.length) {
    let s = '';
    for (let i = start; i < end; i += 8192) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(end, i + 8192)));
    }
    return s;
  }

  const utf8 = new TextDecoder('utf-8');

  /**
   * Inflate with DecompressionStream. It rejects on truncation or trailing
   * garbage (common in real PDFs), so we keep whatever was decoded before that.
   */
  async function inflate(bytes, raw) {
    const ds = new DecompressionStream(raw ? 'deflate-raw' : 'deflate');
    const writer = ds.writable.getWriter();
    writer.write(bytes).catch(() => {});
    writer.close().catch(() => {});
    const reader = ds.readable.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
      }
    } catch (err) {
      if (!total) throw err;
    }
    return concat(chunks, total);
  }

  async function inflateLenient(bytes) {
    try {
      return await inflate(bytes, false);
    } catch {
      // Some writers omit the zlib header; try raw deflate (skipping a bad header).
      try {
        return await inflate(bytes, true);
      } catch {
        return await inflate(bytes.subarray(2), true).catch(() => new Uint8Array(0));
      }
    }
  }

  // ---------------------------------------------------------------- formats

  function startsWith(b, sig, at = 0) {
    for (let i = 0; i < sig.length; i++) if (b[at + i] !== sig.charCodeAt(i)) return false;
    return true;
  }

  function indexOfStr(b, str, from = 0, to = b.length) {
    const c0 = str.charCodeAt(0);
    outer: for (let i = from; i <= to - str.length; i++) {
      if (b[i] !== c0) continue;
      for (let j = 1; j < str.length; j++) if (b[i + j] !== str.charCodeAt(j)) continue outer;
      return i;
    }
    return -1;
  }

  function lastIndexOfStr(b, str, from = b.length - str.length) {
    for (let i = Math.min(from, b.length - str.length); i >= 0; i--) {
      if (startsWith(b, str, i)) return i;
    }
    return -1;
  }

  async function extract(input, opts = {}) {
    try {
      return await detectAndExtract(toBytes(input), opts);
    } catch (err) {
      if (err && err.userFacing) throw err;
      // Anything unexpected means the file is not what it claims to be.
      const e = fail(MSG.corrupt);
      e.cause = err;
      throw e;
    }
  }

  async function detectAndExtract(bytes, opts) {
    const type = String(opts.type || '').toLowerCase();
    const name = String(opts.name || '').toLowerCase();
    const ext = (name.match(/\.([a-z0-9]+)$/) || [])[1] || '';
    if (!bytes.length) throw fail(MSG.empty);

    // Magic bytes first; the declared type and extension are often wrong.
    const head = indexOfStr(bytes, '%PDF-', 0, Math.min(bytes.length, 1024));
    if (head >= 0) return finish(await pdfText(bytes, head));
    if (startsWith(bytes, 'PK\x03\x04') || startsWith(bytes, 'PK\x05\x06')) return finish(await zipText(bytes));
    if (startsWith(bytes, '\xd0\xcf\x11\xe0')) throw fail(MSG.doc);
    if (startsWith(bytes, '{\\rtf')) return finish({ text: rtfText(bin(bytes)), kind: 'text', pages: 1, warnings: [] });

    if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
      // UTF-16 text (Windows Notepad "Unicode").
      const text = new TextDecoder(bytes[0] === 0xff ? 'utf-16le' : 'utf-16be').decode(bytes.subarray(2));
      return finish({ text, kind: 'text', pages: 1, warnings: [] });
    }
    if (type === 'application/pdf' || ext === 'pdf') throw fail(MSG.corrupt);
    if (/wordprocessingml|opendocument/.test(type) || ext === 'docx' || ext === 'odt') throw fail(MSG.corrupt);
    if (type === 'application/msword' || ext === 'doc') throw fail(MSG.doc);
    if (looksLikeText(bytes) || /^text\//.test(type) || /^(txt|md|markdown|text)$/.test(ext)) {
      let text = utf8.decode(bytes).replace(/^\uFEFF/, '');
      if (/html?$/.test(ext) || type === 'text/html') text = htmlText(text);
      return finish({ text, kind: 'text', pages: 1, warnings: [] });
    }
    throw fail(MSG.unsupported);
  }

  function looksLikeText(bytes) {
    const n = Math.min(bytes.length, 4096);
    for (let i = 0; i < n; i++) {
      const c = bytes[i];
      if (c < 9 || (c > 13 && c < 27)) return false; // NUL and other controls: binary
    }
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
      return true;
    } catch (err) {
      // A cut-off multi-byte sequence at the 64 KB boundary is still text.
      return bytes.length > 65536 && /truncat|incomplete/i.test(String(err && err.message));
    }
  }

  async function fromDataUrl(dataUrl, opts = {}) {
    const m = /^data:([^,]*?),/i.exec(String(dataUrl || ''));
    if (!m) throw fail(MSG.corrupt);
    const meta = m[1];
    const payload = String(dataUrl).slice(m[0].length);
    let bytes;
    if (/;base64$/i.test(meta)) {
      let s;
      try {
        s = atob(
          payload
            .replace(/[^A-Za-z0-9+/=_-]/g, '')
            .replace(/-/g, '+')
            .replace(/_/g, '/'),
        );
      } catch {
        throw fail(MSG.corrupt);
      }
      bytes = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    } else {
      // Percent-encoded payload: %XX are raw bytes, everything else is UTF-8 text.
      const out = [];
      const enc = new TextEncoder();
      for (const part of payload.split(/(%[0-9a-f]{2})/i)) {
        if (/^%[0-9a-f]{2}$/i.test(part)) out.push(parseInt(part.slice(1), 16));
        else if (part) out.push(...enc.encode(part));
      }
      bytes = Uint8Array.from(out);
    }
    const type = opts.type || meta.replace(/;base64$/i, '').split(';')[0];
    return extract(bytes, { ...opts, type });
  }

  // ---------------------------------------------------------------- normalise

  function finish(out) {
    out.text = normalizeText(out.text);
    if (!out.text && out.kind !== 'text')
      throw fail(out.kind === 'pdf' ? MSG.scanned : 'This document contains no text.');
    return out;
  }

  // Marks a wide horizontal gap (columns, right-aligned dates); becomes three spaces after collapsing.
  const GAP = '\ue000';

  function normalizeText(text) {
    const t = String(text || '')
      .replace(/\r\n?/g, '\n')
      .replace(/\u00ad[ \t]*\n[ \t]*/g, '') // soft hyphen at a line break joins the word
      .replace(/\u00ad/g, '')
      .normalize('NFKC')
      .replace(/\u200b|\u200c|\u200d|\u2060|\ufeff/g, '')
      .replace(/[^\S\n\t]+/g, ' ')
      .replace(/ ?\ue000[ \ue000]*/g, '   ')
      .replace(/[ \t]+$/gm, '')
      .replace(/^ +/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return dehyphenate(t);
  }

  // Words that usually start a real compound ("second-year", "self-taught") when broken at a line end.
  const COMPOUND =
    /^(self|well|second|first|third|final|full|part|long|short|high|low|real|non|cross|multi|end|open|state|world|year|time|data|team|user|client|hands|problem|detail|fast|one|two|three|four|five|six|best|co|e|front|back|cutting|top|fine|half|life|mid|semi|ex|up|post|pre|sub|test|cost|sales|people|market|object|event|anti|large|small|big|all)$/i;

  /**
   * Re-joins words split across lines: "com-\nmercial" -> "commercial" (as pdftotext does),
   * but keeps the hyphen for likely compounds ("second-\nyear" -> "second-year").
   */
  function dehyphenate(text) {
    if (!/\p{L}-\n\p{Ll}/u.test(text)) return text;
    const hyphenated = new Set((text.match(/\p{L}+-\p{L}+/gu) || []).map((w) => w.toLowerCase()));
    return text.replace(/(\p{L}+)-\n(\p{Ll}\S*)( ?)/gu, (m, a, b, sp) => {
      const word = COMPOUND.test(a) || hyphenated.has((a + '-' + b).toLowerCase()) ? `${a}-${b}` : a + b;
      return sp ? word + '\n' : word;
    });
  }

  function htmlText(html) {
    return decodeEntities(
      html
        .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
        .replace(/<li\b[^>]*>/gi, '• ')
        .replace(/<[^>]+>/g, ''),
    );
  }

  function rtfText(s) {
    // Minimal RTF: drop control groups we cannot show, map \par/\tab, decode \'xx.
    let out = '';
    let depth = 0;
    const skipAt = [];
    const re = /\\([a-z]+)(-?\d+)? ?|\\'([0-9a-f]{2})|\\([{}\\])|([{}])|([^\\{}\r\n]+)/gi;
    let m;
    while ((m = re.exec(s))) {
      const skipping = skipAt.length > 0;
      if (m[5] === '{') depth++;
      else if (m[5] === '}') {
        if (skipAt.length && skipAt[skipAt.length - 1] === depth) skipAt.pop();
        depth--;
      } else if (m[1]) {
        const w = m[1];
        if (/^(fonttbl|colortbl|stylesheet|info|pict|object|header|footer|themedata|datastore|xmlnstbl)$/.test(w))
          skipAt.push(depth);
        else if (!skipping && (w === 'par' || w === 'line')) out += '\n';
        else if (!skipping && w === 'tab') out += '\t';
        else if (!skipping && w === 'u' && m[2]) out += String.fromCharCode((+m[2] + 65536) % 65536);
      } else if (!skipping && m[3]) out += WIN_ANSI[parseInt(m[3], 16)] || '';
      else if (!skipping && m[4]) out += m[4];
      else if (!skipping && m[6]) out += m[6];
    }
    return out;
  }

  // ---------------------------------------------------------------- zip / docx / odt

  function u16(b, o) {
    return b[o] | (b[o + 1] << 8);
  }
  function u32(b, o) {
    return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  }

  /** Lists zip entries from the central directory (falls back to local headers). */
  function zipEntries(b) {
    const entries = new Map();
    let eocd = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
      if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 5 && b[i + 3] === 6) {
        eocd = i;
        break;
      }
    }
    if (eocd >= 0) {
      const count = u16(b, eocd + 10);
      let p = u32(b, eocd + 16);
      for (let n = 0; n < count && p + 46 <= b.length && u32(b, p) === 0x02014b50; n++) {
        const method = u16(b, p + 10);
        const csize = u32(b, p + 20);
        const nameLen = u16(b, p + 28);
        const extraLen = u16(b, p + 30);
        const commentLen = u16(b, p + 32);
        const local = u32(b, p + 42);
        const name = utf8.decode(b.subarray(p + 46, p + 46 + nameLen));
        entries.set(name, { method, csize, local });
        p += 46 + nameLen + extraLen + commentLen;
      }
    }
    if (!entries.size) {
      // Damaged central directory: walk the local file headers instead.
      let p = 0;
      while (p + 30 <= b.length && u32(b, p) === 0x04034b50) {
        const method = u16(b, p + 8);
        const csize = u32(b, p + 18);
        const nameLen = u16(b, p + 26);
        const extraLen = u16(b, p + 28);
        const name = utf8.decode(b.subarray(p + 30, p + 30 + nameLen));
        entries.set(name, { method, csize, local: p });
        if (!csize) break;
        p += 30 + nameLen + extraLen + csize;
      }
    }
    return entries;
  }

  async function zipRead(b, entries, name) {
    const e = entries.get(name);
    if (!e) return null;
    const p = e.local;
    if (u32(b, p) !== 0x04034b50) throw fail(MSG.corrupt);
    const start = p + 30 + u16(b, p + 26) + u16(b, p + 28);
    const data = b.subarray(start, Math.min(b.length, start + e.csize));
    if (e.method === 0) return data;
    if (e.method === 8) return inflate(data, true);
    throw fail(MSG.corrupt);
  }

  async function zipText(b) {
    const entries = zipEntries(b);
    if (entries.has('word/document.xml')) {
      const warnings = [];
      const parts = [];
      const read = async (n) => {
        const data = await zipRead(b, entries, n);
        return data ? utf8.decode(data) : '';
      };
      const rels = await read('word/_rels/document.xml.rels');
      const headerFiles = [...rels.matchAll(/Target="([^"]*(header)\d*\.xml)"/g)].map((m) => m[1]);
      const footerFiles = [...rels.matchAll(/Target="([^"]*(footer)\d*\.xml)"/g)].map((m) => m[1]);
      const seen = new Set();
      const extra = async (files) => {
        let s = '';
        for (const f of files) {
          const t = docxXmlText(await read('word/' + f.replace(/^\/?word\//, ''))).trim();
          if (t && /\p{L}/u.test(t) && !seen.has(t)) {
            seen.add(t);
            s += t + '\n';
          }
        }
        return s;
      };
      parts.push(await extra(headerFiles));
      parts.push(docxXmlText(await read('word/document.xml')));
      parts.push(await extra(footerFiles));
      return { text: parts.filter(Boolean).join('\n'), kind: 'docx', pages: 1, warnings };
    }
    if (entries.has('content.xml')) {
      const xml = utf8.decode(await zipRead(b, entries, 'content.xml'));
      return { text: odtXmlText(xml), kind: 'docx', pages: 1, warnings: [] };
    }
    throw fail(MSG.unsupported);
  }

  function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos|nbsp);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
      }
      return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: '\u00a0' }[e.toLowerCase()];
    });
  }

  /**
   * WordprocessingML → text. Paragraphs become lines; table cells are joined
   * with tabs row by row; numbered/bulleted paragraphs get a "• " prefix.
   */
  function docxXmlText(xml) {
    const lines = [];
    const tagRe = /<(\/?)([\w.]+:)?([\w.]+)([^>]*?)(\/?)>|([^<]+)/g;
    // The WordprocessingML namespace is almost always bound to "w:", but not necessarily.
    const nsm =
      /xmlns:(\w+)="http:\/\/(?:schemas\.openxmlformats\.org\/wordprocessingml\/2006\/main|purl\.oclc\.org\/ooxml\/wordprocessingml\/main)"/.exec(
        xml.slice(0, 5000),
      );
    const W = (nsm ? nsm[1] : 'w') + ':';
    let para = null; // current paragraph text
    let inTabs = false;
    const paraStack = [];
    let skip = 0; // inside w:del, mc:Fallback, w:instrText …
    let inText = false;
    const rows = []; // stack of { cells: [], cell: [] } for nested tables
    const pushLine = (s) => {
      if (rows.length && rows[rows.length - 1].cell) rows[rows.length - 1].cell.push(s);
      else lines.push(s);
    };
    let m;
    while ((m = tagRe.exec(xml))) {
      if (m[6] !== undefined) {
        if (inText && !skip && para) para.text += decodeEntities(m[6]);
        continue;
      }
      const close = m[1] === '/';
      const selfClose = m[5] === '/';
      const ns = m[2] || '';
      const tag = m[3];
      const attrs = m[4];
      if (ns === 'mc:' && tag === 'Fallback') {
        if (!selfClose) skip += close ? -1 : 1;
        continue;
      }
      if (ns !== W) continue;
      if (tag === 'del' || tag === 'instrText' || tag === 'delText' || tag === 'moveFrom') {
        if (!selfClose) skip += close ? -1 : 1;
        continue;
      }
      if (skip) continue;
      switch (tag) {
        case 'p':
          if (selfClose) pushLine('');
          else if (!close) {
            if (para) paraStack.push(para);
            para = { text: '', list: false };
          } else if (para) {
            pushLine((para.list && para.text.trim() ? '• ' : '') + para.text);
            para = paraStack.pop() || null;
          }
          break;
        case 't':
          inText = !close && !selfClose;
          break;
        case 'numPr':
          if (para && !close) para.list = true;
          break;
        case 'tabs':
          if (!selfClose) inTabs = !close; // tab-stop definitions, not tab characters
          break;
        case 'tab':
          if (para && !close && !inTabs) para.text += '\t';
          break;
        case 'br':
        case 'cr':
          if (para && !close) para.text += '\n';
          break;
        case 'noBreakHyphen':
          if (para && !close) para.text += '-';
          break;
        case 'sym':
          if (para && !close) {
            const c = /w:char="([0-9A-Fa-f]+)"/.exec(attrs);
            const code = c ? parseInt(c[1], 16) : 0;
            // Symbol-font bullets live in the private-use area F0xx.
            if (code >= 0xf000) para.text += code === 0xf0b7 || code === 0xf0a7 ? '•' : '';
            else if (code) para.text += String.fromCharCode(code);
          }
          break;
        case 'tr':
          if (!close && !selfClose) rows.push({ cells: [], cell: null });
          else if (close && rows.length) {
            const row = rows.pop();
            const line = row.cells.join('\t');
            if (line.trim()) pushLine(line);
          }
          break;
        case 'tc':
          if (rows.length) {
            const row = rows[rows.length - 1];
            if (!close && !selfClose) row.cell = [];
            else if (close && row.cell) {
              row.cells.push(
                row.cell
                  .map((s) => s.trim())
                  .filter(Boolean)
                  .join(' '),
              );
              row.cell = null;
            }
          }
          break;
      }
    }
    return lines.join('\n');
  }

  /** OpenDocument text: paragraphs, headings, list items, tabs, spaces, tables. */
  function odtXmlText(xml) {
    const body = xml.slice(Math.max(0, xml.indexOf('<office:body')));
    const lines = [];
    const tagRe = /<(\/?)([\w.]+:)?([\w.-]+)([^>]*?)(\/?)>|([^<]+)/g;
    let para = null;
    const stack = [];
    let listDepth = 0;
    let skip = 0;
    const rows = [];
    const pushLine = (s) => {
      if (rows.length && rows[rows.length - 1].cell) rows[rows.length - 1].cell.push(s);
      else lines.push(s);
    };
    let m;
    while ((m = tagRe.exec(body))) {
      if (m[6] !== undefined) {
        if (para && !skip) para.text += decodeEntities(m[6]);
        continue;
      }
      const close = m[1] === '/';
      const selfClose = m[5] === '/';
      const key = (m[2] || '') + m[3];
      if (key === 'text:note-citation' || key === 'office:annotation' || key === 'text:tracked-changes') {
        if (!selfClose) skip += close ? -1 : 1;
        continue;
      }
      if (skip) continue;
      switch (key) {
        case 'text:p':
        case 'text:h':
          if (selfClose) pushLine('');
          else if (!close) {
            if (para) stack.push(para);
            para = { text: '', list: listDepth > 0 && !stack.length };
          } else if (para) {
            pushLine((para.list && para.text.trim() ? '• ' : '') + para.text);
            para = stack.pop() || null;
          }
          break;
        case 'text:list-item':
          listDepth += close ? -1 : selfClose ? 0 : 1;
          break;
        case 'text:tab':
          if (para) para.text += '\t';
          break;
        case 'text:line-break':
          if (para) para.text += '\n';
          break;
        case 'text:s':
          if (para) para.text += ' '.repeat(Math.min(100, +((/text:c="(\d+)"/.exec(m[4]) || [])[1] || 1)));
          break;
        case 'table:table-row':
          if (!close && !selfClose) rows.push({ cells: [], cell: null });
          else if (close && rows.length) {
            const line = rows.pop().cells.join('\t');
            if (line.trim()) pushLine(line);
          }
          break;
        case 'table:table-cell':
          if (rows.length) {
            const row = rows[rows.length - 1];
            if (!close && !selfClose) row.cell = [];
            else if (close && row.cell) {
              row.cells.push(
                row.cell
                  .map((s) => s.trim())
                  .filter(Boolean)
                  .join(' '),
              );
              row.cell = null;
            }
          }
          break;
      }
    }
    return lines.join('\n');
  }

  // ---------------------------------------------------------------- PDF objects

  class PStr {
    constructor(v) {
      this.v = v; // binary string
    }
  }
  class Ref {
    constructor(num, gen) {
      this.num = num;
      this.gen = gen;
    }
  }
  class Op {
    constructor(name) {
      this.name = name;
    }
  }
  class Stream {
    constructor(dict, raw, num, gen) {
      this.dict = dict;
      this.raw = raw;
      this.num = num;
      this.gen = gen;
    }
  }
  const EOF = new Op('%EOF');
  const opCache = new Map();
  const opOf = (name) => {
    let o = opCache.get(name);
    if (!o) opCache.set(name, (o = new Op(name)));
    return o;
  };

  const WS = new Uint8Array(256);
  for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
  const DELIM = new Uint8Array(256);
  for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;
  const HEXV = new Int8Array(256).fill(-1);
  for (let i = 0; i < 16; i++) {
    HEXV['0123456789abcdef'.charCodeAt(i)] = i;
    HEXV['0123456789ABCDEF'.charCodeAt(i)] = i;
  }

  /**
   * Tokenizer + object parser for both file objects and content streams.
   * Names come back as '/Name' strings, strings as PStr, keywords as Op.
   */
  class Lexer {
    constructor(b, p = 0, refs = true) {
      this.b = b;
      this.p = p;
      this.refs = refs;
      this.depth = 0;
    }
    ws() {
      const b = this.b;
      let p = this.p;
      for (;;) {
        while (p < b.length && WS[b[p]]) p++;
        if (b[p] === 0x25) while (p < b.length && b[p] !== 10 && b[p] !== 13) p++;
        else break;
      }
      this.p = p;
    }
    read() {
      this.ws();
      const b = this.b;
      if (this.p >= b.length) return EOF;
      const c = b[this.p];
      if (c === 0x5b) {
        this.p++;
        if (++this.depth > 100) throw fail(MSG.corrupt);
        const arr = [];
        for (;;) {
          this.ws();
          if (this.p >= b.length) break;
          if (b[this.p] === 0x5d) {
            this.p++;
            break;
          }
          const v = this.read();
          if (v === EOF) break;
          if (v instanceof Op && (v.name === 'endobj' || v.name === 'stream')) {
            this.p -= v.name.length; // broken array: let the caller see the keyword
            break;
          }
          arr.push(v);
        }
        this.depth--;
        return arr;
      }
      if (c === 0x3c) {
        if (b[this.p + 1] !== 0x3c) return this.hex();
        this.p += 2;
        if (++this.depth > 100) throw fail(MSG.corrupt);
        const d = Object.create(null);
        for (;;) {
          this.ws();
          if (this.p >= b.length) break;
          if (b[this.p] === 0x3e) {
            this.p += b[this.p + 1] === 0x3e ? 2 : 1;
            break;
          }
          const k = this.read();
          if (k === EOF) break;
          if (k instanceof Op && (k.name === 'endobj' || k.name === 'stream')) {
            this.p -= k.name.length;
            break;
          }
          if (typeof k !== 'string' || k[0] !== '/') continue;
          this.ws();
          if (b[this.p] === 0x3e && b[this.p + 1] === 0x3e) {
            d[k.slice(1)] = null;
            continue;
          }
          const v = this.read();
          if (v === EOF) break;
          d[k.slice(1)] = v;
        }
        this.depth--;
        return d;
      }
      if (c === 0x28) return this.literal();
      if (c === 0x2f) return this.name();
      if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) return this.number();
      if (DELIM[c]) {
        this.p++; // stray ) > ] { }
        return this.read();
      }
      let e = this.p;
      while (e < b.length && !WS[b[e]] && !DELIM[b[e]]) e++;
      const word = bin(b, this.p, e);
      this.p = e;
      if (word === 'true') return true;
      if (word === 'false') return false;
      if (word === 'null') return null;
      return opOf(word);
    }
    number() {
      const b = this.b;
      let p = this.p;
      let neg = false;
      if (b[p] === 0x2b || b[p] === 0x2d) {
        neg = b[p] === 0x2d;
        p++;
        while (b[p] === 0x2d || b[p] === 0x2b) p++; // "--5" from sloppy writers
      }
      let v = 0;
      let frac = 0;
      let scale = 1;
      let isInt = true;
      for (; p < b.length; p++) {
        const c = b[p];
        if (c >= 0x30 && c <= 0x39) {
          if (isInt) v = v * 10 + (c - 0x30);
          else {
            scale /= 10;
            frac += (c - 0x30) * scale;
          }
        } else if (c === 0x2e && isInt) isInt = false;
        else break;
      }
      this.p = p;
      const num = neg ? -(v + frac) : v + frac;
      if (this.refs && isInt && !neg) {
        // Look ahead for "gen R".
        const save = this.p;
        let q = p;
        while (WS[b[q]]) q++;
        let g = 0;
        const gs = q;
        while (b[q] >= 0x30 && b[q] <= 0x39) g = g * 10 + (b[q++] - 0x30);
        if (q > gs) {
          while (WS[b[q]]) q++;
          if (b[q] === 0x52 && (q + 1 >= b.length || WS[b[q + 1]] || DELIM[b[q + 1]])) {
            this.p = q + 1;
            return new Ref(num, g);
          }
        }
        this.p = save;
      }
      return num;
    }
    name() {
      const b = this.b;
      let p = this.p + 1;
      let s = '/';
      while (p < b.length && !WS[b[p]] && !DELIM[b[p]]) {
        if (b[p] === 0x23 && HEXV[b[p + 1]] >= 0 && HEXV[b[p + 2]] >= 0) {
          s += String.fromCharCode(HEXV[b[p + 1]] * 16 + HEXV[b[p + 2]]);
          p += 3;
        } else s += String.fromCharCode(b[p++]);
      }
      this.p = p;
      return s;
    }
    hex() {
      const b = this.b;
      let p = this.p + 1;
      const out = [];
      let hi = -1;
      for (; p < b.length && b[p] !== 0x3e; p++) {
        const v = HEXV[b[p]];
        if (v < 0) continue;
        if (hi < 0) hi = v;
        else {
          out.push(hi * 16 + v);
          hi = -1;
        }
      }
      if (hi >= 0) out.push(hi * 16);
      this.p = p + 1;
      return new PStr(bin(Uint8Array.from(out)));
    }
    literal() {
      const b = this.b;
      let p = this.p + 1;
      let depth = 1;
      const out = [];
      while (p < b.length) {
        let c = b[p++];
        if (c === 0x28) depth++;
        else if (c === 0x29) {
          if (--depth === 0) break;
        } else if (c === 0x5c) {
          c = b[p++];
          switch (c) {
            case 0x6e:
              out.push(10);
              continue;
            case 0x72:
              out.push(13);
              continue;
            case 0x74:
              out.push(9);
              continue;
            case 0x62:
              out.push(8);
              continue;
            case 0x66:
              out.push(12);
              continue;
            case 0x0d:
              if (b[p] === 0x0a) p++;
              continue;
            case 0x0a:
              continue;
          }
          if (c >= 0x30 && c <= 0x37) {
            let v = c - 0x30;
            for (let k = 0; k < 2 && b[p] >= 0x30 && b[p] <= 0x37; k++) v = v * 8 + (b[p++] - 0x30);
            out.push(v & 255);
            continue;
          }
          if (c === undefined) break;
          out.push(c);
          continue;
        } else if (c === 0x0d) {
          if (b[p] === 0x0a) p++;
          c = 0x0a;
        }
        out.push(c);
      }
      this.p = p;
      return new PStr(bin(Uint8Array.from(out)));
    }
  }

  // ---------------------------------------------------------------- PDF document

  const isDict = (v) =>
    v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    !(v instanceof PStr) &&
    !(v instanceof Ref) &&
    !(v instanceof Stream) &&
    !(v instanceof Op);

  class PdfDoc {
    constructor(bytes) {
      this.b = bytes;
      this.xref = new Map(); // num -> { type: 1, off, gen } | { type: 2, stm, idx }
      this.cache = new Map();
      this.objStms = new Map();
      this.trailer = Object.create(null);
      this.crypt = null;
      this.warnings = [];
      this.fetches = 0;
    }

    async init() {
      let ok;
      try {
        ok = await this.readXrefChain();
      } catch {
        ok = false;
      }
      if (!ok || !this.trailer.Root) await this.scanObjects();
      if (this.trailer.Encrypt) await this.setupCrypt();
      this.root = await this.get(this.trailer.Root);
      if (!isDict(this.root) || !this.root.Pages) {
        // xref pointed somewhere wrong; rebuild from a full scan once.
        if (!this.scanned) {
          await this.scanObjects();
          this.cache.clear();
          this.root = await this.get(this.trailer.Root);
        }
        if (!isDict(this.root) || !this.root.Pages) throw fail(MSG.corrupt);
      }
    }

    async readXrefChain() {
      const b = this.b;
      const sx = lastIndexOfStr(b, 'startxref', b.length - 9);
      if (sx < 0) return false;
      const lx = new Lexer(b, sx + 9, false);
      let off = lx.read();
      const seen = new Set();
      let first = true;
      while (typeof off === 'number' && off > 0 && off < b.length && !seen.has(off) && seen.size < 100) {
        seen.add(off);
        const trailer = await this.readXrefAt(off);
        if (!trailer) return !first && !!this.trailer.Root;
        for (const k in trailer) if (!(k in this.trailer)) this.trailer[k] = trailer[k];
        if (typeof trailer.XRefStm === 'number') await this.readXrefAt(trailer.XRefStm).catch(() => null);
        off = trailer.Prev;
        first = false;
      }
      return !!this.trailer.Root && this.xref.size > 0;
    }

    async readXrefAt(off) {
      const b = this.b;
      let p = off;
      while (WS[b[p]]) p++;
      if (startsWith(b, 'xref', p)) {
        const lx = new Lexer(b, p + 4, false);
        for (;;) {
          const start = lx.read();
          if (start instanceof Op && start.name === 'trailer') break;
          const count = lx.read();
          if (typeof start !== 'number' || typeof count !== 'number') return null;
          lx.ws();
          for (let i = 0; i < count; i++) {
            // Entries are nominally 20 bytes; parse loosely to survive bad line ends.
            const o = lx.read();
            const g = lx.read();
            const t = lx.read();
            const num = start + i;
            if (typeof o !== 'number' || !(t instanceof Op)) return null;
            if (!this.xref.has(num) && t.name === 'n' && o > 0) this.xref.set(num, { type: 1, off: o, gen: g });
            else if (!this.xref.has(num) && t.name === 'f') this.xref.set(num, { type: 0 });
          }
        }
        const lx2 = new Lexer(b, lx.p, true);
        const trailer = lx2.read();
        return isDict(trailer) ? trailer : null;
      }
      // Cross-reference stream.
      const obj = this.parseAt(off);
      if (!obj || !(obj.value instanceof Stream) || obj.value.dict.Type !== '/XRef') return null;
      const s = obj.value;
      const data = await this.decodeStream(s);
      const W = s.dict.W;
      if (!Array.isArray(W) || W.length < 3) return null;
      const size = s.dict.Size || 0;
      const index = Array.isArray(s.dict.Index) ? s.dict.Index : [0, size];
      const rowLen = W[0] + W[1] + W[2];
      let p2 = 0;
      const field = (n) => {
        let v = 0;
        for (let i = 0; i < n; i++) v = v * 256 + data[p2++];
        return v;
      };
      for (let k = 0; k + 1 < index.length; k += 2) {
        for (let i = 0; i < index[k + 1] && p2 + rowLen <= data.length; i++) {
          const type = W[0] ? field(W[0]) : 1;
          const f2 = field(W[1]);
          const f3 = field(W[2]);
          const num = index[k] + i;
          if (this.xref.has(num)) continue;
          if (type === 1) this.xref.set(num, { type: 1, off: f2, gen: f3 });
          else if (type === 2) this.xref.set(num, { type: 2, stm: f2, idx: f3 });
          else this.xref.set(num, { type: 0 });
        }
      }
      return s.dict;
    }

    /** Fallback for broken xref: scan the whole file for "N G obj". */
    async scanObjects() {
      this.scanned = true;
      const s = bin(this.b);
      const re = /(?:^|[^0-9])(\d{1,7})[ \t\r\n\f\0]+(\d{1,5})[ \t\r\n\f\0]+obj\b/g;
      let m;
      let n = 0;
      const xrefStreams = [];
      this.xref.clear();
      while ((m = re.exec(s)) && n++ < MAX_OBJECTS) {
        const off = m.index + m[0].indexOf(m[1]);
        this.xref.set(+m[1], { type: 1, off, gen: +m[2] });
        if (/\/Type\s*\/XRef\b/.test(s.slice(off, off + 400))) xrefStreams.push(off);
      }
      // Objects inside object streams: take their entries from any surviving xref stream.
      for (const off of xrefStreams) {
        const keep = new Map(this.xref);
        try {
          await this.readXrefAt(off);
        } catch {
          // ignore
        }
        for (const [k, v] of keep) if (v.type === 1) this.xref.set(k, v);
      }
      let tm;
      const tre = /trailer\s*<</g;
      while ((tm = tre.exec(s))) {
        const t = new Lexer(this.b, tm.index + 7, true).read();
        if (isDict(t)) for (const k in t) this.trailer[k] = t[k];
      }
      for (const off of xrefStreams) {
        const o = this.parseAt(off);
        if (o && o.value instanceof Stream)
          for (const k in o.value.dict) if (!this.trailer[k]) this.trailer[k] = o.value.dict[k];
      }
      if (!this.trailer.Root || !this.xref.has(this.trailer.Root.num)) {
        // Find the catalog by its /Type.
        for (const [num, e] of this.xref) {
          if (e.type !== 1) continue;
          if (/\/Type\s*\/Catalog\b/.test(s.slice(e.off, e.off + 1000))) {
            this.trailer.Root = new Ref(num, e.gen);
            break;
          }
        }
      }
      // Encrypt dictionaries stay referenced from the trailer we found, if any.
    }

    /** Parses "num gen obj ... [stream ...]" at a byte offset. */
    parseAt(off) {
      const b = this.b;
      const lx = new Lexer(b, off, true);
      const num = lx.read();
      const gen = lx.read();
      const kw = lx.read();
      if (typeof num !== 'number' || typeof gen !== 'number' || !(kw instanceof Op) || kw.name !== 'obj') return null;
      let value = lx.read();
      if (value instanceof Op) value = null;
      lx.ws();
      if (isDict(value) && startsWith(b, 'stream', lx.p)) {
        let p = lx.p + 6;
        if (b[p] === 0x0d) p++;
        if (b[p] === 0x0a) p++;
        let len = value.Length;
        if (len instanceof Ref) len = this.getSync(len);
        let end = typeof len === 'number' && len >= 0 ? p + len : -1;
        // Validate /Length against the endstream keyword; search if it is wrong.
        const near = end >= 0 ? indexOfStr(b, 'endstream', end, Math.min(b.length, end + 40)) : -1;
        if (near < 0) {
          const e = indexOfStr(b, 'endstream', p);
          end = e < 0 ? b.length : e;
          while (end > p && (b[end - 1] === 0x0a || b[end - 1] === 0x0d)) end--;
        }
        value = new Stream(value, b.subarray(p, Math.min(end, b.length)), num, gen);
      }
      return { num, gen, value };
    }

    /** Synchronous fetch, only for plain (uncompressed, unencrypted) objects such as /Length. */
    getSync(ref) {
      const e = this.xref.get(ref.num);
      if (!e || e.type !== 1) return null;
      const o = this.parseAt(e.off);
      return o ? o.value : null;
    }

    async fetch(ref) {
      if (this.cache.has(ref.num)) return this.cache.get(ref.num);
      if (++this.fetches > MAX_OBJECTS) throw fail(MSG.corrupt);
      const e = this.xref.get(ref.num);
      let value = null;
      if (e && e.type === 1) {
        const o = this.parseAt(e.off);
        if (o && o.num === ref.num) {
          value = o.value;
          if (this.crypt && value !== null) value = await this.crypt.decryptObject(value, o.num, o.gen);
        } else if (!this.scanned) {
          // Offset is off: rebuild the table and retry once.
          await this.scanObjects();
          return this.fetch(ref);
        }
      } else if (e && e.type === 2) {
        value = await this.fromObjStm(e.stm, e.idx, ref.num);
      }
      this.cache.set(ref.num, value);
      return value;
    }

    async fromObjStm(stmNum, idx, num) {
      let entry = this.objStms.get(stmNum);
      if (!entry) {
        entry = { offsets: new Map(), data: null, first: 0 };
        this.objStms.set(stmNum, entry);
        const s = await this.fetch(new Ref(stmNum, 0));
        if (s instanceof Stream) {
          entry.data = await this.decodeStream(s);
          entry.first = s.dict.First || 0;
          const lx = new Lexer(entry.data, 0, false);
          const n = Math.min(s.dict.N || 0, 100000);
          for (let i = 0; i < n; i++) {
            const on = lx.read();
            const oo = lx.read();
            if (typeof on !== 'number' || typeof oo !== 'number') break;
            entry.offsets.set(on, oo);
          }
        }
      }
      if (!entry.data || !entry.offsets.has(num)) return null;
      const v = new Lexer(entry.data, entry.first + entry.offsets.get(num), true).read();
      return v instanceof Op ? null : v;
    }

    async get(v) {
      let n = 0;
      while (v instanceof Ref && n++ < 20) v = await this.fetch(v);
      return v instanceof Ref ? null : v;
    }

    async decodeStream(s, maxOut = 64 << 20) {
      if (s.decoded) return s.decoded;
      let data = s.raw;
      if (this.crypt && !s.decrypted && s.num != null) data = await this.crypt.decryptStream(s, data);
      let filters = await this.get(s.dict.Filter || s.dict.F);
      let parms = await this.get(s.dict.DecodeParms || s.dict.DP);
      if (!Array.isArray(filters)) filters = filters ? [filters] : [];
      if (!Array.isArray(parms)) parms = [parms];
      for (let i = 0; i < filters.length; i++) {
        const f = filters[i];
        const p = isDict(parms[i]) ? parms[i] : null;
        if (f === '/FlateDecode' || f === '/Fl') data = predict(await inflateLenient(data), p);
        else if (f === '/LZWDecode' || f === '/LZW') data = predict(lzw(data, p ? p.EarlyChange : 1), p);
        else if (f === '/ASCIIHexDecode' || f === '/AHx') data = asciiHex(data);
        else if (f === '/ASCII85Decode' || f === '/A85') data = ascii85(data);
        else if (f === '/RunLengthDecode' || f === '/RL') data = runLength(data);
        else if (f === '/Crypt') continue;
        else {
          data = null; // image codecs (DCT, JBIG2, CCITT, JPX): no text inside
          break;
        }
        if (data.length > maxOut) data = data.subarray(0, maxOut);
      }
      s.decoded = data || new Uint8Array(0);
      return s.decoded;
    }

    async setupCrypt() {
      this.crypt = await makeCrypt(this, await this.get(this.trailer.Encrypt));
    }
  }

  // ---------------------------------------------------------------- filters

  function predict(data, parms) {
    if (!parms) return data;
    const pred = parms.Predictor || 1;
    if (pred < 2) return data;
    const colors = parms.Colors || 1;
    const bpc = parms.BitsPerComponent || 8;
    const columns = parms.Columns || 1;
    const bpp = Math.max(1, (colors * bpc + 7) >> 3);
    const rowLen = (colors * bpc * columns + 7) >> 3;
    if (pred === 2) {
      if (bpc !== 8) return data;
      const out = new Uint8Array(data);
      for (let r = 0; r + rowLen <= out.length; r += rowLen) {
        for (let i = bpp; i < rowLen; i++) out[r + i] = (out[r + i] + out[r + i - bpp]) & 255;
      }
      return out;
    }
    // PNG predictors: each row starts with a filter-type byte.
    const rows = Math.floor(data.length / (rowLen + 1));
    const out = new Uint8Array(rows * rowLen);
    let prev = new Uint8Array(rowLen);
    for (let r = 0; r < rows; r++) {
      const ft = data[r * (rowLen + 1)];
      const src = data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1));
      const cur = out.subarray(r * rowLen, (r + 1) * rowLen);
      for (let i = 0; i < rowLen; i++) {
        const left = i >= bpp ? cur[i - bpp] : 0;
        const up = prev[i];
        const ul = i >= bpp ? prev[i - bpp] : 0;
        let v = src[i];
        if (ft === 1) v += left;
        else if (ft === 2) v += up;
        else if (ft === 3) v += (left + up) >> 1;
        else if (ft === 4) {
          const pa = Math.abs(up - ul);
          const pb = Math.abs(left - ul);
          const pc = Math.abs(left + up - 2 * ul);
          v += pa <= pb && pa <= pc ? left : pb <= pc ? up : ul;
        }
        cur[i] = v & 255;
      }
      prev = cur;
    }
    return out;
  }

  function asciiHex(data) {
    const out = [];
    let hi = -1;
    for (let i = 0; i < data.length && data[i] !== 0x3e; i++) {
      const v = HEXV[data[i]];
      if (v < 0) continue;
      if (hi < 0) hi = v;
      else {
        out.push(hi * 16 + v);
        hi = -1;
      }
    }
    if (hi >= 0) out.push(hi * 16);
    return Uint8Array.from(out);
  }

  function ascii85(data) {
    const out = [];
    let tuple = 0;
    let n = 0;
    let i = 0;
    if (data[0] === 0x3c && data[1] === 0x7e) i = 2;
    for (; i < data.length; i++) {
      const c = data[i];
      if (c === 0x7e) break;
      if (WS[c]) continue;
      if (c === 0x7a && n === 0) {
        out.push(0, 0, 0, 0);
        continue;
      }
      if (c < 0x21 || c > 0x75) continue;
      tuple = tuple * 85 + (c - 0x21);
      if (++n === 5) {
        out.push((tuple >>> 24) & 255, (tuple >>> 16) & 255, (tuple >>> 8) & 255, tuple & 255);
        tuple = 0;
        n = 0;
      }
    }
    if (n > 1) {
      for (let k = n; k < 5; k++) tuple = tuple * 85 + 84;
      const bytes = [(tuple >>> 24) & 255, (tuple >>> 16) & 255, (tuple >>> 8) & 255, tuple & 255];
      out.push(...bytes.slice(0, n - 1));
    }
    return Uint8Array.from(out);
  }

  function runLength(data) {
    const out = [];
    for (let i = 0; i < data.length;) {
      const n = data[i++];
      if (n === 128) break;
      if (n < 128) {
        for (let k = 0; k <= n && i < data.length; k++) out.push(data[i++]);
      } else {
        const v = data[i++];
        for (let k = 0; k < 257 - n; k++) out.push(v);
      }
    }
    return Uint8Array.from(out);
  }

  function lzw(data, earlyChange = 1) {
    const out = [];
    let dict = [];
    const reset = () => {
      dict = [];
      for (let i = 0; i < 256; i++) dict.push([i]);
      dict.push(null, null);
    };
    reset();
    let bits = 9;
    let buf = 0;
    let nbuf = 0;
    let prev = null;
    for (let i = 0; i < data.length; i++) {
      buf = (buf << 8) | data[i];
      nbuf += 8;
      while (nbuf >= bits) {
        const code = (buf >>> (nbuf - bits)) & ((1 << bits) - 1);
        nbuf -= bits;
        buf &= (1 << nbuf) - 1;
        if (code === 256) {
          reset();
          bits = 9;
          prev = null;
          continue;
        }
        if (code === 257) return Uint8Array.from(out);
        let entry;
        if (code < dict.length && dict[code]) entry = dict[code];
        else if (prev) entry = prev.concat(prev[0]);
        else return Uint8Array.from(out);
        out.push(...entry);
        if (prev) dict.push(prev.concat(entry[0]));
        prev = entry;
        if (dict.length + earlyChange >= 1 << bits && bits < 12) bits++;
      }
    }
    return Uint8Array.from(out);
  }

  // ---------------------------------------------------------------- encryption
  // Standard security handler with an empty user password: PDFs that only restrict
  // printing/copying open without a password, so we can read them like a viewer would.

  // prettier-ignore
  const PDF_PAD = Uint8Array.from([
    0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
    0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
  ]);

  const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

  /** MD5 (not in WebCrypto, but required by the PDF key derivation). */
  function md5(data) {
    const n = data.length;
    const len = ((n + 8) >> 6) * 64 + 64;
    const buf = new Uint8Array(len);
    buf.set(data);
    buf[n] = 0x80;
    const bits = n * 8;
    for (let i = 0; i < 4; i++) buf[len - 8 + i] = (bits >>> (8 * i)) & 255;
    buf[len - 4] = Math.floor(n / 2 ** 29) & 255;
    let a0 = 0x67452301;
    let b0 = 0xefcdab89;
    let c0 = 0x98badcfe;
    let d0 = 0x10325476;
    const M = new Uint32Array(16);
    for (let off = 0; off < len; off += 64) {
      for (let i = 0; i < 16; i++) M[i] = u32(buf, off + i * 4);
      let a = a0;
      let b = b0;
      let c = c0;
      let d = d0;
      for (let i = 0; i < 64; i++) {
        let f;
        let g;
        if (i < 16) {
          f = (b & c) | (~b & d);
          g = i;
        } else if (i < 32) {
          f = (d & b) | (~d & c);
          g = (5 * i + 1) & 15;
        } else if (i < 48) {
          f = b ^ c ^ d;
          g = (3 * i + 5) & 15;
        } else {
          f = c ^ (b | ~d);
          g = (7 * i) & 15;
        }
        const s = MD5_S[(i >> 4) * 4 + (i & 3)];
        const t = (a + f + MD5_K[i] + M[g]) >>> 0;
        a = d;
        d = c;
        c = b;
        b = (b + ((t << s) | (t >>> (32 - s)))) >>> 0;
      }
      a0 = (a0 + a) >>> 0;
      b0 = (b0 + b) >>> 0;
      c0 = (c0 + c) >>> 0;
      d0 = (d0 + d) >>> 0;
    }
    const out = new Uint8Array(16);
    [a0, b0, c0, d0].forEach((v, i) => {
      for (let k = 0; k < 4; k++) out[i * 4 + k] = (v >>> (8 * k)) & 255;
    });
    return out;
  }

  function rc4(key, data) {
    const s = new Uint8Array(256);
    for (let i = 0; i < 256; i++) s[i] = i;
    for (let i = 0, j = 0; i < 256; i++) {
      j = (j + s[i] + key[i % key.length]) & 255;
      const t = s[i];
      s[i] = s[j];
      s[j] = t;
    }
    const out = new Uint8Array(data.length);
    for (let k = 0, i = 0, j = 0; k < data.length; k++) {
      i = (i + 1) & 255;
      j = (j + s[i]) & 255;
      const t = s[i];
      s[i] = s[j];
      s[j] = t;
      out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
    }
    return out;
  }

  const join = (...parts) =>
    concat(
      parts,
      parts.reduce((n, p) => n + p.length, 0),
    );
  const strBytes = (v) => (v instanceof PStr ? Uint8Array.from(v.v, (c) => c.charCodeAt(0)) : new Uint8Array(0));
  const equal = (a, b, n) => {
    if (a.length < n || b.length < n) return false;
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
    return true;
  };

  async function aesKey(key, usage) {
    return crypto.subtle.importKey('raw', key, { name: 'AES-CBC' }, false, usage);
  }

  /** AES-CBC encrypt without padding (WebCrypto always pads; drop the extra block). */
  async function aesEncryptRaw(key, iv, data) {
    const k = await aesKey(key, ['encrypt']);
    return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, k, data)).subarray(0, data.length);
  }

  /** AES-CBC decrypt that tolerates missing/invalid PKCS#7 padding. */
  async function aesDecrypt(key, iv, data, padded = true) {
    data = data.subarray(0, data.length - (data.length % 16));
    if (!data.length) return data;
    const k = await aesKey(key, ['encrypt', 'decrypt']);
    if (padded) {
      try {
        return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, k, data));
      } catch {
        // fall through: decrypt as unpadded
      }
    }
    // Append a block that decrypts to valid padding so WebCrypto accepts the input.
    const last = data.subarray(data.length - 16);
    const extra = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-CBC', iv: last }, k, new Uint8Array(16).fill(16)),
    );
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, k, join(data, extra.subarray(0, 16))));
  }

  /** ISO 32000-2 Algorithm 2.B (revision 6 password hash). */
  async function hashR6(pw, salt, udata) {
    let K = new Uint8Array(await crypto.subtle.digest('SHA-256', join(pw, salt, udata)));
    for (let i = 0; i < 1000; i++) {
      const unit = join(pw, K, udata);
      const K1 = new Uint8Array(unit.length * 64);
      for (let r = 0; r < 64; r++) K1.set(unit, r * unit.length);
      const E = await aesEncryptRaw(K.subarray(0, 16), K.subarray(16, 32), K1);
      let sum = 0;
      for (let k = 0; k < 16; k++) sum += E[k];
      K = new Uint8Array(await crypto.subtle.digest(['SHA-256', 'SHA-384', 'SHA-512'][sum % 3], E));
      if (i >= 63 && E[E.length - 1] <= i - 32) break;
    }
    return K.subarray(0, 32);
  }

  async function makeCrypt(doc, enc) {
    if (!isDict(enc) || enc.Filter !== '/Standard') throw fail(MSG.password);
    const V = (await doc.get(enc.V)) || 0;
    const R = (await doc.get(enc.R)) || 2;
    const O = strBytes(await doc.get(enc.O));
    const U = strBytes(await doc.get(enc.U));
    const P = (await doc.get(enc.P)) | 0;
    const ids = await doc.get(doc.trailer.ID);
    const id0 = Array.isArray(ids) ? strBytes(await doc.get(ids[0])) : new Uint8Array(0);
    const cf = isDict(enc.CF) ? enc.CF : {};
    const method = (name) => {
      if (V < 4) return 'rc4';
      if (!name || name === '/Identity') return 'none';
      const d = cf[name.slice(1)];
      const m = isDict(d) ? d.CFM : null;
      return m === '/AESV2' ? 'aes' : m === '/AESV3' ? 'aes256' : m === '/None' ? 'none' : 'rc4';
    };
    const stm = method(enc.StmF);
    const str = method(enc.StrF);
    const empty = new Uint8Array(0);
    let key = null;

    if (R >= 5) {
      // AES-256: the empty password is checked against U (user) and O (owner).
      const hash = (pw, salt, udata) =>
        R >= 6
          ? hashR6(pw, salt, udata)
          : crypto.subtle.digest('SHA-256', join(pw, salt, udata)).then((h) => new Uint8Array(h));
      const UE = strBytes(await doc.get(enc.UE));
      const OE = strBytes(await doc.get(enc.OE));
      const u48 = U.subarray(0, 48);
      if (U.length >= 48 && equal(await hash(empty, U.subarray(32, 40), empty), U, 32)) {
        key = await aesDecrypt(await hash(empty, U.subarray(40, 48), empty), new Uint8Array(16), UE, false);
      } else if (O.length >= 48 && equal(await hash(empty, O.subarray(32, 40), u48), O, 32)) {
        key = await aesDecrypt(await hash(empty, O.subarray(40, 48), u48), new Uint8Array(16), OE, false);
      }
      if (!key || key.length < 32) throw fail(MSG.password);
      key = key.subarray(0, 32);
    } else {
      const n = V === 1 ? 5 : Math.max(5, Math.min(16, ((await doc.get(enc.Length)) || 40) / 8));
      const p4 = Uint8Array.from([P & 255, (P >> 8) & 255, (P >> 16) & 255, (P >>> 24) & 255]);
      const meta = R >= 4 && enc.EncryptMetadata === false ? Uint8Array.from([255, 255, 255, 255]) : empty;
      const fileKey = (padded) => {
        let h = md5(join(padded, O.subarray(0, 32), p4, id0, meta));
        if (R >= 3) for (let i = 0; i < 50; i++) h = md5(h.subarray(0, n));
        return h.subarray(0, n);
      };
      const check = (k) => {
        if (R === 2) return equal(rc4(k, PDF_PAD), U, 32);
        let x = rc4(k, md5(join(PDF_PAD, id0)));
        for (let i = 1; i <= 19; i++)
          x = rc4(
            k.map((b) => b ^ i),
            x,
          );
        return equal(x, U, 16);
      };
      const k1 = fileKey(PDF_PAD);
      if (check(k1)) key = k1;
      else {
        // Empty owner password: recover the user password from O (Algorithm 7).
        let h = md5(PDF_PAD);
        if (R >= 3) for (let i = 0; i < 50; i++) h = md5(h);
        const rk = h.subarray(0, n);
        let pw = O.subarray(0, 32);
        if (R === 2) pw = rc4(rk, pw);
        else
          for (let i = 19; i >= 0; i--)
            pw = rc4(
              rk.map((b) => b ^ i),
              pw,
            );
        const k2 = fileKey(pw);
        if (check(k2)) key = k2;
      }
      if (!key) throw fail(MSG.password);
    }

    const objKey = (num, gen, aes) => {
      if (R >= 5) return key;
      const k = md5(
        join(
          key,
          Uint8Array.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255]),
          aes ? Uint8Array.from([0x73, 0x41, 0x6c, 0x54]) : empty,
        ),
      );
      return k.subarray(0, Math.min(16, key.length + 5));
    };
    const run = async (m, data, num, gen) => {
      if (m === 'none') return data;
      if (m === 'rc4') return rc4(objKey(num, gen, false), data);
      if (data.length < 16) return empty;
      return aesDecrypt(objKey(num, gen, true), data.subarray(0, 16), data.subarray(16));
    };
    const walk = async (v, num, gen, depth) => {
      if (depth > 50) return v;
      if (v instanceof PStr) return new PStr(bin(await run(str, strBytes(v), num, gen)));
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) v[i] = await walk(v[i], num, gen, depth + 1);
      } else if (v instanceof Stream) {
        await walk(v.dict, num, gen, depth + 1);
      } else if (isDict(v)) {
        for (const k in v) v[k] = await walk(v[k], num, gen, depth + 1);
      }
      return v;
    };
    return {
      decryptObject: (v, num, gen) => (v instanceof Stream && v.dict.Type === '/XRef' ? v : walk(v, num, gen, 0)),
      async decryptStream(s, data) {
        s.decrypted = true;
        if (s.dict.Type === '/XRef') return data;
        const filters = [].concat(s.dict.Filter || []);
        if (filters.includes('/Crypt')) return data; // per-stream Identity crypt filter
        return run(stm, data, s.num, s.gen);
      },
    };
  }

  // ---------------------------------------------------------------- encodings & glyph names

  // Codes 128–159 of WinAnsiEncoding; 160–255 are Latin-1.
  const WIN_HIGH = '€\0‚ƒ„…†‡ˆ‰Š‹Œ\0Ž\0\0‘’“”•–—˜™š›œ\0žŸ';
  const WIN_ANSI = [];
  for (let c = 0; c < 256; c++) {
    WIN_ANSI[c] = c >= 32 && c < 127 ? String.fromCharCode(c) : c >= 160 ? String.fromCharCode(c) : '';
    if (c >= 128 && c < 160) WIN_ANSI[c] = WIN_HIGH[c - 128] === '\0' ? '' : WIN_HIGH[c - 128];
  }
  WIN_ANSI[127] = '•';
  WIN_ANSI[173] = '-'; // WinAnsi 0xAD is drawn as a hyphen

  // Upper halves of the other base encodings (from the PDF spec, Annex D).
  // prettier-ignore
  const STD_HIGH = '\u00a1\u00a2\u00a3\u2044\u00a5\u0192\u00a7\u00a4\'\u201c\u00ab\u2039\u203a\ufb01\ufb02\0\u2013\u2020\u2021\u00b7\0\u00b6\u2022\u201a\u201e\u201d\u00bb\u2026\u2030\0\u00bf\0`\u00b4\u02c6\u02dc\u00af\u02d8\u02d9\u00a8\0\u02da\u00b8\0\u02dd\u02db\u02c7\u2014\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\u00c6\0\u00aa\0\0\0\0\u0141\u00d8\u0152\u00ba\0\0\0\0\0\u00e6\0\0\0\u0131\0\0\u0142\u00f8\u0153\u00df\0\0\0\0'; // 161–255
  // prettier-ignore
  const MAC_HIGH = '\u00c4\u00c5\u00c7\u00c9\u00d1\u00d6\u00dc\u00e1\u00e0\u00e2\u00e4\u00e3\u00e5\u00e7\u00e9\u00e8\u00ea\u00eb\u00ed\u00ec\u00ee\u00ef\u00f1\u00f3\u00f2\u00f4\u00f6\u00f5\u00fa\u00f9\u00fb\u00fc\u2020\u00b0\u00a2\u00a3\u00a7\u2022\u00b6\u00df\u00ae\u00a9\u2122\u00b4\u00a8\u2260\u00c6\u00d8\u221e\u00b1\u2264\u2265\u00a5\u00b5\u2202\u2211\u220f\u03c0\u222b\u00aa\u00ba\u2126\u00e6\u00f8\u00bf\u00a1\u00ac\u221a\u0192\u2248\u2206\u00ab\u00bb\u2026\u00a0\u00c0\u00c3\u00d5\u0152\u0153\u2013\u2014\u201c\u201d\u2018\u2019\u00f7\u25ca\u00ff\u0178\u2044\u00a4\u2039\u203a\ufb01\ufb02\u2021\u00b7\u201a\u201e\u2030\u00c2\u00ca\u00c1\u00cb\u00c8\u00cd\u00ce\u00cf\u00cc\u00d3\u00d4\0\u00d2\u00da\u00db\u00d9\u0131\u02c6\u02dc\u00af\u02d8\u02d9\u02da\u00b8\u02dd\u02db\u02c7'; // 128–255
  // prettier-ignore
  const SYMBOL_TABLE = '\u00a0!\u2200#\u2203%&\u220b()\u2217+,\u2212./0123456789:;<=>?\u2245\u0391\u0392\u03a7\u2206\u0395\u03a6\u0393\u0397\u0399\u03d1\u039a\u039b\u039c\u039d\u039f\u03a0\u0398\u03a1\u03a3\u03a4\u03a5\u03c2\u2126\u039e\u03a8\u0396[\u2234]\u22a5_\uf8e5\u03b1\u03b2\u03c7\u03b4\u03b5\u03c6\u03b3\u03b7\u03b9\u03d5\u03ba\u03bb\u03bc\u03bd\u03bf\u03c0\u03b8\u03c1\u03c3\u03c4\u03c5\u03d6\u03c9\u03be\u03c8\u03b6{|}\u223c\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\u20ac\u03d2\u2032\u2264\u2215\u221e\u0192\u2663\u2666\u2665\u2660\u2194\u2190\u2191\u2192\u2193\u00b0\u00b1\u2033\u2265\u00d7\u221d\u2202\u2022\u00f7\u2260\u2261\u2248\u2026\uf8e6\uf8e7\u21b5\u2135\u2111\u211c\u2118\u2297\u2295\u2205\u2229\u222a\u2283\u2287\u2284\u2282\u2286\u2208\u2209\u2220\u2207\uf6da\uf6d9\uf6db\u220f\u221a\u22c5\u00ac\u2227\u2228\u21d4\u21d0\u21d1\u21d2\u21d3\u25ca\u2329\uf8e8\uf8e9\uf8ea\u2211\uf8eb\uf8ec\uf8ed\uf8ee\uf8ef\uf8f0\uf8f1\uf8f2\uf8f3\uf8f4\0\u232a\u222b\u2320\uf8f5\u2321\uf8f6\uf8f7\uf8f8\uf8f9\uf8fa\uf8fb\uf8fc\uf8fd\uf8fe'; // 32–254
  // prettier-ignore
  const DINGBATS_TABLE = '\u00a0\u2701\u2702\u2703\u2704\u260e\u2706\u2707\u2708\u2709\u261b\u261e\u270c\u270d\u270e\u270f\u2710\u2711\u2712\u2713\u2714\u2715\u2716\u2717\u2718\u2719\u271a\u271b\u271c\u271d\u271e\u271f\u2720\u2721\u2722\u2723\u2724\u2725\u2726\u2727\u2605\u2729\u272a\u272b\u272c\u272d\u272e\u272f\u2730\u2731\u2732\u2733\u2734\u2735\u2736\u2737\u2738\u2739\u273a\u273b\u273c\u273d\u273e\u273f\u2740\u2741\u2742\u2743\u2744\u2745\u2746\u2747\u2748\u2749\u274a\u274b\u25cf\u274d\u25a0\u274f\u2750\u2751\u2752\u25b2\u25bc\u25c6\u2756\u25d7\u2758\u2759\u275a\u275b\u275c\u275d\u275e\0\uf8d7\uf8d8\uf8d9\uf8da\uf8db\uf8dc\uf8dd\uf8de\uf8df\uf8e0\uf8e1\uf8e2\uf8e3\uf8e4\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\u2761\u2762\u2763\u2764\u2765\u2766\u2767\u2663\u2666\u2665\u2660\u2460\u2461\u2462\u2463\u2464\u2465\u2466\u2467\u2468\u2469\u2776\u2777\u2778\u2779\u277a\u277b\u277c\u277d\u277e\u277f\u2780\u2781\u2782\u2783\u2784\u2785\u2786\u2787\u2788\u2789\u278a\u278b\u278c\u278d\u278e\u278f\u2790\u2791\u2792\u2793\u2794\u2192\u2194\u2195\u2798\u2799\u279a\u279b\u279c\u279d\u279e\u279f\u27a0\u27a1\u27a2\u27a3\u27a4\u27a5\u27a6\u27a7\u27a8\u27a9\u27aa\u27ab\u27ac\u27ad\u27ae\u27af\0\u27b1\u27b2\u27b3\u27b4\u27b5\u27b6\u27b7\u27b8\u27b9\u27ba\u27bb\u27bc\u27bd\u27be'; // 32–254
  const table = (lo, chars, base) => {
    const t = base ? base.slice() : new Array(256).fill('');
    for (let i = 0; i < chars.length; i++) t[lo + i] = chars[i] === '\0' ? '' : chars[i];
    return t;
  };
  const ASCII = table(32, Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join(''));
  const STANDARD = table(161, STD_HIGH, ASCII);
  STANDARD[0x27] = '’'; // quoteright
  STANDARD[0x60] = '‘'; // quoteleft
  const MAC_ROMAN = table(128, MAC_HIGH, ASCII);
  const ENCODINGS = {
    WinAnsiEncoding: WIN_ANSI,
    StandardEncoding: STANDARD,
    MacRomanEncoding: MAC_ROMAN,
    PDFDocEncoding: WIN_ANSI,
  };
  const SYMBOL_ENC = table(32, SYMBOL_TABLE);
  const DINGBATS_ENC = table(32, DINGBATS_TABLE);

  // Adobe Glyph List subset: name -> code point (hex). Accented Latin names are derived below.
  const AGL_DATA =
    'space:20 exclam:21 quotedbl:22 numbersign:23 dollar:24 percent:25 ampersand:26 quotesingle:27 parenleft:28 parenright:29 asterisk:2a plus:2b comma:2c hyphen:2d period:2e slash:2f zero:30 one:31 two:32 three:33 four:34 five:35 six:36 seven:37 eight:38 nine:39 colon:3a semicolon:3b less:3c equal:3d greater:3e question:3f at:40 bracketleft:5b backslash:5c bracketright:5d asciicircum:5e underscore:5f grave:60 braceleft:7b bar:7c braceright:7d asciitilde:7e nbspace:a0 nonbreakingspace:a0 exclamdown:a1 cent:a2 sterling:a3 currency:a4 yen:a5 brokenbar:a6 section:a7 dieresis:a8 copyright:a9 ordfeminine:aa guillemotleft:ab logicalnot:ac registered:ae macron:af degree:b0 plusminus:b1 acute:b4 mu:b5 paragraph:b6 middot:b7 periodcentered:b7 cedilla:b8 ordmasculine:ba guillemotright:bb onequarter:bc onehalf:bd threequarters:be questiondown:bf AE:c6 Eth:d0 multiply:d7 Oslash:d8 Thorn:de germandbls:df ae:e6 eth:f0 divide:f7 oslash:f8 thorn:fe Cdot:10a cdot:10b Dcroat:110 Dslash:110 dcroat:111 dslash:111 Edot:116 edot:117 Gdot:120 gdot:121 Hbar:126 hbar:127 Idot:130 dotlessi:131 IJ:132 ij:133 Ldot:13f ldot:140 Lslash:141 lslash:142 Eng:14a eng:14b Odblacute:150 odblacute:151 OE:152 oe:153 Tcommaaccent:162 tcommaaccent:163 Tbar:166 tbar:167 Udblacute:170 udblacute:171 Zdot:17b zdot:17c longs:17f slong:17f florin:192 dotlessj:237 circumflex:2c6 caron:2c7 breve:2d8 dotaccent:2d9 ring:2da ogonek:2db tilde:2dc hungarumlaut:2dd Alpha:391 Beta:392 Gamma:393 Deltagreek:394 Epsilon:395 Zeta:396 Eta:397 Theta:398 Iota:399 Kappa:39a Lambda:39b Mu:39c Nu:39d Xi:39e Omicron:39f Pi:3a0 Rho:3a1 Sigma:3a3 Tau:3a4 Upsilon:3a5 Phi:3a6 Chi:3a7 Psi:3a8 Omegagreek:3a9 Iotadieresis:3aa Upsilondieresis:3ab alphatonos:3ac epsilontonos:3ad etatonos:3ae iotatonos:3af upsilondieresistonos:3b0 alpha:3b1 beta:3b2 gamma:3b3 delta:3b4 epsilon:3b5 zeta:3b6 eta:3b7 theta:3b8 iota:3b9 kappa:3ba lambda:3bb mugreek:3bc nu:3bd xi:3be omicron:3bf pi:3c0 rho:3c1 sigma1:3c2 sigmafinal:3c2 sigma:3c3 tau:3c4 upsilon:3c5 phi:3c6 chi:3c7 psi:3c8 omega:3c9 endash:2013 emdash:2014 quoteleft:2018 quoteright:2019 quotesinglbase:201a quotedblleft:201c quotedblright:201d quotedblbase:201e dagger:2020 daggerdbl:2021 bullet:2022 ellipsis:2026 perthousand:2030 minute:2032 second:2033 guilsinglleft:2039 guilsinglright:203a exclamdbl:203c overline:203e fraction:2044 Euro:20ac euro:20ac numero:2116 trademark:2122 Omega:2126 arrowleft:2190 arrowup:2191 arrowright:2192 arrowdown:2193 arrowboth:2194 arrowupdn:2195 partialdiff:2202 Delta:2206 product:220f summation:2211 minus:2212 radical:221a infinity:221e integral:222b approxequal:2248 notequal:2260 lessequal:2264 greaterequal:2265 blacksquare:25a0 filledbox:25a0 lozenge:25ca circle:25cb blackcircle:25cf';
  const AGL = new Map();
  for (const pair of AGL_DATA.split(' ')) {
    const i = pair.lastIndexOf(':');
    if (i > 0) AGL.set(pair.slice(0, i), String.fromCodePoint(parseInt(pair.slice(i + 1), 16)));
  }
  const ACCENTS = {
    acute: '\u0301',
    grave: '\u0300',
    circumflex: '\u0302',
    dieresis: '\u0308',
    tilde: '\u0303',
    ring: '\u030a',
    cedilla: '\u0327',
    caron: '\u030c',
    macron: '\u0304',
    breve: '\u0306',
    dotaccent: '\u0307',
    ogonek: '\u0328',
    hungarumlaut: '\u030b',
    commaaccent: '\u0326',
  };
  const LIGATURES = { ff: 'ff', fi: 'fi', fl: 'fl', ffi: 'ffi', ffl: 'ffl', st: 'st', ft: 'ft', IJ: 'IJ', ij: 'ij' };

  /** Glyph name → Unicode text ('' when unknown). */
  function glyphToUnicode(name) {
    if (!name) return '';
    if (AGL.has(name)) return AGL.get(name);
    if (LIGATURES[name]) return LIGATURES[name];
    if (/^[A-Za-z]$/.test(name)) return name;
    let m = /^uni((?:[0-9A-Fa-f]{4})+)$/.exec(name);
    if (m)
      return m[1]
        .match(/.{4}/g)
        .map((h) => String.fromCharCode(parseInt(h, 16)))
        .join('');
    m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
    if (m) {
      const cp = parseInt(m[1], 16);
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    }
    // Suffixes (.sc, .alt, .oldstyle, .ss01) and underscore ligatures (f_f_i).
    const dot = name.indexOf('.');
    if (dot > 0) return glyphToUnicode(name.slice(0, dot));
    if (name.includes('_')) return name.split('_').map(glyphToUnicode).join('');
    m =
      /^([A-Za-z]|AE|ae|OE|oe|dotlessi)(acute|grave|circumflex|dieresis|tilde|ring|cedilla|caron|macron|breve|dotaccent|ogonek|hungarumlaut|commaaccent)$/.exec(
        name,
      );
    if (m) return (glyphToUnicode(m[1]) + ACCENTS[m[2]]).normalize('NFC');
    // TeX names that are not in the AGL.
    if (name === 'dotlessi') return 'ı';
    if (name === 'visiblespace') return ' ';
    return '';
  }

  // ---------------------------------------------------------------- fonts

  /** Parses a CMap (ToUnicode or embedded encoding CMap). */
  function parseCMap(bytes) {
    const lx = new Lexer(bytes, 0, false);
    const cmap = { spaces: [], map: new Map(), ranges: [] };
    const operands = [];
    const code = (s) => {
      let v = 0;
      for (let i = 0; i < s.length; i++) v = v * 256 + s.charCodeAt(i);
      return v;
    };
    const utf16 = (s) => {
      if (s.length === 1) return s; // some writers emit single-byte targets
      let out = '';
      for (let i = 0; i + 1 < s.length; i += 2)
        out += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
      return out;
    };
    let mode = '';
    for (let n = 0; n < 500000; n++) {
      const t = lx.read();
      if (t === EOF) break;
      if (!(t instanceof Op)) {
        if (mode) operands.push(t);
        continue;
      }
      const w = t.name;
      if (
        w === 'begincodespacerange' ||
        w === 'beginbfchar' ||
        w === 'beginbfrange' ||
        w === 'begincidrange' ||
        w === 'begincidchar'
      ) {
        mode = w;
        operands.length = 0;
        continue;
      }
      if (w === 'endcodespacerange') {
        for (let i = 0; i + 1 < operands.length; i += 2) {
          const lo = operands[i];
          const hi = operands[i + 1];
          if (lo instanceof PStr && hi instanceof PStr)
            cmap.spaces.push({ n: lo.v.length, lo: code(lo.v), hi: code(hi.v) });
        }
      } else if (w === 'endbfchar') {
        for (let i = 0; i + 1 < operands.length; i += 2) {
          const src = operands[i];
          const dst = operands[i + 1];
          if (!(src instanceof PStr)) continue;
          const u = dst instanceof PStr ? utf16(dst.v) : typeof dst === 'string' ? glyphToUnicode(dst.slice(1)) : '';
          cmap.map.set(code(src.v), u);
        }
      } else if (w === 'endbfrange') {
        for (let i = 0; i + 2 < operands.length; i += 3) {
          const lo = operands[i];
          const hi = operands[i + 1];
          const dst = operands[i + 2];
          if (!(lo instanceof PStr) || !(hi instanceof PStr)) continue;
          const a = code(lo.v);
          const z = code(hi.v);
          if (z < a) continue;
          if (Array.isArray(dst)) {
            for (let c = a; c <= z && c - a < dst.length; c++) {
              const d = dst[c - a];
              if (d instanceof PStr) cmap.map.set(c, utf16(d.v));
            }
          } else if (dst instanceof PStr) {
            const base = utf16(dst.v);
            if (z - a < 512) {
              for (let c = a; c <= z; c++) cmap.map.set(c, incLast(base, c - a));
            } else cmap.ranges.push({ a, z, base });
          }
        }
      }
      if (w.startsWith('end')) {
        mode = '';
        operands.length = 0;
      }
    }
    return cmap;
  }

  function incLast(s, k) {
    if (!k) return s;
    const last = s.charCodeAt(s.length - 1);
    if (s.length >= 2 && last >= 0xdc00 && last <= 0xdfff) {
      const cp = s.codePointAt(s.length - 2) + k;
      return s.slice(0, -2) + String.fromCodePoint(Math.min(cp, 0x10ffff));
    }
    return s.slice(0, -1) + String.fromCharCode((last + k) & 0xffff);
  }

  function cmapLookup(cmap, c) {
    const v = cmap.map.get(c);
    if (v !== undefined) return v;
    for (const r of cmap.ranges) if (c >= r.a && c <= r.z) return incLast(r.base, c - r.a);
    return undefined;
  }

  /**
   * Builds a font decoder: split(binaryString) → [{ code, bytes }], and
   * per-code unicode text + advance width (in 1/1000 text-space units).
   */
  async function loadFont(doc, fontRef) {
    const font = await doc.get(fontRef);
    const f = {
      twoByte: false,
      spaces: null,
      uni: new Map(),
      widths: new Map(),
      dw: 500,
      scale: 1, // Type3 glyph-space scale relative to 1/1000
      vscale: 1,
      toUnicode: null,
      base: '',
    };
    if (!isDict(font)) {
      f.uni = DEFAULT_FONT.uni; // missing font resource: assume WinAnsi
      return f;
    }
    const subtype = font.Subtype;
    f.base = typeof font.BaseFont === 'string' ? font.BaseFont.slice(1).replace(/^[A-Z]{6}\+/, '') : '';
    const tu = await doc.get(font.ToUnicode);
    if (tu instanceof Stream) {
      try {
        f.toUnicode = parseCMap(await doc.decodeStream(tu));
      } catch {
        f.toUnicode = null;
      }
    }
    if (subtype === '/Type0') {
      f.twoByte = true;
      const enc = await doc.get(font.Encoding);
      if (enc instanceof Stream) {
        const cm = parseCMap(await doc.decodeStream(enc));
        if (cm.spaces.length) f.spaces = cm.spaces;
      } else if (typeof enc === 'string' && /UCS2|UTF16/.test(enc)) {
        f.ucs2 = true; // codes are Unicode already
      } else if (typeof enc === 'string' && !/Identity/.test(enc)) {
        // Predefined CJK CMaps mix 1- and 2-byte codes; the ToUnicode codespace usually describes them.
        if (f.toUnicode && f.toUnicode.spaces.length) f.spaces = f.toUnicode.spaces;
      }
      let desc = await doc.get(font.DescendantFonts);
      desc = await doc.get(Array.isArray(desc) ? desc[0] : desc);
      if (isDict(desc) && !f.toUnicode && !f.ucs2) {
        // No ToUnicode: map CID → GID → Unicode through the embedded TrueType cmap, if any.
        const fd = await doc.get(desc.FontDescriptor);
        const ff = isDict(fd) ? await doc.get(fd.FontFile2 || fd.FontFile3) : null;
        const glyphs = ff instanceof Stream ? trueTypeGlyphMap(await doc.decodeStream(ff)) : null;
        if (glyphs) {
          const c2g = await doc.get(desc.CIDToGIDMap);
          f.glyphs = glyphs;
          f.cidToGid = c2g instanceof Stream ? await doc.decodeStream(c2g) : null;
        }
      }
      if (isDict(desc)) {
        f.dw = typeof desc.DW === 'number' ? desc.DW : 1000;
        const W = await doc.get(desc.W);
        if (Array.isArray(W)) {
          for (let i = 0; i < W.length && i < 200000;) {
            const first = await doc.get(W[i]);
            const next = await doc.get(W[i + 1]);
            if (Array.isArray(next)) {
              for (let k = 0; k < next.length; k++) f.widths.set(first + k, await doc.get(next[k]));
              i += 2;
            } else {
              const last = next;
              const w = await doc.get(W[i + 2]);
              if (typeof last === 'number' && last - first < 65536)
                for (let c = first; c <= last; c++) f.widths.set(c, w);
              i += 3;
            }
          }
        }
      }
      return f;
    }

    // Simple fonts (Type1, TrueType, Type3, MMType1).
    const first = (await doc.get(font.FirstChar)) || 0;
    const widths = await doc.get(font.Widths);
    if (subtype === '/Type3') {
      const fm = await doc.get(font.FontMatrix);
      if (Array.isArray(fm) && typeof fm[0] === 'number' && fm[0]) {
        f.scale = fm[0] * 1000;
        f.vscale = Math.abs(fm[3] || fm[0]) * 1000;
      }
    }
    if (Array.isArray(widths)) {
      for (let i = 0; i < widths.length; i++) {
        const w = await doc.get(widths[i]);
        if (typeof w === 'number') f.widths.set(first + i, w);
      }
      const fdesc = await doc.get(font.FontDescriptor);
      f.dw = isDict(fdesc) ? +(await doc.get(fdesc.MissingWidth)) || 0 : 0;
    } else {
      const std = stdWidths(f.base);
      if (std) {
        f.widths = std;
        f.dw = 500;
      }
    }
    // Base encoding, then /Differences on top.
    const enc = await doc.get(font.Encoding);
    let table = null;
    const diffs = new Map();
    if (typeof enc === 'string') table = ENCODINGS[enc.slice(1)];
    else if (isDict(enc)) {
      if (typeof enc.BaseEncoding === 'string') table = ENCODINGS[enc.BaseEncoding.slice(1)];
      const d = await doc.get(enc.Differences);
      if (Array.isArray(d)) {
        let c = 0;
        for (const item of d) {
          if (typeof item === 'number') c = item;
          else if (typeof item === 'string') diffs.set(c++, item.slice(1));
        }
      }
    }
    const fd = await doc.get(font.FontDescriptor);
    const flags = isDict(fd) ? +(await doc.get(fd.Flags)) || 0 : 0;
    if (!table && isDict(fd) && (subtype === '/Type1' || subtype === '/MMType1')) {
      // Embedded Type1 programs carry their own encoding (TeX fonts rely on it).
      const ff = await doc.get(fd.FontFile);
      if (ff instanceof Stream) table = type1BuiltinEncoding(await doc.decodeStream(ff));
    }
    if (!table) table = defaultEncoding(f.base, subtype, flags);
    for (let c = 0; c < 256; c++) {
      let u = diffs.has(c) ? glyphToUnicode(diffs.get(c)) : table[c] || '';
      if (diffs.has(c) && !u && table[c]) u = table[c];
      if (u) f.uni.set(c, u);
    }
    return f;
  }

  /** Reads "dup 12 /fi put" lines from the cleartext part of a Type1 font program. */
  function type1BuiltinEncoding(data) {
    const head = bin(data, 0, Math.min(data.length, 65536));
    const at = head.indexOf('/Encoding');
    if (at < 0) return null;
    const tail = head.slice(at, at + 40);
    if (/^\/Encoding\s+StandardEncoding/.test(tail)) return STANDARD;
    const end = head.indexOf('readonly def', at);
    const body = head.slice(at, end > 0 ? end : undefined);
    const t = new Array(256).fill('');
    let any = false;
    for (const m of body.matchAll(/dup\s+(\d+)\s*\/([^\s/]+)\s+put/g)) {
      if (+m[1] < 256) {
        t[+m[1]] = glyphToUnicode(m[2]);
        any = true;
      }
    }
    return any ? t : null;
  }

  function defaultEncoding(base, subtype, flags) {
    if (/Symbol/i.test(base) && !/Symbolic|SymbolMT/i.test(base)) return SYMBOL_ENC;
    if (/Dingbats/i.test(base)) return DINGBATS_ENC;
    // Type1 fonts default to StandardEncoding; TrueType and unknowns are almost always WinAnsi in practice.
    if (subtype === '/Type1' && !(flags & 4)) return STANDARD;
    return WIN_ANSI;
  }

  // Advance widths of the standard 14 fonts for WinAnsi codes 32–255 (base-36 pairs),
  // used when a font omits /Widths (pdf-lib, some generators).
  // prettier-ignore
  const STD_WIDTHS = {
    'Helvetica': '7q7q9vfgfgopij5b9999atg87q997q7qfgfgfgfgfgfgfgfgfgfg7q7qg8g8g8fgs7ijijk2k2ijgzlmk27qdwijfgn5k2lmijlmk2ijgzk2ijq8ijijgz7q7q7qd1fg99fgfgdwfgfg7qfgfg6666dw66n5fgfgfgfg99dw7qfgdwk2dwdwdw9a789ag89qfg9q66fg99rsfgfg99rsij99rs9qgz9q9q666699999qfgrs99rsdw99q89qdwdw7q99fgfgfgfg78fg99khaafgg899kh99b4g8999999fgex7q9999a5fgn6n6n6gzijijijijijijrsk2ijijijij7q7q7q7qk2k2lmlmlmlmlmg8lmk2k2k2k2ijijgzfgfgfgfgfgfgopdwfgfgfgfg7q7q7q7qfgfgfgfgfgfgfgg8gzfgfgfgfgdwfgdw',
    'Helvetica-Bold': '7q99d6fgfgopk26m9999atg87q997q7qfgfgfgfgfgfgfgfgfgfg9999g8g8g8gzr3k2k2k2k2ijgzlmk27qfgk2gzn5k2lmijlmk2ijgzk2ijq8ijijgz997q99g8fg99fggzfggzfg99gzgz7q7qfg7qopgzgzgzgzatfg99gzfglmfgfgdwat7satg89qfg9q7qfgdwrsfgfg99rsij99rs9qgz9q9q7q7qdwdw9qfgrs99rsfg99q89qdwfg7q99fgfgfgfg7sfg99khaafgg899kh99b4g8999999gzfg7q9999a5fgn6n6n6gzk2k2k2k2k2k2rsk2ijijijij7q7q7q7qk2k2lmlmlmlmlmg8lmk2k2k2k2ijijgzfgfgfgfgfgfgopfgfgfgfgfg7q7q7q7qgzgzgzgzgzgzgzg8gzgzgzgzgzfggzfg',
    'Times-Roman': '6y99bcdwdwn5lm509999dwfo6y996y7qdwdwdwdwdwdwdwdwdwdw7q7qfofofoccplk2ijijk2gzfgk2k299atk2gzopk2k2fgk2ijfggzk2k2q8k2k2gz997q99d1dw99ccdwccdwcc99dwdw7q7qdw7qlmdwdwdwdw99at7qdwdwk2dwdwccdc5kdcf19qdw9q99dwccrsdwdw99rsfg99op9qgz9q9q9999cccc9qdwrs99r8at99k29qccdw6y99dwdwdwdw5kdw99l47odwfo99l499b4fo8c8c99dwcl6y998c8mdwkukukucck2k2k2k2k2k2opijgzgzgzgz99999999k2k2k2k2k2k2k2fok2k2k2k2k2k2fgdwccccccccccccijcccccccccc7q7q7q7qdwdwdwdwdwdwdwfodwdwdwdwdwdwdwdw',
    'Times-Bold': '6y99ffdwdwrsn57q9999dwfu6y996y7qdwdwdwdwdwdwdwdwdwdw9999fufufudwpuk2ijk2k2ijgzlmlmatdwlmijq8k2lmgzlmk2fgijk2k2rsk2k2ij997q99g5dw99dwfgccfgcc99dwfg7q99fg7qn5fgdwfgfgccat99fgdwk2dwdwccay64ayeg9qdw9q99dwdwrsdwdw99rsfg99rs9qij9q9q9999dwdw9qdwrs99rsat99k29qccdw6y99dwdwdwdw64dw99kr8cdwfu99kr99b4fu8c8c99fgf06y998c96dwkukukudwk2k2k2k2k2k2rsk2ijijijijatatatatk2k2lmlmlmlmlmfulmk2k2k2k2k2gzfgdwdwdwdwdwdwk2cccccccccc7q7q7q7qdwfgdwdwdwdwdwfudwfgfgfgfgdwfgdw',
    'Times-Italic': '6y99bodwdwn5lm5y9999dwir6y996y7qdwdwdwdwdwdwdwdwdwdw9999iririrdwpkgzgzijk2gzgzk2k299ccijfgn5ijk2gzk2gzdwfgk2gzn5gzfgfgat7qatbqdw99dwdwccdwcc7qdwdw7q7qcc7qk2dwdwdwdwatat7qdwccijccccatb47nb4f19qdw9q99dwfgopdwdw99rsdw99q89qfg9q9q9999fgfg9qdwop99r8at99ij9qatcc6yatdwdwdwdw7ndw99l47odwir99l499b4ir8c8c99dwej6y998c8mdwkukukudwgzgzgzgzgzgzopijgzgzgzgz99999999k2ijk2k2k2k2k2irk2k2k2k2k2fggzdwdwdwdwdwdwdwijcccccccccc7q7q7q7qdwdwdwdwdwdwdwirdwdwdwdwdwccdwcc',
    'Times-BoldItalic': '6yatffdwdwn5lm7q9999dwfu6y996y7qdwdwdwdwdwdwdwdwdwdw9999fufufudwn4ijijijk2ijijk2lmatdwijgzopk2k2gzk2ijfggzk2ijopijgzgz997q99fudw99dwdwccdwcc99dwfg7q7qdw7qlmfgdwdwdwatat7qfgccijdwccat9o649ofu9qdw9q99dwdwrsdwdw99rsfg99q89qgz9q9q9999dwdw9qdwrs99rsat99k29qatcc6yatdwdwdwdw64dw99kr7edwgu99kr99b4fu8c8c99g0dw6y998c8cdwkukukudwijijijijijijq8ijijijijijatatatatk2k2k2k2k2k2k2fuk2k2k2k2k2gzgzdwdwdwdwdwdwdwk2cccccccccc7q7q7q7qdwfgdwdwdwdwdwfudwfgfgfgfgccdwcc',
  };
  const stdWidthCache = new Map();
  function stdWidths(base) {
    let key = base.replace(/[,-](Regular|Roman)$/i, '').replace(/MT$|PSMT$/, '');
    const bold = /Bold|Black|Heavy/i.test(key);
    const italic = /Italic|Oblique/i.test(key);
    if (/Courier/i.test(key)) key = 'Courier';
    else if (/Helvetica|Arial/i.test(key)) key = bold ? 'Helvetica-Bold' : 'Helvetica';
    else if (/Times/i.test(key))
      key = 'Times-' + (bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : 'Roman');
    else return null;
    if (stdWidthCache.has(key)) return stdWidthCache.get(key);
    const m = new Map();
    const data = STD_WIDTHS[key];
    for (let c = 32; c < 256; c++) m.set(c, data ? parseInt(data.substr((c - 32) * 2, 2), 36) : 600);
    stdWidthCache.set(key, m);
    return m;
  }

  // ---------------------------------------------------------------- content streams

  const mul = (m, n) => [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];

  class PageText {
    constructor(doc) {
      this.doc = doc;
      this.runs = [];
      this.fonts = doc.fonts || (doc.fonts = new Map()); // font ref/dict -> decoder, shared by pages
      this.ops = 0;
    }

    async fontFor(resources, name) {
      const fonts = isDict(resources) ? await this.doc.get(resources.Font) : null;
      const ref = isDict(fonts) ? fonts[name.slice(1)] : null;
      const key = ref instanceof Ref ? ref.num : ref;
      if (key != null && this.fonts.has(key)) return this.fonts.get(key);
      const f = ref ? await loadFont(this.doc, ref) : await loadFont(this.doc, null);
      if (key != null) this.fonts.set(key, f);
      return f;
    }

    async run(bytes, resources, ctm, depth) {
      const lx = new Lexer(bytes, 0, false);
      const st = {
        ctm,
        font: null,
        fs: 1,
        tc: 0,
        tw: 0,
        th: 1,
        tl: 0,
        rise: 0,
        tm: [1, 0, 0, 1, 0, 0],
        tlm: [1, 0, 0, 1, 0, 0],
      };
      const stack = [];
      const marked = []; // marked-content stack: { start, text } when /ActualText replaces the glyphs
      const ops = [];
      for (;;) {
        const t = lx.read();
        if (t === EOF) break;
        if (!(t instanceof Op)) {
          if (ops.length < 64) ops.push(t);
          continue;
        }
        if (++this.ops > MAX_OPS) break;
        const op = t.name;
        const a = ops;
        switch (op) {
          case 'BT':
            st.tm = [1, 0, 0, 1, 0, 0];
            st.tlm = st.tm;
            break;
          case 'q':
            if (stack.length < 64) stack.push({ ...st });
            break;
          case 'Q':
            if (stack.length) Object.assign(st, stack.pop());
            break;
          case 'cm':
            if (a.length >= 6) st.ctm = mul(a.slice(-6), st.ctm);
            break;
          case 'Tf':
            if (a.length >= 2 && typeof a[a.length - 2] === 'string') {
              st.font = await this.fontFor(resources, a[a.length - 2]);
              st.fs = a[a.length - 1];
            }
            break;
          case 'Tc':
            st.tc = +a[0] || 0;
            break;
          case 'Tw':
            st.tw = +a[0] || 0;
            break;
          case 'Tz':
            st.th = (+a[0] || 0) / 100;
            break;
          case 'TL':
            st.tl = +a[0] || 0;
            break;
          case 'Ts':
            st.rise = +a[0] || 0;
            break;
          case 'Td':
          case 'TD':
            if (a.length >= 2) {
              st.tlm = mul([1, 0, 0, 1, +a[0] || 0, +a[1] || 0], st.tlm);
              st.tm = st.tlm;
              if (op === 'TD') st.tl = -(+a[1] || 0);
            }
            break;
          case 'Tm':
            if (a.length >= 6) {
              st.tlm = a.slice(0, 6).map((v) => +v || 0);
              st.tm = st.tlm;
            }
            break;
          case 'T*':
            st.tlm = mul([1, 0, 0, 1, 0, -st.tl], st.tlm);
            st.tm = st.tlm;
            break;
          case 'Tj':
            if (a[0] instanceof PStr) this.show(st, a[0].v);
            break;
          case "'":
            st.tlm = mul([1, 0, 0, 1, 0, -st.tl], st.tlm);
            st.tm = st.tlm;
            if (a[0] instanceof PStr) this.show(st, a[0].v);
            break;
          case '"':
            st.tw = +a[0] || 0;
            st.tc = +a[1] || 0;
            st.tlm = mul([1, 0, 0, 1, 0, -st.tl], st.tlm);
            st.tm = st.tlm;
            if (a[2] instanceof PStr) this.show(st, a[2].v);
            break;
          case 'TJ':
            if (Array.isArray(a[0])) {
              for (const item of a[0]) {
                if (item instanceof PStr) this.show(st, item.v);
                else if (typeof item === 'number') st.tm = mul([1, 0, 0, 1, (-item / 1000) * st.fs * st.th, 0], st.tm);
              }
            }
            break;
          case 'Do':
            if (depth < MAX_XOBJ_DEPTH && typeof a[0] === 'string') await this.xobject(resources, a[0], st.ctm, depth);
            break;
          case 'BI':
            skipInlineImage(lx);
            break;
          case 'BMC':
          case 'BDC':
            if (marked.length < 64)
              marked.push(await this.actualText(resources, op === 'BDC' ? a[a.length - 1] : null));
            break;
          case 'EMC':
            this.applyActualText(marked.pop());
            break;
        }
        ops.length = 0;
      }
    }

    async actualText(resources, props) {
      if (typeof props === 'string') {
        const all = isDict(resources) ? await this.doc.get(resources.Properties) : null;
        props = isDict(all) ? await this.doc.get(all[props.slice(1)]) : null;
      }
      const at = isDict(props) ? await this.doc.get(props.ActualText) : null;
      return at instanceof PStr ? { start: this.runs.length, text: textString(at.v) } : null;
    }

    /** Replaces the runs drawn inside a marked-content span by its /ActualText (ligatures, hyphens). */
    applyActualText(m) {
      if (!m || this.runs.length <= m.start) return;
      const first = this.runs[m.start];
      const last = this.runs[this.runs.length - 1];
      this.runs.length = m.start;
      if (m.text) this.runs.push({ ...first, ex: last.ex, ey: last.ey, text: m.text });
    }

    async xobject(resources, name, ctm, depth) {
      const xobjs = isDict(resources) ? await this.doc.get(resources.XObject) : null;
      const x = isDict(xobjs) ? await this.doc.get(xobjs[name.slice(1)]) : null;
      if (!(x instanceof Stream) || x.dict.Subtype !== '/Form') return;
      if (!this.seenForms) this.seenForms = new Set();
      const matrix = await this.doc.get(x.dict.Matrix);
      const m = Array.isArray(matrix) && matrix.length === 6 ? matrix.map((v) => +v || 0) : [1, 0, 0, 1, 0, 0];
      const res = (await this.doc.get(x.dict.Resources)) || resources;
      await this.run(await this.doc.decodeStream(x), res, mul(m, ctm), depth + 1);
    }

    show(st, s) {
      const f = st.font || DEFAULT_FONT;
      const fs = st.fs;
      let text = '';
      let adv = 0;
      const codes = splitCodes(f, s);
      for (const c of codes) {
        const w = f.widths.has(c.code) ? f.widths.get(c.code) : f.dw;
        let u = f.toUnicode ? cmapLookup(f.toUnicode, c.code) : undefined;
        if (u === undefined) u = f.twoByte ? cidText(f, c.code) : f.uni.get(c.code) || '';
        text += u;
        adv += ((w * f.scale) / 1000) * fs + st.tc + (c.len === 1 && c.code === 32 ? st.tw : 0);
      }
      adv *= st.th;
      const trm = mul(st.tm, st.ctm);
      const x0 = st.rise * trm[2] + trm[4];
      const y0 = st.rise * trm[3] + trm[5];
      st.tm = mul([1, 0, 0, 1, adv, 0], st.tm);
      const trm2 = mul(st.tm, st.ctm);
      const size = Math.abs(fs * f.vscale) * Math.hypot(trm[2], trm[3]) || 1;
      if (text) {
        this.runs.push({ x: x0, y: y0, ex: trm2[4] + st.rise * trm2[2], ey: trm2[5] + st.rise * trm2[3], text, size });
      }
    }
  }

  function cidText(f, cid) {
    if (f.ucs2) return String.fromCharCode(cid);
    if (!f.glyphs) return '';
    const m = f.cidToGid;
    const gid = m ? (m.length >= 2 * cid + 2 ? (m[2 * cid] << 8) | m[2 * cid + 1] : 0) : cid;
    return f.glyphs.get(gid) || '';
  }

  /** GID → Unicode from an embedded TrueType/OpenType 'cmap' table (Unicode subtables only). */
  function trueTypeGlyphMap(data) {
    const rd16 = (o) => (data[o] << 8) | data[o + 1];
    const rd32 = (o) => ((data[o] << 24) | (data[o + 1] << 16) | (data[o + 2] << 8) | data[o + 3]) >>> 0;
    if (data.length < 12) return null;
    let cmap = -1;
    for (let i = 0, n = rd16(4); i < n && 28 + i * 16 <= data.length; i++) {
      const r = 12 + i * 16;
      if (bin(data, r, r + 4) === 'cmap') cmap = rd32(r + 8);
    }
    if (cmap < 0 || cmap + 4 > data.length) return null;
    const subs = [];
    for (let i = 0, n = rd16(cmap + 2); i < n && cmap + 12 + i * 8 <= data.length; i++) {
      const r = cmap + 4 + i * 8;
      const pid = rd16(r);
      const eid = rd16(r + 2);
      const rank = pid === 3 && eid === 10 ? 0 : pid === 0 ? 1 : pid === 3 && eid === 1 ? 2 : -1;
      if (rank >= 0) subs.push({ rank, off: cmap + rd32(r + 4) });
    }
    subs.sort((a, b) => a.rank - b.rank);
    const map = new Map();
    const add = (g, c) => {
      if (g && !map.has(g) && c > 0 && c <= 0x10ffff) map.set(g, String.fromCodePoint(c));
    };
    for (const { off } of subs) {
      if (off + 16 > data.length) continue;
      const fmt = rd16(off);
      if (fmt === 4) {
        const seg2 = rd16(off + 6);
        const ends = off + 14;
        const starts = ends + seg2 + 2;
        const deltas = starts + seg2;
        const ranges = deltas + seg2;
        if (ranges + seg2 > data.length) continue;
        for (let k = 0; k < seg2; k += 2) {
          const end = rd16(ends + k);
          const start = rd16(starts + k);
          const delta = rd16(deltas + k);
          const ro = rd16(ranges + k);
          for (let c = start; c <= end && c < 0xffff; c++) {
            if (!ro) add((c + delta) & 0xffff, c);
            else {
              const at = ranges + k + ro + (c - start) * 2;
              if (at + 2 > data.length) break;
              const g = rd16(at);
              if (g) add((g + delta) & 0xffff, c);
            }
          }
        }
      } else if (fmt === 12) {
        for (let i = 0, n = Math.min(rd32(off + 12), 50000); i < n && off + 28 + i * 12 <= data.length; i++) {
          const r = off + 16 + i * 12;
          const sc = rd32(r);
          const ec = Math.min(rd32(r + 4), sc + 65535);
          for (let c = sc; c <= ec; c++) add(rd32(r + 8) + c - sc, c);
        }
      }
      if (map.size) break;
    }
    return map.size ? map : null;
  }

  /** PDF "text string": UTF-16BE with BOM, UTF-8 with BOM, or PDFDocEncoding (≈ Latin-1). */
  function textString(s) {
    if (s.charCodeAt(0) === 0xfe && s.charCodeAt(1) === 0xff) {
      let out = '';
      for (let i = 2; i + 1 < s.length; i += 2)
        out += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
      return out;
    }
    if (s.startsWith('\xef\xbb\xbf')) return utf8.decode(Uint8Array.from(s.slice(3), (c) => c.charCodeAt(0)));
    let out = '';
    for (let i = 0; i < s.length; i++) out += WIN_ANSI[s.charCodeAt(i)] || s[i];
    return out;
  }

  const DEFAULT_FONT = {
    twoByte: false,
    spaces: null,
    uni: new Map(WIN_ANSI.map((u, i) => [i, u])),
    widths: new Map(),
    dw: 500,
    scale: 1,
    vscale: 1,
    toUnicode: null,
  };

  function splitCodes(f, s) {
    const out = [];
    if (!f.twoByte) {
      for (let i = 0; i < s.length; i++) out.push({ code: s.charCodeAt(i), len: 1 });
      return out;
    }
    const spaces = f.spaces;
    for (let i = 0; i < s.length;) {
      let took = 0;
      if (spaces) {
        let v = 0;
        for (let n = 1; n <= 4 && i + n <= s.length && !took; n++) {
          v = v * 256 + s.charCodeAt(i + n - 1);
          for (const r of spaces) if (r.n === n && v >= r.lo && v <= r.hi) took = n;
          if (took) out.push({ code: v, len: n });
        }
      }
      if (!took) {
        took = Math.min(2, s.length - i);
        out.push({ code: took === 2 ? (s.charCodeAt(i) << 8) | s.charCodeAt(i + 1) : s.charCodeAt(i), len: took });
      }
      i += took;
    }
    return out;
  }

  function skipInlineImage(lx) {
    const b = lx.b;
    // Skip the image dictionary up to ID, then the binary data up to a delimited EI.
    const dict = Object.create(null);
    let key = null;
    for (let n = 0; n < 200; n++) {
      const t = lx.read();
      if (t === EOF) return;
      if (t instanceof Op && t.name === 'ID') break;
      if (key === null && typeof t === 'string' && t[0] === '/') key = t.slice(1);
      else if (key !== null) {
        dict[key] = t;
        key = null;
      }
    }
    let p = lx.p + 1;
    // Unfiltered data has a known size, which may itself contain " EI ".
    const w = dict.W || dict.Width;
    const h = dict.H || dict.Height;
    if (!(dict.F || dict.Filter) && w > 0 && h > 0) {
      const bpc = dict.IM || dict.ImageMask ? 1 : dict.BPC || dict.BitsPerComponent || 8;
      const cs = dict.CS || dict.ColorSpace;
      const comps = cs === '/RGB' || cs === '/DeviceRGB' ? 3 : cs === '/CMYK' || cs === '/DeviceCMYK' ? 4 : 1;
      p += Math.ceil((w * comps * bpc) / 8) * h;
    }
    for (; p + 1 < b.length; p++) {
      if (b[p] === 0x45 && b[p + 1] === 0x49 && WS[b[p - 1]] && (p + 2 >= b.length || WS[b[p + 2]])) break;
    }
    lx.p = p + 2;
  }

  // ---------------------------------------------------------------- layout

  /**
   * Turns positioned text runs into lines. Runs are first rotated into reading
   * orientation (page /Rotate and rotated text), grouped by baseline, split into
   * columns when a tall gutter separates independent text, then joined left→right.
   */
  function layoutPage(runs, rotate) {
    const groups = new Map(); // reading direction -> runs
    const rot = (((rotate || 0) % 360) + 360) % 360;
    for (const r of runs) {
      let [x, y, ex, ey] = [r.x, r.y, r.ex, r.ey];
      if (rot === 90) [x, y, ex, ey] = [y, -x, ey, -ex];
      else if (rot === 180) [x, y, ex, ey] = [-x, -y, -ex, -ey];
      else if (rot === 270) [x, y, ex, ey] = [-y, x, -ey, ex];
      const dx = ex - x;
      const dy = ey - y;
      let dir = 0;
      if (Math.abs(dy) > Math.abs(dx)) dir = dy > 0 ? 1 : 3;
      else if (dx < 0) dir = 2;
      // Rotate each direction into a frame where it reads left→right.
      if (dir === 1) [x, y, ex] = [y, -x, ey];
      else if (dir === 2) [x, y, ex] = [-x, -y, -ex];
      else if (dir === 3) [x, y, ex] = [-y, x, -ey];
      if (!groups.has(dir)) groups.set(dir, []);
      groups.get(dir).push({ x, y, x2: Math.max(ex, x), text: r.text, size: r.size });
    }
    // Upright text first; sideways captions and sidebars after it.
    return [0, 1, 3, 2]
      .filter((d) => groups.has(d))
      .map((d) => layoutBlock(toLines(groups.get(d)), 0))
      .filter(Boolean)
      .join('\n\n');
  }

  function toLines(runs) {
    runs.sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const r of runs) {
      // Compare with the last few lines too: superscripts and sub-lines interleave in y order.
      let line = null;
      for (let k = lines.length - 1; k >= 0 && k >= lines.length - 3; k--) {
        const l = lines[k];
        // Smaller text slightly off the baseline is a superscript/subscript of this line.
        const tol =
          r.size < 0.85 * l.size
            ? 0.45 * l.size
            : 0.3 * Math.min(Math.max(l.size, r.size), 2 * Math.min(l.size, r.size));
        if (Math.abs(l.y - r.y) <= tol) {
          line = l;
          break;
        }
      }
      if (line) {
        line.runs.push(r);
        line.size = Math.max(line.size, r.size);
      } else lines.push({ y: r.y, size: r.size, runs: [r] });
    }
    for (const l of lines) {
      l.runs.sort((a, b) => a.x - b.x);
      // Segments: runs separated by less than ~1 em belong to the same phrase.
      l.segs = [];
      for (const r of l.runs) {
        const s = l.segs[l.segs.length - 1];
        if (s && r.x - s.x2 < Math.max(s.size, r.size)) {
          s.x2 = Math.max(s.x2, r.x2);
          s.chars += r.text.length;
        } else l.segs.push({ x: r.x, x2: r.x2, size: r.size, chars: r.text.length });
      }
    }
    return lines;
  }

  /** Finds a vertical gutter that splits a tall stretch of lines into two independent columns. */
  function findGutter(lines) {
    if (lines.length < 6) return null;
    let minX = Infinity;
    let maxX = -Infinity;
    for (const l of lines) {
      minX = Math.min(minX, l.segs[0].x);
      maxX = Math.max(maxX, l.segs[l.segs.length - 1].x2);
    }
    const width = maxX - minX;
    const height = lines[0].y - lines[lines.length - 1].y;
    if (width <= 0 || height <= 0) return null;
    const cands = new Set();
    for (const l of lines) {
      for (let i = 0; i + 1 < l.segs.length; i++) cands.add(Math.round((l.segs[i].x2 + l.segs[i + 1].x) / 2));
    }
    let best = null;
    for (const g of cands) {
      if (g < minX + 0.1 * width || g > maxX - 0.1 * width) continue;
      let start = 0;
      for (let i = 0; i <= lines.length; i++) {
        const crosses = i < lines.length && lines[i].segs.some((s) => s.x < g && s.x2 > g);
        if (!crosses) continue;
        if (i - start >= 6) best = scoreGutter(lines, start, i, g, width, height, best);
        start = i + 1;
      }
      if (lines.length - start >= 6) best = scoreGutter(lines, start, lines.length, g, width, height, best);
    }
    return best;
  }

  function scoreGutter(lines, from, to, g, width, height, best) {
    const h = lines[from].y - lines[to - 1].y;
    if (h < 0.4 * height) return best;
    let nL = 0;
    let nR = 0;
    let both = 0;
    let lMin = Infinity;
    let lMax = -Infinity;
    let rMin = Infinity;
    let rMax = -Infinity;
    const rightEdges = [];
    const leftEdges = [];
    for (let i = from; i < to; i++) {
      let l = false;
      let r = false;
      for (const s of lines[i].segs) {
        if (s.x2 <= g) {
          l = true;
          lMin = Math.min(lMin, s.x);
          lMax = Math.max(lMax, s.x2);
        } else {
          if (!r) leftEdges.push(s.x);
          r = true;
          rMin = Math.min(rMin, s.x);
          rMax = Math.max(rMax, s.x2);
          rightEdges.push(s.x2);
        }
      }
      nL += l;
      nR += r;
      both += l && r;
    }
    if (nL < 3 || nR < 3) return best;
    const spread = (v) => Math.max(...v) - Math.min(...v);
    // Right-aligned dates/locations beside titles are one row each, not a column of their own.
    const rightAligned = spread(rightEdges) < 2 && spread(leftEdges) > 4;
    const paired = both / Math.min(nL, nR);
    const wide = rMax - rMin >= 0.3 * width && lMax - lMin >= 0.2 * width;
    if (rightAligned || (paired >= 0.6 && !wide)) return best;
    const score = to - from;
    return !best || score > best.score ? { g, from, to, score } : best;
  }

  function layoutBlock(lines, depth) {
    if (!lines.length) return '';
    const gut = depth < 3 ? findGutter(lines) : null;
    if (gut) {
      const pick = (side) =>
        lines
          .slice(gut.from, gut.to)
          .map((l) => ({ ...l, runs: l.runs.filter((r) => (side ? r.x >= gut.g : r.x < gut.g)) }))
          .filter((l) => l.runs.length)
          .map((l) => regroup(l));
      return [
        layoutBlock(lines.slice(0, gut.from), depth + 1),
        layoutBlock(pick(false), depth + 1),
        layoutBlock(pick(true), depth + 1),
        layoutBlock(lines.slice(gut.to), depth + 1),
      ]
        .filter(Boolean)
        .join('\n\n');
    }
    // Paragraph breaks: a gap clearly larger than this block's usual line spacing.
    const gaps = [];
    for (let i = 1; i < lines.length; i++) {
      const dy = lines[i - 1].y - lines[i].y;
      if (dy > 0 && dy < 3 * lines[i].size) gaps.push(dy);
    }
    gaps.sort((a, b) => a - b);
    const usual = gaps.length >= 3 ? gaps[Math.floor(gaps.length / 4)] : 0; // lower quartile: plain line spacing
    let out = '';
    let prev = null;
    for (const line of lines) {
      let s = '';
      let last = null;
      for (const r of line.runs) {
        if (last) {
          const em = Math.max(last.size, r.size);
          const gap = r.x - last.x2;
          if (r.text === last.text && Math.abs(r.x - last.x) < 0.2 * em) continue; // fake-bold overprint
          if (gap > 2 * em) s += GAP;
          else if (gap > 0.2 * em && !/\s$/.test(s) && !/^\s/.test(r.text)) s += ' ';
        }
        s += r.text;
        last = r;
      }
      if (prev) {
        const dy = prev.y - line.y;
        const size = Math.max(prev.size, line.size);
        out += dy > (usual ? Math.max(1.3 * usual, 1.2 * size) : 1.8 * size) ? '\n\n' : '\n';
      }
      out += s;
      prev = line;
    }
    return out;
  }

  function regroup(line) {
    const segs = [];
    for (const r of line.runs) {
      const s = segs[segs.length - 1];
      if (s && r.x - s.x2 < Math.max(s.size, r.size)) s.x2 = Math.max(s.x2, r.x2);
      else segs.push({ x: r.x, x2: r.x2, size: r.size, chars: r.text.length });
    }
    return { ...line, segs };
  }

  // ---------------------------------------------------------------- PDF entry

  async function pdfText(bytes, head) {
    const doc = new PdfDoc(head ? bytes.subarray(head) : bytes);
    try {
      await doc.init();
    } catch (err) {
      if (err && err.userFacing) throw err;
      throw fail(MSG.corrupt);
    }
    const pages = [];
    await collectPages(doc, doc.root.Pages, null, pages, new Set());
    const texts = [];
    for (const page of pages) {
      const pt = new PageText(doc);
      let contents = await doc.get(page.dict.Contents);
      if (!Array.isArray(contents)) contents = contents ? [contents] : [];
      const chunks = [];
      for (const c of contents) {
        const s = await doc.get(c);
        if (s instanceof Stream) chunks.push(await doc.decodeStream(s), new Uint8Array([10]));
      }
      const data = concat(
        chunks,
        chunks.reduce((n, c) => n + c.length, 0),
      );
      try {
        await pt.run(data, page.resources, [1, 0, 0, 1, 0, 0], 0);
      } catch (err) {
        if (err && err.userFacing) throw err;
        doc.warnings.push('Some text on a page could not be read.');
      }
      texts.push(layoutPage(pt.runs, page.rotate));
    }
    const text = texts.join('\n\n');
    if (!text.replace(/\s/g, '')) throw fail(MSG.scanned);
    return { text, kind: 'pdf', pages: pages.length, warnings: doc.warnings };
  }

  async function collectPages(doc, ref, inherited, out, seen) {
    if (out.length >= MAX_PAGES || seen.size > 10000) return;
    const node = await doc.get(ref);
    if (!isDict(node)) return;
    const key = ref instanceof Ref ? ref.num : null;
    if (key != null) {
      if (seen.has(key)) return;
      seen.add(key);
    }
    const res = node.Resources !== undefined ? await doc.get(node.Resources) : inherited && inherited.res;
    const rotate = node.Rotate !== undefined ? await doc.get(node.Rotate) : inherited && inherited.rotate;
    const kids = await doc.get(node.Kids);
    if (Array.isArray(kids) && node.Type !== '/Page') {
      for (const k of kids) await collectPages(doc, k, { res, rotate }, out, seen);
    } else out.push({ dict: node, resources: res, rotate: rotate || 0 });
  }

  const doctext = { extract, fromDataUrl };
  JTF.doctext = doctext;
  if (typeof module === 'object' && module.exports) module.exports = doctext;
})(typeof globalThis !== 'undefined' ? globalThis : this);
