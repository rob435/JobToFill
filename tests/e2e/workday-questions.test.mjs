// End-to-end: Lloyds Banking Group's application questions on Workday (workday-questions.html, with
// workday-widgets.js: the live form's own legends, options and conditional questions, read on 14 November 2026): every
// question a rich-text <legend> over a Select whose button says only " Select One Required", its options there only
// while its menu is open. Each is asked by the line of its legend that asks ("Country of
// Study" under a note, "I have read and understood" under four paragraphs), a list its words don't settle is opened
// once and looked at again with its options (a grade list is your class), what the rules can't answer goes to the AI
// under its own question, with its options, and an answer never lands in another question's dropdown.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PROFILE, launch, until } from './harness.mjs';

// A second-year student in Glasgow who has never worked for or applied to the bank.
const STUDENT = {
  ...PROFILE,
  personal: { firstName: 'Robin', lastName: 'Li', nationality: 'British', dob: '2006-03-14', pronouns: '' },
  contact: { email: 'robin@example.com', phoneCountryCode: '+44', phone: '07386 526574', phoneType: 'Mobile' },
  address: {
    line1: '10 University Avenue',
    line2: '',
    city: 'Glasgow',
    state: 'Glasgow City',
    postalCode: 'G12 8QQ',
    country: 'United Kingdom',
    organization: '',
  },
  job: { ...PROFILE.job, authorized: 'Yes', sponsorship: 'No', adjustments: 'No' },
  compliance: { previouslyEmployed: 'No', previouslyApplied: 'No', regulatory: 'No', criminal: 'No' },
  education: [
    {
      school: 'University of Glasgow',
      degree: 'BSc',
      field: 'Computing Science',
      gpa: '',
      classification: '2:1',
      location: 'Glasgow, Scotland',
      startDate: '2025-09',
      endDate: '2028-06',
    },
  ],
  experience: [],
  customAnswers: [],
};

/**
 * An OpenAI-compatible endpoint standing in for the model: it answers each question by its own words, as someone with
 * nothing to declare, and records what it was sent.
 */
function mockAi() {
  const calls = [];
  // Questions the model declines, when set (a RegExp on the question).
  const mood = { decline: null };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = JSON.parse(body || '{}');
      const system = (json.messages && json.messages[0] && json.messages[0].content) || '';
      const last = json.messages.at(-1).content;
      let reply = { unsupported: [] };
      if (/answer job application form questions/.test(system) && last.includes('QUESTIONS:')) {
        const questions = JSON.parse(last.slice(last.indexOf('QUESTIONS:') + 'QUESTIONS:'.length));
        calls.push(...questions);
        reply = {
          answers: questions.map((q) => {
            if (mood.decline && mood.decline.test(q.question))
              return { id: q.id, skip: true, reason: 'not in the material' };
            if (/passport or national identity card/i.test(q.question)) return { id: q.id, answer: 'Yes' };
            if (/dismissed|bankruptcy|County Court|business interests/i.test(q.question))
              return { id: q.id, answer: 'No', basis: 'inferred' };
            return { id: q.id, skip: true, reason: 'not in the material' };
          }),
        };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'mock',
          choices: [{ message: { content: JSON.stringify(reply) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.0001 },
        }),
      );
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, mood })));
}

let h;
let ai;

before(async () => {
  h = await launch();
  ai = await mockAi();
  await h.setProfile(STUDENT);
});

after(async () => {
  await h.close();
  ai.server.close();
});

const state = (page) => page.$eval('#state', (el) => JSON.parse(el.textContent));
const menusOpen = (page) => page.$$eval('.wd-menu', (els) => els.length);
const settled = async (page) => {
  await until(
    (fn) => page.evaluate(fn),
    () => !document.querySelector('.wd-menu'),
  );
  return state(page);
};

// What the profile answers on the first step, by the rules alone.
const BY_RULES = {
  employed: 'No',
  // Where the degree is, as the list puts it; the class, as the list writes it.
  country: 'Within UK',
  degreeType: 'Bachelor Degree',
  subject: 'Computer Science / Software Engineering',
  grade: '2.1',
  gradeStatus: 'Expected',
  onTrack: 'Yes',
  // A list of the qualifications, ending in a "No" of its own.
  postgraduate: 'No',
  applied: 'No',
  programme: 'No',
  rightToWork: 'Yes',
  // Drawn once the right to work is a Yes.
  basis: 'British/Irish citizen',
  disciplinary: 'No',
  careerBreak: 'No',
  redundant: 'No',
  age: 'Under 21 years',
};
// What is left for the AI: legal and vetting questions, and the two nothing in a profile answers.
const FOR_AI = { passport: 'Yes', dismissed: 'No', bankruptcy: 'No', ccj: 'No', ccjFour: 'No', interests: 'No' };

test('each dropdown is asked by its legend, and a list its words don’t settle is read once', async () => {
  const page = await h.open('workday-questions.html');
  const r = await h.fill(page);
  assert.equal(r.error, undefined);
  const s = await settled(page);
  for (const [name, want] of Object.entries(BY_RULES)) assert.equal(s.chosen[name], want, name);
  // "Full degree title" is drawn once the degree type is chosen, and filled in the same go.
  assert.match(s.chosen.title, /Computing Science/);
  // Whether you need sponsoring is only asked after a No to the right to work.
  assert.equal('sponsorship' in s.opened, false);
  // Nothing was guessed: what the profile doesn't answer is still on "Select One".
  for (const name of [...Object.keys(FOR_AI), 'occupation']) assert.equal(s.chosen[name], undefined, name);
  // "County Court Judgements" is no county, and the questions before the asked line (a paragraph on sponsorship) are
  // not what is answered.
  assert.equal(s.chosen.ccjFour, undefined);
  // No menu was opened more than twice (once to read, once to pick), every one is closed again, and the step's own
  // "Save and Continue" was never pressed.
  for (const [name, n] of Object.entries(s.opened)) assert.ok(n <= 2, `${name} opened ${n} times`);
  assert.equal(await menusOpen(page), 0);
  assert.equal(s.continued, 0);

  // Fill pressed again: the lists read before are not opened to be read a second time.
  const again = await h.fill(page);
  assert.equal(again.error, undefined);
  assert.equal(again.filled, 0, JSON.stringify(again));
  assert.deepEqual((await settled(page)).opened, s.opened);

  // The page map names every question by what it asks.
  const map = await h.handler('jtf:pagemap', page, { values: 'redacted' });
  assert.equal(map.error, undefined);
  assert.doesNotMatch(map.text, /"Select One Required"|"No Required"/);
  assert.match(map.text, /"Country of Study"/);
  assert.match(map.text, /"Do you have four or more County Court Judgements or judgment debts\?"/);
  await page.close();
});

test('what the rules leave goes to the AI under its own question, with its options, and lands in its own dropdown', async () => {
  await h.bg(async (base) => {
    const { store } = globalThis.JTF;
    await store.saveSettings({
      ai: { provider: 'custom', baseUrl: base, model: 'mock' },
      aiSensitive: { legal: true },
    });
    await store.setAiKey('test-key');
  }, `http://127.0.0.1:${ai.server.address().port}/v1`);
  const page = await h.open('workday-questions.html');
  const r = await h.bg((id) => globalThis.JTFBackground.fillTab(id, { waitAi: true }), await h.tabId(page));
  assert.equal(r.error, undefined);
  assert.equal(r.ai.status, 'done', JSON.stringify(r.ai));
  const s = await settled(page);
  for (const [name, want] of Object.entries({ ...BY_RULES, ...FOR_AI })) assert.equal(s.chosen[name], want, name);

  // The model saw each question in its own words, with its options and the rest of its legend, never a dropdown's
  // prompt; and nothing the rules answer.
  const asked = ai.calls.map((q) => q.question);
  assert.ok(!asked.some((q) => /select one/i.test(q)), asked.join(' | '));
  assert.ok(!asked.some((q) => /Country of Study|legal right to work|basis on which/i.test(q)), asked.join(' | '));
  const ccj = ai.calls.find((q) => /four or more County Court/.test(q.question));
  assert.deepEqual(ccj.options, ['Yes', 'No']);
  assert.equal(ccj.profileValue, undefined, 'no county is offered as its answer');
  const bankruptcy = ai.calls.find((q) => /bankruptcy/.test(q.question));
  assert.match(bankruptcy.question, /^We need to know a little bit about your credit history\. Do you have/);
  // A question is linked only to the one that really stands before it.
  const passport = ai.calls.find((q) => /passport/.test(q.question));
  const dismissed = ai.calls.find((q) => /dismissed/.test(q.question));
  assert.equal(dismissed.follows.id, passport.id);
  assert.equal(await menusOpen(page), 0);
  assert.equal(s.continued, 0);

  // Filled again (the same application): the saved answers go back to their own questions, the model isn't asked.
  const before = ai.calls.length;
  await page.reload();
  const again = await h.bg((id) => globalThis.JTFBackground.fillTab(id, { waitAi: true }), await h.tabId(page));
  assert.equal(again.error, undefined);
  const s2 = await settled(page);
  for (const [name, want] of Object.entries({ ...BY_RULES, ...FOR_AI })) assert.equal(s2.chosen[name], want, name);
  assert.equal(ai.calls.length, before, 'nothing was asked twice');
  await page.close();
});

test('“I have read and understood” is the acknowledgement, the adjustment questions the profile’s to answer', async () => {
  await h.setSettings({ aiSensitive: { legal: false } });
  const sent = ai.calls.length;
  const page = await h.open('workday-questions.html?step=2');
  const r = await h.bg((id) => globalThis.JTFBackground.fillTab(id, { waitAi: true }), await h.tabId(page));
  assert.equal(r.error, undefined);
  let s = await settled(page);
  // No extra time is needed, as the profile says: both 25% questions, and the required one that ends "…in order to
  // request adjustments for the recruitment process" (Yes there asks for a call about adjustments).
  assert.equal(s.chosen.adjustOnline, 'No');
  assert.equal(s.chosen.adjustInsight, 'No');
  assert.equal(s.chosen.neurodiversity, 'No');
  // The acknowledgements are left until the person lets them be ticked: three "I have read and understood" (one
  // after "What do we mean by disability?" and its answer) and "Are you happy to submit your application?".
  for (const name of ['understoodAdjustments', 'understoodHub', 'understoodDcs', 'happy'])
    assert.equal(s.chosen[name], undefined, name);
  assert.equal(r.consents, 4);
  // A second email address and phone number are yours to give; whether you count yourself disabled is never guessed.
  assert.equal(s.chosen.secondaryEmail, undefined);
  assert.equal(s.chosen.secondaryPhone, undefined);
  assert.equal(s.chosen.dcs, undefined);
  // Declarations, health and diversity questions never reach the model, nor a second address.
  assert.equal(ai.calls.length, sent, JSON.stringify(ai.calls.slice(sent)));

  await h.setSettings({ consents: true });
  const again = await h.fill(page);
  assert.equal(again.error, undefined);
  s = await settled(page);
  for (const name of ['understoodAdjustments', 'understoodHub', 'understoodDcs', 'happy'])
    assert.equal(s.chosen[name], 'Yes', name);
  assert.equal(s.chosen.adjustOnline, 'No');
  assert.equal(s.chosen.adjustInsight, 'No');
  assert.equal(await menusOpen(page), 0);
  assert.equal(s.continued, 0, 'answering "Are you happy to submit your application?" presses nothing');

  // Undo takes the picks back: each list's own "Select One" is picked again, where the list still offers it (the one
  // required question greys it out, so that pick stays).
  const undone = await h.handler('jtf:undo', page);
  assert.equal(undone.undone, 6, JSON.stringify(undone));
  s = await settled(page);
  assert.deepEqual(s.chosen, { neurodiversity: 'No' });
  assert.equal(await menusOpen(page), 0);
  await h.setSettings({ consents: false });
  await page.close();
});

test('“Are you currently in your penultimate year of study?” is answered from the course dates', async () => {
  const page = await h.open('workday-questions.html?step=3');
  const r = await h.fill(page);
  assert.equal(r.error, undefined);
  // September 2025 to June 2028 is three years: the second of them, in November 2026, is the last but one.
  assert.equal((await settled(page)).chosen.penultimate, 'Yes');
  await page.close();
});

test('a list none of whose options is your answer is searched once, not by every fill JobToFill makes itself', async () => {
  // Your own answer to a question whose list has no such option ("Yes | No").
  await h.setProfile({ customAnswers: [{ id: 'c1', question: 're-joining LBG', answer: 'After a sabbatical' }] });
  try {
    const page = await h.open('workday-questions.html');
    const tabId = await h.tabId(page);
    const first = await h.fill(page);
    assert.equal(first.error, undefined);
    let s = await settled(page);
    assert.equal(s.chosen.careerBreak, undefined);
    assert.equal(s.opened.careerBreak, 1);
    assert.ok(first.unmatched.length >= 1, JSON.stringify(first));
    // Quick apply's second fill (the letter and CV are ready): nothing new to try in that list.
    const second = await h.bg(
      (id) => globalThis.JTFBackground.fillTab(id, { quick: true, replace: ['file.coverLetter'], ai: false }),
      tabId,
    );
    assert.equal(second.error, undefined);
    s = await settled(page);
    assert.equal(s.opened.careerBreak, 1, 'not opened again for the same answer');
    assert.deepEqual(second.unmatched, first.unmatched, 'and still said to be unmatched');
    // Fill pressed by the person tries it again.
    await h.fill(page);
    s = await settled(page);
    assert.equal(s.opened.careerBreak, 2);
    assert.equal(await menusOpen(page), 0);

    // Undo on a required list: Workday greys out "Select One" there, so its picks stay; the box typed into goes back.
    const undone = await h.handler('jtf:undo', page);
    s = await settled(page);
    assert.equal(s.chosen.degreeType, 'Bachelor Degree');
    assert.ok(!s.chosen.title, JSON.stringify(s.chosen));
    assert.equal(undone.undone, 1, JSON.stringify(undone));
    assert.equal(await menusOpen(page), 0);
    await page.close();
  } finally {
    await h.setProfile({ customAnswers: [] });
  }
});

test('a question the AI declined isn’t asked again by a fill JobToFill makes itself', async () => {
  await h.setSettings({ aiSensitive: { legal: true } });
  await h.bg(() => globalThis.JTF.api.storage.local.set({ answers: [] }));
  ai.mood.decline = /business interests/;
  try {
    const page = await h.open('workday-questions.html');
    const tabId = await h.tabId(page);
    const first = await h.bg((id) => globalThis.JTFBackground.fillTab(id, { waitAi: true }), tabId);
    assert.equal(first.ai.status, 'done', JSON.stringify(first.ai));
    let s = await settled(page);
    assert.equal(s.chosen.interests, undefined);
    assert.equal(s.chosen.ccjFour, 'No');
    assert.match(first.ai.skipped.map((x) => x.question).join(' | '), /business interests/);
    const asked = ai.calls.length;

    // Quick apply's second fill: the question is still listed as left for you, and the model isn't asked again.
    const second = await h.bg(
      (id) => globalThis.JTFBackground.fillTab(id, { quick: true, replace: ['file.coverLetter'], waitAi: true }),
      tabId,
    );
    assert.equal(second.error, undefined);
    assert.equal(ai.calls.length, asked, JSON.stringify(ai.calls.slice(asked)));
    assert.match(second.ai.skipped.map((x) => x.question).join(' | '), /business interests/);
    assert.deepEqual((await settled(page)).opened, s.opened, 'and no menu is opened again');

    // Fill pressed by the person asks it again (the model may have more to go on by now).
    ai.mood.decline = null;
    const third = await h.bg((id) => globalThis.JTFBackground.fillTab(id, { waitAi: true }), tabId);
    assert.equal(third.error, undefined);
    assert.equal(ai.calls.length, asked + 1);
    s = await settled(page);
    assert.equal(s.chosen.interests, 'No');
    assert.equal(await menusOpen(page), 0);
    await page.close();
  } finally {
    ai.mood.decline = null;
    await h.setSettings({ aiSensitive: { legal: false } });
  }
});
