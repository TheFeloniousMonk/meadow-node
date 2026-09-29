// The Meadow app's main process (SPEC §16.1): one instance, the core
// services, the loopback interfaces, background sync, the window, and the
// tray. Closing the window keeps the app running in the tray, so messages keep
// arriving and the AI's tools keep working; Quit is in the tray menu.
//
// Development only (refused in a packaged app):
//   --data=<dir>          use another data folder
//   --screenshot=<file>   open on --route=<screen>, capture the window, and exit
// Always:
//   --hidden              start in the tray (how start-at-login opens it)

import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, shell, Tray } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { masterKey } from './master-key.ts';
import { Services } from '../app/services.ts';
import { createHandlers } from '../app/handlers.ts';
import { CHANNELS } from '../shared/api.ts';

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const dev = !app.isPackaged;
const screenshot = dev ? arg('screenshot') : undefined;
const route = dev ? arg('route') : undefined;
const hidden = process.argv.includes('--hidden');
if (dev && arg('data')) app.setPath('userData', resolve(arg('data')!));
const resources = join(import.meta.dirname, '../../resources');

app.setAppUserModelId('com.meadowprotocol.app'); // Windows: notifications show as Meadow

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let services: Services | null = null;
let quitting = false;
const changed = () => {
  if (win && !win.isDestroyed()) win.webContents.send('meadow:changed');
};

async function createWindow(): Promise<BrowserWindow> {
  const theme = services!.settings().theme;
  const w = new BrowserWindow({
    width: 1240, height: 860, minWidth: 900, minHeight: 640, show: false,
    title: 'Meadow',
    icon: join(resources, 'icon.png'),
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
  // Closing hides the window; the app keeps running in the tray.
  w.on('close', (e) => {
    if (quitting || screenshot) return;
    e.preventDefault();
    w.hide();
    const told = services!.db.prepare("SELECT 1 FROM meta WHERE key = 'told_tray'").get();
    if (!told && Notification.isSupported()) {
      new Notification({ title: 'Meadow is still running', body: 'It keeps receiving messages in the background. Open or quit it from its icon near the clock.', icon: join(resources, 'icon.png') }).show();
      services!.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('told_tray', '1')").run();
    }
  });
  if (!hidden || screenshot) w.once('ready-to-show', () => w.show());
  const query = route ? `?route=${encodeURIComponent(route)}` : '';
  if (dev && process.env.ELECTRON_RENDERER_URL) await w.loadURL(process.env.ELECTRON_RENDERER_URL + query);
  else await w.loadFile(join(import.meta.dirname, '../renderer/index.html'), { search: query });
  return w;
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  const image = nativeImage.createFromPath(join(resources, 'tray.png'));
  image.addRepresentation({ scaleFactor: 2, buffer: readFileSync(join(resources, 'tray@2x.png')) });
  tray = new Tray(image);
  tray.setToolTip('Meadow');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Meadow', click: showWindow },
    { label: 'Check for messages now', click: () => void services?.syncAll() },
    { type: 'separator' },
    { label: 'Quit Meadow', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

/** A system notification when new messages arrive (§16.14); clicking it opens the window. */
function notify(_agent: string, name: string, count: number, held: number) {
  if (!Notification.isSupported() || (win?.isVisible() && win.isFocused())) return;
  const body = `${count} new message${count === 1 ? '' : 's'}${held ? `, ${held} kept aside by MessageGuard for you to look at` : ''}.`;
  const n = new Notification({ title: `${name} on Meadow`, body, icon: join(resources, 'icon.png') });
  n.on('click', showWindow);
  n.show();
}

/** A ChatGPT connection request waits for the person (§16.7.2): bring the window forward, and say so. */
function askApproval() {
  showWindow();
  if (Notification.isSupported()) {
    const n = new Notification({ title: 'ChatGPT wants to connect to Meadow', body: 'Check the code and approve or refuse in the Meadow window.', icon: join(resources, 'icon.png') });
    n.on('click', showWindow);
    n.show();
  }
}

const gotLock = screenshot ? true : app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', showWindow);

  app.whenReady().then(async () => {
    try {
      const dir = app.getPath('userData');
      services = new Services({ dbPath: join(dir, 'meadow.db'), masterKey: masterKey(dir), version: app.getVersion(), changed, notify, askApproval });
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
      saveFile: async (defaultName, data) => {
        const r = await dialog.showSaveDialog(win!, { title: 'Save the backup', defaultPath: join(app.getPath('documents'), defaultName), filters: [{ name: 'Meadow backup', extensions: ['meadow-backup'] }] });
        if (r.canceled || !r.filePath) return null;
        writeFileSync(r.filePath, data);
        return r.filePath;
      },
      openFile: async () => {
        const r = await dialog.showOpenDialog(win!, { title: 'Choose a backup', properties: ['openFile'], filters: [{ name: 'Meadow backup', extensions: ['meadow-backup'] }] });
        if (r.canceled || !r.filePaths[0]) return null;
        return { name: basename(r.filePaths[0]), data: readFileSync(r.filePaths[0]) };
      },
      applySettings: (s) => {
        if (!dev) app.setLoginItemSettings({ openAtLogin: s.startAtLogin, args: ['--hidden'] });
      },
    });
    for (const c of CHANNELS) ipcMain.handle(`meadow:${c}`, (_e, arg) => handle(c, arg));
    await services.catalog.refresh().catch(() => {});
    await services.listen();
    if (!screenshot) await services.listenPublic();
    services.schedule();
    if (!screenshot) createTray();
    win = await createWindow();

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

  app.on('before-quit', () => {
    quitting = true;
  });
  // The window only hides; the app ends from the tray's Quit (or the system shutting down).
  app.on('window-all-closed', () => {});
  app.on('will-quit', () => services?.stop());
}
