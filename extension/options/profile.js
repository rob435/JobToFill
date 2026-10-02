/* JobToFill settings — the profile sections. Each renderer returns the nodes for #sections. */
import { el } from '../ui/common.js';
import { control, formatBytes, grid, group, sectionHead } from './controls.js';

const { store, util, fields } = globalThis.JTF;

const NONE = ['', '— don’t fill —'];
const YES_NO = [NONE, ['Yes', 'Yes'], ['No', 'No']];
const DECLINE = ['Decline to answer', 'Prefer not to say'];
const same = (values) => values.map((v) => [v, v]);

const CHOICES = {
  prefix: [['', '—'], ...same(['Mr', 'Ms', 'Mrs', 'Miss', 'Mx', 'Dr'])],
  phoneType: same(['Mobile', 'Home', 'Work']),
  gender: [NONE, ...same(['Male', 'Female', 'Non-binary']), DECLINE],
  // prettier-ignore
  race: [
    NONE,
    ...same([
      'American Indian or Alaska Native', 'Asian', 'Black or African American', 'Hispanic or Latino',
      'Native Hawaiian or Other Pacific Islander', 'White', 'Two or More Races',
    ]),
    DECLINE,
  ],
  hispanic: [...YES_NO, DECLINE],
  veteran: [NONE, ['No', 'I am not a protected veteran'], ['Yes', 'I identify as a protected veteran'], DECLINE],
  disability: [NONE, ['No', 'No, I don’t have a disability'], ['Yes', 'Yes, I have a disability'], DECLINE],
  // UK social-mobility monitoring (the Social Mobility Commission's standard questions)
  schoolType: [
    NONE,
    ...same([
      'State school (non-selective)',
      'State school (selective)',
      'Independent / fee-paying school',
      'Independent school with a 90%+ bursary',
      'School outside the UK',
    ]),
    DECLINE,
  ],
  freeSchoolMeals: [...YES_NO, ['Not applicable', 'Not applicable'], DECLINE],
  parentsDegree: [NONE, ['Yes', 'Yes, at least one has a degree'], ['No', 'No'], DECLINE],
  parentOccupation: [
    NONE,
    ...same([
      'Professional',
      'Manager / administrator',
      'Clerical / intermediate',
      'Technical / craft',
      'Routine / semi-routine',
      'Long-term unemployed',
      'Small business owner',
      'Other / not applicable',
    ]),
    DECLINE,
  ],
};

// prettier-ignore
export const DEGREES = [
  'High School Diploma', 'Associate’s Degree', 'Bachelor’s Degree', 'Bachelor of Science', 'Bachelor of Arts',
  'Bachelor of Engineering', 'Master’s Degree', 'Master of Science', 'Master of Arts', 'MBA', 'PhD', 'JD', 'MD',
];

const f = (path, label, extra) => ({ path, label, ...extra });

const FORMS = {
  personal: {
    title: 'Personal & contact',
    intro: 'The basics every form asks for. Everything stays in this browser.',
    groups: [
      {
        title: 'Name',
        fields: [
          f('personal.prefix', 'Title', { type: 'select', options: CHOICES.prefix }),
          f('personal.firstName', 'First name', { autocomplete: 'given-name' }),
          f('personal.middleName', 'Middle name', { autocomplete: 'additional-name' }),
          f('personal.lastName', 'Last name', { autocomplete: 'family-name' }),
          f('personal.preferredName', 'Preferred name', {
            hint: 'For “preferred name” boxes. Leave blank to use your first name.',
          }),
          f('personal.pronouns', 'Pronouns', { placeholder: 'e.g. she/her' }),
        ],
      },
      {
        title: 'Contact',
        fields: [
          f('contact.email', 'Email', { type: 'email', autocomplete: 'email' }),
          f('contact.phoneCountryCode', 'Phone country code', { placeholder: '+1', autocomplete: 'tel-country-code' }),
          f('contact.phone', 'Phone number', {
            type: 'tel',
            placeholder: '555 123 4567',
            autocomplete: 'tel-national',
          }),
          f('contact.phoneType', 'Phone type', { type: 'select', options: CHOICES.phoneType }),
        ],
      },
      {
        title: 'Address',
        fields: [
          f('address.line1', 'Street address', { wide: true, autocomplete: 'address-line1' }),
          f('address.line2', 'Apartment, suite, unit', { wide: true, autocomplete: 'address-line2' }),
          f('address.city', 'City', { autocomplete: 'address-level2' }),
          f('address.state', 'State / province / region', {
            autocomplete: 'address-level1',
            hint: 'Either “CA” or “California” works.',
          }),
          f('address.postalCode', 'ZIP / postal code', { autocomplete: 'postal-code' }),
          f('address.country', 'Country', { list: 'countries', autocomplete: 'country-name' }),
          f('address.organization', 'Company (shipping forms)', {
            hint: 'Only used for the “Company” line on checkout forms.',
          }),
        ],
      },
      {
        title: 'Other',
        fields: [
          f('personal.dob', 'Date of birth', { type: 'date' }),
          f('personal.nationality', 'Nationality / citizenship', { list: 'countries' }),
        ],
      },
    ],
  },
  links: {
    title: 'Links',
    intro: 'Profile links most applications ask for.',
    groups: [
      {
        title: 'Online profiles',
        fields: [
          f('links.linkedin', 'LinkedIn', { type: 'url', placeholder: 'https://www.linkedin.com/in/…', wide: true }),
          f('links.github', 'GitHub', { type: 'url', placeholder: 'https://github.com/…', wide: true }),
          f('links.portfolio', 'Portfolio', { type: 'url', wide: true }),
          f('links.website', 'Personal website', { type: 'url', wide: true }),
          f('links.twitter', 'Twitter / X', { type: 'url', wide: true }),
        ],
      },
    ],
  },
  work: {
    title: 'Work eligibility & preferences',
    intro: 'Standard screening questions. “— don’t fill —” leaves a question for you to answer.',
    groups: [
      {
        title: 'Screening questions',
        fields: [
          f('job.authorized', 'Legally authorized to work?', {
            type: 'select',
            options: YES_NO,
            hint: 'In the country you are applying in.',
          }),
          f('job.sponsorship', 'Need visa sponsorship (now or later)?', { type: 'select', options: YES_NO }),
          f('job.relocate', 'Willing to relocate?', { type: 'select', options: YES_NO }),
          f('job.over18', 'At least 18 years old?', { type: 'select', options: YES_NO }),
          f('job.clearance', 'Security clearance held', {
            placeholder: 'None, SC, DV, Secret, Top Secret…',
            hint: 'Defence and engineering forms ask “Do you hold an active security clearance?”.',
          }),
          f('job.clearanceEligible', 'Eligible for / willing to get clearance?', { type: 'select', options: YES_NO }),
          f('job.otherOffers', 'Other offers or deadlines?', {
            placeholder: 'No — or: Yes, Acme, deadline 1 Nov',
            hint: 'Start with Yes or No; the rest goes into the “please tell us more” box.',
          }),
          f('job.nonCompete', 'Non-compete or restrictions', {
            placeholder: 'e.g. None',
            hint: 'Questions about non-competes and garden leave.',
          }),
        ],
      },
      {
        title: 'Preferences',
        fields: [
          f('job.yearsExperience', 'Years of experience', { placeholder: 'e.g. 5' }),
          f('job.salary', 'Salary expectation', {
            placeholder: 'e.g. 120000',
            hint: 'Range dropdowns like “$100k–$150k” are matched automatically.',
          }),
          f('job.noticePeriod', 'Notice period', { placeholder: 'e.g. 2 weeks' }),
          f('job.startDate', 'Available from', { placeholder: 'Immediately, or 2026-11-01' }),
          f('job.referralSource', 'How did you hear about us?', { placeholder: 'e.g. LinkedIn' }),
          f('job.locations', 'Preferred locations', {
            wide: true,
            placeholder: 'London, New York, Remote',
            hint: 'Best first. Ticks matching office checkboxes, and a dropdown gets the first one it offers.',
          }),
        ],
      },
    ],
  },
  writing: {
    title: 'Skills & writing',
    intro: 'Longer answers for summary, skills and cover letter boxes.',
    groups: [
      {
        title: 'Text',
        fields: [
          f('skills', 'Skills', {
            type: 'textarea',
            rows: 3,
            wide: true,
            placeholder: 'Python, SQL, React, project management…',
          }),
          f('languages', 'Languages', { wide: true, placeholder: 'English (native), Spanish (professional)' }),
          f('summary', 'Professional summary', { type: 'textarea', rows: 5, wide: true }),
          f('coverLetter', 'Cover letter', {
            type: 'textarea',
            rows: 12,
            wide: true,
            hint: 'Pasted into “Cover letter” text boxes. Upload a file under Resume & files for upload buttons.',
          }),
        ],
      },
    ],
  },
  eeo: {
    title: 'Voluntary disclosures',
    intro:
      'Employers ask these for equal-opportunity and social-mobility reporting. Answering is voluntary and never affects your application. ' +
      'Leave a question on “— don’t fill —” to answer it yourself each time.',
    groups: [
      {
        title: 'Self-identification',
        fields: [
          f('eeo.gender', 'Gender', { type: 'select', options: CHOICES.gender }),
          f('eeo.race', 'Race / ethnicity', { type: 'select', options: CHOICES.race }),
          f('eeo.hispanic', 'Hispanic or Latino?', { type: 'select', options: CHOICES.hispanic }),
          f('eeo.veteran', 'Veteran status', { type: 'select', options: CHOICES.veteran }),
          f('eeo.disability', 'Disability status', { type: 'select', options: CHOICES.disability }),
        ],
      },
      {
        title: 'UK social mobility',
        hint: 'UK employers ask these to see how open their hiring is. They are about your background, not your merit.',
        fields: [
          f('eeo.schoolType', 'School you mainly attended, age 11–16', {
            type: 'select',
            options: CHOICES.schoolType,
          }),
          f('eeo.freeSchoolMeals', 'Eligible for free school meals?', {
            type: 'select',
            options: CHOICES.freeSchoolMeals,
          }),
          f('eeo.parentsDegree', 'Does a parent or guardian have a university degree?', {
            type: 'select',
            options: CHOICES.parentsDegree,
            hint: '“First in your family to go to university?” is answered from this too.',
          }),
          f('eeo.parentOccupation', 'Main household earner’s job when you were about 14', {
            type: 'select',
            options: CHOICES.parentOccupation,
          }),
        ],
      },
    ],
  },
};

const LISTS = {
  education: {
    title: 'Education',
    intro: 'Most recent first. Forms with several education sections get one entry each.',
    add: 'Add education',
    blank: fields.blankEducation,
    name: (e, i) => e.school || `Education ${i + 1}`,
    fields: [
      f('school', 'School / university', { wide: true }),
      f('degree', 'Degree', { list: 'degrees' }),
      f('field', 'Field of study / major'),
      f('gpa', 'GPA / grade'),
      f('location', 'Location', { placeholder: 'City, State' }),
      f('startDate', 'Start', { type: 'month' }),
      f('endDate', 'End / expected graduation', { type: 'month' }),
    ],
  },
  experience: {
    title: 'Work experience',
    intro: 'Most recent first. The first entry (or the one marked current) is your “current company”.',
    add: 'Add job',
    blank: fields.blankExperience,
    name: (e, i) => [e.title, e.company].filter(Boolean).join(' · ') || `Job ${i + 1}`,
    fields: [
      f('title', 'Job title'),
      f('company', 'Company'),
      f('location', 'Location', { placeholder: 'City, State' }),
      f('startDate', 'Start', { type: 'month' }),
      f('endDate', 'End', { type: 'month' }),
      f('current', 'I currently work here', { type: 'checkbox' }),
      f('description', 'Description', { type: 'textarea', rows: 4, wide: true }),
    ],
  },
};

/* ------------------------------------------------------------------ forms */

function renderForm(key, { state, scheduleSave }) {
  const spec = FORMS[key];
  const bind = (fs) =>
    control(fs, util.getPath(state.profile, fs.path), (v) => {
      util.setPath(state.profile, fs.path, v);
      scheduleSave();
    });
  return [
    sectionHead(spec.title, spec.intro),
    ...spec.groups.map((g) => group(g.title, g.hint, grid(g.fields.map(bind)))),
  ];
}

/* ------------------------------------------------------- repeated entries */

function renderList(key, { state, scheduleSave }) {
  const spec = LISTS[key];
  const wrap = el('div');

  const draw = () => {
    const list = state.profile[key];
    const changed = () => {
      scheduleSave();
      draw();
    };
    const move = (i, d) => {
      [list[i], list[i + d]] = [list[i + d], list[i]];
      changed();
    };

    const entries = list.map((item, i) => {
      const title = el('strong', { textContent: spec.name(item, i) });
      const tools = el(
        'div',
        { className: 'entry-tools' },
        el('button', {
          type: 'button',
          textContent: '↑',
          title: 'Move up',
          disabled: i === 0,
          onclick: () => move(i, -1),
        }),
        el('button', {
          type: 'button',
          textContent: '↓',
          title: 'Move down',
          disabled: i === list.length - 1,
          onclick: () => move(i, 1),
        }),
        el('button', {
          type: 'button',
          className: 'danger',
          textContent: 'Remove',
          onclick: () => (list.splice(i, 1), changed()),
        }),
      );
      const inputs = spec.fields.map((fs) =>
        control(fs, item[fs.path], (v) => {
          item[fs.path] = v;
          title.textContent = spec.name(item, i);
          scheduleSave();
        }),
      );
      return el('div', { className: 'entry' }, el('div', { className: 'entry-head' }, title, tools), grid(inputs));
    });

    const add = el('button', {
      type: 'button',
      textContent: '+ ' + spec.add,
      onclick: () => (list.push(spec.blank()), changed()),
    });
    wrap.replaceChildren(...entries, add);
  };

  draw();
  return [sectionHead(spec.title, spec.intro), group(null, null, wrap)];
}

/* --------------------------------------------------------- custom answers */

function renderAnswers({ state, scheduleSave }) {
  const wrap = el('div');

  const draw = () => {
    const list = state.profile.customAnswers;
    const rows = list.map((a, i) =>
      el(
        'div',
        { className: 'answer-row' },
        control(
          { path: 'question', label: 'When the question contains…', placeholder: 'how did you hear | referral' },
          a.question,
          (v) => {
            a.question = v;
            scheduleSave();
          },
        ),
        control({ path: 'answer', label: 'Answer with', type: 'textarea', rows: 2 }, a.answer, (v) => {
          a.answer = v;
          scheduleSave();
        }),
        el('button', {
          type: 'button',
          className: 'small danger remove',
          textContent: 'Remove',
          onclick: () => {
            list.splice(i, 1);
            scheduleSave();
            draw();
          },
        }),
      ),
    );
    const empty = el('p', {
      className: 'empty',
      textContent:
        'No custom answers yet. Add one below, or use “Learn from this page” in the toolbar popup after typing answers into a form.',
    });
    const add = el('button', {
      type: 'button',
      textContent: '+ Add answer',
      onclick: () => (list.push(fields.blankCustomAnswer()), draw()),
    });
    wrap.replaceChildren(rows.length ? el('div', {}, rows) : empty, add);
  };

  draw();
  return [
    sectionHead(
      'Custom answers',
      'Answers for the questions that differ on every site: “Why do you want to work here?”, “Do you have a clearance?”, “Can you work weekends?”.',
    ),
    group(
      'Your answers',
      'Matching ignores case and punctuation. Separate alternatives with | , or write a regular expression like /^why .* (us|here)/. ' +
        'Custom answers win over the built-in fields, and Yes/No answers also pick the right radio button or dropdown option.',
      wrap,
    ),
  ];
}

/* -------------------------------------------------------------- documents */

const DOC_LABELS = { resume: 'Resume / CV', coverLetter: 'Cover letter' };
const MAX_DOC_BYTES = 10 * 1048576;

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function renderDocuments({ state }) {
  const wrap = el('div');

  const card = (which, doc) => {
    const message = el('small', { className: 'error' });
    const picker = el('input', {
      type: 'file',
      hidden: true,
      accept: '.pdf,.doc,.docx,.txt,.rtf,.odt,.pages',
      name: 'doc-' + which,
    });
    picker.addEventListener('change', async () => {
      const file = picker.files[0];
      if (!file) return;
      if (file.size > MAX_DOC_BYTES) {
        message.textContent = 'That file is over 10 MB. Most application forms reject files that large.';
        return;
      }
      await store.setDoc(state.profile.id, which, {
        name: file.name,
        type: file.type,
        size: file.size,
        dataUrl: await readAsDataUrl(file),
      });
      draw();
    });
    const remove = async () => {
      await store.removeDoc(state.profile.id, which);
      draw();
    };
    const extension = doc ? (doc.name.split('.').pop() || 'file').slice(0, 4).toUpperCase() : '—';
    return el(
      'div',
      { className: 'doc-card' },
      el('div', { className: 'doc-icon', textContent: extension }),
      el(
        'div',
        { className: 'doc-info' },
        el('strong', { textContent: DOC_LABELS[which] }),
        el('span', { className: 'muted', textContent: doc ? `${doc.name} · ${formatBytes(doc.size)}` : 'No file yet' }),
        message,
      ),
      el(
        'div',
        { className: 'doc-actions' },
        el('button', {
          type: 'button',
          className: doc ? '' : 'primary',
          textContent: doc ? 'Replace' : 'Upload',
          onclick: () => picker.click(),
        }),
        doc ? el('button', { type: 'button', className: 'danger', textContent: 'Remove', onclick: remove }) : null,
      ),
      picker,
    );
  };

  const draw = async () => {
    const info = await store.docInfo(state.profile.id);
    wrap.replaceChildren(...store.DOC_TYPES.map((which) => card(which, info[which])));
  };

  draw();
  return [
    sectionHead(
      'Resume & files',
      'Attached automatically to resume / CV and cover-letter upload buttons. Stored per profile, so a “Data analyst” profile can carry a different resume.',
    ),
    group(null, null, wrap),
  ];
}

/* ----------------------------------------------------------------- export */

export const PROFILE_SECTIONS = {
  personal: (ctx) => renderForm('personal', ctx),
  links: (ctx) => renderForm('links', ctx),
  work: (ctx) => renderForm('work', ctx),
  education: (ctx) => renderList('education', ctx),
  experience: (ctx) => renderList('experience', ctx),
  writing: (ctx) => renderForm('writing', ctx),
  documents: renderDocuments,
  answers: renderAnswers,
  eeo: (ctx) => renderForm('eeo', ctx),
};
