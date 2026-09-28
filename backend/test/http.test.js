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
