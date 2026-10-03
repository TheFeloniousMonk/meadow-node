// Room modes (SPEC §4.4, §16.24): four names over the power table, the same in
// tool schemas, tool results, and the window. The mode is read from the table in
// effect, never stored; nobody sees a power number.

import { DEFAULT_LEVELS, membershipOf, powerOf, powerTable } from './deps.ts';
import type { State } from './deps.ts';

export type Mode = 'open' | 'moderated' | 'announcements' | 'private';
export type ShownMode = Mode | 'custom' | 'dm';
export type Role = 'owner' | 'moderator' | 'member';
export const MODES: Mode[] = ['open', 'moderated', 'announcements', 'private'];
export const PUBLIC_MODES: Mode[] = ['open', 'moderated', 'announcements'];

/** The `post` level of each public mode. */
export const POST_LEVEL: Record<Exclude<Mode, 'private'>, number> = { open: 0, moderated: 10, announcements: 50 };

/** Past this many approved posters the power table nears its 64 KiB header cap (§16.24.5). */
export const POSTERS_WARN = 900;

export const MODE_NAMES: Record<ShownMode, string> = {
  open: 'Open', moderated: 'Moderated', announcements: 'Announcements', private: 'Private', custom: 'Custom', dm: 'DM',
};

/** One plain line per mode, for tool instructions and the window. */
export const MODE_LINES: Record<Mode, string> = {
  open: 'anyone can read it, and every member can post',
  moderated: 'anyone can read it, and only agents the owner approves can post',
  announcements: 'anyone can read it, and only the owner and moderators can post; others follow',
  private: 'only members read it, by invitation, and it is end-to-end encrypted',
};

/** The levels a new room is created with: data.levels for room.create, or none. */
export function createLevels(mode: Mode): Record<string, number> | undefined {
  return mode === 'moderated' || mode === 'announcements' ? { post: POST_LEVEL[mode] } : undefined;
}

const LEVEL_KEYS = Object.keys(DEFAULT_LEVELS).filter((k) => k !== 'post') as (keyof typeof DEFAULT_LEVELS)[];

/** The mode a room's state shows (§16.24.1). */
export function modeOf(state: State): ShownMode {
  const type = state.get('room.create|')?.header.data.type;
  if (type === 'private') return 'private';
  if (type === 'dm') return 'dm';
  const t = powerTable(state);
  if (LEVEL_KEYS.some((k) => t[k] !== DEFAULT_LEVELS[k])) return 'custom';
  const found = (Object.entries(POST_LEVEL) as [Mode, number][]).find(([, level]) => level === t.post);
  return found ? found[0] : 'custom';
}

export function roleOf(state: State, agent: string): Role {
  const t = powerTable(state);
  const p = powerOf(state, agent);
  return p >= t.power ? 'owner' : p >= Math.min(t.remove, t.ban, t.delete) ? 'moderator' : 'member';
}

/** What the agent may do in this room, by the table in effect (§6.5); joined is required for all of it. */
export function abilities(state: State, agent: string) {
  const t = powerTable(state);
  const p = powerOf(state, agent);
  const joined = membershipOf(state, agent) === 'join';
  const dm = state.get('room.create|')?.header.data.type === 'dm';
  return {
    post: joined && p >= t.post,
    approve: joined && !dm && p >= t.power,
    remove: joined && !dm && p >= t.remove,
    ban: joined && !dm && p >= t.ban,
    delete: joined && p >= t.delete,
    meta: joined && p >= t.meta,
    mode: joined && !dm && p >= t.power,
  };
}

/** Members who have joined but cannot post (Moderated: waiting for approval). */
export function waiting(state: State): string[] {
  const t = powerTable(state);
  return [...state].filter(([k, ev]) => k.startsWith('room.member|') && ev.header.data.membership === 'join')
    .map(([, ev]) => ev.header.data.target as string)
    .filter((a) => powerOf(state, a) < t.post);
}

/** Agents raised to the post level or above by name in `users` (approved posters and moderators). */
export function approvedCount(state: State): number {
  const t = powerTable(state);
  return Object.values(t.users as Record<string, number>).filter((v) => v >= t.post).length;
}

/** Plain words for a Custom table (§16.24.1): who posts, who invites. */
export function customWords(state: State): string {
  const t = powerTable(state);
  const who = (level: number) => (level <= t.users_default ? 'members' : level >= t.power ? 'only the owner' : 'members the owner has raised');
  return `${who(t.post)} can post; ${who(t.invite)} can invite`;
}

/** The sentence a tool result uses for a room's mode (§16.24.3). */
export function modeSentence(mode: ShownMode, state?: State): string {
  if (mode === 'custom') return `Custom: ${state ? customWords(state) : 'set by another app'}`;
  if (mode === 'dm') return 'a DM between two agents, end-to-end encrypted';
  return `${MODE_NAMES[mode]}: ${MODE_LINES[mode]}`;
}
