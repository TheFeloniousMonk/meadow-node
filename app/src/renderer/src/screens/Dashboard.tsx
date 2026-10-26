// The Dashboard (SPEC §16.10.1): unread and unsent, Sync Now with its cost,
// the agents, the wallets, and recent refusals and errors in plain words.
import { useEffect, useState } from 'react';
import { agentsSharePayer, meadow, shortAddress, time, useAction, useCopy, when } from '../lib.tsx';
import type { ScreenProps } from '../App.tsx';
import { TopOff } from './Wallets.tsx';
import { ClubHeldNotice } from './Alumni.tsx';

export function Dashboard({ state, go, balances, reloadBalances }: ScreenProps) {
  const copy = useCopy();
  const { busy, run } = useAction();
  const [result, setResult] = useState<string | null>(null);
  const [topOff, setTopOff] = useState<string | null>(null);
  const unread = state.agents.reduce((n, a) => n + a.unread, 0);
  const queued = state.agents.reduce((n, a) => n + a.queued, 0);
  // While an alumni membership is active the club pays for every agent (§18.8).
  const club = state.alumni.active ? state.alumni : null;
  const syncable = state.agents.filter((a) => a.registered && (club || a.walletId));

  // Every agent at once; agents one payer pays for go together, up to 8 a call (§16.8).
  const combined = agentsSharePayer(state);
  const syncNow = () => run(async () => {
    const results = await meadow.syncAllNow();
    const name = (id: string) => state.agents.find((a) => a.id === id)?.displayName ?? 'An agent';
    setResult(results.map((r) => `${name(r.agent)}: ${r.message}`).join(' ') || 'No registered agent to sync.');
  });

  return (
    <div className="stack">
      {/* Two columns (§16.25.3): the three cards stacked on the left, Event Mode on the right. */}
      <div className="grid two" style={{ alignItems: 'start' }}>
      <div className="stack">
        <button className="card stat" style={{ textAlign: 'left', color: 'inherit', fontWeight: 400 }} onClick={() => go('inbox')}>
          <div className="label">Unread by your agents</div>
          <div className="big">{unread}</div>
        </button>
        <button className="card stat" style={{ textAlign: 'left', color: 'inherit', fontWeight: 400 }} onClick={() => go('inbox')}>
          <div className="label">Waiting to be sent</div>
          <div className="big">{queued}</div>
        </button>
        <div className="card stat">
          <div className="label">Check the network now</div>
          <p className="small muted" style={{ margin: '.25rem 0 .6rem' }}>
            About {state.pricePerCallUsd ?? 'the portal\'s price'} {combined ? 'for up to 8 agents together' : 'per agent'}, {club ? 'paid by the alumni club' : combined ? 'paid from their wallet' : 'paid from its wallet'}.
          </p>
          <button onClick={syncNow} disabled={busy || !syncable.length}>{busy ? 'Syncing…' : 'Sync Now'}</button>
        </div>
      </div>
      <EventModeCard state={state} />
      </div>
      {result && <div className="notice" role="status">{result}</div>}
      {club && (club.held ? <ClubHeldNotice held={club.held} fallback={club.fallback} /> : (
        <div className="notice">
          <strong>Your alumni club membership pays for your agents' calls.</strong>{' '}
          {club.callsLeft !== null && club.capCalls !== null ? `${club.callsLeft.toLocaleString('en-US')} of ${club.capCalls.toLocaleString('en-US')} calls left today.`
            : club.capCalls !== null ? `Up to ${club.capCalls.toLocaleString('en-US')} calls a day.` : 'Up to its daily allowance.'}{' '}
          <button className="link" onClick={() => go('settings', { open: 'alumni' })}>Membership</button>
        </div>
      ))}
      {state.agents.filter((a) => a.held > 0).map((a) => (
        <div key={`held-${a.id}`} className="notice warn">
          <strong>MessageGuard kept {a.held} message{a.held === 1 ? '' : 's'} aside for {a.displayName}.</strong> {a.displayName} has not seen {a.held === 1 ? 'it' : 'them'}. <button className="link" onClick={() => go('inbox')}>Look in the Inbox</button>
        </div>
      ))}
      {state.agents.filter((a) => a.backupDue).map((a) => (
        <div key={`backup-${a.id}`} className="notice warn">
          <strong>Time for a fresh backup of {a.displayName}.</strong> {a.backupDue} <button className="link" onClick={() => go('agents')}>Go to Agents</button>
        </div>
      ))}

      <div className="card">
        <h2>Agents</h2>
        {state.agents.length === 0 ? (
          <p className="muted">No agents yet. <button className="link" onClick={() => go('agents')}>Add one</button></p>
        ) : (
          <table>
            <thead><tr><th>Agent</th><th>Connection</th><th>Status</th><th>Last sync</th></tr></thead>
            <tbody>
              {state.agents.map((a) => (
                <tr key={a.id}>
                  <td><strong>{a.displayName}</strong><div className="small muted mono">{a.handle}</div></td>
                  <td>{a.connection ? a.connection.type === 'claude' ? (a.claude?.installed ? 'Claude, connected' : 'Claude, not connected') : a.connection.type === 'chatgpt' ? 'ChatGPT' : 'Other' : 'None'}</td>
                  <td>{a.registered ? <span className="pill ok">Registered</span> : <span className="pill todo">Not registered</span>}</td>
                  <td className="small">{when(a.lastSync)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Wallets</h2>
        {state.wallets.length === 0 ? (
          <p className="muted">No wallets yet. <button className="link" onClick={() => go('wallets')}>Create one</button></p>
        ) : (
          <table>
            <thead><tr><th>Wallet</th><th>Address</th><th>Balance</th><th>Spent today</th><th></th></tr></thead>
            <tbody>
              {state.wallets.map((w) => (
                <tr key={w.id}>
                  <td><strong>{w.name}</strong></td>
                  <td>
                    <span className="mono">{shortAddress(w.address)}</span>{' '}
                    <button className="secondary icon" onClick={() => copy(w.address, 'Address copied')} aria-label={`Copy the address of ${w.name}`}>Copy</button>
                  </td>
                  <td>{balances[w.id] ?? '…'} <span className="small muted">USDC</span></td>
                  <td>{w.spent24hUsd} of {'$' + w.dailyBudgetUsd}</td>
                  <td><button className="secondary" onClick={() => setTopOff(w.id)}>Top off</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Recent problems</h2>
        {state.problems.length === 0 ? <p className="muted">None.</p> : (
          <table>
            <tbody>
              {state.problems.slice(0, 8).map((p, i) => (
                <tr key={i}><td className="small muted" style={{ whiteSpace: 'nowrap' }}>{time(p.at)}</td><td>{p.text}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {topOff && <TopOff walletId={topOff} balance={balances[topOff]} check={() => reloadBalances(true)} onClose={() => setTopOff(null)} elsewhere={state.wallets.find((w) => w.id === topOff)?.elsewhere} />}
    </div>
  );
}

/** "1 hour", "1 hour 15 minutes", "8 hours". */
const hoursText = (min: number) => {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h} hour${h === 1 ? '' : 's'}${m ? ` ${m} minutes` : ''}`;
};
const everyText = (n: number) => (n === 1 ? 'every minute' : `every ${n} minutes`);
/** The countdown as h:mm:ss. */
const clock = (ms: number) => {
  const t = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

/**
 * Event Mode (§16.25): for a live event, the app checks for new messages more often for a set
 * time, then goes back to its normal schedule. Off by default; the cost shows before it starts.
 */
function EventModeCard({ state }: { state: ScreenProps['state'] }) {
  const em = state.eventMode;
  const { busy, error, run } = useAction();
  const act = (a: Parameters<typeof meadow.setEventMode>[0]) => run(() => meadow.setEventMode(a));
  // The countdown moves every second; the core ends the event itself when its time is up.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!em.on || em.paused) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [em.on, em.paused]);

  const leftMs = !em.on ? em.duration * 60_000 : em.paused ? em.remainingMs ?? 0 : Math.max(0, (em.endsAt ?? now) - now);
  // Calls over the time left (the whole duration before it starts): one per payer's group each round.
  const rounds = Math.ceil(leftMs / 60_000 / em.frequency);
  const price = state.pricePerCallUsd ? Number(state.pricePerCallUsd.replace('$', '')) : null;
  const guardOn = state.settings.guardPublic || state.settings.guardPrivate;
  const normal = em.normal.enabled ? `checking ${everyText(em.normal.minutes)}` : 'no automatic checks (they are off in Settings)';

  return (
    <section className="card">
      <h2 style={{ marginTop: 0 }}>Event Mode</h2>
      <p className="small muted">For a live event in a busy room: the app checks for new messages more often for a set time, for all your agents, then goes back to {normal}.</p>

      <div className="group">
        <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 14rem)', gap: '.5rem .75rem', alignItems: 'center' }}>
          <label htmlFor="em-frequency">Check</label>
          <select id="em-frequency" value={em.frequency} disabled={busy} onChange={(e) => act({ action: 'choose', frequency: Number(e.target.value) })} style={{ width: '100%' }}>
            {em.frequencies.map((f) => <option key={f} value={f}>{everyText(f)}</option>)}
          </select>
          <label htmlFor="em-duration">For</label>
          <select id="em-duration" value={em.duration} disabled={busy} onChange={(e) => act({ action: 'choose', duration: Number(e.target.value) })} style={{ width: '100%' }}>
            {em.durations.map((d) => <option key={d} value={d}>{hoursText(d)}</option>)}
          </select>
        </div>
        {em.on && <p className="small muted">A new frequency applies at once. A new duration starts the countdown again at that length.</p>}
        <label className="check" style={{ marginTop: '.6rem' }}>
          <input type="checkbox" checked={em.on} disabled={busy || (!em.on && !em.payers.length)} onChange={(e) => act({ action: e.target.checked ? 'start' : 'stop' })} />
          {em.on ? 'Event Mode is on' : 'Turn on Event Mode'}
        </label>
        {!em.payers.length && <p className="small muted">No registered agent has a wallet to pay for checks yet.</p>}
      </div>

      {em.on && (
        <div className="group">
          <div className="big" aria-live="polite">{clock(leftMs)}</div>
          <p className="small muted" style={{ margin: '.25rem 0 .6rem' }}>
            {em.paused ? 'Paused: the normal schedule applies until you resume.' : `Checking ${everyText(em.frequency)}, until ${new Date(em.endsAt ?? now).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.`}
          </p>
          <div className="row">
            {em.paused
              ? <button disabled={busy} onClick={() => act({ action: 'resume' })}>Resume</button>
              : <button disabled={busy} onClick={() => act({ action: 'pause' })}>Pause</button>}
            <button className="secondary" disabled={busy} onClick={() => act({ action: 'reset' })}>Reset to {hoursText(em.duration)}</button>
          </div>
        </div>
      )}

      <div className="group">
        {em.payers.map((p) => {
          const calls = rounds * p.callsPerRound;
          const short = p.callsLeft !== null && calls > p.callsLeft;
          return (
            <div key={p.name}>
              <p className="small" style={{ margin: 0 }}>
                {em.on ? 'The rest of this event' : 'This event'}: about {calls.toLocaleString('en-US')} call{calls === 1 ? '' : 's'}
                {price !== null && !p.club ? ` at ${state.pricePerCallUsd} each, about $${(calls * price).toFixed(2)},` : ','} {p.club ? 'from your alumni club allowance' : `from ${p.name}`}.
              </p>
              {short && (
                <div className="notice warn" style={{ marginTop: '.4rem' }}>
                  {p.club ? 'Your alumni club allowance' : `${p.name}'s daily budget`} has about {p.callsLeft!.toLocaleString('en-US')} call{p.callsLeft === 1 ? '' : 's'} left today, fewer than this event needs. Checks past that are refused{p.club ? '' : ': raise the budget on the Wallets screen'}.
                </div>
              )}
            </div>
          );
        })}
        {guardOn && <p className="small muted" style={{ margin: '.4rem 0 0' }}>MessageGuard adds a check{state.guardPriceUsd ? ` (${state.guardPriceUsd})` : ''} whenever a check brings new messages.</p>}
      </div>
      {error && <div className="notice warn">{error}</div>}
    </section>
  );
}
