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

// Sunday 21:00 in London; the email is to arrive at 08:10 on Monday (UTC in November).
const SUNDAY = Date.UTC(2026, 10, 22, 21, 0);
const MONDAY = Date.UTC(2026, 10, 23, 8, 10);
const jane = {
  to: [{ email: 'jane.smith@hbk.com', name: 'Jane Smith' }],
  subject: 'Summer internship, HBK',
  text: 'Dear Jane,',
};

test('nylas: a follow-up names the message it answers, so it lands in the same thread (drafts too)', async () => {
  const log = [];
  const fetchFn = fake({ data: { data: { id: 'm-10', thread_id: 't-3', date: 1795421500 } } }, log);
  const follow = { ...jane, subject: 'Re: Summer internship, HBK', replyTo: ' m-9 ' };
  assert.deepEqual(await nylas.send(config, follow, { fetch: fetchFn, now: SUNDAY }), {
    id: 'm-10',
    threadId: 't-3',
    date: 1795421500,
  });
  assert.deepEqual(JSON.parse(log[0].init.body), {
    subject: 'Re: Summer internship, HBK',
    body: '<p>Dear Jane,</p>',
    to: [{ email: 'jane.smith@hbk.com', name: 'Jane Smith' }],
    attachments: [],
    reply_to_message_id: 'm-9',
  });
  // A draft takes the reply but never a send time (Nylas's Create Draft has no send_at).
  await nylas.saveDraft(config, { ...follow, sendAt: MONDAY }, { fetch: fetchFn });
  assert.equal(log[1].url, 'https://api.eu.nylas.com/v3/grants/g-1/drafts');
  assert.deepEqual(Object.keys(JSON.parse(log[1].init.body)), [
    'subject',
    'body',
    'to',
    'attachments',
    'reply_to_message_id',
  ]);
  // A first email names nothing.
  await nylas.send(config, jane, { fetch: fetchFn });
  assert.equal('reply_to_message_id' in JSON.parse(log[2].init.body), false);
});

test('nylas: a scheduled send carries send_at in seconds and gives back the schedule to undo', async () => {
  const log = [];
  // The reference's 202 is a whole message object: its id and thread are Nylas's own, never the one in Sent later.
  const fetchFn = fake(
    {
      status: 202,
      data: {
        request_id: 'r-1',
        data: {
          object: 'message',
          id: 'tmp-1',
          thread_id: 'tmp-t',
          grant_id: 'g-1',
          subject: jane.subject,
          send_at: 1795421400,
          schedule_id: 'sch-8cd5',
        },
      },
    },
    log,
  );
  assert.deepEqual(await nylas.send(config, { ...jane, sendAt: MONDAY }, { fetch: fetchFn, now: SUNDAY }), {
    id: '',
    threadId: '',
    date: 0,
    scheduleId: 'sch-8cd5',
    sendAt: MONDAY,
  });
  assert.equal(log[0].url, 'https://api.eu.nylas.com/v3/grants/g-1/messages/send');
  assert.deepEqual(JSON.parse(log[0].init.body), {
    subject: 'Summer internship, HBK',
    body: '<p>Dear Jane,</p>',
    to: [{ email: 'jane.smith@hbk.com', name: 'Jane Smith' }],
    attachments: [],
    send_at: 1795421400,
  });
  // A follow-up can wait too: a part of a second rounds up, never early.
  await nylas.send(config, { ...jane, replyTo: 'm-9', sendAt: MONDAY + 400 }, { fetch: fetchFn, now: SUNDAY });
  const second = JSON.parse(log[1].init.body);
  assert.deepEqual([second.send_at, second.reply_to_message_id], [1795421401, 'm-9']);
});

test('nylas: a send time too close or past goes now; one too far or unreadable is refused before asking', async () => {
  const log = [];
  const fetchFn = fake({ data: { data: { id: 'm-11', thread_id: 't-4', date: 1795421460 } } }, log);
  // The card was made ready on Sunday night and sent at 08:09 on Monday: Nylas wants a minute's lead, so now.
  const late = await nylas.send(config, { ...jane, sendAt: MONDAY }, { fetch: fetchFn, now: MONDAY - 60000 });
  assert.deepEqual(late, { id: 'm-11', threadId: 't-4', date: 1795421460 });
  await nylas.send(config, { ...jane, sendAt: MONDAY }, { fetch: fetchFn, now: MONDAY + 3600000 });
  await nylas.send(config, { ...jane, sendAt: null }, { fetch: fetchFn, now: SUNDAY });
  assert.equal(log.length, 3);
  assert.ok(log.every((l) => !('send_at' in JSON.parse(l.init.body))));
  const far = { ...jane, sendAt: SUNDAY + 31 * 24 * 3600000 };
  await assert.rejects(nylas.send(config, far, { fetch: fetchFn, now: SUNDAY }), (e) => e.code === 'schedule');
  await assert.rejects(
    nylas.send(config, { ...jane, sendAt: 'Monday' }, { fetch: fetchFn, now: SUNDAY }),
    (e) => e.code === 'schedule',
  );
  assert.equal(log.length, 3);
});

test('nylas: a large attachment with a send time and a thread goes as multipart, both in the message part', async () => {
  const log = [];
  const big = 'data:application/pdf;base64,' + Buffer.alloc(3355443, 7).toString('base64');
  const email = { ...jane, replyTo: 'm-9', sendAt: MONDAY, attachments: [{ name: 'cv.pdf', dataUrl: big }] };
  const r = await nylas.send(config, email, {
    fetch: fake({ status: 202, data: { data: { schedule_id: 'sch-2' } } }, log),
    now: SUNDAY,
  });
  assert.deepEqual([r.scheduleId, r.sendAt], ['sch-2', MONDAY]);
  const form = log[0].init.body;
  assert.ok(form instanceof FormData);
  assert.deepEqual(JSON.parse(form.get('message')), {
    subject: 'Summer internship, HBK',
    body: '<p>Dear Jane,</p>',
    to: [{ email: 'jane.smith@hbk.com', name: 'Jane Smith' }],
    reply_to_message_id: 'm-9',
    send_at: 1795421400,
  });
  assert.equal(form.get('file0').size, 3355443);
  assert.equal(log[0].init.headers['Content-Type'], undefined);
});

test('nylas: a schedule Nylas refuses says so in plain words', async () => {
  const refused = fake(
    {
      status: 400,
      data: { error: { type: 'invalid_request_error', message: 'send_at must be at least 1 minute in the future' } },
    },
    [],
  );
  await assert.rejects(nylas.send(config, { ...jane, sendAt: MONDAY }, { fetch: refused, now: SUNDAY }), (e) => {
    assert.equal(e.name, 'NylasError');
    assert.equal(e.code, 'schedule');
    assert.equal(e.status, 400);
    assert.match(e.message, /wouldn’t schedule this email: it sends at a time from one minute to 30 days ahead/);
    return true;
  });
  // Other refusals keep their own explanation.
  const other = fake({ status: 400, data: { error: { message: 'to: invalid address' } } }, []);
  await assert.rejects(
    nylas.send(config, jane, { fetch: other }),
    (e) => e.code === null && /invalid address/.test(e.message),
  );
});

test('nylas: Undo takes a scheduled email back, until a minute before it goes', async () => {
  const log = [];
  const ok = fake(
    { status: 202, data: { request_id: 'r-2', data: { message: 'requested cancelation for workflow' } } },
    log,
  );
  assert.deepEqual(await nylas.cancelScheduled(config, 'sch-8cd5', { fetch: ok, sendAt: MONDAY, now: SUNDAY }), {
    scheduleId: 'sch-8cd5',
    cancelled: true,
  });
  assert.equal(log[0].url, 'https://api.eu.nylas.com/v3/grants/g-1/messages/schedules/sch-8cd5');
  assert.equal(log[0].init.method, 'DELETE');
  assert.equal(log[0].init.body, undefined);
  assert.equal(log[0].init.headers.Authorization, 'Bearer nyk_x');
  await nylas.cancelScheduled(config, 'sch-8cd5', { fetch: ok, sendAt: MONDAY, now: MONDAY - 60000 });
  // Nylas's own cut-off counts when the request arrives, so 10.2 s on this clock is a race: refused without asking.
  for (const now of [MONDAY - 59000, MONDAY - 10200])
    await assert.rejects(
      nylas.cancelScheduled(config, 'sch-8cd5', { fetch: ok, sendAt: MONDAY, now }),
      (e) => e.code === 'late' && /too late to take that email back: it goes in under a minute/.test(e.message),
    );
  // The next day the card may still offer it: that one has gone.
  await assert.rejects(
    nylas.cancelScheduled(config, 'sch-8cd5', { fetch: ok, sendAt: MONDAY, now: MONDAY + 26 * 3600000 }),
    (e) => e.code === 'late' && /has gone already/.test(e.message),
  );
  await assert.rejects(nylas.cancelScheduled(config, '', { fetch: ok }), (e) => e.code === 'setup');
  await assert.rejects(nylas.cancelScheduled({ apiKey: 'k' }, 'sch-8cd5', { fetch: ok }), (e) => e.code === 'setup');
  assert.equal(log.length, 2);
  // Gone already (sent, or taken back before) is not a lost inbox; a lost inbox still says so.
  const gone = fake({ status: 404, data: { error: { type: 'not_found_error', message: 'schedule not found' } } }, []);
  await assert.rejects(nylas.cancelScheduled(config, 'sch-8cd5', { fetch: gone }), (e) => e.code === 'gone');
  const noGrant = fake({ status: 404, data: { error: { type: 'not_found_error', message: 'grant not found' } } }, []);
  await assert.rejects(nylas.cancelScheduled(config, 'sch-8cd5', { fetch: noGrant }), (e) => e.code === 'grant');
  const readOnly = fake({ status: 403, data: { error: { message: 'Insufficient scopes for this request' } } }, []);
  await assert.rejects(nylas.cancelScheduled(config, 'sch-8cd5', { fetch: readOnly }), (e) => e.code === 'scope');
});

test('nylas: a take-back Nylas refuses never reads as a refused send, which would invite a second email', async () => {
  const log = [];
  for (const message of ['schedule cannot be cancelled less than 10 seconds before send_at', 'invalid schedule id']) {
    const refused = fake({ status: 400, data: { error: { type: 'invalid_request_error', message } } }, log);
    await assert.rejects(
      nylas.cancelScheduled(config, 'sch-1', { fetch: refused, sendAt: MONDAY, now: SUNDAY }),
      (e) => {
        assert.equal(e.code, 'late');
        assert.equal(e.status, 400);
        assert.match(e.message, /couldn’t take that email back, so it may still go/);
        assert.doesNotMatch(e.message, /wouldn’t schedule|Send it now/);
        return true;
      },
    );
  }
  assert.deepEqual(
    log.map((l) => l.init.method),
    ['DELETE', 'DELETE'],
  );
  // A draft's refusal that happens to name a schedule isn't a send time Nylas turned down either.
  const draft = fake({ status: 400, data: { error: { message: 'drafts cannot be scheduled here' } } }, []);
  await assert.rejects(nylas.saveDraft(config, jane, { fetch: draft }), (e) => e.code === null);
});

test('nylas: where a scheduled email is, bare as the docs show it or wrapped in data', async () => {
  const log = [];
  const bare = fake(
    { data: { schedule_id: 'sch-1', status: { code: 'pending', description: 'schedule send awaiting send at time' } } },
    log,
  );
  assert.deepEqual(await nylas.scheduled(config, 'sch-1', { fetch: bare }), {
    scheduleId: 'sch-1',
    status: 'pending',
    description: 'schedule send awaiting send at time',
    closedAt: 0,
  });
  assert.equal(log[0].url, 'https://api.eu.nylas.com/v3/grants/g-1/messages/schedules/sch-1');
  assert.equal(log[0].init.method, 'GET');
  const wrapped = fake(
    {
      data: {
        request_id: 'r',
        data: { schedule_id: 'sch-2', status: { code: 'failed', description: 'send failed' }, close_time: 1795421401 },
      },
    },
    [],
  );
  assert.deepEqual(await nylas.scheduled(config, 'sch-2', { fetch: wrapped }), {
    scheduleId: 'sch-2',
    status: 'failed',
    description: 'send failed',
    closedAt: 1795421401000,
  });
  await assert.rejects(nylas.scheduled(config, ' ', { fetch: bare }), (e) => e.code === 'setup');
  const gone = fake({ status: 404, data: { error: { message: 'schedule not found' } } }, []);
  await assert.rejects(nylas.scheduled(config, 'sch-3', { fetch: gone }), (e) => e.code === 'gone');
});

test('nylas: the message a scheduled email became, found by recipient and exact subject once it went', async () => {
  const log = [];
  const list = fake(
    {
      data: {
        data: [
          // Its follow-up, a reply and an older email to someone else all share words of the subject.
          {
            id: 'f',
            thread_id: 't-1',
            date: 1795421900,
            subject: 'Re: Summer internship, HBK',
            from: [{ email: 'ada@example.org' }],
            to: [{ email: 'jane.smith@hbk.com' }],
          },
          {
            id: 'r',
            thread_id: 't-1',
            date: 1795421700,
            subject: 'Summer internship, HBK',
            from: [{ email: 'jane.smith@hbk.com' }],
            to: [{ email: 'ada@example.org' }],
          },
          {
            id: 'o',
            thread_id: 't-0',
            date: 1795421410,
            subject: 'Summer internship, HBK',
            from: [{ email: 'ada@example.org' }],
            to: [{ email: 'careers@hbk.com' }],
          },
          {
            id: 'm',
            thread_id: 't-1',
            date: 1795421402,
            subject: 'Summer internship, HBK',
            from: [{ email: 'Ada@Example.org' }],
            to: [{ name: 'Jane Smith', email: 'Jane.Smith@hbk.com' }],
          },
        ],
      },
    },
    log,
  );
  const found = await nylas.sentMessage(config, {
    to: 'jane.smith@hbk.com',
    subject: jane.subject,
    after: MONDAY,
    fetch: list,
  });
  assert.deepEqual(found, { id: 'm', threadId: 't-1', date: 1795421402 });
  const u = new URL(log[0].url);
  assert.equal(u.pathname, '/v3/grants/g-1/messages');
  assert.equal(u.searchParams.get('subject'), 'Summer internship, HBK');
  assert.equal(u.searchParams.get('received_after'), '1795421340');
  const none = fake({ data: { data: [] } }, []);
  assert.equal(
    await nylas.sentMessage(config, { to: 'jane.smith@hbk.com', subject: jane.subject, after: MONDAY, fetch: none }),
    null,
  );
  assert.equal(await nylas.sentMessage(config, { to: '', subject: jane.subject, fetch: none }), null);
});
