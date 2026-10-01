/*
 * JobToFill — the pure (DOM-free) half of the engine:
 *   classify(desc)          which field type is this control?
 *   plan(descs, profile)    classify a whole page, apply custom answers and
 *                           work out which education / job entry each box is for
 *   matchOption(opts, val)  pick the right <option>, radio or list item
 *   formatForText(val, d)   turn a value into the string a text box expects
 *
 * A "descriptor" is a plain object built by content/dom.js (or by a unit test):
 *   { kind, inputType, autocomplete, maxLength, placeholderRaw,
 *     options: [{ text, value }], signals: { label, question, aria, nearby,
 *     placeholder, attrs, name, id, title, ancestors, describedby } }
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});
  const U = JTF.util;
  const norm = U.normalize;
  const F = () => JTF.fields;

  // How much each piece of evidence counts. An explicit <label> beats a name attribute.
  const WEIGHTS = {
    label: 1, question: 1, aria: 0.95, nearby: 0.8, placeholder: 0.75, attrs: 0.7,
    name: 0.7, id: 0.65, title: 0.6, ancestors: 0.35, describedby: 0.3,
  };

  const EMAIL_TYPES = new Set(['email', 'account.username']);
  // Field types a lone checkbox can answer ("I am authorized to work in the US").
  const BOOL_TYPES = new Set(['job.authorized', 'job.sponsorship', 'job.relocate', 'job.over18', 'exp.current']);

  function signalTexts(desc) {
    const out = [];
    const s = desc.signals || {};
    for (const key of Object.keys(WEIGHTS)) {
      if (!s[key]) continue;
      const text = norm(String(s[key]).slice(0, 300));
      if (text) out.push({ key, text, weight: WEIGHTS[key] });
    }
    return out;
  }

  function kindAllowed(rule, desc) {
    if (desc.kind === 'checkbox') return BOOL_TYPES.has(rule.type);
    const kinds = rule.kinds || F().KINDS.DEFAULT_KINDS;
    if (!kinds.includes(desc.kind)) return false;
    if (desc.kind === 'email' && !EMAIL_TYPES.has(rule.type)) return false;
    return true;
  }

  function fromAutocomplete(desc) {
    if (!desc.autocomplete || ['radio', 'checkbox', 'checkboxes', 'file'].includes(desc.kind)) return null;
    const tokens = desc.autocomplete.toLowerCase().split(/\s+/);
    for (const token of tokens) {
      const hit = F().AUTOCOMPLETE[token];
      if (!hit) continue;
      const [type, part] = hit;
      // Sites stick autocomplete="new-password" on random boxes to stop browser autofill.
      if (type.startsWith('account.pass') && desc.kind !== 'password') return null;
      if (desc.kind === 'password' && !type.startsWith('account.pass')) return null;
      return { type, part: part || null, score: 2, source: 'autocomplete' };
    }
    return null;
  }

  function fallback(desc) {
    switch (desc.kind) {
      case 'email': return { type: 'email', part: null, score: 0.4, source: 'type' };
      case 'tel': return { type: 'phone', part: null, score: 0.4, source: 'type' };
      case 'password': return { type: 'account.password', part: null, score: 0.4, source: 'type' };
      case 'url': return { type: 'links.website', part: null, score: 0.3, source: 'type' };
      default: return null;
    }
  }

  /** Classify one control. Returns { type, part, score, source } or null. */
  function classify(desc) {
    const ac = fromAutocomplete(desc);
    if (ac) return refine(ac, desc);

    const signals = signalTexts(desc);
    const byType = new Map();
    let best = null;
    for (const rule of F().RULES) {
      if (!kindAllowed(rule, desc)) continue;
      let score = 0;
      let hits = 0;
      let hitText = '';
      for (const s of signals) {
        if (!rule.re.test(s.text) || (rule.not && rule.not.test(s.text))) continue;
        hits++;
        if (s.weight > score) {
          score = s.weight;
          hitText = s.text;
        }
      }
      if (!hits) continue;
      if (rule.test && !rule.test(desc, hitText)) continue;
      score += 0.05 * (hits - 1);
      const candidate = { type: rule.type, part: rule.part || null, score, source: 'rule', rule };
      const prev = byType.get(rule.type);
      if (!prev || score > prev.score) byType.set(rule.type, candidate);
      if (!best || score > best.score + 1e-9) best = candidate;
    }
    if (!best) return refine(fallback(desc), desc);

    // "Name" labels a first/last pair more often than a full-name box: let specifics win.
    if (best.rule.yieldsTo) {
      for (const type of best.rule.yieldsTo) {
        const alt = byType.get(type);
        if (alt && alt.score >= 0.5) {
          best = alt;
          break;
        }
      }
    }
    const { rule, ...result } = best;
    return refine(result, desc);
  }

  const MONTH_WORD = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/;

  /** For date-ish fields, is this box only the month, the year or the day? */
  function detectPart(desc) {
    const opts = (desc.options || []).filter((o) => !isPlaceholder(norm(o.text)));
    if (opts.length >= 3) {
      const texts = opts.map((o) => norm(o.text));
      const share = (re) => texts.filter((t) => re.test(t)).length / texts.length;
      if (share(/^(19|20)\d{2}$/) >= 0.8) return 'year';
      if (opts.length <= 13 && texts.filter((t) => MONTH_WORD.test(t) || /^(0?[1-9]|1[0-2])$/.test(t)).length / texts.length >= 0.8) return 'month';
      if (opts.length >= 28 && share(/^(0?[1-9]|[12]\d|3[01])$/) >= 0.8) return 'day';
    }
    const s = desc.signals || {};
    const text = [s.label, s.aria, s.placeholder, s.name, s.id, s.attrs, s.nearby, s.title].map(norm).join(' | ');
    const hasMonth = /\bmonth\b|\bmm\b|\bmonat\b|\bmes\b|\bmois\b/.test(text);
    const hasYear = /\byear\b|\byyyy\b|\byy\b|\bjahr\b|\bano\b|\bannee\b/.test(text);
    const hasDay = /\bday\b|\bdd\b/.test(text);
    if (hasMonth && !hasYear) return 'month';
    if (hasYear && !hasMonth) return 'year';
    if (hasDay && !hasMonth && !hasYear) return 'day';
    return null;
  }

  function looksLikePhoneCodes(options) {
    const opts = (options || []).filter((o) => !isPlaceholder(norm(o.text)));
    if (opts.length < 3) return false;
    return opts.filter((o) => /\+\s?\d{1,4}\b/.test(o.text)).length / opts.length >= 0.6;
  }

  function refine(r, desc) {
    if (!r) return null;
    if (F().DATE_TYPES.has(r.type) && !r.part) r.part = detectPart(desc);
    if ((r.type === 'address.country' || r.type === 'nationality') && looksLikePhoneCodes(desc.options)) r.type = 'phone.countryCode';
    if (desc.kind === 'email' && !EMAIL_TYPES.has(r.type)) r.type = 'email';
    if (desc.kind === 'password' && !r.type.startsWith('account.pass')) r.type = 'account.password';
    return r;
  }

  /* ----------------------------------------------------------- custom answers */

  /** The human question a control asks, for custom answers and the learn feature. */
  function questionText(desc) {
    const s = desc.signals || {};
    return U.cleanLabel(s.question || s.label || s.aria || s.nearby || s.placeholder || s.title || '');
  }

  /** "how did you hear|referral" -> phrases; "/^why .* us\??$/i" -> RegExp. */
  function compilePattern(question) {
    const s = String(question || '').trim();
    if (!s) return null;
    const m = s.match(/^\/(.+)\/([a-z]*)$/i);
    if (m) {
      try {
        return { re: new RegExp(m[1], m[2].includes('i') ? m[2] : m[2] + 'i') };
      } catch (err) {
        return null;
      }
    }
    const phrases = s.split('|').map(norm).filter(Boolean);
    return phrases.length ? { phrases } : null;
  }

  function matchCustom(desc, compiled) {
    const raw = questionText(desc);
    if (!raw) return null;
    const padded = ' ' + norm(raw) + ' ';
    for (const { answer, pattern } of compiled) {
      if (pattern.re ? pattern.re.test(raw) : pattern.phrases.some((p) => padded.includes(' ' + p + ' '))) return answer;
    }
    return null;
  }

  /* --------------------------------------------------------------------- plan */

  function groupOf(type) {
    if (!type) return null;
    if (type.startsWith('edu.') && type !== 'edu.level') return 'edu';
    if (type.startsWith('exp.')) return 'exp';
    return null;
  }

  /**
   * Classify every control on a page, then use document order to decide which
   * education / work-history entry each box belongs to: a repeated type
   * ("School" again) starts the next entry, and generic boxes ("From", "To",
   * "Location") take the section of the field just before them.
   */
  function plan(descs, profile) {
    const compiled = ((profile && profile.customAnswers) || [])
      .filter((a) => a && !U.isBlank(a.answer))
      .map((a) => ({ answer: a, pattern: compilePattern(a.question) }))
      .filter((c) => c.pattern);

    const results = descs.map((desc) => {
      if (desc.kind !== 'file' && desc.kind !== 'password' && compiled.length) {
        const a = matchCustom(desc, compiled);
        if (a) return { type: 'custom', part: null, score: 3, source: 'custom', answer: a.answer, answerId: a.id };
      }
      return classify(desc);
    });

    const state = { edu: { index: -1, seen: new Set() }, exp: { index: -1, seen: new Set() } };
    let prev = null;
    for (const r of results) {
      if (!r || !r.type) continue;
      if (r.type === 'custom') {
        prev = null;
        continue;
      }
      if (r.type.startsWith('gen.')) {
        const target = prev && (r.type !== 'gen.description' || prev === 'exp') ? prev + r.type.slice(3) : null;
        if (!target) {
          r.dropped = r.type;
          r.type = null;
          continue;
        }
        r.type = target;
      } else if (prev && (r.type === 'location' || r.type === 'address.city')) {
        r.type = prev + '.location';
      } else if (prev && ['address.state', 'address.country', 'address.postalCode'].includes(r.type)) {
        // The school's or employer's state, not yours.
        r.dropped = r.type;
        r.type = null;
        continue;
      }
      const g = groupOf(r.type);
      if (!g) {
        prev = null;
        continue;
      }
      const st = state[g];
      const key = r.type + ':' + (r.part || '');
      if (st.index < 0 || st.seen.has(key)) {
        st.index++;
        st.seen = new Set();
      }
      st.seen.add(key);
      r.index = st.index;
      prev = g;
    }

    const types = results.filter((r) => r && r.type).map((r) => r.type);
    const passwordFields = descs.filter((d) => d.kind === 'password').length;
    const context = {
      jobContext: types.some((t) => F().JOB_TYPES.test(t)),
      hasCountryCodeField: types.includes('phone.countryCode'),
      passwordFields,
      signup: passwordFields >= 2 || types.includes('account.passwordConfirm') ||
        descs.some((d) => /\bnew-password\b/.test(d.autocomplete || '')),
    };
    return { results, context };
  }

  /* ---------------------------------------------------------- option matching */

  function isPlaceholder(n) {
    return !n || /^(select|choose|please (select|choose|specify)|pick (one|an option)|none selected|click to select)\b/.test(n);
  }

  const DECLINE = /\bdecline|prefer not|not (wish|want) to|(don t|do not|does not) wish|(don t|do not) want to|rather not|not to (say|answer|disclose|self identify|specify|provide|state|respond)|choose not|not disclose|undisclosed|wish not to/;

  /** Map an answer or option to yes / no / decline / male / female / nonbinary, if it is one. */
  function canonicalOf(text) {
    const t = norm(text);
    if (!t || t.length > 160) return null;
    if (/^(yes|y|true|yep|yeah)\b/.test(t)) return 'yes';
    if (/^(no|n|false|nope)\b/.test(t)) return 'no';
    if (DECLINE.test(t)) return 'decline';
    if (/\bnon ?binary\b|genderqueer|gender ?(non|queer|fluid|nonconforming)|\bnon conforming\b/.test(t)) return 'nonbinary';
    if (/^(f|female|woman|women)$|\bfemale\b|\bwoman\b/.test(t)) return 'female';
    if (/^(m|male|man|men)$|\bmale\b|^man\b|\bcis ?man\b/.test(t)) return 'male';
    if (/\bnot\b|\bdo not\b|\bdon t\b|\bdoes not\b|\bnone\b|\bnever\b|\bhaven t\b|\bwon t\b|\bcannot\b|\bcan t\b/.test(t)) return 'no';
    if (/\bi am\b|\bi have\b|\bi identify\b|\bi do\b|\bi will\b|\bi can\b|\bi m\b|\bi agree\b/.test(t)) return 'yes';
    return null;
  }

  const DEGREE_GROUPS = [
    ['doctorate', /\bdoctor|\bph ?d\b|\bd ?phil\b|\bjd\b|\bmd\b|\bed ?d\b/],
    ['master', /\bmaster|\bm ?sc?\b|\bm ?a\b|\bm ?eng\b|\bmba\b|\bm ?tech\b|\bm ?phil\b|\bllm\b|\bmfa\b|post ?graduate|graduate degree/],
    ['bachelor', /\bbachelor|\bb ?sc?\b|\bb ?a\b|\bb ?eng\b|\bb ?tech\b|\bbba\b|\bb ?com\b|\bllb\b|\bbfa\b|undergraduate|\bab\b/],
    ['associate', /\bassociate|\baas\b/],
    ['highschool', /high school|secondary|\bged\b|a levels?|gcse/],
  ];

  function degreeGroup(n) {
    for (const [name, re] of DEGREE_GROUPS) if (re.test(n)) return name;
    return null;
  }

  function jaccard(a, b) {
    if (!a.length || !b.length) return 0;
    const sa = new Set(a);
    const sb = new Set(b);
    let inter = 0;
    for (const t of sa) if (sb.has(t)) inter++;
    return inter / (sa.size + sb.size - inter);
  }

  // "m b a" -> "mba", "ph d" -> "phd": acronyms survive punctuation stripping.
  const squash = (s) => s.replace(/\b([a-z]) (?=[a-z]\b)/g, '$1');

  function textScore(o, raw) {
    let best = 0;
    const c = squash(raw);
    for (const field of [o.n, o.nv]) {
      if (!field) continue;
      const s = squash(field);
      let sc;
      if (s === c || s.replace(/ /g, '') === c.replace(/ /g, '')) sc = 100;
      else if (s.startsWith(c + ' ') || c.startsWith(s + ' ')) sc = 80;
      else if ((' ' + s + ' ').includes(' ' + c + ' ')) sc = 70;
      else if (s.length >= 3 && (' ' + c + ' ').includes(' ' + s + ' ')) sc = 60;
      else sc = jaccard(U.tokens(s), U.tokens(c)) * 60;
      if (field === o.nv && field !== o.n) sc *= 0.9; // prefer the visible text
      if (sc > best) best = sc;
    }
    return best;
  }

  function bestText(opts, cands, v) {
    const wantDegree = v.kind === 'degree' ? degreeGroup(cands[0] || '') : null;
    const primary = U.tokens(cands[0] || '');
    let best = null;
    for (const o of opts) {
      let score = 0;
      for (const c of cands) score = Math.max(score, textScore(o, c));
      if (wantDegree && degreeGroup(o.n) === wantDegree) score = Math.max(score, 75 + score * 0.2);
      // Break ties toward the option that shares the most words with the main spelling.
      if (score > 0) score += jaccard(U.tokens(o.n), primary) * 5;
      if (!best || score > best.score) best = { i: o.i, score };
    }
    return best;
  }

  function parseRange(raw) {
    const t = String(raw).toLowerCase().replace(/[,$€£]/g, '')
      .replace(/(\d+(?:\.\d+)?)\s*k\b/g, (m, x) => String(parseFloat(x) * 1000));
    let m = t.match(/(\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?)/);
    if (m) return [+m[1], +m[2]];
    m = t.match(/(\d+(?:\.\d+)?)\s*(?:\+|or more|and (?:above|over|up)|plus)/) || t.match(/(?:more than|over|above|at least|greater than)\s*(\d+(?:\.\d+)?)/);
    if (m) return [+m[1], Infinity];
    m = t.match(/(?:less than|under|below|fewer than)\s*(\d+(?:\.\d+)?)/);
    if (m) return [0, +m[1] - 1e-9];
    m = t.match(/^\s*(\d+(?:\.\d+)?)\s*(?:years?|yrs?)?\s*$/);
    if (m) return [+m[1], +m[1]];
    return null;
  }

  function bestRange(opts, n) {
    let best = null;
    for (const o of opts) {
      const r = parseRange(o.text);
      if (!r || n < r[0] || n > r[1]) continue;
      const width = r[1] - r[0];
      if (!best || width < best.width) best = { i: o.i, width };
    }
    return best ? best.i : -1;
  }

  function bestPhoneCode(opts, v) {
    const re = new RegExp('(^|[^\\d])\\+?\\s?' + v.code + '(?!\\d)');
    const countries = (v.countries || []).map(norm).filter(Boolean);
    let best = null;
    for (const o of opts) {
      let s = 0;
      if (re.test(o.text) || re.test(o.value)) s += 60;
      const hay = ' ' + o.n + ' ' + o.nv + ' ';
      if (countries.some((c) => hay.includes(' ' + c + ' '))) s += 40;
      if (!best || s > best.s) best = { i: o.i, s };
    }
    return best && best.s >= 40 ? best.i : -1;
  }

  /**
   * Pick the option that best represents value `v`.
   * options: [{ text, value, disabled }]. Returns the index into `options`, or -1.
   */
  function matchOption(options, v) {
    if (!v || !options || !options.length) return -1;
    const opts = [];
    options.forEach((o, i) => {
      if (!o || o.disabled) return;
      const text = String(o.text || '').trim();
      const value = String(o.value == null ? '' : o.value).trim();
      const n = norm(text);
      if (isPlaceholder(n)) return;
      opts.push({ i, text, value, n, nv: norm(value) });
    });
    if (!opts.length) return -1;

    if (v.kind === 'phoneCode') return bestPhoneCode(opts, v);

    const cands = [...new Set((v.candidates || [v.text]).map(norm).filter(Boolean))];
    for (const c of cands) {
      const hit = opts.find((o) => o.n === c) || opts.find((o) => o.nv === c);
      if (hit) return hit.i;
    }

    if (v.kind === 'number' && v.number != null) {
      const r = bestRange(opts, v.number);
      if (r >= 0) return r;
    }

    if (v.canonical) {
      const hits = opts.filter((o) => canonicalOf(o.text) === v.canonical);
      if (hits.length === 1) return hits[0].i;
      if (hits.length > 1) return bestText(hits, cands, v).i;
      // Two options, one of them clearly the opposite answer: take the other one.
      if (opts.length === 2 && (v.canonical === 'yes' || v.canonical === 'no')) {
        const opposite = v.canonical === 'yes' ? 'no' : 'yes';
        const other = opts.filter((o) => canonicalOf(o.text) !== opposite);
        if (other.length === 1 && canonicalOf(opts.find((o) => o !== other[0]).text) === opposite) return other[0].i;
      }
    }

    const best = bestText(opts, cands, v);
    return best && best.score >= 45 ? best.i : -1;
  }

  /* --------------------------------------------------------------- formatting */

  function formatDate(v, desc) {
    const d = v.date;
    const y = String(d.year);
    const mm = U.pad2(d.month || 1);
    const dd = U.pad2(d.day || 1);
    const type = desc.inputType || 'text';
    const hint = String(desc.placeholderRaw || (desc.signals && desc.signals.placeholder) || '').toLowerCase();

    if (v.kind === 'month') return type === 'number' ? String(d.month) : mm;
    if (v.kind === 'year') return desc.maxLength === 2 || /^\s*yy\s*$/.test(hint) ? y.slice(2) : y;
    if (v.kind === 'day') return type === 'number' ? String(d.day) : dd;
    if (type === 'month') return `${y}-${mm}`;
    if (type === 'date') return `${y}-${mm}-${dd}`;

    const sep = (hint.match(/[/.-]/) || ['/'])[0];
    const S = '\\s*[/.\\-]\\s*';
    const yy4 = /y{4}/.test(hint);
    if (new RegExp('y{4}' + S + 'm{1,2}' + S + 'd{1,2}').test(hint)) return [y, mm, dd].join(sep);
    if (new RegExp('d{1,2}' + S + 'm{1,2}' + S + 'y{2,4}').test(hint)) return [dd, mm, yy4 ? y : y.slice(2)].join(sep);
    if (new RegExp('m{1,2}' + S + 'd{1,2}' + S + 'y{2,4}').test(hint)) return [mm, dd, yy4 ? y : y.slice(2)].join(sep);
    if (new RegExp('m{1,2}' + S + 'y{4}').test(hint)) return [mm, y].join(sep);
    if (new RegExp('m{1,2}' + S + 'y{2}').test(hint)) return [mm, y.slice(2)].join(sep);
    if (new RegExp('y{4}' + S + 'm{1,2}').test(hint)) return [y, mm].join(sep);
    if (/^\s*y{4}\s*$/.test(hint)) return y;
    if (v.defaultFormat === 'MM/YY') return desc.maxLength && desc.maxLength >= 7 ? `${mm}/${y}` : `${mm}/${y.slice(2)}`;
    if (d.day) return [mm, dd, y].join('/');
    if (d.month) return [mm, y].join('/');
    return y;
  }

  /** The string to type into a text-like control for value `v`. */
  function formatForText(v, desc) {
    if (!v) return '';
    const max = desc.maxLength > 0 ? desc.maxLength : 0;
    let out = v.text;
    if (v.date && ['date', 'month', 'year', 'day'].includes(v.kind)) out = formatDate(v, desc);
    else if (v.kind === 'country' && max && out.length > max) out = (max === 2 && v.iso2) || (max === 3 && v.iso3) || out;
    else if (v.kind === 'region' && max && out.length > max && v.code) out = v.code;
    else if (v.kind === 'phone' && max && out.length > max) out = v.national;
    if (desc.inputType === 'number') {
      const n = v.number != null ? v.number : parseFloat(String(out).replace(/[^\d.]/g, ''));
      out = Number.isFinite(n) ? String(n) : '';
    }
    if (max && out.length > max) out = out.slice(0, max);
    return out;
  }

  const matcher = {
    WEIGHTS, classify, plan, detectPart, questionText, compilePattern, canonicalOf,
    matchOption, formatForText, isPlaceholder, parseRange, degreeGroup,
  };
  JTF.matcher = matcher;
  if (typeof module === 'object' && module.exports) module.exports = matcher;
})(typeof globalThis !== 'undefined' ? globalThis : this);
