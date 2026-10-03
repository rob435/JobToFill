// An application form built with Vue 3 and Element Plus, the way its docs show: an el-form with rules (validated
// on blur or change), el-input, el-select in its variants (plain, whose inner input is read-only; filterable;
// remote search; multiple), radio groups (el-radio and el-radio-button), el-checkbox, el-date-picker that shows
// DD/MM/YYYY and keeps YYYY-MM-DD, and el-input-number. Every dropdown and the date panel are teleported to <body>.
// The reactive model and each field's validation result are printed into #state.
import { createApp, reactive, ref } from 'vue';
import ElementPlus from 'element-plus';
import css from 'element-plus/dist/index.css';
import schools from '../data/schools.json';

const style = document.createElement('style');
style.textContent = css;
document.head.append(style);

// prettier-ignore
const COUNTRIES = [
  'Argentina', 'Australia', 'Austria', 'Bangladesh', 'Belgium', 'Brazil', 'Bulgaria', 'Canada', 'Chile', 'China',
  'Colombia', 'Croatia', 'Cyprus', 'Czech Republic', 'Denmark', 'Egypt', 'Estonia', 'Finland', 'France', 'Germany',
  'Ghana', 'Greece', 'Hong Kong', 'Hungary', 'Iceland', 'India', 'Indonesia', 'Ireland', 'Israel', 'Italy', 'Japan',
  'Kenya', 'Latvia', 'Lithuania', 'Luxembourg', 'Malaysia', 'Malta', 'Mexico', 'Morocco', 'Netherlands',
  'New Zealand', 'Nigeria', 'Norway', 'Pakistan', 'Peru', 'Philippines', 'Poland', 'Portugal', 'Romania',
  'Saudi Arabia', 'Singapore', 'Slovakia', 'Slovenia', 'South Africa', 'South Korea', 'Spain', 'Sri Lanka', 'Sweden',
  'Switzerland', 'Taiwan', 'Thailand', 'Turkey', 'Ukraine', 'United Arab Emirates', 'United Kingdom',
  'United States', 'Vietnam',
];

const DEGREES = ['High school / A-levels', 'Bachelor’s degree', 'Master’s degree', 'MBA', 'PhD', 'Other'];
const LOCATIONS = ['London', 'Edinburgh', 'Glasgow', 'Manchester', 'Dublin', 'New York', 'Hong Kong', 'Singapore'];

const required = (message, trigger = 'change') => ({ required: true, message, trigger });

const App = {
  setup() {
    const form = reactive({
      firstName: '',
      lastName: '',
      email: '',
      phone: '',
      country: '',
      university: '',
      degree: '',
      graduation: '',
      locations: [],
      sponsorship: '',
      relocate: '',
      salary: null,
      privacy: false,
    });
    const rules = {
      firstName: [required('Please enter your first name', 'blur')],
      lastName: [required('Please enter your last name', 'blur')],
      email: [
        required('Please enter your email address', 'blur'),
        { type: 'email', message: 'Please enter a valid email address', trigger: ['blur', 'change'] },
      ],
      phone: [
        required('Please enter your phone number', 'blur'),
        { pattern: /^\+?[0-9 ]{10,15}$/, message: 'Please enter a valid phone number', trigger: 'blur' },
      ],
      country: [required('Please select your country')],
      university: [required('Please select your university')],
      degree: [required('Please select your degree')],
      graduation: [required('Please pick your graduation date')],
      locations: [{ type: 'array', required: true, message: 'Please select at least one location', trigger: 'change' }],
      sponsorship: [required('Please answer this question')],
      relocate: [required('Please answer this question')],
      privacy: [
        {
          validator: (rule, value, callback) =>
            value ? callback() : callback(new Error('Please accept the privacy policy')),
          trigger: 'change',
        },
      ],
    };
    // What each rule last said: true, or the message shown under the field.
    const validation = reactive({});
    const onValidate = (prop, isValid, message) => {
      validation[prop] = isValid || message;
    };
    // "Continue" validates the whole form: 'valid', or the fields that failed.
    const formRef = ref();
    const review = ref(null);
    const submit = () =>
      formRef.value.validate((valid, failed) => {
        review.value = valid ? 'valid' : Object.keys(failed).sort();
      });
    // The university search asks the server: results come back 300 ms later.
    const universities = ref([]);
    const loading = ref(false);
    const searchUniversities = (query) => {
      if (!query) {
        universities.value = [];
        return;
      }
      loading.value = true;
      setTimeout(() => {
        const q = query.toLowerCase();
        universities.value = schools.filter((s) => s.toLowerCase().includes(q)).slice(0, 50);
        loading.value = false;
      }, 300);
    };
    return {
      form,
      rules,
      validation,
      onValidate,
      formRef,
      review,
      submit,
      universities,
      loading,
      searchUniversities,
      countries: COUNTRIES,
      degrees: DEGREES,
      locations: LOCATIONS,
    };
  },
  template: `
    <el-form ref="formRef" :model="form" :rules="rules" label-position="top" status-icon @validate="onValidate">
      <h2>Personal details</h2>
      <el-form-item label="First name" prop="firstName">
        <el-input v-model="form.firstName" autocomplete="given-name" />
      </el-form-item>
      <el-form-item label="Last name" prop="lastName">
        <el-input v-model="form.lastName" autocomplete="family-name" />
      </el-form-item>
      <el-form-item label="Email" prop="email">
        <el-input v-model="form.email" />
      </el-form-item>
      <el-form-item label="Phone number" prop="phone">
        <el-input v-model="form.phone" />
      </el-form-item>
      <el-form-item label="Country of residence" prop="country">
        <el-select v-model="form.country" filterable placeholder="Select">
          <el-option v-for="c in countries" :key="c" :label="c" :value="c" />
        </el-select>
      </el-form-item>

      <h2>Education</h2>
      <el-form-item label="University" prop="university">
        <el-select
          v-model="form.university"
          filterable
          remote
          :remote-method="searchUniversities"
          :loading="loading"
          placeholder="Start typing to search"
        >
          <el-option v-for="u in universities" :key="u" :label="u" :value="u" />
        </el-select>
      </el-form-item>
      <el-form-item label="Degree" prop="degree">
        <el-select v-model="form.degree" placeholder="Select">
          <el-option v-for="d in degrees" :key="d" :label="d" :value="d" />
        </el-select>
      </el-form-item>
      <el-form-item label="Graduation date" prop="graduation">
        <el-date-picker
          v-model="form.graduation"
          type="date"
          format="DD/MM/YYYY"
          value-format="YYYY-MM-DD"
          placeholder="Pick a date"
        />
      </el-form-item>

      <h2>Your preferences</h2>
      <el-form-item label="Preferred locations" prop="locations">
        <el-select v-model="form.locations" multiple placeholder="Select">
          <el-option v-for="l in locations" :key="l" :label="l" :value="l" />
        </el-select>
      </el-form-item>
      <el-form-item label="Will you now or in the future require visa sponsorship to work in the UK?" prop="sponsorship">
        <el-radio-group v-model="form.sponsorship">
          <el-radio value="Yes">Yes</el-radio>
          <el-radio value="No">No</el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="Are you willing to relocate?" prop="relocate">
        <el-radio-group v-model="form.relocate">
          <el-radio-button value="Yes">Yes</el-radio-button>
          <el-radio-button value="No">No</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="Expected salary (£)" prop="salary">
        <el-input-number v-model="form.salary" :min="0" :step="1000" />
      </el-form-item>
      <el-form-item prop="privacy">
        <el-checkbox v-model="form.privacy">I agree to the privacy policy</el-checkbox>
      </el-form-item>
      <el-button type="primary" @click="submit">Continue</el-button>
    </el-form>
    <pre id="state">{{ JSON.stringify({ form, validation, review }, null, 2) }}</pre>
  `,
};

createApp(App).use(ElementPlus).mount('#app');
