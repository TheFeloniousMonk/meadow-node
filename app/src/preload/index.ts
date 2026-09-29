// The only bridge between the window and the core (SPEC §16.1): one function
// per fixed channel, and a notification when state changes. No require, no
// generic invoke.
import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, type Api, type Channel } from '../shared/api.ts';

type Remote = { [K in Channel]: (arg?: Parameters<Api[K]>[0]) => Promise<ReturnType<Api[K]>> };

const api = Object.fromEntries(
  CHANNELS.map((c) => [c, async (arg?: unknown) => {
    const r = await ipcRenderer.invoke(`meadow:${c}`, arg ?? {});
    if (r && typeof r === 'object' && 'error' in r && Object.keys(r).length === 1) throw new Error(r.error);
    return r;
  }]),
) as Remote;

contextBridge.exposeInMainWorld('meadow', {
  ...api,
  onChanged: (fn: () => void) => {
    const listener = () => fn();
    ipcRenderer.on('meadow:changed', listener);
    return () => ipcRenderer.removeListener('meadow:changed', listener);
  },
});

export type MeadowBridge = Remote & { onChanged(fn: () => void): () => void };
