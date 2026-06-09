import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWorkspaceAbsolutePath } from './WorkspaceFileTree';

test('buildWorkspaceAbsolutePath joins a workspace root and relative entry path', () => {
  assert.equal(
    buildWorkspaceAbsolutePath('/Users/demo/project', 'packages/frontend/src/App.tsx'),
    '/Users/demo/project/packages/frontend/src/App.tsx',
  );
});

test('buildWorkspaceAbsolutePath avoids duplicate separators after a trailing root slash', () => {
  assert.equal(
    buildWorkspaceAbsolutePath('/Users/demo/project/', 'docs/readme.md'),
    '/Users/demo/project/docs/readme.md',
  );
});

test('buildWorkspaceAbsolutePath preserves Windows-style roots', () => {
  assert.equal(
    buildWorkspaceAbsolutePath('C:\\work\\project', 'src/App.tsx'),
    'C:\\work\\project\\src\\App.tsx',
  );
});

test('buildWorkspaceAbsolutePath falls back to the entry path when root is unavailable', () => {
  assert.equal(buildWorkspaceAbsolutePath(null, 'src/App.tsx'), 'src/App.tsx');
});
