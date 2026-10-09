// Scripted models, for checking the harness without a provider (run.mjs --provider fake --model oracle|null, and
// the unit tests). "oracle" reads the labels: it answers what should be answered (with the label's acceptable
// option, or a plain sentence from the candidate's material), skips the rest and writes a letter that passes
// every check, so its run should score full coverage and no violations. "null" skips everything and writes an
// empty letter, so its run should score nothing. A harness that grades either one wrongly is broken.

// The prompt shows questions tidied (util.cleanLabel: no trailing colon, say): compare words only.
const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const field = (text, name) => (String(text).match(new RegExp(`^${name}: (.*)$`, 'm')) || [])[1] || '';

// One sentence of the candidate's own facts: no numbers, no tool the material lacks.
const sentence = (employer) =>
  `At Finch & Partners I built an Excel model for a sector note and cleaned store-level sales data in Python, and I want to bring the same care to the work at ${employer}.`;

function letter(company, role, location) {
  return {
    salutation: `Dear ${company} Recruitment Team,`,
    paragraphs: [
      `I am applying for the ${role}${location ? ` in ${location}` : ''}. I am a final-year Economics student at University College London, graduating in June 2027.`,
      'Most of my work so far has been about making numbers trustworthy. As a summer analyst intern at Finch & Partners I built an Excel model of the margins of 40 listed UK retailers that the team used in its sector note. Before the model could say anything, I cleaned three years of store-level sales data in Python with pandas and wrote the summary charts. Getting it right meant checking every input against its source and writing down each assumption so that the analysts could follow the model and question it.',
      'Outside the internship I test ideas with code. I wrote a pairs trading backtest in Python on FTSE 100 stocks, and the most useful part was the write-up explaining why the strategy stopped working once trading costs were included. As treasurer of the UCL Economics & Finance Society I run the annual budget and lead our sponsorship talks with four firms, and I organised a trading game for 120 students built around a market-making simulation.',
      `I want to do this kind of careful, testable work at ${company}. My modules in econometrics, statistics and corporate finance have given me the methods, and the internship showed me how much depends on the data underneath them. I would bring that habit of checking the inputs to every model I build, along with the patience to explain a result plainly to the people who have to act on it.`,
      `I would welcome the chance to join ${company} and learn from its team. Thank you for considering my application.`,
    ],
    closing: 'Yours sincerely,',
    keywords: [],
  };
}

/** A fake `chat(messages, options) → { text, json, usage, model }` in `mode` (oracle | null) over the answer forms. */
export function fakeChat(mode, { forms = [] } = {}) {
  if (!['oracle', 'null'].includes(mode)) throw new Error(`The fake model is "oracle" or "null", not "${mode}".`);
  // The prompt shows each question's text, and the question before it: with the employer, they find the label.
  const labels = new Map();
  const key = (company, question, before) =>
    [norm(company), norm(question).slice(0, 300), norm(before).slice(0, 120)].join('|');
  for (const f of forms)
    for (const it of f.items) {
      const k = key(f.company, it.question, it.follows && it.follows.question);
      if (!labels.has(k)) labels.set(k, it.label);
      if (!labels.has(key(f.company, it.question, ''))) labels.set(key(f.company, it.question, ''), it.label);
    }

  function answer(q, employer, questions) {
    const before = q.follows && (q.follows.question || (questions.find((x) => x.id === q.follows.id) || {}).question);
    const label = labels.get(key(employer, q.question, before)) || labels.get(key(employer, q.question, ''));
    if (mode === 'null' || !label || label.expect !== 'answer')
      return { id: q.id, skip: true, reason: 'not in the material' };
    const ok = label.acceptable && label.acceptable.length ? label.acceptable : q.options || [];
    if (q.type === 'choice') return { id: q.id, answer: ok[0], basis: 'material' };
    if (q.type === 'multi') return { id: q.id, answer: ok.slice(0, 1), basis: 'material' };
    if (q.type === 'tick') return { id: q.id, answer: 'Yes', basis: 'material' };
    if (q.type === 'essay') return { id: q.id, answer: sentence(employer), basis: 'material' };
    if (q.type === 'text') return { id: q.id, answer: 'Yes', basis: 'material' };
    return { id: q.id, skip: true, reason: 'no number or date in the material' };
  }

  return async (messages) => {
    const system = String(messages[0].content);
    const last = String(messages[messages.length - 1].content);
    let json;
    if (/strict fact-checker/.test(system)) json = { unsupported: [] };
    else if (/^Some answers need fixing/.test(last)) json = { answers: [] };
    else if (/^You answer job application form questions/.test(system)) {
      const questions = JSON.parse(last.slice(last.indexOf('QUESTIONS:') + 10));
      json = { answers: questions.map((q) => answer(q, field(last, 'Employer'), questions)) };
    } else if (/^You extract facts from a job posting/.test(system))
      json = {
        isPosting: true,
        company: field(last, 'Company'),
        // The role as a sentence names it: no codes or dashes.
        role: field(last, 'Title').replace(/\s*[|–—]\s*|\s+-\s+/g, ', '),
        location: field(last, 'Location'),
      };
    else if (/^You write job application cover letters/.test(system)) {
      // The first request has the job; a revision adds the fixes after it.
      const first = String(messages[1].content);
      const job = JSON.parse(
        first.slice(first.indexOf('{', first.indexOf('JOB (facts')), first.indexOf('\n\nJOB POSTING:')),
      );
      json = mode === 'null' ? { paragraphs: [] } : letter(job.company, job.role, job.location);
    } else throw new Error('The fake model got a prompt it doesn’t know.');
    const text = JSON.stringify(json);
    const prompt = messages.reduce((n, m) => n + String(m.content).length, 0);
    return {
      text,
      json,
      usage: { prompt_tokens: Math.ceil(prompt / 4), completion_tokens: Math.ceil(text.length / 4) },
      model: `fake-${mode}`,
    };
  };
}
