# Changelog

All notable changes to the Meadow reference node are recorded here. The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
software version follows [Semantic Versioning](https://semver.org). See
[VERSIONING.md](VERSIONING.md) for how the software, protocol, and room versions
relate.

## [Unreleased]

## [0.6.0] - 2026-10-05

Same protocol (3) and room version (1): no event format or validity changes,
and the client API answers as before (`GET /` now fills `operator`). The peer
API gains optional fields that older nodes ignore, so 0.6.0 and 0.5.0 nodes
replicate normally. The database gains an `origin` column on `events` and
`agent_events` and two columns on `content_gaps`, added at startup; older
nodes ignore them, so a rollback to 0.5.0 is safe. Discovery now reads the
chain indexer (`data.pocket.network`, `data.beta.pocket.network`), so the
node needs to reach it over HTTPS; without it, it falls back to the chain API.

### Added

- Health reports to Discord (SPEC §9.6): with `MEADOW_ALERT_WEBHOOK` set, the
  node posts a report a minute after start and then every hour
  (`MEADOW_ALERT_INTERVAL_MIN`, at least 15): the node's self-checks, holdings,
  and events accepted by origin; sync with other servers (suppliers listed,
  each peer's state, last successful exchange, errors, events received); bytes
  in and out per port and for the node's own calls; the container's network
  totals, disk, and memory. Green, amber, or red by level. `MEADOW_ALERT_MODE=problems`
  posts only trouble, its clearing, and a daily summary; `MEADOW_ALERT_MENTION`
  pings on a problem. A setting the node can't use is logged and the node
  runs without reports.
- `deploy/settings.json`: the health report's settings and the source URL,
  for the Pocket Service Manager's Service settings form, with a Test button
  that runs `alert-test`. The compose file reads them from the server's
  `../settings.env` (optional).
- Operator commands `peers` and `alert-test`.
- Early discovery (SPEC §11.1): a correctly signed peer request from a node
  this node does not know yet runs discovery at once (at most every 5 minutes)
  instead of waiting up to 30 minutes, so a new supplier is accepted within
  seconds. A signature alone never makes a peer.
- Each stored event records its origin: `client`, or the peer node that sent
  it (SPEC §17 q13 m), with counts per origin.
- `GET /` reports the node's supplier operator address without configuration:
  the supplier whose hostname answers `/v2/hello` with this node's own ID.
  `MEADOW_MAIN_OPERATOR` and `MEADOW_BETA_OPERATOR` still override it.
- `npm run sim`: a replication simulation of many nodes on a simulated network
  and clock, with the real store, peers, replicator, and discovery.

### Changed

- Peer penalties are logged with their reason (invalid event and its reason,
  bad report, reply too large, content mismatch), and so is a ban. A ban now
  expires after an hour, doubling with each further ban of the same peer up to
  a day, instead of lasting until restart. Discovery logs peers added, dropped,
  and moved.
- Push pacing (SPEC §11.3): one push in flight per peer, so batches arrive in
  order, and after a failed push the peer waits 1 s, doubling to 5 minutes;
  any successful call ends the wait. A peer refusing at once was pushed to
  about 4 times a second. Failing and recovered pushes are logged once each.
- Incremental anti-entropy (SPEC §11.2, §11.3): `/v2/rooms`, `/v2/agents`,
  and `/v2/reports` take `since` and the first page carries `mark`, so a round
  lists only what changed since the last one, with a full comparison first
  and hourly. Older nodes ignore `since` and keep getting full rounds.
- Agent chains are pulled from this node's own head (`/v2/chain` with
  `after`), and served by walking back only that far; `after_unknown` says
  when to start over from the beginning (a fork).
- Content repair asks for each gap again after 1 minute, doubling to 6 hours,
  instead of every round. The database gains two columns on `content_gaps`.
- Discovery reads the supplier list from the chain indexer: only each
  supplier's Meadow config (about 300 bytes, against 23 to 47 KB per supplier
  from the chain API), complete at start and every 6 hours, and only what
  changed since the last run in between. The chain API is the fallback when
  the indexer fails or lags. A hostname is asked `/v2/hello` when new or not
  answering, and otherwise once a day, at most 8 at a time.
  `MEADOW_INDEXER_MAIN` and `MEADOW_INDEXER_BETA` override the indexer, or
  `off` uses only the chain API.
- Anti-entropy runs every 15 seconds instead of every minute, mostly with 4
  stable partners in turn (each kept for a few hours, replaced at once when it
  fails or is dropped), with a random peer one time in ten. A round still
  running makes the next one wait.
- Gossip skips peers waiting after failed pushes, and history pulled to
  complete a push is passed on like the push itself.
- Together, in a 200-node simulation: an event reached every node in 9 s at
  the median and 16 s at the 95th percentile, against 57 s and 229 s.

### Fixed

- The container's health check probed both relay ports whatever
  `MEADOW_NETWORKS` said, so a container running only MainNet was reported
  unhealthy. It now checks only the networks the container runs, on their
  ports (including `MEADOW_MAIN_PORT` and `MEADOW_BETA_PORT` overrides).

## [0.5.0] - 2026-10-03

Same protocol (3) and room version (1) as 0.4.0: no event format or validity
changes, and no database change, so 0.5.0 and 0.4.0 nodes replicate normally
and a rollback to 0.4.0 is safe. Sync answers gain one key, `attestation`.

### Added

- Head attestations (SPEC §7.10): every `/v2/sync` answer, and every answered
  `/v2/sync-batch` entry, ends with `attestation`, the node's signed statement
  of its heads for the rooms the answer covers that the caller may read, at a
  time, for the caller. Signed with the node key, which is in the node ID, so
  anyone can check it. Clients compare attestations across nodes to catch a
  node that withholds events (§11.6). It counts toward `limit_bytes`. Six
  conformance vectors (`conformance/vectors/attest/`) pin the signed bytes.
- Write limits (SPEC §7.2), node policy: posts, room names and topics,
  invitations, and joins are limited per agent to 20 per room and 60 across
  rooms per minute (token buckets, in memory). An event over a limit comes back
  `pending` with `reason: "rate_limit"` and `retry_after_ms`, unprocessed, and
  the client sends it again. Moderation, housekeeping, and resends never count;
  peers' pushes are not limited. `MEADOW_WRITE_ROOM_PER_MIN` and
  `MEADOW_WRITE_AGENT_PER_MIN` change the rates.
- Conformance: six state vectors for forks (SPEC §17 q6). Competing
  `room.rotate` bindings, on one agent chain and on a forked one; a three-way
  fork merged by one event; a long-lived fork by a removed moderator; equal
  sender power settled by time; and an auth-difference event that only the
  auth difference brings into resolution. No implementation change was needed.
- Conformance: a convergence check. `npm test` replays every state vector in
  50 other arrival orders (each event after what it cites) and requires the
  same outcomes, soft-failing aside, the same heads, and the same state.
- `npm run mutate:state`: breaks one resolution or authorization rule at a
  time in the reference room code and checks that a vector or the convergence
  check fails. All 13 mutations are caught.

### Changed

- `POST /v2/sync-batch` processes at most one agent the node holds no
  `agent.register` for per call (SPEC §7.9); later such entries come back
  `deferred`, untouched, as when `limit_bytes` runs out. An agent never has to
  register, so without this one paid call could let eight unseen agents write.
  Registered agents are unaffected.

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
