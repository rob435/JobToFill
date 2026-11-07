/*
 * JobToFill — Discover internships. Finds reputable firms that keep a low profile (small hedge funds,
 * quant shops, boutique advisers, small tech companies…) from a bundled registry built from the SEC's adviser
 * register, Wikipedia and Y Combinator's directory, and from Hacker News' "Who is hiring" posts; leaves out the
 * ones Trackr and Simplify already list; reads each firm's own careers pages, job boards and team pages for student
 * roles and who to email; drafts that email with the person's own AI; and keeps a watchlist that the background
 * re-checks and an outreach list of the firms written to. Nothing is ever sent from here: emails open in the
 * person's own email app.
 */
import {
  $,
  api,
  download,
  el,
  hasSiteAccess,
  modelPicker,
  plural,
  requestAiConsent,
  requestSiteAccess,
} from '../ui/common.js';

const {
  store,
  ai,
  util,
  letter: L,
  doctext,
  discover: D,
  discoverContacts: C,
  discoverSources: S,
  discoverOutreach: O,
} = globalThis.JTF;

const PAGE = 25;
const CHECK_AGE = 12 * 3600e3; // a careers check is reused for half a day
const LIST_AGE = 24 * 3600e3; // Trackr's and Simplify's lists
const HN_AGE = 12 * 3600e3;
const SHOWN_CONTACTS = 3;
const NO_AI = 'Add an AI key under Settings › Cover letters & AI first.';

const state = {
  firms: [],
  built: '',
  listed: null, // Trackr's and Simplify's names and domains together (S.listedSet), for D.onList
  sources: [], // which of the two lists answered: ['Trackr', 'Simplify']
  results: [], // [{ firm, score, reasons, flags, why? }]
  shown: PAGE,
  checks: {}, // firmId → { at, result } (careers())
  contacts: {}, // firmId → { at, result (findContacts()), read (readPage(), merged) }
  running: new Set(),
  reading: new Set(),
  showAll: new Set(), // cards showing every contact
  drafts: {}, // firmId → the email drawer: { contact, kind, instruction, subject, body, result, running, error, … }
  watch: [],
  watchStates: {},
  outreach: {}, // firmId → store.getOutreach() record
  config: null, // store.discoverAiConfig(): what every AI call on this page uses
  keys: {},
  settings: null,
};

const send = (message) => api.runtime.sendMessage(message);
const fetchFn = (url, init) => fetch(url, init);
const aiReady = () => !!state.config && !ai.problem(state.config);
/** The AI call every pipeline here gets, with the model chosen for this page. */
const aiChat = () => (messages, options) => ai.chat(state.config, { messages, ...options });
const errorText = (err) => String((err && err.message) || err);

/* --------------------------------------------------------------- loading */

async function loadRegistry() {
  const res = await fetch(api.runtime.getURL('data/firms.json'));
  const json = await res.json();
  state.firms = D.loadFirms(json);
  state.built = json.built || '';
  $('#registry-info').textContent =
    `${state.firms.length.toLocaleString('en-GB')} firms in the registry${state.built ? ` (built ${state.built})` : ''}`;
  const names = $('#firm-names');
  names.replaceChildren(...state.firms.map((f) => el('option', { value: f.name })));
}

/** One cached list: the stored copy while it is fresh, else fetched again (a failure keeps the old copy, if any). */
async function cachedList(key, stored, fetchList, maxAge, force) {
  if (!force && stored && Date.now() - stored.at < maxAge) return stored;
  const list = await Promise.resolve()
    .then(fetchList)
    .catch(() => null);
  if (list && list.answered) {
    await store.setDiscoverCache({ [key]: list });
    return list;
  }
  return stored || null;
}

/**
 * Trackr's and Simplify's company lists (each cached for a day), to leave out the firms every student already
 * applies to. Either one failing just leaves it out. Simplify's lists are tech (its finance names are Trackr's too)
 * and some 25 MB between them, so they are only fetched for a search that takes in tech firms; any other search
 * uses the copy kept, however old.
 */
async function loadLists(force, { tech = true } = {}) {
  const cache = await store.getDiscoverCache();
  const [trackr, simplify] = await Promise.all([
    cachedList('trackr', cache.trackr, () => D.trackrCompanies({ fetch: fetchFn }), LIST_AGE, force),
    tech
      ? cachedList(
          'listed',
          cache.listed,
          () => S.simplifyListings({ fetch: fetchFn, now: Date.now() }),
          LIST_AGE,
          force,
        )
      : cache.listed,
  ]);
  const lists = [trackr, simplify].filter(Boolean);
  state.sources = [trackr && 'Trackr', simplify && 'Simplify'].filter(Boolean);
  state.listed = lists.length ? S.listedSet(...lists) : null;
}

/** This month's Hacker News "Who is hiring" posts (cached for 12 hours). */
async function loadHn() {
  const cache = (await store.getDiscoverCache()).hn;
  if (cache && Date.now() - cache.at < HN_AGE) return cache;
  const hn = await S.hnHiring({ fetch: fetchFn, now: Date.now(), cache });
  if (hn && hn.answered) await store.setDiscoverCache({ hn });
  return hn && hn.answered ? hn : cache || hn;
}

/* ---------------------------------------------------------------- search */

function readQuery() {
  const niches = [...document.querySelectorAll('#niches input:checked')].map((i) => i.value);
  const seedNames = $('#seeds')
    .value.split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    niches,
    place: $('#place').value,
    size: $('#size').value,
    text: $('#text').value.trim(),
    hideTrackr: $('#hide-trackr').checked,
    hn: $('#use-hn').checked,
    seedNames,
    seeds: seedNames.map((n) => D.lookup(state.firms, n)).filter(Boolean),
  };
}

function status(text, error) {
  $('#status').textContent = text;
  $('#status').classList.toggle('error', !!error);
}

/** "Trackr and Simplify list 1,234 names; those are left out." */
function listedNote(q) {
  if (!state.listed || !q.hideTrackr || !state.sources.length) return '';
  const who = state.sources.join(' and ');
  const n = (state.listed.names || []).length.toLocaleString('en-GB');
  return ` ${who} ${state.sources.length > 1 ? 'list' : 'lists'} ${n} names; those are left out.`;
}

async function search(event) {
  if (event) event.preventDefault();
  const useAi = $('#use-ai').checked && !$('#use-ai').disabled;
  // Firefox asks before page text goes to the AI provider; the request must come straight from the click.
  const consent = useAi ? requestAiConsent() : Promise.resolve(true);
  const q = readQuery();
  // No kind of firm chosen takes in tech firms too.
  const tech = !q.niches.length || D.wantsTech(q.niches);
  $('#search').disabled = true;
  try {
    status('Checking which firms Trackr and Simplify list…');
    await loadLists(false, { tech }).catch(() => null);
    const results = D.search(state.firms, q, { trackr: state.listed });
    // Firms sharing Wikipedia categories with the ones you named ("Tiger Cub firms").
    const seedTitles = q.seeds.map((s) => s.wiki).filter(Boolean);
    if (seedTitles.length || q.seedNames.length) {
      status('Looking for similar firms on Wikipedia…');
      for (const name of q.seedNames.filter((n) => !D.lookup(state.firms, n) || !D.lookup(state.firms, n).wiki)) {
        const w = await D.wikiFind(name, { fetch: fetchFn }).catch(() => null);
        if (w) seedTitles.push(w.title);
      }
      const similar = await D.wikiSimilar(seedTitles, { fetch: fetchFn }).catch(() => []);
      mergeWiki(results, similar, q);
    }
    state.results = results;
    state.shown = PAGE;
    let hnNote = '';
    // A finance-only search shows no posts (hnFits), so they aren't fetched for one.
    if (q.hn && !tech) hnNote = ' Hacker News posts are tech: tick a Tech kind of firm to see them.';
    else if (q.hn) {
      status('Reading Hacker News’ “Who is hiring”…');
      try {
        const hn = await addHn(q);
        hnNote = !hn.answered
          ? ' Hacker News didn’t answer.'
          : hn.count
            ? ` ${plural(hn.count, 'Hacker News post')} among them.`
            : ' No Hacker News post fits this search.';
      } catch (err) {
        hnNote = ` Hacker News didn’t answer (${errorText(err)}).`;
      }
    }
    renderResults();
    const count = state.results.length;
    status(`${count ? `${plural(count, 'firm')} match.` : 'No firms match.'}${hnNote}${listedNote(q)}`);
    if (useAi) await askAi(q, await consent);
  } catch (err) {
    status(errorText(err), true);
  } finally {
    $('#search').disabled = false;
  }
}

/** Wikipedia neighbours: registry firms get a reason and a boost; others join as Wikipedia-only firms. */
function mergeWiki(results, similar, q) {
  const byId = new Map(results.map((r) => [r.firm.id, r]));
  for (const s of similar) {
    if (s.shared.length < 1) continue;
    // Only neighbours in a category of the kind of firm asked for ("Hedge fund firms in…" for hedge funds).
    const kinds = q.niches.map((n) => D.NICHES[n] && D.NICHES[n].wiki).filter(Boolean);
    if (kinds.length && !s.shared.some((c) => kinds.some((re) => re.test(c)))) continue;
    const reason = `Shares ${s.shared.length > 1 ? `${s.shared.length} Wikipedia categories` : `“${s.shared[0]}”`} with the firms you named`;
    const known =
      state.firms.find((f) => f.wiki === s.title.replace(/ /g, '_') || f.wiki === s.title) ||
      D.lookup(state.firms, s.title);
    if (known) {
      const r = byId.get(known.id);
      if (r) {
        r.score += 0.15 * s.shared.length;
        r.reasons.unshift(reason);
      }
      continue;
    }
    const firm = {
      id: s.qid ? 'wd:' + s.qid : 'w:' + s.title,
      name: s.title.replace(/\s*\([^)]*\)$/, ''),
      aliases: [],
      domain: '',
      site: '',
      cities: [],
      country: '',
      employees: null,
      aum: null,
      funds: null,
      crd: null,
      wiki: s.title,
      qid: s.qid,
      tags: [],
      source: 'wikipedia',
    };
    const st = D.standing(firm, { trackr: state.listed });
    if (q.hideTrackr && st.onTrackr) continue;
    const r = {
      firm,
      score: 0.3 + 0.1 * s.shared.length,
      reasons: [reason, ...st.reasons],
      flags: { onTrackr: st.onTrackr, similar: true },
    };
    results.push(r);
    byId.set(firm.id, r);
  }
  results.sort((a, b) => b.score - a.score);
}

/** Put extra results among the others, one every `every` places from the top, so both kinds show on the first page. */
function interleave(results, extra, every = 3) {
  extra.forEach((r, i) => results.splice(Math.min(i * every, results.length), 0, r));
}

const isTech = (niche) => !!D.NICHES[niche] && D.NICHES[niche].group === 'tech';
/** The kind of firm a registry tag stands for ("hedge" → Hedge funds, "yc" → Backed startups), or null. */
const nicheOfTag = (tag) => Object.values(D.NICHES).find((n) => (n.tags || []).includes(tag)) || null;

/** Is the firm in the place asked for? D.placeMatch where the registry's fields are, by its words otherwise. */
function placeFits(firm, place) {
  if (!place || place === 'any') return true;
  const located = (firm.cities || []).length > 0 || !!firm.country;
  // A post that says nothing about where is worth a look from anywhere; "Remote" ones too.
  if (place === 'remote') return !!firm.remote || !located;
  if (!located) return false;
  const p = D.PLACES[place] || {};
  const cities = (firm.cities || []).map((c) => util.normalize(c));
  // A post's country is its first location's ("NY, SF, London, UK & Toronto" → US), so a city named is enough.
  if (firm.source === 'hn' && p.cities && cities.some((c) => p.cities.includes(c))) return true;
  if (D.placeMatch) return D.placeMatch({ cities: [], country: '', ...firm }, place);
  if (p.cities) return cities.some((c) => p.cities.includes(c));
  if (p.countries) return p.countries.includes(firm.country);
  return !p.country || firm.country === p.country;
}

/**
 * Does a Hacker News post's firm fit the search? Only for tech kinds of firm (or none chosen): a finance-only search
 * shows no posts. A post tagged with what it does must share a tag with the tech kinds chosen; an untagged one fits.
 */
function hnFits(firm, q) {
  const tech = q.niches.filter(isTech);
  if (q.niches.length && !tech.length) return false;
  // A post says only "tech" (S.hnFirm); one tagged with a kind of its own must be a kind asked for.
  const tags = new Set(tech.flatMap((n) => D.NICHES[n].tags || [n]));
  const own = (firm.tags || []).filter(nicheOfTag);
  if (tags.size && own.length && !own.some((t) => tags.has(t))) return false;
  if (q.text && !D.normName(firm.name).includes(D.normName(q.text))) return false;
  return placeFits(firm, q.place);
}

/**
 * The Hacker News posts that fit the search, as result cards among the registry's (a firm in both gets the post).
 * → { count: the cards with a post, answered: whether Hacker News (or the copy kept) answered at all }
 */
async function addHn(q) {
  const hn = await loadHn();
  const byDomain = new Map(state.results.filter((r) => r.firm.domain).map((r) => [r.firm.domain, r]));
  const byName = new Map(state.results.map((r) => [D.normName(r.firm.name), r]));
  const extra = [];
  const seen = new Set();
  for (const post of (hn && hn.posts) || []) {
    const firm = S.hnFirm(post);
    if (!firm || !firm.name || seen.has(firm.id) || !hnFits(firm, q)) continue;
    seen.add(firm.id);
    const known = (firm.domain && byDomain.get(firm.domain)) || byName.get(D.normName(firm.name));
    if (known) {
      // The registry's firm, with what the post adds (its boards, the address to write to).
      const { id, name, aliases, crd, wiki, qid, aum, employees } = known.firm;
      known.firm = { ...firm, ...known.firm, id, name, aliases, crd, wiki, qid, aum, employees, hn: firm.hn };
      for (const k of ['boards', 'pages']) known.firm[k] = [...(known.firm[k] || []), ...(firm[k] || [])];
      known.flags = { ...known.flags, hn: true };
      continue;
    }
    const st = D.standing(firm, { trackr: state.listed });
    if (q.hideTrackr && st.onTrackr) continue;
    extra.push({ firm, score: 0.9, reasons: st.reasons, flags: { onTrackr: st.onTrackr, hn: true } });
  }
  interleave(state.results, extra, 2);
  // hnHiring() never throws: a failure is a result with nothing answered.
  return { count: state.results.filter((r) => r.flags && r.flags.hn).length, answered: !!(hn && hn.answered) };
}

/** The angles a thorough search asks the AI from, each a round of ideas of its own. */
function anglesFor(q) {
  const place = D.PLACES[q.place];
  const where = place && !['any', 'remote'].includes(q.place) ? ` with an office in ${place.label}` : '';
  return [
    'Prefer firms that take speculative applications by email',
    'Prefer firms founded in the last fifteen years',
    `Prefer firms${where} of under 100 people`,
    'Prefer firms that run a formal internship or graduate programme',
  ];
}

async function askAi(q, consented) {
  state.config = await store.discoverAiConfig();
  const problem = ai.problem(state.config);
  if (problem) return status(`${problem} (Settings › Cover letters & AI) The registry results are above.`, true);
  if (!consented) return status('Firefox didn’t allow sending the search to your AI provider.', true);
  const angles = state.config.effort === 'thorough' ? anglesFor(q) : [''];
  const chat = aiChat();
  const named = [];
  const rejected = [];
  let suggested = 0;
  let added = 0;
  let failed = '';
  for (const [i, angle] of angles.entries()) {
    status(
      angles.length > 1
        ? `Asking the AI for more firms (${i + 1} of ${angles.length}: ${angle.replace(/^Prefer /, '')}), then checking each one…`
        : 'Asking the AI for more firms, then checking each one…',
    );
    // Names it already gave, then the best of the rest, so a later angle brings new ones.
    const exclude = [...named, ...state.results.slice(0, 60).map((r) => r.firm.name)];
    let out;
    try {
      out = await D.suggest(chat, q, state.firms, { fetch: fetchFn, exclude, ...(angle ? { angle } : {}) });
    } catch (err) {
      if (!i) throw err;
      failed = errorText(err);
      break;
    }
    suggested += out.found.length + out.rejected.length;
    const extra = [];
    for (const f of out.found) {
      named.push(f.firm.name);
      const norm = D.normName(f.firm.name);
      if (state.results.some((r) => r.firm.id === f.firm.id || D.normName(r.firm.name) === norm)) continue;
      const st = D.standing(f.firm, { trackr: state.listed });
      if (q.hideTrackr && st.onTrackr) continue;
      extra.push({
        firm: f.firm,
        score: 1,
        reasons: [...new Set([...f.reasons, ...st.reasons])],
        flags: { onTrackr: st.onTrackr, ai: true },
        why: f.why,
      });
    }
    // Each round's ideas go in after the last round's.
    extra.forEach((r, j) => state.results.splice(Math.min((added + j) * 3, state.results.length), 0, r));
    added += extra.length;
    for (const x of out.rejected) if (!rejected.some((y) => y.name === x.name)) rejected.push(x);
    for (const x of out.rejected) named.push(x.name);
    renderResults();
    renderRejected(rejected);
  }
  status(
    `The AI suggested ${plural(suggested, 'firm')}: ${added} new and checked, ${rejected.length} left out because they couldn’t be verified.` +
      (failed ? ` It stopped early: ${failed}` : ''),
    !!failed,
  );
}

/* --------------------------------------------------------- careers & contacts */

/**
 * A careers check as it is kept: three page texts of 8,000 characters at most (as careers() reads them), so a few
 * hundred checks stay small and the cache isn't megabytes to rewrite on each check.
 */
function slim(result) {
  const texts = (result.texts || [])
    .slice(0, 3)
    .map((t) => ({ url: t.url, text: String(t.text || '').slice(0, 8000) }));
  return { ...result, texts };
}

/** The firm's careers pages and job boards, then who to email there; both kept for half a day. */
async function checkFirm(firm, { force } = {}) {
  const cached = state.checks[firm.id];
  if (!force && cached && Date.now() - cached.at < CHECK_AGE && state.contacts[firm.id]) return cached.result;
  if (state.running.has(firm.id)) return null;
  state.running.add(firm.id);
  rerender(firm.id);
  try {
    const result = slim(await D.careers(firm, { fetch: fetchFn, boards: firm.boards || [], pages: firm.pages || [] }));
    const at = Date.now();
    state.checks[firm.id] = { at, result };
    rerender(firm.id);
    const site = firm.site || result.site || '';
    const contacts = await C.findContacts(
      { ...firm, site, domain: firm.domain || (site ? D.domainOf(site) : '') },
      { fetch: fetchFn, pages: result.pages },
    ).catch((err) => ({
      emails: [],
      people: [],
      pattern: null,
      best: [],
      log: [{ url: site, outcome: `failed: ${errorText(err)}` }],
      status: 'unreachable',
    }));
    state.contacts[firm.id] = { at, result: contacts };
    await store.setDiscoverCache({
      careers: { [firm.id]: state.checks[firm.id] },
      contacts: { [firm.id]: state.contacts[firm.id] },
    });
    return result;
  } finally {
    state.running.delete(firm.id);
    rerender(firm.id);
  }
}

/** A thorough search reads a careers page the rules made nothing of, once the check is done (consent from the click). */
async function checkAndRead(firm, options, consent) {
  const result = await checkFirm(firm, options);
  if (result && consent && canRead(firm)) await readPage(firm, consent);
  return result;
}

const thorough = () => aiReady() && state.config.effort === 'thorough';
// Said on the check buttons and while they run: in Thorough mode a check can send a page to the AI provider.
const THOROUGH_READ =
  'In Thorough mode a careers page the rules make nothing of is also read by your AI model (one call each).';

async function checkTop() {
  const list = visible()
    .slice(0, 10)
    .filter((r) => !state.checks[r.firm.id]);
  const read = thorough();
  const consent = read ? requestAiConsent() : null;
  const button = $('#check-top');
  const line = $('#status');
  const before = [line.textContent, line.classList.contains('error')];
  const note = `Checking ${plural(list.length, 'firm')}… ${THOROUGH_READ}`;
  button.disabled = true;
  if (read && list.length) status(note);
  try {
    await D.pool(list, 3, (r) => checkAndRead(r.firm, {}, consent));
  } finally {
    button.disabled = false;
    // The search's own line again, unless a search has said something since.
    if (line.textContent === note) status(...before);
  }
}

const hasOpen = (result) => !!result && (result.status === 'roles' || result.status === 'programme');

/** Is there a careers page the rules made nothing of, for the AI to read? Not while the firm is being checked again. */
function canRead(firm) {
  const check = state.checks[firm.id];
  if (!check || !aiReady() || state.reading.has(firm.id) || state.running.has(firm.id)) return false;
  const c = state.contacts[firm.id];
  if (c && c.read) return false;
  const texts = (check.result.texts || []).filter((t) => t && t.text);
  return texts.length > 0 && ['page', 'programme', 'described', 'none'].includes(check.result.status);
}

const readFound = (r) =>
  !!r && (!!r.howToApply || !!(r.emails || []).length || !!(r.contacts || []).length || !!(r.programmes || []).length);

/** The AI reads the firm's careers page (the next one too when the first gives nothing); only what the page says stays. */
async function readPage(firm, consent) {
  const check = state.checks[firm.id];
  const texts = ((check && check.result.texts) || []).filter((t) => t && t.text);
  if (!texts.length) return;
  state.reading.add(firm.id);
  rerender(firm.id);
  let read = null;
  let readError = '';
  try {
    if (!(await consent)) throw new Error('Firefox didn’t allow sending the page to your AI provider.');
    state.config = await store.discoverAiConfig();
    const problem = ai.problem(state.config);
    if (problem) throw new Error(`${problem} (Settings › Cover letters & AI)`);
    const got = { emails: [], contacts: [], programmes: [], dropped: [], notes: '', howToApply: '', urls: [] };
    const usage = [];
    for (const t of texts.slice(0, 2)) {
      const r = await O.readPage(aiChat(), { firm, url: t.url, text: t.text, now: Date.now() });
      usage.push(r.usage);
      got.urls.push(t.url);
      for (const k of ['emails', 'contacts', 'programmes', 'dropped']) got[k].push(...(r[k] || []));
      got.howToApply = got.howToApply || r.howToApply || '';
      got.notes = [got.notes, r.notes].filter(Boolean).join(' ');
      if (readFound(r)) break;
    }
    read = { ...got, at: Date.now(), usage: usageLine(state.config, usage) };
  } catch (err) {
    readError = errorText(err);
  } finally {
    // Into what the firm's entry holds now: a contacts check that ended meanwhile keeps what it found.
    const entry = { at: Date.now(), result: null, ...state.contacts[firm.id] };
    if (read) {
      entry.read = read;
      delete entry.readError;
    } else entry.readError = readError;
    state.contacts[firm.id] = entry;
    await store.setDiscoverCache({ contacts: { [firm.id]: entry } }).catch(() => null);
    state.reading.delete(firm.id);
    rerender(firm.id);
  }
}

/* ----------------------------------------------------------- who to email */

const addressOf = (x) => String((x && (x.address || x.email)) || (typeof x === 'string' ? x : '')).trim();

/**
 * Everyone the card can offer to write to, best first, one line per address: the contacts check's picks, then what
 * the AI read on the page (verified there), the careers pages' addresses and the Hacker News post's.
 * Each: { address, name, title, kind, why, guessed, source: 'check'|'ai'|'page'|'hn' }.
 */
function contactsOf(firm) {
  const c = state.contacts[firm.id] || {};
  const read = c.read || {};
  const check = state.checks[firm.id];
  const out = [];
  const add = (x, extra) => {
    const address = addressOf(x);
    if (!address || !/@/.test(address) || out.some((o) => o.address.toLowerCase() === address.toLowerCase())) return;
    const o = typeof x === 'object' ? x : {};
    out.push({ name: o.name || '', title: o.title || '', kind: o.kind || '', why: o.why || '', ...extra, address });
  };
  for (const b of (c.result && c.result.best) || []) add(b, { guessed: !!b.guessed, source: 'check' });
  for (const p of read.contacts || []) add(p, { why: 'Named on the careers page', guessed: false, source: 'ai' });
  for (const e of read.emails || []) add(e, { why: 'On the careers page', guessed: false, source: 'ai' });
  for (const e of (check && check.result.emails) || [])
    add(e, { why: 'On the careers page', guessed: false, source: 'page' });
  for (const e of (firm.hn && firm.hn.emails) || [])
    add(e, { why: 'The Hacker News post says to write here', guessed: false, source: 'hn' });
  return out;
}

const KIND_LABEL = {
  recruiting: 'Recruiting mailbox',
  careers: 'Careers mailbox',
  internships: 'Internships mailbox',
  hr: 'HR mailbox',
  general: 'General mailbox',
};

/** "Jane Doe, Head of Talent", or what kind of mailbox it is. */
const whoLabel = (p) =>
  p.name ? [p.name, p.title].filter(Boolean).join(', ') : KIND_LABEL[p.kind] || (p.title ? p.title : 'Mailbox');

// The best way in, best first: what the status line says and how "Best way in first" sorts.
const WAYS = [
  ['ok', 'Roles open'],
  ['ok', 'Programme page'],
  ['ok', 'Programme described'],
  ['ok', 'Email to apply'],
  ['', 'A person to write to'],
  ['', 'A general mailbox'],
  ['warn', 'Nothing found'],
];

/** The best way in to a checked firm, as an index into WAYS; null when it hasn't been checked. */
function wayOf(firm) {
  const check = state.checks[firm.id];
  if (!check) return null;
  const read = (state.contacts[firm.id] || {}).read || {};
  if (check.result.status === 'roles') return 0;
  if (check.result.status === 'programme' || (read.programmes || []).length) return 1;
  if (check.result.status === 'described' || (check.result.mentions || []).length) return 2;
  const people = contactsOf(firm);
  // careers@ or internships@ is a way to apply; info@ is only somewhere to write.
  if (people.some((p) => !p.name && !p.guessed && p.kind !== 'general')) return 3;
  if (people.some((p) => p.name)) return 4;
  if (people.some((p) => !p.guessed)) return 5;
  return 6;
}

const wayText = (firm) => {
  const w = wayOf(firm);
  return w == null ? '' : WAYS[w][1];
};

/* ---------------------------------------------------------------- drafts */

/** The text of the stored CV, read once per file and cached with the cover letter material (as the studio does). */
async function readCv(profile, kit) {
  // The pasted LaTeX master (Settings › Cover letters & AI) is cleaner than text scraped from a PDF.
  if (kit.cvMaster && kit.cvMaster.sections && kit.cvMaster.sections.length) return L.cvText(kit.cvMaster);
  const doc = await store.getDoc(profile.id, 'resume');
  if (!doc) return '';
  if (kit.cv && kit.cv.updatedAt === doc.updatedAt && kit.cv.name === doc.name) return kit.cv.text || '';
  try {
    const out = await doctext.fromDataUrl(doc.dataUrl, { type: doc.type, name: doc.name });
    await store.saveKit(profile.id, { cv: { name: doc.name, updatedAt: doc.updatedAt, text: out.text } });
    return out.text;
  } catch (err) {
    const error = `Couldn’t read ${doc.name}: ${err.message}`;
    await store.saveKit(profile.id, { cv: { name: doc.name, updatedAt: doc.updatedAt, text: '', error } });
    return '';
  }
}

/**
 * The role an email could be about, as the drawer names it: the first student role or programme found, or the Hacker
 * News post's. O.draft asks about this one (a programme's clipped sentence by the programme's name).
 */
function roleOf(firm) {
  const res = (state.checks[firm.id] || {}).result || {};
  const read = (state.contacts[firm.id] || {}).read || {};
  const role = (res.roles || [])[0];
  if (role) return role.title;
  const prog = (read.programmes || [])[0] || (res.programmes || [])[0] || (res.mentions || [])[0];
  if (prog) return prog.name || clip(prog.text || prog.quote || '', 60);
  const hn = firm.hn && (firm.hn.roles || [])[0];
  return hn ? (typeof hn === 'string' ? hn : hn.title || '') : '';
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

/** What the checks found, for the email to draw on. */
function foundFor(firm) {
  const res = (state.checks[firm.id] || {}).result || {};
  const c = state.contacts[firm.id] || {};
  const read = c.read || {};
  return {
    ...res,
    roles: res.roles || [],
    programmes: [...(res.programmes || []), ...(read.programmes || [])],
    contacts: c.result || null,
    read: c.read || null,
    hn: firm.hn || null,
  };
}

const firmRef = (firm) => ({ id: firm.id, name: firm.name, domain: firm.domain || '', site: firm.site || '' });
const contactRef = (p) => ({ name: p.name || '', title: p.title || '', email: p.address, guessed: !!p.guessed });
const sameAddress = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

/** The email drawer of a firm: { open, to (the address chosen under “To”), kind, instruction, subject, body, … }. */
function drawerOf(firm) {
  if (!state.drafts[firm.id])
    state.drafts[firm.id] = { open: false, to: '', kind: 'speculative', instruction: '', subject: '', body: '' };
  return state.drafts[firm.id];
}

/** Who the drawer offers to write to: contactsOf(), and the address a draft went to when a later check drops it. */
function offeredTo(firm, d) {
  const people = contactsOf(firm);
  const was = d.draftedFor;
  if (was && !people.some((p) => sameAddress(p.address, was.address))) people.push(was);
  return people;
}

/**
 * The one chosen under “To”, by address (contactsOf() grows and reorders as checks and readings arrive), else the
 * first; the choice is kept, so what the drawer shows is who it writes to.
 */
function recipientOf(d, people) {
  const p = people.find((x) => sameAddress(x.address, d.to)) || people[0] || null;
  if (p) d.to = p.address;
  return p;
}

// A "name" that is a mailbox's ("Recruiting team"), and a title before a name ("Dr Jane Smith"), as O.draft reads them.
const MAILBOX_NAME =
  /\b(team|recruit\w*|careers?|jobs?|hr|talent|people|info|enquir\w*|inquir\w*|admin|office|hiring|internships?|graduates?|campus|mailbox|contact)\b/i;
const HONORIFIC = /^(mr|mrs|ms|miss|mx|dr|prof|professor|sir|dame)\.?\s+/i;

/**
 * The greeting O.draft opens an email to `p` with: "Dear Jane," to a person, "Dear Quiet Capital recruiting team," to
 * a recruiting mailbox, else "Hello,".
 */
function greetingFor(p, firm) {
  const name = String(p.name || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(HONORIFIC, '');
  const first = name.split(/[\s,]+/)[0];
  if (name && !/@/.test(name) && !MAILBOX_NAME.test(name) && /^\p{L}[\p{L}'’-]+$/u.test(first)) {
    const word = first === first.toUpperCase() ? first.toLowerCase() : first;
    return `Dear ${word[0].toUpperCase() + word.slice(1)},`;
  }
  // "Lansdowne Partners (UK) LLP" → "Lansdowne Partners".
  const names = L.companyAliases(
    String(firm.name || '')
      .replace(/\s*\([^)]*\)\s*/g, ' ')
      .trim(),
  );
  return p.kind === 'recruiting' && names.length ? `Dear ${names[names.length - 1]} recruiting team,` : 'Hello,';
}

// A draft's first line: "Dear Jane,", "Dear Quiet Capital recruiting team,", "Hello," (or the person's own).
const GREETING_LINE = /^(dear|hello|hi|hey|good (morning|afternoon|evening)|greetings)\b[^\n]{0,80}[,:!]?$/i;

/** The email with its first line, the greeting, made `greeting`; one whose first line is no longer a greeting stays. */
function withGreeting(body, greeting) {
  const [first, ...rest] = String(body || '').split('\n');
  return GREETING_LINE.test(first.trim()) ? [greeting, ...rest].join('\n') : body;
}

async function draftEmail(firm, consent) {
  const d = drawerOf(firm);
  const contact = recipientOf(d, offeredTo(firm, d));
  d.running = true;
  d.error = '';
  rerender(firm.id);
  try {
    if (!(await consent)) throw new Error('Firefox didn’t allow sending your material to your AI provider.');
    if (!contact) throw new Error('No one to write to yet: check the firm first.');
    state.config = await store.discoverAiConfig();
    const problem = ai.problem(state.config);
    if (problem) throw new Error(`${problem} (Settings › Cover letters & AI)`);
    const { profile } = await store.getActive();
    const kit = await store.getKit(profile.id);
    const cvText = await readCv(profile, kit);
    // Thin material makes a thin email: it is still drafted, with a word on what would help.
    d.thin = !O.material({ profile, kit, cvText }).ok;
    // The role the drawer offers is the one the email is about, not one the library picks for itself.
    const role = d.kind === 'role' ? roleOf(firm) : '';
    const kind = role ? 'role' : 'speculative';
    const r = await O.draft(aiChat(), {
      firm,
      found: foundFor(firm),
      contact: { ...contact, email: contact.address },
      profile,
      kit,
      cvText,
      instruction: d.instruction.trim(),
      kind,
      role,
      today: Date.now(),
    });
    // r.body is the whole email (greeting to contact line); a 'role' email with no role found comes back speculative.
    Object.assign(d, {
      kind: r.kind || kind,
      result: r,
      to: contact.address,
      draftedFor: contact,
      subject: r.subject || '',
      body: r.body || '',
      usage: usageLine(state.config, r.usage),
      sent: false,
    });
    const old = state.outreach[firm.id];
    // A draft after the email went (a follow-up) leaves its record as it is.
    if (!old || old.status === 'drafted')
      await setOutreach(firm, {
        status: 'drafted',
        to: contact.address,
        subject: d.subject,
        contact: contactRef(contact),
        way: wayText(firm),
      });
  } catch (err) {
    d.error = errorText(err);
  } finally {
    d.running = false;
    rerender(firm.id);
  }
}

/** "Claude Sonnet 5.5 · 1.2k tokens · $0.004", as the studio counts it. */
function usageLine(config, usage) {
  const list = [].concat(usage || []).filter((u) => u && typeof u === 'object');
  const sum = (k) => list.reduce((n, u) => n + (Number(u[k]) || 0), 0);
  // Discover's pipelines total their calls as { tokens, cost }; a single call reports the provider's own counts.
  const tokens =
    sum('tokens') ||
    sum('total_tokens') ||
    sum('prompt_tokens') + sum('completion_tokens') ||
    sum('input_tokens') + sum('output_tokens');
  const priced = list.filter((u) => typeof u.cost === 'number');
  const cost = priced.reduce((n, u) => n + u.cost, 0);
  const parts = [modelLabel(config)];
  if (tokens) parts.push(tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k tokens` : `${tokens} tokens`);
  if (priced.length) parts.push(`$${cost.toFixed(cost >= 0.001 ? 3 : 4)}`);
  return parts.join(' · ');
}

/** The model a config calls, by its name where the provider suggests it ("Claude Sonnet 5.5"). */
function modelLabel(config) {
  if (!config) return '';
  const r = ai.resolve(config);
  const known = ai.suggestions(config.provider).find((m) => m.id === r.model);
  return known ? known.name : r.model || r.label;
}

/* ---------------------------------------------------------------- outreach */

async function setOutreach(firm, patch) {
  const rec = await store.setOutreach(firm.id, { ...patch, firm: firmRef(firm) });
  if (rec) state.outreach[firm.id] = rec;
  else delete state.outreach[firm.id];
  renderOutreach();
  rerender(firm.id);
  return rec;
}

const OUTREACH_TEXT = { drafted: 'Drafted', sent: 'Sent', replied: 'Replied', closed: 'Closed' };

function day(t) {
  if (!t) return '';
  const d = new Date(t);
  const opts = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-GB', opts);
}

/** 'Drafted', 'Sent 6 Nov', 'Replied' or 'Closed'. */
function outreachPill(rec) {
  if (!rec) return null;
  const text = rec.status === 'sent' ? `Sent ${day(rec.sentAt || rec.updatedAt)}` : OUTREACH_TEXT[rec.status];
  const tone = rec.status === 'sent' || rec.status === 'replied' ? ' ok' : '';
  return el('span', { className: 'pill outreach-pill' + tone, textContent: text });
}

/* ------------------------------------------------------------ rendering */

/** The results as shown: only those with something open when asked, best way in first when asked. */
function visible() {
  const list = $('#only-open').checked
    ? state.results.filter((r) => hasOpen((state.checks[r.firm.id] || {}).result))
    : state.results;
  if (!$('#sort-way').checked) return list;
  // Checked firms by their way in (the search's order within each), unchecked ones after.
  return list
    .map((r, i) => [r, wayOf(r.firm), i])
    .sort((a, b) => (a[1] == null ? 9 : a[1]) - (b[1] == null ? 9 : b[1]) || a[2] - b[2])
    .map((x) => x[0]);
}

function money(bn) {
  return bn >= 10 ? `$${Math.round(bn)}bn` : bn >= 1 ? `$${bn.toFixed(1)}bn` : `$${Math.round(bn * 1000)}m`;
}

function meta(firm) {
  const parts = [];
  if ((firm.cities || []).length) parts.push(firm.cities.slice(0, 3).join(', '));
  if (firm.employees != null) parts.push(`${firm.employees.toLocaleString('en-GB')} staff`);
  if (firm.aum) parts.push(`${money(firm.aum)} AUM`);
  // A 1988 games studio or a 2021 startup: age is half of "reputable but low-profile".
  if (firm.founded) parts.push(`founded ${firm.founded}`);
  return parts.join(' · ');
}

const link = (href, text, props) => el('a', { href, target: '_blank', rel: 'noopener', textContent: text, ...props });

function badges(firm, flags) {
  const out = [];
  if (firm.crd) out.push(el('span', { className: 'pill ok', textContent: 'SEC-registered', title: `CRD ${firm.crd}` }));
  if (firm.yc) out.push(el('span', { className: 'pill ok', textContent: `Y Combinator ${firm.yc}` }));
  if (firm.wiki)
    out.push(
      link(`https://en.wikipedia.org/wiki/${encodeURIComponent(firm.wiki.replace(/ /g, '_'))}`, 'Wikipedia', {
        className: 'pill',
      }),
    );
  if (firm.hn && firm.hn.url)
    out.push(
      link(firm.hn.url, 'Hacker News', {
        className: 'pill hn',
        title: firm.hn.month ? `Posted in “Who is hiring”, ${firm.hn.month}` : 'Posted in “Who is hiring”',
      }),
    );
  if (firm.remote) out.push(el('span', { className: 'pill', textContent: 'Remote' }));
  if (flags && flags.ai) out.push(el('span', { className: 'pill warn', textContent: 'AI idea · verified' }));
  // The lists consulted: "Trackr" alone for a finance search without Simplify's kept.
  const lists = state.sources.join(' or ') || 'Trackr or Simplify';
  if (flags && flags.onTrackr) out.push(el('span', { className: 'pill', textContent: `On ${lists}` }));
  else if (state.listed) out.push(el('span', { className: 'pill ok', textContent: `Not on ${lists}` }));
  for (const niche of [...new Set((firm.tags || []).map(nicheOfTag).filter(Boolean))].slice(0, 3))
    out.push(el('span', { className: 'pill', textContent: niche.label }));
  out.push(outreachPill(state.outreach[firm.id]));
  return el('div', { className: 'badges' }, out);
}

/** What a Hacker News post says: the roles, who they're for, and where to write. */
function hnView(hn) {
  const roles = (hn.roles || []).map((r) => (typeof r === 'string' ? r : r.title || '')).filter(Boolean);
  const kinds = (hn.kinds || []).map(String).filter(Boolean);
  const emails = (hn.emails || []).map(addressOf).filter(Boolean);
  if (!roles.length && !kinds.length && !emails.length) return null;
  return el(
    'div',
    { className: 'hn-post small' },
    kinds.length || roles.length
      ? el(
          'p',
          { className: 'row' },
          ...kinds.map((k) =>
            el('span', { className: 'pill ok', textContent: k.charAt(0).toUpperCase() + k.slice(1) }),
          ),
          roles.length ? el('span', { textContent: clip(roles.slice(0, 4).join(' · '), 200) }) : null,
        )
      : null,
    emails.length
      ? el(
          'p',
          {},
          'Apply by email: ',
          ...emails.map((e, i) => el('a', { href: 'mailto:' + e, textContent: (i ? ', ' : '') + e })),
        )
      : null,
  );
}

const STATUS_TEXT = {
  roles: ['ok', 'Student roles open'],
  programme: ['ok', 'Programme page'],
  // HBK's careers page: "The HBK Summer Intern Experience", "intern class of 2022", no date in sight.
  described: ['ok', 'Internship programme described, no dates on the page'],
  board: ['', 'Job board, no student roles right now'],
  page: ['', 'Careers page, nothing for students right now'],
  quiet: ['', 'Nothing for students right now'],
  // Many small funds have no careers page at all and hire from speculative CVs.
  none: ['warn', 'No careers page: try a speculative application'],
  blocked: ['warn', 'The site turns robots away: open it yourself'],
  unreachable: ['bad', 'Site didn’t load'],
};

const KIND = { internship: 'Internship', graduate: 'Graduate', insight: 'Insight / spring' };

function rolesList(roles, freshKeys) {
  return el(
    'ul',
    { className: 'roles' },
    roles
      .slice(0, 12)
      .map((r) =>
        el(
          'li',
          { className: freshKeys && freshKeys.has(D.itemKey(r)) ? 'new' : '' },
          el('span', { className: 'pill ok', textContent: KIND[r.kind] || 'Role' }),
          link(r.url, r.title),
          r.location ? el('span', { className: 'where', textContent: r.location }) : null,
        ),
      ),
    roles.length > 12 ? el('li', { className: 'muted small', textContent: `…and ${roles.length - 12} more` }) : null,
  );
}

function programmesList(programmes, freshKeys) {
  return programmes
    .slice(0, 4)
    .map((p) =>
      el(
        'p',
        { className: 'programme' + (freshKeys && freshKeys.has(D.itemKey(p)) ? ' new' : '') },
        p.deadline ? el('strong', { textContent: `Deadline ${p.deadline}: ` }) : null,
        p.text,
      ),
    );
}

/** What the careers page says about its programme when it gives no date ("we annually offer a range of internship programmes"). */
function mentionsList(mentions) {
  return mentions
    .slice(0, 4)
    .map((m) =>
      el(
        'p',
        { className: 'programme mention' },
        el('span', { className: 'muted', textContent: `${KIND[m.kind] || 'Programme'} · the page says: ` }),
        m.text,
      ),
    );
}

/** 2026-11-06 as "6 November 2026"; anything else as it is. */
const longDate = (iso) =>
  /^\d{4}-\d\d-\d\d$/.test(iso)
    ? new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    : iso;

const aiPill = () => el('span', { className: 'pill ok', textContent: 'AI-read · verified on the page' });

/** What the AI read on the careers page, checked against it: how to apply and the programmes, quoted. */
function readView(read) {
  const programmes = (read.programmes || [])
    .slice(0, 4)
    .map((p) =>
      el(
        'p',
        { className: 'programme' },
        aiPill(),
        ' ',
        p.name
          ? el('strong', { textContent: p.name + (p.deadline ? ` (deadline ${longDate(p.deadline)})` : '') + ': ' })
          : null,
        p.quote ? `“${p.quote}”` : '',
        p.eligibility ? el('span', { className: 'muted', textContent: ` ${p.eligibility}` }) : null,
      ),
    );
  return [
    read.howToApply
      ? el('p', { className: 'small' }, aiPill(), ' ', el('strong', { textContent: 'How to apply: ' }), read.howToApply)
      : null,
    ...programmes,
    read.notes ? el('p', { className: 'small muted', textContent: read.notes }) : null,
    readFound(read)
      ? null
      : el('p', { className: 'small muted', textContent: 'The AI found nothing more on the page.' }),
    read.usage ? el('p', { className: 'small muted', textContent: `Read by ${read.usage}` }) : null,
  ];
}

/** "Who to email": the best few contacts (all on request), the address pattern, or where to look instead. */
function whoView(firm) {
  const c = state.contacts[firm.id];
  if (!c || !c.result)
    return el('p', { className: 'small muted', textContent: 'Press “Check again” to look for who to email.' });
  const people = contactsOf(firm);
  const all = state.showAll.has(firm.id);
  const shown = all ? people : people.slice(0, SHOWN_CONTACTS);
  const pattern = c.result.pattern && c.result.pattern.pattern;
  // Where its examples were seen, and how many: the guesses rest on them, often on a single address.
  const domain = (c.result.pattern && c.result.pattern.domain) || firm.domain || '';
  const seen = (c.result.pattern && c.result.pattern.examples) || 0;
  const site = firm.site || ((state.checks[firm.id] || {}).result || {}).site;
  const named = ((c.read && c.read.contacts) || []).filter((p) => p.name && !p.email);
  return el(
    'div',
    { className: 'contacts' },
    el('h3', { textContent: 'Who to email' }),
    people.length
      ? el(
          'ul',
          { className: 'plain contact-list' },
          shown.map((p) =>
            el(
              'li',
              {},
              el('span', { className: 'who', textContent: whoLabel(p) }),
              el('a', { href: 'mailto:' + p.address, textContent: p.address }),
              p.source === 'ai'
                ? aiPill()
                : p.guessed
                  ? el('span', { className: 'pill warn', textContent: 'Guessed', title: p.why || 'Guessed' })
                  : el('span', { className: 'pill ok', textContent: 'Listed' }),
              p.why ? el('span', { className: 'why', textContent: p.why }) : null,
            ),
          ),
        )
      : el(
          'p',
          { className: 'small' },
          'No address found: ',
          site ? link(site, 'open the site') : 'try the firm’s website or LinkedIn',
        ),
    named.length
      ? el(
          'p',
          { className: 'small' },
          aiPill(),
          ' Also named on the page, without an address: ',
          named.map((p) => [p.name, p.title].filter(Boolean).join(', ')).join('; '),
        )
      : null,
    people.length > SHOWN_CONTACTS
      ? el('button', {
          className: 'link small',
          type: 'button',
          textContent: all ? 'Show fewer' : `Show all ${people.length}`,
          onclick: () => (all ? state.showAll.delete(firm.id) : state.showAll.add(firm.id), rerender(firm.id)),
        })
      : null,
    pattern
      ? el('p', {
          className: 'small muted',
          textContent: `Addresses here follow ${/@/.test(pattern) ? pattern : `${pattern}@${domain || 'the firm’s domain'}`}${seen ? ` (${seen} seen)` : ''}`,
        })
      : null,
  );
}

function foundView(firm, result) {
  const [tone, text] = STATUS_TEXT[result.status] || ['', result.status];
  const c = state.contacts[firm.id] || {};
  const way = wayOf(firm);
  const boardText = (result.boards || [])
    .filter((b) => b.slug || b.ats === 'phenom')
    .map((b) => `${b.ats}${b.found === 'guessed' ? ' (matched by name)' : ''}`)
    .join(', ');
  const reading = state.reading.has(firm.id);
  const log = [
    ...(result.log || []),
    ...((c.result && c.result.log) || []),
    // What the AI said that the page doesn't bear out ("jane@acme.com: not on the page").
    ...((c.read && c.read.dropped) || []).map((x) => ({
      outcome: `AI-read, dropped (${(x && x.why) || 'not on the page'})`,
      url: typeof x === 'string' ? x : (x && x.what) || '',
    })),
  ];
  return el(
    'div',
    { className: 'found' },
    el(
      'p',
      { className: 'way small' },
      'Best way in: ',
      el('span', { className: `pill ${WAYS[way][0]}`, textContent: WAYS[way][1] }),
    ),
    // The check's own status, unless the way in already says it ("Programme page" twice).
    el(
      'div',
      { className: 'row small' },
      text !== WAYS[way][1] ? el('span', { className: `pill ${tone}`, textContent: text }) : null,
      boardText ? el('span', { className: 'muted', textContent: `Board: ${boardText}` }) : null,
      result.other ? el('span', { className: 'muted', textContent: `${plural(result.other, 'other job')}` }) : null,
    ),
    (result.roles || []).length ? rolesList(result.roles) : null,
    programmesList(result.programmes || []),
    mentionsList(result.mentions || []),
    c.read ? readView(c.read) : null,
    (result.pages || []).length
      ? el(
          'p',
          { className: 'small' },
          'Careers pages: ',
          ...result.pages.slice(0, 3).map((u, i) => link(u, (i ? ' · ' : '') + shortUrl(u))),
        )
      : null,
    state.running.has(firm.id) && !state.contacts[firm.id]
      ? el('p', { className: 'small muted', textContent: 'Looking for who to email…' })
      : whoView(firm),
    canRead(firm) || reading
      ? el(
          'div',
          { className: 'row' },
          el('button', {
            className: 'small read-page',
            type: 'button',
            disabled: reading,
            textContent: reading ? 'Reading the page…' : 'Ask the AI to read the page',
            title: 'Sends this firm’s careers page text to your AI provider; only what the page itself says is kept.',
            onclick: () => readPage(firm, requestAiConsent()),
          }),
        )
      : null,
    c.readError ? el('p', { className: 'small error', textContent: c.readError }) : null,
    el(
      'details',
      {},
      el('summary', { textContent: 'What was checked' }),
      el(
        'ul',
        { className: 'plain log' },
        log.map((l) => el('li', { textContent: `${l.outcome}: ${l.url}` })),
      ),
    ),
  );
}

/** The email drawer: who to, what about, the draft to edit, its checks, and the ways to send it yourself. */
function drawerView(firm) {
  const d = drawerOf(firm);
  const people = offeredTo(firm, d);
  const recipient = () => recipientOf(d, people);
  recipient();
  const role = roleOf(firm);
  const name = `kind-${firm.id}`;
  const result = d.result;
  const mailto = () => O.mailto({ to: d.to, subject: d.subject, body: d.body });
  const draftOut = result ? mailto() : null;
  const open = draftOut && el('a', { className: 'button primary small open-mail', href: draftOut.href });
  if (open) open.textContent = 'Open in your email app';
  const truncated = el('p', {
    className: 'small warn-text',
    hidden: !(draftOut && draftOut.truncated),
    textContent: 'Too long for your email app’s link: the end is cut off there, so use Copy for the whole text.',
  });
  // A draft written for someone other than the one now chosen: its greeting is swapped, and this says who it was for.
  const redraft = el('p', { className: 'small warn-text redraft' });
  const showRedraft = () => {
    const was = d.draftedFor;
    const other = !!result && !!was && !sameAddress(was.address, d.to);
    redraft.hidden = !other;
    redraft.textContent = other
      ? `Drafted for ${was.name || was.address}; press Draft again to write it for ${recipient().name || d.to}.`
      : '';
  };
  showRedraft();
  // Edits go into the link as they're typed.
  const edited = () => {
    const m = mailto();
    open.href = m.href;
    truncated.hidden = !m.truncated;
  };
  const bodyBox =
    result &&
    el('textarea', {
      name: 'body',
      rows: 10,
      value: d.body,
      oninput: (e) => ((d.body = e.target.value), edited()),
    });
  /** Another “To”: the link goes there, and a draft greets them (the card isn't drawn again, so focus stays). */
  const chooseTo = (address) => {
    const p = people.find((x) => x.address === address);
    if (!p) return;
    d.to = p.address;
    if (!result) return;
    d.body = withGreeting(d.body, greetingFor(p, firm));
    bodyBox.value = d.body;
    edited();
    showRedraft();
  };
  const copied = el('span', { className: 'small muted', attrs: { 'aria-live': 'polite' } });
  const rec = state.outreach[firm.id];
  return el(
    'div',
    { className: 'drawer' },
    el(
      'div',
      { className: 'grid' },
      el(
        'label',
        { className: 'field' },
        el('span', { textContent: 'To' }),
        el(
          'select',
          {
            name: 'contact',
            onchange: (e) => chooseTo(e.target.value),
          },
          people.map((p) =>
            el('option', {
              value: p.address,
              selected: p.address === d.to,
              textContent: `${whoLabel(p)} <${p.address}>${p.guessed ? ' (guessed)' : ''}`,
            }),
          ),
        ),
      ),
      el(
        'fieldset',
        { className: 'field kinds' },
        el('legend', { textContent: 'About' }),
        el(
          'label',
          { className: 'check' },
          el('input', {
            type: 'radio',
            name,
            value: 'speculative',
            checked: d.kind !== 'role' || !role,
            onchange: () => (d.kind = 'speculative'),
          }),
          'About internships',
        ),
        role
          ? el(
              'label',
              { className: 'check' },
              el('input', {
                type: 'radio',
                name,
                value: 'role',
                checked: d.kind === 'role',
                onchange: () => (d.kind = 'role'),
              }),
              `About ${clip(role, 70)}`,
            )
          : null,
      ),
      el(
        'label',
        { className: 'field wide' },
        el('span', { textContent: 'Anything to add (optional)' }),
        el('input', {
          type: 'text',
          name: 'instruction',
          value: d.instruction,
          placeholder: 'Mention my chess; ask about the spring week',
          autocomplete: 'off',
          oninput: (e) => (d.instruction = e.target.value),
        }),
      ),
    ),
    el(
      'div',
      { className: 'row' },
      el('button', {
        className: 'small primary draft-go',
        type: 'button',
        disabled: !!d.running,
        textContent: d.running ? 'Drafting…' : result ? 'Draft again' : 'Draft',
        onclick: () => draftEmail(firm, requestAiConsent()),
      }),
      el('span', {
        className: 'small muted',
        textContent: 'Sends your CV’s text, profile and notes, with what was found here, to your AI provider.',
      }),
    ),
    d.error ? el('p', { className: 'small error', textContent: d.error }) : null,
    result
      ? [
          el(
            'label',
            { className: 'field' },
            el('span', { textContent: 'Subject' }),
            el('input', {
              type: 'text',
              name: 'subject',
              value: d.subject,
              oninput: (e) => ((d.subject = e.target.value), edited()),
            }),
          ),
          el('label', { className: 'field' }, el('span', { textContent: 'Email' }), bodyBox),
          redraft,
          (result.checks || []).length ? checksView(result.checks) : null,
          result.ok === false
            ? el('p', {
                className: 'small warn-text',
                textContent: 'Some checks failed: read it through and fix what they name before you send it.',
              })
            : null,
          d.thin
            ? el('p', {
                className: 'small warn-text',
                textContent:
                  'There’s little about you to write from: upload your CV (Settings › Resume & files) for a more concrete email.',
              })
            : null,
          el('p', {
            className: 'small muted',
            textContent: 'Attach your CV before sending; JobToFill never sends anything.',
          }),
          truncated,
          el(
            'div',
            { className: 'row' },
            open,
            el('button', {
              className: 'small',
              type: 'button',
              textContent: 'Copy',
              title: 'Copy the email’s text',
              onclick: async () => {
                try {
                  await navigator.clipboard.writeText(d.body);
                  copied.textContent = 'Copied.';
                } catch (err) {
                  copied.textContent = 'Couldn’t copy: select the text and copy it yourself.';
                }
              },
            }),
            el('button', {
              className: 'small mark-sent',
              type: 'button',
              disabled: !!rec && rec.status !== 'drafted',
              textContent: rec && rec.status !== 'drafted' ? OUTREACH_TEXT[rec.status] : 'Mark as sent',
              // Whoever is chosen under “To” now, which may not be who the draft was written for.
              onclick: () => {
                const p = recipient();
                setOutreach(firm, {
                  status: 'sent',
                  to: p.address,
                  subject: d.subject,
                  contact: contactRef(p),
                  way: wayText(firm),
                });
              },
            }),
            copied,
          ),
          d.usage ? el('p', { className: 'small muted', textContent: d.usage }) : null,
        ]
      : null,
  );
}

/** The draft's checks: what failed, each on its own line, and the ones that passed as one count. */
function checksView(checks) {
  const failed = checks.filter((c) => !c.ok);
  const passed = checks.length - failed.length;
  return el(
    'ul',
    { className: 'plain checks small' },
    failed.map((c) => el('li', { className: 'warn-text', textContent: `✗ ${c.what}` })),
    passed
      ? el('li', {
          className: 'ok-text',
          textContent: `✓ ${failed.length ? `The other ${plural(passed, 'check')} passed` : `All ${plural(passed, 'check')} passed`}: ${checks
            .filter((c) => c.ok)
            .map((c) => c.what.replace(/^[A-Z]/, (m) => m.toLowerCase()))
            .join(', ')}.`,
        })
      : null,
  );
}

function shortUrl(u) {
  try {
    const x = new URL(u);
    return x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/$/, '');
  } catch (err) {
    return u;
  }
}

function firmCard(r) {
  const { firm } = r;
  const check = state.checks[firm.id];
  const running = state.running.has(firm.id);
  const watched = state.watch.some((w) => w.id === firm.id);
  const people = contactsOf(firm);
  const d = state.drafts[firm.id];
  return el(
    'li',
    { className: 'firm', dataset: { id: firm.id, open: String(hasOpen(check && check.result)) } },
    el(
      'div',
      { className: 'firm-head' },
      el('span', { className: 'firm-name', textContent: firm.name }),
      el('span', { className: 'firm-meta', textContent: meta(firm) }),
    ),
    badges(firm, r.flags),
    r.reasons.length || r.why || firm.about
      ? el('p', {
          className: 'firm-why',
          textContent: [
            r.why,
            firm.about,
            ...r.reasons.filter((x) => !/^SEC-registered adviser$|^Wikipedia article$/.test(x)),
          ]
            .filter(Boolean)
            .join(' · '),
        })
      : null,
    firm.hn ? hnView(firm.hn) : null,
    el(
      'div',
      { className: 'firm-actions' },
      el('button', {
        className: 'small check' + (check ? '' : ' primary'),
        type: 'button',
        disabled: running,
        textContent: running ? 'Checking…' : check ? 'Check again' : 'Check careers & contacts',
        title: thorough() ? THOROUGH_READ : '',
        onclick: () => checkAndRead(firm, { force: !!check }, thorough() ? requestAiConsent() : null),
      }),
      el('button', {
        className: 'small',
        type: 'button',
        textContent: watched ? 'Watching' : 'Watch',
        disabled: watched,
        onclick: () => watchFirm(firm),
      }),
      people.length
        ? el('button', {
            className: 'small draft',
            type: 'button',
            disabled: !aiReady(),
            title: aiReady() ? 'Draft an email to this firm with your AI' : NO_AI,
            attrs: { 'aria-expanded': String(!!(d && d.open)) },
            textContent: d && d.open ? 'Close the email' : 'Draft an email',
            onclick: () => {
              const drawer = drawerOf(firm);
              drawer.open = !drawer.open;
              rerender(firm.id);
            },
          })
        : null,
      firm.site ? link(firm.site, firm.domain || 'Website', { className: 'small' }) : null,
    ),
    running && thorough() ? el('p', { className: 'small muted reads', textContent: THOROUGH_READ }) : null,
    check ? foundView(firm, check.result) : null,
    d && d.open && people.length ? drawerView(firm) : null,
  );
}

function renderResults() {
  const list = visible();
  $('#results-card').hidden = false;
  $('#results-title').textContent = plural(list.length, 'firm');
  // Nothing to list: what to change to get something.
  const none = $('#only-open').checked
    ? 'No firm checked so far has anything open. Check more firms (“Check careers & contacts”, “Check the top 10”), or untick “Only firms with something open”.'
    : 'No firms match. Try “Anywhere”, any size, more kinds of firm, or fewer words in “Name contains”.';
  $('#results').replaceChildren(
    ...(list.length ? list.slice(0, state.shown).map(firmCard) : [el('li', { className: 'muted', textContent: none })]),
  );
  $('#more').hidden = list.length <= state.shown;
  $('#results-export').disabled = !list.length;
}

function rerender(id) {
  const old = document.querySelector(`#results .firm[data-id="${CSS.escape(id)}"]`);
  const r = state.results.find((x) => x.firm.id === id);
  if (old && r) old.replaceWith(firmCard(r));
}

function renderRejected(rejected) {
  const box = $('#rejected');
  box.hidden = !rejected.length;
  box.querySelector('summary').textContent = `${plural(rejected.length, 'AI suggestion')} left out`;
  box.querySelector('ul').replaceChildren(...rejected.map((x) => el('li', { textContent: `${x.name}: ${x.why}` })));
}

/* ------------------------------------------------------------------- CSV */

/** One cell: quoted when it must be, and text that starts like a formula kept as text in a spreadsheet. */
function csvCell(value) {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The rows as a CSV file (with a byte-order mark, so Excel reads the curly quotes). */
function saveCsv(rows, name) {
  const text = '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  // The local date, as 2026-11-06.
  const today = new Date().toLocaleDateString('en-CA');
  download(new Blob([text], { type: 'text/csv;charset=utf-8' }), `jobtofill-${name}-${today}.csv`);
}

function exportResults() {
  const rows = [
    [
      'Firm',
      'Website',
      'Careers check',
      'Best way in',
      'Contact name',
      'Title',
      'Email',
      'Guessed',
      'Outreach',
      'Source',
    ],
  ];
  for (const r of visible()) {
    const check = state.checks[r.firm.id];
    const p = contactsOf(r.firm)[0] || {};
    const rec = state.outreach[r.firm.id];
    rows.push([
      r.firm.name,
      r.firm.site || (check && check.result.site) || '',
      check ? (STATUS_TEXT[check.result.status] || ['', check.result.status])[1] : 'Not checked',
      wayText(r.firm),
      p.name || '',
      p.title || '',
      p.address || '',
      p.address ? (p.guessed ? 'yes' : 'no') : '',
      rec ? OUTREACH_TEXT[rec.status] : '',
      r.flags && r.flags.hn ? 'Hacker News' : r.flags && r.flags.ai ? 'AI idea' : r.firm.source || 'Registry',
    ]);
  }
  saveCsv(rows, 'firms');
}

function exportOutreach() {
  const rows = [
    [
      'Firm',
      'Website',
      'Contact name',
      'Title',
      'Email',
      'Guessed',
      'Status',
      'Date',
      'Subject',
      'Notes',
      'Best way in',
    ],
  ];
  for (const [id, rec] of outreachList()) {
    const c = rec.contact || {};
    rows.push([
      rec.firm.name,
      rec.firm.site || (rec.firm.domain ? 'https://' + rec.firm.domain : ''),
      c.name || '',
      c.title || '',
      c.email || rec.to || '',
      c.email || rec.to ? (c.guessed ? 'yes' : 'no') : '',
      OUTREACH_TEXT[rec.status] || rec.status,
      new Date(rec.status === 'sent' && rec.sentAt ? rec.sentAt : rec.updatedAt).toISOString().slice(0, 10),
      rec.subject || '',
      rec.notes || '',
      (state.checks[id] && wayText({ id })) || rec.way || '',
    ]);
  }
  saveCsv(rows, 'outreach');
}

/* -------------------------------------------------------------- outreach tab */

const outreachList = () => Object.entries(state.outreach).sort(([, a], [, b]) => b.updatedAt - a.updatedAt);

async function loadOutreach() {
  state.outreach = await store.getOutreach();
  renderOutreach();
}

// Notes are saved a moment after typing stops, when the box is left, and when the tab is closed or hidden.
const notes = new Map(); // firmId → { text, timer }

async function writeNote(id) {
  const pending = notes.get(id);
  if (!pending) return;
  clearTimeout(pending.timer);
  notes.delete(id);
  if (!state.outreach[id]) return;
  const rec = await store.setOutreach(id, { notes: pending.text });
  if (rec) state.outreach[id] = rec;
  $('#outreach-status').textContent = 'Saved.';
}

function saveNote(id, text, now) {
  const pending = notes.get(id);
  if (pending) clearTimeout(pending.timer);
  notes.set(id, { text, timer: setTimeout(() => writeNote(id), 600) });
  if (now) writeNote(id);
}

const flushNotes = () => [...notes.keys()].forEach(writeNote);

function outreachItem(id, rec) {
  const c = rec.contact || {};
  const firmName = rec.firm.site ? link(rec.firm.site, rec.firm.name) : rec.firm.name;
  const when =
    rec.status === 'sent' && rec.sentAt
      ? `Sent ${day(rec.sentAt)}`
      : `${OUTREACH_TEXT[rec.status]} ${day(rec.updatedAt)}`;
  return el(
    'li',
    { className: 'firm outreach-item', dataset: { id } },
    el(
      'div',
      { className: 'firm-head' },
      el('span', { className: 'firm-name' }, firmName),
      el('span', { className: 'firm-meta', textContent: when }),
    ),
    el(
      'p',
      { className: 'small' },
      [c.name, c.title].filter(Boolean).join(', ') + (c.name || c.title ? ' ' : ''),
      c.email || rec.to ? el('a', { href: 'mailto:' + (c.email || rec.to), textContent: c.email || rec.to }) : '',
      c.guessed ? el('span', { className: 'pill warn', textContent: 'Guessed' }) : null,
      rec.subject ? el('span', { className: 'muted', textContent: ` · “${rec.subject}”` }) : null,
    ),
    el(
      'div',
      { className: 'outreach-fields' },
      el(
        'label',
        { className: 'field' },
        el('span', { textContent: 'Status' }),
        el(
          'select',
          {
            className: 'outreach-status',
            onchange: async (e) => {
              const item = e.target.closest('li');
              const value = e.target.value;
              // A note typed a moment ago is saved first, so the item drawn again shows it.
              await writeNote(id);
              const next = await store.setOutreach(id, { status: value });
              state.outreach[id] = next;
              const fresh = outreachItem(id, next);
              item.replaceWith(fresh);
              fresh.querySelector('select').focus();
              rerender(id);
            },
          },
          Object.entries(OUTREACH_TEXT).map(([value, text]) =>
            el('option', { value, textContent: text, selected: value === rec.status }),
          ),
        ),
      ),
      el(
        'label',
        { className: 'field' },
        el('span', { textContent: 'Notes' }),
        el('textarea', {
          className: 'outreach-notes',
          rows: 2,
          value: rec.notes || '',
          placeholder: 'Spoke to Jane; call back in January',
          oninput: (e) => saveNote(id, e.target.value),
          onchange: (e) => saveNote(id, e.target.value, true),
        }),
      ),
    ),
    el(
      'div',
      { className: 'firm-actions' },
      el('button', {
        className: 'small',
        type: 'button',
        textContent: 'Remove',
        onclick: async () => {
          clearTimeout((notes.get(id) || {}).timer);
          notes.delete(id);
          await store.removeOutreach(id);
          delete state.outreach[id];
          renderOutreach();
          rerender(id);
        },
      }),
    ),
  );
}

function renderOutreach() {
  const list = outreachList();
  $('#outreach-count').textContent = String(list.length);
  $('#outreach-empty').hidden = !!list.length;
  $('#outreach-export').disabled = !list.length;
  // A note being typed isn't drawn again under the cursor when a draft elsewhere adds a firm: that firm waits.
  const typing = document.activeElement && document.activeElement.closest('#outreach .outreach-notes');
  if (typing) return;
  $('#outreach').replaceChildren(...list.map(([id, rec]) => outreachItem(id, rec)));
}

/* ------------------------------------------------------------- watchlist */

async function watchFirm(firm) {
  const result = (state.checks[firm.id] || {}).result || (await checkFirm(firm));
  const entry = {
    id: firm.id,
    firm,
    boards: result ? result.boards.filter((b) => b.slug || b.ats === 'phenom') : [],
    pages: result ? result.pages.filter((u) => !/greenhouse|lever|ashby|workable|myworkday/.test(u)).slice(0, 3) : [],
    emails: result ? result.emails : [],
  };
  await store.saveWatch(entry);
  // What's open today is the baseline; only later additions count as new.
  if (result)
    await store.setWatchState(firm.id, {
      seen: [...result.roles, ...result.programmes].map(D.itemKey),
      fresh: [],
      checkedAt: Date.now(),
      status: result.status,
      roles: result.roles.length,
      programmes: result.programmes.length,
    });
  await loadWatch();
  rerender(firm.id);
}

async function loadWatch() {
  state.watch = await store.getWatchlist();
  state.watchStates = await store.getWatchStates(state.watch.map((w) => w.id));
  const fresh = Object.values(state.watchStates).reduce((n, s) => n + ((s && s.fresh.length) || 0), 0);
  $('#watch-count').textContent = fresh ? `${fresh} new` : String(state.watch.length);
  $('#watch-count').className = 'pill' + (fresh ? ' ok' : '');
  renderWatch();
}

function ago(t) {
  if (!t) return 'not checked yet';
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1
    ? 'checked just now'
    : m < 60
      ? `checked ${m} min ago`
      : m < 48 * 60
        ? `checked ${Math.round(m / 60)} h ago`
        : `checked ${Math.round(m / 1440)} days ago`;
}

function renderWatch() {
  const fresh = state.watch.some((w) => ((state.watchStates[w.id] || {}).fresh || []).length);
  $('#watch-empty').hidden = !!state.watch.length;
  // Nothing watched: nothing to check or mark; nothing new: nothing to mark as seen.
  $('#watch-check').hidden = !state.watch.length;
  $('#watch-seen').hidden = !state.watch.length;
  $('#watch-seen').disabled = !fresh;
  const cards = state.watch.map((w) => {
    const st = state.watchStates[w.id] || { fresh: [] };
    const freshKeys = new Set(st.fresh.map(D.itemKey));
    const [tone, text] = STATUS_TEXT[st.status] || ['', 'Waiting for the first check'];
    const roles = st.fresh.filter((x) => x.title);
    const programmes = st.fresh.filter((x) => !x.title);
    const check = state.checks[w.id];
    return el(
      'li',
      { className: 'firm', dataset: { open: String(st.fresh.length > 0) } },
      el(
        'div',
        { className: 'firm-head' },
        el('span', { className: 'firm-name', textContent: w.firm.name }),
        el('span', {
          className: 'firm-meta',
          textContent: [meta(w.firm), ago(st.checkedAt)].filter(Boolean).join(' · '),
        }),
      ),
      el(
        'div',
        { className: 'row small' },
        el('span', { className: `pill ${tone}`, textContent: text }),
        st.fresh.length ? el('span', { className: 'pill ok', textContent: `${st.fresh.length} new` }) : null,
        st.roles ? el('span', { className: 'muted', textContent: plural(st.roles, 'student role') + ' open' }) : null,
      ),
      roles.length ? rolesList(roles, freshKeys) : null,
      programmesList(programmes, freshKeys),
      check && !st.fresh.length && check.result.roles.length ? rolesList(check.result.roles) : null,
      el(
        'div',
        { className: 'firm-actions' },
        w.pages[0] ? link(w.pages[0], 'Careers page', { className: 'small' }) : null,
        w.firm.site ? link(w.firm.site, w.firm.domain, { className: 'small' }) : null,
        el('button', {
          className: 'small',
          type: 'button',
          textContent: 'Remove',
          onclick: async () => (await store.removeWatch(w.id), await send({ type: 'jtf:watch-badge' }), loadWatch()),
        }),
      ),
    );
  });
  $('#watchlist').replaceChildren(...cards);
}

async function checkWatchNow() {
  const button = $('#watch-check');
  button.disabled = true;
  $('#watch-status').textContent = `Checking ${plural(state.watch.length, 'firm')}…`;
  try {
    const r = await send({ type: 'jtf:watch-check' });
    $('#watch-status').textContent =
      r && r.error ? r.error : `Checked. ${r.fresh ? `${r.fresh} new.` : 'Nothing new.'}`;
  } finally {
    button.disabled = false;
    await loadWatch();
  }
}

async function markSeen() {
  for (const w of state.watch) await store.setWatchState(w.id, { fresh: [] });
  await send({ type: 'jtf:watch-badge' });
  await loadWatch();
}

const TABS = ['find', 'watch', 'outreach'];

function showTab(which) {
  for (const t of TABS) {
    $(`#tab-${t}`).setAttribute('aria-selected', String(which === t));
    $(`#${t}-view`).hidden = which !== t;
  }
  history.replaceState(null, '', which === 'find' ? '#' : '#' + which);
}

/* ------------------------------------------------------------- AI model */

/** The model Settings › Cover letters & AI saved for a provider. */
function settingsModel(id) {
  const s = { ...store.DEFAULT_SETTINGS.ai, ...(state.settings && state.settings.ai) };
  if (s.models && s.models[id] != null) return s.models[id];
  return id === s.provider ? s.model || '' : '';
}

let picker = null;

/** The "AI model for this page" box: provider (Same as Settings, or one with a key), model and effort. */
async function buildAiBox() {
  let settingsConfig;
  [state.settings, state.keys, settingsConfig] = await Promise.all([
    store.getSettings(),
    store.getAiKeys(),
    store.aiConfig(),
  ]);
  const chosen = state.settings.discoverAi;
  const settingsAi = { ...store.DEFAULT_SETTINGS.ai, ...state.settings.ai };
  const keyed = Object.keys(ai.PROVIDERS).filter((id) => state.keys[id]);
  const label = (id) => (ai.PROVIDERS[id] || ai.PROVIDERS.custom).label;
  $('#discover-provider').replaceChildren(
    // "Same as Settings (Claude Sonnet 5.5)": the model those calls would use.
    el('option', {
      value: '',
      textContent: `Same as Settings (${settingsConfig.apiKey ? modelLabel(settingsConfig) : 'no key yet'})`,
    }),
    ...keyed.map((id) => el('option', { value: id, textContent: label(id) })),
  );
  $('#discover-provider').value = keyed.includes(chosen.provider) ? chosen.provider : '';
  $('#discover-effort').value = chosen.effort;
  $('#ai-none').hidden = keyed.length > 0;
  if (!picker) {
    picker = modelPicker({
      name: 'discover-model',
      list: (id) =>
        ai.models({ provider: id, baseUrl: id === 'custom' ? settingsAi.baseUrl : '', apiKey: state.keys[id] || '' }),
      onChange: (model) => saveAi({ model }),
    });
    $('#discover-model-field').append(...picker.parts);
  }
  showProvider(chosen.model);
}

/** Show the model of the provider chosen (its own, else the one Settings saved for it); none for Same as Settings. */
function showProvider(model) {
  const id = $('#discover-provider').value;
  $('#discover-model-field').hidden = !id;
  if (id) picker.set(id, model || settingsModel(id));
  const same =
    !id && state.config ? `Uses ${modelLabel(state.config)}, as chosen under Settings › Cover letters & AI.` : '';
  $('#discover-same').textContent = same;
  $('#discover-same').hidden = !same;
}

async function saveAi(patch) {
  await store.saveDiscoverAi(patch);
  state.config = await store.discoverAiConfig();
  $('#ai-saved').textContent = 'Saved.';
  // Another provider shows its own model. A choice made in the picker stays as it is: drawing it again would undo
  // “Another model…”, which saves '' (the provider's model under Settings) until an id is typed in its box.
  if ('provider' in patch) showProvider('');
  syncAi();
}

/**
 * Everything that depends on whether an AI is set up: the summary, the tick box, the check buttons' word on Thorough
 * mode, the cards' AI buttons. Not the model picker: buildAiBox() and a change of provider draw that.
 */
function syncAi() {
  const c = state.config;
  const ready = aiReady();
  const effort = c && c.effort === 'thorough' ? ' · thorough' : '';
  $('#ai-summary').textContent = ready
    ? `AI: ${modelLabel(c)}${c.source === 'settings' ? ' (same as Settings)' : ` (${ai.resolve(c).label})`}${effort}`
    : 'AI: none set up yet';
  $('#use-ai').disabled = !ready;
  $('#ai-wrap').title = ready ? '' : NO_AI;
  $('#check-top').title = thorough() ? THOROUGH_READ : '';
  if (state.results.length) renderResults();
}

/* ------------------------------------------------------------------ init */

function buildForm() {
  const groups = D.NICHE_GROUPS || { finance: 'Finance' };
  const byGroup = new Map(Object.keys(groups).map((g) => [g, []]));
  for (const [id, n] of Object.entries(D.NICHES)) {
    const g = n.group || 'finance';
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup
      .get(g)
      .push(
        el(
          'label',
          { className: 'chip' },
          el('input', { type: 'checkbox', value: id, checked: id === 'hedge' }),
          n.label,
        ),
      );
  }
  $('#niches').replaceChildren(
    ...[...byGroup]
      .filter(([, chips]) => chips.length)
      .map(([g, chips]) =>
        el(
          'div',
          { className: 'niche-group', dataset: { group: g }, attrs: { role: 'group', 'aria-label': groups[g] || g } },
          el('span', { className: 'niche-head', textContent: groups[g] || g }),
          el('div', { className: 'chips' }, chips),
        ),
      ),
  );
  $('#place').replaceChildren(
    ...Object.entries(D.PLACES).map(([id, p]) => el('option', { value: id, textContent: p.label })),
  );
  $('#place').value = 'london';
  $('#size').replaceChildren(
    ...Object.entries(D.SIZES).map(([id, s]) => el('option', { value: id, textContent: s.label })),
  );
  $('#size').value = 'small';
}

async function start() {
  buildForm();
  $('#query').addEventListener('submit', search);
  $('#more').addEventListener('click', () => ((state.shown += PAGE), renderResults()));
  $('#only-open').addEventListener('change', renderResults);
  $('#sort-way').addEventListener('change', renderResults);
  $('#check-top').addEventListener('click', checkTop);
  $('#results-export').addEventListener('click', exportResults);
  $('#outreach-export').addEventListener('click', exportOutreach);
  for (const t of TABS) $(`#tab-${t}`).addEventListener('click', () => showTab(t));
  $('#watch-check').addEventListener('click', checkWatchNow);
  $('#watch-seen').addEventListener('click', markSeen);
  $('#watch-find').addEventListener('click', () => {
    showTab('find');
    $('#search').focus();
  });
  $('#ai-settings').addEventListener('click', () =>
    api.tabs.create({ url: api.runtime.getURL('options/options.html#letters') }),
  );
  $('#discover-provider').addEventListener('change', () => saveAi({ provider: $('#discover-provider').value }));
  // Enter in the model box chooses the model; it doesn't search.
  $('#ai-box').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('input')) e.preventDefault();
  });
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flushNotes());
  addEventListener('pagehide', flushNotes);
  $('#discover-effort').addEventListener('change', () => saveAi({ effort: $('#discover-effort').value }));
  state.config = await store.discoverAiConfig();
  await buildAiBox();
  syncAi();
  await Promise.all([
    loadRegistry(),
    loadWatch(),
    loadOutreach(),
    store.getDiscoverCache().then((c) => ((state.checks = c.careers || {}), (state.contacts = c.contacts || {}))),
  ]);
  const tab = location.hash.slice(1);
  showTab(TABS.includes(tab) ? tab : 'find');
}

async function boot() {
  if (await hasSiteAccess()) return start();
  $('#access').hidden = false;
  $('#access-allow').onclick = async () => {
    if (!(await requestSiteAccess())) return;
    $('#access').hidden = true;
    start();
  };
}

boot().catch((err) => status(errorText(err), true));
