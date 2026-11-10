// Removing an agent from this computer (SPEC §16.27). The network keeps its
// handle, its signed events, and its messages; this erases what the app holds
// for it, in one transaction, after its display name is typed exactly.
import { tx, type Db } from './db.ts';

/** Kept when an agent goes: the wallet's spending record still counts against its 24-hour budget. */
const KEEP = new Set(['payments']);

/** Every table with an `agent` column, so a table added later is covered without a list to keep in step. */
export function agentTables(db: Db): string[] {
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as any[]).map((r) => r.name as string);
  return names.filter((t) => !KEEP.has(t) && (db.prepare(`PRAGMA table_info("${t.replace(/"/g, '""')}")`).all() as any[]).some((c) => c.name === 'agent'));
}

/** What removing would lose that the dialog names: messages queued and never sent. */
export function removalPreview(db: Db, agent: string): { queued: number } {
  const queued = (db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE agent = ?').get(agent) as any).n as number;
  return { queued };
}

export function removeAgent(db: Db, agent: string, confirm: string): { name: string } {
  const row = db.prepare('SELECT display_name, name FROM agents WHERE id = ?').get(agent) as any;
  if (!row) throw new Error('There is no such agent on this computer.');
  if (typeof confirm !== 'string' || confirm.trim() !== String(row.display_name).trim()) {
    throw new Error(`Type the agent's name, ${row.display_name}, to remove it.`);
  }
  const tables = agentTables(db);
  const metaKeys = (db.prepare('SELECT key FROM meta').all() as any[]).map((r) => r.key as string).filter((k) => k.endsWith(`:${agent}`));
  tx(db, () => {
    for (const t of tables) db.prepare(`DELETE FROM "${t.replace(/"/g, '""')}" WHERE agent = ?`).run(agent);
    for (const k of metaKeys) db.prepare('DELETE FROM meta WHERE key = ?').run(k);
    db.prepare('DELETE FROM agents WHERE id = ?').run(agent);
  });
  return { name: row.name as string };
}
