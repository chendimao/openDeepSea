import { useEffect, useState, type ReactNode } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Bell,
  Bot,
  Copy,
  Database,
  FileText,
  History,
  Image as ImageIcon,
  Menu,
  MessageCircle,
  Minus,
  Search,
  Settings,
  ShieldCheck,
  Square,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { cn } from '../lib/utils';
import { CreateProjectDialog } from './CreateProjectDialog';
import { CommandMenu } from './CommandMenu';
import { getThemeStyle, type ThemeMode } from '../lib/theme';
import {
  getLastSessionWorkspaceHref,
  subscribeLastSessionWorkspaceHref,
} from '../lib/sessionWorkspaceRouteMemory';

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
  const [sessionWorkspaceHref, setSessionWorkspaceHref] = useState(getLastSessionWorkspaceHref);
  const location = useLocation();
  const { t } = useI18n();
  const themeStyle = getThemeStyle(theme);
  const desktopApi = getDesktopApi();
  const isMacDesktop = desktopApi?.platform === 'darwin';
  const isSessionWorkspaceRoute = location.pathname === '/' ||
    /^\/projects\/[^/]+\/?$/.test(location.pathname) ||
    /^\/projects\/[^/]+\/sessions\/[^/]+\/?$/.test(location.pathname);
  const isKnowledgeRoute = location.pathname === '/knowledge' ||
    /^\/projects\/[^/]+\/knowledge\/?$/.test(location.pathname);
  const isSkillsRoute = location.pathname === '/skills';
  const isImageWorkbenchRoute = /^\/projects\/[^/]+\/images\/?$/.test(location.pathname);
  const isSettingsRoute = location.pathname === '/settings';
  const activeProjectId = location.pathname.match(/^\/projects\/([^/]+)/)?.[1]
    ?? sessionWorkspaceHref.match(/^\/projects\/([^/]+)/)?.[1]
    ?? null;
  const { data: projects = [] } = useQuery({
    queryKey: ['projects'],
    queryFn: api.listProjects,
    refetchInterval: 30_000,
  });

  useEffect(() => {
    setSessionWorkspaceHref(getLastSessionWorkspaceHref());
    return subscribeLastSessionWorkspaceHref(setSessionWorkspaceHref);
  }, []);

  const imageWorkbenchProjectId = activeProjectId ?? projects[0]?.id ?? null;
  const imageWorkbenchHref = imageWorkbenchProjectId ? `/projects/${imageWorkbenchProjectId}/images` : sessionWorkspaceHref;
  const headerNavItems: HeaderNavItem[] = [
    {
      to: sessionWorkspaceHref,
      active: isSessionWorkspaceRoute,
      exact: true,
      icon: History,
      label: '会话',
    },
    { to: '/chat', active: location.pathname === '/chat', icon: MessageCircle, label: '聊天' },
    { to: '/agents', active: location.pathname === '/agents', icon: Bot, label: '智能体' },
    { to: '/skills', active: location.pathname === '/skills', icon: ShieldCheck, label: '技能' },
    {
      to: activeProjectId ? `/projects/${activeProjectId}/knowledge` : '/knowledge',
      active: isKnowledgeRoute,
      icon: Database,
      label: '知识库',
    },
    {
      to: imageWorkbenchHref,
      active: isImageWorkbenchRoute,
      icon: ImageIcon,
      label: '图片',
    },
    {
      to: '/files',
      active: location.pathname === '/files' || /^\/projects\/[^/]+\/files\/?$/.test(location.pathname),
      icon: FileText,
      label: '资源',
    },
  ];

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
    <div className={cn('flex h-screen w-screen flex-col overflow-hidden bg-[var(--color-bg)] text-[var(--color-fg)]', isSessionWorkspaceRoute && 'app-shell--session', isKnowledgeRoute && 'app-shell--knowledge', isSkillsRoute && 'app-shell--skills', isImageWorkbenchRoute && 'app-shell--image-workbench', isSettingsRoute && 'app-shell--settings')}>
      {themeStyle === 'apple' && <div className="liquid-backdrop" aria-hidden="true" />}
      <header className="deepsea-topbar app-header" aria-label={t('shell.sidebar.aria')}>
        <div className="deepsea-topbar__identity">
          {isMacDesktop && <DesktopWindowControls placement="mac" />}
          <NavLink to="/" className="deepsea-brand" aria-label={t('app.name')}>
            <span className="deepsea-brand__mark">
              <img alt="蟹老板 AI 指挥官 Logo" src="/deepsea-krabs-logo.jpg" />
            </span>
            <span>深海指挥中心</span>
          </NavLink>
          <nav className="deepsea-shell-nav" aria-label={t('shell.sidebar.aria')}>
            {headerNavItems.map((item) => (
              <HeaderNavLink key={`${item.to}-${item.label}`} {...item} />
            ))}
          </nav>
        </div>
        <div className="deepsea-topbar__actions">
          <div className="deepsea-action-icons">
            <HeaderMenu
              items={headerNavItems}
              label={t('shell.headerMenu')}
              commandLabel={t('shell.searchCommand')}
              onOpenCommandMenu={() => setCommandOpen(true)}
            />
            <Link to="/settings" aria-label={t('shell.systemSettings')} className="deepsea-icon-button app-header-settings">
              <Settings aria-hidden="true" />
            </Link>
            <button type="button" className="deepsea-icon-button deepsea-icon-button--alert" aria-label="通知">
              <Bell aria-hidden="true" />
              <span />
            </button>
          </div>
          {desktopApi && !isMacDesktop && <DesktopWindowControls placement="system" />}
        </div>
      </header>
      <div className="app-grid">
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

type DesktopApi = NonNullable<Window['openDeepSeaDesktop']>;
type DesktopWindowApi = DesktopApi & Required<Pick<DesktopApi, 'minimizeWindow' | 'toggleMaximizeWindow' | 'closeWindow'>>;

function getDesktopApi(): DesktopWindowApi | null {
  if (typeof window === 'undefined') return null;
  const desktopApi = window.openDeepSeaDesktop;
  if (!desktopApi?.minimizeWindow || !desktopApi.toggleMaximizeWindow || !desktopApi.closeWindow) return null;
  return desktopApi as DesktopWindowApi;
}

function DesktopWindowControls({ placement }: { placement: 'mac' | 'system' }): JSX.Element | null {
  const desktopApi = getDesktopApi();
  const [windowState, setWindowState] = useState<OpenDeepSeaDesktopWindowState>({
    isMaximized: false,
    isFullScreen: false,
  });

  useEffect(() => {
    if (!desktopApi) return undefined;
    let disposed = false;
    const unsubscribe = desktopApi.onWindowStateChanged?.((state) => setWindowState(state));
    void desktopApi.getWindowState?.().then((state) => {
      if (!disposed) setWindowState(state);
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [desktopApi]);

  if (!desktopApi) return null;

  const maximizeLabel = windowState.isMaximized ? '还原窗口' : '最大化窗口';
  const MaximizeIcon = windowState.isMaximized ? Copy : Square;

  return (
    <div
      className={cn('desktop-window-controls', placement === 'mac' ? 'desktop-window-controls--mac' : 'desktop-window-controls--system')}
      role="group"
      aria-label="窗口控制"
    >
      <button
        type="button"
        className="desktop-window-control"
        aria-label="最小化窗口"
        onClick={() => void desktopApi.minimizeWindow()}
      >
        <Minus aria-hidden="true" />
      </button>
      <button
        type="button"
        className="desktop-window-control"
        aria-label={maximizeLabel}
        onClick={() => void desktopApi.toggleMaximizeWindow()}
      >
        <MaximizeIcon aria-hidden="true" />
      </button>
      <button
        type="button"
        className="desktop-window-control desktop-window-control--close"
        aria-label="关闭窗口"
        onClick={() => void desktopApi.closeWindow()}
      >
        <X aria-hidden="true" />
      </button>
    </div>
  );
}

interface HeaderNavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  active?: boolean;
  exact?: boolean;
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

function HeaderMenu({
  items,
  label,
  commandLabel,
  onOpenCommandMenu,
}: {
  items: HeaderNavItem[];
  label: string;
  commandLabel: string;
  onOpenCommandMenu: () => void;
}): JSX.Element {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" aria-label={label} className="deepsea-icon-button app-header-menu-button">
          <Menu aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={8} className="deepsea-header-menu" aria-label={label}>
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <DropdownMenu.Item asChild key={`${item.to}-${item.label}`}>
                <Link
                  to={item.to}
                  className={cn('deepsea-header-menu__item', item.active && 'is-active')}
                >
                  <Icon aria-hidden="true" />
                  <span>{item.label}</span>
                </Link>
              </DropdownMenu.Item>
            );
          })}
          <DropdownMenu.Separator className="deepsea-header-menu__separator" />
          <DropdownMenu.Item
            className="deepsea-header-menu__item"
            onSelect={onOpenCommandMenu}
          >
            <Search aria-hidden="true" />
            <span>{commandLabel}</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
