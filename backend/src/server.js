// HTTP fronts. The relay port serves the client API through Pocket relays
// (SPEC §7). The peer port serves the peer API (§11.2) to other nodes, via
// the supplier's public hostname; relays cannot reach it. Every response is a
// JSON object, errors included; bodies may arrive chunked, without
// Content-Length.

import http from 'node:http';
import { verifyRequest } from './api/auth.js';
import { RequestError, SYNC_LIMITS, sync } from './api/sync.js';
import { directory } from './api/rooms.js';
import { fetchEvents } from './api/events.js';
import { lookup } from './api/lookup.js';
import { report } from './api/report.js';
import { peerRoutes } from './peer/api.js';
import { Peers, verifyPeer } from './peer/peers.js';
import { toWire } from './api/wire.js';
import { AGENT_KINDS, PROTOCOL, ROOM_VERSION } from './proto/event.js';

export const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

// Agent events are self-authenticating (§5.4), so the requester's own agent
// events in a sync outbox are taken before the request's signature is checked.
// That lets an agent sync with a node that has not yet seen its key rotation.
function ingestOwnAgentEvents(store, body) {
  const agent = body.auth?.agent;
  // This runs BEFORE the request signature is verified, so a rotated agent can
  // bootstrap a node that has not seen its rotation. It must therefore stay
  // bounded: never ingest more than a normal sync's outbox, so an
  // unauthenticated request cannot force an unbounded number of ingests/writes
  // (the outbox<=100 cap is otherwise only checked after auth, in sync()).
  if (!Array.isArray(body.outbox) || body.outbox.length > SYNC_LIMITS.outbox) return;
  for (const ev of body.outbox) {
    if (ev?.header?.author === agent && AGENT_KINDS.has(ev.header.kind)) store.ingest(ev);
  }
}

// Timeouts (SPEC §7: stay well under the relay timeout; close stalled/slow
// connections so a slowloris cannot hold sockets open). A legitimate relayed
// request arrives in milliseconds over the local supplier network.
export const HEADERS_TIMEOUT_MS = 10_000;
export const REQUEST_TIMEOUT_MS = 20_000;
const KEEPALIVE_TIMEOUT_MS = 10_000;
// Node checks headers/request timeouts only this often (its default is 30 s,
// which let a stalled body live up to ~50 s); it can only be set at creation.
const TIMEOUT_CHECK_MS = 2_000;
// A body that sends nothing for this long is closed, whatever its total age.
export const BODY_IDLE_MS = 10_000;

function send(res, status, value, head = false) {
  // A request that already timed out (Node auto-sends 408 and destroys it) or a
  // closed socket must not be written again.
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  const body = toWire(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body, 'utf8'),
    'cache-control': 'no-store',
  });
  res.end(head ? undefined : body);
}

const error = (code, message, details = {}) => ({ error: { code, message, ...details } });

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const idle = () => {
      reject(new RequestError('client_closed', 'request body stalled'));
      req.destroy();
    };
    let timer = setTimeout(idle, BODY_IDLE_MS);
    const stop = () => clearTimeout(timer);
    req.on('data', (chunk) => {
      clearTimeout(timer);
      timer = setTimeout(idle, BODY_IDLE_MS);
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        reject(new RequestError('too_large', `request body over ${MAX_REQUEST_BYTES} bytes`));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      stop();
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      stop();
      reject(err);
    });
    req.on('close', stop);
    // A stalled/slow body is closed by the server's requestTimeout; settle the
    // promise so the handler doesn't hang on an aborted connection.
    req.on('aborted', () => reject(new RequestError('client_closed', 'request aborted')));
  });
}

// A JSON POST server over a route table. `authenticate(route, body)` returns
// { error, status } or the caller's identity; `gets` answers GET and HEAD.
function jsonServer(table, authenticate, gets = {}) {
  const server = http.createServer({ connectionsCheckingInterval: TIMEOUT_CHECK_MS }, async (req, res) => {
    const path = new URL(req.url, 'http://node').pathname;
    try {
      if (gets[path] && (req.method === 'GET' || req.method === 'HEAD')) return send(res, 200, gets[path](), req.method === 'HEAD');
      const route = table[path];
      if (!route) return send(res, 404, error('not_found', 'no such endpoint'));
      if (req.method !== 'POST') return send(res, 405, error('method_not_allowed', 'use POST with a JSON body'));

      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return send(res, 400, error('bad_json', 'body is not valid JSON'));
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return send(res, 400, error('bad_request', 'body must be a JSON object'));
      }
      // auth: 'optional' routes serve anonymous callers too, but a present auth block must verify.
      if (!route.auth || (route.auth === 'optional' && body.auth === undefined)) return send(res, 200, route.handle(body, null));
      const who = authenticate(route, body);
      if (who.error) return send(res, who.status, error(who.error, who.message));
      return send(res, 200, route.handle(body, who.id));
    } catch (err) {
      if (err instanceof RequestError) return send(res, err.code === 'too_large' ? 413 : 400, error(err.code, err.message, err.details));
      console.error(err);
      return send(res, 500, error('internal', 'internal error'));
    }
  });
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = KEEPALIVE_TIMEOUT_MS;
  return server;
}

export function nodeInfo(store, config) {
  return {
    node: store.node.id,
    network: config.network ?? null,
    protocol: PROTOCOL,
    room_versions: [ROOM_VERSION],
    software: { name: 'meadow-node', version: config.version },
    source: config.sourceUrl,
    support: config.supportUrl ?? null,
    operator: config.operator ?? null,
    retention_days: Math.round(store.retention.contentMs / 86_400_000),
    room_expiry_days: Math.round(store.retention.roomMs / 86_400_000),
    status: 'ok',
  };
}

// The relay port: client API (§7).
export function createServer(store, config) {
  const table = {
    '/v2/sync': { auth: true, before: ingestOwnAgentEvents, handle: (body, agent) => sync(store, body, agent) },
    '/v2/report': { auth: true, handle: (body, agent) => report(store, body, agent) },
    '/v2/lookup': { handle: (body) => lookup(store, body) },
    '/v2/rooms': { handle: (body) => directory(store, body) },
    '/v2/events': { auth: 'optional', handle: (body, agent) => fetchEvents(store, body, agent) },
  };
  const authenticate = (route, body) => {
    route.before?.(store, body);
    const auth = verifyRequest(body, Date.now(), (agent) => store.requestKey(agent));
    return auth.error ? { error: auth.error, status: 401, message: 'request authentication failed (SPEC 7.1)' } : { id: auth.agent };
  };
  return jsonServer(table, authenticate, {
    '/': () => nodeInfo(store, config),
    // Readiness probe for the relayer and the container (JSON, as the Service Manager expects).
    '/healthz': () => ({ status: 'ok' }),
  });
}

// The peer port: peer API (§11.2), requests signed by known peers' node keys.
export function createPeerServer(store, peers = new Peers(), replicator = null) {
  const authenticate = (route, body) => {
    const auth = verifyPeer(body, peers);
    if (!auth.error) return { id: auth.node };
    return { error: auth.error, status: auth.error === 'unknown_peer' ? 403 : 401, message: 'peer authentication failed (SPEC 11.2)' };
  };
  return jsonServer(peerRoutes(store, peers, replicator), authenticate);
}
