import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DATA_DIR_MARKER_FILE,
  createDesktopDataManager,
  isUnsafeDataDirectory,
} from './desktop-data';

test('desktop data state uses default directory when no custom directory is configured', async () => {
  await withTempRoot(async (root) => {
    const manager = createDesktopDataManager({ userDataDir: root });

    const state = await manager.getState();

    assert.equal(state.activeDataDir, join(root, 'data'));
    assert.equal(state.defaultDataDir, join(root, 'data'));
    assert.equal(state.pendingDataDir, null);
    assert.equal(state.requiresRestart, false);
    assert.equal(state.canClearData, false);
  });
});

test('desktop data directory changes are pending until a new manager is created', async () => {
  await withTempRoot(async (root) => {
    const manager = createDesktopDataManager({ userDataDir: root });
    const customDir = join(root, 'custom-data');

    const pendingState = await manager.setDataDirectory(customDir);

    assert.equal(pendingState.activeDataDir, join(root, 'data'));
    assert.equal(pendingState.pendingDataDir, customDir);
    assert.equal(pendingState.requiresRestart, true);

    const restartedManager = createDesktopDataManager({ userDataDir: root });
    const restartedState = await restartedManager.getState();

    assert.equal(restartedState.activeDataDir, customDir);
    assert.equal(restartedState.pendingDataDir, null);
    assert.equal(restartedState.requiresRestart, false);
  });
});

test('desktop data clear refuses unmarked directories', async () => {
  await withTempRoot(async (root) => {
    const customDir = join(root, 'custom-data');
    await mkdir(customDir, { recursive: true });
    await writeFile(join(customDir, 'openclaw-room.db'), 'not really sqlite');
    const manager = createDesktopDataManager({ userDataDir: root, activeDataDir: customDir });

    await assert.rejects(
      () => manager.clearActiveDataDirectory(),
      /marker/i,
    );

    assert.deepEqual(await readdir(customDir), ['openclaw-room.db']);
  });
});

test('desktop data directory changes refuse non-empty unmarked custom directories', async () => {
  await withTempRoot(async (root) => {
    const manager = createDesktopDataManager({ userDataDir: root });
    const customDir = join(root, 'custom-data');
    await mkdir(customDir, { recursive: true });
    await writeFile(join(customDir, 'user-file.txt'), 'keep me');

    await assert.rejects(
      () => manager.setDataDirectory(customDir),
      /empty/i,
    );

    assert.deepEqual(await readdir(customDir), ['user-file.txt']);
  });
});

test('desktop data clear removes marked directory contents and preserves marker', async () => {
  await withTempRoot(async (root) => {
    const manager = createDesktopDataManager({ userDataDir: root });
    const activeDir = join(root, 'data');
    await manager.ensureActiveDataDirectory();
    await writeFile(join(activeDir, 'openclaw-room.db'), 'db');
    await writeFile(join(activeDir, 'openclaw-room.db-wal'), 'wal');
    await mkdir(join(activeDir, 'uploads', 'files'), { recursive: true });
    await writeFile(join(activeDir, 'uploads', 'files', 'asset.txt'), 'asset');

    await manager.clearActiveDataDirectory();

    const entries = await readdir(activeDir);
    assert.deepEqual(entries, [DATA_DIR_MARKER_FILE]);
    const marker = JSON.parse(await readFile(join(activeDir, DATA_DIR_MARKER_FILE), 'utf8')) as { app: string };
    assert.equal(marker.app, 'OpenDeepSea');
  });
});

test('isUnsafeDataDirectory rejects roots and the Electron userData directory itself', () => {
  const userDataDir = resolve('/tmp/OpenDeepSea');

  assert.equal(isUnsafeDataDirectory('/', userDataDir), true);
  assert.equal(isUnsafeDataDirectory(userDataDir, userDataDir), true);
  assert.equal(isUnsafeDataDirectory(join(userDataDir, 'data'), userDataDir), false);
});

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'opendeepsea-desktop-data-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
