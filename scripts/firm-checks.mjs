/*
 * JobToFill — runs Discover's own careers and contacts checks (lib/discover.js careers(), lib/discover-contacts.js
 * findContacts()) over every firm in extension/data/firms.json, ahead of time, and writes what they found to
 * extension/data/checks.json: each firm's careers pages and job boards, its recruiting and general mailboxes, the
 * address format its own site shows and the pages that name its people. Discover starts from that file, so a firm's
 * card says who to write to before any check runs, and Review prepares an email without waiting for the crawl.
 *
 * Firms whose website is gone (no answer, a parked domain) or that have no careers page and no address anywhere on
 * their site are listed as `dead`, and --prune takes them out of firms.json (scripts/firms.mjs leaves them out of
 * later builds too). A site that turns robots away is never dead: a browser may get through.
 *
 * Only firm-level facts are kept: role mailboxes (careers@, info@), the format, page addresses. Named people and
 * their addresses are still read live from the firm's pages, as before.
 *
 * Results are cached in .cache/checks/results.jsonl, one line per firm, so a run can stop and carry on.
 * Usage: npm run checks [-- --limit 200] [-- --refresh] [-- --prune] [-- --concurrency 24] [-- --only id,id]
 *        [-- --again none,unreachable,timeout] (check the firms that ended so last time again) [-- --write-only]
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const cacheDir = path.join(root, '.cache', 'checks');
const cacheFile = path.join(cacheDir, 'results.jsonl');
const firmsFile = path.join(root, 'extension', 'data', 'firms.json');
const outFile = path.join(root, 'extension', 'data', 'checks.json');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const LIMIT = Number(value('limit', 0)) || Infinity;
const CONCURRENCY = Number(value('concurrency', 24)) || 24;
const ONLY = new Set(String(value('only', '')).split(',').filter(Boolean));
// Statuses to check again (`--again none,unreachable,timeout`): a second look before a firm is called gone.
const AGAIN = new Set(String(value('again', '')).split(',').filter(Boolean));
const statusOf = (r) => (r.timedOut ? 'timeout' : r.error ? 'error' : r.s);
const FIRM_TIMEOUT = 150e3;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/** The extension's libraries, loaded as the unit tests load them. */
function libs() {
  globalThis.chrome = { runtime: { id: 'jobtofill-checks' }, storage: { local: {}, session: {} } };
  const lib = (f) => require(path.join(root, 'extension', 'lib', f + '.js'));
  for (const f of ['util', 'jobpage']) lib(f);
  return { D: lib('discover'), C: lib('discover-contacts') };
}

/** fetch() as a browser asks: its user agent and language, so fewer sites take the crawl for a bot. */
const fetchFn = (url, init = {}) =>
  fetch(url, {
    ...init,
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-GB,en;q=0.9', ...(init.headers || {}) },
  });

const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), ms))]);

/** A careers check and a contacts check of one firm, cut to what the file keeps. */
async function checkOne(D, C, firm) {
  const careers = await D.careers(firm, { fetch: fetchFn });
  const site = firm.site || careers.site || '';
  const contacts = await C.findContacts(
    { ...firm, site, domain: firm.domain || (site ? D.domainOf(site) : '') },
    { fetch: fetchFn, pages: careers.pages },
  ).catch(() => ({ best: [], people: [], emails: [], pattern: {}, log: [], status: 'unreachable' }));
  const mailboxes = [];
  const addMailbox = (address, kind) => {
    const a = String(address || '').toLowerCase();
    if (a && /@/.test(a) && !mailboxes.some((m) => m.a === a)) mailboxes.push({ a, k: kind || '' });
  };
  for (const b of contacts.best || []) if (!b.name && !b.guessed) addMailbox(b.address, b.kind);
  for (const e of careers.emails || []) addMailbox(e, 'careers page');
  const pattern = contacts.pattern && contacts.pattern.pattern ? contacts.pattern : null;
  const teamPages = [
    ...new Set(
      (contacts.log || [])
        .filter((l) => /team page|contact page/.test(l.outcome))
        .map((l) => l.url)
        .filter(Boolean),
    ),
  ].slice(0, 3);
  const homeFailed = (careers.log || []).some((l) => l.url === site + '/' && /^failed/.test(l.outcome));
  const parked = (careers.log || []).some((l) => /doesn’t name the firm/.test(l.outcome)) && !careers.pages.length;
  return {
    id: firm.id,
    s: careers.status,
    u: careers.site && careers.site !== firm.site ? careers.site : undefined,
    p: careers.pages.slice(0, 3),
    b: (careers.boards || [])
      .filter((b) => b.ats && (b.slug || b.host || b.url))
      .slice(0, 3)
      .map(({ ats, slug, host, site: s, locale, url }) => ({ ats, slug, host, site: s, locale, url })),
    m: mailboxes.slice(0, 4),
    f: pattern ? { p: pattern.pattern, d: pattern.domain, n: pattern.examples || 0 } : undefined,
    t: teamPages.length ? teamPages : undefined,
    n: (contacts.people || []).length,
    r: (careers.roles || []).length,
    g: (careers.programmes || []).length + (careers.mentions || []).length,
    c: contacts.status,
    h: homeFailed ? 1 : undefined,
    k: parked ? 1 : undefined,
  };
}

/**
 * Gone, for the registry: its site didn't answer and nothing else found it, or it answered but there is no careers
 * page, no job board, no programme and no address of any kind on it (the person's "remove them from the database").
 */
function isDead(r) {
  if (!r || r.timedOut || r.s === 'blocked') return false;
  const anyAddress = (r.m || []).length || r.f || r.n;
  const anyWay = (r.p || []).length || (r.b || []).length || r.r || r.g;
  if (r.s === 'unreachable' && !anyWay && !anyAddress) return true;
  return r.s === 'none' && !anyWay && !anyAddress;
}

async function main() {
  const { D, C } = libs();
  const json = JSON.parse(await readFile(firmsFile, 'utf8'));
  const firms = D.loadFirms(json);
  await mkdir(cacheDir, { recursive: true });
  const done = new Map();
  if (existsSync(cacheFile) && !flag('refresh'))
    for (const line of (await readFile(cacheFile, 'utf8')).split('\n'))
      if (line.trim())
        try {
          const r = JSON.parse(line);
          done.set(r.id, r);
        } catch (err) {
          // A line cut short by a stopped run.
        }
  const again = (id) => done.has(id) && AGAIN.has(statusOf(done.get(id)));
  const todo = firms.filter((f) => (!ONLY.size || ONLY.has(f.id)) && (!done.has(f.id) || again(f.id))).slice(0, LIMIT);
  console.log(`${firms.length} firms; ${done.size} checked before; checking ${todo.length} now.`);
  let n = 0;
  const started = Date.now();
  await D.pool(todo, CONCURRENCY, async (firm) => {
    let r;
    try {
      r = await withTimeout(checkOne(D, C, firm), FIRM_TIMEOUT);
      if (r.timedOut) r = { id: firm.id, timedOut: true };
    } catch (err) {
      r = { id: firm.id, error: String((err && err.message) || err) };
    }
    r.at = Date.now();
    done.set(firm.id, r);
    await appendFile(cacheFile, JSON.stringify(r) + '\n');
    if (++n % 50 === 0) {
      const rate = n / ((Date.now() - started) / 60e3);
      console.log(`${n}/${todo.length} (${rate.toFixed(0)} a minute)`);
    }
  });
  await write(D, firms, done, json);
}

/** checks.json from every result kept, and with --prune, firms.json without the dead. */
async function write(D, firms, done, json) {
  const out = {};
  const dead = [];
  const tally = {};
  for (const f of firms) {
    const r = done.get(f.id);
    if (!r) continue;
    const key = r.timedOut ? 'timed out' : r.error ? 'error' : r.s;
    tally[key] = (tally[key] || 0) + 1;
    if (isDead(r)) {
      dead.push(f.id);
      continue;
    }
    if (r.timedOut || r.error) continue;
    const kept = {};
    // The crawl's own bookkeeping (when, the home page failing, a parked page) stays in the cache.
    for (const [key2, v] of Object.entries(r))
      if (!['id', 'at', 'h', 'k'].includes(key2) && v != null && v !== 0 && !(Array.isArray(v) && !v.length))
        kept[key2] = v;
    out[r.id] = kept;
  }
  const built = new Date().toISOString().slice(0, 10);
  dead.sort();
  // One firm a line, as firms.json is kept: a rebuild's diff shows which firms changed.
  const lines = Object.entries(out).map(([id, v]) => `${JSON.stringify(id)}:${JSON.stringify(v)}`);
  await writeFile(
    outFile,
    `{\n"built": ${JSON.stringify(built)},\n"dead": ${JSON.stringify(dead)},\n"firms": {\n${lines.join(',\n')}\n}\n}\n`,
  );
  console.log('Status:', tally);
  console.log(`${Object.keys(out).length} firms written to checks.json; ${dead.length} dead.`);
  if (flag('prune')) {
    const gone = new Set(dead);
    const before = json.firms.length;
    const left = json.firms.filter((r) => !gone.has(D.firmFrom(r) && D.firmFrom(r).id));
    const text = (await readFile(firmsFile, 'utf8')).split('\n');
    // firms.json keeps one firm a line: drop the lines of the dead, leave the rest byte for byte.
    const keep = text.filter((line) => {
      const m = line.match(/^\{"n":.*\},?$/);
      if (!m) return true;
      const r = JSON.parse(line.replace(/,$/, ''));
      const f = D.firmFrom(r);
      return !(f && gone.has(f.id));
    });
    // The last firm's line may have lost the comma after it, or kept one it no longer needs.
    const lastFirm = keep.map((l) => /^\{"n":/.test(l)).lastIndexOf(true);
    for (let i = 0; i < keep.length; i++)
      if (/^\{"n":/.test(keep[i])) keep[i] = keep[i].replace(/,$/, '') + (i === lastFirm ? '' : ',');
    await writeFile(firmsFile, keep.join('\n'));
    console.log(`Pruned ${before - left.length} firms from firms.json (${left.length} left).`);
  }
}

if (flag('write-only')) {
  const { D } = libs();
  const json = JSON.parse(await readFile(firmsFile, 'utf8'));
  const done = new Map();
  for (const line of (await readFile(cacheFile, 'utf8')).split('\n'))
    if (line.trim())
      try {
        const r = JSON.parse(line);
        done.set(r.id, r);
      } catch (err) {
        // A line cut short.
      }
  await write(D, D.loadFirms(json), done, json);
} else await main();
// A site that never closed its connection would keep the process waiting.
process.exit(0);
