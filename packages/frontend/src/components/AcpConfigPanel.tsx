import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Code2, Sparkles, Terminal, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { type MessageKey, useI18n } from '../lib/i18n';
import type { AcpBackend, AcpPermissionMode, RoomAgent, WorkflowRole } from '../lib/types';
import { cn, truncate } from '../lib/utils';
import { Button } from './ui/Button';

const BACKENDS: { id: AcpBackend; label: string; icon: typeof Code2 }[] = [
  { id: 'claudecode', label: 'Claude Code', icon: Sparkles },
  { id: 'opencode', label: 'OpenCode', icon: Terminal },
  { id: 'codex', label: 'Codex', icon: Code2 },
];

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

const CODEX_PERMISSION_MODES: { id: AcpPermissionMode; titleKey: MessageKey; descriptionKey: MessageKey }[] = [
  { id: 'bypass', titleKey: 'acp.permission.bypass', descriptionKey: 'acp.permission.bypassHelp' },
  { id: 'workspace-write', titleKey: 'acp.permission.workspaceWrite', descriptionKey: 'acp.permission.workspaceWriteHelp' },
  { id: 'read-only', titleKey: 'acp.permission.readOnly', descriptionKey: 'acp.permission.readOnlyHelp' },
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
  const [workflowRole, setWorkflowRole] = useState<WorkflowRole | null>(agent.workflow_role);
  const [permissionMode, setPermissionMode] = useState<AcpPermissionMode>(agent.acp_permission_mode ?? 'bypass');
  const [writableDirsText, setWritableDirsText] = useState((agent.acp_writable_dirs ?? []).join('\n'));
  const queryClient = useQueryClient();
  const { formatRelativeTime, t, workflowRoleLabel } = useI18n();

  useEffect(() => {
    setEnabled(!!agent.acp_enabled);
    setBackend(agent.acp_backend);
    setSessionId(agent.acp_session_id);
    setWorkflowRole(agent.workflow_role);
    setPermissionMode(agent.acp_permission_mode ?? 'bypass');
    setWritableDirsText((agent.acp_writable_dirs ?? []).join('\n'));
  }, [agent]);

  const { data: sessions = [], isLoading: sessionsLoading } = useQuery({
    queryKey: ['acp-sessions', projectId, backend],
    queryFn: () => api.listAcpSessions(projectId, backend!),
    enabled: enabled && !!backend,
  });

  const save = useMutation({
    mutationFn: async () => {
      const label = sessions.find((s) => s.sessionId === sessionId)?.title ?? null;
      const updated = await api.setAgentAcp(roomId, agent.id, {
        acp_enabled: enabled,
        acp_backend: enabled ? backend : null,
        acp_session_id: enabled ? sessionId : null,
        acp_session_label: label,
        acp_permission_mode: permissionMode,
        acp_writable_dirs: parseWritableDirs(writableDirsText),
      });
      return api.setAgentWorkflowRole(roomId, updated.id, workflowRole);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['room-agents', roomId] });
      toast.success(t('acp.saved'));
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
          aria-label={t('common.close')}
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
              <div className="font-display text-[13px] font-medium">{t('acp.enableTitle')}</div>
              <div className="text-[11.5px] text-[var(--color-fg-muted)] mt-0.5">
                {t('acp.enableDescription')}
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
                  'absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-[var(--color-switch-thumb)] shadow-[0_1px_3px_rgba(16,32,38,0.22)] ease-ocean transition-transform',
                  enabled ? 'translate-x-4' : 'translate-x-0',
                )}
              />
            </button>
          </div>
        </section>

        <section>
          <label
            htmlFor="agent-workflow-role"
            className="block font-display text-[12px] font-medium uppercase tracking-wider text-[var(--color-fg-muted)] mb-2"
          >
            {t('acp.workflowRole')}
          </label>
          <select
            id="agent-workflow-role"
            value={workflowRole ?? ''}
            onChange={(e) => setWorkflowRole((e.target.value || null) as WorkflowRole | null)}
            className="surface-1 h-10 w-full rounded-lg px-3 text-[13px] outline-none focus:border-[var(--color-primary)] focus:glow-primary"
          >
            <option value="">{t('acp.noWorkflowRole')}</option>
            {(['analyst', 'planner', 'coordinator', 'executor', 'reviewer', 'acceptor'] as const).map((role) => (
              <option key={role} value={role}>
                {workflowRoleLabel(role)}
              </option>
            ))}
          </select>
          <div className="mt-2 text-[11.5px] text-[var(--color-fg-muted)]">
            {t('acp.workflowRoleHelp')}
          </div>
        </section>

        {enabled && (
          <>
            <section>
              <div className="font-display text-[12px] font-medium uppercase tracking-wider text-[var(--color-fg-muted)] mb-2">
                {t('acp.backendLabel')}
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
                        <div className="text-[11px] text-[var(--color-fg-muted)] font-mono">
                          {t(`acp.backend.${b.id}`)}
                        </div>
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
              <>
              <section>
                <div className="font-display text-[12px] font-medium uppercase tracking-wider text-[var(--color-fg-muted)] mb-2">
                  {t('acp.permissionLabel')}
                </div>
                <div className="space-y-2">
                  {CODEX_PERMISSION_MODES.map((mode) => {
                    const selected = permissionMode === mode.id;
                    return (
                      <button
                        type="button"
                        key={mode.id}
                        onClick={() => setPermissionMode(mode.id)}
                        className={cn(
                          'w-full surface-1 rounded-lg px-3 py-2.5 text-left ease-ocean transition-all',
                          selected
                            ? 'border-[var(--color-primary)] glow-primary'
                            : 'hover:border-[var(--color-border-strong)]',
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-display text-[13px] font-medium">{t(mode.titleKey)}</span>
                          {selected && (
                            <span className="ml-auto h-1.5 w-1.5 rounded-full bg-[var(--color-primary)]" />
                          )}
                        </div>
                        <div className="mt-1 text-[11.5px] text-[var(--color-fg-muted)]">
                          {permissionModeDescription(t, backend, mode.id, mode.descriptionKey)}
                        </div>
                      </button>
                    );
                  })}
                </div>

                {permissionMode === 'workspace-write' && (backend === 'codex' || backend === 'claudecode') && (
                  <div className="mt-3">
                    <label
                      htmlFor="acp-writable-dirs"
                      className="block font-display text-[12px] font-medium uppercase tracking-wider text-[var(--color-fg-muted)] mb-2"
                    >
                      {t('acp.writableDirs')}
                    </label>
                    <textarea
                      id="acp-writable-dirs"
                      value={writableDirsText}
                      onChange={(e) => setWritableDirsText(e.target.value)}
                      placeholder="/Users/chendimao/WWW/another-project"
                      className="surface-1 min-h-24 w-full rounded-lg px-3 py-2 text-[12px] font-mono outline-none focus:border-[var(--color-primary)] focus:glow-primary"
                    />
                    <div className="mt-2 text-[11.5px] text-[var(--color-fg-muted)]">
                      {t(backend === 'claudecode' ? 'acp.writableDirsHelp.claudecode' : 'acp.writableDirsHelp.codex')}
                    </div>
                  </div>
                )}

                {permissionMode === 'workspace-write' && backend === 'opencode' && (
                  <div className="mt-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-[11.5px] text-[var(--color-fg-muted)]">
                    {t('acp.writableDirsHelp.opencode')}
                  </div>
                )}
              </section>

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
                    <span className="font-display text-[12.5px]">{t('acp.newSession')}</span>
                    <span className="ml-auto text-[10.5px] font-mono text-[var(--color-fg-muted)]">
                      {t('acp.newSessionDescription')}
                    </span>
                  </button>

                  {sessionsLoading && (
                    <div className="text-[12px] text-[var(--color-fg-muted)] py-3">
                      {t('acp.loadingSessions')}
                    </div>
                  )}

                  {!sessionsLoading && sessions.length === 0 && (
                    <div className="text-[12px] text-[var(--color-fg-muted)] py-3">
                      {t('acp.noSessions', { backend })}
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
                          {formatRelativeTime(s.lastActivity)}
                        </span>
                      </div>
                      <div className="text-[12.5px] text-[var(--color-fg)] mt-1 line-clamp-2">
                        {truncate(s.title || s.firstUserMessage || t('acp.emptySession'), 100)}
                      </div>
                      {s.messageCount > 0 && (
                        <div className="text-[10.5px] font-mono text-[var(--color-muted)] mt-1">
                          {t('acp.recordCount', { count: s.messageCount })}
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </section>
              </>
            )}
          </>
        )}
      </div>

      <footer className="px-4 py-3 border-t border-[var(--color-border)] flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? t('acp.saving') : t('common.apply')}
        </Button>
      </footer>
    </div>
  );
}

function parseWritableDirs(value: string): string[] {
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const line of value.split('\n')) {
    const dir = line.trim();
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    dirs.push(dir);
  }
  return dirs;
}

function permissionModeDescription(
  t: Translate,
  backend: AcpBackend,
  mode: AcpPermissionMode,
  fallbackKey: MessageKey,
): string {
  if (backend === 'claudecode') {
    if (mode === 'bypass') return t('acp.permission.bypassHelp.claudecode');
    if (mode === 'workspace-write') return t('acp.permission.workspaceWriteHelp.claudecode');
    return t('acp.permission.readOnlyHelp.claudecode');
  }
  if (backend === 'opencode') {
    if (mode === 'bypass') return t('acp.permission.bypassHelp.opencode');
    return t('acp.permission.limitedHelp.opencode');
  }
  return t(fallbackKey);
}
