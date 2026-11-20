'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require('../../extension/lib/pdfdoc.js');
require('../../extension/lib/cvtex.js');
require('../../extension/lib/cvcheck.js');
const { pdfdoc: P, cvtex, cvcheck: K } = globalThis.JTF;

const FONTS = path.join(__dirname, '..', '..', 'extension', 'fonts');
const fontsReady = P.loadFonts(async (f) => new Uint8Array(fs.readFileSync(path.join(FONTS, f))));
const TEMPLATE_CV = cvtex.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cv', 'robin-li.tex'), 'utf8'),
).cv;
// 20 November 2026: a degree ending in 2028 is still being studied.
const NOW = Date.UTC(2026, 10, 20);

/** A one-section CV of bullets under an Experience entry, with a full contact line. */
const cvOf = (bullets, more = {}) => ({
  name: 'Ada Example',
  contact: ['07700 900123', 'ada@example.com', 'linkedin.com/in/ada'],
  sections: [
    {
      title: 'Experience',
      entries: [{ heading: 'Acme Capital', right: 'London', subheading: 'Analyst', subright: 'Jun 2025', bullets }],
      lines: [],
    },
  ],
  ...more,
});
const ids = (r) => r.findings.map((f) => f.id);
const find = (r, id) => r.findings.find((f) => f.id === id);
// Its last line is the one word “and.”, as the layout sets it (the short-line test below proves it).
const STRANDED =
  'Cleaned around 5,000 transactions with pandas, fixing missing values and inconsistent merchant names and.';

test('cvcheck: every laid-out line knows its section, entry, bullet and place, and the layout draws as before', async () => {
  const fonts = await fontsReady;
  const lay = P.layoutCv(TEMPLATE_CV, { fonts, fit: true });
  assert.equal(lay.stepIndex, 0);
  assert.ok(lay.lead > 0 && lay.margin > 0);
  const lines = lay.items.filter((i) => i.kind === 'line');
  assert.ok(lines.every((l) => l.src && Number.isInteger(l.src.section) && l.src.line < l.src.of));
  const bullets = lines.filter((l) => l.src.part === 'bullet');
  assert.deepEqual(
    [...new Set(bullets.map((l) => `${l.src.section}.${l.src.entry}.${l.src.bullet}`))],
    ['1.0.0', '1.0.1', '1.0.2', '2.0.0', '2.0.1', '2.1.0', '2.1.1', '2.1.2'],
  );
  // The width a bullet was set in, so it can be set again: its lines fill it.
  for (const l of bullets.filter((x) => x.src.line < x.src.of - 1))
    assert.ok(Math.abs(P.lineWidth(l.line) - l.src.width) < 0.5, 'a justified line fills the width it was set in');
  assert.deepEqual(
    lay.items.filter((i) => i.kind === 'line' && i.src.part === 'row').map((l) => `${l.src.section}.r${l.src.row}`),
    ['3.r0', '3.r1', '4.r0', '4.r1', '4.r2', '4.r3'],
  );
});

test('cvcheck: the template CV, one page with room to spare, a degree without grades and bullets without a number', async () => {
  const fonts = await fontsReady;
  const r = K.check(TEMPLATE_CV, { fonts, now: NOW });
  assert.equal(r.layout.pages, 1);
  assert.equal(r.layout.fits, true);
  assert.equal(r.layout.fontSize, 10.95);
  assert.equal(r.layout.squeezed, 0);
  assert.ok(r.layout.free.lines >= 6 && r.layout.free.mm > 20, JSON.stringify(r.layout.free));
  assert.match(find(r, 'space').text, /^One page, with \d+ lines \(\d+ mm\) free at the bottom\.$/);
  assert.match(find(r, 'space').fix, /Room for another bullet/);
  // The two bullets that ended on one or two words were fixed by hand: none is left.
  assert.equal(find(r, 'short-line'), undefined);
  assert.equal(r.counts.short, 0);

  // Glasgow has its years but no grades, and the degree runs to 2028: the grade so far is what to give. Madras
  // College's "AAAAA" is a grade.
  const grades = r.findings.filter((f) => f.id === 'grades');
  assert.deepEqual(
    grades.map((g) => g.text),
    ['Education › University of Glasgow gives no grades.'],
  );
  assert.equal(grades[0].severity, 'warn');
  assert.match(grades[0].fix, /grade so far/);
  assert.equal(find(r, 'grad-year'), undefined);

  const bare = find(r, 'no-number');
  assert.equal(bare.text, '3 of 8 bullets under Experience, Projects have no number.');
  assert.deepEqual(
    bare.items.map((x) => x.where),
    ['Experience › Barclays › bullet 3', 'Projects › eBaySpy › bullet 2', 'Projects › Market Tape › bullet 2'],
  );
  assert.match(bare.items[0].text, /^Built charts of monthly spending by category and…$/);
  assert.deepEqual(r.counts.bullets, 8);
  assert.deepEqual(r.counts.numbered, 5);

  assert.match(find(r, 'same-verb').text, /^“Built” opens 3 bullets\.$/);
  assert.equal(
    r.findings
      .filter((f) => f.id === 'contact')
      .map((f) => f.text)
      .join(),
    'The contact line has no LinkedIn link.',
    'a phone and an email are there',
  );
  assert.equal(find(r, 'weak-opener'), undefined);
  assert.equal(find(r, 'full-stops'), undefined, 'every bullet ends with a full stop');
  assert.equal(find(r, 'date-style'), undefined, '“Sep 2025 – Jun 2028”, “Mar 2026”: one style');
  // Warnings come first.
  const firstInfo = r.findings.findIndex((f) => f.severity === 'info');
  assert.ok(r.findings.slice(firstInfo).every((f) => f.severity === 'info'));

  // The thumbnail: every drawn piece, the flagged bullets' lines marked.
  assert.equal(r.page.lines.length, P.layoutCv(TEMPLATE_CV, { fonts }).items.length);
  assert.ok(r.page.lines.every((l) => l.x >= 0 && l.x + l.w <= r.page.W && l.y > 0 && l.y <= r.page.bottom + 2));
  assert.ok(
    r.page.lines.some((l) => l.flag === 'warn'),
    'the Glasgow entry is marked',
  );
  assert.ok(r.page.lines.some((l) => l.flag === 'info'));
});

test('cvcheck: a bullet whose last line is one word, and exactly how many characters to cut to pull it up', async () => {
  const fonts = await fontsReady;
  const r = K.check(cvOf([STRANDED, 'Built a reconciliation tool that checks 40,000 trades a night.']), { fonts });
  const short = r.findings.filter((f) => f.id === 'short-line');
  assert.equal(short.length, 1);
  assert.equal(short[0].severity, 'warn');
  assert.equal(short[0].text, 'Experience › Acme Capital › bullet 1 ends on a line of its own: “and.”');
  assert.deepEqual([short[0].section, short[0].entry, short[0].bullet], [0, 0, 0]);
  assert.ok(short[0].cut > 0 && short[0].add > short[0].cut);
  assert.match(short[0].fix, new RegExp(`^Cut ${short[0].cut} characters? to pull “and\\.” up onto the line above`));
  // Setting it again bears the number out: one character fewer still leaves two lines.
  const ctx = { fonts, missing: new Set() };
  const lay = P.layoutCv(cvOf([STRANDED]), { fonts });
  const width = lay.items.find((i) => i.kind === 'line' && i.src.part === 'bullet').src.width;
  const run = { font: fonts.regular, size: lay.size };
  const lines = (n) => P.setParagraph([{ text: STRANDED.slice(0, STRANDED.length - n), ...run }], width, ctx).length;
  assert.equal(lines(0), 2);
  assert.equal(lines(short[0].cut), 1);
  assert.equal(lines(short[0].cut - 1), 2);
  // Only the stranded line is marked on the page.
  const marked = r.page.lines.filter((l) => l.flag === 'warn');
  assert.equal(marked.length, 1);
  assert.equal(r.counts.short, 1);

  // Two words on the last line count too; three ordinary words don't.
  const two =
    'Cleaned around 5,000 transactions with pandas, fixing missing values and inconsistent merchant names and wrote.';
  assert.match(
    find(K.check(cvOf([two]), { fonts }), 'short-line').text,
    /ends with two words on a line of their own: “and wrote\.”$/,
  );
  const three =
    'Cleaned around 5,000 transactions with pandas, fixing missing values and inconsistent merchant names and wrote the rules.';
  assert.equal(find(K.check(cvOf([three]), { fonts }), 'short-line'), undefined);
});

/**
 * The first text, the words of `pool` added one at a time, whose `part` of the CV `make` builds ends on one word, as
 * the layout sets it: a stranded line found by setting it, not guessed.
 */
function stranded(fonts, make, part, pool) {
  for (let n = 4; n <= pool.length; n++) {
    const text = `${pool.slice(0, n).join(' ')}.`;
    const lines = P.layoutCv(make(text), { fonts }).items.filter((i) => i.kind === 'line' && i.src.part === part);
    const last = K.lineText(lines[lines.length - 1].line).trim();
    if (lines.length > 1 && !last.includes(' ')) return text;
  }
  throw new Error(`no stranded ${part} found`);
}
const POOL = (
  'Python and SQL for the desk, with pandas and NumPy for the data, Git and Linux for the systems, and Excel for ' +
  'the monthly report that the team sends to the partners every first Monday of the month and to the clients after'
).split(' ');

test('cvcheck: a stranded label row and a stranded entry paragraph are found too', async () => {
  const fonts = await fontsReady;
  const withText = (text) => {
    const cv = cvOf([]);
    cv.sections[0].entries[0].text = text;
    return cv;
  };
  const withRow = (text) => {
    const cv = cvOf([]);
    cv.sections.push({ title: 'Skills', entries: [], lines: [{ label: 'Programming', text }] });
    return cv;
  };
  const cv = withRow(stranded(fonts, withRow, 'row', POOL));
  cv.sections[0].entries[0].text = stranded(fonts, withText, 'text', POOL);
  const r = K.check(cv, { fonts });
  const where = r.findings.filter((f) => f.id === 'short-line').map((f) => f.text.split(' ends')[0]);
  assert.ok(where.includes('Experience › Acme Capital'), where.join());
  assert.ok(
    where.some((w) => /^Skills › Programming$/.test(w)),
    where.join(),
  );
});

test('cvcheck: a word hyphenated over two lines, and a bullet of three lines', async () => {
  const fonts = await fontsReady;
  const long =
    'Built internationalisation incomprehensibility counterrevolutionary disproportionately telecommunications and more besides for the trading desk, which used it every morning for its risk report and its reconciliation of the overnight positions.';
  const r = K.check(cvOf([long]), { fonts });
  const broken = find(r, 'hyphen');
  assert.equal(broken.severity, 'info');
  assert.equal(broken.text, '1 word is broken over two lines.');
  assert.deepEqual(
    broken.items.map((x) => x.text),
    ['“telecommunications”'],
  );
  const tall = find(r, 'long-bullet');
  assert.match(tall.items[0].text, /\(3 lines\)$/);
  assert.equal(tall.items[0].where, 'Experience › Acme Capital › bullet 1');
});

test('cvcheck: a CV squeezed to fit says how much to cut, one that still runs over says by how many lines', async () => {
  const fonts = await fontsReady;
  // pdfdoc.test.js's paragraph, three or five times over: tighter spacing, then smaller type.
  const para =
    'I am applying for the Operations Analyst programme in London. I am a second-year Mathematics student at the University of Leeds, graduating in June 2028. Last summer I built a reconciliation tool that checks 40,000 trades a night and flags any break before the morning meeting, which cut the team’s manual checks from three hours to twenty minutes.';
  const tight = structuredClone(TEMPLATE_CV);
  tight.sections[1].entries[0].bullets.push(...Array(5).fill(para));
  const squeezed = K.check(tight, { fonts });
  assert.equal(squeezed.layout.fits, true);
  assert.ok(squeezed.layout.squeezed > 0);
  assert.ok(squeezed.layout.fontSize < 10.95);
  const s = find(squeezed, 'squeezed');
  assert.equal(s.severity, 'warn');
  assert.match(s.text, /^Fits on one page only with type set at [\d.]+pt instead of 11pt\.$/);
  assert.match(s.fix, /^Cut about \d+ lines to set it at full size and spacing/);
  assert.equal(find(squeezed, 'space'), undefined);

  const spacing = structuredClone(TEMPLATE_CV);
  spacing.sections[1].entries[0].bullets.push(...Array(3).fill(para));
  const roomy = K.check(spacing, { fonts });
  assert.equal(roomy.layout.fontSize, 10.95);
  assert.match(find(roomy, 'squeezed').text, /^Fits on one page only with tighter spacing/);

  const huge = structuredClone(TEMPLATE_CV);
  huge.sections[1].entries[0].bullets.push(...Array(40).fill(para));
  const over = K.check(huge, { fonts });
  assert.equal(over.layout.fits, false);
  assert.ok(over.layout.pages > 1);
  assert.ok(over.layout.over > 10);
  assert.match(find(over, 'overflow').text, new RegExp(`^Runs onto a second page by ${over.layout.over} lines`));
  assert.ok(
    over.page.lines.some((l) => l.flag === 'over'),
    'what runs over is marked',
  );
  assert.equal(over.findings[0].id, 'overflow', 'the first thing to fix');
});

test('cvcheck: an education entry without a year or grades, and the grades a CV writes', async () => {
  const fonts = await fontsReady;
  const cv = cvOf(['Built a tool that checks 40,000 trades a night.']);
  cv.sections.unshift({
    title: 'Education',
    entries: [
      { heading: 'University of Leeds', right: 'Leeds', subheading: 'BSc Mathematics' },
      { heading: 'King’s College London', subheading: 'MSc Finance, Distinction', subright: '2024' },
      { heading: 'Leeds Grammar School', subheading: 'A-levels: Maths, Physics', subright: '2021' },
    ],
    lines: [],
  });
  const r = K.check(cv, { fonts, now: NOW });
  assert.deepEqual(
    r.findings.filter((f) => f.id === 'grad-year').map((f) => f.text),
    ['Education › University of Leeds has no year.'],
  );
  const grades = r.findings.filter((f) => f.id === 'grades');
  assert.deepEqual(
    grades.map((f) => f.text),
    ['Education › University of Leeds gives no grades.', 'Education › Leeds Grammar School gives no grades.'],
  );
  assert.match(grades[0].fix, /a class \(“First”, “2:1”\), an average/);
  assert.match(grades[1].fix, /as the school gave them \(“A\*A\*A”/);

  for (const yes of [
    'BSc Economics, 2:1',
    'First Class Honours',
    'MEng, 1st',
    'Upper Second Class',
    'GPA 3.8/4.0',
    'Average: 68%',
    'A-levels: A*A*A',
    'Scottish Highers: AAAAA',
    '38 IB points',
    'Predicted AAB',
    'Merit',
    'Dean’s List',
  ])
    assert.equal(K.hasGrade(yes), true, yes);
  for (const no of [
    'BSc Computing Science',
    'Sep 2025 – Jun 2028',
    'Glasgow, Scotland',
    'First-year representative',
    'University of Example',
    'Imperial College London',
  ])
    assert.equal(K.hasGrade(no), false, no);
});

test('cvcheck: weak openers, mixed full stops, dates written two ways and a contact line without a phone', async () => {
  const fonts = await fontsReady;
  const cv = cvOf([
    'Responsible for the monthly report to 12 desks.',
    'Helped onboard 3 new analysts',
    'Built a dashboard used by 40 traders.',
    'Wrote 200 tests for the pricing library.',
  ]);
  cv.contact = ['ada@example.com'];
  cv.sections[0].entries.push({ heading: 'Beta Ltd', subright: 'June 2024 - August 2024', bullets: [] });
  cv.sections[0].entries[0].subright = '06/2025 – 09/2025';
  const r = K.check(cv, { fonts });
  const weak = find(r, 'weak-opener');
  assert.equal(weak.text, '2 bullets open with what you were given, not what you did.');
  assert.deepEqual(
    weak.items.map((x) => x.where),
    ['Experience › Acme Capital › bullet 1', 'Experience › Acme Capital › bullet 2'],
  );
  const stops = find(r, 'full-stops');
  assert.equal(stops.text, '3 bullets end with a full stop and 1 doesn’t.');
  assert.deepEqual(
    stops.items.map((x) => x.text),
    ['Helped onboard 3 new analysts'],
  );
  const dates = find(r, 'date-style');
  assert.match(dates.text, /^Dates are written 2 ways: “06\/2025 – 09\/2025”, “June 2024 - August 2024”\.$/);
  const contact = r.findings.filter((f) => f.id === 'contact');
  assert.deepEqual(
    contact.map((f) => [f.severity, f.text]),
    [
      ['warn', 'The contact line has no phone number.'],
      ['info', 'The contact line has no LinkedIn link.'],
    ],
  );
  assert.equal(find(r, 'no-number'), undefined, 'every bullet has a number');
});

test('cvcheck: bullets without a number count only where they say what you did', async () => {
  const fonts = await fontsReady;
  const cv = cvOf(['Built the pricing library.', 'Wrote the onboarding guide.', 'Led a team of four.']);
  cv.sections.push({
    title: 'Interests',
    entries: [{ heading: 'Chess', bullets: ['Club captain.', 'Coach juniors.', 'Play online.'] }],
    lines: [],
  });
  const r = K.check(cv, { fonts });
  const bare = find(r, 'no-number');
  assert.equal(bare.text, '2 of 3 bullets under Experience have no number.');
  assert.equal(bare.severity, 'warn', 'most of them');
  assert.deepEqual(
    bare.items.map((x) => x.text),
    ['Built the pricing library.', 'Wrote the onboarding guide.'],
  );
});

test('cvcheck: a CV file’s text: its education section and bullets, a bullet’s next line joined to it', () => {
  const text = [
    'Ada Lovelace',
    'ada@example.com | 07700 900123',
    '',
    'EDUCATION',
    'University of Leeds   Sep 2024 – Jun 2027',
    'BSc Mathematics',
    '',
    'EXPERIENCE',
    'Acme Capital, Analyst   Jun 2025',
    '• Built the reconciliation tool the desk',
    '  uses every morning before 8:00.',
    '• Wrote the onboarding guide for new joiners.',
    '- Responsible for the team’s weekly report.',
    '• Cut the report’s run time from an hour to ten minutes.',
    'Skills',
    '• Python, SQL',
  ].join('\n');
  const r = K.checkText(text, { now: NOW });
  // Warnings first: two of four bullets without a number is a note.
  assert.deepEqual(ids(r), ['grades', 'weak-opener', 'no-number']);
  assert.equal(find(r, 'grades').text, 'The EDUCATION section gives no grades.');
  assert.match(find(r, 'grades').fix, /grade so far/);
  assert.deepEqual(
    find(r, 'no-number').items.map((x) => x.text),
    ['Wrote the onboarding guide for new joiners.', 'Responsible for the team’s weekly report.'],
  );
  assert.equal(find(r, 'weak-opener').items[0].where, 'EXPERIENCE › bullet 3');
  // A year and a grade where the section has them: nothing to say.
  const fine = text.replace('BSc Mathematics', 'BSc Mathematics, First Class Honours');
  assert.ok(!ids(K.checkText(fine, { now: NOW })).includes('grades'));
  assert.deepEqual(K.checkText('', {}).findings, []);
});
