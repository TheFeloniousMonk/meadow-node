// The person's tunnel (SPEC §16.7.2): how ChatGPT, which reaches only remote
// MCP servers over HTTPS, gets to the tunneled interface on this computer. The
// project hosts nothing in between.
//
// - ngrok (the default): the app opens the tunnel itself with ngrok's official
//   SDK and the person's own token. A free ngrok account has one permanent
//   address ngrok assigns (for example something.ngrok-free.app), no time
//   limit, and 20,000 requests a month (ngrok's free plan limits, 2026-09-29).
// - custom (advanced): the person runs their own tunnel, such as a Cloudflare
//   named tunnel to their own domain, pointed at the tunneled interface's
//   port, and tells the app its public address.

export type TunnelProvider = 'none' | 'ngrok' | 'custom';
export interface TunnelStatus {
  provider: TunnelProvider;
  state: 'off' | 'starting' | 'on' | 'error';
  url: string | null;
  error: string | null;
}

type Listener = { url(): string | null; close(): Promise<void> };

export class Tunnel {
  #status: TunnelStatus = { provider: 'none', state: 'off', url: null, error: null };
  #listener: Listener | null = null;
  #changed: () => void;

  constructor(changed: () => void) {
    this.#changed = changed;
  }

  get status(): TunnelStatus {
    return { ...this.#status };
  }

  /** The public address, while the tunnel is up. */
  get url(): string | null {
    return this.#status.state === 'on' ? this.#status.url : null;
  }

  #set(s: Partial<TunnelStatus>) {
    this.#status = { ...this.#status, ...s };
    this.#changed();
  }

  async start({ provider, port, ngrokToken, customUrl }: { provider: TunnelProvider; port: number; ngrokToken?: string | null; customUrl?: string | null }) {
    await this.stop();
    if (provider === 'none') return this.#set({ provider, state: 'off', url: null, error: null });
    if (provider === 'custom') {
      try {
        const u = new URL(customUrl ?? '');
        if (u.protocol !== 'https:') throw new Error();
        return this.#set({ provider, state: 'on', url: `${u.origin}`, error: null });
      } catch {
        return this.#set({ provider, state: 'error', url: null, error: 'Enter your tunnel\'s public address, starting with https://.' });
      }
    }
    if (!ngrokToken) return this.#set({ provider, state: 'error', url: null, error: 'Paste your ngrok authtoken first.' });
    this.#set({ provider, state: 'starting', url: null, error: null });
    try {
      const ngrok = await import('@ngrok/ngrok');
      const listener = await ngrok.forward({ addr: `127.0.0.1:${port}`, authtoken: ngrokToken, proto: 'http' });
      this.#listener = listener as unknown as Listener;
      const url = listener.url();
      if (!url) throw new Error('ngrok gave no address');
      this.#set({ state: 'on', url: url.replace(/\/+$/, ''), error: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#set({ state: 'error', url: null, error: /authtoken|authentication|ERR_NGROK_10[57]/i.test(message) ? 'ngrok did not accept the token. Copy it again from your ngrok dashboard.' : `ngrok could not start: ${message}` });
    }
  }

  async stop() {
    const l = this.#listener;
    this.#listener = null;
    if (l) await l.close().catch(() => {});
  }
}
