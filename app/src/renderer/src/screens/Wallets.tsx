// Wallets (SPEC §16.9, §16.10.4): each wallet's address, balance, and daily
// budget; creating one (the recovery phrase shown once, continued only after
// the person ticks that it is saved); importing one; topping off by address
// and QR code; removing one from this app (§16.9: red, behind typing its
// name); and recent payments.
import { useEffect, useRef, useState } from 'react';
import { Dialog, meadow, time, useAction, useCopy } from '../lib.tsx';
import type { ScreenProps } from '../App.tsx';
import type { AppState, BridgePlanView, BridgeStateView, MovePlanView, MoveStateView, WalletView } from '../../../shared/api.ts';

const USD = /^\d+(\.\d{1,6})?$/;

export function Wallets({ state, refresh, balances, balancesAt, reloadBalances, intent, clearIntent }: ScreenProps) {
  const checking = useAction();
  const recheck = () => checking.run(() => reloadBalances(true));
  const copy = useCopy();
  const [dialog, setDialog] = useState<'create' | 'import' | { topOff: string } | { budget: string } | { remove: string } | { move: string } | null>(null);
  // Opening the screen looks for USDC sent on the wrong network (§16.9.2): free, at most once a minute.
  useEffect(() => {
    void meadow.checkElsewhere({}).catch(() => {});
  }, []);
  // Arriving from Troubleshoot (§16.21): open that wallet's Top off or budget.
  useEffect(() => {
    if (!intent) return;
    if (intent.wallet && intent.open === 'topOff') setDialog({ topOff: intent.wallet });
    if (intent.wallet && intent.open === 'budget') setDialog({ budget: intent.wallet });
    clearIntent?.();
  }, [intent]);
  const agentName = (id: string | null) => state.agents.find((a) => a.id === id)?.displayName ?? '—';
  const close = () => {
    setDialog(null);
    void refresh();
  };
  return (
    <div className="stack">
      <p className="lede">Wallets hold USDC, a digital dollar, on the Base network. Your agents' calls are paid from them. The app signs payments by itself, but never beyond a wallet's daily budget.</p>
      <UsdcExplainer open={state.wallets.length === 0} />
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
              <div className="row">
                <button className="secondary" onClick={() => setDialog({ move: w.id })}>Move money</button>
                <button onClick={() => setDialog({ topOff: w.id })}>Top off</button>
              </div>
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
            {w.elsewhere.length > 0 && <div style={{ marginTop: '.75rem' }}><Elsewhere items={w.elsewhere} walletId={w.id} /></div>}
            <div className="row spread" style={{ marginTop: '.75rem' }}>
              <p className="small muted" style={{ margin: 0 }}>
                Pays for: {w.agents.length ? w.agents.map((a) => agentName(a)).join(', ') : 'no agent yet'}
              </p>
              <button className="danger solid icon" onClick={() => setDialog({ remove: w.id })}>Remove from this app</button>
            </div>
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
      {dialog && typeof dialog === 'object' && 'topOff' in dialog && <TopOff walletId={dialog.topOff} balance={balances[dialog.topOff]} check={() => reloadBalances(true)} onClose={close} elsewhere={state.wallets.find((w) => w.id === dialog.topOff)?.elsewhere} />}
      {dialog && typeof dialog === 'object' && 'budget' in dialog && (
        <Budget walletId={dialog.budget} current={state.wallets.find((w) => w.id === dialog.budget)!.dailyBudgetUsd} onClose={close} />
      )}
      {dialog && typeof dialog === 'object' && 'remove' in dialog && (
        <RemoveWallet
          wallet={state.wallets.find((w) => w.id === dialog.remove)!}
          balance={balances[dialog.remove]}
          agents={state.wallets.find((w) => w.id === dialog.remove)!.agents.map(agentName)}
          onClose={close}
          onMove={() => setDialog({ move: dialog.remove })}
        />
      )}
      {dialog && typeof dialog === 'object' && 'move' in dialog && (
        <MoveMoney
          wallet={state.wallets.find((w) => w.id === dialog.move)!}
          others={state.wallets.filter((w) => w.id !== dialog.move)}
          onCreate={() => setDialog('create')}
          onDone={() => void reloadBalances(true)}
          onClose={close}
        />
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
        <div className="notice warn">
          <strong>Never take a photo or a screenshot of them, and never show them to anyone, your AI included.</strong> No one helping you ever needs them.
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

/**
 * Remove from this app (§16.9). A wallet lives on Base, not here: this only
 * erases the app's copy of its phrase. High friction on purpose: it says where
 * the money is, and Remove works only once the wallet's name is typed exactly.
 */
function RemoveWallet({ wallet, balance, agents, onClose, onMove }: { wallet: AppState['wallets'][number]; balance: string | null | undefined; agents: string[]; onClose: () => void; onMove: () => void }) {
  const [typed, setTyped] = useState('');
  const { busy, error, run } = useAction();
  const funded = balance == null || Number(balance.replace('$', '')) > 0;
  const matches = typed.trim() === wallet.name.trim();
  return (
    <Dialog title={`Remove ${wallet.name} from this app`} onClose={onClose}>
      <p>
        A wallet cannot be deleted. It lives on the Base network, not on this computer, and its address and any money in it stay there.
        This only takes it off this app: the app forgets its recovery phrase and stops paying from it.
      </p>
      <div className="notice warn">
        {balance == null
          ? <>The app could not check this wallet's balance just now. It may still hold money.</>
          : funded
            ? <>This wallet holds <strong>{balance}</strong> in USDC. After removing it, only its 12-word recovery phrase can reach that money.</>
            : <>This wallet is empty right now. Anything sent to its address later can be reached only with its recovery phrase.</>}
        {' '}If you do not have the phrase written down, keep the wallet.
      </div>
      <p>
        <strong>If someone else has seen the recovery phrase</strong> (a photo, a screenshot, or showing it to an AI), removing the wallet does not make it safe:
        {funded
          ? ' first create a new wallet here and move the money into it with Move money, then remove this one.'
          : ' remove it, create a new wallet here, and never send money to the old address.'}
      </p>
      {agents.length > 0 && <p>It pays for {agents.join(', ')}. They will have no wallet, and will not send or receive, until you choose another on the Agents screen.</p>}
      <div className="field">
        <label htmlFor="rmconfirm">Type the wallet's name, <strong>{wallet.name}</strong>, to confirm</label>
        <input id="rmconfirm" type="text" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
      </div>
      {error && <div className="notice warn">{error}</div>}
      <div className="actions">
        <button className="secondary" onClick={onClose}>Keep the wallet</button>
        {funded && <button className="secondary" onClick={onMove}>Move the money first</button>}
        <button className="danger solid" disabled={busy || !matches} onClick={() => run(async () => { await meadow.removeWallet({ walletId: wallet.id, confirm: typed }); onClose(); })}>Remove from this app</button>
      </div>
    </Dialog>
  );
}

const MOVE_WORDS: Record<MoveStateView['step'], string> = {
  checking: 'Checking the wallet…',
  swapping: 'Buying a little ETH for the network fee. This usually takes a minute or two…',
  sending: 'Sending the money…',
  done: 'Done.',
  sent: 'Sent.',
  failed: 'The move stopped.',
};

/**
 * Move money (§16.9.1): every USDC in the wallet, to another wallet here or to
 * an address. Irreversible, so: a review of what will happen, the last 4
 * characters of an outside address typed back, and a system dialog after that.
 */
function MoveMoney({ wallet, others, onCreate, onDone, onClose }: {
  wallet: AppState['wallets'][number]; others: AppState['wallets']; onCreate: () => void; onDone: () => void; onClose: () => void;
}) {
  const [kind, setKind] = useState<'wallet' | 'address'>(others.length ? 'wallet' : 'address');
  const [otherId, setOtherId] = useState(others[0]?.id ?? '');
  const [address, setAddress] = useState('');
  const [plan, setPlan] = useState<MovePlanView | null>(null);
  const [typed, setTyped] = useState('');
  const [status, setStatus] = useState<MoveStateView | null>(null);
  const checking = useAction();
  const starting = useAction();
  const to = kind === 'wallet' ? otherId : address.trim();
  const running = status && !['done', 'sent', 'failed'].includes(status.step);

  // A move already under way (the dialog was closed and opened again): follow it.
  useEffect(() => {
    meadow.moveStatus({ walletId: wallet.id }).then((s) => s && !['done', 'sent', 'failed'].includes(s.step) && setStatus(s)).catch(() => {});
  }, [wallet.id]);
  const latestDone = useRef(onDone);
  latestDone.current = onDone;
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(async () => {
      const s = await meadow.moveStatus({ walletId: wallet.id }).catch(() => null);
      if (!s) return;
      setStatus(s);
      if (s.step === 'done' || s.step === 'sent') latestDone.current();
    }, 1500);
    return () => window.clearInterval(t);
  }, [running, wallet.id]);

  if (status && (running || status.step !== 'failed' || !plan)) {
    return (
      <Dialog title={`Move money out of ${wallet.name}`} onClose={running ? undefined : onClose}>
        <p><strong>{MOVE_WORDS[status.step]}</strong></p>
        {running && <p className="muted">You can close the app's window; the move carries on while Meadow runs in the tray.</p>}
        {status.step === 'done' && <p>{status.amount} of USDC is now at <span className="mono" style={{ overflowWrap: 'anywhere' }}>{status.to}</span>.</p>}
        {status.step === 'sent' && <p>{status.amount} of USDC is on its way to <span className="mono" style={{ overflowWrap: 'anywhere' }}>{status.to}</span>. Base has not confirmed it yet; the link below shows when it does.</p>}
        {status.step === 'failed' && <div className="notice warn">{status.error}</div>}
        {status.tx && <p><button className="link" onClick={() => void meadow.openExternal({ url: `https://basescan.org/tx/${status.tx}` })}>See it on Basescan</button></p>}
        {(status.step === 'done' || status.step === 'sent') && <p className="small muted">A few cents' worth of ETH may stay in {wallet.name}, for the fee of any later move.</p>}
        <div className="actions">
          {status.step === 'failed' && <button className="secondary" onClick={() => { setStatus(null); setPlan(null); }}>Try again</button>}
          {!running && <button onClick={onClose}>Close</button>}
        </div>
      </Dialog>
    );
  }

  if (plan) {
    const outside = !plan.toWallet;
    const ok = !outside || typed.trim().toLowerCase() === plan.to.slice(-4).toLowerCase();
    return (
      <Dialog title={`Move money out of ${wallet.name}`} onClose={onClose}>
        <p>
          This moves <strong>all {plan.usdc}</strong> of USDC in {wallet.name} to {plan.toWallet ? <>your wallet <strong>{plan.toWallet}</strong>, at</> : 'the address'}
        </p>
        <p className="mono" style={{ overflowWrap: 'anywhere', fontSize: '1.05rem' }}>{plan.to}</p>
        {plan.swapUsd && (
          <div className="notice">
            Sending money on Base costs a small network fee, paid in ETH, and this wallet has none. So the app first uses <strong>{plan.swapUsd}</strong> of
            the USDC to buy a little ETH, through CoW Protocol, which pays the fee for that swap itself. About <strong>{plan.arrivesUsd}</strong> arrives.
          </div>
        )}
        {plan.contract && <p className="small">This address belongs to a smart wallet or other contract. That is fine for most smart wallets; if in doubt, ask whoever gave you the address.</p>}
        <div className="notice warn">
          <strong>This cannot be undone.</strong> {outside ? 'Money sent to a wrong address is gone. Check that the address is right, and that it is for USDC on the Base network.' : ''}
        </div>
        {outside && (
          <div className="field">
            <label htmlFor="mvconfirm">Type the last 4 characters of the address, <strong className="mono">{plan.to.slice(-4)}</strong>, to confirm</label>
            <input id="mvconfirm" type="text" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} style={{ maxWidth: '10rem' }} />
          </div>
        )}
        {starting.error && <div className="notice warn">{starting.error}</div>}
        <div className="actions">
          <button className="secondary" onClick={() => { setPlan(null); setTyped(''); }}>Back</button>
          <button className="danger solid" disabled={starting.busy || !ok} onClick={() => starting.run(async () => {
            const r = await meadow.moveStart({ walletId: wallet.id, to: plan.toWallet ? otherId : plan.to, confirm: typed });
            if (!r.ok) throw new Error(r.error);
            setStatus({ step: 'checking', to: plan.to });
          })}>Move {plan.arrivesUsd}</button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title={`Move money out of ${wallet.name}`} onClose={onClose}>
      <p>Moves all of this wallet's USDC to another wallet: one here, or any address for USDC on the Base network.</p>
      <fieldset className="field" style={{ border: 0, padding: 0 }}>
        <legend style={{ fontWeight: 600, marginBottom: '.35rem' }}>Where to</legend>
        <label className="check" style={{ fontWeight: 400 }}>
          <input type="radio" name="mvkind" checked={kind === 'wallet'} disabled={!others.length} onChange={() => setKind('wallet')} />
          <span>Another wallet in this app{!others.length && <> (there is none yet: <button className="link" onClick={onCreate}>create one</button>)</>}</span>
        </label>
        <label className="check" style={{ fontWeight: 400 }}>
          <input type="radio" name="mvkind" checked={kind === 'address'} onChange={() => setKind('address')} />
          <span>An address</span>
        </label>
      </fieldset>
      {kind === 'wallet' && others.length > 0 && (
        <div className="field">
          <label htmlFor="mvwallet">Wallet</label>
          <select id="mvwallet" value={otherId} onChange={(e) => setOtherId(e.target.value)}>
            {others.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </div>
      )}
      {kind === 'address' && (
        <div className="field">
          <label htmlFor="mvaddr">Address</label>
          <input id="mvaddr" type="text" className="mono" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="0x…" autoComplete="off" spellCheck={false} />
          <div className="hint">Paste it; don't type it. It must be for USDC on the Base network: an exchange's Base deposit address, or another wallet's.</div>
        </div>
      )}
      {checking.error && <div className="notice warn">{checking.error}</div>}
      <div className="actions">
        <button className="secondary" onClick={onClose}>Cancel</button>
        <button disabled={checking.busy || !to} onClick={() => checking.run(async () => setPlan(await meadow.movePlan({ walletId: wallet.id, to })))}>{checking.busy ? 'Checking…' : 'Next'}</button>
      </div>
    </Dialog>
  );
}

/** Where to get USDC on Base, by country (§16.9.2): a page that changes without an app release. */
export const GET_USDC_URL = 'https://meadowprotocol.com/get-usdc';

/**
 * What are USDC and Base? (§16.9.2), in plain words: a tester had never used crypto
 * and looked for a "Base network" to connect to. Folded unless `open`.
 */
export function UsdcExplainer({ open = false }: { open?: boolean }) {
  return (
    <details className="explainer" open={open}>
      <summary>What are USDC and Base?</summary>
      <ul>
        <li><strong>USDC</strong> is a digital dollar: one USDC is worth about one US dollar. Meadow's calls are paid in it.</li>
        <li><strong>Base</strong> is the network USDC travels on for Meadow, like choosing which bank a transfer goes through. The same USDC exists on other networks too, so when you send it, you must choose Base.</li>
        <li><strong>There is nothing to connect to.</strong> The app connects to Base by itself. "Base" matters only when you send money to your wallet: it is the network you pick.</li>
        <li><strong>Your wallet</strong> is an address, a long code starting with 0x. It is like an account number that only this app, and your recovery phrase, can spend from.</li>
      </ul>
    </details>
  );
}

/**
 * USDC that arrived on the wrong network (§16.9.2): safe, the person's, but not usable here.
 * Native USDC and USDbC can be moved to Base from here (§16.9.3); the rest not yet.
 */
export function Elsewhere({ items, walletId }: { items: WalletView['elsewhere'] | undefined; walletId?: string }) {
  const [moving, setMoving] = useState<WalletView['elsewhere'][number] | null>(null);
  if (!items?.length) return null;
  const stuck = items.some((f) => !f.movable);
  return (
    <div className="notice warn">
      {items.map((f, i) => (
        <div key={i} style={{ margin: i ? '.6rem 0 0' : 0 }}>
          <p style={{ margin: 0 }}>{f.text}</p>
          {f.movable && walletId && <button style={{ marginTop: '.4rem' }} onClick={() => setMoving(f)}>Move to Base</button>}
        </div>
      ))}
      {stuck && <p className="small" style={{ margin: '.5rem 0 0' }}>The app cannot move bridged USDC, or USDC on BNB Smart Chain, yet: each needs a network fee paid on its own network. It is still yours.</p>}
      {moving && walletId && <BridgeDialog walletId={walletId} item={moving} onClose={() => setMoving(null)} />}
    </div>
  );
}

const BRIDGE_WORDS: Record<BridgeStateView['step'], string> = {
  checking: 'Checking…',
  buying_gas: 'Buying a little ETH for Base\'s network fee…',
  approving: 'Approving the swap on Base…',
  signing: 'Signing…',
  moving: 'Moving it to Base…',
  done: 'Done.',
  refunded: 'Refunded.',
  failed: 'It did not move.',
  unknown: 'Not finished yet.',
};

/**
 * Move to Base (§16.9.3): the quote, checked by the core's guard, with its fee and what
 * arrives; then a system dialog; then progress. Only the core signs.
 */
function BridgeDialog({ walletId, item, onClose }: { walletId: string; item: WalletView['elsewhere'][number]; onClose: () => void }) {
  const [plan, setPlan] = useState<BridgePlanView | null>(null);
  const [state, setState] = useState<BridgeStateView | null>(null);
  const [started, setStarted] = useState(false);
  const { busy, error, run } = useAction();
  useEffect(() => {
    void run(async () => setPlan(await meadow.bridgePlan({ walletId, network: item.network, kind: item.kind })));
  }, []);
  useEffect(() => {
    if (!started) return;
    const t = window.setInterval(async () => {
      const all = await meadow.bridgeStatus({ walletId }).catch(() => []);
      const s = all.find((x) => x.network === item.network && x.kind === item.kind);
      if (s) setState(s);
    }, 2000);
    return () => window.clearInterval(t);
  }, [started]);
  const finished = state && ['done', 'refunded', 'failed', 'unknown'].includes(state.step);
  const what = item.kind === 'usdbc' ? 'USDbC' : `USDC on ${item.network}`;
  return (
    <Dialog title="Move to Base" onClose={onClose}>
      {!plan && !error && <p>Asking for a price…</p>}
      {plan && !started && (
        <>
          <p>Moves all <strong>{plan.amountUsd}</strong> of {what} to this same wallet, as USDC on Base.</p>
          <dl className="deposit">
            <dt>Fee</dt><dd>about {plan.feeUsd}</dd>
            <dt>Arrives</dt><dd>at least {plan.arrivesUsd}</dd>
          </dl>
          {plan.high && <p><strong>That is more than 5% in fees. Moving later, or with more there, costs less in proportion.</strong></p>}
          {plan.route === 'relay'
            ? <p className="small">Relay, a third-party bridge, carries it, usually in seconds. If the move fails, Relay refunds it to this wallet on {item.network}, less that network's fee. The wallet's address is sent to Relay.</p>
            : <p className="small">The app approves the swap on Base{plan.gasFromUsdc ? ', paying its network fee with a little of this wallet\'s USDC' : ''}, then CoW Protocol swaps the USDbC for USDC, usually within a minute or two.</p>}
          <p className="small muted">This is not a payment: it does not count against the daily budget.</p>
        </>
      )}
      {state && (
        <div className={`notice${state.step === 'failed' || state.step === 'unknown' ? ' warn' : ''}`}>
          <strong>{BRIDGE_WORDS[state.step]}</strong>
          {state.step === 'done' && state.arrived && <> {state.arrived} arrived as USDC on Base.</>}
          {state.error && <> {state.error}</>}
        </div>
      )}
      {error && <div className="notice warn">{error}</div>}
      <div className="actions">
        <button className="secondary" onClick={onClose}>{finished ? 'Done' : started ? 'Close (it keeps going)' : 'Cancel'}</button>
        {plan && !started && (
          <button disabled={busy} onClick={() => run(async () => {
            const r = await meadow.bridgeStart({ walletId, network: item.network, kind: item.kind });
            if (!r.ok) throw new Error(r.error);
            setStarted(true);
            setState({ step: 'checking', network: item.network, kind: item.kind });
          })}>Move</button>
        )}
      </div>
    </Dialog>
  );
}

const usd = (s: string | null | undefined) => (s ? Number(s.replace('$', '')) : null);

/**
 * Top off (§16.9, §16.9.2): exactly what to type at an exchange (asset, network, address),
 * a small test amount first, and what happens if the network is wrong. While it is open the
 * balance is read every 15 seconds and the other networks every minute, so a deposit, or one
 * on the wrong network, shows soon after it lands. No outside wallet is connected.
 */
export function TopOff({ walletId, balance, check, onClose, elsewhere }: { walletId: string; balance: string | null | undefined; check: () => Promise<void>; onClose: () => void; elsewhere?: WalletView['elsewhere'] }) {
  const copy = useCopy();
  const [qr, setQr] = useState<{ svg: string; address: string } | null>(null);
  // The balance when the dialog opened (once known), to say when the test amount arrives.
  const [start, setStart] = useState<number | null>(null);
  useEffect(() => {
    meadow.walletQr({ walletId }).then(setQr).catch(() => {});
    void meadow.checkElsewhere({ walletId }).catch(() => {});
  }, [walletId]);
  useEffect(() => {
    if (start === null && usd(balance) !== null) setStart(usd(balance));
  }, [balance, start]);
  const latest = useRef(check);
  latest.current = check;
  useEffect(() => {
    const t = window.setInterval(() => void latest.current().catch(() => {}), 15_000);
    const e = window.setInterval(() => void meadow.checkElsewhere({ walletId }).catch(() => {}), 60_000);
    return () => {
      window.clearInterval(t);
      window.clearInterval(e);
    };
  }, [walletId]);
  const now = usd(balance);
  const arrived = start !== null && now !== null && now > start ? now - start : null;
  return (
    <Dialog title="Top off" onClose={onClose}>
      <p>Send USDC to this wallet from an exchange or another wallet. Where it asks, choose exactly this:</p>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <dl className="deposit">
          <dt>Asset</dt><dd><strong>USDC</strong></dd>
          <dt>Network</dt><dd><strong>Base</strong></dd>
          <dt>Address</dt>
          <dd>
            <span className="mono" style={{ overflowWrap: 'anywhere' }}>{qr?.address ?? '…'}</span>
            {qr && <div><button onClick={() => copy(qr.address, 'Address copied')}>Copy address</button></div>}
          </dd>
        </dl>
        {qr && <div className="qr" aria-label="QR code of the address" dangerouslySetInnerHTML={{ __html: qr.svg }} />}
      </div>
      {arrived !== null ? (
        <div className="notice"><strong>Your ${arrived.toFixed(2)} arrived.</strong> Everything is set up correctly: you can send the rest now.</div>
      ) : (
        <div className="notice"><strong>Send a small amount first,</strong> about $1. When it arrives here, send the rest. Balance now: <strong>{balance ?? '…'}</strong></div>
      )}
      <Elsewhere items={elsewhere} walletId={walletId} />
      <details className="explainer">
        <summary>What to pick at the exchange</summary>
        <ul>
          <li>Choose <strong>USDC</strong>, then <strong>Base</strong> as the network. Some exchanges call it "Base Mainnet" or show the Base logo.</li>
          <li>Do not pick <strong>USDbC</strong>: it is an older copy of USDC on Base, and the app does not use it.</li>
          <li>No memo or tag is needed.</li>
          <li>If you pick another network by mistake, the money is not lost, but the app cannot use it there. The app will tell you if it finds it. Networks with a different kind of address, such as Solana or Tron, will not accept this address.</li>
        </ul>
      </details>
      <UsdcExplainer />
      <p>
        <button className="link" onClick={() => void meadow.openExternal({ url: GET_USDC_URL })}>Where to get USDC on Base</button>, by country. Or ask someone who already has USDC on Base to send it to this address: they can scan the QR code.
      </p>
      <p className="small muted">No ETH is needed: payments are signed here and settled by the portal. While this window is open, the balance is checked every 15 seconds.</p>
      <div className="actions"><button className="secondary" onClick={onClose}>Done</button></div>
    </Dialog>
  );
}
