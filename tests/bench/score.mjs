// The detection benchmark's scoring: each field's outcome (what a fill leaves in it) against the answer expected of
// it, with no browser and no corpus of its own (tests/unit/bench.test.js runs it on a made-up form).

/** Text as compared: case, spacing and curly quotes don't count. */
export const same = (a, b) => flat(a) === flat(b);
const flat = (t) =>
  String(t == null ? '' : t)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/**
 * A key for each field that survives a form being read again (by a newer dom.js, or from its saved page): its
 * question, and how many fields before it asked the same ("Start date#2"). A field with no question goes by its kind.
 */
export function keysOf(fields) {
  const seen = new Map();
  return fields.map((f) => {
    const q = flat(f.question).slice(0, 100) || `(${f.kind})`;
    const n = (seen.get(q) || 0) + 1;
    seen.set(q, n);
    return n > 1 ? `${q}#${n}` : q;
  });
}

/**
 * What a fill leaves in a field, from lib/decide.js page(): { outcome: 'fill', text } (a value typed or an option
 * picked, an upload's document types), or 'ai' (left empty for the AI), or 'empty' (left for you, or missing from the
 * profile), with the action that decided it ('withheld' when only the AI's limits keep it from the AI).
 */
export function outcomeOf(entry) {
  if (entry.action === 'fill' || entry.action === 'upload') return { outcome: 'fill', text: entry.text || '' };
  return { outcome: entry.ai ? 'ai' : 'empty', why: entry.withheld ? 'withheld' : entry.action };
}

/**
 * One field's verdict against what was expected of it:
 *   right    as expected
 *   wrong    a value went in that shouldn't have: another value, or one where nothing (or the AI's answer) belonged
 *   missed   nothing went in where the profile has the answer
 *   routed   left empty either way, but for the AI where it was yours to answer, or the other way round
 *   unscored no expectation (`expect.skip`, or none written)
 * Expectations: { fill: text | [texts] }, { ai: true }, { empty: true }, { blank: true } (the AI or you: not filled).
 */
export function verdict(expect, got) {
  if (!expect || expect.skip) return 'unscored';
  if (expect.fill != null) {
    if (got.outcome !== 'fill') return 'missed';
    const texts = Array.isArray(expect.fill) ? expect.fill : [expect.fill];
    return texts.some((t) => same(t, got.text)) ? 'right' : 'wrong';
  }
  if (got.outcome === 'fill') return 'wrong';
  if (expect.blank) return 'right';
  if (expect.ai) return got.outcome === 'ai' ? 'right' : 'routed';
  if (expect.empty) return got.outcome === 'empty' ? 'right' : 'routed';
  return 'unscored';
}

const VERDICTS = ['right', 'wrong', 'missed', 'routed', 'unscored'];

/**
 * The key an expected entry goes by in a reading of its form (`mode` 'live': the fields as captured on the site;
 * 'pages': the saved page read again by the current dom.js), or null when that reading has no such field. `key` is the
 * capture's; `pages` the page's where it differs (Pharus's "1. Full name" was "1. Full name Single line text." when
 * captured); `pages: false` and `live: false` mark a field only the other reading has.
 */
export function keyIn(entry, mode) {
  if (mode === 'pages') return entry.pages === false ? null : entry.pages || entry.key;
  return entry.live === false ? null : entry.key;
}

/**
 * Score one form: `fields` as read now ({ question, kind, … } with `got` from outcomeOf), `expected` the form's
 * expected.json entries ({ key, pages, live, expect }), in a reading `mode` (keyIn). Returns { counts, rows, lost }: a
 * row per field read, with its verdict, and the expected fields this reading didn't find (`lost`: a field a newer
 * dom.js names differently, until its entry says how).
 */
export function scoreForm(fields, expected, mode = 'live') {
  const keys = keysOf(fields);
  const byKey = new Map();
  for (const e of expected || []) {
    const key = keyIn(e, mode);
    if (key != null) byKey.set(key, e);
  }
  const counts = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
  const rows = fields.map((f, i) => {
    const e = byKey.get(keys[i]);
    byKey.delete(keys[i]);
    const v = verdict(e && e.expect, f.got);
    counts[v]++;
    return { key: keys[i], verdict: v, got: f.got, expect: e ? e.expect : null, type: f.type || null };
  });
  const lost = [...byKey.values()].filter((e) => e.expect && !e.expect.skip).map((e) => e.key);
  return { counts, rows, lost };
}

/** Totals over forms, and the share of scored fields that came out right. */
export function total(forms) {
  const counts = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
  let lost = 0;
  for (const f of forms) {
    for (const v of VERDICTS) counts[v] += f.counts[v];
    lost += f.lost.length;
  }
  const scored = counts.right + counts.wrong + counts.missed + counts.routed;
  return { counts, lost, scored, score: scored ? counts.right / scored : 0 };
}

/**
 * What changed since an earlier run (its saved results): fields that came out right and now don't (`worse`), the
 * other way round (`better`), and any other whose outcome changed (`moved`), unscored ones too: a change meant to
 * change nothing (a refactor) shows every field it touched.
 */
export function compare(before, after) {
  const was = new Map();
  for (const f of before.forms || []) for (const r of f.rows) was.set(`${f.id}|${r.key}`, r);
  const out = { better: [], worse: [], moved: [] };
  for (const f of after.forms || []) {
    for (const r of f.rows) {
      const old = was.get(`${f.id}|${r.key}`);
      if (!old) continue;
      const row = { form: f.id, key: r.key, from: old, to: r };
      const changed = old.got.outcome !== r.got.outcome || !same(old.got.text, r.got.text);
      if (old.verdict === 'right' && r.verdict !== 'right' && r.verdict !== 'unscored') out.worse.push(row);
      else if (old.verdict !== 'right' && r.verdict === 'right') out.better.push(row);
      else if (changed) out.moved.push(row);
    }
  }
  return out;
}
