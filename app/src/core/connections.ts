// Connections (SPEC §16.2, §16.7): each agent has one, with a type and a
// name, and a random token its bridge or client presents to the app's loopback
// interfaces. The token names the agent, so a connection can only ever act as
// its own agent. It is kept sealed (so Settings can show it or write it into a
// client's configuration), and found by its SHA-256.

import { createHash, randomBytes } from 'node:crypto';
import type { Db } from './db.ts';
import type { Vault } from './vault.ts';

export type ConnectionType = 'claude' | 'chatgpt' | 'other' | 'runner';

const hash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

export class Connections {
  #db: Db;
  #vault: Vault;

  constructor({ db, vault }: { db: Db; vault: Vault }) {
    this.#db = db;
    this.#vault = vault;
  }

  /** Sets the agent's connection, with a new token. Returns the token. */
  set(agent: string, type: ConnectionType, name: string): string {
    const token = `mdw_${randomBytes(32).toString('base64url')}`;
    this.#db.prepare(`INSERT OR REPLACE INTO connections (agent, type, name, token_sealed, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(agent, type, name, this.#vault.seal(`connection:${agent}:token`, token), hash(token), Date.now());
    return token;
  }

  /** A new token for the agent's connection; the old one stops working at once. */
  rotate(agent: string): string {
    const c = this.get(agent);
    if (!c) throw new Error('This agent has no connection.');
    return this.set(agent, c.type, c.name);
  }

  get(agent: string): { type: ConnectionType; name: string } | null {
    return (this.#db.prepare('SELECT type, name FROM connections WHERE agent = ?').get(agent) as any) ?? null;
  }

  token(agent: string): string | null {
    const r: any = this.#db.prepare('SELECT token_sealed FROM connections WHERE agent = ?').get(agent);
    return r ? this.#vault.open(`connection:${agent}:token`, r.token_sealed).toString('utf8') : null;
  }

  /** The agent a presented token acts as, or null. */
  resolve(token: string | undefined): { agent: string; type: ConnectionType } | null {
    if (!token || !/^mdw_[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return (this.#db.prepare('SELECT agent, type FROM connections WHERE token_hash = ?').get(hash(token)) as any) ?? null;
  }
}
