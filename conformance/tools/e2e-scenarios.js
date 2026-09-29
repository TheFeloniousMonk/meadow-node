// End-to-end encryption scenarios (SPEC §8). Each `expect` is derived by hand
// from §8, independently of the reference implementation in e2e.js;
// generate-e2e.js refuses to write a vector when the implementation disagrees.
//
// A scenario builds one room with a Builder and one E2EClient per agent. The
// vector's receiver is `receiver`: its state is snapshotted at the end of the
// build, before it has received anything, and the vector checks what it makes
// of the room's events. Other agents that need to read something during the
// build (to answer a request, or to steal a session) read through a copy of
// their state, so the originals stay unreceived.
//
// Statuses: 'shown:<text>', 'missing_key', 'undecryptable', 'replayed',
// 'bad_commitment', 'unsupported' for messages (§8.7); 'accepted',
// 'discarded:<why>', 'ignored:<why>', 'request' for room.keys (§8.5, §8.6).
// `answers` gives, per request, the index M the owner shares each asked-for
// session from, or null (§8.6).

import { canonicalize } from '../../backend/src/proto/encoding.js';
import { dmKey } from '../../backend/src/proto/event.js';
import { Builder } from './builder.js';
import { E2EClient, OLM, wasm } from './e2e.js';

export function world() {
  const b = new Builder();
  const clients = {};
  const bundles = {};
  const add = (name) => {
    const a = b.agent(name);
    clients[name] = new E2EClient(a);
    bundles[a.id] = clients[name].bundle;
    return clients[name];
  };
  const events = () => b.steps.map((s) => s.event);
  // What `name` would make of the room now, through a throwaway copy of its state.
  const peek = (name, roomType) => {
    const copy = E2EClient.fromSnapshot(clients[name].agent, clients[name].snapshot());
    return { copy, ...copy.receive(events(), roomType, bundles) };
  };
  return { b, clients, bundles, add, events, peek };
}

const sessionOf = (w, label) => JSON.parse(w.b.steps.find((s) => s.label === label).event.content).session;

// A private room with `names` joined (the first creates it and invites the rest).
function privateRoom(w, names) {
  const [owner, ...rest] = names.map((n) => w.add(n));
  w.b.create('create', owner.agent, { type: 'private' });
  w.b.join(`${owner.agent.name}-join`, owner.agent);
  for (const c of rest) {
    w.b.member(`invite-${c.agent.name}`, owner.agent, c.agent, 'invite');
    w.b.join(`${c.agent.name}-join`, c.agent);
  }
  return [owner, ...rest];
}

export const e2eScenarios = [
  {
    name: 'dm-offline-start',
    description: 'Alice opens a DM with Bob, who has no membership yet, and writes twice: dm_with is a recipient before joining, so Bob reads both once he has joined. Bob replies on his own session, which Alice shares nothing about to Bob.',
    sections: ['8.4', '8.5', '8.7', '8.8'],
    roomType: 'dm',
    receiver: 'bob',
    build(w) {
      const alice = w.add('alice');
      const bob = w.add('bob');
      w.b.create('create', alice.agent, { type: 'dm', dm_with: bob.id, dm_key: dmKey(alice.id, bob.id) });
      w.b.join('alice-join', alice.agent);
      alice.post(w.b, 'alice-1', 'are you there?', w.bundles, { shareLabel: 'alice-keys' });
      alice.post(w.b, 'alice-2', 'no rush', w.bundles);
      w.b.join('bob-join', bob.agent);
      bob.post(w.b, 'bob-1', 'here now', w.bundles, { shareLabel: 'bob-keys' });
    },
    // alice-keys: one share of Alice's session, to Bob (the only recipient), form session: accepted.
    // alice-1, alice-2: indexes 0 and 1 of that session: shown. Bob's own events are not checked.
    expect: () => ({
      statuses: { 'alice-keys': 'accepted', 'alice-1': 'shown:are you there?', 'alice-2': 'shown:no rush' },
    }),
  },
  {
    name: 'invitee-reads-after-joining',
    description: 'An invitee is a recipient (§8.4): Alice writes while Bob is only invited, Bob joins, and Alice writes again on the same session (the recipient set did not change). Bob reads both.',
    sections: ['8.4'],
    roomType: 'private',
    receiver: 'bob',
    build(w) {
      const alice = w.add('alice');
      const bob = w.add('bob');
      w.b.create('create', alice.agent, { type: 'private' });
      w.b.join('alice-join', alice.agent);
      w.b.member('invite-bob', alice.agent, bob.agent, 'invite');
      alice.post(w.b, 'before-join', 'welcome', w.bundles, { shareLabel: 'alice-keys' });
      w.b.join('bob-join', bob.agent);
      alice.post(w.b, 'after-join', 'glad you came', w.bundles);
    },
    // Bob in the recipient set as invitee and as member: the same set {bob}, so no rotation and no second share.
    expect: () => ({
      statuses: { 'alice-keys': 'accepted', 'before-join': 'shown:welcome', 'after-join': 'shown:glad you came' },
    }),
  },
  {
    name: 'removed-member',
    description: 'Alice removes Carol, then writes: the recipient set changed, so Alice rotates and shares the new session with Bob only. Carol reads what came before her removal and nothing after.',
    sections: ['8.4'],
    roomType: 'private',
    receiver: 'carol',
    build(w) {
      const [alice] = privateRoom(w, ['alice', 'bob', 'carol']);
      alice.post(w.b, 'before', 'hello both', w.bundles, { shareLabel: 'keys-1' });
      w.b.member('remove-carol', alice.agent, w.clients.carol.agent, 'leave');
      alice.post(w.b, 'after', 'just us now', w.bundles, { shareLabel: 'keys-2' });
    },
    // keys-1 names Carol: accepted. keys-2 names only Bob: ignored:not_for_me. 'after' is on the second session: missing_key.
    expect: () => ({
      statuses: { 'keys-1': 'accepted', before: 'shown:hello both', 'keys-2': 'ignored:not_for_me', after: 'missing_key' },
    }),
  },
  {
    name: 'late-key',
    description: 'A message arrives before its key: it is missing_key until the key arrives, then shown. The key is shared from index 0 with a proof, so it covers the message.',
    sections: ['8.5', '8.7'],
    roomType: 'private',
    receiver: 'bob',
    build(w) {
      const [alice] = privateRoom(w, ['alice', 'bob']);
      alice.post(w.b, 'early', 'key follows', w.bundles, { skipShare: true });
      alice.share(w.b, 'late-keys', w.bundles, { form: 'export', from: 0 });
    },
    // early (index 0) waits; late-keys is an export from 0 with a valid proof: accepted; early is then shown.
    expect: () => ({ statuses: { early: 'shown:key follows', 'late-keys': 'accepted' } }),
  },
  {
    name: 'key-from-a-later-index',
    description: 'A key shared from the session\'s current index does not cover earlier messages: those stay missing_key, and later ones are shown.',
    sections: ['8.5', '8.7'],
    roomType: 'private',
    receiver: 'bob',
    build(w) {
      const [alice] = privateRoom(w, ['alice', 'bob']);
      alice.post(w.b, 'first', 'one', w.bundles, { skipShare: true });
      alice.share(w.b, 'keys-at-1', w.bundles);
      alice.post(w.b, 'second', 'two', w.bundles);
    },
    // keys-at-1 is form session at index 1. first is index 0: missing_key. second is index 1: shown.
    expect: () => ({ statuses: { first: 'missing_key', 'keys-at-1': 'accepted', second: 'shown:two' } }),
  },
  {
    name: 'misaddressed-shares',
    description: 'Shares whose sealed plaintext names the wrong recipient, room, sender, or session, or has no creation proof, are discarded. The message on that session stays missing_key.',
    sections: ['8.5'],
    roomType: 'private',
    receiver: 'bob',
    build(w) {
      const [alice, bob, carol] = privateRoom(w, ['alice', 'bob', 'carol']);
      const to = [bob.id];
      alice.share(w.b, 'wrong-recipient', w.bundles, { to, tamper: (pt) => ({ ...pt, recipient: carol.id }) });
      alice.share(w.b, 'wrong-room', w.bundles, { to, tamper: (pt) => ({ ...pt, room: 'r_' + 'A'.repeat(43) }) });
      alice.share(w.b, 'wrong-sender', w.bundles, { to, tamper: (pt) => ({ ...pt, sender: carol.id }) });
      alice.share(w.b, 'wrong-session', w.bundles, { to, tamper: (pt) => ({ ...pt, session: 'not-this-one' }) });
      alice.share(w.b, 'wrong-type', w.bundles, { to, tamper: (pt) => ({ ...pt, t: 'meadow.something_else' }) });
      alice.share(w.b, 'export-without-proof', w.bundles, { to, form: 'export', tamper: ({ proof, ...pt }) => pt });
      alice.share(w.b, 'export-as-session', w.bundles, { to, form: 'export', tamper: (pt) => ({ ...pt, form: 'session' }) });
      alice.share(w.b, 'not-for-bob', w.bundles, { to: [carol.id] });
      alice.post(w.b, 'message', 'unreadable', w.bundles, { skipShare: true });
    },
    // Each tampered share fails one §8.5 check; 'export-as-session' puts an unsigned export where a signed key must be.
    expect: () => ({
      statuses: {
        'wrong-recipient': 'discarded:recipient', 'wrong-room': 'discarded:room', 'wrong-sender': 'discarded:sender',
        'wrong-session': 'discarded:session', 'wrong-type': 'discarded:type', 'export-without-proof': 'discarded:proof',
        'export-as-session': 'discarded:proof', 'not-for-bob': 'ignored:not_for_me', message: 'missing_key',
      },
    }),
  },
  {
    name: 'stolen-session',
    description: 'Carol holds Alice\'s session, as every member does, and re-shares it to Bob as her own, then reposts Alice\'s ciphertext as her message. Her share has no valid creation proof, so it is discarded, and her repost finds no session under her name.',
    sections: ['8.5', '8.7'],
    roomType: 'private',
    receiver: 'bob',
    build(w) {
      const [alice, bob, carol] = privateRoom(w, ['alice', 'bob', 'carol']);
      alice.post(w.b, 'alice-says', 'I said this', w.bundles, { shareLabel: 'alice-keys' });
      const { copy } = w.peek('carol', 'private');
      const session = sessionOf(w, 'alice-keys');
      const stolen = copy.inbound.get(`${w.b.room.id}|${alice.id}|${session}`);
      const forge = (label, pt) => {
        const content = canonicalize({ alg: OLM, kind: 'share', session, to: [carol.olmSendForTest(bob.id, w.bundles, canonicalize(pt))] });
        w.b.add(label, carol.agent, 'room.keys', { content });
      };
      const base = { t: 'meadow.room_key', room: w.b.room.id, sender: carol.id, recipient: bob.id, session };
      forge('as-session', { ...base, form: 'session', key: stolen.exportAt(0) });
      forge('as-export-no-proof', { ...base, form: 'export', key: stolen.exportAt(0) });
      forge('as-export-own-proof', { ...base, form: 'export', key: stolen.exportAt(0), proof: new wasm.GroupSession().sessionKey });
      carol.repost(w.b, 'carol-claims', w.b.id('alice-says'));
    },
    // as-session: an export is not a signed key: discarded:proof. as-export-no-proof: discarded:proof.
    // as-export-own-proof: the proof is for another session: discarded:session. carol-claims: no session under Carol: missing_key.
    expect: () => ({
      statuses: {
        'alice-keys': 'accepted', 'alice-says': 'shown:I said this', 'as-session': 'discarded:proof',
        'as-export-no-proof': 'discarded:proof', 'as-export-own-proof': 'discarded:session', 'carol-claims': 'missing_key',
      },
    }),
  },
  {
    name: 'replayed-index',
    description: 'Alice posts one ciphertext in two events. Of the events at one (session, index), the one with the lowest event ID is shown and the other is replayed.',
    sections: ['8.7'],
    roomType: 'private',
    receiver: 'bob',
    build(w) {
      const [alice] = privateRoom(w, ['alice', 'bob']);
      alice.post(w.b, 'original', 'once', w.bundles, { shareLabel: 'alice-keys' });
      alice.repost(w.b, 'copy', w.b.id('original'));
    },
    expect: (w) => {
      const [first, second] = [w.b.id('original'), w.b.id('copy')].sort();
      const label = (id) => (id === w.b.id('original') ? 'original' : 'copy');
      return { statuses: { 'alice-keys': 'accepted', [label(first)]: 'shown:once', [label(second)]: 'replayed' } };
    },
  },
  {
    name: 'bad-messages',
    description: 'A message whose commitment does not open to its body, one under an unknown algorithm, and one whose ciphertext is corrupted.',
    sections: ['8.7', '9.1'],
    roomType: 'private',
    receiver: 'bob',
    build(w) {
      const [alice] = privateRoom(w, ['alice', 'bob']);
      alice.post(w.b, 'fine', 'ok', w.bundles, { shareLabel: 'alice-keys' });
      alice.post(w.b, 'wrong-commitment', 'said one thing', w.bundles, { commitmentOf: { text: 'committed to another' } });
      alice.post(w.b, 'body-not-committed', 'visible text', w.bundles, { innerBody: { text: 'a different body' } });
      alice.post(w.b, 'unknown-alg', 'future', w.bundles, { alg: 'megolm.v9' });
      alice.post(w.b, 'corrupted', 'garbled', w.bundles, { corrupt: (c) => c.slice(0, 20) + (c[20] === 'A' ? 'B' : 'A') + c.slice(21) });
    },
    // wrong-commitment: the header commits to another body. body-not-committed: the sealed body is not the one committed.
    // unknown-alg: unsupported. corrupted: a flipped character: undecryptable.
    expect: () => ({
      statuses: {
        'alice-keys': 'accepted', fine: 'shown:ok', 'wrong-commitment': 'bad_commitment',
        'body-not-committed': 'bad_commitment', 'unknown-alg': 'unsupported', corrupted: 'undecryptable',
      },
    }),
  },
  {
    name: 'restore-recovered-by-request',
    description: 'Bob lacks Alice\'s session key: the share reached him without content. He asks for it (§8.6); Alice, finding him a recipient for every message, shares it again from index 0 with a proof, and Bob reads everything.',
    sections: ['8.6'],
    roomType: 'private',
    receiver: 'bob',
    withhold: ['alice-keys'],
    build(w) {
      const [alice, bob] = privateRoom(w, ['alice', 'bob']);
      alice.post(w.b, 'one', 'first', w.bundles, { shareLabel: 'alice-keys' });
      alice.post(w.b, 'two', 'second', w.bundles);
      const session = sessionOf(w, 'alice-keys');
      bob.request(w.b, 'bob-asks', alice.id, [{ session, from: 0 }], w.bundles);
      const { requests } = w.peek('alice', 'private');
      const req = requests.get(w.b.id('bob-asks'));
      alice.answer(w.b, 'alice-answers', req.requester, req.sessions, w.bundles);
    },
    // alice-keys arrives without content: ignored. one, two wait. The answer (export from 0, proof) is accepted: both shown.
    expect: (w) => ({
      statuses: {
        'alice-keys': 'ignored:no_content', one: 'shown:first', two: 'shown:second',
        [w.b.steps.find((s) => s.label.startsWith('alice-answers')).label]: 'accepted',
      },
    }),
  },
  {
    name: 'late-joiner-entitlement',
    description: 'Alice keeps one session across Carol\'s invite (a sender that did not rotate). Carol asks for it from index 0; Alice shares it only from index 1, the first message Carol was a recipient for (while only invited), so Carol reads the later messages and not the earlier one.',
    sections: ['8.6'],
    roomType: 'private',
    receiver: 'carol',
    build(w) {
      const [alice] = privateRoom(w, ['alice', 'bob']);
      const carol = w.add('carol');
      alice.post(w.b, 'm0', 'before carol', w.bundles, { shareLabel: 'alice-keys' });
      w.b.member('invite-carol', alice.agent, carol.agent, 'invite');
      alice.post(w.b, 'm1', 'carol is invited', w.bundles, { noRotate: true });
      w.b.join('carol-join', carol.agent);
      alice.post(w.b, 'm2', 'carol is here', w.bundles, { noRotate: true });
      const session = sessionOf(w, 'alice-keys');
      carol.request(w.b, 'carol-asks', alice.id, [{ session, from: 0 }], w.bundles);
      const { requests } = w.peek('alice', 'private');
      const req = requests.get(w.b.id('carol-asks'));
      alice.answer(w.b, 'alice-answers', req.requester, req.sessions, w.bundles);
    },
    // m0's state-before lacks Carol; m1's has her invited (a recipient, §8.4), m2's joined. Entitled suffix: m1, m2. M = 1.
    // alice-keys named only Bob: ignored:not_for_me. Carol: m0 missing_key (index 0 < 1), m1 and m2 shown.
    expect: (w) => ({
      statuses: {
        'alice-keys': 'ignored:not_for_me', m0: 'missing_key', m1: 'shown:carol is invited', m2: 'shown:carol is here',
        [w.b.steps.find((s) => s.label.startsWith('alice-answers')).label]: 'accepted',
      },
    }),
  },
  {
    name: 'late-joiner-owner-side',
    description: "The owner's side of late-joiner-entitlement: Alice, finding Carol a recipient (invited) from index 1 of the session and not before, answers Carol's request from 0 with M = 1.",
    sections: ['8.4', '8.6'],
    roomType: 'private',
    receiver: 'alice',
    build(w) {
      return e2eScenarios.find((x) => x.name === 'late-joiner-entitlement').build(w);
    },
    // The only event from another agent that Alice judges is the request. m0's state-before lacks Carol; m1's has her invited.
    expect: () => ({ statuses: { 'carol-asks': 'request' }, answers: { 'carol-asks': [1] } }),
  },
  {
    name: 'requests-refused',
    description: 'The owner\'s side (§8.6): a removed member\'s request gets nothing; a member who joined after a session was used gets nothing for it; a request whose sealed requester or owner is wrong is discarded.',
    sections: ['8.6'],
    roomType: 'private',
    receiver: 'alice',
    build(w) {
      const [alice, bob, carol] = privateRoom(w, ['alice', 'bob', 'carol']);
      const dave = w.add('dave');
      alice.post(w.b, 'm0', 'three of us', w.bundles, { shareLabel: 'keys-1' });
      const s1 = sessionOf(w, 'keys-1');
      w.b.member('remove-carol', alice.agent, carol.agent, 'leave');
      // Carol writes from before her removal. A conforming node soft-fails this and serves it
      // without content; the vector serves it anyway, to test the owner's own check.
      carol.request(w.b, 'carol-asks', alice.id, [{ session: s1, from: 0 }], w.bundles, { parents: ['m0'] });
      w.b.member('invite-dave', alice.agent, dave.agent, 'invite');
      w.b.join('dave-join', dave.agent);
      dave.request(w.b, 'dave-asks', alice.id, [{ session: s1, from: 0 }], w.bundles);
      bob.request(w.b, 'forged-requester', alice.id, [{ session: s1, from: 0 }], w.bundles, { tamper: (pt) => ({ ...pt, requester: dave.id }) });
      bob.request(w.b, 'wrong-owner', alice.id, [{ session: s1, from: 0 }], w.bundles, { tamper: (pt) => ({ ...pt, owner: bob.id }) });
      bob.request(w.b, 'bob-asks', alice.id, [{ session: s1, from: 0 }], w.bundles);
    },
    // carol-asks: Carol is not a recipient now: null. dave-asks: Dave is a recipient now, but m0's state-before lacks him: null.
    // forged-requester, wrong-owner: discarded. bob-asks: Bob was a recipient for m0 and is now: M = 0.
    expect: () => ({
      statuses: {
        'carol-asks': 'request', 'dave-asks': 'request', 'forged-requester': 'discarded:requester',
        'wrong-owner': 'discarded:owner', 'bob-asks': 'request',
      },
      answers: { 'carol-asks': [null], 'dave-asks': [null], 'bob-asks': [0] },
    }),
  },
];
