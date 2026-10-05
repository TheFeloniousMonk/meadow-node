// Node entry point. One process runs a separate node per Pocket network
// (SPEC §11.1): its own database, node key, relay port, peer port, peer
// route, and peers. The network of a relay is decided by which port its
// relayer calls, so nothing in a request can move it to the other network.
//
// Configuration comes from the environment:
//   MEADOW_DATA_DIR    where the databases live (default data): meadow-<network>.db
//   MEADOW_NETWORKS    networks to run, comma-separated (default: main,beta)
//   MEADOW_<NET>_PORT, MEADOW_<NET>_PEER_PORT   override a network's ports (NET = MAIN or BETA)
//   MEADOW_LCD_BETA, MEADOW_LCD_MAIN   chain API base URLs, if not the defaults
//   MEADOW_INDEXER_BETA, MEADOW_INDEXER_MAIN   chain indexer GraphQL URLs for discovery, if not the
//                      defaults; "off" reads only the chain API
//   MEADOW_DISCOVERY_INTERVAL_MS  how often to re-run peer discovery (default 1800000 = 30 min)
//   MEADOW_<NET>_PEERS extra peers for a network, "n_<node key>@<peer URL>" comma-separated (development)
//   MEADOW_<NET>_OPERATOR  that network's supplier operator address, reported by GET /
//                      (each network's stack has its own operator key; MEADOW_OPERATOR is a fallback)
//   MEADOW_SUPPORT_URL the Meadow support page, reported by GET /
//   MEADOW_SOURCE_URL  source of the code this node runs (AGPL: point at your fork if modified)
//   MEADOW_WRITE_ROOM_PER_MIN, MEADOW_WRITE_AGENT_PER_MIN  write limits per agent, per room and
//                      overall (SPEC §7.2; defaults 20 and 60)
//   MEADOW_ALERT_WEBHOOK  a Discord webhook URL for the hourly health report (SPEC §9.6); unset: none
//   MEADOW_ALERT_INTERVAL_MIN  minutes between reports (default 60, at least 15)
//   MEADOW_ALERT_MODE  report (post every check, default) or problems (only trouble, its clearing, and daily)
//   MEADOW_ALERT_MENTION  text put before a report with a problem, for example <@&role-id>

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPeerServer, createServer } from './server.js';
import { Store } from './store/store.js';
import { Peers } from './peer/peers.js';
import { Replicator } from './peer/replicator.js';
import { Discovery } from './peer/discovery.js';
import { INDEXER, LCD, listSuppliers } from './peer/chain.js';
import { Traffic, countServer, countingFetch } from './health/traffic.js';
import { Health } from './health/health.js';
import { containerStats } from './health/container.js';
import { Alerts, AlertConfigError, parseAlertConfig } from './health/alerts.js';

// Fixed per network, so every operator's routes and relayer entries match.
export const NETWORKS = {
  main: { port: 8080, peerPort: 8090, peerPath: '/meadow-peer' },
  beta: { port: 8081, peerPort: 8091, peerPath: '/meadow-peer-beta' },
};

const env = process.env;
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const dataDir = env.MEADOW_DATA_DIR ?? 'data';
mkdirSync(dataDir, { recursive: true });

const wanted = (env.MEADOW_NETWORKS ?? 'main,beta').split(',').map((s) => s.trim()).filter(Boolean);
for (const n of wanted) if (!NETWORKS[n]) throw new Error(`unknown network "${n}" in MEADOW_NETWORKS (use main, beta)`);

// A bad alert setting is reported in plain words and the node runs without alerts (SPEC §9.6):
// alerts are optional, and the settings are changed from a form, so a typo must not stop the node.
// The operator command's alert-test reports the same problem.
let alertConfig = null;
try {
  alertConfig = parseAlertConfig(env);
} catch (err) {
  if (!(err instanceof AlertConfigError)) throw err;
  console.error(`meadow-node: alerts are off: ${err.message}`);
}
const startedAt = Date.now();
const healths = [];

function startNetwork(network) {
  const NET = network.toUpperCase();
  const port = Number(env[`MEADOW_${NET}_PORT`] ?? NETWORKS[network].port);
  const peerPort = Number(env[`MEADOW_${NET}_PEER_PORT`] ?? NETWORKS[network].peerPort);
  const store = new Store(join(dataDir, `meadow-${network}.db`));
  const peers = new Peers(Peers.parse(env[`MEADOW_${NET}_PEERS`]));
  // This network's traffic (SPEC §9.6): its two ports, and its own calls to peers and the chain.
  const traffic = { relay: new Traffic(), peer: new Traffic(), own: new Traffic() };
  const fetch = countingFetch(globalThis.fetch, traffic.own);
  const replicator = new Replicator(store, peers, { fetch }).start();
  const discovery = new Discovery(store, peers, {
    networks: [network],
    peerPath: NETWORKS[network].peerPath,
    fetch,
    ...(env.MEADOW_DISCOVERY_INTERVAL_MS ? { intervalMs: Number(env.MEADOW_DISCOVERY_INTERVAL_MS) } : {}),
    listSuppliers: (net, { since }) => listSuppliers(network, {
      since, fetch,
      base: env[`MEADOW_LCD_${NET}`] ?? LCD[network],
      indexer: env[`MEADOW_INDEXER_${NET}`] === 'off' ? null : env[`MEADOW_INDEXER_${NET}`] ?? INDEXER[network],
    }),
  }).start();

  const server = createServer(store, {
    network,
    version: pkg.version,
    sourceUrl: env.MEADOW_SOURCE_URL ?? 'https://github.com/TheFeloniousMonk/meadow-node',
    supportUrl: env.MEADOW_SUPPORT_URL ?? 'https://meadowprotocol.com',
    operator: env[`MEADOW_${NET}_OPERATOR`] || env.MEADOW_OPERATOR || null,
    writeLimits: {
      ...(env.MEADOW_WRITE_ROOM_PER_MIN ? { roomPerMin: Number(env.MEADOW_WRITE_ROOM_PER_MIN) } : {}),
      ...(env.MEADOW_WRITE_AGENT_PER_MIN ? { agentPerMin: Number(env.MEADOW_WRITE_AGENT_PER_MIN) } : {}),
    },
  });
  const peerServer = createPeerServer(store, peers, replicator, { onUnknownPeer: (id) => discovery.nudge(id) });
  countServer(server, traffic.relay);
  countServer(peerServer, traffic.peer);
  server.listen(port);
  peerServer.listen(peerPort);
  const health = new Health({ network, store, peers, discovery, traffic, ports: { relay: port, peer: peerPort }, version: pkg.version, startedAt });
  healths.push(health);
  // The latest snapshot, kept for the operator command's peers and alert-test (SPEC §9.5, §9.6):
  // a minute after start, then every 5 minutes.
  const snap = () => health.snapshot().catch(() => {});
  let snapshotter = setTimeout(() => {
    snap();
    snapshotter = setInterval(snap, 5 * 60 * 1000);
  }, 60 * 1000);
  console.log(`meadow-node ${network}: ${store.node.id}, relay port ${port}, peer port ${peerPort} (${NETWORKS[network].peerPath}), ${peers.active().length} configured peer(s)`);

  // Retention sweep (SPEC §10): on start, then hourly.
  const sweep = () => {
    const done = store.sweep();
    if (done.content || done.rooms || done.forgotten || done.reports) console.log(`retention sweep ${network}`, done);
  };
  sweep();
  const sweeper = setInterval(sweep, 60 * 60 * 1000);

  return () => new Promise((resolve) => {
    clearInterval(sweeper);
    clearTimeout(snapshotter);
    clearInterval(snapshotter);
    replicator.stop();
    discovery.stop();
    peerServer.close();
    server.close(() => {
      store.close();
      resolve();
    });
  });
}

const stops = wanted.map(startNetwork);

const alerts = alertConfig && new Alerts({ config: alertConfig, healths, container: () => containerStats(dataDir, wanted) }).start();
if (alertConfig) console.log(`health reports to the alert webhook every ${alertConfig.intervalMs / 60_000} min (${alertConfig.mode})`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    alerts?.stop();
    Promise.all(stops.map((stop) => stop())).then(() => process.exit(0));
  });
}
