// Connection diagnostics (SPEC §16.17): what is recorded, the connection
// check's steps and verdict, Test connection through a stand-in tunnel, and
// the export, which must name no one and hold no secret.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Catalog } from '../src/core/catalog.ts';
import { Services } from '../src/app/services.ts';
import { createPublicServer } from '../src/server/public.ts';
import { handleMcp } from '../src/core/mcp.ts';
import { Diagnostics, KEEP_CALLS, scrub } from '../src/core/diagnostics.ts';
import { openDb } from '../src/core/db.ts';
import { connectionCheck, diagnosticsText, testConnection } from '../src/app/check.ts';
import { startMockPortal, type MockPortal } from './mock-portal.ts';

let portal: MockPortal;
before(async () => {
  portal = await startMockPortal();
});
after(() => portal.close());

const TUNNEL = 'https://meadow-test.example';
const REDIRECT = 'https://chatgpt.com/connector/oauth/cb123';

async function computer() {
  const catalog = new Catalog({ url: portal.catalogUrl });
  await catalog.refresh();
  const s = new Services({ dbPath: ':memory:', masterKey: randomBytes(32), version: 'test', changed: () => {}, catalog });
  const wallet = s.wallets.create('Test', '5.00').id;
  const agent = async (name: string, type: 'claude' | 'chatgpt' | 'other' = 'chatgpt') => {
    const { id } = s.core.createAgent(name);
    s.wallets.assign(id, wallet);
    s.connections.set(id, type, name);
    await s.core.register(id);
    return id;
  };
  return { s, agent, wallet };
}

/** The ChatGPT door on a random port, answering as the stand-in tunnel's host. */
async function door(s: Services, opts: { explode?: () => boolean } = {}) {
  const server = createPublicServer({
    host: s.tools, oauth: s.oauth, version: 'test', diagnostics: s.diagnostics,
    base: () => s.tunnel.url,
    agents: () => {
      if (opts.explode?.()) throw new Error('boom');
      return s.chatgptAgents();
    },
    onRequest: () => {},
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  s.publicServer = server;
  const port = (server.address() as AddressInfo).port;
  // A fetch that reaches the door as a tunnel would: to this port, with the tunnel's host name.
  const viaTunnel: typeof fetch = (async (input: any, init: any = {}) => {
    const u = new URL(String(input));
    return new Promise<Response>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: u.pathname + u.search, method: init.method ?? 'GET', headers: { ...(init.headers ?? {}), host: u.host } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers as any })));
      });
      req.on('error', reject);
      if (init.body) req.write(init.body);
      req.end();
    });
  }) as typeof fetch;
  // The tunnel's own checks go the same way (§16.17.8), and the first one decides its state.
  s.tunnel.fetchImpl = viaTunnel;
  await s.tunnel.start({ provider: 'custom', port, customUrl: TUNNEL });
  await s.tunnel.settled();
  return { server, port, viaTunnel, close: async () => { await s.tunnel.stop(); await new Promise<void>((r) => server.close(() => r())); } };
}

/** ChatGPT's sign-in, driven straight through the app's OAuth: register, authorize, the person's code, the token. */
function signIn(s: Services, agent: string, name: string) {
  const client: any = s.oauth.register({ client_name: 'ChatGPT', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' });
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const resource = `${TUNNEL}/${name}/mcp`;
  const req: any = s.oauth.authorize({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', resource }, () => agent);
  assert.equal(s.oauth.enterCode(agent, req.match).ok, true);
  const code = new URL(s.oauth.status(req.id).redirect!).searchParams.get('code')!;
  const tokens: any = s.oauth.token({ grant_type: 'authorization_code', code, client_id: client.client_id, code_verifier: verifier, redirect_uri: REDIRECT });
  return { client: client.client_id as string, access: tokens.access_token as string, refresh: tokens.refresh_token as string, resource };
}

test('the recorder keeps the last 200 calls and the newest of each outcome, and counts repeated events', () => {
  let now = 1_000;
  const d = new Diagnostics({ db: openDb(), now: () => now++ });
  d.call('a_x', 'chatgpt', 'send', 'failed', 5, 'The app could not run send: boom');
  d.call('a_x', 'chatgpt', 'send', 'refused', 5, 'budget');
  for (let i = 0; i < KEEP_CALLS + 20; i++) d.call('a_x', 'chatgpt', 'status', 'ok', 1);
  const calls = d.calls('a_x', { limit: 1000 });
  assert.equal(calls.length, KEEP_CALLS + 2, 'the 200 newest, plus the old failure and refusal');
  assert.deepEqual(calls.slice(-2).map((c) => c.outcome), ['refused', 'failed']);
  for (let i = 0; i < 50; i++) d.event('http', '404', 'unknown path');
  const e = d.events({ kinds: ['http'] });
  assert.equal(e.length, 1);
  assert.equal(e[0].count, 50);
});

test('every way in is recorded: tool calls with how they ended, MCP methods, and failures with the tool named', async () => {
  const { s, agent } = await computer();
  const chappy = await agent('Chappy');
  await handleMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, s.tools, chappy, { via: 'chatgpt' });
  await handleMcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'status', arguments: {} } }, s.tools, chappy, { via: 'chatgpt' });
  s.core.setMay(chappy, 'porch');
  await handleMcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'send', arguments: { room: 'r_x', text: 'hi' } } }, s.tools, chappy, { via: 'chatgpt' });
  s.core.setMay(chappy, 'all');
  const orig = s.core.lookup.bind(s.core);
  (s.core as any).lookup = async () => { throw new Error('the lookup blew up'); };
  const failed: any = await handleMcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'find_agents', arguments: { name: 'x' } } }, s.tools, chappy, { via: 'chatgpt' });
  (s.core as any).lookup = orig;
  assert.equal(failed.error.code, -32603);
  await s.tools.call(chappy, 'status', {}, { via: 'runner', rooms: new Set() });
  const calls = s.diagnostics.calls(chappy).reverse();
  assert.deepEqual(calls.map((c) => [c.via, c.name, c.outcome]), [
    ['chatgpt', 'initialize', 'ok'], ['chatgpt', 'status', 'ok'], ['chatgpt', 'send', 'refused'], ['chatgpt', 'find_agents', 'failed'], ['runner', 'status', 'ok'],
  ]);
  assert.match(calls[3].error!, /could not run find_agents: the lookup blew up/);
  assert.ok(calls.every((c) => !/"hi"|r_x/.test(JSON.stringify(c))), 'no arguments are kept');
});

test('the ChatGPT door records why it refused, never the path a stranger typed, and never answers a bare 500', async () => {
  const { s, agent } = await computer();
  const chappy = await agent('Chappy');
  let explode = false;
  const d = await door(s, { explode: () => explode });
  try {
    const post = (path: string, token?: string) => d.viaTunnel(`${TUNNEL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
    assert.equal((await post('/chappy/mcp')).status, 401);
    assert.equal((await post('/chappy/mcp', `mat_${'A'.repeat(43)}`)).status, 401);
    assert.equal((await post('/secret-probe-path')).status, 404);
    explode = true;
    const r = await post('/chappy/mcp');
    explode = false;
    assert.equal(r.status, 500);
    assert.match(((await r.json()) as any).error_description, /connection check/);
    const e = s.diagnostics.events({ kinds: ['http'] });
    const text = e.map((x) => `${x.what} ${x.detail} ${x.agent}`).join('\n');
    assert.match(text, new RegExp(`401 sign-in token: none ${chappy}`));
    assert.match(text, /401 sign-in token: unknown or revoked/);
    assert.match(text, /404 unknown path/);
    assert.match(text, /500 boom/);
    assert.doesNotMatch(text, /secret-probe-path/);
  } finally {
    await d.close();
  }
});

test('sign-ins are recorded: issued, refreshed, an expired refresh named as expired for its agent, revoked', async () => {
  const { s, agent } = await computer();
  const chappy = await agent('Chappy');
  const t = signIn(s, chappy, 'chappy');
  const again: any = s.oauth.token({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: t.client });
  s.db.prepare("UPDATE oauth_tokens SET expires_at = ? WHERE kind = 'refresh'").run(Date.now() - 60_000); // expired a minute ago
  const refused: any = s.oauth.token({ grant_type: 'refresh_token', refresh_token: again.refresh_token, client_id: t.client });
  assert.equal(refused.error, 'invalid_grant');
  assert.equal(refused.agent, undefined, 'the agent is recorded, never sent');
  s.oauth.revoke(t.client, chappy);
  const ev = s.diagnostics.events({ agent: chappy, kinds: ['oauth'] }).map((e) => [e.what, e.agent === chappy, e.detail]);
  assert.deepEqual(ev, [
    ['revoked', true, ''],
    ['refused', true, 'invalid_grant: The refresh token expired after 30 days unused.'],
    ['refreshed', true, ''],
    ['issued', true, ''],
  ]);
});

test('the connection check names the first step that is not working, in order, and all green says whose side a failure is on', async () => {
  const { s, agent } = await computer();
  const chappy = await agent('Chappy');
  await s.core.sync(chappy);
  const keys = (c: any) => c.steps.map((x: any) => `${x.key}:${x.state}`);

  let c = connectionCheck(s, chappy, null)!;
  assert.deepEqual(keys(c), ['network:ok', 'door:bad', 'tunnel:bad', 'signin:bad', 'lastcall:warn']);
  assert.match(c.verdict.text, /^The app's ChatGPT door:/);

  const d = await door(s);
  try {
    c = connectionCheck(s, chappy, null)!;
    assert.deepEqual(keys(c), ['network:ok', 'door:ok', 'tunnel:ok', 'signin:bad', 'lastcall:warn']);
    assert.match(c.verdict.text, /^ChatGPT's sign-in: Follow Set up ChatGPT/);

    const t = signIn(s, chappy, 'chappy');
    c = connectionCheck(s, chappy, null)!;
    assert.match(c.verdict.text, /^Last call from ChatGPT: Ask ChatGPT to use Meadow/);

    const res = await d.viaTunnel(`${TUNNEL}/chappy/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t.access}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'status', arguments: {} } }) });
    assert.equal(res.status, 200);
    c = connectionCheck(s, chappy, null)!;
    assert.deepEqual(keys(c), ['network:ok', 'door:ok', 'tunnel:ok', 'signin:ok', 'lastcall:ok']);
    assert.equal(c.verdict.state, 'ok');
    assert.match(c.verdict.text, /on ChatGPT's side/);

    // A slow answer: ChatGPT may have given up although the app finished.
    s.diagnostics.call(chappy, 'chatgpt', 'sync', 'ok', 25_000);
    c = connectionCheck(s, chappy, null)!;
    assert.match(c.verdict.text, /^Last call from ChatGPT: Try again/);
    assert.match(c.steps.at(-1)!.text, /took 25 seconds/);

    // A request with no token after the last good call is not a failed sign-in: ChatGPT's
    // own first request has none, and so does Test connection's (testers, 2026-10-01).
    s.diagnostics.call(chappy, 'chatgpt', 'status', 'ok', 5);
    const tick = () => new Promise((r) => setTimeout(r, 5));
    await tick();
    await d.viaTunnel(`${TUNNEL}/chappy/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal((await testConnection(s, chappy, d.viaTunnel)).ok, true);
    c = connectionCheck(s, chappy, null)!;
    assert.equal(c.steps.find((x) => x.key === 'signin')!.state, 'ok');
    assert.equal(c.verdict.state, 'ok');

    // A refused token after the last good call is.
    await tick();
    await d.viaTunnel(`${TUNNEL}/chappy/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer mat_${'A'.repeat(43)}` }, body: '{}' });
    c = connectionCheck(s, chappy, null)!;
    assert.equal(c.steps.find((x) => x.key === 'signin')!.state, 'warn');
    assert.match(c.steps.find((x) => x.key === 'signin')!.text, /unknown or revoked/);

    // ChatGPT renewing its sign-in afterwards clears it, before any call.
    await tick();
    s.oauth.token({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: t.client });
    c = connectionCheck(s, chappy, null)!;
    assert.equal(c.steps.find((x) => x.key === 'signin')!.state, 'ok');
    assert.match(c.steps.find((x) => x.key === 'signin')!.text, /last renewed/);

    // Revoked in Settings.
    s.oauth.revoke(t.client, chappy);
    c = connectionCheck(s, chappy, null)!;
    assert.match(c.steps.find((x) => x.key === 'signin')!.text, /revoked in Settings/);
  } finally {
    await d.close();
  }
});

test('a failed sync is placed: a refused payment is named on the network step, from any path', async () => {
  const { s, agent, wallet } = await computer();
  const chappy = await agent('Chappy', 'claude');
  s.wallets.setBudget(wallet, '0.000001');
  await s.tools.call(chappy, 'sync', {}, { via: 'claude' });
  const c = connectionCheck(s, chappy, { installed: true, upToDate: true, unreadable: false })!;
  assert.deepEqual(c.steps.map((x) => x.key), ['network', 'bridge', 'lastcall']);
  assert.equal(c.steps[0].state, 'bad');
  assert.match(c.steps[0].text, /wallet would not pay/);
  assert.match(c.verdict.text, /^Meadow network: Look at the wallet/);
  assert.equal(connectionCheck(s, chappy, { installed: false, upToDate: false, unreadable: false })!.steps[1].state, 'bad');
});

test('Test connection passes through a working tunnel, and says so when the tunnel answers instead of the app', async () => {
  const { s, agent } = await computer();
  const chappy = await agent('Chappy');
  const d = await door(s);
  try {
    const good = await testConnection(s, chappy, d.viaTunnel);
    assert.equal(good.ok, true, JSON.stringify(good.steps));
    assert.equal(s.oauth.authorized().length, 0, 'no token was made or sent');
    const offline: typeof fetch = (async () => new Response('<html>ERR_NGROK_3200 The endpoint is offline</html>', { status: 404 })) as typeof fetch;
    const bad = await testConnection(s, chappy, offline);
    assert.equal(bad.ok, false);
    assert.match(bad.steps[0].text, /tunnel's own error page \(ERR_NGROK_3200\)/);
    assert.match(bad.note, /cannot check ChatGPT's side/);
    // Something else answers at the address, with JSON of its own.
    const impostor: typeof fetch = (async () => Response.json({ resource: 'https://elsewhere.example/mcp' })) as typeof fetch;
    const wrong = await testConnection(s, chappy, impostor);
    assert.equal(wrong.ok, false);
    assert.match(wrong.steps[0].text, /something other than this app/);
    assert.deepEqual(s.diagnostics.events({ kinds: ['test'] }).map((e) => e.what), ['fail', 'fail', 'pass']);
  } finally {
    await d.close();
  }
});

test('the export names no one and holds no secret, and keeps what helps', async () => {
  const { s, agent, wallet } = await computer();
  const chappy = await agent('Chappy');
  const d = await door(s);
  try {
    const t = signIn(s, chappy, 'chappy');
    s.diagnostics.call(chappy, 'chatgpt', 'send', 'failed', 12, `The app could not run send: ${chappy} in r_${'x'.repeat(43)} said no to chappy#abcdefgh at ${TUNNEL}/chappy/mcp`);
    s.diagnostics.event('http', '500', `boom at ${TUNNEL}`);
    const text = diagnosticsText(s, () => null);
    const handle = s.core.agents()[0].handle;
    const address = s.wallets.list().find((w) => w.id === wallet)!.address;
    for (const secret of [chappy, handle, address, t.access, t.refresh, t.client, 'meadow-test.example', 'Chappy', 'chappy', 'r_xxxx']) {
      assert.equal(text.includes(secret), false, `the export must not contain ${secret}`);
    }
    assert.match(text, /App version: test/);
    assert.match(text, /Agent 1: connection chatgpt, registered/);
    assert.match(text, /chatgpt send failed 12 ms: The app could not run send: <agent> in <room> said no to <handle> at https:\/\/<tunnel>\/<name>\/mcp/);
    assert.match(text, /oauth issued \(Agent 1\)/);
  } finally {
    await d.close();
  }
});

test("the local interfaces tell the Claude bridge from other hosts by the connection's type", async () => {
  const { s, agent } = await computer();
  const claude = await agent('Clawd', 'claude');
  const other = await agent('Lm', 'other');
  s.setSettings({ localPort: 0 });
  await s.listen();
  const port = (s.server!.address() as AddressInfo).port;
  const init = (token: string) => fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
  try {
    assert.equal((await init(s.connections.token(claude)!)).status, 200);
    assert.equal((await init(s.connections.token(other)!)).status, 200);
    assert.equal(s.diagnostics.calls(claude)[0].via, 'claude');
    assert.equal(s.diagnostics.calls(other)[0].via, 'local');
  } finally {
    s.server!.close();
  }
});

test('scrub takes out every identifier and keeps the public services', () => {
  assert.equal(scrub('mdw_abc mat_x a_' + 'A'.repeat(43) + ' e_' + 'b'.repeat(43) + ' 0x' + 'c'.repeat(40) + ' https://my.host/x https://agent.pocket.network/v1'),
    '<token> <token> <agent> <event> <address> https://<host>/x https://agent.pocket.network/v1');
});
