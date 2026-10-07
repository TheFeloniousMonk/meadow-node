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
import { Troubleshoot } from './screens/Troubleshoot.tsx';

export type Route = 'setup' | 'dashboard' | 'inbox' | 'agents' | 'wallets' | 'settings' | 'troubleshoot';
/** What to open on arrival, for Troubleshoot's buttons (§16.21): the screen's own dialog, for one agent or wallet. */
export interface Intent {
  open?: 'topOff' | 'budget' | 'backup' | 'chatgpt' | 'claude' | 'chooseWallet' | 'alumni';
  agent?: string;
  wallet?: string;
}
export type Go = (r: Route, intent?: Intent) => void;

const ICONS: Record<string, string> = {
  setup: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  dashboard: 'M3 13h8V3H3zm10 8h8V11h-8zM3 21h8v-6H3zm10-18v6h8V3z',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
  agents: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm14 10v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  wallets: 'M21 12V7H5a2 2 0 0 1 0-4h14v4M3 5v14a2 2 0 0 0 2 2h16v-5M18 12a2 2 0 0 0 0 4h4v-4z',
  troubleshoot: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
};

function Icon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

const LABELS: Record<Route, string> = { setup: 'Setup', dashboard: 'Dashboard', inbox: 'Inbox', agents: 'Agents', wallets: 'Wallets', settings: 'Settings', troubleshoot: 'Troubleshoot' };

export function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}

function Shell() {
  const [state, refresh, error] = useAppState();
  const bal = useBalances([state?.wallets.length, state?.payments[0]?.at]);
  const balances = bal.values;
  const asked = new URLSearchParams(location.search).get('route') as Route | null;
  const [route, setRoute] = useState<Route | null>(asked);
  const [intent, setIntent] = useState<Intent | null>(null);
  const go: Go = (r, i) => {
    setIntent(i ?? null);
    setRoute(r);
  };
  const status = useMemo(() => (state ? checks(state, balances) : null), [state, balances]);

  // Open on the Dashboard when setup is complete, else on the checklist (§16.5). "Funded" needs a
  // balance read from Base, which takes a moment: decide once it is in, or after 4 s (offline).
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setWaited(true), 4000);
    return () => window.clearTimeout(t);
  }, []);
  const balancesKnown = bal.at !== null || waited || state?.wallets.length === 0;
  useEffect(() => {
    if (!route && status && balancesKnown) setRoute(status.allDone ? 'dashboard' : 'setup');
  }, [route, status, balancesKnown]);

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
  const props = { state, refresh, go, balances, balancesAt: bal.at, reloadBalances: bal.reload, intent, clearIntent: () => setIntent(null) };
  const blocked = state.troubleshoot.verdict.state === 'bad';

  return (
    <div className="app">
      <nav className="sidebar" aria-label="Main">
        <div className="brand"><img src={logo} alt="" /><span>meadow</span></div>
        {nav.map((r) => (
          <button key={r} className="nav" aria-current={route === r ? 'page' : undefined} onClick={() => go(r)}>
            <Icon name={r} />
            {LABELS[r]}
            {r === 'inbox' && unread > 0 && <span className="count" aria-label={`${unread} unread`}>{unread}</span>}
          </button>
        ))}
        {/* Set apart at the bottom (§16.21.1); a red dot only while something blocks, never for amber. */}
        <button className="nav apart" aria-current={route === 'troubleshoot' ? 'page' : undefined} onClick={() => go('troubleshoot')}>
          <Icon name="troubleshoot" />
          {LABELS.troubleshoot}
          {blocked && <span className="dot" aria-label="something is not working" />}
        </button>
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
        {route === 'troubleshoot' && <Troubleshoot {...props} />}
      </main>
    </div>
  );
}

/** A newer release (§16.3): the Scoop command on Windows, the release page elsewhere. */
function UpdateBanner({ state }: { state: AppState }) {
  const u = state.update;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: true; file?: string } | { ok: false; error: string } | null>(null);
  if (!u) return null;
  const update = async () => {
    setBusy(true);
    setResult(await meadow.installUpdate());
    setBusy(false);
  };
  const notes = <button className="link" onClick={() => meadow.openExternal({ url: u.url })}>What's new</button>;
  if (result?.ok && result.file) {
    const mac = /\.zip$/.test(result.file);
    const deb = /\.deb$/.test(result.file);
    return (
      <div className="notice update" role="status">
        <strong>Meadow {u.version} is downloaded and checked</strong> ({result.file}). To install it, quit Meadow from its icon near the clock, then{' '}
        {mac ? 'open the zip and drag the new Meadow into Applications, replacing the old one.' : deb ? <>run <code>sudo apt install ./meadow_amd64.deb</code> in that folder.</> : 'make the new AppImage executable and run it instead of the old one.'}{' '}
        Your agents, wallets, and settings stay as they are.
      </div>
    );
  }
  return (
    <div className="notice update" role="status">
      <strong>Meadow {u.version} is available.</strong>{' '}
      {u.action === 'scoop' && <>Meadow closes, updates, and opens again. </>}
      {u.action === 'download' && <>The app downloads it and checks it; you install it in one step. </>}
      {u.action === 'none' ? (
        <button className="link" onClick={() => meadow.openExternal({ url: u.url })}>Download it from the releases page.</button>
      ) : (
        <button disabled={busy || (result?.ok ?? false)} onClick={update}>{busy ? (u.action === 'scoop' ? 'Starting…' : 'Downloading…') : 'Update now'}</button>
      )}{' '}
      {notes}
      {result && !result.ok && <div className="small" style={{ marginTop: '.4rem' }}>{result.error}</div>}
    </div>
  );
}

export interface ScreenProps {
  state: AppState;
  refresh: () => Promise<void>;
  go: Go;
  balances: Record<string, string | null>;
  /** When the balances were last read, and a way to read them again now (§16.10.4). */
  balancesAt: number | null;
  reloadBalances: (fresh?: boolean) => Promise<void>;
  /** What to open on arrival (from Troubleshoot), and how to say it was handled. */
  intent?: Intent | null;
  clearIntent?: () => void;
}
