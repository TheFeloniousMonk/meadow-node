// Plugins (SPEC §16.26.6): Install at the top, with a preview of everything a plugin would add
// before anything is kept; then the installed plugins, each with an on/off switch and Remove.
import { useState } from 'react';
import type { PluginPreview, PluginTypeView, PluginView } from '../../../shared/api.ts';
import { Dialog, meadow, useAction, useToast } from '../lib.tsx';
import type { ScreenProps } from '../App.tsx';

export const COMPONENT_WORDS: Record<string, string> = {
  video: 'a video player', audio: 'an audio player', image: 'an image', math: 'a maths formula', code: 'code', card: 'a link card',
};

function Types({ types }: { types: PluginTypeView[] }) {
  return (
    <ul className="small" style={{ margin: '.25rem 0 0', paddingLeft: '1.2rem' }}>
      {types.map((t) => (
        <li key={t.type}><strong className="mono">{t.type}</strong>, shown as {COMPONENT_WORDS[t.component] ?? t.component}: {t.description}</li>
      ))}
    </ul>
  );
}

function Hosts({ hosts }: { hosts: string[] }) {
  return hosts.length
    ? <p className="small" style={{ margin: '.25rem 0 0' }}>When you press Play or Show, it may load from: {hosts.map((h, i) => <span key={h}>{i ? ', ' : ''}<span className="mono">{h}</span></span>)}.</p>
    : <p className="small muted" style={{ margin: '.25rem 0 0' }}>It never loads anything from the internet.</p>;
}

function Icon({ src }: { src: string | null }) {
  return src
    ? <img src={src} alt="" width={40} height={40} style={{ borderRadius: 8, flex: 'none' }} />
    : <div aria-hidden="true" style={{ width: 40, height: 40, borderRadius: 8, flex: 'none', background: 'var(--bg-subtle, var(--border-subtle))' }} />;
}

export function PluginsScreen({ state, refresh }: ScreenProps) {
  const toast = useToast();
  const { busy, error, run, setError } = useAction();
  const [preview, setPreview] = useState<PluginPreview | null>(null);
  const [removing, setRemoving] = useState<PluginView | null>(null);

  const choose = () => run(async () => {
    const r = await meadow.pluginChoose();
    if (!r) return;
    if ('error' in r) setError(r.error);
    else setPreview(r.preview);
  });
  const install = () => run(async () => {
    await meadow.pluginInstall();
    toast(`${preview!.name} is installed and on.`);
    setPreview(null);
    await refresh();
  });
  const cancel = () => {
    void meadow.pluginCancel();
    setPreview(null);
  };

  return (
    <div className="stack">
      <section className="card">
        <h2 style={{ marginTop: 0 }}>Install a plugin</h2>
        <p className="muted">
          A plugin adds kinds of rich content to messages, such as videos, music, images, or formulas: your AI can put them in a message,
          and Meadow shows them when you read it. Plugins hold no code; Meadow checks every part of one, and nothing it shows loads until you press Play or Show.
          Install plugins only from people you trust.
        </p>
        <button disabled={busy} onClick={choose}>Choose a plugin file…</button>
        {error && <div className="notice warn" style={{ marginTop: '.75rem' }}>{error}</div>}
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Installed</h2>
        {!state.plugins.length && <p className="muted">No plugins yet.</p>}
        {state.plugins.map((p) => (
          <div key={p.id} className="group" style={{ display: 'flex', gap: '.9rem', alignItems: 'flex-start' }}>
            <Icon src={p.icon} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div><strong>{p.name}</strong>{p.version && <span className="muted"> {p.version}</span>}{p.author && <span className="muted small"> · by {p.author}</span>}</div>
              {p.description && <p className="small" style={{ margin: '.2rem 0 0' }}>{p.description}</p>}
              {p.error && <div className="notice warn" style={{ marginTop: '.5rem' }}>Switched off: {p.error}</div>}
              <Types types={p.types} />
              {!p.error && <Hosts hosts={p.hosts} />}
              <div className="row" style={{ marginTop: '.5rem' }}>
                <label className="check" style={{ fontWeight: 400 }}>
                  <input type="checkbox" checked={p.enabled} disabled={busy || !!p.error}
                    onChange={(e) => run(async () => { await meadow.pluginSetEnabled({ id: p.id, on: e.target.checked }); await refresh(); })} />
                  {p.enabled ? 'On: its content shows in messages' : 'Off: its content shows as plain text'}
                </label>
                <button className="secondary" disabled={busy} onClick={() => setRemoving(p)}>Remove</button>
              </div>
            </div>
          </div>
        ))}
      </section>

      {preview && (
        <Dialog title={preview.replaces ? `Update ${preview.name}` : `Install ${preview.name}?`} onClose={cancel}>
          <div style={{ display: 'flex', gap: '.9rem', alignItems: 'flex-start' }}>
            <Icon src={preview.icon} />
            <div>
              <div><strong>{preview.name}</strong> <span className="muted">{preview.version}</span>{preview.author && <span className="muted small"> · by {preview.author}</span>}</div>
              <p className="small" style={{ margin: '.2rem 0 0' }}>{preview.description}</p>
            </div>
          </div>
          {preview.replaces && <p className="notice" style={{ marginTop: '.75rem' }}>This replaces version {preview.replaces}, which is installed now.</p>}
          <div className="group">
            <h3 style={{ margin: '.75rem 0 0' }}>It adds</h3>
            <Types types={preview.types} />
          </div>
          <div className="group">
            <h3 style={{ margin: '.75rem 0 0' }}>From the internet</h3>
            <Hosts hosts={preview.hosts} />
          </div>
          <p className="small muted">Nothing is kept until you press Install. It stays on this computer only.</p>
          <div className="actions">
            <button className="secondary" onClick={cancel}>Cancel</button>
            <button disabled={busy} onClick={install}>Install</button>
          </div>
        </Dialog>
      )}

      {removing && (
        <Dialog title={`Remove ${removing.name}?`} onClose={() => setRemoving(null)}>
          <p>Its content shows as plain text again in messages. Nothing else changes, and you can install it again later.</p>
          <div className="actions">
            <button className="secondary" onClick={() => setRemoving(null)}>Cancel</button>
            <button disabled={busy} onClick={() => run(async () => { await meadow.pluginRemove({ id: removing.id }); toast(`${removing.name} is removed.`); setRemoving(null); await refresh(); })}>Remove</button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
