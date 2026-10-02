'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');

// fromHtml() needs a DOMParser; linkedom provides the parsing.
globalThis.DOMParser = class {
  parseFromString(html) {
    return parseHTML(String(html)).document;
  }
};
require('../../extension/lib/util.js');
const jp = require('../../extension/lib/jobpage.js');

const FIX = path.join(__dirname, '..', 'fixtures', 'jobs');
const html = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');
const json = (name) => JSON.parse(html(name));
const doc = (name) => parseHTML(html(name)).document;
const words = (s) =>
  String(s || '')
    .split(/\s+/)
    .filter(Boolean).length;

/* ------------------------------------------------------------------ ats() */

test('ats: Greenhouse boards, embeds and company sites', () => {
  assert.deepEqual(jp.ats('https://job-boards.greenhouse.io/point72/jobs/8845395002'), {
    name: 'greenhouse',
    company: 'point72',
    jobId: '8845395002',
    stage: 'description',
  });
  assert.equal(jp.ats('https://job-boards.eu.greenhouse.io/neptunenorth/jobs/4847890101?gh_src=x').jobId, '4847890101');
  assert.equal(jp.ats('https://boards.greenhouse.io/point72/jobs/8811167002').company, 'point72');
  const embed = jp.ats('https://boards.greenhouse.io/embed/job_app?for=jumptrading&token=4982814');
  assert.equal(embed.stage, 'application');
  assert.equal(embed.company, 'jumptrading');
  assert.equal(embed.jobId, '4982814');
  assert.equal(jp.ats('https://job-boards.greenhouse.io/point72/jobs/8845395002/confirmation').stage, 'unknown');
  const site = jp.ats('https://www.jumptrading.com/hr/job?gh_jid=4982814');
  assert.deepEqual(
    [site.name, site.company, site.jobId, site.stage],
    ['greenhouse', 'jumptrading', '4982814', 'description'],
  );
});

test('ats: Lever, Ashby, SmartRecruiters and Workable', () => {
  const id = 'cbde47db-c60b-4339-a8f4-a8e4f30505ab';
  assert.equal(jp.ats(`https://jobs.lever.co/belvederetrading/${id}`).stage, 'description');
  assert.deepEqual(jp.ats(`https://jobs.eu.lever.co/cirrus/${id.toUpperCase()}/apply`), {
    name: 'lever',
    company: 'cirrus',
    jobId: id,
    stage: 'application',
  });
  assert.equal(jp.ats('https://jobs.lever.co/belvederetrading').stage, 'unknown');

  const ash = '1fc309c8-da20-4ff2-84c7-8b863ece2b0a';
  assert.equal(jp.ats(`https://jobs.ashbyhq.com/notion/${ash}`).stage, 'description');
  assert.equal(jp.ats(`https://jobs.ashbyhq.com/notion/${ash}/application`).stage, 'application');
  const hosted = jp.ats(`https://semgrep.dev/about/careers/?ashby_employment_type=Intern&ashby_jid=${ash}`);
  assert.deepEqual([hosted.name, hosted.company, hosted.jobId], ['ashby', 'semgrep', ash]);

  const sr = jp.ats(
    'https://jobs.smartrecruiters.com/RolandBerger/744000152107209-junior-consultant-summer-internship-2027',
  );
  assert.deepEqual(
    [sr.name, sr.company, sr.jobId, sr.stage],
    ['smartrecruiters', 'RolandBerger', '744000152107209', 'description'],
  );
  const one = jp.ats(
    'https://jobs.smartrecruiters.com/oneclick-ui/company/RolandBerger/publication/b7f97800-1987-4cf3-bd74-63372b53b511?dcr_ci=RolandBerger',
  );
  assert.deepEqual(
    [one.company, one.jobId, one.stage],
    ['RolandBerger', 'b7f97800-1987-4cf3-bd74-63372b53b511', 'application'],
  );

  assert.deepEqual(jp.ats('https://apply.workable.com/rystad-energy/j/5D9349562D/'), {
    name: 'workable',
    company: 'rystad-energy',
    jobId: '5D9349562D',
    stage: 'description',
  });
  assert.equal(jp.ats('https://apply.workable.com/rystad-energy/j/5D9349562D/apply/').stage, 'application');
});

test('ats: Workday job pages, apply steps and myworkdaysite', () => {
  const page =
    'https://gresearch.wd103.myworkdayjobs.com/en-US/G-Research/job/London-UK/Quant-Research-Internship_R3691';
  assert.deepEqual(jp.ats(page), {
    name: 'workday',
    company: 'gresearch',
    jobId: 'R3691',
    stage: 'description',
    site: 'G-Research',
    jobPath: 'London-UK/Quant-Research-Internship_R3691',
  });
  const apply = jp.ats(page + '/apply/autofillWithResume');
  assert.equal(apply.stage, 'application');
  assert.equal(apply.jobPath, 'London-UK/Quant-Research-Internship_R3691');
  assert.equal(
    jp.ats('https://rbs.wd3.myworkdayjobs.com/en-US/RBS/job/Graduate-Trainee---NatWest-Markets-Front-Office_R-00285715')
      .jobId,
    'R-00285715',
  );
  const noLocale = jp.ats(
    'https://lgtcp.wd502.myworkdayjobs.com/lgtcpcurrentvacancies/job/Pfaffikon/Analyst_R0001234-1',
  );
  assert.deepEqual([noLocale.site, noLocale.jobId], ['lgtcpcurrentvacancies', 'R0001234']);
  const mws = jp.ats('https://wd3.myworkdaysite.com/recruiting/acme/External/job/London/Analyst_JR-77001/apply');
  assert.deepEqual([mws.company, mws.site, mws.jobId, mws.stage], ['acme', 'External', 'JR-77001', 'application']);
  assert.equal(
    jp.ats('https://fticonsulting.wd108.myworkdayjobs.com/en-US/FTIConsultingCareers/jobs?q=x').stage,
    'unknown',
  );
});

test('ats: Oracle, SuccessFactors, Taleo, iCIMS', () => {
  const o = jp.ats('https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210765547');
  assert.deepEqual(
    [o.name, o.company, o.jobId, o.stage, o.site],
    ['oracle', 'jpmc', '210765547', 'description', 'CX_1001'],
  );
  assert.equal(
    jp.ats('https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210765547/apply/email')
      .stage,
    'application',
  );
  const sel = jp.ats(
    'https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/requisitions?selectedItem=210765547',
  );
  assert.equal(sel.jobId, '210765547');

  const sf = jp.ats(
    'https://career012.successfactors.eu/career?career_ns=job_listing&company=banquepict&career_job_req_id=12345',
  );
  assert.deepEqual([sf.name, sf.company, sf.jobId, sf.stage], ['successfactors', 'banquepict', '12345', 'description']);
  assert.equal(
    jp.ats('https://career4.successfactors.com/career?career_ns=job_application&company=x&career_job_req_id=9').stage,
    'application',
  );
  const rmk = jp.ats(
    'https://careers.capgemini.com/job/Telford-Graduate-Software-Engineering-Programme-2027/1443168333/',
  );
  assert.deepEqual([rmk.name, rmk.jobId, rmk.stage], ['successfactors', '1443168333', 'description']);
  const tc = jp.ats('https://careers.capgemini.com/talentcommunity/apply/1443168333/?locale=en_GB');
  assert.deepEqual([tc.name, tc.jobId, tc.stage], ['successfactors', '1443168333', 'application']);

  assert.equal(jp.ats('https://acme.taleo.net/careersection/2/jobdetail.ftl?job=0012345').stage, 'description');
  assert.equal(jp.ats('https://acme.taleo.net/careersection/2/jobapply.ftl?job=0012345').stage, 'application');

  const ic = jp.ats('https://careers-lordabbett.icims.com/jobs/2396/investment-associate-internship---summer-2027/job');
  assert.deepEqual([ic.name, ic.company, ic.jobId, ic.stage], ['icims', 'lordabbett', '2396', 'description']);
  assert.equal(jp.ats('https://careers-lordabbett.icims.com/jobs/2396/login').stage, 'application');
});

test('ats: Eightfold, Avature, Phenom and the smaller boards', () => {
  const ef = jp.ats('https://aexp.eightfold.ai/careers?pid=24871234&domain=aexp.com');
  assert.deepEqual([ef.name, ef.jobId, ef.stage, ef.domain], ['eightfold', '24871234', 'description', 'aexp.com']);
  assert.equal(jp.ats('https://aexp.eightfold.ai/careers/apply?pid=24871234&domain=aexp.com').stage, 'application');
  assert.equal(jp.ats('https://careers.example.com/careers/job/24871234').name, null);

  const av = jp.ats('https://koch.avature.net/en_US/careers/JobDetail/Intern-Trading/184786');
  assert.deepEqual([av.name, av.company, av.jobId, av.stage], ['avature', 'koch', '184786', 'description']);
  const avApply = jp.ats('https://koch.avature.net/en_US/careers/ApplicationMethods?jobId=184786');
  assert.deepEqual([avApply.jobId, avApply.stage], ['184786', 'application']);

  const ph = jp.ats('https://careers.marsh.com/global/en/job/R_364008/NERA-Summer-Internship');
  assert.deepEqual([ph.name, ph.company, ph.jobId, ph.stage], ['phenom', 'marsh', 'R_364008', 'description']);
  const phApply = jp.ats('https://careers.marsh.com/global/en/apply?jobSeqNo=MAMCGLOBALR_364008EXTERNALENGLOBAL');
  assert.deepEqual([phApply.stage, phApply.jobSeqNo], ['application', 'MAMCGLOBALR_364008EXTERNALENGLOBAL']);

  const cases = [
    ['https://ikpartners.recruitee.com/o/capital-markets-off-cycle-analyst-2027/c/new', 'recruitee', 'application'],
    ['https://antin.teamtailor.com/jobs/8072275-investment-internship-london', 'teamtailor', 'description'],
    ['https://verdane.jobs.personio.de/job/2776049?language=en#apply', 'personio', 'application'],
    ['https://eastdilsecured.bamboohr.com/careers/170', 'bamboohr', 'description'],
    ['https://jobs.jobvite.com/aarete/job/oCzEAfw9/apply', 'jobvite', 'application'],
    ['https://marex.breezy.hr/p/86dc2823d7d601-marex-uk-graduate-programme-2027', 'breezy', 'description'],
    ['https://aab.pinpointhq.com/en/postings/565726/applications/new', 'pinpoint', 'application'],
    ['https://ats.rippling.com/en-GB/acme/jobs/243e29ea-62c3-4e3f-93be-e1d2fd37c0ed/apply', 'rippling', 'application'],
    ['https://unionsquareadvisors.applytojob.com/apply/xMjdapyDh9/Investment-Banking', 'jazzhr', 'description'],
    ['https://recruiting.ultipro.com/ACM1000/JobBoard/abc/OpportunityDetail?opportunityId=8d1c', 'ukg', 'description'],
  ];
  for (const [url, name, stage] of cases) {
    const a = jp.ats(url);
    assert.deepEqual([a.name, a.stage], [name, stage], url);
    assert.ok(a.jobId, url);
  }
});

test('ats: unknown sites are guessed from the path', () => {
  assert.deepEqual(jp.ats('https://www.deshaw.com/careers/cove-private-equity-intern-summer-2027-5875'), {
    name: null,
    company: null,
    jobId: '5875',
    stage: 'description',
  });
  assert.equal(jp.ats('https://careers.fabrikam.example/apply/REQ-40921').stage, 'application');
  assert.equal(jp.ats('https://example.com/about').stage, 'unknown');
  assert.equal(jp.ats('not a url').name, null);
  assert.equal(jp.ats('mailto:jobs@example.com').stage, 'unknown');
});

test('urlJobIds and textJobIds find requisition numbers but not years or portal names', () => {
  assert.deepEqual(
    jp.urlJobIds('https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210765547'),
    ['210765547'],
  );
  assert.ok(
    jp.urlJobIds('https://careers.fabrikam.example/jobs/quant-intern-summer-2027-REQ-40921').includes('REQ-40921'),
  );
  assert.deepEqual(jp.urlJobIds('https://example.com/jobs/graduate-scheme-2027'), []);
  assert.deepEqual(jp.textJobIds('Location: London · Requisition ID: REQ-40921 · Posted 2026'), ['REQ-40921']);
  assert.deepEqual(jp.textJobIds('Job ID: R-1234 and JR101594'), ['R-1234', 'JR101594']);
});

/* --------------------------------------------------------------- htmlToText */

test('htmlToText keeps paragraphs and bullets and decodes entities', () => {
  const t = jp.htmlToText(
    '<div><h3>What you&rsquo;ll do</h3><p>Build &amp; ship.</p><ul><li><p>Write code</p></li><li>Review&nbsp;code</li></ul></div>',
  );
  assert.equal(t, 'What you’ll do\n\nBuild & ship.\n\n• Write code\n• Review code');
  assert.equal(jp.htmlToText('&lt;p&gt;Encoded &amp;amp; twice&lt;/p&gt;'), 'Encoded & twice');
  assert.equal(jp.htmlToText('<script>var x = 1;</script><p>Visible</p>'), 'Visible');
  assert.equal(jp.htmlToText(null), '');
});

/* ---------------------------------------------------------------- JSON-LD */

test('JSON-LD: HTML-encoded description, PropertyValue identifier, several locations', () => {
  const url =
    'https://careers.marsh.com/global/en/job/R_364008/NERA-Summer-Internship-Summer-2028-Grads-Multiple-Locations';
  const p = jp.fromHtml(html('jsonld-phenom.html'), url);
  assert.equal(p.source, 'json-ld');
  assert.equal(p.title, 'NERA Summer Internship - Summer 2028 Grads - Multiple Locations');
  assert.equal(p.company, 'Oliver Wyman Group');
  assert.match(p.location, /New York/);
  assert.match(p.location, /Boston/);
  assert.ok(p.jobIds.includes('R_364008'));
  assert.equal(p.employmentType, 'INTERN');
  assert.doesNotMatch(p.description, /&lt;|<p>/);
  assert.match(p.description, /\n• Analyse large data sets/);
  assert.equal(p.ats, 'phenom');
  // The hidden "job has been filled" template doesn't count against a page with structured data…
  assert.equal(jp.applicationContext(doc('jsonld-phenom.html'), url).gone, false);
  // …but a closed job's tab title does.
  const closed = html('jsonld-phenom.html').replace(/<title>[^<]*/, '<title>Job not found | Marsh McLennan Careers');
  assert.equal(jp.fromHtml(closed, url), null);
});

test('candidates: a Phenom apply page uses the job ID it shows to find the job page', () => {
  const url = 'https://careers.marsh.com/global/en/apply?jobSeqNo=MAMCGLOBALR364008EXTERNALENGLOBAL&step=1';
  const list = jp.candidates({ url, ats: jp.ats(url), jobIds: ['R_364008'], links: [] }).map((c) => c.url);
  assert.equal(list[0], 'https://careers.marsh.com/global/en/job/R_364008');
});

test('JSON-LD: a JobPosting inside @graph with raw line breaks in its strings', () => {
  const p = jp.fromHtml(html('jsonld-graph.html'), 'https://www.northwind.example/careers/graduate-software-engineer/');
  assert.equal(p.title, 'Graduate Software Engineer 2027');
  assert.equal(p.company, 'Northwind Systems Ltd');
  assert.equal(p.location, 'Leeds, West Yorkshire, GB');
  assert.deepEqual(p.jobIds, ['NW-2291']);
  assert.match(p.description, /^Join our two-year graduate scheme/);
  assert.match(p.description, /Responsibilities\n\n• Write, test and ship/);
});

test('JSON-LD: several postings on one page — the one this address is about wins', () => {
  const markets = jp.fromHtml(
    html('jsonld-list.html'),
    'https://careers.contoso.example/jobs/4412-summer-analyst-markets',
  );
  assert.equal(markets.title, 'Summer Analyst 2027 – Markets');
  assert.deepEqual(markets.jobIds, ['4412']);
  const tech = jp.fromHtml(
    html('jsonld-list.html'),
    'https://careers.contoso.example/jobs/4415-summer-analyst-technology',
  );
  assert.equal(tech.title, 'Summer Analyst 2027 – Technology');
  assert.equal(tech.location, 'Glasgow, GB');
  // No address match: the page's own heading decides.
  const byHeading = jp.fromHtml(html('jsonld-list.html'), 'https://careers.contoso.example/some/other/page');
  assert.equal(byHeading.title, 'Summer Analyst 2027 – Markets');
});

test('JSON-LD: a Workday location that starts with the company name loses it', () => {
  const ld = {
    '@type': 'JobPosting',
    title: 'Halma Catalyst Programme - Graduate Trainee',
    hiringOrganization: { name: 'Halma plc' },
    jobLocation: { address: { addressLocality: 'Halma plc Amersham', addressCountry: 'United Kingdom' } },
    identifier: { value: 'JR26_000946' },
    description: `<p>${'Join our graduate programme and rotate through businesses in the group. '.repeat(10)}</p>`,
  };
  const url =
    'https://halma.wd3.myworkdayjobs.com/Halma/job/Amersham/Halma-Catalyst-Programme-Graduate-Trainee_JR26_000946/apply';
  const page = `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body></body></html>`;
  const c = jp.applicationContext(parseHTML(page).document, url);
  assert.equal(c.company, 'Halma plc');
  assert.equal(c.location, 'Amersham, United Kingdom');
  assert.equal(c.posting.location, 'Amersham, United Kingdom');
  // Only a leading company name goes, and never the whole location.
  assert.equal(jp.fromHtml(page.replace('Halma plc Amersham', 'Halma plc'), url).location, 'United Kingdom');
  const only = JSON.stringify({ ...ld, jobLocation: { address: { addressLocality: 'Halma plc' } } });
  assert.equal(jp.fromHtml(page.replace(JSON.stringify(ld), only), url).location, 'Halma plc');
});

test('fromHtml: a page that is only a script shell has no posting; fromHtml needs a DOMParser', () => {
  const url =
    'https://osv-cci.wd1.myworkdayjobs.com/en-US/CCICareers/job/Commodities-Trading-Summer-Analyst-Internship';
  assert.equal(jp.fromHtml(html('workday-shell.html'), url), null);
  assert.equal(jp.fromHtml(html('../signup.html'), 'https://example.com/signup'), null);
  const saved = globalThis.DOMParser;
  delete globalThis.DOMParser;
  try {
    assert.throws(() => jp.fromHtml('<p>x</p>', 'https://example.com/'), /DOMParser/);
  } finally {
    globalThis.DOMParser = saved;
  }
});

test('fromHtml: removed jobs and search results are not postings', () => {
  const list = Array.from(
    { length: 12 },
    (_, i) =>
      `<li><a href="/jobs/${1000 + i}/analyst/job">Analyst ${i}</a><p>We are looking for a graduate analyst to join our team, with experience in Excel and strong communication skills.</p></li>`,
  ).join('');
  const gone = `<html><head><title>Listings</title></head><body><h1>Error: The requested job could not be found.</h1><ul>${list}</ul></body></html>`;
  assert.equal(jp.fromHtml(gone, 'https://careers-acme.icims.com/jobs/2272/analyst/job'), null);
  const search = `<html><head><title>Search jobs</title></head><body><main><h2>Responsibilities of our analysts</h2><ul>${list}</ul></main></body></html>`;
  assert.equal(jp.fromHtml(search, 'https://careers-acme.icims.com/jobs/search?ss=1'), null);
  assert.equal(jp.fromHtml(search, 'https://www.acme.example/careers/search?q=analyst'), null);
});

test('fromDocument: ATS markup when there is no structured data', () => {
  const p = jp.fromDocument(doc('greenhouse-apply.html'), 'https://job-boards.greenhouse.io/point72/jobs/8811167002');
  assert.equal(p.source, 'page');
  assert.equal(p.title, '2027 Investment Services Internship');
  assert.equal(p.company, 'Point72');
  assert.match(p.location, /^New York/);
  assert.match(p.description, /^About the Investment Services internship/);
  assert.doesNotMatch(p.description, /First Name|Apply for this job/);
  assert.ok(p.jobIds.includes('8811167002'));
});

test('fromDocument: generic main text, without menus or cookie banners', () => {
  const page = `<html><head><title>Graduate Analyst | Tailspin Toys</title></head><body>
    <nav><a href="/">Home</a> <a href="/jobs">Jobs</a></nav>
    <div class="cookie-banner"><p>We use cookies on this website to give you a better experience, measure traffic and show you relevant adverts, as explained in our cookie policy.</p></div>
    <article class="job-body"><h1>Graduate Analyst</h1>
      <h2>About the role</h2><p>You will join the commercial finance team, preparing monthly forecasts, analysing the profitability of our product ranges and presenting your findings to category managers across the business.</p>
      <h2>Responsibilities</h2><ul><li>Build and maintain forecasting models in Excel</li><li>Investigate variances against budget and explain them to the team</li><li>Support the annual planning cycle with scenario analysis</li></ul>
      <h2>Requirements</h2><ul><li>A 2:1 degree in any discipline, finishing in 2027</li><li>Strong numerical skills, curiosity and attention to detail</li><li>Clear communication with people at every level</li></ul>
    </article>
    <footer><p>Copyright Tailspin Toys. All rights reserved. Registered in England and Wales, company number 0000000, registered office in Leeds.</p></footer>
  </body></html>`;
  const p = jp.fromHtml(page, 'https://tailspin.example/careers/graduate-analyst');
  assert.equal(p.source, 'page-text');
  assert.match(p.description, /About the role/);
  assert.match(p.description, /• Build and maintain forecasting models/);
  assert.doesNotMatch(p.description, /cookies|Copyright/);
  assert.equal(p.title, 'Graduate Analyst');
  assert.equal(p.company, 'Tailspin Toys');
});

test('fromDocument: a description split into section blocks (Personio-style markup) is read whole', () => {
  const item = (title, body) =>
    `<div class="page_jobDescriptionItem__x"><h2 class="detail-block-title">${title}</h2><div class="page_richTextContent__y">${body}</div></div>`;
  const page = `<html><head><title>visiting analyst (f/m/d) | Jobs at </title></head><body><main><div class="page_jobContainer__z">
    <h1>visiting analyst (f/m/d)</h1><p>Zug, Berlin, London · Full-time</p>
    <div class="page_jobDescription__w">
      ${item('Your mission', '<p>As part of the investment team you will source and assess early-stage companies, meet founders and help prepare investment memos for the partners.</p>')}
      ${item('Your profile', '<ul><li>Excellent academic track record</li><li>Background in STEM or business</li><li>Prior internships in venture capital, start-ups, consulting or banking are a plus</li><li>Fluent English; German is helpful</li></ul>')}
      ${item('Why us?', '<p>You will work closely with experienced investors on real deals and get feedback every week, in a small team that values initiative.</p>')}
    </div></div></main></body></html>`;
  const p = jp.fromHtml(page, 'https://redalpine.jobs.personio.com/job/2028216');
  assert.match(p.description, /Your mission[\s\S]*Your profile[\s\S]*Why us\?/);
  assert.equal(p.title, 'visiting analyst (f/m/d)');
  assert.notEqual(p.company, 'at');
});

/* ---------------------------------------------------------------- fromApi */

test('apiRequests: the public JSON endpoint for each board', () => {
  const kinds = (url) => jp.apiRequests(url).map((r) => [r.kind, r.url]);
  assert.deepEqual(kinds('https://job-boards.greenhouse.io/point72/jobs/8811167002'), [
    ['greenhouse', 'https://boards-api.greenhouse.io/v1/boards/point72/jobs/8811167002'],
  ]);
  assert.deepEqual(kinds('https://jobs.eu.lever.co/cirrus/2564ad0c-23de-415d-9849-0c9514755b3c/apply'), [
    ['lever', 'https://api.eu.lever.co/v0/postings/cirrus/2564ad0c-23de-415d-9849-0c9514755b3c'],
  ]);
  assert.match(
    kinds('https://jobs.ashbyhq.com/kastle/6f32db51-de45-472f-a9c8-d9419d3634ee/application')[0][1],
    /\/job-board\/kastle\?/,
  );
  assert.deepEqual(
    kinds(
      'https://gresearch.wd103.myworkdayjobs.com/en-US/G-Research/job/London-UK/Quant-Research-Internship_R3691/apply',
    ),
    [
      [
        'workday',
        'https://gresearch.wd103.myworkdayjobs.com/wday/cxs/gresearch/G-Research/job/London-UK/Quant-Research-Internship_R3691',
      ],
    ],
  );
  assert.match(
    kinds('https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210765547/apply/email')[0][1],
    /recruitingCEJobRequisitionDetails\?.*Id=%22210765547%22,siteNumber=CX_1001/,
  );
  assert.equal(
    kinds('https://aexp.eightfold.ai/careers?pid=24871234&domain=aexp.com')[0][1].includes('domain=aexp.com'),
    true,
  );
  assert.deepEqual(kinds('https://example.com/jobs/123456'), []);
  const r = jp.apiRequests('https://apply.workable.com/rystad-energy/j/5D9349562D/')[0];
  assert.deepEqual(
    [r.method, r.headers.Accept, r.page],
    ['GET', 'application/json', 'https://apply.workable.com/rystad-energy/j/5D9349562D/'],
  );
});

const API_CASES = [
  {
    kind: 'greenhouse',
    page: 'https://job-boards.greenhouse.io/point72/jobs/8845395002',
    title: '2027 Point72 Academy Spring Insight Programme – UK',
    company: 'Point72',
    location: 'London, UK',
    id: '8845395002',
    text: /^The Spring Insight Programme is a short, paid introduction/,
  },
  {
    kind: 'lever',
    page: 'https://jobs.eu.lever.co/coretechsecurity/1e68e7e1-b61e-40a4-96bf-31d85cda9335/apply',
    title: 'Junior Cyber Security Researcher - September 2027',
    company: 'CoreTech Security',
    location: 'Cheltenham',
    id: '1e68e7e1-b61e-40a4-96bf-31d85cda9335',
    text: /Skills you may have\n\n• An interest in how software vulnerabilities/,
  },
  {
    kind: 'ashby',
    page: 'https://jobs.ashbyhq.com/kastle/6f32db51-de45-472f-a9c8-d9419d3634ee/application',
    title: 'Software Engineer - Intern',
    company: 'Kastle',
    location: 'San Francisco',
    id: '6f32db51-de45-472f-a9c8-d9419d3634ee',
    text: /^Kastle builds AI agents/,
  },
  {
    kind: 'workday',
    page: 'https://gresearch.wd103.myworkdayjobs.com/en-US/G-Research/job/London-UK/Quant-Research-Internship_R3691/apply',
    title: 'Quant Research Internship',
    company: 'Braunford LLP',
    location: 'London, UK',
    id: 'R3691',
    text: /^Our quant research interns spend the summer/,
  },
  {
    kind: 'smartrecruiters',
    page: 'https://jobs.smartrecruiters.com/RolandBerger/744000152107209-junior-consultant-summer-internship-2027',
    title: 'Junior Consultant Summer Internship 2027',
    company: 'Roland Berger',
    location: 'London, England, United Kingdom',
    id: 'REF4557P',
    text: /^Job Description\n\nAs a summer intern/,
  },
  {
    kind: 'workable',
    page: 'https://apply.workable.com/rystad-energy/j/5D9349562D/',
    title: 'Graduate Management Consultant - Summer 2027',
    company: 'Rystad Energy',
    location: 'London, England, United Kingdom',
    id: '5D9349562D',
    text: /graduate consultants work on research and advisory projects/,
  },
  {
    kind: 'oracle',
    page: 'https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210765547',
    title: '2027 Internal Audit Analyst Program - Summer Intern Opportunity',
    company: 'JPMC',
    location: 'Jersey City, NJ, United States',
    id: '210765547',
    text: /^The Internal Audit summer analyst programme[\s\S]*JPMorganChase is one of the oldest/,
  },
  {
    kind: 'recruitee',
    page: 'https://ikpartners.recruitee.com/o/capital-markets-off-cycle-analyst-2027/c/new',
    title: 'Capital Markets Off-Cycle Analyst 2027',
    company: 'IK Partners',
    location: 'London, Greater London, United Kingdom',
    id: 'capital-markets-off-cycle-analyst-2027',
    text: /Requirements\n\nOur expectation\n\n• Relevant internship experience/,
  },
  {
    kind: 'bamboohr',
    page: 'https://eastdilsecured.bamboohr.com/careers/170',
    title: '2027 Analyst (London)',
    company: 'Eastdil Secured',
    location: 'London, United Kingdom',
    id: '170',
    text: /^Eastdil Secured advises clients/,
  },
];

for (const c of API_CASES) {
  test(`fromApi: ${c.kind}`, () => {
    const p = jp.fromApi(c.kind, json(`api-${c.kind}.json`), c.page);
    assert.ok(p, 'a posting');
    assert.equal(p.source, 'api');
    assert.equal(p.title, c.title);
    assert.equal(p.company, c.company);
    assert.ok(p.location.startsWith(c.location), p.location);
    assert.ok(p.jobIds.includes(c.id), `${p.jobIds} has ${c.id}`);
    assert.match(p.description, c.text);
    assert.doesNotMatch(p.description, /<\/?(p|li|div|ul)>|&lt;|&amp;/);
    assert.ok(words(p.description) >= 60, `${words(p.description)} words`);
  });
}

test('fromApi: Ashby picks the requested job from the whole board; empty and unknown data', () => {
  const board = json('api-ashby.json');
  const other = board.jobs.find((j) => j.id !== '6f32db51-de45-472f-a9c8-d9419d3634ee');
  const p = jp.fromApi('ashby', board, `https://jobs.ashbyhq.com/kastle/${other.id}/application`);
  assert.equal(p.title, other.title);
  assert.deepEqual(p.jobIds, [other.id]);
  assert.equal(
    jp.fromApi('ashby', board, 'https://jobs.ashbyhq.com/kastle/00000000-0000-0000-0000-000000000000'),
    null,
  );
  assert.equal(jp.fromApi('greenhouse', { error: 'Job not found' }, 'https://job-boards.greenhouse.io/x/jobs/1'), null);
  assert.equal(jp.fromApi('lever', null, ''), null);
  // An unknown API: the most posting-like object wins.
  const generic = jp.fromApi(
    null,
    {
      data: {
        job: {
          jobTitle: 'Data Analyst Intern',
          id: 'DA-1001',
          descriptionHtml: `<p>${'Analyse data, build dashboards and present insights to the product team. '.repeat(8)}</p>`,
        },
      },
    },
    'https://careers.example.com/jobs/data-analyst',
  );
  assert.equal(generic.title, 'Data Analyst Intern');
  assert.ok(generic.jobIds.includes('DA-1001'));
});

/* ----------------------------------------------------- applicationContext */

test('applicationContext: Greenhouse page with the description above the form', () => {
  const url = 'https://job-boards.greenhouse.io/point72/jobs/8811167002';
  const c = jp.applicationContext(doc('greenhouse-apply.html'), url);
  assert.equal(c.title, '2027 Investment Services Internship');
  assert.equal(c.company, 'Point72');
  assert.match(c.location, /New York/);
  assert.deepEqual(c.jobIds, ['8811167002']);
  assert.equal(c.ats.name, 'greenhouse');
  assert.ok(c.posting && words(c.posting.description) > 80);
  assert.doesNotThrow(() => JSON.stringify(c));
  assert.deepEqual(JSON.parse(JSON.stringify(c)).jobIds, c.jobIds);
});

test('applicationContext: Lever /apply page', () => {
  const c = jp.applicationContext(
    doc('lever-apply.html'),
    'https://jobs.lever.co/palantir/6ed76ce8-4156-4b60-b120-403538bd66cd/apply',
  );
  assert.equal(c.title, 'Administrative Business Partner');
  assert.equal(c.company, 'Palantir Technologies');
  assert.equal(c.location, 'Singapore, Singapore');
  assert.deepEqual(c.jobIds, ['6ed76ce8-4156-4b60-b120-403538bd66cd']);
  assert.equal(c.posting, null, 'a form is not a description');
});

test('applicationContext: Ashby /application page keeps its JSON-LD posting and the Overview link', () => {
  const c = jp.applicationContext(
    doc('ashby-application.html'),
    'https://jobs.ashbyhq.com/notion/1fc309c8-da20-4ff2-84c7-8b863ece2b0a/application',
  );
  assert.equal(c.title, 'Software Engineer, Developer Platform');
  assert.equal(c.company, 'Notion');
  assert.match(c.location, /San Francisco/);
  assert.equal(c.posting.source, 'json-ld');
  assert.deepEqual(
    c.links.map((l) => l.url),
    ['https://jobs.ashbyhq.com/notion/1fc309c8-da20-4ff2-84c7-8b863ece2b0a'],
    'the board’s job list is not a candidate',
  );
});

test('applicationContext: Workday "Start Your Application" and Oracle e-mail step', () => {
  const wd = jp.applicationContext(
    doc('workday-apply.html'),
    'https://gresearch.wd103.myworkdayjobs.com/en-US/G-Research/job/London-UK/Quant-Research-Internship_R3691/apply',
  );
  assert.equal(wd.title, 'Quant Research Internship');
  assert.ok(wd.jobIds.includes('R3691'));
  assert.equal(wd.location, 'London, United Kingdom');
  const or = jp.applicationContext(
    doc('oracle-apply.html'),
    'https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210765547/apply/email',
  );
  assert.equal(or.title, '2027 Internal Audit Analyst Program - Summer Intern Opportunity');
  assert.equal(or.company, 'JPMC');
  assert.equal(or.location, 'Jersey City, NJ, United States');
  assert.deepEqual(or.jobIds, ['210765547']);
});

test('applicationContext: a company’s own form with a requisition ID and a job link', () => {
  const c = jp.applicationContext(doc('company-apply.html'), 'https://careers.fabrikam.example/apply/REQ-40921');
  assert.equal(c.title, 'Quantitative Researcher Intern (Summer 2027)');
  assert.equal(c.company, 'Fabrikam Capital');
  assert.ok(c.jobIds.includes('REQ-40921'));
  assert.deepEqual(c.links, [
    {
      url: 'https://careers.fabrikam.example/jobs/quantitative-researcher-intern-summer-2027-REQ-40921',
      text: 'View job description',
    },
  ]);
  assert.equal(c.posting, null);
});

test('applicationContext: a candidate portal’s home page (where a sign-in redirect lands) has no posting', () => {
  const page = `<html><head><title>HSBC Candidate Portal</title></head><body><main>
    <h1>HSBC Candidate Portal</h1><h2>What we look for</h2>
    <p>We are looking for people who bring curiosity, integrity and resilience to everything they do, and who want to grow a career with a global bank. Our programmes offer training, mentoring and real responsibility from the start.</p>
    <h2>Benefits</h2><ul><li>Competitive pay and pension</li><li>Hybrid working and flexible hours</li><li>Volunteering days and wellbeing support for you and your family</li></ul>
    <p>Sign in to see your applications, track your progress and update your details at any time during the process.</p>
  </main></body></html>`;
  const c = jp.applicationContext(parseHTML(page).document, 'https://apply.careers.hsbc.com/');
  assert.equal(c.posting, null);
  assert.equal(c.title, '', 'a portal name is not a job title');
});

test('applicationContext: no document, or a page with nothing about a job', () => {
  const empty = jp.applicationContext(null, 'https://example.com/apply');
  assert.deepEqual([empty.title, empty.posting, empty.links], ['', null, []]);
  const c = jp.applicationContext(doc('../signup.html'), 'https://example.com/signup');
  assert.equal(c.posting, null);
  assert.deepEqual(c.jobIds, []);
});

test('applicationContext: an iCIMS job inside #icims_content_iframe (no JSON-LD)', () => {
  const frame =
    'https://careers-sargentlundy.icims.com/jobs/27617/instrumentation-&-controls-engineering-intern---nuclear-%28summer-2027%29/job?in_iframe=1';
  const c = jp.applicationContext(doc('icims-frame.html'), frame);
  assert.equal(c.ats.name, 'icims');
  assert.equal(c.title, 'Instrumentation & Controls Engineering Intern - Nuclear (Summer 2027)');
  assert.equal(c.company, 'Sargent & Lundy');
  assert.equal(c.location, 'Phoenix, AZ, United States');
  assert.ok(c.jobIds.includes('27617'));
  assert.equal(c.gone, false);
  const p = c.posting;
  assert.equal(p.source, 'page');
  assert.match(p.description, /^Responsibilities\n\nThis internship starts in summer 2027/);
  assert.match(p.description, /Qualifications\n\n• Studying electrical/);
  assert.doesNotMatch(p.description, /Apply for this job online|Email this job/);
});

test('applicationContext: a closed iCIMS job (redirected to the search page) is reported as gone', () => {
  const url = 'https://careers-gtsx.icims.com/jobs/search?ss=1&notFound=1&in_iframe=1';
  const c = jp.applicationContext(doc('icims-gone.html'), url);
  assert.equal(c.posting, null, 'the list of other jobs is not a posting');
  assert.equal(c.gone, true);
  assert.deepEqual(c.jobIds, []);
});

/* ------------------------------------------------------------- candidates */

test('candidates: board data first, then the job page behind the application step', () => {
  const c = jp.applicationContext(
    doc('lever-apply.html'),
    'https://jobs.lever.co/palantir/6ed76ce8-4156-4b60-b120-403538bd66cd/apply',
  );
  const list = jp.candidates({ ...c, referrer: 'https://www.google.com/' });
  assert.deepEqual(
    list.map((x) => x.url),
    [
      'https://api.lever.co/v0/postings/palantir/6ed76ce8-4156-4b60-b120-403538bd66cd',
      'https://jobs.lever.co/palantir/6ed76ce8-4156-4b60-b120-403538bd66cd',
    ],
  );
  assert.equal(list[0].request.kind, 'lever');
  assert.ok(list.every((x) => x.structural));
});

test('candidates: page links, canonical, referrer and the page itself', () => {
  const ctx = {
    url: 'https://careers.fabrikam.example/apply/REQ-40921',
    ats: jp.ats('https://careers.fabrikam.example/apply/REQ-40921'),
    jobIds: ['REQ-40921'],
    links: [
      { url: 'https://careers.fabrikam.example/jobs/quant-researcher-intern-REQ-40921', text: 'View job description' },
      { url: 'https://careers.fabrikam.example/jobs/quant-trader-intern-REQ-40933', text: 'Quant Trader Intern' },
    ],
    canonical: 'https://careers.fabrikam.example/apply?req=REQ-40921',
    referrer: 'https://careers.fabrikam.example/jobs/quant-researcher-intern-REQ-40921?src=list',
  };
  const list = jp.candidates(ctx);
  assert.equal(list[0].url, 'https://careers.fabrikam.example/jobs/quant-researcher-intern-REQ-40921');
  assert.equal(list[0].weight, 0.88);
  const ref = list.find((x) => /src=list/.test(x.url));
  assert.ok(ref && ref.weight < list[0].weight);
  assert.ok(list.find((x) => x.reason === 'the page’s canonical address'));
  // Referrers that are searches, job boards' lists or sign-in pages are ignored.
  for (const referrer of [
    'https://www.google.com/search?q=quant',
    'https://www.linkedin.com/jobs/search?keywords=quant',
    'https://careers.fabrikam.example/login',
    'https://careers.fabrikam.example/jobs?q=quant',
  ])
    assert.ok(!jp.candidates({ ...ctx, referrer }).some((x) => x.url === referrer), referrer);
  // A job page whose description never rendered: try its server HTML.
  const self = jp.candidates({ url: 'https://www.deshaw.com/careers/cove-private-equity-intern-summer-2027-5875' });
  assert.deepEqual(
    self.map((x) => x.reason),
    ['this page as the server sends it'],
  );
});

test('candidates: a pasted address and its board data come first', () => {
  const pasted = 'https://job-boards.greenhouse.io/point72/jobs/8845395002';
  const ctx = {
    url: 'https://jobs.lever.co/palantir/6ed76ce8-4156-4b60-b120-403538bd66cd/apply',
    links: [{ url: pasted, text: 'pasted' }],
    pasted,
  };
  const list = jp.candidates(ctx);
  assert.equal(list[0].url, 'https://boards-api.greenhouse.io/v1/boards/point72/jobs/8845395002');
  assert.equal(list[0].weight, 1);
  assert.equal(list[1].url, pasted);
  assert.ok(list.slice(2).every((x) => x.weight < 0.99));
});

test('descriptionUrls: the job page behind each kind of application step', () => {
  const first = (url) => (jp.descriptionUrls(url)[0] || {}).url;
  assert.equal(
    first('https://boards.greenhouse.io/embed/job_app?for=jumptrading&token=4982814'),
    'https://job-boards.greenhouse.io/jumptrading/jobs/4982814',
  );
  assert.equal(
    first('https://jobs.ashbyhq.com/notion/1fc309c8-da20-4ff2-84c7-8b863ece2b0a/application'),
    'https://jobs.ashbyhq.com/notion/1fc309c8-da20-4ff2-84c7-8b863ece2b0a',
  );
  assert.equal(
    first('https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210765547/apply/email'),
    'https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210765547',
  );
  assert.equal(
    first('https://koch.avature.net/en_US/careers/ApplicationMethods?jobId=184786'),
    'https://koch.avature.net/en_US/careers/JobDetail/184786',
  );
  assert.equal(
    first('https://aexp.eightfold.ai/careers/apply?pid=24871234&domain=aexp.com'),
    'https://aexp.eightfold.ai/careers?pid=24871234&domain=aexp.com',
  );
  assert.equal(
    first('https://careers.marsh.com/global/en/apply?jobSeqNo=MAMCGLOBALR_364008EXTERNALENGLOBAL'),
    'https://careers.marsh.com/global/en/job/R_364008',
  );
  assert.equal(
    first('https://career4.successfactors.com/career?career_ns=job_application&company=x&career_job_req_id=9'),
    'https://career4.successfactors.com/career?career_ns=job_listing&company=x&career_job_req_id=9',
  );
  assert.equal(
    first('https://www.example.com/careers/analyst-1234/apply'),
    'https://www.example.com/careers/analyst-1234',
  );
  assert.equal(first('https://jobs.lever.co/palantir/6ed76ce8-4156-4b60-b120-403538bd66cd'), undefined);
});

/* ---------------------------------------------------------------- history */

test('historyQuery and rankHistory: past visits to the job page rank first', () => {
  const now = Date.parse('2026-10-01T12:00:00Z');
  const ctx = {
    url: 'https://careers.fabrikam.example/apply/REQ-40921',
    ats: jp.ats('https://careers.fabrikam.example/apply/REQ-40921'),
    title: 'Quantitative Researcher Intern (Summer 2027)',
    company: 'Fabrikam Capital',
    jobIds: ['REQ-40921'],
  };
  const qs = jp.historyQuery(ctx, now);
  assert.deepEqual(
    qs.map((x) => x.text),
    ['REQ-40921', 'Quantitative Researcher Intern Summer 2027', 'Fabrikam Capital', ''],
  );
  assert.ok(qs.slice(0, 3).every((x) => x.startTime === now - 60 * 864e5));
  // Everything from the last three hours: the job page opened just before a sign-in wall.
  assert.deepEqual(qs[3], { text: '', startTime: now - 3 * 36e5, maxResults: 200 });

  const day = 864e5;
  const items = [
    {
      url: 'https://www.google.com/search?q=fabrikam+quant',
      title: 'fabrikam quant - Google Search',
      lastVisitTime: now,
    },
    {
      url: 'https://careers.fabrikam.example/jobs?q=quant',
      title: 'Search jobs | Fabrikam Capital',
      lastVisitTime: now,
    },
    { url: 'https://careers.fabrikam.example/login', title: 'Sign in | Fabrikam Capital', lastVisitTime: now },
    {
      url: 'https://careers.fabrikam.example/jobs/quant-trader-intern-REQ-40933',
      title: 'Quantitative Trader Intern | Fabrikam Capital',
      lastVisitTime: now - day,
    },
    {
      url: 'https://careers.fabrikam.example/jobs/quant-researcher-intern-REQ-40921',
      title: 'Quantitative Researcher Intern (Summer 2027) | Fabrikam Capital',
      lastVisitTime: now - 2 * day,
    },
    {
      url: 'https://www.linkedin.com/jobs/view/4012345678/',
      title: 'Fabrikam Capital hiring Quantitative Researcher Intern (Summer 2027) in London | LinkedIn',
      lastVisitTime: now - 3 * day,
    },
    { url: 'https://news.example.com/markets', title: 'Markets today', lastVisitTime: now },
    { url: ctx.url, title: 'Apply', lastVisitTime: now },
  ];
  const ranked = jp.rankHistory(ctx, items, now);
  assert.equal(ranked[0].url, 'https://careers.fabrikam.example/jobs/quant-researcher-intern-REQ-40921');
  assert.match(ranked[0].reason, /job ID/);
  assert.equal(ranked[1].url, 'https://www.linkedin.com/jobs/view/4012345678/');
  const urls = ranked.map((r) => r.url);
  for (const bad of ['google.com', 'jobs?q=', '/login', 'news.example.com', '/apply/']) {
    assert.ok(!urls.some((u) => u.includes(bad)), bad);
  }
  assert.ok(ranked.every((r) => r.weight <= 0.85));
});

/* ---------------------------------------------------------------- compare */

const posting = (fields) => ({
  url: '',
  title: '',
  company: '',
  location: '',
  jobIds: [],
  description: '',
  ...fields,
});

test('compare: same job by ID, or by title + company + location', () => {
  const ctx = {
    url: 'https://jobs.lever.co/palantir/6ed76ce8-4156-4b60-b120-403538bd66cd/apply',
    ats: jp.ats('https://jobs.lever.co/palantir/6ed76ce8-4156-4b60-b120-403538bd66cd/apply'),
    title: 'Administrative Business Partner',
    company: 'Palantir Technologies',
    location: 'Singapore, Singapore',
    jobIds: ['6ed76ce8-4156-4b60-b120-403538bd66cd'],
  };
  const byId = jp.compare(
    ctx,
    jp.fromApi(
      'lever',
      { ...json('api-lever.json'), id: '6ed76ce8-4156-4b60-b120-403538bd66cd', hostedUrl: '' },
      'https://jobs.lever.co/palantir/6ed76ce8-4156-4b60-b120-403538bd66cd',
    ),
  );
  assert.equal(byId.verdict, 'same', byId.reasons.join('; '));

  const company = {
    url: 'https://careers.fabrikam.example/apply',
    title: 'Quantitative Researcher Intern – Summer 2027',
    company: 'Fabrikam',
    location: 'London',
    jobIds: [],
  };
  const v = jp.compare(
    company,
    posting({
      url: 'https://fabrikam.example/careers/quant',
      title: 'Quant Researcher Internship 2027',
      company: 'Fabrikam Capital LLP',
      location: 'London, United Kingdom',
    }),
  );
  assert.equal(v.verdict, 'same', v.reasons.join('; '));
  assert.ok(v.score >= 0.9);
  assert.ok(v.reasons.includes('title matches') && v.reasons.includes('company matches'));
});

test('compare: different jobs at the same company, place or board', () => {
  // Same board and company, another job ID.
  const gh = {
    url: 'https://job-boards.greenhouse.io/point72/jobs/8811167002',
    ats: jp.ats('https://job-boards.greenhouse.io/point72/jobs/8811167002'),
    title: '2027 Investment Services Internship',
    company: 'Point72',
    location: 'New York',
    jobIds: ['8811167002'],
  };
  const other = jp.fromApi(
    'greenhouse',
    json('api-greenhouse.json'),
    'https://job-boards.greenhouse.io/point72/jobs/8845395002',
  );
  const a = jp.compare(gh, other);
  assert.equal(a.verdict, 'different', a.reasons.join('; '));
  assert.match(a.reasons[0], /different job ID/);

  // Same company, different job, no IDs to go on.
  const ctx = {
    url: 'https://careers.contoso.example/apply',
    title: 'Summer Analyst 2027 – Markets',
    company: 'Contoso Bank',
    location: 'London',
  };
  const ib = jp.compare(
    ctx,
    posting({ title: 'Summer Analyst 2027 – Investment Banking', company: 'Contoso Bank', location: 'London' }),
  );
  assert.notEqual(ib.verdict, 'same', ib.reasons.join('; '));
  const tech = jp.compare(
    { ...ctx, title: 'Software Engineer Intern' },
    posting({ title: 'Quantitative Trader Intern', company: 'Contoso Bank', location: 'London' }),
  );
  assert.equal(tech.verdict, 'different', tech.reasons.join('; '));

  // Same title, another city.
  const city = jp.compare(
    { ...ctx, title: 'Graduate Software Engineer', company: 'Northwind Systems', location: 'Leeds' },
    posting({ title: 'Graduate Software Engineer', company: 'Northwind Systems', location: 'Bristol, United Kingdom' }),
  );
  assert.notEqual(city.verdict, 'same', city.reasons.join('; '));
  assert.ok(city.reasons.includes('location differs'));

  // Same title, another employer.
  const employer = jp.compare(
    { ...ctx, title: 'Investment Banking Summer Analyst', company: 'Contoso Bank' },
    posting({ title: 'Software Engineer', company: 'Tailspin Toys' }),
  );
  assert.equal(employer.verdict, 'different');

  // Two Oracle requisitions on the same site share nothing but the site number.
  const or = {
    url: 'https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210765547/apply/email',
    title: '2027 Internal Audit Analyst Program - Summer Intern Opportunity',
    company: 'JPMC',
    jobIds: ['210765547'],
  };
  const orOther = jp.compare(
    or,
    jp.fromApi(
      'oracle',
      { items: [{ ...json('api-oracle.json').items[0], Id: '210700001', Title: '2027 Software Engineer Program' }] },
      'https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210700001',
    ),
  );
  assert.equal(orOther.verdict, 'different', orOther.reasons.join('; '));
});

test('compare: the job ID in the address beats IDs from a "similar jobs" list on the page', () => {
  const url = 'https://jobs.pwc.co.uk/earlycareers/uk/en/job/EC202660/Summer-Internship-Technology-and-AI-London';
  const ctx = {
    url,
    ats: jp.ats(url),
    title: 'Summer Internship - Technology and AI - London',
    company: 'PwC',
    jobIds: ['EC202660', 'EC202632', 'EC202629'],
  };
  const other = posting({
    url: 'https://jobs.pwc.co.uk/earlycareers/uk/en/job/EC202632/Graduate-Technology-and-AI-London',
    title: 'Graduate - Technology and AI - London',
    company: 'PwC',
    jobIds: ['EC202632'],
  });
  const v = jp.compare(ctx, other);
  assert.equal(v.verdict, 'different', v.reasons.join('; '));
  const same = jp.compare(ctx, { ...other, url, title: ctx.title, jobIds: ['EC202660'] });
  assert.equal(same.verdict, 'same');
});

test('compare: unsure when there is too little to go on', () => {
  const v = jp.compare(
    { url: 'https://example.com/apply', company: 'Contoso Bank' },
    posting({ title: 'Analyst', company: 'Contoso Bank' }),
  );
  assert.equal(v.verdict, 'unsure');
  assert.ok(v.reasons.includes('not enough on the application page to compare'));
  const similar = jp.compare(
    { url: 'https://example.com/apply', title: 'Analyst', company: 'Contoso Bank' },
    posting({ title: 'Analyst Programme', company: 'Contoso Bank' }),
  );
  assert.equal(similar.verdict, 'unsure', 'a one-word title is not enough for "same"');
  assert.equal(jp.compare({}, null).verdict, 'different');
});

test('titleSimilarity and companyMatch', () => {
  assert.equal(jp.titleSimilarity('Summer 2027', 'Summer 2026'), null);
  assert.equal(jp.titleSimilarity('Summer Analyst 2027', 'Summer Internship 2026'), 0);
  assert.ok(jp.titleSimilarity('SWE Intern - Summer 2027', 'Software Engineering Internship') >= 0.9);
  assert.ok(
    jp.titleSimilarity('Quant Research Intern', 'Quantitative Research Internship – Equities (London)') >= 0.85,
  );
  assert.ok(jp.titleSimilarity('Graduate Software Engineer', 'Investment Banking Analyst') < 0.2);
  assert.equal(jp.companyMatch('JPMC', 'JP Morgan Chase & Co.'), true);
  assert.equal(jp.companyMatch('Goldman Sachs', 'Goldman Sachs International'), true);
  assert.equal(jp.companyMatch('Point72', 'Citadel'), false);
  assert.equal(jp.companyMatch('', 'Citadel'), null);
});

/* ------------------------------------------------------------------- find */

/** A fetch that serves fixed bodies by URL, and records what was asked for. */
function mockFetch(routes, log = []) {
  return async (url, init = {}) => {
    log.push({ url, method: init.method || 'GET', accept: (init.headers || {}).Accept });
    const route = routes[url];
    if (route === undefined) return { ok: false, status: 404, url, headers: new Map(), text: async () => 'Not found' };
    if (typeof route === 'function') return route(url, init);
    const type = typeof route === 'string' ? 'text/html; charset=utf-8' : 'application/json';
    const body = typeof route === 'string' ? route : JSON.stringify(route);
    return {
      ok: true,
      status: 200,
      url,
      headers: { get: (k) => (/content-type/i.test(k) ? type : null) },
      text: async () => body,
    };
  };
}

const LEVER_APPLY = 'https://jobs.eu.lever.co/coretechsecurity/1e68e7e1-b61e-40a4-96bf-31d85cda9335/apply';
const leverCtx = () => ({
  url: LEVER_APPLY,
  host: 'jobs.eu.lever.co',
  ats: jp.ats(LEVER_APPLY),
  title: 'Junior Cyber Security Researcher - September 2027',
  company: 'CoreTech Security',
  location: 'Cheltenham',
  jobIds: ['1e68e7e1-b61e-40a4-96bf-31d85cda9335'],
  links: [],
  posting: null,
});

test('find: the board API answers with the same job', async () => {
  const log = [];
  const fetch = mockFetch(
    {
      'https://api.eu.lever.co/v0/postings/coretechsecurity/1e68e7e1-b61e-40a4-96bf-31d85cda9335':
        json('api-lever.json'),
    },
    log,
  );
  const r = await jp.find(leverCtx(), { fetch });
  assert.equal(r.verdict, 'same');
  assert.equal(r.posting.title, 'Junior Cyber Security Researcher - September 2027');
  assert.equal(r.source, 'https://api.eu.lever.co/v0/postings/coretechsecurity/1e68e7e1-b61e-40a4-96bf-31d85cda9335');
  assert.equal(log[0].accept, 'application/json');
  assert.match(r.tried.find((t) => t.url === r.source).outcome, /^same \(0\.9\d\)/);
});

test('find: 404s, timeouts and script shells are reported in tried', async () => {
  const ctx = {
    url: 'https://osv-cci.wd1.myworkdayjobs.com/en-US/CCICareers/job/Commodities-Trading-Summer-Analyst_R123/apply',
    title: 'Commodities Trading Summer Analyst',
    company: 'CCI',
    jobIds: ['R123'],
  };
  ctx.ats = jp.ats(ctx.url);
  const fetch = mockFetch({
    'https://osv-cci.wd1.myworkdayjobs.com/wday/cxs/osv-cci/CCICareers/job/Commodities-Trading-Summer-Analyst_R123':
      () => new Promise(() => {}),
    'https://osv-cci.wd1.myworkdayjobs.com/en-US/CCICareers/job/Commodities-Trading-Summer-Analyst_R123':
      html('workday-shell.html'),
  });
  const r = await jp.find(ctx, { fetch, timeout: 50 });
  assert.equal(r.posting, null);
  assert.equal(r.verdict, null);
  const outcomes = Object.fromEntries(r.tried.map((t) => [t.url.replace(/^https:\/\/[^/]+/, ''), t.outcome]));
  assert.equal(outcomes['/wday/cxs/osv-cci/CCICareers/job/Commodities-Trading-Summer-Analyst_R123'], 'timed out');
  assert.equal(
    outcomes['/en-US/CCICareers/job/Commodities-Trading-Summer-Analyst_R123'],
    'empty shell (needs scripts)',
  );
  // The studio reads these in a background tab.
  assert.ok(r.tried.some((t) => /empty|no posting|shell|script/i.test(t.outcome)));

  const errors = await jp.find(leverCtx(), {
    fetch: async (url) => {
      if (/api/.test(url)) throw new TypeError('Failed to fetch');
      return { ok: false, status: 404 };
    },
  });
  assert.deepEqual(
    errors.tried.map((t) => t.outcome),
    ['failed: Failed to fetch', 'HTTP 404'],
  );
});

test('find: iCIMS from the address alone reads the ?in_iframe=1 page', async () => {
  const url =
    'https://careers-sargentlundy.icims.com/jobs/27617/instrumentation-%26-controls-engineering-intern/job?mode=job&iis=Trackr';
  const ctx = {
    url,
    ats: jp.ats(url),
    title: 'Instrumentation & Controls Engineering Intern',
    jobIds: ['27617'],
    links: [],
  };
  const frame =
    'https://careers-sargentlundy.icims.com/jobs/27617/instrumentation-%26-controls-engineering-intern/job?in_iframe=1';
  assert.equal(jp.candidates(ctx)[0].url, frame);
  const wrapper =
    '<html><head><title>Careers</title></head><body><iframe id="icims_content_iframe"></iframe></body></html>';
  const r = await jp.find(ctx, { fetch: mockFetch({ [frame]: html('icims-frame.html'), [url]: wrapper }) });
  assert.equal(r.verdict, 'same', r.reasons.join('; '));
  assert.equal(r.source, frame);
  assert.equal(r.posting.company, 'Sargent & Lundy');
});

test('find: never an empty "tried" — closed jobs and pages with nothing to look up say so', async () => {
  const gone = jp.applicationContext(
    doc('icims-gone.html'),
    'https://careers-gtsx.icims.com/jobs/search?ss=1&notFound=1',
  );
  const r = await jp.find(gone, { fetch: mockFetch({}) });
  assert.equal(r.posting, null);
  assert.equal(r.tried.length, 1);
  assert.match(r.tried[0].outcome, /closed or no longer available/);
  assert.doesNotMatch(
    r.tried[0].outcome,
    /empty|no posting|shell|script/i,
    'not something to open in a background tab',
  );
  const bare = await jp.find({ url: 'https://example.com/apply', links: [] }, { fetch: mockFetch({}) });
  assert.match(bare.tried[0].outcome, /nothing to look up/);
  const dead = await jp.find(
    {
      url: 'https://careers-gtsx.icims.com/jobs/1588/quant-intern/job',
      ats: jp.ats('https://careers-gtsx.icims.com/jobs/1588/quant-intern/job'),
      links: [],
    },
    { fetch: async () => ({ ok: false, status: 410 }) },
  );
  assert.deepEqual(
    dead.tried.map((t) => t.outcome),
    ['HTTP 410', 'HTTP 410'],
  );
});

test('find: the description on the application page itself', async () => {
  const url = 'https://job-boards.greenhouse.io/point72/jobs/8811167002';
  const ctx = jp.applicationContext(doc('greenhouse-apply.html'), url);
  let calls = 0;
  const r = await jp.find(ctx, {
    fetch: async () => {
      calls++;
      return { ok: false, status: 500 };
    },
  });
  assert.equal(r.verdict, 'same');
  assert.equal(r.source, url);
  assert.equal(calls, 0);
});

test('find: rejects a different job and keeps looking', async () => {
  const ctx = jp.applicationContext(doc('company-apply.html'), 'https://careers.fabrikam.example/apply/REQ-40921');
  const page = (title, id) =>
    `<html><head><title>${title} | Fabrikam Capital</title><script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting',
      title,
      identifier: id,
      hiringOrganization: { name: 'Fabrikam Capital' },
      description: `<p>${title}: ${'Research systematic strategies with our quantitative teams, test ideas on large data sets and present results. '.repeat(5)}</p>`,
    })}</script></head><body><h1>${title}</h1></body></html>`;
  const right = 'https://careers.fabrikam.example/jobs/quantitative-researcher-intern-summer-2027-REQ-40921';
  const r = await jp.find(
    {
      ...ctx,
      links: [...ctx.links, { url: 'https://careers.fabrikam.example/jobs/trader-REQ-40933', text: 'Job details' }],
    },
    {
      fetch: mockFetch({
        [right]: page('Quantitative Researcher Intern (Summer 2027)', 'REQ-40921'),
        'https://careers.fabrikam.example/jobs/trader-REQ-40933': page(
          'Quantitative Trader Intern (Summer 2027)',
          'REQ-40933',
        ),
      }),
    },
  );
  assert.equal(r.verdict, 'same');
  assert.equal(r.source, right);
  assert.match(r.reasons[0], /same job ID REQ-40921/);

  const wrong = await jp.find(
    { ...ctx, links: [{ url: 'https://careers.fabrikam.example/jobs/trader-REQ-40933', text: 'Job details' }] },
    {
      fetch: mockFetch({
        'https://careers.fabrikam.example/jobs/trader-REQ-40933': page('Quantitative Trader Intern', 'REQ-40933'),
      }),
    },
  );
  assert.equal(wrong.posting, null);
  assert.equal(wrong.verdict, 'different');
});

test('find: a pasted address is tried first and accepted unless clearly different', async () => {
  const pasted = 'https://job-boards.greenhouse.io/point72/jobs/8845395002';
  const log = [];
  const base = leverCtx();
  const fetch = mockFetch(
    { 'https://boards-api.greenhouse.io/v1/boards/point72/jobs/8845395002': json('api-greenhouse.json') },
    log,
  );
  // A different-looking job: accepted (the user chose it), but only as "unsure".
  const r = await jp.find({ ...base, links: [{ url: pasted, text: 'pasted' }], pasted }, { fetch });
  assert.equal(log[0].url, 'https://boards-api.greenhouse.io/v1/boards/point72/jobs/8845395002');
  assert.equal(log.length, 1);
  assert.equal(r.source, pasted);
  assert.equal(r.posting.title, '2027 Point72 Academy Spring Insight Programme – UK');
  assert.equal(r.verdict, 'unsure');
  assert.ok(r.reasons.includes('you chose this page'));

  // Matching context: 'same'.
  const same = await jp.find(
    {
      url: 'https://example.com/apply',
      title: '2027 Point72 Academy Spring Insight Programme',
      company: 'Point72',
      links: [{ url: pasted, text: 'pasted' }],
      pasted,
    },
    { fetch },
  );
  assert.equal(same.verdict, 'same');

  // Nothing at the pasted address: fall back to the usual candidates.
  const fallback = await jp.find(
    { ...base, links: [{ url: 'https://example.com/nothing', text: 'pasted' }], pasted: 'https://example.com/nothing' },
    {
      fetch: mockFetch({
        'https://api.eu.lever.co/v0/postings/coretechsecurity/1e68e7e1-b61e-40a4-96bf-31d85cda9335':
          json('api-lever.json'),
      }),
    },
  );
  assert.equal(fallback.tried[0].url, 'https://example.com/nothing');
  assert.equal(fallback.verdict, 'same');
});

test('find: history candidates, and no fetch at all', async () => {
  const ctx = {
    url: 'https://careers.fabrikam.example/apply/REQ-40921',
    title: 'Quantitative Researcher Intern (Summer 2027)',
    company: 'Fabrikam Capital',
    jobIds: ['REQ-40921'],
    links: [],
  };
  ctx.ats = jp.ats(ctx.url);
  const seen = [];
  const jobUrl = 'https://careers.fabrikam.example/jobs/quant-researcher-intern-REQ-40921';
  const r = await jp.find(ctx, {
    now: Date.now(),
    historySearch: async (q) => {
      seen.push(q.text);
      return q.text === 'REQ-40921'
        ? [{ url: jobUrl, title: 'Quantitative Researcher Intern (Summer 2027) | Fabrikam', lastVisitTime: Date.now() }]
        : [];
    },
    fetch: mockFetch({
      [jobUrl]: `<script type="application/ld+json">${JSON.stringify({
        '@type': 'JobPosting',
        title: 'Quantitative Researcher Intern (Summer 2027)',
        identifier: 'REQ-40921',
        description: 'Research systematic trading strategies with our quantitative teams over ten weeks. '.repeat(8),
      })}</script>`,
    }),
  });
  assert.ok(seen.includes('REQ-40921'));
  assert.equal(r.verdict, 'same');
  assert.equal(r.source, jobUrl);

  const broken = await jp.find(ctx, {
    historySearch: async () => {
      throw new Error('no permission');
    },
    fetch: mockFetch({}),
  });
  assert.match(broken.tried[0].outcome, /history search failed: no permission/);

  const saved = globalThis.fetch;
  globalThis.fetch = undefined;
  try {
    const none = await jp.find(ctx, {});
    assert.deepEqual([none.posting, none.reasons], [null, ['no way to fetch pages']]);
  } finally {
    globalThis.fetch = saved;
  }
});

/* ------------------------------------------------------- round 2: hardening */

const ENTITY = /&(#\d+|#x[\da-f]+|[a-z][a-z\d]{1,8});/i;
const noEntities = (o, what) => {
  for (const k of ['title', 'company', 'location']) assert.ok(!ENTITY.test(o[k] || ''), `${what}.${k}: ${o[k]}`);
};

test('entities: titles, companies and places come out decoded from every source, even twice-encoded', () => {
  const GS = 'https://higher.gs.com/roles/174813';
  const title = '2027 | EMEA | London | FICC & Equities, Sales & Trading | Apprentice Programme';
  // DOM text, <title> and meta tags.
  const p = jp.fromHtml(html('entities-dom.html'), GS);
  assert.deepEqual([p.title, p.location], [title, 'London & South East, United Kingdom']);
  noEntities(p, 'dom posting');
  const ctx = jp.applicationContext(doc('entities-dom.html'), GS);
  assert.equal(ctx.title, title);
  assert.equal(ctx.company, 'Goldman Sachs');
  noEntities(ctx, 'context');
  noEntities(ctx.posting, 'context.posting');

  // JSON-LD (entity-encoded HTML inside JSON) and a page's embedded state.
  const ld = jp.fromHtml(html('entities-data.html'), 'https://careers.rothwell.example/jobs/MA-2027-14');
  assert.equal(ld.source, 'json-ld');
  assert.deepEqual(
    [ld.title, ld.company, ld.location],
    ['Mergers & Acquisitions Analyst – Summer 2027 ("M&A")', 'Rothwell & Partners', 'São Paulo, BR'],
  );
  assert.match(ld.description, /Join our M&A team/);
  const state = jp.fromHtml(
    html('entities-data.html').replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, ''),
    'https://careers.rothwell.example/jobs/ST-27',
  );
  assert.equal(state.source, 'page-data');
  assert.deepEqual(
    [state.title, state.company, state.location],
    ["Sales & Trading Intern '27", 'Rothwell & Partners', 'New York City'],
  );

  // Board APIs.
  const gh = jp.fromApi(
    'greenhouse',
    {
      id: 77,
      title: 'Risk &amp;amp; Quant Analyst &#x2013; Z&uuml;rich',
      company_name: 'Smith &amp; Wesson Capital',
      location: { name: 'Z&uuml;rich &amp; Geneva' },
      content:
        '&lt;p&gt;' +
        'Model market and credit risk with the quantitative team and our traders. '.repeat(6) +
        '&lt;/p&gt;',
    },
    'https://job-boards.greenhouse.io/smithcap/jobs/77',
  );
  assert.deepEqual(
    [gh.title, gh.company, gh.location],
    ['Risk & Quant Analyst – Zürich', 'Smith & Wesson Capital', 'Zürich & Geneva'],
  );
  const oracle = jp.fromApi(
    'oracle',
    {
      items: [
        {
          Id: '174813',
          Title: '2027 | EMEA | London | FICC &amp; Equities, Sales &amp;amp; Trading | Apprentice Programme',
          PrimaryLocation: 'London,&nbsp;United Kingdom',
          ExternalDescriptionStr: '<p>' + 'Rotate across trading desks and learn how markets work. '.repeat(8) + '</p>',
        },
      ],
    },
    'https://hdpc.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/LateralHiring/job/174813',
  );
  assert.deepEqual([oracle.title, oracle.location], [title, 'London, United Kingdom']);
  // "R&D", "AT&T" and "M&A" are not entities and stay as they are.
  const plain = jp.fromApi(
    'greenhouse',
    { id: 5, title: 'R&D Engineer, AT&T M&A', content: '<p>' + 'Build test rigs for our labs. '.repeat(12) + '</p>' },
    'https://job-boards.greenhouse.io/acme/jobs/5',
  );
  assert.equal(plain.title, 'R&D Engineer, AT&T M&A');
});

test('cookie banners and legal pop-ups are never the posting; an embedded Greenhouse board answers for gh_jid', async () => {
  const URL0 = 'https://www.verition.com/open-positions?gh_jid=5239291007';
  const ctx = jp.applicationContext(doc('gh-embed-cookies.html'), URL0);
  assert.equal(ctx.posting, null);
  assert.ok(!/privacy|cookie/i.test(ctx.title), ctx.title);
  assert.deepEqual(ctx.embeds, [
    'https://job-boards.greenhouse.io/embed/job_app?for=veritiongroupllc&token=5239291007',
    'https://boards.greenhouse.io/embed/job_board/js?for=veritiongroupllc',
  ]);
  assert.equal(jp.fromHtml(html('gh-embed-cookies.html'), 'https://www.verition.com/disclosures'), null);
  const api = 'https://boards-api.greenhouse.io/v1/boards/veritiongroupllc/jobs/5239291007';
  assert.equal(jp.candidates(ctx)[0].url, api);
  const found = await jp.find(ctx, { fetch: mockFetch({ [api]: json('api-greenhouse-verition.json') }) });
  assert.deepEqual(
    [found.verdict, found.source, found.posting.title, found.posting.company],
    ['same', api, '2027 Investment Internship (London)', 'Verition Group LLC'],
  );
  assert.match(found.reasons[0], /same job ID 5239291007/);

  // Text that only the page vouches for: a privacy notice is never 'same', even when it is long.
  const notice = html('gh-embed-cookies.html')
    .match(/<div class="noOrphanP">([\s\S]*?)<\/div>/)[1]
    .replace(/<[^>]+>/g, ' ');
  const privacy = {
    ...ctx,
    embeds: [],
    posting: { title: 'Your Privacy', description: notice + notice, source: 'page-text', confidence: 0.65, jobIds: [] },
  };
  const r1 = await jp.find(privacy, { fetch: mockFetch({}) });
  assert.notEqual(r1.verdict, 'same');
  assert.equal(r1.posting, null);
  // A real advert in the page text, while the board can't be reached: 'likely', not 'same'.
  const advert = jp.htmlToText(json('api-greenhouse-verition.json').content);
  const onPage = { ...privacy, posting: { ...privacy.posting, title: '', description: advert + '\n\n' + advert } };
  const r2 = await jp.find(onPage, { fetch: mockFetch({}) });
  assert.deepEqual([r2.verdict, r2.reasons[1]], ['likely', 'the job board didn’t confirm it']);
});

/* ------------------------------------------- sign-in walls: this tab's trail and history */

const HSBC_JOB =
  'https://apply.careers.hsbc.com/emergingtalent/job/London-Markets-Sales-and-Trading-Off-Cycle-Internship-E14-5HQ/1373576757/';
const HSBC_OTHER =
  'https://apply.careers.hsbc.com/emergingtalent/job/London-Relationship-Management-Private-Bank-Graduate-E14-5HQ/1373565757/';
const HSBC_TITLE = 'Markets - Sales and Trading - Off-Cycle Internship Job Details | HSBC Global Services Limited';
const OTHER_TITLE = 'Relationship Management - Private Bank - Graduate Job Details | HSBC Global Services Limited';
const rmkPage = (title, id) =>
  html('rmk-job.html')
    .replace(/Markets - Sales and Trading - Off-Cycle Internship/g, title)
    .replace(/1373576757/g, id);
// Where SuccessFactors' Apply lands without a session: the site's home page, without the job.
const hsbcRoot = () =>
  jp.applicationContext(
    parseHTML(
      '<html><head><title>HSBC Careers</title></head><body><header><img class="logo" alt="HSBC"></header>' +
        '<h1>SEARCH FOR JOBS THAT ARE MATCHED TO YOUR SKILL SET!</h1><div class="jobTitle"><a href="/emergingtalent/job/x/1373599999/">' +
        'Featured: Global Banking Analyst</a></div></body></html>',
    ).document,
    'https://apply.careers.hsbc.com/',
  );

test('trail: the job page this tab showed before a sign-in wall is found; lists and searches are ignored', async () => {
  const now = Date.parse('2026-10-02T10:00:00Z');
  const ctx = hsbcRoot();
  assert.deepEqual([ctx.title, ctx.company, ctx.jobIds], ['', 'HSBC', []]);
  ctx.trail = [
    { url: HSBC_JOB, title: HSBC_TITLE, at: now - 2 * 6e4 },
    {
      url: 'https://apply.careers.hsbc.com/emergingtalent/search/?q=trading',
      title: 'Search results | HSBC',
      at: now - 4 * 6e4,
    },
    {
      url: 'https://www.google.com/search?q=hsbc+off+cycle',
      title: 'hsbc off cycle - Google Search',
      at: now - 6 * 6e4,
    },
    { url: HSBC_OTHER, title: OTHER_TITLE, at: now - 9 * 6e4 },
    { url: 'https://apply.careers.hsbc.com/', title: 'HSBC Careers', at: now - 12 * 6e4 },
    {
      url: 'https://app.the-trackr.com/uk-finance/off-cycle-internships',
      title: 'UK Finance - Trackr',
      at: now - 14 * 6e4,
    },
  ];
  const list = jp.candidates(ctx, now);
  assert.equal(list[0].url, HSBC_JOB);
  assert.equal(list[0].reason, 'the job page you opened before this one in this tab');
  assert.ok(list[0].weight >= 0.6 && list[0].weight < 0.88, String(list[0].weight));
  assert.ok(list[1].url === HSBC_OTHER && list[1].weight < list[0].weight);
  assert.equal(list.length, 2, list.map((c) => c.url).join(' '));

  const found = await jp.find(ctx, {
    now,
    fetch: mockFetch({
      [HSBC_JOB]: html('rmk-job.html'),
      [HSBC_OTHER]: rmkPage('Relationship Management - Private Bank - Graduate', '1373565757'),
    }),
  });
  assert.deepEqual(
    [found.verdict, found.source, found.posting.title, found.posting.location],
    ['likely', HSBC_JOB, 'Markets - Sales and Trading - Off-Cycle Internship', 'London, GB, E14 5HQ'],
  );
  assert.ok(found.reasons.includes('you opened this page before this one in this tab'), found.reasons.join('; '));
  assert.ok(found.reasons.includes('the job page you opened before this one in this tab'));
});

test('trail: pages of other jobs lose to the context’s own job, and are rejected when it names a different one', async () => {
  const now = Date.parse('2026-10-02T10:00:00Z');
  const CAP = 'https://careers.capgemini.com/job/Telford-Graduate-Software-Engineering-Programme-2027/1443168333/';
  const SUBSEA = 'https://careers.subsea7.com/job/London-%28Sutton%29-Graduate-Engineers-2027-Sutton/1366219555/';
  const LYB = 'https://careers.lyondellbasell.com/job/Houston-2027-Trading-&-Supply-Intern-TX-77056/1428780300/';
  const ctx = {
    url: 'https://careers.capgemini.com/talentcommunity/login/',
    ats: jp.ats('https://careers.capgemini.com/talentcommunity/login/'),
    title: 'Graduate Software Engineering Programme 2027',
    company: 'Capgemini',
    location: 'Telford',
    jobIds: [],
    links: [],
    trail: [
      { url: SUBSEA, title: 'Graduate Engineers 2027 - Sutton Job Details | Subsea7', at: now - 3 * 6e4 },
      { url: CAP, title: 'Graduate Software Engineering Programme 2027 Job Details | Capgemini', at: now - 8 * 6e4 },
      {
        url: LYB,
        title: '2027 Trading & Supply Intern Job Details | LyondellBasell North America',
        at: now - 20 * 6e4,
      },
    ],
  };
  const list = jp.candidates(ctx, now);
  assert.deepEqual(
    list.map((c) => c.url),
    [CAP, SUBSEA, LYB],
  );
  const page = (title, company, place) =>
    `<script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting',
      title,
      hiringOrganization: { name: company },
      jobLocation: { address: { addressLocality: place } },
      description: 'Join our graduate programme and work on real projects with experienced engineers. '.repeat(10),
    })}</script>`;
  const routes = {
    [CAP]: page('Graduate Software Engineering Programme 2027', 'Capgemini', 'Telford'),
    [SUBSEA]: page('Graduate Engineers 2027 - Sutton', 'Subsea7', 'Sutton'),
    [LYB]: page('2027 Trading & Supply Intern', 'LyondellBasell', 'Houston'),
  };
  const found = await jp.find(ctx, { now, fetch: mockFetch(routes) });
  assert.deepEqual([found.verdict, found.source], ['same', CAP]);
  // Without the right page in the trail, the other jobs are rejected, not offered.
  const none = await jp.find(
    { ...ctx, trail: ctx.trail.filter((e) => e.url !== CAP) },
    { now, fetch: mockFetch(routes) },
  );
  assert.equal(none.posting, null);
  assert.equal(none.verdict, 'different');
});

/** chrome.history.search over a list of visits: every word of the text in the address or title, newest first. */
const historyOf = (visits) => async (q) =>
  visits
    .filter((v) => v.lastVisitTime >= (q.startTime || 0))
    .filter((v) =>
      String(q.text || '')
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .every((w) => `${v.url} ${v.title}`.toLowerCase().includes(w)),
    )
    .sort((a, b) => b.lastVisitTime - a.lastVisitTime)
    .slice(0, q.maxResults || 100);

test('history: behind a sign-in wall, the job page opened minutes before wins over searches, lists and other jobs', async () => {
  const now = Date.parse('2026-10-02T10:00:00Z');
  const min = 6e4;
  const visits = [
    {
      url: 'https://www.google.com/search?q=hsbc+markets+off+cycle',
      title: 'hsbc markets off cycle - Google Search',
      lastVisitTime: now - 31 * min,
      visitCount: 1,
    },
    {
      url: 'https://app.the-trackr.com/uk-finance/off-cycle-internships',
      title: 'UK Finance - Trackr',
      lastVisitTime: now - 30 * min,
      visitCount: 6,
    },
    {
      url: 'https://www.linkedin.com/jobs/search/?keywords=hsbc%20trading',
      title: '(3) hsbc trading Jobs | LinkedIn',
      lastVisitTime: now - 26 * min,
      visitCount: 1,
    },
    {
      url: 'https://apply.careers.hsbc.com/emergingtalent/',
      title: 'Careers | HSBC',
      lastVisitTime: now - 25 * min,
      visitCount: 3,
    },
    {
      url: 'https://apply.careers.hsbc.com/emergingtalent/search/?q=trading',
      title: 'Search results | HSBC',
      lastVisitTime: now - 24 * min,
      visitCount: 1,
    },
    { url: HSBC_OTHER, title: OTHER_TITLE, lastVisitTime: now - 3 * 864e5, visitCount: 2 },
    {
      url: 'https://job-boards.greenhouse.io/point72/jobs/8811167002',
      title: 'Job Application for Investment Analyst at Point72',
      lastVisitTime: now - 8 * min,
      visitCount: 1,
    },
    {
      url: HSBC_JOB + '?utm_source=Trackr&utm_medium=tracker&utm_campaign=UK_Finance_2027',
      title: HSBC_TITLE,
      lastVisitTime: now - 6 * min,
      visitCount: 1,
    },
  ];
  const ctx = hsbcRoot();
  assert.deepEqual(
    jp.historyQuery(ctx, now).map((q) => q.text),
    ['HSBC', ''],
  );
  const items = [];
  for (const q of jp.historyQuery(ctx, now)) items.push(...(await historyOf(visits)(q)));
  const ranked = jp.rankHistory(ctx, items, now);
  assert.match(ranked[0].url, /1373576757/);
  assert.deepEqual(ranked[0].history, { ageMin: 6, latest: true, rivals: 0 });
  assert.match(ranked[0].reason, /same site, opened 6 min ago/);
  assert.deepEqual(
    ranked.map((r) => r.url.replace(/\?.*$/, '')),
    [HSBC_JOB, HSBC_OTHER],
  );
  const routes = {
    [HSBC_JOB + '?utm_source=Trackr&utm_medium=tracker&utm_campaign=UK_Finance_2027']: html('rmk-job.html'),
    [HSBC_OTHER]: rmkPage('Relationship Management - Private Bank - Graduate', '1373565757'),
  };
  // History alone picks the right job but can't prove it (the page has nothing to compare): 'unsure', for the
  // AI check and the user to confirm.
  const found = await jp.find(ctx, { now, historySearch: historyOf(visits), fetch: mockFetch(routes) });
  assert.deepEqual(
    [found.verdict, found.posting && found.posting.title],
    ['unsure', 'Markets - Sales and Trading - Off-Cycle Internship'],
  );
  assert.ok(found.reasons.some((r) => /opened 6 min ago/.test(r)) || /opened 6 min ago/.test(ranked[0].reason));

  // Two HSBC jobs opened within the same few minutes (tabs): the newer one is offered, but only as 'unsure'.
  const tabs = visits.map((v) => (v.url === HSBC_OTHER ? { ...v, lastVisitTime: now - 4 * min } : v));
  const both = await jp.find(ctx, { now, historySearch: historyOf(tabs), fetch: mockFetch(routes) });
  assert.equal(both.verdict, 'unsure');
  assert.match(both.posting.title, /Relationship Management/);
});

test('history: Amazon passport sign-in, and an application page whose title rejects the newest job page', async () => {
  const now = Date.parse('2026-10-02T10:00:00Z');
  const min = 6e4;
  const AMZ =
    'https://www.amazon.jobs/en/jobs/10435672/2027-amazon-finance-rotation-program-business-unit-finance-intern';
  const AMZ2 = 'https://www.amazon.jobs/en/jobs/10554390/financial-analyst-intern-2027';
  const ld = (title, id, place) =>
    `<script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting',
      title,
      identifier: id,
      hiringOrganization: { name: 'Amazon' },
      jobLocation: { address: { addressLocality: place } },
      description:
        'Rotate through finance teams, build forecasts and analyse business performance with your team. '.repeat(9),
    })}</script>`;
  const passport = jp.applicationContext(
    parseHTML(
      '<html><head><title>Amazon.jobs</title></head><body><h1>Sign in</h1><form><input name="email"></form></body></html>',
    ).document,
    'https://passport.amazon.jobs/',
  );
  assert.deepEqual([passport.title, passport.jobIds], ['', []]);
  const visits = [
    {
      url: 'https://www.amazon.jobs/en/search?base_query=finance+intern',
      title: 'Search Jobs | Amazon.jobs',
      lastVisitTime: now - 20 * min,
    },
    {
      url: AMZ2,
      title: 'Financial Analyst Intern 2027 - Job ID: 10554390 | Amazon.jobs',
      lastVisitTime: now - 2 * 864e5,
    },
    {
      url: AMZ,
      title: '2027 Amazon Finance Rotation Program - Business Unit Finance Intern - Job ID: 10435672 | Amazon.jobs',
      lastVisitTime: now - 4 * min,
    },
  ];
  const routes = {
    [AMZ]: ld('2027 Amazon Finance Rotation Program - Business Unit Finance Intern', '10435672', 'Seattle'),
    [AMZ2]: ld('Financial Analyst Intern 2027', '10554390', 'Seattle'),
  };
  const r = await jp.find(passport, { now, historySearch: historyOf(visits), fetch: mockFetch(routes) });
  assert.deepEqual([r.verdict, r.source], ['unsure', AMZ]);
  // Only another Amazon job in history: offered at most as 'unsure', never 'same' or 'likely'.
  const onlyOther = visits
    .filter((v) => v.url !== AMZ)
    .map((v) => (v.url === AMZ2 ? { ...v, lastVisitTime: now - 3 * min } : v));
  const r0 = await jp.find(passport, { now, historySearch: historyOf(onlyOther), fetch: mockFetch(routes) });
  assert.ok(!['same', 'likely'].includes(r0.verdict), r0.verdict);

  // The application page names its job: the newest job page in history is a different one and is rejected.
  const named = {
    url: 'https://www.amazon.jobs/en/applicant/jobs/10554390/apply',
    ats: jp.ats('https://www.amazon.jobs/en/applicant/jobs/10554390/apply'),
    title: 'Financial Analyst Intern 2027',
    company: 'Amazon',
    location: 'Seattle',
    jobIds: ['10554390'],
    links: [],
  };
  const r2 = await jp.find(named, { now, historySearch: historyOf(visits), fetch: mockFetch(routes) });
  assert.deepEqual([r2.verdict, r2.posting.title], ['same', 'Financial Analyst Intern 2027']);
  const amz = r2.tried.find((t) => t.url === AMZ);
  assert.ok(!amz || /^different/.test(amz.outcome), amz && amz.outcome);
});

test('Trackr: where the user came from names the programme — a hint that breaks ties, never the description', async () => {
  const now = Date.parse('2026-10-02T10:00:00Z');
  const min = 6e4;
  const TAGGED = HSBC_JOB + '?utm_source=Trackr&utm_medium=tracker&utm_campaign=UK_Finance_2027';
  assert.deepEqual(jp.trackrHint({ url: 'https://apply.careers.hsbc.com/', referrer: 'https://app.the-trackr.com/' }), {
    region: null,
    industry: null,
    season: null,
    type: null,
    links: [],
  });
  const visits = [
    {
      url: 'https://app.the-trackr.com/uk-finance/off-cycle-internships',
      title: 'UK Finance - Trackr',
      lastVisitTime: now - 9 * min,
    },
    { url: TAGGED, title: HSBC_TITLE, lastVisitTime: now - 6 * min },
    { url: HSBC_OTHER, title: OTHER_TITLE, lastVisitTime: now - 3 * min },
  ];
  const ctx = hsbcRoot();
  const hint = jp.trackrHint(ctx, visits);
  assert.deepEqual(hint, {
    region: 'UK',
    industry: 'Finance',
    season: '2027',
    type: 'off-cycle-internships',
    links: [TAGGED],
  });
  const API = 'https://api.the-trackr.com/programmes?region=UK&industry=Finance&season=2027&type=off-cycle-internships';
  assert.deepEqual(
    jp.trackrRequests(hint).map((r) => r.url),
    [API],
  );
  const routes = {
    [API]: json('trackr-uk-finance-off-cycle.json'),
    [TAGGED]: html('rmk-job.html'),
    [HSBC_OTHER]: rmkPage('Relationship Management - Private Bank - Graduate', '1373565757'),
  };
  // Two HSBC jobs opened minutes apart: history alone can't tell them apart (see above); Trackr's programme can.
  const found = await jp.find(ctx, { now, historySearch: historyOf(visits), fetch: mockFetch(routes) });
  assert.deepEqual(
    [found.verdict, found.posting.title],
    ['likely', 'Markets - Sales and Trading - Off-Cycle Internship'],
  );
  assert.match(found.posting.description, /rotate across sales and trading desks/);
  assert.ok(found.reasons.includes('the programme you opened on Trackr'), found.reasons.join('; '));
  assert.deepEqual(
    [found.hint.source, found.hint.company, found.hint.programme, found.hint.deadline],
    ['Trackr', 'HSBC', 'Markets - Sales and Trading - Off-Cycle Internship', '2026-10-15'],
  );
  assert.match(found.tried.find((t) => t.url === API).outcome, /^Trackr: Markets - Sales and Trading/);

  // A page that names its own job keeps its own verdicts: the hint doesn't turn a different job into a match.
  const other = await jp.find(
    {
      ...ctx,
      url: HSBC_OTHER + 'apply',
      title: 'Relationship Management - Private Bank - Graduate',
      jobIds: ['1373565757'],
    },
    { now, historySearch: historyOf(visits), fetch: mockFetch(routes) },
  );
  assert.notEqual(other.posting && other.posting.title, 'Markets - Sales and Trading - Off-Cycle Internship');
});

test('closed jobs: a job address that redirects to a list of open positions is reported as closed, not as a posting', async () => {
  const LIST = 'https://www.bluerivertechnology.com/careers/open-positions/';
  const JOB = 'https://www.bluerivertechnology.com/job/?gh_jid=7947246';
  // The list itself is no posting, here or at an address that doesn't look like a list.
  assert.equal(jp.fromHtml(html('closed-redirect-list.html'), LIST), null);
  assert.equal(
    jp.fromHtml(html('closed-redirect-list.html'), 'https://www.bluerivertechnology.com/team/join-us/'),
    null,
  );
  const listCtx = jp.applicationContext(doc('closed-redirect-list.html'), LIST);
  assert.equal(listCtx.posting, null);
  assert.equal(listCtx.company, 'Blue River Technology');
  // Opened from the trail, the job's page lands on the list.
  const ctx = {
    url: 'https://www.bluerivertechnology.com/apply',
    ats: jp.ats('https://www.bluerivertechnology.com/apply'),
    title: '2026 Machine Learning Intern, Autonomy',
    company: 'Blue River Technology',
    jobIds: [],
    links: [],
    trail: [
      { url: JOB, title: '2026 Machine Learning Intern, Autonomy | Blue River Technology', at: Date.now() - 6e4 },
    ],
  };
  const redirected = () => ({
    ok: true,
    status: 200,
    url: LIST,
    headers: { get: () => 'text/html' },
    text: async () => html('closed-redirect-list.html'),
  });
  const r = await jp.find(ctx, { now: Date.now(), fetch: mockFetch({ [JOB]: redirected }) });
  assert.equal(r.posting, null);
  const t = r.tried.find((x) => x.url === JOB);
  assert.match(
    t.outcome,
    /^closed: the job page now redirects to https:\/\/www\.bluerivertechnology\.com\/careers\/open-positions/,
  );
  assert.ok(!/empty|no posting|shell|script/i.test(t.outcome), 'the studio must not re-read it in a tab');
  assert.ok(
    r.reasons.some((x) => /probably closed/.test(x)),
    r.reasons.join('; '),
  );
  // A redirect to a sign-in page is not a closed job; the studio may read it in a tab with the user's session.
  const login = () => ({ ...redirected(), url: 'https://www.bluerivertechnology.com/candidate/login?next=%2Fjob%2F' });
  const r2 = await jp.find(ctx, { now: Date.now(), fetch: mockFetch({ [JOB]: login }) });
  const t2 = r2.tried.find((x) => x.url === JOB);
  assert.match(t2.outcome, /no posting without signing in/);
  assert.ok(!r2.reasons.some((x) => /closed/.test(x)));
});

test('Oleeo (tal.net): opportunity pages, the apply step, and the advert inside a read-only form', () => {
  const DESC =
    'https://blackrock.tal.net/vx/lang-en-GB/mobile-0/brand-3/user-2489896/xf-9b8e2dccf17f/candidate/so/pm/1/pl/1/opp/11984-2027-Summer-Internship-Program-APAC/en-GB';
  const APPLY =
    'https://blackrock.tal.net/vx/lang-en-GB/mobile-0/brand-3/user-2489896/xf-4c3e8ca7b9cc/candidate/so/pm/1/pl/1/opp/11984/apply/en-GB';
  assert.deepEqual(jp.ats(DESC), { name: 'tal.net', company: 'blackrock', jobId: '11984', stage: 'description' });
  assert.deepEqual(
    [
      jp.ats(APPLY).stage,
      jp.ats(APPLY).jobId,
      jp.ats('https://nomuracampus.tal.net/vx/candidate/so/pm/1/pl/1/opp/1518-x').company,
    ],
    ['application', '11984', 'nomura'],
  );
  // The session's user number is not a job ID.
  assert.ok(!jp.urlJobIds(DESC).includes('2489896'), jp.urlJobIds(DESC).join());
  assert.equal(
    jp.ats(
      'https://jefferies.tal.net/vx/lang-en-GB/mobile-0/appcentre-ext/brand-4/user-415213/xf-5ac368c85a0a/candidate/jobboard/vacancy/2/adv/',
    ).stage,
    'unknown',
  );
  assert.deepEqual(
    jp.descriptionUrls(APPLY).map((d) => d.url),
    [
      'https://blackrock.tal.net/vx/lang-en-GB/mobile-0/brand-3/user-2489896/xf-4c3e8ca7b9cc/candidate/so/pm/1/pl/1/opp/11984',
    ],
  );
  const p = jp.fromHtml(html('oleeo-vacancy.html'), DESC);
  assert.equal(p.title, '2027 Summer Internship Program - APAC');
  assert.equal(p.company, 'BlackRock');
  assert.deepEqual(p.jobIds, ['11984']);
  assert.match(p.description, /one year away from finishing/);
  assert.ok(words(p.description) > 150);
});

test('sign-in and easy-apply pages: the job they name in their address is a candidate', () => {
  const bcg =
    'https://studenttalent.bcg.com/candidate/login?domain=bcg.com&hl=en&utm_source=Phenom&next=https%3A%2F%2Fstudenttalent.bcg.com%2Fcareerhub%2Fexplore%2Fjobs%2F790315435619%3Fpost_onboarding_pid%3D790315435619%26amp%3Bshow_apply%3D1';
  const ctx = jp.applicationContext(
    parseHTML(
      '<html><head><title>Login</title><meta property="og:site_name" content="Company"></head><body><h1>Sign in</h1></body></html>',
    ).document,
    bcg,
  );
  assert.equal(ctx.company, ''); // not "Company"
  const c = jp.candidates(ctx)[0];
  assert.deepEqual(
    [c.url, c.reason],
    [
      'https://studenttalent.bcg.com/careerhub/explore/jobs/790315435619?post_onboarding_pid=790315435619&show_apply=1',
      'the job this sign-in page will return to',
    ],
  );
  // SAP easy-apply carries the requisition as ReqId=; Yello's /new_candidate step sits under the requisition.
  assert.deepEqual(
    jp.urlJobIds('https://ea-lidl.cfapps.eu20.hana.ondemand.com/easyapply/index.html?ReqId=751069&sap-language=en_GB'),
    ['751069'],
  );
  assert.deepEqual(
    jp
      .descriptionUrls('https://db.recsolu.com/external/requisitions/KjA5VnH2SAzsZbIs-ZFeMg/new_candidate')
      .map((d) => d.url),
    ['https://db.recsolu.com/external/requisitions/KjA5VnH2SAzsZbIs-ZFeMg'],
  );
  // A portal's own sign-in page is not the job.
  assert.deepEqual(jp.descriptionUrls('https://careers.example.com/talentcommunity/login/'), []);
});

test('German and French adverts: their own section headings, references and places; no cookie text, no similar jobs', () => {
  const DE = 'https://www.hellweg-partner.example/karriere/stellen/hp-2027-031';
  const de = jp.fromHtml(html('de-stellenanzeige.html'), DE);
  assert.deepEqual(
    [de.title, de.company, de.location],
    ['Praktikum Corporate Finance / M&A (m/w/d)', 'Hellweg & Partner', 'Frankfurt am Main'],
  );
  assert.match(de.description, /Ihre Aufgaben[\s\S]*Ihr Profil[\s\S]*Wir bieten/);
  assert.ok(!/Cookies|Debt Advisory|Restructuring/.test(de.description), de.description);
  const deCtx = jp.applicationContext(doc('de-stellenanzeige.html'), DE);
  assert.ok(deCtx.posting, 'a German advert counts as a real description');
  assert.deepEqual([deCtx.jobIds, deCtx.company], [['HP-2027-031'], 'Hellweg & Partner']);

  // French: the sections are a collapsed accordion, and the JSON-LD is a featured job in Lyon (another reference).
  const FR = 'https://carrieres.banque-lumiere.example/offres/2026-118-stage-analyste-ma-paris';
  const fr = jp.fromHtml(html('fr-offre-accordeon.html'), FR);
  assert.equal(fr.source, 'page-text');
  assert.equal(fr.title, 'Stage Analyste M&A – Paris (H/F)');
  assert.match(fr.description, /Vos missions[\s\S]*valorisations[\s\S]*Profil recherché/);
  assert.ok(!/Lyon|cookies/i.test(fr.description), fr.description);
  const frCtx = jp.applicationContext(doc('fr-offre-accordeon.html'), FR);
  assert.deepEqual([frCtx.title, frCtx.jobIds], ['Stage Analyste M&A – Paris (H/F)', ['2026-118']]);
  // The featured job is 'different' from the page's own.
  const lyon = {
    url: 'https://carrieres.banque-lumiere.example/offres/2026-097-analyste-credit-lyon',
    title: 'Analyste Crédit – Lyon (H/F)',
    company: 'Banque Lumière',
    location: 'Lyon, FR',
    jobIds: ['2026-097'],
  };
  assert.equal(jp.compare(frCtx, lyon).verdict, 'different');
});

test('several JobPosting blocks with nothing to say which, requisition codes in titles, one programme in several cities', () => {
  // A page listing three JobPostings whose heading names none of them: no posting from its JSON-LD.
  const list = html('jsonld-list.html')
    .replace(/<h1>[^<]*<\/h1>/, '<h1>Summer programmes</h1>')
    .replace(/<title>[^<]*/, '<title>Summer programmes | Contoso Bank Careers');
  const p = jp.fromHtml(list, 'https://careers.contoso.example/students/summer');
  assert.ok(!p || p.source !== 'json-ld', p && p.title);

  assert.equal(jp.titleSimilarity('Quantitative Analyst (Req #12345)', 'Quantitative Analyst'), 1);
  assert.equal(jp.titleSimilarity('Software Engineer [JR-1234]', 'Software Engineer - R0012345'), 1);
  assert.deepEqual(jp.textJobIds('Quantitative Analyst (Req #12345)'), ['12345']);

  // The same programme in London and New York is not the same job, whether the city is in the title or the place.
  const base = { company: 'Morgan Stanley', jobIds: [], url: 'https://ms.tal.net/vx/candidate/apply' };
  const london = { ...base, title: '2027 Technology Summer Analyst Program – London', location: '' };
  const nyPosting = posting({
    title: '2027 Technology Summer Analyst Program – New York',
    company: 'Morgan Stanley',
    location: 'New York, NY, United States',
    url: 'https://morganstanley.tal.net/vx/candidate/so/pm/1/pl/1/opp/17060-2027-Technology-Summer-Analyst-Program-New-York',
  });
  assert.equal(jp.compare(london, nyPosting).verdict, 'different');
  assert.equal(
    jp.compare({ ...london, title: '2027 Technology Summer Analyst Program', location: 'London' }, nyPosting).verdict,
    'different',
  );
  const ldnPosting = {
    ...nyPosting,
    title: '2027 Technology Summer Analyst Program – London',
    location: 'London, United Kingdom',
  };
  assert.equal(jp.compare(london, ldnPosting).verdict, 'same');
  // "London, New York or remote" is not a clash.
  assert.notEqual(jp.compare(london, { ...nyPosting, location: 'London / New York' }).verdict, 'different');
});

test('lists and logos: RMK category pages are lists, and an image file name is not a company', () => {
  const list =
    '<html><head><title>Early careers Jobs</title></head><body><header><img class="logo" alt="Marsh_48px"></header><main>' +
    Array.from(
      { length: 8 },
      (_, i) =>
        `<div class="job"><a href="/job/Markets-Intern-US-2027/6104${i}-en_GB">Markets Intern US 2027 ${i}</a><p>New York, United States. Apply to join our markets team for the summer programme and work with experienced traders.</p></div>`,
    ).join('') +
    '</main></body></html>';
  assert.equal(jp.fromHtml(list, 'https://jobs.standardchartered.com/go/Early-careers-Jobs/9783557/'), null);
  const ctx = jp.applicationContext(parseHTML(list).document, 'https://careers.marsh.com/global/en/apply?jobSeqNo=X');
  assert.equal(ctx.company, 'Marsh');
  // A template's placeholder ("Company Name" on careers.phillips66.com) is no company either.
  const placeholder = jp.applicationContext(
    parseHTML(
      '<html><head><title>Careers</title><meta property="og:site_name" content="Company Name"></head><body></body></html>',
    ).document,
    'https://careers.phillips66.com/',
  );
  assert.equal(placeholder.company, '');
  // SuccessFactors' classic apply page: "Career Opportunities: {title} - {company} ({requisition})".
  const sf = jp.applicationContext(
    parseHTML(
      '<html><head><title>Career Opportunities: Student Internship Programme 1H2027 - Hang Seng Bank (HK) (55392)</title></head><body><h1>Apply</h1></body></html>',
    ).document,
    'https://career2.successfactors.eu/careers?company=hsbcholdin&career_ns=job_application&career_job_req_id=55392',
  );
  assert.deepEqual(
    [sf.title, sf.company, sf.jobIds],
    ['Student Internship Programme 1H2027', 'Hang Seng Bank (HK)', ['55392']],
  );
  // Page text whose only heading is the equal-opportunity statement: the advert's first title-like line instead.
  const eeo = jp.fromHtml(
    '<html><head><title>Careers | WWT</title></head><body><main><div class="job"><p>Back</p><p>Technology &amp; Analytics Intern- 2027</p><p>#26-2239</p><p>Multiple Locations</p>' +
      '<h3>Responsibilities</h3><p>' +
      'Work with analytics teams on dashboards, data pipelines and reporting for our customers across many industries. '.repeat(
        4,
      ) +
      '</p><h3>Qualifications</h3><p>Pursuing a degree in data science, statistics, computer science or a related field, with strong communication skills.</p>' +
      '<h2>WWT is an Equal Opportunity Employer</h2><p>We consider all qualified applicants without regard to protected characteristics, in line with applicable law.</p></div></main></body></html>',
    'https://myjobs.adp.com/wwtexternalcareersite/cx/job-details?reqId=5001213867100',
  );
  assert.equal(eeo.title, 'Technology & Analytics Intern- 2027');
  // A language picker's heading is no job title.
  const lang = jp.applicationContext(
    parseHTML(
      '<html><head><title>Law vacation scheme - England Vacation placement</title></head><body><div class="language-selector"><h2>View this site in your language</h2></div></body></html>',
    ).document,
    'https://www.pinsentmasons.com/careers/early-talent/england/vacation-placement',
  );
  assert.ok(!/language/i.test(lang.title), lang.title);
  // A video player inside the application page (its frame's title once became the job's title).
  const video = jp.applicationContext(
    parseHTML('<html><head><title>Vimeo</title></head><body><h1>Our people</h1></body></html>').document,
    'https://player.vimeo.com/video/1079445251?background=1',
  );
  assert.deepEqual([video.title, video.company, video.jobIds], ['', '', []]);
  // A law firm's graduate portal on a recruiting platform: the subdomain is the firm, not the platform.
  const portal = jp.applicationContext(
    parseHTML(
      '<html><head><title>DWF</title><meta property="og:site_name" content="AllHires"></head><body></body></html>',
    ).document,
    'https://dwf.grad.allhires.com/app/',
  );
  assert.equal(portal.company, 'DWF');
  // An iCIMS sign-in page for careers.sig.com: the tab names the site, and "SIG" is Susquehanna International Group;
  // another job on the company's own site is a different job.
  const ICIMS = 'https://careers-sig.icims.com/jobs/10837/login?_sp=ec357c4d';
  const sig = jp.applicationContext(
    parseHTML('<html><head><title>Susquehanna International Group, LLP Careers</title></head><body></body></html>')
      .document,
    ICIMS,
  );
  assert.equal(sig.title, '');
  assert.equal(jp.companyMatch('SIG', 'Susquehanna International Group, LLP'), true);
  const other = posting({
    url: 'https://careers.sig.com/intern-co-op/jobs/10838?lang=en-us',
    title: 'Quantitative Trader Internship: Summer 2027',
    company: 'Susquehanna International Group, LLP',
    jobIds: ['10838'],
  });
  assert.equal(jp.compare(sig, other).verdict, 'different');
  assert.equal(
    jp.compare(sig, { ...other, url: 'https://careers.sig.com/intern-co-op/jobs/10837', jobIds: ['10837'] }).verdict,
    'same',
  );
});

test('one Workable programme in three cities (Clipperton, jobs.workable.com data): only the same city is the same job', () => {
  const APPLY = 'https://apply.workable.com/clipperton/j/E398F06FC2/apply/';
  const ctx = {
    url: APPLY,
    ats: jp.ats(APPLY),
    title: 'Technology M&A Analyst - Paris - January or March 2027 (Internship)',
    company: 'Clipperton',
    location: 'Paris, Île-de-France, France',
    jobIds: ['E398F06FC2'],
  };
  const job = (title, location) =>
    posting({ title, company: 'Clipperton', location, url: 'https://jobs.workable.com/view/x/technology-m%26a' });
  const munich = job('Technology M&A Analyst - Munich - Q4 2026 (Internship)', 'Munich, Bavaria, Germany');
  const berlin = job('Technology M&A Analyst - Berlin - Q4 2026 (Internship)', 'Berlin, Berlin, Germany');
  const paris = job(
    'Technology M&A Analyst - Paris - January or March 2027 (Internship)',
    'Paris, Île-de-France, France',
  );
  assert.equal(jp.compare(ctx, munich).verdict, 'different');
  assert.equal(jp.compare(ctx, berlin).verdict, 'different');
  assert.equal(jp.compare(ctx, paris).verdict, 'same');
  // Without a location on the application page, the cities in the titles still tell them apart.
  assert.equal(jp.compare({ ...ctx, location: '' }, munich).verdict, 'different');
});

test('50skills: the apply step, the job page behind it and its public JSON', async () => {
  const APPLY = 'https://jobs.50skills.com/stifel/en/23155/apply';
  assert.deepEqual(jp.ats(APPLY), { name: '50skills', company: 'stifel', jobId: '23155', stage: 'application' });
  assert.deepEqual(
    jp.descriptionUrls(APPLY).map((d) => d.url),
    ['https://jobs.50skills.com/stifel/en/23155'],
  );
  const API = 'https://static-jobs-api.50skills.app/public/stifel/jobs/23155.json';
  assert.equal(jp.apiRequests(APPLY)[0].url, API);
  const p = jp.fromApi('50skills', json('api-50skills.json'), APPLY);
  assert.deepEqual(
    [p.title, p.company, p.location, p.jobIds],
    ['Investment Banking - Analyst Intern - Business and Tech-Enabled Services', 'Stifel', 'Paris', ['23155']],
  );
  assert.match(p.description, /Duties & Responsibilities[\s\S]*Requirements/);
  const ctx = { url: APPLY, ats: jp.ats(APPLY), title: '', company: 'Stifel', jobIds: ['23155'], links: [] };
  const found = await jp.find(ctx, { fetch: mockFetch({ [API]: json('api-50skills.json') }) });
  assert.deepEqual([found.verdict, found.source], ['same', API]);
});

test('Sainoo: a French board whose job page needs scripts; its JSON answers, and Lyon is not Paris', async () => {
  const JOB = 'https://www.sainoo.com/jobs/10665';
  assert.deepEqual(jp.ats(JOB), { name: 'sainoo', company: null, jobId: '10665', stage: 'description' });
  const API = 'https://www.sainoo.com/api/v1/jobs/10665';
  assert.equal(jp.apiRequests(JOB)[0].url, API);
  const p = jp.fromApi('sainoo', json('api-sainoo.json'), JOB);
  assert.deepEqual(
    [p.title, p.company, p.location, p.jobIds],
    ['Lyon - Stage Private Equity - Février 2027', 'Ciclad', 'Lyon, France', ['10665']],
  );
  assert.match(p.description, /Mission[\s\S]*Profil recherché/);
  // The job page itself (a script shell) is the application page: the board's data confirms it by ID.
  const ctx = { url: JOB, ats: jp.ats(JOB), title: '', company: '', jobIds: ['10665'], links: [] };
  const found = await jp.find(ctx, { fetch: mockFetch({ [API]: json('api-sainoo.json') }) });
  assert.deepEqual([found.verdict, found.source], ['same', API]);
  // The same internship in Paris (the board's "similar job") is another vacancy.
  const paris = posting({
    url: 'https://www.sainoo.com/jobs/10666',
    title: 'Paris - Stage Private Equity - Mars 2027',
    company: 'Ciclad',
    location: 'Paris, France',
    jobIds: ['10666'],
  });
  assert.equal(
    jp.compare({ ...ctx, title: p.title, company: 'Ciclad', location: 'Lyon, France' }, paris).verdict,
    'different',
  );
});

test('a law firm’s programme page (no job ID, no board) is its own description, as likely', async () => {
  const URL0 = 'https://www.stephensonharwood.example/careers/early-careers/london-training-contracts/';
  const page =
    '<html><head><title>London training contracts | Stephenson Harwood</title></head><body><nav><a href="/">Home</a></nav><main>' +
    '<h1>London training contracts</h1><h2>About the training contract</h2><p>' +
    'Trainees spend two years rotating through four seats across our practice groups, working on real matters for clients from day one. '.repeat(
      3,
    ) +
    '</p><h2>What we look for</h2><p>' +
    'We want curious, commercially minded people with strong academics, clear communication and a genuine interest in a career in law. '.repeat(
      2,
    ) +
    '</p><h2>How to apply</h2><p>Applications for September 2029 open in October and close on 31 December; apply online through our graduate portal.</p></main></body></html>';
  const ctx = jp.applicationContext(parseHTML(page).document, URL0);
  assert.equal(ctx.posting.source, 'page-text');
  const found = await jp.find(ctx, { fetch: mockFetch({}) });
  assert.deepEqual(
    [found.verdict, found.reasons],
    ['likely', ['the description is on this page', 'no job ID or job board to confirm it']],
  );
  // The same text on the firm's home page is not offered.
  const home = jp.applicationContext(parseHTML(page).document, 'https://www.stephensonharwood.example/');
  assert.equal(home.posting, null);
});

test('a reposted job: the page’s canonical address names its new ID, which is the same job, not a clash', async () => {
  const OLD = 'https://jobs.smartrecruiters.com/Wiser/744000146674569-resa-analyst-2027-evercore';
  const NEW = 'https://jobs.smartrecruiters.com/Wiser/744000146681959-resa-analyst-2027-evercore';
  const page =
    `<html><head><title>RESA Analyst (2027) | Evercore</title><link rel="canonical" href="${NEW}"></head><body>` +
    '<main itemscope itemtype="http://schema.org/JobPosting"><h1 itemprop="title">RESA Analyst (2027) | Evercore</h1>' +
    '<span itemprop="jobLocation" itemscope itemtype="http://schema.org/Place"><span itemprop="address" itemscope><span itemprop="addressLocality">London</span></span></span>' +
    '<div itemprop="description"><h2>Job Description</h2><p>' +
    'Join the restructuring and special situations advisory team in London for analyst training and live mandates. '.repeat(
      6,
    ) +
    '</p><h2>Qualifications</h2><p>Strong academic record, financial modelling skills and clear writing.</p></div></main></body></html>';
  const ctx = jp.applicationContext(parseHTML(page).document, OLD);
  assert.deepEqual(ctx.jobIds, ['744000146674569', '744000146681959']);
  assert.equal(jp.compare(ctx, ctx.posting).verdict, 'same');
  const found = await jp.find(ctx, { fetch: mockFetch({}) });
  assert.equal(found.verdict, 'same');
  // The board's own data under the new ID is the same job; a third ID on the board is another one.
  assert.equal(jp.compare(ctx, { ...ctx.posting, url: NEW, jobIds: ['744000146681959'] }).verdict, 'same');
  const other = {
    ...ctx.posting,
    title: 'M&A Analyst (2027)',
    url: NEW.replace('681959', '699999'),
    jobIds: ['744000146699999'],
  };
  assert.equal(jp.compare(ctx, other).verdict, 'different');
});

test('trail: a law firm’s programme page before its graduate portal’s sign-in is likely the job', async () => {
  const now = Date.parse('2026-10-02T10:00:00Z');
  const PROGRAMME = 'https://www.pinsentmasons.com/careers/early-talent/england/vacation-placement';
  const PORTAL = 'https://pinsentmasons.ambertrack.co.uk/graduates2027/CandidateLogin.aspx';
  const ctx = jp.applicationContext(
    parseHTML('<html><head><title></title></head><body></body></html>').document,
    PORTAL,
  );
  assert.equal(ctx.company, 'Pinsentmasons');
  ctx.trail = [{ url: PROGRAMME, title: 'Vacation placements in England | Pinsent Masons', at: now - 2 * 6e4 }];
  const page =
    '<html><head><title>Vacation placements in England | Pinsent Masons</title></head><body><main><h1>Vacation placements</h1>' +
    '<h2>About the scheme</h2><p>' +
    'Spend two weeks with our lawyers in one of our English offices, working on live matters and meeting partners and trainees. '.repeat(
      3,
    ) +
    '</p><h2>What we look for</h2><p>' +
    'Curious, commercially aware students with strong academics who communicate clearly and enjoy solving problems in a team. '.repeat(
      2,
    ) +
    '</p><h2>How to apply</h2><p>Applications open in October and close in January; apply online through our graduate portal.</p></main></body></html>';
  const found = await jp.find(ctx, { now, fetch: mockFetch({ [PROGRAMME]: page }) });
  assert.deepEqual([found.verdict, found.source], ['likely', PROGRAMME]);
  assert.ok(found.reasons.includes('the job page you opened before this one in this tab'));
});
