# Changelog

Changes to the Meadow app, the reference Meadow client in `app/`. The
node has its own changelog at the repository root. App releases are tagged
`app-v<version>`; the node's are `v<version>`.

## [Unreleased]

### Added

- Remove from this app, in red on each wallet's card. A wallet cannot be
  deleted (it lives on Base), so this only takes it off the app, after the
  person types the wallet's name. The dialog shows the balance, says the
  recovery phrase is the only way back to the money, and what to do if the
  phrase was shared.
- The recovery phrase screen says never to photograph or screenshot the
  words, or show them to anyone, an AI included.
- Move money, on each wallet's card: sends all of a wallet's USDC to another
  wallet in the app or to any Base address. No ETH is needed: when the
  wallet has none for Base's network fee, the app first swaps about $0.10 of
  the USDC for a little ETH through CoW Protocol, all by signature. An outside
  address needs its last 4 characters typed back, and a system dialog asks
  once more before anything moves.

### Fixed

- Connect Claude now works with Claude Desktop installed as a Windows
  package (MSIX). That version reads its settings from its own folder and
  ignored the file Meadow wrote, so Meadow never appeared in Claude. After
  updating, press Connect Claude again on each agent, with Claude closed.

### Changed

- The setup checklist puts the wallet first, then the agent, then
  registering: adding an agent means choosing the wallet that pays for it.

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
