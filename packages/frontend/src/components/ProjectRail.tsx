import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Ellipsis, FolderOpen, Pin, PinOff, Plus, Search, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Project } from '../lib/types';
import { sortPinnedItems } from '../lib/sortableItems';
import { cn, truncate } from '../lib/utils';
import { Input } from './ui/Input';

export function ProjectRail({
  projects,
  activeProjectId,
  busyProjectId,
  onSelectProject,
  onCreateProject,
  onTogglePin,
  onDeleteProject,
}: {
  projects: Project[];
  activeProjectId?: string;
  busyProjectId?: string | null;
  onSelectProject: (project: Project) => void;
  onCreateProject: () => void;
  onTogglePin: (project: Project) => void;
  onDeleteProject: (project: Project) => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const visibleProjects = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const sorted = sortPinnedItems(projects);
    if (!normalized) return sorted;
    return sorted.filter((project) => project.name.toLowerCase().includes(normalized));
  }, [projects, query]);

  return (
    <aside className="project-rail" aria-label="项目列表">
      <div className="project-rail-header">
        <span>项目</span>
        <button type="button" className="project-rail-icon-button" onClick={onCreateProject} aria-label="新增项目">
          <Plus className="h-4 w-4" />
        </button>
      </div>
      <div className="project-rail-search">
        <Search className="h-3.5 w-3.5" />
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目" />
      </div>
      <div className="project-rail-list">
        {visibleProjects.map((project) => (
          <ProjectRailItem
            key={project.id}
            project={project}
            active={project.id === activeProjectId}
            busy={busyProjectId === project.id}
            onSelect={() => onSelectProject(project)}
            onTogglePin={() => onTogglePin(project)}
            onDelete={() => onDeleteProject(project)}
          />
        ))}
      </div>
    </aside>
  );
}

function ProjectRailItem({
  project,
  active,
  busy,
  onSelect,
  onTogglePin,
  onDelete,
}: {
  project: Project;
  active: boolean;
  busy: boolean;
  onSelect: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
}): JSX.Element {
  return (
    <div className={cn('project-rail-item', active && 'is-active', busy && 'is-busy')}>
      <button type="button" className="project-rail-select" onClick={onSelect} disabled={busy}>
        <FolderOpen className="h-4 w-4" />
        <span>{truncate(project.name, 28)}</span>
        {project.pinned_at !== undefined && project.pinned_at !== null ? <Pin className="h-3.5 w-3.5" /> : null}
      </button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button type="button" className="project-rail-menu-button" aria-label={`${project.name} 操作`} disabled={busy}>
            <Ellipsis className="h-4 w-4" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={6} className="project-rail-menu">
            <DropdownMenu.Item className="project-rail-menu-item" onSelect={onTogglePin}>
              {project.pinned_at !== undefined && project.pinned_at !== null ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
              {project.pinned_at !== undefined && project.pinned_at !== null ? '取消置顶' : '置顶'}
            </DropdownMenu.Item>
            <DropdownMenu.Item className="project-rail-menu-item is-danger" onSelect={onDelete}>
              <Trash2 className="h-3.5 w-3.5" />
              删除
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
