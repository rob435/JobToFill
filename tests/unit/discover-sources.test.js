'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const JTF = require('./helpers').load();
require('../../extension/lib/jobpage.js');
require('../../extension/lib/discover.js');
const S = require('../../extension/lib/discover-sources.js');

const D = JTF.discover;
const FIX = path.join(__dirname, '..', 'fixtures', 'jobs');
const json = (n) => JSON.parse(fs.readFileSync(path.join(FIX, n), 'utf8'));
const NOW = Date.parse('2026-11-06T12:00:00Z');
const HOUR = 3600e3;

/** A fetch that serves fixed bodies by URL, and records what was asked for (and how). */
function mockFetch(routes, log = []) {
  return async (url, init = {}) => {
    log.push({ url, method: init.method || 'GET', body: init.body, credentials: init.credentials });
    const route = routes[url];
    if (route === undefined) return { ok: false, status: 404, url, text: async () => '404: Not Found' };
    const body = typeof route === 'string' ? route : JSON.stringify(route);
    return { ok: true, status: 200, url, text: async () => body };
  };
}

/* ------------------------------------------------------------ Hacker News */

const BASE = 'https://hn.test/api/v1';
const NOV = '50338728';
const OCT = '49922569';
const THREADS = `${BASE}/search_by_date?tags=story,author_whoishiring&query=%22who%20is%20hiring%22&hitsPerPage=6`;
const comments = (id, page) => `${BASE}/search_by_date?tags=comment,story_${id}&hitsPerPage=1000&page=${page}`;
// Algolia pages at 1,000 hits; the November fixture splits its six over two pages to exercise paging.
const HN = {
  [THREADS]: json('hn-threads.json'),
  [comments(NOV, 0)]: json('hn-comments-november-p0.json'),
  [comments(NOV, 1)]: json('hn-comments-november-p1.json'),
  [comments(OCT, 0)]: json('hn-comments-october.json'),
};
const HN_FILES = ['hn-comments-november-p0.json', 'hn-comments-november-p1.json', 'hn-comments-october.json'];

/** A fixture comment as hnPosts() hands it on. */
function postOf(id) {
  const h = HN_FILES.flatMap((f) => json(f).hits).find((x) => x.objectID === id);
  return {
    id: h.objectID,
    author: h.author,
    createdAt: h.created_at,
    html: h.comment_text,
    url: 'https://news.ycombinator.com/item?id=' + h.objectID,
  };
}

const ids = (boards) => boards.map((b) => `${b.ats}:${b.slug}`);

test('discover sources: the latest two “Who is hiring?” threads, not the other monthly ones', async () => {
  assert.equal(S.HN_API, 'https://hn.algolia.com/api/v1');
  const log = [];
  const threads = await S.hnThreads({ fetch: mockFetch(HN, log), now: NOW, base: BASE });
  assert.deepEqual(
    log.map((l) => l.url),
    [THREADS],
  );
  // "Who wants to be hired?" and "Freelancer? Seeking freelancer?" come from the same account; September is a third.
  assert.deepEqual(threads, [
    {
      id: NOV,
      title: 'Ask HN: Who is hiring? (November 2026)',
      month: 'November 2026',
      createdAt: '2026-11-02T16:01:37Z',
    },
    {
      id: OCT,
      title: 'Ask HN: Who is hiring? (October 2026)',
      month: 'October 2026',
      createdAt: '2026-10-01T15:02:07Z',
    },
  ]);
  // Months later, none of them is this month's or last month's.
  assert.deepEqual(
    await S.hnThreads({ fetch: mockFetch(HN), now: Date.parse('2027-02-20T00:00:00Z'), base: BASE }),
    [],
  );
  // The API down: no threads, no error.
  assert.deepEqual(await S.hnThreads({ fetch: mockFetch({}), now: NOW, base: BASE }), []);
});

test('discover sources: a thread’s top-level comments, page by page, without the replies', async () => {
  const log = [];
  const posts = await S.hnPosts({ id: NOV, month: 'November 2026' }, { fetch: mockFetch(HN, log), base: BASE });
  assert.deepEqual(
    log.map((l) => l.url),
    [comments(NOV, 0), comments(NOV, 1)],
  );
  // 50340533 asks Tidewell a question: a reply, not a post.
  assert.deepEqual(
    posts.map((p) => p.id),
    ['50355871', '50352210', '50343988', '50341502', '50340117'],
  );
  const tidewell = posts[4];
  assert.equal(tidewell.author, 'tidewell_ana');
  assert.equal(tidewell.createdAt, '2026-11-02T18:12:40Z');
  assert.equal(tidewell.url, 'https://news.ycombinator.com/item?id=50340117');
  assert.equal(tidewell.thread, NOV);
  assert.equal(tidewell.month, 'November 2026');
  assert.match(tidewell.html, /^Tidewell \(YC S24\) \| London, UK/);
  // A parent id given as a string still counts.
  const p1 = json('hn-comments-november-p1.json');
  for (const h of p1.hits) h.parent_id = String(h.parent_id);
  const again = await S.hnPosts({ id: NOV }, { fetch: mockFetch({ ...HN, [comments(NOV, 1)]: p1 }), base: BASE });
  assert.equal(again.length, 5);
});

test('discover sources: past Algolia’s 1,000 hits, older comments by date', async () => {
  const hit = (i, t) => ({
    objectID: String(60000000 + i),
    parent_id: 1,
    story_id: 1,
    author: 'a',
    comment_text: 'Acme | London | INTERNS',
    created_at: new Date(t * 1000).toISOString(),
    created_at_i: t,
  });
  const top = 1793700000;
  const first = Array.from({ length: 1000 }, (_, i) => hit(i, top - i));
  const oldest = top - 999;
  // Asking for those at or before the oldest repeats it once.
  const rest = [hit(999, oldest), ...Array.from({ length: 200 }, (_, i) => hit(1000 + i, oldest - 1 - i))];
  const log = [];
  const routes = {
    [comments(1, 0)]: { hits: first, nbHits: 1200, nbPages: 1, page: 0, hitsPerPage: 1000 },
    [`${comments(1, 0)}&numericFilters=created_at_i%3C%3D${oldest}`]: { hits: rest, nbHits: 201, nbPages: 1, page: 0 },
  };
  const posts = await S.hnPosts({ id: '1' }, { fetch: mockFetch(routes, log), base: BASE });
  assert.equal(log.length, 2);
  assert.equal(posts.length, 1200);
  assert.equal(new Set(posts.map((p) => p.id)).size, 1200);
});

test('discover sources: a “Who is hiring?” post, read', () => {
  const p = S.parsePost(postOf('50340117'));
  assert.equal(p.company, 'Tidewell');
  assert.equal(p.yc, 'S24');
  assert.equal(
    p.header,
    'Tidewell (YC S24) | London, UK | Software Engineer, ML Engineer | ONSITE (Hybrid ok) | Full-time + INTERNS | https://www.linkedin.com/company/tidewell',
  );
  assert.equal(p.segments.length, 6);
  assert.deepEqual(p.roles, [
    { title: 'Software Engineer', kind: null },
    { title: 'ML Engineer', kind: null },
    { title: 'INTERNS', kind: 'internship' },
  ]);
  assert.equal(p.student, true);
  assert.deepEqual(p.kinds, ['internship']);
  assert.deepEqual(p.locations, ['London, UK']);
  assert.equal(p.onsite, true);
  assert.equal(p.remote, false);
  // HN escapes what people type, and "[at]" keeps an address from scrapers.
  assert.deepEqual(p.emails, ['hiring@tidewell.co.uk', 'ana.kowalski@tidewell.co.uk']);
  // LinkedIn and its Lever board come first; its own site is the one on its name.
  assert.deepEqual(p.urls.slice(0, 2), ['https://www.linkedin.com/company/tidewell', 'https://jobs.lever.co/tidewell']);
  assert.equal(p.site, 'https://www.tidewell.co.uk');
  assert.equal(p.domain, 'tidewell.co.uk');
  assert.deepEqual(ids(p.boards), ['lever:tidewell']);
  assert.match(p.text, /^Tidewell forecasts tidal and offshore wind output/);
  assert.match(p.text, /We're hiring two engineers/);
  assert.ok(!/&#x27;|&quot;|&#x2F;|<p>/.test(p.text));
  assert.ok(p.text.length <= 600);
  assert.equal(p.hnUrl, 'https://news.ycombinator.com/item?id=50340117');
  assert.equal(p.postedAt, '2026-11-02T18:12:40Z');
});

test('discover sources: posts that turn students away, and other ways of writing one', () => {
  const no = S.parsePost(postOf('50341502'));
  assert.equal(no.company, 'Northgate Labs');
  assert.equal(no.student, false, '“No interns or new grads this cycle, sorry”');
  assert.deepEqual(no.kinds, []);
  assert.equal(no.remote, true);
  assert.deepEqual(no.locations, ['US']);
  // A Greenhouse board is all it links to: no site of its own.
  assert.equal(no.site, '');
  assert.deepEqual(ids(no.boards), ['greenhouse:northgatelabs']);

  // " - " between the parts, and no links: the site comes from the email.
  const quill = S.parsePost(postOf('50343988'));
  assert.equal(quill.company, 'Quillfeather');
  assert.deepEqual(quill.roles, [{ title: 'Working Student (Backend, 20h/week)', kind: 'internship' }]);
  assert.deepEqual(quill.locations, ['Berlin, Germany']);
  assert.deepEqual([quill.onsite, quill.remote], [true, false]);
  assert.deepEqual(quill.emails, ['jobs@quillfeather.de']);
  assert.equal(quill.site, 'https://quillfeather.de');

  const lumen = S.parsePost(postOf('50352210'));
  assert.deepEqual(lumen.emails, ['careers@lumengrid.com'], '“careers at lumengrid dot com”');
  assert.deepEqual(lumen.kinds, ['graduate']);
  assert.deepEqual(lumen.locations, ['NYC']);

  const inline = (html) => S.parsePost({ id: '1', html, createdAt: '2026-11-03T00:00:00Z' });
  const kestrel = inline(
    'Kestrel Robotics (YC W25) | Pittsburgh, PA | Robotics Software Intern | ONSITE<p>No internship experience needed. Our engineers at kestrel.dev wrote the stack.<p>Email jobs (at) kestrel.dev',
  );
  assert.deepEqual([kestrel.company, kestrel.yc, kestrel.student], ['Kestrel Robotics', 'W25', true]);
  assert.deepEqual(kestrel.emails, ['jobs@kestrel.dev'], '“engineers at kestrel.dev” is a sentence');
  assert.deepEqual(kestrel.locations, ['Pittsburgh, PA']);
  assert.equal(kestrel.site, 'https://kestrel.dev');
  // "Not hiring juniors" outweighs a junior in the header.
  assert.equal(inline('Acme | Junior Developer | REMOTE<p>Sorry, not hiring juniors after all.').student, false);
  // Someone looking for work in the wrong thread names no company.
  assert.equal(inline('Location: Dorset, UK<p>Remote: Yes').company, '');
});

test('discover sources: a post as a Discover firm', () => {
  const post = { ...S.parsePost(postOf('50340117')), month: 'November 2026' };
  const firm = S.hnFirm(post);
  assert.equal(firm.id, 'hn:tidewell.co.uk');
  assert.equal(firm.name, 'Tidewell');
  assert.equal(firm.site, 'https://www.tidewell.co.uk');
  assert.equal(firm.domain, 'tidewell.co.uk');
  assert.deepEqual(firm.cities, ['London']);
  assert.equal(firm.country, 'GB');
  assert.deepEqual([firm.source, firm.yc, firm.remote, firm.tags], ['hn', 'S24', false, ['tech']]);
  assert.deepEqual([firm.employees, firm.aum, firm.crd, firm.wiki, firm.qid], [null, null, null, null, null]);
  assert.deepEqual(firm.hn, {
    url: 'https://news.ycombinator.com/item?id=50340117',
    month: 'November 2026',
    roles: post.roles,
    emails: ['hiring@tidewell.co.uk', 'ana.kowalski@tidewell.co.uk'],
    kinds: ['internship'],
    postedAt: '2026-11-02T18:12:40Z',
  });
  assert.deepEqual(ids(firm.boards), ['lever:tidewell']);
  assert.deepEqual(firm.pages, ['https://www.tidewell.co.uk/careers/internships']);
  assert.ok(firm.about.length <= 160 && /^Tidewell forecasts/.test(firm.about));
  // It searches like a registry firm.
  assert.deepEqual(
    D.search([firm], { place: 'london' }).map((h) => h.firm.id),
    ['hn:tidewell.co.uk'],
  );
  // No site: the id comes from the name.
  const northgate = S.hnFirm(S.parsePost(postOf('50341502')));
  assert.deepEqual([northgate.id, northgate.country, northgate.pages], ['hn:northgate-labs', 'US', []]);
  const lumen = S.hnFirm(S.parsePost(postOf('50352210')));
  assert.deepEqual([lumen.cities, lumen.country], [['New York'], 'US']);
});

test('discover sources: a post’s site is one on its name, in its header or in its address, never just a link', async () => {
  const inline = (html) => S.parsePost({ id: '1', html, createdAt: '2026-11-03T00:00:00Z' });
  const nyt = '<a href="https:&#x2F;&#x2F;www.nytimes.com&#x2F;2026&#x2F;05&#x2F;tech">NYT</a>';
  const zephyr = inline(
    `Zephyr Labs | SWE Intern | New York | Onsite<p>We were featured in the ${nyt} last year.<p>Apply: https:&#x2F;&#x2F;jobs.ashbyhq.com&#x2F;zephyr`,
  );
  assert.deepEqual([zephyr.site, zephyr.domain], ['', ''], 'the NYT isn’t Zephyr’s site');
  assert.deepEqual(ids(zephyr.boards), ['ashby:zephyr']);
  const firm = S.hnFirm(zephyr);
  assert.deepEqual([firm.id, firm.site, firm.domain, firm.pages], ['hn:zephyr-labs', '', '', []]);
  // A link on its name, wherever it is; a link in the header; its address's domain (not a webmail one).
  const site = (html) => inline(html).site;
  assert.equal(
    site(
      `Zephyr Labs | Intern | NYC<p>${nyt}. More: <a href="https:&#x2F;&#x2F;zephyrlabs.ai&#x2F;about">about us</a>`,
    ),
    'https://zephyrlabs.ai',
  );
  assert.equal(
    site(`Zephyr Labs | Intern | NYC | <a href="https:&#x2F;&#x2F;zl.dev">zl.dev</a><p>${nyt}`),
    'https://zl.dev',
  );
  assert.equal(site(`Zephyr Labs | Intern | NYC<p>${nyt}<p>Email hello@zl-hq.com`), 'https://zl-hq.com');
  assert.equal(site(`Zephyr Labs | Intern | NYC<p>${nyt}<p>Email zephyr.labs@gmail.com`), '');
  // Part of a word, or a word every other company has, isn't the name.
  const gate = '<a href="https:&#x2F;&#x2F;gate.io">gate.io</a>';
  assert.equal(site(`Northgate Labs | Intern | NYC<p>We settle trades on ${gate}`), '');
  assert.equal(
    site('Zephyr Labs | Intern | NYC<p>Built on <a href="https:&#x2F;&#x2F;labs.google">Google Labs</a>'),
    '',
  );
  assert.equal(
    site(`Kestrel Robotics | Intern | Pittsburgh, PA<p><a href="https:&#x2F;&#x2F;kestrel.dev">us</a>`),
    'https://kestrel.dev',
  );

  // Two companies that link the same outside site stay two.
  const thread = { objectID: '7', title: 'Ask HN: Who is hiring? (November 2026)', created_at: '2026-11-02T16:00:00Z' };
  const hit = (id, html) => ({
    objectID: id,
    parent_id: 7,
    author: 'a',
    comment_text: html,
    created_at: '2026-11-03T00:00:00Z',
  });
  const routes = {
    [THREADS]: { hits: [thread] },
    [comments('7', 0)]: {
      hits: [
        hit('71', `Zephyr Labs | SWE Intern | NYC<p>Featured in the ${nyt}.`),
        hit('72', `Orchid AI | ML Intern | NYC<p>Also in the ${nyt}.`),
      ],
      nbPages: 1,
    },
  };
  const res = await S.hnHiring({ fetch: mockFetch(routes), now: NOW, base: BASE });
  assert.deepEqual(res.posts.map((p) => S.hnFirm(p).id).sort(), ['hn:orchid-ai', 'hn:zephyr-labs']);
});

test('discover sources: addresses, not sentences that say where someone works', () => {
  const emails = (body, head = 'Foo Labs | Intern | London') =>
    S.parsePost({ id: '1', html: `${head}<p>${body}` }).emails;
  // Jobs before " at ", and domains that aren't the company's.
  assert.deepEqual(emails('Our CEO was previously CTO at stripe.com.'), []);
  assert.deepEqual(emails('Say hi to our founder at acme.io'), []);
  assert.deepEqual(emails('Ask the team lead at quux.de'), []);
  assert.deepEqual(emails('Email sam at stripe.com'), [], 'not Foo Labs’s domain');
  // The company's own domain, at the end of a sentence too.
  assert.deepEqual(emails('Write to sam at foolabs.com.'), ['sam@foolabs.com']);
  assert.equal(
    S.parsePost({ id: '1', html: 'Foo Labs | Intern | London<p>Write to sam at foolabs.com.' }).site,
    'https://foolabs.com',
  );
  assert.deepEqual(emails('I’m the founder at foolabs.com.'), [], 'a job, even on its own domain');
  // Or the domain of its site, whatever it is called.
  const quux = 'Foo Labs | Intern | Berlin | <a href="https:&#x2F;&#x2F;quux.de">quux.de</a>';
  assert.deepEqual(emails('Email anna at quux.de, or call.', quux), ['anna@quux.de']);
  assert.deepEqual(emails('Our team lead at quux.de will reply.', quux), []);
  // Spelt out, bracketed or spaced: an address wherever it is.
  assert.deepEqual(emails('Write to ana at otherco dot io.'), ['ana@otherco.io']);
  assert.deepEqual(emails('Write to jobs [at] otherco.io, or jobs @ foolabs.com.'), [
    'jobs@otherco.io',
    'jobs@foolabs.com',
  ]);
  assert.deepEqual(emails('Find us @ foolabs.com'), []);
});

test('discover sources: a post’s country, wherever it is', () => {
  const country = (...locations) => S.hnFirm({ company: 'Acme', locations }).country;
  const cases = {
    'London, UK': 'GB',
    'NY, SF, London': 'US',
    'Tempe, AZ': 'US',
    'Dublin, Ireland': 'IE',
    'Dublin, CA': 'US',
    Toronto: 'CA',
    'Toronto, CA': 'CA',
    'London, ON': 'CA',
    'Waterloo, Canada': 'CA',
    'Paris, France': 'FR',
    'Paris, TX': 'US',
    Berlin: 'DE',
    'MUNICH, GERMANY': 'DE',
    'Berlin, Freiburg, NYC': 'DE',
    Amsterdam: 'NL',
    'Tel Aviv': 'IL',
    'Zürich, Switzerland': 'CH',
    Geneva: 'CH',
    Singapore: 'SG',
    'Hong Kong': 'HK',
    'Sydney, Australia': 'AU',
    Melbourne: 'AU',
    'Madrid, Spain': 'ES',
    Milan: 'IT',
    Stockholm: 'SE',
    Copenhagen: 'DK',
    Oslo: 'NO',
    Helsinki: 'FI',
    Brussels: 'BE',
    Vienna: 'AT',
    Lisbon: 'PT',
    Warsaw: 'PL',
    Prague: 'CZ',
    'Bangalore, IN': 'IN',
    'Chicago, IL': 'US',
    Tokyo: 'JP',
    'São Paulo, Brazil': 'BR',
    'Mexico City': 'MX',
    'Belfast, Northern Ireland': 'GB',
    'Sydney, New South Wales': 'AU',
    'Boston, New England': 'US',
    'Europe, Norrköping or Stockholm': 'SE',
    Cambridge: '',
    Europe: '',
  };
  for (const [loc, code] of Object.entries(cases)) assert.equal(country(loc), code, loc);
  assert.equal(country('Remote', 'Berlin, Germany'), 'DE', 'the first place that names one');
  // Firms from posts now come up for the places beyond the US and the UK.
  const firm = (...locations) => S.hnFirm({ company: 'Acme', locations });
  const at = (f, place) => D.search([f], { place }).length === 1;
  assert.ok(at(firm('Dublin, Ireland'), 'dublin'));
  assert.ok(at(firm('Toronto, ON'), 'toronto'));
  assert.ok(at(firm('Paris'), 'paris'));
  assert.ok(at(firm('Munich'), 'germany'));
  assert.ok(at(firm('Zürich'), 'ch'));
  assert.ok(at(firm('Amsterdam'), 'europe'));
  assert.ok(!at(firm('Dublin, CA'), 'dublin'));
});

test('discover sources: student posts from both threads, one per company, cached for 12 hours', async () => {
  const log = [];
  const res = await S.hnHiring({ fetch: mockFetch(HN, log), now: NOW, base: BASE });
  // Fernhill and Northgate aren't hiring students; Tidewell posted both months and November's is kept.
  assert.deepEqual(
    res.posts.map((p) => [p.company, p.month]),
    [
      ['Lumen Grid', 'November 2026'],
      ['Quillfeather', 'November 2026'],
      ['Tidewell', 'November 2026'],
      ['Orbit Analytics', 'October 2026'],
    ],
  );
  assert.deepEqual(res.threads, [
    { id: NOV, title: 'Ask HN: Who is hiring? (November 2026)', month: 'November 2026', at: NOW },
    { id: OCT, title: 'Ask HN: Who is hiring? (October 2026)', month: 'October 2026', at: NOW },
  ]);
  assert.deepEqual([res.at, res.answered, res.asked], [NOW, 4, 4]);
  // Public and key-free: plain GETs, no cookies, nothing in a body.
  assert.ok(log.every((l) => l.method === 'GET' && l.body === undefined && l.credentials === 'omit'));

  // An hour later both threads come from the cache: only the list of threads is asked for.
  const soon = [];
  const res2 = await S.hnHiring({ fetch: mockFetch(HN, soon), now: NOW + HOUR, base: BASE, cache: res });
  assert.deepEqual(
    soon.map((l) => l.url),
    [THREADS],
  );
  assert.deepEqual(
    res2.posts.map((p) => p.company),
    res.posts.map((p) => p.company),
  );
  assert.equal(res2.threads[0].at, NOW, 'when it was read, not now');
  // Thirteen hours after they were read, they are read again.
  const later = [];
  await S.hnHiring({ fetch: mockFetch(HN, later), now: NOW + 13 * HOUR, base: BASE, cache: res2 });
  assert.equal(later.length, 4);
  // Offline: the cache still stands while it is fresh, and without one there is nothing (and no error).
  const offline = await S.hnHiring({ fetch: mockFetch({}), now: NOW + 2 * HOUR, base: BASE, cache: res });
  assert.equal(offline.posts.length, 4);
  assert.deepEqual([offline.answered, offline.asked], [0, 1]);
  const none = await S.hnHiring({ fetch: mockFetch({}), now: NOW, base: BASE });
  assert.deepEqual([none.posts, none.threads, none.answered], [[], [], 0]);
});

/* -------------------------------------------------------------- Simplify */

const SIMPLIFY = (current, grad) => ({
  [current]: json('simplify-internships.json'),
  [grad]: json('simplify-new-grad.json'),
});

test('discover sources: Simplify’s listings, next summer’s repository first', async () => {
  assert.deepEqual(S.SIMPLIFY_REPOS, {
    intern: 'SimplifyJobs/Summer{YEAR}-Internships',
    grad: 'SimplifyJobs/New-Grad-Positions',
  });
  const urls = S.simplifyUrls(NOW);
  assert.deepEqual(urls, [
    'https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json',
    'https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/.github/scripts/listings.json',
    'https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json',
  ]);
  const [next, current, grad] = urls;
  const log = [];
  // Summer2027 isn't there (404): Summer2026 is used.
  const res = await S.simplifyListings({ fetch: mockFetch(SIMPLIFY(current, grad), log), now: NOW });
  assert.deepEqual(log.map((l) => l.url).sort(), [next, current, grad].sort());
  assert.deepEqual([res.at, res.answered, res.asked], [NOW, 2, 3]);
  assert.ok(res.names.includes('hudson river trading') && res.names.includes('hudson river'));
  for (const n of ['CACI', 'Ramp', 'TikTok', 'Charles Schwab']) assert.ok(res.names.includes(D.normName(n)), n);
  // A closed listing still says Simplify lists the company; a hidden one doesn't.
  assert.ok(res.names.includes('old mill robotics') && res.names.includes('jane street'));
  assert.ok(res.names.includes('citadel securities') && res.names.includes('citadel'));
  assert.ok(!res.names.some((n) => /hidden/.test(n)));
  // Only companies' own domains: not Simplify's pages, nor Workday's, Greenhouse's, Ashby's or iCIMS's.
  assert.deepEqual(res.domains.sort(), [
    'citadelsecurities.com',
    'hudsonrivertrading.com',
    'janestreet.com',
    'lifeattiktok.com',
  ]);
  // Open roles, newest first.
  assert.deepEqual(
    res.roles.map((r) => [r.company, r.kind, r.posted]),
    [
      ['Hudson River Trading', 'internship', '2026-11-02'],
      ['CACI', 'internship', '2026-11-02'],
      ['Charles Schwab', 'graduate', '2026-11-02'],
      ['Ramp', 'internship', '2026-11-01'],
      ['TikTok', 'internship', '2026-10-31'],
      ['Citadel Securities', 'graduate', '2026-10-30'],
    ],
  );
  assert.deepEqual(res.roles[0], {
    company: 'Hudson River Trading',
    title: 'Software Engineering Intern – Summer 2027',
    url: 'https://www.hudsonrivertrading.com/hrt-job/software-engineering-intern-summer-2027/',
    locations: ['New York, NY'],
    posted: '2026-11-02',
    kind: 'internship',
    sponsorship: 'Other',
    active: true,
    terms: ['Summer 2027'],
  });
  // Nothing answers: empty lists, no error.
  const none = await S.simplifyListings({ fetch: mockFetch({}), now: NOW });
  assert.deepEqual([none.names, none.domains, none.roles, none.answered, none.asked], [[], [], [], 0, 3]);
});

test('discover sources: Trackr’s and Simplify’s lists as one, for leaving companies out', async () => {
  const [, current, grad] = S.simplifyUrls(NOW);
  const simplify = await S.simplifyListings({ fetch: mockFetch(SIMPLIFY(current, grad)), now: NOW });
  const trackr = { names: ['man group', 'man', 'citadel'], domains: ['man.com'], at: NOW - HOUR, answered: 64 };
  const listed = S.listedSet(trackr, null, simplify, undefined);
  assert.deepEqual(Object.keys(listed).sort(), ['at', 'domains', 'names']);
  assert.equal(listed.at, NOW);
  assert.equal(new Set(listed.names).size, listed.names.length, 'no repeats');
  assert.ok(listed.names.includes('man group') && listed.names.includes('hudson river trading'));
  assert.ok(listed.domains.includes('man.com') && listed.domains.includes('lifeattiktok.com'));
  assert.equal(D.onList(listed, D.firmFrom({ n: 'Hudson River Trading LLC' })), true, 'by name');
  assert.equal(D.onList(listed, D.firmFrom({ n: 'HRT', d: 'www.hudsonrivertrading.com' })), true, 'by domain');
  assert.equal(D.onList(listed, D.firmFrom({ n: 'Man Group plc' })), true, 'Trackr’s');
  assert.equal(D.onList(listed, S.hnFirm(S.parsePost(postOf('50340117')))), false, 'Tidewell is on neither');
  assert.deepEqual(S.listedSet(), { names: [], domains: [], at: null });
});
