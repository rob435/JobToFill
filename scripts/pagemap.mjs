// The page map of a live page or a test fixture, as the extension sees it: the outline of its text, every field with
// its ref, question, state and what the rules take it for, the buttons and the frames (lib/pagemap.js). Runs the real
// extension in Chromium through the e2e harness. Nothing is ever clicked or submitted; --fill fills the form with the
// test profile the way the Fill button does, so the map shows what the fill did.
//
//   node scripts/pagemap.mjs <url | fixture.html> [--fill] [--screenshot out.png] [--json out.json]
//                            [--max-chars N] [--wait ms] [--values state|redacted|full] [--headed]
//
// A bare name ("greenhouse.html", "lib-antd.html?x=1") is a page from tests/fixtures; anything with a scheme is opened
// as it is. The map goes to stdout; --json writes the whole map, --screenshot a full-page screenshot with each ref
// drawn on its field or button. --values full shows what is typed in fields too (state, the default, never does).
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const USAGE = `Usage: node scripts/pagemap.mjs <url | fixture.html> [--fill] [--screenshot out.png] [--json out.json]
                            [--max-chars N] [--wait ms] [--values state|redacted|full] [--headed]`;

function parse(argv) {
  const opts = { fill: false, headed: false, values: 'state', wait: 0, maxChars: 0 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [key, inline] = a.startsWith('--') ? a.slice(2).split(/=(.*)/s) : [null];
    const next = () => (inline != null ? inline : argv[++i]);
    if (key === 'fill') opts.fill = true;
    else if (key === 'headed') opts.headed = true;
    else if (key === 'screenshot') opts.screenshot = next();
    else if (key === 'json') opts.json = next();
    else if (key === 'max-chars') opts.maxChars = parseInt(next(), 10) || 0;
    else if (key === 'wait') opts.wait = parseInt(next(), 10) || 0;
    else if (key === 'values') opts.values = next();
    else if (key === 'help' || key === 'h') opts.help = true;
    else if (key) throw new Error(`Unknown option --${key}`);
    else rest.push(a);
  }
  opts.target = rest[0];
  return opts;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for the page to go quiet: no requests for a moment (at most 15 s), then `extra` ms more. */
async function settle(page, extra) {
  if (typeof page.waitForLoadState === 'function')
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  else if (typeof page.waitForNetworkIdle === 'function')
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 15000 }).catch(() => {});
  await sleep(Math.max(300, extra || 0));
}

async function main() {
  const opts = parse(process.argv.slice(2));
  if (opts.help || !opts.target) {
    console.error(USAGE);
    process.exit(opts.help ? 0 : 2);
  }
  if (!['state', 'redacted', 'full'].includes(opts.values)) throw new Error('--values is state, redacted or full');
  // The harness reads HEADED when it loads.
  if (opts.headed) process.env.HEADED = '1';
  const { launch, PROFILE, RESUME_PDF } = await import('../tests/e2e/harness.mjs');
  const h = await launch();
  try {
    // The test profile and CV: the rules' ✓ and ✗ say what a fill would have for each field.
    const profileId = await h.setProfile(PROFILE);
    await h.bg(
      ([id, dataUrl]) =>
        globalThis.JTF.store.setDoc(id, 'resume', {
          name: 'Ada_Lovelace_CV.pdf',
          type: 'application/pdf',
          size: 60,
          dataUrl,
        }),
      [profileId, RESUME_PDF],
    );
    const url = /^[a-z][\w+.-]*:/i.test(opts.target)
      ? opts.target
      : h.url(opts.target.replace(/^(\.\/)?tests\/fixtures\//, ''));
    const page = await h.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await settle(page, opts.wait);
    const tabId = await tabOf(h, page);
    if (tabId == null) throw new Error(`No tab for ${page.url()}`);
    const call = (type, msg) =>
      h.bg(([t, m]) => globalThis.JTFBackground.handlers[t](m, {}), [type, { tabId, ...msg }]);
    if (opts.fill) {
      const r = await h.bg((id) => globalThis.JTFBackground.fillTab(id), tabId);
      if (r && r.error) throw new Error(`Fill: ${r.error}`);
      console.error(`Filled ${r.filled} of ${r.detected} recognised fields.`);
      await settle(page, 500);
    }
    const ask = { values: opts.values, maxChars: opts.maxChars || undefined };
    let res;
    if (opts.screenshot) {
      // Marks on (from a map made now: the screenshot and the text show the same refs), screenshot, marks off.
      res = await call('jtf:pagemap-marks', { ...ask, on: true });
      if (res.error) throw new Error(res.error);
      await page.screenshot({ path: path.resolve(opts.screenshot), fullPage: true });
      await call('jtf:pagemap-marks', { on: false });
      console.error(`Screenshot with ${res.marks} refs: ${opts.screenshot}`);
    } else {
      res = await call('jtf:pagemap', ask);
      if (res.error) throw new Error(res.error);
    }
    if (opts.json) {
      await writeFile(path.resolve(opts.json), JSON.stringify(res.map, null, 2) + '\n');
      console.error(`Map: ${opts.json}`);
    }
    process.stdout.write(res.text + '\n');
  } finally {
    await h.close();
  }
}

/** The tab showing the page: by its address, else the newest tab (a page that changed its address as it loaded). */
function tabOf(h, page) {
  return h.bg(async (u) => {
    const tabs = await globalThis.JTF.api.tabs.query({});
    const hit = tabs.filter((t) => t.url === u).pop() || tabs.sort((a, b) => a.id - b.id).pop();
    return hit ? hit.id : null;
  }, page.url());
}

main().catch((err) => {
  console.error(String((err && err.stack) || err));
  process.exit(1);
});
