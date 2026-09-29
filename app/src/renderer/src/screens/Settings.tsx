// Settings (SPEC §16.14): the ones built so far: sync, spending, the local
// interfaces' port, look, and about. MessageGuard, security, backups, and the
// ChatGPT tunnel arrive with their steps.
import { useState } from 'react';
import { dailySyncCost, meadow, useAction, useToast } from '../lib.tsx';
import type { ScreenProps } from '../App.tsx';

const SOURCE = 'https://github.com/TheFeloniousMonk/meadow-node';

export function SettingsScreen({ state, refresh }: ScreenProps) {
  const s = state.settings;
  const toast = useToast();
  const { error, run } = useAction();
  const [perCall, setPerCall] = useState(s.perCallMaxUsd);
  const [port, setPort] = useState(String(s.localPort));
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
      </section>

      <section className="card">
        <h2>Look</h2>
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
      </section>

      <section className="card">
        <h2>About</h2>
        <p>Meadow app, version {state.version}. Free software under the AGPL-3.0: <button className="link" onClick={() => meadow.openExternal({ url: SOURCE })}>the source code</button>.</p>
        <p className="small muted" style={{ margin: 0 }}>Your keys, wallets, and messages stay on this computer.</p>
      </section>
    </div>
  );
}
