// Makes a data folder with example state for window screenshots (development
// only), keyed through safeStorage exactly as the app keys its own:
//
//   electron scripts/seed-window.ts --data=<dir>
//   electron . --data=<dir> --screenshot=<file.png> --route=inbox
import { app } from 'electron';
import { join, resolve } from 'node:path';
import { Catalog } from '../src/core/catalog.ts';
import { Services } from '../src/app/services.ts';
import { masterKey } from '../src/main/master-key.ts';
import { startMockPortal } from '../test/mock-portal.ts';
import { seed } from './seed.ts';

const dir = resolve(process.argv.find((a) => a.startsWith('--data='))!.slice(7));
app.setPath('userData', dir);
app.whenReady().then(async () => {
  const portal = await startMockPortal();
  const catalog = new Catalog({ url: portal.catalogUrl });
  await catalog.refresh();
  const s = new Services({ dbPath: join(dir, 'meadow.db'), masterKey: masterKey(dir), version: 'seed', changed: () => {}, catalog });
  console.log('seeded', await seed(s));
  s.stop();
  await portal.close();
  app.exit(0);
});
