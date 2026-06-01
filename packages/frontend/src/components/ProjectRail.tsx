import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Ellipsis, FolderOpen, Pin, PinOff, Plus, Search, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { DragEvent } from 'react';
import type { Project } from '../lib/types';
import { isPinnedItem, layerIds, reorderWithinLayer, sortPinnedItems } from '../lib/sortableItems';
import { cn } from '../lib/utils';
import { Input } from './ui/Input';

export function ProjectRail({
  projects,
  activeProjectId,
  busyProjectId,
  onSelectProject,
  onCreateProject,
  onTogglePin,
  onDeleteProject,
  onReorderProjects,
}: {
  projects: Project[];
  activeProjectId?: string;
  busyProjectId?: string | null;
  onSelectProject: (project: Project) => void;
  onCreateProject: () => void;
  onTogglePin: (project: Project) => void;
  onDeleteProject: (project: Project) => void;
  onReorderProjects: (ids: string[], pinned: boolean) => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [draggingProjectId, setDraggingProjectId] = useState<string | null>(null);
  const [dropProjectId, setDropProjectId] = useState<string | null>(null);
  const sortedProjects = useMemo(() => sortPinnedItems(projects), [projects]);
  const visibleProjects = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return sortedProjects;
    return sortedProjects.filter((project) => project.name.toLowerCase().includes(normalized));
  }, [query, sortedProjects]);

  const resetDragState = () => {
    setDraggingProjectId(null);
    setDropProjectId(null);
  };

  const canDropOnProject = (target: Project) => {
    if (!draggingProjectId || draggingProjectId === target.id) return false;
    const draggingProject = sortedProjects.find((project) => project.id === draggingProjectId);
    return Boolean(draggingProject && isPinnedItem(draggingProject) === isPinnedItem(target));
  };

  const handleDrop = (target: Project) => {
    if (!canDropOnProject(target)) {
      resetDragState();
      return;
    }

    const activeId = draggingProjectId;
    if (!activeId) {
      resetDragState();
      return;
    }

    const next = reorderWithinLayer(sortedProjects, activeId, target.id);
    const moved = next.find((project) => project.id === activeId);
    if (moved) {
      const pinned = isPinnedItem(moved);
      onReorderProjects(layerIds(next, pinned), pinned);
    }
    resetDragState();
  };

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
            dragging={draggingProjectId === project.id}
            dropTarget={dropProjectId === project.id}
            onSelect={() => onSelectProject(project)}
            onTogglePin={() => onTogglePin(project)}
            onDelete={() => onDeleteProject(project)}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', project.id);
              setDraggingProjectId(project.id);
            }}
            onDragOver={(event) => {
              if (!canDropOnProject(project)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              setDropProjectId(project.id);
            }}
            onDragLeave={() => {
              if (dropProjectId === project.id) setDropProjectId(null);
            }}
            onDrop={(event) => {
              event.preventDefault();
              handleDrop(project);
            }}
            onDragEnd={resetDragState}
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
  dragging,
  dropTarget,
  onSelect,
  onTogglePin,
  onDelete,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
}: {
  project: Project;
  active: boolean;
  busy: boolean;
  dragging: boolean;
  dropTarget: boolean;
  onSelect: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
  onDragStart: (event: DragEvent<HTMLDivElement>) => void;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onDragLeave: () => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
}): JSX.Element {
  return (
    <div
      className={cn(
        'project-rail-item',
        active && 'is-active',
        busy && 'is-busy',
        dragging && 'is-dragging',
        dropTarget && 'is-drop-target',
      )}
      draggable={!busy}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      <button type="button" className="project-rail-select" onClick={onSelect} disabled={busy} title={project.name}>
        <FolderOpen className="h-4 w-4" />
        <span>{project.name}</span>
        {isPinnedItem(project) ? <Pin className="h-3.5 w-3.5" /> : null}
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
              {isPinnedItem(project) ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
              {isPinnedItem(project) ? '取消置顶' : '置顶'}
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
