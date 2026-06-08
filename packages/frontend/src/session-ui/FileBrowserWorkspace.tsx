import React, { useState } from 'react';
import type { WorkspaceDirectoryEntry } from '../lib/types';
import { WorkspaceFileTabs } from './WorkspaceFileTabs';
import { WorkspaceFileTree } from './WorkspaceFileTree';
import {
  closeWorkspaceFileTab,
  openWorkspaceFileTab,
  reorderWorkspaceFileTabs,
  type WorkspaceFileTab,
} from './workspace-file-model';

export function FileBrowserWorkspace({ projectId }: { projectId: string }): JSX.Element {
  const [tabs, setTabs] = useState<WorkspaceFileTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);

  const openFile = (file: WorkspaceDirectoryEntry) => {
    if (file.type !== 'file') return;
    setTabs((current) => {
      const result = openWorkspaceFileTab(current, file);
      setActivePath(result.activePath);
      return result.tabs;
    });
  };

  const closeFile = (path: string) => {
    setTabs((current) => {
      const result = closeWorkspaceFileTab(current, path, activePath);
      setActivePath(result.activePath);
      return result.tabs;
    });
  };

  return (
    <div className="deepsea-file-browser">
      <aside className="deepsea-file-browser__tree" aria-label="项目文件目录">
        <WorkspaceFileTree projectId={projectId} onOpenFile={openFile} />
      </aside>
      <section className="deepsea-file-browser__tabs" aria-label="打开的项目文件">
        <WorkspaceFileTabs
          projectId={projectId}
          tabs={tabs}
          activePath={activePath}
          onClose={closeFile}
          onFocus={setActivePath}
          onReorder={(ids) => setTabs((current) => reorderWorkspaceFileTabs(current, ids))}
        />
      </section>
    </div>
  );
}
