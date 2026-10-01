/*
 * JobToFill — job postings: find the real job description behind an application page and prove
 * it is the same job. Pure logic (no extension APIs); depends only on JTF.util.
 *
 *   ats(url)                      → { name, company, jobId, stage: 'description'|'application'|'unknown' }
 *   fromDocument(doc, url)        → posting | null   JSON-LD, microdata, ATS markup, embedded JSON, main text
 *   fromHtml(html, url)           → posting | null   same, parsed with DOMParser (throws without one)
 *   htmlToText(html)              → plain text: paragraphs, "• " bullets, entities decoded
 *   apiRequests(url)              → [{ url, method, headers, body, kind, page }] public ATS JSON endpoints
 *   fromApi(kind, json, url)      → posting | null   (url: the job page the request was made for)
 *   applicationContext(doc, url)  → { url, host, ats, title, company, location, jobIds, referrer, canonical,
 *                                     links: [{ url, text }], posting, pageText }   JSON-serialisable
 *   candidates(context)           → [{ url, reason, weight, request? }] best first
 *   historyQuery(context, now?)   → [{ text, startTime, maxResults }] for chrome.history.search
 *   rankHistory(context, items)   → candidates from history items { url, title, lastVisitTime, visitCount }
 *   compare(context, posting)     → { score: 0..1, verdict: 'same'|'different'|'unsure', reasons: [] }
 *   find(context, { fetch, historySearch, now, budget, timeout })
 *                                 → Promise<{ posting, verdict, reasons, source, tried: [{ url, outcome }] }>
 *
 * A posting is { url, title, company, location, jobIds, description, source, ats, datePosted,
 * employmentType, confidence }; description is plain text with blank-line paragraphs and "• " bullets.
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});
  const U = JTF.util;
  const norm = (s) => U.normalize(s);

  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const JSON_HEADERS = { Accept: 'application/json' };

  // Section headings that only job descriptions have.
  const JOB_HEADING =
    /\b(responsibilit|requirements?\b|qualifications?\b|what you('|’)?ll (do|bring|need|learn|get|be doing)|what you will (do|bring|learn)|what (we('|’)?re|we are) looking for|what we look for|about (the|this) (role|job|position|team|opportunity|programme|program|internship)|the role\b|your role|role overview|job (description|summary|purpose|overview|responsibilities)|key (skills|duties|accountabilities|responsibilities)|duties\b|who you are|about you|your profile|your impact|skills (and|&) experience|experience (and|&) skills|essential (skills|criteria)|desirable|preferred qualifications|basic qualifications|minimum qualifications|nice to have|what we offer|benefits\b|you will\b|you have\b|you('|’)?ll\b)/i;
  // Pages that are not a single job: searches, lists, sign-in.
  const LIST_PAGE =
    /([?&](q|query|keywords?|search|k)=)|\/(search|jobs\/?$|careers\/?$|job-search|search-results|results|saved-?jobs|jobs\/search|joblist|openings\/?$|positions\/?$)/i;
  const SEARCH_HOST =
    /(^|\.)(google|bing|duckduckgo|yahoo|ecosia|baidu|yandex|startpage|search\.brave)\.[a-z.]+$|^(t\.co|lnkd\.in)$/i;
  const LOGIN_PAGE = /\/(login|log-in|signin|sign-in|sso|auth|oauth|register|signup|sign-up|account)(\/|$|\?)/i;
  const ACTION_LINK =
    /logout|log-out|signout|sign-out|unsubscribe|delete|remove|withdraw|cancel|confirm|verify|activate|reset|token=|password/i;

  /* ------------------------------------------------------------- helpers */

  function parseUrl(url, base) {
    try {
      return new URL(url, base);
    } catch (err) {
      return null;
    }
  }

  function safeDecode(s) {
    try {
      return decodeURIComponent(s);
    } catch (err) {
      return s;
    }
  }

  function clean(s, max = 300) {
    if (s == null) return '';
    const out = String(s).replace(/\s+/g, ' ').trim();
    return out.length > max ? out.slice(0, max).trim() : out;
  }

  function words(s) {
    const m = String(s || '').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
    return m ? m.length : 0;
  }

  /** "https://x/y/?a#b" and "https://x/y?a" are the same page. */
  function urlKey(url) {
    const u = parseUrl(url);
    if (!u) return String(url || '');
    u.hash = '';
    return (u.origin + u.pathname.replace(/\/+$/, '') + u.search).toLowerCase();
  }

  function compact(s) {
    return norm(s).replace(/ /g, '');
  }

  function uniq(list) {
    return Array.from(new Set(list.filter(Boolean)));
  }

  /** The registrable-ish label of a host: careers.jumptrading.com → jumptrading. */
  function companyFromHost(host) {
    const labels = String(host || '')
      .toLowerCase()
      .split('.')
      .filter(Boolean);
    if (labels.length < 2) return labels[0] || null;
    let i = labels.length - 2;
    if (labels[labels.length - 1].length === 2 && /^(co|com|org|ac|gov|net|ltd|plc)$/.test(labels[i]) && i > 0) i--;
    return labels[i];
  }

  /* ------------------------------------------------------------ html → text */

  // prettier-ignore
  const ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
    ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', sbquo: '‚',
    bdquo: '„', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', euro: '€', pound: '£',
    yen: '¥', cent: '¢', deg: '°', times: '×', divide: '÷', laquo: '«', raquo: '»', shy: '',
    zwj: '', zwnj: '', lrm: '', rlm: '', eacute: 'é', egrave: 'è', ecirc: 'ê', aacute: 'á',
    agrave: 'à', acirc: 'â', auml: 'ä', ouml: 'ö', uuml: 'ü', szlig: 'ß', ccedil: 'ç', ntilde: 'ñ',
    oacute: 'ó', iacute: 'í', uacute: 'ú', Eacute: 'É', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', frac12: '½',
    sect: '§', para: '¶', plusmn: '±', rarr: '→', larr: '←', check: '✓', hyphen: '-', dash: '-',
  };

  function decodeEntities(s) {
    return String(s).replace(/&(#x[\da-f]+|#\d+|[a-z][a-z\d]{1,8});?/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        if (!code || code > 0x10ffff) return m;
        return code === 160 ? ' ' : String.fromCodePoint(code);
      }
      return Object.prototype.hasOwnProperty.call(ENTITIES, e) ? ENTITIES[e] : m;
    });
  }

  const BLOCK_TAGS =
    'p|div|section|article|header|footer|main|aside|h[1-6]|ul|ol|dl|table|tbody|thead|tfoot|blockquote|pre|figure|figcaption|form|fieldset|address|hr|nav|details|summary';

  /** Readable plain text from an HTML fragment (or entity-encoded HTML, as some APIs and JSON-LD send). */
  function htmlToText(html) {
    if (html == null) return '';
    let s = String(html);
    if (!/<[a-z!/]/i.test(s) && /&lt;\/?[a-z]/i.test(s)) s = decodeEntities(s);
    if (!/<[a-z!/]/i.test(s)) return tidy(decodeEntities(s));
    s = s
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(
        /<(script|style|noscript|template|svg|head|title|button|select|iframe|textarea)\b[\s\S]*?<\/\1\s*>/gi,
        ' ',
      )
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '\n• ')
      .replace(/<\/(li|dt|dd|tr)\s*>/gi, '\n')
      .replace(new RegExp(`</?(${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n\n')
      .replace(/<\/?(td|th)\b[^>]*>/gi, ' ')
      .replace(/<[^>]*>/g, '');
    return tidy(decodeEntities(s));
  }

  function tidy(s) {
    const lines = String(s)
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t\f\v\u00a0\u2000-\u200b\u202f\u205f\u3000]+/g, ' ')
      .split('\n')
      .map((l) => l.trim());
    // "• " followed by its text on a later line (an <li> wrapping a <p>): join them.
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      if (/^•\s*$/.test(line)) {
        let j = i + 1;
        while (j < lines.length && !lines[j]) j++;
        if (j < lines.length && !/^•/.test(lines[j])) {
          line = '• ' + lines[j];
          i = j;
        } else continue;
      }
      out.push(line);
    }
    // Drop blank lines between consecutive bullets so lists stay together.
    const joined = [];
    for (let i = 0; i < out.length; i++) {
      if (!out[i] && joined.length && /^•/.test(joined[joined.length - 1])) {
        let j = i;
        while (j < out.length && !out[j]) j++;
        if (j < out.length && /^•/.test(out[j])) {
          i = j - 1;
          continue;
        }
      }
      joined.push(out[i]);
    }
    return joined
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function elText(el) {
    if (!el) return '';
    return htmlToText(el.innerHTML != null ? el.innerHTML : el.textContent || '');
  }

  function shortText(el, max = 200) {
    if (!el) return '';
    return clean(el.textContent || '', max);
  }

  function attr(doc, selector, name) {
    try {
      const el = doc.querySelector(selector);
      return el ? clean(el.getAttribute(name) || '') : '';
    } catch (err) {
      return '';
    }
  }

  function q(doc, selector) {
    try {
      return doc.querySelector(selector);
    } catch (err) {
      return null;
    }
  }

  function qa(doc, selector) {
    try {
      return Array.from(doc.querySelectorAll(selector));
    } catch (err) {
      return [];
    }
  }

  /* --------------------------------------------------------------- ATS URLs */

  /** Which applicant tracking system serves this URL, for which company, which job, and which step. */
  function ats(url) {
    const out = { name: null, company: null, jobId: null, stage: 'unknown' };
    const u = parseUrl(url);
    if (!u || !/^https?:$/.test(u.protocol)) return out;
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const parts = u.pathname.split('/').filter(Boolean).map(safeDecode);
    const lower = parts.map((p) => p.toLowerCase());
    const qp = u.searchParams;
    const set = (name, company, jobId, stage, extra) =>
      Object.assign(out, { name, company: company || null, jobId: jobId || null, stage }, extra || {});
    const has = (...names) => names.some((n) => lower.includes(n));
    let m;

    // Greenhouse: job-boards(.eu).greenhouse.io/{board}/jobs/{id}, boards.greenhouse.io/embed/job_app?for=&token=
    if (/(^|\.)greenhouse\.io$/.test(host)) {
      if (lower[0] === 'embed') {
        const stage = lower[1] === 'job_app' ? 'application' : 'unknown';
        return set('greenhouse', qp.get('for'), qp.get('token') || qp.get('gh_jid'), stage);
      }
      const i = lower.indexOf('jobs');
      if (i >= 1 && /^\d+$/.test(parts[i + 1] || '')) {
        const stage = lower[i + 2] === 'confirmation' ? 'unknown' : 'description';
        return set('greenhouse', parts[0], parts[i + 1], stage);
      }
      return set('greenhouse', parts[0] || qp.get('for'), qp.get('token') || qp.get('gh_jid'), 'unknown');
    }
    if (host === 'grnh.se') return set('greenhouse', null, null, 'unknown');
    if (qp.get('gh_jid') && /^\d+$/.test(qp.get('gh_jid')))
      return set('greenhouse', companyFromHost(host), qp.get('gh_jid'), 'description');

    // Lever: jobs(.eu).lever.co/{company}/{uuid}[/apply]
    if (/^jobs\.(eu\.)?lever\.co$/.test(host)) {
      const id = UUID_RE.test(parts[1] || '') ? parts[1].toLowerCase() : null;
      const stage = lower[2] === 'apply' ? 'application' : id && !lower[2] ? 'description' : 'unknown';
      return set('lever', parts[0], id, stage);
    }

    // Ashby: jobs.ashbyhq.com/{org}/{uuid}[/application]; company sites with ?ashby_jid=
    if (host === 'jobs.ashbyhq.com') {
      const id = UUID_RE.test(parts[1] || '') ? parts[1].toLowerCase() : null;
      const stage = lower[2] === 'application' ? 'application' : id ? 'description' : 'unknown';
      return set('ashby', parts[0], id, stage);
    }
    if (qp.get('ashby_jid')) return set('ashby', companyFromHost(host), qp.get('ashby_jid'), 'description');

    // Workday: {tenant}.wd{n}.myworkdayjobs.com/{locale?}/{site}/job/{location}/{slug}_{REQ}[/apply/...]
    if (/\.myworkdayjobs\.com$|(^|\.)myworkdaysite\.com$/.test(host)) {
      let tenant = host.split('.')[0];
      let rest = parts;
      if (/myworkdaysite\.com$/.test(host) && lower[0] === 'recruiting') {
        tenant = parts[1];
        rest = parts.slice(2);
      }
      if (rest[0] && /^[a-z]{2}(-[a-z]{2,4})?$/i.test(rest[0]) && rest.length > 1) rest = rest.slice(1);
      const site = rest[0] || null;
      const k = rest.findIndex((p) => p === 'job' || p === 'details');
      const applyAt = rest.findIndex((p, i) => i > k && /^apply$/i.test(p));
      let jobId = null;
      let jobPath = null;
      if (k > 0) {
        const tail = rest.slice(k + 1, applyAt > 0 ? applyAt : undefined);
        const slug = tail[tail.length - 1] || '';
        const mm = slug.match(/_((?:[A-Z]{1,5}[-_]?)?\d[\w-]*?)(?:-\d{1,2})?$/i) || slug.match(/_([A-Za-z0-9-]{3,})$/);
        jobId = mm ? mm[1] : null;
        jobPath = tail.length ? tail.join('/') : null;
      }
      const stage = applyAt > 0 || has('apply') ? 'application' : jobPath ? 'description' : 'unknown';
      return set('workday', tenant, jobId, stage, { site, jobPath });
    }

    // SmartRecruiters: jobs.smartrecruiters.com/{company}/{id}-{slug}; one-click apply: /oneclick-ui/company/{co}/publication/{uuid}
    if (/^(jobs|careers)\.smartrecruiters\.com$/.test(host)) {
      if (lower[0] === 'oneclick-ui') {
        const co = parts[lower.indexOf('company') + 1];
        const pub = parts[lower.indexOf('publication') + 1];
        return set('smartrecruiters', co, pub && UUID_RE.test(pub) ? pub.toLowerCase() : null, 'application');
      }
      m = (parts[1] || '').match(/^(\d{6,})(?:-|$)/) || (UUID_RE.test(parts[1] || '') ? [0, parts[1]] : null);
      const stage = m ? (lower[2] === 'apply' ? 'application' : 'description') : 'unknown';
      return set('smartrecruiters', parts[0], m ? m[1] : null, stage);
    }

    // Workable: apply.workable.com/{account}/j/{shortcode}[/apply]; {account}.workable.com/j/{shortcode}
    if (/(^|\.)workable\.com$/.test(host) && host !== 'jobs.workable.com') {
      const j = lower.indexOf('j');
      const account = host === 'apply.workable.com' ? parts[0] : host.split('.')[0];
      const code = j >= 0 ? parts[j + 1] : null;
      const stage = code ? (lower[j + 2] === 'apply' ? 'application' : 'description') : 'unknown';
      return set('workable', account, code, stage);
    }

    // iCIMS: careers-{co}.icims.com/jobs/{id}/{slug}/job (description) or …/login, /candidate (application)
    if (/\.icims\.com$/.test(host)) {
      const company = host
        .split('.')[0]
        .replace(/^(careers|jobs|uscareers|externalcareers|external|career|global|apply|hr)-/, '');
      const i = lower.indexOf('jobs');
      const id = i >= 0 && /^\d+$/.test(parts[i + 1] || '') ? parts[i + 1] : null;
      const last = lower[lower.length - 1] || '';
      const stage = !id
        ? 'unknown'
        : /^(login|candidate|apply|questions|submit|profile)$/.test(last) || qp.get('mode') === 'apply'
          ? 'application'
          : 'description';
      return set('icims', company, id, stage);
    }

    // Oracle Recruiting Cloud: *.oraclecloud.com/hcmUI/CandidateExperience/{lang}/sites/{site}/job/{id}[/apply/...]
    if (/\.oraclecloud\.com$/.test(host) && has('candidateexperience')) {
      const s = lower.indexOf('sites');
      const site = s >= 0 ? parts[s + 1] : null;
      const j = lower.findIndex((p, i) => (p === 'job' || p === 'preview') && /^\d+$/.test(parts[i + 1] || ''));
      const id = j >= 0 ? parts[j + 1] : qp.get('selectedItem') || null;
      const stage = has('apply') ? 'application' : id ? 'description' : 'unknown';
      return set('oracle', host.split('.')[0], id, stage, { site });
    }

    // SAP SuccessFactors: career{n}.successfactors.com/career?career_job_req_id=…; RMK sites /job/{slug}/{id}/
    if (/(successfactors|sapsf)\.(com|eu|cn)$/.test(host)) {
      const id = qp.get('career_job_req_id') || qp.get('jobId') || qp.get('jobReqId');
      const ns = (qp.get('career_ns') || '').toLowerCase();
      const stage = /application|apply/.test(ns) ? 'application' : id ? 'description' : 'unknown';
      return set('successfactors', qp.get('company'), id, stage);
    }
    if (lower[0] === 'talentcommunity' && lower[1] === 'apply' && /^\d+$/.test(parts[2] || ''))
      return set('successfactors', companyFromHost(host), parts[2], 'application');
    m = u.pathname.match(/^\/(?:[\w-]+\/)?job\/[^/]+\/(\d{7,})\/?$/);
    if (m) return set('successfactors', companyFromHost(host), m[1], 'description');

    // Taleo: {co}.taleo.net/careersection/{section}/jobdetail.ftl?job={id} / jobapply.ftl
    if (/(^|\.)taleo\.net$/.test(host)) {
      const id = qp.get('job') || qp.get('requisition') || null;
      const stage = /jobapply|application|apply/.test(u.pathname.toLowerCase())
        ? 'application'
        : /jobdetail/.test(u.pathname.toLowerCase())
          ? 'description'
          : 'unknown';
      return set('taleo', host.split('.')[0], id, stage);
    }

    // Eightfold: {co}.eightfold.ai/careers?pid={id} | /careers/job/{id} | /careers/apply?pid=
    if (
      /(^|\.)eightfold\.ai$/.test(host) ||
      (lower[0] === 'careers' && qp.get('pid') && /^\d+$/.test(qp.get('pid'))) ||
      (lower[0] === 'careers' && lower[1] === 'job' && /^\d{10,}$/.test(parts[2] || ''))
    ) {
      const j = lower.indexOf('job');
      const id = qp.get('pid') || (j >= 0 && /^\d+$/.test(parts[j + 1] || '') ? parts[j + 1] : null);
      const stage = has('apply') ? 'application' : id ? 'description' : 'unknown';
      const company = /eightfold\.ai$/.test(host) ? host.split('.')[0] : companyFromHost(host);
      return set('eightfold', company, id, stage, { domain: qp.get('domain') || null });
    }

    // Avature: {co}.avature.net/{lang}/{portal}/JobDetail/{slug?}/{id}; apply: ApplicationMethods?jobId=, Login?jobId=
    if (/\.avature\.net$/.test(host) || has('jobdetail') || /^\d+$/.test(qp.get('jobId') || '-')) {
      const d = lower.indexOf('jobdetail');
      if (d >= 0 || /\.avature\.net$/.test(host)) {
        const tailId = d >= 0 ? parts.slice(d + 1).find((p) => /^\d+$/.test(p)) : null;
        const id = tailId || qp.get('jobId') || qp.get('jobid') || null;
        const stage =
          d >= 0
            ? 'description'
            : /applicationmethods|login|register|apply/i.test(u.pathname)
              ? 'application'
              : 'unknown';
        return set('avature', host.split('.')[0], id, stage);
      }
    }

    // Phenom People career sites: /{country}/{lang}/job/{id}/{slug}; apply: /{country}/{lang}/apply?jobSeqNo=
    if (parts.length >= 3 && /^[a-z]{2}(?:[-_][a-z]{2})?$/i.test(parts[1]) && /^[a-z-]{2,10}$/i.test(parts[0])) {
      if (lower[2] === 'job' && parts[3]) return set('phenom', companyFromHost(host), parts[3], 'description');
      if (lower[2] === 'apply' && qp.get('jobSeqNo'))
        return set('phenom', companyFromHost(host), null, 'application', { jobSeqNo: qp.get('jobSeqNo') });
    }

    // Recruitee: {co}.recruitee.com/o/{slug}[/c/new]
    if (/\.recruitee\.com$/.test(host)) {
      const o = lower.indexOf('o');
      const slug = o >= 0 ? parts[o + 1] : null;
      return set(
        'recruitee',
        host.split('.')[0],
        slug,
        slug ? (lower[o + 2] === 'c' ? 'application' : 'description') : 'unknown',
      );
    }

    // Teamtailor: {co}.teamtailor.com/jobs/{id}-{slug}[/applications/new]
    if (/\.teamtailor\.com$/.test(host)) {
      const j = lower.indexOf('jobs');
      const mm = j >= 0 && (parts[j + 1] || '').match(/^(\d+)/);
      const stage = mm ? (has('applications', 'apply') ? 'application' : 'description') : 'unknown';
      return set('teamtailor', host.split('.')[0], mm ? mm[1] : null, stage);
    }

    // Personio: {co}.jobs.personio.de/job/{id}[/apply]
    if (/\.jobs\.personio\.(de|com)$/.test(host)) {
      const j = lower.indexOf('job');
      const id = j >= 0 && /^\d+$/.test(parts[j + 1] || '') ? parts[j + 1] : null;
      const stage = id ? (has('apply') || u.hash === '#apply' ? 'application' : 'description') : 'unknown';
      return set('personio', host.split('.')[0], id, stage);
    }

    // BambooHR: {co}.bamboohr.com/careers/{id}[/apply]
    if (/\.bamboohr\.com$/.test(host)) {
      const c = lower.indexOf('careers');
      const id = c >= 0 && /^\d+$/.test(parts[c + 1] || '') ? parts[c + 1] : qp.get('id');
      const stage = id ? (has('apply') ? 'application' : 'description') : 'unknown';
      return set('bamboohr', host.split('.')[0], id, stage);
    }

    // Jobvite: jobs.jobvite.com/{co}/job/{id}[/apply]
    if (/(^|\.)jobvite\.com$/.test(host)) {
      const j = lower.indexOf('job');
      const id = j >= 0 ? parts[j + 1] : qp.get('j') || null;
      const stage = id ? (has('apply') ? 'application' : 'description') : 'unknown';
      return set('jobvite', j > 0 ? parts[0] : host.split('.')[0], id, stage);
    }

    // A few more hosted boards that have a job page and a separate apply step.
    if (/\.breezy\.hr$/.test(host) && lower[0] === 'p' && parts[1]) {
      const id = parts[1].split('-')[0];
      return set('breezy', host.split('.')[0], id, lower[2] === 'apply' ? 'application' : 'description');
    }
    if (/\.pinpointhq\.com$/.test(host)) {
      const p = lower.indexOf('postings');
      const id = p >= 0 ? parts[p + 1] : null;
      const stage = id ? (has('applications', 'apply') ? 'application' : 'description') : 'unknown';
      return set('pinpoint', host.split('.')[0], id, stage);
    }
    if (host === 'ats.rippling.com') {
      const j = lower.indexOf('jobs');
      const id = j >= 0 && UUID_RE.test(parts[j + 1] || '') ? parts[j + 1].toLowerCase() : null;
      const stage = id ? (has('apply') ? 'application' : 'description') : 'unknown';
      return set('rippling', j > 0 ? parts[j - 1] : null, id, stage);
    }
    if (/\.applytojob\.com$/.test(host)) {
      const a = lower.indexOf('apply');
      return set('jazzhr', host.split('.')[0], a >= 0 ? parts[a + 1] : null, 'description');
    }
    if (/(^|\.)ultipro\.com$|(^|\.)ukg\.net$/.test(host)) {
      const id = qp.get('opportunityId');
      const stage = id ? (/apply/i.test(u.pathname) ? 'application' : 'description') : 'unknown';
      return set('ukg', parts[0], id, stage);
    }

    // Anything else: guess from the path.
    const path = u.pathname.toLowerCase();
    out.jobId = urlJobIds(url)[0] || null;
    if (/\/(apply|application|applications|apply-now|candidate|register|login|signin)(\/|$)/.test(path))
      out.stage = 'application';
    else if (out.jobId && /job|career|position|vacanc|opening|posting|opportunit|role/.test(path))
      out.stage = 'description';
    return out;
  }

  /** IDs that a URL carries: query parameters, requisition-like path tokens, uuids and long numbers. */
  function urlJobIds(url) {
    const u = parseUrl(url);
    if (!u) return [];
    const ids = [];
    for (const key of [
      'gh_jid',
      'jobId',
      'jobid',
      'job_id',
      'job',
      'jid',
      'id',
      'pid',
      'reqId',
      'req',
      'requisitionId',
      'career_job_req_id',
      'opportunityId',
      'token',
      'ashby_jid',
      'jobReqId',
      'postingId',
      'jk',
    ]) {
      const v = u.searchParams.get(key);
      if (v && /\d/.test(v) && v.length <= 40 && !/^(19|20)\d\d$/.test(v)) ids.push(v);
    }
    const segs = u.pathname.split('/').map(safeDecode);
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      // Oracle's site name ("CX_1001") and similar portal names are not job IDs.
      if (i > 0 && /^(sites?|portal|board)$/i.test(segs[i - 1])) continue;
      const uuid = seg.match(UUID_RE);
      if (uuid) ids.push(uuid[0].toLowerCase());
      for (const mm of seg.matchAll(
        /(?:^|[^A-Za-z0-9])((?:R|JR|REQ|JOB|VAC|REF)[-_]?\d{3,}(?:-\d+)?)(?=$|[^A-Za-z0-9])/g,
      ))
        ids.push(mm[1]);
      if (/^\d{5,}$/.test(seg)) ids.push(seg);
      const lead = seg.match(/^(\d{6,})-/);
      if (lead) ids.push(lead[1]);
      const trail = seg.match(/[A-Za-z]{3}.*[-_](\d{4,})$/);
      if (trail && !/^(19|20)\d\d$/.test(trail[1])) ids.push(trail[1]);
      const wd = seg.match(/_([A-Z]{1,5}[-_]?\d{3,}(?:-\d+)?)$/);
      if (wd) ids.push(wd[1]);
    }
    return uniq(ids);
  }

  /** IDs written on the page: "Job ID: R-1234", "Requisition ID 5678", "REQ-0099". */
  function textJobIds(text) {
    const ids = [];
    const s = String(text || '').slice(0, 20000);
    const label =
      /\b(?:job|req(?:uisition)?|reference|ref|vacancy|posting|position|opening)\s*(?:id|no\.?|number|code|#)\s*[:#.]?\s*([A-Za-z]{0,5}[-_]?\d[\w-]{2,24})/gi;
    for (const mm of s.matchAll(label)) ids.push(mm[1].replace(/[-_.]+$/, ''));
    for (const mm of s.matchAll(/\b((?:R|JR|REQ|VAC)[-_]?\d{4,}(?:-\d+)?)\b/g)) ids.push(mm[1]);
    return uniq(ids.filter((id) => /\d{3,}/.test(id) && !/^(19|20)\d\d$/.test(id)));
  }

  function idKey(id) {
    return String(id || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
  }

  function idShape(id) {
    const k = idKey(id);
    if (UUID_RE.test(String(id))) return 'uuid';
    if (/^\d+$/.test(k)) return 'n' + Math.round(k.length / 3);
    const pre = k.match(/^[A-Z]*/)[0];
    return pre ? 'p' + pre : 'x';
  }

  function idsMatch(a, b) {
    const x = idKey(a);
    const y = idKey(b);
    if (!x || !y || x.length < 3 || y.length < 3) return false;
    if (x === y) return true;
    // "R_364008" vs "364008", "JR101594" vs "101594": the same number with and without a prefix.
    const dx = x.replace(/^[A-Z]+/, '');
    const dy = y.replace(/^[A-Z]+/, '');
    return dx.length >= 5 && dx === dy && (/^\d+$/.test(x) || /^\d+$/.test(y));
  }

  /* ------------------------------------------------------------ transforms */

  /** Job pages a URL points at: the posting behind an application step, an embed or a company-site link. */
  function descriptionUrls(url) {
    const a = ats(url);
    const u = parseUrl(url);
    if (!u) return [];
    const out = [];
    const add = (href, reason) => {
      if (href && urlKey(href) !== urlKey(url)) out.push({ url: href, reason });
    };
    const cut = (re) => {
      const v = new URL(u.href);
      v.pathname = v.pathname.replace(re, '') || '/';
      v.hash = '';
      return v.href;
    };
    switch (a.name) {
      case 'greenhouse':
        if (a.company && a.jobId && (a.stage === 'application' || !/greenhouse\.io$/.test(u.hostname)))
          add(
            `https://job-boards.greenhouse.io/${encodeURIComponent(a.company)}/jobs/${a.jobId}`,
            'the Greenhouse job page',
          );
        break;
      case 'lever':
        if (a.stage === 'application') add(cut(/\/apply\/?.*$/i), 'the Lever job page');
        break;
      case 'ashby':
        if (a.stage === 'application') add(cut(/\/application\/?.*$/i), 'the Ashby job page');
        break;
      case 'workday':
        if (a.stage === 'application') add(cut(/\/apply(\/.*)?$/i), 'the Workday job page');
        break;
      case 'smartrecruiters':
        if (a.stage === 'application' && a.jobId && /^\d+$/.test(a.jobId))
          add(`https://jobs.smartrecruiters.com/${a.company}/${a.jobId}`, 'the SmartRecruiters job page');
        break;
      case 'workable':
        if (a.stage === 'application') add(cut(/\/apply\/?.*$/i), 'the Workable job page');
        break;
      case 'icims':
        if (a.jobId) {
          const slug = u.pathname.split('/')[3];
          const page = `${u.origin}/jobs/${a.jobId}/${slug && !/^(login|candidate|apply|job)$/i.test(slug) ? slug + '/' : ''}job`;
          if (a.stage === 'application') add(page, 'the iCIMS job page');
          add(page + '?in_iframe=1', 'the iCIMS job page (frame)');
        }
        break;
      case 'oracle':
        if (a.stage === 'application' && a.jobId) add(cut(/\/apply(\/.*)?$/i), 'the Oracle job page');
        break;
      case 'successfactors':
        if (a.stage === 'application') {
          if (/career_ns=/.test(u.search)) {
            const v = new URL(u.href);
            v.searchParams.set('career_ns', 'job_listing');
            add(v.href, 'the SuccessFactors job page');
          } else if (a.jobId) add(`${u.origin}/job/${a.jobId}/`, 'the job page');
        }
        break;
      case 'taleo':
        if (a.stage === 'application' && a.jobId)
          add(u.href.replace(/jobapply\.ftl/i, 'jobdetail.ftl').replace(/#.*$/, ''), 'the Taleo job page');
        break;
      case 'eightfold':
        if (a.jobId && a.stage === 'application') {
          const v = new URL(`${u.origin}/careers`);
          v.searchParams.set('pid', a.jobId);
          if (a.domain) v.searchParams.set('domain', a.domain);
          add(v.href, 'the Eightfold job page');
        }
        break;
      case 'avature':
        if (a.stage === 'application' && a.jobId) {
          const base = u.pathname.replace(
            /\/(ApplicationMethods|Login|Register|Apply\w*|SubmitApplication\w*)(\/.*)?$/i,
            '',
          );
          add(`${u.origin}${base}/JobDetail/${a.jobId}`, 'the Avature job page');
        }
        break;
      case 'phenom':
        if (a.stage === 'application' && a.jobSeqNo) {
          // jobSeqNo = site code + job ID + "EXTERNAL" + locale: "MAMCGLOBAL" "R_364008" "EXTERNAL" "ENGLOBAL".
          const [country, lang] = u.pathname.split('/').filter(Boolean);
          const core = a.jobSeqNo.replace(/(EXTERNAL|INTERNAL)[A-Z_]*$/i, '');
          const ids = uniq([
            (core.match(/GLOBAL([A-Z0-9][\w-]*)$/) || [])[1],
            (core.match(/((?:JR|REQ|R)[-_]?\d{3,}[A-Z]{0,3})$/) || [])[1],
            (core.match(/(\d{3,}[A-Z]{0,3})$/) || [])[1],
          ]).slice(0, 2);
          for (const id of ids) add(`${u.origin}/${country}/${lang}/job/${id}`, 'the job page');
        }
        break;
      case 'recruitee':
        if (a.stage === 'application') add(cut(/\/c\/new\/?$/i), 'the Recruitee job page');
        break;
      case 'teamtailor':
        if (a.stage === 'application') add(cut(/\/applications?(\/new)?\/?$/i), 'the Teamtailor job page');
        break;
      default:
        break;
    }
    if (!out.length && a.stage === 'application') {
      const stripped = u.pathname.replace(
        /\/(apply|application|applications\/new|apply-now|login|candidate)(\/.*)?$/i,
        '',
      );
      if (stripped !== u.pathname && stripped.length > 1)
        add(
          cut(/\/(apply|application|applications\/new|apply-now|login|candidate)(\/.*)?$/i),
          'the page before the application step',
        );
    }
    return out;
  }

  /** Public JSON endpoints that return the posting behind a job or application URL. */
  function apiRequests(url) {
    const a = ats(url);
    const u = parseUrl(url);
    if (!u || !a.name) return [];
    const enc = encodeURIComponent;
    const get = (href, kind) => ({
      url: href,
      method: 'GET',
      headers: { ...JSON_HEADERS },
      body: null,
      kind,
      page: url,
    });
    const out = [];
    switch (a.name) {
      case 'greenhouse':
        if (a.jobId && a.company)
          out.push(
            get(`https://boards-api.greenhouse.io/v1/boards/${enc(a.company)}/jobs/${enc(a.jobId)}`, 'greenhouse'),
          );
        break;
      case 'lever':
        if (a.jobId && a.company) {
          const api = /\.eu\.lever\.co$/.test(u.hostname) ? 'api.eu.lever.co' : 'api.lever.co';
          out.push(get(`https://${api}/v0/postings/${enc(a.company)}/${a.jobId}`, 'lever'));
        }
        break;
      case 'ashby':
        if (a.jobId && a.company && u.hostname === 'jobs.ashbyhq.com')
          out.push(
            get(`https://api.ashbyhq.com/posting-api/job-board/${enc(a.company)}?includeCompensation=true`, 'ashby'),
          );
        break;
      case 'workday':
        if (a.jobPath && a.site)
          out.push(
            get(
              `${u.origin}/wday/cxs/${enc(a.company)}/${enc(a.site)}/job/${a.jobPath.split('/').map(enc).join('/')}`,
              'workday',
            ),
          );
        break;
      case 'smartrecruiters':
        if (a.jobId && a.company)
          out.push(
            get(
              `https://api.smartrecruiters.com/v1/companies/${enc(a.company)}/postings/${enc(a.jobId)}`,
              'smartrecruiters',
            ),
          );
        break;
      case 'workable':
        if (a.jobId && a.company)
          out.push(
            get(`https://apply.workable.com/api/v2/accounts/${enc(a.company)}/jobs/${enc(a.jobId)}`, 'workable'),
          );
        break;
      case 'oracle':
        if (a.jobId && a.site)
          out.push(
            get(
              `${u.origin}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%22${enc(a.jobId)}%22,siteNumber=${enc(a.site)}`,
              'oracle',
            ),
          );
        break;
      case 'recruitee':
        if (a.jobId) out.push(get(`${u.origin}/api/offers/${enc(a.jobId)}`, 'recruitee'));
        break;
      case 'bamboohr':
        if (a.jobId) out.push(get(`${u.origin}/careers/${enc(a.jobId)}/detail`, 'bamboohr'));
        break;
      case 'eightfold':
        if (a.jobId) {
          const domain = a.domain || u.hostname.replace(/^[^.]+\./, '').replace(/^eightfold\.ai$/, `${a.company}.com`);
          out.push(get(`${u.origin}/api/apply/v2/jobs/${enc(a.jobId)}?domain=${enc(domain)}`, 'eightfold'));
        }
        break;
      default:
        break;
    }
    return out;
  }

  /* --------------------------------------------------------------- postings */

  function makePosting(fields) {
    const p = {
      url: fields.url || '',
      title: clean(fields.title, 200),
      company: clean(fields.company, 120),
      location: clean(fields.location, 200),
      jobIds: uniq((fields.jobIds || []).map((x) => (x == null ? '' : String(x).trim())).filter((x) => x.length >= 2)),
      description: fields.description || '',
      source: fields.source || '',
      ats: fields.ats || ats(fields.url || '').name || null,
      datePosted: fields.datePosted ? String(fields.datePosted).slice(0, 40) : null,
      employmentType: fields.employmentType ? clean(fields.employmentType, 80) : null,
      confidence: fields.confidence || 0.5,
    };
    if (p.url) for (const id of urlJobIds(p.url)) if (!p.jobIds.includes(id)) p.jobIds.push(id);
    return p;
  }

  /** Does this look like a job description rather than a form, a list or legal small print? */
  function isRealDescription(text, strict) {
    const n = words(text);
    if (n < (strict ? 80 : 40)) return false;
    if (JOB_HEADING.test(text)) return true;
    if (strict) return false;
    const hits = (
      String(text).match(
        /\b(experience|skills|team|role|responsib|candidate|degree|work with|you will|we are|our)\b/gi,
      ) || []
    ).length;
    return hits >= 3;
  }

  /** Several parts (description, requirements, benefits…) as one text without repeats. */
  function joinParts(parts) {
    const out = [];
    for (const p of parts) {
      const t = p && p.html != null ? htmlToText(p.html) : htmlToText(p && p.text != null ? p.text : p);
      if (!t) continue;
      if (out.some((o) => o.includes(t.slice(0, 200)))) continue;
      out.push(p && p.title && !t.startsWith(p.title) ? `${p.title}\n\n${t}` : t);
    }
    return out.join('\n\n').trim();
  }

  function asText(v) {
    if (v == null) return '';
    if (typeof v === 'string' || typeof v === 'number') return String(v);
    if (Array.isArray(v)) return v.map(asText).filter(Boolean).join(', ');
    if (typeof v === 'object') return asText(v.name || v['@value'] || v.value || v.text || '');
    return '';
  }

  function ldLocation(loc) {
    const list = Array.isArray(loc) ? loc : loc ? [loc] : [];
    const out = [];
    for (const l of list) {
      if (!l) continue;
      if (typeof l === 'string') {
        out.push(l);
        continue;
      }
      const ad = l.address || l;
      if (typeof ad === 'string') out.push(ad);
      else {
        const country = asText(ad.addressCountry);
        const bits = [asText(ad.addressLocality), asText(ad.addressRegion), country].filter(Boolean);
        if (bits.length) out.push(uniq(bits).join(', '));
        else if (l.name) out.push(asText(l.name));
      }
    }
    return uniq(out).slice(0, 4).join(' / ');
  }

  function ldIds(identifier) {
    const list = Array.isArray(identifier) ? identifier : identifier != null ? [identifier] : [];
    return list
      .map((x) => (x && typeof x === 'object' ? x.value || x['@value'] || x.propertyID || '' : x))
      .map((x) => String(x == null ? '' : x).trim())
      .filter(Boolean);
  }

  function fromJobPostingLd(o, url) {
    const description = joinParts([
      o.description,
      o.responsibilities && { title: 'Responsibilities', html: asText(o.responsibilities) },
      o.qualifications && { title: 'Qualifications', html: asText(o.qualifications) },
      o.skills && typeof o.skills === 'string' && { title: 'Skills', html: o.skills },
      o.experienceRequirements &&
        typeof o.experienceRequirements === 'string' && { title: 'Experience', html: o.experienceRequirements },
    ]);
    let location = ldLocation(o.jobLocation);
    if (/telecommute/i.test(asText(o.jobLocationType))) location = location ? `${location} / Remote` : 'Remote';
    if (!location && o.applicantLocationRequirements) location = asText(o.applicantLocationRequirements);
    const org = Array.isArray(o.hiringOrganization) ? o.hiringOrganization[0] : o.hiringOrganization;
    return makePosting({
      url: (typeof o.url === 'string' && parseUrl(o.url, url) ? parseUrl(o.url, url).href : '') || url,
      title: htmlToText(asText(o.title || o.name)),
      company: htmlToText(asText(org)),
      location: htmlToText(location),
      jobIds: ldIds(o.identifier),
      description,
      source: 'json-ld',
      datePosted: asText(o.datePosted),
      employmentType: asText(o.employmentType),
      confidence: 0.95,
    });
  }

  // Raw newlines and tabs inside JSON-LD strings are common and make JSON.parse fail.
  // eslint-disable-next-line no-control-regex
  const CONTROL_CHARS = /[\u0000-\u001f]+/g;

  function parseJsonLoose(text) {
    const s = String(text || '')
      .trim()
      .replace(/^<!\[CDATA\[|\]\]>$/g, '')
      .replace(/^\s*\/\/[^\n]*$/gm, '');
    if (!s) return null;
    for (const fix of [
      (x) => x,
      (x) => x.replace(CONTROL_CHARS, ' '),
      (x) => x.replace(CONTROL_CHARS, ' ').replace(/,\s*([}\]])/g, '$1'),
    ]) {
      try {
        return JSON.parse(fix(s));
      } catch (err) {
        /* try the next repair */
      }
    }
    return null;
  }

  function collectTyped(node, type, out, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 8 || out.length > 50) return;
    if (Array.isArray(node)) {
      for (const n of node) collectTyped(n, type, out, depth + 1);
      return;
    }
    const t = node['@type'];
    const types = Array.isArray(t) ? t : [t];
    if (types.some((x) => String(x || '').replace(/^.*[/#:]/, '') === type)) out.push(node);
    for (const k of [
      '@graph',
      'mainEntity',
      'mainEntityOfPage',
      'itemListElement',
      'item',
      'about',
      'hasPart',
      'subjectOf',
    ])
      if (node[k] && typeof node[k] === 'object') collectTyped(node[k], type, out, depth + 1);
  }

  /** Several JobPosting blocks on one page: prefer the one this URL is about. */
  function pickPosting(list, url, heading) {
    if (list.length <= 1) return list[0] || null;
    const key = urlKey(url);
    const ids = urlJobIds(url);
    const h = norm(heading);
    let best = null;
    let bestScore = -1;
    for (const p of list) {
      let s = Math.min(words(p.description) / 1000, 0.5);
      if (p.url && urlKey(p.url) === key) s += 3;
      if (p.jobIds.some((id) => ids.some((x) => idsMatch(id, x)))) s += 2;
      if (h && norm(p.title) === h) s += 1;
      if (s > bestScore) {
        best = p;
        bestScore = s;
      }
    }
    return best;
  }

  function fromJsonLd(doc, url) {
    const found = [];
    for (const s of qa(doc, 'script[type="application/ld+json"], script[type="application/ld+json; charset=utf-8"]')) {
      const json = parseJsonLoose(s.textContent);
      if (json) collectTyped(json, 'JobPosting', found);
    }
    if (!found.length) return null;
    const postings = found.map((o) => fromJobPostingLd(o, url));
    return pickPosting(postings, url, shortText(q(doc, 'h1')));
  }

  function fromMicrodata(doc, url) {
    const scope = q(doc, '[itemtype*="JobPosting"]');
    if (!scope) return null;
    const prop = (name) => {
      const el = qa(scope, `[itemprop~="${name}"]`)[0];
      if (!el) return '';
      return clean(el.getAttribute('content') || el.getAttribute('datetime') || el.textContent || '');
    };
    const descEl = qa(scope, '[itemprop~="description"]')[0];
    const org = qa(scope, '[itemprop~="hiringOrganization"]')[0];
    const orgName = org
      ? clean((qa(org, '[itemprop~="name"]')[0] || org).getAttribute('content') || '') ||
        shortText(qa(org, '[itemprop~="name"]')[0] || org, 120)
      : '';
    const locEl = qa(scope, '[itemprop~="jobLocation"]')[0];
    let location = '';
    if (locEl) {
      const bits = ['addressLocality', 'addressRegion', 'addressCountry'].map((n) => {
        const e = qa(locEl, `[itemprop~="${n}"]`)[0];
        return e ? clean(e.getAttribute('content') || e.textContent) : '';
      });
      location = uniq(bits).join(', ') || shortText(locEl, 120);
    }
    const description = descEl ? elText(descEl) : '';
    if (!description) return null;
    return makePosting({
      url,
      title: prop('title') || prop('name'),
      company: orgName,
      location,
      jobIds: [prop('identifier')].filter(Boolean),
      description,
      source: 'microdata',
      datePosted: prop('datePosted'),
      employmentType: prop('employmentType'),
      confidence: 0.9,
    });
  }

  // Where each ATS puts the title, company, location and description in its pages.
  // prettier-ignore
  const DOM_RULES = [
    { ats: 'greenhouse', title: ['.job__title h1', '.job__title', '#header .app-title', '.app-title', 'h1.section-header'], company: ['#header .company-name', '.company-name'], location: ['.job__location', '#header .location', '.location'], description: ['.job__description', '#content .job-post-content', '#content'] },
    { ats: 'lever', title: ['.posting-headline h2', '.posting-header h2'], company: [], location: ['.posting-categories .location', '.posting-category.location', '.posting-header .posting-categories > :first-child'], description: ['.posting-page [data-qa="job-description"]', '.posting-page .section.page-centered'], all: true, skip: '.last-section-apply' },
    { ats: 'ashby', title: ['h1[class*="_title_"]', '.ashby-job-posting-heading'], company: [], location: ['[class*="_location_"]'], description: ['[class*="_descriptionText_"]', '.ashby-job-posting-right-pane'] },
    { ats: 'workday', title: ['[data-automation-id="jobPostingHeader"]'], company: [], location: ['[data-automation-id="locations"] dd', '[data-automation-id="locations"]'], description: ['[data-automation-id="jobPostingDescription"]'] },
    { ats: 'smartrecruiters', title: ['h1.job-title', '.job-title'], company: ['.header-logo img[alt]'], location: ['.job-details .job-location', '[itemprop="jobLocation"]'], description: ['.job-sections', '[itemprop="description"]'] },
    { ats: 'workable', title: ['[data-ui="job-title"]', 'h1[data-ui="job-title"]'], company: [], location: ['[data-ui="job-location"]'], description: ['[data-ui="job-description"]', '[data-ui="job-requirements"]', '[data-ui="job-benefits"]'], all: true },
    { ats: 'icims', title: ['.iCIMS_Header h1', 'h1.iCIMS_Header', '.iCIMS_JobHeaderTag h1', '.iCIMS_Header'], company: [], location: ['.iCIMS_JobHeaderGroup .header.left span:not(.field-label)'], description: ['.iCIMS_JobContent', '.iCIMS_InfoMsg_Job'], all: true },
    { ats: 'oracle', title: ['.job-details__title', 'h1.heading', '.app-header__current-page-title-container > :first-child'], company: [], location: ['.job-details__subtitle', '.job-meta__subitem', '.posting-locations .text-color-primary li', '.posting-locations .text-color-primary'], description: ['.job-details__description-content'], all: true },
    { ats: 'successfactors', title: ['[data-careersite-propertyid="title"]', '#job-title', '.jobTitle'], company: [], location: ['[data-careersite-propertyid="city"]', '[data-careersite-propertyid="location"]', '.jobGeoLocation'], description: ['[data-careersite-propertyid="description"]', '.jobdescription', '.job-description', '#job-description'] },
    { ats: 'taleo', title: ['.subtitle', '[id*="reqTitleLinkAction"]'], company: [], location: ['[id*="reqBasicLocation"]'], description: ['.editablesection', '#requisitionDescriptionInterface'] },
    { ats: 'eightfold', title: ['.position-title', 'h1[class*="position-title"]'], company: [], location: ['.position-location'], description: ['.position-job-description', '[class*="job-description"]'] },
    { ats: 'phenom', title: ['h1.job-title', '.job-title'], company: [], location: ['.job-location', '.au-target.job-location'], description: ['[data-ph-at-id="job-description-text"]', '.job-description', '.jd-info'] },
    { ats: 'avature', title: ['.banner__text__title', 'h1.title', 'h2.title'], company: [], location: [], description: ['.article--details .article__content', '.job-description', '.article__content'] },
    { ats: 'jobvite', title: ['.jv-header'], company: [], location: ['.jv-job-detail-meta'], description: ['.jv-job-detail-description'] },
    { ats: 'breezy', title: ['.banner h1', '.position-header h1'], company: [], location: ['.location'], description: ['.description'] },
    { ats: null, title: ['[itemprop="title"]', '.job-title', '.jobTitle', '.posting-title'], company: [], location: ['.job-location', '.location'], description: ['.job-description', '.jobDescription', '#job-description', '#jobDescription', '.job-details', '.job-detail', '.job-content', '.posting-description', '.vacancy-description', '[class*="JobDescription"]'] },
  ];

  function firstText(doc, selectors, max = 200, ok) {
    for (const s of selectors || []) {
      for (const el of qa(doc, s)) {
        const t = clean(s.endsWith('[alt]') ? el.getAttribute('alt') : el.textContent, max);
        if (t && (!ok || ok(t))) return t;
      }
    }
    return '';
  }

  function fromAtsDom(doc, url, name) {
    for (const rule of DOM_RULES) {
      if (rule.ats && rule.ats !== name) continue;
      let description = '';
      if (rule.all) {
        const els = [];
        for (const s of rule.description)
          for (const el of qa(doc, s)) if (!els.some((e) => e.contains(el) || el.contains(e))) els.push(el);
        description = joinParts(
          els.filter((el) => !(rule.skip && el.matches && el.matches(rule.skip))).map((el) => ({ html: el.innerHTML })),
        );
      } else {
        for (const s of rule.description) {
          const el = q(doc, s);
          const t = el ? elText(el) : '';
          if (words(t) >= 40) {
            description = t;
            break;
          }
        }
      }
      if (words(description) < 40) continue;
      return makePosting({
        url,
        title: firstText(doc, rule.title, 200, notGeneric),
        company: firstText(doc, rule.company, 120),
        location: firstText(doc, rule.location, 150),
        description,
        source: 'page',
        ats: name || null,
        confidence: rule.ats ? 0.85 : 0.75,
      });
    }
    return null;
  }

  /* ------------------------------------------------------- embedded JSON */

  /** The JSON object literal that starts at text[start] ("{"), found by bracket matching. */
  function jsonAt(text, start) {
    let depth = 0;
    let inStr = false;
    for (let i = start; i < text.length && i - start < 3e6; i++) {
      const c = text[i];
      if (inStr) {
        if (c === '\\') i++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        depth--;
        if (depth === 0) return parseJsonLoose(text.slice(start, i + 1));
      }
    }
    return null;
  }

  const DESC_KEYS =
    /^(description|descriptionhtml|descriptionplain|jobdescription|job_description|content|externaldescriptionstr|externaldescription|jobad|body|details|posting_description|jobpostingdescription|longdescription)$/i;
  const TITLE_KEYS =
    /^(title|jobtitle|job_title|name|text|postingtitle|positiontitle|jobpostingtitle|requisitiontitle)$/i;
  const EXTRA_KEYS =
    /^(requirements|qualifications|responsibilities|benefits|externalresponsibilitiesstr|externalqualificationsstr|additional|additionalplain|lists|sections)$/i;

  /** The most posting-like object inside arbitrary JSON (a page's state or an unknown API). */
  function findPostingInJson(json) {
    let best = null;
    let bestScore = 0;
    let seen = 0;
    const walk = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 14 || ++seen > 30000) return;
      if (Array.isArray(node)) {
        for (const n of node.slice(0, 500)) walk(n, depth + 1);
        return;
      }
      let desc = '';
      let title = '';
      for (const [k, v] of Object.entries(node)) {
        if (typeof v === 'string') {
          if (DESC_KEYS.test(k) && v.length > desc.length) desc = v;
          else if (TITLE_KEYS.test(k) && !title && v.length < 200) title = v;
        }
      }
      if (desc.length >= 300) {
        const score = Math.min(desc.length, 20000) + (title ? 5000 : 0);
        if (score > bestScore) {
          bestScore = score;
          best = { node, desc, title };
        }
      }
      for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v, depth + 1);
    };
    walk(json, 0);
    if (!best) return null;
    const { node } = best;
    const extras = [];
    for (const [k, v] of Object.entries(node)) {
      if (!EXTRA_KEYS.test(k) || !v) continue;
      if (typeof v === 'string') extras.push({ html: v });
      else if (Array.isArray(v))
        for (const item of v)
          if (item && typeof item === 'object')
            extras.push({ title: item.text || item.title, html: item.content || item.text || '' });
    }
    const loc = node.location || node.locationName || node.jobLocation || node.city || node.PrimaryLocation;
    return {
      title: htmlToText(best.title),
      description: joinParts([{ html: best.desc }, ...extras]),
      location:
        typeof loc === 'string'
          ? loc
          : loc && typeof loc === 'object'
            ? asText(loc.name || loc.city || loc.fullLocation || loc.label)
            : '',
      company: asText(node.companyName || node.company_name || node.company || node.hiringOrganization || ''),
      id: node.id || node.jobId || node.reqId || node.requisitionId || node.Id || null,
    };
  }

  function fromEmbeddedJson(doc, url) {
    let best = null;
    for (const s of qa(doc, 'script:not([src])')) {
      const type = (s.getAttribute('type') || '').toLowerCase();
      if (type === 'application/ld+json') continue;
      const text = s.textContent || '';
      if (text.length < 500 || !/description|jobDescription|descriptionHtml/i.test(text)) continue;
      let json = null;
      if (/json/.test(type)) json = parseJsonLoose(text);
      else {
        const m = text.match(
          /(?:__NEXT_DATA__|__appData|__INITIAL_STATE__|__PRELOADED_STATE__|__remixContext|__NUXT__|phApp\.ddo|jobDetail|window\.\w+)\s*=\s*\{/,
        );
        if (m) json = jsonAt(text, m.index + m[0].length - 1);
      }
      if (!json) continue;
      const found = findPostingInJson(json);
      if (found && (!best || found.description.length > best.description.length)) best = found;
    }
    if (!best || words(best.description) < 40) return null;
    return makePosting({
      url,
      title: best.title,
      company: best.company,
      location: best.location,
      jobIds: best.id != null ? [best.id] : [],
      description: best.description,
      source: 'page-data',
      confidence: 0.8,
    });
  }

  /* --------------------------------------------------- generic main content */

  const JUNK_SELECTOR =
    'script,style,noscript,template,svg,iframe,nav,footer,form,button,select,textarea,input,label,dialog,[role="navigation"],[role="contentinfo"],[role="dialog"],[role="alertdialog"],[aria-modal="true"],[hidden]';
  const JUNK_NAME =
    /(^|[\s_-])(cookies?|consent|gdpr|onetrust|ot-sdk|banner|modal|popup|newsletter|subscribe|social|share|sharing|breadcrumbs?|similar|related|recommended|recommendations|more-jobs|other-jobs|job-?alerts?|footer|sidebar|navbar|nav|menu|skip-link|search|filters?|pagination)($|[\s_-])/i;
  const GOOD_NAME = /desc|content|detail|posting|job|article|main|body|vacanc|position/i;

  function genericPosting(doc, url) {
    const body = doc.body;
    if (!body) return null;
    const clone = body.cloneNode(true);
    for (const el of qa(clone, JUNK_SELECTOR)) el.remove();
    for (const el of qa(clone, '[class],[id]')) {
      const name = `${el.getAttribute('class') || ''} ${el.getAttribute('id') || ''}`;
      if (JUNK_NAME.test(name) && !/(^|[\s_-])(job|posting)[\w-]*(desc|detail|content)/i.test(name)) el.remove();
    }
    const scores = new Map();
    const bump = (el, v) => {
      if (el && el.nodeType === 1) scores.set(el, (scores.get(el) || 0) + v);
    };
    for (const el of qa(clone, '*')) {
      let own = '';
      for (const n of el.childNodes) if (n.nodeType === 3) own += n.textContent;
      own = own.trim();
      const isHeading = /^(H[1-6]|STRONG|B|DT)$/i.test(el.tagName);
      if (isHeading && own.length < 80 && JOB_HEADING.test(own)) {
        bump(el.parentNode, 4);
        bump(el.parentNode && el.parentNode.parentNode, 2);
        continue;
      }
      if (own.length < 25) continue;
      const v = 1 + (own.match(/,/g) || []).length * 0.5 + Math.min(own.length / 100, 3);
      const p = el.parentNode;
      bump(p, v);
      bump(p && p.parentNode, v / 2);
      bump(p && p.parentNode && p.parentNode.parentNode, v / 3);
    }
    let best = null;
    let bestScore = 0;
    const ranked = Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12);
    for (const [el, raw] of ranked) {
      const text = el.textContent || '';
      if (text.length < 200) continue;
      let linkLen = 0;
      for (const a of qa(el, 'a')) linkLen += (a.textContent || '').length;
      const name = `${el.getAttribute('class') || ''} ${el.getAttribute('id') || ''}`;
      const factor = (1 - Math.min(linkLen / text.length, 1)) * (GOOD_NAME.test(name) ? 1.25 : 1);
      if (raw * factor > bestScore) {
        best = el;
        bestScore = raw * factor;
      }
    }
    if (!best) return null;
    // A description split into sibling sections (About / Responsibilities / Requirements): take their parent.
    const parent = best.parentNode;
    if (parent && parent !== clone && parent.nodeType === 1) {
      const siblings = Array.from(parent.children).filter((c) => c !== best && (scores.get(c) || 0) >= bestScore * 0.3);
      if (siblings.length && siblings.length <= 6) best = parent;
    }
    const description = elText(best);
    if (!isRealDescription(description)) return null;
    return makePosting({
      url,
      description,
      source: 'page-text',
      confidence: JOB_HEADING.test(description) ? 0.65 : 0.5,
    });
  }

  /* --------------------------------------------------------- page headings */

  const GENERIC_TITLE =
    /^(apply|application|apply now|apply for this (job|position|role)|job application|start your application|my information|personal (information|details)|sign in|log in|login|create (an )?account|careers?|jobs?|job search|search jobs|welcome|home|current vacancies|open positions|join us|thank you|are you still with us\??|work summary|job application form|candidate (home|experience)|review|submit|resume|cv|error\b|\d{3}\b|internal server error|access denied|forbidden|too many requests|just a moment|attention required|page not found|listings|search results|current openings)\b/i;
  const notGeneric = (t) => !GENERIC_TITLE.test(t);
  const SITE_PIECE =
    /^(workday|careers?|jobs?|job board|lever|greenhouse|ashby|smartrecruiters|workable|icims|taleo|avature|eightfold|oracle|apply|application|home|job details?|job description|careers? (site|page|portal)|candidate experience( page)?)$/i;

  function cleanCompany(s) {
    return clean(
      String(s || '')
        .replace(
          /\b(candidate experience page|candidate experience|careers? (site|page|portal)|careers?|jobs?|job board|recruiting|recruitment|talent community)\b/gi,
          ' ',
        )
        .replace(/\s+[|–—-]\s*$/, '')
        .replace(/^\s*[|–—-]\s+/, '')
        .replace(/\s*\blogo\b\s*/gi, ' '),
      120,
    ).replace(/[\s|–—:,-]+$/, '');
  }

  /** "jumptrading" → "Jump Trading" when the page writes it that way, else "Jumptrading". */
  function prettyCompany(slug, texts) {
    if (!slug) return '';
    const target = compact(String(slug).replace(/(careers?|jobs?|hr|recruiting|inc|llc|ltd)$/i, '')) || compact(slug);
    for (const text of texts || []) {
      const ws = String(text || '')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 400);
      for (let i = 0; i < ws.length; i++) {
        let acc = '';
        for (let n = 0; n < 4 && i + n < ws.length; n++) {
          acc += compact(ws[i + n]);
          if (acc === target && acc.length >= 2)
            return clean(
              ws
                .slice(i, i + n + 1)
                .join(' ')
                .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}.&)]+$/gu, ''),
            );
          if (acc.length >= target.length) break;
        }
      }
    }
    const s = String(slug)
      .replace(/[-_+.]+/g, ' ')
      .trim();
    return s.length <= 4 && !/\s/.test(s) ? s.toUpperCase() : s.replace(/(^|\s)\p{Ll}/gu, (c) => c.toUpperCase());
  }

  /** Title and company from document.title patterns, cross-checked with the page's headings. */
  function titleParts(docTitle, headings) {
    const t = clean(String(docTitle || '').replace(/<!--[\s\S]*?-->/g, ''), 300)
      .replace(
        /^(job application for|application for|apply for|apply to|applying for|apply|application|job)\s*[:\-–—]?\s+/i,
        '',
      )
      .trim();
    let m = t.match(/^(.+?)\s+(?:at|@)\s+(.+)$/i);
    if (m && !/[|–—]/.test(m[2])) return { title: m[1].trim(), company: cleanCompany(m[2]) };
    const pieces = t
      .split(/\s+[|–—·•]\s+|\s+-\s+|\s*::\s*/)
      .map((p) => p.trim())
      .filter((p) => p && !SITE_PIECE.test(p));
    if (!pieces.length) return { title: '', company: '' };
    const hs = headings.map(norm).filter(Boolean);
    let ti = pieces.findIndex((p) => hs.includes(norm(p)));
    if (ti < 0)
      ti = pieces.findIndex((p) => hs.some((h) => h.length > 6 && (norm(p).includes(h) || h.includes(norm(p)))));
    const titleIdx = ti >= 0 ? ti : 0;
    const others = pieces.filter((_, i) => i !== titleIdx);
    const companyPiece = others.find((p) => /careers?|jobs/i.test(p)) || others[others.length - 1] || '';
    const company = cleanCompany(companyPiece);
    // "2027 | EMEA | London | Sales & Trading | Apprentice Programme | Goldman Sachs": the title has pipes in it.
    if (ti < 0 && pieces.length >= 3 && words(pieces[titleIdx].replace(/\d+/g, '')) < 1)
      return { title: pieces.filter((p) => p !== companyPiece).join(' | '), company };
    m = pieces[titleIdx].match(/^(.+?)\s+(?:at|@)\s+(.+)$/i);
    if (m) return { title: m[1].trim(), company: company || cleanCompany(m[2]) };
    return { title: pieces[titleIdx], company };
  }

  function headingTexts(doc) {
    return qa(doc, 'h1, h2')
      .slice(0, 8)
      .map((h) => clean(h.textContent, 200))
      .filter((t) => t && !GENERIC_TITLE.test(t));
  }

  function metaContent(doc, names) {
    for (const n of names) {
      const v = attr(doc, `meta[property="${n}"]`, 'content') || attr(doc, `meta[name="${n}"]`, 'content');
      if (v) return v;
    }
    return '';
  }

  /* ------------------------------------------------------- fromDocument */

  // "The requested job could not be found", "This position is no longer available"…
  const GONE =
    /\b(job|position|posting|vacancy|role|opportunity|page|requisition|advert)\b.{0,60}\b(could ?n[o']t be found|can ?n[o']t be found|not (be )?found|no longer (available|accepting|exists|active|open|online)|has (now )?(been )?(closed|expired|filled|removed|deleted)|is (closed|expired|not currently active|not available)|does not exist)|^\s*(404|page not found|job not found|not found)\b/i;

  /** The job posting on this page (best structured source first), or null. */
  function fromDocument(doc, url) {
    if (!doc) return null;
    const pageUrl = url || (doc.location && doc.location.href) || '';
    const a = ats(pageUrl);
    const top = [
      doc.title || '',
      ...qa(doc, 'h1, h2, h3, [role="alert"], .error, .alert')
        .slice(0, 6)
        .map((h) => clean(h.textContent, 200)),
    ];
    if (top.some((t) => GONE.test(t))) return null;
    let posting = null;
    for (const step of [
      fromJsonLd,
      fromMicrodata,
      (d, u) => fromAtsDom(d, u, a.name),
      fromEmbeddedJson,
      genericPosting,
    ]) {
      let p;
      try {
        p = step(doc, pageUrl);
      } catch (err) {
        p = null;
      }
      if (p && words(p.description) >= 40) {
        posting = p;
        break;
      }
    }
    if (!posting) return null;
    // A search page's text is a list of jobs, not one.
    if (
      posting.source === 'page-text' &&
      (LIST_PAGE.test(pageUrl.replace(/^\w+:\/\/[^/]+/, '')) || (a.stage === 'unknown' && a.name))
    )
      return null;
    // Fill what the chosen source left out from the page itself.
    const heads = headingTexts(doc);
    const parts = titleParts(doc.title || '', heads);
    if (!posting.title) posting.title = heads[0] || parts.title || metaContent(doc, ['og:title']);
    if (!posting.company) {
      const og = cleanCompany(metaContent(doc, ['og:site_name', 'application-name']));
      posting.company =
        parts.company || og || (a.company ? prettyCompany(a.company, [doc.title, og, heads.join(' ')]) : '') || '';
    }
    if (!posting.location) {
      for (const rule of DOM_RULES)
        if (!rule.ats || rule.ats === a.name) posting.location = posting.location || firstText(doc, rule.location, 150);
    }
    if (!posting.ats) posting.ats = a.name;
    if (posting.url && urlKey(posting.url) !== urlKey(pageUrl) && posting.source !== 'json-ld') posting.url = pageUrl;
    if (!posting.url) posting.url = pageUrl;
    if (a.jobId && !posting.jobIds.includes(a.jobId)) posting.jobIds.push(a.jobId);
    return posting;
  }

  function parseDocument(html) {
    const P = root.DOMParser;
    if (typeof P !== 'function')
      throw new Error(
        'jobpage.fromHtml needs DOMParser: run it in a page, or set globalThis.DOMParser (e.g. from linkedom)',
      );
    return new P().parseFromString(String(html), 'text/html');
  }

  function fromHtml(html, url) {
    return fromDocument(parseDocument(html), url);
  }

  /* -------------------------------------------------------------- fromApi */

  function fromApi(kind, json, url) {
    if (!json || typeof json !== 'object') return null;
    const a = ats(url || '');
    let p = null;
    switch (kind) {
      case 'greenhouse':
        if (json.title && json.content)
          p = {
            url: json.absolute_url || url,
            title: json.title,
            company: json.company_name || '',
            location: json.location && json.location.name,
            jobIds: [json.id, json.internal_job_id, json.requisition_id],
            description: htmlToText(json.content),
            datePosted: json.first_published || json.updated_at,
          };
        break;
      case 'lever':
        if (json.text && (json.description || json.descriptionPlain)) {
          const cats = json.categories || {};
          p = {
            url: json.hostedUrl || url,
            title: json.text,
            location: (cats.allLocations && cats.allLocations.join(' / ')) || cats.location,
            jobIds: [json.id],
            description: joinParts([
              { html: json.opening || '' },
              { html: json.descriptionBody || json.description || json.descriptionPlain },
              ...(json.lists || []).map((l) => ({ title: htmlToText(l.text), html: `<ul>${l.content || ''}</ul>` })),
              { html: json.additional || json.additionalPlain || '' },
            ]),
            employmentType: cats.commitment,
            datePosted: json.createdAt ? new Date(json.createdAt).toISOString().slice(0, 10) : null,
          };
        }
        break;
      case 'ashby': {
        const jobs = Array.isArray(json.jobs) ? json.jobs : json.jobPosting ? [json.jobPosting] : [];
        const id = a.jobId || ((String(url).match(UUID_RE) || [])[0] || '').toLowerCase();
        const job = jobs.find(
          (j) => String(j.id).toLowerCase() === id || (j.jobUrl && String(j.jobUrl).toLowerCase().includes(id)),
        );
        if (job)
          p = {
            url: job.jobUrl || url,
            title: job.title,
            company: (json.organization && json.organization.name) || '',
            location: uniq([
              job.location || job.locationName,
              ...(job.secondaryLocations || []).map((l) => l.location || l.locationName),
            ]).join(' / '),
            jobIds: [job.id],
            description: htmlToText(job.descriptionHtml || job.descriptionPlain || ''),
            employmentType: job.employmentType,
            datePosted: job.publishedAt || job.publishedDate,
          };
        break;
      }
      case 'workday': {
        const info = json.jobPostingInfo;
        if (info && info.title)
          p = {
            url: info.externalUrl || url,
            title: info.title,
            company: (json.hiringOrganization && json.hiringOrganization.name) || '',
            location: uniq([info.location, ...(info.additionalLocations || [])]).join(' / '),
            jobIds: [info.jobReqId, info.jobPostingId, info.id],
            description: htmlToText(info.jobDescription || ''),
            employmentType: info.timeType,
            datePosted: info.startDate || info.postedOn,
          };
        break;
      }
      case 'smartrecruiters':
        if (json.name && json.jobAd) {
          const sec = (json.jobAd && json.jobAd.sections) || {};
          const loc = json.location || {};
          p = {
            url: json.postingUrl || url,
            title: json.name,
            company: (json.company && json.company.name) || '',
            location:
              loc.fullLocation ||
              [loc.city, loc.region, loc.country && String(loc.country).toUpperCase()].filter(Boolean).join(', '),
            jobIds: [json.id, json.uuid, json.refNumber],
            description: joinParts(
              ['jobDescription', 'qualifications', 'additionalInformation', 'companyDescription']
                .map((k) => sec[k])
                .filter((s) => s && s.text)
                .map((s) => ({ title: s.title, html: s.text })),
            ),
            employmentType: json.typeOfEmployment && json.typeOfEmployment.label,
            datePosted: json.releasedDate,
          };
        }
        break;
      case 'workable':
        if (json.title && (json.description || json.requirements)) {
          const loc = json.location || {};
          p = {
            url:
              url && !/\/api\//.test(url) ? url : `https://apply.workable.com/${a.company || ''}/j/${json.shortcode}/`,
            title: json.title,
            location: [loc.city, loc.region, loc.country].filter(Boolean).join(', '),
            jobIds: [json.shortcode, json.id],
            description: joinParts([
              { html: json.description },
              json.requirements && { title: 'Requirements', html: json.requirements },
              json.benefits && { title: 'Benefits', html: json.benefits },
            ]),
            employmentType: json.type,
            datePosted: json.published,
          };
        }
        break;
      case 'oracle': {
        const item = (json.items && json.items[0]) || null;
        if (item && item.Title)
          p = {
            url,
            title: item.Title,
            location: uniq([item.PrimaryLocation, ...((item.secondaryLocations || []).map((l) => l.Name) || [])]).join(
              ' / ',
            ),
            jobIds: [item.Id, item.RequisitionNumber],
            description: joinParts([
              { html: item.ExternalDescriptionStr },
              item.ExternalResponsibilitiesStr && { title: 'Responsibilities', html: item.ExternalResponsibilitiesStr },
              item.ExternalQualificationsStr && { title: 'Qualifications', html: item.ExternalQualificationsStr },
              item.CorporateDescriptionStr && { html: item.CorporateDescriptionStr },
              item.OrganizationDescriptionStr && { html: item.OrganizationDescriptionStr },
            ]),
            employmentType: item.JobSchedule || item.WorkerType,
            datePosted: item.ExternalPostedStartDate,
          };
        break;
      }
      case 'recruitee': {
        const o = json.offer;
        if (o && o.title)
          p = {
            url: o.careers_url || url,
            title: o.title,
            company: o.company_name,
            location: o.location || [o.city, o.country].filter(Boolean).join(', '),
            jobIds: [o.id, o.slug],
            description: joinParts([
              { html: o.description },
              o.requirements && { title: 'Requirements', html: o.requirements },
            ]),
            employmentType: o.employment_type_code,
            datePosted: o.published_at,
          };
        break;
      }
      case 'bamboohr': {
        const o = json.result && json.result.jobOpening;
        if (o && o.jobOpeningName) {
          const loc = o.location || {};
          p = {
            url,
            title: o.jobOpeningName,
            location: [loc.city, loc.state, loc.addressCountry || loc.country].filter(Boolean).join(', '),
            jobIds: [o.id],
            description: htmlToText(o.description || ''),
            employmentType: o.employmentStatusLabel,
            datePosted: o.datePosted,
          };
        }
        break;
      }
      case 'eightfold':
        if (json.name && json.job_description)
          p = {
            url: json.canonicalPositionUrl || url,
            title: json.name,
            location: (json.locations && json.locations.join(' / ')) || json.location,
            jobIds: [json.id, json.display_job_id, json.ats_job_id],
            description: htmlToText(json.job_description),
            employmentType: json.type,
            datePosted: json.t_create ? new Date(json.t_create * 1000).toISOString().slice(0, 10) : null,
          };
        break;
      default:
        break;
    }
    // Unknown data only: a known board's answer without this job must not yield another job from it.
    if (!p && !(kind && ['ashby', 'greenhouse', 'lever', 'workday', 'smartrecruiters', 'oracle'].includes(kind))) {
      const found = findPostingInJson(json);
      if (!found || words(found.description) < 40) return null;
      p = {
        url,
        title: found.title,
        company: found.company,
        location: found.location,
        jobIds: [found.id],
        description: found.description,
      };
    }
    if (!p || !p.description || words(p.description) < 20) return null;
    if (kind && kind === a.name && a.jobId) p.jobIds = [...(p.jobIds || []), a.jobId];
    if (!p.company && a.company) p.company = prettyCompany(a.company, [p.description.slice(0, 3000)]);
    return makePosting({
      ...p,
      jobIds: (p.jobIds || []).filter((x) => x != null && x !== ''),
      source: 'api',
      ats: a.name || kind,
      confidence: 0.95,
    });
  }

  /* -------------------------------------------------- applicationContext */

  const LINK_TEXT =
    /\b(view|see|read|show|open|back to|return to|full|original)\b.{0,25}\b(job|posting|position|role|description|details|vacancy|opportunity|advert|listing)\b|\bjob (description|details|posting|summary|advert)\b|\bposition (description|details)\b|\bview (the )?(full )?(job|description)\b/i;

  function visibleText(doc) {
    const body = doc.body;
    if (!body) return '';
    let t;
    try {
      t = typeof body.innerText === 'string' && body.innerText.trim() ? body.innerText : '';
    } catch (err) {
      t = '';
    }
    if (!t) t = htmlToText(body.innerHTML || '');
    return tidy(t).slice(0, 20000);
  }

  function pageLinks(doc, url, context) {
    const a0 = context.ats;
    const out = [];
    const seen = new Set([urlKey(url)]);
    const anchors = qa(doc, 'a[href]').slice(0, 3000);
    for (const el of anchors) {
      const raw = el.getAttribute('href') || '';
      if (!raw || /^(#|javascript:|mailto:|tel:)/i.test(raw)) continue;
      const u = parseUrl(raw, url);
      if (!u || !/^https?:$/.test(u.protocol)) continue;
      const href = u.href.replace(/#.*$/, '');
      const key = urlKey(href);
      if (seen.has(key) || ACTION_LINK.test(href)) continue;
      const text = clean(el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '', 120);
      const la = ats(href);
      // A board's home page or a search is never the job itself.
      if ((la.name && !la.jobId && la.stage === 'unknown') || LIST_PAGE.test(u.pathname + u.search)) continue;
      let weight = 0;
      if (LINK_TEXT.test(text) || LINK_TEXT.test(el.getAttribute('aria-label') || '')) weight = 0.75;
      if (
        la.name &&
        a0 &&
        la.name === a0.name &&
        la.stage === 'description' &&
        la.jobId &&
        a0.jobId &&
        idsMatch(la.jobId, a0.jobId)
      )
        weight = Math.max(weight, 0.8);
      if (
        context.jobIds.some((id) => id.length >= 4 && href.toLowerCase().includes(id.toLowerCase())) &&
        !LOGIN_PAGE.test(u.pathname) &&
        la.stage !== 'application'
      )
        weight = Math.max(weight, weight ? 0.85 : 0.6);
      if (!weight) continue;
      seen.add(key);
      out.push({ url: href, text: text || clean(u.pathname, 80), weight });
    }
    return out
      .sort((x, y) => y.weight - x.weight)
      .slice(0, 10)
      .map(({ url: href, text }) => ({ url: href, text }));
  }

  /** Everything this page says about the job being applied for (runs in the page; JSON-serialisable). */
  function applicationContext(doc, url) {
    const pageUrl = url || (doc && doc.location && doc.location.href) || '';
    const u = parseUrl(pageUrl);
    const a = ats(pageUrl);
    const context = {
      url: pageUrl,
      host: u ? u.hostname : '',
      ats: a,
      title: '',
      company: '',
      location: '',
      jobIds: [],
      referrer: '',
      canonical: '',
      links: [],
      posting: null,
      pageText: '',
    };
    if (!doc) return context;
    try {
      context.referrer = doc.referrer || '';
    } catch (err) {
      context.referrer = '';
    }
    const canon = attr(doc, 'link[rel="canonical"]', 'href') || metaContent(doc, ['og:url']);
    const cu = canon && parseUrl(canon, pageUrl);
    context.canonical = cu && urlKey(cu.href) !== urlKey(pageUrl) ? cu.href : '';
    context.pageText = visibleText(doc);

    let posting;
    try {
      posting = fromDocument(doc, pageUrl);
    } catch (err) {
      posting = null;
    }
    // Only a real description counts; a generic block of text on an application form doesn't.
    if (
      posting &&
      (posting.source === 'page-text' ? isRealDescription(posting.description, true) : words(posting.description) >= 60)
    )
      context.posting = posting;

    const heads = headingTexts(doc);
    const parts = titleParts(doc.title || '', heads);
    let atsTitle = '';
    let atsCompany = '';
    let atsLocation = '';
    for (const rule of DOM_RULES) {
      if (rule.ats && rule.ats !== a.name) continue;
      atsTitle = atsTitle || firstText(doc, rule.title, 200, notGeneric);
      atsCompany = atsCompany || firstText(doc, rule.company, 120);
      atsLocation = atsLocation || firstText(doc, rule.location, 150);
    }
    const og = cleanCompany(metaContent(doc, ['og:site_name', 'application-name']));
    const logoAlt = cleanCompany(
      attr(doc, 'header img[alt]', 'alt') ||
        attr(doc, '[class*="logo"] img[alt]', 'alt') ||
        attr(doc, 'img[class*="logo"][alt]', 'alt'),
    );
    const ogTitle = metaContent(doc, ['og:title', 'twitter:title']);
    const titleOk = (t) => t && !GENERIC_TITLE.test(t) && words(t) <= 20;
    context.title = clean(
      [atsTitle, posting && posting.source !== 'page-text' ? posting.title : '', parts.title, heads[0], ogTitle].find(
        titleOk,
      ) || '',
      200,
    );
    // A company slug reads better in the page's own spelling: "jumptrading" → "Jump Trading".
    const named = [posting && posting.source !== 'page-text' && posting.company, atsCompany, parts.company, og, logoAlt]
      .map(cleanCompany)
      .filter((c) => c && norm(c) !== norm(context.title) && !GENERIC_TITLE.test(c));
    const slugName = a.company
      ? prettyCompany(a.company, [doc.title, og, logoAlt, ogTitle, heads.join(' '), context.pageText.slice(0, 4000)])
      : '';
    const slugKey = a.company ? compact(a.company) : '';
    context.company =
      named.find((c) => slugKey && (compact(c).includes(slugKey) || slugKey.includes(compact(c)))) ||
      named[0] ||
      slugName ||
      '';
    context.location = clean((posting && posting.location) || atsLocation || '', 200);

    context.jobIds = uniq([
      a.jobId,
      ...urlJobIds(pageUrl),
      ...(context.canonical ? urlJobIds(context.canonical) : []),
      ...textJobIds(`${doc.title || ''}\n${context.pageText.slice(0, 6000)}`),
      ...(posting ? posting.jobIds : []),
    ]).slice(0, 12);
    context.links = pageLinks(doc, pageUrl, context);
    return context;
  }

  /* ----------------------------------------------------------- candidates */

  function isJobReferrer(context, ref) {
    const u = parseUrl(ref);
    if (!u || !/^https?:$/.test(u.protocol)) return false;
    if (SEARCH_HOST.test(u.hostname)) return false;
    if (urlKey(ref) === urlKey(context.url)) return false;
    if (
      /(^|\.)(linkedin\.com|indeed\.[a-z.]+|glassdoor\.[a-z.]+|the-trackr\.com|gradcracker\.com|brightnetwork\.co\.uk|efinancialcareers\.[a-z.]+)$/i.test(
        u.hostname,
      ) &&
      !/\/jobs\/view\/|\/viewjob|jk=/i.test(ref)
    )
      return false;
    if (LIST_PAGE.test(u.pathname + u.search) || LOGIN_PAGE.test(u.pathname)) return false;
    const a = ats(ref);
    return (
      a.stage === 'description' ||
      !!a.jobId ||
      urlJobIds(ref).length > 0 ||
      /job|career|position|vacanc|opening|posting/i.test(u.pathname)
    );
  }

  /** Places to look for the description, best first. */
  function candidates(context) {
    const ctx = context || {};
    const ctxAts = ctx.ats && 'stage' in ctx.ats ? ctx.ats : ats(ctx.url || '');
    const out = new Map();
    const add = (url, reason, weight, extra) => {
      const u = parseUrl(url);
      if (!u || !/^https?:$/.test(u.protocol)) return;
      const key = (extra && extra.request ? 'api:' : '') + urlKey(u.href);
      const isPasted = ctx.pasted && urlKey(ctx.pasted) === urlKey(u.href);
      if (!extra && key === urlKey(ctx.url) && !isPasted) return;
      // A board's home page or a search lists jobs; it never is one.
      if (!isPasted && !(extra && extra.request)) {
        const la = ats(u.href);
        if ((la.name && !la.jobId && la.stage === 'unknown') || LIST_PAGE.test(u.pathname + u.search)) return;
      }
      const prev = out.get(key);
      if (!prev || prev.weight < weight) out.set(key, { url: u.href, reason, weight, ...(extra || {}) });
    };
    const pages = uniq([ctx.pasted, ctx.url, ctx.canonical]);
    if (ctx.pasted) {
      for (const r of apiRequests(ctx.pasted))
        add(r.url, 'the job board’s data for the address you gave', 1, { request: r, structural: true });
      add(ctx.pasted, 'the address you gave', 0.99, { structural: true });
    }
    for (const page of pages) {
      const base = page === ctx.pasted ? 0.98 : 0;
      for (const r of apiRequests(page))
        add(r.url, 'the job board’s data for this job', base || 0.95, { request: r, structural: true });
      for (const t of descriptionUrls(page)) {
        add(t.url, t.reason, base || 0.9, { structural: true });
        for (const r of apiRequests(t.url))
          add(r.url, 'the job board’s data for this job', base || 0.93, { request: r, structural: true });
      }
    }
    for (const l of ctx.links || []) {
      const text = l.text || '';
      const strong = LINK_TEXT.test(text);
      const la = ats(l.url);
      const sameJob = (ctx.jobIds || []).some((id) => idKey(id).length >= 4 && idKey(l.url).includes(idKey(id)));
      add(
        l.url,
        `the page’s link “${clean(text, 60)}”`,
        strong && sameJob ? 0.88 : strong ? 0.75 : sameJob ? 0.7 : 0.5,
      );
      for (const r of apiRequests(l.url)) add(r.url, 'the job board’s data for the linked job', 0.8, { request: r });
      if (la.stage === 'application') for (const t of descriptionUrls(l.url)) add(t.url, t.reason, 0.6);
    }
    if (ctx.canonical && urlKey(ctx.canonical) !== urlKey(ctx.url))
      add(ctx.canonical, 'the page’s canonical address', 0.6);
    if (ctx.referrer && isJobReferrer(ctx, ctx.referrer)) add(ctx.referrer, 'the page you came from', 0.55);
    // A job page that hasn't rendered its description yet: its server HTML may carry JSON-LD.
    if (!ctx.posting && ctxAts.stage === 'description' && !ctx.pasted)
      out.set('self:' + urlKey(ctx.url), { url: ctx.url, reason: 'this page as the server sends it', weight: 0.45 });
    return Array.from(out.values()).sort((x, y) => y.weight - x.weight);
  }

  /* -------------------------------------------------------------- history */

  function titleCore(title) {
    return keyTokens(title, {}).slice(0, 5);
  }

  function historyQuery(context, now) {
    const ctx = context || {};
    const startTime = (now || Date.now()) - 60 * 864e5;
    const out = [];
    for (const id of (ctx.jobIds || []).filter((x) => idKey(x).length >= 4).slice(0, 2))
      out.push({ text: String(id), startTime, maxResults: 25 });
    const core = titleCore(ctx.title);
    if (core.length)
      out.push({ text: clean(String(ctx.title).replace(/[|–—:()[\]]+/g, ' '), 80), startTime, maxResults: 40 });
    if (ctx.company) out.push({ text: ctx.company, startTime, maxResults: 60 });
    else if (ctx.ats && ctx.ats.company) out.push({ text: ctx.ats.company, startTime, maxResults: 60 });
    return out;
  }

  function rankHistory(context, items, now) {
    const ctx = context || {};
    const t = now || Date.now();
    const seen = new Set();
    const out = [];
    for (const it of items || []) {
      if (!it || !it.url) continue;
      const u = parseUrl(it.url);
      if (!u || !/^https?:$/.test(u.protocol)) continue;
      const key = urlKey(it.url);
      if (seen.has(key) || key === urlKey(ctx.url)) continue;
      seen.add(key);
      if (
        SEARCH_HOST.test(u.hostname) ||
        LIST_PAGE.test(u.pathname + u.search) ||
        LOGIN_PAGE.test(u.pathname) ||
        ACTION_LINK.test(it.url)
      )
        continue;
      const a = ats(it.url);
      if (a.stage === 'application') continue;
      let w = 0.2;
      const reasons = [];
      const hay = `${it.url} ${it.title || ''}`.toLowerCase();
      if ((ctx.jobIds || []).some((id) => idKey(id).length >= 4 && idKey(hay).includes(idKey(id)))) {
        w += 0.35;
        reasons.push('job ID');
      }
      const ts = titleSimilarity(ctx.title, it.title || '', ctx);
      if (ts != null && ts >= 0.5) {
        w += 0.25 * ts;
        reasons.push('title');
      }
      const sameAts =
        a.name &&
        ctx.ats &&
        a.name === ctx.ats.name &&
        a.company &&
        ctx.ats.company &&
        compact(a.company) === compact(ctx.ats.company);
      const companyHit = ctx.company && compact(hay).includes(compact(ctx.company));
      if (sameAts || companyHit) {
        w += 0.1;
        reasons.push(sameAts ? 'same job board' : 'company');
      }
      if (!reasons.length) continue;
      const ageDays = it.lastVisitTime ? Math.max(0, (t - it.lastVisitTime) / 864e5) : 30;
      w += 0.1 * Math.exp(-ageDays / 7);
      if (a.stage === 'description' || a.jobId) w += 0.05;
      out.push({ url: it.url, reason: `in your history (${reasons.join(', ')})`, weight: Math.min(w, 0.85) });
    }
    return out.sort((x, y) => y.weight - x.weight).slice(0, 6);
  }

  /* -------------------------------------------------------------- compare */

  // prettier-ignore
  const TITLE_REWRITES = [
    [/\((m|f|w|d|h|x|all genders?)(\s*\/\s*(m|f|w|d|h|x|div))+\)/gi, ' '],
    [/\b(summer|spring|autumn|fall|winter|off[- ]?cycle)\b/gi, ' '],
    [/\b(19|20)\d\d(\s*[/-]\s*(19|20)?\d\d)?\b/g, ' '],
    [/\b(summer analysts?|summer associates?|internships?|interns?|placements?|industrial placement|work placement|co-?ops?|stagiaire|praktikum|werkstudent)\b/gi, ' intern '],
    [/\b(graduates?|grads?|new grads?|early careers?|entry[- ]level|campus|university hire|recent graduates?)\b/gi, ' graduate '],
    [/\b(programmes?|programs?|schemes?)\b/gi, ' program '],
    [/\bsr\.?\b|\bsnr\b/gi, ' senior '],
    [/\bjr\.?\b|\bjnr\b/gi, ' junior '],
    [/\bswe\b|\bsde\b/gi, ' software engineer '],
    [/\bquant\b/gi, ' quantitative '],
    [/\bops\b/gi, ' operations '],
    [/\bmgmt\b/gi, ' management '],
    [/\btech\b/gi, ' technology '],
    [/\b(engineering)\b/gi, ' engineer '],
    [/\b(developer|development)\b/gi, ' developer '],
  ];
  const TITLE_FILLER = new Set(
    'job role position opportunity vacancy hiring apply application careers career new team based remote hybrid onsite office full time part fte permanent contract temporary london new york'.split(
      ' ',
    ),
  );

  function keyTokens(title, ctx) {
    let s = String(title || '');
    for (const [re, to] of TITLE_REWRITES) s = s.replace(re, to);
    const drop = new Set([
      ...U.tokens(ctx && ctx.company),
      ...U.tokens(ctx && ctx.location),
      ...U.tokens(ctx && ctx.postingCompany),
      ...U.tokens(ctx && ctx.postingLocation),
    ]);
    const toks = U.tokens(s)
      .map((t) => (t.length > 4 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t))
      .filter((t) => !TITLE_FILLER.has(t) && !drop.has(t) && !/^\d{1,2}$/.test(t));
    return toks;
  }

  /** 0..1 how alike two job titles are once years, seasons, synonyms, company and place names are set aside. */
  function titleSimilarity(a, b, ctx) {
    if (!a || !b) return null;
    const A = keyTokens(a, ctx);
    const B = keyTokens(b, ctx);
    if (!A.length || !B.length) {
      return norm(a) && norm(a) === norm(b) ? 1 : null;
    }
    if (A.join(' ') === B.join(' ')) return 1;
    const sa = new Set(A);
    const sb = new Set(B);
    let inter = 0;
    for (const t of sa) if (sb.has(t)) inter++;
    const dice = (2 * inter) / (sa.size + sb.size);
    const small = Math.min(sa.size, sb.size);
    // One title is a shorter form of the other ("Quant Research Intern" in "Quant Research Intern – Equities").
    const contain = small >= 2 ? (inter / small) * 0.9 : 0;
    return Math.max(dice, contain);
  }

  const COMPANY_FILLER = new Set(
    'inc incorporated llc llp lp ltd limited plc corp corporation co company group holdings holding gmbh ag sa se nv bv the careers career jobs job recruiting talent international global uk us usa europe'.split(
      ' ',
    ),
  );

  function companyTokens(name) {
    return U.tokens(name).filter((t) => !COMPANY_FILLER.has(t));
  }

  /** Is `abbr` made of the starts of `toks`, in order ("jpmc" ← jp morgan chase, "gs" ← goldman sachs)? */
  function abbreviates(abbr, toks, i = 0) {
    if (!abbr) return i >= Math.min(toks.length, 2);
    if (i >= toks.length) return false;
    for (let n = Math.min(abbr.length, toks[i].length); n >= 1; n--)
      if (toks[i].startsWith(abbr.slice(0, n)) && abbreviates(abbr.slice(n), toks, i + 1)) return true;
    return false;
  }

  /** true / false / null (unknown) — are these the same employer? */
  function companyMatch(a, b) {
    const A = companyTokens(a);
    const B = companyTokens(b);
    if (!A.length || !B.length) return null;
    const ca = A.join('');
    const cb = B.join('');
    if (ca === cb) return true;
    if ((ca.length >= 4 && cb.includes(ca)) || (cb.length >= 4 && ca.includes(cb))) return true;
    if (A.some((t) => t.length >= 3 && B.includes(t))) return true;
    // Initials: "JPMC" ↔ "JP Morgan Chase", "GS" ↔ "Goldman Sachs".
    if (A.length === 1 && ca.length <= 6 && abbreviates(ca, B)) return true;
    if (B.length === 1 && cb.length <= 6 && abbreviates(cb, A)) return true;
    return false;
  }

  const LOCATION_FILLER = new Set(
    'united kingdom states america usa us uk gb england scotland wales europe emea amer apac remote hybrid office offices multiple locations location various city area greater metropolitan region state county district'.split(
      ' ',
    ),
  );

  // prettier-ignore
  const PLACE_ALIASES = { nyc: 'new york', sf: 'san francisco', bangalore: 'bengaluru', bombay: 'mumbai', gurgaon: 'gurugram', munchen: 'munich', koln: 'cologne', wien: 'vienna', zurich: 'zurich', geneve: 'geneva', milano: 'milan', roma: 'rome', praha: 'prague', warszawa: 'warsaw', lisboa: 'lisbon', 'hong kong sar': 'hong kong', dc: 'washington' };

  function placeTokens(s) {
    const n = U.normalize(s);
    const aliased = n.replace(/[\p{L}]+(?: sar)?/gu, (w) => PLACE_ALIASES[w] || w);
    return U.tokens(aliased).filter((t) => t.length > 2 && !LOCATION_FILLER.has(t));
  }

  function locationMatch(a, b) {
    if (!a || !b) return null;
    if (/remote|multiple|various|anywhere/i.test(a) || /remote|multiple|various|anywhere/i.test(b)) return null;
    const A = placeTokens(a);
    const B = placeTokens(b);
    if (!A.length || !B.length) return null;
    return A.some((t) => B.includes(t));
  }

  /** Is this posting the job the application page is for? Conservative: 'same' must be very reliable. */
  function compare(context, posting) {
    const ctx = context || {};
    if (!posting) return { score: 0, verdict: 'different', reasons: ['no posting'] };
    const reasons = [];
    const ctxAts = ctx.ats && ctx.ats.name ? ctx.ats : ats(ctx.url || '');
    const pAts = ats(posting.url || '');
    const pIds = uniq([...(posting.jobIds || []).map(String), pAts.jobId]);
    const cIds = uniq([...(ctx.jobIds || []).map(String), ctxAts.jobId]);
    const sharedId = cIds.find((c) => pIds.some((p) => idsMatch(c, p)));

    const tCtx = {
      company: ctx.company,
      location: ctx.location,
      postingCompany: posting.company,
      postingLocation: posting.location,
    };
    const t = titleSimilarity(ctx.title, posting.title, tCtx);
    const c = companyMatch(
      ctx.company || (ctxAts.company && prettyCompany(ctxAts.company)),
      posting.company || (pAts.company && prettyCompany(pAts.company)),
    );
    const l = locationMatch(ctx.location, posting.location);
    if (t != null) reasons.push(t >= 0.85 ? 'title matches' : t >= 0.5 ? 'title is similar' : 'title differs');
    if (c === true) reasons.push('company matches');
    if (c === false) reasons.push('company differs');
    if (l === true) reasons.push('location matches');
    if (l === false) reasons.push('location differs');

    if (sharedId) {
      if (c === false && t != null && t < 0.3) {
        reasons.unshift(`same job ID ${sharedId}, but nothing else matches`);
        return { score: 0.5, verdict: 'unsure', reasons };
      }
      reasons.unshift(`same job ID ${sharedId}`);
      return { score: 0.97, verdict: 'same', reasons };
    }
    // Two different jobs on the same board: same ATS and company, both with a job ID of the same kind.
    const sameBoard =
      ctxAts.name &&
      ctxAts.name === pAts.name &&
      ctxAts.company &&
      pAts.company &&
      compact(ctxAts.company) === compact(pAts.company);
    if (sameBoard && ctxAts.jobId && pAts.jobId && idShape(ctxAts.jobId) === idShape(pAts.jobId)) {
      reasons.unshift(`different job ID (${ctxAts.jobId} vs ${pAts.jobId})`);
      return { score: 0.05, verdict: 'different', reasons };
    }
    // Both addresses (or the posting's own data) name a job ID of the same kind, and they differ.
    const strongCtx = uniq([
      ctxAts.jobId,
      ...urlJobIds(ctx.url || ''),
      ...(ctx.canonical ? urlJobIds(ctx.canonical) : []),
    ]);
    const strongPost = uniq([pAts.jobId, ...(posting.jobIds || []).map(String)]);
    const sameSite =
      sameBoard ||
      (parseUrl(ctx.url || '') &&
        parseUrl(posting.url || '') &&
        companyFromHost(parseUrl(ctx.url).hostname) === companyFromHost(parseUrl(posting.url).hostname));
    const clash =
      c !== false &&
      sameSite &&
      strongCtx.find((x) =>
        strongPost.some((y) => idShape(x) === idShape(y) && idKey(x).length >= 4 && !idsMatch(x, y)),
      );
    if (clash) {
      const theirs = strongPost.find((y) => idShape(clash) === idShape(y));
      reasons.unshift(`different job ID (${clash} vs ${theirs})`);
      return { score: 0.1, verdict: 'different', reasons };
    }
    if (t == null) {
      reasons.push('not enough on the application page to compare');
      return { score: c === true ? 0.4 : 0.25, verdict: 'unsure', reasons };
    }
    const score =
      Math.round(
        (0.6 * t + 0.25 * (c === true ? 1 : c === false ? 0 : 0.5) + 0.15 * (l === true ? 1 : l === false ? 0 : 0.5)) *
          100,
      ) / 100;
    const titleTokens = keyTokens(ctx.title, tCtx).length;
    // A different single place (not "London, Paris or remote") means another vacancy, even with the same title.
    const specific = (x) => x && placeTokens(x).length <= 4 && !/[/;]|\bor\b/i.test(x);
    let verdict = 'unsure';
    if (t >= 0.92 && c === true && l !== false && (l === true || titleTokens >= 3)) verdict = 'same';
    else if (t < 0.35 || (c === false && t < 0.75) || (l === false && t < 0.6)) verdict = 'different';
    else if (l === false && c !== false && specific(ctx.location) && specific(posting.location)) verdict = 'different';
    return { score, verdict, reasons };
  }

  /* ----------------------------------------------------------------- find */

  function looksLikeShell(html) {
    const body = String(html || '').replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ');
    const text = htmlToText(body);
    return words(text) < 120;
  }

  /** Find the description for the application in `context`; see the API notes at the top. */
  async function find(context, opts = {}) {
    const ctx = context || {};
    const fetchFn = opts.fetch || (typeof root.fetch === 'function' ? root.fetch.bind(root) : null);
    const budget = opts.budget || 10;
    const timeout = opts.timeout || 9000;
    const parallel = opts.parallel || 3;
    const tried = [];
    const results = [];

    // The description is already on this page (Greenhouse, Lever and many company sites show it above the form).
    if (
      !ctx.pasted &&
      ctx.posting &&
      ctx.posting.description &&
      (ctx.posting.confidence || 0) >= 0.6 &&
      words(ctx.posting.description) >= 80
    ) {
      const cmp = compare(ctx, ctx.posting);
      if (cmp.verdict !== 'different')
        return {
          posting: ctx.posting,
          verdict: 'same',
          reasons: ['the description is on this page'],
          source: ctx.url,
          tried,
        };
    }

    let list = candidates(ctx);
    if (opts.historySearch && !ctx.pasted) {
      try {
        const items = [];
        for (const query of historyQuery(ctx, opts.now)) {
          const got = await opts.historySearch(query);
          if (Array.isArray(got)) items.push(...got);
        }
        list = list.concat(rankHistory(ctx, items, opts.now));
      } catch (err) {
        tried.push({ url: 'history', outcome: `history search failed: ${(err && err.message) || err}` });
      }
      list.sort((x, y) => y.weight - x.weight);
    }
    if (!fetchFn) {
      return { posting: null, verdict: null, reasons: ['no way to fetch pages'], source: null, tried };
    }

    const isDone = () => results.some((r) => r.cmp.verdict === 'same' && r.cmp.score >= 0.9);
    const controllers = new Set();

    async function load(c) {
      const req = c.request || null;
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      if (ctl) controllers.add(ctl);
      let timer = null;
      const outcome = (text) => tried.push({ url: c.url, outcome: text });
      try {
        const init = req
          ? { method: req.method || 'GET', headers: req.headers, ...(req.body ? { body: req.body } : {}) }
          : { method: 'GET', headers: { Accept: 'text/html,application/xhtml+xml' } };
        if (ctl) init.signal = ctl.signal;
        const res = await Promise.race([
          fetchFn(c.url, init),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              if (ctl) ctl.abort();
              reject(new Error('timed out'));
            }, timeout);
          }),
        ]);
        if (!res) return outcome('no response');
        if (res.ok === false) return outcome(`HTTP ${res.status || 'error'}`);
        const type = (res.headers && typeof res.headers.get === 'function' && res.headers.get('content-type')) || '';
        let body = typeof res.text === 'function' ? await res.text() : null;
        let json = null;
        if (body == null && typeof res.json === 'function') json = await res.json();
        if (body != null && body.length > 6e6) body = body.slice(0, 6e6);
        let posting = null;
        const finalUrl = (res.url && !req && res.url) || c.url;
        if (req || /json/i.test(type) || (body && /^\s*[{[]/.test(body) && !/^\s*</.test(body))) {
          if (!json) json = parseJsonLoose(body);
          posting = json ? fromApi(req ? req.kind : null, json, req ? req.page : finalUrl) : null;
          if (!posting) return outcome(json ? 'no posting in the data' : 'not JSON');
        } else {
          posting = fromHtml(body || '', finalUrl);
          if (!posting || words(posting.description) < 40)
            return outcome(looksLikeShell(body) ? 'empty shell (needs scripts)' : 'no posting found on the page');
        }
        if (!posting.url) posting.url = finalUrl;
        let cmp = compare(ctx, posting);
        if (
          (ctx.pasted && urlKey(c.url) === urlKey(ctx.pasted)) ||
          (c.request && c.request.page && ctx.pasted && urlKey(c.request.page) === urlKey(ctx.pasted))
        )
          cmp = { ...cmp, chosen: true };
        results.push({ c, posting, cmp });
        outcome(`${cmp.verdict} (${cmp.score.toFixed(2)}): ${posting.title || 'untitled'}`);
      } catch (err) {
        const msg = (err && err.message) || String(err);
        outcome(/abort|timed out/i.test(msg) ? 'timed out' : /skipped/i.test(msg) ? msg : `failed: ${clean(msg, 120)}`);
      } finally {
        if (timer) clearTimeout(timer);
        if (ctl) controllers.delete(ctl);
      }
    }

    // A pasted address is the user's choice: try it (and its job board data) before anything else.
    if (ctx.pasted) {
      const mine = list.filter((c) => c.weight >= 0.98);
      list = list.filter((c) => c.weight < 0.98);
      for (const c of mine) {
        await load(c);
        const hit = results.find((r) => r.cmp.chosen);
        if (hit) {
          const verdict = hit.cmp.verdict === 'same' ? 'same' : 'unsure';
          return {
            posting: hit.posting,
            verdict,
            reasons: [...hit.cmp.reasons, 'you chose this page'],
            source: ctx.pasted,
            tried,
          };
        }
      }
    }

    let used = 0;
    let next = 0;
    const worker = async () => {
      while (next < list.length && used < budget && !isDone()) {
        const c = list[next++];
        used++;
        await load(c);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, parallel) }, worker));
    for (const ctl of controllers) ctl.abort();

    for (const r of results) {
      // Reached from this very application page by the board's own URL scheme: likely the same job.
      if (
        r.cmp.verdict === 'unsure' &&
        r.c.structural &&
        r.cmp.score >= 0.45 &&
        !/different job ID/.test(r.cmp.reasons.join(' '))
      )
        r.verdict = 'likely';
      else r.verdict = r.cmp.verdict;
    }
    const rank = { same: 3, likely: 2, unsure: 1, different: 0 };
    results.sort((x, y) => rank[y.verdict] - rank[x.verdict] || y.cmp.score - x.cmp.score || y.c.weight - x.c.weight);
    const best = results[0];
    if (!best || best.verdict === 'different') {
      return {
        posting: null,
        verdict: best ? 'different' : null,
        reasons: best ? best.cmp.reasons : ['no job description found'],
        source: null,
        tried,
      };
    }
    const reasons = best.verdict === 'likely' ? [...best.cmp.reasons, best.c.reason] : best.cmp.reasons;
    return { posting: best.posting, verdict: best.verdict, reasons, source: best.c.url, tried };
  }

  const jobpage = {
    ats,
    fromDocument,
    fromHtml,
    htmlToText,
    apiRequests,
    fromApi,
    applicationContext,
    candidates,
    historyQuery,
    rankHistory,
    compare,
    find,
    // Exposed for tests and the studio.
    descriptionUrls,
    urlJobIds,
    textJobIds,
    titleSimilarity,
    companyMatch,
    findPostingInJson,
  };
  JTF.jobpage = jobpage;
  if (typeof module === 'object' && module.exports) module.exports = jobpage;
})(typeof globalThis !== 'undefined' ? globalThis : this);
