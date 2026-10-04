// Jane Street's application form (janestreet.html): its StandardDropdown class as the site ships it (minified in
// /static/js/main.js, here with readable names), chosen on the three <select>s, and the form's own wiring (the
// student fields shown once "Are you currently a student?" is Yes, the phone number put together with its code,
// the timeline and school-email boxes that appear on demand). #state shows what the form would submit.
import jQuery from 'jquery-ui-dist/node_modules/jquery/dist/jquery.js';
import chosenCss from 'chosen-js/chosen.css';

window.jQuery = window.$ = jQuery;
const $ = jQuery;
const style = document.createElement('style');
style.textContent = chosenCss;
document.head.append(style);

const INITIALISM_STOPWORDS = new Set(['of', 'the', 'at', 'and', 'in', 'for', 'de', 'a', 'an']);
const normalizeForSearch = (e) =>
  e
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
const tokenizeForSearch = (e) =>
  e
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
const getSignificantTokens = (e) => tokenizeForSearch(e).filter((t) => !INITIALISM_STOPWORDS.has(t));
function getInitialisms(tokens) {
  const out = [];
  for (let n = 0; n < tokens.length; n++) {
    let i = '';
    for (let o = n; o < tokens.length; o++) (i += tokens[o][0]).length > 1 && out.push(i);
  }
  return out;
}

class StandardDropdown {
  constructor(element) {
    this.element = element;
    this.items = [];
    this.selectedItems = [];
    this.otherSelected = false;
    this.isMultiselect = element.classList.contains('multiselect');
    this.includeOther = element.hasAttribute('data-include-other');
    this.getDropdownOptions();
    this.bindEvents();
    document.addEventListener('click', (e) => this.element.contains(e.target) || this.closeDropdown());
    const specify = this.element.querySelector('.specify-input');
    specify.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), specify.blur()));
  }
  bindEvents() {
    this.element.querySelector('.preview-box').addEventListener('click', () => this.openDropdown());
    this.element.querySelector('.dropdown-search-input').addEventListener('input', () => this.handleSearchInput());
    this.element
      .querySelectorAll('.category-name-container')
      .forEach((c) => c.addEventListener('click', () => c.classList.toggle('open')));
    this.element.querySelector('.dropdown-container').addEventListener('click', (e) => {
      const t = e.target.closest('li[data-dropdown-selection], button.clear-selection');
      if (t) this.isMultiselect ? this.handleMultiselect(t) : this.applySelection(t);
    });
  }
  closeDropdown() {
    this.element.classList.remove('open', 'searching');
    const filtered = this.element.querySelector('.filtered-items');
    this.element.querySelectorAll('.category-name-container').forEach((c) => c.classList.remove('open'));
    if (filtered) filtered.remove();
    this.element.querySelector('.dropdown-search-input').value = '';
  }
  handleMultiselect(li) {
    const value = li.getAttribute('data-dropdown-selection');
    const other = li.hasAttribute('data-other');
    const on = other ? !this.otherSelected : !this.selectedItems.includes(value);
    if (other) this.otherSelected = on;
    else if (on) this.selectedItems.push(value);
    else this.selectedItems = this.selectedItems.filter((v) => v !== value);
    this.element
      .querySelectorAll('li[data-dropdown-selection]')
      .forEach((e) => e.getAttribute('data-dropdown-selection') === value && e.classList.toggle('selected', on));
    this.updateMultiselectDisplay();
    if (other) {
      this.handleSpecify(on);
      this.closeDropdown();
      if (on) this.element.querySelector('.specify-input').focus();
    }
  }
  updateMultiselectDisplay() {
    const input = this.element.querySelector('.dropdown-selection');
    const text = this.element.querySelector('.preview-box .text');
    const placeholder = text.getAttribute('data-placeholder') || 'Select an option';
    const chosen = new Set(this.selectedItems);
    const values = this.items.map((e) => e.value).filter((v) => chosen.has(v));
    const shown = [...values];
    if (this.otherSelected) shown.push(this.otherValue);
    text.textContent = shown.length ? shown.join(', ') : placeholder;
    text.classList.toggle('selected', shown.length > 0);
    input.value = values.join(', ');
  }
  updateSelectedOption() {
    const box = this.element.querySelector('.selected-option');
    if (!box) return;
    const value = this.element.querySelector('.dropdown-selection').value;
    box.classList.toggle('hidden', !value);
    box.querySelector('.selected-option-label').textContent = value;
    box.querySelector('li').setAttribute('data-dropdown-selection', value);
    this.element
      .querySelectorAll('.items-container li, .filtered-items li')
      .forEach((e) => e.classList.toggle('hidden', !!value && e.getAttribute('data-dropdown-selection') === value));
  }
  openDropdown() {
    const filtered = this.element.querySelector('.filtered-items');
    this.updateSelectedOption();
    if (filtered) filtered.remove();
    this.element.classList.remove('searching');
    this.element.classList.add('open');
    this.element.querySelector('.dropdown-search-input').focus();
    if (!this.isMultiselect)
      this.handleSpecify(this.element.querySelector('.dropdown-selection').hasAttribute('data-requires-details'));
  }
  getDropdownOptions() {
    this.items = [];
    this.otherValue = null;
    this.otherItem = null;
    this.element.querySelectorAll('.items-container li').forEach((li) => {
      const value = li.getAttribute('data-dropdown-selection');
      if (li.hasAttribute('data-other')) return void (this.otherValue = value);
      if (value === 'Other') return void (this.otherItem = { value });
      const tokens = getSignificantTokens(value);
      this.items.push({
        value,
        normalizedValue: normalizeForSearch(value),
        searchTokens: tokens,
        searchValue: tokens.join(''),
        initialisms: getInitialisms(tokens),
        requiresDetails: li.hasAttribute('data-requires-details'),
      });
    });
  }
  getCollegeMatchScore(item, tokens, joined) {
    if (item.searchValue === joined) return -1;
    let score = 0;
    for (const t of tokens)
      if (!item.searchTokens.includes(t))
        if (item.searchTokens.some((s) => s.startsWith(t))) score = Math.max(score, 1);
        else {
          if (!item.initialisms.includes(t)) return null;
          score = Math.max(score, 2);
        }
    return score;
  }
  filterCollegeOptions(query) {
    const tokens = getSignificantTokens(query);
    if (!tokens.length) return [];
    const joined = tokens.join('');
    return this.items
      .map((item) => ({
        item,
        score: this.getCollegeMatchScore(item, tokens, joined),
        extra: Math.abs(item.searchTokens.length - tokens.length),
      }))
      .filter((e) => e.score !== null)
      .sort((a, b) => a.score - b.score || a.extra - b.extra || a.item.value.localeCompare(b.item.value))
      .slice(0, 50)
      .map((e) => e.item);
  }
  filterDropdownOptions(query) {
    const tokens = tokenizeForSearch(query);
    return this.items
      .filter((e) => tokens.length > 0 && tokens.every((t) => e.normalizedValue.includes(t)))
      .sort((a, b) => a.value.localeCompare(b.value));
  }
  handleSearchInput() {
    const query = this.element.querySelector('.dropdown-search-input').value;
    const old = this.element.querySelector('.filtered-items');
    if (old) old.remove();
    const container = this.element.querySelector('.dropdown-container');
    const searching = query.length > 0;
    this.element.classList.toggle('searching', searching);
    if (searching) {
      const ul = document.createElement('ul');
      ul.className = 'filtered-items';
      container.appendChild(ul);
    }
    const found = this.element.classList.contains('college')
      ? this.filterCollegeOptions(query)
      : this.filterDropdownOptions(query);
    const ul = this.element.querySelector('.filtered-items');
    if (ul) {
      found.forEach((e) => ul.appendChild(this.buildFilteredItem(e)));
      if (this.includeOther && query.length > 0)
        ul.appendChild(this.buildFilteredItem({ value: this.otherValue, isOther: true }));
      else if (this.otherItem) ul.appendChild(this.buildFilteredItem(this.otherItem));
      else if (!found.length) {
        const a = document.createElement('a');
        a.className = 'no-results';
        a.textContent = `"${query}" yielded no results`;
        ul.appendChild(a);
      }
    }
    this.updateSelectedOption();
  }
  buildFilteredItem({ value, requiresDetails = false, isOther = false }) {
    const li = document.createElement('li');
    li.setAttribute('data-dropdown-selection', value);
    li.toggleAttribute('data-requires-details', requiresDetails);
    li.toggleAttribute('data-other', isOther);
    li.textContent = value;
    const on = isOther ? this.otherSelected : this.selectedItems.includes(value);
    if (this.isMultiselect && on) li.classList.add('selected');
    return li;
  }
  handleSpecify(on) {
    const box = this.element.querySelector('.specify-box');
    const input = this.element.querySelector('.specify-input');
    box.classList.toggle('active', on);
    input.required = on;
    if (!on) input.value = '';
  }
  applySelection(li) {
    const value = li.getAttribute('data-dropdown-selection');
    const details = li.hasAttribute('data-requires-details') || li.hasAttribute('data-other');
    const input = this.element.querySelector('.dropdown-selection');
    const text = this.element.querySelector('.preview-box .text');
    const specify = this.element.querySelector('.specify-input');
    input.value = value;
    input.toggleAttribute('data-requires-details', details);
    text.textContent = value || text.getAttribute('data-placeholder') || 'Select an option';
    text.classList.toggle('selected', !!value);
    specify.value = '';
    this.handleSpecify(details);
    this.closeDropdown();
    if (li.hasAttribute('data-other')) specify.focus();
  }
}
document.querySelectorAll('.standard-dropdown').forEach((e) => new StandardDropdown(e));

// The phone number goes in with the dialling code its dropdown shows ("United States (+1)" by default).
const dialCode = (v) => ((v || '').match(/\((\+\d+)\)$/) || [])[1] || '';
function updatePhone() {
  const code = dialCode($("input[name='phone_country_code']").val());
  const number = ($('#phone-number').val() || '').trim();
  $('#phone').val(number ? (number.charAt(0) === '+' ? number : [code, number].filter(Boolean).join(' ')) : '');
  $('.phone-country-code .preview-box .text')
    .text(code || 'Code')
    .toggleClass('selected', !!code);
}
$('.phone-country-code .dropdown-selection').val('United States (+1)');
updatePhone();
$(document).on('click', '.phone-country-code li[data-dropdown-selection]', updatePhone);
$(document).on('input', '#phone-number', updatePhone);

// "Are you currently a student?" Yes shows the student fields.
$('input[name="student"]').on('change', () =>
  $('.student-fields').toggleClass('active', $('#student-true').is(':checked')),
);
// The boxes that appear on demand.
function conditional(trigger, field, container, isActive) {
  const update = () => {
    const on = isActive();
    $(field).prop('disabled', !on);
    $(container).prop('hidden', !on);
  };
  $(trigger).on('change', update);
  update();
}
conditional('input[name="recruiting_timelines"]', '#timeline-details', '.recruiting-timeline-details', () =>
  $('#recruiting_timelines-true').is(':checked'),
);
conditional('#no-university-email', '#university_email_reason', '.university-email-reason', () =>
  $('#no-university-email').is(':checked'),
);

(async () => {
  await import('chosen-js/chosen.jquery.js');
  $('.chosen-select').chosen({ width: '100%' });
})();

const form = document.getElementById('application-form');
function show() {
  const data = {};
  for (const [k, v] of new FormData(form)) {
    if (v instanceof File) data[k] = v.name || '';
    else data[k] = k in data ? [].concat(data[k], v) : v;
  }
  document.getElementById('state').textContent = JSON.stringify(data, null, 1);
}
['input', 'change', 'click', 'focusout'].forEach((t) => document.addEventListener(t, () => setTimeout(show, 0), true));
show();
