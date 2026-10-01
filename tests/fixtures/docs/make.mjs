// Regenerates the CV fixtures used by tests/unit/doctext.test.js.
// Everything describes a fictional "Ada Lovelace" — never put real personal data here.
//   node tests/fixtures/docs/make.mjs
// Needs LibreOffice (soffice), Playwright's Chromium and pdf-lib (devDependency).
import { execFileSync } from 'node:child_process';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, deflateSync } from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DIR = dirname(fileURLToPath(import.meta.url));
const out = (name, data) => {
  writeFileSync(join(DIR, name), data);
  console.log(name.padEnd(28), String(data.length).padStart(6), 'bytes');
};
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const CV = {
  name: 'Ada Lovelace',
  contact: 'ada.lovelace@example.com | +44 20 7946 0000 | London, UK',
  profile: 'Analytical thinker with a flair for efficient, first-of-its-kind workflows and poetical science.',
  jobs: [
    {
      title: 'Lead Programmer, Analytical Engine Project',
      dates: 'Jan 2024 – Present',
      bullets: [
        'Wrote the first published algorithm for computing Bernoulli numbers.',
        'Reviewed Charles Babbage’s designs and the engine’s punched-card workflow.',
      ],
    },
    {
      title: 'Translator, Scientific Memoirs',
      dates: 'Sep 2021 – Dec 2023',
      bullets: ['Translated and annotated Menabrea’s memoir, tripling its length with notes.'],
    },
  ],
  education: [{ title: 'Private tutoring in mathematics, London', dates: '2015 – 2021' }],
  skills: [
    ['Languages', 'English, French, Italian'],
    ['Mathematics', 'Calculus, Logic, Probability'],
  ],
};

// ---------------------------------------------------------------- LibreOffice (PDF, DOCX, ODT)

function flatOdt() {
  const p = (style, text) => `<text:p text:style-name="${style}">${text}</text:p>`;
  const job = (j) =>
    p('Job', `${esc(j.title)}<text:tab/>${esc(j.dates)}`) +
    `<text:list text:style-name="Bullets">${j.bullets
      .map((b) => `<text:list-item>${p('Standard', esc(b))}</text:list-item>`)
      .join('')}</text:list>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
 xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
 xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
 office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.text">
<office:font-face-decls>
 <style:font-face style:name="Liberation Serif" svg:font-family="'Liberation Serif'" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"/>
</office:font-face-decls>
<office:styles>
 <style:style style:name="Standard" style:family="paragraph"><style:text-properties style:font-name="Liberation Serif" fo:font-size="11pt"/></style:style>
 <style:style style:name="Name" style:family="paragraph"><style:paragraph-properties fo:margin-bottom="0.1in"/><style:text-properties style:font-name="Liberation Serif" fo:font-size="20pt" fo:font-weight="bold"/></style:style>
 <style:style style:name="Heading" style:family="paragraph"><style:paragraph-properties fo:margin-top="0.2in" fo:margin-bottom="0.05in"/><style:text-properties style:font-name="Liberation Serif" fo:font-size="13pt" fo:font-weight="bold"/></style:style>
 <style:style style:name="Job" style:family="paragraph"><style:paragraph-properties><style:tab-stops><style:tab-stop style:position="6.5in" style:type="right"/></style:tab-stops></style:paragraph-properties><style:text-properties style:font-name="Liberation Serif" fo:font-size="11pt" fo:font-weight="bold"/></style:style>
 <text:list-style style:name="Bullets"><text:list-level-style-bullet text:level="1" text:bullet-char="•"><style:list-level-properties text:space-before="0.25in" text:min-label-width="0.2in"/></text:list-level-style-bullet></text:list-style>
</office:styles>
<office:body><office:text>
${p('Name', esc(CV.name))}
${p('Standard', esc(CV.contact))}
${p('Heading', 'Profile')}
${p('Standard', esc(CV.profile) + '<text:s text:c="2"/>Soft' + '\u00ad' + 'hyphen test.')}
${p('Heading', 'Experience')}
${CV.jobs.map(job).join('\n')}
${p('Heading', 'Education')}
${CV.education.map((e) => p('Job', `${esc(e.title)}<text:tab/>${esc(e.dates)}`)).join('')}
${p('Heading', 'Skills')}
<table:table table:name="Skills"><table:table-column table:number-columns-repeated="2"/>
${CV.skills
  .map(
    (r) =>
      `<table:table-row>${r.map((c) => `<table:table-cell office:value-type="string">${p('Standard', esc(c))}</table:table-cell>`).join('')}</table:table-row>`,
  )
  .join('\n')}
</table:table>
</office:text></office:body></office:document>`;
}

function libreOffice() {
  const tmp = mkdtempSync(join(tmpdir(), 'jtf-docs-'));
  try {
    const src = join(tmp, 'ada-libreoffice.fodt');
    writeFileSync(src, flatOdt());
    for (const fmt of ['pdf', 'docx', 'odt']) {
      // Needs the Writer component (libreoffice-writer); core-only installs report "source file could not be loaded".
      execFileSync(
        'soffice',
        ['--headless', `-env:UserInstallation=file://${tmp}/profile`, '--convert-to', fmt, '--outdir', tmp, src],
        {
          stdio: 'ignore',
        },
      );
      out(`ada-libreoffice.${fmt}`, readFileSync(join(tmp, `ada-libreoffice.${fmt}`)));
    }
  } catch (err) {
    console.warn('LibreOffice conversion failed, keeping existing ada-libreoffice.* files:', err.message);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- Chromium print-to-PDF

async function chromium() {
  const { chromium: browserType } = require('playwright');
  const row = (l, r, cls = 'row') => `<div class="${cls}"><span>${esc(l)}</span><span>${esc(r)}</span></div>`;
  const html = `<!doctype html><meta charset="utf-8"><style>
    body { font: 10.5pt Arial, Helvetica, sans-serif; margin: 0; color: #222; }
    h1 { font-size: 22pt; margin: 0 0 2pt; } h2 { font-size: 12pt; margin: 14pt 0 4pt; border-bottom: 1px solid #999; }
    .row { display: flex; justify-content: space-between; font-weight: bold; margin-top: 6pt; }
    ul { margin: 2pt 0 0 16pt; padding: 0; } .grid { display: grid; grid-template-columns: 30% 70%; }
  </style>
  <h1>${esc(CV.name)}</h1><div>${esc(CV.contact)}</div>
  <h2>Profile</h2><p>${esc(CV.profile)}</p>
  <h2>Experience</h2>
  ${CV.jobs.map((j) => row(j.title, j.dates) + `<ul>${j.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`).join('')}
  <h2>Education</h2>${CV.education.map((e) => row(e.title, e.dates)).join('')}
  <h2>Skills</h2><div class="grid">${CV.skills.map(([k, v]) => `<b>${esc(k)}</b><span>${esc(v)}</span>`).join('')}</div>`;
  const browser = await browserType.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html);
    out(
      'ada-chromium.pdf',
      await page.pdf({ format: 'A4', margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' } }),
    );
    // Sidebar layout: a full-width name banner, then a narrow left column and a main column whose
    // baselines do not line up. The two columns must come out one after the other, not interleaved.
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>
      body { font: 10pt Arial, Helvetica, sans-serif; margin: 0; color: #222; }
      h1 { font-size: 24pt; margin: 0 0 12pt; } h2 { font-size: 12pt; margin: 12pt 0 4pt; }
      .cols { display: flex; gap: 24pt; } .side { width: 30%; line-height: 1.6; } .main { flex: 1; line-height: 1.3; }
      .row { display: flex; justify-content: space-between; font-weight: bold; margin-top: 6pt; }
      </style><h1>${esc(CV.name)}</h1>
      <div class="cols"><div class="side">
        <h2>Contact</h2><div>ada.lovelace@example.com</div><div>+44 20 7946 0000</div><div>London, UK</div>
        <h2>Skills</h2><div>Mathematical analysis</div><div>Algorithm design</div><div>Technical writing</div><div>Translation</div>
        <h2>Languages</h2><div>English (native)</div><div>French (fluent)</div><div>Italian (good)</div>
      </div><div class="main">
        <h2>Profile</h2><p>${esc(CV.profile)} ${esc(CV.profile)}</p>
        <h2>Experience</h2>
        ${CV.jobs.map((j) => row(j.title, j.dates) + j.bullets.map((b) => `<p>${esc(b)}</p>`).join('')).join('')}
        <h2>Education</h2>${CV.education.map((e) => row(e.title, e.dates)).join('')}
      </div></div>`);
    out(
      'ada-sidebar.pdf',
      await page.pdf({ format: 'A4', margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' } }),
    );
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------- pdf-lib (standard font, object streams)

async function pdfLib() {
  const { PDFDocument, StandardFonts } = require('pdf-lib');
  const doc = await PDFDocument.create();
  doc.setTitle('Ada Lovelace CV');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage([595, 842]);
  let y = 780;
  const line = (text, { f = font, size = 11, gap = 16, right } = {}) => {
    page.drawText(text, { x: 56, y, size, font: f });
    if (right) page.drawText(right, { x: 539 - f.widthOfTextAtSize(right, size), y, size, font: f });
    y -= gap;
  };
  line(CV.name, { f: bold, size: 20, gap: 24 });
  line(CV.contact, { gap: 30 });
  line('Experience', { f: bold, size: 13, gap: 20 });
  for (const j of CV.jobs) {
    line(j.title, { f: bold, right: j.dates });
    for (const b of j.bullets) line('• ' + b);
    y -= 10;
  }
  page = doc.addPage([595, 842]);
  y = 780;
  line('Education', { f: bold, size: 13, gap: 20 });
  for (const e of CV.education) line(e.title, { f: bold, right: e.dates });
  out('ada-pdflib.pdf', await doc.save({ useObjectStreams: true }));
}

// ---------------------------------------------------------------- hand-written PDFs

/** Assembles "N 0 obj" bodies (strings or {dict, data}) into a PDF with a classic xref. */
function buildPdf(objects, { trailer = '', header = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n' } = {}) {
  const parts = [Buffer.from(header, 'latin1')];
  let len = parts[0].length;
  const offsets = [];
  objects.forEach((o, i) => {
    offsets.push(len);
    const chunks =
      typeof o === 'string'
        ? [`${i + 1} 0 obj\n${o}\nendobj\n`]
        : [`${i + 1} 0 obj\n${o.dict.replace('LEN', o.data.length)}\nstream\n`, o.data, '\nendstream\nendobj\n'];
    for (const c of chunks) {
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c, 'latin1');
      parts.push(b);
      len += b.length;
    }
  });
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailer}>>\nstartxref\n${len}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  return { buf: Buffer.concat(parts), offsets, xrefAt: len };
}

const a85 = (buf) => {
  let s = '';
  for (let i = 0; i < buf.length; i += 4) {
    const chunk = Buffer.alloc(4);
    buf.copy(chunk, 0, i, i + 4);
    const n = Math.min(4, buf.length - i);
    let v = chunk.readUInt32BE(0);
    if (v === 0 && n === 4) {
      s += 'z';
      continue;
    }
    let t = '';
    for (let k = 0; k < 5; k++) {
      t = String.fromCharCode(33 + (v % 85)) + t;
      v = Math.floor(v / 85);
    }
    s += t.slice(0, n + 1);
  }
  return Buffer.from(s + '~>', 'latin1');
};

/** LZW (EarlyChange 1) for short inputs: fewer than 254 new codes, so codes stay 9 bits wide. */
function lzw(data) {
  const bytes = [];
  let acc = 0;
  let nbits = 0;
  const emit = (code) => {
    acc = (acc << 9) | code;
    nbits += 9;
    while (nbits >= 8) {
      bytes.push((acc >>> (nbits - 8)) & 255);
      nbits -= 8;
    }
    acc &= (1 << nbits) - 1;
  };
  const dict = new Map();
  let next = 258;
  let w = '';
  emit(256);
  for (const b of data) {
    const wc = w + String.fromCharCode(b);
    if (wc.length === 1 || dict.has(wc)) {
      w = wc;
      continue;
    }
    emit(w.length === 1 ? w.charCodeAt(0) : dict.get(w));
    dict.set(wc, next++);
    w = String.fromCharCode(b);
  }
  if (w) emit(w.length === 1 ? w.charCodeAt(0) : dict.get(w));
  emit(257);
  if (nbits) bytes.push((acc << (8 - nbits)) & 255);
  if (next > 500) throw new Error('lzw(): input too long for 9-bit codes');
  return Buffer.from(bytes);
}

/** RunLength: one repeated run, then literal chunks. */
function runLength(data) {
  const parts = [Buffer.from([257 - 3]), data.subarray(0, 1)]; // first byte three times
  for (let i = 0; i < data.length; i += 128) {
    const chunk = data.subarray(i, i + 128);
    parts.push(Buffer.from([chunk.length - 1]), chunk);
  }
  parts.push(Buffer.from([128]));
  return Buffer.concat(parts);
}

/**
 * Type1 font with /Differences: ligature glyphs (fi, fl, ffi), quoteright, endash and uniXXXX names;
 * TJ kerning that implies word spaces; a Form XObject; an inline image; /ActualText; Flate, ASCII85, ASCIIHex, LZW and RunLength streams.
 */
function handDifferences() {
  const content = Buffer.from(
    [
      'BT /F1 12 Tf 72 760 Td (Ada Lovelace) Tj ET',
      'BT /F1 10 Tf 72 740 Td [(E)20(\\003cient)-280(work\\002ow)-260(designer)] TJ ET',
      'BT /F1 10 Tf 72 726 Td (Babbage\\005s o\\003ce \\006 Caf\\200 opening) Tj ET',
      'BT /F1 10 Tf 72 712 Td (Lead Programmer) Tj 380 0 Td (Jan 2024 \\006 Present) Tj ET',
      // Inline image whose 8 data bytes contain " EI ": readers must skip W×H bytes, not search.
      'q 1 0 0 1 72 600 cm BI /W 4 /H 2 /CS /G /BPC 8 ID \x00 EI \xff\x00\x01 EI Q',
      'q 1 0 0 1 72 650 cm /Fm1 Do Q',
      // Marked content with /ActualText replaces the glyphs it wraps.
      'BT /F1 10 Tf 72 620 Td /Span << /ActualText <FEFF00500061006700650020006F006E0065> >> BDC (Pg 1) Tj EMC ET',
      'BT /F1 10 Tf 72 680 Td (Line one) Tj 0 -12 TD (Line two) Tj T* (Line three) Tj ET',
    ].join('\n'),
    'latin1',
  );
  const form = Buffer.from('BT /F1 9 Tf 0 0 Td (Text from a form XObject) Tj ET', 'latin1');
  const hex = (b) => Buffer.from(b.toString('hex') + '>', 'latin1');
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 /Resources << /Font << /F1 5 0 R >> /XObject << /Fm1 6 0 R >> >> >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents [4 0 R 7 0 R 8 0 R 9 0 R] >>',
    { dict: '<< /Length LEN /Filter /FlateDecode >>', data: deflateSync(content) },
    '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [1 /fi /fl /ffi /ff /quoteright /endash 128 /uni00E9] >> >>',
    {
      dict: '<< /Type /XObject /Subtype /Form /BBox [0 0 300 50] /Length LEN /Filter [/ASCII85Decode /FlateDecode] >>',
      data: a85(deflateSync(form)),
    },
    {
      dict: '<< /Length LEN /Filter /ASCIIHexDecode >>',
      data: hex(Buffer.from('BT /F1 10 Tf 72 560 Td (The end.) Tj ET')),
    },
    {
      dict: '<< /Length LEN /Filter /LZWDecode >>',
      data: lzw(Buffer.from('BT /F1 10 Tf 72 600 Td (Decoded from an LZW stream, LZW stream.) Tj ET')),
    },
    // Repeated leading spaces from the run are harmless whitespace in the content stream.
    {
      dict: '<< /Length LEN /Filter /RunLengthDecode >>',
      data: runLength(Buffer.from(' BT /F1 10 Tf 72 588 Td (Run-length too.) Tj ET')),
    },
  ]).buf;
}

/**
 * Incremental update: the original page says "Draft", an appended revision with an xref
 * *stream* (PNG Up predictor) replaces the content with "Final".
 */
function handIncremental() {
  const base = buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    { dict: '<< /Length LEN >>', data: Buffer.from('BT /F1 12 Tf 72 700 Td (Draft CV of Ada Lovelace) Tj ET') },
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ]);
  const content = Buffer.from('BT /F1 12 Tf 72 700 Td (Final CV of Ada Lovelace) Tj ET');
  const obj4 = Buffer.concat([
    Buffer.from(`4 0 obj\n<< /Length ${content.length} >>\nstream\n`),
    content,
    Buffer.from('\nendstream\nendobj\n'),
  ]);
  // An unreferenced stale copy of object 4 after the live one: a reader that ignores the
  // xref stream and scans for "4 0 obj" would pick it up.
  const stale = Buffer.from('BT /F1 12 Tf 72 700 Td (Stale CV of Ada Lovelace) Tj ET');
  const orphan = Buffer.concat([
    Buffer.from(`4 0 obj\n<< /Length ${stale.length} >>\nstream\n`),
    stale,
    Buffer.from('\nendstream\nendobj\n'),
  ]);
  const off4 = base.buf.length;
  const off6 = off4 + obj4.length + orphan.length;
  // xref stream rows: type(1) offset(4) gen(1); entries for objects 4 and 6.
  const rows = [
    [1, off4, 0],
    [1, off6, 0],
  ];
  const raw = [];
  let prev = Buffer.alloc(6);
  for (const [t, o, g] of rows) {
    const row = Buffer.alloc(6);
    row[0] = t;
    row.writeUInt32BE(o, 1);
    row[5] = g;
    raw.push(Buffer.from([2]), Buffer.from(row.map((v, i) => (v - prev[i]) & 255)));
    prev = row;
  }
  const data = deflateSync(Buffer.concat(raw));
  const obj6 = Buffer.concat([
    Buffer.from(
      `6 0 obj\n<< /Type /XRef /Size 7 /Root 1 0 R /Prev ${base.xrefAt} /Index [4 1 6 1] /W [1 4 1] ` +
        `/Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 6 >> /Length ${data.length} >>\nstream\n`,
    ),
    data,
    Buffer.from(`\nendstream\nendobj\nstartxref\n${off6}\n%%EOF\n`),
  ]);
  return Buffer.concat([base.buf, obj4, orphan, obj6]);
}

/** The /Differences file with its xref and startxref destroyed: readers must scan for objects. */
function handBroken() {
  const text = handDifferences()
    .toString('latin1')
    .replace(/\nxref\n/, '\nxrfe\n')
    .replace(/startxref\n\d+/, 'startxref\n123456');
  return Buffer.from(text, 'latin1');
}

// ---------------------------------------------------------------- encryption (standard security handler)

const PAD = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');
const md5 = (...parts) => createHash('md5').update(Buffer.concat(parts)).digest();
function rc4(key, data) {
  const s = [...Array(256).keys()];
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const outBuf = Buffer.alloc(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    outBuf[k] = data[k] ^ s[(s[i] + s[j]) & 255];
  }
  return outBuf;
}
const padPw = (pw) => Buffer.concat([Buffer.from(pw, 'latin1'), PAD]).subarray(0, 32);

/** Encrypted one-page CV. aes=false → RC4 128-bit (R3), aes=true → AES-128 (V4/R4). */
function handEncrypted({ aes, userPassword = '' }) {
  const id = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
  const P = -3904;
  const R = aes ? 4 : 3;
  const n = 16;
  // Algorithm 3: owner key.
  let ok = md5(padPw('owner-secret'));
  for (let i = 0; i < 50; i++) ok = md5(ok);
  let O = rc4(ok, padPw(userPassword));
  for (let i = 1; i <= 19; i++)
    O = rc4(
      ok.map((b) => b ^ i),
      O,
    );
  // Algorithm 2: file key.
  const p4 = Buffer.alloc(4);
  p4.writeInt32LE(P);
  let key = md5(padPw(userPassword), O, p4, id);
  for (let i = 0; i < 50; i++) key = md5(key.subarray(0, n));
  key = key.subarray(0, n);
  // Algorithm 5: U.
  let U = rc4(key, md5(PAD, id));
  for (let i = 1; i <= 19; i++)
    U = rc4(
      key.map((b) => b ^ i),
      U,
    );
  U = Buffer.concat([U, Buffer.alloc(16)]);

  const objKey = (num) => {
    const k = md5(
      key,
      Buffer.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, 0, 0]),
      aes ? Buffer.from('sAlT') : Buffer.alloc(0),
    );
    return k.subarray(0, Math.min(16, n + 5));
  };
  const enc = (num, data) => {
    if (!aes) return rc4(objKey(num), data);
    const iv = randomBytes(16);
    const c = createCipheriv('aes-128-cbc', objKey(num), iv);
    return Buffer.concat([iv, c.update(data), c.final()]);
  };
  const hexStr = (num, s) => `<${enc(num, Buffer.from(s, 'latin1')).toString('hex')}>`;
  const content = Buffer.from(
    'BT /F1 14 Tf 72 720 Td (Ada Lovelace) Tj 0 -20 Td /F1 11 Tf (Encrypted CV: Analytical Engine programmer) Tj ET',
  );
  const encDict = aes
    ? `<< /Filter /Standard /V 4 /R 4 /Length 128 /CF << /StdCF << /CFM /AESV2 /AuthEvent /DocOpen /Length 16 >> >> /StmF /StdCF /StrF /StdCF /O <${O.toString('hex')}> /U <${U.toString('hex')}> /P ${P} >>`
    : `<< /Filter /Standard /V 2 /R ${R} /Length 128 /O <${O.toString('hex')}> /U <${U.toString('hex')}> /P ${P} >>`;
  return buildPdf(
    [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
      { dict: '<< /Length LEN /Filter /FlateDecode >>', data: enc(4, deflateSync(content)) },
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
      `<< /Title ${hexStr(6, 'Ada Lovelace CV')} >>`,
      encDict,
    ],
    { trailer: `/Info 6 0 R /Encrypt 7 0 R /ID [<${id.toString('hex')}> <${id.toString('hex')}>] ` },
  ).buf;
}

/** ISO 32000-2 Algorithm 2.B. */
function hash2B(pw, salt, udata) {
  let K = createHash('sha256')
    .update(Buffer.concat([pw, salt, udata]))
    .digest();
  for (let i = 0; ; i++) {
    const K1 = Buffer.concat(Array(64).fill(Buffer.concat([pw, K, udata])));
    const c = createCipheriv('aes-128-cbc', K.subarray(0, 16), K.subarray(16, 32)).setAutoPadding(false);
    const E = Buffer.concat([c.update(K1), c.final()]);
    let sum = 0;
    for (let k = 0; k < 16; k++) sum += E[k];
    K = createHash(['sha256', 'sha384', 'sha512'][sum % 3])
      .update(E)
      .digest();
    if (i >= 63 && E[E.length - 1] <= i - 32) break;
  }
  return K.subarray(0, 32);
}

/** AES-256 (V5/R6) with an empty user password and an owner password. */
function handEncrypted256() {
  const fileKey = randomBytes(32);
  const empty = Buffer.alloc(0);
  const owner = Buffer.from('owner-secret');
  const wrap = (key, data) => {
    const c = createCipheriv('aes-256-cbc', key, Buffer.alloc(16)).setAutoPadding(false);
    return Buffer.concat([c.update(data), c.final()]);
  };
  const [vs, ks, ovs, oks] = [randomBytes(8), randomBytes(8), randomBytes(8), randomBytes(8)];
  const U = Buffer.concat([hash2B(empty, vs, empty), vs, ks]);
  const UE = wrap(hash2B(empty, ks, empty), fileKey);
  const O = Buffer.concat([hash2B(owner, ovs, U), ovs, oks]);
  const OE = wrap(hash2B(owner, oks, U), fileKey);
  const P = -3904;
  const perms = Buffer.concat([
    Buffer.alloc(4),
    Buffer.from([255, 255, 255, 255]),
    Buffer.from('Tadb'),
    randomBytes(4),
  ]);
  perms.writeInt32LE(P, 0);
  const ecb = createCipheriv('aes-256-ecb', fileKey, null).setAutoPadding(false);
  const Perms = Buffer.concat([ecb.update(perms), ecb.final()]);
  const enc = (data) => {
    const iv = randomBytes(16);
    const c = createCipheriv('aes-256-cbc', fileKey, iv);
    return Buffer.concat([iv, c.update(data), c.final()]);
  };
  const content = Buffer.from('BT /F1 14 Tf 72 720 Td (Ada Lovelace) Tj 0 -20 Td /F1 11 Tf (AES-256 CV) Tj ET');
  const hex = (b) => `<${b.toString('hex')}>`;
  return buildPdf(
    [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
      { dict: '<< /Length LEN /Filter /FlateDecode >>', data: enc(deflateSync(content)) },
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
      `<< /Title ${hex(enc(Buffer.from('Ada Lovelace CV')))} >>`,
      `<< /Filter /Standard /V 5 /R 6 /Length 256 /CF << /StdCF << /CFM /AESV3 /AuthEvent /DocOpen /Length 32 >> >> ` +
        `/StmF /StdCF /StrF /StdCF /O ${hex(O)} /U ${hex(U)} /OE ${hex(OE)} /UE ${hex(UE)} /Perms ${hex(Perms)} /P ${P} >>`,
    ],
    {
      trailer:
        '/Info 6 0 R /Encrypt 7 0 R /ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>] ',
    },
  ).buf;
}

// ---------------------------------------------------------------- hand-written DOCX (tiny zip writer)

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content, deflate] of files) {
    const data = Buffer.from(content);
    const body = deflate ? deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(deflate ? 8 : 0, 8);
    head.writeUInt32LE(crc32(data), 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    locals.push(head, nameBuf, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(deflate ? 8 : 0, 10);
    cen.writeUInt32LE(crc32(data), 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** Word features the converter must handle: tracked changes, lists, tabs, breaks, tables, entities. */
function handDocx() {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const run = (t) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
  const para = (inner, list) =>
    `<w:p>${list ? '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>' : ''}${inner}</w:p>`;
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>
${para(run('Ada Lovelace'))}
${para(run('Lead Programmer') + '<w:r><w:tab/></w:r>' + run('Jan 2024 &#8211; Present'))}
${para(run('Wrote the ') + '<w:del w:id="1" w:author="x"><w:r><w:delText>deleted </w:delText></w:r></w:del>' + run('first algorithm'), true)}
${para(run('Babbage&#x2019;s engine &amp; notes'), true)}
${para(run('Line one') + '<w:r><w:br/></w:r>' + run('Line two'))}
<w:tbl><w:tr><w:tc>${para(run('Languages'))}</w:tc><w:tc>${para(run('English, French'))}</w:tc></w:tr>
<w:tr><w:tc>${para(run('Maths'))}</w:tc><w:tc>${para(run('Calculus'))}${para(run('Logic'))}</w:tc></w:tr></w:tbl>
${para('<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> HYPERLINK "x" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>' + run('ada@example.com') + '<w:r><w:fldChar w:fldCharType="end"/></w:r>')}
</w:body></w:document>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>`;
  const header = `<?xml version="1.0" encoding="UTF-8"?><w:hdr ${W}>${para(run('ada.lovelace@example.com'))}</w:hdr>`;
  return zip([
    [
      '[Content_Types].xml',
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
      false,
    ],
    ['word/document.xml', doc, true],
    ['word/_rels/document.xml.rels', rels, false],
    ['word/header1.xml', header, true],
  ]);
}

/** Minimal OpenDocument text: headings, spaces, tabs, line breaks, a list and a table. */
function handOdt() {
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0">
<office:body><office:text>
<text:h text:outline-level="1">Ada Lovelace</text:h>
<text:p>Lead Programmer<text:tab/>Jan 2024 &#x2013; Present</text:p>
<text:list><text:list-item><text:p>Wrote the first<text:s text:c="3"/>algorithm</text:p></text:list-item>
<text:list-item><text:p>Babbage&#x2019;s engine<text:line-break/>and notes</text:p></text:list-item></text:list>
<table:table><table:table-row><table:table-cell><text:p>Languages</text:p></table:table-cell>
<table:table-cell><text:p>English, French</text:p></table:table-cell></table:table-row></table:table>
<text:p>Ends here<office:annotation><text:p>A reviewer comment</text:p></office:annotation>.</text:p>
</office:text></office:body></office:document-content>`;
  return zip([
    ['mimetype', 'application/vnd.oasis.opendocument.text', false],
    ['content.xml', content, true],
  ]);
}

// ---------------------------------------------------------------- main

const only = process.argv[2];
const steps = {
  libreoffice: libreOffice,
  chromium,
  pdflib: pdfLib,
  hand: () => {
    out('ada-differences.pdf', handDifferences());
    out('ada-incremental.pdf', handIncremental());
    out('ada-broken-xref.pdf', handBroken());
    out('ada-rc4.pdf', handEncrypted({ aes: false }));
    out('ada-aes128.pdf', handEncrypted({ aes: true }));
    out('ada-password.pdf', handEncrypted({ aes: false, userPassword: 'secret' }));
    out('ada-aes256.pdf', handEncrypted256());
    out('ada-hand.docx', handDocx());
    out('ada-hand.odt', handOdt());
  },
};
for (const [name, fn] of Object.entries(steps)) if (!only || only === name) await fn();
