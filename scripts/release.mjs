// Makes a GitHub release people install from: the Firefox build signed by Mozilla as an unlisted add-on (signed for
// you, not listed on addons.mozilla.org), so regular Firefox keeps it installed and updates itself from the releases,
// and the Chrome build to unzip and load unpacked. Run by .github/workflows/release.yml (Actions › Release › Run
// workflow); also works locally:
//
//   WEB_EXT_API_KEY=user:… WEB_EXT_API_SECRET=… npm run release [-- --publish]
//   npm run release -- --dry-run      no credentials needed: builds, and prints the version and the release notes
//
// (npm run sign:firefox is the same script.) Mozilla signs each version once and Firefox only updates to a higher one,
// so the version is the manifest version plus a release number one higher than the last release's (1.2.0 ->
// 1.2.0.18), read from the repository's tags: v1.2.0.18, or firefox-v1.2.0.17 from before. RELEASE_NUMBER=<n> sets it
// instead, e.g. to step past a number Mozilla signed in a run that then failed to publish.
// Output in dist/release/: jobtofill.xpi, jobtofill-chrome.zip, updates.json (which every signed copy checks, at
// releases/latest/download/updates.json) and notes.md. --publish creates the release with the `gh` CLI, marked latest.
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import webExt from 'web-ext';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const dryRun = process.argv.includes('--dry-run');
const publish = process.argv.includes('--publish') && !dryRun;

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

/** git's output in this repository, or null when it fails (no network, a tag that isn't fetched). */
function git(...args) {
  try {
    // Never a password prompt: a repository that wants one fails, and RELEASE_NUMBER is asked for instead.
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    return execFileSync('git', args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/** owner/repo, from GitHub Actions or the "origin" remote. */
function repository() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const url = git('remote', 'get-url', 'origin') || '';
  const m = url.match(/github\.com[:/]+([^/]+\/[^/]+?)(?:\.git)?$/);
  if (!m) fail(`The "origin" remote (${url}) is not a GitHub repository; set GITHUB_REPOSITORY=owner/repo.`);
  return m[1];
}

/** Negative, zero or positive as version a is lower than, the same as or higher than b (1.2.0.9 < 1.2.0.10). */
function compare(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** The releases so far, oldest first, from the repository's tags on GitHub; null when they can't be read. */
function releases(repo) {
  const out = git('ls-remote', '--tags', `https://github.com/${repo}.git`);
  if (out == null) return null;
  return [...out.matchAll(/refs\/tags\/((?:firefox-)?v(\d+(?:\.\d+)+))$/gm)]
    .map((m) => ({ tag: m[1], version: m[2], number: +m[2].split('.').at(-1) }))
    .sort((a, b) => compare(a.version, b.version));
}

/** The subjects of the commits since the last release, newest first; null when its tag isn't in this clone. */
function changesSince(tag) {
  const out = git('log', '--no-merges', '--format=%s', `${tag}..${process.env.GITHUB_SHA || 'HEAD'}`);
  return out == null ? null : out.split('\n').filter(Boolean);
}

const manifest = JSON.parse(await readFile(path.join(root, 'extension', 'manifest.json'), 'utf8'));
if (manifest.version.split('.').length > 3)
  fail(`The manifest version (${manifest.version}) has four parts, leaving none for the release number.`);
const addonId = manifest.browser_specific_settings.gecko.id;
const repo = repository();

// 1. The version: one release number higher than the last release's, and above every release so far.
const past = releases(repo);
const last = past && past.at(-1);
const number =
  (process.env.RELEASE_NUMBER || '').trim() || (past ? String(Math.max(0, ...past.map((r) => r.number)) + 1) : '');
if (!past && !number)
  fail(`Couldn't read the release tags of github.com/${repo}: set RELEASE_NUMBER, one higher than the last release's.`);
// Chrome takes at most 65535 in each part of a version.
if (!/^\d{1,5}$/.test(number) || +number > 65535) fail('RELEASE_NUMBER must be a whole number up to 65535.');
const version = `${manifest.version}.${+number}`;
if (last && compare(version, last.version) <= 0)
  fail(
    `${version} isn't above the last release, ${last.version} (${last.tag}), and Firefox only updates to a higher ` +
      'version. Leave RELEASE_NUMBER empty to take the next number.',
  );
const tag = `v${version}`;
const updateUrl = `https://github.com/${repo}/releases/latest/download/updates.json`;
const xpiUrl = `https://github.com/${repo}/releases/download/${tag}/jobtofill.xpi`;

// Copied credentials often carry a stray space or line break, which breaks the signature.
const apiKey = (process.env.WEB_EXT_API_KEY || '').trim();
const apiSecret = (process.env.WEB_EXT_API_SECRET || '').trim();
if (!dryRun && (!apiKey || !apiSecret))
  fail(
    'Set WEB_EXT_API_KEY and WEB_EXT_API_SECRET to your addons.mozilla.org API credentials ' +
      '(https://addons.mozilla.org/developers/addon/api/key/), or try it with --dry-run.',
  );

// 2. The builds, with this version, and for Firefox the address it checks for updates.
execFileSync(process.execPath, [path.join(root, 'scripts', 'build.mjs')], {
  stdio: 'inherit',
  env: { ...process.env, RELEASE_VERSION: version, FIREFOX_UPDATE_URL: updateUrl },
});

// 3. Mozilla's signature. Unlisted add-ons are checked automatically, usually within a few minutes.
let signed = null;
const signedDir = path.join(dist, 'signed');
if (!dryRun) {
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
              : /already exists/i.test(err.message)
                ? `\nMozilla signed ${version} before, in a run that didn't publish it: run again with ` +
                  `RELEASE_NUMBER=${+number + 1} (the workflow's "Release number" box).`
                : ''),
      ),
    );
  signed = (result.downloadedFiles || []).find((f) => f.endsWith('.xpi'));
  if (!signed) fail('Mozilla did not return a signed file.');
}

// 4. The release files: fixed names, the update manifest pointing at this .xpi, and the notes.
const releaseDir = path.join(dist, 'release');
await rm(releaseDir, { recursive: true, force: true });
await mkdir(releaseDir, { recursive: true });
if (signed)
  await copyFile(
    path.isAbsolute(signed) ? signed : path.join(signedDir, signed),
    path.join(releaseDir, 'jobtofill.xpi'),
  );
await copyFile(
  path.join(dist, `jobtofill-chrome-unpacked-${version}.zip`),
  path.join(releaseDir, 'jobtofill-chrome.zip'),
);
const updates = { addons: { [addonId]: { updates: [{ version, update_link: xpiUrl }] } } };
await writeFile(path.join(releaseDir, 'updates.json'), JSON.stringify(updates, null, 2) + '\n');

/** The release notes: how to install from it, then the commits since the last release (their subjects say what changed). */
function releaseNotes() {
  const notes = [
    '## How to install',
    '',
    '**Firefox 142 or newer:** download **jobtofill.xpi** below, open `about:addons`, click ⚙ › **Install Add-on ' +
      'From File…** and choose it. Mozilla has signed it, so Firefox keeps it and updates it from here by itself.',
    '',
    '**Chrome, Edge, Brave, Opera, Vivaldi, Arc:** download **jobtofill-chrome.zip** below and unzip it into a ' +
      'folder you’ll keep. Open `chrome://extensions` (`edge://extensions` in Edge), turn on **Developer mode**, ' +
      'click **Load unpacked** and choose that folder. To update, unzip a newer release over the same folder and ' +
      'click the reload arrow on JobToFill’s card: your details stay.',
  ];
  if (!last) return notes.join('\n');
  const changes = changesSince(last.tag) || [];
  const listed = changes.slice(0, 25).map((s) => `- ${s.replace(/</g, '&lt;')}`);
  if (changes.length > listed.length) listed.push(`- …and ${changes.length - listed.length} more`);
  notes.push('', '## What’s new', '', ...listed, ...(listed.length ? [''] : []));
  notes.push(`Every change since ${last.version}: https://github.com/${repo}/compare/${last.tag}...${tag}`);
  return notes.join('\n');
}
const notes = releaseNotes();
await writeFile(path.join(releaseDir, 'notes.md'), notes + '\n');
console.log(
  `${dryRun ? '✓ Dry run, nothing signed' : `✓ Signed JobToFill ${version}`}: dist/release/ ` +
    `(${signed ? 'jobtofill.xpi, ' : ''}jobtofill-chrome.zip, updates.json, notes.md)`,
);

// 5. The GitHub release. Marked latest, so updates.json above is what every signed copy finds next.
const ghArgs = [
  'release',
  'create',
  tag,
  ...(signed ? [path.join(releaseDir, 'jobtofill.xpi')] : []),
  path.join(releaseDir, 'jobtofill-chrome.zip'),
  path.join(releaseDir, 'updates.json'),
  '--title',
  `JobToFill ${version}`,
  '--notes-file',
  path.join(releaseDir, 'notes.md'),
  '--latest',
  ...(process.env.GITHUB_SHA ? ['--target', process.env.GITHUB_SHA] : []),
];
if (publish) {
  execFileSync('gh', ghArgs, { stdio: 'inherit', cwd: root });
  console.log(`✓ Published https://github.com/${repo}/releases/tag/${tag}`);
} else {
  const shell = (a) => (a.startsWith(root) ? path.relative(root, a) : / /.test(a) ? `'${a}'` : a);
  console.log(`\nRelease ${tag}; --publish would run: gh ${ghArgs.map(shell).join(' ')}\n\n${notes}`);
}
