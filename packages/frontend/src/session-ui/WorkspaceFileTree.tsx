import { useQuery } from '@tanstack/react-query';
import {
  ChevronRight,
  Clipboard,
  File,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  RefreshCcw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ControlledTreeEnvironment,
  InteractionMode,
  Tree,
  type TreeItem,
  type TreeItemIndex,
} from 'react-complex-tree';
import { api } from '../lib/api';
import type { WorkspaceDirectoryEntry } from '../lib/types';
import { parentPathForCreate, validateWorkspaceEntryNameInput } from './workspace-file-operations';
import { pickInitialWorkspaceFile } from './workspace-file-model';

type TreeItemData = WorkspaceDirectoryEntry & { title: string };
type WorkspaceTreeItem = TreeItem<TreeItemData>;

const ROOT_ITEM_ID = 'workspace-root';
const PROJECT_ROOT_ITEM_ID = 'workspace-project-root';
const WORKSPACE_TREE_ID = 'workspace-tree';

type InlineEntryAction =
  | { type: 'create-file'; parentPath: string; error?: string }
  | { type: 'create-directory'; parentPath: string; error?: string }
  | { type: 'rename'; entry: WorkspaceDirectoryEntry; error?: string };

export function WorkspaceFileTree({
  projectId,
  activePath,
  selectedPath,
  dirtyPaths,
  refreshVersion = 0,
  autoOpenRootFile = false,
  onSelectEntry,
  onOpenFile,
  onCreateFile,
  onCreateDirectory,
  onRenameEntry,
  onDeleteEntry,
}: {
  projectId: string;
  activePath?: string | null;
  selectedPath?: string | null;
  dirtyPaths?: Set<string>;
  refreshVersion?: number;
  autoOpenRootFile?: boolean;
  onSelectEntry: (entry: WorkspaceDirectoryEntry | null) => void;
  onOpenFile: (file: WorkspaceDirectoryEntry) => void;
  onCreateFile: (parentPath: string, name: string) => Promise<void>;
  onCreateDirectory: (parentPath: string, name: string) => Promise<void>;
  onRenameEntry: (entry: WorkspaceDirectoryEntry, name: string) => Promise<void>;
  onDeleteEntry: (entry: WorkspaceDirectoryEntry) => Promise<void>;
}): JSX.Element {
  const [loadedDirs, setLoadedDirs] = useState<Record<string, WorkspaceDirectoryEntry[]>>({});
  const [failedDirs, setFailedDirs] = useState<Record<string, string>>({});
  const [expandedItems, setExpandedItems] = useState<TreeItemIndex[]>([PROJECT_ROOT_ITEM_ID]);
  const [focusedItem, setFocusedItem] = useState<TreeItemIndex>(PROJECT_ROOT_ITEM_ID);
  const [searchText, setSearchText] = useState('');
  const [inlineAction, setInlineAction] = useState<InlineEntryAction | null>(null);
  const [inlineName, setInlineName] = useState('');
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    entry: WorkspaceDirectoryEntry;
  } | null>(null);
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
  const selectedItemId = selectedPath === ''
    ? PROJECT_ROOT_ITEM_ID
    : selectedPath && visibleTreeItems[selectedPath]
      ? selectedPath
      : null;
  const selectedItems = selectedItemId ? [selectedItemId] : [];
  const currentFocusedItem = visibleTreeItems[focusedItem] ? focusedItem : PROJECT_ROOT_ITEM_ID;
  const selectedEntryFromTree = selectedItemId
    ? visibleTreeItems[selectedItemId]?.data ?? null
    : null;
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
    setInlineAction(null);
    setInlineName('');
    setContextMenu(null);
    hasAutoOpenedRef.current = false;
  }, [projectId]);

  useEffect(() => {
    if (refreshVersion === 0) return;
    void rootQuery.refetch();
    const directoryIds = expandedItems
      .filter((itemId) => itemId !== ROOT_ITEM_ID && itemId !== PROJECT_ROOT_ITEM_ID)
      .map((itemId) => String(itemId));
    directoryIds.forEach((directoryPath) => {
      void api.listWorkspaceDirectory(projectId, directoryPath)
        .then((result) => {
          setLoadedDirs((current) => ({ ...current, [directoryPath]: result.entries }));
          setFailedDirs((current) => {
            const next = { ...current };
            delete next[directoryPath];
            return next;
          });
        })
        .catch((error: unknown) => {
          setFailedDirs((current) => ({
            ...current,
            [directoryPath]: error instanceof Error ? error.message : '读取目录失败',
          }));
        });
    });
  }, [expandedItems, projectId, refreshVersion, rootQuery.refetch]);

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

  useEffect(() => {
    if (!contextMenu) return undefined;
    const closeMenu = () => setContextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu();
    };
    window.addEventListener('click', closeMenu);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('click', closeMenu);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [contextMenu]);

  const startCreate = useCallback((type: 'file' | 'directory', entry: WorkspaceDirectoryEntry | null) => {
    const parentPath = parentPathForCreate(entry);
    setInlineAction({ type: type === 'file' ? 'create-file' : 'create-directory', parentPath });
    setInlineName('');
    setContextMenu(null);
  }, []);

  const startRename = useCallback((entry: WorkspaceDirectoryEntry) => {
    setInlineAction({ type: 'rename', entry });
    setInlineName(entry.name);
    setContextMenu(null);
  }, []);

  const submitInlineAction = useCallback(async () => {
    if (!inlineAction) return;
    const error = validateWorkspaceEntryNameInput(inlineName);
    if (error) {
      setInlineAction({ ...inlineAction, error });
      return;
    }
    const trimmedName = inlineName.trim();
    try {
      if (inlineAction.type === 'create-file') {
        await onCreateFile(inlineAction.parentPath, trimmedName);
      } else if (inlineAction.type === 'create-directory') {
        await onCreateDirectory(inlineAction.parentPath, trimmedName);
      } else {
        await onRenameEntry(inlineAction.entry, trimmedName);
      }
      setInlineAction(null);
      setInlineName('');
    } catch (error) {
      setInlineAction({
        ...inlineAction,
        error: error instanceof Error ? error.message : '操作失败',
      });
    }
  }, [inlineAction, inlineName, onCreateDirectory, onCreateFile, onRenameEntry]);

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
        <div>
          <button
            type="button"
            aria-label="新建文件夹"
            onClick={() => startCreate('directory', selectedEntryFromTree)}
          >
            <FolderPlus aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="新建文件"
            onClick={() => startCreate('file', selectedEntryFromTree)}
          >
            <FilePlus aria-hidden="true" />
          </button>
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
      {inlineAction ? (
        <form
          className="deepsea-workspace-tree__inline-entry"
          onSubmit={(event) => {
            event.preventDefault();
            void submitInlineAction();
          }}
        >
          <input
            autoFocus
            value={inlineName}
            onChange={(event) => setInlineName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setInlineAction(null);
                setInlineName('');
              }
            }}
            placeholder={inlineAction.type === 'create-directory' ? '文件夹名称' : '文件名称'}
          />
          {inlineAction.error ? <span>{inlineAction.error}</span> : null}
        </form>
      ) : null}
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
          onSelectEntry(item.data);
          if (item.data.type === 'file') onOpenFile(item.data);
        }}
        onFocusItem={(item) => setFocusedItem(item.index)}
        onCollapseItem={(item) => {
          onSelectEntry(item.data);
          setExpandedItems((current) => current.filter((itemId) => itemId !== item.index));
        }}
        onExpandItem={(item) => {
          onSelectEntry(item.data);
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
            isSelected={item.index === selectedItemId}
            isDirty={Boolean(dirtyPaths?.has(item.data.path))}
            isSearchMatch={matchedItemIds.has(item.index)}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onSelectEntry(item.data);
              setContextMenu({ x: event.clientX, y: event.clientY, entry: item.data });
            }}
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
      {contextMenu ? (
        <div
          className="deepsea-workspace-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
          onClick={(event) => event.stopPropagation()}
        >
          {contextMenu.entry.type === 'file' ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onOpenFile(contextMenu.entry);
                setContextMenu(null);
              }}
            >
              <File aria-hidden="true" />
              打开
            </button>
          ) : null}
          <button type="button" role="menuitem" onClick={() => startCreate('file', contextMenu.entry)}>
            <FilePlus aria-hidden="true" />
            新建文件
          </button>
          <button type="button" role="menuitem" onClick={() => startCreate('directory', contextMenu.entry)}>
            <FolderPlus aria-hidden="true" />
            新建文件夹
          </button>
          {contextMenu.entry.path ? (
            <>
              <button type="button" role="menuitem" onClick={() => startRename(contextMenu.entry)}>
                <Pencil aria-hidden="true" />
                重命名
              </button>
              <button
                type="button"
                role="menuitem"
                data-danger="true"
                onClick={() => {
                  setContextMenu(null);
                  void onDeleteEntry(contextMenu.entry);
                }}
              >
                <Trash2 aria-hidden="true" />
                删除
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  void navigator.clipboard?.writeText(contextMenu.entry.path);
                  setContextMenu(null);
                }}
              >
                <Clipboard aria-hidden="true" />
                复制相对路径
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function WorkspaceTreeTitle({
  item,
  failedMessage,
  isActive,
  isSelected,
  isDirty,
  isSearchMatch,
  onContextMenu,
}: {
  item: WorkspaceTreeItem;
  failedMessage?: string;
  isActive: boolean;
  isSelected: boolean;
  isDirty: boolean;
  isSearchMatch: boolean;
  onContextMenu: (event: React.MouseEvent<HTMLSpanElement>) => void;
}): JSX.Element {
  const Icon = item.data.type === 'directory' ? (item.children?.length ? FolderOpen : Folder) : File;
  const extension = item.data.type === 'file' ? getFileExtension(item.data.name || item.data.path) : '';
  return (
    <span
      className="deepsea-workspace-tree__title"
      data-active={isActive ? 'true' : undefined}
      data-selected={isSelected ? 'true' : undefined}
      data-dirty={isDirty ? 'true' : undefined}
      data-entry-type={item.data.type}
      data-extension={extension || undefined}
      data-root={item.index === PROJECT_ROOT_ITEM_ID ? 'true' : undefined}
      data-search-match={isSearchMatch ? 'true' : undefined}
      title={failedMessage ?? item.data.path}
      onContextMenu={onContextMenu}
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
