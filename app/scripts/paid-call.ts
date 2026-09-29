// A developer harness for one real paid call through the portal (SPEC §16.9),
// with the core's own wallet, spend guard, and transport. Not part of the app.
//
// State lives outside the repository, in ~/.meadow-app-dev/paid-call/: the
// database and a random master key in a file (the app itself keeps its master
// key in the OS keychain through safeStorage).
//
//   node scripts/paid-call.ts new        create the test wallet; prints its address only
//   node scripts/paid-call.ts balance    its USDC balance on Base
//   node scripts/paid-call.ts call       one paid POST /v2/rooms {} (the public directory)
//   node scripts/paid-call.ts phrase     prints the recovery phrase: run it yourself, to move leftover funds

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/core/db.ts';
import { Vault } from '../src/core/vault.ts';
import { Catalog, formatUsd } from '../src/core/catalog.ts';
import { Wallets } from '../src/core/wallets.ts';
import { PortalTransport } from '../src/core/portal.ts';
import { Core } from '../src/core/core.ts';
import { tokenBalance } from '../src/core/balance.ts';

const dir = join(homedir(), '.meadow-app-dev', 'paid-call');
mkdirSync(dir, { recursive: true });
const keyFile = join(dir, 'master.key');
if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
const db = openDb(join(dir, 'app.db'));
const vault = new Vault(readFileSync(keyFile));
const catalog = new Catalog();
await catalog.refresh();
const wallets = new Wallets({ db, vault, catalog });
const core = new Core({ db, vault, transport: new PortalTransport({ catalog, wallets }) });

const wallet = wallets.list()[0];
const agent = core.agents()[0];
const rail = catalog.baseRail('meadow')!;

switch (process.argv[2]) {
  case 'new': {
    if (wallet) {
      console.log(`A test wallet already exists: ${wallet.address}`);
      break;
    }
    const w = wallets.create('Paid-call test', '0.02');
    const { id } = core.createAgent('paid-call-test');
    wallets.assign(id, w.id);
    console.log(`Test wallet ${w.address} (daily budget $0.02, per-call max $${wallets.perCallMaxUsd()}).`);
    console.log('Send it a little USDC on Base (no ETH needed). The recovery phrase is sealed in', dir);
    break;
  }
  case 'balance':
    console.log(`${wallet.address}: ${formatUsd(await tokenBalance(wallet.address, rail.tokenAddress), rail.tokenDecimals)} USDC on Base`);
    break;
  case 'call': {
    const before = await tokenBalance(wallet.address, rail.tokenAddress);
    const res = await new PortalTransport({ catalog, wallets }).call('/v2/rooms', {}, agent.id);
    console.log('status', res.status, 'cost', res.cost);
    console.log('rooms', JSON.stringify(res.data?.rooms?.map((r: any) => ({ room: r.room, name: r.name, members: r.members }))));
    console.log('payment', wallets.payments(1)[0]);
    console.log(`balance before ${formatUsd(before)}, after ${formatUsd(await tokenBalance(wallet.address, rail.tokenAddress))} (settlement can take a few seconds)`);
    break;
  }
  case 'phrase': {
    const row: any = db.prepare('SELECT id, secret_sealed FROM wallets WHERE id = ?').get(wallet.id);
    console.log(vault.openJson(`wallet:${row.id}:secret`, row.secret_sealed).mnemonic);
    break;
  }
  default:
    console.log('usage: node scripts/paid-call.ts new | balance | call | phrase');
}
