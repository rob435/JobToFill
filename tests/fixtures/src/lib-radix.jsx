// An application form built with Radix UI primitives, as shadcn/ui-style career sites use them: Select in its default
// item-aligned position (a long country list, only part of it in view, with scroll buttons) and with
// position="popper", Checkbox and RadioGroup (buttons over hidden native inputs, as Radix renders them inside a
// <form>), around plain controlled <input>s. The form's React state is printed into #state on every change.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as Select from '@radix-ui/react-select';
import * as Checkbox from '@radix-ui/react-checkbox';
import * as RadioGroup from '@radix-ui/react-radio-group';
import { COUNTRIES } from './lib-headless-data.mjs';

const SOURCES = [
  'Company website',
  'LinkedIn',
  'Indeed',
  'Glassdoor',
  'University careers service',
  'Careers fair',
  'Employee referral',
  'Other',
];

const Chevron = ({ up }) => (
  <svg width="12" height="12" viewBox="0 0 15 15" aria-hidden="true">
    <path d={up ? 'M4 9l3.5-3.5L11 9' : 'M4 6l3.5 3.5L11 6'} stroke="currentColor" fill="none" strokeWidth="1.5" />
  </svg>
);

function SelectItem({ value, children }) {
  return (
    <Select.Item value={value} className="item">
      <Select.ItemText>{children}</Select.ItemText>
      <Select.ItemIndicator className="indicator">✓</Select.ItemIndicator>
    </Select.Item>
  );
}

function SelectField({ id, label, placeholder, items, value, onChange, position }) {
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <Select.Root value={value} onValueChange={onChange} name={id} required>
        <Select.Trigger id={id} className="trigger">
          <Select.Value placeholder={placeholder} />
          <Select.Icon className="icon">
            <Chevron />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content className="content" position={position} sideOffset={position ? 4 : undefined}>
            <Select.ScrollUpButton className="scroll">
              <Chevron up />
            </Select.ScrollUpButton>
            <Select.Viewport className="viewport">
              {items.map((item) => (
                <SelectItem key={item} value={item}>
                  {item}
                </SelectItem>
              ))}
            </Select.Viewport>
            <Select.ScrollDownButton className="scroll">
              <Chevron />
            </Select.ScrollDownButton>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
    </div>
  );
}

function TextField({ id, label, type = 'text', value, onChange }) {
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <input className="input" id={id} name={id} type={type} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function App() {
  const [s, setS] = useState({
    fullName: '',
    email: '',
    phone: '',
    linkedin: '',
    country: '',
    source: '',
    over18: '',
    privacy: false,
  });
  const set = (key) => (v) => setS((prev) => ({ ...prev, [key]: v }));
  useEffect(() => {
    document.getElementById('state').textContent = JSON.stringify(s, null, 2);
  }, [s]);
  return (
    <form className="form" onSubmit={(e) => e.preventDefault()}>
      <TextField id="full_name" label="Full name" value={s.fullName} onChange={set('fullName')} />
      <TextField id="email" label="Email" type="email" value={s.email} onChange={set('email')} />
      <TextField id="phone" label="Phone" type="tel" value={s.phone} onChange={set('phone')} />
      <TextField id="linkedin" label="LinkedIn URL" type="url" value={s.linkedin} onChange={set('linkedin')} />
      <SelectField
        id="country"
        label="Country of residence"
        placeholder="Select a country"
        items={COUNTRIES}
        value={s.country}
        onChange={set('country')}
      />
      <SelectField
        id="source"
        label="How did you hear about us?"
        placeholder="Select an option"
        items={SOURCES}
        value={s.source}
        onChange={set('source')}
        position="popper"
      />
      <div className="field">
        <div className="label" id="over18-label">
          Are you over 18?
        </div>
        <RadioGroup.Root
          className="radios"
          aria-labelledby="over18-label"
          name="over18"
          value={s.over18}
          onValueChange={set('over18')}
          required
        >
          {['Yes', 'No'].map((o) => (
            <div className="radio-row" key={o}>
              <RadioGroup.Item className="radio" value={o} id={`over18-${o}`}>
                <RadioGroup.Indicator className="dot" />
              </RadioGroup.Item>
              <label htmlFor={`over18-${o}`}>{o}</label>
            </div>
          ))}
        </RadioGroup.Root>
      </div>
      <div className="field check-row">
        <Checkbox.Root
          className="checkbox"
          id="privacy"
          name="privacy"
          checked={s.privacy}
          onCheckedChange={(v) => set('privacy')(v === true)}
          required
        >
          <Checkbox.Indicator className="tick">✓</Checkbox.Indicator>
        </Checkbox.Root>
        <label htmlFor="privacy">I consent to the privacy notice</label>
      </div>
      <button type="submit" className="submit">
        Submit application
      </button>
    </form>
  );
}

createRoot(document.getElementById('root')).render(<App />);
