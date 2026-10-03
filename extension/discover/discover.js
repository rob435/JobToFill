/*
 * JobToFill — Discover internships. Finds reputable firms that keep a low profile (small hedge funds,
 * quant shops, boutique advisers…) from a bundled registry built from the SEC's adviser register and
 * Wikipedia, leaves out the ones Trackr already lists, reads each firm's own careers pages and job boards
 * for student roles, and keeps a watchlist that the background re-checks.
 */
import { $, api, el, hasSiteAccess, plural, requestAiConsent, requestSiteAccess } from '../ui/common.js';

const { store, ai, discover: D } = globalThis.JTF;

const PAGE = 25;
const CHECK_AGE = 12 * 3600e3; // a careers check is reused for half a day
const TRACKR_AGE = 24 * 3600e3;

const state = {
  firms: [],
  built: '',
  trackr: null,
  results: [], // [{ firm, score, reasons, flags, why? }]
  shown: PAGE,
  checks: {}, // firmId → { at, result } (careers())
  running: new Set(),
  watch: [],
  watchStates: {},
  config: null,
};

const send = (message) => api.runtime.sendMessage(message);
const fetchFn = (url, init) => fetch(url, init);

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

/** Trackr's company list (cached for a day), to leave out firms students already hear about. */
async function loadTrackr(force) {
  const cache = await store.getDiscoverCache();
  state.checks = cache.careers || {};
  if (!force && cache.trackr && Date.now() - cache.trackr.at < TRACKR_AGE) {
    state.trackr = cache.trackr;
    return;
  }
  const list = await D.trackrCompanies({ fetch: fetchFn });
  if (list.answered) {
    state.trackr = list;
    await store.setDiscoverCache({ trackr: list });
  } else if (cache.trackr) state.trackr = cache.trackr;
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
    seedNames,
    seeds: seedNames.map((n) => D.lookup(state.firms, n)).filter(Boolean),
  };
}

function status(text, error) {
  $('#status').textContent = text;
  $('#status').classList.toggle('error', !!error);
}

async function search(event) {
  if (event) event.preventDefault();
  const useAi = $('#use-ai').checked;
  // Firefox asks before page text goes to the AI provider; the request must come straight from the click.
  const consent = useAi ? requestAiConsent() : Promise.resolve(true);
  const q = readQuery();
  $('#search').disabled = true;
  try {
    status('Checking which firms Trackr lists…');
    await loadTrackr().catch(() => null);
    const results = D.search(state.firms, q, { trackr: state.trackr });
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
    renderResults();
    const left =
      state.trackr && q.hideTrackr
        ? ` Trackr lists ${state.trackr.names.length.toLocaleString('en-GB')} names; those are left out.`
        : '';
    status(`${plural(results.length, 'firm')} match.${left}`);
    if (useAi) await askAi(q, await consent);
  } catch (err) {
    status(String((err && err.message) || err), true);
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
    const st = D.standing(firm, { trackr: state.trackr });
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

async function askAi(q, consented) {
  state.config = await store.aiConfig();
  const problem = ai.problem(state.config);
  if (problem) return status(`${problem} (Settings › Cover letters) The registry results are above.`, true);
  if (!consented) return status('Firefox didn’t allow sending the search to your AI provider.', true);
  status('Asking the AI for more firms, then checking each one…');
  const exclude = state.results.slice(0, 60).map((r) => r.firm.name);
  const chat = (messages, options) => ai.chat(state.config, { messages, ...options });
  const { found, rejected } = await D.suggest(chat, q, state.firms, { fetch: fetchFn, exclude });
  let added = 0;
  for (const f of found) {
    if (state.results.some((r) => r.firm.id === f.firm.id)) continue;
    const st = D.standing(f.firm, { trackr: state.trackr });
    if (q.hideTrackr && st.onTrackr) continue;
    state.results.splice(Math.min(added * 3, state.results.length), 0, {
      firm: f.firm,
      score: 1,
      reasons: [...new Set([...f.reasons, ...st.reasons])],
      flags: { onTrackr: st.onTrackr, ai: true },
      why: f.why,
    });
    added++;
  }
  renderResults();
  renderRejected(rejected);
  status(
    `The AI suggested ${plural(found.length + rejected.length, 'firm')}: ${added} new and checked, ${rejected.length} left out because they couldn’t be verified.`,
  );
}

/* --------------------------------------------------------------- careers */

async function checkFirm(firm, { force } = {}) {
  const cached = state.checks[firm.id];
  if (!force && cached && Date.now() - cached.at < CHECK_AGE) return cached.result;
  if (state.running.has(firm.id)) return null;
  state.running.add(firm.id);
  rerender(firm.id);
  try {
    const result = await D.careers(firm, { fetch: fetchFn });
    state.checks[firm.id] = { at: Date.now(), result };
    await store.setDiscoverCache({ careers: { [firm.id]: state.checks[firm.id] } });
    return result;
  } finally {
    state.running.delete(firm.id);
    rerender(firm.id);
  }
}

async function checkTop() {
  const list = visible()
    .slice(0, 10)
    .filter((r) => !state.checks[r.firm.id]);
  const button = $('#check-top');
  button.disabled = true;
  try {
    await D.pool(list, 3, (r) => checkFirm(r.firm));
  } finally {
    button.disabled = false;
  }
}

const hasOpen = (result) => !!result && (result.status === 'roles' || result.status === 'programme');

/* ------------------------------------------------------------ rendering */

function visible() {
  return $('#only-open').checked
    ? state.results.filter((r) => hasOpen((state.checks[r.firm.id] || {}).result))
    : state.results;
}

function money(bn) {
  return bn >= 10 ? `$${Math.round(bn)}bn` : bn >= 1 ? `$${bn.toFixed(1)}bn` : `$${Math.round(bn * 1000)}m`;
}

function meta(firm) {
  const parts = [];
  if (firm.cities.length) parts.push(firm.cities.slice(0, 3).join(', '));
  if (firm.employees != null) parts.push(`${firm.employees.toLocaleString('en-GB')} staff`);
  if (firm.aum) parts.push(`${money(firm.aum)} AUM`);
  return parts.join(' · ');
}

function badges(firm, flags) {
  const out = [];
  if (firm.crd) out.push(el('span', { className: 'pill ok', textContent: 'SEC-registered', title: `CRD ${firm.crd}` }));
  if (firm.wiki)
    out.push(
      el('a', {
        className: 'pill',
        textContent: 'Wikipedia',
        href: `https://en.wikipedia.org/wiki/${encodeURIComponent(firm.wiki.replace(/ /g, '_'))}`,
        target: '_blank',
        rel: 'noopener',
      }),
    );
  if (flags && flags.ai) out.push(el('span', { className: 'pill warn', textContent: 'AI idea · verified' }));
  if (flags && flags.onTrackr) out.push(el('span', { className: 'pill', textContent: 'On Trackr' }));
  else if (state.trackr) out.push(el('span', { className: 'pill ok', textContent: 'Not on Trackr' }));
  for (const t of firm.tags.slice(0, 3)) {
    const niche = D.NICHES[t];
    out.push(el('span', { className: 'pill', textContent: niche ? niche.label : t }));
  }
  return el('div', { className: 'badges' }, out);
}

const STATUS_TEXT = {
  roles: ['ok', 'Student roles open'],
  programme: ['ok', 'Programme page'],
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
          el('a', { href: r.url, target: '_blank', rel: 'noopener', textContent: r.title }),
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

function foundView(result) {
  const [tone, text] = STATUS_TEXT[result.status] || ['', result.status];
  const boardText = result.boards
    .filter((b) => b.slug || b.ats === 'phenom')
    .map((b) => `${b.ats}${b.found === 'guessed' ? ' (matched by name)' : ''}`)
    .join(', ');
  return el(
    'div',
    { className: 'found' },
    el(
      'div',
      { className: 'row small' },
      el('span', { className: `pill ${tone}`, textContent: text }),
      boardText ? el('span', { className: 'muted', textContent: `Board: ${boardText}` }) : null,
      result.other ? el('span', { className: 'muted', textContent: `${plural(result.other, 'other job')}` }) : null,
    ),
    result.roles.length ? rolesList(result.roles) : null,
    programmesList(result.programmes),
    result.emails.length
      ? el(
          'p',
          { className: 'small' },
          'Apply by email: ',
          ...result.emails.map((e) => el('a', { href: 'mailto:' + e, textContent: e + ' ' })),
        )
      : null,
    result.pages.length
      ? el(
          'p',
          { className: 'small' },
          'Careers pages: ',
          ...result.pages
            .slice(0, 3)
            .map((u, i) =>
              el('a', { href: u, target: '_blank', rel: 'noopener', textContent: (i ? ' · ' : '') + shortUrl(u) }),
            ),
        )
      : null,
    el(
      'details',
      {},
      el('summary', { textContent: 'What was checked' }),
      el(
        'ul',
        { className: 'plain log' },
        result.log.map((l) => el('li', { textContent: `${l.outcome}: ${l.url}` })),
      ),
    ),
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
    r.reasons.length || r.why
      ? el('p', {
          className: 'firm-why',
          textContent: [r.why, ...r.reasons.filter((x) => !/^SEC-registered adviser$|^Wikipedia article$/.test(x))]
            .filter(Boolean)
            .join(' · '),
        })
      : null,
    el(
      'div',
      { className: 'firm-actions' },
      el('button', {
        className: 'small' + (check ? '' : ' primary'),
        type: 'button',
        disabled: running,
        textContent: running ? 'Checking…' : check ? 'Check again' : 'Check careers',
        onclick: () => checkFirm(firm, { force: !!check }),
      }),
      el('button', {
        className: 'small',
        type: 'button',
        textContent: watched ? 'Watching' : 'Watch',
        disabled: watched,
        onclick: () => watchFirm(firm),
      }),
      firm.site
        ? el('a', {
            className: 'small',
            href: firm.site,
            target: '_blank',
            rel: 'noopener',
            textContent: firm.domain || 'Website',
          })
        : null,
    ),
    check ? foundView(check.result) : null,
  );
}

function renderResults() {
  const list = visible();
  $('#results-card').hidden = false;
  $('#results-title').textContent = plural(list.length, 'firm');
  $('#results').replaceChildren(...list.slice(0, state.shown).map(firmCard));
  $('#more').hidden = list.length <= state.shown;
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
  $('#watch-empty').hidden = !!state.watch.length;
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
        w.pages[0]
          ? el('a', {
              className: 'small',
              href: w.pages[0],
              target: '_blank',
              rel: 'noopener',
              textContent: 'Careers page',
            })
          : null,
        w.firm.site
          ? el('a', {
              className: 'small',
              href: w.firm.site,
              target: '_blank',
              rel: 'noopener',
              textContent: w.firm.domain,
            })
          : null,
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

function showTab(which) {
  $('#tab-find').setAttribute('aria-selected', String(which === 'find'));
  $('#tab-watch').setAttribute('aria-selected', String(which === 'watch'));
  $('#find-view').hidden = which !== 'find';
  $('#watch-view').hidden = which !== 'watch';
  history.replaceState(null, '', which === 'watch' ? '#watch' : '#');
}

/* ------------------------------------------------------------------ init */

function buildForm() {
  $('#niches').replaceChildren(
    ...Object.entries(D.NICHES).map(([id, n]) =>
      el(
        'label',
        { className: 'chip' },
        el('input', { type: 'checkbox', value: id, checked: id === 'hedge' }),
        n.label,
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
  $('#check-top').addEventListener('click', checkTop);
  $('#tab-find').addEventListener('click', () => showTab('find'));
  $('#tab-watch').addEventListener('click', () => showTab('watch'));
  $('#watch-check').addEventListener('click', checkWatchNow);
  $('#watch-seen').addEventListener('click', markSeen);
  state.config = await store.aiConfig();
  $('#use-ai').disabled = !!ai.problem(state.config);
  if ($('#use-ai').disabled) $('#ai-wrap').title = 'Add an AI key under Settings › Cover letters first.';
  await Promise.all([
    loadRegistry(),
    loadWatch(),
    store.getDiscoverCache().then((c) => (state.checks = c.careers || {})),
  ]);
  showTab(location.hash === '#watch' ? 'watch' : 'find');
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

boot().catch((err) => status(String((err && err.message) || err), true));
