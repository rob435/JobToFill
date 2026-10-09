// Graders: what the pipelines did, against the labels. Pure functions over plain data, so they can be changed
// and re-run on recorded runs (run.mjs --replay) for free.
//
// Answers, per question: an answer to a question labelled "skip" is a violation (invented, or never the AI's to
// answer); a skip of one labelled "answer" is a miss; a choice outside the label's `acceptable` options is a wrong
// choice. Letters: the letter's own checks (checkLetter), the fact audit, attempts and length.

const norm = (s) =>
  String(s == null ? '' : s)
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
const words = (s) => (String(s || '').match(/\S+/g) || []).length;

/* ---------------------------------------------------------------- answers */

// The answers pipeline's own reasons for leaving a question (answers.js); anything else is the model's.
const DROPPED = /without inventing facts|isn’t in your material/;
const INVALID = /isn’t one of the options|^none of the options$|^not a number$|^not a date$|^too long for the box$/;

/** Why a question was left: withheld (never asked), dropped (failed the checks), invalid, omitted or model. */
export function skipKind(skip) {
  if (!skip) return null;
  if (skip.withheld) return 'withheld';
  if (DROPPED.test(skip.reason || '')) return 'dropped';
  if (INVALID.test(skip.reason || '')) return 'invalid';
  if ((skip.reason || '') === 'no answer') return 'omitted';
  return 'model';
}

/** Is an answer one of the label's acceptable options? True when the label names none. */
export function acceptable(label, value, kind) {
  if (!label.acceptable || !label.acceptable.length) return true;
  // A tick is the box's one option.
  if (kind === 'tick') return true;
  const ok = new Set(label.acceptable.map(norm));
  const picked = Array.isArray(value) ? value : [value];
  return picked.length > 0 && picked.every((v) => ok.has(norm(v)));
}

/**
 * One question's outcome and grade. `item` carries its label; `out` is answers.answer()'s result. Returns
 * { id, kind, expect, category, outcome, value, basis, warnings, reason, skipBy, grade } where grade is
 * ok | violation | miss | wrongChoice (or unlabelled).
 */
export function gradeQuestion(item, out, kindOf = () => '') {
  const label = item.label || {};
  const a = out.answers.find((x) => String(x.id) === String(item.id));
  const s = out.skipped.find((x) => String(x.id) === String(item.id));
  const row = {
    id: item.id,
    question: String(item.question || '').slice(0, 200),
    kind: kindOf(item),
    expect: label.expect,
    category: label.category || null,
  };
  if (a) {
    const warnings = a.warnings || [];
    const grade = !label.expect
      ? 'unlabelled'
      : label.expect === 'skip'
        ? 'violation'
        : acceptable(label, a.value, a.kind)
          ? 'ok'
          : 'wrongChoice';
    return { ...row, outcome: 'answered', value: a.value, basis: a.basis, warnings, grade };
  }
  const skipBy = s ? skipKind(s) : 'lost';
  return {
    ...row,
    outcome: 'skipped',
    reason: s ? s.reason : 'not in the result',
    skipBy,
    ...(s && s.withheld ? { withheld: s.withheld } : {}),
    grade: !label.expect ? 'unlabelled' : label.expect === 'answer' ? 'miss' : 'ok',
  };
}

/** Every question of one form. */
export function gradeAnswers(form, out, kindOf) {
  return form.items.map((item) => gradeQuestion(item, out, kindOf));
}

const tally = (list, key) =>
  list.reduce((o, x) => {
    const k = key(x);
    if (k != null) o[k] = (o[k] || 0) + 1;
    return o;
  }, {});
const ratio = (a, b) => (b ? a / b : null);

/**
 * The answers suite in numbers, over the cases that ran (errored cases are counted, not graded):
 * coverage = answered and labelled answer / labelled answer; safe = answered and labelled answer / answered;
 * violation rate = answered and labelled skip / labelled skip.
 */
export function aggregateAnswers(rows) {
  const ran = rows.filter((r) => !r.error);
  const qs = ran.flatMap((r) => r.questions || []);
  const answered = qs.filter((q) => q.outcome === 'answered');
  const good = answered.filter((q) => q.expect === 'answer');
  const labelAnswer = qs.filter((q) => q.expect === 'answer').length;
  const labelSkip = qs.filter((q) => q.expect === 'skip').length;
  const violations = qs.filter((q) => q.grade === 'violation');
  const misses = qs.filter((q) => q.grade === 'miss');
  const warned = answered.filter((q) => q.warnings && q.warnings.length);
  return {
    cases: rows.length,
    errors: rows.length - ran.length,
    errorsBy: tally(
      rows.filter((r) => r.error),
      (r) => r.errorCode || 'Error',
    ),
    questions: qs.length,
    labelAnswer,
    labelSkip,
    answered: answered.length,
    correct: good.length,
    coverage: ratio(good.length, labelAnswer),
    safeRate: ratio(good.length, answered.length),
    violations: violations.length,
    violationRate: ratio(violations.length, labelSkip),
    violationsBy: tally(violations, (q) => q.category || 'other'),
    misses: misses.length,
    missesBy: tally(misses, (q) => q.skipBy),
    wrongChoice: qs.filter((q) => q.grade === 'wrongChoice').length,
    dropped: qs.filter((q) => q.skipBy === 'dropped').length,
    warnings: warned.length,
    warningsBy: tally(
      warned.flatMap((q) => q.warnings),
      (w) => (/^shortened/.test(w) ? 'shortened' : /^check this is true/.test(w) ? 'unverified' : 'other'),
    ),
    byKind: Object.fromEntries(
      Object.entries(tally(qs, (q) => q.kind)).map(([kind, n]) => {
        const of = qs.filter((q) => q.kind === kind);
        const want = of.filter((q) => q.expect === 'answer');
        return [
          kind,
          {
            questions: n,
            coverage: ratio(want.filter((q) => q.outcome === 'answered').length, want.length),
            violations: of.filter((q) => q.grade === 'violation').length,
          },
        ];
      }),
    ),
  };
}

/* ---------------------------------------------------------------- letters */

/** A written letter's grade from letter.write()'s result (and the analysis, for a posting it refused). */
export function gradeLetter(analysis, result) {
  if (analysis && analysis.isPosting === false) return { pass: false, notPosting: true };
  const check = result.check || { errors: [], warnings: [] };
  const claims = (check.unsupported || []).length + check.warnings.filter((w) => /^Check this is true/.test(w)).length;
  const body = (result.letter && result.letter.paragraphs) || [];
  const n = check.words != null ? check.words : words(body.join(' '));
  const { minWords, maxWords } = result.options || {};
  return {
    pass: check.errors.length === 0,
    errors: check.errors.length,
    severe: check.severe || 0,
    warnings: check.warnings.length,
    claims,
    attempts: result.attempts,
    words: n,
    inRange: !!minWords && n >= minWords && n <= maxWords,
    paragraphs: body.length,
  };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function aggregateLetters(rows) {
  const ran = rows.filter((r) => !r.error);
  const g = ran.map((r) => r.grade);
  const written = g.filter((x) => !x.notPosting);
  return {
    cases: rows.length,
    errors: rows.length - ran.length,
    errorsBy: tally(
      rows.filter((r) => r.error),
      (r) => r.errorCode || 'Error',
    ),
    passRate: ratio(g.filter((x) => x.pass).length, g.length),
    notPosting: g.filter((x) => x.notPosting).length,
    meanErrors: mean(written.map((x) => x.errors)),
    meanWarnings: mean(written.map((x) => x.warnings)),
    meanClaims: mean(written.map((x) => x.claims)),
    meanAttempts: mean(written.map((x) => x.attempts)),
    meanWords: mean(written.map((x) => x.words)),
    inRangeRate: ratio(written.filter((x) => x.inRange).length, written.length),
  };
}

/* ------------------------------------------------------- judge, cost, time */

const SCORES = ['answersQuestion', 'specificity', 'voice', 'structure', 'fit'];

/** Judge grades in numbers: how many were judged, how many couldn't be, the supported rate and mean scores. */
export function aggregateJudge(grades) {
  const ok = grades.filter((j) => j && j.status === 'ok');
  if (!grades.length) return null;
  const out = {
    judged: ok.length,
    unavailable: grades.length - ok.length,
    supportedRate: ratio(ok.filter((j) => j.supported).length, ok.length),
  };
  for (const k of SCORES) {
    const xs = ok.map((j) => j[k]).filter((x) => typeof x === 'number');
    if (xs.length) out[k] = mean(xs);
  }
  return out;
}

/** Calls, cost (known part, and how many calls had no price), tokens and time over cases. */
export function aggregateCost(rows) {
  const calls = rows.flatMap((r) => r.calls || []);
  const known = calls.filter((c) => c.cost != null);
  const sum = (xs, f) => xs.reduce((a, x) => a + (f(x) || 0), 0);
  const ms = rows.filter((r) => !r.error && r.ms != null).map((r) => r.ms);
  return {
    calls: calls.length,
    cost: known.length ? sum(known, (c) => c.cost) : null,
    unpriced: calls.length - known.length,
    costPerCase: known.length && rows.length ? sum(known, (c) => c.cost) / rows.length : null,
    tokens: {
      input: sum(calls, (c) => c.tokens && c.tokens.input),
      cacheRead: sum(calls, (c) => c.tokens && c.tokens.cacheRead),
      output: sum(calls, (c) => c.tokens && c.tokens.output),
    },
    meanMs: mean(ms),
    maxMs: ms.length ? Math.max(...ms) : null,
    models: [...new Set(calls.map((c) => c.model).filter(Boolean))],
    fallbacks: calls.filter((c) => c.fallback).length,
  };
}
