// The eval's frozen datasets and the candidate they're answered for. The candidate lives in one place, the live
// survey's fictional applicant (tests/live/profile.mjs); the data files hold public postings and form questions only.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SURVEY_CV, SURVEY_PROFILE } from '../live/profile.mjs';

export const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
// The survey's date: forms were simulated, and the AI answers and writes, as on this day (noon UTC, so the date
// is the same in every time zone and the prompts are byte for byte the same everywhere).
export const TODAY = '2026-10-02';
export const TODAY_MS = Date.parse(`${TODAY}T12:00:00Z`);

export async function loadData(name) {
  return JSON.parse(await readFile(path.join(DATA, `${name}.json`), 'utf8'));
}

/** The candidate as the extension holds them: the profile (upgraded like a stored one), kit and CV text. */
export function candidate(JTF, kit) {
  return {
    profile: JTF.fields.upgradeProfile(structuredClone(SURVEY_PROFILE)),
    kit: { notes: '', samples: [], answerNotes: '', ...kit },
    cvText: SURVEY_CV,
  };
}

/**
 * The cases of a suite: answers (one per form) or letters (one per posting), for a split, the first `limit`.
 * Each is { suite, id, split, data } where data is the form or posting.
 */
export async function loadCases(suite, { split = 'all', limit } = {}) {
  const file = await loadData(suite);
  const list = suite === 'answers' ? file.forms : file.cases;
  const picked = list.filter((c) => split === 'all' || c.split === split);
  return picked.slice(0, limit > 0 ? limit : picked.length).map((c) => ({ suite, id: c.id, split: c.split, data: c }));
}
