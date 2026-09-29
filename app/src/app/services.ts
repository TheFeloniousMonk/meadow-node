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
import { GUARD_PATH, GUARD_SERVICE, MessageGuard, readScreen } from '../core/guard.ts';
import { createLocalServer } from '../server/local.ts';
import { createPublicServer } from '../server/public.ts';
import { OAuth } from '../core/oauth.ts';
import { Runner } from '../core/runner.ts';
import { Tunnel } from './tunnel.ts';
import type { Settings } from '../shared/api.ts';

export const DEFAULT_SETTINGS: Omit<Settings, 'perCallMaxUsd'> = {
  theme: 'light', textScale: 1, syncEnabled: true, syncMinutes: 15, localPort: 47733,
  // Anything that costs money is off until the person turns it on (§16.11).
  guardPublic: false, guardPrivate: false, guardLimit: 10,
  notifications: true,
  startAtLogin: false,
  publicPort: 47734, tunnelProvider: 'none', tunnelUrl: '',
};

/** How the app tells the person about new messages; the main process shows a system notification. */
export type Notify = (agent: string, displayName: string, count: number, held: number) => void;
/** How the app asks the person to look at a ChatGPT connection request; the main process brings the window forward. */
export type AskApproval = () => void;

export class Services {
  readonly db: Db;
  readonly vault: Vault;
  readonly catalog: Catalog;
  readonly wallets: Wallets;
  readonly core: Core;
  readonly connections: Connections;
  readonly tools: ToolHost;
  readonly transport: PortalTransport;
  readonly guard: MessageGuard;
  readonly oauth: OAuth;
  readonly runner: Runner;
  readonly tunnel: Tunnel;
  publicServer: Server | null = null;
  publicError: string | null = null;
  #notify: Notify;
  #askApproval: AskApproval;
  server: Server | null = null;
  serverError: string | null = null;
  lastSync = new Map<string, number>();
  #timer: NodeJS.Timeout | null = null;
  #changed: () => void;

  readonly version: string;

  constructor({ dbPath, masterKey, version, changed, catalog = new Catalog(), notify = () => {}, askApproval = () => {} }: {
    dbPath: string; masterKey: Uint8Array; version: string; changed: () => void; catalog?: Catalog; notify?: Notify; askApproval?: AskApproval;
  }) {
    this.#notify = notify;
    this.#askApproval = askApproval;
    this.#changed = changed;
    this.version = version;
    this.db = openDb(dbPath);
    this.vault = new Vault(masterKey);
    this.catalog = catalog;
    this.wallets = new Wallets({ db: this.db, vault: this.vault, catalog: this.catalog });
    this.transport = new PortalTransport({ catalog: this.catalog, wallets: this.wallets });
    const guardSettings = () => {
      const s = this.settings();
      return { public: s.guardPublic, private: s.guardPrivate, perSyncLimit: s.guardLimit };
    };
    this.guard = new MessageGuard({
      db: this.db, vault: this.vault, settings: guardSettings,
      screener: async (text, agent) => {
        const r = await this.transport.callService(GUARD_SERVICE, GUARD_PATH, { text }, agent);
        return r.status === 200 ? readScreen(r.data) : null;
      },
    });
    // After every sync, from any path (background, Sync Now, a tool): screen what arrived, then tell the person.
    this.core = new Core({
      db: this.db, vault: this.vault, transport: this.transport,
      afterSync: async (agent, report) => {
        const screened = await this.guard.screenNew(agent);
        if (screened.stopped) this.db.prepare('INSERT INTO problems (agent, at, kind, text) VALUES (?, ?, ?, ?)').run(agent, Date.now(), 'messageguard', `MessageGuard could not check every new message: ${screened.stopped}`);
        if (report.messages && this.settings().notifications) {
          const a = this.core.agents().find((x) => x.id === agent);
          this.#notify(agent, a?.display_name ?? 'Your agent', report.messages, screened.held);
        }
        // The runner acts outside the sync that woke it (the sync holds the agent's lock, and its own writes sync).
        if (this.runner.config(agent)?.enabled) setTimeout(() => void this.runner.run(agent).finally(() => this.#changed()), 0);
        this.#changed();
      },
    });
    this.connections = new Connections({ db: this.db, vault: this.vault });
    this.tools = new ToolHost({ core: this.core, wallets: this.wallets, catalog: this.catalog, guard: guardSettings });
    this.oauth = new OAuth({ db: this.db });
    this.runner = new Runner({ db: this.db, vault: this.vault, host: this.tools });
    this.tunnel = new Tunnel(changed);
  }

  /** The agents ChatGPT may act as, by network name: those whose connection is ChatGPT (§16.7.2). */
  chatgptAgents(): Map<string, { id: string; displayName: string }> {
    const out = new Map<string, { id: string; displayName: string }>();
    for (const a of this.core.agents()) if (this.connections.get(a.id)?.type === 'chatgpt') out.set(a.name, { id: a.id, displayName: a.display_name });
    return out;
  }

  /** The tunneled interface on its loopback port, and the tunnel in Settings. */
  async listenPublic(): Promise<void> {
    if (this.publicServer) await new Promise<void>((r) => this.publicServer!.close(() => r()));
    await this.tunnel.stop();
    const s = this.settings();
    const server = createPublicServer({
      host: this.tools, oauth: this.oauth, version: this.version,
      base: () => this.tunnel.url,
      agents: () => this.chatgptAgents(),
      onRequest: () => {
        this.#changed();
        this.#askApproval();
      },
      onTokens: () => this.#changed(),
    });
    this.publicServer = server;
    const ok = await new Promise<boolean>((resolve) => {
      server.once('error', (err: any) => {
        this.publicError = err.code === 'EADDRINUSE' ? `Port ${s.publicPort} is taken by another program; choose another in Settings.` : err.message;
        this.publicServer = null;
        resolve(false);
      });
      server.listen(s.publicPort, '127.0.0.1', () => {
        this.publicError = null;
        resolve(true);
      });
    });
    if (ok && s.tunnelProvider !== 'none') await this.tunnel.start({ provider: s.tunnelProvider, port: s.publicPort, ngrokToken: this.ngrokToken(), customUrl: s.tunnelUrl });
    this.#changed();
  }

  ngrokToken(): string | null {
    const r: any = this.db.prepare("SELECT value FROM meta WHERE key = 'ngrok_token'").get();
    return r ? this.vault.open('tunnel:ngrok:token', Buffer.from(r.value, 'base64')).toString('utf8') : null;
  }

  /** Sets the tunnel: its provider, the ngrok token (sealed; kept when not given), or a custom public address. */
  async setTunnel(t: { provider: 'none' | 'ngrok' | 'custom'; ngrokToken?: string; url?: string }) {
    if (t.ngrokToken) {
      this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('ngrok_token', ?)").run(Buffer.from(this.vault.seal('tunnel:ngrok:token', t.ngrokToken.trim())).toString('base64'));
    }
    this.setSettings({ tunnelProvider: t.provider, ...(t.url !== undefined && { tunnelUrl: t.url.trim() }) });
    await this.listenPublic();
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
    if (changes.publicPort !== undefined) void this.listenPublic();
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
    this.publicServer?.close();
    void this.tunnel.stop();
    this.db.close();
  }
}
