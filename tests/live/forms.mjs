// Live application forms, read from the job boards' public APIs (no browser needed): the questions each
// form asks, as the descriptors content/dom.js would build for them. Used by survey-api.mjs.
//
//   Greenhouse  boards-api.greenhouse.io/v1/boards/{board}/jobs/{id}?questions=true
//   Ashby       jobs.ashbyhq.com/api/non-user-graphql (ApiJobPosting: the application form)
//   Lever       jobs.lever.co/{company}/{id}/apply (server-rendered form)
import { parseHTML } from 'linkedom';

const clean = (s) =>
  String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;/g, '’')
    .replace(/&quot;/g, '"')
    .replace(/[✱*]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();

/** A descriptor for one question: { kind, options, signals: { label, section, describedby }, ... }. */
function question({ label, kind, options, required, section, help, maxLength, host }) {
  return {
    kind,
    inputType:
      { text: 'text', textarea: 'textarea', email: 'email', tel: 'tel', url: 'url', number: 'number', date: 'date' }[
        kind
      ] || kind,
    autocomplete: '',
    maxLength: maxLength || 0,
    placeholderRaw: '',
    lang: 'en',
    host,
    options: options ? options.map((o) => (typeof o === 'string' ? { text: o, value: o } : o)) : null,
    required: !!required,
    signals: {
      [kind === 'radio' || kind === 'checkboxes' ? 'question' : 'label']: clean(label),
      section: section || '',
      describedby: clean(help).slice(0, 200),
    },
  };
}

/* ------------------------------------------------------------ Greenhouse */

const GH_KIND = {
  input_text: 'text',
  textarea: 'textarea',
  multi_value_single_select: 'select',
  multi_value_multi_select: 'checkboxes',
  input_file: 'file',
};

function greenhouseIds(url) {
  const u = new URL(url);
  const id =
    u.searchParams.get('gh_jid') ||
    (u.pathname.match(/\/jobs\/(\d+)/) || [])[1] ||
    (/\/embed\/job_app/.test(u.pathname) ? u.searchParams.get('token') : null);
  const board = u.searchParams.get('for') || (u.pathname.match(/^\/([^/]+)\/jobs\//) || [])[1];
  return id && board ? { board, id } : null;
}

async function greenhouse(url, fetchJson) {
  const ids = greenhouseIds(url);
  if (!ids) return null;
  const host = new URL(url).hostname.includes('.eu.') ? 'job-boards.eu.greenhouse.io' : 'job-boards.greenhouse.io';
  // EU boards (job-boards.eu.greenhouse.io) answer on the same API host.
  const job = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${ids.board}/jobs/${ids.id}?questions=true`);
  if (!job || !job.questions) return null;
  const out = [];
  const add = (q, section) => {
    const f = (q.fields || []).find((x) => x.type !== 'input_hidden');
    if (!f || !GH_KIND[f.type]) return;
    out.push(
      question({
        label: q.label,
        kind: GH_KIND[f.type],
        options: f.values && f.values.length ? f.values.map((v) => v.label) : null,
        required: q.required,
        section,
        help: q.description,
        host,
      }),
    );
  };
  for (const q of job.questions) add(q, '');
  for (const q of job.location_questions || []) add(q, '');
  for (const c of job.compliance || [])
    for (const q of c.questions || []) add(q, c.type === 'eeoc' ? 'U.S. Equal Employment Opportunity' : '');
  const demo = job.demographic_questions;
  for (const q of (demo && demo.questions) || [])
    out.push(
      question({
        label: q.label,
        kind: q.type === 'multi_value_multi_select' ? 'checkboxes' : 'select',
        options: (q.answer_options || []).map((o) => o.label),
        required: q.required,
        section: (demo && demo.header) || 'Voluntary questions',
        host,
      }),
    );
  return {
    ats: 'greenhouse',
    company: job.company_name,
    title: job.title,
    description: clean(job.content).slice(0, 12000),
    questions: out,
  };
}

/* ----------------------------------------------------------------- Ashby */

const ASHBY_QUERY =
  'query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) { jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) { id title descriptionHtml applicationForm { sections { title fieldEntries { ... on FormFieldEntry { id field isRequired descriptionHtml isHidden } } } } surveyForms { sections { title fieldEntries { ... on FormFieldEntry { id field isRequired isHidden } } } } } }';

const ASHBY_KIND = {
  String: 'text',
  Email: 'email',
  Phone: 'tel',
  Url: 'url',
  File: 'file',
  Location: 'combobox',
  Boolean: 'radio',
  ValueSelect: 'radio',
  MultiValueSelect: 'checkboxes',
  LongText: 'textarea',
  Number: 'number',
  Date: 'date',
  Score: 'radio',
};

async function ashby(url, fetchJson) {
  const m = new URL(url).pathname.match(/^\/([^/]+)\/([0-9a-f-]{36})/);
  if (!m) return null;
  const json = await fetchJson('https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      operationName: 'ApiJobPosting',
      variables: { organizationHostedJobsPageName: m[1], jobPostingId: m[2] },
      query: ASHBY_QUERY,
    }),
  });
  const jp = json && json.data && json.data.jobPosting;
  if (!jp || !jp.applicationForm) return null;
  const out = [];
  const add = (entries, section) => {
    for (const e of entries || []) {
      const f = e.field || {};
      if (e.isHidden || !ASHBY_KIND[f.type]) continue;
      const options =
        f.type === 'Boolean'
          ? ['Yes', 'No']
          : f.selectableValues && f.selectableValues.length
            ? f.selectableValues.map((v) => v.label)
            : null;
      const kind = ASHBY_KIND[f.type] === 'radio' && options && options.length > 6 ? 'select' : ASHBY_KIND[f.type];
      out.push(
        question({
          label: f.title,
          kind,
          options,
          required: e.isRequired,
          section,
          help: e.descriptionHtml,
          host: 'jobs.ashbyhq.com',
        }),
      );
    }
  };
  for (const s of jp.applicationForm.sections || []) add(s.fieldEntries, s.title || '');
  for (const sf of jp.surveyForms || []) for (const s of sf.sections || []) add(s.fieldEntries, s.title || 'Survey');
  return {
    ats: 'ashby',
    company: m[1],
    title: jp.title,
    description: clean(jp.descriptionHtml).slice(0, 12000),
    questions: out,
  };
}

/* ----------------------------------------------------------------- Lever */

async function lever(url, fetchText) {
  const u = new URL(url);
  const path = u.pathname.replace(/\/apply\/?$/, '').replace(/\/$/, '');
  const html = await fetchText(`${u.origin}${path}/apply`);
  if (!html) return null;
  const { document } = parseHTML(html);
  const out = [];
  for (const q of document.querySelectorAll('.application-question, .application-additional')) {
    const labelEl = q.querySelector('.application-label') || q.querySelector('.text');
    const label = clean(labelEl ? labelEl.textContent : '');
    const section = clean(
      (q.closest('.section, .eeo-survey') || { querySelector: () => null }).querySelector?.('h4')?.textContent,
    );
    const radios = [...q.querySelectorAll('input[type=radio]')];
    const boxes = [...q.querySelectorAll('input[type=checkbox]')];
    const select = q.querySelector('select');
    const area = q.querySelector('textarea');
    const input = q.querySelector('input:not([type=hidden]):not([type=radio]):not([type=checkbox])');
    const optionText = (el) => clean((el.closest('label') || el.parentElement).textContent);
    let d = null;
    if (radios.length) d = { kind: 'radio', options: radios.map(optionText) };
    else if (boxes.length > 1) d = { kind: 'checkboxes', options: boxes.map(optionText) };
    else if (boxes.length === 1) d = { kind: 'checkbox', options: [optionText(boxes[0])] };
    else if (select)
      d = { kind: 'select', options: [...select.querySelectorAll('option')].map((o) => clean(o.textContent)) };
    else if (area) d = { kind: 'textarea' };
    else if (input) d = { kind: { file: 'file', email: 'email', tel: 'tel', url: 'url' }[input.type] || 'text' };
    if (!d || !label) continue;
    out.push(
      question({ label, ...d, section, required: /✱/.test(labelEl ? labelEl.textContent : ''), host: u.hostname }),
    );
  }
  const title = clean((document.querySelector('.posting-headline h2') || {}).textContent);
  const description = clean(
    (document.querySelector('.section-wrapper.page-full-width') || document.body || {}).textContent,
  );
  return { ats: 'lever', company: path.split('/')[1], title, description: description.slice(0, 12000), questions: out };
}

/* ------------------------------------------------------------------ main */

export async function liveForm(url) {
  const fetchJson = (u, init) =>
    fetch(u, { ...init, headers: { Accept: 'application/json', ...((init && init.headers) || {}) } })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  const fetchText = (u) =>
    fetch(u)
      .then((r) => (r.ok ? r.text() : null))
      .catch(() => null);
  let resolved = url;
  // Trackr's short links (grnh.se, apptrkr.io) redirect to the board.
  if (/grnh\.se|apptrkr\.io/.test(url))
    resolved = await fetch(url, { redirect: 'follow' }).then(
      (r) => r.url,
      () => url,
    );
  const host = new URL(resolved).hostname;
  if (/greenhouse\.io$/.test(host) || new URL(resolved).searchParams.get('gh_jid'))
    return greenhouse(resolved, fetchJson);
  if (host === 'jobs.ashbyhq.com') return ashby(resolved, fetchJson);
  if (/lever\.co$/.test(host)) return lever(resolved, fetchText);
  return null;
}
