// The app's core services (SPEC §16.1): the database, the catalog, wallets,
// the portal transport, the core, connections, the tools, the loopback
// server, and the background sync. They run in the main process, which gives
// them the master key from the OS keychain (src/main/index.ts); nothing here
// depends on Electron.

import type { Server } from 'node:http';
import { openDb, type Db } from '../core/db.ts';
import { Vault } from '../core/vault.ts';
import { Catalog } from '../core/catalog.ts';
import { Wallets } from '../core/wallets.ts';
import { PortalTransport } from '../core/portal.ts';
import { Core } from '../core/core.ts';
import { Connections } from '../core/connections.ts';
import { ToolHost } from '../core/tools.ts';
import { createLocalServer } from '../server/local.ts';
import type { Settings } from '../shared/api.ts';

export const DEFAULT_SETTINGS: Omit<Settings, 'perCallMaxUsd'> = {
  theme: 'light', textScale: 1, syncEnabled: true, syncMinutes: 15, localPort: 47733,
};

export class Services {
  readonly db: Db;
  readonly vault: Vault;
  readonly catalog: Catalog;
  readonly wallets: Wallets;
  readonly core: Core;
  readonly connections: Connections;
  readonly tools: ToolHost;
  server: Server | null = null;
  serverError: string | null = null;
  lastSync = new Map<string, number>();
  #timer: NodeJS.Timeout | null = null;
  #changed: () => void;

  readonly version: string;

  constructor({ dbPath, masterKey, version, changed, catalog = new Catalog() }: { dbPath: string; masterKey: Uint8Array; version: string; changed: () => void; catalog?: Catalog }) {
    this.#changed = changed;
    this.version = version;
    this.db = openDb(dbPath);
    this.vault = new Vault(masterKey);
    this.catalog = catalog;
    this.wallets = new Wallets({ db: this.db, vault: this.vault, catalog: this.catalog });
    this.core = new Core({ db: this.db, vault: this.vault, transport: new PortalTransport({ catalog: this.catalog, wallets: this.wallets }) });
    this.connections = new Connections({ db: this.db, vault: this.vault });
    this.tools = new ToolHost({ core: this.core, wallets: this.wallets, catalog: this.catalog });
  }

  settings(): Settings {
    const row: any = this.db.prepare("SELECT value FROM meta WHERE key = 'settings'").get();
    return { ...DEFAULT_SETTINGS, ...(row ? JSON.parse(row.value) : {}), perCallMaxUsd: this.wallets.perCallMaxUsd() };
  }

  setSettings(changes: Partial<Settings>): Settings {
    const { perCallMaxUsd, ...rest } = { ...this.settings(), ...changes };
    if (changes.perCallMaxUsd !== undefined) this.wallets.setPerCallMax(changes.perCallMaxUsd);
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('settings', ?)").run(JSON.stringify(rest));
    if (changes.syncEnabled !== undefined || changes.syncMinutes !== undefined) this.schedule();
    if (changes.localPort !== undefined) void this.listen();
    return this.settings();
  }

  /** The loopback interfaces, on the port in Settings (§16.7.1, §16.7.3). */
  async listen(): Promise<void> {
    if (this.server) await new Promise<void>((r) => this.server!.close(() => r()));
    const server = createLocalServer({
      host: this.tools,
      version: this.version,
      resolve: (token) => {
        const c = this.connections.resolve(token);
        return c && { agent: c.agent, audience: 'person' };
      },
    });
    const port = this.settings().localPort;
    this.server = server;
    await new Promise<void>((resolve) => {
      server.once('error', (err: any) => {
        this.serverError = err.code === 'EADDRINUSE' ? `Port ${port} is taken by another program; choose another in Settings.` : err.message;
        this.server = null;
        resolve();
      });
      server.listen(port, '127.0.0.1', () => {
        this.serverError = null;
        resolve();
      });
    });
    this.#changed();
  }

  /** Background receiving (§16.8): every agent that is registered and has a wallet, on the interval in Settings. */
  schedule() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    const s = this.settings();
    if (!s.syncEnabled) return;
    this.#timer = setInterval(() => void this.syncAll(), s.syncMinutes * 60_000);
  }

  async syncAll() {
    for (const a of this.core.agents().filter((x) => x.registered && this.wallets.walletOf(x.id))) {
      await this.syncOne(a.id).catch(() => {});
    }
  }

  async syncOne(agent: string): Promise<{ ok: boolean; message: string }> {
    try {
      const r = await this.core.sync(agent);
      this.lastSync.set(agent, Date.now());
      return { ok: true, message: r.messages ? `${r.messages} new message${r.messages === 1 ? '' : 's'}.` : 'Nothing new.' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.db.prepare('INSERT INTO problems (agent, at, kind, text) VALUES (?, ?, ?, ?)').run(agent, Date.now(), 'sync', message);
      return { ok: false, message };
    } finally {
      this.#changed();
    }
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.server?.close();
    this.db.close();
  }
}
