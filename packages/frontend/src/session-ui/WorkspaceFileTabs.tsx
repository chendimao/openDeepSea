import { Actions, Layout, Model, type TabNode } from 'flexlayout-react';
import React, { useMemo, useRef } from 'react';
import { FileViewer, type WorkspaceFileDirtyState } from './FileViewers';
import { useHideFlexLayoutArtifacts } from './flexlayout-accessibility';
import type { WorkspaceFileTab } from './workspace-file-model';

const FILE_TABSET_ID = 'workspace-file-tabs';

export function WorkspaceFileTabs({
  projectId,
  tabs,
  activePath,
  dirtyPaths,
  dirtyByPath,
  onClose,
  onReorder,
  onFocus,
  onDraftChange,
  onSave,
}: {
  projectId: string;
  tabs: WorkspaceFileTab[];
  activePath: string | null;
  dirtyPaths: Set<string>;
  dirtyByPath: Record<string, WorkspaceFileDirtyState>;
  onClose: (path: string) => void;
  onReorder: (ids: string[]) => void;
  onFocus: (path: string) => void;
  onDraftChange: (path: string, savedContent: string, draftContent: string, mtimeMs: number | null) => void;
  onSave: (path: string, options?: { force?: boolean }) => Promise<boolean>;
}): JSX.Element {
  const canUseFlexLayout = typeof document !== 'undefined';
  const model = useMemo(
    () => (canUseFlexLayout ? createFileTabsModel(tabs, activePath) : null),
    [activePath, canUseFlexLayout, tabs],
  );
  const tabsRef = useRef<HTMLDivElement | null>(null);
  useHideFlexLayoutArtifacts(tabsRef);
  const tabsById = useMemo(() => new Map(tabs.map((tab) => [tab.id, tab])), [tabs]);

  if (tabs.length === 0) {
    return (
      <div className="deepsea-file-tabs-empty">
        <strong>未打开文件</strong>
        <span>从左侧目录选择文件</span>
      </div>
    );
  }

  if (!model) {
    const activeTab = tabs.find((tab) => tab.path === activePath) ?? tabs[0];
    return (
      <div ref={tabsRef} className="deepsea-file-tabs">
        <div className="deepsea-file-tabs__ssr-tabs" aria-hidden="true">
          {tabs.map((tab) => <span key={tab.id}>{tab.name}</span>)}
        </div>
        {activeTab ? (
          <FileViewer
            projectId={projectId}
            tab={activeTab}
            dirtyState={dirtyByPath[activeTab.path] ?? null}
            onDraftChange={onDraftChange}
            onSave={onSave}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div ref={tabsRef} className="deepsea-file-tabs">
      <Layout
        model={model}
        factory={(node) => {
          const tab = tabsById.get(node.getId());
          return tab ? (
            <FileViewer
              projectId={projectId}
              tab={tab}
              dirtyState={dirtyByPath[tab.path] ?? null}
              onDraftChange={onDraftChange}
              onSave={onSave}
            />
          ) : (
            <div className="deepsea-file-viewer-state">文件已关闭</div>
          );
        }}
        onAction={(action) => {
          if (action.type === Actions.DELETE_TAB) {
            const tab = tabsById.get(String(action.data.node));
            if (tab) onClose(tab.path);
            return undefined;
          }

          if (action.type === Actions.SELECT_TAB) {
            const tab = tabsById.get(String(action.data.tabNode));
            if (tab) onFocus(tab.path);
          }

          if (action.type === Actions.MOVE_NODE && action.data.location !== 'center') {
            return undefined;
          }

          return action;
        }}
        onModelChange={(nextModel) => {
          const tabset = nextModel.getNodeById(FILE_TABSET_ID);
          const nextIds = tabset && 'getChildren' in tabset
            ? tabset.getChildren().map((node) => node.getId())
            : tabs.map((tab) => tab.id);
          if (!areSameOrder(nextIds, tabs.map((tab) => tab.id))) onReorder(nextIds);
        }}
        onRenderTab={(node: TabNode, renderValues) => {
          const tab = tabsById.get(node.getId());
          renderValues.content = (
            <span
              className="deepsea-file-tab-title"
              data-dirty={tab && dirtyPaths.has(tab.path) ? 'true' : undefined}
              data-extension={getFileExtension(tab?.name ?? node.getName()) || undefined}
              title={tab?.path ?? node.getName()}
            >
              <span className="deepsea-file-tab-title__icon" aria-hidden="true" />
              <span>{node.getName()}</span>
              {tab && dirtyPaths.has(tab.path) ? <span className="deepsea-file-tab-title__dirty" aria-hidden="true" /> : null}
            </span>
          );
        }}
      />
    </div>
  );
}

function createFileTabsModel(tabs: WorkspaceFileTab[], activePath: string | null): Model {
  const selected = Math.max(0, tabs.findIndex((tab) => tab.path === activePath));
  return Model.fromJson({
    global: {
      enableEdgeDock: false,
      tabEnableRename: false,
      tabSetEnableClose: false,
      tabSetEnableDeleteWhenEmpty: false,
      tabSetEnableDivide: false,
      tabSetEnableMaximize: false,
      tabSetEnableTabScrollbar: true,
    },
    borders: [],
    layout: {
      type: 'row',
      children: [{
        type: 'tabset',
        id: FILE_TABSET_ID,
        selected,
        enableClose: false,
        enableDeleteWhenEmpty: false,
        enableDivide: false,
        enableDrop: true,
        enableMaximize: false,
        children: tabs.map((tab) => ({
          type: 'tab',
          id: tab.id,
          name: tab.name,
          component: 'workspace-file',
          enableClose: true,
          enableDrag: true,
          config: { path: tab.path },
        })),
      }],
    },
  });
}

function areSameOrder(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function getFileExtension(name: string): string {
  const lastSegment = name.split(/[\\/]/u).pop() ?? name;
  const dotIndex = lastSegment.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === lastSegment.length - 1) return '';
  return lastSegment.slice(dotIndex + 1).toLowerCase();
}
