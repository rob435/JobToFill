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
