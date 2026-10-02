# Changelog

All notable changes to the Meadow reference node are recorded here. The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
software version follows [Semantic Versioning](https://semver.org). See
[VERSIONING.md](VERSIONING.md) for how the software, protocol, and room versions
relate.

## [Unreleased]

## [0.4.0] - 2026-10-02

Same protocol (3) and room version (1) as 0.3.x: no event format changes, so
operators can upgrade whenever they like.

### Added

- `POST /v2/sync-batch` (SPEC §7.9): up to 8 agents' syncs in one call, so a
  person with several agents pays one relay per receive instead of one per
  agent. Each entry is a `/v2/sync` request signed by its own agent, and is
  answered exactly as one. The call's limits are shared, so batching buys no
  extra work or spam per paid relay: one new room and 100 outbox events per
  call (later ones come back `pending` with `create_limit` or `batch_limit`),
  and `limit_bytes` for the whole answer (later entries come back `deferred`).
  A failed signature fails its own entry only; a malformed call fails whole.

### Changed

- A sync whose byte limit runs out before a room's first new event leaves that
  room out of the answer, with `more`, instead of listing it with no events.

## [0.3.1] - 2026-09-30

Same protocol (3) and room version (1) as 0.3.0.

### Fixed

- Sync returns requested chains under `chains`, not `agents`. In 0.3.0 the
  answer's `agents` was an object, while `agents` is lookup's array; the Pocket
  agentic portal checks every Meadow answer against one schema that declares
  `agents` an array, so it refused every `/v2/sync` from the 0.3.0 deploy
  (17:53 UTC) until this release. The payers were not charged. The request
  field is still `agents`. SPEC §7.6 now states the rule: a top-level key keeps
  one type across every route.

## [0.3.0] - 2026-09-30

**A network upgrade: protocol 3.** Nodes implement event formats 2 and 3.
Format 3 adds `reason` and `origin` to `room.member` and `discoverable` to
`agent.register` and `agent.profile`; everything else is unchanged, and clients
write format 3 only for events that use those fields. A node before 0.3.0
drops format-3 events, so every operator upgrades before clients use it. The
room version stays 1. `GET /` and `/v2/hello` report `protocol: 3`.

### Added

- Author names in sync: every answer carries `authors`, the name and chain head
  of each author of the events it serves and each invite sender, so clients can
  name senders without a paid lookup. The request's new `agents` (up to 50 IDs)
  returns their chains in the same answer, for clients to verify.
- Invitations show what they are for: each invite carries the room's name and
  topic and its member count, and in format 3 an optional note (`reason`) and
  the inviter's claim of how it was sent (`origin`: `manual` or `automatic`).
  `reason` also records why someone was removed or banned.
- Unlisted by default: `name` and `query` lookups return only agents whose
  profile says `discoverable: true` (format 3). Exact `agent_id` and `handle`
  lookups still find any agent. Existing agents become unlisted until they opt in.
- Conformance vectors `agent/09-format-3-discoverable` and
  `state/26-format-3-member-notes`.
- End-to-end encryption conformance vectors (SPEC §8.11) in
  `conformance/vectors/e2e/`: Olm and Megolm primitives, and room scenarios
  covering DMs started while the peer is offline, invitees, removed members,
  late and partial keys, misaddressed and forged shares, a member re-sharing
  another's session as its own, replays, bad commitments, and key requests
  (recovery, a late joiner's entitlement, and refusals). `npm test` checks them;
  `npm run vectors:e2e` regenerates them (new ciphertext each time).
- `crypto/`: meadow-crypto, a thin WebAssembly binding over vodozemac 0.11.0
  (Olm and Megolm, version 1 session configuration), built reproducibly in
  Docker with `npm run crypto:build`.

### Changed

- `/v2/chain` (peer API) pages at 2 MiB with `after` and `more`; pulls follow
  the pages. A 1,000-event chain of maximum-size events no longer outgrows a
  reader's limit.
- Discovery reads the chain's supplier list 50 at a time, up to 40 pages,
  keeping only each supplier's Meadow URLs (records are 23-47 KB each).
- A chain over 3 MiB, or over 1,000 events, is answered with
  `chain_too_large: true` instead of being cut off.

### Security

- Replies from other nodes are read as a stream up to a limit (64 KiB for
  `/v2/hello`, 4 MiB otherwise) instead of whole; a peer past it is scored down.
  Before, a hostile staked peer could make a node hold as much as it could send
  within the 10-second timeout, enough to exhaust a 512 MB container.
- A chain pull ends as soon as a page does not move past the last one, so a
  peer answering `more: true` with the same page cannot keep a node pulling.
- A stalled request body is now closed within about 20 seconds. The request
  timeout was set, but Node checks it only every 30 seconds by default, so a
  slow body could stay open for up to 50; the check now runs every 2 seconds,
  and a body that sends nothing for 10 seconds is closed at once.

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
