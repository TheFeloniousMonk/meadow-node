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
// --update shows the update banner as a Scoop install would (§16.3); add --update-download for a Mac's.

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, normalize } from 'node:path';
import { Catalog } from '../src/core/catalog.ts';
import { Services } from '../src/app/services.ts';
import { createHandlers } from '../src/app/handlers.ts';
import { startMockPortal } from '../test/mock-portal.ts';
import type { Channel } from '../src/shared/api.ts';
import { seed } from './seed.ts';
import { Mover } from '../src/core/move.ts';
import { MOCK_COW, MOCK_RPC, mockBase } from '../test/mock-base.ts';
import { createPublicServer } from '../src/server/public.ts';

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
const files = mkdtempSync(join(tmpdir(), 'meadow-ui-files-'));
let lastSaved: string | null = null;
const handle = createHandlers(services, {
  execPath: 'C:/Program Files/Meadow/Meadow.exe',
  bridgeScript: 'C:/Program Files/Meadow/resources/app/out/main/bridge.js',
  copy: (text) => console.log('copy:', text.length > 60 ? text.slice(0, 60) + '…' : text),
  openExternal: (url) => console.log('open:', url),
  // Never the real Claude Desktop settings.
  claudeConfigPath: join(mkdtempSync(join(tmpdir(), 'meadow-ui-claude-')), 'claude_desktop_config.json'),
  // The harness writes a temp file, not Claude's own, so a Claude open on this computer does not matter here.
  claudeRunning: async () => process.argv.includes('--claude-open'),
  // Files go to a temporary folder; opening picks the last backup saved there.
  saveText: async (name, text) => {
    const path = join(files, name);
    writeFileSync(path, text);
    console.log('saved:', path);
    return path;
  },
  saveFile: async (name, data) => {
    lastSaved = join(files, name);
    writeFileSync(lastSaved, data);
    console.log('saved:', lastSaved);
    return lastSaved;
  },
  openFile: async () => (lastSaved ? { name: basename(lastSaved), data: readFileSync(lastSaved) } : null),
  // The system dialog, answered here: yes, unless --move-no.
  confirmMove: async ({ message, detail }) => {
    console.log('confirm:', message, detail.replace(/\s+/g, ' '));
    return !process.argv.includes('--move-no');
  },
});

// Moving money (§16.9.1) against a mock Base and CoW, never the real ones: every wallet
// starts with $4.20 and no ETH, and each step waits a second and a half so the window's progress shows.
const base = mockBase();
const baseFetch = base.fetchImpl;
(services as any).mover = new Mover({
  wallets: services.wallets, db: services.db, rpc: { rpc: MOCK_RPC }, cowApi: MOCK_COW,
  fetchImpl: (async (url: string, init?: RequestInit) => {
    for (const w of services.wallets.list()) if (!base.chain.usdc.has(w.address.toLowerCase())) base.chain.usdc.set(w.address.toLowerCase(), 4_200_000n);
    return baseFetch(url, init);
  }) as typeof fetch,
  sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 1500))),
});

const seeded = process.argv.includes('--seed') ? await seed(services) : null;
if (seeded) console.log('seeded', seeded);
// --busy (with --seed): 40 more messages in the garden club, then a new one every 4 seconds, to see the Inbox scroll.
if (seeded && process.argv.includes('--busy')) {
  const { chappy, scout, room } = seeded;
  for (const w of services.wallets.list()) services.wallets.setBudget(w.id, '50.00'); // the mock portal's money
  for (let i = 1; i <= 40; i++) await services.core.send(scout, room, `Filler message ${i} of 40.`);
  await services.core.sync(chappy);
  let n = 0;
  setInterval(async () => {
    await services.core.send(scout, room, `A new message (${++n}).`);
    await services.core.sync(chappy);
    version++;
  }, 4000);
}
if (process.argv.includes('--update')) services.update.available = { version: '9.9.9', url: 'https://github.com/TheFeloniousMonk/meadow-node/releases/tag/app-v9.9.9', command: process.argv.includes('--update-download') ? null : 'scoop update meadow', action: process.argv.includes('--update-download') ? 'download' : 'scoop', asset: process.argv.includes('--update-download') ? 'Meadow-mac-arm64.zip' : null };

// --chatgpt: a ChatGPT agent, and the tunneled interface on plain local HTTP (no tunnel), to act ChatGPT's part by hand.
if (process.argv.includes('--chatgpt')) {
  const w = services.wallets.list()[0]?.id ?? services.wallets.create('Everyday', '1.00').id;
  const { id } = services.core.createAgent('Chappy GPT');
  services.connections.set(id, 'chatgpt', 'Chappy GPT');
  services.wallets.assign(id, w);
  await services.core.register(id);
  let publicBase = '';
  const pub = createPublicServer({
    host: services.tools, oauth: services.oauth, version: 'harness', base: () => publicBase,
    agents: () => services.chatgptAgents(), onRequest: () => version++,
  });
  await new Promise<void>((r) => pub.listen(5198, '127.0.0.1', () => r()));
  publicBase = 'http://127.0.0.1:5198';
  console.log(`tunneled interface on ${publicBase}/chappy-gpt/mcp`);
}

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
