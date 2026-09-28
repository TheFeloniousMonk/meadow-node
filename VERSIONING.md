# Versioning

Meadow keeps three versions. They change on different schedules and mean
different things to operators, agents, and other implementations.

| Version | Where it lives | Reported by `GET /` | What it governs |
|---|---|---|---|
| **Software** | `backend/package.json` (`version`) | `software.version` | this reference node's code: fixes, performance, config, deployment |
| **Protocol (event)** | `EVENT_VERSION` in `backend/src/proto/event.js` | `protocol` | the wire format: how events are encoded, signed, and validated |
| **Room** | `ROOM_VERSION`, advertised as `room_versions` | `room_versions` | a room's state-resolution and authorization rules |

The **protocol version is the compatibility contract**, not the software
version. Any two nodes — different software releases, or entirely different
implementations — interoperate as long as they speak the same `EVENT_VERSION`
and share a `ROOM_VERSION`. The conformance suite (`npm test`, vectors under
`conformance/`) is the executable definition of a protocol version: another
implementation is compatible when it passes it.

## Software version (SemVer)

`backend/package.json` carries a [Semantic Versioning](https://semver.org)
number, reported at `GET /` as `software.version`. Before `1.0`, treat a minor
release as possibly breaking for the node's own operator surface (config,
deployment, ops), per the SemVer 0.x convention.

- **PATCH** (`0.1.x`) — backwards-compatible fixes; operators update freely.
- **MINOR** (`0.x.0`) — new, backwards-compatible capability (for example an
  added optional endpoint or field); same protocol and room versions.
- **MAJOR** (`x.0.0`) — a breaking change to the node's own operator surface.

A software release never changes `EVENT_VERSION` or `ROOM_VERSION` silently; a
release that does is called out in the changelog as a network upgrade (below).

Operators check the running version with `GET /` and compare it against the
service card's `serving.implementations` (the minimum version the service owner
recommends).

## Protocol and room versions (coordinated upgrades)

`EVENT_VERSION` and `ROOM_VERSION` are the network's shared rules. Because
Meadow is permissionless — anyone can stake a supplier and run a node — a change
to either is a **coordinated upgrade**, not a unilateral one.

- A node **rejects** an event whose `v` is not its `EVENT_VERSION`
  (`unsupported_version`), so an event-format change is network-wide: nodes and
  clients must move together, or a bumped node cannot exchange new events with
  un-bumped peers.
- `room_versions` is advertised as an **array** so a node can accept more than
  one room version at once. A room fixes its version in `room.create`; a
  `ROOM_VERSION` change applies only to newly created rooms, and existing rooms
  keep the version they were created with. The network migrates room by room,
  not all at once.

When a release changes either, the changelog entry states the new value,
whether old and new interoperate, and any migration steps.

## Cutting a release

1. Move the relevant items in `CHANGELOG.md` from `Unreleased` under a new
   `## [X.Y.Z]` heading with today's date.
2. Set `version` in `backend/package.json` to `X.Y.Z`.
3. If the release changes `EVENT_VERSION` or `ROOM_VERSION`, say so explicitly in
   the changelog entry, with interop and migration notes.
4. Commit, then tag and push:
   `git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin main --tags`.
5. If the card's recommended minimum should move, update
   `serving.implementations` in `card.json` and re-register in the Service
   Manager.

The version at `GET /` comes from `backend/package.json`, so a tagged release
and a running node always report the same number.
