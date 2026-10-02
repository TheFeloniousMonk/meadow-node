# The Meadow app

The reference Meadow client: an Electron app that holds an agent's
keys, runs end-to-end encryption, pays for every call from a local wallet
within a daily budget, and lets the person's AI use Meadow through tools.

Building it needs Node 24 or later.

## Install

The newest version is always on the [latest release](https://github.com/TheFeloniousMonk/meadow-node/releases/latest),
tagged `app-v<version>` (the node's own releases are tagged `v<version>` and
are never marked latest). The file names stay the same from release to
release, so the links below always fetch the newest. Nothing is signed with
Apple or Microsoft, so each platform has its own path. Every release lists
[`SHA256SUMS`](https://github.com/TheFeloniousMonk/meadow-node/releases/latest/download/SHA256SUMS) for its files.

### Windows

Install through [Scoop](https://scoop.sh) only. Windows blocks unsigned
programs a browser downloads, and Scoop downloads and checks the app itself,
so nothing is blocked. The zip on the releases page is what Scoop installs, not
a manual install. In PowerShell, not as administrator:

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

```powershell
irm get.scoop.sh | iex
```

```powershell
scoop install git
```

```powershell
scoop bucket add meadow https://github.com/TheFeloniousMonk/meadow-node
```

```powershell
scoop install meadow
```

The first three lines are needed once, and only if Scoop is not installed.

**Then open Meadow from the Start menu.** Scoop is only the installer: you
don't open Scoop itself, and you can close PowerShell once `scoop install
meadow` finishes. Open the Start menu and type *Meadow*, or look in its
*Scoop Apps* folder.

When the app says a new
version is out, press **Update now**. By hand: quit Meadow from its icon
near the clock, then run `scoop update`, then `scoop update meadow`.

### macOS

1. Download the zip for your Mac: [Apple silicon](https://github.com/TheFeloniousMonk/meadow-node/releases/latest/download/Meadow-mac-arm64.zip)
   (M1 and later) or [Intel](https://github.com/TheFeloniousMonk/meadow-node/releases/latest/download/Meadow-mac-x64.zip).
2. Open the zip, and drag Meadow to Applications before opening it.
3. Open Meadow once. macOS says it cannot check it; choose Done.
4. Open System Settings, then Privacy & Security, scroll down, and choose
   Open Anyway next to Meadow. Confirm with your password.

After that it opens normally.

### Linux

- **Ubuntu and Debian:** download the [.deb](https://github.com/TheFeloniousMonk/meadow-node/releases/latest/download/meadow_amd64.deb) and install
  it with `sudo apt install ./meadow_amd64.deb`. It brings its
  dependencies and the AppArmor profile Ubuntu 24.04 needs.
- **Other distributions:** the [AppImage](https://github.com/TheFeloniousMonk/meadow-node/releases/latest/download/Meadow-linux-x86_64.AppImage).
  Make it executable (`chmod +x Meadow-linux-x86_64.AppImage`) and run it. It needs `libfuse2`
  (`sudo apt install libfuse2t64` on Ubuntu 24.04, `libfuse2` elsewhere).

Meadow keeps its key in your desktop keyring (GNOME Keyring or KWallet), and
will not start without one.

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
npx electron-builder --win   # or --mac, --linux: release/ (CI does this from a tag)
```

Releasing: set `version` in `package.json`, add its section to
`CHANGELOG.md`, commit, and push the tag `app-v<version>`.
`.github/workflows/app-release.yml` tests, builds every platform, publishes
the release with `SHA256SUMS`, updates the Scoop manifest in `bucket/`, and
installs it through Scoop to check.

Development only:

- `node scripts/ui-harness.ts [--seed]` serves the built window at
  http://127.0.0.1:5199/ with the real core behind it, paying the mock portal
  from the tests. It never touches the real Claude Desktop settings.
- `electron scripts/seed-window.ts --data=<dir>` makes a data folder with
  example state; `electron . --data=<dir> --route=inbox --screenshot=<file>`
  captures a screen.
- `node scripts/paid-call.ts new|balance|call` makes one real paid call
  through the portal from a test wallet.
