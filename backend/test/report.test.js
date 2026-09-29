import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Builder } from '../../conformance/tools/builder.js';
import { report, REPORT_LIMITS } from '../src/api/report.js';
import { RequestError } from '../src/api/sync.js';
import { reportId } from '../src/proto/report.js';
import { Store } from '../src/store/store.js';

const strip = (ev) => ({ header: ev.header, id: ev.id, sig: ev.sig });

// Three public posts by carol, each reportable.
function posts() {
  const b = new Builder();
  const carol = b.agent('carol');
  b.create('create', carol, { type: 'public' });
  b.join('join', carol);
  return ['one', 'two', 'three'].map((t) => {
    b.post(t, carol, t);
    return { event: strip(b.steps.at(-1).event), reason: 'spam' };
  });
}

const reporter = 'a_' + 'R'.repeat(43);
const other = 'a_' + 'S'.repeat(43);

const refused = (fn) => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof RequestError);
    return err;
  }
  assert.fail('expected a refusal');
};

test('one new report per agent per minute; the refusal says when to retry', () => {
  const store = new Store();
  const [a, b, c] = posts();
  const t0 = 1_790_000_000_000;
  assert.equal(report(store, { report: a }, reporter, t0).report_id, reportId(a));

  const err = refused(() => report(store, { report: b }, reporter, t0 + 20_000));
  assert.equal(err.code, 'rate_limited');
  assert.equal(err.details.retry_after_ms, REPORT_LIMITS.intervalMs - 20_000);
  assert.equal(store.hasReport(reportId(b)), false, 'a refused report is not stored');

  // Another agent is not limited by the first one's report.
  assert.equal(report(store, { report: b }, other, t0 + 20_000).report_id, reportId(b));
  // After a minute, the first agent may report again.
  assert.equal(report(store, { report: c }, reporter, t0 + REPORT_LIMITS.intervalMs).report_id, reportId(c));
});

test('resubmitting a held report returns its ID and never counts', () => {
  const store = new Store();
  const [a, b, c] = posts();
  const t0 = 1_790_000_000_000;
  report(store, { report: a }, reporter, t0);
  // A gateway retry, seconds later, is answered.
  assert.equal(report(store, { report: a }, reporter, t0 + 1_000).report_id, reportId(a));
  // A report already held from a peer is answered too, without counting.
  store.addReport(reportId(b), b, null, t0);
  assert.equal(report(store, { report: b }, other, t0 + 1_000).report_id, reportId(b));
  assert.equal(report(store, { report: c }, other, t0 + 2_000).report_id, reportId(c), 'the resubmission did not count');
});

test('invalid reports are refused before the limit is checked', () => {
  const store = new Store();
  const [a] = posts();
  const t0 = 1_790_000_000_000;
  report(store, { report: a }, reporter, t0);
  const err = refused(() => report(store, { report: { ...a, reason: 'boring' } }, reporter, t0 + 1_000));
  assert.equal(err.code, 'invalid_report');
});
