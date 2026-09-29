// A development harness for the window: serves the built renderer
// (out/renderer) in a browser, with the app's real core services behind it,
// paying the mock portal from the tests (test/mock-portal.ts) in front of a
// node in this process. Nothing here is part of the app; the app's window
// talks to the core only through the preload.
//
//   npx electron-vite build && node scripts/ui-harness.ts [--seed]
//   then open http://127.0.0.1:5199/
//
// --seed adds two registered agents, a wallet, a public room, and a DM.

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { Catalog } from '../src/core/catalog.ts';
import { Services } from '../src/app/services.ts';
import { createHandlers } from '../src/app/handlers.ts';
import { startMockPortal } from '../test/mock-portal.ts';
import type { Channel } from '../src/shared/api.ts';
import { seed } from './seed.ts';

const PORT = 5199;
const root = join(import.meta.dirname, '..', 'out', 'renderer');
const portal = await startMockPortal();
let version = 0;
const services = new Services({
  dbPath: join(mkdtempSync(join(tmpdir(), 'meadow-ui-')), 'meadow.db'),
  masterKey: randomBytes(32),
  version: '0.0.1-harness',
  changed: () => version++,
  catalog: new Catalog({ url: portal.catalogUrl }),
});
await services.catalog.refresh();
const handle = createHandlers(services, {
  execPath: 'C:/Program Files/Meadow/Meadow.exe',
  bridgeScript: 'C:/Program Files/Meadow/resources/app/out/main/bridge.js',
  copy: (text) => console.log('copy:', text.length > 60 ? text.slice(0, 60) + '…' : text),
  openExternal: (url) => console.log('open:', url),
  // Never the real Claude Desktop settings.
  claudeConfigPath: join(mkdtempSync(join(tmpdir(), 'meadow-ui-claude-')), 'claude_desktop_config.json'),
});

if (process.argv.includes('--seed')) console.log('seeded', await seed(services));

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const SHIM = `
window.meadow = new Proxy({}, { get: (_t, name) => {
  if (name === 'onChanged') return (fn) => { let v = -1; const t = setInterval(async () => {
    const n = await (await fetch('/version')).json(); if (v !== -1 && n !== v) fn(); v = n; }, 1000); return () => clearInterval(t); };
  return async (arg) => { const r = await (await fetch('/ipc/' + name, { method: 'POST', body: JSON.stringify(arg ?? {}) })).json();
    if (r && typeof r === 'object' && 'error' in r && Object.keys(r).length === 1) throw new Error(r.error); return r; };
}});`;

http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  if (url.pathname === '/version') return res.end(JSON.stringify(version));
  if (url.pathname.startsWith('/ipc/') && req.method === 'POST') {
    let body = '';
    for await (const c of req) body += c;
    const out = await handle(url.pathname.slice(5) as Channel, JSON.parse(body || '{}'));
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify(out));
  }
  if (url.pathname === '/shim.js') {
    res.setHeader('content-type', 'text/javascript');
    return res.end(SHIM);
  }
  const file = normalize(join(root, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(root) || !existsSync(file)) {
    res.statusCode = 404;
    return res.end('not found');
  }
  let data: Buffer | string = readFileSync(file);
  if (file.endsWith('index.html')) {
    // The built page's CSP allows no connections; the harness talks over HTTP, so it swaps in its own.
    data = data.toString('utf8').replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '').replace('<head>', '<head><script src="/shim.js"></script>').replace(/(src|href)="\.\//g, '$1="/');
  }
  res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
  res.end(data);
}).listen(PORT, '127.0.0.1', () => console.log(`window harness on http://127.0.0.1:${PORT}/`));
