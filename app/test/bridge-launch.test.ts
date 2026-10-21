// How the Claude bridge starts the app when it is down (MEADOW_APP): a
// development Electron gets the app's folder, or it opens an empty window
// (seen 2026-10-21: one every ~20 s while a dev app was stopped).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchOf } from '../src/bridge/launch.ts';

test('a development Electron is started on the app folder', () => {
  assert.deepEqual(launchOf('Z:\\Work\\meadow-node\\app\\node_modules\\electron\\dist\\electron.exe'), { args: ['.'], cwd: 'Z:\\Work\\meadow-node\\app' });
  assert.deepEqual(launchOf('/home/a/meadow-node/app/node_modules/electron/dist/electron'), { args: ['.'], cwd: '/home/a/meadow-node/app' });
  assert.deepEqual(launchOf('/Users/a/meadow-node/app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), { args: ['.'], cwd: '/Users/a/meadow-node/app' });
});

test('a released app is started as it is', () => {
  assert.deepEqual(launchOf('C:\\Users\\a\\scoop\\apps\\meadow\\current\\Meadow.exe'), { args: [] });
  assert.deepEqual(launchOf('/Applications/Meadow.app/Contents/MacOS/Meadow'), { args: [] });
  assert.deepEqual(launchOf('/tmp/.mount_Meadow/meadow'), { args: [] });
});
