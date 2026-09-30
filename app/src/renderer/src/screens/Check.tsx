// The connection check on each agent's card, Test connection, and the
// diagnostics export (SPEC §16.17). Plain words, one line per step, and the
// first step that is not working named first, with what to do.
import { useEffect, useState } from 'react';
import type { AgentView, ConnectionTestView } from '../../../shared/api.ts';
import { Dialog, meadow, useAction, when } from '../lib.tsx';

const MARK = { ok: 'ok', warn: 'todo', bad: 'warn' } as const;
const WORD = { ok: 'Working', warn: 'Check', bad: 'Not working' } as const;

/** The connection check, folded to its verdict until the person opens it. */
export function ConnectionCheck({ agent }: { agent: AgentView }) {
  const [open, setOpen] = useState(false);
  const [test, setTest] = useState<ConnectionTestView | null>(null);
  const [exporting, setExporting] = useState(false);
  const { busy, error, run } = useAction();
  const c = agent.check;
  if (!c) return null;
  return (
    <div className="check-panel" style={{ marginTop: '1rem' }}>
      <div className="row spread">
        <div className="row" style={{ gap: '.6rem' }}>
          <strong>Connection check</strong>
          <span className={`pill ${MARK[c.verdict.state]}`}>{WORD[c.verdict.state]}</span>
        </div>
        <button className="link small" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide the steps' : 'Show the steps'}</button>
      </div>
      <p className="small" style={{ margin: '.4rem 0 0' }}>{c.verdict.text}</p>
      {open && (
        <>
          <ol className="steps">
            {c.steps.map((st) => (
              <li key={st.key}>
                <span className={`pill ${MARK[st.state]}`}>{WORD[st.state]}</span>
                <span><strong>{st.label}.</strong> {st.text}{st.at ? ` ${when(st.at)}.` : ''}</span>
              </li>
            ))}
          </ol>
          <div className="row">
            {agent.connection?.type === 'chatgpt' && (
              <button className="secondary" disabled={busy} onClick={() => run(async () => setTest(await meadow.testConnection({ agent: agent.id })))}>
                {busy ? 'Testing…' : 'Test connection'}
              </button>
            )}
            <button className="secondary" onClick={() => setExporting(true)}>Export diagnostics</button>
          </div>
          {error && <div className="notice warn">{error}</div>}
          {test && (
            <div className={`notice${test.ok ? '' : ' warn'}`} style={{ marginTop: '.6rem' }}>
              <strong>{test.ok ? 'The tunnel reaches this app.' : 'The tunnel does not reach this app.'}</strong>
              <ul style={{ margin: '.4rem 0 0' }}>{test.steps.map((x, i) => <li key={i}>{x.label}: {x.text}</li>)}</ul>
              <p className="small" style={{ margin: '.4rem 0 0' }}>{test.note}</p>
            </div>
          )}
        </>
      )}
      {exporting && <DiagnosticsDialog onClose={() => setExporting(false)} />}
    </div>
  );
}

/** The export's full text first, so the person sees exactly what they would send (§16.17.4). */
export function DiagnosticsDialog({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  useEffect(() => {
    void run(async () => setText((await meadow.diagnosticsText()).text));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Dialog title="Export diagnostics" onClose={onClose}>
      {saved ? (
        <>
          <p>Saved in:</p>
          <p className="mono small" style={{ overflowWrap: 'anywhere' }}>{saved}</p>
          <p className="muted">Send this file to whoever helps you with Meadow.</p>
          <div className="actions"><button onClick={onClose}>Done</button></div>
        </>
      ) : (
        <>
          <p>This is everything the file will hold. It has no keys, passwords, tokens, wallet addresses, handles, room names, or messages. Read it before sending it to anyone.</p>
          <pre className="export">{text ?? 'Gathering…'}</pre>
          {error && <div className="notice warn">{error}</div>}
          <div className="actions">
            <button className="secondary" onClick={onClose}>Cancel</button>
            <button disabled={busy || text === null} onClick={() => run(async () => { const r = await meadow.diagnosticsSave(); if (r.saved) setSaved(r.saved); })}>Choose where to save it</button>
          </div>
        </>
      )}
    </Dialog>
  );
}
