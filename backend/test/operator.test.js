import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Builder } from '../../conformance/tools/builder.js';
import { reportId } from '../src/proto/report.js';
import { openDatabase, operate, OperatorError } from '../src/operator.js';
import { Store } from '../src/store/store.js';

const OPERATOR = fileURLToPath(new URL('../src/operator.js', import.meta.url));
const strip = (ev) => ({ header: ev.header, id: ev.id, sig: ev.sig });

// A node database on disk, with a public post (reported directly, by dave) and a
// private post (reported through a peer, so without a reporter). The operator
// command gets its own connection to the same file, as in production.
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'meadow-op-'));
  const path = join(dir, 'meadow-beta.db');
  const store = new Store(path);

  const pub = new Builder();
  const carol = pub.agent('carol');
  pub.create('create', carol, { type: 'public' });
  pub.join('join', carol);
  pub.post('rude', carol, 'something rude');
  pub.post('fine', carol, 'something fine');

  const priv = new Builder();
  const alice = priv.agent('alice');
  const bob = priv.agent('bob');
  priv.create('create', alice, { type: 'private' });
  priv.join('join', alice);
  priv.member('invite', alice, bob, 'invite');
  priv.join('bob-join', bob);
  priv.sealed('secret', bob, 'something illegal');
  for (const b of [pub, priv]) for (const s of b.steps) assert.equal(store.ingest(s.event).outcome, 'accepted', s.label);

  const ev = (b, label) => b.steps.find((s) => s.label === label).event;
  const publicReport = { event: strip(ev(pub, 'rude')), reason: 'abuse' };
  const privateReport = { event: strip(ev(priv, 'secret')), ...priv.openings.get('secret'), reason: 'illegal', note: 'see this' };
  const dave = 'a_' + 'D'.repeat(43);
  store.addReport(reportId(publicReport), publicReport, dave);
  store.addReport(reportId(privateReport), privateReport, null);

  const db = openDatabase(path);
  const op = (command, ...args) => operate(db, command, args);
  const cleanup = () => {
    db.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, db, op, cleanup, pub, priv, ev, dave, publicId: reportId(publicReport), privateId: reportId(privateReport) };
}

test('reports lists open reports; report shows one in full, verified again', () => {
  const t = setup();
  try {
    const { reports } = t.op('reports');
    assert.equal(reports.length, 2);
    const byId = Object.fromEntries(reports.map((r) => [r.report, r]));
    assert.equal(byId[t.publicId].source, 'direct');
    assert.equal(byId[t.privateId].source, 'peer');
    assert.equal(byId[t.publicId].event, t.pub.id('rude'));
    assert.equal(byId[t.publicId].held, true);
    assert.equal(byId[t.publicId].taken_down, false);
    assert.equal(byId[t.publicId].resolution, null);

    const pub = t.op('report', t.publicId);
    assert.equal(pub.verified, true);
    assert.equal(pub.reporter, t.dave);
    assert.deepEqual(pub.written, { from: 'node', content: JSON.stringify({ text: 'something rude' }) });

    const priv = t.op('report', t.privateId);
    assert.equal(priv.verified, true);
    assert.equal(priv.reporter, undefined, 'a forwarded report has no reporter');
    assert.equal(priv.note, 'see this');
    assert.deepEqual(priv.written, { from: 'report', body: { text: 'something illegal' } });
  } finally {
    t.cleanup();
  }
});

test('takedown drops the content for clients and peers, and resolves the report', () => {
  const t = setup();
  try {
    const id = t.pub.id('rude');
    const res = t.op('takedown', id, '--report', t.publicId, '--note', 'abusive');
    assert.equal(res.held, true);
    assert.equal(res.already_down, false);
    assert.equal(res.withheld, 'operator');

    // The running node sees it on the next request.
    const room = t.store.room(t.pub.room.id);
    const served = t.store.serve(room, id);
    assert.equal(served.withheld, 'operator');
    assert.equal(served.content, undefined);
    assert.equal(t.store.forPeer(t.pub.room.id, id).content, undefined);
    assert.ok(t.store.serve(room, t.pub.id('fine')).content, 'other posts are untouched');

    assert.deepEqual(t.op('reports').reports.map((r) => r.report), [t.privateId]);
    const all = t.op('reports', '--all').reports.find((r) => r.report === t.publicId);
    assert.equal(all.taken_down, true);
    assert.equal(all.resolution.resolution, 'takedown');
    assert.deepEqual(t.op('takedowns').takedowns.map((x) => [x.event, x.report, x.note]), [[id, t.publicId, 'abusive']]);
    assert.equal(t.op('takedown', id).already_down, true);
    assert.equal(t.op('report', t.publicId).written.withheld, 'operator');
  } finally {
    t.cleanup();
  }
});

test('a takedown made before the event arrives means its content is never stored', () => {
  const t = setup();
  try {
    const b = new Builder();
    const erin = b.agent('erin');
    b.create('create', erin, { type: 'public' });
    b.join('join', erin);
    const id = b.post('later', erin, 'arrives later');
    const res = t.op('takedown', id, '--note', 'from a peer report');
    assert.equal(res.held, false);

    for (const s of b.steps) assert.equal(t.store.ingest(s.event).outcome, 'accepted', s.label);
    const served = t.store.serve(t.store.room(b.room.id), id);
    assert.equal(served.withheld, 'operator');
    assert.equal(t.db.prepare('SELECT content FROM events WHERE id = ?').get(id).content, null);
    // A second copy with content does not fill it either.
    t.store.ingest(b.steps.at(-1).event);
    assert.equal(t.store.serve(t.store.room(b.room.id), id).content, undefined);
  } finally {
    t.cleanup();
  }
});

test('a takedown closes a content gap; restore reopens it for repair from peers', () => {
  const t = setup();
  try {
    const id = t.pub.id('rude');
    const content = t.ev(t.pub, 'rude').content;
    t.op('takedown', id);
    assert.deepEqual(t.store.contentGaps(10), []);
    assert.equal(t.store.repairContent(id, content), 'skipped', 'taken-down content is never repaired');
    t.op('restore', id);
    assert.deepEqual(t.store.contentGaps(10), [id]);
    assert.equal(t.store.repairContent(id, 'not the content'), 'mismatch');
    assert.equal(t.store.repairContent(id, content), 'filled');
    assert.equal(t.store.serve(t.store.room(t.pub.room.id), id).content, content);
    assert.deepEqual(t.store.contentGaps(10), []);
  } finally {
    t.cleanup();
  }
});

test('restore withdraws a takedown; a later copy with content fills it', () => {
  const t = setup();
  try {
    const id = t.pub.id('rude');
    t.op('takedown', id);
    const res = t.op('restore', id);
    assert.equal(res.restored, true);
    assert.equal(res.content_restored, false);
    assert.deepEqual(t.op('takedowns').takedowns, []);
    const room = t.store.room(t.pub.room.id);
    assert.equal(t.store.serve(room, id).withheld, 'operator', 'still without content until a copy arrives');

    t.store.ingest(t.ev(t.pub, 'rude')); // a peer supplies it again, with content
    const served = t.store.serve(room, id);
    assert.equal(served.withheld, undefined);
    assert.equal(served.content, JSON.stringify({ text: 'something rude' }));
    assert.throws(() => t.op('restore', id), OperatorError);
  } finally {
    t.cleanup();
  }
});

test('an author deletion is not replaced by a takedown', () => {
  const t = setup();
  try {
    const carol = t.pub.agents.get('carol');
    t.pub.add('delete', carol, 'msg.delete', { data: { target: t.pub.id('fine') } });
    assert.equal(t.store.ingest(t.pub.steps.at(-1).event).outcome, 'accepted');
    const res = t.op('takedown', t.pub.id('fine'));
    assert.equal(res.withheld, 'author');
  } finally {
    t.cleanup();
  }
});

test('dismiss resolves without action; resolutions go with their reports, takedowns stay', () => {
  const t = setup();
  try {
    assert.equal(t.op('dismiss', t.privateId, '--note', 'not illegal').resolution, 'dismissed');
    assert.deepEqual(t.op('reports').reports.map((r) => r.report), [t.publicId]);
    t.op('takedown', t.pub.id('rude'), '--report', t.publicId);

    t.store.sweep(Date.now() + t.store.retention.reportMs + 1);
    assert.deepEqual(t.op('reports', '--all').reports, []);
    assert.equal(t.db.prepare('SELECT count(*) AS n FROM report_resolutions').get().n, 0);
    assert.equal(t.op('takedowns').takedowns.length, 1);
  } finally {
    t.cleanup();
  }
});

test('mistakes are refused', () => {
  const t = setup();
  try {
    for (const [cmd, ...args] of [
      ['nope'],
      ['report', 'p_x'],
      ['report', 'p_' + 'A'.repeat(43)],
      ['takedown', 'e_x'],
      ['takedown', t.pub.id('join')], // a state event carries no content
      ['takedown', t.pub.id('fine'), '--report', t.publicId], // that report names another event
      ['dismiss', 'p_' + 'A'.repeat(43)],
      ['reports', '--limit', '0'],
      ['takedowns', '--limit'],
    ]) {
      assert.throws(() => t.op(cmd, ...args), OperatorError, [cmd, ...args].join(' '));
    }
    assert.equal(t.op('takedowns').takedowns.length, 0, 'nothing was taken down');
  } finally {
    t.cleanup();
  }
});

test('the command line prints JSON and exits 1 on errors', () => {
  const t = setup();
  try {
    const run = (...args) => spawnSync(process.execPath, [OPERATOR, ...args], { env: { ...process.env, MEADOW_DATA_DIR: t.dir }, encoding: 'utf8' });
    const ok = run('beta', 'reports');
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).reports.length, 2);
    const bad = run('beta', 'takedown', 'e_x');
    assert.equal(bad.status, 1);
    assert.ok(JSON.parse(bad.stdout).error);
    const noDb = run('main', 'reports');
    assert.equal(noDb.status, 1);
    assert.match(JSON.parse(noDb.stdout).error, /no database/);
  } finally {
    t.cleanup();
  }
});
