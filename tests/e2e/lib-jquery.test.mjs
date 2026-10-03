// End-to-end: the jQuery-era and vanilla widget plugins older careers sites are built from (lib-jquery.html): select2
// (a country preselected from the visitor's IP, a multi-select, an ajax search), chosen, choices.js, Tom Select,
// intl-tel-input (also on the wrong country), Inputmask and jQuery UI. Each plugin's own value (its API's, and the
// <select>/<input> it keeps for the form) is read from the page's #state.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PROFILE, launch, text } from './harness.mjs';

let h;

// A student in Glasgow, applying from a VPS in Italy.
const STUDENT = {
  ...PROFILE,
  personal: { firstName: 'Robin', lastName: 'Li', nationality: 'British', dob: '2005-03-14' },
  contact: { email: 'robin@example.com', phoneCountryCode: '+44', phone: '07386 526574', phoneType: 'Mobile' },
  address: {
    line1: '10 University Avenue',
    line2: 'Flat 2',
    city: 'Glasgow',
    state: 'Glasgow City',
    postalCode: 'G12 8QQ',
    country: 'United Kingdom',
    organization: '',
  },
  job: { ...PROFILE.job, locations: 'London, Glasgow', referralSource: 'LinkedIn', startDate: '2027-06-28' },
  education: [
    {
      school: 'University of Glasgow',
      degree: 'BSc',
      field: 'Computing Science',
      gpa: '',
      classification: '2:1',
      location: 'Glasgow, Scotland',
      startDate: '2023-09',
      endDate: '2027-06',
    },
  ],
  skills: 'Python, SQL, Machine Learning',
  languages: 'English, Mandarin',
};

before(async () => {
  h = await launch();
});

after(() => h && h.close());

async function open() {
  const page = await h.open('lib-jquery.html');
  await page.waitForFunction(() => document.getElementById('state').textContent.length > 2);
  return page;
}

const state = (page) => page.$eval('#state', (el) => JSON.parse(el.textContent));

/** The plugins' menus and pop-ups that are still showing. */
const leftOpen = (page) =>
  page.$$eval(
    '.select2-container--open, .chosen-with-drop, .choices.is-open, .ts-dropdown, .iti__country-selector, .ui-autocomplete, #ui-datepicker-div',
    (els) =>
      els
        .filter((el) => getComputedStyle(el).display !== 'none' && !el.classList.contains('iti__hide'))
        .map((el) => el.className),
  );

/** The questions the fill left for the AI, as the content script lists them (with the active profile). */
async function askedQuestions(page) {
  const tabId = await h.tabId(page);
  return h.bg(async (id) => {
    const { profile } = await globalThis.JTF.store.getActive();
    const [{ result }] = await globalThis.JTF.api.scripting.executeScript({
      target: { tabId: id },
      args: [profile],
      func: async (p) => (await globalThis.__jtf.pending({ profile: p })).items,
    });
    return result;
  }, tabId);
}

/** Put answers in the way the AI's are put in. */
async function applyAnswers(page, list) {
  const tabId = await h.tabId(page);
  return h.bg(
    async ([id, answers]) => {
      const [{ result }] = await globalThis.JTF.api.scripting.executeScript({
        target: { tabId: id },
        args: [answers],
        func: (a) => globalThis.__jtf.applyAnswers(a, { settings: {} }),
      });
      return result;
    },
    [tabId, list],
  );
}

test('jQuery plugins, US profile: Inputmask phone and date masks, intl-tel-input, select2 country', async () => {
  await h.setProfile(PROFILE);
  const page = await open();
  const r = await h.fill(page);
  assert.equal(r.error, undefined);
  const s = await state(page);
  // intl-tel-input started on Italy: the number and its country are both the profile's.
  assert.equal(s.phone.number, '+14155550100');
  assert.equal(s.phone.iso2, 'us');
  // "(999) 999-9999" holds the national number: "+1 415 555 0100" is not squeezed into it as "(141) 555-5010".
  assert.deepEqual(s.mobile_us, { value: '(415) 555-0100', unmasked: '4155550100', complete: true });
  assert.deepEqual(s.dob, { value: '10/12/1990', unmasked: '10121990', complete: true });
  assert.deepEqual(s.country, { value: 'US', select2: ['United States'] });
  assert.equal(s.city.value, 'San Francisco');
  assert.deepEqual(s.start_date, { value: '11/02/2026', date: '2026-11-02' });
  assert.deepEqual(s.university, { value: 'University of Cambridge', select2: ['University of Cambridge'] });
  assert.deepEqual(s.field_of_study, { value: 'Mathematics', tomselect: 'Mathematics' });
  assert.deepEqual(s.languages, { value: ['English', 'French'] });
  assert.deepEqual(await leftOpen(page), []);
  await page.close();
});

test('jQuery plugins, UK student: select2, chosen, choices.js and Tom Select register what the profile says', async () => {
  await h.setProfile(STUDENT);
  const page = await open();
  const r = await h.fill(page);
  assert.equal(r.error, undefined);
  assert.equal(r.failed, 0, `unmatched: ${r.unmatched}`);
  const s = await state(page);
  assert.equal(s.first_name, 'Robin');
  // intl-tel-input's Italy (+39) and select2's preselected, clearable Italy are put right.
  assert.equal(s.phone.number, '+447386526574');
  assert.equal(s.phone.iso2, 'gb');
  assert.deepEqual(s.country, { value: 'GB', select2: ['United Kingdom'] });
  assert.deepEqual(s.dob, { value: '14/03/2005', unmasked: '14032005', complete: true });
  // jQuery UI: the city typed (its suggestions never left open), the start date in the picker's own format.
  assert.equal(s.city.value, 'Glasgow');
  assert.deepEqual(s.start_date, { value: '06/28/2027', date: '2027-06-28' });
  // select2's ajax search, typed into the search box inside its dropdown; its multi-select takes both offices.
  assert.deepEqual(s.university, { value: 'University of Glasgow', select2: ['University of Glasgow'] });
  assert.deepEqual(s.locations, { value: ['London', 'Glasgow'], select2: ['London', 'Glasgow'] });
  // chosen: its <select> and what it shows.
  assert.deepEqual(s.degree, { value: "Bachelor's Degree (BA, BSc, BEng)" });
  assert.equal(await text(page, '#degree_chosen .chosen-single span'), "Bachelor's Degree (BA, BSc, BEng)");
  assert.deepEqual(s.languages, { value: ['English', 'Mandarin'] });
  assert.deepEqual(
    await page.$$eval('#languages_chosen .search-choice span', (els) => els.map((el) => el.textContent)),
    ['English', 'Mandarin'],
  );
  // Tom Select: "Computing Science" is listed as "Computer Science"; a skill it doesn't list is added as a new one.
  assert.deepEqual(s.field_of_study, { value: 'Computer Science', tomselect: 'Computer Science' });
  assert.deepEqual(s.skills, {
    value: ['Python', 'SQL', 'Machine Learning'],
    tomselect: ['Python', 'SQL', 'Machine Learning'],
  });
  // choices.js.
  assert.deepEqual(s.source, { value: 'LinkedIn', choices: 'LinkedIn' });
  assert.deepEqual(await leftOpen(page), []);

  // "Which teams interest you?" (choices.js, multiple) is nothing the profile knows: it waits for the AI, which sees
  // its options without the menu being opened, and its answer goes in as the AI's answers do.
  const asked = await askedQuestions(page);
  const teams = asked.find((q) => /teams/i.test(q.question));
  assert.ok(teams, `asked: ${asked.map((q) => q.question)}`);
  assert.equal(teams.multiple, true);
  assert.ok(teams.options.includes('Quantitative Research'), `options: ${teams.options}`);
  const applied = await applyAnswers(page, [
    { id: teams.id, question: teams.question, value: ['Technology', 'Quantitative Research'] },
  ]);
  assert.equal(applied.filled, 1);
  assert.deepEqual((await state(page)).teams, {
    value: ['Technology', 'Quantitative Research'],
    choices: ['Technology', 'Quantitative Research'],
  });
  assert.deepEqual(await leftOpen(page), []);

  // A second fill finds everything answered: no multi-select loses or doubles an entry.
  const before = await state(page);
  await h.fill(page);
  assert.deepEqual(await state(page), before);
  await page.close();
});
