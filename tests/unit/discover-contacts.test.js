'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers');

load();
require('../../extension/lib/jobpage.js');
const D = require('../../extension/lib/discover.js');
const C = require('../../extension/lib/discover-contacts.js');

const NOW = Date.parse('2026-10-03T09:00:00Z');

/** A fetch that serves fixed bodies by URL, and records what was asked for. */
function mockFetch(routes, log = []) {
  return async (url, init = {}) => {
    log.push({ url, method: init.method || 'GET' });
    const route = routes[url];
    if (route === undefined) return { ok: false, status: 404, url, text: async () => 'Not found' };
    if (typeof route === 'function') return route(url, init);
    return { ok: true, status: 200, url, text: async () => route };
  };
}

/** An address as Cloudflare hides it: a key byte, then every character XORed with it. */
function cloudflare(address, key = 0x5a) {
  return key.toString(16) + [...address].map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, '0')).join('');
}

const PAD = `<p>${'Acme Capital is a London investment firm. '.repeat(10)}</p>`;

// A team page as small firms build them: cards with a photo, the name in a heading and the title under it.
const TEAM = `<html><head><title>Our team | Acme Capital</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Acme Capital",
 "email":"info@acmecapital.com","contactPoint":{"@type":"ContactPoint","email":"careers@acmecapital.com"},
 "founder":{"@type":"Person","name":"Robert Black","jobTitle":"Founder and Managing Partner",
 "sameAs":["https://www.linkedin.com/in/robertblack"]}}</script></head><body>
<nav><a href="/about">About</a></nav>
<h1>Our team</h1>
<div class="team-grid">
  <div class="team-member">
    <img src="/img/jane.jpg" alt="Jane Smith">
    <h3 class="team-member__name">Jane Smith</h3>
    <p class="team-member__role">Head of Talent</p>
    <a href="mailto:jane.smith@acmecapital.com">Email</a>
    <a href="https://uk.linkedin.com/in/janesmith/">LinkedIn</a>
  </div>
  <div class="team-member">
    <img src="/img/tom.jpg" alt="Photo of Tom O'Neil">
    <h3 class="team-member__name">Tom O&#8217;Neil</h3>
    <p class="team-member__role">Partner, Credit</p>
    <a href="mailto:tom.oneil@acmecapital.com">tom.oneil@acmecapital.com</a>
  </div>
  <div class="team-member"><h3>Priya Patel</h3><p>Graduate Recruitment Manager</p></div>
  <div class="team-member"><h3>Mark Read</h3><p>Analyst</p></div>
</div>
<h2>Asset Management</h2><p>Our portfolio managers invest across credit.</p>
<h2>Our Offices</h2><p>Partner with us</p>
${PAD}
<footer>Acme Capital LLP · <a href="mailto:press@acmecapital.com">Press</a> ·
  Legal advice from <a href="mailto:j.doe@lawfirm.co.uk">J Doe</a></footer>
</body></html>`;

/* --------------------------------------------------------------- kinds */

test('discover contacts: what an address is for', () => {
  const kinds = {
    'careers@acme.com': 'recruiting',
    'Internships2027@acme.com': 'recruiting',
    'campusrecruiting@acme.com': 'recruiting',
    'graduates-uk@acme.com': 'recruiting',
    'hr@acme.com': 'recruiting',
    'people@acme.com': 'recruiting',
    'cv@acme.com': 'recruiting',
    'workwithus@acme.com': 'recruiting',
    'talent.acquisition@acme.com': 'recruiting',
    'info@acme.com': 'general',
    'contact.us@acme.com': 'general',
    'hello@acme.com': 'general',
    'london@acme.com': 'general',
    'info.uk@acme.com': 'general',
    'enquiries@acme.com': 'general',
    'jane.smith@acme.com': 'person',
    'jsmith@acme.com': 'person',
    'j.smith@acme.com': 'person',
    'jane_smith@acme.com': 'person',
    'jane@acme.com': 'person',
    'press@acme.com': 'other',
    'ir@acme.com': 'other',
    'investor-relations@acme.com': 'other',
    'no-reply@acme.com': 'other',
    'donotreply@acme.com': 'other',
    'compliance@acme.com': 'other',
    'gdpr@acme.com': 'other',
    'trading@acme.com': 'other',
    'jane.smith2@acme.com': 'other',
    // A department or a system's mailbox isn't a person, however much it looks like one word or two.
    'internal@acme.com': 'other',
    'partners@acme.com': 'other',
    'workday@acme.com': 'other',
    'new.business@acme.com': 'other',
    'internal.enquiries@acme.com': 'other',
    'machine.learning@acme.com': 'other',
    'customer.success@acme.com': 'other',
    'hrteam@acme.com': 'recruiting',
    'peopleops@acme.com': 'recruiting',
    'jack.london@acme.com': 'person',
    'smith@acme.com': 'person',
    // Nobody reads these, whatever they're about.
    'jobs-noreply@acme.com': 'other',
    'recruiting-noreply@acme.com': 'other',
    'careers-no-reply@acme.com': 'other',
    'careers.donotreply@acme.com': 'other',
    'talent-notifications@acme.com': 'other',
    'mailer-daemon@acme.com': 'other',
    'jobalerts@acme.com': 'other',
  };
  for (const [address, kind] of Object.entries(kinds)) assert.equal(C.kindOf(address), kind, address);
});

/* ------------------------------------------------------------ addresses */

test('discover contacts: addresses in links, text, Cloudflare, JSON-LD and written-out forms', () => {
  const html = `<html><head><script type="application/ld+json">
    {"@type":"Organization","name":"Acme","contactPoint":[{"@type":"ContactPoint","email":"mailto:Careers@AcmeCapital.com"}]}
    </script></head><body>
    <p>Write to us: <a href="mailto:Internships@AcmeCapital.com?subject=Internship">apply</a></p>
    <p>Graduates: graduates&#64;acmecapital.com</p>
    <p>Or jane [at] acmecapital [dot] com, or tom (at) acmecapital (dot) com, or sam at acmecapital dot com.</p>
    <p>Hidden: <a href="/cdn-cgi/l/email-protection#${cloudflare('hello@acmecapital.com')}">[email&#160;protected]</a></p>
    <p>Joe: jo&#8203;e.bloggs@acmecapital.com</p>
    <p>Our recruiters: recruiting@acmerecruiting.com</p>
    <p>Our lawyers: info@lawfirm.com, partner.name@lawfirm.com</p>
    <p>Media: press@acmecapital.com, noreply@acmecapital.com</p>
    <p>Meet you at Acme dot com events.</p>
    <img src="/logo@2x.png" alt="Acme"></body></html>`;
  const found = C.emailsIn(html, { domain: 'acmecapital.com' });
  assert.deepEqual(
    found.map((e) => `${e.address} ${e.kind} ${e.source}${e.name ? ' ' + e.name : ''}`),
    [
      'careers@acmecapital.com recruiting jsonld',
      'internships@acmecapital.com recruiting mailto',
      'hello@acmecapital.com general cloudflare',
      'graduates@acmecapital.com recruiting obfuscated',
      'joe.bloggs@acmecapital.com person obfuscated Joe Bloggs',
      'recruiting@acmerecruiting.com recruiting text',
      'jane@acmecapital.com person obfuscated',
      'tom@acmecapital.com person obfuscated',
      'sam@acmecapital.com person obfuscated',
    ],
  );
});

// Egerton Capital's contact page as served: "Email [email protected]", hidden twice over (keys 0x8d and 0x6e).
const EGERTON_EMAIL = `<p>Email <a class="no-underline" href="/cdn-cgi/l/email-protection#8de4e3ebe2cde8eae8ffeeecfda3eee2a3f8e6"><span class="__cf_email__" data-cfemail="6e070008012e0b090b1c0d0f1e400d01401b05">[email&#160;protected]</span></a></p>`;

test('discover contacts: a Cloudflare-hidden address on the firm’s name cut short is its own', () => {
  // Both encodings are "info@egercap.co.uk": Egerton Capital's mailbox, not on egertoncapital.com.
  const own = { domain: 'egertoncapital.com', name: 'Egerton Capital' };
  assert.deepEqual(C.emailsIn(EGERTON_EMAIL, own), [
    { address: 'info@egercap.co.uk', kind: 'general', name: '', source: 'cloudflare' },
  ]);
  // Without the firm's name it is another domain's general mailbox, like a law firm's.
  assert.deepEqual(C.emailsIn(EGERTON_EMAIL, { domain: 'egertoncapital.com' }), []);
  const mailboxes = (domain) => C.emailsIn(`<p>Write to info@${domain}</p>`, own).map((e) => e.address);
  assert.deepEqual(mailboxes('egerton.com'), ['info@egerton.com'], 'the first word whole');
  assert.deepEqual(mailboxes('egerton-cap.com'), ['info@egerton-cap.com']);
  assert.deepEqual(mailboxes('eger.co.uk'), [], 'one word cut short could be anyone’s');
  assert.deepEqual(mailboxes('capital.com'), [], 'not from the first word');
  assert.deepEqual(mailboxes('egerlaw.co.uk'), []);
  assert.deepEqual(
    C.emailsIn('<p>JP: info@jpmorgan.com</p>', { domain: 'jpmorganchase.com', name: 'J.P. Morgan' }).map(
      (e) => e.address,
    ),
    ['info@jpmorgan.com'],
  );
});

test('discover contacts: a person’s name for their address, from beside it or its shape', () => {
  const html = `<a href="mailto:jsmith@acme.com">Jane Smith</a> <a href="mailto:tom.brown@acme.com">Email</a>
    <a href="mailto:kwu@acme.com">Email</a> <a href="mailto:alee@acme.com">Bob Jones</a>`;
  assert.deepEqual(
    C.emailsIn(html, { domain: 'acme.com' }).map((e) => [e.address, e.name]),
    [
      ['jsmith@acme.com', 'Jane Smith'],
      ['tom.brown@acme.com', 'Tom Brown'],
      ['kwu@acme.com', ''],
      // The name beside it doesn't spell it, so it isn't theirs.
      ['alee@acme.com', ''],
    ],
  );
});

/* --------------------------------------------------------------- people */

test('discover contacts: the people on a team page, with their titles, addresses and LinkedIn', () => {
  const people = C.peopleIn(TEAM, { domain: 'acmecapital.com' });
  assert.deepEqual(
    people.map((p) => [p.name, p.title, p.role, p.email]),
    [
      ['Jane Smith', 'Head of Talent', 'recruiting', 'jane.smith@acmecapital.com'],
      ['Priya Patel', 'Graduate Recruitment Manager', 'recruiting', ''],
      ['Robert Black', 'Founder and Managing Partner', 'leadership', ''],
      ["Tom O'Neil", 'Partner, Credit', 'leadership', 'tom.oneil@acmecapital.com'],
      // Mark Read, an analyst named only in a heading, isn't counted: nothing else says the heading is a person.
    ],
  );
  assert.equal(people[0].linkedin, 'https://uk.linkedin.com/in/janesmith/');
  assert.equal(people.find((p) => p.name === 'Robert Black').linkedin, 'https://www.linkedin.com/in/robertblack');
});

test('discover contacts: headings that aren’t people, and a name in a strong tag or a class', () => {
  const html = `<h2>Private Equity</h2><p>Director-led deals</p><h3>Meet The Team</h3><p>Partner</p>
    <h4>Contact Us</h4><p>Head office</p><h3>2027 Summer Internship</h3><p>Analyst programme</p>
    <p><strong>Dr Sarah McDonald, CFA</strong>, Chief Investment Officer</p>
    <div class="bio"><span class="person-name">JAMES VAN DER BERG</span><span class="person-role">Head of People</span></div>`;
  assert.deepEqual(
    C.peopleIn(html, { domain: 'acme.com' }).map((p) => [p.name, p.title, p.role]),
    [
      ['James van der Berg', 'Head of People', 'recruiting'],
      ['Sarah McDonald', 'Chief Investment Officer', 'leadership'],
    ],
  );
});

test('discover contacts: a person’s address spells their name or its link names them, never just the nearest', () => {
  // The last card runs to the end of the page, where the firm's own mailboxes are.
  const last = `<html><title>Team | Acme</title><h3>John Doe</h3><p>Founder &amp; CEO</p><p>John started Acme in 2009.</p>
    <p>Internal enquiries: internal@acme.com</p>${PAD}</html>`;
  assert.deepEqual(
    C.peopleIn(last, { domain: 'acme.com' }).map((p) => [p.name, p.email]),
    [['John Doe', '']],
  );
  assert.deepEqual(
    C.contacts({ name: 'Acme', domain: 'acme.com' }, [{ url: 'https://acme.com/team', html: last }]).best,
    [],
  );
  const html = `<h3>Sara Lee</h3><p>Head of People</p>
    <p>To visit, write to <a href="mailto:mary.jones@acme.com">Mary</a> at reception.</p>
    <h3>Tom Brown</h3><p>Partner</p><a href="mailto:tommy@acme.com" aria-label="Email Tom Brown">✉</a>
    <h3>Ann Wu</h3><p>Partner</p><a href="mailto:awu@acme.com">Email</a>`;
  assert.deepEqual(
    C.peopleIn(html, { domain: 'acme.com' }).map((p) => [p.name, p.email]),
    [
      ['Sara Lee', ''],
      ['Tom Brown', 'tommy@acme.com'],
      ['Ann Wu', 'awu@acme.com'],
    ],
  );
});

test('discover contacts: an address that could be two people’s is given to neither, listed or guessed', () => {
  const html = `<html><title>Team | Acme</title><h3>Jane Smith</h3><p>Head of Talent</p>
    <h3>John Smith</h3><p>Partner</p><a href="mailto:jsmith@acme.com">Email John</a>${PAD}</html>`;
  const res = C.contacts({ name: 'Acme', domain: 'acme.com' }, [{ url: 'https://acme.com/team', html }]);
  assert.deepEqual(
    res.people.map((p) => [p.name, p.email]),
    [
      ['Jane Smith', ''],
      ['John Smith', 'jsmith@acme.com'],
    ],
  );
  assert.deepEqual(
    res.best.map((b) => [b.address, b.name, b.guessed]),
    [['jsmith@acme.com', 'John Smith', false]],
  );
});

test('discover contacts: section headings aren’t people, and get no guessed address', () => {
  const html = `<html><title>Team | Acme</title>
    <h3>Anna Lee</h3><p>Partner</p><a href="mailto:anna.lee@acme.com">Email Anna</a>
    <h2>Machine Learning</h2><p>Lead by our CTO, the team builds models.</p>
    <h2>Customer Success</h2><p>Head of Customer Success</p>
    <h2>Data Science</h2><img src="/img/lab.png" alt="Data Science"><p>Head of Research</p>
    <h3>Mark Read</h3><p>Analyst</p>
    <img src="/img/ola.jpg" alt="Ola Nordmann"><h3>Ola Nordmann</h3><p>Analyst</p>${PAD}</html>`;
  assert.deepEqual(
    C.peopleIn(html, { domain: 'acme.com' }).map((p) => [p.name, p.title, p.role]),
    [
      ['Anna Lee', 'Partner', 'leadership'],
      // An analyst's photo says the heading is a person; a heading and "Analyst" alone don't.
      ['Ola Nordmann', 'Analyst', 'other'],
    ],
  );
  const res = C.contacts({ name: 'Acme', domain: 'acme.com', employees: 20 }, [{ url: 'https://acme.com/team', html }]);
  assert.deepEqual(
    res.best.map((b) => b.address),
    ['anna.lee@acme.com'],
  );
});

test('discover contacts: a no-reply address is never offered as the recruiting mailbox', () => {
  const html = `<html><title>Careers | Acme</title><p>Applications are acknowledged from
    <a href="mailto:recruiting-noreply@acme.com">recruiting-noreply@acme.com</a>; questions to careers@acme.com.</p>
    <p>Alerts come from jobs-noreply@acme.com and careers-no-reply@acme.com.</p>${PAD}</html>`;
  assert.deepEqual(
    C.emailsIn(html, { domain: 'acme.com' }).map((e) => e.address),
    ['careers@acme.com'],
  );
  const res = C.contacts({ name: 'Acme', domain: 'acme.com' }, [{ url: 'https://acme.com/careers', html }]);
  assert.deepEqual(
    res.best.map((b) => b.address),
    ['careers@acme.com'],
  );
});

/* ------------------------------------------------------------- patterns */

test('discover contacts: the firm’s address pattern, from names or from shapes that can only be one thing', () => {
  const emails = C.emailsIn(TEAM, { domain: 'acmecapital.com' });
  const people = C.peopleIn(TEAM, { domain: 'acmecapital.com' });
  assert.deepEqual(C.patternOf(emails, people), {
    pattern: 'first.last',
    examples: 2,
    sample: 'jane.smith@acmecapital.com',
    domain: 'acmecapital.com',
  });
  assert.deepEqual(C.patternOf(['jsmith@acme.com', 'tbrown@acme.com'], ['Jane Smith', 'Tom Brown']), {
    pattern: 'flast',
    examples: 2,
    sample: 'jsmith@acme.com',
    domain: 'acme.com',
  });
  assert.equal(C.patternOf(['jane@acme.com'], [{ name: 'Jane Smith' }]).pattern, 'first');
  assert.equal(C.patternOf(['ann.lee@acme.com']).pattern, 'first.last');
  assert.equal(C.patternOf(['ann_lee@acme.com']).pattern, 'first_last');
  assert.equal(C.patternOf(['ann-lee@acme.com']).pattern, 'first-last');
  assert.equal(C.patternOf(['a.lee@acme.com']).pattern, 'f.last');
  // "jsmith" could be J. Smith or a one-word name: nothing to go on.
  assert.deepEqual(C.patternOf(['jsmith@acme.com'], []), { pattern: null, examples: 0, sample: '', domain: '' });
  // Mailboxes say nothing about people's addresses.
  assert.equal(C.patternOf(['careers@acme.com', 'info@acme.com'], ['Jane Smith']).pattern, null);
});

test('discover contacts: a guessed address from a name and the pattern', () => {
  assert.equal(C.guess({ name: 'Priya Patel' }, 'first.last', 'acmecapital.com'), 'priya.patel@acmecapital.com');
  assert.equal(C.guess('Renée O’Neil-Smith', 'flast', 'acme.com'), 'roneilsmith@acme.com');
  assert.equal(
    C.guess('Jan van der Berg', { pattern: 'first.last' }, 'https://www.acme.nl/team'),
    'jan.vanderberg@acme.nl',
  );
  assert.equal(C.guess('Jane A. Smith', 'firstl', 'acme.com'), 'janes@acme.com');
  assert.equal(C.guess('Jane Smith', 'last', 'acme.com'), 'smith@acme.com');
  assert.equal(C.guess('Madonna', 'first.last', 'acme.com'), '');
  assert.equal(C.guess('Madonna', 'first', 'acme.com'), 'madonna@acme.com');
  assert.equal(C.guess('J. Smith', 'first.last', 'acme.com'), '', 'an initial is not a first name');
  assert.equal(C.guess('J. Smith', 'f.last', 'acme.com'), 'j.smith@acme.com');
  assert.equal(C.guess('Jane Smith', null, 'acme.com'), '');
  assert.equal(C.guess('Jane Smith', 'first.last', ''), '');
  assert.equal(C.guess('Machine Learning', 'first.last', 'acme.com'), '', 'a section, not a person');
});

/* -------------------------------------------------------------- ranking */

const ACME = { name: 'Acme Capital', domain: 'acmecapital.com', site: 'https://www.acmecapital.com', employees: 40 };
const CAREERS = `<html><title>Careers | Acme Capital</title><h1>Careers</h1>
  <p>Students: <a href="mailto:internships@acmecapital.com">internships@acmecapital.com</a></p>${PAD}</html>`;

test('discover contacts: the best people to write to, ranked, with guesses marked as guesses', () => {
  const res = C.contacts(ACME, [
    { url: 'https://www.acmecapital.com/careers', html: CAREERS, careers: true },
    { url: 'https://www.acmecapital.com/team', html: TEAM },
  ]);
  assert.deepEqual(
    res.best.map((b) => [b.address, b.kind, b.guessed, b.why]),
    [
      ['internships@acmecapital.com', 'recruiting', false, 'Listed on its careers page'],
      ['careers@acmecapital.com', 'recruiting', false, 'Listed on its team page'],
      ['jane.smith@acmecapital.com', 'person', false, 'Head of Talent, listed on the team page'],
      [
        'priya.patel@acmecapital.com',
        'person',
        true,
        'Guessed from the firm’s pattern (2 addresses on its site are first.last@)',
      ],
      ['info@acmecapital.com', 'general', false, 'General mailbox'],
    ],
  );
  assert.equal(res.best[3].name, 'Priya Patel');
  assert.equal(res.best[3].title, 'Graduate Recruitment Manager');
  assert.equal(res.pattern.pattern, 'first.last');
  assert.ok(res.people.length >= 4);
  assert.ok(!res.emails.some((e) => /press|lawfirm/.test(e.address)));
});

const ABOUT = `<html><title>About Acme Capital</title>
  <h3>Robert Black</h3><p>Founder and Managing Partner</p>
  <h3>Anna Lee</h3><p>Partner</p><a href="mailto:anna.lee@acmecapital.com">Email Anna</a>
  <p>General enquiries: info@acmecapital.com</p>${PAD}</html>`;

test('discover contacts: at a small firm its leaders come after the mailboxes; at a big one they don’t', () => {
  const small = C.contacts(ACME, [{ url: 'https://www.acmecapital.com/about', html: ABOUT }]);
  assert.deepEqual(
    small.best.map((b) => [b.address, b.guessed, b.why]),
    [
      ['info@acmecapital.com', false, 'General mailbox'],
      ['anna.lee@acmecapital.com', false, 'Partner, listed on the about page'],
      ['robert.black@acmecapital.com', true, 'Guessed from the firm’s pattern (1 address on its site is first.last@)'],
    ],
  );
  const big = C.contacts({ ...ACME, employees: 900 }, [{ url: 'https://www.acmecapital.com/about', html: ABOUT }]);
  assert.deepEqual(
    big.best.map((b) => b.address),
    ['info@acmecapital.com'],
  );
});

test('discover contacts: no guess without an address to learn the pattern from, nor from a page not the firm’s', () => {
  const people = `<html><title>Acme Capital</title><h3>Priya Patel</h3><p>Head of Recruiting</p>${PAD}</html>`;
  const none = C.contacts(ACME, [{ url: 'https://www.acmecapital.com/team', html: people }]);
  assert.equal(none.people[0].name, 'Priya Patel');
  assert.deepEqual(none.best, []);
  assert.equal(none.pattern.pattern, null);
  // A page that doesn't name the firm keeps its mailboxes but not its people or their addresses.
  const other = C.contacts(ACME, [{ url: 'https://www.acmecapital.com/team', html: TEAM, isFirm: false }]);
  assert.deepEqual(other.people, []);
  assert.ok(!other.emails.some((e) => e.kind === 'person'));
  assert.deepEqual(
    other.best.map((b) => b.address),
    ['careers@acmecapital.com', 'info@acmecapital.com'],
  );
});

/* ---------------------------------------------------------------- fetch */

const SITE = 'https://www.acme.example';
const page = (title, body) =>
  `<html><head><title>${title}</title></head><body>${body}${'<p>x</p>'.repeat(40)}</body></html>`;

test('discover contacts: reads the home page’s links, guesses the usual paths until two answer, and the careers pages', async () => {
  const log = [];
  const fetch = mockFetch(
    {
      [`${SITE}/`]: page(
        'Acme Capital',
        `<nav><a href="/who-we-are">Who we are</a><a href="/careers">Careers</a><a href="/about/logout">About you: sign out</a></nav>`,
      ),
      [`${SITE}/who-we-are`]: page(
        'Who we are | Acme Capital',
        `<h3>Jane Smith</h3><p>Head of Talent</p><a href="mailto:jane.smith@acme.example">Email</a>`,
      ),
      // Answers, but isn't the firm's (a template left on the server): nobody on it counts.
      [`${SITE}/team`]: page(
        'Our people',
        `<h3>Bob Jones</h3><p>Head of People</p><a href="mailto:bob.jones@acme.example">Email Bob</a>`,
      ),
      [`${SITE}/people`]: page('Our team | Acme Capital', `<h3>Anna Lee</h3><p>Managing Partner</p>`),
      [`${SITE}/about`]: page('About | Acme Capital', `<p>info@acme.example</p>`),
      [`${SITE}/our-team`]: page('Our team | Acme Capital', `<h3>Sam West</h3><p>Partner</p>`),
      [`${SITE}/careers`]: page(
        'Careers | Acme Capital',
        `<p>Write to <a href="mailto:recruiting@acme.example">our recruiting team</a>.</p>`,
      ),
    },
    log,
  );
  const firm = { name: 'Acme Capital', domain: 'acme.example', site: SITE, employees: null };
  const res = await C.findContacts(firm, { fetch, pages: [`${SITE}/careers`], now: NOW });
  const asked = log.map((l) => l.url);
  assert.ok(asked.includes(`${SITE}/team`) && asked.includes(`${SITE}/contact`) && asked.includes(`${SITE}/people`));
  assert.ok(!asked.includes(`${SITE}/about`), '“Who we are” is its about page: not guessed again');
  assert.ok(!asked.includes(`${SITE}/team/`), 'the same page as /team');
  assert.ok(!asked.includes(`${SITE}/our-team`), 'two guessed paths answered: no more guesses');
  assert.ok(!asked.some((u) => /logout/.test(u)), 'never opens an address that might do something');
  assert.ok(asked.length <= 8);
  assert.equal(res.status, 'found');
  assert.deepEqual(
    res.best.map((b) => [b.address, b.guessed, b.why]),
    [
      ['recruiting@acme.example', false, 'Listed on its careers page'],
      ['jane.smith@acme.example', false, 'Head of Talent, listed on the about page'],
      ['anna.lee@acme.example', true, 'Guessed from the firm’s pattern (1 address on its site is first.last@)'],
    ],
  );
  assert.ok(!res.people.some((p) => p.name === 'Bob Jones'));
  assert.ok(!res.emails.some((e) => e.address === 'bob.jones@acme.example'));
  assert.deepEqual(
    res.log.map((l) => `${l.outcome}: ${l.url.replace(SITE, '')}`),
    [
      'home page: /',
      'about page: /who-we-are',
      'careers page: /careers',
      'doesn’t name the firm: /team',
      'team page: /people',
    ],
  );
  assert.equal(res.checkedAt, NOW);
});

test('discover contacts: a home page’s link is followed when its words or its address say contact, about or team', () => {
  const kind = (url, text = '') => C.linkKind({ url, text }, 'acme.example');
  // The right ones, and what they are read as.
  assert.equal(kind(`${SITE}/contact-us/`, 'Contact us'), 'contact page');
  assert.equal(kind(`${SITE}/company`, 'About Us'), 'about page', 'Darktrace’s about page is /company');
  assert.equal(kind(`${SITE}/company/contact-us/`, 'Contact support'), 'contact page', 'by its address');
  assert.equal(kind(`${SITE}/company/team`, 'Meet our people'), 'team page');
  assert.equal(kind(`${SITE}/about/us`), 'about page');
  assert.equal(kind(`${SITE}/who-we-are`, 'Who we are'), 'about page');
  assert.equal(kind(`${SITE}/firm`, 'Get in touch →'), 'contact page');
  assert.equal(kind(`${SITE}/insights`, 'MEET THE TEAM'), 'team page');
  // "contact" or "about" inside a slug, a product, a post, a help centre or a sign-in page.
  assert.equal(kind(`${SITE}/use-cases/contact-center-solutions`), '', 'Speechmatics');
  assert.equal(kind(`${SITE}/blog/why-has-hmrc-written-to-me-about-mtd/`, 'I’ve received a letter'), '', 'FreeAgent');
  assert.equal(kind(`${SITE}/blog/about`, 'About'), '');
  assert.equal(kind(`${SITE}/products/team-inbox`, 'Team'), '');
  assert.equal(kind(`${SITE}/talk-to-a-human`, 'Talk to a human'), '', 'PostHog');
  assert.equal(kind('https://help.acme.example/en/articles/7182166-how-can-i-contact-acme', 'Contact Sales'), '');
  assert.equal(kind('https://support.acme.example/contact', 'Contact'), '');
  assert.equal(kind(`${SITE}/login/?loginredirect=/about-us/team`, 'Team'), '', 'Capula');
  assert.equal(kind(`${SITE}/sign_up`, 'Join the team'), '');
  assert.equal(kind(`${SITE}/contact-sales`, 'Contact sales'), '');
  assert.equal(kind(`${SITE}/about-our-funds`, 'About our funds'), '');
  assert.equal(kind('https://other.example/contact', 'Contact'), '', 'another site');
  assert.equal(kind(`${SITE}/about.pdf`, 'About'), '');
});

test('discover contacts: a guess that lands on a sign-in page is skipped; one that lands elsewhere keeps its kind', async () => {
  const log = [];
  const fetch = mockFetch(
    {
      [`${SITE}/`]: page('Acme Capital', '<nav><a href="/talk-to-a-human">Talk to a human</a></nav>'),
      // Capula's /team asks investors to sign in; whatever the sign-in page says, it names nobody.
      [`${SITE}/team`]: (url) => ({
        ok: true,
        status: 200,
        url: `${SITE}/login/?loginredirect=/about-us/team`,
        text: async () =>
          page(
            'Investor login | Acme Capital',
            '<h3>Jane Smith</h3><p>Head of Talent</p><p>jane.smith@acme.example</p>',
          ),
      }),
      [`${SITE}/team/`]: (url) => ({
        ok: true,
        status: 200,
        url: `${SITE}/login/?loginredirect=/about-us/team/`,
        text: async () => page('Investor login | Acme Capital', ''),
      }),
      // PostHog's /contact is "/talk-to-a-human".
      [`${SITE}/contact`]: (url) => ({
        ok: true,
        status: 200,
        url: `${SITE}/talk-to-a-human`,
        text: async () => page('Talk to a human | Acme Capital', '<p>hello@acme.example</p>'),
      }),
    },
    log,
  );
  const firm = { name: 'Acme Capital', domain: 'acme.example', site: SITE, employees: 30 };
  const res = await C.findContacts(firm, { fetch, now: NOW });
  assert.ok(!log.some((l) => l.url === `${SITE}/talk-to-a-human`), 'the link isn’t followed');
  assert.deepEqual(
    res.log.map((l) => `${l.outcome}: ${l.url}`),
    [
      `home page: ${SITE}/`,
      `sign-in page, skipped: ${SITE}/login/?loginredirect=/about-us/team`,
      `contact page: ${SITE}/talk-to-a-human`,
    ],
  );
  assert.deepEqual(res.people, []);
  assert.ok(!res.emails.some((e) => e.address === 'jane.smith@acme.example'));
  assert.deepEqual(
    res.best.map((b) => [b.address, b.why]),
    [['hello@acme.example', 'General mailbox']],
  );
});

test('discover contacts: a guessed /contact/ page gives the firm’s mailbox when the home page links nowhere', async () => {
  const EG = 'https://www.egertoncapital.com';
  const fetch = mockFetch({
    // Egerton's home page is a terms gate; it names the firm, so it is the firm's.
    [`${EG}/`]: page(
      'Egerton Capital - Investment Management Firm',
      `<p>By clicking the ‘I Accept’ button below you agree that you have read and accepted these terms and conditions.
      Egerton Capital (UK) LLP may suspend your use of this Site immediately if you do not comply with this Agreement.</p>
      <button type="button">I Accept</button>`,
    ),
    // WordPress adds the slash.
    [`${EG}/contact`]: () => ({
      ok: true,
      status: 200,
      url: `${EG}/contact/`,
      text: async () => page('Contact - Egerton Capital', `<h1>Contact</h1>${EGERTON_EMAIL}`),
    }),
  });
  const firm = { name: 'Egerton Capital', domain: 'egertoncapital.com', site: EG, employees: 36 };
  const res = await C.findContacts(firm, { fetch, now: NOW });
  assert.equal(res.status, 'found');
  assert.ok(res.log.some((l) => l.url === `${EG}/contact/` && l.outcome === 'contact page'));
  assert.deepEqual(
    res.best.map((b) => [b.kind, b.address, b.why, b.page]),
    [['general', 'info@egercap.co.uk', 'General mailbox', `${EG}/contact/`]],
  );
});

test('discover contacts: the firm’s pattern counts as found when no one is offered', async () => {
  // A big firm: its leaders aren't offered, but its press contacts show how its addresses are made.
  const fetch = mockFetch({
    [`${SITE}/`]: page('Acme Capital', '<nav><a href="/company/leadership">Leadership</a></nav>'),
    [`${SITE}/company/leadership`]: page(
      'Leadership | Acme Capital',
      `<h1>Leadership</h1><p>Media enquiries: madeline.wilson@acme.example, tom.brown@acme.example or
      sam.west@acme.example.</p>`,
    ),
  });
  const firm = { name: 'Acme Capital', domain: 'acme.example', site: SITE, employees: 1600 };
  const res = await C.findContacts(firm, { fetch, now: NOW });
  assert.deepEqual(res.best, []);
  assert.deepEqual(res.people, []);
  assert.deepEqual(res.pattern, {
    pattern: 'first.last',
    examples: 3,
    sample: 'madeline.wilson@acme.example',
    domain: 'acme.example',
  });
  assert.equal(res.status, 'found');
  assert.ok(res.log.some((l) => l.url === `${SITE}/company/leadership` && l.outcome === 'team page'));
});

test('discover contacts: a site that doesn’t answer is unreachable', async () => {
  const res = await C.findContacts(
    { name: 'Gone Capital', domain: 'gone.example', site: 'https://gone.example' },
    { fetch: mockFetch({}), now: NOW },
  );
  assert.equal(res.status, 'unreachable');
  assert.deepEqual(res.best, []);
  assert.ok(D.get, 'discover.js is what fetches');
});
