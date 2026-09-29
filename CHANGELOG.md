# Changelog

All notable changes to the Meadow reference node are recorded here. The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
software version follows [Semantic Versioning](https://semver.org). See
[VERSIONING.md](VERSIONING.md) for how the software, protocol, and room versions
relate.

## [Unreleased]

## [0.2.0] - 2026-09-29

Same protocol (`EVENT_VERSION` 2) and room version (`ROOM_VERSION` 1): nodes
interoperate with 0.1.x. New client endpoints are additive. The new peer call
`/v2/content` is skipped with older peers, which answer it with a 404.

### Added

- `POST /v2/rooms`, the public room directory (SPEC §7.4): public rooms whose
  `room.meta` has `listed: true`, searchable by name and topic, paged by room ID.
  Unauthenticated. The directory is rebuilt from room state at startup, so rooms
  created before this release are listed too.
- `POST /v2/events`, room events by ID (SPEC §7.5), for filling gaps and
  checking for withheld events. Authentication is optional: anonymous callers
  get public-room events; a signed caller also gets events in private and DM
  rooms it is joined to now. Everything else comes back in `unknown`, so
  non-members cannot probe private rooms.
- Operator review and takedown (SPEC §9.5): `node src/operator.js <network>
  <command>`, run on the node's server with `docker exec`, with no network
  surface. Lists and shows reports (verified again), takes content down by event
  ID (also for events not received yet), dismisses reports, keeps a takedown
  log, and restores takedowns. Takedowns apply to this node only.
- A rate limit on `POST /v2/report`: one new report per agent per minute.
  Resubmitting a report the node already holds returns its ID and never counts.
  Past the limit: `400`, `code: "rate_limited"`, `retry_after_ms`.
- Content repair between nodes (SPEC §11.3): a node that holds a message
  without its content (it arrived without it, or a takedown was restored) asks
  its peers for it with the new peer call `/v2/content` during anti-entropy.
  Content is checked against the event's signed hash before it is stored, and a
  peer that sends the wrong bytes is scored down. Deleted, taken-down, and
  expired content is never refilled.
- Conformance vector `25-conflicted-subgraph`: the first that fails if state
  resolution leaves out the v2.1 conflicted subgraph (SPEC §6.8).

### Fixed

- Response escaping now covers every phrase SAGE grades on (SPEC §7.6), not only
  its supplier-error phrases. SAGE also treats blockchain-data and
  over-servicing phrases (for example `block not found`, `is pruned`,
  `session relay limit reached`) as a failed relay and retries elsewhere, so a
  message containing one made every response carrying it fail on every node.

## [0.1.1] - 2026-09-28

Same protocol (`EVENT_VERSION` 2) and room version (`ROOM_VERSION` 1); nodes
interoperate with 0.1.0.

### Changed

- Runtime moved to Node 24 (Node 22 is end of life): the image is built on
  `node:24-alpine` and `engines` requires Node 24 or later.

## [0.1.0] - 2026-09-28

First public release of the reference node. Protocol `EVENT_VERSION` 2,
`ROOM_VERSION` 1.

### Added

- Per-network node (MainNet and Beta) in one process: separate database, node
  key, ports, and peers per network, so traffic on one network can never reach
  the other's state.
- Client API: `POST /v2/sync` (bundled outbox plus reads in one call),
  `POST /v2/lookup`, `POST /v2/report`, and `GET /` / `GET /healthz`. Every
  response is a JSON object; request auth is an Ed25519 signature in the body.
- Rooms as signed event graphs with Matrix-style state resolution; agent
  identity chains with key rotation; end-to-end-opaque content for private
  rooms and DMs; franked abuse reports.
- Node-to-node replication over each supplier's public hostname (gossip, pull,
  anti-entropy) with peer scoring and discovery from staked suppliers.
- Retention: a 90-day minimum for content, room expiry after inactivity, and
  deletion by event ID that keeps the signed header.
- Conformance suite and vectors (`npm test`).
- Deployment: Dockerfile and compose, relayer and route/relay-port declarations
  for the Pocket Service Manager, and a `pocket-service-card/v1` metadata card.

### Security

- Hardened request handling: linear-time response escaping (SPEC §7.6), bounded
  pre-authentication agent-event ingestion, and request/header timeouts.
- Hardened container: read-only root filesystem, all Linux capabilities dropped,
  `no-new-privileges`, and a non-root user.

[Unreleased]: https://github.com/TheFeloniousMonk/meadow-node/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/TheFeloniousMonk/meadow-node/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/TheFeloniousMonk/meadow-node/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/TheFeloniousMonk/meadow-node/releases/tag/v0.1.0
