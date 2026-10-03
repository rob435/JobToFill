'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

require('../../extension/lib/pdfdoc.js');
const P = globalThis.JTF.pdfdoc;

const FONTS = path.join(__dirname, '..', '..', 'extension', 'fonts');
const fontsReady = P.loadFonts(async (f) => new Uint8Array(fs.readFileSync(path.join(FONTS, f))));

// pdftotext (poppler) checks the text really extracts; CI machines may not have it.
let pdftotext = null;
try {
  execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
  pdftotext = (bytes) => {
    const file = path.join(
      require('node:os').tmpdir(),
      `jtf-${process.pid}-${Math.random().toString(36).slice(2)}.pdf`,
    );
    fs.writeFileSync(file, bytes);
    try {
      return execFileSync('pdftotext', ['-layout', file, '-']).toString();
    } finally {
      fs.unlinkSync(file);
    }
  };
} catch (err) {
  /* not installed */
}

const PARAGRAPH =
  'I am applying for the Operations Analyst programme in London. I am a second-year Mathematics student at the University of Leeds, graduating in June 2028. Last summer I built a reconciliation tool that checks 40,000 trades a night and flags any break before the morning meeting, which cut the team’s manual checks from three hours to twenty minutes.';

const letter = (paragraphs) => ({
  name: 'Ada Lovelace',
  contact: ['07700 900123', 'ada@example.com', 'github.com/ada'],
  date: '1 October 2026',
  salutation: 'Dear Acme Capital Recruitment Team,',
  paragraphs,
  closing: 'Yours sincerely,',
  signature: 'Ada Lovelace',
});

/** Every xref entry points at "N 0 obj" and startxref at the xref table. */
function assertValidPdf(bytes) {
  const text = Buffer.from(bytes).toString('latin1');
  assert.ok(text.startsWith('%PDF-1.7'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  const startxref = +text.match(/startxref\n(\d+)\n%%EOF\s*$/)[1];
  assert.equal(text.slice(startxref, startxref + 4), 'xref');
  const table = text.slice(startxref).split('\n');
  const count = +table[1].split(' ')[1];
  for (let n = 1; n < count; n++) {
    const offset = +table[2 + n].slice(0, 10);
    assert.equal(text.slice(offset, offset + `${n} 0 obj`.length), `${n} 0 obj`, `object ${n} offset`);
  }
  return text;
}

test('pdfdoc: a cover letter is a valid one-page PDF with embedded fonts, links and real text', async () => {
  const fonts = await fontsReady;
  const out = await P.coverLetter(letter([PARAGRAPH, PARAGRAPH]), { fonts, paper: 'a4', fit: true });
  assert.equal(out.pages, 1);
  assert.equal(out.fontSize, 11);
  assert.equal(out.overflow, false);
  assert.deepEqual(out.missing, []);
  const raw = assertValidPdf(out.bytes);
  assert.match(raw, /\/Subtype \/CIDFontType2/);
  assert.match(raw, /\/FontFile2/);
  assert.match(raw, /\/ToUnicode/);
  assert.match(raw, /\/URI \(mailto:ada@example\.com\)/);
  assert.match(raw, /\/URI \(https:\/\/github\.com\/ada\)/);
  assert.match(raw, /\/MediaBox \[0 0 595\.276 841\.89\]/);
  if (pdftotext) {
    const text = pdftotext(out.bytes).replace(/\s+/g, ' ');
    assert.match(text, /Ada Lovelace 07700 900123 \| ada@example\.com \| github\.com\/ada 1 October 2026 Dear Acme/);
    assert.match(text, /checks 40,000 trades a night/);
    assert.match(text, /team’s manual checks/);
    assert.match(text, /Yours sincerely, Ada Lovelace/);
  }
});

test('pdfdoc: paragraphs are justified to the margin with TeX-style breaks', async () => {
  const fonts = await fontsReady;
  const ctx = { fonts, missing: new Set() };
  const run = { font: fonts.regular, size: 10.9091 };
  const width = 451.276;
  const lines = P.setParagraph([{ text: PARAGRAPH + ' ' + PARAGRAPH, ...run }], width, ctx);
  assert.ok(lines.length >= 6);
  for (const line of lines.slice(0, -1))
    assert.ok(Math.abs(P.lineWidth(line) - width) < 0.01, 'full lines reach the margin');
  assert.ok(P.lineWidth(lines.at(-1)) < width, 'the last line is ragged');
  for (const line of lines) assert.ok(line.ratio >= -1 && line.ratio < 2, 'no overfull or wildly loose lines');
  // Ligatures and kerning are applied.
  const glyphs = P.shape('office fluff', fonts.regular);
  assert.deepEqual(
    glyphs.map((g) => g.text),
    ['o', 'ffi', 'c', 'e', ' ', 'fl', 'u', 'ff'],
  );
  assert.ok(P.shape('AV', fonts.regular)[1].kern < 0, 'A–V is kerned');
});

test('pdfdoc: hyphenation follows TeX’s patterns and exceptions', async () => {
  const { hyphenation } = await fontsReady;
  assert.deepEqual(P.hyphenate('university', hyphenation), [3, 6], 'uni-ver-sity (exception)');
  assert.deepEqual(P.hyphenate('however', hyphenation), [3], 'how-ever (exception)');
  for (const word of ['reconciliation', 'operations', 'programme', 'responsibilities']) {
    const points = P.hyphenate(word, hyphenation);
    assert.ok(points.length > 0, word);
    assert.ok(
      points.every((p) => p >= 2 && p <= word.length - 3),
      `${word}: 2 letters before, 3 after`,
    );
  }
  assert.deepEqual(P.hyphenate('cat', hyphenation), []);
});

test('pdfdoc: a long letter is tightened to fit, a far too long one flows onto a second page', async () => {
  const fonts = await fontsReady;
  const long = await P.coverLetter(letter(Array(10).fill(PARAGRAPH)), { fonts, fit: true });
  assert.equal(long.pages, 1);
  assert.equal(long.fontSize, 10.5, 'one step smaller');
  assert.equal(long.overflow, false);
  const fixed = await P.coverLetter(letter(Array(10).fill(PARAGRAPH)), { fonts, fit: false });
  assert.equal(fixed.pages, 2, 'without fitting it runs onto a second page');
  const huge = await P.coverLetter(letter(Array(14).fill(PARAGRAPH)), { fonts, fit: true });
  assert.equal(huge.overflow, true);
  assert.equal(huge.pages, 2);
  assert.equal(huge.fontSize, 10);
  assertValidPdf(huge.bytes);
});

test('pdfdoc: characters the font lacks fall back or are reported, never crash', async () => {
  const fonts = await fontsReady;
  const out = await P.coverLetter(letter(['Zoë met Łukasz at the café → 日本 office.']), { fonts });
  assert.ok(out.missing.includes('日'), 'reported');
  assert.ok(!out.missing.includes('ë') && !out.missing.includes('Ł'), 'accented Latin is in the fonts');
  if (pdftotext) assert.match(pdftotext(out.bytes), /Zoë met Łukasz at the café/);
  assert.equal((await P.coverLetter(letter([]), { fonts })).pages, 1, 'an empty letter still renders');
});

test('pdfdoc: US Letter paper', async () => {
  const fonts = await fontsReady;
  const out = await P.coverLetter(letter([PARAGRAPH]), { fonts, paper: 'letter' });
  assert.match(assertValidPdf(out.bytes), /\/MediaBox \[0 0 612 792\]/);
});

test('pdfdoc: a CV with sections, right-aligned dates, bullets and skills on one page', async () => {
  const fonts = await fontsReady;
  const data = {
    name: 'Ada Lovelace',
    contact: ['07700 900123', 'ada@example.com', 'linkedin.com/in/ada'],
    sections: [
      {
        title: 'Education',
        entries: [
          {
            heading: 'University of Leeds',
            right: 'Sep 2024 – Jun 2028',
            subheading: 'BSc Mathematics',
            subright: 'Leeds, UK',
            bullets: ['First-class marks in Probability and Statistics'],
          },
        ],
      },
      {
        title: 'Experience',
        entries: [
          {
            heading: 'Northwind',
            right: 'Jun 2025 – Aug 2025',
            subheading: 'Data intern',
            subright: 'London, UK',
            bullets: Array(4).fill(PARAGRAPH.slice(0, 180)),
          },
        ],
      },
      {
        title: 'Skills',
        lines: [
          { label: 'Languages', text: 'Python, SQL, Excel' },
          { label: '', text: 'Chess captain' },
        ],
      },
    ],
  };
  const out = await P.cv(data, { fonts, paper: 'a4', fit: true });
  assert.equal(out.pages, 1);
  assert.equal(out.overflow, false);
  assert.match(assertValidPdf(out.bytes), /\/URI \(https:\/\/linkedin\.com\/in\/ada\)/);
  if (pdftotext) {
    const text = pdftotext(out.bytes);
    assert.match(text, /University of Leeds\s+Sep 2024 – Jun 2028/);
    assert.match(text, /BSc Mathematics\s+Leeds, UK/);
    assert.match(text, /Languages: Python, SQL, Excel/);
  }
  const long = await P.cv({ ...data, sections: Array(6).fill(data.sections[1]) }, { fonts, fit: true });
  assert.equal(long.pages, 2);
  assertValidPdf(long.bytes);
});

/* -------------------------------------------------- the LaTeX template CV */

require('../../extension/lib/cvtex.js');
const TEMPLATE_CV = globalThis.JTF.cvtex.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cv', 'robin-li.tex'), 'utf8'),
).cv;

test('pdfdoc: the template CV lays out on one A4 page at the full 11pt, with real link annotations', async () => {
  const fonts = await fontsReady;
  const out = await P.cv(TEMPLATE_CV, { fonts, paper: 'a4', fit: true });
  assert.equal(out.pages, 1);
  assert.equal(out.overflow, false);
  assert.equal(out.fontSize, 10.95, 'no shrinking was needed');
  assert.deepEqual(out.missing, []);
  const raw = assertValidPdf(out.bytes);
  assert.match(raw, /\/MediaBox \[0 0 595\.276 841\.89\]/);
  assert.match(raw, /\/URI \(mailto:robinlipersonal@gmail\.com\)/);
  assert.match(raw, /\/URI \(https:\/\/github\.com\/rob435\)/);
  assert.equal((raw.match(/\/Subtype \/Link/g) || []).length, 2, 'the phone number is not a link');
  assert.match(raw, /\/Border \[0 0 0\]/, 'hidelinks: no box');
  if (pdftotext) {
    const text = pdftotext(out.bytes);
    assert.match(text, /^Robin Li\n/);
    assert.match(text, /07386 526574 \| robinlipersonal@gmail\.com \| github\.com\/rob435/);
    assert.match(text, /EDUCATION\n/);
    assert.match(text, /University of Glasgow\s+Glasgow, Scotland\nBSc Computing Science\s+Sep 2025 – Jun 2028/);
    assert.match(text, /eBaySpy – eBay deal detector\s+Python, eBay API, SQLite, Telegram/);
    assert.match(text, /• Built a personal finance dashboard/);
    assert.match(text, /Programming\/Data: Python, SQL, Bash, pandas, NumPy/);
  }
});

test('pdfdoc: nothing in the template CV is set past the margins or on top of its neighbour', async () => {
  const fonts = await fontsReady;
  const lay = P.layoutCv(TEMPLATE_CV, { fonts, paper: 'a4', fit: true });
  const left = 46.8;
  const right = lay.W - 46.8;
  const rows = new Map();
  for (const it of lay.items) {
    assert.ok(it.y > left && it.y <= lay.bottom + 2, `inside the page: ${it.kind} at ${it.y}`);
    if (it.kind === 'line') {
      assert.ok(it.x >= left - 0.01, 'starts inside the left margin');
      assert.ok(
        it.x + P.lineWidth(it.line) <= right + 0.5,
        `ends inside the right margin: ${it.x + P.lineWidth(it.line)}`,
      );
      rows.set(it.y, { ...rows.get(it.y), end: it.x + P.lineWidth(it.line) });
    } else if (it.kind === 'right') {
      const width = P.lineWidth(
        P.setParagraph([{ text: it.text, ...it.run }], 1e6, { fonts, missing: new Set() }, { justify: false })[0],
      );
      assert.ok(it.x <= right + 0.01 && it.x - width >= left, 'a right-aligned part stays inside the margins');
      rows.set(it.y, { ...rows.get(it.y), start: it.x - width });
    }
  }
  for (const r of rows.values())
    if (r.end != null && r.start != null) assert.ok(r.end < r.start - 5, 'hfill parts never touch');
  const sections = lay.items.filter((i) => i.kind === 'section');
  assert.deepEqual(
    sections.map((s) => s.text),
    ['EDUCATION', 'EXPERIENCE', 'PROJECTS', 'ACHIEVEMENTS', 'SKILLS'],
  );
  assert.equal(lay.items.filter((i) => i.kind === 'rule').length, 5, 'a rule under every title');
  assert.ok(sections.every((s, k) => !k || s.y > sections[k - 1].y));
});

test('pdfdoc: a CV too long for a page loses spacing before type size, and says so when it still overflows', async () => {
  const fonts = await fontsReady;
  const more = structuredClone(TEMPLATE_CV);
  more.sections[1].entries[0].bullets.push(...Array(3).fill(PARAGRAPH));
  const squeezed = await P.cv(more, { fonts, fit: true });
  assert.equal(squeezed.pages, 1);
  assert.equal(squeezed.fontSize, 10.95, 'tighter spacing was enough, the type stays 11pt');
  const tight = structuredClone(TEMPLATE_CV);
  tight.sections[1].entries[0].bullets.push(...Array(5).fill(PARAGRAPH));
  const small = await P.cv(tight, { fonts, fit: true });
  assert.equal(small.pages, 1);
  assert.ok(small.fontSize < 10.95 && small.fontSize >= 9.5, `type shrinks a little: ${small.fontSize}`);
  const huge = structuredClone(TEMPLATE_CV);
  huge.sections[1].entries[0].bullets.push(...Array(40).fill(PARAGRAPH));
  const over = await P.cv(huge, { fonts, fit: true });
  assert.equal(over.overflow, true, 'overflow is reported, not hidden');
  assert.ok(over.pages > 1);
  assert.ok(over.fontSize >= 9.5, 'never below 9.5pt');
  assertValidPdf(over.bytes);
});

test('pdfdoc: a CV contact item can carry its own link, and a long contact line wraps', async () => {
  const fonts = await fontsReady;
  const data = {
    ...TEMPLATE_CV,
    contact: [
      { text: 'My portfolio', href: 'https://example.com/me?a=1' },
      'a@b.co',
      ...Array(6).fill('+44 (0) 7700 900123 extension'),
    ],
  };
  const out = await P.cv(data, { fonts });
  const raw = assertValidPdf(out.bytes);
  assert.match(raw, /\/URI \(https:\/\/example\.com\/me\?a=1\)/);
  const lay = P.layoutCv(data, { fonts });
  assert.ok(
    lay.items.filter((i) => i.kind === 'contact').length > 1,
    'wrapped onto more rows instead of running off the page',
  );
});
