'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const nylas = require('../../extension/lib/nylas.js');

const config = { apiKey: 'nyk_x', region: 'eu', grantId: 'g-1', email: 'ada@example.org' };

/** A fetch that answers every request with `reply` (status, data), and keeps what was asked. */
function fake(reply, log) {
  return async (url, init = {}) => {
    log.push({ url, init });
    const { status = 200, data = {} } = typeof reply === 'function' ? reply(url, init) : reply;
    return { ok: status < 400, status, text: async () => JSON.stringify(data) };
  };
}

const PDF = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 tiny').toString('base64');

test('nylas: an email as Nylas takes it, plain text as paragraphs, the CV as base64', () => {
  const m = nylas.messageOf({
    to: 'jane.smith@hbk.com',
    name: 'Jane Smith',
    subject: 'Summer internship enquiry, HBK',
    text: 'Dear Jane,\n\nI study <Computer Science> & more.\n\nKind regards,\nAda Lovelace\nada@example.org',
    attachments: [{ name: 'Ada Lovelace CV.pdf', dataUrl: PDF }],
  });
  assert.deepEqual(m.to, [{ email: 'jane.smith@hbk.com', name: 'Jane Smith' }]);
  assert.equal(
    m.body,
    '<p>Dear Jane,</p>\n<p>I study &lt;Computer Science&gt; &amp; more.</p>\n<p>Kind regards,<br>Ada Lovelace<br>ada@example.org</p>',
  );
  assert.deepEqual(
    { ...m.attachments[0], content: Buffer.from(m.attachments[0].content, 'base64').toString() },
    { filename: 'Ada Lovelace CV.pdf', content_type: 'application/pdf', content: '%PDF-1.4 tiny', size: 13 },
  );
  assert.throws(() => nylas.messageOf({ to: 'not an address', text: 'x' }), /no address/);
});

test('nylas: sends and saves drafts through the grant, JSON with the key in a header', async () => {
  const log = [];
  const fetchFn = fake({ data: { data: { id: 'm-9', thread_id: 't-3', date: 1763400000 } } }, log);
  const email = {
    to: [{ email: 'careers@hbk.com' }],
    subject: 'Hello',
    text: 'Hi',
    attachments: [{ name: 'cv.pdf', dataUrl: PDF }],
  };
  assert.deepEqual(await nylas.send(config, email, { fetch: fetchFn }), {
    id: 'm-9',
    threadId: 't-3',
    date: 1763400000,
  });
  assert.equal(log[0].url, 'https://api.eu.nylas.com/v3/grants/g-1/messages/send');
  assert.equal(log[0].init.method, 'POST');
  assert.equal(log[0].init.headers.Authorization, 'Bearer nyk_x');
  const body = JSON.parse(log[0].init.body);
  assert.deepEqual(body.to, [{ email: 'careers@hbk.com' }]);
  assert.equal(body.attachments[0].filename, 'cv.pdf');
  await nylas.saveDraft(config, email, { fetch: fetchFn });
  assert.equal(log[1].url, 'https://api.eu.nylas.com/v3/grants/g-1/drafts');
});

test('nylas: a large attachment goes as multipart, and a read-only inbox says what to do', async () => {
  const log = [];
  const big = 'data:application/pdf;base64,' + Buffer.alloc(3355443, 7).toString('base64');
  await nylas.send(
    config,
    { to: 'a@b.co', subject: 's', text: 't', attachments: [{ name: 'cv.pdf', dataUrl: big }] },
    { fetch: fake({ data: { data: { id: 'x' } } }, log) },
  );
  assert.ok(log[0].init.body instanceof FormData);
  assert.equal(JSON.parse(log[0].init.body.get('message')).subject, 's');
  assert.equal(log[0].init.body.get('file0').size, 3355443);
  const scope = fake(
    { status: 403, data: { error: { type: 'forbidden', message: 'Insufficient scopes for this request' } } },
    [],
  );
  await assert.rejects(nylas.send(config, { to: 'a@b.co', text: 't' }, { fetch: scope }), (e) => e.code === 'scope');
  await assert.rejects(nylas.saveDraft({ apiKey: 'k' }, { to: 'a@b.co', text: 't' }), (e) => e.code === 'setup');
});

test('nylas: what the grant lets it do, and replies in a thread from someone else', async () => {
  const grant = (scope) => fake({ data: { data: { id: 'g-1', provider: 'google', scope } } }, []);
  const read = ['https://www.googleapis.com/auth/gmail.readonly'];
  assert.deepEqual(await nylas.abilities(config, { fetch: grant(read) }), {
    draft: false,
    send: false,
    scopes: read,
    provider: 'google',
  });
  const compose = [...read, 'https://www.googleapis.com/auth/gmail.compose'];
  const can = await nylas.abilities(config, { fetch: grant(compose) });
  assert.deepEqual([can.draft, can.send], [true, true]);
  const sendOnly = await nylas.abilities(config, {
    fetch: grant([...read, 'https://www.googleapis.com/auth/gmail.send']),
  });
  assert.deepEqual([sendOnly.draft, sendOnly.send], [false, true]);
  const log = [];
  const list = fake(
    {
      data: {
        data: [
          { id: '1', from: [{ email: 'ada@example.org' }], subject: 'Hello', date: 1 },
          {
            id: '2',
            from: [{ name: 'Jane Smith', email: 'jane.smith@hbk.com' }],
            subject: 'Re: Hello',
            snippet: 'Thanks Ada',
            date: 2,
          },
        ],
      },
    },
    log,
  );
  const replies = await nylas.replies(config, { threadId: 't-3', after: 1763400000000, fetch: list });
  assert.deepEqual(
    replies.map((r) => r.id),
    ['2'],
  );
  const u = new URL(log[0].url);
  assert.equal(u.searchParams.get('thread_id'), 't-3');
  assert.equal(u.searchParams.get('received_after'), '1763400000');
});
