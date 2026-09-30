// The app's local state (SPEC §16.1): one node:sqlite database in the user's
// data folder. Columns named *_sealed hold values sealed by the Vault; pickle
// columns hold vodozemac pickles, encrypted with the agent's pickle key.

import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- One row per agent on this computer (SPEC §16.2).
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  name TEXT NOT NULL,
  secret_sealed BLOB NOT NULL,          -- {seed}
  account TEXT NOT NULL,                -- Olm account pickle (§8.2)
  fallback TEXT NOT NULL,               -- the current fallback key, as published
  fallback_used INTEGER NOT NULL DEFAULT 0,
  fallback_rotated_at INTEGER NOT NULL DEFAULT 0,
  chain_head TEXT,                      -- this agent's own chain head (§5.4)
  registered_at INTEGER,                -- when a node accepted agent.register
  wallet TEXT,                          -- the wallet that pays for it (§16.2)
  created_at INTEGER NOT NULL
);

-- Wallets (§16.9): a recovery phrase, sealed; USDC on Base.
CREATE TABLE IF NOT EXISTS wallets (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT NOT NULL UNIQUE,
  secret_sealed BLOB NOT NULL,          -- {mnemonic}
  daily_budget TEXT NOT NULL,           -- token base units per any 24 hours
  created_at INTEGER NOT NULL
);

-- Every payment the core signed (§16.9, §16.10.4). It counts against the budget from
-- the moment it is signed. status: signed, settled, failed (not settled by the portal).
CREATE TABLE IF NOT EXISTS payments (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet TEXT NOT NULL, agent TEXT, service TEXT NOT NULL, path TEXT NOT NULL,
  amount TEXT NOT NULL, asset TEXT NOT NULL, network TEXT NOT NULL, pay_to TEXT NOT NULL,
  nonce TEXT NOT NULL, valid_before INTEGER NOT NULL,
  signed_at INTEGER NOT NULL, status TEXT NOT NULL, tx TEXT, error TEXT
);
CREATE INDEX IF NOT EXISTS payments_wallet ON payments (wallet, signed_at);

-- Money the person moved out of a wallet (§16.9.1). Not a payment: it never counts
-- against the budget. status: sending, sent (not yet seen in a block), done, failed.
CREATE TABLE IF NOT EXISTS moves (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet TEXT NOT NULL, address TEXT NOT NULL, to_address TEXT NOT NULL,
  amount TEXT, swap_order TEXT, swap_sell TEXT, tx TEXT,
  status TEXT NOT NULL, error TEXT, at INTEGER NOT NULL
);

-- The agent's own chain events, as signed.
CREATE TABLE IF NOT EXISTS own_chain (
  agent TEXT NOT NULL, id TEXT NOT NULL, event TEXT NOT NULL, seq INTEGER NOT NULL,
  PRIMARY KEY (agent, id)
);

-- Events waiting to be sent, in order (§7.2). reason: why the last sync left it pending.
CREATE TABLE IF NOT EXISTS outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL, id TEXT NOT NULL, room TEXT, kind TEXT NOT NULL,
  event TEXT NOT NULL, reason TEXT, added_at INTEGER NOT NULL,
  UNIQUE (agent, id)
);

-- Rooms the agent knows. status: joined, reading, invited, left, removed, banned, expired.
CREATE TABLE IF NOT EXISTS rooms (
  agent TEXT NOT NULL, room TEXT NOT NULL,
  type TEXT, status TEXT NOT NULL,
  cursor TEXT,                          -- the heads to send in /v2/sync (JSON), null for none yet
  invite TEXT,                          -- the invite entry from /v2/sync (JSON)
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (agent, room)
);

-- Room events as the agent's own Room processed them (§6.6), in arrival order.
CREATE TABLE IF NOT EXISTS events (
  agent TEXT NOT NULL, room TEXT NOT NULL, id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event TEXT NOT NULL,                  -- {header, id, sig}
  outcome TEXT NOT NULL,                -- JSON: the Room's result
  content TEXT,                         -- as served; ciphertext in private rooms
  withheld TEXT,
  PRIMARY KEY (agent, id)
);
CREATE INDEX IF NOT EXISTS events_room ON events (agent, room, seq);

-- Messages (msg.post) with their status (§8.7): shown, missing_key, undecryptable,
-- replayed, bad_commitment, unsupported, withheld, deleted. body_sealed holds
-- {body, k_f} (k_f only in private rooms, for reports, §9.2).
CREATE TABLE IF NOT EXISTS messages (
  agent TEXT NOT NULL, id TEXT NOT NULL, room TEXT NOT NULL, author TEXT NOT NULL,
  ts INTEGER NOT NULL, status TEXT NOT NULL,
  body_sealed BLOB,
  session TEXT, idx INTEGER,
  slot TEXT,                            -- room|author|session|index once decrypted, for replays
  checked TEXT,                         -- ok or bad_commitment, for the decrypted
  delivered INTEGER NOT NULL DEFAULT 0, -- given to the agent (§16.10.2)
  received_at INTEGER NOT NULL,
  PRIMARY KEY (agent, id)
);
CREATE INDEX IF NOT EXISTS messages_room ON messages (agent, room, ts);
CREATE INDEX IF NOT EXISTS messages_slot ON messages (agent, slot);
CREATE INDEX IF NOT EXISTS messages_session ON messages (agent, room, author, session);

-- Other agents as this agent knows them: the key bundle from a verified chain (§8.2).
CREATE TABLE IF NOT EXISTS peers (
  agent TEXT NOT NULL, peer TEXT NOT NULL,
  name TEXT, curve25519 TEXT NOT NULL, fallback TEXT NOT NULL,
  head TEXT, chain TEXT,                -- the verified chain (JSON), for rooms' key resolution
  verified_at INTEGER NOT NULL,
  PRIMARY KEY (agent, peer)
);

-- Each agent's one connection (§16.2, §16.7): its type, its name, and the token its
-- bridge or client presents on loopback. The token is sealed; its hash finds the agent.
CREATE TABLE IF NOT EXISTS connections (
  agent TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL,
  token_sealed BLOB NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
);

-- OAuth for the tunneled MCP interface (§16.7.2). The app is both the authorization
-- server and the resource. Codes and tokens are stored as SHA-256 hashes only.
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY, name TEXT, redirect_uris TEXT NOT NULL, created_at INTEGER NOT NULL
);
-- An authorization request waiting for the person's decision in the app window.
CREATE TABLE IF NOT EXISTS oauth_requests (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, agent TEXT NOT NULL, redirect_uri TEXT NOT NULL,
  state TEXT, challenge TEXT NOT NULL, resource TEXT NOT NULL, match TEXT NOT NULL,
  created_at INTEGER NOT NULL, decision TEXT, code TEXT
);
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, agent TEXT NOT NULL, redirect_uri TEXT NOT NULL,
  challenge TEXT NOT NULL, resource TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, client_id TEXT NOT NULL, agent TEXT NOT NULL,
  resource TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
);

-- The built-in runner (§16.7.3), per agent: the model endpoint, and the rooms it may act in.
CREATE TABLE IF NOT EXISTS runners (
  agent TEXT PRIMARY KEY, enabled INTEGER NOT NULL, provider TEXT NOT NULL, endpoint TEXT NOT NULL,
  model TEXT NOT NULL, key_sealed BLOB, rooms TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runner_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL, at INTEGER NOT NULL, text TEXT NOT NULL
);

-- Handles this agent has interacted with, pinned to the agent ID they had then (§3.2).
-- Names nodes gave for other agents in sync answers (§7.2 authors, §16.8), not yet
-- verified: shown until a verified chain (peers) replaces them; never pinned, never keys.
-- asked_at paces chain requests; too_large marks an agent whose chain no node will send.
CREATE TABLE IF NOT EXISTS author_names (
  agent TEXT NOT NULL, peer TEXT NOT NULL,
  name TEXT NOT NULL, head TEXT NOT NULL, node TEXT,
  seen_at INTEGER NOT NULL, asked_at INTEGER, too_large INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent, peer)
);

-- Authors of stored messages that no sync ever named (§16.8 backfill): when their chain
-- was last asked for, and whether a node said it is too large. Pacing only.
CREATE TABLE IF NOT EXISTS name_backfill (
  agent TEXT NOT NULL, peer TEXT NOT NULL, asked_at INTEGER NOT NULL, too_large INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent, peer)
);

CREATE TABLE IF NOT EXISTS pins (
  agent TEXT NOT NULL, handle TEXT NOT NULL, peer TEXT NOT NULL, first_seen INTEGER NOT NULL,
  PRIMARY KEY (agent, handle)
);

-- Encryption state (§8.9).
CREATE TABLE IF NOT EXISTS olm_sessions (
  agent TEXT NOT NULL, peer TEXT NOT NULL, session_id TEXT NOT NULL,
  pickle TEXT NOT NULL, created INTEGER NOT NULL, last_decrypt INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent, peer, session_id)
);
CREATE TABLE IF NOT EXISTS group_out (
  agent TEXT NOT NULL, room TEXT NOT NULL, session_id TEXT NOT NULL,
  pickle TEXT NOT NULL, copy TEXT NOT NULL,
  recipients TEXT NOT NULL, count INTEGER NOT NULL, messages TEXT NOT NULL,
  created_at INTEGER NOT NULL, seq INTEGER NOT NULL,
  PRIMARY KEY (agent, room, session_id)
);
CREATE TABLE IF NOT EXISTS group_in (
  agent TEXT NOT NULL, room TEXT NOT NULL, sender TEXT NOT NULL, session_id TEXT NOT NULL,
  pickle TEXT NOT NULL, first_index INTEGER NOT NULL,
  PRIMARY KEY (agent, room, sender, session_id)
);
CREATE TABLE IF NOT EXISTS group_bind (
  agent TEXT NOT NULL, room TEXT NOT NULL, session_id TEXT NOT NULL, sender TEXT NOT NULL,
  PRIMARY KEY (agent, room, session_id)
);
-- What each room.keys event did (§8.5, §8.6): accepted, request, ignored:*, discarded:*.
CREATE TABLE IF NOT EXISTS keys_log (
  agent TEXT NOT NULL, id TEXT NOT NULL, room TEXT NOT NULL, outcome TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (agent, id)
);
CREATE TABLE IF NOT EXISTS requests_in (
  agent TEXT NOT NULL, id TEXT NOT NULL, room TEXT NOT NULL, requester TEXT NOT NULL,
  sessions TEXT NOT NULL, answered INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent, id)
);
-- Key request pacing (§8.6): kind 'ask' (peer = owner) or 'answer' (peer = requester).
CREATE TABLE IF NOT EXISTS key_pace (
  agent TEXT NOT NULL, kind TEXT NOT NULL, room TEXT NOT NULL, session_id TEXT NOT NULL, peer TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (agent, kind, room, session_id, peer)
);

-- The activity log (§16.18): what changed, who caused it, in plain sentences; never message
-- text. ext marks a sentence holding text other agents wrote (room names, notes), fenced for the AI.
CREATE TABLE IF NOT EXISTS activity (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL, at INTEGER NOT NULL, who TEXT NOT NULL, kind TEXT NOT NULL,
  text TEXT NOT NULL, room TEXT, ext INTEGER NOT NULL DEFAULT 0,
  UNIQUE (agent, at, who, kind, text)
);
CREATE INDEX IF NOT EXISTS activity_agent ON activity (agent, at);

-- Connection diagnostics (§16.17.1): times and outcomes only, never a token, argument,
-- body, or message. Each call from a connection, and events counted rather than repeated.
CREATE TABLE IF NOT EXISTS conn_calls (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL, at INTEGER NOT NULL, via TEXT NOT NULL, name TEXT NOT NULL,
  outcome TEXT NOT NULL, ms INTEGER NOT NULL, error TEXT
);
CREATE INDEX IF NOT EXISTS conn_calls_agent ON conn_calls (agent, seq);
CREATE TABLE IF NOT EXISTS conn_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, what TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
  first_at INTEGER NOT NULL, last_at INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 1,
  UNIQUE (agent, kind, what, detail)
);

-- Refusals and errors for the Dashboard (§16.10.1), in plain words.
CREATE TABLE IF NOT EXISTS problems (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT, at INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL
);
`;

/**
 * Columns added after a table was first created: added to existing databases
 * on open, so a data folder from an earlier build keeps working.
 */
const COLUMNS: [table: string, column: string, definition: string][] = [
  // MessageGuard (§16.11): the verdict, the patterns that matched, and whether the message is held for the person.
  ['messages', 'guard', 'TEXT'],
  ['messages', 'guard_matches', 'TEXT'],
  ['messages', 'held', 'INTEGER NOT NULL DEFAULT 0'],
  // Backups (§16.12) and the backup nudge (§8.9).
  ['agents', 'last_backup_at', 'INTEGER'],
  ['group_in', 'received_at', 'INTEGER NOT NULL DEFAULT 0'],
  // A restore keeps Olm sessions for receiving only (§8.9).
  ['olm_sessions', 'send', 'INTEGER NOT NULL DEFAULT 1'],
  // Where a ChatGPT sign-in request came from, to keep one waiting per source (§16.7.2).
  ['oauth_requests', 'source', "TEXT NOT NULL DEFAULT ''"],
  // What the agent may do (§16.7.5): all, no_new (no new conversations), or porch (read only).
  ['agents', 'may', "TEXT NOT NULL DEFAULT 'all'"],
  // Per-room settings, local only (§16.10.2): MessageGuard (default, always, never) and notifications (normal, priority, muted).
  ['rooms', 'guard_mode', "TEXT NOT NULL DEFAULT 'default'"],
  ['rooms', 'notify', "TEXT NOT NULL DEFAULT 'normal'"],
];

export function openDb(path = ':memory:'): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  for (const [table, column, definition] of COLUMNS) {
    const have = (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).some((c) => c.name === column);
    if (!have) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  return db;
}

/** Runs fn in a transaction; nested calls join the outer one. */
export function tx<T>(db: Db, fn: () => T): T {
  if ((db as any).isTransaction) return fn();
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
