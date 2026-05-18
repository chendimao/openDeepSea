import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Bot, Code2, Sparkles, Terminal, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { type MessageKey, useI18n } from '../lib/i18n';
import type {
  AcpBackend,
  AcpPermissionMode,
  AgentMemoryScope,
  AgentRuntimeBackend,
  AgentToolCapability,
  RoomAgent,
  WorkflowRole,
} from '../lib/types';
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

type BoundaryTemplate = 'readOnly' | 'backend' | 'frontend' | 'custom';

const TOOL_CAPABILITIES: AgentToolCapability[] = [
  'read_files',
  'write_files',
  'run_shell',
  'browser',
  'search',
  'image_input',
  'commit',
];

const MEMORY_SCOPES: AgentMemoryScope[] = ['project', 'room', 'agent', 'task', 'none'];

const BOUNDARY_TEMPLATES: Record<
  Exclude<BoundaryTemplate, 'custom'>,
  {
    permissionMode: AcpPermissionMode;
    runtimeBackend: AgentRuntimeBackend;
    tools: AgentToolCapability[];
    writeDirs: string[];
    memoryScope: AgentMemoryScope;
  }
> = {
  readOnly: {
    permissionMode: 'read-only',
    runtimeBackend: 'acp',
    tools: ['read_files'],
    writeDirs: [],
    memoryScope: 'room',
  },
  backend: {
    permissionMode: 'workspace-write',
    runtimeBackend: 'acp',
    tools: ['read_files', 'write_files', 'run_shell'],
    writeDirs: ['packages/backend'],
    memoryScope: 'room',
  },
  frontend: {
    permissionMode: 'workspace-write',
    runtimeBackend: 'acp',
    tools: ['read_files', 'write_files', 'run_shell'],
    writeDirs: ['packages/frontend'],
    memoryScope: 'room',
  },
};

export function AcpConfigPanel({
  agent,
  roomAgents,
  projectId,
  projectPath,
  roomId,
  onClose,
}: {
  agent: RoomAgent;
  roomAgents: RoomAgent[];
  projectId: string;
  projectPath: string;
  roomId: string;
  onClose: () => void;
}) {
  const [enabled, setEnabled] = useState<boolean>(!!agent.acp_enabled);
  const [backend, setBackend] = useState<AcpBackend | null>(agent.acp_backend);
  const [sessionId, setSessionId] = useState<string | null>(agent.acp_session_id);
  const [workflowRole, setWorkflowRole] = useState<WorkflowRole | null>(agent.workflow_role);
  const [permissionMode, setPermissionMode] = useState<AcpPermissionMode>(agent.acp_permission_mode ?? 'bypass');
  const [boundaryTemplate, setBoundaryTemplate] = useState<BoundaryTemplate>('custom');
  const [runtimeBackend, setRuntimeBackend] = useState<AgentRuntimeBackend | null>(agent.runtime_backend ?? 'acp');
  const [toolPolicy, setToolPolicy] = useState<AgentToolCapability[]>(agent.tool_policy?.allowed ?? ['read_files']);
  const [workspaceWriteInput, setWorkspaceWriteInput] = useState(
    formatPathList(agent.workspace_policy?.write ?? []),
  );
  const [memoryScope, setMemoryScope] = useState<AgentMemoryScope | null>(agent.memory_scope ?? 'room');
  const [removeImpact, setRemoveImpact] = useState<{
    error: string;
    active_run_count?: number;
    open_task_count?: number;
    historical_run_count?: number;
    message_count?: number;
  } | null>(null);
  const [transferTargetId, setTransferTargetId] = useState('');
  const queryClient = useQueryClient();
  const { formatRelativeTime, t, workflowRoleLabel } = useI18n();
  const transferTargets = roomAgents.filter((item) => item.id !== agent.id && !item.left_at);

  useEffect(() => {
    setEnabled(!!agent.acp_enabled);
    setBackend(agent.acp_backend);
    setSessionId(agent.acp_session_id);
    setWorkflowRole(agent.workflow_role);
    setPermissionMode(agent.acp_permission_mode ?? 'bypass');
    setBoundaryTemplate('custom');
    setRuntimeBackend(agent.runtime_backend ?? 'acp');
    setToolPolicy(agent.tool_policy?.allowed ?? ['read_files']);
    setWorkspaceWriteInput(formatPathList(agent.workspace_policy?.write ?? []));
    setMemoryScope(agent.memory_scope ?? 'room');
    setRemoveImpact(null);
    setTransferTargetId('');
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
        runtime_backend: runtimeBackend,
        tool_policy: { allowed: toolPolicy },
        workspace_policy: { read: ['.'], write: parsePathList(workspaceWriteInput) },
        memory_scope: memoryScope,
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

  function applyBoundaryTemplate(template: BoundaryTemplate) {
    setBoundaryTemplate(template);
    if (template === 'custom') return;
    const next = BOUNDARY_TEMPLATES[template];
    setPermissionMode(next.permissionMode);
    setRuntimeBackend(next.runtimeBackend);
    setToolPolicy(next.tools);
    setWorkspaceWriteInput(formatPathList(next.writeDirs));
    setMemoryScope(next.memoryScope);
  }

  function updateToolCapability(capability: AgentToolCapability, checked: boolean) {
    setBoundaryTemplate('custom');
    setToolPolicy((current) => {
      if (checked) return current.includes(capability) ? current : [...current, capability];
      return current.filter((item) => item !== capability);
    });
  }
  const remove = useMutation({
    mutationFn: (input?: { task_action?: 'unassign' | 'transfer'; transfer_to_room_agent_id?: string }) =>
      api.removeRoomAgent(roomId, agent.id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['room-agents', roomId] });
      queryClient.invalidateQueries({ queryKey: ['room-tasks', roomId] });
      toast.success('智能体已移出当前群聊');
      onClose();
    },
    onError: (err) => {
      const impact = parseRemoveImpact((err as Error).message);
      if (impact) {
        setRemoveImpact(impact);
        if (!transferTargetId && transferTargets[0]) setTransferTargetId(transferTargets[0].id);
        if (impact.error === 'agent has active runs') {
          toast.error('该智能体有运行中的任务，暂时不能移出');
        } else {
          toast.error('该智能体还有未完成任务，请先选择处理方式');
        }
        return;
      }
      toast.error((err as Error).message);
    },
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
                        onClick={() => {
                          setBoundaryTemplate('custom');
                          setPermissionMode(mode.id);
                        }}
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
                  <div className="mt-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2">
                    <div className="font-display text-[12px] font-medium uppercase tracking-wider text-[var(--color-fg-muted)]">
                      {t('acp.currentProjectDir')}
                    </div>
                    <div className="mt-1 break-all font-mono text-[11.5px] text-[var(--color-fg)]">
                      {projectPath || t('acp.currentProjectDirUnknown')}
                    </div>
                    <div className="mt-2 text-[11.5px] text-[var(--color-fg-muted)]">
                      {t(backend === 'claudecode' ? 'acp.currentProjectDirHelp.claudecode' : 'acp.currentProjectDirHelp.codex')}
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
                  {t('acp.boundaryLabel')}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {(['readOnly', 'backend', 'frontend', 'custom'] as const).map((template) => {
                    const selected = boundaryTemplate === template;
                    return (
                      <button
                        type="button"
                        key={template}
                        onClick={() => applyBoundaryTemplate(template)}
                        className={cn(
                          'surface-1 min-h-9 rounded-md px-2.5 py-2 text-left text-[12px] ease-ocean transition-all',
                          selected
                            ? 'border-[var(--color-primary)] glow-primary'
                            : 'hover:border-[var(--color-border-strong)]',
                        )}
                      >
                        <span className="block truncate font-display font-medium">
                          {t(`acp.boundaryTemplate.${template}`)}
                        </span>
                      </button>
                    );
                  })}
                </div>

                <div className="mt-3 grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="mb-1.5 block text-[11.5px] font-medium text-[var(--color-fg-muted)]">
                      {t('acp.runtimeBackend')}
                    </span>
                    <select
                      value={runtimeBackend ?? ''}
                      onChange={(event) => {
                        setBoundaryTemplate('custom');
                        setRuntimeBackend((event.target.value || null) as AgentRuntimeBackend | null);
                      }}
                      className="surface-1 h-9 w-full rounded-md px-2 text-[12px] outline-none focus:border-[var(--color-primary)]"
                    >
                      {(['acp', 'model', 'none'] as AgentRuntimeBackend[]).map((value) => (
                        <option key={value} value={value}>
                          {t(`acp.runtimeBackend.${value}`)}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="block">
                    <span className="mb-1.5 block text-[11.5px] font-medium text-[var(--color-fg-muted)]">
                      {t('acp.memoryScope')}
                    </span>
                    <select
                      value={memoryScope ?? ''}
                      onChange={(event) => {
                        setBoundaryTemplate('custom');
                        setMemoryScope((event.target.value || null) as AgentMemoryScope | null);
                      }}
                      className="surface-1 h-9 w-full rounded-md px-2 text-[12px] outline-none focus:border-[var(--color-primary)]"
                    >
                      {MEMORY_SCOPES.map((scope) => (
                        <option key={scope} value={scope}>
                          {t(`acp.memoryScope.${scope}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="mt-3">
                  <div className="mb-2 text-[11.5px] font-medium text-[var(--color-fg-muted)]">
                    {t('acp.toolPolicy')}
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {TOOL_CAPABILITIES.map((capability) => (
                      <label
                        key={capability}
                        className="surface-1 flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-[11.5px]"
                      >
                        <input
                          type="checkbox"
                          checked={toolPolicy.includes(capability)}
                          onChange={(event) => updateToolCapability(capability, event.target.checked)}
                          className="h-3.5 w-3.5 shrink-0 accent-[var(--color-primary)]"
                        />
                        <span className="min-w-0 truncate">{t(`acp.tool.${capability}`)}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <label className="mt-3 block">
                  <span className="mb-1.5 block text-[11.5px] font-medium text-[var(--color-fg-muted)]">
                    {t('acp.writableDirs')}
                  </span>
                  <textarea
                    value={workspaceWriteInput}
                    onChange={(event) => {
                      setBoundaryTemplate('custom');
                      setWorkspaceWriteInput(event.target.value);
                    }}
                    rows={3}
                    placeholder="packages/frontend, docs"
                    className="surface-1 w-full resize-y rounded-md px-2.5 py-2 font-mono text-[12px] outline-none focus:border-[var(--color-primary)]"
                  />
                  <span className="mt-1 block text-[11px] text-[var(--color-fg-muted)]">
                    {t('acp.writableDirsHelp')}
                  </span>
                </label>
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
        <div className="mr-auto flex max-w-[70%] flex-wrap items-center gap-2">
          <Button variant="danger" onClick={() => remove.mutate(undefined)} disabled={remove.isPending}>
            <Trash2 className="h-3.5 w-3.5" />
            {remove.isPending ? '移出中...' : '移出群聊'}
          </Button>
          {removeImpact && (
            <span className="inline-flex items-center gap-1 text-[11px] text-[var(--color-fg-muted)]">
              <AlertTriangle className="h-3 w-3 text-[var(--color-danger)]" />
              {removeImpact.error === 'agent has active runs'
                ? `运行中：${removeImpact.active_run_count ?? 0}`
                : `未完成任务：${removeImpact.open_task_count ?? 0}`}
            </span>
          )}
          {removeImpact?.error === 'agent has open tasks' && (
            <>
              <Button variant="secondary" onClick={() => remove.mutate({ task_action: 'unassign' })} disabled={remove.isPending}>
                清空负责人
              </Button>
              <select
                value={transferTargetId}
                onChange={(event) => setTransferTargetId(event.target.value)}
                className="surface-1 h-9 min-w-[150px] rounded-md px-2 text-[12px] outline-none focus:border-[var(--color-primary)]"
              >
                {transferTargets.map((item) => (
                  <option key={item.id} value={item.id}>{item.agent_name}</option>
                ))}
              </select>
              <Button
                variant="secondary"
                onClick={() => remove.mutate({
                  task_action: 'transfer',
                  transfer_to_room_agent_id: transferTargetId,
                })}
                disabled={remove.isPending || !transferTargetId}
              >
                转交并移出
              </Button>
            </>
          )}
        </div>
        <Button variant="ghost" onClick={onClose} disabled={remove.isPending}>{t('common.cancel')}</Button>
        <Button onClick={() => save.mutate()} disabled={save.isPending || remove.isPending}>
          {save.isPending ? t('acp.saving') : t('common.apply')}
        </Button>
      </footer>
    </div>
  );
}

function parseRemoveImpact(message: string): {
  error: string;
  active_run_count?: number;
  open_task_count?: number;
  historical_run_count?: number;
  message_count?: number;
} | null {
  const jsonStart = message.indexOf('{');
  if (jsonStart < 0) return null;
  try {
    const parsed = JSON.parse(message.slice(jsonStart)) as {
      error?: string;
      active_run_count?: number;
      open_task_count?: number;
      historical_run_count?: number;
      message_count?: number;
    };
    if (parsed.error === 'agent has active runs' || parsed.error === 'agent has open tasks') return parsed as {
      error: string;
      active_run_count?: number;
      open_task_count?: number;
      historical_run_count?: number;
      message_count?: number;
    };
    return null;
  } catch {
    return null;
  }
}

function parsePathList(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function formatPathList(value: string[]): string {
  return value.join('\n');
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
