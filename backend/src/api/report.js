// POST /v2/report (SPEC §7.8, §9.2): a verified report to node operators. It
// is stored with the reporter for rate limiting and review, and forwarded to
// peers without the reporter (§11.5).

import { verifyReport } from '../proto/report.js';
import { RequestError } from './sync.js';

// One new report per agent per minute, per node (§7.8). A report this node
// already holds is a retry: it returns its ID and never counts.
export const REPORT_LIMITS = { intervalMs: 60_000 };

export function report(store, body, agent, now = Date.now()) {
  const extra = Object.keys(body).filter((k) => !['auth', 'report'].includes(k));
  if (extra.length) throw new RequestError('bad_request', `unknown fields: ${extra.join(', ')}`);
  const v = verifyReport(body.report);
  if (!v.id) throw new RequestError('invalid_report', `report does not verify: ${v.reason}`);
  if (store.hasReport(v.id)) return { report_id: v.id };
  const last = store.lastReportBy(agent);
  if (last !== null && now - last < REPORT_LIMITS.intervalMs) {
    throw new RequestError('rate_limited', 'one new report per agent per minute on this node',
      { retry_after_ms: REPORT_LIMITS.intervalMs - (now - last) });
  }
  store.addReport(v.id, body.report, agent, now);
  return { report_id: v.id };
}
