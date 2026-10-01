// Packages the extension for the stores:
//   dist/chrome/   + dist/jobtofill-chrome-<version>.zip    Chrome, Edge, Brave, Opera, Vivaldi, Arc
//   dist/firefox/  + dist/jobtofill-firefox-<version>.zip   Firefox 142+ (desktop and Android)
//
// extension/manifest.json already works unpacked in both browsers; each store copy just drops
// the keys the other browser needs so store validators report no warnings. "key" only pins the
// extension ID of the unpacked folder (so moving it keeps your data); the stores assign their own.
// Usage: npm run build
// FIREFOX_VERSION and FIREFOX_UPDATE_URL (set by scripts/firefox-release.mjs) give the Firefox copy
// its own version and the address Firefox checks for updates of a self-distributed install.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import webExt from 'web-ext';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'extension');
const dist = path.join(root, 'dist');
const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'));

const TARGETS = {
  chrome(m) {
    delete m.key;
    m.background = { service_worker: m.background.service_worker };
    delete m.browser_specific_settings;
  },
  firefox(m) {
    delete m.key;
    m.background = { scripts: m.background.scripts };
    delete m.minimum_chrome_version;
    if (process.env.FIREFOX_VERSION) m.version = process.env.FIREFOX_VERSION;
    if (process.env.FIREFOX_UPDATE_URL) m.browser_specific_settings.gecko.update_url = process.env.FIREFOX_UPDATE_URL;
  },
};

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

for (const [name, transform] of Object.entries(TARGETS)) {
  const dir = path.join(dist, name);
  await cp(source, dir, { recursive: true });
  const m = structuredClone(manifest);
  transform(m);
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
  const filename = `jobtofill-${name}-${m.version}.zip`;
  await webExt.cmd.build(
    { sourceDir: dir, artifactsDir: dist, filename, overwriteDest: true },
    { shouldExitProgram: false },
  );
  console.log(`dist/${filename}`);
}
