// Static server for the fixture pages. Used by the E2E tests and by `npm run demo`
// to try the extension by hand: open http://localhost:8080/ after loading it unpacked.
import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.pdf': 'application/pdf' };

export function serve(port = 0) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let file = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    if (file.includes('..')) { res.writeHead(400).end(); return; }
    try {
      if (file === 'index.html') {
        const pages = (await readdir(dir)).filter((f) => f.endsWith('.html'));
        res.writeHead(200, { 'content-type': TYPES['.html'] });
        res.end(`<!doctype html><title>JobToFill demo forms</title><style>body{font:15px system-ui;margin:40px}</style><h1>JobToFill demo forms</h1><ul>${pages.map((p) => `<li><a href="${p}">${p}</a></li>`).join('')}</ul>`);
        return;
      }
      const body = await readFile(path.join(dir, file));
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
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
