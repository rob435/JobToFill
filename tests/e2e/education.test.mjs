// End-to-end: education on real UK and US application forms (Teamtailor menus, SuccessFactors blocks, Greenhouse
// transcript uploads), in Chromium or Firefox.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PROFILE, RESUME_PDF, checked, launch, selectedText, text, value } from './harness.mjs';

let h;
let profileId;

// A University of Glasgow undergraduate.
const GLASGOW = {
  school: 'University of Glasgow',
  degree: 'BSc (Hons) Computer Science',
  field: 'Computer Science',
  gpa: '',
  classification: '2:1',
  location: 'Glasgow, Scotland',
  startDate: '2023-09',
  endDate: '2027-06',
};

before(async () => {
  h = await launch();
  profileId = await h.setProfile({ ...PROFILE, education: [GLASGOW] });
  for (const [which, name] of [
    ['resume', 'Ada_Lovelace_CV.pdf'],
    ['transcript', 'Ada_Lovelace_transcript.pdf'],
  ])
    await h.bg(
      ([id, kind, file, dataUrl]) =>
        globalThis.JTF.store.setDoc(id, kind, { name: file, type: 'application/pdf', size: 60, dataUrl }),
      [profileId, which, name, RESUME_PDF],
    );
});

after(() => h.close());

const fileName = (page, selector) => page.$eval(selector, (input) => (input.files[0] ? input.files[0].name : ''));
const state = async (page) => JSON.parse(await text(page, '#state'));

test('Teamtailor (Alloyed): the "University:" menu gets Glasgow, never Glasgow Caledonian; course, class, degree type', async () => {
  const page = await h.open('teamtailor.html');
  const r = await h.fill(page);
  assert.equal(r.error, undefined);
  const s = await state(page);
  assert.equal(s['University:'], 'University of Glasgow', 'picked from the menu of 67 universities');
  assert.equal(await checked(page, '#candidate_answers_attributes_2_choice_42'), true, 'the hidden radio is ticked');
  assert.equal(await checked(page, '#candidate_answers_attributes_2_choice_10'), false, 'not Glasgow Caledonian');
  assert.equal(await text(page, '#id_2058_selected'), 'University of Glasgow', 'the button shows the choice');
  assert.equal(
    await page.$eval('#dropdown-2', (m) => m.classList.contains('hidden')),
    true,
    'the menu is closed again',
  );
  assert.equal(
    await value(page, '#candidate_answers_attributes_3_text'),
    'Computer Science',
    '"University Course" is what you study, not the university',
  );
  assert.equal(s['Expected/Achieved Degree Classification'], '2:1');
  assert.equal(s['Degree Type'], 'Bachelors Degree');
  assert.equal(s['Year of Graduation'], '2027');
  assert.equal(s.Gender, 'Female');
  assert.equal(s['Do you require sponsorship to work in the UK?'], 'No');
  assert.equal(
    s['Graduate Engineer / Summer Internship'],
    undefined,
    'a "role classification" is not your degree class',
  );
  assert.equal(
    await value(page, '#candidate_answers_attributes_8_date'),
    '',
    '"Start Date" after the graduation year is not when your degree started',
  );
  assert.equal(await value(page, '#candidate_first_name'), 'Ada');
  assert.equal(await fileName(page, '#candidate_resume_remote_url'), 'Ada_Lovelace_CV.pdf');

  // Filling again changes nothing: a menu button showing its choice has a value, not "Select an option".
  const before = await state(page);
  const refill = await h.fill(page);
  assert.equal(refill.filled, 0, JSON.stringify(refill));
  assert.deepEqual(await state(page), before);
  await page.close();
});

test('Teamtailor: a classification written as the GPA ("2:1") still picks the class; GPA bands never do', async () => {
  await h.setProfile({ education: [{ ...GLASGOW, classification: '', gpa: '2:1' }] });
  try {
    const page = await h.open('teamtailor.html');
    await h.fill(page);
    assert.equal((await state(page))['Expected/Achieved Degree Classification'], '2:1');
    await page.close();
  } finally {
    await h.setProfile({ education: [GLASGOW] });
  }
});

test('SuccessFactors: each block starts with its "From Date"; school country and city from the entry', async () => {
  const page = await h.open('successfactors.html');
  const r = await h.fill(page);
  assert.equal(r.error, undefined);
  // Previous employment: the current job (no end date), its country from "San Francisco, CA".
  assert.equal(await value(page, '#outsideWorkExperience_startDate_0'), '03/01/2020', 'the box’s own MM/DD/YYYY');
  assert.equal(await value(page, '#outsideWorkExperience_endDate_0'), '');
  assert.equal(await value(page, '#outsideWorkExperience_employer_0'), 'Analytical Engines Inc');
  assert.equal(await value(page, '#outsideWorkExperience_title_0'), 'Senior Engineer');
  assert.equal(await selectedText(page, '#outsideWorkExperience_country_0'), 'United States');
  // Education: "From Date" right after the work history is the degree's start, not a second job's.
  assert.equal(await value(page, '#education_startDate_0'), '09/01/2023');
  assert.equal(await value(page, '#education_endDate_0'), '06/01/2027');
  assert.equal(await value(page, '#education_school_0'), 'University of Glasgow');
  assert.equal(await selectedText(page, '#education_country_0'), 'United Kingdom', 'from "Glasgow, Scotland"');
  assert.equal(await value(page, '#education_schoolCity_0'), 'Glasgow, Scotland');
  assert.equal(await value(page, '#education_major_0'), 'Computer Science');
  assert.equal(await selectedText(page, '#education_degree_0'), "Bachelor's Degree");
  assert.equal(await selectedText(page, '#education_level_0'), "Bachelor's");
  await page.close();
});

test('Greenhouse (Databricks): the undergraduate transcript is attached, the graduate one is left for a BSc', async () => {
  const page = await h.open('greenhouse-transcripts.html');
  const r = await h.fill(page);
  assert.equal(r.error, undefined);
  assert.equal(await fileName(page, '#resume'), 'Ada_Lovelace_CV.pdf');
  assert.equal(await fileName(page, '#question_32886064002'), 'Ada_Lovelace_transcript.pdf');
  assert.equal(await fileName(page, '#question_32886065002'), '', 'no graduate studies, no graduate transcript');
  assert.ok(!r.missing.includes('Transcript file'), JSON.stringify(r.missing));
  await page.close();

  // A master's student has graduate studies: both get the transcript.
  await h.setProfile({
    education: [{ ...GLASGOW, degree: 'MSc Data Science', startDate: '2026-09', endDate: '2027-09' }, GLASGOW],
  });
  try {
    const again = await h.open('greenhouse-transcripts.html');
    await h.fill(again);
    assert.equal(await fileName(again, '#question_32886064002'), 'Ada_Lovelace_transcript.pdf');
    assert.equal(await fileName(again, '#question_32886065002'), 'Ada_Lovelace_transcript.pdf');
    await again.close();
  } finally {
    await h.setProfile({ education: [GLASGOW] });
  }
});
