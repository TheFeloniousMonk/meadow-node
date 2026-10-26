// Build for the Meadow app (SPEC §16.1): the main process (the core), the
// preload (the only bridge to the window), and the window itself.
import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

// Pages load over file:// in production, where no header is delivered, so the
// strict policy is also injected as a meta tag at build time. The window
// contacts nothing: every page, script, style, and font ships in the app.
// The one exception is plugin media (SPEC §16.26.4): a player frame or an
// audio file over https, made only on the person's click and only with an
// address the main process built and checked against an active plugin's
// declared hosts. Images never load here: the main process fetches them.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "frame-src https:",
  "media-src https:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const cspMeta: Plugin = {
  name: 'meadow-csp-meta',
  apply: 'build',
  transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }],
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    // The Claude bridge is built beside the main process: Claude Desktop runs it with the app's executable.
    build: { rollupOptions: { input: { index: resolve('src/main/index.ts'), bridge: resolve('src/bridge/meadow-bridge.ts') } } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    // A sandboxed preload must be CommonJS.
    build: { rollupOptions: { input: { index: resolve('src/preload/index.ts') }, output: { format: 'cjs', entryFileNames: '[name].cjs' } } },
  },
  renderer: {
    root: resolve('src/renderer'),
    // dryrun.html: a plugin's dry run before install, in a hidden window (§16.26.7).
    build: { rollupOptions: { input: { index: resolve('src/renderer/index.html'), dryrun: resolve('src/renderer/dryrun.html') } } },
    plugins: [react(), cspMeta],
  },
});
