import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Box, ChevronRight, Clock3, FileDiff, ListChecks, LocateFixed, Radio, ServerCog, Terminal, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { useI18n, type MessageKey } from '../lib/i18n';
import type { MessageLayer, RoomAgent, Task, TaskEvent, TaskExecutorListItem } from '../lib/types';
import { AgentAvatar } from './AgentAvatar';
import { Button } from './ui/Button';
import { Label } from './ui/Input';

export type TaskDetailView = 'plan' | 'timeline' | 'diff' | 'logs';
export type TaskLayerVisibility = Record<MessageLayer, boolean>;

const TASK_DETAIL_VIEWS: Array<{ id: TaskDetailView; labelKey: MessageKey; icon: typeof ListChecks }> = [
  { id: 'plan', labelKey: 'taskDetail.view.plan', icon: ListChecks },
  { id: 'timeline', labelKey: 'taskDetail.view.timeline', icon: Clock3 },
  { id: 'diff', labelKey: 'taskDetail.view.diff', icon: FileDiff },
  { id: 'logs', labelKey: 'taskDetail.view.logs', icon: Terminal },
];

const TASK_LAYER_FILTERS: MessageLayer[] = ['activity', 'timeline', 'runtime', 'diff'];
const PLAN_EVENT_TYPES = new Set<TaskEvent['type']>([
  'plan_proposed',
  'workflow_plan_ready',
  'workflow_assignment_created',
]);

export function selectTaskDetailEvents(
  events: TaskEvent[],
  layerVisibility: TaskLayerVisibility,
): {
  visibleEvents: TaskEvent[];
  planEvents: TaskEvent[];
  timelineEvents: TaskEvent[];
  diffEvents: TaskEvent[];
  logEvents: TaskEvent[];
} {
  const visibleEvents = events.filter((event) => layerVisibility[event.layer]);
  return {
    visibleEvents,
    planEvents: visibleEvents.filter((event) => PLAN_EVENT_TYPES.has(event.type)),
    timelineEvents: visibleEvents.filter((event) => event.layer === 'activity' || event.layer === 'timeline'),
    diffEvents: visibleEvents.filter((event) => event.layer === 'diff'),
    logEvents: visibleEvents.filter((event) => event.layer === 'runtime'),
  };
}

export function TaskDetailPanel({
  task,
  agents,
  layerVisibility,
  onLocateSourceMessage,
  onLayerVisibilityChange,
  onClose,
}: {
  task: Task | null;
  agents: RoomAgent[];
  layerVisibility: TaskLayerVisibility;
  onLocateSourceMessage?: (messageId: string, task: Task) => void;
  onLayerVisibilityChange: (layer: MessageLayer, visible: boolean) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { formatRelativeTime, interactionModeLabel, t, taskPriorityLabel, taskStatusLabel } = useI18n();
  const [activeView, setActiveView] = useState<TaskDetailView>('plan');
  const assignedAgent = task?.assigned_agent_id
    ? agents.find((agent) => agent.id === task.assigned_agent_id)
    : undefined;
  const { data: eventResponse } = useQuery({
    queryKey: ['room-task-events', task?.room_id, task?.id],
    queryFn: () => api.listRoomTaskEvents(task!.room_id, { taskId: task!.id, limit: 80 }),
    enabled: !!task,
  });
  const { data: executors = [], isLoading: executorsLoading } = useQuery({
    queryKey: ['task-executors', task?.id],
    queryFn: () => api.listTaskExecutors(task!.id),
    enabled: !!task,
  });
  const events = eventResponse?.events ?? [];
  const { visibleEvents, planEvents, timelineEvents, diffEvents, logEvents } =
    selectTaskDetailEvents(events, layerVisibility);

  const update = useMutation({
    mutationFn: (patch: Partial<Pick<Task, 'status' | 'priority' | 'interaction_mode' | 'assigned_agent_id'>>) =>
      api.updateTask(task!.id, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['room-tasks', task?.room_id] });
      toast.success(t('taskDetail.updated'));
    },
    onError: (err) => toast.error((err as Error).message),
  });

  if (!task) {
    return (
      <aside className="inspector-panel" aria-label={t('taskDetail.panel')}>
        <header className="inspector-header">
          <div className="min-w-0">
            <div className="font-display text-[14px] font-semibold">Workflow Inspector</div>
            <div className="mt-1 text-[11px] font-mono text-[var(--color-fg-muted)]">
              {t('taskDetail.waitingSelection')}
            </div>
          </div>
        </header>
        <div className="flex flex-1 items-center justify-center px-7 text-center">
          <div>
            <Box className="mx-auto h-8 w-8 text-[var(--color-muted)]" strokeWidth={1.6} />
            <div className="mt-3 font-display text-[13px] font-semibold">{t('taskDetail.noTask')}</div>
            <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-fg-muted)]">
              {t('taskDetail.emptyDescription')}
            </p>
          </div>
        </div>
      </aside>
    );
  }

  return (
    <aside className="inspector-panel fade-up" aria-label={t('taskDetail.panel')}>
      <header className="inspector-header">
        <div className="min-w-0">
          <div className="truncate font-display text-[14px] font-semibold leading-snug">{task.title}</div>
          <div className="mt-1 flex items-center gap-2 text-[11px] font-mono text-[var(--color-fg-muted)]">
            <span>{taskStatusLabel(task.status)}</span>
            <span>·</span>
            <span>{taskPriorityLabel(task.priority)}</span>
          </div>
        </div>
        <button
          onClick={onClose}
          aria-label={t('common.close')}
          type="button"
          className="ml-auto rounded-md p-1 text-[var(--color-fg-muted)] transition-colors ease-ocean hover:bg-white/45 hover:text-[var(--color-fg)]"
        >
          <XCircle className="h-4 w-4" />
        </button>
      </header>

      <div className="inspector-content">
        <TaskDetailViewTabs activeView={activeView} onChange={setActiveView} t={t} />

        <TaskLayerToggles
          layerVisibility={layerVisibility}
          onChange={onLayerVisibilityChange}
          t={t}
        />

        <section className="inspector-section">
          <Label>{t('taskDetail.basicInfo')}</Label>
          <div className="glass-info-card space-y-3">
            <InfoRow label={t('taskDetail.taskId')} value={`#${task.id.slice(0, 6)}`} />
            <InfoRow label={t('taskDetail.status')} value={taskStatusLabel(task.status)} />
            <InfoRow label={t('taskDetail.priority')} value={taskPriorityLabel(task.priority)} />
            <InfoRow label={t('taskDetail.assignee')} value={assignedAgent?.agent_name ?? t('common.unassigned')} />
            {task.source_message_id && onLocateSourceMessage && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="mt-1 w-full justify-center"
                onClick={() => onLocateSourceMessage(task.source_message_id!, task)}
              >
                <LocateFixed className="h-3.5 w-3.5" />
                {t('taskBoard.locateSourceMessage')}
              </Button>
            )}
          </div>
        </section>

        <section className="inspector-section">
          <Label>{t('taskDetail.description')}</Label>
          <div className="glass-info-card min-h-[76px] whitespace-pre-wrap px-3 py-2.5 text-[13px] leading-relaxed">
            {task.description || t('taskDetail.noDescription')}
          </div>
        </section>

        <TaskExecutorSessions executors={executors} isLoading={executorsLoading} t={t} />

        {activeView === 'plan' && (
          <TaskPlanView task={task} events={planEvents} formatRelativeTime={formatRelativeTime} t={t} />
        )}

        {activeView === 'timeline' && (
          <section className="inspector-section">
            <Label>{t('taskDetail.timeline')}</Label>
            <TaskEventTimeline
              events={timelineEvents}
              emptyKey={visibleEvents.length === 0 ? 'taskDetail.noVisibleEvents' : 'taskDetail.noTimelineEvents'}
              formatRelativeTime={formatRelativeTime}
              t={t}
            />
          </section>
        )}

        {activeView === 'diff' && (
          <section className="inspector-section">
            <Label>{t('taskDetail.diff')}</Label>
            <TaskEventTimeline
              events={diffEvents}
              emptyKey={layerVisibility.diff ? 'taskDetail.noDiffEvents' : 'taskDetail.diffHidden'}
              formatRelativeTime={formatRelativeTime}
              t={t}
            />
          </section>
        )}

        {activeView === 'logs' && (
          <section className="inspector-section">
            <Label>{t('taskDetail.logs')}</Label>
            <TaskEventTimeline
              events={logEvents}
              emptyKey={layerVisibility.runtime ? 'taskDetail.noLogEvents' : 'taskDetail.logsHidden'}
              formatRelativeTime={formatRelativeTime}
              t={t}
            />
          </section>
        )}

        <section className="inspector-section grid grid-cols-2 gap-3">
          <div>
            <Label>{t('taskDetail.status')}</Label>
            <select
              value={task.status}
              onChange={(e) => update.mutate({ status: e.target.value as Task['status'] })}
              className="glass-select"
              disabled={update.isPending}
            >
              {(['todo', 'in_progress', 'review', 'done', 'failed'] as const).map((status) => (
                <option key={status} value={status}>
                  {taskStatusLabel(status)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label>{t('taskDetail.priority')}</Label>
            <select
              value={task.priority}
              onChange={(e) => update.mutate({ priority: e.target.value as Task['priority'] })}
              className="glass-select"
              disabled={update.isPending}
            >
              {(['low', 'normal', 'high', 'urgent'] as const).map((priority) => (
                <option key={priority} value={priority}>
                  {taskPriorityLabel(priority)}
                </option>
              ))}
            </select>
          </div>
        </section>

        <section className="inspector-section">
          <Label>{t('taskDetail.interactionMode')}</Label>
          <select
            value={task.interaction_mode}
            onChange={(e) => update.mutate({ interaction_mode: e.target.value as Task['interaction_mode'] })}
            className="glass-select"
            disabled={update.isPending}
          >
            {(['ask_user', 'auto_recommended'] as const).map((mode) => (
              <option key={mode} value={mode}>
                {interactionModeLabel(mode)}
              </option>
            ))}
          </select>
        </section>

        <section className="inspector-section">
          <Label>{t('taskDetail.assignedAgent')}</Label>
          <select
            value={task.assigned_agent_id ?? ''}
            onChange={(e) => update.mutate({ assigned_agent_id: e.target.value || null })}
            className="glass-select"
            disabled={update.isPending}
          >
            <option value="">{t('common.unassigned')}</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.agent_name}
              </option>
            ))}
          </select>
          {assignedAgent && (
            <div className="mt-3 flex items-center gap-2 rounded-lg bg-white/45 p-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.65)]">
              <AgentAvatar name={assignedAgent.agent_name} size={28} active={!!assignedAgent.acp_enabled} />
              <div className="min-w-0">
                <div className="font-display text-[12.5px] font-semibold truncate">
                  {assignedAgent.agent_name}
                </div>
                <div className="font-mono text-[10.5px] text-[var(--color-muted)] truncate">
                  {assignedAgent.agent_id}
                </div>
              </div>
            </div>
          )}
        </section>

        <section className="inspector-section grid grid-cols-2 gap-3 text-[11px] font-mono text-[var(--color-fg-muted)]">
          <div className="glass-info-card rounded-lg p-3">
            <div className="text-[var(--color-muted)] mb-1">{t('taskDetail.createdAt')}</div>
            <div>{formatRelativeTime(task.created_at)}</div>
          </div>
          <div className="glass-info-card rounded-lg p-3">
            <div className="text-[var(--color-muted)] mb-1">{t('taskDetail.completedAt')}</div>
            <div>{task.completed_at ? formatRelativeTime(task.completed_at) : t('taskDetail.notCompleted')}</div>
          </div>
        </section>
      </div>

      <footer className="inspector-footer">
        <Button variant="danger" onClick={onClose}>
          {t('common.close')}
        </Button>
      </footer>
    </aside>
  );
}

export function TaskEventTimeline({
  events,
  emptyKey = 'taskDetail.noEvents',
  formatRelativeTime,
  t,
}: {
  events: TaskEvent[];
  emptyKey?: MessageKey;
  formatRelativeTime: (timestamp: number) => string;
  t: (key: MessageKey, values?: Record<string, string | number>) => string;
}): JSX.Element {
  if (events.length === 0) {
    return (
      <div className="glass-info-card flex min-h-[96px] items-center gap-3 text-[12px] text-[var(--color-fg-muted)]">
        <Radio className="h-4 w-4 shrink-0 text-[var(--color-muted)]" strokeWidth={1.8} />
        <span>{t(emptyKey)}</span>
      </div>
    );
  }

  return (
    <div className="task-event-timeline glass-info-card">
      {events.map((event) => (
        <div key={event.id} className="task-event-row">
          <span className="task-event-dot" data-layer={event.layer} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[12.5px] font-semibold text-[var(--color-fg)]">
                {eventTitle(event, t)}
              </span>
              <span className="shrink-0 font-mono text-[10.5px] text-[var(--color-muted)]">
                {formatRelativeTime(event.created_at)}
              </span>
            </div>
            <div className="mt-1 text-[11.5px] leading-relaxed text-[var(--color-fg-muted)]">
              {describeTaskEvent(event, t)}
            </div>
            <TaskEventPayloadDetails event={event} />
          </div>
        </div>
      ))}
    </div>
  );
}

function TaskDetailViewTabs({
  activeView,
  onChange,
  t,
}: {
  activeView: TaskDetailView;
  onChange: (view: TaskDetailView) => void;
  t: (key: MessageKey, values?: Record<string, string | number>) => string;
}): JSX.Element {
  return (
    <div className="task-detail-tabs segmented-control" aria-label={t('taskDetail.views')}>
      {TASK_DETAIL_VIEWS.map((view) => {
        const Icon = view.icon;
        const selected = activeView === view.id;
        return (
          <button
            key={view.id}
            type="button"
            className={selected ? 'is-active' : undefined}
            aria-pressed={selected}
            onClick={() => onChange(view.id)}
          >
            <Icon className="h-3.5 w-3.5" strokeWidth={1.8} />
            <span>{t(view.labelKey)}</span>
          </button>
        );
      })}
    </div>
  );
}

export function TaskLayerToggles({
  layerVisibility,
  onChange,
  t,
}: {
  layerVisibility: TaskLayerVisibility;
  onChange: (layer: MessageLayer, visible: boolean) => void;
  t: (key: MessageKey, values?: Record<string, string | number>) => string;
}): JSX.Element {
  return (
    <div className="task-layer-toggles" aria-label={t('taskDetail.layers')}>
      {TASK_LAYER_FILTERS.map((layer) => (
        <label key={layer} className="task-layer-toggle">
          <input
            type="checkbox"
            checked={layerVisibility[layer]}
            onChange={(event) => onChange(layer, event.currentTarget.checked)}
          />
          <span className="task-event-dot" data-layer={layer} />
          <span>{eventLayerLabel(layer, t)}</span>
        </label>
      ))}
    </div>
  );
}

export function TaskExecutorSessions({
  executors,
  isLoading,
  t,
}: {
  executors: TaskExecutorListItem[];
  isLoading: boolean;
  t: (key: MessageKey, values?: Record<string, string | number>) => string;
}): JSX.Element {
  return (
    <section className="inspector-section">
      <Label>{t('taskDetail.executors')}</Label>
      <div className="task-executor-list glass-info-card">
        {isLoading && (
          <div className="task-executor-empty">
            <ServerCog className="h-4 w-4 shrink-0 text-[var(--color-muted)]" strokeWidth={1.8} />
            <span>{t('taskDetail.executorsLoading')}</span>
          </div>
        )}

        {!isLoading && executors.length === 0 && (
          <div className="task-executor-empty">
            <ServerCog className="h-4 w-4 shrink-0 text-[var(--color-muted)]" strokeWidth={1.8} />
            <span>{t('taskDetail.noExecutors')}</span>
          </div>
        )}

        {!isLoading && executors.map((executor) => (
          <div key={executor.id} className="task-executor-row">
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[12.5px] font-semibold text-[var(--color-fg)]">
                  {executor.agent_name ?? executor.agent_id}
                </span>
                <span className="task-executor-status" data-status={executor.status}>
                  {taskExecutorStatusLabel(executor.status, t)}
                </span>
              </div>
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10.5px] text-[var(--color-muted)]">
                <span className="truncate">{executor.acp_backend ?? t('taskDetail.executorBackendUnknown')}</span>
                <span>·</span>
                <span className="truncate">
                  {executor.acp_session_id ? shortSessionId(executor.acp_session_id) : t('taskDetail.noSession')}
                </span>
              </div>
              {executor.acp_session_handoff_pending === 1 && (
                <div className="mt-2 rounded bg-[var(--color-warning-soft)] px-2 py-1 text-[10.5px] font-semibold text-[var(--color-warning)]">
                  {t('taskExecutor.handoffPending')}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function TaskPlanView({
  task,
  events,
  formatRelativeTime,
  t,
}: {
  task: Task;
  events: TaskEvent[];
  formatRelativeTime: (timestamp: number) => string;
  t: (key: MessageKey, values?: Record<string, string | number>) => string;
}): JSX.Element {
  return (
    <section className="inspector-section">
      <Label>{t('taskDetail.plan')}</Label>
      <div className="task-plan-summary glass-info-card">
        <InfoRow label={t('taskDetail.status')} value={t(`task.status.${task.status}` as MessageKey)} />
        <InfoRow label={t('taskDetail.interactionModeShort')} value={t(`task.interaction.${task.interaction_mode}` as MessageKey)} />
        <InfoRow label={t('taskDetail.origin')} value={task.created_from ?? t('taskDetail.originUnknown')} />
      </div>
      <div className="mt-3">
        <TaskEventTimeline
          events={events}
          emptyKey="taskDetail.noPlanEvents"
          formatRelativeTime={formatRelativeTime}
          t={t}
        />
      </div>
    </section>
  );
}

function eventTitle(event: TaskEvent, t: (key: MessageKey) => string): string {
  const key = `taskEvent.${event.type}` as MessageKey;
  const translated = t(key);
  return translated === key ? event.type : translated;
}

export function describeTaskEvent(event: TaskEvent, t: (key: MessageKey) => string): string {
  const payload = event.payload;
  if (event.type === 'message_routed' || event.type === 'message_route_uncertain') {
    const routeReason = readString(payload.route_reason) ?? readString(payload.reason);
    const routeConfidence = readNumber(payload.route_confidence);
    const confidenceSummary = routeConfidence !== null ? `${Math.round(routeConfidence * 100)}%` : null;
    const summary = compactJoin([routeReason, confidenceSummary], ' · ');
    if (summary) return summary;
  }
  if (event.type === 'diff_detected') {
    const path = readString(payload.path);
    const additions = readNumber(payload.additions);
    const deletions = readNumber(payload.deletions);
    const stats = compactJoin([
      additions !== null ? `+${additions}` : null,
      deletions !== null ? `-${deletions}` : null,
    ], ' / ');
    const summary = compactJoin([path, stats], ' · ');
    if (summary) return summary;
  }
  if (event.type === 'runtime_event') {
    const command = readString(payload.command);
    if (command) return command;
    const toolName = readString(payload.name) ?? readString(payload.tool_name);
    const inputSummary = summarizeRuntimeInput(payload.input);
    const summary = compactJoin([toolName, inputSummary], ' · ');
    if (summary) return summary;
  }
  const values = [
    payload.reason,
    payload.route_action,
    payload.status,
    payload.summary,
    payload.title,
    payload.message_id ? `${t('taskDetail.messageRef')} ${String(payload.message_id).slice(0, 6)}` : null,
  ];
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)
    ?? eventLayerLabel(event.layer, t);
}

function TaskEventPayloadDetails({ event }: { event: TaskEvent }): JSX.Element | null {
  if (event.type === 'diff_detected') {
    const diff = readString(event.payload.diff) ?? readString(event.payload.patch);
    if (!diff) return null;
    return (
      <div className="task-event-detail-block task-event-diff-block" aria-label="diff detail">
        {diff.split('\n').slice(0, 8).map((line, index) => (
          <div key={index} className={diffLineClassName(line)}>
            {line || ' '}
          </div>
        ))}
      </div>
    );
  }

  if (event.type !== 'runtime_event') return null;
  const output = readString(event.payload.output) ?? readString(event.payload.stdout) ?? readString(event.payload.stderr);
  if (!output) return null;
  return (
    <pre className="task-event-detail-block task-event-runtime-output">
      {output.length > 360 ? `${output.slice(0, 357)}...` : output}
    </pre>
  );
}

function eventLayerLabel(layer: MessageLayer, t: (key: MessageKey) => string): string {
  const key = `taskLayer.${layer}` as MessageKey;
  const translated = t(key);
  return translated === key ? layer : translated;
}

function taskExecutorStatusLabel(
  status: TaskExecutorListItem['status'],
  t: (key: MessageKey) => string,
): string {
  const key = `taskExecutor.status.${status}` as MessageKey;
  const translated = t(key);
  return translated === key ? status : translated;
}

function shortSessionId(sessionId: string): string {
  return sessionId.length > 12 ? `${sessionId.slice(0, 8)}…${sessionId.slice(-4)}` : sessionId;
}

function summarizeRuntimeInput(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      return summarizeRuntimeInput(JSON.parse(trimmed) as unknown) ?? trimmed.slice(0, 96);
    } catch {
      return trimmed.length > 96 ? `${trimmed.slice(0, 93)}...` : trimmed;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return readString(record.path)
    ?? readString(record.file)
    ?? readString(record.command)
    ?? readString(record.pattern)
    ?? null;
}

function compactJoin(values: Array<string | null>, separator: string): string {
  return values.filter((value): value is string => Boolean(value?.trim())).join(separator);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function diffLineClassName(line: string): string {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'task-event-diff-line is-added';
  if (line.startsWith('-') && !line.startsWith('---')) return 'task-event-diff-line is-removed';
  return 'task-event-diff-line';
}

function InfoRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex items-center gap-3 text-[12px]">
      <span className="w-16 shrink-0 text-[var(--color-fg-muted)]">{label}</span>
      <ChevronRight className="h-3 w-3 text-[var(--color-muted)]" strokeWidth={1.8} />
      <span className="min-w-0 truncate font-medium text-[var(--color-fg)]">{value}</span>
    </div>
  );
}
