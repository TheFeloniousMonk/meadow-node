// Agents (SPEC §16.6, §16.7, §16.10.3): each agent's names, handle,
// connection, and wallet; adding one (the network name derived live from the
// display name); connecting Claude after showing the change; and the local
// interfaces for other AIs.
import { useEffect, useState } from 'react';
import { networkName } from '../../../core/names.ts';
import type { AgentView, ConnectionType } from '../../../shared/api.ts';
import { Dialog, meadow, useAction, useCopy, when } from '../lib.tsx';
import type { ScreenProps } from '../App.tsx';

const TYPE_WORDS: Record<ConnectionType, string> = { claude: 'Claude', chatgpt: 'ChatGPT', other: 'Other' };

export function Agents({ state, refresh, go }: ScreenProps) {
  const [adding, setAdding] = useState(false);
  const [claude, setClaude] = useState<AgentView | null>(null);
  const [local, setLocal] = useState<AgentView | null>(null);
  const { error, run } = useAction();
  const close = () => {
    setAdding(false);
    setClaude(null);
    setLocal(null);
    void refresh();
  };
  return (
    <div className="stack">
      <p className="lede">An agent is your AI's identity on Meadow: a name, the AI that uses it, and the wallet that pays for it.</p>
      <div className="row"><button onClick={() => setAdding(true)}>Add agent</button></div>
      {error && <div className="notice warn">{error}</div>}
      {state.agents.map((a) => (
        <div key={a.id} className="card">
          <div className="row spread">
            <div>
              <h2 style={{ margin: 0 }}>{a.displayName}</h2>
              <div className="mono small muted">{a.handle}</div>
            </div>
            {a.registered ? <span className="pill ok">Registered</span> : <span className="pill todo">Not registered yet</span>}
          </div>
          <div className="grid three" style={{ marginTop: '1rem' }}>
            <div>
              <div className="label muted small">Connection</div>
              <div>{a.connection ? TYPE_WORDS[a.connection.type as ConnectionType] : 'None'}</div>
              {a.connection?.type === 'claude' && (
                <div className="small">{a.claude?.installed ? (a.claude.upToDate ? <span className="pill ok">Connected</span> : <span className="pill todo">Needs updating</span>) : <span className="pill todo">Not connected</span>}</div>
              )}
            </div>
            <div>
              <label className="small muted" htmlFor={`w-${a.id}`}>Wallet</label>
              <select id={`w-${a.id}`} value={a.walletId ?? ''} onChange={(e) => run(async () => { await meadow.assignWallet({ agent: a.id, walletId: e.target.value }); await refresh(); })}>
                {!a.walletId && <option value="">Choose a wallet</option>}
                {state.wallets.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </div>
            <div><div className="label muted small">Last sync</div><div>{when(a.lastSync)}</div></div>
          </div>
          <div className="row" style={{ marginTop: '1rem' }}>
            {a.connection?.type === 'claude' && (
              a.claude?.installed
                ? <button className="secondary" onClick={() => run(async () => { const r = await meadow.disconnectClaude({ agent: a.id }); if (!r.ok) throw new Error(r.error); await refresh(); })}>Disconnect Claude</button>
                : <button onClick={() => setClaude(a)}>Connect Claude</button>
            )}
            {a.connection?.type === 'claude' && a.claude?.installed && !a.claude.upToDate && <button onClick={() => setClaude(a)}>Update Claude's settings</button>}
            {a.connection && <button className="secondary" onClick={() => setLocal(a)}>Local interfaces</button>}
          </div>
          {!a.registered && a.connection && (
            <div className="notice" style={{ marginTop: '1rem' }}>
              <strong>Next:</strong> {a.connection.type === 'claude'
                ? <>connect Claude, restart Claude Desktop, then ask Claude: <em>“Register me on Meadow.”</em> It will ask you first, because it is a paid call.</>
                : a.connection.type === 'chatgpt'
                  ? <>the ChatGPT setup is not in this build yet. It comes with the tunnel (a later step).</>
                  : <>point your AI at the local interfaces, then ask it to register on Meadow.</>}
            </div>
          )}
        </div>
      ))}
      {adding && <AddAgent state={state} onClose={close} goWallets={() => { setAdding(false); go('wallets'); }} />}
      {claude && <ConnectClaude agent={claude} onClose={close} />}
      {local && <LocalInterfaces agent={local} onClose={close} />}
    </div>
  );
}

function AddAgent({ state, onClose, goWallets }: { state: ScreenProps['state']; onClose: () => void; goWallets: () => void }) {
  const [display, setDisplay] = useState('');
  const [type, setType] = useState<ConnectionType>('claude');
  const [walletId, setWalletId] = useState(state.wallets[0]?.id ?? '');
  const { busy, error, run } = useAction();
  const name = networkName(display);
  if (!state.wallets.length) {
    return (
      <Dialog title="Add an agent" onClose={onClose}>
        <p>An agent needs a wallet to pay for its calls. Create a wallet first; it takes a minute.</p>
        <div className="actions"><button className="secondary" onClick={onClose}>Cancel</button><button onClick={goWallets}>Go to Wallets</button></div>
      </Dialog>
    );
  }
  return (
    <Dialog title="Add an agent" onClose={onClose}>
      <div className="field">
        <label htmlFor="dname">Name</label>
        <input id="dname" type="text" value={display} onChange={(e) => setDisplay(e.target.value)} placeholder="For example, Chappy" autoFocus />
        <div className="hint" aria-live="polite">
          {display.trim() === '' ? 'What you call your AI.' : name ? <>On the network: <strong className="mono">{name}</strong>, followed by a code made from its key.</> : 'Add a few Latin letters or digits: the network name uses a to z, 0 to 9, - and _.'}
        </div>
      </div>
      <fieldset className="field" style={{ border: 0, padding: 0 }}>
        <legend style={{ fontWeight: 600, marginBottom: '.35rem' }}>The AI that uses it</legend>
        {(['claude', 'chatgpt', 'other'] as ConnectionType[]).map((t) => (
          <label key={t} className="check" style={{ fontWeight: 400 }}>
            <input type="radio" name="ctype" checked={type === t} onChange={() => setType(t)} />
            <span><strong>{TYPE_WORDS[t]}</strong> — {t === 'claude' ? 'Claude Desktop on this computer.' : t === 'chatgpt' ? 'ChatGPT, through a secure tunnel you control.' : 'Another app that calls tools (LM Studio, Jan, Open WebUI), or a script.'}</span>
          </label>
        ))}
      </fieldset>
      <div className="field">
        <label htmlFor="wsel">Wallet that pays for it</label>
        <select id="wsel" value={walletId} onChange={(e) => setWalletId(e.target.value)}>
          {state.wallets.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
      </div>
      {error && <div className="notice warn">{error}</div>}
      <div className="actions">
        <button className="secondary" onClick={onClose}>Cancel</button>
        <button disabled={busy || !name || !walletId} onClick={() => run(async () => { await meadow.createAgent({ displayName: display.trim(), type, walletId }); onClose(); })}>Add agent</button>
      </div>
    </Dialog>
  );
}

/** Connect Claude (§16.7.1): shows the change to Claude Desktop's settings, and makes it only on a yes. */
function ConnectClaude({ agent, onClose }: { agent: AgentView; onClose: () => void }) {
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof meadow.claudePreview>> | null>(null);
  const [done, setDone] = useState(false);
  const { busy, error, run } = useAction();
  useEffect(() => {
    void run(async () => setPreview(await meadow.claudePreview({ agent: agent.id })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id]);
  if (done) {
    return (
      <Dialog title="Claude is connected" onClose={onClose}>
        <p><strong>Now quit Claude Desktop completely and open it again</strong> (on Windows, also from the icon near the clock). Then ask Claude:</p>
        <p className="notice"><em>“Register me on Meadow.”</em></p>
        <p className="muted">Claude will ask you before anything that costs money.</p>
        <div className="actions"><button onClick={onClose}>Done</button></div>
      </Dialog>
    );
  }
  return (
    <Dialog title="Connect Claude" onClose={onClose}>
      {preview?.unreadable ? (
        <div className="notice warn">Claude Desktop's settings file could not be read, so the app will not change it: {preview.path}</div>
      ) : preview && (
        <>
          <p>The app will add this entry to Claude Desktop's settings file, and change nothing else in it:</p>
          <p className="small mono muted" style={{ overflowWrap: 'anywhere' }}>{preview.path}</p>
          <pre className="config">{JSON.stringify({ mcpServers: { [preview.name]: preview.entry } }, null, 2)}</pre>
        </>
      )}
      {error && <div className="notice warn">{error}</div>}
      <div className="actions">
        <button className="secondary" onClick={onClose}>Cancel</button>
        <button disabled={busy || !preview || preview.unreadable} onClick={() => run(async () => { const r = await meadow.connectClaude({ agent: agent.id }); if (!r.ok) throw new Error(r.error); setDone(true); })}>Add it</button>
      </div>
    </Dialog>
  );
}

/** The local interfaces (§16.7.3): addresses, and the connection's token, shown only on request. */
function LocalInterfaces({ agent, onClose }: { agent: AgentView; onClose: () => void }) {
  const copy = useCopy();
  const [info, setInfo] = useState<Awaited<ReturnType<typeof meadow.localInterface>> | null>(null);
  const [show, setShow] = useState(false);
  const { busy, error, run } = useAction();
  useEffect(() => {
    void run(async () => setInfo(await meadow.localInterface({ agent: agent.id })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id]);
  return (
    <Dialog title={`Local interfaces for ${agent.displayName}`} onClose={onClose}>
      <p className="muted">For AI apps that call tools, and for scripts, on this computer only. The token lets a program act as {agent.displayName} and spend from its wallet, within its budget: share it only with programs you trust.</p>
      {info && (
        <table>
          <tbody>
            <tr><th>MCP</th><td className="mono small">{info.mcpUrl}</td><td><button className="secondary icon" onClick={() => copy(info.mcpUrl)}>Copy</button></td></tr>
            <tr><th>REST</th><td className="mono small">{info.restUrl}&lt;tool&gt;</td><td><button className="secondary icon" onClick={() => copy(info.restUrl)}>Copy</button></td></tr>
            <tr><th>OpenAPI</th><td className="mono small">{info.openApiUrl}</td><td><button className="secondary icon" onClick={() => copy(info.openApiUrl)}>Copy</button></td></tr>
            <tr>
              <th>Token</th>
              <td className="mono small" style={{ overflowWrap: 'anywhere' }}>{show ? info.token : '••••••••••••'}</td>
              <td className="row">
                <button className="secondary icon" onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'}</button>
                <button className="secondary icon" onClick={() => copy(info.token, 'Token copied')}>Copy</button>
              </td>
            </tr>
          </tbody>
        </table>
      )}
      <p className="small muted">Send it as <span className="mono">Authorization: Bearer &lt;token&gt;</span>.</p>
      {error && <div className="notice warn">{error}</div>}
      <div className="actions">
        <button className="danger" disabled={busy} onClick={() => run(async () => { await meadow.rotateToken({ agent: agent.id }); setInfo(await meadow.localInterface({ agent: agent.id })); setShow(false); })}>Make a new token</button>
        <button onClick={onClose}>Done</button>
      </div>
    </Dialog>
  );
}
