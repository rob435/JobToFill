/*
 * JobToFill — cover letter studio. Opened from the popup for the application in a tab: finds the
 * job's real description, checks it's the same job, writes and fact-checks a letter in the person's
 * own style, renders it as a PDF like their template, and can tailor their CV to the same job.
 * Runs as an extension page, so long AI calls aren't cut short like they would be in the worker.
 */
import {
  $,
  api,
  download,
  el,
  hasAiConsent,
  hasSiteAccess,
  requestAiConsent,
  requestSiteAccess,
} from '../ui/common.js';

const { store, ai, letter: L, jobpage, doctext, pdfdoc, cvtex, util } = globalThis.JTF;

const params = new URLSearchParams(location.search);
const tabId = params.has('tab') ? Number(params.get('tab')) : null;
// Quick apply: background.js opens this page unfocused with ?quick=1 and the whole chain runs without stopping.
let quick = params.get('quick') === '1' && tabId != null;

const state = {
  profile: null,
  settings: null,
  kit: null,
  config: null,
  context: null, // the application page
  job: null, // { posting, verdict, reasons, source, tried }
  cvText: '',
  analysis: null,
  result: null, // JTF.letter.write() result, kept in sync with the editor
  entry: null, // the saved letter (store.saveLetter)
  letterPdf: null, // { bytes, url, overflow, pages }
  cv: null, // { result, pdf, tex }
  showing: 'letter',
  controller: null,
  cost: 0,
  tokens: 0,
  fallback: null,
};

const send = (message) => api.runtime.sendMessage(message);

/* --------------------------------------------------------------- helpers */

function bytesToDataUrl(bytes, type) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(bin)}`;
}

const slug = (s) =>
  util
    .normalize(s)
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 40);

/** "ada_lovelace_cover_letter_acme_capital.pdf", like people name these files themselves. */
function fileName(kind, ext = 'pdf') {
  const company = slug((state.analysis && state.analysis.company) || (state.job && state.job.posting.company) || '');
  const parts = [slug(L.fullName(state.profile)), kind === 'cv' ? 'cv' : 'cover_letter', company];
  return parts.filter(Boolean).join('_') + '.' + ext;
}

/** The AI call used by JTF.letter, with the running cost shown in the top bar. */
async function chat(messages, options) {
  const r = await ai.chat(state.config, { messages, ...options, signal: state.controller && state.controller.signal });
  // OpenRouter reports the cost; DeepSeek's own API only the tokens.
  if (r.usage && typeof r.usage.cost === 'number') state.cost += r.usage.cost;
  else if (r.usage && r.usage.total_tokens) state.tokens += r.usage.total_tokens;
  if (r.fallback) state.fallback = r.fallback;
  const parts = [];
  if (state.cost) parts.push(`AI cost so far: $${state.cost.toFixed(4)}`);
  if (state.tokens) parts.push(`${state.tokens.toLocaleString()} tokens`);
  if (state.fallback) parts.push(`${state.fallback.to} stood in: ${state.fallback.reason}`);
  $('#cost').textContent = parts.join(' · ');
  return r;
}

/* ---------------------------------------------------------------- steps */

const STEPS = [
  ['job', 'Find the job description'],
  ['cv', 'Read your CV'],
  ['analyse', 'Pick out what the job needs'],
  ['write', 'Write the letter'],
  ['check', 'Check every fact'],
  ['pdf', 'Lay out the PDF'],
];

function resetSteps(from) {
  $('#progress-card').hidden = false;
  $('#error').hidden = true;
  $('#retry').hidden = true;
  const list = $('#steps');
  if (!list.children.length)
    list.replaceChildren(
      ...STEPS.map(([id, label]) =>
        el(
          'li',
          { dataset: { step: id, state: 'pending' } },
          el('span', { textContent: label }),
          el('span', { className: 'detail' }),
        ),
      ),
    );
  let reset = !from;
  for (const li of list.children) {
    if (li.dataset.step === from) reset = true;
    if (reset) {
      li.dataset.state = 'pending';
      li.querySelector('.detail').textContent = '';
    }
  }
}

function step(id, stateName, detail) {
  const li = $(`#steps [data-step="${id}"]`);
  if (!li) return;
  li.dataset.state = stateName;
  if (detail != null) li.querySelector('.detail').textContent = detail;
}

function fail(err, stepId) {
  if (err && err.name === 'AbortError') return;
  if (stepId) step(stepId, 'fail');
  const box = $('#error');
  box.hidden = false;
  box.textContent = String((err && err.message) || err);
  $('#retry').hidden = false;
  $('#stop').hidden = true;
}

/* ---------------------------------------------------------------- setup */

function renderSetup(onDone) {
  const card = $('#setup');
  card.hidden = false;
  const provider = $('#setup-provider');
  provider.replaceChildren(
    ...Object.entries(ai.PROVIDERS).map(([id, p]) => el('option', { value: id, textContent: p.label })),
  );
  const cfg = state.config;
  provider.value = cfg.provider || 'openrouter';
  $('#setup-model').value = cfg.model || '';
  $('#setup-base').value = cfg.baseUrl || '';
  const sync = () => {
    const p = ai.PROVIDERS[provider.value];
    $('#setup-model').placeholder = p.model || 'model id';
    $('#setup-key').placeholder = p.keyHint || '';
    $('#setup-base-wrap').hidden = provider.value !== 'custom';
    const link = $('#setup-key-link');
    link.href = p.keyUrl || '#';
    link.textContent = p.keyUrl ? p.keyUrl.replace(/^https:\/\//, '') : 'your provider';
  };
  // Another provider's model and key don't carry over.
  provider.onchange = () => {
    $('#setup-model').value = provider.value === cfg.provider ? cfg.model || '' : '';
    sync();
  };
  sync();
  $('#setup-save').onclick = async () => {
    // Firefox's consent prompt only opens straight from the click.
    const consent = requestAiConsent();
    const status = $('#setup-status');
    const next = {
      provider: provider.value,
      model: $('#setup-model').value.trim(),
      baseUrl: $('#setup-base').value.trim(),
      apiKey: $('#setup-key').value.trim() || (provider.value === cfg.provider ? cfg.apiKey : ''),
    };
    if (!(await consent)) {
      status.textContent = 'JobToFill needs your permission to send this to the AI provider.';
      return;
    }
    status.textContent = 'Testing…';
    try {
      await ai.test(next);
    } catch (err) {
      status.textContent = err.message;
      return;
    }
    await store.saveAiSettings({ provider: next.provider, model: next.model, baseUrl: next.baseUrl });
    await store.setAiKey(next.apiKey, next.provider);
    state.config = await store.aiConfig();
    status.textContent = 'Connected.';
    card.hidden = true;
    onDone();
  };
}

/* ------------------------------------------------------------------ job */

// Never fetch addresses that might do something when opened.
const UNSAFE =
  /logout|log-out|signout|sign-out|unsubscribe|delete|remove|withdraw|cancel|confirm|verify|activate|reset|token=|password/i;

// Job board data addresses: worth fetching, but there is no page to open in a tab.
const DATA_URL = /\/api\/|\/wday\/cxs\/|graphql|\.json(\?|$)|[?&]format=json/i;

/** fetch for the job finder: GET only, nothing that looks like an action, no cookies. */
async function safeFetch(url, init) {
  const method = ((init && init.method) || 'GET').toUpperCase();
  const isApi = !!(init && init.headers && /json/i.test(JSON.stringify(init.headers)));
  if (UNSAFE.test(url) && !isApi) throw new Error('skipped: looks like an action link');
  if (method !== 'GET' && !(method === 'POST' && isApi)) throw new Error('skipped: not a page load');
  return fetch(url, { credentials: 'omit', redirect: 'follow', ...init });
}

async function historyAllowed() {
  try {
    return await api.permissions.contains({ permissions: ['history'] });
  } catch (err) {
    return false;
  }
}

async function findJob() {
  const context = await send({ type: 'jtf:job-context', tabId });
  if (!context || context.error) throw new Error((context && context.error) || 'JobToFill couldn’t read this page.');
  state.context = context;

  const useHistory = state.settings.searchHistory && (await historyAllowed());
  const found = await jobpage.find(context, {
    fetch: safeFetch,
    historySearch: useHistory ? (q) => api.history.search(q) : null,
    now: Date.now(),
  });

  // Pages built entirely by scripts come back empty when fetched, and some sites block or throttle
  // plain fetches (403, 429, 503): read those pages in a background tab, as the user would see them.
  if (!found.posting || found.verdict === 'different') {
    const blocked = /HTTP (401|403|429|5\d\d)|timed out|failed:/i;
    const shells = (found.tried || [])
      .filter((t) => /empty|no posting|shell|script/i.test(t.outcome || '') || blocked.test(t.outcome || ''))
      .filter((t) => /^https?:/.test(t.url || '') && !DATA_URL.test(t.url))
      .filter((t, i, all) => all.findIndex((x) => x.url === t.url) === i)
      .slice(0, 2);
    for (const t of shells) {
      const page = await send({ type: 'jtf:scrape', url: t.url }).catch(() => null);
      if (page && page.posting && page.posting.description) {
        const verdict = jobpage.compare(context, page.posting);
        (found.tried || []).push({ url: t.url, outcome: `read in a background tab: ${verdict.verdict}` });
        if (verdict.verdict !== 'different') {
          Object.assign(found, {
            posting: page.posting,
            verdict: verdict.verdict,
            reasons: verdict.reasons,
            source: t.url,
          });
          break;
        }
      }
    }
  }

  // The application page itself may be all there is (many put the description above the form).
  if (!found.posting && context.posting && L.words(context.posting.description) > 120) {
    Object.assign(found, {
      posting: context.posting,
      verdict: 'same',
      reasons: ['the description is on the application page'],
      source: context.url,
    });
  }

  // Unsure? A quick second opinion from the model before writing a letter for the wrong job.
  if (found.posting && found.verdict === 'unsure') {
    try {
      const second = await L.sameJob(chat, context, found.posting);
      found.reasons = [
        ...(found.reasons || []),
        `AI check: ${second.reason || (second.same ? 'same job' : 'different job')}`,
      ];
      if (second.same && second.confidence >= 0.7) found.verdict = 'likely';
      else if (!second.same && second.confidence >= 0.7) found.verdict = 'different';
    } catch (err) {
      /* keep "unsure" */
    }
  }
  state.job = found;
  return found;
}

const VERDICTS = {
  same: ['ok', 'Same job'],
  likely: ['ok', 'Very likely the same job'],
  unsure: ['warn', 'Couldn’t confirm it’s the same job'],
  different: ['bad', 'Looks like a different job'],
  pasted: ['ok', 'Your description'],
};

function renderJob() {
  const job = state.job;
  const body = $('#job-body');
  const verdict = $('#job-verdict');
  $('#job-history').hidden = !!(job && job.posting && job.verdict !== 'different') || !!state.settings.searchHistory;
  $('#job-change').hidden = !job || !job.posting;
  if (!job || !job.posting) {
    verdict.hidden = true;
    body.replaceChildren(
      el('p', {
        textContent:
          'JobToFill couldn’t find the description for this job. Paste its web address or the description itself, or open the job’s page and try again from there.',
      }),
    );
    $('#job-manual').hidden = false;
  } else {
    const p = job.posting;
    const [cls, label] = VERDICTS[job.verdict] || VERDICTS.unsure;
    verdict.hidden = false;
    verdict.className = 'pill ' + cls;
    verdict.textContent = label;
    const host = (() => {
      try {
        return new URL(job.source || p.url).hostname;
      } catch (err) {
        return '';
      }
    })();
    body.replaceChildren(
      el('div', {
        className: 'job-title',
        textContent: p.title || (state.context && state.context.title) || 'Untitled job',
      }),
      el('div', { className: 'job-meta', textContent: [p.company, p.location].filter(Boolean).join(' · ') }),
      job.reasons && job.reasons.length
        ? el(
            'ul',
            { className: 'reasons' },
            job.reasons.map((r) => el('li', { textContent: r })),
          )
        : null,
      host
        ? el(
            'p',
            { className: 'small muted' },
            'From ',
            el('a', { href: job.source || p.url, target: '_blank', rel: 'noopener', textContent: host }),
            ` · ${L.words(p.description)} words`,
          )
        : null,
      el('div', { className: 'job-desc', textContent: p.description }),
    );
  }
  const tried = (job && job.tried) || [];
  $('#job-tried').hidden = !tried.length;
  $('#job-tried-list').replaceChildren(...tried.map((t) => el('li', { textContent: `${t.url} — ${t.outcome}` })));
}

async function useManual() {
  const text = $('#job-manual-text').value.trim();
  if (!text) return;
  const context = state.context || { url: '', title: '', company: '' };
  if (/^https?:\/\/\S+$/.test(text)) {
    const found = await jobpage.find(
      { ...context, links: [{ url: text, text: 'pasted' }], pasted: text },
      { fetch: safeFetch, now: Date.now() },
    );
    if (!found.posting) {
      const page = await send({ type: 'jtf:scrape', url: text }).catch(() => null);
      if (page && page.posting) Object.assign(found, { posting: page.posting, source: text });
    }
    if (!found.posting)
      return alert('JobToFill couldn’t read a job description from that address. Paste the description instead.');
    state.job = { ...found, verdict: 'pasted', reasons: ['you chose this page'], source: text };
  } else {
    if (L.words(text) < 60) return alert('That’s too short to be a job description. Paste the whole thing.');
    state.job = {
      posting: {
        url: context.url,
        title: context.title,
        company: context.company,
        location: context.location,
        description: text,
        source: 'pasted',
      },
      verdict: 'pasted',
      reasons: ['pasted by you'],
      tried: [],
    };
  }
  $('#job-manual').hidden = true;
  renderJob();
  run('cv');
}

/* -------------------------------------------------------------------- CV */

/** The text of the stored resume, read once per file and cached with the cover letter material. */
async function readCv() {
  // The pasted LaTeX master (Settings › Cover letters) is cleaner than text scraped from a PDF.
  const master = state.kit.cvMaster && state.kit.cvMaster.sections && state.kit.cvMaster.sections.length;
  if (master) return { text: L.cvText(state.kit.cvMaster), note: '' };
  const doc = await store.getDoc(state.profile.id, 'resume');
  if (!doc) return { text: '', note: 'No CV uploaded (Settings › Resume & files), so the letter uses your profile.' };
  if (state.kit.cv && state.kit.cv.updatedAt === doc.updatedAt && state.kit.cv.name === doc.name)
    return { text: state.kit.cv.text || '', note: state.kit.cv.error || '' };
  try {
    const out = await doctext.fromDataUrl(doc.dataUrl, { type: doc.type, name: doc.name });
    state.kit = await store.saveKit(state.profile.id, {
      cv: { name: doc.name, updatedAt: doc.updatedAt, text: out.text },
    });
    return { text: out.text, note: '' };
  } catch (err) {
    const error = `Couldn’t read ${doc.name}: ${err.message}`;
    state.kit = await store.saveKit(state.profile.id, {
      cv: { name: doc.name, updatedAt: doc.updatedAt, text: '', error },
    });
    return { text: '', note: error };
  }
}

/* ------------------------------------------------------------------ PDF */

let fontsPromise = null;
function fonts() {
  if (!fontsPromise)
    fontsPromise = pdfdoc.loadFonts(async (path) => {
      const res = await fetch(api.runtime.getURL('fonts/' + path));
      if (!res.ok) throw new Error(`Missing font ${path}`);
      return new Uint8Array(await res.arrayBuffer());
    });
  return fontsPromise;
}

function letterForPdf() {
  const { letter, header } = state.result;
  return {
    name: header.name,
    contact: header.contact,
    date: header.date,
    salutation: letter.salutation,
    paragraphs: letter.paragraphs,
    closing: letter.closing,
    signature: header.name,
  };
}

async function renderLetterPdf() {
  const out = await pdfdoc.coverLetter(letterForPdf(), {
    fonts: await fonts(),
    paper: state.kit.paper || 'a4',
    fit: true,
  });
  if (state.letterPdf && state.letterPdf.url) URL.revokeObjectURL(state.letterPdf.url);
  state.letterPdf = { ...out, url: URL.createObjectURL(new Blob([out.bytes], { type: 'application/pdf' })) };
  if (state.showing === 'letter') showPreview('letter');
  return state.letterPdf;
}

function showPreview(which) {
  state.showing = which;
  const doc = which === 'cv' ? state.cv && state.cv.pdf : state.letterPdf;
  $('#tab-letter').setAttribute('aria-selected', String(which === 'letter'));
  $('#tab-cv').setAttribute('aria-selected', String(which === 'cv'));
  const frame = $('#preview');
  $('#preview-empty').hidden = !!doc;
  frame.hidden = !doc;
  $('#open-pdf').hidden = !doc;
  if (doc) {
    frame.src = doc.url + '#toolbar=0&view=FitH';
    $('#open-pdf').href = doc.url;
  }
}

/* --------------------------------------------------------------- editor */

function fillEditor() {
  const { letter } = state.result;
  $('#salutation').value = letter.salutation;
  $('#body').value = letter.paragraphs.join('\n\n');
  $('#closing').value = letter.closing;
  $('#editor').hidden = false;
  $('#cv-card').hidden = false;
  renderChecks();
}

function checkContext() {
  const { posting } = state.job;
  return {
    company: state.analysis.company,
    role: state.analysis.role,
    sources: L.materials(state.profile, state.kit, state.cvText),
    posting: [
      posting.description,
      posting.title,
      posting.company,
      posting.location,
      JSON.stringify(state.analysis),
    ].join('\n'),
    samples: state.kit.samples || [],
    today: Date.now(),
    // The same range the writer aimed for, with the same slack.
    minWords: state.result.options.minWords - 60,
    maxWords: state.result.options.maxWords + 30,
  };
}

function renderChecks() {
  const check = L.checkLetter(state.result.letter, checkContext());
  // Claims the fact audit doubted stay listed until the text they quote is edited away.
  const body = state.result.letter.paragraphs.join(' ');
  const doubts = (state.result.check.unsupported || []).filter((c) => body.includes(c.quote.slice(0, 40)));
  const items = [
    ...check.errors.map((t) => ['bad', t]),
    ...doubts.map((c) => ['warn', `Check this is true: “${c.quote}” (${c.problem})`]),
    ...check.warnings.map((t) => ['warn', t]),
  ];
  if (!check.errors.length) {
    items.unshift([
      'ok',
      `Every number, skill and name is from your material or the posting${doubts.length ? ', apart from the claims below' : ''}.`,
    ]);
    items.unshift([
      'ok',
      `Written for ${state.analysis.company || 'this company'}${state.analysis.role ? `, ${state.analysis.role}` : ''}.`,
    ]);
  }
  if (state.letterPdf)
    items.push(
      state.letterPdf.overflow
        ? ['bad', 'Runs over one page: cut a few sentences.']
        : [
            'ok',
            `Fits on one page${state.letterPdf.fontSize && state.letterPdf.fontSize < 11 ? ` (at ${state.letterPdf.fontSize} pt)` : ''}.`,
          ],
    );
  $('#checks').replaceChildren(...items.map(([cls, text]) => el('li', { className: cls, textContent: text })));
  $('#words').textContent = `${check.words} words`;
}

let editTimer = null;
function onEdit() {
  const letter = state.result.letter;
  letter.salutation = $('#salutation').value.trim();
  letter.closing = $('#closing').value.trim();
  letter.paragraphs = $('#body')
    .value.split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean);
  clearTimeout(editTimer);
  editTimer = setTimeout(async () => {
    await renderLetterPdf();
    renderChecks();
    await saveEntry();
  }, 500);
}

/* ---------------------------------------------------------------- saving */

async function saveEntry(extra) {
  const pdf = state.letterPdf;
  const posting = state.job.posting;
  const entry = {
    ...(state.entry ? { id: state.entry.id } : {}),
    profileId: state.profile.id,
    url: (state.context && state.context.url) || posting.url,
    host: state.context && state.context.host,
    jobIds: [...new Set([...((state.context && state.context.jobIds) || []), ...(posting.jobIds || [])])],
    posting: {
      url: posting.url,
      title: posting.title,
      company: state.analysis.company || posting.company,
      location: posting.location,
    },
    letter: state.result.letter,
    header: state.result.header,
    options: state.result.options,
    analysis: state.analysis,
    unsupported: state.result.check.unsupported || [],
    text: L.asText(state.result),
    pdf: pdf
      ? {
          name: fileName('letter'),
          type: 'application/pdf',
          size: pdf.bytes.length,
          dataUrl: bytesToDataUrl(pdf.bytes, 'application/pdf'),
        }
      : null,
    ...extra,
  };
  state.entry = await store.saveLetter(entry);
  return state.entry;
}

/** Does the tab still show this application (same site; no other job's ID in the address)? */
async function stillSameJob(url) {
  const context = state.context;
  if (!context || !context.url || !url) return true;
  let before;
  let now;
  try {
    before = new URL(context.url);
    now = new URL(url);
  } catch (err) {
    return true;
  }
  if (before.hostname !== now.hostname) return false;
  const ids = [...(context.jobIds || []), ...((state.job && state.job.posting && state.job.posting.jobIds) || [])];
  const nowIds = (jobpage.ats(url) || {}).jobId;
  return !nowIds || !ids.length || ids.some((id) => String(id).toLowerCase() === String(nowIds).toLowerCase());
}

async function useForApplication() {
  const status = $('#use-status');
  if (tabId == null) {
    status.textContent = 'Saved. Download it to upload by hand.';
    return;
  }
  // The tab may have moved on to another job since the letter was written.
  const tab = await api.tabs.get(tabId).catch(() => null);
  if (!tab) {
    status.textContent = 'The application tab is closed. Download the PDF to upload it by hand.';
    return;
  }
  if (
    !(await stillSameJob(tab.url)) &&
    !confirm(
      `That tab now shows ${tab.url}\n\nAttach the letter for ${state.analysis.company || 'this job'} there anyway?`,
    )
  ) {
    status.textContent = 'Not attached: the tab shows a different page.';
    return;
  }
  status.textContent = 'Attaching…';
  clearTimeout(editTimer);
  await renderLetterPdf();
  await saveEntry(cvExtra());
  const r = await send({ type: 'jtf:attach', tabId, letterId: state.entry.id });
  if (r && r.error) status.textContent = `Saved for this application, but: ${r.error}`;
  else if (r && r.filled)
    status.textContent = `Attached to the form (${r.filled} field${r.filled === 1 ? '' : 's'}). It will be used on the next steps too.`;
  else
    status.textContent =
      'Saved for this application: it goes in as soon as the form asks for a cover letter (when you click Fill).';
}

/* ------------------------------------------------------------------- CV */

function cvExtra(use = $('#cv-use').checked) {
  if (!state.cv) return { useCv: false };
  return {
    useCv: use,
    cv: {
      name: fileName('cv'),
      type: 'application/pdf',
      size: state.cv.pdf.bytes.length,
      dataUrl: bytesToDataUrl(state.cv.pdf.bytes, 'application/pdf'),
    },
    cvChanges: state.cv.result.cv.changes,
  };
}

/**
 * Tailor the CV to the analysed job and lay it out: no buttons, no page updates, so "Quick apply" can
 * call it too. Uses the master CV (Settings › Cover letters) when there is one, else the text of the
 * uploaded file. Returns { result, pdf, tex }: result is letter.tailor()'s { cv, check, before, after },
 * pdf is pdfdoc.cv()'s { bytes, pages, overflow, ... }, tex the same CV as a LaTeX file.
 */
async function buildTailoredCv({ instructions = '' } = {}) {
  const master = state.kit.cvMaster && state.kit.cvMaster.sections && state.kit.cvMaster.sections.length;
  if (!master && !state.cvText)
    throw new Error(
      'JobToFill needs your CV to tailor it: paste it as LaTeX in Settings › Cover letters, or add the file in Settings › Resume & files.',
    );
  const result = await L.tailor(chat, {
    profile: state.profile,
    kit: state.kit,
    cvText: state.cvText,
    analysis: state.analysis,
    instructions,
  });
  const pdf = await pdfdoc.cv(result.cv, { fonts: await fonts(), paper: state.kit.paper || 'a4', fit: true });
  return { result, pdf, tex: cvtex.render(result.cv) };
}

/** Keep a built CV as the current one and show it (preview, keywords, checks, changes). */
function showTailoredCv({ result, pdf, tex }) {
  if (state.cv && state.cv.pdf.url) URL.revokeObjectURL(state.cv.pdf.url);
  state.cv = {
    result,
    tex,
    pdf: { ...pdf, url: URL.createObjectURL(new Blob([pdf.bytes], { type: 'application/pdf' })) },
  };
  const { before, after, check } = result;
  $('#cv-coverage').hidden = false;
  $('#cv-coverage').className = 'pill ok';
  $('#cv-coverage').textContent =
    `Keywords: ${before.matched.length} → ${after.matched.length} of ${after.matched.length + after.missing.length}`;
  $('#cv-keywords').textContent = after.missing.length
    ? `Not in your CV (and not added, because it isn’t in your material): ${after.missing.slice(0, 12).join(', ')}`
    : 'Your CV now uses every keyword the job lists.';
  $('#cv-checks').replaceChildren(
    ...[
      ...(check.errors.length
        ? check.errors.map((t) => ['bad', t])
        : [['ok', 'No new facts: every number, skill and organisation is from your CV.']]),
      ...check.warnings.map((t) => ['warn', t]),
      ...(result.restored && result.restored.length
        ? [['ok', `Kept your names, dates, places and titles exactly (${result.restored.length} edit(s) undone).`]]
        : []),
      [pdf.overflow || pdf.pages > 1 ? 'warn' : 'ok', pdf.pages > 1 ? `${pdf.pages} pages.` : 'One page.'],
    ].map(([cls, text]) => el('li', { className: cls, textContent: text })),
  );
  $('#cv-changes').replaceChildren(...result.cv.changes.map((c) => el('li', { textContent: c })));
  $('#cv-result').hidden = false;
  $('#cv-use-wrap').hidden = false;
  $('#cv-download').hidden = false;
  $('#cv-download-tex').hidden = false;
  $('#tab-cv').hidden = false;
  showPreview('cv');
}

async function tailorCv() {
  const button = $('#cv-make');
  button.disabled = true;
  button.textContent = 'Tailoring…';
  state.controller = new AbortController();
  try {
    showTailoredCv(await buildTailoredCv({ instructions: $('#instructions').value }));
    if (state.entry) await saveEntry(cvExtra());
  } catch (err) {
    if (err.name !== 'AbortError') alert(err.message);
  } finally {
    button.disabled = false;
    button.textContent = state.cv ? 'Tailor again' : 'Tailor my CV';
  }
}

/* ------------------------------------------------------ earlier letters */

/** A letter this profile already wrote for the same job (same page, job ID or posting). */
async function previousLetter() {
  const ids = new Set([...((state.context && state.context.jobIds) || []), ...(state.job.posting.jobIds || [])]);
  const postingUrl = state.job.posting.url;
  // The same application address isn't enough: some sites use one address for every job.
  const title = util.normalize(state.job.posting.title || '');
  const sameTitle = (l) => !!title && !!l.posting && util.normalize(l.posting.title || '') === title;
  return (
    (await store.getLetters()).find(
      (l) =>
        l.profileId === state.profile.id &&
        l.letter &&
        l.analysis &&
        ((state.context && l.url === state.context.url && sameTitle(l)) ||
          (postingUrl && l.posting && l.posting.url === postingUrl) ||
          (l.jobIds || []).some((id) => id && id.length >= 4 && ids.has(id))),
    ) || null
  );
}

/** Ask with buttons in the progress card; resolves true to reuse the earlier letter. */
function offerPrevious(previous) {
  return new Promise((resolve) => {
    const when = new Date(previous.createdAt).toLocaleString();
    const box = el(
      'div',
      { className: 'row', id: 'previous' },
      el('span', { textContent: `You wrote a letter for this job on ${when}.` }),
      el('button', {
        type: 'button',
        className: 'primary small',
        textContent: 'Open it',
        onclick: () => (box.remove(), resolve(true)),
      }),
      el('button', {
        type: 'button',
        className: 'small',
        textContent: 'Write a new one',
        onclick: () => (box.remove(), resolve(false)),
      }),
    );
    $('#progress-card').append(box);
  });
}

async function reopen(previous) {
  state.entry = previous;
  state.analysis = previous.analysis;
  state.result = {
    letter: previous.letter,
    header: previous.header,
    options: previous.options || { minWords: 320, maxWords: 420 },
    check: { errors: [], warnings: [], unsupported: previous.unsupported || [] },
  };
  state.kit = await store.getKit(state.profile.id);
  state.cvText = (await readCv()).text;
  for (const id of ['cv', 'analyse', 'write', 'check']) step(id, 'done', id === 'write' ? 'your earlier letter' : '');
  await renderLetterPdf();
  step('pdf', 'done', 'one page');
  fillEditor();
  $('#stop').hidden = true;
}

/* ---------------------------------------------------------- eligibility */

async function checkEligibility(signal) {
  const list = $('#job-fit');
  list.hidden = true;
  try {
    const issues = await L.eligibility(chat, state.analysis, state.profile, state.kit, state.cvText, { signal });
    if (signal.aborted) return;
    const lang = L.postingLanguage(state.job.posting.description);
    const notes = L.LANG_NAMES[lang]
      ? [
          el('li', {
            className: 'warn',
            textContent: `This posting is in ${L.LANG_NAMES[lang]}. The letter is in English; check the employer accepts English applications.`,
          }),
        ]
      : [];
    list.replaceChildren(
      ...notes,
      ...(issues.length
        ? issues.map((i) =>
            el('li', { className: 'warn', textContent: `Check you can apply: ${i.requirement}. ${i.detail}` }),
          )
        : state.analysis.eligibility.length
          ? [el('li', { className: 'ok', textContent: 'You meet the requirements on who can apply.' })]
          : []),
    );
    list.hidden = !list.children.length;
  } catch (err) {
    /* advice only: the letter doesn't depend on it */
  }
}

/* ------------------------------------------------------------- pipeline */

async function run(from = 'job') {
  if (state.controller) state.controller.abort();
  state.controller = new AbortController();
  const signal = state.controller.signal;
  resetSteps(from);
  $('#stop').hidden = false;
  let current = from;
  // Later steps reuse what earlier runs found: "Rewrite" starts at the writing step.
  const ORDER = ['job', 'cv', 'analyse', 'write'];
  const at = (id) => ORDER.indexOf(id) >= ORDER.indexOf(from);
  try {
    if (at('job')) {
      current = 'job';
      step('job', 'active');
      const found = await findJob();
      renderJob();
      if (!found.posting || found.verdict === 'different') {
        step('job', 'warn', found.posting ? 'that page looks like a different job' : 'not found');
        $('#stop').hidden = true;
        $('#job-manual').hidden = false;
        return;
      }
      step(
        'job',
        found.verdict === 'unsure' ? 'warn' : 'done',
        VERDICTS[found.verdict] ? VERDICTS[found.verdict][1] : '',
      );
      // Already wrote one for this job? Offer it (with any edits) instead of paying for a new one.
      const previous = await previousLetter();
      if (previous && (await offerPrevious(previous))) {
        await reopen(previous);
        return;
      }
    }
    if (signal.aborted) return;

    if (at('cv')) {
      current = 'cv';
      step('cv', 'active');
      state.kit = await store.getKit(state.profile.id);
      const cv = await readCv();
      state.cvText = cv.text;
      step('cv', cv.text ? 'done' : 'warn', cv.text ? `${L.words(cv.text)} words` : cv.note);
      if (!L.fullName(state.profile))
        throw new Error('Add your name in Settings › Personal & contact first: it goes at the top of the letter.');
      if (!L.hasSubstance(state.profile, state.kit, state.cvText))
        throw new Error(
          'There isn’t enough about you to write from yet. Upload your CV (Settings › Resume & files) or add notes in Settings › Cover letters.',
        );
    }

    if (at('analyse')) {
      current = 'analyse';
      step('analyse', 'active');
      state.analysis = await L.analyse(chat, state.job.posting, state.context, { signal });
      // The page the finder settled on may not be a job description at all (a privacy notice, a job list).
      if (!state.analysis.isPosting) {
        step('analyse', 'warn', 'that page isn’t a job description');
        $('#job-manual').hidden = false;
        throw new Error(
          'The text JobToFill found doesn’t read like a job description (it may be a privacy notice or a list of jobs). Paste the job’s address or its description above.',
        );
      }
      step('analyse', 'done', [state.analysis.role, state.analysis.company].filter(Boolean).join(' at '));
      // Runs alongside the writing: does the person meet the hard requirements?
      checkEligibility(signal);
    }

    current = 'write';
    step('write', 'active');
    const input = {
      profile: state.profile,
      kit: state.kit,
      cvText: state.cvText,
      posting: state.job.posting,
      analysis: state.analysis,
      context: state.context,
      instructions: $('#instructions').value,
    };
    let fixes = 0;
    state.result = await L.write(chat, input, {
      signal,
      onProgress: (stage, detail) => {
        if (stage === 'writing' || stage === 'revising') {
          step('write', 'active', stage === 'revising' ? `draft ${detail + 1}` : '');
          step('check', 'pending');
        }
        if (stage === 'auditing') {
          step('write', 'done');
          step('check', 'active', 'checking claims against your CV');
        }
        if (stage === 'checking') {
          fixes += detail.length;
          step('check', 'active', `fixing ${detail.length} problem${detail.length === 1 ? '' : 's'}`);
        }
      },
    });
    current = 'check';
    step('write', 'done', `${state.result.check.words} words`);
    const left = state.result.check.errors.length + state.result.check.warnings.length;
    step(
      'check',
      left ? 'warn' : 'done',
      left
        ? `${left} thing${left === 1 ? '' : 's'} for you to look at`
        : fixes
          ? `fixed ${fixes} problem${fixes === 1 ? '' : 's'}`
          : 'all good',
    );

    current = 'pdf';
    step('pdf', 'active');
    let pdf = await renderLetterPdf();
    if (pdf.overflow) {
      step('pdf', 'active', 'too long for one page, shortening');
      state.result.letter = await L.shorten(chat, input, state.result, 60, { signal });
      pdf = await renderLetterPdf();
    }
    step(
      'pdf',
      pdf.overflow ? 'warn' : 'done',
      pdf.overflow ? 'still over one page' : `one page${pdf.fontSize < 11 ? `, ${pdf.fontSize} pt` : ''}`,
    );
    fillEditor();
    await saveEntry();
    $('#stop').hidden = true;
  } catch (err) {
    fail(err, current);
  }
}

/* ------------------------------------------------------------ quick apply */

let studioTabId = null;

async function quickStatus(message, stateName = 'running') {
  await store.setQuickStatus({ state: stateName, message, tabId, studioTabId }).catch(() => {});
}

/** Show a step as running here and in the popup's status line. */
function phase(id, message) {
  step(id, 'active');
  return quickStatus(message);
}

/** The application page's own text, when the real posting can't be found: better than stopping to ask. */
function useApplicationPage(tried) {
  const context = state.context || {};
  const text = (context.posting && context.posting.description) || context.pageText || '';
  if (L.words(text) < 60) return false;
  state.job = {
    posting: {
      url: context.url,
      title: context.title,
      company: context.company,
      location: context.location,
      description: text.slice(0, 15000),
      source: 'page-text',
    },
    verdict: 'pasted',
    reasons: ['Quick apply used the text of the application page itself'],
    tried: tried || [],
  };
  return true;
}

/**
 * Quick apply: find the job (falling back to the application page), read the CV, write and fit the letter,
 * tailor the CV, save both for this application, then have the background fill the whole form. No
 * confirmations. Keeps one temporary result for the "Last quick apply" page and closes this tab when done.
 */
async function quickApply() {
  state.controller = new AbortController();
  const signal = state.controller.signal;
  resetSteps();
  $('#stop').hidden = true;
  const list = $('#steps');
  for (const [id, label] of [
    ['tailor', 'Tailor your CV'],
    ['fill', 'Fill the form'],
  ])
    list.append(
      el(
        'li',
        { dataset: { step: id, state: 'pending' } },
        el('span', { textContent: label }),
        el('span', { className: 'detail' }),
      ),
    );
  let current = 'job';
  try {
    await phase('job', 'finding the job…');
    const found = await findJob();
    let note = '';
    if (!found.posting || found.verdict === 'different') {
      if (!useApplicationPage(found.tried))
        throw new Error(
          'Quick apply couldn’t find this job’s description, and the application page doesn’t contain one. Use “Write cover letter” and paste it.',
        );
      note = 'used the application page';
    }
    step('job', 'done', note || (VERDICTS[state.job.verdict] || [])[1] || '');

    current = 'cv';
    await phase('cv', 'reading your CV…');
    state.kit = await store.getKit(state.profile.id);
    const cv = await readCv();
    state.cvText = cv.text;
    step('cv', cv.text ? 'done' : 'warn', cv.text ? `${L.words(cv.text)} words` : cv.note);
    if (!L.fullName(state.profile))
      throw new Error('Add your name in Settings › Personal & contact first: it goes at the top of the letter.');
    if (!L.hasSubstance(state.profile, state.kit, state.cvText))
      throw new Error(
        'There isn’t enough about you to write from yet. Upload your CV (Settings › Resume & files) or add notes in Settings › Cover letters.',
      );

    current = 'analyse';
    await phase('analyse', 'reading the job…');
    state.analysis = await L.analyse(chat, state.job.posting, state.context, { signal });
    if (!state.analysis.isPosting && state.job.posting.source !== 'page-text' && useApplicationPage(state.job.tried))
      state.analysis = await L.analyse(chat, state.job.posting, state.context, { signal });
    if (!state.analysis.isPosting)
      throw new Error(
        'The text Quick apply found doesn’t read like a job description. Use “Write cover letter” and paste it.',
      );
    step('analyse', 'done', [state.analysis.role, state.analysis.company].filter(Boolean).join(' at '));

    current = 'write';
    await phase('write', 'writing the letter…');
    const input = {
      profile: state.profile,
      kit: state.kit,
      cvText: state.cvText,
      posting: state.job.posting,
      analysis: state.analysis,
      context: state.context,
      instructions: '',
    };
    state.result = await L.write(chat, input, {
      signal,
      onProgress: (stage) => {
        if (stage === 'auditing' || stage === 'checking') quickStatus('checking the letter…');
      },
    });
    step('write', 'done', `${state.result.check.words} words`);
    let pdf = await renderLetterPdf();
    if (pdf.overflow) {
      await quickStatus('shortening the letter…');
      state.result.letter = await L.shorten(chat, input, state.result, 60, { signal });
      pdf = await renderLetterPdf();
    }
    step('check', 'done');
    step('pdf', pdf.overflow ? 'warn' : 'done');
    const left = L.checkLetter(state.result.letter, checkContext()).errors.length + (pdf.overflow ? 1 : 0);

    current = 'tailor';
    let cvNote = '';
    state.cv = null;
    await phase('tailor', 'tailoring your CV…');
    try {
      const built = await buildTailoredCv();
      state.cv = { ...built };
      step('tailor', 'done', `${built.result.cv.changes.length} changes`);
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      cvNote = /needs your CV/.test(err.message)
        ? 'No CV to tailor (add one in Settings).'
        : `CV not tailored: ${err.message}`;
      step('tailor', 'warn', cvNote);
    }

    // The letter (with the CV, if there is one) is saved for this application so the form fill attaches them.
    await saveEntry({ quick: true, ...cvExtra(true) });
    const letterText = L.asText(state.result);
    await store.saveQuickApply({
      tabUrl: (state.context && state.context.url) || '',
      company: state.analysis.company || '',
      role: state.analysis.role || '',
      letter: { text: letterText, pdf: state.entry.pdf.dataUrl, name: state.entry.pdf.name },
      cv: state.cv
        ? {
            pdf: state.entry.cv.dataUrl,
            name: state.entry.cv.name,
            tex: state.cv.tex,
            changes: state.cv.result.cv.changes,
          }
        : null,
      note: [
        cvNote,
        left ? `The letter has ${left} unresolved check${left === 1 ? '' : 's'}: read it before sending.` : '',
      ]
        .filter(Boolean)
        .join(' '),
    });

    current = 'fill';
    await phase('fill', 'filling the form…');
    const tab = await api.tabs.get(tabId).catch(() => null);
    if (!tab)
      throw new Error(
        'The application tab was closed, so nothing was filled. Open “Last quick apply” to see the letter and CV.',
      );
    if (!(await stillSameJob(tab.url)))
      throw new Error(
        'The application tab moved to another site, so nothing was filled. Open “Last quick apply” to see the letter and CV.',
      );
    const r = await send({ type: 'jtf:quick-fill', tabId, letterId: state.entry.id, cv: !!state.cv });
    if (!r || r.error) throw new Error((r && r.error) || 'Filling the form failed.');
    step('fill', 'done', `${r.filled} field${r.filled === 1 ? '' : 's'}`);
    await quickStatus(cvNote ? `done (${cvNote})` : 'done', 'done');
    const me = await api.tabs.getCurrent();
    if (me) await api.tabs.remove(me.id);
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    const message = String((err && err.message) || err);
    await quickStatus(message, 'error');
    // Say so on the application page too, since the person isn't looking at this tab.
    await send({ type: 'jtf:toast', tabId, message: `Quick apply stopped: ${message}` }).catch(() => {});
    fail(err, current);
  }
}

/** A prerequisite is missing (site access, AI consent, an AI key): carry on as the normal page, in front. */
function leaveQuick() {
  if (!quick) return;
  quick = false;
  api.tabs.getCurrent().then((t) => t && api.tabs.update(t.id, { active: true }));
  store
    .setQuickStatus({
      state: 'error',
      message: 'Quick apply needs one more step first: finish it in the JobToFill tab.',
      tabId,
      studioTabId,
    })
    .catch(() => {});
}

/* ----------------------------------------------------------------- boot */

async function boot() {
  const { profile, settings } = await store.getActive();
  state.profile = profile;
  state.settings = settings;
  state.kit = await store.getKit(profile.id);
  state.config = await store.aiConfig();
  $('#profile-name').textContent = profile.name;
  if (quick) studioTabId = ((await api.tabs.getCurrent()) || {}).id ?? null;

  $('#open-settings').onclick = () => api.tabs.create({ url: api.runtime.getURL('options/options.html#letters') });
  $('#retry').onclick = () => run(!state.job || !state.job.posting ? 'job' : state.analysis ? 'write' : 'cv');
  $('#stop').onclick = () => {
    if (state.controller) state.controller.abort();
    for (const li of document.querySelectorAll('#steps [data-state="active"]'))
      step(li.dataset.step, 'warn', 'stopped');
    $('#stop').hidden = true;
    $('#retry').hidden = false;
  };
  $('#job-change').onclick = () => {
    $('#job-manual').hidden = false;
    $('#job-manual-text').focus();
  };
  $('#job-manual-cancel').onclick = () => ($('#job-manual').hidden = true);
  $('#job-manual-use').onclick = () => useManual().catch((err) => alert(err.message));
  $('#job-history').onclick = async () => {
    // Asked straight from the click, as browsers require for permission prompts.
    const granted = await api.permissions.request({ permissions: ['history'] }).catch(() => false);
    if (!granted) return;
    state.settings = await store.saveSettings({ searchHistory: true });
    run('job');
  };
  for (const id of ['#salutation', '#body', '#closing']) $(id).addEventListener('input', onEdit);
  const rewrite = () => run(state.analysis ? 'write' : 'cv');
  $('#rewrite').onclick = rewrite;
  $('#instructions').addEventListener('keydown', (e) => e.key === 'Enter' && rewrite());
  $('#use').onclick = () => useForApplication().catch((err) => ($('#use-status').textContent = err.message));
  $('#download').onclick = async () => {
    await renderLetterPdf();
    download(new Blob([state.letterPdf.bytes], { type: 'application/pdf' }), fileName('letter'));
  };
  $('#copy').onclick = async () => {
    await navigator.clipboard.writeText(L.asText(state.result));
    $('#use-status').textContent = 'Copied.';
  };
  $('#cv-make').onclick = tailorCv;
  $('#cv-use').onchange = () => state.entry && saveEntry(cvExtra());
  $('#cv-download').onclick = () =>
    state.cv && download(new Blob([state.cv.pdf.bytes], { type: 'application/pdf' }), fileName('cv'));
  $('#cv-download-tex').onclick = () =>
    state.cv && download(new Blob([state.cv.tex], { type: 'application/x-tex' }), fileName('cv', 'tex'));
  $('#tab-letter').onclick = () => showPreview('letter');
  $('#tab-cv').onclick = () => showPreview('cv');

  // Steps after the job step use the AI; the job search itself doesn't need it.
  if (tabId == null) {
    state.context = { url: '', title: '', company: '' };
    state.job = { posting: null, tried: [] };
    renderJob();
  }
  // Each prerequisite is asked for from a click (browsers require it), then the next one.
  const begin = () => (tabId == null ? null : quick ? quickApply() : run('job'));
  const consent = async () => {
    if (await hasAiConsent()) return begin();
    leaveQuick();
    $('#consent').hidden = false;
    $('#consent-allow').onclick = async () => {
      if (!(await requestAiConsent())) return;
      $('#consent').hidden = true;
      begin();
    };
  };
  const setup = () => {
    if (!ai.problem(state.config)) return consent();
    leaveQuick();
    renderSetup(begin);
  };
  if (await hasSiteAccess()) setup();
  else {
    leaveQuick();
    $('#access').hidden = false;
    $('#access-allow').onclick = async () => {
      if (!(await requestSiteAccess())) return;
      $('#access').hidden = true;
      setup();
    };
  }
}

boot().catch((err) => fail(err));
