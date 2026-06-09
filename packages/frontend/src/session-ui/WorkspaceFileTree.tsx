import { useQuery } from '@tanstack/react-query';
import { ChevronRight, File, Folder, FolderOpen, RefreshCcw } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  StaticTreeDataProvider,
  Tree,
  UncontrolledTreeEnvironment,
  type TreeItem,
  type TreeItemIndex,
} from 'react-complex-tree';
import { api } from '../lib/api';
import type { WorkspaceDirectoryEntry } from '../lib/types';
import { pickInitialWorkspaceFile } from './workspace-file-model';

type TreeItemData = WorkspaceDirectoryEntry & { title: string };
type WorkspaceTreeItem = TreeItem<TreeItemData>;

const ROOT_ITEM_ID = 'workspace-root';
const WORKSPACE_TREE_ID = 'workspace-tree';

export function WorkspaceFileTree({
  projectId,
  activePath,
  autoOpenRootFile = false,
  onOpenFile,
}: {
  projectId: string;
  activePath?: string | null;
  autoOpenRootFile?: boolean;
  onOpenFile: (file: WorkspaceDirectoryEntry) => void;
}): JSX.Element {
  const [loadedDirs, setLoadedDirs] = useState<Record<string, WorkspaceDirectoryEntry[]>>({});
  const [failedDirs, setFailedDirs] = useState<Record<string, string>>({});
  const hasAutoOpenedRef = useRef(false);
  const rootQuery = useQuery({
    queryKey: ['workspace-tree', projectId, ''],
    queryFn: () => api.listWorkspaceDirectory(projectId, ''),
  });

  const rootEntries = rootQuery.data?.entries ?? [];
  const treeItems = useMemo(() => buildTreeItems(rootEntries, loadedDirs), [rootEntries, loadedDirs]);
  const dataProvider = useMemo(
    () => new StaticTreeDataProvider<TreeItemData>(treeItems, (item, title) => ({
      ...item,
      data: { ...item.data, title },
    })),
    [treeItems],
  );
  const viewState = useMemo(
    () => ({
      [WORKSPACE_TREE_ID]: {
        selectedItems: activePath ? [activePath] : [],
      },
    }),
    [activePath],
  );

  useEffect(() => {
    setLoadedDirs({});
    setFailedDirs({});
    hasAutoOpenedRef.current = false;
  }, [projectId]);

  useEffect(() => {
    if (!autoOpenRootFile || hasAutoOpenedRef.current) return;
    const initialFile = pickInitialWorkspaceFile(rootEntries);
    if (!initialFile) return;
    hasAutoOpenedRef.current = true;
    onOpenFile(initialFile);
  }, [autoOpenRootFile, onOpenFile, rootEntries]);

  if (rootQuery.isLoading) return <FileTreeState>正在加载目录...</FileTreeState>;
  if (rootQuery.isError) {
    return (
      <FileTreeState>
        <strong>目录加载失败</strong>
        <button type="button" onClick={() => void rootQuery.refetch()}>
          <RefreshCcw aria-hidden="true" />
          重试
        </button>
      </FileTreeState>
    );
  }

  return (
    <div className="deepsea-workspace-tree">
      {Object.keys(failedDirs).length > 0 ? (
        <div className="deepsea-workspace-tree__notice">部分目录读取失败</div>
      ) : null}
      <UncontrolledTreeEnvironment<TreeItemData>
        dataProvider={dataProvider}
        getItemTitle={(item) => item.data.title}
        viewState={viewState}
        disableMultiselect
        canDragAndDrop={false}
        canDropOnFolder={false}
        canDropOnNonFolder={false}
        canReorderItems={false}
        canRename={false}
        canSearch={false}
        onSelectItems={(items) => {
          const entry = findEntry(treeItems, items[0]);
          if (entry?.type === 'file') onOpenFile(entry);
        }}
        onExpandItem={(item) => {
          if (item.data.type !== 'directory' || loadedDirs[item.data.path]) return;
          void api.listWorkspaceDirectory(projectId, item.data.path)
            .then((result) => {
              setLoadedDirs((current) => ({ ...current, [item.data.path]: result.entries }));
              setFailedDirs((current) => {
                const next = { ...current };
                delete next[item.data.path];
                return next;
              });
            })
            .catch((error: unknown) => {
              setFailedDirs((current) => ({
                ...current,
                [item.data.path]: error instanceof Error ? error.message : '读取目录失败',
              }));
            });
        }}
        renderItemTitle={({ item }) => (
          <WorkspaceTreeTitle
            item={item}
            failedMessage={failedDirs[item.data.path]}
            isActive={item.data.path === activePath}
          />
        )}
        renderItemArrow={({ item, context }) => (
          item.isFolder ? (
            <ChevronRight
              aria-hidden="true"
              className={context.isExpanded ? 'is-expanded' : undefined}
            />
          ) : null
        )}
      >
        <Tree treeId={WORKSPACE_TREE_ID} rootItem={ROOT_ITEM_ID} treeLabel="当前项目目录" />
      </UncontrolledTreeEnvironment>
    </div>
  );
}

function WorkspaceTreeTitle({
  item,
  failedMessage,
  isActive,
}: {
  item: WorkspaceTreeItem;
  failedMessage?: string;
  isActive: boolean;
}): JSX.Element {
  const Icon = item.data.type === 'directory' ? (item.children?.length ? FolderOpen : Folder) : File;
  return (
    <span
      className="deepsea-workspace-tree__title"
      data-active={isActive ? 'true' : undefined}
      title={failedMessage ?? item.data.path}
    >
      <Icon aria-hidden="true" />
      <span>{item.data.title}</span>
    </span>
  );
}

function FileTreeState({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="deepsea-file-tree-state">{children}</div>;
}

function buildTreeItems(
  rootEntries: WorkspaceDirectoryEntry[],
  loadedDirs: Record<string, WorkspaceDirectoryEntry[]>,
): Record<TreeItemIndex, WorkspaceTreeItem> {
  const items: Record<TreeItemIndex, WorkspaceTreeItem> = {
    [ROOT_ITEM_ID]: {
      index: ROOT_ITEM_ID,
      canMove: false,
      isFolder: true,
      children: rootEntries.map((entry) => entry.path),
      data: {
        name: 'root',
        title: 'root',
        path: '',
        type: 'directory',
        size: null,
        mimeType: null,
        language: null,
      },
    },
  };

  const appendEntry = (entry: WorkspaceDirectoryEntry) => {
    const children = loadedDirs[entry.path] ?? [];
    items[entry.path] = {
      index: entry.path,
      canMove: false,
      isFolder: entry.type === 'directory',
      children: entry.type === 'directory' ? children.map((child) => child.path) : undefined,
      data: { ...entry, title: entry.name },
    };
    children.forEach(appendEntry);
  };

  rootEntries.forEach(appendEntry);
  return items;
}

function findEntry(
  treeItems: Record<TreeItemIndex, WorkspaceTreeItem>,
  itemId: TreeItemIndex | undefined,
): WorkspaceDirectoryEntry | null {
  if (itemId === undefined) return null;
  const item = treeItems[itemId];
  return item?.data ?? null;
}
