/*
 * JobToFill — field rules, education and experience: your entries (school, degree, subject, dates, grades: classes,
 * GPAs and A-levels, never converted) and the jobs you held. One of the parts lib/fields.js puts together (loaded
 * before it, in the order background.js lists them).
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});
  const U = JTF.util;
  const P = (JTF.fieldParts = JTF.fieldParts || {});
  const {
    CHOICE,
    LONG_TEXT,
    ORDINALS,
    SUFFIX,
    TEXTISH,
    countryVal,
    dateVal,
    notApplicable,
    numberVal,
    otherwiseVal,
    placeCountry,
    simple,
    val,
    windowAnswer,
  } = P;

  // UK degree classes (and a master's Distinction / Merit) and the ways forms spell them.
  const DEGREE_CLASSES = {
    first: ['First', '1st', 'First Class', 'First Class Honours', '1st Class', 'First / 1st'],
    upper: [
      '2:1',
      '2.1',
      '2i',
      'Upper Second',
      'Upper Second Class',
      'Upper Second Class Honours',
      'Second Class Honours Grade 1',
      'Second Class Honours (Upper Division)',
      'Second Class Upper',
    ],
    lower: [
      '2:2',
      '2.2',
      '2ii',
      'Lower Second',
      'Lower Second Class',
      'Lower Second Class Honours',
      'Second Class Honours Grade 2',
      'Second Class Honours (Lower Division)',
      'Second Class Lower',
    ],
    third: ['Third', '3rd', 'Third Class', 'Third Class Honours', '3rd Class'],
    pass: ['Pass', 'Ordinary', 'Ordinary degree', 'Pass degree'],
    distinction: ['Distinction', 'Pass with Distinction'],
    merit: ['Merit', 'Pass with Merit'],
  };

  /**
   * The class an answer or option names: "Upper Second Class Honours (2:1)", "2(i)", "2.1" or "Second class honours:
   * Grade 1" -> 'upper'; also 'first', 'lower', 'third', 'pass', 'distinction', 'merit'. Null for anything else,
   * GPA bands ("3.00 - 3.49") included.
   */
  function degreeClassOf(text) {
    const raw = String(text || '');
    if (/\d\.\d+\s*(-|–|—|to)\s*\d/.test(raw) && !/class|honou?r|first|second|third|division/i.test(raw)) return null;
    const t = U.normalize(raw.replace(/\b2\s*\(\s*(i{1,2})\s*\)/gi, '2$1'));
    if (!t || t.length > 120) return null;
    if (
      /\b(2 ?1|2 ?i|upper second|second (class )?upper|upper (second )?division)\b|\bsecond class( honou?rs)?( grade| division)? (1|i|one|upper)\b/.test(
        t,
      )
    )
      return 'upper';
    if (
      /\b(2 ?2|2 ?ii|lower second|second (class )?lower|lower (second )?division)\b|\bsecond class( honou?rs)?( grade| division)? (2|ii|two|lower)\b/.test(
        t,
      )
    )
      return 'lower';
    if (/\bdistinction\b/.test(t)) return 'distinction';
    if (/\bmerit\b/.test(t)) return 'merit';
    if (/^(first|1st)\b(?! (name|half|year|time|choice|language|semester|term))|^1$|\b(first|1st) class\b/.test(t))
      return 'first';
    if (/^(third|3rd)\b(?! (party|year))|^3$|\b(third|3rd) class\b/.test(t)) return 'third';
    if (/^(pass|ordinary|unclassified)\b|\b(pass|ordinary) (degree|honou?rs)\b/.test(t)) return 'pass';
    return null;
  }

  // "Upper Second (2:1) – predicted", "2:1 (expected)": a class you are on course for, not one you have.
  const EXPECTED_CLASS = /\b(predicted|expected|anticipated|projected|forecast|on track|working towards)\b/;

  /** A degree class: "2:1" also picks "Upper Second Class Honours (2:1)", "2(i)" or "Second class honours: Grade 1". */
  function classVal(text, expected) {
    const v = val(text);
    const cls = v && degreeClassOf(v.text);
    if (!cls) return v;
    return Object.assign(v, {
      kind: 'class',
      cls,
      expected: !!expected,
      candidates: [...new Set([v.text, ...DEGREE_CLASSES[cls]])],
    });
  }

  /** "3.9" or "3.9/4.0" also matches ranges like "3.80 - 4.00"; "2:1" or "First" matches its spellings. */
  function gpaVal(text) {
    const m = String(text || '').match(/^\s*(\d(?:\.\d+)?)\s*(?:\/\s*\d(?:\.\d+)?)?\s*$/);
    if (m && !/:/.test(text)) return val(text, { kind: 'number', number: parseFloat(m[1]) });
    return classVal(text);
  }

  // "GPA (out of 4.0)", "Cumulative GPA", "Grade point average": a number, never "2:1".
  const NUMERIC_GPA = /\b(4 0|4 point|5 0|10 0|out of|scale|grade point|cumulative|cgpa|numeric|decimal)\b/;
  // "If your school/university uses a GPA system, enter your GPA on a 0- 4.0 scale. Otherwise, provide your overall
  // result in your school/university's grading system" (Shell's Workday): a result in your own grading system is
  // welcome too, whatever scale the GPA is on.
  const OWN_SYSTEM =
    /\bor (the |its |an? )?equi?v[ei]?\w*\b|\botherwise\b.{0,80}\b(results?|grades?|marks?|class(es|ification)?)\b|\b(own|local|national|home|equivalent|(school|university|college|institution|country)( s)?) (grading|marking|grade|assessment) (system|scale)\b|\b(does not|doesn t|do not|don t) use (a |the )?(gpa|grade point)\b|\bscale (used|of|at) (by |at |in )?(your )?(own |local |home )?(school|university|college|institution|country)\b/;

  /**
   * A GPA question: your GPA (a class written there too, unless the question wants a number). With no GPA, a "Grade"
   * or "GPA / grade" box takes your degree classification; one that only asks for a GPA, or for one on a scale, doesn't
   * (a class is never turned into a number). A box whose page also takes a result in your own grading system
   * ("Overall Result (GPA)" on Workday: "…Otherwise, provide your overall result in your school/university's grading
   * system") takes the class as written ("2:1"). `ctx.help`: what the page says about the box, normalised.
   */
  function gpaFor(e, ctx) {
    const q = ctx.question || '';
    const help = ctx.help || '';
    const ownSystem = OWN_SYSTEM.test(q) || OWN_SYSTEM.test(help);
    const scaled = NUMERIC_GPA.test(q) || (/\b(gpa|grade point)\b/.test(help) && NUMERIC_GPA.test(help));
    const numeric = ctx.kind === 'number' || (scaled && !ownSystem);
    if (!U.isBlank(e.gpa)) {
      const v = gpaVal(e.gpa);
      return numeric && v && v.kind === 'class' ? null : v;
    }
    const gpaOnly = /\bgpa\b/.test(q) && !/\b(grades?|class|classification|results?)\b/.test(q) && !ownSystem;
    return numeric || gpaOnly ? null : classFor(e, ctx);
  }

  /**
   * "Expected/Achieved Degree Classification", "Predicted grade", "Degree result": your classification, else a class
   * written as your GPA ("2:1"), else the GPA as it is (a free-text box on a UK form takes a US student's "3.8").
   * Predicted while the course is still running, or when you wrote so ("2:1 (predicted)").
   */
  function classFor(e, ctx) {
    const own = !U.isBlank(e.classification) ? e.classification : degreeClassOf(e.gpa) ? e.gpa : '';
    if (U.isBlank(own)) return U.isBlank(e.gpa) ? null : gpaVal(e.gpa);
    const end = U.parseDate(e.endDate);
    const now = ctx.today || new Date();
    const studying = !!end && end.year * 12 + (end.month || 6) - 1 >= now.getFullYear() * 12 + now.getMonth();
    return classVal(own, studying || EXPECTED_CLASS.test(U.normalize(own)));
  }

  /**
   * "GPA Scale", "Please specify the grading scale used by your current school" [4.0 Scale / 5.0 Scale / UK Grading
   * System]: what your GPA is out of ("3.8/4.0"), or for a UK degree class the UK option of a list; never "2:1" itself.
   */
  function gpaScale(e, ctx) {
    const out = String(e.gpa || '').match(/\/\s*(\d+(?:\.\d+)?)\s*$/);
    if (out)
      return val(out[1], { kind: 'number', number: parseFloat(out[1]), candidates: [out[1], `${out[1]} scale`] });
    if ((U.isBlank(e.classification) && !degreeClassOf(e.gpa)) || !CHOICE.includes(ctx.kind)) return null;
    return val('UK degree classification', {
      candidates: [
        'UK degree classification',
        'UK grading system',
        'UK honours classification',
        'UK classification',
        'UK',
      ],
    });
  }

  const CLASS_RANK = { first: 4, distinction: 4, upper: 3, merit: 3, lower: 2, third: 1, pass: 0 };
  // The classes a question names: "a First or 2:1" (never "first year" or "your first degree").
  const CLASS_NAMED = [
    ['upper', /\b2 (1|i)\b|\bupper second\b/],
    ['lower', /\b2 (2|ii)\b|\blower second\b/],
    [
      'first',
      /\bfirst class\b|\b(predicted|achieve|achieved|expect) (a )?(first|1st)\b(?! (year|degree|time))|\b(first|1st) or\b|\bor (a )?(first|1st)\b/,
    ],
    ['third', /\bthird class\b/],
  ];

  /**
   * "Do you have a 2:1 or above (or equivalent)?", "Have you achieved or are you on track for a First or 2:1?": yes when
   * your class (predicted or achieved; First > 2:1 > 2:2 > Third > Pass, a master's Distinction and Merit level with a
   * First and a 2:1) is at least the lowest one named. "Do you expect to graduate with honours?": yes for an honours
   * degree or class. Null without a class (a GPA is never converted).
   */
  function classAtLeast(p, ctx) {
    const q = ctx.question || '';
    if (qualsOf(q).length) return schoolGradesAtLeast(p, ctx);
    const level = eduLevelOf(q);
    const list = p.education || [];
    const e = level ? list.find((x) => JTF.matcher.degreeGroup(U.normalize(x.degree)) === level) : list[0];
    if (!e) return null;
    const own = classFor(e, ctx);
    const cls = own && own.cls;
    const named = CLASS_NAMED.filter(([, re]) => re.test(q)).map(([c]) => c);
    if (named.length) {
      if (!cls) return null;
      return val(CLASS_RANK[cls] >= Math.min(...named.map((c) => CLASS_RANK[c])) ? 'Yes' : 'No');
    }
    if (!/\bhonou?rs\b/.test(q)) return null;
    if (/\b(hons|honou?rs)\b/.test(U.normalize(e.degree)) || ['first', 'upper', 'lower', 'third'].includes(cls))
      return val('Yes');
    return cls === 'pass' ? val('No') : null;
  }

  // A-level grades, lowest first.
  const SCHOOL_GRADES = ['E', 'D', 'C', 'B', 'A', 'A*'];
  // The grades a question sets as the bar, as written ("A*AA" loses its stars once normalised): "grade B or higher",
  // "AAB or above", "at least an A", "a minimum of ABB".
  const GRADE_BAR =
    /\b(?:grades? )?((?:[a-e]\*?){1,5}) or (?:higher|above|better)\b|\b(?:at least|minimum(?: of)?) (?:an? |grades? )?((?:[a-e]\*?){1,5})(?![\w*-]| ?-?levels?\b)/;

  /**
   * Isio's "…require successful candidates to have achieved an Maths A-Level grade B or higher… Please confirm if you
   * have obtained this.", "Do you have AAB or above at A-level (or equivalent)?": yes when your school grades reach
   * the bar (in that subject, when it names one of yours; else your best grades, one for each it names). Null when
   * your grades aren't letters, the subject isn't among yours, or it sets no bar.
   */
  function schoolGradesAtLeast(p, ctx) {
    const q = ctx.question || '';
    const e = schoolEntries(p).find((x) => sameQualification(q, x.degree));
    const grades = e && gradeList(e.gpa);
    const bar = String(ctx.asked || '')
      .toLowerCase()
      .match(GRADE_BAR);
    if (!grades || !bar || !grades.every((g) => SCHOOL_GRADES.includes(g))) return null;
    const rank = (g) => SCHOOL_GRADES.indexOf(g);
    const need = (bar[1] || bar[2]).toUpperCase().match(/[A-E]\*?/g);
    const named = subjectsNamed(q);
    if (named.length === 1 && need.length === 1) {
      const subjects = U.isBlank(e.field) ? [] : subjectList(e.field);
      if (subjects.length !== grades.length) return null;
      const at = subjects.findIndex((s) => named[0].keys.includes(U.normalize(s)));
      return at < 0 ? null : val(rank(grades[at]) >= rank(need[0]) ? 'Yes' : 'No');
    }
    if (named.length) return null;
    const best = grades.map(rank).sort((a, b) => b - a);
    const bars = need.map(rank).sort((a, b) => b - a);
    return val(best.length >= bars.length && bars.every((r, i) => best[i] >= r) ? 'Yes' : 'No');
  }

  // Degree subjects and the other names lists give them ("Computing Science" is "Computer Science", "Maths"
  // "Mathematics", "LLB" "Law"): [names, STEM?]. The usual name comes first.
  // prettier-ignore
  const SUBJECTS = [
    [['Computer Science', 'Computing Science', 'Computer Sciences', 'Computing', 'Comp Sci', 'CompSci', 'CS',
      'Computer Studies', 'Informatics'], true],
    [['Software Engineering', 'Software Development'], true],
    [['Computer Engineering', 'Computer Systems Engineering', 'Electrical/Computer Engineering'], true],
    [['Electrical Engineering', 'Electrical and Electronic Engineering', 'Electronic Engineering',
      'Electronic and Electrical Engineering', 'EEE', 'Electronics'], true],
    [['Mechanical Engineering', 'MechEng'], true],
    [['Aerospace Engineering', 'Aeronautical Engineering', 'Aeronautical & Aerospace Engineering',
      'Aerospace and Aeronautical Engineering'], true],
    [['Engineering', 'General Engineering', 'Engineering (various disciplines)'], true],
    [['Mathematics', 'Maths', 'Math', 'Mathematical Sciences', 'Mathematical Science'], true],
    [['Statistics', 'Stats', 'Statistical Science'], true],
    [['Data Science', 'Data Sciences'], true],
    [['Physics', 'Physical Science'], true],
    [['Chemistry', 'Chemical Sciences'], true],
    [['Biology', 'Biological Sciences', 'Biosciences', 'Life Sciences'], true],
    [['Natural Sciences', 'Natural Science', 'NatSci', 'Nat Sci'], true],
    [['Economics', 'Econ', 'Economic Sciences', 'Economics & Econometrics'], false],
    [['Philosophy, Politics and Economics', 'PPE', 'Politics, Philosophy and Economics'], false],
    [['Business', 'Business Administration', 'Business Management', 'Business Studies', 'Management',
      'Business & Management Studies', 'Business and Management'], false],
    [['Finance', 'Banking and Finance', 'Financial Management'], false],
    [['Accounting', 'Accountancy', 'Accounting and Finance'], false],
    [['Law', 'LLB', 'Laws', 'Legal Studies', 'Jurisprudence'], false],
    [['Politics', 'Political Science', 'Government'], false],
    [['Modern Languages', 'Languages', 'Modern Foreign Languages'], false],
  ].map(([names, stem]) => ({ names, stem, keys: names.map(U.normalize) }));

  /**
   * A degree subject: its other names too ("Computing Science" also tries "Computer Science"), for each subject it
   * names, in the order it names them ("Mathematics and Computer Science").
   */
  /** The subjects a text names: "…the following disciplines: Computer Science or Computer Engineering". */
  function subjectsNamed(text) {
    const t = ' ' + U.normalize(text) + ' ';
    return SUBJECTS.filter((row) => row.keys.some((k) => t.includes(' ' + k + ' ')));
  }

  /**
   * Appian's "Are you currently pursuing a Major in one of the following disciplines: Computer Science or Computer
   * Engineering": Yes when your subject is one of them, else No.
   */
  function subjectIn(p, ctx) {
    const e = (p.education || [])[0];
    const named = subjectsNamed(ctx.question || '');
    if (!e || U.isBlank(e.field) || !named.length) return null;
    const mine = subjectVal(e.field).candidates.map(U.normalize);
    if (named.some((row) => row.names.some((n) => mine.includes(U.normalize(n))))) return val('Yes');
    // Aluna's "…in Finance, Accounting or similar?": whether Economics is similar is yours to say.
    return /\b(or )?(similar|related|equivalent|relevant)\b/.test(ctx.question || '') ? null : val('No');
  }

  function subjectVal(text) {
    const v = val(text);
    if (!v) return v;
    const t = ' ' + U.normalize(v.text) + ' ';
    const hits = [];
    for (const row of SUBJECTS) {
      const at = row.keys.map((k) => t.indexOf(' ' + k + ' ')).filter((i) => i >= 0);
      if (at.length) hits.push([Math.min(...at), row]);
    }
    hits.sort((a, b) => a[0] - b[0]);
    const stem = hits.some(([, row]) => row.stem);
    // A subject the list doesn't have: its "Other" (SpaceX's "Other (Non-Technical)" for Economics).
    const other = stem ? ['Other (Technical)', 'Other (STEM)'] : ['Other (Non-Technical)', 'Other (Non-STEM)'];
    return Object.assign(v, {
      kind: 'subject',
      candidates: [...new Set([v.text, ...hits.flatMap(([, row]) => row.names)])],
      stem,
      fallback: [...other, 'Other', 'Other (please specify)'],
    });
  }

  /**
   * "What year of study are you in?", worked out from the course you are on (the first education
   * entry that hasn't ended, else the first one): "3rd year", plus the words lists use for it
   * ("Final year", "Penultimate year", "Junior"). Null before the course starts.
   */
  function studyYear(p, today) {
    const now = today || new Date();
    const nowM = now.getFullYear() * 12 + now.getMonth();
    const month = (d, typical) => (d ? d.year * 12 + (d.month || typical) - 1 : null);
    const list = (p.education || []).map((e) => ({
      start: month(U.parseDate(e.startDate), 9),
      end: month(U.parseDate(e.endDate), 6),
    }));
    const e = list.find((x) => x.end != null && x.end >= nowM) || list[0];
    if (!e || e.start == null || e.end == null || nowM < e.start) return null;
    if (nowM > e.end)
      return val('Graduated', { candidates: ['Graduated', 'I have graduated', 'Already graduated', 'Alumni'] });
    const total = Math.max(1, Math.round((e.end - e.start) / 12));
    const year = Math.min(total, Math.floor((nowM - e.start) / 12) + 1);
    const n = `${year}${SUFFIX(year)}`;
    const word = ORDINALS[year - 1] || n;
    const extra = [];
    if (year === total) extra.push('Final year', 'Final', 'Senior');
    else if (year === total - 1) extra.push('Penultimate year', 'Penultimate');
    if (year === 1) extra.push('Freshman');
    else if (year === 2 && year !== total) extra.push('Sophomore');
    else if (year === 3 && year !== total) extra.push('Junior');
    return val(`${n} year`, { candidates: [`${n} year`, `Year ${year}`, `${word} year`, ...extra, n, String(year)] });
  }

  // "Are you a final year student?", "Are you in your penultimate year?": yes or no from your year of study.
  const YEAR_ASKED =
    /^(are|is) you\b.*?\b(first|second|third|fourth|fifth|final|penultimate|pre ?final|1st|2nd|3rd|4th|5th) year\b/;

  function yearAnswer(p, ctx) {
    const m = (ctx.question || '').match(YEAR_ASKED);
    const y = studyYear(p, ctx.today);
    if (!y) return null;
    const want = m[2].replace(/^pre ?final$/, 'penultimate');
    return val(y.candidates.some((c) => [want, want + ' year'].includes(U.normalize(c))) ? 'Yes' : 'No');
  }

  /**
   * "Please select your enrollment status" / "Are you currently enrolled?": yes, at the level of the course you
   * are on (an education entry that hasn't ended), else no. Null without dated education.
   */
  function enrolment(p, today, question) {
    const now = today || new Date();
    const nowM = now.getFullYear() * 12 + now.getMonth();
    const dated = (p.education || []).filter((e) => U.parseDate(e.endDate));
    if (!dated.length) return null;
    const current = dated.find((e) => {
      const d = U.parseDate(e.endDate);
      return d.year * 12 + (d.month || 6) - 1 >= nowM;
    });
    if (!current)
      return val('No', {
        candidates: ['No', 'Not currently enrolled', 'Not enrolled', 'Graduated', 'None of the above'],
      });
    // "Are you currently an undergraduate student?": yes at that level only (an MEng counts as both).
    const asked = question && /^(are|were|is) you\b/.test(question) ? levelsOf(question) : [];
    const held = asked.length && JTF.matcher ? entryLevels(current) : [];
    if (held.length) return val(asked.some((l) => held.includes(l)) ? 'Yes' : 'No');
    const level = JTF.matcher ? JTF.matcher.degreeGroup(U.normalize(current.degree)) : null;
    const words =
      {
        bachelor: ['Enrolled in a bachelor', 'Bachelor', 'Undergraduate'],
        master: ['Enrolled in a graduate', 'Graduate', 'Master', 'Postgraduate'],
        doctorate: ['Enrolled in a graduate', 'Doctorate', 'PhD', 'Graduate'],
        highschool: ['High school'],
      }[level] || [];
    // The level first: it decides between "enrolled in a bachelor's…" and "enrolled in a graduate…".
    return val('Yes', { candidates: [...words, 'Yes', 'Currently enrolled', 'Enrolled'] });
  }

  // "Highest Education Obtained", "…qualification you hold": what you have finished. "…currently pursuing" is not.
  const HELD = /\b(obtained|held|hold|completed|attained|achieved|awarded|earned|gained)\b/;
  const UNDER_WAY = /\b(pursuing|studying|current(ly)?|expected|will be|working towards|in progress)\b/;
  const SOME_COLLEGE =
    /\bsome (college|university|uni)\b|\bcurrently (studying|enrolled)\b|\b(in progress|ongoing|working towards|studying towards)\b/;

  /**
   * Your highest education: your degree, or while it is still under way and the question asks what you hold or
   * obtained (BambooHR's "Highest Education Obtained", Menzies' "…qualification you hold"), "Some College" where the
   * list has it, else your finished school qualification (A-levels).
   */
  function highestLevel(p, ctx) {
    const list = p.education || [];
    if (!list.length) return null;
    const q = (ctx && ctx.question) || '';
    const enrolled = enrolment(p, ctx && ctx.today);
    if (!HELD.test(q) || UNDER_WAY.test(q) || !enrolled || enrolled.canonical !== 'yes')
      return degreeVal(list[0].degree);
    const school = list.find((e) => JTF.matcher.degreeGroup(U.normalize(e.degree)) === 'highschool');
    return Object.assign(degreeVal((school || list[0]).degree), { named: SOME_COLLEGE });
  }

  function degreeVal(text) {
    return val(text, { kind: 'degree' });
  }

  function currentJob(p) {
    const list = p.experience || [];
    return list.find((e) => e.current) || list[0] || null;
  }

  // "Undergraduate GPA", "GPA (Graduate)", "Name of secondary school": the entry at that level of study.
  const LEVEL_WORDS = [
    [
      'highschool',
      /\b(high school|(?<!\bpost )secondary( school)?|sixth form|a levels?|gcses?|academy school|abitur|baccalaureat|matura|leaving cert\w*|school graduation|school leaving|highers|international baccalaureate|ib diploma|btecs?)\b/,
    ],
    ['bachelor', /\b(undergrad\w*|bachelor\w*|bsc)\b/],
    // "Graduate studies" / "graduate transcript" is postgraduate (US usage); "undergraduate" never matches here.
    [
      'master',
      /\b(master\w*|msc|mba|post ?grad\w*|graduate (degree|school|program|programme|gpa|studies|study|student|level|transcripts?|records?|coursework))\b|\b(gpa|transcripts?) graduate\b/,
    ],
    ['doctorate', /\b(doctora\w*|ph ?d|dphil)\b/],
  ];

  /** Every level of study a question names: "academic transcripts (undergraduate and postgraduate)" names two. */
  function levelsOf(question) {
    // Examples don't count: "…graduate? This includes … studies e.g. a Masters".
    const q = String(question || '').replace(/\b(e g|eg|i e|such as|for example|including|includes|include)\b.*$/, '');
    return LEVEL_WORDS.filter(([, re]) => re.test(q)).map(([level]) => level);
  }

  // School qualifications that are not one another: GCSE grades are not A-level grades, nor Highers IB points.
  const SCHOOL_QUALS = [
    ['gcse', /\b(i ?)?gcses?\b|\bo levels?\b|\bnational 5s?\b|\bjunior cert\w*/],
    ['alevel', /\ba ?levels?\b|\bas levels?\b|\bpre ?u\b/],
    ['highers', /\b(advanced )?highers\b/],
    ['ib', /\bib\b|\binternational baccalaureate\b/],
    ['btec', /\bbtecs?\b/],
    ['leaving', /\bleaving cert\w*/],
    ['abitur', /\babitur\b/],
  ];
  const qualsOf = (text) => SCHOOL_QUALS.filter(([, re]) => re.test(text)).map(([q]) => q);

  /**
   * Is a school entry's qualification the one a question asks about? "Scottish Highers grades" for Advanced Highers,
   * "What A Level grades (or International Equivalent)…" for any; "Maths GCSE grade" never for A-levels.
   */
  function sameQualification(question, degree) {
    const asked = qualsOf(question);
    const held = qualsOf(U.normalize(degree));
    return !asked.length || !held.length || /\bequivalent\b/.test(question) || asked.some((q) => held.includes(q));
  }

  /** Which qualification a school entry is, its school qualifications ("A-Levels" -> ['alevel']). */
  const heldQuals = (p) => (p.education || []).flatMap((e) => qualsOf(U.normalize(e.degree)));
  const schoolEntries = (p) =>
    (p.education || []).filter((e) => JTF.matcher.degreeGroup(U.normalize(e.degree)) === 'highschool');

  /**
   * "Did you complete UK A-levels?": Yes when a school entry is that qualification, No when your school entries are
   * another one (Advanced Highers), nothing when the profile has no school entry.
   */
  function qualificationHeld(p, ctx) {
    const asked = qualsOf(ctx.question || '');
    if (!asked.length) return null;
    if (heldQuals(p).some((q) => asked.includes(q))) return val('Yes');
    return schoolEntries(p).length ? val('No') : null;
  }

  /**
   * "If you didn't complete UK A-levels, please provide your equivalent high school qualification and results":
   * nothing when you did; else your school entry as you would write it ("Advanced Highers in Mathematics, Physics –
   * AAA").
   */
  function equivalentQualification(p, ctx) {
    const asked = qualsOf(ctx.question || '');
    if (!asked.length || heldQuals(p).some((q) => asked.includes(q))) return null;
    const e = schoolEntries(p)[0];
    if (!e) return null;
    const what = [e.degree, e.field].filter((t) => !U.isBlank(t)).join(' in ');
    return val([what, e.gpa].filter((t) => !U.isBlank(t)).join(' – '));
  }

  /**
   * The position a question asks for in a list of subjects or grades: "A-Level Subject 2", "A-Level Grade 2", "2nd
   * subject", "Second A-level grade" are 1. -1 for none ("A-level grades", "GCSE Maths grade (9-1)").
   */
  function positionAsked(q) {
    const m =
      q.match(/\b(?:subject|grade|result)s? (?:no |number )?([1-9])\b(?! \d)/) ||
      q.match(/\b([1-9])(?:st|nd|rd|th)? (?:a level |gcse |higher )?(?:subject|grade|result)\b/);
    if (m) return +m[1] - 1;
    const w = q.match(
      /\b(first|second|third|fourth|fifth|sixth) (?:a level |gcse |higher )?(?:subject|grade|result)\b/,
    );
    return w ? ORDINALS.indexOf(w[1]) : -1;
  }

  /** "Mathematics, Further Mathematics and Economics" -> the three subjects; one subject stays one. */
  function subjectList(text) {
    const parts = String(text || '')
      .split(/\s*[,;]\s*/)
      .filter(Boolean);
    if (parts.length > 1 && / and /.test(parts[parts.length - 1])) parts.push(...parts.pop().split(/\s+and\s+/));
    return parts;
  }

  /** "A*A*A", "A* A* A", "AAB", "D*D*D": one grade each; null for anything else ("38/45", "2:1", "3.8"). */
  function gradeList(text) {
    const t = String(text || '').trim();
    const parts = /[\s,;/]/.test(t) ? t.split(/[\s,;/]+/).filter(Boolean) : t.match(/[A-GU]\*{0,2}/gi) || [];
    const each = parts.length > 1 && parts.every((g) => /^([A-GU]\*{0,2}|[1-9])$/i.test(g));
    return each && parts.join('').length === t.replace(/[\s,;/]+/g, '').length
      ? parts.map((g) => g.toUpperCase())
      : null;
  }

  /** The one level of study a question names, or null (none, or several). */
  function eduLevelOf(question) {
    const hits = levelsOf(question);
    return hits.length === 1 ? hits[0] : null;
  }

  /**
   * The levels of study an education entry covers: a BSc (or a Scottish MA (Hons)) is 'bachelor', an integrated
   * master's (MEng, MSci…) both 'bachelor' and 'master'.
   */
  function entryLevels(e) {
    const d = U.normalize(e.degree);
    if (JTF.matcher.isIntegratedMasters(d)) return ['bachelor', 'master'];
    const level = JTF.matcher.degreeGroup(d);
    return level ? [level] : [];
  }

  /**
   * "Country of School", "Country of Employer": from the entry's location, else the country you live in when the
   * entry is in your town ("Glasgow", or "University of Glasgow" with no location, for someone living in Glasgow).
   * Anything else is left: most students live where they study, but not all, and a wrong country is worse than none.
   */
  function entryCountry(e, p) {
    const row = placeCountry(e.location);
    if (row) return countryVal(row[2]);
    const city = U.normalize(p.address.city);
    const words = ' ' + U.normalize(U.isBlank(e.location) ? e.school || e.company : e.location) + ' ';
    if (city && words.includes(' ' + city + ' ') && JTF.geo.findCountry(p.address.country))
      return countryVal(p.address.country);
    return null;
  }

  /**
   * "Are you currently or have you ever attended university?", Capgemini's "Are you currently studying for, or have you
   * completed, a postgraduate qualification other than a masters degree?": Yes with an entry at that level (a degree
   * for "university"), else No.
   */
  function levelAttended(p, ctx) {
    const q = ctx.question || '';
    const list = p.education || [];
    if (!list.length) return null;
    let asked = levelsOf(q);
    // "…other than a masters degree": a doctorate or another postgraduate qualification.
    if (/\bother than (a |an )?(masters?|msc|ma)\b/.test(q)) asked = ['doctorate'];
    if (!asked.length) asked = ['bachelor', 'master', 'doctorate'];
    return val(list.some((e) => entryLevels(e).some((l) => asked.includes(l))) ? 'Yes' : 'No');
  }

  /**
   * Aurora's "Are you currently studying or have you completed your most recent degree in the UK?": from where your
   * latest entry is. Nothing when its place isn't in the profile.
   */
  function studiedIn(p, ctx) {
    const named = [...new Set(JTF.geo.placesNamed(ctx.question || '').map((pl) => pl.country))];
    const e = (p.education || [])[0];
    const here = e && entryCountry(e, p);
    if (named.length !== 1 || !here || !here.iso2) return null;
    return val(here.iso2 === named[0] ? 'Yes' : 'No');
  }

  /** The entry a question is about: the one at the level of study it names ("Undergraduate GPA"), else entry `index`. */
  function entryAt(p, list, ctx) {
    const level = list === 'education' ? eduLevelOf(ctx.question) : null;
    const e = level
      ? (p.education || []).find((x) => JTF.matcher.degreeGroup(U.normalize(x.degree)) === level)
      : (p[list] || [])[ctx.index || 0];
    return { e: e || null, level };
  }

  // An entry's own facts, empty for a level of study you have no entry at.
  const LEVEL_ENTRY_TYPES = new Set([
    'edu.school',
    'edu.degree',
    'edu.field',
    'edu.completed',
    'edu.classification',
    'edu.gpa',
    'edu.start',
    'edu.end',
    'edu.location',
  ]);

  // Questions about your grades: answered from your profile, or left for you.
  const GRADE_TYPES = new Set(['edu.gpa', 'edu.classification', 'edu.gpaScale', 'edu.classAtLeast']);

  /**
   * Does your profile hold the grade a grade question is about (a GPA or class for that entry; for school grades, of
   * the qualification asked)? Then the rules answer it or leave it empty on purpose (a GPA box that wants a number,
   * for a UK class), and the AI never converts one grade into another.
   */
  function gradeHeld(type, p, ctx) {
    if (!GRADE_TYPES.has(type) || !p) return false;
    const { e, level } = entryAt(p, 'education', ctx || {});
    if (!e || (U.isBlank(e.gpa) && U.isBlank(e.classification))) return false;
    return level !== 'highschool' || sameQualification((ctx && ctx.question) || '', e.degree);
  }

  /**
   * Does the profile answer a box with nothing, on purpose? "A-Level Subject 4" for three A-levels, "A-Level Grade 1"
   * for Advanced Highers; "If you didn't complete UK A-levels, … your equivalent" for someone who did. Not missing
   * from the profile, nor the AI's to answer.
   */
  function leftEmpty(type, p, ctx) {
    const q = (ctx && ctx.question) || '';
    if (type === 'edu.equivalent') return qualsOf(q).some((x) => heldQuals(p).includes(x));
    // Northern Ireland's community background is yours to give, wherever you are applying.
    if (type === 'eeo.community') return true;
    // Capgemini's "What is your postgraduate degree?" when you have none: nothing to give, nothing missing.
    if (/^edu\./.test(type) && LEVEL_ENTRY_TYPES.has(type)) {
      const { e, level } = entryAt(p, 'education', ctx || {});
      if (level && !e) return true;
    }
    // A grade you hold that the box can't take (a 2:1 in a number box): never converted, nor missing.
    if (gradeHeld(type, p, ctx) && !P.resolve(type, p, ctx)) return true;
    if (!['edu.field', 'edu.gpa', 'edu.classification'].includes(type)) return false;
    const { e, level } = entryAt(p, 'education', ctx || {});
    if (!e) return false;
    if (level === 'highschool' && !sameQualification(q, e.degree)) return true;
    const nth = type === 'edu.classification' ? -1 : positionAsked(q);
    const list =
      nth < 0 ? null : type === 'edu.gpa' ? gradeList(e.gpa) : U.isBlank(e.field) ? null : subjectList(e.field);
    return !!list && nth >= list.length;
  }

  /**
   * An entry's end date for a form's "To" box: a stint that starts and ends in the same month (a spring week, an
   * insight day: "03/2026" to "03/2026") ends the month after, since forms turn down a "To" that isn't after "From".
   */
  function endAfterStart(e) {
    const start = U.parseDate(e.startDate);
    const end = U.parseDate(e.endDate);
    if (!start || !end || !start.month || end.day || start.year !== end.year || start.month !== end.month)
      return e.endDate;
    const next = start.year * 12 + start.month; // the month after, counted from January of year 0
    return `${Math.floor(next / 12)}-${U.pad2((next % 12) + 1)}`;
  }

  const DEGREE_TITLE = /\b(exact|full) (degree )?(title|name)\b|\bdegree (title|name)\b|\btitle of (your )?degree\b/;

  /**
   * "Please state your higher educational qualifications, including (current) grade and starting and (expected)
   * graduating date" (DN Capital): one line per degree (school entries too when the question isn't about higher
   * education), "BSc Economics, University College London, September 2024 – June 2027 (expected), predicted 2:1".
   */
  function qualificationsSummary(p, ctx) {
    const q = ctx.question || '';
    const higher = /\b(higher|university|degree|tertiary|undergraduate|post ?graduate)\b/.test(q);
    const now = ctx.today || new Date();
    const when = (raw) => {
      const d = U.parseDate(raw);
      const month = d && d.month ? U.monthName(d.month) : '';
      return d ? [month.charAt(0).toUpperCase() + month.slice(1), d.year].filter(Boolean).join(' ') : '';
    };
    const lines = (p.education || [])
      .filter((e) => !U.isBlank(e.school) || !U.isBlank(e.degree))
      .filter((e) => !higher || JTF.matcher.degreeGroup(U.normalize(e.degree)) !== 'highschool')
      .map((e) => {
        const end = U.parseDate(e.endDate);
        const ongoing = !!end && end.year * 12 + (end.month || 6) - 1 >= now.getFullYear() * 12 + now.getMonth();
        // "BSc Economics"; "A-Levels (Mathematics, Further Mathematics, Economics)".
        const field = U.isBlank(e.field) ? '' : /,/.test(e.field) ? `(${e.field})` : e.field;
        const title = [e.degree, field].filter((t) => !U.isBlank(t)).join(' ');
        const dates = [when(e.startDate), when(e.endDate)].filter(Boolean).join(' – ');
        const grade = !U.isBlank(e.classification) ? e.classification : e.gpa;
        const graded = U.isBlank(grade) ? '' : ongoing && !/predict|expect/i.test(grade) ? `predicted ${grade}` : grade;
        return [title, e.school, dates && (ongoing ? `${dates} (expected)` : dates), graded].filter(Boolean).join(', ');
      });
    return lines.length ? val(lines.join('\n')) : null;
  }

  function entry(label, list, key, kind) {
    return {
      label,
      list,
      key,
      group: list === 'education' ? 'edu' : 'exp',
      get(p, ctx) {
        const i = ctx.index || 0;
        if (list === 'experience' && !ctx.jobContext) {
          // A "Company" box on a checkout form is not your employer.
          return key === 'company' && i === 0 ? val(p.address.organization) : null;
        }
        const { e, level } = entryAt(p, list, ctx);
        // No studies at the level asked: "…graduate (Master) GPA? Please indicate N/A if you do not have one.", and
        // Eastdil's required "Postgraduate University (if applicable)" for someone with no postgraduate degree.
        if (!e) return level ? otherwiseVal(ctx) || notApplicable(ctx) : null;
        if (
          level === 'highschool' &&
          ['gpa', 'class', 'subject'].includes(kind) &&
          !sameQualification(ctx.question, e.degree)
        )
          return null;
        if (kind === 'date') {
          if (key === 'endDate' && e.current) return null;
          // Capgemini's "If you selected predicted Status, which month will you complete this degree qualification?"
          // [N/A | January…]: N/A once it's finished.
          if (
            key === 'endDate' &&
            /^if you (selected|chose|answered|said) (predicted|expected)\b/.test(ctx.question || '')
          ) {
            const end = U.parseDate(e.endDate);
            const now = ctx.today || new Date();
            if (end && end.year * 12 + (end.month || 6) - 1 < now.getFullYear() * 12 + now.getMonth())
              return val('N/A', { otherwise: true, canonical: null, candidates: ['N/A', 'Not applicable'] });
          }
          const typical = key === 'endDate' ? 6 : 9;
          const raw = key === 'endDate' ? endAfterStart(e) : e[key];
          const v = windowAnswer(raw, ctx.question, typical) || dateVal(raw, ctx.part, typical);
          // PDT's "What is your anticipated graduation date?" [Fall 2027 | Spring 2028 | … | Other]: "Other" for a term
          // the list doesn't have.
          if (v && list === 'education' && CHOICE.includes(ctx.kind)) v.fallback = ['Other', 'Other (please specify)'];
          // Graduated already: "Expected graduation date: … / I am not currently enrolled" takes the last one.
          if (v && v.date && key === 'endDate' && list === 'education') {
            const now = ctx.today || new Date();
            if (v.date.year * 12 + (v.date.month || typical) - 1 < now.getFullYear() * 12 + now.getMonth())
              v.past = true;
          }
          return v;
        }
        // AAB's "University Dates Attended" in one box: "September 2024 – June 2027 (expected)".
        if (kind === 'range') {
          const say = (d) =>
            d
              ? d.month
                ? `${U.monthName(d.month).replace(/^./, (c) => c.toUpperCase())} ${d.year}`
                : String(d.year)
              : '';
          const from = U.parseDate(e.startDate);
          const to = e.current ? null : U.parseDate(endAfterStart(e));
          if (!from && !to) return null;
          const now = ctx.today || new Date();
          const ahead = !!to && to.year * 12 + (to.month || 6) - 1 > now.getFullYear() * 12 + now.getMonth();
          const end = to ? say(to) + (ahead ? ' (expected)' : '') : 'present';
          return val(from ? `${say(from)} – ${end}` : end, { canonical: null });
        }
        if (kind === 'bool') return val(e[key] ? 'Yes' : 'No');
        if (kind === 'degree') {
          // "What degree course are you studying?" in a text box wants "BSc in Mathematics", not just "BSc".
          const q = ctx.question || '';
          const withSubject =
            LONG_TEXT.includes(ctx.kind) &&
            !U.isBlank(e.degree) &&
            !U.isBlank(e.field) &&
            !U.normalize(e.degree).includes(U.normalize(e.field));
          // Capgemini's "Please state your exact degree title": "BSc Economics".
          if (withSubject && DEGREE_TITLE.test(q)) return degreeVal(`${e.degree} ${e.field}`);
          return degreeVal(
            withSubject && /\b(course|subject|studying|major)\b/.test(q) ? `${e.degree} in ${e.field}` : e[key],
          );
        }
        if (kind === 'number') return numberVal(e[key]);
        // "A-Level Grade 2" / "A-Level Subject 2" (Eastdil): the second of your grades or subjects, or nothing.
        const nth = kind === 'gpa' || kind === 'subject' ? positionAsked(ctx.question || '') : -1;
        if (nth >= 0 && kind === 'gpa' && gradeList(e.gpa)) {
          const grade = gradeList(e.gpa)[nth];
          return grade ? val(grade, { kind: 'grade' }) : null;
        }
        if (nth >= 0 && kind === 'subject' && !U.isBlank(e.field)) {
          const subject = subjectList(e.field)[nth];
          return subject ? subjectVal(subject) : null;
        }
        // "Please enter the details of all Higher/A Level (or equivalent) results and dates these were achieved" (AAB),
        // "…A-level, Scottish Higher, or equivalent subjects, and results" (Capgemini): each subject with its grade, and
        // the year when it asks when.
        if (kind === 'gpa' && TEXTISH.includes(ctx.kind) && /\b(subjects?|details)\b/.test(ctx.question || '')) {
          const grades = gradeList(e.gpa);
          const subjects = U.isBlank(e.field) ? [] : subjectList(e.field);
          if (grades && grades.length === subjects.length) {
            const end = U.parseDate(e.endDate);
            const when = end && /\b(dates?|years?|when)\b/.test(ctx.question) ? ` (${end.year})` : '';
            return val(subjects.map((t, k) => `${t} ${grades[k]}`).join(', ') + when, { canonical: null });
          }
        }
        if (kind === 'gpa') return gpaFor(e, ctx);
        if (kind === 'class') return classFor(e, ctx);
        if (kind === 'school') return val(e[key], { kind: 'school' });
        if (kind === 'subject') return subjectVal(e[key]);
        if (kind === 'scale') return gpaScale(e, ctx);
        if (kind === 'country') return entryCountry(e, p);
        // Corient's "City" in an education entry, beside its own "Country": "London", not "London, UK".
        if (key === 'location' && ctx.part === 'city' && !U.isBlank(e.location))
          return val(String(e.location).split(',')[0].trim());
        // Pharus's "Previous relevant role title and company (if applicable)" in one box: "Summer Analyst Intern, Finch &
        // Partners".
        if (
          list === 'experience' &&
          TEXTISH.includes(ctx.kind) &&
          TITLE_AND_COMPANY.test(ctx.question || '') &&
          !U.isBlank(e.title) &&
          !U.isBlank(e.company)
        )
          return val(`${e.title}, ${e.company}`, { canonical: null });
        return val(e[key]);
      },
    };
  }

  // A job's title and its employer asked for together.
  const TITLE_AND_COMPANY =
    /\b(title|role|position)\b.*\b(and|&) (the )?(company|employer|organi[sz]ation|firm)\b|\b(company|employer|organi[sz]ation|firm)\b.*\b(and|&) (job |role )?(title|position)\b/;

  // What each type of field is filled with.
  Object.assign((P.DEFS = P.DEFS || {}), {
    'job.currentCompany': {
      label: 'Current company',
      get: (p) => {
        const j = currentJob(p);
        return j ? val(j.company) : null;
      },
    },
    'job.currentTitle': {
      label: 'Current title',
      get: (p) => {
        const j = currentJob(p);
        return j ? val(j.title) : null;
      },
    },
    'job.yearsExperience': simple('Years of experience', 'job.yearsExperience', numberVal),
    // A job's "Supervisor" (Dayforce's work history): someone else's name, yours to give.
    'exp.supervisor': { label: 'Supervisor', get: () => null, leave: true, derived: true },
    // "Minor" beside "Major": a UK degree has none, and your profile names none.
    'edu.minor': { label: 'Minor', get: () => null, leave: true, derived: true },

    'edu.level': { label: 'Highest education', get: highestLevel },
    // A school is matched by the words that tell institutions apart: never "Glasgow Caledonian" for "Glasgow".
    'edu.school': entry('School / university', 'education', 'school', 'school'),
    'edu.degree': entry('Degree', 'education', 'degree', 'degree'),
    // "Computing Science" picks "Computer Science", or "STEM (… Computer Science …)"; "Science" only as a last resort.
    'edu.field': entry('Field of study', 'education', 'field', 'subject'),
    'edu.gpa': entry('GPA', 'education', 'gpa', 'gpa'),
    'edu.classification': entry('Degree classification', 'education', 'classification', 'class'),
    // Worked out from the GPA or class (never learnt into them).
    'edu.gpaScale': Object.assign(entry('GPA scale', 'education', 'gpa', 'scale'), { derived: true }),
    'edu.classAtLeast': { label: 'Degree class or school grades at least (yes/no)', get: classAtLeast },
    'edu.location': entry('School location', 'education', 'location'),
    'edu.dates': Object.assign(entry('Dates attended', 'education', 'dates', 'range'), { derived: true }),
    // Worked out from the entry's location (never learnt into it).
    'edu.country': Object.assign(entry('Country of school', 'education', 'location', 'country'), { derived: true }),
    'edu.start': entry('Education start date', 'education', 'startDate', 'date'),
    'edu.end': entry('Graduation date', 'education', 'endDate', 'date'),
    'edu.year': {
      label: 'Year of study',
      get(p, ctx) {
        const q = ctx.question || '';
        if (YEAR_ASKED.test(q)) return yearAnswer(p, ctx);
        // Clarity's "School Year completed by the beginning of Summer 2027": the year you are in just before then.
        const by = q.match(/\b(completed|finished) by (?:the )?(?:(beginning|start|end) of )?(.+?(?:19|20)\d{2})\b/);
        const span = by && JTF.matcher.optionSpan(by[3]);
        if (!span) return studyYear(p, ctx.today);
        const m = (by[2] === 'end' ? span[1] + 1 : span[0]) - 1;
        return studyYear(p, new Date(Math.floor(m / 12), m % 12, 15));
      },
    },
    'edu.enrolled': { label: 'Currently enrolled', get: (p, ctx) => enrolment(p, ctx.today, ctx.question) },
    // "Can you confirm you have completed your studies?", "Have you graduated?": the other way round from enrolled.
    'edu.completed': {
      label: 'Studies completed',
      get(p, ctx) {
        // "Is your postgraduate degree completed or still predicted?": that degree's, nothing without one.
        const level = eduLevelOf(ctx.question || '');
        const at = level ? (p.education || []).filter((e) => entryLevels(e).includes(level)) : null;
        if (at && !at.length) return null;
        const enrolled = enrolment(at ? { education: at } : p, ctx.today);
        if (!enrolled) return null;
        // Capgemini's "…degree completed or still predicted?" [Completed | Predicted].
        return enrolled.canonical === 'yes'
          ? val('No', { candidates: ['No', 'Predicted', 'Expected', 'In progress', 'Ongoing', 'Still studying'] })
          : val('Yes', { candidates: ['Yes', 'Completed', 'Achieved', 'Graduated', 'Awarded'] });
      },
    },

    'edu.summary': { label: 'Qualifications (summary)', get: qualificationsSummary, derived: true },
    'edu.attended': { label: 'Studied at that level (yes/no)', get: levelAttended, derived: true },
    'edu.majorIn': { label: 'Studies one of the subjects asked (yes/no)', get: subjectIn, derived: true },
    'edu.inCountry': { label: 'Studied in the country asked (yes/no)', get: studiedIn, derived: true },
    // "Did you complete UK A-levels?", and the box for an equivalent if you didn't.
    'edu.qualification': { label: 'School qualification held (yes/no)', get: qualificationHeld },
    'edu.equivalent': { label: 'Equivalent school qualification', get: equivalentQualification, derived: true },

    'exp.company': entry('Company', 'experience', 'company'),
    'exp.title': entry('Job title', 'experience', 'title'),
    'exp.location': entry('Job location', 'experience', 'location'),
    'exp.country': Object.assign(entry('Country of employer', 'experience', 'location', 'country'), { derived: true }),
    'exp.start': entry('Job start date', 'experience', 'startDate', 'date'),
    'exp.end': entry('Job end date', 'experience', 'endDate', 'date'),
    'exp.current': entry('Currently work here', 'experience', 'current', 'bool'),
    'exp.description': entry('Job description', 'experience', 'description'),
  });

  Object.assign(P, {
    YEAR_ASKED,
    degreeClassOf,
    eduLevelOf,
    entryLevels,
    gradeHeld,
    leftEmpty,
    levelsOf,
    qualsOf,
    subjectsNamed,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
