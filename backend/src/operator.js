// Operator review and takedown (SPEC §9.5). Runs on the node's own server and
// has no network surface:
//   docker exec meadow-backend node src/operator.js <main|beta> <command> [arguments]
// It works on the network's database while the node runs (WAL, busy timeout);
// the node reads content from the database on every request, so changes take
// effect without a restart. Output is one JSON object per command.
//
// Commands:
//   reports [--all] [--limit N]                  open reports, newest first (--all: every held report)
//   report <p_…>                                 one report in full, verified again
//   takedown <e_…> [--report <p_…>] [--note …]   drop an event's content on this node
//   dismiss <p_…> [--note …]                     resolve a report with no action
//   takedowns [--limit N]                        the takedown log, newest first
//   restore <e_…>                                withdraw a takedown
//   peers                                        peers and discovery, from the node's latest health snapshot (§9.6)
//   alert-test                                   post a test health report to MEADOW_ALERT_WEBHOOK (§9.6)

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isEventId } from './proto/event.js';
import { verifyReport } from './proto/report.js';
import { CONTENT_KINDS, SCHEMA } from './store/store.js';
import { parseAlertConfig, postWebhook } from './health/alerts.js';
import { buildPayload } from './health/report.js';
import { containerStats } from './health/container.js';

export class OperatorError extends Error {}

const isReportId = (x) => typeof x === 'string' && /^p_[A-Za-z0-9_-]{43}$/.test(x);

// Parses `<positional> --flag value --switch` into { args, flags }.
export function parseArgs(argv, switches = ['--all']) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) args.push(a);
    else if (switches.includes(a)) flags[a.slice(2)] = true;
    else if (i + 1 < argv.length) flags[a.slice(2)] = argv[++i];
    else throw new OperatorError(`${a} needs a value`);
  }
  return { args, flags };
}

export function openDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

const limitOf = (flags, fallback = 50) => {
  if (flags.limit === undefined) return fallback;
  const n = Number(flags.limit);
  if (!Number.isSafeInteger(n) || n < 1 || n > 1000) throw new OperatorError('--limit is 1..1000');
  return n;
};

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

function summary(db, row) {
  const report = JSON.parse(row.report);
  const h = report.event?.header ?? {};
  const held = db.prepare('SELECT withheld FROM events WHERE id = ?').get(report.event?.id);
  const takedown = db.prepare('SELECT 1 FROM takedowns WHERE event = ?').get(report.event?.id);
  const res = db.prepare('SELECT resolution, event, at, note FROM report_resolutions WHERE id = ?').get(row.id);
  return {
    report: row.id,
    received_at: iso(row.received_at),
    reason: report.reason,
    event: report.event?.id ?? null,
    room: h.room ?? null,
    author: h.author ?? null,
    held: held !== undefined,
    taken_down: takedown !== undefined,
    source: row.reporter ? 'direct' : 'peer',
    resolution: res ? { resolution: res.resolution, at: iso(res.at), ...(res.note && { note: res.note }) } : null,
  };
}

const getReport = (db, id) => {
  if (!isReportId(id)) throw new OperatorError('give a report ID (p_…)');
  const row = db.prepare('SELECT id, report, reporter, received_at FROM reports WHERE id = ?').get(id);
  if (!row) throw new OperatorError(`no report ${id} on this node (reports are kept 30 days)`);
  return row;
};

// The node's latest health snapshot (§9.6), written every 5 minutes and at each alert check.
function healthSnapshot(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'health'").get();
  if (!row) throw new OperatorError('no health snapshot yet: the node writes one a minute after it starts (node 0.6.0 or later)');
  return JSON.parse(row.value);
}

const COMMANDS = {
  peers(db) {
    const s = healthSnapshot(db);
    return {
      snapshot_at: iso(s.at),
      node: s.node,
      discovery: { ...s.discovery, last_run: iso(s.discovery.last_run), last_error: s.discovery.last_error && { text: s.discovery.last_error.text, at: iso(s.discovery.last_error.at) } },
      peers: s.peers.map((p) => ({
        node: p.id, host: p.host, source: p.source, banned: p.banned, banned_until: iso(p.banned_until),
        penalty: p.penalty, last_penalty: p.last_penalty && { reason: p.last_penalty.reason, at: iso(p.last_penalty.at) },
        last_ok: iso(p.last_ok), failures: p.failures, last_error: p.last_error && { text: p.last_error.text, at: iso(p.last_error.at) },
      })),
      issues: s.issues,
    };
  },

  reports(db, { flags }) {
    const rows = db.prepare(`SELECT r.id, r.report, r.reporter, r.received_at FROM reports r
      ${flags.all ? '' : 'WHERE NOT EXISTS (SELECT 1 FROM report_resolutions x WHERE x.id = r.id)'}
      ORDER BY r.received_at DESC, r.id LIMIT ?`).all(limitOf(flags));
    return { reports: rows.map((r) => summary(db, r)) };
  },

  report(db, { args }) {
    const row = getReport(db, args[0]);
    const report = JSON.parse(row.report);
    const v = verifyReport(report);
    const stored = db.prepare('SELECT content, withheld FROM events WHERE id = ?').get(report.event?.id);
    // What the author wrote: the opened body (private rooms), or the content this node holds (public rooms).
    let written;
    if (report.body !== undefined) written = { from: 'report', body: report.body };
    else if (stored?.content != null) written = { from: 'node', content: stored.content };
    else written = { from: null, withheld: stored?.withheld ?? null, held: stored !== undefined };
    return {
      ...summary(db, row),
      verified: v.id === row.id,
      ...(v.id ? {} : { verify_reason: v.reason }),
      ...(row.reporter && { reporter: row.reporter }),
      ...(report.note !== undefined && { note: report.note }),
      header: report.event?.header ?? null,
      written,
    };
  },

  takedown(db, { args, flags }, now) {
    const id = args[0];
    if (!isEventId(id)) throw new OperatorError('give an event ID (e_…)');
    if (flags.report !== undefined) {
      const reported = JSON.parse(getReport(db, flags.report).report).event?.id;
      if (reported !== id) throw new OperatorError(`${flags.report} reports ${reported}, not ${id}`);
    }
    const row = db.prepare('SELECT event, withheld FROM events WHERE id = ?').get(id);
    const kind = row ? JSON.parse(row.event).header.kind : null;
    if (row && !CONTENT_KINDS.has(kind)) throw new OperatorError(`${id} is a ${kind}, which carries no content`);
    const already = db.prepare('SELECT at FROM takedowns WHERE event = ?').get(id);
    db.exec('BEGIN');
    try {
      if (!already) {
        db.prepare('INSERT INTO takedowns (event, at, report, note) VALUES (?, ?, ?, ?)')
          .run(id, now, flags.report ?? null, flags.note ?? null);
        // Content already withheld by its author or a moderator stays so; it is gone either way.
        db.prepare(`UPDATE events SET content = NULL, withheld = 'operator' WHERE id = ? AND withheld IS NULL`).run(id);
        db.prepare('DELETE FROM content_gaps WHERE id = ?').run(id); // never repaired while taken down
      }
      if (flags.report !== undefined) {
        db.prepare(`INSERT OR REPLACE INTO report_resolutions (id, resolution, event, at, note) VALUES (?, 'takedown', ?, ?, ?)`)
          .run(flags.report, id, now, flags.note ?? null);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    const after = db.prepare('SELECT withheld FROM events WHERE id = ?').get(id);
    return {
      event: id,
      held: row !== undefined,
      already_down: already !== undefined,
      withheld: after?.withheld ?? null,
      ...(flags.report !== undefined && { report: flags.report, resolution: 'takedown' }),
      ...(row ? {} : { note: 'not held here yet: its content will never be stored' }),
    };
  },

  dismiss(db, { args, flags }, now) {
    const row = getReport(db, args[0]);
    db.prepare(`INSERT OR REPLACE INTO report_resolutions (id, resolution, event, at, note) VALUES (?, 'dismissed', NULL, ?, ?)`)
      .run(row.id, now, flags.note ?? null);
    return { report: row.id, resolution: 'dismissed' };
  },

  takedowns(db, { flags }) {
    const rows = db.prepare('SELECT event, at, report, note FROM takedowns ORDER BY at DESC, event LIMIT ?').all(limitOf(flags));
    return {
      takedowns: rows.map((r) => ({ event: r.event, at: iso(r.at), report: r.report, ...(r.note && { note: r.note }) })),
    };
  },

  restore(db, { args }) {
    const id = args[0];
    if (!isEventId(id)) throw new OperatorError('give an event ID (e_…)');
    const removed = Number(db.prepare('DELETE FROM takedowns WHERE event = ?').run(id).changes) > 0;
    if (!removed) throw new OperatorError(`${id} is not taken down`);
    const row = db.prepare('SELECT room, content, withheld, received_at FROM events WHERE id = ?').get(id);
    // Replication asks peers for the dropped content (§11.3).
    if (row && row.content == null && row.withheld === 'operator') {
      db.prepare('INSERT OR IGNORE INTO content_gaps (id, room, received_at) VALUES (?, ?, ?)').run(id, row.room, row.received_at);
    }
    return {
      event: id,
      restored: true,
      held: row !== undefined,
      content_restored: row?.content != null,
      note: row
        ? 'the content was dropped from this node; replication asks peers for it, and it returns if a peer still holds it'
        : 'not held here: a later copy will be stored normally',
    };
  },
};

// alert-test (§9.6): the latest snapshot and the container's figures now, posted as a test report,
// so a wrong webhook URL shows at once. Async, unlike the other commands.
export async function alertTest(db, network, { env = process.env, post = null, dataDir = env.MEADOW_DATA_DIR ?? 'data' } = {}) {
  const config = parseAlertConfig(env);
  if (!config) throw new OperatorError('MEADOW_ALERT_WEBHOOK is not set in this container');
  const snap = healthSnapshot(db);
  const c = containerStats(dataDir, [network]);
  const { payload } = buildPayload([snap], { ...c, networkInterval: null, networkTotal: null, interval_ms: 0 }, {
    note: `Test report from the ${network} node (latest snapshot, ${iso(snap.at)}).`,
  });
  const res = await (post ?? ((p) => postWebhook(config.webhook, p)))(payload);
  return res.ok ? { posted: true, status: res.status } : { posted: false, error: res.error };
}

export function operate(db, command, argv = [], now = Date.now()) {
  const fn = COMMANDS[command];
  if (!fn) throw new OperatorError(`unknown command "${command}"; use ${[...Object.keys(COMMANDS), 'alert-test'].join(', ')}`);
  return fn(db, parseArgs(argv), now);
}

async function main() {
  const [network, command, ...rest] = process.argv.slice(2);
  const print = (value) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  try {
    if (!['main', 'beta'].includes(network) || !command) {
      throw new OperatorError('usage: node src/operator.js <main|beta> <command> [arguments]');
    }
    const path = join(process.env.MEADOW_DATA_DIR ?? 'data', `meadow-${network}.db`);
    if (!existsSync(path)) throw new OperatorError(`no database at ${path}; is the ${network} node running here?`);
    const db = openDatabase(path);
    try {
      print(command === 'alert-test' ? await alertTest(db, network) : operate(db, command, rest));
    } finally {
      db.close();
    }
  } catch (err) {
    if (!(err instanceof OperatorError) && err.name !== 'AlertConfigError') throw err;
    print({ error: err.message });
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
