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
import { Mover } from '../core/move.ts';
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
import { Diagnostics, syncFailureClass } from '../core/diagnostics.ts';
import { Activity } from '../core/activity.ts';
import { Notes } from '../core/notes.ts';
import type { Received } from '../core/core.ts';
import { UpdateCheck, type InstallKind } from '../core/update.ts';
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
/**
 * New messages for the person (§16.10.2): `count` from rooms set to normal, in one
 * notification; each priority room in one of its own. Muted rooms are left out.
 */
/** A failed sync's kind (§16.17.1), in the activity log's words. */
const SYNC_FAILURE_WORDS: Record<ReturnType<typeof syncFailureClass>, string> = {
  'payment refused': 'the wallet would not pay for it',
  'portal unreachable': 'the app could not reach the Meadow network',
  'reply too large': 'the network sent an answer too large to read',
  portal: 'the portal answered with an error',
  node: 'the Meadow network refused it',
  app: 'the app failed',
};

export type Notify = (agent: string, displayName: string, count: number, held: number, priority: { room: string; title: string; count: number }[], mentions?: MentionNote) => void;

/** Mention notifications (§16.20.3): one per room, at most 5 a sync, and how many more rooms had mentions. */
export type MentionNote = { rooms: { room: string; title: string; by: string; count: number }[]; more: number };
export const MENTION_ROOMS_PER_SYNC = 5;

export class Services {
  readonly db: Db;
  readonly vault: Vault;
  readonly catalog: Catalog;
  readonly wallets: Wallets;
  readonly mover: Mover;
  readonly core: Core;
  readonly connections: Connections;
  readonly tools: ToolHost;
  readonly transport: PortalTransport;
  readonly guard: MessageGuard;
  readonly oauth: OAuth;
  readonly runner: Runner;
  readonly tunnel: Tunnel;
  readonly update: UpdateCheck;
  readonly diagnostics: Diagnostics;
  readonly activity: Activity;
  readonly notes: Notes;
  publicServer: Server | null = null;
  publicError: string | null = null;
  #notify: Notify;
  server: Server | null = null;
  serverError: string | null = null;
  lastSync = new Map<string, number>();

  /**
   * Mentions not yet notified (§16.20.3), by room, and marks them notified. A message
   * MessageGuard holds waits until the person releases it; muted rooms count too.
   */
  #newMentions(agent: string): MentionNote {
    const rows = this.db.prepare(`SELECT id, room, author FROM messages WHERE agent = ? AND mentioned = 1 AND mention_notified = 0 AND held = 0 AND author != ?
      ORDER BY received_at, id`).all(agent, agent) as any[];
    if (!rows.length) return { rooms: [], more: 0 };
    const mark = this.db.prepare('UPDATE messages SET mention_notified = 1 WHERE agent = ? AND id = ?');
    for (const r of rows) mark.run(agent, r.id);
    const byRoom = new Map<string, { first: string; count: number }>();
    for (const r of rows) {
      const e = byRoom.get(r.room) ?? { first: r.author, count: 0 };
      e.count++;
      byRoom.set(r.room, e);
    }
    const info = new Map(this.core.rooms(agent).map((r) => [r.room, r]));
    const all = [...byRoom].map(([room, e]) => ({ room, title: info.get(room)?.name ?? 'a room', by: this.core.handleOf(agent, e.first) ?? 'An agent', count: e.count }));
    return { rooms: all.slice(0, MENTION_ROOMS_PER_SYNC), more: Math.max(0, all.length - MENTION_ROOMS_PER_SYNC) };
  }

  /** What the network did to an agent, in the activity log (§16.18.1). */
  #received(agent: string, what: Received) {
    const r = this.core.rooms(agent).find((x) => x.room === what.room);
    const inv = this.core.invites(agent).find((x) => x.room === what.room);
    const name = r?.name ?? inv?.name;
    const handle = (id: string | null | undefined) => (id ? this.core.handleOf(agent, id) ?? id : 'another agent');
    const title = (r?.type ?? inv?.type) === 'dm' ? `a DM with ${handle(r?.dmWith ?? inv?.from)}` : name ? `“${name}”` : 'a room with no name';
    const ext = !!name && (r?.type ?? inv?.type) !== 'dm';
    if (what.type === 'invite') {
      const kind = inv?.type === 'dm' ? 'a DM' : `the ${inv?.type ?? ''} room ${name ? `“${name}”` : 'with no name'}`.replace('  ', ' ');
      const opening = inv?.type === 'dm' ? `A DM invitation arrived from ${handle(inv?.from)}` : `An invitation arrived from ${handle(inv?.from)} to ${kind}`;
      this.activity.add(agent, 'network', 'received', `${opening}${inv?.note ? `, with the note “${inv.note.length > 60 ? `${inv.note.slice(0, 60)}…` : inv.note}”` : ''}.`,
        { room: what.room, ext: ext || !!inv?.note });
    } else if (what.type === 'removed') {
      this.activity.add(agent, 'network', 'received', `${what.ban ? 'Banned' : 'Removed'} from ${title} by ${handle(what.by)}${what.reason ? `, saying “${what.reason.length > 80 ? `${what.reason.slice(0, 80)}…` : what.reason}”` : ''}.`,
        { room: what.room, ext: ext || !!what.reason });
    } else {
      this.activity.add(agent, 'network', 'received', `${title[0].toUpperCase()}${title.slice(1)} expired after 90 days with no activity.`, { room: what.room, ext });
    }
  }

  /** The last successful sync, from any path, kept across restarts (§16.17.2). */
  lastSyncOk(agent: string): number | null {
    const r: any = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(`sync_ok:${agent}`);
    return r ? Number(r.value) : this.lastSync.get(agent) ?? null;
  }
  #timer: NodeJS.Timeout | null = null;
  #changed: () => void;

  readonly version: string;

  constructor({ dbPath, masterKey, version, changed, catalog = new Catalog(), notify = () => {}, install = 'dev' }: {
    dbPath: string; masterKey: Uint8Array; version: string; changed: () => void; catalog?: Catalog; notify?: Notify; install?: InstallKind;
  }) {
    this.#notify = notify;
    this.#changed = changed;
    this.version = version;
    this.db = openDb(dbPath);
    this.vault = new Vault(masterKey);
    this.catalog = catalog;
    this.wallets = new Wallets({ db: this.db, vault: this.vault, catalog: this.catalog });
    this.mover = new Mover({ wallets: this.wallets, db: this.db });
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
    this.diagnostics = new Diagnostics({ db: this.db });
    this.activity = new Activity({ db: this.db });
    this.notes = new Notes({ db: this.db, vault: this.vault });
    this.core = new Core({
      db: this.db, vault: this.vault, transport: this.transport,
      // Every failed sync, from any path, with where it failed (§16.17.1).
      onSyncError: (agent, err) => {
        const where = syncFailureClass(err);
        this.diagnostics.event('sync', where, err instanceof Error ? err.message : String(err), agent);
        // In the activity log at most once per kind of failure per hour (§16.18.1).
        const text = `A sync failed: ${SYNC_FAILURE_WORDS[where]}.`;
        if (!this.activity.recent(agent, 'problems', text, 3600_000)) this.activity.add(agent, 'app', 'problems', text);
      },
      onReceived: (agent, what) => this.#received(agent, what),
      afterSync: async (agent, report) => {
        this.lastSync.set(agent, Date.now());
        this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(`sync_ok:${agent}`, String(Date.now()));
        const screened = await this.guard.screenNew(agent);
        if (screened.stopped) this.db.prepare('INSERT INTO problems (agent, at, kind, text) VALUES (?, ?, ?, ?)').run(agent, Date.now(), 'messageguard', `MessageGuard could not check every new message: ${screened.stopped}`);
        const mentions = this.#newMentions(agent);
        if ((report.messages || mentions.rooms.length) && this.settings().notifications) {
          const a = this.core.agents().find((x) => x.id === agent);
          const rooms = new Map(this.core.rooms(agent).map((r) => [r.room, r]));
          // A room with a mention notification is covered by it, whatever its setting.
          const mentioned = new Set(mentions.rooms.map((m) => m.room));
          let normal = 0;
          const priority: { room: string; title: string; count: number }[] = [];
          for (const [room, n] of Object.entries(report.byRoom ?? {})) {
            const r = rooms.get(room);
            if (mentioned.has(room) || r?.notify === 'muted') continue;
            // An unmuted DM is addressed to the agent: Priority (§16.20.4).
            if (r?.notify !== 'priority' && r?.type !== 'dm') {
              normal += n;
              continue;
            }
            const title = r.type === 'dm' ? `DM with ${(r.dmWith && this.core.handleOf(agent, r.dmWith)) ?? 'another agent'}` : r.name ?? 'a room';
            priority.push({ room, title, count: n });
          }
          if (normal || priority.length || screened.held || mentions.rooms.length) this.#notify(agent, a?.display_name ?? 'Your agent', normal, screened.held, priority, mentions);
        }
        // The runner acts outside the sync that woke it (the sync holds the agent's lock, and its own writes sync).
        if (this.runner.config(agent)?.enabled) setTimeout(() => void this.runner.run(agent).finally(() => this.#changed()), 0);
        this.#changed();
      },
    });
    this.connections = new Connections({ db: this.db, vault: this.vault });
    this.tools = new ToolHost({ core: this.core, wallets: this.wallets, catalog: this.catalog, guard: guardSettings, diagnostics: this.diagnostics, activity: this.activity, notes: this.notes });
    this.oauth = new OAuth({ db: this.db, diagnostics: this.diagnostics });
    this.runner = new Runner({ db: this.db, vault: this.vault, host: this.tools });
    // Each change of the tunnel's state is recorded, with its error or address (§16.17.1).
    let tunnelWas = '';
    this.tunnel = new Tunnel(() => {
      const t = this.tunnel.status;
      const now = `${t.state}|${t.error ?? t.url ?? ''}`;
      if (now !== tunnelWas) {
        tunnelWas = now;
        this.diagnostics.event('tunnel', t.state, t.error ?? t.url ?? '');
      }
      changed();
    });
    this.update = new UpdateCheck({ version, kind: install });
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
      // A sign-in request waits, unseen, for the person to type its code (§16.7.2): nothing pops up.
      onRequest: () => this.#changed(),
      onTokens: () => this.#changed(),
      diagnostics: this.diagnostics,
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
        // The Claude bridge and Claude Code come as the agent's Claude connection; anything else is another local host.
        return c && { agent: c.agent, audience: 'person', via: this.connections.get(c.agent)?.type === 'claude' ? 'claude' : 'local' };
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
