'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, installChrome } = require('./helpers');
const T = require('../../extension/lib/tracker.js');
const nylas = require('../../extension/lib/nylas.js');

const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 20, 12);
const JS = [{ name: 'Jane Street Recruiting', email: 'recruiting@janestreet.com' }];

/** What classify() makes of an email from Jane Street: its kind only. */
const kind = (subject, text, from = JS) => T.classify({ from, subject, text }).kind;

/* -------------------------------------------------------------- classify */

test('tracker: confirmations, tests, interviews, offers and rejections, in the employers’ own words', () => {
  const cases = [
    // Received.
    [
      'Thank you for applying to Jane Street',
      'Hi Ada, Thank you for applying for the Software Engineer Intern position. Our team will review your application and be in touch. If your application is successful, you may be invited to complete an online assessment.',
      'received',
    ],
    [
      'Application received',
      'We have received your application and will be in touch. Unsuccessful candidates will be notified by email.',
      'received',
    ],
    [
      'Your Goldman Sachs application',
      'Thank you for your application. Our recruitment process includes online assessments, a video interview and a superday.',
      'received',
    ],
    // Tests.
    [
      'Online assessment',
      'We would like to invite you to complete our online assessment. Please complete it within 5 days.',
      'test',
    ],
    ['Reminder: complete your HackerRank test', 'Your test link expires in 2 days.', 'test'],
    [
      'Your assessment link',
      'Unfortunately the link has expired. Please complete your assessment with this new link: https://x',
      'test',
    ],
    [
      'Video interview',
      'Congratulations! You have been invited to complete a HireVue video interview. Please complete it by Friday.',
      'test',
    ],
    [
      'Invitation: Codility test from Citadel',
      'Citadel has invited you to take a Codility test. You have 7 days to start it.',
      'test',
    ],
    [
      'Lloyds Banking Group - Next steps',
      'Congratulations, you have been successful at the application stage and are invited to complete the Lloyds Banking Group online assessments. Please complete them by 20 November.',
      'test',
    ],
    [
      'Action required: Arctic Shores assessment',
      'Please play the Arctic Shores game-based assessment by Sunday.',
      'test',
    ],
    [
      'Thank you for completing your HireVue interview',
      'We have received your responses and will be in touch.',
      'test',
    ],
    // Interviews.
    [
      'Interview invitation',
      'We were impressed by your application and would like to invite you to a first-round interview with our team. Please let us know your availability.',
      'interview',
    ],
    [
      'Assessment centre',
      'We are pleased to offer you the opportunity to attend our assessment centre on 12 March.',
      'interview',
    ],
    [
      'Your application to Lloyds',
      'Thank you for completing the online assessment. We are pleased to let you know you have progressed to the next stage.',
      'interview',
    ],
    ['Superday', 'You have been invited to our Superday on 3 December.', 'interview'],
    [
      'Interview availability',
      'Could you share your availability for a 30-minute call with the hiring manager next week?',
      'interview',
    ],
    ['Schedule your interview', 'Please use the link below to book an interview slot with our team.', 'interview'],
    // Offers.
    ['Offer', 'We are delighted to offer you a place on our 2027 Summer Internship Programme.', 'offer'],
    ['Your offer', 'Congratulations! Please find attached your offer letter for the Summer Analyst position.', 'offer'],
    // Rejections, even when they mention the interview before.
    [
      'Your application',
      'Dear Ada, Thank you for your interest in Jane Street. Unfortunately, after careful consideration, we will not be moving forward with your application at this time, but if we have suitable roles we will be in touch.',
      'rejected',
    ],
    [
      'Next steps',
      'Thank you for your interview last week. Unfortunately we have decided to pursue other candidates whose experience more closely matches.',
      'rejected',
    ],
    ['Re: speculative', 'We regret to inform you that the position has been filled.', 'rejected'],
    [
      'Your application status',
      'We have reviewed your application and regret that we are unable to offer you a place on this occasion.',
      'rejected',
    ],
    [
      'Application update',
      'We wanted to let you know that we will not be progressing your application to the next stage.',
      'rejected',
    ],
    // Not news.
    ['New jobs for you', 'Jobs you may be interested in: Software Engineer at Jane Street.', null],
    ['Update', 'If you are not successful, we will let you know.', null],
    ['Weekly newsletter from Jane Street', 'Read our latest blog posts. Unsubscribe.', null],
    ['Your job alert: Software Engineer', '5 new jobs match your search.', null],
    ['Your application has been withdrawn', 'You withdrew your application.', null],
  ];
  for (const [subject, text, want] of cases) assert.equal(kind(subject, text), want, `${subject}: ${text}`);
});

test('tracker: the quote is the sentence that says it, and a test says what kind', () => {
  const r = T.classify({
    from: [{ name: 'HireVue', email: 'noreply@hirevue.com' }],
    subject: 'Your interview with Lloyds',
    text: 'Hi Ada,\nCongratulations! Lloyds Banking Group invites you to complete a video interview on HireVue by 22 November.\nGood luck.',
  });
  assert.deepEqual(r, {
    kind: 'test',
    detail: 'video',
    quote: 'Lloyds Banking Group invites you to complete a video interview on HireVue by 22 November.',
  });
  assert.equal(
    T.classify({ subject: 'Your coding challenge', text: 'Please take the HackerRank coding challenge within 7 days.' })
      .detail,
    'coding',
  );
  assert.equal(
    T.classify({ subject: 'Superday', text: 'We would like to invite you to our Superday.' }).detail,
    'assessment centre',
  );
});

test('tracker: an email’s body as text, without the thread it quotes', () => {
  const html =
    '<html><head><style>p{}</style></head><body><p>Dear Ada,</p><p>Unfortunately we won&rsquo;t be progressing&nbsp;your application.</p>' +
    '<div>On Tue, 3 Nov 2026 at 09:12, Ada &lt;ada@example.org&gt; wrote:</div><blockquote>Thank you for the interview</blockquote></body></html>';
  const text = T.plainText(html);
  assert.equal(text, 'Dear Ada,\nUnfortunately we won’t be progressing your application.');
  assert.equal(kind('Re: your application', text), 'rejected');
});

/* ----------------------------------------------------------------- match */

const APPS = [
  {
    id: 'js',
    date: NOW - 20 * DAY,
    url: 'https://job-boards.greenhouse.io/janestreet/jobs/123/apply',
    company: 'Jane Street Capital',
    role: 'Software Engineer Intern',
  },
  {
    id: 'lloyds',
    date: NOW - 20 * DAY,
    url: 'https://lloyds.wd3.myworkday.com/en-US/lloyds/job/London/Graduate_R1/apply',
    company: 'Lloyds Banking Group',
    role: 'Technology Graduate Programme',
  },
  {
    id: 'gs1',
    date: NOW - 20 * DAY,
    url: 'https://hdpc.fa.us2.oraclecloud.com/x',
    company: 'Goldman Sachs',
    role: 'Summer Analyst, Engineering',
  },
  {
    id: 'gs2',
    date: NOW - 18 * DAY,
    url: 'https://hdpc.fa.us2.oraclecloud.com/y',
    company: 'Goldman Sachs',
    role: 'Summer Analyst, Global Markets',
  },
  // Logged before the employer and role were kept: they come from the page's title.
  {
    id: 'citadel',
    date: NOW - 60 * DAY,
    url: 'https://boards.greenhouse.io/citadel/jobs/9',
    title: 'Job Application for Quant Intern at Citadel',
  },
  {
    id: 'man',
    date: NOW - 20 * DAY,
    url: 'https://www.man.com/careers/apply',
    company: 'Man Group',
    role: 'Quant Intern',
  },
  { id: 'optiver', date: NOW + 5 * DAY, company: 'Optiver', role: 'Trader Intern' },
];
const match = (from, subject, text) => T.match({ from, subject, text, at: NOW }, APPS);

test('tracker: an email goes on the application its sender, subject or words name', () => {
  // Greenhouse sends for the firm: its name is the sender's.
  assert.equal(
    match([{ name: 'Jane Street', email: 'no-reply@us.greenhouse-mail.io' }], 'Thank you for applying', 'Hi').id,
    'js',
  );
  // Workday writes from the tenant's own address.
  assert.equal(match([{ name: '', email: 'lloydsbankinggroup@myworkday.com' }], 'Your application', 'Hi').id, 'lloyds');
  // HackerRank names the employer only in its words.
  assert.equal(
    match(
      [{ name: 'HackerRank', email: 'support@hackerrankforwork.com' }],
      'Invitation to test',
      'Citadel has invited you to take a test.',
    ).id,
    'citadel',
  );
  // Man Group's own domain, though "Man" alone is every man on the web.
  assert.equal(match([{ name: 'Careers', email: 'careers@man.com' }], 'Your application', 'hi').id, 'man');
  assert.equal(match([{ name: 'Some Guy', email: 'x@y.com' }], 'Hello man', 'the man said'), null);
  // Applied to after the email arrived: not this one.
  assert.equal(match([{ name: 'Optiver', email: 'x@optiver.com' }], 'Interview', ''), null);
});

test('tracker: two applications at one firm are told apart by the role, never by taking the first', () => {
  const gs = [{ name: 'Goldman Sachs Recruiting', email: 'gs@gs.com' }];
  const either = match(gs, 'Update on your application', 'Unfortunately…');
  assert.deepEqual(either.ambiguous, ['gs1', 'gs2']);
  assert.match(either.why, /Goldman Sachs 2 times/);
  assert.equal(match(gs, 'Update on your Summer Analyst, Global Markets application', 'Unfortunately…').id, 'gs2');
});

test('tracker: who an application is with, from what was logged', () => {
  assert.deepEqual(T.employerOf(APPS[4]), {
    company: 'Citadel',
    role: 'Quant Intern',
    slug: 'citadel',
    forms: ['citadel'],
    caps: [],
    domains: [],
  });
  const lloyds = T.employerOf(APPS[1]);
  assert.equal(lloyds.slug, 'lloyds');
  assert.deepEqual(lloyds.forms, ['lloyds banking group', 'lloyds banking', 'lloyds']);
  assert.deepEqual(
    T.employerOf({ url: 'https://jobs.lever.co/palantir/abc', title: 'Palantir - Software Engineer' }).company,
    'Palantir',
  );
  assert.deepEqual(T.employerOf({ url: 'https://careers.janestreet.com/apply' }).domains, ['janestreet.com']);
});

test('tracker: worth reading in full: recruiting systems, employers applied to, an application’s words; never your own', () => {
  assert.equal(T.worth({ from: [{ email: 'no-reply@greenhouse.io', name: 'Acme' }], subject: 'hi' }, APPS), true);
  assert.equal(T.worth({ from: [{ email: 'news@citadel.com', name: 'Citadel' }], subject: 'hello' }, APPS), true);
  assert.equal(
    T.worth({ from: [{ email: 'x@acme.com', name: 'Acme' }], subject: 'Your interview on Tuesday' }, APPS),
    true,
  );
  assert.equal(
    T.worth({ from: [{ email: 'x@facebookmail.com', name: 'Facebook' }], subject: 'A new friend' }, APPS),
    false,
  );
  const mine = { from: [{ email: 'ada@example.org' }], subject: 'Re: your application' };
  assert.equal(T.worth(mine, APPS, { me: 'ada@example.org' }), false);
});

test('tracker: a later step of the same application is the same entry', () => {
  const first = {
    url: 'https://lloyds.wd3.myworkday.com/x/apply/step1',
    host: 'lloyds.wd3.myworkday.com',
    jobId: 'R1',
    company: 'Lloyds',
    role: 'Graduate',
    date: NOW - DAY,
    updatedAt: NOW - DAY,
  };
  assert.equal(
    T.sameApplication(
      first,
      { url: 'https://lloyds.wd3.myworkday.com/x/apply/step3', host: 'lloyds.wd3.myworkday.com', jobId: 'R1' },
      NOW,
    ),
    true,
  );
  assert.equal(
    T.sameApplication(first, { url: 'https://other', host: 'x', company: 'Lloyds', role: 'Graduate' }, NOW),
    true,
  );
  assert.equal(
    T.sameApplication(first, { url: 'https://other', host: 'x', company: 'Lloyds', role: 'Graduate' }, NOW + 20 * DAY),
    false,
  );
  assert.equal(
    T.sameApplication(first, { url: 'https://other', host: 'x', company: 'Lloyds', role: 'Summer intern' }, NOW),
    false,
  );
});

/* ---------------------------------------------------------------- stages */

const ev = (kind, days, extra = {}) => ({
  kind,
  at: NOW - days * DAY,
  messageId: `${kind}-${days}`,
  subject: kind,
  ...extra,
});

test('tracker: never backwards, a rejection keeps how far it got, an email counts once', () => {
  let a = { id: 'a', date: NOW - 30 * DAY };
  a = T.advance(a, ev('test', 20));
  a = T.advance(a, ev('received', 25)); // older and less: changes nothing
  assert.equal(a.stage, 'test');
  a = T.advance(a, ev('interview', 10));
  a = T.advance(a, ev('received', 5)); // a late "Thank you for applying"
  assert.equal(a.stage, 'interview');
  a = T.advance(a, ev('rejected', 2));
  assert.deepEqual([a.stage, a.reached, a.stageAt], ['rejected', 'interview', NOW - 2 * DAY]);
  const again = T.advance(a, ev('rejected', 2));
  assert.equal(again.events.length, a.events.length);
  // Read in any order, the same answer: a rejection read before the invitation it followed.
  let b = { id: 'b', date: NOW - 30 * DAY };
  b = T.advance(b, ev('rejected', 2));
  b = T.advance(b, ev('interview', 10));
  assert.deepEqual([b.stage, b.reached], ['rejected', 'interview']);
});

test('tracker: a stage set by hand wins over the emails before it, and later ones still move it on', () => {
  let a = T.advance({ id: 'a', date: NOW - 30 * DAY }, ev('interview', 10));
  a = T.setStage(a, 'applied', NOW - 5 * DAY); // the "interview" was a webinar invitation
  assert.equal(a.stage, 'applied');
  assert.equal(a.manual.stage, 'applied');
  a = T.advance(a, ev('test', 3));
  assert.equal(a.stage, 'test');
  a = T.setStage(a, 'withdrawn', NOW - 2 * DAY);
  a = T.advance(a, ev('rejected', 1));
  assert.deepEqual([a.stage, a.reached], ['withdrawn', 'test']);
  a = T.setStage(a, null);
  assert.equal(a.stage, 'rejected');
  // An offer after a rejection stands.
  const o = T.advance(T.advance({ id: 'o', date: NOW - 30 * DAY }, ev('rejected', 5)), ev('offer', 1));
  assert.equal(o.stage, 'offer');
});

/* --------------------------------------------------------- funnel, cuts */

/** n applications that ended as `events` say, filled 60 days ago. */
const apps = (n, ...events) =>
  Array.from({ length: n }, (_, i) =>
    events.reduce((a, [k, d, extra]) => T.advance(a, ev(k, d, { messageId: `${k}-${d}-${i}`, ...extra })), {
      id: `${events.map((e) => e[0]).join('-')}-${i}`,
      date: NOW - 60 * DAY,
    }),
  );

test('tracker: the funnel counts how far each got, and the rejections at each stage', () => {
  const list = [
    ...apps(6, ['rejected', 40]),
    ...apps(3, ['test', 50], ['rejected', 40]),
    ...apps(2, ['test', 50], ['interview', 30], ['rejected', 20]),
    ...apps(1, ['test', 50], ['interview', 30], ['offer', 10]),
    ...apps(2, ['received', 59]),
  ];
  const f = T.funnel(list, NOW);
  assert.deepEqual(
    f.stages.map((s) => [s.stage, s.count, s.movedOn]),
    [
      // A test, an interview or an offer means it was sent: they count as applied too.
      ['filled', 14, 8],
      ['applied', 8, 6],
      ['test', 6, 3],
      ['interview', 3, 1],
      ['offer', 1, 0],
    ],
  );
  assert.deepEqual(f.rejected, { screen: 6, test: 3, interview: 2, total: 11 });
  assert.equal(f.offers, 1);
  // Two that heard nothing since the confirmation two months ago: likely silent rejections.
  assert.equal(f.silent, 2);
});

test('tracker: where you’re being cut, once there are enough outcomes', () => {
  assert.match(T.diagnose(apps(3, ['rejected', 5]), NOW)[0].text, /^Too few outcomes yet .*: 3 so far/);
  const cv = T.diagnose([...apps(14, ['rejected', 40]), ...apps(4, ['test', 50], ['rejected', 40])], NOW);
  assert.match(cv[0].text, /^14 of 18 rejections came before any test or interview: your CV is the first thing to fix/);
  const tests = T.diagnose(
    [
      ...apps(4, ['test', 50, { detail: 'video' }], ['rejected', 40]),
      ...apps(2, ['test', 50, { detail: 'coding' }], ['rejected', 40]),
      ...apps(3, ['test', 50], ['interview', 30]),
    ],
    NOW,
  );
  assert.equal(tests[0].tone, 'warn');
  assert.match(
    tests[0].text,
    /^6 of 9 firms that sent you a test didn’t take you further \(4 after video interviews, 2 after coding tests\)/,
  );
  const interviews = T.diagnose(apps(5, ['interview', 30], ['rejected', 20]), NOW);
  assert.match(interviews[0].text, /^5 of 5 interviews ended in a rejection/);
  // No reply for a month is said apart, never as a rejection.
  const silent = T.diagnose([...apps(5, ['rejected', 40]), ...apps(3)], NOW);
  assert.match(
    silent[silent.length - 1].text,
    /^3 applications have had no reply for 30 days or more: likely silent rejections/,
  );
});

/* ----------------------------------------------------------------- nylas */

const config = { apiKey: 'nyk_x', region: 'us', grantId: 'g-1', email: 'ada@example.org' };

/** A fetch that answers with `reply(url)` and keeps what was asked. */
function fake(reply, log) {
  return async (url, init = {}) => {
    log.push({ url, init });
    const { status = 200, data = {} } = reply(url, init);
    return { ok: status < 400, status, text: async () => JSON.stringify(data) };
  };
}

test('nylas: messages listed a page at a time without their bodies, and one read in full', async () => {
  const log = [];
  const fetchFn = fake(
    (url) =>
      /\/messages\/m-2/.test(url)
        ? {
            data: {
              data: { id: 'm-2', subject: 'Interview', from: [{ email: 'a@b.co' }], date: 5, body: '<p>Hi</p>' },
            },
          }
        : {
            data: {
              data: [{ id: 'm-1', subject: 'Hello', from: [], date: 7, snippet: 'x', body: 'never kept' }],
              next_cursor: 'p2',
            },
          },
    log,
  );
  const page = await nylas.listMessages(config, {
    since: 1763000000000,
    until: 1763600000000,
    pageToken: 'p1',
    fetch: fetchFn,
  });
  assert.deepEqual(page, { messages: [{ id: 'm-1', subject: 'Hello', from: [], date: 7, snippet: 'x' }], next: 'p2' });
  const url = new URL(log[0].url);
  assert.equal(url.pathname, '/v3/grants/g-1/messages');
  assert.equal(url.searchParams.get('select'), 'id,subject,from,date,snippet');
  assert.equal(url.searchParams.get('received_after'), '1763000000');
  assert.equal(url.searchParams.get('received_before'), '1763600000');
  assert.equal(url.searchParams.get('page_token'), 'p1');
  assert.equal(url.searchParams.get('limit'), '200');
  const m = await nylas.message(config, 'm-2', { fetch: fetchFn });
  assert.equal(m.body, '<p>Hi</p>');
  assert.equal(new URL(log[1].url).pathname, '/v3/grants/g-1/messages/m-2');
});

test('nylas: an older API that refuses "select" is asked again without it', async () => {
  const log = [];
  const fetchFn = fake(
    (url) =>
      new URL(url).searchParams.has('select')
        ? { status: 400, data: { error: { message: 'unknown query parameter: select' } } }
        : { data: { data: [] } },
    log,
  );
  assert.deepEqual(await nylas.listMessages(config, { fetch: fetchFn }), { messages: [], next: '' });
  assert.equal(log.length, 2);
  await assert.rejects(nylas.listMessages({ apiKey: 'k' }), (e) => e.code === 'setup');
});

/* ----------------------------------------------------------------- store */

test('store: a later step of an application updates its entry, keeping the date it was first filled', async () => {
  installChrome();
  const JTF = load();
  require('../../extension/lib/tracker.js');
  const { store } = JTF;
  await store.clearHistory();
  const first = await store.addHistory({
    url: 'https://lloyds.wd3.myworkday.com/x/apply/1',
    host: 'lloyds.wd3.myworkday.com',
    title: 'Apply',
    filled: 9,
    company: 'Lloyds Banking Group',
    role: 'Technology Graduate Programme',
    jobId: 'R1',
  });
  assert.ok(first.id);
  assert.equal(first.stage, 'filled');
  const next = await store.addHistory({
    url: 'https://lloyds.wd3.myworkday.com/x/apply/3',
    host: 'lloyds.wd3.myworkday.com',
    title: 'Apply',
    filled: 4,
    company: '',
    role: '',
    jobId: 'R1',
  });
  assert.equal(next.id, first.id);
  const [only, ...rest] = await store.getHistory();
  assert.equal(rest.length, 0);
  assert.deepEqual(
    [only.date, only.filled, only.company, only.url],
    [first.date, 9, 'Lloyds Banking Group', 'https://lloyds.wd3.myworkday.com/x/apply/3'],
  );
  // An entry logged before entries had ids gets one, the same every time.
  await JTF.api.storage.local.set({ history: [{ date: 1, url: 'https://a', host: 'a', title: 'x', filled: 1 }] });
  const [old] = await store.getHistory();
  assert.equal(old.id, (await store.getHistory())[0].id);
  await store.setTracker({ unsorted: [{ messageId: 'm' }], seen: ['m'] });
  assert.deepEqual((await store.getTracker()).seen, ['m']);
});
