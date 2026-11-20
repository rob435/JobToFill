/* JobToFill — the CV check as the settings page and the letter studio show it (ES module): lib/cvcheck.js's findings,
 * the space left on the page, and a thumbnail of the page drawn from its layout. */
import { api, el, plural } from './common.js';

const { pdfdoc } = globalThis.JTF;

let fontsPromise = null;

/** The CV's fonts, loaded once per page (as the studio loads them for the PDF). */
export function cvFonts() {
  if (!fontsPromise)
    fontsPromise = pdfdoc
      .loadFonts(async (path) => {
        const res = await fetch(api.runtime.getURL('fonts/' + path));
        if (!res.ok) throw new Error(`Missing font ${path}`);
        return new Uint8Array(await res.arrayBuffer());
      })
      .catch((err) => {
        fontsPromise = null;
        throw err;
      });
  return fontsPromise;
}

const SVG = 'http://www.w3.org/2000/svg';
/** An SVG element with its attributes. */
function svg(tag, attrs, ...children) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, String(v));
  for (const c of children) if (c) node.append(c);
  return node;
}
const r1 = (n) => Math.round(n * 10) / 10;

/**
 * The page as bars: each line at its real place and width, the flagged ones in the warning colour, what runs past
 * the page in red below its edge, and the free space at the foot shaded.
 */
export function cvThumbnail(result) {
  const { page, layout } = result;
  const last = page.lines.reduce((y, l) => Math.max(y, l.y), 0);
  const height = Math.max(page.H, last + page.margin);
  const flagged = page.lines.filter((l) => l.flag === 'warn').length;
  const label = [
    layout.fits
      ? `One page, ${plural(layout.free.lines, 'line')} free`
      : `${plural(layout.over, 'line')} over the page`,
    flagged ? `${plural(flagged, 'line')} flagged` : '',
  ]
    .filter(Boolean)
    .join(', ');
  const root = svg('svg', {
    class: 'cv-thumb',
    viewBox: `0 0 ${r1(page.W)} ${r1(height)}`,
    role: 'img',
    'aria-label': label,
  });
  root.append(svg('rect', { class: 'sheet', x: 0, y: 0, width: r1(page.W), height: r1(page.H), rx: 4 }));
  if (layout.fits && layout.free.pt > 4) {
    const top = page.bottom - layout.free.pt;
    root.append(
      svg('rect', {
        class: 'free',
        x: page.margin,
        y: r1(top + 3),
        width: r1(page.W - 2 * page.margin),
        height: r1(Math.max(0, page.bottom - top - 3)),
        rx: 3,
      }),
    );
  }
  if (!layout.fits)
    root.append(
      svg('line', { class: 'edge', x1: 0, x2: r1(page.W), y1: r1(page.bottom), y2: r1(page.bottom) }),
      svg('line', { class: 'edge', x1: 0, x2: r1(page.W), y1: r1(page.H), y2: r1(page.H) }),
    );
  for (const l of page.lines) {
    if (!(l.w > 0)) continue;
    root.append(
      svg('rect', {
        class: `bar ${l.kind}${l.flag ? ` ${l.flag}` : ''}`,
        x: r1(l.x),
        y: r1(l.y - l.h),
        width: r1(l.w),
        height: r1(Math.max(l.h, 0.6)),
        rx: l.kind === 'bullet' ? r1(l.h / 2) : 0.8,
      }),
    );
  }
  return root;
}

/** One finding: what it is, the fix, and the bullets or lines it is about. */
function findingView(f) {
  return el(
    'li',
    { className: f.severity },
    el('span', { className: 'what', textContent: f.text }),
    f.fix ? el('span', { className: 'fix', textContent: f.fix }) : null,
    f.items && f.items.length
      ? el(
          'ul',
          {},
          f.items.map((x) => el('li', {}, el('span', { className: 'muted', textContent: `${x.where}: ` }), x.text)),
        )
      : null,
  );
}

/** "One page at 10.95pt · 3 lines free · 2 to fix, 4 notes". */
export function cvHeadline(result) {
  const { layout, counts } = result;
  const page = !layout
    ? ''
    : !layout.fits
      ? `${plural(layout.pages, 'page')}: ${plural(layout.over, 'line')} too long`
      : `One page at ${layout.fontSize}pt${layout.squeezed ? ' (squeezed to fit)' : ''}`;
  const free = layout && layout.fits ? `${plural(layout.free.lines, 'line')} (${layout.free.mm} mm) free` : '';
  const found = counts.warn
    ? `${counts.warn} to fix${counts.info ? `, ${plural(counts.info, 'note')}` : ''}`
    : counts.info
      ? `Nothing to fix, ${plural(counts.info, 'note')}`
      : 'Nothing to fix';
  return [page, free, found].filter(Boolean).join(' · ');
}

/**
 * The check as a block: the headline, the page's thumbnail (with a layout) and the findings, to fix first. `note`
 * says what was checked ("From your CV file’s text: …").
 */
export function cvReport(result, { note = '' } = {}) {
  const list = el('ul', { className: 'cv-findings' }, result.findings.map(findingView));
  return el(
    'div',
    { className: 'cv-check' },
    el('p', { className: 'cv-headline', textContent: cvHeadline(result) }),
    note ? el('p', { className: 'muted small', textContent: note }) : null,
    el(
      'div',
      { className: 'cv-check-body' },
      result.page ? cvThumbnail(result) : null,
      result.findings.length
        ? list
        : el('p', { className: 'muted', textContent: 'Nothing found to fix: every check passed.' }),
    ),
  );
}
