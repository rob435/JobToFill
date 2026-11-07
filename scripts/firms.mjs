/*
 * JobToFill — builds extension/data/firms.json, the bundled registry of reputable but
 * low-profile finance and tech firms behind "Discover internships".
 *
 * Sources (facts only, no article prose):
 *   - SEC Form ADV bulk CSV (monthly zip of every SEC-registered adviser): name, main office,
 *     website, employees (5A), regulatory AUM (5F(2)(c)), private funds (7B(1)) and fund types.
 *   - Wikipedia category members (MediaWiki API: finance firms, and software, AI, fintech, deep-tech,
 *     security and games companies) plus Wikidata (website P856, dissolved P576, headquarters P159,
 *     country P17, employees P1128, inception P571) and the infobox website line.
 *   - Y Combinator's company directory (yc-oss.github.io's JSON copy): active or public companies
 *     with a website and 15 to 5,000 staff, with their batch, one-liner, team size and offices.
 * Affiliated advisers of one group (same website domain, or same normalised name) collapse into a
 * single entry, as does a company known to more than one source. Downloads are cached under
 * .cache/firms/ (Wikipedia, Wikidata and YC answers for a week); pass --refresh to fetch everything
 * again. The output only changes when the data does.
 *
 * SEC asks automated clients for a User-Agent with a contact e-mail: set FIRMS_CONTACT, or the
 * script uses `git config user.email`. With --no-sec (or when the SEC file can't be downloaded)
 * the Form ADV firms are kept from the previous firms.json as they are, and only the Wikipedia and
 * YC parts are rebuilt and merged in. Behind an HTTPS proxy on Node 22+, run with
 * NODE_USE_ENV_PROXY=1; if fetch() still fails, the script retries the download with curl.
 * Usage: npm run firms [-- --refresh] [-- --no-sec]
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = path.join(root, '.cache', 'firms');
const outFile = path.join(root, 'extension', 'data', 'firms.json');
const refresh = process.argv.includes('--refresh');
const noSec = process.argv.includes('--no-sec');
const WEEK = 7 * 24 * 3600 * 1000;

// Inclusion thresholds for firms known only from Form ADV (Wikipedia firms are always kept).
const MIN_AUM = 500e6;
const MIN_EMPLOYEES = 10;
// Y Combinator companies big enough to run an internship, small enough to be overlooked.
const YC_MIN_TEAM = 15;
const YC_MAX_TEAM = 5000;

const SEC_INDEX =
  'https://www.sec.gov/data-research/sec-markets-data/information-about-registered-investment-advisers-exempt-reporting-advisers';
const SEC_FILES =
  'https://www.sec.gov/files/investment/data/other/information-about-registered-investment-advisers-exempt-reporting-advisers/';
const SEC_FALLBACK = 'ia100226.zip';
const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const YC_API = 'https://yc-oss.github.io/api/companies/all.json';
const PROJECT = 'JobToFill firms builder (github.com/rob435/JobToFill)';

// [category, expand one level of subcategories]. Subcategories are kept only if they match SUBCAT_OK.
const FINANCE_CATEGORIES = [
  ['Hedge fund firms in the United Kingdom', false],
  ['Hedge fund firms in New York City', true],
  ['Hedge fund firms of the United States', true],
  ['Hedge fund firms in Hong Kong', false],
  ['Hedge fund firms in Asia-Pacific', true],
  ['Tiger Cub firms', false],
  ['Investment banks in the United Kingdom', false],
  ['Investment banks in the United States', true],
  ['Investment management companies of the United Kingdom', false],
  ['Private equity firms of the United Kingdom', false],
  ['Alternative investment management companies', false],
  ['Financial derivative trading companies', false],
  ['Family offices', false],
  ['Financial services companies based in the City of London', false],
];
// Tech companies that hire interns. There is no "Financial technology companies of the United Kingdom",
// "Quantum computing companies", "Companies in the Silicon Fen" or "Technology companies of Scotland":
// the categories below are the nearest that exist.
const TECH_CATEGORIES = [
  ['Software companies of the United Kingdom', true], // of England, of Scotland, of Wales
  ['Software companies based in London', false],
  ['Software companies based in Cambridge', false], // the Silicon Fen
  ['Technology companies based in London', false],
  ['Technology companies based in Cambridge', false], // Arm
  ['Technology companies of the United Kingdom', false],
  ['Information technology companies of the United Kingdom', false],
  ['Artificial intelligence industry in the United Kingdom', false], // Google DeepMind
  ['Software companies of Ireland', false],
  ['Software companies of Germany', false],
  ['Software companies of France', false],
  ['Software companies of the Netherlands', false],
  ['Software companies of Switzerland', false],
  ['Software companies of Israel', false],
  ['Software companies of Canada', false],
  ['Software companies based in the San Francisco Bay Area', true], // Mountain View, Bay Area games
  ['Software companies based in New York City', false],
  ['Software companies based in Massachusetts', false],
  ['Software companies based in Washington (state)', true], // Seattle
  ['Software companies based in Texas', false],
  ['Software companies based in Illinois', false],
  ['Software companies based in Colorado', false],
  ['Artificial intelligence companies', true], // Generative AI companies
  ['Artificial intelligence industry in the United States', false], // Hugging Face, Scale AI, Perplexity
  ['Financial technology companies', true], // payment service providers, financial software, of the United States
  ['Financial technology companies based in California', false],
  ['Online banks', false],
  ['Neobanks', false],
  ['Online financial services companies of the United Kingdom', false], // Wise, Checkout.com
  ['Computer security companies', true], // computer security software, DDoS mitigation
  ['Semiconductor companies', true], // by country, fabless, equipment, foundries
  ['Robotics companies', true], // industrial robotics, self-driving cars
  ['Robotics companies of the United States', false],
  ['Robotics companies of the United Kingdom', false],
  ['Private spaceflight companies', false],
  ['Companies involved in quantum computing', false],
  ['Photonics companies', false],
  ['Video game companies of the United Kingdom', true], // stubs: the small studios
  ['Video game development companies', false],
  ['Y Combinator companies', false],
];
const CATEGORIES = [...FINANCE_CATEGORIES, ...TECH_CATEGORIES];
// Semiconductor companies by country: only where Discover's places are.
const CHIP_PLACES =
  'the United Kingdom|the United States|Ireland|Germany|France|the Netherlands|Switzerland|Israel|Canada|' +
  'Denmark|Sweden|Norway|Austria|Spain|Poland|Singapore';
const SUBCAT_OK = new RegExp(
  'hedge fund firms|tiger cub|investment banks|software companies (of|based in)|video game companies|' +
    'video game company stubs|generative ai companies|payment service providers|financial software companies|' +
    'financial technology companies (of|based in)|computer security software|ddos mitigation|' +
    `semiconductor companies of (${CHIP_PLACES})$|^(fabless|equipment|foundry) semiconductor|` +
    'industrial robotics|self-driving car companies',
  'i',
);
const SUBCAT_BAD = new RegExp(
  'defunct|former|failed|people|managers|personnel|executives|officers|founders|bankers|lists?\\b|wikipedia|' +
    'named after',
  'i',
);

// ---------------------------------------------------------------------------------------------
// HTTP with cache and polite retries

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lastHit = new Map();

async function contactEmail() {
  if (process.env.FIRMS_CONTACT) return process.env.FIRMS_CONTACT;
  try {
    return execFileSync('git', ['config', 'user.email'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function curl(url, headers) {
  const args = ['-sS', '-L', '--fail', '--max-time', '300'];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  return execFileSync('curl', [...args, url], { maxBuffer: 256 * 1024 * 1024 });
}

// GET returning a Buffer. Retries 429/5xx (and a failed curl) with 5, 10, 20, 40, 60s… backoff (or Retry-After):
// Wikipedia answers a long run's bursts with "You are making too many requests to the API".
async function get(url, headers = {}) {
  const host = new URL(url).host;
  const delays = [5, 10, 20, 40, 60, 60, 60, 60];
  for (let attempt = 0; ; attempt++) {
    const wait = 1000 - (Date.now() - (lastHit.get(host) || 0));
    if (wait > 0) await sleep(wait);
    lastHit.set(host, Date.now());
    let res;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(300_000) });
    } catch (err) {
      // fetch() ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1; curl honours it.
      console.warn(`  fetch failed (${err.cause?.code || err.message}), retrying with curl: ${url.slice(0, 120)}`);
      try {
        return curl(url, headers);
      } catch (curlErr) {
        if (attempt >= delays.length) throw curlErr;
        console.warn(`  curl failed too, retrying in ${delays[attempt]}s`);
        await sleep(delays[attempt] * 1000);
        continue;
      }
    }
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    if ((res.status === 429 || res.status >= 500) && attempt < delays.length) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const delay = retryAfter > 0 && retryAfter <= 120 ? retryAfter : delays[attempt];
      console.warn(`  HTTP ${res.status}, retrying in ${delay}s: ${url.slice(0, 120)}`);
      await sleep(delay * 1000);
      continue;
    }
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
}

async function cached(file, maxAge, load) {
  const p = path.join(cacheDir, file);
  if (!refresh && existsSync(p) && (maxAge === Infinity || Date.now() - (await stat(p)).mtimeMs < maxAge))
    return readFile(p);
  const data = await load();
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, data);
  return data;
}

const wikiHeaders = {
  'User-Agent': `${PROJECT} node`,
  'Api-User-Agent': PROJECT,
};

async function api(base, params) {
  const url = `${base}?${new URLSearchParams({ format: 'json', formatversion: '2', ...params })}`;
  const key = createHash('sha1').update(url).digest('hex');
  const buf = await cached(`api/${key}.json`, WEEK, () => get(url, wikiHeaders));
  const json = JSON.parse(buf.toString('utf8'));
  if (json.error) throw new Error(`${base}: ${json.error.code} ${json.error.info}`);
  return json;
}

// action=query with continuation; pages are merged by pageid (array props concatenated).
async function queryAll(params) {
  const pages = new Map();
  let cont = {};
  for (;;) {
    const json = await api(WIKI_API, { action: 'query', ...params, ...cont });
    for (const page of json.query?.pages || []) {
      const prev = pages.get(page.pageid);
      if (!prev) pages.set(page.pageid, page);
      else
        for (const [k, v] of Object.entries(page))
          prev[k] = Array.isArray(v) && Array.isArray(prev[k]) ? [...prev[k], ...v] : (prev[k] ?? v);
    }
    if (json.query?.categorymembers) {
      for (const m of json.query.categorymembers) pages.set(m.pageid, m);
    }
    if (!json.continue) break;
    cont = json.continue;
  }
  return [...pages.values()];
}

// ---------------------------------------------------------------------------------------------
// Form ADV: zip reader and CSV parser

function unzipFirst(buf, pattern) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip: end of central directory not found');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip: bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!pattern.test(name)) continue;
    if (size === 0xffffffff || local === 0xffffffff) throw new Error('zip: ZIP64 is not supported');
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('zip: bad local header');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    if (method === 0) return { name, data };
    if (method === 8) return { name, data: inflateRawSync(data) };
    throw new Error(`zip: unsupported compression method ${method}`);
  }
  throw new Error(`zip: no entry matches ${pattern}`);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) rows.push([...row, field]);
  return rows;
}

const num = (s) => {
  const n = Number(String(s || '').replace(/[,\s$]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

async function loadAdv() {
  const ua = `JobToFill firms builder ${await contactEmail()}`.trim();
  const headers = { 'User-Agent': ua, Accept: 'text/html,application/zip,*/*' };
  let file = SEC_FALLBACK;
  try {
    const html = (await get(SEC_INDEX, headers)).toString('utf8');
    // The page lists newest first; registered-adviser files are the ones without "exempt".
    const zips = [...html.matchAll(/href="([^"]*\/(ia[^"/]*\.zip))"/gi)].map((m) => m[2]);
    file = zips.find((z) => !/exempt/i.test(z)) || file;
  } catch (err) {
    console.warn(`  SEC index unavailable (${err.message}); using ${file}`);
  }
  const zip = await cached(`adv/${file}`, Infinity, () =>
    get(SEC_FILES + file, headers).catch((err) => {
      throw new Error(
        `${err.message}\nSEC needs a contact e-mail in the User-Agent: set FIRMS_CONTACT=you@example.org`,
      );
    }),
  );
  const { name, data } = unzipFirst(zip, /\.csv$/i);
  const rows = parseCsv(data.toString('latin1'));
  const header = rows.shift().map((h) => h.trim());
  const col = (label) => {
    const i = header.findIndex((h) => h.toLowerCase() === label.toLowerCase());
    if (i < 0) throw new Error(`Form ADV: column "${label}" not found`);
    return i;
  };
  const c = {
    crd: col('Organization CRD#'),
    name: col('Primary Business Name'),
    legal: col('Legal Name'),
    city: col('Main Office City'),
    country: col('Main Office Country'),
    // Withheld when the main office is a private residence: fall back to the mailing address.
    mailCity: col('Mail Office City'),
    mailCountry: col('Mail Office Country'),
    site: col('Website Address'),
    employees: col('5A'),
    aum: col('5F(2)(c)'),
    funds: col('Count of Private Funds - 7B(1)'),
    hedge: col('Total number of Hedge funds'),
    pe: col('Total number of PE funds'),
    vc: col('Total number of VC funds'),
    securitized: col('Total number of Securitized funds'),
    realEstate: col('Total number of Real Estate funds'),
    liquidity: col('Total number of Liquidity funds'),
    other: col('Total number of Other funds'),
  };
  const advisers = rows.map((r) => ({
    crd: num(r[c.crd]),
    name: r[c.name].trim(),
    legal: r[c.legal].trim(),
    city: (r[c.city] || r[c.mailCity]).trim(),
    country: (r[c.country] || r[c.mailCountry]).trim(),
    site: r[c.site].trim(),
    employees: num(r[c.employees]),
    aum: num(r[c.aum]),
    funds: num(r[c.funds]),
    types: {
      hedge: num(r[c.hedge]),
      pe: num(r[c.pe]),
      vc: num(r[c.vc]),
      credit: num(r[c.securitized]),
      realEstate: num(r[c.realEstate]),
      liquidity: num(r[c.liquidity]),
      other: num(r[c.other]),
    },
  }));
  console.log(`Form ADV ${file} (${name}): ${advisers.length} advisers, ${header.length} columns`);
  return { file, advisers };
}

// ---------------------------------------------------------------------------------------------
// Names, places and websites

const COUNTRIES = {
  'united states': 'US',
  'united kingdom': 'GB',
  'hong kong': 'HK',
  singapore: 'SG',
  switzerland: 'CH',
  canada: 'CA',
  germany: 'DE',
  france: 'FR',
  japan: 'JP',
  australia: 'AU',
  netherlands: 'NL',
  ireland: 'IE',
  luxembourg: 'LU',
  sweden: 'SE',
  norway: 'NO',
  denmark: 'DK',
  finland: 'FI',
  belgium: 'BE',
  spain: 'ES',
  italy: 'IT',
  austria: 'AT',
  portugal: 'PT',
  'united arab emirates': 'AE',
  israel: 'IL',
  china: 'CN',
  "china, people's republic of": 'CN',
  'korea, republic of': 'KR',
  'south korea': 'KR',
  korea: 'KR',
  'korea, south': 'KR',
  'taiwan, republic of china': 'TW',
  'bahamas, the': 'BS',
  mauritius: 'MU',
  estonia: 'EE',
  gibraltar: 'GI',
  guam: 'GU',
  croatia: 'HR',
  romania: 'RO',
  'saint lucia': 'LC',
  jamaica: 'JM',
  'trinidad and tobago': 'TT',
  'dominican republic': 'DO',
  guatemala: 'GT',
  bolivia: 'BO',
  ghana: 'GH',
  taiwan: 'TW',
  india: 'IN',
  brazil: 'BR',
  mexico: 'MX',
  'cayman islands': 'KY',
  bermuda: 'BM',
  guernsey: 'GG',
  jersey: 'JE',
  'isle of man': 'IM',
  'british virgin islands': 'VG',
  'virgin islands, british': 'VG',
  bahamas: 'BS',
  monaco: 'MC',
  liechtenstein: 'LI',
  'new zealand': 'NZ',
  'south africa': 'ZA',
  'saudi arabia': 'SA',
  qatar: 'QA',
  kuwait: 'KW',
  bahrain: 'BH',
  cyprus: 'CY',
  malta: 'MT',
  greece: 'GR',
  poland: 'PL',
  'czech republic': 'CZ',
  hungary: 'HU',
  turkey: 'TR',
  russia: 'RU',
  argentina: 'AR',
  chile: 'CL',
  colombia: 'CO',
  peru: 'PE',
  uruguay: 'UY',
  panama: 'PA',
  'puerto rico': 'PR',
  malaysia: 'MY',
  thailand: 'TH',
  indonesia: 'ID',
  philippines: 'PH',
  vietnam: 'VN',
  nigeria: 'NG',
  egypt: 'EG',
  kenya: 'KE',
  pakistan: 'PK',
  ukraine: 'UA',
  england: 'GB',
  scotland: 'GB',
  'united states of america': 'US',
  'u.s.': 'US',
  us: 'US',
  usa: 'US',
  uk: 'GB',
};
// Wikidata country items (P17) for the countries that matter here.
const COUNTRY_QIDS = {
  Q30: 'US',
  Q145: 'GB',
  Q8646: 'HK',
  Q334: 'SG',
  Q39: 'CH',
  Q16: 'CA',
  Q183: 'DE',
  Q142: 'FR',
  Q17: 'JP',
  Q408: 'AU',
  Q55: 'NL',
  Q27: 'IE',
  Q32: 'LU',
  Q34: 'SE',
  Q20: 'NO',
  Q35: 'DK',
  Q31: 'BE',
  Q29: 'ES',
  Q38: 'IT',
  Q40: 'AT',
  Q878: 'AE',
  Q801: 'IL',
  Q148: 'CN',
  Q884: 'KR',
  Q865: 'TW',
  Q668: 'IN',
  Q155: 'BR',
  Q96: 'MX',
  Q5785: 'KY',
  Q23635: 'BM',
  Q664: 'NZ',
  Q258: 'ZA',
  Q851: 'SA',
  Q846: 'QA',
  Q235: 'MC',
  Q347: 'LI',
  Q33: 'FI',
  Q36: 'PL',
  Q191: 'EE',
  Q213: 'CZ',
  Q45: 'PT',
  Q212: 'UA',
  Q159: 'RU',
  Q43: 'TR',
  Q414: 'AR',
};
const countryCode = (s) =>
  COUNTRIES[
    String(s || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim()
  ] || '';

const CITY_ALIASES = {
  'new york city': 'New York',
  'new york, ny': 'New York',
  nyc: 'New York',
  manhattan: 'New York',
  'city of london': 'London',
  'city of westminster': 'London',
  westminster: 'London',
  mayfair: 'London',
  'st james': 'London',
  "st james's": 'London',
  'canary wharf': 'London',
  soho: 'New York',
  'midtown manhattan': 'New York',
  'lower manhattan': 'New York',
  'financial district': 'New York',
  'wall street': 'New York',
  tribeca: 'New York',
  'hudson yards': 'New York',
  'greenwich village': 'New York',
  knightsbridge: 'London',
  marylebone: 'London',
  holborn: 'London',
  'st. james': 'London',
  'st james, london': 'London',
  'back bay': 'Boston',
  'hong kong island': 'Hong Kong',
  central: 'Hong Kong',
  'city of edinburgh': 'Edinburgh',
  'city of glasgow': 'Glasgow',
  'ward of bishopsgate': 'London',
  'tel aviv-yafo': 'Tel Aviv',
  sf: 'San Francisco',
  la: 'Los Angeles',
};

const ACRONYMS = new Set(
  (
    'AB ABN ADIA AEW AG AHL AI AKO AMP AQR ASB BC BDT BGC BHP BKM BMO BNP BNY BTG CBRE CDPQ CFM CI CIBC CIM CIO CLO CPP ' +
    'CQS CS CVC DC DRW DWS EFG EQT ETF FX GAM GCM GIC GLG GMO GPS GSA GW HBK HG HPS HRT HSBC ICG II III IMC ING ISAM ' +
    'IV JB JP KKR KLS LGT LLC LLP LMR LP LPL LSV LTD MFS MKP MLP MSD NB NBIM NJ NY NYC OCP PAG PDT PGIM PIMCO PJT PLC ' +
    'PIC PTE QIC QMA RBC RBS RCM RWC SA SAC SC SEB SEI SG SIG SL SLC SMBC TCI TCW TD TIAA TPG TT UBS UK US USA VII WCM WTW ' +
    'XTX'
  ).split(' '),
);
const SMALL_WORDS = new Set(['AND', 'OF', 'THE', 'FOR', 'IN', 'AT', 'ON', 'DE', 'DU', 'DES', 'LA', 'LE', 'VON', 'VAN']);

function titleWord(word, first) {
  if (!/[A-Z]/.test(word)) return word;
  if (/[a-z]/.test(word)) return word; // already mixed case
  const bare = word.replace(/[^A-Z0-9]/g, '');
  if (ACRONYMS.has(bare) || /^([A-Z]\.)+[A-Z]?\.?$/.test(word)) return word;
  if (bare.length > 1 && !/[AEIOUY]/.test(bare) && !/\d/.test(bare)) return word; // HBK, LMR, CQS
  if (!first && SMALL_WORDS.has(bare)) return word.toLowerCase();
  if (bare.length === 2 && word.length === 2 && !/^(CO|IN|ON|AT|TO|BY|OF|MY|GO|UP|SO|NO|DO)$/.test(bare)) return word; // AJ, GW
  return word
    .toLowerCase()
    .replace(/(^|[-'’/(])([a-z])/g, (m, sep, ch) => sep + ch.toUpperCase())
    .replace(/^Mc([a-z])/, (m, ch) => 'Mc' + ch.toUpperCase())
    .replace(/^Mac(kenzie|kay|donald|lean|leod|millan|intyre|gregor|arthur)/, (m, rest) => 'Mac' + titleCase(rest))
    .replace(/'S\b/g, "'s");
}
function titleCase(s) {
  return s
    .split(/(\s+)/)
    .map((w, i) => {
      if (/\s/.test(w)) return w;
      const brand = BRANDS.get(w.replace(/[^A-Za-z]/g, '').toUpperCase());
      return brand && w === w.toUpperCase() ? w.replace(/[A-Za-z]+/, brand) : titleWord(w, i === 0);
    })
    .join('');
}

// Brand spellings that title-casing an upper-case SEC name cannot recover.
const BRANDS = new Map(
  (
    'BlackRock AllianceBernstein PineBridge StepStone HarbourVest GoldenTree BlueCrest BlueBay ExodusPoint PointState ' +
    'BlueMountain TwinRock BlackBarn KKR FS iShares HighVista LightBay GreenOak WisdomTree DoubleLine TCW ' +
    'BlackGold LongView SkyBridge LaSalle DiamondRock PrimeStone OrbiMed BayPine BlueOwl ArrowMark'
  )
    .split(' ')
    .map((b) => [b.toUpperCase(), b]),
);

// Legal-form and geography suffixes stripped from the display name ("Lansdowne Partners (UK) LLP").
const LEGAL =
  /^(LLP|LP|L\.P\.|LLC|L\.L\.C\.|LTD\.?|LIMITED|INC\.?|INCORPORATED|CORP\.?|CORPORATION|PLC|S\.?A\.?|AG|GMBH|PTE\.?|N\.?A\.?|US|USA|U\.S\.|UK|AMERICAS?|NORTH)$/i;
function displayName(raw) {
  let s = raw.replace(/\s+/g, ' ').trim();
  s = s.replace(/\s*\([^)]*\)/g, ''); // (UK), (US), (NEW YORK)
  s = s.replace(/,?\s+LIMITED PARTNERSHIP$/i, '');
  for (;;) {
    const m = s.match(/^(.*?)[\s,]+([^\s,]+)$/);
    if (!m || !m[1] || !LEGAL.test(m[2])) break;
    s = m[1];
  }
  s = s.replace(/[\s,]+$/, '').replace(/\s+(OF|AND|&|THE)$/i, '');
  return titleCase(s);
}

// Display name for a group of advisers known only from Form ADV: the words shared by the names of
// the lead's affiliates ("Blackstone Real Estate Advisors", "Blackstone Credit…" -> "Blackstone").
function groupName(advs, lead) {
  const leadName = displayName(lead.name);
  const first = leadName.split(' ')[0];
  const names = [...new Set(advs.map((a) => displayName(a.name)).filter((n) => n.split(' ')[0] === first))];
  if (names.length < 2) return leadName;
  if (names.length === 2) {
    const [a, b] = names.sort((x, y) => x.length - y.length);
    return (b + ' ').startsWith(a + ' ') ? a : leadName;
  }
  const words = names.map((n) => n.split(' '));
  const prefix = [];
  for (let i = 0; words.every((w) => w[i] !== undefined && w[i] === words[0][i]); i++) prefix.push(words[0][i]);
  while (prefix.length && /^(&|and|of|the|for|,)$/i.test(prefix[prefix.length - 1])) prefix.pop();
  const result = prefix.join(' ').replace(/,$/, '');
  return result.length >= 3 ? result : leadName;
}

// Matching key: display name minus generic business words, so "Capula Investment US LP" and
// "Capula Investment Management" meet, as do "Brevan Howard US Investment Management" and "Brevan Howard".
const GENERIC = new Set(
  (
    'LLP LP LLC LTD LIMITED INC INCORPORATED CORP CORPORATION CO COMPANY PLC SA AG GMBH PTE NA US USA UK NORTH AMERICA ' +
    'AMERICAS MANAGEMENT MANAGER MANAGERS ADVISORS ADVISERS ADVISORY INVESTMENT INVESTMENTS ASSET GROUP HOLDINGS THE ' +
    'PARTNERSHIP INTERNATIONAL GLOBAL EUROPE'
  ).split(' '),
);
function nameKey(raw) {
  const words = raw
    .toUpperCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/&/g, ' AND ')
    .replace(/\./g, '')
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  while (words.length > 1 && GENERIC.has(words[words.length - 1])) words.pop();
  while (words.length > 1 && words[0] === 'THE') words.shift();
  return words.join(' ');
}

// Social networks, media and hosting platforms: never a firm's own site.
const SOCIAL = new RegExp(
  '(^|\\.)(' +
    'linkedin|twitter|x|facebook|fb|instagram|threads|youtube|youtu|tiktok|pinterest|reddit|medium|substack|vimeo|' +
    'spotify|spoti|soundcloud|podbean|libsyn|buzzsprout|anchor|apple|podcasts|bloomberg|crunchbase|pitchbook|' +
    'glassdoor|indeed|wikipedia|sec|finra|adviserinfo|google|bit|tinyurl|linktr|wix|wixsite|squarespace|godaddy|' +
    'wordpress|blogspot|github|morningstar|yahoo|wsj|ft|reuters|cnbc|businesswire|prnewswire|globenewswire|issuu|' +
    'slideshare|dropbox|sharepoint|mailchimp|eventbrite|calendly|docsend|carta|ycombinator|pandora|iheart|' +
    'iheartradio|audible|amazon|stitcher|deezer|tunein|castbox|transistor|simplecast|megaphone|omny|acast|qq|' +
    'weixin|weibo|wechat|bilibili|zhihu|xiaohongshu|naver|line' +
    ')\\.(com|be|gov|org|ly|io|fi|fm|me|ee|co|net)$',
  'i',
);
const SECOND_LEVEL =
  /\.(co|com|org|net|ac|gov|ltd|plc|edu)\.(uk|hk|sg|au|jp|nz|za|in|il|kr|tw|br|mx|ar|my|ph|cn|id|tr|sa|ae|co)$/i;

function website(raw) {
  let s = String(raw || '')
    .trim()
    .replace(/^\{\{\s*(?:URL|url|official URL|Official URL|official website)\s*\|\s*/, '')
    .replace(/\}\}.*$/, '')
    .replace(/\|.*$/, '')
    .replace(/^\[\s*/, '')
    .split(/\s/)[0];
  if (!s || !/\./.test(s)) return null;
  if (!/^[a-z]+:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  let host;
  try {
    host = new URL(s).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) || SOCIAL.test(host)) return null;
  const bare = host.replace(/^www\d*\./, '');
  const labels = bare.split('.');
  const domain = labels.slice(SECOND_LEVEL.test(bare) ? -3 : -2).join('.');
  return { domain, site: `https://${host}` };
}

// ---------------------------------------------------------------------------------------------
// Wikipedia and Wikidata

function infobox(wikitext) {
  const field = (names) => {
    for (const name of names) {
      const m = wikitext.match(new RegExp(`^\\s*\\|\\s*${name}\\s*=[ \\t]*(.*)$`, 'mi'));
      const value = m ? m[1].replace(/<!--.*?(-->|$)/g, '').trim() : '';
      if (value) return value;
    }
    return '';
  };
  return {
    website: field(['website', 'homepage', 'url']),
    city: field(['hq_location_city', 'location_city', 'hq_location', 'location', 'headquarters']),
    country: field(['hq_location_country', 'location_country']),
    defunct: field(['defunct', 'dissolved']),
  };
}

// "[[New York City]], [[New York (state)|New York]], U.S." -> "New York City"
// "31 [[St James's Place]], [[London]]" -> "London" (street addresses are skipped).
function plain(s) {
  const parts = s
    .replace(/<ref[^>]*\/>|<ref[^>]*>[\s\S]*?<\/ref>|<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, ',')
    .replace(/<[^>]+>/g, '')
    .replace(/\{\{[^{}]*\}\}/g, '')
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/'''?/g, '')
    .split(/[,;\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
  return parts.find((x) => !/\d/.test(x) && !BUILDING.test(x)) || '';
}

const BUILDING =
  /\b(center|centre|tower|building|plaza|house|street|st\.|avenue|ave\.?|road|square|place|wharf|court|floor|suite|park avenue|lane|row|hall|gardens?)\b/i;

function advCity(s) {
  const c = s
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return CITY_ALIASES[c.toLowerCase()] || titleCase(c);
}

// Wikidata sometimes gives a state or country as the headquarters ("Florida", "United States").
const REGIONS = new Set(
  (
    'alabama,alaska,arizona,arkansas,california,colorado,connecticut,delaware,florida,georgia,hawaii,idaho,' +
    'illinois,indiana,iowa,kansas,kentucky,louisiana,maine,maryland,massachusetts,michigan,minnesota,mississippi,' +
    'missouri,montana,nebraska,nevada,new hampshire,new jersey,new mexico,north carolina,north dakota,ohio,' +
    'oklahoma,oregon,pennsylvania,rhode island,south carolina,south dakota,tennessee,texas,utah,vermont,virginia,' +
    'west virginia,wisconsin,wyoming,england,scotland,wales'
  ).split(','),
);

function cityName(s) {
  const c = plain(String(s || '').replace(/\s*\([^)]*\)/g, '')).replace(/\s+/g, ' ');
  if (!c || c.length > 40 || COUNTRIES[c.toLowerCase()] || REGIONS.has(c.toLowerCase())) return '';
  const alias = CITY_ALIASES[c.toLowerCase()];
  if (alias) return alias;
  if (/^London Borough of /i.test(c)) return 'London';
  const town = c.replace(/^City of /i, ''); // Wikidata's "City of Portsmouth"
  return town === town.toUpperCase() ? titleCase(town) : town;
}

// Cities that name their country, for firms no source gives one a country ("Cambridge" and "Santiago" don't).
const CITY_COUNTRY = Object.fromEntries(
  Object.entries({
    GB: 'london,edinburgh,glasgow,manchester,bristol,oxford,birmingham,leeds,belfast,cardiff,guildford,dundee',
    US:
      'new york,san francisco,boston,chicago,los angeles,seattle,austin,palo alto,mountain view,menlo park,' +
      'san jose,santa clara,sunnyvale,redwood city,san mateo,berkeley,oakland,atlanta,denver,miami,dallas,' +
      'houston,washington,philadelphia,pittsburgh,san diego,irvine,greenwich,stamford,salt lake city,boulder,' +
      'bethesda,nashua',
    CA: 'toronto,vancouver,montreal,ottawa,waterloo,calgary,kitchener',
    IE: 'dublin,cork',
    DE: 'berlin,munich,hamburg,frankfurt,cologne',
    FR: 'paris,lyon',
    NL: 'amsterdam,rotterdam,utrecht',
    CH: 'zurich,zürich,geneva,lausanne',
    IL: 'tel aviv,herzliya,jerusalem,haifa',
    IN: 'bangalore,bengaluru,mumbai,new delhi,delhi,gurugram,gurgaon,hyderabad,pune,chennai,noida',
    SE: 'stockholm',
    DK: 'copenhagen',
    FI: 'helsinki',
    NO: 'oslo',
    ES: 'madrid,barcelona',
    IT: 'milan,rome',
    PL: 'warsaw,kraków,krakow',
    NG: 'lagos',
    KE: 'nairobi',
    EG: 'cairo',
    BR: 'são paulo,sao paulo,rio de janeiro',
    MX: 'mexico city,monterrey,guadalajara',
    CO: 'bogotá,bogota,medellín',
    AR: 'buenos aires',
    SG: 'singapore',
    HK: 'hong kong,sheung wan',
    JP: 'tokyo,osaka,kyoto',
    KR: 'seoul',
    CN: 'beijing,shanghai,shenzhen,hangzhou',
    TW: 'taipei',
    AU: 'sydney,melbourne,brisbane',
    AE: 'dubai,abu dhabi',
    ID: 'jakarta',
    PK: 'lahore,karachi',
    UA: 'kyiv',
    TR: 'istanbul',
    TH: 'bangkok',
    LU: 'luxembourg,luxembourg city',
    HU: 'budapest',
    BG: 'sofia',
    LT: 'vilnius',
    LV: 'riga',
    BY: 'minsk',
    SK: 'bratislava',
    HR: 'zagreb',
    SI: 'ljubljana',
    IS: 'reykjavík,reykjavik',
    BD: 'dhaka',
    NP: 'kathmandu',
    JO: 'amman',
    MA: 'casablanca',
  }).flatMap(([code, list]) => list.split(',').map((city) => [city, code])),
);
const cityCountry = (cities) =>
  cities.map((c) => CITY_COUNTRY[c.toLowerCase().split(',')[0].trim()]).find(Boolean) || '';

const DEFUNCT_CATEGORY = /^(Defunct |Former )|disestablished in|Companies that have ceased|Liquidated/i;

// Places in category names, most specific first: "Companies based in Cambridge, Massachusetts" is American,
// "Companies based in New England" and "London, Ontario" aren't English, "New South Wales" isn't Welsh.
const CATEGORY_PLACES = [
  [/Canada|Ontario|Toronto|Vancouver|Montreal|Quebec|British Columbia|Alberta/, 'CA'],
  [/Australia|New South Wales|Sydney|Melbourne/, 'AU'],
  [
    new RegExp(
      'United States|U\\.S\\. state|^American (companies|brands)|New York|New England|New Jersey|Connecticut|' +
        'Chicago|Illinois|California|San Francisco|Bay Area|Silicon Valley|Mountain View|Massachusetts|Boston|' +
        'Texas|Florida|Washington|Seattle|Colorado|Utah|Virginia|Pennsylvania',
    ),
    'US',
  ],
  [
    new RegExp(
      'United Kingdom|London|England|Scotland|Wales|Northern Ireland|^British (companies|brands)|Edinburgh|' +
        'Glasgow|Cambridge|Oxford|Manchester',
    ),
    'GB',
  ],
  [/Ireland|Dublin/, 'IE'],
  [/Hong Kong/, 'HK'],
  [/Singapore/, 'SG'],
  [/Germany|Berlin|Munich/, 'DE'],
  [/France|Paris/, 'FR'],
  [/Netherlands|Amsterdam/, 'NL'],
  [/Switzerland|Zurich|Zürich|Geneva/, 'CH'],
  [/Israel|Tel Aviv/, 'IL'],
];

function categoryCountry(cats) {
  for (const c of cats) for (const [re, code] of CATEGORY_PLACES) if (re.test(c)) return code;
  return '';
}

const FINANCE_TAGS = ['hedge', 'quant', 'trading', 'pe', 'credit', 'vc', 'ib', 'asset', 'family'];
const TECH_TAGS = ['software', 'ai', 'fintech', 'deeptech', 'cyber', 'games', 'yc'];
const TAG_ORDER = [...FINANCE_TAGS, ...TECH_TAGS];

// Words in a category's name and the tag they give.
const CATEGORY_TAGS = [
  [/Hedge fund|Tiger Cub/i, 'hedge'],
  [/Investment banks?\b/i, 'ib'],
  [/Private equity/i, 'pe'],
  [/Venture capital/i, 'vc'],
  [/derivative trading|Market makers|Proprietary trading|High-frequency trading/i, 'trading'],
  [/Family offices/i, 'family'],
  [/Investment management companies|Asset management companies/i, 'asset'],
  // "Technology companies based in London" are mostly software: the nearest tag.
  [/Software companies|Software as a service|\bSaaS\b|Cloud computing|Internet companies/i, 'software'],
  [/^(Information )?technology companies (of|based in)/i, 'software'],
  [/Artificial intelligence|Machine learning|Generative AI/i, 'ai'],
  [/Financial technology|Fintech|Cryptocurrency|Payment service providers|Financial software/i, 'fintech'],
  [/Online banks|Neobanks|Online financial services/i, 'fintech'],
  [/Semiconductor|Fabless|Robotics|spaceflight|Quantum computing|Photonics|Self-driving/i, 'deeptech'],
  [/Electronics (companies|manufacturers)|hardware companies/i, 'deeptech'],
  [/Computer security|Cybersecurity|DDoS mitigation/i, 'cyber'],
  [/Video game/i, 'games'],
  [/Y Combinator/i, 'yc'],
];

function categoryTags(cats) {
  const tags = new Set();
  for (const c of cats) {
    // Who owns or backed a company says nothing of what it does ("Private equity portfolio companies").
    if (/portfolio companies|-backed companies/i.test(c)) continue;
    for (const [re, tag] of CATEGORY_TAGS) if (re.test(c)) tags.add(tag);
  }
  return tags;
}

// "asset" is the fallback: Wikipedia files many hedge funds under investment management too.
function finishTags(tags, names) {
  if (FINANCE_TAGS.some((t) => t !== 'asset' && tags.has(t))) tags.delete('asset');
  if (!FINANCE_TAGS.some((t) => tags.has(t)) && /\b(asset|investment|wealth) management\b/i.test(names.join(' ')))
    tags.add('asset');
  return TAG_ORDER.filter((t) => tags.has(t));
}

// Wikidata statements, preferred first.
const claims = (entity, prop) =>
  (entity.claims?.[prop] || [])
    .filter((c) => c.rank !== 'deprecated' && c.mainsnak?.datavalue)
    .sort((a, b) => (b.rank === 'preferred') - (a.rank === 'preferred'));
const claim = (entity, prop) => claims(entity, prop).map((c) => c.mainsnak.datavalue.value);

// Employees (P1128): the figure with the latest point in time (P585), preferred first among equals. Under 10 for a
// company Wikipedia writes about is a stray claim (Improbable's 3, 5, 6 and 7 for 2018 to 2025): unknown.
function headcount(entity) {
  const when = (c) => c.qualifiers?.P585?.[0]?.datavalue?.value?.time || '';
  const latest = claims(entity, 'P1128').sort(
    (a, b) => (when(a) < when(b)) - (when(a) > when(b)) || (b.rank === 'preferred') - (a.rank === 'preferred'),
  )[0];
  const n = Math.round(Number(latest?.mainsnak.datavalue.value.amount));
  return n >= 10 ? n : 0;
}

// Inception (P571) as a year: "+2014-00-00T00:00:00Z" -> 2014.
function founded(entity) {
  const year = Number(/^\+?(\d{4})-/.exec(claim(entity, 'P571')[0]?.time || '')?.[1]);
  return year >= 1600 && year <= new Date().getFullYear() ? year : 0;
}

// Articles filed in company categories that are not companies: lists, people, products, and single-word topics like
// "Neobank" or "Insurtech" (Wikidata makes those classes, P279, not instances).
const NOT_FIRM = /^(Lists? of|Timeline of|Comparison of|History of|Outline of|Index of) /i;

async function loadWikipedia() {
  const categories = [];
  const tech = new Set(); // categories (and their subcategories) from TECH_CATEGORIES
  for (const [name, expand] of CATEGORIES) {
    const isTech = TECH_CATEGORIES.some(([c]) => c === name);
    const add = (cat) => {
      if (!categories.includes(cat)) categories.push(cat);
      if (isTech) tech.add(cat);
    };
    add(name);
    if (!expand) continue;
    const subs = await queryAll({
      list: 'categorymembers',
      cmtitle: `Category:${name}`,
      cmtype: 'subcat',
      cmlimit: 'max',
    });
    for (const s of subs) {
      const sub = s.title.replace(/^Category:/, '');
      if (SUBCAT_OK.test(sub) && !SUBCAT_BAD.test(sub)) add(sub);
    }
  }

  const pages = new Map(); // title -> { title, qid, cats:Set, from:Set }
  for (const cat of categories) {
    const members = await queryAll({
      generator: 'categorymembers',
      gcmtitle: `Category:${cat}`,
      gcmtype: 'page',
      gcmlimit: 'max',
      gcmnamespace: '0',
      prop: 'pageprops|categories',
      ppprop: 'wikibase_item',
      clshow: '!hidden',
      cllimit: 'max',
    });
    for (const m of members) {
      if (NOT_FIRM.test(m.title)) continue;
      const page = pages.get(m.title) || { title: m.title, qid: '', cats: new Set(), from: new Set() };
      page.qid ||= m.pageprops?.wikibase_item || '';
      for (const c of m.categories || []) page.cats.add(c.title.replace(/^Category:/, ''));
      page.from.add(cat);
      pages.set(m.title, page);
    }
    console.log(`  ${cat}: ${members.length}`);
  }
  const all = [...pages.values()].sort((a, b) => a.title.localeCompare(b.title));

  // Infobox (section 0 wikitext), 50 titles per request.
  for (let i = 0; i < all.length; i += 50) {
    const batch = all.slice(i, i + 50);
    const res = await queryAll({
      titles: batch.map((p) => p.title).join('|'),
      prop: 'revisions',
      rvprop: 'content',
      rvslots: 'main',
      rvsection: '0',
    });
    for (const r of res) {
      const page = pages.get(r.title);
      if (page) page.box = infobox(r.revisions?.[0]?.slots?.main?.content || '');
    }
  }

  // Wikidata: website, dissolution, headquarters, country, employees, inception, and whether the item is a
  // person (P31 human) or a class (P279) rather than a company.
  const byQid = new Map(all.filter((p) => p.qid).map((p) => [p.qid, p]));
  const cityQids = new Set();
  const ids = [...byQid.keys()];
  for (let i = 0; i < ids.length; i += 50) {
    const json = await api(WIKIDATA_API, {
      action: 'wbgetentities',
      ids: ids.slice(i, i + 50).join('|'),
      props: 'claims',
    });
    for (const [qid, entity] of Object.entries(json.entities || {})) {
      const page = byQid.get(qid);
      if (!page) continue;
      page.wdSite = claim(entity, 'P856')[0] || '';
      page.dissolved = claim(entity, 'P576').length > 0;
      page.hqQid = claim(entity, 'P159')[0]?.id || '';
      page.countryQid = claim(entity, 'P17')[0]?.id || '';
      page.employees = headcount(entity);
      page.founded = founded(entity);
      // A topic ("Neobank") is a class of things and an instance of nothing. Lansdowne Partners and DailyPay are
      // filed as subclasses too, but as instances of a business, and Waymo has a website.
      const has = (...props) => props.some((prop) => claim(entity, prop).length > 0);
      const topic = has('P279') && !has('P31') && !has('P856', 'P159', 'P1128');
      // Products filed beside their makers ("ChatGPT", "Pebble (watch)") have a developer or a manufacturer and no
      // headquarters, staff, industry or legal form; Monzo and Starling Bank, their own apps' developers, have them.
      const product = has('P178', 'P176') && !has('P159', 'P1128', 'P452', 'P1454');
      page.notFirm = topic || product || claim(entity, 'P31').some((v) => v.id === 'Q5');
      if (page.hqQid) cityQids.add(page.hqQid);
    }
  }
  const cityLabels = new Map();
  const cityIds = [...cityQids].sort();
  for (let i = 0; i < cityIds.length; i += 50) {
    const json = await api(WIKIDATA_API, {
      action: 'wbgetentities',
      ids: cityIds.slice(i, i + 50).join('|'),
      props: 'labels',
      languages: 'en',
    });
    for (const [qid, entity] of Object.entries(json.entities || {}))
      if (entity.labels?.en) cityLabels.set(qid, entity.labels.en.value);
  }

  const firms = [];
  let defunct = 0;
  let topics = 0;
  for (const p of all) {
    const cats = [...p.cats];
    if (p.dissolved || p.box?.defunct || cats.some((c) => DEFUNCT_CATEGORY.test(c))) {
      defunct++;
      continue;
    }
    const box = p.box || {};
    const site = website(p.wdSite) || website(box.website);
    const city = cityName(cityLabels.get(p.hqQid) || '') || cityName(box.city);
    const country = COUNTRY_QIDS[p.countryQid] || countryCode(plain(box.country || ''));
    // Topic articles filed in firm categories ("Hedge fund", "Special situation", "Video game developer") are not
    // firms: firm titles are proper nouns ("Wise (company)", "Rockstar North"; "eToro" and "iRobot" are brands).
    const words = p.title
      .replace(/\s*\(.*\)$/, '')
      .split(' ')
      .slice(1);
    const lower = (w) =>
      /^[a-z]/.test(w) &&
      !/[A-Z0-9]/.test(w) &&
      !/^(of|and|the|de|du|la|le|des|von|van|der|den|for|in|on|at|by|to|a|an|with|und|et|e|y|plc|&)$/.test(w);
    if (p.notFirm || words.some(lower)) {
      topics++;
      if (process.env.FIRMS_DEBUG) console.log('  topic:', p.title);
      continue;
    }
    firms.push({
      title: p.title,
      qid: p.qid,
      site,
      city,
      country,
      employees: p.employees || 0,
      founded: p.founded || 0,
      tech: [...p.from].every((c) => tech.has(c)),
      catCountry: categoryCountry([...p.from, ...cats]),
      tags: categoryTags([...p.from, ...cats]),
    });
  }
  console.log(
    `Wikipedia: ${categories.length} categories, ${all.length} pages, ${defunct} defunct and ${topics} topic articles dropped`,
  );
  return { firms, members: all.length };
}

// ---------------------------------------------------------------------------------------------
// Y Combinator

// YC's industries and tags ("B2B", "Fintech", "Developer Tools", "Manufacturing and Robotics"…) as registry tags.
const YC_TAGS = new Map(
  Object.entries({
    fintech: 'Fintech|Payments|Banking and Exchange|Neobank|Banking as a Service|Crypto / Web3',
    software:
      'B2B|Software|SaaS|Enterprise Software|Developer Tools|Infrastructure|Productivity|Analytics|Open Source|' +
      'API|Data Engineering|Engineering, Product and Design',
    ai:
      'Artificial Intelligence|AI|Machine Learning|Generative AI|Deep Learning|Computer Vision|Conversational AI|' +
      'NLP|AI Assistant|AIOps',
    deeptech:
      'Hardware|Hard Tech|Industrials|Robotics|Manufacturing and Robotics|Aerospace|Aviation and Space|Drones|' +
      'Semiconductors|Quantum Computing|Space Exploration',
    cyber: 'Security|Cybersecurity',
    games: 'Gaming',
  }).flatMap(([tag, labels]) => labels.split('|').map((label) => [label.toLowerCase(), tag])),
);

// "Winter 2021" -> "W21" (YC's own short form; Spring is X).
function ycBatch(batch) {
  const m = /^(Winter|Summer|Fall|Spring) (\d{4})$/.exec(String(batch || '').trim());
  return m ? { Winter: 'W', Summer: 'S', Fall: 'F', Spring: 'X' }[m[1]] + m[2].slice(2) : '';
}

// "London, England, United Kingdom; New York City, NY, USA; Remote" -> cities ["London", "New York"] and the
// first office's country, GB.
function ycPlaces(locations) {
  const cities = [];
  let country = '';
  for (const loc of String(locations || '').split(/\s*;\s*/)) {
    const parts = loc.split(',').map((x) => x.trim());
    if (!parts[0] || /^(remote|partly remote)$/i.test(parts[0])) continue;
    country ||= countryCode(parts[parts.length - 1]); // "Singapore" is both
    // "MH, India" and "LA, Nigeria" are a state and its country: no city.
    if (parts.length === 2 && /^[A-Z]{2}$/.test(parts[0])) continue;
    const raw = parts[0].replace(/\s+/g, ' ');
    const city =
      CITY_ALIASES[raw.toLowerCase()] ||
      (raw === raw.toLowerCase() || raw === raw.toUpperCase()
        ? raw.toLowerCase().replace(/(^|[\s-])([a-z])/g, (m, sep, ch) => sep + ch.toUpperCase())
        : raw);
    if (!cities.includes(city)) cities.push(city);
  }
  return { cities, country };
}

// "On-demand electronics manufacturing", cut at a word to 120 characters.
function oneLiner(s) {
  const t = String(s || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length <= 120) return t;
  return (
    t
      .slice(0, 119)
      .replace(/\s+\S*$/, '')
      .replace(/[\s,;:–—-]+$/, '') + '…'
  );
}

async function loadYc() {
  let list;
  try {
    const buf = await cached('yc/companies.json', WEEK, () =>
      get(YC_API, { 'User-Agent': `${PROJECT} node`, Accept: 'application/json' }),
    );
    list = JSON.parse(buf.toString('utf8'));
    if (!Array.isArray(list)) throw new Error('not a list');
  } catch (err) {
    console.warn(`  Y Combinator directory unavailable (${err.message}); YC only from its Wikipedia category`);
    return { firms: [], count: 0 };
  }
  const firms = [];
  for (const c of list) {
    if (!/^(Active|Public)$/.test(c.status) || !(c.team_size >= YC_MIN_TEAM && c.team_size <= YC_MAX_TEAM)) continue;
    const web = website(c.website);
    const name = String(c.name || '').trim();
    if (!web || !name) continue;
    const tags = new Set(['yc']);
    for (const label of [c.industry, ...(c.industries || []), ...(c.tags || [])]) {
      const tag = YC_TAGS.get(
        String(label || '')
          .trim()
          .toLowerCase(),
      );
      if (tag) tags.add(tag);
    }
    firms.push({
      name,
      slug: String(c.slug || ''),
      web,
      ...ycPlaces(c.all_locations),
      employees: Math.round(c.team_size),
      batch: ycBatch(c.batch),
      oneLiner: oneLiner(c.one_liner),
      tags,
    });
  }
  firms.sort((a, b) => a.name.localeCompare(b.name, 'en') || a.slug.localeCompare(b.slug));
  console.log(`Y Combinator: ${list.length} companies, ${firms.length} active or public with ${YC_MIN_TEAM}+ staff`);
  return { firms, count: list.length };
}

// ---------------------------------------------------------------------------------------------
// Merge

const QUANT_NAMES =
  /\b(quant\w*|systematic|algorithmic|two sigma|d\.? ?e\.? shaw|renaissance technologies|aqr|winton|g-research|qube|cubist|pdt partners|worldquant|squarepoint|quadrature|voleon|aspect capital|capital fund management|arrowstreet|acadian|panagora|engineers gate|graham capital|man ahl|millburn|research (and|&) technolog\w*)\b/i;
const TRADING_NAMES =
  /\b(jane street|optiver|imc trading|flow traders|susquehanna|drw|hudson river trading|jump trading|xtx|tower research|virtu|citadel securities|akuna|old mission|five rings|maven securities|da vinci|mako|tibra|qube research)\b/i;

function nameTags(names) {
  const tags = new Set();
  const s = names.join(' | ');
  if (QUANT_NAMES.test(s)) tags.add('quant');
  if (TRADING_NAMES.test(s)) tags.add('trading');
  if (/\b(credit|debt|lending|loan|clo)\b/i.test(s)) tags.add('credit');
  if (/\bventures?\b/i.test(s)) tags.add('vc');
  if (/private equity/i.test(s)) tags.add('pe');
  if (/family office/i.test(s)) tags.add('family');
  return tags;
}

// A firm's record in firms.json's key order, without the empty fields.
const KEYS = ['n', 'a', 'd', 's', 'c', 'k', 'e', 'm', 'f', 'r', 'w', 'q', 'i', 'y', 'o', 't'];
function compact(fields) {
  const firm = {};
  for (const k of KEYS) {
    const v = fields[k];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length && k !== 't')) continue;
    firm[k] = v;
  }
  return firm;
}

const unique = (list) => [...new Set(list.filter(Boolean))];
const wikiName = (title) => title.replace(/\s*\([^)]*\)$/, '').replace(/,? (plc|Inc\.|LLC|Ltd\.?|Limited|L\.P\.)$/, '');
const wikiKey = (title) => title.replace(/ /g, '_');

// Tech companies come from Wikipedia's tech categories and YC; everything else is finance.
const isTech = (it) => it.kind === 'yc' || (it.kind === 'wiki' && it.tech);
// The staff count that makes a name match across websites believable: an adviser's, as Form ADV gives it.
const staff = (it) => (it.kind === 'adv' || it.kind === 'kept' ? it.employees || 0 : 0);
// Whether a website's name matches the firm's: Form ADV sometimes gives a platform's site instead
// ("pennington.addepar.com" for Pennington Partners), which mustn't pull Addepar the company in.
function ownSite(it, domain) {
  const label = domain.split('.')[0].replace(/[^a-z0-9]/g, '');
  return it.keys.some((key) => {
    const first = key.split(' ')[0].toLowerCase();
    const whole = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    return (
      (first.length >= 3 && label.includes(first)) || (label.length >= 3 && whole.includes(label)) || whole === label
    );
  });
}

// A firm kept from the previous build (--no-sec): its Form ADV facts as they were, plus what Wikipedia and
// Y Combinator add now (an article and its name, the year founded, a YC batch, tech tags).
function keepFirm(rec, w, wikis, ycs) {
  const y = ycs[0];
  const name = !rec.w && w ? wikiName(w.title) : rec.n;
  const aliases = [...(rec.a || [])];
  if (name !== rec.n && !aliases.includes(rec.n)) aliases.unshift(rec.n);
  // Its finance tags as built; the tech ones afresh, so a rebuild with --no-sec drops what no longer applies.
  const tags = new Set(rec.t.filter((t) => FINANCE_TAGS.includes(t)));
  for (const x of [...wikis, ...ycs]) for (const t of x.tags) tags.add(t);
  const cities = unique([...(rec.c || []), w?.city, ...(y?.cities || [])]).slice(0, 4);
  return compact({
    ...rec,
    n: name,
    a: aliases.slice(0, 3),
    c: cities,
    k: rec.k || w?.country || y?.country || w?.catCountry || cityCountry(cities),
    w: rec.w || (w && wikiKey(w.title)),
    q: rec.q || w?.qid,
    i: w?.founded || undefined,
    y: y?.batch,
    o: y?.oneLiner,
    t: finishTags(tags, [name, ...aliases]),
  });
}

// kept: the previous build's Form ADV firms, standing in for `adv` when the SEC file isn't there (--no-sec).
function build(adv, wiki, yc, kept = []) {
  // Union-find over advisers (or kept firms), Wikipedia firms and YC companies.
  // A domain listed by advisers with three or more unrelated names, none of them matching the domain,
  // is a platform (a podcast host, an ETF brand), not a firm's site. man.com (Man, AHL, GLG) stays.
  const advWeb = adv.map((a) => website(a.site));
  const firstWords = new Map();
  adv.forEach((a, i) => {
    const d = advWeb[i]?.domain;
    if (!d) return;
    if (!firstWords.has(d)) firstWords.set(d, new Set());
    firstWords.get(d).add(nameKey(a.name).split(' ')[0]);
  });
  const platforms = new Set(
    [...firstWords]
      .filter(([d, w]) => {
        const label = d.split('.')[0].replace(/[^a-z0-9]/g, '');
        return w.size >= 3 && ![...w].some((x) => label.includes(x.toLowerCase()) || x.toLowerCase().includes(label));
      })
      .map(([d]) => d),
  );
  const items = [
    ...adv.map((a, i) => ({
      kind: 'adv',
      ...a,
      web: platforms.has(advWeb[i]?.domain) ? null : advWeb[i],
      keys: [nameKey(a.name)],
      places: [advCity(a.city)],
      countries: [countryCode(a.country)],
    })),
    ...kept.map((rec) => ({
      kind: 'kept',
      rec,
      web: rec.d ? { domain: rec.d, site: rec.s || `https://${rec.d}` } : null,
      keys: unique([rec.n, ...(rec.a || [])].map(nameKey)),
      employees: rec.e || 0,
      places: rec.c || [],
      countries: [rec.k],
    })),
    ...wiki.map((w) => ({
      kind: 'wiki',
      ...w,
      web: w.site,
      keys: [nameKey(w.title.replace(/\s*\(.*\)$/, ''))],
      places: [w.city],
      countries: [w.country || w.catCountry],
    })),
    ...yc.map((y) => ({ kind: 'yc', ...y, keys: [nameKey(y.name)], places: y.cities, countries: [y.country] })),
  ];
  const parent = items.map((_, i) => i);
  const domains = items.map((it) => new Set(it.web ? [it.web.domain] : []));
  const cities = items.map((it) => new Set(it.places.filter(Boolean)));
  const countries = items.map((it) => new Set(it.countries.filter(Boolean)));
  const keeps = items.map((it) => it.kind === 'kept');
  const secs = items.map((it) => it.kind === 'kept' || it.kind === 'adv');
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const overlap = (a, b) => [...a].some((x) => b.has(x));
  // A YC company and the Wikipedia article of its name are one company despite different websites when the
  // article is filed under "Y Combinator companies" (Deel: deel.com, and letsdeel.com on Wikidata), or when both
  // sites have the same name (replika.ai, replika.com) and no two cities disagree. YC's Runway (runway.team) is not
  // Runway ML, nor its Conduit (conduit.ai, San Francisco) the New York one (conduit.com).
  const ycArticle = (a, b, ra, rb) => {
    const yc = [a, b].find((it) => it.kind === 'yc');
    const article = [a, b].find((it) => it.kind === 'wiki');
    if (!yc || !article || secs[ra] || secs[rb]) return false;
    const label = (web) => web?.domain.split('.')[0];
    if (article.tags.has('yc')) return true;
    const citiesAgree = !cities[ra].size || !cities[rb].size || overlap(cities[ra], cities[rb]);
    return label(yc.web) === label(article.web) && citiesAgree;
  };
  const union = (a, b, byName) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // Kept firms stay as the previous build made them: one never absorbs another.
    if (keeps[ra] && keeps[rb]) return;
    if (!byName && isTech(items[a]) !== isTech(items[b])) {
      const fin = isTech(items[a]) ? items[b] : items[a];
      if ((fin.kind === 'adv' || fin.kind === 'kept') && !ownSite(fin, fin.web.domain)) return;
    }
    if (byName) {
      const conflict = domains[ra].size && domains[rb].size && !overlap(domains[ra], domains[rb]);
      if (isTech(items[a]) || isTech(items[b])) {
        // Tech names are often words ("Ripple", "Atlas"): in different countries, or with different websites (but
        // for a YC company and its own article), they're different companies.
        if (countries[ra].size && countries[rb].size && !overlap(countries[ra], countries[rb])) return;
        if (conflict && !ycArticle(items[a], items[b], ra, rb)) return;
      } else if (conflict) {
        // A name match may not join two groups that already have different websites, unless a
        // Wikipedia firm and an adviser share a city (Davidson Kempner: dkpartners.com, davidsonkempner.com),
        // or a country when one has no city and the adviser is sizeable (50+ staff).
        const sameCity = overlap(cities[ra], cities[rb]);
        const big = Math.max(staff(items[a]), staff(items[b])) >= 50;
        const sameCountry = big && (!cities[ra].size || !cities[rb].size) && overlap(countries[ra], countries[rb]);
        if (items[a].kind === items[b].kind || !(sameCity || sameCountry)) return;
      }
    }
    parent[rb] = ra;
    keeps[ra] ||= keeps[rb];
    secs[ra] ||= secs[rb];
    for (const d of domains[rb]) domains[ra].add(d);
    for (const c of cities[rb]) cities[ra].add(c);
    for (const c of countries[rb]) countries[ra].add(c);
  };
  const firstBy = new Map();
  items.forEach((it, i) => {
    if (!it.web) return;
    const d = it.web.domain;
    if (firstBy.has(d)) union(firstBy.get(d), i, false);
    else firstBy.set(d, i);
  });
  const firstKey = new Map();
  items.forEach((it, i) => {
    for (const key of it.keys) {
      if (key.length < 4) continue;
      if (firstKey.has(key)) union(firstKey.get(key), i, true);
      else firstKey.set(key, i);
    }
  });

  const groups = new Map();
  items.forEach((it, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(it);
  });

  const firms = [];
  for (const members of groups.values()) {
    const advs = members
      .filter((m) => m.kind === 'adv')
      .sort((a, b) => b.employees - a.employees || b.aum - a.aum || a.crd - b.crd);
    const wikis = members.filter((m) => m.kind === 'wiki').sort((a, b) => a.title.localeCompare(b.title));
    const ycs = members
      .filter((m) => m.kind === 'yc')
      .sort((a, b) => b.employees - a.employees || a.name.localeCompare(b.name, 'en') || a.slug.localeCompare(b.slug));
    const prev = members.find((m) => m.kind === 'kept')?.rec;
    if (prev) {
      firms.push(keepFirm(prev, prev.w ? wikis.find((x) => wikiKey(x.title) === prev.w) : wikis[0], wikis, ycs));
      continue;
    }
    const w = wikis[0];
    const y = ycs[0];
    const maxEmp = Math.max(0, ...advs.map((a) => a.employees));
    const maxAum = Math.max(0, ...advs.map((a) => a.aum));
    const maxFunds = Math.max(0, ...advs.map((a) => a.funds));
    if (!w && !y && !(maxFunds > 0 && maxAum >= MIN_AUM && maxEmp >= MIN_EMPLOYEES)) continue;

    const lead = advs.find((a) => a.funds > 0) || advs[0];
    // A startup's site as YC has it (Wikidata can lag: letsdeel.com for Deel), else Wikipedia/Wikidata's, else
    // the one most of the group's staff work under (ADV lists only each adviser's first site, sometimes a
    // LinkedIn page or a local subsidiary's domain).
    let web = advs.length ? w?.site || y?.web : y?.web || w?.site;
    if (!web) {
      const weight = new Map();
      for (const a of advs) if (a.web) weight.set(a.web.domain, (weight.get(a.web.domain) || 0) + a.employees + 1);
      const best = [...weight].sort((x, z) => z[1] - x[1] || x[0].localeCompare(z[0]))[0]?.[0];
      web = (best && lead?.web?.domain === best && lead.web) || advs.find((a) => a.web?.domain === best)?.web;
    }
    // A tech company without a website can't be checked for openings.
    if (!web && (!w || members.every(isTech))) continue;

    const name = w ? wikiName(w.title) : advs.length ? groupName(advs, lead) : y.name;
    const aliases = [];
    for (const alias of [...advs.map((a) => titleCase(a.name.replace(/\s+/g, ' '))), ...ycs.map((x) => x.name)])
      if (alias !== name && !aliases.includes(alias)) aliases.push(alias);
    const cities = unique([w?.city, ...advs.map((a) => advCity(a.city)), ...(y?.cities || [])]);
    const country = w?.country || countryCode(lead?.country) || y?.country || w?.catCountry || cityCountry(cities);

    const tags = new Set();
    for (const x of [...wikis, ...ycs]) for (const t of x.tags) tags.add(t);
    // Fund types reported in Form ADV 7.B: a type counts when it is at least a quarter of the funds.
    const types = {};
    for (const a of advs) for (const [t, n] of Object.entries(a.types)) types[t] = (types[t] || 0) + n;
    const total = Object.values(types).reduce((s, n) => s + n, 0);
    for (const t of ['hedge', 'pe', 'vc', 'credit']) if (total && types[t] / total > 1 / 3) tags.add(t);
    // Finance words in a tech company's name mean something else: "Quantum Motion" builds qubits, not a quant fund.
    if (members.some((m) => !isTech(m))) for (const t of nameTags([name, ...aliases])) tags.add(t);

    firms.push(
      compact({
        n: name,
        a: aliases.slice(0, 3),
        d: web?.domain,
        s: web?.site,
        c: cities.slice(0, 4),
        k: country,
        // Form ADV's staff count, else YC's team size, else Wikidata's.
        e: maxEmp || y?.employees || w?.employees || undefined,
        m: maxAum ? Math.round(maxAum / 1e8) / 10 : undefined,
        f: maxFunds || undefined,
        r: lead?.crd,
        w: w && wikiKey(w.title),
        q: w?.qid,
        i: w?.founded || undefined,
        y: y?.batch,
        o: y?.oneLiner,
        t: finishTags(tags, [name, ...aliases]),
      }),
    );
  }
  return firms.sort(
    (a, b) =>
      a.n.localeCompare(b.n, 'en') ||
      (a.r || 0) - (b.r || 0) ||
      (a.d || '').localeCompare(b.d || '') ||
      (a.w || '').localeCompare(b.w || ''),
  );
}

// ---------------------------------------------------------------------------------------------

function summary(firms, bytes) {
  const count = (list, fn) => {
    const m = new Map();
    for (const f of list) for (const k of [].concat(fn(f) || [])) m.set(k, (m.get(k) || 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  };
  const top = (pairs, n) =>
    pairs
      .slice(0, n)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
  console.log(`\n${firms.length} firms, ${(bytes / 1024).toFixed(0)} KB`);
  const has = (k) => firms.filter((f) => f[k]).length;
  const both = firms.filter((f) => f.r && f.w).length;
  console.log(`  sources:   SEC ${has('r')}, Wikipedia ${has('w')}, both ${both}, YC ${has('y')}`);
  console.log(
    `  countries: ${top(
      count(firms, (f) => f.k || '?'),
      20,
    )}`,
  );
  console.log(
    `  cities:    ${top(
      count(firms, (f) => f.c?.[0] || '?'),
      15,
    )}`,
  );
  console.log(`  untagged:  ${firms.filter((f) => !f.t.length).length}`);
  for (const tag of TAG_ORDER) {
    const tagged = firms.filter((f) => f.t.includes(tag));
    console.log(
      `  ${tag.padEnd(9)} ${String(tagged.length).padStart(5)}  ${top(
        count(tagged, (f) => f.k || '?'),
        8,
      )}`,
    );
  }
}

// The previous build: its Form ADV firms stand in when the SEC file isn't fetched, and its date stays when
// nothing changed.
let prev = null;
try {
  prev = JSON.parse(await readFile(outFile, 'utf8'));
} catch {
  // first build
}
let adv = null;
if (!noSec) {
  try {
    adv = await loadAdv();
  } catch (err) {
    console.warn(`Form ADV unavailable: ${err.message}\n  keeping the previous build's SEC firms`);
  }
}
const kept = adv ? [] : (prev?.firms || []).filter((f) => f.r);
if (!adv && !kept.length) throw new Error('No Form ADV file, and no previous firms.json to keep its SEC firms from');
const advSource = adv
  ? adv.file
  : / \(kept from /.test(prev.sources?.adv || '')
    ? prev.sources.adv
    : `${prev.sources?.adv || 'Form ADV'} (kept from ${prev.built})`;
if (!adv) console.log(`Form ADV: ${kept.length} firms kept from the previous build: ${advSource}`);
const { firms: wiki, members } = await loadWikipedia();
const { firms: yc, count: ycCount } = await loadYc();
const firms = build(adv?.advisers || [], wiki, yc, kept);

const sources = { adv: advSource, wikipedia: `${members} category members` };
if (ycCount) sources.yc = `${ycCount} companies (yc-oss.github.io)`;
const built =
  prev && JSON.stringify([prev.sources, prev.firms]) === JSON.stringify([sources, firms])
    ? prev.built
    : new Date().toISOString().slice(0, 10);
const body =
  `{\n"built": ${JSON.stringify(built)},\n"sources": ${JSON.stringify(sources)},\n"firms": [\n` +
  firms.map((f) => JSON.stringify(f)).join(',\n') +
  '\n]\n}\n';
await mkdir(path.dirname(outFile), { recursive: true });
await writeFile(outFile, body);
summary(firms, Buffer.byteLength(body));
console.log(`✓ wrote ${path.relative(root, outFile)}`);
