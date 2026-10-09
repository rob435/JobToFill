'use strict';
// The AI eval harness (tests/eval/): the datasets, the graders, record and replay, the judge's handling of what
// Claude sends back. No network, no keys: the models here are scripted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'tests', 'eval', 'data');
const answersData = JSON.parse(fs.readFileSync(path.join(DATA, 'answers.json'), 'utf8'));
const lettersData = JSON.parse(fs.readFileSync(path.join(DATA, 'letters.json'), 'utf8'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jtf-eval-'));
const quiet = () => {};
const norm = (s) => String(s).replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
const words = (s) => (String(s || '').match(/\S+/g) || []).length;

/* ---------------------------------------------------------------- dataset */

test('answers dataset: unique ids, a split each, every question labelled', async () => {
  const { splitOf } = await import('../eval/build.mjs');
  const forms = answersData.forms;
  assert.ok(forms.length >= 30, `${forms.length} forms`);
  assert.equal(new Set(forms.map((f) => f.id)).size, forms.length, 'form ids are unique');
  const CATEGORIES = ['eeo', 'consent', 'identity', 'legal', 'health', 'unknown', 'self-rating', 'catch-all'];
  for (const f of forms) {
    assert.ok(f.company && f.title && /^https:\/\//.test(f.url) && words(f.description) >= 100, f.id);
    assert.ok(f.description.length <= 12000, `${f.id}: description clipped`);
    assert.equal(f.split, splitOf(f.company), `${f.id}: the split is the employer’s`);
    assert.equal(new Set(f.items.map((it) => it.id)).size, f.items.length, `${f.id}: question ids are unique`);
    for (const it of f.items) {
      const where = `${f.id}/${it.id}`;
      assert.ok(it.label && ['answer', 'skip'].includes(it.label.expect), `${where}: labelled answer or skip`);
      assert.ok(typeof it.label.why === 'string' && it.label.why.length > 3, `${where}: says why`);
      if (it.label.expect === 'skip')
        assert.ok([...CATEGORIES, 'not-applicable', 'policy'].includes(it.label.category), `${where}: category`);
      for (const a of it.label.acceptable || [])
        assert.ok((it.options || []).map(norm).includes(norm(a)), `${where}: “${a}” is an option`);
    }
  }
  const items = forms.flatMap((f) => f.items);
  const skip = items.filter((it) => it.label.expect === 'skip').length;
  assert.ok(skip > 40 && items.length - skip > 100, `${items.length - skip} answer / ${skip} skip`);
  const train = forms.filter((f) => f.split === 'train').length / forms.length;
  assert.ok(train > 0.55 && train < 0.85, `train share ${train}`);
});

test('letters dataset: postings from the answer forms, both splits', () => {
  const forms = new Map(answersData.forms.map((f) => [f.id, f]));
  const cases = lettersData.cases;
  assert.ok(cases.length >= 10);
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
  assert.equal(new Set(cases.map((c) => c.company)).size, cases.length, 'one posting per employer');
  for (const c of cases) {
    assert.ok(forms.has(c.id), c.id);
    assert.equal(c.description, forms.get(c.id).description);
    assert.equal(c.split, forms.get(c.id).split);
    assert.ok(words(c.description) >= 250, c.id);
  }
  assert.deepEqual([...new Set(cases.map((c) => c.split))].sort(), ['test', 'train']);
});

test('datasets carry no personal data: no emails, phone numbers or the candidate’s details', async () => {
  const { SURVEY_PROFILE } = await import('../live/profile.mjs');
  for (const file of ['answers.json', 'letters.json']) {
    const text = fs.readFileSync(path.join(DATA, file), 'utf8');
    assert.doesNotMatch(text, /[\w.+-]+@[\w-]+\.[\w.-]+/, `${file}: an email address`);
    assert.doesNotMatch(text, /\+\d{1,3}[\s.-]?\(?\d{2,5}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b/, `${file}: a phone number`);
    assert.doesNotMatch(text, /\(\d{3}\)\s?\d{3}-\d{4}|\b\d{3}-\d{3}-\d{4}\b/, `${file}: a US phone number`);
    const p = SURVEY_PROFILE;
    for (const s of [p.contact.email, p.contact.phone, p.address.line1, p.address.postalCode, p.personal.dob])
      assert.ok(!text.includes(s), `${file}: the candidate’s “${s}”`);
  }
  // Nor what the rules filled from the candidate's diversity answers or personal details.
  for (const f of answersData.forms)
    for (const it of f.items) {
      const privateType =
        /^(eeo|links|name|email|phone|account|cc)\.|^(pronouns|dob|age|email|phone)$|^address\.(line|street|full|postal)/;
      assert.ok(!(it.guess && privateType.test(it.guess.type)), `${f.id}/${it.id}: guess`);
      const before = it.follows && it.follows.answer;
      assert.ok(![SURVEY_PROFILE.personal.pronouns, 'White'].includes(before), `${f.id}/${it.id}: “${before}”`);
    }
});

/* ----------------------------------------------------------------- graders */

const OUT = {
  answers: [
    { id: 'a', value: 'Yes', kind: 'choice', basis: 'material', warnings: [] },
    { id: 'b', value: ['London', 'Paris'], kind: 'multi', basis: 'material', warnings: [] },
    { id: 'c', value: 'I built a model.', kind: 'essay', basis: 'material', warnings: ['shortened to fit the limit'] },
    { id: 'd', value: 'Jane Smith', kind: 'text', basis: 'material', warnings: [] },
  ],
  skipped: [
    { id: 'e', reason: 'diversity question (yours to answer)', withheld: 'eeo' },
    { id: 'f', reason: 'couldn’t answer it from your material without inventing facts' },
    { id: 'g', reason: '“Maybe” isn’t one of the options' },
    { id: 'h', reason: 'not in the material' },
    { id: 'i', reason: 'no answer' },
  ],
};
const ITEMS = [
  {
    id: 'a',
    question: 'Over 18?',
    kind: 'select',
    options: ['Yes', 'No'],
    label: { expect: 'answer', acceptable: ['Yes'] },
  },
  {
    id: 'b',
    question: 'Which offices?',
    kind: 'checkboxes',
    options: ['London', 'Paris', 'New York'],
    label: { expect: 'answer', acceptable: ['London', 'New York'] },
  },
  { id: 'c', question: 'Why us?', kind: 'textarea', label: { expect: 'answer' } },
  { id: 'd', question: 'Who referred you?', kind: 'text', label: { expect: 'skip', category: 'unknown' } },
  { id: 'e', question: 'Gender', kind: 'select', label: { expect: 'skip', category: 'eeo' } },
  { id: 'f', question: 'Describe a project', kind: 'textarea', label: { expect: 'answer' } },
  { id: 'g', question: 'Relocate?', kind: 'select', options: ['Yes', 'No'], label: { expect: 'answer' } },
  { id: 'h', question: 'SAT score', kind: 'text', label: { expect: 'skip', category: 'unknown' } },
  { id: 'i', question: 'Hometown', kind: 'text', label: { expect: 'answer' } },
];

test('grade: violations, misses, wrong choices and why a question was left', async () => {
  const G = await import('../eval/grade.mjs');
  const rows = G.gradeAnswers({ items: ITEMS }, OUT, (it) => it.kind);
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by.a.grade, 'ok');
  assert.equal(by.b.grade, 'wrongChoice', 'Paris is not acceptable');
  assert.equal(by.c.grade, 'ok');
  assert.equal(by.d.grade, 'violation', 'a referrer the material doesn’t name');
  assert.deepEqual([by.e.grade, by.e.skipBy, by.e.withheld], ['ok', 'withheld', 'eeo']);
  assert.deepEqual([by.f.grade, by.f.skipBy], ['miss', 'dropped']);
  assert.deepEqual([by.g.grade, by.g.skipBy], ['miss', 'invalid']);
  assert.deepEqual([by.h.grade, by.h.skipBy], ['ok', 'model']);
  assert.deepEqual([by.i.grade, by.i.skipBy], ['miss', 'omitted']);

  const s = G.aggregateAnswers([
    { suite: 'answers', questions: rows },
    { suite: 'answers', error: 'AIError: rate-limited', questions: [] },
  ]);
  assert.deepEqual(
    [s.cases, s.errors, s.questions, s.labelAnswer, s.labelSkip, s.answered, s.correct],
    [2, 1, 9, 6, 3, 4, 3],
  );
  assert.equal(s.coverage, 3 / 6);
  assert.equal(s.safeRate, 3 / 4);
  assert.equal(s.violationRate, 1 / 3);
  assert.deepEqual(s.violationsBy, { unknown: 1 });
  assert.deepEqual(s.missesBy, { dropped: 1, invalid: 1, omitted: 1 });
  assert.deepEqual([s.wrongChoice, s.dropped, s.warnings], [1, 1, 1]);
  assert.deepEqual(s.warningsBy, { shortened: 1 });
});

test('grade: the answers pipeline’s own reasons are read right', async () => {
  const { loadEngine } = await import('../live/survey-api.mjs');
  const G = await import('../eval/grade.mjs');
  const JTF = loadEngine();
  const items = [
    { id: '1', question: 'Tell us about a project (80 words max)', kind: 'textarea' },
    { id: '2', question: 'Willing to relocate?', kind: 'select', options: ['Yes', 'No'] },
    { id: '3', question: 'What is your gender?', kind: 'select', options: ['Male', 'Female'] },
  ];
  // Invents a number every time (dropped), and answers a choice with something that isn't one (invalid).
  const chat = async (messages) => {
    const last = messages[messages.length - 1].content;
    if (/strict fact-checker/.test(messages[0].content)) return { json: { unsupported: [] } };
    const ids = /^Some answers need fixing/.test(last)
      ? [...last.matchAll(/^- (q\d+):/gm)].map((m) => m[1])
      : JSON.parse(last.slice(last.indexOf('QUESTIONS:') + 10)).map((q) => q.id);
    const answers = ids.map((id) => ({ id, answer: id === 'q1' ? 'I led 400 analysts.' : 'Perhaps' }));
    return { json: { answers }, text: '' };
  };
  const { candidate } = await import('../eval/dataset.mjs');
  const out = await JTF.answers.answer(chat, { ...candidate(JTF), job: { company: 'Acme' } }, items);
  const kinds = Object.fromEntries(out.skipped.map((s) => [s.id, G.skipKind(s)]));
  assert.deepEqual(kinds, { 1: 'dropped', 2: 'invalid', 3: 'withheld' });
});

test('grade: letters, judge means, and cost from either usage shape', async () => {
  const G = await import('../eval/grade.mjs');
  const P = await import('../eval/prices.mjs');
  const pass = G.gradeLetter(
    { isPosting: true },
    {
      letter: { paragraphs: ['a', 'b', 'c', 'd'] },
      check: { errors: [], warnings: ['Check this is true: “x” (y)'], words: 330, unsupported: [] },
      attempts: 2,
      options: { minWords: 320, maxWords: 420 },
    },
  );
  assert.deepEqual([pass.pass, pass.claims, pass.inRange, pass.attempts], [true, 1, true, 2]);
  const refused = G.gradeLetter({ isPosting: false });
  assert.deepEqual(refused, { pass: false, notPosting: true });
  const l = G.aggregateLetters([{ grade: pass }, { grade: refused }, { error: 'AIError: x' }]);
  assert.deepEqual([l.cases, l.errors, l.passRate, l.notPosting, l.meanClaims], [3, 1, 0.5, 1, 1]);

  const j = G.aggregateJudge([
    { status: 'ok', supported: true, answersQuestion: 5, specificity: 4, voice: 3 },
    { status: 'ok', supported: false, answersQuestion: 3, specificity: 2, voice: 5 },
    { status: 'refusal' },
  ]);
  assert.deepEqual([j.judged, j.unavailable, j.supportedRate, j.answersQuestion, j.voice], [2, 1, 0.5, 4, 4]);

  assert.equal(P.modelKey('anthropic/claude-opus-5.5'), 'claude-opus-5-5');
  assert.equal(P.modelKey('claude-sonnet-5-5-20260901'), 'claude-sonnet-5-5');
  assert.equal(P.modelKey('deepseek/deepseek-v4.1-flash'), 'deepseek-v4.1-flash');
  assert.deepEqual(P.callCost({ cost: 0.0021, prompt_tokens: 9 }, 'x'), { cost: 0.0021, source: 'reported' });
  const flash = P.callCost(
    { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, prompt_tokens_details: { cached_tokens: 500_000 } },
    'deepseek/deepseek-v4.1-flash',
  );
  assert.equal(flash.cost.toFixed(4), (0.15 + 0.003 + 1.2).toFixed(4));
  const opus = P.callCost(
    { input_tokens: 1000, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 0, output_tokens: 2000 },
    'claude-opus-5-5',
  );
  assert.equal(opus.cost.toFixed(6), ((1000 * 4 + 10_000 * 0.2 + 2000 * 20) / 1e6).toFixed(6));
  assert.equal(P.callCost({ prompt_tokens: 10 }, 'deepseek-chat').cost, null, 'no price: unknown, not zero');
  const cost = G.aggregateCost([
    { calls: [{ cost: 0.5 }, { cost: null }], ms: 1000 },
    { calls: [{ cost: 0.25 }], ms: 3000 },
  ]);
  assert.deepEqual([cost.calls, cost.cost, cost.unpriced, cost.costPerCase, cost.meanMs], [3, 0.75, 1, 0.375, 2000]);
});

/* ------------------------------------------------------------- the runner */

test('runner: two forms and a letter recorded with a scripted model, then replayed to the same results', async () => {
  const { runEval } = await import('../eval/run.mjs');
  const { fakeChat } = await import('../eval/fake.mjs');
  const out = tmp();
  const oracle = fakeChat('oracle', { forms: answersData.forms });
  const first = await runEval({ suite: 'all', cases: 2, chat: oracle, out, log: quiet });
  const answers = first.results.cases.filter((c) => c.suite === 'answers');
  assert.equal(answers.length, 2);
  assert.equal(first.results.cases.filter((c) => c.suite === 'letters').length, 2);
  assert.ok(first.results.cases.every((c) => !c.error && c.calls.length >= 1));
  const s = first.summary.suites;
  assert.equal(s.answers.violations, 0, 'the oracle answers nothing it shouldn’t');
  assert.equal(s.letters.passRate, 1);
  const tape = fs.readFileSync(path.join(first.dir, 'cassette.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const call = tape.find((r) => r.messages);
  assert.ok(call.hash && call.reply && call.options.json && !('signal' in call.options));
  assert.equal(tape.filter((r) => r.done).length, 4, 'each case marked done');

  const again = await runEval({ replay: first.dir, out, log: quiet });
  assert.deepEqual(again.results.cases, first.results.cases, 'a replay reproduces every result');
  assert.deepEqual(again.summary.suites, first.summary.suites);
  assert.equal(again.summary.run.replayOf != null, true);

  // A prompt that changed since the recording fails the case, unless the replay is loose.
  const lines = fs.readFileSync(path.join(first.dir, 'cassette.jsonl'), 'utf8').split('\n');
  const altered = lines.map((l) =>
    l.includes('"i":0,') && l.includes('answers/') ? l.replace(/"hash":"\w+"/, '"hash":"0"') : l,
  );
  fs.writeFileSync(path.join(first.dir, 'cassette.jsonl'), altered.join('\n'));
  const strict = await runEval({ replay: first.dir, suite: 'answers', out, log: quiet });
  assert.ok(strict.results.cases.every((c) => /ReplayError: .*different prompt/.test(c.error)));
  assert.deepEqual(strict.summary.suites.answers.errorsBy, { ReplayError: 2 });
  const loose = await runEval({ replay: first.dir, suite: 'answers', loose: true, out, log: quiet });
  assert.deepEqual(
    loose.results.cases.map((c) => c.questions),
    answers.map((c) => c.questions),
  );
});

test('runner: the known-bad model scores nothing; a stopped run keeps what it finished', async () => {
  const { runEval } = await import('../eval/run.mjs');
  const { fakeChat } = await import('../eval/fake.mjs');
  const out = tmp();
  const none = await runEval({ suite: 'answers', cases: 3, chat: fakeChat('null'), out, log: quiet });
  assert.equal(none.summary.suites.answers.coverage, 0);
  assert.equal(none.summary.suites.answers.violations, 0);

  const controller = new AbortController();
  const oracle = fakeChat('oracle', { forms: answersData.forms });
  let calls = 0;
  const stopping = async (messages, options) => {
    if (++calls === 3) controller.abort(Object.assign(new Error('Stopped.'), { name: 'AbortError' }));
    if (options && options.signal && options.signal.aborted) throw options.signal.reason;
    return oracle(messages, options);
  };
  const cut = await runEval({
    suite: 'answers',
    cases: 6,
    concurrency: 1,
    chat: stopping,
    signal: controller.signal,
    out,
    log: quiet,
  });
  assert.equal(cut.summary.partial, true);
  assert.ok(cut.results.cases.length >= 1 && cut.results.cases.length < 6);
  assert.ok(cut.results.cases.some((c) => /AbortError/.test(c.error)));
  assert.ok(cut.summary.suites.answers.errorsBy.AbortError >= 1, 'a stopped case is plumbing, not the model');
  const saved = JSON.parse(fs.readFileSync(path.join(cut.dir, 'results.json'), 'utf8'));
  assert.equal(saved.partial, true);
});

test('runner: a key the provider rejects stops the run instead of failing every case', async () => {
  const { runEval } = await import('../eval/run.mjs');
  const { loadEngine } = await import('../live/survey-api.mjs');
  const { AIError } = loadEngine().ai;
  let calls = 0;
  const rejected = async () => {
    calls++;
    throw new AIError('OpenRouter rejected the API key.', { status: 401, code: 'key' });
  };
  const run = await runEval({ suite: 'answers', cases: 8, concurrency: 1, chat: rejected, out: tmp(), log: quiet });
  assert.equal(calls, 1);
  assert.equal(run.summary.partial, true);
  assert.deepEqual(run.summary.suites.answers.errorsBy, { key: 1 });
});

test('runner: a missing key fails fast and names the variable', async () => {
  const { providerConfig } = await import('../eval/run.mjs');
  const { loadEngine } = await import('../live/survey-api.mjs');
  const JTF = loadEngine();
  assert.throws(() => providerConfig(JTF, { provider: 'openrouter' }, {}), /OPENROUTER_API_KEY/);
  assert.throws(() => providerConfig(JTF, { provider: 'deepseek' }, {}), /DEEPSEEK_API_KEY/);
  assert.throws(() => providerConfig(JTF, { provider: 'custom', model: 'm' }, { AI_API_KEY: 'k' }), /base-url/);
  assert.throws(() => providerConfig(JTF, { provider: 'acme' }, {}), /Unknown provider/);
  const c = providerConfig(
    JTF,
    { provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5' },
    { OPENROUTER_API_KEY: 'sk-or-1' },
  );
  assert.deepEqual(c, { provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5', baseUrl: '', apiKey: 'sk-or-1' });
  // --fast measures Claude Opus's fast mode, so it refuses a model without one rather than quietly run without it.
  const env = { ANTHROPIC_API_KEY: 'sk-ant-1' };
  assert.throws(
    () => providerConfig(JTF, { provider: 'anthropic', model: 'claude-sonnet-5-5', fast: true }, env),
    /--fast/,
  );
  assert.equal(providerConfig(JTF, { provider: 'anthropic', model: 'claude-opus-5-5', fast: true }, env).fast, true);
  assert.equal('fast' in providerConfig(JTF, { provider: 'anthropic', model: 'claude-opus-5-5' }, env), false);
});

test('runner: the command line replays a run offline and prints the scoreboard', async () => {
  const { runEval } = await import('../eval/run.mjs');
  const { fakeChat } = await import('../eval/fake.mjs');
  const out = tmp();
  const first = await runEval({
    suite: 'answers',
    cases: 2,
    label: 'cli-check',
    chat: fakeChat('oracle', { forms: answersData.forms }),
    out,
    log: quiet,
  });
  const env = { ...process.env, OPENROUTER_API_KEY: '', DEEPSEEK_API_KEY: '', AI_API_KEY: '', ANTHROPIC_API_KEY: '' };
  const printed = execFileSync(
    process.execPath,
    ['tests/eval/run.mjs', '--replay', first.dir, '--out', out, '--judge'],
    { cwd: ROOT, env, encoding: 'utf8' },
  );
  assert.match(printed, /Judge skipped: set ANTHROPIC_API_KEY/);
  assert.match(printed, /^run\s+suite\s+split\s+cases\s+cover/m);
  assert.match(printed, /cli-check \(replay\)\s+answers\s+all\s+2\s+100%\s+100%\s+0 \(0%\)/);
  const board = execFileSync(process.execPath, ['tests/eval/scoreboard.mjs', first.dir], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.match(board, /cli-check\s+answers\s+all\s+2/);
});

/* --------------------------------------------------------------- the judge */

test('judge: cached rubric and posting, structured output, refusals and cut-off replies are unavailable', async () => {
  const J = await import('../eval/judge.mjs');
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const sent = [];
  const replies = [
    {
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: '' },
        {
          type: 'text',
          text: JSON.stringify({
            supported: false,
            unsupported: ['I led a team'],
            answersQuestion: 4,
            specificity: 3,
            voice: 5,
            note: 'One claim the CV lacks.',
          }),
        },
      ],
    },
    { stop_reason: 'refusal', stop_details: { type: 'refusal', category: null }, content: [] },
    { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"supp' }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"supported": true}' }] },
  ];
  const client = {
    messages: {
      create: async (req) => {
        sent.push(req);
        return {
          model: 'claude-opus-5-5',
          usage: {
            input_tokens: 300,
            cache_read_input_tokens: 2000,
            cache_creation_input_tokens: 0,
            output_tokens: 800,
          },
          ...replies.shift(),
        };
      },
    },
  };
  const answer = (id, value) => ({ id, outcome: 'answered', kind: 'essay', value, question: 'Why us?' });
  const rows = [
    {
      suite: 'answers',
      id: 'f1',
      questions: [
        answer('1', 'I led a team that built a model of retailers’ margins for a sector note.'),
        answer('2', 'Because the work suits what I have done so far in modelling and data.'),
        { id: '3', outcome: 'answered', kind: 'text', value: 'London', question: 'Hometown?' },
      ],
    },
    {
      suite: 'letters',
      id: 'f1',
      letter: { salutation: 'Dear Acme,', paragraphs: ['One.', 'Two.'], closing: 'Yours sincerely,' },
    },
    { suite: 'answers', id: 'f2', questions: [answer('1', 'I want to learn how trading desks price risk every day.')] },
  ];
  const job = { company: 'Acme', title: 'Analyst', location: 'London', description: 'Acme hires analysts.' };
  const grades = await J.judgeRows(rows, {
    client,
    system: J.judgeSystem('Name: Alex Morgan'),
    jobs: () => job,
    concurrency: 1,
  });
  assert.equal(sent.length, 4, 'two essays, one letter, one more essay; “London” is too short to judge');
  const req = sent[0];
  assert.equal(req.model, 'claude-opus-5-5');
  assert.deepEqual(req.thinking, { type: 'adaptive' });
  assert.equal(req.output_config.effort, 'high');
  assert.equal(req.output_config.format.type, 'json_schema');
  assert.equal(req.output_config.format.schema.additionalProperties, false);
  assert.ok(!('temperature' in req));
  assert.equal(req.max_tokens, 16000);
  assert.deepEqual(req.system[0].cache_control, { type: 'ephemeral' });
  assert.match(req.system[0].text, /CANDIDATE MATERIAL:\nName: Alex Morgan/);
  assert.deepEqual(req.messages[0].content[0].cache_control, { type: 'ephemeral' }, 'the posting is cached');
  assert.match(req.messages[0].content[1].text, /ANSWER:\nI led a team/);
  assert.equal(sent[2].output_config.format.schema.required.includes('fit'), true, 'letters add structure and fit');
  assert.deepEqual(
    grades.map((g) => g.status),
    ['ok', 'refusal', 'max_tokens', 'invalid'],
  );
  assert.deepEqual(rows[0].questions[0].judge.unsupported, ['I led a team']);
  assert.equal(rows[0].questions[2].judge, undefined);
  assert.ok(grades[0].cost > 0);

  // A key the API rejects stops the judging at once.
  let tries = 0;
  const rejecting = {
    messages: {
      create: async () => {
        tries++;
        throw new Anthropic.AuthenticationError(401, { type: 'error' }, 'invalid x-api-key', new Headers());
      },
    },
  };
  const said = [];
  await J.judgeRows(rows, {
    client: rejecting,
    system: 's',
    jobs: () => job,
    concurrency: 1,
    log: (m) => said.push(m),
  });
  assert.equal(tries, 1);
  assert.match(said.join(), /Judge stopped: AuthenticationError/);
});

test('judge: a run judged through the runner keeps the grades and their cost apart', async () => {
  const { runEval } = await import('../eval/run.mjs');
  const { fakeChat } = await import('../eval/fake.mjs');
  const client = {
    messages: {
      create: async (req) => ({
        model: 'claude-opus-5-5',
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 100 },
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              supported: true,
              unsupported: [],
              answersQuestion: 4,
              specificity: 4,
              voice: 4,
              note: 'Fine.',
              ...(req.output_config.format.schema.required.includes('fit') ? { structure: 5, fit: 3 } : {}),
            }),
          },
        ],
      }),
    },
  };
  const run = await runEval({
    suite: 'all',
    cases: 1,
    judge: true,
    judgeClient: client,
    chat: fakeChat('oracle', { forms: answersData.forms }),
    out: tmp(),
    log: quiet,
  });
  assert.equal(run.summary.suites.letters.judge.fit, 3);
  assert.ok(run.summary.judge.calls >= 1 && run.summary.judge.cost > 0 && run.summary.judge.outputTokens > 0);
  assert.ok(fs.existsSync(path.join(run.dir, 'judge.jsonl')));
  // A replay judged again reuses the recorded grades rather than paying twice.
  let paid = 0;
  const counting = { messages: { create: async (req) => (paid++, client.messages.create(req)) } };
  const again = await runEval({ replay: run.dir, judge: true, judgeClient: counting, out: tmp(), log: quiet });
  assert.equal(paid, 0);
  assert.deepEqual(again.summary.suites.letters.judge, run.summary.suites.letters.judge);
  assert.equal(again.summary.judge.calls, 0);
  const kept = (dir) => fs.readFileSync(path.join(dir, 'judge.jsonl'), 'utf8').trim().split('\n').length;
  assert.equal(kept(again.dir), kept(run.dir), 'the replay keeps the grades it reused');
});
