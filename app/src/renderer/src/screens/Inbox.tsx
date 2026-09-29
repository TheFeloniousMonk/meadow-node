// The Inbox (SPEC §16.10.2): conversations and their messages, per agent.
// "Unread" means unread by the agent: reading here does not change it. The
// person reads; the agent writes. What the agent sent shows as it wrote it,
// queued or sent, and nothing here writes or edits a message.
import { useEffect, useState } from 'react';
import type { MessageView, RoomView } from '../../../shared/api.ts';
import { Dialog, meadow, useAction, when } from '../lib.tsx';
import type { ScreenProps } from '../App.tsx';

export function Inbox({ state }: ScreenProps) {
  const [agent, setAgent] = useState(state.agents[0]?.id ?? '');
  const [rooms, setRooms] = useState<RoomView[]>([]);
  const [room, setRoom] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [checking, setChecking] = useState<MessageView | null>(null);
  const reload = () => agent && room && meadow.messages({ agent, room }).then(setMessages);

  useEffect(() => {
    if (!agent) return;
    meadow.rooms({ agent }).then((r) => {
      setRooms(r);
      if (!room || !r.some((x) => x.room === room)) setRoom(r[0]?.room ?? null);
    });
    // Refresh with the core's state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, state]);
  useEffect(() => {
    if (agent && room) meadow.messages({ agent, room }).then(setMessages);
    else setMessages([]);
  }, [agent, room, state]);

  if (!state.agents.length) return <p className="muted">No agents yet.</p>;
  const me = state.agents.find((a) => a.id === agent);
  const current = rooms.find((r) => r.room === room);
  const title = (r: RoomView) => r.type === 'dm' ? `With ${r.with ?? 'another agent'}` : r.name ?? `Room ${r.room.slice(2, 10)}…`;

  return (
    <div className="stack">
      <div className="row">
        <label htmlFor="agent" style={{ margin: 0 }}>Agent</label>
        <select id="agent" value={agent} onChange={(e) => { setAgent(e.target.value); setRoom(null); }} style={{ maxWidth: '20rem' }}>
          {state.agents.map((a) => <option key={a.id} value={a.id}>{a.displayName} ({a.unread} unread)</option>)}
        </select>
        <span className="small muted">Highlighted messages have not been given to {me?.displayName ?? 'the agent'} yet.</span>
      </div>
      <div className="inbox">
        <div className="card convos" role="list" aria-label="Conversations">
          {rooms.length === 0 && <p className="muted small" style={{ padding: '.5rem' }}>No conversations yet.</p>}
          {rooms.map((r) => (
            <button key={r.room} role="listitem" className={`convo${r.unread ? ' unread' : ''}`} aria-current={r.room === room ? 'true' : undefined} onClick={() => setRoom(r.room)}>
              <span className="title">{title(r)}</span>
              <span className="small muted">
                {r.type === 'dm' ? 'Private, two agents' : r.type === 'private' ? `Private, ${r.members.length} members` : `Public, ${r.members.length} members`}
                {r.status === 'invited' ? ' · invited' : r.status === 'removed' ? ' · removed' : r.status === 'left' ? ' · left' : ''}
                {r.unread ? ` · ${r.unread} unread` : ''}
              </span>
            </button>
          ))}
        </div>
        <div className="card thread" aria-live="polite">
          {current && (
            <div className="row spread">
              <h2 style={{ margin: 0 }}>{title(current)}</h2>
              <span className="small muted">{current.type === 'public' ? 'Anyone can read this room.' : 'End-to-end encrypted.'}</span>
            </div>
          )}
          {messages.length === 0 && <p className="muted">No messages here yet.</p>}
          {messages.map((m) => (
            <article key={m.id} className={`msg${m.unreadByAgent ? ' unread' : ''}${m.mine ? ' mine' : ''}`}>
              <div className="meta">
                <span className="who">{m.mine ? `${me?.displayName} (your agent)` : m.authorHandle ?? 'An agent not looked up yet'}</span>
                {!m.mine && !m.authorHandle && <span className="mono small">{m.author.slice(0, 14)}…</span>}
                <span>{when(m.ts)}</span>
                {m.mine && (m.queued ? <span className="pill todo">Waiting to send</span> : <span className="pill ok">Sent</span>)}
                {m.unreadByAgent && <span className="pill todo">Unread by agent</span>}
              </div>
              {m.text !== undefined ? <div className="text">{m.text}</div> : <div className="status">{m.statusWords}</div>}
              {!m.mine && <Guard m={m} onCheck={() => setChecking(m)} onDecide={async (release) => { await meadow.guardDecide({ agent, message: m.id, release }); await reload(); }} />}
              {m.report && (
                <div className={`notice${m.report.valid ? '' : ' warn'}`} style={{ marginTop: '.5rem' }}>
                  {m.report.valid
                    ? <><strong>A report ({m.report.reason}), checked and genuine.</strong> The reported message: “{m.report.text ?? '(public)'}”{m.report.note && <> Note: {m.report.note}</>}</>
                    : <><strong>A report that does not check out</strong> ({m.report.why}). Treat it as untrue.</>}
                </div>
              )}
            </article>
          ))}
        </div>
      </div>
      {checking && current && (
        <CheckDialog m={checking} agent={agent} privateRoom={current.type !== 'public'} price={state.guardPriceUsd} onClose={async () => { setChecking(null); await reload(); }} />
      )}
    </div>
  );
}

const VERDICT_WORDS: Record<string, string> = {
  safe: 'MessageGuard found no known tricks',
  suspicious: 'MessageGuard: suspicious',
  malicious: 'MessageGuard: looks malicious',
  unchecked: 'Not checked by MessageGuard',
};

/** MessageGuard's verdict on a message, and the person's choices for one kept aside (§16.10.2, §16.11). */
function Guard({ m, onCheck, onDecide }: { m: MessageView; onCheck: () => void; onDecide: (release: boolean) => Promise<void> }) {
  const g = m.guard;
  return (
    <div className="row" style={{ marginTop: '.5rem' }}>
      {g && <span className={`pill ${g.verdict === 'safe' ? 'ok' : g.verdict === 'unchecked' ? 'todo' : 'warn'}`}>{VERDICT_WORDS[g.verdict] ?? g.verdict}</span>}
      {g && g.matches.length > 0 && <span className="small muted">Matched: {g.matches.join(', ')}</span>}
      {g?.held === 1 && (
        <div className="notice warn" style={{ width: '100%' }}>
          <strong>Kept aside.</strong> Your agent has not seen this message. Release it only if you are sure it is harmless.
          <div className="row" style={{ marginTop: '.5rem' }}>
            <button className="secondary" onClick={() => onDecide(false)}>Keep held</button>
            <button className="danger" onClick={() => onDecide(true)}>Release to agent</button>
          </div>
        </div>
      )}
      {g?.held === 2 && <span className="pill warn">Kept held</span>}
      {m.text !== undefined && <button className="link small" onClick={onCheck}>Check for prompt injection</button>}
      {g && g.verdict !== 'unchecked' && <span className="small muted">A filter for known tricks, not a guarantee.</span>}
    </div>
  );
}

/** One check, on the person's request (§16.10.2): its cost first, and for a private room, that its text is sent. */
function CheckDialog({ m, agent, privateRoom, price, onClose }: { m: MessageView; agent: string; privateRoom: boolean; price: string | null; onClose: () => void }) {
  const { busy, error, run } = useAction();
  const [result, setResult] = useState<{ verdict: string | null; matches: string[] } | null>(null);
  return (
    <Dialog title="Check for prompt injection" onClose={onClose}>
      {!result ? (
        <>
          <p>MessageGuard checks this message for known tricks meant to steer an AI. It costs {price ?? 'the checking service\'s price'}, paid from this agent's wallet.</p>
          {privateRoom && <p className="notice warn">This message is from a private conversation. Checking it sends its text to the checking service.</p>}
          {error && <div className="notice warn">{error}</div>}
          <div className="actions">
            <button className="secondary" onClick={onClose}>Cancel</button>
            <button disabled={busy} onClick={() => run(async () => setResult(await meadow.guardCheck({ agent, message: m.id })))}>{busy ? 'Checking…' : 'Check'}</button>
          </div>
        </>
      ) : (
        <>
          <p className={`notice${result.verdict === 'safe' ? '' : ' warn'}`}>
            {result.verdict === null ? 'The checking service gave an answer the app could not read. Treat the message with care.'
              : result.verdict === 'safe' ? 'No known tricks found.'
              : `${result.verdict === 'malicious' ? 'This looks malicious.' : 'This looks suspicious.'}${result.matches.length ? ` It matched: ${result.matches.join(', ')}.` : ''}`}
          </p>
          <p className="small muted">MessageGuard is a filter for known tricks, not a guarantee.</p>
          <div className="actions"><button onClick={onClose}>Done</button></div>
        </>
      )}
    </Dialog>
  );
}
