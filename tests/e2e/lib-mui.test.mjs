// End-to-end: an application form built with the real Material UI and MUI X date pickers (lib-mui.html), checked
// against the site's own React state. Outlined TextFields, Autocompletes (a country preselected from the visitor's IP
// address, chips for several locations, a school search the server answers 400 ms after typing), Selects whose menus
// open in a portal and fade out, a NativeSelect, a RadioGroup, a Checkbox, a Switch, and dates typed in parts
// (role="spinbutton" spans in MUI X's default field, a DD/MM/YYYY DateField) beside a masked plain <input>.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PROFILE, launch, text } from './harness.mjs';

let h;

// A student in Glasgow, applying from a connection the site places in Italy.
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
  links: { linkedin: 'https://www.linkedin.com/in/robinli', github: '', portfolio: '', website: '', twitter: '' },
  job: {
    ...PROFILE.job,
    salary: '32000',
    relocate: 'Yes',
    startDate: '2027-06-14',
    referralSource: 'LinkedIn',
    locations: 'London, Edinburgh',
  },
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
  experience: [],
  coverLetter: 'I would love to join the Summer Analyst programme.',
  customAnswers: [],
};

before(async () => {
  h = await launch();
  await h.setProfile(STUDENT);
});

after(() => h && h.close());

const state = async (page) => JSON.parse(await text(page, '#state'));
// The menus and calendars on screen (one that has faded out is gone, though React unmounts it a little later).
const openMenus = (page) =>
  page.$$eval('[role="listbox"], [role="dialog"]', (list) =>
    list.filter((el) => el.checkVisibility({ checkOpacity: true })).map((el) => el.outerHTML.slice(0, 160)),
  );

test('MUI: every widget a UK student’s profile answers lands in the site’s React state', async () => {
  await h.setSettings({ consents: true });
  try {
    const page = await h.open('lib-mui.html');
    await page.waitForSelector('#state');
    const r = await h.fill(page);
    assert.equal(r.error, undefined);
    const s = await state(page);
    // TextFields
    assert.equal(s.firstName, 'Robin');
    assert.equal(s.lastName, 'Li');
    assert.equal(s.email, 'robin@example.com');
    assert.equal(s.phone, '+44 7386 526574', 'dialled from abroad without the trunk zero');
    assert.equal(s.linkedin, 'https://www.linkedin.com/in/robinli');
    assert.equal(s.salary, '32000', 'type="number"');
    assert.equal(s.coverLetter, 'I would love to join the Summer Analyst programme.', 'multiline');
    // Autocompletes
    assert.equal(s.country, 'United Kingdom', 'the country picked from the IP address (Italy) is put right');
    assert.deepEqual(s.locations, ['London', 'Edinburgh'], 'multiple: one chip per preferred location');
    assert.equal(s.school, 'University of Glasgow', 'picked from what the server returned after typing');
    assert.equal(s.fieldOfStudy, 'Computer Science', 'the list has no "Computing Science"');
    // Selects (menus in a portal), NativeSelect, RadioGroup, Switch, Checkbox
    assert.equal(s.degree, 'Bachelor’s');
    assert.equal(s.heard, 'LinkedIn', 'the menu of the Select before it had faded out first');
    assert.deepEqual(s.teams, [], 'nothing in the profile says which teams');
    assert.equal(s.authorizedUK, 'yes');
    assert.equal(s.sponsorship, 'no');
    assert.equal(s.relocation, true);
    assert.equal(s.privacy, true);
    // Dates: MUI X's default field (role="spinbutton" parts), a DD/MM/YYYY DateField, and a masked plain <input>.
    assert.equal(s.graduationDate, '2027-06-01', 'a month-only date takes the 1st');
    assert.equal(s.startDate, '2027-06-14');
    assert.equal(s.dob, '2005-03-14', 'typed day first, as its parts come');
    assert.equal(s.availableFrom, '2027-06-14');
    assert.deepEqual(r.unmatched, []);
    assert.deepEqual(await openMenus(page), [], 'no menu or calendar left open');

    // Filling again changes nothing: every widget reports the answer it already has.
    const refill = await h.fill(page);
    assert.equal(refill.filled, 0, JSON.stringify(refill));
    assert.deepEqual(await state(page), s);

    // The AI's answer to "Which teams interest you?" names two teams: both are ticked in the multi-select.
    const tabId = await h.tabId(page);
    const [frame] = await h.bg(async (id) => {
      const { profile } = await globalThis.JTF.store.getActive();
      return globalThis.JTFBackground.callFrames(id, 'pending', [{ profile, settings: {}, ai: true }], [0]);
    }, tabId);
    const teams = frame.items.find((it) => /which teams/i.test(it.question));
    assert.ok(teams, JSON.stringify(frame.items));
    assert.deepEqual(
      teams.options,
      ['Investment Banking', 'Global Markets', 'Technology', 'Quantitative Research', 'Asset Management'],
      'read from its menu, which then closes',
    );
    assert.equal(teams.multiple, true);
    assert.deepEqual(await openMenus(page), []);
    const answer = { id: teams.id, question: teams.question, value: ['Technology', 'Quantitative Research'] };
    const [applied] = await h.bg(
      ([id, a]) => globalThis.JTFBackground.callFrames(id, 'applyAnswers', [[a], { settings: {} }], [0]),
      [tabId, answer],
    );
    assert.equal(applied.filled, 1, JSON.stringify(applied));
    assert.deepEqual((await state(page)).teams, ['Technology', 'Quantitative Research']);
    assert.deepEqual(await openMenus(page), []);
    await page.close();
  } finally {
    await h.setSettings({ consents: false });
  }
});
