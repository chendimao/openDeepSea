import { useEffect, type ReactNode } from 'react';
import { NavLink, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Activity, FolderKanban, Plus, Settings } from 'lucide-react';
import { api } from '../lib/api';
import { cn, truncate } from '../lib/utils';
import { roomSocket } from '../lib/ws';
import { LobsterMark } from './LobsterMark';
import { CreateProjectDialog } from './CreateProjectDialog';

export function AppShell({ children }: { children: ReactNode }): JSX.Element {
  useEffect(() => {
    roomSocket.connect();
    return () => roomSocket.destroy();
  }, []);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[var(--color-bg)] text-[var(--color-fg)]">
      <Sidebar />
      <main className="flex-1 min-w-0 overflow-hidden">{children}</main>
    </div>
  );
}

function Sidebar(): JSX.Element {
  const { projectId } = useParams();
  const { data: projects = [] } = useQuery({
    queryKey: ['projects'],
    queryFn: api.listProjects,
    refetchInterval: 30_000,
  });
  const { data: gw } = useQuery({
    queryKey: ['gateway-status'],
    queryFn: api.health,
    refetchInterval: 15_000,
  });

  return (
    <aside className="w-[260px] flex-shrink-0 surface-1 border-r border-[var(--color-border)] flex flex-col">
      <div className="px-4 py-4 flex items-center gap-2 border-b border-[var(--color-border)]">
        <LobsterMark className="h-7 w-7" />
        <div>
          <div className="font-display text-[15px] font-semibold tracking-tight leading-tight">
            OpenClaw Room
          </div>
          <div className="text-[11px] text-[var(--color-fg-muted)] font-mono leading-tight">
            v0.1 · deep ocean
          </div>
        </div>
      </div>

      <div className="px-3 py-3 flex items-center justify-between text-[11px] uppercase tracking-wider text-[var(--color-fg-muted)] font-mono">
        <span>项目</span>
        <CreateProjectDialog>
          <button
            type="button"
            aria-label="新建项目"
            className="rounded-md p-1 hover:bg-[var(--color-surface-raised)] text-[var(--color-fg-muted)] hover:text-[var(--color-primary)] ease-ocean transition-colors"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
        </CreateProjectDialog>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        <NavLink
          to="/"
          end
          className={({ isActive }) =>
            cn(
              'group flex items-center gap-2 rounded-md px-2.5 py-2 text-sm ease-ocean transition-colors mb-1',
              isActive
                ? 'bg-[var(--color-surface-raised)] text-[var(--color-fg)]'
                : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-raised)]',
            )
          }
        >
          <FolderKanban className="h-4 w-4" strokeWidth={1.75} />
          <span className="font-display text-[13px]">所有项目</span>
          <span className="ml-auto text-[11px] text-[var(--color-muted)] font-mono">{projects.length}</span>
        </NavLink>

        <div className="space-y-0.5 mt-2">
          {projects.map((p) => (
            <NavLink
              key={p.id}
              to={`/projects/${p.id}`}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm ease-ocean transition-colors',
                  isActive || projectId === p.id
                    ? 'bg-[var(--color-surface-raised)] text-[var(--color-fg)]'
                    : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-raised)]',
                )
              }
              title={p.path}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)] opacity-60 flex-shrink-0" />
              <span className="font-display text-[12.5px] truncate">{truncate(p.name, 22)}</span>
              {(p.stats?.tasksInProgress ?? 0) > 0 && (
                <span className="ml-auto text-[10px] font-mono text-[var(--color-warning)]">
                  {p.stats?.tasksInProgress}
                </span>
              )}
            </NavLink>
          ))}
          {projects.length === 0 && (
            <div className="px-3 py-6 text-center text-[12px] text-[var(--color-muted)]">
              还没有项目
              <br />
              <CreateProjectDialog>
                <button className="text-[var(--color-primary)] hover:text-[var(--color-primary-hover)] mt-2 underline-offset-4 hover:underline ease-ocean">
                  添加第一个项目
                </button>
              </CreateProjectDialog>
            </div>
          )}
        </div>
      </nav>

      <div className="px-3 py-3 border-t border-[var(--color-border)] flex items-center gap-2 text-[11px] text-[var(--color-fg-muted)] font-mono">
        <span
          className={cn(
            'h-1.5 w-1.5 rounded-full',
            gw?.gateway ? 'bg-[var(--color-success)]' : 'bg-[var(--color-muted)]',
          )}
        />
        <Activity className="h-3 w-3" strokeWidth={1.75} />
        <span>{gw?.gateway ? 'Gateway 已连接' : 'Gateway 离线'}</span>
        <button
          type="button"
          aria-label="设置"
          className="ml-auto p-1 hover:text-[var(--color-fg)] ease-ocean"
        >
          <Settings className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
      </div>
    </aside>
  );
}
