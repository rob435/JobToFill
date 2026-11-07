'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, installChrome } = require('./helpers');

const JTF = load();
require('../../extension/lib/jobpage.js');
const D = require('../../extension/lib/discover.js');

const FIX = path.join(__dirname, '..', 'fixtures', 'jobs');
const json = (n) => JSON.parse(fs.readFileSync(path.join(FIX, n), 'utf8'));
const NOW = Date.parse('2026-10-03T09:00:00Z');

/** A fetch that serves fixed bodies by URL (or by `METHOD url`), and records what was asked for. */
function mockFetch(routes, log = []) {
  return async (url, init = {}) => {
    const method = init.method || 'GET';
    log.push({ url, method, body: init.body });
    const route = routes[`${method} ${url}`] !== undefined ? routes[`${method} ${url}`] : routes[url];
    if (route === undefined) return { ok: false, status: 404, url, text: async () => 'Not found' };
    if (typeof route === 'function') return route(url, init);
    const body = typeof route === 'string' ? route : JSON.stringify(route);
    return { ok: true, status: 200, url, text: async () => body };
  };
}

const firm = (r) => D.firmFrom(r);

const REGISTRY = D.loadFirms({
  firms: [
    {
      n: 'Lansdowne Partners',
      a: ['Lansdowne Partners (UK) LLP'],
      d: 'lansdownepartners.com',
      c: ['London'],
      k: 'GB',
      e: 53,
      m: 12,
      f: 7,
      r: 1,
      w: 'Lansdowne_Partners',
      t: ['hedge'],
    },
    { n: 'Egerton Capital', d: 'egertoncapital.com', c: ['London'], k: 'GB', e: 36, m: 15, f: 3, r: 2, t: ['hedge'] },
    {
      n: 'Marshall Wace',
      d: 'mwam.com',
      c: ['London'],
      k: 'GB',
      e: 900,
      m: 60,
      r: 3,
      w: 'Marshall_Wace',
      t: ['hedge'],
    },
    { n: 'Man Group', d: 'man.com', c: ['London'], k: 'GB', e: 1800, m: 170, r: 4, t: ['hedge', 'quant'] },
    { n: 'HBK Capital Management', d: 'hbk.com', c: ['Dallas'], k: 'US', e: 198, m: 35.6, f: 10, r: 5, t: ['hedge'] },
    { n: 'Robey Warshaw', d: 'robeywarshaw.com', c: ['London'], k: 'GB', w: 'Robey_Warshaw', t: ['ib'] },
    { n: 'Nowhere Holdings', c: ['London'], k: 'GB', e: 20 },
  ],
});
const byName = (n) => REGISTRY.find((f) => f.name === n);

/* ------------------------------------------------------------- roles */

test('discover: student role titles, and the ones that only look like it', () => {
  const kinds = {
    '2027 Summer Internship Program – Trading, London': 'internship',
    'Quantitative Researcher - Intern': 'internship',
    '2027 January Off-Cycle Analyst (Strategic Advisory & Restructuring) Munich': 'internship',
    'Summer Analyst 2027 - Investment Banking': 'internship',
    'Werkstudent Data Engineering (m/w/d)': 'internship',
    'Women in Trading & Technology Insight Programme - 2027': 'insight',
    'Spring Week 2027': 'insight',
    'Quantitative Developer, Graduate': 'graduate',
    'Graduate Software Engineer 2027': 'graduate',
    'Internal Audit Associate': null,
    'International Equities Trader': null,
    'Head of Internship Programmes': null,
    'Senior Graduate Programme Manager': null,
    'Portfolio Manager': null,
    'Early Stage Investing Analyst': null,
  };
  for (const [title, kind] of Object.entries(kinds)) assert.equal(D.roleKind(title), kind, title);
});

/* ------------------------------------------------------------- names */

test('discover: firm names compare by their distinctive part, strictly', () => {
  assert.equal(D.normName('LANSDOWNE PARTNERS (UK) LLP'), 'lansdowne partners');
  assert.equal(D.coreName('HBK Capital Management, L.P.'), 'hbk');
  assert.ok(D.sameFirm('Lansdowne Partners (UK) LLP', 'Lansdowne Partners'));
  assert.ok(D.sameFirm('GSA Capital Partners LLP', 'GSA Capital'));
  assert.ok(D.sameFirm('Davidson Kempner Capital Management', 'Davidson Kempner'));
  assert.ok(!D.sameFirm('Capital Group', 'Capula Investment Management'));
  assert.ok(!D.sameFirm('Man Group', 'Mandarin Capital'));
  // Three letters is too little to go on unless the full names agree.
  assert.ok(!D.sameFirm('GSA', 'GSA Capital'));
});

test('discover: domains and websites', () => {
  assert.equal(D.domainOf('https://careers.brevanhoward.com/gb/en'), 'brevanhoward.com');
  assert.equal(D.domainOf('www.ruffer.co.uk'), 'ruffer.co.uk');
  assert.equal(D.siteOf('www.HBK.com/careers'), 'https://www.hbk.com');
  assert.equal(D.siteOf('https://www.linkedin.com/company/lansdowne-partners'), '');
  assert.equal(D.siteOf('not a site'), '');
});

/* ------------------------------------------------------------ search */

test('discover: search ranks reputable small firms and leaves out Trackr’s', () => {
  const trackr = { names: ['man group', 'man'], domains: ['man.com'] };
  const hits = D.search(REGISTRY, { niches: ['hedge'], place: 'london', size: 'mid', hideTrackr: true }, { trackr });
  const names = hits.map((h) => h.firm.name);
  assert.deepEqual(names.slice(0, 2).sort(), ['Egerton Capital', 'Lansdowne Partners']);
  assert.ok(names.includes('Marshall Wace'));
  assert.ok(!names.includes('Man Group'), 'on Trackr');
  assert.ok(!names.includes('HBK Capital Management'), 'Dallas, not London');
  assert.ok(!names.includes('Robey Warshaw'), 'not a hedge fund');
  assert.ok(hits[0].reasons.some((r) => /staff/.test(r)));
  // Shown (flagged) when not hidden.
  const all = D.search(REGISTRY, { niches: ['hedge'], place: 'london', size: 'any' }, { trackr });
  assert.equal(all.find((h) => h.firm.name === 'Man Group').flags.onTrackr, true);
});

test('discover: firms like the seeds rank first', () => {
  const seeds = [byName('Lansdowne Partners')];
  const hits = D.search(REGISTRY, { niches: [], place: 'any', size: 'any', seeds });
  assert.equal(hits[0].firm.name, 'Egerton Capital');
  assert.ok(hits[0].reasons.includes('Like Lansdowne Partners'));
  assert.ok(!hits.some((h) => h.firm.name === 'Lansdowne Partners'), 'the seed itself is left out');
});

test('discover: registry lookup by name, legal name or website', () => {
  assert.equal(D.lookup(REGISTRY, 'LANSDOWNE PARTNERS (UK) LLP').name, 'Lansdowne Partners');
  assert.equal(D.lookup(REGISTRY, 'https://www.hbk.com/careers').name, 'HBK Capital Management');
  assert.equal(D.lookup(REGISTRY, 'HBK').name, 'HBK Capital Management');
  assert.equal(D.lookup(REGISTRY, 'Citadel'), null);
});

/* ------------------------------------------------------------ careers */

test('discover: job boards a careers page embeds or links to', () => {
  const html = `
    <script src="https://boards.greenhouse.io/embed/job_board/js?for=hbkcapitalmanagement"></script>
    <a href="https://job-boards.greenhouse.io/embed/job_app?for=gsacapital&amp;token=7336091002">Apply</a>
    <a href="https://pjtpartners.wd1.myworkdayjobs.com/en-US/Students">Students</a>
    <a href="https://wd1.myworkdaysite.com/recruiting/pwp/PWP_Experienced_Opportunities">Jobs</a>
    <a href="https://jobs.eu.lever.co/acme-trading">Lever</a>
    <a href="https://apply.workable.com/capula-investment-management-ltd/j/ABC123/">Workable</a>
    <link href="https://cdn.phenompeople.com/CareerConnectResources/BHABHAGB/x.css">`;
  const boards = D.detectBoards(html, 'https://firm.example/careers');
  const ids = boards.map((b) => `${b.ats}:${b.slug}${b.site ? '/' + b.site : ''}`);
  assert.deepEqual(ids, [
    'greenhouse:hbkcapitalmanagement',
    'greenhouse:gsacapital',
    'lever:acme-trading',
    'workable:capula-investment-management-ltd',
    'workday:pjtpartners/Students',
    'workday:pwp/PWP_Experienced_Opportunities',
    'phenom:BHABHAGB',
  ]);
  const wd = boards.find((b) => b.slug === 'pwp');
  assert.equal(D.boardRequest(wd).url, 'https://wd1.myworkdaysite.com/wday/cxs/pwp/PWP_Experienced_Opportunities/jobs');
  assert.equal(
    D.boardRequest(boards.find((b) => b.ats === 'lever')).url,
    'https://api.eu.lever.co/v0/postings/acme-trading?mode=json',
  );
});

test('discover: careers links on a home page, and what isn’t one', () => {
  const html = `<nav><a href="/about">About</a><a href="/people/jane">Jane</a><a href="/join-us/">Join us</a>
    <a href="/careers/students">Students &amp; graduates</a><a href="https://www.linkedin.com/company/x">LinkedIn</a>
    <a href="https://boards.greenhouse.io/x">Open roles</a><a href="mailto:jobs@x.com">Email</a></nav>`;
  const urls = D.careerLinks(html, 'https://www.x.com/', 'x.com').map((l) => l.url);
  assert.deepEqual(urls, [
    'https://www.x.com/careers/students',
    'https://www.x.com/join-us/',
    'https://boards.greenhouse.io/x',
  ]);
});

test('discover: programme sentences and the deadline on a plain careers page', () => {
  const text = [
    'Careers',
    'Lansdowne Partners’ 2027 Summer Internship Programme in London offers the opportunity to gain hands-on experience.',
    'We ran a 2019 internship programme for the first time.',
    'Our internal audit team is growing.',
    'Please submit your CV and a paragraph about your degree to [email protected] by Friday 6th November',
  ].join('\n');
  const found = D.programmesFromText(text, NOW);
  assert.equal(found.length, 2);
  assert.equal(found[0].deadline, '2026-11-06');
  assert.match(found[1].text, /2027 Summer Internship Programme/);
  assert.equal(D.deadlineIn('Applications close on 15 January 2027.', NOW), '2027-01-15');
  // A date already well past this year means next year's.
  assert.equal(D.deadlineIn('Apply by 1 March', NOW), '2027-03-01');
});

test('discover: email addresses, including Cloudflare’s hidden ones', () => {
  // "internships@lansdownepartners.com" XOR 0x42.
  const key = 0x42;
  const hex =
    key.toString(16) +
    [...'internships@lansdownepartners.com'].map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, '0')).join('');
  const html = `<a href="/cdn-cgi/l/email-protection#${hex}">[email protected]</a> <a href="mailto:press@x.com">Press</a>
    <a href="mailto:campusrecruiting@pjtpartners.com\\">Campus</a>`;
  assert.deepEqual(D.emails(html), ['campusrecruiting@pjtpartners.com', 'internships@lansdownepartners.com']);
});

test('discover: every job board answer is read as roles', () => {
  const roles = (b, res) => D.parseBoard(b, res).map((j) => `${j.title} | ${j.location} | ${j.url}`);
  assert.deepEqual(
    roles(
      { ats: 'greenhouse', slug: 'x' },
      { json: { jobs: [{ title: 'Quant Intern', absolute_url: 'https://x/1', location: { name: 'London' } }] } },
    ),
    ['Quant Intern | London | https://x/1'],
  );
  assert.deepEqual(
    roles(
      { ats: 'lever', slug: 'x' },
      {
        json: [
          {
            text: 'Summer Analyst',
            hostedUrl: 'https://jobs.lever.co/x/1',
            categories: { location: 'NYC' },
            createdAt: NOW,
          },
        ],
      },
    ),
    ['Summer Analyst | NYC | https://jobs.lever.co/x/1'],
  );
  assert.deepEqual(
    roles(
      { ats: 'workday', slug: 'pwp', host: 'wd1.myworkdaysite.com', site: 'PWP' },
      {
        json: {
          jobPostings: [{ title: '2027 Summer Analyst', externalPath: '/job/NY/2027_R1', locationsText: 'New York' }],
        },
      },
    ),
    ['2027 Summer Analyst | New York | https://wd1.myworkdaysite.com/recruiting/pwp/PWP/job/NY/2027_R1'],
  );
  assert.deepEqual(
    roles(
      { ats: 'workable', slug: 'capula' },
      {
        json: {
          name: 'Capula',
          jobs: [{ title: '2027 Summer Internship', shortcode: 'AB12', city: 'London', country: 'United Kingdom' }],
        },
      },
    ),
    ['2027 Summer Internship | London, United Kingdom | https://apply.workable.com/capula/j/AB12/'],
  );
  const phenom = `<script>phApp.ddo = {"eagerLoadRefineSearch":{"data":{"jobs":[{"title":"3 – 6 Month Off Cycle Internship","city":"Geneva","country":"Switzerland","jobSeqNo":"BH1","applyUrl":"https://wd3.myworkdaysite.com/x"}]}},"note":"a } in a string"};</script>`;
  assert.deepEqual(roles({ ats: 'phenom', host: 'careers.bh.com', locale: '/gb/en' }, { text: phenom }), [
    '3 – 6 Month Off Cycle Internship | Geneva, Switzerland | https://wd3.myworkdaysite.com/x',
  ]);
  const oleeo =
    '<a href="/vx/lang-en-GB/mobile-0/appcentre-ext/brand-4/candidate/so/pm/1/pl/2/opp/123-2027-Summer-Analyst/en-GB">2027 Summer Analyst</a>';
  assert.deepEqual(
    roles({ ats: 'oleeo' }, { text: oleeo, url: 'https://pwpcareers.tal.net/vx/candidate/jobboard/vacancy/1/adv/' }),
    [
      '2027 Summer Analyst |  | https://pwpcareers.tal.net/vx/lang-en-GB/mobile-0/appcentre-ext/brand-4/candidate/so/pm/1/pl/2/opp/123-2027-Summer-Analyst/en-GB',
    ],
  );
});

const HBK_HOME = `<html><head><title>HBK Capital Management</title></head><body>${'x'.repeat(400)}
  <nav><a href="/about">About</a><a href="/careers">Careers</a></nav><p>HBK is a global investment firm.</p></body></html>`;
const HBK_CAREERS = `<html><body><h1>Careers at HBK</h1><a href="/careers/careers-openings">Current openings</a>
  <p>Our 2027 summer internship programme is open to penultimate-year students.</p></body></html>`;
const HBK_OPENINGS = `<html><body><div id="grnhse_app"></div>
  <script src="https://boards.greenhouse.io/embed/job_board/js?for=hbkcapitalmanagement"></script></body></html>`;

test('discover: careers follows the firm’s own links to its job board and keeps the student roles', async () => {
  const log = [];
  const fetch = mockFetch(
    {
      'https://www.hbk.com/': HBK_HOME,
      'https://www.hbk.com/careers': HBK_CAREERS,
      'https://www.hbk.com/careers/careers-openings': HBK_OPENINGS,
      'https://boards-api.greenhouse.io/v1/boards/hbkcapitalmanagement/jobs': {
        jobs: [
          {
            title: '2027 Summer Intern - Quantitative Research',
            absolute_url: 'https://www.hbk.com/careers/careers-openings?gh_jid=1',
            location: { name: 'London' },
          },
          {
            title: 'Senior Portfolio Manager',
            absolute_url: 'https://www.hbk.com/careers/careers-openings?gh_jid=2',
            location: { name: 'Dallas' },
          },
        ],
      },
    },
    log,
  );
  const r = await D.careers(firm({ n: 'HBK Capital Management', d: 'www.hbk.com' }), { fetch, now: NOW });
  assert.equal(r.status, 'roles');
  assert.deepEqual(
    r.roles.map((x) => [x.kind, x.title]),
    [['internship', '2027 Summer Intern - Quantitative Research']],
  );
  assert.equal(r.other, 1);
  assert.deepEqual(
    r.boards.map((b) => [b.ats, b.slug, b.found]),
    [['greenhouse', 'hbkcapitalmanagement', 'linked']],
  );
  assert.ok(r.pages.includes('https://www.hbk.com/careers'));
  assert.match(r.programmes[0].text, /2027 summer internship programme/);
  // The board was found on the site, so no slugs were guessed.
  assert.ok(!log.some((l) => /api\.lever\.co|ashbyhq|workable/.test(l.url)));
});

test('discover: a guessed board must carry the firm’s name', async () => {
  const fetch = mockFetch({
    'https://www.gsa.example/': `<title>GSA Capital</title>${'x'.repeat(400)}`,
    // Somebody else's board at the guessed address.
    'https://boards-api.greenhouse.io/v1/boards/gsacapitalpartners/jobs': {
      jobs: [{ title: 'Intern', absolute_url: 'https://x/1', company_name: 'GSA Logistics GmbH' }],
    },
    'https://apply.workable.com/api/v1/widget/accounts/gsacapitalpartners': {
      name: 'GSA Capital Partners',
      jobs: [{ title: 'Quantitative Researcher - Intern', shortcode: 'Q1' }],
    },
  });
  const r = await D.careers(firm({ n: 'GSA Capital Partners LLP', d: 'gsa.example' }), { fetch, now: NOW });
  assert.deepEqual(
    r.boards.map((b) => [b.ats, b.slug, b.found]),
    [['workable', 'gsacapitalpartners', 'guessed']],
  );
  assert.equal(r.roles[0].title, 'Quantitative Researcher - Intern');
  assert.ok(r.log.some((l) => /someone else/.test(l.outcome)));
});

test('discover: a site that turns robots away says so', async () => {
  const fetch = mockFetch({
    'https://qube.example/': () => ({
      ok: true,
      status: 202,
      url: 'https://qube.example/',
      text: async () => '<html>challenge</html>',
    }),
  });
  const r = await D.careers(firm({ n: 'Qube Research & Technologies', d: 'qube.example' }), {
    fetch,
    now: NOW,
    guess: false,
  });
  assert.equal(r.status, 'blocked');
});

/* ------------------------------------------------------------- watchlist */

test('discover: a watchlist check reports only what wasn’t there before', async () => {
  const board = { ats: 'greenhouse', slug: 'hbkcapitalmanagement' };
  let jobs = [{ title: 'Summer Intern 2027', absolute_url: 'https://x/1', location: { name: 'London' } }];
  const fetch = mockFetch({
    'https://boards-api.greenhouse.io/v1/boards/hbkcapitalmanagement/jobs': () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ jobs }),
    }),
  });
  const entry = { firm: byName('HBK Capital Management'), boards: [board], pages: [] };
  const first = await D.check(entry, { fetch, now: NOW });
  assert.equal(first.status, 'roles');
  assert.deepEqual(first.fresh, [], 'the first check is the baseline');
  jobs = [
    ...jobs,
    { title: 'Off-Cycle Internship (Credit)', absolute_url: 'https://x/2' },
    { title: 'Controller', absolute_url: 'https://x/3' },
  ];
  const second = await D.check({ ...entry, seen: first.keys }, { fetch, now: NOW + 864e5 });
  assert.deepEqual(second.fresh, ['r:https://x/2']);
});

const acmeJob = (n) => ({
  title: `Summer Internship ${n}`,
  absolute_url: `https://boards.greenhouse.io/acme/jobs/${n}`,
});
const acmeKey = (j) => D.itemKey({ title: j.title, url: j.absolute_url });
/** A watched firm whose Greenhouse board lists `board.jobs`, answering once `board.gate` (if any) settles. */
async function watchAcme(id) {
  const board = { jobs: [], gate: null };
  const fetch = mockFetch({
    'https://boards-api.greenhouse.io/v1/boards/acme/jobs': async () => {
      await board.gate;
      return { ok: true, status: 200, text: async () => JSON.stringify({ jobs: board.jobs }) };
    },
  });
  const entry = {
    id,
    firm: byName('HBK Capital Management'),
    boards: [{ ats: 'greenhouse', slug: 'acme' }],
    pages: [],
  };
  await JTF.store.saveWatch(entry);
  /** One check, merged as background.js runWatchChecks() merges it. */
  const check = async (meanwhile) => {
    const state = await JTF.store.getWatchState(id);
    const running = D.check({ ...entry, seen: state.seen }, { fetch, now: NOW });
    if (meanwhile) await meanwhile();
    const res = await running;
    return { res, next: await JTF.store.setWatchState(id, (now) => D.afterCheck(now, res, NOW)) };
  };
  return { board, check };
}

test('discover: a role listed all along stays seen, however many others came and went', async () => {
  installChrome();
  await JTF.store.loadAll();
  const { board, check } = await watchAcme('w1');
  // Months of checks: role 1 first, then 999 others that came and went.
  const old = [acmeJob(1), ...Array.from({ length: 999 }, (_, i) => acmeJob(1000 + i))];
  await JTF.store.setWatchState('w1', { seen: old.map(acmeKey), fresh: [] });
  // Today: role 1 still open, and one new role.
  board.jobs = [acmeJob(1), acmeJob(5000)];
  const a = await check();
  assert.deepEqual(a.res.fresh, [acmeKey(acmeJob(5000))], 'only the new role is new');
  assert.equal(a.next.seen.length, 1000, 'the seen list stays at its limit');
  assert.deepEqual(a.next.seen.slice(-2), [acmeKey(acmeJob(1)), acmeKey(acmeJob(5000))], 'what is listed goes last');
  await JTF.store.setWatchState('w1', { fresh: [] }); // "Mark as seen"
  const b = await check();
  assert.deepEqual(b.res.fresh, [], 'role 1, open all along, isn’t “new” again');
  assert.deepEqual(b.next.fresh, []);
  // A firm's site that doesn't answer keeps what was seen.
  board.jobs = [];
  const down = D.afterCheck(b.next, { ...b.res, status: 'unreachable', keys: [], roles: [], fresh: [] }, NOW);
  assert.equal(down.seen, b.next.seen);
});

test('discover: a check merges with what changed while it ran: “Mark as seen” stays, a removed firm stays removed', async () => {
  installChrome();
  await JTF.store.loadAll();
  const acme = await watchAcme('w2');
  await JTF.store.setWatchState('w2', { seen: [], fresh: [{ title: 'Summer Internship 9', url: 'https://x/9' }] });
  acme.board.jobs = [acmeJob(1)];
  let open;
  acme.board.gate = new Promise((resolve) => (open = resolve));
  // The board is slow to answer; meanwhile the person presses "Mark as seen".
  const { next } = await acme.check(async () => {
    await JTF.store.setWatchState('w2', { fresh: [] });
    open();
  });
  assert.deepEqual(
    next.fresh.map((f) => f.url),
    ['https://boards.greenhouse.io/acme/jobs/1'],
    'only the role found now is new: the one marked seen stays seen',
  );

  const gone = await watchAcme('w3');
  gone.board.jobs = [acmeJob(2)];
  await JTF.store.setWatchState('w3', { seen: [], fresh: [] });
  const after = await gone.check(() => JTF.store.removeWatch('w3'));
  assert.equal(after.next, null, 'nothing is written back for a firm removed during the check');
  assert.equal(await JTF.store.getWatchState('w3'), null);
});

/* ---------------------------------------------------------------- Trackr */

test('discover: Trackr’s company list, to leave out', async () => {
  const fixture = json('trackr-uk-finance-off-cycle.json');
  const fetch = mockFetch({
    'https://trackr.test/programmes?region=UK&industry=Finance&season=2026&type=off-cycle-internships': fixture,
  });
  const list = await D.trackrCompanies({ fetch, now: NOW, regions: ['UK'], base: 'https://trackr.test/programmes' });
  assert.equal(list.answered, 1);
  assert.ok(list.names.includes('hsbc'));
  assert.ok(list.domains.includes('hsbc.com'));
  assert.ok(!list.domains.some((d) => /greenhouse|workday/.test(d)));
  assert.ok(D.onList(list, firm({ n: 'HSBC Holdings plc', d: 'hsbc.com' })));
  assert.ok(!D.onList(list, byName('Lansdowne Partners')));
});

test('discover: a short name on the lists hides only the firm of that name', async () => {
  const fixture = {
    programmes: [
      { company: { name: 'Capital One' } },
      { company: { name: 'ION Group' } },
      { company: { name: 'One' } },
      { company: { name: 'Hudson River Trading' } },
    ],
  };
  const fetch = mockFetch({
    'https://trackr.test/programmes?region=UK&industry=Finance&season=2026&type=off-cycle-internships': fixture,
  });
  const list = await D.trackrCompanies({ fetch, now: NOW, regions: ['UK'], base: 'https://trackr.test/programmes' });
  assert.deepEqual(list.names.sort(), ['capital one', 'hudson river', 'hudson river trading', 'ion', 'one']);
  // "one" and "ion" are One's and ION Group's full names, not the start of everyone else's.
  for (const n of ['One Investment Management', 'ION Asset Management', 'One Capital Partners', 'Capital Group'])
    assert.equal(D.onList(list, firm({ n })), false, n);
  assert.ok(D.onList(list, firm({ n: 'ION Group Ltd' })), 'by its full name');
  assert.ok(D.onList(list, firm({ n: 'One' })));
  assert.ok(D.onList(list, firm({ n: 'Capital One Financial Corp' })), 'a listed name and more');
  assert.ok(D.onList(list, firm({ n: 'Hudson River Trading LLC' })));
  assert.ok(D.onList(list, firm({ n: 'HRT', a: ['Hudson River Trading Europe Ltd'] })), 'by an alias');
  // The core alone, without a full name to go on: four letters or more.
  const short = { names: ['one', 'ion', 'jump'] };
  assert.equal(D.onList(short, firm({ n: 'One Capital Partners' })), false);
  assert.equal(D.onList(short, firm({ n: 'Jump Trading LLC' })), true);
});

/* -------------------------------------------------------------------- AI */

test('discover: AI ideas are kept only when they check out', async () => {
  const chat = async () => ({
    json: {
      firms: [
        { name: 'Egerton Capital', website: 'egertoncapital.com', why: 'Tiger Cub' },
        {
          name: 'Trinity Street Asset Management',
          website: 'trinitystreet.example',
          city: 'London',
          why: 'Small London fund',
        },
        { name: 'Totally Made Up Partners', website: 'madeup.example', why: 'Invented' },
      ],
    },
  });
  const sec = (q) =>
    `https://api.adviserinfo.sec.gov/search/firm?query=${encodeURIComponent(q)}&nrows=5&start=0&wt=json`;
  const fetch = mockFetch({
    'https://trinitystreet.example/': `<title>Trinity Street Asset Management</title>${'x'.repeat(500)}`,
    [sec('Trinity Street Asset Management')]: {
      hits: {
        hits: [
          {
            _source: {
              firm_name: 'TRINITY STREET ASSET MANAGEMENT LLP',
              firm_source_id: '160000',
              firm_ia_scope: 'ACTIVE',
              firm_ia_address_details: '{"officeAddress":{"city":"LONDON","country":"United Kingdom"}}',
            },
          },
        ],
      },
    },
    // A real-looking website alone isn't enough.
    'https://madeup.example/': `<title>Totally Made Up Partners</title>${'x'.repeat(500)}`,
    [sec('Totally Made Up Partners')]: { hits: { hits: [] } },
  });
  const { found, rejected } = await D.suggest(chat, { niches: ['hedge'], place: 'london' }, REGISTRY, { fetch });
  const names = found.map((f) => f.firm.name).sort();
  assert.deepEqual(names, ['Egerton Capital', 'Trinity Street Asset Management']);
  const trinity = found.find((f) => f.firm.name === 'Trinity Street Asset Management');
  assert.equal(trinity.firm.crd, '160000');
  assert.equal(trinity.firm.site, 'https://trinitystreet.example');
  assert.deepEqual(
    rejected.map((r) => r.name),
    ['Totally Made Up Partners'],
  );
});

/* ----------------------------------------------------------------- store */

test('store: the watchlist is backed up; check results are not', async () => {
  installChrome();
  await JTF.store.loadAll();
  await JTF.store.saveWatch({
    id: 'crd:1',
    firm: byName('Lansdowne Partners'),
    boards: [],
    pages: ['https://x/careers/'],
  });
  await JTF.store.setWatchState('crd:1', { seen: ['a'], fresh: [{ title: 'Intern', url: 'https://x/1' }] });
  const states = await JTF.store.getWatchStates(['crd:1']);
  assert.equal(states['crd:1'].fresh.length, 1);
  const out = await JTF.store.exportData();
  assert.equal(out.watchlist.length, 1);
  installChrome();
  await JTF.store.importData(out);
  assert.equal((await JTF.store.getWatchlist())[0].firm.name, 'Lansdowne Partners');
  await JTF.store.removeWatch('crd:1');
  assert.deepEqual(await JTF.store.getWatchlist(), []);
});

/* ---------------------------------------------------------- more boards */

test('discover: Breezy, Rippling and Personio boards a page links to, and the requests that list them', () => {
  const html = `<a href="https://acme.breezy.hr/">Jobs</a> <a href="https://app.breezy.hr/signin">Employers</a>
    <iframe src="https://ats.rippling.com/en-GB/acme-robotics/jobs"></iframe>
    <a href="https://acme-gmbh.jobs.personio.com/">Karriere</a>`;
  const boards = D.detectBoards(html, 'https://acme.example/careers');
  assert.deepEqual(
    boards.map((b) => `${b.ats}:${b.slug}`),
    ['personio:acme-gmbh', 'breezy:acme', 'rippling:acme-robotics'],
  );
  const url = (b) => D.boardRequest(b) && D.boardRequest(b).url;
  assert.equal(url(boards[0]), 'https://acme-gmbh.jobs.personio.com/xml');
  assert.equal(url({ ats: 'personio', slug: 'acme' }), 'https://acme.jobs.personio.de/xml');
  assert.equal(url(boards[1]), 'https://acme.breezy.hr/json');
  assert.equal(url(boards[2]), 'https://api.rippling.com/platform/api/ats/v1/board/acme-robotics/jobs');
  assert.equal(url({ ats: 'bamboohr', slug: 'eastdilsecured' }), 'https://eastdilsecured.bamboohr.com/careers/list');
  assert.equal(url({ ats: 'pinpoint', slug: 'acme' }), 'https://acme.pinpointhq.com/postings.json');
  assert.equal(url({ ats: 'teamtailor', slug: 'acme' }), 'https://acme.teamtailor.com/jobs');
  assert.equal(url({ ats: 'jobvite', slug: 'acme' }), 'https://jobs.jobvite.com/acme/jobs');
  assert.equal(url({ ats: 'applied', slug: 'acme' }), 'https://acme.beapplied.com/');
  // A slug that isn't a host name can't be put in front of the board's domain.
  assert.equal(D.boardRequest({ ats: 'bamboohr', slug: 'evil.example/x' }), null);
  // iCIMS: one search for each kind of student role, in the address.
  assert.deepEqual(
    D.boardRequests(D.boardRequest({ ats: 'icims', slug: 'careers-acme' })).map((r) => r.url),
    [
      'https://careers-acme.icims.com/jobs/search?ss=1&in_iframe=1&searchKeyword=intern',
      'https://careers-acme.icims.com/jobs/search?ss=1&in_iframe=1&searchKeyword=graduate',
    ],
  );
});

test('discover: the new job boards’ answers are read as roles', () => {
  const roles = (b, res) => D.parseBoard(b, res).map((j) => `${j.title} | ${j.location} | ${j.url}`);
  const personio = `<?xml version="1.0" encoding="UTF-8"?>
<workzag-jobs>
<position>
<id>1234567</id>
<subcompany>Acme GmbH</subcompany>
<office>Berlin</office>
<additionalOffices><office>Munich</office></additionalOffices>
<department>Engineering</department>
<name>Werkstudent Software Engineering (m/w/d)</name>
<jobDescriptions><jobDescription><name>Your tasks</name><value><![CDATA[<p>Build things</p>]]></value></jobDescription></jobDescriptions>
<createdAt>2026-09-14T09:01:39+00:00</createdAt>
</position>
<position><id>7654321</id><office>Hamburg</office><name><![CDATA[Praktikum Marketing &amp; Sales]]></name></position>
</workzag-jobs>`;
  const p = D.parseBoard(
    { ats: 'personio', slug: 'acme' },
    { text: personio, url: 'https://acme.jobs.personio.de/xml' },
  );
  assert.deepEqual(
    p.map((j) => `${j.title} | ${j.location} | ${j.url} | ${j.posted}`),
    [
      'Werkstudent Software Engineering (m/w/d) | Berlin | https://acme.jobs.personio.de/job/1234567 | 2026-09-14',
      'Praktikum Marketing & Sales | Hamburg | https://acme.jobs.personio.de/job/7654321 | null',
    ],
  );
  assert.equal(D.roleKind(p[0].title), 'internship');
  assert.deepEqual(
    roles(
      { ats: 'bamboohr', slug: 'eastdilsecured' },
      {
        json: {
          meta: {},
          result: [
            { id: '170', jobOpeningName: '2027 Analyst (London)', location: { city: 'London', state: null } },
            { id: '171', jobOpeningName: 'Summer Intern', location: { city: 'Dallas', state: 'Texas' } },
          ],
        },
      },
    ),
    [
      '2027 Analyst (London) | London | https://eastdilsecured.bamboohr.com/careers/170',
      'Summer Intern | Dallas, Texas | https://eastdilsecured.bamboohr.com/careers/171',
    ],
  );
  assert.deepEqual(
    roles(
      { ats: 'pinpoint', slug: 'acme' },
      {
        json: {
          data: [
            {
              title: 'Summer Internship 2027',
              url: 'https://acme.pinpointhq.com/en/postings/0f1e',
              location: { name: 'London' },
              created_at: '2026-09-01T00:00:00Z',
            },
          ],
        },
      },
    ),
    ['Summer Internship 2027 | London | https://acme.pinpointhq.com/en/postings/0f1e'],
  );
  assert.deepEqual(
    roles(
      { ats: 'breezy', slug: 'acme' },
      {
        json: [
          {
            name: 'Software Engineering Intern',
            url: 'https://acme.breezy.hr/p/9a8b-software-engineering-intern',
            location: { name: 'Austin, TX' },
            published_date: '2026-09-02T00:00:00Z',
          },
        ],
      },
    ),
    ['Software Engineering Intern | Austin, TX | https://acme.breezy.hr/p/9a8b-software-engineering-intern'],
  );
  assert.deepEqual(
    roles(
      { ats: 'rippling', slug: 'acme-robotics' },
      {
        json: [
          {
            name: 'Data Science Intern',
            url: 'https://ats.rippling.com/acme-robotics/jobs/1b2c',
            workLocation: { label: 'San Francisco, CA' },
          },
        ],
      },
    ),
    ['Data Science Intern | San Francisco, CA | https://ats.rippling.com/acme-robotics/jobs/1b2c'],
  );
  const teamtailor = `<ul><li><a href="https://acme.teamtailor.com/jobs/4567890-summer-intern-engineering">
    <span title="Summer Intern, Engineering">Summer Intern, Engineering</span></a><div><span>Engineering</span> ·
    <span>Stockholm</span></div></li><li><a href="/jobs">All jobs</a></li>
    <li><a href="/jobs/4567890-summer-intern-engineering/applications/new">Apply</a></li></ul>`;
  assert.deepEqual(
    roles({ ats: 'teamtailor', slug: 'acme' }, { text: teamtailor, url: 'https://acme.teamtailor.com/jobs' }),
    ['Summer Intern, Engineering |  | https://acme.teamtailor.com/jobs/4567890-summer-intern-engineering'],
  );
  const icims = `<a href="https://careers-acme.icims.com/jobs/2345/summer-analyst-2027/job?in_iframe=1" class="iCIMS_Anchor">
    <span class="sr-only field-label">Title</span><h3>Summer Analyst 2027</h3></a>
    <a href="https://careers-acme.icims.com/jobs/search?pr=1&amp;in_iframe=1">Next</a>`;
  assert.deepEqual(
    roles(
      { ats: 'icims', slug: 'careers-acme' },
      { text: icims, url: 'https://careers-acme.icims.com/jobs/search?ss=1&in_iframe=1&searchKeyword=intern' },
    ),
    ['Summer Analyst 2027 |  | https://careers-acme.icims.com/jobs/2345/summer-analyst-2027/job'],
  );
  const jobvite = `<td class="jv-job-list-name"><a href="/acme/job/oAbC123x">Quant Research Intern</a></td>
    <a href="/acme/jobs/alerts">Job alerts</a><a href="/other/job/oZZZ">Someone else’s</a>`;
  assert.deepEqual(
    roles({ ats: 'jobvite', slug: 'acme' }, { text: jobvite, url: 'https://jobs.jobvite.com/acme/jobs' }),
    ['Quant Research Intern |  | https://jobs.jobvite.com/acme/job/oAbC123x'],
  );
  const applied = `<a href="/apply/xyz123ab">Graduate Policy Analyst</a><a href="/about">About</a>`;
  assert.deepEqual(roles({ ats: 'applied', slug: 'acme' }, { text: applied, url: 'https://acme.beapplied.com/' }), [
    'Graduate Policy Analyst |  | https://acme.beapplied.com/apply/xyz123ab',
  ]);
});

test('discover: a watchlist check searches an iCIMS board once for each kind of role', async () => {
  const base = 'https://careers-acme.icims.com/jobs/search?ss=1&in_iframe=1&searchKeyword=';
  const job = (id, title) => `<a href="https://careers-acme.icims.com/jobs/${id}/x/job?in_iframe=1">${title}</a>`;
  const fetch = mockFetch({
    [base + 'intern']: job(1, 'Summer Intern 2027'),
    [base + 'graduate']: job(2, 'Graduate Analyst 2027') + job(1, 'Summer Intern 2027'),
  });
  const res = await D.check(
    { firm: byName('HBK Capital Management'), boards: [{ ats: 'icims', slug: 'careers-acme' }], pages: [] },
    { fetch, now: NOW },
  );
  assert.deepEqual(
    res.roles.map((r) => r.title),
    ['Summer Intern 2027', 'Graduate Analyst 2027'],
  );
});

/* ---------------------------------------------------- careers, extended */

test('discover: boards and pages known already are checked, even for a firm without a website', async () => {
  const log = [];
  const fetch = mockFetch(
    {
      'https://tinyrobotics.breezy.hr/json': [
        {
          name: 'Robotics Software Intern',
          url: 'https://tinyrobotics.breezy.hr/p/1-robotics-software-intern',
          location: { name: 'Cambridge, UK' },
        },
        { name: 'Senior Controls Engineer', url: 'https://tinyrobotics.breezy.hr/p/2-senior-controls-engineer' },
      ],
      'https://tinyrobotics.example/careers': `<html><body><h1>Careers at Tiny Robotics</h1>
        <p>We build warehouse robots.</p></body></html>`,
    },
    log,
  );
  const firm = { ...D.firmFrom({ n: 'Tiny Robotics' }), source: 'hn', remote: true };
  const r = await D.careers(firm, {
    fetch,
    now: NOW,
    boards: [{ ats: 'breezy', slug: 'tinyrobotics' }],
    pages: ['https://tinyrobotics.example/careers'],
  });
  assert.equal(r.status, 'roles');
  assert.deepEqual(
    r.roles.map((x) => [x.kind, x.title]),
    [['internship', 'Robotics Software Intern']],
  );
  assert.deepEqual(
    r.boards.map((b) => [b.ats, b.slug, b.found, b.jobs]),
    [['breezy', 'tinyrobotics', 'linked', 2]],
  );
  assert.deepEqual(r.pages, ['https://tinyrobotics.example/careers']);
  assert.deepEqual(r.texts, [], 'with roles to show, nothing for the AI to read');
  assert.ok(!log.some((l) => /lever|greenhouse|ashby|workable/.test(l.url)), 'no slugs guessed');
  // A board from elsewhere on a host that isn't a board's is not followed.
  const odd = await D.careers(firm, {
    fetch: mockFetch({}),
    now: NOW,
    guess: false,
    boards: [{ ats: 'workday', slug: 'x', host: 'evil.example', site: 'Jobs' }],
  });
  assert.deepEqual(odd.boards, []);
});

test('discover: a Hacker News firm’s site that doesn’t name it is left alone', async () => {
  const home = `<html><head><title>The New York Times - Breaking News</title></head><body>${'World news. '.repeat(40)}
    <a href="/careers">Careers</a> <a href="https://boards.greenhouse.io/nytimes">Jobs at The Times</a></body></html>`;
  const routes = {
    'https://www.nytimes.com/': home,
    'https://www.nytimes.com/careers': '<html><body><h1>Careers at The Times</h1></body></html>',
    'https://zephyrlabs.breezy.hr/json': [
      { name: 'Software Engineering Intern', url: 'https://zephyrlabs.breezy.hr/p/1-software-engineering-intern' },
    ],
  };
  // A site worked out from a post (a header link, an address), not one the registry holds.
  const zephyr = { ...D.firmFrom({ n: 'Zephyr Labs', d: 'www.nytimes.com' }), id: 'hn:nytimes.com', source: 'hn' };
  const log = [];
  const r = await D.careers(zephyr, { fetch: mockFetch(routes, log), now: NOW });
  assert.equal(r.status, 'none');
  assert.deepEqual([r.boards, r.pages, r.roles], [[], [], []]);
  assert.deepEqual(
    r.log.map((l) => l.outcome),
    ['home page', 'doesn’t name the firm'],
  );
  const asked = log.map((l) => l.url);
  assert.deepEqual(
    asked.filter((u) => /nytimes/.test(u)),
    ['https://www.nytimes.com/'],
    'no careers pages, its boards or a board guessed from its domain',
  );
  // The boards its post links are still its own.
  const linked = await D.careers(zephyr, {
    fetch: mockFetch(routes),
    now: NOW,
    boards: [{ ats: 'breezy', slug: 'zephyrlabs' }],
  });
  assert.equal(linked.status, 'roles');
  assert.deepEqual(
    linked.roles.map((x) => x.title),
    ['Software Engineering Intern'],
  );
  // A registry firm's site is its own, whatever the home page says: it is read as before.
  const registry = await D.careers(D.firmFrom({ n: 'Zephyr Labs', d: 'www.nytimes.com' }), {
    fetch: mockFetch(routes),
    now: NOW,
    guess: false,
  });
  assert.deepEqual(
    registry.boards.map((b) => [b.ats, b.slug]),
    [['greenhouse', 'nytimes']],
  );
  assert.deepEqual(registry.pages, ['https://www.nytimes.com/careers']);
});

test('discover: a careers page with nothing for students gives its text for the AI to read', async () => {
  const careersPage = `<html><body><nav><a href="/">Home</a></nav><h1>Careers</h1>
    <p>We are always looking for talented people who love hard problems.</p>
    <p>Send your CV to <a href="mailto:jobs@quietcapital.example">jobs@quietcapital.example</a>.</p>
    <p>${'More about life here. '.repeat(600)}</p></body></html>`;
  const fetch = mockFetch({
    'https://www.quietcapital.example/': `<html><head><title>Quiet Capital</title></head><body>${'x'.repeat(400)}
      <a href="/careers">Careers</a></body></html>`,
    'https://www.quietcapital.example/careers': careersPage,
  });
  const r = await D.careers(firm({ n: 'Quiet Capital', d: 'www.quietcapital.example' }), {
    fetch,
    now: NOW,
    guess: false,
  });
  assert.equal(r.status, 'page');
  assert.equal(r.texts.length, 1);
  assert.equal(r.texts[0].url, 'https://www.quietcapital.example/careers');
  assert.match(r.texts[0].text, /^Careers\nWe are always looking for talented people/);
  assert.equal(r.texts[0].text.length, 8000);
  assert.deepEqual(r.emails, ['jobs@quietcapital.example']);
});

/* ------------------------------------------------ careers, live findings */

test('discover: programmes a page describes without a date, and what isn’t one', () => {
  // HBK's careers page, as pageText() gives it.
  const hbk = [
    'Current openings',
    'Resources',
    '• The HBK Summer Intern Experience',
    'Read a summary from two of our recent interns and learn more about what it’s like to be a part of the HBK family for a summer.',
    'View Article',
    'Meet an HBK Intern - Shray',
    'Shray joined our intern class of 2022 working with our Strategy team in Dallas. Shray graduated from the University of Texas at Austin.',
    'Tell us about your summer internship at HBK',
    'I interned on the Strategy team at HBK, and the best aspect of the internship was being part of multiple projects.',
    'I had an amazing internship experience with HBK.',
    'Looking for your next summer internship?',
    'Our internal audit team works with our international offices.',
  ].join('\n');
  assert.deepEqual(D.mentionsFromText(hbk, NOW), [
    {
      text: 'The HBK Summer Intern Experience — Read a summary from two of our recent interns and learn more about what it’s like to be a part of the HBK family for a summer.',
      kind: 'internship',
    },
    { text: 'Shray joined our intern class of 2022 working with our Strategy team in Dallas.', kind: 'internship' },
  ]);
  // Marshall Wace's internships page: a sentence and two headings, each with the line under it; not its cookie text.
  const mw = [
    'Internships',
    '• Interns',
    'At Marshall Wace, we annually offer a range of internship programmes across various teams. Our internships are meticulously structured.',
    'Technology Internship Programme',
    'Find out more about our Technology Internship available in London, New York, Singapore and Hong Kong.',
    'Find out more about our programme.',
    'Quantitative Research Internship Programme',
    'Find out more about our Quant Research Internship available in London.',
    'We use cookies on our website to give you the most relevant experience, including on our internship programme pages.',
  ].join('\n');
  assert.deepEqual(
    D.mentionsFromText(mw, NOW).map((m) => m.text),
    [
      'At Marshall Wace, we annually offer a range of internship programmes across various teams.',
      'Technology Internship Programme — Find out more about our Technology Internship available in London, New York, Singapore and Hong Kong.',
      'Quantitative Research Internship Programme — Find out more about our Quant Research Internship available in London.',
    ],
  );
  // Saying there is none, internships in general, and cookie text are not a programme.
  const none = [
    'We do not currently offer internships.',
    'There are no internships available at this time.',
    'We are not currently recruiting for our graduate programme.',
    'Internship programmes are a great way to start a career.',
    'Summer Internship Programme',
    'We don’t run an internship programme this year.',
  ].join('\n');
  assert.deepEqual(D.mentionsFromText(none, NOW), []);
  // A dated programme is programmesFromText's, not a mention; the kinds; at most four, the strongest kept.
  const mixed = [
    'Our 2027 Summer Internship Programme opens in September.',
    'Our Spring Insight Week gives first-year students a look at the trading floor.',
    'Business Operations Graduate Programme',
    'Find out more about our Business Operations graduate programme in London.',
    'Our interns work on live projects from their first day.',
    'Our placement year suits students on a sandwich degree.',
    'We offer internships to penultimate-year students in London and New York.',
  ].join('\n');
  assert.equal(D.programmesFromText(mixed, NOW).length, 1);
  assert.deepEqual(
    D.mentionsFromText(mixed, NOW).map((m) => [m.kind, m.text.slice(0, 40)]),
    [
      ['insight', 'Our Spring Insight Week gives first-year'],
      ['graduate', 'Business Operations Graduate Programme —'],
      ['internship', 'Our placement year suits students on a s'],
      ['internship', 'We offer internships to penultimate-year'],
    ],
    'the interns sentence, the weakest, makes way',
  );
  const long = `We offer a ten-week internship programme ${'with real work on the desk, '.repeat(10)}and a final presentation.`;
  const [clipped] = D.mentionsFromText(long, NOW);
  assert.ok(clipped.text.length <= 300 && clipped.text.endsWith('…'), clipped.text);
});

const HBK_PAGE = `<html><body><h1>Careers at HBK</h1>
  <p>HBK’s business is dynamic and fast paced, providing significant learning and career growth opportunities.</p>
  <p><a href="/careers/careers-openings">Current openings</a></p>
  <h2>Resources</h2>
  <h3>The HBK Summer Intern Experience</h3>
  <p>Read a summary from two of our recent interns and learn more about what it’s like to be a part of the HBK family for a summer.</p>
  <p><a href="/careers/a-day-in-the-life-of-an-intern">View Article</a></p>
  <h3>Meet an HBK Intern - Shray</h3>
  <p>Shray joined our intern class of 2022 working with our Strategy team in Dallas. Shray graduated from the University of Texas at Austin.</p>
  </body></html>`;
const HBK_STORY = `<html><body><h1>HBK Intern: Shray</h1>
  <p>Shray joined our intern class of 2022 working with our Strategy team in Dallas.</p>
  <h2>Tell us about your summer internship at HBK</h2>
  <p>I interned on the Strategy team at HBK, and the best aspect of the internship was being part of multiple projects.</p>
  </body></html>`;
const HBK_ROUTES = {
  'https://www.hbk.com/': HBK_HOME,
  'https://www.hbk.com/careers': HBK_PAGE,
  'https://www.hbk.com/careers/careers-openings': HBK_OPENINGS,
  'https://www.hbk.com/careers/a-day-in-the-life-of-an-intern': HBK_STORY,
  'https://boards-api.greenhouse.io/v1/boards/hbkcapitalmanagement/jobs': {
    jobs: [
      { title: 'Senior Portfolio Manager', absolute_url: 'https://www.hbk.com/careers/careers-openings?gh_jid=2' },
    ],
  },
};

test('discover: a careers page that describes an internship programme without dates is “described”', async () => {
  const r = await D.careers(firm({ n: 'HBK Capital Management', d: 'www.hbk.com' }), {
    fetch: mockFetch(HBK_ROUTES),
    now: NOW,
  });
  assert.equal(r.status, 'described');
  assert.deepEqual(r.programmes, []);
  assert.deepEqual(
    r.mentions.map((m) => [m.kind, m.text.split(' — ')[0]]),
    [
      ['internship', 'The HBK Summer Intern Experience'],
      ['internship', 'Shray joined our intern class of 2022 working with our Strategy team in Dallas.'],
    ],
    'once, though two pages say it',
  );
  assert.ok(r.texts.length >= 2, 'the AI may still read the pages');
  assert.deepEqual(
    r.boards.map((b) => [b.ats, b.jobs]),
    [['greenhouse', 1]],
  );
  // The watchlist reads the same, but mentions are not items to be new or seen.
  const res = await D.check(
    { firm: byName('HBK Capital Management'), boards: [], pages: ['https://www.hbk.com/careers'] },
    { fetch: mockFetch(HBK_ROUTES), now: NOW },
  );
  assert.equal(res.status, 'described');
  assert.equal(res.mentions.length, 2);
  assert.deepEqual([res.keys, res.fresh], [[], []]);
  assert.equal(D.afterCheck(null, res, NOW).status, 'described');
});

test('discover: links that are markup or a template, not an address', () => {
  const html = `<!--  <a href="--><!--" target="_blank"><i class="fa fa-twitter"></i></a>-->
    <a href="\${job.jobUrl}">\${job.title}</a> <a href="$%7Bjob.jobUrl%7D">Job</a> <a href="{{ job.url }}">Job</a>
    <a href="' + jobUrlWithUtm + '">Apply</a> <a href="/-/">Dash</a>
    <a href="Early Careers, https://www.mwam.com/join-us/early-careers, ">Discover More</a>
    <a href="/join-us/internships/">Internships</a> <a href="https://www.mwam.com/search?url=https://x.example/">Search</a>`;
  assert.deepEqual(
    D.links(html, 'https://www.mwam.com/join-us/early-careers/').map((l) => l.url),
    ['https://www.mwam.com/join-us/internships/', 'https://www.mwam.com/search?url=https://x.example/'],
  );
});

test('discover: careers links leave out blog posts, help centres, communities and sign-up pages', () => {
  const synthesia = `<a href="/post/internal-communication-videos">Internal Communications</a>
    <a href="/careers">Careers</a> <a href="/community">Join the community</a>
    <a href="https://community.synthesia.io/sign_up">Join</a> <a href="/join-us">Join us</a>
    <a href="https://jobs.synthesia.io/">Join our team</a> <a href="/join/">Join</a>
    <a href="/internships">Internships</a> <a href="/users/login">Join</a>
    <a href="/international-offices">International offices</a>`;
  assert.deepEqual(
    D.careerLinks(synthesia, 'https://www.synthesia.io/', 'synthesia.io')
      .map((l) => l.url)
      .sort(),
    [
      'https://jobs.synthesia.io/',
      'https://www.synthesia.io/careers',
      'https://www.synthesia.io/internships',
      'https://www.synthesia.io/join-us',
      'https://www.synthesia.io/join/',
    ],
  );
  const freeagent = `<a href="https://careers.freeagent.com/">Careers</a>
    <a href="https://support.freeagent.com/hc/en-gb/articles/18671037475986-Use-FreeAgent-with-your-accountant">Work with an accountant</a>
    <a href="https://help.freeagent.com/careers">Careers help</a> <a href="/blog/how-to-file">How to file</a>
    <a href="/work-with-us">Work with us</a>`;
  assert.deepEqual(
    D.careerLinks(freeagent, 'https://www.freeagent.com/', 'freeagent.com').map((l) => l.url),
    ['https://careers.freeagent.com/', 'https://www.freeagent.com/work-with-us'],
  );
});

test('discover: a careers page is read once, and only on the firm’s own site, never a PDF', async () => {
  const log = [];
  const pdf = 'https://static1.squarespace.com/static/61dd35c9/t/65e07104/1709207868101/Careers+Handbook+2024';
  const cdnPage = 'https://cdn.example-host.net/careers.html';
  const fetch = mockFetch(
    {
      'https://www.freeagent.com/': `<html><head><title>FreeAgent</title></head><body>${'x'.repeat(400)}
        <a href="https://careers.freeagent.com/">Careers</a></body></html>`,
      'https://careers.freeagent.com/': `<html><body><h1>Careers at FreeAgent</h1>
        <a href="https://careers.freeagent.com/?scroll_to=js-careers-jobs-block">View Jobs</a>
        <a href="https://careers.freeagent.com/#jobs">Jobs</a>
        <a href="/s/Careers-Handbook-2024">Careers Handbook</a> <a href="/careers-elsewhere">Careers elsewhere</a></body></html>`,
      // Squarespace's file links redirect to its CDN.
      'https://careers.freeagent.com/s/Careers-Handbook-2024': () => ({
        ok: true,
        status: 200,
        url: pdf,
        text: async () => '%PDF-1.7\n%âãÏÓ\n1 0 obj << /Type /Catalog >> endobj careers internship programme',
      }),
      'https://careers.freeagent.com/careers-elsewhere': () => ({
        ok: true,
        status: 200,
        url: cdnPage,
        text: async () =>
          '<html><body><h1>Careers</h1><a href="https://cdn.example-host.net/jobs">Jobs</a></body></html>',
      }),
    },
    log,
  );
  const r = await D.careers(firm({ n: 'FreeAgent', d: 'freeagent.com' }), { fetch, now: NOW, guess: false });
  assert.deepEqual(r.pages, ['https://careers.freeagent.com/']);
  assert.deepEqual(
    r.texts.map((t) => t.url),
    ['https://careers.freeagent.com/'],
  );
  const asked = log.map((l) => l.url);
  assert.equal(
    asked.filter((u) => u.startsWith('https://careers.freeagent.com/?') || u === 'https://careers.freeagent.com/')
      .length,
    1,
  );
  assert.ok(!asked.includes('https://cdn.example-host.net/jobs'), 'nothing followed from another host');
  assert.ok(r.log.some((l) => l.url === pdf && l.outcome === 'PDF, not read'));
  assert.ok(r.log.some((l) => l.url === cdnPage && l.outcome === 'not the firm’s site'));
  // A watchlist check doesn't read a PDF either.
  const res = await D.check(
    {
      firm: firm({ n: 'FreeAgent', d: 'freeagent.com' }),
      pages: ['https://careers.freeagent.com/s/Careers-Handbook-2024'],
    },
    { fetch, now: NOW },
  );
  assert.deepEqual([res.status, res.programmes, res.mentions], ['quiet', [], []]);
  // A page the firm's own post links is read wherever it lands.
  const posted = await D.careers(
    { ...firm({ n: 'FreeAgent' }), source: 'hn' },
    { fetch, now: NOW, guess: false, pages: ['https://careers.freeagent.com/careers-elsewhere'] },
  );
  assert.deepEqual(posted.pages, [cdnPage]);
});

test('discover: Marshall Wace’s internships page, linked, is read after its careers pages', async () => {
  const log = [];
  const fetch = mockFetch(
    {
      'https://www.mwam.com/': `<html><head><title>Marshall Wace</title></head><body>${'x'.repeat(400)}
        <a href="/join-us/">Join Us</a></body></html>`,
      'https://www.mwam.com/join-us/': `<html><body><h1>Join Our Team</h1>
        <a href="Early Careers, https://www.mwam.com/join-us/early-careers, ">Discover More</a>
        <!-- <a href="--><!--" target="_blank">Twitter</a> -->
        <a href="/join-us/benefits/">Benefits</a> <a href="/join-us/internships/">Internships</a></body></html>`,
      'https://www.mwam.com/join-us/benefits/': '<html><body><h1>Benefits</h1></body></html>',
      'https://www.mwam.com/join-us/internships/': `<html><body><h1>Internships</h1>
        <p>At Marshall Wace, we annually offer a range of internship programmes across various teams.</p>
        <h2>Technology Internship Programme</h2>
        <p>Find out more about our Technology Internship available in London, New York, Singapore and Hong Kong.</p>
        <h2>Quantitative Research Internship Programme</h2>
        <p>Find out more about our Quant Research Internship available in London.</p></body></html>`,
      'https://boards-api.greenhouse.io/v1/boards/marshallwace/jobs': {
        jobs: [
          {
            title: 'MBA Intern',
            absolute_url: 'https://boards.greenhouse.io/marshallwace/jobs/1',
            company_name: 'Marshall Wace',
          },
        ],
      },
    },
    log,
  );
  const r = await D.careers(firm({ n: 'Marshall Wace', d: 'mwam.com' }), { fetch, now: NOW });
  assert.equal(r.status, 'roles');
  assert.deepEqual(
    r.roles.map((x) => x.title),
    ['MBA Intern'],
  );
  assert.ok(r.pages.includes('https://www.mwam.com/join-us/internships/'));
  assert.deepEqual(
    r.mentions.map((m) => m.text.split(' — ')[0]),
    [
      'At Marshall Wace, we annually offer a range of internship programmes across various teams.',
      'Technology Internship Programme',
      'Quantitative Research Internship Programme',
    ],
  );
  assert.ok(!log.some((l) => /\/--$|Early%20Careers/.test(l.url)), 'no markup taken for an address');
});

test('discover: a guessed board with jobs wins over the firm’s empty ones, and a short name on its domain will do', async () => {
  const log = [];
  const fetch = mockFetch(
    {
      'https://www.wayve.ai/': `<html><head><title>Wayve</title></head><body>${'x'.repeat(400)}</body></html>`,
      'https://boards-api.greenhouse.io/v1/boards/wayve/jobs': { jobs: [] },
      'https://api.ashbyhq.com/posting-api/job-board/wayve': {
        jobs: [
          { title: 'Research Scientist Intern', jobUrl: 'https://jobs.ashbyhq.com/wayve/1', location: 'London' },
          { title: 'Senior Software Engineer', jobUrl: 'https://jobs.ashbyhq.com/wayve/2', location: 'London' },
        ],
      },
      'https://apply.workable.com/api/v1/widget/accounts/wayve': { name: 'Wayve', jobs: [] },
    },
    log,
  );
  const r = await D.careers(firm({ n: 'Wayve', d: 'wayve.ai', t: ['ai'] }), { fetch, now: NOW });
  assert.deepEqual(
    r.boards.map((b) => [b.ats, b.slug, b.found, b.jobs]),
    [['ashby', 'wayve', 'guessed', 2]],
  );
  assert.equal(r.status, 'roles');
  assert.deepEqual(
    r.roles.map((x) => x.title),
    ['Research Scientist Intern'],
  );
  // Ashby gives no company name: "wayve" is the whole name and the domain, so it is the firm's. A slug that is
  // only the start of the name isn't, however long.
  const other = await D.careers(firm({ n: 'Wayve Robotics Research', d: 'wrr.example' }), {
    fetch: mockFetch({ 'https://api.ashbyhq.com/posting-api/job-board/wayverobotics': { jobs: [] } }),
    now: NOW,
  });
  assert.deepEqual(other.boards, []);
  assert.ok(other.log.some((l) => /ashbyhq.*wayverobotics/.test(l.url) && /someone else/.test(l.outcome)));
});

test('discover: a firm without a website gets one guessed from its name, when the page there names it', async () => {
  const log = [];
  const robey = firm({ n: 'Robey Warshaw LLP', c: ['London'], k: 'GB', t: ['ib'] });
  const fetch = mockFetch(
    {
      'https://www.robeywarshaw.com/': `<html><head><title>This domain is for sale</title></head><body>${'Buy this domain. '.repeat(30)}</body></html>`,
      'https://www.robeywarshaw.co.uk/': `<html><head><title>Robey Warshaw</title></head><body>${'x'.repeat(400)}
        <a href="/careers">Careers</a></body></html>`,
      'https://www.robeywarshaw.co.uk/careers': `<html><body><h1>Careers</h1>
        <p>We offer a small number of summer internships to penultimate-year students each year.</p></body></html>`,
    },
    log,
  );
  const r = await D.careers(robey, { fetch, now: NOW });
  assert.equal(r.site, 'https://www.robeywarshaw.co.uk');
  assert.deepEqual(r.log[0], { url: 'https://www.robeywarshaw.co.uk/', outcome: 'guessed site' });
  assert.equal(r.status, 'described');
  assert.deepEqual(r.pages, ['https://www.robeywarshaw.co.uk/careers']);
  // At most three addresses, and none when guessing is off.
  const tech = firm({ n: 'Tiny Robotics', k: 'GB', t: ['deeptech'] });
  const asked = [];
  await D.careers(tech, { fetch: mockFetch({}, asked), now: NOW });
  assert.deepEqual(
    asked.map((a) => a.url).filter((u) => !/greenhouse|lever|ashby|workable/.test(u)),
    ['https://www.tinyrobotics.com/', 'https://www.tinyrobotics.co.uk/', 'https://www.tinyrobotics.ai/'],
  );
  const none = [];
  await D.careers(tech, { fetch: mockFetch({}, none), now: NOW, guess: false });
  assert.deepEqual(none, []);
});

/* --------------------------------------------------- niches and places */

test('discover: niches come in groups, tech among them', () => {
  for (const [key, n] of Object.entries(D.NICHES)) assert.ok(D.NICHE_GROUPS[n.group], key);
  const of = (g) => Object.keys(D.NICHES).filter((k) => D.NICHES[k].group === g);
  assert.deepEqual(of('finance'), ['hedge', 'quant', 'trading', 'asset', 'credit', 'pe', 'ib', 'family', 'vc']);
  assert.deepEqual(of('tech'), ['software', 'ai', 'fintech', 'deeptech', 'cyber', 'games', 'startups']);
  assert.deepEqual(D.NICHES.startups.tags, ['yc']);
  assert.ok(D.NICHES.games.wiki.test('British video game developer'));
  assert.equal(D.wantsTech(['hedge', 'pe']), false);
  assert.equal(D.wantsTech(['hedge', 'ai']), true);
});

test('discover: places keep their order, and Remote means a source said so', () => {
  const keys = Object.keys(D.PLACES);
  const old = [
    'london',
    'uk',
    'nyc',
    'greenwich',
    'boston',
    'chicago',
    'sf',
    'texas',
    'us',
    'hk',
    'sg',
    'ch',
    'europe',
    'any',
  ];
  assert.deepEqual(
    keys.filter((k) => old.includes(k)),
    old,
  );
  for (const k of ['scotland', 'cambridge', 'manchester', 'dublin', 'germany', 'paris', 'netherlands', 'israel'])
    assert.ok(keys.includes(k), k);
  for (const k of ['seattle', 'la', 'toronto', 'remote']) assert.ok(keys.includes(k), k);
  const firms = D.loadFirms([
    { n: 'Skyscanner', d: 'skyscanner.net', c: ['Edinburgh'], k: 'GB', t: ['software'] },
    { n: 'Intercom', d: 'intercom.com', c: ['Dublin'], k: 'IE', t: ['software'] },
    { n: 'Darktrace', d: 'darktrace.com', c: ['Cambridge'], k: 'GB', t: ['cyber'] },
  ]);
  const at = (place) => D.search(firms, { place }).map((h) => h.firm.name);
  assert.deepEqual(at('scotland'), ['Skyscanner']);
  assert.deepEqual(at('dublin'), ['Intercom']);
  assert.deepEqual(at('cambridge'), ['Darktrace']);
  assert.deepEqual(at('boston'), [], 'Cambridge, Massachusetts is in the US');
  assert.deepEqual(at('remote'), []);
  const hn = { ...firms[0], id: 'hn:1', name: 'Remote Co', remote: true, source: 'hn' };
  assert.deepEqual(
    D.search([...firms, hn], { place: 'remote' }).map((h) => h.firm.name),
    ['Remote Co'],
  );
});

test('discover: a registry record’s YC batch and description, and what they add to its standing', () => {
  const yc = firm({
    n: 'Tiny Robotics',
    d: 'tinyrobotics.example',
    y: 'W21',
    o: '  Robots that   pick fruit. ',
    i: 2021,
  });
  assert.equal(yc.yc, 'W21');
  assert.equal(yc.about, 'Robots that pick fruit.');
  assert.equal(yc.founded, 2021);
  const plain = firm({ n: 'Plain Robotics', d: 'plainrobotics.example', i: 0 });
  assert.equal(plain.yc, null);
  assert.equal(plain.about, '');
  assert.equal(plain.founded, null);
  const a = D.standing(yc);
  const b = D.standing(plain);
  assert.ok(a.reasons.includes('Y Combinator-backed'));
  assert.ok(Math.abs(a.reputation - b.reputation - 0.2) < 1e-9);
  const hn = D.standing({ ...plain, source: 'hn' });
  assert.ok(hn.reasons.includes('Hiring on Hacker News this month'));
  assert.ok(Math.abs(hn.reputation - b.reputation - 0.15) < 1e-9);
});

/* ----------------------------------------------------------- AI, tech */

const TINY_HOME = `<html><head><title>Tiny Robotics</title></head><body>${'x'.repeat(400)}
  <nav><a href="/careers">Careers</a></nav><p>Tiny Robotics builds warehouse robots.</p></body></html>`;

test('discover: an AI search angle is the prompt’s last line, and the system prompt covers tech', async () => {
  const asked = [];
  const chat = async (messages) => {
    asked.push(messages);
    return { json: { firms: [] } };
  };
  await D.suggest(chat, { niches: ['ai'], place: 'london' }, REGISTRY, {
    fetch: mockFetch({}),
    angle: 'Prefer firms that take speculative applications by email.',
  });
  await D.suggest(chat, { niches: ['hedge'] }, REGISTRY, { fetch: mockFetch({}) });
  const [first, second] = asked;
  assert.match(first[1].content, /\nFocus: Prefer firms that take speculative applications by email\.$/);
  assert.match(first[1].content, /^Kind of firm: AI and machine learning\n/);
  assert.ok(!/Focus:/.test(second[1].content));
  assert.match(first[0].content, /in finance \(think HBK.*not Goldman Sachs or Citadel\) or tech \(well-funded/);
});

test('discover: a tech firm checks out by its careers page; a finance firm still needs a registry', async () => {
  const chat = async () => ({
    json: { firms: [{ name: 'Tiny Robotics', website: 'tinyrobotics.example', why: 'Small' }] },
  });
  const routes = {
    'https://tinyrobotics.example/': TINY_HOME,
    'https://tinyrobotics.example/careers': `<html><body><h1>Join Tiny Robotics</h1></body></html>`,
  };
  const tech = await D.suggest(chat, { niches: ['deeptech'] }, REGISTRY, { fetch: mockFetch(routes) });
  assert.deepEqual(
    tech.found.map((f) => f.firm.name),
    ['Tiny Robotics'],
  );
  assert.ok(tech.found[0].reasons.includes('Has a careers page'));
  assert.equal(tech.found[0].firm.site, 'https://tinyrobotics.example');
  const finance = await D.suggest(chat, { niches: ['hedge'] }, REGISTRY, { fetch: mockFetch(routes) });
  assert.deepEqual(finance.found, []);
  assert.deepEqual(
    finance.rejected.map((r) => r.why),
    ['no SEC registration or Wikipedia article found'],
  );
  // A job board on the home page is enough too; a site with neither is not.
  const board = await D.verify(
    { name: 'Tiny Robotics', website: 'tinyrobotics.example' },
    {
      fetch: mockFetch({
        'https://tinyrobotics.example/': TINY_HOME.replace(
          '</body>',
          '<script src="https://boards.greenhouse.io/embed/job_board/js?for=tinyrobotics"></script></body>',
        ),
      }),
      tech: true,
    },
  );
  assert.ok(board.firm && board.reasons.includes('Has a careers page'));
  const bare = await D.verify(
    { name: 'Tiny Robotics', website: 'tinyrobotics.example' },
    {
      fetch: mockFetch({ 'https://tinyrobotics.example/': TINY_HOME.replace('<a href="/careers">Careers</a>', '') }),
      tech: true,
    },
  );
  assert.equal(bare.why, 'no Wikipedia article or careers page found');
});
