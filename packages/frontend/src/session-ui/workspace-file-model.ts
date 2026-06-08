import type { WorkspaceDirectoryEntry, WorkspaceFileViewerKind } from '../lib/types';

export interface WorkspaceFileTab {
  id: string;
  path: string;
  name: string;
  mimeType: string | null;
  language: string | null;
  size: number | null;
  viewerKind: WorkspaceFileViewerKind;
}

export function workspaceFileTabId(path: string): string {
  return `workspace-file:${path}`;
}

export function resolveWorkspaceFileViewer(file: WorkspaceDirectoryEntry): WorkspaceFileViewerKind {
  if (file.type !== 'file') return 'unsupported';

  const mimeType = (file.mimeType ?? '').toLowerCase();
  if (mimeType.startsWith('image/')) return 'image';
  if (
    mimeType.startsWith('text/') ||
    mimeType.includes('json') ||
    mimeType.includes('xml') ||
    mimeType.includes('yaml') ||
    mimeType.includes('javascript') ||
    mimeType.includes('typescript')
  ) {
    return 'text';
  }

  const extension = getFileExtension(file.name || file.path);
  if (imageExtensions.has(extension)) return 'image';
  if (textExtensions.has(extension) || textFileNames.has(file.name.toLowerCase())) return 'text';
  return 'unsupported';
}

export function createWorkspaceFileTab(file: WorkspaceDirectoryEntry): WorkspaceFileTab {
  return {
    id: workspaceFileTabId(file.path),
    path: file.path,
    name: file.name,
    mimeType: file.mimeType,
    language: file.language,
    size: file.size,
    viewerKind: resolveWorkspaceFileViewer(file),
  };
}

export function openWorkspaceFileTab(tabs: WorkspaceFileTab[], file: WorkspaceDirectoryEntry): {
  tabs: WorkspaceFileTab[];
  activePath: string;
} {
  if (tabs.some((tab) => tab.path === file.path)) {
    return {
      tabs,
      activePath: file.path,
    };
  }

  return {
    tabs: [...tabs, createWorkspaceFileTab(file)],
    activePath: file.path,
  };
}

export function closeWorkspaceFileTab(
  tabs: WorkspaceFileTab[],
  path: string,
  currentActivePath: string | null = null,
): {
  tabs: WorkspaceFileTab[];
  activePath: string | null;
} {
  const closedIndex = tabs.findIndex((tab) => tab.path === path);
  if (closedIndex === -1) {
    return {
      tabs,
      activePath: currentActivePath && tabs.some((tab) => tab.path === currentActivePath)
        ? currentActivePath
        : tabs[0]?.path ?? null,
    };
  }

  const nextTabs = tabs.filter((tab) => tab.path !== path);
  if (currentActivePath && currentActivePath !== path && nextTabs.some((tab) => tab.path === currentActivePath)) {
    return {
      tabs: nextTabs,
      activePath: currentActivePath,
    };
  }

  const previousTab = tabs[closedIndex - 1];
  return {
    tabs: nextTabs,
    activePath: previousTab?.path ?? nextTabs[0]?.path ?? null,
  };
}

export function reorderWorkspaceFileTabs(tabs: WorkspaceFileTab[], ids: string[]): WorkspaceFileTab[] {
  const tabsById = new Map(tabs.map((tab) => [tab.id, tab]));
  const selectedIds = new Set<string>();
  const orderedTabs: WorkspaceFileTab[] = [];

  for (const id of ids) {
    const tab = tabsById.get(id);
    if (!tab || selectedIds.has(id)) continue;
    orderedTabs.push(tab);
    selectedIds.add(id);
  }

  return [
    ...orderedTabs,
    ...tabs.filter((tab) => !selectedIds.has(tab.id)),
  ];
}

function getFileExtension(name: string): string {
  const lastSegment = name.split(/[\\/]/u).pop() ?? name;
  const dotIndex = lastSegment.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === lastSegment.length - 1) return '';
  return lastSegment.slice(dotIndex + 1).toLowerCase();
}

const imageExtensions = new Set([
  'apng',
  'avif',
  'gif',
  'jpeg',
  'jpg',
  'png',
  'svg',
  'webp',
]);

const textExtensions = new Set([
  'bash',
  'c',
  'cjs',
  'cpp',
  'css',
  'csv',
  'cts',
  'env',
  'go',
  'h',
  'hpp',
  'html',
  'ini',
  'java',
  'js',
  'json',
  'jsx',
  'log',
  'md',
  'mdx',
  'mjs',
  'mts',
  'py',
  'rb',
  'rs',
  'scss',
  'sh',
  'sql',
  'svelte',
  'toml',
  'ts',
  'tsx',
  'txt',
  'vue',
  'xml',
  'yaml',
  'yml',
  'zsh',
]);

const textFileNames = new Set([
  '.env',
  '.gitignore',
  'dockerfile',
  'makefile',
]);
