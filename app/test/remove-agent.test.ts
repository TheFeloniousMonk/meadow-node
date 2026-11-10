// Removing an agent (SPEC §16.27): only after its name is typed exactly; every
// row the app keeps for it goes, in every table with an `agent` column; the
// wallet, the other agents, and the budget's spending record stay; its Claude
// Desktop entry goes; and a backup made before brings it back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Catalog } from '../src/core/catalog.ts';
import { Services } from '../src/app/services.ts';
import { createHandlers } from '../src/app/handlers.ts';
import { agentTables, removeAgent } from '../src/core/remove.ts';
import { makeBackup, readBackup, restoreBackup } from '../src/core/backup.ts';

function setup() {
  const catalog = new Catalog({ fetchImpl: (async () => new Response(JSON.stringify({ services: [] }))) as unknown as typeof fetch });
  const s = new Services({ dbPath: ':memory:', masterKey: randomBytes(32), version: 'test', changed: () => {}, catalog });
  const config = join(mkdtempSync(join(tmpdir(), 'meadow-remove-')), 'claude_desktop_config.json');
  let running: boolean | null = false;
  const handle = createHandlers(s, {
    execPath: 'C:/Apps/Meadow/Meadow.exe', bridgeScript: 'C:/Data/Meadow/bridge/meadow-bridge.js', claudeConfigPath: config,
    claudeRunning: async () => running, copy: () => {}, openExternal: () => {}, saveFile: async () => null, openFile: async () => null, confirmMove: async () => false,
  });
  return { s, handle, config, setRunning: (r: boolean | null) => { running = r; } };
}

/** Rows that belong to `agent` in every table that has an `agent` column, plus its own row and meta entries. */
function footprint(s: Services, agent: string) {
  const out: Record<string, number> = {};
  for (const t of [...agentTables(s.db), 'payments']) out[t] = (s.db.prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE agent = ?`).get(agent) as any).n;
  out.agents = (s.db.prepare('SELECT COUNT(*) AS n FROM agents WHERE id = ?').get(agent) as any).n;
  out.meta = (s.db.prepare('SELECT key FROM meta').all() as any[]).filter((r) => r.key.endsWith(`:${agent}`)).length;
  return out;
}

function fill(s: Services, agent: string, wallet: string) {
  s.connections.set(agent, 'claude', s.core.agents().find((a) => a.id === agent)!.name);
  s.wallets.assign(agent, wallet);
  s.activity.add(agent, 'you', 'settings', 'Something happened.');
  s.notes.set(agent, 'agent', '', 'Remember the meadow.', 'you');
  const now = Date.now();
  s.db.prepare('INSERT INTO trusted_senders (agent, author, at) VALUES (?, ?, ?)').run(agent, 'a_friend', now);
  s.db.prepare('INSERT INTO hints (agent, key, at) VALUES (?, ?, ?)').run(agent, 'room_modes', now);
  s.db.prepare('INSERT INTO problems (agent, at, kind, text) VALUES (?, ?, ?, ?)').run(agent, now, 'sync', 'A test problem.');
  s.db.prepare('INSERT INTO oauth_tokens (token_hash, kind, client_id, agent, resource, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(`h_${agent}`, 'access', 'c1', agent, 'https://x/mcp', now + 3600_000, now);
  s.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(`sync_ok:${agent}`, String(now));
  s.db.prepare(`INSERT INTO payments (wallet, agent, service, path, amount, asset, network, pay_to, nonce, valid_before, signed_at, status)
                VALUES (?, ?, 'meadow', '/v2/sync', '5000', 'usdc', 'base', '0xpay', ?, ?, ?, 'settled')`).run(wallet, agent, `n_${agent}`, now + 60_000, now);
}

test('removing an agent erases what the app keeps for it, and nothing of the others', async () => {
  const { s, handle, config } = setup();
  const w = s.wallets.create('Everyday', '1.00');
  const a = s.core.createAgent('Chappy').id;
  const b = s.core.createAgent('Juniper').id;
  fill(s, a, w.id);
  fill(s, b, w.id);
  assert.deepEqual(await handle('connectClaude', { agent: a }), { ok: true });
  assert.deepEqual(await handle('connectClaude', { agent: b }), { ok: true });
  const before = footprint(s, a);
  for (const t of ['connections', 'activity', 'notes', 'trusted_senders', 'hints', 'problems', 'oauth_tokens', 'payments', 'agents', 'meta']) assert.ok(before[t] > 0, `seeded ${t}`);
  const others = footprint(s, b);
  const token = s.connections.token(a);
  assert.ok(token);

  const res: any = await handle('removeAgent', { agent: a, confirm: '  Chappy ' });
  assert.equal(res.ok, true);
  assert.equal(res.claudeRunning, false);

  const after = footprint(s, a);
  for (const [t, n] of Object.entries(after)) assert.equal(n, t === 'payments' ? before.payments : 0, `${t} after removal`);
  assert.deepEqual(footprint(s, b), others, 'the other agent is untouched');
  assert.deepEqual(s.core.agents().map((x) => x.id), [b]);
  assert.ok(s.db.prepare('SELECT 1 FROM wallets WHERE id = ?').get(w.id), 'the wallet stays');
  assert.equal(s.connections.token(a), null);
  const servers = JSON.parse(readFileSync(config, 'utf8')).mcpServers;
  assert.deepEqual(Object.keys(servers), ['meadow-juniper'], 'only the removed agent\'s Claude entry goes');
  s.stop();
});

test('the name must be typed exactly, and the core checks it again', async () => {
  const { s, handle } = setup();
  const a = s.core.createAgent('Chappy').id;
  assert.match(((await handle('removeAgent', { agent: a, confirm: 'chappy' })) as any).error, /Type the agent's name, Chappy/);
  assert.match(((await handle('removeAgent', { agent: a, confirm: '' })) as any).error, /Type the agent's name/);
  assert.throws(() => removeAgent(s.db, a, 'Chap'), /Type the agent's name/);
  assert.equal(s.core.agents().length, 1);
  assert.match(((await handle('removeAgent', { agent: 'a_nobody', confirm: 'x' })) as any).error, /no such agent/);
  s.stop();
});

test('the dialog names queued messages, and says to restart a running Claude Desktop', async () => {
  const { s, handle, setRunning } = setup();
  const a = s.core.createAgent('Chappy').id;
  assert.deepEqual(await handle('removalPreview', { agent: a }), { queued: 0 });
  s.db.prepare("INSERT INTO outbox (agent, id, room, kind, event, added_at) VALUES (?, 'e1', 'r1', 'msg.post', '{}', ?)").run(a, Date.now());
  assert.deepEqual(await handle('removalPreview', { agent: a }), { queued: 1 });
  setRunning(true);
  const res: any = await handle('removeAgent', { agent: a, confirm: 'Chappy' });
  assert.equal(res.claudeRunning, true);
  assert.equal((s.db.prepare('SELECT COUNT(*) AS n FROM outbox').get() as any).n, 0, 'queued messages are never sent');
  s.stop();
});

test('a backup made before removing brings the agent back, without its wallet', async () => {
  const { s, handle } = setup();
  const w = s.wallets.create('Everyday', '1.00');
  const a = s.core.createAgent('Chappy').id;
  fill(s, a, w.id);
  const file = makeBackup(s.db, s.vault, a, 'correct horse battery');
  await handle('removeAgent', { agent: a, confirm: 'Chappy' });
  assert.equal(s.core.agents().length, 0);
  const { agent, replaced } = restoreBackup(s.db, s.vault, readBackup(file, 'correct horse battery'));
  assert.equal(agent, a);
  assert.equal(replaced, false, 'it comes back as a new arrival');
  assert.equal(s.core.agents()[0].display_name, 'Chappy');
  assert.equal((s.db.prepare('SELECT wallet FROM agents WHERE id = ?').get(a) as any).wallet, null, 'its wallet is chosen again');
  assert.equal((s.db.prepare('SELECT COUNT(*) AS n FROM notes WHERE agent = ?').get(a) as any).n, 1, 'its notes come back');
  s.stop();
});
