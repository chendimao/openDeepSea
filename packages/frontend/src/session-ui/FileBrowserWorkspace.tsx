import * as Dialog from '@radix-ui/react-dialog';
import { useQueryClient } from '@tanstack/react-query';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import type { WorkspaceDirectoryEntry } from '../lib/types';
import { WorkspaceFileTabs } from './WorkspaceFileTabs';
import { WorkspaceFileTree } from './WorkspaceFileTree';
import type { WorkspaceFileDirtyState } from './FileViewers';
import {
  closeTabsForDeletedEntry,
  dirtyFilesUnderEntry,
  renameDirtyPaths,
  renamedPath,
  renameWorkspaceTabPaths,
} from './workspace-file-operations';
import {
  closeWorkspaceFileTab,
  openWorkspaceFileTab,
  reorderWorkspaceFileTabs,
  type WorkspaceFileTab,
} from './workspace-file-model';

type PendingWorkspaceAction =
  | { type: 'close-tab'; path: string }
  | { type: 'delete-entry'; entry: WorkspaceDirectoryEntry }
  | { type: 'rename-entry'; entry: WorkspaceDirectoryEntry; name: string }
  | { type: 'save-conflict'; path: string };

type DirtyConfirmState = {
  dirtyPaths: string[];
  action: PendingWorkspaceAction;
};

export function FileBrowserWorkspace({ projectId }: { projectId: string }): JSX.Element {
  const queryClient = useQueryClient();
  const [tabs, setTabs] = useState<WorkspaceFileTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<WorkspaceDirectoryEntry | null>(null);
  const [treeRefreshVersion, setTreeRefreshVersion] = useState(0);
  const [dirtyByPath, setDirtyByPath] = useState<Record<string, WorkspaceFileDirtyState>>({});
  const [dirtyConfirm, setDirtyConfirm] = useState<DirtyConfirmState | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<WorkspaceDirectoryEntry | null>(null);
  const dirtyPaths = useMemo(() => new Set(Object.keys(dirtyByPath)), [dirtyByPath]);

  useEffect(() => {
    setTabs([]);
    setActivePath(null);
    setSelectedEntry(null);
    setDirtyByPath({});
    setDirtyConfirm(null);
    setDeleteConfirm(null);
    setTreeRefreshVersion((version) => version + 1);
  }, [projectId]);

  const openFile = useCallback((file: WorkspaceDirectoryEntry) => {
    if (file.type !== 'file') return;
    setSelectedEntry(file);
    setTabs((current) => {
      const result = openWorkspaceFileTab(current, file);
      setActivePath(result.activePath);
      return result.tabs;
    });
  }, []);

  const refreshDirectory = useCallback((path: string) => {
    void queryClient.invalidateQueries({ queryKey: ['workspace-tree', projectId, path] });
    setTreeRefreshVersion((version) => version + 1);
  }, [projectId, queryClient]);

  const closeFileWithoutConfirm = useCallback((path: string) => {
    setTabs((current) => {
      const result = closeWorkspaceFileTab(current, path, activePath);
      setActivePath(result.activePath);
      return result.tabs;
    });
    setDirtyByPath((current) => {
      if (!current[path]) return current;
      const next = { ...current };
      delete next[path];
      return next;
    });
  }, [activePath]);

  const createFile = useCallback(async (parentPath: string, name: string) => {
    const result = await api.createWorkspaceFile(projectId, { parentPath, name });
    refreshDirectory(parentPath);
    setSelectedEntry(result.entry);
    openFile(result.entry);
  }, [openFile, projectId, refreshDirectory]);

  const createDirectory = useCallback(async (parentPath: string, name: string) => {
    const result = await api.createWorkspaceDirectory(projectId, { parentPath, name });
    refreshDirectory(parentPath);
    setSelectedEntry(result.entry);
  }, [projectId, refreshDirectory]);

  const performRenameEntry = useCallback(async (entry: WorkspaceDirectoryEntry, name: string) => {
    const result = await api.renameWorkspaceEntry(projectId, { path: entry.path, name });
    const parent = entry.path.split('/').slice(0, -1).join('/');
    refreshDirectory(parent);
    setTabs((current) => renameWorkspaceTabPaths(current, result.oldPath, result.newPath, entry.type));
    setDirtyByPath((current) => renameDirtyPaths(current, result.oldPath, result.newPath, entry.type));
    setActivePath((current) => (
      current ? renamedPath(current, result.oldPath, result.newPath, entry.type) ?? current : current
    ));
    setSelectedEntry(result.entry);
  }, [projectId, refreshDirectory]);

  const requestDeleteEntry = useCallback((entry: WorkspaceDirectoryEntry) => {
    setDeleteConfirm(entry);
  }, []);

  const confirmDeleteEntry = useCallback(async (entry: WorkspaceDirectoryEntry) => {
    await api.deleteWorkspaceEntry(projectId, { path: entry.path });
    const parent = entry.path.split('/').slice(0, -1).join('/');
    refreshDirectory(parent);
    setTabs((current) => {
      const nextTabs = closeTabsForDeletedEntry(current, entry.path, entry.type);
      setActivePath((currentActivePath) => {
        if (!currentActivePath) return nextTabs[0]?.path ?? null;
        return nextTabs.some((tab) => tab.path === currentActivePath)
          ? currentActivePath
          : nextTabs[0]?.path ?? null;
      });
      return nextTabs;
    });
    setDirtyByPath((current) => {
      const affected = new Set(dirtyFilesUnderEntry(current, entry.path, entry.type));
      if (affected.size === 0) return current;
      const next = { ...current };
      affected.forEach((path) => delete next[path]);
      return next;
    });
    setSelectedEntry(null);
    setDeleteConfirm(null);
  }, [projectId, refreshDirectory]);

  const runPendingAction = useCallback(async (action: PendingWorkspaceAction) => {
    if (action.type === 'close-tab') {
      closeFileWithoutConfirm(action.path);
      return;
    }
    if (action.type === 'rename-entry') {
      await performRenameEntry(action.entry, action.name);
      return;
    }
    if (action.type === 'delete-entry') {
      requestDeleteEntry(action.entry);
    }
  }, [closeFileWithoutConfirm, performRenameEntry, requestDeleteEntry]);

  const runOrConfirmDirty = useCallback((dirtyActionPaths: string[], action: PendingWorkspaceAction): Promise<void> => {
    if (dirtyActionPaths.length === 0) {
      return runPendingAction(action);
    }
    setDirtyConfirm({ dirtyPaths: dirtyActionPaths, action });
    return Promise.resolve();
  }, [runPendingAction]);

  const closeFile = useCallback((path: string) => {
    void runOrConfirmDirty(dirtyByPath[path] ? [path] : [], { type: 'close-tab', path });
  }, [dirtyByPath, runOrConfirmDirty]);

  const renameEntry = useCallback(async (entry: WorkspaceDirectoryEntry, name: string) => {
    const affectedDirtyPaths = dirtyFilesUnderEntry(dirtyByPath, entry.path, entry.type);
    await runOrConfirmDirty(affectedDirtyPaths, { type: 'rename-entry', entry, name });
  }, [dirtyByPath, runOrConfirmDirty]);

  const deleteEntry = useCallback(async (entry: WorkspaceDirectoryEntry) => {
    const affectedDirtyPaths = dirtyFilesUnderEntry(dirtyByPath, entry.path, entry.type);
    await runOrConfirmDirty(affectedDirtyPaths, { type: 'delete-entry', entry });
  }, [dirtyByPath, runOrConfirmDirty]);

  const onDraftChange = useCallback((
    path: string,
    savedContent: string,
    draftContent: string,
    mtimeMs: number | null,
  ) => {
    setDirtyByPath((current) => {
      if (draftContent === savedContent) {
        if (!current[path]) return current;
        const next = { ...current };
        delete next[path];
        return next;
      }
      return {
        ...current,
        [path]: {
          path,
          savedContent,
          draftContent,
          mtimeMs,
          saving: current[path]?.saving ?? false,
          saveError: null,
        },
      };
    });
  }, []);

  const saveFile = useCallback(async (path: string, options: { force?: boolean } = {}): Promise<boolean> => {
    const dirty = dirtyByPath[path];
    if (!dirty) return true;
    setDirtyByPath((current) => ({
      ...current,
      [path]: { ...dirty, saving: true, saveError: null },
    }));
    try {
      const preview = await api.saveWorkspaceFile(projectId, {
        path,
        content: dirty.draftContent,
        expectedMtimeMs: dirty.mtimeMs,
        force: options.force,
      });
      setDirtyByPath((current) => {
        const next = { ...current };
        delete next[path];
        return next;
      });
      queryClient.setQueryData(['workspace-file-preview', projectId, path], preview);
      void queryClient.invalidateQueries({ queryKey: ['workspace-tree', projectId] });
      toast.success('文件已保存', { description: path });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : '保存失败';
      if (message.includes('WORKSPACE_FILE_CONFLICT')) {
        setDirtyConfirm({ dirtyPaths: [path], action: { type: 'save-conflict', path } });
      }
      setDirtyByPath((current) => ({
        ...current,
        [path]: {
          ...dirty,
          saving: false,
          saveError: message,
        },
      }));
      return false;
    }
  }, [dirtyByPath, projectId, queryClient]);

  const saveDirtyAndContinue = useCallback(async (state: DirtyConfirmState) => {
    if (state.action.type === 'save-conflict') return;
    for (const path of state.dirtyPaths) {
      const saved = await saveFile(path);
      if (!saved) return;
    }
    setDirtyConfirm(null);
    await runPendingAction(state.action);
  }, [runPendingAction, saveFile]);

  const discardDirtyAndContinue = useCallback((state: DirtyConfirmState) => {
    setDirtyByPath((current) => {
      const next = { ...current };
      state.dirtyPaths.forEach((path) => delete next[path]);
      return next;
    });
    setDirtyConfirm(null);
    void runPendingAction(state.action);
  }, [runPendingAction]);

  const reloadConflictedFile = useCallback((path: string) => {
    setDirtyByPath((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
    setDirtyConfirm(null);
    void queryClient.invalidateQueries({ queryKey: ['workspace-file-preview', projectId, path] });
  }, [projectId, queryClient]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      if (activePath) void saveFile(activePath);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activePath, saveFile]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (Object.keys(dirtyByPath).length === 0) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirtyByPath]);

  return (
    <div className="deepsea-file-browser">
      <aside className="deepsea-file-browser__tree" aria-label="项目文件目录">
        <WorkspaceFileTree
          projectId={projectId}
          activePath={activePath}
          selectedPath={selectedEntry?.path ?? null}
          dirtyPaths={dirtyPaths}
          refreshVersion={treeRefreshVersion}
          autoOpenRootFile={tabs.length === 0 && activePath === null}
          onSelectEntry={setSelectedEntry}
          onOpenFile={openFile}
          onCreateFile={createFile}
          onCreateDirectory={createDirectory}
          onRenameEntry={renameEntry}
          onDeleteEntry={deleteEntry}
        />
      </aside>
      <section className="deepsea-file-browser__tabs" aria-label="打开的项目文件">
        <WorkspaceFileTabs
          projectId={projectId}
          tabs={tabs}
          activePath={activePath}
          dirtyPaths={dirtyPaths}
          dirtyByPath={dirtyByPath}
          onClose={closeFile}
          onFocus={setActivePath}
          onReorder={(ids) => setTabs((current) => reorderWorkspaceFileTabs(current, ids))}
          onDraftChange={onDraftChange}
          onSave={saveFile}
        />
      </section>
      {dirtyConfirm ? (
        <DirtyConfirmDialog
          state={dirtyConfirm}
          onCancel={() => setDirtyConfirm(null)}
          onDiscard={() => discardDirtyAndContinue(dirtyConfirm)}
          onForceSave={() => void saveFile(dirtyConfirm.action.type === 'save-conflict' ? dirtyConfirm.action.path : dirtyConfirm.dirtyPaths[0] ?? '', { force: true })
            .then((saved) => {
              if (saved) setDirtyConfirm(null);
            })}
          onReload={() => {
            if (dirtyConfirm.action.type === 'save-conflict') reloadConflictedFile(dirtyConfirm.action.path);
          }}
          onSave={() => void saveDirtyAndContinue(dirtyConfirm)}
        />
      ) : null}
      {deleteConfirm ? (
        <DeleteConfirmDialog
          entry={deleteConfirm}
          onCancel={() => setDeleteConfirm(null)}
          onConfirm={() => void confirmDeleteEntry(deleteConfirm)}
        />
      ) : null}
    </div>
  );
}

function DirtyConfirmDialog({
  state,
  onCancel,
  onDiscard,
  onForceSave,
  onReload,
  onSave,
}: {
  state: DirtyConfirmState;
  onCancel: () => void;
  onDiscard: () => void;
  onForceSave: () => void;
  onReload: () => void;
  onSave: () => void;
}): JSX.Element {
  const isConflict = state.action.type === 'save-conflict';
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="deepsea-workspace-dialog-overlay" />
        <Dialog.Content className="deepsea-workspace-dialog">
          <Dialog.Title>{isConflict ? '磁盘文件已变化' : '存在未保存修改'}</Dialog.Title>
          {isConflict ? (
            <p>当前文件在磁盘上已经被外部修改。</p>
          ) : (
            <>
              <p>以下文件有未保存修改：</p>
              <ul>
                {state.dirtyPaths.slice(0, 5).map((path) => <li key={path}>{path}</li>)}
              </ul>
              {state.dirtyPaths.length > 5 ? <p>还有 {state.dirtyPaths.length - 5} 个文件</p> : null}
            </>
          )}
          <div className="deepsea-workspace-dialog__actions">
            {isConflict ? (
              <>
                <button type="button" onClick={onReload}>重新加载磁盘版本</button>
                <button type="button" data-primary="true" onClick={onForceSave}>强制覆盖</button>
              </>
            ) : (
              <>
                <button type="button" data-primary="true" onClick={onSave}>保存并继续</button>
                <button type="button" onClick={onDiscard}>放弃并继续</button>
              </>
            )}
            <button type="button" onClick={onCancel}>取消</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function DeleteConfirmDialog({
  entry,
  onCancel,
  onConfirm,
}: {
  entry: WorkspaceDirectoryEntry;
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element {
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="deepsea-workspace-dialog-overlay" />
        <Dialog.Content className="deepsea-workspace-dialog">
          <Dialog.Title>永久删除</Dialog.Title>
          <p>
            {entry.type === 'directory'
              ? `将永久删除 ${entry.path || '项目根目录'} 及其内容。`
              : `将永久删除 ${entry.path}。`}
          </p>
          <div className="deepsea-workspace-dialog__actions">
            <button type="button" onClick={onCancel}>取消</button>
            <button type="button" data-danger="true" onClick={onConfirm}>删除</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
