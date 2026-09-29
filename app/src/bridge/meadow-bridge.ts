// The Claude bridge (SPEC §16.7.1): a small program Claude Desktop runs as a
// local stdio MCP server. It relays each JSON-RPC line from stdin to the
// running Meadow app on loopback, with its connection's token, and writes the
// answer to stdout. It holds no key and keeps no state; the app does the work.
//
// Configuration comes from the environment Claude Desktop starts it with:
//   MEADOW_URL     the app's MCP endpoint, http://127.0.0.1:<port>/mcp
//   MEADOW_TOKEN   the agent's connection token
//   MEADOW_APP     (optional) the app to start when it is not running
//
// Node built-ins only. In the packaged app it runs under the app's own
// executable with ELECTRON_RUN_AS_NODE=1, so nothing else needs installing.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const url = process.env.MEADOW_URL ?? '';
const token = process.env.MEADOW_TOKEN ?? '';
const app = process.env.MEADOW_APP;
const NOT_RUNNING = 'The Meadow app is not running on this computer. Ask your person to open it, then try again.';

let launched = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(body: string): Promise<Response | null> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      return await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body });
    } catch {
      // Not running: start it once, then wait for it to listen.
      if (!app) return null;
      if (!launched) {
        launched = true;
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        spawn(app, [], { detached: true, stdio: 'ignore', env }).unref();
      }
      await sleep(1000);
    }
  }
  return null;
}

function write(message: unknown) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

async function relay(line: string) {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON.' } });
  }
  const res = await post(line);
  if (msg?.id === undefined) return; // a notification: nothing to answer
  if (!res) {
    // A tool call gets an answer the model can relay; anything else, an error.
    if (msg.method === 'tools/call') return write({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: NOT_RUNNING }], isError: true } });
    return write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: NOT_RUNNING } });
  }
  if (res.status === 401) return write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'The Meadow app did not accept this connection. Connect Claude again from the Agents screen.' } });
  const text = await res.text();
  if (text) process.stdout.write(text.replace(/\n/g, '') + '\n');
}

if (!url || !token) {
  process.stderr.write('meadow-bridge: MEADOW_URL and MEADOW_TOKEN must be set.\n');
  process.exit(2);
}

// Lines are answered in order, one at a time.
let chain = Promise.resolve();
createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  chain = chain.then(() => relay(line));
});
