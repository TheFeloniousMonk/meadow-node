// The core's side of the window's fixed channels (src/shared/api.ts). Each
// handler returns plain JSON; a failure comes back as {error} in plain words.
// The main process puts them on IPC; what needs Electron comes in `env`.

import QRCode from 'qrcode';
import { formatUsd } from '../core/catalog.ts';
import { GUARD_SERVICE } from '../core/guard.ts';
import { backupDue, describeBackup, makeBackup, readBackup, restoreBackup } from '../core/backup.ts';
import { tokenBalance } from '../core/balance.ts';
import { add, bridgeEntry, claudeDesktopConfigPath, claudeDesktopRunning, entryName, remove, status } from '../server/claude-desktop.ts';
import { CHANNELS, linkAllowed, type Api, type AppState, type Channel, type MessageView, type MovePlanView, type MoveStateView } from '../shared/api.ts';
import type { Services } from './services.ts';

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
  saveFile(defaultName: string, data: Buffer): Promise<string | null>;
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

export function createHandlers(s: Services, env: HandlerEnv): (channel: Channel, arg: unknown) => Promise<unknown> {
  // The backup chosen for a restore, held in memory between the person's steps.
  let restoring: { name: string; data: Buffer } | null = null;
  let balanceCache: { at: number; values: Record<string, string | null> } | null = null;
  // Each wallet's move in progress or last finished (§16.9.1), for the window to follow.
  const moves = new Map<string, MoveStateView>();
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
            backupDue: backupDue(s.db, a.id),
            mcpUrl: conn?.type === 'chatgpt' && s.tunnel.url ? `${s.tunnel.url}/${a.name}/mcp` : null,
            runner: s.runner.config(a.id),
            runnerLog: s.runner.log(a.id, 5),
            queued: s.core.outbox(a.id).filter((e) => e.kind === 'msg.post').length,
            lastSync: s.lastSync.get(a.id) ?? null,
            discoverable: a.registered ? s.core.discoverable(a.id) : null,
            unlistedNotice: a.registered && s.core.discoverable(a.id) !== true && !s.db.prepare('SELECT 1 FROM meta WHERE key = ?').get(`unlisted_notice_seen:${a.id}`),
          };
        }),
        wallets: s.wallets.list().map((w) => ({ id: w.id, name: w.name, address: w.address, dailyBudgetUsd: w.dailyBudgetUsd, spent24hUsd: formatUsd(w.spent24h), agents: w.agents })),
        payments: s.wallets.payments(30).map((p) => ({ at: p.signed_at, service: p.service, path: p.path, usd: formatUsd(BigInt(p.amount)), agent: p.agent, status: p.status, tx: p.tx })),
        problems: s.core.problems().slice(-20).reverse(),
        pricePerCallUsd: price ? formatUsd(price.atomic, price.decimals) : null,
        guardPriceUsd: guardPrice ? formatUsd(guardPrice.atomic, guardPrice.decimals) : null,
        tunnel: { ...s.tunnel.status, error: s.publicError ?? s.tunnel.status.error, hasNgrokToken: s.ngrokToken() !== null, port: s.settings().publicPort },
        authorized: s.oauth.authorized().map((c) => ({ ...c, agentName: s.core.agents().find((a) => a.id === c.agent)?.display_name ?? c.agent })),
        catalogError: s.catalog.fetchedAt ? null : 'The app has not read the portal\'s price list yet.',
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
      s.wallets.assign(agent, walletId);
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

    walletQr: undefined as any, // async, below

    syncNow: undefined as any, // async, below

    rooms({ agent }) {
      const unread = new Map<string, number>();
      const last = new Map<string, number>();
      for (const m of s.core.messages(agent)) {
        if (!m.delivered && m.author !== agent) unread.set(m.room, (unread.get(m.room) ?? 0) + 1);
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
            room: r.room, type: r.type ?? i?.type ?? null, status: r.status, ...(name && { name }), ...(topic && { topic }),
            ...(r.dmWith && { with: s.core.handleOf(agent, r.dmWith) ?? r.dmWith }), members: r.members, unread: unread.get(r.room) ?? 0, last: last.get(r.room) ?? 0,
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
        unreadByAgent: !m.delivered && m.author !== agent, queued: queued.has(m.id),
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
    connectClaude: undefined as any,
    claudeRunning: undefined as any,
    installUpdate: undefined as any,
    setTunnel: undefined as any,

    enterChatgptCode({ agent, code }) {
      if (typeof agent !== 'string' || typeof code !== 'string' || code.length > 40) return { ok: false, error: 'Type the code the ChatGPT page shows.' };
      return s.oauth.enterCode(agent, code);
    },

    revokeClient({ client, agent }) {
      s.oauth.revoke(client, agent);
      return { ok: true };
    },

    setRunner({ agent, ...c }) {
      s.runner.configure(agent, c);
      return { ok: true };
    },

    guardDecide({ agent, message, release }) {
      s.guard.decide(agent, message, release);
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
      const { agent } = restoreBackup(s.db, s.vault, readBackup(restoring.data, password), { replace });
      s.core.forget(agent);
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
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    },
    setTunnel: async (t) => {
      await s.setTunnel(t);
      return { ok: true };
    },
    guardCheck: async ({ agent, message }) => {
      const r = await s.guard.checkOne(agent, message);
      return { verdict: r?.verdict ?? null, matches: r?.matches.map((m) => m.label) ?? [] };
    },
    backup: async ({ agent, password }) => {
      const name = s.core.agents().find((a) => a.id === agent)?.name ?? 'agent';
      const file = makeBackup(s.db, s.vault, agent, password);
      return { saved: await env.saveFile(`${name}.meadow-backup`, file) };
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
    // Findable by name (§16.6): a profile change, one paid call, with the answer in plain words.
    setDiscoverable: async ({ agent, on }) => {
      try {
        const r = await s.core.updateProfile(agent, { discoverable: !!on });
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
            values[w.id] = rail ? formatUsd(await tokenBalance(w.address, rail.tokenAddress), rail.tokenDecimals) : null;
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
