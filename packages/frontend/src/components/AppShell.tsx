import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Bot,
  BriefcaseBusiness,
  FolderKanban,
  GitBranch,
  Home,
  Moon,
  Plus,
  Search,
  Settings,
  SquareCheck,
  Sun,
} from 'lucide-react';
import { api } from '../lib/api';
import { cn, truncate } from '../lib/utils';
import { roomSocket } from '../lib/ws';
import { LobsterMark } from './LobsterMark';
import { CreateProjectDialog } from './CreateProjectDialog';
import { CommandMenu } from './CommandMenu';
import { SystemSettingsDialog } from './SettingsDialogs';
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
      <div className="liquid-backdrop" aria-hidden="true" />
      <div className="app-grid h-full">
        <aside className="app-sidebar" aria-label="项目工作区">
          <ProjectSidebar
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

function ProjectSidebar({
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
    <div className="glass-sidebar flex h-full flex-col">
      <div className="px-5 pb-5 pt-5">
        <div className="flex items-center gap-3">
          <div className="liquid-logo-small">
            <LobsterMark className="h-6 w-6" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate font-display text-[16px] font-semibold leading-tight">深海指挥中心</div>
            <div className="mt-0.5 font-mono text-[11px] text-[var(--color-fg-muted)]">
              local agent console
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <CreateProjectDialog>
              <button type="button" aria-label="新增项目" className="sidebar-icon-button">
                <Plus className="h-3.5 w-3.5" strokeWidth={1.9} />
              </button>
            </CreateProjectDialog>
            <SystemSettingsDialog>
              <button type="button" aria-label="系统设置" className="sidebar-icon-button">
                <Settings className="h-3.5 w-3.5" strokeWidth={1.75} />
              </button>
            </SystemSettingsDialog>
          </div>
        </div>
        <button
          type="button"
          onClick={onOpenCommand}
          className="glass-search mt-5"
        >
          <Search className="h-3.5 w-3.5" strokeWidth={1.75} />
          <span>搜索 / 快速命令</span>
          <span className="ml-auto rounded-[5px] bg-white/56 px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-muted)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.72)]">
            ⌘K
          </span>
        </button>
      </div>

      <div className="sidebar-nav px-4">
        <SidebarLink to="/" active={!currentProject} icon={Home} label="开发" exact />
        <SidebarLink to={currentProject ? `/projects/${currentProject.id}` : '/'} icon={GitBranch} label="路线" />
        <SidebarLink to="/" icon={Bot} label="Agent" inactive />
        <SidebarLink to="/" active={!!currentProject} icon={SquareCheck} label="任务" />
        <SidebarLink to="/" icon={BriefcaseBusiness} label="工作流" inactive />
        <SidebarLink to="/" icon={FolderKanban} label="文件" inactive />
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5">
        <div className="mb-3 text-[10.5px] font-medium text-[var(--color-muted)]">当前项目</div>
        {currentProject ? (
          <div className="glass-project-card">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <h2 className="truncate font-display text-[14px] font-semibold leading-snug">
                  {currentProject.name}
                </h2>
                <p className="mt-1 truncate font-mono text-[10px] text-[var(--color-muted)]" title={currentProject.path}>
                  {currentProject.path}
                </p>
              </div>
              <span className="rounded-md bg-white/52 px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-muted)]">
                ⌘62
              </span>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <RailMetric label="群聊" value={currentProject.stats?.rooms ?? 0} />
              <RailMetric label="任务" value={currentProject.stats?.tasks ?? 0} />
              <RailMetric label="进行中" value={currentProject.stats?.tasksInProgress ?? 0} />
              <RailMetric label="已完成" value={currentProject.stats?.tasksDone ?? 0} />
            </div>
          </div>
        ) : (
          <div className="glass-project-card text-center">
            <FolderKanban className="mx-auto h-6 w-6 text-[var(--color-primary)]" strokeWidth={1.75} />
            <div className="mt-3 font-display text-[13px] font-medium">选择项目</div>
            <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-fg-muted)]">
              打开项目后显示工作区摘要。
            </p>
          </div>
        )}

        <div className="mt-6">
          <div className="mb-2 text-[10.5px] font-medium text-[var(--color-muted)]">最近项目</div>
          <div className="space-y-1.5">
            {projects.slice(0, 8).map((project) => (
              <NavLink
                key={project.id}
                to={`/projects/${project.id}`}
                className={({ isActive }) =>
                  cn('recent-project-link', isActive && 'is-active')
                }
              >
                <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[#16c8e6]" />
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

      <div className="px-5 pb-4">
        <button
          type="button"
          aria-label={`切换到${nextTheme === 'dark' ? '暗色' : '亮色'}主题`}
          onClick={() => onThemeChange(nextTheme)}
          className="theme-toggle"
        >
          <ThemeIcon className="h-3.5 w-3.5" strokeWidth={1.75} />
          <span>{nextTheme === 'dark' ? '暗色模式' : '亮色模式'}</span>
          <span className="ml-auto h-5 w-5 rounded-full bg-white/80 shadow-[inset_0_0_0_1px_rgba(15,23,42,0.08)]" />
        </button>
      </div>
    </div>
  );
}

function SidebarLink({
  to,
  label,
  icon: Icon,
  active = false,
  exact = false,
  inactive = false,
}: {
  to: string;
  label: string;
  icon: typeof Home;
  active?: boolean;
  exact?: boolean;
  inactive?: boolean;
}): JSX.Element {
  return (
    <NavLink
      to={to}
      end={exact}
      className={({ isActive }) => cn('sidebar-link', ((isActive && !inactive) || active) && 'is-active')}
    >
      <Icon className="h-4 w-4" strokeWidth={1.65} />
      <span>{label}</span>
    </NavLink>
  );
}

function RailMetric({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className="metric-tile">
      <div className="font-mono text-[15px] text-[var(--color-fg)]">{value}</div>
      <div className="mt-0.5 text-[10.5px] text-[var(--color-fg-muted)]">{label}</div>
    </div>
  );
}

function getProjectId(pathname: string): string | undefined {
  const [, first, projectId] = pathname.split('/');
  return first === 'projects' ? projectId : undefined;
}
