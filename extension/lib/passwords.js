/*
 * JobToFill — passwords and payment cards, the password generator and the rules sign-up pages state.
 *
 * Kept as plain JSON in storage.local "passwords" (like the AI keys, and in the backup file with them):
 *   { version: 1, defaultPassword, defaultCardId,
 *     credentials: [{ id, host, portal?, username, password, note, createdAt, updatedAt, previousPassword? }],
 *     cards: [{ id, label, name, number, expMonth, expYear, cvc }] }
 * Only the background hands them to a page: during a fill you started, on HTTPS, into visible fields.
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});

  const KEY = 'passwords';

  function emptyData() {
    return { version: 1, defaultPassword: '', credentials: [], cards: [], defaultCardId: null };
  }

  /* ---------------------------------------------------------------- passwords */

  const SETS = {
    lower: 'abcdefghijkmnopqrstuvwxyz',
    upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
    digits: '23456789',
    symbols: '!@#$%^&*-_=+?',
  };

  function randomInt(max) {
    // Rejection sampling keeps every character equally likely.
    const limit = Math.floor(0x100000000 / max) * max;
    const buf = new Uint32Array(1);
    let x;
    do {
      root.crypto.getRandomValues(buf);
      x = buf[0];
    } while (x >= limit);
    return x % max;
  }

  /* ------------------------------------------------------------ password rules */

  // "at least eight characters": numbers sites spell out.
  // prettier-ignore
  const NUMBER_WORDS = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
    thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, eighteen: 18, twenty: 20, thirty: 30,
  };
  const N = `(\\d{1,3}|${Object.keys(NUMBER_WORDS).join('|')})`;
  const num = (w) => (/^\d+$/.test(w) ? +w : NUMBER_WORDS[w] || 0);
  const SYMBOL_WORD = /\b(special|symbols?|punctuation|non ?alpha ?numeric|non ?alphanumeric)\b/;
  const DIGIT_WORD = /\b(numbers?|numerals?|numeric|digits?)\b(?! of\b)/;
  const REPEATS = /\b(consecutive|identical|repeated|repeating|same|in a row)\b/;
  const NEGATED =
    /\b(must not|mustn t|cannot|can not|can t|may not|should not|shouldn t|not be|not contain|no|without|do not|don t|isn t|is not|are not|not allowed)\b/;
  const ASKS = /\b(at least|must (contain|include|have|use)|requires?|required|one|1|a mix)\b/;

  /** The punctuation a clause lists after "special characters:", "(", "such as": "!@#$%^&*". */
  function listedSymbols(clause) {
    const m = clause.match(/(?:[:(]|\bsuch as\b|\be\.?g\.?|\blike\b|\bincluding\b|\bfollowing\b)([^:(]*)$/i);
    if (!m) return '';
    const tail = m[1].replace(/\b(and|or|etc)\b\.?/gi, ' ');
    if (/[\p{L}\p{N}]/u.test(tail)) return '';
    let chars = [...new Set(tail.replace(/[\s,]/g, ''))];
    if (/\(/.test(clause.slice(0, clause.length - m[1].length)) && chars[chars.length - 1] === ')')
      chars = chars.slice(0, -1);
    return chars.length >= 2 ? chars.join('') : '';
  }

  /**
   * What a sign-up page says its password must be, from the text around the box (help text, a requirements
   * list) and the box's own minlength / maxlength / pattern. SuccessFactors: "Password must be at least 8
   * characters long. Password must not be longer than 18 characters. Password must contain at least one upper
   * case and one lower case letter. Password must contain at least one number or punctuation character.
   * Password must not contain space or unicode characters." -> { minLength: 8, maxLength: 18, upper, lower,
   * digitOrSymbol, noSpaces, ascii }.
   */
  function parseRules(input) {
    const src = input || {};
    const rules = {
      minLength: 0,
      maxLength: 0,
      upper: false,
      lower: false,
      digit: false,
      symbol: false,
      digitOrSymbol: false,
      symbols: 'any', // 'any', 'none', or the special characters the page lists
      forbidden: '',
      noSpaces: false,
      ascii: false,
      maxRepeat: 0,
      startLetter: false,
      noPersonal: false,
      pattern: String(src.pattern || ''),
    };
    const raw = String(src.text || '')
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .slice(0, 4000);
    // One requirement per clause: sentences, list items, lines.
    const clauses = raw
      .split(/[\n\r•·▪●✓✔✗✘]+|(?<=[A-Za-z0-9)])\.\s+|;\s*|(?=\b[Pp]assword (?:must|should|cannot|may not|needs)\b)/)
      .map((c) => c.trim())
      .filter(Boolean);
    const longer = (n) => (rules.maxLength = rules.maxLength ? Math.min(rules.maxLength, n) : n);
    for (const clause of clauses) {
      const t = clause
        .toLowerCase()
        .replace(/[^\p{L}\p{N}+]+/gu, ' ')
        .trim();
      const negated = NEGATED.test(t);
      const lengthy = /\b(characters?|chars?|long|length)\b/.test(t) && !REPEATS.test(t);
      // Length: "between 8 and 64 characters", "8-20 characters", "at least 8", "8 or more", "no more than 18".
      let m = t.match(new RegExp(`\\b${N} (?:and |to |or )?${N} (characters?|chars?)\\b`));
      if (m && num(m[1]) >= 4 && num(m[1]) < num(m[2])) {
        rules.minLength = Math.max(rules.minLength, num(m[1]));
        longer(num(m[2]));
      }
      if (lengthy) {
        m = t.match(
          new RegExp(
            `\\b(at least|minimum(?: of)?|min|(?<!(?:no|not|not be) )(?:more|longer) than|no (?:fewer|less|shorter) than|not (?:be )?(?:shorter|less) than) ${N}\\b`,
          ),
        );
        if (m && !(negated && /^(more|longer)/.test(m[1]))) {
          const n = num(m[2]) + (/^(more|longer)/.test(m[1]) ? 1 : 0);
          if (n >= 4 && n <= 128) rules.minLength = Math.max(rules.minLength, n);
        }
        m = t.match(new RegExp(`\\b${N} ?(?:\\+|or more\\b|(?:characters?|chars?) (?:minimum|min|or more)\\b)`));
        if (m && num(m[1]) >= 4 && num(m[1]) <= 128) rules.minLength = Math.max(rules.minLength, num(m[1]));
        m = t.match(
          new RegExp(
            `\\b(at most|maximum(?: of)?|max|no (?:more|longer) than|not (?:be )?(?:more|longer) than|up to|exceed|(?<!no )(?:fewer|less) than) ${N}\\b`,
          ),
        );
        if (m) {
          const n = num(m[2]) - (/(fewer|less) than$/.test(m[1]) ? 1 : 0);
          if (n >= 4 && n <= 256) longer(n);
        }
      }
      // Repeated characters: "no more than 2 identical characters in a row", "cannot contain 3 consecutive…".
      if (REPEATS.test(t)) {
        m = t.match(
          new RegExp(
            `\\b(?:no more than|not more than|at most|maximum(?: of)?|max|more than) ${N} (?:\\w+ )?${REPEATS.source}`,
          ),
        );
        const n = m ? num(m[1]) : 0;
        m = t.match(
          new RegExp(
            `\\b(?:cannot|can t|must not|may not|should not) (?:contain|have|use|include) ${N} (?:or more )?(?:\\w+ )?${REPEATS.source}`,
          ),
        );
        if (n) rules.maxRepeat = n;
        else if (m && num(m[1]) >= 2) rules.maxRepeat = num(m[1]) - 1;
        else if (negated && /\b(characters?|letters?)\b/.test(t)) rules.maxRepeat = 1;
      }
      if (
        /\b(begin|start)s? with (a |an )?letter\b/.test(t) ||
        /\b(cannot|can t|must not|may not) (begin|start) with (a )?(number|digit|special|symbol)/.test(t)
      )
        rules.startLetter = true;
      if (
        /\b(must not|cannot|can t|may not|should not) (contain|include|use|be|match)( your)? (\w+ ){0,2}(name|user ?name|e ?mail|login)\b/.test(
          t,
        )
      )
        rules.noPersonal = true;
      if (/\bspaces?\b|\bwhite ?space\b|\bblanks?\b/.test(t) && negated) rules.noSpaces = true;
      if (/\bunicode\b|\bnon ascii\b|\bascii\b|\baccent(s|ed)?\b/.test(t) && (negated || /\bonly\b/.test(t)))
        rules.ascii = true;
      // Characters it names as not allowed: "cannot contain the following characters: < > &", "< and > are not allowed".
      const forbiddenRun =
        clause.match(
          /(?:cannot|can't|must not|may not|should not|do not|don't)\s+(?:contain|include|use)\b[^:]*?:\s*(.+)$/i,
        ) ||
        clause.match(
          /((?:[^\p{L}\p{N}\s,.]\s*(?:,|and|or)?\s*){1,20})\s*(?:are|is)\s+not\s+(?:allowed|permitted|accepted|supported)/iu,
        );
      const forbidden = forbiddenRun ? [...forbiddenRun[1]].filter((ch) => /[^\p{L}\p{N}\s,]/u.test(ch)) : [];
      for (const ch of forbidden) if (!rules.forbidden.includes(ch)) rules.forbidden += ch;
      // No special characters at all: "letters and numbers only", "special characters are not allowed".
      if (
        !forbidden.length &&
        ((SYMBOL_WORD.test(t) && negated && !ASKS.test(t)) ||
          /\b(letters and (numbers|digits) only|only (letters and (numbers|digits)|alpha ?numeric)|alpha ?numeric( characters)? only)\b/.test(
            t,
          ))
      )
        rules.symbols = 'none';
      if (negated && !ASKS.test(t)) continue;
      // The special characters it lists: "one special character (!@#$%^&*)".
      const listed = SYMBOL_WORD.test(t) ? listedSymbols(clause) : '';
      if (listed && rules.symbols !== 'none') rules.symbols = listed;
      // The kinds of character it asks for. "One number or punctuation character" is either.
      const either =
        DIGIT_WORD.test(t) &&
        SYMBOL_WORD.test(t) &&
        /\b(numbers?|digits?|numeric|numerals?) or (a |one )?(special|symbols?|punctuation|non)|\b(special|symbols?|punctuation)( characters?)? or (a |one )?(numbers?|digits?|numeric)/.test(
          t,
        );
      if (/\bupper ?case\b|\bcapital\b|\bupper\b/.test(t)) rules.upper = true;
      if (/\blower ?case\b|\blower\b|\bsmall letters?\b/.test(t)) rules.lower = true;
      if (either) rules.digitOrSymbol = true;
      else {
        if (DIGIT_WORD.test(t) && !/\b(phone|mobile)\b/.test(t)) rules.digit = true;
        if (SYMBOL_WORD.test(t) && rules.symbols !== 'none') rules.symbol = true;
      }
    }
    const minAttr = +src.minLength || 0;
    const maxAttr = +src.maxLength || 0;
    if (minAttr > 0 && minAttr <= 128) rules.minLength = Math.max(rules.minLength, minAttr);
    if (maxAttr > 0 && maxAttr < 1000) longer(maxAttr);
    return rules;
  }

  /** The page's pattern attribute as the browser reads it (the whole value must match). */
  function patternOf(rules) {
    if (!rules || !rules.pattern) return null;
    for (const flags of ['v', 'u', ''])
      try {
        return new RegExp(`^(?:${rules.pattern})$`, flags);
      } catch (err) {
        /* try the next flag */
      }
    return null;
  }

  /**
   * What is wrong with `password` for a page with these rules: [] when it's fine. `personal` ({ email, names })
   * for "must not contain your name or email".
   */
  function checkPassword(password, rules, personal) {
    const pw = String(password || '');
    const r = rules || {};
    if (!pw) return ['no password'];
    const out = [];
    const symbolsIn = pw.replace(/[\p{L}\p{N}\s]/gu, '');
    if (r.minLength && pw.length < r.minLength) out.push(`shorter than ${r.minLength} characters`);
    if (r.maxLength && pw.length > r.maxLength) out.push(`longer than ${r.maxLength} characters`);
    if (r.upper && !/\p{Lu}/u.test(pw)) out.push('no capital letter');
    if (r.lower && !/\p{Ll}/u.test(pw)) out.push('no lower-case letter');
    if (r.digit && !/\d/.test(pw)) out.push('no number');
    if (r.symbol && !symbolsIn) out.push('no special character');
    if (r.digitOrSymbol && !/\d/.test(pw) && !symbolsIn) out.push('no number or special character');
    if (r.symbols === 'none' && symbolsIn) out.push('has special characters');
    else if (r.symbols && r.symbols !== 'any' && [...symbolsIn].some((ch) => !r.symbols.includes(ch)))
      out.push('uses a special character the site doesn’t list');
    const bad = [...new Set(r.forbidden || '')].filter((ch) => pw.includes(ch));
    if (bad.length) out.push(`contains ${bad.map((ch) => `“${ch}”`).join(' ')}`);
    if (r.noSpaces && /\s/.test(pw)) out.push('contains a space');
    if (r.ascii && /[^\x20-\x7e]/.test(pw)) out.push('has non-ASCII characters');
    if (r.maxRepeat && new RegExp(`(.)\\1{${r.maxRepeat}}`, 'u').test(pw)) out.push('repeats a character too often');
    if (r.startLetter && !/^\p{L}/u.test(pw)) out.push('doesn’t start with a letter');
    const re = patternOf(r);
    if (re && !re.test(pw)) out.push('doesn’t match the pattern the site asks for');
    if (r.noPersonal && personal) {
      const low = pw.toLowerCase();
      const words = [String(personal.email || '').split('@')[0], ...(personal.names || [])]
        .map((w) => String(w || '').toLowerCase())
        .filter((w) => w.length >= 3);
      if (words.some((w) => low.includes(w))) out.push('contains your name or email');
    }
    return out;
  }

  // Special characters every sign-up form takes; a page's own list or ban narrows them.
  const PUNCTUATION = /[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/;

  /**
   * A random password with at least one lower-case letter, capital, digit (and symbol), as most sign-up forms
   * demand. `rules` (parseRules) makes it fit a page: its length limits, the special characters it lists or
   * bans, no repeated characters, a letter first, its pattern.
   */
  function generatePassword(options) {
    const opts = Object.assign({ length: 20, symbols: true }, options || {});
    const r = opts.rules || {};
    const keep = (set) => [...set].filter((ch) => !(r.forbidden || '').includes(ch)).join('');
    let symbols = '';
    if (opts.symbols && r.symbols !== 'none') {
      const listed =
        r.symbols && r.symbols !== 'any' ? [...r.symbols].filter((ch) => PUNCTUATION.test(ch)).join('') : '';
      symbols = keep(listed || SETS.symbols);
    }
    const sets = [keep(SETS.lower), keep(SETS.upper), keep(SETS.digits), symbols].filter(Boolean);
    const max = r.maxLength && r.maxLength >= sets.length ? r.maxLength : Infinity;
    const length = Math.min(Math.max(opts.length, r.minLength || 0, sets.length), max);
    const re = patternOf(r);
    const repeated = new RegExp(`(.)\\1{${r.maxRepeat || 2}}`);
    const make = (pool) => {
      const chars = pool.map((s) => s[randomInt(s.length)]);
      const every = pool.join('');
      while (chars.length < length) chars.push(every[randomInt(every.length)]);
      for (let i = chars.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [chars[i], chars[j]] = [chars[j], chars[i]];
      }
      if (r.startLetter) {
        const k = chars.findIndex((ch) => /[a-z]/i.test(ch));
        if (k > 0) [chars[0], chars[k]] = [chars[k], chars[0]];
      }
      return chars.join('');
    };
    let pw = '';
    // A page's pattern can rule out the symbols: try without them before giving up.
    for (const pool of [sets, sets.filter((s) => s !== symbols)]) {
      for (let tries = 0; tries < 60; tries++) {
        pw = make(pool);
        if (repeated.test(pw)) continue;
        if (!re || re.test(pw)) return pw;
      }
    }
    return pw;
  }

  /* ------------------------------------------------------------------ storage */

  const local = () => JTF.api.storage.local;

  async function read() {
    const got = await local().get(KEY);
    return JTF.util.mergeDefaults(got[KEY], emptyData());
  }

  async function write(data) {
    await local().set({ [KEY]: data });
  }

  // Read-modify-write runs one at a time within a context, so two saves don't drop each other's changes.
  let queue = Promise.resolve();

  /** Read, let `fn` change the data in place, write it back. */
  function update(fn) {
    const run = queue.then(async () => {
      const data = await read();
      await fn(data);
      await write(data);
      return data;
    });
    queue = run.catch(() => {});
    return run;
  }

  /**
   * The saved login for a site. `portal` tells apart the employers that share one host (every SuccessFactors
   * company on career8.successfactors.com, "company:moodysprod"): a login saved for another portal there is
   * not this one. `exact`: only a login saved for this very portal (does an account exist here?).
   */
  function findCredential(data, host, portal, exact) {
    const matches = (data.credentials || []).filter(
      (c) =>
        JTF.util.hostMatches(host, c.host) && (!portal ? !exact || !c.portal : c.portal ? c.portal === portal : !exact),
    );
    // This portal's own login first, then the most specific saved host (careers.acme.com over acme.com).
    matches.sort((a, b) => !!b.portal - !!a.portal || b.host.length - a.host.length);
    return matches[0] || null;
  }

  function defaultCard(data) {
    const cards = data.cards || [];
    return cards.find((c) => c.id === data.defaultCardId) || cards[0] || null;
  }

  /* -------------------------------------------------- the old encrypted vault */

  // Older versions kept all this in an encrypted vault: storage.local "vault" ({ kdf: { iterations, salt },
  // data: { iv, ct } }), AES-256-GCM with a key derived from a master password by PBKDF2-SHA256, and the raw key
  // in storage.session "vaultKey" while it was unlocked. What it holds is moved over once, then it is removed.
  const LEGACY_KEY = 'vault';
  const LEGACY_SESSION = ['vaultKey', 'vaultLastUsed'];
  const session = () => JTF.api.storage.session;

  function unb64(str) {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function legacyBlob() {
    return (await local().get(LEGACY_KEY))[LEGACY_KEY] || null;
  }

  /** Is there an old vault still to move over (or discard)? */
  async function legacy() {
    return !!(await legacyBlob());
  }

  /** Merge what the old vault held into the passwords, without duplicating any: { credentials, cards } added. */
  function mergeLegacy(old) {
    const added = { credentials: 0, cards: 0 };
    const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
    return update((data) => {
      if (!data.defaultPassword && old.defaultPassword) data.defaultPassword = old.defaultPassword;
      for (const c of old.credentials || []) {
        // A login saved since (or moved over before) stays as it is, and comes first.
        const known = (x) =>
          x.id === c.id ||
          (same(x.host, c.host) &&
            same(x.portal, c.portal) &&
            same(x.username, c.username) &&
            x.password === c.password);
        if (!c || !c.host || data.credentials.some(known)) continue;
        data.credentials.push(c);
        added.credentials++;
      }
      for (const c of old.cards || []) {
        if (!c || data.cards.some((x) => x.id === c.id || x.number === c.number)) continue;
        data.cards.push(c);
        added.cards++;
      }
      if (!data.cards.some((c) => c.id === data.defaultCardId))
        data.defaultCardId = data.cards.some((c) => c.id === old.defaultCardId) ? old.defaultCardId : null;
    }).then(() => added);
  }

  /** Decrypt the old vault with `key`, move what it holds over and remove it. */
  async function moveLegacy(blob, key) {
    let old;
    try {
      const { iv, ct } = blob.data;
      const plain = await root.crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(ct));
      old = JSON.parse(new TextDecoder().decode(plain));
    } catch (err) {
      throw new Error('Wrong master password.', { cause: err });
    }
    const added = await mergeLegacy(old || {});
    await discardLegacy();
    return added;
  }

  /** Move the old vault's logins, cards and default password over, with its master password: { credentials, cards }. */
  async function importLegacy(masterPassword) {
    const blob = await legacyBlob();
    if (!blob || !blob.kdf || !blob.data) throw new Error('There is no old vault to move over.');
    const subtle = root.crypto.subtle;
    const secret = new TextEncoder().encode(String(masterPassword || ''));
    const base = await subtle.importKey('raw', secret, 'PBKDF2', false, ['deriveKey']);
    const key = await subtle.deriveKey(
      { name: 'PBKDF2', salt: unb64(blob.kdf.salt), iterations: blob.kdf.iterations, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );
    return moveLegacy(blob, key);
  }

  /** The old vault while its key is still in memory (it was unlocked when JobToFill updated): moved over silently. */
  async function importLegacySession() {
    const got = session() ? await session().get('vaultKey') : {};
    const blob = got.vaultKey ? await legacyBlob() : null;
    if (!blob || !blob.data) return null;
    const key = await root.crypto.subtle.importKey('raw', unb64(got.vaultKey), 'AES-GCM', false, ['decrypt']);
    return moveLegacy(blob, key);
  }

  /** Delete the old vault, and its key if that is still in memory. */
  async function discardLegacy() {
    await local().remove(LEGACY_KEY);
    if (session()) await session().remove(LEGACY_SESSION);
  }

  const passwords = {
    generatePassword,
    parseRules,
    checkPassword,
    read,
    write,
    update,
    findCredential,
    defaultCard,
    legacy,
    importLegacy,
    importLegacySession,
    discardLegacy,
  };
  JTF.passwords = passwords;
  if (typeof module === 'object' && module.exports) module.exports = passwords;
})(typeof globalThis !== 'undefined' ? globalThis : this);
