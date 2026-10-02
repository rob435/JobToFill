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
    ['REQ-40921', 'Quantitative Researcher Intern Summer 2027', 'Fabrikam Capital'],
  );
  assert.ok(qs.every((x) => x.startTime === now - 60 * 864e5));

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
