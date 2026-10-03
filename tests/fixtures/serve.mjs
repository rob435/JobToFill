// Static server for the fixture pages. Used by the E2E tests and by `npm run demo`
// to try the extension by hand: open http://localhost:8080/ after loading it unpacked.
import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const dir = path.dirname(fileURLToPath(import.meta.url));

// build/<name>.js is src/<name>.jsx bundled on first request (pages that use real widget libraries: React, Vue,
// jQuery plugins). A stylesheet imported there is its text (`import css from 'select2/dist/css/select2.css'`, then
// put into a <style>), and the fonts and images it names are inlined.
const bundles = new Map();
const require = createRequire(import.meta.url);
function bundle(name) {
  if (!bundles.has(name)) {
    bundles.set(
      name,
      build({
        entryPoints: [path.join(dir, 'src', name + '.jsx')],
        bundle: true,
        write: false,
        format: 'iife',
        jsx: 'automatic',
        define: {
          'process.env.NODE_ENV': '"production"',
          __VUE_OPTIONS_API__: 'true',
          __VUE_PROD_DEVTOOLS__: 'false',
          __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
        },
        // Vue templates written as strings need the build that compiles them.
        alias: { vue: require.resolve('vue/dist/vue.esm-bundler.js') },
        loader: {
          '.css': 'text',
          '.woff': 'dataurl',
          '.woff2': 'dataurl',
          '.ttf': 'dataurl',
          '.eot': 'dataurl',
          '.png': 'dataurl',
          '.gif': 'dataurl',
          '.svg': 'dataurl',
        },
        minify: true,
        logLevel: 'silent',
      }).then((r) => r.outputFiles[0].contents),
    );
  }
  return bundles.get(name);
}
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.pdf': 'application/pdf',
};

export function serve(port = 0) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const file = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    if (file.includes('..')) {
      res.writeHead(400).end();
      return;
    }
    try {
      if (file === 'index.html') {
        const pages = (await readdir(dir)).filter((f) => f.endsWith('.html'));
        res.writeHead(200, { 'content-type': TYPES['.html'] });
        res.end(
          `<!doctype html><title>JobToFill demo forms</title><style>body{font:15px system-ui;margin:40px}</style><h1>JobToFill demo forms</h1><ul>${pages.map((p) => `<li><a href="${p}">${p}</a></li>`).join('')}</ul>`,
        );
        return;
      }
      const built = file.match(/^build\/([\w-]+)\.js$/);
      const body = built ? await bundle(built[1]) : await readFile(path.join(dir, file));
      const headers = { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' };
      // csp-*.html pages get a strict policy, like many real application sites.
      if (file.startsWith('csp-'))
        headers['content-security-policy'] =
          "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'";
      res.writeHead(200, headers);
      res.end(body);
    } catch (err) {
      res.writeHead(404).end('Not found');
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = +process.env.PORT || 8080;
  await serve(port);
  console.log(`Demo forms on http://localhost:${port}/`);
}
