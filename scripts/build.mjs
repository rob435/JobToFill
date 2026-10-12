// Packages the extension:
//   dist/chrome/          + dist/jobtofill-chrome-<version>.zip           the Chrome Web Store (Edge Add-ons too)
//   dist/chrome-unpacked/ + dist/jobtofill-chrome-unpacked-<version>.zip  Load unpacked in Chrome, Edge, Brave, Opera,
//                                                                         Vivaldi, Arc (the release's jobtofill-chrome.zip)
//   dist/firefox/         + dist/jobtofill-firefox-<version>.zip          Firefox 142+ (desktop and Android), for signing
//
// extension/manifest.json already works unpacked in both browsers; each copy drops the keys the other browser needs,
// so neither shows warnings. "key" pins the extension ID of an unpacked install, so a folder moved, replaced by a
// newer release or loaded again keeps your data: the unpacked copy keeps it, the store copies drop it (the stores
// assign their own ID; Firefox goes by browser_specific_settings.gecko.id).
// Usage: npm run build
// RELEASE_VERSION (set by scripts/release.mjs) gives every copy the release's version, 1.2.0 -> 1.2.0.18;
// FIREFOX_UPDATE_URL the address Firefox checks for updates of a self-distributed install.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import webExt from 'web-ext';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'extension');
const dist = path.join(root, 'dist');
const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'));

/** Chromium's manifest: the service worker, without Firefox's settings. */
function chromium(m) {
  m.background = { service_worker: m.background.service_worker };
  delete m.browser_specific_settings;
}

const TARGETS = {
  chrome(m) {
    chromium(m);
    delete m.key;
  },
  'chrome-unpacked': chromium,
  firefox(m) {
    delete m.key;
    m.background = { scripts: m.background.scripts };
    // Firefox's background page has a DOM of its own; offscreen documents are a Chromium API.
    m.permissions = m.permissions.filter((p) => p !== 'offscreen');
    delete m.minimum_chrome_version;
    if (process.env.FIREFOX_UPDATE_URL) m.browser_specific_settings.gecko.update_url = process.env.FIREFOX_UPDATE_URL;
  },
};

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

for (const [name, transform] of Object.entries(TARGETS)) {
  const dir = path.join(dist, name);
  await cp(source, dir, { recursive: true });
  const m = structuredClone(manifest);
  if (process.env.RELEASE_VERSION) m.version = process.env.RELEASE_VERSION;
  transform(m);
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
  const filename = `jobtofill-${name}-${m.version}.zip`;
  await webExt.cmd.build(
    { sourceDir: dir, artifactsDir: dist, filename, overwriteDest: true },
    { shouldExitProgram: false },
  );
  console.log(`dist/${filename}`);
}
