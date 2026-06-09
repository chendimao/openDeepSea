import { useQuery } from '@tanstack/react-query';
import { ChevronRight, File, FilePlus, Folder, FolderOpen, FolderPlus, RefreshCcw, Search, X } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ControlledTreeEnvironment,
  InteractionMode,
  Tree,
  type TreeItem,
  type TreeItemIndex,
} from 'react-complex-tree';
import { api } from '../lib/api';
import type { WorkspaceDirectoryEntry } from '../lib/types';
import { pickInitialWorkspaceFile } from './workspace-file-model';

type TreeItemData = WorkspaceDirectoryEntry & { title: string };
type WorkspaceTreeItem = TreeItem<TreeItemData>;

const ROOT_ITEM_ID = 'workspace-root';
const PROJECT_ROOT_ITEM_ID = 'workspace-project-root';
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
  const [expandedItems, setExpandedItems] = useState<TreeItemIndex[]>([PROJECT_ROOT_ITEM_ID]);
  const [focusedItem, setFocusedItem] = useState<TreeItemIndex>(PROJECT_ROOT_ITEM_ID);
  const [searchText, setSearchText] = useState('');
  const hasAutoOpenedRef = useRef(false);
  const treeRef = useRef<HTMLDivElement | null>(null);
  const rootQuery = useQuery({
    queryKey: ['workspace-tree', projectId, ''],
    queryFn: () => api.listWorkspaceDirectory(projectId, ''),
  });

  const rootEntries = rootQuery.data?.entries ?? [];
  const treeItems = useMemo(() => buildTreeItems(rootEntries, loadedDirs), [rootEntries, loadedDirs]);
  const normalizedSearch = normalizeSearch(searchText);
  const visibleTreeResult = useMemo(
    () => filterTreeItemsForSearch(treeItems, normalizedSearch),
    [normalizedSearch, treeItems],
  );
  const visibleTreeItems = visibleTreeResult.items;
  const matchedItemIds = visibleTreeResult.matchedItemIds;
  const searchExpandedItems = useMemo(
    () => collectExpandedDirectoryIds(visibleTreeItems),
    [visibleTreeItems],
  );
  const currentExpandedItems = normalizedSearch ? searchExpandedItems : expandedItems;
  const selectedItems = activePath && visibleTreeItems[activePath] ? [activePath] : [];
  const currentFocusedItem = visibleTreeItems[focusedItem] ? focusedItem : PROJECT_ROOT_ITEM_ID;
  const viewState = useMemo(
    () => ({
      [WORKSPACE_TREE_ID]: {
        expandedItems: currentExpandedItems,
        selectedItems,
        focusedItem: currentFocusedItem,
      },
    }),
    [currentExpandedItems, currentFocusedItem, selectedItems],
  );

  useEffect(() => {
    setLoadedDirs({});
    setFailedDirs({});
    setExpandedItems([PROJECT_ROOT_ITEM_ID]);
    setFocusedItem(PROJECT_ROOT_ITEM_ID);
    setSearchText('');
    hasAutoOpenedRef.current = false;
  }, [projectId]);

  useEffect(() => {
    if (!autoOpenRootFile || hasAutoOpenedRef.current) return;
    const initialFile = pickInitialWorkspaceFile(rootEntries);
    if (!initialFile) return;
    hasAutoOpenedRef.current = true;
    onOpenFile(initialFile);
  }, [autoOpenRootFile, onOpenFile, rootEntries]);

  useEffect(() => {
    if (!activePath) return;
    const scrollActiveItemIntoView = () => {
      const activeItem = treeRef.current
        ?.querySelector<HTMLElement>('.deepsea-workspace-tree__title[data-active="true"]');
      const scroller = treeRef.current?.closest<HTMLElement>('.deepsea-file-browser__tree');
      if (!activeItem || !scroller) return;

      const activeTop = activeItem.offsetTop;
      const activeBottom = activeTop + activeItem.offsetHeight;
      if (activeTop < scroller.scrollTop) {
        scroller.scrollTop = Math.max(0, activeTop - 12);
      } else if (activeBottom > scroller.scrollTop + scroller.clientHeight) {
        scroller.scrollTop = activeBottom - scroller.clientHeight + 12;
      }

      const activeRect = activeItem.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      if (activeRect.top < scrollerRect.top) {
        scroller.scrollTop -= scrollerRect.top - activeRect.top + 12;
      } else if (activeRect.bottom > scrollerRect.bottom) {
        scroller.scrollTop += activeRect.bottom - scrollerRect.bottom + 12;
      }
    };

    const frame = window.requestAnimationFrame(scrollActiveItemIntoView);
    const timer = window.setTimeout(scrollActiveItemIntoView, 120);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [activePath]);

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
    <div ref={treeRef} className="deepsea-workspace-tree">
      <div className="deepsea-workspace-tree__header">
        <span>资源管理器</span>
        <div aria-hidden="true">
          <FolderPlus />
          <FilePlus />
        </div>
      </div>
      <label className="deepsea-workspace-tree__search">
        <Search aria-hidden="true" />
        <input
          type="search"
          value={searchText}
          onChange={(event) => setSearchText(event.currentTarget.value)}
          placeholder="搜索文件或目录"
          aria-label="搜索文件或目录"
        />
        {searchText ? (
          <button type="button" onClick={() => setSearchText('')} aria-label="清空文件搜索">
            <X aria-hidden="true" />
          </button>
        ) : null}
      </label>
      {Object.keys(failedDirs).length > 0 ? (
        <div className="deepsea-workspace-tree__notice">部分目录读取失败</div>
      ) : null}
      {normalizedSearch && matchedItemIds.size === 0 ? (
        <div className="deepsea-workspace-tree__notice" data-variant="empty">
          没有匹配“{searchText.trim()}”的文件
        </div>
      ) : null}
      <ControlledTreeEnvironment<TreeItemData>
        items={visibleTreeItems}
        getItemTitle={(item) => item.data.title}
        viewState={viewState}
        defaultInteractionMode={InteractionMode.ClickItemToExpand}
        canDragAndDrop={false}
        canDropOnFolder={false}
        canDropOnNonFolder={false}
        canReorderItems={false}
        canRename={false}
        canSearch={false}
        onPrimaryAction={(item) => {
          if (item.data.type === 'file') onOpenFile(item.data);
        }}
        onFocusItem={(item) => setFocusedItem(item.index)}
        onCollapseItem={(item) => {
          setExpandedItems((current) => current.filter((itemId) => itemId !== item.index));
        }}
        onExpandItem={(item) => {
          setExpandedItems((current) => (
            current.includes(item.index) ? current : [...current, item.index]
          ));
          if (item.index === PROJECT_ROOT_ITEM_ID) return;
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
            isSearchMatch={matchedItemIds.has(item.index)}
          />
        )}
        renderItemArrow={({ item, context }) => (
          <span
            {...(item.isFolder ? context.arrowProps : {})}
            className="deepsea-workspace-tree__arrow"
            aria-hidden="true"
          >
            {item.isFolder ? (
              <ChevronRight
                aria-hidden="true"
                className={context.isExpanded ? 'is-expanded' : undefined}
              />
            ) : null}
          </span>
        )}
      >
        <Tree treeId={WORKSPACE_TREE_ID} rootItem={ROOT_ITEM_ID} treeLabel="当前项目目录" />
      </ControlledTreeEnvironment>
    </div>
  );
}

function WorkspaceTreeTitle({
  item,
  failedMessage,
  isActive,
  isSearchMatch,
}: {
  item: WorkspaceTreeItem;
  failedMessage?: string;
  isActive: boolean;
  isSearchMatch: boolean;
}): JSX.Element {
  const Icon = item.data.type === 'directory' ? (item.children?.length ? FolderOpen : Folder) : File;
  const extension = item.data.type === 'file' ? getFileExtension(item.data.name || item.data.path) : '';
  return (
    <span
      className="deepsea-workspace-tree__title"
      data-active={isActive ? 'true' : undefined}
      data-entry-type={item.data.type}
      data-extension={extension || undefined}
      data-root={item.index === PROJECT_ROOT_ITEM_ID ? 'true' : undefined}
      data-search-match={isSearchMatch ? 'true' : undefined}
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
      children: [PROJECT_ROOT_ITEM_ID],
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
    [PROJECT_ROOT_ITEM_ID]: {
      index: PROJECT_ROOT_ITEM_ID,
      canMove: false,
      isFolder: true,
      children: rootEntries.map((entry) => entry.path),
      data: {
        name: 'openDeepSea',
        title: 'openDeepSea',
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

function normalizeSearch(searchText: string): string {
  return searchText.trim().toLocaleLowerCase();
}

function filterTreeItemsForSearch(
  treeItems: Record<TreeItemIndex, WorkspaceTreeItem>,
  searchTerm: string,
): {
  items: Record<TreeItemIndex, WorkspaceTreeItem>;
  matchedItemIds: Set<TreeItemIndex>;
} {
  if (!searchTerm) return { items: treeItems, matchedItemIds: new Set() };

  const parentByChild = new Map<TreeItemIndex, TreeItemIndex>();
  Object.values(treeItems).forEach((item) => {
    item.children?.forEach((childId) => parentByChild.set(childId, item.index));
  });

  const visibleItemIds = new Set<TreeItemIndex>([ROOT_ITEM_ID, PROJECT_ROOT_ITEM_ID]);
  const matchedItemIds = new Set<TreeItemIndex>();

  Object.values(treeItems).forEach((item) => {
    if (item.index === ROOT_ITEM_ID || item.index === PROJECT_ROOT_ITEM_ID) return;
    if (!matchesTreeItemSearch(item, searchTerm)) return;
    matchedItemIds.add(item.index);

    let currentItemId: TreeItemIndex | undefined = item.index;
    while (currentItemId !== undefined) {
      visibleItemIds.add(currentItemId);
      currentItemId = parentByChild.get(currentItemId);
    }
  });

  const filteredItems: Record<TreeItemIndex, WorkspaceTreeItem> = {};
  Object.entries(treeItems).forEach(([itemId, item]) => {
    if (!visibleItemIds.has(item.index)) return;
    filteredItems[itemId] = {
      ...item,
      children: item.children?.filter((childId) => visibleItemIds.has(childId)),
    };
  });

  return { items: filteredItems, matchedItemIds };
}

function matchesTreeItemSearch(item: WorkspaceTreeItem, searchTerm: string): boolean {
  return [
    item.data.title,
    item.data.name,
    item.data.path,
    item.data.language ?? '',
  ]
    .join(' ')
    .toLocaleLowerCase()
    .includes(searchTerm);
}

function collectExpandedDirectoryIds(
  treeItems: Record<TreeItemIndex, WorkspaceTreeItem>,
): TreeItemIndex[] {
  return Object.values(treeItems)
    .filter((item) => item.isFolder && item.children && item.children.length > 0)
    .map((item) => item.index);
}

function getFileExtension(name: string): string {
  const lastSegment = name.split(/[\\/]/u).pop() ?? name;
  const dotIndex = lastSegment.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === lastSegment.length - 1) return '';
  return lastSegment.slice(dotIndex + 1).toLowerCase();
}
