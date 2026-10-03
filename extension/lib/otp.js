/*
 * JobToFill — reads verification emails: finds the one-time code (or the "verify your email" link) in a
 * message, and decides whether the message really belongs to the site that is asking for it.
 *
 * That second part is what makes filling codes automatically safe. A page that asks for "the code we
 * emailed you" gets a code only from an email sent by that site (same domain, the same applicant
 * tracking system, or an email that links back to it). A code from anyone else is never filled on its
 * own: a look-alike page can't collect your bank's login code just by showing a code box.
 *
 * Pure functions, no browser APIs: used by the background and the unit tests.
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});

  /* ---------------------------------------------------------------- text */

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', zwnj: '', zwj: '', shy: '' };

  function decode(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        try {
          return String.fromCodePoint(n);
        } catch (err) {
          return ' ';
        }
      }
      const v = ENTITIES[e.toLowerCase()];
      return v == null ? m : v;
    });
  }

  /** An email body as plain text, one block per line, plus its links ({ href, text }). */
  function readBody(body) {
    let html = String(body || '');
    const links = [];
    if (!/<[a-z!/][^>]*>/i.test(html)) {
      for (const m of html.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) links.push({ href: m[0], text: '' });
      return { text: html.replace(/\r/g, ''), links };
    }
    html = html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      // Preheader text and other hidden blocks repeat the code or carry unrelated numbers.
      .replace(/<([a-z][a-z0-9]*)\b[^>]*display\s*:\s*none[^>]*>([\s\S]{0,1500}?)<\/\1\s*>/gi, (m, tag, inner) => {
        // An unclosed hidden <p> runs into the next one: drop only the text up to that next tag.
        const next = inner.search(new RegExp(`<${tag}\\b`, 'i'));
        return next < 0 ? ' ' : ' ' + m.slice(m.indexOf('>') + 1 + next);
      });
    for (const m of html.matchAll(/<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi)) {
      const href = decode(m[2]).trim();
      if (/^https?:\/\//i.test(href)) links.push({ href, text: clean(decode(m[3].replace(/<[^>]+>/g, ' '))) });
    }
    const text = decode(
      html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|tr|td|th|h[1-6]|li|table|section|center|blockquote)\s*>/gi, '\n')
        .replace(/<[^>]+>/g, ' '),
    )
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/ *\n[ \n]*/g, '\n')
      .trim();
    return { text, links };
  }

  const clean = (s) =>
    String(s || '')
      .replace(/\s+/g, ' ')
      .trim();

  /* --------------------------------------------------------------- codes */

  // Words that introduce a code, in the languages job sites write in.
  const KEYWORD =
    /\b(code|passcode|pass code|otp|one[- ]?time|verification|verify|verifying|security|confirm|confirmation|authenti\w*|login|log-in|sign[- ]?in|pin|token|access)\b|bestätigungscode|sicherheitscode|einmalcode|code de (vérification|confirmation|sécurité)|código|codigo|codice|verificatiecode|beveiligingscode|weryfikacyjny|kod\b|验证码|認証コード|확인 코드|인증/i;
  const STRONG_KEYWORD =
    /\b(verification|security|confirmation|one[- ]?time|login|sign[- ]?in|access|authentication)\s+(code|pin|passcode)\b|\bpass ?code\b|\botp\b|\b(your|the|this) code\b|\bcode( is)?\s*:?\s*$|bestätigungscode|sicherheitscode|code de (vérification|confirmation)|código de (verificación|verificação|confirmación)|codice di verifica|verificatiecode|验证码/i;
  // Numbers that are something else: order numbers, phone numbers, prices, addresses, references.
  const NOT_A_CODE =
    /(order|invoice|receipt|ref(erence)?|ticket|case|account|acct|customer|member|requisition|req|job|id|no\.?|number|nr|#|phone|tel(ephone)?|mobile|call|fax|zip|post ?code|postal|suite|street|st\.|ave(nue)?|road|rd\.|box|unit|floor|room|reg(istered|istration)?( no)?|company|vat|tax|price|total|amount|usd|eur|gbp|chf|\$|£|€|¥)\s*[:.#-]?\s*$/i;
  const INSTRUCTION_AFTER =
    /^\s*(is|as|ist|est|es|è|is uw|jest)\s+(your|the|ihr|dein|votre|tu|su|il|uw|twój)?\s*\w*\s*(code|passcode|otp|pin|token)/i;

  /**
   * The likeliest one-time code in a message: { code, score } or null. `want` narrows the search to
   * what the page's box takes: { length, numeric }.
   */
  function findCode(message, want) {
    const w = want || {};
    const subject = clean(message.subject);
    const { text } = readBody(message.body || message.snippet || '');
    // Addresses and links carry long numbers (tracking ids) that are never the code.
    const scrub = (s) =>
      s
        .replace(/https?:\/\/\S+|www\.\S+/gi, (m) => ' '.repeat(m.length))
        .replace(/\S+@\S+\.\w+/g, (m) => ' '.repeat(m.length));
    const parts = [
      { text: scrub(subject), subject: true },
      { text: scrub(text), subject: false },
    ];
    const subjectHasKeyword = KEYWORD.test(subject);
    const found = new Map();

    for (const part of parts) {
      const s = part.text;
      const patterns = [
        /(?<![\w/.#$£€+-]|\d:)(\d{3}[ -]\d{3}|\d{4,8})(?![\w/%]|[.,:]\d|-\d)/g,
        /(?<![\w/.-])([A-Za-z0-9]{6,10})(?![\w/-])/g,
      ];
      for (const re of patterns) {
        for (const m of s.matchAll(re)) {
          const raw = m[1];
          const code = raw.replace(/[ -]/g, '');
          const alnum = /[A-Za-z]/.test(code);
          if (alnum && !/\d/.test(code)) continue;
          // A mixed-case code needs a capital, a small letter and a digit ("Ab3dEf9h"); "abc123" is a word.
          if (alnum && /[a-z]/.test(code) && !/[A-Z]/.test(code)) continue;
          if (w.numeric && alnum) continue;
          if (w.length && code.length !== w.length) continue;
          const at = m.index;
          const before = s.slice(Math.max(0, at - 90), at);
          const near = s.slice(Math.max(0, at - 30), at);
          const after = s.slice(at + raw.length, at + raw.length + 50);
          const lineStart = s.lastIndexOf('\n', at) + 1;
          const lineEnd = s.indexOf('\n', at) < 0 ? s.length : s.indexOf('\n', at);
          const line = s.slice(lineStart, lineEnd).trim();

          let score = 0;
          if (KEYWORD.test(before)) score += 3;
          if (KEYWORD.test(near)) score += 2;
          if (STRONG_KEYWORD.test(before)) score += 2;
          if (/[:：]\s*$|\bis\s*:?\s*$/i.test(before)) score += 1;
          if (INSTRUCTION_AFTER.test(after)) score += 5;
          if (/^\s*(to|for|and)\s+(confirm|verify|sign|log|complete|activate|continue|finish)/i.test(after)) score += 4;
          if (
            /\b(enter|use|type|input|paste|eingeben|saisissez|introduce|inserisci)\s*(this|the|code)?\s*:?\s*$/i.test(
              near,
            )
          )
            score += 2;
          if (/(promo|discount|coupon|voucher|gift|referral|offer)\s*(code)?\s*:?\s*$/i.test(before.slice(-30)))
            score -= 8;
          if (/^\s*(at checkout|for \d+ ?%|off\b|on your (next )?(order|purchase))/i.test(after)) score -= 8;
          if (line === raw) score += 2; // on a line of its own, usually in large type
          if (part.subject) score += subjectHasKeyword ? 3 : 1;
          else if (subjectHasKeyword) score += 1;
          score += code.length === 6 ? 2 : code.length === 8 ? 0.5 : code.length >= 4 ? 0.5 : 0;
          if (alnum) score -= /[a-z]/.test(code) ? 2.5 : 1.5;
          if (/^(19|20)\d\d$/.test(code)) score -= 5; // a year
          if (/^(\d)\1+$/.test(code)) score -= 2;
          if (NOT_A_CODE.test(before.slice(-25))) score -= 6;
          if (
            /^\s*(%|percent|minutes?|mins?|hours?|days?|seconds?|items?|people|applicants?|jobs?|positions?|st\b|nd\b|rd\b|th\b)/i.test(
              after,
            )
          )
            score -= 6;
          if (/[/.]\s*$/.test(before) || /^\s*[/.]\d/.test(after)) score -= 3; // a date or version
          const prev = found.get(code);
          found.set(code, prev ? { code, score: Math.max(prev.score, score) + 1 } : { code, score });
        }
      }
    }
    const best = [...found.values()].sort((a, b) => b.score - a.score)[0];
    return best && best.score >= 5 ? best : null;
  }

  /* --------------------------------------------------------------- links */

  const LINK_GOOD =
    /verif|confirm|activat|validat|complete (your )?registration|finish (signing|setting) up|bestätig|vérif|confirmer|verific|bevestig/i;
  const LINK_BAD =
    /unsubscribe|opt[- ]?out|preferences|privacy|terms|cookie|reset|forgot|help|support|contact|report|not you|didn['’]?t|abuse|feedback|survey|manage|settings|view (it )?(in|online)|browser|app ?store|google play|facebook|twitter|linkedin|instagram|youtube/i;

  // Links that approve something rather than confirm your address: opening one could let someone else in.
  const LINK_DANGER =
    /approve|authori[sz]e|allow|grant|deny|was (this|it) you|(sign|log)[- ]?in|login|session|device|unusual|suspicious|new (sign|log)|payment|transfer|delete|cancel|withdraw/i;

  /** The "verify your email" link in a message: { href, score } or null. */
  function findLink(message, pageHost) {
    const { text, links } = readBody(message.body || '');
    const subject = clean(message.subject);
    // Sign-in alerts ("Was this you? Approve") are never opened for you.
    if (
      /was (this|it) you|new (sign|log)[- ]?in|(sign|log)[- ]?in (attempt|request)|approve|unusual|suspicious/i.test(
        `${subject} ${text.slice(0, 2000)}`,
      )
    )
      return null;
    let best = null;
    for (const l of links) {
      let host;
      try {
        host = new URL(l.href).hostname;
      } catch (err) {
        continue;
      }
      const path = l.href.replace(/^https?:\/\/[^/]+/, '');
      if (LINK_BAD.test(l.text) || LINK_BAD.test(path) || LINK_DANGER.test(l.text) || LINK_DANGER.test(path)) continue;
      let score = 0;
      if (LINK_GOOD.test(l.text)) score += 4;
      if (LINK_GOOD.test(l.href)) score += 2;
      if (pageHost && sameFamily(site(host), site(pageHost))) score += 2;
      if (LINK_GOOD.test(subject)) score += 1;
      if (score >= 4 && (!best || score > best.score)) best = { href: l.href, score };
    }
    return best;
  }

  /* --------------------------------------------------------- whose email */

  /** The registrable part of a host name: careers.acme.co.uk -> acme.co.uk (good enough without the PSL). */
  function site(host) {
    const parts = String(host || '')
      .toLowerCase()
      .replace(/\.$/, '')
      .split('.');
    if (parts.length <= 2) return parts.join('.');
    const sld = parts[parts.length - 2];
    const tld = parts[parts.length - 1];
    const n = tld.length === 2 && /^(co|com|net|org|gov|edu|ac|ne|or|go|gob|nic|ltd|plc|sch)$/.test(sld) ? 3 : 2;
    return parts.slice(-n).join('.');
  }

  // Applicant tracking systems and sign-in services that serve pages on one domain and send mail from
  // another: [page domains, mail domains] (mail defaults to the page domains). Mail domains are only
  // matched against the sender, so a domain that hosts customer files never vouches for a page.
  // prettier-ignore
  const FAMILIES = {
    workday: [['myworkdayjobs.com', 'myworkdaysite.com', 'myworkday.com', 'workday.com'], ['myworkday.com', 'workday.com', 'myworkdayjobs.com']],
    successfactors: [['successfactors.com', 'successfactors.eu', 'sapsf.com', 'sapsf.eu', 'sapsf.cn', 'jobs2web.com'], ['successfactors.com', 'successfactors.eu', 'sapsf.com', 'sapsf.eu', 'sap.com']],
    oracle: [['oraclecloud.com', 'taleo.net'], ['oracle.com', 'oraclecloud.com', 'taleo.net']],
    icims: [['icims.com']],
    greenhouse: [['greenhouse.io']],
    lever: [['lever.co']],
    ashby: [['ashbyhq.com']],
    smartrecruiters: [['smartrecruiters.com'], ['smartrecruiters.com', 'smartrecruiters.net']],
    avature: [['avature.net', 'avature.com']],
    phenom: [['phenom.com', 'phenompeople.com']],
    eightfold: [['eightfold.ai']],
    jobvite: [['jobvite.com']],
    brassring: [['brassring.com', 'kenexa.com']],
    cornerstone: [['csod.com', 'cornerstoneondemand.com']],
    hirevue: [['hirevue.com']],
    hackerrank: [['hackerrank.com']],
    codility: [['codility.com']],
    microsoft: [['microsoft.com', 'microsoftonline.com', 'live.com', 'office.com']],
    google: [['google.com']],
  };
  const PAGE_FAMILY = new Map();
  const MAIL_FAMILY = new Map();
  for (const [name, [pages, mail]] of Object.entries(FAMILIES)) {
    for (const d of pages) PAGE_FAMILY.set(d, name);
    for (const d of mail || pages) MAIL_FAMILY.set(d, name);
  }
  const familyOf = (s) => PAGE_FAMILY.get(s) || null;
  const mailFamilyOf = (s) => MAIL_FAMILY.get(s) || null;
  const sameFamily = (a, b) => a === b || (!!familyOf(a) && familyOf(a) === mailFamilyOf(b));
  // Big sign-in providers: their pages host other people's forms (Google Forms, Microsoft Forms), so an
  // email from them never vouches for a page of theirs.
  const SHARED = new Set(['microsoft', 'google']);
  // Tracking systems that only give out subdomains to paying employers (acme.wd3.myworkdayjobs.com), so
  // the company name in one can be trusted. Free ones (anyone can make paypal.recruitee.com) are left out.
  const VETTED = new Set([
    'workday',
    'successfactors',
    'oracle',
    'icims',
    'avature',
    'phenom',
    'eightfold',
    'brassring',
    'cornerstone',
  ]);
  // Domains where anyone can publish a page under a subdomain: there, only the exact host counts.
  // prettier-ignore
  const HOSTED = new Set([
    'google.com', 'googleusercontent.com', 'appspot.com', 'web.app', 'firebaseapp.com', 'github.io', 'gitlab.io',
    'netlify.app', 'vercel.app', 'pages.dev', 'workers.dev', 'herokuapp.com', 'glitch.me', 'repl.co', 'replit.app',
    'wixsite.com', 'squarespace.com', 'weebly.com', 'wordpress.com', 'blogspot.com', 'notion.site', 'zendesk.com',
    'freshdesk.com', 'typeform.com', 'jotform.com', 'office.com', 'microsoftonline.com', 'live.com', 'sharepoint.com',
    'azurewebsites.net', 'cloudfront.net', 'amazonaws.com', 'windows.net', 'ngrok.io', 'ngrok-free.app', 'myshopify.com',
    'webflow.io', 'framer.app', 'carrd.co', 'hs-sites.com', 'recruitee.com', 'teamtailor.com', 'breezy.hr', 'bamboohr.com',
    'pinpointhq.com', 'personio.de', 'personio.com', 'workable.com', 'jobs.personio.de', 'medium.com', 'substack.com',
  ]);
  // Storage and compute hosts inside an otherwise trusted domain (Oracle Object Storage serves any file).
  const RAW_HOST = /(^|\.)(objectstorage|storage|compute|s3|blob|files?|static|cdn|usercontent)[.-]/i;

  // prettier-ignore
  const GENERIC = new Set([
    'www', 'careers', 'career', 'jobs', 'job', 'apply', 'login', 'auth', 'account', 'accounts', 'secure', 'app', 'my',
    'id', 'sso', 'portal', 'signin', 'signup', 'mail', 'email', 'noreply', 'reply', 'info', 'team', 'recruiting',
    'recruitment', 'talent', 'hr', 'eu', 'us', 'uk', 'com', 'net', 'org', 'io', 'co', 'hiring', 'external', 'global',
    'candidate', 'candidates', 'notifications', 'notification', 'support', 'verify', 'verification', 'web', 'online',
    'services', 'service', 'group', 'the', 'and', 'bank', 'home', 'site', 'sites', 'cloud', 'prod', 'fa', 'docs',
    'forms', 'form',
  ]);

  /** Words in a host name that name the company: acme.wd3.myworkdayjobs.com -> ['acme']. */
  function hostTokens(host) {
    const s = site(host);
    const shared = familyOf(s) || HOSTED.has(s);
    const labels = String(host || '')
      .toLowerCase()
      .split('.');
    const own = shared ? labels.slice(0, labels.length - s.split('.').length) : [s.split('.')[0]];
    return [...new Set(own.flatMap((l) => l.split(/[-_]+/)))].filter(
      (t) => t.length >= 3 && !GENERIC.has(t) && !/^(wd\d+|\d+|career\d+|[a-z]{1,2}\d+)$/.test(t),
    );
  }

  const hostOfUrl = (href) => {
    try {
      return new URL(href).hostname.toLowerCase();
    } catch (err) {
      return '';
    }
  };

  /**
   * How sure is it that `message` was sent by the site on `hosts` (the page, and the top page when it is
   * the same site)? 'strong': the same site, the same tracking system, the company's own domain behind a
   * vetted tracking system, or a link back to the page's site. On domains where anyone can publish a page
   * only the exact host counts, and Google's and Microsoft's own pages never match. 'weak': the company's
   * name only appears in it. 'none' otherwise.
   */
  function relevance(message, hosts) {
    const list = []
      .concat(hosts || [])
      .filter(Boolean)
      .map((h) => String(h).toLowerCase());
    const from = (message.from && message.from[0]) || {};
    const senderHost = (String(from.email || '').split('@')[1] || '').toLowerCase();
    const sender = site(senderHost);
    const { text, links } = readBody(message.body || '');
    const linkHosts = links.map((l) => hostOfUrl(l.href)).filter(Boolean);
    let weak = false;
    for (const host of list) {
      const page = site(host);
      const fam = familyOf(page);
      const tokens = hostTokens(host);
      if (fam && SHARED.has(fam)) {
        // Google Forms, Microsoft Forms: anyone's page. Never strong.
      } else if (HOSTED.has(page) || RAW_HOST.test(host)) {
        if (senderHost === host || linkHosts.includes(host)) return 'strong';
      } else {
        if (sender && sender === page) return 'strong';
        if (sender && fam && fam === mailFamilyOf(sender)) return 'strong';
        // acme.wd3.myworkdayjobs.com emailing from talent@acme.com.
        if (fam && VETTED.has(fam) && sender && !HOSTED.has(sender) && tokens.includes(sender.split('.')[0]))
          return 'strong';
        if (linkHosts.some((l) => site(l) === page)) return 'strong';
      }
      const words = clean(
        `${from.name || ''} ${senderHost} ${message.subject || ''} ${text.slice(0, 3000)}`,
      ).toLowerCase();
      if (tokens.some((t) => new RegExp(`(^|[^a-z0-9])${t}([^a-z0-9]|$)`).test(words))) weak = true;
    }
    return weak ? 'weak' : 'none';
  }

  /* ---------------------------------------------------------------- pick */

  /**
   * The code (or link) to use from a list of messages, newest first.
   *   kind: 'code' | 'link'; hosts: the page's host names; since: ms, ignore older mail;
   *   want: { length, numeric }; used: message ids already used; explicit: the person asked for it, so
   *   take the newest code even when its sender can't be matched to the page.
   * Returns { code | link, id, from, subject, date, relevance } or null.
   */
  function pick(messages, { kind = 'code', hosts, since = 0, want, used, explicit = false } = {}) {
    const seen = new Set(used || []);
    const list = (messages || [])
      .filter((m) => m && m.id && !seen.has(m.id) && (m.date || 0) * 1000 >= since)
      .sort((a, b) => (b.date || 0) - (a.date || 0));
    let fallback = null;
    for (const m of list) {
      const rel = relevance(m, hosts);
      const found = kind === 'link' ? findLink(m, [].concat(hosts || [])[0]) : findCode(m, want);
      if (!found) continue;
      const from = (m.from && m.from[0]) || {};
      const out = {
        id: m.id,
        from: from.name ? `${from.name} <${from.email || ''}>` : from.email || '',
        subject: clean(m.subject),
        date: (m.date || 0) * 1000,
        relevance: rel,
      };
      if (kind === 'link') out.link = found.href;
      else out.code = found.code;
      if (rel === 'strong') return out;
      if (!fallback && (rel === 'weak' || explicit)) fallback = out;
    }
    return fallback;
  }

  const otp = { readBody, findCode, findLink, site, hostTokens, relevance, pick, familyOf };
  JTF.otp = otp;
  if (typeof module === 'object' && module.exports) module.exports = otp;
})(typeof globalThis !== 'undefined' ? globalThis : this);
