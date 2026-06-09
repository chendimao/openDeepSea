import type { WorkspaceDirectoryEntry } from '../lib/types';
import type { WorkspaceFileTab } from './workspace-file-model';
import { workspaceFileTabId } from './workspace-file-model';

export type WorkspaceEntryKind = 'file' | 'directory';

export function parentPathForCreate(entry: WorkspaceDirectoryEntry | null): string {
  if (!entry) return '';
  if (entry.type === 'directory') return entry.path;
  return parentPath(entry.path);
}

export function validateWorkspaceEntryNameInput(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return '名称不能为空';
  if (trimmed === '.' || trimmed === '..') return '名称不能是 . 或 ..';
  if (/[\\/\0]/u.test(trimmed)) return '名称不能包含路径分隔符';
  return null;
}

export function renameWorkspaceTabPaths(
  tabs: WorkspaceFileTab[],
  oldPath: string,
  newPath: string,
  entryType: WorkspaceEntryKind,
): WorkspaceFileTab[] {
  return tabs.map((tab) => {
    const nextPath = renamedPath(tab.path, oldPath, newPath, entryType);
    if (!nextPath || nextPath === tab.path) return tab;
    return {
      ...tab,
      id: workspaceFileTabId(nextPath),
      path: nextPath,
      name: basename(nextPath),
    };
  });
}

export function closeTabsForDeletedEntry(
  tabs: WorkspaceFileTab[],
  deletedPath: string,
  entryType: WorkspaceEntryKind,
): WorkspaceFileTab[] {
  return tabs.filter((tab) => !isPathAffected(tab.path, deletedPath, entryType));
}

export function dirtyFilesUnderEntry<T extends { path: string }>(
  dirtyByPath: Record<string, T>,
  entryPath: string,
  entryType: WorkspaceEntryKind,
): string[] {
  return Object.keys(dirtyByPath).filter((path) => isPathAffected(path, entryPath, entryType));
}

export function renameDirtyPaths<T extends { path: string }>(
  dirtyByPath: Record<string, T>,
  oldPath: string,
  newPath: string,
  entryType: WorkspaceEntryKind,
): Record<string, T> {
  const next: Record<string, T> = {};
  Object.entries(dirtyByPath).forEach(([path, state]) => {
    const renamed = renamedPath(path, oldPath, newPath, entryType);
    if (!renamed) {
      next[path] = state;
      return;
    }
    next[renamed] = { ...state, path: renamed };
  });
  return next;
}

export function isPathAffected(path: string, targetPath: string, entryType: WorkspaceEntryKind): boolean {
  if (entryType === 'file') return path === targetPath;
  return path === targetPath || path.startsWith(`${targetPath}/`);
}

export function renamedPath(
  path: string,
  oldPath: string,
  newPath: string,
  entryType: WorkspaceEntryKind,
): string | null {
  if (entryType === 'file') return path === oldPath ? newPath : null;
  if (path === oldPath) return newPath;
  const prefix = `${oldPath}/`;
  return path.startsWith(prefix) ? `${newPath}/${path.slice(prefix.length)}` : null;
}

function parentPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}
