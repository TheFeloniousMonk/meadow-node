// The core's side of the window's fixed channels (src/shared/api.ts). Each
// handler returns plain JSON; a failure comes back as {error} in plain words.
// The main process puts them on IPC; what needs Electron comes in `env`.

import QRCode from 'qrcode';
import { formatUsd } from '../core/catalog.ts';
import { GUARD_SERVICE } from '../core/guard.ts';
import { backupDue, describeBackup, makeBackup, readBackup, restoreBackup } from '../core/backup.ts';
import { tokenBalance } from '../core/balance.ts';
import { add, bridgeEntry, claudeDesktopConfigPath, entryName, remove, status } from '../server/claude-desktop.ts';
import { CHANNELS, EXTERNAL_LINKS, type Api, type AppState, type Channel, type MessageView } from '../shared/api.ts';
import type { Services } from './services.ts';

export interface HandlerEnv {
  /** The app's executable, which runs the Claude bridge as Node. */
  execPath: string;
  bridgeScript: string;
  copy(text: string): void;
  openExternal(url: string): void;
  /** Claude Desktop's settings file; by default where Claude Desktop keeps it on this computer. */
  claudeConfigPath?: string;
  /** Asks where to save a file (a system dialog); resolves to the path written, or null if cancelled. */
  saveFile(defaultName: string, data: Buffer): Promise<string | null>;
  /** Asks for a file to open; resolves to its name and bytes, or null. */
  openFile(): Promise<{ name: string; data: Buffer } | null>;
  /** Applies settings that belong to the operating system (start at login). */
  applySettings?(s: ReturnType<Services['settings']>): void;
}

const STATUS_WORDS: Record<string, string> = {
  missing_key: 'Encrypted. Its key has not arrived yet; the app has asked for it.',
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
            queued: s.core.outbox(a.id).filter((e) => e.kind === 'msg.post').length,
            lastSync: s.lastSync.get(a.id) ?? null,
          };
        }),
        wallets: s.wallets.list().map((w) => ({ id: w.id, name: w.name, address: w.address, dailyBudgetUsd: w.dailyBudgetUsd, spent24hUsd: formatUsd(w.spent24h), agents: w.agents })),
        payments: s.wallets.payments(30).map((p) => ({ at: p.signed_at, service: p.service, path: p.path, usd: formatUsd(BigInt(p.amount)), agent: p.agent, status: p.status, tx: p.tx })),
        problems: s.core.problems().slice(-20).reverse(),
        pricePerCallUsd: price ? formatUsd(price.atomic, price.decimals) : null,
        guardPriceUsd: guardPrice ? formatUsd(guardPrice.atomic, guardPrice.decimals) : null,
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

    connectClaude({ agent }) {
      const r = add(claudePath(), entryName(nameOf(agent)), claudeEntry(agent));
      return r.ok ? { ok: true } : { ok: false, error: r.error };
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

    setBudget({ walletId, dailyBudgetUsd }) {
      s.wallets.setBudget(walletId, dailyBudgetUsd);
      return { ok: true };
    },

    walletQr: undefined as any, // async, below

    syncNow: undefined as any, // async, below

    rooms({ agent }) {
      const unread = new Map<string, number>();
      const last = new Map<string, number>();
      for (const m of s.core.messages(agent)) {
        if (!m.delivered && m.author !== agent) unread.set(m.room, (unread.get(m.room) ?? 0) + 1);
        last.set(m.room, Math.max(last.get(m.room) ?? 0, m.ts));
      }
      return s.core.rooms(agent)
        .map((r) => ({ room: r.room, type: r.type, status: r.status, ...(r.name && { name: r.name }), ...(r.dmWith && { with: s.core.handleOf(agent, r.dmWith) ?? r.dmWith }), members: r.members, unread: unread.get(r.room) ?? 0, last: last.get(r.room) ?? 0 }))
        .sort((a, b) => b.last - a.last);
    },

    messages({ agent, room }): MessageView[] {
      const queued = new Set(s.core.outbox(agent).map((e) => e.id));
      return s.core.messages(agent, { room }).map((m) => ({
        id: m.id, room: m.room, author: m.author, authorHandle: s.core.handleOf(agent, m.author), mine: m.author === agent,
        ts: m.ts, status: m.status, statusWords: m.status === 'shown' ? null : STATUS_WORDS[m.status] ?? m.status,
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
      if (!EXTERNAL_LINKS.some((l) => url === l || url.startsWith(l))) return { ok: false };
      env.openExternal(url);
      return { ok: true };
    },
  };

  const asyncHandlers: Partial<Record<keyof Api, (a: any) => Promise<unknown>>> = {
    syncNow: ({ agent }) => s.syncOne(agent),
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
    walletQr: async ({ walletId }) => {
      const w = s.wallets.list().find((x) => x.id === walletId);
      if (!w) throw new Error('There is no such wallet.');
      return { svg: await QRCode.toString(w.address, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }), address: w.address };
    },
    balances: async () => {
      // Read again after a minute, or when a wallet is new since the last read.
      const ids = s.wallets.list().map((w) => w.id);
      if (!balanceCache || Date.now() - balanceCache.at > 60_000 || ids.some((id) => !(id in balanceCache!.values))) {
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
