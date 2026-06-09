import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkspaceDirectoryEntry } from '../lib/types';
import {
  closeTabsForDeletedEntry,
  dirtyFilesUnderEntry,
  parentPathForCreate,
  renameDirtyPaths,
  renameWorkspaceTabPaths,
  validateWorkspaceEntryNameInput,
} from './workspace-file-operations';
import { createWorkspaceFileTab, type WorkspaceFileTab } from './workspace-file-model';

test('parentPathForCreate resolves root, selected folders, and selected file parents', () => {
  assert.equal(parentPathForCreate(null), '');
  assert.equal(parentPathForCreate(entry({ path: 'src', name: 'src', type: 'directory' })), 'src');
  assert.equal(parentPathForCreate(entry({ path: 'src/App.tsx', name: 'App.tsx', type: 'file' })), 'src');
  assert.equal(parentPathForCreate(entry({ path: 'README.md', name: 'README.md', type: 'file' })), '');
});

test('validateWorkspaceEntryNameInput rejects invalid file manager names', () => {
  assert.equal(validateWorkspaceEntryNameInput('App.tsx'), null);
  assert.match(validateWorkspaceEntryNameInput('') ?? '', /名称不能为空/);
  assert.match(validateWorkspaceEntryNameInput('..') ?? '', /不能是/);
  assert.match(validateWorkspaceEntryNameInput('a/b') ?? '', /不能包含/);
});

test('renameWorkspaceTabPaths updates files and nested directory tabs', () => {
  const tabs = [
    tab('src/App.tsx'),
    tab('src/components/Button.tsx'),
    tab('README.md'),
  ];
  assert.deepEqual(renameWorkspaceTabPaths(tabs, 'src/App.tsx', 'src/Main.tsx', 'file').map((item) => item.path), [
    'src/Main.tsx',
    'src/components/Button.tsx',
    'README.md',
  ]);
  assert.deepEqual(renameWorkspaceTabPaths(tabs, 'src', 'packages/frontend/src', 'directory').map((item) => item.path), [
    'packages/frontend/src/App.tsx',
    'packages/frontend/src/components/Button.tsx',
    'README.md',
  ]);
});

test('closeTabsForDeletedEntry closes files and nested directory tabs', () => {
  const tabs = [tab('src/App.tsx'), tab('src/components/Button.tsx'), tab('README.md')];
  assert.deepEqual(closeTabsForDeletedEntry(tabs, 'src/App.tsx', 'file').map((item) => item.path), [
    'src/components/Button.tsx',
    'README.md',
  ]);
  assert.deepEqual(closeTabsForDeletedEntry(tabs, 'src', 'directory').map((item) => item.path), ['README.md']);
});

test('dirty helpers find and rename affected dirty paths', () => {
  const dirty = {
    'src/App.tsx': { path: 'src/App.tsx' },
    'src/components/Button.tsx': { path: 'src/components/Button.tsx' },
    'README.md': { path: 'README.md' },
  };
  assert.deepEqual(dirtyFilesUnderEntry(dirty, 'src', 'directory'), ['src/App.tsx', 'src/components/Button.tsx']);
  assert.deepEqual(Object.keys(renameDirtyPaths(dirty, 'src', 'packages/frontend/src', 'directory')), [
    'packages/frontend/src/App.tsx',
    'packages/frontend/src/components/Button.tsx',
    'README.md',
  ]);
});

function entry(overrides: Partial<WorkspaceDirectoryEntry>): WorkspaceDirectoryEntry {
  return {
    path: 'src/App.tsx',
    name: 'App.tsx',
    type: 'file',
    size: null,
    mimeType: 'text/plain',
    language: 'typescript',
    ...overrides,
  };
}

function tab(path: string): WorkspaceFileTab {
  return createWorkspaceFileTab(entry({
    path,
    name: path.split('/').pop() ?? path,
  }));
}
