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
export function useBalances(deps: unknown[] = []): Record<string, string | null> {
  const [b, setB] = useState<Record<string, string | null>>({});
  useEffect(() => {
    let live = true;
    meadow.balances().then((v) => live && setB(v)).catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return b;
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

/** Syncs per day and what they cost, from the live price (§16.8). */
export function dailySyncCost(minutes: number, price: string | null): string | null {
  if (!price) return null;
  const per = Number(price.replace('$', ''));
  const n = Math.ceil((24 * 60) / minutes);
  return `${n} syncs a day, about $${(n * per).toFixed(2)} a day per agent`;
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
