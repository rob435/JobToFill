'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, opts } = require('./helpers');

const { matcher, fields } = load();
const profile = () => fields.createProfile('Test');

/** Text of the option that matchOption picks. */
function pick(options, v) {
  const i = matcher.matchOption(options, v);
  return i < 0 ? null : options[i].text;
}

test('countries match by name, alias or code', () => {
  const p = profile();
  const select = opts(
    'Select…',
    ['Canada', 'CA'],
    ['United Kingdom', 'GB'],
    ['United States', 'US'],
    ['United States Minor Outlying Islands', 'UM'],
  );
  for (const stored of ['USA', 'US', 'United States of America', 'united states', 'America']) {
    p.address.country = stored;
    assert.equal(pick(select, fields.resolve('address.country', p)), 'United States', stored);
  }
  p.address.country = 'UK';
  assert.equal(pick(select, fields.resolve('address.country', p)), 'United Kingdom');
  p.address.country = 'Great Britain';
  assert.equal(
    pick(
      opts(['United Kingdom of Great Britain and Northern Ireland', '826'], ['France', '250']),
      fields.resolve('address.country', p),
    ),
    'United Kingdom of Great Britain and Northern Ireland',
  );
});

test('states match code <-> name', () => {
  const p = profile();
  p.address.country = 'United States';
  p.address.state = 'CA';
  assert.equal(
    pick(opts('State', 'Arizona', 'California', 'Colorado'), fields.resolve('address.state', p)),
    'California',
  );
  p.address.state = 'New York';
  assert.equal(pick(opts(['--', ''], ['NJ', 'NJ'], ['NY', 'NY']), fields.resolve('address.state', p)), 'NY');
  p.address.country = 'Canada';
  p.address.state = 'Quebec';
  assert.equal(pick(opts('Ontario', 'Québec'), fields.resolve('address.state', p)), 'Québec');
});

test('yes / no answers pick the right option, whatever the wording', () => {
  const v = (t) => fields.val(t);
  assert.equal(pick(opts('--', ['Yes', '1'], ['No', '0']), v('Yes')), 'Yes');
  assert.equal(pick(opts('--', ['Yes', '1'], ['No', '0']), v('No')), 'No');
  assert.equal(
    pick(
      opts('Yes, I am authorized to work in the US and do not need sponsorship', 'No, I am not authorized'),
      v('Yes'),
    ),
    'Yes, I am authorized to work in the US and do not need sponsorship',
  );
  const veteran = opts(
    'Please select',
    'I am not a protected veteran',
    'I identify as one or more of the classifications of protected veteran',
    "I don't wish to answer",
  );
  assert.equal(pick(veteran, v('No')), 'I am not a protected veteran');
  assert.equal(pick(veteran, v('Yes')), 'I identify as one or more of the classifications of protected veteran');
  assert.equal(pick(veteran, v('Decline to answer')), "I don't wish to answer");
  const disability = opts(
    'Yes, I have a disability (or previously had a disability)',
    "No, I don't have a disability",
    "I don't wish to answer",
  );
  assert.equal(pick(disability, v('No')), "No, I don't have a disability");
  assert.equal(pick(disability, v('Decline to answer')), "I don't wish to answer");
  assert.equal(pick(opts('Authorized', 'Not authorized'), v('Yes')), 'Authorized');
  assert.equal(pick(opts('Male', 'Female', 'Decline To Self Identify'), v('Female')), 'Female');
  assert.equal(pick(opts('Man', 'Woman', 'Non-binary', 'Prefer not to say'), v('Male')), 'Man');
  assert.equal(
    pick(opts('Man', 'Woman', 'Non-binary', 'Prefer not to say'), v('Decline to answer')),
    'Prefer not to say',
  );
  assert.equal(pick(opts('Male', 'Female'), v('Decline to answer')), null);
});

test('free text answers: exact beats canonical, fuzzy is bounded', () => {
  const v = (t) => fields.val(t);
  assert.equal(pick(opts('No', 'Not applicable', 'Yes'), v('Not applicable')), 'Not applicable');
  assert.equal(pick(opts('LinkedIn', 'Indeed', 'Company website', 'Referral'), v('linkedin')), 'LinkedIn');
  assert.equal(pick(opts('LinkedIn', 'Indeed'), v('A friend told me')), null);
  assert.equal(
    pick(opts('Computer Science', 'Mathematics', 'Physics'), v('Computer Science and Engineering')),
    'Computer Science',
  );
});

test('degrees match by level', () => {
  const p = profile();
  const degrees = opts(
    '--',
    'High School',
    "Associate's Degree",
    "Bachelor's Degree",
    "Master's Degree",
    'Master of Business Administration (M.B.A.)',
    'Doctor of Philosophy (Ph.D.)',
  );
  for (const [stored, want] of [
    ['BSc', "Bachelor's Degree"],
    ['Bachelor of Science', "Bachelor's Degree"],
    ['MS', "Master's Degree"],
    ['PhD', 'Doctor of Philosophy (Ph.D.)'],
    ['MBA', 'Master of Business Administration (M.B.A.)'],
  ]) {
    p.education[0].degree = stored;
    assert.equal(pick(degrees, fields.resolve('edu.degree', p, { jobContext: true, index: 0 })), want, stored);
  }
});

test('month, year and day parts', () => {
  const p = profile();
  p.education[0].startDate = '2019-09';
  const ctx = (part) => ({ jobContext: true, index: 0, part });
  assert.equal(
    pick(
      opts(
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
      ),
      fields.resolve('edu.start', p, ctx('month')),
    ),
    'September',
  );
  assert.equal(pick(opts(['Sep', '9'], ['Oct', '10']), fields.resolve('edu.start', p, ctx('month'))), 'Sep');
  assert.equal(pick(opts('01', '02', '09', '10'), fields.resolve('edu.start', p, ctx('month'))), '09');
  assert.equal(pick(opts('2018', '2019', '2020'), fields.resolve('edu.start', p, ctx('year'))), '2019');
});

test('numeric ranges', () => {
  const p = profile();
  p.job.yearsExperience = '6';
  assert.equal(
    pick(opts('Select', '0-1', '1-3', '3-5', '5-10', '10+'), fields.resolve('job.yearsExperience', p)),
    '5-10',
  );
  p.job.yearsExperience = '12';
  assert.equal(pick(opts('0-1', '1-3', '3-5', '5-10', '10+'), fields.resolve('job.yearsExperience', p)), '10+');
  p.job.salary = '$130,000';
  assert.equal(
    pick(opts('$50k-$80k', '$80k - $120k', '$120k–$160k', '$160k+'), fields.resolve('job.salary', p)),
    '$120k–$160k',
  );
  p.job.salary = '95k';
  assert.equal(
    pick(opts('Less than 60000', '60000 to 100000', 'More than 100000'), fields.resolve('job.salary', p)),
    '60000 to 100000',
  );
});

test('phone country codes', () => {
  const p = profile();
  p.contact.phoneCountryCode = '+1';
  p.address.country = 'United States';
  const codes = opts('Antigua and Barbuda (+1 268)', 'Canada (+1)', 'United Kingdom (+44)', 'United States (+1)');
  assert.equal(pick(codes, fields.resolve('phone.countryCode', p)), 'United States (+1)');
  p.contact.phoneCountryCode = '44';
  p.address.country = 'UK';
  assert.equal(pick(codes, fields.resolve('phone.countryCode', p)), 'United Kingdom (+44)');
  assert.equal(pick(opts(['+44', 'GB'], ['+1', 'US']), fields.resolve('phone.countryCode', p)), '+44');
});

test('placeholders and disabled options are never picked', () => {
  const v = fields.val('Select one');
  assert.equal(matcher.matchOption(opts('Select one', 'Please select', '-- choose --'), v), -1);
  assert.equal(
    matcher.matchOption(
      [
        { text: 'Yes', value: 'y', disabled: true },
        { text: 'No', value: 'n' },
      ],
      fields.val('Yes'),
    ),
    -1,
  );
});

test('canonicalOf', () => {
  const c = matcher.canonicalOf;
  assert.equal(c('Yes'), 'yes');
  assert.equal(c('No, I do not'), 'no');
  assert.equal(c('Yes, but I do not need sponsorship'), 'yes');
  assert.equal(c('I am not a protected veteran'), 'no');
  assert.equal(c("I don't wish to answer"), 'decline');
  assert.equal(c('Decline To Self Identify'), 'decline');
  assert.equal(c('Female'), 'female');
  assert.equal(c('Male'), 'male');
  assert.equal(c('Norway'), null);
  assert.equal(c('LinkedIn'), null);
});

test('short degree lists with curly apostrophes', () => {
  const p = profile();
  const degrees = opts('Bachelor’s', 'Master’s', 'PhD', 'Postdoc');
  for (const [stored, want] of [
    ['BSc Computer Science', 'Bachelor’s'],
    ["Bachelor's", 'Bachelor’s'],
    ['MEng', 'Master’s'],
    ['MSc', 'Master’s'],
    ['DPhil', 'PhD'],
  ]) {
    p.education[0].degree = stored;
    assert.equal(pick(degrees, fields.resolve('edu.degree', p, { jobContext: true, index: 0 })), want, stored);
  }
});

test('graduation dates pick the term or period that covers them', () => {
  const p = profile();
  const terms = opts(
    'Spring 2025',
    'Fall 2025',
    'Winter 2026',
    'Spring/Summer 2026',
    'Fall 2026',
    'Winter 2027',
    'Spring/Summer 2027',
    'Fall 2027',
    'Winter 2028',
  );
  const grad = (endDate, options) => {
    p.education[0].endDate = endDate;
    return pick(options, fields.resolve('edu.end', p, { jobContext: true, index: 0 }));
  };
  assert.equal(grad('2027-05', terms), 'Spring/Summer 2027');
  assert.equal(grad('2027-07', terms), 'Spring/Summer 2027');
  assert.equal(grad('2027', terms), 'Spring/Summer 2027', 'a year alone means a typical June graduation');
  assert.equal(grad('2026-12', terms), 'Fall 2026');
  assert.equal(grad('2027-01', terms), 'Winter 2027');
  assert.equal(grad('2030-06', terms), null, 'no option near that date: leave it');

  const seasons = opts('Spring 2027', 'Summer 2027', 'Fall 2027');
  assert.equal(grad('2027-05', seasons), 'Spring 2027');
  assert.equal(grad('2027-07', seasons), 'Summer 2027');
  assert.equal(grad('2026-12', opts('Fall 2026', 'Spring 2027')), 'Fall 2026');
  assert.equal(grad('2027-06', opts('2026', '2027', '2028')), '2027');
  assert.equal(grad('2027-06', opts('May 2027', 'June 2027', 'July 2027')), 'June 2027');
  assert.equal(grad('2027-06', opts('Q1 2027', 'Q2 2027', 'Q3 2027')), 'Q2 2027');
  assert.equal(grad('2027-06', opts('Class of 2026', 'Class of 2027')), 'Class of 2027');
  assert.equal(grad('2031-06', opts('2028', '2029', '2030 or later')), '2030 or later');
  assert.equal(grad('2024-06', opts('Before 2025', '2025', '2026')), 'Before 2025');
  assert.equal(grad('2027-05', opts("Spring '26", "Spring '27")), "Spring '27");
});

test('optionSpan reads terms, months, quarters and open ranges', () => {
  const span = (t) => {
    const s = matcher.optionSpan(t);
    return s && s.map((x) => (Number.isFinite(x) ? `${Math.floor(x / 12)}-${(x % 12) + 1}` : String(x)));
  };
  assert.deepEqual(span('Spring/Summer 2027'), ['2027-3', '2027-8']);
  assert.deepEqual(span('Fall/Winter 2026'), ['2026-9', '2027-2']);
  assert.deepEqual(span('2027-05'), ['2027-5', '2027-5']);
  assert.deepEqual(span('2026-27'), ['2026-9', '2027-8']);
  assert.deepEqual(span('Sep 2026 - May 2027'), ['2026-9', '2027-5']);
  assert.deepEqual(span('2029 or later'), ['2029-1', 'Infinity']);
  for (const notADate of ['Yes', 'Other', 'Bachelor’s', '3-5 years', '10+', 'London'])
    assert.equal(span(notADate), null);
});

test('lists: every matching checkbox, or the first preferred option a dropdown offers', () => {
  const p = profile();
  p.job.locations = 'London, New York; Remote';
  const v = fields.resolve('job.locations', p, { jobContext: true });
  assert.deepEqual(v.items, ['London', 'New York', 'Remote']);
  const cities = opts('Chicago', 'New York', 'London', 'Bristol', 'Hong Kong');
  assert.deepEqual(
    matcher.matchAll(cities, v).map((i) => cities[i].text),
    ['London', 'New York'],
  );
  assert.equal(pick(opts('Chicago', 'New York', 'London'), v), 'London', 'first choice wins');
  assert.equal(pick(opts('Chicago', 'New York (NYC)'), v), 'New York (NYC)');
  assert.equal(pick(opts('Chicago', 'Sydney'), v), null);

  p.skills = 'Python, C++, SQL';
  const skills = fields.resolve('skills', p, { jobContext: true, kind: 'checkboxes' });
  const langs = opts('Java', 'Python', 'C++', 'Rust');
  assert.deepEqual(
    matcher.matchAll(langs, skills).map((i) => langs[i].text),
    ['Python', 'C++'],
  );
  assert.equal(fields.resolve('skills', p, { jobContext: true, kind: 'textarea' }).text, 'Python, C++, SQL');
});

test('links: a scheme is added and LinkedIn tracking parameters are dropped', () => {
  const p = profile();
  p.links.linkedin = 'https://www.linkedin.com/in/robin-l/?isSelfProfile=true';
  assert.equal(fields.resolve('links.linkedin', p, {}).text, 'https://www.linkedin.com/in/robin-l/');
  p.links.linkedin = 'linkedin.com/in/robin';
  assert.equal(fields.resolve('links.linkedin', p, {}).text, 'https://linkedin.com/in/robin');
  p.links.website = 'https://robin.dev/?ref=cv';
  assert.equal(fields.resolve('links.website', p, {}).text, 'https://robin.dev/?ref=cv', 'other sites are kept as is');
});

test('non-compete and notice period share one box when the question asks for both', () => {
  const p = profile();
  const ask = (kind, question) => {
    const v = fields.resolve('job.nonCompete', p, { kind, question });
    return v && v.text;
  };
  p.job.nonCompete = 'None';
  p.job.noticePeriod = '2 weeks';
  assert.equal(ask('text', 'non compete notice period comments'), 'None. Notice period: 2 weeks');
  assert.equal(ask('text', 'are you subject to a non compete'), 'None');
  assert.equal(ask('combobox', 'non compete notice period'), 'None');
  p.job.nonCompete = '';
  assert.equal(ask('text', 'non compete notice period comments'), '2 weeks');
  assert.equal(ask('text', 'are you subject to a non compete'), null);
});
