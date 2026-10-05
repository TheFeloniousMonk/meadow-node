// One live combined sync (SPEC §7.9, §16.8) on MainNet through the agentic
// portal: reopens a computer from an earlier live end-to-end run (its agents
// are registered), pays from the current test wallet with a small daily cap,
// and syncs its agents in one /v2/sync-batch call. Not part of the app.
//
//   node scripts/live-batch.ts <live run folder>/A
//
// The test wallet's phrase is read in this process only, never printed.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/core/db.ts';
import { Vault } from '../src/core/vault.ts';
import { Catalog, formatUsd } from '../src/core/catalog.ts';
import { Services } from '../src/app/services.ts';

const dir = process.argv[2];
if (!dir) throw new Error('Give the folder of a computer from a live run, such as ~/.meadow-app-dev/live-e2e/live-…/A');

function testWallet(): { address: string; phrase: string } {
  const pc = join(homedir(), '.meadow-app-dev', 'paid-call');
  const db = openDb(join(pc, 'app.db'));
  const vault = new Vault(readFileSync(join(pc, 'master.key')));
  const row: any = db.prepare('SELECT w.id, w.address, w.secret_sealed FROM wallets w JOIN agents a ON a.wallet = w.id LIMIT 1').get()
    ?? db.prepare('SELECT id, address, secret_sealed FROM wallets LIMIT 1').get();
  const phrase = vault.openJson(`wallet:${row.id}:secret`, row.secret_sealed).mnemonic as string;
  db.close();
  return { address: row.address, phrase };
}

const catalog = new Catalog();
await catalog.refresh();
const s = new Services({ dbPath: join(dir, 'app.db'), masterKey: readFileSync(join(dir, 'master.key')), version: 'live-batch', changed: () => {}, catalog });
const current = testWallet();
let wallet = s.wallets.list().find((w) => w.address.toLowerCase() === current.address.toLowerCase())?.id;
if (!wallet) wallet = s.wallets.import('Test wallet', current.phrase, '0.05').id;
s.wallets.setBudget(wallet, '0.05');
const agents = s.core.agents().filter((a) => a.registered);
for (const a of agents) s.wallets.assign(a.id, wallet);
console.log(`Agents: ${agents.map((a) => a.handle).join(', ')}; wallet ${current.address}.`);

const since = (s.db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM payments').get() as any).n;
const results = await s.syncAll('person');
for (const r of results) console.log(`${agents.find((a) => a.id === r.agent)?.handle}: ${r.ok ? 'ok' : 'FAILED'}, ${r.message}`);
for (const p of s.db.prepare('SELECT path, amount, status, tx FROM payments WHERE seq > ? ORDER BY seq').all(since) as any[]) {
  console.log(`paid ${p.path} ${formatUsd(BigInt(p.amount))} ${p.status}${p.tx ? ` tx ${p.tx}` : ''}`);
}
console.log(`Combined syncs off for now: ${s.core.batchOff()}`);
s.stop();
