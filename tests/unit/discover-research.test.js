'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers');

load();
require('../../extension/lib/jobpage.js');
require('../../extension/lib/letter.js');
require('../../extension/lib/discover.js');
require('../../extension/lib/discover-contacts.js');
const R = require('../../extension/lib/discover-research.js');
const F = require('../../extension/lib/discover-finder.js');
const ai = require('../../extension/lib/ai.js');

const PAD = `<p>${'HBK is a global investment firm with offices in Dallas, New York and London. '.repeat(8)}</p>`;

/** A fetch that serves fixed bodies by URL, and records what was asked for. */
function mockFetch(routes, log = []) {
  return async (url, init = {}) => {
    log.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body });
    const route = routes[url];
    if (route === undefined) return { ok: false, status: 404, url, text: async () => 'Not found' };
    if (typeof route === 'function') return route(url, init);
    return { ok: true, status: 200, url, text: async () => route };
  };
}

test('research: formats as directories and pages write them', () => {
  const f = (text, domain) => R.formatsIn(text, domain).map((x) => x.pattern);
  assert.deepEqual(
    f('The most common HBK email format is [first].[last] (ex. jane.doe@hbk.com), used by 85%.', 'hbk.com'),
    ['first.last'],
  );
  assert.deepEqual(f('The most used email format for hbk.com is {first}.{last}@hbk.com', 'hbk.com'), ['first.last']);
  assert.deepEqual(f('Email format: first initial + last name (e.g. JSmith@acme.co.uk)', 'acme.co.uk'), ['flast']);
  assert.deepEqual(f('{f}{last}@acme.com is the format', 'acme.com'), ['flast']);
  assert.deepEqual(f('Man Group uses jdoe@man.com and firstname.lastname@man.com', 'man.com'), ['flast', 'first.last']);
  // Mailboxes say nothing about people's addresses, and another domain's format isn't this one's.
  assert.deepEqual(f('Write to careers@hbk.com or info@hbk.com.', 'hbk.com'), []);
  assert.deepEqual(f('Send CVs to first.last@acme.com.au', 'acme.com'), []);
  assert.deepEqual(
    ['{f}{last}', 'first initial last name', '[first]_[last]', 'firstname.lastname', 'f.last', 'jdoe', 'info'].map(
      R.shapeOf,
    ),
    ['flast', 'flast', 'first_last', 'first.last', 'f.last', '', ''],
  );
});

test('research: a person stays only when a source names them with the firm, their title only when it gives it', () => {
  const firm = { name: 'HBK Capital Management', domain: 'hbk.com' };
  const ev = R.evidenceOf([
    {
      url: 'https://uk.linkedin.com/in/janesmith',
      title: 'Jane Smith - Head of Campus Recruiting - HBK Capital Management | LinkedIn',
      kind: 'result',
    },
    {
      url: 'https://www.hbk.com/leadership',
      title: 'Leadership',
      text: 'David Haley, President. Jon Mark, COO.',
      kind: 'page',
    },
    {
      url: 'https://news.example.com/a',
      title: 'Markets wrap',
      text: `Bob Jones of Citadel said markets were calm. ${'Other news. '.repeat(60)} HBK posted gains.`,
      kind: 'cited',
    },
    {
      url: 'https://uk.linkedin.com/in/amy',
      title: 'Amy Lee - Software Engineer - Jane Street | LinkedIn',
      kind: 'result',
    },
  ]);
  const jane = R.confirmPerson({ name: 'Jane Smith', title: 'Head of Campus Recruiting' }, ev, firm);
  assert.equal(jane.title, 'Head of Campus Recruiting');
  assert.equal(jane.url, 'https://uk.linkedin.com/in/janesmith');
  assert.equal(R.confirmPerson({ name: 'David Haley', title: 'President' }, ev, firm).title, 'President');
  // On the firm's own page, but the model's title isn't there: the name stays, the title goes.
  const jon = R.confirmPerson({ name: 'Jon Mark', title: 'Head of Technology' }, ev, firm);
  assert.deepEqual([jon.name, jon.title], ['Jon Mark', '']);
  // Named far from the firm in a long page, or at another firm, or nowhere: dropped.
  assert.ok(R.confirmPerson({ name: 'Bob Jones', title: 'Analyst' }, ev, firm).why);
  assert.ok(R.confirmPerson({ name: 'Amy Lee', title: 'Software Engineer' }, ev, firm).why);
  assert.ok(R.confirmPerson({ name: 'Made Up', title: 'CEO' }, ev, firm).why);
  assert.ok(R.confirmPerson({ name: 'Customer Success', title: 'Team' }, ev, firm).why, 'not a name');
});

test('research: the prompt carries the firm and what its site showed, never the person', () => {
  const text = R.brief(
    { name: 'GLG Partners', site: 'https://www.glgpartners.com', cities: ['London'], employees: 144 },
    { status: 'unreachable', pages: [] },
    { status: 'unreachable', log: [{ url: 'https://www.glgpartners.com/', outcome: 'failed: ENOTFOUND' }] },
  );
  assert.match(text, /FIRM: GLG Partners/);
  assert.match(text, /didn’t load/);
  assert.doesNotMatch(R.SYSTEM + text, /\bCV\b|CANDIDATE|your profile/);
});

test('research: keeps only what the search returned, reads a page the model points to, and finds the format', async () => {
  const firm = { name: 'GLG Partners', domain: 'glgpartners.com', site: 'https://www.glgpartners.com' };
  const reply = {
    website: 'https://www.man.com',
    website_note: 'GLG Partners is now part of Man Group',
    careers: [
      { url: 'https://www.man.com/careers', title: 'Careers' },
      { url: 'https://jobs.example.org/x', title: 'Elsewhere' },
    ],
    programmes: [
      {
        name: 'Summer Internship',
        url: 'https://www.man.com/careers',
        quote: 'Our 10-week summer internship runs in London',
      },
      { name: 'Made up week', url: 'https://www.man.com/careers', quote: 'A week the page never mentions at all' },
    ],
    people: [
      { name: 'Jane Smith', title: 'Head of Early Careers', group: 'recruiting', url: 'https://uk.linkedin.com/in/js' },
      { name: 'Tom Brown', title: 'CTO', group: 'technology', url: 'https://www.man.com/team' },
      { name: 'Invented Person', title: 'CEO', url: 'https://www.man.com/team' },
    ],
    emails: [
      { address: 'graduates@man.com', url: 'https://www.man.com/careers' },
      { address: 'secret@man.com', url: 'https://www.man.com/careers' },
    ],
    format: { pattern: 'first.last', url: 'https://rocketreach.co/man-group-email-format' },
  };
  const sources = [
    {
      url: 'https://uk.linkedin.com/in/js',
      title: 'Jane Smith – Head of Early Careers – Man Group | LinkedIn',
      text: '',
      kind: 'result',
    },
    {
      url: 'https://www.man.com/careers',
      title: 'Careers | Man Group',
      text: 'Our 10-week summer internship runs in London. Questions: graduates@man.com',
      kind: 'cited',
    },
    {
      url: 'https://rocketreach.co/man-group-email-format',
      title: 'Man Group Email Format',
      text: 'The most common Man Group email format is [first].[last] (ex. jane.doe@man.com)',
      kind: 'cited',
    },
  ];
  const calls = [];
  const search = async (messages, options) => {
    calls.push({ messages, options });
    return { json: reply, sources, searches: 4, usage: { prompt_tokens: 1000, completion_tokens: 200, cost: 0.05 } };
  };
  const log = [];
  const fetchFn = mockFetch(
    {
      'https://www.man.com': `<html><title>Man Group</title><body>${PAD} Man Group plc, including Man GLG. ${PAD}</body></html>`,
      'https://www.man.com/team': `<html><body><h2>Tom Brown</h2><p>CTO, Man Group</p>${PAD}</body></html>`,
    },
    log,
  );
  const r = await R.research(search, { firm, found: { status: 'unreachable' }, contacts: {}, fetch: fetchFn, now: 5 });
  assert.equal(calls[0].options.maxSearches, 6);
  assert.deepEqual(r.website, {
    url: 'https://www.man.com',
    note: 'GLG Partners is now part of Man Group',
    confirmed: true,
  });
  assert.deepEqual(
    r.people.map((p) => [p.name, p.title, p.group]),
    [
      ['Jane Smith', 'Head of Early Careers', 'recruiting'],
      ['Tom Brown', 'CTO', 'technology'],
    ],
  );
  assert.ok(
    log.some((l) => l.url === 'https://www.man.com/team'),
    'the team page the model named is read here',
  );
  assert.ok(!log.some((l) => /linkedin/.test(l.url)), 'LinkedIn is never fetched');
  assert.deepEqual(
    r.emails.map((e) => e.address),
    ['graduates@man.com'],
  );
  assert.ok(r.dropped.some((d) => d.what === 'secret@man.com'));
  assert.ok(r.dropped.some((d) => /Invented Person/.test(d.what)));
  assert.deepEqual(
    r.formats.map((f) => [f.pattern, f.domain, f.source]),
    [['first.last', 'man.com', 'stated']],
  );
  assert.deepEqual(
    r.careers.map((c) => c.url),
    ['https://www.man.com/careers'],
  );
  assert.deepEqual(
    r.programmes.map((p) => p.name),
    ['Summer Internship'],
  );
  assert.equal(r.searches, 4);
});

test('research: a website that doesn’t name the firm, and a format no source states, are dropped', async () => {
  const firm = { name: 'Quiet Capital', domain: 'quietcap.com', site: 'https://quietcap.com' };
  const search = async () => ({
    json: { website: 'https://other.example', people: [], format: { pattern: 'first.last' } },
    sources: [],
    searches: 1,
  });
  const fetchFn = mockFetch({ 'https://other.example': `<html><title>Other</title>${PAD}</html>` });
  const r = await R.research(search, { firm, fetch: fetchFn });
  assert.equal(r.website.confirmed, false);
  assert.deepEqual(r.formats, []);
  assert.ok(r.dropped.some((d) => /format/.test(d.what)));
});

test('ai.search: Claude’s web search with its results kept as sources, resumed after a pause', async () => {
  const bodies = [];
  const replies = [
    {
      stop_reason: 'pause_turn',
      model: 'claude-sonnet-5-5',
      content: [
        { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'HBK careers' } },
        {
          type: 'web_search_tool_result',
          tool_use_id: 's1',
          content: [
            {
              type: 'web_search_result',
              url: 'https://www.hbk.com/careers',
              title: 'Careers | HBK',
              encrypted_content: 'x',
            },
          ],
        },
      ],
      usage: { input_tokens: 100, output_tokens: 10, server_tool_use: { web_search_requests: 1 } },
    },
    {
      stop_reason: 'end_turn',
      content: [
        {
          type: 'text',
          text: '{"people": []}',
          citations: [
            {
              type: 'web_search_result_location',
              url: 'https://www.hbk.com/careers',
              title: 'Careers | HBK',
              cited_text: 'The HBK Summer Intern Experience',
            },
          ],
        },
      ],
      usage: { input_tokens: 200, output_tokens: 20, server_tool_use: { web_search_requests: 1 } },
    },
  ];
  const fetchFn = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    const data = replies.shift();
    return { ok: true, status: 200, text: async () => JSON.stringify(data), headers: { get: () => null } };
  };
  const config = { provider: 'anthropic', apiKey: 'sk-ant-x', model: 'claude-sonnet-5-5' };
  const r = await ai.search(config, { messages: [{ role: 'user', content: 'Research HBK' }], fetch: fetchFn });
  assert.deepEqual(r.json, { people: [] });
  assert.equal(r.searches, 2);
  assert.deepEqual(
    r.sources.map((s) => [s.kind, s.url, s.text]),
    [
      ['result', 'https://www.hbk.com/careers', ''],
      ['cited', 'https://www.hbk.com/careers', 'The HBK Summer Intern Experience'],
    ],
  );
  assert.equal(bodies[0].tools[0].type, 'web_search_20260209');
  assert.equal(bodies[0].tools[1].type, 'web_fetch_20260209');
  // The paused turn goes back as it was.
  assert.equal(bodies[1].messages.length, 2);
  assert.equal(bodies[1].messages[1].role, 'assistant');
  assert.ok(r.usage.cost > 0.02, 'two searches at a cent each, plus tokens');
  // Older models take the older tools; a provider that can't search says so.
  assert.equal(ai.canSearch({ provider: 'deepseek', apiKey: 'x' }), false);
  await assert.rejects(
    ai.search({ provider: 'deepseek', apiKey: 'x' }, { messages: [], fetch: fetchFn }),
    (e) => e.code === 'nosearch',
  );
});

test('ai.search: OpenRouter’s web plugin, its citations kept as sources', async () => {
  let body;
  const fetchFn = async (url, init) => {
    body = JSON.parse(init.body);
    const data = {
      model: 'deepseek/deepseek-v4.1-flash',
      choices: [
        {
          message: {
            content: '{"people": []}',
            annotations: [
              {
                type: 'url_citation',
                url_citation: { url: 'https://a.example', title: 'A', content: 'Jane Smith, HBK' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 5, cost: 0.03 },
    };
    return { ok: true, status: 200, text: async () => JSON.stringify(data), headers: { get: () => null } };
  };
  const r = await ai.search(
    { provider: 'openrouter', apiKey: 'sk-or-x', model: 'deepseek/deepseek-v4.1-flash' },
    { messages: [{ role: 'user', content: 'x' }], fetch: fetchFn },
  );
  assert.equal(body.plugins[0].id, 'web');
  assert.deepEqual(r.sources, [{ url: 'https://a.example', title: 'A', text: 'Jane Smith, HBK', kind: 'cited' }]);
  assert.equal(r.usage.cost, 0.03);
});

test('finder: MX through DNS over HTTPS, a dead domain, and Hunter with its key in a header', async () => {
  const log = [];
  const fetchFn = mockFetch(
    {
      'https://dns.google/resolve?name=hbk.com&type=MX': JSON.stringify({
        Status: 0,
        Answer: [{ type: 15, data: '5 mxa-001f1202.gslb.pphosted.com.' }],
      }),
      'https://dns.google/resolve?name=gone.example&type=MX': JSON.stringify({ Status: 3 }),
      'https://dns.google/resolve?name=nomail.example&type=MX': JSON.stringify({
        Status: 0,
        Answer: [{ type: 15, data: '0 .' }],
      }),
      'https://api.hunter.io/v2/domain-search?domain=hbk.com&limit=5&department=hr%2Cexecutive': JSON.stringify({
        data: {
          domain: 'hbk.com',
          pattern: '{first}.{last}',
          accept_all: true,
          emails: [
            {
              value: 'jane.smith@hbk.com',
              type: 'personal',
              confidence: 94,
              first_name: 'Jane',
              last_name: 'Smith',
              position: 'Head of Talent',
              department: 'hr',
              sources: [
                {
                  domain: 'example.org',
                  uri: 'https://example.org/a',
                  last_seen_on: '2026-10-01',
                  still_on_page: true,
                },
              ],
              verification: { status: 'valid' },
            },
            { value: 'careers@hbk.com', type: 'generic', confidence: 90, sources: [] },
          ],
        },
      }),
      'https://api.hunter.io/v2/email-verifier?email=tom.brown%40hbk.com': JSON.stringify({
        data: { status: 'accept_all', result: 'risky', score: 70, accept_all: true },
      }),
      'https://api.hunter.io/v2/account': () => ({
        ok: false,
        status: 401,
        text: async () => '{"errors":[{"id":"x"}]}',
      }),
    },
    log,
  );
  assert.deepEqual(await F.mx('hbk.com', { fetch: fetchFn }), { ok: true, hosts: ['mxa-001f1202.gslb.pphosted.com'] });
  assert.equal((await F.mx('gone.example', { fetch: fetchFn })).ok, false);
  assert.equal((await F.mx('nomail.example', { fetch: fetchFn })).ok, false, 'a null MX takes no mail');
  const d = await F.hunter.domain('hk', 'hbk.com', { fetch: fetchFn, departments: ['hr', 'executive'] });
  assert.equal(d.pattern, 'first.last');
  assert.deepEqual(
    d.emails.map((e) => [e.address, e.name, e.kind, e.status]),
    [
      ['jane.smith@hbk.com', 'Jane Smith', 'person', 'valid'],
      ['careers@hbk.com', '', 'mailbox', ''],
    ],
  );
  const asked = log.find((l) => /hunter/.test(l.url));
  assert.equal(asked.headers['X-API-KEY'], 'hk');
  assert.doesNotMatch(asked.url, /hk/, 'the key never goes in the address');
  assert.equal((await F.hunter.verify('hk', 'tom.brown@hbk.com', { fetch: fetchFn })).status, 'accept_all');
  await assert.rejects(F.hunter.account('hk', { fetch: fetchFn }), (e) => e.code === 'key');
  await assert.rejects(F.hunter.domain('', 'hbk.com', { fetch: fetchFn }), (e) => e.code === 'setup');
});

test('finder: how far an address can be trusted', () => {
  const mxOk = { ok: true, hosts: ['mx'] };
  assert.equal(F.verdict({ mx: { ok: false }, guessed: true }).level, 'bad');
  assert.equal(F.verdict({ mx: mxOk, check: { status: 'invalid' } }).level, 'bad');
  assert.equal(F.verdict({ mx: mxOk, check: { status: 'valid' }, guessed: true }).level, 'verified');
  assert.equal(F.verdict({ mx: mxOk, listed: 'https://hbk.com/contact' }).level, 'listed');
  const acceptAll = F.verdict({ mx: mxOk, check: { status: 'accept_all' }, guessed: true });
  assert.equal(acceptAll.level, 'likely');
  assert.match(acceptAll.text, /accepts every address/);
  assert.equal(F.verdict({ guessed: true }).level, 'unconfirmed');
});

test('research: a directory’s example addresses are formats, and the format most addresses follow wins', async () => {
  const text =
    'Egerton Capital Email Formats Example Percentage FirstLast@egercap.co.uk JohnDoe@egercap.co.uk 78% ' +
    'F.Last@egercap.co.uk J.Doe@egercap.co.uk 22% First.Last@egertoncapital.com John.Doe@egertoncapital.com 100%';
  assert.deepEqual(R.formatsIn(text, 'egercap.co.uk'), [
    { pattern: 'firstlast', example: '', share: 78 },
    { pattern: 'f.last', example: '', share: 22 },
  ]);
  assert.deepEqual(['FirstLast', 'FLast', 'FirstL', 'JohnDoe'].map(R.shapeOf), ['firstlast', 'flast', 'firstl', '']);
  const firm = { name: 'Egerton Capital', domain: 'egertoncapital.com', site: 'https://www.egertoncapital.com' };
  const search = async () => ({
    json: {
      people: [
        {
          name: 'John Armitage',
          title: 'Chief Investment Officer & Founder',
          url: 'https://www.egertoncapital.com/team',
        },
      ],
    },
    sources: [
      { url: 'https://leadiq.com/c/egerton-capital/x', title: 'Egerton Capital Email Formats', text, kind: 'cited' },
      {
        url: 'https://www.egertoncapital.com/team',
        title: 'Team | Egerton Capital',
        text: 'John Armitage Chief Investment Officer & Founder',
        kind: 'page',
      },
    ],
    searches: 2,
  });
  // Its site prints info@egercap.co.uk: that is the domain its people's mail is on.
  const contacts = { emails: [{ address: 'info@egercap.co.uk', kind: 'general' }] };
  const web = await R.research(search, { firm, contacts, fetch: mockFetch({}) });
  assert.deepEqual(web.emails, [], 'JohnDoe@ and F.Last@ are nobody’s');
  const fetchFn = mockFetch({
    'https://dns.google/resolve?name=egertoncapital.com&type=MX': JSON.stringify({
      Status: 0,
      Answer: [{ type: 15, data: '10 mx.example.' }],
    }),
    'https://dns.google/resolve?name=egercap.co.uk&type=MX': JSON.stringify({
      Status: 0,
      Answer: [{ type: 15, data: '10 mx.example.' }],
    }),
  });
  const found = await R.addresses(web, { firm, contacts, domain: 'egertoncapital.com', fetch: fetchFn });
  assert.equal(found.format.pattern, 'firstlast');
  assert.equal(found.format.domain, 'egercap.co.uk');
  assert.match(found.format.why, /78% of its addresses/);
  assert.deepEqual(
    found.people.map((p) => [p.address, p.how, p.level]),
    [['johnarmitage@egercap.co.uk', 'format', 'likely']],
  );
});

test('research: people the firm’s own site names get an address from a confirmed format', async () => {
  const firm = { name: 'HBK Capital Management', domain: 'hbk.com' };
  const contacts = {
    named: [
      {
        name: 'Brian Palabrica',
        title: 'Head of Recruitment',
        role: 'recruiting',
        page: 'https://www.hbk.com/leadership',
      },
    ],
  };
  const web = {
    people: [],
    emails: [],
    formats: [
      {
        pattern: 'first.last',
        domain: 'hbk.com',
        url: 'https://rocketreach.co/hbk-email-format',
        source: 'stated',
        share: 85,
      },
    ],
  };
  const fetchFn = mockFetch({
    'https://dns.google/resolve?name=hbk.com&type=MX': JSON.stringify({
      Status: 0,
      Answer: [{ type: 15, data: '5 mxa.pphosted.com.' }],
    }),
  });
  const found = await R.addresses(web, { firm, contacts, domain: 'hbk.com', fetch: fetchFn });
  assert.deepEqual(
    found.people.map((p) => [p.name, p.address, p.group, p.level]),
    [['Brian Palabrica', 'brian.palabrica@hbk.com', 'recruiting', 'likely']],
  );
  assert.match(
    found.people[0].why,
    /Head of Recruitment, on hbk\.com; address from the format first\.last@ \(stated on rocketreach\.co, 85% of its addresses\)/,
  );
});
