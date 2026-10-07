// The app's core services (SPEC §16.1): the database, the catalog, wallets,
// the portal transport, the core, connections, the tools, the loopback
// server, and the background sync. They run in the main process, which gives
// them the master key from the OS keychain (src/main/index.ts); nothing here
// depends on Electron.

import type { Server } from 'node:http';
import { openDb, type Db } from '../core/db.ts';
import { Vault } from '../core/vault.ts';
import { Catalog, formatUsd } from '../core/catalog.ts';
import { Wallets } from '../core/wallets.ts';
import { Mover } from '../core/move.ts';
import { Bridger } from '../core/bridge.ts';
import { withCause } from '../core/cause.ts';
import { PortalTransport, type Payer } from '../core/portal.ts';
import { Alumni, ClubFallback, MAX_INTERVAL, MIN_INTERVAL, type ClubStatus } from '../core/alumni.ts';
import { TransportError } from '../core/transport.ts';
import { Core, SYNC, type SyncReport } from '../core/core.ts';
import { Connections } from '../core/connections.ts';
import { ToolHost } from '../core/tools.ts';
import { GUARD_PATH, GUARD_SERVICE, MessageGuard, readScreen, type GuardReport } from '../core/guard.ts';
import { createLocalServer } from '../server/local.ts';
import { createPublicServer } from '../server/public.ts';
import { OAuth } from '../core/oauth.ts';
import { Runner } from '../core/runner.ts';
import { Tunnel } from './tunnel.ts';
import { newOutside, type Outside } from './troubleshoot.ts';
import { findElsewhere, type ElsewhereResult } from '../core/elsewhere.ts';
import { Diagnostics, syncFailureClass } from '../core/diagnostics.ts';
import { Activity } from '../core/activity.ts';
import { Notes } from '../core/notes.ts';
import type { Received } from '../core/core.ts';
import { MODE_NAMES } from '../core/modes.ts';
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
/** How often background receiving looks for groups that are due (§16.8). */
export const BACKGROUND_TICK_MS = 60_000;

export class Services {
  readonly db: Db;
  readonly vault: Vault;
  readonly catalog: Catalog;
  readonly wallets: Wallets;
  readonly mover: Mover;
  /** Move to Base (§16.9.3). */
  readonly bridger: Bridger;
  readonly core: Core;
  readonly connections: Connections;
  readonly tools: ToolHost;
  readonly transport: PortalTransport;
  /** The alumni club (SPEC §18.8): pays for every agent while a membership is active. */
  readonly alumni: Alumni;
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
  /** Troubleshoot's outside checks: their last results (§16.21.4). */
  readonly outside: Outside = newOutside();
  /** USDC each wallet holds on another network or as USDbC (§16.9.2), by wallet. */
  readonly elsewhere = new Map<string, ElsewhereResult>();
  #elsewhereBusy = new Set<string>();
  #notifyText: (title: string, body: string) => void;
  #daily: NodeJS.Timeout | null = null;

  /**
   * Looks for each wallet's USDC on the wrong network (§16.9.2): at most once a minute per
   * wallet unless `force`. Free reads; nothing signed.
   */
  async checkElsewhere({ wallet, force = false, fetchImpl }: { wallet?: string; force?: boolean; fetchImpl?: typeof fetch } = {}) {
    const list = this.wallets.list().filter((w) => !wallet || w.id === wallet);
    await Promise.all(list.map(async (w) => {
      const last = this.elsewhere.get(w.id);
      if (this.#elsewhereBusy.has(w.id) || (!force && last && Date.now() - last.at < 60_000)) return;
      this.#elsewhereBusy.add(w.id);
      try {
        this.elsewhere.set(w.id, await findElsewhere(w.address, fetchImpl ? { fetchImpl } : {}));
      } catch {
        // Kept as it was: a failed look says nothing new.
      } finally {
        this.#elsewhereBusy.delete(w.id);
      }
    }));
    this.#changed();
  }

  /**
   * A balance read from Base (§16.9.2): a rise that the app's own moves between its wallets
   * do not explain is a deposit, and raises a notification. The first read only remembers.
   */
  noteBalance(wallet: string, amount: bigint) {
    const key = `balance_seen:${wallet}`;
    const prev = (this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as any)?.value;
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, amount.toString());
    if (prev === undefined || amount <= BigInt(prev)) return;
    const w = this.wallets.list().find((x) => x.id === wallet);
    if (!w) return;
    const moved = this.db.prepare('SELECT 1 FROM moves WHERE lower(to_address) = lower(?) AND at > ?').get(w.address, Date.now() - 6 * 3600 * 1000);
    if (moved || !this.settings().notifications) return;
    this.#notifyText(`${formatUsd(amount - BigInt(prev))} of USDC arrived in ${w.name}`, 'It is ready to pay for your agents\' calls.');
  }

  /** Tells the window the state changed (for work done outside the services, such as Troubleshoot's checks). */
  changedNow() {
    this.#changed();
  }

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
    } else if (what.type === 'poster') {
      this.activity.add(agent, 'network', 'received', `${what.approved ? 'Approved to post in' : 'Silenced in'} ${title} by ${handle(what.by)}.`, { room: what.room, ext });
    } else if (what.type === 'mode') {
      this.activity.add(agent, 'network', 'received', `${title[0].toUpperCase()}${title.slice(1)} was made ${MODE_NAMES[what.mode]} by ${handle(what.by)}.`, { room: what.room, ext });
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

  constructor({ dbPath, masterKey, version, changed, catalog = new Catalog(), notify = () => {}, notifyText = () => {}, install = 'dev', alumniUrl }: {
    dbPath: string; masterKey: Uint8Array; version: string; changed: () => void; catalog?: Catalog; notify?: Notify;
    /** A plain system notification (a deposit arrived, §16.9.2). */
    notifyText?: (title: string, body: string) => void; install?: InstallKind;
    /** The alumni club's address (tests use a stand-in). */
    alumniUrl?: string;
  }) {
    this.#notify = notify;
    this.#notifyText = notifyText;
    this.#changed = changed;
    this.version = version;
    this.db = openDb(dbPath);
    this.vault = new Vault(masterKey);
    this.catalog = catalog;
    this.wallets = new Wallets({ db: this.db, vault: this.vault, catalog: this.catalog });
    this.mover = new Mover({ wallets: this.wallets, db: this.db });
    this.bridger = new Bridger({ wallets: this.wallets, db: this.db, mover: this.mover });
    // A membership starting or ending changes the receive interval in force (§18.8).
    this.alumni = new Alumni({ db: this.db, vault: this.vault, catalog: this.catalog, changed: () => { this.#reschedule(); this.#changed(); }, ...(alumniUrl && { base: alumniUrl }) });
    // While a membership is active the club signs; at its cap, or when it cannot be reached, the
    // agent's own wallet pays only if the person turned the fallback on (§18.8).
    const payer: Payer = async (req) => {
      if (!this.alumni.active()) return this.wallets.authorize(req);
      try {
        return await this.alumni.authorize(req);
      } catch (err) {
        if (!(err instanceof ClubFallback)) throw err;
        if (this.alumni.fallback()) return this.wallets.authorize(req);
        throw new TransportError('refused', `${err.message} Your person can let their own wallet pay past the club's allowance, in Settings under Meadow v1 alumni.`, { code: `club_${err.code}` });
      }
    };
    this.transport = new PortalTransport({ catalog: this.catalog, wallets: this.wallets, payer });
    const guardSettings = () => {
      const s = this.effectiveSettings();
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
      afterSync: async (agent, report) => this.#afterSync(agent, report, await this.guard.screenNew(agent)),
      // After a combined sync, MessageGuard screens every agent's new messages in one check (§18.8).
      afterSyncMany: async (reports) => {
        const screened = await this.guard.screenMany([...reports.keys()]);
        for (const [agent, report] of reports) await this.#afterSync(agent, report, screened.get(agent)!);
      },
    });
    this.connections = new Connections({ db: this.db, vault: this.vault });
    this.tools = new ToolHost({
      core: this.core, wallets: this.wallets, catalog: this.catalog, guard: guardSettings, diagnostics: this.diagnostics, activity: this.activity, notes: this.notes,
      club: () => ((st) => (st ? { capUsd: st.daily_cap_usd, allowanceLeftUsd: this.alumni.allowanceLeft() } : null))(this.alumni.settings()),
      freshness: (agent) => this.freshness(agent),
    });
    this.oauth = new OAuth({ db: this.db, diagnostics: this.diagnostics });
    this.runner = new Runner({ db: this.db, vault: this.vault, host: this.tools });
    // Each change of the tunnel's state is recorded, with its error or address, and so is
    // what the watch saw and did: wakes, checks, restarts, the door (§16.17.1, §16.17.8).
    let tunnelWas = '';
    this.tunnel = new Tunnel({
      changed: () => {
        const t = this.tunnel.status;
        const now = `${t.state}|${t.error ?? t.why ?? t.url ?? ''}`;
        if (now !== tunnelWas) {
          tunnelWas = now;
          this.diagnostics.event('tunnel', t.state, t.error ?? t.why ?? t.url ?? '');
        }
        changed();
      },
      event: (what, detail = '') => this.diagnostics.event('tunnel', what, detail),
    });
    this.update = new UpdateCheck({ version, kind: install });
  }

  /** After every sync, from any path (background, Sync Now, a tool, a combined sync): record it, report what MessageGuard did, then tell the person. */
  async #afterSync(agent: string, report: SyncReport, screened: GuardReport) {
    this.lastSync.set(agent, Date.now());
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(`sync_ok:${agent}`, String(Date.now()));
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
    // combineSyncs was a setting until combined syncs became the only way (§16.8); a stored value is ignored.
    const { combineSyncs: _, ...stored } = row ? JSON.parse(row.value) : {};
    return { ...DEFAULT_SETTINGS, ...stored, perCallMaxUsd: this.wallets.perCallMaxUsd() };
  }

  /**
   * The settings in force: the person's, with the alumni club's overrides while a membership is
   * active (§18.8): the tier's receive interval, and MessageGuard for public rooms on the tiers that
   * include it. Private-room MessageGuard stays the person's on those tiers; on a tier without
   * MessageGuard it is off, since the club does not pay for screening. The person's own values are
   * kept, and are in force again when the membership ends.
   */
  effectiveSettings(): Settings {
    const own = this.settings();
    // Whoever set it (the window or the club), the interval stays within what Settings offers (security review A1).
    const s = { ...own, syncMinutes: Number.isSafeInteger(own.syncMinutes) ? Math.min(Math.max(own.syncMinutes, MIN_INTERVAL), MAX_INTERVAL) : 15 };
    const club = this.alumni.settings();
    if (!club) return s;
    return { ...s, syncMinutes: club.receive_interval_min, guardPublic: club.messageguard, guardPrivate: club.messageguard && s.guardPrivate };
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

  /** Background receiving (§16.8): every agent that is registered and has a wallet, on the interval in force. */
  schedule() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    const s = this.effectiveSettings();
    this.#scheduled = s.syncEnabled ? s.syncMinutes : null;
    // Once a day, free: USDC sent to a wallet on the wrong network (§16.9.2); first a minute after start.
    if (!this.#daily) {
      // The alumni club's status on start, then with the syncs once a day (§18.8).
      setTimeout(() => void this.refreshAlumni().catch(() => {}), 5_000).unref();
      setTimeout(() => void this.checkElsewhere().catch(() => {}), 60_000).unref();
      this.#daily = setInterval(() => void this.checkElsewhere({ force: true }).catch(() => {}), 24 * 3600 * 1000);
      this.#daily.unref();
    }
    if (!s.syncEnabled) return;
    // Looks once a minute and syncs only the groups that are due (§16.8): a sync the AI, a write, or
    // Sync Now just made is never repeated. A tick while the last one still runs is skipped (security review A1).
    this.#timer = setInterval(() => {
      if (this.#background) return;
      this.#background = true;
      void this.syncAll('background', { due: true }).finally(() => (this.#background = false));
    }, BACKGROUND_TICK_MS);
  }

  /** A background receive is running. */
  #background = false;

  /** The interval background receiving runs on, once scheduled; null when it is off. */
  #scheduled: number | null | undefined = undefined;

  /** Schedules again when the interval in force changed (a membership began or ended). */
  #reschedule() {
    if (this.#scheduled === undefined) return;
    const s = this.effectiveSettings();
    if ((s.syncEnabled ? s.syncMinutes : null) !== this.#scheduled) this.schedule();
  }

  /** Asks the alumni club for the membership's status, and tells the person when it ends (§18.8). */
  async refreshAlumni(): Promise<ClubStatus | null> {
    const was = this.alumni.active();
    const status = await this.alumni.refresh();
    if (was && !this.alumni.active()) {
      this.#notifyText('Your alumni membership has ended', 'Your agents\' own wallets pay for their calls again.');
    }
    return status;
  }

  /** When background receiving last tried each group (by its agents), success or not. */
  #attempted = new Map<string, number>();

  /**
   * The agents that sync together (§7.9), up to 8 a call: the club pays for every agent; otherwise
   * each wallet pays for its own agents, so no wallet pays for another's. With the fallback on, a
   * club refusal makes the first agent's own wallet pay for the call, so then the agents are grouped
   * by their own wallets too (security review A5).
   */
  #syncGroups(): string[][] {
    const club = this.alumni.active();
    const byOwn = !club || this.alumni.fallback();
    const groups = new Map<string, string[]>();
    for (const a of this.core.agents().filter((x) => x.registered && (club || this.wallets.walletOf(x.id)))) {
      const payer = byOwn ? `${club ? 'alumni:' : ''}${this.wallets.walletOf(a.id) ?? 'none'}` : 'alumni';
      groups.set(payer, [...(groups.get(payer) ?? []), a.id]);
    }
    const out: string[][] = [];
    for (const list of groups.values()) for (let i = 0; i < list.length; i += SYNC.batch) out.push(list.slice(i, i + SYNC.batch));
    return out;
  }

  /**
   * When background receiving next syncs a group: a full interval (in force, §18.8) after the least
   * recently synced of its agents last synced successfully, by any path, and after its last background try.
   */
  #dueAt(group: string[]): number {
    const oldest = Math.min(...group.map((a) => this.lastSyncOk(a) ?? 0));
    const tried = Math.max(...group.map((a) => this.#attempted.get(a) ?? 0));
    return Math.max(oldest, tried) + this.effectiveSettings().syncMinutes * 60_000;
  }

  /**
   * How fresh an agent's view of the network is, for the AI (§16.8): its last successful sync, and
   * when background receiving will next check (null when it is off).
   */
  freshness(agent: string, now = Date.now()): { lastOk: number | null; nextBackground: number | null } {
    const lastOk = this.lastSyncOk(agent);
    if (!this.effectiveSettings().syncEnabled) return { lastOk, nextBackground: null };
    const group = this.#syncGroups().find((g) => g.includes(agent)) ?? [agent];
    return { lastOk, nextBackground: Math.max(this.#dueAt(group), now) + BACKGROUND_TICK_MS };
  }

  /**
   * Syncs every agent that something pays for: its wallet, or the alumni club; `cause` is what its
   * payments are recorded as (§16.9.4). `due`: background receiving, which syncs only the groups whose
   * time has come (§16.8).
   */
  async syncAll(cause: 'background' | 'person' = 'background', { due = false, now = Date.now() }: { due?: boolean; now?: number } = {}): Promise<{ agent: string; ok: boolean; message: string }[]> {
    if (this.alumni.due()) await this.refreshAlumni().catch(() => {});
    // A membership can end by its date alone, with nothing said: the interval in force follows.
    this.#reschedule();
    const club = this.alumni.active();
    // At the club's cap, with the agents' own wallets not allowed past it, background receiving
    // waits until the allowance frees up (§18.8): every call until then would be refused.
    if (cause === 'background' && club && !this.alumni.fallback() && this.alumni.held()?.code === 'cap') return [];
    const groups = this.#syncGroups().filter((g) => !due || this.#dueAt(g) <= now);
    if (due) for (const g of groups) for (const a of g) this.#attempted.set(a, now);
    const out: { agent: string; ok: boolean; message: string }[] = [];
    if (this.core.batchOff()) {
      for (const a of groups.flat()) out.push({ agent: a, ...(await withCause(cause, () => this.syncOne(a))) });
      return out;
    }
    // Combined, always (§7.9, §16.8): each payer's agents, up to 8 a call (#syncGroups); an agent
    // alone with its payer gets an ordinary sync (Core.syncMany).
    {
      for (const chunk of groups) {
        const results = await withCause(cause, () => this.core.syncMany(chunk)).catch((err) => new Map(chunk.map((a) => [a, err as Error])));
        for (const a of chunk) out.push({ agent: a, ...this.#syncResult(a, results.get(a) ?? new Error('Not synced.')) });
      }
    }
    this.#changed();
    return out;
  }

  async syncOne(agent: string): Promise<{ ok: boolean; message: string }> {
    try {
      return this.#syncResult(agent, await this.core.sync(agent).catch((err) => (err instanceof Error ? err : new Error(String(err)))));
    } finally {
      this.#changed();
    }
  }

  /** A sync's outcome in the person's words; a failure is kept with the Dashboard's problems. */
  #syncResult(agent: string, r: SyncReport | Error): { ok: boolean; message: string } {
    if (r instanceof Error) {
      this.db.prepare('INSERT INTO problems (agent, at, kind, text) VALUES (?, ?, ?, ?)').run(agent, Date.now(), 'sync', r.message);
      return { ok: false, message: r.message };
    }
    this.lastSync.set(agent, Date.now());
    return { ok: true, message: r.messages ? `${r.messages} new message${r.messages === 1 ? '' : 's'}.` : 'Nothing new.' };
  }

  /** Restart tunnel (§16.17.8): the same as the automatic restart, once, now. */
  async restartTunnel(): Promise<{ ok: boolean; text: string }> {
    if (!this.publicServer?.listening) return { ok: false, text: 'The app\'s ChatGPT door is not listening, so a tunnel would have nothing to reach. Quit Meadow from its icon near the clock and open it again.' };
    return this.tunnel.restart();
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    if (this.#daily) clearInterval(this.#daily);
    this.server?.close();
    this.publicServer?.close();
    void this.tunnel.stop();
    this.db.close();
  }
}
