// An application form built the way Ant Design's docs build one (antd v6): one <Form> whose Form.Items carry the
// name, label and rules; the phone number as a dial-code Select named "prefix" and an Input side by side in
// Space.Compact under one label (the "Registration" example); long Selects with antd's default virtual lists (only
// the ~10 rows in view are in the DOM, next to a 0×0 role="listbox" kept for screen readers): the countries
// searchable, the dial codes not; a remote-search Select that shows a Spin while it "fetches" (the "Search and Select
// Users" example); a State question that appears for the United States; button-style radios, a Checkbox.Group and
// date pickers with typed input. The site preselects Italy and +39 from the visitor's IP address. The form's own
// state (form.getFieldsValue(true)) and its validation errors are printed into #state, so tests check what the form
// registered.
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AutoComplete, Button, Checkbox, DatePicker, Form, Input, InputNumber, Radio, Select, Space, Spin } from 'antd';
import dayjs from 'dayjs';
import schools from '../data/schools.json';

const COUNTRY_ROWS = [
  ['AR', 'Argentina', 54],
  ['AU', 'Australia', 61],
  ['AT', 'Austria', 43],
  ['BD', 'Bangladesh', 880],
  ['BE', 'Belgium', 32],
  ['BR', 'Brazil', 55],
  ['BG', 'Bulgaria', 359],
  ['CA', 'Canada', 1],
  ['CL', 'Chile', 56],
  ['CN', 'China', 86],
  ['CO', 'Colombia', 57],
  ['HR', 'Croatia', 385],
  ['CY', 'Cyprus', 357],
  ['CZ', 'Czech Republic', 420],
  ['DK', 'Denmark', 45],
  ['EG', 'Egypt', 20],
  ['EE', 'Estonia', 372],
  ['FI', 'Finland', 358],
  ['FR', 'France', 33],
  ['DE', 'Germany', 49],
  ['GH', 'Ghana', 233],
  ['GR', 'Greece', 30],
  ['HK', 'Hong Kong', 852],
  ['HU', 'Hungary', 36],
  ['IS', 'Iceland', 354],
  ['IN', 'India', 91],
  ['ID', 'Indonesia', 62],
  ['IE', 'Ireland', 353],
  ['IL', 'Israel', 972],
  ['IT', 'Italy', 39],
  ['JP', 'Japan', 81],
  ['KE', 'Kenya', 254],
  ['KR', 'Korea, Republic of', 82],
  ['LV', 'Latvia', 371],
  ['LT', 'Lithuania', 370],
  ['LU', 'Luxembourg', 352],
  ['MY', 'Malaysia', 60],
  ['MT', 'Malta', 356],
  ['MX', 'Mexico', 52],
  ['NL', 'Netherlands', 31],
  ['NZ', 'New Zealand', 64],
  ['NG', 'Nigeria', 234],
  ['NO', 'Norway', 47],
  ['PK', 'Pakistan', 92],
  ['PE', 'Peru', 51],
  ['PH', 'Philippines', 63],
  ['PL', 'Poland', 48],
  ['PT', 'Portugal', 351],
  ['QA', 'Qatar', 974],
  ['RO', 'Romania', 40],
  ['SA', 'Saudi Arabia', 966],
  ['SG', 'Singapore', 65],
  ['SK', 'Slovakia', 421],
  ['SI', 'Slovenia', 386],
  ['ZA', 'South Africa', 27],
  ['ES', 'Spain', 34],
  ['LK', 'Sri Lanka', 94],
  ['SE', 'Sweden', 46],
  ['CH', 'Switzerland', 41],
  ['TW', 'Taiwan', 886],
  ['TH', 'Thailand', 66],
  ['TR', 'Turkey', 90],
  ['UA', 'Ukraine', 380],
  ['AE', 'United Arab Emirates', 971],
  ['GB', 'United Kingdom', 44],
  ['US', 'United States', 1],
  ['VN', 'Vietnam', 84],
];
const COUNTRIES = COUNTRY_ROWS.map(([value, label]) => ({ value, label }));
// Dial codes as many sites list them: by country, the code after the name (not searchable).
const DIAL_CODES = COUNTRY_ROWS.map(([value, label, code]) => ({ value, label: `${label} (+${code})` }));

const US_STATES = [
  'Alabama',
  'Alaska',
  'Arizona',
  'Arkansas',
  'California',
  'Colorado',
  'Connecticut',
  'Delaware',
  'District of Columbia',
  'Florida',
  'Georgia',
  'Hawaii',
  'Idaho',
  'Illinois',
  'Indiana',
  'Iowa',
  'Kansas',
  'Kentucky',
  'Louisiana',
  'Maine',
  'Maryland',
  'Massachusetts',
  'Michigan',
  'Minnesota',
  'Mississippi',
  'Missouri',
  'Montana',
  'Nebraska',
  'Nevada',
  'New Hampshire',
  'New Jersey',
  'New Mexico',
  'New York',
  'North Carolina',
  'North Dakota',
  'Ohio',
  'Oklahoma',
  'Oregon',
  'Pennsylvania',
  'Rhode Island',
  'South Carolina',
  'South Dakota',
  'Tennessee',
  'Texas',
  'Utah',
  'Vermont',
  'Virginia',
  'Washington',
  'West Virginia',
  'Wisconsin',
  'Wyoming',
].map((label) => ({ value: label, label }));

const OFFICES = ['London', 'New York', 'Hong Kong', 'Singapore', 'Paris', 'Frankfurt', 'Tokyo', 'Sydney'];

const DEGREES = [
  'High school / A-levels',
  'Bachelor’s degree (BA, BSc, BEng)',
  'Master’s degree (MA, MSc, MEng)',
  'MBA',
  'PhD',
  'Other',
].map((v) => ({ value: v, label: v }));

const SOURCES = [
  'University careers service',
  'Careers fair',
  'LinkedIn',
  'Glassdoor',
  'Indeed',
  'Friend or colleague',
  'Our website',
  'Other',
].map((v) => ({ value: v, label: v }));

const CITIES = [
  'Aberdeen',
  'Amsterdam',
  'Belfast',
  'Birmingham',
  'Boston',
  'Bristol',
  'Cambridge',
  'Cardiff',
  'Chicago',
  'Dublin',
  'Edinburgh',
  'Glasgow',
  'Leeds',
  'Liverpool',
  'London',
  'Manchester',
  'Milan',
  'New York',
  'Oxford',
  'Paris',
  'Rome',
  'San Francisco',
];

// The "Search and Select Users" example: each search clears the list, shows a Spin, and fills it 400 ms later.
function UniversitySelect(props) {
  const [fetching, setFetching] = useState(false);
  const [options, setOptions] = useState([]);
  const timer = useRef(null);
  const onSearch = (value) => {
    clearTimeout(timer.current);
    setOptions([]);
    const q = value.trim().toLowerCase();
    if (!q) {
      setFetching(false);
      return;
    }
    setFetching(true);
    timer.current = setTimeout(() => {
      setOptions(
        schools
          .filter((s) => s.toLowerCase().includes(q))
          .slice(0, 20)
          .map((s) => ({ value: s, label: s })),
      );
      setFetching(false);
    }, 400);
  };
  return (
    <Select
      {...props}
      showSearch
      filterOption={false}
      onSearch={onSearch}
      notFoundContent={fetching ? <Spin size="small" /> : 'No results found'}
      options={options}
      placeholder="Start typing your university"
    />
  );
}

function CityInput(props) {
  const [options, setOptions] = useState([]);
  const onSearch = (text) => {
    const q = text.trim().toLowerCase();
    setOptions(q ? CITIES.filter((c) => c.toLowerCase().startsWith(q)).map((c) => ({ value: c })) : []);
  };
  return <AutoComplete {...props} options={options} onSearch={onSearch} placeholder="e.g. London" />;
}

// ?range asks for the dates of study (a RangePicker) instead of the graduation date; ?lang=en makes the page plain
// English (the site's own markup says en-GB).
const params = new URLSearchParams(location.search);
const RANGE = params.has('range');
if (params.get('lang')) document.documentElement.lang = params.get('lang');

const required = (message) => ({ required: true, message });

// Dates as the form holds them (dayjs objects), written out so the state is readable.
const plain = (v) =>
  dayjs.isDayjs(v) ? v.format('YYYY-MM-DD') : Array.isArray(v) ? v.map(plain) : v === undefined ? null : v;

function App() {
  const [form] = Form.useForm();
  // The State question only shows for the United States.
  const country = Form.useWatch('country', form);
  const [, setTick] = useState(0);
  const update = () => setTick((n) => n + 1);
  // The first render runs before the form has its initial values.
  useEffect(update, []);
  const values = form.getFieldsValue(true);
  const state = {
    values: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, plain(v)])),
    errors: Object.fromEntries(
      form
        .getFieldsError()
        .filter((f) => f.errors.length)
        .map((f) => [f.name.join('.'), f.errors]),
    ),
  };
  return (
    <>
      <Form
        form={form}
        name="apply"
        layout="vertical"
        style={{ maxWidth: 640 }}
        initialValues={{ prefix: 'IT', country: 'IT' }}
        onValuesChange={update}
        onFieldsChange={update}
        onFinish={update}
        scrollToFirstError
      >
        <h2>Personal details</h2>
        <Form.Item name="firstName" label="First name" rules={[required('Please enter your first name')]}>
          <Input autoComplete="given-name" />
        </Form.Item>
        <Form.Item name="lastName" label="Last name" rules={[required('Please enter your last name')]}>
          <Input autoComplete="family-name" />
        </Form.Item>
        <Form.Item
          name="email"
          label="Email"
          rules={[
            { type: 'email', message: 'The input is not a valid email address' },
            required('Please enter your email address'),
          ]}
        >
          <Input />
        </Form.Item>
        <Form.Item label="Phone number" required>
          <Space.Compact block>
            <Form.Item name="prefix" noStyle>
              <Select style={{ width: 220 }} options={DIAL_CODES} />
            </Form.Item>
            <Form.Item
              name="phone"
              noStyle
              rules={[
                required('Please enter your phone number'),
                { pattern: /^\d[\d ()-]{6,15}$/, message: 'Enter the number without the country code' },
              ]}
            >
              <Input style={{ width: '100%' }} />
            </Form.Item>
          </Space.Compact>
        </Form.Item>
        <Form.Item
          name="country"
          label="Country of residence"
          rules={[required('Please select your country of residence')]}
        >
          <Select showSearch optionFilterProp="label" options={COUNTRIES} placeholder="Select a country" />
        </Form.Item>
        {country === 'US' && (
          <Form.Item name="state" label="State" rules={[required('Please select your state')]}>
            <Select showSearch optionFilterProp="label" options={US_STATES} placeholder="Select a state" />
          </Form.Item>
        )}
        <Form.Item name="city" label="City" rules={[required('Please enter your city')]}>
          <CityInput />
        </Form.Item>
        <Form.Item name="linkedin" label="LinkedIn" rules={[{ type: 'url', message: 'Please enter a valid URL' }]}>
          <Input placeholder="https://www.linkedin.com/in/…" />
        </Form.Item>

        <h2>Education</h2>
        <Form.Item name="university" label="University" rules={[required('Please select your university')]}>
          <UniversitySelect />
        </Form.Item>
        <Form.Item name="degree" label="Degree" rules={[required('Please select your degree')]}>
          <Select options={DEGREES} placeholder="Select" />
        </Form.Item>
        {RANGE ? (
          <Form.Item name="studyDates" label="Dates of study" rules={[required('Please enter your dates of study')]}>
            <DatePicker.RangePicker format="DD/MM/YYYY" style={{ width: '100%' }} />
          </Form.Item>
        ) : (
          <Form.Item
            name="graduationDate"
            label="Expected graduation date"
            rules={[required('Please enter your expected graduation date')]}
          >
            <DatePicker format="DD/MM/YYYY" style={{ width: '100%' }} />
          </Form.Item>
        )}

        <h2>The role</h2>
        <Form.Item
          name="offices"
          label="Preferred office locations"
          rules={[required('Please choose at least one office')]}
        >
          <Select mode="multiple" allowClear options={OFFICES.map((o) => ({ value: o, label: o }))} />
        </Form.Item>
        <Form.Item name="officesConsidered" label="Which offices would you consider?">
          <Checkbox.Group options={OFFICES.slice(0, 5)} />
        </Form.Item>
        <Form.Item name="startMonth" label="Start month">
          <DatePicker picker="month" />
        </Form.Item>
        <Form.Item name="salary" label="Expected salary">
          <InputNumber min={0} step={1000} prefix="£" style={{ width: 200 }} />
        </Form.Item>
        <Form.Item
          name="sponsorship"
          label="Do you require visa sponsorship?"
          rules={[required('Please answer this question')]}
        >
          <Radio.Group
            optionType="button"
            buttonStyle="solid"
            options={[
              { label: 'Yes', value: 'yes' },
              { label: 'No', value: 'no' },
            ]}
          />
        </Form.Item>
        <Form.Item name="over18" label="Are you over 18?" rules={[required('Please answer this question')]}>
          <Radio.Group>
            <Radio value="yes">Yes</Radio>
            <Radio value="no">No</Radio>
          </Radio.Group>
        </Form.Item>
        <Form.Item name="source" label="How did you hear about us?">
          <Select options={SOURCES} placeholder="Select" />
        </Form.Item>
        <Form.Item name="coverLetter" label="Cover letter">
          <Input.TextArea rows={4} showCount maxLength={2000} />
        </Form.Item>
        <Form.Item
          name="privacy"
          valuePropName="checked"
          rules={[
            {
              validator: (_, value) =>
                value ? Promise.resolve() : Promise.reject(new Error('You must accept the privacy notice')),
            },
          ]}
        >
          <Checkbox>I have read and agree to the privacy notice</Checkbox>
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit">
            Submit application
          </Button>
        </Form.Item>
      </Form>
      <pre id="state">{JSON.stringify(state, null, 2)}</pre>
    </>
  );
}

createRoot(document.getElementById('root')).render(<App />);
