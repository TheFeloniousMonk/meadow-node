// OAuth for the tunneled MCP interface (SPEC §16.7.2). The tunnel makes the
// interface reachable from the internet, and behind it is an agent whose
// wallet signs without asking, so it answers only clients the person approved
// in the app window. The app is both the authorization server and the
// resource server, as the MCP authorization spec and ChatGPT expect:
//
// - dynamic client registration (RFC 7591), redirects only to ChatGPT;
// - authorization code with PKCE S256 (RFC 7636), resource indicators (RFC 8707);
// - each authorization request waits for the person, who sees the same short
//   code in the browser and in the app, and approves or refuses there;
// - access tokens for one hour, refresh tokens for 30 days, rotated on use,
//   bound to one agent's resource; stored as hashes; revocable in Settings.

import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { Db } from './db.ts';

export const OAUTH = {
  requestMs: 10 * 60_000, // an authorization request waits this long for the person
  codeMs: 5 * 60_000,
  accessMs: 3600_000,
  refreshMs: 30 * 24 * 3600_000,
  maxPending: 5, // open requests at once, so no one can flood the person with dialogs
  // Registration is open to anyone who knows the tunnel's address, so it is bounded:
  maxUnusedClients: 20, // registered clients that hold no token, at once
  unusedClientMs: 24 * 3600_000, // an unused registration is forgotten after a day
  registerPerMinute: 10,
  maxRedirectLength: 512,
  scope: 'meadow',
};

/** Where an approved client may be sent back to: ChatGPT only. */
export const REDIRECTS = [/^https:\/\/chatgpt\.com\/[\w\-./]*$/, /^https:\/\/chat\.openai\.com\/[\w\-./]*$/];

const hash = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const token = (prefix: string) => `${prefix}_${randomBytes(32).toString('base64url')}`;
const s256 = (verifier: string) => createHash('sha256').update(verifier, 'ascii').digest('base64url');

export type OAuthError = { error: string; error_description: string };
const err = (error: string, error_description: string): OAuthError => ({ error, error_description });

export interface PendingRequest {
  id: string;
  client: string;
  agent: string;
  match: string;
  createdAt: number;
}

export class OAuth {
  #db: Db;
  #now: () => number;
  #registrations: number[] = [];

  constructor({ db, now = Date.now }: { db: Db; now?: () => number }) {
    this.#db = db;
    this.#now = now;
  }

  /** Dynamic client registration (RFC 7591), public clients only, redirecting to ChatGPT only. */
  register(body: any): OAuthError | Record<string, unknown> {
    const uris = body?.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 5 || !uris.every((u) => typeof u === 'string' && u.length <= OAUTH.maxRedirectLength && REDIRECTS.some((r) => r.test(u)))) {
      return err('invalid_redirect_uri', 'This app accepts only ChatGPT as a client.');
    }
    if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== 'none') {
      return err('invalid_client_metadata', 'Only public clients (token_endpoint_auth_method none) are supported.');
    }
    const now = this.#now();
    this.#registrations = this.#registrations.filter((t) => t > now - 60_000);
    this.#db.prepare('DELETE FROM oauth_clients WHERE created_at < ? AND client_id NOT IN (SELECT client_id FROM oauth_tokens) AND client_id NOT IN (SELECT client_id FROM oauth_requests)').run(now - OAUTH.unusedClientMs);
    const unused = (this.#db.prepare('SELECT COUNT(*) AS n FROM oauth_clients WHERE client_id NOT IN (SELECT client_id FROM oauth_tokens)').get() as any).n;
    if (this.#registrations.length >= OAUTH.registerPerMinute || unused >= OAUTH.maxUnusedClients) {
      return err('temporarily_unavailable', 'Too many registrations. Try again later.');
    }
    this.#registrations.push(now);
    const clientId = token('client');
    const name = typeof body.client_name === 'string' ? body.client_name.slice(0, 100) : 'ChatGPT';
    this.#db.prepare('INSERT INTO oauth_clients (client_id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)').run(clientId, name, JSON.stringify(uris), this.#now());
    return {
      client_id: clientId, client_name: name, redirect_uris: uris, client_id_issued_at: Math.floor(this.#now() / 1000),
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    };
  }

  #client(id: string): { name: string; redirect_uris: string[] } | null {
    const c: any = this.#db.prepare('SELECT name, redirect_uris FROM oauth_clients WHERE client_id = ?').get(id);
    return c ? { name: c.name, redirect_uris: JSON.parse(c.redirect_uris) } : null;
  }

  /**
   * Starts an authorization request. `agentOf(resource)` names the agent a
   * resource URL belongs to, or null. Errors before a valid redirect is known
   * are shown on the page, never redirected (RFC 6749 §4.1.2.1).
   */
  authorize(q: Record<string, string | undefined>, agentOf: (resource: string) => string | null): OAuthError | { id: string; match: string } {
    const client = q.client_id ? this.#client(q.client_id) : null;
    if (!client) return err('invalid_client', 'This client is not registered with the app.');
    if (!q.redirect_uri || !client.redirect_uris.includes(q.redirect_uri)) return err('invalid_request', 'The redirect address is not one this client registered.');
    if (q.response_type !== 'code') return err('unsupported_response_type', 'Only the authorization code flow is supported.');
    if (q.code_challenge_method !== 'S256' || !q.code_challenge || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge)) return err('invalid_request', 'PKCE with S256 is required.');
    const agent = q.resource ? agentOf(q.resource) : null;
    if (!q.resource || !agent) return err('invalid_target', 'That address is not an agent on this app that ChatGPT may use.');
    this.#sweep();
    const open = (this.#db.prepare('SELECT COUNT(*) AS n FROM oauth_requests WHERE decision IS NULL').get() as any).n;
    if (open >= OAUTH.maxPending) return err('temporarily_unavailable', 'Too many connection requests are waiting. Try again in a few minutes.');
    const id = token('req');
    const match = String(randomInt(1000, 10000));
    this.#db.prepare(`INSERT INTO oauth_requests (id, client_id, agent, redirect_uri, state, challenge, resource, match, created_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, q.client_id!, agent, q.redirect_uri, q.state ?? null, q.code_challenge, q.resource, match, this.#now());
    return { id, match };
  }

  #sweep() {
    const now = this.#now();
    this.#db.prepare("UPDATE oauth_requests SET decision = 'expired' WHERE decision IS NULL AND created_at < ?").run(now - OAUTH.requestMs);
    this.#db.prepare('DELETE FROM oauth_requests WHERE created_at < ?').run(now - 2 * OAUTH.requestMs);
    this.#db.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').run(now);
    this.#db.prepare('DELETE FROM oauth_tokens WHERE expires_at < ?').run(now);
  }

  /** Requests waiting for the person, for the app window. */
  pending(): PendingRequest[] {
    this.#sweep();
    return (this.#db.prepare(`SELECT r.id, r.agent, r.match, r.created_at, c.name FROM oauth_requests r JOIN oauth_clients c ON c.client_id = r.client_id
                               WHERE r.decision IS NULL ORDER BY r.created_at`).all() as any[])
      .map((r) => ({ id: r.id, client: r.name, agent: r.agent, match: r.match, createdAt: r.created_at }));
  }

  /** The person's decision, made in the app window. Approving issues a one-time code. */
  decide(id: string, approve: boolean) {
    const r: any = this.#db.prepare('SELECT * FROM oauth_requests WHERE id = ? AND decision IS NULL').get(id);
    if (!r) return;
    if (!approve) {
      this.#db.prepare("UPDATE oauth_requests SET decision = 'refused' WHERE id = ?").run(id);
      return;
    }
    const code = token('code');
    this.#db.prepare('INSERT INTO oauth_codes (code_hash, client_id, agent, redirect_uri, challenge, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(hash(code), r.client_id, r.agent, r.redirect_uri, r.challenge, r.resource, this.#now() + OAUTH.codeMs);
    this.#db.prepare("UPDATE oauth_requests SET decision = 'approved', code = ? WHERE id = ?").run(code, id);
  }

  /**
   * What the browser page waiting on a request does next: keep waiting, or go
   * back to the client with the code (once) or with access_denied.
   */
  status(id: string): { state: 'pending' | 'done' | 'expired'; redirect?: string } {
    this.#sweep();
    const r: any = this.#db.prepare('SELECT * FROM oauth_requests WHERE id = ?').get(id);
    if (!r || r.decision === 'expired') return { state: 'expired' };
    if (r.decision === null) return { state: 'pending' };
    const url = new URL(r.redirect_uri);
    if (r.decision === 'approved' && r.code) {
      url.searchParams.set('code', r.code);
      // The code is handed over once; the request no longer holds it.
      this.#db.prepare("UPDATE oauth_requests SET code = NULL, decision = 'delivered' WHERE id = ?").run(id);
    } else if (r.decision === 'delivered') {
      return { state: 'expired' };
    } else {
      url.searchParams.set('error', 'access_denied');
      url.searchParams.set('error_description', 'The person refused the connection in the Meadow app.');
    }
    if (r.state) url.searchParams.set('state', r.state);
    return { state: 'done', redirect: url.toString() };
  }

  /** The token endpoint: authorization_code with the PKCE verifier, or refresh_token (rotated). */
  token(form: Record<string, string | undefined>): OAuthError | Record<string, unknown> {
    this.#sweep();
    if (form.grant_type === 'authorization_code') {
      const c: any = form.code ? this.#db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').get(hash(form.code)) : null;
      if (!c) return err('invalid_grant', 'The code is unknown, used, or expired.');
      this.#db.prepare('DELETE FROM oauth_codes WHERE code_hash = ?').run(hash(form.code!));
      if (form.client_id !== c.client_id) return err('invalid_grant', 'The code was issued to another client.');
      if (form.redirect_uri !== undefined && form.redirect_uri !== c.redirect_uri) return err('invalid_grant', 'The redirect address does not match.');
      if (!form.code_verifier || s256(form.code_verifier) !== c.challenge) return err('invalid_grant', 'The PKCE verifier does not match.');
      if (form.resource !== undefined && form.resource !== c.resource) return err('invalid_target', 'The resource does not match the authorization.');
      return this.#issue(c.client_id, c.agent, c.resource);
    }
    if (form.grant_type === 'refresh_token') {
      const t: any = form.refresh_token ? this.#db.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'").get(hash(form.refresh_token)) : null;
      if (!t || t.expires_at < this.#now()) return err('invalid_grant', 'The refresh token is unknown, revoked, or expired.');
      if (form.client_id !== undefined && form.client_id !== t.client_id) return err('invalid_grant', 'The refresh token belongs to another client.');
      this.#db.prepare('DELETE FROM oauth_tokens WHERE token_hash = ?').run(t.token_hash);
      return this.#issue(t.client_id, t.agent, t.resource);
    }
    return err('unsupported_grant_type', 'Use authorization_code or refresh_token.');
  }

  #issue(client: string, agent: string, resource: string) {
    const access = token('mat');
    const refresh = token('mrt');
    const now = this.#now();
    const ins = this.#db.prepare('INSERT INTO oauth_tokens (token_hash, kind, client_id, agent, resource, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    ins.run(hash(access), 'access', client, agent, resource, now + OAUTH.accessMs, now);
    ins.run(hash(refresh), 'refresh', client, agent, resource, now + OAUTH.refreshMs, now);
    return { access_token: access, token_type: 'Bearer', expires_in: OAUTH.accessMs / 1000, refresh_token: refresh, scope: OAUTH.scope };
  }

  /** The agent a bearer token acts as, for this resource; null for anything else. */
  verify(bearer: string | undefined, resource: string): string | null {
    if (!bearer || !/^mat_[A-Za-z0-9_-]{43}$/.test(bearer)) return null;
    const t: any = this.#db.prepare("SELECT agent, resource, expires_at FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'").get(hash(bearer));
    return t && t.expires_at > this.#now() && t.resource === resource ? t.agent : null;
  }

  /** Clients with a live authorization, per agent, for Settings. */
  authorized(): { client: string; name: string; agent: string; since: number }[] {
    return (this.#db.prepare(`SELECT t.client_id, c.name, t.agent, MIN(t.created_at) AS since FROM oauth_tokens t JOIN oauth_clients c ON c.client_id = t.client_id
                               WHERE t.expires_at > ? GROUP BY t.client_id, t.agent ORDER BY since`).all(this.#now()) as any[])
      .map((r) => ({ client: r.client_id, name: r.name, agent: r.agent, since: r.since }));
  }

  /** Revokes a client for an agent: its tokens stop working at once. */
  revoke(client: string, agent: string) {
    this.#db.prepare('DELETE FROM oauth_tokens WHERE client_id = ? AND agent = ?').run(client, agent);
    this.#db.prepare('DELETE FROM oauth_codes WHERE client_id = ? AND agent = ?').run(client, agent);
  }
}
