/*
 * JobToFill — Discover internships. Finds reputable firms that keep a low profile (small hedge funds,
 * quant shops, boutique advisers, small tech companies…) from a bundled registry built from the SEC's adviser
 * register, Wikipedia and Y Combinator's directory, and from Hacker News' "Who is hiring" posts; leaves out the
 * ones Trackr and Simplify already list; reads each firm's own careers pages, job boards and team pages for student
 * roles and who to email; drafts that email with the person's own AI; and keeps a watchlist that the background
 * re-checks and an outreach list of the firms written to. With the person's AI it also searches the web for the people
 * to write to and the firm's address format (every claim held to what the search returned), checks addresses (MX, and
 * Hunter with their key), and with Nylas connected it saves the email to their drafts or sends it, CV attached, only
 * when they press that button for that email.
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
  discoverResearch: R,
  discoverFinder: F,
  nylas: N,
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
  research: {}, // firmId → { at, result (researchFirm()), error }
  hooks: {}, // firmId → { at, common, result (discoverHooks.find()) }: reasons to write
  researching: new Set(),
  moved: {}, // firmId → { url, name }: where the web research found a firm whose site on file didn't load (GLG → man.com)
  running: new Set(),
  reading: new Set(),
  showAll: new Set(), // cards showing every contact
  drafts: {}, // firmId → the email drawer: { contact, kind, instruction, subject, body, result, running, error, … }
  watch: [],
  watchStates: {},
  outreach: {}, // firmId → store.getOutreach() record
  config: null, // store.discoverAiConfig(): what every AI call on this page uses
  keys: {},
  finderKeys: {}, // store.getFinderKeys(): { hunter }
  nylas: null, // store.getNylas(): the inbox drafts are saved to and sent from
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

/**
 * The firm as it is now: one whose site on file didn't load and that the web research found elsewhere is checked
 * and written to there, under the name it goes by there (GLG Partners at man.com is Man Group: man.com's pages never
 * say "GLG", and an email to them shouldn't either).
 */
function nowAt(firm) {
  const moved = state.moved[firm.id];
  if (!moved) return firm;
  return {
    ...firm,
    site: moved.url,
    domain: D.domainOf(moved.url),
    ...(moved.name ? { name: moved.name, aliases: [firm.name, ...(firm.aliases || [])] } : {}),
  };
}

/** The firm's careers pages and job boards, then who to email there; both kept for half a day. */
async function checkFirm(firm, { force } = {}) {
  const cached = state.checks[firm.id];
  if (!force && cached && Date.now() - cached.at < CHECK_AGE && state.contacts[firm.id]) return cached.result;
  if (state.running.has(firm.id)) return null;
  state.running.add(firm.id);
  rerender(firm.id);
  firm = nowAt(firm);
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

/** Find people at the top 10 firms not yet searched, two at a time (each checks its firm first if need be). */
async function researchTop() {
  const list = visible()
    .slice(0, 10)
    .filter((r) => !state.research[r.firm.id]);
  const consent = canSearch() ? requestAiConsent() : null;
  const button = $('#research-top');
  button.disabled = true;
  try {
    await D.pool(list, 2, (r) => researchFirm(r.firm, consent));
  } finally {
    button.disabled = false;
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
  const web = (state.research[firm.id] || {}).result || null;
  const out = [];
  const add = (x, extra) => {
    const address = addressOf(x);
    if (!address || !/@/.test(address)) return;
    const o = typeof x === 'object' ? x : {};
    const next = { name: o.name || '', title: o.title || '', kind: o.kind || '', why: o.why || '', ...extra, address };
    const had = out.find((y) => y.address.toLowerCase() === address.toLowerCase());
    if (!had) return out.push(next);
    // Found twice (the site's pattern guessed it; the web research made it from the same format and found its domain
    // takes mail): the surer finding stands, and the name and title fill in.
    const level = (y) => LEVEL_RANK[y.level || (y.guessed ? 'guessed' : 'listed')] ?? 3;
    if (level(next) < level(had))
      Object.assign(had, { ...next, name: had.name || next.name, title: had.title || next.title });
  };
  for (const b of (c.result && c.result.best) || [])
    add(b, { guessed: !!b.guessed, source: 'check', role: b.role || '', level: b.guessed ? 'guessed' : 'listed' });
  for (const p of read.contacts || []) add(p, { why: 'Named on the careers page', guessed: false, source: 'ai' });
  for (const e of read.emails || []) add(e, { why: 'On the careers page', guessed: false, source: 'ai' });
  for (const e of (check && check.result.emails) || [])
    add(e, { why: 'On the careers page', guessed: false, source: 'page' });
  for (const e of (firm.hn && firm.hn.emails) || [])
    add(e, { why: 'The Hacker News post says to write here', guessed: false, source: 'hn' });
  for (const p of (web && web.people) || [])
    if (p.address && p.level !== 'bad')
      add(
        { ...p, kind: 'person', why: p.why },
        { guessed: p.how === 'format', source: 'web', level: p.level, url: p.url, group: p.group, check: p.verdict },
      );
  for (const e of (web && web.mailboxes) || [])
    add(e, { why: e.why, guessed: false, source: 'web', level: e.level || 'listed', url: e.url });
  // Whoever runs recruiting first (a careers@ mailbox, then a named recruiter), then the heads of technology and
  // research, then a small firm's partners, then info@; within each, the surest address first.
  const order = out.map((p, i) => [rankOf(p), LEVEL_RANK[p.level || (p.guessed ? 'guessed' : 'listed')] ?? 3, i, p]);
  order.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  return order.map((x) => x[3]);
}

const LEVEL_RANK = { verified: 0, listed: 1, likely: 2, guessed: 3, unconfirmed: 4 };
const GROUP_RANK = { recruiting: 1, technology: 2, research: 2, trading: 2, leadership: 3, other: 5 };

/** Where a contact goes in the list: recruiting mailbox 0, recruiter 1, department head 2, leader 3, info@ 4. */
function rankOf(p) {
  // A mailbox or a recruiter for students comes first (internships@, Man Group's "Emerging Talent Partner"), then
  // careers@ and jobs@, then other recruiters, then HR's own mailboxes (hr@, Man Group's hrso@).
  const forStudents = /intern|grad|campus|student|early|emerging|university/i;
  if (!p.name) {
    if (p.kind === 'general') return 4;
    if (forStudents.test(p.address)) return 0;
    return /career|recruit|job|talent|apply|cv|hiring/i.test(p.address) ? 1 : 1.5;
  }
  const recruiting = p.group === 'recruiting' || (!p.group && p.role === 'recruiting');
  if (recruiting) return forStudents.test(p.title || '') ? 0.5 : 1.2;
  if (p.group) return GROUP_RANK[p.group] ?? 5;
  if (p.role === 'leadership') return 3;
  return p.source === 'check' ? 3 : 5;
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
  const web = (state.research[firm.id] || {}).result || {};
  return {
    ...res,
    roles: res.roles || [],
    // The web research's programmes are quoted from a page it returned, like the AI reading's.
    programmes: [...(res.programmes || []), ...(read.programmes || []), ...(web.programmes || [])],
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
      firm: nowAt(firm),
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
  // Named on the firm's own site with no address (HBK's Head of Recruitment), unless the web research gave them one.
  const withAddress = new Set(people.filter((p) => p.name).map((p) => p.name.toLowerCase()));
  const onSite = (c.result.named || []).filter((p) => p.name && !withAddress.has(p.name.toLowerCase()));
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
              p.source === 'ai' ? aiPill() : levelPill(p),
              p.why ? el('span', { className: 'why', textContent: p.why }) : null,
              p.url ? link(p.url, sourceName(p.url), { className: 'source small' }) : null,
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
    onSite.length
      ? el(
          'p',
          { className: 'small named' },
          'Named on its site, no address yet: ',
          onSite
            .slice(0, 4)
            .map((p) => [p.name, p.title].filter(Boolean).join(', '))
            .join('; '),
          canResearch() && !state.research[firm.id] ? ' (Find people looks for their address format)' : '',
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

const LEVEL_PILL = {
  verified: ['ok', 'Verified', 'A mailbox check says this address exists'],
  listed: ['ok', 'Listed', 'Printed on the firm’s site or another page'],
  likely: ['', 'Likely', 'Made from the firm’s confirmed address format, on a domain that takes email'],
  guessed: ['warn', 'Guessed', 'Made from the firm’s address format'],
  unconfirmed: ['warn', 'Unconfirmed', 'Nothing confirms this address'],
};

/** How sure an address is, as a pill: Verified, Listed, Likely, Guessed. */
function levelPill(p) {
  const level = p.level || (p.guessed ? 'guessed' : 'listed');
  const [tone, text, title] = LEVEL_PILL[level] || LEVEL_PILL.unconfirmed;
  return el('span', { className: `pill ${tone}`.trim(), textContent: text, title: p.check || title });
}

/** "LinkedIn", "hbk.com", the source a contact was found on. */
function sourceName(url) {
  const host = shortUrl(url).split('/')[0];
  return /linkedin\.com$/.test(host) ? 'LinkedIn' : host;
}

/* -------------------------------------------------------------- research */

const RESEARCH_NOTE =
  'Searches the web with your AI (about six searches, a few cents on your key) and, with a Hunter key, Hunter’s directory, for the people to write to and the firm’s address format. Sends the firm’s name and what its site showed, nothing about you; every name and address is kept only if a search result or page shows it.';
const canSearch = () => aiReady() && ai.canSearch(state.config);
const canResearch = () => canSearch() || !!state.finderKeys.hunter;

/**
 * Who to write to at a firm, beyond its own site: the web research (its people, printed addresses and address format,
 * and its website now when the one on file didn't load), Hunter's directory with a key, an address made from the best
 * confirmed format for each person without one, and a check of each address (MX for all, Hunter's mailbox check for
 * the first few with a key). Checks the firm first when it hasn't been.
 */
async function researchFirm(firm, consent) {
  if (state.researching.has(firm.id)) return;
  state.researching.add(firm.id);
  const entry = (state.research[firm.id] = { ...(state.research[firm.id] || {}), error: '' });
  rerender(firm.id);
  try {
    if (!state.checks[firm.id]) await checkFirm(firm);
    const useAi = canSearch();
    if (useAi && consent && !(await consent))
      throw new Error('Firefox didn’t allow sending the firm’s name to your AI provider.');
    const check = (state.checks[firm.id] || {}).result || {};
    let web = null;
    if (useAi) {
      state.config = await store.discoverAiConfig();
      web = await R.research((messages, options) => ai.search(state.config, { messages, ...options }), {
        firm: { ...firm, site: (state.moved[firm.id] || {}).url || firm.site || check.site || '' },
        found: check,
        contacts: (state.contacts[firm.id] || {}).result || {},
        fetch: fetchFn,
      });
      // A site that moved (GLG Partners is part of Man Group now): its careers and contacts are read there.
      if (web.website.confirmed && ['unreachable', 'none', 'blocked'].includes(check.status)) {
        state.moved[firm.id] = { url: web.website.url, name: web.website.name || '' };
        await checkFirm(firm, { force: true });
      }
    }
    const found = await addressesFor(firm, web);
    entry.result = { ...(web || {}), ...found, usage: web && web.usage, at: Date.now() };
    entry.at = Date.now();
    await store.setDiscoverCache({ research: { [firm.id]: { at: entry.at, result: entry.result } } });
  } catch (err) {
    entry.error = errorText(err);
  } finally {
    state.researching.delete(firm.id);
    rerender(firm.id);
  }
}

/** The domain a firm's people have their addresses on: the format's, its site's now, or the one on file. */
function mailDomain(firm) {
  const c = (state.contacts[firm.id] || {}).result || {};
  const check = (state.checks[firm.id] || {}).result || {};
  return (
    (c.pattern && c.pattern.domain) ||
    D.domainOf((state.moved[firm.id] || {}).url || '') ||
    firm.domain ||
    D.domainOf(firm.site || check.site || '')
  );
}

/** Every person found, each with the surest address there is, checked (R.addresses with this page's keys). */
function addressesFor(firm, web) {
  return R.addresses(web, {
    firm,
    contacts: (state.contacts[firm.id] || {}).result || {},
    domain: mailDomain(firm),
    hunterKey: state.finderKeys.hunter || '',
    fetch: fetchFn,
  });
}

/** The web research's part of a card: what it found that the site didn't say, and what it dropped. */
function researchView(firm) {
  const entry = state.research[firm.id];
  const running = state.researching.has(firm.id);
  if (!entry && !running) return null;
  const r = (entry && entry.result) || null;
  const noAddress = r ? (r.people || []).filter((p) => !p.address) : [];
  return el(
    'div',
    { className: 'research small' },
    running ? el('p', { className: 'muted', textContent: 'Searching the web for who to write to…' }) : null,
    entry && entry.error ? el('p', { className: 'error', textContent: entry.error }) : null,
    r && r.website && r.website.confirmed
      ? el(
          'p',
          {},
          'Its website now: ',
          link(r.website.url, shortUrl(r.website.url)),
          r.website.note ? ` (${r.website.note})` : '',
        )
      : null,
    r && (r.programmes || []).length
      ? el(
          'ul',
          { className: 'plain' },
          r.programmes.map((p) =>
            el(
              'li',
              {},
              el('strong', { textContent: p.name ? `${p.name}: ` : '' }),
              `“${p.quote}” `,
              link(p.url, sourceName(p.url)),
            ),
          ),
        )
      : null,
    r && (r.careers || []).length
      ? el(
          'p',
          {},
          'Careers pages on the web: ',
          ...r.careers.slice(0, 3).map((c, i) => link(c.url, (i ? ' · ' : '') + shortUrl(c.url))),
        )
      : null,
    noAddress.length
      ? el(
          'p',
          {},
          `Also found, no address yet (no confirmed format): `,
          noAddress.map((p) => [p.name, p.title].filter(Boolean).join(', ')).join('; '),
        )
      : null,
    r && r.format
      ? el('p', {
          className: 'muted',
          textContent: `Address format: ${r.format.pattern}@${r.format.domain} (${r.format.why})`,
        })
      : r
        ? el('p', {
            className: 'muted',
            textContent: (r.disputed || []).length
              ? `No address format confirmed: the directories disagree (${r.disputed.join(' or ')}).`
              : 'No address format confirmed: names without an address are listed above.',
          })
        : null,
    r && r.hunter && r.hunter.error ? el('p', { className: 'warn-text', textContent: r.hunter.error }) : null,
    r && r.usage
      ? el('p', {
          className: 'muted',
          textContent: `Web search: ${plural(r.searches || 0, 'search', 'searches')}, ${usageLine(state.config, r.usage)}`,
        })
      : null,
    r && (r.dropped || []).length
      ? el(
          'details',
          {},
          el('summary', { textContent: `Left out: ${plural(r.dropped.length, 'claim')} no source bore out` }),
          el(
            'ul',
            { className: 'plain log' },
            r.dropped.map((d) => el('li', { textContent: `${d.what}: ${d.why}` })),
          ),
        )
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
          sendView(firm, d, recipient),
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

/* ---------------------------------------------------------------- sending */

/** Can the connected inbox take a draft or send ({ draft, send }), asked of Nylas once per page. */
async function inboxAbilities() {
  if (!state.nylas || !state.nylas.grantId) return { draft: false, send: false };
  if (!state.abilities)
    state.abilities = N.abilities(state.nylas, { fetch: fetchFn }).catch((err) => ({
      draft: true,
      send: true,
      error: errorText(err),
    }));
  return state.abilities;
}

/** The CV a sent email carries: the stored resume file ({ name, dataUrl, type }), or null. */
async function cvFile() {
  const { profile } = await store.getActive();
  const doc = await store.getDoc(profile.id, 'resume');
  return doc && doc.dataUrl ? doc : null;
}

/**
 * Send the drawer's email from the connected inbox, or save it to its drafts (Gmail's Drafts folder), CV attached when
 * ticked. Sending asks first, naming who it goes to and from, and says when the address is only made from a format
 * or the draft failed a check. The outreach record says how it went (and keeps the thread, for replies).
 */
async function sendEmail(firm, how) {
  const d = drawerOf(firm);
  const p = recipientOf(d, offeredTo(firm, d));
  if (!p || d.sending) return;
  const cv = d.attach !== false ? await cvFile() : null;
  if (how === 'send') {
    const doubts = [
      p.guessed || ['likely', 'guessed', 'unconfirmed'].includes(p.level)
        ? `${p.address} is made from the firm’s address format and isn’t confirmed: it may bounce.`
        : '',
      d.result && d.result.ok === false ? 'Some of the draft’s checks failed: read it through first.' : '',
    ].filter(Boolean);
    const from = (state.nylas && state.nylas.email) || 'your inbox';
    const ask = [
      `Send this email to ${p.name ? `${p.name} <${p.address}>` : p.address} from ${from}${cv ? `, with ${cv.name} attached` : ', with no attachment'}?`,
      ...doubts,
    ].join('\n\n');
    if (!confirm(ask)) return;
  }
  d.sending = how;
  d.sendError = '';
  d.sendDone = '';
  rerender(firm.id);
  try {
    const nylas = await store.getNylas();
    if (!nylas || !nylas.grantId) throw new Error('Connect your inbox first (Settings › Email codes).');
    const email = {
      to: [{ email: p.address, ...(p.name ? { name: p.name } : {}) }],
      subject: d.subject,
      text: d.body,
      attachments: cv ? [{ name: cv.name, dataUrl: cv.dataUrl }] : [],
    };
    const r =
      how === 'send'
        ? await N.send(nylas, email, { fetch: fetchFn })
        : await N.saveDraft(nylas, email, { fetch: fetchFn });
    d.sendDone =
      how === 'send'
        ? `Sent to ${p.address}${cv ? `, ${cv.name} attached` : ''}. It’s in your Sent folder.`
        : `Saved to your drafts${cv ? `, ${cv.name} attached` : ''}: open your email to send it.`;
    await setOutreach(firm, {
      status: how === 'send' ? 'sent' : 'drafted',
      to: p.address,
      subject: d.subject,
      contact: contactRef(p),
      way: wayText(firm),
      via: 'nylas',
      ...(how === 'send' ? { messageId: r.id, threadId: r.threadId } : { draftId: r.id }),
    });
  } catch (err) {
    d.sendError = errorText(err);
  } finally {
    d.sending = '';
    rerender(firm.id);
  }
}

/** The drawer's way out: Send and Save to drafts through Nylas, or how to get them; the CV to attach. */
function sendView(firm, d) {
  const n = state.nylas;
  if (!n || !n.grantId)
    return el(
      'p',
      { className: 'small muted' },
      'Attach your CV before sending. To send from here with your CV attached, or save it to your drafts, connect your inbox under ',
      el('button', {
        className: 'link',
        type: 'button',
        textContent: 'Settings › Email codes',
        onclick: () => api.tabs.create({ url: api.runtime.getURL('options/options.html#email') }),
      }),
      '.',
    );
  const can = d.abilities || { draft: true, send: true };
  if (!d.abilities)
    inboxAbilities().then((a) => {
      d.abilities = a;
      if (!a.draft || !a.send) rerender(firm.id);
    });
  const rec = state.outreach[firm.id];
  const sent = rec && rec.status !== 'drafted' && rec.via === 'nylas' && rec.messageId;
  return el(
    'div',
    { className: 'send' },
    el(
      'label',
      { className: 'check small' },
      el('input', {
        type: 'checkbox',
        name: 'attach',
        checked: d.attach !== false,
        onchange: (e) => (d.attach = e.target.checked),
      }),
      state.cvName ? `Attach my CV (${state.cvName})` : 'Attach my CV (none uploaded yet: Settings › Resume & files)',
    ),
    el(
      'div',
      { className: 'row' },
      el('button', {
        className: 'small primary send-go',
        type: 'button',
        disabled: !!d.sending || !can.send || !!sent,
        textContent: d.sending === 'send' ? 'Sending…' : sent ? 'Sent' : 'Send',
        title: `Sends it from ${n.email || 'your inbox'} through Nylas`,
        onclick: () => sendEmail(firm, 'send'),
      }),
      el('button', {
        className: 'small save-draft',
        type: 'button',
        disabled: !!d.sending || !can.draft,
        textContent: d.sending === 'draft' ? 'Saving…' : 'Save to my drafts',
        title: `Puts it in ${n.email || 'your inbox'}’s Drafts folder, ready to send from there`,
        onclick: () => sendEmail(firm, 'draft'),
      }),
      el('span', { className: 'small muted', textContent: `From ${n.email || 'your inbox'}` }),
    ),
    !can.send || !can.draft
      ? el('p', {
          className: 'small warn-text',
          textContent:
            'Your inbox is connected to Nylas for reading codes only. To send or save drafts from here, connect it again with permission to send and draft mail (Settings › Email codes).',
        })
      : null,
    d.sendDone ? el('p', { className: 'small ok-text', attrs: { role: 'status' }, textContent: d.sendDone }) : null,
    d.sendError ? el('p', { className: 'small error', attrs: { role: 'alert' }, textContent: d.sendError }) : null,
  );
}

/** Replies to emails sent from here: a sent record whose thread has a message from someone else becomes Replied. */
async function checkReplies() {
  const nylas = state.nylas;
  if (!nylas || !nylas.grantId) return;
  const waiting = Object.entries(state.outreach).filter(([, r]) => r.status === 'sent' && r.threadId);
  for (const [id, rec] of waiting) {
    const list = await N.replies(nylas, {
      threadId: rec.threadId,
      after: rec.sentAt,
      me: nylas.email,
      fetch: fetchFn,
    }).catch(() => []);
    if (!list.length) continue;
    const from = (list[0].from || [])[0] || {};
    const note = `Reply from ${from.name || from.email || 'them'} on ${day((list[0].date || 0) * 1000)}: “${String(list[0].snippet || '').slice(0, 140)}”`;
    const next = await store.setOutreach(id, { status: 'replied', notes: rec.notes ? `${rec.notes}\n${note}` : note });
    if (next) state.outreach[id] = next;
  }
  if (waiting.length) renderOutreach();
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

/** A firm card's one big button: put it in the review queue, or say where it is. */
function writeButton(firm) {
  const item = review.items.find((i) => i.id === firm.id);
  const rec = state.outreach[firm.id];
  const written = rec && rec.status !== 'drafted';
  return el('button', {
    className: 'write-go' + (item || written ? '' : ' primary'),
    type: 'button',
    disabled: !!written || !aiReady(),
    title: aiReady() ? 'Check it, find who to write to and a reason to, and draft the email to read in Review' : NO_AI,
    textContent: written ? 'Written to' : item ? 'In Review' : 'Write to them',
    onclick: () => writeTo([firm]),
  });
}

function firmCard(r) {
  const { firm } = r;
  const check = state.checks[firm.id];
  const running = state.running.has(firm.id);
  const researching = state.researching.has(firm.id);
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
      writeButton(firm),
      el('button', {
        className: 'small check',
        type: 'button',
        disabled: running,
        textContent: running ? 'Checking…' : check ? 'Check again' : 'Check careers & contacts',
        title: thorough() ? THOROUGH_READ : '',
        onclick: () => checkAndRead(firm, { force: !!check }, thorough() ? requestAiConsent() : null),
      }),
      canResearch()
        ? el('button', {
            className: 'small research-go',
            type: 'button',
            disabled: researching,
            title: RESEARCH_NOTE,
            textContent: researching
              ? 'Searching the web…'
              : state.research[firm.id]
                ? 'Search the web again'
                : 'Find people',
            onclick: () => researchFirm(firm, canSearch() ? requestAiConsent() : null),
          })
        : null,
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
    researchView(firm),
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
  const next = nextToWrite();
  const started = review.items.some((i) => i.type === 'first');
  $('#write-top').textContent = next.length
    ? `Write to the ${started ? 'next' : 'top'} ${next.length === TOP ? TOP : plural(next.length, 'firm')}`
    : 'Written to all of these';
  $('#write-top').disabled = !next.length;
  $('#write-top').title = aiReady() ? '' : NO_AI;
}

function rerender(id) {
  const old = document.querySelector(`#results .firm[data-id="${CSS.escape(id)}"]`);
  const r = state.results.find((x) => x.firm.id === id);
  if (old && r) old.replaceWith(firmCard(r));
  renderReview();
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

/* ---------------------------------------------------------------- review */

// The review queue: firms an email is prepared for in the background (the careers check, the people, a reason to write
// and the draft, two firms at a time), then shown one at a time with big buttons, so writing to ten firms is reading ten
// emails and pressing Send ten times. Nothing is sent unless Send is pressed for that email, and a sent one can be taken
// back for five seconds.
const review = {
  items: [], // [{ id, firm, type: 'first' | 'follow', status, step, error, hooks, hook, to, subject, body, result, … }]
  at: 0, // the item shown
  busy: 0, // items being prepared
  consent: null, // the AI consent asked for on the click that filled the queue (Firefox)
  pending: null, // { item, timer, run }: a send waiting out its five seconds
  toast: null, // { text, undo?, show? }
  drawn: '', // what the card was last drawn from, so typing in it isn't undone by a redraw
};
const PREPARE_AT_ONCE = 2;
const UNDO_MS = 5000;
const HOOK_AGE = 7 * 24 * 3600e3; // reasons to write are looked for again after a week
const TOP = 10;
const FINISHED = new Set(['sent', 'scheduled', 'saved', 'skipped']);
const STEPS = [
  ['check', 'Reading its careers pages and team pages'],
  ['people', 'Searching the web for the people to write to'],
  ['hooks', 'Looking for a reason to write that a template wouldn’t have'],
  ['draft', 'Writing the email'],
];
const H = () => globalThis.JTF.discoverHooks;
const settingOf = (key, fallback) => {
  const d = (state.settings && state.settings.discoverAi) || {};
  return key in d ? d[key] : fallback;
};
const askChoice = () => settingOf('ask', 'internship');

/** The queue as kept between visits: what each item was doing is forgotten, its draft and outcome kept. */
function saveQueue() {
  clearTimeout(saveQueue.timer);
  saveQueue.timer = setTimeout(() => {
    const items = review.items.map((i) => ({
      ...i,
      status: ['preparing', 'sending'].includes(i.status) ? (i.body ? 'ready' : 'waiting') : i.status,
      step: '',
      armed: false,
    }));
    store.setDiscoverCache({ queue: { items, at: review.at } }).catch(() => null);
  }, 300);
}

/** The queue's count on its tab: emails ready to read. */
function reviewCount() {
  const ready = review.items.filter((i) => i.status === 'ready').length;
  $('#review-count').textContent = ready ? String(ready) : '';
}

/**
 * Put firms in the queue (one already in it is shown instead; one already written to is left out, and said so) and
 * start preparing them. Called from a click, so Firefox's AI consent can be asked for here.
 */
function writeTo(firms) {
  if (!aiReady()) {
    status(NO_AI, true);
    return;
  }
  review.consent = requestAiConsent();
  const added = [];
  const written = [];
  for (const firm of firms) {
    const rec = state.outreach[firm.id];
    if (review.items.some((i) => i.id === firm.id)) continue;
    if (rec && rec.status !== 'drafted') {
      written.push(firm.name);
      continue;
    }
    added.push({ id: firm.id, firm, type: 'first', status: 'waiting', step: '', hooks: [], hook: 0 });
  }
  review.items.push(...added);
  const first = added[0] ? added[0].id : firms.length === 1 ? firms[0].id : '';
  const index = review.items.findIndex((i) => i.id === first);
  if (index >= 0) review.at = index;
  review.toast = written.length
    ? {
        text: `Already written to ${written.slice(0, 3).join(', ')}${written.length > 3 ? '…' : ''}: see the Outreach tab.`,
      }
    : null;
  pump();
  saveQueue();
  showTab('review');
  renderReview();
  if (state.results.length) renderResults();
}

/** The next firms of the results to write to: not in the queue, not written to. */
function nextToWrite(n = TOP) {
  return visible()
    .map((r) => r.firm)
    .filter(
      (f) =>
        !review.items.some((i) => i.id === f.id) &&
        !(state.outreach[f.id] && state.outreach[f.id].status !== 'drafted'),
    )
    .slice(0, n);
}

/** Carry on preparing what the page left waiting when it was closed (asked for: each one is an AI call or few). */
function resumeQueue() {
  if (!aiReady()) return status(NO_AI, true);
  review.consent = requestAiConsent();
  pump();
  renderReview(true);
}

/** Start preparing waiting items, two at a time, in queue order. */
function pump() {
  while (review.busy < PREPARE_AT_ONCE) {
    const item = review.items.find((i) => i.status === 'waiting');
    if (!item) break;
    review.busy++;
    prepare(item).finally(() => {
      review.busy--;
      pump();
    });
  }
  reviewCount();
}

/** Wait until `id` is no longer in `set` (a firm's check or search that something else started). */
async function settled(set, id) {
  while (set.has(id)) await new Promise((resolve) => setTimeout(resolve, 400));
}

/** One item made ready: the firm checked, its people found, a reason to write looked for, the email drafted. */
async function prepare(item) {
  item.status = 'preparing';
  item.error = '';
  const step = (s) => {
    item.step = s;
    renderReview();
  };
  try {
    if (review.consent && !(await review.consent))
      throw new Error('Firefox didn’t allow sending the firm’s name and your material to your AI provider.');
    state.config = await store.discoverAiConfig();
    if (ai.problem(state.config)) throw new Error(`${ai.problem(state.config)} (Settings › Cover letters & AI)`);
    if (item.type === 'follow') {
      step('draft');
      await writeFollowUp(item);
      return;
    }
    const firm = item.firm;
    step('check');
    await checkFirm(firm);
    // A check or search the firm's card started is waited for, not started again.
    await settled(state.running, firm.id);
    if (canResearch() && !(state.research[firm.id] && state.research[firm.id].result)) {
      step('people');
      await researchFirm(firm, null);
    }
    await settled(state.researching, firm.id);
    const people = contactsOf(firm);
    if (!people.length) {
      item.status = 'none';
      return;
    }
    const sure = people.find((p) => !p.guessed && !['guessed', 'unconfirmed'].includes(p.level));
    const chosen = people.find((p) => sameAddress(p.address, item.to)) || sure || people[0];
    item.to = chosen.address;
    if (canSearch() && H()) {
      step('hooks');
      item.hooks = await reasonsFor(firm, chosen, people).catch((err) => {
        item.hookError = errorText(err);
        return [];
      });
      item.hook = item.hooks.length ? 0 : -1;
    } else item.hook = -1;
    step('draft');
    await writeDraft(item);
  } catch (err) {
    item.status = 'failed';
    item.error = errorText(err);
  } finally {
    if (item.status === 'preparing') item.status = item.body ? 'ready' : 'failed';
    item.step = '';
    renderReview();
    saveQueue();
  }
}

/**
 * Reasons to write to this firm (discoverHooks.find: common ground, their recent work, a way to show it, each borne
 * out by a source), best first for `contact`; kept for a week per firm, and looked for again when common ground is
 * switched on or off.
 */
async function reasonsFor(firm, contact, people) {
  const common = settingOf('commonGround', false) === true;
  const named = people.filter((p) => p.name);
  const ref = (p) => ({ name: p.name, title: p.title || '', address: p.address });
  let cached = state.hooks[firm.id];
  if (!cached || Date.now() - cached.at > HOOK_AGE || cached.common !== common) {
    const { profile } = await store.getActive();
    const result = await H().find((messages, options) => ai.search(state.config, { messages, ...options }), {
      firm: nowAt(firm),
      contact: contact.name ? ref(contact) : null,
      people: named
        .filter((p) => p !== contact)
        .slice(0, 4)
        .map(ref),
      institutions: common ? H().institutions(profile) : [],
      fetch: fetchFn,
    });
    cached = state.hooks[firm.id] = { at: Date.now(), common, result };
    await store.setDiscoverCache({ hooks: { [firm.id]: cached } });
  }
  return H().rank((cached.result && cached.result.hooks) || [], { contact: contact.name ? ref(contact) : null });
}

/** The item's email written (again) for whoever it goes to, with the reason chosen and the ask chosen. */
async function writeDraft(item) {
  const firm = item.firm;
  const people = contactsOf(firm);
  const contact = people.find((p) => sameAddress(p.address, item.to)) || people[0];
  if (!contact) throw new Error('No one to write to yet.');
  const { profile } = await store.getActive();
  const kit = await store.getKit(profile.id);
  const cvText = await readCv(profile, kit);
  const ask = askChoice();
  const role = ask === 'internship' ? roleOf(firm) : '';
  const hook = item.hook >= 0 ? item.hooks[item.hook] || null : null;
  const r = await O.draft(aiChat(), {
    firm: nowAt(firm),
    found: foundFor(firm),
    contact: { ...contact, email: contact.address },
    profile,
    kit,
    cvText,
    instruction: '',
    kind: role ? 'role' : 'speculative',
    role,
    today: Date.now(),
    ...(hook ? { hook } : {}),
    ...(ask !== 'internship' ? { ask } : {}),
  });
  Object.assign(item, {
    status: 'ready',
    to: contact.address,
    draftedFor: { address: contact.address, hook: item.hook, ask },
    subject: r.subject || '',
    body: r.body || '',
    result: { ok: r.ok, checks: r.checks },
    usage: usageLine(state.config, r.usage),
    thin: !O.material({ profile, kit, cvText }).ok,
    error: '',
  });
  const old = state.outreach[firm.id];
  if (!old || old.status === 'drafted')
    await setOutreach(firm, {
      status: 'drafted',
      to: contact.address,
      subject: item.subject,
      contact: contactRef(contact),
      way: wayText(firm),
    });
}

/** A follow-up, in the same thread, to an email sent from here that has had no reply. */
async function writeFollowUp(item) {
  const rec = state.outreach[item.firm.id];
  if (!rec) throw new Error('The email it follows up is no longer in your outreach list.');
  const { profile } = await store.getActive();
  const kit = await store.getKit(profile.id);
  const cvText = await readCv(profile, kit);
  const c = rec.contact || {};
  const r = await O.followUp(aiChat(), {
    firm: item.firm,
    rec,
    contact: { name: c.name || '', title: c.title || '', email: rec.to, address: rec.to, kind: c.name ? 'person' : '' },
    profile,
    kit,
    cvText,
    today: Date.now(),
  });
  Object.assign(item, {
    status: 'ready',
    to: rec.to,
    subject: r.subject || '',
    body: r.body || '',
    result: { ok: r.ok, checks: r.checks },
    usage: usageLine(state.config, r.usage),
    error: '',
  });
}

/** Emails sent from here five working days ago without a reply or a follow-up: put in the queue on request. */
function followUpsDue() {
  if (!O.dueFollowUps) return [];
  return O.dueFollowUps(state.outreach, Date.now()).filter((d) => !review.items.some((i) => i.id === `${d.id}:follow`));
}

function queueFollowUps() {
  if (!aiReady()) return status(NO_AI, true);
  review.consent = requestAiConsent();
  const due = followUpsDue();
  const items = due.map(({ id, rec }) => ({
    id: `${id}:follow`,
    firm: state.firms.find((f) => f.id === id) || { ...rec.firm, id },
    type: 'follow',
    status: 'waiting',
    step: '',
    hooks: [],
    hook: -1,
    to: rec.to,
  }));
  // Follow-ups first: they're the ones waiting longest.
  review.items.splice(0, 0, ...items);
  review.at = 0;
  pump();
  saveQueue();
  renderReview();
}

/* review: actions */

const shown = () => review.items[review.at] || null;

/** Show the next item that needs reading (after this one, then from the top), or the summary when none does. */
function advance() {
  const n = review.items.length;
  for (let k = 1; k <= n; k++) {
    const i = (review.at + k) % n;
    if (!FINISHED.has(review.items[i].status) && review.items[i].status !== 'sending') {
      review.at = i;
      return renderReview(true);
    }
  }
  review.at = n; // past the end: the summary
  renderReview(true);
}

function move(by) {
  review.at = Math.max(0, Math.min(review.items.length, review.at + by));
  renderReview(true);
}

/** What makes a send worth a second press: an address made from a format, or a draft that failed a check. */
function doubtsOf(item) {
  const p = contactsOf(item.firm).find((x) => sameAddress(x.address, item.to));
  return [
    p && (p.guessed || ['likely', 'guessed', 'unconfirmed'].includes(p.level))
      ? `${item.to} is made from the firm’s address format, not seen written anywhere: it may bounce.`
      : '',
    item.result && item.result.ok === false
      ? 'Some of the draft’s checks failed (listed above): read it through first.'
      : '',
    item.draftedFor &&
    (!sameAddress(item.draftedFor.address, item.to) ||
      item.draftedFor.hook !== item.hook ||
      item.draftedFor.ask !== askChoice())
      ? 'You changed who it goes to, the reason or the ask since it was written: press Write it again first, or send it as it is.'
      : '',
  ].filter(Boolean);
}

/** When the email would arrive: { at (ms, or null for now), local ("Mon 08:10 in London") }. */
function arrival(item) {
  if (!settingOf('theirMorning', true) || !O.sendTime) return { at: null, local: '' };
  return O.sendTime(item.firm, Date.now()) || { at: null, local: '' };
}

/** Send: a doubtful email takes a second press; then it goes in five seconds unless Undo is pressed. */
function sendItem(item) {
  if (!item || item.status !== 'ready') return;
  if (doubtsOf(item).length && !item.armed) {
    item.armed = true;
    return renderReview(true);
  }
  if (review.pending) flushPending();
  item.armed = false;
  item.status = 'sending';
  const run = () => deliver(item);
  review.pending = {
    item,
    run,
    timer: setTimeout(() => {
      review.pending = null;
      run();
    }, UNDO_MS),
  };
  review.toast = { text: `Sending to ${item.to}…`, undo: true };
  advance();
}

/** Send a waiting email now (another Send was pressed, or the page is being left). */
function flushPending() {
  const p = review.pending;
  if (!p) return;
  clearTimeout(p.timer);
  review.pending = null;
  p.run();
}

/** Undo: the email waiting out its five seconds goes back to being read. */
function undoSend() {
  const p = review.pending;
  if (!p) return;
  clearTimeout(p.timer);
  review.pending = null;
  p.item.status = 'ready';
  review.at = review.items.indexOf(p.item);
  review.toast = { text: 'Not sent.' };
  renderReview(true);
}

/** The email sent from the connected inbox (CV attached to a first email; a follow-up goes in the same thread). */
async function deliver(item) {
  const firm = item.firm;
  const rec = state.outreach[firm.id];
  const follow = item.type === 'follow';
  try {
    const nylas = await store.getNylas();
    if (!nylas || !nylas.grantId) throw new Error('Connect your inbox first (Settings › Email codes).');
    const cv = follow ? null : await cvFile();
    const when = arrival(item);
    const p = contactsOf(firm).find((x) => sameAddress(x.address, item.to)) || (rec && rec.contact) || {};
    const email = {
      to: [{ email: item.to, ...(p.name ? { name: p.name } : {}) }],
      subject: item.subject,
      text: item.body,
      attachments: cv ? [{ name: cv.name, dataUrl: cv.dataUrl }] : [],
      ...(follow && rec && rec.messageId ? { replyTo: rec.messageId } : {}),
      ...(when.at ? { sendAt: when.at } : {}),
    };
    const r = await N.send(nylas, email, { fetch: fetchFn });
    item.status = when.at ? 'scheduled' : 'sent';
    item.outcome = when.at
      ? `Arrives ${when.local}${cv ? `, ${cv.name} attached` : ''}.`
      : `Sent${cv ? `, ${cv.name} attached` : ''}. It’s in your Sent folder.`;
    const hook = item.hook >= 0 ? item.hooks[item.hook] : null;
    if (follow) await setOutreach(firm, { followedUpAt: Date.now(), followUps: ((rec && rec.followUps) || 0) + 1 });
    else
      await setOutreach(firm, {
        status: 'sent',
        to: item.to,
        subject: item.subject,
        body: item.body,
        contact: contactRef(p.address ? p : { address: item.to }),
        way: wayText(firm),
        via: 'nylas',
        reason: hook ? hook.label : '',
        reasonKind: hook ? hook.kind : 'none',
        ask: (item.draftedFor && item.draftedFor.ask) || askChoice(),
        messageId: r.id,
        threadId: r.threadId,
        ...(when.at ? { sentAt: when.at, sendAt: when.at, scheduleId: r.scheduleId || '' } : {}),
      });
    review.toast = { text: `${follow ? 'Follow-up' : 'Email'} to ${firm.name}: ${item.outcome}` };
  } catch (err) {
    item.status = 'ready';
    item.error = `Not sent: ${errorText(err)}`;
    review.toast = { text: `Couldn’t send to ${firm.name}: ${errorText(err)}`, show: item.id, error: true };
  }
  renderReview(true);
  saveQueue();
}

/** Save to the connected inbox's drafts, to send from there. */
async function saveItem(item) {
  if (!item || item.status !== 'ready') return;
  item.status = 'sending';
  renderReview(true);
  try {
    const nylas = await store.getNylas();
    if (!nylas || !nylas.grantId) throw new Error('Connect your inbox first (Settings › Email codes).');
    const cv = item.type === 'follow' ? null : await cvFile();
    const r = await N.saveDraft(
      nylas,
      {
        to: [{ email: item.to }],
        subject: item.subject,
        text: item.body,
        attachments: cv ? [{ name: cv.name, dataUrl: cv.dataUrl }] : [],
      },
      { fetch: fetchFn },
    );
    item.status = 'saved';
    item.outcome = `Saved to your drafts${cv ? `, ${cv.name} attached` : ''}.`;
    if (item.type !== 'follow')
      await setOutreach(item.firm, {
        status: 'drafted',
        to: item.to,
        subject: item.subject,
        draftId: r.id,
        via: 'nylas',
      });
    advance();
  } catch (err) {
    item.status = 'ready';
    item.error = `Not saved: ${errorText(err)}`;
    renderReview(true);
  }
  saveQueue();
}

/** Without an inbox connected: the person sent it from their own email program and says so. */
async function markSent(item) {
  item.status = 'sent';
  item.outcome = 'Marked as sent.';
  if (item.type === 'follow') await setOutreach(item.firm, { followedUpAt: Date.now() });
  else
    await setOutreach(item.firm, {
      status: 'sent',
      to: item.to,
      subject: item.subject,
      body: item.body,
      via: 'mailto',
    });
  advance();
  saveQueue();
}

function skipItem(item) {
  if (!item || ['sending'].includes(item.status)) return;
  item.status = 'skipped';
  advance();
  saveQueue();
}

/** Back from skipped: read it after all (or prepare it, if it never was). */
function unskip(item) {
  item.status = item.body ? 'ready' : 'waiting';
  pump();
  renderReview(true);
  saveQueue();
}

/** Write it again for whoever it now goes to, with the reason and ask now chosen. */
async function redraft(item) {
  if (!item || !['ready', 'failed'].includes(item.status)) return;
  item.status = 'preparing';
  item.step = 'draft';
  item.armed = false;
  renderReview(true);
  try {
    state.config = await store.discoverAiConfig();
    if (item.type === 'follow') await writeFollowUp(item);
    else await writeDraft(item);
  } catch (err) {
    item.status = item.body ? 'ready' : 'failed';
    item.error = errorText(err);
  }
  item.step = '';
  renderReview(true);
  saveQueue();
}

/** Someone else at the firm: the next contact, greeted by name (Write it again for a draft made for them). */
function otherContact(item) {
  if (!item || item.status !== 'ready' || item.type === 'follow') return;
  const people = contactsOf(item.firm);
  if (people.length < 2) return;
  const i = people.findIndex((p) => sameAddress(p.address, item.to));
  const p = people[(i + 1) % people.length];
  item.to = p.address;
  item.body = withGreeting(item.body, greetingFor(p, item.firm));
  item.armed = false;
  renderReview(true);
  saveQueue();
}

/** Another reason to write, or none ("the email opens with what the firm does"), in turn. */
function otherHook(item) {
  if (!item || item.status !== 'ready' || !(item.hooks || []).length) return;
  item.hook = item.hook + 1 >= item.hooks.length ? -1 : item.hook + 1;
  item.armed = false;
  renderReview(true);
  saveQueue();
}

/** What Ctrl+Enter does: send, or save to drafts when the inbox can't send, or open the email program. */
async function primaryAction(item) {
  if (!item) return;
  if (item.status !== 'ready') return;
  const n = state.nylas;
  if (!n || !n.grantId) {
    const a = document.querySelector('#review-card .open-mail');
    if (a) a.click();
    return;
  }
  const can = await inboxAbilities();
  if (can.send) sendItem(item);
  else if (can.draft) saveItem(item);
}

function reviewKeys(e) {
  if ($('#review-view').hidden) return;
  const item = shown();
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    primaryAction(item);
    return;
  }
  const typing = e.target.closest && e.target.closest('input, textarea, select, [contenteditable="true"]');
  if (typing) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const act = {
    s: () => skipItem(item),
    arrowright: () => move(1),
    j: () => move(1),
    arrowleft: () => move(-1),
    k: () => move(-1),
    c: () => otherContact(item),
    h: () => otherHook(item),
    r: () => redraft(item),
    u: () => undoSend(),
    e: () => {
      const box = $('#review-card textarea');
      if (box) box.focus();
    },
  }[e.key.toLowerCase()];
  if (!act) return;
  e.preventDefault();
  act();
}

/* review: drawing */

/** The card's reason to write: the source's own words, where they're from and when, and the others in turn. */
function reasonView(item) {
  const hooks = item.hooks || [];
  const hook = item.hook >= 0 ? hooks[item.hook] : null;
  const another =
    hooks.length > 0
      ? el('button', {
          className: 'ghost',
          type: 'button',
          textContent: hook
            ? `Another reason (${item.hook + 1} of ${hooks.length})`
            : `Use a reason (${hooks.length} found)`,
          title: 'H',
          onclick: () => otherHook(item),
        })
      : null;
  if (!hook) {
    const why = !canSearch()
      ? 'Reasons to write are looked for with your AI’s web search (Claude, or OpenRouter): with another provider the email opens with what the firm does.'
      : item.hookError
        ? `Couldn’t look for a reason to write: ${item.hookError}`
        : hooks.length
          ? 'No reason used: the email opens with what the firm does.'
          : 'No reason to write was borne out by a source, so the email opens with what the firm does.';
    return el('div', { className: 'reason none' }, el('p', { className: 'muted small', textContent: why }), another);
  }
  return el(
    'div',
    { className: 'reason' },
    el(
      'div',
      { className: 'reason-head' },
      el('span', { className: `pill reason-${hook.kind}`, textContent: hook.label || 'A reason to write' }),
      link(hook.url, hook.source || sourceName(hook.url), { className: 'small' }),
      another,
    ),
    el('blockquote', { textContent: `“${hook.quote}”` }),
  );
}

/** Who it goes to, how sure the address is, and the next person at the firm. */
function toView(item) {
  const people = item.type === 'follow' ? [] : contactsOf(item.firm);
  const p = people.find((x) => sameAddress(x.address, item.to));
  const rec = state.outreach[item.firm.id];
  const name = p ? whoLabel(p) : (rec && rec.contact && rec.contact.name) || '';
  return el(
    'div',
    { className: 'to-line' },
    el('span', { className: 'muted', textContent: 'To' }),
    el('strong', { textContent: name || item.to }),
    name ? el('span', { className: 'address', textContent: item.to }) : null,
    p ? levelPill(p) : null,
    p && p.url ? link(p.url, sourceName(p.url), { className: 'small' }) : null,
    people.length > 1
      ? el('button', {
          className: 'ghost',
          type: 'button',
          title: 'C',
          textContent: `Someone else (${people.length - 1} more)`,
          onclick: () => otherContact(item),
        })
      : null,
  );
}

/** The firm's name and what it is, the way in, and its website. */
function reviewHead(item) {
  const firm = item.firm;
  const way = wayText(firm);
  return el(
    'div',
    { className: 'review-head' },
    el(
      'div',
      {},
      el('h2', { textContent: firm.name }),
      el('p', {
        className: 'muted small',
        textContent: [meta(firm), firm.about ? clip(firm.about, 140) : ''].filter(Boolean).join(' · '),
      }),
    ),
    el(
      'div',
      { className: 'row' },
      item.type === 'follow' ? el('span', { className: 'pill', textContent: 'Follow-up' }) : null,
      way ? el('span', { className: `pill ${WAYS.find((w) => w[1] === way)[0]}`.trim(), textContent: way }) : null,
      firm.site ? link(firm.site, firm.domain || 'Website', { className: 'small' }) : null,
    ),
  );
}

/** The big buttons: Send (or Save to drafts, or Open in your email app) and the rest. */
function reviewActions(item) {
  const n = state.nylas;
  const skip = el('button', {
    className: 'big',
    type: 'button',
    textContent: 'Skip',
    title: 'S',
    onclick: () => skipItem(item),
  });
  const again = el('button', {
    className: 'big ghost',
    type: 'button',
    textContent: 'Write it again',
    title: 'R',
    onclick: () => redraft(item),
  });
  if (!n || !n.grantId) {
    const m = O.mailto({ to: item.to, subject: item.subject, body: item.body });
    const open = el('a', {
      className: 'button primary big open-mail',
      href: m.href,
      textContent: 'Open in your email app',
    });
    return el(
      'div',
      { className: 'review-actions' },
      open,
      el('button', { className: 'big', type: 'button', textContent: 'Mark as sent', onclick: () => markSent(item) }),
      skip,
      again,
    );
  }
  const can = review.abilities || { send: true, draft: true };
  const when = arrival(item);
  const send = el('button', {
    className: 'primary big send-go' + (item.armed ? ' armed' : ''),
    type: 'button',
    disabled: !can.send,
    textContent: item.armed ? 'Send anyway' : when.at ? 'Send · arrives in their morning' : 'Send',
    title: 'Ctrl+Enter',
    onclick: () => sendItem(item),
  });
  const save = el('button', {
    className: 'big save-draft' + (can.send ? ' ghost' : ' primary'),
    type: 'button',
    disabled: !can.draft,
    textContent: 'Save to my drafts',
    onclick: () => saveItem(item),
  });
  return el('div', { className: 'review-actions' }, send, save, skip, again);
}

/** One line under the buttons: from where, when it arrives, what's attached. */
function sendNote(item) {
  const n = state.nylas;
  if (!n || !n.grantId)
    return el(
      'p',
      { className: 'small muted' },
      'To send from here with your CV attached, connect your inbox under ',
      el('button', {
        className: 'link',
        type: 'button',
        textContent: 'Settings › Email codes',
        onclick: () => api.tabs.create({ url: api.runtime.getURL('options/options.html#email') }),
      }),
      '. Without it, your email program opens with the email written; attach your CV there.',
    );
  const when = arrival(item);
  const cv =
    item.type === 'follow'
      ? 'no attachment (a reply in the same thread)'
      : state.cvName
        ? `${state.cvName} attached`
        : 'no CV uploaded yet (Settings › Resume & files)';
  return el('p', {
    className: 'small muted',
    textContent: `From ${n.email || 'your inbox'} · ${when.at ? `arrives ${when.local}, as it’s outside their working day now` : 'sends now'} · ${cv}`,
  });
}

/** The card for an item, by how far it has got. */
function itemView(item) {
  const head = reviewHead(item);
  if (item.status === 'waiting' || item.status === 'preparing') {
    const order = item.type === 'follow' ? [['draft', 'Writing the follow-up']] : STEPS;
    const at = order.findIndex(([k]) => k === item.step);
    return el(
      'div',
      { className: 'review-body' },
      head,
      el(
        'ol',
        { className: 'steps' },
        order.map(([k, text], i) =>
          el('li', {
            className: item.status === 'waiting' ? '' : i < at ? 'done' : i === at ? 'now' : '',
            textContent: text,
          }),
        ),
      ),
      item.status === 'waiting' && !review.busy
        ? el(
            'div',
            { className: 'review-actions' },
            el('button', {
              className: 'primary big',
              type: 'button',
              textContent: 'Prepare it',
              onclick: resumeQueue,
            }),
            el('button', { className: 'big', type: 'button', textContent: 'Skip', onclick: () => skipItem(item) }),
          )
        : null,
      el('p', {
        className: 'muted small',
        textContent:
          item.status === 'waiting'
            ? review.busy
              ? 'Waiting its turn: two firms are prepared at a time.'
              : 'Not prepared yet: the page was closed before its turn.'
            : 'This takes about a minute. The next firm is being prepared meanwhile.',
      }),
    );
  }
  if (item.status === 'none' || item.status === 'failed') {
    const watched = state.watch.some((w) => w.id === item.firm.id);
    return el(
      'div',
      { className: 'review-body' },
      head,
      el('p', {
        className: item.status === 'failed' ? 'error' : '',
        textContent:
          item.status === 'failed'
            ? item.error
            : 'No one to write to was found: no recruiting mailbox, no named person with an address, and no address format to make one from.',
      }),
      el(
        'div',
        { className: 'review-actions' },
        item.status === 'failed'
          ? el('button', {
              className: 'primary big',
              type: 'button',
              textContent: 'Try again',
              onclick: () => ((item.status = 'waiting'), pump(), renderReview(true)),
            })
          : el('button', {
              className: 'primary big',
              type: 'button',
              disabled: watched,
              textContent: watched ? 'Watching' : 'Watch it for new roles',
              onclick: () => watchFirm(item.firm).then(() => advance()),
            }),
        el('button', { className: 'big', type: 'button', textContent: 'Skip', onclick: () => skipItem(item) }),
      ),
    );
  }
  if (FINISHED.has(item.status) || item.status === 'sending') {
    const text = {
      sending: 'Sending…',
      sent: item.outcome || 'Sent.',
      scheduled: item.outcome || 'Scheduled.',
      saved: item.outcome || 'Saved to your drafts.',
      skipped: 'Skipped.',
    }[item.status];
    return el(
      'div',
      { className: 'review-body' },
      head,
      el('p', { className: item.status === 'skipped' ? 'muted' : 'ok-text', textContent: text }),
      el(
        'div',
        { className: 'review-actions' },
        item.status === 'sending' && review.pending && review.pending.item === item
          ? el('button', { className: 'big', type: 'button', textContent: 'Undo', onclick: undoSend })
          : null,
        item.status === 'skipped'
          ? el('button', {
              className: 'big',
              type: 'button',
              textContent: 'Write to them after all',
              onclick: () => unskip(item),
            })
          : null,
        el('button', { className: 'primary big', type: 'button', textContent: 'Next', onclick: () => advance() }),
      ),
    );
  }
  // Ready: the email to read.
  const checks = (item.result && item.result.checks) || [];
  const failed = checks.filter((c) => !c.ok);
  const doubts = item.armed ? doubtsOf(item) : [];
  return el(
    'div',
    { className: 'review-body' },
    head,
    item.type === 'follow' ? null : reasonView(item),
    toView(item),
    el('input', {
      className: 'subject',
      type: 'text',
      value: item.subject,
      attrs: { 'aria-label': 'Subject' },
      oninput: (e) => ((item.subject = e.target.value), saveQueue()),
    }),
    el('textarea', {
      className: 'body',
      value: item.body,
      rows: Math.min(22, Math.max(12, item.body.split('\n').length + 2)),
      attrs: { 'aria-label': 'Email' },
      oninput: (e) => ((item.body = e.target.value), fitBox(e.target), saveQueue()),
    }),
    el(
      'p',
      { className: 'small ' + (failed.length ? 'warn-text' : 'muted') },
      failed.length
        ? `Check before sending: ${failed.map((c) => c.what).join(' · ')}`
        : `All ${checks.length} checks passed: every fact is from your CV or the firm’s own pages${item.hook >= 0 ? ' and the source quoted above' : ''}.`,
      item.usage ? ` · ${item.usage}` : '',
    ),
    item.thin
      ? el('p', {
          className: 'small warn-text',
          textContent:
            'Your CV and profile are thin, so the email is too: upload your CV under Settings › Resume & files.',
        })
      : null,
    item.error ? el('p', { className: 'small error', attrs: { role: 'alert' }, textContent: item.error }) : null,
    doubts.length
      ? el(
          'div',
          { className: 'doubts', attrs: { role: 'alert' } },
          doubts.map((d) => el('p', { textContent: d })),
        )
      : null,
    reviewActions(item),
    sendNote(item),
  );
}

const REASON_KINDS = { common: 'common ground', work: 'their work', show: 'a way to show it', none: 'no reason' };
const ASK_KINDS = {
  internship: 'asking for an internship',
  call: 'asking for a call',
  project: 'offering a trial task',
};

/**
 * Replies so far to emails sent from Review, overall and by the reason and the ask they used ("common ground 2 of 4"):
 * what works, from the person's own emails. Nothing until five have gone.
 */
function replyStats() {
  const sent = Object.values(state.outreach).filter(
    (r) => r.reasonKind && ['sent', 'replied', 'closed'].includes(r.status),
  );
  if (sent.length < 5) return '';
  const rate = (list) => `${list.filter((r) => r.status === 'replied').length} of ${list.length}`;
  const by = (key, names) =>
    Object.entries(names)
      .map(([k, label]) => [label, sent.filter((r) => r[key] === k)])
      .filter(([, list]) => list.length)
      .map(([label, list]) => `${label} ${rate(list)}`);
  return [`Replies so far: ${rate(sent)}`, ...by('reasonKind', REASON_KINDS), ...by('ask', ASK_KINDS)].join(' · ');
}

/** Nothing left to read: what happened, and the next ten. */
function summaryView() {
  const count = (s) => review.items.filter((i) => i.status === s).length;
  const working = review.items.filter((i) => ['waiting', 'preparing'].includes(i.status)).length;
  const next = nextToWrite();
  const parts = [
    count('sent') && `${count('sent')} sent`,
    count('scheduled') && `${count('scheduled')} arriving in their morning`,
    count('saved') && `${count('saved')} saved to drafts`,
    count('skipped') && `${count('skipped')} skipped`,
  ].filter(Boolean);
  return el(
    'div',
    { className: 'review-body summary' },
    el('h2', {
      textContent: !review.items.length
        ? 'Nothing to review yet'
        : working
          ? 'The rest are being prepared'
          : 'All read',
    }),
    el('p', {
      className: 'muted',
      textContent: !review.items.length
        ? 'Search for firms, then press Write to the top 10: JobToFill checks each firm, finds who to write to and a reason to, and drafts the email, and you read each one here.'
        : parts.join(' · ') || 'Nothing sent yet.',
    }),
    replyStats() ? el('p', { className: 'small stats', textContent: replyStats() }) : null,
    el(
      'div',
      { className: 'review-actions' },
      next.length
        ? el('button', {
            className: 'primary big',
            type: 'button',
            textContent: `Write to the next ${next.length}`,
            onclick: () => writeTo(next),
          })
        : el('button', {
            className: 'primary big',
            type: 'button',
            textContent: 'Find firms',
            onclick: () => showTab('find'),
          }),
      review.items.some((i) => FINISHED.has(i.status))
        ? el('button', {
            className: 'big ghost',
            type: 'button',
            textContent: 'Clear the finished ones',
            onclick: () => {
              review.items = review.items.filter((i) => !FINISHED.has(i.status));
              review.at = 0;
              saveQueue();
              renderReview(true);
            },
          })
        : null,
    ),
  );
}

/** Firm 3 of 10, with how many are ready, being prepared and done, as a bar. */
function progressView() {
  const n = review.items.length;
  if (!n) return [];
  const count = (f) => review.items.filter(f).length;
  const done = count((i) => FINISHED.has(i.status));
  const ready = count((i) => i.status === 'ready');
  const working = count((i) => ['waiting', 'preparing'].includes(i.status));
  const bar = el('div', { className: 'bar' }, el('span', { style: `width:${Math.round((done / n) * 100)}%` }));
  return [
    el(
      'div',
      { className: 'row' },
      el('strong', { textContent: review.at < n ? `${review.at + 1} of ${n}` : `${n} firms` }),
      el('span', {
        className: 'muted small',
        textContent: [ready && `${ready} ready to read`, working && `${working} being prepared`, done && `${done} done`]
          .filter(Boolean)
          .join(' · '),
      }),
      el('span', { className: 'grow' }),
      el('button', {
        className: 'ghost',
        type: 'button',
        textContent: '←',
        title: 'Back (←)',
        disabled: review.at <= 0,
        onclick: () => move(-1),
      }),
      el('button', {
        className: 'ghost',
        type: 'button',
        textContent: '→',
        title: 'Next (→)',
        disabled: review.at >= n,
        onclick: () => move(1),
      }),
    ),
    bar,
  ];
}

/** The toast: what just happened, with Undo while an email waits out its five seconds; it goes after eight. */
function toastView() {
  const t = review.toast;
  if (!t) return null;
  if (!t.timer && !(t.undo && review.pending))
    t.timer = setTimeout(() => {
      if (review.toast === t) review.toast = null;
      renderReview();
    }, 8000);
  return el(
    'div',
    { className: 'toast' + (t.error ? ' error' : ''), attrs: { role: 'status' } },
    el('span', { textContent: t.text }),
    t.undo && review.pending
      ? el('button', { className: 'link', type: 'button', textContent: 'Undo (U)', onclick: undoSend })
      : null,
    t.show
      ? el('button', {
          className: 'link',
          type: 'button',
          textContent: 'Show it',
          onclick: () => {
            review.at = review.items.findIndex((i) => i.id === t.show);
            review.toast = null;
            renderReview(true);
          },
        })
      : null,
  );
}

/**
 * Draw the queue: progress, the card shown, the follow-ups due and the toast. The card is drawn again only when what
 * it shows changed (force), so typing in it, or a check finishing for another firm, never loses the cursor.
 */
function renderReview(force) {
  reviewCount();
  if (!$('#review-view')) return;
  const item = shown();
  const key = item
    ? [item.id, item.status, item.step, item.hook, item.to, item.armed, item.error, (item.hooks || []).length].join('|')
    : `summary|${review.items.map((i) => i.status).join()}`;
  $('#review-progress').replaceChildren(...progressView());
  const due = followUpsDue();
  const box = $('#follow-due');
  box.hidden = !due.length;
  if (due.length)
    box.replaceChildren(
      el('span', {
        textContent: `${plural(due.length, 'email')} sent from here ${due.length === 1 ? 'has' : 'have'} had no reply for five working days.`,
      }),
      el('button', {
        className: 'primary',
        type: 'button',
        textContent: `Write ${due.length === 1 ? 'a follow-up' : 'the follow-ups'}`,
        onclick: queueFollowUps,
      }),
    );
  const old = document.querySelector('#review-view .toast');
  const toast = toastView();
  if (old) old.replaceWith(...(toast ? [toast] : []));
  else if (toast) $('#review-view').append(toast);
  $('#review-keys').hidden = !item || item.status !== 'ready';
  if (!force && key === review.drawn) return;
  review.drawn = key;
  $('#review-card').replaceChildren(item ? itemView(item) : summaryView());
  const body = $('#review-card textarea.body');
  if (body) fitBox(body);
  if (state.nylas && state.nylas.grantId && !review.abilities)
    inboxAbilities().then((a) => {
      review.abilities = a;
      if (!a.send || !a.draft) renderReview(true);
    });
}

/** The email box as tall as the email, so the whole of it reads without scrolling the box. */
function fitBox(box) {
  box.style.height = 'auto';
  box.style.height = `${box.scrollHeight + 4}px`;
}

/** The queue as it was left, and the choices above it. */
async function loadReview() {
  const cache = await store.getDiscoverCache();
  state.hooks = cache.hooks || {};
  if (cache.queue) {
    review.items = cache.queue.items.filter((i) => i && i.id && i.firm);
    review.at = Math.min(cache.queue.at || 0, review.items.length);
  }
  const d = (state.settings && state.settings.discoverAi) || {};
  for (const r of document.querySelectorAll('input[name="ask"]')) r.checked = r.value === (d.ask || 'internship');
  $('#their-morning').checked = d.theirMorning !== false;
  $('#common-ground').checked = d.commonGround === true;
  renderReview(true);
}

/** A choice above the queue saved; the drafts already written keep theirs until written again. */
async function saveReviewChoice(patch) {
  await saveAi(patch);
  state.settings = await store.getSettings();
  renderReview(true);
}

const TABS = ['find', 'review', 'watch', 'outreach'];

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
  $('#research-top').hidden = !canResearch();
  $('#research-top').title = RESEARCH_NOTE;
  if (state.results.length) renderResults();
}

/** The Hunter key box under “AI model for this page”: optional, kept like the AI keys. */
function buildFinderBox() {
  const input = $('#hunter-key');
  if (!input) return;
  input.value = state.finderKeys.hunter || '';
  const saved = $('#hunter-saved');
  input.addEventListener('change', async () => {
    state.finderKeys = await store.setFinderKey('hunter', input.value);
    saved.textContent = input.value.trim() ? 'Checking the key…' : 'Removed.';
    syncAi();
    if (!input.value.trim()) return;
    try {
      const a = await F.hunter.account(state.finderKeys.hunter, { fetch: fetchFn });
      const left = (x) => Math.max(0, (x.available || 0) - (x.used || 0));
      saved.textContent = `Saved. ${a.plan || 'Hunter'}: ${left(a.searches)} searches and ${left(a.verifications)} checks left this month.`;
    } catch (err) {
      saved.textContent = errorText(err);
    }
  });
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
  $('#write-top').addEventListener('click', () => writeTo(nextToWrite()));
  for (const r of document.querySelectorAll('input[name="ask"]'))
    r.addEventListener('change', () => r.checked && saveReviewChoice({ ask: r.value }));
  $('#their-morning').addEventListener('change', (e) => saveReviewChoice({ theirMorning: e.target.checked }));
  $('#common-ground').addEventListener('change', (e) => saveReviewChoice({ commonGround: e.target.checked }));
  document.addEventListener('keydown', reviewKeys);
  // Leaving the page with an email waiting out its five seconds: it goes, as Send was pressed for it.
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flushPending());
  addEventListener('beforeunload', (e) => {
    if (!review.pending) return;
    flushPending();
    e.preventDefault();
  });
  $('#research-top').addEventListener('click', researchTop);
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
    store
      .getDiscoverCache()
      .then(
        (c) => (
          (state.checks = c.careers || {}),
          (state.contacts = c.contacts || {}),
          (state.research = c.research || {})
        ),
      ),
    store.getNylas().then((n) => (state.nylas = n)),
    store.getFinderKeys().then((k) => (state.finderKeys = k)),
    cvFile()
      .then((doc) => (state.cvName = doc ? doc.name : ''))
      .catch(() => ''),
  ]);
  buildFinderBox();
  // What a Hunter key alone makes possible (Find people) shows once the keys are read.
  syncAi();
  checkReplies().catch(() => null);
  await loadReview();
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
