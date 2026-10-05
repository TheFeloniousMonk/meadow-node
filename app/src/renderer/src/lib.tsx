// Shared pieces of the window: the core's state, a toast, a dialog, and small formatters.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AppState } from '../../shared/api.ts';

export const meadow = window.meadow;

/** The core's state, refreshed whenever the core says it changed, and on demand. */
export function useAppState(): [AppState | null, () => Promise<void>, string | null] {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setState(await meadow.state());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
    return meadow.onChanged(() => void refresh());
  }, [refresh]);
  return [state, refresh, error];
}

/** Wallet balances from Base, read by the core (cached for a minute). */
/**
 * Wallet balances, read from Base: when `deps` change, every minute while the
 * app is open (a deposit changes nothing else the window watches), and at once
 * on reload(true), the Wallets screen's Refresh.
 */
export function useBalances(deps: unknown[] = []): { values: Record<string, string | null>; at: number | null; reload: (fresh?: boolean) => Promise<void> } {
  const [b, setB] = useState<{ values: Record<string, string | null>; at: number | null }>({ values: {}, at: null });
  const reload = useCallback(async (fresh = false) => {
    const values = await meadow.balances({ fresh });
    setB({ values, at: Date.now() });
  }, []);
  useEffect(() => {
    void reload().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    const t = window.setInterval(() => void reload().catch(() => {}), 60_000);
    return () => window.clearInterval(t);
  }, [reload]);
  return { ...b, reload };
}

const ToastContext = createContext<(text: string) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [text, setText] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const show = useCallback((t: string) => {
    setText(t);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setText(null), 2200);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      {text && <div className="toast" role="status">{text}</div>}
    </ToastContext.Provider>
  );
}
export const useToast = () => useContext(ToastContext);

/** Copies through the core (the system clipboard), then says so. */
export function useCopy() {
  const toast = useToast();
  return async (text: string, what = 'Copied') => {
    await meadow.copy({ text });
    toast(what);
  };
}

export function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose?: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'never');
export const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * Whether any one payer pays for two or more registered agents: the alumni club for all of them, or
 * one wallet for its own. Those agents are always checked together, up to 8 in a call (§7.9, §16.8).
 */
export function agentsSharePayer(state: AppState): boolean {
  const agents = state.agents.filter((a) => a.registered);
  if (state.alumni.active) return agents.length > 1;
  const per = new Map<string, number>();
  for (const a of agents) if (a.walletId) per.set(a.walletId, (per.get(a.walletId) ?? 0) + 1);
  return [...per.values()].some((n) => n > 1);
}

/** Syncs per day and what they cost, from the live price (§16.8). */
export function dailySyncCost(minutes: number, price: string | null, combined = false): string | null {
  if (!price) return null;
  const per = Number(price.replace('$', ''));
  const n = Math.ceil((24 * 60) / minutes);
  return `${n} syncs a day, about $${(n * per).toFixed(2)} a day ${combined ? 'for up to 8 agents together' : 'per agent'}`;
}

const CLUB_TIP = 'Your alumni club membership sets this. It changes back when the membership ends.';

/** An info mark with a tooltip that shows on hover and on keyboard focus. */
export function InfoTip({ text }: { text: string }) {
  return <span className="info" tabIndex={0} role="note" aria-label={text} data-tip={text}>i</span>;
}

/**
 * "Set by Alumni status" (SPEC §18.8): beside a setting the alumni membership fixes while it is
 * active. The link opens the membership in Settings; the mark says why the setting is greyed.
 */
export function ClubSet({ go }: { go: (r: 'settings', i: { open: 'alumni' }) => void }) {
  return (
    <span className="club-set">
      <button className="link small" onClick={() => go('settings', { open: 'alumni' })}>Set by Alumni status</button>
      <InfoTip text={CLUB_TIP} />
    </span>
  );
}

/** Runs an action and turns a failure into a message for the person. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}
