'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, installChrome } = require('./helpers');

const JTF = load();
const { store } = JTF;

test.beforeEach(() => installChrome());

// The review queue's own choices, as they start: ask for an internship, no common ground, arrive in their morning.
const QUEUE = { ask: 'internship', commonGround: false, theirMorning: true };

test('store: Discover’s AI follows Settings until a provider with a key is chosen there', async () => {
  await store.setAiKey('sk-or-1', 'openrouter');
  await store.saveAiSettings({ provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' });
  assert.deepEqual((await store.getSettings()).discoverAi, { provider: '', model: '', effort: 'quick', ...QUEUE });
  let config = await store.discoverAiConfig();
  assert.deepEqual(
    [config.source, config.effort, config.provider, config.model, config.apiKey],
    ['settings', 'quick', 'openrouter', 'deepseek/deepseek-v4.1-flash', 'sk-or-1'],
  );
  assert.deepEqual(
    { ...(await store.aiConfig()), source: 'settings', effort: 'quick' },
    config,
    'the Settings’ config',
  );

  // Claude chosen for Discover but no key for it yet: still the Settings’ provider.
  await store.saveDiscoverAi({ provider: 'anthropic', effort: 'thorough' });
  config = await store.discoverAiConfig();
  assert.deepEqual([config.source, config.provider, config.effort], ['settings', 'openrouter', 'thorough']);

  // With a key: Claude, with the model saved for it under Settings (none: '' and ai.js uses its default).
  await store.setAiKey('sk-ant-1', 'anthropic');
  config = await store.discoverAiConfig();
  assert.deepEqual(
    [config.source, config.provider, config.model, config.apiKey, config.baseUrl],
    ['discover', 'anthropic', '', 'sk-ant-1', ''],
  );
  assert.equal(config.fallback.provider, 'openrouter', 'the Settings’ stand-in rule');
  await store.saveAiSettings({ provider: 'anthropic', model: 'claude-opus-5-5' });
  await store.saveAiSettings({ provider: 'openrouter' });
  assert.equal((await store.discoverAiConfig()).model, 'claude-opus-5-5', 'the model saved for Claude');
  await store.saveDiscoverAi({ model: 'claude-haiku-5-5' });
  config = await store.discoverAiConfig();
  assert.equal(config.model, 'claude-haiku-5-5', 'its own model wins');
  assert.equal((await store.aiConfig()).provider, 'openrouter', 'Settings are left alone');

  // Another provider forgets the model chosen for the last one; '' goes back to Settings; junk is refused.
  await store.saveDiscoverAi({ provider: 'deepseek' });
  assert.deepEqual((await store.getSettings()).discoverAi, {
    provider: 'deepseek',
    model: '',
    effort: 'thorough',
    ...QUEUE,
  });
  assert.equal((await store.discoverAiConfig()).source, 'settings', 'no DeepSeek key');
  await store.saveDiscoverAi({ provider: 'mystery', effort: 'max' });
  assert.deepEqual((await store.getSettings()).discoverAi, { provider: '', model: '', effort: 'quick', ...QUEUE });
  assert.deepEqual(store.DEFAULT_SETTINGS.discoverAi, { provider: '', model: '', effort: 'quick', ...QUEUE });

  // The queue's choices are kept; junk falls back to the defaults, and common ground is on only when set to true.
  await store.saveDiscoverAi({ ask: 'project', commonGround: true, theirMorning: false });
  assert.deepEqual(
    [(await store.getSettings()).discoverAi.ask, (await store.discoverAiConfig()).effort],
    ['project', 'quick'],
  );
  assert.equal((await store.getSettings()).discoverAi.commonGround, true);
  await store.saveDiscoverAi({ ask: 'beg', commonGround: 'yes', theirMorning: 0 });
  assert.deepEqual((await store.getSettings()).discoverAi, {
    provider: '',
    model: '',
    effort: 'quick',
    ask: 'internship',
    commonGround: false,
    theirMorning: true,
  });
});

test('store: outreach records are created, merged, removed and kept to the newest 500', async () => {
  const firm = { id: 'crd:1', name: 'Quiet Capital', domain: 'quiet.example', site: 'https://quiet.example', aum: 3 };
  const first = await store.setOutreach(firm.id, {
    firm,
    status: 'drafted',
    to: 'jane@quiet.example',
    subject: 'Summer internship',
    contact: { name: 'Jane Doe', title: 'Head of Talent', email: 'jane@quiet.example', guessed: false },
  });
  assert.deepEqual(first.firm, { id: 'crd:1', name: 'Quiet Capital', domain: 'quiet.example', site: firm.site });
  assert.equal(first.at, first.updatedAt);
  const sent = await store.setOutreach(firm.id, { status: 'sent' });
  assert.equal(sent.subject, 'Summer internship', 'merged');
  assert.equal(sent.contact.name, 'Jane Doe');
  assert.ok(sent.sentAt >= first.at);
  assert.equal(sent.at, first.at, 'first saved stays');
  await store.setOutreach(firm.id, { status: 'nonsense', notes: 'Called on Monday' });
  let all = await store.getOutreach();
  assert.deepEqual([all[firm.id].status, all[firm.id].notes], ['sent', 'Called on Monday']);
  await store.setOutreach(firm.id, { status: 'none' });
  assert.deepEqual(await store.getOutreach(), {});
  await store.setOutreach('a', { firm: { id: 'a', name: 'A' } });
  await store.removeOutreach('a');
  assert.deepEqual(await store.getOutreach(), {});

  // 501 records: the one changed longest ago goes.
  const many = {};
  for (let i = 0; i < 501; i++)
    many['f' + i] = { firm: { id: 'f' + i, name: 'Firm ' + i }, status: 'sent', updatedAt: 1000 + i, at: 1 };
  await chrome.storage.local.set({ outreach: many });
  await store.setOutreach('f500', { notes: 'x' });
  all = await store.getOutreach();
  assert.equal(Object.keys(all).length, 500);
  assert.ok(!all.f0 && all.f1 && all.f500);
});

test('store: outreach travels in backups, imported only when it names its firms', async () => {
  assert.equal(await store.hasData(), false);
  await store.setOutreach('crd:2', { firm: { id: 'crd:2', name: 'Egerton Capital' }, status: 'replied' });
  assert.equal(await store.hasData(), true, 'an outreach record is worth a backup');
  assert.equal(store.backsUp('outreach'), true);
  const out = await store.exportData({ documents: false, passwords: false, history: false, keys: false });
  assert.equal(out.outreach['crd:2'].status, 'replied');
  installChrome();
  await store.importData({
    ...out,
    outreach: {
      ...out.outreach,
      bad: { firm: { name: '' }, status: 'sent' },
      worse: 'text',
      odd: { firm: { id: 'odd', name: 'Odd & Co' }, status: 'lost' },
    },
  });
  const all = await store.getOutreach();
  assert.deepEqual(Object.keys(all).sort(), ['crd:2', 'odd']);
  assert.equal(all.odd.status, 'drafted', 'an unknown status becomes drafted');
  // A backup without outreach leaves the records alone.
  await store.importData({ ...out, outreach: undefined });
  assert.equal(Object.keys(await store.getOutreach()).length, 2);
});

test('store: an imported outreach record’s times are made numbers, so the export can date it', async () => {
  const before = Date.now();
  const out = await store.exportData({ documents: false, passwords: false, history: false, keys: false });
  await store.importData({
    ...out,
    outreach: {
      undated: { firm: { id: 'undated', name: 'Undated LLP' }, status: 'sent', sentAt: 'soon' },
      texty: { firm: { id: 'texty', name: 'Texty & Co' }, updatedAt: '1767225600000', at: '2026-01-01', sentAt: 1e20 },
    },
  });
  const all = await store.getOutreach();
  const { undated, texty } = all;
  assert.ok(undated.updatedAt >= before && undated.updatedAt <= Date.now(), 'no updatedAt: imported now');
  assert.equal(undated.at, undated.updatedAt);
  assert.ok(!('sentAt' in undated), 'a sentAt that isn’t a time goes');
  assert.deepEqual([texty.updatedAt, texty.at], [1767225600000, Date.parse('2026-01-01')]);
  assert.ok(!('sentAt' in texty), 'past the dates a Date can hold');
  // What the outreach export does with each record.
  for (const rec of Object.values(all))
    assert.match(new Date(rec.sentAt || rec.updatedAt).toISOString(), /^\d{4}-\d\d-\d\d/);
  // Marked as sent later: dated then.
  assert.ok((await store.setOutreach('undated', { status: 'sent', notes: 'x' })).sentAt >= before);
});

test('store: the Discover cache keeps the lists whole and checks per firm, the newest 300', async () => {
  assert.deepEqual(await store.getDiscoverCache(), {
    trackr: null,
    hn: null,
    listed: null,
    careers: {},
    contacts: {},
    research: {},
    hooks: {},
    queue: null,
  });
  const hn = { posts: [{ id: 1 }], threads: [{ id: 9, title: 'Ask HN: Who is hiring? (November 2026)' }], at: 5 };
  const listed = { names: ['jane street'], domains: ['janestreet.com'], at: 6 };
  // Simplify's 3,000 roles aren't kept: only its names and domains are used.
  await store.setDiscoverCache({ hn, listed: { ...listed, roles: [{ company: 'Jane Street', title: 'SWE Intern' }] } });
  await store.setDiscoverCache({ contacts: { a: { at: 1, result: { status: 'found' } } } });
  await store.setDiscoverCache({ contacts: { b: { at: 2, result: { status: 'none' } } }, careers: { a: { at: 3 } } });
  let cache = await store.getDiscoverCache();
  assert.deepEqual(cache.hn, hn);
  assert.deepEqual(cache.listed, listed);
  assert.deepEqual(Object.keys(cache.contacts).sort(), ['a', 'b'], 'merged per firm');
  assert.deepEqual(Object.keys(cache.careers), ['a']);
  await store.setDiscoverCache({ research: { a: { at: 4, result: { people: [] } } } });
  assert.deepEqual((await store.getDiscoverCache()).research, { a: { at: 4, result: { people: [] } } });
  // Reasons to write are kept per firm too; the review queue is kept whole, and an empty one clears it.
  await store.setDiscoverCache({
    hooks: { a: { at: 5, result: { hooks: [] } } },
    queue: { items: [{ id: 'a' }], at: 7 },
  });
  cache = await store.getDiscoverCache();
  assert.deepEqual([cache.hooks.a.at, cache.queue], [5, { items: [{ id: 'a' }], at: 7, cleared: [], declined: {} }]);
  await store.setDiscoverCache({ queue: { items: 'junk' } });
  assert.equal((await store.getDiscoverCache()).queue, null);
  const lots = {};
  for (let i = 0; i < 305; i++) lots['x' + i] = { at: 100 + i, result: {} };
  await store.setDiscoverCache({ contacts: lots });
  cache = await store.getDiscoverCache();
  assert.equal(Object.keys(cache.contacts).length, 300);
  assert.ok(!cache.contacts.a && cache.contacts.x304, 'the oldest go');
  assert.equal(store.backsUp('discoverCache'), false);
  // A cache kept before then loses its roles when read, and so on its next write.
  await chrome.storage.local.set({ discoverCache: { listed: { ...listed, roles: [{ title: 'x' }] } } });
  assert.deepEqual((await store.getDiscoverCache()).listed, listed);
  await store.setDiscoverCache({ careers: { a: { at: 1 } } });
  assert.deepEqual((await chrome.storage.local.get('discoverCache')).discoverCache.listed, listed);
});
