// A replica of Accenture's Pinpoint application questions (accenture.pinpointhq.com, a summer internship, October
// 2026), as Pinpoint renders them: each Singleselect a react-select labelled by its title (searchable, options without
// ARIA roles, a <select> beside it that only shows on phones), each Boolean (YesNo here) a Yes / No pair labelled by hidden divs
// that repeat the question ("…Are you at least 18 years of age? yes"), each Dateselect three <select>s, and the
// conditional Shorttexts only drawn once their list holds the answer they follow ("Other"). The live React state is
// printed into #state, by question number.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import Select, { components } from 'react-select';

const opts = (labels) => labels.map((label) => ({ label, value: label }));

// Older react-select (as on Pinpoint) renders the menu and its options without ARIA roles.
const noRole = (props) => {
  const innerProps = { ...props.innerProps };
  delete innerProps.role;
  delete innerProps['aria-selected'];
  return { ...props, innerProps };
};
const Option = (props) => <components.Option {...noRole(props)} />;
const MenuList = (props) => <components.MenuList {...noRole(props)} />;

const id = (index, what) => `application_form_application_answers_attributes_${index}_${what}`;

// A question's additional information, inside its label after the title.
const INFO = {
  1: 'Please confirm if you understand this requirement.  If you do not agree with this requirement, we will be unable to progress your application.',
  6: "Type to search for a university. If your university is not listed, select 'Other'.",
  8: "Choose the subject area that most closely matches your degree title. You can type to search for a subject. If your degree type is not listed, select 'Other'.",
  43: 'Please confirm the statement below to proceed with your application: I confirm that the information I will provide is correct to the best of my knowledge and belief. I confirm that as the applicant, I will personally and individually complete each assessment that is being submitted as part of this application. If you do not confirm the statement, you will be unable to proceed with your application.',
};

function Title({ text, info, htmlFor }) {
  return (
    <label className="external-form__label" htmlFor={htmlFor}>
      <span className="external-form__label--title external-form__label--required">{text}</span>
      {info && <span>{info}</span>}
      <div></div>
    </label>
  );
}

function Singleselect({ index, title, options, onChange }) {
  return (
    <div className="pad-v-3">
      <Title text={title} info={INFO[index]} htmlFor={id(index, 'text_answer')} />
      <Select
        inputId={id(index, 'text_answer')}
        className="react-select hide-sm-block"
        classNamePrefix="react-select"
        options={opts(options)}
        isSearchable
        aria-label={title}
        components={{ Option, MenuList }}
        onChange={(o) => onChange(index, o ? o.label : '')}
      />
      <select className="hide-at-sm-block" id={id(index, 'mobile_select')} aria-label={title}>
        <option value="blank">Select...</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}

function Shorttext({ index, title, onChange }) {
  return (
    <div className="pad-v-3">
      <Title text={title} htmlFor={id(index, 'text_answer')} />
      <input type="text" id={id(index, 'text_answer')} onChange={(e) => onChange(index, e.target.value)} />
    </div>
  );
}

function YesNo({ index, title, onChange }) {
  const radio = (value, text) => (
    <div className="col-1-2">
      <div id={`answer-label-${index}-${value}`} style={{ display: 'none' }}>
        {`${title} ${text.toLowerCase()}`}
      </div>
      <input
        type="radio"
        id={id(index, `boolean_answer_${value}`)}
        name={`application_form[application][answers_attributes][${index}][boolean_answer]`}
        aria-labelledby={`answer-label-${index}-${value}`}
        value={value}
        onChange={() => onChange(index, text)}
      />
      <label aria-labelledby={`answer-label-${index}-${value}`} htmlFor={id(index, `boolean_answer_${value}`)}>
        {text}
      </label>
    </div>
  );
  return (
    <div className="pad-v-3">
      <Title text={title} htmlFor={id(index, 'boolean_answer')} />
      <div className="frow">
        {radio('true', 'Yes')}
        {radio('false', 'No')}
      </div>
    </div>
  );
}

const MONTHS = 'January February March April May June July August September October November December'.split(' ');
const YEARS = Array.from({ length: 40 }, (_, k) => 2035 - k);

function Dateselect({ index, title, onChange }) {
  const [date, setDate] = useState({});
  const set = (part) => (e) => {
    const next = { ...date, [part]: e.target.value };
    setDate(next);
    onChange(index, [next.day, next.month, next.year].filter(Boolean).join(' '));
  };
  const box = (part, suffix, label, values) => (
    <select id={id(index, `date_answer_${suffix}`)} aria-label={`${title} - ${label}`} onChange={set(part)}>
      <option value="">{label}</option>
      {values.map((v) => (
        <option key={v} value={v}>
          {v}
        </option>
      ))}
    </select>
  );
  return (
    <div className="pad-v-3">
      <div className="external-form__label" id={id(index, 'date_label')}>
        <span className="external-form__label--title external-form__label--required">{title}</span>
      </div>
      <div className="date-select" role="group" aria-labelledby={id(index, 'date_label')}>
        {box(
          'day',
          '3i',
          'Day',
          Array.from({ length: 31 }, (_, k) => String(k + 1)),
        )}
        {box('month', '2i', 'Month', MONTHS)}
        {box('year', '1i', 'Year', YEARS.map(String))}
      </div>
    </div>
  );
}

// [index, kind, title, options, shown when question `when[0]` is `when[1]`]
const QUESTIONS = [
  [
    0,
    YesNo,
    'Are you a penultimate year student of an undergraduate or integrated masters degree, and graduating in 2028? Unfortunately, if this requirement is not met, your application will not progress further in our process.',
  ],
  [
    1,
    Singleselect,
    'Accenture is a people first business that thrives on collaboration and knowledge sharing. You must live within commutable distance of your assigned office and come in to the office regularly. Due to the nature of our work, you may deliver projects at client sites across the UK and occasionally outside the UK. You are expected to work on client site or in your assigned office for a minimum of 3 days a week, potentially up to 5 days depending on business needs.',
    ['Yes, I understand '],
  ],
  [
    2,
    Singleselect,
    'Are you currently studying for an undergraduate degree or equivalent?',
    ['Degree', 'Degree Equivalent '],
  ],
  [
    3,
    Shorttext,
    "As you have selected 'degree equivalent', please provide details of the equivalent qualification you expect to obtain.",
    null,
    [2, 'Degree Equivalent '],
  ],
  [
    4,
    Singleselect,
    'Please choose your type of undergraduate degree from the options provided below.',
    [
      'Bachelor of Arts (BA)',
      'Bachelor of Science (BSc)',
      'Bachelor of Business Administration (BBA)',
      'Bachelor of Engineering (BEng)',
      'Integrated Master of Engineering (MEng)',
      'Bachelor of Education (BEd)',
      'Bachelor of Laws (LLB)',
      'Bachelor of Laws with Honours (LLB Hons)',
      'Integrated Masters of Science (MSci)',
      'Other',
    ],
  ],
  [5, Shorttext, 'Please provide details below', null, [4, 'Other']],
  [
    6,
    Singleselect,
    'Which university are you currently attending or did you attend for your undergraduate studies?',
    [
      'University of Buenos Aires',
      'Australian National University',
      'University of Cambridge',
      'University College London (UCL)',
      'University of Edinburgh',
      'University of Glasgow',
      'Other',
    ],
  ],
  [7, Shorttext, 'Please provide details of which university you gained your qualification.', null, [6, 'Other']],
  [
    8,
    Singleselect,
    'Please select your degree subject from the options provided below.',
    ['Accounting', 'Computer Science', 'Economics', 'Engineering', 'Mathematics', 'Physics', 'Other'],
  ],
  [9, Shorttext, "If you have selected 'Other' in the previous question, please provide details.", null, [8, 'Other']],
  [10, Dateselect, 'Please enter your qualification start date.'],
  [11, Dateselect, 'Please enter your qualification end date, or predicted end date.'],
  [
    12,
    Singleselect,
    "Please select your bachelor's degree results/expected results from the options below.",
    [
      'First-Class Honours (1st)',
      'Upper Second-Class Honours (2:1)',
      'Lower Second-Class Honours (2:2)',
      'Third-Class Honours (3rd)',
      'Pass (Ordinary Degree/Non-Honours)',
      'Other',
    ],
  ],
  [
    13,
    Shorttext,
    'If you selected other, please provide further details of your degree results/expected degree results.',
    null,
    [12, 'Other'],
  ],
  [14, YesNo, 'Do you currently have or are you working towards a postgraduate qualification?'],
  [
    15,
    Shorttext,
    'Please list details of which university/college or institution you are/will complete your postgraduate studies, and provide the qualification name.',
    null,
    [14, 'Yes'],
  ],
  [
    40,
    Singleselect,
    'Do you have any special circumstances you would like us to consider in your application?',
    [
      'Primary carer for a close relative ',
      'Parent or legal guardian for a child or children for whom you have significant caring responsibilities ',
      'Refugee status',
      'Care Leaver',
      'Not applicable',
      'Other',
    ],
  ],
  [
    42,
    YesNo,
    'Accenture is committed to not hiring employees who are not of the minimum legal age to work. For individuals under the age of 18, we have to confirm that they are legally entitled to work. Are you at least 18 years of age?',
  ],
  [43, Singleselect, 'Declaration', ['Yes I confirm with this statement']],
];

function App() {
  const [state, setState] = useState({});
  const onChange = (index, value) => setState((s) => ({ ...s, [index]: value }));
  return (
    <form id="application" onSubmit={(e) => e.preventDefault()}>
      <fieldset>
        <legend>2. Questions</legend>
        {QUESTIONS.map(([index, Kind, title, options, when]) =>
          when && state[when[0]] !== when[1] ? null : (
            <Kind key={index} index={index} title={title} options={options} onChange={onChange} />
          ),
        )}
      </fieldset>
      <pre id="state">{JSON.stringify(state)}</pre>
    </form>
  );
}

createRoot(document.getElementById('root')).render(<App />);
