// Troubleshoot (SPEC §16.21): one screen that checks every piece the app
// depends on, in the order they depend on each other, each with a state, one
// sentence, and the button that fixes it when the app has one. Above them, one
// line names the first thing that blocks. Built from local records and the
// last results of the outside checks (balances from Base, the address, the
// sign-in protection), which never cost money. The connection check on each
// agent's card is the same code (§16.17.2), so the two never disagree.

import { formatUsd } from '../core/catalog.ts';
import { tokenBalance } from '../core/balance.ts';
import { backupDue } from '../core/backup.ts';
import { GUARD_SERVICE } from '../core/guard.ts';
import type { CheckStep, TroubleAction, TroubleGroup, TroubleItem, TroubleState, TroubleshootView } from '../shared/api.ts';
import { connectionCheck, protectionCheck, type ClaudeState } from './check.ts';
import { describeFailure } from './tunnel.ts';
import type { Services } from './services.ts';

const HOST: Record<string, string> = { chatgpt: 'ChatGPT', claude: 'Claude', other: 'your AI' };
/** A balance that covers fewer days of background syncing than this is amber. */
export const LOW_DAYS = 3;
/** Past this share of the budget spent, amber. */
export const BUDGET_WARN = 0.8;
/** The outside checks run at most this often, unless the person presses Check again. */
export const OUTSIDE_EVERY_MS = 60_000;

/** The outside checks' last results, kept by the services. */
export interface Outside {
  at: number | null;
  checking: boolean;
  /** Each wallet's USDC in base units; null when Base could not be read. */
  balances: Map<string, bigint | null>;
  /** Each ChatGPT agent's sign-in protection: null when refused as it must be, else what came back. */
  protection: Map<string, string | null>;
}

export const newOutside = (): Outside => ({ at: null, checking: false, balances: new Map(), protection: new Map() });

const MARK: Record<CheckStep['state'], TroubleState> = { ok: 'ok', warn: 'warn', bad: 'bad' };
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const day = (at: number) => new Date(at).toLocaleDateString([], { day: 'numeric', month: 'long' });

const item = (key: string, label: string, state: TroubleState, text: string, extra: { at?: number | null; fix?: string; action?: TroubleAction } = {}): TroubleItem =>
  ({ key, label, state, text, ...(extra.at != null && { at: extra.at }), ...(extra.fix && { fix: extra.fix }), ...(extra.action && { action: extra.action }) });

/** A connection check step as a Troubleshoot line, with the button that fixes it. */
const fromStep = (st: CheckStep, action?: TroubleAction): TroubleItem =>
  item(st.key, st.label, MARK[st.state], st.text, { at: st.at, fix: st.fix, action: st.state === 'ok' ? undefined : action });

/** What one background sync a day costs per agent, from the live price: syncs × price. */
function dailySync(s: Services): bigint | null {
  const price = s.catalog.priceAtomic('meadow');
  const st = s.settings();
  if (!price) return null;
  return st.syncEnabled ? BigInt(Math.ceil((24 * 60) / st.syncMinutes)) * price.atomic : 0n;
}

export function troubleshoot(s: Services, claude: (agent: string) => ClaudeState): TroubleshootView {
  const out = s.outside;
  const settings = s.settings();
  const agents = s.core.agents();
  const price = s.catalog.priceAtomic('meadow');
  const perDay = dailySync(s);
  const groups: TroubleGroup[] = [];

  // ---- This computer ----
  const computer: TroubleItem[] = [];
  const chatgptUsed = agents.some((a) => (s.connections.get(a.id) as any)?.type === 'chatgpt') || settings.tunnelProvider !== 'none';
  const door = s.tunnel.status.door;
  if (!s.server?.listening) {
    computer.push(item('interfaces', 'The app\'s interfaces', 'bad', s.serverError ?? 'The way your AI reaches this app on this computer is not listening.',
      { fix: s.serverError && /taken/.test(s.serverError) ? 'Open Settings, then Connections, and choose another port.' : 'Quit Meadow from its icon near the clock and open it again.' }));
  } else if (chatgptUsed && (!s.publicServer?.listening || (door && !door.ok))) {
    computer.push(item('interfaces', 'The app\'s interfaces', 'bad', s.publicError ?? (door?.why ? `The app's ChatGPT door does not answer as it should: ${door.why}.` : 'The app\'s ChatGPT door is not listening.'),
      { fix: s.publicError && /taken/.test(s.publicError) ? 'Open Settings, then Connections, and choose another port for ChatGPT.' : 'Quit Meadow from its icon near the clock and open it again.' }));
  } else {
    computer.push(item('interfaces', 'The app\'s interfaces', 'ok', `Listening for your AI on this computer (port ${settings.localPort}${chatgptUsed ? `, and ${settings.publicPort} for ChatGPT` : ''}).`));
  }
  const u = s.update.available;
  computer.push(u
    ? item('update', 'Updates', 'warn', `Meadow ${u.version} is available; this is ${s.version}.`, { action: u.action === 'none' ? undefined : { label: 'Update now', run: 'updateNow' }, fix: u.action === 'none' ? 'Download it from the releases page.' : undefined })
    : item('update', 'Updates', 'ok', `Version ${s.version}; no newer version found.`));
  computer.push(settings.startAtLogin
    ? item('login', 'Start at login', 'ok', 'On: Meadow starts with this computer.')
    : item('login', 'Start at login', 'info', 'Off: Meadow, and ChatGPT\'s way in, stop when you quit it or restart the computer.', { action: { label: 'Turn on', run: 'startAtLogin' } }));
  const guardCost = s.catalog.priceAtomic(GUARD_SERVICE)?.atomic;
  computer.push(settings.guardPublic || settings.guardPrivate
    ? item('guard', 'MessageGuard', 'ok', `On for ${settings.guardPublic && settings.guardPrivate ? 'every room' : settings.guardPublic ? 'public rooms' : 'private rooms and DMs'}.`)
    : item('guard', 'MessageGuard', 'info', `Off. Recommended: it checks new messages for prompt injection${guardCost ? `, for ${formatUsd(guardCost)} a sync that brings new messages` : ''}.`,
      { action: { label: 'Turn on in Settings', go: 'settings' } }));
  groups.push({ title: 'This computer', items: computer });

  // ---- Money ----
  const money: TroubleItem[] = [];
  const wallets = s.wallets.list();
  const paying = (w: { agents: string[] }) => agents.filter((a) => w.agents.includes(a.id) && a.registered).length;
  for (const a of agents.filter((x) => !s.wallets.walletOf(x.id))) {
    money.push(item(`nowallet:${a.id}`, 'Wallets', 'bad', `${a.display_name} has no wallet to pay for its calls.`,
      wallets.length ? { action: { label: 'Choose a wallet', go: 'agents', open: 'chooseWallet', agent: a.id } } : { action: { label: 'Create a wallet', go: 'wallets' } }));
  }
  for (const w of wallets.filter((x) => x.agents.length)) {
    const bal = out.balances.get(w.id);
    const need = perDay !== null ? perDay * BigInt(paying(w)) : null;
    const topOff: TroubleAction = { label: 'Top off', go: 'wallets', open: 'topOff', wallet: w.id };
    if (bal === undefined) money.push(item(`balance:${w.id}`, 'Wallets', 'info', `${w.name}: checking its balance…`));
    else if (bal === null) money.push(item(`balance:${w.id}`, 'Wallets', 'warn', `The app could not read ${w.name}'s balance from Base just now.`, { fix: 'Check this computer\'s internet connection; Check again tries once more.' }));
    else if (price && bal < price.atomic) money.push(item(`balance:${w.id}`, 'Wallets', 'bad', `${w.name} is empty (${formatUsd(bal)}), so its agents' calls cannot be paid.`, { action: topOff }));
    else if (need && bal < need * BigInt(LOW_DAYS)) money.push(item(`balance:${w.id}`, 'Wallets', 'warn', `${w.name} has ${formatUsd(bal)}: less than ${LOW_DAYS} days of background syncing (about ${formatUsd(need)} a day).`, { action: topOff }));
    else money.push(item(`balance:${w.id}`, 'Wallets', 'ok', `${w.name}: ${formatUsd(bal)}${need ? `, about ${(bal / need).toString()} days of background syncing` : ''}.`));

    if (!price) continue;
    const b = s.wallets.budgetFor(w.id, price.atomic);
    const budget: TroubleAction = { label: 'Change the budget', go: 'wallets', open: 'budget', wallet: w.id };
    if (!b.fits) {
      money.push(item(`budget:${w.id}`, 'Budgets', 'bad', b.frees
        ? `${w.name}'s daily budget is spent: ${formatUsd(b.spent)} of ${formatUsd(b.budget)} in the last 24 hours. Paid calls are refused until ${clock(b.frees)}.`
        : `${w.name}'s daily budget (${formatUsd(b.budget)}) is less than one call (${formatUsd(price.atomic)}).`, { action: budget }));
    } else if (need && need > b.budget) {
      money.push(item(`budget:${w.id}`, 'Budgets', 'warn', `Background syncing alone needs about ${formatUsd(need)} a day for ${w.name}'s ${paying(w)} agent${paying(w) === 1 ? '' : 's'}, more than its daily budget of ${formatUsd(b.budget)}.`,
        { fix: 'Raise the budget, or sync less often in Settings.', action: budget }));
    } else if (b.budget > 0n && Number(b.spent) >= Number(b.budget) * BUDGET_WARN) {
      money.push(item(`budget:${w.id}`, 'Budgets', 'warn', `${w.name} has spent ${formatUsd(b.spent)} of its ${formatUsd(b.budget)} daily budget in the last 24 hours.`, { action: budget }));
    } else {
      money.push(item(`budget:${w.id}`, 'Budgets', 'ok', `${w.name}: ${formatUsd(b.spent)} of ${formatUsd(b.budget)} spent in the last 24 hours.`));
    }
  }
  if (!wallets.length && !agents.length) money.push(item('wallets', 'Wallets', 'info', 'No wallet yet. Create one before adding an agent.', { action: { label: 'Create a wallet', go: 'wallets' } }));
  groups.push({ title: 'Money', items: money });

  // ---- Each agent ----
  for (const a of agents) {
    const conn = s.connections.get(a.id) as { type: string } | null;
    const host = HOST[conn?.type ?? ''] ?? 'your AI';
    const items: TroubleItem[] = [];
    items.push(a.registered
      ? item('registered', 'Registered', 'ok', `On the network as ${a.handle}.`)
      : item('registered', 'Registered', 'bad', 'Not registered on the network yet.', { fix: conn ? `Ask ${host} to register it on Meadow (one paid call).` : 'Give it a connection first, on the Agents screen.' }));
    const check = connectionCheck(s, a.id, claude(a.id));
    if (!check) {
      items.push(item('way', 'The way in', 'bad', 'It has no connection to an AI.', { fix: 'Remove it and add it again with the AI that will use it.', action: { label: 'Open Agents', go: 'agents' } }));
    } else {
      for (const st of check.steps) {
        if (st.key === 'network') items.push(fromStep(st, a.registered && s.wallets.walletOf(a.id) ? { label: `Sync now${price ? ` (${formatUsd(price.atomic)})` : ''}`, run: 'syncNow', agent: a.id } : undefined));
        else if (st.key === 'bridge') items.push(fromStep(st, { label: claude(a.id)?.installed ? 'Update Claude\'s settings' : 'Connect Claude', go: 'agents', open: 'claude', agent: a.id }));
        else if (st.key === 'tunnel') {
          const t = s.tunnel.status;
          items.push(fromStep(st, t.provider === 'none' || t.state === 'off' || t.state === 'error'
            ? { label: 'Turn the tunnel on', go: 'settings' }
            : t.provider === 'ngrok' ? { label: 'Restart tunnel', run: 'restartTunnel' } : undefined));
          // Sign-in protection (§16.21.3): the tools, through the address, must refuse a caller with no token.
          if (s.tunnel.url) {
            const p = out.protection.get(a.id);
            items.push(p === undefined
              ? item('protection', 'Sign-in protection', 'info', 'Checking…')
              : p === null
                ? item('protection', 'Sign-in protection', 'ok', 'Without signing in, the app refuses, as it must.', { at: out.at })
                : item('protection', 'Sign-in protection', 'bad', `A call without signing in did not get this app's refusal: ${p}.`, { at: out.at, fix: 'Check that the tunnel points at this app (port ' + settings.publicPort + '), then press Check again.' }));
          }
        } else if (st.key === 'signin') items.push(fromStep(st, { label: 'Pair ChatGPT again', go: 'agents', open: 'chatgpt', agent: a.id }));
        else items.push(fromStep(st));
      }
    }
    const last = (s.db.prepare('SELECT last_backup_at FROM agents WHERE id = ?').get(a.id) as any)?.last_backup_at ?? null;
    const nudge = backupDue(s.db, a.id);
    items.push(nudge
      ? item('backup', 'Backup', 'warn', nudge, { action: { label: last ? 'Back up again' : 'Back up now', go: 'agents', open: 'backup', agent: a.id } })
      : last
        ? item('backup', 'Backup', 'ok', `Last backup ${day(last)}.`)
        : item('backup', 'Backup', 'info', 'Never backed up. Nothing private to lose yet.', { action: { label: 'Back up now', go: 'agents', open: 'backup', agent: a.id } }));
    const held = s.core.messages(a.id).filter((m) => m.guard?.held === 1).length;
    const queued = s.core.outbox(a.id).filter((e) => e.kind === 'msg.post').length;
    items.push(held || queued
      ? item('waiting', 'Waiting for you', 'warn', [held && `${held} message${held === 1 ? '' : 's'} MessageGuard kept aside`, queued && `${queued} message${queued === 1 ? '' : 's'} not sent yet`].filter(Boolean).join('; ') + '.',
        { action: { label: 'Open Inbox', go: 'inbox', agent: a.id } })
      : item('waiting', 'Waiting for you', 'ok', 'Nothing kept aside or waiting to be sent.'));
    groups.push({ title: a.display_name, agent: a.id, items });
  }

  // The verdict: the first red line, in this order; amber never takes it while something is red.
  const all = groups.flatMap((g) => g.items.map((i) => ({ g, i })));
  const reds = all.filter((x) => x.i.state === 'bad');
  const amber = all.filter((x) => x.i.state === 'warn').length;
  let verdict: TroubleshootView['verdict'];
  if (reds.length) {
    const { g, i } = reds[0];
    const whose = g.agent ? ` for ${g.title}` : '';
    verdict = { state: 'bad', text: `Everything is working except ${i.label.toLowerCase()}${whose}: ${i.fix ?? i.text}`, ...(i.action && { action: i.action }), more: reds.length - 1, amber };
  } else {
    verdict = {
      state: 'ok', more: 0, amber,
      text: amber
        ? `Everything is working. ${amber === 1 ? 'One thing could' : `${amber} things could`} use a look below.`
        : 'Everything is working. If your AI still shows an error, it is on its side: ask it to check your Meadow status (free), or start a new conversation there.',
    };
  }
  return { verdict, groups, outside: { checking: out.checking, at: out.at } };
}

/**
 * The outside checks (§16.21.4): wallet balances from Base (free), and for each ChatGPT
 * agent the address and the sign-in protection (2 requests each against a free ngrok
 * account's monthly limit). At most once a minute unless `again`. No paid call, no sync.
 */
export async function runOutside(s: Services, { again = false, fetchImpl = fetch as typeof fetch, balanceOf = tokenBalance } = {}): Promise<boolean> {
  const out = s.outside;
  if (out.checking || (!again && out.at && Date.now() - out.at < OUTSIDE_EVERY_MS)) return false;
  out.checking = true;
  s.changedNow();
  try {
    const rail = s.catalog.baseRail('meadow');
    await Promise.all(s.wallets.list().map(async (w) => {
      try {
        out.balances.set(w.id, rail ? await balanceOf(w.address, rail.tokenAddress) : null);
      } catch {
        out.balances.set(w.id, null);
      }
    }));
    const chatgpt = s.core.agents().filter((a) => (s.connections.get(a.id) as any)?.type === 'chatgpt');
    if (chatgpt.length && s.tunnel.url) {
      await s.tunnel.checkNow();
      for (const a of chatgpt) {
        const base = s.tunnel.url;
        if (!base) break;
        try {
          out.protection.set(a.id, await protectionCheck(base, a.name, fetchImpl));
        } catch (err) {
          out.protection.set(a.id, describeFailure(err));
        }
      }
    }
    out.at = Date.now();
    return true;
  } finally {
    out.checking = false;
    s.changedNow();
  }
}
