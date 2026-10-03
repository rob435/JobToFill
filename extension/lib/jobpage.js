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
 *                                 → Promise<{ posting, verdict, reasons, source, tried: [{ url, outcome }], hint? }>
 *                                   hint: { source: 'Trackr', company, programme, deadline, … } when the user came
 *                                   from Trackr (a hint for matching, never the description)
 *   trackrHint(context, items)    → { region, industry, season, type, links } | null  (referrer, trail, history)
 *
 * context may also carry trail: [{ url, title, at }] — this tab's earlier pages, newest first — and embeds
 * (job boards embedded in the page); candidates(context, now) uses both.
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
  // The same in German, French, Italian, Spanish and Dutch adverts ("Ihre Aufgaben", "Profil recherché", "Missions").
  const JOB_HEADING_INTL =
    /(stellenbeschreibung|ihre aufgaben|deine aufgaben|aufgabengebiet|ihr profil|dein profil|das bringst du mit|das bringen sie mit|was (dich|sie) erwartet|anforderungen|qualifikationen|wir bieten|das bieten wir|was wir bieten|description (du|de) poste|descriptif du poste|vos missions|votre mission|missions? principales|le poste|profil recherché|votre profil|le profil|compétences (requises|recherchées)|qualifications requises|ce que nous offrons|nous vous offrons|pourquoi nous rejoindre|responsabilità|requisiti|descrizione (del ruolo|della posizione)|cosa offriamo|il tuo profilo|responsabilidades|requisitos|funciones|ofrecemos|tu perfil|functieomschrijving|wat ga je doen|wat vragen wij|wat bieden wij)/i;
  const isJobHeading = (t) => JOB_HEADING.test(t) || JOB_HEADING_INTL.test(t);
  // Other headings a job advert's sections have (only used to find the advert's extent on a page).
  const SECTION_HEADING =
    /^(your (mission|tasks|team|day|future)|why (us|join|work)|about (us|the company|[\w&.' -]{2,40})$|who we are|our (offer|team|culture)|we offer|perks|tasks|ihre aufgaben|ihr profil|wir bieten|missions?|profil)/i;
  // Pages that are not a single job: searches, lists, sign-in.
  const LIST_PAGE =
    /([?&](q|query|keywords?|search|k)=)|\/(search|jobs\/?$|careers\/?$|job-search|search-results|results|saved-?jobs|jobs\/search|joblist|(job-|current-|open-)?openings\/?$|(open-)?positions\/?$|open-roles\/?$|(current-)?vacancies\/?$|all-jobs\/?$|find-a-(job|role)\/?$|job-offers\/?$|stellenangebote\/?$|offres(-d-emploi)?\/?$|go\/[^/]+\/\d+\/?$)/i;
  const SEARCH_HOST =
    /(^|\.)(google|bing|duckduckgo|yahoo|ecosia|baidu|yandex|startpage|search\.brave)\.[a-z.]+$|^(t\.co|lnkd\.in)$/i;
  const LOGIN_PAGE = /\/(login|log-in|signin|sign-in|sso|auth|oauth|register|signup|sign-up|account)(\/|$|\?)/i;
  const ACTION_LINK =
    /logout|log-out|signout|sign-out|unsubscribe|delete|remove|withdraw|cancel|confirm|verify|activate|reset|token=|password/i;
  const SF_HOST = /(successfactors|sapsf)\.(com|eu|cn)$/i;

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

  /**
   * A one-line field (title, company, place) as plain text: entities decoded — also twice-encoded ones
   * ("FICC &amp;amp; Equities", which a page's DOM text or JSON can still carry) — tags dropped, spaces collapsed.
   */
  function field(s, max = 200) {
    let out = s == null || s === false ? '' : String(s);
    for (let i = 0; i < 3 && /&(#x[\da-f]+|#\d+|[a-z][a-z\d]{1,8});/i.test(out); i++) {
      const next = decodeEntities(out);
      if (next === out) break;
      out = next;
    }
    if (/<\/?[a-z][a-z\d]*(\s[^<>]*)?\/?>/i.test(out)) out = out.replace(/<\/?[a-z][a-z\d]*(\s[^<>]*)?\/?>/gi, ' ');
    return clean(out, max);
  }

  /** Title, company and location of a posting or a context as plain one-line text. */
  function plainFields(o) {
    if (!o) return o;
    for (const [k, max] of [
      ['title', 200],
      ['company', 120],
      ['location', 200],
    ])
      if (typeof o[k] === 'string') o[k] = field(o[k], max);
    return o;
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

  /** An element's text on one line, without the CSS or scripts some boards put inside it (RMK's location). */
  function shortText(el, max = 200) {
    if (!el) return '';
    const html = el.innerHTML;
    const text = html != null && /<(style|script|noscript|template)\b/i.test(html) ? htmlToText(html) : el.textContent;
    return field(text || '', max);
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

    // SAP SuccessFactors' classic sites, career{n}.successfactors.com|eu and career{n}.sapsf.com|eu|cn: a job is
    // /career, /careers or /portalcareer?career_ns=job_listing&company={tenant}&career_job_req_id={req} (Trackr's
    // links add jobId=, utm_ and a session's _s.crb=) or /sfcareer/jobreqcareer?jobId={req}&company={tenant}; without
    // career_ns the same address is the site's search page. Applying: career_ns=job_application, or signing in for a
    // job (career_ns=job_save, login_ns=register). Apply posts the form to "/portalcareer?_s.crb=…" (a session token
    // alone) and every later step stays there: an application whose job only the page names (sfClassic).
    if (SF_HOST.test(host)) {
      const id = qp.get('career_job_req_id') || qp.get('jobId') || qp.get('jobReqId');
      const ns = (qp.get('career_ns') || '').toLowerCase();
      const company = qp.get('company') || qp.get('career_company');
      const session =
        !id &&
        !ns &&
        qp.has('_s.crb') &&
        parts.length === 1 &&
        /^(career|careers|portalcareer)$/.test(lower[0]) &&
        [...qp.keys()].every((k) => /^(_s\.crb|utm_\w+|lang|locale|site|company|career_company)$/i.test(k));
      const stage =
        /application|apply|job_save/.test(ns) || (id && qp.get('login_ns')) || session
          ? 'application'
          : id && (ns === 'job_listing' || has('jobreqcareer'))
            ? 'description'
            : 'unknown';
      return set('successfactors', company, id, stage);
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

    // Phenom People career sites: [/{site}]/{country}/{lang}/job/{id}/{slug}; apply: …/{country}/{lang}/apply?jobSeqNo=
    for (let k = 0; k <= 1 && k + 2 < parts.length; k++) {
      if (!/^[a-z]{2}(?:[-_][a-z]{2})?$/i.test(parts[k + 1]) || !/^[a-z-]{2,10}$/i.test(parts[k])) continue;
      const base = '/' + parts.slice(0, k + 2).join('/');
      if (lower[k + 2] === 'job' && parts[k + 3])
        return set('phenom', companyFromHost(host), parts[k + 3], 'description', { base });
      if (/^(hvh)?apply$/.test(lower[k + 2]) && qp.get('jobSeqNo'))
        return set('phenom', companyFromHost(host), null, 'application', { jobSeqNo: qp.get('jobSeqNo'), base });
    }

    // Oleeo (tal.net): {co}.tal.net/vx/…/candidate/so/pm/1/pl/1/opp/{id}-{slug}[/en-GB]; apply: …/opp/{id}/apply/…
    if (/\.tal\.net$/.test(host)) {
      const o = lower.lastIndexOf('opp');
      const mm = o >= 0 && (parts[o + 1] || '').match(/^(\d+)(?:-|$)/);
      const id = mm ? mm[1] : null;
      const after = o >= 0 ? lower.slice(o + 2) : [];
      const stage = id
        ? after.some((p) => /^(apply|application|form|register|login)$/.test(p))
          ? 'application'
          : 'description'
        : 'unknown';
      return set('tal.net', host.split('.')[0].replace(/campus$|careers$/, ''), id, stage);
    }

    // Sainoo: (www|{co}).sainoo.com/jobs/{id}[/apply] (France)
    if (/(^|\.)sainoo\.com$/.test(host) && lower[0] === 'jobs' && /^\d+$/.test(parts[1] || '')) {
      const co = host.split('.')[0];
      return set(
        'sainoo',
        co === 'sainoo' ? null : co,
        parts[1],
        has('apply', 'application') ? 'application' : 'description',
      );
    }

    // 50skills: jobs.50skills.com/{co}[/{lang}]/{id}[/apply]
    if (host === 'jobs.50skills.com') {
      const id = parts.slice(1).find((p) => /^\d+$/.test(p)) || null;
      return set('50skills', parts[0], id, id ? (has('apply') ? 'application' : 'description') : 'unknown');
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

    // Anything else: guess from the path. On a recruiting platform's subdomain the first label is the employer.
    const path = u.pathname.toLowerCase();
    out.jobId = urlJobIds(url)[0] || null;
    const tenant = host.match(
      /^([a-z0-9-]+)\.(?:grad\.allhires\.com|(?:app|hr)\.candidats\.io|ambertrack\.co\.uk|vacancy-filler\.co\.uk|apply4law\.com|current-vacancies\.com|careers\.hibob\.com|zohorecruit\.(?:com|eu)|bc\.direct|talentview\.io|jobs\.50skills\.com|easyapply\.co)$/,
    );
    if (tenant && !/^(app|www|jobs|careers|apply)$/.test(tenant[1])) out.company = tenant[1].replace(/^app-/, '');
    if (
      /\/(apply|application|applications|apply-now|candidate|new_candidate|new-candidate|register|login|signin|signup|sign-up|easyapply)(\/|$)/.test(
        path,
      )
    )
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
      'folderId',
      'vacancyId',
      'positionId',
      'jobPostingId',
      'reqid',
    ]) {
      const v = u.searchParams.get(key);
      if (v && /\d/.test(v) && v.length <= 40 && !/^(19|20)\d\d$/.test(v)) ids.push(v);
    }
    // The same names in another case ("ReqId=751069" on SAP's easy-apply pages).
    for (const [k, v] of u.searchParams)
      if (
        /^(job_?id|req_?id|requisition_?id|posting_?id|vacancy_?id|position_?id|opportunity_?id)$/i.test(k) &&
        v &&
        /\d/.test(v) &&
        v.length <= 40
      )
        ids.push(v);
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
      // Not a session's or a portal's own number ("user-415213", "brand-4", "site-12345" in Oleeo addresses).
      if (
        trail &&
        !/^(19|20)\d\d$/.test(trail[1]) &&
        !/^(user|brand|site|partner|session|sid|uid|wid|appcentre|mobile|lang|xf)[-_]/i.test(seg)
      )
        ids.push(trail[1]);
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
    // "Referenz: HP-2027-031", "Kennziffer 4711", "Réf. 2026-118", "Rif. 2026/07".
    const intl =
      /(?:^|[^\p{L}])(?:referenz(?:nummer)?|kennziffer|stellen-?id|job-?id|réf(?:érence)?|rif(?:erimento)?|referencia)\s*[:#.]?\s*([A-Za-z]{0,5}[-_]?\d[\w/-]{2,24})/giu;
    for (const mm of s.matchAll(intl)) ids.push(mm[1].replace(/[-_./]+$/, ''));
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
      case 'successfactors': {
        const page = a.stage !== 'description' ? sfJobPage(u.href, a.company, a.jobId) : '';
        if (page) add(page, 'the SuccessFactors job page');
        else if (a.stage === 'application' && a.jobId && !SF_HOST.test(u.hostname))
          add(`${u.origin}/job/${a.jobId}/`, 'the job page');
        break;
      }
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
          // jobSeqNo = site code (ending in the country) + job ID + "EXTERNAL" + locale:
          // "MAMC" "GLOBAL" "R_364008" "EXTERNAL" "ENGLOBAL", "PUDPUN" "UK" "EC202660" "EXTERNAL" "ENUK".
          const country = a.base.split('/').filter(Boolean).slice(-2)[0].toUpperCase();
          const core = a.jobSeqNo.replace(/(EXTERNAL|INTERNAL)[A-Z_]*$/i, '');
          const at = core.lastIndexOf(country);
          const ids = uniq([
            at > 0 && at + country.length < core.length ? core.slice(at + country.length) : null,
            (core.match(/GLOBAL([A-Z0-9][\w-]*)$/) || [])[1],
            (core.match(/((?:JR|REQ|R)[-_]?\d{3,}[A-Z]{0,3})$/) || [])[1],
            (core.match(/(\d{3,}[A-Z]{0,3})$/) || [])[1],
          ]).slice(0, 2);
          for (const id of ids) add(`${u.origin}${a.base}/job/${id}`, 'the job page');
        }
        break;
      case 'recruitee':
        if (a.stage === 'application') add(cut(/\/c\/new\/?$/i), 'the Recruitee job page');
        break;
      case 'tal.net':
        if (a.stage === 'application') add(cut(/\/(apply|application|form|register|login)(\/.*)?$/i), 'the job page');
        break;
      case '50skills':
        if (a.stage === 'application') add(cut(/\/apply(\/.*)?$/i), 'the job page');
        break;
      case 'teamtailor':
        if (a.stage === 'application') add(cut(/\/applications?(\/new)?\/?$/i), 'the Teamtailor job page');
        break;
      default:
        break;
    }
    if (!out.length && a.stage === 'application') {
      const STEP =
        /\/(apply|application|applications\/new|apply-now|login|candidate|new_candidate|new-candidate|register|signup|sign-up|easyapply|apply-start)(\/.*)?$/i;
      const stripped = u.pathname.replace(STEP, '');
      const last = stripped.split('/').filter(Boolean).pop() || '';
      if (
        stripped !== u.pathname &&
        stripped.length > 1 &&
        !/^(talent-?community|candidates?|portal|careers?|jobs?|home|account|users?|recruits?|external|[a-z]{2}([-_][a-z]{2})?)$/i.test(
          last,
        )
      )
        add(cut(STEP), 'the page before the application step');
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
      case 'sainoo':
        if (a.jobId) out.push(get(`https://www.sainoo.com/api/v1/jobs/${enc(a.jobId)}`, 'sainoo'));
        break;
      case '50skills':
        if (a.jobId && a.company)
          out.push(
            get(`https://static-jobs-api.50skills.app/public/${enc(a.company)}/jobs/${enc(a.jobId)}.json`, '50skills'),
          );
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

  /** "Halma plc Amersham, United Kingdom" → "Amersham, United Kingdom" when the company is Halma plc (Workday). */
  function placeWithoutCompany(location, company) {
    const name = clean(company);
    if (!location || name.length < 2) return location || '';
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^${esc}(?=[\\s,:–—-])[\\s,:–—-]+`, 'i');
    return String(location)
      .split(' / ')
      .map((part) => {
        const rest = part.replace(re, '').trim();
        return rest && /\p{L}/u.test(rest) ? rest : part;
      })
      .join(' / ');
  }

  function makePosting(fields) {
    const p = {
      url: fields.url || '',
      title: field(fields.title, 200),
      company: field(fields.company, 120),
      location: field(fields.location, 200),
      jobIds: uniq((fields.jobIds || []).map((x) => (x == null ? '' : String(x).trim())).filter((x) => x.length >= 2)),
      description: fields.description || '',
      source: fields.source || '',
      ats: fields.ats || ats(fields.url || '').name || null,
      datePosted: fields.datePosted ? String(fields.datePosted).slice(0, 40) : null,
      employmentType: fields.employmentType ? clean(fields.employmentType, 80) : null,
      confidence: fields.confidence || 0.5,
    };
    if (p.url) for (const id of urlJobIds(p.url)) if (!p.jobIds.includes(id)) p.jobIds.push(id);
    p.location = placeWithoutCompany(p.location, p.company);
    return p;
  }

  // Cookie notices, privacy policies and terms of use: legal small print, not a job.
  const LEGAL_WORDS =
    /\b(cookies?|privacy|personal (data|information)|terms (and|&) conditions|terms of (use|service)|consent|gdpr|data protection|tracking technologies|this (web)?site|browsing|browser|disclaimer|liability|copyright|trademarks?|datenschutz|données personnelles)\b/gi;
  const JOB_WORDS =
    /\b(responsibilit\w*|requirements?|qualifications?|experience|skills|candidates?|internships?|interns?|graduates?|applicants?|position|vacancy|degree|team|role)\b/gi;
  // The parts a job advert has: what you'll do, what you need, what you get, and how and when to apply.
  // prettier-ignore
  const JOB_SECTIONS = [
    /responsibilit|what you('|’)?ll (do|be doing|work on)|what you will (do|work on)|your (role|impact|tasks|mission|day)|the role\b|role overview|about the (role|job|position|programme|program|internship|training contract|scheme)|job (description|summary|purpose)|key (duties|accountabilities)|duties|seats?\b|rotations?\b|ihre aufgaben|deine aufgaben|aufgaben|vos missions|missions?\b|le poste|descriptif du poste/i,
    /requirements?|qualifications?|what (we('|’)?re|we are) looking for|what we look for|who you are|about you|your profile|skills (and|&) experience|experience (and|&) skills|essential|desirable|nice to have|ihr profil|dein profil|profil recherché|votre profil|compétences|you have\b|you('|’)?ll (need|bring)|you will (need|bring)/i,
    /benefits|what we offer|wir bieten|perks|salary|compensation|avantages|nous offrons|why join/i,
    /\b(apply|application|deadline|closing date|start date|duration|full[- ]time|part[- ]time|contract|internship|graduate|candidates?|bewerbung|candidature|stage)\b/i,
  ];

  /** How many kinds of job-advert section a text has (0–4). */
  function jobStructure(text) {
    const s = String(text || '').slice(0, 30000);
    return JOB_SECTIONS.filter((re) => re.test(s)).length;
  }

  /** Mostly cookie, privacy or terms-of-use wording? */
  function isLegalText(text) {
    const s = String(text || '').slice(0, 30000);
    const legal = (s.match(LEGAL_WORDS) || []).length;
    const job = (s.match(JOB_WORDS) || []).length;
    return (
      (legal >= 6 && legal > job) || (legal >= 3 && /^\W*(this (web)?site|we use cookies|by (using|browsing))/i.test(s))
    );
  }

  /** Does this look like a job description rather than a form, a list or legal small print? */
  function isRealDescription(text, strict) {
    const n = words(text);
    if (n < (strict ? 80 : 40)) return false;
    if (isLegalText(text)) return false;
    if (isJobHeading(text)) return true;
    if (strict) return false;
    const hits = (
      String(text).match(
        /\b(experience|skills|team|role|responsib|candidate|degree|work with|you will|we are|our|expérience|compétences|équipe|missions?|profil|stage|vous|nous|erfahrung|kenntnisse|studium|aufgaben|ihre|wir|esperienza|competenze|requisiti|experiencia|requisitos|equipo)\b/giu,
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

  /** How surely a JobPosting block is about this page: its address, its ID, the page's heading (0 = no sign). */
  function postingFit(p, url, heading, docTitle) {
    let s = 0;
    if (p.url && urlKey(p.url) === urlKey(url)) s += 3;
    const ids = urlJobIds(url);
    if (p.jobIds.some((id) => ids.some((x) => idsMatch(id, x)))) s += 2;
    const h = norm(heading);
    if (h && norm(p.title) === h) s += 1;
    else {
      const sim = Math.max(...[heading, docTitle].map((t) => (t ? titleSimilarity(t, p.title, {}) || 0 : 0)));
      if (sim >= 0.8) s += 0.75;
    }
    return s;
  }

  /** Several JobPosting blocks on one page: the one this URL is about; none when nothing says which. */
  function pickPosting(list, url, heading, docTitle) {
    if (list.length <= 1) return list[0] || null;
    let best = null;
    let bestScore = -1;
    for (const p of list) {
      const s = postingFit(p, url, heading, docTitle) + Math.min(words(p.description) / 1000, 0.5);
      if (s > bestScore) {
        best = p;
        bestScore = s;
      }
    }
    // A list of jobs (search results, "similar jobs") without a sign of which one this page is about.
    return bestScore >= 0.75 ? best : null;
  }

  const JOBBY_TITLE =
    /\b(analyst|analyste|analista|engineer|ingénieur|ingenieur|developer|intern|internship|manager|associate|graduate|trader|researcher|scientist|designer|consultant|specialist|officer|assistant|director|apprentice|trainee|programme|program|scheme|placement|praktikum|praktikant|stage|stagiaire|alternant|alternance|werkstudent|becario|tirocinio)\b/i;

  /**
   * One JobPosting block on another job's page (a "featured job", the last job viewed): its ID or address is a
   * different job on this site, or the page's heading names a different job.
   */
  function aboutAnotherJob(p, url, heading, docTitle, pageStart) {
    if (postingFit(p, url, heading, docTitle) >= 0.75) return false;
    const ids = urlJobIds(url);
    const theirs = uniq([...p.jobIds, ...(p.url && urlKey(p.url) !== urlKey(url) ? urlJobIds(p.url) : [])]);
    if (ids.length && theirs.some((y) => ids.some((x) => idShape(x) === idShape(y) && !idsMatch(x, y)))) return true;
    const pu = parseUrl(p.url);
    const here = parseUrl(url);
    if (pu && here && pu.hostname === here.hostname && urlJobIds(pu.href).length && ids.length) return true;
    // The page's heading and title name their own reference ("Réf. 2026-118"), and it isn't this one's.
    const written = textJobIds(`${docTitle || ''}\n${heading || ''}\n${pageStart || ''}`);
    if (written.length && theirs.length && !theirs.some((y) => written.some((x) => idsMatch(x, y)))) return true;
    // The page's own heading is a job title that has nothing in common with this one, or another city's.
    if (heading && JOBBY_TITLE.test(heading) && p.title) {
      const sims = [heading, docTitle]
        .map((t) => (t ? titleSimilarity(t, p.title, {}) : null))
        .filter((x) => x != null);
      const best = sims.length ? Math.max(...sims) : null;
      if (best != null && best < 0.3) return true;
      const mine = cities(heading);
      const there = cities(p.title, p.location);
      if (best != null && best < 0.85 && mine.length && there.length && !mine.some((c) => there.includes(c)))
        return true;
    }
    return false;
  }

  function fromJsonLd(doc, url) {
    const found = [];
    for (const s of qa(doc, 'script[type="application/ld+json"], script[type="application/ld+json; charset=utf-8"]')) {
      const json = parseJsonLoose(s.textContent);
      if (json) collectTyped(json, 'JobPosting', found);
    }
    if (!found.length) return null;
    const postings = found.map((o) => fromJobPostingLd(o, url));
    const heading = shortText(q(doc, 'h1'));
    const docTitle = clean(String(doc.title || '').replace(/<!--[\s\S]*?-->/g, ''), 300);
    const best = pickPosting(postings, url, heading, docTitle);
    const pageStart = visibleText(doc).slice(0, 3000);
    return best && !aboutAnotherJob(best, url, heading, docTitle, pageStart) ? best : null;
  }

  function fromMicrodata(doc, url) {
    const scope = q(doc, '[itemtype*="JobPosting"]');
    if (!scope) return null;
    const prop = (name) => {
      const el = qa(scope, `[itemprop~="${name}"]`)[0];
      if (!el) return '';
      return field(el.getAttribute('content') || el.getAttribute('datetime') || shortText(el, 300) || '', 300);
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
        return e ? field(e.getAttribute('content') || shortText(e, 120)) : '';
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
    { ats: 'icims', title: ['.iCIMS_Header h1', 'h1.iCIMS_Header', '.iCIMS_JobHeaderTag h1', '.iCIMS_Header'], company: [], location: ['.iCIMS_JobHeaderGroup .header.left span:not(.field-label)'], description: ['.iCIMS_InfoField_Job, .iCIMS_InfoMsg_Job', '.iCIMS_JobContent'], each: true },
    { ats: 'oracle', title: ['.job-details__title', 'h1.heading', '.app-header__current-page-title-container > :first-child'], company: [], location: ['.job-details__subtitle', '.job-meta__subitem', '.posting-locations .text-color-primary li', '.posting-locations .text-color-primary'], description: ['.job-details__description-content'], all: true },
    { ats: 'successfactors', title: ['[data-careersite-propertyid="title"]', '#job-title', '.jobTitle'], company: [], location: ['[data-careersite-propertyid="city"]', '[data-careersite-propertyid="location"]', '.jobGeoLocation'], description: ['[data-careersite-propertyid="description"]', '.jobdescription', '.job-description', '#job-description'] },
    { ats: 'taleo', title: ['.subtitle', '[id*="reqTitleLinkAction"]'], company: [], location: ['[id*="reqBasicLocation"]'], description: ['.editablesection', '#requisitionDescriptionInterface'] },
    { ats: 'eightfold', title: ['.position-title', 'h1[class*="position-title"]'], company: [], location: ['.position-location'], description: ['.position-job-description', '[class*="job-description"]'] },
    { ats: 'phenom', title: ['h1.job-title', '.job-title'], company: [], location: ['.job-location', '.au-target.job-location'], description: ['[data-ph-at-id="job-description-text"]', '.job-description', '.jd-info'] },
    { ats: 'avature', title: ['.banner__text__title', 'h1.title', 'h2.title', '.section__header__text h2.title', '.article--details h1, .article--details h2'], company: [], location: [], description: ['.article--details .article__content', '.job-description', '.article__content'], each: true },
    { ats: 'tal.net', title: ['#vac_desc h1', 'h1.section'], company: [], location: [], description: ['#vac_desc .form-view', '#vac_desc'] },
    { ats: 'jobvite', title: ['.jv-header'], company: [], location: ['.jv-job-detail-meta'], description: ['.jv-job-detail-description'] },
    { ats: 'breezy', title: ['.banner h1', '.position-header h1'], company: [], location: ['.location'], description: ['.description'] },
    { ats: null, title: ['[itemprop="title"]', '.job-title', '.jobTitle', '.posting-title'], company: [], location: ['.job-location', '.location'], description: ['.job-description', '.jobDescription', '#job-description', '#jobDescription', '.job-details', '.job-detail', '.job-content', '.posting-description', '.vacancy-description', '[class*="JobDescription"]'] },
  ];

  /** The rule's title that the browser tab's title also names (banners often use the same classes), else the first. */
  function pickTitle(doc, selectors) {
    const all = [];
    for (const s of selectors || []) for (const el of qa(doc, s)) all.push(shortText(el, 200));
    const list = all.filter((t) => t && notGeneric(t));
    const dt = norm(String(doc.title || '').replace(/<!--[\s\S]*?-->/g, ''));
    return list.find((t) => norm(t).length > 3 && dt.includes(norm(t))) || list[0] || '';
  }

  function firstText(doc, selectors, max = 200, ok) {
    for (const s of selectors || []) {
      for (const el of qa(doc, s)) {
        const t = s.endsWith('[alt]') ? field(el.getAttribute('alt'), max) : shortText(el, max);
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
          // each: a description split over several blocks of the same kind (Avature's collapsible sections).
          const el = rule.each ? null : q(doc, s);
          const t = rule.each ? joinParts(qa(doc, s).map((e) => ({ html: e.innerHTML }))) : el ? elText(el) : '';
          if (words(t) >= 40) {
            description = t;
            break;
          }
        }
      }
      if (words(description) < 40) continue;
      return makePosting({
        url,
        title: pickTitle(doc, rule.title),
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

  /* ---------------------------------------------- SuccessFactors classic */

  /** A SuccessFactors classic job page: "/career?career_ns=job_listing&company=MoodysProd&career_job_req_id=14588". */
  function sfJobPage(url, company, id) {
    const u = parseUrl(url);
    if (!u || !SF_HOST.test(u.hostname) || !company || !/^\d+$/.test(String(id || ''))) return '';
    const path = /^\/(career|careers|portalcareer)$/i.test(u.pathname) ? u.pathname : '/career';
    return `${u.origin}${path}?career_ns=job_listing&company=${encodeURIComponent(company)}&career_job_req_id=${id}`;
  }

  /** A JavaScript string literal's text: "Moody\'s", "Moody\x27s" → "Moody's". */
  function jsText(s) {
    return String(s)
      .replace(/\\x([\da-f]{2})|\\u([\da-f]{4})/gi, (m, x, u4) => String.fromCharCode(parseInt(x || u4, 16)))
      .replace(/\\(.)/g, '$1');
  }

  /** The words two texts end with: "Let's begin! Analyst" and "Career Opportunities: Analyst" → "Analyst". */
  function sharedTail(a, b) {
    const x = a.split(/\s+/);
    const y = b.split(/\s+/);
    let n = 0;
    while (n < x.length && n < y.length && x[x.length - 1 - n] === y[y.length - 1 - n]) n++;
    return x.slice(x.length - n).join(' ');
  }

  /**
   * What a SuccessFactors classic page says about its job: { jobId, company, title, named, form, location,
   * datePosted }. Every step is one form, #careerform, whose hidden fields name the requisition and the tenant
   * (career_job_req_id 14588, career_company MoodysProd), also where the address is only a session token (signing
   * in and applying after Apply). A job's page heads it "{label} {title} ({req})" — the site picks the label:
   * "Career Opportunities:", Moody's "Let's begin!" — and its print button repeats the title, and the location in
   * brackets:
   * openPrintDialogWithReqSubTitle(key, '14588', true, true, '…%28Edinburgh%20%2d%207%20Exchange%20Crescent%29',
   * '', 'Software Engineering Summer Intern', true).
   */
  function sfClassic(doc) {
    const hidden = (name) =>
      qa(doc, `input[type="hidden"][name="${name}"]`)
        .map((el) => clean(el.getAttribute('value'), 120))
        .find(Boolean) || '';
    const print = q(doc, 'a[onclick*="openPrintDialogWithReqSubTitle"]');
    const args = print
      ? Array.from((print.getAttribute('onclick') || '').matchAll(/'((?:\\.|[^'\\])*)'/g), (m) => jsText(m[1]))
      : [];
    const withReq = (t) => field(t, 300).match(/^(.*?\S)\s*\((\d{2,})\)$/);
    const head = withReq(shortText(q(doc, '.pagetitle h1') || q(doc, 'h1'), 300));
    const tab = withReq(String(doc.title || '').replace(/<!--[\s\S]*?-->/g, ''));
    const jobId =
      [hidden('career_job_req_id'), args[1], head && head[2], tab && tab[2]].find((x) => /^\d{2,}$/.test(x || '')) ||
      '';
    // Only a heading that ends with this job's requisition names it (not "Let's begin! Sign in to apply at Moody's").
    const h = head && (!jobId || head[2] === jobId) ? head[1] : '';
    const t = tab && (!jobId || tab[2] === jobId) ? tab[1] : '';
    const ours = args.length >= 5 && args[1] === jobId;
    const printed = ours ? field(args[args.length - 1], 200) : '';
    // (The tab's title alone is left to titleParts: "{title} - Hang Seng Bank (HK) ({req})" names the company too.)
    const title = printed || (h && t && h !== t && sharedTail(h, t)) || h.replace(/^career opportunities\s*:\s*/i, '');
    const place = (ours ? safeDecode(args[2]) : '')
      .split(/&nbsp;-&nbsp;/)
      .map((p) => p.trim().match(/^\((.+)\)$/))
      .find(Boolean);
    const posted = Number(attr(doc, '#postedOnFastDate', 'value'));
    return {
      jobId,
      company: hidden('career_company') || hidden('company'),
      title,
      named: !!(printed || h || t),
      form: !!q(doc, 'form#careerform'),
      location: place ? field(place[1], 150) : '',
      datePosted: posted > 0 && posted < 1e14 ? new Date(posted).toISOString().slice(0, 10) : null,
    };
  }

  /** A SuccessFactors classic job page's posting: the description sits in its form, in .joqReqDescription. */
  function fromSfClassic(doc, url) {
    const el = q(doc, '.joqReqDescription') || q(doc, '.externalPosting');
    const description = el ? elText(el) : '';
    if (words(description) < 40) return null;
    const sf = sfClassic(doc);
    const tenant = ats(url).company || sf.company;
    return makePosting({
      url,
      title: sf.title,
      company: tenant ? companyInText(tenant, [doc.title, description.slice(0, 3000)]) : '',
      location: sf.location,
      jobIds: [sf.jobId],
      description,
      source: 'page',
      ats: 'successfactors',
      datePosted: sf.datePosted,
      confidence: 0.85,
    });
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
    /(^|[\s_-])(cookies?|consent|gdpr|onetrust|ot-sdk|banner|modal|popup|newsletter|subscribe|social|share|sharing|breadcrumbs?|similar|related|recommended|recommendations|more-jobs|other-jobs|job-?alerts?|footer|sidebar|navbar|nav|menu|skip-link|search|filters?|pagination|language-?(selector|switcher|picker)|country-?(selector|picker)|locale-?(selector|switcher))($|[\s_-])/i;
  const GOOD_NAME = /desc|content|detail|posting|job|article|main|body|vacanc|position/i;
  // Cookie and consent banners (OneTrust, Cookiebot, Usercentrics…), privacy and legal pop-ups, by class, id or label.
  const CONSENT_NAME =
    /cookie|consent|onetrust|ot-sdk|optanon|cookiebot|cybot|usercentrics|didomi|truste|gdpr|privacy|disclaimer|legal-?pop|legal-?notice|legal-?modal|terms-?of-?use|terms-?and-?conditions|popup/i;
  const JOBBY_NAME = /(^|[\s_-])(job|posting|vacanc|position)[\w-]*(desc|detail|content|body|text)/i;

  const nameOf = (el) =>
    `${el.getAttribute('class') || ''} ${el.getAttribute('id') || ''} ${el.getAttribute('aria-label') || ''}`;

  /** A cookie banner or a privacy/legal pop-up — not a page wrapper that only carries a "cookies-accepted" class. */
  function consentLike(el) {
    const name = nameOf(el);
    if (!CONSENT_NAME.test(name) || JOBBY_NAME.test(name)) return false;
    return !qa(el, 'h1, h2, h3, h4, h5, h6, strong, b, dt').some((h) => {
      const t = clean(h.textContent, 100);
      return t.length < 80 && isJobHeading(t);
    });
  }

  /** Is this element a banner, menu, pop-up or other page furniture (by its class, id or label)? */
  function junkName(el) {
    const name = nameOf(el);
    return (JUNK_NAME.test(name) && !JOBBY_NAME.test(name)) || consentLike(el);
  }

  /** Inside a dialog, a cookie banner or another pop-up? */
  function inJunk(el) {
    for (let e = el, i = 0; e && e.nodeType === 1 && i < 15; e = e.parentNode, i++) {
      if (/^(DIALOG|NAV|FOOTER)$/i.test(e.tagName) || /^(dialog|alertdialog)$/i.test(e.getAttribute('role') || ''))
        return true;
      if (e.getAttribute('aria-modal') === 'true' || consentLike(e)) return true;
    }
    return false;
  }

  function genericPosting(doc, url) {
    const body = doc.body;
    if (!body) return null;
    const clone = body.cloneNode(true);
    // An accordion's toggle buttons are its section headings ("Vos missions", "Profil recherché").
    for (const b of qa(clone, 'button[aria-controls], button[aria-expanded], [class*="accordion"] > button')) {
      const t = clean(b.textContent, 80);
      if (!t || !b.ownerDocument) continue;
      const h = b.ownerDocument.createElement('h3');
      h.textContent = t;
      b.replaceWith(h);
    }
    // (A read-only "form" with no fields is how some boards lay out the advert itself, e.g. Oleeo's form-view, and
    // collapsed sections — accordions, "Read more" — are hidden until clicked but are the advert's own text.)
    for (const el of qa(clone, JUNK_SELECTOR)) {
      if (el.tagName === 'FORM' && !q(el, 'input:not([type="hidden"]), select, textarea, button')) continue;
      if (
        el.hasAttribute('hidden') &&
        /^(DIV|SECTION|P|UL|OL|SPAN|DD|ARTICLE)$/i.test(el.tagName) &&
        !el.getAttribute('role') &&
        !junkName(el) &&
        words(el.textContent) >= 12
      )
        continue;
      el.remove();
    }
    for (const el of qa(clone, '[class],[id],[aria-label]')) if (junkName(el)) el.remove();
    const scores = new Map();
    const bump = (el, v) => {
      if (el && el.nodeType === 1) scores.set(el, (scores.get(el) || 0) + v);
    };
    for (const el of qa(clone, '*')) {
      let own = '';
      for (const n of el.childNodes) if (n.nodeType === 3) own += n.textContent;
      own = own.trim();
      const isHeading = /^(H[1-6]|STRONG|B|DT)$/i.test(el.tagName);
      if (isHeading && own.length < 80 && isJobHeading(own)) {
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
    // A list or paragraph from one section: climb to the block that holds the most job-section headings.
    const headingCount = (el) =>
      qa(el, 'h1, h2, h3, h4, h5, h6, strong, b, dt').filter((h) => {
        const t = clean(h.textContent, 100);
        return t.length < 80 && (isJobHeading(t) || SECTION_HEADING.test(t));
      }).length;
    const linkShare = (el) => {
      const len = (el.textContent || '').length || 1;
      let links = 0;
      for (const a of qa(el, 'a')) links += (a.textContent || '').length;
      return links / len;
    };
    let top = best;
    let topCount = headingCount(best);
    for (let el = best.parentNode, i = 0; el && el !== clone && el.nodeType === 1 && i < 6; el = el.parentNode, i++) {
      if (words(el.textContent) > 4000 || linkShare(el) > 0.3) break;
      const n = headingCount(el);
      if (n > topCount) {
        top = el;
        topCount = n;
      }
    }
    best = top;
    // A list of jobs (every line a link) is not one job.
    if (linkShare(best) > 0.4) return null;
    const description = elText(best);
    if (!isRealDescription(description) || /^\s*[[{]/.test(description)) return null;
    return makePosting({
      url,
      description,
      source: 'page-text',
      confidence: isJobHeading(description) ? 0.65 : 0.5,
    });
  }

  /* --------------------------------------------------------- page headings */

  const GENERIC_TITLE =
    /^(apply|application|apply now|apply for this (job|position|role)|job application|start your application|my information|personal (information|details)|sign in|log in|login|create (an )?account|careers?|jobs?|job search|search jobs|welcome|home|current vacancies|open positions|join us|thank you|are you still with us\??|work summary|job application form|candidate (home|experience)|review|submit|resume|cv|error\s*\d*\b|\d{3}\b|internal server error|access denied|forbidden|too many requests|just a moment|attention required|page not found|listings|search results|current openings|(\w+ )?candidate portal|(join )?(our )?talent (community|network|pool)|sign up|your personal space|who we are|my (profile|account|applications?)|dashboard|create (a |your )?profile|register|your privacy|privacy (policy|notice|statement|settings|preferences|cent(er|re))|cookies?( (policy|settings|preferences|notice|consent|declaration))?|manage (cookies|consent|preferences)|we (use|value) (cookies|your privacy)|terms (of use|and conditions)|legal (notice|information)|disclaimer|imprint|impressum|datenschutz\w*|mentions légales|politique de confidentialité|view this (site|page) in|(choose|select|change) (your )?(language|country|region|location)|.{0,60}\bequal (employment )?opportunit(y|ies)\b.*|.{0,40}\bis an? (equal|e-verify)\b.*)\b/i;
  const notGeneric = (t) => !GENERIC_TITLE.test(t);
  const SITE_PIECE =
    /^(workday|careers?|jobs?|job board|lever|greenhouse|ashby|smartrecruiters|workable|icims|taleo|avature|eightfold|oracle|apply|application|home|job details?|job description|careers? (site|page|portal)|candidate experience( page)?)$/i;

  function cleanCompany(s) {
    if (
      /^\s*(false|true|null|undefined|none|n\/a|company( name| logo)?|your company|logo|brand|site name|home|careers?|jobs?|log ?in|sign ?in|apply|greenhouse|lever|workday|ashby|smartrecruiters|workable|icims|taleo|successfactors|oracle|avature|eightfold|phenom|jobvite|recruitee|personio|teamtailor|bamboohr|pinpoint|breezy|allhires|candidats|ambertrack|vacancy filler|apply4law|oleeo|cezanne|eploy|tribepad|hireful|jobtrain|networx|webitrent|hibob|zoho recruit|50skills)\s*$/i.test(
        String(s || ''),
      )
    )
      return '';
    return clean(
      field(s, 300)
        .replace(
          /\b(candidate experience page|candidate experience|careers? (site|page|portal)|careers?|jobs?|job board|recruiting|recruitment|talent community)\b/gi,
          ' ',
        )
        .replace(/\s+[|–—-]\s*$/, '')
        .replace(/^\s*[|–—-]\s+/, '')
        .replace(/\s*\blogo\b\s*/gi, ' ')
        // An image's file name used as its alt text: "Marsh_48px", "acme-logo.svg".
        .replace(/[_-]?\d+px\b|\.(png|svg|jpe?g|gif|webp)\b/gi, '')
        // A requisition number the tab's title puts last: "Hang Seng Bank (HK) (55392)".
        .replace(/\s*\(\s*[A-Z]{0,4}[-_]?\d{3,}[\w-]*\s*\)\s*$/i, '')
        .replace(/_/g, ' '),
      120,
    ).replace(/[\s|–—:,-]+$/, '');
  }

  /** "jumptrading" → "Jump Trading" when the page writes it that way, else "Jumptrading". */
  function prettyCompany(slug, texts) {
    if (!slug) return '';
    return companyInText(slug, texts) || slugTitle(slug);
  }

  // A tenant ID's environment suffix: SuccessFactors' "MoodysProd" and "exxonmobilP" are Moody's and ExxonMobil.
  const bareTenant = (slug) => String(slug).replace(/([a-z]{2})(?:Prod|PROD|Production|P)$/, '$1');

  /** The page's own spelling of a company slug ("sargentlundy" → "Sargent & Lundy"), or ''. */
  function companyInText(slug, texts) {
    const bare = bareTenant(slug);
    const target = compact(bare.replace(/(careers?|jobs?|hr|recruiting|inc|llc|ltd)$/i, '')) || compact(bare);
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
    return '';
  }

  function slugTitle(slug) {
    const s = bareTenant(slug)
      .replace(/[-_+.]+/g, ' ')
      .trim();
    return s.length <= 4 && !/\s/.test(s) ? s.toUpperCase() : s.replace(/(^|\s)\p{Ll}/gu, (c) => c.toUpperCase());
  }

  /** Title and company from document.title patterns, cross-checked with the page's headings. */
  function titleParts(docTitle, headings) {
    const t = field(String(docTitle || '').replace(/<!--[\s\S]*?-->/g, ''), 300)
      .replace(
        /^(job application for|application for|apply for|apply to|applying for|apply|application|career opportunities|job opportunity|job details|job|vacancy|stellenangebot|stellenanzeige|offre d['’]emploi|offre)\s*[:\-–—]?\s+/i,
        '',
      )
      .trim();
    let m = t.match(/^(.+?)\s+(?:at|@)\s+(.+)$/i);
    if (m && !/[|–—]/.test(m[2]) && !/\s[|–—]\s/.test(m[1])) return { title: m[1].trim(), company: cleanCompany(m[2]) };
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
    // The page's heading says more than the tab's piece of it ("Stage Analyste M&A – Paris (H/F)"): use it.
    const fuller =
      ti >= 0
        ? headings.find(
            (h) =>
              norm(h).includes(norm(pieces[ti])) &&
              norm(h) !== norm(pieces[ti]) &&
              h.length <= 2 * pieces[ti].length + 30,
          )
        : null;
    const others = pieces.filter((_, i) => i !== titleIdx);
    const companyPiece = others.find((p) => /careers?|jobs/i.test(p)) || others[others.length - 1] || '';
    const company = cleanCompany(companyPiece.replace(/^(careers?|jobs?|work|life)\s+(at|with)\b\s*/i, ''));
    // "2027 | EMEA | London | Sales & Trading | Apprentice Programme | Goldman Sachs": the title has pipes in it.
    if (ti < 0 && pieces.length >= 3 && words(pieces[titleIdx].replace(/\d+/g, '')) < 1)
      return { title: pieces.filter((p) => p !== companyPiece).join(' | '), company };
    m = pieces[titleIdx].match(/^(.+?)\s+(?:at|@)\s+(.+)$/i);
    if (m) return { title: m[1].trim(), company: company || cleanCompany(m[2]) };
    return { title: fuller || pieces[titleIdx], company };
  }

  function headingTexts(doc) {
    return qa(doc, 'h1, h2')
      .slice(0, 30)
      .filter((h) => !inJunk(h))
      .slice(0, 8)
      .map((h) => shortText(h, 200))
      .filter((t) => t && !GENERIC_TITLE.test(t))
      .filter((t) => !(words(t) < 6 && (isJobHeading(t) || SECTION_HEADING.test(t)))); // "What we look for"
  }

  function metaContent(doc, names) {
    for (const n of names) {
      const v = attr(doc, `meta[property="${n}"]`, 'content') || attr(doc, `meta[name="${n}"]`, 'content');
      if (v) return v;
    }
    return '';
  }

  /** A location from labelled fields: "City Phoenix · State AZ · Country United States", "Location: London". */
  function fieldLocation(doc) {
    const found = {};
    for (const label of qa(doc, 'dt, th, .iCIMS_JobHeaderField, [class*="field-label"], [class*="label"]').slice(
      0,
      200,
    )) {
      const key = norm(label.textContent);
      if (!/^((job |work )?locations?|city|town|state|region|province|country)$/.test(key) || found[key]) continue;
      // Not a form's "Country" question: only read-only text next to its label.
      const next = label.nextElementSibling;
      if (label.tagName === 'LABEL' || (label.closest && label.closest('form, fieldset'))) continue;
      if (!next || next.matches('input, select, textarea, button') || q(next, 'input, select, textarea')) continue;
      const value = clean(next.textContent, 120);
      if (value && value.length < 120) found[key.replace(/^(job|work) /, '').replace(/s$/, '')] = value;
    }
    if (found.location) return found.location;
    return uniq([found.city || found.town, found.state || found.region || found.province, found.country]).join(', ');
  }

  /** "Location: London", "Standort: Frankfurt am Main", "Lieu : Paris" written in a posting's text. */
  function textLocation(text) {
    const m = String(text || '')
      .slice(0, 4000)
      .match(
        /^(?:•\s*)?(?:job |work |office )?(?:locations?|standort|arbeitsort|einsatzort|dienstort|lieu(?: de travail)?|localisation|sede(?: di lavoro)?|ubicación|city)\s*:\s*([^\n]{2,80})$/im,
      );
    return m ? clean(m[1], 120) : '';
  }

  /* ------------------------------------------------------- fromDocument */

  // "The requested job could not be found", "This position is no longer available", "This job cannot be viewed at
  // the moment. It has either been deleted or is no longer available for application" (SuccessFactors)…
  const GONE =
    /\b(job|position|posting|vacancy|role|opportunity|page|requisition|advert)\b.{0,60}\b(could ?n[o']t be found|can ?n[o']t be found|not (be )?found|no longer (available|accepting|exists|active|open|online)|has (now )?(either )?(been )?(closed|expired|filled|removed|deleted)|is (closed|expired|not currently active|not available)|does not exist)|^\s*(404|page not found|job not found|not found)\b/i;

  /**
   * Does the page say the job is closed? The tab title always counts; headings and alerts only when they are
   * shown (in a live page) — career sites ship a hidden "this job has been filled" template with every job.
   */
  function saysGone(doc, structured) {
    if (GONE.test(clean(String(doc.title || '').replace(/<!--[\s\S]*?-->/g, ''), 300))) return true;
    if (structured) return false;
    const live = !!doc.defaultView && !!doc.body && typeof doc.body.getClientRects === 'function';
    return qa(doc, 'h1, h2, h3, [role="alert"], .error, .alert, #jobAppPageTitle')
      .filter((h) => !h.closest || !h.closest('[hidden], [aria-hidden="true"], template'))
      .filter((h) => !live || h.getClientRects().length > 0)
      .slice(0, 6)
      .some((h) => GONE.test(clean(h.textContent, 200)));
  }

  /** The job posting on this page (best structured source first), or null. */
  function fromDocument(doc, url) {
    if (!doc) return null;
    const pageUrl = url || (doc.location && doc.location.href) || '';
    const a = ats(pageUrl);
    let posting = null;
    for (const step of [
      fromJsonLd,
      fromMicrodata,
      (d, u) => (a.name === 'successfactors' ? fromSfClassic(d, u) : null),
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
    if (!posting || saysGone(doc, /json-ld|microdata/.test(posting.source))) return null;
    // A search page's text is a list of jobs, not one; a home page's text is not a job either.
    if (posting.source === 'page-text' && (parseUrl(pageUrl) || { pathname: '/' }).pathname.replace(/\/+$/, '') === '')
      return null;
    if (
      posting.source === 'page-text' &&
      (LIST_PAGE.test(pageUrl.replace(/^\w+:\/\/[^/]+/, '')) || (a.stage === 'unknown' && a.name))
    )
      return null;
    // Fill what the chosen source left out from the page itself.
    const heads = headingTexts(doc);
    const parts = titleParts(doc.title || '', heads);
    if (!posting.title) posting.title = heads[0] || parts.title || metaContent(doc, ['og:title']);
    // Page text whose headings are boilerplate ("WWT is an Equal Opportunity Employer"): its first line that reads
    // like a job title ("Technology & Analytics Intern- 2027").
    if (posting.source === 'page-text' && (!posting.title || !JOBBY_TITLE.test(posting.title))) {
      const line = posting.description
        .split('\n')
        .slice(0, 8)
        .map((l) => clean(l.replace(/^•\s*/, ''), 200))
        .find((l) => l && words(l) <= 12 && JOBBY_TITLE.test(l) && !isJobHeading(l) && !/[.:]$/.test(l));
      if (line) posting.title = line;
    }
    if (!posting.company) {
      const og = cleanCompany(metaContent(doc, ['og:site_name', 'application-name']));
      const texts = [doc.title, og, heads.join(' '), posting.description.slice(0, 3000)];
      posting.company =
        (a.company && companyInText(a.company, texts)) ||
        parts.company ||
        og ||
        (a.company ? slugTitle(a.company) : '') ||
        '';
    }
    if (!posting.location) {
      for (const rule of DOM_RULES)
        if (!rule.ats || rule.ats === a.name) posting.location = posting.location || firstText(doc, rule.location, 150);
      posting.location = posting.location || fieldLocation(doc) || textLocation(posting.description);
    }
    if (!posting.ats) posting.ats = a.name;
    if (posting.url && urlKey(posting.url) !== urlKey(pageUrl) && posting.source !== 'json-ld') posting.url = pageUrl;
    if (!posting.url) posting.url = pageUrl;
    if (a.jobId && !posting.jobIds.includes(a.jobId)) posting.jobIds.push(a.jobId);
    plainFields(posting);
    posting.location = placeWithoutCompany(posting.location, posting.company);
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
      case 'sainoo': {
        const d = json.data;
        if (d && d.position_title && d.brief) {
          const office = d.office || {};
          p = {
            url: `https://www.sainoo.com/jobs/${d.id}`,
            title: d.position_title,
            company: (d.company && d.company.name) || '',
            location: [office.city, office.country].filter(Boolean).join(', '),
            jobIds: [d.id],
            description: htmlToText(d.brief),
            employmentType: (d.experiences || []).join(', ') || d.employment_type,
            datePosted: d.published_at || null,
          };
        }
        break;
      }
      case '50skills': {
        const langs = Array.isArray(json.languages) ? json.languages : [];
        const l = langs.find((x) => /^en/i.test(x.language || '')) || langs[0];
        if (l && l.title)
          p = {
            url: json.url || url,
            title: l.title,
            company: json.companyFullName || '',
            location: l.location || '',
            jobIds: [json.id],
            description: htmlToText(l.description || l.shortDescriptionHtml || l.shortDescription || ''),
            employmentType: json.status,
            datePosted: json.published || null,
          };
        break;
      }
      default:
        break;
    }
    // Unknown data only: a known board's answer without this job must not yield another job from it.
    if (
      !p &&
      !(
        kind &&
        ['ashby', 'greenhouse', 'lever', 'workday', 'smartrecruiters', 'oracle', '50skills', 'sainoo'].includes(kind)
      )
    ) {
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
    let guessed = false;
    if (!p.company && a.company) {
      p.company = companyInText(a.company, [p.description.slice(0, 3000)]);
      if (!p.company) {
        p.company = slugTitle(a.company);
        guessed = true;
      }
    }
    const made = makePosting({
      ...p,
      jobIds: (p.jobIds || []).filter((x) => x != null && x !== ''),
      source: 'api',
      ats: a.name || kind,
      confidence: 0.95,
    });
    // Only the address named the company ("hdpc.fa.us2.oraclecloud.com" → "HDPC"): a better name may replace it.
    if (guessed) made.companyGuessed = true;
    return made;
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
    let a = ats(pageUrl);
    // SuccessFactors' classic steps name the job in the form, not always in the address ("/portalcareer?_s.crb=…").
    const sf = doc && a.name === 'successfactors' ? sfClassic(doc) : null;
    if (sf) a = { ...a, company: a.company || sf.company || null, jobId: a.jobId || sf.jobId || null };
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
      gone: false,
      embeds: [],
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
    // Closed jobs: boards redirect to an error page ("?error=true", "notFound=1") or say so.
    context.gone =
      saysGone(doc, !!(posting && /json-ld|microdata/.test(posting.source))) ||
      /[?&](notfound|error)=(1|true)\b/i.test(pageUrl);

    // A video player, captcha or tracking frame inside the application page says nothing about the job.
    let framed;
    try {
      const w = doc.defaultView;
      framed = !!w && !!w.top && w.top !== w;
    } catch (err) {
      framed = true; // (a cross-origin parent)
    }
    const widget =
      (framed && !a.name && !context.posting && !urlJobIds(pageUrl).length) ||
      /(^|\.)(vimeo\.com|youtube(-nocookie)?\.com|recaptcha\.net|hcaptcha\.com|challenges\.cloudflare\.com|facebook\.com|doubleclick\.net|googletagmanager\.com|demdex\.net|linkedin\.com|twitter\.com|x\.com|instagram\.com|vidyard\.com|wistia\.(com|net)|brightcove\.net)$/i.test(
        context.host,
      );
    if (widget) {
      context.posting = null;
      return context;
    }
    const heads = headingTexts(doc);
    const parts = titleParts(doc.title || '', heads);
    let atsTitle = (sf && sf.title) || '';
    let atsCompany = '';
    let atsLocation = (sf && sf.location) || '';
    for (const rule of DOM_RULES) {
      if (rule.ats && rule.ats !== a.name) continue;
      atsTitle = atsTitle || pickTitle(doc, rule.title);
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
    // "Susquehanna International Group, LLP Careers" names the site, not a job.
    const siteTitle = (t) => /\b(careers?|jobs|karriere|carrières?|emplois)\b/i.test(t) && !JOBBY_TITLE.test(t);
    const titleOk = (t) => t && !GENERIC_TITLE.test(t) && !siteTitle(t) && words(t) <= 20;
    // An identity provider's sign-in page ("IBMid", "Amazon Passport") says nothing about the job, nor does a site's
    // home, search or sign-in page that a sign-in wall lands on ("SEARCH FOR JOBS…", "Our Strategy").
    const landing =
      !!u &&
      !a.jobId &&
      !urlJobIds(pageUrl).length &&
      (u.pathname.replace(/\/+$/, '') === '' || LIST_PAGE.test(u.pathname + u.search) || LOGIN_PAGE.test(u.pathname));
    const idp = /^(login|signin|sso|auth|passport|accounts?|id|identity)\./i.test(context.host);
    // A SuccessFactors step's heading is the step's ("Let's begin! Sign in to apply at Moody's"), not the job's,
    // unless it ends with the requisition ("… Summer Intern (14588)").
    const unnamed = !!sf && (!!sf.jobId || sf.form) && !sf.named;
    const req = sf && sf.jobId ? new RegExp(`\\s*\\(${sf.jobId}\\)$`) : null;
    context.title =
      (landing
        ? []
        : [
            atsTitle,
            posting && posting.source !== 'page-text' ? posting.title : '',
            ...(idp || unnamed ? [] : [parts.title, heads[0], ogTitle]),
          ]
      )
        .map((t) => (req ? field(t, 200).replace(req, '') : field(t, 200)))
        .find(titleOk) || '';
    // A company slug reads better in the page's own spelling: "jumptrading" → "Jump Trading".
    const named = [posting && posting.source !== 'page-text' && posting.company, atsCompany, parts.company, og, logoAlt]
      .map(cleanCompany)
      .filter((c) => c && norm(c) !== norm(context.title) && !GENERIC_TITLE.test(c));
    const texts = [doc.title, og, logoAlt, ogTitle, heads.join(' '), context.pageText.slice(0, 4000)];
    const spelled = a.company ? companyInText(a.company, texts) : '';
    const slugKey = a.company ? compact(a.company) : '';
    context.company =
      named.find((c) => slugKey && (compact(c).includes(slugKey) || slugKey.includes(compact(c)))) ||
      spelled ||
      named[0] ||
      (a.company ? slugTitle(a.company) : '') ||
      '';
    context.location = placeWithoutCompany(
      field(
        (posting && posting.location) || atsLocation || fieldLocation(doc) || textLocation(context.pageText) || '',
        200,
      ),
      context.company,
    );
    plainFields(context);
    // A portal that shows only the firm's name ("Trowers & Hamlins", "Freshfields") names no job.
    const firstLabel = context.host.replace(/^www\./, '').split('.')[0];
    if (
      context.title &&
      !JOBBY_TITLE.test(context.title) &&
      [context.company, firstLabel, siteLabel(pageUrl)].some((n) => n && companyMatch(context.title, n) === true)
    )
      context.title = '';

    context.jobIds = uniq([
      a.jobId,
      ...urlJobIds(pageUrl),
      ...(context.canonical ? urlJobIds(context.canonical) : []),
      ...textJobIds(`${doc.title || ''}\n${context.pageText.slice(0, 6000)}`),
      ...(posting ? posting.jobIds : []),
    ]).slice(0, 12);
    context.links = pageLinks(doc, pageUrl, context);
    context.embeds = embeddedBoards(doc, pageUrl);
    return context;
  }

  /**
   * Job boards embedded in a company page: Greenhouse's job_app iframe or board script ("for=veritiongroupllc"),
   * Ashby's or Lever's embeds. Their board name is often not the site's ("verition.com" ↔ "veritiongroupllc").
   */
  function embeddedBoards(doc, url) {
    const here = parseUrl(url);
    const out = [];
    for (const el of qa(doc, 'iframe[src], script[src], embed[src]').slice(0, 400)) {
      const u = parseUrl(el.getAttribute('src') || '', url);
      if (!u || !/^https?:$/.test(u.protocol) || (here && u.hostname === here.hostname)) continue;
      const a = ats(u.href);
      if (!a.name || !a.company || !['greenhouse', 'ashby', 'lever'].includes(a.name)) continue;
      // Only what identifies the board and the job (Greenhouse adds a long validity token).
      const v = new URL(u.origin + u.pathname);
      for (const k of ['for', 'token', 'gh_jid'])
        if (u.searchParams.get(k)) v.searchParams.set(k, u.searchParams.get(k));
      out.push(v.href);
    }
    return uniq(out).slice(0, 4);
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
  function candidates(context, now) {
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
    // A SuccessFactors step whose address is a session token ("/portalcareer?_s.crb=…"): the job's page, from the
    // requisition and the tenant that its form names.
    const sfPage =
      ctxAts.name === 'successfactors' && !ats(ctx.url || '').jobId
        ? sfJobPage(ctx.url, ctxAts.company, ctxAts.jobId)
        : '';
    if (sfPage) add(sfPage, 'the SuccessFactors job page', 0.9, { structural: true });
    // A sign-in page that names where it will go next (?next=, ?returnUrl=, ?redirect_uri=…): the job's page.
    for (const page of uniq([ctx.url, ctx.canonical])) {
      const u = parseUrl(page);
      if (!u) continue;
      for (const [k, v] of u.searchParams) {
        if (
          !/^(next|return(_?url|_?to)?|redirect(_?ur[il]|_?to)?|target(url)?|goto|dest(ination)?|continue|relaystate|ru|back(_?url)?|forward(url)?)$/i.test(
            k,
          )
        )
          continue;
        const to = parseUrl(safeDecode(v).replace(/&amp;/g, '&'), u.href);
        if (
          to &&
          /^https?:$/.test(to.protocol) &&
          urlKey(to.href) !== urlKey(page) &&
          (looksLikeJobPage(to.href) || urlJobIds(to.href).length)
        )
          add(to.href, 'the job this sign-in page will return to', 0.85, { structural: true });
      }
    }
    // A board embedded in the page, with this page's job ID (gh_jid=, ashby_jid=) or the embed's own.
    for (const e of ctx.embeds || []) {
      const ea = ats(e);
      const id = ea.jobId || (ctxAts.name === ea.name ? ctxAts.jobId : null);
      if (!ea.company || !id) continue;
      const co = encodeURIComponent(ea.company);
      const job =
        ea.name === 'greenhouse'
          ? `https://job-boards.greenhouse.io/${co}/jobs/${encodeURIComponent(id)}`
          : ea.name === 'ashby' && UUID_RE.test(id)
            ? `https://jobs.ashbyhq.com/${co}/${id.toLowerCase()}`
            : ea.name === 'lever' && UUID_RE.test(id)
              ? `https://jobs.lever.co/${co}/${id.toLowerCase()}`
              : null;
      if (!job) continue;
      for (const r of apiRequests(job))
        add(r.url, 'the job board’s data for this job (embedded in the page)', 0.96, { request: r, structural: true });
      add(job, 'the job board’s page for this job (embedded in the page)', 0.91, { structural: true });
    }
    // Phenom: the job ID written on the apply page, found inside its jobSeqNo ("…R364008…" ← "R_364008").
    if (ctxAts.name === 'phenom' && ctxAts.jobSeqNo && ctxAts.base && parseUrl(ctx.url)) {
      for (const id of ctx.jobIds || [])
        if (idKey(id).length >= 4 && idKey(ctxAts.jobSeqNo).includes(idKey(id)))
          add(`${parseUrl(ctx.url).origin}${ctxAts.base}/job/${encodeURIComponent(id)}`, 'the job page', 0.92, {
            structural: true,
          });
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
    if (!ctx.pasted) for (const c of trailCandidates(ctx, now)) add(c.url, c.reason, c.weight, { trail: c.trail });
    // A job page that hasn't rendered its description yet: its server HTML may carry JSON-LD.
    if (!ctx.posting && ctxAts.stage === 'description' && !ctx.pasted)
      out.set('self:' + urlKey(ctx.url), { url: ctx.url, reason: 'this page as the server sends it', weight: 0.45 });
    return Array.from(out.values()).sort((x, y) => y.weight - x.weight);
  }

  /* -------------------------------------------------------------- history */

  function titleCore(title) {
    return keyTokens(title, {}).slice(0, 5);
  }

  /** The site's own label: "apply.careers.hsbc.com" → "hsbc", "passport.amazon.jobs" → "amazon". */
  function siteLabel(url) {
    const u = parseUrl(url);
    return u ? companyFromHost(u.hostname.replace(/^www\./, '')) || '' : '';
  }

  /** Does this address look like one job's page (not a list, a home page or a sign-in)? */
  function looksLikeJobPage(url) {
    const u = parseUrl(url);
    if (
      !u ||
      u.pathname.replace(/\/+$/, '') === '' ||
      LIST_PAGE.test(u.pathname + u.search) ||
      LOGIN_PAGE.test(u.pathname)
    )
      return false;
    const a = ats(url);
    if (a.stage === 'description') return true;
    if (a.stage === 'application') return false;
    return (
      urlJobIds(url).length > 0 &&
      /job|career|position|vacanc|opening|posting|opportunit|role|requisition|stelle|emploi|offre|vagas?/i.test(
        u.pathname + u.search,
      )
    );
  }

  const isTrackr = (url) => /(^|\.)the-trackr\.com$/i.test((parseUrl(url) || {}).hostname || '');

  /**
   * chrome.history.search queries: the job's IDs, its title, the company, the site's own name, and everything
   * visited in the last three hours (a sign-in wall often drops all of these, but the job page was just opened).
   */
  function historyQuery(context, now) {
    const ctx = context || {};
    const t = now || Date.now();
    const startTime = t - 60 * 864e5;
    const out = [];
    for (const id of (ctx.jobIds || []).filter((x) => idKey(x).length >= 4).slice(0, 2))
      out.push({ text: String(id), startTime, maxResults: 25 });
    const core = titleCore(ctx.title);
    if (core.length)
      out.push({ text: clean(String(ctx.title).replace(/[|–—:()[\]]+/g, ' '), 80), startTime, maxResults: 40 });
    const company = clean(String(ctx.company || (ctx.ats && ctx.ats.company) || '').replace(/[.,]+$/, ''), 60);
    if (company) out.push({ text: company, startTime, maxResults: 60 });
    const label = siteLabel(ctx.url);
    if (label && label.length >= 3 && !compact(company).includes(compact(label)))
      out.push({ text: label, startTime, maxResults: 60 });
    out.push({ text: '', startTime: t - 3 * 36e5, maxResults: 200 });
    return out;
  }

  /** What a visited page (history or this tab's trail) shares with the application: ID, title, board, site, company. */
  function visitSignals(ctx, url, title) {
    const ctxAts = ctx.ats && 'stage' in ctx.ats ? ctx.ats : ats(ctx.url || '');
    const a = ats(url);
    const label = siteLabel(ctx.url);
    const hay = `${url} ${title || ''}`.toLowerCase();
    const sameAts =
      !!a.name &&
      a.name === ctxAts.name &&
      !!a.company &&
      !!ctxAts.company &&
      compact(a.company) === compact(ctxAts.company);
    // Another employer on the same board's servers (career8.successfactors.com hosts Moody's and others) is no
    // same site.
    const otherTenant =
      !!a.name &&
      a.name === ctxAts.name &&
      !!a.company &&
      !sameAts &&
      (!!ctxAts.company || (!!ctx.company && companyMatch(ctx.company, a.company) === false));
    return {
      idHit: (ctx.jobIds || []).some((id) => idKey(id).length >= 4 && idKey(hay).includes(idKey(id))),
      ts: titleSimilarity(ctx.title, title || '', ctx),
      sameAts,
      sameSite: sameAts || (!otherTenant && !!label && label.length >= 3 && siteLabel(url) === label),
      companyHit: !!ctx.company && compact(ctx.company).length >= 3 && compact(hay).includes(compact(ctx.company)),
      jobPage: looksLikeJobPage(url),
    };
  }

  /**
   * This tab's earlier pages (context.trail, newest first: [{ url, title, at }]) as candidates. The tab itself is
   * the evidence — the job page the user clicked Apply on was open here moments ago — so no other match is needed;
   * one adds weight, a clashing title takes it away. Capped below a pasted address and a strong job-ID match.
   */
  function trailCandidates(ctx, now) {
    const t = now || Date.now();
    const out = [];
    let pos = 0;
    for (const e of (Array.isArray(ctx.trail) ? ctx.trail : []).slice(0, 12)) {
      const u = e && parseUrl(e.url);
      if (!u || !/^https?:$/.test(u.protocol) || urlKey(u.href) === urlKey(ctx.url)) continue;
      if (
        SEARCH_HOST.test(u.hostname) ||
        isTrackr(u.href) ||
        u.pathname.replace(/\/+$/, '') === '' ||
        LIST_PAGE.test(u.pathname + u.search) ||
        LOGIN_PAGE.test(u.pathname) ||
        ACTION_LINK.test(u.href) ||
        ats(u.href).stage === 'application'
      )
        continue;
      const ageMin = e.at ? Math.max(0, (t - e.at) / 6e4) : 60;
      const sig = visitSignals(ctx, u.href, e.title);
      let w = (ageMin <= 30 ? 0.6 : Math.max(0.3, 0.6 * Math.exp(-(ageMin - 30) / 60))) - 0.05 * pos;
      if (sig.idHit) w += 0.2;
      if (sig.ts != null && sig.ts >= 0.5) w += 0.15 * sig.ts;
      else if (sig.ts != null && sig.ts < 0.35) w -= 0.2;
      if (sig.sameSite || sig.companyHit) w += 0.05;
      out.push({
        url: u.href,
        reason: 'the job page you opened before this one in this tab',
        weight: Math.round(Math.max(0.1, Math.min(w, sig.idHit ? 0.87 : 0.8)) * 1000) / 1000,
        trail: { ageMin: Math.round(ageMin), pos, sameSite: sig.sameSite || sig.companyHit, jobPage: sig.jobPage },
      });
      pos++;
    }
    return out;
  }

  /**
   * History items as candidates: pages with the job's ID or title, and job pages on the same site or board —
   * the one opened last, minutes before this application page, first. Each says how recent it was and how
   * many other jobs on that site were opened in the same hour (`history: { ageMin, latest, rivals }`).
   */
  function rankHistory(context, items, now) {
    const ctx = context || {};
    const t = now || Date.now();
    const seen = new Set();
    const rows = [];
    for (const it of items || []) {
      if (!it || !it.url) continue;
      const u = parseUrl(it.url);
      if (!u || !/^https?:$/.test(u.protocol)) continue;
      const key = urlKey(it.url);
      if (seen.has(key) || key === urlKey(ctx.url)) continue;
      seen.add(key);
      if (
        SEARCH_HOST.test(u.hostname) ||
        isTrackr(it.url) ||
        LIST_PAGE.test(u.pathname + u.search) ||
        LOGIN_PAGE.test(u.pathname) ||
        ACTION_LINK.test(it.url)
      )
        continue;
      if (ats(it.url).stage === 'application') continue;
      const sig = visitSignals(ctx, it.url, it.title);
      const ageMin = it.lastVisitTime ? Math.max(0, (t - it.lastVisitTime) / 6e4) : 1e6;
      if (!sig.idHit && !(sig.ts != null && sig.ts >= 0.5) && !(sig.jobPage && (sig.sameSite || sig.companyHit)))
        continue;
      rows.push({ it, ...sig, ageMin });
    }
    // Job pages on this site opened in the last hour, newest first: the one just before this page is the likeliest.
    const recent = rows.filter((r) => r.jobPage && (r.sameSite || r.companyHit) && r.ageMin <= 60);
    recent.sort((x, y) => x.ageMin - y.ageMin);
    const out = rows.map((r) => {
      let w = 0.2;
      const reasons = [];
      if (r.idHit) {
        w += 0.35;
        reasons.push('job ID');
      }
      if (r.ts != null && r.ts >= 0.5) {
        w += 0.25 * r.ts;
        reasons.push('title');
      }
      if (r.sameAts || r.sameSite || r.companyHit) {
        w += 0.1;
        reasons.push(r.sameAts ? 'same job board' : r.sameSite ? 'same site' : 'company');
      }
      const i = recent.indexOf(r);
      if (i === 0) {
        w += 0.2;
        reasons.push(`opened ${Math.max(1, Math.round(r.ageMin))} min ago`);
      } else if (i > 0) w += 0.05;
      w += 0.1 * Math.exp(-r.ageMin / (7 * 1440));
      if (r.jobPage) w += 0.05;
      return {
        url: r.it.url,
        reason: `in your history (${reasons.join(', ')})`,
        weight: Math.round(Math.min(w, 0.85) * 1000) / 1000,
        history: { ageMin: Math.round(r.ageMin), latest: i === 0, rivals: i >= 0 ? recent.length - 1 : 0 },
      };
    });
    return out.sort((x, y) => y.weight - x.weight).slice(0, 6);
  }

  /* --------------------------------------------------------------- Trackr */

  // app.the-trackr.com trackers live at /{region}-{industry}[-{season}][/{type}]; their outbound links carry
  // utm_source=Trackr&utm_campaign={Region}_{Industry}_{season}; api.the-trackr.com lists each tracker's
  // programmes (company, name, deadline, locations, link) as public JSON.
  // prettier-ignore
  const TRACKR_REGIONS = { uk: 'UK', us: 'US', eu: 'EU', france: 'France', germany: 'Germany', italy: 'Italy', hong_kong: 'Hong Kong' };
  const TRACKR_TYPES =
    /^(summer-internships|graduate-programmes|off-cycle-internships|spring-weeks|placements|vacation-schemes|training-contracts)$/;
  const TRACKR_KEY =
    /^(uk|us|eu|france|germany|italy|hong[-_]kong)[-_](finance|tech|law|engineering)(?:[-_](20\d\d))?$/i;
  const TRACKR_TAGS = /^(utm_source|utm_medium|utm_campaign|utm_content|utm_term|gh_src|source|src|ref|trid)$/i;

  /** What an address says about a Trackr tracker: its own page, or a link out of it (utm_source=Trackr). */
  function trackrTracker(url) {
    const u = parseUrl(url);
    if (!u || !/^https?:$/.test(u.protocol)) return null;
    const make = (m, type, extra) => ({
      region: TRACKR_REGIONS[m[1].toLowerCase().replace('-', '_')],
      industry: m[2][0].toUpperCase() + m[2].slice(1).toLowerCase(),
      season: m[3] || null,
      type: type && TRACKR_TYPES.test(type) ? type : null,
      ...extra,
    });
    if (isTrackr(u.href)) {
      const [slug, type] = u.pathname.split('/').filter(Boolean);
      const m = String(slug || '').match(TRACKR_KEY);
      return m
        ? make(m, type, { page: u.href })
        : { region: null, industry: null, season: null, type: null, page: u.href };
    }
    if (![...u.searchParams.values()].some((v) => /^trackr$/i.test(v))) return null;
    const m = String(u.searchParams.get('utm_campaign') || '').match(TRACKR_KEY);
    return m
      ? make(m, null, { link: u.href })
      : { region: null, industry: null, season: null, type: null, link: u.href };
  }

  /** The same job's address, give or take tracking parameters ("?feedId=…&utm_source=Trackr")? */
  function sameJobUrl(a, b) {
    if (untagged(a) === untagged(b)) return true;
    const x = parseUrl(a);
    const y = parseUrl(b);
    if (!x || !y || x.hostname.replace(/^www\./, '') !== y.hostname.replace(/^www\./, '')) return false;
    const ix = urlJobIds(x.href);
    const iy = urlJobIds(y.href);
    if (ix.length && iy.length) return ix.some((i) => iy.some((j) => idsMatch(i, j)));
    return (
      x.pathname.replace(/\/+$/, '').toLowerCase() === y.pathname.replace(/\/+$/, '').toLowerCase() &&
      x.pathname.length > 1 &&
      !ix.length &&
      !iy.length &&
      !x.search &&
      !y.search
    );
  }

  /** An address without Trackr's tracking parameters (how Trackr's own list names the job). */
  function untagged(url) {
    const u = parseUrl(url);
    if (!u) return String(url || '');
    for (const k of [...u.searchParams.keys()]) if (TRACKR_TAGS.test(k)) u.searchParams.delete(k);
    return urlKey(u.href);
  }

  /**
   * Did the user come from Trackr? From the referrer, this tab's trail, history visits and tagged addresses: the
   * tracker (region, industry, season, type when known) and the tagged links. Only a hint, never a description.
   */
  function trackrHint(context, items) {
    const ctx = context || {};
    const urls = uniq([
      ctx.url,
      ctx.canonical,
      ctx.referrer,
      ...(Array.isArray(ctx.trail) ? ctx.trail.map((e) => e && e.url) : []),
      ...(items || []).map((i) => i && i.url),
    ]);
    const found = urls.map(trackrTracker).filter(Boolean);
    if (!found.length) return null;
    const known = found.filter((f) => f.region);
    const best = known.find((f) => f.season) || known[0] || found[0];
    const same = known.filter((f) => f.region === best.region && f.industry === best.industry);
    return {
      region: best.region,
      industry: best.industry,
      season: (same.find((f) => f.season) || {}).season || null,
      type: (same.find((f) => f.type) || {}).type || null,
      links: uniq(found.map((f) => f.link)).slice(0, 10),
    };
  }

  /** api.the-trackr.com requests for a hint's tracker (the type when known, else the likeliest ones). */
  function trackrRequests(hint) {
    if (!hint || !hint.region || !hint.industry || !hint.season) return [];
    const types = hint.type
      ? [hint.type]
      : hint.industry === 'Law'
        ? ['vacation-schemes', 'training-contracts']
        : ['summer-internships', 'graduate-programmes', 'off-cycle-internships'];
    return types.map((type) => ({
      url: `https://api.the-trackr.com/programmes?region=${encodeURIComponent(hint.region)}&industry=${hint.industry}&season=${hint.season}&type=${type}`,
      method: 'GET',
      headers: { ...JSON_HEADERS },
      body: null,
      kind: 'trackr',
    }));
  }

  /** The Trackr programme this application is for: its link is this page, or one the user opened from Trackr. */
  function trackrProgramme(context, json, hint) {
    const list = json && Array.isArray(json.programmes) ? json.programmes : [];
    const ctx = context || {};
    const mine = uniq([
      ctx.url,
      ctx.canonical,
      ...((hint && hint.links) || []),
      ...(Array.isArray(ctx.trail) ? ctx.trail.map((e) => e && e.url) : []),
    ]);
    const p = list.find((x) => x && x.url && mine.some((m) => sameJobUrl(m, x.url)));
    if (!p) return null;
    const company = (p.company && p.company.name) || '';
    return {
      source: 'Trackr',
      company: field(company, 120),
      programme: field(p.name, 200),
      deadline: p.closingDate ? String(p.closingDate).slice(0, 10) : null,
      opens: p.openingDate ? String(p.openingDate).slice(0, 10) : null,
      locations: (p.locations || []).map((l) => field(l, 60)).slice(0, 6),
      url: p.url,
      tracker: `${p.region} ${p.industry} ${p.type} ${p.season}`,
      // Trackr's short note on the company: background for "Why us?" answers, never the job's description.
      about: field((p.company && p.company.description) || '', 600),
    };
  }

  /* -------------------------------------------------------------- compare */

  // prettier-ignore
  const TITLE_REWRITES = [
    // Requisition codes: "(Req #12345)", "[JR-1234]", "– R0012345", "Job ID: 5678".
    [/[([]\s*(?:(?:req(?:uisition)?|job|ref|vacancy|position)\.?\s*(?:id|no\.?|number|#)?\s*[:#]?\s*)?[A-Z]{0,4}[-_]?\d{3,}[\w-]*\s*[)\]]/gi, ' '],
    [/\b(?:req(?:uisition)?|job|ref|vacancy|position)\.?\s*(?:id|no\.?|number|#)\s*[:#]?\s*[A-Z]{0,4}[-_]?\d{3,}[\w-]*/gi, ' '],
    [/\s[-–—|]\s*(?:R|JR|REQ|VAC)[-_]?\d{4,}(?:-\d+)?\s*$/gi, ' '],
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

  // Words that say what kind of job it is, not which one.
  const ROLE_WORDS = new Set(
    'intern graduate program analyst associate engineer developer trainee apprentice apprenticeship placement consultant assistant officer specialist manager junior senior lead staff student scholar fellow fellowship rotation rotational vacation insight week day experience training contract solicitor'.split(
      ' ',
    ),
  );

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
    // One title is a shorter form of the other ("Quant Research Intern" in "Quant Research Intern – Equities"),
    // as long as they share more than role words ("Graduate Engineer" is in every engineering firm's list).
    let contain = small >= 2 ? (inter / small) * 0.9 : 0;
    if (contain && ![...sa].some((t) => sb.has(t) && !ROLE_WORDS.has(t))) contain *= 0.65;
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
    // Initials that count the words set aside above: "SIG" ↔ "Susquehanna International Group".
    const fa = U.tokens(b).filter((t) => t !== 'the');
    const fb = U.tokens(a).filter((t) => t !== 'the');
    if (A.length === 1 && ca.length <= 6 && fa.length > B.length && abbreviates(ca, fa)) return true;
    if (B.length === 1 && cb.length <= 6 && fb.length > A.length && abbreviates(cb, fb)) return true;
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

  // Cities that job titles name ("Summer Analyst – London" vs "– New York"): the same programme elsewhere.
  // prettier-ignore
  const CITIES = ['london', 'new york', 'hong kong', 'paris', 'frankfurt', 'munich', 'berlin', 'hamburg', 'dusseldorf', 'zurich', 'geneva', 'milan', 'rome', 'madrid', 'barcelona', 'lisbon', 'dublin', 'edinburgh', 'glasgow', 'manchester', 'birmingham', 'leeds', 'bristol', 'belfast', 'cardiff', 'aberdeen', 'amsterdam', 'brussels', 'luxembourg', 'stockholm', 'copenhagen', 'oslo', 'helsinki', 'warsaw', 'prague', 'vienna', 'budapest', 'athens', 'istanbul', 'dubai', 'abu dhabi', 'riyadh', 'doha', 'mumbai', 'bengaluru', 'delhi', 'gurugram', 'hyderabad', 'chennai', 'pune', 'singapore', 'tokyo', 'seoul', 'shanghai', 'beijing', 'shenzhen', 'taipei', 'sydney', 'melbourne', 'toronto', 'montreal', 'vancouver', 'chicago', 'boston', 'san francisco', 'los angeles', 'houston', 'dallas', 'charlotte', 'seattle', 'austin', 'atlanta', 'miami', 'philadelphia', 'denver', 'sao paulo', 'mexico city', 'johannesburg', 'tel aviv', 'kuala lumpur', 'bangkok', 'jakarta', 'manila', 'lyon', 'marseille', 'lille', 'toulouse', 'bordeaux', 'nantes', 'strasbourg', 'cologne', 'stuttgart', 'leipzig', 'hanover', 'nuremberg', 'turin', 'bologna', 'florence', 'naples', 'valencia', 'seville', 'bilbao', 'porto', 'rotterdam', 'utrecht', 'antwerp', 'gothenburg', 'basel', 'lausanne', 'lugano', 'krakow', 'wroclaw', 'bucharest', 'nottingham', 'sheffield', 'liverpool', 'newcastle', 'southampton'];
  const CITY_RE = new RegExp(`\\b(${CITIES.join('|')})\\b`, 'g');

  /** Cities a title or a place names, in one spelling ("NYC" → "new york", "Zürich" → "zurich"). */
  function cities(...texts) {
    const n = U.normalize(texts.filter(Boolean).join(' | ')).replace(/[\p{L}]+/gu, (w) => PLACE_ALIASES[w] || w);
    return uniq(n.match(CITY_RE) || []);
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
    let l = locationMatch(ctx.location, posting.location);
    // The cities each side names, in its title or its place: none in common means another city's vacancy.
    const cityA = cities(ctx.title, ctx.location);
    const cityB = cities(posting.title, posting.location);
    const cityClash =
      cityA.length > 0 &&
      cityB.length > 0 &&
      !cityA.some((x) => cityB.includes(x)) &&
      !/remote|multiple|various/i.test(`${ctx.location || ''} ${posting.location || ''}`);
    if (cityClash) l = false;
    if (t != null) reasons.push(t >= 0.85 ? 'title matches' : t >= 0.5 ? 'title is similar' : 'title differs');
    if (c === true) reasons.push('company matches');
    if (c === false) reasons.push('company differs');
    if (l === true) reasons.push('location matches');
    if (l === false) reasons.push('location differs');
    if ((Array.isArray(ctx.trail) ? ctx.trail : []).some((e) => e && urlKey(e.url) === urlKey(posting.url)))
      reasons.push('you opened this page before this one in this tab');

    // The addresses' own job IDs outrank IDs that only the page's text shared ("similar jobs" lists).
    // Two different jobs on the same board: same ATS and company, both with a job ID of the same kind.
    // The page's canonical address names the same job, perhaps reposted under a new ID (SmartRecruiters).
    const aliases = ctx.canonical ? uniq([ats(ctx.canonical).jobId, ...urlJobIds(ctx.canonical)]) : [];
    const sameBoard =
      ctxAts.name &&
      ctxAts.name === pAts.name &&
      ctxAts.company &&
      pAts.company &&
      compact(ctxAts.company) === compact(pAts.company);
    if (
      sameBoard &&
      ctxAts.jobId &&
      pAts.jobId &&
      idShape(ctxAts.jobId) === idShape(pAts.jobId) &&
      !idsMatch(ctxAts.jobId, pAts.jobId) &&
      !aliases.some((x) => idsMatch(x, pAts.jobId))
    ) {
      reasons.unshift(`different job ID (${ctxAts.jobId} vs ${pAts.jobId})`);
      return { score: 0.05, verdict: 'different', reasons };
    }
    // SuccessFactors numbers each employer's requisitions on its own: ExxonMobil's 14588 is not Moody's 14588.
    const onSf = (x) => SF_HOST.test((parseUrl(x || '') || {}).hostname || '');
    if (sharedId && ctxAts.company && pAts.company && !sameBoard && onSf(ctx.url) && onSf(posting.url)) {
      reasons.unshift(`another employer’s requisition ${sharedId} (${pAts.company}, not ${ctxAts.company})`);
      return { score: 0.05, verdict: 'different', reasons };
    }
    // Both addresses (or the posting's own data) name a job ID of the same kind, and they differ.
    const strongCtx = uniq([
      ctxAts.jobId,
      ...urlJobIds(ctx.url || ''),
      ...(ctx.canonical ? urlJobIds(ctx.canonical) : []),
    ]);
    const strongPost = uniq([pAts.jobId, ...(posting.jobIds || []).map(String)]);
    // (Or a board hosted for the company's own site: careers-sig.icims.com ↔ careers.sig.com.)
    const sameSite =
      sameBoard ||
      (parseUrl(ctx.url || '') &&
        parseUrl(posting.url || '') &&
        (companyFromHost(parseUrl(ctx.url).hostname) === companyFromHost(parseUrl(posting.url).hostname) ||
          (!!ctxAts.company && compact(ctxAts.company) === siteLabel(posting.url)) ||
          (!!pAts.company && compact(pAts.company) === siteLabel(ctx.url))));
    const clash =
      c !== false &&
      sameSite &&
      !strongCtx.some((x) => strongPost.some((y) => idsMatch(x, y))) &&
      strongCtx.find(
        (x) =>
          idKey(x).length >= 4 &&
          !strongPost.some((y) => idsMatch(x, y)) &&
          strongPost.some((y) => idShape(x) === idShape(y)),
      );
    if (clash) {
      const theirs = strongPost.find((y) => idShape(clash) === idShape(y));
      reasons.unshift(`different job ID (${clash} vs ${theirs})`);
      return { score: 0.1, verdict: 'different', reasons };
    }
    if (sharedId) {
      if (c === false && t != null && t < 0.3) {
        reasons.unshift(`same job ID ${sharedId}, but nothing else matches`);
        return { score: 0.5, verdict: 'unsure', reasons };
      }
      reasons.unshift(`same job ID ${sharedId}`);
      return { score: 0.97, verdict: 'same', reasons };
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
    else if (t < 0.35 || (c === false && t < 0.75) || (l === false && t < 0.6) || (c === false && l === false))
      verdict = 'different';
    else if (l === false && c !== false && ((specific(ctx.location) && specific(posting.location)) || cityClash))
      verdict = 'different';
    return { score, verdict, reasons };
  }

  /* ----------------------------------------------------------------- find */

  function looksLikeShell(html) {
    const body = String(html || '').replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ');
    const text = htmlToText(body);
    return words(text) < 120;
  }

  /** Did a job's address (with its ID) land on a page without it — the careers home, a list or a search? */
  function movedAway(from, to) {
    if (!to || urlKey(from) === urlKey(to)) return false;
    const ids = uniq([ats(from).jobId, ...urlJobIds(from)]).filter((x) => idKey(x).length >= 4);
    if (!ids.length) return false;
    const now = uniq([ats(to).jobId, ...urlJobIds(to)]);
    if (now.some((y) => ids.some((x) => idsMatch(x, y)))) return false;
    const u = parseUrl(to);
    return !!u && (u.pathname.replace(/\/+$/, '') === '' || LIST_PAGE.test(u.pathname + u.search) || !now.length);
  }

  /** A trail or history candidate that is almost certainly the page the user clicked Apply on. */
  // (Not history alone: a job page opened minutes ago in some tab may not be the one being applied for; with
  // nothing on the application page to compare, that stays 'unsure' for the AI check and the user to confirm.)
  // (A programme page without a job ID — a law firm's vacation scheme — counts when its text is a real advert.)
  function justBefore(c, posting) {
    return (
      !!c.trail &&
      c.trail.pos === 0 &&
      c.trail.ageMin <= 30 &&
      c.trail.sameSite &&
      (c.trail.jobPage || (!!posting && jobStructure(posting.description) >= 2 && !isLegalText(posting.description)))
    );
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
    const ctxAts0 = ctx.ats && 'stage' in ctx.ats ? ctx.ats : ats(ctx.url || '');
    const aboutOneJob = (ctx.jobIds || []).length > 0 || ctxAts0.stage !== 'unknown';
    const here = ctx.posting;
    const onPage =
      !ctx.pasted &&
      here &&
      here.description &&
      (here.confidence || 0) >= 0.6 &&
      words(here.description) >= 80 &&
      (here.source !== 'page-text' || aboutOneJob);
    // Text read off the page (not data that says it's a job posting) must read like a job advert — never a
    // cookie or privacy notice — and when a job board's ID is in the address (gh_jid=…) or a board is embedded,
    // the board's own data is asked first: 'same' then rests on the job ID.
    const marked = here && /json-ld|microdata/.test(here.source);
    const advert = onPage && (marked || (jobStructure(here.description) >= 2 && !isLegalText(here.description)));
    const askBoard =
      onPage && here.source === 'page-text' && (apiRequests(ctx.url || '').length > 0 || (ctx.embeds || []).length > 0);
    // A programme page (a law firm's training contract, a company's own advert) with no job ID or board to ask:
    // its own text, as 'likely' — when nothing better turns up and it isn't a home, list or sign-in page.
    const pu = parseUrl(ctx.url || '');
    const plainPage =
      !ctx.pasted &&
      !onPage &&
      here &&
      here.source === 'page-text' &&
      words(here.description) >= 120 &&
      jobStructure(here.description) >= 2 &&
      !isLegalText(here.description) &&
      !!pu &&
      pu.pathname.replace(/\/+$/, '') !== '' &&
      !LIST_PAGE.test(pu.pathname + pu.search) &&
      !LOGIN_PAGE.test(pu.pathname);
    const deferred = (advert && askBoard) || plainPage ? here : null;
    if (advert && !askBoard) {
      const cmp = compare(ctx, here);
      if (cmp.verdict !== 'different')
        return {
          posting: ctx.posting,
          verdict: 'same',
          reasons: ['the description is on this page'],
          source: ctx.url,
          tried: [
            {
              url: ctx.url || '',
              outcome: `same: the description is on this page (${ctx.posting.title || 'untitled'})`,
            },
          ],
        };
    }

    let list = candidates(ctx, opts.now);
    const items = [];
    if (opts.historySearch && !ctx.pasted) {
      try {
        for (const query of historyQuery(ctx, opts.now)) {
          const got = await opts.historySearch(query);
          if (Array.isArray(got)) items.push(...got);
        }
        list = list.concat(rankHistory(ctx, items, opts.now));
      } catch (err) {
        tried.push({ url: 'history', outcome: `history search failed: ${(err && err.message) || err}` });
      }
    }
    // One entry per page (a page can be in this tab's trail, in history and linked from the page).
    const byKey = new Map();
    for (const c of list) {
      const k = (c.request ? 'api:' : '') + urlKey(c.url);
      const prev = byKey.get(k);
      if (!prev) byKey.set(k, c);
      else byKey.set(k, { ...(prev.weight >= c.weight ? c : prev), ...(prev.weight >= c.weight ? prev : c) });
    }
    list = Array.from(byKey.values()).sort((x, y) => y.weight - x.weight);
    if (!fetchFn) {
      return { posting: null, verdict: null, reasons: ['no way to fetch pages'], source: null, tried };
    }
    // Came from Trackr? Its list names the company, the programme and the deadline: a hint for comparing (never
    // the description). Looked up alongside the job's own pages; used once they have answered.
    let hint = null;
    let hintDone = false;
    const tracker = !ctx.pasted ? trackrHint(ctx, items) : null;
    const hintLookup = tracker && trackrRequests(tracker).length ? lookupTrackr(tracker) : null;
    // Nothing to look up: say why, so the studio can tell the user (and never report an empty search).
    if (!list.length && !hintLookup && !deferred) {
      const why = ctx.gone
        ? 'the job board says this job is closed or no longer available'
        : 'nothing to look up: this page has no job address, job ID or link to the job';
      tried.push({ url: ctx.url || '', outcome: why });
      return { posting: null, verdict: null, reasons: [why], source: null, tried };
    }

    // (Its outcomes join `tried` only when the hint is used: a lookup still running when find() returns is dropped.)
    async function lookupTrackr(tr) {
      const log = [];
      for (const r of trackrRequests(tr)) {
        let timer = null;
        let found = null;
        try {
          const res = await Promise.race([
            fetchFn(r.url, { method: 'GET', headers: r.headers }),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('timed out')), timeout);
            }),
          ]);
          const data =
            res && res.ok !== false
              ? typeof res.json === 'function'
                ? await res.json()
                : parseJsonLoose(await res.text())
              : null;
          found = trackrProgramme(ctx, data, tr);
          log.push({
            url: r.url,
            outcome: found ? `Trackr: ${found.programme} (${found.company})` : 'Trackr: this job isn’t in the tracker',
          });
        } catch (err) {
          log.push({ url: r.url, outcome: `Trackr: failed: ${clean((err && err.message) || err, 80)}` });
        } finally {
          if (timer) clearTimeout(timer);
        }
        if (found) {
          hintDone = true;
          return { found, log };
        }
      }
      hintDone = true;
      return { found: null, log };
    }

    const isDone = () => results.some((r) => r.cmp.verdict === 'same' && r.cmp.score >= 0.9);
    const closed = [];
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
        // A redirect to a sign-in page isn't a closed job: the user's own session (a background tab) may show it.
        const fu = parseUrl(finalUrl);
        if (
          !req &&
          fu &&
          urlKey(finalUrl) !== urlKey(c.url) &&
          (LOGIN_PAGE.test(fu.pathname) ||
            /^(login|signin|sso|auth|passport|accounts?|id|identity)\./i.test(fu.hostname))
        )
          return outcome('no posting without signing in (it redirects to a sign-in page)');
        // A closed job's page often redirects to the careers home or a job list: closed, not another posting.
        if (!req && movedAway(c.url, finalUrl)) {
          closed.push(finalUrl);
          return outcome(`closed: the job page now redirects to ${clean(finalUrl, 120)}`);
        }
        if (req || /json/i.test(type) || (body && /^\s*[{[]/.test(body) && !/^\s*</.test(body))) {
          if (!json) json = parseJsonLoose(body);
          posting = json ? fromApi(req ? req.kind : null, json, req ? req.page : finalUrl) : null;
          // (Worded so the studio doesn't open data addresses in a tab: see its /empty|no posting|shell|script/.)
          if (!posting) return outcome(json ? 'this job isn’t in the board’s data' : 'unreadable data');
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

    // The Trackr hint: waited for unless the job is already settled (then only taken if it has arrived).
    if (hintLookup) {
      const settled = results.some((r) => r.cmp.verdict === 'same' && !r.posting.companyGuessed);
      if (!settled || hintDone) {
        const got = await hintLookup;
        tried.push(...got.log);
        hint = got.found;
      }
    }
    if (hint) {
      // (A page's company that Trackr contradicts is likely its template's: "Company Name".)
      const hintCompany = !!hint.company && (!ctx.company || companyMatch(ctx.company, hint.company) === false);
      const cmpCtx =
        (!ctx.title && hint.programme) || hintCompany
          ? { ...ctx, title: ctx.title || hint.programme, company: hintCompany ? hint.company : ctx.company }
          : null;
      // The job page Trackr links to, when nothing better has been found.
      const hu = parseUrl(hint.url);
      if (
        hu &&
        !results.some((r) => ['same', 'likely'].includes(r.cmp.verdict)) &&
        urlKey(hu.href) !== urlKey(ctx.url) &&
        ats(hu.href).stage !== 'application' &&
        !LIST_PAGE.test(hu.pathname + hu.search) &&
        !tried.some((t) => sameJobUrl(t.url, hu.href))
      )
        await load({ url: hu.href, reason: 'the job page Trackr links to', weight: 0.7 });
      // Trackr's programme name and company only break ties: never 'same' or 'different' on their own.
      if (cmpCtx)
        for (const r of results) {
          if (r.cmp.verdict !== 'unsure') continue;
          const h = compare(cmpCtx, r.posting);
          if (h.verdict === 'same' || (h.score >= 0.85 && !h.reasons.some((x) => /differs/.test(x))))
            r.cmp = {
              ...r.cmp,
              score: Math.max(r.cmp.score, Math.min(h.score, 0.89)),
              reasons: [...r.cmp.reasons, 'the programme you opened on Trackr'],
              hinted: true,
            };
          else if (h.verdict === 'different')
            r.cmp = {
              ...r.cmp,
              score: Math.round(r.cmp.score * 50) / 100,
              reasons: [...r.cmp.reasons, 'not the programme you opened on Trackr'],
            };
        }
    }

    for (const r of results) {
      const clash = /different job ID/.test(r.cmp.reasons.join(' '));
      // Reached from this very application page by the board's own URL scheme: likely the same job.
      if (r.cmp.verdict === 'unsure' && r.c.structural && r.cmp.score >= 0.45 && !clash) r.verdict = 'likely';
      // The job page this tab showed just before (on the same site), or Trackr's programme name matches:
      // likely, when nothing on the application page says otherwise (another employer's job, say).
      else if (
        r.cmp.verdict === 'unsure' &&
        !clash &&
        ((justBefore(r.c, r.posting) && !r.cmp.reasons.includes('company differs')) ||
          (r.cmp.hinted && r.cmp.score >= 0.85))
      )
        r.verdict = 'likely';
      else r.verdict = r.cmp.verdict;
    }
    const rank = { same: 3, likely: 2, unsure: 1, different: 0 };
    results.sort((x, y) => rank[y.verdict] - rank[x.verdict] || y.cmp.score - x.cmp.score || y.c.weight - x.c.weight);
    const best = results[0];
    // The board didn't answer for the job on this page: the page's own text, without its confirmation.
    if (deferred && (!best || rank[best.verdict] < rank.likely) && compare(ctx, deferred).verdict !== 'different') {
      tried.push({
        url: ctx.url || '',
        outcome: `likely: the description is on this page (${deferred.title || 'untitled'})`,
      });
      return withHint({
        posting: deferred,
        verdict: 'likely',
        reasons: [
          'the description is on this page',
          plainPage ? 'no job ID or job board to confirm it' : 'the job board didn’t confirm it',
        ],
        source: ctx.url,
        tried,
      });
    }
    if (!best || best.verdict === 'different') {
      return withHint({
        posting: null,
        verdict: best ? 'different' : null,
        reasons: [
          ...(best ? best.cmp.reasons : ['no job description found']),
          ...(ctx.gone ? ['the job board says this job is closed or no longer available'] : []),
          ...(closed.length
            ? ['the job’s page now redirects to a general careers page: the job is probably closed']
            : []),
        ],
        source: null,
        tried,
      });
    }
    // Why this page was looked at, when the match itself can't settle it (a trail or history visit, a board URL).
    const reasons =
      best.verdict === 'likely' || (best.verdict === 'unsure' && (best.c.history || best.c.trail))
        ? [...best.cmp.reasons, best.c.reason]
        : best.cmp.reasons;
    return withHint({ posting: best.posting, verdict: best.verdict, reasons, source: best.c.url, tried });

    /** The Trackr hint goes with the answer; it also names the company when the posting only guessed it. */
    function withHint(out) {
      if (!hint) return out;
      if (
        out.posting &&
        out.posting.companyGuessed &&
        hint.company &&
        companyMatch(out.posting.company, hint.company) !== true
      )
        out.posting = { ...out.posting, company: hint.company, companyGuessed: false };
      return { ...out, hint };
    }
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
    trackrHint,
    trackrRequests,
    trackrProgramme,
  };
  JTF.jobpage = jobpage;
  if (typeof module === 'object' && module.exports) module.exports = jobpage;
})(typeof globalThis !== 'undefined' ? globalThis : this);
