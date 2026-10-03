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
//   MEADOW_DISCOVERY_INTERVAL_MS  how often to re-run peer discovery (default 1800000 = 30 min)
//   MEADOW_<NET>_PEERS extra peers for a network, "n_<node key>@<peer URL>" comma-separated (development)
//   MEADOW_<NET>_OPERATOR  that network's supplier operator address, reported by GET /
//                      (each network's stack has its own operator key; MEADOW_OPERATOR is a fallback)
//   MEADOW_SUPPORT_URL the Meadow support page, reported by GET /
//   MEADOW_SOURCE_URL  source of the code this node runs (AGPL: point at your fork if modified)
//   MEADOW_WRITE_ROOM_PER_MIN, MEADOW_WRITE_AGENT_PER_MIN  write limits per agent, per room and
//                      overall (SPEC §7.2; defaults 20 and 60)

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPeerServer, createServer } from './server.js';
import { Store } from './store/store.js';
import { Peers } from './peer/peers.js';
import { Replicator } from './peer/replicator.js';
import { Discovery } from './peer/discovery.js';
import { LCD, listSuppliers } from './peer/chain.js';

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

function startNetwork(network) {
  const NET = network.toUpperCase();
  const port = Number(env[`MEADOW_${NET}_PORT`] ?? NETWORKS[network].port);
  const peerPort = Number(env[`MEADOW_${NET}_PEER_PORT`] ?? NETWORKS[network].peerPort);
  const store = new Store(join(dataDir, `meadow-${network}.db`));
  const peers = new Peers(Peers.parse(env[`MEADOW_${NET}_PEERS`]));
  const replicator = new Replicator(store, peers).start();
  const discovery = new Discovery(store, peers, {
    networks: [network],
    peerPath: NETWORKS[network].peerPath,
    ...(env.MEADOW_DISCOVERY_INTERVAL_MS ? { intervalMs: Number(env.MEADOW_DISCOVERY_INTERVAL_MS) } : {}),
    listSuppliers: () => listSuppliers(network, { base: env[`MEADOW_LCD_${NET}`] ?? LCD[network] }),
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
  const peerServer = createPeerServer(store, peers, replicator);
  server.listen(port);
  peerServer.listen(peerPort);
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

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => Promise.all(stops.map((stop) => stop())).then(() => process.exit(0)));
}
