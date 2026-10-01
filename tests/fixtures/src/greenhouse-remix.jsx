// A replica of Greenhouse's current job board application form (job-boards.greenhouse.io),
// modelled on a real internship posting: real react-select, wired the way Greenhouse wires it
// (the menu is controlled: it opens on keyup, toggles on mouseup and closes on blur), "Attach"
// upload buttons over hidden file inputs, and checkbox fieldsets. The live React state is
// printed into #state so tests can check what the site itself registered.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import Select, { components } from 'react-select';
import AsyncSelect from 'react-select/async';
import schools from '../data/schools.json';

const opts = (labels) => labels.map((label, i) => ({ label, value: 1000 + i }));

const COUNTRIES = [
  ['United States', 'us', 1],
  ['Afghanistan', 'af', 93],
  ['Canada', 'ca', 1],
  ['France', 'fr', 33],
  ['Germany', 'de', 49],
  ['Guernsey', 'gg', 44],
  ['India', 'in', 91],
  ['Ireland', 'ie', 353],
  ['Isle of Man', 'im', 44],
  ['Jersey', 'je', 44],
  ['Singapore', 'sg', 65],
  ['United Kingdom', 'gb', 44],
].map(([name, iso2, dial]) => ({ label: `${name} +${dial}`, value: iso2 }));

const PLACES = [
  'Cupar, Scotland, United Kingdom',
  'Glasgow, Scotland, United Kingdom',
  'London, England, United Kingdom',
  'New York, New York, United States',
  'San Francisco, California, United States',
];

const QUESTIONS = {
  sponsorship: opts(['Yes', 'No']),
  degree: opts(['Bachelor’s', 'Master’s', 'PhD', 'Postdoc']),
  graduation: opts([
    'Spring 2025',
    'Fall 2025',
    'Winter 2026',
    'Spring/Summer 2026',
    'Fall 2026',
    'Winter 2027',
    'Spring/Summer 2027',
    'Fall 2027',
    'Winter 2028',
    'Spring/Summer 2028',
    'Fall 2028',
    'Winter 2029',
  ]),
  offers: opts(['Yes', 'No']),
  source: opts([
    'Friend / word of mouth',
    'Campus recruiting event',
    'Recruiter reached out to me',
    'Research conference',
    'Jump Website / Careers Page',
    'Online Job Board (e.g., Indeed, Glassdoor, ZipRecruiter)',
    'Social Media (e.g., LinkedIn, Reddit, Discord, Facebook, X, Instagram)',
    'Employee Referral',
    'University career services',
    'News article',
    'University alumni network',
    'Other',
  ]),
  school: opts(schools),
};
const OFFICES = opts(['Chicago', 'London', 'New York', 'Singapore']);
const RELOCATION = opts([
  'Chicago',
  'New York',
  'London',
  'Bristol',
  'Amsterdam',
  'Paris',
  'Singapore',
  'Shanghai',
  'Hong Kong',
  'Mumbai',
  'Sydney',
]);

// Greenhouse wraps the control in a div that opens the menu on keyup and toggles it on mouseup.
function Control(props) {
  const { onShellKeyUp, onShellMouseUp } = props.selectProps;
  return (
    <div onKeyUp={onShellKeyUp} onMouseUp={onShellMouseUp}>
      <components.Control {...props} />
    </div>
  );
}

function Label({ id, children, required }) {
  return (
    <label id={`${id}-label`} htmlFor={id} className="label select__label">
      {children}
      {required && <span aria-hidden="true">*</span>}
    </label>
  );
}

function GhSelect({
  id,
  label,
  required,
  options,
  isMulti,
  loadOptions,
  value,
  onChange,
  placeholder,
  clearable = true,
}) {
  const [open, setOpen] = useState(false);
  const common = {
    inputId: id,
    instanceId: id,
    classNamePrefix: 'select',
    className: 'select-shell',
    'aria-labelledby': `${id}-label`,
    'aria-required': required,
    placeholder: placeholder == null ? 'Select...' : placeholder,
    isMulti,
    isClearable: clearable,
    value,
    menuIsOpen: open,
    onShellKeyUp: (e) =>
      e.code === 'Escape' || e.code === 'Tab' ? setOpen(false) : e.code !== 'Enter' && setOpen(true),
    onShellMouseUp: () => setOpen((o) => !o),
    onBlur: () => setOpen(false),
    onChange: (v) => {
      onChange(v);
      setOpen(false);
    },
    components: { Control },
  };
  return (
    <div className="field-wrapper">
      <div className="select">
        <div className="select__container">
          <Label id={id} required={required}>
            {label}
          </Label>
          {loadOptions ? (
            <AsyncSelect {...common} loadOptions={loadOptions} cacheOptions />
          ) : (
            <Select {...common} options={options} />
          )}
        </div>
      </div>
    </div>
  );
}

function Text({ id, label, required, value, onChange, type, autoComplete }) {
  return (
    <div className="field-wrapper">
      <div className="text-input-wrapper">
        <div className="input-wrapper">
          <label id={`${id}-label`} htmlFor={id} className="label">
            {label}
            {required && <span aria-hidden="true">*</span>}
          </label>
          <input
            id={id}
            className="input input__single-line"
            aria-label={label}
            aria-required={required}
            type={type || 'text'}
            maxLength={255}
            autoComplete={autoComplete}
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      </div>
    </div>
  );
}

function Upload({ id, label, required, file, onChange }) {
  return (
    <div className="field-wrapper">
      <div role="group" aria-labelledby={`upload-label-${id}`} aria-required={required} className="file-upload">
        <div id={`upload-label-${id}`} className="label upload-label">
          {label}
          {required && <span className="required">*</span>}
        </div>
        {file ? (
          <div className="file-upload__filename">
            {file}{' '}
            <button type="button" aria-label="Remove file" onClick={() => onChange(null)}>
              ×
            </button>
          </div>
        ) : (
          <div className="button-container">
            <div>
              <button type="button" className="btn btn--pill" onClick={() => document.getElementById(id).click()}>
                Attach
              </button>
              <label className="visually-hidden" htmlFor={id}>
                Attach
              </label>
              <input
                id={id}
                className="visually-hidden"
                type="file"
                accept=".pdf,.doc,.docx,.txt,.rtf"
                onChange={(e) => onChange(e.target.files[0] ? e.target.files[0].name : null)}
              />
            </div>
            <button type="button" className="btn btn--pill">
              Dropbox
            </button>
            <button type="button" className="btn btn--pill">
              Enter manually
            </button>
            <p className="file-upload__filetypes">Accepted file types: pdf, doc, docx, txt, rtf</p>
          </div>
        )}
      </div>
    </div>
  );
}

function Checkboxes({ id, legend, required, options, values, onChange, description }) {
  const toggle = (value) => onChange(values.includes(value) ? values.filter((v) => v !== value) : [...values, value]);
  return (
    <div className="field-wrapper">
      <fieldset className="checkbox" id={id} aria-required={required}>
        <legend className="label checkbox__description">
          {legend}
          {required && <span className="required">*</span>}
        </legend>
        {options.map((o) => (
          <div className="checkbox__wrapper" key={o.value}>
            <div className="checkbox__input">
              <input
                description={legend}
                type="checkbox"
                id={`${id}_${o.value}`}
                name={id}
                value={String(o.value)}
                checked={values.includes(o.value)}
                onChange={() => toggle(o.value)}
              />
            </div>
            <label htmlFor={`${id}_${o.value}`}>{o.label}</label>
          </div>
        ))}
      </fieldset>
      {description && <div className="question-description">{description}</div>}
    </div>
  );
}

const loadPlaces = (input) =>
  new Promise((resolve) =>
    setTimeout(() => {
      const q = input.trim().toLowerCase();
      resolve(q ? PLACES.filter((p) => p.toLowerCase().includes(q)).map((p) => ({ label: p, value: p })) : []);
    }, 300),
  );

function App() {
  const [s, setS] = useState({ relocation: [], notice: [] });
  const set = (key) => (value) => setS((prev) => ({ ...prev, [key]: value }));
  const label = (v) => (Array.isArray(v) ? v.map((x) => x.label) : v ? v.label : null);
  const state = {
    ...s,
    country: label(s.country),
    location: label(s.location),
    sponsorship: label(s.sponsorship),
    school: label(s.school),
    degree: label(s.degree),
    graduation: label(s.graduation),
    offers: label(s.offers),
    source: label(s.source),
    offices: label(s.offices),
    relocation: s.relocation.map((v) => RELOCATION.find((o) => o.value === v).label),
  };
  return (
    <>
      <form id="application-form" className="application--form" onSubmit={(e) => e.preventDefault()}>
        <div className="application--questions">
          <Text
            id="first_name"
            label="First Name"
            required
            value={s.first}
            onChange={set('first')}
            autoComplete="given-name"
          />
          <Text
            id="last_name"
            label="Last Name"
            required
            value={s.last}
            onChange={set('last')}
            autoComplete="family-name"
          />
          <Text id="email" label="Email" required value={s.email} onChange={set('email')} autoComplete="email" />
          <fieldset className="phone-input">
            <legend className="visually-hidden">Phone</legend>
            <div className="phone-input__country">
              <GhSelect
                id="country"
                label="Country"
                required
                options={COUNTRIES}
                value={s.country || null}
                onChange={set('country')}
                placeholder=""
                clearable={false}
              />
            </div>
            <div className="phone-input__phone">
              <Text id="phone" label="Phone" required type="tel" value={s.phone} onChange={set('phone')} />
            </div>
          </fieldset>
          <GhSelect
            id="candidate-location"
            label="Location (City)"
            required
            loadOptions={loadPlaces}
            value={s.location || null}
            onChange={set('location')}
            placeholder=""
          />
          <Upload id="resume" label="Resume/CV" required file={s.resume} onChange={set('resume')} />
          <Upload id="cover_letter" label="Cover Letter" file={s.coverLetter} onChange={set('coverLetter')} />
        </div>
        <div className="application--questions">
          <hr />
          <Text id="question_1001" label="LinkedIn Profile" value={s.linkedin} onChange={set('linkedin')} />
          <Text
            id="question_1002"
            label="Non-compete/Notice period comments"
            required
            value={s.nonCompete}
            onChange={set('nonCompete')}
          />
          <GhSelect
            id="question_1003"
            label="Will you require sponsorship for work authorization in the future?"
            required
            options={QUESTIONS.sponsorship}
            value={s.sponsorship || null}
            onChange={set('sponsorship')}
          />
          <Checkboxes
            id="question_1004[]"
            legend="Review our Notice at Collection to learn how we will process your personal data."
            required
            options={opts(['Acknowledge/Confirm'])}
            values={s.notice}
            onChange={set('notice')}
            description="CANDIDATE PERSONAL DATA NOTICE AT COLLECTION"
          />
          <GhSelect
            id="question_1005"
            label="Please select your current school from the list below:"
            required
            options={QUESTIONS.school}
            value={s.school || null}
            onChange={set('school')}
          />
          <GhSelect
            id="question_1006[]"
            label="What degree are you currently pursuing?"
            required
            isMulti
            options={QUESTIONS.degree}
            value={s.degree || []}
            onChange={set('degree')}
          />
          <GhSelect
            id="question_1007"
            label="What is your expected graduation date?"
            required
            options={QUESTIONS.graduation}
            value={s.graduation || null}
            onChange={set('graduation')}
          />
          <GhSelect
            id="question_1008"
            label="Do you currently have any offers from other firms or deadlines we should be aware of?"
            required
            options={QUESTIONS.offers}
            value={s.offers || null}
            onChange={set('offers')}
          />
          <Text
            id="question_1009"
            label="If you said yes above, please tell us about your offers and deadlines."
            value={s.offerDetails}
            onChange={set('offerDetails')}
          />
          <Checkboxes
            id="question_1010[]"
            legend="Other than the location posted for this role, please indicate which other locations you are interested in relocating to:"
            options={RELOCATION}
            values={s.relocation}
            onChange={set('relocation')}
          />
          <div className="field-wrapper">
            <label id="offices-label" htmlFor="offices" className="label">
              Which offices would you consider?
            </label>
            {/* A react-select with no classNamePrefix: only hashed class names, like many sites. */}
            <Select
              inputId="offices"
              aria-labelledby="offices-label"
              isMulti
              options={OFFICES}
              value={s.offices || []}
              onChange={set('offices')}
            />
          </div>
          <GhSelect
            id="question_1011"
            label="How did you hear about us?"
            options={QUESTIONS.source}
            value={s.source || null}
            onChange={set('source')}
          />
          <Text
            id="question_1012"
            label='If you selected "Other" above, please specify:'
            value={s.otherSource}
            onChange={set('otherSource')}
          />
        </div>
        <button type="submit" className="btn btn--pill">
          Submit application
        </button>
      </form>
      <pre id="state">{JSON.stringify(state, null, 1)}</pre>
    </>
  );
}

createRoot(document.getElementById('root')).render(<App />);
