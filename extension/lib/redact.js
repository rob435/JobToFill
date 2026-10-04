/*
 * JobToFill — takes a person's details out of text, for the page snapshots a bug report carries
 * (content/snapshot.js, and the background's last pass over the saved file). Built from the profile: names,
 * email, phone, address, postcode, date of birth, links, document file names, employers and longer written
 * answers, each replaced by a placeholder ("[first name]", "[email]"). Matching ignores case, accents, spacing
 * and the punctuation pages put into phone numbers ("+1 (415) 555-0100"); when in doubt it redacts, so a first
 * name that is also a word ("Will") goes wherever the word is. City, country, school and degree names stay: they
 * are the option lists a form is made of.
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});

  // Where a word-like detail (a name, a handle) starts and ends. In text a name is a whole word ("Ada", never the
  // "ada" in "Canada"); in class names, ids and CSS a whole token, so the name Max leaves "max-width" alone.
  const EDGES = {
    text: ['(?<![\\p{L}\\p{N}])', '(?![\\p{L}\\p{N}])'],
    ident: ['(?<![\\p{L}\\p{N}_-])', '(?![\\p{L}\\p{N}_-])'],
  };
  const BEFORE = EDGES.text[0];
  const AFTER = EDGES.text[1];
  // Parts of a name too common to blank out on their own ("van der Berg": only "Berg").
  // prettier-ignore
  const PARTICLES = new Set([
    'van', 'von', 'der', 'den', 'del', 'della', 'des', 'dos', 'das', 'bin', 'ibn', 'ter', 'ten', 'mac', 'san',
  ]);
  // A written answer is found sentence by sentence (a review page shows it split into paragraphs).
  const MIN_SENTENCE = 25;
  const MAX_SENTENCES = 200;
  const LABELS = {
    resume: '[resume file]',
    coverLetter: '[cover letter file]',
    transcript: '[transcript file]',
  };

  const clean = (s) =>
    String(s == null ? '' : s)
      .replace(/\s+/g, ' ')
      .trim();
  const escapeChar = (c) => (/[.*+?^${}()|[\]\\/]/.test(c) ? '\\' + c : c);
  const exact = (s) => Array.from(String(s), escapeChar).join('');

  /**
   * A pattern for `s` that also matches it as pages write it: any case (the regex flag), any run of spaces, curly
   * or no apostrophes (O'Brien, O’Brien), a hyphen as a space or nothing (Smith-Jones, Smith Jones), underscores
   * for spaces (Ada_Lovelace_CV.pdf), and letters with or without their accents (José, Jose).
   */
  function literal(s, space) {
    let out = '';
    for (const c of clean(s)) {
      if (/['’‘`´]/.test(c)) out += "['’‘`´]?";
      else if (/[-‐‑–—]/.test(c)) out += '[-‐‑–—\\s]?';
      else if (c === ' ') out += space || '[\\s_]+';
      else if (c === '_') out += '[_\\s]+';
      else {
        const base = c.normalize('NFD').replace(/\p{M}/gu, '');
        out += base && base !== c ? `(?:${escapeChar(c)}|${escapeChar(base)}\\p{M}*)` : escapeChar(c);
      }
    }
    return out;
  }

  /** A name and, when it has several parts, each distinctive part on its own ("Mary Ann", "Smith-Jones"). */
  function nameParts(value) {
    const v = clean(value);
    if (v.length < 2) return [];
    const words = v.split(/[\s\-‐‑–—]+/);
    const parts = words.filter((p) => p.length >= 3 && !PARTICLES.has(p.toLowerCase()));
    return words.length > 1 ? [v, ...parts] : [v];
  }

  /**
   * A phone number however the page writes it: its digits in order with spaces, dots, dashes, slashes or
   * brackets between them, with or without a country code ("+44", "0044", "1") and the trunk 0 ("(0)7700").
   */
  function phonePattern(phone, code) {
    const raw = String(phone || '');
    const digits = raw.replace(/\D/g, '');
    const cc = String(code || '').replace(/\D/g, '');
    const cores = new Set();
    const add = (d) => {
      const core = d.replace(/^0+/, '');
      if (core.length >= 6) cores.add(core);
    };
    add(digits);
    if (cc && digits.startsWith(cc)) add(digits.slice(cc.length));
    // "+44 7700 900123" kept with its country code but no separate code: the code is one to three digits.
    if (/^\s*(\+|00)/.test(raw)) for (let k = 1; k <= 3; k++) add(digits.replace(/^00/, '').slice(k));
    if (!cores.size) return null;
    const sep = '[\\s().\\-/\\u00a0]{0,3}';
    const body = [...cores]
      .sort((a, b) => b.length - a.length)
      .map((core) => core.split('').join(sep))
      .join('|');
    return `(?<!\\d)(?:(?:(?:\\+|00)${sep})?(?:\\d${sep}){1,3})?(?:\\(?0\\)?${sep})?\\(?(?:${body})(?!\\d)`;
  }

  /** A date of birth as numbers in any order pages use (1990-12-10, 10/12/1990, 12.10.1990) or with its month's name. */
  function datePattern(value) {
    const U = JTF.util;
    const d = U && U.parseDate ? U.parseDate(value) : null;
    if (!d || !d.day || !d.month) return null;
    const sep = '[\\s/.\\-]{1,2}';
    const D = `0?${d.day}`;
    const M = `0?${d.month}`;
    const Y = String(d.year);
    const name = U.monthName(d.month);
    const month = `(?:${name}|${name.slice(0, 3)}${name === 'september' ? 't?' : ''}\\.?)`;
    const nth = '(?:st|nd|rd|th)?';
    const forms = [
      `${Y}${sep}${M}${sep}${D}`,
      `${D}${sep}${M}${sep}${Y}`,
      `${M}${sep}${D}${sep}${Y}`,
      `${D}${nth}\\s*(?:of\\s+)?${month},?\\s*${Y}`,
      `${month}\\s*${D}${nth},?\\s*${Y}`,
    ];
    return `(?<!\\d)(?:${forms.join('|')})(?!\\d)`;
  }

  /** A link with or without its scheme and www., slashes plain or URL-encoded; and its handle (the last path part). */
  function linkPatterns(url) {
    const core = clean(url)
      .replace(/^[a-z][\w+.-]*:\/\//i, '')
      .replace(/^www\./i, '')
      .replace(/[/?#]+$/, '');
    if (core.length < 4) return null;
    const slash = '(?:/|%2F)';
    const pattern =
      `(?:https?(?::|%3A)${slash}{2})?(?:www\\.)?` +
      core
        .split('/')
        .map((p) => literal(p))
        .join(slash) +
      `${slash}?`;
    const path = core.split(/[?#]/)[0].split('/').filter(Boolean);
    const handle = path.length > 1 ? path[path.length - 1].replace(/^@/, '') : '';
    return { url: `${BEFORE}${pattern}(?![\\p{L}\\p{N}_-])`, handle: handle.length >= 3 ? handle : null };
  }

  /** "Analytical Engines Inc" and "Analytical Engines". */
  function employerNames(company) {
    const c = clean(company);
    if (c.length < 3) return [];
    const core = c.replace(
      /[\s,]+(inc|incorporated|ltd|limited|llc|llp|plc|gmbh|corp|corporation|co|company|sa|ag|bv|pty)\.?$/i,
      '',
    );
    return core !== c && core.length >= 4 ? [c, core] : [c];
  }

  /** The sentences of the longer things a person writes (summary, cover letter, answers), long ones first. */
  function sentences(texts) {
    const out = new Set();
    for (const t of texts)
      for (const s of String(t || '').split(/(?<=[.!?;])\s+|\s*\n\s*/))
        if (clean(s).length >= MIN_SENTENCE) out.add(clean(s));
    return [...out].sort((a, b) => b.length - a.length).slice(0, MAX_SENTENCES);
  }

  const escapeHtml = (s) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /**
   * The redactor for one person. `extra`: { files: [{ which, name }] (the documents a fill uploads), usernames,
   * secrets (passwords: matched exactly, also as HTML writes them) }. Returns:
   *   text(s)    page text and attribute values
   *   ident(s)   class names, ids and CSS: names only as whole tokens, placeholders without spaces
   *   strict(s)  serialized HTML: only the details that can't be mistaken for markup (no names: "Mark" is a tag)
   */
  function redactor(profile, extra) {
    const p = profile || {};
    const personal = p.personal || {};
    const contact = p.contact || {};
    const address = p.address || {};
    const more = extra || {};
    // { source, label, word (needs EDGES), strict (also in serialized HTML), long (written answers) }
    const terms = [];
    const add = (source, label, flags) => source && terms.push(Object.assign({ source, label }, flags));

    for (const s of sentences([
      p.summary,
      p.coverLetter,
      ...(p.experience || []).map((e) => e && e.description),
      ...(p.customAnswers || []).map((a) => a && a.answer),
      p.compliance && p.compliance.relativesDetails,
      p.compliance && p.compliance.governmentDetails,
      p.job && p.job.adjustments,
      p.job && p.job.otherOffers,
    ]))
      add(literal(s), '[your text]', { long: true });

    // Your email and your university's.
    for (const email of [clean(contact.email), clean(contact.schoolEmail)]) {
      if (!email.includes('@')) continue;
      add(`(?<![\\p{L}\\p{N}._%+-])${exact(email).replace('@', '(?:@|%40)')}${AFTER}`, '[email]', { strict: true });
      // "Signed in as ada.lovelace90": the part before the @ when it is distinctive enough.
      const local = email.split('@')[0];
      if (local.length >= 4 && (local.length >= 6 || /[._\d-]/.test(local)))
        add(literal(local), '[email]', { word: true });
    }
    const links = Object.entries(p.links || {}).filter(([, v]) => clean(v));
    const handles = [];
    for (const [key, value] of links) {
      const l = linkPatterns(value);
      if (!l) continue;
      add(l.url, `[${key}]`, { strict: true });
      if (l.handle) handles.push([l.handle, `[${key}]`]);
    }
    for (const f of more.files || []) {
      const name = clean(f && f.name);
      if (name.length < 3) continue;
      const label = LABELS[f.which] || '[file]';
      add(`${BEFORE}${literal(name)}${AFTER}`, label, { strict: true });
      const base = name.replace(/\.[a-z0-9]{1,5}$/i, '');
      if (base !== name && base.length >= 4 && /[\s_.\-\d]/.test(base)) add(literal(base), label, { word: true });
    }
    for (const u of more.usernames || []) {
      const name = clean(u);
      if (name.length >= 3) add(`${BEFORE}${literal(name)}${AFTER}`, '[username]', { strict: true });
    }
    for (const s of more.secrets || []) {
      const secret = String(s || '');
      if (secret.length >= 4)
        add([...new Set([secret, escapeHtml(secret)])].map(exact).join('|'), '[password]', { strict: true });
    }
    add(phonePattern(contact.phone, contact.phoneCountryCode), '[phone]', { strict: true });
    add(datePattern(personal.dob), '[date of birth]', { strict: true });
    if (clean(address.line1).length >= 3)
      add(`${literal(address.line1, '[\\s,]+')}\\.?`, '[address]', { word: true, strict: true });
    if (clean(address.line2).length >= 3)
      add(`${literal(address.line2, '[\\s,]+')}\\.?`, '[address line 2]', { word: true, strict: true });
    const postcode = clean(address.postalCode).replace(/[\s-]+/g, '');
    if (postcode.length >= 3)
      add(Array.from(postcode, escapeChar).join('[\\s-]?'), '[postcode]', { word: true, strict: true });
    for (const e of [...(p.experience || []).map((x) => x && x.company), p.job && p.job.currentCompany])
      for (const name of employerNames(e)) add(literal(name), '[employer]', { word: true });
    const names = [
      [personal.firstName, '[first name]'],
      [personal.lastName, '[last name]'],
      [personal.middleName, '[middle name]'],
      [personal.preferredName, '[preferred name]'],
    ];
    for (const [value, label] of names) for (const part of nameParts(value)) add(literal(part), label, { word: true });
    for (const [handle, label] of handles) add(literal(handle), label, { word: true });

    return {
      text: build(terms, 'text'),
      ident: build(
        terms.filter((t) => !t.long),
        'ident',
      ),
      strict: build(
        terms.filter((t) => t.strict),
        'text',
      ),
      size: terms.length,
    };
  }

  /** One pass over a string: the first term (in the order added) that matches at a place wins. */
  function build(terms, mode) {
    if (!terms.length) return (s) => s;
    const [before, after] = EDGES[mode];
    const re = new RegExp(
      terms.map((t) => `(${t.word ? `${before}(?:${t.source})${after}` : t.source})`).join('|'),
      'giu',
    );
    const labels = terms.map((t) =>
      mode === 'ident' ? 'redacted-' + t.label.slice(1, -1).replace(/\s+/g, '-') : t.label,
    );
    return (s) => {
      if (typeof s !== 'string' || !/[\p{L}\p{N}]/u.test(s)) return s;
      return s.replace(re, (...m) => {
        for (let i = 1; i <= labels.length; i++) if (m[i] !== undefined) return labels[i - 1];
        return m[0];
      });
    };
  }

  JTF.redact = { redactor, literal };
  if (typeof module === 'object' && module.exports) module.exports = JTF.redact;
})(typeof globalThis !== 'undefined' ? globalThis : this);
