// Message franking and report verification (SPEC §9.1, §9.2).

import { createHmac } from 'node:crypto';
import { b64u, canonicalize, fromB64u, sha256 } from './encoding.js';
import { checkWellFormed } from './event.js';

export const REPORT_REASONS = new Set(['spam', 'abuse', 'illegal', 'other']);
const REPORT_FIELDS = ['event', 'body', 'k_f', 'reason', 'note'];

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

// commitment = HMAC-SHA256(k_f, JCS(body))
export function commitment(kf, body) {
  return b64u(createHmac('sha256', kf).update(canonicalize(body)).digest());
}

export function reportId(report) {
  return 'p_' + b64u(sha256(canonicalize(report)));
}

// Returns { id } for a valid report, else { reason }. Needs nothing but the
// report itself: the reported header is signed and carries the commitment.
export function verifyReport(report) {
  if (!isObject(report) || !Object.keys(report).every((k) => REPORT_FIELDS.includes(k))) return { reason: 'malformed' };
  if (!REPORT_REASONS.has(report.reason)) return { reason: 'malformed' };
  if (report.note !== undefined && (typeof report.note !== 'string' || Buffer.byteLength(report.note, 'utf8') > 1024)) {
    return { reason: 'malformed' };
  }
  const ev = report.event;
  if (!isObject(ev) || ev.content !== undefined || checkWellFormed(ev) !== null) return { reason: 'bad_event' };
  if (ev.header.kind !== 'msg.post') return { reason: 'not_a_message' };

  if (ev.header.commitment === undefined) {
    if (report.body !== undefined || report.k_f !== undefined) return { reason: 'malformed' };
  } else {
    const kf = fromB64u(report.k_f);
    if (!kf || kf.length !== 32 || !isObject(report.body)) return { reason: 'malformed' };
    let opened;
    try {
      opened = commitment(kf, report.body);
    } catch {
      return { reason: 'malformed' };
    }
    if (opened !== ev.header.commitment) return { reason: 'bad_opening' };
  }

  let canonical;
  try {
    canonical = canonicalize(report);
  } catch {
    return { reason: 'malformed' };
  }
  if (Buffer.byteLength(canonical, 'utf8') > 128 * 1024) return { reason: 'malformed' };
  return { id: reportId(report) };
}
