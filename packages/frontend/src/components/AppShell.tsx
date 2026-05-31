import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useQueries, useQuery } from '@tanstack/react-query';
import {
  Bot,
  FolderKanban,
  Home,
  MessageCircle,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  TestTube2,
} from 'lucide-react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { RECENT_ROOMS_UPDATED_EVENT, readRecentRooms, type RecentRoom } from '../lib/recentRooms';
import { cn, truncate } from '../lib/utils';
import { roomSocket } from '../lib/ws';
import { LobsterMark } from './LobsterMark';
import { CreateProjectDialog } from './CreateProjectDialog';
import { CommandMenu } from './CommandMenu';
import { SystemSettingsDialog } from './SettingsDialogs';
import { type ThemeMode } from '../lib/theme';

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
  const [recentRooms, setRecentRooms] = useState<RecentRoom[]>(() => readRecentRooms());
  const location = useLocation();
  const { t } = useI18n();
  const projectId = getProjectId(location.pathname);
  const isRoomRoute = Boolean(getRoomId(location.pathname));
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
    const refreshRecentRooms = () => setRecentRooms(readRecentRooms());
    window.addEventListener(RECENT_ROOMS_UPDATED_EVENT, refreshRecentRooms);
    window.addEventListener('storage', refreshRecentRooms);
    return () => {
      window.removeEventListener(RECENT_ROOMS_UPDATED_EVENT, refreshRecentRooms);
      window.removeEventListener('storage', refreshRecentRooms);
    };
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
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[var(--color-bg)] text-[var(--color-fg)]">
      <div className="liquid-backdrop" aria-hidden="true" />
      {!isRoomRoute && (
        <header className="shell-public-header" aria-label={t('shell.sidebar.aria')}>
          <nav className="shell-public-nav" aria-label={t('shell.sidebar.aria')}>
            <SidebarLink to="/" active={location.pathname === '/'} icon={Home} label={t('shell.nav.development')} exact className="shell-public-link" />
            <SidebarLink to="/chat" icon={MessageCircle} label={t('shell.nav.chat')} className="shell-public-link" />
            <SidebarLink to="/agents" icon={Bot} label={t('shell.nav.agents')} className="shell-public-link" />
            <SidebarLink to="/skills" icon={ShieldCheck} label={t('shell.nav.skills')} className="shell-public-link" />
            <SidebarLink to="/files" icon={FolderKanban} label={t('shell.nav.files')} className="shell-public-link" />
            <SidebarLink to="/test" icon={TestTube2} label={t('shell.nav.test')} className="shell-public-link" />
          </nav>
        </header>
      )}
      <div className={cn('app-grid h-full', isRoomRoute && 'app-grid--room')}>
        <aside className="app-sidebar" aria-label={t('shell.sidebar.aria')}>
          <ProjectSidebar
            projects={projects}
            recentRooms={recentRooms}
            currentProject={currentProject}
            theme={theme}
            onThemeChange={onThemeChange}
            onOpenCommand={() => setCommandOpen(true)}
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
  recentRooms,
  currentProject,
  theme,
  onThemeChange,
  onOpenCommand,
}: {
  projects: Awaited<ReturnType<typeof api.listProjects>>;
  recentRooms: RecentRoom[];
  currentProject?: Awaited<ReturnType<typeof api.listProjects>>[number];
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
  onOpenCommand: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const location = useLocation();
  const currentRoomId = getRoomId(location.pathname);
  const recentRoomProjectIds = useMemo(() => {
    const availableProjectIds = new Set(projects.map((project) => project.id));
    return [...new Set(recentRooms.map((room) => room.projectId))]
      .filter((projectId) => availableProjectIds.has(projectId));
  }, [projects, recentRooms]);
  const recentRoomQueries = useQueries({
    queries: recentRoomProjectIds.map((projectId) => ({
      queryKey: ['rooms', projectId],
      queryFn: () => api.listRooms(projectId),
      staleTime: 30_000,
    })),
  });
  const visibleRecentRooms = useMemo(() => {
    const projectsById = new Map(projects.map((project) => [project.id, project]));
    const roomsByProjectId = new Map(
      recentRoomProjectIds.map((projectId, index) => [projectId, recentRoomQueries[index]?.data]),
    );
    return recentRooms
      .filter((room) => projectsById.has(room.projectId))
      .flatMap((room) => {
        const rooms = roomsByProjectId.get(room.projectId);
        const freshRoom = rooms?.find((item) => item.id === room.roomId);
        if (rooms && !freshRoom) return [];
        return [{
          ...room,
          roomName: freshRoom?.name ?? room.roomName,
          projectName: projectsById.get(room.projectId)?.name ?? room.projectName,
        }];
      });
  }, [projects, recentRooms, recentRoomProjectIds, recentRoomQueries]);

  return (
    <div className="glass-sidebar flex h-full flex-col">
      <div className="px-5 pb-5 pt-5">
        <div className="flex items-center gap-3">
          <div className="liquid-logo-small">
            <LobsterMark className="h-6 w-6" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate font-display text-[16px] font-semibold leading-tight">{t('app.name')}</div>
            <div className="mt-0.5 font-mono text-[11px] text-[var(--color-fg-muted)]">
              {t('shell.subtitle')}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <CreateProjectDialog>
              <button type="button" aria-label={t('shell.newProject')} className="sidebar-icon-button">
                <Plus className="h-3.5 w-3.5" strokeWidth={1.9} />
              </button>
            </CreateProjectDialog>
            <SystemSettingsDialog theme={theme} onThemeChange={onThemeChange}>
              <button type="button" aria-label={t('shell.systemSettings')} className="sidebar-icon-button">
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
          <span>{t('shell.searchCommand')}</span>
          <span className="ml-auto rounded-[5px] bg-white/56 px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-muted)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.72)]">
            ⌘K
          </span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5">
        <div>
          <div className="mb-2 text-[10.5px] font-medium text-[var(--color-muted)]">{t('shell.recentProjects')}</div>
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
                {t('shell.noProjects')}
              </div>
            )}
          </div>
        </div>

        <div className="mt-6">
          <div className="mb-2 text-[10.5px] font-medium text-[var(--color-muted)]">{t('shell.recentRooms')}</div>
          <div className="space-y-1.5">
            {visibleRecentRooms.map((room) => (
              <NavLink
                key={room.roomId}
                to={`/projects/${room.projectId}/rooms/${room.roomId}`}
                className={({ isActive }) =>
                  cn('recent-project-link min-h-[44px] py-2', (isActive || currentRoomId === room.roomId) && 'is-active')
                }
              >
                <MessageCircle className="h-3.5 w-3.5 flex-shrink-0 text-[#16c8e6]" strokeWidth={1.75} />
                <span className="min-w-0">
                  <span className="block truncate text-[12.5px]">{truncate(room.roomName, 24)}</span>
                  <span className="mt-0.5 block truncate font-mono text-[10.5px] text-[var(--color-fg-muted)]">
                    {truncate(room.projectName, 26)}
                  </span>
                </span>
              </NavLink>
            ))}
            {visibleRecentRooms.length === 0 && (
              <div className="px-2.5 py-4 text-[12px] text-[var(--color-fg-muted)]">
                {t('shell.noRecentRooms')}
              </div>
            )}
          </div>
        </div>
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
  className,
}: {
  to: string;
  label: string;
  icon: typeof Home;
  active?: boolean;
  exact?: boolean;
  inactive?: boolean;
  className?: string;
}): JSX.Element {
  return (
    <NavLink
      to={to}
      end={exact}
      className={({ isActive }) =>
        cn('sidebar-link', className, ((isActive && !inactive) || active) && 'is-active')
      }
    >
      <Icon className="h-4 w-4" strokeWidth={1.65} />
      <span>{label}</span>
    </NavLink>
  );
}

function getProjectId(pathname: string): string | undefined {
  const [, first, projectId] = pathname.split('/');
  return first === 'projects' ? projectId : undefined;
}

function getRoomId(pathname: string): string | undefined {
  const [, first, , second, roomId] = pathname.split('/');
  return first === 'projects' && second === 'rooms' ? roomId : undefined;
}
