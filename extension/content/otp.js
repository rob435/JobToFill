/*
 * JobToFill — verification codes. Injected (with nothing else) into pages once Nylas is connected.
 * Watches for a box that asks for the code a site just emailed you (one input, or a row of single-digit
 * boxes), asks the background for that code until it arrives, and types it in. It also notices "check
 * your inbox to verify your email" pages, so the background can open the link from that email.
 *
 * The background decides which email a code may come from; this file never sees your inbox.
 */
(function (root) {
  'use strict';
  if (root.__jtfOtp) return;

  const WATCH_FOR = 15 * 60e3; // stop watching a page that never asks
  const POLL_FOR = 5 * 60e3; // stop waiting for an email that never comes
  const LOOKBACK = 10 * 60e3; // a code requested a little before the box appeared still counts

  const CODE_WORDS =
    /\b(verification|verify|confirm(ation)?|security|one[- ]?time|access|auth(entication)?|log ?in|sign[- ]?in|e-?mail(ed)?|2fa|mfa|two[- ]?(factor|step))\s*(code|pin|passcode)\b|\botp\b|\bpass ?code\b|\bone[- ]?time\b|\b\d[- ]digit\b|\benter (the |your )?code\b|\bcode (we |that we )?(sent|e-?mailed)\b|bestätigungscode|sicherheitscode|code de (vérification|confirmation|sécurité)|código de (verificación|verificação|confirmación|seguridad)|codice di verifica|verificatiecode/i;
  const CODE_NAME =
    /(^|[^a-z])(otp|mfa|2fa|totp|passcode|one_?time|verification_?code|verify_?code|confirmation_?code|security_?code|auth_?code|email_?code|login_?code|pin_?code|token)([^a-z]|$)|verificationcode|otpcode/i;
  const NOT_CODE =
    /promo|coupon|discount|voucher|gift|postal|zip|post ?code|referral|invite|invitation|country|area code|dial|phone|cvc|cvv|card|sort ?code|swift|bic|iban|tax|vat|product|captcha|tracking|campus|course|class|offer|reference/i;
  const CARD = /card ?number|credit|debit|expir|cvv|cvc|billing|payment|mm ?\/ ?yy/i;
  const EMAIL_HINT = /e-?mail|inbox|mailbox|we (have |'ve |’ve )?sent|sent (you |to )|check your/i;
  const OTHER_CHANNEL =
    /authenticator|authentication app|google auth|text message|\bsms\b|texted|phone number ending|backup code|recovery code/i;
  const VERIFY_PAGE =
    /(check|verify|confirm) your (e-?mail|inbox)|we('ve| have)? (just )?(sent|e-?mailed) (you )?(an? )?(e-?mail|link|verification|activation|confirmation)|(verification|activation|confirmation) (link|e-?mail) (has been |was )?sent|click the link (we sent|in the e-?mail)|activate your account/i;

  const state = { since: Date.now(), polling: null, done: new WeakSet(), observer: null, ended: false, link: null };

  const visible = (el) => {
    if (!el.isConnected || el.disabled || el.readOnly) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };

  const TEXTY = new Set(['', 'text', 'tel', 'number', 'password', 'search']);

  function labelText(el) {
    const bits = [el.getAttribute('aria-label'), el.placeholder, el.title];
    if (el.id) {
      try {
        for (const l of document.querySelectorAll(`label[for="${CSS.escape(el.id)}"]`)) bits.push(l.textContent);
      } catch (err) {
        /* odd id */
      }
    }
    const wrap = el.closest('label');
    if (wrap) bits.push(wrap.textContent);
    for (const id of (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)) {
      const l = document.getElementById(id);
      if (l) bits.push(l.textContent);
    }
    return bits.filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 300);
  }

  /** Text around a box: the form or section it sits in, for "We sent a code to r***@gmail.com". */
  function contextText(el) {
    let node = el.parentElement;
    for (let i = 0; node && i < 6; i++, node = node.parentElement) {
      const t = (node.innerText || '').replace(/\s+/g, ' ');
      if (t.length > 40 || node.localName === 'form') return t.slice(0, 1500);
    }
    return '';
  }

  /** The one-time code boxes on this page: { inputs: [el, …], length, numeric } or null. */
  function findTarget() {
    const inputs = [...document.querySelectorAll('input')].filter(
      (el) => TEXTY.has((el.getAttribute('type') || '').toLowerCase()) && !state.done.has(el) && visible(el),
    );
    if (!inputs.length) return null;

    // A row of single-character boxes, one per digit.
    const singles = inputs.filter(
      (el) =>
        el.maxLength === 1 ||
        (el.getBoundingClientRect().width < 64 && el.size <= 2 && el.maxLength > 0 && el.maxLength <= 2),
    );
    const groups = new Map();
    for (const el of singles) {
      let p = el.parentElement;
      for (let i = 0; p && i < 3; i++, p = p.parentElement) {
        const count = singles.filter((x) => p.contains(x)).length;
        if (count >= 4) {
          if (!groups.has(p))
            groups.set(
              p,
              singles.filter((x) => p.contains(x)),
            );
          break;
        }
      }
    }
    for (const [box, list] of groups) {
      if (list.length < 4 || list.length > 8 || list.some((x) => x.value)) continue;
      const label = `${labelText(list[0])} ${box.getAttribute('aria-label') || ''}`;
      const around = `${label} ${contextText(box)}`;
      if (NOT_CODE.test(label) || CARD.test(around)) continue;
      if (OTHER_CHANNEL.test(around) && !EMAIL_HINT.test(around)) continue;
      // A row of boxes is only a code when something says so (word games and ID inputs look the same).
      const oneTime = list.some((x) => /one-time-code/i.test(x.getAttribute('autocomplete') || ''));
      if (!oneTime && !CODE_WORDS.test(around) && !(EMAIL_HINT.test(around) && /\bcode\b/i.test(around))) continue;
      return { inputs: list, length: list.length, numeric: list.every(numericBox) };
    }

    // One box for the whole code.
    let best = null;
    for (const el of inputs) {
      if (el.value || (el.maxLength > 0 && (el.maxLength < 4 || el.maxLength > 12))) continue;
      const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
      if (/^cc-|\scc-/.test(ac)) continue; // card fields: "Security code" is the CVC
      const name = `${el.name} ${el.id}`;
      const label = labelText(el);
      if (NOT_CODE.test(label) || NOT_CODE.test(name)) continue;
      const around = contextText(el);
      if (!/one-time-code/.test(ac) && CARD.test(`${label} ${around}`)) continue;
      let score = 0;
      if (/one-time-code/.test(ac)) score += 5;
      if (CODE_WORDS.test(label)) score += 4;
      if (CODE_NAME.test(name)) score += 3;
      if (/^\s*code\s*\*?$/i.test(label) || /(^|[^a-z])code([^a-z]|$)/i.test(name)) score += 1;
      if (CODE_WORDS.test(around)) score += 1;
      if (EMAIL_HINT.test(around)) score += 1;
      if (OTHER_CHANNEL.test(`${label} ${around}`) && !EMAIL_HINT.test(`${label} ${around}`)) score -= 6;
      if ((el.getAttribute('type') || '') === 'password' && !/one-time-code/.test(ac)) score -= 2;
      if (score >= 4 && (!best || score > best.score)) best = { score, el };
    }
    if (!best) return null;
    const el = best.el;
    const length = el.maxLength >= 4 && el.maxLength <= 8 ? el.maxLength : 0;
    return { inputs: [el], length, numeric: numericBox(el) };
  }

  function numericBox(el) {
    return (
      el.type === 'number' ||
      el.type === 'tel' ||
      el.inputMode === 'numeric' ||
      /^\[0-9\]|\\d/.test(el.getAttribute('pattern') || '')
    );
  }

  /* ---------------------------------------------------------------- fill */

  function setValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const setter = (
      Object.getOwnPropertyDescriptor(proto, 'value') ||
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
    ).set;
    el.focus();
    setter.call(el, value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
    for (const type of ['keydown', 'keyup'])
      el.dispatchEvent(new KeyboardEvent(type, { key: value.slice(-1), bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function fillCode(target, code) {
    const { inputs } = target;
    if (inputs.length === 1) {
      setValue(inputs[0], code);
    } else {
      // Most digit-box widgets take a paste on the first box and spread it out themselves.
      try {
        const data = new DataTransfer();
        data.setData('text/plain', code);
        inputs[0].focus();
        inputs[0].dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true, composed: true }),
        );
      } catch (err) {
        /* no DataTransfer */
      }
      await sleep(120);
      if (inputs.map((el) => el.value).join('') !== code)
        for (let i = 0; i < inputs.length; i++) {
          setValue(inputs[i], code[i] || '');
          await sleep(30);
        }
    }
    for (const el of inputs) {
      state.done.add(el);
      el.style.outline = '2px solid rgba(124, 92, 255, 0.95)';
    }
    return (
      inputs
        .map((el) => el.value)
        .join('')
        .replace(/\s/g, '') === code || inputs[0].value === code
    );
  }

  /* --------------------------------------------------------------- toast */

  function toast(message, action) {
    if (!action && root.__jtf && root.__jtf.toast) return root.__jtf.toast(message, { duration: 7000 });
    const host = document.createElement('jobtofill-otp');
    host.style.cssText = 'all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647';
    const shadow = host.attachShadow({ mode: 'closed' });
    const box = document.createElement('div');
    box.setAttribute('role', 'status');
    box.style.cssText =
      'display:flex;gap:10px;align-items:flex-start;max-width:360px;padding:12px 14px;border-radius:12px;background:#17142b;color:#f4f2ff;font:13px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.25);white-space:pre-line';
    const dot = document.createElement('span');
    dot.style.cssText = 'flex:none;width:10px;height:10px;margin-top:4px;border-radius:50%;background:#8b74ff';
    const text = document.createElement('span');
    text.style.cssText = 'flex:1';
    text.textContent = message;
    box.append(dot, text);
    const buttons = [];
    if (action) {
      for (const [label, run] of [
        [action.label, action.run],
        ['Dismiss', () => {}],
      ]) {
        const b = document.createElement('button');
        b.textContent = label;
        b.style.cssText = 'all:unset;cursor:pointer;color:#b9abff;font-weight:600;margin-left:6px';
        b.addEventListener('click', () => {
          host.remove();
          run();
        });
        buttons.push(b);
      }
      box.append(...buttons);
    }
    shadow.append(box);
    (document.body || document.documentElement).append(host);
    setTimeout(() => host.remove(), action ? 60000 : 7000);
    return true;
  }

  /* ---------------------------------------------------------------- poll */

  function send(message) {
    const api = root.browser || root.chrome;
    return api.runtime.sendMessage(message).catch((err) => ({ error: String((err && err.message) || err) }));
  }

  async function pollForCode(target) {
    if (state.polling) return state.polling;
    const started = Date.now();
    const since = Math.min(state.since, started) - LOOKBACK;
    state.polling = (async () => {
      let delay = 0;
      while (Date.now() - started < POLL_FOR) {
        await sleep(delay);
        delay = Date.now() - started < 60e3 ? 3500 : 8000;
        if (!target.inputs.every((el) => el.isConnected)) return null;
        // The person typed it themselves.
        if (target.inputs.some((el) => el.value) && !target.inputs.every((el) => state.done.has(el))) return null;
        const res = await send({
          type: 'jtf:otp',
          kind: 'code',
          since,
          want: { length: target.length, numeric: target.numeric },
        });
        if (!res || res.stop) return null;
        if (res.error) {
          if (res.fatal) return null;
          continue;
        }
        if (res.code) {
          const ok = await fillCode(target, res.code);
          toast(
            ok
              ? `Filled the verification code from ${res.from}.`
              : `Couldn’t type the code from ${res.from} into this box.`,
          );
          return res;
        }
        if (res.suggest) {
          for (const el of target.inputs) state.done.add(el);
          toast(
            `A code just arrived from ${res.from} (“${res.subject}”), but it doesn’t look like it’s from this site.`,
            {
              label: 'Use it',
              run: async () => {
                const got = await send({ type: 'jtf:otp-claim', token: res.suggest });
                if (got && got.code) await fillCode(target, got.code);
              },
            },
          );
          return res;
        }
      }
      // Nothing came: don't start waiting again for the same boxes.
      for (const el of target.inputs) state.done.add(el);
      return null;
    })().finally(() => {
      state.polling = null;
    });
    return state.polling;
  }

  async function pollForLink() {
    if (state.link) return;
    const started = Date.now();
    state.link = (async () => {
      let delay = 1500;
      while (Date.now() - started < POLL_FOR) {
        await sleep(delay);
        delay = Date.now() - started < 60e3 ? 4000 : 10000;
        if (findTarget()) return; // it asks for a code after all
        const res = await send({ type: 'jtf:otp', kind: 'link', since: state.since - LOOKBACK });
        if (!res || res.stop || (res.error && res.fatal)) return;
        if (res.opened) {
          toast(`Opened the verification link from ${res.from} in a new tab.`);
          return;
        }
      }
    })();
  }

  /* --------------------------------------------------------------- watch */

  let scheduled = false;
  let lastTextCheck = 0;
  function check(options) {
    if (state.ended) return false;
    const target = document.querySelector('input') && findTarget();
    if (target) {
      pollForCode(target);
      return true;
    }
    // Reading the page's text is the costly part: at most every few seconds, and not once a link is awaited.
    if (root === root.top && options && options.links !== false && !state.link && Date.now() - lastTextCheck > 4000) {
      lastTextCheck = Date.now();
      const text = (document.body && document.body.innerText) || '';
      if (VERIFY_PAGE.test(text.slice(0, 6000))) pollForLink();
    }
    return false;
  }

  const hasInput = (node) =>
    node.nodeType === 1 && (node.localName === 'input' || (node.firstElementChild && !!node.querySelector('input')));

  function watch(options) {
    state.options = options || {};
    // A new page load or step: codes are timed from now (less the look-back).
    if (!state.polling) state.since = Date.now();
    check(state.options);
    if (state.observer) return;
    // New boxes are checked soon; a style or class change (a hidden step being shown) less often.
    state.observer = new MutationObserver((records) => {
      if (scheduled || state.polling) return;
      const added = records.some((r) => r.type === 'childList' && [...r.addedNodes].some(hasInput));
      scheduled = true;
      setTimeout(
        () => {
          scheduled = false;
          if (!state.polling) check(state.options);
        },
        added ? 500 : 2000,
      );
    });
    state.observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'hidden'],
    });
    setTimeout(() => {
      if (state.observer) state.observer.disconnect();
      state.observer = null;
    }, WATCH_FOR);
  }

  /** The box the person right-clicked: "Insert verification code from email". */
  function fillFocused(code) {
    const el = document.activeElement;
    if (!el || el.localName !== 'input') return false;
    const target = findTarget();
    if (target && target.inputs.includes(el)) return fillCode(target, code);
    return fillCode({ inputs: [el] }, code);
  }

  root.__jtfOtp = { watch, check, findTarget, fillCode, fillFocused };
})(typeof globalThis !== 'undefined' ? globalThis : this);
