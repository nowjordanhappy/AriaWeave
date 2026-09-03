// Fixtures must be served over http, not file://.
//
// Under file://, every file is a unique opaque origin, so the service worker's
// fetch() of an image src is blocked ("Unsafe attempt to load URL ... 'file:'
// URLs are treated as unique security origins"). loadImage() then returns null,
// every tier below T1 is skipped, and each element falls to the honest
// fallback with tier "none" — which reads as "the model is bad" when the real
// cause is that no image ever reached it.
//
// Node's http + fs. No dependency for what a few lines do.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
export const PORT = Number(process.env.ARIAWEAVE_PORT || 5187);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.json': 'application/json', '.css': 'text/css', '.js': 'text/javascript',
};

createServer(async (req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\/+/, '');
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(PORT, () => console.log(`fixtures on http://localhost:${PORT}`));
