'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, desc, opts } = require('./helpers');

const { matcher } = load();
const typeOf = (d) => {
  const r = matcher.classify(d);
  return r ? r.type + (r.part ? ':' + r.part : '') : null;
};

test('labels on text inputs', () => {
  const cases = {
    'First Name *': 'name.first', 'Given name': 'name.first', 'Last Name': 'name.last', 'Surname': 'name.last',
    'Family name': 'name.last', 'Middle name': 'name.middle', 'Name': 'name.full', 'Full name': 'name.full',
    'Your name': 'name.full', 'Legal name': 'name.full', 'Preferred First Name': 'name.preferred', 'Nickname': 'name.preferred',
    'Email': 'email', 'E-mail address': 'email', 'Confirm email': 'email', 'Phone': 'phone', 'Mobile number': 'phone',
    'Telephone': 'phone', 'Address': 'address.line1', 'Street address': 'address.line1', 'Address Line 1': 'address.line1',
    'Address Line 2': 'address.line2', 'Apartment, suite, etc.': 'address.line2', 'City': 'address.city', 'Town / City': 'address.city',
    'State': 'address.state', 'Province': 'address.state', 'ZIP code': 'address.postalCode', 'Postcode': 'address.postalCode',
    'Zip / Postal Code': 'address.postalCode', 'Country': 'address.country', 'Location (City)': 'location', 'Current location': 'location',
    'LinkedIn Profile': 'links.linkedin', 'LinkedIn URL': 'links.linkedin', 'GitHub': 'links.github', 'Portfolio URL': 'links.portfolio',
    'Website': 'links.website', 'Personal website': 'links.website', 'Twitter': 'links.twitter',
    'School': 'edu.school', 'University': 'edu.school', 'College or University': 'edu.school', 'GPA': 'edu.gpa',
    'Field of study': 'edu.field', 'Major': 'edu.field', 'Company': 'exp.company', 'Employer': 'exp.company', 'Job title': 'exp.title',
    'Title': 'exp.title', 'Current company': 'job.currentCompany', 'Current title': 'job.currentTitle', 'Years of experience': 'job.yearsExperience',
    'Desired salary': 'job.salary', 'Salary expectations': 'job.salary', 'Notice period': 'job.noticePeriod',
    'When can you start?': 'job.startDate', 'Pronouns': 'pronouns', 'Skills': 'skills', 'Username': 'account.username',
    'Card number': 'cc.number', 'Name on card': 'cc.name', 'Cardholder name': 'cc.name', 'CVV': 'cc.cvc', 'Security code': 'cc.cvc',
    'Expiration date': 'cc.exp', 'Expiry month': 'cc.exp:month', 'Expiry year': 'cc.exp:year', 'Graduation year': 'edu.end:year',
    'Start date': 'gen.start', 'End date': 'gen.end', 'From': 'gen.start', 'To': 'gen.end',
  };
  for (const [label, want] of Object.entries(cases)) assert.equal(typeOf(desc(label)), want, label);
});

test('things that are not personal fields are left alone', () => {
  for (const label of ['Referrer name', 'Emergency contact name', 'Hiring manager email', 'Company website', 'Search', 'Coupon code',
    'Passport expiration date', 'Additional information', 'Name of your previous manager', 'Why do you want to work here?']) {
    const t = typeOf(desc(label));
    assert.ok(!t || !/^(name\.|email|cc\.|links\.website)/.test(t), `${label} -> ${t}`);
  }
});

test('long screening questions', () => {
  const sel = (label) => typeOf(desc({ question: label }, { kind: 'radio', options: opts('Yes', 'No') }));
  assert.equal(sel('Are you legally authorized to work in the United States?'), 'job.authorized');
  assert.equal(sel('Will you now or in the future require sponsorship for employment visa status (e.g., H-1B visa status)?'), 'job.sponsorship');
  assert.equal(sel('Are you legally authorized to work in the country in which the job is located without sponsorship?'), 'job.authorized');
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
  assert.equal(typeOf(desc({ aria: 'Month', placeholder: 'MM', attrs: 'dateSectionMonth-input', ancestors: 'formField-startDate workExperience-1' })), 'gen.start:month');
  assert.equal(typeOf(desc({ aria: 'Year', placeholder: 'YYYY', ancestors: 'formField-endDate' })), 'gen.end:year');
  assert.equal(typeOf(desc({ label: 'Name', name: 'first_name' })), 'name.first', 'specific name attribute beats a generic "Name" label');
  assert.equal(typeOf(desc({ label: 'Phone', name: 'phone_country_code' }, { kind: 'select', options: opts('+1', '+44') })), 'phone.countryCode');
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

test('single checkboxes only answer yes/no questions', () => {
  assert.equal(typeOf(desc({ label: 'I currently work here' }, { kind: 'checkbox' })), 'exp.current');
  assert.equal(typeOf(desc({ label: 'I am legally authorized to work in the US' }, { kind: 'checkbox' })), 'job.authorized');
  assert.equal(typeOf(desc({ label: 'I agree to the terms and conditions' }, { kind: 'checkbox' })), null);
  assert.equal(typeOf(desc({ label: 'Email me job alerts' }, { kind: 'checkbox' })), null);
});

test('options refine the guess', () => {
  assert.equal(typeOf(desc({ label: 'Title' }, { kind: 'select', options: opts('Mr', 'Mrs', 'Ms', 'Dr') })), 'name.prefix');
  assert.equal(typeOf(desc({ label: 'Country' }, { kind: 'select', options: opts('United States (+1)', 'United Kingdom (+44)', 'India (+91)') })), 'phone.countryCode');
  const months = opts('Month', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December');
  assert.equal(typeOf(desc({ label: 'Start date' }, { kind: 'select', options: months })), 'gen.start:month');
  assert.equal(typeOf(desc({ label: 'Start date' }, { kind: 'select', options: opts('2020', '2021', '2022', '2023') })), 'gen.start:year');
  assert.equal(typeOf(desc({ label: 'Date of birth', placeholder: 'DD/MM/YYYY' })), 'dob');
});
