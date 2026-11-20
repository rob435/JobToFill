/*
 * JobToFill — the application tracker page: every application you filled (the application log), how far each got,
 * the funnel and where you're being cut (lib/tracker.js), the emails it couldn't place, and the stage, notes and
 * removal you choose. With Settings › Application log › "Follow my applications in my inbox" on, the background reads
 * employers' emails through Nylas (background.js runTracker); every change here goes through the background too, so
 * it never crosses a look at the inbox writing the log.
 */
import { $, api, download, el, plural } from '../ui/common.js';

const { store, tracker: T } = globalThis.JTF;
const DAY = 24 * 3600 * 1000;

const state = {
  apps: [],
  tracker: null,
  settings: null,
  nylas: null,
  filter: 'all',
  query: '',
  open: new Set(),
  checking: false,
  pending: false,
};

const send = (message) => api.runtime.sendMessage(message);

/* ---------------------------------------------------------------- words */

const KIND_WORDS = {
  received: 'Application received',
  test: 'Test',
  interview: 'Interview',
  offer: 'Offer',
  rejected: 'Rejected',
};
const DETAIL_WORDS = {
  video: 'video interview',
  coding: 'coding test',
  game: 'game-based test',
  assessment: 'online test',
};
const TONE = { offer: 'ok', interview: 'ok', test: 'warn', rejected: 'bad', withdrawn: '', applied: '', filled: '' };

/** "11 Nov", or "11 Nov 2025" when it isn't this year. */
function dateText(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const opts = {
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}),
  };
  return d.toLocaleDateString('en-GB', opts);
}

/** "today", "yesterday", "12 days ago". */
function ago(ms) {
  const days = Math.floor((Date.now() - ms) / DAY);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
}

/** What an event was, in words: "Test (video interview)", "Rejected". */
const eventWords = (e) =>
  `${KIND_WORDS[e.kind] || e.kind}${e.detail && DETAIL_WORDS[e.detail] ? ` (${DETAIL_WORDS[e.detail]})` : e.detail ? ` (${e.detail})` : ''}`;

/** A stage as the page says it: "Rejected after an interview", "Rejected at the CV screen", "Test". */
function stageWords(a) {
  if (a.stage === 'rejected')
    return a.reached === 'interview' || a.reached === 'offer'
      ? 'Rejected after an interview'
      : a.reached === 'test'
        ? 'Rejected after a test'
        : 'Rejected at the CV screen';
  if (a.stage === 'withdrawn') return 'Withdrawn';
  return T.LABELS[a.stage] || 'Filled';
}

const employer = (a) => T.employerOf(a);
const newest = (a) => (a.events || []).filter((e) => !e.ignored).sort((x, y) => y.at - x.at)[0] || null;

/* ---------------------------------------------------------------- load */

async function load() {
  const [apps, tracker, settings, nylas] = await Promise.all([
    store.getHistory(),
    store.getTracker(),
    store.getSettings(),
    store.getNylas(),
  ]);
  state.apps = apps.map((a) => T.settle({ ...a }));
  Object.assign(state, { tracker, settings, nylas });
}

const following = () => !!(state.settings && state.settings.trackApplications && state.nylas && state.nylas.grantId);

/* ---------------------------------------------------------------- setup */

function renderSetup() {
  const on = !!state.settings.trackApplications;
  const inbox = !!(state.nylas && state.nylas.grantId);
  $('#setup').hidden = following();
  $('#track').checked = on;
  $('#setup-inbox').hidden = inbox;
  $('#status').hidden = !following();
  renderStatus();
}

/** The line under "Check my inbox now": the last look, what it found, or what went wrong. */
function renderStatus(text) {
  const line = $('#status-text');
  if (text) {
    line.textContent = text;
    return;
  }
  const run = state.tracker && state.tracker.lastRun;
  if (state.checking) line.textContent = 'Looking at your inbox…';
  else if (!run) line.textContent = 'Not looked at your inbox yet.';
  else if (run.error) line.textContent = `Couldn’t read your inbox ${ago(run.at)}: ${run.error}`;
  else
    line.textContent =
      [
        `Looked at your inbox ${ago(run.at)} at ${new Date(run.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}: ${plural(run.read || 0, 'new email')}, ${run.looked || 0} read in full`,
        run.news
          ? `${plural(run.news, 'update')} (${run.matched || 0} put on applications${run.unsorted ? `, ${run.unsorted} to sort` : ''})`
          : 'no news',
        run.more || run.behind ? 'more to read next time' : '',
      ]
        .filter(Boolean)
        .join(' · ') + '. It looks again every three hours.';
}

/* --------------------------------------------------------------- funnel */

function renderFunnel() {
  const f = T.funnel(state.apps);
  $('#totals').textContent = f.total
    ? `${plural(f.total, 'application')}${f.withdrawn ? `, ${f.withdrawn} withdrawn` : ''}`
    : '';
  const max = Math.max(1, f.total);
  $('#funnel').replaceChildren(
    ...f.stages.map((s) =>
      el(
        'li',
        { className: `stage stage-${s.stage}` },
        el('span', { className: 'count', textContent: String(s.count) }),
        el('span', { className: 'label', textContent: s.stage === 'filled' ? 'Filled' : s.label }),
        el(
          'span',
          { className: 'bar', attrs: { 'aria-hidden': 'true' } },
          el('span', { style: `width:${Math.round((s.count / max) * 100)}%` }),
        ),
        el('span', {
          className: 'muted small',
          textContent:
            s.share == null ? (s.stage === 'offer' ? '' : 'none yet') : `${Math.round(s.share * 100)}% went further`,
        }),
      ),
    ),
  );
  const r = f.rejected;
  $('#rejections').replaceChildren(
    ...[
      r.total
        ? `Rejected: ${r.screen} at the CV screen · ${r.test} after a test · ${r.interview} after an interview`
        : 'No rejections yet.',
      `${plural(f.offers, 'offer')} · ${f.open} still waiting`,
      f.silent ? `${f.silent} with no reply for ${T.SILENT_DAYS}+ days` : '',
    ]
      .filter(Boolean)
      .flatMap((t, i) => (i ? [el('br'), t] : [t])),
  );
  $('#diagnosis-list').replaceChildren(
    ...T.diagnose(state.apps).map((d) => el('li', { className: `finding ${d.tone}`, textContent: d.text })),
  );
}

/* ------------------------------------------------------------- unsorted */

/** "Jane Street Recruiting <…>" → "Jane Street": a guess at a new application's employer from the sender. */
function senderEmployer(from) {
  const name = String(from || '')
    .replace(/<[^>]*>/g, '')
    .replace(
      /\b(recruiting|recruitment|careers?|talent( acquisition)?|hiring( team)?|team|hr|no-?reply|jobs|early careers|campus|graduates?|people)\b/gi,
      '',
    )
    .replace(/[,|–—-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return name;
}

function renderUnsorted() {
  const list = (state.tracker && state.tracker.unsorted) || [];
  $('#unsorted').hidden = !list.length;
  $('#unsorted-title').textContent = `Emails to sort (${list.length})`;
  $('#unsorted-list').replaceChildren(
    ...list.map((u) => {
      const likely = (u.apps || []).filter((id) => state.apps.some((a) => a.id === id));
      const options = [
        ...likely.map((id) => state.apps.find((a) => a.id === id)),
        ...state.apps.filter((a) => !likely.includes(a.id)),
      ].map((a) => {
        const e = employer(a);
        return el('option', {
          value: a.id,
          textContent: `${e.company || a.host}${e.role ? ` · ${e.role}` : ''} (${dateText(a.date)})`,
        });
      });
      const pick = el(
        'select',
        { attrs: { 'aria-label': 'This is about' } },
        el('option', { value: '', textContent: 'This is about…' }),
        likely.length ? el('optgroup', { label: 'Could be' }, options.slice(0, likely.length)) : null,
        el('optgroup', { label: likely.length ? 'Or' : 'Your applications' }, options.slice(likely.length)),
        el('option', { value: 'new', textContent: 'A new application (one JobToFill didn’t fill)' }),
      );
      const company = el('input', {
        type: 'text',
        value: senderEmployer(u.from),
        hidden: true,
        attrs: { 'aria-label': 'Employer' },
        placeholder: 'Employer',
      });
      const put = el('button', {
        type: 'button',
        className: 'small primary',
        textContent: 'Put it there',
        disabled: true,
      });
      pick.addEventListener('change', () => {
        company.hidden = pick.value !== 'new';
        put.disabled = !pick.value;
      });
      put.addEventListener('click', () =>
        edit({ action: 'assign', messageId: u.messageId, id: pick.value, company: company.value }),
      );
      return el(
        'li',
        { className: 'unsorted-item' },
        el(
          'div',
          { className: 'row' },
          el('span', { className: `pill ${TONE[TARGET_OF[u.kind]] || ''}`.trim(), textContent: eventWords(u) }),
          el('strong', { textContent: u.subject || '(no subject)' }),
          el('span', { className: 'muted small', textContent: `${u.from} · ${dateText(u.at)}` }),
        ),
        u.quote ? el('blockquote', { textContent: `“${u.quote}”` }) : null,
        el('p', { className: 'muted small', textContent: `Not put on an application: ${u.why}.` }),
        el(
          'div',
          { className: 'row' },
          pick,
          company,
          put,
          el('button', {
            type: 'button',
            className: 'small',
            textContent: 'Not about an application',
            onclick: () => edit({ action: 'dismiss', messageId: u.messageId }),
          }),
        ),
      );
    }),
  );
}

/* ----------------------------------------------------------------- list */

const FILTERS = [
  ['all', 'All', () => true],
  ['waiting', 'Waiting', (a) => !['rejected', 'withdrawn', 'offer'].includes(a.stage)],
  ['filled', 'Filled', (a) => a.stage === 'filled'],
  ['applied', 'Applied', (a) => a.stage === 'applied'],
  ['test', 'Test', (a) => a.stage === 'test'],
  ['interview', 'Interview', (a) => a.stage === 'interview'],
  ['offer', 'Offer', (a) => a.stage === 'offer'],
  ['rejected', 'Rejected', (a) => a.stage === 'rejected'],
  ['withdrawn', 'Withdrawn', (a) => a.stage === 'withdrawn'],
  ['silent', `No reply for ${T.SILENT_DAYS}+ days`, (a) => T.silent(a, Date.now())],
];

/** Does an application hold every word searched for (its employer, role, site, emails and notes)? */
function matches(a, query) {
  const e = employer(a);
  const hay = [
    e.company,
    e.role,
    a.host,
    a.location,
    a.notes,
    ...(a.events || []).flatMap((x) => [x.subject, x.quote, x.from]),
  ]
    .join(' ')
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

function renderChips() {
  // A stage nothing is at has no chip (unless it's the one shown).
  const chips = FILTERS.map(([key, label, test]) => [key, label, state.apps.filter(test).length]).filter(
    ([key, , n]) => n || key === 'all' || key === state.filter,
  );
  $('#chips').replaceChildren(
    ...chips.map(([key, label, n]) => {
      return el('button', {
        type: 'button',
        className: 'chip',
        textContent: `${label} ${n}`,
        attrs: { 'aria-pressed': String(state.filter === key) },
        onclick: () => {
          state.filter = key;
          renderList();
        },
      });
    }),
  );
}

/** The stage chooser: the stage the emails give, or one you set (it wins over the emails before it). */
function stageControl(a) {
  const auto = T.settle({ ...a, manual: null });
  const select = el(
    'select',
    { attrs: { 'aria-label': `Stage of ${employer(a).company || a.host}` } },
    el('option', { value: '', textContent: `From emails: ${stageWords(auto)}` }),
    [...T.STAGES, ...T.OUTCOMES].map((s) => el('option', { value: s, textContent: `${T.LABELS[s]} (set by you)` })),
  );
  select.value = a.manual ? a.manual.stage : '';
  select.addEventListener('change', () => edit({ action: 'stage', id: a.id, stage: select.value || null }));
  return select;
}

function detailRow(a) {
  const events = [...(a.events || [])].sort((x, y) => y.at - x.at);
  const notes = el('textarea', {
    value: a.notes || '',
    rows: 2,
    placeholder: 'Notes: who you spoke to, the next date…',
    attrs: { 'aria-label': 'Notes' },
  });
  let timer = null;
  notes.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => edit({ action: 'notes', id: a.id, notes: notes.value }, { quiet: true }), 500);
  });
  const links = [
    /^https?:/.test(a.url || '')
      ? el('a', { href: a.url, target: '_blank', rel: 'noopener', textContent: 'The application page' })
      : null,
    /^https?:/.test(a.jobUrl || '')
      ? el('a', { href: a.jobUrl, target: '_blank', rel: 'noopener', textContent: 'The job posting' })
      : null,
  ].filter(Boolean);
  return el(
    'tr',
    { className: 'detail', dataset: { for: a.id } },
    el(
      'td',
      { colSpan: 6 },
      el(
        'div',
        { className: 'detail-body' },
        el(
          'label',
          { className: 'row stage-pick' },
          el('span', { className: 'muted small', textContent: 'Stage' }),
          stageControl(a),
        ),
        events.length
          ? el(
              'ol',
              { className: 'timeline' },
              events.map((e) =>
                el(
                  'li',
                  { className: e.ignored ? 'ignored' : '' },
                  el('span', { className: `pill ${TONE[TARGET_OF[e.kind]] || ''}`.trim(), textContent: eventWords(e) }),
                  el('span', { className: 'muted small', textContent: `${dateText(e.at)} · ${e.from}` }),
                  el('strong', { textContent: e.subject || '(no subject)' }),
                  e.quote ? el('blockquote', { textContent: `“${e.quote}”` }) : null,
                ),
              ),
            )
          : el('p', {
              className: 'muted small',
              textContent: following()
                ? 'No email about it yet.'
                : 'Emails about it show here once JobToFill follows your applications in your inbox.',
            }),
        el(
          'p',
          { className: 'muted small' },
          `Filled ${dateText(a.date)}${a.filled ? ` (${plural(a.filled, 'field')})` : ''}${a.profile ? ` with the profile ${a.profile}` : ''}${a.location ? ` · ${a.location}` : ''}`,
          ...links.flatMap((l) => [' · ', l]),
        ),
        notes,
        el(
          'div',
          { className: 'row' },
          el('button', {
            type: 'button',
            className: 'small danger',
            textContent: 'Remove',
            onclick: () => {
              if (confirm(`Remove ${employer(a).company || a.host} from your applications?`))
                edit({ action: 'remove', id: a.id });
            },
          }),
        ),
      ),
    ),
  );
}

const TARGET_OF = { received: 'applied', test: 'test', interview: 'interview', offer: 'offer', rejected: 'rejected' };

function renderList() {
  renderChips();
  const test = (FILTERS.find((f) => f[0] === state.filter) || FILTERS[0])[2];
  const shown = state.apps.filter(test).filter((a) => !state.query || matches(a, state.query));
  $('#empty').hidden = state.apps.length > 0;
  $('#empty').textContent = 'Nothing yet. Fill a job application and it shows up here.';
  const rows = shown.flatMap((a) => {
    const e = employer(a);
    const last = newest(a);
    const open = state.open.has(a.id);
    const row = el(
      'tr',
      { dataset: { id: a.id }, className: `app stage-${a.stage}` },
      el(
        'td',
        { className: 'firm' },
        el('strong', { textContent: e.company || a.host || '' }),
        a.location ? el('div', { className: 'muted small', textContent: a.location }) : null,
      ),
      el('td', { className: 'role', textContent: e.role || a.title || '' }),
      el('td', { className: 'when', textContent: dateText(a.date), title: new Date(a.date).toLocaleString() }),
      el(
        'td',
        { className: 'stage-cell' },
        el('span', { className: `pill ${TONE[a.stage] || ''}`.trim(), textContent: stageWords(a) }),
        a.manual ? el('div', { className: 'muted small yours', textContent: 'Set by you' }) : null,
      ),
      el(
        'td',
        { className: 'latest' },
        last
          ? [
              el('span', { textContent: last.subject || eventWords(last), title: last.quote || '' }),
              el('div', { className: 'muted small', textContent: `${eventWords(last)} · ${dateText(last.at)}` }),
            ]
          : el('span', { className: 'muted small', textContent: `No news · ${ago(a.date)}` }),
      ),
      el(
        'td',
        { className: 'more' },
        el('button', {
          type: 'button',
          className: 'small ghost',
          textContent: open ? 'Less' : 'More',
          attrs: { 'aria-expanded': String(open) },
          onclick: () => {
            if (state.open.has(a.id)) state.open.delete(a.id);
            else state.open.add(a.id);
            renderList();
          },
        }),
      ),
    );
    return open ? [row, detailRow(a)] : [row];
  });
  $('#apps tbody').replaceChildren(...rows);
  $('#apps').hidden = !shown.length;
}

/* ------------------------------------------------------------------ CSV */

function toCsv(apps) {
  const cell = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const header = [
    'Date applied',
    'Employer',
    'Role',
    'Stage',
    'Got as far as',
    'Stage since',
    'Latest email',
    'Latest email date',
    'Location',
    'Application page',
    'Job posting',
    'Site',
    'Fields filled',
    'Profile',
    'Notes',
  ];
  const rows = apps.map((a) => {
    const e = employer(a);
    const last = newest(a);
    const iso = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '');
    return [
      iso(a.date),
      e.company,
      e.role,
      stageWords(a),
      T.LABELS[a.reached] || '',
      iso(a.stageAt),
      last ? last.subject : '',
      last ? iso(last.at) : '',
      a.location,
      a.url,
      a.jobUrl,
      a.host,
      a.filled,
      a.profile,
      a.notes,
    ];
  });
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\n');
}

/* ---------------------------------------------------------------- write */

/** A change, made by the background (see editApplications), then the page drawn again from what is stored. */
async function edit(message, { quiet = false } = {}) {
  const r = await send({ type: 'jtf:tracker-edit', ...message }).catch((err) => ({
    error: String(err.message || err),
  }));
  if (r && r.error) renderStatus(`Couldn’t save that: ${r.error}`);
  if (!quiet) await refresh();
}

async function check() {
  if (state.checking || !following()) return;
  state.checking = true;
  $('#check').disabled = true;
  renderStatus();
  try {
    const r = await send({ type: 'jtf:tracker-check' });
    await load();
    renderStatus(r && r.error ? `Couldn’t read your inbox: ${r.error}` : undefined);
  } finally {
    state.checking = false;
    $('#check').disabled = false;
  }
  render();
}

/* --------------------------------------------------------------- render */

function render() {
  renderSetup();
  renderFunnel();
  renderUnsorted();
  renderList();
}

/** Drawn again from storage; not while a box on the page is being typed in (it would lose what's typed), but after. */
async function refresh() {
  const active = document.activeElement;
  if (
    active &&
    active.matches &&
    active.matches('textarea, input[type="text"], select') &&
    active.closest('#apps, #unsorted')
  ) {
    state.pending = true;
    return;
  }
  state.pending = false;
  await load();
  render();
}

async function boot() {
  await load();
  render();
  $('#track').addEventListener('change', async (e) => {
    state.settings = await store.saveSettings({ trackApplications: e.target.checked });
    render();
    if (following()) check();
  });
  $('#stop-tracking').addEventListener('click', async () => {
    state.settings = await store.saveSettings({ trackApplications: false });
    render();
  });
  $('#open-email').addEventListener('click', () =>
    api.tabs.create({ url: api.runtime.getURL('options/options.html#email') }),
  );
  $('#check').addEventListener('click', check);
  $('#search').addEventListener('input', (e) => {
    state.query = e.target.value.trim();
    renderList();
  });
  $('#export').addEventListener('click', () =>
    download(new Blob([toCsv(state.apps)], { type: 'text/csv' }), 'jobtofill-applications.csv'),
  );
  document.addEventListener('focusout', () => setTimeout(() => state.pending && refresh(), 0));
  // A fill, a look at the inbox or another page changing the log or the settings: drawn again.
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.history || changes.tracker || changes.settings || changes.nylas) refresh();
  });
  // A look at the inbox as the page opens, unless one ran in the last ten minutes.
  const run = state.tracker && state.tracker.lastRun;
  if (following() && (!run || Date.now() - run.at > 10 * 60000)) check();
}

boot();
