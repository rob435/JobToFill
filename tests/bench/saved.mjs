// A corpus form's saved page as the benchmark loads it (run.mjs --pages, styles.mjs).

/**
 * The saved page with nothing of the site's that could run (scripts, inline handlers) and, when the corpus has its
 * stylesheets (`css`, from styles.mjs), those in place of the links to the site's: the widgets' finished markup,
 * hidden where the site hid it.
 */
export function savedPage(html, css) {
  let page = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/\son\w+="[^"]*"/gi, '');
  if (css == null) return page;
  page = page.replace(/<link\b[^>]*\brel\s*=\s*["']?stylesheet\b[^>]*>/gi, '');
  const style = `<style id="jtf-bench-styles">\n${css}\n</style>`;
  // First in <head>, where the links mostly were: the page's own <style> blocks still come after them.
  return /<head\b[^>]*>/i.test(page) ? page.replace(/<head\b[^>]*>/i, (head) => head + style) : style + page;
}
