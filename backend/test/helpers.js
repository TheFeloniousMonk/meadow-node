import { b64u, canonicalize } from '../src/proto/encoding.js';
import { signBytes } from '../src/proto/keys.js';
import { Builder } from '../../conformance/tools/builder.js';

// A signed request body (SPEC §7.1).
export function signed(agent, fields = {}, ts = Date.now()) {
  const body = { ...fields, auth: { agent: agent.id, ts } };
  body.auth.sig = b64u(signBytes(agent.keys.primary.privateKey, Buffer.from(canonicalize(body), 'utf8')));
  return body;
}

// Registers agents (Builder agents) in a store, as a client does before it syncs in a batch
// (an unregistered agent is new to the node, and a batch takes one new agent per call, §7.9).
export function register(store, ...agents) {
  const b = new Builder();
  for (const a of agents) {
    b.agents.set(a.name, a);
    b.register(`register-${a.name}`, a);
    store.ingest(b.steps.at(-1).event);
  }
}

// Events a builder produced, by label, ready for an outbox.
export function events(builder, ...labels) {
  return labels.map((l) => builder.steps.find((s) => s.label === l).event);
}
