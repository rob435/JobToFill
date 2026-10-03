'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require('../../extension/lib/cvtex.js');
const T = globalThis.JTF.cvtex;

const FIXTURE = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cv', 'robin-li.tex'), 'utf8');

test('cvtex: the template CV parses into name, contact, sections, entries, bullets and rows', () => {
  const { cv, warnings } = T.parse(FIXTURE);
  assert.deepEqual(warnings, []);
  assert.equal(cv.name, 'Robin Li');
  assert.deepEqual(cv.contact, ['07386 526574', 'robinlipersonal@gmail.com', 'github.com/rob435']);
  assert.deepEqual(
    cv.sections.map((s) => s.title),
    ['Education', 'Experience', 'Projects', 'Achievements', 'Skills'],
  );
  const [edu, exp, proj, ach, skills] = cv.sections;
  assert.deepEqual(edu.entries[0], {
    heading: 'University of Glasgow',
    right: 'Glasgow, Scotland',
    subheading: 'BSc Computing Science',
    subright: 'Sep 2025 – Jun 2028',
  });
  assert.equal(edu.entryGap, 4, 'the \\vspace{4pt} between entries');
  assert.equal(edu.entries[1].subheading.startsWith('Scottish Highers: AAAAA (Maths'), true);
  assert.equal(exp.entries[0].bullets.length, 3);
  assert.equal(exp.entryGap, undefined, 'a single entry has no spacing to record');
  assert.deepEqual(
    proj.entries.map((e) => [e.heading, e.tagline, e.right]),
    [
      ['eBaySpy', 'eBay deal detector', 'Python, eBay API, SQLite, Telegram'],
      ['Market Tape', 'crypto market-data recorder', 'Python, WebSockets, Linux, systemd'],
    ],
  );
  assert.match(proj.entries[0].bullets[1], /restarts don’t produce duplicates/, 'apostrophes become typographic');
  assert.deepEqual(ach.lines[0], {
    label: 'Chess',
    text: 'University of Glasgow Chess Champion; 2000+ Rapid rating on Chess.com',
  });
  assert.equal(ach.entries.length, 0);
  assert.deepEqual(
    skills.lines.map((l) => l.label),
    ['Programming/Data', 'Systems/Tools', 'Languages', 'Interests'],
  );
});

test('cvtex: parse → render → parse gives the same model, and render reproduces the template', () => {
  const first = T.parse(FIXTURE);
  const tex = T.render(first.cv);
  assert.deepEqual(T.parse(tex).cv, first.cv);
  assert.equal(tex, FIXTURE, 'the template is reproduced byte for byte');
  assert.ok(tex.startsWith(T.PREAMBLE));
  assert.match(tex, /\\href\{mailto:robinlipersonal@gmail\.com\}\{robinlipersonal@gmail\.com\}/);
  assert.match(tex, /\\href\{https:\/\/github\.com\/rob435\}\{github\.com\/rob435\}/);
});

test('cvtex: comments are ignored, escaped percent signs are not', () => {
  const tex = FIXTURE.replace('\\section{Skills}', '% TODO: add a certificate\n\\section{Skills} % TODO trim').replace(
    'Python, SQL, Bash, pandas, NumPy',
    'Python, SQL % TODO more\n  and 100\\% of Bash',
  );
  const { cv } = T.parse(tex);
  assert.equal(cv.sections[4].lines[0].text, 'Python, SQL and 100% of Bash');
  assert.equal(cv.sections.length, 5);
  assert.equal(T.parse('x \\\\% hidden\n').cv.name, 'x', 'a line break before % is not an escaped percent');
});

test('cvtex: special characters are escaped and survive a round trip', () => {
  const nasty = {
    name: 'Ana & Bo',
    contact: ['a_b@example.com', { text: 'My site', href: 'https://example.com/a_b?x=1&y=50%#top' }],
    sections: [
      {
        title: 'R&D',
        entries: [
          {
            heading: 'Smith & Sons_100% {Ltd} #1',
            right: 'C:\\temp ~ ^ $5',
            bullets: ['Cut costs by 30% (£5k) -- a “lot”: it’s ‘great’.', '[bracket] first', 'dash – and — here'],
          },
        ],
        lines: [{ label: 'Q&A', text: 'a_b, c#, 50%' }],
      },
    ],
  };
  const tex = T.render(nasty);
  assert.match(tex, /\\section\{R\\&D\}/);
  assert.match(tex, /Smith \\& Sons\\_100\\% \\\{Ltd\\\} \\#1/);
  assert.match(tex, /C:\\textbackslash\{\}temp \\textasciitilde\{\} \\textasciicircum\{\} \\\$5/);
  assert.match(tex, /\\href\{https:\/\/example\.com\/a_b\?x=1\\&y=50\\%\\#top\}\{My site\}/);
  const back = T.parse(tex);
  assert.deepEqual(back.warnings, []);
  assert.deepEqual(back.cv, T.normalize(nasty));
  assert.equal(T.escape('50% of #1_a'), '50\\% of \\#1\\_a');
});

test('cvtex: other templates and odd commands degrade to plain text and never throw', () => {
  const tex = String.raw`\documentclass{article}\usepackage{x}
\begin{document}
\begin{center}{\LARGE \textbf{Grace \'Hopper}}\\ \textcolor{red}{Navy} $\cdot$ \textsc{Admiral}\end{center}
\section*{Experience}
\textbf{Navy}, 1943--1986 \hfill \textit{Washington\,DC} \\ \emph{Rear Admiral}
\begin{itemize}[leftmargin=*]
\item Wrote the first \textbf{compiler}, A-0, for \foo{UNIVAC} \mystery
  \begin{itemize}\item nested point\end{itemize}
\item \href{https://example.com}{Linked} and \url{example.org/x_y}
\end{itemize}
\medskip
Plain summary paragraph \& more.
\end{document}`;
  const { cv, warnings } = T.parse(tex);
  assert.equal(cv.name, 'Grace H\u0301opper', 'accents combine');
  assert.equal(cv.sections[0].title, 'Experience');
  assert.equal(cv.sections[0].entries[0].heading, 'Navy');
  assert.equal(cv.sections[0].entries[0].tagline, ', 1943–1986');
  assert.equal(cv.sections[0].entries[0].subheading, 'Rear Admiral');
  assert.deepEqual(cv.sections[0].entries[0].bullets.slice(-1), ['Linked and example.org/x_y']);
  assert.ok(cv.sections[0].entries[0].bullets.some((b) => /compiler, A-0, for UNIVAC/.test(b)));
  assert.ok(cv.sections[0].entries.some((e) => e.text === 'Plain summary paragraph & more.'));
  assert.ok(warnings.some((w) => /\\foo/.test(w)));
  assert.ok(warnings.some((w) => /\\mystery/.test(w)));
  assert.ok(warnings.some((w) => /Nested/.test(w)));

  for (const junk of [
    '',
    '   ',
    '\\',
    '{',
    '}}}',
    '\\section',
    '\\section{',
    '\\begin{itemize}\\item',
    '$',
    '\\href{',
    '%%%',
    '\\\\\\\\',
    null,
    undefined,
    42,
  ]) {
    const out = T.parse(junk);
    assert.ok(Array.isArray(out.warnings) && out.cv && Array.isArray(out.cv.sections), String(junk));
    assert.equal(typeof T.render(out.cv), 'string');
  }
  assert.deepEqual(T.parse('').cv, { name: '', contact: [], sections: [] });
  assert.ok(T.parse('Hello world').warnings.length > 0);
});

test('cvtex: summarize says what was understood', () => {
  const lines = T.summarize(T.parse(FIXTURE).cv);
  assert.equal(lines[0], 'Name: Robin Li');
  assert.match(lines[1], /07386 526574 \| robinlipersonal@gmail\.com \| github\.com\/rob435/);
  assert.ok(lines.includes('Experience: 1 entry, 3 bullets'));
  assert.ok(lines.includes('Skills: 4 rows'));
});

test('cvtex: a project’s tech line renders as small bold capitals and reads back', () => {
  const { cv } = T.parse(FIXTURE);
  const proj = cv.sections.find((s) => s.title === 'Projects');
  proj.entries[0].tech = ['Python', 'eBay API', 'SQLite'];
  const tex = T.render(cv);
  assert.match(
    tex,
    /\\textbf\{eBaySpy\} -- eBay deal detector \\hfill \\textit\{Python, eBay API, SQLite, Telegram\} \\\\\n\{\\footnotesize\\bfseries PYTHON \$\\cdot\$ EBAY API \$\\cdot\$ SQLITE\}\n\\begin\{itemize\}/,
  );
  const back = T.parse(tex);
  assert.deepEqual(back.warnings, []);
  const entry = back.cv.sections.find((s) => s.title === 'Projects').entries[0];
  assert.deepEqual(entry.tech, ['PYTHON', 'EBAY API', 'SQLITE']);
  assert.equal(entry.subheading, undefined);
  assert.equal(entry.bullets.length, 2);
  // Given as text, it is split into items.
  assert.deepEqual(
    T.normalize({ sections: [{ title: 'P', entries: [{ heading: 'X', tech: 'A, B; C · D' }] }] }).sections[0].entries[0]
      .tech,
    ['A', 'B', 'C', 'D'],
  );
  // A plain (not bold) capitals line under a heading is still its subheading.
  const plain = T.parse('\\section{Experience}\n\\noindent \\textbf{ACME} \\\\\nSENIOR ENGINEER\n').cv;
  assert.equal(plain.sections[0].entries[0].subheading, 'SENIOR ENGINEER');
  assert.equal(plain.sections[0].entries[0].tech, undefined);
});
