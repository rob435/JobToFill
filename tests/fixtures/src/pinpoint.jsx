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
      <pre id="state">{JSON.stringify(state)}</pre>
    </form>
  );
}

createRoot(document.getElementById('root')).render(<App />);
