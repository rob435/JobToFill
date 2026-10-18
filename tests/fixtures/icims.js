// Behaviour of the iCIMS fixture pages (icims-candidate.html, framed by icims.html), written to act as iCIMS's own
// scripts do on globalcampus-amd.icims.com:
// - its searchable dropdown (common/icimsDropdown.js): the <select> is kept for the form but hidden (class
//   dropdown-hide: position fixed, visibility hidden); an <a class="dropdown-select" role="combobox"> shows the
//   choice and opens, on mousedown only, a menu with its own "— Type to Search —" box (role="combobox" too) over a
//   role="listbox" that draws 25 rows at a time and the next 25 as it is scrolled. A list loaded from the server
//   (the default, unless icimsdropdown-ajax="0") keeps only its "legacy" options in the <select> and searches 500ms
//   after the last keyup (never on an input event); a pick puts that one option in the <select>, without a change
//   event on it, then calls the select's own onchange. A list that depends on another (data-ddd-parent-link:
//   Region on Country) asks for that one's value, and says "Please select a country" while it has nothing.
// - its field collections ("Phones (1)", "Education (2)"): "Add More (Education)" shows the next group and hides its
//   own row; the group's × empties it and hides it again.
// - its résumé upload: choosing a file sends the whole profile form at once, with &uploadResume=1, and the page
//   comes back with what iCIMS read from the CV (icims-candidate.html stands in for that).
// window.ICIMSFX.dropdowns[id] is each dropdown's own state, for the tests (getSelected(), state()).
window.ICIMSFX = (function () {
  'use strict';

  const dropdowns = {};
  const LIMIT = 25;
  const PLACEHOLDER = '— Make a Selection —';
  const SEARCH = '— Type to Search —';
  const NO_RESULTS = 'No Results';
  // What the server was asked, for the tests: { id, q, page, parentValue }.
  const requests = [];

  /* ------------------------------------------------------------------ the lists iCIMS serves */

  // prettier-ignore
  const COUNTRIES = [
    'Afghanistan', 'Argentina', 'Australia', 'Austria', 'Bangladesh', 'Belgium', 'Brazil', 'Bulgaria', 'Canada',
    'Chile', 'China', 'Colombia', 'Croatia', 'Cyprus', 'Czech Republic', 'Denmark', 'Egypt', 'Estonia', 'Finland',
    'France', 'Germany', 'Ghana', 'Greece', 'Hong Kong', 'Hungary', 'Iceland', 'India', 'Indonesia', 'Ireland',
    'Israel', 'Italy', 'Japan', 'Kenya', 'Korea, Republic of', 'Latvia', 'Lithuania', 'Luxembourg', 'Malaysia',
    'Malta', 'Mexico', 'Netherlands', 'New Zealand', 'Nigeria', 'Norway', 'Pakistan', 'Philippines', 'Poland',
    'Portugal', 'Romania', 'Saudi Arabia', 'Serbia', 'Singapore', 'Slovakia', 'Slovenia', 'South Africa', 'Spain',
    'Sri Lanka', 'Sweden', 'Switzerland', 'Taiwan', 'Thailand', 'Turkey', 'Uganda', 'Ukraine', 'United Arab Emirates',
    'United Kingdom', 'United States', 'United States Minor Outlying Islands', 'Uruguay', 'Vietnam', 'Zambia',
    'Zimbabwe',
  ];
  // prettier-ignore
  const REGIONS = {
    'United Kingdom': [
      'Aberdeenshire', 'Angus', 'Argyll and Bute', 'Bedfordshire', 'Berkshire', 'Bristol', 'Buckinghamshire',
      'Cambridgeshire', 'Cardiff', 'Cheshire', 'City of Edinburgh', 'Cornwall', 'County Antrim', 'County Down',
      'Cumbria', 'Derbyshire', 'Devon', 'Dorset', 'Dundee City', 'Durham', 'East Lothian', 'East Sussex', 'Essex',
      'Falkirk', 'Fife', 'Glasgow City', 'Gloucestershire', 'Greater London', 'Greater Manchester', 'Gwynedd',
      'Hampshire', 'Hertfordshire', 'Highland', 'Kent', 'Lancashire', 'Leicestershire', 'Lincolnshire', 'Merseyside',
      'Midlothian', 'Norfolk', 'North Yorkshire', 'Northamptonshire', 'Nottinghamshire', 'Oxfordshire',
      'Perth and Kinross', 'Powys', 'Renfrewshire', 'Shropshire', 'Somerset', 'South Lanarkshire', 'South Yorkshire',
      'Staffordshire', 'Stirling', 'Suffolk', 'Surrey', 'Swansea', 'Tyne and Wear', 'Warwickshire', 'West Lothian',
      'West Midlands', 'West Sussex', 'West Yorkshire', 'Wiltshire', 'Worcestershire',
    ],
    'United States': [
      'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware',
      'District of Columbia', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas',
      'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi', 'Missouri',
      'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey', 'New Mexico', 'New York', 'North Carolina',
      'North Dakota', 'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota',
      'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming',
    ],
    Canada: ['Alberta', 'British Columbia', 'Manitoba', 'New Brunswick', 'Nova Scotia', 'Ontario', 'Quebec'],
  };
  // prettier-ignore
  const SCHOOLS = [
    'Aberystwyth University', 'Arizona State University', 'Boston University', 'Brown University',
    'California Institute of Technology', 'Cardiff University', 'Carnegie Mellon University', 'Columbia University',
    'Cornell University', 'Duke University', 'Durham University', 'Edinburgh Napier University',
    'Georgia Institute of Technology', 'Glasgow Caledonian University', 'Harvard University', 'Heriot-Watt University',
    'Imperial College London', "King's College London", 'Lancaster University',
    'London School of Economics and Political Science', 'Loughborough University',
    'Massachusetts Institute of Technology', 'New York University', 'Newcastle University', 'Northeastern University',
    'Princeton University', 'Purdue University', 'Queen Mary University of London', "Queen's University Belfast",
    'Robert Gordon University', 'Stanford University', 'Texas A&M University', 'The University of Edinburgh',
    'The University of Manchester', 'The University of Texas at Austin', 'University College London',
    'University of Aberdeen', 'University of Bath', 'University of Birmingham', 'University of Bristol',
    'University of California, Berkeley', 'University of California, Los Angeles', 'University of Cambridge',
    'University of Dundee', 'University of Exeter', 'University of Glasgow', 'University of Illinois Urbana-Champaign',
    'University of Leeds', 'University of Michigan', 'University of Nottingham', 'University of Oxford',
    'University of Pennsylvania', 'University of Southampton', 'University of St Andrews', 'University of Stirling',
    'University of Strathclyde', 'University of Sussex', 'University of Toronto', 'University of Warwick',
    'University of Waterloo', 'University of the West of Scotland', 'University of York', 'Yale University',
  ];
  // prettier-ignore
  const DEGREES = [
    'High School Diploma or Equivalent', 'Some College', "Associate's Degree", "Bachelor's Degree", "Master's Degree",
    'MBA', 'Doctorate (PhD)', 'Juris Doctor (JD)', 'Doctor of Medicine (MD)', 'Certificate', 'Other',
  ];
  // prettier-ignore
  const MAJORS = [
    'Accounting', 'Aerospace Engineering', 'Applied Mathematics', 'Biology', 'Biomedical Engineering',
    'Business Administration', 'Chemical Engineering', 'Chemistry', 'Civil Engineering', 'Computer Engineering',
    'Computer Science', 'Computer Science and Engineering', 'Data Science', 'Economics',
    'Electrical and Computer Engineering', 'Electrical Engineering', 'Electronic Engineering', 'Engineering Physics',
    'Finance', 'Information Systems', 'Information Technology', 'Management', 'Materials Science', 'Mathematics',
    'Mechanical Engineering', 'Mechatronics', 'Physics', 'Software Engineering', 'Statistics', 'Other',
  ];
  // The list behind each field, by its name after the entry's prefix (iCIMS's `id` parameter).
  const LISTS = {
    'PersonProfileFields.AddressCountry': () => COUNTRIES,
    'WorkExperienceFields.Country': () => COUNTRIES,
    'PersonProfileFields.AddressState': (country) => REGIONS[country] || [],
    'WorkExperienceFields.State': (country) => REGIONS[country] || [],
    'EducationFields.School': () => SCHOOLS,
    'EducationFields.Degree': () => DEGREES,
    'EducationFields.Major': () => MAJORS,
  };
  // Every text's value, numeric as iCIMS's, and the same on every list that has it (a page's own short lists too).
  const ids = new Map();
  const texts = {};
  const idOf = (text) => {
    if (!ids.has(text)) {
      ids.set(text, String(20000 + ids.size));
      texts[ids.get(text)] = text;
    }
    return ids.get(text);
  };
  [COUNTRIES, ...Object.values(REGIONS), SCHOOLS, DEGREES, MAJORS].forEach((list) => list.forEach(idOf));

  /** iCIMS's /jobs/profileoptions: 25 options a page, those containing `q`, after a moment on the network. */
  function profileoptions({ id, q, page, parentValue }) {
    requests.push({ id, q, page, parentValue });
    const all = (LISTS[id] ? LISTS[id](texts[parentValue] || '') : []).filter((t) =>
      t.toLowerCase().includes(q.toLowerCase()),
    );
    const options = all.slice(page * LIMIT, (page + 1) * LIMIT).map((t) => ({ value: idOf(t), text: t }));
    return new Promise((resolve) => setTimeout(() => resolve({ options, total: all.length }), 120));
  }

  /* ------------------------------------------------------------------ the dropdown */

  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);
  const fieldId = (list) => list.name.substring(list.name.lastIndexOf('_') + 1);
  const parentOf = (list) => {
    const link = list.getAttribute('data-ddd-parent-link');
    if (!link) return null;
    const prefix = list.name.substring(0, list.name.lastIndexOf('_'));
    return document.getElementById(link) || document.getElementById(prefix + '_' + link);
  };

  /** Make `list` (a <select>) an iCIMS searchable dropdown; `onchange(list, word)` follows each pick. */
  function dropdown(list, onchange) {
    const search = list.getAttribute('icimsdropdown-search') !== '0';
    const ajax = list.getAttribute('icimsdropdown-ajax') !== '0';
    const dependent = !!list.getAttribute('data-ddd-parent-link');
    let placeholder = PLACEHOLDER;
    let open = false;
    let words = [];
    let legacy = [];
    let matches = [];
    let page = 0;
    let pages = 1;
    let pending = null;
    let focusIndex = -1;
    let selected = {};
    let timer = null;
    let lastInput = '';

    const label = document.getElementById('label_' + list.id);
    const face = document.createElement('a');
    face.id = list.id + '_icimsDropdown';
    face.className = 'dropdown-select';
    face.setAttribute('aria-expanded', 'false');
    face.setAttribute('tabIndex', '0');
    face.setAttribute('aria-label', label ? label.textContent : placeholder);
    if (list.getAttribute('aria-required')) {
      face.setAttribute('aria-required', list.getAttribute('aria-required'));
      list.removeAttribute('aria-required');
    }
    face.setAttribute('role', 'combobox');
    if (list.id.includes('PersonProfileFields.AddressCountry')) face.setAttribute('autocomplete', 'country-name');
    if (list.id.includes('PersonProfileFields.AddressState')) face.setAttribute('autocomplete', 'address-level1');
    const shown = document.createElement('span');
    shown.id = list.id + '_fakeSelected_icimsDropdown';
    shown.className = 'dropdown-text';
    shown.textContent = placeholder;
    face.appendChild(shown);
    list.after(face);

    const container = document.createElement('div');
    container.id = face.id + '_ctnr';
    container.className = 'dropdown-container dropdown-invisible';
    container.setAttribute('aria-owns', list.id + '_dropdown-results');
    container.setAttribute('aria-expanded', 'false');
    face.after(container);
    const box = document.createElement('input');
    box.type = 'text';
    box.className = 'dropdown-search' + (search ? '' : ' dropdown-invisible');
    box.setAttribute('autocomplete', 'off');
    box.setAttribute('placeholder', SEARCH);
    box.setAttribute('title', SEARCH);
    box.setAttribute('aria-label', SEARCH);
    box.setAttribute('role', 'combobox');
    if (search) {
      box.setAttribute('aria-autocomplete', 'list');
      box.setAttribute('aria-controls', list.id + '_dropdown-results');
    } else box.setAttribute('aria-hidden', 'true');
    container.appendChild(box);
    const live = document.createElement('div');
    live.setAttribute('aria-live', 'polite');
    const ul = document.createElement('ul');
    ul.id = list.id + '_dropdown-results';
    ul.className = 'dropdown-results';
    ul.setAttribute('role', 'listbox');
    live.appendChild(ul);
    const bar = document.createElement('div');
    bar.className = 'dropdown-loading hide';
    live.appendChild(bar);
    container.appendChild(live);
    const arrow = document.createElement('div');
    arrow.className = 'dropdown-arrow-container';
    arrow.innerHTML = '<i class="dropdown-arrow"></i>';
    face.appendChild(arrow);

    const optionWords = (onlyLegacy) =>
      Array.from(list.options)
        .filter((o) => !onlyLegacy || o.hasAttribute('legacy'))
        .map((o) => ({ value: o.value, text: o.text }));
    const input = () => box.value.trim();

    function setText(html, isPlaceholder) {
      shown.innerHTML = isPlaceholder || !html ? `<span class="dropdown-placeholder">${placeholder}</span>` : html;
    }

    function updateSelected(word) {
      if (!word) return;
      selected = word;
      setText(escapeHtml(word.text), !word.value);
      if (ajax) {
        const option = document.createElement('option');
        if (word.value) {
          option.value = word.value;
          option.setAttribute('selected', 'selected');
        }
        option.textContent = word.text;
        list.options.length = 0;
        list.appendChild(option);
        list.selectedIndex = 0;
      } else {
        for (let i = 0; i < list.options.length; i++) if (list.options[i].value === word.value) list.selectedIndex = i;
      }
    }

    function item(word, index, selectable) {
      const li = document.createElement('li');
      li.id = `result-selectable_${list.id}_${index}`;
      li.className = 'dropdown-result ' + (selectable ? 'result-selectable' : 'result-unselectable');
      li.setAttribute('role', selectable ? 'option' : 'presentation');
      li.setAttribute('dropdown-index', String(index));
      li.setAttribute('title', word.text || placeholder);
      li.setAttribute('aria-label', word.text || placeholder);
      const q = escapeHtml(input()).replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
      const text = escapeHtml(word.text || '');
      li.innerHTML = !word.text
        ? `<span class="dropdown-placeholder">${placeholder}</span>`
        : q && index >= 0
          ? text.replace(new RegExp('(' + q + ')', 'gi'), '<b>$1</b>')
          : text;
      return li;
    }

    function drawPage() {
      const chunk = matches.slice(page * LIMIT, (page + 1) * LIMIT);
      chunk.forEach((w, i) => ul.appendChild(item(w, page * LIMIT + i, true)));
      if (!chunk.length && page === 0 && !legacy.length) ul.appendChild(item({ text: NO_RESULTS }, -1, false));
      page++;
    }

    /** The next page of rows: the <select>'s own options filtered by the search, or the server's. */
    function load() {
      if (pending || page >= pages) return pending || Promise.resolve();
      if (!ajax) {
        matches = words.filter((w) => w.text.toUpperCase().includes(input().toUpperCase()));
        pages = Math.max(1, Math.ceil(matches.length / LIMIT));
        drawPage();
        return Promise.resolve();
      }
      bar.classList.remove('hide');
      const parent = parentOf(list);
      const parentValue = parent ? (parent.options[parent.selectedIndex] || {}).value || '-999' : '';
      const asked = input();
      pending = profileoptions({ id: fieldId(list), q: asked, page, parentValue }).then((res) => {
        pending = null;
        bar.classList.add('hide');
        if (asked !== input()) return;
        words = page === 0 ? res.options : words.concat(res.options);
        matches = words;
        pages = Math.max(1, Math.ceil(res.total / LIMIT));
        drawPage();
        // A dependent list says what it waits for while it has nothing to offer.
        if (dependent && !open && !selected.value) {
          placeholder = res.total ? PLACEHOLDER : 'Please select a country';
          setText('', true);
        }
      });
      return pending;
    }

    function reset() {
      page = 0;
      pages = 1;
      focusIndex = -1;
      ul.innerHTML = '';
      legacy.forEach((w, j) => ul.appendChild(item(w, -(legacy.length - j), true)));
      return load();
    }

    function expand() {
      open = true;
      face.classList.add('focus');
      container.classList.remove('dropdown-invisible');
      for (const el of [container, face, box]) el.setAttribute('aria-expanded', 'true');
      box.select();
    }

    function collapse() {
      open = false;
      face.classList.remove('focus');
      container.classList.add('dropdown-invisible');
      for (const el of [container, face, box]) el.setAttribute('aria-expanded', 'false');
      box.blur();
      box.removeAttribute('aria-activedescendant');
    }

    const wordAt = (i) => (i < 0 ? legacy[legacy.length + i] : matches[i]);

    function pick(word) {
      if (!word) return;
      updateSelected(word);
      collapse();
      onchange(list, word);
    }

    function focusItem(li) {
      if (!li) return;
      ul.querySelectorAll('.result-focus').forEach((x) => {
        x.classList.remove('result-focus');
        x.setAttribute('aria-selected', 'false');
      });
      focusIndex = Number(li.getAttribute('dropdown-index'));
      li.classList.add('result-focus');
      li.setAttribute('aria-selected', 'true');
      box.setAttribute('aria-activedescendant', li.id);
      li.scrollIntoView({ block: 'nearest' });
    }

    document.addEventListener('mousedown', (e) => {
      if (e.target === face || face.contains(e.target)) {
        if (open) collapse();
        else expand();
        face.focus();
        if (search && open) box.focus();
        e.preventDefault();
        e.stopPropagation();
      } else if (open && !container.contains(e.target)) collapse();
    });
    ul.addEventListener('click', (e) => {
      const li = e.target.closest('li.result-selectable');
      if (li) {
        pick(wordAt(Number(li.getAttribute('dropdown-index'))));
        face.focus();
      }
      e.stopPropagation();
    });
    ul.addEventListener('scroll', () => {
      if (ul.offsetHeight + ul.scrollTop + ul.scrollHeight * 0.25 >= ul.scrollHeight) load();
    });
    box.addEventListener('keyup', () => {
      if (input() === lastInput) return;
      lastInput = input();
      clearTimeout(timer);
      if (!ajax) reset();
      else timer = setTimeout(reset, 500);
    });
    box.addEventListener('click', (e) => e.stopPropagation());
    container.addEventListener('keydown', (e) => {
      if (!open) return;
      const rows = Array.from(ul.querySelectorAll('li.result-selectable'));
      const at = rows.findIndex((li) => Number(li.getAttribute('dropdown-index')) === focusIndex);
      if (e.key === 'Escape') {
        collapse();
        face.focus();
      } else if ((e.key === 'Enter' || e.key === 'Tab') && at >= 0) {
        pick(wordAt(focusIndex));
        if (e.key === 'Enter') e.preventDefault();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        focusItem(rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))]);
        e.preventDefault();
      }
    });
    face.addEventListener('keydown', (e) => {
      if (e.target !== face) return;
      if (e.key === ' ' || e.key === 'Enter' || (e.key === 'ArrowDown' && e.altKey)) {
        expand();
        if (search) box.focus();
        e.preventDefault();
      } else if (search && /^[a-z0-9]$/i.test(e.key)) {
        expand();
        box.focus();
        box.value = '';
      }
    });

    if (ajax) legacy = optionWords(true);
    else words = optionWords(false);
    // The page was drawn with a choice: iCIMS asks the server for its text ("Loading..." meanwhile).
    const chosen = list.getAttribute('icimsdropdown-selected');
    if (ajax && chosen && texts[chosen]) {
      setText('Loading...');
      setTimeout(() => updateSelected({ value: chosen, text: texts[chosen] }), 60);
    } else {
      const o = list.options[list.selectedIndex];
      if (o && o.value) selected = { value: o.value, text: o.text };
      setText(o && o.value ? escapeHtml(o.text) : '', !(o && o.value));
    }
    list.classList.add('dropdown-hide');
    // The first page is fetched at once; a dependent list's once the page has drawn the list it depends on.
    if (dependent) setTimeout(reset, 0);
    else reset();

    const pub = {
      getSelected: () => selected,
      state: () => ({ open }),
      resetOptions: () => {
        words = [];
        return reset();
      },
      selectPlaceholder: () => {
        selected = {};
        if (ajax) {
          list.options.length = 0;
          for (const w of legacy) {
            const o = new Option(w.text, w.value);
            o.setAttribute('legacy', 'true');
            list.appendChild(o);
          }
        } else list.selectedIndex = 0;
        setText('', true);
      },
      collapseList: collapse,
    };
    dropdowns[list.id] = pub;
    return pub;
  }

  /** iCIMS's initializeAllIcimsDropdowns(): every <select icimsdropdown-enabled="1"> not made one yet. */
  function initAll() {
    document.querySelectorAll('select[icimsdropdown-enabled="1"]').forEach((select) => {
      if (select.classList.contains('dropdown-hide') || dropdowns[select.id]) return;
      dropdown(select, (list) => {
        if (typeof list.onchange === 'function') list.onchange();
        resize();
      });
    });
  }

  /** A country's dropdown changed (its select's onchange): the region beside it starts again from its list. */
  function countryChanged(select) {
    const at = select.id.indexOf('_') + 1;
    const own = select.id.slice(at) === 'PersonProfileFields.AddressCountry';
    const child =
      dropdowns[select.id.slice(0, at) + (own ? 'PersonProfileFields.AddressState' : 'WorkExperienceFields.State')];
    if (!child) return;
    child.selectPlaceholder();
    child.resetOptions();
  }

  /* ------------------------------------------------------------------ collections */

  const groupOf = (collection, n) => document.querySelector(`[data-collection="${collection}"][data-group="${n}"]`);

  /** "Add More (Education)": the next group shows and this row hides; the new one has its own "Add More" and ×. */
  function showGroup(collection, n) {
    const next = groupOf(collection, n + 1);
    if (!next) return false;
    groupOf(collection, n).querySelector('.iCIMS_AddMore').classList.add('iCIMS_NoDisplay');
    next.classList.remove('iCIMS_NoDisplay');
    resize();
    return false;
  }

  /** A group's ×: its boxes emptied, its dropdowns back on their placeholder, the group hidden. */
  function hideGroup(collection, n) {
    const el = groupOf(collection, n);
    el.querySelectorAll('input, textarea').forEach((i) => (i.value = ''));
    el.querySelectorAll('select').forEach((s) => {
      if (dropdowns[s.id]) dropdowns[s.id].selectPlaceholder();
      else s.selectedIndex = 0;
    });
    el.classList.add('iCIMS_NoDisplay');
    const before = groupOf(collection, n - 1);
    if (before) before.querySelector('.iCIMS_AddMore').classList.remove('iCIMS_NoDisplay');
    resize();
    return false;
  }

  /* ------------------------------------------------------------------ résumé and frame */

  /** The résumé box (icimsAllowResumeAutosubmit): a file sends the profile form at once, to be read. */
  function resumeUpload(input) {
    input.addEventListener('change', () => {
      if (!input.files.length) return;
      sessionStorage.setItem('icimsResume', input.files[0].name);
      sessionStorage.setItem('icimsUploads', String(Number(sessionStorage.getItem('icimsUploads') || 0) + 1));
      document.getElementById('PortalProfileFields.Resume_Loading').classList.remove('iCIMS_NoDisplay');
      input.form.action = input.form.action + '&uploadResume=1';
      input.form.submit();
    });
  }

  /** Tell the portal page how tall this one is (icims_resizeIFrameHeight). */
  function resize() {
    parent.postMessage(JSON.stringify({ height: document.body.offsetHeight + 16 }), '*');
  }

  return { dropdowns, requests, texts, idOf, initAll, countryChanged, showGroup, hideGroup, resumeUpload, resize };
})();
