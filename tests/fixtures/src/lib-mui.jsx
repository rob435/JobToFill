// An application form built with the real Material UI (@mui/material) and MUI X date pickers
// (@mui/x-date-pickers with AdapterDayjs), used the way their docs show: outlined TextFields, Autocompletes
// (a country the site pre-selects from your IP address, chips for several locations, an async school search
// that only lists what the server returns), Selects whose menus open in a portal, a NativeSelect, a RadioGroup,
// a Checkbox, a Switch, and date fields made of role="spinbutton" sections. The live React state is printed
// into #state so tests can check what the site itself registered. Built against the versions installed here:
// @mui/material 9 and @mui/x-date-pickers 9 (same DOM as v7 / v8 for these widgets, but the pickers' plain-<input>
// field is gone: "Available from" uses the masked-input custom field from the MUI X docs instead).
import { forwardRef, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import CircularProgress from '@mui/material/CircularProgress';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormLabel from '@mui/material/FormLabel';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import InputLabel from '@mui/material/InputLabel';
import ListItemText from '@mui/material/ListItemText';
import MenuItem from '@mui/material/MenuItem';
import NativeSelect from '@mui/material/NativeSelect';
import OutlinedInput from '@mui/material/OutlinedInput';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import { DateField } from '@mui/x-date-pickers/DateField';
import { usePickerAdapter, usePickerContext, useSplitFieldProps } from '@mui/x-date-pickers/hooks';
import { CalendarIcon } from '@mui/x-date-pickers/icons';
import { IMaskInput } from 'react-imask';
import schools from '../data/schools.json';

dayjs.extend(customParseFormat);

const COUNTRIES = [
  'Argentina',
  'Australia',
  'Austria',
  'Bangladesh',
  'Belgium',
  'Brazil',
  'Bulgaria',
  'Canada',
  'Chile',
  'China',
  'Colombia',
  'Croatia',
  'Cyprus',
  'Czech Republic',
  'Denmark',
  'Egypt',
  'Estonia',
  'Finland',
  'France',
  'Germany',
  'Ghana',
  'Greece',
  'Hong Kong',
  'Hungary',
  'Iceland',
  'India',
  'Indonesia',
  'Ireland',
  'Israel',
  'Italy',
  'Japan',
  'Kenya',
  'Latvia',
  'Lithuania',
  'Luxembourg',
  'Malaysia',
  'Malta',
  'Mexico',
  'Morocco',
  'Netherlands',
  'New Zealand',
  'Nigeria',
  'Norway',
  'Pakistan',
  'Peru',
  'Philippines',
  'Poland',
  'Portugal',
  'Qatar',
  'Romania',
  'Saudi Arabia',
  'Singapore',
  'Slovakia',
  'Slovenia',
  'South Africa',
  'South Korea',
  'Spain',
  'Sri Lanka',
  'Sweden',
  'Switzerland',
  'Taiwan',
  'Thailand',
  'Turkey',
  'Ukraine',
  'United Arab Emirates',
  'United Kingdom',
  'United States',
  'Vietnam',
];

const LOCATIONS = [
  'London',
  'Manchester',
  'Edinburgh',
  'Birmingham',
  'Dublin',
  'Paris',
  'Frankfurt',
  'New York',
  'Hong Kong',
  'Singapore',
];

const FIELDS_OF_STUDY = [
  'Accounting',
  'Biology',
  'Business Administration',
  'Chemistry',
  'Computer Engineering',
  'Computer Science',
  'Data Science',
  'Economics',
  'Electrical Engineering',
  'Finance',
  'History',
  'Law',
  'Mathematics',
  'Mechanical Engineering',
  'Philosophy',
  'Physics',
  'Politics',
  'Psychology',
  'Statistics',
  'Other',
];

const DEGREES = ['High school diploma', 'Associate’s', 'Bachelor’s', 'Master’s', 'MBA', 'PhD', 'Other'];
const SOURCES = [
  'LinkedIn',
  'Indeed',
  'Glassdoor',
  'Company website',
  'Referral',
  'University careers service',
  'Other',
];
const TEAMS = ['Investment Banking', 'Global Markets', 'Technology', 'Quantitative Research', 'Asset Management'];

/** The school search: the server answers ~400 ms after typing stops, with the names that contain the query. */
function searchSchools(query) {
  const q = query.trim().toLowerCase();
  return new Promise((resolve) =>
    setTimeout(() => resolve(q ? schools.filter((s) => s.toLowerCase().includes(q)).slice(0, 50) : []), 400),
  );
}

// MUI X "Custom field" docs, "Using a masked input" (react-imask): a plain <input> as the picker's field.
// v9 removed enableAccessibleFieldDOMStructure={false}; this is how its docs now give a single masked <input>.
const MaskedInput = forwardRef(function MaskedInput(props, ref) {
  const { onChange, ...other } = props;
  return (
    <IMaskInput
      {...other}
      mask="00/00/0000"
      inputRef={ref}
      overwrite
      onAccept={(value) => onChange({ target: { name: props.name, value } })}
    />
  );
});

function MaskedDateField(props) {
  const { forwardedProps } = useSplitFieldProps(props, 'date');
  const picker = usePickerContext();
  // "L" in English is "MM/DD/YYYY".
  const format = usePickerAdapter().expandFormat(picker.fieldFormat);
  const [text, setText] = useState(() => (picker.value && picker.value.isValid() ? picker.value.format(format) : ''));
  useEffect(() => {
    // The calendar picked a day: the box shows it.
    if (picker.value && picker.value.isValid() && picker.value.format(format) !== text)
      setText(picker.value.format(format));
  }, [picker.value]);
  const onChange = (e) => {
    const next = e.target.value;
    setText(next);
    const date = dayjs(next, format, true);
    if (next.length === format.length && date.isValid()) picker.setValue(date);
    else if (!next) picker.setValue(null);
  };
  return (
    <TextField
      {...forwardedProps}
      label={picker.label}
      name={picker.name}
      value={text}
      onChange={onChange}
      placeholder={format}
      ref={picker.rootRef}
      className={picker.rootClassName}
      fullWidth
      slotProps={{
        input: {
          inputComponent: MaskedInput,
          endAdornment: (
            <InputAdornment position="end">
              <IconButton aria-label="Choose date" ref={picker.triggerRef} onClick={() => picker.setOpen((o) => !o)}>
                <CalendarIcon />
              </IconButton>
            </InputAdornment>
          ),
        },
      }}
    />
  );
}

function SchoolSearch({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [options, setOptions] = useState([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let active = true;
    if (!inputValue || inputValue === value) {
      setOptions(value ? [value] : []);
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    searchSchools(inputValue).then((found) => {
      if (!active) return;
      setOptions(found);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [inputValue, value]);
  return (
    <Autocomplete
      id="school"
      open={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      options={options}
      loading={loading}
      filterOptions={(x) => x}
      value={value}
      noOptionsText="Start typing to search"
      onChange={(e, v) => onChange(v)}
      onInputChange={(e, v) => setInputValue(v)}
      renderInput={(params) => (
        <TextField
          {...params}
          label="School or university"
          required
          slotProps={{
            ...params.slotProps,
            input: {
              ...params.slotProps.input,
              endAdornment: (
                <>
                  {loading ? <CircularProgress color="inherit" size={20} /> : null}
                  {params.slotProps.input.endAdornment}
                </>
              ),
            },
          }}
        />
      )}
    />
  );
}

const iso = (d) => (d ? (d.isValid() ? d.format('YYYY-MM-DD') : 'Invalid Date') : null);

function App() {
  const [s, setS] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    linkedin: '',
    salary: '',
    coverLetter: '',
    // Geo-located: the site guesses where you are from your IP address.
    country: 'Italy',
    locations: [],
    school: null,
    fieldOfStudy: null,
    degree: '',
    heard: '',
    teams: [],
    authorizedUK: '',
    sponsorship: '',
    privacy: false,
    relocation: false,
    graduationDate: null,
    startDate: null,
    dob: null,
    availableFrom: null,
  });
  const set = (key) => (value) => setS((prev) => ({ ...prev, [key]: value }));
  const text = (key) => (e) => set(key)(e.target.value);
  const state = useMemo(
    () => ({
      ...s,
      graduationDate: iso(s.graduationDate),
      startDate: iso(s.startDate),
      dob: iso(s.dob),
      availableFrom: iso(s.availableFrom),
    }),
    [s],
  );
  return (
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <Box component="form" noValidate autoComplete="off" onSubmit={(e) => e.preventDefault()}>
        <Typography variant="h5" component="h2" gutterBottom>
          Personal details
        </Typography>
        <Stack spacing={2}>
          <Stack direction="row" spacing={2}>
            <TextField
              id="first-name"
              label="First name"
              required
              fullWidth
              value={s.firstName}
              onChange={text('firstName')}
            />
            <TextField
              id="last-name"
              label="Last name"
              required
              fullWidth
              value={s.lastName}
              onChange={text('lastName')}
            />
          </Stack>
          <TextField id="email" label="Email" type="email" required value={s.email} onChange={text('email')} />
          <TextField id="phone" label="Phone number" type="tel" value={s.phone} onChange={text('phone')} />
          <Autocomplete
            id="country"
            options={COUNTRIES}
            value={s.country}
            onChange={(e, v) => set('country')(v)}
            renderInput={(params) => <TextField {...params} label="Country" required />}
          />
          <DateField
            label="Date of birth"
            format="DD/MM/YYYY"
            value={s.dob}
            onChange={set('dob')}
            helperText="As shown on your passport"
          />
          <TextField
            id="linkedin"
            label="LinkedIn profile URL"
            value={s.linkedin}
            onChange={text('linkedin')}
            placeholder="https://www.linkedin.com/in/…"
          />
        </Stack>

        <Typography variant="h5" component="h2" gutterBottom sx={{ mt: 4 }}>
          Education
        </Typography>
        <Stack spacing={2}>
          <SchoolSearch value={s.school} onChange={set('school')} />
          <FormControl fullWidth required>
            <InputLabel id="degree-label">Degree</InputLabel>
            <Select
              labelId="degree-label"
              id="degree"
              value={s.degree}
              label="Degree"
              onChange={(e) => set('degree')(e.target.value)}
            >
              {DEGREES.map((d) => (
                <MenuItem key={d} value={d}>
                  {d}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <Autocomplete
            id="field-of-study"
            options={FIELDS_OF_STUDY}
            value={s.fieldOfStudy}
            onChange={(e, v) => set('fieldOfStudy')(v)}
            renderInput={(params) => <TextField {...params} label="Field of study" required />}
          />
          <DatePicker label="Graduation date" value={s.graduationDate} onChange={set('graduationDate')} />
        </Stack>

        <Typography variant="h5" component="h2" gutterBottom sx={{ mt: 4 }}>
          Your application
        </Typography>
        <Stack spacing={2}>
          <Autocomplete
            id="locations"
            multiple
            options={LOCATIONS}
            value={s.locations}
            onChange={(e, v) => set('locations')(v)}
            renderInput={(params) => <TextField {...params} label="Preferred locations" />}
          />
          <FormControl fullWidth>
            <InputLabel id="teams-label">Which teams interest you?</InputLabel>
            <Select
              labelId="teams-label"
              id="teams"
              multiple
              value={s.teams}
              onChange={(e) => set('teams')(e.target.value)}
              input={<OutlinedInput label="Which teams interest you?" />}
              renderValue={(selected) => selected.join(', ')}
            >
              {TEAMS.map((t) => (
                <MenuItem key={t} value={t}>
                  <Checkbox checked={s.teams.includes(t)} />
                  <ListItemText primary={t} />
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <TextField
            id="salary"
            label="Expected salary"
            type="number"
            value={s.salary}
            onChange={text('salary')}
            slotProps={{ input: { startAdornment: <InputAdornment position="start">£</InputAdornment> } }}
          />
          <DatePicker label="Earliest start date" value={s.startDate} onChange={set('startDate')} />
          <DatePicker
            label="Available from"
            value={s.availableFrom}
            onChange={set('availableFrom')}
            slots={{ field: MaskedDateField }}
          />
          <FormControl fullWidth>
            <InputLabel variant="standard" htmlFor="authorized-uk">
              Are you legally authorized to work in the United Kingdom?
            </InputLabel>
            <NativeSelect
              value={s.authorizedUK}
              onChange={text('authorizedUK')}
              inputProps={{ name: 'authorizedUK', id: 'authorized-uk' }}
            >
              <option value="" />
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </NativeSelect>
          </FormControl>
          <FormControl>
            <FormLabel id="sponsorship-label">Will you now or in the future require sponsorship?</FormLabel>
            <RadioGroup
              row
              aria-labelledby="sponsorship-label"
              name="sponsorship"
              value={s.sponsorship}
              onChange={text('sponsorship')}
            >
              <FormControlLabel value="yes" control={<Radio />} label="Yes" />
              <FormControlLabel value="no" control={<Radio />} label="No" />
            </RadioGroup>
          </FormControl>
          <FormControlLabel
            control={<Switch checked={s.relocation} onChange={(e) => set('relocation')(e.target.checked)} />}
            label="Open to relocation"
          />
          <FormControl fullWidth required>
            <InputLabel id="heard-label">How did you hear about us?</InputLabel>
            <Select
              labelId="heard-label"
              id="heard"
              value={s.heard}
              label="How did you hear about us?"
              onChange={(e) => set('heard')(e.target.value)}
            >
              {SOURCES.map((o) => (
                <MenuItem key={o} value={o}>
                  {o}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <TextField
            id="cover-letter"
            label="Cover letter"
            multiline
            minRows={4}
            value={s.coverLetter}
            onChange={text('coverLetter')}
          />
          <FormControlLabel
            required
            control={<Checkbox checked={s.privacy} onChange={(e) => set('privacy')(e.target.checked)} />}
            label="I agree to the privacy policy"
          />
          <Button type="submit" variant="contained">
            Submit application
          </Button>
        </Stack>
      </Box>
      <pre id="state">{JSON.stringify(state, null, 2)}</pre>
    </LocalizationProvider>
  );
}

createRoot(document.getElementById('root')).render(<App />);
