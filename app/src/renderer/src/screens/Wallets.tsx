// Wallets (SPEC §16.9, §16.10.4): each wallet's address, balance, and daily
// budget; creating one (the recovery phrase shown once, continued only after
// the person ticks that it is saved); importing one; topping off by address
// and QR code; and recent payments.
import { useEffect, useRef, useState } from 'react';
import { Dialog, meadow, time, useAction, useCopy } from '../lib.tsx';
import type { ScreenProps } from '../App.tsx';

const USD = /^\d+(\.\d{1,6})?$/;

export function Wallets({ state, refresh, balances, balancesAt, reloadBalances }: ScreenProps) {
  const checking = useAction();
  const recheck = () => checking.run(() => reloadBalances(true));
  const copy = useCopy();
  const [dialog, setDialog] = useState<'create' | 'import' | { topOff: string } | { budget: string } | null>(null);
  const agentName = (id: string | null) => state.agents.find((a) => a.id === id)?.displayName ?? '—';
  const close = () => {
    setDialog(null);
    void refresh();
  };
  return (
    <div className="stack">
      <p className="lede">Wallets hold USDC on the Base network, which pays for your agents' calls. The app signs payments by itself, but never beyond a wallet's daily budget.</p>
      <div className="row">
        <button onClick={() => setDialog('create')}>Create wallet</button>
        <button className="secondary" onClick={() => setDialog('import')}>Import wallet</button>
        {state.wallets.length > 0 && (
          <>
            <button className="secondary" disabled={checking.busy} onClick={recheck}>{checking.busy ? 'Checking…' : 'Refresh balances'}</button>
            <span className="small muted">{balancesAt ? `Checked at ${time(balancesAt)}` : 'Not checked yet'}</span>
          </>
        )}
      </div>
      {state.wallets.map((w) => {
        const spent = Number(w.spent24hUsd.replace('$', ''));
        const budget = Number(w.dailyBudgetUsd);
        return (
          <div key={w.id} className="card">
            <div className="row spread">
              <h2 style={{ margin: 0 }}>{w.name}</h2>
              <button onClick={() => setDialog({ topOff: w.id })}>Top off</button>
            </div>
            <div className="grid three" style={{ marginTop: '1rem' }}>
              <div className="stat"><div className="label">Balance</div><div className="big">{balances[w.id] ?? '…'}</div><div className="small muted">USDC on Base</div></div>
              <div className="stat">
                <div className="label">Spent in the last 24 hours</div>
                <div className="big">{w.spent24hUsd}</div>
                <progress value={Math.min(spent, budget)} max={budget || 1} style={{ width: '100%' }} aria-label="Spent against the daily budget" />
                <div className="small muted">of a daily budget of ${w.dailyBudgetUsd} <button className="link" onClick={() => setDialog({ budget: w.id })}>Change</button></div>
              </div>
              <div className="stat">
                <div className="label">Address</div>
                <div className="mono small" style={{ overflowWrap: 'anywhere' }}>{w.address}</div>
                <button className="secondary icon" onClick={() => copy(w.address, 'Address copied')}>Copy address</button>
              </div>
            </div>
            <p className="small muted" style={{ marginTop: '.75rem', marginBottom: 0 }}>
              Pays for: {w.agents.length ? w.agents.map((a) => agentName(a)).join(', ') : 'no agent yet'}
            </p>
          </div>
        );
      })}

      <div className="card">
        <h2>Recent payments</h2>
        {state.payments.length === 0 ? <p className="muted">None yet.</p> : (
          <table>
            <thead><tr><th>Time</th><th>Service</th><th>Amount</th><th>Agent</th><th>Result</th></tr></thead>
            <tbody>
              {state.payments.map((p, i) => (
                <tr key={i}>
                  <td className="small">{time(p.at)}</td>
                  <td>{p.service === 'meadow' ? `Meadow ${p.path}` : p.service}</td>
                  <td>{p.usd}</td>
                  <td>{agentName(p.agent)}</td>
                  <td>{p.status === 'settled' ? <span className="pill ok">Paid</span> : p.status === 'failed' ? <span className="pill warn">Not accepted</span> : <span className="pill todo">Signed</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {dialog === 'create' && <CreateWallet onClose={close} />}
      {dialog === 'import' && <ImportWallet onClose={close} />}
      {dialog && typeof dialog === 'object' && 'topOff' in dialog && <TopOff walletId={dialog.topOff} balance={balances[dialog.topOff]} check={() => reloadBalances(true)} onClose={close} />}
      {dialog && typeof dialog === 'object' && 'budget' in dialog && (
        <Budget walletId={dialog.budget} current={state.wallets.find((w) => w.id === dialog.budget)!.dailyBudgetUsd} onClose={close} />
      )}
    </div>
  );
}

function BudgetField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="field">
      <label htmlFor="budget">Daily budget, in US dollars</label>
      <input id="budget" type="text" inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value.trim())} style={{ maxWidth: '10rem' }} />
      <div className="hint">The most this wallet can spend in any 24 hours. You can change it at any time.</div>
    </div>
  );
}

function CreateWallet({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('Everyday');
  const [budget, setBudget] = useState('1.00');
  const [created, setCreated] = useState<{ address: string; mnemonic: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();
  if (created) {
    return (
      <Dialog title="Write down your recovery phrase">
        <div className="notice warn">
          <strong>These 12 words are the only way to get this wallet's money back</strong> if this computer is lost or the app is removed.
          Write them down, in order, on paper, and keep them somewhere safe. Anyone who has them can take the money. The app will not show them again.
        </div>
        <div className="phrase">{created.mnemonic.split(' ').map((w, i) => <span key={i}>{w}</span>)}</div>
        <label className="check"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I have written these words down and put them somewhere safe.</label>
        <div className="actions">
          <button disabled={!saved} onClick={() => { setCreated(null); onClose(); }}>Continue</button>
        </div>
      </Dialog>
    );
  }
  return (
    <Dialog title="Create a wallet" onClose={onClose}>
      <div className="field"><label htmlFor="wname">Name</label><input id="wname" type="text" value={name} onChange={(e) => setName(e.target.value)} /></div>
      <BudgetField value={budget} onChange={setBudget} />
      {error && <div className="notice warn">{error}</div>}
      <div className="actions">
        <button className="secondary" onClick={onClose}>Cancel</button>
        <button disabled={busy || !name.trim() || !USD.test(budget)} onClick={() => run(async () => setCreated(await meadow.createWallet({ name: name.trim(), dailyBudgetUsd: budget })))}>Create</button>
      </div>
    </Dialog>
  );
}

function ImportWallet({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('Imported');
  const [phrase, setPhrase] = useState('');
  const [budget, setBudget] = useState('1.00');
  const { busy, error, run } = useAction();
  return (
    <Dialog title="Import a wallet" onClose={onClose}>
      <div className="field"><label htmlFor="iname">Name</label><input id="iname" type="text" value={name} onChange={(e) => setName(e.target.value)} /></div>
      <div className="field">
        <label htmlFor="phrase">Recovery phrase</label>
        <textarea id="phrase" value={phrase} onChange={(e) => setPhrase(e.target.value)} autoComplete="off" spellCheck={false} />
        <div className="hint">The 12 or 24 words, in order, separated by spaces. They stay on this computer.</div>
      </div>
      <BudgetField value={budget} onChange={setBudget} />
      {error && <div className="notice warn">{error}</div>}
      <div className="actions">
        <button className="secondary" onClick={onClose}>Cancel</button>
        <button disabled={busy || !phrase.trim() || !USD.test(budget)} onClick={() => run(async () => {
          await meadow.importWallet({ name: name.trim(), phrase, dailyBudgetUsd: budget });
          setPhrase('');
          onClose();
        })}>Import</button>
      </div>
    </Dialog>
  );
}

function Budget({ walletId, current, onClose }: { walletId: string; current: string; onClose: () => void }) {
  const [budget, setBudget] = useState(current);
  const { busy, error, run } = useAction();
  return (
    <Dialog title="Daily budget" onClose={onClose}>
      <BudgetField value={budget} onChange={setBudget} />
      {error && <div className="notice warn">{error}</div>}
      <div className="actions">
        <button className="secondary" onClick={onClose}>Cancel</button>
        <button disabled={busy || !USD.test(budget)} onClick={() => run(async () => { await meadow.setBudget({ walletId, dailyBudgetUsd: budget }); onClose(); })}>Save</button>
      </div>
    </Dialog>
  );
}

/** Top off (§16.9): the address as text with a copy button, and as a QR code. No outside wallet is connected. */
/** The deposit address; while it is open, the balance is read every 15 seconds, so a deposit shows soon after it lands. */
export function TopOff({ walletId, balance, check, onClose }: { walletId: string; balance: string | null | undefined; check: () => Promise<void>; onClose: () => void }) {
  const copy = useCopy();
  const [qr, setQr] = useState<{ svg: string; address: string } | null>(null);
  useEffect(() => {
    meadow.walletQr({ walletId }).then(setQr).catch(() => {});
  }, [walletId]);
  const latest = useRef(check);
  latest.current = check;
  useEffect(() => {
    const t = window.setInterval(() => void latest.current().catch(() => {}), 15_000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <Dialog title="Top off" onClose={onClose}>
      <p>Send <strong>USDC on the Base network</strong> to this address, from an exchange or another wallet. Nothing else: other coins, or USDC on another network, would be lost.</p>
      {qr && (
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <div className="qr" aria-label="QR code of the address" dangerouslySetInnerHTML={{ __html: qr.svg }} />
          <div className="stack" style={{ flex: 1, minWidth: '14rem' }}>
            <div className="mono" style={{ overflowWrap: 'anywhere', fontSize: '1.05rem' }}>{qr.address}</div>
            <div><button onClick={() => copy(qr.address, 'Address copied')}>Copy address</button></div>
            <p>Balance now: <strong>{balance ?? '…'}</strong> USDC</p>
            <p className="small muted">No ETH is needed: payments are signed here and settled by the portal. While this window is open, the balance is checked every 15 seconds.</p>
          </div>
        </div>
      )}
      <div className="actions"><button className="secondary" onClick={onClose}>Done</button></div>
    </Dialog>
  );
}
