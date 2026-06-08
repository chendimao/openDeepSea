import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { ensureOpenDeepSeaDataDir, getOpenDeepSeaDataDir } from './data-dir.js';

test('getOpenDeepSeaDataDir defaults to backend data directory', () => {
  withDataDirEnv(undefined, () => {
    assert.match(getOpenDeepSeaDataDir(), /packages[\\/]backend[\\/]data$/);
  });
});

test('getOpenDeepSeaDataDir resolves configured data directory', () => {
  withDataDirEnv('relative-opendeepsea-data', () => {
    assert.equal(getOpenDeepSeaDataDir(), resolve('relative-opendeepsea-data'));
  });
});

test('ensureOpenDeepSeaDataDir creates configured directory', () => {
  const parent = mkdtempSync(join(tmpdir(), 'opendeepsea-data-dir-'));
  const target = join(parent, 'nested', 'data');

  try {
    withDataDirEnv(target, () => {
      assert.equal(ensureOpenDeepSeaDataDir(), target);
    });
  } finally {
    rmSync(parent, { force: true, recursive: true });
  }
});

function withDataDirEnv(value: string | undefined, run: () => void): void {
  const previous = process.env.OPENDEEPSEA_DATA_DIR;
  try {
    if (value === undefined) {
      delete process.env.OPENDEEPSEA_DATA_DIR;
    } else {
      process.env.OPENDEEPSEA_DATA_DIR = value;
    }
    run();
  } finally {
    if (previous === undefined) {
      delete process.env.OPENDEEPSEA_DATA_DIR;
    } else {
      process.env.OPENDEEPSEA_DATA_DIR = previous;
    }
  }
}
