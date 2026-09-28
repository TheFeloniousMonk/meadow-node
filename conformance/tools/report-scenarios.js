// Report verification cases (SPEC §9.2). Expectations are hand-derived from the
// spec; generate.js refuses to write vectors if verifyReport disagrees.

import { b64u, sha256 } from '../../backend/src/proto/encoding.js';
import { Builder } from './builder.js';

const strip = (ev) => ({ header: ev.header, id: ev.id, sig: ev.sig });

export function reportCases() {
  const p = new Builder();
  const alice = p.agent('alice'), bob = p.agent('bob');
  p.create('create', alice, { type: 'private' });
  p.join('alice-join', alice);
  p.member('alice-invites-bob', alice, bob, 'invite');
  p.join('bob-join', bob);
  p.sealed('bob-secret', bob, 'something reportable');

  const q = new Builder();
  const carol = q.agent('carol');
  q.create('create', carol, { type: 'public' });
  q.join('carol-join', carol);
  q.post('carol-public', carol, 'something public');

  const ev = (b, label) => b.steps.find((st) => st.label === label).event;
  const secret = strip(ev(p, 'bob-secret'));
  const opening = p.openings.get('bob-secret');
  const pub = strip(ev(q, 'carol-public'));

  return [
    {
      name: 'private-valid',
      description: 'A private-room report opens the commitment with the decrypted body and k_f.',
      report: { event: secret, ...opening, reason: 'abuse' },
      expect: { valid: true },
    },
    {
      name: 'private-valid-with-note',
      description: 'An optional note is part of the report and so of its ID.',
      report: { event: secret, ...opening, reason: 'illegal', note: 'context for the reviewer' },
      expect: { valid: true },
    },
    {
      name: 'public-valid',
      description: 'A public-room report is the event alone; nodes hold the plaintext.',
      report: { event: pub, reason: 'spam' },
      expect: { valid: true },
    },
    {
      name: 'altered-body',
      description: 'A body the author did not write fails the commitment.',
      report: { event: secret, body: { text: 'words put in their mouth' }, k_f: opening.k_f, reason: 'abuse' },
      expect: { valid: false, reason: 'bad_opening' },
    },
    {
      name: 'wrong-franking-key',
      description: 'The right body under the wrong key fails the commitment.',
      report: { event: secret, body: opening.body, k_f: b64u(sha256('not the key')), reason: 'abuse' },
      expect: { valid: false, reason: 'bad_opening' },
    },
    {
      name: 'private-missing-opening',
      description: 'A report on an event with a commitment must open it.',
      report: { event: secret, reason: 'abuse' },
      expect: { valid: false, reason: 'malformed' },
    },
    {
      name: 'public-with-opening',
      description: 'A report on an event without a commitment must not carry body or k_f.',
      report: { event: pub, body: { text: 'something public' }, k_f: opening.k_f, reason: 'spam' },
      expect: { valid: false, reason: 'malformed' },
    },
    {
      name: 'not-a-message',
      description: 'Only msg.post events can be reported.',
      report: { event: strip(ev(p, 'alice-join')), reason: 'other' },
      expect: { valid: false, reason: 'not_a_message' },
    },
    {
      name: 'forged-event',
      description: 'The reported header must be exactly what its author signed.',
      report: { event: { ...secret, header: { ...secret.header, ts: secret.header.ts + 1 } }, ...opening, reason: 'abuse' },
      expect: { valid: false, reason: 'bad_event' },
    },
    {
      name: 'event-with-content',
      description: 'The reported event is sent without content.',
      report: { event: ev(q, 'carol-public'), reason: 'spam' },
      expect: { valid: false, reason: 'bad_event' },
    },
    {
      name: 'unknown-reason',
      description: 'The reason must be one of spam, abuse, illegal, other.',
      report: { event: pub, reason: 'boring' },
      expect: { valid: false, reason: 'malformed' },
    },
    {
      name: 'unknown-field',
      description: 'Reports have no fields beyond event, body, k_f, reason, and note.',
      report: { event: pub, reason: 'spam', reporter: carol.id },
      expect: { valid: false, reason: 'malformed' },
    },
  ];
}
