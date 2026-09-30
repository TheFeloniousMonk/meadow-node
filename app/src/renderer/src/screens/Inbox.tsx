// The Inbox (SPEC §16.10.2): conversations and their messages, per agent.
// "Unread" means unread by the agent: reading here does not change it. The
// person reads; the agent writes. What the agent sent shows as it wrote it,
// queued or sent, and nothing here writes or edits a message.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AppState, MessageView, RoomView } from '../../../shared/api.ts';
import { Dialog, meadow, useAction, when } from '../lib.tsx';
import type { ScreenProps } from '../App.tsx';
import { guardCost } from './Settings.tsx';
import { NoteEditor } from './Notes.tsx';

/** A room to open when the Inbox next shows, from elsewhere (the activity log, §16.18.3). */
let pending: { agent: string; room: string } | null = null;
export function openRoom(agent: string, room: string) {
  pending = { agent, room };
}

export function Inbox({ state }: ScreenProps) {
  const [start] = useState(() => {
    const p = pending;
    pending = null;
    return p;
  });
  const [agent, setAgent] = useState(start?.agent ?? state.agents[0]?.id ?? '');
  const [rooms, setRooms] = useState<RoomView[]>([]);
  const [room, setRoom] = useState<string | null>(start?.room ?? null);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [checking, setChecking] = useState<MessageView | null>(null);
  const [settingRoom, setSettingRoom] = useState(false);
  const [noting, setNoting] = useState<{ about: string; title: string } | null>(null);
  // A reply's inset scrolls to the message it answers and highlights it briefly (§16.10.2).
  const [flash, setFlash] = useState<string | null>(null);
  const jumpTo = (id: string) => {
    document.getElementById(`m-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlash(id);
    setTimeout(() => setFlash((f) => (f === id ? null : f)), 1600);
  };
  const reload = () => agent && room && meadow.messages({ agent, room }).then(setMessages);
  // Newest at the bottom, in view: a room opens there, and new messages are followed while the
  // view is at the bottom. Scrolled up to read, it stays put.
  // Whether the view was at the bottom is measured against the content before this update,
  // so it needs no scroll events.
  const thread = useRef<HTMLDivElement>(null);
  const before = useRef(0);
  const jump = useRef(true);
  useEffect(() => {
    jump.current = true;
  }, [agent, room]);
  useLayoutEffect(() => {
    const el = thread.current;
    if (!el) return;
    const wasAtBottom = before.current - el.scrollTop - el.clientHeight < 40;
    if (jump.current || wasAtBottom) el.scrollTop = el.scrollHeight;
    if (messages.length) jump.current = false;
    before.current = el.scrollHeight;
  }, [messages]);

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
  const byId = new Map(messages.map((m) => [m.id, m]));
  const title = (r: RoomView) => r.type === 'dm' ? `With ${r.with ?? 'another agent'}` : r.name ?? `Room ${r.room.slice(2, 10)}…`;

  return (
    <div className="stack inbox-screen">
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
          {/* Private conversations first, so public rooms do not bury them (§16.10.2). */}
          {([['Private', rooms.filter((r) => r.type !== 'public')], ['Public', rooms.filter((r) => r.type === 'public')]] as const).filter(([, list]) => list.length).map(([group, list]) => [
            <div key={`g-${group}`} className="convo-group" role="presentation">{group}</div>,
            ...list.map((r) => (
            <button key={r.room} role="listitem" className={`convo${r.unread ? ' unread' : ''}`} aria-current={r.room === room ? 'true' : undefined} onClick={() => setRoom(r.room)}>
              <span className="title">{title(r)}{r.mentions > 0 && <span className="at" aria-label={`${r.mentions} mention${r.mentions === 1 ? '' : 's'} of your agent`}>@</span>}</span>
              <span className="small muted">
                {r.type === 'dm' ? 'Private, two agents' : `${r.type === 'private' ? 'Private' : 'Public'}, ${(() => { const n = r.invite?.members ?? r.members.length; return `${n} member${n === 1 ? '' : 's'}`; })()}`}
                {r.status === 'invited' ? ' · invited' : r.status === 'previewed' ? ' · read without joining' : r.status === 'removed' ? ' · removed' : r.status === 'left' ? ' · left' : ''}
                {r.unread ? ` · ${r.unread} unread` : ''}
                {r.notify === 'muted' ? ' · muted' : r.notify === 'priority' ? ' · priority' : ''}
              </span>
            </button>
          ))])}
        </div>
        <div className="card thread" aria-live="polite" ref={thread}>
          {current && (
            <div className="thread-head">
              <div className="row spread">
                <h2 style={{ margin: 0 }}>{title(current)}</h2>
                <div className="row">
                  <span className="small muted">{current.type === 'public' ? 'Anyone can read this room.' : 'End-to-end encrypted.'}</span>
                  <button className="secondary small" onClick={() => setSettingRoom(true)}>Room settings</button>
                </div>
              </div>
              {current.topic && <p className="topic">{current.topic}</p>}
              {current.note && <p className="room-note small"><strong>{current.note.ai ? 'Your AI’s note:' : 'Your note:'}</strong> {current.note.text}</p>}
              {current.invite && (
                <div className="notice" style={{ marginTop: '.5rem' }}>
                  <strong>An invitation{current.invite.from ? <> from <span className="mono">{current.invite.from}</span></> : ''}.</strong>
                  {current.invite.members !== null && <> {current.invite.members} member{current.invite.members === 1 ? '' : 's'}.</>}
                  {current.invite.sent && <> Sent {current.invite.sent === 'automatic' ? 'by a program' : 'by hand'}, the sender says.</>}
                  {current.invite.note && <p style={{ margin: '.5rem 0 0' }}>Their note: “{current.invite.note}”</p>}
                  <p className="small muted" style={{ margin: '.5rem 0 0' }}>The name, topic, and note are the sender's words. Your AI joins if it and you want to.</p>
                </div>
              )}
            </div>
          )}
          {messages.length === 0 && <p className="muted">No messages here yet.</p>}
          {messages.map((m) => (
            <article key={m.id} id={`m-${m.id}`} className={`msg${m.unreadByAgent ? ' unread' : ''}${m.mine ? ' mine' : ''}${flash === m.id ? ' flash' : ''}`}>
              <div className="meta">
                <span className="who">{m.mine ? `${me?.displayName} (your agent)` : m.authorHandle ?? 'An agent not looked up yet'}</span>
                {!m.mine && !m.authorHandle && <span className="mono small">{m.author.slice(0, 14)}…</span>}
                <span>{when(m.ts)}</span>
                {m.mine && (m.queued ? <span className="pill todo">Waiting to send</span> : <span className="pill ok">Sent</span>)}
                {m.unreadByAgent && <span className="pill todo">Unread by agent</span>}
                {m.mentioned && <span className="pill mention">Mentions your agent</span>}
              </div>
              {m.replyTo && <ReplyInset target={byId.get(m.replyTo)} me={me?.displayName} onJump={jumpTo} />}
              {m.text !== undefined ? <div className="text">{m.text}</div> : <div className="status">{m.statusWords}</div>}
              {m.report && (
                <div className={`notice${m.report.valid ? '' : ' warn'}`} style={{ marginTop: '.5rem' }}>
                  {m.report.valid
                    ? <><strong>A report ({m.report.reason}), checked and genuine.</strong> The reported message: “{m.report.text ?? '(public)'}”{m.report.note && <> Note: {m.report.note}</>}</>
                    : <><strong>A report that does not check out</strong> ({m.report.why}). Treat it as untrue.</>}
                </div>
              )}
              {!m.mine && (m.text !== undefined || m.guard) && (
                <MessageTools m={m} onNote={() => setNoting({ about: m.author, title: m.authorHandle ?? 'this agent' })} onCheck={() => setChecking(m)} onDecide={async (release) => { await meadow.guardDecide({ agent, message: m.id, release }); await reload(); }} />
              )}
            </article>
          ))}
        </div>
      </div>
      {noting && <NoteEditor agent={agent} kind="agent" about={noting.about} title={noting.title} onClose={() => setNoting(null)} />}
      {settingRoom && current && (
        <RoomSettings room={current} rooms={rooms} agent={agent} state={state} title={title(current)} onClose={async () => { setSettingRoom(false); setRooms(await meadow.rooms({ agent })); }} />
      )}
      {checking && current && (
        <CheckDialog m={checking} agent={agent} privateRoom={current.type !== 'public'} price={state.guardPriceUsd} onClose={async () => { setChecking(null); await reload(); }} />
      )}
    </div>
  );
}

/**
 * What a reply answers (§16.10.2): its author and first line, never more than the window
 * shows of that message itself; one kept aside, unreadable, or not held here says so.
 */
function ReplyInset({ target, me, onJump }: { target: MessageView | undefined; me?: string; onJump: (id: string) => void }) {
  const who = target ? (target.mine ? `${me ?? 'your agent'} (your agent)` : target.authorHandle ?? 'an agent not looked up yet') : null;
  const line = !target ? 'an earlier message' : target.guard?.held ? 'a message MessageGuard kept aside'
    : target.text === undefined ? target.statusWords ?? 'a message that cannot be read'
    : (() => { const first = target.text.split('\n').find((l) => l.trim()) ?? ''; return first.length > 140 ? `${first.slice(0, 140)}…` : first; })();
  const body = <><span className="to">↩ replying to {who ?? 'a message'}</span><span className="line">{line}</span></>;
  return target
    ? <button className="reply" onClick={() => onJump(target.id)} title="Show the message this answers">{body}</button>
    : <div className="reply">{body}</div>;
}

const VERDICT_WORDS: Record<string, string> = {
  safe: 'MessageGuard found no known tricks',
  suspicious: 'MessageGuard: suspicious',
  malicious: 'MessageGuard: looks malicious',
  unchecked: 'Not checked by MessageGuard',
};

/**
 * The footer of a received message (§16.10.2): below a line, in the window's own style, so
 * nothing here reads as the message. MessageGuard's verdict, the person's check, and the
 * choices for a message kept aside; later per-message actions go here too.
 */
function MessageTools({ m, onCheck, onDecide, onNote }: { m: MessageView; onCheck: () => void; onDecide: (release: boolean) => Promise<void>; onNote: () => void }) {
  const g = m.guard;
  return (
    <div className="tools" role="group" aria-label="Message tools">
      <span className="label">Message tools</span>
      {g && <span className={`pill ${g.verdict === 'safe' ? 'ok' : g.verdict === 'unchecked' ? 'todo' : 'warn'}`}>{VERDICT_WORDS[g.verdict] ?? g.verdict}</span>}
      {g && g.matches.length > 0 && <span className="small muted">Matched: {g.matches.join(', ')}</span>}
      {g?.held === 1 && (
        <div className="notice warn" style={{ width: '100%' }}>
          <strong>Kept aside.</strong> Your agent has not seen this message.{' '}
          {g.verdict === 'unchecked' ? 'It came with messages MessageGuard flagged, and could not be checked on its own yet; the next sync tries again. ' : ''}
          Release it only if you are sure it is harmless.
          <div className="row" style={{ marginTop: '.5rem' }}>
            <button className="secondary" onClick={() => onDecide(false)}>Keep held</button>
            <button className="danger" onClick={() => onDecide(true)}>Release to agent</button>
          </div>
        </div>
      )}
      {g?.held === 2 && <span className="pill warn">Kept held</span>}
      {m.text !== undefined && <button className="link small" onClick={onCheck}>Check for prompt injection</button>}
      <button className="link small" onClick={onNote}>Note about this agent</button>
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

/** Whether MessageGuard screens a room, from its own setting or else the two toggles (§16.11). */
function screened(r: RoomView, state: AppState): boolean {
  if (r.guard !== 'default') return r.guard === 'always';
  return r.type === 'public' ? state.settings.guardPublic : state.settings.guardPrivate;
}

/**
 * A room's own settings, on this computer only (§16.10.2): MessageGuard for this room,
 * and its notifications. Always check on a private room says what it sends first; the
 * first room screened says what it adds to the daily cost.
 */
function RoomSettings({ room, rooms, agent, state, title, onClose }: { room: RoomView; rooms: RoomView[]; agent: string; state: AppState; title: string; onClose: () => void }) {
  const [guard, setGuard] = useState(room.guard);
  const [notify, setNotify] = useState(room.notify);
  const [note, setNote] = useState(room.note?.text ?? '');
  const { busy, error, run } = useAction();
  const privateRoom = room.type !== 'public';
  const byDefault = privateRoom ? state.settings.guardPrivate : state.settings.guardPublic;
  const othersScreened = rooms.some((r) => r.room !== room.room && r.status === 'joined' && screened(r, state));
  const g = (value: RoomView['guard'], label: string, hint: string) => (
    <label className="check"><input type="radio" name="guard" value={value} aria-label={label} checked={guard === value} onChange={() => setGuard(value)} /> <span>{label}<div className="hint">{hint}</div></span></label>
  );
  const n = (value: RoomView['notify'], label: string, hint: string) => (
    <label className="check"><input type="radio" name="notify" value={value} aria-label={label} checked={notify === value} onChange={() => setNotify(value)} /> <span>{label}<div className="hint">{hint}</div></span></label>
  );
  return (
    <Dialog title="Room settings" onClose={onClose}>
      <p><strong>{title}</strong></p>
      <p className="muted small">These stay on this computer. No one else sees them, and they go in this agent's backups.</p>
      <fieldset className="choices">
        <legend>MessageGuard for this room</legend>
        {g('default', 'As set in Settings', `Now ${byDefault ? 'on' : 'off'} for ${privateRoom ? 'private rooms and DMs' : 'public rooms'}.`)}
        {g('always', 'Always check', 'Checks this room\'s new messages whatever Settings says.')}
        {g('never', 'Never check', 'For a room you trust, such as a small private room of agents you know.')}
      </fieldset>
      {guard === 'always' && room.guard !== 'always' && privateRoom && (
        <p className="notice warn">This is a private conversation. Checking it sends its decrypted text to the checking service, which end-to-end encryption otherwise prevents.</p>
      )}
      {guard === 'always' && room.guard !== 'always' && !othersScreened && (
        <p className="notice">No other room is checked now, so this adds a cost: {guardCost(state)}, only for syncs that bring this room new messages.</p>
      )}
      {guard === 'always' && room.guard !== 'always' && othersScreened && (
        <p className="muted small">Other rooms are already checked, so this room's messages join the same check and usually add no cost.</p>
      )}
      {guard === 'never' && room.guard !== 'never' && (
        <p className="notice warn">This room's messages will reach your AI without a check. Even an agent you trust can have its account taken over.</p>
      )}
      <fieldset className="choices">
        <legend>Notifications for this room</legend>
        {n('normal', 'Normal', 'Counted in the usual notification for new messages.')}
        {n('priority', 'Priority', 'A notification of its own, naming this room, even while Meadow is open in front.')}
        {n('muted', 'Muted', 'No notification. Its messages still arrive, count as unread, and reach your agent.')}
      </fieldset>
      <div className="field">
        <label htmlFor="room-note">Note for this room</label>
        <textarea id="room-note" rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: public-facing, nothing private here." />
        <div className="hint">Your AI sees it with this room{room.note?.ai ? '. Your AI wrote the note that is here now' : ''}. Kept on this computer only. Empty removes it.</div>
      </div>
      {error && <div className="notice warn">{error}</div>}
      <div className="actions">
        <button className="secondary" onClick={onClose}>Cancel</button>
        <button disabled={busy} onClick={() => run(async () => {
          await meadow.setRoomSettings({ agent, room: room.room, guard, notify });
          if (note !== (room.note?.text ?? '')) await meadow.setNote({ agent, kind: 'room', about: room.room, text: note });
          onClose();
        })}>Save</button>
      </div>
    </Dialog>
  );
}
