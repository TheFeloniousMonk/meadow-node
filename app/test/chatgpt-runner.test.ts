// The tunneled interface and its OAuth (SPEC §16.7.2), walked the way
// ChatGPT walks it; and the runner (§16.7.3) against stand-in Anthropic and
// OpenAI-compatible endpoints. Meadow calls are paid through the mock portal.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Catalog } from '../src/core/catalog.ts';
import { Services } from '../src/app/services.ts';
import { createPublicServer } from '../src/server/public.ts';
import { startMockPortal, type MockPortal } from './mock-portal.ts';

let portal: MockPortal;
before(async () => {
  portal = await startMockPortal();
});
after(() => portal.close());

async function computer() {
  const catalog = new Catalog({ url: portal.catalogUrl });
  await catalog.refresh();
  const s = new Services({ dbPath: ':memory:', masterKey: randomBytes(32), version: 'test', changed: () => {}, catalog });
  const wallet = s.wallets.create('Test', '5.00').id;
  const agent = async (name: string, type: 'claude' | 'chatgpt' | 'other' = 'claude') => {
    const { id } = s.core.createAgent(name);
    s.wallets.assign(id, wallet);
    s.connections.set(id, type, name);
    await s.core.register(id);
    return id;
  };
  return { s, agent };
}

const listen = (server: http.Server) => new Promise<string>((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
const REDIRECT = 'https://chatgpt.com/connector/oauth/cb123';

test('ChatGPT signs in only after the person approves in the app, and then uses the agent through MCP', async () => {
  const { s, agent } = await computer();
  const chappy = await agent('Chappy', 'chatgpt');
  await agent('Other', 'chatgpt');
  let asked = 0;
  let base = '';
  const server = createPublicServer({ host: s.tools, oauth: s.oauth, version: 'test', base: () => base, agents: () => s.chatgptAgents(), onRequest: () => asked++ });
  base = await listen(server);
  const mcpUrl = `${base}/chappy/mcp`;
  const rpc = (token: string | null, method: string, params: unknown = {}, url = mcpUrl) =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  try {
    // 1. Without a token: 401, pointing at the protected resource metadata.
    const first = await rpc(null, 'initialize');
    assert.equal(first.status, 401);
    assert.equal(first.headers.get('www-authenticate'), `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/chappy/mcp", scope="meadow"`);
    const prm: any = await (await fetch(`${base}/.well-known/oauth-protected-resource/chappy/mcp`)).json();
    assert.deepEqual([prm.resource, prm.authorization_servers], [mcpUrl, [base]]);
    const as: any = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    assert.deepEqual(as.code_challenge_methods_supported, ['S256']);

    // 2. Registration: ChatGPT's redirect only.
    const reg = (uris: string[]) => fetch(as.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: uris, token_endpoint_auth_method: 'none' }) });
    assert.equal((await reg(['https://evil.example/cb'])).status, 400);
    const client: any = await (await reg([REDIRECT])).json();

    // 3. Authorization: a page that waits; the request waits for the person, with a code shown in both places.
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorize = (extra: Record<string, string> = {}) => fetch(`${as.authorization_endpoint}?${new URLSearchParams({
      response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', resource: mcpUrl, scope: 'meadow', ...extra,
    })}`);
    const pageRes = await authorize();
    const html = await pageRes.text();
    assert.equal(pageRes.status, 200);
    assert.match(pageRes.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    const [pending] = s.oauth.pending();
    assert.equal(asked, 1);
    assert.equal(pending.agent, chappy);
    assert.ok(html.includes(`<p class="code">${pending.match}</p>`));
    assert.match(html, /act as <strong>Chappy<\/strong>/);
    const status = async () => (await fetch(`${base}/oauth/status?request=${pending.id}`)).json() as Promise<any>;
    assert.equal((await status()).state, 'pending');

    // Another client may not ask for a resource that is not an agent here.
    assert.equal((await authorize({ resource: `${base}/nobody/mcp` })).status, 400);

    // 4. The person approves; the page goes back to ChatGPT with the code, once.
    s.oauth.decide(pending.id, true);
    const done = await status();
    const back = new URL(done.redirect);
    assert.equal(back.origin + back.pathname, REDIRECT);
    assert.equal(back.searchParams.get('state'), 'xyz');
    assert.equal((await status()).state, 'expired');

    // 5. The token: PKCE must match.
    const tokenCall = (form: Record<string, string>) => fetch(as.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) }).then(async (r) => ({ status: r.status, body: await r.json() as any }));
    const tok = await tokenCall({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT, resource: mcpUrl });
    assert.equal(tok.status, 200);
    assert.equal(tok.body.token_type, 'Bearer');
    assert.equal((await tokenCall({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, code_verifier: verifier, client_id: client.client_id })).body.error, 'invalid_grant'); // used

    // 6. MCP as Chappy; the same token is refused at the other agent's address.
    const init: any = await (await rpc(tok.body.access_token, 'initialize', { protocolVersion: '2025-06-18' })).json();
    assert.match(init.result.instructions, /Ask your person before a paid action/);
    const list: any = await (await rpc(tok.body.access_token, 'tools/list')).json();
    assert.equal(list.result.tools.find((t: any) => t.name === 'inbox').annotations.readOnlyHint, true);
    const st: any = await (await rpc(tok.body.access_token, 'tools/call', { name: 'status', arguments: {} })).json();
    assert.match(st.result.structuredContent.handle, /^chappy#/);
    assert.equal((await rpc(tok.body.access_token, 'tools/list', {}, `${base}/other/mcp`)).status, 401);

    // 7. Refresh tokens rotate; revoking stops everything at once.
    const refreshed = await tokenCall({ grant_type: 'refresh_token', refresh_token: tok.body.refresh_token, client_id: client.client_id });
    assert.equal(refreshed.status, 200);
    assert.equal((await tokenCall({ grant_type: 'refresh_token', refresh_token: tok.body.refresh_token })).body.error, 'invalid_grant');
    assert.deepEqual(s.oauth.authorized().map((a) => a.agent), [chappy]);
    s.oauth.revoke(client.client_id, chappy);
    assert.equal((await rpc(refreshed.body.access_token, 'tools/list')).status, 401);

    // 8. A wrong verifier, and a refusal.
    await authorize();
    const second = s.oauth.pending()[0];
    s.oauth.decide(second.id, true);
    const code2 = new URL((await (await fetch(`${base}/oauth/status?request=${second.id}`)).json() as any).redirect).searchParams.get('code')!;
    assert.equal((await tokenCall({ grant_type: 'authorization_code', code: code2, code_verifier: randomBytes(32).toString('base64url'), client_id: client.client_id })).body.error, 'invalid_grant');
    await authorize();
    const third = s.oauth.pending()[0];
    s.oauth.decide(third.id, false);
    const refused = new URL((await (await fetch(`${base}/oauth/status?request=${third.id}`)).json() as any).redirect);
    assert.equal(refused.searchParams.get('error'), 'access_denied');

    // 9. Nothing else is served through the tunnel.
    for (const path of ['/rest/status', '/openapi.json', '/mcp']) assert.equal((await fetch(base + path, { method: path.includes('rest') || path === '/mcp' ? 'POST' : 'GET' })).status, 404);
  } finally {
    server.close();
  }
});

/** A stand-in model endpoint: answers each request with the next scripted reply, and records the requests. */
async function model(replies: ((body: any) => unknown)[]) {
  const seen: { headers: http.IncomingHttpHeaders; body: any; path: string }[] = [];
  const server = http.createServer(async (req, res) => {
    let text = '';
    for await (const c of req) text += c;
    const body = JSON.parse(text);
    seen.push({ headers: req.headers, body, path: req.url ?? '' });
    const reply = replies[Math.min(seen.length - 1, replies.length - 1)](body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply));
  });
  const url = await listen(server);
  return { url, seen, close: () => server.close() };
}

async function runnerScenario(provider: 'anthropic' | 'openai') {
  const A = await computer();
  const B = await computer();
  const alice = await A.agent('alice');
  const bot = await B.agent('bot', 'other');
  const { result: room } = await A.s.core.createRoom(alice, { type: 'public', name: 'Helpdesk' });
  const { result: elsewhere } = await A.s.core.createRoom(alice, { type: 'public', name: 'Elsewhere' });
  await B.s.core.joinRoom(bot, room);
  await B.s.core.joinRoom(bot, elsewhere);
  return { A, B, alice, bot, room, elsewhere };
}

const waitFor = async (fn: () => boolean) => {
  for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 50));
};

test('the runner answers through the Anthropic Messages API, only in its enabled room', async () => {
  const { A, B, alice, bot, room, elsewhere } = await runnerScenario('anthropic');
  const m = await model([
    () => ({ content: [
      { type: 'text', text: 'Replying.' },
      { type: 'tool_use', id: 'tu_1', name: 'send', input: { room, text: 'Hello from the runner.' } },
      { type: 'tool_use', id: 'tu_2', name: 'send', input: { room: elsewhere, text: 'Not allowed here.' } },
    ], stop_reason: 'tool_use' }),
    () => ({ content: [{ type: 'text', text: 'Answered one question.' }], stop_reason: 'end_turn' }),
  ]);
  try {
    B.s.runner.configure(bot, { enabled: true, provider: 'anthropic', endpoint: m.url, model: 'claude-sonnet-5', rooms: [room], apiKey: 'sk-test-key' });
    await A.s.core.send(alice, room, 'Can anyone help?');
    await A.s.core.send(alice, elsewhere, 'Not for the bot.');
    await B.s.core.sync(bot); // brings the messages; the runner starts after the sync
    await waitFor(() => B.s.runner.log(bot).length > 0);

    const [firstCall, secondCall] = m.seen;
    assert.equal(firstCall.path, '/v1/messages');
    assert.equal(firstCall.headers['x-api-key'], 'sk-test-key');
    assert.equal(firstCall.headers['anthropic-version'], '2023-06-01');
    assert.equal(firstCall.body.model, 'claude-sonnet-5');
    assert.match(firstCall.body.system, /no person in this conversation/);
    assert.ok(firstCall.body.tools.some((t: any) => t.name === 'send' && t.input_schema.required.includes('room')));
    assert.match(firstCall.body.messages[0].content, /Can anyone help\?/);
    assert.doesNotMatch(firstCall.body.messages[0].content, /Not for the bot/); // only its enabled room
    const results = secondCall.body.messages.at(-1).content;
    assert.equal(results[0].tool_use_id, 'tu_1');
    assert.match(results[1].content, /not enabled to act there/);
    assert.match(B.s.runner.log(bot)[0].text, /send; send \(refused\); Summary: Answered one question\./);

    await A.s.core.sync(alice);
    assert.deepEqual(A.s.core.messages(alice, { room }).map((x) => x.text), ['Can anyone help?', 'Hello from the runner.']);
    assert.deepEqual(A.s.core.messages(alice, { room: elsewhere }).map((x) => x.text), ['Not for the bot.']);
  } finally {
    m.close();
  }
});

test('the runner works with an OpenAI-compatible endpoint, and its key is never shown', async () => {
  const { A, B, alice, bot, room } = await runnerScenario('openai');
  const m = await model([
    () => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'send', arguments: JSON.stringify({ room, text: 'Hi, via chat completions.' }) } }] } }] }),
    () => ({ choices: [{ message: { role: 'assistant', content: 'Done.' } }] }),
  ]);
  try {
    B.s.runner.configure(bot, { enabled: true, provider: 'openai', endpoint: m.url, model: 'some-model', rooms: [room], apiKey: 'sk-openai-test' });
    assert.deepEqual(B.s.runner.config(bot), { enabled: true, provider: 'openai', endpoint: m.url, model: 'some-model', rooms: [room], hasKey: true });
    await A.s.core.send(alice, room, 'Ping?');
    await B.s.core.sync(bot);
    await waitFor(() => B.s.runner.log(bot).length > 0);
    assert.equal(m.seen[0].path, '/chat/completions');
    assert.equal(m.seen[0].headers.authorization, 'Bearer sk-openai-test');
    assert.equal(m.seen[0].body.tools[0].type, 'function');
    const toolMsg = m.seen[1].body.messages.at(-1);
    assert.deepEqual([toolMsg.role, toolMsg.tool_call_id], ['tool', 'call_1']);
    await A.s.core.sync(alice);
    assert.equal(A.s.core.messages(alice, { room }).at(-1)?.text, 'Hi, via chat completions.');
    assert.throws(() => B.s.runner.configure(bot, { enabled: true, provider: 'openai', endpoint: 'http://example.com/v1', model: 'x', rooms: [] }), /https/);
  } finally {
    m.close();
  }
});
