/*
 * JobToFill — job-portal accounts: what a button or link on a sign-in or sign-up page does, what the page says
 * after a submit ("An account with this email already exists", "Invalid password"), which employer a shared
 * portal host is for, and which frames belong to CAPTCHA services.
 *
 * Signing in and creating accounts for you (Settings › "Sign in and create job-portal accounts for me") only
 * ever clicks what passes intent() here: a strict allow-list of sign-in / sign-up wording, never anything on
 * the deny-list (apply, submit, send, withdraw, delete, pay, "Sign in with Google"…). On an application, the only
 * clicks are those stepIntent() allows: a section's "Add" for another entry, and (Settings › "Move through
 * multi-step applications for me") a step's own "Next" or "Save and Continue", never anything that sends it.
 * Pure functions: used by the content scripts, the background and the unit tests. Texts are JTF.util.normalize()d
 * first.
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});
  const norm = (s) => JTF.util.normalize(s);

  // Never clicked, whatever else the text says: job applications, money, deleting, other sign-in services,
  // password resets, uploads, leaving.
  const NEVER =
    /\b(apply|applying|application|applications|withdraw|delete|remove|pay|payment|purchase|buy|order|checkout|unsubscribe|deactivate|forgot|forgotten|reset|recover|google|linked ?in|facebook|apple|microsoft|indeed|git ?hub|twitter|yahoo|amazon|sso|single sign|saml|dropbox|drive|upload|cancel|decline|reject|log ?out|sign ?out|guest|skip)\b/;
  // Allowed only as the one submit button of a pure sign-up or sign-in form.
  const ONLY_SUBMIT = /^(submit|send|save|done|ok|continue|next|proceed|finish|complete( registration)?|confirm)$/;

  const ACCOUNT_WORD = '(?:candidate |applicant |career |job seeker |user |new |personal |talent )*(?:account|profile)';
  const SIGN_IN =
    /^(?:sign|log) ?(?:in|on)(?: (?:now|here|securely|instead))?$|^(?:login|signin|log ?in now)$|^continue to (?:sign|log) ?in$/;
  // SuccessFactors: "Sign in to apply at Moody's" is the sign-in form's own button.
  const SIGN_IN_TO = /^(?:sign|log) ?in (?:to|and) (?:apply|continue)(?: (?:at|for|with|to) [a-z0-9 ]{1,40})?$/;
  const SIGN_UP = new RegExp(
    `^(?:(?:create|register|open|make|set up|setup|start) (?:an |my |your |a )?${ACCOUNT_WORD}(?: now)?|register(?: now)?|sign ?up(?: now)?|join(?: now| us)?|create)$`,
  );
  const TO_SIGN_UP = new RegExp(
    `^(?:(?:create|register|open|make|set up) (?:an |my |your |a )?${ACCOUNT_WORD}(?: here| now)?|register(?: here| now| for an account)?|sign ?up(?: here| now)?|new (?:user|candidate|applicant)s?(?: (?:register|sign ?up|create (?:an |your |a )?account)(?: here| now)?)?|(?:i m |i am )?new here|(?:don t|do not) have an account(?: yet)?(?: (?:register|sign ?up|create (?:an |one|account|an account))(?: here| now)?)?|not registered(?: yet)?(?: (?:register|sign ?up|create (?:an |your |a )?account)(?: here| now)?)?|first time (?:user|here|applicant|applying))$`,
  );
  const TO_SIGN_IN =
    /^(?:(?:sign|log) ?in(?: here| now| instead)?|login|already (?:have an account|registered|a member)(?: (?:sign|log) ?in(?: here| now)?)?|(?:back|go|return) to (?:sign|log) ?in|existing (?:user|candidate|applicant)s?(?: (?:sign|log) ?in)?)$/;
  const VERIFY =
    /^(?:continue|verify|confirm|next|ok|proceed|verify (?:code|e ?mail(?: address)?|and continue|my e ?mail)|confirm (?:code|e ?mail(?: address)?))$/;
  // Workday's "Sign in with email" beside "Sign in with Google / Apple / LinkedIn": your email and a password.
  const TO_EMAIL =
    /^(?:(?:sign|log) ?(?:in|on|up)|continue|register) (?:with|using|via) (?:your |an? )?e ?mail(?: address)?(?: and password)?$|^use (?:your )?e ?mail(?: address)?(?: instead)?$/;

  /**
   * What clicking a control with this text would do, for a page of the given kind:
   *   'signin'    the sign-in form's submit ("Sign in", "Log in", "Sign in to apply at Moody's")
   *   'signup'    the sign-up form's submit ("Create account", "Register")
   *   'to-signup' a link from a sign-in page to the sign-up page ("Create your account", "New user?")
   *   'to-signin' a link back to sign in ("Already have an account? Sign in")
   *   'verify'    the submit of an emailed-code step ("Continue", "Verify")
   *   'to-email'  a sign-in page's "Sign in with email", beside other services' buttons
   *   'only'      "Submit" / "Continue" / "Next": only as the one submit of a pure account form
   * or null. Anything on the deny-list is null.
   */
  function intent(text) {
    const t = norm(text).slice(0, 120);
    if (!t) return null;
    // "Sign in to apply at …": the rest of the text must still be harmless.
    if (SIGN_IN_TO.test(t))
      return NEVER.test(t.replace(/^(sign|log) ?in (to|and) (apply|continue)/, '')) ? null : 'signin';
    if (NEVER.test(t)) return null;
    if (TO_EMAIL.test(t)) return 'to-email';
    if (SIGN_IN.test(t)) return 'signin';
    if (SIGN_UP.test(t)) return 'signup';
    if (TO_SIGN_UP.test(t)) return 'to-signup';
    if (TO_SIGN_IN.test(t)) return 'to-signin';
    if (VERIFY.test(t)) return 'verify';
    if (ONLY_SUBMIT.test(t)) return 'only';
    return null;
  }

  // A multi-step application's own way on to its next step: only these words ("Save & Continue" reads "save continue").
  const NEXT_STEP =
    /^(?:next|next step|next page|next section|save (?:and )?(?:continue|next|proceed)|save (?:and )?go to (?:the )?next (?:step|page)|continue to (?:the )?next (?:step|page|section)|go to (?:the )?next (?:step|page|section))$/;
  // A bare "Continue" or "Proceed": only on a page that shows it is one step of several (the content side checks).
  const NEXT_PLAIN = /^(?:continue|proceed)$/;
  // Never on the way to the next step: anything that sends, finishes, agrees or pays.
  const SENDS = /\b(?:submit|send|finish|complete|confirm|review|done|agree|accept|sign|pay|withdraw)\b/;
  // A section's own "Add" for another entry: Workday's "Add" and "Add Another", Greenhouse's "+ Add another education".
  const ADD_ENTRY =
    /^add(?: another| more| new| an?)?(?: (?:work experience|experience|job|position|employment|role|education|school|degree|qualification|entry))?$/;
  // What sends an application ("Submit", "Submit Application", "Send application", "Finish"): its last step.
  const SUBMITS =
    /^(?:submit|send|finish|complete)\b|\bsubmit\b|\bsend (?:my |your |the )?application\b|^apply(?: now)?$/;

  /**
   * What clicking a control on an application would do, for the clicks allowed there: 'next' (a step's own "Next",
   * "Save and Continue"), 'continue' (a bare "Continue" or "Proceed": only on a page that is one step of several) or
   * 'add' (a section's "Add" for another entry). Null for anything else, and always for what sends it.
   */
  function stepIntent(text) {
    const t = norm(text).slice(0, 80);
    if (!t || NEVER.test(t) || SENDS.test(t)) return null;
    if (NEXT_STEP.test(t)) return 'next';
    if (NEXT_PLAIN.test(t)) return 'continue';
    if (ADD_ENTRY.test(t)) return 'add';
    return null;
  }

  /** Does this control send the application ("Submit", "Send application"): the step that is the person's? */
  const submits = (text) => SUBMITS.test(norm(text).slice(0, 80));

  /** Does this text name a control that must never be clicked (for reports and the tests)? */
  function denied(text) {
    const t = norm(text);
    return !!t && NEVER.test(t.replace(/^(sign|log) ?in (to|and) (apply|continue)\b/, ''));
  }

  // What a page says after a submit.
  const EXISTS =
    /\b(an? )?(user|account|profile|candidate|login)( account| profile)? (with|for|using|associated with|linked to) (this|that|the|your|these)( same| given| entered)? (e ?mail|user ?name|login)( address| id)?( already)? (exists|is already (registered|in use|taken|associated))|\b(this |that |the |your )?(e ?mail|user ?name)( address| id)? (you entered |provided )?(is |has )?already (been )?(registered|in use|taken|exists|used|associated with an?( existing| other)? (account|profile|user))|\b(e ?mail|user ?name)( address| id)? (is )?(in use|taken|not available)\b|\balready (an? )?(account|user|profile) (exists|registered)|\b(account|user ?name|user|profile|candidate) already exists\b|\balready have an account with (this|that|the) e ?mail|\bduplicate (account|user|e ?mail|user ?name)\b/;
  const BAD_LOGIN =
    /\b(invalid|incorrect|wrong|unrecogni[sz]ed|unknown) (user ?name|e ?mail( address)?|password|credentials|login|sign in|log in|combination)\b|\b(user ?name|e ?mail( address)?|password|login|credentials) (and|or|\/) (password|user ?name|e ?mail)( combination)? (is |are |was |were |you entered )*(invalid|incorrect|wrong|not (valid|correct|recogni[sz]ed))|\b(could not|couldn t|unable to|can t|cannot) (sign|log) (you )?in\b|\b(login|sign in|log in|authentication) (failed|unsuccessful|error)\b|\bpassword (is |was )?(incorrect|invalid|wrong)\b|\b(kennwort|passwort) ungultig\b|\bungultig(e)? (e mail|anmeldedaten|zugangsdaten)/;

  // The account was made and waits for the link the site emailed: Workday's "An email has been sent to you. Please
  // verify your account." after "Create Account", and its "Verify your account before you sign in or request a
  // verification email." when it is signed in to too soon.
  const VERIFY_EMAIL =
    /\b(an? |the )?(verification |confirmation |activation )?e ?mail (has been|was|have been|is being) sent\b|\bwe( ve| have)? (just )?(sent|e ?mailed) (you )?(an? )?(e ?mail|link|verification|activation|confirmation)\b|\b(please )?(verify|confirm|activate) your (account|e ?mail( address)?)\b|\bcheck your (e ?mail|inbox)\b|\b(account|e ?mail( address)?) (is |has )?not (yet )?(been )?(verified|activated|confirmed)\b|\bunverified (account|e ?mail)\b/;

  /** Does this one message say a link to verify the account was emailed (not an error to fix)? */
  const isVerifyNotice = (text) => VERIFY_EMAIL.test(norm(text).slice(0, 600));

  /** What a page's messages (errors, alerts) say about the account: { exists, badLogin, verifyEmail }. */
  function readMessages(text) {
    const t = norm(text).slice(0, 4000);
    return { exists: EXISTS.test(t), badLogin: BAD_LOGIN.test(t), verifyEmail: VERIFY_EMAIL.test(t) };
  }

  // Frames that belong to CAPTCHA services: nothing is filled or clicked inside them.
  const CAPTCHA_FRAME =
    /^https?:\/\/([^/]+\.)?(google\.com|recaptcha\.net|gstatic\.com)\/recaptcha\/|^https?:\/\/([^/]+\.)?(hcaptcha\.com|newassets\.hcaptcha\.com)\/|^https?:\/\/challenges\.cloudflare\.com\/|^https?:\/\/([^/]+\.)?(arkoselabs\.com|funcaptcha\.com|geetest\.com|friendlycaptcha\.(com|eu)|mtcaptcha\.com)\//i;
  const isCaptchaFrame = (url) => CAPTCHA_FRAME.test(String(url || ''));

  /**
   * Which employer a shared portal host is for, so a login saved for one employer isn't taken for another's:
   * every SuccessFactors company lives on career8.successfactors.com (…?company=MoodysProd), and Workday's
   * shared hosts carry the tenant in the path. '' when the host itself is the employer's.
   */
  function portal(url, hints) {
    let u;
    try {
      u = new URL(url);
    } catch (err) {
      return '';
    }
    const host = u.hostname.toLowerCase();
    const h = hints || {};
    // SuccessFactors pages say so on any host: their form carries a hidden "career_company".
    if (/(^|\.)(successfactors\.(com|eu)|sapsf\.(com|eu|cn))$/.test(host) || h.careerCompany) {
      const company = u.searchParams.get('company') || u.searchParams.get('career_company') || h.company || '';
      return company ? `company:${company.toLowerCase()}` : '';
    }
    if (/(^|\.)myworkdaysite\.com$/.test(host)) {
      const m = u.pathname.match(/^\/(?:[a-z]{2}-[A-Z]{2}\/)?recruiting\/([^/]+)/);
      return m ? `tenant:${m[1].toLowerCase()}` : '';
    }
    return '';
  }

  const accounts = { intent, stepIntent, submits, denied, readMessages, isVerifyNotice, isCaptchaFrame, portal };
  JTF.accounts = accounts;
  if (typeof module === 'object' && module.exports) module.exports = accounts;
})(typeof globalThis !== 'undefined' ? globalThis : this);
