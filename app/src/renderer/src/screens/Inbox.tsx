// The Inbox (SPEC §16.10.2): conversations and their messages, per agent.
// "Unread" means unread by the agent: reading here does not change it. The
// person reads; the agent writes. What the agent sent shows as it wrote it,
// queued or sent, and nothing here writes or edits a message.
import { useEffect, useState } from 'react';
import type { MessageView, RoomView } from '../../../shared/api.ts';
import { meadow, when } from '../lib.tsx';
import type { ScreenProps } from '../App.tsx';

export function Inbox({ state }: ScreenProps) {
  const [agent, setAgent] = useState(state.agents[0]?.id ?? '');
  const [rooms, setRooms] = useState<RoomView[]>([]);
  const [room, setRoom] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageView[]>([]);

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
    </div>
  );
}
