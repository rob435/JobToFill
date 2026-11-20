/*
 * JobToFill — the application tracker: how far each application you filled got, read from the employers' emails in
 * your inbox (Settings › Application log › "Follow my applications in my inbox", off unless switched on).
 *
 *   employerOf(app)                 → { company, role, slug, forms, caps, domains }  who an application is with
 *   sameApplication(a, b, now)      → is a fill another step of the application `a` logged (Workday's steps)?
 *   worth(message, apps, { me })    → is a message listed without its body worth reading in full?
 *   plainText(html)                 → an email's body as text, without the thread it quotes
 *   classify({ from, subject, text })  → { kind: 'received'|'test'|'interview'|'offer'|'rejected'|null, detail, quote }
 *   match(message, apps)            → { id, why } | { ambiguous: [ids], why } | null
 *   advance(app, event)             → the application with the email's event recorded and its stage worked out again
 *   setStage(app, stage, now)       → the stage set by hand (it wins over emails before it), or cleared with null
 *   settle(app)                     → stage, reached and stageAt worked out from the events and the hand-set stage
 *   funnel(apps, now)               → how many reached each stage, how many moved on, and the rejections at each
 *   diagnose(apps, now)             → [{ tone, text }] where you're being cut, once there are enough outcomes
 *
 * An application is a log entry (store.addHistory): { id, date (first filled), url, host, title, filled, profile,
 * company, role, location, jobUrl, ats, jobId, events: [{ at, kind, detail, subject, from, quote, messageId }],
 * manual: { stage, at } (set by hand), stage, reached, stageAt, notes }. Stages go filled → applied → test →
 * interview → offer; 'rejected' and 'withdrawn' end one, keeping how far it got in `reached`. Pure: no storage, no
 * network; runs in the background, extension pages and Node.
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});

  const STAGES = ['filled', 'applied', 'test', 'interview', 'offer'];
  const OUTCOMES = ['rejected', 'withdrawn'];
  const LABELS = {
    filled: 'Filled',
    applied: 'Applied',
    test: 'Test',
    interview: 'Interview',
    offer: 'Offer',
    rejected: 'Rejected',
    withdrawn: 'Withdrawn',
  };
  // What each kind of email moves an application to.
  const TARGET = { received: 'applied', test: 'test', interview: 'interview', offer: 'offer', rejected: 'rejected' };
  const DAY = 24 * 3600 * 1000;
  // No reply this long after applying (and nothing since) is likely a silent rejection, counted apart.
  const SILENT_DAYS = 30;
  // Where you're being cut is said only once this many applications have an outcome.
  const ENOUGH = 5;
  const MAX_EVENTS = 30;
  const QUOTE = 240;

  const rank = (stage) => STAGES.indexOf(stage);
  const str = (v) => (v == null ? '' : String(v)).trim();
  const flat = (s) => str(s).replace(/\s+/g, ' ');
  /** Lower case, accents and punctuation gone, one space between words: "Lloyds Banking Group plc" → "lloyds banking group plc". */
  const fold = (s) =>
    String(s || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/['’‘`]/g, '')
      .replace(/&/g, ' and ')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  const compact = (s) => fold(s).replace(/ /g, '');
  /** Where `needle` stands in `hay` (both folded) as whole words. */
  const has = (hay, needle) => !!needle && ` ${hay} `.includes(` ${needle} `);

  /* ------------------------------------------------------------- employers */

  // Endings that are no part of an employer's name as its emails write it: "Jane Street Capital LLC" is "Jane Street".
  const LEGAL =
    /\s+(ltd|limited|plc|llp|llc|lp|inc|incorporated|corp|corporation|co|company|group|holdings|gmbh|ag|sa|sas|bv|nv|se|international|global|uk|us|usa|europe|emea)$/;
  const SOFT =
    /\s+(capital|partners|management|technologies|technology|securities|investments|advisors|advisers|labs|bank|banking|financial)$/;
  // One-word names that are everyday words: they count only written with a capital, or in the sender's address.
  const COMMON = new Set(
    'man arm one block square apple amazon meta oracle shell visa ford target next three via bank capital'.split(' '),
  );
  // Recruiting and assessment systems that send employers' emails for them: the employer is named in the email.
  const SYSTEMS =
    /(^|\.)(greenhouse\.io|greenhouse-mail\.io|lever\.co|ashbyhq\.com|myworkday\.com|myworkdayjobs\.com|workday\.com|smartrecruiters\.com|icims\.com|successfactors\.(com|eu)|sapsf\.(com|eu)|oraclecloud\.com|taleo\.net|jobvite\.com|workable\.com|workablemail\.com|teamtailor\.com|teamtailor-mail\.com|personio\.(de|com)|recruitee\.com|bamboohr\.com|breezy\.hr|pinpointhq\.com|beapplied\.com|eightfold\.ai|phenompeople\.com|avature\.net|tal\.net|oleeo\.com|cezanneondemand\.com|dayforcehcm\.com|ultipro\.com|ukg\.com|jazzhr\.com|rippling\.com|hibob\.com|gem\.com|goodtime\.io|hackerrank\.com|hackerrankforwork\.com|codility\.com|codesignal\.com|hirevue\.com|shl\.com|pymetrics\.(ai|com)|arcticshores\.com|cappfinity\.com|sovaassessment\.com|talogy\.com|testgorilla\.com|karat\.(com|io)|mettl\.com|harver\.com|cut-e\.com|wonderlic\.com|criteriacorp\.com|vervoe\.com|sonru\.com|modernhire\.com|tazio\.co\.uk|clevry\.com|aon\.com|amcat\.com|myamcat\.com|coderpad\.io|calendly\.com)$/i;
  // Hosts that are a recruiting system's, where the employer is the first label or the path's first part.
  const ATS_SLUG = [
    [/(^|\.)greenhouse\.io$/i, (u) => u.searchParams.get('for') || part(u, 0, /^(embed|jobs)$/)],
    [/^jobs\.(eu\.)?lever\.co$/i, (u) => part(u, 0)],
    [/^jobs\.ashbyhq\.com$/i, (u) => part(u, 0)],
    [/^(jobs|careers)\.smartrecruiters\.com$/i, (u) => part(u, 0)],
    [/^apply\.workable\.com$/i, (u) => part(u, 0)],
    [/^jobs\.jobvite\.com$/i, (u) => part(u, 0)],
    [/(^|\.)successfactors\.(com|eu)$|(^|\.)sapsf\.(com|eu)$/i, (u) => u.searchParams.get('company')],
    [/^careers-([a-z0-9-]+)\.icims\.com$/i, (u) => u.hostname.match(/^careers-([a-z0-9-]+)\./i)[1]],
    [
      /\.(myworkdayjobs\.com|myworkday\.com|teamtailor\.com|recruitee\.com|bamboohr\.com|pinpointhq\.com|breezy\.hr|tal\.net|avature\.net|icims\.com|workable\.com|personio\.(de|com))$/i,
      (u) => u.hostname.split('.')[0],
    ],
  ];

  /** The path's part at `i`, unless it is one of `skip`'s ("embed", "jobs"). */
  function part(u, i, skip) {
    const parts = u.pathname.split('/').filter(Boolean);
    const p = parts[i] || '';
    return skip && skip.test(p) ? '' : decodeURIComponent(p);
  }

  const urlOf = (s) => {
    try {
      return new URL(String(s || ''));
    } catch (err) {
      return null;
    }
  };

  /** The employer's slug in a recruiting system's address (boards.greenhouse.io/janestreet → "janestreet"), or ''. */
  function slugOf(url) {
    const u = urlOf(url);
    if (!u) return '';
    for (const [re, read] of ATS_SLUG)
      if (re.test(u.hostname)) {
        const s = str(read(u)).replace(/^(careers|jobs|www)-?/i, '');
        return /^(wd\d+|www|jobs|careers|apply|boards|job-boards)$/i.test(s) ? '' : compact(s);
      }
    return '';
  }

  /** "careers.janestreet.com" → "janestreet.com"; a recruiting system's host → ''. */
  function ownDomain(url) {
    const u = urlOf(url);
    if (!u || SYSTEMS.test(u.hostname) || ATS_SLUG.some(([re]) => re.test(u.hostname))) return '';
    const labels = u.hostname
      .toLowerCase()
      .replace(/^www\./, '')
      .split('.');
    const keep = labels.length > 2 && /^(co|com|org|ac|gov|net|ltd|plc)$/.test(labels[labels.length - 2]) ? 3 : 2;
    return labels.slice(-keep).join('.');
  }

  /**
   * An employer's name and the role from a page title, for an entry logged before either was kept: Greenhouse's "Job
   * Application for Software Engineer Intern at Jane Street", Lever's "Jane Street - Software Engineer Intern".
   */
  function fromTitle(title) {
    const t = flat(title);
    let m = t.match(
      /^(?:job application for |apply for |application for |apply to )?(.+?) at ([^|–—]+?)(?:\s*[|–—].*)?$/i,
    );
    if (m) return { role: m[1], company: m[2] };
    m = t.match(/^([^|–—-]{2,60}?)\s+[-–—|]\s+(.+)$/);
    return m ? { company: m[1], role: m[2] } : { company: '', role: '' };
  }

  /** An employer's name as its emails could write it: "Jane Street Capital LLC" → ["jane street capital", "jane street"]. */
  function nameForms(name) {
    let f = fold(name).replace(/^the /, '');
    const out = [f];
    // One ending at a time: "Lloyds Banking Group" is also "Lloyds Banking" and "Lloyds".
    for (let k = 0; k < 4; k++) {
      const next = LEGAL.test(f) ? f.replace(LEGAL, '') : f.replace(SOFT, '');
      if (next === f || !next) break;
      out.push((f = next));
    }
    return [...new Set(out.filter((x) => x.length >= 2))];
  }

  /**
   * Who an application is with: { company, role, slug (the recruiting system's or the site's label), forms (its names,
   * folded, of more than one word or one long uncommon word), caps (one-word names that count only capitalised: "Man",
   * "Arm"), domains }.
   */
  function employerOf(app) {
    const a = app || {};
    const titled = fromTitle(a.title);
    const company = flat(a.company) || flat(titled.company);
    const role = flat(a.role) || flat(titled.role);
    const slug = slugOf(a.url) || slugOf(a.jobUrl) || compact(str(a.atsCompany));
    const domains = [...new Set([ownDomain(a.url), ownDomain(a.jobUrl)].filter(Boolean))];
    const forms = [];
    const caps = [];
    for (const f of nameForms(company))
      if (f.includes(' ') || (f.length >= 4 && !COMMON.has(f))) forms.push(f);
      else if (f.length >= 2) caps.push(f);
    const label = domains.length ? domains[0].split('.')[0] : '';
    return { company: company || titleCase(slug || label), role, slug: slug || label, forms, caps, domains };
  }

  /** "janestreet" → "Janestreet": a slug as a name, when there is nothing better. */
  const titleCase = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');

  /**
   * Is a new fill another step of the application `a` logged? The same page within the hour (as before), the same job
   * id on the same site (Workday's steps keep it; SuccessFactors' session pages carry it in the form), or the same
   * employer and role within 14 days.
   */
  function sameApplication(a, b, now = Date.now()) {
    if (!a || !b) return false;
    const last = a.updatedAt || a.date || 0;
    if (a.url && a.url === b.url && now - last < 3600000) return true;
    if (a.jobId && b.jobId && a.host === b.host && String(a.jobId) === String(b.jobId)) return true;
    const x = employerOf(a);
    const y = employerOf(b);
    return (
      !!x.company &&
      !!x.role &&
      fold(x.company) === fold(y.company) &&
      fold(x.role) === fold(y.role) &&
      now - last < 14 * DAY
    );
  }

  /* ---------------------------------------------------------------- emails */

  const senderOf = (from) =>
    [].concat(from || []).map((f) => ({ name: flat(f && f.name), email: str(f && f.email).toLowerCase() }));
  const domainOf = (email) => String(email || '').split('@')[1] || '';
  /** Is an address a recruiting or assessment system's ("no-reply@us.greenhouse-mail.io", "…@hackerrankforwork.com")? */
  const fromSystem = (email) => SYSTEMS.test(domainOf(String(email || '').toLowerCase()));

  /** Where an employer's emails name them: the sender's name, address and the subject and text, folded. */
  function places(message) {
    const senders = senderOf(message.from);
    return {
      senders,
      name: fold(senders.map((s) => s.name).join(' ')),
      subject: fold(message.subject),
      text: fold(message.text || message.snippet || ''),
      raw: `${str(message.subject)}\n${str(message.text || message.snippet || '')}`,
    };
  }

  /** How strongly a message names an employer: 3 its sender, 2 its subject, 1 its text, 0 not at all. */
  function names(p, e) {
    let best = 0;
    for (const s of p.senders) {
      const [local, domain] = [s.email.split('@')[0], domainOf(s.email)];
      const label = domain.split('.').slice(0, -1).join('');
      const own = e.domains.some((d) => domain === d || domain.endsWith('.' + d));
      // Workday sends "lloydsbankinggroup@myworkday.com"; Greenhouse "no-reply@us.greenhouse-mail.io" names no one.
      const system = fromSystem(s.email) && !!e.slug && compact(local).startsWith(e.slug);
      const named = !!e.slug && e.slug.length >= 4 && label.split(/[.-]/).some((x) => x === e.slug);
      const domainNamed = e.forms.some((f) => f.length >= 4 && compact(label) === f.replace(/ /g, ''));
      if (own || system || named || domainNamed) best = 3;
    }
    const said = (hay) => e.forms.some((f) => has(hay, f));
    const capped = (raw) =>
      e.caps.some((c) =>
        new RegExp(`(^|[^\\p{L}\\p{N}])${c[0].toUpperCase()}${c.slice(1)}(?![\\p{L}\\p{N}])`, 'u').test(raw),
      );
    if (best < 3 && (said(p.name) || capped(p.senders.map((s) => s.name).join(' ')))) best = 3;
    if (best < 2 && (said(p.subject) || capped(str(p.raw.split('\n')[0])))) best = 2;
    if (best < 1 && (said(p.text) || capped(p.raw))) best = 1;
    return best;
  }

  /** Does the message name the role ("Software Engineer Intern", "2027 Summer Analyst")? */
  function namesRole(p, role) {
    const r = fold(role)
      .replace(/\b(19|20)\d\d\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return r.length >= 4 && (has(p.subject, r) || has(p.text, r));
  }

  // Words of an email about an application, in its subject: worth reading even from a sender no fill names.
  const NEWS_SUBJECT =
    /\b(application|applying|applied|candidate|candidacy|interview|assessment|online test|coding (test|challenge)|offer|next steps?|recruitment|your (submission|profile)|superday|assessment cent(re|er))\b/i;

  /**
   * Is a message (listed without its body) worth reading in full? Not one of yours; from a recruiting or assessment
   * system, or naming an employer you applied to, or with an application's words in its subject.
   */
  function worth(message, apps, { me = '' } = {}) {
    const p = places(message);
    const mine = str(me).toLowerCase();
    if (mine && p.senders.some((s) => s.email === mine)) return false;
    if (p.senders.some((s) => fromSystem(s.email))) return true;
    if ((apps || []).some((a) => names(p, employerOf(a)) > 0)) return true;
    return NEWS_SUBJECT.test(str(message.subject));
  }

  // Entities a mail body uses; others are rare enough to leave.
  const ENTITY = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    rsquo: '’',
    lsquo: '‘',
    ldquo: '“',
    rdquo: '”',
    ndash: '–',
    mdash: '—',
    hellip: '…',
    bull: '•',
  };
  // Where a reply's quote of the thread starts: "On Tue, 3 Nov 2026 at 09:12, Jane <…> wrote:", Outlook's "From: ".
  const QUOTED = /\n\s*(on .{6,120} wrote:|-{2,} ?original message ?-{2,}|from: .{2,120}\n\s*(sent|date): )/i;

  /** An email's HTML (or text) as plain text, without the earlier messages it quotes. */
  function plainText(html) {
    let s = String(html || '');
    if (/<[a-z!/]/i.test(s))
      s = s
        .replace(/<(style|script|head|title)\b[\s\S]*?<\/\1\s*>/gi, ' ')
        .replace(/<blockquote\b[\s\S]*?<\/blockquote\s*>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|tr|h[1-6]|table)\s*>/gi, '\n')
        .replace(/<[^>]+>/g, ' ');
    s = s
      .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (m, e) => {
        if (e[0] === '#') {
          const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
          return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
        }
        return ENTITY[e.toLowerCase()] != null ? ENTITY[e.toLowerCase()] : m;
      })
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n[\s]*/g, '\n')
      .trim();
    const cut = s.search(QUOTED);
    return (cut > 0 ? s.slice(0, cut) : s).slice(0, 8000);
  }

  /* -------------------------------------------------------------- classify */

  // A job board's or the firm's mailing, not news of an application: "New jobs for you", "Jobs you may be interested
  // in", a talent community's newsletter.
  const ALERT =
    /\b(new jobs? (for you|matching|that match)|jobs? (you may|you might|we think you('|’)?ll) (be interested|like)|job alerts?|recommended (jobs|roles|for you)|similar jobs|jobs near you|weekly digest|newsletter|talent community|talent network|join our talent|webinar|event invitation|register (now|today) for)\b/i;
  const ABOUT_YOURS = /\byour (application|candidacy|interview|assessment|test|offer)\b|\bapplication (for|to)\b/i;
  // Words that only say what may happen: "If successful, you will be invited to interview", "the process may include".
  const MAYBE =
    /\b(if (you are|you're|your application is|we|successful|shortlisted|selected|you progress)|should (you|your application) (be|progress)|may (be|include|involve|ask)|might|could include|our (process|recruitment process|hiring process) (includes|consists|involves|has)|the (process|next steps?) (includes?|consists|involves|will involve)|typically|usually|in the event)\b/i;

  const OFFER = [
    /\b(pleased|delighted|happy|thrilled|excited|glad) to (extend|make|confirm) (to you )?(an?|our|the|your) ((formal|conditional|verbal|written|full[- ]time|internship|summer|graduate|job|employment)\s+)*offer\b/i,
    /\b(pleased|delighted|happy|thrilled|excited|glad) to offer you (an? |the )?((summer|internship|graduate|full[- ]time|permanent|analyst|engineering)\s+)*(position|role|place|job|internship|employment|contract|opportunity to join)\b/i,
    /\b(offer of employment|employment offer|formal offer|conditional offer|offer letter|offer pack|contract of employment|we('d| would) like to offer you (a|the|an) (position|role|place|job|internship))\b/i,
  ];
  const NOT_OFFER =
    /\b(assessment|test|interview|superday|assessment (centre|center)|webinar|event|opportunity to (complete|take|attend|apply|interview))\b/i;
  const REJECT = [
    /\bregret(fully)? to (inform|advise|tell|let you know|say)\b/i,
    /\b(not|won['’]?t|will not|unable to|cannot|can['’]?t) (be )?(moving|progressing|proceeding|taking) (forward|further|ahead|on)\b/i,
    /\b(not|won['’]?t|will not|unable to|cannot|can['’]?t) (be )?(moving|progressing|proceeding|taking) (with )?(you|your (application|candidacy))\b/i,
    /\b(decided|chosen|opted) (not to (proceed|progress|move forward|continue)|to (pursue|progress|move forward with|proceed with|continue with) (other|another|different) (candidates?|applicants?))\b/i,
    /\b(position|role|vacancy|job|opening) (has|have) (now |already )?been filled\b/i,
    /\b(you were|you have been|you('|’)?ve been|your application (was|has been|is)|we have been|been) (unsuccessful|not successful|not selected)\b/i,
    /\b(not been|was not|were not|have not been|haven['’]t been) (selected|shortlisted|successful)\b/i,
    /\b(cannot|can['’]?t|are unable to|unable to|not able to|not in a position to) (offer you|invite you|progress your|move your application|take your application)\b/i,
    /\b(other candidates|candidates|applicants) (whose|who) (skills|experience|background|qualifications|profiles?)?\s*(more closely|better|most closely) (match|align|fit)/i,
    /\bno longer (being )?(considered|under consideration)\b/i,
    /\b(not|won['’]?t) be (offering you|inviting you|able to offer|able to invite|able to progress|able to move)\b/i,
    /\bunfortunately\b[^.]{0,120}\b(not (be )?(able|progress|proceed|mov|select|success|offer|invit)|unable|unsuccessful|other candidates|on this occasion|filled)\w*/i,
    /\bon this occasion\b[^.]{0,80}\b(not|unsuccessful|unable)\b|\b(not|unsuccessful|unable)\b[^.]{0,80}\bon this occasion\b/i,
  ];
  // An automatic or recorded interview, a test of its own: HireVue's, Sonru's, "complete a video interview".
  const RECORDED =
    /\b(hirevue|sonru|modern ?hire|willo|spark hire|one[- ]way|pre[- ]recorded|recorded (video )?interview|on[- ]demand (video )?interview|async(hronous)? (video )?interview|digital interview|video interview platform|(complete|record|submit) (a |an |your |the )?(digital |online |recorded )?video (interview|assessment|questions))\b/i;
  const TEST_NOUN =
    /\b((online|digital|coding|technical|numerical|verbal|logical|inductive|deductive|abstract|diagrammatic|situational judg(e)?ment|game[- ]based|psychometric|cognitive|aptitude|personality|behavioural|behavioral|reasoning|work style|job simulation|immersive|virtual)\s+(assessments?|tests?|challenges?|exercises?|questionnaires?|games?|tasks?|simulations?)|hackerrank|codility|codesignal|hirevue|shl|pymetrics|arctic shores|cappfinity|sova|talogy|watson[- ]glaser|test ?gorilla|criteria (corp|cognitive)|cut-e|amcat|mettl|harver|saville|kenexa|talent ?q|clevry|tazio|wonderlic|vervoe|karat|coderpad|assessments?|tests?|coding (challenge|exercise|task)|take[- ]home)\b/i;
  const TEST_ACTION =
    /\b(complete|completing|take|taking|start|begin|attempt|access|sit|play|record|invite|invited|inviting|invitation|link|deadline|reminder|remind|action required|expires?|expired|expiring|due|within \d+ (days|hours)|by (\d|(mon|tues|wednes|thurs|fri|satur|sun)day|tomorrow|midnight|the end)|before|hasn['’]t been completed|not yet (completed|started)|still (to )?complete|next step|next stage|progress(ed)? to)\b/i;
  const INTERVIEW = [
    /\b(invite|invitation|like|pleased|delighted|happy|keen) (you )?(to|for) (an? |the |your )?((first|second|third|final|next)[- ]round |phone |telephone |video |virtual |technical |in[- ]person |on[- ]?site |face[- ]to[- ]face |competency[- ]based |strengths[- ]based )*(interview|interviews|conversation with|call with|chat with)\b/i,
    /\binterview (invitation|invite|confirmation|confirmed|scheduling|scheduled|slots?|availability|details)\b/i,
    /\b(schedule|arrange|book|set up) (an? |your |the )?((first|second|final|next)[- ]round |phone |video |technical )?(interview|call|chat|conversation|time to (speak|talk|chat))\b/i,
    /\b(super ?day|assessment (centre|center|day)|final[- ]round interview|first[- ]round interview|phone screen|recruiter (call|screen)|hiring manager (interview|call))\b/i,
    /\b(availability|available) (for|to) (an? )?(interview|call|chat|speak)\b/i,
    /\bschedule a call with\b|\bcalendly\.com\b|\bgoodtime\.io\b/i,
    /\b(speak|talk|chat) (with|to) you (about|regarding) (your application|the (role|position|opportunity))\b/i,
  ];
  // Generic progress: an interview only when no test is named ("You have progressed to the next stage").
  // A test already taken: "Thank you for completing the online assessment" invites to nothing.
  const DONE =
    /\b(thank(s| you) for (completing|taking|submitting|sitting)|having (completed|taken)|(you('ve| have)|you) (completed|taken|submitted|passed)|following (your|the) (completion|online|recent))\b/i;
  // A rejection only said might happen: "If you are not successful, we will let you know", "Unsuccessful candidates
  // will be notified".
  const MAYBE_NOT =
    /\b(if (you are |you're |your application is |you were )?(not |un)successful|if (we are|we're) (unable|not able)|(unsuccessful|all) (candidates|applicants) will|should (you|your application) (not|be unsuccessful)|may not be able to (respond|reply|contact))\b/i;
  const NEXT =
    /\b(progress(ed)?|move(d)?|invite(d)?|through) (you )?(forward |on )?to the (next|following) (stage|round|step)\b/i;
  const RECEIVED = [
    /\bthank(s| you) (so much |very much )?for (your )?(applying|application|submitting|applying to|your interest in (applying|the|our))\b/i,
    /\b(we('ve| have)|has been|have been|we) (successfully )?received (your|the) (job )?application\b/i,
    /\b(your )?application (has been|was|is) (successfully )?(received|submitted|complete)\b/i,
    /\bapplication (received|submitted|confirmation)\b/i,
    /\bconfirm(ing)? (that )?(we have |we've )?(received|receipt of) your application\b/i,
  ];

  /** The sentences of an email: the body's, each cut at its end, then the subject (the body says it more fully). */
  function sentences(subject, text) {
    return [...String(text || '').split(/(?<=[.!?])\s+|\n+/), str(subject)]
      .map((s) => flat(s))
      .filter((s) => s.length > 3);
  }

  const quoteOf = (s) => (s.length > QUOTE ? `${s.slice(0, QUOTE - 1).replace(/\s+\S*$/, '')}…` : s);

  /** The first sentence a test of `fits` passes, or ''. */
  const first = (all, fits) => all.find(fits) || '';

  /** What kind of test an email asks for: 'video', 'coding', 'game' or 'assessment'. */
  function testDetail(s) {
    if (RECORDED.test(s) || /\bvideo\b/i.test(s)) return 'video';
    if (
      /\b(coding|hackerrank|codility|codesignal|karat|coderpad|technical (test|assessment|challenge)|take[- ]home|programming)\b/i.test(
        s,
      )
    )
      return 'coding';
    if (/\b(game[- ]based|games?\b|arctic shores|pymetrics)\b/i.test(s)) return 'game';
    return 'assessment';
  }

  /**
   * What an employer's email says about an application, from its sender, subject and text: 'offer', 'rejected',
   * 'interview', 'test' (an online assessment, a coding test, a recorded video interview; a reminder or a new link
   * too), 'received' (it was submitted), or null (a job alert, a newsletter, anything else). A rejection that mentions
   * the interview it follows is a rejection; "Unfortunately the link has expired: please complete your assessment with
   * this new link" is a test. → { kind, detail, quote (the sentence that says it) }.
   */
  function classify({ from, subject = '', text = '' } = {}) {
    const all = sentences(subject, text);
    const said = all.join('\n');
    const none = { kind: null, detail: '', quote: '' };
    if (!all.length) return none;
    // A job board's alert is never news, unless it is about your own application.
    if (ALERT.test(`${subject}\n${said.slice(0, 600)}`) && !ABOUT_YOURS.test(said)) return none;
    const sure = (s) => !MAYBE.test(s);
    const offer = first(all, (s) => OFFER.some((re) => re.test(s)) && !NOT_OFFER.test(s) && sure(s));
    if (offer) return { kind: 'offer', detail: '', quote: quoteOf(offer) };
    const reject = first(all, (s) => REJECT.some((re) => re.test(s)) && !MAYBE_NOT.test(s));
    if (reject) return { kind: 'rejected', detail: '', quote: quoteOf(reject) };
    const recorded = first(all, (s) => RECORDED.test(s) && sure(s));
    const interview = first(
      all,
      (s) =>
        INTERVIEW.some((re) => re.test(s)) &&
        sure(s) &&
        !(RECORDED.test(s) || (/\b(complete|record)\b/i.test(s) && /\bvideo\b/i.test(s))),
    );
    if (interview)
      return {
        kind: 'interview',
        detail: /super ?day|assessment (centre|center|day)/i.test(interview) ? 'assessment centre' : '',
        quote: quoteOf(interview),
      };
    const senders = senderOf(from);
    const platform = senders.some((s) =>
      /hackerrank|codility|codesignal|hirevue|shl\.com|pymetrics|arcticshores|cappfinity|sova|talogy|testgorilla|karat|mettl|harver|cut-e|wonderlic|criteriacorp|vervoe|sonru|modernhire|tazio|clevry|amcat/i.test(
        s.email,
      ),
    );
    const test =
      recorded ||
      first(all, (s) => TEST_NOUN.test(s) && TEST_ACTION.test(s) && !DONE.test(s) && sure(s)) ||
      (platform ? first(all, (s) => TEST_NOUN.test(s) || /\b(invit|challenge|assessment|test)\w*/i.test(s)) : '');
    if (test) return { kind: 'test', detail: testDetail(test), quote: quoteOf(test) };
    const next = first(all, (s) => NEXT.test(s) && sure(s));
    if (next) return { kind: 'interview', detail: '', quote: quoteOf(next) };
    const received = first(all, (s) => RECEIVED.some((re) => re.test(s)));
    if (received) return { kind: 'received', detail: '', quote: quoteOf(received) };
    return none;
  }

  /* ----------------------------------------------------------------- match */

  /**
   * Which application an email is about: the employer it names (its sender, then its subject, then its text), then,
   * when you applied to that employer more than once, the role it names. Only applications filled before it (with a
   * day's slack for clocks) count. Two applications at one firm and no role named is ambiguous: it is never put on the
   * first. → { id, why } | { ambiguous: [ids], why } | null.
   */
  function match(message, apps, { slack = DAY } = {}) {
    const p = places(message);
    const at = Number(message.at) || (Number(message.date) || 0) * 1000 || Date.now();
    const scored = [];
    for (const app of apps || []) {
      if (!app || (app.date || 0) - slack > at) continue;
      const e = employerOf(app);
      const score = names(p, e);
      if (score) scored.push({ app, e, score, key: fold(e.company) || e.slug });
    }
    if (!scored.length) return null;
    const top = Math.max(...scored.map((s) => s.score));
    const best = scored.filter((s) => s.score === top);
    const firms = [...new Set(best.map((s) => s.key))];
    const where = top === 3 ? 'its sender' : top === 2 ? 'its subject' : 'its words';
    if (firms.length > 1)
      return {
        ambiguous: best.map((s) => s.app.id),
        why: `${where} could be ${firms.length} employers you applied to`,
      };
    if (best.length === 1) return { id: best[0].app.id, why: `${best[0].e.company} named in ${where}` };
    const roles = best.filter((s) => namesRole(p, s.e.role));
    if (roles.length === 1)
      return { id: roles[0].app.id, why: `${roles[0].e.company} named in ${where}, and the role` };
    return {
      ambiguous: best.map((s) => s.app.id),
      why: `you applied to ${best[0].e.company} ${best.length} times and it doesn’t say which role`,
    };
  }

  /* ----------------------------------------------------------------- stages */

  /**
   * The stage, how far it got, and since when, from the events and a stage set by hand: an email never moves an
   * application backwards ("Thank you for applying" after an interview invitation changes nothing), a rejection ends
   * it where it got to, an offer after a rejection stands, and what you set wins over every email before it.
   */
  function settle(app) {
    const a = app || {};
    const m = a.manual && (STAGES.includes(a.manual.stage) || OUTCOMES.includes(a.manual.stage)) ? a.manual : null;
    let reached = 'filled';
    let outcome = null;
    let since = a.date || 0;
    if (m) {
      if (OUTCOMES.includes(m.stage)) {
        outcome = m.stage;
        reached = STAGES.includes(m.reached) ? m.reached : 'filled';
      } else reached = m.stage;
      since = m.at || since;
    }
    const events = (a.events || []).filter((e) => !e.ignored && (!m || e.at > m.at)).sort((x, y) => x.at - y.at);
    for (const e of events) {
      const t = TARGET[e.kind];
      if (t === 'rejected') {
        if (outcome !== 'withdrawn' && reached !== 'offer') {
          if (outcome !== 'rejected') since = e.at;
          outcome = 'rejected';
        }
      } else if (t && rank(t) > rank(reached)) {
        reached = t;
        if (!outcome || (t === 'offer' && outcome === 'rejected')) {
          since = e.at;
          if (t === 'offer') outcome = null;
        }
      }
    }
    return Object.assign(a, { stage: outcome || reached, reached, stageAt: since });
  }

  /** The application with an email's event recorded (once per message) and its stage worked out again. */
  function advance(app, event) {
    const a = { ...app, events: [...((app && app.events) || [])] };
    if (!event || !TARGET[event.kind]) return settle(a);
    if (event.messageId && a.events.some((e) => e.messageId === event.messageId)) return settle(a);
    a.events.push({
      at: Number(event.at) || Date.now(),
      kind: event.kind,
      detail: str(event.detail),
      subject: flat(event.subject).slice(0, 200),
      from: flat(event.from).slice(0, 160),
      quote: flat(event.quote).slice(0, QUOTE + 10),
      messageId: str(event.messageId),
    });
    a.events.sort((x, y) => y.at - x.at);
    a.events = a.events.slice(0, MAX_EVENTS);
    return settle(a);
  }

  /** The stage set by hand (it wins over the emails before it; later ones still move it on), or cleared with null. */
  function setStage(app, stage, now = Date.now()) {
    const a = { ...app };
    if (stage == null || stage === '') delete a.manual;
    else if (STAGES.includes(stage) || OUTCOMES.includes(stage)) {
      const before = settle({ ...app });
      a.manual = { stage, at: now, ...(OUTCOMES.includes(stage) ? { reached: before.reached } : {}) };
    }
    return settle(a);
  }

  /* ----------------------------------------------------------------- funnel */

  const isOpen = (a) => !OUTCOMES.includes(a.stage) && a.stage !== 'offer';
  /** The latest news of an application: its newest event's time, or when it was filled. */
  const lastNews = (a) => Math.max(a.date || 0, ...(a.events || []).filter((e) => !e.ignored).map((e) => e.at || 0));

  /** Applications still open with no news for SILENT_DAYS since they were filled: likely silent rejections. */
  const silent = (a, now) =>
    isOpen(a) && rank(a.reached || 'filled') <= rank('applied') && now - lastNews(a) >= SILENT_DAYS * DAY;

  /**
   * How far applications got: { total, stages: [{ stage, label, count, movedOn, share }], rejected: { screen, test,
   * interview, offer, total }, withdrawn, open, silent }. `count` is those that reached the stage, `movedOn` those of
   * them that went further (a rejection ends one where it got to).
   */
  function funnel(apps, now = Date.now()) {
    const list = (apps || []).map((a) => settle({ ...a })).filter((a) => a.stage !== 'withdrawn');
    const reached = (s) => list.filter((a) => rank(a.reached) >= rank(s)).length;
    const stages = STAGES.map((stage, i) => {
      const count = reached(stage);
      const next = STAGES[i + 1];
      const movedOn = next ? reached(next) : 0;
      return { stage, label: LABELS[stage], count, movedOn, share: count && next ? movedOn / count : null };
    });
    const rej = list.filter((a) => a.stage === 'rejected');
    const at = (stages) => rej.filter((a) => stages.includes(a.reached)).length;
    return {
      total: list.length,
      stages,
      rejected: {
        screen: at(['filled', 'applied']),
        test: at(['test']),
        interview: at(['interview']),
        total: rej.length,
      },
      offers: list.filter((a) => a.stage === 'offer').length,
      withdrawn: (apps || []).length - list.length,
      open: list.filter(isOpen).length,
      silent: list.filter((a) => silent(a, now)).length,
    };
  }

  const share = (n, d) => `${n} of ${d}`;

  /**
   * Where you're being cut, plainly, once ENOUGH applications have an outcome (a rejection, an offer, or a step past a
   * test or an interview): rejections before any test or interview point at the CV, after tests at the tests, after
   * interviews at the interviews. No reply after 30 days is said apart, never counted as a rejection.
   * → [{ tone: 'warn'|'ok'|'info', text }].
   */
  function diagnose(apps, now = Date.now()) {
    const f = funnel(apps, now);
    const list = (apps || []).map((a) => settle({ ...a })).filter((a) => a.stage !== 'withdrawn');
    const out = [];
    const reachedTest = list.filter((a) => rank(a.reached) >= rank('test'));
    const decided = list.filter(
      (a) => a.stage === 'rejected' || a.stage === 'offer' || rank(a.reached) >= rank('interview'),
    ).length;
    if (decided < ENOUGH) {
      out.push({
        tone: 'info',
        text: `Too few outcomes yet to say where you’re being cut: ${decided} so far. It says once ${ENOUGH} applications have a rejection, an offer or an interview.`,
      });
    } else {
      const r = f.rejected;
      if (r.total && r.screen / r.total >= 0.6 && r.screen >= 3)
        out.push({
          tone: 'warn',
          text: `${share(r.screen, r.total)} rejections came before any test or interview: your CV is the first thing to fix (Settings › Cover letters & AI › Check my CV), and a CV tailored to each job.`,
        });
      // Of those that sent a test and have decided since: how many didn't go further.
      const afterTest = reachedTest.filter((a) => a.stage === 'rejected' || rank(a.reached) > rank('test'));
      const cutAtTest = afterTest.filter((a) => a.stage === 'rejected' && a.reached === 'test');
      if (afterTest.length >= 3 && cutAtTest.length / afterTest.length >= 0.5) {
        const kinds = {};
        for (const a of cutAtTest) {
          const e = (a.events || []).find((x) => x.kind === 'test');
          const k = (e && e.detail) || 'assessment';
          kinds[k] = (kinds[k] || 0) + 1;
        }
        const named = {
          video: 'video interviews',
          coding: 'coding tests',
          game: 'game-based tests',
          assessment: 'online tests',
        };
        const which = Object.entries(kinds)
          .sort((x, y) => y[1] - x[1])
          .map(([k, n]) => `${n} after ${named[k] || 'tests'}`)
          .join(', ');
        out.push({
          tone: 'warn',
          text: `${share(cutAtTest.length, afterTest.length)} firms that sent you a test didn’t take you further (${which}): practise the tests (numerical and verbal reasoning, situational judgement, coding, recorded interviews) before the next ones.`,
        });
      }
      const interviewed = list.filter(
        (a) => rank(a.reached) >= rank('interview') && (a.stage === 'rejected' || a.stage === 'offer'),
      );
      const cutAtInterview = interviewed.filter((a) => a.stage === 'rejected');
      if (interviewed.length >= 3 && cutAtInterview.length / interviewed.length >= 0.5)
        out.push({
          tone: 'warn',
          text: `${share(cutAtInterview.length, interviewed.length)} interviews ended in a rejection: your CV and tests are getting you through, so practise interviews (your story, “Why us?”, technical questions).`,
        });
      if (!out.length)
        out.push({
          tone: 'ok',
          text: `No one stage stands out: of ${f.total} applications, ${f.stages[2].count} reached a test, ${f.stages[3].count} an interview and ${f.offers} an offer.`,
        });
    }
    if (f.silent)
      out.push({
        tone: 'info',
        text: `${f.silent} ${f.silent === 1 ? 'application has' : 'applications have'} had no reply for ${SILENT_DAYS} days or more: likely silent rejections, not counted above.`,
      });
    return out;
  }

  const tracker = {
    STAGES,
    OUTCOMES,
    LABELS,
    SILENT_DAYS,
    employerOf,
    sameApplication,
    slugOf,
    fromSystem,
    worth,
    plainText,
    classify,
    match,
    advance,
    setStage,
    settle,
    funnel,
    diagnose,
    silent,
    lastNews,
  };
  JTF.tracker = tracker;
  if (typeof module === 'object' && module.exports) module.exports = tracker;
})(typeof globalThis !== 'undefined' ? globalThis : this);
