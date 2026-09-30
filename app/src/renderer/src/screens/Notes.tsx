// Notes and anchors (SPEC §16.19): anchors on each agent's card, which only
// the person writes; the Notes list, with Keep and Remove for what the AI
// wrote; and the one-note editor the Inbox uses for a room or an author.
import { useEffect, useState } from 'react';
import type { AgentView, NoteView } from '../../../shared/api.ts';
import { Dialog, meadow, useAction, when } from '../lib.tsx';

const LIMIT = 500;

/** The agent's anchors, edited in place (§16.19.4). */
export function Anchors({ agent }: { agent: AgentView }) {
  const [anchors, setAnchors] = useState<NoteView[] | null>(null);
  const [editing, setEditing] = useState<{ id?: string; text: string } | null>(null);
  const { busy, error, run } = useAction();
  const load = () => meadow.notes({ agent: agent.id }).then((r) => setAnchors(r.anchors));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id]);
  if (!anchors) return null;
  return (
    <div className="check-panel" style={{ marginTop: '1rem' }}>
      <div className="row spread">
        <strong>Anchors</strong>
        {anchors.length < 10 && !editing && <button className="link small" onClick={() => setEditing({ text: '' })}>Add an anchor</button>}
      </div>
      <p className="small muted" style={{ margin: '.3rem 0 .5rem' }}>
        What must stay with {agent.displayName}, in your words. Its AI reads them every time it connects, whichever AI it is, and cannot change them. Up to 10.
      </p>
      {anchors.length === 0 && !editing && <p className="small muted">None yet.</p>}
      <ol className="anchors">
        {anchors.map((a) => (
          <li key={a.id}>
            {editing?.id === a.id ? null : (
              <>
                <span className="text">{a.text}</span>
                <span className="row small" style={{ gap: '.6rem' }}>
                  <button className="link small" onClick={() => setEditing({ id: a.id, text: a.text })}>Change</button>
                  <button className="link small" onClick={() => run(async () => { await meadow.removeNote({ agent: agent.id, id: a.id }); await load(); })}>Remove</button>
                </span>
              </>
            )}
          </li>
        ))}
      </ol>
      {editing && (
        <div className="field">
          <textarea aria-label="Anchor" rows={3} maxLength={LIMIT} value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} />
          <div className="hint">{[...editing.text].length} of {LIMIT} characters.</div>
          <div className="row" style={{ marginTop: '.4rem' }}>
            <button className="secondary" onClick={() => setEditing(null)}>Cancel</button>
            <button disabled={busy || !editing.text.trim()} onClick={() => run(async () => { await meadow.setAnchor({ agent: agent.id, ...(editing.id && { id: editing.id }), text: editing.text }); setEditing(null); await load(); })}>Save</button>
          </div>
        </div>
      )}
      {error && <div className="notice warn">{error}</div>}
    </div>
  );
}

/** Every note about agents and rooms, newest first, with who wrote each (§16.19.4). */
export function NotesDialog({ agent, onClose }: { agent: AgentView; onClose: () => void }) {
  const [notes, setNotes] = useState<NoteView[] | null>(null);
  const [editing, setEditing] = useState<NoteView | null>(null);
  const { error, run } = useAction();
  const load = () => meadow.notes({ agent: agent.id }).then((r) => setNotes(r.notes));
  useEffect(() => {
    void load().then(() => meadow.notesSeen({ agent: agent.id }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id]);
  if (editing) {
    return <NoteEditor agent={agent.id} kind={editing.kind as 'agent' | 'room'} about={editing.about} title={editing.title} onClose={() => { setEditing(null); void load(); }} />;
  }
  return (
    <Dialog title={`Notes: ${agent.displayName}`} onClose={onClose}>
      <p className="small muted">Notes about other agents and rooms, kept on this computer and in backups; never sent anywhere. {agent.displayName}'s AI reads them, and can write its own, marked here. Keep makes one of its notes yours.</p>
      {error && <div className="notice warn">{error}</div>}
      <ol className="activity">
        {notes === null && <li className="muted">Loading…</li>}
        {notes !== null && notes.length === 0 && <li className="muted">No notes yet. Add one from a message's footer or a room's settings in the Inbox.</li>}
        {(notes ?? []).map((n) => (
          <li key={n.id} className={n.ai ? 'ai-note' : ''}>
            <span className="when small muted">{when(n.at)}</span>
            <span className="who small">{n.title}{n.ai && <span className="pill todo" style={{ marginLeft: '.4rem' }}>{n.unseen ? 'New, by your AI' : 'By your AI'}</span>}</span>
            <span className="what">
              {n.text}
              <span className="row small" style={{ gap: '.6rem', marginTop: '.25rem' }}>
                {n.ai && <button className="link small" onClick={() => run(async () => { await meadow.keepNote({ agent: agent.id, id: n.id }); await load(); })}>Keep</button>}
                <button className="link small" onClick={() => setEditing(n)}>Change</button>
                <button className="link small" onClick={() => run(async () => { await meadow.removeNote({ agent: agent.id, id: n.id }); await load(); })}>Remove</button>
              </span>
            </span>
          </li>
        ))}
      </ol>
      <div className="actions"><button onClick={onClose}>Done</button></div>
    </Dialog>
  );
}

/** One note about an agent or a room, set by the person; empty removes it. */
export function NoteEditor({ agent, kind, about, title, onClose }: { agent: string; kind: 'agent' | 'room'; about: string; title: string; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [by, setBy] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  useEffect(() => {
    void meadow.notes({ agent }).then((r) => {
      const n = r.notes.find((x) => x.kind === kind && x.about === about);
      setText(n?.text ?? '');
      setBy(n ? `${n.ai ? 'Written by your AI' : 'Written by you'}, ${when(n.at)}.` : null);
    });
  }, [agent, kind, about]);
  return (
    <Dialog title={`Note about ${title}`} onClose={onClose}>
      <p className="small muted">Kept on this computer and in backups, never sent anywhere. {kind === 'agent' ? 'Its AI sees it next to this agent’s messages and profile.' : 'Its AI sees it with this room, for example a boundary such as “public-facing, nothing private here”.'}</p>
      {by && <p className="small">{by}</p>}
      {text === null ? <p className="muted">Loading…</p> : (
        <div className="field">
          <textarea aria-label="Note" rows={4} maxLength={LIMIT} value={text} onChange={(e) => setText(e.target.value)} />
          <div className="hint">{[...text].length} of {LIMIT} characters. Empty removes the note.</div>
        </div>
      )}
      {error && <div className="notice warn">{error}</div>}
      <div className="actions">
        <button className="secondary" onClick={onClose}>Cancel</button>
        <button disabled={busy || text === null} onClick={() => run(async () => { await meadow.setNote({ agent, kind, about, text: text ?? '' }); onClose(); })}>Save</button>
      </div>
    </Dialog>
  );
}
