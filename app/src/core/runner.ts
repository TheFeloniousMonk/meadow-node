// The runner (SPEC §16.7.3): for a model with no host of its own. When a
// sync brings new messages in the rooms the person enabled, the runner gives
// the model the same tools every connection has, and those messages, and lets
// it act: at most MAX_STEPS model calls a run. No person is in that
// conversation, so the tools refuse anything outside the enabled rooms, and
// the wallet's budget is the hard limit. The model's API key is the person's,
// kept sealed; the endpoint is theirs to choose: the Anthropic Messages API,
// or any OpenAI-compatible chat completions API.

import type { Db } from './db.ts';
import type { Vault } from './vault.ts';
import type { Json, ToolHost } from './tools.ts';
import { REPLY_LIMITS, readText } from './deps.ts';

export const MAX_STEPS = 8;
export const MODEL_TIMEOUT_MS = 90_000;
export type Provider = 'anthropic' | 'openai';
export const DEFAULT_ENDPOINTS: Record<Provider, string> = { anthropic: 'https://api.anthropic.com', openai: 'https://api.openai.com/v1' };

export interface RunnerConfig {
  enabled: boolean;
  provider: Provider;
  endpoint: string;
  model: string;
  rooms: string[];
  hasKey: boolean;
}

interface Call {
  id: string;
  name: string;
  input: Json;
}
interface Turn {
  text: string;
  calls: Call[];
}

/** One conversation with a model, in the shape of its API. */
interface Conversation {
  send(): Promise<Turn>;
  results(results: { id: string; content: string; isError: boolean }[]): void;
}

export class Runner {
  #db: Db;
  #vault: Vault;
  #host: ToolHost;
  #fetch: typeof fetch;
  #running = new Set<string>();

  constructor({ db, vault, host, fetchImpl = fetch }: { db: Db; vault: Vault; host: ToolHost; fetchImpl?: typeof fetch }) {
    this.#db = db;
    this.#vault = vault;
    this.#host = host;
    this.#fetch = fetchImpl;
  }

  config(agent: string): RunnerConfig | null {
    const r: any = this.#db.prepare('SELECT * FROM runners WHERE agent = ?').get(agent);
    return r ? { enabled: !!r.enabled, provider: r.provider, endpoint: r.endpoint, model: r.model, rooms: JSON.parse(r.rooms), hasKey: !!r.key_sealed } : null;
  }

  /** Saves the runner's settings. The key is replaced only when a new one is given. */
  configure(agent: string, c: { enabled: boolean; provider: Provider; endpoint?: string; model: string; rooms: string[]; apiKey?: string }) {
    if (!['anthropic', 'openai'].includes(c.provider)) throw new Error('Choose Anthropic or an OpenAI-compatible endpoint.');
    const endpoint = (c.endpoint?.trim() || DEFAULT_ENDPOINTS[c.provider]).replace(/\/+$/, '');
    const u = new URL(endpoint);
    if (u.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new Error('The endpoint must use https, unless it runs on this computer.');
    if (!c.model.trim()) throw new Error('Give the model name.');
    const old: any = this.#db.prepare('SELECT key_sealed FROM runners WHERE agent = ?').get(agent);
    const key = c.apiKey ? this.#vault.seal(`runner:${agent}:key`, c.apiKey) : old?.key_sealed ?? null;
    this.#db.prepare(`INSERT OR REPLACE INTO runners (agent, enabled, provider, endpoint, model, key_sealed, rooms, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(agent, c.enabled ? 1 : 0, c.provider, endpoint, c.model.trim(), key, JSON.stringify(c.rooms), Date.now());
  }

  log(agent: string, limit = 20): { at: number; text: string }[] {
    return this.#db.prepare('SELECT at, text FROM runner_log WHERE agent = ? ORDER BY seq DESC LIMIT ?').all(agent, limit) as any[];
  }

  #note(agent: string, text: string) {
    this.#db.prepare('INSERT INTO runner_log (agent, at, text) VALUES (?, ?, ?)').run(agent, Date.now(), text.slice(0, 2000));
  }

  /** Runs once if there is anything new in the enabled rooms, and the runner is not already running for this agent. */
  async run(agent: string): Promise<{ steps: number; actions: string[] } | null> {
    const c = this.config(agent);
    if (!c?.enabled || !c.hasKey || !c.rooms.length || this.#running.has(agent)) return null;
    const rooms = new Set(c.rooms);
    const fresh = this.#host.core.messages(agent, { undelivered: true, deliverable: true }).filter((m) => m.author !== agent && rooms.has(m.room));
    if (!fresh.length) return null;
    this.#running.add(agent);
    const actions: string[] = [];
    let steps = 0;
    try {
      const key = this.#vault.open(`runner:${agent}:key`, (this.#db.prepare('SELECT key_sealed FROM runners WHERE agent = ?').get(agent) as any).key_sealed).toString('utf8');
      const inbox = await this.#host.inbox(agent, 50, rooms);
      const system = `${this.#host.instructions('runner')} Rooms you may act in: ${c.rooms.join(', ')}.`;
      const user = `New messages arrived on Meadow. Read them, and act only if it is useful and within your purpose. When you are done, reply with a short summary.\n\n${JSON.stringify(inbox, null, 1)}`;
      const convo = c.provider === 'anthropic' ? this.#anthropic(c, key, system, user) : this.#openai(c, key, system, user);
      while (steps < MAX_STEPS) {
        steps++;
        const turn = await convo.send();
        if (!turn.calls.length) {
          if (turn.text) actions.push(`Summary: ${turn.text.slice(0, 300)}`);
          break;
        }
        const results = [];
        for (const call of turn.calls) {
          const r = await this.#host.call(agent, call.name, call.input, { audience: 'runner', rooms });
          actions.push(`${call.name}${'refused' in r.data ? ' (refused)' : r.isError ? ' (failed)' : ''}`);
          results.push({ id: call.id, content: JSON.stringify(r.data), isError: !!r.isError });
        }
        convo.results(results);
      }
      if (steps >= MAX_STEPS) actions.push(`Stopped after ${MAX_STEPS} steps.`);
      this.#note(agent, actions.join('; ') || 'Nothing to do.');
      return { steps, actions };
    } catch (err) {
      this.#note(agent, `The model could not be reached or answered in a way the app cannot read: ${err instanceof Error ? err.message : String(err)}`);
      return { steps, actions };
    } finally {
      this.#running.delete(agent);
    }
  }

  async #post(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
    const res = await this.#fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(MODEL_TIMEOUT_MS) });
    const text = await readText(res, REPLY_LIMITS.model);
    if (!res.ok) throw new Error(`the model endpoint answered ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  }

  /** The Anthropic Messages API: tool_use blocks, answered with tool_result blocks. */
  #anthropic(c: RunnerConfig, key: string, system: string, user: string): Conversation {
    const tools = this.#host.list().map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
    const messages: any[] = [{ role: 'user', content: user }];
    return {
      send: async () => {
        const r = await this.#post(`${c.endpoint}/v1/messages`, { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, { model: c.model, max_tokens: 2048, system, tools, messages });
        if (!Array.isArray(r?.content)) throw new Error('no content in the answer');
        messages.push({ role: 'assistant', content: r.content });
        return {
          text: r.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n'),
          calls: r.content.filter((b: any) => b.type === 'tool_use').map((b: any) => ({ id: b.id, name: b.name, input: b.input ?? {} })),
        };
      },
      results: (results) => {
        messages.push({ role: 'user', content: results.map((x) => ({ type: 'tool_result', tool_use_id: x.id, content: x.content, ...(x.isError && { is_error: true }) })) });
      },
    };
  }

  /** OpenAI-compatible chat completions: tool_calls, answered with tool messages. */
  #openai(c: RunnerConfig, key: string, system: string, user: string): Conversation {
    const tools = this.#host.list().map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    const messages: any[] = [{ role: 'system', content: system }, { role: 'user', content: user }];
    return {
      send: async () => {
        const r = await this.#post(`${c.endpoint}/chat/completions`, { authorization: `Bearer ${key}` }, { model: c.model, messages, tools });
        const m = r?.choices?.[0]?.message;
        if (!m) throw new Error('no message in the answer');
        messages.push({ role: 'assistant', content: m.content ?? null, ...(m.tool_calls?.length && { tool_calls: m.tool_calls }) });
        return {
          text: typeof m.content === 'string' ? m.content : '',
          calls: (m.tool_calls ?? []).map((t: any) => {
            let input: Json = {};
            try {
              input = JSON.parse(t.function?.arguments || '{}');
            } catch {}
            return { id: t.id, name: t.function?.name, input };
          }),
        };
      },
      results: (results) => {
        for (const x of results) messages.push({ role: 'tool', tool_call_id: x.id, content: x.content });
      },
    };
  }
}
