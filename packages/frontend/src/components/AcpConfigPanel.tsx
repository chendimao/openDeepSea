import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Code2, Sparkles, Terminal, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import type { AcpBackend, RoomAgent } from '../lib/types';
import { cn, relativeTime, truncate } from '../lib/utils';
import { Button } from './ui/Button';

const BACKENDS: { id: AcpBackend; label: string; sub: string; icon: typeof Code2 }[] = [
  { id: 'claudecode', label: 'Claude Code', sub: 'Anthropic 官方 CLI', icon: Sparkles },
  { id: 'opencode',  label: 'OpenCode',    sub: 'opencode-ai/opencode', icon: Terminal },
  { id: 'codex',     label: 'Codex',       sub: 'OpenAI Codex CLI',     icon: Code2 },
];

export function AcpConfigPanel({
  agent,
  projectId,
  roomId,
  onClose,
}: {
  agent: RoomAgent;
  projectId: string;
  roomId: string;
  onClose: () => void;
}) {
  const [enabled, setEnabled] = useState<boolean>(!!agent.acp_enabled);
  const [backend, setBackend] = useState<AcpBackend | null>(agent.acp_backend);
  const [sessionId, setSessionId] = useState<string | null>(agent.acp_session_id);
  const queryClient = useQueryClient();

  useEffect(() => {
    setEnabled(!!agent.acp_enabled);
    setBackend(agent.acp_backend);
    setSessionId(agent.acp_session_id);
  }, [agent]);

  const { data: sessions = [], isLoading: sessionsLoading } = useQuery({
    queryKey: ['acp-sessions', projectId, backend],
    queryFn: () => api.listAcpSessions(projectId, backend!),
    enabled: enabled && !!backend,
  });

  const save = useMutation({
    mutationFn: () => {
      const label = sessions.find((s) => s.sessionId === sessionId)?.title ?? null;
      return api.setAgentAcp(roomId, agent.id, {
        acp_enabled: enabled,
        acp_backend: enabled ? backend : null,
        acp_session_id: enabled ? sessionId : null,
        acp_session_label: label,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['room-agents', roomId] });
      toast.success('ACP 配置已保存');
      onClose();
    },
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <div className="workspace-drawer absolute right-0 top-0 z-30 h-full surface-1 border-l border-[var(--color-border)] flex flex-col fade-up">
      <header className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2">
        <Bot className="h-4 w-4 text-[var(--color-accent)]" strokeWidth={1.75} />
        <div className="min-w-0">
          <div className="font-display text-[14px] font-semibold truncate">{agent.agent_name}</div>
          <div className="text-[11px] font-mono text-[var(--color-fg-muted)] truncate">{agent.agent_id}</div>
        </div>
        <button
          onClick={onClose}
          aria-label="关闭"
          type="button"
          className="ml-auto p-1 rounded text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-raised)] ease-ocean"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
        <section>
          <div className="flex items-center justify-between">
            <div>
              <div className="font-display text-[13px] font-medium">启用 ACP</div>
              <div className="text-[11.5px] text-[var(--color-fg-muted)] mt-0.5">
                让此 profile 通过本地 CLI 执行编码任务
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              onClick={() => setEnabled((v) => !v)}
              className={cn(
                'relative h-5 w-9 rounded-full border ease-ocean transition-colors',
                enabled
                  ? 'border-[var(--color-primary)] bg-[var(--color-primary)]'
                  : 'border-[var(--color-border-strong)] bg-[var(--color-switch-off)]',
              )}
            >
              <span
                className={cn(
                  'absolute top-0.5 h-4 w-4 rounded-full bg-[var(--color-switch-thumb)] shadow-[0_1px_3px_rgba(16,32,38,0.22)] ease-ocean transition-transform',
                  enabled ? 'translate-x-[18px]' : 'translate-x-[2px]',
                )}
              />
            </button>
          </div>
        </section>

        {enabled && (
          <>
            <section>
              <div className="font-display text-[12px] font-medium uppercase tracking-wider text-[var(--color-fg-muted)] mb-2">
                选择后端
              </div>
              <div className="space-y-2">
                {BACKENDS.map((b) => {
                  const Icon = b.icon;
                  const selected = backend === b.id;
                  return (
                    <button
                      type="button"
                      key={b.id}
                      onClick={() => {
                        setBackend(b.id);
                        setSessionId(null);
                      }}
                      className={cn(
                        'w-full surface-1 rounded-lg px-3 py-2.5 flex items-center gap-3 text-left ease-ocean transition-all',
                        selected
                          ? 'border-[var(--color-primary)] glow-primary'
                          : 'hover:border-[var(--color-border-strong)]',
                      )}
                    >
                      <Icon className="h-4 w-4 text-[var(--color-accent)]" strokeWidth={1.75} />
                      <div className="min-w-0">
                        <div className="font-display text-[13px] font-medium">{b.label}</div>
                        <div className="text-[11px] text-[var(--color-fg-muted)] font-mono">{b.sub}</div>
                      </div>
                      {selected && (
                        <span className="ml-auto h-1.5 w-1.5 rounded-full bg-[var(--color-primary)]" />
                      )}
                    </button>
                  );
                })}
              </div>
            </section>

            {backend && (
              <section>
                <div className="font-display text-[12px] font-medium uppercase tracking-wider text-[var(--color-fg-muted)] mb-2">
                  Session ({sessions.length})
                </div>
                <div className="space-y-1.5 max-h-[360px] overflow-y-auto pr-1">
                  <button
                    type="button"
                    onClick={() => setSessionId(null)}
                    className={cn(
                      'w-full surface-1 rounded-md px-3 py-2 text-left ease-ocean transition-all flex items-center gap-2',
                      sessionId === null
                        ? 'border-[var(--color-accent)] glow-accent'
                        : 'hover:border-[var(--color-border-strong)]',
                    )}
                  >
                    <Sparkles className="h-3.5 w-3.5 text-[var(--color-accent)]" strokeWidth={1.75} />
                    <span className="font-display text-[12.5px]">新建会话</span>
                    <span className="ml-auto text-[10.5px] font-mono text-[var(--color-fg-muted)]">
                      新对话 / 新上下文
                    </span>
                  </button>

                  {sessionsLoading && (
                    <div className="text-[12px] text-[var(--color-fg-muted)] py-3">扫描本地 session…</div>
                  )}

                  {!sessionsLoading && sessions.length === 0 && (
                    <div className="text-[12px] text-[var(--color-fg-muted)] py-3">
                      此项目下还没有 {backend} 的历史 session
                    </div>
                  )}

                  {sessions.map((s) => (
                    <button
                      type="button"
                      key={s.sessionId}
                      onClick={() => setSessionId(s.sessionId)}
                      className={cn(
                        'w-full surface-1 rounded-md px-3 py-2 text-left ease-ocean transition-all',
                        sessionId === s.sessionId
                          ? 'border-[var(--color-accent)] glow-accent'
                          : 'hover:border-[var(--color-border-strong)]',
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[10.5px] text-[var(--color-muted)] truncate">
                          {s.sessionId.slice(0, 10)}
                        </span>
                        <span className="text-[10.5px] font-mono text-[var(--color-fg-muted)] ml-auto">
                          {relativeTime(s.lastActivity)}
                        </span>
                      </div>
                      <div className="text-[12.5px] text-[var(--color-fg)] mt-1 line-clamp-2">
                        {truncate(s.title || s.firstUserMessage || '(空 session)', 100)}
                      </div>
                      {s.messageCount > 0 && (
                        <div className="text-[10.5px] font-mono text-[var(--color-muted)] mt-1">
                          {s.messageCount} 条记录
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>

      <footer className="px-4 py-3 border-t border-[var(--color-border)] flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? '保存中…' : '应用'}
        </Button>
      </footer>
    </div>
  );
}
