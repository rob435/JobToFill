// Renders extension/icons/icon{16,32,48,128}.png from the SVG below using Playwright's Chromium.
// Usage: npm run icons
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'extension', 'icons');

// A form card with filled lines and a spark: "fill this form for me".
const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#8b6cff"/>
      <stop offset="1" stop-color="#4f3bd6"/>
    </linearGradient>
  </defs>
  <rect x="4" y="4" width="120" height="120" rx="28" fill="url(#bg)"/>
  <rect x="26" y="30" width="56" height="12" rx="6" fill="#fff"/>
  <rect x="26" y="58" width="76" height="12" rx="6" fill="#fff" opacity=".92"/>
  <rect x="26" y="86" width="40" height="12" rx="6" fill="#fff" opacity=".85"/>
  <path d="M100 18 L106 32 L120 38 L106 44 L100 58 L94 44 L80 38 L94 32 Z" fill="#ffd166"/>
</svg>`;

const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  await writeFile(path.join(out, `icon${size}.png`), png);
  console.log(`icon${size}.png`);
}
await browser.close();
