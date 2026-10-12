/*
 * JobToFill settings — this page's edits to a profile, put onto the profile as it is stored now, so a change made
 * elsewhere meanwhile (Popup › Learn from this page, another Settings tab) isn't written over. Pure, so the unit
 * tests run it.
 */

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasIds = (...lists) => lists.every((list) => list.every((x) => isObject(x) && typeof x.id === 'string' && x.id));

/** Do two stored values hold the same (keys in any order, a key set to undefined as good as absent)? */
export function same(a, b) {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (!isObject(a) || !isObject(b)) return false;
  const keys = (o) => Object.keys(o).filter((k) => o[k] !== undefined);
  const mine = keys(a);
  return mine.length === keys(b).length && mine.every((k) => same(a[k], b[k]));
}

/**
 * What to store: `theirs` (the profile as stored now) with what this page changed on top, that is where `mine` (the
 * page's copy) differs from `base` (the stored profile it last matched). A value the page didn't change is
 * theirs; one it did is its own, also when both changed it (the page's is what the person sees). Undefined: the
 * value is gone.
 * Lists of entries with ids (custom answers) go by id: an answer "Learn from this page" added stays when the page
 * removes another. Entries without (education, jobs) go by `originOf(entry)`, where the entry was in `base` (by
 * place when it isn't given and the page added or removed none); one the page added has none. A list whose
 * length both changed is the page's.
 */
export function mergeEdits(base, mine, theirs, originOf = null) {
  if (same(mine, base)) return theirs;
  if (same(theirs, base) || same(theirs, mine)) return mine;
  if (isObject(base) && isObject(mine) && isObject(theirs)) {
    const out = {};
    for (const key of new Set([...Object.keys(theirs), ...Object.keys(mine), ...Object.keys(base)])) {
      const value = mergeEdits(base[key], mine[key], theirs[key], originOf);
      if (value !== undefined) out[key] = value;
    }
    return out;
  }
  if (Array.isArray(base) && Array.isArray(mine) && Array.isArray(theirs))
    return mergeList(base, mine, theirs, originOf);
  return mine;
}

/** mergeEdits for a list that both sides changed. */
function mergeList(base, mine, theirs, originOf) {
  if (hasIds(base, mine, theirs)) {
    const ids = (list) => list.map((x) => x.id);
    const byId = (list) => new Map(list.map((x) => [x.id, x]));
    const [b, m, t] = [byId(base), byId(mine), byId(theirs)];
    // In the page's order when it added, removed or moved one, else in theirs; what only the other has goes after.
    const lead = same(ids(mine), ids(base)) ? [theirs, mine] : [mine, theirs];
    const order = new Set([...ids(lead[0]), ...ids(lead[1]), ...ids(base)]);
    return [...order].map((id) => mergeEdits(b.get(id), m.get(id), t.get(id), originOf)).filter((x) => x !== undefined);
  }
  if (theirs.length !== base.length || !mine.every(isObject)) return mine;
  const from = (entry, i) => (originOf ? originOf(entry) : mine.length === base.length ? i : undefined);
  return mine.map((entry, i) => {
    const k = from(entry, i);
    return k == null || !base[k] ? entry : mergeEdits(base[k], entry, theirs[k], originOf);
  });
}
