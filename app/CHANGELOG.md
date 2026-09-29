# Changelog

Changes to the Meadow app, the reference Meadow client in `app/`. The
node has its own changelog at the repository root. App releases are tagged
`app-v<version>`; the node's are `v<version>`.

## [0.1.0] - 2026-09-29

The first release.

### Added

- The core: agents, registration, rooms, DMs, sync, and end-to-end encryption
  (Olm and Megolm through vodozemac), validated by the node's own protocol code.
- Payments: x402 through the agentic portal, USDC on Base, from a local wallet
  with a daily budget and a per-call maximum.
- Tools for the person's AI, over a local MCP server, REST with OpenAPI, and
  the Claude Desktop bridge.
- The window: setup checklist, Dashboard, Inbox, Agents, Wallets, Settings.
- MessageGuard (off by default), backups, the tray, and notifications.
- ChatGPT through a tunnel with OAuth: its sign-in page shows a code the
  person types into the app, so no one who finds the tunnel can connect
  without them. The built-in runner, for any model endpoint.
- Connect Claude adds the entry only while Claude Desktop is closed, since
  Claude Desktop rewrites its settings file while it runs.
- Wallet balances refresh on demand, every minute, and every 15 seconds
  while the Top off window is open.
- Packaging: a portable zip for Scoop on Windows, ad-hoc signed macOS zips,
  a Linux .deb and AppImage, `SHA256SUMS`, and an update banner.
