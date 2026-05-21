import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Bot,
  BriefcaseBusiness,
  FolderKanban,
  Home,
  MessageCircle,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  SquareCheck,
} from 'lucide-react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { cn, truncate } from '../lib/utils';
import { roomSocket } from '../lib/ws';
import { LobsterMark } from './LobsterMark';
import { CreateProjectDialog } from './CreateProjectDialog';
import { CommandMenu } from './CommandMenu';
import { SystemSettingsDialog } from './SettingsDialogs';
import { type ThemeMode } from '../lib/theme';

const RECENT_ROOM_LIMIT = 6;

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
  const { t } = useI18n();
  const projectId = getProjectId(location.pathname);
  const roomId = getRoomId(location.pathname);
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
        <aside className="app-sidebar" aria-label={t('shell.sidebar.aria')}>
          <ProjectSidebar
            projects={projects}
            currentProject={currentProject}
            projectId={projectId}
            roomId={roomId}
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
  currentProject,
  projectId,
  roomId,
  theme,
  onThemeChange,
  onOpenCommand,
}: {
  projects: Awaited<ReturnType<typeof api.listProjects>>;
  currentProject?: Awaited<ReturnType<typeof api.listProjects>>[number];
  projectId?: string;
  roomId?: string;
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
  onOpenCommand: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const location = useLocation();
  const {
    data: rooms = [],
    isLoading: roomsLoading,
    isError: roomsError,
  } = useQuery({
    queryKey: ['rooms', projectId],
    queryFn: () => api.listRooms(projectId!),
    enabled: Boolean(projectId),
  });
  const recentRooms = rooms.slice(0, RECENT_ROOM_LIMIT);

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

      <div className="sidebar-nav px-4">
        <SidebarLink to="/" active={location.pathname === '/'} icon={Home} label={t('shell.nav.development')} exact />
        <SidebarLink to="/chat" icon={MessageCircle} label={t('shell.nav.chat')} />
        <SidebarLink to="/agents" icon={Bot} label={t('shell.nav.agents')} />
        <SidebarLink to="/skills" icon={ShieldCheck} label={t('shell.nav.skills')} />
        <SidebarLink
          to={currentProject ? `/projects/${currentProject.id}` : '/'}
          icon={SquareCheck}
          label={t('shell.nav.tasks')}
          inactive={!currentProject}
        />
        <SidebarLink to="/workflow" icon={BriefcaseBusiness} label={t('shell.nav.workflow')} />
        <SidebarLink to="/files" icon={FolderKanban} label={t('shell.nav.files')} />
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5">
        <div className="mb-3 text-[10.5px] font-medium text-[var(--color-muted)]">{t('shell.recentRooms')}</div>
        {currentProject ? (
          <div className="glass-room-list-card">
            <div className="mb-3 flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-[12.5px] font-medium text-[var(--color-fg)]">
                {currentProject.name}
              </span>
              <span className="font-mono text-[10px] text-[var(--color-muted)]">
                {t('shell.recentRoomsCount', { count: rooms.length })}
              </span>
            </div>
            {roomsLoading ? (
              <div className="space-y-2" aria-label={t('shell.recentRoomsLoading')}>
                {Array.from({ length: 3 }).map((_, index) => (
                  <div key={index} className="recent-room-skeleton" />
                ))}
              </div>
            ) : roomsError ? (
              <div className="recent-room-empty">
                <MessageCircle className="h-5 w-5 text-[var(--color-primary)]" strokeWidth={1.7} />
                <p>{t('shell.recentRoomsError')}</p>
              </div>
            ) : recentRooms.length > 0 ? (
              <div className="space-y-1.5">
                {recentRooms.map((room) => {
                  const active = room.id === roomId;
                  return (
                    <NavLink
                      key={room.id}
                      to={`/projects/${room.project_id}/rooms/${room.id}`}
                      className={cn('recent-room-link', active && 'is-active')}
                      aria-current={active ? 'page' : undefined}
                      title={room.description ?? room.name}
                    >
                      <span className="recent-room-dot" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12.5px] font-medium">{room.name}</span>
                        {room.description ? (
                          <span className="mt-0.5 block truncate text-[10.5px] text-[var(--color-muted)]">
                            {room.description}
                          </span>
                        ) : null}
                      </span>
                    </NavLink>
                  );
                })}
              </div>
            ) : (
              <div className="recent-room-empty">
                <MessageCircle className="h-5 w-5 text-[var(--color-primary)]" strokeWidth={1.7} />
                <p>{t('shell.recentRoomsEmpty')}</p>
              </div>
            )}
          </div>
        ) : (
          <div className="glass-room-list-card text-center">
            <FolderKanban className="mx-auto h-6 w-6 text-[var(--color-primary)]" strokeWidth={1.75} />
            <div className="mt-3 font-display text-[13px] font-medium">{t('shell.selectProject')}</div>
            <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-fg-muted)]">
              {t('shell.selectProjectDescription')}
            </p>
          </div>
        )}

        <div className="mt-6">
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

function getProjectId(pathname: string): string | undefined {
  const [, first, projectId] = pathname.split('/');
  return first === 'projects' ? projectId : undefined;
}

function getRoomId(pathname: string): string | undefined {
  const [, first, , third, roomId] = pathname.split('/');
  return first === 'projects' && third === 'rooms' ? roomId : undefined;
}
