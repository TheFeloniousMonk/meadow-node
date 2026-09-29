// Renders resources/icon.svg (the meadowprotocol.com mark) to the PNGs the
// tray, notifications, and window use. Development only; run when the mark changes:
//   electron scripts/make-icons.ts
import { app, BrowserWindow } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const res = join(import.meta.dirname, '..', 'resources');
const svg = readFileSync(join(res, 'icon.svg'), 'utf8');
app.whenReady().then(async () => {
  const size = 256;
  const w = new BrowserWindow({ width: size, height: size, show: false, transparent: true, frame: false, useContentSize: true, webPreferences: { offscreen: true } });
  const html = `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`;
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 400));
  const img = await w.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  // The window and notifications use 256 px; the tray, 32 px and 64 px for high-density screens.
  for (const [file, px] of [['icon.png', 256], ['tray.png', 32], ['tray@2x.png', 64]] as const) {
    writeFileSync(join(res, file), img.resize({ width: px, height: px, quality: 'best' }).toPNG());
    console.log(file, px);
  }
  app.exit(0);
});
