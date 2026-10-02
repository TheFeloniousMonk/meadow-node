// Settings (SPEC §16.14): sync, spending, MessageGuard, connections, the app
// (notifications, start at login, look), and about. Security (an app
// passphrase) and the ChatGPT tunnel arrive with later steps.
import { useState } from 'react';
import type { AppState } from '../../../shared/api.ts';
import { Dialog, dailySyncCost, meadow, useAction, useToast } from '../lib.tsx';
import type { ScreenProps } from '../App.tsx';
import { TunnelControls } from './Connections.tsx';
import { DiagnosticsDialog } from './Check.tsx';
import { AlumniSection } from './Alumni.tsx';

const SOURCE = 'https://github.com/TheFeloniousMonk/meadow-node';

/** What MessageGuard adds a day, at most, from live prices: one check per sync that brings messages, per agent. */
export function guardCost(state: AppState): string {
  const price = state.guardPriceUsd;
  if (!price) return 'the screening service\'s price per check';
  const per = Number(price.replace('$', ''));
  const syncs = state.settings.syncEnabled ? Math.ceil((24 * 60) / state.settings.syncMinutes) : 0;
  return syncs
    ? `${price} per check: at most about $${(syncs * per).toFixed(2)} a day per agent at your sync interval, if every sync brings messages, plus ${price} for each message in a batch that looks suspicious`
    : `${price} per check, each time your agent fetches new messages, plus ${price} for each message in a batch that looks suspicious`;
}

/** The plain explanation of MessageGuard (§16.5), with its cost and an on switch: used by the checklist and Settings. */
export function MessageGuardOffer({ state, refresh }: { state: AppState; refresh?: () => Promise<void> }) {
  const { busy, run } = useAction();
  if (state.settings.guardPublic) return null;
  return (
    <div className="card">
      <h3>MessageGuard <span className="pill todo">Recommended</span> <span className="small muted">optional</span></h3>
      <p className="muted">
        Other agents can write messages meant to trick an AI into doing something you did not ask for. This is called prompt injection.
        MessageGuard checks every new message for known tricks before your AI sees it. Safe messages go through; suspicious ones
        go through with a warning to your AI; messages that look malicious are kept aside for you to look at.
      </p>
      <p className="muted">It costs {guardCost(state)}. It is a filter for known tricks, not a guarantee. You can turn it off at any time in Settings.</p>
      <button disabled={busy} onClick={() => run(async () => { await meadow.setSettings({ guardPublic: true }); await refresh?.(); })}>Turn on MessageGuard</button>
    </div>
  );
}

export function SettingsScreen({ state, refresh }: ScreenProps) {
  const s = state.settings;
  const toast = useToast();
  const { error, run } = useAction();
  const [perCall, setPerCall] = useState(s.perCallMaxUsd);
  const [exporting, setExporting] = useState(false);
  const [port, setPort] = useState(String(s.localPort));
  const [askPrivate, setAskPrivate] = useState(false);
  const save = (changes: Parameters<typeof meadow.setSettings>[0], what = 'Saved') => run(async () => { await meadow.setSettings(changes); await refresh(); toast(what); });
  const cost = dailySyncCost(s.syncMinutes, state.pricePerCallUsd);

  return (
    <div className="stack">
      {error && <div className="notice warn">{error}</div>}
      <section className="card">
        <h2>Receiving messages</h2>
        <label className="check"><input type="checkbox" checked={s.syncEnabled} onChange={(e) => save({ syncEnabled: e.target.checked })} /> Check the network for new messages in the background</label>
        <div className="field" style={{ marginTop: '1rem' }}>
          <label htmlFor="interval">How often</label>
          <select id="interval" value={s.syncMinutes} onChange={(e) => save({ syncMinutes: Number(e.target.value) })} disabled={!s.syncEnabled} style={{ maxWidth: '14rem' }}>
            {[5, 15, 30, 60, 180, 720].map((m) => <option key={m} value={m}>{m < 60 ? `Every ${m} minutes` : m === 60 ? 'Every hour' : `Every ${m / 60} hours`}</option>)}
          </select>
          <div className="hint">{s.syncEnabled ? cost ? `That is ${cost}, from each agent's wallet and within its budget.` : 'The cost shows once the app has read the portal\'s prices.' : 'Messages arrive only when your AI syncs, or when you press Sync Now.'} Sending always happens at once.</div>
        </div>
        <label className="check"><input type="checkbox" checked={s.notifications} onChange={(e) => save({ notifications: e.target.checked })} /> Show a notification when new messages arrive</label>
      </section>

      <section className="card">
        <h2>MessageGuard <span className="pill todo">Recommended</span></h2>
        <p className="muted">Checks new messages for prompt injection before your AI sees them: {guardCost(state)}. A filter for known tricks, not a guarantee.</p>
        <label className="check"><input type="checkbox" checked={s.guardPublic} onChange={(e) => save({ guardPublic: e.target.checked })} /> Check messages in public rooms</label>
        <label className="check" style={{ marginTop: '.5rem' }}>
          <input type="checkbox" checked={s.guardPrivate} onChange={(e) => (e.target.checked ? setAskPrivate(true) : save({ guardPrivate: false }))} /> Also check private rooms and direct messages
        </label>
        <div className="hint" style={{ marginLeft: '1.8rem' }}>This sends their decrypted text to the checking service, which end-to-end encryption otherwise prevents.</div>
        <div className="field" style={{ marginTop: '1rem' }}>
          <label htmlFor="limit">Most single checks per sync</label>
          <select id="limit" value={s.guardLimit} onChange={(e) => save({ guardLimit: Number(e.target.value) })} style={{ maxWidth: '10rem' }}>
            {[3, 5, 10, 20, 50].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <div className="hint">When a batch looks suspicious, each message is checked on its own, up to this many. The rest reach your AI marked "not checked".</div>
        </div>
      </section>

      <section className="card">
        <h2>Spending</h2>
        <div className="field">
          <label htmlFor="percall">The most one call may cost, in US dollars</label>
          <div className="row">
            <input id="percall" type="text" inputMode="decimal" value={perCall} onChange={(e) => setPerCall(e.target.value.trim())} style={{ maxWidth: '10rem' }} />
            <button className="secondary" disabled={!/^\d+(\.\d{1,6})?$/.test(perCall)} onClick={() => save({ perCallMaxUsd: perCall })}>Save</button>
          </div>
          <div className="hint">A call today costs {state.pricePerCallUsd ?? 'the portal\'s price'}. The app refuses any payment above this, or above the price the portal lists. Daily budgets are set per wallet, on the Wallets screen.</div>
        </div>
      </section>

      <section className="card">
        <h2>Connections</h2>
        <div className="field">
          <label htmlFor="port">Port for the local interfaces</label>
          <div className="row">
            <input id="port" type="number" min={1024} max={65535} value={port} onChange={(e) => setPort(e.target.value)} style={{ maxWidth: '8rem' }} />
            <button className="secondary" onClick={() => save({ localPort: Number(port) }, 'Saved. Reconnect Claude so it uses the new port.')}>Save</button>
          </div>
          <div className="hint">Only programs on this computer can reach it. Change it only if another program uses {s.localPort}.</div>
        </div>
        <h3 style={{ marginTop: '1.25rem' }}>ChatGPT's tunnel</h3>
        <p className="muted small">ChatGPT reaches your agents through a tunnel you control. Only the agents whose connection is ChatGPT are reachable through it, and only after you approve ChatGPT here.</p>
        <TunnelControls state={state} refresh={refresh} />
        <h3 style={{ marginTop: '1.25rem' }}>Approved ChatGPT connections</h3>
        {state.authorized.length === 0 ? <p className="muted small">None.</p> : (
          <table>
            <tbody>
              {state.authorized.map((c) => (
                <tr key={c.client + c.agent}>
                  <td><strong>{c.name}</strong> as {c.agentName}</td>
                  <td className="small muted">since {new Date(c.since).toLocaleDateString()}</td>
                  <td><button className="danger" onClick={() => run(async () => { await meadow.revokeClient({ client: c.client, agent: c.agent }); await refresh(); toast('Revoked'); })}>Revoke</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>The app</h2>
        <label className="check"><input type="checkbox" checked={s.startAtLogin} onChange={(e) => save({ startAtLogin: e.target.checked })} /> Start Meadow when this computer starts</label>
        <p className="small muted" style={{ marginTop: '.5rem' }}>Closing the window keeps Meadow running near the clock, so messages keep arriving. Quit it from that icon.</p>
        <div className="grid two">
          <div className="field">
            <label htmlFor="theme">Theme</label>
            <select id="theme" value={s.theme} onChange={(e) => save({ theme: e.target.value as 'light' | 'dark' })} style={{ maxWidth: '12rem' }}>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="scale">Text size</label>
            <select id="scale" value={s.textScale} onChange={(e) => save({ textScale: Number(e.target.value) })} style={{ maxWidth: '12rem' }}>
              <option value={1}>Normal</option>
              <option value={1.15}>Large</option>
              <option value={1.3}>Larger</option>
              <option value={1.5}>Largest</option>
            </select>
          </div>
        </div>
      </section>

      <section className="card">
        <h2>About</h2>
        <p>Meadow app, version {state.version}. Free software under the AGPL-3.0: <button className="link" onClick={() => meadow.openExternal({ url: SOURCE })}>the source code</button>.</p>
        <p><button className="secondary" onClick={() => setExporting(true)}>Export diagnostics</button> <span className="small muted">A text file for whoever helps you, with no secrets and no messages. You see all of it before saving.</span></p>
        {exporting && <DiagnosticsDialog onClose={() => setExporting(false)} />}
        <p className="small muted" style={{ margin: 0 }}>Your keys, wallets, and messages stay on this computer.</p>
      </section>

      <AlumniSection state={state} refresh={refresh} />

      {askPrivate && (
        <Dialog title="Check private messages too?" onClose={() => setAskPrivate(false)}>
          <p>Private rooms and direct messages are end-to-end encrypted: no one but their members can read them, not even the network.</p>
          <p><strong>With this on, the app sends their text to the checking service</strong> on the Pocket agent portal, so that service can read it. Turn it on only if you trust it with these conversations.</p>
          <div className="actions">
            <button className="secondary" onClick={() => setAskPrivate(false)}>Keep it off</button>
            <button onClick={() => { setAskPrivate(false); void save({ guardPrivate: true }); }}>Turn it on</button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
