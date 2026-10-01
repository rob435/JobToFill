/* JobToFill settings — cover letters: the AI model, what to write about, example letters, layout. */
import { api, download, el, plural, requestAiConsent } from '../ui/common.js';
import { control, grid, group, sectionHead, table } from './controls.js';

const { store, ai, doctext, letter: L } = globalThis.JTF;

const MAX_SAMPLE_BYTES = 5 * 1024 * 1024;

function readBytes(file) {
  return file.arrayBuffer().then((b) => new Uint8Array(b));
}

async function aiGroup() {
  const settings = await store.getSettings();
  const config = await store.aiConfig();
  const cfg = { ...ai.DEFAULT_CONFIG, ...settings.ai };
  const status = el('span', { className: 'muted', attrs: { 'aria-live': 'polite' } });

  const provider = el(
    'select',
    { name: 'ai-provider' },
    Object.entries(ai.PROVIDERS).map(([id, p]) => el('option', { value: id, textContent: p.label })),
  );
  provider.value = cfg.provider;
  const model = el('input', {
    type: 'text',
    name: 'ai-model',
    value: cfg.model || '',
    autocomplete: 'off',
    spellcheck: false,
  });
  model.setAttribute('list', 'ai-models');
  const models = el('datalist', { id: 'ai-models' });
  const base = el('input', {
    type: 'url',
    name: 'ai-base',
    value: cfg.baseUrl || '',
    autocomplete: 'off',
    spellcheck: false,
  });
  const key = el('input', {
    type: 'password',
    name: 'ai-key',
    value: config.apiKey || '',
    autocomplete: 'off',
    spellcheck: false,
  });
  const keyLink = el('a', { target: '_blank', rel: 'noopener' });
  const baseField = el('label', { className: 'field wide' }, el('span', { textContent: 'API address' }), base);

  const loadModels = async () => {
    try {
      const ids = await ai.models({ ...cfg, ...current(), apiKey: key.value.trim() });
      models.replaceChildren(...ids.slice(0, 400).map((id) => el('option', { value: id })));
    } catch (err) {
      models.replaceChildren();
    }
  };
  const current = () => ({ provider: provider.value, model: model.value.trim(), baseUrl: base.value.trim() });
  const sync = () => {
    const p = ai.PROVIDERS[provider.value];
    model.placeholder = p.model || 'model id';
    key.placeholder = p.keyHint || '';
    baseField.hidden = provider.value !== 'custom';
    keyLink.href = p.keyUrl || '#';
    keyLink.textContent = p.keyUrl ? p.keyUrl.replace(/^https:\/\//, '') : '';
  };
  const save = async () => {
    await store.saveSettings({ ai: current() });
    await store.setAiKey(key.value);
    status.textContent = 'Saved.';
  };
  // The model list is fetched when someone goes to pick a model, not every time settings open.
  let listed = null;
  model.addEventListener('focus', () => {
    if (listed === provider.value) return;
    listed = provider.value;
    loadModels();
  });
  provider.addEventListener('change', () => {
    sync();
    save();
  });
  for (const input of [model, base, key]) input.addEventListener('change', save);
  sync();

  const test = async () => {
    const consent = requestAiConsent(); // straight from the click, as Firefox requires
    await save();
    if (!(await consent)) {
      status.textContent = 'JobToFill needs your permission to send letters’ material to the AI provider.';
      return;
    }
    status.textContent = 'Testing…';
    try {
      const r = await ai.test(await store.aiConfig());
      status.textContent = `Works: ${r.model} answered in ${(r.ms / 1000).toFixed(1)} s.`;
    } catch (err) {
      status.textContent = err.message;
    }
  };

  return group(
    'AI model',
    'Letters are written by the model you choose, with your own API key. DeepSeek V4.1 Flash through OpenRouter is fast and costs about a tenth of a cent per letter. The key is stored only in this browser and is left out of backups and exports.',
    grid(
      el('label', { className: 'field' }, el('span', { textContent: 'Provider' }), provider),
      el('label', { className: 'field' }, el('span', { textContent: 'Model' }), model, models),
      baseField,
      el(
        'label',
        { className: 'field wide' },
        el('span', { textContent: 'API key' }),
        key,
        el('small', {}, 'Get one at ', keyLink),
      ),
    ),
    el(
      'div',
      { className: 'row spaced' },
      el('button', { type: 'button', textContent: 'Test connection', onclick: test }),
      status,
    ),
  );
}

function aboutGroup(kit, saveKit) {
  return group(
    'What to write about',
    'Facts the AI may use besides your CV and profile: projects, results with numbers, awards, why you want this kind of role. It never adds facts that aren’t here, in your CV or in your example letters.',
    control(
      {
        path: 'kit.notes',
        type: 'textarea',
        rows: 8,
        label: 'Notes about you',
        placeholder:
          'e.g. Built a price tracker that checks 2,000 listings a day, with 120 automated tests.\nRan the university investment society’s research team (12 people).\nWhy operations: I like finding and fixing what breaks.',
        wide: true,
      },
      kit.notes,
      (v) => saveKit({ notes: v }),
    ),
  );
}

function samplesGroup(kit, saveKit, refresh) {
  const message = el('small', { className: 'error' });
  const picker = el('input', { type: 'file', hidden: true, multiple: true, accept: '.pdf,.docx,.odt,.txt,.md' });
  picker.addEventListener('change', async () => {
    message.textContent = '';
    const samples = [...kit.samples];
    for (const file of picker.files) {
      if (file.size > MAX_SAMPLE_BYTES) {
        message.textContent = `${file.name} is over 5 MB.`;
        continue;
      }
      try {
        const out = await doctext.extract(await readBytes(file), { type: file.type, name: file.name });
        if (L.words(out.text) < 80) throw new Error('there is hardly any text in it');
        samples.push({ id: globalThis.JTF.util.uid(), name: file.name, text: out.text, addedAt: Date.now() });
      } catch (err) {
        message.textContent = `Couldn’t read ${file.name}: ${err.message}`;
      }
    }
    picker.value = '';
    await saveKit({ samples: samples.slice(-5) });
    refresh();
  });
  const paste = el('textarea', { rows: 6, placeholder: 'Or paste a letter you wrote here', name: 'sample-paste' });
  const addPasted = async () => {
    const text = paste.value.trim();
    if (L.words(text) < 80) {
      message.textContent = 'Paste a whole letter (at least a few paragraphs).';
      return;
    }
    await saveKit({
      samples: [
        ...kit.samples,
        { id: globalThis.JTF.util.uid(), name: 'Pasted letter', text, addedAt: Date.now() },
      ].slice(-5),
    });
    refresh();
  };
  const rows = kit.samples.map((s) =>
    el(
      'tr',
      {},
      el('td', { textContent: s.name }),
      el('td', { textContent: `${L.words(s.text)} words` }),
      el('td', { textContent: L.sampleCompanies([s]).join(', ') || '—' }),
      el(
        'td',
        {},
        el('button', {
          type: 'button',
          className: 'small danger',
          textContent: 'Remove',
          onclick: async () => {
            await saveKit({ samples: kit.samples.filter((x) => x.id !== s.id) });
            refresh();
          },
        }),
      ),
    ),
  );
  return group(
    'Your example letters',
    'Letters you wrote before. New letters copy their voice, structure and length, and may reuse what they say about you; the companies they were written for are checked so they never leak into a new letter. Up to 5.',
    rows.length
      ? table(['File', 'Length', 'Written for', ''], rows)
      : el('p', { className: 'empty', textContent: 'None yet.' }),
    el(
      'div',
      { className: 'row spaced' },
      el('button', {
        type: 'button',
        className: 'primary',
        textContent: 'Add letters (PDF, Word, text)…',
        onclick: () => picker.click(),
      }),
      picker,
    ),
    paste,
    el(
      'div',
      { className: 'row' },
      el('button', { type: 'button', textContent: 'Add pasted letter', onclick: addPasted }),
      message,
    ),
  );
}

function layoutGroup(kit, saveKit, profile) {
  const auto = L.contactLine(profile, {}).join(' | ');
  return group(
    'Letter layout',
    'The PDF matches a classic LaTeX letter: your name, a contact line, the date, then justified paragraphs on one page.',
    grid(
      control(
        {
          path: 'kit.contact',
          label: 'Contact line',
          placeholder: auto || 'phone | email | github.com/you',
          hint: 'Separate items with |. Leave empty to use your profile.',
          wide: true,
        },
        kit.contact,
        (v) => saveKit({ contact: v }),
      ),
      control({ path: 'kit.closing', label: 'Sign-off', placeholder: 'Yours sincerely,' }, kit.closing, (v) =>
        saveKit({ closing: v }),
      ),
      control(
        {
          path: 'kit.spelling',
          type: 'select',
          label: 'Spelling',
          options: [
            ['auto', 'From the job’s country'],
            ['en-GB', 'British English'],
            ['en-US', 'American English'],
          ],
        },
        kit.spelling,
        (v) => saveKit({ spelling: v }),
      ),
      control(
        {
          path: 'kit.paper',
          type: 'select',
          label: 'Paper',
          options: [
            ['a4', 'A4'],
            ['letter', 'US Letter'],
          ],
        },
        kit.paper,
        (v) => saveKit({ paper: v }),
      ),
    ),
  );
}

async function findingGroup(settings) {
  const granted = await api.permissions.contains({ permissions: ['history'] }).catch(() => false);
  const box = el('input', { type: 'checkbox', checked: !!settings.searchHistory && granted, name: 'search-history' });
  box.addEventListener('change', async () => {
    if (box.checked) {
      // Requested straight from the click, as browsers require.
      const ok = await api.permissions.request({ permissions: ['history'] }).catch(() => false);
      box.checked = ok;
      await store.saveSettings({ searchHistory: ok });
    } else {
      await store.saveSettings({ searchHistory: false });
      await api.permissions.remove({ permissions: ['history'] }).catch(() => {});
    }
  });
  return group(
    'Finding the job description',
    'Application forms often don’t include the job description. JobToFill looks for it on the page, through the job site’s public listings, and on pages linked from the form, then checks it is the same job (same job ID, company and title) before writing anything.',
    el(
      'label',
      { className: 'check top' },
      box,
      el(
        'span',
        {},
        el('strong', { textContent: 'Also look in my browsing history' }),
        el('br'),
        el('small', {
          className: 'muted',
          textContent:
            'Finds the job page you read before clicking Apply. History is searched in this browser only; just the matching job pages are opened.',
        }),
      ),
    ),
  );
}

async function recentGroup(refresh) {
  const letters = await store.getLetters();
  const rows = letters.map((l) =>
    el(
      'tr',
      {},
      el('td', { textContent: new Date(l.createdAt).toLocaleString() }),
      el('td', {
        textContent: [l.posting && l.posting.title, l.posting && l.posting.company].filter(Boolean).join(' · '),
      }),
      el('td', { textContent: l.attachedAt ? 'Used' : '' }),
      el(
        'td',
        { className: 'row' },
        l.pdf
          ? el('button', {
              type: 'button',
              className: 'small',
              textContent: 'PDF',
              onclick: async () => download(await (await fetch(l.pdf.dataUrl)).blob(), l.pdf.name),
            })
          : null,
        el('button', {
          type: 'button',
          className: 'small danger',
          textContent: 'Delete',
          onclick: async () => {
            await store.removeLetter(l.id);
            refresh();
          },
        }),
      ),
    ),
  );
  return group(
    plural(letters.length, 'recent letter'),
    'The last 25 letters you generated. A letter you chose with “Use for this application” is attached automatically while you fill that application.',
    rows.length
      ? table(['When', 'Job', '', ''], rows)
      : el('p', {
          className: 'empty',
          textContent: 'None yet. On a job application, open the JobToFill popup and click “Write cover letter”.',
        }),
  );
}

export async function renderLetters({ state, refresh }) {
  const profile = state.profile;
  let kit = await store.getKit(profile.id);
  const saveKit = async (patch) => {
    kit = await store.saveKit(profile.id, patch);
    return kit;
  };
  const settings = await store.getSettings();
  return [
    sectionHead(
      'Cover letters',
      'On any job application, “Write cover letter” in the popup finds the job description, writes a letter in your style from your CV, checks every fact, and attaches the PDF to the form. It can tailor your CV to the job too.',
    ),
    await aiGroup(),
    aboutGroup(kit, saveKit),
    samplesGroup(kit, saveKit, refresh),
    layoutGroup(kit, saveKit, profile),
    await findingGroup(settings),
    await recentGroup(refresh),
  ];
}
