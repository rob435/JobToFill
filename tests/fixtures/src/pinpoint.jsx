// A replica of a Pinpoint (pinpointhq.com) application form: react-select dropdowns given the form's own
// input ids (so the ids no longer say "react-select-N-input"), most of them not searchable (a read-only
// dummy input), and options without ARIA roles. The live React state is printed into #state.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import Select, { components } from 'react-select';

const opts = (labels) => labels.map((label) => ({ label, value: label }));

// Older react-select (as on Pinpoint) renders the menu and its options without ARIA roles.
const noRole = (props) => {
  const innerProps = { ...props.innerProps };
  delete innerProps.role;
  delete innerProps['aria-selected'];
  delete innerProps['aria-multiselectable'];
  return { ...props, innerProps };
};
const Option = (props) => <components.Option {...noRole(props)} />;
const MenuList = (props) => <components.MenuList {...noRole(props)} />;

const FIELDS = [
  ['application_form_application_country', 'Country', ['United Kingdom', 'United States', 'Ireland'], true],
  [
    'application_form_answers_10_text_answer',
    'Which office location are you interested in?',
    ['London', 'Leeds', 'Aberdeen'],
    false,
  ],
  [
    'application_form_equality_monitoring_gender',
    'Gender',
    ['Male', 'Female', 'Non-Binary', 'Prefer Not To Say'],
    false,
  ],
  ['application_form_equality_monitoring_age_bracket', 'Age Bracket', ['16-24', '25-34', '35-44', '45+'], false],
];

function Field({ id, label, options, searchable, onChange }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <Select
        inputId={id}
        classNamePrefix="react-select"
        options={opts(options)}
        isSearchable={searchable}
        components={{ Option, MenuList }}
        onChange={(o) => onChange(id, o ? o.label : '')}
      />
    </div>
  );
}

// Custom questions as Pinpoint renders them (Shared::Form::Questions::Singleselect / Multiselect, as on
// alloyed.pinpointhq.com): a label holding the title, its additional information and a helper line; react-select,
// searchable, labelled by the title (a multi-select stays open while you pick); a single choice also has a <select>
// that only shows on phones.
const ordinal = (n) =>
  n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');
/** "Monday 12th October" for the Monday at least a week away, plus `offset` days. */
function slotDay(offset) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + 7);
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7) + offset);
  const weekday = d.toLocaleDateString('en-GB', { weekday: 'long' });
  return `${weekday} ${ordinal(d.getDate())} ${d.toLocaleDateString('en-GB', { month: 'long' })}`;
}
const SLOTS = [
  `${slotDay(0)} – 10:00-11:00`,
  `${slotDay(1)} – 14:00-15:00`,
  `${slotDay(2)} – 18:30-21:00`,
  `${slotDay(5)} – 10:00-11:00`,
  'None of these dates work for me',
];
const QUESTIONS = [
  [
    11,
    'How did you hear about Alloyed?',
    null,
    ['Indeed', 'Glassdoor', 'Social media', 'Linkedin', 'Company website', 'Employee referral', 'Other'],
    false,
  ],
  [
    12,
    '1st Stage Video Interview Availability',
    'Please select ALL dates/times for which you are available for a 30 minute video interview.',
    SLOTS,
    true,
  ],
];

function Question({ index, title, info, options, multi, onChange }) {
  const id = `application_form_application_answers_attributes_${index}_text_answer`;
  return (
    <div className="pad-v-3">
      <label className="external-form__label" htmlFor={id}>
        <span className="external-form__label--title external-form__label--required">
          {title}
          <abbr title="required">*</abbr>
          <span className="sr-only">Required</span>
        </span>
        {info && <span>{info}</span>}
        <div>{multi ? '(Multiple Choice)' : ''}</div>
      </label>
      <Select
        inputId={id}
        className="react-select"
        classNamePrefix="react-select"
        options={opts(options)}
        isMulti={multi}
        isClearable={!multi}
        closeMenuOnSelect={!multi}
        isSearchable
        aria-label={title}
        components={{ Option, MenuList }}
        onChange={(o) => onChange(id, multi ? (o || []).map((x) => x.label) : o ? o.label : '')}
      />
      {!multi && (
        <select
          className="hide-at-sm-block"
          id={`application_form_application_answers_attributes_${index}_mobile_select`}
          aria-label={title}
        >
          <option value="blank">Select...</option>
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function App() {
  const [state, setState] = useState({});
  const onChange = (id, value) => setState((s) => ({ ...s, [id]: value }));
  return (
    <form onSubmit={(e) => e.preventDefault()}>
      <div className="field">
        <label htmlFor="first_name">First Name</label>
        <input id="first_name" />
      </div>
      {FIELDS.map(([id, label, options, searchable]) => (
        <Field key={id} id={id} label={label} options={options} searchable={searchable} onChange={onChange} />
      ))}
      {QUESTIONS.map(([index, title, info, options, multi]) => (
        <Question
          key={index}
          index={index}
          title={title}
          info={info}
          options={options}
          multi={multi}
          onChange={onChange}
        />
      ))}
      <pre id="state">{JSON.stringify(state)}</pre>
      <pre id="slots" hidden>
        {JSON.stringify(SLOTS)}
      </pre>
    </form>
  );
}

createRoot(document.getElementById('root')).render(<App />);
