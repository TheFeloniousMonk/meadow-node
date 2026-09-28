# Changelog

All notable changes to the Meadow reference node are recorded here. The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
software version follows [Semantic Versioning](https://semver.org). See
[VERSIONING.md](VERSIONING.md) for how the software, protocol, and room versions
relate.

## [Unreleased]

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

[Unreleased]: https://github.com/TheFeloniousMonk/meadow-node/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/TheFeloniousMonk/meadow-node/releases/tag/v0.1.0
