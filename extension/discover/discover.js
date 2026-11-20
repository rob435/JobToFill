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
  hasAiConsent,
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
  opened: new Set(), // cards whose folded detail (a firm checked only ahead of time) was opened
  drafts: {}, // firmId → the email drawer: { contact, kind, instruction, subject, body, result, running, error, … }
  watch: [],
  watchStates: {},
  outreach: {}, // firmId → store.getOutreach() record
  config: null, // store.discoverAiConfig(): what every AI call on this page uses
  keys: {},
  finderKeys: {}, // store.getFinderKeys(): { hunter }
  nylas: null, // store.getNylas(): the inbox drafts are saved to and sent from
  settings: null,
  pre: {}, // firmId → what data/checks.json found on its site ahead of time (scripts/firm-checks.mjs)
  preBuilt: '',
  picked: new Set(), // firms ticked in the results, for Write to them / Watch them
  hidden: 0, // results left out as written to already, at the last draw
  outreachFilter: 'all',
  checkingReplies: false,
};

const send = (message) => api.runtime.sendMessage(message);
const fetchFn = (url, init) => fetch(url, init);
const aiReady = () => !!state.config && !ai.problem(state.config);
/** The AI call every pipeline here gets, with the model chosen for this page. */
const aiChat = () => (messages, options) => ai.chat(state.config, { messages, ...options });
const errorText = (err) => String((err && err.message) || err);

/* --------------------------------------------------------------- loading */

async function loadRegistry() {
  const [json, pre] = await Promise.all([
    fetch(api.runtime.getURL('data/firms.json')).then((r) => r.json()),
    fetch(api.runtime.getURL('data/checks.json'))
      .then((r) => r.json())
      .catch(() => null),
  ]);
  const dead = new Set((pre && pre.dead) || []);
  state.pre = (pre && pre.firms) || {};
  state.preBuilt = (pre && pre.built) || '';
  // Firms whose site is gone, or that have no careers page and no address anywhere, were found so ahead of time.
  state.firms = D.loadFirms(json).filter((f) => !dead.has(f.id));
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

const LAST_SEARCH = 'jobtofill-discover-search';

/** The search form as it was last searched, kept in this browser so the page opens on the same firms. */
function rememberSearch() {
  const q = {
    niches: [...document.querySelectorAll('#niches input:checked')].map((i) => i.value),
    place: $('#place').value,
    size: $('#size').value,
    seeds: $('#seeds').value,
    text: $('#text').value,
    hideTrackr: $('#hide-trackr').checked,
    hn: $('#use-hn').checked,
  };
  try {
    localStorage.setItem(LAST_SEARCH, JSON.stringify(q));
  } catch (err) {
    // Storage off: the page just opens on the defaults next time.
  }
}

/** The last search put back in the form; true when there was one. */
function restoreSearch() {
  let q;
  try {
    q = JSON.parse(localStorage.getItem(LAST_SEARCH) || 'null');
  } catch (err) {
    return false;
  }
  if (!q || typeof q !== 'object') return false;
  if (Array.isArray(q.niches))
    for (const box of document.querySelectorAll('#niches input')) box.checked = q.niches.includes(box.value);
  const set = (sel, v) => {
    const box = $(sel);
    if (typeof v === 'string' && (box.tagName !== 'SELECT' || [...box.options].some((o) => o.value === v)))
      box.value = v;
  };
  set('#place', q.place);
  set('#size', q.size);
  set('#seeds', q.seeds);
  set('#text', q.text);
  if (typeof q.hideTrackr === 'boolean') $('#hide-trackr').checked = q.hideTrackr;
  if (typeof q.hn === 'boolean') $('#use-hn').checked = q.hn;
  return true;
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
  return ` ${who} ${state.sources.length > 1 ? 'list' : 'lists'} ${n} ${n === '1' ? 'name' : 'names'}; those are left out.`;
}

async function search(event, { quiet = false } = {}) {
  if (event) event.preventDefault();
  // The search the page opens on (the last one) never asks the AI: that takes a press.
  const useAi = !quiet && $('#use-ai').checked && !$('#use-ai').disabled;
  if (!quiet) rememberSearch();
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
    topUp();
    renderHome();
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
  if (!force && cached && !cached.bundled && Date.now() - cached.at < CHECK_AGE && state.contacts[firm.id])
    return cached.result;
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

/**
 * What the firm's site showed when the registry was checked ahead of time (data/checks.json), as a careers check and
 * a contacts check: its way in and its mailboxes show on its card at once, and Review prepares its email without
 * waiting for the crawl. Marked `bundled`, so Check again (and Check the top 10) reads the site afresh; a check made
 * here always wins.
 */
function adoptPre() {
  const at = Date.parse(state.preBuilt) || 0;
  for (const firm of state.firms) {
    const p = state.pre[firm.id];
    if (!p || state.checks[firm.id]) continue;
    const site = p.u || firm.site || '';
    const domain = D.domainOf(site) || firm.domain || '';
    const why = `On ${domain || 'its website'}${state.preBuilt ? ` (checked ${longDate(state.preBuilt)})` : ''}`;
    const best = (p.m || []).map((m) => ({
      address: m.a,
      kind: C.kindOf(m.a),
      name: '',
      title: '',
      why,
      guessed: false,
    }));
    state.checks[firm.id] = {
      at,
      bundled: true,
      result: {
        status: p.s || 'none',
        site,
        pages: p.p || [],
        boards: (p.b || []).map((b) => ({ ...b, found: 'site' })),
        roles: [],
        other: 0,
        programmes: [],
        mentions: [],
        emails: [],
        texts: [],
        log: [],
        pre: { roles: p.r || 0, programmes: p.g || 0 },
      },
    };
    state.contacts[firm.id] = {
      at,
      bundled: true,
      result: {
        best,
        people: [],
        emails: best.map((b) => ({ address: b.address, kind: b.kind, name: '', source: 'site' })),
        pattern: p.f
          ? { pattern: p.f.p, domain: p.f.d, examples: p.f.n || 0, sample: `${p.f.p}@${p.f.d}` }
          : { pattern: null, examples: 0, sample: '', domain: '' },
        named: [],
        status: p.c || (best.length ? 'found' : 'none'),
        log: [],
      },
    };
  }
}

/** Has the firm been checked on this computer (not only ahead of time, in data/checks.json)? */
const checkedHere = (id) => !!state.checks[id] && !state.checks[id].bundled;

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
    .filter((r) => !checkedHere(r.firm.id));
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

/** Change a firm's record (patch, or a function of the record as stored: see store.setOutreach) and draw it. */
async function setOutreach(firm, patch) {
  const named = (p) => p && { ...p, firm: firmRef(firm) };
  const rec = await store.setOutreach(firm.id, typeof patch === 'function' ? (old) => named(patch(old)) : named(patch));
  if (rec) state.outreach[firm.id] = rec;
  else delete state.outreach[firm.id];
  renderOutreach();
  rerender(firm.id);
  return rec;
}

const OUTREACH_TEXT = { drafted: 'Drafted', sent: 'Sent', replied: 'Replied', closed: 'Closed' };

/**
 * The firms written to (or Closed), by id and by website: the same firm found again under another id (a Hacker News
 * post of a registry firm) counts as written to, so it's never recommended twice.
 */
function writtenIndex() {
  const ids = new Set();
  const domains = new Set();
  for (const [id, rec] of Object.entries(state.outreach)) {
    if (!rec || (rec.status === 'drafted' && !rec.sending)) continue;
    ids.add(id);
    const d = rec.firm && (rec.firm.domain || D.domainOf(rec.firm.site || ''));
    if (d) domains.add(d);
  }
  return { ids, domains };
}
const writtenTo = (firm, index = writtenIndex()) =>
  index.ids.has(firm.id) || (!!firm.domain && index.domains.has(firm.domain));

function day(t) {
  if (!t) return '';
  const d = new Date(t);
  const opts = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-GB', opts);
}

/** A first email waiting at Nylas for their morning: not sent yet, whatever its record's status says. */
const waitsAtNylas = (rec) => rec.status === 'sent' && !!rec.scheduleId && !rec.messageId && rec.sendAt > Date.now();

/** 'Drafted', 'Sent 6 Nov', 'Arrives 9 Nov' (waiting at Nylas), 'Replied' or 'Closed'. */
function outreachPill(rec) {
  if (!rec) return null;
  const text = waitsAtNylas(rec)
    ? `Arrives ${day(rec.sendAt)}`
    : rec.status === 'sent'
      ? `Sent ${day(rec.sentAt || rec.updatedAt)}`
      : OUTREACH_TEXT[rec.status];
  const tone = rec.status === 'sent' || rec.status === 'replied' ? ' ok' : '';
  return el('span', { className: 'pill outreach-pill' + tone, textContent: text });
}

/* ------------------------------------------------------------ rendering */

/** The results as shown: only those with something open when asked, best way in first when asked. */
function visible() {
  const written = writtenIndex();
  const hide = $('#hide-written').checked;
  let list = state.results;
  if (hide) list = list.filter((r) => !writtenTo(r.firm, written));
  state.hidden = state.results.length - list.length;
  if ($('#only-open').checked) list = list.filter((r) => hasOpen((state.checks[r.firm.id] || {}).result));
  if ($('#only-contact').checked) list = list.filter((r) => contactsOf(r.firm).length);
  // A firm whose site showed nothing (no careers page, no board, no address) goes after the rest, in the search's
  // order: it's still a real firm (the web search may find someone), just not the first to write to.
  const empty = (r) => wayOf(r.firm) === WAYS.length - 1;
  list = [...list.filter((r) => !empty(r)), ...list.filter(empty)];
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
    // A firm checked only ahead of time is read again first, unless that's under way already (Review starts it
    // alongside this search): then the search starts from what the site showed then, and the addresses below wait
    // for the read to finish.
    if (!checkedHere(firm.id)) await checkFirm(firm);
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
      await settled(state.running, firm.id);
      const now = (state.checks[firm.id] || {}).result || check;
      // A site that moved (GLG Partners is part of Man Group now): its careers and contacts are read there.
      if (web.website.confirmed && ['unreachable', 'none', 'blocked'].includes(now.status)) {
        state.moved[firm.id] = { url: web.website.url, name: web.website.name || '' };
        await checkFirm(firm, { force: true });
      }
    }
    await settled(state.running, firm.id);
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
  const bundled = !!(state.checks[firm.id] || {}).bundled;
  // A firm checked only ahead of time keeps the detail folded: the line at the top of its card says the gist. Opened,
  // it stays open while the card is drawn again.
  const open = !bundled || state.opened.has(firm.id);
  return el(
    'details',
    {
      className: 'found',
      open,
      ontoggle: (e) => (e.target.open ? state.opened.add(firm.id) : state.opened.delete(firm.id)),
    },
    el('summary', {
      textContent: bundled
        ? `Careers pages and who to email${state.preBuilt ? ` (checked ${longDate(state.preBuilt)})` : ''}`
        : 'Careers pages and who to email',
    }),
    // The check's own status, unless the way in already says it ("Programme page" twice).
    el(
      'div',
      { className: 'row small' },
      text !== WAYS[way][1] ? el('span', { className: `pill ${tone}`, textContent: text }) : null,
      boardText ? el('span', { className: 'muted', textContent: `Board: ${boardText}` }) : null,
      result.other ? el('span', { className: 'muted', textContent: `${plural(result.other, 'other job')}` }) : null,
    ),
    (result.roles || []).length ? rolesList(result.roles) : null,
    result.pre && (result.pre.roles || result.pre.programmes)
      ? el('p', {
          className: 'small muted',
          textContent: `${[
            result.pre.roles && plural(result.pre.roles, 'student role'),
            result.pre.programmes && plural(result.pre.programmes, 'programme'),
          ]
            .filter(Boolean)
            .join(
              ' and ',
            )} on its site when it was checked${state.preBuilt ? ` on ${longDate(state.preBuilt)}` : ''}: Check now lists them.`,
        })
      : null,
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
      { hidden: !log.length },
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
    // Written to meanwhile (Review, in this tab or another): never a second email from here.
    const stored = (await store.getOutreach())[firm.id];
    if (stored) state.outreach[firm.id] = stored;
    if (how === 'send' && stored && stored.status !== 'drafted' && (stored.messageId || stored.scheduleId))
      throw new Error('Not sent: this firm was written to meanwhile (see the Outreach tab).');
    // Noted before Nylas has it: a page closed meanwhile looks for it in Sent next time, and the firm counts as
    // written to until then, so it isn't offered a second email.
    if (how === 'send') await setOutreach(firm, { sending: { to: p.address, subject: d.subject, from: Date.now() } });
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
    // Sent now: dated now, and no longer the email waiting at Nylas (Take it back leaves this one alone). A draft
    // saved for a firm already written to (or with an email waiting at Nylas) only adds the draft: its status,
    // address, subject and contact stay those of the email that went, which follow-ups and the reply check use.
    await setOutreach(firm, (old) => {
      const wrote = old && (old.sentAt || old.messageId || old.scheduleId || ['sent', 'replied'].includes(old.status));
      if (how !== 'send' && wrote) return { draftId: r.id };
      return {
        status: how === 'send' ? 'sent' : 'drafted',
        to: p.address,
        subject: d.subject,
        contact: contactRef(p),
        way: wayText(firm),
        via: 'nylas',
        ...(how === 'send'
          ? { messageId: r.id, threadId: r.threadId, sentAt: Date.now(), sendAt: null, scheduleId: '', sending: null }
          : { draftId: r.id }),
      };
    });
  } catch (err) {
    d.sendError = errorText(err);
    // Nylas said no: it didn't go.
    if (how === 'send') await setOutreach(firm, (old) => old && old.sending && { sending: null }).catch(() => null);
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
  const sent =
    rec && ((rec.status !== 'drafted' && rec.via === 'nylas' && (rec.messageId || rec.scheduleId)) || rec.sending);
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
  if (!nylas || !nylas.grantId) return {};
  // The first thing Nylas refused (a revoked grant, an expired key): said by Check for replies, never "No new replies".
  let error = null;
  const failed = (err) => ((error = error || err), null);
  // An email the drawer was sending as its page closed: found in Sent, it's recorded as sent; not there (a minute
  // on), it didn't go; not looked in (Nylas down), it stays counted as written to until it can be.
  const closedOn = Object.entries(state.outreach).filter(([, r]) => r.sending && Date.now() - r.sending.from > 60e3);
  for (const [id, rec] of closedOn) {
    const s = rec.sending;
    let failed = false;
    const m = await N.sentMessage(nylas, { to: s.to, subject: s.subject, after: s.from - 60e3, fetch: fetchFn }).catch(
      () => ((failed = true), null),
    );
    if (failed) continue;
    const found = m && {
      status: 'sent',
      to: s.to,
      subject: s.subject,
      via: 'nylas',
      messageId: m.id,
      threadId: m.threadId,
      sentAt: m.date ? m.date * 1000 : s.from,
    };
    const next = await store.setOutreach(id, (old) =>
      old && old.sending && old.sending.from === s.from ? { ...found, sending: null } : null,
    );
    if (next) state.outreach[id] = next;
  }
  // An email scheduled for their morning that has gone since: its message and thread, from the Sent folder.
  const gone = Object.entries(state.outreach).filter(
    ([, r]) => r.status === 'sent' && r.scheduleId && !r.messageId && r.sendAt && r.sendAt <= Date.now(),
  );
  for (const [id, rec] of gone) {
    const m = await N.sentMessage(nylas, { to: rec.to, subject: rec.subject, after: rec.sendAt, fetch: fetchFn }).catch(
      () => null,
    );
    if (!m) continue;
    // Worked out from the record as it is when written: it may have been taken back or changed meanwhile.
    const next = await store.setOutreach(id, (old) =>
      old && old.scheduleId === rec.scheduleId && !old.messageId ? { messageId: m.id, threadId: m.threadId } : null,
    );
    if (next) state.outreach[id] = next;
  }
  const waiting = Object.entries(state.outreach).filter(([, r]) => r.status === 'sent' && r.threadId);
  for (const [id, rec] of waiting) {
    const list = await N.replies(nylas, {
      threadId: rec.threadId,
      after: rec.sentAt,
      me: nylas.email,
      fetch: fetchFn,
    }).catch(failed);
    if (!list) continue;
    // An out-of-office noted once isn't noted again at the next look.
    const seen = new Set(rec.seenReplies || []);
    const fresh = list.filter((m) => !seen.has(m.id)).map((m) => ({ ...m, kind: O.replyKind(m) }));
    if (!fresh.length) continue;
    // A person's answer counts over a bounce, a bounce over an out-of-office.
    const human = fresh.find((m) => !['auto', 'bounced'].includes(m.kind));
    const bounce = fresh.find((m) => m.kind === 'bounced');
    const m = human || bounce || fresh[0];
    const from = (m.from || [])[0] || {};
    const who = from.name || from.email || 'them';
    const snippet = String(m.snippet || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
    const label = human ? 'Reply' : bounce ? 'Bounced' : 'Auto-reply';
    const note = `${label} from ${who} on ${day((m.date || 0) * 1000)}: “${snippet.slice(0, 140)}”`;
    const reply = { kind: m.kind, from: who, at: (m.date || 0) * 1000 || Date.now(), snippet };
    // Added to the note as it is when written, not as it was when the check began: one saved meanwhile stays.
    const next = await store.setOutreach(id, (old) => {
      if (!old || old.status !== 'sent' || old.threadId !== rec.threadId) return null;
      // Noted already (a second look running at once, another tab): left as it is.
      const known = new Set(old.seenReplies || []);
      if (fresh.every((x) => known.has(x.id))) return null;
      const notes = old.notes ? `${old.notes}\n${note}` : note;
      const seenReplies = [...new Set([...(old.seenReplies || []), ...fresh.map((x) => x.id)])].slice(-20);
      if (human) return { status: 'replied', reply, notes, seenReplies };
      // Never arrived: closed, with the address kept so the firm is written to at someone else's if asked.
      if (bounce) {
        const bounced = [...new Set([...(old.bounced || []), String(old.to || '').toLowerCase()])].filter(Boolean);
        return { status: 'closed', reply, notes, seenReplies, bounced };
      }
      // An out-of-office: still waiting for a person, and followed up as any other.
      return { reply, notes, seenReplies };
    });
    if (next) state.outreach[id] = next;
  }
  if (waiting.length) renderOutreach();
  afterReconcile(reconcileQueue());
  renderHome();
  return { error };
}

/** The reply check from a button (and every ten minutes while the page is open), one at a time. */
async function lookForReplies(button) {
  if (state.checkingReplies) return;
  // Said beside the button pressed (the Overview's or Outreach's).
  const line = button && button.id === 'home-check-replies' ? $('#home-status') : $('#outreach-status');
  if (!state.nylas || !state.nylas.grantId) {
    if (button) line.textContent = 'Connect your inbox under Settings › Email codes to have replies found.';
    return;
  }
  state.checkingReplies = true;
  if (button) button.disabled = true;
  const before = JSON.stringify(Object.values(state.outreach).map((r) => [r.status, r.reply && r.reply.at]));
  try {
    const res = await checkReplies();
    if (res && res.error) throw res.error;
    if (button) {
      const after = JSON.stringify(Object.values(state.outreach).map((r) => [r.status, r.reply && r.reply.at]));
      line.textContent =
        after === before
          ? 'No new replies.'
          : button.id === 'home-check-replies'
            ? 'Replies found: see Latest activity.'
            : 'Replies found: see below.';
    }
  } catch (err) {
    if (button) line.textContent = `Couldn’t look for replies: ${errorText(err)}`;
  } finally {
    state.checkingReplies = false;
    if (button) button.disabled = false;
  }
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
  const written = (rec && (rec.status !== 'drafted' || !!rec.sending)) || writtenTo(firm);
  return el('button', {
    className: 'write-go' + (item || written ? '' : ' primary'),
    type: 'button',
    disabled: !!written || !aiReady(),
    title: aiReady() ? 'Check it, find who to write to and a reason to, and draft the email to read in Review' : NO_AI,
    // One Closed by hand before anything was sent wasn't written to: it says Closed.
    textContent: written
      ? rec && rec.status === 'closed' && !rec.sentAt
        ? 'Closed'
        : 'Written to'
      : item
        ? 'In Review'
        : 'Write to them',
    onclick: () => writeTo([firm]),
  });
}

/** One line at the top of a card: the best way in and the first person to write to, from whatever check there is. */
function glanceView(firm) {
  const way = wayOf(firm);
  if (way == null) return null;
  const first = contactsOf(firm)[0];
  return el(
    'div',
    { className: 'glance' },
    el('span', {}, 'Best way in: ', el('span', { className: `pill ${WAYS[way][0]}`, textContent: WAYS[way][1] })),
    first
      ? el(
          'span',
          {},
          'Write to ',
          el('span', { className: 'who', textContent: whoLabel(first) }),
          ' ',
          el('a', { href: 'mailto:' + first.address, textContent: first.address }),
        )
      : el('span', { className: 'muted', textContent: 'No address on its site yet' }),
  );
}

/** Tick or untick a firm for Write to them / Watch them. */
function pick(id, on) {
  if (on) state.picked.add(id);
  else state.picked.delete(id);
  const li = document.querySelector(`#results .firm[data-id="${CSS.escape(id)}"]`);
  if (li) {
    li.classList.toggle('picked', on);
    const box = li.querySelector('input.pick');
    if (box) box.checked = on;
  }
  pickedBar();
}

/** The bar over the results: how many are picked, and what can be done with them. */
function pickedBar() {
  const ids = [...state.picked].filter((id) => state.results.some((r) => r.firm.id === id));
  state.picked = new Set(ids);
  const n = ids.length;
  $('#picked-count').textContent = n ? `${plural(n, 'firm')} selected` : 'None selected';
  $('#pick-none').hidden = !n;
  $('#write-picked').hidden = !n;
  $('#watch-picked').hidden = !n;
  $('#write-picked').textContent = `Write to ${n === 1 ? 'it' : `these ${n}`}`;
  $('#write-picked').disabled = !aiReady();
  $('#write-picked').title = aiReady() ? '' : NO_AI;
  $('#watch-picked').textContent = `Watch ${n === 1 ? 'it' : `these ${n}`}`;
}

/** The firms picked, in the order they're shown. */
const pickedFirms = () => state.results.filter((r) => state.picked.has(r.firm.id)).map((r) => r.firm);

function firmCard(r) {
  const { firm } = r;
  const check = state.checks[firm.id];
  const running = state.running.has(firm.id);
  const researching = state.researching.has(firm.id);
  const watched = state.watch.some((w) => w.id === firm.id);
  const people = contactsOf(firm);
  const d = state.drafts[firm.id];
  const picked = state.picked.has(firm.id);
  return el(
    'li',
    {
      className: 'firm' + (picked ? ' picked' : ''),
      dataset: { id: firm.id, open: String(hasOpen(check && check.result)) },
    },
    el(
      'div',
      { className: 'firm-head' },
      el('input', {
        type: 'checkbox',
        className: 'pick',
        checked: picked,
        attrs: { 'aria-label': `Select ${firm.name}` },
        onchange: (e) => pick(firm.id, e.target.checked),
      }),
      el('span', { className: 'firm-name', textContent: firm.name }),
      el('span', { className: 'firm-meta', textContent: meta(firm) }),
      outreachPill(state.outreach[firm.id]),
    ),
    glanceView(firm),
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
        textContent: running
          ? 'Checking…'
          : checkedHere(firm.id)
            ? 'Check again'
            : check
              ? 'Check now'
              : 'Check careers & contacts',
        onclick: () => checkAndRead(firm, { force: !!check }, thorough() ? requestAiConsent() : null),
        title:
          (check && check.bundled
            ? `Checked ahead of time${state.preBuilt ? ` on ${longDate(state.preBuilt)}` : ''}: Check now reads its site again for today’s roles and people. `
            : '') + (thorough() ? THOROUGH_READ : ''),
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
  $('#results-empty').hidden = true;
  $('#results-title').textContent = plural(list.length, 'firm');
  const ready = list.filter((r) => contactsOf(r.firm).length).length;
  $('#results-note').textContent = [
    list.length && `${ready} with someone to write to`,
    state.hidden && `${plural(state.hidden, 'firm')} you’ve written to left out`,
  ]
    .filter(Boolean)
    .join(' · ');
  pickedBar();
  // Nothing to list: what to change to get something.
  const none = $('#only-open').checked
    ? 'No firm checked so far has anything open. Check more firms (“Check careers & contacts”, “Check the top 10”), or untick “Only firms with something open”.'
    : $('#only-contact').checked
      ? 'No firm here has an address yet. Untick “Only firms with someone to write to”, or press Write to them: your AI looks for people.'
      : state.hidden && !list.length
        ? 'You’ve written to every firm that matches. Untick “Hide firms I’ve written to” to see them.'
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

/** The Outreach list as a spreadsheet, with a note typed a moment ago (its box left by the click) in it. */
async function exportOutreach() {
  await flushNotes();
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
      'Reply',
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
      waitsAtNylas(rec) ? 'Scheduled' : OUTREACH_TEXT[rec.status] || rec.status,
      new Date(rec.status === 'sent' && rec.sentAt ? rec.sentAt : rec.updatedAt).toISOString().slice(0, 10),
      rec.subject || '',
      rec.notes || '',
      (state.checks[id] && wayText({ id })) || rec.way || '',
      replyOf(rec) ? REPLY_TEXT[replyOf(rec)][1] : '',
    ]);
  }
  saveCsv(rows, 'outreach');
}

/* -------------------------------------------------------------- outreach tab */

const outreachList = () =>
  Object.entries(state.outreach)
    .filter(([, r]) => r)
    .sort(([, a], [, b]) => b.updatedAt - a.updatedAt);

// The Outreach tab's filters: [key, words, does a record fit].
const OUTREACH_FILTERS = [
  ['all', 'All', () => true],
  ['waiting', 'Awaiting a reply', (r) => r.status === 'sent' && !waitsAtNylas(r)],
  ['quiet', 'No reply for 5+ days', (r) => r.status === 'sent' && !waitsAtNylas(r) && workingDaysSince(r.sentAt) >= 5],
  [
    'replied',
    'Answered',
    (r) => r.status === 'replied' || ['positive', 'apply', 'declined', 'reply'].includes(replyOf(r)),
  ],
  ['positive', 'Interested', (r) => replyOf(r) === 'positive'],
  ['apply', 'Apply online', (r) => replyOf(r) === 'apply'],
  ['declined', 'Declined', (r) => replyOf(r) === 'declined'],
  ['auto', 'Auto-reply', (r) => r.status === 'sent' && replyOf(r) === 'auto'],
  ['bounced', 'Bounced', (r) => replyOf(r) === 'bounced' && !(r.reply && r.reply.done)],
  ['scheduled', 'Arriving later', (r) => waitsAtNylas(r)],
  ['drafted', 'Drafted', (r) => r.status === 'drafted'],
  ['closed', 'Closed', (r) => r.status === 'closed' && replyOf(r) !== 'bounced'],
];

/** Does a record fit the filter chosen and the words typed in the search box? */
function outreachFits(rec) {
  const f = OUTREACH_FILTERS.find(([k]) => k === state.outreachFilter) || OUTREACH_FILTERS[0];
  if (!f[2](rec)) return false;
  const words = ($('#outreach-search').value || '').trim().toLowerCase();
  if (!words) return true;
  const c = rec.contact || {};
  const hay = [rec.firm.name, rec.firm.domain, c.name, c.title, c.email, rec.to, rec.subject, rec.notes]
    .join(' ')
    .toLowerCase();
  return words.split(/\s+/).every((w) => hay.includes(w));
}

/** The filter chips over the list, each with its count; one with none is left out (All always shows). */
function drawOutreachFilters() {
  const recs = Object.values(state.outreach).filter(Boolean);
  const box = $('#outreach-filters');
  const chips = OUTREACH_FILTERS.map(([key, words, fits]) => {
    const n = recs.filter(fits).length;
    if (!n && key !== 'all' && key !== state.outreachFilter) return null;
    return el(
      'button',
      {
        type: 'button',
        attrs: { role: 'radio', 'aria-checked': String(key === state.outreachFilter) },
        dataset: { filter: key },
        onclick: () => {
          state.outreachFilter = key;
          renderOutreach(true);
        },
      },
      words,
      el('span', { className: 'count', textContent: String(n) }),
    );
  }).filter(Boolean);
  const key = chips.map((c) => c.textContent + c.getAttribute('aria-checked')).join('|');
  if (key !== box.dataset.drawn) {
    const had = document.activeElement && document.activeElement.closest('#outreach-filters');
    box.replaceChildren(...chips);
    box.dataset.drawn = key;
    if (had) {
      const again = box.querySelector('[aria-checked="true"]');
      if (again) again.focus();
    }
  }
}

/** The registry's firm for an outreach record (its id, else its website), or the record's own short copy. */
function firmOf(rec) {
  const id = rec.firm.id;
  const found =
    state.firms.find((f) => f.id === id) ||
    (rec.firm.domain && state.firms.find((f) => f.domain === rec.firm.domain)) ||
    (state.results.find((r) => r.firm.id === id) || {}).firm;
  return found || { aliases: [], cities: [], tags: [], ...rec.firm };
}

/** A bounced email's firm back to Drafted and into Review, where its email goes to someone else there. */
async function tryAgain(id) {
  const rec = state.outreach[id];
  if (!rec) return;
  if (!aiReady()) return void ($('#outreach-status').textContent = NO_AI);
  const consent = requestAiConsent();
  // The record's own id, whatever entry its website matches: the record changed, the email queued and the addresses
  // left out are all that firm's.
  const found = firmOf(rec);
  const firm = found.id === id ? found : { ...found, id };
  // The address that bounced is never written to again (a record from before bounces were noted has only its "to").
  const bounced = (old) => [...new Set([...(old.bounced || []), String(old.to || '').toLowerCase()])].filter(Boolean);
  await setOutreach(firm, (old) =>
    old ? { status: 'drafted', reply: null, sentAt: old.sentAt, bounced: bounced(old) } : null,
  );
  review.consent = consent;
  writeTo([firm], true, true);
}

async function loadOutreach() {
  await storeLeftNotes();
  state.outreach = await store.getOutreach();
  renderOutreach();
}

// Notes are saved a moment after typing stops, when the box is left, and when the tab is closed or hidden.
const notes = new Map(); // firmId → { text, timer }
const noteBase = new Map(); // firmId → the note as this tab last drew or saved it: what the typing started from
const writing = new Map(); // firmId → the note being written now
const unsaved = new Map(); // firmId → the note typed and not yet stored, kept in the page's storage if it closes
const NOTES_LEFT = 'jobtofill-notes-left';

/**
 * Write a note typed here. One changed meanwhile (a line added in another tab, a reply noted by the reply check) is
 * kept, with what was typed here put with it, never written over; a box left as it was drawn (or as this tab last
 * wrote it: measured once any write of its own still going has landed) writes nothing, so the row (and the select
 * just clicked in it) isn't drawn again.
 */
function writeNote(id) {
  const pending = notes.get(id);
  const before = writing.get(id);
  if (!pending) return before || Promise.resolve();
  clearTimeout(pending.timer);
  notes.delete(id);
  const done = (async () => {
    await before;
    const base = noteBase.has(id) ? noteBase.get(id) : (state.outreach[id] && state.outreach[id].notes) || '';
    if (pending.text === base) return forget(id, pending.text);
    let merged = false;
    const rec = await store.setOutreach(id, (old) => {
      if (!old) return null;
      const theirs = old.notes || '';
      if (theirs === pending.text) return null;
      merged = theirs !== base;
      return { notes: merged ? mergeNote(base, theirs, pending.text) : pending.text };
    });
    forget(id, pending.text);
    // Removed meanwhile (in another tab): said, and its row goes once the box is left.
    if (!rec) {
      $('#outreach-status').textContent = 'Not saved: this firm was removed from the list.';
      return setTimeout(() => renderOutreach());
    }
    state.outreach[id] = rec;
    // The box shows the note as kept, unless more has been typed since: then the next save starts from what was
    // typed, so it puts the other line in again rather than dropping it.
    const box = document.querySelector(`#outreach li[data-id="${CSS.escape(id)}"] .outreach-notes`);
    const shows = !!box && box.value === pending.text;
    if (merged && shows) setBox(box, rec.notes || '');
    noteBase.set(id, merged && !shows ? pending.text : rec.notes || '');
    $('#outreach-status').textContent = merged ? 'Saved, with what was added meanwhile kept.' : 'Saved.';
  })().finally(() => writing.get(id) === done && writing.delete(id));
  writing.set(id, done);
  return done;
}

/** A note stored (or found already there): no longer kept for a page that closes. */
function forget(id, text) {
  if (unsaved.get(id) === text) unsaved.delete(id);
}

/** Two pieces of a note put together, on a new line when the second starts a sentence of its own. */
const joinNote = (a, b) => (a && /^[\p{L}\p{N}“"']/u.test(b) && !/\s$/.test(a) ? `${a}\n${b}` : a + b);

/**
 * A note typed from `base` put with one changed meanwhile: each one's addition kept (the typed one first, as the
 * person wrote it, then the other's), or both whole when either was edited rather than added to.
 */
function mergeNote(base, theirs, mine) {
  if (theirs.startsWith(base)) return joinNote(mine, theirs.slice(base.length));
  if (mine.startsWith(base)) return joinNote(theirs, mine.slice(base.length));
  return `${theirs}\n${mine}`;
}

/** A box's text changed under the caret: an addition at the end goes in after it, else the caret stays put. */
function setBox(box, text) {
  if (box.value === text) return;
  if (document.activeElement !== box) return void (box.value = text);
  if (text.startsWith(box.value))
    return box.setRangeText(text.slice(box.value.length), box.value.length, box.value.length, 'preserve');
  const [a, b] = [box.selectionStart, box.selectionEnd];
  box.value = text;
  box.setSelectionRange(Math.min(a, text.length), Math.min(b, text.length));
}

function saveNote(id, text, now) {
  const pending = notes.get(id);
  if (pending) clearTimeout(pending.timer);
  notes.set(id, { text, timer: setTimeout(() => writeNote(id), 600) });
  unsaved.set(id, text);
  if (now) writeNote(id);
}

/** Every note typed and not yet written, written now; resolves once those being written are too. */
const flushNotes = () => Promise.all([...[...notes.keys()].map(writeNote), ...writing.values()]);

/**
 * The page closing: notes typed and not yet stored kept in the page's own storage, which writes at once (the
 * extension's storage reads first, and the page is gone before it can write), to be stored when Discover next opens.
 */
function leaveNotes() {
  if (!unsaved.size) return;
  try {
    const left = JSON.parse(localStorage.getItem(NOTES_LEFT) || '{}');
    // With what the typing started from, as this tab last drew or wrote it; after any another tab left for the firm.
    for (const [id, text] of unsaved) {
      const base = noteBase.has(id) ? noteBase.get(id) : (state.outreach[id] || {}).notes || '';
      left[id] = [...(Array.isArray(left[id]) ? left[id] : left[id] ? [left[id]] : []), { text, base }];
    }
    localStorage.setItem(NOTES_LEFT, JSON.stringify(left));
  } catch (err) {
    // Not allowed: the write started as the page closed may still land.
  }
}

/** Notes a page left as it closed, stored now: put with the note as it is, unless they're in it already. */
async function storeLeftNotes() {
  let left;
  try {
    left = JSON.parse(localStorage.getItem(NOTES_LEFT) || 'null');
    localStorage.removeItem(NOTES_LEFT);
  } catch (err) {
    return;
  }
  for (const [id, list] of Object.entries(left || {}))
    for (const n of Array.isArray(list) ? list : [list]) {
      if (!n || typeof n.text !== 'string') continue;
      const base = String(n.base || '');
      const rec = await store.setOutreach(id, (old) => {
        if (!old) return null;
        const theirs = old.notes || '';
        // Written already (the page's own save landed after all, or another tab stored this one).
        const added = n.text.startsWith(base) ? n.text.slice(base.length) : '';
        if (theirs === n.text || (added && theirs.includes(added))) return null;
        // Unchanged since that page drew it: what it typed, a line cut out included; else put with what's there.
        return { notes: theirs === base ? n.text : mergeNote(base, theirs, n.text) };
      });
      if (rec) state.outreach[id] = rec;
    }
}

/** A row's date: 'Sent 6 Nov', 'Arrives 9 Nov' for one waiting at Nylas, else its status and when it last changed. */
const outreachWhen = (rec) => {
  if (waitsAtNylas(rec)) return `Arrives ${day(rec.sendAt)} (waiting at Nylas)`;
  if (rec.status === 'sent' && rec.sentAt) {
    const quiet = workingDaysSince(rec.sentAt);
    return `Sent ${day(rec.sentAt)}${quiet >= 2 ? ` · no reply for ${quiet} working days` : ''}${rec.followedUpAt ? ' · followed up' : ''}`;
  }
  if (rec.reply && rec.reply.at && rec.status !== 'drafted') return `${OUTREACH_TEXT[rec.status]} ${day(rec.reply.at)}`;
  return `${OUTREACH_TEXT[rec.status]} ${day(rec.updatedAt)}`;
};

/**
 * What a row shows apart from its note and the date it last changed: one whose note alone changed (and with it that
 * date) is the same row, updated in place, so the select or Remove being clicked in it stays.
 */
const outreachCore = (rec) =>
  JSON.stringify({ ...rec, notes: '', updatedAt: 0, when: outreachWhen({ ...rec, updatedAt: 0 }) });
/** What a row was drawn from: its record, and what its date says now ("Arrives…" turns to "Sent…" when it goes). */
const outreachDrawn = (rec) => `${JSON.stringify(rec)}|${outreachWhen(rec)}`;

let removedAt = 0; // the last Remove on the Outreach tab

function outreachItem(id, rec) {
  noteBase.set(id, rec.notes || '');
  const c = rec.contact || {};
  const firmName = rec.firm.site ? link(rec.firm.site, rec.firm.name) : rec.firm.name;
  const when = outreachWhen(rec);
  const kind = replyOf(rec);
  const [tone, said] = kind ? REPLY_TEXT[kind] : ['', ''];
  return el(
    'li',
    { className: 'firm outreach-item', dataset: { id } },
    el(
      'div',
      { className: 'firm-head' },
      el('span', { className: 'firm-name' }, firmName),
      el('span', { className: 'firm-meta', textContent: when }),
      kind ? el('span', { className: `pill reply-pill ${tone}`, textContent: said }) : null,
    ),
    rec.reply && rec.reply.snippet
      ? el('p', {
          className: `reply-snippet ${kind}`,
          textContent: `${rec.reply.from ? `${rec.reply.from}: ` : ''}“${rec.reply.snippet}”`,
        })
      : null,
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
              // Removed in another tab (its row kept while its note had the focus): not made again without its name.
              if (!state.outreach[id]) {
                $('#outreach-status').textContent = 'Not changed: this firm was removed from the list.';
                return renderOutreach();
              }
              // A note typed a moment ago is saved first, so the item drawn again shows it.
              await writeNote(id);
              const next = await store.setOutreach(id, { status: value });
              state.outreach[id] = next;
              const fresh = outreachItem(id, next);
              Object.assign(fresh, { drawn: outreachDrawn(next), core: outreachCore(next) });
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
          placeholder: 'Add a note',
          oninput: (e) => saveNote(id, e.target.value),
          onchange: (e) => saveNote(id, e.target.value, true),
        }),
      ),
    ),
    el(
      'div',
      { className: 'firm-actions' },
      kind === 'bounced' && !(rec.reply && rec.reply.done)
        ? el('button', {
            className: 'small leave-it',
            type: 'button',
            textContent: 'Leave it',
            title: 'Not writing to anyone else there: it stops counting as a bounce to deal with',
            onclick: () =>
              setOutreach(firmOf(rec), (old) => (old && old.reply ? { reply: { ...old.reply, done: true } } : null)),
          })
        : null,
      kind === 'bounced' && !(rec.reply && rec.reply.done)
        ? el('button', {
            className: 'small primary try-again',
            type: 'button',
            textContent: 'Try someone else',
            title: `Back into Review, written to another person at ${rec.firm.name} (never ${(rec.bounced || []).join(', ') || 'the address that bounced'})`,
            onclick: () => tryAgain(id),
          })
        : null,
      el('button', {
        className: 'small',
        type: 'button',
        textContent: 'Remove',
        onclick: async (e) => {
          // A double click, or a second tap straight after, isn't for the firm that has moved up under the pointer.
          if (Date.now() - removedAt < 600) return;
          removedAt = Date.now();
          const keyboard = e.detail === 0;
          // The note as the box shows it, typed a moment ago or still being written: Undo brings that back.
          const box = e.currentTarget.closest('li').querySelector('.outreach-notes');
          const typed = box ? box.value : null;
          clearTimeout((notes.get(id) || {}).timer);
          notes.delete(id);
          unsaved.delete(id);
          await writing.get(id);
          // Only typing not yet stored is taken from the box (put with a line added meanwhile): a box left as drawn
          // may be out of date (a reply noted while another note had the focus).
          const was = state.outreach[id];
          const base = noteBase.has(id) ? noteBase.get(id) : (was && was.notes) || '';
          const stored = (was && was.notes) || '';
          const keep = typed === null || typed === base || typed === stored ? stored : mergeNote(base, stored, typed);
          const gone = was && { ...was, notes: keep };
          await store.removeOutreach(id);
          delete state.outreach[id];
          renderOutreach();
          rerender(id);
          if (gone) outreachToast(`Removed ${gone.firm.name}.`, 'Undo', () => undoRemove(id, gone), keyboard);
        },
      }),
    ),
  );
}

/**
 * Remove undone: the record back as it was, with its date (so it's back in its place when the tab is next opened). A
 * first email waiting at Nylas that the queue took back meanwhile comes back as Drafted, never as on its way; a firm
 * drafted again meanwhile keeps the new record, with the old notes put back.
 */
async function undoRemove(id, gone) {
  outreachToast();
  const name = gone.firm.name;
  const back =
    gone.scheduleId && review.items.some((i) => i.firm.id === id && i.takenBack === gone.scheduleId)
      ? {
          ...gone,
          status: gone.status === 'sent' ? 'drafted' : gone.status,
          sentAt: null,
          sendAt: null,
          scheduleId: '',
          takenBack: gone.scheduleId,
        }
      : gone;
  let again = false;
  const rec = await store.setOutreach(
    id,
    (old) => {
      if (!old) return back;
      again = true;
      const had = String(old.notes || '');
      return gone.notes && !had.includes(gone.notes) ? { notes: had ? `${had}\n${gone.notes}` : gone.notes } : null;
    },
    { at: gone.updatedAt },
  );
  if (rec) state.outreach[id] = rec;
  renderOutreach();
  rerender(id);
  const li = document.querySelector(`#outreach li[data-id="${CSS.escape(id)}"]`);
  if (li) li.querySelector('select').focus({ preventScroll: false });
  // Made again meanwhile: said as it is now (drafted, or written to: "Sent 20 Nov").
  const now = rec && (rec.status === 'drafted' ? 'drafted again' : `written to again (${outreachWhen(rec)})`);
  const kept = rec && rec.status === 'drafted' ? 'the new draft' : 'that record';
  $('#outreach-status').textContent = again
    ? `${name} was ${now} meanwhile: it keeps ${kept}${gone.notes ? ', with its notes put back' : ''}.`
    : `${name} is back.`;
}

/**
 * A word at the foot of the screen while Outreach is open (Remove's Undo), seen however far down the row was; it goes
 * after twelve seconds, not while the pointer or the keyboard's focus is on it (given it, after a Remove pressed with
 * the keyboard).
 */
function outreachToast(text, label, act, focus) {
  let box = $('#outreach-view .toasts');
  if (!box) {
    box = el('div', { className: 'toasts' });
    $('#outreach-view').append(box);
  }
  clearTimeout(outreachToast.timer);
  if (!text) return box.replaceChildren();
  const button = el('button', { className: 'link', type: 'button', textContent: label, onclick: act });
  const toast = el('div', { className: 'toast', attrs: { role: 'status' } }, el('span', { textContent: text }), button);
  const later = () => (outreachToast.timer = setTimeout(() => box.replaceChildren(), 12000));
  const hold = () => clearTimeout(outreachToast.timer);
  toast.addEventListener('pointerenter', hold);
  toast.addEventListener('focusin', hold);
  toast.addEventListener('pointerleave', () => !toast.contains(document.activeElement) && later());
  toast.addEventListener('focusout', (e) => !toast.contains(e.relatedTarget) && later());
  box.replaceChildren(toast);
  later();
  if (focus) button.focus();
}

/**
 * The Outreach list. While it's on screen its order stays as drawn (a firm drafted meanwhile, by the queue or another
 * tab, goes at the end; newest first again when the tab is next opened), so no row moves from under the pointer and
 * the next click (Remove) lands on the firm meant. Only rows whose record changed are drawn again; one whose note or
 * time alone changed is updated in place (its select may be the one being clicked), and one with the focus gives it
 * back to the same control.
 */
function renderOutreach(sort) {
  const every = outreachList();
  $('#outreach-count').textContent = String(every.length);
  $('#outreach-empty').hidden = !!every.length;
  $('#outreach-export').disabled = !every.length;
  $('#outreach-filters').hidden = !every.length;
  drawOutreachFilters();
  const list = every.filter(([, r]) => outreachFits(r));
  $('#outreach-none').hidden = !every.length || !!list.length;
  renderHome();
  // A note being typed isn't drawn again under the cursor when a draft elsewhere adds a firm: that firm waits (drawn
  // when the box is left). Its own note changed meanwhile shows in it, unless something has been typed there since.
  const active = document.activeElement;
  const typing = active && active.closest('#outreach .outreach-notes');
  if (typing) {
    const id = typing.closest('li').dataset.id;
    const rec = state.outreach[id];
    if (rec && !notes.has(id) && typing.value === noteBase.get(id) && (rec.notes || '') !== typing.value) {
      setBox(typing, rec.notes || '');
      noteBase.set(id, typing.value);
    }
    return;
  }
  outreachTimer(list);
  const ul = $('#outreach');
  const rows = new Map([...ul.children].map((li) => [li.dataset.id, li]));
  const byId = new Map(list);
  const order =
    sort || $('#outreach-view').hidden
      ? list
      : [
          ...[...rows.keys()].filter((id) => byId.has(id)).map((id) => [id, byId.get(id)]),
          ...list.filter(([id]) => !rows.has(id)),
        ];
  const row = active && active.closest('#outreach li[data-id]');
  // The focus goes back to the same control in a row drawn again: its select, note or Remove, else its nth link (an
  // address or website added meanwhile mustn't take the select's place).
  const role = row && active.matches('select, textarea, button') ? active.tagName.toLowerCase() : '';
  const at = row && !role ? [...row.querySelectorAll('a')].indexOf(active) : -1;
  const core = outreachCore;
  const want = order.map(([id, rec]) => {
    const drawn = outreachDrawn(rec);
    const old = rows.get(id);
    if (old && old.drawn === drawn) return old;
    if (old && old.core === core(rec)) {
      const box = old.querySelector('.outreach-notes');
      if (box && box !== active) {
        box.value = rec.notes || '';
        noteBase.set(id, box.value);
      }
      old.querySelector('.firm-meta').textContent = outreachWhen(rec);
      old.drawn = drawn;
      return old;
    }
    const li = outreachItem(id, rec);
    Object.assign(li, { drawn, core: core(rec) });
    return li;
  });
  for (const li of [...ul.children]) if (!want.includes(li)) li.remove();
  want.forEach((li, k) => ul.children[k] !== li && ul.insertBefore(li, ul.children[k] || null));
  const again = row && !row.isConnected && want.find((li) => li.dataset.id === row.dataset.id);
  const control = again && (role ? again.querySelector(role) : again.querySelectorAll('a')[at]);
  if (control) control.focus({ preventScroll: true });
}

/** With the page left open, the list (and the firms' cards) drawn again as the next email waiting at Nylas goes. */
function outreachTimer(list) {
  clearTimeout(outreachTimer.timer);
  const waiting = list.filter(([, r]) => waitsAtNylas(r));
  if (!waiting.length) return;
  const next = Math.min(...waiting.map(([, r]) => r.sendAt));
  outreachTimer.timer = setTimeout(
    () => {
      renderOutreach();
      for (const [id, r] of waiting) if (!waitsAtNylas(r)) rerender(id);
    },
    Math.min(next - Date.now() + 1000, 3600e3),
  );
}

/* ------------------------------------------------------------- watchlist */

async function watchFirm(firm) {
  // Its roles as its site lists them today are the baseline: one checked only ahead of time lists none, so every role
  // open now would come up as new.
  const result = checkedHere(firm.id) ? state.checks[firm.id].result : await checkFirm(firm);
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
// emails and pressing Send ten times. Nothing is sent unless Send is pressed for that email: a press in the first moment
// a card shows is taken for the card before, a held key counts once, and each sent email can be taken back for five
// seconds (leaving the page in that time takes it back too).
const review = {
  items: [], // [{ id, firm, type: 'first' | 'follow', status, step, error, hooks, hook, to, subject, body, result, … }]
  at: 0, // the item shown (items.length: the summary)
  busy: 0, // items being prepared
  consent: null, // the AI consent asked for on the click that started the work (Firefox)
  pending: new Map(), // item id → { item, timer }: sends waiting out their five seconds, oldest first
  delivering: new Set(), // items this page is handing to Nylas now (any other 'delivering' one, the page closed on)
  running: new Map(), // item → the run preparing or writing it again, still waiting on the AI (owner or not); by the
  // item itself, not its id: a firm cleared and written to again is a new item, and never takes the old one's run
  toast: null, // { text, show?, takeBack? }: what just happened
  note: null, // { key, node }: the toast under the alerts as drawn
  alerts: [], // [{ text, show?, at, keep?, seen? }]: what went wrong, kept until read (never pushed out by the next "Sent")
  room: 0, // the room kept below the card for the toasts: grows at once, shrinks only when the card changes
  drawn: '', // what the card was last drawn from, so typing in it isn't undone by a redraw
  shownKey: '', // the item and status the card shows, and since when: a press then is for the card before
  shownAt: 0,
  undoneAt: 0, // the last Undo: a second one straight after (a double click) isn't for the email before
  typedAt: 0, // the last key typed into the card's boxes
  dropped: false, // the card was drawn again under the cursor (its email finished elsewhere) mid-word
  cleared: [], // firm ids cleared from the queue, so Write to the next 10 doesn't bring them back
  declined: {}, // firm id → the sentAt of the email whose follow-up was skipped: not offered again
  live: false, // this tab has the queue (claimQueue): another Discover tab shows it's open there
  opening: true, // finding out whether it does, as the page opens
  ready: null, // resolves once it knows (readied)
  readied: null,
  holding: false, // holds the queue's lock (also for a moment after handing it over, until it's taken)
  taking: false, // asked the tab that has it to hand it over
  busyThere: false, // and that tab is finishing what it's sending first
  handing: '', // the tab it's being handed to, once nothing is being sent
  leaving: false, // being stored to hand over: nothing new is sent, saved or taken back
  cameFrom: null, // { id, at }: the tab it was handed here from, to go back to if this one closes straight away
  granted: null, // resolves once this tab has the queue
  grant: null,
  waiting: null, // aborts this tab's place in the line for it (when handed it, it takes it at once)
  reclaim: 0, // takes it back when the tab it was handed to doesn't take it
  channel: null, // to ask the tab that has it to hand it over
};
review.ready = new Promise((resolve) => (review.readied = resolve));
const PREPARE_AT_ONCE = 4;
const UNDO_MS = 5000;
const FRESH_MS = 600; // a Send this soon after a card shows (or a doubt is raised) was meant for what was there before
const TYPING_MS = 1200; // keys this close together, after the box typed in was drawn away, are still the typing
const LOOK_FOR_MS = 3 * 24 * 3600e3; // an email the page closed on is looked for in Sent for three days after its time
const HOOK_AGE = 7 * 24 * 3600e3; // reasons to write are looked for again after a week
const TOP = 10;
// Statuses: waiting, preparing, ready, none (no one to write to), failed, sending (its five seconds), delivering (at
// Nylas), saving (to drafts), and the finished ones (elsewhere: written to or answered outside the queue).
const FINISHED = new Set(['sent', 'scheduled', 'saved', 'skipped', 'watched', 'elsewhere']);
const MOVING = new Set(['sending', 'delivering', 'saving']);
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
const shown = () => review.items[review.at] || null;
/** Draw the queue, the card again only when it shows this item (an async step finishing elsewhere keeps the cursor). */
const redraw = (item) => renderReview(shown() === item);

/**
 * The queue as kept between visits: what each item was doing is forgotten, its draft and outcome kept. An email still
 * in its five seconds wasn't sent and says so; one handed to Nylas is looked for in Sent when the page opens again.
 * Written at once after a send or a skip; typing (`soon`) waits for a pause.
 */
function saveQueue(soon) {
  clearTimeout(saveQueue.timer);
  // Only the tab that has the queue stores it: another's copy is stale.
  if (!review.live) return Promise.resolve();
  const write = () =>
    store
      .setDiscoverCache({ queue: queueNow() })
      .then(() => {
        try {
          localStorage.removeItem(QUEUE_LEFT);
        } catch (err) {
          // Nothing kept there to clear.
        }
      })
      .catch(() => null);
  if (soon) saveQueue.timer = setTimeout(write, 400);
  else return write();
  return Promise.resolve();
}

/** The queue as stored: each item as the next visit should find it, with the alerts not yet read (for a tab it's
 * handed to: an email that didn't go). */
function queueNow() {
  const items = review.items.map(({ job, takingBack, ...i }) => kept(i));
  const alerts = review.alerts.filter((a) => !a.seen).map(({ text, show, keep }) => ({ text, show, keep }));
  const { cleared, declined } = review;
  return { items, at: Math.max(0, review.at), cleared, declined, alerts, savedAt: Date.now() };
}

/**
 * The page closing: the queue as it is now (an edit typed a moment ago, the card moved to) kept at once in the page's
 * own storage, which writes before the page goes, where the extension's storage can't (it reads before it writes);
 * the next Discover page to open the queue takes it from there if it's newer.
 */
const QUEUE_LEFT = 'jobtofill-review-queue-left';
function leaveQueue() {
  if (!review.live || !review.items.length) return;
  const queue = queueNow();
  try {
    localStorage.setItem(QUEUE_LEFT, JSON.stringify(queue));
  } catch (err) {
    // Too big or not allowed: the extension's storage still has the last save.
  }
  store.setDiscoverCache({ queue }).catch(() => null);
}

/** The queue a page left as it closed, if it's newer than the one stored (and not dated ahead: a clock put back). */
function queueLeft(stored) {
  try {
    const left = JSON.parse(localStorage.getItem(QUEUE_LEFT) || 'null');
    const at = (left && left.savedAt) || 0;
    if (left && Array.isArray(left.items) && at > ((stored && stored.savedAt) || 0) && at < Date.now() + 60e3)
      return left;
  } catch (err) {
    // Unreadable: the stored queue it is.
  }
  return null;
}

/**
 * An item as the next visit should find it: nothing runs when a page opens, so one being prepared is waiting (held:
 * prepared again only when asked) or ready; one in its five seconds wasn't sent; one being saved to drafts may be
 * there already. One handed to Nylas stays 'delivering', to be looked for when the page opens.
 */
function kept(i) {
  const k = { ...i, step: '', armed: false };
  if (k.status === 'preparing') k.status = k.body ? 'ready' : 'waiting';
  if (k.status === 'sending')
    Object.assign(k, { status: 'ready', error: 'Not sent: the page was closed before its five seconds were up.' });
  if (k.status === 'saving')
    Object.assign(k, {
      status: 'ready',
      error: 'The page closed while this was being saved to your drafts: look there before saving or sending it.',
      unsure: 'It may be in your drafts already: look there before sending it from here.',
    });
  if (k.status === 'waiting') k.held = true;
  // An older version kept one written to or answered elsewhere as sent: it wasn't sent from here.
  if (k.status === 'sent' && Object.values(DONE).includes(k.outcome)) k.status = 'elsewhere';
  return k;
}

/** The queue's count on its tab: emails ready to read. */
function reviewCount() {
  const ready = review.items.filter((i) => i.status === 'ready').length;
  $('#review-count').textContent = ready ? String(ready) : '';
  drawQueue();
  renderHome();
}

// How each item stands, in the list down the side of Review: [class, icon, words].
const QUEUE_STATE = {
  waiting: ['', '○', 'Waiting'],
  preparing: ['q-busy', '◌', 'Preparing'],
  ready: ['q-ready', '●', 'Ready to read'],
  none: ['q-need', '!', 'No one to write to'],
  failed: ['q-need', '!', 'Needs you'],
  sending: ['q-busy', '◌', 'Sending'],
  delivering: ['q-busy', '◌', 'Sending'],
  saving: ['q-busy', '◌', 'Saving to drafts'],
  sent: ['q-done', '✓', 'Sent'],
  scheduled: ['q-done', '✓', 'Arrives in their morning'],
  saved: ['q-done', '✓', 'Saved to drafts'],
  skipped: ['q-done', '–', 'Skipped'],
  watched: ['q-done', '–', 'Watched'],
  elsewhere: ['q-done', '–', 'No longer needed'],
};
const STEP_WORDS = { check: 'Reading its site', people: 'Finding people', hooks: 'Finding a reason', draft: 'Writing' };

/** The queue down the side of Review: every firm, how far it has got, and a click to read it. */
function drawQueue() {
  const list = $('#review-queue');
  if (!list) return;
  if (!review.live || !review.items.length) {
    drawQueue.key = '';
    return void list.replaceChildren();
  }
  const at = shown();
  const key = review.items.map((i) => `${i.id}|${i.status}|${i.step}|${i.held}|${i.type}|${i === at}`).join(';');
  if (key === drawQueue.key) return;
  drawQueue.key = key;
  list.replaceChildren(
    ...review.items.map((i) => {
      const [cls, icon, words] = QUEUE_STATE[i.status] || ['', '○', i.status];
      const what =
        i.status === 'preparing'
          ? STEP_WORDS[i.step] || words
          : i.status === 'waiting' && i.held
            ? 'Not prepared yet'
            : i.status === 'failed' && i.error
              ? 'Something went wrong'
              : i.status === 'skipped' && i.nobody
                ? 'No one to write to'
                : words;
      return el(
        'li',
        { className: cls },
        el(
          'button',
          {
            type: 'button',
            attrs: { 'aria-current': String(i === at) },
            title: i.error || '',
            onclick: () => showItem(i),
          },
          el('span', { className: 'q-icon', textContent: icon, attrs: { 'aria-hidden': 'true' } }),
          el('span', { className: 'q-name', textContent: (i.type === 'follow' ? 'Follow-up: ' : '') + i.firm.name }),
          el('span', { className: 'q-state', textContent: what }),
        ),
      );
    }),
  );
}

/** No AI key: said where the person is looking (the toast on Review, the status line on Find firms). */
function noAi() {
  if ($('#review-view').hidden) return status(NO_AI, true);
  alarm(NO_AI);
  renderReview();
}

/**
 * Something that went wrong, said until it's read: kept beside the Undo toast, never replaced by the next "Sent". Three
 * at most, the oldest going first, but one about an email that will still go (`keep`: a failed take-back) goes last.
 */
function alarm(text, item, keep) {
  const all = [...review.alerts.filter((a) => a.text !== text), { text, show: item ? item.id : '', at: 0, keep }];
  // Never the one just raised: with three failed take-backs up, the oldest of those goes.
  while (all.length > 3) {
    const k = all.slice(0, -1).findIndex((a) => !a.keep);
    all.splice(k < 0 ? 0 : k, 1);
  }
  review.alerts = all;
}

/** A later success for an email settles what went wrong with it before (a failed take-back retried, a send). */
function settle(item) {
  review.alerts = review.alerts.filter((a) => a.show !== item.id);
}

/**
 * When a scheduled item goes: its own time (kept on the item since it was handed to Nylas), else, for one queued by an
 * older version before reconcileQueue() copies it, its record's.
 */
function goesAt(i) {
  const rec = state.outreach[i.firm.id];
  return i.sendAt || (rec && (i.type === 'first' ? rec.sendAt : rec.followedUpAt)) || 0;
}

/** The doubt about a copy the page closed on, kept while a copy sent anyway waits at Nylas: back if that's taken back. */
const doubtBack = (i) => ({
  unsure: (i.before && i.before.unsure) || '',
  lookFor: (i.before && i.before.lookFor) || null,
  before: null,
});

/**
 * Why an item is done already, from the firm's outreach record ('' when it isn't): a first email to a firm written to
 * since (from the drawer, another tab, Outreach), a follow-up to one that has had a reply or a follow-up.
 */
function alreadyDone(item, rec) {
  if (item.type === 'follow') {
    if (!rec) return DONE.gone;
    if (rec.status === 'replied') return DONE.replied;
    if (rec.status !== 'sent') return DONE.closed;
    return rec.followedUpAt ? DONE.followed : '';
  }
  if (rec && rec.status === 'closed' && !rec.sentAt) return DONE.dropped;
  // One the drawer was sending when its page closed counts as written to until Sent is looked in.
  return rec && (rec.status !== 'drafted' || rec.sending) ? DONE.written : '';
}
/** "Not sent again." where that email went already (written to, followed up); else "Not sent." (Closed, replied). */
const notAgain = (why, what) => `Not ${what}${[DONE.written, DONE.followed].includes(why) ? ' again' : ''}.`;
const DONE = {
  written: 'Already written to: see the Outreach tab.',
  dropped: 'Closed on the Outreach tab, so not written to.',
  replied: 'They replied: see the Outreach tab.',
  closed: 'No longer waiting for a reply: see the Outreach tab.',
  followed: 'Followed up already.',
  gone: 'The email it follows up is no longer in your outreach list.',
};

/**
 * The queue squared with the outreach records: an item written to or answered elsewhere is finished ('elsewhere', not
 * counted as sent), and back again only if its record is set back to Drafted (one removed stays finished: it was
 * written to); an email scheduled for their morning whose time has passed has gone, and one taken back is to read
 * again. Returns the items changed.
 */
function reconcileQueue() {
  if (!review.live) return [];
  const changed = [];
  let copied = false;
  for (const i of review.items) {
    const rec = state.outreach[i.firm.id];
    if (i.status === 'scheduled') {
      // Its schedule kept on the item (one queued by an older version gets its record's here), so a record removed on
      // the Outreach tab, or made again since, doesn't lose it.
      const t = rec && (i.type === 'first' ? rec.sendAt : rec.followedUpAt);
      if (t && !i.sendAt) {
        Object.assign(i, { sendAt: t, scheduleId: (i.type === 'first' ? rec.scheduleId : i.scheduleId) || '' });
        copied = true;
      }
      const at = goesAt(i);
      // Taken back (here or in another tab) is a record stamped with its schedule (an older item's, Drafted with no
      // schedule left). One set to Drafted by hand is still waiting at Nylas, so it stays as it is, with Take it back,
      // until it goes; so does one whose record was removed, or made again since (the drawer's draft of the firm).
      const takenBack = i.scheduleId
        ? !!rec && rec.takenBack === i.scheduleId
        : !!rec && rec.status === 'drafted' && !rec.scheduleId;
      if (i.type === 'first' && takenBack)
        Object.assign(i, { status: 'ready', outcome: '', error: '', scheduleId: '', sendAt: 0, ...doubtBack(i) });
      else if (!at || at <= Date.now())
        Object.assign(i, { status: 'sent', outcome: at ? `Sent ${day(at)}.` : 'Sent.', error: '', before: null });
      else continue;
      changed.push(i);
      continue;
    }
    const why = alreadyDone(i, rec);
    if (i.status === 'elsewhere') {
      // Still done, perhaps for another reason now (Closed, then set to Sent: written to after all).
      if (why && why !== i.outcome && Object.values(DONE).includes(i.outcome)) {
        i.outcome = why;
        changed.push(i);
      }
      if (why || (i.type === 'first' && !rec)) continue;
      Object.assign(i, i.body ? { status: 'ready', outcome: '' } : { status: 'waiting', held: true, outcome: '' });
      changed.push(i);
      continue;
    }
    if (FINISHED.has(i.status) || MOVING.has(i.status) || i.status === 'preparing' || !why) continue;
    finishElsewhere(i, why);
    changed.push(i);
  }
  if (changed.length || copied) saveQueue();
  whenDue();
  return changed;
}

/**
 * With the page left open: the queue looked at again when the next email waiting for their morning goes (so it stops
 * saying "Arrives…"), and when one the page closed on is due to be in Sent.
 */
function whenDue() {
  clearTimeout(whenDue.timer);
  const now = Date.now();
  const times = review.items.flatMap((i) =>
    [i.status === 'scheduled' ? goesAt(i) : 0, i.lookFor && !MOVING.has(i.status) ? i.lookFor.at : 0].filter(
      (t) => t > now,
    ),
  );
  if (!times.length) return;
  // A minute past its time, so Nylas has sent it; no further ahead than an hour at once (a timer's own limit). Only
  // what the page closed on is looked for: an email being sent now is this page's own.
  whenDue.timer = setTimeout(
    () => {
      afterReconcile(reconcileQueue());
      reconcileDelivering({ closed: false }).catch(() => null);
    },
    Math.min(Math.min(...times) - now + 60e3, 3600e3),
  );
}

/** An item done outside the queue (written to from the drawer or another tab, answered, followed up already). */
function finishElsewhere(item, why) {
  Object.assign(item, { status: 'elsewhere', outcome: why, armed: false, job: null });
}

/** Draw after the outreach records changed: the card again only if its own item did (another's never moves the cursor). */
const afterReconcile = (changed) => renderReview(changed.includes(shown()));

/**
 * Put firms in the queue (one already in it is shown instead; one already written to is left out, and said so) and
 * start preparing them. Called from a click, so Firefox's AI consent can be asked for here.
 */
function writeTo(firms, asked, again) {
  if (!aiReady()) return noAi();
  if (!asked) review.consent = requestAiConsent();
  // Pressed in a tab that doesn't have the queue: it's asked for first (handed over once nothing is being sent).
  if (!review.live) {
    const wait = 'Opening Review here: the other Discover tab hands it over once it has finished what it’s sending…';
    status(wait);
    return takeOver().then(() => {
      if ($('#status').textContent === wait) status('');
      writeTo(firms, true, again);
    });
  }
  // Asked again (Try someone else after a bounce): the firm's finished email makes way for a new one.
  if (again)
    review.items = review.items.filter(
      (i) => !(i.type === 'first' && firms.some((f) => f.id === i.id) && clearable(i)),
    );
  const added = [];
  const written = [];
  const closed = [];
  const writtenAt = writtenIndex();
  for (const firm of firms) {
    if (review.items.some((i) => i.id === firm.id)) continue;
    // Written to under another entry (a Hacker News post of a registry firm) counts, as on its card's button.
    const why =
      alreadyDone({ type: 'first' }, state.outreach[firm.id]) || (writtenTo(firm, writtenAt) ? DONE.written : '');
    if (why) {
      (why === DONE.dropped ? closed : written).push(firm.name);
      continue;
    }
    added.push({ id: firm.id, firm, type: 'first', status: 'waiting', step: '', hooks: [], hook: 0 });
  }
  review.items.push(...added);
  review.cleared = review.cleared.filter((id) => !added.some((i) => i.id === id));
  const first = added[0] ? added[0].id : firms.length === 1 ? firms[0].id : '';
  const index = review.items.findIndex((i) => i.id === first);
  if (index >= 0) review.at = index;
  const names = (list) => `${list.slice(0, 3).join(', ')}${list.length > 3 ? '…' : ''}`;
  if (written.length || closed.length)
    review.toast = {
      text: [
        written.length && `Already written to ${names(written)}: see the Outreach tab.`,
        closed.length && `${names(closed)}: Closed on the Outreach tab, so left out.`,
      ]
        .filter(Boolean)
        .join(' '),
    };
  pump(added[0]);
  saveQueue();
  showTab('review');
  renderReview(true);
  if (state.results.length) renderResults();
}

/** The next firms of the results to write to: not in the queue or cleared from it, not written to or saved as a draft. */
function nextToWrite(n = TOP) {
  const written = writtenIndex();
  return visible()
    .map((r) => r.firm)
    .filter((f) => {
      const rec = state.outreach[f.id];
      return (
        // Written to under another entry (its website matches), whatever "Hide firms I've written to" says.
        !writtenTo(f, written) &&
        !review.items.some((i) => i.id === f.id) &&
        !review.cleared.includes(f.id) &&
        !alreadyDone({ type: 'first' }, rec) &&
        !(rec && rec.draftId)
      );
    })
    .slice(0, n);
}

/** Carry on preparing what the page left waiting when it was closed (asked for: each one is an AI call or few). */
function resumeQueue(first) {
  if (!aiReady()) return noAi();
  review.consent = requestAiConsent();
  for (const i of review.items) i.held = i.moved = false;
  pump(first);
  renderReview(true);
}

/** Start preparing waiting items, four at a time: `first` (the one just asked for) first, then in queue order. */
function pump(first) {
  while (review.live && !review.leaving && review.busy < PREPARE_AT_ONCE) {
    const ok = (i) => i && i.status === 'waiting' && !i.held;
    const item = ok(first) ? first : review.items.find(ok);
    if (!item) break;
    review.busy++;
    prepare(item).finally(() => {
      review.busy--;
      pump();
      topUp();
    });
  }
  reviewCount();
}

/** Wait until `id` is no longer in `set` (a firm's check or search that something else started). */
async function settled(set, id) {
  while (set.has(id)) await new Promise((resolve) => setTimeout(resolve, 400));
}

/**
 * One item made ready: the firm checked, its people found, a reason to write looked for, the email drafted. Each run
 * owns the item while it runs (`job`): skipped meanwhile, it stops where it is, and what it was still waiting for is
 * dropped when it comes, so a draft can never land on an email being read, edited or sent.
 */
async function prepare(item) {
  const job = (item.job = {});
  review.running.set(item, job);
  item.status = 'preparing';
  item.error = '';
  const going = () => item.job === job && item.status === 'preparing';
  // Kept on the run too: picked up again after a skip, the card shows where it had got to.
  const step = (s) => {
    if (!going()) return;
    item.step = job.step = s;
    redraw(item);
  };
  try {
    if (!(await (review.consent || requestAiConsent()))) {
      // Refused: nothing more is prepared ahead until the next press asks again.
      review.consent = null;
      throw new Error('Firefox didn’t allow sending the firm’s name and your material to your AI provider.');
    }
    state.config = await store.discoverAiConfig();
    if (ai.problem(state.config)) throw new Error(`${ai.problem(state.config)} (Settings › Cover letters & AI)`);
    if (item.type === 'follow') {
      step('draft');
      await writeFollowUp(item, job);
      return;
    }
    const firm = item.firm;
    step('check');
    // A firm checked ahead of time whose site answered then has its site read again while the web is searched, not
    // before: the search starts from what the site showed then. (One whose site didn't answer may have moved, which
    // the search finds, and is checked again there.)
    const pre = state.checks[firm.id];
    const alongside = !!pre && pre.bundled && !['unreachable', 'none', 'blocked'].includes(pre.result.status);
    const checking = checkFirm(firm).catch(() => null);
    if (!alongside) await checking;
    // A check or search the firm's card started is waited for, not started again.
    if (!alongside) await settled(state.running, firm.id);
    if (!going()) return;
    if (canResearch() && !(state.research[firm.id] && state.research[firm.id].result)) {
      step('people');
      await researchFirm(firm, null);
    }
    await settled(state.researching, firm.id);
    await checking;
    await settled(state.running, firm.id);
    if (!going()) return;
    const people = writable(firm);
    const searchError = (state.research[firm.id] || {}).error;
    if (!people.length && searchError) throw new Error(`Couldn’t search the web for people: ${searchError}`);
    if (!people.length) {
      // Nothing to write to after the site and the web were both read: left out, and never offered again.
      item.status = 'skipped';
      item.nobody = true;
      item.outcome = 'No one to write to: its site and the web gave no address, so it’s left out.';
      review.cleared = [...new Set([...review.cleared, firm.id])].slice(-2000);
      return;
    }
    const sure = people.find((p) => !p.guessed && !['guessed', 'unconfirmed'].includes(p.level));
    choose(item, people.find((p) => sameAddress(p.address, item.to)) || sure || people[0]);
    if (canSearch() && H()) {
      step('hooks');
      const chosen = people.find((p) => sameAddress(p.address, item.to));
      let hookError = '';
      const hooks = await reasonsFor(firm, chosen, people).catch((err) => {
        hookError = errorText(err);
        return [];
      });
      if (!going()) return;
      Object.assign(item, { hooks, hook: hooks.length ? 0 : -1, hookError });
    } else item.hook = -1;
    if (!going()) return;
    step('draft');
    await writeDraft(item, job);
  } catch (err) {
    if (!going()) return;
    item.status = 'failed';
    item.error = errorText(err);
  } finally {
    if (review.running.get(item) === job) review.running.delete(item);
    // Only the run that still owns the item finishes it; one stopped (skipped, written again) leaves it as it is.
    if (item.job === job) {
      if (going()) item.status = item.body ? 'ready' : 'failed';
      landed(item);
      item.job = null;
      item.step = '';
      // Left out for having no one to write to while it was on screen: on to the next one to read.
      if (item.nobody && item.status === 'skipped' && shown() === item) advance();
      else redraw(item);
      saveQueue();
    }
  }
}

/**
 * A run's draft landing on a firm written to or answered while it was being written (another tab, the drawer): it isn't
 * offered to read, it's finished, as reconcileQueue() would have made it had it not been busy.
 */
function landed(item) {
  if (!['ready', 'failed'].includes(item.status)) return;
  const why = alreadyDone(item, state.outreach[item.firm.id]);
  if (why) finishElsewhere(item, why);
}

/** Everyone at the firm an email can go to: contactsOf(), less any address that bounced before. */
function writable(firm) {
  const bounced = new Set(((state.outreach[firm.id] || {}).bounced || []).map((a) => String(a).toLowerCase()));
  return contactsOf(firm).filter((p) => !bounced.has(p.address.toLowerCase()));
}

/** Who the item writes to, and how sure their address is, kept for when the firm's contacts change. */
function choose(item, p) {
  item.to = p.address;
  item.toLevel = p.level || (p.guessed ? 'guessed' : 'listed');
}

/**
 * Reasons to write to this firm (discoverHooks.find: common ground, their recent work, a way to show it, each borne
 * out by a source), best first for `contact`; kept for a week per firm, and looked for again when common ground is
 * switched on or off.
 */
async function reasonsFor(firm, contact, people) {
  const common = settingOf('commonGround', false) === true;
  const named = people.filter((p) => p.name);
  const ref = (p) => ({ name: p.name, title: p.title || '', address: p.address, kind: p.kind || '' });
  const to = contact && contact.name ? ref(contact) : null;
  let cached = state.hooks[firm.id];
  if (!cached || Date.now() - cached.at > HOOK_AGE || cached.common !== common) {
    const { profile } = await store.getActive();
    const result = await H().find((messages, options) => ai.search(state.config, { messages, ...options }), {
      firm: nowAt(firm),
      contact: to,
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
  return H().rank((cached.result && cached.result.hooks) || [], { contact: to });
}

/** Does this run still own the item, still being prepared (not skipped, stopped, or taken over by another run)? */
const owns = (item, job) => item.job === job && item.status === 'preparing';

/**
 * The item's email written (again) for whoever it goes to, with the reason chosen and the ask chosen; put on the item
 * only if the run that asked for it still owns it.
 */
async function writeDraft(item, job) {
  const firm = item.firm;
  const people = writable(firm);
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
  if (!owns(item, job)) return;
  choose(item, contact);
  Object.assign(item, {
    draftedFor: { address: contact.address, hook: item.hook, ask },
    role: r.kind === 'role' ? role : '',
    subject: r.subject || '',
    body: r.body || '',
    result: { ok: r.ok, checks: r.checks },
    usage: usageLine(state.config, r.usage),
    thin: !O.material({ profile, kit, cvText }).ok,
    // A doubt about an earlier copy (it may have gone, or be in drafts) stays: a new draft doesn't settle it.
    error: '',
    status: 'ready',
  });
  // The stored record, not this page's copy: another tab or the drawer may have sent to this firm meanwhile.
  const old = (await store.getOutreach())[firm.id];
  if (old) state.outreach[firm.id] = old;
  if (!old || old.status === 'drafted')
    await setOutreach(firm, {
      status: 'drafted',
      to: contact.address,
      subject: item.subject,
      contact: contactRef(contact),
      way: wayText(firm),
    });
}

/** A follow-up, in the same thread, to an email sent from here that has had no reply (kept only by its own run). */
async function writeFollowUp(item, job) {
  const rec = state.outreach[item.firm.id];
  const why = alreadyDone(item, rec);
  if (why) throw new Error(why);
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
  if (!owns(item, job)) return;
  Object.assign(item, {
    to: rec.to,
    subject: r.subject || '',
    body: r.body || '',
    result: { ok: r.ok, checks: r.checks },
    usage: usageLine(state.config, r.usage),
    error: '',
    status: 'ready',
  });
}

/** Emails sent from here five working days ago without a reply or a follow-up: put in the queue on request. */
// Not one already in the queue (finished or not), nor one skipped for that same email.
function followUpsDue() {
  if (!O.dueFollowUps) return [];
  return O.dueFollowUps(state.outreach, Date.now()).filter(
    (d) => !review.items.some((i) => i.id === `${d.id}:follow`) && review.declined[d.id] !== d.rec.sentAt,
  );
}

function queueFollowUps() {
  if (!aiReady()) return noAi();
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
  pump(items[0]);
  saveQueue();
  renderReview(true);
}

/* review: actions */

/** Show the next item that needs reading (after this one, then from the top), or the summary when none does. */
function advance() {
  const n = review.items.length;
  for (let k = 1; k <= n; k++) {
    const i = (review.at + k) % n;
    const s = review.items[i].status;
    if (!FINISHED.has(s) && !MOVING.has(s)) {
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
  // Kept a moment later (a page closing can't wait for storage), so a reload opens on the card being read.
  saveQueue(true);
}

/** Go to an item (Undo, Show it, Read them). */
function showItem(item) {
  const i = review.items.indexOf(item);
  if (i < 0) return;
  review.at = i;
  renderReview(true);
  saveQueue(true);
}

/** The press is for this card only when the card has been showing for a moment (a double or held press isn't). */
const freshCard = () => Date.now() - review.shownAt < FRESH_MS;

/** Let go of the run preparing an item: what it's still waiting for is dropped when it comes. */
function stopRun(item) {
  item.job = null;
  item.step = '';
}

/**
 * What makes a send worth a second press: an address made from a format (or no longer among the firm's contacts), a
 * draft that failed a check, a draft written for another person, reason or ask, or a CV the email mentions but that
 * isn't uploaded.
 */
function doubtsOf(item) {
  const first = item.type === 'first';
  const p = first ? contactsOf(item.firm).find((x) => sameAddress(x.address, item.to)) : null;
  const level = p ? p.level || (p.guessed ? 'guessed' : 'listed') : item.toLevel;
  return [
    first && ['likely', 'guessed', 'unconfirmed'].includes(level)
      ? `${item.to} is made from the firm’s address format, not seen written anywhere: it may bounce.`
      : '',
    first && !p ? `${item.to} is no longer among the firm’s contacts found: check it before sending.` : '',
    item.result && item.result.ok === false
      ? 'Some of the draft’s checks failed (listed above): read it through first.'
      : '',
    item.draftedFor &&
    (!sameAddress(item.draftedFor.address, item.to) ||
      item.draftedFor.hook !== item.hook ||
      item.draftedFor.ask !== askChoice())
      ? 'You changed who it goes to, the reason or the ask since it was written: press Write it again first, or send it as it is.'
      : '',
    first && !state.cvName && /\bCV\b|résumé|resume|attached/i.test(item.body)
      ? 'The email says your CV is attached, but none is uploaded (Settings › Resume & files): it goes without one.'
      : '',
    item.unsure || '',
  ].filter(Boolean);
}

/** When the email would arrive: { at (ms, or null for now), local ("Mon 08:10 in London") }. */
function arrival(item) {
  if (!settingOf('theirMorning', true) || !O.sendTime) return { at: null, local: '' };
  return O.sendTime(item.firm, Date.now()) || { at: null, local: '' };
}

/**
 * Send: a doubtful email takes a second press, a moment after the first; then it goes in five seconds unless Undo is
 * pressed. One written to meanwhile (another tab, the drawer) isn't sent again.
 */
function sendItem(item) {
  if (frozen()) return;
  if (!item || item.status !== 'ready' || shown() !== item || freshCard()) return;
  const why = alreadyDone(item, state.outreach[item.firm.id]);
  if (why) {
    finishElsewhere(item, why);
    alarm(`${item.firm.name}: ${why} ${notAgain(why, 'sent')}`, item);
    saveQueue();
    return advance();
  }
  if (doubtsOf(item).length && !item.armed) {
    item.armed = true;
    item.armedAt = Date.now();
    return renderReview(true);
  }
  if (item.armed && Date.now() - item.armedAt < FRESH_MS) return;
  item.armed = false;
  item.status = 'sending';
  item.error = '';
  review.pending.set(item.id, {
    item,
    timer: setTimeout(() => {
      review.pending.delete(item.id);
      deliver(item);
    }, UNDO_MS),
  });
  saveQueue();
  advance();
}

/** Undo: an email still in its five seconds (the latest, by default) goes back to being read, and is shown. */
function undoSend(id) {
  // A double click on the toast's Undo (redrawn for the email before) undoes one email, not two.
  if (Date.now() - review.undoneAt < FRESH_MS) return;
  const all = [...review.pending.values()];
  const p = id ? review.pending.get(id) : all[all.length - 1];
  if (!p) {
    if (review.items.some((i) => i.status === 'delivering')) {
      review.toast = { text: 'Too late to undo: it’s with your inbox now.' };
      renderReview();
    }
    return;
  }
  clearTimeout(p.timer);
  review.pending.delete(p.item.id);
  review.undoneAt = Date.now();
  p.item.status = 'ready';
  review.toast = { text: `Not sent to ${p.item.to}.` };
  saveQueue();
  showItem(p.item);
}

/** The fields an outreach record keeps of an email sent from Review (and what "What gets replies" counts). */
function sentFields(item, p) {
  const used = item.draftedFor ? item.draftedFor.hook : item.hook;
  const hook = used >= 0 ? (item.hooks || [])[used] : null;
  return {
    to: item.to,
    subject: item.subject,
    body: item.body,
    contact: contactRef(p && p.address ? p : { address: item.to }),
    way: wayText(item.firm),
    reason: hook ? hook.label : '',
    reasonKind: hook ? hook.kind : 'none',
    ask: (item.draftedFor && item.draftedFor.ask) || askChoice(),
    role: item.role || '',
    followedUpAt: null,
    followUps: 0,
  };
}

/**
 * The email sent from the connected inbox (CV attached to a first email; a follow-up goes in the same thread), after
 * one more look at the stored record. It's marked as with Nylas first, so a page closed meanwhile looks for it in Sent
 * when it opens again rather than offering it twice.
 */
async function deliver(item) {
  const firm = item.firm;
  const follow = item.type === 'follow';
  const when = arrival(item);
  // Scheduled, it isn't in Sent until it goes: a page closed meanwhile can't look for it there. What's handed over is
  // kept as it is, so one found in Sent later is recorded as it went, not as the draft has been rewritten since.
  Object.assign(item, {
    status: 'delivering',
    deliverFrom: Date.now(),
    scheduling: !!when.at,
    deliverAt: when.at || 0,
    handed: sentFields(item, contactsOf(firm).find((x) => sameAddress(x.address, item.to)) || {}),
  });
  review.delivering.add(item);
  saveQueue();
  redraw(item);
  try {
    const rec = (await store.getOutreach())[firm.id];
    if (rec) state.outreach[firm.id] = rec;
    else delete state.outreach[firm.id];
    const why = alreadyDone(item, rec);
    if (why) {
      finishElsewhere(item, why);
      // Kept until read: the next email's Undo or "Sent" would hide it, and the person thinks this one went.
      alarm(`${firm.name}: ${why} ${notAgain(why, 'sent')}`, item);
      return;
    }
    const nylas = await store.getNylas();
    if (!nylas || !nylas.grantId) throw new Error('Connect your inbox first (Settings › Email codes).');
    const cv = follow ? null : await cvFile();
    const p = contactsOf(firm).find((x) => sameAddress(x.address, item.to)) || {};
    const name = p.name || (follow && rec && rec.contact && rec.contact.name) || '';
    const email = {
      to: [{ email: item.to, ...(name ? { name } : {}) }],
      subject: item.subject,
      text: item.body,
      attachments: cv ? [{ name: cv.name, dataUrl: cv.dataUrl }] : [],
      ...(follow && rec && rec.messageId ? { replyTo: rec.messageId } : {}),
      ...(when.at ? { sendAt: when.at } : {}),
    };
    const r = await N.send(nylas, email, { fetch: fetchFn });
    // Nylas sends one due within two minutes straight away: only a schedule id says it waits.
    const later = !!r.scheduleId;
    const at = later ? r.sendAt || when.at : Date.now();
    item.status = later ? 'scheduled' : 'sent';
    // A copy the page closed on may still be at Nylas too: that doubt comes back if this one is taken back.
    const before = later && (item.unsure || item.lookFor) ? { unsure: item.unsure, lookFor: item.lookFor } : null;
    Object.assign(item, { unsure: '', lookFor: null, error: '', before, scheduleId: later ? r.scheduleId : '' });
    item.sendAt = later ? at : 0;
    settle(item);
    item.outcome = later
      ? `Arrives ${when.local}${cv ? `, ${cv.name} attached` : ''}. Until then it waits at Nylas.`
      : `Sent${cv ? `, ${cv.name} attached` : ''}. It’s in your Sent folder.`;
    if (follow) await setOutreach(firm, { followedUpAt: at, followUps: ((rec && rec.followUps) || 0) + 1 });
    else
      await setOutreach(firm, {
        status: 'sent',
        ...sentFields(item, p),
        via: 'nylas',
        // A scheduled email has no message id until it goes: checkReplies() finds it in Sent then. One sent again
        // (after a bounce) starts its five working days again.
        messageId: r.id || '',
        threadId: r.threadId || '',
        sentAt: at,
        sendAt: later ? at : null,
        scheduleId: later ? r.scheduleId : '',
      });
    review.toast = {
      text: `${follow ? 'Follow-up' : 'Email'} to ${firm.name}: ${item.outcome}`,
      ...(later && !follow ? { takeBack: item.id } : {}),
    };
  } catch (err) {
    item.status = 'ready';
    item.error = `Not sent: ${errorText(err)}`;
    alarm(`Couldn’t send to ${firm.name}: ${errorText(err)}`, item);
    // Nothing else to read: show it straight away.
    if (!shown()) review.at = review.items.indexOf(item);
  } finally {
    review.delivering.delete(item);
    redraw(item);
    saveQueue();
    // One fewer ready: the next is prepared now, so it's there when this one has gone.
    topUp();
  }
}

/**
 * An item's line on what went wrong, changed where its card shows it rather than by drawing the card again: its email
 * may be being typed in. The card is taken as drawn with it, so no later redraw happens for the wording alone.
 */
function reword(item, error) {
  const was = item.error;
  item.error = error;
  if (shown() !== item || !review.live) return;
  const line = [...document.querySelectorAll('#review-card p.error')].find((p) => p.textContent === was);
  if (!line) return;
  line.textContent = error;
  if (review.drawn === cardKey({ ...item, error: was })) review.drawn = cardKey(item);
}

/** What the card says about an email the page closed on as it went: why Sent couldn't be looked in (`failed`), if so. */
const closedText = (failed) =>
  `The page closed while this was being sent, and ${
    failed ? `your Sent folder couldn’t be checked (${failed})` : 'it isn’t in your Sent folder yet'
  }: look there before sending it again.`;

/**
 * Items the page was handing to Nylas when it closed: sent if Sent has them (and recorded as they went), else back to
 * read with a word to look in Sent first, and looked for again on later visits (one scheduled for their morning once
 * that has come), so an email that did go is recorded, followed up and watched for replies like any other. `closed`
 * false (the page's own timer): only those looked for again, never an email this page is sending now.
 */
async function reconcileDelivering({ closed = true } = {}) {
  if (!review.live) return;
  const now = Date.now();
  const stuck = closed ? review.items.filter((i) => i.status === 'delivering' && !review.delivering.has(i)) : [];
  const lost = review.items.filter((i) => i.lookFor && !MOVING.has(i.status) && i.lookFor.at <= now);
  if (!stuck.length && !lost.length) return;
  const nylas = state.nylas;
  const changed = [];
  for (const i of [...stuck, ...lost]) {
    const mine = stuck.includes(i);
    const q = mine
      ? {
          to: i.to,
          subject: i.subject,
          after: i.deliverFrom || 0,
          at: i.scheduling ? i.deliverAt || 0 : 0,
          fields: i.handed || null,
        }
      : i.lookFor;
    // Couldn't look (no inbox now, Nylas down) isn't "not there": the looking goes on.
    let m = null;
    let failed = '';
    if (!(nylas && nylas.grantId && N.sentMessage)) failed = 'no inbox is connected';
    else
      m = await N.sentMessage(nylas, { to: q.to, subject: q.subject, after: q.after, fetch: fetchFn }).catch((err) => {
        failed = (errorText(err) || 'Nylas didn’t answer').replace(/\.$/, '');
        return null;
      });
    // What the person did meanwhile wins: an item they're sending or saving now is theirs.
    if (mine ? i.status !== 'delivering' || review.delivering.has(i) : MOVING.has(i.status) || i.lookFor !== q)
      continue;
    if (!m && !mine) {
      // Looked at since it couldn't be (Nylas back, an inbox connected), or the other way round: the card says what
      // the latest check found, reworded where it's shown (never by drawing the card, and the email being typed in,
      // again), and how long it's looked for follows it.
      if (!!q.unchecked !== !!failed) {
        if (i.error === closedText(q.unchecked || '')) reword(i, closedText(failed));
        i.lookFor = { ...q, unchecked: failed };
      }
      // Not there days after its time: it didn't go. The doubt stays; the looking stops (after a month, if it can't look).
      if (now - Math.max(q.at, q.after) > (failed ? 10 : 1) * LOOK_FOR_MS) i.lookFor = null;
      continue;
    }
    changed.push(i);
    if (!m) {
      // One being scheduled for their morning isn't in Sent until then: it may be waiting at Nylas.
      Object.assign(
        i,
        i.scheduling
          ? {
              status: 'ready',
              error:
                'The page closed while this was being scheduled for their morning: it may be waiting at Nylas to go then.',
              unsure:
                'It may already be waiting at Nylas for their morning: sending it again could send it twice. After their morning, look in your Sent folder first.',
            }
          : {
              status: 'ready',
              error: closedText(failed),
              unsure: 'It may have gone already: look in your Sent folder before sending it again.',
            },
        { lookFor: failed ? { ...q, unchecked: failed } : q },
      );
      continue;
    }
    const at = m.date ? m.date * 1000 : q.at || q.after || now;
    // Found: sent, whatever the item was doing since (still to read, skipped, saved to drafts: that copy would be a
    // second one, Closed by hand meanwhile: it went all the same); one finished another way stays so.
    const dropped = i.status === 'elsewhere' && i.outcome === DONE.dropped;
    if (mine || !FINISHED.has(i.status) || i.status === 'skipped' || i.status === 'saved' || dropped)
      Object.assign(i, {
        status: 'sent',
        outcome: mine
          ? 'Sent (the page closed as it went).'
          : `Sent ${day(at)}: found in your Sent folder.${
              i.status === 'saved' ? ' The copy saved to your drafts would be a second one: delete it there.' : ''
            }`,
        armed: false,
      });
    Object.assign(i, { unsure: '', error: '', lookFor: null });
    stopRun(i);
    const rec = state.outreach[i.firm.id];
    // A follow-up is noted on its firm's record, if that's still there: one removed on Outreach isn't made again as a
    // nameless Drafted one.
    const message = { to: q.to, subject: q.subject, via: 'nylas', messageId: m.id, threadId: m.threadId };
    const done = alreadyDone(i, rec);
    if (i.type === 'follow') {
      if (rec) await setOutreach(i.firm, { followedUpAt: at, followUps: (rec.followUps || 0) + 1 });
    } else if (!done)
      await setOutreach(i.firm, {
        status: 'sent',
        ...(q.fields || sentFields(i, {})),
        ...message,
        sentAt: at,
        sendAt: null,
        scheduleId: '',
      });
    // Closed by hand before it was found: still Closed, but written to, and when (left out of searches as such).
    else if (done === DONE.dropped) await setOutreach(i.firm, { ...message, sentAt: at, sendAt: null, scheduleId: '' });
  }
  saveQueue();
  if (changed.length) renderReview(changed.includes(shown()));
  whenDue();
}

/** A first email waiting for their morning, taken back: Nylas deletes it, and it's back to read and send again. */
async function takeBack(item) {
  if (frozen()) return;
  const s = schedule(item);
  // A second click while the first is with Nylas would be told the email is gone: it's been taken back.
  if (!s.id || item.takingBack) return;
  item.takingBack = true;
  renderReview(shown() === item);
  try {
    const nylas = await store.getNylas();
    await N.cancelScheduled(nylas, s.id, { sendAt: s.at, fetch: fetchFn });
    // Its own record only, while it still describes this email (stamped, so another tab takes it back too): its
    // schedule goes, and Sent with it; a Closed stays Closed. One sent since (from the drawer: it has a message of its
    // own) or made again is another email's, left as it is.
    let other = false;
    const rec = await setOutreach(item.firm, (old) => {
      if (!old || old.scheduleId !== s.id) return null;
      if (old.messageId) return void (other = old.status !== 'drafted');
      return {
        status: old.status === 'sent' ? 'drafted' : old.status,
        sentAt: null,
        sendAt: null,
        scheduleId: '',
        takenBack: s.id,
      };
    });
    // Remembered on the item too: Undo on a firm removed from Outreach meanwhile doesn't bring this email back.
    Object.assign(item, { status: 'ready', outcome: '', error: '', scheduleId: '', sendAt: 0, takenBack: s.id });
    Object.assign(item, doubtBack(item));
    if (other || alreadyDone(item, rec)) finishElsewhere(item, alreadyDone(item, rec) || DONE.written);
    review.toast = {
      text: item.lookFor
        ? `Taken back: this copy to ${item.firm.name} won’t be sent, but the one the page closed on may still go.`
        : `Taken back: the email to ${item.firm.name} won’t be sent.`,
      show: item.id,
    };
    settle(item);
    // Nothing else to read: show it straight away.
    if (!shown()) review.at = review.items.indexOf(item);
  } catch (err) {
    // Said on its card too: the email still goes at its time. Kept above other alerts until read.
    item.error = `Not taken back: ${errorText(err)}`;
    alarm(`Couldn’t take back the email to ${item.firm.name}: ${errorText(err)}`, item, true);
  }
  item.takingBack = false;
  redraw(item);
  saveQueue();
}

/** A scheduled first email's schedule at Nylas: its own (an older version's item, its record's until copied). */
function schedule(item) {
  if (item.type !== 'first' || item.status !== 'scheduled') return {};
  if (item.scheduleId) return { id: item.scheduleId, at: item.sendAt || 0 };
  const rec = state.outreach[item.firm.id];
  return rec ? { id: rec.scheduleId || '', at: rec.sendAt || 0 } : {};
}

/** Can a scheduled email still be taken back (Nylas needs a minute's notice)? */
const canTakeBack = (item) => {
  const s = schedule(item);
  return !!s.id && s.at - Date.now() > 60e3;
};

/** Save to the connected inbox's drafts, to send from there (a follow-up in the first email's thread). */
async function saveItem(item) {
  if (frozen()) return;
  if (!item || item.status !== 'ready' || freshCard()) return;
  item.status = 'saving';
  // Saved straight away: a page closed before Nylas answers says the draft may be there already.
  saveQueue();
  redraw(item);
  try {
    // The stored record, as for a send: one written to meanwhile (another tab, the drawer) keeps its Sent.
    const stored = (await store.getOutreach())[item.firm.id];
    if (stored) state.outreach[item.firm.id] = stored;
    else delete state.outreach[item.firm.id];
    const why = alreadyDone(item, stored);
    if (why) {
      finishElsewhere(item, why);
      alarm(`${item.firm.name}: ${why} Not saved to your drafts.`, item);
      if (shown() === item) advance();
      else renderReview();
      return saveQueue();
    }
    const nylas = await store.getNylas();
    if (!nylas || !nylas.grantId) throw new Error('Connect your inbox first (Settings › Email codes).');
    const follow = item.type === 'follow';
    const cv = follow ? null : await cvFile();
    const rec = state.outreach[item.firm.id];
    const r = await N.saveDraft(
      nylas,
      {
        ...(follow && rec && rec.messageId ? { replyTo: rec.messageId } : {}),
        to: [{ email: item.to }],
        subject: item.subject,
        text: item.body,
        attachments: cv ? [{ name: cv.name, dataUrl: cv.dataUrl }] : [],
      },
      { fetch: fetchFn },
    );
    item.status = 'saved';
    item.unsure = '';
    settle(item);
    item.outcome = `Saved to your drafts${cv ? `, ${cv.name} attached` : ''}.`;
    if (follow) await setOutreach(item.firm, { followedUpAt: Date.now(), followUpDraftId: r.id });
    else
      await setOutreach(item.firm, {
        status: 'drafted',
        to: item.to,
        subject: item.subject,
        draftId: r.id,
        via: 'nylas',
      });
    // On only if it's still the card shown: the person may have moved on while it saved.
    if (shown() === item) advance();
    else renderReview();
  } catch (err) {
    item.status = 'ready';
    item.error = `Not saved: ${errorText(err)}`;
    // As a failed send: kept until read, and shown straight away when there's nothing else to read.
    alarm(`Couldn’t save the email to ${item.firm.name} to your drafts: ${errorText(err)}`, item);
    if (!shown()) review.at = review.items.indexOf(item);
    redraw(item);
  }
  saveQueue();
}

/** Without an inbox connected: the person sent it from their own email program and says so. */
async function markSent(item) {
  if (frozen()) return;
  if (!item || item.status !== 'ready' || freshCard()) return;
  // One written to meanwhile keeps its record (its address, date and follow-ups): it isn't marked again.
  const why = alreadyDone(item, state.outreach[item.firm.id]);
  if (why) {
    finishElsewhere(item, why);
    alarm(`${item.firm.name}: ${why} ${notAgain(why, 'marked')}`, item);
    saveQueue();
    return shown() === item ? advance() : renderReview();
  }
  // Marked by the person themselves: no copy the page closed on is looked for any more.
  Object.assign(item, { status: 'sent', outcome: 'Marked as sent.', unsure: '', lookFor: null, before: null });
  if (item.type === 'follow') await setOutreach(item.firm, { followedUpAt: Date.now() });
  else
    await setOutreach(item.firm, {
      status: 'sent',
      ...sentFields(
        item,
        contactsOf(item.firm).find((x) => sameAddress(x.address, item.to)),
      ),
      via: 'mailto',
      sentAt: Date.now(),
      sendAt: null,
      scheduleId: '',
    });
  if (shown() === item) advance();
  saveQueue();
}

/**
 * Skip: a firm waiting, being prepared, ready or that needs you; never one sent or on its way, nor the card after
 * this one (a second press straight after). Its preparation stops; a skipped follow-up isn't offered again.
 */
function skipItem(item) {
  if (frozen()) return;
  if (!item || !['waiting', 'preparing', 'ready', 'none', 'failed'].includes(item.status) || freshCard()) return;
  stopRun(item);
  item.status = 'skipped';
  item.armed = false;
  const rec = state.outreach[item.firm.id];
  if (item.type === 'follow' && rec && rec.sentAt) review.declined[item.firm.id] = rec.sentAt;
  advance();
  saveQueue();
  topUp();
}

/**
 * Back from skipped: read it after all (or prepare it, if it never was), unless it was written to meanwhile. A run
 * still going for it carries on (it isn't started twice), and its draft is the one shown.
 */
function unskip(item) {
  if (frozen()) return;
  delete review.declined[item.firm.id];
  item.nobody = false;
  const why = alreadyDone(item, state.outreach[item.firm.id]);
  if (why) {
    finishElsewhere(item, why);
    saveQueue();
    return renderReview(true);
  }
  const live = review.running.get(item);
  if (live) Object.assign(item, { job: live, status: 'preparing', held: false, moved: false, step: live.step || '' });
  else {
    item.status = item.body ? 'ready' : 'waiting';
    item.held = item.moved = false;
    if (item.status === 'waiting') {
      if (!aiReady()) return noAi();
      review.consent = requestAiConsent();
      pump(item);
    }
  }
  renderReview(true);
  saveQueue();
}

/**
 * Write it again stopped: the email as it was (with the person's edits) is kept, and the new one dropped when it comes;
 * finished instead if the firm was written to or answered meanwhile, as the rewrite landing would have been. Taken
 * however soon after the card showed: it only ever keeps an email, never sends one.
 */
function keepDraft(item) {
  if (frozen()) return;
  if (!item || item.status !== 'preparing' || !item.body) return;
  stopRun(item);
  review.running.delete(item);
  item.status = 'ready';
  landed(item);
  renderReview(true);
  saveQueue();
}

/** Try again after a failure, from the click (so Firefox can ask). */
function retry(item) {
  if (frozen()) return;
  if (!aiReady()) return noAi();
  review.consent = requestAiConsent();
  Object.assign(item, { status: 'waiting', held: false, moved: false, error: '' });
  pump(item);
  renderReview(true);
}

/** Write it again for whoever it now goes to, with the reason and ask now chosen (asked from the click or key). */
async function redraft(item) {
  if (frozen()) return;
  if (!item || !['ready', 'failed'].includes(item.status)) return;
  if (!aiReady()) return noAi();
  const consent = requestAiConsent();
  const job = (item.job = { step: 'draft' });
  review.running.set(item, job);
  Object.assign(item, { status: 'preparing', step: 'draft', armed: false });
  redraw(item);
  try {
    if (!(await consent)) throw new Error('Firefox didn’t allow sending your material to your AI provider.');
    state.config = await store.discoverAiConfig();
    if (item.type === 'follow') await writeFollowUp(item, job);
    else await writeDraft(item, job);
  } catch (err) {
    // The email as it was stays, with why it wasn't written again.
    if (owns(item, job)) Object.assign(item, { status: item.body ? 'ready' : 'failed', error: errorText(err) });
  } finally {
    if (review.running.get(item) === job) review.running.delete(item);
    if (item.job === job) {
      if (owns(item, job)) item.status = item.body ? 'ready' : 'failed';
      landed(item);
      Object.assign(item, { job: null, step: '' });
      redraw(item);
      saveQueue();
    }
  }
}

/** Someone else at the firm: the next contact, greeted by name (Write it again for a draft made for them). */
function otherContact(item) {
  if (frozen()) return;
  if (!item || item.status !== 'ready' || item.type === 'follow') return;
  const people = writable(item.firm);
  if (people.length < 2) return;
  const i = people.findIndex((p) => sameAddress(p.address, item.to));
  const p = people[(i + 1) % people.length];
  choose(item, p);
  item.body = withGreeting(item.body, greetingFor(p, item.firm));
  item.armed = false;
  renderReview(true);
  saveQueue();
}

/** Another reason to write, or none ("the email opens with what the firm does"), in turn. */
function otherHook(item) {
  if (frozen()) return;
  if (!item || item.status !== 'ready' || !(item.hooks || []).length) return;
  item.hook = item.hook + 1 >= item.hooks.length ? -1 : item.hook + 1;
  item.armed = false;
  renderReview(true);
  saveQueue();
}

/** Can this page send or save through Nylas, or only open the email program (no inbox, or one for codes only)? */
function mailOnly() {
  const n = state.nylas;
  if (!n || !n.grantId) return true;
  const a = review.abilities;
  return !!a && !a.send && !a.draft;
}

/** What Ctrl+Enter does: send, or save to drafts when the inbox can't send, or open the email program. */
async function primaryAction(item) {
  if (frozen()) return;
  if (!item || item.status !== 'ready' || freshCard()) return;
  if (mailOnly()) {
    const a = document.querySelector('#review-card .open-mail');
    if (a) a.click();
    return;
  }
  const can = await inboxAbilities();
  if (can.send) sendItem(item);
  else if (can.draft) saveItem(item);
}

function reviewKeys(e) {
  if ($('#review-view').hidden || frozen()) return;
  const send = (e.ctrlKey || e.metaKey) && e.key === 'Enter';
  // Keys are letters while the cursor is in a box; a tick box or a choice above the queue just had the last click.
  const typing =
    e.target.closest &&
    e.target.closest('textarea, select, [contenteditable="true"], input:not([type="checkbox"]):not([type="radio"])');
  const guarded = !typing && review.dropped && Date.now() - review.typedAt < TYPING_MS;
  // A held key is one press: it never sends the next card or says yes to a doubt. Held in a box (Backspace) it's
  // typing until it's let go, so the pause below counts from then; never a held Ctrl+Enter, whose U after is an Undo.
  if (e.repeat) {
    if (send) e.preventDefault();
    else if (typing || guarded) review.typedAt = Date.now();
    return;
  }
  // The box typed in drawn away mid-word (its email finished elsewhere, a reply came): the rest of the sentence isn't
  // commands ("j" of "job" moving to the next firm, "e" typing into its email, "r" writing it again). Every key goes on
  // being typing until a pause (a Shift, Ctrl+Backspace, an AltGr "é" or a Mac Option key too), Escape ending it at
  // once. A send from the box clears the clock (typedAt), so the U or S straight after one is a command. The first U
  // while an email waits out its five seconds is Undo: a stray one brings an email back to send again, a swallowed one
  // lets it go; it counts as typing too, so the "ld" of "would" still is.
  if (!typing && review.dropped) {
    // One per stretch of typing: the next "u" (of "you") is typing again, not a second email brought back.
    const u = e.key.toLowerCase() === 'u' && !(e.ctrlKey || e.metaKey || e.altKey);
    if (guarded && u && review.pending.size && !review.undidTyping) {
      e.preventDefault();
      review.typedAt = Date.now();
      review.undidTyping = true;
      return undoSend();
    }
    if (e.key !== 'Escape' && guarded) {
      review.typedAt = Date.now();
      if (e.key !== 'Tab') e.preventDefault();
      return;
    }
    review.dropped = review.undidTyping = false;
    if (e.key === 'Escape') return;
  }
  const item = shown();
  if (send) {
    e.preventDefault();
    // A command, not typing: the card it draws away (sent, or a doubt raised) was the person's own doing, so the keys
    // after it (U for Undo, S, a second Ctrl+Enter for Send anyway) are commands too.
    review.typedAt = 0;
    primaryAction(item);
    return;
  }
  if (typing) {
    review.dropped = false;
    if (e.key === 'Escape') e.target.blur();
    else review.typedAt = Date.now();
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
  const people = item.type === 'follow' ? [] : writable(item.firm);
  const p =
    people.find((x) => sameAddress(x.address, item.to)) ||
    contactsOf(item.firm).find((x) => sameAddress(x.address, item.to));
  const rec = state.outreach[item.firm.id];
  const name = p ? whoLabel(p) : (rec && rec.contact && rec.contact.name) || '';
  const level = p || (item.type === 'first' && item.toLevel ? { level: item.toLevel } : null);
  return el(
    'div',
    { className: 'to-line' },
    el('span', { className: 'muted', textContent: 'To' }),
    el('strong', { textContent: name || item.to }),
    name ? el('span', { className: 'address', textContent: item.to }) : null,
    level ? levelPill(level) : null,
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
      el('h2', { textContent: firm.name, tabIndex: -1 }),
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

/** The email as the email program gets it, from what's in the boxes now. */
const mailtoOf = (item) => O.mailto({ to: item.to, subject: item.subject, body: item.body });

/** The big buttons: Send (or Save to drafts, or Open in your email app) and the rest. */
function reviewActions(item) {
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
  if (mailOnly()) {
    const copied = el('span', { className: 'small muted', attrs: { 'aria-live': 'polite' } });
    return el(
      'div',
      { className: 'review-actions' },
      el('a', {
        className: 'button primary big open-mail',
        href: mailtoOf(item).href,
        textContent: 'Open in your email app',
        title: 'Ctrl+Enter',
        // The link is made when it's clicked, so edits made since are in it; never for a firm written to or answered
        // meanwhile (another tab, the Outreach tab), which the email app would get a second email to.
        onclick: (e) => {
          const why = alreadyDone(item, state.outreach[item.firm.id]);
          if (!why) return (e.currentTarget.href = mailtoOf(item).href);
          e.preventDefault();
          finishElsewhere(item, why);
          alarm(`${item.firm.name}: ${why} ${notAgain(why, 'opened')}`, item);
          saveQueue();
          return shown() === item ? advance() : renderReview();
        },
      }),
      el('button', {
        className: 'big',
        type: 'button',
        textContent: 'Copy',
        onclick: () =>
          navigator.clipboard
            .writeText(`${item.subject}\n\n${item.body}`)
            .then(() => (copied.textContent = 'Copied.'))
            .catch(() => (copied.textContent = 'Couldn’t copy: select the text and copy it.')),
      }),
      el('button', { className: 'big', type: 'button', textContent: 'Mark as sent', onclick: () => markSent(item) }),
      skip,
      again,
      copied,
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

/** One line under the buttons: from where, when it arrives, what's attached (or why only the email program will do). */
function sendNote(item) {
  const n = state.nylas;
  const settings = el('button', {
    className: 'link',
    type: 'button',
    textContent: 'Settings › Email codes',
    onclick: () => api.tabs.create({ url: api.runtime.getURL('options/options.html#email') }),
  });
  if (mailOnly()) {
    const long = el('p', {
      className: 'small warn-text truncated',
      hidden: !mailtoOf(item).truncated,
      textContent: 'Too long for your email app’s link: the end is cut off there, so use Copy for the whole text.',
    });
    return el(
      'div',
      { className: 'send-note' },
      n && n.grantId
        ? el(
            'p',
            { className: 'small warn-text' },
            'Your inbox is connected to Nylas for reading codes only. To send or save drafts from here, connect it again with permission to send and draft mail (',
            settings,
            ').',
          )
        : el(
            'p',
            { className: 'small muted' },
            'To send from here with your CV attached, connect your inbox under ',
            settings,
            '. Without it, your email program opens with the email written; attach your CV there.',
          ),
      long,
    );
  }
  const when = arrival(item);
  const cv =
    item.type === 'follow'
      ? 'no attachment (a reply in the same thread)'
      : state.cvName
        ? `${state.cvName} attached`
        : 'no CV uploaded yet (Settings › Resume & files)';
  return el('p', {
    className: 'small muted send-note',
    textContent: `From ${n.email || 'your inbox'} · ${when.at ? `arrives ${when.local}, as it’s outside their working day now` : 'sends now'} · ${cv}`,
  });
}

/** After typing: the saved queue, the box's height and, without an inbox, the long-link warning. */
function edited(item, box) {
  if (box.tagName === 'TEXTAREA') fitBox(box);
  const long = $('#review-card .truncated');
  if (long) long.hidden = !mailtoOf(item).truncated;
  saveQueue(true);
}

/** The card for an item, by how far it has got. */
function itemView(item) {
  const head = reviewHead(item);
  if (item.status === 'waiting' || item.status === 'preparing') {
    // Written again (Write it again): only the writing is redone, and the email as it was can be kept.
    const again = item.status === 'preparing' && !!item.body;
    const order = again
      ? [['draft', `Writing the ${item.type === 'follow' ? 'follow-up' : 'email'} again`]]
      : item.type === 'follow'
        ? [['draft', 'Writing the follow-up']]
        : STEPS;
    const at = order.findIndex(([k]) => k === item.step);
    const held = item.status === 'waiting' && (item.held || !review.busy);
    // Another firm really being prepared for the first time (not one written again, nor one waiting behind a skipped
    // firm's AI call still out).
    const others = review.items.some(
      (i) =>
        i !== item &&
        ((i.status === 'preparing' && !i.body && !!i.job) ||
          (i.status === 'waiting' && !i.held && review.busy < PREPARE_AT_ONCE)),
    );
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
      el(
        'div',
        { className: 'review-actions' },
        held
          ? el('button', {
              className: 'primary big',
              type: 'button',
              textContent: 'Prepare it',
              onclick: () => resumeQueue(item),
            })
          : null,
        again
          ? el('button', {
              className: 'big',
              type: 'button',
              textContent: 'Keep the one I had',
              // The second click of a double click on Write it again (at phone width this is under it) isn't a Keep.
              onclick: (e) => e.detail > 1 || keepDraft(item),
            })
          : el('button', {
              className: 'big',
              type: 'button',
              textContent: item.status === 'preparing' ? 'Stop and skip' : 'Skip',
              onclick: () => skipItem(item),
            }),
      ),
      el('p', {
        className: 'muted small',
        textContent: held
          ? item.moved
            ? 'Not prepared yet: it was being prepared in another Discover tab when Review moved here.'
            : 'Not prepared yet: the page was closed before its turn.'
          : item.status === 'waiting'
            ? `Waiting its turn: ${PREPARE_AT_ONCE === 4 ? 'four' : PREPARE_AT_ONCE} firms are prepared at a time.`
            : again
              ? 'The new one replaces it, edits and all, unless you keep the one you had.'
              : `This takes about a minute.${others ? ' Another firm is being prepared meanwhile.' : ''}`,
      }),
    );
  }
  if (item.status === 'none' || item.status === 'failed') {
    const watched = state.watch.some((w) => w.id === item.firm.id);
    const noSearch = !canResearch()
      ? ' No web search ran: finding people beyond its site needs Claude or OpenRouter, or a Hunter key.'
      : '';
    return el(
      'div',
      { className: 'review-body' },
      head,
      el('p', {
        className: item.status === 'failed' ? 'error' : '',
        textContent:
          item.status === 'failed'
            ? item.error
            : `No one to write to was found: no recruiting mailbox, no named person with an address, and no address format to make one from.${noSearch}`,
      }),
      el(
        'div',
        { className: 'review-actions' },
        item.status === 'failed'
          ? el('button', {
              className: 'primary big',
              type: 'button',
              textContent: 'Try again',
              onclick: () => retry(item),
            })
          : el('button', {
              className: 'primary big',
              type: 'button',
              disabled: watched,
              textContent: watched ? 'Watching' : 'Watch it for new roles',
              onclick: () =>
                watchFirm(item.firm).then(() => {
                  item.status = 'watched';
                  saveQueue();
                  if (shown() === item) advance();
                  else renderReview();
                }),
            }),
        el('button', { className: 'big', type: 'button', textContent: 'Skip', onclick: () => skipItem(item) }),
      ),
    );
  }
  if (FINISHED.has(item.status) || MOVING.has(item.status)) {
    const pending = review.pending.get(item.id);
    const text = {
      sending: 'Sending in a few seconds…',
      delivering: 'Sending…',
      saving: 'Saving to your drafts…',
      sent: item.outcome || 'Sent.',
      scheduled: item.outcome || 'Scheduled.',
      saved: item.outcome || 'Saved to your drafts.',
      skipped: 'Skipped.',
      watched: 'Watched: new roles show on the Watchlist tab.',
      elsewhere: item.outcome || 'Done elsewhere: see the Outreach tab.',
    }[item.status];
    return el(
      'div',
      { className: 'review-body' },
      head,
      el('p', {
        className: ['skipped', 'watched', 'elsewhere'].includes(item.status) ? 'muted' : 'ok-text',
        textContent: text,
      }),
      // A take-back that failed: the email still goes at its time.
      item.status === 'scheduled' && item.error
        ? el('p', { className: 'small error', attrs: { role: 'alert' }, textContent: item.error })
        : null,
      el(
        'div',
        { className: 'review-actions' },
        pending
          ? el('button', { className: 'big', type: 'button', textContent: 'Undo', onclick: () => undoSend(item.id) })
          : null,
        item.status === 'scheduled' && canTakeBack(item)
          ? el('button', {
              className: 'big',
              type: 'button',
              disabled: !!item.takingBack,
              textContent: item.takingBack ? 'Taking it back…' : 'Take it back',
              onclick: () => takeBack(item),
            })
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
      oninput: (e) => ((item.subject = e.target.value), edited(item, e.target)),
    }),
    el('textarea', {
      className: 'body',
      value: item.body,
      rows: Math.min(22, Math.max(12, item.body.split('\n').length + 2)),
      attrs: { 'aria-label': 'Email' },
      oninput: (e) => ((item.body = e.target.value), edited(item, e.target)),
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
    // The doubt about an earlier copy, still said once the error that raised it has gone (the email written again).
    !item.error && item.unsure && !doubts.length
      ? el('p', { className: 'small warn-text', textContent: item.unsure })
      : null,
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
    (r) => r && r.reasonKind && ['sent', 'replied', 'closed'].includes(r.status),
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

/** How the queue stands: { ready, working (being prepared), held (not prepared yet), needYou, done }. */
function tally() {
  const count = (f) => review.items.filter(f).length;
  return {
    ready: count((i) => i.status === 'ready'),
    working: count((i) => i.status === 'preparing' || (i.status === 'waiting' && !i.held)),
    held: count((i) => i.status === 'waiting' && i.held),
    needYou: count((i) => i.status === 'none' || i.status === 'failed'),
    sending: count((i) => i.status === 'sending' || i.status === 'delivering'),
    saving: count((i) => i.status === 'saving'),
    done: count((i) => FINISHED.has(i.status)),
  };
}

/**
 * Can Clear the finished ones clear it? Not an email that can still be taken back, nor one whose earlier copy (the page
 * closed as it went) is still looked for in Sent: cleared, that copy would never be recorded, and the firm could be
 * written to again with no word of it.
 */
/**
 * Finished, and nothing left to happen to it: one waiting for their morning can still be taken back, and a copy the
 * page closed on, looked for in Sent, is recorded as sent when found (unless its record says so already).
 */
const clearable = (i) =>
  FINISHED.has(i.status) && !canTakeBack(i) && (!i.lookFor || !!alreadyDone(i, state.outreach[i.firm.id]));

/** Past the last card: what's left to do first (read, prepare, look at), then what happened and the next ten. */
function summaryView() {
  const count = (s) => review.items.filter((i) => i.status === s).length;
  const nobody = review.items.filter((i) => i.status === 'skipped' && i.nobody).length;
  const t = tally();
  const next = nextToWrite();
  const firstOf = (f) => review.items.find(f);
  const looking = review.items.filter((i) => FINISHED.has(i.status) && !canTakeBack(i) && !clearable(i));
  const parts = [
    t.sending && `${t.sending} being sent`,
    t.saving && `${t.saving} being saved to drafts`,
    count('sent') && `${count('sent')} sent`,
    count('scheduled') && `${count('scheduled')} arriving in their morning`,
    count('saved') && `${count('saved')} saved to drafts`,
    count('elsewhere') && `${count('elsewhere')} no longer needed (see the Outreach tab)`,
    count('skipped') - nobody && `${count('skipped') - nobody} skipped`,
    nobody && `${nobody} with no one to write to (left out)`,
    count('watched') && `${count('watched')} watched`,
  ].filter(Boolean);
  const [heading, action] = !review.items.length
    ? ['Nothing to review yet', null]
    : t.ready
      ? [
          `${plural(t.ready, 'email')} still to read`,
          ['Read them', () => showItem(firstOf((i) => i.status === 'ready'))],
        ]
      : t.working
        ? ['The rest are being prepared', null]
        : t.held
          ? [`${plural(t.held, 'firm')} not prepared yet`, ['Prepare them', () => resumeQueue()]]
          : t.needYou
            ? [
                `${plural(t.needYou, 'firm')} need${t.needYou === 1 ? 's' : ''} you`,
                ['Show them', () => showItem(firstOf((i) => i.status === 'none' || i.status === 'failed'))],
              ]
            : ['All read', null];
  return el(
    'div',
    { className: 'review-body summary' },
    el('h2', { textContent: heading, tabIndex: -1 }),
    el('p', {
      className: 'muted',
      textContent: !review.items.length
        ? 'Search for firms, then press Write to the top 10: JobToFill checks each firm, finds who to write to and a reason to, and drafts the email, and you read each one here.'
        : parts.join(' · ') || 'Nothing sent yet.',
    }),
    replyStats() ? el('p', { className: 'small stats', textContent: replyStats() }) : null,
    looking.length
      ? el('p', {
          className: 'small muted',
          textContent: `${looking
            .slice(0, 3)
            .map((i) => i.firm.name)
            .join(
              ', ',
            )}${looking.length > 3 ? '…' : ''} ${looking.length === 1 ? 'stays' : 'stay'} here while the email the page closed on is looked for in your Sent folder (${lookingUntil(looking)}): found, it’s recorded as sent.`,
        })
      : null,
    el(
      'div',
      { className: 'review-actions' },
      action
        ? el('button', { className: 'primary big', type: 'button', textContent: action[0], onclick: action[1] })
        : null,
      next.length
        ? el('button', {
            className: action ? 'big' : 'primary big',
            type: 'button',
            textContent: `Write to the next ${next.length === TOP ? TOP : plural(next.length, 'firm')}`,
            onclick: () => writeTo(next),
          })
        : el('button', {
            className: action ? 'big' : 'primary big',
            type: 'button',
            textContent: 'Find firms',
            onclick: () => showTab('find'),
          }),
      review.items.some(clearable)
        ? el('button', {
            className: 'big ghost',
            type: 'button',
            textContent: 'Clear the finished ones',
            onclick: () => {
              // An email still waiting for their morning stays, so it can be taken back.
              const gone = review.items.filter(clearable);
              review.cleared = [...new Set([...review.cleared, ...gone.map((i) => i.firm.id)])].slice(-2000);
              review.items = review.items.filter((i) => !gone.includes(i));
              review.at = -1;
              advance();
              saveQueue();
            },
          })
        : null,
    ),
  );
}

/** Review in a tab that doesn't have the queue: where it is, and asking for it here (again, if it's slow to come). */
function elsewhereView() {
  if (review.opening)
    return el('div', { className: 'review-body summary' }, el('h2', { textContent: 'Opening Review…', tabIndex: -1 }));
  return el(
    'div',
    { className: 'review-body summary' },
    el('h2', { textContent: 'Review is open in another Discover tab', tabIndex: -1 }),
    el('p', {
      className: 'muted',
      attrs: { role: 'status' },
      textContent: !review.taking
        ? 'The queue works in one tab at a time, so no email is ever sent twice. Close the other tab, or review here: anything it’s sending finishes first, and a firm it was still preparing waits for Prepare them.'
        : review.busyThere
          ? 'Waiting for that tab to finish what it’s sending; the queue then opens here.'
          : 'Opening the queue here…',
    }),
    el(
      'div',
      { className: 'review-actions' },
      el('button', {
        className: review.taking ? 'big' : 'primary big',
        type: 'button',
        textContent: review.taking ? 'Ask again' : 'Review here instead',
        onclick: () => takeOver(),
      }),
    ),
  );
}

/**
 * How long emails the page closed on are looked for in Sent: three days past their time, or, while Sent couldn't be
 * checked (no inbox, Nylas down), until it can be (reconcileDelivering() goes on looking for a month then).
 */
function lookingUntil(looking) {
  if (looking.some((i) => i.lookFor.unchecked)) return 'until your Sent folder can be checked';
  const at = Math.max(...looking.map((i) => Math.max(i.lookFor.at, i.lookFor.after || 0) + LOOK_FOR_MS));
  return at > Date.now() ? `until ${day(at)}` : 'until it’s next looked for';
}

/** Firm 3 of 10, with how many are ready, being prepared, not prepared, need you and done, as a bar. */
function progressView() {
  const n = review.items.length;
  if (!n) return [];
  const t = tally();
  const bar = el('div', { className: 'bar' }, el('span', { style: `width:${Math.round((t.done / n) * 100)}%` }));
  return [
    el(
      'div',
      { className: 'row' },
      el('strong', { textContent: review.at < n ? `${review.at + 1} of ${n}` : plural(n, 'firm') }),
      el('span', {
        className: 'muted small',
        textContent: [
          t.ready && `${t.ready} ready to read`,
          t.working && `${t.working} being prepared`,
          t.held && `${t.held} not prepared yet`,
          t.needYou && `${t.needYou} need${t.needYou === 1 ? 's' : ''} you`,
          t.sending && `${t.sending} sending`,
          t.saving && `${t.saving} saving`,
          t.done && `${t.done} done`,
        ]
          .filter(Boolean)
          .join(' · '),
      }),
      el('span', { className: 'grow' }),
      el(
        'span',
        { className: 'nav' },
        el('button', {
          className: 'ghost',
          type: 'button',
          textContent: '←',
          title: 'Back (←)',
          attrs: { 'aria-label': 'Back' },
          disabled: review.at <= 0,
          onclick: () => move(-1),
        }),
        el('button', {
          className: 'ghost',
          type: 'button',
          textContent: '→',
          title: 'Next (→)',
          attrs: { 'aria-label': 'Next' },
          disabled: review.at >= n,
          onclick: () => move(1),
        }),
      ),
    ),
    bar,
  ];
}

/**
 * The toasts, bottom of the page: what went wrong (kept until read: closed, or its email shown), and below it, while
 * emails wait out their five seconds, the latest of them with Undo (and how many more); otherwise what just happened,
 * gone after eight seconds. Each is put in the page once and left there while it says the same, so a screen reader
 * reads it once and a Close with the keyboard's focus keeps it.
 */
function drawToasts() {
  const target = (id) => review.items.find((i) => i.id === id);
  // An alert about an email is read once its card has been on screen with it (the card says it too): it goes when the
  // person moves on from that card, never at some redraw while they're still reading it. Shown in a hidden Review tab
  // (the send failed while they were on Find firms) isn't on screen.
  const now = shown();
  const onScreen = !$('#review-view').hidden && document.visibilityState === 'visible';
  for (const a of review.alerts) if (onScreen && a.show && now && target(a.show) === now) a.seen = true;
  review.alerts = review.alerts.filter((a) => !a.seen || !target(a.show) || target(a.show) === now);
  const canShow = (id) => !!id && !!target(id) && shown() !== target(id);
  const showIt = (id, after) =>
    canShow(id)
      ? el('button', {
          className: 'link',
          type: 'button',
          textContent: 'Show it',
          onclick: () => {
            after();
            showItem(target(id));
          },
        })
      : null;
  const nodes = review.alerts.map((a) => {
    a.at = a.at || Date.now();
    const close = () => {
      review.alerts = review.alerts.filter((x) => x !== a);
      renderReview();
    };
    // One about no email in particular goes by itself after a while.
    if (!a.show && !a.timer) a.timer = setTimeout(close, 12000);
    // Built once (a screen reader reads it once); its Show it is there only while its email isn't the one shown.
    if (!a.node) {
      a.showIt = a.show
        ? el('button', {
            className: 'link',
            type: 'button',
            textContent: 'Show it',
            onclick: () => {
              review.alerts = review.alerts.filter((x) => x !== a);
              showItem(target(a.show));
            },
          })
        : null;
      a.node = el(
        'div',
        { className: 'toast error', attrs: { role: 'alert' } },
        el('span', { textContent: a.text }),
        a.showIt,
        el('button', { className: 'link', type: 'button', textContent: 'Close', onclick: close }),
      );
    }
    if (a.showIt) a.showIt.hidden = !canShow(a.show);
    return a.node;
  });
  const waiting = [...review.pending.values()];
  let note = null;
  if (waiting.length) {
    const last = waiting[waiting.length - 1].item;
    const more = waiting.length > 1 ? ` (and ${plural(waiting.length - 1, 'other')})` : '';
    const text = `Sending to ${last.to}${more}…`;
    note = noteOf(['undo', last.id, text], () =>
      el(
        'div',
        { className: 'toast', attrs: { role: 'status' } },
        el('span', { textContent: text }),
        // Undo names its email: a second click lands on the email before, and undoSend lets it pass only after a moment.
        el('button', { className: 'link', type: 'button', textContent: 'Undo (U)', onclick: () => undoSend(last.id) }),
      ),
    );
  } else if (review.toast) {
    const t = review.toast;
    if (!t.timer)
      t.timer = setTimeout(() => {
        if (review.toast === t) review.toast = null;
        renderReview();
      }, 8000);
    const back = t.takeBack && target(t.takeBack);
    const taking = back && canTakeBack(back) ? (back.takingBack ? 'busy' : 'yes') : 'no';
    note = noteOf([t, taking, canShow(t.show)], () =>
      el(
        'div',
        { className: 'toast', attrs: { role: 'status' } },
        el('span', { textContent: t.text }),
        taking !== 'no'
          ? el('button', {
              className: 'link',
              type: 'button',
              disabled: taking === 'busy',
              textContent: 'Take it back',
              onclick: () => takeBack(back),
            })
          : null,
        showIt(t.show, () => (review.toast = null)),
      ),
    );
  }
  const want = [...nodes, note].filter(Boolean);
  let box = document.querySelector('#review-view .toasts');
  if (!box) {
    box = el('div', { className: 'toasts' });
    $('#review-view').append(box);
    if (globalThis.ResizeObserver) new ResizeObserver(() => makeRoom()).observe(box);
  }
  for (const n of [...box.children]) if (!want.includes(n)) n.remove();
  want.forEach((n, k) => box.children[k] !== n && box.insertBefore(n, box.children[k] || null));
  box.hidden = !want.length;
}

/**
 * Room below the card for the toasts, so what they cover can be scrolled above them. It grows at once and shrinks only
 * when the card changes (`fresh`): a toast going never shortens the page and moves the card under the pointer.
 */
function makeRoom(fresh) {
  const box = document.querySelector('#review-view .toasts');
  const h = box && !box.hidden && box.offsetHeight ? box.offsetHeight + 24 : 0;
  review.room = fresh ? h : Math.max(review.room, h);
  $('#review-view').style.paddingBottom = review.room ? `${review.room}px` : '';
}

/** The note under the alerts, built again only when what it says (or offers) changed. */
function noteOf(key, build) {
  const same = review.note && review.note.key.length === key.length && review.note.key.every((k, i) => k === key[i]);
  if (!same) review.note = { key, node: build() };
  return review.note.node;
}

/**
 * What a card is drawn from: drawn again only when this changes (the summary also when the replies or the firms left
 * to write to change, not only the queue).
 */
const cardKey = (item) =>
  item
    ? [item.id, item.status, item.step, item.hook, item.to, item.armed, item.error, (item.hooks || []).length].join('|')
    : ['summary', review.items.map((i) => i.status).join(), replyStats(), nextToWrite().length].join('|');

/**
 * Draw the queue: progress, the card shown, the follow-ups due and the toast. The card is drawn again only when what
 * it shows changed (force), so typing in it, or a check finishing for another firm, never loses the cursor. A new card
 * gets the focus on its heading and is scrolled to, and a Send pressed in its first moment doesn't count.
 */
function renderReview(force) {
  reviewCount();
  if (!$('#review-view')) return;
  if (!review.live) {
    $('#review-progress').replaceChildren();
    $('#follow-due').hidden = true;
    $('#review-keys').hidden = true;
    drawToasts();
    const key = `elsewhere|${review.opening}|${review.taking}|${review.busyThere}`;
    if (force || key !== review.drawn) {
      // Pressed with the keyboard: the focus goes to the card's heading, not the page.
      const had = document.activeElement && document.activeElement.closest('#review-card');
      $('#review-card').replaceChildren(elsewhereView());
      if (had) $('#review-card h2').focus({ preventScroll: true });
    }
    review.drawn = key;
    return;
  }
  const item = shown();
  const key = cardKey(item);
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
  drawToasts();
  $('#review-keys').hidden = !item || item.status !== 'ready';
  if (!force && key === review.drawn) return;
  review.drawn = key;
  // Typed in when it's drawn again (its email finished elsewhere): the keys that follow are still the typing.
  const active = document.activeElement;
  const lost = !!(active && active.closest && active.closest('#review-card input, #review-card textarea'));
  $('#review-card').replaceChildren(item ? itemView(item) : summaryView());
  if (lost) {
    review.dropped = true;
    const heading = $('#review-card h2');
    if (heading) heading.focus({ preventScroll: true });
  }
  const body = $('#review-card textarea.body');
  if (body) fitBox(body);
  // Another firm, or this one now ready to read: what's under the pointer and the keys changed.
  const shownKey = item ? `${item.id}|${item.status}` : 'summary';
  if (shownKey !== review.shownKey) {
    const moved = !item || !review.shownKey.startsWith(`${item.id}|`);
    review.shownKey = shownKey;
    review.shownAt = Date.now();
    if (moved) makeRoom(true);
    if (moved && !$('#review-view').hidden) {
      const heading = $('#review-card h2');
      if (heading) heading.focus({ preventScroll: true });
      // Below the sticky bar at the top (taller on a phone, where it wraps), so "3 of 10" isn't under it.
      const bar = document.querySelector('.topbar');
      const under = bar ? bar.getBoundingClientRect().bottom : 0;
      const top = $('#review-progress').getBoundingClientRect().top;
      if (top < under || top > innerHeight - 100)
        scrollTo({ top: Math.max(0, scrollY + $('#review-view').getBoundingClientRect().top - under - 8) });
    }
  }
  // Asked once; when it answers, only the buttons and the line under them change, in place: the email may be being
  // typed in.
  if (state.nylas && state.nylas.grantId && !review.abilities && !review.askingAbilities)
    review.askingAbilities = inboxAbilities().then((a) => {
      review.abilities = a;
      if (a.send && a.draft) return;
      const now = shown();
      const actions = document.querySelector('#review-card .review-actions');
      const note = document.querySelector('#review-card .send-note');
      if (now && now.status === 'ready' && actions && note) {
        actions.replaceWith(reviewActions(now));
        note.replaceWith(sendNote(now));
      } else renderReview(true);
    });
}

/** The email box as tall as the email, so the whole of it reads without scrolling the box (not while hidden). */
function fitBox(box) {
  if (!box.offsetParent) return;
  box.style.height = 'auto';
  box.style.height = `${box.scrollHeight + 4}px`;
}

/**
 * The queue as it was left (squared with the outreach records), and the choices above it; with the alerts not yet read
 * (`alerts`) when this tab is handed it by another. Only the latest call counts: one begun before is stale.
 */
async function loadReview(alerts) {
  const n = (loadReview.n = (loadReview.n || 0) + 1);
  const cache = await store.getDiscoverCache();
  if (n !== loadReview.n) return;
  state.hooks = cache.hooks || {};
  // A page that closed a moment ago may have left a newer queue than it could store.
  const left = queueLeft(cache.queue);
  if (left) cache.queue = left;
  if (alerts)
    review.alerts = ((cache.queue && cache.queue.alerts) || []).map((a) => ({
      text: a.text,
      show: a.show || '',
      keep: !!a.keep,
      at: 0,
    }));
  if (cache.queue) {
    // Nothing runs when the page opens, whatever the queue was saved as (one saved by an older version too).
    review.items = cache.queue.items.filter((i) => i && i.id && i.firm).map(kept);
    review.at = Math.max(0, Math.min(cache.queue.at || 0, review.items.length));
    review.cleared = cache.queue.cleared || [];
    review.declined = cache.queue.declined || {};
  }
  reconcileQueue();
  const d = (state.settings && state.settings.discoverAi) || {};
  for (const r of document.querySelectorAll('input[name="ask"]')) r.checked = r.value === (d.ask || 'internship');
  $('#their-morning').checked = d.theirMorning !== false;
  $('#common-ground').checked = d.commonGround === true;
  renderReview(true);
  reconcileDelivering().catch(() => null);
}

/* review: one tab at a time */

const QUEUE_LOCK = 'jobtofill-review-queue';
const TAB_ID = Math.random().toString(36).slice(2);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** The queue can't be acted on here: another tab has it, or it's being stored to hand over. */
const frozen = () => !review.live || review.leaving;
/** What the queue isn't let go during: an email in its five seconds, with Nylas, or being taken back. */
const sending = () => review.pending.size || review.items.some((i) => MOVING.has(i.status) || i.takingBack);

/**
 * Ask for the queue's lock (`opts` as for locks.request): true once this tab has it, false if the asking was given
 * up. Held until the page closes or the tab it's handed to takes it (steals it, ahead of any other tab waiting).
 */
function holdQueue(opts) {
  return new Promise((resolve) => {
    let got = false;
    navigator.locks
      .request(QUEUE_LOCK, opts, () => {
        got = review.holding = true;
        resolve(true);
        return new Promise(() => {});
      })
      .catch(() => (got ? handedOff() : resolve(false)));
  });
}

/**
 * Whether this tab had the queue as its last page closed a moment ago (a reload): stamped as it goes, kept for the tab
 * only and read once, so a new tab, or one duplicated from it, doesn't think so.
 */
function hadQueue() {
  try {
    const t = Number(sessionStorage.getItem(QUEUE_LOCK));
    sessionStorage.removeItem(QUEUE_LOCK);
    return t > 0 && Date.now() - t < 15000;
  } catch (err) {
    return false;
  }
}

/**
 * The queue works in one Discover tab at a time: two would each store their copy over the other's (a skip undone, a
 * scheduled email losing Take it back) and could send the same email twice. The tab that has it holds a lock while
 * it's open; another shows Review as open there, gets it when that tab closes, or asks for it (Review here instead,
 * Write to them) and is handed it, ahead of any other tab waiting, once nothing is being sent. A tab reloaded asks for
 * it back (another tab waiting gets it as the page reloads).
 */
async function claimQueue() {
  if (!navigator.locks || typeof BroadcastChannel !== 'function') return void (review.live = true);
  review.channel = new BroadcastChannel(QUEUE_LOCK);
  review.channel.onmessage = (e) => heard(e.data || {});
  addEventListener('pagehide', () => {
    // Asked and gone before it came: the tab that has it keeps it, and what it's preparing.
    if (review.taking) review.channel.postMessage({ never: TAB_ID });
    if (!review.live) return;
    // Taken from a tab a moment ago and closed: it goes back there, not to whichever tab has waited longest.
    if (review.cameFrom && Date.now() - review.cameFrom.at < 10000)
      review.channel.postMessage({ yours: review.cameFrom.id, from: TAB_ID });
    try {
      sessionStorage.setItem(QUEUE_LOCK, String(Date.now()));
    } catch (err) {
      // No session storage: a reload just waits for the queue like any other tab.
    }
  });
  const reloaded = hadQueue();
  // A moment's wait: a page being reloaded is still letting go of it.
  const got = await holdQueue({ signal: AbortSignal.timeout(1500) });
  if (got) {
    review.live = true;
    return review.channel.postMessage({ have: TAB_ID });
  }
  review.granted = new Promise((resolve) => (review.grant = resolve));
  waitForQueue();
  if (reloaded) takeOver();
}

/** Wait for the queue: the tab that has it closing gives it to the tab waiting longest. */
function waitForQueue() {
  review.waiting = new AbortController();
  holdQueue({ signal: review.waiting.signal }).then((got) => got && opened());
}

/**
 * What the other Discover tabs say: asking for the queue (answered once nothing is being sent; one asking while it's
 * being handed to another is told to wait, and asks again once that tab has it), asking no more, handing it to one,
 * having it now, still sending.
 */
function heard(m) {
  if (m.ask) {
    if (!review.live) return;
    if (review.handing && review.handing !== m.ask) review.channel.postMessage({ busy: m.ask });
    else handOver(m.ask);
  } else if (m.never) {
    if (review.handing === m.never) review.handing = '';
  } else if (m.yours) {
    if (m.yours !== TAB_ID || review.live || !review.waiting) return;
    // Taken straight away, ahead of any other tab waiting for it.
    review.cameFrom = m.from ? { id: m.from, at: Date.now() } : null;
    review.waiting.abort();
    holdQueue({ steal: true }).then((got) => got && opened());
  } else if (m.have) {
    if (m.have === TAB_ID || !review.taking) return;
    // Another tab has it now (handed it, or the tab that had it closed): asked of that one.
    review.busyThere = false;
    renderReview(true);
    review.channel.postMessage({ ask: TAB_ID });
  } else if (m.busy === TAB_ID && review.taking && !review.busyThere) {
    review.busyThere = true;
    renderReview(true);
  }
}

/** This tab has the queue now (the tab that had it closed, or handed it here): opened as stored, its alerts too. */
async function opened() {
  clearTimeout(review.reclaim);
  Object.assign(review, { live: true, taking: false, busyThere: false, toast: null });
  try {
    await loadReview(true);
  } finally {
    review.grant();
  }
  review.channel.postMessage({ have: TAB_ID });
}

/** Ask the tab that has the queue to hand it over (again, if pressed again); resolves once this tab has it. */
function takeOver() {
  if (review.opening) return review.ready.then(takeOver);
  if (review.live) return Promise.resolve();
  if (!review.taking) {
    Object.assign(review, { taking: true, busyThere: false });
    renderReview(true);
  }
  review.channel.postMessage({ ask: TAB_ID });
  return review.granted;
}

/**
 * Writing in the card's email: the cursor in it while this tab is in front (a pause to think included), or a key a
 * moment ago. A hand-over waits for that to end, so the sentence isn't cut off; going to the tab that asked ends it.
 */
const typingNow = () =>
  !!document.activeElement &&
  !!document.activeElement.closest('#review-card textarea, #review-card input') &&
  (document.hasFocus() || Date.now() - review.typedAt < 2500);

/**
 * Asked for by tab `to`: once nothing is in its five seconds, with Nylas or being taken back, and the email isn't
 * being typed in, nothing new is sent or saved here (leaving), what's being prepared stops (it waits there for Prepare
 * them; a Write it again says it stopped), the queue is stored, alerts and all, and the asking tab takes it. Not taken
 * within a moment (that tab closed), this one has it back.
 */
async function handOver(to) {
  if (!review.live || review.handing) return;
  review.handing = to;
  if (sending() || typingNow()) {
    review.channel.postMessage({ busy: to });
    review.toast = { text: 'Another Discover tab asked for Review: it moves there once nothing is being sent here.' };
    renderReview();
  }
  while ((sending() || typingNow()) && review.handing === to) await sleep(300);
  if (review.handing !== to) return;
  review.leaving = true;
  for (const i of review.items) {
    if ((i.status === 'preparing' && !i.body) || (i.status === 'waiting' && !i.held)) i.moved = true;
    if (i.status === 'preparing' && i.body)
      i.error = 'Write it again stopped when Review moved to another Discover tab: press it again for a new one.';
  }
  review.items.forEach(stopRun);
  clearTimeout(whenDue.timer);
  await saveQueue();
  Object.assign(review, { live: false, leaving: false, handing: '', taking: false, alerts: [], toast: null });
  review.granted = new Promise((resolve) => (review.grant = resolve));
  renderReview(true);
  review.channel.postMessage({ yours: to, from: TAB_ID });
  review.reclaim = setTimeout(() => review.holding && !review.live && opened(), 3000);
}

/** The tab this one handed the queue to has it: this one waits to have it back. */
function handedOff() {
  clearTimeout(review.reclaim);
  review.holding = false;
  if (review.live) {
    Object.assign(review, { live: false, alerts: [], toast: null });
    review.granted = new Promise((resolve) => (review.grant = resolve));
    renderReview(true);
  }
  waitForQueue();
}

/** The queue as another tab stored it, for this tab's Find firms (In Review) and count while it doesn't have it. */
function adoptQueue(cache) {
  const q = cache && cache.queue;
  if (review.live || !q || !Array.isArray(q.items)) return;
  review.items = q.items.filter((i) => i && i.id && i.firm).map(kept);
  review.cleared = q.cleared || [];
  review.declined = q.declined || {};
  reviewCount();
}

/** Another tab, the drawer or the Outreach tab wrote to a firm: the queue hears of it before anything is sent. */
async function outreachChanged() {
  const was = state.outreach;
  state.outreach = await store.getOutreach();
  // The Outreach tab too: the queue points there for a firm written to in another tab.
  renderOutreach();
  // A firm's card (its pill, Write to them, its drawer's Send) follows a record changed elsewhere; not while its
  // drawer is being typed in.
  const typing = document.activeElement && document.activeElement.closest('#results .firm');
  for (const id of new Set([...Object.keys(was), ...Object.keys(state.outreach)]))
    if (JSON.stringify(was[id]) !== JSON.stringify(state.outreach[id]) && !(typing && typing.dataset.id === id))
      rerender(id);
  afterReconcile(reconcileQueue());
}

/** The AI key, model or inbox changed (in Settings, or another tab): the header, buttons and Overview follow. */
async function settingsChanged(changes) {
  [state.config, state.nylas, state.settings] = await Promise.all([
    store.discoverAiConfig(),
    store.getNylas(),
    store.getSettings(),
  ]);
  if (changes.nylas) {
    // What the inbox may do is asked of Nylas again.
    review.abilities = null;
    review.askingAbilities = null;
  }
  if (changes.aiKeys) await buildAiBox();
  syncAi();
  renderHome();
  renderReview();
}

/** A choice above the queue saved; the drafts already written keep theirs until written again. */
async function saveReviewChoice(patch) {
  await saveAi(patch);
  state.settings = await store.getSettings();
  renderReview(true);
}

/* -------------------------------------------------------------- overview */

/** What a reply in an email's thread was ('positive', 'apply', 'declined', 'reply', 'auto', 'bounced'), or ''. */
function replyOf(rec) {
  if (!rec) return '';
  const kind = rec.reply && rec.reply.kind;
  // The status the person sets wins over the hint: Replied by hand is a reply whatever came before it, and a bounce
  // set back to Sent (it arrived after all) is no bounce.
  if (kind && rec.status === 'replied' && ['auto', 'bounced'].includes(kind)) return 'reply';
  if (kind === 'bounced' && rec.status !== 'closed') return '';
  if (kind) return kind;
  if (rec.status !== 'replied') return '';
  // Answered before replies were sorted: worked out from the line the reply check left in the notes.
  const line = String(rec.notes || '').match(/Reply from ([^\n]*?) on [^:\n]*: “([^\n]*)”/);
  return line ? O.replyKind({ from: [{ name: line[1] }], snippet: line[2] }) : 'reply';
}

const REPLY_TEXT = {
  positive: ['ok', 'Interested'],
  apply: ['', 'Apply online'],
  declined: ['bad', 'Declined'],
  reply: ['ok', 'Replied'],
  auto: ['', 'Auto-reply'],
  bounced: ['bad', 'Bounced'],
};

/** Working days since a time, counting Monday to Friday. */
function workingDaysSince(t) {
  if (!t) return 0;
  let n = 0;
  for (let d = new Date(t); d < Date.now() - 864e5 + 1; d = new Date(d.getTime() + 864e5)) {
    const next = new Date(d.getTime() + 864e5);
    if (next <= Date.now() && next.getDay() % 6) n++;
  }
  return n;
}

/** When a record last had news: its reply, else when it was sent, else when it was last changed. */
const lastEvent = (r) => (r.reply && r.reply.at) || (r.status !== 'drafted' && r.sentAt) || r.updatedAt || 0;

/** The outreach list counted every way the Overview and Outreach's filters want it. */
function outreachTally() {
  const recs = Object.entries(state.outreach);
  const t = {
    all: recs.length,
    drafted: 0,
    sent: 0,
    waiting: 0,
    quiet: 0,
    replied: 0,
    answered: 0,
    positive: 0,
    apply: 0,
  };
  Object.assign(t, { declined: 0, bounced: 0, auto: 0, closed: 0, scheduled: 0 });
  for (const [, r] of recs) {
    const kind = replyOf(r);
    if (r.sentAt || ['sent', 'replied'].includes(r.status)) t.sent++;
    if (r.status === 'drafted') t.drafted++;
    if (r.status === 'closed' && kind !== 'bounced') t.closed++;
    if (waitsAtNylas(r)) t.scheduled++;
    else if (r.status === 'sent') {
      t.waiting++;
      if (workingDaysSince(r.sentAt) >= 5) t.quiet++;
    }
    if (r.status === 'replied') t.replied++;
    // Answered by a person, whatever the status says now (a replied firm set to Closed was still answered).
    if (r.status === 'replied' || ['positive', 'apply', 'declined', 'reply'].includes(kind)) t.answered++;
    // A bounce left alone (Leave it) is dealt with.
    if (kind === 'bounced' && r.reply && r.reply.done) continue;
    if (kind && t[kind] != null && kind !== 'reply') t[kind]++;
  }
  return t;
}

/** One number on the Overview, a button that opens where it's counted. */
function stat(n, label, tone, go) {
  return el(
    'button',
    { className: `stat ${n ? tone : ''}`, type: 'button', onclick: go },
    el('span', { className: 'n', textContent: String(n) }),
    el('span', { className: 'label', textContent: label }),
  );
}

/** Outreach, showing one filter. */
function openOutreach(filter) {
  state.outreachFilter = filter;
  showTab('outreach');
}

/** The first queue item that's `f`, shown on Review. */
function openReview(f) {
  showTab('review');
  const item = f && review.items.find(f);
  if (item) showItem(item);
}

/** The Overview: the numbers, what needs doing now, preparing ahead, and the latest replies and sends. */
function renderHome() {
  if (!$('#home-view') || $('#home-view').hidden) return;
  // A press on one of its buttons isn't lost to a redraw a step elsewhere caused: the same button gets the focus back.
  const had = document.activeElement && document.activeElement.closest('#home-view button');
  const label = had && had.textContent;
  const refocus = () => {
    if (!had || had.isConnected) return;
    const again = [...document.querySelectorAll('#home-view button')].find((b) => b.textContent === label);
    if (again) again.focus({ preventScroll: true });
  };
  const q = tally();
  const o = outreachTally();
  const due = followUpsDue();
  const fresh = Object.values(state.watchStates).reduce((n, st) => n + ((st && st.fresh.length) || 0), 0);
  const rate = o.sent ? Math.round((o.answered / o.sent) * 100) : 0;
  $('#home-sub').textContent = o.sent
    ? `${plural(o.sent, 'email')} sent, ${o.answered} answered (${rate}%).`
    : 'Nothing sent yet. Search for firms, then Write to the top 10.';
  const draw = (box, children) => {
    const key = children.map((c) => (c ? c.textContent + '|' + c.className : '')).join('§');
    if (box.dataset.key === key) return;
    box.dataset.key = key;
    box.replaceChildren(...children);
  };
  draw($('#home-stats'), [
    stat(q.ready, 'Ready to read', 'accent', () => openReview((i) => i.status === 'ready')),
    stat(q.working, 'Being prepared', '', () => openReview((i) => ['preparing', 'waiting'].includes(i.status))),
    stat(o.waiting, 'Awaiting a reply', '', () => openOutreach('waiting')),
    stat(o.answered, 'Answered', 'ok', () => openOutreach('replied')),
    stat(o.positive, 'Interested', 'ok', () => openOutreach('positive')),
    stat(due.length, 'Follow-ups due', 'warn', () =>
      due.length ? (showTab('review'), queueFollowUps()) : openOutreach('quiet'),
    ),
    stat(o.bounced + q.needYou, 'Bounced or stuck', 'bad', () =>
      o.bounced ? openOutreach('bounced') : openReview((i) => i.status === 'failed' || i.status === 'none'),
    ),
    stat(o.sent, 'Sent in all', '', () => openOutreach('all')),
  ]);
  const todo = [];
  const add = (tone, title, detail, label, act, primary) =>
    todo.push(
      el(
        'li',
        {},
        el('span', { className: `tone ${tone}`, attrs: { 'aria-hidden': 'true' } }),
        el(
          'span',
          { className: 'what' },
          el('strong', { textContent: title }),
          detail ? el('span', { className: 'small muted', textContent: detail }) : null,
        ),
        label
          ? el('button', {
              className: primary ? 'primary small' : 'small',
              type: 'button',
              textContent: label,
              onclick: act,
            })
          : null,
      ),
    );
  if (!aiReady())
    add(
      'bad',
      'Add an AI key',
      'Needed to find people, look for a reason to write and draft emails.',
      'Open Settings',
      () => api.tabs.create({ url: api.runtime.getURL('options/options.html#letters') }),
    );
  if (!state.nylas || !state.nylas.grantId)
    add(
      'warn',
      'Connect your inbox to send in one click',
      'Settings › Email codes, with Nylas: Send then sends from your own mailbox with your CV, and replies are noticed by themselves.',
      'Open Settings',
      () => api.tabs.create({ url: api.runtime.getURL('options/options.html#email') }),
    );
  const alerts = (review.alerts || []).filter((a) => !a.seen);
  if (q.ready)
    add(
      'accent',
      `${plural(q.ready, 'email')} ready to read`,
      'Read, edit if you like, and press Send (Ctrl+Enter).',
      'Read them',
      () => openReview((i) => i.status === 'ready'),
      true,
    );
  if (alerts.length)
    add('bad', `${plural(alerts.length, 'send')} went wrong`, alerts[0].text || '', 'Show it', () => showTab('review'));
  if (q.needYou)
    add(
      'bad',
      `${plural(q.needYou, 'firm')} stuck in Review`,
      'A step failed (the AI or a website didn’t answer). Try again or skip.',
      'Show them',
      () => openReview((i) => i.status === 'failed' || i.status === 'none'),
    );
  if (o.bounced)
    add(
      'bad',
      `${plural(o.bounced, 'email')} bounced`,
      'The address doesn’t exist. Try someone else at the firm.',
      'See them',
      () => openOutreach('bounced'),
    );
  if (due.length)
    add(
      'warn',
      `${plural(due.length, 'follow-up')} due`,
      'Sent five working days ago with no reply: a short note in the same thread.',
      'Write them',
      () => (showTab('review'), queueFollowUps()),
    );
  const answer = Object.values(state.outreach).filter(
    (r) => r.status === 'replied' && ['positive', 'reply'].includes(replyOf(r)),
  ).length;
  if (answer)
    add(
      'ok',
      `${plural(answer, 'reply')} to answer`,
      'People who wrote back: answer from your inbox, then set them to Closed.',
      'See them',
      () => openOutreach('replied'),
    );
  // Only while they're still Replied: set to Closed once applied for, they're done.
  const apply = Object.values(state.outreach).filter((r) => r.status === 'replied' && replyOf(r) === 'apply').length;
  if (apply)
    add(
      '',
      `${plural(apply, 'firm')} asked you to apply online`,
      'Their reply points to the website or a programme.',
      'See them',
      () => openOutreach('apply'),
    );
  if (q.held)
    add(
      '',
      `${plural(q.held, 'firm')} not prepared yet`,
      'Left waiting when the page closed.',
      'Prepare them',
      () => (showTab('review'), resumeQueue()),
    );
  if (fresh) add('ok', `${fresh} new at firms you watch`, '', 'See them', () => showTab('watch'));
  const next = state.results.length ? nextToWrite() : [];
  if (next.length)
    add(
      'accent',
      `Write to the next ${next.length === TOP ? TOP : plural(next.length, 'firm')}`,
      `From your search: ${next
        .slice(0, 3)
        .map((f) => f.name)
        .join(', ')}${next.length > 3 ? '…' : ''}`,
      'Write to them',
      () => writeTo(next),
      !q.ready,
    );
  else if (!state.results.length)
    add('', 'Find firms to write to', 'Pick kinds of firm and a place.', 'Find firms', () => showTab('find'), !q.ready);
  draw($('#home-next'), todo);
  $('#home-write').hidden = !next.length;
  $('#home-write').textContent =
    next.length === TOP ? `Write to the next ${TOP}` : `Write to the next ${plural(next.length, 'firm')}`;
  $('#home-write').disabled = !aiReady();
  // Latest activity: the newest sends and replies.
  const recent = Object.values(state.outreach)
    .filter((r) => r.sentAt || r.status !== 'drafted')
    .sort((a, b) => lastEvent(b) - lastEvent(a))
    .slice(0, 8);
  draw(
    $('#home-recent'),
    recent.length
      ? recent.map((r) => {
          const kind = replyOf(r);
          const [tone, text] = kind ? REPLY_TEXT[kind] : ['', ''];
          return el(
            'li',
            {},
            el('span', { className: 'when', textContent: day(lastEvent(r)) }),
            el('span', { className: 'name', textContent: r.firm.name }),
            kind ? el('span', { className: `pill ${tone}`, textContent: text }) : outreachPill(r),
            el('span', { className: 'small muted', textContent: (r.contact && r.contact.name) || r.to || '' }),
            r.reply && r.reply.snippet
              ? el('span', { className: 'snippet', textContent: `“${r.reply.snippet}”` })
              : null,
          );
        })
      : [el('li', { className: 'muted small', textContent: 'Emails you send and the replies to them show here.' })],
  );
  $('#home-stats-line').textContent = replyStats();
  // Not while it's being chosen: the choice is saved a moment later, and drawing the old one would undo it.
  if (document.activeElement !== $('#keep-ready'))
    $('#keep-ready').value = String((state.settings && state.settings.discoverAi.keepReady) || 0);
  keepReadyNote();
  const setup = [];
  if (!state.cvName) setup.push('No CV uploaded: emails go without one (Settings › Resume & files).');
  if (!canSearch() && aiReady())
    setup.push('Your AI provider can’t search the web: Claude or OpenRouter find people and reasons to write.');
  draw(
    $('#home-setup'),
    setup.length
      ? [
          el(
            'ul',
            { className: 'plain small muted' },
            setup.map((t) => el('li', { textContent: t })),
          ),
        ]
      : [],
  );
  refocus();
}

/** Under "Keep this many emails ready": what it's doing now. */
function keepReadyNote() {
  const want = (state.settings && state.settings.discoverAi.keepReady) || 0;
  const q = tally();
  $('#keep-ready-note').textContent = !want
    ? ''
    : !aiReady()
      ? NO_AI
      : !state.results.length
        ? 'Search for firms first: it prepares from your last search.'
        : `${q.ready} ready, ${q.working} being prepared. It tops up as you send.`;
}

/**
 * Prepare ahead: with "Keep this many emails ready" on, firms from the last search go into the queue (in the
 * background, without leaving the tab) until that many are ready or being prepared. Nothing is sent: each is read and
 * sent from Review as before.
 */
function topUp() {
  const want = (state.settings && state.settings.discoverAi.keepReady) || 0;
  if (!want || !review.live || review.leaving || !aiReady() || !state.results.length || !review.consent) return;
  const q = tally();
  // A firm that failed (a key that doesn't work, a refused permission) holds its place until it's dealt with: the
  // top-up never goes on through the whole search one failure after another.
  const short = want - q.ready - q.working - q.needYou;
  if (short <= 0) return;
  const next = nextToWrite(short);
  if (!next.length) return;
  for (const firm of next)
    review.items.push({ id: firm.id, firm, type: 'first', status: 'waiting', step: '', hooks: [], hook: 0 });
  pump();
  saveQueue();
  renderReview();
  if (state.results.length) renderResults();
}

/** The header's line on how things stand: the AI, the inbox, the CV. */
function renderHealth() {
  const pill = (tone, text, title) => el('span', { className: `pill ${tone}`, textContent: text, title });
  const inbox = state.nylas && state.nylas.grantId;
  $('#health').replaceChildren(
    aiReady() ? pill('ok', `AI: ${modelLabel(state.config)}`, 'Discover’s AI model') : pill('bad', 'No AI key', NO_AI),
    inbox
      ? pill('ok', 'Inbox connected', `Sends from ${state.nylas.email || 'your inbox'}`)
      : pill('warn', 'No inbox', 'Connect one under Settings › Email codes to send in one click'),
  );
}

const TABS = ['home', 'find', 'review', 'watch', 'outreach'];

function showTab(which) {
  for (const t of TABS) {
    $(`#tab-${t}`).setAttribute('aria-selected', String(which === t));
    $(`#${t}-view`).hidden = which !== t;
  }
  $(`#tab-${which}`).scrollIntoView({ block: 'nearest', inline: 'nearest' });
  history.replaceState(null, '', '#' + which);
  if (which === 'home') renderHome();
  // Newest first again each time the tab is opened (kept as drawn while it's on screen).
  if (which === 'outreach') renderOutreach(true);
  // What changed while it was hidden (a search's firms to write to next), and an alert's card now really on screen.
  if (which === 'review') renderReview();
  const box = which === 'review' && $('#review-card textarea.body');
  if (box) fitBox(box);
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
  renderHealth();
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
  // Each group's kinds ticked or unticked at once ("All" the finance kinds, "None" of the tech ones).
  const setAll = (root, on) => {
    for (const box of root.querySelectorAll('input[type="checkbox"]')) box.checked = on;
  };
  $('#niches').replaceChildren(
    ...[...byGroup]
      .filter(([, chips]) => chips.length)
      .map(([g, chips]) => {
        const group = el(
          'div',
          { className: 'niche-group', dataset: { group: g }, attrs: { role: 'group', 'aria-label': groups[g] || g } },
          el(
            'div',
            { className: 'niche-title' },
            el('span', { className: 'niche-head', textContent: groups[g] || g }),
            el('button', {
              className: 'link small niche-all',
              type: 'button',
              textContent: 'All',
              attrs: { 'aria-label': `All ${groups[g] || g} kinds` },
              onclick: () => setAll(group, true),
            }),
            el('button', {
              className: 'link small niche-none',
              type: 'button',
              textContent: 'None',
              attrs: { 'aria-label': `No ${groups[g] || g} kinds` },
              onclick: () => setAll(group, false),
            }),
          ),
          el('div', { className: 'chips' }, chips),
        );
        return group;
      }),
  );
  $('#niche-all').onclick = () => setAll($('#niches'), true);
  $('#niche-none').onclick = () => setAll($('#niches'), false);
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
  // The sticky search form and queue sit just under the bar, which wraps to two lines on a narrower window.
  const bar = $('.topbar');
  const fit = () => document.documentElement.style.setProperty('--bar', `${bar.offsetHeight}px`);
  if (typeof ResizeObserver === 'function') new ResizeObserver(fit).observe(bar);
  fit();
  const searched = restoreSearch();
  $('#query').addEventListener('submit', search);
  $('#more').addEventListener('click', () => ((state.shown += PAGE), renderResults()));
  $('#only-open').addEventListener('change', renderResults);
  $('#only-contact').addEventListener('change', renderResults);
  $('#sort-way').addEventListener('change', renderResults);
  $('#hide-written').addEventListener('change', (e) => {
    saveAi({ hideWritten: e.target.checked }).catch(() => null);
    renderResults();
  });
  // Picking firms: the top ten not written to, everything shown, or none; then write to them or watch them.
  $('#pick-top').addEventListener('click', () => {
    const index = writtenIndex();
    for (const r of visible()
      .filter((x) => !writtenTo(x.firm, index))
      .slice(0, TOP))
      pick(r.firm.id, true);
  });
  $('#pick-page').addEventListener('click', () => {
    for (const r of visible().slice(0, state.shown)) pick(r.firm.id, true);
  });
  $('#pick-none').addEventListener('click', () => {
    for (const id of [...state.picked]) pick(id, false);
  });
  $('#write-picked').addEventListener('click', () => {
    const firms = pickedFirms();
    for (const id of [...state.picked]) pick(id, false);
    writeTo(firms);
  });
  $('#watch-picked').addEventListener('click', async () => {
    const firms = pickedFirms().filter((f) => !state.watch.some((w) => w.id === f.id));
    for (const id of [...state.picked]) pick(id, false);
    status(`Watching ${plural(firms.length, 'firm')}…`);
    await D.pool(firms, 3, (f) => watchFirm(f));
    status(`Watching ${plural(firms.length, 'more firm')}: see the Watchlist.`);
  });
  $('#home-write').addEventListener('click', () => writeTo(nextToWrite()));
  $('#home-check-replies').addEventListener('click', (e) => lookForReplies(e.currentTarget));
  $('#outreach-replies').addEventListener('click', (e) => lookForReplies(e.currentTarget));
  $('#home-outreach').addEventListener('click', () => openOutreach('all'));
  $('#outreach-search').addEventListener('input', () => renderOutreach(true));
  $('#keep-ready').addEventListener('change', async (e) => {
    const n = Number(e.target.value) || 0;
    // Asked from the change itself (Firefox), and kept for the emails prepared ahead from now on.
    if (n) review.consent = requestAiConsent();
    await saveAi({ keepReady: n });
    state.settings = await store.getSettings();
    topUp();
    renderHome();
  });
  $('#check-top').addEventListener('click', checkTop);
  $('#write-top').addEventListener('click', () => writeTo(nextToWrite()));
  for (const r of document.querySelectorAll('input[name="ask"]'))
    r.addEventListener('change', () => r.checked && saveReviewChoice({ ask: r.value }));
  $('#their-morning').addEventListener('change', (e) => saveReviewChoice({ theirMorning: e.target.checked }));
  $('#common-ground').addEventListener('change', (e) => saveReviewChoice({ commonGround: e.target.checked }));
  document.addEventListener('keydown', reviewKeys);
  // Leaving the page while an email waits out its five seconds asks first; left, the email isn't sent (it's saved as
  // ready, with a word on why), as Undo would. A tab only hidden keeps counting.
  // One with Nylas (being sent, scheduled or saved) asks too: closed then, it may or may not have gone.
  // Only in the tab that has the queue: another's copy of an email with Nylas is that tab's to send.
  addEventListener('beforeunload', (e) => {
    if (review.live && (review.pending.size || review.items.some((i) => MOVING.has(i.status)))) e.preventDefault();
    // A drawer's email with Nylas too.
    if (Object.values(state.drafts).some((d) => d && d.sending === 'send')) e.preventDefault();
  });
  api.storage.onChanged.addListener((changes) => {
    if (changes.outreach) outreachChanged().catch(() => null);
    if (changes.nylas || changes.aiKeys || changes.settings) settingsChanged(changes).catch(() => null);
    if (changes.discoverCache) adoptQueue(changes.discoverCache.newValue);
    // A CV uploaded or removed in Settings meanwhile: what the card says is attached, and the doubt, follow it.
    if (Object.keys(changes).some((k) => /^doc:.*:resume$/.test(k)))
      cvFile()
        .then((doc) => {
          state.cvName = doc ? doc.name : '';
          // The line under the buttons, without drawing the email being read (and maybe typed in) again.
          const note = document.querySelector('#review-card .send-note');
          if (note && shown() && shown().status === 'ready') note.replaceWith(sendNote(shown()));
        })
        .catch(() => null);
  });
  $('#research-top').addEventListener('click', researchTop);
  $('#results-export').addEventListener('click', exportResults);
  $('#outreach-export').addEventListener('click', exportOutreach);
  // Leaving a note box draws what changed while it had the focus (a reply noted, a firm removed in another tab); left
  // by a press on a button or select in the list, once the press is over, so the row isn't replaced under it.
  let pressing = false;
  const pressed = () => pressing && ((pressing = false), setTimeout(() => renderOutreach(), 250));
  $('#outreach').addEventListener('pointerdown', () => (pressing = true));
  addEventListener('pointerup', pressed);
  addEventListener('pointercancel', pressed);
  $('#outreach').addEventListener(
    'focusout',
    (e) => e.target.matches('.outreach-notes') && !pressing && setTimeout(() => renderOutreach()),
  );
  for (const t of TABS) $(`#tab-${t}`).addEventListener('click', () => showTab(t));
  // The popup bringing this tab forward on one of its tabs (the watchlist's new roles).
  addEventListener('hashchange', () => TABS.includes(location.hash.slice(1)) && showTab(location.hash.slice(1)));
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
  document.addEventListener('visibilitychange', () =>
    document.visibilityState === 'hidden' ? flushNotes() : !$('#review-view').hidden && renderReview(),
  );
  addEventListener('pagehide', flushNotes);
  addEventListener('pagehide', leaveQueue);
  addEventListener('pagehide', leaveNotes);
  // Another Discover tab closed with a note not yet stored: stored from here straight away, and shown.
  addEventListener('storage', (e) => {
    if (e.key === NOTES_LEFT && e.newValue)
      storeLeftNotes().then(
        () => renderOutreach(),
        () => null,
      );
  });
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
  adoptPre();
  state.settings = await store.getSettings();
  $('#hide-written').checked = state.settings.discoverAi.hideWritten;
  buildFinderBox();
  // What a Hunter key alone makes possible (Find people) shows once the keys are read.
  syncAi();
  lookForReplies().catch(() => null);
  // And again every ten minutes while the page is open.
  setInterval(() => lookForReplies().catch(() => null), 10 * 60e3);
  // The tab asked for straight away; Review says it's opening while another Discover tab may still have the queue.
  // Without one, the Overview once there's something on it, else Find firms.
  const tab = location.hash.slice(1);
  const wrote = Object.values(state.outreach).some((r) => r && (r.sentAt || r.status !== 'drafted'));
  showTab(TABS.includes(tab) ? tab : wrote ? 'home' : 'find');
  await claimQueue();
  await loadReview();
  review.opening = false;
  review.readied();
  renderReview(true);
  // Preparing ahead goes on from where it was, without asking again where the AI may be used already.
  if (state.settings.discoverAi.keepReady && (await hasAiConsent())) review.consent = Promise.resolve(true);
  // The last search again, so its firms (and the next ten to write to) are there; never with the AI's ideas.
  if (searched) await search(null, { quiet: true });
  renderHome();
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
