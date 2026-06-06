import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Bell,
  Bot,
  FileText,
  History,
  MessageCircle,
  Settings,
  ShieldCheck,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { cn } from '../lib/utils';
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
  const isRoomRoute = Boolean(getRoomId(location.pathname));
  const isSessionWorkspaceRoute = location.pathname === '/' ||
    /^\/projects\/[^/]+\/?$/.test(location.pathname) ||
    /^\/projects\/[^/]+\/sessions\/[^/]+\/?$/.test(location.pathname);
  const { data: projects = [] } = useQuery({
    queryKey: ['projects'],
    queryFn: api.listProjects,
    refetchInterval: 30_000,
  });

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
    <div className={cn('flex h-screen w-screen flex-col overflow-hidden bg-[var(--color-bg)] text-[var(--color-fg)]', isSessionWorkspaceRoute && 'app-shell--session')}>
      {themeStyle === 'apple' && <div className="liquid-backdrop" aria-hidden="true" />}
      <header className="deepsea-topbar app-header" aria-label={t('shell.sidebar.aria')}>
        <div className="deepsea-topbar__identity">
          <NavLink to="/" className="deepsea-brand" aria-label={t('app.name')}>
            <span className="deepsea-brand__mark">
              <img alt="蟹老板 AI 指挥官 Logo" src="/deepsea-krabs-logo.jpg" />
            </span>
            <span>深海指挥中心</span>
          </NavLink>
          <nav className="deepsea-shell-nav" aria-label={t('shell.sidebar.aria')}>
            <HeaderNavLink
              to="/"
              active={isSessionWorkspaceRoute}
              exact
              icon={History}
              label="会话"
            />
            <HeaderNavLink to="/chat" icon={MessageCircle} label="聊天" />
            <HeaderNavLink to="/agents" icon={Bot} label="智能体" />
            <HeaderNavLink to="/skills" icon={ShieldCheck} label="技能" />
            <HeaderNavLink
              to="/files"
              active={location.pathname === '/files' || /^\/projects\/[^/]+\/files\/?$/.test(location.pathname)}
              icon={FileText}
              label="资源"
            />
          </nav>
        </div>
        <div className="deepsea-topbar__actions">
          <div className="deepsea-action-icons">
            <SystemSettingsDialog theme={theme} onThemeChange={onThemeChange}>
              <button type="button" aria-label={t('shell.systemSettings')} className="deepsea-icon-button app-header-settings">
                <Settings aria-hidden="true" />
              </button>
            </SystemSettingsDialog>
            <button type="button" className="deepsea-icon-button deepsea-icon-button--alert" aria-label="通知">
              <Bell aria-hidden="true" />
              <span />
            </button>
          </div>
          <img alt="Profile" className="deepsea-avatar" src="/deepsea-profile-avatar.png" />
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

function HeaderNavLink({
  to,
  label,
  icon: Icon,
  active = false,
  exact = false,
}: {
  to: string;
  label: string;
  icon: LucideIcon;
  active?: boolean;
  exact?: boolean;
}): JSX.Element {
  return (
    <NavLink
      to={to}
      end={exact}
      className={({ isActive }) =>
        cn((isActive || active) && 'is-active')
      }
    >
      <Icon aria-hidden="true" />
      <span>{label}</span>
    </NavLink>
  );
}

function getRoomId(pathname: string): string | undefined {
  const [, first, , second, roomId] = pathname.split('/');
  return first === 'projects' && second === 'rooms' ? roomId : undefined;
}
