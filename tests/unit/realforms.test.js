'use strict';
// Cases the detection benchmark found on real forms (tests/bench), each in the form's own words, decided the way the
// fill decides (lib/decide.js), as the benchmark's applicant: a British final-year Economics student at UCL with
// A-levels, who found the job on Trackr.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { load, desc, opts } = require('./helpers');

const { decide, fields, matcher } = load();
for (const f of ['ai', 'letter', 'answers']) require(path.join(__dirname, '..', '..', 'extension', 'lib', f + '.js'));
const { answers } = globalThis.JTF;

const TODAY = new Date('2026-10-09T12:00:00Z');

function alex() {
  const p = fields.createProfile('Alex');
  Object.assign(p.personal, { firstName: 'Alex', lastName: 'Morgan', nationality: 'British' });
  Object.assign(p.address, { city: 'London', state: 'Greater London', country: 'United Kingdom' });
  Object.assign(p.links, { github: 'https://github.com/alexmorgan-jtf' });
  Object.assign(p.job, { referralSource: 'Trackr', clearance: 'None', otherOffers: 'No' });
  p.compliance.previouslyEmployed = 'No';
  p.education = [
    {
      school: 'University College London',
      degree: 'BSc',
      field: 'Economics',
      gpa: '2:1',
      location: 'London, UK',
      startDate: '2024-09',
      endDate: '2027-06',
    },
    {
      school: 'Highbury Grove School',
      degree: 'A-levels',
      field: 'Mathematics, Further Mathematics, Economics',
      gpa: 'A*A*A',
      location: 'London, UK',
      startDate: '2017-09',
      endDate: '2023-07',
    },
  ];
  p.experience = [
    {
      company: 'Finch & Partners',
      title: 'Summer Analyst Intern',
      location: 'London',
      startDate: '2025-07',
      endDate: '2025-08',
      current: false,
    },
  ];
  return fields.upgradeProfile(p);
}

/** Each field of a page as a fill leaves it: the text that goes in, 'ai', or the action that left it empty. */
function decided(descs, p = alex(), context = {}) {
  const withheld = (item) => answers.withheld(item, '');
  return decide
    .page(descs, p, { context: { today: TODAY, jobContext: true, ...context }, withheld })
    .map((e) => (e.action === 'fill' ? e.text : e.ai ? 'ai' : e.action));
}

const yn = opts('Yes', 'No');
const radio = (question, options = yn) => desc({ question }, { kind: 'radio', options });
const typeOf = (d) => (matcher.classify(d) || {}).type || null;

test('real forms: a bar on your A-level grades, in a subject or overall, from your school entry', () => {
  // Isio
  const isio = radio(
    'Our early career opportunities within our Actuarial and Consulting team require successful candidates to have achieved an Maths A-Level grade B or higher regardless of degree subject. Please confirm if you have obtained this.',
  );
  assert.equal(typeOf(isio), 'edu.classAtLeast');
  assert.deepEqual(decided([isio]), ['Yes']);
  assert.deepEqual(decided([radio('Do you have AAB or above at A-level (or equivalent)?')]), ['Yes']);
  assert.deepEqual(decided([radio('Do you have A*A*A* or above at A-level?')]), ['No']);
  assert.deepEqual(decided([radio('Have you achieved at least an A* in A-level Mathematics?')]), ['Yes']);
  // Not one of your subjects: not the rules' to say.
  assert.notDeepEqual(decided([radio('Have you achieved a Physics A-Level grade B or higher?')]), ['Yes']);
  assert.notDeepEqual(decided([radio('Have you achieved a Physics A-Level grade B or higher?')]), ['No']);
  // A degree class is still a degree class.
  assert.deepEqual(decided([radio('Do you have or expect a 2:1 or above?')]), ['Yes']);
});

test('real forms: a role and its employer in one box, degree categories, the exact degree title after its list', () => {
  assert.deepEqual(decided([desc('17. Previous relevant role title and company (if applicable)')]), [
    'Summer Analyst Intern, Finch & Partners',
  ]);
  // Panmure Liberum
  const panmure = radio('Which of these categories best describes your degree?', [
    ...opts('Finance or Economics', 'STEM', 'Humanities or Arts', 'Other'),
  ]);
  assert.equal(typeOf(panmure), 'edu.field');
  assert.deepEqual(decided([panmure]), ['Finance or Economics']);
  // Capgemini: the list of degrees, then "Please state your exact degree title".
  const page = [
    desc(
      {
        question: 'What undergraduate or integrated master’s degree have you obtained, or are you expecting to obtain?',
      },
      { kind: 'select', options: opts('BA', 'BSc', 'BEng', 'MEng', 'Other') },
    ),
    desc('Please state your exact degree title'),
  ];
  assert.deepEqual(decided(page), ['BSc', 'BSc Economics']);
  // A student holds no degree yet.
  assert.equal(typeOf(desc('What university degree do you hold?')), null);
});

test('real forms: US clearance levels, Northern Ireland’s community monitoring, the event you heard of a job at', () => {
  // Clarity Innovates
  const clearance = desc(
    { label: 'Current clearance level' },
    {
      kind: 'combobox',
      options: opts('Non-clearable', 'Clearable', 'Public Trust', 'Secret', 'Top Secret', 'TS/SCI'),
    },
  );
  assert.deepEqual(decided([clearance]), ['Non-clearable']);
  const american = alex();
  american.personal.nationality = 'American';
  assert.notDeepEqual(decided([clearance], american), ['Non-clearable'], 'a US citizen can be cleared');

  // Isio
  const community = radio(
    'Community Background Data (Belfast, Northern Ireland applications) For Northern Ireland applications only, we are legally obliged to gather community data and gender and report to the Equality Commission.',
    opts(
      'I am a member of the Roman Catholic Community',
      'I am a member of the Protestant Community',
      'I am not a member of either the Roman Catholic or Protestant Community',
      'Please select if you are not applying for a role based in Northern Ireland',
    ),
  );
  assert.equal(typeOf(community), 'eeo.community');
  assert.deepEqual(decided([community], alex(), { jobLocation: 'Birmingham' }), [
    'Please select if you are not applying for a role based in Northern Ireland',
  ]);
  assert.deepEqual(decided([community], alex(), { jobLocation: 'Belfast' }), ['leave'], 'yours, never the AI’s');
  assert.deepEqual(decided([community]), ['leave'], 'where the job is unknown');
  assert.equal(
    matcher.isPlaceholder('please select if you are not applying for a role based in northern ireland'),
    false,
  );
  assert.equal(matcher.isPlaceholder('please select'), true);

  // Cambridge Consultants; Maven asks what you went to, which the profile doesn't say.
  const event = desc(
    { label: 'University event / society details' },
    {
      kind: 'combobox',
      options: opts('NA', 'University of Bath, Careers and Placements Fair 2026', 'University Society'),
    },
  );
  assert.equal(typeOf(event), 'job.referralEvent');
  assert.deepEqual(decided([event]), ['NA']);
  const atFair = alex();
  atFair.job.referralSource = 'University careers fair';
  assert.notDeepEqual(decided([event], atFair), ['NA']);
  assert.notEqual(
    typeOf(
      desc(
        { label: "Please select which event you attended or select 'N/A' if you did not attend" },
        { kind: 'combobox', options: opts('UCL Tech Soc Event', 'N/A') },
      ),
    ),
    'job.referralEvent',
  );
});

test('real forms: boxes that are yours to fill or leave, never the AI’s', () => {
  const page = [
    desc('Fax'),
    desc('Pager'),
    desc('Alternate Email'),
    desc('Supervisor'),
    desc('Minor'),
    radio('Did your household receive income support during your school years?'),
    desc(
      { label: '', aria: 'Email address without domain', section: 'Already working at Isio?' },
      { kind: 'textarea' },
    ),
  ];
  assert.deepEqual(page.map(typeOf), [
    'contact.other',
    'contact.other',
    'contact.other',
    'exp.supervisor',
    'edu.minor',
    'eeo.incomeSupport',
    'page',
  ]);
  assert.deepEqual(decided(page), ['leave', 'leave', 'leave', 'leave', 'leave', 'leave', 'leave']);
  // Capgemini's postgraduate questions, for someone with no postgraduate degree: nothing to give, nothing missing.
  assert.deepEqual(
    decided([
      desc('What is your postgraduate degree?'),
      radio('Is your postgraduate degree completed or still predicted?', opts('Completed', 'Predicted')),
    ]),
    ['leave', 'leave'],
  );
});

test('real forms: declarations stay yours, whatever their number or wording', () => {
  // OC&C
  const accurate = desc(
    { label: 'The information I have provided is accurate' },
    { kind: 'checkbox', options: opts('Yes') },
  );
  assert.equal(typeOf(accurate), 'consent');
  assert.equal(
    answers.withheld({ question: 'The information I have provided is accurate', kind: 'checkbox' }),
    'consent',
  );
  // Pharus (Microsoft Forms numbers its questions)
  assert.equal(
    answers.withheld({
      question: '18. I have uploaded my CV using the link below https://pharus.app.box.com/f/x',
      kind: 'radio',
    }),
    'consent',
  );
  // Netcraft
  assert.equal(
    answers.withheld({
      question: 'Please disclose below whether AI tools were used to generate all or a portion of your code sample.',
      kind: 'textarea',
    }),
    'consent',
  );
  // Dayforce's "Import Resume" box reads the CV into the form: never the CV's upload.
  assert.notEqual(
    typeOf(
      desc(
        {
          label:
            'Click Import Resume to add this information from your resume. You can also enter the information manually.',
        },
        { kind: 'file', inputType: 'file' },
      ),
    ),
    'file.resume',
  );
});

test('real forms: a follow-up whose condition the list before it rules out never goes to the AI', () => {
  const offers = radio('Do you have any other offers or deadlines?');
  const deadline = desc('If yes, please provide the applicable deadline or timeline.', { kind: 'textarea' });
  const [said, then] = decided([offers, deadline]);
  assert.equal(said, 'No');
  assert.notEqual(then, 'ai', 'after a No');
  const offered = alex();
  offered.job.otherOffers = 'Yes';
  assert.equal(decided([offers, deadline], offered)[1], 'ai', 'after a Yes');
  // Maven: a named option.
  const heard = desc(
    { label: 'How did you hear about this job?' },
    { kind: 'select', options: opts('Job board', 'A friend or relative', 'University event') },
  );
  const friend = desc("If you selected 'A friend or relative', please put their full name below");
  assert.notEqual(decided([heard, friend])[1], 'ai');
  // Voloridge: a school the list had.
  const school = desc(
    { label: 'Please select the college or university you currently attend or previously attended' },
    { kind: 'select', options: opts('Imperial College London', 'UCL (University College London)', 'Other') },
  );
  const unlisted = desc('If your institution is not listed above, please specify below');
  assert.deepEqual(
    decided([school, unlisted]).map((x) => x !== 'ai'),
    [true, true],
  );
  // Nothing chosen says nothing: the AI may still answer it.
  const unknown = desc(
    { label: 'Have you worked here before?' },
    { kind: 'select', options: opts('Option A', 'Option B') },
  );
  assert.equal(decided([unknown, deadline])[1], 'ai');
});

test('real forms: a link asked for in so many words, and what the box is called', () => {
  // Netcraft
  const netcraft = desc(
    'Please provide a sample of your code. You may share either a URL to your website or GitHub profile, or upload a file below.',
    { kind: 'textarea' },
  );
  assert.deepEqual(decided([netcraft]), ['https://github.com/alexmorgan-jtf']);
  // XY Capital: "Link to Portfolio" in a box named for GitHub.
  assert.deepEqual(decided([desc({ label: 'Link to Portfolio', name: '/candidate/socialMediaGitHub' })]), [
    'https://github.com/alexmorgan-jtf',
  ]);
});

test('real forms: school results and dates in one box, a city of its own, the US state of someone in London', () => {
  // AAB
  const results = desc(
    'Please enter the details of all Higher/A Level (or equivalent) results and dates these were achieved',
  );
  const page = [
    desc('Secondary/Academy School Dates Attended'),
    results,
    desc('University Dates Attended', { kind: 'textarea' }),
  ];
  assert.deepEqual(decided(page), [
    'September 2017 – July 2023',
    'Mathematics A*, Further Mathematics A*, Economics A (2023)',
    'September 2024 – June 2027 (expected)',
  ]);
  // Capgemini asks for no dates.
  assert.deepEqual(
    decided([
      desc(
        'Please provide your A-level, Scottish Higher, or equivalent subjects, and results. If you hold an equivalent qualification, please specify the qualification type and grades achieved',
        { kind: 'textarea' },
      ),
    ]),
    ['Mathematics A*, Further Mathematics A*, Economics A'],
  );
  // Corient (Dayforce): an education entry's "City" beside its own "Country".
  assert.deepEqual(decided([desc('School'), desc('City'), desc('G.P.A.')]).slice(0, 2), [
    'University College London',
    'London',
  ]);
  // DV Trading: nothing for someone who lives in London.
  assert.notDeepEqual(decided([desc('If applicable, which US state do you reside in?')]), ['Greater London']);
});

test('real forms: working there now or before, a primary language, a degree status, a name you would prefer', () => {
  assert.deepEqual(decided([radio('Do you currently work for us?')]), ['No']); // FDM
  const before = alex();
  before.compliance.previouslyEmployed = 'Yes';
  assert.notDeepEqual(decided([radio('Do you currently work for us?')], before), ['Yes'], 'worked there once, not now');
  assert.deepEqual(decided([radio('Have you previously completed an internship or work placement at Capgemini UK?')]), [
    'No',
  ]);
  // SpaceX
  const history = desc(
    { label: 'SpaceX & SpaceXAI Employment History' },
    {
      kind: 'combobox',
      options: opts(
        'I have never worked for SpaceX, SpaceXAI, xAI, X, or Twitter',
        'I am a former SpaceX, SpaceXAI, xAI, X, or Twitter employee',
        'I am a current SpaceX employee',
      ),
    },
  );
  assert.deepEqual(decided([history]), ['I have never worked for SpaceX, SpaceXAI, xAI, X, or Twitter']);
  // Cambridge Associates: the first language you list.
  const p = alex();
  p.languages = 'English, Spanish';
  const primary = desc(
    { label: 'Is English your primary language?' },
    {
      kind: 'combobox',
      options: opts(
        'Yes, English is my primary language',
        'No, English is my secondary language but I feel just as proficient in English as my primary language',
        'I prefer not to say',
      ),
    },
  );
  assert.deepEqual(decided([primary], p), ['Yes, English is my primary language']);
  // Pharus (Microsoft Forms), on 9 October 2026 with the degree ending in June 2027.
  assert.deepEqual(decided([radio('11. Degree Status', opts('Graduated', 'Final Year', 'Other answer'))]), [
    'Final Year',
  ]);
  // Isio: the name, not a yes or no.
  p.personal.preferredName = 'Alex';
  assert.deepEqual(decided([desc('Do you have a name you would prefer to use?')], p), ['Alex']);
});

test('real forms: the site’s own search and language picker, and a list’s box for its "Other"', () => {
  assert.deepEqual(decided([desc('Search jobs, skills or qualifications')]), ['leave']); // BCG
  assert.deepEqual(
    decided([
      desc({ label: 'Select language, current: English' }, { kind: 'combo', options: opts('English', 'Deutsch') }),
    ]),
    ['leave'],
  ); // redalpine
  // Carlsquare: the example names a referrer, the box is the list's.
  const heard = desc(
    { label: 'How did you hear about us?' },
    { kind: 'select', options: opts('LinkedIn', 'Referral', 'Event', 'Other') },
  );
  assert.deepEqual(decided([heard, desc("Additional Details (e.g., Referrer's Name/Event)")]), ['Other', 'Trackr']);
  // SpaceX: "(f) Other" keeps its letter once normalised.
  const citizenship = desc(
    { label: 'Citizenship Status' },
    {
      kind: 'combobox',
      options: opts(
        '(a) U.S. citizen or national of the United States',
        '(b) U.S. lawful permanent resident',
        '(f) Other (please explain)',
      ),
    },
  );
  const [status, explained] = decided([citizenship, desc('If (f) Other, please explain')]);
  assert.equal(status, '(f) Other (please explain)');
  assert.match(explained, /British/);
});
