/*
 * JobToFill — shared helpers.
 * Classic script: loaded by the service worker, extension pages, injected
 * content scripts and Node unit tests. Everything hangs off globalThis.JTF.
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});

  // prettier-ignore
  const MONTHS = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
  ];

  // prettier-ignore
  const STOPWORDS = new Set([
    'a', 'an', 'the', 'of', 'and', 'or', 'in', 'on', 'for', 'to', 'with', 'at', 'by',
    'is', 'are', 'am', 'be', 'you', 'your', 'i', 'my', 'me', 'do', 'please', 'select',
  ]);

  /**
   * Canonical form for all text comparisons: camelCase split, lowercase,
   * accents stripped, every run of punctuation collapsed to one space.
   * "LinkedIn URL*" -> "linked in url", "e-mail" -> "e mail".
   */
  function normalize(input) {
    if (input == null) return '';
    return String(input)
      .replace(/([a-z\d])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  }

  /** Human-readable label: collapsed whitespace, no required markers. */
  function cleanLabel(input, max = 300) {
    if (!input) return '';
    let s = String(input).replace(/\s+/g, ' ').trim();
    s = s
      .replace(/\s*\((required|optional)\)\s*$/i, '')
      .replace(/[\s*:]+$/, '')
      .replace(/^\*+\s*/, '');
    return s.length > max ? s.slice(0, max).trim() + '…' : s;
  }

  function tokens(input) {
    return normalize(input)
      .split(' ')
      .filter((t) => t && !STOPWORDS.has(t));
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  /** Parse "YYYY", "YYYY-MM", "YYYY-MM-DD", "MM/YYYY" or "MM/DD/YYYY". */
  function parseDate(value) {
    if (!value) return null;
    const s = String(value).trim();
    let m = s.match(/^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/);
    if (m) return { year: +m[1], month: m[2] ? +m[2] : null, day: m[3] ? +m[3] : null };
    m = s.match(/^(\d{1,2})[/.-](\d{4})$/);
    if (m) return { year: +m[2], month: +m[1], day: null };
    m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
    if (m) return { year: +m[3], month: +m[1], day: +m[2] };
    return null;
  }

  function monthName(month, short) {
    const name = MONTHS[month - 1] || '';
    return short ? name.slice(0, 3) : name;
  }

  function getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }

  function setPath(obj, path, value) {
    const keys = path.split('.');
    let o = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') o[keys[i]] = {};
      o = o[keys[i]];
    }
    o[keys[keys.length - 1]] = value;
  }

  function uid() {
    const bytes = new Uint8Array(8);
    root.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function isBlank(v) {
    return v == null || (typeof v === 'string' && v.trim() === '');
  }

  /** Recursively fill missing keys of `target` from `defaults` (arrays are left alone). */
  function mergeDefaults(target, defaults) {
    const out = target && typeof target === 'object' ? target : {};
    for (const [k, v] of Object.entries(defaults)) {
      if (!(k in out)) out[k] = JSON.parse(JSON.stringify(v));
      else if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = mergeDefaults(out[k], v);
    }
    return out;
  }

  /** Registrable-ish host check: "boards.greenhouse.io" matches saved "greenhouse.io". */
  function hostMatches(frameHost, savedHost) {
    if (!frameHost || !savedHost) return false;
    const a = frameHost.toLowerCase().replace(/^www\./, '');
    const b = savedHost
      .toLowerCase()
      .replace(/^\*\./, '')
      .replace(/^www\./, '');
    return a === b || a.endsWith('.' + b);
  }

  /** Is this Firefox? (Only Firefox has runtime.getBrowserInfo.) */
  function isFirefox() {
    const api = root.browser || root.chrome;
    return !!(api && api.runtime && typeof api.runtime.getBrowserInfo === 'function');
  }

  const util = {
    MONTHS,
    normalize,
    cleanLabel,
    tokens,
    pad2,
    parseDate,
    monthName,
    getPath,
    setPath,
    uid,
    isBlank,
    mergeDefaults,
    hostMatches,
    isFirefox,
  };
  JTF.util = util;

  // The promise-based extension API: `browser` in Firefox, `chrome` in Chromium browsers.
  Object.defineProperty(JTF, 'api', { configurable: true, get: () => root.browser || root.chrome });
  if (typeof module === 'object' && module.exports) module.exports = util;
})(typeof globalThis !== 'undefined' ? globalThis : this);
