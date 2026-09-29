// The tunneled interface (SPEC §16.7.2): what ChatGPT reaches through the
// person's own tunnel. It listens on loopback, on its own port, and the tunnel
// forwards the internet to it. It serves the MCP interface of each agent whose
// connection is ChatGPT, at <base>/<network name>/mcp, and the OAuth that
// guards it; nothing else (no REST, no OpenAPI, no local token).
//
//   GET  /.well-known/oauth-authorization-server              (RFC 8414)
//   GET  /.well-known/oauth-protected-resource/<name>/mcp      (RFC 9728)
//   POST /oauth/register                                       (RFC 7591)
//   GET  /oauth/authorize          a page: "approve in the Meadow app"
//   GET  /oauth/status?request=    the page polls this
//   POST /oauth/token
//   POST /<name>/mcp               MCP, with an access token for that agent

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { handleMcp, MCP_VERSIONS } from '../core/mcp.ts';
import { OAUTH, type OAuth } from '../core/oauth.ts';
import type { ToolHost } from '../core/tools.ts';

const MAX_BODY = 256 * 1024;

export interface PublicServerOptions {
  host: ToolHost;
  oauth: OAuth;
  /** The public address the tunnel gives, without a trailing slash; null while there is none. */
  base(): string | null;
  /** The agents ChatGPT may act as: network name to agent ID. */
  agents(): Map<string, { id: string; displayName: string }>;
  version: string;
  /** Called when a new authorization request waits for the person. */
  onRequest(): void;
  /** Called when tokens are issued, so the app shows the connection as approved. */
  onTokens?(): void;
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
};

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

function parseForm(req: IncomingMessage, text: string): Record<string, string> {
  if ((req.headers['content-type'] ?? '').includes('application/json')) {
    try {
      const o = JSON.parse(text);
      return Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The page ChatGPT opens in the person's browser: it waits for the decision made in the app. */
function page(res: ServerResponse, status: number, title: string, body: string, script = '') {
  const nonce = randomBytes(16).toString('base64');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>body{font-family:system-ui,sans-serif;background:#faf7f2;color:#231d14;max-width:34rem;margin:3rem auto;padding:0 1.25rem;font-size:1.15rem;line-height:1.6}
h1{font-family:Georgia,serif;font-weight:500}.code{font-size:2.6rem;letter-spacing:.3rem;font-weight:700;background:#fff;border:2px solid #d99a1e;border-radius:12px;padding:.5rem 1.25rem;display:inline-block}
.muted{color:#6b5f4d}</style></head><body>${body}${script ? `<script nonce="${nonce}">${script}</script>` : ''}</body></html>`;
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
    'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
  });
  res.end(html);
}

export function createPublicServer(opts: PublicServerOptions): Server {
  const resourceOf = (base: string, name: string) => `${base}/${name}/mcp`;
  const agentOf = (base: string) => (resource: string) => {
    for (const [name, a] of opts.agents()) if (resourceOf(base, name) === resource) return a.id;
    return null;
  };

  const server = createServer(async (req, res) => {
    try {
      const base = opts.base();
      if (!base) return json(res, 503, { error: 'not_ready', error_description: 'The Meadow app has no public address yet.' });
      const url = new URL(req.url ?? '/', base);
      const path = url.pathname;

      if (req.method === 'GET' && path === '/.well-known/oauth-authorization-server') {
        return json(res, 200, {
          issuer: base,
          authorization_endpoint: `${base}/oauth/authorize`,
          token_endpoint: `${base}/oauth/token`,
          registration_endpoint: `${base}/oauth/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
          scopes_supported: [OAUTH.scope],
        });
      }
      const prm = /^\/\.well-known\/oauth-protected-resource\/([a-z0-9_-]{2,32})\/mcp$/.exec(path);
      if (req.method === 'GET' && prm && opts.agents().has(prm[1])) {
        return json(res, 200, { resource: resourceOf(base, prm[1]), authorization_servers: [base], scopes_supported: [OAUTH.scope], bearer_methods_supported: ['header'], resource_name: `Meadow: ${opts.agents().get(prm[1])!.displayName}` });
      }

      if (req.method === 'POST' && path === '/oauth/register') {
        let body: any;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return json(res, 400, { error: 'invalid_client_metadata', error_description: 'The body must be JSON.' });
        }
        const r = opts.oauth.register(body);
        return json(res, 'error' in r ? 400 : 201, r);
      }

      if (req.method === 'GET' && path === '/oauth/authorize') {
        const q = Object.fromEntries(url.searchParams);
        const r = opts.oauth.authorize(q, agentOf(base));
        if ('error' in r) return page(res, 400, 'Meadow could not connect', `<h1>This connection cannot go ahead</h1><p>${escape(r.error_description)}</p>`);
        opts.onRequest();
        // The resource was checked above: <base>/<name>/mcp.
        const agent = opts.agents().get(q.resource!.slice(base.length + 1, -'/mcp'.length));
        return page(res, 200, 'Approve in the Meadow app',
          `<h1>Approve in the Meadow app</h1>
<p>On your computer, the Meadow app is asking whether ChatGPT may act as <strong>${escape(agent?.displayName ?? 'your agent')}</strong>.</p>
<p>Check that the app shows this code, then click <strong>Approve</strong> there:</p>
<p class="code">${r.match}</p>
<p class="muted" id="status">Waiting for your answer in the app…</p>`,
          `const id=${JSON.stringify(r.id)};const s=document.getElementById('status');
async function poll(){try{const r=await fetch('/oauth/status?request='+encodeURIComponent(id),{cache:'no-store'});const j=await r.json();
if(j.state==='done'){s.textContent='Done. Returning to ChatGPT…';location.replace(j.redirect);return}
if(j.state==='expired'){s.textContent='This request has expired. Start again from ChatGPT.';return}}catch(e){}setTimeout(poll,2000)}poll();`);
      }
      if (req.method === 'GET' && path === '/oauth/status') {
        return json(res, 200, opts.oauth.status(url.searchParams.get('request') ?? ''));
      }
      if (req.method === 'POST' && path === '/oauth/token') {
        const r = opts.oauth.token(parseForm(req, await readBody(req)));
        if (!('error' in r)) opts.onTokens?.();
        return json(res, 'error' in r ? 400 : 200, r, { pragma: 'no-cache' });
      }

      const mcp = /^\/([a-z0-9_-]{2,32})\/mcp$/.exec(path);
      if (mcp && opts.agents().has(mcp[1])) {
        const resource = resourceOf(base, mcp[1]);
        const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization?.trim() ?? '')?.[1];
        const agent = opts.oauth.verify(bearer, resource);
        if (!agent) {
          return json(res, 401, { error: 'invalid_token', error_description: 'Sign in through the Meadow app first.' }, {
            'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/${mcp[1]}/mcp", scope="${OAUTH.scope}"`,
          });
        }
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only.' });
        let body: any;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON.' } });
        }
        const messages = Array.isArray(body) ? body : [body];
        const answers = [];
        for (const m of messages) {
          const a = await handleMcp(m, opts.host, agent, { audience: 'person', version: opts.version });
          if (a) answers.push(a);
        }
        if (!answers.length) {
          res.writeHead(202, { 'mcp-protocol-version': MCP_VERSIONS[0] });
          return res.end();
        }
        return json(res, 200, Array.isArray(body) ? answers : answers[0], { 'mcp-protocol-version': MCP_VERSIONS[0] });
      }
      return json(res, 404, { error: 'not_found' });
    } catch {
      if (!res.headersSent) json(res, 500, { error: 'server_error' });
    }
  });
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  return server;
}
