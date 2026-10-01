// Packages the extension for distribution:
//   dist/jobtofill-chrome-<version>.zip   Chrome, Edge, Brave, Opera, Arc (Manifest V3, service worker)
//   dist/jobtofill-firefox-<version>.zip  Firefox 121+ (background scripts instead of a service worker)
// Usage: npm run build    (needs the `zip` command)
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'extension');
const dist = path.join(root, 'dist');
const manifest = JSON.parse(await readFile(path.join(src, 'manifest.json'), 'utf8'));

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

async function pack(name, transform) {
  const dir = path.join(dist, name);
  await cp(src, dir, { recursive: true });
  const m = transform(JSON.parse(JSON.stringify(manifest)));
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
  const zip = path.join(dist, `jobtofill-${name}-${m.version}.zip`);
  execFileSync('zip', ['-qr', zip, '.'], { cwd: dir });
  console.log(path.relative(root, zip));
}

await pack('chrome', (m) => m);

// Firefox runs the same code as a non-persistent background page, so the libraries the
// service worker pulls in with importScripts() are listed as background scripts instead.
const background = await readFile(path.join(src, 'background.js'), 'utf8');
const libs = [...background.match(/importScripts\(([^)]*)\)/)[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);

await pack('firefox', (m) => {
  m.background = { scripts: [...libs, 'background.js'] };
  delete m.minimum_chrome_version;
  m.browser_specific_settings = { gecko: { id: 'jobtofill@local', strict_min_version: '121.0' } };
  return m;
});
