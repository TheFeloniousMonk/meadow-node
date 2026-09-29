import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { Builder } from '../../conformance/tools/builder.js';
import { createServer } from '../src/server.js';
import { toWire } from '../src/api/wire.js';
import { Store } from '../src/store/store.js';
import { events, signed } from './helpers.js';

let server;
let port;
const store = new Store();

before(async () => {
  server = createServer(store, { version: '0.0.0-test', sourceUrl: 'https://example.invalid/src' });
  await new Promise((resolve) => server.listen(0, resolve));
  port = server.address().port;
});
after(() => server.close());

// Sends the body in chunks with no Content-Length, as relays do.
function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = request({ port, method, path, headers: body ? { 'content-type': 'application/json' } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) {
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      for (let i = 0; i < text.length; i += 1000) req.write(text.slice(i, i + 1000));
    }
    req.end();
  });
}

test('GET / and HEAD / answer the RelayMiner health check with JSON', async () => {
  const get = await call('GET', '/');
  assert.equal(get.status, 200);
  const info = JSON.parse(get.raw);
  assert.equal(info.node, store.node.id);
  assert.equal(info.status, 'ok');
  const head = await call('HEAD', '/');
  assert.equal(head.status, 200);
  assert.equal(head.raw, '');
});

test('errors are JSON objects', async () => {
  for (const [method, path, body, status] of [
    ['POST', '/nope', {}, 404],
    ['GET', '/v2/sync', undefined, 405],
    ['POST', '/v2/sync', '{not json', 400],
    ['POST', '/v2/sync', '[1]', 400],
    ['POST', '/v2/sync', {}, 401],
  ]) {
    const res = await call(method, path, body);
    assert.equal(res.status, status, `${method} ${path}`);
    assert.ok(JSON.parse(res.raw).error.code);
  }
});

test('sync over HTTP, with chunked bodies', async () => {
  const b = new Builder();
  const alice = b.agent('alice');
  b.create('create', alice, { type: 'public' });
  b.join('alice-join', alice);
  b.post('hello', alice, 'the gateway timeout was a connection refused');
  const res = await call('POST', '/v2/sync', signed(alice, { outbox: events(b, 'create', 'alice-join', 'hello') }));
  assert.equal(res.status, 200);
  assert.ok(!/timeout|connection refused/i.test(res.raw), 'error phrases are escaped on the wire');
  const body = JSON.parse(res.raw);
  assert.equal(body.accepted.length, 3);
  assert.equal(body.rooms[b.room.id].events[2].content, events(b, 'hello')[0].content);

  const bad = await call('POST', '/v2/sync', signed(alice, { outbox: 'x' }));
  assert.equal(bad.status, 400);
  assert.equal(JSON.parse(bad.raw).error.code, 'bad_request');
});

test('the room directory over HTTP, unauthenticated and escaped', async () => {
  const b = new Builder();
  const alice = b.agent('dir-owner');
  b.create('create', alice, { type: 'public' });
  b.join('join', alice);
  b.meta('meta', alice, { name: 'Service Unavailable club', listed: true });
  await call('POST', '/v2/sync', signed(alice, { outbox: events(b, 'create', 'join', 'meta') }));

  const res = await call('POST', '/v2/rooms', { query: 'club' });
  assert.equal(res.status, 200);
  assert.ok(!/service unavailable/i.test(res.raw), 'room names are escaped on the wire');
  assert.deepEqual(JSON.parse(res.raw).rooms.map((e) => [e.room, e.name]), [[b.room.id, 'Service Unavailable club']]);

  const bad = await call('POST', '/v2/rooms', { limit: 'x' });
  assert.equal(bad.status, 400);
  assert.equal(JSON.parse(bad.raw).error.code, 'bad_request');
});

test('events by ID over HTTP: auth optional, but a present auth block must verify', async () => {
  const b = new Builder();
  const owner = b.agent('events-owner');
  b.create('create', owner, { type: 'private' });
  b.join('join', owner);
  b.sealed('secret', owner, 'secret');
  await call('POST', '/v2/sync', signed(owner, { outbox: events(b, 'create', 'join', 'secret') }));
  const ids = [b.id('secret')];

  const anon = await call('POST', '/v2/events', { ids });
  assert.equal(anon.status, 200);
  assert.deepEqual(JSON.parse(anon.raw).unknown, ids);

  const member = await call('POST', '/v2/events', signed(owner, { ids }));
  assert.equal(member.status, 200);
  assert.deepEqual(JSON.parse(member.raw).events.map((e) => e.id), ids);

  const forged = signed(owner, { ids });
  forged.auth.sig = forged.auth.sig.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'));
  const bad = await call('POST', '/v2/events', forged);
  assert.equal(bad.status, 401);
  assert.ok(JSON.parse(bad.raw).error.code.startsWith('auth_'));
});

test('a rate-limited report is a JSON 4xx with retry_after_ms, never a 429', async () => {
  const b = new Builder();
  const author = b.agent('limit-author');
  const reporter = b.agent('limit-reporter');
  b.create('create', author, { type: 'public' });
  b.join('join', author);
  b.post('one', author, 'one');
  b.post('two', author, 'two');
  const strip = (ev) => ({ header: ev.header, id: ev.id, sig: ev.sig });
  const [one, two] = events(b, 'one', 'two').map(strip);

  const first = await call('POST', '/v2/report', signed(reporter, { report: { event: one, reason: 'spam' } }));
  assert.equal(first.status, 200);
  const retry = await call('POST', '/v2/report', signed(reporter, { report: { event: one, reason: 'spam' } }));
  assert.equal(retry.status, 200, 'an exact resubmission is answered');
  const second = await call('POST', '/v2/report', signed(reporter, { report: { event: two, reason: 'spam' } }));
  assert.equal(second.status, 400);
  const err = JSON.parse(second.raw).error;
  assert.equal(err.code, 'rate_limited');
  assert.ok(err.retry_after_ms > 0 && err.retry_after_ms <= 60_000);
});

test('no 2xx body has a top-level result, error, or jsonrpc key (SAGE grades those as JSON-RPC)', async () => {
  const b = new Builder();
  const alice = b.agent('shape-check');
  b.create('create', alice, { type: 'public' });
  b.join('join', alice);
  b.meta('meta', alice, { name: 'Shape', listed: true });
  b.post('hello', alice, 'hello');
  const strip = (ev) => ({ header: ev.header, id: ev.id, sig: ev.sig });
  const calls = [
    ['GET', '/'],
    ['GET', '/healthz'],
    ['POST', '/v2/sync', signed(alice, { outbox: events(b, 'create', 'join', 'meta', 'hello') })],
    ['POST', '/v2/lookup', { agent_id: alice.id }],
    ['POST', '/v2/rooms', {}],
    ['POST', '/v2/events', { ids: [b.id('hello')] }],
    ['POST', '/v2/report', signed(alice, { report: { event: strip(events(b, 'hello')[0]), reason: 'spam' } })],
  ];
  for (const [method, path, body] of calls) {
    const res = await call(method, path, body);
    assert.equal(res.status, 200, path);
    const keys = Object.keys(JSON.parse(res.raw));
    for (const k of ['result', 'error', 'jsonrpc']) assert.ok(!keys.includes(k), `${path} has a top-level ${k}`);
  }
});

test('wire escaping round-trips, including existing escapes', () => {
  const value = {
    a: 'TimeOut and Bad Gateway, Service Unavailable, connection reset',
    b: '\timeout',
    c: '\\timeout',
    d: 'gateway timeout',
    e: '\u001bad gateway and \u000connection reset',
    nested: ['connection refused', { 'x': 'fine' }],
  };
  const wire = toWire(value);
  assert.ok(!/timeout|bad gateway|service unavailable|connection re(fused|set)/i.test(wire));
  assert.deepEqual(JSON.parse(wire), value);
});
