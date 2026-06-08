import assert from 'node:assert/strict';
import test from 'node:test';
import {
  closeWorkspaceFileTab,
  createWorkspaceFileTab,
  openWorkspaceFileTab,
  reorderWorkspaceFileTabs,
  resolveWorkspaceFileViewer,
  workspaceFileTabId,
  type WorkspaceFileTab,
} from './workspace-file-model';
import type { WorkspaceDirectoryEntry } from '../lib/types';

test('openWorkspaceFileTab opens a new file tab and reuses an existing path', () => {
  const readme = createWorkspaceFile({ path: 'README.md', name: 'README.md', mimeType: 'text/markdown' });
  const packageJson = createWorkspaceFile({ path: 'package.json', name: 'package.json', mimeType: 'application/json' });

  const opened = openWorkspaceFileTab([], readme);

  assert.deepEqual(opened, {
    tabs: [
      {
        id: workspaceFileTabId('README.md'),
        path: 'README.md',
        name: 'README.md',
        mimeType: 'text/markdown',
        language: null,
        size: null,
        viewerKind: 'text',
      },
    ],
    activePath: 'README.md',
  });

  const withSecondTab = openWorkspaceFileTab(opened.tabs, packageJson);
  assert.deepEqual(withSecondTab.tabs.map((tab) => tab.path), ['README.md', 'package.json']);
  assert.equal(withSecondTab.activePath, 'package.json');

  const reused = openWorkspaceFileTab(withSecondTab.tabs, createWorkspaceFile({
    path: 'README.md',
    name: 'README.md',
    mimeType: 'text/markdown',
  }));

  assert.equal(reused.tabs.length, 2);
  assert.deepEqual(reused.tabs.map((tab) => tab.path), ['README.md', 'package.json']);
  assert.equal(reused.activePath, 'README.md');
});

test('closeWorkspaceFileTab closes a tab and falls back to the previous or first remaining tab', () => {
  const tabs: WorkspaceFileTab[] = [
    createWorkspaceFileTab(createWorkspaceFile({ path: 'src/a.ts', name: 'a.ts' })),
    createWorkspaceFileTab(createWorkspaceFile({ path: 'src/b.ts', name: 'b.ts' })),
    createWorkspaceFileTab(createWorkspaceFile({ path: 'src/c.ts', name: 'c.ts' })),
  ];

  const closedMiddle = closeWorkspaceFileTab(tabs, 'src/b.ts');
  assert.deepEqual(closedMiddle.tabs.map((tab) => tab.path), ['src/a.ts', 'src/c.ts']);
  assert.equal(closedMiddle.activePath, 'src/a.ts');

  const closedFirst = closeWorkspaceFileTab(closedMiddle.tabs, 'src/a.ts');
  assert.deepEqual(closedFirst.tabs.map((tab) => tab.path), ['src/c.ts']);
  assert.equal(closedFirst.activePath, 'src/c.ts');

  const closedLast = closeWorkspaceFileTab(closedFirst.tabs, 'src/c.ts');
  assert.deepEqual(closedLast.tabs, []);
  assert.equal(closedLast.activePath, null);
});

test('closeWorkspaceFileTab keeps the active tab when closing a different tab', () => {
  const tabs: WorkspaceFileTab[] = [
    createWorkspaceFileTab(createWorkspaceFile({ path: 'src/a.ts', name: 'a.ts' })),
    createWorkspaceFileTab(createWorkspaceFile({ path: 'src/b.ts', name: 'b.ts' })),
    createWorkspaceFileTab(createWorkspaceFile({ path: 'src/c.ts', name: 'c.ts' })),
  ];

  const result = closeWorkspaceFileTab(tabs, 'src/a.ts', 'src/c.ts');

  assert.deepEqual(result.tabs.map((tab) => tab.path), ['src/b.ts', 'src/c.ts']);
  assert.equal(result.activePath, 'src/c.ts');
});

test('reorderWorkspaceFileTabs orders known ids and keeps missing tabs after them', () => {
  const tabs: WorkspaceFileTab[] = [
    createWorkspaceFileTab(createWorkspaceFile({ path: 'src/a.ts', name: 'a.ts' })),
    createWorkspaceFileTab(createWorkspaceFile({ path: 'src/b.ts', name: 'b.ts' })),
    createWorkspaceFileTab(createWorkspaceFile({ path: 'src/c.ts', name: 'c.ts' })),
    createWorkspaceFileTab(createWorkspaceFile({ path: 'src/d.ts', name: 'd.ts' })),
  ];

  const reordered = reorderWorkspaceFileTabs(tabs, [
    workspaceFileTabId('src/c.ts'),
    'unknown-tab',
    workspaceFileTabId('src/a.ts'),
  ]);

  assert.deepEqual(reordered.map((tab) => tab.path), ['src/c.ts', 'src/a.ts', 'src/b.ts', 'src/d.ts']);
});

test('resolveWorkspaceFileViewer distinguishes text, image, and unsupported files', () => {
  assert.equal(resolveWorkspaceFileViewer(createWorkspaceFile({
    path: 'src/App.tsx',
    name: 'App.tsx',
    mimeType: 'application/octet-stream',
  })), 'text');
  assert.equal(resolveWorkspaceFileViewer(createWorkspaceFile({
    path: 'assets/logo.svg',
    name: 'logo.svg',
    mimeType: 'image/svg+xml',
  })), 'image');
  assert.equal(resolveWorkspaceFileViewer(createWorkspaceFile({
    path: 'archive.zip',
    name: 'archive.zip',
    mimeType: 'application/zip',
  })), 'unsupported');
});

function createWorkspaceFile(overrides: Partial<WorkspaceDirectoryEntry>): WorkspaceDirectoryEntry {
  return {
    path: 'src/index.ts',
    name: 'index.ts',
    type: 'file',
    size: null,
    mimeType: null,
    language: null,
    ...overrides,
  };
}
