// An application form built from the form-state and input libraries React sites use, each wired the way its docs
// show: react-hook-form (uncontrolled `register` inputs validated on blur, a `Controller`, valueAsNumber), Formik
// with a Yup schema, react-imask masks, react-phone-number-input (its country preset from where the visitor seems
// to be: Italy) and plain inputs with HTML constraint validation. Each library's own state (values, errors, the
// widget's value) is printed into #state, so tests check what the site itself registered.
//   ?section=rhf,formik,imask,phone,native  only those sections (default: all of them)
//   ?us                                      the masks a US site uses: (000) 000-0000, MM/DD/YYYY, a ZIP code
import { forwardRef, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Controller, useForm } from 'react-hook-form';
import { ErrorMessage, Field, Form, Formik } from 'formik';
import * as yup from 'yup';
import { IMask, IMaskInput } from 'react-imask';
import PhoneInput from 'react-phone-number-input';
import phoneCss from 'react-phone-number-input/style.css';

const style = document.createElement('style');
style.textContent = phoneCss;
document.head.append(style);

const params = new URLSearchParams(location.search);
const SECTIONS = (params.get('section') || 'rhf,formik,imask,phone,native').split(',');
const US = params.has('us');
// A London employer's site is in British English; the US variant is an American site's.
document.documentElement.lang = US ? 'en-US' : 'en-GB';

function Error({ id, children }) {
  return children ? (
    <p id={id} className="error" role="alert">
      {children}
    </p>
  ) : null;
}

/* ------------------------------------------------------------ react-hook-form */

// A design-system text box handed to a Controller: controlled, its value only what the form gives it.
const TextField = forwardRef(function TextField({ id, label, hint, value, onChange, onBlur, name, error }, ref) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {hint && <p className="hint">{hint}</p>}
      <input
        ref={ref}
        id={id}
        name={name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        aria-invalid={error ? 'true' : 'false'}
      />
      <Error>{error}</Error>
    </div>
  );
});

function RhfSection({ report }) {
  const { register, control, getValues, watch, formState, handleSubmit } = useForm({
    mode: 'onBlur',
    defaultValues: { firstName: '', lastName: '', email: '', linkedin: '', preferredName: '', salary: '' },
  });
  watch(); // re-render on every change, so the printed values are current
  const { errors, touchedFields } = formState;
  const values = getValues();
  // "Continue" runs every rule: 'valid', or the fields that failed.
  const [submit, setSubmit] = useState(null);
  useEffect(() =>
    report('rhf', {
      values,
      errors: Object.fromEntries(Object.entries(errors).map(([k, e]) => [k, e.message || e.type])),
      touched: Object.keys(touchedFields).sort(),
      submit,
    }),
  );
  const text = (name, label, rules, extra = {}) => (
    <div className="field">
      <label htmlFor={`rhf-${name}`}>{label}</label>
      <input
        id={`rhf-${name}`}
        aria-invalid={errors[name] ? 'true' : 'false'}
        aria-describedby={errors[name] ? `rhf-${name}-error` : undefined}
        {...extra}
        {...register(name, rules)}
      />
      <Error id={`rhf-${name}-error`}>{errors[name] && errors[name].message}</Error>
    </div>
  );
  return (
    <section id="rhf">
      <h2>Your details</h2>
      <form
        noValidate
        onSubmit={handleSubmit(
          () => setSubmit('valid'),
          (failed) => setSubmit(Object.keys(failed).sort()),
        )}
      >
        {text('firstName', 'First name *', { required: 'Enter your first name' }, { autoComplete: 'given-name' })}
        {text('lastName', 'Last name *', { required: 'Enter your last name' }, { autoComplete: 'family-name' })}
        <Controller
          name="preferredName"
          control={control}
          rules={{ maxLength: { value: 40, message: 'Use 40 characters or fewer' } }}
          render={({ field, fieldState }) => (
            <TextField
              id="rhf-preferredName"
              label="Preferred name"
              hint="If different from your first name"
              error={fieldState.error && fieldState.error.message}
              {...field}
            />
          )}
        />
        {text('email', 'Email address *', {
          required: 'Enter your email address',
          pattern: { value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, message: 'Enter a valid email address' },
        })}
        {text('linkedin', 'LinkedIn profile', {
          pattern: {
            value: /^https:\/\/(www\.)?linkedin\.com\/in\/[\w-]+\/?$/,
            message: 'Enter the full address of your profile, like https://www.linkedin.com/in/yourname',
          },
        })}
        {text(
          'salary',
          'Expected salary (£ per year)',
          {
            valueAsNumber: true,
            validate: (n) => Number.isNaN(n) || n > 0 || 'Enter a number',
          },
          { type: 'number' },
        )}
        <button type="submit">Continue</button>
      </form>
    </section>
  );
}

/* --------------------------------------------------------------- Formik + Yup */

const DEGREES = [
  'A-levels / Highers',
  'Foundation degree',
  'Bachelor’s degree (BA, BSc, BEng)',
  'Integrated Master’s (MEng, MSci)',
  'Master’s degree (MA, MSc, MBA)',
  'PhD / Doctorate',
  'Other',
];

const schema = yup.object({
  phone: yup
    .string()
    .required('Enter your phone number')
    .matches(/^\+?[0-9 ]{10,15}$/, 'Enter a phone number, like +44 7700 900123'),
  email: yup.string().required('Enter your email address').email('Enter a valid email address'),
  dob: yup
    .string()
    .required('Enter your date of birth')
    .matches(/^(0[1-9]|[12]\d|3[01])\/(0[1-9]|1[0-2])\/(19|20)\d\d$/, 'Enter your date of birth as DD/MM/YYYY'),
  degree: yup.string().required('Select your degree'),
});

function FormikReport({ report, formik, submitted }) {
  const { values, errors, touched } = formik;
  useEffect(() => report('formik', { values, errors, touched, submitted }));
  return null;
}

function FormikSection({ report }) {
  // "Continue" validates the whole schema; Formik only calls onSubmit when it passes.
  const [submitted, setSubmitted] = useState(false);
  const field = (name, label, props = {}, children) => (
    <div className="field">
      <label htmlFor={`fk-${name}`}>{label}</label>
      <Field id={`fk-${name}`} name={name} {...props}>
        {children}
      </Field>
      <ErrorMessage name={name}>{(msg) => <Error>{msg}</Error>}</ErrorMessage>
    </div>
  );
  return (
    <section id="formik">
      <h2>Contact and education</h2>
      <Formik
        initialValues={{ phone: '', email: '', dob: '', degree: '' }}
        validationSchema={schema}
        validateOnBlur
        validateOnChange={false}
        onSubmit={() => setSubmitted(true)}
      >
        {(formik) => (
          <Form noValidate>
            <FormikReport report={report} formik={formik} submitted={submitted} />
            {field('phone', 'Phone number *', { type: 'tel' })}
            {field('email', 'Email *', { type: 'email' })}
            {field('dob', 'Date of birth (DD/MM/YYYY) *')}
            {field(
              'degree',
              'Degree *',
              { as: 'select' },
              <>
                <option value="">Please select</option>
                {DEGREES.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </>,
            )}
            <button type="submit">Continue</button>
          </Form>
        )}
      </Formik>
    </section>
  );
}

/* ---------------------------------------------------------------- react-imask */

const range = (from, to, maxLength) => ({ mask: IMask.MaskedRange, from, to, maxLength });

const MASKS = US
  ? {
      phone: { mask: '(000) 000-0000' },
      dob: {
        mask: 'MM/DD/YYYY',
        blocks: { MM: range(1, 12, 2), DD: range(1, 31, 2), YYYY: range(1900, 2030) },
        lazy: false,
      },
      postcode: { mask: '00000' },
    }
  : {
      phone: { mask: '+{44} 0000 000000' },
      dob: {
        mask: 'DD/MM/YYYY',
        blocks: { DD: range(1, 31, 2), MM: range(1, 12, 2), YYYY: range(1900, 2030) },
        // The date shows its slots ("__/__/____") before anything is typed.
        lazy: false,
      },
      // UK postcodes: "G12 8QQ", "SW1A 1AA", "M1 1AE".
      postcode: { mask: 'a[a]0[*] 0aa', prepareChar: (s) => s.toUpperCase() },
    };

function ImaskSection({ report }) {
  const [s, setS] = useState({});
  useEffect(() => report('imask', s));
  const accept = (name) => (value, mask) =>
    setS((prev) => ({
      ...prev,
      [name]: value,
      [name + 'Unmasked']: mask.unmaskedValue,
      [name + 'Complete']: mask.masked.isComplete,
    }));
  const masked = (name, label, props) => (
    <div className="field">
      <label htmlFor={`im-${name}`}>{label}</label>
      <IMaskInput id={`im-${name}`} name={name} {...MASKS[name]} {...props} onAccept={accept(name)} />
    </div>
  );
  return (
    <section id="imask">
      <h2>Contact details</h2>
      <form noValidate onSubmit={(e) => e.preventDefault()}>
        {masked('phone', 'Phone', { type: 'tel' })}
        {masked('dob', 'Date of birth', {})}
        {masked('postcode', US ? 'ZIP code' : 'Postcode', {})}
      </form>
    </section>
  );
}

/* ---------------------------------------------------- react-phone-number-input */

function PhoneSection({ report }) {
  const [value, setValue] = useState();
  const [country, setCountry] = useState('IT');
  useEffect(() => report('phone', { value: value || null, country: country || null }));
  return (
    <section id="phone">
      <h2>Mobile</h2>
      <form noValidate onSubmit={(e) => e.preventDefault()}>
        <div className="field">
          <label htmlFor="mobile">Mobile phone number *</label>
          <PhoneInput id="mobile" defaultCountry="IT" value={value} onChange={setValue} onCountryChange={setCountry} />
        </div>
      </form>
    </section>
  );
}

/* --------------------------------------------------- native constraint validation */

function NativeSection({ report }) {
  const [s, setS] = useState({});
  useEffect(() => report('native', s));
  const track = (e) => {
    const el = e.target;
    setS((prev) => ({ ...prev, [el.name]: { value: el.value, valid: el.validity.valid } }));
  };
  return (
    <section id="native">
      <h2>Additional information</h2>
      <form onSubmit={(e) => e.preventDefault()} onInput={track} onChange={track}>
        <div className="field">
          <label htmlFor="nat-mobile">Mobile number (digits only)</label>
          <input id="nat-mobile" name="mobile" type="tel" pattern="[0-9]{10,11}" maxLength={11} required />
        </div>
        <div className="field">
          <label htmlFor="nat-email">Email</label>
          <input id="nat-email" name="email" type="email" required />
        </div>
        <div className="field">
          <label htmlFor="nat-linkedin">LinkedIn URL</label>
          <input id="nat-linkedin" name="linkedin" type="url" />
        </div>
        <div className="field">
          <label htmlFor="nat-start">Earliest start date</label>
          <input id="nat-start" name="start" type="date" min="2026-01-01" required />
        </div>
      </form>
    </section>
  );
}

/* ------------------------------------------------------------------------ page */

function App() {
  const [state, setState] = useState({});
  const report = useCallback(
    (key, data) =>
      setState((prev) => (JSON.stringify(prev[key]) === JSON.stringify(data) ? prev : { ...prev, [key]: data })),
    [],
  );
  const show = (name) => SECTIONS.includes(name);
  return (
    <>
      {show('rhf') && <RhfSection report={report} />}
      {show('formik') && <FormikSection report={report} />}
      {show('imask') && <ImaskSection report={report} />}
      {show('phone') && <PhoneSection report={report} />}
      {show('native') && <NativeSection report={report} />}
      <pre id="state">{JSON.stringify(state, null, 2)}</pre>
    </>
  );
}

createRoot(document.getElementById('root')).render(<App />);
