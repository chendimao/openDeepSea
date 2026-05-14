import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Activity, FolderKanban, Home, Moon, Plus, Search, Settings, Sun } from 'lucide-react';
import { api } from '../lib/api';
import { cn, truncate } from '../lib/utils';
import { roomSocket } from '../lib/ws';
import { LobsterMark } from './LobsterMark';
import { CreateProjectDialog } from './CreateProjectDialog';
import { CommandMenu } from './CommandMenu';
import type { ThemeMode } from '../lib/theme';

export function AppShell({
  children,
  theme,
  onThemeChange,
}: {
  children: ReactNode;
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
}): JSX.Element {
  const [commandOpen, setCommandOpen] = useState(false);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const location = useLocation();
  const projectId = getProjectId(location.pathname);
  const { data: projects = [] } = useQuery({
    queryKey: ['projects'],
    queryFn: api.listProjects,
    refetchInterval: 30_000,
  });
  const currentProject = useMemo(
    () => projects.find((project) => project.id === projectId),
    [projectId, projects],
  );

  useEffect(() => {
    roomSocket.connect();
    return () => roomSocket.destroy();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="h-screen w-screen overflow-hidden bg-[var(--color-bg)] text-[var(--color-fg)]">
      <div className="app-grid h-full">
        <aside className="app-sidebar" aria-label="项目导航">
          <Sidebar projects={projects} />
        </aside>
        <aside className="app-rail" aria-label="当前项目">
          <ProjectRail
            projects={projects}
            currentProject={currentProject}
            onOpenCommand={() => setCommandOpen(true)}
            theme={theme}
            onThemeChange={onThemeChange}
          />
        </aside>
        <main className="app-main">{children}</main>
      </div>
      <CommandMenu
        projects={projects}
        open={commandOpen}
        onOpenChange={setCommandOpen}
        onCreateProject={() => {
          setCommandOpen(false);
          setCreateProjectOpen(true);
        }}
      />
      <CreateProjectDialog open={createProjectOpen} onOpenChange={setCreateProjectOpen} />
    </div>
  );
}

function Sidebar({ projects }: { projects: Awaited<ReturnType<typeof api.listProjects>> }): JSX.Element {
  const location = useLocation();
  const projectId = getProjectId(location.pathname);
  const { data: gw } = useQuery({
    queryKey: ['gateway-status'],
    queryFn: api.health,
    refetchInterval: 15_000,
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center justify-center border-b border-[var(--color-border)]">
        <LobsterMark className="h-7 w-7" />
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-3">
        <NavLink
          to="/"
          end
          aria-label="所有项目"
          className={({ isActive }) =>
            cn(
              'mb-2 flex h-10 w-10 items-center justify-center rounded-md ease-ocean transition-colors',
              isActive
                ? 'bg-[var(--color-surface-raised)] text-[var(--color-fg)]'
                : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-fg)]',
            )
          }
        >
          <Home className="h-4 w-4" strokeWidth={1.75} />
        </NavLink>

        <div className="space-y-2">
          {projects.map((project) => (
            <NavLink
              key={project.id}
              to={`/projects/${project.id}`}
              aria-label={project.name}
              title={project.path}
              className={({ isActive }) =>
                cn(
                  'relative flex h-10 w-10 items-center justify-center rounded-md font-mono text-[12px] font-semibold uppercase ease-ocean transition-colors',
                  isActive || projectId === project.id
                    ? 'bg-[var(--color-surface-raised)] text-[var(--color-fg)]'
                    : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-fg)]',
                )
              }
            >
              {project.name.slice(0, 2)}
              {(project.stats?.tasksInProgress ?? 0) > 0 && (
                <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[var(--color-warning)]" />
              )}
            </NavLink>
          ))}
        </div>
      </nav>

      <div className="space-y-2 border-t border-[var(--color-border)] px-2 py-3">
        <CreateProjectDialog>
          <button
            type="button"
            aria-label="新建项目"
            className="flex h-10 w-10 items-center justify-center rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-primary)] ease-ocean transition-colors"
          >
            <Plus className="h-4 w-4" strokeWidth={2} />
          </button>
        </CreateProjectDialog>

        <button
          type="button"
          aria-label={gw?.gateway ? 'Gateway 已连接' : 'Gateway 离线'}
          className="flex h-10 w-10 items-center justify-center rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-fg)] ease-ocean transition-colors"
        >
          <Activity
            className={cn('h-4 w-4', gw?.gateway && 'text-[var(--color-success)]')}
            strokeWidth={1.75}
          />
        </button>
      </div>
    </div>
  );
}

function ProjectRail({
  projects,
  currentProject,
  onOpenCommand,
  theme,
  onThemeChange,
}: {
  projects: Awaited<ReturnType<typeof api.listProjects>>;
  currentProject?: Awaited<ReturnType<typeof api.listProjects>>[number];
  onOpenCommand: () => void;
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
}): JSX.Element {
  const nextTheme = theme === 'light' ? 'dark' : 'light';
  const ThemeIcon = theme === 'light' ? Moon : Sun;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-[var(--color-border)] px-4 py-4">
        <div className="font-display text-[15px] font-semibold leading-tight">OpenClaw Room</div>
        <div className="mt-1 font-mono text-[11px] text-[var(--color-fg-muted)]">
          workspace console
        </div>
        <button
          type="button"
          onClick={onOpenCommand}
          className="mt-4 flex h-9 w-full items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-left text-[12px] text-[var(--color-fg-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-fg)] ease-ocean transition-colors"
        >
          <Search className="h-3.5 w-3.5" strokeWidth={1.75} />
          <span>Command</span>
          <span className="ml-auto font-mono text-[10px]">⌘K</span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {currentProject ? (
          <>
            <div className="mb-3 px-1">
              <div className="text-[11px] uppercase tracking-wider text-[var(--color-fg-muted)] font-mono">
                当前项目
              </div>
              <h2 className="mt-2 font-display text-[15px] font-semibold leading-snug">
                {currentProject.name}
              </h2>
              <p className="mt-1 truncate font-mono text-[10.5px] text-[var(--color-muted)]" title={currentProject.path}>
                {currentProject.path}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2 px-1">
              <RailMetric label="聊天室" value={currentProject.stats?.rooms ?? 0} />
              <RailMetric label="任务" value={currentProject.stats?.tasks ?? 0} />
              <RailMetric label="进行中" value={currentProject.stats?.tasksInProgress ?? 0} />
              <RailMetric label="已完成" value={currentProject.stats?.tasksDone ?? 0} />
            </div>
          </>
        ) : (
          <div className="rounded-lg border border-dashed border-[var(--color-border)] px-4 py-6 text-center">
            <FolderKanban className="mx-auto h-6 w-6 text-[var(--color-accent)]" strokeWidth={1.75} />
            <div className="mt-3 font-display text-[13px] font-medium">选择项目</div>
            <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-fg-muted)]">
              打开项目后，这里会显示当前工作区摘要。
            </p>
          </div>
        )}

        <div className="mt-5">
          <div className="mb-2 px-1 text-[11px] uppercase tracking-wider text-[var(--color-fg-muted)] font-mono">
            最近项目
          </div>
          <div className="space-y-1">
            {projects.slice(0, 8).map((project) => (
              <NavLink
                key={project.id}
                to={`/projects/${project.id}`}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-2 rounded-md px-2.5 py-2 ease-ocean transition-colors',
                    isActive
                      ? 'bg-[var(--color-surface-raised)] text-[var(--color-fg)]'
                      : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-fg)]',
                  )
                }
              >
                <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[var(--color-accent)] opacity-70" />
                <span className="truncate text-[12.5px]">{truncate(project.name, 24)}</span>
              </NavLink>
            ))}
            {projects.length === 0 && (
              <div className="px-2.5 py-4 text-[12px] text-[var(--color-fg-muted)]">
                暂无项目
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="border-t border-[var(--color-border)] px-3 py-3">
        <button
          type="button"
          aria-label={`切换到${nextTheme === 'dark' ? '暗色' : '亮色'}主题`}
          onClick={() => onThemeChange(nextTheme)}
          className="mb-1 flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-[12px] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-fg)] ease-ocean transition-colors"
        >
          <ThemeIcon className="h-3.5 w-3.5" strokeWidth={1.75} />
          {nextTheme === 'dark' ? '暗色' : '亮色'}
        </button>
        <NavLink
          to="/settings"
          aria-label="设置"
          className={({ isActive }) =>
            cn(
              'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-[12px] ease-ocean transition-colors',
              isActive
                ? 'bg-[var(--color-surface-raised)] text-[var(--color-fg)]'
                : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-fg)]',
            )
          }
        >
          <Settings className="h-3.5 w-3.5" strokeWidth={1.75} />
          设置
        </NavLink>
      </div>
    </div>
  );
}

function RailMetric({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2">
      <div className="font-mono text-[15px] text-[var(--color-fg)]">{value}</div>
      <div className="mt-0.5 text-[10.5px] text-[var(--color-fg-muted)]">{label}</div>
    </div>
  );
}

function getProjectId(pathname: string): string | undefined {
  const [, first, projectId] = pathname.split('/');
  return first === 'projects' ? projectId : undefined;
}
