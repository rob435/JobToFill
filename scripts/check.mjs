// Static checks: every script parses, the manifest is valid, and every file it
// (or an HTML page) references exists. Usage: npm run lint
import { readFile, readdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ext = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const problems = [];

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

const exists = async (p) =>
  stat(p).then(
    () => true,
    () => false,
  );
const files = await walk(ext);

for (const f of files.filter((x) => x.endsWith('.js'))) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (err) {
    problems.push(`${path.relative(ext, f)}: ${err.stderr.toString().split('\n').slice(0, 4).join(' ')}`);
  }
}

const manifest = JSON.parse(await readFile(path.join(ext, 'manifest.json'), 'utf8'));
const referenced = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_ui.page,
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
];
const bg = await readFile(path.join(ext, manifest.background.service_worker), 'utf8');
for (const m of bg.matchAll(/'((?:lib|content)\/[\w.-]+\.js)'/g)) referenced.push(m[1]);

// Chromium loads the background libraries with importScripts(), Firefox from manifest "background.scripts":
// the two lists must stay identical.
const imported = [...bg.match(/importScripts\(([^)]*)\)/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
const listed = manifest.background.scripts || [];
if (JSON.stringify([...imported, manifest.background.service_worker]) !== JSON.stringify(listed)) {
  problems.push(
    `manifest background.scripts ${JSON.stringify(listed)} does not match importScripts() in background.js`,
  );
}
for (const f of referenced)
  if (!(await exists(path.join(ext, f)))) problems.push(`missing file referenced by manifest/background: ${f}`);

for (const html of files.filter((x) => x.endsWith('.html'))) {
  const src = await readFile(html, 'utf8');
  for (const m of src.matchAll(/(?:src|href)="([^"#:]+)"/g)) {
    const target = path.resolve(path.dirname(html), m[1]);
    if (!(await exists(target))) problems.push(`${path.relative(ext, html)} references missing ${m[1]}`);
  }
  if (/<script>(?!\s*<\/script>)/.test(src) || /\son[a-z]+="/.test(src))
    problems.push(`${path.relative(ext, html)}: inline script (blocked by the extension CSP)`);
}

if (problems.length) {
  console.error(problems.map((p) => '✗ ' + p).join('\n'));
  process.exit(1);
}
console.log(`✓ ${files.length} files checked, manifest v${manifest.version} OK`);
