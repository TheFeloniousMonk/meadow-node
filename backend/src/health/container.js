// The container's own figures for the health report (SPEC §9.6): network
// interface totals, disk, and memory. Each is left out where it can't be read
// (for example /proc and cgroups off Linux).

import { readFileSync, statSync, statfsSync } from 'node:fs';
import { join } from 'node:path';

const read = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

/** { in, out } bytes over every interface but loopback, from /proc/net/dev; null if unreadable. */
export function networkTotals(text = read('/proc/net/dev')) {
  if (!text) return null;
  let rx = 0;
  let tx = 0;
  for (const line of text.split('\n').slice(2)) {
    const [name, rest] = line.split(':');
    if (!rest || name.trim() === 'lo') continue;
    const f = rest.trim().split(/\s+/).map(Number);
    rx += f[0] || 0;
    tx += f[8] || 0;
  }
  return { in: rx, out: tx };
}

const size = (path) => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

/** Each network's database with its write-ahead log, and the data volume's space. */
export function disk(dataDir, networks) {
  const databases = networks.map((n) => {
    const db = join(dataDir, `meadow-${n}.db`);
    return { network: n, bytes: size(db), wal: size(db + '-wal') + size(db + '-shm') };
  });
  let volume = null;
  try {
    const s = statfsSync(dataDir);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    volume = { total, free, used: total - s.bfree * s.bsize };
    volume.percent = total ? Math.round((volume.used / total) * 100) : null;
  } catch { /* not available here */ }
  return { databases, volume };
}

/** The process's resident memory, and the container's limit when cgroups say. */
export function memory() {
  const rss = process.memoryUsage().rss;
  let limit = null;
  const v2 = read('/sys/fs/cgroup/memory.max')?.trim();
  const v1 = read('/sys/fs/cgroup/memory/memory.limit_in_bytes')?.trim();
  const raw = v2 ?? v1;
  if (raw && raw !== 'max') {
    const n = Number(raw);
    // cgroup v1 reports "no limit" as a huge number.
    if (Number.isFinite(n) && n > 0 && n < 2 ** 60) limit = n;
  }
  return { rss, limit, percent: limit ? Math.round((rss / limit) * 100) : null };
}

/** Everything the container embed shows; `net` holds the totals at start, for "since start". */
export function containerStats(dataDir, networks) {
  return { network: networkTotals(), disk: disk(dataDir, networks), memory: memory() };
}
