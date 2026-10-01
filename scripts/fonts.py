#!/usr/bin/env python3
"""Rebuild extension/fonts/ (the fonts and hyphenation patterns used by extension/lib/pdfdoc.js).

Downloads Latin Modern Roman (GUST Font License) from CTAN, subsets it to Latin-1 + Latin Extended-A +
common punctuation, converts the CFF outlines to TrueType (PDF FontFile2), re-encodes the GPOS pair
kerning as compact class kerning, and renames the fonts as the GUST licence requests. Also fetches the
British English TeX hyphenation patterns (MIT) from hyph-utf8.

Usage: pip install fonttools && python3 scripts/fonts.py   (deterministic: same inputs, same bytes)
"""

import io
import os
import sys
import urllib.request
from collections import defaultdict

from fontTools import subset
from fontTools.feaLib.builder import addOpenTypeFeaturesFromString
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont, newTable

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'extension', 'fonts')
LM = 'https://mirrors.ctan.org/fonts/lm/fonts/opentype/public/lm/'
HYPH = 'https://raw.githubusercontent.com/hyphenation/tex-hyphen/master/hyph-utf8/tex/generic/hyph-utf8/patterns/'

# output name -> (CTAN file, new family, style). Same design sizes LaTeX picks for an 11pt document:
# cmr10/cmbx10/cmti10/cmcsc10 for text, cmbx12 for the large name.
FONTS = {
    'jtfroman10-regular.ttf': ('lmroman10-regular.otf', 'JTF Roman 10', 'Regular'),
    'jtfroman10-bold.ttf': ('lmroman10-bold.otf', 'JTF Roman 10', 'Bold'),
    'jtfroman10-italic.ttf': ('lmroman10-italic.otf', 'JTF Roman 10', 'Italic'),
    'jtfroman12-bold.ttf': ('lmroman12-bold.otf', 'JTF Roman 12', 'Bold'),
    'jtfromancaps10-regular.ttf': ('lmromancaps10-regular.otf', 'JTF Roman Caps 10', 'Regular'),
}

UNICODES = (
    list(range(0x20, 0x7F))
    + list(range(0xA0, 0x180))  # Latin-1 Supplement + Latin Extended-A
    + [0x0218, 0x0219, 0x021A, 0x021B]  # Romanian comma-below letters
    + [0x02C6, 0x02C7, 0x02D8, 0x02D9, 0x02DA, 0x02DB, 0x02DC, 0x02DD]  # spacing accents
    + list(range(0x2010, 0x2023))  # dashes, quotes, daggers, bullet
    + [0x2026, 0x2030, 0x2032, 0x2033, 0x2039, 0x203A, 0x2044, 0x20AC, 0x2116, 0x2122]
    + [0x2190, 0x2191, 0x2192, 0x2193, 0x2212, 0x2248, 0x2260, 0x2264, 0x2265]
    + list(range(0xFB00, 0xFB05))  # ff fi fl ffi ffl: the cmap already maps the ligature glyphs here
)


def fetch(url):
    with urllib.request.urlopen(url, timeout=60) as res:
        return res.read()


def contours(glyph_set, name):
    pen = RecordingPen()
    glyph_set[name].draw(pen)
    out, cur = [], []
    for op, args in pen.value:
        cur.append((op, tuple((round(x, 3), round(y, 3)) for x, y in args)))
        if op in ('closePath', 'endPath'):
            out.append(tuple(cur))
            cur = []
    return out


def normalized(cs):
    """Contours translated so the first point is the origin, plus that offset."""
    x0, y0 = cs[0][0][1][0]
    key = tuple(tuple((op, tuple((x - x0, y - y0) for x, y in pts)) for op, pts in c) for c in cs)
    return key, (x0, y0)


def find_composites(font):
    """CFF has no composite glyphs, so every accented letter is a full copy of base + accent outlines.
    Find glyphs whose contours are exactly two other glyphs' contours (translated) and rebuild them as
    TrueType composites: this halves the file size."""
    glyph_set = font.getGlyphSet()
    order = font.getGlyphOrder()
    shapes, index = {}, {}
    for name in order:
        cs = contours(glyph_set, name)
        if cs:
            shapes[name] = cs
            key, _ = normalized(cs)
            index.setdefault(key, name)
    composites = {}
    for name, cs in shapes.items():
        for split in range(1, len(cs)):
            parts = []
            for part in (cs[:split], cs[split:]):
                key, (x, y) = normalized(part)
                other = index.get(key)
                if not other or other == name:
                    break
                ox, oy = normalized(shapes[other])[1]
                dx, dy = x - ox, y - oy
                if dx != int(dx) or dy != int(dy):
                    break
                parts.append((other, int(dx), int(dy)))
            if len(parts) == 2 and not any(p[0] in composites for p in parts):
                composites[name] = parts
                break
    return composites


def to_truetype(font, composites, max_err=1.0):
    """CFF -> glyf, following fontTools' Snippets/otf2ttf.py (cubic -> quadratic within max_err units)."""
    order = font.getGlyphOrder()
    glyph_set = font.getGlyphSet()
    glyphs = {}
    for name in order:
        pen = TTGlyphPen(glyph_set)
        parts = composites.get(name)
        if parts and all(p[0] in glyph_set for p in parts):
            for other, dx, dy in parts:
                pen.addComponent(other, (1, 0, 0, 1, dx, dy))
        else:
            glyph_set[name].draw(Cu2QuPen(pen, max_err, reverse_direction=True))
        glyphs[name] = pen.glyph()
    font['loca'] = newTable('loca')
    font['glyf'] = glyf = newTable('glyf')
    glyf.glyphOrder = order
    glyf.glyphs = glyphs
    del font['CFF ']
    glyf.compile(font)
    for name in order:  # left side bearing = xMin in TrueType
        glyph = glyf[name]
        if glyph.isComposite():
            glyph.recalcBounds(glyf)
        font['hmtx'][name] = (font['hmtx'][name][0], getattr(glyph, 'xMin', 0))
    maxp = font['maxp'] = newTable('maxp')
    maxp.tableVersion = 0x00010000
    for attr in (
        'maxZones maxTwilightPoints maxStorage maxFunctionDefs maxInstructionDefs '
        'maxStackElements maxSizeOfInstructions maxComponentElements'
    ).split():
        setattr(maxp, attr, 0)
    maxp.maxZones = 1
    maxp.maxComponentElements = max((len(g.components) for g in glyphs.values() if g.isComposite()), default=0)
    maxp.maxComponentDepth = 1 if maxp.maxComponentElements else 0
    maxp.compile(font)
    post = font['post']
    post.formatType = 3.0  # no glyph names: the PDF ToUnicode CMap carries the text
    font.sfntVersion = '\0\1\0\0'


def kern_pairs(font):
    pairs = {}
    gpos = font['GPOS'].table
    for lookup in gpos.LookupList.Lookup:
        for st in lookup.SubTable:
            if lookup.LookupType == 9:
                st = st.ExtSubTable
            if getattr(st, 'Format', None) == 1 and hasattr(st, 'PairSet'):
                for first, pset in zip(st.Coverage.glyphs, st.PairSet):
                    for rec in pset.PairValueRecord:
                        value = getattr(rec.Value1, 'XAdvance', 0) if rec.Value1 else 0
                        if value:
                            pairs.setdefault((first, rec.SecondGlyph), value)
            elif getattr(st, 'Format', None) == 2:
                raise SystemExit('unexpected class kerning in the source font')
    return pairs


def class_kerning(font, pairs):
    """Replace GPOS with one class-based PairPos lookup: glyphs with identical rows/columns share a class."""
    rows, cols = defaultdict(dict), defaultdict(dict)
    for (a, b), v in pairs.items():
        rows[a][b] = v
    order = {g: i for i, g in enumerate(font.getGlyphOrder())}
    left = defaultdict(list)
    for a, row in rows.items():
        left[tuple(sorted(row.items()))].append(a)
    left_classes = sorted((sorted(gs, key=order.get) for gs in left.values()), key=lambda gs: order[gs[0]])
    for li, gs in enumerate(left_classes):
        for b, v in rows[gs[0]].items():
            cols[b][li] = v
    right = defaultdict(list)
    for b, col in cols.items():
        right[tuple(sorted(col.items()))].append(b)
    right_classes = sorted((sorted(gs, key=order.get) for gs in right.values()), key=lambda gs: order[gs[0]])
    fea = []
    for i, gs in enumerate(left_classes):
        fea.append('@L%d = [%s];' % (i, ' '.join(gs)))
    for i, gs in enumerate(right_classes):
        fea.append('@R%d = [%s];' % (i, ' '.join(gs)))
    fea.append('feature kern {')
    for ri, gs in enumerate(right_classes):
        for li, v in sorted(cols[gs[0]].items()):
            fea.append('  pos @L%d @R%d %d;' % (li, ri, v))
    fea.append('} kern;')
    del font['GPOS']
    addOpenTypeFeaturesFromString(font, '\n'.join(fea))
    return len(left_classes), len(right_classes)


def rename(font, family, style, source):
    ps = (family.replace(' ', '') + '-' + style).replace('JTFRoman', 'JTFRoman')
    name = font['name']
    copyright_ = name.getDebugName(0)
    name.names = []
    for nid, text in (
        (0, copyright_),
        (1, family),
        (2, style),
        (3, 'JobToFill: ' + ps),
        (4, family + ' ' + style),
        (5, 'Version 2.005-jtf'),
        (6, ps),
        (10, 'Subset of %s from the Latin Modern fonts, converted to TrueType for JobToFill.' % source),
        (13, 'GUST Font License, see GUST-FONT-LICENSE.txt and NOTICE.txt'),
        (14, 'https://www.gust.org.pl/projects/e-foundry/licenses'),
    ):
        name.setName(text, nid, 3, 1, 0x409)


def build_font(out_name, source, family, style):
    font = TTFont(io.BytesIO(fetch(LM + source)))
    composites = find_composites(font)
    cmap = font.getBestCmap()
    keep = set(cmap[u] for u in UNICODES if u in cmap)
    components = sorted({p[0] for g in keep if g in composites for p in composites[g]} - keep)
    options = subset.Options()
    options.layout_features = ['kern']
    options.name_IDs = [0]
    options.notdef_outline = True
    options.recalc_bounds = True
    options.drop_tables += ['GSUB', 'FFTM', 'DSIG']
    options.hinting = False
    sub = subset.Subsetter(options)
    sub.populate(unicodes=UNICODES, glyphs=components)
    sub.subset(font)
    pairs = kern_pairs(font)
    to_truetype(font, composites)
    nl, nr = class_kerning(font, pairs)
    rename(font, family, style, source)
    font['head'].created = font['head'].modified = 0x0
    path = os.path.join(OUT, out_name)
    font.save(path, reorderTables=True)
    print('%-28s %6d bytes  %3d glyphs  %4d kern pairs in %dx%d classes' % (
        out_name, os.path.getsize(path), len(font.getGlyphOrder()), len(pairs), nl, nr))


def build_hyphenation():
    """hyph-en-gb patterns and exceptions in one text file; pdfdoc.js skips the % header."""
    tex = fetch(HYPH + 'tex/hyph-en-gb.tex').decode('utf-8')
    header = [line for line in tex.splitlines() if line.startswith('%')][:40]
    pats = fetch(HYPH + 'txt/hyph-en-gb.pat.txt').decode('utf-8').split()
    hyps = fetch(HYPH + 'txt/hyph-en-gb.hyp.txt').decode('utf-8').split()
    lines, line = [], ''
    for p in pats:
        if len(line) + len(p) >= 120:
            lines.append(line)
            line = ''
        line += (' ' if line else '') + p
    lines.append(line)
    body = '\n'.join(header) + '\n%\n% Patterns (left/right hyphenmin 2/3):\n' + '\n'.join(lines)
    body += '\n% Exceptions:\n' + ' '.join(hyps) + '\n'
    with open(os.path.join(OUT, 'hyph-en-gb.txt'), 'w', encoding='utf-8') as f:
        f.write(body)
    print('hyph-en-gb.txt               %6d bytes  %d patterns, %d exceptions' % (len(body.encode()), len(pats), len(hyps)))


def main():
    os.makedirs(OUT, exist_ok=True)
    only = sys.argv[1:]
    for out_name, (source, family, style) in FONTS.items():
        if not only or out_name in only:
            build_font(out_name, source, family, style)
    build_hyphenation()


if __name__ == '__main__':
    main()
