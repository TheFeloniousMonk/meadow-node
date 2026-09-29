// The window (SPEC §16.10): a sidebar on every screen, the theme switch in the
// header, and the setup checklist until the three startup checks hold (§16.5).
import { useEffect, useMemo, useState } from 'react';
import logo from './logo.svg';
import { ToastProvider, meadow, useAppState, useBalances } from './lib.tsx';
import type { AppState } from '../../shared/api.ts';
import { Setup, checks } from './screens/Setup.tsx';
import { Dashboard } from './screens/Dashboard.tsx';
import { Inbox } from './screens/Inbox.tsx';
import { Agents } from './screens/Agents.tsx';
import { Wallets } from './screens/Wallets.tsx';
import { SettingsScreen } from './screens/Settings.tsx';

export type Route = 'setup' | 'dashboard' | 'inbox' | 'agents' | 'wallets' | 'settings';
export type Go = (r: Route) => void;

const ICONS: Record<string, string> = {
  setup: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  dashboard: 'M3 13h8V3H3zm10 8h8V11h-8zM3 21h8v-6H3zm10-18v6h8V3z',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
  agents: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm14 10v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  wallets: 'M21 12V7H5a2 2 0 0 1 0-4h14v4M3 5v14a2 2 0 0 0 2 2h16v-5M18 12a2 2 0 0 0 0 4h4v-4z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
};

function Icon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

const LABELS: Record<Route, string> = { setup: 'Setup', dashboard: 'Dashboard', inbox: 'Inbox', agents: 'Agents', wallets: 'Wallets', settings: 'Settings' };

export function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}

function Shell() {
  const [state, refresh, error] = useAppState();
  const balances = useBalances([state?.wallets.length, state?.payments[0]?.at]);
  const asked = new URLSearchParams(location.search).get('route') as Route | null;
  const [route, setRoute] = useState<Route | null>(asked);
  const status = useMemo(() => (state ? checks(state, balances) : null), [state, balances]);

  // Open on the Dashboard when setup is complete, else on the checklist (§16.5).
  useEffect(() => {
    if (!route && status) setRoute(status.allDone ? 'dashboard' : 'setup');
  }, [route, status]);

  useEffect(() => {
    if (!state) return;
    document.documentElement.dataset.theme = state.settings.theme;
    document.documentElement.style.setProperty('--scale', String(state.settings.textScale));
  }, [state?.settings.theme, state?.settings.textScale]);

  if (error) return <div className="content"><div className="notice warn">{error}</div></div>;
  if (!state || !route || !status) return null;

  const unread = state.agents.reduce((n, a) => n + a.unread, 0);
  const nav: Route[] = status.allDone ? ['dashboard', 'inbox', 'agents', 'wallets', 'settings'] : ['setup', 'dashboard', 'inbox', 'agents', 'wallets', 'settings'];
  const toggleTheme = () => meadow.setSettings({ theme: state.settings.theme === 'dark' ? 'light' : 'dark' }).then(refresh);
  const props = { state, refresh, go: setRoute, balances };

  return (
    <div className="app">
      <nav className="sidebar" aria-label="Main">
        <div className="brand"><img src={logo} alt="" /><span>meadow</span></div>
        {nav.map((r) => (
          <button key={r} className="nav" aria-current={route === r ? 'page' : undefined} onClick={() => setRoute(r)}>
            <Icon name={r} />
            {LABELS[r]}
            {r === 'inbox' && unread > 0 && <span className="count" aria-label={`${unread} unread`}>{unread}</span>}
          </button>
        ))}
        <div className="spacer" />
        <div className="foot">Version {state.version}</div>
      </nav>
      <main className="content">
        <header className="pagehead">
          <h1>{LABELS[route]}</h1>
          <button className="secondary icon" onClick={toggleTheme} aria-label="Switch between light and dark">
            {state.settings.theme === 'dark' ? '☀ Light' : '☾ Dark'}
          </button>
        </header>
        <UpdateBanner state={state} />
        {route === 'setup' && <Setup {...props} />}
        {route === 'dashboard' && <Dashboard {...props} />}
        {route === 'inbox' && <Inbox {...props} />}
        {route === 'agents' && <Agents {...props} />}
        {route === 'wallets' && <Wallets {...props} />}
        {route === 'settings' && <SettingsScreen {...props} />}
      </main>
    </div>
  );
}

/** A newer release (§16.3): the Scoop command on Windows, the release page elsewhere. */
function UpdateBanner({ state }: { state: AppState }) {
  const u = state.update;
  if (!u) return null;
  return (
    <div className="notice update" role="status">
      <strong>Meadow {u.version} is available.</strong>{' '}
      {u.command ? (
        <>
          To update, close Meadow from its icon near the clock, then run this in PowerShell:{' '}
          <code>{u.command}</code>{' '}
          <button className="secondary" onClick={() => meadow.copy({ text: u.command! })}>Copy</button>
        </>
      ) : (
        <button className="link" onClick={() => meadow.openExternal({ url: u.url })}>Download it from the releases page.</button>
      )}
    </div>
  );
}

export interface ScreenProps {
  state: AppState;
  refresh: () => Promise<void>;
  go: Go;
  balances: Record<string, string | null>;
}
