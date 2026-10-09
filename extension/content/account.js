/*
 * JobToFill — sign-in, sign-up and emailed-code pages, and the steps of an application, in the page. Reads what kind
 * of page this is, what still stands between it and its submit or its next step (an empty required box, an "I'm not
 * a robot" check, the terms), and clicks the page's own controls when the background says so: sign-in and
 * create-account controls whose wording passes JTF.accounts.intent(), only on pages with no job-application
 * questions; on an application, only a section's "Add" for another entry and a step's own "Next", whose wording
 * passes JTF.accounts.stepIntent(), never anything that sends it. Never inside a CAPTCHA. Nothing else in the
 * extension clicks a page's buttons.
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});
  if (JTF.flow) return;
  const U = JTF.util;
  const dom = () => JTF.dom;
  const A = () => JTF.accounts;

  /* -------------------------------------------------------------- CAPTCHAs */

  // CAPTCHA widgets, and the hidden field each fills in once the person has solved it. SuccessFactors renders
  // reCAPTCHA into #captchaImg and copies the answer to #recaptcha_response_field.
  const CAPTCHAS = [
    {
      kind: 'hCaptcha',
      box: '.h-captcha',
      frame: /hcaptcha\.com/,
      token: 'textarea[name="h-captcha-response"], input[name="h-captcha-response"]',
    },
    {
      kind: 'Turnstile',
      box: '.cf-turnstile',
      frame: /challenges\.cloudflare\.com/,
      token: 'input[name="cf-turnstile-response"]',
    },
    {
      kind: 'Arkose',
      box: '#arkose, [id^="arkose" i], [data-arkose], .funcaptcha',
      frame: /arkoselabs\.com|funcaptcha\.com/,
      token: null,
    },
    {
      kind: 'reCAPTCHA',
      box: '.g-recaptcha, [data-sitekey], #captchaImg',
      frame: /\/recaptcha\/(api2|enterprise)\/anchor|recaptcha\.net\/recaptcha/,
      token:
        'textarea[name="g-recaptcha-response"], textarea[id^="g-recaptcha-response"], input[name="g-recaptcha-response"], input[name="recaptcha_response_field"]',
    },
  ];
  /** Containers nothing is filled or clicked inside. */
  const CAPTCHA_BOX =
    '.g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey], #captchaImg, .grecaptcha-badge, .funcaptcha, [id^="arkose" i]';
  // An image CAPTCHA's answer box ("Enter the characters you see").
  const IMAGE_CAPTCHA =
    /captcha|security check|(characters|text|letters|code|word)s? (you see|shown|displayed|in the (image|picture|box))|enter the (characters|text|letters|word)s?( above| below| shown)?$|type the (characters|text|letters|word)/i;

  const shown = (el) => !!el && dom().isVisible(el, { ignoreOpacity: true });

  function captchaAnswerBox(el) {
    if (!el || el.localName !== 'input' || /^(hidden|checkbox|radio|submit|button|file|password)$/.test(el.type))
      return false;
    const label = [
      el.name,
      el.id,
      el.placeholder,
      el.getAttribute('aria-label'),
      ...Array.from(el.labels || [], (l) => l.textContent),
    ]
      .filter(Boolean)
      .join(' ');
    return IMAGE_CAPTCHA.test(label);
  }

  /** Is this control part of a CAPTCHA (never filled or clicked)? */
  function inCaptcha(el) {
    return !!el && (!!el.closest(CAPTCHA_BOX) || captchaAnswerBox(el));
  }

  /**
   * The CAPTCHA on this page that waits for a person: { kind, solved, detectable } or null. Invisible reCAPTCHA
   * and v3 badges ask nothing of anyone, so they don't count.
   */
  function captcha(doc) {
    doc = doc || document;
    const frames = Array.from(doc.querySelectorAll('iframe'));
    for (const c of CAPTCHAS) {
      const widget =
        frames.some((f) => c.frame.test(f.src || '') && !/[?&]size=invisible\b/.test(f.src) && shown(f)) ||
        Array.from(doc.querySelectorAll(c.box)).some(
          (b) => b.getAttribute('data-size') !== 'invisible' && !b.classList.contains('grecaptcha-badge') && shown(b),
        );
      if (!widget) continue;
      const tokens = c.token ? Array.from(doc.querySelectorAll(c.token)) : [];
      return { kind: c.kind, solved: tokens.some((t) => String(t.value || '').trim()), detectable: tokens.length > 0 };
    }
    const box = Array.from(doc.querySelectorAll('input')).find((el) => captchaAnswerBox(el) && shown(el));
    if (box) return { kind: 'image', solved: box.value.trim().length >= 3, detectable: true };
    return null;
  }

  /* -------------------------------------------------------- page analysis */

  const CLICKABLE =
    'button, input[type="submit"], input[type="button"], input[type="image"], a[href], [role="button"], [role="link"]';
  const SUBMIT_TYPE = 'button:not([type="button"]):not([type="reset"]), input[type="submit"], input[type="image"]';
  const ERRORS =
    '[role="alert"], [aria-live="assertive"], .error, .errors, .alert-danger, .alert-error, .invalid-feedback, .field-error, .form-error, .error-message, .errorMessage, .sysmsg.error, [class*="error" i]:not(input):not(select):not(textarea):not(form):not(body)';
  const NOTICES = `${ERRORS}, .alert, .message, .notice, [class*="message" i], [class*="notice" i], [role="status"]`;

  function controlText(el) {
    const own = el.localName === 'input' ? el.value : dom().textOf(el);
    return U.cleanLabel(own || el.getAttribute('aria-label') || el.getAttribute('title') || '', 120);
  }

  function usableControl(el) {
    return (
      shown(el) &&
      !el.disabled &&
      el.getAttribute('aria-disabled') !== 'true' &&
      !el.closest('[data-jtf-ui]') &&
      !inCaptcha(el) &&
      // A link that only runs script is fine; one that leaves for another site is not a sign-in control.
      !(
        el.localName === 'a' &&
        /^https?:/i.test(el.href) &&
        new URL(el.href).hostname !== location.hostname &&
        !sameSite(new URL(el.href).hostname)
      )
    );
  }

  function sameSite(host) {
    const site = (h) => h.split('.').slice(-2).join('.');
    return site(host) === site(location.hostname);
  }

  /** Every visible control a person could click, with what it would do. */
  function controls(doc) {
    return Array.from((doc || document).querySelectorAll(CLICKABLE))
      .filter(usableControl)
      .map((el) => ({ el, text: controlText(el), intent: A().intent(controlText(el)) }))
      .filter((c) => c.text);
  }

  /** Is a field required: the attribute, aria-required, or a "*" / "Required" on its label (dom.isRequired)? */
  const isRequired = (field) => JTF.dom.isRequired(field);

  /**
   * Rows marked required that hold no box to fill: SuccessFactors' "Terms of Use: Read and acknowledge the data
   * privacy statement" link and its "Confirm you are not a robot" row. Each keeps its answer in a hidden input,
   * which tells when the person has done it.
   */
  function requiredRows(doc) {
    const out = [];
    for (const label of (doc || document).querySelectorAll('label')) {
      if (!shown(label) || label.closest('[data-jtf-ui]')) continue;
      const marked =
        /\*/.test(label.textContent) ||
        /^required$/i.test(label.getAttribute('title') || '') ||
        !!label.querySelector('.required');
      if (!marked) continue;
      const target = label.htmlFor ? label.ownerDocument.getElementById(label.htmlFor) : null;
      if (target && /^(input|select|textarea)$/.test(target.localName) && target.type !== 'hidden') continue;
      const row =
        label.closest('tr, li, .form-group, fieldset') || (label.parentElement && label.parentElement.parentElement);
      const hidden = row ? Array.from(row.querySelectorAll('input[type="hidden"]')) : [];
      if (!hidden.length) continue;
      const text = U.cleanLabel(dom().textOf(label), 80);
      out.push({
        label: text,
        done: hidden.some((h) => String(h.value || '').trim()),
        robot: /robot|captcha|human/i.test(text),
      });
    }
    return out;
  }

  /** Visible error and notice texts (a validation message, "An account with this email already exists"). */
  function messages(doc, selector) {
    const els = Array.from((doc || document).querySelectorAll(selector)).filter(
      (el) =>
        shown(el) && !el.closest('[data-jtf-ui]') && !el.querySelector('input:not([type="hidden"]), select, textarea'),
    );
    const texts = [];
    for (const el of els) {
      if (els.some((o) => o !== el && el.contains(o))) continue;
      const t = U.cleanLabel(dom().textOf(el), 300);
      if (t.length >= 3 && !texts.includes(t)) texts.push(t);
    }
    return texts;
  }

  const ACCOUNT_TYPES =
    /^(account\.|email$|human$|otp$|consent$|name\.|phone|address\.|location$|nationality$|pronouns$)/;

  /**
   * What kind of page this frame is, from a scan ({ fields, results } as main.js makes them):
   *   kind     'login' | 'signup' | 'verify' | 'chooser' | 'application' | 'none'
   *            ('chooser': a sign-in page that only offers ways in, Workday's "Sign in with email" among them)
   *   pure     no job-application questions or uploads (the only pages anything is ever clicked on)
   * plus what it would take to submit it: blockers, errors, the submit and switch links it offers.
   * `opts.ignore`: messages still showing from an earlier try (an old "wrong password" once the password has been
   * replaced), left out of errors and of what the page says.
   */
  function analyze(scan, opts) {
    const { fields, results } = scan;
    const F = JTF.fields;
    const ignore = new Set((opts && opts.ignore) || []);
    const out = {
      kind: 'none',
      url: location.href,
      host: location.hostname,
      top: root === root.top,
      portal: A().portal(location.href, hints()),
      pure: false,
      ready: false,
      passwordFilled: false,
      blockers: [],
      errors: [],
      exists: false,
      badLogin: false,
      verifyEmail: false,
      notices: [],
      // The tracking system behind the page, when its sign-in says so (Workday's, also on employers' own domains).
      system: document.querySelector('[data-automation-id="signInContent"], [data-automation-id="signInFormo"]')
        ? 'workday'
        : '',
      captcha: null,
      submit: '',
      toSignup: '',
      toSignin: '',
      toEmail: '',
    };
    if (A().isCaptchaFrame(location.href)) return out;
    const types = results.map((r) => (r && r.type) || null);
    const pick = (pred) => fields.map((f, i) => i).filter((i) => pred(types[i], fields[i]));
    const passwords = pick((t) => t === 'account.password');
    const confirms = pick((t) => t === 'account.passwordConfirm');
    const codes = pick((t) => t === 'otp');
    const jobby = pick(
      (t, f) =>
        (t &&
          !ACCOUNT_TYPES.test(t) &&
          (F.JOB_TYPES.test(t) || t === 'custom' || /^(job|edu|exp|eeo|compliance)\./.test(t))) ||
        f.kind === 'file' ||
        (!t && f.kind === 'textarea'),
    );
    // Changing or resetting a password (a "Current password" box, a "Reset your password" page) is not signing up.
    const changing =
      [...passwords, ...confirms].some((i) =>
        /\b(current|old|existing|temporary|previous)\b/.test(U.normalize(JTF.matcher.questionText(fields[i].desc))),
      ) || /\b(reset|change|update|forgot(ten)?|recover)\b.{0,20}\bpassword\b/i.test(`${document.title} ${headings()}`);
    // An upload tile without its file box yet (SuccessFactors' "Upload a Resume") is an application too.
    if (jobby.length || JTF.fill.uploadTriggers(document).length) out.kind = 'application';
    else if (changing) out.kind = 'none';
    else if (passwords.length + confirms.length >= 2 || confirms.length) out.kind = 'signup';
    else if (passwords.length === 1)
      out.kind = /\bnew-password\b/.test(fields[passwords[0]].desc.autocomplete) ? 'signup' : 'login';
    else if (codes.length) out.kind = 'verify';
    else {
      // No boxes yet, only ways in: "Sign in with Google", "Sign in with Apple", "Sign in with email" (Workday). The
      // wording is read first: only a page with such a button is looked at closer.
      const candidates = Array.from(document.querySelectorAll(CLICKABLE));
      const email = candidates
        .filter((el) => A().intent(controlText(el)) === 'to-email' && usableControl(el))
        .map((el) => ({ el, text: controlText(el) }))[0];
      const others = () => candidates.some((el) => OTHER_SERVICE.test(controlText(el)) && shown(el));
      if (email && (others() || /\b(sign|log) ?in\b/i.test(headings()))) {
        out.kind = 'chooser';
        out.pure = true;
        out.toEmail = email.text;
        out.ready = true;
      }
      return out;
    }
    if (out.kind === 'none' || out.kind === 'application') return out;
    out.pure = true;

    const hasValue = (i) => JTF.fill.hasValue(fields[i]);
    out.passwordFilled = passwords.length > 0 && passwords.every(hasValue) && confirms.every(hasValue);
    const label = (i) => U.cleanLabel(JTF.matcher.questionText(fields[i].desc), 60) || fields[i].kind;
    fields.forEach((f, i) => {
      if (hasValue(i) || !isRequired(f) || inCaptcha(f.el)) return;
      const t = types[i];
      if (t === 'otp' && out.kind !== 'verify') return;
      if (t === 'consent') out.blockers.push({ kind: 'terms', label: label(i), wait: true });
      else if (t === 'human') out.blockers.push({ kind: 'robot', label: label(i), wait: true });
      else out.blockers.push({ kind: 'missing', label: label(i) });
    });
    if (passwords.length && confirms.length && out.passwordFilled) {
      const pw = fields[passwords[0]].el.value;
      if (confirms.some((i) => fields[i].el.value !== pw)) out.blockers.push({ kind: 'mismatch', label: 'Passwords' });
    }
    const c = captcha(document);
    out.captcha = c;
    if (c && !c.solved) out.blockers.push({ kind: 'captcha', label: c.kind, wait: c.detectable });
    for (const row of requiredRows(document)) {
      if (row.done || (row.robot && c)) continue;
      out.blockers.push({ kind: row.robot ? 'captcha' : 'terms', label: row.label, wait: true });
    }
    // "An email has been sent to you. Please verify your account." is news, not an error to fix.
    out.errors = messages(document, ERRORS).filter(
      (t) => !/^\*?\s*(indicates|denotes) a required/i.test(t) && !ignore.has(t) && !A().isVerifyNotice(t),
    );
    out.notices = messages(document, NOTICES).filter((t) => !ignore.has(t));
    const said = A().readMessages(out.notices.join(' \n '));
    out.exists = said.exists;
    out.badLogin = said.badLogin;
    out.verifyEmail = said.verifyEmail;
    if (!out.errors.length) {
      const invalid = fields.filter((f) => f.el.getAttribute('aria-invalid') === 'true' && shown(f.el));
      if (invalid.length) out.errors.push(`Check ${U.cleanLabel(JTF.matcher.questionText(invalid[0].desc), 60)}`);
    }

    const anchor = fields[passwords[0] != null ? passwords[0] : confirms[0] != null ? confirms[0] : codes[0]];
    const submit = submitFor(out.kind, anchor && anchor.el);
    out.submit = submit ? submit.text : '';
    const all = controls(document);
    const form = anchor && anchor.el.form;
    // On a sign-in page "Create your account" leads to sign-up; on a sign-up page a "Sign in" link (not the
    // submit of a sign-in form beside it) leads back. Workday's is a <button> outside any form, after the form; the
    // header's "Sign In" before it opens a menu, so the ones after the form come first.
    const up = out.kind === 'login' ? all.find((x) => x.intent === 'to-signup' || x.intent === 'signup') : null;
    const following = (x) => !!anchor && !!(anchor.el.compareDocumentPosition(x.el) & Node.DOCUMENT_POSITION_FOLLOWING);
    const back =
      out.kind === 'signup'
        ? all
            .filter(
              (x) =>
                x.intent === 'to-signin' ||
                (x.intent === 'signin' &&
                  (x.el.localName === 'a' || !form || !form.contains(x.el)) &&
                  !(x.el.matches(SUBMIT_TYPE) && x.el.form)),
            )
            .sort((a, b) => following(b) - following(a))[0]
        : null;
    out.toSignup = up ? up.text : '';
    out.toSignin = back ? back.text : '';
    const codeFilled = out.kind !== 'verify' || codes.every(hasValue);
    out.ready =
      !!submit &&
      !out.errors.length &&
      !out.blockers.length &&
      codeFilled &&
      (out.kind === 'verify' || out.passwordFilled);
    return out;
  }

  // Other services' sign-in buttons (never clicked) that tell a page of ways in from any page with an email button.
  const OTHER_SERVICE =
    /\b(?:(?:sign|log) ?(?:in|on|up)|continue|connect)\b.*\b(?:google|apple|linked ?in|microsoft|facebook|indeed|git ?hub|twitter|yahoo|amazon)\b/i;

  const headings = () =>
    Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"]'))
      .filter(shown)
      .slice(0, 6)
      .map((h) => h.textContent)
      .join(' ');

  /** Clues a page holds about the employer behind a shared portal host (SuccessFactors' hidden company field). */
  function hints() {
    const own = document.querySelector('input[name="career_company"], input#career_company');
    const el = own || document.querySelector('input[name="company"][type="hidden"]');
    return { company: el ? el.value : '', careerCompany: !!own };
  }

  /**
   * The submit of the form the password (or code) box sits in: a control whose wording says it signs in, creates
   * the account or confirms the code, nearest after that box. Failing that, the form's only submit button when it
   * says no more than "Submit" / "Continue" (a pure account form's own submit).
   */
  function submitFor(kind, anchor) {
    if (!anchor) return null;
    const want = kind === 'login' ? ['signin'] : kind === 'signup' ? ['signup'] : ['verify'];
    let scope = anchor.form || null;
    for (let a = anchor.parentElement; !scope && a && a !== document.body; a = a.parentElement)
      if (controls(a).some((c) => want.includes(c.intent))) scope = a;
    const list = controls(scope || document);
    const after = (c) => !!(anchor.compareDocumentPosition(c.el) & Node.DOCUMENT_POSITION_FOLLOWING);
    const rank = (c) => (after(c) ? 0 : 2) + (c.el.matches('a[href]') ? 1 : 0);
    const named = list.filter((c) => want.includes(c.intent)).sort((a, b) => rank(a) - rank(b));
    if (named.length) return named[0];
    if (!scope) return null;
    const submits = list.filter((c) => c.el.matches(SUBMIT_TYPE));
    if (submits.length === 1 && ['only', 'verify'].includes(submits[0].intent)) return submits[0];
    return null;
  }

  /* --------------------------------------------------------------- clicks */

  /**
   * Click like a person: on whatever is on top at the control's centre, when that is the control itself (or an
   * overlay that says the same, like Workday's click filter, whose label is a bare "Submit" over the "Sign In" of
   * its email sign-in form). Anything else covering it (a cookie banner, a dialog) means no click. `same(over)`: does
   * a control laid over this one say the same (the account flow's own test by default)?
   */
  function press(el, same) {
    if (el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    const rootNode = el.getRootNode();
    const finder = rootNode.elementFromPoint ? rootNode : el.ownerDocument;
    const top = finder.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    let target = el;
    if (top && top !== el && !el.contains(top)) {
      const over = top.closest(CLICKABLE) || top;
      if (!(same || sameAccountControl)(over, el)) return { ok: false, reason: 'covered' };
      target = over;
    }
    const view = el.ownerDocument.defaultView;
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view,
      button: 0,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
    };
    target.dispatchEvent(new view.PointerEvent('pointerdown', init));
    target.dispatchEvent(new view.MouseEvent('mousedown', init));
    target.dispatchEvent(new view.PointerEvent('pointerup', init));
    target.dispatchEvent(new view.MouseEvent('mouseup', init));
    target.click();
    return { ok: true };
  }

  /** Does a control laid over an account control say the same (or a plain "Submit" over it, sharing its wrapper)? */
  function sameAccountControl(over, el) {
    const said = A().intent(controlText(over));
    const own = A().intent(controlText(el));
    const filter =
      said === 'only' &&
      ['signin', 'signup', 'verify'].includes(own) &&
      !!over.parentElement &&
      over.parentElement.contains(el);
    return !!said && (said === own || filter);
  }

  /** Does a control laid over a step's control say the same (Workday's click filter over "Save and Continue")? */
  function sameStepControl(over, el) {
    const said = A().stepIntent(controlText(over));
    return !!said && said === A().stepIntent(controlText(el));
  }

  /**
   * Click one of the page's account controls: 'submit' (sign in / create account / confirm the code, only when
   * the page is ready), 'to-signup' or 'to-signin'. Checks everything again first. Returns { clicked } or
   * { refused }.
   */
  function click(which, scan, opts) {
    const st = analyze(scan, opts);
    if (!st.pure || st.kind === 'application' || st.kind === 'none')
      return { refused: 'not a sign-in or sign-up page', state: st };
    if (location.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname))
      return { refused: 'not a secure page', state: st };
    let target = null;
    if (which === 'submit') {
      if (!st.ready) return { refused: 'not ready', state: st };
      const { fields, results } = scan;
      const anchor = fields.find(
        (f, i) => results[i] && /^(account\.password|account\.passwordConfirm|otp)$/.test(results[i].type),
      );
      target = submitFor(st.kind, anchor && anchor.el);
    } else if (which === 'to-signup' || which === 'to-signin') {
      const label = which === 'to-signup' ? st.toSignup : st.toSignin;
      target = label ? controls(document).find((c) => c.text === label) : null;
    } else if (which === 'to-email' && st.kind === 'chooser') {
      target = controls(document).find((c) => c.intent === 'to-email' && c.text === st.toEmail) || null;
    }
    if (!target) return { refused: 'no such control', state: st };
    // The last word: the wording must still pass, and never a denied one.
    if (A().denied(target.text) || !A().intent(target.text)) return { refused: 'not an allowed control', state: st };
    const res = press(target.el);
    return res.ok ? { clicked: target.text, kind: st.kind, state: st } : { refused: res.reason, state: st };
  }

  /* ---------------------------------------------------- application steps */

  // "Step 2 of 6", Workday's "current step 2 of 6 My Experience".
  const STEP_OF = /\b(?:step|page|stage|part)\s+(\d{1,2})\s*(?:of|\/|out of)\s*(\d{1,2})\b/i;
  const CURRENT_STEP = '[aria-current="step"], [data-automation-id="progressBarActiveStep"]';
  const STEP_TEXT =
    'h1, h2, h3, h4, [role="heading"], [role="progressbar"], [class*="step" i], [class*="progress" i], [class*="wizard" i]';

  /** Where a multi-step application is: { step, total, label } (as far as the page says), or null when it shows no steps. */
  function progress(doc) {
    const current = Array.from(doc.querySelectorAll(CURRENT_STEP)).find(shown);
    if (current) {
      const label = U.cleanLabel(dom().textOf(current), 80);
      const m = label.match(STEP_OF);
      if (m) return { step: +m[1], total: +m[2], label };
      const list = current.closest('ol, ul, [role="list"], [role="tablist"]');
      const items = list ? Array.from(list.children).filter(shown) : [];
      const i = items.findIndex((c) => c === current || c.contains(current));
      return i >= 0 ? { step: i + 1, total: items.length, label } : { label };
    }
    for (const el of doc.querySelectorAll(STEP_TEXT)) {
      if (!shown(el) || el.closest('[data-jtf-ui]')) continue;
      const text = [el.getAttribute('aria-valuetext'), dom().textOf(el)].filter(Boolean).join(' ').slice(0, 300);
      const m = text.match(STEP_OF);
      if (m && +m[1] >= 1 && +m[1] <= +m[2]) return { step: +m[1], total: +m[2], label: U.cleanLabel(m[0], 80) };
    }
    return null;
  }

  /** The step's own way on: a "Next" or "Save and Continue" at the foot of its form (a bare "Continue" on a page of steps). */
  function nextControl(fields, steps) {
    const forward = controls(document).filter((c) => {
      const i = A().stepIntent(c.text);
      return i === 'next' || (i === 'continue' && steps);
    });
    const last = fields.length ? fields[fields.length - 1].el : null;
    const after = (c) => !!last && !!(last.compareDocumentPosition(c.el) & Node.DOCUMENT_POSITION_FOLLOWING);
    return forward.filter(after).pop() || forward[forward.length - 1] || null;
  }

  /**
   * What stands between an application's step and its next, from a scan: { application, progress, next (the words of
   * its "Next"), final (the page offers its submit, or is the last step: the person's), blockers (required fields
   * still empty, the terms, a CAPTCHA), errors, ready, signature (tells the next step from this one) }.
   */
  function stepState(scan) {
    const { fields, results } = scan;
    const st = progress(document);
    const out = {
      application: analyze(scan).kind === 'application',
      progress: st,
      next: '',
      final: false,
      blockers: [],
      errors: [],
      ready: false,
      signature: [
        location.href,
        st ? `${st.step}/${st.total} ${st.label || ''}` : '',
        ...fields.slice(0, 12).map((f) => JTF.matcher.questionText(f.desc).slice(0, 60)),
      ].join('|'),
    };
    if (!out.application) return out;
    out.final = controls(document).some((c) => A().submits(c.text)) || (!!st && st.total > 1 && st.step === st.total);
    const next = nextControl(fields, !!st);
    out.next = next ? next.text : '';
    const label = (f) => U.cleanLabel(JTF.matcher.questionText(f.desc), 60) || f.kind;
    fields.forEach((f, i) => {
      if (!isRequired(f) || inCaptcha(f.el) || JTF.fill.hasValue(f)) return;
      out.blockers.push({ kind: results[i] && results[i].type === 'consent' ? 'terms' : 'missing', label: label(f) });
    });
    const c = captcha(document);
    if (c && !c.solved) out.blockers.push({ kind: 'captcha', label: c.kind });
    out.errors = messages(document, ERRORS).filter((t) => !/^\*?\s*(indicates|denotes) a required/i.test(t));
    out.ready = !!next && !out.final && !out.blockers.length && !out.errors.length;
    return out;
  }

  /**
   * Click the step's own "Next" (`label`, as stepState() read it), when the step is still ready: everything on it
   * filled, no error showing, and not the step that submits. { clicked } or { refused }.
   */
  function advance(scan, label) {
    const st = stepState(scan);
    if (!st.application) return { refused: 'not an application', state: st };
    if (!st.ready || st.next !== label) return { refused: 'not ready', state: st };
    const target = nextControl(scan.fields, !!st.progress);
    if (!target || target.text !== label) return { refused: 'no such control', state: st };
    // The last word: the wording must still pass, and never one that sends.
    if (A().denied(target.text) || A().submits(target.text) || !A().stepIntent(target.text))
      return { refused: 'not an allowed control', state: st };
    const res = press(target.el, sameStepControl);
    return res.ok ? { clicked: target.text, state: st } : { refused: res.reason, state: st };
  }

  // The sections that hold your education and your jobs, one entry after another, by their headings.
  const ENTRY_SECTIONS = {
    edu: /^(?:education|education history|academic history|academic background|education and qualifications|qualifications)$/,
    exp: /^(?:work experience|experience|employment|employment history|work history|professional experience|previous employment|career history)$/,
  };
  const SECTION_HEADING = 'h1, h2, h3, h4, h5, h6, [role="heading"], legend';
  const DIALOGS = '[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"]';
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** The section headed "Education" or "Work Experience" (`kind` edu / exp) that has its own "Add": { el } or null. */
  function entrySection(kind) {
    const other = kind === 'edu' ? ENTRY_SECTIONS.exp : ENTRY_SECTIONS.edu;
    for (const h of document.querySelectorAll(SECTION_HEADING)) {
      if (!shown(h) || !ENTRY_SECTIONS[kind].test(U.normalize(dom().textOf(h)))) continue;
      for (let a = h.parentElement, i = 0; a && a !== document.body && i < 4; a = a.parentElement, i++) {
        // Never as far as the page around both sections.
        const heads = Array.from(a.querySelectorAll(SECTION_HEADING)).filter(shown);
        if (heads.some((x) => other.test(U.normalize(dom().textOf(x))))) break;
        if (controls(a).some((c) => A().stepIntent(c.text) === 'add')) return { el: a };
      }
    }
    return null;
  }

  /** How many entries a section holds: the distinct entries its fields are planned into. */
  function entriesIn(section, kind, scan) {
    const seen = new Set();
    scan.fields.forEach((f, i) => {
      const r = scan.results[i];
      if (section.el.contains(f.el) && r && r.type && r.type.startsWith(kind + '.')) seen.add(r.index || 0);
    });
    return seen.size;
  }

  /**
   * Make room for each of your education and job entries: in a section headed "Education" or "Work Experience" that
   * holds fewer entries than your profile has (Workday's My Experience starts with none), click its own "Add" ("Add
   * Another") once per missing entry, while each click adds one. A button that opens a dialog instead is closed again
   * and left alone. `scanner()` reads the page afresh. Returns how many entries were added.
   */
  async function addEntries(profile, scanner) {
    const want = {
      edu: (profile.education || []).filter((e) => e && (e.school || e.degree)).length,
      exp: (profile.experience || []).filter((e) => e && (e.company || e.title)).length,
    };
    let added = 0;
    for (const kind of ['edu', 'exp']) {
      for (let i = 0; i < 6; i++) {
        const section = entrySection(kind);
        if (!section) break;
        const before = entriesIn(section, kind, scanner());
        if (before >= want[kind]) break;
        const add = controls(section.el)
          .filter((c) => A().stepIntent(c.text) === 'add' && !A().denied(c.text))
          .pop();
        const dialogs = document.querySelectorAll(DIALOGS).length;
        if (!add || !press(add.el, sameStepControl).ok) break;
        let grew = false;
        for (let waited = 0; waited < 2500 && !grew; waited += 250) {
          await sleep(250);
          const now = entrySection(kind);
          grew = !!now && entriesIn(now, kind, scanner()) > before;
        }
        if (!grew) {
          if (document.querySelectorAll(DIALOGS).length > dialogs) JTF.fill.closeDialogs(document, dialogs);
          break;
        }
        added++;
      }
    }
    return added;
  }

  /* ------------------------------------------------------------- waiting */

  let waiter = null;

  /**
   * Watch the page until what blocked its submit is done (a CAPTCHA solved, the terms accepted), then tell the
   * background (which checks again and clicks). Gives up after `timeout` ms.
   */
  function wait(token, scanner, timeout) {
    stopWait();
    const started = Date.now();
    let timer = null;
    const send = (msg) =>
      JTF.api.runtime.sendMessage(Object.assign({ type: 'jtf:flow-ready', token }, msg)).catch(() => {});
    const check = () => {
      if (!waiter) return;
      const st = analyze(scanner());
      if (st.ready) {
        stopWait();
        send({});
      } else if (Date.now() - started > timeout) {
        stopWait();
        send({ timedOut: true });
      }
    };
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(check, 400);
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    // A solved CAPTCHA only changes a hidden field's value, which no observer sees: look every second too.
    const interval = setInterval(check, 1000);
    const onInput = () => setTimeout(check, 200);
    document.addEventListener('change', onInput, true);
    waiter = () => {
      observer.disconnect();
      clearInterval(interval);
      clearTimeout(timer);
      document.removeEventListener('change', onInput, true);
    };
    return true;
  }

  function stopWait() {
    if (waiter) waiter();
    waiter = null;
    return true;
  }

  JTF.flow = {
    analyze,
    click,
    stepState,
    advance,
    addEntries,
    wait,
    stopWait,
    captcha,
    inCaptcha,
    isRequired,
    portal: () => A().portal(location.href, hints()),
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
