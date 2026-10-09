// Saves each corpus form's stylesheets beside its page (forms/<id>/styles.css), so that a page read again (--pages)
// hides what the site hid: a widget's own <select> under its menu (Pinpoint's "hide-at-sm-block"), a closed dialog, a
// cookie banner's switches. Without them every such control reads as a field of the form.
//
//   node tests/bench/styles.mjs [--corpus DIR] [--only 88-menzies,53-aab-group] [--force]
//
// It fetches the sheets the saved page links to (and what they @import), as the sites serve them now, and keeps only
// the rules that apply to something on that page (Phenom's 59 MB for BCG come to a few hundred KB): read in Chromium,
// a rule stays when its selector matches an element, hover and focus states and pseudo-elements included, along with
// the @media, @supports, @layer and @container around it. Fonts, images and animations stay out. Run it once for a new
// form: the corpus keeps what it wrote.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { savedPage } from './saved.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const corpus = path.resolve(option('--corpus') || process.env.JTF_BENCH || path.join(here, '../../../JobToFill-bench'));
const only = option('--only') ? new Set(option('--only').split(',')) : null;
const force = args.includes('--force');

/** An attribute of a tag's source, quoted or not. */
const attr = (tag, name) =>
  (tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')) || [])
    .slice(1)
    .find((v) => v != null);

/** The stylesheets a page links to, in order: [{ href, media }]. */
function linked(html, base) {
  const out = [];
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/^stylesheet$/i.test((attr(tag, 'rel') || '').trim()) || !attr(tag, 'href')) continue;
    try {
      out.push({ href: new URL(attr(tag, 'href').replace(/&amp;/g, '&'), base).href, media: attr(tag, 'media') || '' });
    } catch (err) {
      /* not a URL */
    }
  }
  return out;
}

/** A sheet's text with its @imports put in place (one level deep is all the corpus needs) and no @charset. */
async function sheet(href, depth = 0) {
  const res = await fetch(href, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let css = (await res.text()).replace(/@charset\s+[^;]+;/gi, '');
  if (depth > 0) return css;
  const imports = [...css.matchAll(/@import\s+(?:url\()?\s*["']?([^"')\s;]+)["']?\s*\)?[^;]*;/gi)];
  for (const [rule, url] of imports) {
    const inner = await sheet(new URL(url, href).href, depth + 1).catch((err) => `/* ${url}: ${err.message} */`);
    css = css.replace(rule, () => inner);
  }
  return css;
}

/**
 * In the page: the rules of its <style id="jtf-bench-styles"> that apply to something there, as CSS text. A selector
 * is tried without its states and pseudo-elements ("a:hover::after" as "a"); one the browser can't read is tried a
 * part at a time.
 */
function pruneInPage() {
  const STATES =
    /::?(hover|focus|focus-within|focus-visible|active|visited|link|any-link|target|before|after|placeholder|selection|marker|first-line|first-letter|backdrop|file-selector-button|-webkit-[\w-]+|-moz-[\w-]+|-ms-[\w-]+)(\([^()]*\))?/g;
  const found = (sel) => {
    try {
      return !!document.querySelector(sel.replace(STATES, '').trim() || '*');
    } catch (err) {
      return null;
    }
  };
  const applies = (sel) => {
    const whole = found(sel);
    return whole != null ? whole : sel.split(',').some((part) => found(part));
  };
  // By constructor name: a browser without one of these kinds of rule has no constructor to compare against.
  const keep = (rules) => {
    const out = [];
    for (const rule of rules) {
      const kind = rule.constructor.name;
      if (kind === 'CSSStyleRule') {
        if (applies(rule.selectorText)) out.push(rule.cssText);
      } else if (kind === 'CSSLayerStatementRule' || kind === 'CSSPropertyRule') out.push(rule.cssText);
      else if (rule.cssRules && rule.cssRules.length) {
        const head = {
          CSSMediaRule: () => `@media ${rule.media.mediaText}`,
          CSSSupportsRule: () => `@supports ${rule.conditionText}`,
          CSSLayerBlockRule: () => `@layer ${rule.name}`,
          CSSContainerRule: () => `@container ${rule.conditionText}`,
        }[kind];
        const inner = head ? keep(rule.cssRules) : [];
        if (inner.length) out.push(`${head()} {\n${inner.join('\n')}\n}`);
      }
    }
    return out;
  };
  const el = document.getElementById('jtf-bench-styles');
  return el && el.sheet ? keep(el.sheet.cssRules).join('\n') : '';
}

const ids = readdirSync(path.join(corpus, 'forms'))
  .filter((id) => !only || only.has(id))
  .sort();
const { chromium } = await import('playwright');
const browser = await chromium.launch({ channel: 'chromium', headless: true });
const context = await browser.newContext();
const pages = new Map();
await context.route('**/*', (route) => {
  const body = pages.get(route.request().url());
  return body != null ? route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body }) : route.abort(); // nothing from the sites: the sheets are inline, fonts and images stay out
});
for (const id of ids) {
  const dir = path.join(corpus, 'forms', id);
  const file = path.join(dir, 'form.html');
  const out = path.join(dir, 'styles.css');
  if (!existsSync(file) || (existsSync(out) && !force)) continue;
  const meta = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const html = readFileSync(file, 'utf8');
  const base = attr((html.match(/<base\b[^>]*>/i) || [''])[0], 'href') || meta.formUrl || meta.url;
  const sources = [];
  const parts = [];
  for (const { href, media } of linked(html, base)) {
    try {
      const css = await sheet(href);
      parts.push(media && !/^(all|screen)$/i.test(media.trim()) ? `@media ${media} {\n${css}\n}` : css);
      sources.push(href);
    } catch (err) {
      sources.push(`${href} (not fetched: ${err.message})`);
    }
  }
  const url = `https://bench.test/${id}/`;
  pages.set(url, savedPage(html, parts.join('\n')));
  const page = await context.newPage();
  await page.goto(url);
  const kept = await page.evaluate(pruneInPage);
  await page.close();
  pages.delete(url);
  const head = `/* The rules of these stylesheets that apply to form.html (tests/bench/styles.mjs in JobToFill, ${new Date()
    .toISOString()
    .slice(0, 10)}):\n${sources.map((s) => `   ${s}`).join('\n')}\n*/\n`;
  writeFileSync(out, head + kept + '\n');
  const fetched = sources.filter((s) => !/\(not fetched/.test(s)).length;
  console.log(`${id}: ${fetched} of ${sources.length} stylesheets, ${Math.round(kept.length / 1000)} KB kept`);
}
await browser.close();
