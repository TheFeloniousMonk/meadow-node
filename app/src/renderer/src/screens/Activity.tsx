// The activity log (SPEC §16.18): what changed for an agent and who caused
// it, newest first, with filters by kind and by who, and an export for the
// person's own records. Above it, what the wallet paid, by cause: built from the
// payment records, so background receiving never floods the log.
import { useEffect, useState } from 'react';
import type { ActivityView, AgentView, SpendingView } from '../../../shared/api.ts';
import { Dialog, meadow, useAction, when } from '../lib.tsx';
import { openRoom } from './Inbox.tsx';

const KINDS: { label: string; kinds: ActivityView['kind'][] | null }[] = [
  { label: 'All', kinds: null },
  { label: 'Rooms and DMs', kinds: ['rooms', 'reports', 'moderation'] },
  { label: 'Messages sent', kinds: ['messages'] },
  { label: 'Received', kinds: ['received'] },
  { label: 'Settings and backups', kinds: ['settings', 'backups', 'profile'] },
  { label: 'Problems', kinds: ['problems'] },
];
const WHO: { label: string; who: ActivityView['who'][] | null }[] = [
  { label: 'Anyone', who: null },
  { label: 'You', who: ['you'] },
  { label: 'Your AI', who: ['claude', 'chatgpt', 'local'] },
  { label: 'The built-in runner', who: ['runner'] },
  { label: 'The network', who: ['network'] },
  { label: 'The app', who: ['app'] },
];

export function ActivityDialog({ agent, onClose, goInbox }: { agent: AgentView; onClose: () => void; goInbox: () => void }) {
  const [entries, setEntries] = useState<ActivityView[] | null>(null);
  const [kind, setKind] = useState(0);
  const [who, setWho] = useState(0);
  const [days, setDays] = useState(0);
  const [saved, setSaved] = useState<string | null>(null);
  const [spendDays, setSpendDays] = useState(1);
  const [spending, setSpending] = useState<SpendingView | null | undefined>(undefined);
  const { busy, error, run } = useAction();
  useEffect(() => {
    void run(async () => setEntries(await meadow.activity({ agent: agent.id })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id]);
  useEffect(() => {
    void run(async () => setSpending(await meadow.activitySpending({ agent: agent.id, days: spendDays })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id, spendDays]);
  const k = KINDS[kind].kinds;
  const w = WHO[who].who;
  const shown = (entries ?? []).filter((e) => (!k || k.includes(e.kind)) && (!w || w.includes(e.who)));
  return (
    <Dialog title={`Activity: ${agent.displayName}`} onClose={onClose}>
      <p className="small muted">What changed for {agent.displayName}, and who did it; not its messages, which are in the Inbox. Kept on this computer for 90 days, and in backups.</p>
      <div className="row" style={{ gap: '.75rem', flexWrap: 'wrap' }}>
        <label className="small" htmlFor="act-kind">Show</label>
        <select id="act-kind" value={kind} onChange={(e) => setKind(Number(e.target.value))} style={{ maxWidth: '14rem' }}>
          {KINDS.map((x, i) => <option key={x.label} value={i}>{x.label}</option>)}
        </select>
        <label className="small" htmlFor="act-who">by</label>
        <select id="act-who" value={who} onChange={(e) => setWho(Number(e.target.value))} style={{ maxWidth: '14rem' }}>
          {WHO.map((x, i) => <option key={x.label} value={i}>{x.label}</option>)}
        </select>
      </div>
      <section className="spending" aria-label="Spending">
        <div className="row" style={{ gap: '.75rem', flexWrap: 'wrap' }}>
          <strong>Spending</strong>
          <select aria-label="Spending period" value={spendDays} onChange={(e) => setSpendDays(Number(e.target.value))} style={{ maxWidth: '12rem' }}>
            <option value={1}>The last 24 hours</option>
            <option value={7}>The last 7 days</option>
            <option value={30}>The last 30 days</option>
          </select>
        </div>
        {spending === undefined && <p className="small muted">Loading…</p>}
        {spending === null && <p className="small muted">No wallet is assigned to {agent.displayName}.</p>}
        {spending && (
          <>
            <p className="small">
              The wallet “{spending.wallet}” paid <strong>{spending.total}</strong>{spending.calls ? `, ${spending.calls} call${spending.calls === 1 ? '' : 's'}` : ''}.
              {spending.calls > 0 && ' Every agent on this wallet shares it:'}
            </p>
            {spending.by.length > 0 && <ul className="small">{spending.by.map((l) => <li key={l}>{l}</li>)}</ul>}
          </>
        )}
      </section>
      {WHO[who].label === 'Your AI' && (
        <p className="notice small" style={{ marginTop: '.6rem' }}>The app knows which connection your AI acted through, not whether you asked for it in your conversation or it decided on its own. Your conversation with it shows that.</p>
      )}
      {error && <div className="notice warn">{error}</div>}
      <ol className="activity">
        {entries === null && <li className="muted">Loading…</li>}
        {entries !== null && shown.length === 0 && <li className="muted">Nothing here yet.</li>}
        {shown.map((e, i) => (
          <li key={`${e.at}-${i}`} className={e.kind === 'problems' ? 'problem' : ''}>
            <span className="when small muted">{when(e.at)}</span>
            <span className="who small">{e.whoWords}</span>
            <span className="what">
              {e.text}
              {e.room && <> <button className="link small" onClick={() => { openRoom(agent.id, e.room!); onClose(); goInbox(); }}>Open in the Inbox</button></>}
            </span>
          </li>
        ))}
      </ol>
      {saved && <p className="notice small">Saved in <span className="mono" style={{ overflowWrap: 'anywhere' }}>{saved}</span>.</p>}
      <div className="actions" style={{ flexWrap: 'wrap' }}>
        <select aria-label="How much to export" value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ maxWidth: '12rem' }}>
          <option value={0}>Everything</option>
          <option value={7}>The last 7 days</option>
          <option value={30}>The last 30 days</option>
        </select>
        <button className="secondary" disabled={busy} onClick={() => run(async () => { const r = await meadow.activitySave({ agent: agent.id, days: days || undefined }); if (r.saved) setSaved(r.saved); })}>Export activity</button>
        <button onClick={onClose}>Done</button>
      </div>
      <p className="small muted" style={{ marginTop: '.5rem' }}>The export is for your own records: it names rooms and other agents, but holds no messages, keys, or passwords.</p>
    </Dialog>
  );
}
