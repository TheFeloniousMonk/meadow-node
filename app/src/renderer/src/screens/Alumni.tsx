// The Meadow v1 alumni club in Settings (SPEC §18.8): join, validate a key,
// the membership's status and history, cancel, a new key, and the fallback to
// the agents' own wallets. The window never sees the key, only what the club
// said about it.
import { useState } from 'react';
import type { AppState } from '../../../shared/api.ts';
import { Dialog, meadow, time, useAction, useToast, when } from '../lib.tsx';

export function AlumniSection({ state, refresh }: { state: AppState; refresh: () => Promise<void> }) {
  const a = state.alumni;
  const toast = useToast();
  const { busy, error, run } = useAction();
  const [key, setKey] = useState('');
  const [keyError, setKeyError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const link = (rotate: boolean) => run(async () => { await meadow.alumniLink({ rotate }); await refresh(); });
  const validate = () => run(async () => {
    setKeyError(null);
    const r = await meadow.alumniValidate({ key });
    if (r.ok) {
      setKey('');
      toast('Alumni membership validated');
      await refresh();
    } else setKeyError(r.error);
  });

  return (
    <section className="card" id="alumni" style={{ scrollMarginTop: '1rem' }}>
      <h2>Meadow v1 alumni</h2>
      {error && <div className="notice warn">{error}</div>}
      {a.linkError && <div className="notice warn">{a.linkError}</div>}
      {a.linking && (
        <div className="notice">
          The club's site is open in your browser. Finish there: this page updates by itself when your membership is connected.{' '}
          <span className="small">Closed the page, or nothing happened? <button className="link" disabled={busy} onClick={() => run(async () => { await meadow.alumniLink({ rotate: false, again: true }); await refresh(); })}>Start again</button></span>
        </div>
      )}

      {a.active ? (
        <>
          {/* The tier's allowance first, in calls, and how much of it is used (the owner, 2026-10-07). */}
          <div className="stat">
            <div className="label">Your {a.tierName} allowance</div>
            <div className="big">{a.capCalls !== null ? `${a.capCalls.toLocaleString('en-US')} calls a day` : 'Its daily allowance'}</div>
            {a.capCalls !== null && a.callsLeft !== null && (
              <>
                <progress value={Math.max(0, a.capCalls - a.callsLeft)} max={a.capCalls} style={{ width: '100%' }} aria-label={`Calls used of your ${a.tierName} allowance`} />
                <div><strong>{Math.max(0, a.capCalls - a.callsLeft).toLocaleString('en-US')} used</strong>, {a.callsLeft.toLocaleString('en-US')} left</div>
              </>
            )}
            <div className="small muted">Shared by all your agents, over the last 24 hours. Every call counts, background receiving{a.messageguard ? ' and MessageGuard' : ''} included.</div>
          </div>
          {a.held && <ClubHeldNotice held={a.held} fallback={a.fallback} />}
          <label className="check" style={{ marginTop: '1rem' }}>
            <input type="checkbox" checked={a.fallback} disabled={busy}
              onChange={(e) => run(async () => { await meadow.alumniSetFallback({ on: e.target.checked }); await refresh(); })} />
            Use my own wallet when the club allowance is used up
          </label>
          <p className="small muted" style={{ marginTop: '.25rem' }}>
            Off: once the day's allowance is used, paid calls wait until it frees up. On: each agent's own wallet pays past it, within that wallet's own budget. The same applies if the club cannot be reached.
          </p>
          <h3>Membership</h3>
          <p>
            <strong>{a.tierName}</strong>, paid through {a.paidThrough}
            {a.cancelled ? '. Cancelled: it ends then' : ''}.
            {a.changesTo && <> It changes to {a.changesTo} on {a.changesOn}.</>}
          </p>
          {a.options.length > 0 && (
            <>
              <ul style={{ listStyle: 'none', padding: 0, margin: '.25rem 0 .5rem' }}>
                {a.options.map((o) => (
                  <li key={o.tier} className="row" style={{ gap: '.75rem', alignItems: 'center', marginBottom: '.4rem' }}>
                    <button className={o.higher ? '' : 'secondary'} disabled={busy} onClick={() => run(async () => { await meadow.alumniOpenAccount(); })}>
                      {o.higher ? 'Upgrade' : 'Change'} to {o.name}
                    </button>
                    <span>{o.calls !== null ? `${o.calls.toLocaleString('en-US')} calls a day` : 'its allowance'}, {o.priceMonthUsd} a month{o.messageguard && !a.messageguard ? ', MessageGuard included' : ''}</span>
                  </li>
                ))}
              </ul>
              <p className="small muted">
                These open the club's site, where you approve the change with PayPal. An upgrade starts at once, and PayPal charges the new price from your next payment. A lower tier starts with your next payment.
              </p>
            </>
          )}
          {a.cancelled && <p className="small muted">A cancelled membership can't change tier. When it ends, you can join again at any tier.</p>}
          <div className="actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
            {!a.cancelled && <button className="secondary" disabled={busy} onClick={() => setCancelling(true)}>Cancel membership</button>}
            <button className="secondary" disabled={busy || a.linking} onClick={() => link(true)}>Get a new key</button>
            <button className="link small" disabled={busy} onClick={() => run(async () => { await meadow.alumniRefresh(); await refresh(); })}>Check now</button>
          </div>
          <p className="small muted">Get a new key stops the old one everywhere at once. Checked {a.checkedAt ? when(a.checkedAt) : 'not yet'}.</p>
          <p className="small muted">
            While the membership lasts it also sets, for every agent: background receiving every {a.receiveMinutes ?? 15} minutes, the most one call may cost (the portal's price),
            and {a.messageguard ? 'MessageGuard for public rooms, on' : 'MessageGuard, off (included in Premium)'}. Those settings show "Set by Alumni status", and go back to yours when it ends.
          </p>
        </>
      ) : (
        <>
          {a.linked && a.ended && <div className="notice">Your alumni membership is not active: {a.ended}</div>}
          <p>For Meadow v1 alumni: the club pays for your agents' calls each day, up to your tier's allowance.</p>
          <div className="actions" style={{ justifyContent: 'flex-start' }}>
            <button disabled={busy || a.linking} onClick={() => link(false)}>Join alumni club</button>
          </div>
          <div className="field" style={{ marginTop: '1rem' }}>
            <label htmlFor="alumni-key">Validate alumni membership</label>
            <div className="row" style={{ gap: '.5rem' }}>
              <input id="alumni-key" value={key} onChange={(e) => { setKey(e.target.value); setKeyError(null); }} placeholder="mclub1.…" autoComplete="off" spellCheck={false} />
              <button className="secondary" disabled={busy || !key.trim()} onClick={validate}>Validate</button>
            </div>
            {keyError && <p className="small" style={{ margin: '.35rem 0 0', color: 'var(--warn-text)' }}>{keyError}</p>}
            <p className="small muted" style={{ marginTop: '.35rem' }}>If you joined on another computer, sign in at the club's site, choose Show my key, and paste it here.</p>
          </div>
        </>
      )}

      {a.history.length > 0 && (
        <>
          <h3>Payment history</h3>
          <table>
            <thead><tr><th>Date</th><th>Amount</th><th>Tier</th></tr></thead>
            <tbody>
              {a.history.map((p, i) => (
                <tr key={`${p.date}-${i}`}><td>{p.date}</td><td>{p.amount} {p.currency}{p.status !== 'completed' ? ` (${p.status})` : ''}</td><td>{p.tier ?? ''}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {cancelling && (
        <Dialog title="Cancel your alumni membership?" onClose={() => setCancelling(false)}>
          <p>Your membership runs to the end of the month you paid for ({a.paidThrough}). There are no refunds.</p>
          <p>After that, your agents' own wallets pay for their calls again.</p>
          <div className="actions">
            <button className="secondary" onClick={() => setCancelling(false)}>Keep it</button>
            <button disabled={busy} onClick={() => run(async () => {
              const r = await meadow.alumniCancel();
              setCancelling(false);
              if (!r.ok) throw new Error(r.error);
              toast(`Cancelled. It runs to ${r.runsUntil ?? 'the end of the paid month'}.`);
              await refresh();
            })}>Cancel membership</button>
          </div>
        </Dialog>
      )}
    </section>
  );
}

/** Why the club is not paying just now (§18.8), in the person's words: used up until a time, or unreachable. */
export function ClubHeldNotice({ held, fallback }: { held: NonNullable<AppState['alumni']['held']>; fallback: boolean }) {
  const at = held.until ? time(held.until) : null;
  if (held.code === 'cap') {
    return (
      <div className="notice warn">
        <strong>The alumni club's allowance for today is used up{at ? `; it frees up at ${at}` : ''}.</strong>{' '}
        {fallback ? "Until then each agent's own wallet pays, within its own budget." : 'Until then paid calls are refused and background receiving waits.'}
      </div>
    );
  }
  return (
    <div className="notice warn">
      <strong>The alumni club could not pay just now.</strong> {held.text}{' '}
      {fallback ? "Meanwhile each agent's own wallet pays, within its own budget." : 'Paid calls are refused until it answers again; the app tries with each call.'}
    </div>
  );
}
