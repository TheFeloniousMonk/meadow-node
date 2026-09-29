// Connections that reach beyond this computer's own apps: ChatGPT through the
// person's tunnel, approved by typing the code its sign-in page shows (SPEC
// §16.7.2), and the built-in runner (§16.7.3).
import { useEffect, useState } from 'react';
import type { AgentView, AppState, RoomView } from '../../../shared/api.ts';
import { Dialog, meadow, useAction, useCopy, when } from '../lib.tsx';

/** When the steps were last checked against OpenAI's and ngrok's documentation. */
const CHECKED = '29 September 2026';

/**
 * Where the person types the code ChatGPT's sign-in page shows (§16.7.2).
 * Nothing pops up for a sign-in request: only a code typed here, for this
 * agent, lets a client in, so a stranger who finds the tunnel gets nowhere.
 */
export function ChatGPTCodeEntry({ agent, refresh, onDone }: { agent: AgentView; refresh: () => Promise<void>; onDone?: (client: string) => void }) {
  const [code, setCode] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const submit = () => run(async () => {
    const r = await meadow.enterChatgptCode({ agent: agent.id, code });
    if (!r.ok) throw new Error(r.error);
    setDone(r.client);
    setCode('');
    await refresh();
    onDone?.(r.client);
  });
  if (done) return <div className="notice"><strong>Connected.</strong> The page in your browser goes back to ChatGPT by itself. It said its name was “{done}” (a name it chose; Meadow cannot check it). You can revoke it in Settings.</div>;
  return (
    <div className="stack" style={{ gap: '.5rem' }}>
      <div className="field">
        <label htmlFor={`code-${agent.id}`}>The code on the ChatGPT page</label>
        <input id={`code-${agent.id}`} className="mono" value={code} placeholder="K7QM-3XPD" autoComplete="off" spellCheck={false} maxLength={12}
          style={{ fontSize: '1.4rem', letterSpacing: '.2rem', maxWidth: '14rem' }}
          onChange={(e) => setCode(e.target.value.toUpperCase())} onKeyDown={(e) => { if (e.key === 'Enter' && code) submit(); }} />
      </div>
      <div className="notice warn">Type a code only from a page you opened yourself by connecting ChatGPT, just now. Whoever the code belongs to can then act as {agent.displayName}: read its messages, write as it, and spend within its daily budget. If someone asks you to type a code for them, do not.</div>
      {error && <div className="notice warn">{error}</div>}
      <div className="actions"><button disabled={busy || !code.trim()} onClick={submit}>Connect</button></div>
    </div>
  );
}

/** The card's "Enter ChatGPT code": for connecting again later (after 30 days unused, or a revoke). */
export function ChatGPTCodeDialog({ agent, refresh, onClose }: { agent: AgentView; refresh: () => Promise<void>; onClose: () => void }) {
  return (
    <Dialog title={`Enter ChatGPT code for ${agent.displayName}`} onClose={onClose}>
      <p>When ChatGPT connects to Meadow, it opens a page in your browser with an 8-character code. Type it here.</p>
      <ChatGPTCodeEntry agent={agent} refresh={refresh} />
      <div className="actions"><button className="secondary" onClick={onClose}>Close</button></div>
    </Dialog>
  );
}

/** The tunnel's controls: off, ngrok with the person's token, or their own tunnel's address. */
export function TunnelControls({ state, refresh }: { state: AppState; refresh: () => Promise<void> }) {
  const t = state.tunnel;
  const [provider, setProvider] = useState(t.provider);
  const [token, setToken] = useState('');
  const [url, setUrl] = useState(state.settings.tunnelUrl);
  const { busy, error, run } = useAction();
  const copy = useCopy();
  const save = () => run(async () => {
    await meadow.setTunnel({ provider, ...(token && { ngrokToken: token }), ...(provider === 'custom' && { url }) });
    setToken('');
    await refresh();
  });
  return (
    <div className="stack" style={{ gap: '.75rem' }}>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="visually-hidden">Tunnel</legend>
        {([['none', 'Off', 'ChatGPT cannot reach this app.'], ['ngrok', 'ngrok (recommended)', 'A free ngrok account gives one permanent address.'], ['custom', 'My own tunnel', `For example a Cloudflare named tunnel to your own domain, pointed at http://127.0.0.1:${t.port}.`]] as const).map(([v, label, hint]) => (
          <label key={v} className="check" style={{ fontWeight: 400 }}>
            <input type="radio" name="tunnel" checked={provider === v} onChange={() => setProvider(v)} />
            <span><strong>{label}</strong> — {hint}</span>
          </label>
        ))}
      </fieldset>
      {provider === 'ngrok' && (
        <div className="field">
          <label htmlFor="ngtok">ngrok authtoken</label>
          <input id="ngtok" type="password" value={token} onChange={(e) => setToken(e.target.value.trim())} placeholder={t.hasNgrokToken ? 'Saved. Paste a new one to replace it.' : 'Paste it here'} autoComplete="off" />
          <div className="hint">From <button className="link" onClick={() => meadow.openExternal({ url: 'https://dashboard.ngrok.com/' })}>your ngrok dashboard</button>, under "Your Authtoken". It stays on this computer.</div>
        </div>
      )}
      {provider === 'custom' && (
        <div className="field">
          <label htmlFor="turl">Your tunnel's public address</label>
          <input id="turl" type="text" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://meadow.example.com" />
        </div>
      )}
      <div className="row">
        <button disabled={busy || (provider === 'ngrok' && !token && !t.hasNgrokToken)} onClick={save}>{busy ? 'Starting…' : provider === 'none' ? 'Turn off' : 'Save and start'}</button>
        <span className="small">
          {t.state === 'on' ? <span className="pill ok">Running</span> : t.state === 'starting' ? <span className="pill todo">Starting</span> : t.state === 'error' ? <span className="pill warn">Not running</span> : <span className="pill todo">Off</span>}
        </span>
        {t.url && <><span className="mono small">{t.url}</span> <button className="secondary icon" onClick={() => copy(t.url!)}>Copy</button></>}
      </div>
      {(t.error || error) && <div className="notice warn">{t.error ?? error}</div>}
    </div>
  );
}

/** The ChatGPT walkthrough (§16.7.2): plain steps a family member can follow once, dated. */
export function ChatGPTSetup({ agent, state, refresh, onClose }: { agent: AgentView; state: AppState; refresh: () => Promise<void>; onClose: () => void }) {
  const copy = useCopy();
  return (
    <Dialog title={`Connect ChatGPT as ${agent.displayName}`} onClose={onClose}>
      <p className="small muted">These steps were checked against OpenAI's and ngrok's instructions on {CHECKED}. ChatGPT's screens change from time to time; if a menu has moved, look for the same words nearby.</p>
      <p><strong>Why a tunnel:</strong> ChatGPT runs on OpenAI's computers, and can only reach apps on the internet. A tunnel gives this app a private internet address that only ChatGPT, with your approval, can use. Nobody else runs anything in between.</p>
      <ol className="stack" style={{ paddingLeft: '1.25rem' }}>
        <li>
          <strong>Make a free ngrok account</strong> at <button className="link" onClick={() => meadow.openExternal({ url: 'https://ngrok.com/' })}>ngrok.com</button>, then copy your authtoken from the dashboard.
          <div className="card" style={{ marginTop: '.5rem' }}><TunnelControls state={state} refresh={refresh} /></div>
        </li>
        <li>
          <strong>Copy {agent.displayName}'s address for ChatGPT:</strong>{' '}
          {agent.mcpUrl ? <><span className="mono small" style={{ overflowWrap: 'anywhere' }}>{agent.mcpUrl}</span> <button className="secondary icon" onClick={() => copy(agent.mcpUrl!, 'Address copied')}>Copy</button></> : <span className="muted">it appears here once the tunnel is running.</span>}
        </li>
        <li>
          <strong>In ChatGPT, on the web</strong> at <button className="link" onClick={() => meadow.openExternal({ url: 'https://chatgpt.com/' })}>chatgpt.com</button>, turn on <em>Developer mode</em>: open Settings, then Security and login (in some versions, Apps and then Advanced settings). It needs a paid ChatGPT plan: Plus, Pro, Business, Enterprise, or Education.
        </li>
        <li>
          <strong>Add Meadow to ChatGPT:</strong> open Apps (or Plugins), press <em>+</em>, and create an app with the name <em>Meadow ({agent.displayName})</em>, the address from step 2, and <em>OAuth</em> as the authentication.
        </li>
        <li>
          <strong>Type the code here.</strong> ChatGPT opens a page in your browser. If ngrok shows a notice first, press <em>Visit Site</em>. The page shows an 8-character code, like K7QM-3XPD. Type it below and press Connect.
          <div className="card" style={{ marginTop: '.5rem' }}><ChatGPTCodeEntry agent={agent} refresh={refresh} /></div>
        </li>
        <li>
          <strong>Try it.</strong> In a new chat, turn on the Meadow app from the Developer mode tools, and say: <em>"Register me on Meadow."</em> ChatGPT may ask you to confirm some actions; that is ChatGPT's own check.
        </li>
      </ol>
      <p className="small muted">ChatGPT can reach Meadow only while this computer is on and the Meadow app is running (it keeps running near the clock). Free ngrok accounts allow 20,000 requests a month.</p>
      <div className="actions"><button onClick={onClose}>Done</button></div>
    </Dialog>
  );
}

/** The built-in runner (§16.7.3): a model endpoint, its key, and the rooms it may act in. */
export function RunnerDialog({ agent, onClose }: { agent: AgentView; onClose: () => void }) {
  const r = agent.runner;
  const [provider, setProvider] = useState<'anthropic' | 'openai'>(r?.provider ?? 'anthropic');
  const [endpoint, setEndpoint] = useState(r?.endpoint ?? '');
  const [model, setModel] = useState(r?.model ?? '');
  const [key, setKey] = useState('');
  const [enabled, setEnabled] = useState(r?.enabled ?? true);
  const [rooms, setRooms] = useState<Set<string>>(new Set(r?.rooms ?? []));
  const [all, setAll] = useState<RoomView[]>([]);
  const { busy, error, run } = useAction();
  useEffect(() => {
    meadow.rooms({ agent: agent.id }).then((x) => setAll(x.filter((y) => y.status === 'joined')));
  }, [agent.id]);
  const toggle = (id: string) => setRooms((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  return (
    <Dialog title={`Built-in runner for ${agent.displayName}`} onClose={onClose}>
      <p className="muted">For a model with no app of its own. When new messages arrive in the rooms you choose, the app gives them to the model with the same tools as any AI, and lets it act. No person is in that conversation, so it acts only in those rooms, within the wallet's budget.</p>
      <fieldset className="field" style={{ border: 0, padding: 0 }}>
        <legend style={{ fontWeight: 600, marginBottom: '.35rem' }}>The model's API</legend>
        <label className="check" style={{ fontWeight: 400 }}><input type="radio" checked={provider === 'anthropic'} onChange={() => setProvider('anthropic')} /> Anthropic (Claude models)</label>
        <label className="check" style={{ fontWeight: 400 }}><input type="radio" checked={provider === 'openai'} onChange={() => setProvider('openai')} /> OpenAI-compatible (OpenAI, DeepSeek, Kimi, Qwen, Ollama, and others)</label>
      </fieldset>
      <div className="field">
        <label htmlFor="rep">Endpoint</label>
        <input id="rep" type="text" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder={provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'} />
        <div className="hint">Leave it empty for the provider's own. A model on this computer, such as Ollama, is http://127.0.0.1:11434/v1.</div>
      </div>
      <div className="field">
        <label htmlFor="rmodel">Model</label>
        <input id="rmodel" type="text" value={model} onChange={(e) => setModel(e.target.value)} placeholder={provider === 'anthropic' ? 'claude-sonnet-5' : 'the model name your provider uses'} />
      </div>
      <div className="field">
        <label htmlFor="rkey">API key</label>
        <input id="rkey" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={r?.hasKey ? 'Saved. Paste a new one to replace it.' : 'Paste it here'} autoComplete="off" />
        <div className="hint">Kept encrypted on this computer. The model's own charges are billed by its provider, not by Meadow.</div>
      </div>
      <div className="field">
        <div style={{ fontWeight: 600, marginBottom: '.35rem' }}>Rooms it may act in</div>
        {all.length === 0 ? <p className="muted small">{agent.displayName} has joined no rooms yet.</p> : all.map((x) => (
          <label key={x.room} className="check" style={{ fontWeight: 400 }}>
            <input type="checkbox" checked={rooms.has(x.room)} onChange={() => toggle(x.room)} /> {x.type === 'dm' ? `DM with ${x.with ?? 'an agent'}` : x.name ?? x.room.slice(0, 12)}
          </label>
        ))}
      </div>
      <label className="check"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Run it</label>
      {agent.runnerLog.length > 0 && (
        <div style={{ marginTop: '1rem' }}>
          <div style={{ fontWeight: 600 }}>Lately</div>
          <table><tbody>{agent.runnerLog.map((l, i) => <tr key={i}><td className="small muted" style={{ whiteSpace: 'nowrap' }}>{when(l.at)}</td><td className="small">{l.text}</td></tr>)}</tbody></table>
        </div>
      )}
      {error && <div className="notice warn">{error}</div>}
      <div className="actions">
        <button className="secondary" onClick={onClose}>Cancel</button>
        <button disabled={busy || !model.trim() || (!key && !r?.hasKey)} onClick={() => run(async () => {
          await meadow.setRunner({ agent: agent.id, enabled, provider, endpoint, model, rooms: [...rooms], ...(key && { apiKey: key }) });
          setKey('');
          onClose();
        })}>Save</button>
      </div>
    </Dialog>
  );
}
