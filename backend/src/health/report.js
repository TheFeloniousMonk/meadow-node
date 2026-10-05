// The health report as a Discord webhook message (SPEC §9.6): one embed per
// network and one for the container, within Discord's limits (10 embeds,
// 4,096 characters per description, 6,000 per message).

export const COLOURS = { ok: 0x2e9e5b, warning: 0xe0a526, problem: 0xd64545 };
const LEVEL_WORDS = { ok: 'OK', warning: 'Warning', problem: 'Problem' };
const NETWORK_NAMES = { main: 'MainNet', beta: 'Beta' };
const MAX_PEERS = 10;
const DESCRIPTION_MAX = 4096;
const MESSAGE_MAX = 6000;

export function bytes(n) {
  if (n === null || n === undefined) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function duration(ms) {
  if (ms === null || ms === undefined) return 'never';
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} days ${h % 24} h`;
}

const inOut = (t) => `in ${bytes(t.in)}, out ${bytes(t.out)}`;
const cut = (text, max) => (text.length <= max ? text : text.slice(0, max - 1) + '…');
const levelOf = (levels) => (levels.includes('problem') ? 'problem' : levels.includes('warning') ? 'warning' : 'ok');

function networkEmbed(s) {
  const name = NETWORK_NAMES[s.network] ?? s.network;
  const check = (c) => (c.ok ? `ok (${c.ms} ms)` : `**failing** (${c.error})`);
  const lines = [];
  if (s.issues.length) {
    for (const i of s.issues) lines.push(`${i.level === 'problem' ? '🔴' : '🟠'} ${i.text}`);
    lines.push('');
  }
  lines.push('**Node**');
  lines.push(`\`${s.node.slice(0, 12)}…\` · meadow-node ${s.version} · protocol ${s.protocol} · up ${duration(s.up_ms)}`);
  lines.push(`Relay port ${check(s.self.relay)} · peer port ${check(s.self.peer)}`);
  lines.push(`Holds ${s.holds.rooms} rooms, ${s.holds.agents} agents, ${s.holds.events} events`);
  lines.push(`Accepted in the last ${duration(s.traffic.interval_ms)}: ${s.accepted.clients} from clients, ${s.accepted.peers} from peers`);
  lines.push('');
  lines.push('**Sync with other servers**');
  const d = s.discovery;
  const active = s.peers.filter((p) => !p.banned).length;
  lines.push(d.last_run === null
    ? `Discovery has not finished a run yet${d.last_error ? ` (last error: ${d.last_error.text})` : ''}. ${active} peer${active === 1 ? '' : 's'} active.`
    : `The chain lists ${d.suppliers} supplier${d.suppliers === 1 ? '' : 's'} (${d.others} other than this one); ${active} peer${active === 1 ? '' : 's'} active.`);
  const peers = [...s.peers].sort((a, b) => Number(b.banned) - Number(a.banned) || (b.quiet_ms ?? 0) - (a.quiet_ms ?? 0));
  for (const p of peers.slice(0, MAX_PEERS)) {
    const state = p.banned ? `**banned**, ${p.penalty} points` : `active${p.penalty ? `, ${p.penalty} penalty points` : ''}`;
    const last = p.last_ok ? `last exchange ${duration(s.at - p.last_ok)} ago` : 'no exchange yet';
    const fail = p.failures ? `; ${p.failures} failure${p.failures === 1 ? '' : 's'} since (${cut(p.last_error?.text ?? '?', 80)})` : '';
    lines.push(`• \`${p.id.slice(0, 12)}…\` ${p.host} (${p.source}): ${state}, ${last}${fail}; ${p.interval.received} events received, ${p.interval.accepted} accepted`);
  }
  if (peers.length > MAX_PEERS) lines.push(`and ${peers.length - MAX_PEERS} more`);
  lines.push('');
  lines.push(`**Data** (last ${duration(s.traffic.interval_ms)}; since start)`);
  const t = s.traffic;
  lines.push(`Relay port: ${inOut(t.interval.relay)}; ${inOut(t.total.relay)}`);
  lines.push(`Peer port: ${inOut(t.interval.peer)}; ${inOut(t.total.peer)}`);
  lines.push(`Own calls (peers, chain): ${inOut(t.interval.own)}; ${inOut(t.total.own)}`);
  return {
    title: `Meadow node, ${name}: ${LEVEL_WORDS[s.level]}`,
    color: COLOURS[s.level],
    description: cut(lines.join('\n'), DESCRIPTION_MAX),
    timestamp: new Date(s.at).toISOString(),
  };
}

// The container's level and its issues (disk, memory).
export function containerIssues(c) {
  const issues = [];
  const pct = c.disk.volume?.percent;
  if (pct >= 90) issues.push({ level: 'problem', text: `The data volume is ${pct}% full. Free space or grow the volume before the databases can't write.` });
  else if (pct >= 80) issues.push({ level: 'warning', text: `The data volume is ${pct}% full.` });
  if (c.memory.percent >= 80) issues.push({ level: 'warning', text: `The node uses ${c.memory.percent}% of its memory limit (${bytes(c.memory.rss)} of ${bytes(c.memory.limit)}).` });
  return issues;
}

function containerEmbed(c, at) {
  const issues = containerIssues(c);
  const level = levelOf(issues.map((i) => i.level));
  const lines = issues.map((i) => `${i.level === 'problem' ? '🔴' : '🟠'} ${i.text}`);
  if (lines.length) lines.push('');
  if (c.networkInterval && c.networkTotal) lines.push(`**Network** (all traffic): last ${duration(c.interval_ms)} ${inOut(c.networkInterval)}; since start ${inOut(c.networkTotal)}`);
  lines.push('**Disk**');
  for (const db of c.disk.databases) lines.push(`${NETWORK_NAMES[db.network] ?? db.network} database: ${bytes(db.bytes)} (+ ${bytes(db.wal)} log)`);
  const v = c.disk.volume;
  if (v) lines.push(`Data volume: ${bytes(v.used)} used of ${bytes(v.total)} (${v.percent}%), ${bytes(v.free)} free`);
  lines.push(`**Memory** ${bytes(c.memory.rss)}${c.memory.limit ? ` of ${bytes(c.memory.limit)} (${c.memory.percent}%)` : ''}`);
  return { level, embed: { title: `Container: ${LEVEL_WORDS[level]}`, color: COLOURS[level], description: cut(lines.join('\n'), DESCRIPTION_MAX), timestamp: new Date(at).toISOString() } };
}

/**
 * The webhook payload, and the overall level. `snapshots`: one per network (Health.snapshot);
 * `container`: containerStats plus networkInterval, networkTotal, interval_ms; `mention` goes before a
 * report with a problem; `note` (for example "Test report") goes first in the message.
 */
export function buildPayload(snapshots, container, { mention = null, note = null, cleared = false } = {}) {
  const at = snapshots[0]?.at ?? Date.now();
  const c = containerEmbed(container, at);
  const level = levelOf([...snapshots.map((s) => s.level), c.level]);
  const embeds = [...snapshots.map(networkEmbed), c.embed].slice(0, 10);
  // Keep the whole message within Discord's 6,000 characters: shorten the longest descriptions.
  const total = () => embeds.reduce((n, e) => n + e.title.length + e.description.length, 0);
  while (total() > MESSAGE_MAX) {
    const longest = embeds.reduce((a, b) => (b.description.length > a.description.length ? b : a));
    longest.description = cut(longest.description, Math.max(200, longest.description.length - (total() - MESSAGE_MAX) - 1));
  }
  const words = [note, cleared && level === 'ok' ? 'All clear again.' : null].filter(Boolean).join(' ');
  const content = [level === 'problem' && mention ? mention : null, words || null].filter(Boolean).join(' ');
  return { level, payload: { ...(content && { content }), embeds } };
}
