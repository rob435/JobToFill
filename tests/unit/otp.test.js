'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, installChrome } = require('./helpers');
const otp = require('../../extension/lib/otp.js');
const nylas = require('../../extension/lib/nylas.js');

const JTF = load();
const { store } = JTF;

const msg = (subject, body, extra) => ({
  id: 'm' + Math.random().toString(36).slice(2),
  subject,
  body,
  from: [{ name: 'Sender', email: 'noreply@example.com' }],
  date: Math.floor(Date.now() / 1000),
  ...extra,
});
const code = (subject, body, want) => (otp.findCode(msg(subject, body), want) || {}).code || null;

test('otp: finds the code in typical verification emails', () => {
  const workday = `<html><head><style>.x{color:#123456}</style></head><body>
    <div style="display:none">Your code 999999 preview</div>
    <p>Hello Ada,</p><p>Your verification code is:</p><p style="font-size:28px"><b>482913</b></p>
    <p>This code expires in 10 minutes.</p>
    <p>Acme Corp, 1600 Main Street, Suite 200, Mountain View, CA 94043</p><p>Ref: 12345678</p>
    <a href="https://acme.wd3.myworkdayjobs.com/en-US/careers?ref=55667788">Careers</a></body></html>`;
  assert.equal(code('Your Workday verification code', workday), '482913');
  assert.equal(code('482913 is your Greenhouse code', 'Use it to sign in.'), '482913');
  assert.equal(code('Confirm your email', 'Hi, enter 7731 to confirm. Order number 55443322.'), '7731');
  assert.equal(code('Sign in to Oracle', 'Your one-time passcode: K7Q2MX9. Do not share it.'), 'K7Q2MX9');
  assert.equal(code('Bestätigungscode', 'Ihr Bestätigungscode lautet 551 204.'), '551204');
  assert.equal(code('Security code', 'Your security code is 3048-11'), null, 'not a code shape');
  assert.equal(code('Your code', '<p>Use <strong>829 104</strong> to verify your account</p>'), '829104');
});

test('otp: ignores numbers that are not codes', () => {
  assert.equal(code('Welcome to Acme', 'Thanks for applying to job 123456. We got it on 03/10/2026.'), null);
  assert.equal(code('Application received', 'Reference 482913. Questions? Call 020 7946 0958.'), null);
  assert.equal(code('Your order', 'Order #554433 total $1234. Track at https://x.com/t/123456'), null);
  assert.equal(code('Newsletter', 'In 2026, 4500 people joined. 20% off for 7 days.'), null);
});

test('otp: the box decides the shape of the code', () => {
  assert.equal(code('Verify', 'Your verification code is 9921', { length: 6 }), null);
  assert.equal(code('Verify', 'Your verification code is 9921', { length: 4 }), '9921');
  assert.equal(code('Sign in', 'Your one-time passcode: K7Q2MX', { numeric: true }), null);
});

test('otp: finds the verify link and skips the others', () => {
  const body = `<a href="https://acme.com/unsubscribe?u=1">Verify preferences</a>
    <a href="https://acme.wd3.myworkdayjobs.com/verify?token=abc">Verify my account</a>
    <a href="https://acme.com/privacy">Privacy</a>`;
  const l = otp.findLink(msg('Verify your email', body), 'acme.wd3.myworkdayjobs.com');
  assert.equal(l.href, 'https://acme.wd3.myworkdayjobs.com/verify?token=abc');
  assert.equal(otp.findLink(msg('Hi', '<a href="https://acme.com/reset">Reset password</a>'), 'acme.com'), null);
});

test('otp: hosts, sites and company names', () => {
  assert.equal(otp.site('careers.acme.co.uk'), 'acme.co.uk');
  assert.equal(otp.site('acme.wd3.myworkdayjobs.com'), 'myworkdayjobs.com');
  assert.deepEqual(otp.hostTokens('acme.wd3.myworkdayjobs.com'), ['acme']);
  assert.deepEqual(otp.hostTokens('careers.acme.com'), ['acme']);
  assert.deepEqual(otp.hostTokens('jpmc.fa.oraclecloud.com'), ['jpmc']);
});

test('otp: whose email it is', () => {
  const from = (email, extra) =>
    msg('Your verification code', 'Code: 123456', { from: [{ name: 'X', email }], ...extra });
  const wd = 'acme.wd3.myworkdayjobs.com';
  assert.equal(otp.relevance(from('acme@myworkday.com'), [wd]), 'strong', 'same applicant tracking system');
  assert.equal(otp.relevance(from('talent@acme.com'), [wd]), 'strong', 'the company behind its tracking system');
  assert.equal(otp.relevance(from('no-reply@accounts.acme.com'), ['careers.acme.com']), 'strong', 'same site');
  assert.equal(otp.relevance(from('alerts@bank.com'), [wd]), 'none');
  assert.equal(
    otp.relevance(from('mailer@sendgrid.net', { body: '<a href="https://careers.acme.com/x">Open</a> Code: 1' }), [
      'careers.acme.com',
    ]),
    'strong',
    'links back to the site',
  );
  assert.equal(
    otp.relevance(from('mailer@sendgrid.net', { subject: 'Your Acme code' }), ['careers.acme.com']),
    'weak',
    'only names the company',
  );
  // A look-alike page is never a strong match for the real company's email.
  assert.notEqual(otp.relevance(from('security@barclays.co.uk'), ['barclays-verify.com']), 'strong');
  // Sign-in providers serve many sites: a Microsoft email isn't strong for a Microsoft-hosted page of someone else.
  assert.equal(
    otp.relevance(from('account-security-noreply@accountprotection.microsoft.com'), ['login.microsoftonline.com']),
    'none',
  );
});

test('otp: pick takes the newest strong match, offers weak ones, skips used and old mail', () => {
  const now = Math.floor(Date.now() / 1000);
  const hosts = ['acme.wd3.myworkdayjobs.com'];
  const strongOld = msg('Verification code', 'Your verification code is 111111', {
    from: [{ email: 'acme@myworkday.com' }],
    date: now - 100,
  });
  const strongNew = msg('Verification code', 'Your verification code is 222222', {
    from: [{ email: 'acme@myworkday.com' }],
    date: now - 10,
  });
  const bank = msg('Your bank code', 'Your security code is 999999', {
    from: [{ email: 'alerts@bank.com' }],
    date: now,
  });
  assert.equal(otp.pick([strongOld, bank, strongNew], { hosts }).code, '222222');
  assert.equal(otp.pick([strongOld, bank, strongNew], { hosts, used: [strongNew.id] }).code, '111111');
  assert.equal(otp.pick([bank], { hosts }), null, 'unrelated sender: nothing');
  assert.equal(otp.pick([bank], { hosts, explicit: true }).code, '999999', 'unless the person asked');
  assert.equal(otp.pick([strongOld], { hosts, since: (now - 50) * 1000 }), null, 'too old');
  const weak = msg('Your Acme code', 'Your code is 333333', { from: [{ email: 'x@mailer.net' }], date: now });
  const r = otp.pick([weak], { hosts });
  assert.equal(r.relevance, 'weak');
  assert.equal(r.code, '333333');
});

test('nylas: lists inboxes and reads messages with the key', async () => {
  const calls = [];
  const fake = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization });
    const u = new URL(url);
    if (u.pathname === '/v3/grants')
      return new Response(JSON.stringify({ data: [{ id: 'g1', email: 'ada@example.com', grant_status: 'valid' }] }));
    return new Response(
      JSON.stringify({
        data: [{ id: 'm1', subject: 'Code', from: [{ email: 'a@b.com' }], date: 5, body: '<p>1</p>' }],
      }),
    );
  };
  const config = { apiKey: ' nyk_123 ', region: 'eu', grantId: 'g1' };
  assert.deepEqual(await nylas.grants(config, { fetch: fake }), [
    { id: 'g1', email: 'ada@example.com', provider: '', status: 'valid' },
  ]);
  const list = await nylas.messages(config, { since: 1700000000000, fetch: fake });
  assert.equal(list[0].id, 'm1');
  const u = new URL(calls[1].url);
  assert.equal(u.origin, 'https://api.eu.nylas.com');
  assert.equal(u.pathname, '/v3/grants/g1/messages');
  assert.equal(u.searchParams.get('received_after'), '1700000000');
  assert.equal(calls[1].auth, 'Bearer nyk_123');
});

test('nylas: explains errors and retries without select', async () => {
  const bad = async () => new Response(JSON.stringify({ error: { type: 'unauthorized' } }), { status: 401 });
  await assert.rejects(nylas.grants({ apiKey: 'x' }, { fetch: bad }), (e) => e.code === 'key');
  await assert.rejects(nylas.grants({}, { fetch: bad }), (e) => e.code === 'setup');
  let n = 0;
  const noSelect = async (url) => {
    n++;
    if (new URL(url).searchParams.has('select'))
      return new Response(JSON.stringify({ error: { message: 'unknown query param: select' } }), { status: 400 });
    return new Response(JSON.stringify({ data: [] }));
  };
  assert.deepEqual(await nylas.messages({ apiKey: 'x', grantId: 'g' }, { fetch: noSelect }), []);
  assert.equal(n, 2);
});

test('store: Nylas connection is saved, backed up and restored', async () => {
  installChrome();
  assert.equal(await store.getNylas(), null);
  assert.equal(await store.hasData(), false);
  await store.setNylas({ apiKey: ' nyk_1 ', grantId: 'g1', email: 'ada@example.com' });
  // Connecting the inbox alone is worth a backup file, and rewrites it.
  assert.equal(await store.hasData(), true, 'a Nylas key alone is backed up');
  assert.equal(store.backsUp('nylas'), true);
  assert.deepEqual(await store.getNylas(), { region: 'us', apiKey: 'nyk_1', grantId: 'g1', email: 'ada@example.com' });
  assert.deepEqual(store.otpSettings(await store.getSettings()), { auto: true, links: true });
  const backup = await store.exportData();
  assert.equal(backup.nylas.apiKey, 'nyk_1');
  await store.saveAiSettings({ backupKeys: false });
  assert.equal((await store.exportData()).nylas, undefined, 'kept out with the other keys');
  installChrome();
  await store.importData(backup);
  assert.equal((await store.getNylas()).grantId, 'g1');
  await store.setNylas(null);
  assert.equal(await store.getNylas(), null);
});

test('otp: pages anyone can publish never get another account’s code', () => {
  const from = (email, extra) =>
    msg('Your verification code', 'Your verification code: 123456', { from: [{ name: 'X', email }], ...extra });
  // A free tracking-system subdomain named after a company is not that company.
  assert.notEqual(otp.relevance(from('service@paypal.com'), ['paypal.recruitee.com']), 'strong');
  // Google Forms and Microsoft Forms live on Google's and Microsoft's own domains.
  assert.notEqual(otp.relevance(from('no-reply@accounts.google.com'), ['docs.google.com']), 'strong');
  assert.notEqual(otp.relevance(from('no-reply@google.com'), ['docs.google.com']), 'strong');
  assert.notEqual(otp.relevance(from('account@microsoft.com'), ['forms.office.com']), 'strong');
  // A link to a help centre doesn't vouch for someone else's page on the same help desk.
  const help = from('alerts@bank.com', { body: 'Code: 123456 <a href="https://bank.zendesk.com/hc">Help</a>' });
  assert.notEqual(otp.relevance(help, ['evil.zendesk.com']), 'strong');
  assert.equal(otp.relevance(help, ['bank.zendesk.com']), 'strong', 'the exact host still counts');
  // Files on Oracle's storage aren't Oracle's sign-in page.
  assert.notEqual(otp.relevance(from('no-reply@oracle.com'), ['objectstorage.us-ashburn-1.oraclecloud.com']), 'strong');
  assert.equal(otp.relevance(from('no-reply@oracle.com'), ['jpmc.fa.us2.oraclecloud.com']), 'strong');
});

test('otp: short brands on country domains', () => {
  assert.equal(otp.site('jobs.bmw.de'), 'bmw.de');
  assert.equal(otp.site('www.ing.nl'), 'ing.nl');
  assert.equal(otp.site('careers.acme.com.au'), 'acme.com.au');
  const m = msg('Code', 'Your verification code is 123456', { from: [{ email: 'noreply@bmw.de' }] });
  assert.equal(otp.relevance(m, ['jobs.bmw.de']), 'strong');
});

test('otp: more code formats and hidden text', () => {
  assert.equal(
    code(
      'Security code for your application',
      'Copy and paste this code into the security code field on your application: Ab3dEf9h',
    ),
    'Ab3dEf9h',
  );
  assert.equal(code('Verify', 'Your verification code:123456'), '123456');
  assert.equal(code('Sign in', '<h1 style="display:none">Code 111111</h1><p>Your code is 222222</p>'), '222222');
  // An unclosed hidden paragraph doesn't swallow the one with the code.
  assert.equal(
    code('Verify', '<p style="display:none">preview<p>Your verification code is <b>654321</b></p>'),
    '654321',
  );
});

test('otp: sign-in approval links are never opened', () => {
  const alert = msg(
    'New sign-in to your account',
    '<p>Was this you?</p><a href="https://acme.com/confirm?t=1">Yes, confirm it was me</a>',
  );
  assert.equal(otp.findLink(alert, 'acme.com'), null);
  const approve = msg('Verify', '<a href="https://acme.com/login/approve?t=1">Verify and sign in</a>');
  assert.equal(otp.findLink(approve, 'acme.com'), null);
});

test('otp: Workday’s verification link, whatever page it sends you to afterwards', () => {
  const page = 'acme.wd3.myworkdayjobs.com';
  // Where the link goes afterwards names the sign-in page: that isn't what the link does.
  const onward = msg(
    'Verify your candidate account',
    `<p>Please verify your account.</p><a href="https://${page}/en-US/Acme/activate/tok123?redirect=%2Fen-US%2FAcme%2Flogin">Verify Account</a>
     <a href="https://${page}/en-US/Acme/login">Sign In</a>`,
  );
  assert.equal(
    otp.findLink(onward, page).href,
    `https://${page}/en-US/Acme/activate/tok123?redirect=%2Fen-US%2FAcme%2Flogin`,
  );
  // Its activation link under the site's own sign-in pages counts on that very host, nowhere else.
  const under = msg('Verify', `<a href="https://${page}/en-US/Acme/login/activate?token=t1">Verify Account</a>`);
  assert.equal(otp.findLink(under, page).href, `https://${page}/en-US/Acme/login/activate?token=t1`);
  const elsewhere = msg('Verify', '<a href="https://evil.example/login/activate?token=t1">Verify Account</a>');
  assert.equal(otp.findLink(elsewhere, page), null);
  // "Click here": the one link back to the page, in an email about verifying the account.
  const plain = msg(
    'Verify your candidate account',
    `<p>Please verify your email address.</p><a href="https://${page}/en-US/Acme/t/9f8e7d">Click here</a> <a href="https://www.workday.com/privacy">Privacy</a>`,
  );
  assert.equal(otp.findLink(plain, page).href, `https://${page}/en-US/Acme/t/9f8e7d`);
  // Not when the email has several such links, or isn't about verifying.
  const two = msg(
    'Verify your candidate account',
    `<p>Please verify your email address.</p><a href="https://${page}/en-US/Acme/t/1">Click here</a> <a href="https://${page}/en-US/Acme/jobs">See our jobs</a>`,
  );
  assert.equal(otp.findLink(two, page), null);
  assert.equal(
    otp.findLink(msg('Your application', `<a href="https://${page}/en-US/Acme/t/1">Click here</a>`), page),
    null,
  );
});
