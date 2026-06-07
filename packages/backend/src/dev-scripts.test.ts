import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

type RootPackageJson = {
  scripts?: Record<string, string>;
};

const rootPackageJson = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../package.json'), 'utf8'),
) as RootPackageJson;

const expectedLocalTokenPrefix = 'OPENDEEPSEA_LOCAL_TOKEN=${OPENDEEPSEA_LOCAL_TOKEN:-openclaw-room-dev-token}';

test('standalone dev scripts share the default local access token', () => {
  assert.equal(
    rootPackageJson.scripts?.dev?.startsWith(`${expectedLocalTokenPrefix} `),
    true,
    'dev must set the default OPENDEEPSEA_LOCAL_TOKEN',
  );

  for (const scriptName of ['dev:backend', 'dev:backend:watch', 'dev:frontend'] as const) {
    const scriptText: string = rootPackageJson.scripts?.[scriptName] ?? '';
    assert.equal(
      scriptText.startsWith(`${expectedLocalTokenPrefix} `),
      true,
      `${scriptName} must set the same default OPENDEEPSEA_LOCAL_TOKEN as root dev`,
    );
  }
});
