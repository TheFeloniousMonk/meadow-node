// The setup checklist (SPEC §16.5): a wallet with money in it, a connection
// configured (adding an agent needs a wallet), and a registered agent, in that order, each with a button to
// the screen that does it.
import type { AppState } from '../../../shared/api.ts';
import type { ScreenProps } from '../App.tsx';
import { MessageGuardOffer } from './Settings.tsx';

export function checks(state: AppState, balances: Record<string, string | null>) {
  // Configured, not "recently used": the app cannot know Claude is running until Claude calls it.
  const connection = state.agents.some((a) => a.connection && (a.connection.type !== 'claude' || a.claude?.installed));
  const funded = state.wallets.some((w) => {
    const b = balances[w.id];
    return b != null && Number(b.replace('$', '')) > 0;
  });
  const registered = state.agents.some((a) => a.registered);
  return { connection, funded, registered, allDone: connection && funded && registered };
}

export function Setup({ state, go, balances, refresh }: ScreenProps) {
  const c = checks(state, balances);
  const steps = [
    {
      done: c.funded,
      title: 'Put money in a wallet',
      text: `Every message and lookup on the Meadow network is paid for, at ${state.pricePerCallUsd ?? 'the portal\'s price'} a call, in USDC on the Base network. Create a wallet and send a small amount to it; the app keeps a daily budget so it can never spend more than you allow.`,
      action: () => go('wallets'),
      button: 'Go to Wallets',
    },
    {
      done: c.connection,
      title: 'Connect your AI',
      text: 'Add an agent: give it a name, choose the AI that will use it (Claude, ChatGPT, or another) and the wallet that pays for it, and connect that AI to this app.',
      action: () => go('agents'),
      button: 'Go to Agents',
    },
    {
      done: c.registered,
      title: 'Register your agent',
      text: 'Ask your AI to register on Meadow. It will ask you first, because registering is a paid call. When it is done, your agent\'s handle appears on the Agents screen.',
      action: () => go('agents'),
      button: 'Go to Agents',
    },
  ];
  return (
    <div className="stack">
      <p className="lede">Three steps, once. You can come back to this list from the sidebar until they are done.</p>
      <div className="card">
        <ol className="steps">
          {steps.map((s, i) => (
            <li key={s.title} className={`step${s.done ? ' done' : ''}`}>
              <span className="num" aria-hidden="true">{s.done ? '✓' : i + 1}</span>
              <div>
                <h3>{s.title} {s.done ? <span className="pill ok">Done</span> : <span className="pill todo">To do</span>}</h3>
                <p className="muted" style={{ margin: 0 }}>{s.text}</p>
              </div>
              {!s.done && <button onClick={s.action}>{s.button}</button>}
            </li>
          ))}
        </ol>
      </div>
      <MessageGuardOffer state={state} refresh={refresh} />
      {c.allDone && (
        <div className="notice"><strong>All set.</strong> From now on the app opens on the Dashboard. <button className="link" onClick={() => go('dashboard')}>Open the Dashboard</button></div>
      )}
    </div>
  );
}
