// The connection check, Test connection, and the diagnostics export (SPEC
// §16.17). Each step between the person's AI and the network reports its own
// state in plain words, and the first one that is not working is named, with
// what to do. Nothing here makes a paid call.

import { release } from 'node:os';
import { SLOW_MS, scrub, type EventRow, type Via } from '../core/diagnostics.ts';
import type { CheckStep, ConnectionCheckView, ConnectionTestView } from '../shared/api.ts';
import type { Services } from './services.ts';
import { BLOCKED_HERE, BLOCKED_WHY, describeAnswer, describeFailure } from './tunnel.ts';

/** The Claude Desktop entry's state, as the Agents screen already reads it. */
export type ClaudeState = { installed: boolean; upToDate: boolean; unreadable: boolean } | null;

const VIA: Record<string, Via[]> = { chatgpt: ['chatgpt'], claude: ['claude'], other: ['local', 'rest', 'runner'] };
const HOST: Record<string, string> = { chatgpt: 'ChatGPT', claude: 'Claude', other: 'your AI' };

const SYNC_WORDS: Record<string, { text: string; fix: string }> = {
  'payment refused': { text: 'the wallet would not pay for it', fix: 'Look at the wallet on the Wallets screen: its balance, and its budget for today.' },
  'portal unreachable': { text: 'the app could not reach the Meadow network', fix: 'Check this computer\'s internet connection; the app tries again at the next sync.' },
  'reply too large': { text: 'the network sent an answer too large to read', fix: 'Try again later. If it keeps happening, export diagnostics and send them to whoever helps you.' },
  portal: { text: 'the portal answered with an error', fix: 'Try again later. If it keeps happening, export diagnostics and send them to whoever helps you.' },
  node: { text: 'the Meadow network refused it', fix: 'Try again later. If it keeps happening, export diagnostics and send them to whoever helps you.' },
  app: { text: 'the app failed', fix: 'Quit Meadow from its icon near the clock and open it again.' },
};

/** What to do about a door that is not listening: another port only when the port is taken. */
const portFix = (error: string | null, where: string) =>
  error && /taken/.test(error) ? `Open Settings, then Connections, and choose another port for ${where}.` : 'Quit Meadow from its icon near the clock and open it again.';

const step = (key: CheckStep['key'], label: string, state: CheckStep['state'], text: string, extra: { at?: number | null; fix?: string } = {}): CheckStep =>
  ({ key, label, state, text, ...(extra.at != null && { at: extra.at }), ...(extra.fix && { fix: extra.fix }) });

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** Step 3 (§16.17.2, §16.17.8): what the app last confirmed about the tunnel, not that it was started. */
export function tunnelStep(s: Services): CheckStep {
  const t = s.tunnel.status;
  const turnOn = 'Open Settings, then Connections, and turn the tunnel on.';
  if (t.provider === 'none') return step('tunnel', 'Tunnel', 'bad', 'No tunnel is set up, so ChatGPT cannot reach this computer.', { fix: turnOn });
  switch (t.state) {
    case 'on':
      return step('tunnel', 'Tunnel', 'ok', `On, at ${t.url}; reached this app`, { at: t.reachedAt });
    case 'starting':
      return step('tunnel', 'Tunnel', 'warn', 'Starting.', { fix: 'Wait a few seconds.' });
    case 'reconnecting':
      return t.restarts > 0
        ? step('tunnel', 'Tunnel', 'warn', `The tunnel stopped reaching this app${t.why ? `: ${t.why}` : ''}. The app is restarting it (${t.restarts} ${t.restarts === 1 ? 'try' : 'tries'} so far).`, { fix: 'Wait a few minutes; the app keeps trying.' })
        : step('tunnel', 'Tunnel', 'warn', 'ngrok lost its connection and is reconnecting.', { fix: 'Wait a minute; the app restarts it if it does not come back.' });
    case 'unreachable': {
      // Nothing to restart: the block is between this computer and the address (§16.17.8).
      if (t.blockedHere) {
        return step('tunnel', 'Tunnel', 'warn', `${BLOCKED_HERE}: ${t.why ?? 'no answer'}. ${BLOCKED_WHY}`,
          { fix: 'If ChatGPT works, nothing needs doing. To clear this, pause that protection or VPN for a moment and press Check again.' });
      }
      if (t.heldElsewhere) return step('tunnel', 'Tunnel', 'bad', 'Your ngrok address is open somewhere else, perhaps on another computer.', { fix: 'Close it there, then press Restart tunnel.' });
      const lead = t.wokeAt ? `After this computer woke at ${clock(t.wokeAt)}, the tunnel` : 'The tunnel';
      if (t.provider === 'custom') {
        return step('tunnel', 'Tunnel', 'bad', `${lead} stopped reaching this app: ${t.why ?? 'no answer'}.`, { fix: 'Restart your own tunnel program, then press Test connection.' });
      }
      const tried = t.restarts ? ` The app restarted it ${t.restarts} ${t.restarts === 1 ? 'time' : 'times'}.` : '';
      return step('tunnel', 'Tunnel', 'bad', `${lead} stopped reaching this app: ${t.why ?? 'no answer'}.${tried}`,
        { fix: 'Press Restart tunnel. If that does not help, check this computer\'s internet connection, or quit Meadow from its icon near the clock and open it again.' });
    }
    default:
      return step('tunnel', 'Tunnel', 'bad', t.error ?? 'The tunnel is off, so ChatGPT cannot reach this computer.', { fix: turnOn });
  }
}

/** The connection check for one agent (§16.17.2); null for an agent with no connection. */
export function connectionCheck(s: Services, agent: string, claude: ClaudeState): ConnectionCheckView | null {
  const conn = s.connections.get(agent) as { type: string } | null;
  if (!conn) return null;
  const type = conn.type;
  const host = HOST[type] ?? 'your AI';
  const Host = host[0].toUpperCase() + host.slice(1);
  const steps: CheckStep[] = [];
  const a = s.core.agents().find((x) => x.id === agent);

  // 1. The network: the last sync that worked, or the last that failed after it.
  const ok = s.lastSyncOk(agent);
  const fail = s.diagnostics.last('sync', Object.keys(SYNC_WORDS), agent);
  if (fail && (!ok || fail.lastAt > ok)) {
    const w = SYNC_WORDS[fail.what] ?? SYNC_WORDS.app;
    steps.push(step('network', 'Meadow network', 'bad', `The last sync failed: ${w.text}.`, { at: fail.lastAt, fix: w.fix }));
  } else if (ok) {
    steps.push(step('network', 'Meadow network', 'ok', 'Last synced', { at: ok }));
  } else {
    steps.push(step('network', 'Meadow network', 'warn', a?.registered ? 'Not synced yet.' : 'This agent is not registered yet.',
      { fix: a?.registered ? 'Press Sync Now on the Dashboard.' : `Ask ${host} to register it on Meadow.` }));
  }

  // 2. The way in: the ChatGPT door, the Claude Desktop entry, or the local interfaces.
  if (type === 'chatgpt') {
    const port = s.settings().publicPort;
    const door = s.tunnel.status.door;
    steps.push(!s.publicServer?.listening
      ? step('door', 'The app\'s ChatGPT door', 'bad', s.publicError ?? 'It is not listening.', { fix: portFix(s.publicError, 'ChatGPT') })
      // Listening, but its own loopback check got the wrong answer (§16.17.8): no tunnel restart fixes that.
      : door && !door.ok
        ? step('door', 'The app\'s ChatGPT door', 'bad', `It does not answer as it should: ${door.why}.`, { at: door.at, fix: 'Quit Meadow from its icon near the clock and open it again.' })
        : step('door', 'The app\'s ChatGPT door', 'ok', `Listening on port ${port}.`));
  } else if (type === 'claude') {
    steps.push(!claude || claude.unreadable
      ? step('bridge', 'Claude Desktop', 'warn', 'The app cannot read Claude Desktop\'s settings file.', { fix: 'Press Connect Claude on this card, with Claude Desktop closed.' })
      : !claude.installed
        ? step('bridge', 'Claude Desktop', 'bad', 'Claude Desktop does not have Meadow in its settings.', { fix: 'Quit Claude Desktop, press Connect Claude on this card, then open Claude again.' })
        : !claude.upToDate
          ? step('bridge', 'Claude Desktop', 'warn', 'Claude Desktop\'s Meadow entry is out of date.', { fix: 'Quit Claude Desktop, press Update Claude\'s settings on this card, then open Claude again.' })
          : step('bridge', 'Claude Desktop', 'ok', 'Meadow is in Claude Desktop\'s settings.'));
  } else {
    steps.push(s.server?.listening
      ? step('door', 'Local interfaces', 'ok', `Listening on port ${s.settings().localPort}.`)
      : step('door', 'Local interfaces', 'bad', s.serverError ?? 'They are not listening.', { fix: portFix(s.serverError, 'the local interfaces') }));
  }

  // 3 and 4. ChatGPT only: the tunnel, and ChatGPT's sign-in.
  if (type === 'chatgpt') {
    steps.push(tunnelStep(s));

    const approved = s.oauth.authorized().filter((c) => c.agent === agent);
    const signin = s.diagnostics.last('oauth', ['issued', 'refreshed', 'refused', 'revoked'], agent);
    // A 401 for a request with no token is not a failed sign-in: ChatGPT's own first
    // request has none, and so does Test connection's, and so does a stranger's.
    const refused401 = s.diagnostics.events({ agent, kinds: ['http'], limit: 50 })
      .find((e) => e.what === '401' && e.agent === agent && e.detail !== 'sign-in token: none');
    const lastCall = s.diagnostics.calls(agent, { via: ['chatgpt'], limit: 200 }).find((c) => c.outcome !== 'failed');
    // A call that worked, or a token issued or refreshed since, means ChatGPT holds a working sign-in again.
    const lastOk = Math.max(lastCall?.at ?? 0, signin && signin.what !== 'refused' ? signin.lastAt : 0);
    if (!approved.length) {
      steps.push(signin && ['issued', 'refreshed', 'refused'].includes(signin.what)
        ? step('signin', 'ChatGPT\'s sign-in', 'bad', signin.what === 'refused' ? `ChatGPT's sign-in was refused: ${signin.detail.replace(/^[a-z_]+: /, '')}` : 'ChatGPT\'s sign-in has expired.',
          { at: signin.lastAt, fix: 'In ChatGPT, connect the Meadow app again; then type the code it shows on this card.' })
        : step('signin', 'ChatGPT\'s sign-in', 'bad', signin?.what === 'revoked' ? 'ChatGPT\'s approval was revoked in Settings.' : 'ChatGPT has not been approved yet.',
          { fix: 'Follow Set up ChatGPT on this card.' }));
    } else if (refused401 && refused401.lastAt > lastOk) {
      steps.push(step('signin', 'ChatGPT\'s sign-in', 'warn', `ChatGPT's last call was refused: its ${refused401.detail}.`,
        { at: refused401.lastAt, fix: 'ChatGPT usually renews its sign-in by itself. If this stays, connect the Meadow app again in ChatGPT.' }));
    } else {
      steps.push(step('signin', 'ChatGPT\'s sign-in', 'ok', signin && signin.what !== 'refused' ? 'Approved; last renewed' : 'Approved.', { at: signin && signin.what !== 'refused' ? signin.lastAt : null }));
    }
  }

  // 5. The last call from the AI.
  const last = s.diagnostics.calls(agent, { via: VIA[type] ?? ['local'], limit: 1 })[0];
  if (!last) {
    steps.push(step('lastcall', `Last call from ${host}`, 'warn', `${Host} has not called Meadow yet.`, { fix: `Ask ${host} to use Meadow, for example: “Check my Meadow status.”` }));
  } else if (last.outcome === 'failed') {
    steps.push(step('lastcall', `Last call from ${host}`, 'bad', `${last.name} failed: ${last.error ?? 'no reason given'}`, { at: last.at, fix: 'Try again. If it fails the same way, export diagnostics and send them to whoever helps you.' }));
  } else if (last.ms > SLOW_MS) {
    steps.push(step('lastcall', `Last call from ${host}`, 'warn', `${last.name} took ${Math.round(last.ms / 1000)} seconds. ${Host} may have stopped waiting and shown an error, although the app finished.`, { at: last.at, fix: 'Try again; the network is usually faster.' }));
  } else if (last.outcome === 'refused') {
    steps.push(step('lastcall', `Last call from ${host}`, 'ok', `${last.name} was refused by the app, as set: ${last.error ?? ''}`, { at: last.at }));
  } else {
    steps.push(step('lastcall', `Last call from ${host}`, 'ok', `${last.name} worked`, { at: last.at }));
  }

  const first = steps.find((x) => x.state !== 'ok');
  const verdict = first
    ? { state: first.state === 'bad' ? 'bad' as const : 'warn' as const, text: `${first.label}: ${first.fix ?? first.text}` }
    : { state: 'ok' as const, text: `Everything on this computer is working. If ${host} still shows an error, it is on ${host}'s side: try again, or start a new conversation there.` };
  return { verdict, steps };
}

/**
 * Test connection's second request (§16.17.3), also Troubleshoot's sign-in protection (§16.21.3):
 * an agent's tools through the address with no token must get this app's own 401. Null when
 * they do; otherwise what came back. Throws when nothing answered.
 */
export async function protectionCheck(base: string, name: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const res = await fetchImpl(`${base}/${name}/mcp`, {
    method: 'POST', body: '{}', signal: AbortSignal.timeout(10_000),
    headers: { 'ngrok-skip-browser-warning': '1', 'user-agent': 'Meadow connection test', 'content-type': 'application/json' },
  });
  if (res.status !== 401) return describeAnswer(res);
  return /resource_metadata=/.test(res.headers.get('www-authenticate') ?? '') ? null : 'a refusal that is not this app\'s';
}

/**
 * Test connection (§16.17.3): from this computer, what a stranger on the internet could
 * do, through the tunnel's public address. Sends no token and makes no paid call.
 */
export async function testConnection(s: Services, agent: string, fetchImpl: typeof fetch = fetch): Promise<ConnectionTestView> {
  const note = 'This checks the tunnel and this app together. It cannot check ChatGPT\'s side: ask ChatGPT to check your Meadow status (free) to try the whole way.';
  const a = s.core.agents().find((x) => x.id === agent);
  const base = s.tunnel.url;
  if (!a || !base) {
    s.diagnostics.event('test', 'fail', 'no tunnel address', agent);
    return { ok: false, steps: [{ label: 'The tunnel\'s public address', ok: false, text: 'The tunnel is not on, so there is nothing to test.' }], note };
  }
  const headers = { 'ngrok-skip-browser-warning': '1', 'user-agent': 'Meadow connection test' };
  const describe = describeAnswer;
  const attempt = async (label: string, run: () => Promise<string | null>) => {
    try {
      const why = await run();
      return { label, ok: why === null, text: why ?? 'As expected.' };
    } catch (err) {
      const why = describeFailure(err);
      return { label, ok: false, text: `${why[0].toUpperCase()}${why.slice(1)}.` };
    }
  };
  const resource = `${base}/${a.name}/mcp`;
  const steps = [
    await attempt('The sign-in description ChatGPT reads first', async () => {
      const res = await fetchImpl(`${base}/.well-known/oauth-protected-resource/${a.name}/mcp`, { headers, signal: AbortSignal.timeout(10_000) });
      if (res.status !== 200) return describe(res);
      const j: any = await res.json().catch(() => null);
      return j?.resource === resource ? null : 'an answer from something other than this app';
    }),
    await attempt('Meadow\'s tools, without signing in (must be refused)', () => protectionCheck(base, a.name, fetchImpl)),
  ];
  const ok = steps.every((x) => x.ok);
  // A pass went through the address to this app: it counts as the tunnel's check (§16.17.8).
  if (ok) s.tunnel.confirm();
  s.diagnostics.event('test', ok ? 'pass' : 'fail', ok ? '' : steps.filter((x) => !x.ok).map((x) => `${x.label}: ${x.text}`).join('; '), agent);
  return { ok, steps, note };
}

/**
 * The diagnostics export (§16.17.4), built from a list of allowed fields, not by
 * removing secrets from a dump. No tokens, keys, codes, passwords, phrases, wallet
 * addresses or balances, handles, agent or room IDs or names, messages, or other
 * agent-written text; the tunnel's host is replaced. Error sentences are the app's
 * own words, with any identifier in them taken out.
 */
export function diagnosticsText(s: Services, claude: (agent: string) => ClaudeState, now = Date.now()): string {
  const t = (at: number | null | undefined) => (at ? new Date(at).toISOString().replace('.000', '') : 'never');
  const hideTunnel = (text: string) => {
    const url = s.tunnel.url;
    return url ? text.split(new URL(url).host).join('<tunnel>') : text;
  };
  const clean = (text: string) => scrub(hideTunnel(text));
  const settings = s.effectiveSettings();
  const lines: string[] = [
    'Meadow app diagnostics',
    `Made: ${t(now)}`,
    `App version: ${s.version} (${s.update.kind})`,
    `System: ${process.platform} ${release()} ${process.arch}`,
    `Network sends names (node 0.3.0 or later): ${s.core.protocol3() ? 'yes' : 'not seen yet'}`,
    `Alumni club: ${s.alumni.active() ? `active, ${s.alumni.cached()?.status.tier ?? 'unknown tier'}${s.alumni.held() ? `, not paying just now (${s.alumni.held()!.code})` : ''}` : s.alumni.key() ? 'linked, not active' : 'not linked'}`,
    `Background sync: ${settings.syncEnabled ? `every ${settings.syncMinutes} minutes` : 'off'}, ${settings.combineSyncs ? `combined${s.core.batchOff() ? ' (off for now: the network refused the route)' : ''}` : 'one call per agent'}`,
    `MessageGuard: public rooms ${settings.guardPublic ? 'on' : 'off'}, private rooms and DMs ${settings.guardPrivate ? 'on' : 'off'}`,
    `Tunnel: ${s.tunnel.status.provider}, ${s.tunnel.status.state}${s.tunnel.status.error ? ` (${clean(s.tunnel.status.error)})` : ''}`,
    `Local interfaces: ${s.server?.listening ? 'listening' : `not listening${s.serverError ? ` (${clean(s.serverError)})` : ''}`}`,
    `ChatGPT door: ${s.publicServer?.listening ? 'listening' : `not listening${s.publicError ? ` (${clean(s.publicError)})` : ''}`}`,
    '',
  ];
  const agents = s.core.agents();
  agents.forEach((a, i) => {
    const conn = s.connections.get(a.id) as { type: string } | null;
    lines.push(`Agent ${i + 1}: connection ${conn?.type ?? 'none'}, ${a.registered ? 'registered' : 'not registered'}, may do: ${s.core.may(a.id)}`);
    const check = connectionCheck(s, a.id, claude(a.id));
    if (check) {
      lines.push(`  Verdict (${check.verdict.state}): ${clean(check.verdict.text)}`);
      for (const st of check.steps) lines.push(`  [${st.state}] ${st.label}: ${clean(st.text)}${st.at ? ` ${t(st.at)}` : ''}`);
    }
    const calls = s.diagnostics.calls(a.id, { limit: 50 });
    lines.push(calls.length ? `  Last ${calls.length} calls from connections (newest first):` : '  No calls from connections yet.');
    for (const c of calls) lines.push(`    ${t(c.at)} ${c.via} ${c.name} ${c.outcome} ${c.ms} ms${c.ms > SLOW_MS ? ' SLOW' : ''}${c.error ? `: ${clean(c.error)}` : ''}`);
    lines.push('');
  });
  const byAgent = new Map(agents.map((a, i) => [a.id, `Agent ${i + 1}`]));
  const events = s.diagnostics.events({ limit: 50 });
  lines.push(`Events (newest first; sign-ins, tunnel, sync failures, the ChatGPT door's refusals, tests):`);
  for (const e of events) lines.push(`  ${t(e.lastAt)} ${e.kind} ${e.what}${eventWho(e, byAgent)}${e.count > 1 ? ` x${e.count} since ${t(e.firstAt)}` : ''}${e.detail ? `: ${clean(e.detail)}` : ''}`);
  return `${lines.join('\n')}\n`;
}

const eventWho = (e: EventRow, byAgent: Map<string, string>) => (e.agent ? ` (${byAgent.get(e.agent) ?? 'a removed agent'})` : '');
