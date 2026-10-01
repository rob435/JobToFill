/* JobToFill — profile editor and settings page. */
(function () {
  'use strict';
  const { store, vault, util, fields, geo } = globalThis.JTF;
  const $ = (sel, root) => (root || document).querySelector(sel);

  const state = { all: null, profile: null, settings: null, section: 'personal' };

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'attrs') for (const [a, av] of Object.entries(v)) node.setAttribute(a, av);
      else node[k] = v;
    }
    for (const c of children.flat()) if (c != null && c !== false) node.append(c);
    return node;
  }

  /* ------------------------------------------------------------- choices */

  const NONE = ['', '— don’t fill —'];
  const YES_NO = [NONE, ['Yes', 'Yes'], ['No', 'No']];
  const YES_NO_DECLINE = [...YES_NO, ['Decline to answer', 'Prefer not to say']];
  const CHOICES = {
    prefix: [['', '—'], ['Mr', 'Mr'], ['Ms', 'Ms'], ['Mrs', 'Mrs'], ['Miss', 'Miss'], ['Mx', 'Mx'], ['Dr', 'Dr']],
    phoneType: [['Mobile', 'Mobile'], ['Home', 'Home'], ['Work', 'Work']],
    gender: [NONE, ['Male', 'Male'], ['Female', 'Female'], ['Non-binary', 'Non-binary'], ['Decline to answer', 'Prefer not to say']],
    race: [NONE, ...['American Indian or Alaska Native', 'Asian', 'Black or African American', 'Hispanic or Latino',
      'Native Hawaiian or Other Pacific Islander', 'White', 'Two or More Races'].map((r) => [r, r]), ['Decline to answer', 'Prefer not to say']],
    veteran: [NONE, ['No', 'I am not a protected veteran'], ['Yes', 'I identify as a protected veteran'], ['Decline to answer', 'Prefer not to say']],
    disability: [NONE, ['No', 'No, I don’t have a disability'], ['Yes', 'Yes, I have a disability'], ['Decline to answer', 'Prefer not to say']],
  };
  const DEGREES = ['High School Diploma', 'Associate’s Degree', 'Bachelor’s Degree', 'Bachelor of Science', 'Bachelor of Arts',
    'Bachelor of Engineering', 'Master’s Degree', 'Master of Science', 'Master of Arts', 'MBA', 'PhD', 'JD', 'MD'];

  /* ---------------------------------------------------------- profile spec */

  const f = (path, label, extra) => Object.assign({ path, label }, extra || {});

  const PROFILE_SECTIONS = {
    personal: {
      title: 'Personal & contact',
      intro: 'The basics every form asks for. Everything stays in this browser.',
      groups: [
        { title: 'Name', fields: [
          f('personal.prefix', 'Title', { type: 'select', options: CHOICES.prefix }),
          f('personal.firstName', 'First name', { autocomplete: 'given-name' }),
          f('personal.middleName', 'Middle name', { autocomplete: 'additional-name' }),
          f('personal.lastName', 'Last name', { autocomplete: 'family-name' }),
          f('personal.preferredName', 'Preferred name', { hint: 'Used for “preferred name” boxes. Leave blank to use your first name.' }),
          f('personal.pronouns', 'Pronouns', { placeholder: 'e.g. she/her' }),
        ] },
        { title: 'Contact', fields: [
          f('contact.email', 'Email', { type: 'email', autocomplete: 'email' }),
          f('contact.phoneCountryCode', 'Phone country code', { placeholder: '+1', autocomplete: 'tel-country-code' }),
          f('contact.phone', 'Phone number', { type: 'tel', placeholder: '555 123 4567', autocomplete: 'tel-national' }),
          f('contact.phoneType', 'Phone type', { type: 'select', options: CHOICES.phoneType }),
        ] },
        { title: 'Address', fields: [
          f('address.line1', 'Street address', { wide: true, autocomplete: 'address-line1' }),
          f('address.line2', 'Apartment, suite, unit', { wide: true, autocomplete: 'address-line2' }),
          f('address.city', 'City', { autocomplete: 'address-level2' }),
          f('address.state', 'State / province / region', { autocomplete: 'address-level1', hint: 'Either “CA” or “California” works.' }),
          f('address.postalCode', 'ZIP / postal code', { autocomplete: 'postal-code' }),
          f('address.country', 'Country', { list: 'countries', autocomplete: 'country-name' }),
          f('address.organization', 'Company (shipping forms)', { hint: 'Only used for the “Company” line on checkout forms.' }),
        ] },
        { title: 'Other', fields: [
          f('personal.dob', 'Date of birth', { type: 'date' }),
          f('personal.nationality', 'Nationality / citizenship', { list: 'countries' }),
        ] },
      ],
    },
    links: {
      title: 'Links',
      intro: 'Profile links most applications ask for.',
      groups: [{ title: 'Online profiles', fields: [
        f('links.linkedin', 'LinkedIn', { type: 'url', placeholder: 'https://www.linkedin.com/in/…', wide: true }),
        f('links.github', 'GitHub', { type: 'url', placeholder: 'https://github.com/…', wide: true }),
        f('links.portfolio', 'Portfolio', { type: 'url', wide: true }),
        f('links.website', 'Personal website', { type: 'url', wide: true }),
        f('links.twitter', 'Twitter / X', { type: 'url', wide: true }),
      ] }],
    },
    work: {
      title: 'Work eligibility & preferences',
      intro: 'Standard screening questions. “— don’t fill —” leaves a question for you to answer.',
      groups: [
        { title: 'Screening questions', fields: [
          f('job.authorized', 'Legally authorized to work?', { type: 'select', options: YES_NO, hint: 'In the country you are applying in.' }),
          f('job.sponsorship', 'Need visa sponsorship (now or later)?', { type: 'select', options: YES_NO }),
          f('job.relocate', 'Willing to relocate?', { type: 'select', options: YES_NO }),
          f('job.over18', 'At least 18 years old?', { type: 'select', options: YES_NO }),
        ] },
        { title: 'Preferences', fields: [
          f('job.yearsExperience', 'Years of experience', { placeholder: 'e.g. 5' }),
          f('job.salary', 'Salary expectation', { placeholder: 'e.g. 120000', hint: 'Range dropdowns like “$100k–$150k” are matched automatically.' }),
          f('job.noticePeriod', 'Notice period', { placeholder: 'e.g. 2 weeks' }),
          f('job.startDate', 'Available from', { placeholder: 'Immediately, or 2026-11-01' }),
          f('job.referralSource', 'How did you hear about us?', { placeholder: 'e.g. LinkedIn' }),
        ] },
      ],
    },
    writing: {
      title: 'Skills & writing',
      intro: 'Longer answers for summary, skills and cover letter boxes.',
      groups: [{ title: 'Text', fields: [
        f('skills', 'Skills', { type: 'textarea', rows: 3, wide: true, placeholder: 'Python, SQL, React, project management…' }),
        f('languages', 'Languages', { wide: true, placeholder: 'English (native), Spanish (professional)' }),
        f('summary', 'Professional summary', { type: 'textarea', rows: 5, wide: true }),
        f('coverLetter', 'Cover letter', { type: 'textarea', rows: 12, wide: true, hint: 'Pasted into “Cover letter” text boxes. Upload a file under Resume & files for upload boxes.' }),
      ] }],
    },
    eeo: {
      title: 'Voluntary disclosures',
      intro: 'US employers ask these for equal-opportunity reporting. Answering is voluntary and never affects your application. Leave a question on “— don’t fill —” to answer it yourself each time.',
      groups: [{ title: 'Self-identification', fields: [
        f('eeo.gender', 'Gender', { type: 'select', options: CHOICES.gender }),
        f('eeo.race', 'Race / ethnicity', { type: 'select', options: CHOICES.race }),
        f('eeo.hispanic', 'Hispanic or Latino?', { type: 'select', options: YES_NO_DECLINE }),
        f('eeo.veteran', 'Veteran status', { type: 'select', options: CHOICES.veteran }),
        f('eeo.disability', 'Disability status', { type: 'select', options: CHOICES.disability }),
      ] }],
    },
  };

  const LISTS = {
    education: {
      title: 'Education', intro: 'Most recent first. Forms with several education sections get one entry each.',
      add: 'Add education', blank: fields.blankEducation,
      name: (e, i) => e.school || `Education ${i + 1}`,
      fields: [
        f('school', 'School / university', { wide: true }),
        f('degree', 'Degree', { list: 'degrees' }),
        f('field', 'Field of study / major'),
        f('gpa', 'GPA / grade'),
        f('location', 'Location', { placeholder: 'City, State' }),
        f('startDate', 'Start', { type: 'month' }),
        f('endDate', 'End / expected graduation', { type: 'month' }),
      ],
    },
    experience: {
      title: 'Work experience', intro: 'Most recent first. The first entry (or the one marked current) is your “current company”.',
      add: 'Add job', blank: fields.blankExperience,
      name: (e, i) => [e.title, e.company].filter(Boolean).join(' · ') || `Job ${i + 1}`,
      fields: [
        f('title', 'Job title'),
        f('company', 'Company'),
        f('location', 'Location', { placeholder: 'City, State' }),
        f('startDate', 'Start', { type: 'month' }),
        f('endDate', 'End', { type: 'month' }),
        f('current', 'I currently work here', { type: 'checkbox' }),
        f('description', 'Description', { type: 'textarea', rows: 4, wide: true }),
      ],
    },
  };

  /* ------------------------------------------------------------- saving */

  let saveTimer = null;
  function setSaveState(text, ok) {
    const s = $('#save-state');
    s.textContent = text;
    s.classList.toggle('saved', !!ok);
  }

  function scheduleSave() {
    setSaveState('Saving…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 350);
  }

  async function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    await store.saveProfile(state.profile);
    setSaveState('All changes saved', true);
  }

  document.addEventListener('visibilitychange', () => { if (saveTimer) saveNow(); });

  /* -------------------------------------------------------------- inputs */

  function control(spec, value, onChange) {
    if (spec.type === 'checkbox') {
      const box = el('input', { type: 'checkbox', checked: !!value, name: spec.path, onchange: () => onChange(box.checked) });
      return el('label', { className: 'check field' + (spec.wide ? ' wide' : '') }, box, spec.label);
    }
    let input;
    if (spec.type === 'select') {
      input = el('select', { name: spec.path }, spec.options.map(([v, l]) => el('option', { value: v, textContent: l })));
      input.value = value == null ? '' : value;
      if (input.value !== (value || '') && value) input.append(el('option', { value, textContent: value, selected: true }));
      input.addEventListener('change', () => onChange(input.value));
    } else if (spec.type === 'textarea') {
      input = el('textarea', { name: spec.path, rows: spec.rows || 4, value: value || '' });
      input.addEventListener('input', () => onChange(input.value));
    } else {
      input = el('input', { type: spec.type || 'text', name: spec.path, value: value || '' });
      if (spec.list) input.setAttribute('list', spec.list);
      input.addEventListener('input', () => onChange(input.value));
    }
    if (spec.placeholder) input.placeholder = spec.placeholder;
    input.autocomplete = spec.autocomplete || 'off';
    return el('label', { className: 'field' + (spec.wide ? ' wide' : '') },
      el('span', { textContent: spec.label }), input, spec.hint ? el('small', { textContent: spec.hint }) : null);
  }

  function sectionHead(title, intro) {
    return el('div', { className: 'section-head' }, el('h1', { textContent: title }), intro ? el('p', { textContent: intro }) : null);
  }

  function group(title, hint, ...children) {
    return el('section', { className: 'group' }, title ? el('h2', { textContent: title }) : null, hint ? el('p', { className: 'hint', textContent: hint }) : null, ...children);
  }

  /* ------------------------------------------------------------ sections */

  function renderProfileSection(key) {
    const spec = PROFILE_SECTIONS[key];
    return [sectionHead(spec.title, spec.intro), ...spec.groups.map((g) => group(g.title, g.hint,
      el('div', { className: 'grid' }, g.fields.map((fs) => control(fs, util.getPath(state.profile, fs.path), (v) => {
        util.setPath(state.profile, fs.path, v);
        scheduleSave();
      })))))];
  }

  function renderList(key) {
    const spec = LISTS[key];
    const wrap = el('div');
    const draw = () => {
      const list = state.profile[key];
      wrap.replaceChildren(...list.map((item, i) => {
        const title = el('strong', { textContent: spec.name(item, i) });
        const move = (d) => {
          const j = i + d;
          if (j < 0 || j >= list.length) return;
          [list[i], list[j]] = [list[j], list[i]];
          scheduleSave();
          draw();
        };
        return el('div', { className: 'entry' },
          el('div', { className: 'entry-head' }, title,
            el('div', { className: 'entry-tools' },
              el('button', { type: 'button', textContent: '↑', title: 'Move up', disabled: i === 0, onclick: () => move(-1) }),
              el('button', { type: 'button', textContent: '↓', title: 'Move down', disabled: i === list.length - 1, onclick: () => move(1) }),
              el('button', { type: 'button', className: 'danger', textContent: 'Remove', onclick: () => { list.splice(i, 1); scheduleSave(); draw(); } }))),
          el('div', { className: 'grid' }, spec.fields.map((fs) => control(fs, item[fs.path], (v) => {
            item[fs.path] = v;
            title.textContent = spec.name(item, i);
            scheduleSave();
          }))));
      }), el('button', { type: 'button', textContent: '+ ' + spec.add, onclick: () => { list.push(spec.blank()); scheduleSave(); draw(); } }));
    };
    draw();
    return [sectionHead(spec.title, spec.intro), group(null, null, wrap)];
  }

  function renderAnswers() {
    const wrap = el('div');
    const draw = () => {
      const list = state.profile.customAnswers;
      const rows = list.map((a, i) => el('div', { className: 'answer-row' },
        control({ path: 'question', label: 'When the question contains…', placeholder: 'how did you hear | referral' }, a.question, (v) => { a.question = v; scheduleSave(); }),
        control({ path: 'answer', label: 'Answer with', type: 'textarea', rows: 2 }, a.answer, (v) => { a.answer = v; scheduleSave(); }),
        el('button', { type: 'button', className: 'small danger', textContent: 'Remove', attrs: { style: 'margin-top: 22px' }, onclick: () => { list.splice(i, 1); scheduleSave(); draw(); } })));
      wrap.replaceChildren(
        rows.length ? el('div', {}, rows) : el('p', { className: 'empty', textContent: 'No custom answers yet. Add one below, or use “Learn from this page” in the toolbar popup after typing answers into a form.' }),
        el('button', { type: 'button', textContent: '+ Add answer', onclick: () => { list.push(fields.blankCustomAnswer()); draw(); } }));
    };
    draw();
    return [
      sectionHead('Custom answers', 'Answers for the questions that are different on every site: “Why do you want to work here?”, “Do you have a clearance?”, “Are you willing to work weekends?”.'),
      group('Your answers', 'Matching ignores case and punctuation. Separate alternatives with | . For full control write a regular expression like /^why .* (us|here)/. Custom answers win over the built-in fields. Yes/No answers also pick the right radio button or dropdown option.', wrap),
    ];
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function renderDocuments() {
    const wrap = el('div');
    const LABELS = { resume: 'Resume / CV', coverLetter: 'Cover letter' };
    const draw = async () => {
      const info = await store.docInfo(state.profile.id);
      wrap.replaceChildren(...store.DOC_TYPES.map((which) => {
        const d = info[which];
        const picker = el('input', { type: 'file', hidden: true, accept: '.pdf,.doc,.docx,.txt,.rtf,.odt,.pages', name: 'doc-' + which });
        const msg = el('small', { className: 'error' });
        picker.addEventListener('change', async () => {
          const file = picker.files[0];
          if (!file) return;
          if (file.size > 10 * 1048576) { msg.textContent = 'That file is over 10 MB. Most application forms reject files that large.'; return; }
          const dataUrl = await new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result);
            r.onerror = () => reject(r.error);
            r.readAsDataURL(file);
          });
          await store.setDoc(state.profile.id, which, { name: file.name, type: file.type, size: file.size, dataUrl });
          draw();
        });
        const ext = d ? (d.name.split('.').pop() || 'file').slice(0, 4).toUpperCase() : '—';
        return el('div', { className: 'doc-card' },
          el('div', { className: 'doc-icon', textContent: ext }),
          el('div', { className: 'doc-info' },
            el('strong', { textContent: LABELS[which] }),
            el('span', { className: 'muted', textContent: d ? `${d.name} · ${formatBytes(d.size)}` : 'No file yet' }), el('br'), msg),
          el('div', { className: 'doc-actions' },
            el('button', { type: 'button', className: d ? '' : 'primary', textContent: d ? 'Replace' : 'Upload', onclick: () => picker.click() }),
            d ? el('button', { type: 'button', className: 'danger', textContent: 'Remove', onclick: async () => { await store.removeDoc(state.profile.id, which); draw(); } }) : null),
          picker);
      }));
    };
    draw();
    return [sectionHead('Resume & files', 'Attached automatically to resume / CV and cover-letter upload buttons. Stored per profile, so a “Data analyst” profile can carry a different resume.'), group(null, null, wrap)];
  }

  /* ---------------------------------------------------------------- vault */

  function secretInput(value, onChange, name) {
    const input = el('input', { type: 'password', value: value || '', name: name || '', autocomplete: 'off', spellcheck: false });
    if (onChange) input.addEventListener('change', () => onChange(input.value));
    const show = el('button', { type: 'button', className: 'small', textContent: 'Show', onclick: () => {
      input.type = input.type === 'password' ? 'text' : 'password';
      show.textContent = input.type === 'password' ? 'Show' : 'Hide';
    } });
    const copy = el('button', { type: 'button', className: 'small', textContent: 'Copy', onclick: async () => {
      await navigator.clipboard.writeText(input.value);
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
    } });
    return { input, row: el('div', { className: 'secret' }, input, show, copy) };
  }

  function masked(number) {
    const digits = String(number || '').replace(/\D/g, '');
    return digits ? '•••• ' + digits.slice(-4) : '';
  }

  async function renderVault(container) {
    const status = await vault.status();
    const head = sectionHead('Passwords & cards', 'An encrypted vault (AES-256-GCM, key derived from your master password with PBKDF2). Secrets are only filled on HTTPS pages, only into visible fields, and only when you trigger a fill.');
    const rerender = () => renderVault(container);

    if (status === 'none') {
      const pw = el('input', { type: 'password', name: 'master', autocomplete: 'new-password' });
      const pw2 = el('input', { type: 'password', name: 'master2', autocomplete: 'new-password' });
      const err = el('p', { className: 'error' });
      const form = el('form', { className: 'stack', onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        if (pw.value !== pw2.value) { err.textContent = 'The passwords don’t match.'; return; }
        try { await vault.setup(pw.value); rerender(); } catch (ex) { err.textContent = ex.message; }
      } },
      el('div', { className: 'grid' },
        el('label', { className: 'field' }, el('span', { textContent: 'Master password' }), pw),
        el('label', { className: 'field' }, el('span', { textContent: 'Repeat master password' }), pw2)),
      err,
      el('div', { className: 'row' }, el('button', { className: 'primary', type: 'submit', textContent: 'Create vault' })));
      container.replaceChildren(head, group('Create your vault',
        'Pick something long that you don’t use anywhere else. It can’t be recovered: if you forget it you can only reset the vault and start again.', form));
      return;
    }

    if (status === 'locked') {
      const pw = el('input', { type: 'password', name: 'master', autocomplete: 'current-password' });
      const err = el('p', { className: 'error' });
      const form = el('form', { className: 'inline-form', onsubmit: async (e) => {
        e.preventDefault();
        try { await vault.unlock(pw.value); rerender(); } catch (ex) { err.textContent = ex.message; pw.select(); }
      } }, el('label', { className: 'field' }, el('span', { textContent: 'Master password' }), pw), el('button', { className: 'primary', type: 'submit', textContent: 'Unlock' }));
      container.replaceChildren(head, group('Vault locked', null, form, err,
        el('p', { className: 'muted' }, 'Forgot it? ', el('button', { type: 'button', className: 'link', textContent: 'Reset the vault', onclick: async () => {
          if (confirm('Delete every saved password and card? This cannot be undone.')) { await vault.reset(); rerender(); }
        } }), ' (deletes all saved passwords and cards).')));
      setTimeout(() => pw.focus(), 0);
      return;
    }

    const data = await vault.read();
    const settings = await store.getSettings();
    const save = async (fn) => { await vault.update(fn); rerender(); };

    // Sign-up strategy + default password.
    const strategy = el('div', { className: 'stack' },
      ...[['generate', 'Generate a unique password for every site and save it here (recommended)'],
        ['default', 'Use my default password everywhere']].map(([v, l]) => el('label', { className: 'check' },
        el('input', { type: 'radio', name: 'passwordStrategy', value: v, checked: settings.passwordStrategy === v, onchange: async () => {
          await store.saveSettings({ passwordStrategy: v });
        } }), l)));
    const def = secretInput(data.defaultPassword, (v) => save((d) => { d.defaultPassword = v; }), 'defaultPassword');
    const genDefault = el('button', { type: 'button', className: 'small', textContent: 'Generate', onclick: () => {
      def.input.value = vault.generatePassword();
      def.input.type = 'text';
      def.input.dispatchEvent(new Event('change'));
    } });
    def.row.append(genDefault);

    // Saved logins.
    const credRows = data.credentials.slice().sort((a, b) => a.host.localeCompare(b.host)).map((c) => {
      const s = secretInput(c.password, (v) => save((d) => { const x = d.credentials.find((y) => y.id === c.id); if (x) { x.password = v; x.updatedAt = Date.now(); } }));
      return el('tr', {},
        el('td', { className: 'mono', textContent: c.host }),
        el('td', { textContent: c.username || '—' }),
        el('td', {}, s.row),
        el('td', {}, el('button', { type: 'button', className: 'small danger', textContent: 'Delete', onclick: () => {
          if (confirm(`Delete the saved password for ${c.host}?`)) save((d) => { d.credentials = d.credentials.filter((y) => y.id !== c.id); });
        } })));
    });
    const newHost = el('input', { name: 'newHost', placeholder: 'careers.example.com' });
    const newUser = el('input', { name: 'newUser', placeholder: state.profile.contact.email || 'you@example.com' });
    const newPass = secretInput('', null, 'newPass');
    newPass.row.append(el('button', { type: 'button', className: 'small', textContent: 'Generate', onclick: () => { newPass.input.value = vault.generatePassword(); newPass.input.type = 'text'; } }));
    const addLogin = el('form', { className: 'inline-form', onsubmit: (e) => {
      e.preventDefault();
      const host = newHost.value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      if (!host || !newPass.input.value) return;
      save((d) => { d.credentials.push({ id: util.uid(), host, username: newUser.value.trim() || state.profile.contact.email, password: newPass.input.value, createdAt: Date.now(), updatedAt: Date.now() }); });
    } },
    el('label', { className: 'field' }, el('span', { textContent: 'Site' }), newHost),
    el('label', { className: 'field' }, el('span', { textContent: 'Username / email' }), newUser),
    el('label', { className: 'field' }, el('span', { textContent: 'Password' }), newPass.row),
    el('button', { type: 'submit', textContent: 'Add login' }));

    // Cards.
    const cardRows = data.cards.map((c) => el('tr', {},
      el('td', {}, el('input', { type: 'radio', name: 'defaultCard', checked: (data.defaultCardId || (data.cards[0] && data.cards[0].id)) === c.id, title: 'Use this card', onchange: () => save((d) => { d.defaultCardId = c.id; }) })),
      el('td', { textContent: c.label || fields.cardBrand(c.number) || 'Card' }),
      el('td', { textContent: c.name }),
      el('td', { className: 'mono', textContent: masked(c.number) }),
      el('td', { className: 'mono', textContent: `${util.pad2(c.expMonth)}/${String(c.expYear).slice(-2)}` }),
      el('td', {}, el('button', { type: 'button', className: 'small danger', textContent: 'Delete', onclick: () => {
        if (confirm('Delete this card?')) save((d) => { d.cards = d.cards.filter((y) => y.id !== c.id); if (d.defaultCardId === c.id) d.defaultCardId = null; });
      } }))));
    const card = {
      label: el('input', { name: 'cardLabel', placeholder: 'Personal Visa' }),
      name: el('input', { name: 'cardName', value: [state.profile.personal.firstName, state.profile.personal.lastName].filter(Boolean).join(' '), autocomplete: 'off' }),
      number: el('input', { name: 'cardNumber', inputMode: 'numeric', autocomplete: 'off', placeholder: '4242 4242 4242 4242' }),
      expMonth: el('input', { name: 'cardExpMonth', inputMode: 'numeric', placeholder: 'MM', maxLength: 2 }),
      expYear: el('input', { name: 'cardExpYear', inputMode: 'numeric', placeholder: 'YYYY', maxLength: 4 }),
      cvc: el('input', { name: 'cardCvc', inputMode: 'numeric', placeholder: 'Optional', maxLength: 4, autocomplete: 'off' }),
    };
    const cardErr = el('p', { className: 'error' });
    const addCard = el('form', { className: 'stack', onsubmit: (e) => {
      e.preventDefault();
      const number = card.number.value.replace(/\D/g, '');
      const month = parseInt(card.expMonth.value, 10);
      let year = parseInt(card.expYear.value, 10);
      if (year < 100) year += 2000;
      if (number.length < 12 || !(month >= 1 && month <= 12) || !(year >= 2000)) { cardErr.textContent = 'Check the card number and expiry.'; return; }
      save((d) => {
        const id = util.uid();
        d.cards.push({ id, label: card.label.value.trim(), name: card.name.value.trim(), number, expMonth: month, expYear: year, cvc: card.cvc.value.trim() });
        if (!d.defaultCardId) d.defaultCardId = id;
      });
    } },
    el('div', { className: 'grid' }, ...[['label', 'Nickname'], ['name', 'Name on card'], ['number', 'Card number'], ['expMonth', 'Expiry month'], ['expYear', 'Expiry year'], ['cvc', 'Security code']]
      .map(([k, l]) => el('label', { className: 'field' }, el('span', { textContent: l }), card[k]))),
    cardErr,
    el('div', { className: 'row' }, el('button', { type: 'submit', textContent: 'Add card' })));

    // Master password.
    const np = el('input', { type: 'password', name: 'newMaster', autocomplete: 'new-password' });
    const npMsg = el('span');
    const changePw = el('form', { className: 'inline-form', onsubmit: async (e) => {
      e.preventDefault();
      try { await vault.changePassword(np.value); np.value = ''; npMsg.className = 'success'; npMsg.textContent = 'Master password changed.'; } catch (ex) { npMsg.className = 'error'; npMsg.textContent = ex.message; }
    } }, el('label', { className: 'field' }, el('span', { textContent: 'New master password' }), np), el('button', { type: 'submit', textContent: 'Change' }), npMsg);

    container.replaceChildren(head,
      group('Sign-up forms', 'Job portals like Workday make you create an account for every employer. JobToFill fills “create password” and “confirm password” boxes for you.', strategy,
        el('label', { className: 'field', attrs: { style: 'margin-top: 14px' } }, el('span', { textContent: 'Default password' }), def.row,
          el('small', { textContent: 'Only used when “Use my default password everywhere” is chosen.' }))),
      group(`Saved logins (${data.credentials.length})`, 'Filled on login pages for the matching site. A saved “example.com” also matches “careers.example.com”.',
        credRows.length ? el('div', { className: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ['Site', 'Username', 'Password', ''].map((h) => el('th', { textContent: h })))), el('tbody', {}, credRows))) : el('p', { className: 'empty', textContent: 'No saved logins yet.' }),
        el('div', { attrs: { style: 'margin-top: 12px' } }, addLogin)),
      group(`Payment cards (${data.cards.length})`, 'The selected card fills checkout forms. Many shops put card fields in a secure frame; JobToFill fills those too when it can.',
        cardRows.length ? el('div', { className: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ['Use', 'Card', 'Name', 'Number', 'Expires', ''].map((h) => el('th', { textContent: h })))), el('tbody', {}, cardRows))) : el('p', { className: 'empty', textContent: 'No cards yet.' }),
        el('div', { attrs: { style: 'margin-top: 12px' } }, addCard)),
      group('Vault', null,
        el('div', { className: 'row' },
          el('button', { type: 'button', textContent: 'Lock now', onclick: async () => { await vault.lock(); rerender(); } }),
          el('button', { type: 'button', className: 'danger', textContent: 'Reset vault', onclick: async () => {
            if (confirm('Delete every saved password and card? This cannot be undone.')) { await vault.reset(); rerender(); }
          } })),
        el('div', { attrs: { style: 'margin-top: 14px' } }, changePw)));
  }

  /* -------------------------------------------------------------- history */

  async function renderHistory(container) {
    const history = await store.getHistory();
    const rows = history.map((h) => el('tr', {},
      el('td', { textContent: new Date(h.date).toLocaleString() }),
      el('td', {}, /^https?:\/\//.test(h.url || '') ? el('a', { href: h.url, target: '_blank', rel: 'noopener', textContent: h.title || h.url }) : (h.title || '')),
      el('td', { className: 'mono', textContent: h.host }),
      el('td', { textContent: String(h.filled) }),
      el('td', { textContent: h.profile || '' })));
    const exportCsv = () => {
      const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
      const csv = [['Date', 'Title', 'URL', 'Site', 'Fields filled', 'Profile'].join(','),
        ...history.map((h) => [new Date(h.date).toISOString(), h.title, h.url, h.host, h.filled, h.profile].map(esc).join(','))].join('\n');
      download(new Blob([csv], { type: 'text/csv' }), 'jobtofill-applications.csv');
    };
    container.replaceChildren(
      sectionHead('Application log', 'Every job application page you filled, so you can keep track of where you applied. Stored only in this browser.'),
      group(`${history.length} application${history.length === 1 ? '' : 's'}`, null,
        rows.length ? el('div', { className: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ['When', 'Page', 'Site', 'Fields', 'Profile'].map((h) => el('th', { textContent: h })))), el('tbody', {}, rows)))
          : el('p', { className: 'empty', textContent: 'Nothing yet. Fill a job application and it will show up here.' }),
        el('div', { className: 'row', attrs: { style: 'margin-top: 12px' } },
          el('button', { type: 'button', textContent: 'Export CSV', disabled: !rows.length, onclick: exportCsv }),
          el('button', { type: 'button', className: 'danger', textContent: 'Clear log', disabled: !rows.length, onclick: async () => {
            if (confirm('Clear the application log?')) { await store.clearHistory(); renderHistory(container); }
          } }))));
  }

  /* ------------------------------------------------------------- settings */

  async function renderSettings(container) {
    const settings = await store.getSettings();
    const toggle = (key, label, hint) => el('label', { className: 'check', attrs: { style: 'align-items: flex-start' } },
      el('input', { type: 'checkbox', name: key, checked: !!settings[key], attrs: { style: 'margin-top: 3px' }, onchange: (e) => store.saveSettings({ [key]: e.target.checked }) }),
      el('span', {}, el('strong', { textContent: label }), el('br'), el('span', { className: 'muted', textContent: hint })));
    const lock = el('select', { name: 'autoLockMinutes', onchange: (e) => store.saveSettings({ autoLockMinutes: +e.target.value }) },
      [[5, '5 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 hour'], [240, '4 hours'], [0, 'Only when the browser closes']]
        .map(([v, l]) => el('option', { value: String(v), textContent: l, selected: settings.autoLockMinutes === v })));
    let shortcut = 'Alt+Shift+F';
    try {
      const cmd = (await chrome.commands.getAll()).find((c) => c.name === 'fill-page');
      shortcut = (cmd && cmd.shortcut) || 'not set';
    } catch (err) { /* ignore */ }
    container.replaceChildren(
      sectionHead('Settings'),
      group('Filling', null, el('div', { className: 'stack' },
        toggle('overwrite', 'Overwrite fields that already have a value', 'Off: only empty fields are filled, so nothing you typed gets replaced.'),
        toggle('highlight', 'Highlight filled fields', 'Outlines each field JobToFill filled until you click into it.'),
        toggle('toast', 'Show a summary on the page', 'After filling with the keyboard shortcut or right-click menu.'),
        toggle('comboboxes', 'Operate custom dropdowns', 'Opens searchable dropdowns (Workday, Greenhouse, react-select…) and picks the matching option.'),
        toggle('logApplications', 'Keep an application log', 'Remember each job application page you filled.'))),
      group('Vault', null, el('label', { className: 'field', attrs: { style: 'max-width: 280px' } }, el('span', { textContent: 'Lock the vault after inactivity' }), lock)),
      group('Keyboard shortcut', null, el('p', {}, 'Fill the current page: ', el('kbd', { textContent: shortcut }), ' — ',
        el('button', { type: 'button', className: 'link', textContent: 'change shortcut', onclick: () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }) })),
      el('p', { className: 'muted' }, 'You can also right-click any page or field: “Fill this page”, “Insert from profile” and “Generate strong password”.')));
  }

  /* --------------------------------------------------------------- backup */

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function renderBackup(container) {
    const opts = { documents: true, vault: true, history: true };
    const check = (key, label) => el('label', { className: 'check' }, el('input', { type: 'checkbox', checked: true, onchange: (e) => { opts[key] = e.target.checked; } }), label);
    const msg = el('p');
    const picker = el('input', { type: 'file', accept: 'application/json,.json', hidden: true, name: 'import' });
    picker.addEventListener('change', async () => {
      const file = picker.files[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (!confirm('Replace your current profiles and settings with this backup?')) return;
        await store.importData(data);
        msg.className = 'success';
        msg.textContent = 'Backup restored.';
        await load();
      } catch (err) {
        msg.className = 'error';
        msg.textContent = err.message;
      }
    });
    container.replaceChildren(
      sectionHead('Backup & restore', 'Move your profiles to another browser or keep a copy. Backups are plain JSON; the vault inside stays encrypted with your master password.'),
      group('Export', null, el('div', { className: 'stack' },
        check('documents', 'Include resume and cover-letter files'),
        check('vault', 'Include the encrypted vault'),
        check('history', 'Include the application log'),
        el('div', { className: 'row' }, el('button', { type: 'button', className: 'primary', textContent: 'Download backup', onclick: async () => {
          await saveNow();
          const data = await store.exportData(opts);
          download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `jobtofill-backup-${new Date().toISOString().slice(0, 10)}.json`);
        } })))),
      group('Restore', 'Replaces all profiles and settings in this browser.', el('button', { type: 'button', textContent: 'Choose backup file…', onclick: () => picker.click() }), picker, msg));
  }

  /* ------------------------------------------------------------- routing */

  const RENDERERS = {
    personal: () => renderProfileSection('personal'),
    links: () => renderProfileSection('links'),
    work: () => renderProfileSection('work'),
    education: () => renderList('education'),
    experience: () => renderList('experience'),
    writing: () => renderProfileSection('writing'),
    documents: renderDocuments,
    answers: renderAnswers,
    eeo: () => renderProfileSection('eeo'),
    vault: (c) => renderVault(c),
    history: (c) => renderHistory(c),
    settings: (c) => renderSettings(c),
    backup: (c) => renderBackup(c),
  };

  async function show(section) {
    if (!RENDERERS[section]) section = 'personal';
    state.section = section;
    for (const a of document.querySelectorAll('#nav a')) {
      if (a.getAttribute('href') === '#' + section) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    const container = $('#sections');
    container.dataset.section = section;
    const out = RENDERERS[section](container);
    if (Array.isArray(out)) container.replaceChildren(...out);
    else await out;
    window.scrollTo(0, 0);
  }

  async function renderProfiles() {
    const select = $('#profile-select');
    select.replaceChildren(...state.all.order.map((id) => el('option', { value: id, textContent: state.all.profiles[id].name, selected: id === state.profile.id })));
    $('#profile-delete').disabled = state.all.order.length < 2;
  }

  async function load() {
    state.all = await store.loadAll();
    state.settings = state.all.settings;
    state.profile = state.all.profiles[state.settings.activeProfileId];
    await renderProfiles();
    await show(location.hash.slice(1) || 'personal');
  }

  async function init() {
    $('#countries').append(...geo.COUNTRIES.map((c) => el('option', { value: c[2] })));
    document.body.append(el('datalist', { id: 'degrees' }, DEGREES.map((d) => el('option', { value: d }))));

    window.addEventListener('hashchange', () => show(location.hash.slice(1)));
    $('#profile-select').addEventListener('change', async (e) => {
      if (saveTimer) await saveNow();
      await store.setActive(e.target.value);
      await load();
    });
    $('#profile-new').addEventListener('click', async () => {
      const name = prompt('Name for the new profile (e.g. “Software engineer”, “Personal shopping”)');
      if (!name) return;
      if (saveTimer) await saveNow();
      const p = await store.createProfile(name.trim());
      await store.setActive(p.id);
      await load();
    });
    $('#profile-dup').addEventListener('click', async () => {
      const name = prompt('Name for the copy', state.profile.name + ' (copy)');
      if (!name) return;
      await saveNow();
      const p = await store.createProfile(name.trim(), state.profile);
      await store.setActive(p.id);
      await load();
    });
    $('#profile-rename').addEventListener('click', async () => {
      const name = prompt('Rename profile', state.profile.name);
      if (!name) return;
      state.profile.name = name.trim();
      await saveNow();
      await load();
    });
    $('#profile-delete').addEventListener('click', async () => {
      if (!confirm(`Delete the profile “${state.profile.name}” and its files?`)) return;
      clearTimeout(saveTimer);
      saveTimer = null;
      await store.deleteProfile(state.profile.id);
      await load();
    });

    // Another tab (or the popup's "learn" feature) changed the profile: reload unless we're mid-edit.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || saveTimer) return;
      if (changes.profiles || changes.profileOrder) {
        const next = changes.profiles && changes.profiles.newValue && changes.profiles.newValue[state.profile.id];
        if (next && JSON.stringify(next) === JSON.stringify(state.profile)) return;
        const active = document.activeElement;
        if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return;
        load();
      }
    });

    await load();
  }

  init();
})();
