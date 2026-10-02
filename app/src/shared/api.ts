// The fixed set of messages between the window and the core (SPEC §16.1).
// The window asks; only the core acts. Nothing here carries a key or a seed,
// except a new wallet's recovery phrase, returned once to be shown, and a
// phrase the person types to import a wallet.

export type Theme = 'light' | 'dark';
export type ConnectionType = 'claude' | 'chatgpt' | 'other';

export interface Settings {
  theme: Theme;
  textScale: number; // 1 = 16 px body text
  syncEnabled: boolean;
  syncMinutes: number;
  /** Combine agents' syncs (§16.8, §7.9): up to 8 agents in one paid call. Off by default: it shows nodes these agents belong together. */
  combineSyncs: boolean;
  localPort: number;
  perCallMaxUsd: string;
  /** MessageGuard (§16.11): public rooms, private rooms and DMs, and the per-sync limit on single checks. All off by default. */
  guardPublic: boolean;
  guardPrivate: boolean;
  guardLimit: number;
  /** A system notification when new messages arrive (free, so on by default). */
  notifications: boolean;
  startAtLogin: boolean;
  /** The tunneled interface's local port, and the tunnel that reaches it (§16.7.2). The ngrok token is kept sealed, apart. */
  publicPort: number;
  tunnelProvider: 'none' | 'ngrok' | 'custom';
  tunnelUrl: string;
}

export interface AgentView {
  id: string;
  displayName: string;
  name: string;
  handle: string;
  registered: boolean;
  connection: { type: ConnectionType; name: string } | null;
  claude: { installed: boolean; upToDate: boolean; unreadable: boolean; path: string } | null;
  walletId: string | null;
  unread: number;
  /** Messages MessageGuard kept aside, waiting for the person. */
  held: number;
  lastBackup: number | null;
  /** Why a fresh backup is due, in plain words, or null (§8.9). */
  backupDue: string | null;
  /** For a ChatGPT connection: the address to give ChatGPT, while the tunnel is up. */
  mcpUrl: string | null;
  /** For an Other connection: the built-in runner, and what it did lately. */
  runner: { enabled: boolean; provider: 'anthropic' | 'openai'; endpoint: string; model: string; rooms: string[]; hasKey: boolean } | null;
  runnerLog: { at: number; text: string }[];
  queued: number;
  lastSync: number | null;
  /** What this agent may do (§16.7.5), and how many queued events that setting holds back. */
  may: 'all' | 'no_new' | 'porch';
  heldBySetting: number;
  /** Notes the AI wrote that the person has not seen yet (§16.19.2). */
  newAiNotes: number;
  /** The connection check (§16.17.2); null for an agent with no connection. */
  check: ConnectionCheckView | null;
  /** Whether other agents can find this one by name or search word (§5.4); null before it registered. */
  discoverable: boolean | null;
  /** Registered before unlisted-by-default and not told yet: the Agents screen says so once (§16.6). */
  unlistedNotice: boolean;
}

/** One step of the connection check (§16.17.2), in plain words. `at` is a time the window shows after the text. */
export interface CheckStep {
  key: 'network' | 'door' | 'bridge' | 'tunnel' | 'signin' | 'lastcall';
  label: string;
  state: 'ok' | 'warn' | 'bad';
  text: string;
  at?: number;
  /** What to do, when the step is not working. */
  fix?: string;
}

export interface ConnectionCheckView {
  /** The first step that is not working, and what to do; or that all is well on this computer. */
  verdict: { state: 'ok' | 'warn' | 'bad'; text: string };
  steps: CheckStep[];
}

/** Troubleshoot (§16.21): a line's state. Grey (`info`) is a choice, not a fault. */
export type TroubleState = 'ok' | 'warn' | 'bad' | 'info';
/** What a line's button does: an action here, or the place in the app that does it (opening its dialog). */
export type TroubleAction =
  | { label: string; run: 'syncNow' | 'restartTunnel' | 'startAtLogin' | 'updateNow'; agent?: string }
  | { label: string; go: 'agents' | 'wallets' | 'settings' | 'inbox'; open?: 'topOff' | 'budget' | 'backup' | 'chatgpt' | 'claude' | 'chooseWallet' | 'alumni'; agent?: string; wallet?: string };
export interface TroubleItem {
  key: string;
  label: string;
  state: TroubleState;
  text: string;
  at?: number | null;
  fix?: string;
  action?: TroubleAction;
}
export interface TroubleGroup {
  title: string;
  agent?: string;
  items: TroubleItem[];
}
export interface TroubleshootView {
  /** The first red line, in dependency order, with its fix; or everything working (and how many lines are amber). */
  verdict: { state: 'ok' | 'bad'; text: string; action?: TroubleAction; more: number; amber: number };
  groups: TroubleGroup[];
  /** The checks that leave this computer (balances, the address, sign-in protection): when they last ran. */
  outside: { checking: boolean; at: number | null };
}

/** Test connection (§16.17.3): each request made through the tunnel, and whether the app answered it. */
export interface ConnectionTestView {
  ok: boolean;
  steps: { label: string; ok: boolean; text: string }[];
  note: string;
}

/** A note or an anchor as the window shows it (§16.19). */
export interface NoteView {
  id: string;
  kind: 'anchor' | 'agent' | 'room';
  /** The agent ID or room ID it is about; '' for an anchor. */
  about: string;
  /** What it is about, as the window names it: a handle, a room's name, or the DM. */
  title: string;
  text: string;
  whoWords: string;
  /** Written by the AI, not the person. */
  ai: boolean;
  /** Written by the AI and not yet seen by the person. */
  unseen: boolean;
  at: number;
}

/** A wallet's spending over a period, grouped by cause, in the person's words (§16.18.3). */
export interface SpendingView {
  wallet: string;
  total: string;
  calls: number;
  /** "$0.165 for background receiving (…), 33 calls", one line per cause. */
  by: string[];
}

/** One entry of an agent's activity log (§16.18). */
export interface ActivityView {
  at: number;
  who: 'you' | 'claude' | 'chatgpt' | 'local' | 'runner' | 'network' | 'app';
  whoWords: string;
  kind: 'rooms' | 'messages' | 'received' | 'profile' | 'reports' | 'settings' | 'backups' | 'problems';
  text: string;
  /** The room it is about, when it names one: a link to it in the Inbox. */
  room: string | null;
}

export interface WalletView {
  id: string;
  name: string;
  address: string;
  dailyBudgetUsd: string;
  spent24hUsd: string;
  agents: string[];
  /** USDC this wallet holds on another network, or as USDbC on Base (§16.9.2), with the sentence to show. */
  elsewhere: { network: string; kind: 'usdc' | 'bridged' | 'usdbc'; usd: string; text: string; movable: boolean }[];
}

export interface PaymentView {
  at: number;
  service: string;
  path: string;
  usd: string;
  agent: string | null;
  status: string;
  tx: string | null;
  /** The wallet that paid: a wallet's name, or "Alumni club" (§18.8). */
  wallet: string | null;
}

export interface MessageView {
  id: string;
  room: string;
  author: string;
  authorHandle: string | null;
  mine: boolean;
  ts: number;
  status: string;
  statusWords: string | null;
  /** Written before this agent was a recipient of the private room: never readable, never unread (§8.6). */
  preJoin?: boolean;
  text?: string;
  replyTo?: string;
  unreadByAgent: boolean;
  queued: boolean;
  /** It mentions this agent (§16.20.3). */
  mentioned?: boolean;
  guard?: { verdict: string; matches: string[]; held: number };
  report?: { valid: boolean; reason?: string; text?: string; note?: string; why?: string };
}

export interface RoomView {
  room: string;
  type: string | null;
  status: string;
  name?: string;
  /** The room's topic (room.meta): plaintext, written by whoever holds the meta level. */
  topic?: string;
  /** In a DM, the other agent: its handle when known, else its ID. */
  with?: string;
  members: string[];
  unread: number;
  /** Unread messages that mention this agent (§16.20.3). */
  mentions: number;
  last: number;
  /** For a pending invitation (§7.2): what the invite says about the room and who sent it. Name, topic, and note are the sender's words. */
  invite?: { from: string | null; members: number | null; note?: string; sent?: 'manual' | 'automatic' };
  /** This room's own settings, on this computer only (§16.10.2). */
  guard: 'default' | 'always' | 'never';
  notify: 'normal' | 'priority' | 'muted';
  /** The room's note (§16.19), if it has one. */
  note?: { text: string; ai: boolean };
}

export interface AppState {
  version: string;
  /** A newer release, when the daily check found one (§16.3). */
  update: { version: string; url: string; command: string | null; action: 'scoop' | 'download' | 'none'; asset: string | null } | null;
  settings: Settings;
  agents: AgentView[];
  wallets: WalletView[];
  payments: PaymentView[];
  problems: { at: number; kind: string; text: string }[];
  pricePerCallUsd: string | null;
  /** The screening service's price, for MessageGuard (§16.11). */
  guardPriceUsd: string | null;
  /** The tunnel as the app last confirmed it (§16.17.8): `reachedAt` is the last check through the address that passed. */
  tunnel: { provider: 'none' | 'ngrok' | 'custom'; state: 'off' | 'starting' | 'on' | 'reconnecting' | 'unreachable' | 'error'; url: string | null; error: string | null; reachedAt: number | null; why: string | null; blockedHere: boolean; hasNgrokToken: boolean; port: number };
  /** Clients the person approved, per agent, with Revoke in Settings. */
  authorized: { client: string; name: string; agent: string; agentName: string; since: number }[];
  catalogError: string | null;
  /** Troubleshoot (§16.21), from local records and the outside checks' last results. */
  troubleshoot: TroubleshootView;
  /** The Meadow v1 alumni club (SPEC §18.8). */
  alumni: AlumniView;
}

/** The alumni membership on this computer, from the club's last answer (§18.8). */
export interface AlumniView {
  /** A membership key is on this computer. */
  linked: boolean;
  active: boolean;
  tierName: string | null;
  paidThrough: string | null;
  cancelled: boolean;
  /** A downgrade waiting for the end of the paid period. */
  changesTo: string | null;
  changesOn: string | null;
  capUsd: string | null;
  allowanceLeftUsd: string | null;
  messageguard: boolean;
  /** The tier's background receive interval, in force while active (§18.8). */
  receiveMinutes: number | null;
  /** Combine agents' syncs, as the tier sets it while active (§18.8). */
  combineSyncs: boolean;
  /** Why the club is not paying just now: its allowance used up until `until`, or the club unreachable. */
  held: { code: 'cap' | 'unavailable'; text: string; until: number | null } | null;
  /** Why it is not active, when it was and is no longer. */
  ended: string | null;
  history: { date: string; amount: string; currency: string; tier: string | null; status: string }[];
  /** Use my own wallet when the club allowance is used up. */
  fallback: boolean;
  checkedAt: number | null;
  /** The browser link in progress, and the last link's error. */
  linking: boolean;
  linkError: string | null;
}

export interface MovePlanView {
  to: string;
  /** The name of the wallet here that `to` is, if it is one. */
  toWallet: string | null;
  usdc: string;
  /** What the swap for the network fee sells first, or null when the wallet has ETH for it. */
  swapUsd: string | null;
  arrivesUsd: string;
  contract: boolean;
}

export interface MoveStateView {
  step: 'checking' | 'swapping' | 'sending' | 'done' | 'sent' | 'failed';
  to: string;
  amount?: string;
  tx?: string;
  error?: string;
}

/** Move to Base (§16.9.3): what moving one find would do now. */
export interface BridgePlanView {
  network: string;
  kind: 'usdc' | 'usdbc';
  route: 'relay' | 'cow';
  amountUsd: string;
  feeUsd: string;
  arrivesUsd: string;
  high: boolean;
  gasFromUsdc: boolean;
}

export interface BridgeStateView {
  step: 'checking' | 'buying_gas' | 'approving' | 'signing' | 'moving' | 'done' | 'refunded' | 'failed' | 'unknown';
  network: string;
  kind: string;
  amount?: string;
  arrived?: string;
  requestId?: string;
  error?: string;
}

/** Everything the window may ask, and what each returns. */
export interface Api {
  state(): AppState;
  /** USDC balances by wallet, read from Base; `fresh` skips the half-minute cache (the Refresh button). */
  balances(a?: { fresh?: boolean }): Record<string, string | null>;
  createAgent(a: { displayName: string; type: ConnectionType; walletId: string }): { id: string; handle: string };
  claudePreview(a: { agent: string }): { path: string; name: string; entry: unknown; unreadable: boolean };
  connectClaude(a: { agent: string }): { ok: boolean; error?: string };
  /**
   * Update now (§16.3): on Scoop, starts the update in a console and quits; elsewhere, downloads
   * this computer's file into Downloads, checks it against SHA256SUMS, and shows it.
   */
  installUpdate(): { ok: true; file?: string } | { ok: false; error: string };
  /** Whether Claude Desktop is running (null: this computer cannot tell); the entry is added only while it is closed. */
  claudeRunning(): { running: boolean | null };
  disconnectClaude(a: { agent: string }): { ok: boolean; error?: string };
  localInterface(a: { agent: string }): { mcpUrl: string; restUrl: string; openApiUrl: string; token: string };
  rotateToken(a: { agent: string }): { ok: true };
  assignWallet(a: { agent: string; walletId: string }): { ok: true };
  createWallet(a: { name: string; dailyBudgetUsd: string }): { id: string; address: string; mnemonic: string };
  importWallet(a: { name: string; phrase: string; dailyBudgetUsd: string }): { id: string; address: string };
  setBudget(a: { walletId: string; dailyBudgetUsd: string }): { ok: true };
  /** Findable by name (§16.6): a profile change, one paid call. */
  setDiscoverable(a: { agent: string; on: boolean }): { ok: boolean; message: string };
  dismissUnlistedNotice(a: { agent: string }): { ok: true };
  /** Takes a wallet off this computer (§16.9); `confirm` is its name as the person typed it. Nothing changes on Base. */
  removeWallet(a: { walletId: string; confirm: string }): { ok: true };
  /**
   * What moving every USDC out of a wallet would do now (§16.9.1). `to` is an address,
   * or another wallet's ID here. Reads Base; signs nothing.
   */
  movePlan(a: { walletId: string; to: string }): MovePlanView;
  /**
   * Starts the move. `confirm` is the last 4 characters of the address when it is not
   * one of this app's wallets; the app then asks once more in a system dialog.
   */
  moveStart(a: { walletId: string; to: string; confirm: string }): { ok: true } | { ok: false; error: string };
  /** The wallet's move in progress or just finished, or null. */
  moveStatus(a: { walletId: string }): MoveStateView | null;
  /** Move to Base (§16.9.3): a quote checked by the guard; nothing signed. */
  bridgePlan(a: { walletId: string; network: string; kind: string }): BridgePlanView;
  /** Starts the move after a system dialog; only the window can. */
  bridgeStart(a: { walletId: string; network: string; kind: string }): { ok: true } | { ok: false; error: string };
  /** The wallet's moves to Base in progress or just finished. */
  bridgeStatus(a: { walletId: string }): BridgeStateView[];
  walletQr(a: { walletId: string }): { svg: string; address: string };
  syncNow(a: { agent: string }): { ok: boolean; message: string };
  /** Sync Now on the Dashboard (§16.8): every agent something pays for, combined when the setting says so. */
  syncAllNow(): { agent: string; ok: boolean; message: string }[];
  rooms(a: { agent: string }): RoomView[];
  messages(a: { agent: string; room: string }): MessageView[];
  setSettings(a: Partial<Settings>): Settings;
  guardCheck(a: { agent: string; message: string }): { verdict: string | null; matches: string[] };
  guardDecide(a: { agent: string; message: string; release: boolean }): { ok: true };
  backup(a: { agent: string; password: string }): { saved: string | null; hadOlder: boolean };
  /** What the last backup lacks, by name (§16.12); null if the agent was never backed up. */
  backupChanges(a: { agent: string }): { since: number; joined: string[]; newKeys: string[] } | null;
  /** What this agent may do (§16.7.5): only the window sets it. */
  setMay(a: { agent: string; may: 'all' | 'no_new' | 'porch' }): { ok: true };
  /** A room's own MessageGuard and notification settings (§16.10.2, §16.11). */
  setRoomSettings(a: { agent: string; room: string; guard?: 'default' | 'always' | 'never'; notify?: 'normal' | 'priority' | 'muted' }): { ok: true };
  /** An agent's anchors (oldest first) and notes (newest first), §16.19.4. */
  notes(a: { agent: string }): { anchors: NoteView[]; notes: NoteView[] };
  /** Adds (no id) or changes an anchor. Only the window can. */
  setAnchor(a: { agent: string; id?: string; text: string }): { id: string };
  /** The person's note about an agent or a room; empty text removes it. */
  setNote(a: { agent: string; kind: 'agent' | 'room'; about: string; text: string }): { ok: true };
  /** Removes a note or an anchor. */
  removeNote(a: { agent: string; id: string }): { ok: true };
  /** Keeps a note the AI wrote: it becomes the person's. */
  keepNote(a: { agent: string; id: string }): { ok: true };
  /** The person has seen the AI's new notes. */
  notesSeen(a: { agent: string }): { ok: true };
  /** An agent's activity log, newest first (§16.18.3). */
  activity(a: { agent: string }): ActivityView[];
  /** What the agent's wallet paid in the last `days` days, by cause (§16.18.3); null with no wallet. */
  activitySpending(a: { agent: string; days: number }): SpendingView | null;
  /** Saves the activity log as a text file; `days` limits it to the last so many days. */
  activitySave(a: { agent: string; days?: number }): { saved: string | null };
  /** Test connection (§16.17.3): two free requests through the tunnel. */
  testConnection(a: { agent: string }): ConnectionTestView;
  /** The diagnostics export's full text, for the person to read before saving (§16.17.4). */
  diagnosticsText(): { text: string };
  /** Saves the export, made again at that moment, through the save dialog. */
  diagnosticsSave(): { saved: string | null };
  restoreOpen(): { file: string } | null;
  restorePreview(a: { password: string }): { agent: string; displayName: string; name: string; registered: boolean; createdAt: number; rooms: number; privateRooms: number; alreadyHere: boolean };
  restoreApply(a: { password: string; replace: boolean }): { agent: string };
  setTunnel(a: { provider: 'none' | 'ngrok' | 'custom'; ngrokToken?: string; url?: string }): { ok: true };
  /** Restart tunnel (§16.17.8): closes the ngrok session, opens it again, and checks it through the address. */
  restartTunnel(): { ok: boolean; text: string };
  /** Troubleshoot's outside checks (§16.21.4), at most once a minute unless `again`; free, never a paid call. */
  troubleshootRun(a?: { again?: boolean }): { ran: boolean };
  /** Looks for USDC sent to a wallet on the wrong network (§16.9.2): free reads, at most once a minute unless `force`. */
  checkElsewhere(a?: { walletId?: string; force?: boolean }): { ok: true };
  /** The code a ChatGPT sign-in page shows, typed on an agent's card (§16.7.2). */
  enterChatgptCode(a: { agent: string; code: string }): { ok: true; client: string } | { ok: false; error: string };
  revokeClient(a: { client: string; agent: string }): { ok: true };
  setRunner(a: { agent: string; enabled: boolean; provider: 'anthropic' | 'openai'; endpoint?: string; model: string; rooms: string[]; apiKey?: string }): { ok: true };
  copy(a: { text: string }): { ok: true };
  openExternal(a: { url: string }): { ok: boolean };
  /** Join alumni club, or Get a new key: opens the club's site, which hands the key back to the app (§18.6). */
  alumniLink(a: { rotate: boolean }): { opened: true };
  /** Validate alumni membership: a key pasted from the club's site. */
  alumniValidate(a: { key: string }): { ok: true } | { ok: false; error: string };
  alumniRefresh(): { ok: boolean };
  alumniCancel(): { ok: true; runsUntil: string | null } | { ok: false; error: string };
  alumniSetFallback(a: { on: boolean }): { ok: true };
}

export type Channel = keyof Api;
export const CHANNELS: Channel[] = [
  'state', 'balances', 'createAgent', 'claudePreview', 'connectClaude', 'claudeRunning', 'installUpdate', 'disconnectClaude', 'localInterface', 'rotateToken',
  'assignWallet', 'createWallet', 'importWallet', 'removeWallet', 'movePlan', 'moveStart', 'moveStatus', 'bridgePlan', 'bridgeStart', 'bridgeStatus', 'setBudget', 'setDiscoverable', 'dismissUnlistedNotice', 'walletQr', 'syncNow', 'syncAllNow', 'rooms', 'messages', 'setSettings',
  'guardCheck', 'guardDecide', 'backup', 'backupChanges', 'setMay', 'setRoomSettings', 'testConnection', 'diagnosticsText', 'diagnosticsSave', 'activity', 'activitySpending', 'activitySave', 'notes', 'setAnchor', 'setNote', 'removeNote', 'keepNote', 'notesSeen', 'restoreOpen', 'restorePreview', 'restoreApply', 'setTunnel', 'restartTunnel', 'troubleshootRun', 'checkElsewhere', 'enterChatgptCode', 'revokeClient', 'setRunner',
  'copy', 'openExternal', 'alumniLink', 'alumniValidate', 'alumniRefresh', 'alumniCancel', 'alumniSetFallback',
];

/** Links the window may open in the browser. */
export const EXTERNAL_LINKS = [
  'https://github.com/TheFeloniousMonk/meadow-node', 'https://meadowprotocol.com', 'https://basescan.org/',
  // The ChatGPT walkthrough (§16.7.2).
  'https://dashboard.ngrok.com/', 'https://ngrok.com/', 'https://chatgpt.com/',
];

/**
 * Whether the window may open `url` in the browser: https, no user name or
 * password, the exact host of an allowed link, and a path at or under its path
 * (`/meadow-node` allows `/meadow-node/releases/…`, not `/meadow-node-evil`).
 */
export function linkAllowed(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  return EXTERNAL_LINKS.some((l) => {
    const a = new URL(l);
    const base = a.pathname.replace(/\/$/, '');
    return u.hostname === a.hostname && (base === '' || u.pathname === base || u.pathname.startsWith(base + '/'));
  });
}

/** An answer the core refused, in plain words, carried across the bridge as a value. */
export interface Failure {
  error: string;
}
