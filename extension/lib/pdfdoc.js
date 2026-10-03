/*
 * JobToFill — PDF writer for cover letters and CVs, typeset the way LaTeX would.
 *
 *   loadFonts(fetchBytes)            → fonts      fetchBytes('jtfroman10-regular.ttf') → Uint8Array
 *   coverLetter(letter, { fonts, paper, fit })   → Promise<{ bytes, pages, fontSize, overflow, missing }>
 *   cv(cv, { fonts, paper, fit })                → same
 *
 * letter = { name, contact: [...], date, salutation, paragraphs: [...], closing, signature }
 * cv     = { name, contact: [...], sections: [{ title, entries: [{ heading, right, subheading, subright,
 *            bullets, text }], lines: [{ label, text }] }] }
 *
 * The letter reproduces a LaTeX article (11pt, 1in margins, \parskip, Computer Modern) measured from a
 * real one: Latin Modern fonts embedded as TrueType, Knuth–Plass paragraph breaking with TeX's
 * badness, demerits, space factors and Liang hyphenation, kerning and f-ligatures. Text stays real
 * text (spaces are space glyphs, with a ToUnicode map), so it copies cleanly and applicant tracking
 * systems can read it. No dependencies; runs in extension pages and in Node.
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});

  const FONT_FILES = {
    regular: 'jtfroman10-regular.ttf',
    bold: 'jtfroman10-bold.ttf',
    italic: 'jtfroman10-italic.ttf',
    title: 'jtfroman12-bold.ttf',
    caps: 'jtfromancaps10-regular.ttf',
  };
  const HYPHENATION_FILE = 'hyph-en-gb.txt';

  // TeX points are 1/72.27 in; PDF points 1/72 in.
  const PT = 72 / 72.27;
  const PAPER = { a4: [595.276, 841.89], letter: [612, 792] };
  const INF = 10000;

  /* ------------------------------------------------------------ TrueType */

  function reader(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
      u8: (o) => view.getUint8(o),
      u16: (o) => view.getUint16(o),
      i16: (o) => view.getInt16(o),
      u32: (o) => view.getUint32(o),
      tag: (o) =>
        String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3)),
    };
  }

  /** The parts of a TrueType font the writer needs: metrics, cmap, pair kerning, names. */
  function parseFont(bytes, key) {
    const r = reader(bytes);
    const tables = {};
    for (let i = 0, n = r.u16(4); i < n; i++) {
      const at = 12 + i * 16;
      tables[r.tag(at)] = { offset: r.u32(at + 8), length: r.u32(at + 12) };
    }
    for (const t of ['head', 'hhea', 'hmtx', 'maxp', 'cmap'])
      if (!tables[t]) throw new Error(`Font ${key}: no ${t} table`);

    const head = tables.head.offset;
    const upm = r.u16(head + 18);
    const bbox = [r.i16(head + 36), r.i16(head + 38), r.i16(head + 40), r.i16(head + 42)];
    const hhea = tables.hhea.offset;
    const numGlyphs = r.u16(tables.maxp.offset + 4);
    const numMetrics = r.u16(hhea + 34);
    const widths = new Uint16Array(numGlyphs);
    for (let g = 0; g < numGlyphs; g++) widths[g] = r.u16(tables.hmtx.offset + Math.min(g, numMetrics - 1) * 4);
    const scale = (v) => Math.round((v * 1000) / upm);

    const font = {
      key,
      bytes,
      upm,
      numGlyphs,
      widths: Array.from(widths, scale),
      bbox: bbox.map(scale),
      ascent: scale(r.i16(hhea + 4)),
      descent: scale(r.i16(hhea + 6)),
      capHeight: 700,
      italicAngle: 0,
      cmap: new Map(),
      kerns: null,
      name: 'JTFRoman',
    };

    // cmap: Windows Unicode, full repertoire (format 12) or BMP (format 4).
    const cmap = tables.cmap.offset;
    let best = null;
    for (let i = 0, n = r.u16(cmap + 2); i < n; i++) {
      const at = cmap + 4 + i * 8;
      const platform = r.u16(at);
      const encoding = r.u16(at + 2);
      const sub = cmap + r.u32(at + 4);
      const format = r.u16(sub);
      const rank = format === 12 ? 3 : format === 4 && (platform === 3 || platform === 0) ? 2 : 0;
      if (rank && (!best || rank > best.rank)) best = { sub, format, rank, platform, encoding };
    }
    if (!best) throw new Error(`Font ${key}: no Unicode cmap`);
    if (best.format === 12) {
      for (let i = 0, n = r.u32(best.sub + 12); i < n; i++) {
        const at = best.sub + 16 + i * 12;
        const start = r.u32(at);
        const end = r.u32(at + 4);
        const gid = r.u32(at + 8);
        for (let c = start; c <= end && c - start < 0x10000; c++) font.cmap.set(c, gid + c - start);
      }
    } else {
      const segs = r.u16(best.sub + 6) / 2;
      const ends = best.sub + 14;
      const starts = ends + segs * 2 + 2;
      const deltas = starts + segs * 2;
      const ranges = deltas + segs * 2;
      for (let i = 0; i < segs; i++) {
        const start = r.u16(starts + i * 2);
        const end = r.u16(ends + i * 2);
        const delta = r.i16(deltas + i * 2);
        const rangeOffset = r.u16(ranges + i * 2);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let gid;
          if (!rangeOffset) gid = (c + delta) & 0xffff;
          else {
            const at = ranges + i * 2 + rangeOffset + (c - start) * 2;
            gid = r.u16(at);
            if (gid) gid = (gid + delta) & 0xffff;
          }
          if (gid) font.cmap.set(c, gid);
        }
      }
    }

    if (tables['OS/2'] && r.u16(tables['OS/2'].offset) >= 2) font.capHeight = scale(r.i16(tables['OS/2'].offset + 88));
    if (tables.post) font.italicAngle = r.i16(tables.post.offset + 4) + r.u16(tables.post.offset + 6) / 65536;
    if (tables.name) font.name = psName(r, tables.name.offset) || font.name;
    if (tables.GPOS) font.kerns = parseKerning(r, tables.GPOS.offset, scale);
    return font;
  }

  function psName(r, at) {
    const count = r.u16(at + 2);
    const strings = at + r.u16(at + 4);
    for (let i = 0; i < count; i++) {
      const rec = at + 6 + i * 12;
      if (r.u16(rec + 6) !== 6) continue;
      const platform = r.u16(rec);
      const length = r.u16(rec + 8);
      const offset = strings + r.u16(rec + 10);
      let s = '';
      if (platform === 3 || platform === 0)
        for (let j = 0; j < length; j += 2) s += String.fromCharCode(r.u16(offset + j));
      else for (let j = 0; j < length; j++) s += String.fromCharCode(r.u8(offset + j));
      if (s) return s.replace(/[^\x21-\x7e]/g, '');
    }
    return '';
  }

  const VALUE_FIELDS = [0x1, 0x2, 0x4, 0x8, 0x10, 0x20, 0x40, 0x80];
  const valueSize = (format) => VALUE_FIELDS.filter((bit) => format & bit).length * 2;
  /** Byte offset of XAdvance inside a ValueRecord, or -1. */
  const xAdvanceAt = (format) => (format & 0x4 ? valueSize(format & 0x3) : -1);

  function coverage(r, at) {
    const map = new Map();
    const format = r.u16(at);
    if (format === 1) for (let i = 0, n = r.u16(at + 2); i < n; i++) map.set(r.u16(at + 4 + i * 2), i);
    else
      for (let i = 0, n = r.u16(at + 2); i < n; i++) {
        const rec = at + 4 + i * 6;
        const start = r.u16(rec);
        const end = r.u16(rec + 2);
        const index = r.u16(rec + 4);
        for (let g = start; g <= end; g++) map.set(g, index + g - start);
      }
    return map;
  }

  function classDef(r, at) {
    const map = new Map();
    const format = r.u16(at);
    if (format === 1) {
      const start = r.u16(at + 2);
      for (let i = 0, n = r.u16(at + 4); i < n; i++) map.set(start + i, r.u16(at + 6 + i * 2));
    } else
      for (let i = 0, n = r.u16(at + 2); i < n; i++) {
        const rec = at + 4 + i * 6;
        for (let g = r.u16(rec); g <= r.u16(rec + 2); g++) map.set(g, r.u16(rec + 4));
      }
    return map;
  }

  /** Pair kerning (GPOS lookup type 2, formats 1 and 2) as a function (left, right) → font units/1000. */
  function parseKerning(r, gpos, scale) {
    const lookups = gpos + r.u16(gpos + 8);
    const tables = [];
    for (let i = 0, n = r.u16(lookups); i < n; i++) {
      const lookup = lookups + r.u16(lookups + 2 + i * 2);
      let type = r.u16(lookup);
      for (let j = 0, m = r.u16(lookup + 4); j < m; j++) {
        let sub = lookup + r.u16(lookup + 6 + j * 2);
        if (type === 9) {
          type = r.u16(sub + 2);
          sub += r.u32(sub + 4);
        }
        if (type !== 2) continue;
        const format = r.u16(sub);
        const cov = coverage(r, sub + r.u16(sub + 2));
        const vf1 = r.u16(sub + 4);
        const vf2 = r.u16(sub + 6);
        const xa = xAdvanceAt(vf1);
        if (xa < 0) continue;
        const recordSize = valueSize(vf1) + valueSize(vf2);
        if (format === 1) {
          const pairs = new Map();
          for (const [glyph, index] of cov) {
            const set = sub + r.u16(sub + 10 + index * 2);
            const inner = new Map();
            for (let k = 0, c = r.u16(set); k < c; k++) {
              const rec = set + 2 + k * (2 + recordSize);
              inner.set(r.u16(rec), scale(r.i16(rec + 2 + xa)));
            }
            pairs.set(glyph, inner);
          }
          tables.push((a, b) => {
            const inner = pairs.get(a);
            return inner ? inner.get(b) : undefined;
          });
        } else if (format === 2) {
          const c1 = classDef(r, sub + r.u16(sub + 8));
          const c2 = classDef(r, sub + r.u16(sub + 10));
          const count2 = r.u16(sub + 14);
          const records = sub + 16;
          tables.push((a, b) => {
            if (!cov.has(a)) return undefined;
            const at = records + ((c1.get(a) || 0) * count2 + (c2.get(b) || 0)) * recordSize + xa;
            return scale(r.i16(at));
          });
        }
      }
    }
    if (!tables.length) return null;
    const cache = new Map();
    return (a, b) => {
      const k = a * 65536 + b;
      if (cache.has(k)) return cache.get(k);
      let v = 0;
      for (const t of tables) {
        const hit = t(a, b);
        if (hit !== undefined) {
          v = hit;
          break;
        }
      }
      cache.set(k, v);
      return v;
    };
  }

  /* ---------------------------------------------------------- hyphenation */

  /** Liang's patterns (TeX's hyphenation) from a hyph-utf8 file: patterns, then "% Exceptions:". */
  function parseHyphenation(text) {
    const patterns = new Map();
    const exceptions = new Map();
    let inExceptions = false;
    let maxLen = 0;
    for (const raw of String(text).split('\n')) {
      if (/^%\s*Exceptions/i.test(raw)) {
        inExceptions = true;
        continue;
      }
      if (/^\s*%/.test(raw)) continue;
      for (const item of raw.trim().split(/\s+/)) {
        if (!item) continue;
        if (inExceptions) {
          exceptions.set(item.replace(/-/g, ''), item);
          continue;
        }
        const letters = item.replace(/\d/g, '');
        const levels = [];
        let pos = 0;
        for (const ch of item) {
          if (/\d/.test(ch)) levels[pos] = +ch;
          else pos++;
        }
        const values = [];
        for (let i = 0; i <= letters.length; i++) values.push(levels[i] || 0);
        patterns.set(letters, values);
        maxLen = Math.max(maxLen, letters.length);
      }
    }
    return { patterns, exceptions, maxLen };
  }

  /** Positions (character indices) where `word` may be hyphenated: at least 2 letters before, 3 after. */
  function hyphenate(word, hy) {
    if (!hy || word.length < 5 || !/^[a-z]+$/.test(word)) return [];
    const ex = hy.exceptions.get(word);
    if (ex) {
      const out = [];
      let i = 0;
      for (const ch of ex) {
        if (ch === '-') out.push(i);
        else i++;
      }
      return out;
    }
    const w = `.${word}.`;
    const levels = new Array(w.length + 1).fill(0);
    for (let i = 0; i < w.length; i++)
      for (let len = 1; len <= hy.maxLen && i + len <= w.length; len++) {
        const p = hy.patterns.get(w.slice(i, i + len));
        if (p) for (let k = 0; k < p.length; k++) levels[i + k] = Math.max(levels[i + k], p[k]);
      }
    const out = [];
    for (let i = 2; i <= word.length - 3; i++) if (levels[i + 1] % 2) out.push(i);
    return out;
  }

  /* --------------------------------------------------------------- fonts */

  async function loadFonts(fetchBytes) {
    const entries = await Promise.all(
      Object.entries(FONT_FILES).map(async ([key, file]) => [key, parseFont(await fetchBytes(file), key)]),
    );
    const fonts = Object.fromEntries(entries);
    try {
      const raw = await fetchBytes(HYPHENATION_FILE);
      fonts.hyphenation = parseHyphenation(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch (err) {
      fonts.hyphenation = null; // letters still set, just without hyphenation
    }
    return fonts;
  }

  // Characters the fonts lack, mapped to ones they have (after trying the accent-free form).
  const FALLBACK = {
    '\u2018': "'",
    '\u2019': "'",
    '\u201a': ',',
    '\u201c': '"',
    '\u201d': '"',
    '\u2013': '-',
    '\u2014': '-',
    '\u2212': '-',
    '\u2010': '-',
    '\u2011': '-',
    '\u2026': '...',
    '\u2022': '\u00b7',
    '\u25cf': '\u00b7',
    '\u00a0': ' ',
    '\u2009': ' ',
    '\u202f': ' ',
    '\u200b': '',
    '\u00ad': '',
    '\u2122': 'TM',
    '\u2192': '->',
  };

  // Ligatures TeX makes in Computer Modern, longest first.
  const LIGATURES = [
    ['ffi', 0xfb03],
    ['ffl', 0xfb04],
    ['ff', 0xfb00],
    ['fi', 0xfb01],
    ['fl', 0xfb02],
  ];

  /**
   * Text → glyphs for one font: ligatures, fallbacks for missing characters, kerning between
   * neighbours. Returns [{ gid, text, width, kern }] where kern is the adjustment before this glyph.
   */
  function shape(text, font, missing) {
    const glyphs = [];
    const chars = Array.from(String(text).normalize('NFC'));
    for (let i = 0; i < chars.length; i++) {
      let lig = null;
      if (chars[i] === 'f')
        for (const [seq, cp] of LIGATURES) {
          if (chars.slice(i, i + seq.length).join('') === seq && font.cmap.has(cp)) {
            lig = { seq, cp };
            break;
          }
        }
      if (lig) {
        const gid = font.cmap.get(lig.cp);
        glyphs.push({ gid, text: lig.seq, width: font.widths[gid] });
        i += lig.seq.length - 1;
        continue;
      }
      for (const ch of substitute(chars[i], font, missing)) {
        const gid = font.cmap.get(ch.codePointAt(0)) || 0;
        glyphs.push({ gid, text: ch, width: font.widths[gid] });
      }
    }
    for (let i = 1; i < glyphs.length; i++)
      glyphs[i].kern = font.kerns ? font.kerns(glyphs[i - 1].gid, glyphs[i].gid) : 0;
    if (glyphs.length) glyphs[0].kern = 0;
    return glyphs;
  }

  function substitute(ch, font, missing) {
    if (font.cmap.has(ch.codePointAt(0))) return [ch];
    const plain = ch.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    if (plain && Array.from(plain).every((c) => font.cmap.has(c.codePointAt(0)))) return Array.from(plain);
    if (ch in FALLBACK) return Array.from(FALLBACK[ch]).filter((c) => font.cmap.has(c.codePointAt(0)));
    if (missing) missing.add(ch);
    return font.cmap.has(63) ? ['?'] : [];
  }

  const glyphsWidth = (glyphs) => glyphs.reduce((w, g) => w + g.width + (g.kern || 0), 0);

  /* ------------------------------------------------------- line breaking */

  // TeX's space factors: more room after sentence ends, a little after commas.
  function spaceFactor(word) {
    const core = word.replace(/[’'”")\]]+$/u, '');
    const last = core.slice(-1);
    const before = core.slice(-2, -1);
    if (/[.!?]/.test(last)) return /\p{Lu}/u.test(before) ? 1000 : 3000;
    if (last === ':') return 2000;
    if (last === ';') return 1500;
    if (last === ',') return 1250;
    return 1000;
  }

  /**
   * A paragraph as Knuth–Plass items. runs: [{ text, font, size }]. Words may cross runs (a bold
   * label then regular text); breaks are allowed at spaces, after explicit hyphens and dashes, and,
   * when `hyph` is given, at hyphenation points.
   */
  function itemize(runs, ctx, hyph) {
    const items = [];
    // Split runs into words that remember their pieces' fonts.
    const words = [];
    let current = null;
    for (const run of runs) {
      const parts = String(run.text).split(/( +|\n)/);
      for (const part of parts) {
        if (!part) continue;
        if (/^ +$|^\n$/.test(part)) {
          current = null;
          words.push({ space: true, run });
          continue;
        }
        if (!current) {
          current = { pieces: [] };
          words.push(current);
        }
        current.pieces.push({ text: part, run });
      }
    }
    let lastWord = '';
    for (let w = 0; w < words.length; w++) {
      const word = words[w];
      if (word.space) {
        if (!items.length || items[items.length - 1].type === 'glue') continue;
        const run = word.run;
        const em = run.size;
        const sf = spaceFactor(lastWord);
        const font = run.font;
        const space = (font.widths[font.cmap.get(32) || 0] || 333) / 1000;
        items.push({
          type: 'glue',
          width: em * (space + (sf >= 2000 ? 0.111 : 0)),
          stretch: (em * space * 0.5 * sf) / 1000,
          shrink: (em * space * (1 / 3) * 1000) / sf,
          run,
        });
        continue;
      }
      for (const piece of word.pieces) {
        const { font, size } = piece.run;
        // Break points inside the piece: after "-" / "–" / "—" (explicit), and hyphenation points.
        const segments = [];
        const re = /[^-–—/]+[-–—/]?|[-–—/]/g;
        let m;
        while ((m = re.exec(piece.text))) segments.push(m[0]);
        segments.forEach((seg, si) => {
          const hard = /[-–—/]$/.test(seg) && si < segments.length - 1;
          const letters = seg.replace(/[-–—/]$/, '');
          // Hyphenate the leading letters of a word (TeX does capitalised words too, not acronyms),
          // never inside an f-ligature, which would break it apart.
          let points = [];
          const core = (letters.match(/^[A-Za-z]+/) || [''])[0];
          if (hyph && core.length >= 5 && !/^[A-Z]{2}/.test(core))
            points = hyphenate(core.toLowerCase(), hyph).filter((p) => !(core[p - 1] === 'f' && /[fil]/.test(core[p])));
          let start = 0;
          const pieces = [];
          for (const p of points) {
            pieces.push(seg.slice(start, p));
            start = p;
          }
          pieces.push(seg.slice(start));
          let prevGlyph = null;
          pieces.forEach((text, pi) => {
            const glyphs = shape(text, font, ctx.missing);
            // The kern across a hyphenation point is its own item, dropped if the line breaks there.
            if (prevGlyph && glyphs.length && font.kerns) {
              const kern = font.kerns(prevGlyph.gid, glyphs[0].gid);
              if (kern) items.push({ type: 'kern', width: (kern * size) / 1000 });
            }
            if (glyphs.length) prevGlyph = glyphs[glyphs.length - 1];
            items.push({ type: 'box', width: (glyphsWidth(glyphs) * size) / 1000, glyphs, run: piece.run });
            if (pi < pieces.length - 1) {
              const hyphen = shape('-', font, ctx.missing);
              items.push({
                type: 'penalty',
                width: (glyphsWidth(hyphen) * size) / 1000,
                penalty: 50,
                flagged: true,
                hyphen,
                run: piece.run,
              });
            }
          });
          if (hard) items.push({ type: 'penalty', width: 0, penalty: 50, flagged: true, run: piece.run });
        });
      }
      lastWord = word.pieces.map((p) => p.text).join('');
    }
    while (items.length && items[items.length - 1].type === 'glue') items.pop();
    // \parfillskip and the forced end of paragraph.
    items.push({ type: 'glue', width: 0, stretch: 1e6, shrink: 0 });
    items.push({ type: 'penalty', width: 0, penalty: -INF, flagged: false });
    return items;
  }

  /** Knuth–Plass total-fit line breaking. Returns break indices, or null if `tolerance` is too strict. */
  function breakLines(items, width, tolerance) {
    const sum = { w: [0], y: [0], z: [0] };
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const isGlue = it.type === 'glue';
      sum.w.push(sum.w[i] + (it.type === 'penalty' ? 0 : it.width));
      sum.y.push(sum.y[i] + (isGlue ? it.stretch : 0));
      sum.z.push(sum.z[i] + (isGlue ? it.shrink : 0));
    }
    // Where the next line starts after a break at i: discardable items are skipped.
    const after = (i) => {
      let j = i + 1;
      while (j < items.length && items[j].type !== 'box' && !(items[j].type === 'penalty' && items[j].penalty === -INF))
        j++;
      return j;
    };
    let active = [{ index: -1, start: 0, line: 0, fitness: 1, demerits: 0, prev: null, flagged: false }];
    for (let b = 0; b < items.length; b++) {
      const it = items[b];
      const legal =
        (it.type === 'penalty' && it.penalty < INF) || (it.type === 'glue' && b > 0 && items[b - 1].type === 'box');
      if (!legal) continue;
      const penalty = it.type === 'penalty' ? it.penalty : 0;
      const extra = it.type === 'penalty' ? it.width : 0;
      const candidates = [];
      const keep = [];
      for (const a of active) {
        const s = a.start;
        const natural = sum.w[b] - sum.w[s] + extra;
        const stretch = sum.y[b] - sum.y[s];
        const shrink = sum.z[b] - sum.z[s];
        let ratio;
        if (natural < width) ratio = stretch > 0 ? (width - natural) / stretch : INF;
        else if (natural > width) ratio = shrink > 0 ? (width - natural) / shrink : -INF;
        else ratio = 0;
        if (ratio < -1 || penalty === -INF) {
          /* deactivate */
        } else keep.push(a);
        if (ratio >= -1 && ratio !== INF) {
          const badness = Math.min(INF, 100 * Math.abs(ratio) ** 3);
          if (badness <= tolerance) {
            let d = (10 + badness) ** 2;
            if (penalty >= 0) d += penalty ** 2;
            else if (penalty > -INF) d -= penalty ** 2;
            if (it.flagged && a.flagged) d += 10000;
            const fitness = ratio < -0.5 ? 0 : ratio <= 0.5 ? 1 : ratio <= 1 ? 2 : 3;
            if (Math.abs(fitness - a.fitness) > 1) d += 10000;
            if (penalty === -INF && a.flagged) d += 5000;
            candidates.push({ a, demerits: a.demerits + d, fitness, ratio });
          }
        } else if (ratio === INF && penalty === -INF) {
          // An empty paragraph end: always acceptable.
          candidates.push({ a, demerits: a.demerits, fitness: 1, ratio: 0 });
        }
      }
      active = keep;
      // Best candidate per fitness class becomes an active node.
      const best = new Map();
      for (const c of candidates) {
        const prev = best.get(c.fitness);
        if (!prev || c.demerits < prev.demerits) best.set(c.fitness, c);
      }
      for (const c of best.values())
        active.push({
          index: b,
          start: after(b),
          line: c.a.line + 1,
          fitness: c.fitness,
          demerits: c.demerits,
          prev: c.a,
          flagged: !!it.flagged,
        });
      if (!active.length) return null;
    }
    const end = active.filter((a) => a.index === items.length - 1).sort((x, y) => x.demerits - y.demerits)[0];
    if (!end) return null;
    const breaks = [];
    for (let n = end; n && n.index >= 0; n = n.prev) breaks.unshift(n.index);
    return breaks;
  }

  /** First-fit fallback for text that can't be set within any tolerance (an over-long word). */
  function greedyBreaks(items, width) {
    const breaks = [];
    let lineWidth = 0;
    let lastGlue = -1;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.type === 'box') lineWidth += it.width;
      else if (it.type === 'glue') {
        if (lineWidth > width && lastGlue >= 0) {
          breaks.push(lastGlue);
          lineWidth = 0;
          for (let j = lastGlue + 1; j <= i; j++) if (items[j].type !== 'penalty') lineWidth += items[j].width;
        }
        lastGlue = i;
        lineWidth += it.width;
      }
    }
    breaks.push(items.length - 1);
    return breaks;
  }

  /**
   * Set a paragraph into lines of `width`. justify=false sets every line at its natural width
   * (ragged right), still breaking where Knuth–Plass would.
   */
  function setParagraph(runs, width, ctx, { justify = true } = {}) {
    let items = itemize(runs, ctx, null);
    // TeX's passes: no hyphenation at \pretolerance, hyphenation at \tolerance, then anything.
    let breaks = breakLines(items, width, 100);
    if (!breaks) {
      items = itemize(runs, ctx, ctx.fonts.hyphenation);
      breaks = breakLines(items, width, 200) || breakLines(items, width, 2000) || breakLines(items, width, INF);
    }
    if (!breaks) breaks = greedyBreaks(items, width);
    const lines = [];
    let start = 0;
    for (const b of breaks) {
      while (start < b && items[start].type !== 'box') start++;
      const slice = items.slice(start, b + 1);
      const end = items[b];
      const body = slice.filter((it, i) => !(i === slice.length - 1 && it.type !== 'box'));
      // Trailing glue before a break is dropped.
      while (body.length && body[body.length - 1].type !== 'box') body.pop();
      const natural =
        body.reduce((w, it) => w + (it.type === 'penalty' ? 0 : it.width), 0) + (end.hyphen ? end.width : 0);
      const stretch = body.reduce((s, it) => s + (it.type === 'glue' ? it.stretch : 0), 0);
      const shrink = body.reduce((s, it) => s + (it.type === 'glue' ? it.shrink : 0), 0);
      const last = end.type === 'penalty' && end.penalty === -INF;
      let ratio = 0;
      if (justify && !last) {
        if (natural < width && stretch > 0) ratio = (width - natural) / stretch;
        else if (natural > width && shrink > 0) ratio = Math.max(-1, (width - natural) / shrink);
      } else if (natural > width && shrink > 0) ratio = Math.max(-1, (width - natural) / shrink);
      lines.push({
        items: body.filter((it) => it.type !== 'penalty'),
        hyphen: end.hyphen ? end : null,
        ratio,
        natural,
      });
      start = b + 1;
    }
    return lines;
  }

  const lineWidth = (line) =>
    line.items.reduce((w, it) => w + (it.type === 'glue' ? glueWidth(it, line.ratio) : it.width), 0) +
    (line.hyphen ? line.hyphen.width : 0);
  const glueWidth = (g, ratio) => g.width + (ratio > 0 ? ratio * g.stretch : ratio * g.shrink);

  /* ----------------------------------------------------------- PDF pages */

  class Page {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.ops = [];
      this.links = [];
    }

    /** Draw a set line with its left end at x and baseline y (from the top of the page). */
    line(line, x, y, doc) {
      const ops = this.ops;
      const by = this.height - y;
      ops.push('BT', `1 0 0 1 ${num(x)} ${num(by)} Tm`);
      let font = null;
      let size = 0;
      let tj = [];
      let pending = 0; // extra advance (pt) before the next glyph
      const flush = () => {
        if (tj.length) ops.push(`[${tj.join(' ')}] TJ`);
        tj = [];
      };
      const use = (run) => {
        if (font === run.font && size === run.size) return;
        if (pending && size) {
          tj.push(num((-pending * 1000) / size));
          pending = 0;
        }
        flush();
        font = run.font;
        size = run.size;
        ops.push(`/${doc.fontId(font)} ${num(size)} Tf`);
      };
      const glyphs = (list, run) => {
        use(run);
        for (const g of list) {
          const adjust = pending + ((g.kern || 0) * size) / 1000;
          if (Math.abs(adjust) > 1e-6) tj.push(num((-adjust * 1000) / size));
          pending = 0;
          tj.push(hex4(g.gid));
          doc.useGlyph(font, g);
        }
      };
      for (const it of line.items) {
        if (it.type === 'box') glyphs(it.glyphs, it.run);
        else if (it.type === 'kern') pending += it.width;
        else if (it.type === 'glue') {
          // A real space glyph (so text extracts with spaces), stretched to the glue's width.
          const run = it.run || { font, size };
          if (!run.font) continue;
          use(run);
          const spaceGid = font.cmap.get(32) || 0;
          const spaceWidth = (font.widths[spaceGid] * size) / 1000;
          glyphs([{ gid: spaceGid, text: ' ', width: font.widths[spaceGid] }], run);
          pending += glueWidth(it, line.ratio) - spaceWidth;
        }
      }
      if (line.hyphen) glyphs(line.hyphen.hyphen, line.hyphen.run);
      flush();
      ops.push('ET');
    }

    rule(x, y, width, thickness) {
      this.ops.push(`${num(x)} ${num(this.height - y - thickness / 2)} ${num(width)} ${num(thickness)} re f`);
    }

    link(x, y, width, ascent, descent, uri) {
      this.links.push({ rect: [x, this.height - y - descent, x + width, this.height - y + ascent], uri });
    }
  }

  const num = (n) => {
    const s = (Math.round(n * 1000) / 1000).toFixed(3).replace(/\.?0+$/, '');
    return s === '-0' ? '0' : s;
  };
  const hex4 = (n) => `<${n.toString(16).padStart(4, '0')}>`;

  function pdfString(s) {
    // UTF-16BE with a byte-order mark, for document info that may hold any name.
    let out = 'FEFF';
    for (const ch of String(s)) {
      const cp = ch.codePointAt(0);
      if (cp > 0xffff) {
        const v = cp - 0x10000;
        out +=
          (0xd800 + (v >> 10)).toString(16).padStart(4, '0') + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0');
      } else out += cp.toString(16).padStart(4, '0');
    }
    return `<${out.toUpperCase()}>`;
  }

  async function deflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  class Doc {
    constructor(width, height, info) {
      this.width = width;
      this.height = height;
      this.info = info;
      this.pages = [];
      this.fonts = new Map(); // font -> { id, glyphs: Map(gid -> text) }
    }

    page() {
      const p = new Page(this.width, this.height);
      this.pages.push(p);
      return p;
    }

    fontId(font) {
      if (!this.fonts.has(font)) this.fonts.set(font, { id: `F${this.fonts.size + 1}`, glyphs: new Map() });
      return this.fonts.get(font).id;
    }

    useGlyph(font, g) {
      const used = this.fonts.get(font).glyphs;
      if (!used.has(g.gid)) used.set(g.gid, g.text);
    }

    async bytes() {
      const enc = new TextEncoder();
      const objects = []; // [ Uint8Array | string ]
      const add = (body) => {
        objects.push(body);
        return objects.length;
      };
      const reserve = () => add(null);
      const stream = async (dict, data, compress = true) => {
        const raw = typeof data === 'string' ? enc.encode(data) : data;
        const body = compress ? await deflate(raw) : raw;
        const head = enc.encode(
          `<< ${dict}${compress ? ' /Filter /FlateDecode' : ''} /Length ${body.length} >>\nstream\n`,
        );
        const tail = enc.encode('\nendstream');
        const out = new Uint8Array(head.length + body.length + tail.length);
        out.set(head, 0);
        out.set(body, head.length);
        out.set(tail, head.length + body.length);
        return out;
      };

      const catalog = reserve();
      const pagesId = reserve();
      const fontRefs = [];
      for (const [font, use] of this.fonts) {
        const name = font.name || 'JTFRoman';
        const file = add(await stream(`/Length1 ${font.bytes.length}`, font.bytes));
        const flags = 32 | (font.italicAngle ? 64 : 0) | 2;
        const descriptor = add(
          `<< /Type /FontDescriptor /FontName /${name} /Flags ${flags} /FontBBox [${font.bbox.join(' ')}] /ItalicAngle ${num(font.italicAngle)} /Ascent ${font.ascent} /Descent ${font.descent} /CapHeight ${font.capHeight} /StemV 80 /FontFile2 ${file} 0 R >>`,
        );
        const gids = [...use.glyphs.keys()].sort((a, b) => a - b);
        const w = gids.map((g) => `${g} [${font.widths[g]}]`).join(' ');
        const cid = add(
          `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /DW 1000 /W [${w}] /CIDToGIDMap /Identity >>`,
        );
        const toUnicode = add(await stream('', cmapFor(use.glyphs)));
        const type0 = add(
          `<< /Type /Font /Subtype /Type0 /BaseFont /${name} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${toUnicode} 0 R >>`,
        );
        fontRefs.push(`/${use.id} ${type0} 0 R`);
      }
      const resources = `<< /Font << ${fontRefs.join(' ')} >> /ProcSet [/PDF /Text] >>`;
      const pageIds = [];
      for (const p of this.pages) {
        const contents = add(await stream('', p.ops.join('\n')));
        const annots = p.links.map((l) =>
          add(
            `<< /Type /Annot /Subtype /Link /Rect [${l.rect.map(num).join(' ')}] /Border [0 0 0] /A << /Type /Action /S /URI /URI ${literal(l.uri)} >> >>`,
          ),
        );
        pageIds.push(
          add(
            `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${num(p.width)} ${num(p.height)}] /Resources ${resources} /Contents ${contents} 0 R${annots.length ? ` /Annots [${annots.map((a) => `${a} 0 R`).join(' ')}]` : ''} >>`,
          ),
        );
      }
      objects[pagesId - 1] =
        `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
      objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
      const d = this.info.date || new Date();
      const stamp = `D:${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
      const info = add(
        `<< /Title ${pdfString(this.info.title || '')} /Author ${pdfString(this.info.author || '')} /Producer (JobToFill) /Creator (JobToFill) /CreationDate (${stamp}) /ModDate (${stamp}) >>`,
      );

      const chunks = [enc.encode('%PDF-1.7\n%\u00e2\u00e3\u00cf\u00d3\n')];
      const offsets = [];
      let length = chunks[0].length;
      objects.forEach((body, i) => {
        offsets.push(length);
        const head = enc.encode(`${i + 1} 0 obj\n`);
        const content = typeof body === 'string' ? enc.encode(body) : body;
        const tail = enc.encode('\nendobj\n');
        chunks.push(head, content, tail);
        length += head.length + content.length + tail.length;
      });
      const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`];
      for (const o of offsets) xref.push(`${String(o).padStart(10, '0')} 00000 n \n`);
      xref.push(
        `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${length}\n%%EOF\n`,
      );
      chunks.push(enc.encode(xref.join('')));
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const out = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.length;
      }
      return out;
    }
  }

  const pad = (n) => String(n).padStart(2, '0');

  function literal(s) {
    return `(${String(s)
      .replace(/[\\()]/g, '\\$&')
      .replace(/[^\x20-\x7e]/g, (c) => encodeURI(c))})`;
  }

  function cmapFor(glyphs) {
    const lines = [...glyphs].sort((a, b) => a[0] - b[0]);
    const body = [];
    for (let i = 0; i < lines.length; i += 100) {
      const chunk = lines.slice(i, i + 100);
      body.push(`${chunk.length} beginbfchar`);
      for (const [gid, text] of chunk) {
        let hex = '';
        for (const ch of text) {
          const cp = ch.codePointAt(0);
          if (cp > 0xffff) {
            const v = cp - 0x10000;
            hex +=
              (0xd800 + (v >> 10)).toString(16).padStart(4, '0') + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0');
          } else hex += cp.toString(16).padStart(4, '0');
        }
        body.push(`${hex4(gid)} <${hex || '0020'}>`);
      }
      body.push('endbfchar');
    }
    return [
      '/CIDInit /ProcSet findresource begin',
      '12 dict begin',
      'begincmap',
      '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
      '/CMapName /Adobe-Identity-UCS def',
      '/CMapType 2 def',
      '1 begincodespacerange',
      '<0000> <FFFF>',
      'endcodespacerange',
      ...body,
      'endcmap',
      'CMapName currentdict /CMapResource defineresource pop',
      'end',
      'end',
    ].join('\n');
  }

  /* ------------------------------------------------------- shared pieces */

  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const DOMAIN = /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i;

  function linkFor(item) {
    const s = String(item || '').trim();
    if (EMAIL.test(s)) return `mailto:${s}`;
    if (DOMAIN.test(s) && /[a-z]/i.test(s)) return /^https?:\/\//i.test(s) ? s : `https://${s}`;
    return null;
  }

  /** A contact item is "text" or { text, href }. */
  function contactItem(c) {
    return c && typeof c === 'object'
      ? { text: String(c.text || '').trim(), href: c.href ? String(c.href) : '' }
      : { text: String(c || '').trim(), href: '' };
  }

  /** "phone | email | site": two interword spaces, a bar, two interword spaces, like the template. */
  function contactLine(page, items, x, y, run, ctx, align = 'left', width = 0) {
    const pieces = items.map(contactItem).filter((c) => c.text);
    if (!pieces.length) return;
    const space = ((run.font.widths[run.font.cmap.get(32)] || 333) * run.size) / 1000;
    const bar = shape('|', run.font, ctx.missing);
    const barWidth = (glyphsWidth(bar) * run.size) / 1000;
    const parts = pieces.map((p) => ({ text: p.text, href: p.href, glyphs: shape(p.text, run.font, ctx.missing) }));
    for (const p of parts) p.width = (glyphsWidth(p.glyphs) * run.size) / 1000;
    const gap = 2 * space;
    const total = parts.reduce((w, p) => w + p.width, 0) + (parts.length - 1) * (gap * 2 + barWidth);
    let cx = align === 'center' ? x + (width - total) / 2 : x;
    const ascent = (run.font.ascent * run.size) / 1000;
    const descent = (-run.font.descent * run.size) / 1000;
    parts.forEach((p, i) => {
      if (i) {
        cx += gap;
        page.line(boxLine(bar, run), cx, y, ctx.doc);
        cx += barWidth + gap;
      }
      page.line(boxLine(p.glyphs, run), cx, y, ctx.doc);
      const uri = p.href || linkFor(p.text);
      if (uri) page.link(cx, y, p.width, ascent * 0.8, descent, uri);
      cx += p.width;
    });
  }

  /** A single unbreakable run of text as a "line". */
  function boxLine(glyphs, run) {
    return { items: [{ type: 'box', glyphs, run, width: (glyphsWidth(glyphs) * run.size) / 1000 }], ratio: 0 };
  }

  function textWidth(text, run, ctx) {
    return (glyphsWidth(shape(text, run.font, ctx.missing)) * run.size) / 1000;
  }

  /* -------------------------------------------------------- cover letter */

  // Measured from a pdfTeX letter (article, 11pt, 1in margins, \parskip): PDF points from the top.
  const LETTER = {
    margin: 72,
    nameSize: 24.7871,
    nameBaseline: 89.213,
    contactGap: 16.538,
    dateGap: 28.494,
    size: 10.9091,
    lead: 13.549,
    parskip: 8.966,
  };

  // Ways to make a long letter fit on one page, mildest first (what a person would try in LaTeX).
  const LETTER_STEPS = [
    { size: 11, parskip: 1 },
    { size: 11, parskip: 0.75 },
    { size: 11, parskip: 0.5 },
    { size: 10.5, parskip: 0.6 },
    { size: 10, parskip: 0.55 },
  ];

  function layLetter(letter, opts, step) {
    const [W, H] = PAPER[opts.paper] || PAPER.a4;
    const f = opts.fonts;
    const ctx = { fonts: f, missing: new Set() };
    const scale = step.size / 11;
    const size = LETTER.size * scale;
    const lead = LETTER.lead * scale;
    const parskip = LETTER.parskip * step.parskip;
    const width = W - 2 * LETTER.margin;
    const bottom = H - LETTER.margin;
    const run = { font: f.regular, size };
    const blocks = [];
    // Lines: [{ line, y }] laid out top to bottom, with page breaks if needed.
    let y = LETTER.nameBaseline;
    const heading = { name: letter.name, nameY: y };
    y += LETTER.contactGap * (step.size < 11 ? 0.95 : 1);
    heading.contactY = y;
    y += LETTER.dateGap * (step.size < 11 ? 0.9 : 1);
    const paragraphs = [
      [letter.date, false],
      [letter.salutation, false],
      ...(letter.paragraphs || []).map((p) => [p, true]),
      [letter.closing, false],
      [letter.signature || letter.name, false],
    ].filter(([t]) => t && String(t).trim());
    paragraphs.forEach(([text, justify], i) => {
      if (i) y += lead + parskip;
      const lines = setParagraph([{ text: String(text).trim().replace(/\s+/g, ' '), ...run }], width, ctx, { justify });
      lines.forEach((line, j) => {
        if (j) y += lead;
        blocks.push({ line, y });
      });
    });
    return { W, H, ctx, heading, blocks, size, lead, width, bottom, fits: y <= bottom + 0.01, run };
  }

  async function coverLetter(letter, opts = {}) {
    if (!opts.fonts) throw new Error('pdfdoc.coverLetter needs { fonts } from loadFonts()');
    const steps = opts.fit === false ? LETTER_STEPS.slice(0, 1) : LETTER_STEPS;
    let lay;
    let step;
    for (step of steps) {
      lay = layLetter(letter, opts, step);
      if (lay.fits) break;
    }
    const doc = new Doc(lay.W, lay.H, {
      title: `Cover letter — ${letter.name || ''}`.trim(),
      author: letter.name || '',
    });
    const ctx = Object.assign(lay.ctx, { doc });
    let page = doc.page();
    const f = opts.fonts;
    if (letter.name)
      page.line(
        boxLineText(letter.name, { font: f.title, size: LETTER.nameSize * (step.size / 11) }, ctx),
        LETTER.margin,
        lay.heading.nameY,
        doc,
      );
    contactLine(page, letter.contact || [], LETTER.margin, lay.heading.contactY, lay.run, ctx);
    // Lines past the bottom margin continue on a new page (only when even the smallest size overflows).
    let offset = 0;
    let lastY = 0;
    for (const b of lay.blocks) {
      let y = b.y - offset;
      if (y > lay.bottom + 0.01) {
        page = doc.page();
        offset = b.y - (LETTER.margin + lay.size);
        y = b.y - offset;
      }
      page.line(b.line, LETTER.margin, y, doc);
      lastY = y;
    }
    return {
      bytes: await doc.bytes(),
      pages: doc.pages.length,
      fontSize: step.size,
      overflow: !lay.fits,
      missing: [...ctx.missing],
      lastBaseline: lastY,
    };
  }

  function boxLineText(text, run, ctx) {
    // Words of a heading set at natural spacing (keeps the space glyphs for copy and paste).
    const lines = setParagraph([{ text: String(text).trim(), ...run }], 1e6, ctx, { justify: false });
    return lines[0];
  }

  /* ------------------------------------------------------------------ CV */

  // The CV reproduces the user's LaTeX template (see lib/cvtex.js): 11pt A4 article, Latin Modern, 0.65in
  // margins, left-aligned \Huge name and contact line, \large bold uppercase section titles over a
  // \titlerule, \hfill rows, itemize with leftmargin=*. TeX points scaled to PDF points.
  const CV = {
    margin: 46.8, // 0.65in
    nameSize: 24.88 * PT, // \Huge at 11pt
    nameHeight: 17.213, // top margin to the name's baseline (same box as the letter's name)
    contactGap: 16.538, // name baseline to contact baseline: baselineskip + \\[3pt]
    size: 10.95 * PT, // \normalsize
    lead: 13.6 * PT, // \baselineskip
    depth: 2.5 * PT, // a typical line's depth
    ascent: 0.694, // x size: height of ascenders
    sectionSize: 12 * PT, // \large
    sectionCap: 0.686, // cap height of the bold title font
    before: 10 * PT, // \titlespacing before
    after: 5 * PT, // \titlespacing after
    ruleGap: 3.4 * PT, // baseline of the title to the \titlerule
    rule: 0.4 * PT,
    itemsep: 1 * PT,
    topsep: 1 * PT,
    entryGap: 4 * PT, // \vspace{4pt} between entries
    labelWidth: 5.475 * PT, // natural width of the bullet label
    labelSep: 5 * PT,
    hfillGap: 10, // least room kept between a row's left and right parts
  };

  // Ways to make a long CV fit on one page, mildest first: spacing before leading before type size,
  // never below 9.5pt.
  const CV_STEPS = [
    { size: 1, space: 1, lead: 1 },
    { size: 1, space: 0.75, lead: 1 },
    { size: 1, space: 0.5, lead: 1 },
    { size: 1, space: 0.35, lead: 0.97 },
    { size: 0.96, space: 0.35, lead: 0.96 },
    { size: 0.92, space: 0.3, lead: 0.95 },
    { size: 9.5 / 10.95, space: 0.25, lead: 0.94 },
  ];

  /** Contact items in rows no wider than `width` (the template's single line when it fits). */
  function contactRows(items, run, ctx, width) {
    const space = ((run.font.widths[run.font.cmap.get(32)] || 333) * run.size) / 1000;
    const bar = (glyphsWidth(shape('|', run.font, ctx.missing)) * run.size) / 1000;
    const rows = [];
    let row = [];
    let w = 0;
    for (const c of items || []) {
      const itemW = textWidth(contactItem(c).text, run, ctx);
      if (!contactItem(c).text) continue;
      const add = row.length ? 4 * space + bar + itemW : itemW;
      if (row.length && w + add > width) {
        rows.push(row);
        row = [];
        w = 0;
      }
      w += row.length ? 4 * space + bar + itemW : itemW;
      row.push(c);
    }
    if (row.length) rows.push(row);
    return rows;
  }

  function layCv(data, opts, step) {
    const [W, H] = PAPER[opts.paper] || PAPER.a4;
    const f = opts.fonts;
    const ctx = { fonts: f, missing: new Set() };
    const m = CV.margin;
    const width = W - 2 * m;
    const bottom = H - m;
    const size = CV.size * step.size;
    const lead = CV.lead * step.size * step.lead;
    const sp = step.space;
    const nameSize = CV.nameSize * Math.min(1, step.size * 1.04);
    const regular = { font: f.regular, size };
    const bold = { font: f.bold, size };
    const italic = { font: f.italic, size };
    const items = [];

    let y = m + CV.nameHeight * (nameSize / CV.nameSize);
    items.push({ kind: 'name', y, text: data.name || '', run: { font: f.title, size: nameSize } });
    const rows = contactRows(data.contact, regular, ctx, width);
    rows.forEach((row, k) => {
      y += k ? lead : CV.contactGap * (0.8 + 0.2 * step.lead);
      items.push({ kind: 'contact', y, row });
    });
    if (!rows.length) y = items[0].y;

    // Where the next line's baseline goes: after a heading it is fixed, otherwise a line below the last.
    let first = null;
    let extra = 0;
    const place = () => {
      y = first != null ? first : y + lead + extra;
      first = null;
      extra = 0;
      return y;
    };
    const put = (lines, x, justify) => {
      lines.forEach((line) => items.push({ kind: 'line', y: place(), line, x }));
    };
    // "left \hfill right": the left part wraps in what the right part leaves, the right part sits on its last line.
    const row = (leftRuns, right, rightRun) => {
      const rightW = right ? textWidth(right, rightRun, ctx) : 0;
      const room = width - (right ? rightW + CV.hfillGap : 0);
      const lines = leftRuns.length ? setParagraph(leftRuns, room, ctx, { justify: false }) : [];
      lines.forEach((line, k) => {
        const ly = place();
        items.push({ kind: 'line', y: ly, line, x: m });
        if (right && k === lines.length - 1) items.push({ kind: 'right', y: ly, text: right, run: rightRun, x: m + width });
      });
      if (right && !lines.length) items.push({ kind: 'right', y: place(), text: right, run: rightRun, x: m + width });
    };

    for (const section of data.sections || []) {
      const entries = section.entries || [];
      const rowsOf = section.lines || [];
      y += CV.depth + CV.before * sp + CV.sectionCap * CV.sectionSize;
      const title = String(section.title || '').toUpperCase();
      const head = items.length;
      items.push({ kind: 'section', y, text: title, run: { font: f.title, size: CV.sectionSize } });
      items.push({ kind: 'rule', y: y + CV.ruleGap });
      first = y + CV.ruleGap + CV.rule + CV.after * sp + CV.ascent * size;
      const gap = (section.entryGap == null ? 4 : section.entryGap) * PT * sp;
      let afterList = false;
      entries.forEach((e, idx) => {
        if (idx) extra += gap + (afterList ? CV.topsep * sp : 0);
        afterList = false;
        const left = [];
        if (e.heading) left.push({ text: e.heading, ...bold });
        if (e.tagline) left.push({ text: `${e.heading ? ' – ' : ''}${e.tagline}`, ...regular });
        if (left.length || e.right) row(left, e.right, italic);
        if (e.subheading || e.subright)
          row(e.subheading ? [{ text: e.subheading, ...regular }] : [], e.subright, italic);
        if (e.text) put(setParagraph([{ text: e.text, ...regular }], width, ctx), m);
        const bullets = e.bullets || [];
        const indent = (CV.labelWidth + CV.labelSep) * step.size;
        bullets.forEach((b, k) => {
          extra += (k ? CV.itemsep : CV.topsep) * sp;
          const lines = setParagraph([{ text: b, ...regular }], width - indent, ctx);
          lines.forEach((line, j) => {
            const ly = place();
            if (!j) items.push({ kind: 'bullet', y: ly, run: regular });
            items.push({ kind: 'line', y: ly, line, x: m + indent });
          });
        });
        afterList = bullets.length > 0;
      });
      rowsOf.forEach((l, idx) => {
        if (idx === 0 && entries.length && afterList) extra += CV.topsep * sp;
        const runs = l.label
          ? [
              { text: `${l.label}:`, ...bold },
              { text: ` ${l.text}`, ...regular },
            ]
          : [{ text: l.text, ...regular }];
        put(setParagraph(runs, width, ctx), m);
      });
      // A title never ends a page on its own: it stays with the first line after it.
      const firstLine = items.slice(head).find((it) => it.kind === 'line' || it.kind === 'right');
      items[head].keepUntil = firstLine ? firstLine.y : y;
      items[head + 1].keepUntil = items[head].keepUntil;
    }
    return { W, H, ctx, items, width, bottom, y, fits: y <= bottom + 2, size, step };
  }

  /** The CV's layout without the PDF: where every line goes (for previews and tests). */
  function layoutCv(data, opts = {}) {
    if (!opts.fonts) throw new Error('pdfdoc.layoutCv needs { fonts } from loadFonts()');
    const steps = opts.fit === false ? CV_STEPS.slice(0, 1) : CV_STEPS;
    let lay;
    for (const step of steps) {
      lay = layCv(data, opts, step);
      if (lay.fits) break;
    }
    return lay;
  }

  async function cv(data, opts = {}) {
    if (!opts.fonts) throw new Error('pdfdoc.cv needs { fonts } from loadFonts()');
    const lay = layoutCv(data, opts);
    const f = opts.fonts;
    const doc = new Doc(lay.W, lay.H, { title: `CV — ${data.name || ''}`.trim(), author: data.name || '' });
    const ctx = Object.assign(lay.ctx, { doc });
    let page = doc.page();
    let offset = 0;
    const m = CV.margin;
    for (const it of lay.items) {
      let y = it.y - offset;
      const limit = it.keepUntil != null ? it.keepUntil - offset : y;
      if (limit > lay.bottom + 0.01 && it.kind !== 'bullet') {
        page = doc.page();
        offset = it.y - (m + lay.size);
        y = it.y - offset;
      }
      if (it.kind === 'name') {
        page.line(boxLineText(it.text, it.run, ctx), m, y, doc);
      } else if (it.kind === 'contact') {
        contactLine(page, it.row, m, y, { font: f.regular, size: lay.size }, ctx);
      } else if (it.kind === 'section') {
        page.line(boxLineText(it.text, it.run, ctx), m, y, doc);
      } else if (it.kind === 'rule') {
        page.rule(m, y, lay.width, CV.rule);
      } else if (it.kind === 'right') {
        const w = textWidth(it.text, it.run, ctx);
        page.line(boxLineText(it.text, it.run, ctx), it.x - w, y, doc);
      } else if (it.kind === 'bullet') {
        page.line(boxLine(shape('•', f.regular, ctx.missing), it.run), m, y, doc);
      } else if (it.kind === 'line') {
        page.line(it.line, it.x, y, doc);
      }
    }
    return {
      bytes: await doc.bytes(),
      pages: doc.pages.length,
      fontSize: Math.round((lay.size / PT) * 100) / 100,
      overflow: !lay.fits,
      missing: [...ctx.missing],
    };
  }

  const pdfdoc = {
    FONT_FILES,
    HYPHENATION_FILE,
    PT,
    loadFonts,
    parseFont,
    parseHyphenation,
    hyphenate,
    shape,
    setParagraph,
    lineWidth,
    coverLetter,
    cv,
    layoutCv,
  };
  JTF.pdfdoc = pdfdoc;
  if (typeof module === 'object' && module.exports) module.exports = pdfdoc;
})(typeof globalThis !== 'undefined' ? globalThis : this);
