// The core's side of the window's fixed channels (src/shared/api.ts). Each
// handler returns plain JSON; a failure comes back as {error} in plain words.
// The main process puts them on IPC; what needs Electron comes in `env`.

import QRCode from 'qrcode';
import { formatUsd } from '../core/catalog.ts';
import { GUARD_SERVICE } from '../core/guard.ts';
import { dirname } from 'node:path';
import { backupChanges, backupDue, describeBackup, makeBackup, readBackup, restoreBackup } from '../core/backup.ts';
import { tokenBalance } from '../core/balance.ts';
import { add, bridgeEntry, claudeDesktopConfigPath, claudeDesktopRunning, entryName, remove, status } from '../server/claude-desktop.ts';
import { CHANNELS, linkAllowed, type Api, type AppState, type BridgePlanView, type BridgeStateView, type Channel, type MessageView, type MovePlanView, type MoveStateView, type NoteView } from '../shared/api.ts';
import type { Services } from './services.ts';
import { connectionCheck, diagnosticsText, testConnection, type ClaudeState } from './check.ts';
import { runOutside, troubleshoot } from './troubleshoot.ts';
import { elsewhereSentence } from '../core/elsewhere.ts';
import { movable } from '../core/bridge.ts';
import { WHO_WORDS, type ActivityKind } from '../core/activity.ts';
import type { Note } from '../core/notes.ts';

export interface HandlerEnv {
  /** The app's executable, which runs the Claude bridge as Node. */
  execPath: string;
  bridgeScript: string;
  copy(text: string): void;
  openExternal(url: string): void;
  /** Claude Desktop's settings file; by default where Claude Desktop keeps it on this computer. */
  claudeConfigPath?: string;
  /** Update now (§16.3), done by the main process: it may quit the app. */
  installUpdate?(): Promise<{ ok: true; file?: string } | { ok: false; error: string }>;
  /** Whether Claude Desktop is running (true, false, or null for cannot tell); by default asks the system. */
  claudeRunning?(): Promise<boolean | null>;
  /** Asks where to save a file (a system dialog); resolves to the path written, or null if cancelled. */
  saveFile(defaultName: string, data: Buffer, folder?: string): Promise<string | null>;
  /** Asks where to save a text file (the diagnostics export); resolves to the path written, or null. */
  saveText?(defaultName: string, text: string): Promise<string | null>;
  /** Asks for a file to open; resolves to its name and bytes, or null. */
  openFile(): Promise<{ name: string; data: Buffer } | null>;
  /** Applies settings that belong to the operating system (start at login). */
  applySettings?(s: ReturnType<Services['settings']>): void;
  /**
   * Asks the person in a system dialog, outside the window, before money leaves a
   * wallet (§16.9.1): a window that is not what it seems cannot answer it.
   */
  confirmMove(q: { message: string; detail: string }): Promise<boolean>;
}

const STATUS_WORDS: Record<string, string> = {
  missing_key: 'Encrypted. Its key has not arrived yet; the app has asked for it.',
  pre_join: 'Written before this agent was invited. Private rooms do not share earlier messages with new members.',
  own_elsewhere: 'Written by this agent from another computer or an older copy. Encrypted, and its key is not on this computer.',
  undecryptable: 'Encrypted, and it could not be decrypted.',
  replayed: 'A copy of an earlier message. Not shown.',
  bad_commitment: 'Failed its integrity check. Not shown.',
  unsupported: 'In a format this app cannot read.',
  withheld: 'Its content is not available from the network.',
  deleted: 'Deleted.',
};

const MAY_NAMES = { all: 'Everything', no_new: 'No new conversations', porch: 'Porch (read only)' } as const;
const GUARD_NAMES = { default: 'as set in Settings', always: 'always check', never: 'never check' } as const;

export function createHandlers(s: Services, env: HandlerEnv): (channel: Channel, arg: unknown) => Promise<unknown> {
  // The backup chosen for a restore, held in memory between the person's steps.
  let restoring: { name: string; data: Buffer } | null = null;
  let balanceCache: { at: number; values: Record<string, string | null> } | null = null;
  // Each wallet's move in progress or last finished (§16.9.1), for the window to follow.
  const moves = new Map<string, MoveStateView>();
  // Each Move to Base in progress or last finished (§16.9.3), by wallet, network, and kind.
  const bridges = new Map<string, BridgeStateView>();
  const moveTarget = (walletId: string, to: string) => {
    const other = s.wallets.list().find((w) => w.id === to && w.id !== walletId);
    return other ? { address: other.address, name: other.name } : { address: s.mover.destination(walletId, to), name: null };
  };

  const claudeEntry = (agent: string) => {
    const token = s.connections.token(agent);
    if (!token) throw new Error('This agent has no connection yet.');
    return bridgeEntry({ appExecutable: env.execPath, bridgeScript: env.bridgeScript, port: s.settings().localPort, token });
  };
  const claudePath = () => env.claudeConfigPath ?? claudeDesktopConfigPath();
  // The Claude Desktop entry's state, for the connection check (§16.17.2).
  const claudeState = (agent: string): ClaudeState => {
    if ((s.connections.get(agent) as any)?.type !== 'claude') return null;
    const a = s.core.agents().find((x) => x.id === agent);
    if (!a) return null;
    try {
      const st = status(claudePath(), entryName(a.name), claudeEntry(agent));
      return { installed: st.installed, upToDate: st.upToDate, unreadable: st.unreadable };
    } catch {
      return { installed: false, upToDate: false, unreadable: true };
    }
  };
  // The person's own actions, in the activity log (§16.18.2: You).
  const you = (agent: string, kind: ActivityKind, text: string, room?: string) => {
    const t = room ? roomTitle(agent, room) : null;
    s.activity.add(agent, 'you', kind, text.replace('{room}', t?.title ?? ''), { room: room ?? null, ext: !!t?.ext });
  };
  const roomTitle = (agent: string, room: string): { title: string; ext: boolean } => {
    const r = s.core.rooms(agent).find((x) => x.room === room);
    if (r?.type === 'dm') return { title: `the DM with ${(r.dmWith && s.core.handleOf(agent, r.dmWith)) ?? 'another agent'}`, ext: false };
    return r?.name ? { title: `“${r.name}”`, ext: true } : { title: 'a room with no name', ext: false };
  };
  // The backup nudge, logged once each time it appears (§16.18.1).
  const nudge = (agent: string, due: string | null) => {
    if (!due) return due;
    const last = (s.db.prepare('SELECT last_backup_at FROM agents WHERE id = ?').get(agent) as any)?.last_backup_at ?? 'never';
    const key = `nudge_logged:${agent}`;
    if ((s.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as any)?.value !== String(last)) {
      s.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, String(last));
      s.activity.add(agent, 'app', 'backups', `Suggested a fresh backup: ${due}`);
    }
    return due;
  };
  const nameOf = (agent: string) => s.core.agents().find((a) => a.id === agent)?.name ?? '';

  const handlers: Api = {
    state(): AppState {
      const price = s.catalog.priceAtomic('meadow');
      const guardPrice = s.catalog.priceAtomic(GUARD_SERVICE);
      const path = claudePath();
      return {
        version: s.version,
        update: s.update.available,
        settings: s.settings(),
        agents: s.core.agents().map((a) => {
          const conn = s.connections.get(a.id) as any;
          const messages = s.core.messages(a.id, { undelivered: true }).filter((m) => m.author !== a.id);
          return {
            id: a.id, displayName: a.display_name, name: a.name, handle: a.handle, registered: a.registered,
            connection: conn,
            claude: conn?.type === 'claude' ? (() => { const st = status(path, entryName(a.name), claudeEntry(a.id)); return { installed: st.installed, upToDate: st.upToDate, unreadable: st.unreadable, path }; })() : null,
            walletId: s.wallets.walletOf(a.id),
            unread: messages.filter((m) => !m.guard?.held).length,
            held: s.core.messages(a.id).filter((m) => m.guard?.held === 1).length,
            lastBackup: (s.db.prepare('SELECT last_backup_at FROM agents WHERE id = ?').get(a.id) as any)?.last_backup_at ?? null,
            backupDue: nudge(a.id, backupDue(s.db, a.id)),
            mcpUrl: conn?.type === 'chatgpt' && s.tunnel.url ? `${s.tunnel.url}/${a.name}/mcp` : null,
            runner: s.runner.config(a.id),
            runnerLog: s.runner.log(a.id, 5),
            queued: s.core.outbox(a.id).filter((e) => e.kind === 'msg.post').length,
            may: s.core.may(a.id),
            newAiNotes: s.notes.unseen(a.id),
            check: connectionCheck(s, a.id, claudeState(a.id)),
            heldBySetting: s.core.heldBySetting(a.id),
            lastSync: s.lastSyncOk(a.id),
            discoverable: a.registered ? s.core.discoverable(a.id) : null,
            unlistedNotice: a.registered && s.core.discoverable(a.id) !== true && !s.db.prepare('SELECT 1 FROM meta WHERE key = ?').get(`unlisted_notice_seen:${a.id}`),
          };
        }),
        wallets: s.wallets.list().map((w) => ({
          id: w.id, name: w.name, address: w.address, dailyBudgetUsd: w.dailyBudgetUsd, spent24hUsd: formatUsd(w.spent24h), agents: w.agents,
          // USDC on the wrong network (§16.9.2): safe, the person's, but not usable by the app.
          elsewhere: (s.elsewhere.get(w.id)?.found ?? []).map((f) => ({ network: f.network, kind: f.kind, usd: f.usd, text: elsewhereSentence(f), movable: !!movable(f.network, f.kind) })),
        })),
        payments: s.wallets.payments(30).map((p) => ({ at: p.signed_at, service: p.service, path: p.path, usd: formatUsd(BigInt(p.amount)), agent: p.agent, status: p.status, tx: p.tx })),
        problems: s.core.problems().slice(-20).reverse(),
        pricePerCallUsd: price ? formatUsd(price.atomic, price.decimals) : null,
        guardPriceUsd: guardPrice ? formatUsd(guardPrice.atomic, guardPrice.decimals) : null,
        tunnel: (({ provider, state, url, error, reachedAt, why }) => ({ provider, state, url, error: s.publicError ?? error, reachedAt, why, hasNgrokToken: s.ngrokToken() !== null, port: s.settings().publicPort }))(s.tunnel.status),
        authorized: s.oauth.authorized().map((c) => ({ ...c, agentName: s.core.agents().find((a) => a.id === c.agent)?.display_name ?? c.agent })),
        catalogError: s.catalog.fetchedAt ? null : 'The app has not read the portal\'s price list yet.',
        troubleshoot: troubleshoot(s, claudeState),
      };
    },

    balances() {
      return balanceCache?.values ?? {};
    },

    createAgent({ displayName, type, walletId }) {
      const { id } = s.core.createAgent(displayName);
      s.connections.set(id, type, displayName);
      s.wallets.assign(id, walletId);
      return { id, handle: s.core.agents().find((a) => a.id === id)!.handle };
    },

    claudePreview({ agent }) {
      const path = claudePath();
      const entry: any = claudeEntry(agent);
      const st = status(path, entryName(nameOf(agent)), entry);
      return { path, name: entryName(nameOf(agent)), entry: { ...entry, env: { ...entry.env, MEADOW_TOKEN: '(this agent\'s token)' } }, unreadable: st.unreadable };
    },


    disconnectClaude({ agent }) {
      const r = remove(claudePath(), entryName(nameOf(agent)));
      if (r.ok) you(agent, 'settings', 'Disconnected Claude Desktop.');
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    },

    localInterface({ agent }) {
      const port = s.settings().localPort;
      const token = s.connections.token(agent);
      if (!token) throw new Error('This agent has no connection yet.');
      return { mcpUrl: `http://127.0.0.1:${port}/mcp`, restUrl: `http://127.0.0.1:${port}/rest/`, openApiUrl: `http://127.0.0.1:${port}/openapi.json`, token };
    },

    rotateToken({ agent }) {
      s.connections.rotate(agent);
      // Claude Desktop's entry carries the token: rewrite it when present.
      const path = claudePath();
      if (status(path, entryName(nameOf(agent)), claudeEntry(agent)).installed) add(path, entryName(nameOf(agent)), claudeEntry(agent));
      return { ok: true };
    },

    assignWallet({ agent, walletId }) {
      const before = s.wallets.walletOf(agent);
      s.wallets.assign(agent, walletId);
      if (before !== walletId) you(agent, 'settings', `The wallet that pays for it set to “${s.wallets.list().find((w) => w.id === walletId)?.name ?? 'a wallet'}”.`);
      return { ok: true };
    },

    createWallet({ name, dailyBudgetUsd }) {
      return s.wallets.create(name, dailyBudgetUsd);
    },

    importWallet({ name, phrase, dailyBudgetUsd }) {
      return s.wallets.import(name, phrase, dailyBudgetUsd);
    },

    removeWallet({ walletId, confirm }) {
      s.wallets.remove(walletId, confirm);
      return { ok: true };
    },

    dismissUnlistedNotice({ agent }) {
      s.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(`unlisted_notice_seen:${agent}`, String(Date.now()));
      return { ok: true };
    },

    setDiscoverable: undefined as any, // async, below

    setBudget({ walletId, dailyBudgetUsd }) {
      s.wallets.setBudget(walletId, dailyBudgetUsd);
      return { ok: true };
    },

    movePlan: undefined as any, // async, below
    moveStart: undefined as any, // async, below
    moveStatus: undefined as any, // async, below
    bridgePlan: undefined as any, // async, below
    bridgeStart: undefined as any, // async, below
    bridgeStatus: undefined as any, // async, below

    walletQr: undefined as any, // async, below

    syncNow: undefined as any, // async, below

    rooms({ agent }) {
      const unread = new Map<string, number>();
      const mentions = new Map<string, number>();
      const last = new Map<string, number>();
      for (const m of s.core.messages(agent)) {
        if (!m.delivered && m.author !== agent) unread.set(m.room, (unread.get(m.room) ?? 0) + 1);
        if (!m.delivered && m.mentioned) mentions.set(m.room, (mentions.get(m.room) ?? 0) + 1);
        last.set(m.room, Math.max(last.get(m.room) ?? 0, m.ts));
      }
      // A pending invitation says what the room is before joining (§7.2): its name and topic come from the invite.
      const invites = new Map(s.core.invites(agent).map((i) => [i.room, i]));
      return s.core.rooms(agent)
        .map((r) => {
          const i = r.status === 'invited' ? invites.get(r.room) : undefined;
          const name = r.name ?? i?.name;
          const topic = r.topic ?? i?.topic;
          return {
            room: r.room, type: r.type ?? i?.type ?? null, status: r.status, guard: r.guard, notify: r.notify, ...(name && { name }), ...(topic && { topic }),
            ...((n) => (n ? { note: { text: n.text, ai: n.who !== 'you' } } : {}))(s.notes.get(agent, 'room', r.room)),
            ...(r.dmWith && { with: s.core.handleOf(agent, r.dmWith) ?? r.dmWith }), members: r.members, unread: unread.get(r.room) ?? 0, mentions: mentions.get(r.room) ?? 0, last: last.get(r.room) ?? 0,
            ...(i && { invite: { from: i.from ? s.core.handleOf(agent, i.from) ?? i.from : null, members: i.members, ...(i.note && { note: i.note }), ...(i.origin && { sent: i.origin as 'manual' | 'automatic' }) } }),
          };
        })
        .sort((a, b) => b.last - a.last);
    },

    messages({ agent, room }): MessageView[] {
      const queued = new Set(s.core.outbox(agent).map((e) => e.id));
      return s.core.messages(agent, { room }).map((m) => ({
        id: m.id, room: m.room, author: m.author, authorHandle: s.core.handleOf(agent, m.author), mine: m.author === agent,
        ts: m.ts, status: m.status, statusWords: m.status === 'shown' ? null : m.preJoin ? STATUS_WORDS.pre_join : STATUS_WORDS[m.status] ?? m.status,
        ...(m.text !== undefined && { text: m.text }), ...(m.reply_to && { replyTo: m.reply_to }),
        unreadByAgent: !m.delivered && m.author !== agent, queued: queued.has(m.id), ...(m.mentioned && { mentioned: true }),
        ...(m.guard && { guard: { verdict: m.guard.verdict, matches: m.guard.matches.map((x) => x.label), held: m.guard.held } }),
        ...(m.report && { report: m.report.valid ? { valid: true, reason: m.report.reason, text: m.report.text, note: m.report.note } : { valid: false, why: m.report.why } }),
      }));
    },

    setSettings(changes) {
      const out = s.setSettings(changes);
      env.applySettings?.(out);
      return out;
    },

    guardCheck: undefined as any, // async, below
    testConnection: undefined as any, // async, below
    diagnosticsSave: undefined as any, // async, below
    activitySave: undefined as any, // async, below
    connectClaude: undefined as any,
    claudeRunning: undefined as any,
    installUpdate: undefined as any,
    setTunnel: undefined as any,
    restartTunnel: undefined as any,
    troubleshootRun: undefined as any,
    checkElsewhere: undefined as any,

    enterChatgptCode({ agent, code }) {
      if (typeof agent !== 'string' || typeof code !== 'string' || code.length > 40) return { ok: false, error: 'Type the code the ChatGPT page shows.' };
      const r = s.oauth.enterCode(agent, code);
      if (r.ok) you(agent, 'settings', 'Approved ChatGPT’s sign-in with the code it showed.');
      return r;
    },

    revokeClient({ client, agent }) {
      s.oauth.revoke(client, agent);
      you(agent, 'settings', 'Revoked ChatGPT’s sign-in.');
      return { ok: true };
    },

    setRunner({ agent, ...c }) {
      const was = s.runner.config(agent)?.enabled ?? false;
      s.runner.configure(agent, c);
      you(agent, 'settings', was === c.enabled ? 'Changed the built-in runner’s settings.' : `Turned the built-in runner ${c.enabled ? 'on' : 'off'}.`);
      return { ok: true };
    },

    notes({ agent }) {
      const view = (n: Note): NoteView => ({
        id: n.id, kind: n.kind, about: n.about, text: n.text, whoWords: WHO_WORDS[n.who], ai: n.who !== 'you', unseen: n.unseen, at: n.at,
        title: n.kind === 'anchor' ? '' : n.kind === 'agent' ? s.core.handleOf(agent, n.about) ?? n.about : roomTitle(agent, n.about).title,
      });
      return { anchors: s.notes.anchors(agent).map(view), notes: s.notes.list(agent).filter((n) => n.kind !== 'anchor').map(view) };
    },

    setAnchor({ agent, id, text }) {
      const key = s.notes.setAnchor(agent, id ?? null, text);
      you(agent, 'settings', id ? 'Changed an anchor.' : 'Added an anchor.');
      return { id: key };
    },

    setNote({ agent, kind, about, text }) {
      if (kind !== 'agent' && kind !== 'room') throw new Error('A note is about an agent or a room.');
      const done = s.notes.set(agent, kind, about, text, 'you');
      const what = kind === 'agent' ? s.core.handleOf(agent, about) ?? about : '{room}';
      if (done !== 'unchanged') you(agent, 'settings', `${{ added: 'Wrote a note about', changed: 'Changed the note about', removed: 'Removed the note about' }[done]} ${what}.`, kind === 'room' ? about : undefined);
      return { ok: true };
    },

    removeNote({ agent, id }) {
      const n = s.notes.remove(agent, id);
      if (n) you(agent, 'settings', n.kind === 'anchor' ? 'Removed an anchor.' : `Removed the note about ${n.kind === 'agent' ? s.core.handleOf(agent, n.about) ?? n.about : '{room}'}.`, n.kind === 'room' ? n.about : undefined);
      return { ok: true };
    },

    keepNote({ agent, id }) {
      s.notes.keep(agent, id);
      return { ok: true };
    },

    notesSeen({ agent }) {
      s.notes.seen(agent);
      return { ok: true };
    },

    activity({ agent }) {
      return s.activity.list(agent).map((e) => ({ at: e.at, who: e.who, whoWords: WHO_WORDS[e.who], kind: e.kind, text: e.text, room: e.room }));
    },

    diagnosticsText() {
      return { text: diagnosticsText(s, claudeState) };
    },

    setMay({ agent, may }) {
      const was = s.core.may(agent);
      s.core.setMay(agent, may);
      if (was !== may) you(agent, 'settings', `What this agent may do set to ${MAY_NAMES[may]}.`);
      return { ok: true };
    },

    setRoomSettings({ agent, room, guard, notify }) {
      const was = s.core.rooms(agent).find((r) => r.room === room);
      s.core.setRoomSettings(agent, room, { guard, notify });
      if (guard !== undefined && was?.guard !== guard) you(agent, 'settings', `MessageGuard for {room} set to ${GUARD_NAMES[guard]}.`, room);
      if (notify !== undefined && was?.notify !== notify) you(agent, 'settings', `Notifications for {room} set to ${notify}.`, room);
      return { ok: true };
    },

    backupChanges({ agent }) {
      const c = backupChanges(s.db, agent);
      if (!c) return null;
      const rooms = new Map(s.core.rooms(agent).map((r) => [r.room, r]));
      const title = (id: string) => {
        const r = rooms.get(id);
        if (r?.type === 'dm') return `DM with ${(r.dmWith && s.core.handleOf(agent, r.dmWith)) ?? 'another agent'}`;
        return r?.name ?? 'A private room with no name';
      };
      return { since: c.since, joined: c.joined.map(title), newKeys: c.newKeys.map(title) };
    },

    guardDecide({ agent, message, release }) {
      const m = s.core.messages(agent).find((x) => x.id === message);
      s.guard.decide(agent, message, release);
      if (m) you(agent, 'settings', `${release ? 'Released to the agent' : 'Kept held'} a message MessageGuard kept aside, in {room}.`, m.room);
      return { ok: true };
    },

    backup: undefined as any,
    restoreOpen: undefined as any,

    restorePreview({ password }) {
      if (!restoring) throw new Error('Choose a backup file first.');
      const d = describeBackup(readBackup(restoring.data, password));
      return { ...d, alreadyHere: s.core.agents().some((a) => a.id === d.agent) };
    },

    restoreApply({ password, replace }) {
      if (!restoring) throw new Error('Choose a backup file first.');
      const contents = readBackup(restoring.data, password);
      const { agent } = restoreBackup(s.db, s.vault, contents, { replace });
      s.core.forget(agent);
      you(agent, 'backups', `Restored from a backup made ${new Date(contents.created_at).toISOString().slice(0, 10)}.`);
      // A new connection token; a Claude connection must be connected again from the Agents screen.
      const conn = s.connections.get(agent);
      s.connections.set(agent, (conn?.type ?? 'claude') as any, conn?.name ?? agent);
      restoring = null;
      return { agent };
    },

    copy({ text }) {
      env.copy(text);
      return { ok: true };
    },

    openExternal({ url }) {
      if (typeof url !== 'string' || !linkAllowed(url)) return { ok: false };
      env.openExternal(url);
      return { ok: true };
    },
  };

  const claudeRunning = () => (env.claudeRunning ?? claudeDesktopRunning)();

  const asyncHandlers: Partial<Record<keyof Api, (a: any) => Promise<unknown>>> = {
    syncNow: ({ agent }) => s.syncOne(agent),
    claudeRunning: async () => ({ running: await claudeRunning() }),
    installUpdate: async () => {
      if (!s.update.available) return { ok: false, error: 'No update is waiting.' };
      if (!env.installUpdate) return { ok: false, error: 'This copy cannot update itself.' };
      try {
        return await env.installUpdate();
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    // Only while Claude Desktop is closed: open, it writes back its own copy of the file and drops the entry.
    connectClaude: async ({ agent }) => {
      if ((await claudeRunning()) === true) return { ok: false, error: 'Claude is still open. Quit it from its icon near the clock first, then add the entry.' };
      const r = add(claudePath(), entryName(nameOf(agent)), claudeEntry(agent));
      if (r.ok) you(agent, 'settings', 'Connected Claude Desktop.');
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    },
    setTunnel: async (t) => {
      await s.setTunnel(t);
      return { ok: true };
    },
    restartTunnel: async () => s.restartTunnel(),
    troubleshootRun: async ({ again = false }: { again?: boolean } = {}) => ({ ran: await runOutside(s, { again }) }),
    checkElsewhere: async ({ walletId, force = false }: { walletId?: string; force?: boolean } = {}) => {
      await s.checkElsewhere({ ...(walletId && { wallet: walletId }), force });
      return { ok: true };
    },
    guardCheck: async ({ agent, message }) => {
      const r = await s.guard.checkOne(agent, message);
      return { verdict: r?.verdict ?? null, matches: r?.matches.map((m) => m.label) ?? [] };
    },
    testConnection: async ({ agent }) => testConnection(s, agent),
    // The person's own record (§16.18.3): it keeps room names and handles, never message text or secrets.
    activitySave: async ({ agent, days }) => {
      if (!env.saveText) throw new Error('Saving is not available here.');
      const a = s.core.agents().find((x) => x.id === agent);
      if (!a) throw new Error('There is no such agent.');
      const since = typeof days === 'number' && days > 0 ? Date.now() - days * 24 * 3600 * 1000 : undefined;
      const entries = s.activity.list(agent, { since, limit: 5000 }).reverse();
      const lines = [
        `Meadow activity for ${a.display_name} (${a.handle})`,
        `Made ${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}, ${since ? `the last ${days} days` : 'everything kept (up to 90 days)'}, oldest first.`,
        'For "Your AI" entries the app knows which connection acted, not whether you asked for it.',
        '',
        ...entries.map((e) => `${new Date(e.at).toISOString().replace(/\.\d+Z$/, 'Z')}  ${WHO_WORDS[e.who]}  [${e.kind}]  ${e.text}`),
      ];
      const d = new Date();
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return { saved: await env.saveText(`${a.name}-activity-${date}.txt`, `${lines.join('\n')}\n`) };
    },
    diagnosticsSave: async () => {
      if (!env.saveText) throw new Error('Saving is not available here.');
      const d = new Date();
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return { saved: await env.saveText(`meadow-diagnostics-${date}.txt`, diagnosticsText(s, claudeState)) };
    },
    backup: async ({ agent, password }) => {
      const name = s.core.agents().find((a) => a.id === agent)?.name ?? 'agent';
      const before = (s.db.prepare('SELECT last_backup_at FROM agents WHERE id = ?').get(agent) as any)?.last_backup_at ?? null;
      const file = makeBackup(s.db, s.vault, agent, password);
      // Dated, in the last backup's folder, so a new file sits beside the old one (§16.12).
      const d = new Date();
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const folderKey = `backup_dir:${agent}`;
      const folder = (s.db.prepare('SELECT value FROM meta WHERE key = ?').get(folderKey) as any)?.value;
      const saved = await env.saveFile(`${name}-${date}.meadow-backup`, file, folder);
      // Cancelled: nothing was saved, so the last backup is still the older one.
      if (!saved) s.db.prepare('UPDATE agents SET last_backup_at = ? WHERE id = ?').run(before, agent);
      else {
        s.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(folderKey, dirname(saved));
        you(agent, 'backups', 'Backed up.');
      }
      return { saved, hadOlder: saved !== null && before !== null };
    },
    restoreOpen: async () => {
      restoring = await env.openFile();
      return restoring && { file: restoring.name };
    },
    movePlan: async ({ walletId, to }): Promise<MovePlanView> => {
      const t = moveTarget(walletId, to);
      const p = await s.mover.plan(walletId, t.address);
      return { to: p.to, toWallet: t.name, usdc: formatUsd(p.usdc), swapUsd: p.swap === null ? null : formatUsd(p.swap), arrivesUsd: formatUsd(p.arrives), contract: p.contract };
    },
    moveStart: async ({ walletId, to, confirm }) => {
      const now = moves.get(walletId);
      if (now && !['done', 'sent', 'failed'].includes(now.step)) return { ok: false, error: 'A move from this wallet is already under way.' };
      const t = moveTarget(walletId, to);
      if (!t.name && String(confirm ?? '').trim().toLowerCase() !== t.address.slice(-4).toLowerCase()) {
        return { ok: false, error: 'Type the last 4 characters of the address to confirm it.' };
      }
      const p = await s.mover.plan(walletId, t.address);
      const from = s.wallets.list().find((w) => w.id === walletId)!;
      const yes = await env.confirmMove({
        message: `Move about ${formatUsd(p.arrives)} out of ${from.name}?`,
        detail: `To ${t.name ? `your wallet ${t.name}, ` : ''}${p.to} on the Base network.\n\n`
          + (p.swap !== null ? `First, ${formatUsd(p.swap)} of it buys a little ETH for Base's network fee.\n\n` : '')
          + 'This cannot be undone.',
      });
      if (!yes) return { ok: false, error: 'Nothing moved.' };
      moves.set(walletId, { step: 'checking', to: p.to });
      void s.mover.run(walletId, p.to, (st) => {
        moves.set(walletId, { step: st.step, to: st.to, amount: st.amount, tx: st.tx, error: st.error });
        if (st.step === 'done' || st.step === 'sent') balanceCache = null;
      });
      return { ok: true };
    },
    moveStatus: async ({ walletId }) => moves.get(walletId) ?? null,
    // Move to Base (§16.9.3): a find on another network, or USDbC, to this same wallet's Base USDC.
    bridgePlan: async ({ walletId, network, kind }): Promise<BridgePlanView> => {
      const p = await s.bridger.plan(walletId, network, kind);
      return { network: p.network, kind: p.kind, route: p.route, amountUsd: p.amountUsd, feeUsd: p.feeUsd, arrivesUsd: p.arrivesUsd, high: p.high, gasFromUsdc: p.gasFromUsdc };
    },
    bridgeStart: async ({ walletId, network, kind }) => {
      const key = `${walletId}|${network}|${kind}`;
      const now = bridges.get(key);
      if (now && !['done', 'refunded', 'failed', 'unknown'].includes(now.step)) return { ok: false, error: 'This move is already under way.' };
      const p = await s.bridger.plan(walletId, network, kind);
      const w = s.wallets.list().find((x) => x.id === walletId)!;
      const what = kind === 'usdbc' ? `${p.amountUsd} of USDbC` : `${p.amountUsd} of USDC from ${network}`;
      const yes = await env.confirmMove({
        message: `Move ${what} to Base, in ${w.name}?`,
        detail: `At least ${p.arrivesUsd} arrives as USDC on Base, in this same wallet. ${p.route === 'relay' ? 'Relay' : 'CoW Protocol'} takes about ${p.feeUsd}.\n\n`
          + (p.route === 'relay' ? `Relay, a third-party bridge, carries it. If the move fails, Relay refunds it to this wallet on ${network}, less that network's fee.`
            : `The app first approves the swap on Base${p.gasFromUsdc ? ', paying its network fee with a little of this wallet\'s USDC' : ''}, then CoW Protocol swaps the USDbC for USDC.`),
      });
      if (!yes) return { ok: false, error: 'Nothing moved.' };
      bridges.set(key, { step: 'checking', network, kind });
      void s.bridger.run(walletId, network, kind, (st) => {
        bridges.set(key, st);
        if (['done', 'refunded', 'failed', 'unknown'].includes(st.step)) {
          balanceCache = null;
          void s.checkElsewhere({ wallet: walletId, force: true });
        }
        s.changedNow();
      });
      return { ok: true };
    },
    bridgeStatus: async ({ walletId }) => [...bridges].filter(([k]) => k.startsWith(`${walletId}|`)).map(([, v]) => v),
    // Findable by name (§16.6): a profile change, one paid call, with the answer in plain words.
    setDiscoverable: async ({ agent, on }) => {
      try {
        const r = await s.core.updateProfile(agent, { discoverable: !!on });
        you(agent, 'profile', `Findable by name turned ${on ? 'on' : 'off'}.${r.sent ? '' : ' It is queued, and goes with the next sync that can be paid for.'}`);
        s.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(`unlisted_notice_seen:${agent}`, String(Date.now()));
        if (!r.sent) return { ok: false, message: r.refused ? `Saved, but not sent yet: ${r.refused}` : 'Saved; it goes with the next sync.' };
        return { ok: true, message: on ? 'Other agents can now find this agent by name or search word.' : 'Other agents now reach this agent only by its handle.' };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },
    walletQr: async ({ walletId }) => {
      const w = s.wallets.list().find((x) => x.id === walletId);
      if (!w) throw new Error('There is no such wallet.');
      return { svg: await QRCode.toString(w.address, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }), address: w.address };
    },
    balances: async ({ fresh = false }: { fresh?: boolean } = {}) => {
      // Read again when asked (Refresh), after half a minute, or when a wallet is new since the last read.
      const ids = s.wallets.list().map((w) => w.id);
      if (fresh || !balanceCache || Date.now() - balanceCache.at > 30_000 || ids.some((id) => !(id in balanceCache!.values))) {
        const rail = s.catalog.baseRail('meadow');
        const values: Record<string, string | null> = {};
        for (const w of s.wallets.list()) {
          try {
            if (!rail) values[w.id] = null;
            else {
              const amount = await tokenBalance(w.address, rail.tokenAddress);
              s.noteBalance(w.id, amount); // a rise is a deposit (§16.9.2)
              values[w.id] = formatUsd(amount, rail.tokenDecimals);
            }
          } catch {
            values[w.id] = null;
          }
        }
        balanceCache = { at: Date.now(), values };
      }
      return balanceCache.values;
    },
  };

  return async (channel, arg) => {
    if (!CHANNELS.includes(channel)) return { error: 'Unknown request.' };
    try {
      const fn = asyncHandlers[channel] ?? (handlers[channel] as (a: unknown) => unknown);
      return await fn(arg ?? {});
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };
}
