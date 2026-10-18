// iCIMS end to end, on a replica of AMD's application (globalcampus-amd.icims.com) served at an iCIMS address
// (tests/fixtures/icims*.html, icims.js): the portal's page framing each step, iCIMS's searchable dropdowns (a hidden
// <select> behind a box that opens on mousedown, a "— Type to Search —" box of their own, lists from the server 25 at
// a time, a Region waiting for its Country), field collections, and the résumé box that sends the whole page to be
// read. Each test checks what iCIMS itself holds: the hidden <select>, the box it shows and the dropdown's own state.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ICIMS_HOST, ICIMS_JOB, RESUME_PDF, frameWith, launch, until } from './harness.mjs';

// An invented British student: a degree under way, a summer internship.
const STUDENT = {
  personal: { firstName: 'Morgan', lastName: 'Reid', middleName: '', preferredName: '', nationality: 'United Kingdom' },
  contact: { email: 'morgan.reid@example.com', phoneCountryCode: '+44', phone: '07700900123', phoneType: 'Mobile' },
  address: {
    line1: '12 Castle Street',
    line2: '',
    city: 'Inverness',
    state: 'Highland',
    postalCode: 'IV2 3EG',
    country: 'United Kingdom',
  },
  links: { linkedin: 'https://www.linkedin.com/in/morgan-reid', github: '', portfolio: '', website: '' },
  job: { referralSource: 'LinkedIn' },
  education: [
    {
      school: 'University of Stirling',
      degree: 'Bachelor of Science',
      field: 'Data Science',
      gpa: '',
      location: 'Stirling',
      startDate: '2024-09',
      endDate: '2028-05',
      classification: '2:1',
    },
  ],
  experience: [
    {
      company: 'Calder Partners',
      title: 'Data Engineering Intern',
      location: 'Aberdeen',
      startDate: '2026-06',
      endDate: '2026-08',
      current: false,
      description: 'Data pipelines in Python',
    },
  ],
};

let h;

before(async () => {
  h = await launch();
  await h.setProfile(STUDENT);
});

after(() => h.close());

/** A step of the application at its iCIMS address, and the frame the portal's page shows it in. */
async function openStep(step) {
  const page = await h.open(`${ICIMS_JOB}/${step}`, ICIMS_HOST);
  const frame = await frameWith(page, `/${step}?in_iframe=1`, 'select');
  return { page, frame };
}

const frameOf = (page, step) => page.frames().find((f) => f.url().includes(`/${step}?in_iframe=1`));

/**
 * What iCIMS holds for each field id: for one of its dropdowns, its own state's choice, the hidden <select>'s and the
 * box's text ("widget | select | box", or with " (open)" while its menu shows); a plain <select>'s choice; a box's value.
 */
function held(frame, ids) {
  return frame.evaluate((list) => {
    const out = {};
    for (const id of list) {
      const el = document.getElementById(id);
      const w = window.ICIMSFX.dropdowns[id];
      const chosen = el.localName === 'select' && el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : '';
      if (w) {
        const box = document.getElementById(id + '_fakeSelected_icimsDropdown').textContent;
        out[id] = `${w.getSelected().text || ''} | ${chosen} | ${box}${w.state().open ? ' (open)' : ''}`;
      } else out[id] = el.localName === 'select' ? chosen : el.value;
    }
    return out;
  }, ids);
}

const both = (text) => `${text} | ${text} | ${text}`;
const openMenus = (frame) => frame.$$eval('.dropdown-container:not(.dropdown-invisible)', (els) => els.length);

/** The questions the AI would get from this tab now (none answered by the rules). */
const forAi = async (page) =>
  h.bg(
    async (id) => {
      const { profile, settings } = await globalThis.JTF.store.getActive();
      const frames = await globalThis.JTFBackground.callFrames(id, 'pending', [{ profile, settings }]);
      return frames.flatMap((f) => (f.items || []).map((q) => q.question));
    },
    await h.tabId(page),
  );

test('Candidate Profile: iCIMS’s dropdowns get your answers as iCIMS registers them, with nothing left open', async () => {
  const { page, frame } = await openStep('candidate');
  const r = await h.fill(page);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.unmatched, [], 'every list took its answer');
  assert.deepEqual(
    await held(frame, [
      'rcf3305',
      '-1_PersonProfileFields.AddressCountry',
      '-1_PersonProfileFields.AddressState',
      '-1_EducationFields.School',
      '-1_EducationFields.Degree',
      '-1_EducationFields.Major',
      '-1_WorkExperienceFields.Country',
    ]),
    {
      rcf3305: both('LinkedIn'),
      '-1_PersonProfileFields.AddressCountry': both('United Kingdom'),
      // The Region waits for the Country: Highland from the United Kingdom's list.
      '-1_PersonProfileFields.AddressState': both('Highland'),
      '-1_EducationFields.School': both('University of Stirling'),
      // "Highest Degree (Completed or Not Completed)" is the entry's degree, under way or not.
      '-1_EducationFields.Degree': both("Bachelor's Degree"),
      '-1_EducationFields.Major': both('Data Science'),
      // The job's country, from where it was: Aberdeen is in the country you live in.
      '-1_WorkExperienceFields.Country': both('United Kingdom'),
    },
  );
  assert.deepEqual(
    await held(frame, [
      '-1_PersonProfileFields.PhoneType',
      '-1_PersonProfileFields.PhoneNumber',
      '-1_PersonProfileFields.AddressType',
      '-1_PersonProfileFields.AddressStreet1',
      '-1_PersonProfileFields.AddressCity',
      '-1_PersonProfileFields.AddressZip',
      '-1_EducationFields.SchoolOther',
      '-1_rcf3048',
      '-1_EducationFields.GraduationDate_Month',
      '-1_EducationFields.GraduationDate_Date',
      '-1_EducationFields.GraduationDate_Year',
      '-1_WorkExperienceFields.Employer',
      '-1_WorkExperienceFields.Address',
      '-1_WorkExperienceFields.City',
      '-1_WorkExperienceFields.Zip',
      '-1_WorkExperienceFields.Title',
      '-1_WorkExperienceFields.StartDate_Month',
      '-1_WorkExperienceFields.StartDate_Date',
      '-1_WorkExperienceFields.EndDate_Month',
      '-1_WorkExperienceFields.EndDate_Date',
      '-1_WorkExperienceFields.EndDate_Year',
    ]),
    {
      '-1_PersonProfileFields.PhoneType': 'Mobile',
      '-1_PersonProfileFields.PhoneNumber': '+44 7700900123',
      '-1_PersonProfileFields.AddressType': 'Home',
      '-1_PersonProfileFields.AddressStreet1': '12 Castle Street',
      '-1_PersonProfileFields.AddressCity': 'Inverness',
      '-1_PersonProfileFields.AddressZip': 'IV2 3EG',
      '-1_EducationFields.SchoolOther': '',
      '-1_rcf3048': 'In Progress',
      // A date kept to the month gets the 1st where the form wants a day.
      '-1_EducationFields.GraduationDate_Month': 'May',
      '-1_EducationFields.GraduationDate_Date': '1',
      '-1_EducationFields.GraduationDate_Year': '2028',
      '-1_WorkExperienceFields.Employer': 'Calder Partners',
      // The employer's street and postcode are not yours.
      '-1_WorkExperienceFields.Address': '',
      '-1_WorkExperienceFields.City': 'Aberdeen',
      '-1_WorkExperienceFields.Zip': '',
      '-1_WorkExperienceFields.Title': 'Data Engineering Intern',
      '-1_WorkExperienceFields.StartDate_Month': 'Jun',
      '-1_WorkExperienceFields.StartDate_Date': '1',
      '-1_WorkExperienceFields.EndDate_Month': 'Aug',
      '-1_WorkExperienceFields.EndDate_Date': '1',
      '-1_WorkExperienceFields.EndDate_Year': '2026',
    },
  );
  assert.equal(await openMenus(frame), 0, 'every menu closed again');
  // Nothing is left over for the AI: never a dropdown's own search box, nor the employer's address.
  const left = await forAi(page);
  assert.ok(!left.some((q) => /type to search/i.test(q)), left.join(' | '));
  assert.deepEqual(left, []);
  await page.close();
});

test('Candidate Profile: a school its list hasn’t got goes into “If your school is not listed, enter it here”', async () => {
  await h.setProfile({
    education: [
      {
        school: 'Ardmore Academy',
        degree: 'Scottish Highers',
        field: 'Geography, Modern Studies, Art',
        gpa: 'BBB',
        location: 'Inverness',
        startDate: '2018-08',
        endDate: '2024-06',
      },
    ],
  });
  try {
    const { page, frame } = await openStep('candidate');
    await h.fill(page);
    assert.deepEqual(
      await held(frame, [
        '-1_EducationFields.School',
        '-1_EducationFields.SchoolOther',
        '-1_EducationFields.Degree',
        '-1_rcf3048',
      ]),
      {
        '-1_EducationFields.School': ' | — Make a Selection — | — Make a Selection —',
        '-1_EducationFields.SchoolOther': 'Ardmore Academy',
        '-1_EducationFields.Degree': both('High School Diploma or Equivalent'),
        '-1_rcf3048': 'Received',
      },
    );
    assert.equal(await openMenus(frame), 0);
    await page.close();
  } finally {
    await h.setProfile({ education: STUDENT.education });
  }
});

test('Candidate Profile: the résumé box that sends the page goes in once, and the page it comes back as is filled', async () => {
  const profileId = await h.setProfile({});
  await h.bg(
    ([id, dataUrl]) =>
      globalThis.JTF.store.setDoc(id, 'resume', {
        name: 'morgan_reid_cv.pdf',
        type: 'application/pdf',
        size: 60,
        dataUrl,
      }),
    [profileId, RESUME_PDF],
  );
  try {
    const { page } = await openStep('candidate');
    const r = await h.fill(page);
    assert.equal(r.error, undefined);
    assert.equal(r.docs['file.resume'], 'filled');
    // iCIMS read the CV and drew the page again; the fill carried on there.
    const frame = frameOf(page, 'candidate');
    assert.match(frame.url(), /[?&]uploadResume=1\b/);
    assert.equal(frame.url().match(/uploadResume=1/g).length, 1, 'sent once');
    assert.equal(await frame.evaluate(() => sessionStorage.getItem('icimsUploads')), '1');
    assert.ok(
      r.notes.some((n) => /read your CV and drew the form again/.test(n)),
      r.notes.join(' | '),
    );
    // What iCIMS read from the CV ("+1", the CV's city, the job's shorter title) gives way to the profile's answers,
    // though Overwrite is off: the site wrote it, not you.
    assert.deepEqual(
      await held(frame, [
        '-1_PersonProfileFields.PhoneNumber',
        '-1_PersonProfileFields.AddressCity',
        '-1_EducationFields.Major',
        '-1_EducationFields.Degree',
        '-1_rcf3048',
        '-1_WorkExperienceFields.Title',
      ]),
      {
        '-1_PersonProfileFields.PhoneNumber': '+44 7700900123',
        '-1_PersonProfileFields.AddressCity': 'Inverness',
        '-1_EducationFields.Major': both('Data Science'),
        '-1_EducationFields.Degree': both("Bachelor's Degree"),
        '-1_rcf3048': 'In Progress',
        '-1_WorkExperienceFields.Title': 'Data Engineering Intern',
      },
    );
    // The two education entries it made beyond your profile's one are left as they are, and said so.
    assert.deepEqual(await held(frame, ['-3_EducationFields.School', '-3_EducationFields.Degree', '-3_rcf3048']), {
      '-3_EducationFields.School': both('University of Stirling'),
      '-3_EducationFields.Degree': ' | — Make a Selection — | — Make a Selection —',
      '-3_rcf3048': '',
    });
    assert.ok(
      r.notes.some((n) => /Education entries 2 and 3 aren’t in your profile/.test(n)),
      r.notes.join(' | '),
    );
    assert.deepEqual(await forAi(page), [], 'nor sent to the AI');
    // Fill again: the box shows the CV it read, so it isn't sent a second time.
    const again = await h.fill(page);
    assert.equal(again.error, undefined);
    assert.equal(await frame.evaluate(() => sessionStorage.getItem('icimsUploads')), '1');
    assert.equal(
      frameOf(page, 'candidate')
        .url()
        .match(/uploadResume=1/g).length,
      1,
    );
    await page.close();
  } finally {
    await h.bg((id) => globalThis.JTF.store.removeDoc(id, 'resume'), profileId);
  }
});

/** An OpenAI-compatible stand-in that answers the experience questions by their technology, recording each call. */
function mockAi() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = JSON.parse(body || '{}');
      const system = json.messages[0].content;
      const last = json.messages.at(-1).content;
      calls.push({ system, last });
      let reply = { ok: true };
      if (/strict fact-checker for job application answers/.test(system)) reply = { unsupported: [] };
      else if (/answer job application form questions/.test(system)) {
        const questions = JSON.parse(last.slice(last.indexOf('QUESTIONS:') + 'QUESTIONS:'.length));
        reply = {
          answers: questions.map((q) => ({
            id: q.id,
            answer: /python/i.test(q.question) ? 'Coursework or personal projects' : 'None',
            basis: 'material',
          })),
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
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls })));
}

test('Job Specific Questions: a step of only the employer’s own questions is the application’s, for the AI', async () => {
  const ai = await mockAi();
  await h.bg(async (base) => {
    await globalThis.JTF.store.saveSettings({ ai: { provider: 'custom', baseUrl: base, model: 'mock' } });
    await globalThis.JTF.store.setAiKey('test-key');
  }, `http://127.0.0.1:${ai.server.address().port}/v1`);
  try {
    const { page, frame } = await openStep('questions');
    const r = await h.bg((id) => globalThis.JTFBackground.fillTab(id, { waitAi: true }), await h.tabId(page));
    assert.equal(r.error, undefined);
    assert.equal(r.unknown, 6, 'six questions found, none the rules know');
    assert.equal(r.ai.status, 'done', JSON.stringify(r.ai));
    assert.equal(r.ai.filled, 6);
    const chosen = await frame.$$eval('select', (els) => els.map((e) => e.options[e.selectedIndex].text));
    assert.deepEqual(chosen, ['None', 'None', 'None', 'None', 'Coursework or personal projects', 'None']);
    // The page's own "— Make a Selection —" is no answer the model is offered.
    const asked = ai.calls
      .filter((c) => c.last.includes('QUESTIONS:'))
      .map((c) => c.last)
      .join('\n');
    assert.match(asked, /level of experience or exposure to the following: FPGA/);
    assert.doesNotMatch(asked, /Make a Selection/);
    // Said as what it is, never "No fillable fields found".
    const said = await h.bg((s) => globalThis.JTFBackground.summaryText(s), r);
    assert.doesNotMatch(said, /No fillable fields/);
    // The step it is: 3 of 4, the one with the "Submit" that is yours to press.
    const [state] = await h.bg(
      async ([id, host]) => {
        const { profile } = await globalThis.JTF.store.getActive();
        const frames = await globalThis.JTFBackground.callFrames(id, 'stepState', [
          { profile, applicationHosts: [host] },
        ]);
        return frames.filter((f) => f.application);
      },
      [await h.tabId(page), ICIMS_HOST],
    );
    assert.deepEqual([state.progress.step, state.progress.total, state.final], [3, 4, true]);
    await page.close();
  } finally {
    ai.server.close();
    await h.bg(async () => {
      await globalThis.JTF.store.setAiKey('');
      await globalThis.JTF.store.saveSettings({ ai: { provider: 'openrouter', baseUrl: '', model: '' } });
    });
  }
});

test('Login: the email-first sign-in at the application’s address is a sign-in, with nothing on it for the AI', async () => {
  const { page } = await openStep('login');
  const r = await h.fill(page);
  assert.equal(r.error, undefined);
  assert.equal(r.pending, 0, 'nothing for the AI');
  const states = await h.bg(
    async ([id, host]) => {
      const { profile } = await globalThis.JTF.store.getActive();
      return globalThis.JTFBackground.callFrames(id, 'stepState', [{ profile, applicationHosts: [host] }]);
    },
    [await h.tabId(page), ICIMS_HOST],
  );
  assert.deepEqual(
    states.filter((f) => f.application).map((f) => f.frameId),
    [],
    'not a step of the application',
  );
  await page.close();
});

test('Candidate Profile: "Finish Later" keeps the application, so the step with "Next" is not the last', async () => {
  const { page } = await openStep('candidate');
  const states = await until(
    h.bg,
    async ([id, host]) => {
      const { profile } = await globalThis.JTF.store.getActive();
      const frames = await globalThis.JTFBackground.callFrames(id, 'stepState', [
        { profile, applicationHosts: [host] },
      ]);
      const steps = frames.filter((f) => f.application);
      return steps.length ? steps : null;
    },
    [await h.tabId(page), ICIMS_HOST],
  );
  assert.deepEqual([states[0].progress.step, states[0].final, states[0].next], [2, false, 'Next']);
  await page.close();
});
