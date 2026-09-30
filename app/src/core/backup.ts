// Backups (SPEC §16.12, §8.9): one agent in one file, `<agent>.meadow-backup`.
//
// The file is a header line in the clear, then the encrypted contents:
//
//   {"meadow_backup":1,"kdf":{"alg":"argon2id","memory":65536,"passes":3,"parallelism":4},"salt":"…","nonce":"…"}
//   <base64 of AES-256-GCM ciphertext and tag>
//
// The key comes from the person's password with Argon2id (Node's built-in),
// and the header line is the GCM additional data, so it cannot be changed
// without the file failing to open. The contents are the agent's identity
// key, its chain, all its encryption state (the Olm account and sessions, the
// group sessions it created and received, bindings, the indexes it has seen),
// its rooms, events, and messages, its names, and its connection's type and
// name. Not its wallet: a wallet's recovery phrase is its backup. Not the
// connection's token: a restore makes a new one.
//
// vodozemac state is pickled under the local pickle key, which a restore on
// another computer does not have, so the backup carries it re-pickled under a
// random key of its own, inside the encryption.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { argon2id } from '@noble/hashes/argon2.js';
import { tx, type Db } from './db.ts';
import { wasm } from './deps.ts';
import { signerFromSeed } from './identity.ts';
import type { Vault } from './vault.ts';
import { Activity } from './activity.ts';

export const BACKUP_FORMAT = 1;
export const KDF = { alg: 'argon2id', memory: 65536, passes: 3, parallelism: 4 } as const;
const DAY = 24 * 3600 * 1000;

// Per-agent tables, with the columns that need converting.
const TABLES = ['own_chain', 'outbox', 'rooms', 'events', 'messages', 'peers', 'author_names', 'pins', 'olm_sessions', 'group_out', 'group_in', 'group_bind', 'keys_log', 'requests_in', 'key_pace'] as const;

type Rows = Record<string, any[]>;
interface Contents {
  format: number;
  created_at: number;
  agent: any;
  seed: string;
  pickle_key: string;
  account: string;
  connection: { type: string; name: string } | null;
  tables: Rows;
  /** The activity log (§16.18), merged on restore; absent in backups made before app 0.1.3. */
  activity?: unknown[];
}

export class BackupError extends Error {}

// Argon2id in JavaScript (noble): Electron's crypto library (BoringSSL) has no Argon2, so
// node:crypto's argon2Sync throws there. The output is byte-identical to it (checked
// 2026-09-29), so files made either way open either way; it takes under a second.
const deriveKey = (password: string, salt: Buffer) =>
  Buffer.from(argon2id(Buffer.from(password.normalize('NFC'), 'utf8'), salt, { t: KDF.passes, m: KDF.memory, p: KDF.parallelism, dkLen: 32 }));

/** A backup file of one agent, encrypted under `password`. */
export function makeBackup(db: Db, vault: Vault, agent: string, password: string, now = Date.now()): Buffer {
  if (password.length < 8) throw new BackupError('Choose a password of at least 8 characters.');
  const a: any = db.prepare('SELECT * FROM agents WHERE id = ?').get(agent);
  if (!a) throw new BackupError('There is no such agent.');
  const local = vault.pickleKey(agent);
  const key = randomBytes(32);
  const repickle = (cls: any, p: string) => cls.fromPickle(p, local).pickle(key);

  const tables: Rows = {};
  for (const t of TABLES) {
    tables[t] = (db.prepare(`SELECT * FROM ${t} WHERE agent = ?`).all(agent) as any[]).map((r) => {
      const row = { ...r };
      delete row.seq; // outbox and own_chain sequence numbers are local; order is kept by position
      if (t === 'own_chain' || t === 'outbox' || t === 'events') row._order = r.seq;
      if (t === 'messages' && r.body_sealed) row.body_sealed = vault.openJson(`message:${agent}:${r.id}`, r.body_sealed);
      if (t === 'olm_sessions') row.pickle = repickle(wasm.Session, r.pickle);
      if (t === 'group_out') {
        row.pickle = repickle(wasm.GroupSession, r.pickle);
        row.copy = repickle(wasm.InboundGroupSession, r.copy);
        row._order = r.seq;
      }
      if (t === 'group_in') row.pickle = repickle(wasm.InboundGroupSession, r.pickle);
      return row;
    });
  }
  const { secret_sealed, account, ...agentRow } = a;
  const contents: Contents = {
    format: BACKUP_FORMAT,
    created_at: now,
    agent: { ...agentRow, wallet: null },
    seed: vault.openJson(`agent:${agent}:secret`, secret_sealed).seed,
    pickle_key: key.toString('base64'),
    account: repickle(wasm.Account, account),
    connection: (db.prepare('SELECT type, name FROM connections WHERE agent = ?').get(agent) as any) ?? null,
    tables,
    activity: new Activity({ db }).all(agent),
  };

  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const header = JSON.stringify({ meadow_backup: BACKUP_FORMAT, kdf: KDF, salt: salt.toString('base64'), nonce: nonce.toString('base64') });
  const cipher = createCipheriv('aes-256-gcm', deriveKey(password, salt), nonce);
  cipher.setAAD(Buffer.from(header, 'utf8'));
  const ct = Buffer.concat([cipher.update(JSON.stringify(contents), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  db.prepare('UPDATE agents SET last_backup_at = ? WHERE id = ?').run(now, agent);
  return Buffer.from(`${header}\n${ct.toString('base64')}\n`, 'utf8');
}

/** Opens a backup file; throws a BackupError in plain words if it cannot. */
export function readBackup(file: Buffer | string, password: string): Contents {
  const text = file.toString();
  const nl = text.indexOf('\n');
  let header: any;
  try {
    header = JSON.parse(text.slice(0, nl));
  } catch {
    throw new BackupError('This is not a Meadow backup file.');
  }
  if (header?.meadow_backup !== BACKUP_FORMAT) throw new BackupError('This is not a Meadow backup file this version of the app can open.');
  if (header.kdf?.alg !== KDF.alg || header.kdf.memory !== KDF.memory || header.kdf.passes !== KDF.passes || header.kdf.parallelism !== KDF.parallelism) {
    throw new BackupError('This backup uses settings this version of the app does not know.');
  }
  const body = Buffer.from(text.slice(nl + 1).trim(), 'base64');
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(password, Buffer.from(header.salt, 'base64')), Buffer.from(header.nonce, 'base64'));
    decipher.setAAD(Buffer.from(text.slice(0, nl), 'utf8'));
    decipher.setAuthTag(body.subarray(body.length - 16));
    const plain = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch {
    throw new BackupError('The password is wrong, or the file is damaged.');
  }
}

/** What a backup holds, to show the person before restoring. */
export function describeBackup(c: Contents) {
  const rooms = c.tables.rooms ?? [];
  return {
    agent: c.agent.id as string,
    displayName: c.agent.display_name as string,
    name: c.agent.name as string,
    registered: c.agent.registered_at != null,
    createdAt: c.created_at,
    rooms: rooms.filter((r: any) => r.status === 'joined').length,
    privateRooms: rooms.filter((r: any) => r.status === 'joined' && (r.type === 'private' || r.type === 'dm')).length,
  };
}

/**
 * Restores an agent from opened contents. If the agent is already on this
 * computer, it is replaced only when `replace` is true (the app asks first).
 */
export function restoreBackup(db: Db, vault: Vault, c: Contents, { replace = false } = {}): { agent: string; replaced: boolean } {
  const agent = c.agent.id as string;
  // The file is the person's, but may not be what it claims: the agent must be the one its seed makes.
  if (typeof c.seed !== 'string' || signerFromSeed(Buffer.from(c.seed, 'base64')).id !== agent) throw new BackupError('This backup is damaged: its agent does not match its key.');
  const here: any = db.prepare('SELECT wallet FROM agents WHERE id = ?').get(agent);
  const exists = !!here;
  // Replacing an agent already here keeps the wallet it had; a wallet is never in the file.
  const wallet = here?.wallet && db.prepare('SELECT 1 FROM wallets WHERE id = ?').get(here.wallet) ? here.wallet : null;
  if (exists && !replace) throw new BackupError('This agent is already on this computer.');
  const local = vault.pickleKey(agent);
  const key = Buffer.from(c.pickle_key, 'base64');
  const repickle = (cls: any, p: string) => cls.fromPickle(p, key).pickle(local);

  tx(db, () => {
    for (const t of [...TABLES, 'connections', 'agents'] as const) db.prepare(`DELETE FROM ${t} WHERE ${t === 'agents' ? 'id' : 'agent'} = ?`).run(agent);
    // A fresh fallback key goes out with the next sync: the one in the backup may
    // have been replaced by the old copy, and this copy must be reachable (§8.2, §8.9).
    const row = { ...c.agent, fallback_used: 1, fallback_rotated_at: 0, secret_sealed: vault.sealJson(`agent:${agent}:secret`, { seed: c.seed }), account: repickle(wasm.Account, c.account), wallet };
    insert(db, 'agents', row);
    for (const t of TABLES) {
      const rows = [...(c.tables[t] ?? [])].sort((x, y) => (x._order ?? 0) - (y._order ?? 0));
      for (const r of rows) {
        const out: any = { ...r, agent }; // every row belongs to the restored agent, whatever the file says
        delete out._order;
        if (t === 'own_chain' || t === 'events' || t === 'group_out') out.seq = r._order;
        if (t === 'messages' && r.body_sealed) out.body_sealed = vault.sealJson(`message:${agent}:${r.id}`, r.body_sealed);
        // The peers' copies may have moved past these (§8.9): receive on them, never send.
        if (t === 'olm_sessions') {
          out.pickle = repickle(wasm.Session, r.pickle);
          out.send = 0;
        }
        if (t === 'group_out') {
          out.pickle = repickle(wasm.GroupSession, r.pickle);
          out.copy = repickle(wasm.InboundGroupSession, r.copy);
        }
        if (t === 'group_in') out.pickle = repickle(wasm.InboundGroupSession, r.pickle);
        insert(db, t, out);
      }
    }
    // The log is merged, not replaced: entries made here after the backup stay (§16.18.4).
    new Activity({ db }).merge(agent, c.activity);
  });
  return { agent, replaced: exists };
}

function insert(db: Db, table: string, row: Record<string, unknown>) {
  // Only the table's own columns: names from the file never reach the SQL.
  const known = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c) => c.name));
  const cols = Object.keys(row).filter((k) => known.has(k));
  db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...(cols.map((k) => row[k]) as any[]));
}

/**
 * The backup nudge (§8.9): a fresh backup is due once the encryption state
 * holds something the latest backup lacks. Returns what a restore of the old
 * backup would lose, in plain words, or null.
 */
export function backupDue(db: Db, agent: string, now = Date.now()): string | null {
  const a: any = db.prepare('SELECT last_backup_at FROM agents WHERE id = ?').get(agent);
  const last = a?.last_backup_at ?? null;
  const privateRooms = (db.prepare("SELECT COUNT(*) AS n FROM rooms WHERE agent = ? AND status = 'joined' AND type IN ('private', 'dm') AND updated_at > ?").get(agent, last ?? 0) as any).n;
  if (privateRooms) {
    return last === null
      ? 'This agent has private conversations and no backup. If this computer were lost, their history could not be read again.'
      : `This agent joined ${privateRooms} private conversation${privateRooms === 1 ? '' : 's'} since its last backup. Restoring that backup could not read ${privateRooms === 1 ? 'it' : 'them'}.`;
  }
  if (last !== null && now - last >= 7 * DAY) {
    const fresh = (db.prepare('SELECT COUNT(*) AS n FROM group_in WHERE agent = ? AND received_at > ?').get(agent, last) as any).n;
    if (fresh) return `This agent received new encryption keys in the ${Math.floor((now - last) / DAY)} days since its last backup. Restoring that backup would lose some private history.`;
  }
  return null;
}

/**
 * What the latest backup lacks, for Back up again (§16.12): the private rooms and
 * DMs joined since it was made, and the conversations with encryption keys
 * received since. Room IDs; the window names them. Null if never backed up.
 */
export function backupChanges(db: Db, agent: string): { since: number; joined: string[]; newKeys: string[] } | null {
  const last = (db.prepare('SELECT last_backup_at FROM agents WHERE id = ?').get(agent) as any)?.last_backup_at ?? null;
  if (last === null) return null;
  const joined = (db.prepare("SELECT room FROM rooms WHERE agent = ? AND status = 'joined' AND type IN ('private', 'dm') AND updated_at > ? ORDER BY updated_at").all(agent, last) as any[]).map((r) => r.room as string);
  const newKeys = (db.prepare(`SELECT DISTINCT g.room FROM group_in g JOIN rooms r ON r.agent = g.agent AND r.room = g.room AND r.status = 'joined'
    WHERE g.agent = ? AND g.received_at > ?`).all(agent, last) as any[]).map((r) => r.room as string).filter((r) => !joined.includes(r));
  return { since: last, joined, newKeys };
}
