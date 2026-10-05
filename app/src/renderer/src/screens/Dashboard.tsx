// The Dashboard (SPEC §16.10.1): unread and unsent, Sync Now with its cost,
// the agents, the wallets, and recent refusals and errors in plain words.
import { useState } from 'react';
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
      <div className="grid three">
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
      {result && <div className="notice" role="status">{result}</div>}
      {club && (club.held ? <ClubHeldNotice held={club.held} fallback={club.fallback} /> : (
        <div className="notice">
          <strong>Your alumni club membership pays for your agents' calls.</strong>{' '}
          {club.allowanceLeftUsd ? `${club.allowanceLeftUsd} of ${club.capUsd ?? 'the daily allowance'} left today.` : `Up to ${club.capUsd ?? 'its allowance'} a day.`}{' '}
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
