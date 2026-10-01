// Troubleshoot (SPEC §16.21): every piece the app depends on, in the order they
// depend on each other, with the first one that blocks named at the top and the
// button that fixes it. The checks themselves are free; Sync now is the only
// paid button, and it shows its price.
import { useEffect, useState } from 'react';
import type { TroubleAction, TroubleItem, TroubleState } from '../../../shared/api.ts';
import type { ScreenProps } from '../App.tsx';
import { meadow, time, useAction, useToast, when } from '../lib.tsx';
import { DiagnosticsDialog } from './Check.tsx';

const MARK: Record<TroubleState, string> = { ok: 'ok', warn: 'todo', bad: 'warn', info: 'info' };
const WORD: Record<TroubleState, string> = { ok: 'Working', warn: 'Needs a look', bad: 'Not working', info: 'Your choice' };

export function Troubleshoot({ state, refresh, go }: ScreenProps) {
  const t = state.troubleshoot;
  const [exporting, setExporting] = useState(false);
  const [results, setResults] = useState<Record<string, { ok: boolean; text: string }>>({});
  const checking = useAction();
  const acting = useAction();
  const toast = useToast();

  // Opening the screen runs the outside checks (at most once a minute; the core decides).
  useEffect(() => {
    void meadow.troubleshootRun({}).then(refresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const again = () => checking.run(async () => {
    await meadow.troubleshootRun({ again: true });
    await refresh();
  });

  const act = (key: string, a: TroubleAction) => acting.run(async () => {
    if (!('run' in a)) return go(a.go, { open: a.open, agent: a.agent, wallet: a.wallet });
    let r: { ok: boolean; text: string } | null = null;
    if (a.run === 'syncNow' && a.agent) {
      const s = await meadow.syncNow({ agent: a.agent });
      r = { ok: s.ok, text: s.ok ? `Synced. ${s.message}` : s.message };
    } else if (a.run === 'restartTunnel') {
      r = await meadow.restartTunnel();
    } else if (a.run === 'startAtLogin') {
      await meadow.setSettings({ startAtLogin: true });
      toast('Meadow now starts with this computer');
    } else if (a.run === 'updateNow') {
      const u = await meadow.installUpdate();
      r = u.ok ? { ok: true, text: u.file ? `Downloaded and checked: ${u.file}. Quit Meadow, then install it.` : 'Meadow closes, updates, and opens again.' } : { ok: false, text: u.error };
    }
    if (r) setResults((x) => ({ ...x, [key]: r! }));
    await meadow.troubleshootRun({ again: a.run === 'restartTunnel' });
    await refresh();
  });

  const button = (key: string, a: TroubleAction, primary = false) => (
    <button className={primary ? undefined : 'secondary'} disabled={acting.busy} onClick={() => void act(key, a)}>{a.label}</button>
  );

  return (
    <div className="stack">
      <p className="lede">Everything Meadow depends on, checked in order. Checking is free; nothing here makes a paid call except Sync now, which shows its price.</p>

      <div className={`notice${t.verdict.state === 'bad' ? ' warn' : ''}`} role="status">
        <div className="row spread">
          <div className="row" style={{ gap: '.6rem' }}>
            <span className={`status ${t.verdict.state === 'bad' ? 'warn' : 'ok'}`}>{t.verdict.state === 'bad' ? 'Not working' : 'Working'}</span>
            <strong>{t.verdict.text}</strong>
          </div>
          {t.verdict.action && button('verdict', t.verdict.action, true)}
        </div>
        {t.verdict.more > 0 && <div className="small" style={{ marginTop: '.4rem' }}>And {t.verdict.more} more {t.verdict.more === 1 ? 'thing' : 'things'} below. Fixing the first often fixes the rest.</div>}
        {results.verdict && <div className="small" style={{ marginTop: '.4rem' }}>{results.verdict.text}</div>}
      </div>

      <div className="row">
        <button className="secondary" disabled={checking.busy || t.outside.checking} onClick={() => void again()}>{checking.busy || t.outside.checking ? 'Checking…' : 'Check again'}</button>
        <span className="small muted">{t.outside.checking ? 'Checking balances and the ChatGPT address…' : t.outside.at ? `Outside checks at ${time(t.outside.at)}` : 'Outside checks not run yet'}</span>
        <button className="secondary" onClick={() => setExporting(true)}>Export diagnostics</button>
      </div>
      {(acting.error || checking.error) && <div className="notice warn">{acting.error ?? checking.error}</div>}

      {t.groups.filter((g) => g.items.length).map((g) => (
        <div key={g.agent ?? g.title} className="card">
          <h2 style={{ marginTop: 0 }}>{g.title}</h2>
          <ol className="steps trouble">
            {g.items.map((i: TroubleItem) => {
              const key = `${g.agent ?? g.title}:${i.key}`;
              return (
                <li key={key}>
                  <span className={`status ${MARK[i.state]}`}>{WORD[i.state]}</span>
                  <span className="what">
                    <strong>{i.label}.</strong> {i.text}{i.at ? ` ${when(i.at)}.` : ''}
                    {i.fix && i.state !== 'ok' && <span className="small muted"> {i.fix}</span>}
                    {results[key] && <span className={`small${results[key].ok ? '' : ' warn-text'}`}> {results[key].text}</span>}
                  </span>
                  {i.action && <span className="act">{button(key, i.action)}</span>}
                </li>
              );
            })}
          </ol>
        </div>
      ))}

      <p className="small muted">This screen cannot see your AI's own side: whether ChatGPT still lists the Meadow app, whether a chat has it turned on, or whether Claude Desktop is open. Ask your AI to check your Meadow status. It is free, and it tries the whole way.</p>
      {exporting && <DiagnosticsDialog onClose={() => setExporting(false)} />}
    </div>
  );
}
