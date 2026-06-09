import { Actions, Layout, Model, type TabNode } from 'flexlayout-react';
import React, { Suspense, useMemo, useRef } from 'react';
import { FileBrowserWorkspace } from './FileBrowserWorkspace';
import { useHideFlexLayoutArtifacts } from './flexlayout-accessibility';

const LazyTerminalPanel = React.lazy(() => import('../components/TerminalPanel').then((module) => ({
  default: module.TerminalPanel,
})));

export type SessionCenterWorkspacePane = 'transcript' | 'file-browser' | 'project-terminal';

export function SessionCenterWorkspace({
  projectId,
  workspaceRootPath,
  transcript,
  onActivePaneChange,
}: {
  projectId: string;
  workspaceRootPath: string;
  transcript: React.ReactNode;
  onActivePaneChange?: (pane: SessionCenterWorkspacePane) => void;
}): JSX.Element {
  const canUseFlexLayout = typeof document !== 'undefined';
  const model = useMemo(() => (canUseFlexLayout ? createSessionCenterModel() : null), [canUseFlexLayout]);
  const workspaceRef = useRef<HTMLElement | null>(null);
  useHideFlexLayoutArtifacts(workspaceRef);

  if (!model) {
    return (
      <section ref={workspaceRef} className="deepsea-center-workspace" aria-label="会话中间工作区">
        <div className="deepsea-center-workspace__ssr-tabs" aria-hidden="true">
          <span>对话记录</span>
          <span>文件浏览器</span>
          <span>项目终端</span>
        </div>
        {transcript}
      </section>
    );
  }

  return (
    <section ref={workspaceRef} className="deepsea-center-workspace" aria-label="会话中间工作区">
      <Layout
        model={model}
        factory={(node) => {
          const component = node.getComponent();
          if (component === 'transcript') return <>{transcript}</>;
          if (component === 'file-browser') {
            return <FileBrowserWorkspace projectId={projectId} workspaceRootPath={workspaceRootPath} />;
          }
          if (component === 'project-terminal') {
            return <ProjectTerminalWorkspace projectId={projectId} />;
          }
          return <div className="deepsea-file-viewer-state">未知面板</div>;
        }}
        onAction={(action) => {
          if (action.type === Actions.DELETE_TAB || action.type === Actions.MOVE_NODE) return undefined;
          if (action.type === Actions.SELECT_TAB) {
            const pane = getSessionCenterWorkspacePaneForTabId(String(action.data.tabNode));
            if (pane) onActivePaneChange?.(pane);
          }
          return action;
        }}
        onRenderTab={(node: TabNode, renderValues) => {
          renderValues.content = <span>{node.getName()}</span>;
          renderValues.buttons = [];
        }}
      />
    </section>
  );
}

function ProjectTerminalWorkspace({ projectId }: { projectId: string }): JSX.Element {
  return (
    <div className="deepsea-project-terminal" aria-label="项目终端工作区">
      <Suspense fallback={<div className="deepsea-project-terminal-loading">正在准备项目终端...</div>}>
        <LazyTerminalPanel
          profile="project_shell"
          projectId={projectId}
          title="项目终端"
          className="deepsea-project-terminal-panel"
        />
      </Suspense>
    </div>
  );
}

function createSessionCenterModel(): Model {
  return Model.fromJson({
    global: {
      enableEdgeDock: false,
      tabEnableClose: false,
      tabEnableDrag: false,
      tabEnableRename: false,
      tabSetEnableClose: false,
      tabSetEnableDeleteWhenEmpty: false,
      tabSetEnableDivide: false,
      tabSetEnableDrag: false,
      tabSetEnableDrop: false,
      tabSetEnableMaximize: false,
    },
    borders: [],
    layout: {
      type: 'row',
      children: [{
        type: 'tabset',
        id: 'session-center-tabs',
        selected: 0,
        enableClose: false,
        enableDeleteWhenEmpty: false,
        enableDivide: false,
        enableDrag: false,
        enableDrop: false,
        enableMaximize: false,
        children: [
          {
            type: 'tab',
            id: 'session-transcript-tab',
            name: '对话记录',
            component: 'transcript',
            enableClose: false,
            enableDrag: false,
          },
          {
            type: 'tab',
            id: 'session-file-browser-tab',
            name: '文件浏览器',
            component: 'file-browser',
            enableClose: false,
            enableDrag: false,
          },
          {
            type: 'tab',
            id: 'session-project-terminal-tab',
            name: '项目终端',
            component: 'project-terminal',
            enableClose: false,
            enableDrag: false,
            enableRenderOnDemand: true,
          },
        ],
      }],
    },
  });
}

export function getSessionCenterWorkspacePaneForTabId(tabId: string): SessionCenterWorkspacePane | null {
  if (tabId === 'session-transcript-tab') return 'transcript';
  if (tabId === 'session-file-browser-tab') return 'file-browser';
  if (tabId === 'session-project-terminal-tab') return 'project-terminal';
  return null;
}
