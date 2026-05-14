import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Bot,
  BriefcaseBusiness,
  FolderKanban,
  GitBranch,
  Home,
  Loader2,
  Moon,
  PanelTop,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings,
  Sparkles,
  SquareCheck,
  Sun,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { api } from '../lib/api';
import { cn, truncate } from '../lib/utils';
import { roomSocket } from '../lib/ws';
import { LobsterMark } from './LobsterMark';
import { CreateProjectDialog } from './CreateProjectDialog';
import { CommandMenu } from './CommandMenu';
import { SystemSettingsDialog } from './SettingsDialogs';
import { Dialog, DialogContent, DialogTrigger } from './ui/Dialog';
import {
  createThemeMode,
  getThemeStyle,
  getThemeTone,
  THEME_STYLES,
  THEME_TONES,
  type ThemeMode,
  type ThemeStyle,
  type ThemeTone,
} from '../lib/theme';

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
  theme,
  onThemeChange,
  onOpenCommand,
}: {
  projects: Awaited<ReturnType<typeof api.listProjects>>;
  currentProject?: Awaited<ReturnType<typeof api.listProjects>>[number];
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
  onOpenCommand: () => void;
}): JSX.Element {
  const {
    data: health,
    error: healthError,
    isLoading: healthLoading,
  } = useQuery({
    queryKey: ['health'],
    queryFn: api.health,
    refetchInterval: 10_000,
  });

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
              local agent workspace
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
        <ThemeToggle theme={theme} onThemeChange={onThemeChange} />
        <OpenClawGatewayDialog
          health={health}
          healthError={healthError}
          healthLoading={healthLoading}
        />
      </div>
    </div>
  );
}

function ThemeToggle({
  theme,
  onThemeChange,
}: {
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
}): JSX.Element {
  const style = getThemeStyle(theme);
  const tone = getThemeTone(theme);
  const styleIcons: Record<ThemeStyle, typeof Sun> = {
    apple: Sparkles,
    minimal: PanelTop,
  };
  const toneIcons: Record<ThemeTone, typeof Sun> = {
    light: Sun,
    dark: Moon,
  };

  return (
    <div className="theme-toggle-stack mb-2" aria-label="主题样式">
      <div className="theme-toggle" aria-label="主题风格">
        {THEME_STYLES.map((option) => {
          const Icon = styleIcons[option.value];
          return (
            <button
              key={option.value}
              type="button"
              className={cn('theme-toggle-option', style === option.value && 'is-active')}
              aria-pressed={style === option.value}
              onClick={() => onThemeChange(createThemeMode(option.value, tone))}
            >
              <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
              <span>{option.label}</span>
            </button>
          );
        })}
      </div>
      <div className="theme-toggle" aria-label="明暗模式">
        {THEME_TONES.map((option) => {
          const Icon = toneIcons[option.value];
          return (
            <button
              key={option.value}
              type="button"
              className={cn('theme-toggle-option', tone === option.value && 'is-active')}
              aria-pressed={tone === option.value}
              onClick={() => onThemeChange(createThemeMode(style, option.value))}
            >
              <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
              <span>{option.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function OpenClawGatewayDialog({
  health,
  healthError,
  healthLoading,
}: {
  health?: Awaited<ReturnType<typeof api.health>>;
  healthError: unknown;
  healthLoading: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const {
    data: gatewayAgents,
    error: agentsError,
    isLoading: agentsLoading,
    refetch,
  } = useQuery({
    queryKey: ['gateway-agents'],
    queryFn: api.listGatewayAgents,
    enabled: open,
  });
  const connected = Boolean(health?.gatewayStatus?.running);
  const rpcConnected = Boolean(health?.gatewayStatus?.rpcOk || health?.gatewayRpcConnected);
  const statusLabel = healthLoading
    ? '检查中'
    : connected
      ? rpcConnected
        ? '网关在线'
        : '网关运行中'
      : '网关离线';
  const statusClass = healthLoading ? 'is-loading' : connected ? 'is-online' : 'is-offline';
  const StatusIcon = healthLoading ? Loader2 : connected ? Wifi : WifiOff;
  const healthMessage = healthError instanceof Error
    ? healthError.message
    : health?.gatewayStatus?.error;
  const agentsMessage = agentsError instanceof Error ? agentsError.message : gatewayAgents?.error;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button type="button" className={cn('gateway-status-button', statusClass)}>
          <span className="gateway-status-light" />
          <StatusIcon
            className={cn('h-3.5 w-3.5', healthLoading && 'animate-spin')}
            strokeWidth={1.75}
          />
          <span className="min-w-0 flex-1 text-left">
            <span className="block truncate text-[12px] font-medium">OpenClaw 网关</span>
            <span className="block truncate font-mono text-[10.5px] text-[var(--color-fg-muted)]">{statusLabel}</span>
          </span>
        </button>
      </DialogTrigger>
      <DialogContent
        title="本机 OpenClaw"
        description="网关运行状态与本机可用 Agent 信息"
        className="max-h-[86vh] w-[min(94vw,620px)] overflow-y-auto"
      >
        <div className="space-y-4">
          <div className="gateway-summary-grid">
            <GatewayStat label="服务状态" value={healthLoading ? '检查中' : connected ? '运行中' : '未连接'} tone={connected ? 'online' : 'offline'} />
            <GatewayStat label="RPC" value={rpcConnected ? '已连接' : '未连接'} tone={rpcConnected ? 'online' : 'offline'} />
            <GatewayStat label="PID" value={health?.gatewayStatus?.pid ? String(health.gatewayStatus.pid) : '-'} />
            <GatewayStat label="Capability" value={health?.gatewayStatus?.capability ?? '-'} />
          </div>

          {healthMessage && (
            <div className="gateway-error-box">
              {healthMessage}
            </div>
          )}

          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-[12px] font-medium">
                <Server className="h-3.5 w-3.5 text-[var(--color-primary)]" strokeWidth={1.75} />
                OpenClaw Agents
              </div>
              <button
                type="button"
                className="sidebar-icon-button"
                aria-label="刷新 OpenClaw 信息"
                onClick={() => void refetch()}
              >
                <RefreshCw className={cn('h-3.5 w-3.5', agentsLoading && 'animate-spin')} strokeWidth={1.75} />
              </button>
            </div>

            {!gatewayAgents && agentsLoading ? (
              <div className="surface-1 rounded-md px-3 py-3 text-[12px] text-[var(--color-fg-muted)]">
                正在读取本机 OpenClaw agents 列表
              </div>
            ) : !gatewayAgents?.connected ? (
              <div className="surface-1 rounded-md px-3 py-3 text-[12px] text-[var(--color-fg-muted)]">
                无法读取本机 OpenClaw agents。{agentsMessage ? `错误: ${agentsMessage}` : ''}
              </div>
            ) : gatewayAgents.agents.length === 0 ? (
              <div className="surface-1 rounded-md px-3 py-3 text-[12px] text-[var(--color-fg-muted)]">
                当前本机 OpenClaw 配置中没有可用 Agent。
              </div>
            ) : (
              <div className="space-y-1.5">
                {gatewayAgents.agents.map((agent) => (
                  <div key={agent.id} className="gateway-agent-row">
                    <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" strokeWidth={1.75} />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-display text-[13px] font-medium">{agent.name ?? agent.id}</span>
                        <span className="shrink-0 font-mono text-[11px] text-[var(--color-fg-muted)]">{agent.id}</span>
                      </div>
                      {(agent.description || agent.workspace) && (
                        <div className="mt-0.5 truncate text-[11px] text-[var(--color-fg-muted)]">
                          {agent.description ?? agent.workspace}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function GatewayStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'online' | 'offline';
}): JSX.Element {
  return (
    <div className={cn('gateway-stat', tone === 'online' && 'is-online', tone === 'offline' && 'is-offline')}>
      <div className="text-[10.5px] text-[var(--color-fg-muted)]">{label}</div>
      <div className="mt-1 truncate font-mono text-[12px] text-[var(--color-fg)]" title={value}>{value}</div>
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
