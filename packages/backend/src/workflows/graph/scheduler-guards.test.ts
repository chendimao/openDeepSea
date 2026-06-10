import assert from 'node:assert/strict';
import test from 'node:test';
import { scopeWritesConflict, scopeWritesRequireSerial } from './scheduler-guards.js';

const projectPath = '/repo/openDeepSea';

test('scopeWritesRequireSerial blocks broad scopes, root configs, workflow configs, and shared contracts', () => {
  assert.equal(scopeWritesRequireSerial(['.'], projectPath), true);
  assert.equal(scopeWritesRequireSerial(['/repo/openDeepSea'], projectPath), true);
  assert.equal(scopeWritesRequireSerial(['package.json'], projectPath), true);
  assert.equal(scopeWritesRequireSerial(['package-lock.json'], projectPath), true);
  assert.equal(scopeWritesRequireSerial(['tsconfig.json'], projectPath), true);
  assert.equal(scopeWritesRequireSerial(['vite.config.ts'], projectPath), true);
  assert.equal(scopeWritesRequireSerial(['.github/workflows/ci.yml'], projectPath), true);
  assert.equal(scopeWritesRequireSerial(['packages/backend/src/db/migrations/001.sql'], projectPath), true);
  assert.equal(scopeWritesRequireSerial(['packages/backend/src/contracts/workflow.ts'], projectPath), true);
});

test('scopeWritesRequireSerial allows independent frontend and backend leaf files', () => {
  assert.equal(scopeWritesRequireSerial(['packages/frontend/src/pages/FilesPage.tsx'], projectPath), false);
  assert.equal(scopeWritesRequireSerial(['packages/backend/src/repos/files.ts'], projectPath), false);
});

test('scopeWritesConflict detects broad, identical, parent-child, absolute, and windows-style overlaps', () => {
  assert.equal(scopeWritesConflict(['.'], ['packages/frontend/src/pages/FilesPage.tsx'], projectPath), true);
  assert.equal(scopeWritesConflict(['packages/frontend'], ['packages/frontend/src/pages/FilesPage.tsx'], projectPath), true);
  assert.equal(scopeWritesConflict(['packages/frontend/src/pages/A.tsx'], ['packages/frontend/src/pages/A.tsx'], projectPath), true);
  assert.equal(scopeWritesConflict(['packages/frontend/src/pages/A.tsx'], ['packages/frontend/src/pages/B.tsx'], projectPath), false);
  assert.equal(scopeWritesConflict(['/repo/openDeepSea/packages/backend'], ['packages/backend/src/routes.ts'], projectPath), true);
  assert.equal(scopeWritesConflict(['packages\\backend'], ['packages/backend/src/routes.ts'], projectPath), true);
});
