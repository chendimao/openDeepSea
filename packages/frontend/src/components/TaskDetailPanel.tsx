import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Box, ChevronRight, LocateFixed, Radio, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { useI18n, type MessageKey } from '../lib/i18n';
import type { MessageLayer, RoomAgent, Task, TaskEvent } from '../lib/types';
import { AgentAvatar } from './AgentAvatar';
import { Button } from './ui/Button';
import { Label } from './ui/Input';

export function TaskDetailPanel({
  task,
  agents,
  onLocateSourceMessage,
  onClose,
}: {
  task: Task | null;
  agents: RoomAgent[];
  onLocateSourceMessage?: (messageId: string, task: Task) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { formatRelativeTime, interactionModeLabel, t, taskPriorityLabel, taskStatusLabel } = useI18n();
  const assignedAgent = task?.assigned_agent_id
    ? agents.find((agent) => agent.id === task.assigned_agent_id)
    : undefined;
  const { data: eventResponse } = useQuery({
    queryKey: ['room-task-events', task?.room_id, task?.id],
    queryFn: () => api.listRoomTaskEvents(task!.room_id, { taskId: task!.id, limit: 80 }),
    enabled: !!task,
  });
  const events = eventResponse?.events ?? [];

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
      <aside className="inspector-panel">
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
    <aside className="inspector-panel fade-up">
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

        <section className="inspector-section">
          <Label>{t('taskDetail.timeline')}</Label>
          <TaskEventTimeline events={events} formatRelativeTime={formatRelativeTime} t={t} />
        </section>

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

function TaskEventTimeline({
  events,
  formatRelativeTime,
  t,
}: {
  events: TaskEvent[];
  formatRelativeTime: (timestamp: number) => string;
  t: (key: MessageKey, values?: Record<string, string | number>) => string;
}): JSX.Element {
  if (events.length === 0) {
    return (
      <div className="glass-info-card flex min-h-[96px] items-center gap-3 text-[12px] text-[var(--color-fg-muted)]">
        <Radio className="h-4 w-4 shrink-0 text-[var(--color-muted)]" strokeWidth={1.8} />
        <span>{t('taskDetail.noEvents')}</span>
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
              {eventDescription(event, t)}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function eventTitle(event: TaskEvent, t: (key: MessageKey) => string): string {
  const key = `taskEvent.${event.type}` as MessageKey;
  const translated = t(key);
  return translated === key ? event.type : translated;
}

function eventDescription(event: TaskEvent, t: (key: MessageKey) => string): string {
  const payload = event.payload;
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

function eventLayerLabel(layer: MessageLayer, t: (key: MessageKey) => string): string {
  const key = `taskLayer.${layer}` as MessageKey;
  const translated = t(key);
  return translated === key ? layer : translated;
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
