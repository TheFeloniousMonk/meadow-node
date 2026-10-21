// How the bridge starts the app when it is not running (MEADOW_APP). A
// released app starts as it is. A development Electron (the one under the
// app's node_modules/electron/dist) opens its empty default window unless it
// is given the app's folder, so it gets "." with that folder as its working
// directory.

export function launchOf(app: string): { args: string[]; cwd?: string } {
  const dev = /^(.*)[\\/]node_modules[\\/]electron[\\/]dist[\\/]/.exec(app);
  return dev ? { args: ['.'], cwd: dev[1] } : { args: [] };
}
