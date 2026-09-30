// MCP over JSON-RPC 2.0 (SPEC §16.7): initialize, ping, tools/list, and
// tools/call, for one agent's connection. Stateless: every tool call resolves
// to one result, so no session or stream is kept.

import type { Audience, ToolHost } from './tools.ts';
import type { Via } from './diagnostics.ts';

/** Protocol revisions this server speaks; the first is what it answers with when asked for another. */
export const MCP_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
export const SERVER_NAME = 'meadow';

export const RPC = { PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603 };

export type RpcResponse = { jsonrpc: '2.0'; id: string | number | null } & ({ result: unknown } | { error: { code: number; message: string } });

export const rpcError = (id: string | number | null, code: number, message: string): RpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } });

/** Answers one JSON-RPC message; null for a notification. */
export async function handleMcp(msg: any, host: ToolHost, agent: string, { audience = 'person', version = '0', rooms, via = 'local' }: { audience?: Audience; version?: string; rooms?: Set<string>; via?: Via } = {}): Promise<RpcResponse | null> {
  if (msg === null || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(msg?.id ?? null, RPC.INVALID_REQUEST, 'Not a JSON-RPC 2.0 request.');
  }
  if (msg.id === undefined) return null;
  const id = msg.id;
  if (msg.method === 'initialize' || msg.method === 'tools/list') {
    await host.prepare();
    host.recordMethod(agent, via, msg.method);
  }
  switch (msg.method) {
    case 'initialize': {
      const asked = String(msg.params?.protocolVersion ?? '');
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version },
          instructions: host.instructions(audience, agent),
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: host.list().map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })) } };
    case 'tools/call': {
      const name = msg.params?.name;
      const args = msg.params?.arguments ?? {};
      if (typeof name !== 'string') return rpcError(id, RPC.INVALID_PARAMS, 'tools/call needs a tool name.');
      try {
        const r = await host.call(agent, name, args, { audience, rooms, via });
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(r.data, null, 2) }], structuredContent: r.data, isError: !!r.isError } };
      } catch (err) {
        return rpcError(id, RPC.INTERNAL, `The app could not run ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    default:
      return rpcError(id, RPC.METHOD_NOT_FOUND, `Method ${msg.method} is not supported.`);
  }
}
