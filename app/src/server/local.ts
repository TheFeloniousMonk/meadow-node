// The app's loopback interfaces (SPEC §16.7.1, §16.7.3):
//
//   POST /mcp            MCP over HTTP (JSON responses, no sessions), for the
//                        Claude bridge, Claude Code, and other MCP hosts
//   POST /rest/<tool>    the same tools as plain JSON, for scripts and REST clients
//   GET  /openapi.json   the REST interface's OpenAPI description
//
// Bound to 127.0.0.1 only. Every call but the description needs a
// connection's bearer token, which decides the agent it acts as. A browser
// page cannot use it: any Origin other than this machine is refused.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleMcp, rpcError, RPC, MCP_VERSIONS } from '../core/mcp.ts';
import type { Audience, ToolHost } from '../core/tools.ts';
import type { Via } from '../core/diagnostics.ts';

export const LOCAL_HOST = '127.0.0.1';
const MAX_BODY = 1024 * 1024;

export interface LocalServerOptions {
  host: ToolHost;
  /** The agent a bearer token acts as, and who is in its conversation. */
  resolve(token: string | undefined): { agent: string; audience: Audience; rooms?: Set<string>; via?: Via } | null;
  version: string;
}

function bearer(req: IncomingMessage): string | undefined {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization?.trim() ?? '');
  return m?.[1];
}

function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const h = new URL(origin).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '[::1]';
  } catch {
    return false;
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store', 'mcp-protocol-version': MCP_VERSIONS[0] });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function openApi(host: ToolHost, version: string) {
  const paths: Record<string, unknown> = {};
  for (const t of host.list()) {
    paths[`/rest/${t.name}`] = {
      post: {
        operationId: t.name,
        summary: t.description,
        requestBody: { required: false, content: { 'application/json': { schema: t.inputSchema } } },
        responses: {
          200: { description: 'The result. A spend the app refused has `refused`, in plain words; nothing was sent.', content: { 'application/json': { schema: { type: 'object' } } } },
          400: { description: 'The action failed: `error` says why.' },
          401: { description: 'Missing or unknown token.' },
        },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Meadow app, local interface', version, description: host.instructions('person') },
    servers: [{ url: 'http://127.0.0.1' }],
    components: { securitySchemes: { token: { type: 'http', scheme: 'bearer', description: "The agent's connection token, from the Agents screen." } } },
    security: [{ token: [] }],
    paths,
  };
}

/** The Host header names this loopback server (or one of `extra`), not a name a web page rebound to 127.0.0.1. */
export function hostAllowed(host: string | undefined, server: Server, extra: string[] = []): boolean {
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : null;
  if (!host) return false;
  return extra.includes(host.toLowerCase()) || (port !== null && [`127.0.0.1:${port}`, `localhost:${port}`].includes(host.toLowerCase()));
}

export function createLocalServer(opts: LocalServerOptions): Server {
  const server = createServer({ connectionsCheckingInterval: 5_000 }, async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${LOCAL_HOST}`);
      if (!originAllowed(req.headers.origin)) return send(res, 403, { error: 'Origin refused.' });
      if (!hostAllowed(req.headers.host, server)) return send(res, 421, { error: 'Only 127.0.0.1 is served.' }); // DNS rebinding
      if (req.method === 'GET' && url.pathname === '/openapi.json') return send(res, 200, openApi(opts.host, opts.version));
      const who = opts.resolve(bearer(req));
      if (!who) return send(res, 401, { error: 'Missing or unknown connection token.' });
      if (req.method !== 'POST') return send(res, 405, { error: 'POST only.' });

      let body: any;
      try {
        const text = await readBody(req);
        body = text ? JSON.parse(text) : {};
      } catch {
        return send(res, 400, url.pathname === '/mcp' ? rpcError(null, RPC.PARSE, 'Invalid JSON.') : { error: 'Invalid JSON.' });
      }

      if (url.pathname === '/mcp') {
        const messages = Array.isArray(body) ? body : [body];
        const answers = [];
        for (const m of messages) {
          const a = await handleMcp(m, opts.host, who.agent, { audience: who.audience, version: opts.version, rooms: who.rooms, via: who.via ?? 'local' });
          if (a) answers.push(a);
        }
        if (!answers.length) return send(res, 202, undefined);
        return send(res, 200, Array.isArray(body) ? answers : answers[0]);
      }
      const tool = /^\/rest\/([a-z_]+)$/.exec(url.pathname)?.[1];
      if (tool) {
        const r = await opts.host.call(who.agent, tool, body, { audience: who.audience, rooms: who.rooms, via: 'rest' });
        return send(res, r.isError ? 400 : 200, r.data);
      }
      return send(res, 404, { error: 'Not found.' });
    } catch (err) {
      if (!res.headersSent) send(res, 500, { error: 'The app could not answer.' });
    }
  });
  // The whole request must arrive within 30 s. This bounds only the upload: a paid
  // tool may take longer to answer (a sync pages; a payment makes two calls).
  server.requestTimeout = 30_000;
  server.headersTimeout = 30_000;
  return server;
}
