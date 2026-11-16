// A stand-in for the AI provider, for the end-to-end tests and the live-form runs: an OpenAI-compatible endpoint
// (Settings › Cover letters & AI › Custom) that answers every prompt JobToFill sends the way a capable model would,
// from the candidate's material in the prompt: the job read from a posting, a cover letter, its fact checks, a
// tailored CV, the same-job check, and the answers to a form's leftover questions (choices from their options,
// written answers within their limit, and a value the form turned down written again in the format its message
// asks for). Every request is recorded by kind, so a test can say what the AI was asked.
import http from 'node:http';

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** The kind of request, by its system prompt. */
export function kindOf(system) {
  if (/answer job application form questions/.test(system)) return 'answers';
  if (/fact-checker for job application answers/.test(system)) return 'answers-audit';
  if (/extract facts from a job posting/.test(system)) return 'analyse';
  if (/write job application cover letters/.test(system)) return 'letter';
  if (/fact-checker for cover letters/.test(system)) return 'letter-audit';
  if (/compare an application page/.test(system)) return 'same-job';
  if (/hard requirements/.test(system)) return 'eligibility';
  if (/tailor a candidate’s CV/.test(system)) return 'cv';
  return 'other';
}

const field = (text, name) => (String(text).match(new RegExp(`^${name}: (.*)$`, 'm')) || [])[1] || '';
const PLACEHOLDER = /^(select|choose|please select|pick|--|—|-$|none selected|\s*$)/i;

/** The candidate the material describes: what the answers draw on. */
function candidateOf(prompt) {
  const material = (String(prompt).split('CANDIDATE MATERIAL:')[1] || '').split(/\n[A-Z][A-Z ()’'-]{6,}:\n/)[0];
  const skills = (material.match(/Skills?:\s*([^\n]+)/i) || [])[1] || 'Python, SQL';
  const email = (material.match(/[\w.+-]+@[\w-]+\.[\w.]+/) || [])[0] || 'ada@example.com';
  const phone = (material.match(/\+?\d[\d ()-]{7,}\d/) || [])[0] || '+1 415 555 0100';
  const employer = (material.match(/(?:Experience|Employment)[^\n]*?:\s*([^,\n]+)/i) || [])[1] || 'my last role';
  return { material, skills: skills.split(/,\s*/).filter(Boolean), email, phone, employer: employer.trim() };
}

/** One of a list's options for a question, the way a careful candidate would pick it. */
export function pickOption(question, options, profileValue) {
  const list = (options || []).filter((o) => !PLACEHOLDER.test(String(o)));
  if (!list.length) return null;
  const q = norm(question);
  const find = (re) => list.find((o) => re.test(norm(o)));
  if (profileValue) {
    const hit =
      list.find((o) => norm(o) === norm(profileValue)) || list.find((o) => norm(o).includes(norm(profileValue)));
    if (hit) return hit;
  }
  const yes = find(/^(yes|y|true|i do|i am|i have|i agree|i confirm|i acknowledge)\b/);
  const no = find(/^(no|n|false|i do not|i don t|i am not|i have not)\b/);
  if (/sponsor|visa|work permit/.test(q)) return no || list[list.length - 1];
  if (
    /(previously|ever) (worked|applied|been employed)|relative|family member|conflict|convict|criminal|government official/.test(
      q,
    )
  )
    return no || list[list.length - 1];
  if (
    /authori[sz]ed|right to work|eligible|legally|18|over the age|relocat|willing|able to|available|commit|consent|agree|acknowledge|confirm|understand/.test(
      q,
    )
  )
    return yes || list[0];
  if (/hear about|find out about|source|how did you/.test(q))
    return find(/job board|website|online|internet|linkedin|trackr|careers site|other/) || list[0];
  if (/country/.test(q)) return find(/^united kingdom$|^uk$|^united states$/) || list[0];
  if (/degree|qualification|education level/.test(q)) return find(/bachelor|undergraduate|bsc/) || list[0];
  if (/year|graduat/.test(q)) return find(/2027|2026/) || list[0];
  if (/office|location|city|based/.test(q)) return find(/london|new york|san francisco/) || list[0];
  if (yes && no) return yes;
  return list[0];
}

/** A value written again in the format the form's message asks for. */
function reformat(message, rejected, cand) {
  const m = norm(message);
  const digits = String(rejected || cand.phone).replace(/\D/g, '');
  if (/phone|telephone|mobile/.test(m) || (/digit|numeric|number/.test(m) && /\d{6,}/.test(digits)))
    return /only|digit|numeric|without/.test(m) ? digits.replace(/^1(?=\d{10}$)/, '') : `+${digits}`;
  if (/whole number|integer|numeric|a number|digits/.test(m)) return String(parseInt(rejected, 10) || 2);
  if (/e ?mail/.test(m)) return cand.email;
  if (/url|link|http|website|web address/.test(m)) {
    const r = String(rejected || '').trim();
    return /^https?:\/\//.test(r) ? r : `https://${r.replace(/^\/+/, '') || 'ada.dev'}`;
  }
  const date = /dd ?\/ ?mm ?\/ ?yyyy/.test(message.toLowerCase())
    ? 'DD/MM/YYYY'
    : /mm ?\/ ?dd ?\/ ?yyyy/.test(message.toLowerCase())
      ? 'MM/DD/YYYY'
      : /mm ?\/ ?yyyy/.test(message.toLowerCase())
        ? 'MM/YYYY'
        : /yyyy-mm-dd/.test(message.toLowerCase())
          ? 'YYYY-MM-DD'
          : '';
  if (date) {
    const d = new Date(Date.parse(rejected) || Date.UTC(2027, 5, 1));
    const p = (n) => String(n).padStart(2, '0');
    const [y, mo, da] = [d.getUTCFullYear(), p(d.getUTCMonth() + 1), p(d.getUTCDate())];
    return date === 'DD/MM/YYYY'
      ? `${da}/${mo}/${y}`
      : date === 'MM/DD/YYYY'
        ? `${mo}/${da}/${y}`
        : date === 'MM/YYYY'
          ? `${mo}/${y}`
          : `${y}-${mo}-${da}`;
  }
  const atLeast = /at least (\d+) characters/.exec(m);
  if (atLeast) return null; // a written answer: see essay()
  return null;
}

/** A limit as numbers: { words, chars }. */
function limitOf(limit) {
  const t = String(limit || '');
  const words = /at most (\d+)\s*words?|(?:^|–)(\d+)\s*words?/i.exec(t);
  const chars = /at most (\d+)\s*char/i.exec(t);
  return { words: words ? +(words[1] || words[2]) : 0, chars: chars ? +chars[1] : 0 };
}

function fit(text, limit) {
  const { words, chars } = limitOf(limit);
  let out = text;
  if (words) out = out.split(/\s+/).slice(0, words).join(' ');
  if (chars && out.length > chars) {
    const sentences = out.match(/[^.?]+[.?]/g) || [out];
    out = '';
    for (const x of sentences) if ((out + x).trim().length <= chars) out = (out + x).trim();
    if (!out) out = sentences[0].slice(0, chars).replace(/\s*\S*$/, '');
  }
  if (!/[.?]$/.test(out)) out = out.replace(/[,;:]?$/, '.');
  return out;
}

/** A written answer: plain sentences from the candidate's material, naming the employer. */
function essay(q, employer, cand, minChars) {
  const [a = 'Python', b = 'SQL'] = cand.skills;
  const who = employer || 'your team';
  const parts = [
    `I want to join ${who} because the work described in the posting is the kind of careful, practical work I enjoy most.`,
    `In my experience at ${cand.employer} I have used ${a} and ${b} every day to solve real problems for the people I work with.`,
    `I would bring the same care and attention to detail to this role, and I am keen to learn from the team at ${who}.`,
  ];
  let text = parts.join(' ');
  while (minChars && text.length < minChars) text += ` ${parts[1]}`;
  return fit(text, q.limit);
}

/** A short factual answer for a text box. */
function shortText(q, cand) {
  const t = norm(q.question);
  if (/linkedin/.test(t)) return 'https://www.linkedin.com/in/ada';
  if (/github/.test(t)) return 'https://github.com/ada';
  if (/website|portfolio|url/.test(t)) return 'https://ada.dev';
  if (/e ?mail/.test(t)) return cand.email;
  if (/phone|mobile/.test(t)) return cand.phone;
  if (/salary|compensation|pay/.test(t)) return 'Open to discussion';
  if (/notice/.test(t)) return '2 weeks';
  if (/city|location|where .* based|reside/.test(t)) return 'London';
  if (/university|school|college/.test(t)) return 'University of Cambridge';
  if (/language/.test(t)) return 'Python';
  if (/pronoun/.test(t)) return 'she/her';
  if (/name/.test(t)) return 'Ada Lovelace';
  if (/how many|number of|years/.test(t)) return '2';
  return 'Yes';
}

/** The answers to one batch of questions, as the model would reply. */
export function answerQuestions(prompt, { skipEssays = false, terse = false } = {}) {
  const json = (String(prompt).split('QUESTIONS:\n')[1] || '[]').trim();
  let questions;
  try {
    questions = JSON.parse(json);
  } catch {
    questions = [];
  }
  const employer = field(prompt, 'Employer');
  const cand = candidateOf(prompt);
  return questions.map((q) => {
    const fixing = q.pageError || '';
    if (q.type === 'choice' || (q.options && q.type !== 'multi')) {
      const pick = pickOption(q.question, q.options, q.profileValue);
      return pick ? { id: q.id, answer: pick, basis: 'material' } : { id: q.id, skip: true, reason: 'no option fits' };
    }
    if (q.type === 'multi') {
      const pick = pickOption(q.question, q.options, q.profileValue);
      return pick
        ? { id: q.id, answer: [pick], basis: 'material' }
        : { id: q.id, skip: true, reason: 'no option fits' };
    }
    if (q.type === 'tick') return { id: q.id, answer: 'Yes', basis: 'inferred' };
    if (fixing) {
      const fixed = reformat(fixing, q.rejected, cand);
      if (fixed) return { id: q.id, answer: fixed, basis: 'material' };
      const min = /at least (\d+) characters/i.exec(fixing);
      if (q.type === 'essay' || min)
        return { id: q.id, answer: essay(q, employer, cand, min ? +min[1] : 0), basis: 'material' };
    }
    if (q.type === 'number') return { id: q.id, answer: '2', basis: 'material' };
    if (q.type === 'date') return { id: q.id, answer: '2027-06-01', basis: 'inferred' };
    if (q.type === 'essay') {
      if (skipEssays || /anything else|additional information|note to/.test(norm(q.question)))
        return { id: q.id, skip: true, reason: 'optional' };
      const text = essay(q, employer, cand, 0);
      // A model that writes one sentence, whatever the question's limit says: the form turns it down.
      return { id: q.id, answer: terse ? text.split(/(?<=\.)\s/)[0] : text, basis: 'material' };
    }
    return { id: q.id, answer: fit(shortText(q, cand), q.limit), basis: 'material' };
  });
}

const firstLine = (text, name) => field(text, name).trim();

/** A cover letter for the job in the prompt, from the CV's own facts. */
function letterFor(prompt, job) {
  const company = job.company || firstLine(prompt, 'Company') || firstLine(prompt, 'Employer') || 'the team';
  const role = job.role || firstLine(prompt, 'Role') || firstLine(prompt, 'Title') || 'role';
  return {
    salutation: `Dear ${company} Recruitment Team,`,
    paragraphs: [
      `I am applying for the ${role} at ${company}. I am a Senior Engineer at Analytical Engines Inc, where I build tools in Python and SQL.`,
      'At Analytical Engines I built a reconciliation tool in Python that checks 40,000 trades a night, and I cut the operations team’s manual checks from 3 hours to 20 minutes. Getting the details right before they cause problems is the work I enjoy.',
      'At Babbage Labs I wrote data quality tests for the settlement pipeline in SQL and explained breaks to traders and engineers every morning, so clear communication about what went wrong is part of how I work.',
      `I would welcome the chance to join ${company}. Thank you for considering my application.`,
    ],
    closing: 'Yours sincerely,',
  };
}

const TAILORED_CV = {
  name: 'Ada Lovelace',
  contact: [],
  sections: [
    {
      title: 'Experience',
      entries: [
        {
          heading: 'Analytical Engines Inc',
          right: '2020 – present',
          subheading: 'Senior Engineer',
          bullets: ['Built a trade reconciliation tool in Python that checks 40,000 trades a night'],
        },
      ],
    },
    { title: 'Skills', lines: [{ label: 'Skills', text: 'Python, SQL, Mathematics' }] },
  ],
  changes: ['Experience: “reconciliation tool” → “trade reconciliation tool”'],
};

/**
 * Start the stand-in provider. Returns { server, url (its /v1 base), calls, count(kind), fail, gate, close() }.
 * `fail.status`: answer every request with that HTTP error. `gate.letter`: a promise that holds the letter's reply.
 * `delay`: milliseconds each reply waits (a slower model). `skipEssays`: the model declines written answers. `terse`:
 * the model's first written answer is one sentence, however long the question asks for (it writes enough once the
 * form's message says how much).
 */
export function mockAi({ delay = 0, skipEssays = false, terse = false } = {}) {
  const calls = [];
  const fail = { status: 0 };
  const gate = { letter: null };
  const job = { company: '', role: '' };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      let json;
      try {
        json = JSON.parse(body || '{}');
      } catch {
        json = {};
      }
      const messages = json.messages || [];
      const system = (messages[0] && messages[0].content) || '';
      const users = messages.filter((m) => m.role === 'user').map((m) => String(m.content || ''));
      const kind = kindOf(system);
      calls.push({ path: req.url, kind, json });
      if (req.url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'mock' }] }));
        return;
      }
      if (fail.status) {
        res.writeHead(fail.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'No auth credentials found', code: fail.status } }));
        return;
      }
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      let reply;
      const first = users[0] || '';
      if (kind === 'analyse') {
        job.company = firstLine(first, 'Company') || firstLine(first, 'Company \\(from the application page\\)');
        job.role = firstLine(first, 'Title');
        const posting = first.toLowerCase();
        reply = {
          company: job.company,
          role: job.role,
          location: firstLine(first, 'Location'),
          keywords: ['Python', 'SQL', 'data quality', 'communication'].filter((k) => posting.includes(k.toLowerCase())),
          requirements: [],
          isPosting: true,
        };
      } else if (kind === 'letter') {
        if (gate.letter) await gate.letter;
        reply = letterFor(first, job);
      } else if (kind === 'letter-audit' || kind === 'answers-audit') reply = { unsupported: [] };
      else if (kind === 'same-job') reply = { same: true, confidence: 0.9, reason: 'same title' };
      else if (kind === 'eligibility') reply = { issues: [] };
      else if (kind === 'cv') reply = TAILORED_CV;
      else if (kind === 'answers') reply = { answers: answerQuestions(first, { skipEssays, terse }) };
      else reply = { ok: true };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'mock',
          choices: [{ message: { content: JSON.stringify(reply) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.0001 },
        }),
      );
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}/v1`;
      resolve({
        server,
        url,
        calls,
        fail,
        gate,
        count: (kind) => calls.filter((c) => c.kind === kind).length,
        /** The questions the answers requests asked, parsed. */
        asked: () =>
          calls
            .filter((c) => c.kind === 'answers')
            .flatMap((c) => {
              const user = (c.json.messages || []).find((m) => m.role === 'user');
              try {
                return JSON.parse(String(user.content).split('QUESTIONS:\n')[1]);
              } catch {
                return [];
              }
            }),
        close: () => new Promise((r) => server.close(r)),
      });
    }),
  );
}
