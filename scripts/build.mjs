// Packages the extension for the stores:
//   dist/chrome/   + dist/jobtofill-chrome-<version>.zip    Chrome, Edge, Brave, Opera, Vivaldi, Arc
//   dist/firefox/  + dist/jobtofill-firefox-<version>.zip   Firefox 142+ (desktop and Android)
//
// extension/manifest.json already works unpacked in both browsers; each store copy just drops
// the keys the other browser needs so store validators report no warnings.
// Usage: npm run build
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
    m.background = { service_worker: m.background.service_worker };
    delete m.browser_specific_settings;
  },
  firefox(m) {
    m.background = { scripts: m.background.scripts };
    delete m.minimum_chrome_version;
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
