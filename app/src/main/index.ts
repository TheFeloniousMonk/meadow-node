// The Meadow app's main process (SPEC §16.1): one instance, the core
// services, the loopback interfaces, background sync, and the window.
//
// Development only (refused in a packaged app):
//   --data=<dir>          use another data folder
//   --screenshot=<file>   open on --route=<screen>, capture the window, and exit

import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { masterKey } from './master-key.ts';
import { dirname, join, resolve } from 'node:path';
import { Services } from '../app/services.ts';
import { createHandlers } from '../app/handlers.ts';
import { CHANNELS } from '../shared/api.ts';

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const dev = !app.isPackaged;
const screenshot = dev ? arg('screenshot') : undefined;
const route = dev ? arg('route') : undefined;
if (dev && arg('data')) app.setPath('userData', resolve(arg('data')!));

let win: BrowserWindow | null = null;
let services: Services | null = null;
const changed = () => {
  if (win && !win.isDestroyed()) win.webContents.send('meadow:changed');
};

async function createWindow(): Promise<BrowserWindow> {
  const theme = services!.settings().theme;
  const w = new BrowserWindow({
    width: 1240, height: 860, minWidth: 900, minHeight: 640, show: false,
    title: 'Meadow',
    backgroundColor: theme === 'dark' ? '#171411' : '#faf7f2',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
      devTools: dev,
    },
  });
  // Nothing in the window navigates away or opens windows; links go through the core's allow-list.
  w.webContents.on('will-navigate', (e, url) => {
    if (!(dev && process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL))) e.preventDefault();
  });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.once('ready-to-show', () => w.show());
  const query = route ? `?route=${encodeURIComponent(route)}` : '';
  if (dev && process.env.ELECTRON_RENDERER_URL) await w.loadURL(process.env.ELECTRON_RENDERER_URL + query);
  else await w.loadFile(join(import.meta.dirname, '../renderer/index.html'), { search: query });
  return w;
}

const gotLock = screenshot ? true : app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      const dir = app.getPath('userData');
      services = new Services({ dbPath: join(dir, 'meadow.db'), masterKey: masterKey(dir), version: app.getVersion(), changed });
    } catch (err) {
      dialog.showErrorBox('Meadow could not start', err instanceof Error ? err.message : String(err));
      app.exit(1);
      return;
    }
    // The first run follows the system's light or dark setting (§16.4).
    if (!services.db.prepare("SELECT 1 FROM meta WHERE key = 'settings'").get()) {
      services.setSettings({ theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light' });
    }
    const handle = createHandlers(services, {
      execPath: process.execPath,
      bridgeScript: join(import.meta.dirname, 'bridge.js'),
      copy: (text) => clipboard.writeText(text),
      openExternal: (url) => void shell.openExternal(url),
    });
    for (const c of CHANNELS) ipcMain.handle(`meadow:${c}`, (_e, arg) => handle(c, arg));
    await services.catalog.refresh().catch(() => {});
    await services.listen();
    services.schedule();
    win = await createWindow();
    win.on('closed', () => (win = null));

    if (screenshot) {
      setTimeout(async () => {
        const image = await win!.webContents.capturePage();
        const out = resolve(screenshot);
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, image.toPNG());
        console.log(`screenshot: ${out} (${image.getSize().width}x${image.getSize().height})`);
        app.exit(0);
      }, 3500);
    }
  });

  app.on('window-all-closed', () => {
    services?.stop();
    app.quit();
  });
}
