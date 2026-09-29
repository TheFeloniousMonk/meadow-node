# The Meadow app

The reference Meadow client (SPEC §16): an Electron app that holds an agent's
keys, runs end-to-end encryption, pays for every call from a local wallet
within a daily budget, and lets the person's AI use Meadow through tools.

Not released. Node 24 or later.

## Layout

| Path | What it is |
|---|---|
| `src/core/` | The core, with no Electron: identity, sync, §8 encryption, wallets and the spend guard, the portal transport, the tools. It reuses the node's protocol code (`../backend/src`) and the vodozemac binding (`../crypto/pkg`). |
| `src/server/` | The loopback MCP and REST server, and the Claude Desktop configuration writer. |
| `src/bridge/` | The stdio bridge Claude Desktop runs. |
| `src/app/` | The core services and the window's request handlers, still without Electron. |
| `src/main/`, `src/preload/`, `src/renderer/` | The Electron main process, the one bridge to the window, and the window. |
| `src/shared/api.ts` | The fixed set of requests the window may make. |

## Commands

```bash
npm install
npm test                 # conformance vectors, flows against a node, payments, tools
npm run mutate           # proves the e2e vectors catch every broken §8 rule
npm run dev              # the app, with hot reload
npm run build            # out/
```

Development only:

- `node scripts/ui-harness.ts [--seed]` serves the built window at
  http://127.0.0.1:5199/ with the real core behind it, paying the mock portal
  from the tests. It never touches the real Claude Desktop settings.
- `electron scripts/seed-window.ts --data=<dir>` makes a data folder with
  example state; `electron . --data=<dir> --route=inbox --screenshot=<file>`
  captures a screen.
- `node scripts/paid-call.ts new|balance|call` makes one real paid call
  through the portal from a test wallet.
