'use strict';
// Job-portal accounts: which controls may ever be clicked, what pages say after a submit, the employer behind a
// shared portal host, password rules read from sign-up pages, and passwords made to fit them.
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers');

const { accounts, passwords, geo } = load();

test('the click allow-list: sign in, create account, the links between them, a code step', () => {
  const cases = {
    'Sign In': 'signin',
    'Log in': 'signin',
    Login: 'signin',
    'Sign in to apply at Moody’s': 'signin', // SuccessFactors' sign-in button
    'Continue to sign in': 'signin',
    'Create Account': 'signup',
    'Create an account': 'signup',
    'Register now': 'signup',
    'Sign up': 'signup',
    'Create your account ': 'signup', // SuccessFactors' link from sign-in to sign-up
    'Create a candidate profile': 'signup',
    'New user?': 'to-signup',
    'Don’t have an account? Sign up': 'to-signup',
    'Not registered yet? Register': 'to-signup',
    'Already have an account? Sign in': 'to-signin',
    'Back to sign in': 'to-signin',
    Continue: 'verify',
    Verify: 'verify',
    'Verify email': 'verify',
    Next: 'verify',
    Submit: 'only',
  };
  for (const [text, want] of Object.entries(cases)) assert.equal(accounts.intent(text), want, text);
});

test('the deny-list: applications, money, deleting, other sign-in services, resets, uploads', () => {
  for (const text of [
    'Apply',
    'Apply now',
    'Submit application',
    'Send application',
    'Review and submit',
    'Create account and submit application',
    'Withdraw application',
    'Delete account',
    'Pay now',
    'Checkout',
    'Sign in with Google',
    'Sign in with LinkedIn',
    'Continue with Microsoft',
    'Apply with Indeed',
    'Forgot your password?',
    'Reset password',
    'Upload from Dropbox',
    'Upload a Resume',
    'Sign out',
    'Cancel',
    'Continue as guest',
    'Sign in to apply with LinkedIn',
    'Finish',
    'Save Draft',
    'I agree',
    'Read and acknowledge the data privacy statement',
  ]) {
    const intent = accounts.intent(text);
    assert.ok(intent === null || intent === 'only', `${text} -> ${intent}`);
  }
  for (const text of ['Apply', 'Sign in with Google', 'Withdraw', 'Upload from Dropbox', 'Forgot password'])
    assert.equal(accounts.denied(text), true, text);
  assert.equal(accounts.denied('Sign in to apply at Moody’s'), false);
  assert.equal(accounts.denied('Create Account'), false);
});

test('what a page says after a submit', () => {
  const exists = [
    'An account with this email address already exists. Sign in',
    'This email is already registered.',
    'The email address you entered is already in use.',
    'User already exists',
    'A user with this email already exists',
    'Duplicate username',
  ];
  for (const t of exists) assert.equal(accounts.readMessages(t).exists, true, t);
  const bad = [
    'Invalid username or password. Please try again.',
    'The email or password you entered is incorrect.',
    'Incorrect password',
    'We could not sign you in.',
    'Login failed',
    'E-Mail-Adresse oder Kennwort ungültig',
  ];
  for (const t of bad) assert.equal(accounts.readMessages(t).badLogin, true, t);
  for (const t of [
    'If you already have an account, sign in.',
    'Email address registered with us will receive updates.',
    'Enter your email address and password (Credentials are case sensitive).',
    '*indicates a required field.',
  ]) {
    const said = accounts.readMessages(t);
    assert.deepEqual(said, { exists: false, badLogin: false, verifyEmail: false }, t);
  }
  // Workday's own words (live pages, October 2026).
  const wrong = 'You may have entered the wrong email address or password or your account might be locked.';
  assert.deepEqual(accounts.readMessages(wrong), { exists: false, badLogin: true, verifyEmail: false });
  for (const t of [
    'An email has been sent to you. Please verify your account.',
    'Verify your account before you sign in or request a verification email.',
    'We’ve sent you a verification email.',
    'Check your inbox to activate your account.',
  ]) {
    assert.equal(accounts.readMessages(t).verifyEmail, true, t);
    assert.equal(accounts.readMessages(t).badLogin, false, t);
    assert.equal(accounts.isVerifyNotice(t), true, t);
  }
  assert.equal(accounts.isVerifyNotice(wrong), false);
  assert.equal(
    accounts.isVerifyNotice('Please create an account with us to keep up to date with your application.'),
    false,
  );
});

test('Workday’s “Sign in with email” beside other services’ buttons', () => {
  for (const t of [
    'Sign in with email',
    'Sign In with Email',
    'Continue with email',
    'Sign in with your email address',
  ])
    assert.equal(accounts.intent(t), 'to-email', t);
  for (const t of ['Sign in with Google', 'Sign in with Apple', 'Sign in with LinkedIn', 'Apply with email'])
    assert.equal(accounts.intent(t), null, t);
});

test('the employer behind a shared portal host, and CAPTCHA frames', () => {
  assert.equal(
    accounts.portal('https://career8.successfactors.com/career?company=MoodysProd&career_ns=job_listing'),
    'company:moodysprod',
  );
  // After a POST the address has no company: the page's hidden career_company says it.
  assert.equal(
    accounts.portal('https://career8.successfactors.com/career?_s.crb=abc', {
      company: 'MoodysProd',
      careerCompany: true,
    }),
    'company:moodysprod',
  );
  assert.equal(accounts.portal('https://career5.sapsf.eu/portalcareer?company=AZGROUPPROD'), 'company:azgroupprod');
  assert.equal(accounts.portal('https://wd3.myworkdaysite.com/en-US/recruiting/acme/External'), 'tenant:acme');
  assert.equal(accounts.portal('https://acme.wd5.myworkdayjobs.com/en-US/careers/login'), '');
  assert.equal(accounts.portal('https://careers.example.com/login?company=Other'), '', 'not a shared portal');
  assert.equal(accounts.isCaptchaFrame('https://www.google.com/recaptcha/api2/anchor?ar=1&k=6Lc'), true);
  assert.equal(accounts.isCaptchaFrame('https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html'), true);
  assert.equal(
    accounts.isCaptchaFrame('https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile'),
    true,
  );
  assert.equal(accounts.isCaptchaFrame('https://client-api.arkoselabs.com/fc/gc/'), true);
  assert.equal(accounts.isCaptchaFrame('https://boards.greenhouse.io/embed/job_app'), false);
});

const SF_POLICY =
  'Password must be at least 8 characters long. Password must not be longer than 18 characters. Password must contain at least one upper case and one lower case letter. Password must contain at least one number or punctuation character. Password must not contain space or unicode characters.';

test('password rules read from sign-up pages', () => {
  const pick = (r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v && v !== 'any'));
  assert.deepEqual(pick(passwords.parseRules({ text: SF_POLICY, maxLength: 99 })), {
    minLength: 8,
    maxLength: 18,
    upper: true,
    lower: true,
    digitOrSymbol: true,
    noSpaces: true,
    ascii: true,
  });
  // Workday-style requirement list.
  assert.deepEqual(
    pick(
      passwords.parseRules({
        text: 'Password Requirements:\n• A minimum of 8 characters\n• One uppercase alphabetic character\n• One lowercase alphabetic character\n• One numeric character\n• One special character',
      }),
    ),
    { minLength: 8, upper: true, lower: true, digit: true, symbol: true },
  );
  const r = (text, extra) => passwords.parseRules(Object.assign({ text }, extra));
  assert.deepEqual(
    [r('Your password must be 8-20 characters long.').minLength, r('8-20 characters').maxLength],
    [8, 20],
  );
  assert.equal(r('Use 12 or more characters with a mix of letters, numbers & symbols').minLength, 12);
  assert.equal(r('Must be at least eight characters').minLength, 8);
  assert.equal(r('Must be no less than 8 and less than 21 characters.').maxLength, 20);
  assert.equal(r('Letters and numbers only.').symbols, 'none');
  assert.equal(r('Special characters are not allowed.').symbols, 'none');
  assert.equal(r('Must contain at least 1 special character (!@#$%^&*)').symbols, '!@#$%^&*');
  assert.equal(r('Allowed special characters: ! @ # $ %').symbols, '!@#$%');
  assert.equal(r('Password cannot contain the following characters: < > & " \'').forbidden, '<>&"\'');
  assert.equal(r('The characters < and > are not allowed.').forbidden, '<>');
  assert.equal(r('No more than 2 identical characters in a row.').maxRepeat, 2);
  assert.equal(r('Cannot contain 3 consecutive identical characters').maxRepeat, 2);
  assert.equal(r('Must begin with a letter').startLetter, true);
  assert.equal(r('Must not contain your name or email address').noPersonal, true);
  // A phone number's digits are not a password length.
  assert.equal(r('Phone number must be at least 10 digits').minLength, 0);
  assert.deepEqual(pick(r('', { minLength: 10, maxLength: 12, pattern: '[A-Za-z0-9]+' })), {
    minLength: 10,
    maxLength: 12,
    pattern: '[A-Za-z0-9]+',
  });
});

test('passwords made to fit, and passwords checked against, a page’s rules', () => {
  const pages = [
    passwords.parseRules({ text: SF_POLICY, maxLength: 99 }),
    passwords.parseRules({ minLength: 10, maxLength: 12, pattern: '[A-Za-z0-9]+' }),
    passwords.parseRules({ text: 'One special character (! @ # $ %). 10 to 16 characters. One uppercase letter.' }),
    passwords.parseRules({ text: 'Password cannot contain the following characters: ! @ # $ % ^ & * - _ = + ?' }),
    passwords.parseRules({ text: 'No repeated characters. Must start with a letter.', maxLength: 10 }),
  ];
  for (const rules of pages)
    for (let i = 0; i < 150; i++) {
      const pw = passwords.generatePassword({ rules });
      assert.deepEqual(passwords.checkPassword(pw, rules), [], `${pw} for ${JSON.stringify(rules)}`);
    }
  assert.equal(passwords.generatePassword({ rules: pages[0] }).length, 18, 'as long as the page allows, up to 20');
  assert.equal(passwords.generatePassword().length, 20, 'no rules: as before');
  const sf = pages[0];
  assert.deepEqual(passwords.checkPassword('Default-Password-Far-Too-Long', sf), ['longer than 18 characters']);
  assert.deepEqual(passwords.checkPassword('Pass word1', sf), ['contains a space']);
  assert.deepEqual(passwords.checkPassword('alllowercase1', sf), ['no capital letter']);
  assert.deepEqual(passwords.checkPassword('NoDigitsHere', sf), ['no number or special character']);
  assert.deepEqual(passwords.checkPassword('Moodys-Pass-24', sf), []);
  const personal = passwords.parseRules({ text: 'Must not contain your name or email address' });
  assert.deepEqual(passwords.checkPassword('Ada-Rocks-2024', personal, { email: 'ada@example.com', names: ['Ada'] }), [
    'contains your name or email',
  ]);
});

test('logins on shared portal hosts: one employer’s is not another’s', () => {
  const data = {
    credentials: [
      { host: 'career8.successfactors.com', portal: 'company:moodysprod', password: 'moodys' },
      { host: 'career8.successfactors.com', password: 'legacy' },
      { host: 'acme.wd5.myworkdayjobs.com', password: 'acme' },
    ],
  };
  const host = 'career8.successfactors.com';
  assert.equal(passwords.findCredential(data, host, 'company:moodysprod').password, 'moodys');
  assert.equal(passwords.findCredential(data, host, 'company:other').password, 'legacy', 'filled as a guess');
  assert.equal(passwords.findCredential(data, host, 'company:other', true), null, 'but no account is known there');
  assert.equal(passwords.findCredential(data, host, 'company:moodysprod', true).password, 'moodys');
  assert.equal(passwords.findCredential(data, 'acme.wd5.myworkdayjobs.com', '', true).password, 'acme');
});

test('dialling codes', () => {
  assert.equal(geo.dialCode('United Kingdom'), '44');
  assert.equal(geo.dialCode('USA'), '1');
  assert.equal(geo.countryOfDial('+1'), 'US');
  assert.equal(geo.countryOfDial('44'), 'GB');
  assert.equal(geo.countryOfDial('7'), 'RU');
  assert.equal(geo.countryOfDial('33'), 'FR');
  assert.deepEqual(geo.splitPhone('+44 7700 900123'), { code: '44', national: '7700 900123' });
  assert.deepEqual(geo.splitPhone('0044 (0)20 7946 0958'), { code: '44', national: '20 7946 0958' });
  assert.deepEqual(geo.splitPhone('+1-415-555-0100'), { code: '1', national: '415-555-0100' });
  assert.deepEqual(geo.splitPhone('+353 87 123 4567'), { code: '353', national: '87 123 4567' });
  assert.equal(geo.splitPhone('07700 900123'), null);
  assert.ok(
    geo.COUNTRIES.every((row) => geo.dialCode(row[0])),
    'every country has a code',
  );
});
