// Plugin content in a message (SPEC §16.26.4): the app's own six components, filled with values the
// main process built and checked. Nothing external loads until the person clicks: a frame or audio
// then loads from the checked address; an image is fetched by the main process and shown as data.
// Each embed sits in its own error boundary, so one that fails never takes the message down.
import { Component as ReactComponent, useMemo, useState, type ReactNode } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import type { EmbedView } from '../../shared/api.ts';
import { meadow } from './lib.tsx';

const box = { border: '1px solid var(--border-subtle)', borderRadius: 10, padding: '.6rem .8rem', marginTop: '.5rem', maxWidth: '36rem' } as const;

/** One click to load: says what would load and from where, before anything does. */
function ClickToLoad({ what, host, verb, onLoad }: { what: string; host?: string; verb: string; onLoad: () => void }) {
  return (
    <div style={box}>
      <span className="small">{what}{host && <> from <span className="mono">{host}</span></>}</span>{' · '}
      <button className="link small" onClick={onLoad}>{verb}</button>
    </div>
  );
}

function Video({ f, host }: { f: Record<string, string | boolean>; host?: string }) {
  const [on, setOn] = useState(false);
  if (!on) return <ClickToLoad what={f.title ? `Video: ${f.title}` : 'Video'} host={host} verb="Play" onLoad={() => setOn(true)} />;
  return (
    <div style={{ ...box, padding: 0, overflow: 'hidden', aspectRatio: '16 / 9' }}>
      <iframe src={String(f.src)} title={String(f.title || 'Video')} style={{ width: '100%', height: '100%', border: 0 }}
        sandbox="allow-scripts allow-same-origin allow-presentation" allow="autoplay; encrypted-media; fullscreen; picture-in-picture" referrerPolicy="strict-origin-when-cross-origin" />
    </div>
  );
}

function Audio({ f, host }: { f: Record<string, string | boolean>; host?: string }) {
  const [on, setOn] = useState(false);
  if (!on) return <ClickToLoad what={f.title ? `Audio: ${f.title}` : 'Audio'} host={host} verb="Play" onLoad={() => setOn(true)} />;
  if (f.kind === 'file') return <div style={box}><audio controls autoPlay src={String(f.src)} style={{ width: '100%' }} /></div>;
  return (
    <div style={{ ...box, padding: 0, overflow: 'hidden' }}>
      <iframe src={String(f.src)} title={String(f.title || 'Audio')} style={{ width: '100%', height: 166, border: 0 }}
        sandbox="allow-scripts allow-same-origin" allow="autoplay; encrypted-media" referrerPolicy="strict-origin-when-cross-origin" />
    </div>
  );
}

function Image({ f, host }: { f: Record<string, string | boolean>; host?: string }) {
  const [state, setState] = useState<{ data?: string; error?: string; busy?: boolean }>({});
  if (state.data) return <div style={box}><img src={state.data} alt={String(f.alt ?? '')} style={{ maxWidth: '100%', display: 'block' }} /></div>;
  const show = async () => {
    setState({ busy: true });
    try {
      // A refusal comes back as a thrown error: the bridge turns an { error } answer into one.
      const r = await meadow.embedImage({ url: String(f.src) });
      setState('data' in r ? { data: r.data } : { error: r.error });
    } catch (e) {
      setState({ error: (e as Error).message });
    }
  };
  return (
    <div>
      <ClickToLoad what={f.alt ? `Image: ${f.alt}` : 'Image'} host={host} verb={state.busy ? 'Loading…' : 'Show'} onLoad={() => void show()} />
      {state.error && <div className="small muted" style={{ marginTop: '.25rem' }}>{state.error}</div>}
    </div>
  );
}

function Maths({ f }: { f: Record<string, string | boolean> }) {
  // KaTeX's own output: links, raw HTML, and other trust features off; sizes and macro expansion limited.
  const html = useMemo(() => katex.renderToString(String(f.tex), {
    displayMode: f.display === true, throwOnError: false, trust: false, strict: 'ignore', maxSize: 10, maxExpand: 100, output: 'htmlAndMathml',
  }), [f.tex, f.display]);
  return <div style={{ ...box, overflowX: 'auto' }} dangerouslySetInnerHTML={{ __html: html }} />;
}

function Code({ f }: { f: Record<string, string | boolean> }) {
  return (
    <div style={box}>
      {f.language && <div className="small muted">{String(f.language)}</div>}
      <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{String(f.code)}</pre>
    </div>
  );
}

function Card({ f, host }: { f: Record<string, string | boolean>; host?: string }) {
  return (
    <div style={box}>
      <strong>{String(f.title)}</strong>
      {f.text && <div className="small">{String(f.text)}</div>}
      <button className="link small" onClick={() => void meadow.openEmbedLink({ url: String(f.href) })}>Open {host ?? 'the link'} in your browser</button>
    </div>
  );
}

class Contained extends ReactComponent<{ children: ReactNode; type: string; onError?: (type: string, message: string) => void }, { failed: string | null }> {
  componentDidCatch(e: Error) {
    this.props.onError?.(this.props.type, e?.message ?? 'it failed');
  }
  state = { failed: null as string | null };
  static getDerivedStateFromError(e: Error) {
    return { failed: e?.message ?? 'it failed' };
  }
  render() {
    if (this.state.failed) return <div className="small muted" style={box}>This content couldn't be shown ({this.props.type}): {this.state.failed}</div>;
    return this.props.children;
  }
}

function One({ e }: { e: EmbedView }) {
  if (!e.shown) {
    return (
      <div style={box}>
        <div className="small muted">
          {e.why === 'not_installed'
            ? `Includes ${e.type} content; this app has no plugin for it, or it is off.`
            : `Includes ${e.type} content that does not fit its plugin, so it is not shown${e.detail ? `: ${e.detail}` : '.'}`}
        </div>
        <div className="mono small muted" style={{ overflowWrap: 'anywhere' }}>{e.line}</div>
      </div>
    );
  }
  const f = e.fields;
  switch (e.component) {
    case 'video': return <Video f={f} host={e.host} />;
    case 'audio': return <Audio f={f} host={e.host} />;
    case 'image': return <Image f={f} host={e.host} />;
    case 'math': return <Maths f={f} />;
    case 'code': return <Code f={f} />;
    case 'card': return <Card f={f} host={e.host} />;
  }
}

/** `onError`: told of each embed that fails, with its type (the dry run, and reports for Troubleshoot, §16.26.7). */
export function Embeds({ embeds, onError }: { embeds: EmbedView[]; onError?: (type: string, message: string) => void }) {
  return <>{embeds.map((e, i) => <Contained key={`${e.type}-${i}`} type={e.type} onError={onError}><One e={e} /></Contained>)}</>;
}
