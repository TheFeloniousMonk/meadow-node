// POST /v2/report (SPEC §7.8, §9.2): a verified report to node operators. It
// is stored with the reporter for rate limiting and review, and forwarded to
// peers without the reporter (§11.5).

import { verifyReport } from '../proto/report.js';
import { RequestError } from './sync.js';

export function report(store, body, agent) {
  const extra = Object.keys(body).filter((k) => !['auth', 'report'].includes(k));
  if (extra.length) throw new RequestError('bad_request', `unknown fields: ${extra.join(', ')}`);
  const v = verifyReport(body.report);
  if (!v.id) throw new RequestError('invalid_report', `report does not verify: ${v.reason}`);
  store.addReport(v.id, body.report, agent);
  return { report_id: v.id };
}
