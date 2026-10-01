'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const doctext = require('../../extension/lib/doctext.js');
const DOCS = path.join(__dirname, '..', 'fixtures', 'docs');
const fixture = (name) => new Uint8Array(fs.readFileSync(path.join(DOCS, name)));
const read = (name, opts = {}) => doctext.extract(fixture(name), { name, ...opts });
const lines = (text) => text.split('\n');

test('doctext: Chromium two-column CV keeps right-aligned dates on the title line', async () => {
  const out = await read('ada-chromium.pdf');
  assert.equal(out.kind, 'pdf');
  assert.equal(out.pages, 1);
  const l = lines(out.text);
  assert.equal(l[0], 'Ada Lovelace');
  assert.ok(l.includes('Lead Programmer, Analytical Engine Project   Jan 2024 – Present'), out.text);
  assert.ok(l.includes('Translator, Scientific Memoirs   Sep 2021 – Dec 2023'));
  assert.ok(l.includes('Private tutoring in mathematics, London   2015 – 2021'));
  assert.ok(l.includes('Languages   English, French, Italian'));
  assert.ok(out.text.includes('Reviewed Charles Babbage’s designs and the engine’s punched-card workflow.'));
  assert.ok(out.text.includes('efficient, first-of-its-kind workflows'));
  // Section headings are separated by a blank line.
  assert.match(out.text, /\n\nExperience\n/);
});

test('doctext: CID fonts without /ToUnicode fall back to the embedded TrueType cmap', async () => {
  const original = fixture('ada-chromium.pdf');
  // Same length keeps every xref offset valid.
  const stripped = Buffer.from(
    Buffer.from(original)
      .toString('latin1')
      .replace(/\/ToUnicode/g, '/ToUnicodX'),
    'latin1',
  );
  assert.notDeepEqual(new Uint8Array(stripped), original);
  assert.equal((await doctext.extract(new Uint8Array(stripped))).text, (await doctext.extract(original)).text);
});

test('doctext: sidebar layout comes out column by column, not interleaved', async () => {
  const out = await read('ada-sidebar.pdf');
  const t = out.text;
  assert.match(t, /^Ada Lovelace\n\nContact\n\n?ada\.lovelace@example\.com\n\+44 20 7946 0000\nLondon, UK\n\nSkills\n/);
  assert.match(t, /\nLanguages\n\n?English \(native\)\nFrench \(fluent\)\nItalian \(good\)\n\nProfile\n/);
  assert.ok(t.includes('\nLead Programmer, Analytical Engine Project   Jan 2024 – Present\n'), t);
  assert.ok(t.endsWith('Private tutoring in mathematics, London   2015 – 2021'));
});

test('doctext: pdf-lib file with standard fonts and object streams', async () => {
  const out = await read('ada-pdflib.pdf');
  assert.equal(out.pages, 2);
  const l = lines(out.text);
  assert.ok(l.includes('Lead Programmer, Analytical Engine Project   Jan 2024 – Present'), out.text);
  assert.ok(l.includes('• Wrote the first published algorithm for computing Bernoulli numbers.'));
  assert.ok(l.includes('Private tutoring in mathematics, London   2015 – 2021'));
  assert.ok(out.text.indexOf('Experience') < out.text.indexOf('Education'), 'pages stay in order');
});

test('doctext: /Differences glyph names, ligatures, TJ spacing, forms, inline images, ActualText, all filters', async () => {
  const out = await read('ada-differences.pdf');
  assert.equal(
    out.text,
    [
      'Ada Lovelace',
      '',
      'Efficient workflow designer',
      'Babbage’s office – Café opening',
      'Lead Programmer   Jan 2024 – Present',
      '',
      'Line one',
      'Line two',
      'Line three',
      'Text from a form XObject',
      '',
      'Page one',
      '',
      'Decoded from an LZW stream, LZW stream.',
      'Run-length too.',
      '',
      'The end.',
    ].join('\n'),
  );
});

test('doctext: broken xref falls back to scanning; incremental updates use the newest xref stream', async () => {
  const broken = await read('ada-broken-xref.pdf');
  assert.match(broken.text, /^Ada Lovelace\n\nEfficient workflow designer\nBabbage’s office/);
  const inc = await read('ada-incremental.pdf');
  assert.equal(inc.text, 'Final CV of Ada Lovelace');
});

test('doctext: encrypted PDFs with an empty user password open; real passwords are refused', async () => {
  for (const name of ['ada-rc4.pdf', 'ada-aes128.pdf']) {
    const out = await read(name);
    assert.equal(out.text, 'Ada Lovelace\nEncrypted CV: Analytical Engine programmer', name);
  }
  assert.equal((await read('ada-aes256.pdf')).text, 'Ada Lovelace\nAES-256 CV');
  await assert.rejects(read('ada-password.pdf'), /password-protected/);
});

test('doctext: DOCX paragraphs, tabs, lists, tables, tracked deletions, field codes, headers', async () => {
  const out = await read('ada-hand.docx');
  assert.equal(out.kind, 'docx');
  assert.equal(
    out.text,
    [
      'ada.lovelace@example.com',
      '',
      'Ada Lovelace',
      'Lead Programmer\tJan 2024 – Present',
      '• Wrote the first algorithm',
      '• Babbage’s engine & notes',
      'Line one',
      'Line two',
      'Languages\tEnglish, French',
      'Maths\tCalculus Logic',
      'ada@example.com',
    ].join('\n'),
  );
});

test('doctext: ODT headings, lists, tabs, spaces, line breaks and tables; comments skipped', async () => {
  const out = await read('ada-hand.odt');
  assert.equal(
    out.text,
    [
      'Ada Lovelace',
      'Lead Programmer\tJan 2024 – Present',
      '• Wrote the first algorithm',
      '• Babbage’s engine',
      'and notes',
      'Languages\tEnglish, French',
      'Ends here.',
    ].join('\n'),
  );
});

test('doctext: format detection uses magic bytes before type and name', async () => {
  const pdf = fixture('ada-differences.pdf');
  assert.equal((await doctext.extract(pdf, { name: 'cv.txt', type: 'text/plain' })).kind, 'pdf');
  assert.equal((await doctext.extract(pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.length))).kind, 'pdf');
  const docx = fixture('ada-hand.docx');
  assert.equal((await doctext.extract(docx, { name: 'cv.pdf' })).kind, 'docx');
});

test('doctext: plain text and Markdown are decoded as UTF-8 without BOM', async () => {
  const bytes = new TextEncoder().encode('\ufeff# Ada Lovelace\r\n\r\n\r\n\r\nCafé   notes\n');
  const out = await doctext.extract(bytes, { name: 'cv.md', type: 'text/markdown' });
  assert.equal(out.kind, 'text');
  assert.equal(out.text, '# Ada Lovelace\n\nCafé notes');
});

test('doctext: fromDataUrl decodes base64 payloads', async () => {
  const b64 = Buffer.from(fixture('ada-pdflib.pdf')).toString('base64');
  const out = await doctext.fromDataUrl(`data:application/pdf;base64,${b64}`, { name: 'cv.pdf' });
  assert.equal(out.kind, 'pdf');
  assert.match(out.text, /^Ada Lovelace/);
  const txt = await doctext.fromDataUrl('data:text/plain;base64,' + Buffer.from('Hello Ada').toString('base64'));
  assert.equal(txt.text, 'Hello Ada');
});

test('doctext: human-readable errors for unsupported, scanned and damaged files', async () => {
  const doc = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
  await assert.rejects(doctext.extract(doc, { name: 'cv.doc' }), /\.doc files are not supported/);
  await assert.rejects(doctext.extract(new Uint8Array(0), { name: 'cv.pdf' }), /empty/);
  await assert.rejects(
    doctext.extract(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]), { name: 'cv.png' }),
    /Unsupported/,
  );
  await assert.rejects(doctext.extract(new TextEncoder().encode('%PDF-1.4\ngarbage'), { name: 'cv.pdf' }), /damaged/);
  // A page whose only content is an image: no text layer.
  const scanned = Buffer.from(
    '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n' +
      '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >> endobj\n' +
      '4 0 obj << /Length 30 >> stream\nq 612 0 0 792 0 0 cm /Im1 Do Q\nendstream endobj\ntrailer << /Root 1 0 R >>\n%%EOF',
  );
  await assert.rejects(doctext.extract(new Uint8Array(scanned), { name: 'scan.pdf' }), /no text layer/);
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
  await assert.rejects(doctext.extract(zip, { name: 'cv.docx' }));
});

test('doctext: a two-page CV extracts quickly', async () => {
  const bytes = fixture('ada-chromium.pdf');
  await doctext.extract(bytes);
  const t0 = performance.now();
  for (let i = 0; i < 5; i++) await doctext.extract(bytes);
  assert.ok((performance.now() - t0) / 5 < 200);
});
