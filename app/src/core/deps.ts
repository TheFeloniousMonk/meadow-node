// The protocol code the app shares with the node (SPEC §16.1): encoding,
// signatures, the event format, room validation and state, agent chains, and
// reports come from backend/src; Olm and Megolm come from vodozemac through
// the binding in crypto/pkg. The app implements none of these itself.

import { createRequire } from 'node:module';

export { b64u, canonicalize, fromB64u, sha256 } from '../../../backend/src/proto/encoding.js';
export { agentIdFromKey, keyFromAgentId, keypairFromSeed, signBytes, verifyBytes } from '../../../backend/src/proto/keys.js';
export {
  AGENT_KINDS, EVENT_VERSION, MAX_CONTENT, MAX_PARENTS, ROOM_VERSION,
  checkWellFormed, dmKey, eventId, idBytes, roomIdOf, stateKey,
} from '../../../backend/src/proto/event.js';
export { membershipOf, powerOf, powerTable, selectAuth } from '../../../backend/src/room/auth.js';
import { Room as RoomJs } from '../../../backend/src/room/room.js';
import { AgentLog as AgentLogJs } from '../../../backend/src/agent/agent.js';
export { handleOf } from '../../../backend/src/agent/agent.js';
export { commitment, reportId, verifyReport } from '../../../backend/src/proto/report.js';

const require = createRequire(import.meta.url);
export const wasm: typeof import('../../../crypto/pkg/meadow_crypto.js') = require('../../../crypto/pkg/meadow_crypto.js');

/** An event as signed: header, ID, signature, and content where the kind carries it (SPEC §5.1). */
export interface MeadowEvent {
  header: Header;
  id: string;
  sig: string;
  content?: string;
}

export interface Header {
  v: number;
  kind: string;
  author: string;
  room?: string;
  parents: string[];
  auth: string[];
  ts: number;
  data?: any;
  content_hash?: string;
  content_len?: number;
  commitment?: string;
  mentions?: string[];
  signer?: string;
}

/** A room state: state key ("kind|key") to event (SPEC §6.2). */
export type State = Map<string, MeadowEvent>;

/** The result of processing an event (SPEC §6.6, §5.4). */
export type Outcome =
  | { outcome: 'accepted'; soft_failed?: boolean; reason?: undefined }
  | { outcome: 'rejected' | 'discarded'; reason: string; soft_failed?: undefined }
  | { outcome: 'pending'; missing: string[]; reason?: string; soft_failed?: undefined };

/** One room's event graph, as the node's Room implements it (backend/src/room/room.js). */
export interface Room {
  readonly id: string;
  readonly create: MeadowEvent | null;
  readonly size: number;
  has(id: string): boolean;
  event(id: string): MeadowEvent;
  outcome(id: string): Outcome;
  add(ev: MeadowEvent): Outcome;
  restore(ev: MeadowEvent, result: Outcome): void;
  stateAt(parents: string[]): State;
  stateAfter(id: string): State;
  heads(): string[];
  currentState(): State;
  deletionEffect(del: MeadowEvent): 'author' | 'moderator' | null;
}

export interface AgentRecord {
  id: string;
  agent: string;
  depth: number;
  rotations: number;
  state: { key: string; name: string; description: string; capabilities: string[]; invites: string; keys: { curve25519: string; fallback: string }; blocked: string[] };
}

/** Agent chains (backend/src/agent/agent.js), also the chain resolver rooms consult. */
export interface AgentLog {
  add(ev: MeadowEvent): Outcome;
  head(agent: string): AgentRecord | null;
  keyAt(id: string): { agent: string; key: string } | null;
  descends(id: string, ancestor: string): boolean;
  currentKey(agent: string): string | null;
}

export const Room = RoomJs as unknown as new (agents?: AgentLog | null) => Room;
export const AgentLog = AgentLogJs as unknown as new () => AgentLog;
