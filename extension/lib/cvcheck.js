/*
 * JobToFill — the CV check: what a reader trips on, found from the CV's own layout and words, with no AI. The layout
 * is lib/pdfdoc.js's, the one the PDF is drawn from, so a line it says ends on one word ends on one word in the PDF.
 *
 *   check(cv, { fonts, paper, now })  → { layout, findings, counts, page }
 *     layout   { pages, fits, fontSize, squeezed (the CV_STEPS step it needed, 0 for none), free: { pt, mm, lines,
 *              percent }, over (lines past the page at the tightest step) }
 *     findings [{ id, severity: 'warn'|'info', text, fix, section, entry, bullet, items?: [{ where, text }],
 *              marks: [index into page.lines] }]  warnings first
 *     counts   { bullets, numbered, short, warn, info }
 *     page     { W, H, margin, bottom, lines: [{ x, y, w, h, kind, flag: ''|'warn'|'info'|'over' }] }  for a thumbnail
 *   checkText(text, { now })     → { findings, counts }  the content checks alone, on a CV file's text (no layout)
 *
 * The checks: a bullet, paragraph or row whose last line holds one or two words (and how many characters to cut to
 * pull it up, found by setting it again), words broken over two lines, the free space at the foot of the page (or
 * how far it runs over, or what it took to fit), an education entry without a year or grades, bullets without a
 * number, weak openers ("Responsible for"), one verb opening many bullets, bullets of three lines or more, dates
 * written several ways, full stops on some bullets and not others, and a contact line without an email or phone.
 * Grades are never converted between systems: a missing one is only said to be missing. Pure; runs in Node.
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});
  const P = () => JTF.pdfdoc;

  const MM = 25.4 / 72;
  // A last line this short is stranded, however many words it holds.
  const SHORT_SHARE = 0.15;
  // How far a last line should reach to look meant: half the width.
  const FILL_SHARE = 0.5;

  /* ------------------------------------------------------------------ text */

  const str = (v) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();
  const quote = (s) => `“${s}”`;
  const plural = (n, word, many) => `${n} ${n === 1 ? word : many || `${word}s`}`;
  /** The first few words of a bullet, as a list names it: "Built charts of monthly spending…". */
  const opening = (s, n = 8) => {
    const words = str(s).split(' ');
    return words.length > n ? `${words.slice(0, n).join(' ')}…` : words.join(' ');
  };

  /** The words a set line shows: its boxes' glyphs, a space for each glue, and the hyphen it breaks at. */
  function lineText(line) {
    let s = '';
    for (const it of line.items || [])
      if (it.type === 'box') s += it.glyphs.map((g) => g.text).join('');
      else if (it.type === 'glue') s += ' ';
    return line.hyphen ? `${s}-` : s;
  }

  /* ------------------------------------------------------------- sections */

  const EDUCATION = /\b(education|academic|qualifications?|studies)\b/i;
  // Sections whose bullets say what you did, where a number shows how much.
  const DOING =
    /\b(experience|employment|work|projects?|leadership|activities|extra-?curricular|volunteer\w*|positions?|internships?|research|societ(y|ies)|responsibilit(y|ies))\b/i;
  const NOT_DOING =
    /\b(skills?|education|interests?|languages?|awards?|achievements?|certifications?|courses?|publications?|references?)\b/i;
  const doing = (title) => DOING.test(title || '') && !NOT_DOING.test(title || '');

  /* ---------------------------------------------------------------- facts */

  const YEAR = /\b(19|20)\d\d\b|['’]\d\d\b/;
  // A grade as a CV writes it: a class ("2:1", "First Class Honours", not "first year"), a GPA ("3.8/4.0"), a
  // percentage or an average ("68% average"), A-level or Highers letters ("A*A*A", "AAAAA"), IB points, a
  // Distinction or Merit, a predicted grade.
  const GRADES = [
    /\b2[:.][12]\b|\b(1st|2nd|3rd)\b|\bfirst\b(?![\s-]+(year|semester|term))/i,
    /\b(upper|lower) second\b|\bthird class\b|\bhonou?rs\b|\bhons\b|\bdistinction\b|\bmerit\b|\bcum laude\b|\bdean['’]?s list\b/i,
    /\b(c?gpa|predicted|average|grades?)\b/i,
    /\b\d\.\d{1,2}\s*\/\s*\d(\.\d+)?\b/,
    /\b\d{1,3}(\.\d+)?\s?%/,
    /\b\d{2}\s*(\/\s*45|(ib\s+)?points)\b/i,
    /(?:^|[\s:(,])(?:[A-E]\*?){2,6}(?=$|[\s,;.)])|\b[A-E]\*/,
  ];
  const hasGrade = (text) => GRADES.some((re) => re.test(text));
  const DEGREE =
    /\b(b\.?sc|b\.?a|b\.?eng|m\.?eng|m\.?sc|msci|mba|m\.?phil|d\.?phil|ph\.?d|llb|llm|mmath|mphys|mchem|bachelor\w*|master\w*|degree|undergraduate|universit\w*)\b/i;
  const SCHOOL_LEVEL =
    /\b(a[- ]?levels?|as[- ]levels?|i?gcses?|international baccalaureate|\bib\b|baccalaur[ée]at|highers|leaving cert\w*|btec|high school|sixth form)\b/i;

  // A number of any kind: a digit, or a number word ("a team of four", "doubled", "hundreds of users").
  const NUMBER =
    /\d|\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|hundreds?|thousands?|millions?|billions?|dozens?|half|double[ds]?|tripled?|twice)\b/i;
  const WEAK =
    /^(responsible for|helped|helping|worked on|working on|assisted|assisting|tasked with|involved in|participated in|duties included|in charge of)\b/i;
  const NOT_VERB = new Set(['a', 'an', 'the', 'i', 'my', 'our', 'as', 'in', 'on', 'for', 'with', 'to', 'and']);
  const ENDS_STOP = /[.!?]["”’)]?$/;

  const EMAIL = /[^\s@|]+@[^\s@|]+\.[a-z]{2,}/i;
  const PHONE = /(?:\+|\b)\d[\d\s().-]{6,}\d\b/;

  /** A date's style in a right-hand column: short months ("Sep 2025"), full ("September 2025") or numbers (09/2025). */
  function dateStyles(text) {
    const out = new Set();
    const t = str(text);
    if (/\b(jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\.?\s+(19|20)\d\d\b/i.test(t)) out.add('short');
    if (
      /\b(january|february|march|april|june|july|august|september|october|november|december)\s+(19|20)\d\d\b/i.test(t)
    )
      out.add('full');
    if (/\b(0?[1-9]|1[0-2])\s*[/.]\s*(19|20)\d\d\b/.test(t)) out.add('numeric');
    return out;
  }
  const STYLE_NAME = { short: '“Sep 2025”', full: '“September 2025”', numeric: '“09/2025”' };

  /* ------------------------------------------------------------- the model */

  /** Where a part of the CV is, as a person reads it: "Experience › Barclays › bullet 2". */
  function whereOf(cv, src) {
    const section = (cv.sections || [])[src.section] || {};
    const parts = [str(section.title) || 'Untitled section'];
    if (src.part === 'row') {
      const row = (section.lines || [])[src.row] || {};
      parts.push(str(row.label) || `line ${src.row + 1}`);
    } else if (src.entry != null) {
      const e = (section.entries || [])[src.entry] || {};
      parts.push(str(e.heading) || str(e.subheading) || str(e.tagline) || `entry ${src.entry + 1}`);
      if (src.part === 'bullet') parts.push(`bullet ${src.bullet + 1}`);
    }
    return parts.join(' › ');
  }

  /** Every bullet of the CV: [{ section, entry, bullet, text, title }]. */
  function bulletsOf(cv) {
    const out = [];
    (cv.sections || []).forEach((s, si) =>
      (s.entries || []).forEach((e, ei) =>
        (e.bullets || []).forEach((b, k) =>
          out.push({ section: si, entry: ei, bullet: k, text: str(b), title: str(s.title) }),
        ),
      ),
    );
    return out;
  }

  /* --------------------------------------------------------- content checks */

  /**
   * The checks that need only the words: education without a year or grades, bullets without a number, weak openers,
   * one verb opening many bullets, dates written several ways, full stops on some bullets only, the contact line.
   * `bullets` are [{ text, title, where, … }]; `education` [{ where, name, text, school }].
   */
  function contentFindings({ bullets, education, dates, contact, name, now }) {
    const out = [];
    const thisYear = new Date(Number.isFinite(now) ? now : Date.now()).getUTCFullYear();
    for (const e of education) {
      // Still studying ("Sep 2025 – Jun 2028", "Expected June 2028", "– present"): the grade so far is what to give.
      const years = [...e.text.matchAll(/\b(19|20)\d\d\b/g)].map((m) => Number(m[0]));
      const studying = Math.max(0, ...years) > thisYear || /\b(expected|present|current|ongoing)\b/i.test(e.text);
      if (!YEAR.test(e.text))
        out.push({
          id: 'grad-year',
          severity: 'warn',
          text: `${e.where} has no year.`,
          fix: 'Add when you started and when you graduate (“Sep 2025 – Jun 2028”, or “Expected June 2028”): employers sort and filter applicants by graduation year.',
          ...e.at,
        });
      if (!hasGrade(e.text))
        out.push({
          id: 'grades',
          severity: 'warn',
          text: `${e.where} gives no grades.`,
          fix:
            e.school && !DEGREE.test(e.text)
              ? 'Add your grades as the school gave them (“A*A*A”, “AAAAB”, “38 IB points”).'
              : studying
                ? 'Add your grade so far as your university gives it (“First-year average: 72%”, “On track for a 2:1”): screeners look for it, and a gap reads as a low one.'
                : 'Add your grade as your university gives it: a class (“First”, “2:1”), an average (“68% average”) or a GPA. Screeners look for it, and a gap reads as a low one.',
          ...e.at,
        });
    }

    const work = bullets.filter((b) => doing(b.title));
    const bare = work.filter((b) => !NUMBER.test(b.text));
    if (work.length >= 3 && bare.length)
      out.push({
        id: 'no-number',
        severity: bare.length * 2 > work.length ? 'warn' : 'info',
        text: `${bare.length} of ${plural(work.length, 'bullet')} under ${[...new Set(work.map((b) => b.title))].join(', ')} ${bare.length === 1 ? 'has' : 'have'} no number.`,
        fix: 'Say how many, how much or how fast: “cleaned 5,000 transactions”, “cut the checks from three hours to twenty minutes”, “a team of four”.',
        items: bare.map((b) => ({ where: b.where, text: opening(b.text), at: b.at })),
      });

    const weak = bullets.filter((b) => WEAK.test(b.text));
    if (weak.length)
      out.push({
        id: 'weak-opener',
        severity: 'warn',
        text: `${plural(weak.length, 'bullet')} ${weak.length === 1 ? 'opens' : 'open'} with what you were given, not what you did.`,
        fix: 'Start with the verb for what you did: “Built”, “Cut”, “Led”, “Wrote”, “Automated” (not “Responsible for”, “Helped”, “Worked on”).',
        items: weak.map((b) => ({ where: b.where, text: opening(b.text), at: b.at })),
      });

    const verbs = new Map();
    for (const b of bullets) {
      const first = (b.text.match(/^[\p{L}’'-]+/u) || [''])[0];
      const key = first.toLowerCase();
      if (!key || NOT_VERB.has(key) || WEAK.test(b.text)) continue;
      if (!verbs.has(key)) verbs.set(key, { word: first, list: [] });
      verbs.get(key).list.push(b);
    }
    for (const { word, list } of verbs.values())
      if (list.length >= 3)
        out.push({
          id: 'same-verb',
          severity: 'info',
          text: `${quote(word)} opens ${list.length} bullets.`,
          fix: 'Vary a few so each reads as its own achievement: “Wrote”, “Designed”, “Shipped”, “Automated”, “Led”.',
          items: list.map((b) => ({ where: b.where, text: opening(b.text), at: b.at })),
        });

    const styles = new Map();
    for (const d of dates) for (const s of dateStyles(d)) if (!styles.has(s)) styles.set(s, d);
    const ranges = new Set(
      dates.flatMap((d) =>
        [...str(d).matchAll(/\d\s*(–|—|-|\bto\b)\s*(?=[\p{L}\d])/giu)].map((m) => m[1].toLowerCase()),
      ),
    );
    if (styles.size > 1 || ranges.size > 1)
      out.push({
        id: 'date-style',
        severity: 'info',
        text:
          styles.size > 1
            ? `Dates are written ${styles.size} ways: ${[...styles.values()].map((d) => quote(d)).join(', ')}.`
            : `Date ranges are joined ${ranges.size} ways: ${[...ranges].map((r) => quote(r)).join(', ')}.`,
        fix: `Write every date the same way (${[...styles.keys()].map((k) => STYLE_NAME[k]).join(' or ') || '“Sep 2025 – Jun 2028”'}), with the same dash between them.`,
      });

    const stopped = bullets.filter((b) => ENDS_STOP.test(b.text));
    const open = bullets.filter((b) => !ENDS_STOP.test(b.text));
    if (bullets.length >= 4 && stopped.length && open.length) {
      const fewer = stopped.length < open.length ? stopped : open;
      out.push({
        id: 'full-stops',
        severity: 'info',
        text: `${plural(stopped.length, 'bullet')} ${stopped.length === 1 ? 'ends' : 'end'} with a full stop and ${open.length} ${open.length === 1 ? 'doesn’t' : 'don’t'}.`,
        fix: 'End them all the same way: a reader notices the odd one out.',
        items: fewer.map((b) => ({ where: b.where, text: opening(b.text), at: b.at })),
      });
    }

    if (contact) {
      const line = contact.join(' | ');
      if (!name)
        out.push({
          id: 'contact',
          severity: 'warn',
          text: 'Your CV has no name at the top.',
          fix: 'Put your name first.',
        });
      if (!EMAIL.test(line))
        out.push({
          id: 'contact',
          severity: 'warn',
          text: 'The contact line has no email address.',
          fix: 'Add the address you check daily: interview invitations go there.',
        });
      if (!PHONE.test(line.replace(EMAIL, ' ')))
        out.push({
          id: 'contact',
          severity: 'warn',
          text: 'The contact line has no phone number.',
          fix: 'Add a mobile number: recruiters ring to book interviews and offers.',
        });
      if (!/linkedin\.com/i.test(line))
        out.push({
          id: 'contact',
          severity: 'info',
          text: 'The contact line has no LinkedIn link.',
          fix: 'Add linkedin.com/in/… if your profile is up to date: recruiters look you up there.',
        });
    }
    return out;
  }

  /* ---------------------------------------------------------- layout checks */

  /** Pages the PDF takes, breaking as pdfdoc.cv() does: a line past the bottom starts a page (a title keeps with its line). */
  function pagesOf(lay) {
    let pages = 1;
    let offset = 0;
    for (const it of lay.items) {
      const y = it.y - offset;
      const limit = it.keepUntil != null ? it.keepUntil - offset : y;
      if (limit > lay.bottom + 0.01 && it.kind !== 'bullet') {
        pages++;
        offset = it.y - (lay.margin + lay.size);
      }
    }
    return pages;
  }

  /** The runs with `n` characters cut from the end (from the last run first). */
  function cutRuns(runs, n) {
    const out = runs.map((r) => ({ ...r }));
    for (let i = out.length - 1; i >= 0 && n > 0; i--) {
      const t = out[i].text;
      const take = Math.min(n, t.length);
      out[i].text = t.slice(0, t.length - take);
      n -= take;
    }
    return out.filter((r) => r.text);
  }

  /**
   * How many characters to cut from a paragraph to take a line off it, setting it again at its own width each time
   * (Knuth–Plass may shrink a line's spaces to make room, so it can be fewer than the last line holds); 0 if no cut up
   * to `limit` does.
   */
  function charsToCut(runs, width, lines, ctx, limit) {
    for (let n = 1; n <= limit; n++) if (P().setParagraph(cutRuns(runs, n), width, ctx).length < lines) return n;
    return 0;
  }

  /** What the layout gave up to fit, in words (pdfdoc's CV_STEPS, mildest first). */
  function squeezeWords(step, size) {
    if (!step || step.size === 1) return step && step.lead < 1 ? 'tighter spacing and leading' : 'tighter spacing';
    return `type set at ${Math.round(size * 10) / 10}pt instead of 11pt`;
  }

  /** The findings only the layout shows: short last lines, broken words, long bullets, the space on the page. */
  function layoutFindings(cv, lay, full, ctx) {
    const out = [];
    // Lines by the paragraph they belong to (a bullet, an entry's text, a row), in order.
    const units = new Map();
    lay.items.forEach((it, i) => {
      if (it.kind !== 'line' || !it.src || !['bullet', 'text', 'row'].includes(it.src.part)) return;
      const s = it.src;
      const key = s.part === 'row' ? `${s.section}.r${s.row}` : `${s.section}.${s.entry}.${s.part}.${s.bullet ?? ''}`;
      if (!units.has(key)) units.set(key, { src: s, lines: [] });
      units.get(key).lines.push({ it, i });
    });

    const broken = [];
    const long = [];
    for (const { src, lines } of units.values()) {
      const where = whereOf(cv, src);
      const marks = lines.map((l) => l.i);
      if (src.part === 'bullet' && lines.length >= 3)
        long.push({ where, text: `${opening(src.runs.map((r) => r.text).join(''))} (${lines.length} lines)`, marks });
      lines.forEach(({ it }, j) => {
        if (!it.line.hyphen || j === lines.length - 1) return;
        const a = lineText(it.line).trim().split(' ').pop();
        const b =
          lineText(lines[j + 1].it.line)
            .trim()
            .split(' ')[0] || '';
        broken.push({ where, text: quote(`${a.replace(/-$/, '')}${b}`), marks: [lines[j].i, lines[j + 1].i] });
      });
      if (lines.length < 2) continue;
      const last = lines[lines.length - 1];
      const text = lineText(last.it.line).trim();
      const words = text.split(' ').filter(Boolean);
      const natural = P().lineWidth(last.it.line);
      if (words.length > 2 && natural >= SHORT_SHARE * src.width) continue;
      const all = lines.map((l) => lineText(l.it.line)).join(' ');
      const perChar = lines.reduce((w, l) => w + P().lineWidth(l.it.line), 0) / Math.max(1, all.length);
      const cut = charsToCut(src.runs, src.width, lines.length, ctx, text.length + 60);
      const add = Math.max(1, Math.ceil((FILL_SHARE * src.width - natural) / perChar));
      out.push({
        id: 'short-line',
        severity: 'warn',
        text:
          words.length === 1
            ? `${where} ends on a line of its own: ${quote(text)}`
            : `${where} ends with ${words.length === 2 ? 'two words' : 'a few characters'} on a line of their own: ${quote(text)}`,
        fix: cut
          ? `Cut ${plural(cut, 'character')} to pull ${quote(text)} up onto the line above, or add about ${add} to give the last line some weight.`
          : `Rewrite it a little shorter to pull ${quote(text)} up, or add about ${add} characters to give the last line some weight.`,
        cut,
        add,
        section: src.section,
        entry: src.entry ?? null,
        bullet: src.bullet ?? null,
        marks: [last.i],
      });
    }
    if (broken.length)
      out.push({
        id: 'hyphen',
        severity: 'info',
        text: `${plural(broken.length, 'word is', 'words are')} broken over two lines.`,
        fix: 'Change a word or two in the line so it breaks between words: a split word slows the reader down.',
        items: broken,
        marks: broken.flatMap((b) => b.marks),
      });
    if (long.length)
      out.push({
        id: 'long-bullet',
        severity: 'info',
        text: `${plural(long.length, 'bullet runs', 'bullets run')} to three lines or more.`,
        fix: 'A bullet past two lines gets skimmed: lead with the result, and split or cut the rest.',
        items: long,
        marks: long.flatMap((b) => b.marks),
      });

    // The space on the page: what's left at the foot, or how far it runs over, or what it gave up to fit.
    const fontSize = Math.round((lay.size / P().PT) * 100) / 100;
    if (!lay.fits) {
      const over = Math.ceil((lay.y - lay.bottom) / lay.lead);
      out.push({
        id: 'overflow',
        severity: 'warn',
        text: `Runs onto a second page by ${plural(over, 'line')}, even at ${fontSize}pt with the tightest spacing.`,
        fix: `Cut about ${plural(over, 'line')}: a student CV is one page.`,
      });
    } else if (lay.stepIndex > 0) {
      const over = Math.max(1, Math.ceil((full.y - full.bottom) / full.lead));
      out.push({
        id: 'squeezed',
        severity: 'warn',
        text: `Fits on one page only with ${squeezeWords(lay.step, fontSize)}.`,
        fix: `Cut about ${plural(over, 'line')} to set it at full size and spacing, like your template.`,
      });
    } else {
      const free = Math.max(0, lay.bottom - lay.y);
      const lines = Math.floor(free / lay.lead);
      out.push({
        id: 'space',
        severity: 'info',
        text: lines
          ? `One page, with ${plural(lines, 'line')} (${(free * MM).toFixed(0)} mm) free at the bottom.`
          : 'One page, full to the bottom margin.',
        fix:
          lines >= 6
            ? 'Room for another bullet or a project: a page that stops early reads as having less to say.'
            : lines
              ? 'About right: a little air at the foot of the page.'
              : 'Nothing more fits without squeezing: cut a line before adding one.',
      });
    }
    return out;
  }

  /** What a thumbnail needs: every drawn piece as a bar at its real place and width. */
  function pageOf(cv, lay, ctx) {
    const width = (text, run) =>
      text ? P().lineWidth(P().setParagraph([{ text, ...run }], 1e6, ctx, { justify: false })[0] || { items: [] }) : 0;
    const regular = { font: ctx.fonts.regular, size: lay.size };
    const lines = lay.items.map((it) => {
      const base = { y: it.y, kind: it.kind, flag: '' };
      if (it.kind === 'line') return { ...base, x: it.x, w: P().lineWidth(it.line), h: lay.size * 0.62 };
      if (it.kind === 'right') {
        const w = width(it.text, it.run);
        return { ...base, x: it.x - w, w, h: lay.size * 0.62 };
      }
      if (it.kind === 'rule') return { ...base, x: lay.margin, w: lay.width, h: 0.6 };
      if (it.kind === 'bullet') return { ...base, x: lay.margin + 1, w: lay.size * 0.3, h: lay.size * 0.3 };
      if (it.kind === 'contact') {
        const text = (it.row || []).map((c) => (c && typeof c === 'object' ? c.text : c)).join('  |  ');
        return { ...base, x: lay.margin, w: width(text, regular), h: lay.size * 0.62 };
      }
      return { ...base, x: lay.margin, w: width(it.text, it.run), h: it.run.size * 0.7 };
    });
    for (const l of lines) if (l.y > lay.bottom + 2) l.flag = 'over';
    return { W: lay.W, H: lay.H, margin: lay.margin, bottom: lay.bottom, lines };
  }

  /** Warnings first, then the rest, each kind in the order found. */
  const ORDER = ['overflow', 'squeezed', 'short-line', 'grad-year', 'grades', 'no-number', 'weak-opener', 'contact'];
  const rankOf = (f) => (f.severity === 'warn' ? 0 : 100) + (ORDER.includes(f.id) ? ORDER.indexOf(f.id) : 50);
  const sorted = (list) =>
    list
      .map((f, i) => ({ f, i }))
      .sort((a, b) => rankOf(a.f) - rankOf(b.f) || a.i - b.i)
      .map((x) => x.f);

  function countsOf(findings, bullets) {
    const work = bullets.filter((b) => doing(b.title));
    return {
      bullets: work.length,
      numbered: work.filter((b) => NUMBER.test(b.text)).length,
      short: findings.filter((f) => f.id === 'short-line').length,
      warn: findings.filter((f) => f.severity === 'warn').length,
      info: findings.filter((f) => f.severity === 'info').length,
    };
  }

  /**
   * The whole check of a CV model (lib/cvtex.js's, the one pdfdoc.cv() draws): its layout as the PDF sets it, and its
   * words. → { layout, findings, counts, page } (see the top of this file).
   */
  function check(cv, { fonts, paper = 'a4', now = Date.now() } = {}) {
    if (!fonts) throw new Error('cvcheck.check needs { fonts } from pdfdoc.loadFonts()');
    const data = cv || {};
    const ctx = { fonts, missing: new Set() };
    const lay = P().layoutCv(data, { fonts, paper, fit: true });
    const full = lay.stepIndex > 0 ? P().layoutCv(data, { fonts, paper, fit: false }) : lay;
    const page = pageOf(data, lay, ctx);

    // Which drawn lines each part of the CV took, to mark them on the thumbnail.
    const marksOf = (want) =>
      lay.items
        .map((it, i) => (it.src && want(it.src) && it.kind !== 'rule' && it.kind !== 'section' ? i : -1))
        .filter((i) => i >= 0);
    const bullets = bulletsOf(data).map((b) => {
      const at = { section: b.section, entry: b.entry, bullet: b.bullet };
      return {
        ...b,
        where: whereOf(data, { ...at, part: 'bullet' }),
        at,
        marks: marksOf((s) => s.section === b.section && s.entry === b.entry && s.bullet === b.bullet),
      };
    });
    const education = [];
    const dates = [];
    (data.sections || []).forEach((s, si) =>
      (s.entries || []).forEach((e, ei) => {
        for (const k of ['right', 'subright']) if (YEAR.test(e[k] || '')) dates.push(str(e[k]));
        if (!EDUCATION.test(str(s.title))) return;
        const fields = ['heading', 'tagline', 'right', 'subheading', 'subright', 'text'].map((k) => str(e[k]));
        const text = [...fields, ...(e.bullets || []).map(str)].filter(Boolean).join(' · ');
        education.push({
          where: whereOf(data, { section: si, entry: ei, part: 'heading' }),
          text,
          school: SCHOOL_LEVEL.test(text),
          at: { section: si, entry: ei, bullet: null },
          marks: marksOf((x) => x.section === si && x.entry === ei && x.part !== 'bullet'),
        });
      }),
    );
    const contact = (data.contact || []).map((c) => (c && typeof c === 'object' ? str(c.text) : str(c)));
    const found = contentFindings({ bullets, education, dates, contact, name: str(data.name), now });
    // A finding about bullets marks each bullet's lines; one about an entry, its rows.
    for (const f of found) {
      if (f.items) f.marks = f.items.flatMap((x) => (x.at && bullets.find((b) => b.at === x.at)?.marks) || []);
      else if (f.section != null)
        f.marks = (education.find((e) => e.at.section === f.section && e.at.entry === f.entry) || {}).marks || [];
      else f.marks = [];
      for (const x of f.items || []) delete x.at;
    }
    const findings = sorted([...layoutFindings(data, lay, full, ctx), ...found]);
    for (const f of findings)
      for (const i of f.marks || []) {
        const l = page.lines[i];
        if (l && l.flag !== 'over' && l.flag !== 'warn') l.flag = f.severity;
      }
    const free = Math.max(0, lay.bottom - lay.y);
    return {
      layout: {
        pages: pagesOf(lay),
        fits: lay.fits,
        fontSize: Math.round((lay.size / P().PT) * 100) / 100,
        squeezed: lay.stepIndex,
        free: {
          pt: Math.round(free * 10) / 10,
          mm: Math.round(free * MM),
          lines: lay.fits ? Math.floor(free / lay.lead) : 0,
          percent: Math.round((free / (lay.bottom - lay.margin)) * 100),
        },
        over: lay.fits ? 0 : Math.ceil((lay.y - lay.bottom) / lay.lead),
      },
      findings,
      counts: countsOf(findings, bullets),
      page,
    };
  }

  /* ------------------------------------------------------ a CV file's text */

  const BULLET = /^\s*[•◦▪‣●○■□·*–-]\s+(.*)$/;
  const HEADING =
    /^(education|academic|qualifications?|(work |professional |relevant )?experience|employment|projects?|leadership|activities|extra-?curricular\w*|volunteer\w*|positions? of responsibility|skills?|technical skills|interests?|languages?|awards?|achievements?|certifications?|publications?|research|societies|profile|summary|about me)\b/i;

  /** A line that heads a section: one of the usual names, alone or in capitals, short. */
  function headingOf(line) {
    const t = str(line).replace(/[:|]+$/, '');
    if (!t || t.length > 40 || /[.,;@]/.test(t) || /\d/.test(t)) return '';
    return HEADING.test(t) && t.split(' ').length <= 4 ? t : '';
  }

  /**
   * The content checks on the text read from a CV file (a PDF or Word document): its sections by their headings, its
   * bullets by their marks (•, ◦, -, *), a bullet's next lines joined to it while they carry on its sentence. No
   * layout: the file's own breaks aren't ours to measure. → { findings, counts }.
   */
  function checkText(text, { now = Date.now() } = {}) {
    const bullets = [];
    const sections = [];
    let title = '';
    let current = null;
    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = raw.replace(/\s+$/, '');
      const head = headingOf(line);
      if (head) {
        title = head;
        sections.push({ title, lines: [] });
        current = null;
        continue;
      }
      if (sections.length) sections[sections.length - 1].lines.push(line);
      const b = line.match(BULLET);
      if (b) {
        current = { text: str(b[1]), title };
        bullets.push(current);
      } else if (current && /^\s*[\p{Ll}\d(£$€%&,]/u.test(line) && str(line)) current.text += ` ${str(line)}`;
      else current = null;
    }
    // With no headings found, every bullet counts as one about what you did.
    if (!sections.length) for (const b of bullets) b.title = 'Experience';
    const education = sections
      .filter((s) => EDUCATION.test(s.title))
      .map((s) => {
        const body = s.lines.map(str).filter(Boolean).join(' · ');
        return { where: `The ${s.title} section`, text: body, school: SCHOOL_LEVEL.test(body) && !DEGREE.test(body) };
      })
      .filter((e) => e.text);
    const list = bullets.map((b, i) => ({ ...b, where: `${b.title || 'Bullet'} › bullet ${i + 1}` }));
    const findings = sorted(
      contentFindings({ bullets: list, education, dates: [], contact: null, name: 'x', now }).filter(
        (f) => f.id !== 'date-style' && f.id !== 'full-stops',
      ),
    );
    for (const f of findings) for (const x of f.items || []) delete x.at;
    return { findings, counts: countsOf(findings, list) };
  }

  const cvcheck = { check, checkText, lineText, charsToCut, hasGrade };
  JTF.cvcheck = cvcheck;
  if (typeof module === 'object' && module.exports) module.exports = cvcheck;
})(typeof globalThis !== 'undefined' ? globalThis : this);
