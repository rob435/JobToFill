// An application form built the way Ant Design's docs build one (antd v6): one <Form> whose Form.Items carry the
// name, label and rules, a phone number as a dial-code Select and an Input side by side in Space.Compact (the
// "Registration" example), a long virtualized country Select (only ~10 rows are in the DOM, next to a 0×0
// role="listbox" kept for screen readers), a remote-search Select that shows a Spin while it "fetches" (the "Search
// and Select Users" example), button-style radios and date pickers with typed input. The site preselects Italy and
// +39 from the visitor's IP address. The form's own state (form.getFieldsValue(true)) and its validation errors are
// printed into #state, so tests check what the form registered.
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AutoComplete, Button, Checkbox, DatePicker, Form, Input, InputNumber, Radio, Select, Space, Spin } from 'antd';
import dayjs from 'dayjs';
import schools from '../data/schools.json';

const COUNTRIES = [
  ['AR', 'Argentina'],
  ['AU', 'Australia'],
  ['AT', 'Austria'],
  ['BD', 'Bangladesh'],
  ['BE', 'Belgium'],
  ['BR', 'Brazil'],
  ['BG', 'Bulgaria'],
  ['CA', 'Canada'],
  ['CL', 'Chile'],
  ['CN', 'China'],
  ['CO', 'Colombia'],
  ['HR', 'Croatia'],
  ['CY', 'Cyprus'],
  ['CZ', 'Czech Republic'],
  ['DK', 'Denmark'],
  ['EG', 'Egypt'],
  ['EE', 'Estonia'],
  ['FI', 'Finland'],
  ['FR', 'France'],
  ['DE', 'Germany'],
  ['GH', 'Ghana'],
  ['GR', 'Greece'],
  ['HK', 'Hong Kong'],
  ['HU', 'Hungary'],
  ['IS', 'Iceland'],
  ['IN', 'India'],
  ['ID', 'Indonesia'],
  ['IE', 'Ireland'],
  ['IL', 'Israel'],
  ['IT', 'Italy'],
  ['JP', 'Japan'],
  ['KE', 'Kenya'],
  ['KR', 'Korea, Republic of'],
  ['LV', 'Latvia'],
  ['LT', 'Lithuania'],
  ['LU', 'Luxembourg'],
  ['MY', 'Malaysia'],
  ['MT', 'Malta'],
  ['MX', 'Mexico'],
  ['NL', 'Netherlands'],
  ['NZ', 'New Zealand'],
  ['NG', 'Nigeria'],
  ['NO', 'Norway'],
  ['PK', 'Pakistan'],
  ['PE', 'Peru'],
  ['PH', 'Philippines'],
  ['PL', 'Poland'],
  ['PT', 'Portugal'],
  ['QA', 'Qatar'],
  ['RO', 'Romania'],
  ['SA', 'Saudi Arabia'],
  ['SG', 'Singapore'],
  ['SK', 'Slovakia'],
  ['SI', 'Slovenia'],
  ['ZA', 'South Africa'],
  ['ES', 'Spain'],
  ['LK', 'Sri Lanka'],
  ['SE', 'Sweden'],
  ['CH', 'Switzerland'],
  ['TW', 'Taiwan'],
  ['TH', 'Thailand'],
  ['TR', 'Turkey'],
  ['UA', 'Ukraine'],
  ['AE', 'United Arab Emirates'],
  ['GB', 'United Kingdom'],
  ['US', 'United States'],
  ['VN', 'Vietnam'],
].map(([value, label]) => ({ value, label }));

const DIAL_CODES = [
  '+1',
  '+31',
  '+33',
  '+34',
  '+39',
  '+41',
  '+44',
  '+49',
  '+61',
  '+65',
  '+81',
  '+86',
  '+91',
  '+353',
  '+852',
].map((code) => ({ value: code, label: code }));

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

const required = (message) => ({ required: true, message });

// Dates as the form holds them (dayjs objects), written out so the state is readable.
const plain = (v) =>
  dayjs.isDayjs(v) ? v.format('YYYY-MM-DD') : Array.isArray(v) ? v.map(plain) : v === undefined ? null : v;

function App() {
  const [form] = Form.useForm();
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
        initialValues={{ prefix: '+39', country: 'IT' }}
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
              <Select style={{ width: 96 }} options={DIAL_CODES} />
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
        <Form.Item
          name="graduationDate"
          label="Expected graduation date"
          rules={[required('Please enter your expected graduation date')]}
        >
          <DatePicker format="DD/MM/YYYY" style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="studyDates" label="Dates of study">
          <DatePicker.RangePicker format="DD/MM/YYYY" style={{ width: '100%' }} />
        </Form.Item>

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
