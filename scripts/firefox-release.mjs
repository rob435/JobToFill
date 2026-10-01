// Signs the Firefox build with Mozilla as an unlisted add-on (signed for you, not listed on
// addons.mozilla.org) so regular Firefox keeps it installed, and prepares the GitHub release that
// Firefox then updates itself from. Run by .github/workflows/firefox.yml; also works locally:
//
//   RELEASE_NUMBER=7 WEB_EXT_API_KEY=user:… WEB_EXT_API_SECRET=… npm run sign:firefox [-- --publish]
//
// Mozilla signs each version once and Firefox only updates to a higher one, so the add-on version is
// the manifest version plus RELEASE_NUMBER (1.1.0 -> 1.1.0.7). Output in dist/release/: jobtofill.xpi
// and updates.json. --publish creates the GitHub release with the `gh` CLI.
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import webExt from 'web-ext';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const publish = process.argv.includes('--publish');

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

/** owner/repo, from GitHub Actions or the "origin" remote. */
function repository() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root }).toString().trim();
  const m = url.match(/github\.com[:/]+([^/]+\/[^/]+?)(?:\.git)?$/);
  if (!m) fail(`The "origin" remote (${url}) is not a GitHub repository; set GITHUB_REPOSITORY=owner/repo.`);
  return m[1];
}

const number = process.env.RELEASE_NUMBER || '';
if (!/^\d{1,9}$/.test(number)) fail('Set RELEASE_NUMBER to a whole number, higher than the last release.');
// Copied credentials often carry a stray space or line break, which breaks the signature.
const apiKey = (process.env.WEB_EXT_API_KEY || '').trim();
const apiSecret = (process.env.WEB_EXT_API_SECRET || '').trim();
if (!apiKey || !apiSecret)
  fail(
    'Set WEB_EXT_API_KEY and WEB_EXT_API_SECRET to your addons.mozilla.org API credentials ' +
      '(https://addons.mozilla.org/developers/addon/api/key/).',
  );

const manifest = JSON.parse(await readFile(path.join(root, 'extension', 'manifest.json'), 'utf8'));
const addonId = manifest.browser_specific_settings.gecko.id;
const repo = repository();
const version = `${manifest.version}.${number}`;
const tag = `firefox-v${version}`;
const updateUrl = `https://github.com/${repo}/releases/latest/download/updates.json`;
const xpiUrl = `https://github.com/${repo}/releases/download/${tag}/jobtofill.xpi`;

// 1. The store builds, with this version and the address Firefox checks for updates.
execFileSync(process.execPath, [path.join(root, 'scripts', 'build.mjs')], {
  stdio: 'inherit',
  env: { ...process.env, FIREFOX_VERSION: version, FIREFOX_UPDATE_URL: updateUrl },
});

// 2. Mozilla's signature. Unlisted add-ons are checked automatically, usually within a few minutes.
const signedDir = path.join(dist, 'signed');
await rm(signedDir, { recursive: true, force: true });
const result = await webExt.cmd
  .sign(
    {
      sourceDir: path.join(dist, 'firefox'),
      artifactsDir: signedDir,
      apiKey,
      apiSecret,
      channel: 'unlisted',
      amoBaseUrl: 'https://addons.mozilla.org/api/v5/',
      timeout: 300000,
      approvalTimeout: 1800000,
      webextVersion: 'jobtofill-release',
    },
    { shouldExitProgram: false },
  )
  .catch((err) =>
    fail(
      `Mozilla didn't sign it: ${err.message}` +
        (/decoding signature/i.test(err.message)
          ? '\nMozilla knows the key (JWT issuer) but not the secret: copy the JWT secret into AMO_API_SECRET again.'
          : /Unauthorized|JWT/.test(err.message)
            ? '\nCheck the API credentials (AMO_API_KEY / AMO_API_SECRET).'
            : ''),
    ),
  );
const signed = (result.downloadedFiles || []).find((f) => f.endsWith('.xpi'));
if (!signed) fail('Mozilla did not return a signed file.');

// 3. The release files: a fixed name for the .xpi, and the update manifest pointing at it.
const releaseDir = path.join(dist, 'release');
await rm(releaseDir, { recursive: true, force: true });
await mkdir(releaseDir, { recursive: true });
await copyFile(path.isAbsolute(signed) ? signed : path.join(signedDir, signed), path.join(releaseDir, 'jobtofill.xpi'));
const updates = { addons: { [addonId]: { updates: [{ version, update_link: xpiUrl }] } } };
await writeFile(path.join(releaseDir, 'updates.json'), JSON.stringify(updates, null, 2) + '\n');
console.log(`✓ Signed JobToFill ${version}: dist/release/jobtofill.xpi`);

// 4. The GitHub release. Marked "latest", so updates.json above always resolves to the newest one.
if (publish) {
  const notes = [
    `JobToFill ${version} for Firefox, signed by Mozilla.`,
    '',
    `Install: download **jobtofill.xpi** below, then in Firefox open \`about:addons\`, click ⚙ › **Install Add-on From File…** and choose it. Firefox keeps it installed and updates it from here.`,
  ].join('\n');
  execFileSync(
    'gh',
    [
      'release',
      'create',
      tag,
      path.join(releaseDir, 'jobtofill.xpi'),
      path.join(releaseDir, 'updates.json'),
      '--title',
      `JobToFill ${version} for Firefox`,
      '--notes',
      notes,
      '--latest',
      ...(process.env.GITHUB_SHA ? ['--target', process.env.GITHUB_SHA] : []),
    ],
    { stdio: 'inherit', cwd: root },
  );
  console.log(`✓ Published https://github.com/${repo}/releases/tag/${tag}`);
}
