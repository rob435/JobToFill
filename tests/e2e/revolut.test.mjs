// End-to-end: Revolut's careers application (revolut.html), whose dropdowns are <input type="button"> boxes labelled
// "Select one" under the question's heading, opening a virtual list (with a search box past 14 options) on a click,
// and whose "Links to your Github, portfolio, etc." adds a box each time the last one is filled.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PROFILE, RESUME_PDF, launch, text } from './harness.mjs';

let h;
let original;

before(async () => {
  h = await launch();
  const id = await h.setProfile(PROFILE);
  await h.bg(
    ([pid, dataUrl]) =>
      globalThis.JTF.store.setDoc(pid, 'resume', { name: 'ada_cv.pdf', type: 'application/pdf', size: 60, dataUrl }),
    [id, RESUME_PDF],
  );
  original = await h.profile();
  // A British maths student at Warwick, graduating in June 2027, who has never worked at Revolut.
  await h.setProfile({
    contact: { phoneCountryCode: '+44', phone: '7700 900123' },
    address: { line1: '1 Gower St', city: 'London', state: '', postalCode: 'WC1E 6BT', country: 'United Kingdom' },
    compliance: { previouslyEmployed: 'No' },
    education: [
      {
        school: 'University of Warwick',
        degree: 'BSc',
        field: 'Mathematics',
        gpa: '',
        location: 'Coventry',
        startDate: '2024-09',
        endDate: '2027-06',
      },
    ],
  });
});

after(async () => {
  await h.setProfile({
    contact: original.contact,
    address: original.address,
    compliance: original.compliance,
    education: original.education,
  });
  await h.close();
});

const state = async (page) => JSON.parse(await text(page, '#state'));
const linkBoxes = (page) =>
  page.$$eval('#links input', (list) => list.map((i) => [i.getAttribute('placeholder'), i.value]));

test('Revolut: "Select one" dropdowns under their questions, a virtual list searched, links that grow a box', async () => {
  const page = await h.open('revolut.html');
  const r = await h.fill(page);
  assert.equal(r.error, undefined);
  const s = await state(page);
  assert.equal(s.cv, 'ada_cv.pdf');
  assert.equal(s.full_name, 'Ada Lovelace');
  assert.equal(s.email, 'ada@example.com');
  assert.equal(s.phone, '+447700900123', 'the number beside the "+44" it already shows');
  assert.equal(s.country, 'United Kingdom');
  assert.equal(s.current_company, 'Analytical Engines Inc');
  // Each link once: GitHub in the first link box, the portfolio in the one that appeared, and the last left empty.
  assert.equal(s.linkedin, 'https://www.linkedin.com/in/ada');
  assert.deepEqual(s.links, ['https://github.com/ada', 'https://ada.dev']);
  assert.deepEqual(await linkBoxes(page), [
    ['LinkedIn profile (optional)', 'https://www.linkedin.com/in/ada'],
    ['Links to your Github, portfolio, etc. (optional)', 'https://github.com/ada'],
    ['Links to your Github, portfolio, etc. (optional)', 'https://ada.dev'],
    ['Links to your Github, portfolio, etc. (optional)', ''],
  ]);
  assert.equal(s.gender, 'Female');
  assert.equal(s.ethnicity, 'Prefer not to say');
  // Searched for in a list of 32 that only has the rows in view in the page.
  assert.equal(s.university, 'University of Warwick');
  assert.equal(s.graduation_year, '2027');
  // Ten rows down a list of 14 with no search box: scrolled to.
  assert.equal(s.faculty, 'Mathematics');
  assert.equal(s.heard, 'LinkedIn');
  assert.equal(s.previously_employed, 'No');
  assert.deepEqual(s.pronouns, ['She/her']);
  // What the profile doesn't answer is left for the AI.
  for (const key of ['olympiads', 'competition', 'availability', 'met']) assert.equal(s[key], undefined, key);
  // Every menu closed again, the Add sheets too, and nothing sent.
  assert.equal(await page.$$eval('.rui-popover, [role="dialog"]', (l) => l.length), 0);
  assert.equal(s.submitted, 0);

  // Filled again (Quick apply's second fill, Fill pressed twice): the empty link box still gets no link twice.
  await h.fill(page);
  assert.deepEqual((await state(page)).links, ['https://github.com/ada', 'https://ada.dev']);
  assert.equal((await linkBoxes(page)).length, 4);

  // The AI is offered the questions left, each dropdown with the options it opens with, and its answer is chosen.
  const tabId = await h.tabId(page);
  const items = await h.bg(async (id) => {
    const { profile, settings } = await globalThis.JTF.store.getActive();
    return (await globalThis.JTFBackground.callFrames(id, 'pending', [{ profile, settings, ai: true }], [0]))[0].items;
  }, tabId);
  const olympiads = items.find((i) => /academic olympiads/i.test(i.question));
  assert.ok(olympiads, JSON.stringify(items.map((i) => i.question)));
  assert.deepEqual(olympiads.options, [
    'Yes – I won a medal at an international olympiad',
    'Yes – I took part in an international olympiad',
    'Yes – national level only',
    'No',
  ]);
  assert.match(olympiads.help, /best applies/);
  const availability = items.find((i) => /full duration of the programme/.test(i.question));
  assert.deepEqual(availability.options, ['Yes', 'No']);
  const competition = items.find((i) => /which competition/i.test(i.question));
  assert.ok(!/universities you are affiliated with/.test(competition.help || ''), 'not the Education section’s note');
  const put = await h.bg(
    ([id, answers]) =>
      globalThis.JTFBackground.callFrames(id, 'applyAnswers', [answers, { settings: {} }], [0]).then((f) => f[0]),
    [
      tabId,
      [
        { id: olympiads.id, question: olympiads.question, value: 'Yes – national level only', kind: 'text' },
        { id: availability.id, question: availability.question, value: 'Yes', kind: 'text' },
      ],
    ],
  );
  assert.equal(put.filled, 2, JSON.stringify(put));
  const after = await state(page);
  assert.equal(after.olympiads, 'Yes – national level only');
  assert.equal(after.availability, 'Yes');
  assert.equal(await page.$$eval('.rui-popover', (l) => l.length), 0);
  await page.close();
});

test('Revolut: a university the list doesn’t have takes its “Other – not listed”, as the note says', async () => {
  const before = await h.profile();
  await h.setProfile({ education: [{ ...before.education[0], school: 'University of Sussex' }] });
  try {
    const page = await h.open('revolut.html');
    await h.fill(page);
    const s = await state(page);
    assert.equal(s.university, 'Other – not listed');
    assert.equal(s.graduation_year, '2027');
    await page.close();
  } finally {
    await h.setProfile({ education: before.education });
  }
});
