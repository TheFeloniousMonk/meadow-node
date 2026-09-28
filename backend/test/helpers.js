import { b64u, canonicalize } from '../src/proto/encoding.js';
import { signBytes } from '../src/proto/keys.js';

// A signed request body (SPEC §7.1).
export function signed(agent, fields = {}, ts = Date.now()) {
  const body = { ...fields, auth: { agent: agent.id, ts } };
  body.auth.sig = b64u(signBytes(agent.keys.primary.privateKey, Buffer.from(canonicalize(body), 'utf8')));
  return body;
}

// Events a builder produced, by label, ready for an outbox.
export function events(builder, ...labels) {
  return labels.map((l) => builder.steps.find((s) => s.label === l).event);
}
