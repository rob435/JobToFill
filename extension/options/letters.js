/* JobToFill settings — cover letters: the AI model, what to write about, example letters, layout. */
import { api, download, el, plural, requestAiConsent } from '../ui/common.js';
import { control, grid, group, sectionHead, table } from './controls.js';

const { store, ai, doctext, letter: L, cvtex } = globalThis.JTF;

const MAX_SAMPLE_BYTES = 5 * 1024 * 1024;

function readBytes(file) {
  return file.arrayBuffer().then((b) => new Uint8Array(b));
}

async function aiGroup() {
  const settings = await store.getSettings();
  const cfg = { ...store.DEFAULT_SETTINGS.ai, ...settings.ai };
  const keys = await store.getAiKeys();
  // The model chosen for each provider (older versions kept one, for the provider chosen then).
  cfg.models = { ...(cfg.models || {}) };
  if (cfg.models[cfg.provider] == null && cfg.model) cfg.models[cfg.provider] = cfg.model;
  const modelOf = (id) => cfg.models[id] || '';
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
    value: modelOf(cfg.provider) || '',
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
    value: keys[cfg.provider] || '',
    autocomplete: 'off',
    spellcheck: false,
  });
  const keyLink = el('a', { target: '_blank', rel: 'noopener' });
  const saved = el('small', { className: 'muted' });
  const baseField = el('label', { className: 'field wide' }, el('span', { textContent: 'API address' }), base);
  const checkbox = (name, checked, text) => {
    const box = el('input', { type: 'checkbox', name, checked });
    return [box, el('label', { className: 'check' }, box, el('span', { textContent: text }))];
  };
  const [fallback, fallbackRow] = checkbox(
    'ai-fallback',
    cfg.fallback !== false,
    'If it’s out of credit or down, use my other provider (OpenRouter or DeepSeek) when it has a key',
  );
  const [backupKeys, backupRow] = checkbox(
    'ai-backup-keys',
    cfg.backupKeys !== false,
    'Keep my API keys in the backup file, so they come back if JobToFill is reinstalled',
  );

  const showSaved = () => {
    const names = Object.keys(keys).map((id) => (ai.PROVIDERS[id] || {}).label || id);
    saved.textContent = names.length ? `Keys saved for: ${names.join(', ')}.` : '';
  };
  const loadModels = async () => {
    const p = ai.PROVIDERS[provider.value];
    const ids = await ai.models({ ...current(), apiKey: key.value.trim() }).catch(() => []);
    models.replaceChildren(
      ...(ids.length ? ids : p.models || []).slice(0, 400).map((id) => el('option', { value: id })),
    );
  };
  const current = () => ({ provider: provider.value, model: model.value.trim(), baseUrl: base.value.trim() });
  const sync = () => {
    const p = ai.PROVIDERS[provider.value];
    model.placeholder = p.model || 'model id';
    key.placeholder = p.keyHint || '';
    baseField.hidden = provider.value !== 'custom';
    keyLink.href = p.keyUrl || '#';
    keyLink.textContent = p.keyUrl ? p.keyUrl.replace(/^https:\/\//, '') : '';
    showSaved();
  };
  // What's on screen belongs to the provider shown when it was typed: note it before anything waits,
  // so a quick switch of provider can't file a key or model under the wrong one.
  const saveSettings = async () => {
    const now = current();
    cfg.models = { ...cfg.models, [now.provider]: now.model };
    await store.saveAiSettings({ ...now, fallback: fallback.checked, backupKeys: backupKeys.checked });
    status.textContent = 'Saved.';
  };
  const saveKey = async () => {
    const id = provider.value;
    const value = key.value.trim();
    if (value) keys[id] = value;
    else delete keys[id];
    showSaved();
    await store.setAiKey(value, id);
    status.textContent = 'Saved.';
  };
  // The model list is fetched when someone goes to pick a model, not every time settings open.
  let listed = null;
  model.addEventListener('focus', () => {
    if (listed === provider.value) return;
    listed = provider.value;
    loadModels();
  });
  // Each provider keeps its own key and model: switching shows the ones saved for it.
  provider.addEventListener('change', async () => {
    key.value = keys[provider.value] || '';
    model.value = modelOf(provider.value) || '';
    models.replaceChildren();
    listed = null;
    sync();
    cfg.provider = provider.value;
    await store.saveAiSettings({ provider: provider.value, baseUrl: base.value.trim() });
    status.textContent = 'Saved.';
  });
  key.addEventListener('change', saveKey);
  for (const input of [model, base, fallback, backupKeys]) input.addEventListener('change', saveSettings);
  sync();

  const test = async () => {
    const consent = requestAiConsent(); // straight from the click, as Firefox requires
    await saveSettings();
    await saveKey();
    if (!(await consent)) {
      status.textContent = 'JobToFill needs your permission to send letters’ material to the AI provider.';
      return;
    }
    status.textContent = 'Testing…';
    try {
      const config = await store.aiConfig();
      const r = await ai.test({ ...config, fallback: null });
      status.textContent = `Works: ${r.model} answered in ${(r.ms / 1000).toFixed(1)} s.`;
    } catch (err) {
      status.textContent = err.message;
    }
  };

  return group(
    'AI model',
    'Letters are written by the model you choose, with your own API key. DeepSeek V4.1 Flash through OpenRouter is fast and costs about a tenth of a cent per letter; DeepSeek’s own API (deepseek-chat) works too. Each provider keeps its own key and model. Keys are stored only in this browser and in your own backup file.',
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
        saved,
      ),
    ),
    el('div', { className: 'stack' }, fallbackRow, backupRow),
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

/** A tiny generic example, to show the shape the parser reads (not anyone's real CV). */
const EXAMPLE_CV = {
  name: 'Ada Example',
  contact: ['07700 900123', 'ada@example.com', 'github.com/ada-example'],
  sections: [
    {
      title: 'Education',
      entries: [
        {
          heading: 'University of Example',
          right: 'Leeds, England',
          subheading: 'BSc Mathematics',
          subright: 'Sep 2024 – Jun 2027',
        },
      ],
      lines: [],
    },
    {
      title: 'Projects',
      entries: [
        {
          heading: 'PriceWatch',
          tagline: 'price tracker',
          right: 'Python, SQLite',
          bullets: ['Built a tracker that checks 2,000 listings a day and alerts me to price drops.'],
        },
      ],
      lines: [],
    },
    { title: 'Skills', entries: [], lines: [{ label: 'Languages', text: 'Python, SQL' }] },
  ],
};

function cvGroup(kit, saveKit) {
  const box = el('textarea', {
    name: 'cv-tex',
    className: 'mono',
    rows: 14,
    value: kit.cvTex || '',
    spellcheck: false,
    placeholder: '\\documentclass[11pt,a4paper]{article}\n…\n\\begin{document}\n…\n\\end{document}',
  });
  const status = el('span', { className: 'muted', attrs: { 'aria-live': 'polite' } });
  const report = el('div', { className: 'stack', attrs: { 'aria-live': 'polite' } });
  const show = (cv, warnings) => {
    report.replaceChildren(
      el(
        'ul',
        {},
        cvtex.summarize(cv).map((t) => el('li', { textContent: t })),
      ),
      ...(warnings.length
        ? [
            el('p', { className: 'hint', textContent: 'Heads up:' }),
            el(
              'ul',
              {},
              warnings.map((t) => el('li', { textContent: t })),
            ),
          ]
        : []),
    );
  };
  const read = () => cvtex.parse(box.value);
  const parse = () => {
    if (!box.value.trim()) {
      report.replaceChildren();
      status.textContent = 'Paste your LaTeX first.';
      return null;
    }
    const out = read();
    show(out.cv, out.warnings);
    status.textContent = '';
    return out;
  };
  const save = async () => {
    const out = parse();
    if (!out) return;
    if (!out.cv.sections.length) {
      status.textContent = 'Nothing saved: no sections were found (each needs a \\section{…}).';
      return;
    }
    await saveKit({ cvTex: box.value, cvMaster: out.cv });
    status.textContent = `Saved. Tailoring now edits this CV (${out.cv.sections.length} sections) instead of reading your PDF.`;
  };
  const clear = async () => {
    await saveKit({ cvTex: '', cvMaster: null });
    box.value = '';
    report.replaceChildren();
    status.textContent = 'Removed. Tailoring reads your uploaded CV file again.';
  };
  const downloadTex = () => {
    const text = box.value.trim() ? box.value : kit.cvMaster ? cvtex.render(kit.cvMaster) : '';
    if (!text) {
      status.textContent = 'There is no CV to download yet.';
      return;
    }
    download(new Blob([text], { type: 'application/x-tex' }), 'cv.tex');
  };
  return group(
    'Your CV as LaTeX',
    'Paste the LaTeX of your CV. JobToFill reads its structure (name, contact line, sections, entries, bullets) and uses it as the ground truth: tailoring only rewords bullets and reorders what the AI may touch, and your names, dates, places, titles and grades are always kept exactly. The tailored CV is drawn like your template and can be downloaded as .tex to compile in Overleaf. Lines starting with % are ignored. Saved in this browser and in your backup.',
    box,
    el(
      'div',
      { className: 'row spaced' },
      el('button', { type: 'button', textContent: 'Parse', onclick: parse }),
      el('button', { type: 'button', className: 'primary', textContent: 'Save', onclick: save }),
      el('button', { type: 'button', textContent: 'Download .tex', onclick: downloadTex }),
      el('button', {
        type: 'button',
        textContent: 'Insert example',
        onclick: () => {
          box.value = cvtex.render(EXAMPLE_CV);
          parse();
        },
      }),
      kit.cvMaster
        ? el('button', { type: 'button', className: 'small danger', textContent: 'Remove', onclick: clear })
        : null,
      status,
    ),
    report,
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

async function answersGroup(kit, saveKit, settings, profile, refresh) {
  const box = el('input', { type: 'checkbox', checked: settings.aiAnswers !== false, name: 'ai-answers' });
  box.addEventListener('change', async () => {
    // Firefox asks once before anything is sent to the AI provider; straight from the click.
    if (box.checked && !(await requestAiConsent())) box.checked = false;
    await store.saveSettings({ aiAnswers: box.checked });
  });
  const entries = (await store.getAnswers()).filter((e) => e.profileId === profile.id);
  const rows = entries.slice(0, 30).map((e) =>
    el(
      'tr',
      {},
      el('td', { textContent: new Date(e.at).toLocaleDateString() }),
      el(
        'td',
        {},
        el(
          'details',
          {},
          el('summary', { textContent: [e.role, e.company].filter(Boolean).join(' · ') || e.host }),
          el(
            'dl',
            { className: 'answers-list' },
            (e.items || []).flatMap((i) => [
              el('dt', { textContent: i.question }),
              el('dd', { textContent: Array.isArray(i.value) ? i.value.join('; ') : i.value }),
            ]),
          ),
        ),
      ),
      el('td', { textContent: String((e.items || []).length) }),
      el(
        'td',
        {},
        el('button', {
          type: 'button',
          className: 'small danger',
          textContent: 'Delete',
          onclick: async () => {
            await store.removeAnswers(e.id);
            refresh();
          },
        }),
      ),
    ),
  );
  return group(
    'Answers to new questions',
    'After each fill, questions JobToFill has no saved answer for (“Why Figma?”, “Which desk interests you most?”, “Do you have practical Python experience?”) are answered by the same AI model from your CV, notes and the job’s description, then checked like letters: choices must be one of the options, and written answers keep to the word limit and use only facts from your material. Diversity questions, declarations and ID numbers are never sent. Answers are outlined in dashed orange for you to read before submitting.',
    el(
      'label',
      { className: 'check top' },
      box,
      el(
        'span',
        {},
        el('strong', { textContent: 'Answer new questions with AI when I fill a page' }),
        el('br'),
        el('small', {
          className: 'muted',
          textContent:
            'Uses your API key above. When it’s off, the popup still offers “Answer them with AI” for one page.',
        }),
      ),
    ),
    control(
      {
        path: 'kit.answerNotes',
        type: 'textarea',
        rows: 6,
        label: 'Answer guidance',
        hint: 'Facts and rules the AI may rely on for questions your CV doesn’t settle. Only what’s true for every application.',
        placeholder:
          'e.g. I have never applied to or worked for any of these firms before, and have no relatives working at them.\nI have no criminal convictions and no regulatory history.\nI don’t need any adjustments for interviews.\nI’m happy to work in the office five days a week.\nI haven’t taken the SAT, ACT or GRE.',
        wide: true,
      },
      kit.answerNotes,
      (v) => saveKit({ answerNotes: v }),
    ),
    rows.length
      ? table(['When', 'Application (click to see the answers)', 'Answers', ''], rows)
      : el('p', { className: 'empty', textContent: 'No AI answers yet.' }),
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
      'Cover letters & AI answers',
      'On any job application, “Write cover letter” in the popup finds the job description, writes a letter in your style from your CV, checks every fact, and attaches the PDF to the form. It can tailor your CV to the job too. The same model answers the questions a fill leaves empty.',
    ),
    await aiGroup(),
    cvGroup(kit, saveKit),
    aboutGroup(kit, saveKit),
    await answersGroup(kit, saveKit, settings, profile, refresh),
    samplesGroup(kit, saveKit, refresh),
    layoutGroup(kit, saveKit, profile),
    await findingGroup(settings),
    await recentGroup(refresh),
  ];
}
