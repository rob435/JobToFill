/*
 * JobToFill — the page map viewer: the page in a tab (?tab=<id>) the way JobToFill and the AI see it (lib/pagemap.js),
 * opened from the popup's Page map. Every field with its ref, question, options, state and what the rules take it
 * for; a click on its line shows it on the page. Shown as it is in this browser (values 'state': what is picked, never
 * what is typed); Copy and Save hand over the redacted map (values 'redacted': your details as placeholders), as a
 * snapshot carries it. The page's text is the page's: it only ever goes in as text, never as markup.
 */
import { $, api, download, el, plural, requestSiteAccess } from '../ui/common.js';

const params = new URLSearchParams(location.search);
const tabId = params.has('tab') ? Number(params.get('tab')) : null;
// The viewer has room for a long page whole (the AI's own budget is 24,000 characters).
const MAX_CHARS = 60000;
const LEGEND_KEY = 'jtf-pagemap-legend';
// prettier-ignore
const PLATFORMS = {
  workday: 'Workday', greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', icims: 'iCIMS',
  successfactors: 'SuccessFactors', oracle: 'Oracle', taleo: 'Taleo', jobvite: 'Jobvite', workable: 'Workable',
  teamtailor: 'Teamtailor', avature: 'Avature',
};
// The first line of what is copied or saved: what the rest is, for whoever (or whichever model) reads it.
const HEADER =
  'JobToFill page map: this web page as text, the way the JobToFill extension sees it. f1, f2… are its fields, each ' +
  'with its question, options, what is picked (never what is typed) and → what JobToFill takes it for, then ✓ when ' +
  'it has the answer, ✗ no value when it hasn’t, or (none: for AI) when no rule knows the question; b1… are buttons ' +
  'and i1… frames. Personal details are replaced with placeholders such as [first name].';
const NEEDS_ACCESS = /access to this site/i;

const state = {
  map: null,
  lines: [],
  nodes: [],
  byRef: new Map(),
  url: '',
  at: 0,
  busy: false,
  marks: false,
  closed: false,
  away: false,
};
const send = (message) => api.runtime.sendMessage({ tabId, ...message });

/* ------------------------------------------------------------ the lines */

const HEAD = /^(PAGE|FIELDS|PROGRESS|ALERT|OVERLAY) /;
const KINDS = { f: 'field', b: 'action', i: 'iframe' };

/** What a field still needs: an answer the profile lacks, one for the AI, a fix, or a required one that's empty. */
const needs = (f) =>
  !!f && ((f.rules && f.rules.status === 'empty') || !!f.forAi || !!f.invalid || (!!f.required && !f.hasValue));

/**
 * The text map as lines: depth (two spaces a level), kind (meta, heading, landmark, text, field, action, iframe,
 * frame, note) and, for a field, button or frame, its ref and its entry in the map.
 */
function parse(text, map) {
  const items = new Map([...map.fields, ...map.actions, ...map.iframes].map((x) => [x.ref, x]));
  let head = true;
  return String(text || '')
    .split('\n')
    .map((raw, index) => {
      const body = raw.replace(/^ +/, '');
      const depth = Math.floor((raw.length - body.length) / 2);
      const ref = (body.match(/^([fbi]\d+) /) || [])[1];
      let kind = 'text';
      if (head && depth === 0 && HEAD.test(body)) kind = body.startsWith('ALERT') ? 'meta alert' : 'meta';
      else {
        head = false;
        if (ref && items.has(ref)) kind = KINDS[ref[0]];
        else if (/^#{1,6} /.test(body)) kind = 'heading';
        else if (body.startsWith('[')) kind = 'landmark';
        else if (/^FRAME \d+ /.test(body)) kind = 'frame';
        else if (body.startsWith('… ') || body.startsWith('(this page')) kind = 'note';
      }
      const item = ref && items.has(ref) ? items.get(ref) : null;
      return { index, body, depth, kind, ref: item ? ref : null, item, lower: body.toLowerCase() };
    });
}

/** A line cut into the page's own words (in quotes) and what JobToFill says about them. */
function chunks(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf('"', i);
    if (open < 0) {
      out.push({ text: s.slice(i), quoted: false });
      break;
    }
    // The closing quote is one followed by a space, a comma, a bracket or the end: a question may quote too.
    let close = s.indexOf('"', open + 1);
    while (close >= 0 && close < s.length - 1 && !/[\s,\])]/.test(s[close + 1])) close = s.indexOf('"', close + 1);
    if (close < 0) close = s.length - 1;
    if (open > i) out.push({ text: s.slice(i, open), quoted: false });
    out.push({ text: s.slice(open, close + 1), quoted: true });
    i = close + 1;
  }
  return out;
}

// What JobToFill says about a field, button or frame, outside the page's words: the first match in a chunk wins.
const MARKS = [
  [/→ \(none: for AI\)/, 'ai'],
  [/→ \(none\)/, 'none'],
  [/→ custom answer|→ \S+/, 'rule'],
  [/✓/, 'ok'],
  [/✗ no value/, 'missing'],
  [/\((?:secret|left for you|upload|CAPTCHA, not mapped|not mapped)\)/, 'aside'],
  [/\(answer withheld\)/, 'withheld'],
  [/\(AI answer\)/, 'ai'],
  [/INVALID|validity=\S+/, 'bad'],
  [/fill=filled\b/, 'fill'],
  [/fill=.+?(?=\s*$| INVALID| validity=)/, 'fill-warn'],
  [/\[[^\]]*\]|\(\d+ options: .*?\)(?= |$)/, 'opts'],
  [
    /\((?:next|back|submit|save|add|remove|upload|signin|signup|apply|accept-cookies|reject-cookies|close|other)\)/,
    'intent',
  ],
];

/** Spans for one chunk of a line outside quotes, its marks picked out. */
function marked(text) {
  const out = [];
  let rest = text;
  while (rest) {
    let best = null;
    for (const [re, cls] of MARKS) {
      const m = rest.match(re);
      if (m && (!best || m.index < best.m.index)) best = { m, cls };
    }
    if (!best) {
      out.push(rest);
      break;
    }
    if (best.m.index) out.push(rest.slice(0, best.m.index));
    out.push(el('span', { className: `tok-${best.cls}`, textContent: best.m[0] }));
    rest = rest.slice(best.m.index + best.m[0].length);
  }
  return out;
}

const STATUS_CLASS = { ok: 'ok', empty: 'empty', secret: 'secret', consent: 'aside', file: 'aside' };

/** A ref's badge, coloured as the refs drawn on the page are: by what the rules make of a field, buttons, frames. */
function badge(line) {
  const status = line.kind === 'field' ? STATUS_CLASS[(line.item.rules || {}).status] || 'unknown' : line.kind;
  return el('span', { className: `ref ${status}`, textContent: line.ref });
}

/** The nodes for a line of a field, button or frame: its ref, kind, name and the marks after it. */
function itemNodes(line) {
  const nodes = [badge(line), ' '];
  let named = false;
  let bad = false;
  for (const c of chunks(line.body.slice(line.ref.length + 1))) {
    if (c.quoted) {
      // The first quote is its question (a button's or frame's name); one after INVALID is the page's message.
      const cls = !named ? 'tok-q' : bad ? 'tok-bad' : 'tok-quote';
      nodes.push(el('span', { className: cls, textContent: c.text }));
      named = true;
    } else {
      // Before the question: the kind ("text*"), and "(no question)" when there is none.
      const none = named ? null : c.text.match(/^(.*?\(no (?:question|label)\))(.*)$/s);
      const kind = named ? '' : none ? none[1] : c.text;
      if (kind) nodes.push(el('span', { className: 'tok-kind', textContent: kind }));
      if (!named && none) named = true;
      const rest = kind === c.text ? '' : none ? none[2] : c.text;
      if (rest) nodes.push(...marked(rest));
      bad = /INVALID\s*$/.test(c.text);
    }
  }
  return nodes;
}

/** The nodes for any other line: a heading, landmark, page text, a frame or the lines above the outline. */
function plainNodes(line) {
  const m = line.kind.startsWith('meta') && line.body.match(HEAD);
  if (m) return [el('b', { textContent: m[1] }), line.body.slice(m[1].length)];
  return [line.body];
}

/** One line of the outline: a button that shows its field, button or frame on the page, else plain. */
function lineNode(line) {
  const inner = line.ref
    ? el(
        'button',
        { type: 'button', className: 'go', title: `Show ${line.ref} on the page`, dataset: { ref: line.ref } },
        itemNodes(line),
      )
    : el('span', { className: 'words' }, plainNodes(line));
  const node = el('div', { className: `line ${line.kind}`, attrs: { role: 'listitem' } }, inner);
  node.style.setProperty('--depth', String(line.depth));
  return node;
}

/* -------------------------------------------------------------- showing */

/** Say something in the line under the toolbar ('ok', 'warn', 'error' or nothing). */
function say(text, tone) {
  const status = $('#status');
  status.textContent = text || '';
  status.className = `status small${tone ? ' ' + tone : ''}`;
}

const pad = (n) => String(n).padStart(2, '0');
const clock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** The card at the top: the page, where it is, and its numbers. */
function renderSummary(map) {
  const host = map.host || hostOf(state.url);
  $('#page-title').textContent = map.title || host || 'Untitled page';
  const p = map.progress;
  const step = p
    ? p.step && p.total
      ? `Step ${p.step} of ${p.total}${p.label ? `: ${p.label}` : ''}`
      : p.text || p.label || ''
    : '';
  const platform = map.platform ? PLATFORMS[map.platform] || map.platform : '';
  $('#page-where').textContent = [host, platform, step, `mapped at ${clock(new Date(state.at))}`]
    .filter(Boolean)
    .join(' · ');
  const c = map.counts || {};
  const fields = map.fields.length;
  const need = map.fields.filter(needs).length;
  const frames = map.frames.length;
  const pill = (n, word, tone, title) =>
    el(
      'li',
      { className: `pill${tone ? ' ' + tone : ''}`, title: title || '' },
      el('b', { textContent: String(n) }),
      ` ${word}`,
    );
  const pills = [
    pill(fields, fields === 1 ? 'field' : 'fields'),
    pill(c.required || 0, 'required'),
    pill(c.filled || 0, 'filled'),
    pill(c.invalid || 0, 'invalid', c.invalid ? 'bad' : '', 'Fields the page says are wrong'),
    pill(map.actions.length, map.actions.length === 1 ? 'action' : 'actions', '', 'Buttons that act on the form'),
    frames > 1 ? pill(frames, 'frames', '', 'The page and the frames embedded in it') : null,
    fields
      ? need
        ? pill(
            need,
            need === 1 ? 'needs something' : 'need something',
            'warn',
            'No answer, left for the AI, invalid, or required and empty',
          )
        : el('li', { className: 'pill ok', textContent: 'Nothing missing' })
      : null,
  ];
  $('#counts').replaceChildren(...pills.filter(Boolean));
  $('#no-fields').hidden = fields > 0;
}

/** The outline, line by line; the line that had focus (a refresh) gets it back. */
function renderOutline(focusRef) {
  const outline = $('#outline');
  state.nodes = state.lines.map(lineNode);
  outline.replaceChildren(...state.nodes);
  outline.setAttribute('aria-busy', 'false');
  outline.setAttribute('aria-label', `Page map of ${state.map.title || state.map.host || 'this page'}`);
  applyFilter();
  if (focusRef) {
    const again = outline.querySelector(`button.go[data-ref="${focusRef}"]`);
    if (again && !again.closest('[hidden]')) again.focus();
  }
}

/** A map from the background ({ map, text }) on the page. */
function show(r, focusRef) {
  state.map = r.map;
  state.at = Date.now();
  state.lines = parse(r.text, r.map);
  state.byRef = new Map([...r.map.fields, ...r.map.actions, ...r.map.iframes].map((x) => [x.ref, x]));
  for (const id of ['#problem', '#access', '#stale']) $(id).hidden = true;
  for (const id of ['#summary', '#legend', '#outline-card']) $(id).hidden = false;
  document.title = `Page map: ${r.map.title || r.map.host || 'page'} · JobToFill`;
  renderSummary(r.map);
  renderOutline(focusRef);
}

/** The lines that place a shown line: the landmarks and frame it is in, and the heading above it. */
function contextOf(shown, lines) {
  const out = new Set();
  for (const i of shown) {
    let depth = lines[i].depth;
    let heading = false;
    for (let j = i - 1; j >= 0 && !(heading && depth === 0); j--) {
      const l = lines[j];
      if (l.kind.startsWith('meta')) break;
      if (!heading && l.kind === 'heading' && l.depth <= depth) {
        out.add(j);
        heading = true;
      }
      if (l.depth < depth && (l.kind === 'landmark' || l.kind === 'frame')) {
        out.add(j);
        depth = l.depth;
      }
    }
  }
  for (const i of shown) out.delete(i);
  return out;
}

/** The filters: only fields that need something, and the search; each line shown, shown for context, or hidden. */
function applyFilter() {
  const need = $('#need').checked;
  const query = $('#search').value.trim();
  const q = query.toLowerCase();
  const lines = state.lines;
  const shownNote = $('#shown');
  if (!need && !q) {
    for (const n of state.nodes) {
      n.hidden = false;
      n.classList.remove('context');
    }
    shownNote.textContent = '';
    return;
  }
  const hits = new Set(
    lines
      .filter((l) => (!need || (l.kind === 'field' && needs(l.item))) && (!q || l.lower.includes(q)))
      .map((l) => l.index),
  );
  const context = contextOf(hits, lines);
  state.nodes.forEach((n, i) => {
    n.hidden = !hits.has(i) && !context.has(i);
    n.classList.toggle('context', context.has(i));
  });
  const fields = state.map.fields.length;
  const n = hits.size;
  const match = n === 1 ? 'matches' : 'match';
  const quoted = `“${query}”`;
  shownNote.textContent = !n
    ? need && !q
      ? fields
        ? 'Every field has what it needs.'
        : 'There are no fields on this page.'
      : `Nothing ${need ? 'that needs something ' : ''}matches ${quoted}.`
    : need && q
      ? `${plural(n, 'field')} that ${n === 1 ? 'needs' : 'need'} something ${match} ${quoted}.`
      : need
        ? `${n} of ${plural(fields, 'field')} need something.`
        : `${plural(n, 'line')} ${match} ${quoted}.`;
}

/* ------------------------------------------------------------- states */

/** Something stands in the way: say what, keep any map already shown, and offer to try again if that can help. */
function problem(title, text, retry) {
  $('#problem-title').textContent = title;
  $('#problem-text').textContent = text || '';
  $('#problem-text').hidden = !text;
  $('#problem-retry').hidden = !retry;
  $('#problem').hidden = false;
  if (!state.map) for (const id of ['#summary', '#legend', '#outline-card']) $(id).hidden = true;
}

/** The tab is gone: nothing more to map or show on it. */
function closed() {
  state.closed = true;
  state.marks = false;
  $('#access').hidden = true;
  $('#stale').hidden = true;
  problem('This tab is closed.', 'Open the page again, then choose Page map in the JobToFill popup.', false);
  for (const id of ['#refresh', '#marks', '#copy', '#save']) $(id).disabled = true;
  renderMarksButton();
}

/** A map couldn't be made: the tab closed, no access yet, or a page JobToFill can't run on. */
async function failed(message) {
  const tab = await api.tabs.get(tabId).catch(() => null);
  if (!tab) return closed();
  if (NEEDS_ACCESS.test(message)) {
    $('#access').hidden = false;
    $('#problem').hidden = true;
    if (!state.map) for (const id of ['#summary', '#legend', '#outline-card']) $(id).hidden = true;
    return;
  }
  problem('Can’t map this page', message, true);
}

/** The page has changed since the map (or a ref on it is gone): offer a new one. */
function stale(text) {
  $('#stale-text').textContent = text;
  $('#stale').hidden = false;
}

function setTools(on) {
  for (const id of ['#refresh', '#marks', '#copy', '#save']) $(id).disabled = !on || state.closed;
}

function renderMarksButton() {
  const button = $('#marks');
  button.setAttribute('aria-pressed', String(state.marks));
  button.textContent = state.marks ? 'Hide refs' : 'Show refs on the page';
}

/* ------------------------------------------------------------- actions */

/** Map the page (again), with the refs redrawn when they are on. */
async function load(opts = {}) {
  if (state.busy || state.closed) return;
  state.busy = true;
  setTools(false);
  const refresh = $('#refresh');
  if (state.map) refresh.textContent = 'Refreshing…';
  const active = document.activeElement;
  const focusRef = active && active.dataset ? active.dataset.ref : null;
  try {
    const ask = { values: 'state', maxChars: MAX_CHARS };
    const r = await send(
      state.marks ? { type: 'jtf:pagemap-marks', on: true, ...ask } : { type: 'jtf:pagemap', ...ask },
    );
    if (!r) throw new Error('JobToFill didn’t answer. Try again.');
    if (r.error) await failed(r.error);
    else {
      show(r, focusRef);
      if (opts.announce) say('Updated.', 'ok');
    }
  } catch (err) {
    await failed(String((err && err.message) || err));
  } finally {
    state.busy = false;
    refresh.textContent = 'Refresh';
    setTools(true);
  }
}

/** Show a line's field, button or frame on the page: its tab comes to the front, the element scrolls into view. */
async function reveal(ref) {
  const item = state.byRef.get(ref);
  if (!item || state.closed) return;
  const frame = state.map.frames[item.frame] || {};
  say(`Showing ${ref} on the page…`);
  const r = await send({ type: 'jtf:pagemap-reveal', frameId: frame.frameId || 0, ref: item.local }).catch((err) => ({
    error: String((err && err.message) || err),
  }));
  if (r && r.ok) {
    // The person is on the page now, maybe to fix it: the map is made again when they come back.
    state.away = true;
    return say(`Showed ${ref} on the page.`, 'ok');
  }
  if (r && r.reason === 'closed') return closed();
  if (r && r.reason === 'hidden')
    return say(
      `${ref} is on the page, but nothing of it shows: it may be in a closed section, a menu or another step.`,
      'warn',
    );
  if (r && r.error) return say(r.error, 'error');
  say('');
  stale(`${ref} isn’t on the page any more: it has changed since this map was made.`);
}

/** The redacted map with its header line, as Copy and Save hand it over. */
async function redactedText() {
  const r = await send({ type: 'jtf:pagemap', values: 'redacted', maxChars: MAX_CHARS });
  if (!r || r.error) throw new Error((r && r.error) || 'JobToFill didn’t answer. Try again.');
  return `${HEADER}\n\n${r.text}\n`;
}

async function copy() {
  const button = $('#copy');
  button.disabled = true;
  say('Copying…');
  try {
    const text = await redactedText();
    try {
      await navigator.clipboard.writeText(text);
      $('#copy-box').hidden = true;
      say('Copied — your details are replaced with placeholders', 'ok');
    } catch (err) {
      // No clipboard for this page (it lost focus, or the browser asks for a click first): the text to copy by hand.
      $('#copy-text').value = text;
      $('#copy-box').hidden = false;
      $('#copy-text').focus();
      $('#copy-text').select();
      say('Your details are replaced with placeholders in the text below.');
    }
  } catch (err) {
    say(String((err && err.message) || err), 'error');
  } finally {
    button.disabled = state.closed;
  }
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch (err) {
    return '';
  }
};

/** jobtofill-pagemap-<host>-<yyyymmdd-hhmm>.txt, as snapshots are named. */
function fileName(url, when) {
  const host = hostOf(url).replace(/[^a-z0-9.-]+/gi, '-') || 'page';
  const stamp = `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}-${pad(when.getHours())}${pad(when.getMinutes())}`;
  return `jobtofill-pagemap-${host}-${stamp}.txt`;
}

async function save() {
  const button = $('#save');
  button.disabled = true;
  say('Saving…');
  try {
    const text = await redactedText();
    const tab = await api.tabs.get(tabId).catch(() => null);
    const name = fileName((tab && tab.url) || state.url, new Date());
    download(new Blob([text], { type: 'text/plain;charset=utf-8' }), name);
    say(`Saved ${name} — your details are replaced with placeholders`, 'ok');
  } catch (err) {
    say(String((err && err.message) || err), 'error');
  } finally {
    button.disabled = state.closed;
  }
}

/** Draw the refs on the page (from a map made now, which is then the one shown), or take them off. */
async function toggleMarks() {
  const on = !state.marks;
  const button = $('#marks');
  button.disabled = true;
  try {
    const r = await send({ type: 'jtf:pagemap-marks', on, values: 'state', maxChars: MAX_CHARS });
    if (!r || r.error) throw new Error((r && r.error) || 'JobToFill didn’t answer. Try again.');
    state.marks = on;
    if (on && r.map) show(r);
    say(on ? `${plural(r.marks || 0, 'ref')} drawn on the page.` : 'Refs taken off the page.', 'ok');
  } catch (err) {
    say(String((err && err.message) || err), 'error');
  } finally {
    button.disabled = state.closed;
    renderMarksButton();
  }
}

/* ---------------------------------------------------------------- start */

/** The legend: open the first time, then as the person last left it. */
function setupLegend() {
  const legend = $('#legend');
  let seen = null;
  try {
    seen = localStorage.getItem(LEGEND_KEY);
    if (seen == null) localStorage.setItem(LEGEND_KEY, 'seen');
  } catch (err) {
    /* storage off: open every time */
  }
  legend.open = seen == null || seen === 'open';
  // The summary's click, not the toggle event, which also fires for the line above.
  legend.querySelector('summary').addEventListener('click', () => {
    try {
      localStorage.setItem(LEGEND_KEY, legend.open ? 'seen' : 'open');
    } catch (err) {
      /* not remembered */
    }
  });
}

/** Up and down move between the lines that show something on the page. */
function onOutlineKey(e) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const buttons = [...$('#outline').querySelectorAll('button.go')].filter((b) => !b.closest('[hidden]'));
  const i = buttons.indexOf(document.activeElement);
  const next = i >= 0 && buttons[i + (e.key === 'ArrowDown' ? 1 : -1)];
  if (!next) return;
  e.preventDefault();
  next.focus();
}

async function init() {
  setupLegend();
  $('#refresh').addEventListener('click', () => load({ announce: true }));
  $('#stale-refresh').addEventListener('click', () => load({ announce: true }));
  $('#problem-retry').addEventListener('click', () => load());
  $('#marks').addEventListener('click', toggleMarks);
  $('#copy').addEventListener('click', copy);
  $('#save').addEventListener('click', save);
  $('#copy-close').addEventListener('click', () => ($('#copy-box').hidden = true));
  $('#need').addEventListener('change', applyFilter);
  $('#search').addEventListener('input', applyFilter);
  $('#outline').addEventListener('click', (e) => {
    const button = e.target.closest('button.go');
    if (button) reveal(button.dataset.ref);
  });
  $('#outline').addEventListener('keydown', onOutlineKey);
  $('#access-allow').addEventListener('click', async () => {
    // Straight from the click, before any await, or Firefox refuses.
    if (!(await requestSiteAccess())) return;
    $('#access').hidden = true;
    load();
  });

  if (tabId == null || !Number.isInteger(tabId)) {
    problem('No page to map', 'Open the page you want to see, then choose Page map in the JobToFill popup.', false);
    return;
  }
  api.tabs.onRemoved.addListener((id) => id === tabId && closed());
  api.tabs.onUpdated.addListener((id, info) => {
    if (id !== tabId || !state.map || state.closed) return;
    // A new page took the old one's place: its refs went with it.
    if (info.status === 'loading' && state.marks) {
      state.marks = false;
      renderMarksButton();
    }
    if (info.url || info.status === 'complete') stale('The page has changed since this map was made.');
  });
  // Back from the page a line showed (and maybe a fix made there): the map as the page is now.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !state.away) return;
    state.away = false;
    load();
  });
  // The refs drawn on the page go when the viewer does.
  addEventListener('pagehide', () => state.marks && send({ type: 'jtf:pagemap-marks', on: false }).catch(() => {}));

  const tab = await api.tabs.get(tabId).catch(() => null);
  if (!tab) return closed();
  state.url = tab.url || '';
  await load();
}

init();
