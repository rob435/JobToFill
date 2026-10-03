// An application form built the way custom Next.js / Tailwind career sites build them: Headless UI v2 widgets
// (Listbox, Combobox, a virtual Combobox, Checkbox, Switch, RadioGroup) and Downshift hooks (an async useCombobox,
// useSelect, useMultipleSelection), each used as its docs show, around plain controlled <input>s. The form's React
// state is printed into #state on every change, so tests check what the site itself registered.
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Checkbox,
  Combobox,
  ComboboxInput,
  ComboboxOption,
  ComboboxOptions,
  Field,
  Label,
  Listbox,
  ListboxButton,
  ListboxOption,
  ListboxOptions,
  Radio,
  RadioGroup,
  Switch,
} from '@headlessui/react';
import { useCombobox, useMultipleSelection, useSelect } from 'downshift';
import schools from '../data/schools.json';
import { COUNTRIES } from './lib-headless-data.mjs';

const DEGREES = [
  { id: 1, name: 'High School Diploma' },
  { id: 2, name: 'Associate’s Degree' },
  { id: 3, name: 'Bachelor’s Degree' },
  { id: 4, name: 'Master’s Degree' },
  { id: 5, name: 'MBA' },
  { id: 6, name: 'PhD' },
  { id: 7, name: 'Other' },
];
const COUNTRY_ITEMS = COUNTRIES.map((name, i) => ({ id: i + 1, name }));
const LOCATIONS = ['Chicago', 'Hong Kong', 'London', 'New York', 'San Francisco', 'Singapore'];
const SUBJECTS = [
  'Accounting',
  'Actuarial Science',
  'Applied Mathematics',
  'Biology',
  'Business Administration',
  'Chemical Engineering',
  'Chemistry',
  'Civil Engineering',
  'Computer Engineering',
  'Computer Science',
  'Data Science',
  'Economics',
  'Electrical Engineering',
  'English',
  'Finance',
  'History',
  'Information Systems',
  'Law',
  'Management',
  'Marketing',
  'Mathematics',
  'Mechanical Engineering',
  'Philosophy',
  'Physics',
  'Political Science',
  'Psychology',
  'Statistics',
];
const YEARS = Array.from({ length: 22 }, (_, i) => String(2010 + i));
const SKILLS = [
  'C++',
  'Excel',
  'Financial Modelling',
  'Java',
  'JavaScript',
  'Machine Learning',
  'MATLAB',
  'Power BI',
  'Python',
  'R',
  'SQL',
  'Tableau',
  'TypeScript',
  'VBA',
];

const cx = (...c) => c.filter(Boolean).join(' ');

/* ----------------------------------------------------------- Headless UI */

function DegreeListbox({ value, onChange }) {
  return (
    <Field className="field">
      <Label className="label">Degree</Label>
      <Listbox value={value} onChange={onChange} name="degree" by="id">
        <ListboxButton className="button">{value ? value.name : 'Select…'}</ListboxButton>
        <ListboxOptions anchor="bottom" className="options">
          {DEGREES.map((d) => (
            <ListboxOption key={d.id} value={d} className="option">
              {d.name}
            </ListboxOption>
          ))}
        </ListboxOptions>
      </Listbox>
    </Field>
  );
}

function CountryCombobox({ value, onChange }) {
  const [query, setQuery] = useState('');
  const filtered =
    query === '' ? COUNTRY_ITEMS : COUNTRY_ITEMS.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()));
  return (
    <Field className="field">
      <Label className="label">Country</Label>
      <Combobox value={value} onChange={onChange} onClose={() => setQuery('')} by="id">
        <ComboboxInput
          className="input"
          placeholder="Start typing…"
          displayValue={(c) => (c ? c.name : '')}
          onChange={(e) => setQuery(e.target.value)}
        />
        <ComboboxOptions anchor="bottom" className="options empty-invisible">
          {filtered.map((c) => (
            <ComboboxOption key={c.id} value={c} className="option">
              {c.name}
            </ComboboxOption>
          ))}
        </ComboboxOptions>
      </Combobox>
    </Field>
  );
}

// Thousands of schools: only the rows in view are rendered (Headless UI's `virtual` prop, TanStack Virtual inside).
function SchoolCombobox({ value, onChange }) {
  const [query, setQuery] = useState('');
  const filtered = query === '' ? schools : schools.filter((s) => s.toLowerCase().includes(query.toLowerCase()));
  return (
    <Field className="field">
      <Label className="label">School</Label>
      <Combobox value={value} onChange={onChange} onClose={() => setQuery('')} virtual={{ options: filtered }}>
        <ComboboxInput
          className="input"
          placeholder="Search for your school"
          displayValue={(s) => s || ''}
          onChange={(e) => setQuery(e.target.value)}
        />
        <ComboboxOptions anchor="bottom" className="options virtual empty-invisible">
          {({ option }) => (
            <ComboboxOption value={option} className="option">
              {option}
            </ComboboxOption>
          )}
        </ComboboxOptions>
      </Combobox>
    </Field>
  );
}

function LocationsListbox({ value, onChange }) {
  return (
    <Field className="field">
      <Label className="label">Preferred locations</Label>
      <Listbox value={value} onChange={onChange} multiple name="locations">
        <ListboxButton className="button">{value.length ? value.join(', ') : 'Select all that apply'}</ListboxButton>
        <ListboxOptions anchor="bottom" className="options">
          {LOCATIONS.map((l) => (
            <ListboxOption key={l} value={l} className="option">
              {l}
            </ListboxOption>
          ))}
        </ListboxOptions>
      </Listbox>
    </Field>
  );
}

function YesNo({ label, name, value, onChange }) {
  return (
    <Field className="field">
      <Label className="label">{label}</Label>
      <RadioGroup value={value} onChange={onChange} name={name} className="radios">
        {['Yes', 'No'].map((o) => (
          <Field key={o} className="radio-row">
            <Radio value={o} className="radio" />
            <Label>{o}</Label>
          </Field>
        ))}
      </RadioGroup>
    </Field>
  );
}

/* -------------------------------------------------------------- Downshift */

// Results come from the server 300 ms after typing, as from a search endpoint.
function FieldOfStudy({ value, onChange }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const timer = useRef(0);
  const { isOpen, getLabelProps, getMenuProps, getInputProps, getItemProps, highlightedIndex } = useCombobox({
    items,
    selectedItem: value,
    onSelectedItemChange: ({ selectedItem }) => onChange(selectedItem),
    onInputValueChange({ inputValue }) {
      clearTimeout(timer.current);
      if (!inputValue) {
        setItems([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      timer.current = setTimeout(() => {
        setItems(SUBJECTS.filter((s) => s.toLowerCase().includes(inputValue.toLowerCase())));
        setLoading(false);
      }, 300);
    },
  });
  return (
    <div className="field">
      <label className="label" {...getLabelProps()}>
        Field of study
      </label>
      <input className="input" placeholder="e.g. Economics" {...getInputProps()} />
      <ul className={cx('menu', !isOpen && 'hidden')} {...getMenuProps()}>
        {isOpen && loading && <li className="muted">Searching…</li>}
        {isOpen &&
          !loading &&
          items.map((item, index) => (
            <li
              key={item}
              className={cx('option', highlightedIndex === index && 'highlighted')}
              {...getItemProps({ item, index })}
            >
              {item}
            </li>
          ))}
      </ul>
    </div>
  );
}

function GraduationYear({ value, onChange }) {
  const { isOpen, getToggleButtonProps, getLabelProps, getMenuProps, getItemProps, highlightedIndex } = useSelect({
    items: YEARS,
    selectedItem: value,
    onSelectedItemChange: ({ selectedItem }) => onChange(selectedItem),
  });
  return (
    <div className="field">
      <label className="label" {...getLabelProps()}>
        Graduation year
      </label>
      <div className="button" {...getToggleButtonProps()}>
        <span>{value || 'Select year'}</span>
      </div>
      <ul className={cx('menu', !isOpen && 'hidden')} {...getMenuProps()}>
        {isOpen &&
          YEARS.map((item, index) => (
            <li
              key={item}
              className={cx('option', highlightedIndex === index && 'highlighted', value === item && 'selected')}
              {...getItemProps({ item, index })}
            >
              {item}
            </li>
          ))}
      </ul>
    </div>
  );
}

// Downshift's "multiple selection with combobox" recipe: chips, and a menu that stays open after each pick.
function Skills({ value, onChange }) {
  const [inputValue, setInputValue] = useState('');
  const items = SKILLS.filter((s) => !value.includes(s) && s.toLowerCase().includes(inputValue.toLowerCase()));
  const { getSelectedItemProps, getDropdownProps, removeSelectedItem } = useMultipleSelection({
    selectedItems: value,
    onStateChange({ selectedItems, type }) {
      switch (type) {
        case useMultipleSelection.stateChangeTypes.SelectedItemKeyDownBackspace:
        case useMultipleSelection.stateChangeTypes.SelectedItemKeyDownDelete:
        case useMultipleSelection.stateChangeTypes.DropdownKeyDownBackspace:
        case useMultipleSelection.stateChangeTypes.FunctionRemoveSelectedItem:
          onChange(selectedItems);
          break;
        default:
          break;
      }
    },
  });
  const { isOpen, getLabelProps, getMenuProps, getInputProps, highlightedIndex, getItemProps } = useCombobox({
    items,
    defaultHighlightedIndex: 0, // after selection, highlight the first item.
    selectedItem: null,
    inputValue,
    stateReducer(state, { changes, type }) {
      switch (type) {
        case useCombobox.stateChangeTypes.InputKeyDownEnter:
        case useCombobox.stateChangeTypes.ItemClick:
          return { ...changes, isOpen: true, highlightedIndex: 0 };
        default:
          return changes;
      }
    },
    onStateChange({ inputValue: newInputValue, type, selectedItem }) {
      switch (type) {
        case useCombobox.stateChangeTypes.InputKeyDownEnter:
        case useCombobox.stateChangeTypes.ItemClick:
        case useCombobox.stateChangeTypes.InputBlur:
          if (selectedItem) {
            onChange([...value, selectedItem]);
            setInputValue('');
          }
          break;
        case useCombobox.stateChangeTypes.InputChange:
          setInputValue(newInputValue);
          break;
        default:
          break;
      }
    },
  });
  return (
    <div className="field">
      <label className="label" {...getLabelProps()}>
        Skills
      </label>
      <div className="chips-box">
        {value.map((item, index) => (
          <span className="chip" key={item} {...getSelectedItemProps({ selectedItem: item, index })}>
            {item}
            <span
              className="chip-remove"
              onClick={(e) => {
                e.stopPropagation();
                removeSelectedItem(item);
              }}
            >
              ×
            </span>
          </span>
        ))}
        <input
          className="input bare"
          placeholder="Add a skill"
          {...getInputProps(getDropdownProps({ preventKeyAction: isOpen }))}
        />
      </div>
      <ul className={cx('menu', !(isOpen && items.length) && 'hidden')} {...getMenuProps()}>
        {isOpen &&
          items.map((item, index) => (
            <li
              key={item}
              className={cx('option', highlightedIndex === index && 'highlighted')}
              {...getItemProps({ item, index })}
            >
              {item}
            </li>
          ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ form */

function TextField({ id, label, type = 'text', value, onChange, autoComplete }) {
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <input
        className="input"
        id={id}
        name={id}
        type={type}
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function App() {
  const [s, setS] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    linkedin: '',
    degree: null,
    country: null,
    school: null,
    locations: [],
    terms: false,
    relocation: false,
    sponsorship: null,
    fieldOfStudy: null,
    graduationYear: null,
    skills: [],
  });
  const set = (key) => (v) => setS((prev) => ({ ...prev, [key]: v }));
  useEffect(() => {
    document.getElementById('state').textContent = JSON.stringify(s, null, 2);
  }, [s]);
  return (
    <form className="form" onSubmit={(e) => e.preventDefault()}>
      <h2>Personal information</h2>
      <div className="row">
        <TextField id="first_name" label="First name" value={s.firstName} onChange={set('firstName')} />
        <TextField id="last_name" label="Last name" value={s.lastName} onChange={set('lastName')} />
      </div>
      <TextField id="email" label="Email address" type="email" value={s.email} onChange={set('email')} />
      <TextField id="phone" label="Phone number" type="tel" value={s.phone} onChange={set('phone')} />
      <TextField id="linkedin" label="LinkedIn profile" value={s.linkedin} onChange={set('linkedin')} />
      <CountryCombobox value={s.country} onChange={set('country')} />

      <h2>Education</h2>
      <SchoolCombobox value={s.school} onChange={set('school')} />
      <DegreeListbox value={s.degree} onChange={set('degree')} />
      <FieldOfStudy value={s.fieldOfStudy} onChange={set('fieldOfStudy')} />
      <GraduationYear value={s.graduationYear} onChange={set('graduationYear')} />

      <h2>Preferences</h2>
      <LocationsListbox value={s.locations} onChange={set('locations')} />
      <Skills value={s.skills} onChange={set('skills')} />
      <Field className="field switch-row">
        <Label className="label">Open to relocation</Label>
        <Switch checked={s.relocation} onChange={set('relocation')} name="relocation" className="switch">
          <span className="knob" />
        </Switch>
      </Field>
      <YesNo
        label="Do you require sponsorship?"
        name="sponsorship"
        value={s.sponsorship}
        onChange={set('sponsorship')}
      />
      <Field className="field check-row">
        <Checkbox checked={s.terms} onChange={set('terms')} name="terms" className="checkbox">
          <svg viewBox="0 0 14 14" fill="none" className="tick">
            <path d="M3 8L6 11L11 3.5" strokeWidth={2} stroke="currentColor" />
          </svg>
        </Checkbox>
        <Label>I agree to the terms</Label>
      </Field>
      <button type="submit" className="submit">
        Submit application
      </button>
    </form>
  );
}

createRoot(document.getElementById('root')).render(<App />);
