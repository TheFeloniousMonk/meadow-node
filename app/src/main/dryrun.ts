// A plugin's dry run (SPEC §16.26.7), in a hidden window: no preload (so no bridge to the app), a
// fresh in-memory session that refuses every request but the app's own files (so no network), no
// popups or navigation. Each case announces itself on the console before it renders; a case that
// runs past its limit, a page over its memory ceiling, or a crash stops the run and names the case.

import { app, BrowserWindow, session } from 'electron';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { DryRunCase } from '../app/plugin-views.ts';

const CASE_LIMIT_MS = 3_000;
const LOAD_LIMIT_MS = 15_000;
const MEMORY_LIMIT_KB = 512 * 1024;

export async function dryRun(cases: DryRunCase[], { dev, rendererUrl }: { dev: boolean; rendererUrl?: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const ses = session.fromPartition(`dryrun-${randomUUID()}`); // no "persist:": in memory, gone after
  const own = (url: string) => url.startsWith('file:') || (dev && !!rendererUrl && url.startsWith(rendererUrl));
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !own(d.url) }));
  const w = new BrowserWindow({
    show: false, width: 900, height: 700,
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false, backgroundThrottling: false, spellcheck: false },
  });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e) => e.preventDefault());

  let current = -1;
  let finish: (r: { ok: true } | { ok: false; error: string }) => void = () => {};
  const result = new Promise<{ ok: true } | { ok: false; error: string }>((r) => (finish = r));
  const name = (i: number) => (cases[i] ? cases[i].label : 'loading the check');
  let timer: NodeJS.Timeout | null = null;
  const arm = (ms: number, why: () => string) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      finish({ ok: false, error: why() });
      if (!w.isDestroyed()) w.webContents.forcefullyCrashRenderer();
    }, ms);
  };
  w.webContents.on('console-message', (e) => {
    const m = /^meadow-dryrun:(\d+|done)$/.exec((e as any).message ?? '');
    if (!m || m[1] === 'done') return;
    current = Number(m[1]);
    arm(CASE_LIMIT_MS, () => `${name(current)}: it took longer than ${CASE_LIMIT_MS / 1000} seconds to show`);
  });
  w.webContents.on('render-process-gone', (_e, d) => finish({ ok: false, error: `${name(current)}: the check window stopped (${d.reason})` }));
  // The memory ceiling: the page's process, looked at four times a second.
  const memory = setInterval(() => {
    if (w.isDestroyed()) return;
    const pid = w.webContents.getOSProcessId();
    const kb = app.getAppMetrics().find((p) => p.pid === pid)?.memory.workingSetSize ?? 0;
    if (kb > MEMORY_LIMIT_KB) {
      finish({ ok: false, error: `${name(current)}: it used more than ${MEMORY_LIMIT_KB / 1024} MB of memory` });
      w.webContents.forcefullyCrashRenderer();
    }
  }, 250);

  try {
    arm(LOAD_LIMIT_MS, () => 'loading the check: the check window did not start');
    if (dev && rendererUrl) await w.loadURL(`${rendererUrl}/dryrun.html`);
    else await w.loadFile(join(import.meta.dirname, '../renderer/dryrun.html'));
    const run = w.webContents.executeJavaScript(`window.__dryrun(${JSON.stringify(cases)})`) as Promise<{ i: number; error: string | null }[]>;
    run.then((rs) => {
      const bad = rs.find((r) => r.error);
      finish(bad ? { ok: false, error: `${name(bad.i)}: ${bad.error}` } : { ok: true });
    }, (e) => finish({ ok: false, error: `${name(current)}: ${(e as Error)?.message ?? 'it failed'}` }));
    return await result;
  } catch (e) {
    finish({ ok: false, error: `${name(current)}: ${(e as Error)?.message ?? 'it failed'}` });
    return await result;
  } finally {
    if (timer) clearTimeout(timer);
    clearInterval(memory);
    if (!w.isDestroyed()) w.destroy();
  }
}
