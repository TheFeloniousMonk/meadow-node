// Builds signed events for a scenario and feeds them to the reference Room,
// so scenarios can refer to events by label.

import { b64u, canonicalize, sha256 } from '../../backend/src/proto/encoding.js';
import { agentIdFromKey, keypairFromSeed, signBytes } from '../../backend/src/proto/keys.js';
import { eventId, idBytes, ROOM_VERSION } from '../../backend/src/proto/event.js';
import { DEFAULT_LEVELS, selectAuth } from '../../backend/src/room/auth.js';
import { Room } from '../../backend/src/room/room.js';
import { commitment } from '../../backend/src/proto/report.js';
import { AgentLog } from '../../backend/src/agent/agent.js';

export const BASE_TS = 1790000000000;

export class Builder {
  agentLog = new AgentLog();
  room = new Room(this.agentLog);
  steps = [];
  openings = new Map();
  agents = new Map();
  clock = BASE_TS;
  #ids = new Map();

  // Deterministic keys, so vectors regenerate byte for byte.
  agent(name) {
    const key = (k) => keypairFromSeed(sha256(`meadow-conformance/${name}/${k}`));
    const primary = key('primary');
    const agent = { name, id: agentIdFromKey(primary.publicKey), keys: { primary }, key };
    this.agents.set(name, agent);
    return agent;
  }

  id(label) {
    const id = this.#ids.get(label);
    if (!id) throw new Error(`unknown label ${label}`);
    return id;
  }

  // opts: parents (labels, default current heads), auth (labels, default selected
  // from the state at parents), ts, data, content, key (name of an alternate key
  // of the author), signAs (another agent), patch (edit header before signing),
  // tamper (edit event after signing).
  add(label, author, kind, opts = {}) {
    if (this.#ids.has(label)) throw new Error(`duplicate label ${label}`);
    const parents = opts.parents ? opts.parents.map((l) => this.id(l)) : this.room.heads();
    const header = { v: opts.v ?? 2, kind, author: author.id, ts: opts.ts ?? (this.clock += 1000) };
    if (kind === 'room.create') {
      header.parents = [];
      header.auth = [];
    } else {
      header.room = this.room.id;
      header.parents = parents;
    }
    if (opts.data !== undefined) header.data = opts.data;
    if (opts.content !== undefined) {
      header.content_hash = b64u(sha256(Buffer.from(opts.content, 'utf8')));
      header.content_len = Buffer.byteLength(opts.content, 'utf8');
    }
    const signer = opts.signAs ? opts.signAs.keys.primary : author.keys[opts.key ?? 'primary'];
    if (opts.key) header.signer = b64u(signer.publicKey);
    if (kind !== 'room.create') {
      header.auth = opts.auth ? opts.auth.map((l) => this.id(l)) : selectAuth(header, this.room.stateAt(parents));
    }
    opts.patch?.(header);

    const ev = { header, id: eventId(header) };
    ev.sig = b64u(signBytes(signer.privateKey, idBytes(ev.id)));
    if (opts.content !== undefined) ev.content = opts.content;
    opts.tamper?.(ev);

    this.#ids.set(label, ev.id);
    this.steps.push({ label, event: ev, result: this.room.add(ev) });
    return ev.id;
  }

  // An agent event (§5.4). opts: parent (label, absent for agent.register),
  // data, key (alternate key name: sets signer), signAs, ts, patch.
  agentEvent(label, author, kind, opts = {}) {
    if (this.#ids.has(label)) throw new Error(`duplicate label ${label}`);
    const header = {
      v: opts.v ?? 2, kind, author: author.id,
      parents: opts.parent ? [this.id(opts.parent)] : [], auth: [],
      ts: opts.ts ?? (this.clock += 1000),
    };
    if (opts.data !== undefined) header.data = opts.data;
    const signer = opts.signAs ? opts.signAs.keys.primary : author.keys[opts.key ?? 'primary'];
    if (opts.key) header.signer = b64u(signer.publicKey);
    opts.patch?.(header);
    const ev = { header, id: eventId(header) };
    ev.sig = b64u(signBytes(signer.privateKey, idBytes(ev.id)));
    this.#ids.set(label, ev.id);
    this.steps.push({ label, event: ev, result: this.agentLog.add(ev) });
    return ev.id;
  }
  // agent.register with a deterministic key bundle.
  // opts.v: the event format (3 for `discoverable`, SPEC §15).
  register(label, author, profile = {}, opts = {}) {
    const bundle = { curve25519: b64u(sha256(`${author.name}/curve25519`)), fallback: b64u(sha256(`${author.name}/fallback/0`)) };
    return this.agentEvent(label, author, 'agent.register', { ...opts, data: { name: author.name, ...profile, keys: bundle } });
  }
  // Adds an alternate Ed25519 key to an agent, for agent.rotate.
  newKey(author, keyName) {
    author.keys[keyName] ??= author.key(keyName);
    return b64u(author.keys[keyName].publicKey);
  }

  // Shorthands
  create(label, author, data) {
    return this.add(label, author, 'room.create', { data: { room_version: ROOM_VERSION, ...data } });
  }
  member(label, author, target, membership, opts = {}) {
    return this.add(label, author, 'room.member', { ...opts, data: { target: target.id, membership } });
  }
  join(label, agent, opts = {}) {
    return this.member(label, agent, agent, 'join', opts);
  }
  post(label, author, text, opts = {}) {
    return this.add(label, author, 'msg.post', { ...opts, content: canonicalize({ text }) });
  }
  // A post in a private room. Nodes never decrypt, so the "ciphertext" is an
  // opaque stand-in; what matters is the commitment over the real body (§9.1).
  sealed(label, author, text, opts = {}) {
    const body = { text };
    const kf = sha256(`meadow-conformance/franking/${label}`);
    this.openings.set(label, { body, k_f: b64u(kf) });
    return this.add(label, author, 'msg.post', {
      ...opts,
      content: `ciphertext:${b64u(sha256(label))}`,
      patch: (h) => { h.commitment = commitment(kf, body); opts.patch?.(h); },
    });
  }
  meta(label, author, data, opts = {}) {
    return this.add(label, author, 'room.meta', { ...opts, data });
  }
  power(label, author, users, levels = {}, opts = {}) {
    const table = { ...DEFAULT_LEVELS, ...levels, users: Object.fromEntries(Object.entries(users).map(([n, l]) => [this.agents.get(n).id, l])) };
    return this.add(label, author, 'room.power', { ...opts, data: table });
  }
  // Binds the author's key in this room to an agent chain event (§6.5). Pass
  // opts.key to sign with the key current at that event.
  bind(label, author, chainLabel, opts = {}) {
    return this.add(label, author, 'room.rotate', { ...opts, data: { chain: this.id(chainLabel) } });
  }
}
