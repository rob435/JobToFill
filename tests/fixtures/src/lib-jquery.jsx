// An application form on an older careers site (an iCIMS-style portal, a WordPress job plugin, a PHP ATS): plain
// jQuery and vanilla widget plugins used the way their docs show. select2 (a country preselected from where the
// visitor seems to be, a multi-select and an ajax search), chosen, choices.js, Tom Select, intl-tel-input (also
// starting on the wrong country), Inputmask and jQuery UI. What each plugin itself registered (its own API's
// value, and the <select>/<input> it keeps for the form's submission) is printed into #state on every change.
//
// jQuery 3 (the one these plugins are written for: select2 4.0 and chosen still call $.trim / $.isArray, which
// jQuery 4 dropped) is the copy jquery-ui-dist depends on. The plugins find it as the global `jQuery`, so they
// are loaded once it is set.
import jQuery from 'jquery-ui-dist/node_modules/jquery/dist/jquery.js';
import Choices from 'choices.js';
import TomSelect from 'tom-select';
import intlTelInput from 'intl-tel-input/intlTelInputWithUtils';
import Inputmask from 'inputmask';
import schools from '../data/schools.json';
import select2Css from 'select2/dist/css/select2.css';
import chosenCss from 'chosen-js/chosen.css';
import choicesCss from 'choices.js/public/assets/styles/choices.css';
import tomSelectCss from 'tom-select/dist/css/tom-select.default.css';
import itiCss from 'intl-tel-input/dist/css/intlTelInput-no-assets.css';
import jqueryUiCss from 'jquery-ui-dist/jquery-ui.css';

window.jQuery = window.$ = jQuery;
const $ = jQuery;

const style = document.createElement('style');
style.textContent = [select2Css, chosenCss, choicesCss, tomSelectCss, itiCss, jqueryUiCss].join('\n');
document.head.append(style);

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
  ['LV', 'Latvia'],
  ['LT', 'Lithuania'],
  ['LU', 'Luxembourg'],
  ['MY', 'Malaysia'],
  ['MT', 'Malta'],
  ['MX', 'Mexico'],
  ['MA', 'Morocco'],
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
  ['RS', 'Serbia'],
  ['SG', 'Singapore'],
  ['SK', 'Slovakia'],
  ['SI', 'Slovenia'],
  ['ZA', 'South Africa'],
  ['KR', 'South Korea'],
  ['ES', 'Spain'],
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
];
const DEGREES = [
  'High School Diploma / A-Levels',
  'Associate Degree',
  "Bachelor's Degree (BA, BSc, BEng)",
  "Master's Degree (MA, MSc, MEng)",
  'MBA',
  'PhD / Doctorate',
  'Other',
];
const SUBJECTS = [
  'Accounting',
  'Actuarial Science',
  'Biology',
  'Business Administration',
  'Chemistry',
  'Civil Engineering',
  'Computer Engineering',
  'Computer Science',
  'Data Science',
  'Economics',
  'Electrical Engineering',
  'Finance',
  'History',
  'Law',
  'Management',
  'Mathematics',
  'Mechanical Engineering',
  'Philosophy, Politics and Economics',
  'Physics',
  'Statistics',
  'Other',
];
const LOCATIONS = [
  'London',
  'Edinburgh',
  'Glasgow',
  'Birmingham',
  'Dublin',
  'Frankfurt',
  'Paris',
  'New York',
  'San Francisco',
  'Hong Kong',
  'Singapore',
];
const TEAMS = [
  'Investment Banking',
  'Global Markets',
  'Asset Management',
  'Technology',
  'Quantitative Research',
  'Risk Management',
  'Operations',
];
const LANGUAGES = [
  'Arabic',
  'Cantonese',
  'Dutch',
  'English',
  'French',
  'German',
  'Hindi',
  'Italian',
  'Japanese',
  'Mandarin',
  'Portuguese',
  'Russian',
  'Spanish',
];
const SKILLS = ['C++', 'Excel', 'Financial Modelling', 'Java', 'JavaScript', 'Python', 'R', 'SQL', 'VBA'];
const SOURCES = [
  'LinkedIn',
  'Indeed',
  'Glassdoor',
  'University careers service',
  'Careers fair',
  'Friend or colleague',
  'Company website',
  'Other',
];
const CITIES = [
  'Aberdeen',
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
  'Los Angeles',
  'Manchester',
  'New York',
  'Oxford',
  'San Diego',
  'San Francisco',
  'San Jose',
  'Seattle',
];

const options = (select, labels, { blank, values } = {}) => {
  if (blank != null) select.append(new Option(blank, ''));
  labels.forEach((label, i) => select.append(new Option(label, values ? values[i] : label)));
};

const $id = (id) => document.getElementById(id);
const api = {};
const picked = { city: null };

function state() {
  const selected = (id) => Array.from($id(id).selectedOptions).map((o) => o.value);
  const s2 = (id) =>
    $('#' + id)
      .select2('data')
      .map((d) => d.text);
  const masked = (el) => ({
    value: el.value,
    unmasked: el.inputmask.unmaskedvalue(),
    complete: el.inputmask.isComplete(),
  });
  const date = $('#start_date').datepicker('getDate');
  // getSelectedCountryData() before intl-tel-input 25.
  const country = (api.iti.getSelectedCountry || api.iti.getSelectedCountryData).call(api.iti);
  return {
    first_name: $id('first_name').value,
    last_name: $id('last_name').value,
    email: $id('email').value,
    phone: {
      value: $id('phone').value,
      number: api.iti.getNumber(),
      iso2: country ? country.iso2 || '' : '',
      valid: api.iti.isValidNumber(),
    },
    mobile_us: masked($id('mobile_us')),
    dob: masked($id('dob')),
    country: { value: $('#country').val(), select2: s2('country') },
    city: { value: $id('city').value, picked: picked.city },
    university: { value: $('#university').val(), select2: s2('university') },
    degree: { value: $('#degree').val() },
    field_of_study: { value: $id('field_of_study').value, tomselect: api.fieldOfStudy.getValue() },
    locations: { value: selected('locations'), select2: s2('locations') },
    teams: { value: selected('teams'), choices: api.teams.getValue(true) },
    languages: { value: selected('languages') },
    skills: { value: selected('skills'), tomselect: api.skills.getValue() },
    source: { value: $id('source').value, choices: api.source.getValue(true) || '' },
    start_date: {
      value: $id('start_date').value,
      date: date
        ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
        : null,
    },
  };
}

let last = '';
function render() {
  if (!api.ready) return;
  const json = JSON.stringify(state(), null, 1);
  if (json === last) return;
  last = json;
  $id('state').textContent = json;
}

async function main() {
  // The plugins that attach themselves to the global jQuery.
  const { default: select2 } = await import('select2/dist/js/select2.full.js');
  select2(window, jQuery);
  await import('chosen-js/chosen.jquery.js');
  await import('jquery-ui-dist/jquery-ui.js');

  // select2: the country, preselected from the visitor's location (Italy), with a placeholder and a clear button.
  options(
    $id('country'),
    COUNTRIES.map((c) => c[1]),
    { blank: '', values: COUNTRIES.map((c) => c[0]) },
  );
  $id('country').value = 'IT';
  $('#country').select2({ placeholder: 'Select a country', allowClear: true, width: '100%' });

  // select2 multiple.
  options($id('locations'), LOCATIONS);
  $('#locations').select2({ placeholder: 'Choose locations', width: '100%' });

  // select2 with a remote search: results come 300 ms after typing.
  $('#university').select2({
    placeholder: 'Search for your university',
    minimumInputLength: 2,
    width: '100%',
    ajax: {
      delay: 250,
      transport(params, success) {
        const term = String((params.data && params.data.term) || '').toLowerCase();
        const timer = setTimeout(() => {
          const results = schools
            .filter((name) => name.toLowerCase().includes(term))
            .slice(0, 20)
            .map((name) => ({ id: name, text: name }));
          success({ results });
        }, 300);
        return { abort: () => clearTimeout(timer) };
      },
    },
  });

  // chosen.
  options($id('degree'), DEGREES, { blank: '' });
  $('#degree').chosen({ width: '100%' });
  options($id('languages'), LANGUAGES);
  $('#languages').chosen({ width: '100%' });

  // choices.js.
  options($id('source'), SOURCES, { blank: 'Please select' });
  api.source = new Choices($id('source'), { shouldSort: false, itemSelectText: '' });
  options($id('teams'), TEAMS);
  api.teams = new Choices($id('teams'), {
    removeItemButton: true,
    shouldSort: false,
    placeholderValue: 'Select teams',
  });

  // Tom Select: a searchable single select and a tags box that takes new entries.
  options($id('field_of_study'), SUBJECTS, { blank: '' });
  api.fieldOfStudy = new TomSelect($id('field_of_study'), { create: false, sortField: { field: 'text' } });
  options($id('skills'), SKILLS);
  api.skills = new TomSelect($id('skills'), { create: true, persist: false, plugins: ['remove_button'] });

  // intl-tel-input: Italy first (where the visitor seems to be), the dial code shown beside the number.
  api.iti = intlTelInput($id('phone'), { initialCountry: 'it', separateDialCode: true });

  // Inputmask.
  Inputmask('(999) 999-9999').mask($id('mobile_us'));
  Inputmask('99/99/9999').mask($id('dob'));

  // jQuery UI.
  $('#city').autocomplete({
    source: CITIES,
    select: (event, ui) => {
      picked.city = ui.item.value;
      setTimeout(render);
    },
  });
  $('#start_date').datepicker({ onSelect: () => setTimeout(render) });

  api.ready = true;
  // Plugins report changes with jQuery's own events (which never reach addEventListener), with native events on the
  // <select> they keep, or not at all (intl-tel-input's country): listen for all of them, and look again now and then.
  $(document).on('input change keyup click focusout select2:select select2:unselect select2:clear chosen:updated', () =>
    setTimeout(render),
  );
  document.addEventListener('countrychange', () => setTimeout(render), true);
  setInterval(render, 150);
  render();
}

main();
