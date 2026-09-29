// Runs the test suite under Electron's own Node (ELECTRON_RUN_AS_NODE), the
// runtime the app ships with. Electron builds node:crypto on BoringSSL, not
// OpenSSL, so some calls that pass under plain Node fail in the app (Argon2
// did: backup and restore never worked in the real app until this caught it).
import { spawnSync } from 'node:child_process';
import electron from 'electron';

const r = spawnSync(electron, ['--test', 'test/*.test.ts'], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
process.exit(r.status ?? 1);
