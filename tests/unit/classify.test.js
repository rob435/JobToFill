'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, desc, opts } = require('./helpers');

const { matcher, fields, util } = load();
const typeOf = (d) => {
  const r = matcher.classify(d);
  return r ? r.type + (r.part ? ':' + r.part : '') : null;
};

test('labels on text inputs', () => {
  const cases = {
    'First Name *': 'name.first',
    'Given name': 'name.first',
    'Last Name': 'name.last',
    Surname: 'name.last',
    'Family name': 'name.last',
    'Middle name': 'name.middle',
    Name: 'name.full',
    'Full name': 'name.full',
    'Your name': 'name.full',
    'Legal name': 'name.full',
    'Preferred First Name': 'name.preferred',
    Nickname: 'name.preferred',
    'Preferred name': 'name.preferred',
    'Preferred full name': 'name.preferred',
    'Preferred Name (optional)': 'name.preferred',
    'Name you go by': 'name.preferred',
    'Known as': 'name.preferred',
    'Display name': 'name.preferred',
    'What should we call you?': 'name.preferred',
    'Nom d’usage': 'name.preferred',
    'Bevorzugter Name': 'name.preferred',
    'Nombre preferido': 'name.preferred',
    'Gender pronouns': 'pronouns',
    'Preferred pronouns': 'pronouns',
    'Legal first name': 'name.first',
    'Full legal name': 'name.full',
    'Name as on passport': 'name.full',
    'Legal last name': 'name.last',
    Email: 'email',
    'E-mail address': 'email',
    'Confirm email': 'email',
    Phone: 'phone',
    'Mobile number': 'phone',
    Telephone: 'phone',
    Address: 'address.line1',
    'Street address': 'address.line1',
    'Address Line 1': 'address.line1',
    'Address Line 2': 'address.line2',
    'Apartment, suite, etc.': 'address.line2',
    City: 'address.city',
    'Town / City': 'address.city',
    State: 'address.state',
    Province: 'address.state',
    'ZIP code': 'address.postalCode',
    Postcode: 'address.postalCode',
    'Zip / Postal Code': 'address.postalCode',
    Country: 'address.country',
    'Location (City)': 'location',
    'Current location': 'location',
    'LinkedIn Profile': 'links.linkedin',
    'LinkedIn URL': 'links.linkedin',
    GitHub: 'links.github',
    'Portfolio URL': 'links.portfolio',
    Website: 'links.website',
    'Personal website': 'links.website',
    Twitter: 'links.twitter',
    School: 'edu.school',
    University: 'edu.school',
    'College or University': 'edu.school',
    GPA: 'edu.gpa',
    'Field of study': 'edu.field',
    Major: 'edu.field',
    Company: 'exp.company',
    Employer: 'exp.company',
    'Job title': 'exp.title',
    Title: 'exp.title',
    'Current company': 'job.currentCompany',
    'Current title': 'job.currentTitle',
    'Years of experience': 'job.yearsExperience',
    'Desired salary': 'job.salary',
    'Salary expectations': 'job.salary',
    'Notice period': 'job.noticePeriod',
    'When can you start?': 'job.startDate',
    Pronouns: 'pronouns',
    Skills: 'skills',
    Username: 'account.username',
    'Card number': 'cc.number',
    'Name on card': 'cc.name',
    'Cardholder name': 'cc.name',
    CVV: 'cc.cvc',
    'Security code': 'cc.cvc',
    'Expiration date': 'cc.exp',
    'Expiry month': 'cc.exp:month',
    'Expiry year': 'cc.exp:year',
    'Graduation year': 'edu.end:year',
    'Start date': 'gen.start',
    'End date': 'gen.end',
    From: 'gen.start',
    To: 'gen.end',
  };
  for (const [label, want] of Object.entries(cases)) assert.equal(typeOf(desc(label)), want, label);
});

test('things that are not personal fields are left alone', () => {
  for (const label of [
    'Referrer name',
    'Emergency contact name',
    'Hiring manager email',
    'Company website',
    'Search',
    'Coupon code',
    'Passport expiration date',
    'Additional information',
    'Name of your previous manager',
    'Why do you want to work here?',
  ]) {
    const t = typeOf(desc(label));
    assert.ok(!t || !/^(name\.|email|cc\.|links\.website)/.test(t), `${label} -> ${t}`);
  }
});

test('long screening questions', () => {
  const sel = (label) => typeOf(desc({ question: label }, { kind: 'radio', options: opts('Yes', 'No') }));
  assert.equal(sel('Are you legally authorized to work in the United States?'), 'job.authorized');
  assert.equal(
    sel('Will you now or in the future require sponsorship for employment visa status (e.g., H-1B visa status)?'),
    'job.sponsorship',
  );
  assert.equal(
    sel('Are you legally authorized to work in the country in which the job is located without sponsorship?'),
    'job.authorized',
  );
  assert.equal(sel('Are you willing to relocate to New York City?'), 'job.relocate');
  assert.equal(sel('Are you at least 18 years of age?'), 'job.over18');
  assert.equal(sel('How did you hear about this job? (e.g. LinkedIn, company website)'), 'job.referralSource');
  assert.equal(sel('Are you Hispanic/Latino?'), 'eeo.hispanic');
  assert.equal(sel('Veteran Status'), 'eeo.veteran');
  assert.equal(sel('Do you have a disability?'), 'eeo.disability');
  assert.equal(sel('Gender'), 'eeo.gender');
  assert.equal(sel('Race/Ethnicity'), 'eeo.race');
});

test('name attributes and ATS automation ids', () => {
  assert.equal(typeOf(desc({ name: 'job_application[first_name]' })), 'name.first');
  assert.equal(typeOf(desc({ name: 'urls[LinkedIn]' })), 'links.linkedin');
  assert.equal(typeOf(desc({ name: 'urls[GitHub]' })), 'links.github');
  assert.equal(typeOf(desc({ name: 'org' })), 'job.currentCompany');
  assert.equal(typeOf(desc({ name: 'name' })), 'name.full');
  assert.equal(typeOf(desc({ attrs: 'legalNameSection_firstName' })), 'name.first');
  assert.equal(typeOf(desc({ attrs: 'addressSection_countryRegion' }, { kind: 'combo' })), 'address.state');
  assert.equal(typeOf(desc({ attrs: 'addressSection_postalCode' })), 'address.postalCode');
  assert.equal(
    typeOf(
      desc({
        aria: 'Month',
        placeholder: 'MM',
        attrs: 'dateSectionMonth-input',
        ancestors: 'formField-startDate workExperience-1',
      }),
    ),
    'gen.start:month',
  );
  assert.equal(typeOf(desc({ aria: 'Year', placeholder: 'YYYY', ancestors: 'formField-endDate' })), 'gen.end:year');
  assert.equal(
    typeOf(desc({ label: 'Name', name: 'first_name' })),
    'name.first',
    'specific name attribute beats a generic "Name" label',
  );
  assert.equal(
    typeOf(desc({ label: 'Phone', name: 'phone_country_code' }, { kind: 'select', options: opts('+1', '+44') })),
    'phone.countryCode',
  );
});

test('autocomplete attributes win, but not the new-password trick', () => {
  assert.equal(typeOf(desc({ label: 'Something odd' }, { autocomplete: 'shipping given-name' })), 'name.first');
  assert.equal(typeOf(desc({}, { autocomplete: 'cc-exp-month', kind: 'select' })), 'cc.exp:month');
  assert.equal(typeOf(desc({}, { autocomplete: 'section-a billing postal-code' })), 'address.postalCode');
  assert.equal(typeOf(desc({ label: 'City' }, { autocomplete: 'new-password' })), 'address.city');
  assert.equal(typeOf(desc({ label: 'City' }, { autocomplete: 'off' })), 'address.city');
});

test('input types constrain the guess', () => {
  assert.equal(typeOf(desc({ label: 'Contact' }, { kind: 'email' })), 'email');
  assert.equal(typeOf(desc({ label: 'Website' }, { kind: 'email' })), 'email');
  assert.equal(typeOf(desc({}, { kind: 'tel' })), 'phone');
  assert.equal(typeOf(desc({ label: 'Password' }, { kind: 'password' })), 'account.password');
  assert.equal(typeOf(desc({ label: 'Confirm password' }, { kind: 'password' })), 'account.passwordConfirm');
  assert.equal(typeOf(desc({ label: 'Re-enter password' }, { kind: 'password' })), 'account.passwordConfirm');
  assert.equal(typeOf(desc({}, { kind: 'password' })), 'account.password');
  assert.equal(typeOf(desc({ label: 'Resume/CV' }, { kind: 'file' })), 'file.resume');
  assert.equal(typeOf(desc({ label: 'Cover Letter' }, { kind: 'file' })), 'file.coverLetter');
  assert.equal(typeOf(desc({ label: 'Profile photo' }, { kind: 'file' })), null);
  assert.equal(typeOf(desc({ label: 'Cover letter' }, { kind: 'textarea' })), 'coverLetter');
  assert.equal(typeOf(desc({ label: 'First name' }, { kind: 'file' })), null);
});

test('single checkboxes: yes/no questions, acknowledgements, one option of a checklist', () => {
  const box = (signals) => typeOf(desc(signals, { kind: 'checkbox' }));
  assert.equal(box({ label: 'I currently work here' }), 'exp.current');
  assert.equal(box({ label: 'I am legally authorized to work in the US' }), 'job.authorized');
  assert.equal(box({ label: 'I confirm I am authorised to work in the UK' }), 'job.authorized');
  // Acknowledgements are recognised (and only ticked when the setting is on)…
  assert.equal(box({ label: 'I agree to the terms and conditions' }), 'consent');
  assert.equal(
    box({
      label: 'Acknowledge/Confirm',
      question: 'Review our Notice at Collection to learn how we will process your personal data.',
    }),
    'consent',
  );
  assert.equal(box({ label: 'I have read and understood the candidate privacy notice' }), 'consent');
  // …but marketing and talent-pool opt-ins never are.
  assert.equal(box({ label: 'Email me job alerts' }), null);
  assert.equal(box({ label: 'I agree to receive marketing emails' }), null);
  assert.equal(box({ label: 'I consent to being contacted about future opportunities' }), null);
  assert.equal(box({ label: 'Join our talent community' }), null);
  assert.equal(
    box({ label: 'London', question: 'Which other locations are you interested in relocating to?' }),
    'job.locations',
  );
});

test('application questions whose wording used to slip through', () => {
  const sel = (label, ...options) =>
    typeOf(desc({ label }, { kind: 'combobox', options: options.length ? opts(...options) : null }));
  assert.equal(sel('What degree are you currently pursuing?', 'Bachelor’s', 'Master’s', 'PhD'), 'edu.degree');
  assert.equal(sel('What degree are you currently pursuing?'), 'edu.degree');
  assert.equal(sel('Which degree are you studying for?'), 'edu.degree');
  assert.equal(sel('Type of degree'), 'edu.degree');
  assert.notEqual(sel('Are you currently pursuing a degree?', 'Yes', 'No'), 'edu.degree');
  assert.notEqual(sel('What degree are you currently pursuing?', 'Yes', 'No'), 'edu.degree');
  assert.equal(sel('What is your expected graduation date?'), 'edu.end');
  assert.equal(sel('When do you expect to graduate?'), 'edu.end');
  assert.equal(sel('Please select your current school from the list below:'), 'edu.school');
  assert.equal(sel('Which is your preferred internship location?'), 'job.locations');
  assert.equal(sel('Preferred office location'), 'job.locations');
  assert.equal(sel('Where would you like to work?'), 'job.locations');
  assert.equal(sel('Are you willing to relocate?'), 'job.relocate');
  assert.equal(sel('Location (City)'), 'location');
  assert.equal(
    sel('Do you currently have any offers from other firms or deadlines we should be aware of?'),
    'job.otherOffers',
  );
  assert.equal(sel('If you said yes above, please tell us about your offers and deadlines.'), 'job.otherOffers');
  assert.equal(sel('Non-compete/Notice period comments'), 'job.nonCompete');
  assert.equal(sel('Are you subject to a non-compete agreement?'), 'job.nonCompete');
  assert.equal(sel('Notice period'), 'job.noticePeriod');
  assert.equal(
    typeOf(
      desc(
        {
          question:
            'Other than the location posted for this role, please indicate which other locations you are interested in relocating to:',
        },
        { kind: 'checkboxes', options: opts('Chicago', 'New York', 'London') },
      ),
    ),
    'job.locations',
  );
  assert.equal(
    typeOf(
      desc(
        { question: 'Which programming languages do you use?' },
        { kind: 'checkboxes', options: opts('Python', 'C++') },
      ),
    ),
    'skills',
  );
  assert.notEqual(sel('What is your favourite programming language?'), 'skills');
});

test('uploads: an "Attach" button takes its meaning from its group, id or name', () => {
  const file = (signals) => typeOf(desc(signals, { kind: 'file' }));
  assert.equal(file({ label: 'Attach', question: 'Resume/CV', id: 'resume' }), 'file.resume');
  assert.equal(file({ label: 'Attach', question: 'Cover Letter', id: 'cover_letter' }), 'file.coverLetter');
  assert.equal(file({ label: 'Attach', id: 'cover_letter' }), 'file.coverLetter');
  assert.equal(file({ label: 'Upload', name: 'transcript' }), 'file.transcript');
  assert.equal(file({ label: 'Attach' }), 'file.resume');
});

test('a country picker inside a "Phone" group is the dialling code', () => {
  assert.equal(typeOf(desc({ label: 'Country', group: 'Phone' }, { kind: 'combobox' })), 'phone.countryCode');
  assert.equal(typeOf(desc({ label: 'Country', group: 'Address' }, { kind: 'combobox' })), 'address.country');
});

test('options refine the guess', () => {
  assert.equal(
    typeOf(desc({ label: 'Title' }, { kind: 'select', options: opts('Mr', 'Mrs', 'Ms', 'Dr') })),
    'name.prefix',
  );
  assert.equal(
    typeOf(
      desc(
        { label: 'Country' },
        { kind: 'select', options: opts('United States (+1)', 'United Kingdom (+44)', 'India (+91)') },
      ),
    ),
    'phone.countryCode',
  );
  const months = opts(
    'Month',
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  );
  assert.equal(typeOf(desc({ label: 'Start date' }, { kind: 'select', options: months })), 'gen.start:month');
  assert.equal(
    typeOf(desc({ label: 'Start date' }, { kind: 'select', options: opts('2020', '2021', '2022', '2023') })),
    'gen.start:year',
  );
  assert.equal(typeOf(desc({ label: 'Date of birth', placeholder: 'DD/MM/YYYY' })), 'dob');
});

test('student and graduate-scheme questions', () => {
  const ask = (label, kind, options) =>
    typeOf(desc({ question: label }, { kind: kind || 'text', options: options ? opts(...options) : null }));
  const years = ['1st year', '2nd year', 'Final year'];
  assert.equal(ask('When does your course finish?'), 'edu.end');
  assert.equal(ask('When are you graduating?'), 'edu.end');
  assert.equal(ask('Did you graduate?', 'radio', ['Yes', 'No']), null);
  assert.equal(ask('High school graduation year'), null, 'school leaving year is not your degree');
  assert.equal(ask('A level completion year'), null);
  assert.equal(ask('What year of study are you in?', 'select', years), 'edu.year');
  assert.equal(ask('Current year of study', 'select', years), 'edu.year');
  assert.equal(ask('Class standing', 'select', ['Freshman', 'Sophomore', 'Junior', 'Senior']), 'edu.year');
  assert.equal(ask('Year of university entry', 'select'), null, 'the year you started is not your year of study');
  assert.equal(ask('Degree classification', 'select', ['First', '2:1', '2:2']), 'edu.classification');
  assert.equal(ask('Predicted degree class', 'select', ['First', '2:1', '2:2']), 'edu.classification');
  // Social-mobility questions mention "school" but ask about your background, not your university.
  assert.equal(ask('Did you receive free school meals?', 'select', ['Yes', 'No']), 'eeo.freeSchoolMeals');
  assert.equal(
    ask('What type of school did you attend between the ages of 11 and 16?', 'select', [
      'State-run or state-funded school',
      'Independent or fee-paying school',
    ]),
    'eeo.schoolType',
  );
  assert.equal(ask('I confirm that I will graduate in 2027', 'radio', ['Yes', 'No']), 'edu.end');
  assert.equal(ask('I confirm that I will graduate in 2027', 'checkbox'), 'edu.end');
  assert.equal(
    ask(
      'Tell us about a time you used university resources to solve a problem in your school or college life',
      'textarea',
    ),
    null,
    'an essay question is not the school name',
  );
});

test('work history, start dates and locations', () => {
  const ask = (label, kind, options) =>
    typeOf(desc({ question: label }, { kind: kind || 'text', options: options ? opts(...options) : null }));
  assert.equal(ask('Employment start date'), 'exp.start');
  assert.equal(ask('Employment end date'), 'exp.end');
  assert.equal(ask('Employer location'), 'exp.location');
  assert.equal(ask('Company city'), 'exp.location');
  assert.equal(ask('Preferred employment start date'), null);
  assert.equal(ask('Is your contract open ended?', 'textarea'), null);
  assert.equal(ask('Preferred start date'), 'job.startDate');
  assert.equal(ask('Start date for the internship'), 'job.startDate');
  assert.equal(ask('When are you able to start?'), 'job.startDate');
  assert.equal(ask('When will you be available to start?'), 'job.startDate');
  assert.equal(ask('Where would you be willing to relocate?', 'select'), 'job.locations');
  assert.equal(ask('How did you connect with us?', 'select'), 'job.referralSource');
});

test('contact and identity questions that only look like personal fields', () => {
  const ask = (label, kind, options) =>
    typeOf(desc({ question: label }, { kind: kind || 'text', options: options ? opts(...options) : null }));
  assert.equal(ask('Business phone'), null);
  assert.equal(ask('Company phone number'), null);
  assert.equal(ask('I consent to receive SMS text messages to my phone', 'checkbox'), null);
  assert.equal(ask('State'), 'address.state');
  assert.equal(ask('Please state your notice period'), 'job.noticePeriod');
  assert.equal(ask('Please state any reasonable adjustments you require', 'textarea'), null);
  assert.equal(ask('Nationality', 'select'), 'nationality');
  assert.equal(ask('Do you hold any other citizenships?', 'select', ['Yes', 'No']), null);
  assert.equal(ask('Dual nationality'), null);
  assert.equal(ask('Pronouns'), 'pronouns');
  assert.equal(ask('How do you pronounce your name?'), null, 'neither your pronouns nor your name');
  assert.equal(ask('Name pronunciation'), null);
  assert.equal(ask('Has a bonding company ever denied you coverage?', 'select', ['Yes', 'No']), null);
  // The box for "Other" is for an answer the profile doesn't have.
  assert.equal(ask('If you selected Other, please specify'), null);
  assert.equal(ask('Other, please specify'), null);
  assert.equal(ask('If other, please state'), null);
  // A word in the help text alone is not enough.
  assert.equal(typeOf(desc({ label: 'Tell us more', describedby: 'Please follow your university policy' })), null);
});

test('skills and spoken languages', () => {
  const ask = (label, kind, options) =>
    typeOf(desc({ question: label }, { kind: kind || 'text', options: options ? opts(...options) : null }));
  assert.equal(ask('Which languages are you fluent in?'), 'languages');
  assert.equal(ask('Language fluency'), 'languages');
  assert.equal(ask('What programming languages do you know?'), 'skills');
  assert.equal(ask('What is your level of Python?', 'select'), null);
  assert.equal(ask('How proficient are you with Excel?', 'select'), null);
  assert.equal(
    ask('Do you have programming experience with any of the following?', 'checkboxes', ['Python', 'C++']),
    'skills',
  );
});

test('acknowledgements can be dropdowns too', () => {
  assert.equal(
    typeOf(
      desc(
        { question: 'Please review our privacy notice and confirm' },
        { kind: 'select', options: opts('I confirm') },
      ),
    ),
    'consent',
  );
  for (const answer of ['I confirm', 'Acknowledged', 'I accept', 'Agree', 'I understand', 'Confirmed'])
    assert.equal(matcher.canonicalOf(answer), 'yes', answer);
});

test('real screening questions from graduate application forms', () => {
  const ask = (label, kind, options) =>
    typeOf(desc({ label, aria: label }, { kind: kind || 'combobox', options: options ? opts(...options) : null }));
  // Schools picked from a list, asked as a question.
  assert.equal(ask('Which university are you currently attending? Select "Other" if not listed'), 'edu.school');
  assert.equal(ask('Please re-confirm the university you currently attend'), 'edu.school');
  assert.equal(ask('Which institution do you currently attend/have most recently attended?'), 'edu.school');
  assert.equal(ask('What school do you currently attend?'), 'edu.school');
  assert.equal(
    ask('Are you currently enrolled at a university?', 'select', ['Yes', 'No']),
    'edu.enrolled',
    'not a school',
  );
  assert.equal(ask('Have you attended a university?'), null);
  assert.equal(ask('Please specify the grading scale used by your current school.'), null);
  // Not a sponsorship, relocation or salary question just because a word appears.
  assert.equal(
    ask(
      'If you require any support or adjustments during the recruitment process for any reason including those related to a disability, please indicate here and we will be in contact. This does NOT include questions related to visa sponsorship or our recruitment timelines.',
    ),
    'job.adjustments',
  );
  assert.equal(
    ask(
      'Do you require any reasonable adjustments or accommodations to participate in the recruitment process? (i.e extra time on assessments, relocation of interview venue)',
    ),
    'job.adjustments',
  );
  assert.equal(ask('Are you willing to work in the office 5-days a week?'), 'job.onsite');
  assert.equal(ask('Are you comfortable being onsite 5 days a week at our Needham, MA Headquarters?'), null);
  assert.equal(
    ask(
      'We have several job paths as part of our QTA program. To help us understand which path(s) is/are best for you, which of these statements best describes your interest in CTC?',
    ),
    null,
  );
  assert.equal(ask('Expected CTC', 'text'), 'job.salary');
  assert.equal(ask('Are you available to work full-time for 6 consecutive months?'), null);
  assert.equal(
    ask('Are you able to work on-site at our Jupiter, FL office for a 10-week Summer 2027 internship?'),
    null,
  );
  assert.equal(ask('Are you legally able to work in the UK?'), 'job.authorized');
  assert.equal(
    ask(
      'Do you have the right to work in the United States? Rothesay will not sponsor a work visa for this internship.',
    ),
    'job.authorized',
  );
  assert.equal(
    ask('Can you perform all of the essential functions of this role with or without reasonable accommodations?'),
    null,
  );
  // A yes/no question is never answered with a name, a username or a subject.
  assert.equal(
    ask(
      'Are you related to anyone now working for Graham or anyone who has previously worked for Graham? If yes, list (name, relationship)',
      'text',
    ),
    'compliance.relatives',
    'never a name: answered from "Relatives working here"',
  );
  assert.equal(
    ask(
      'Do you have an immediate family member or domestic partner employed by Ernst & Young, that engages in audit work?',
      'text',
    ),
    null,
  );
  assert.equal(
    ask(
      'Are you currently pursuing a Major in one of the following disciplines: Computer Science or Computer Engineering',
    ),
    null,
  );
  assert.equal(
    ask('Do you have a GitHub profile? Please share the link', 'text'),
    'links.github',
    'a link box is still a link box',
  );
});

test('education questions from graduate application forms', () => {
  const ask = (label, kind, options) =>
    typeOf(desc({ label, aria: label }, { kind: kind || 'combobox', options: options ? opts(...options) : null }));
  assert.equal(
    ask('Please select all fields of study that closely align with your education background', 'checkboxes', [
      'Statistics',
      'Mathematics',
      'Computer Science',
    ]),
    'edu.field',
  );
  assert.equal(ask('Please select your Subjects(s)', 'checkboxes', ['Computer Science', 'Mathematics']), 'edu.field');
  assert.equal(ask('For your most recent degree, what is/was your GPA (normalized to a 4.0 scale)?'), 'edu.gpa');
  assert.equal(ask('GPA (Graduate)'), 'edu.gpa');
  assert.equal(ask('Undergraduate GPA', 'text'), 'edu.gpa');
  assert.equal(
    ask('What is your graduation year (class of 2030 and 2031 undergraduate degrees will not be considered)?'),
    'edu.end:year',
  );
  assert.equal(ask('Are you an undergraduate student?', 'select', ['Yes', 'No']), null);
  assert.equal(ask('What year do you plan on finishing your university studies?'), 'edu.end:year');
  assert.equal(ask('In which year will you/ did you leave academia?'), 'edu.end:year');
  assert.equal(ask('Please indicate the maximum possible score/GPA at your institution, if applicable.', 'text'), null);
  assert.equal(
    ask('What are you on track to receive/ did you receive in your Undergraduate degree?', 'select', [
      'First Class',
      'Upper-Second Class',
      'Lower-Second Class',
      'Third Class',
    ]),
    'edu.classification',
  );
  assert.equal(ask('What is the approximate date that you could start?', 'text'), 'job.startDate');
  assert.equal(
    ask('Please indicate the employer or organization of your most recent working experience.', 'text'),
    'job.currentCompany',
  );
  assert.equal(
    ask('Indicate the title of your most recent work experience, if applicable.', 'text'),
    'job.currentTitle',
  );
});

test('acknowledgements, demographics and answers given by the options', () => {
  const ask = (label, kind, options) =>
    typeOf(desc({ label, aria: label }, { kind: kind || 'combobox', options: options ? opts(...options) : null }));
  assert.equal(ask('Candidate Confidentiality Agreement'), 'consent');
  assert.equal(ask('Recruitment Privacy Notice', 'select', ['Acknowledge']), 'consent');
  assert.equal(ask('Privacy Notice', 'checkboxes', ['Acknowledge']), 'consent');
  assert.equal(ask('Essay portion: answer at least 2 of the 3 essays below', 'select', ['I understand']), 'consent');
  assert.equal(
    ask('Programme', 'select', ['Summer Internship']),
    null,
    'one option is not an acknowledgement by itself',
  );
  for (const answer of ['Acknowledge/Confirm', 'I acknowledge and agree', 'Acknowledge & Agree', 'Understood'])
    assert.equal(matcher.canonicalOf(answer), 'yes', answer);
  assert.equal(
    ask('Voluntary Demographic Questions (for applicants residing in the UK ONLY)', 'select', [
      'Male',
      'Female',
      'Prefer not to say',
    ]),
    'eeo.gender',
  );
  assert.equal(ask('Age', 'select', ['16 - 17', '18 - 21', '22 - 30']), 'age');
  assert.equal(ask('What is your age range?'), 'age');
  assert.equal(ask('Average deal size'), null);
});

test('help text and wrapper ids do not make a phone field', () => {
  assert.equal(
    typeOf(
      desc({
        label: 'Start your job search here',
        placeholder: 'Enter keywords here',
        name: 'searchKeyword',
        ancestors: 'advanced_search_filters_mobile_modal_no_show',
      }),
    ),
    null,
  );
  assert.equal(
    typeOf(
      desc({
        label:
          'Mobile Number (required) For international numbers, start with a + and then the country code, followed by the phone number.',
      }),
    ),
    'phone',
  );
  assert.equal(typeOf(desc({ label: 'Phone number (including country code)' })), 'phone');
  assert.equal(
    typeOf(desc({ label: 'Country code' }, { kind: 'select', options: opts('+1', '+44') })),
    'phone.countryCode',
  );
});

test('salary currency and pay period boxes are not the salary; a green card is not a payment card', () => {
  const currencies = opts('US Dollar ($)', 'Canadian Dollar ($)', 'Euro (€)', 'British Pound (£)');
  assert.equal(
    typeOf(
      desc(
        { nearby: 'Desired Salary', name: 'salaryCurrency', attrs: 'candidate.salary.currency' },
        { kind: 'select', options: currencies },
      ),
    ),
    null,
  );
  assert.equal(
    typeOf(
      desc({ attrs: 'candidate.salary.period' }, { kind: 'select', options: opts('Hourly', 'Monthly', 'Yearly') }),
    ),
    null,
  );
  assert.equal(typeOf(desc({ label: 'Desired Salary Type' }, { kind: 'combo' })), null);
  assert.equal(typeOf(desc({ placeholder: 'Desired Salary', name: 'cSalary' })), 'job.salary');
  assert.equal(
    typeOf(
      desc(
        { label: 'Are you a US citizen or lawful permanent resident (green card holder)?' },
        { kind: 'select', options: opts('Yes', 'No') },
      ),
    ),
    'citizen',
    'answered from your nationality, never a card field',
  );
});

test('salary ranges in a dropdown are still the salary', () => {
  assert.equal(
    typeOf(
      desc({ label: 'Salary expectations' }, { kind: 'select', options: opts('$80k-$120k', '$120k-$160k', '$160k+') }),
    ),
    'job.salary',
  );
});

test('an "Autofill from resume" upload is not the resume field', () => {
  const file = (signals) => typeOf(desc(signals, { kind: 'file' }));
  assert.equal(
    file({ nearby: 'Autofill from resume Upload your resume here to autofill key application fields.' }),
    null,
  );
  assert.equal(
    file({ nearby: "Apply with resume Upload your resume and we'll automatically fill out your application" }),
    null,
  );
  assert.equal(file({ label: 'Resume' }), 'file.resume');
});

test("an employer's location or address is the job's, not yours", () => {
  assert.equal(typeOf(desc('Employer Location (City, State, Zip)')), 'exp.location');
  assert.equal(typeOf(desc('Employer Address')), 'exp.location');
  assert.equal(typeOf(desc('Company city')), 'exp.location');
  assert.equal(typeOf(desc('State')), 'address.state');
  assert.equal(typeOf(desc('Street address')), 'address.line1');
});

test('Ashby UK internship form: right to work, graduation window, parents, AI policy', () => {
  const yn = ['Yes', 'No'];
  const ask = (label, kind, options) =>
    typeOf(desc({ question: label }, { kind: kind || 'radio', options: options ? opts(...options) : null }));
  assert.equal(
    ask(
      'Do you have the right to work in the region? This role will be in the office 5 days a week. Work authorization in the internship location is required. Sponsorship for internships is not available at this time.',
      'radio',
      yn,
    ),
    'job.authorized',
  );
  assert.equal(ask('Are you able to work in the UK without restrictions?', 'radio', yn), 'job.authorized');
  assert.equal(
    ask('Are you currently a university student who will graduate Fall of 2027 or Spring 2028?', 'radio', yn),
    'edu.end',
  );
  assert.equal(ask('Are you a recent graduate?', 'radio', yn), null);
  assert.equal(
    ask('What is the highest level of education completed by either of your parents or guardians?', 'radio', [
      'Primary school or below',
      'Secondary school (High school)',
      "Bachelor's degree (University undergraduate degree)",
    ]),
    'eeo.parentsDegree',
  );
  assert.equal(
    ask(
      'AI Policy for Application While we support the use of AI tools to enhance productivity in your role, we ask that you refrain from using AI assistants during the application process.',
      'radio',
      yn,
    ),
    null,
  );
});

test('round 2 (US tech / EU finance Greenhouse forms): what each question really asks', () => {
  const yn = ['Yes', 'No'];
  const ask = (label, kind, options) =>
    typeOf(desc({ label }, { kind: kind || 'combobox', options: options ? opts(...options) : null }));
  // SpaceX: a "Portfolio" upload (button "Attach") is not the CV; the CV upload still is.
  assert.equal(
    typeOf(desc({ label: 'Attach', question: 'Portfolio', id: 'question_37206157002' }, { kind: 'file' })),
    null,
  );
  assert.equal(typeOf(desc({ label: 'Attach', question: 'Resume/CV', id: 'resume' }, { kind: 'file' })), 'file.resume');
  assert.equal(typeOf(desc({ label: 'Resume / portfolio' }, { kind: 'file' })), 'file.resume');
  // "How much experience in C programming language do you have?" {Less than 3 months…} is not your skills list.
  assert.equal(ask('How much experience in C++ programming language do you have?'), null);
  assert.equal(ask('Which programming languages do you know?', 'checkboxes', ['Python', 'C++']), 'skills');
  assert.equal(ask('Please select the month you will be able to start your internship.'), 'job.startDate:month');
  assert.equal(ask('Answer Certification', 'combobox', yn), 'consent');
  assert.equal(ask('What is your highest level of completed education?'), 'edu.level');
  // Anduril: "…technology that is subject to U.S. export controls" is not a field of study.
  assert.equal(
    ask(
      'EXPORT CONTROLS - This position requires access to information and technology that is subject to U.S. export controls.',
    ),
    null,
  );
  assert.equal(
    ask('Language Skill(s) (Check all that apply)', 'checkboxes', ['English (ENG)', 'French (FRA)']),
    'languages',
  );
  assert.equal(ask('Additional languages', 'combobox'), 'languages');
  // Palantir: the hint to pick "Other" belongs to the school question itself.
  assert.equal(
    ask(
      'Which university are you currently attending or did you last attend? Please select "Other (School Not Listed)" if your school is not listed.',
      'select',
      ['Aalborg University', 'Other (School Not Listed)'],
    ),
    'edu.school',
  );
  assert.equal(ask('If your school is not listed, please enter it here', 'text'), null);
  // KKR: Yes/No questions mentioning portfolio companies; a polite request is not a yes/no question.
  assert.equal(
    ask('Have you interviewed with KKR, its affiliates or any of its portfolio companies in the past?', 'combobox'),
    null,
  );
  assert.equal(ask('Do you have a portfolio? Please share the link', 'text'), 'links.portfolio');
  assert.equal(
    ask("Could you please provide your Bachelor's degree classification?", 'combobox'),
    'edu.classification',
  );
  assert.equal(ask('Could you relocate to London?', 'combobox', yn), 'job.relocate');
  // Examples don't say what the question asks for.
  assert.equal(
    ask(
      'Please share what you are actively involved in outside of the classroom. For example: student clubs, partner organizations, research, work study',
      'text',
    ),
    null,
  );
  assert.equal(
    ask('Are you fluent in French? (Please note this is a requirement for this role)', 'radio', yn),
    'languages',
  );
  assert.equal(ask('Do you speak any languages?', 'radio', yn), null);
  // William Blair: the facts come first, the question after them.
  assert.equal(
    ask(
      'The internship is a 3 month placement running from 1 July to 30 September 2027. Can you confirm that you are available to work on a full-time basis for the duration of the internship?',
      'combobox',
      yn,
    ),
    'job.startDate',
  );
});

test('round 2 (Ashby / Gemini): combined uploads, acknowledgement checklists, SMS opt-ins, school questions', () => {
  const ask = (signals, kind, options) =>
    typeOf(desc(signals, { kind: kind || 'radio', options: options ? opts(...options) : null }));
  // Agentis: one upload for both documents takes the CV; a cover letter upload is still the letter.
  assert.equal(
    ask({ label: 'Please attach a copy of your cover letter and resume in a single combined document.' }, 'file'),
    'file.resume',
  );
  assert.equal(ask({ label: 'Cover Letter' }, 'file'), 'file.coverLetter');
  assert.equal(ask({ label: 'Attach', id: 'cover_letter' }, 'file'), 'file.coverLetter');
  // Gemini: a required group of statements to tick is an acknowledgement.
  assert.equal(
    ask({ question: 'Applicant Privacy Statement', name: 'question_68277061[]' }, 'checkboxes', [
      'By clicking this box and submitting your application, you consent to our Applicant Privacy Statement.',
      'By clicking this box and submitting your application, you consent to third-party background checks.',
    ]),
    'consent',
  );
  // Base Power: an SMS opt-in named "communicationConsent" is not.
  assert.equal(
    ask(
      {
        question:
          'Check Yes or No to indicate your agreement to receive text message updates from Base Power Inc. regarding your job application.',
        name: 'communicationConsent',
      },
      'radio',
      ['Yes - I consent to receiving text messages', 'No - I do not consent to receiving text messages'],
    ),
    null,
  );
  assert.equal(ask({ label: 'Interview Recording Consent' }, 'radio', ['Yes', 'No']), 'consent');
  assert.equal(
    ask(
      {
        label:
          'Which university are you currently enrolled in, or from which institution did you receive your most recent degree?',
      },
      'combobox',
    ),
    'edu.school',
  );
  assert.equal(ask({ label: 'What university degree do you hold?' }, 'text'), null);
  assert.equal(
    ask({ question: 'Are you interested in full-time employment opportunities with us upon graduation?' }, 'radio', [
      'Yes',
      'No',
    ]),
    null,
  );
});

test('round 2 (UK engineering / EU Greenhouse): right to work after a preamble, modules, essays, uploads', () => {
  const ask = (label, kind, options) =>
    typeOf(desc({ label }, { kind: kind || 'combobox', options: options ? opts(...options) : null }));
  // BakerHicks: the sponsorship sentence is a preamble; the question is about your right to work.
  assert.equal(
    ask(
      'Due to recent changes to salary thresholds set by UKVI, this position does not support visa sponsorship in any capacity. Do you currently have the right to work in the UK?',
    ),
    'job.authorized',
  );
  assert.equal(ask('Will you now or in the future require visa sponsorship?'), 'job.sponsorship');
  // An essay about your visa status wants more than "No".
  assert.equal(
    ask(
      'BakerHicks are unable to consider applications from candidates on the Graduate visa. Therefore, please outline your current UK right to work status, including visa type and expiry date, whether you require sponsorship now or in the future',
      'textarea',
    ),
    null,
  );
  assert.equal(ask('Do you require sponsorship?', 'textarea'), 'job.sponsorship');
  // "Building Services" modules are not a flat number.
  assert.equal(
    ask(
      'Which of the following relevant Building Services or Mechanical Engineering modules have you completed as part of your degree?',
      'checkboxes',
      ['HVAC', 'Thermodynamics'],
    ),
    null,
  );
  assert.equal(
    ask('What inspired you to pursue a career in mechanical building services engineering?', 'textarea'),
    null,
  );
  assert.equal(ask('Flat / building', 'text'), 'address.line2');
  assert.equal(ask('Apartment, suite, unit, building, floor, etc.', 'text'), 'address.line2');
  assert.equal(ask('When would you like to start your internship? (Month/Year)', 'text'), 'job.startDate');
  assert.equal(ask('Please attach any other documents (School report, University certificate etc).', 'file'), null);
  // Teamtailor: "Additional files" whose id says "file".
  assert.equal(
    typeOf(
      desc(
        {
          label: 'Additional files',
          aria: 'Drop your file or upload, Additional files',
          id: 'candidate_file_remote_url',
        },
        { kind: 'file' },
      ),
    ),
    null,
  );
  assert.equal(
    typeOf(
      desc(
        { label: 'Upload CV', aria: 'Drop your file or upload, Upload CV', id: 'candidate_resume_remote_url' },
        { kind: 'file' },
      ),
    ),
    'file.resume',
  );
  assert.equal(ask('Current Notice Period', 'combobox'), 'job.noticePeriod');
  assert.equal(ask('From what date are you available for an internship?', 'text'), 'job.startDate');
  assert.equal(ask('When will you be available?', 'text'), 'job.startDate');
});

test('round 2 (FR / DE / IT / ES forms): whole-name labels, dial-code pickers, Personio custom question ids', () => {
  assert.equal(typeOf(desc({ label: 'Nom complet', placeholder: 'Prénom et nom' })), 'name.full');
  assert.equal(typeOf(desc({ label: 'Name', placeholder: 'Vor- und Nachname' })), 'name.full');
  assert.equal(typeOf(desc('Nombre y apellidos')), 'name.full');
  assert.equal(typeOf(desc('Nome e cognome')), 'name.full');
  assert.equal(typeOf(desc('Nom et prénom')), 'name.full');
  assert.equal(typeOf(desc('Prénom')), 'name.first');
  assert.equal(typeOf(desc('Nom')), 'name.last');
  assert.equal(typeOf(desc('Nachname')), 'name.last');
  assert.equal(typeOf(desc('Cognome')), 'name.last');
  assert.equal(
    typeOf(
      desc(
        { aria: "Sélectionner l'indicatif du pays: France", id: 'country-select-input-candidate.phone-8' },
        { kind: 'combo' },
      ),
    ),
    'phone.countryCode',
  );
  assert.equal(
    typeOf(desc({ label: 'Ländervorwahl' }, { kind: 'select', options: opts('+49', '+44', '+33') })),
    'phone.countryCode',
  );
  // Personio: "field-custom_attribute_…" ids.
  const personio = (label, kind, options) =>
    typeOf(
      desc(
        { label, id: 'field-custom_attribute_4621875', name: 'custom_attribute_4621875' },
        { kind: kind || 'text', options: options ? opts(...options) : null },
      ),
    );
  assert.equal(
    personio('Academical Transcripts', 'select', ['Please select', 'High School Degree', 'University Degrees']),
    null,
  );
  assert.equal(personio('Which tech startup would you recommend to us for further evaluation? And Why?'), null);
  assert.equal(personio('Alternative office'), null);
  assert.equal(personio('Field of study'), 'edu.field');
  assert.equal(typeOf(desc('Field')), 'edu.field');
});

test('round 2 (defence / engineering): security clearance held vs eligible, citizenship yes/no', () => {
  const yn = ['Yes', 'No'];
  const ask = (q) => typeOf(desc({ question: q }, { kind: 'radio', options: opts(...yn) }));
  assert.equal(ask('Do you currently hold an active US security clearance?'), 'job.clearance');
  assert.equal(ask('What is your current security clearance level?'), 'job.clearance');
  assert.equal(
    ask('Are you eligible to obtain the security clearance specified in the job description?'),
    'job.clearanceEligible',
  );
  assert.equal(ask('Are you able to hold a U.S. Security Clearance?'), 'job.clearanceEligible');
  assert.equal(ask('Are you willing to undergo a security clearance process?'), 'job.clearanceEligible');
  assert.equal(ask('Do you hold, or are you willing to obtain, SC clearance?'), 'job.clearanceEligible');
  assert.equal(
    ask('This role requires a UK security clearance and background checks. These include holding British Citizenship.'),
    'job.clearanceEligible',
  );
  assert.equal(ask('Are you a U.S. citizen?'), 'citizen');
  assert.equal(ask('Are you an EU citizen?'), 'citizen');
  assert.equal(ask('Are you a dual citizen?'), null);
});

test('round 2 (Pinpoint DE / UK law): school-leaving grades, "please state", processing consent, current firm', () => {
  const ask = (label, kind, options) =>
    typeOf(desc({ label }, { kind: kind || 'text', options: options ? opts(...options) : null }));
  assert.equal(ask('Please state what university you studied at'), 'edu.school');
  assert.equal(ask('State', 'text'), 'address.state');
  assert.equal(ask('(Required) Allow us to process your personal information.', 'checkbox'), 'consent');
  assert.equal(
    ask(
      'DECLARATION OF CONSENT FOR INCLUSION IN THE APPLICANT DATABASE I consent to Cinven storing my data for future vacancies',
      'combobox',
    ),
    null,
  );
  assert.equal(ask('Which firm/organisation do you currently work for?'), 'job.currentCompany');
  assert.equal(
    ask('Is the Gender you identify with the same as registered at birth?', 'combobox'),
    'eeo.genderIdentitySame',
  );
  assert.equal(ask('Gender', 'combobox'), 'eeo.gender');
  assert.equal(
    fields.eduLevelOf(util.normalize('Final grade obtained in School Graduation (Abitur or equivalent)')),
    'highschool',
  );
  assert.equal(fields.eduLevelOf(util.normalize('Final grade obtained in Bachelor’s Degree')), 'bachelor');
  assert.equal(fields.eduLevelOf(util.normalize('Baccalaureate degree GPA')), null);
});

test('diversity and background questions: FSM, care, carers, refugees, bursaries, religion, orientation, identity', () => {
  const yn = ['Yes', 'No', 'Prefer not to say'];
  const ask = (q, kind, options) =>
    typeOf(desc({ question: q }, { kind: kind || 'radio', options: opts(...(options || yn)) }));
  for (const q of [
    'If you finished school after 1980, were you eligible for free school meals at any point during your school years?',
    'Free school meals eligibility',
    'Did you receive free school meals during your school years?',
    'Were you eligible for Pupil Premium?',
    'Did you qualify for free or reduced-price lunch?',
  ])
    assert.equal(ask(q), 'eeo.freeSchoolMeals', q);
  assert.equal(ask('Have you ever been in care?'), 'eeo.careLeaver');
  assert.equal(ask('Are you a care leaver?'), 'eeo.careLeaver');
  assert.equal(ask('Have you spent time in local authority care?'), 'eeo.careLeaver');
  assert.equal(ask('Are you a young carer?'), 'eeo.carer');
  assert.equal(ask('Do you have caring responsibilities?'), 'eeo.carer');
  assert.equal(ask('Are you a refugee or asylum seeker?'), 'eeo.refugee');
  assert.equal(ask('Are you a refugee under 8 U.S.C. 1157?'), null, 'work authorisation, not diversity');
  assert.equal(ask('Did you receive a means-tested bursary or grant at university?'), 'eeo.bursary');
  assert.equal(ask('Were you in receipt of a maintenance grant?'), 'eeo.bursary');
  assert.equal(
    ask('What type of school did you attend?', 'select', ['State school', 'Independent school with a bursary']),
    'eeo.schoolType',
  );
  assert.equal(ask('What is your religion or belief?', 'select', ['Christian', 'Muslim']), 'eeo.religion');
  assert.equal(ask('What is your sexual orientation?', 'select', ['Bi', 'Gay/Lesbian']), 'eeo.sexualOrientation');
  assert.equal(
    ask('Is the gender you identify with the same as the sex you were registered at birth?'),
    'eeo.genderIdentitySame',
  );
  assert.equal(ask('Do you identify as transgender?'), 'eeo.genderIdentitySame');
  assert.equal(
    ask('How would you describe your gender identity?', 'select', ['Man', 'Woman', 'Non-binary']),
    'eeo.gender',
  );
  assert.equal(ask('Do you identify as LGBTQIA (Lesbian, Gay, Bisexual, Transgender, Queer)?'), 'eeo.lgbt');
  assert.equal(ask('Do you consider yourself to be neurodivergent?'), 'eeo.neurodivergent');
  assert.equal(
    typeOf(desc('What was the postcode of your home when you were 14?')),
    'eeo.postcodeAt14',
    'not your current postcode',
  );
  assert.equal(typeOf(desc('Postcode')), 'address.postalCode');
});

test('conflicts of interest: government officials and PEPs, relatives, worked here before', () => {
  const ask = (q, kind) => typeOf(desc({ question: q }, { kind: kind || 'radio', options: opts('Yes', 'No') }));
  for (const q of [
    'Are you, or is any immediate family member (parent, spouse, sibling, child), a current or former government official, public official, or employee of a state-owned entity?',
    'Are you a politically exposed person (PEP)?',
    'Were your parents involved in government?',
    'Are you related to a government official?',
    'Do you or anyone in your family have a personal, client, and/or government connection to KKR?',
  ])
    assert.equal(ask(q), 'compliance.government', q);
  assert.equal(
    typeOf(
      desc({
        label:
          'Government officials engaged in enforcing laws may review this information as required by law; it will be kept confidential.',
      }),
    ),
    null,
    'EEO notice text',
  );
  assert.equal(
    ask('Do you have any family members currently employed by KKR (inclusive of Global Atlantic)?'),
    'compliance.relatives',
  );
  assert.equal(ask('Have you previously worked at Man?'), 'compliance.previouslyEmployed');
  assert.equal(ask('Have you ever been employed by William Blair?'), 'compliance.previouslyEmployed');
  assert.equal(ask('Have you previously applied to Point72?'), 'compliance.previouslyApplied');
  assert.equal(ask('Are you currently, or have you ever been, employed by Deloitte in any capacity?'), null);
});

test('Hong Kong and EU personal details: Chinese / English names, ID cards, German / French / Italian labels', () => {
  const cases = {
    'Chinese name': null,
    'Name in Chinese': null,
    'Name (native script)': null,
    'English name': 'name.preferred',
    'Full name (as shown on HKID)': 'name.full',
    'Identity card number': null,
    'HKID number': null,
    'Card number': 'cc.number',
    'Straße und Hausnummer': 'address.line1',
    Mobilnummer: 'phone',
    Gehaltsvorstellung: 'job.salary',
    'Frühester Eintrittstermin': 'job.startDate',
    Kündigungsfrist: 'job.noticePeriod',
    Nationalité: 'nationality',
    Nazionalità: 'nationality',
    'Data di nascita': 'dob',
    'Prétentions salariales': 'job.salary',
    Disponibilité: 'job.startDate',
  };
  for (const [label, want] of Object.entries(cases)) assert.equal(typeOf(desc(label)), want, label);
});

test('public function / public trust questions are the government-official answer', () => {
  for (const q of [
    'Do you hold or have you held a prominent public function?',
    'Have you ever held a position of public trust?',
    'Are you a politically exposed person (PEP)?',
  ])
    assert.equal(typeOf(desc(q, { kind: 'radio' })), 'compliance.government', q);
});

test('a privacy notice to "acknowledge/confirm" is an acknowledgement however the form asks it', () => {
  const q = 'Please review Graham’s Privacy Notice for Job Applicants below and acknowledge/confirm.*';
  const ask = (signals, kind, options) => typeOf(desc(signals, { kind, options: options ? opts(...options) : null }));
  assert.equal(ask({ label: 'Acknowledge/Confirm', question: q }, 'checkbox'), 'consent');
  assert.equal(ask({ label: q }, 'checkbox'), 'consent');
  assert.equal(ask({ label: q }, 'checkboxes', ['Acknowledge/Confirm']), 'consent');
  assert.equal(ask({ label: q }, 'select', ['Please select', 'Acknowledge/Confirm']), 'consent');
  assert.equal(ask({ label: q }, 'combobox', ['Acknowledge/Confirm']), 'consent');
  assert.equal(ask({ label: q }, 'radio', ['Yes', 'No']), 'consent');
  // The answer each of those gets once acknowledgements are ticked.
  const v = fields.resolve('consent', {}, { consents: true });
  assert.equal(matcher.matchOption(opts('Please select', 'Acknowledge/Confirm'), v), 1);
  assert.equal(matcher.matchOption(opts('Yes', 'No'), v), 0);
});

test('UK education questions: courses are what you study, never the university (Teamtailor: Alloyed)', () => {
  const ask = (label, kind, options) =>
    typeOf(desc({ label }, { kind: kind || 'text', options: options ? opts(...options) : null }));
  // Teamtailor labels end in a screen-reader "Required"; the dropdown is a menu button.
  assert.equal(ask('University: Required', 'combo'), 'edu.school');
  for (const label of [
    'University Course',
    'University Course Required',
    'Course',
    'Course title',
    'Course studied',
    'Name of course',
    'Programme name',
    'Course / subject',
    'Which course are you studying?',
    'Which university course are you studying?',
  ])
    assert.equal(ask(label), 'edu.field', label);
  assert.equal(ask('Degree course'), 'edu.degree', 'a text box gets "BSc in Computer Science"');
  assert.equal(ask('When does your course finish?'), 'edu.end');
  assert.equal(ask('Relevant courses'), null, 'a list of courses is not your degree subject');
  assert.equal(ask('Course code'), null);
  // "Other" boxes after a school list are for a school the list didn't have.
  for (const label of [
    'University (if other, please specify)',
    'University (Other)',
    'Other university',
    'School name (if not listed)',
  ])
    assert.equal(ask(label), null, label);
});

test('degree classification is its own question; A-levels, UCAS points and a role classification are not', () => {
  const ask = (label, kind, options) =>
    typeOf(desc({ label }, { kind: kind || 'text', options: options ? opts(...options) : null }));
  for (const label of [
    'Expected/Achieved Degree Classification',
    'Predicted degree classification',
    'Expected/achieved grade',
    'Degree result',
    'Final degree grade (or predicted)',
    'What degree classification do you expect to achieve?',
    'Degree class',
    'Honours',
    'Expected honours',
  ])
    assert.equal(ask(label), 'edu.classification', label);
  assert.equal(
    ask('Expected/Achieved Degree Classification', 'combo'),
    'edu.classification',
    '"degree" in the label never makes it the degree',
  );
  assert.equal(
    ask('What did you receive in your degree?', 'select', ['First Class Honours (1st)', '2:1', '2:2', 'Third']),
    'edu.classification',
  );
  assert.equal(ask('Grade', 'select', ['1st', '2:1', '2:2', 'Pass']), 'edu.classification');
  assert.equal(ask('A-level grades'), 'edu.gpa', 'answered from a school entry, never the degree class');
  assert.equal(ask('Predicted A-level grades'), 'edu.gpa');
  assert.equal(ask('UCAS points'), null);
  assert.equal(ask('GPA'), 'edu.gpa');
  assert.equal(ask('Overall Result (GPA)'), 'edu.gpa', 'Workday asks for the GPA');
  assert.equal(
    ask(
      'Graduate Engineer / Summer Internship Please select which role classification you would like to progress with.',
      'radio',
      ['Graduate Engineer', 'Summer Internship'],
    ),
    null,
  );
  assert.equal(ask('Year of study', 'select', ['1st year', '2nd year', 'Final year']), 'edu.year');
  assert.equal(ask('Year of graduation'), 'edu.end:year');
});

test('UK degree classes however a list spells them', () => {
  const cases = {
    'First Class Honours (1st)': 'first',
    '1st': 'first',
    'First / 1st': 'first',
    '70%+ - First class honours': 'first',
    'Upper Second Class Honours (2:1)': 'upper',
    '2:1': 'upper',
    2.1: 'upper',
    '2(i)': 'upper',
    '2i': 'upper',
    'Upper Second (2:1) – predicted': 'upper',
    'Upper-Second Class': 'upper',
    '60-69% - Second class honours: Grade 1': 'upper',
    'Second Class Honours (Upper Division)': 'upper',
    'Lower Second Class Honours (2:2)': 'lower',
    '2(ii)': 'lower',
    '2ii': 'lower',
    2.2: 'lower',
    'Third Class Honours': 'third',
    '3rd': 'third',
    'Ordinary/Pass': 'pass',
    Pass: 'pass',
    Distinction: 'distinction',
    Merit: 'merit',
    Other: null,
    'N/A – not yet known': null,
    '3.00 - 3.49': null,
    '2.1 - 2.5': null,
    'First name': null,
    'Third party': null,
  };
  for (const [text, want] of Object.entries(cases)) assert.equal(fields.degreeClassOf(text), want, text);
});

test('where a school or employer is: country and city questions inside an entry (SuccessFactors)', () => {
  const ask = (label, kind, options) =>
    typeOf(desc({ label }, { kind: kind || 'text', options: options ? opts(...options) : null }));
  const countries = ['No Selection', 'France', 'United Kingdom'];
  assert.equal(ask('Country of School', 'select', countries), 'edu.country');
  assert.equal(ask('School Country', 'select', countries), 'edu.country');
  assert.equal(ask('Institution country', 'select', countries), 'edu.country');
  assert.equal(ask('Country where you obtained your degree', 'select', countries), 'edu.country');
  assert.equal(ask('Country of Employer', 'select', countries), 'exp.country');
  assert.equal(ask('In which country do you want to work?', 'select', countries), 'address.country');
  for (const label of ['State/City/Region of School', 'City of School', 'School Location', 'School City/State'])
    assert.equal(ask(label), 'edu.location', label);
  assert.equal(ask('From Date'), 'gen.start');
  assert.equal(ask('Expected or Completed Graduation'), 'edu.end');
  assert.equal(ask('School (Please use the full name, for example, University of Connecticut)'), 'edu.school');
});

test('live survey (British student in Glasgow): residence, commuting, UK visa and citizenship questions', () => {
  const yn = ['Yes', 'No'];
  const ask = (q, kind = 'select', o = yn) => typeOf(desc(q, { kind, options: o ? opts(...o) : null }));
  // Where you live: "located / based / living in" a place.
  assert.equal(ask('Are you located in London?'), 'location.in');
  assert.equal(ask('Are you based in the UK?'), 'location.in');
  assert.equal(ask('Are you currently living in the UK?'), 'location.in');
  assert.equal(ask('Do you currently reside in the United Kingdom?'), 'location.in');
  assert.equal(ask('Are you based in the UK?', 'text', null), 'location.in', 'a yes/no question, not your location');
  assert.equal(ask('Where are you currently based?', 'text', null), 'location');
  assert.equal(ask('Have you been continually resident in the UK for the last 5 years?'), null);
  // Commuting, and willingness to work somewhere in particular.
  assert.equal(ask('Are you able to commute into our London office?'), 'location.commute');
  assert.equal(ask('Do you live within commuting distance of our London office?'), 'location.commute');
  assert.equal(ask('Are you able to commute into our Rowayton, CT and/or New York, NY offices?'), 'location.commute');
  assert.equal(
    ask(
      'Confirm that you will be able to commute to and from our HQ in the South Bay Area of Los Angeles through your full internship duration.',
    ),
    'location.commute',
  );
  assert.equal(ask('Willing to work in London?'), 'job.workIn');
  assert.equal(ask('Are you willing to work in London?'), 'job.workIn');
  assert.equal(ask('Would you be willing to be based in our London office?'), 'job.workIn');
  assert.equal(ask('Are you willing to work onsite at our Chicago office 5 days a week?'), 'job.workIn');
  // Unchanged: the office in general, relocation, and permission.
  assert.equal(ask('Are you willing to work in the office 5 days a week?'), 'job.onsite');
  assert.equal(ask('Are you willing to work in-person for 12 weeks during the internship?'), 'job.onsite');
  assert.equal(
    ask('Are you currently based in the Los Angeles area or willing to relocate to the Los Angeles area?'),
    'job.relocate',
  );
  assert.equal(
    ask(
      'This role is based onsite at our Cheltenham office. Please confirm you are happy to relocate or commute to this location?',
      'radio',
    ),
    'job.relocate',
  );
  assert.equal(ask('Are you able to work in London?'), 'job.authorized');
  // UK visas and citizenship.
  assert.equal(ask('Do you hold a valid UK visa?'), 'job.visa');
  assert.equal(
    ask('Do you currently hold a UK visa?', 'select', ['Yes', 'No', 'Not applicable – British/Irish citizen']),
    'job.visa',
  );
  assert.equal(ask('Do you hold a visa that allows you to work in the UK?'), null, 'that asks for your right to work');
  assert.equal(ask('Visa type (if applicable)', 'text', null), null);
  assert.equal(
    ask('What is your immigration status in the UK?', 'select', [
      'British citizen',
      'Settled status',
      'Skilled Worker visa',
    ]),
    'job.authorized',
  );
  assert.equal(ask('Do you hold British citizenship?'), 'citizen');
  assert.equal(ask('Do you have a British passport?'), 'citizen');
  assert.equal(ask('Do you hold any other citizenships?'), null);
  // The sanctions questions are not citizenship yes/no questions: they are sanctions declarations.
  assert.equal(
    ask(
      'Do you hold citizenship or permanent residency in any of the following countries: Cuba, Iran, North Korea, Syria?',
    ),
    'compliance.sanctions',
  );
  assert.equal(
    ask('Citizen or permanent resident of Cuba, Iran, North Korea, Syria, or the Crimea region', 'checkboxes', yn),
    'compliance.sanctions',
  );
  // "Is there any other context…?" about sponsorship is still a sponsorship question.
  assert.equal(
    ask(
      'Is there any other context you’d like to share about your U.S. Immigration sponsorship needs?',
      'textarea',
      null,
    ),
    'job.sponsorship',
  );
});
