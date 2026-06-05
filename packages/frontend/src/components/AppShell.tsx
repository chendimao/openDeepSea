import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Bot,
  ChevronDown,
  FolderKanban,
  FolderOpen,
  Home,
  MessageCircle,
  Plus,
  Search,
  Settings,
  ShieldCheck,
} from 'lucide-react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { cn, truncate } from '../lib/utils';
import { roomSocket } from '../lib/ws';
import { LobsterMark } from './LobsterMark';
import { CreateProjectDialog } from './CreateProjectDialog';
import { CommandMenu } from './CommandMenu';
import { SystemSettingsDialog } from './SettingsDialogs';
import { getThemeStyle, type ThemeMode } from '../lib/theme';

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
  const themeStyle = getThemeStyle(theme);
  const projectId = getProjectId(location.pathname);
  const isRoomRoute = Boolean(getRoomId(location.pathname));
  const isDevelopmentRoute = location.pathname === '/' || location.pathname.startsWith('/projects/');
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
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[var(--color-bg)] text-[var(--color-fg)]">
      {themeStyle === 'apple' && <div className="liquid-backdrop" aria-hidden="true" />}
      <header className="shell-public-header" aria-label={t('shell.sidebar.aria')}>
        <NavLink to="/" className="shell-brand" aria-label={t('app.name')}>
          <span className="shell-brand-logo">
            <LobsterMark className="h-5 w-5" />
          </span>
          <span className="shell-brand-copy">
            <span className="shell-brand-name">{t('app.name')}</span>
            <span className="shell-brand-subtitle">{t('shell.subtitle')}</span>
          </span>
        </NavLink>
        <nav className="shell-public-nav" aria-label={t('shell.sidebar.aria')}>
          <SidebarLink to="/" active={isDevelopmentRoute} icon={Home} label="Sessions" exact className="shell-public-link" />
          <SidebarLink to="/chat" icon={MessageCircle} label={t('shell.nav.chat')} className="shell-public-link" />
          <SidebarLink to="/agents" icon={Bot} label={t('shell.nav.agents')} className="shell-public-link" />
          <SidebarLink to="/skills" icon={ShieldCheck} label={t('shell.nav.skills')} className="shell-public-link" />
          <SidebarLink to="/files" icon={FolderKanban} label={t('shell.nav.files')} className="shell-public-link" />
        </nav>
        <div className="shell-header-actions">
          <button
            type="button"
            onClick={() => setCommandOpen(true)}
            className="shell-command-button"
            aria-label={t('shell.searchCommand')}
          >
            <Search className="h-3.5 w-3.5" strokeWidth={1.75} />
            <span>{t('shell.searchCommand')}</span>
            <span className="shell-command-kbd">⌘K</span>
          </button>
          <HeaderProjectMenu projects={projects} currentProject={currentProject} />
          <button
            type="button"
            aria-label={t('shell.newProject')}
            className="shell-icon-button"
            onClick={() => setCreateProjectOpen(true)}
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={1.9} />
          </button>
          <SystemSettingsDialog theme={theme} onThemeChange={onThemeChange}>
            <button type="button" aria-label={t('shell.systemSettings')} className="shell-icon-button">
              <Settings className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
          </SystemSettingsDialog>
        </div>
      </header>
      <div className={cn('app-grid', isRoomRoute && 'app-grid--room')}>
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

function HeaderProjectMenu({
  projects,
  currentProject,
}: {
  projects: Awaited<ReturnType<typeof api.listProjects>>;
  currentProject?: Awaited<ReturnType<typeof api.listProjects>>[number];
}): JSX.Element {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const closeTimerRef = useRef<number | null>(null);

  const clearCloseTimer = () => {
    if (closeTimerRef.current === null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };
  const openMenu = () => {
    clearCloseTimer();
    setOpen(true);
  };
  const scheduleClose = () => {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false);
      closeTimerRef.current = null;
    }, 140);
  };

  useEffect(() => clearCloseTimer, []);

  return (
    <div
      className={cn('shell-project-menu', open && 'is-open')}
      onMouseEnter={openMenu}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        className="shell-project-trigger"
        aria-expanded={open}
        onClick={() => {
          clearCloseTimer();
          setOpen((value) => !value);
        }}
      >
        <FolderOpen className="h-3.5 w-3.5" strokeWidth={1.8} />
        <span>{currentProject ? truncate(currentProject.name, 24) : t('shell.recentProjects')}</span>
        <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.8} />
      </button>
      {open && (
        <div className="shell-project-dropdown" role="menu">
          {projects.map((project) => (
            <NavLink
              key={project.id}
              to={`/projects/${project.id}`}
              className={({ isActive }) =>
                cn('shell-project-option', (isActive || currentProject?.id === project.id) && 'is-active')
              }
              role="menuitem"
              onClick={() => {
                clearCloseTimer();
                setOpen(false);
              }}
            >
              <span className="shell-project-dot" />
              <span className="truncate">{project.name}</span>
            </NavLink>
          ))}
          {projects.length === 0 && (
            <div className="shell-project-empty">{t('shell.noProjects')}</div>
          )}
        </div>
      )}
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
