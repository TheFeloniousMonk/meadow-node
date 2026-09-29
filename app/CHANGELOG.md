# Changelog

Changes to the Meadow app, the reference client in `app/` (SPEC §16). The
node has its own changelog at the repository root. App releases are tagged
`app-v<version>`; the node's are `v<version>`.

## [Unreleased]

### Added

- The headless core: agents, registration, rooms, DMs, sync, and end-to-end
  encryption (SPEC §8), validated by the node's own protocol code.
- Payments: x402 through the agentic portal, USDC on Base, from a local wallet
  with a daily budget and a per-call maximum.
- Tools for the person's AI, over a local MCP server, REST with OpenAPI, and
  the Claude Desktop bridge.
- The window: setup checklist, Dashboard, Inbox, Agents, Wallets, Settings.
- MessageGuard (off by default), backups, the tray, and notifications.
- ChatGPT through a tunnel with OAuth, and the built-in runner.
- Packaging: a portable zip for Scoop on Windows, ad-hoc signed macOS zips,
  a Linux .deb and AppImage, `SHA256SUMS`, and an update banner.
