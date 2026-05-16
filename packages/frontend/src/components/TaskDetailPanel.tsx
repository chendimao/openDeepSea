import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Box, ChevronRight, RotateCcw, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import type { RoomAgent, Task, WorkflowDetail, WorkflowRun, WorkflowStatus } from '../lib/types';
import { AgentAvatar } from './AgentAvatar';
import { MemoryPanel } from './MemoryPanel';
import { WorkflowTimeline } from './WorkflowTimeline';
import { Button } from './ui/Button';
import { Label } from './ui/Input';

const ACTIVE_WORKFLOW_STATUSES = new Set<WorkflowStatus>([
  'draft',
  'running',
  'awaiting_decision',
  'awaiting_approval',
  'blocked',
]);

export function TaskDetailPanel({
  task,
  agents,
  projectId,
  onClose,
}: {
  task: Task | null;
  agents: RoomAgent[];
  projectId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { formatRelativeTime, interactionModeLabel, t, taskPriorityLabel, taskStatusLabel } = useI18n();
  const assignedAgent = task?.assigned_agent_id
    ? agents.find((agent) => agent.id === task.assigned_agent_id)
    : undefined;
  const { data: workflows = [] } = useQuery({
    queryKey: ['task-workflows', task?.id],
    queryFn: () => api.listTaskWorkflows(task!.id),
    enabled: !!task,
  });
  const activeWorkflow = workflows.find((workflow) => ACTIVE_WORKFLOW_STATUSES.has(workflow.status)) ?? null;
  const displayWorkflow = activeWorkflow ?? workflows[0] ?? null;
  const { data: workflowDetail = null } = useQuery({
    queryKey: ['workflow', displayWorkflow?.id],
    queryFn: () => api.getWorkflow(displayWorkflow!.id),
    enabled: !!displayWorkflow,
  });

  const refreshWorkflow = (workflow?: WorkflowRun) => {
    if (!task) return;
    queryClient.invalidateQueries({ queryKey: ['messages', task.room_id] });
    queryClient.invalidateQueries({ queryKey: ['room-tasks', task.room_id] });
    queryClient.invalidateQueries({ queryKey: ['room-workflows', task.room_id] });
    queryClient.invalidateQueries({ queryKey: ['task-workflows', task.id] });
    if (workflow?.id) queryClient.invalidateQueries({ queryKey: ['workflow', workflow.id] });
  };

  const update = useMutation({
    mutationFn: (patch: Partial<Pick<Task, 'status' | 'priority' | 'interaction_mode' | 'assigned_agent_id'>>) =>
      api.updateTask(task!.id, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['room-tasks', task?.room_id] });
      toast.success(t('taskDetail.updated'));
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const startWorkflow = useMutation({
    mutationFn: () =>
      api.startWorkflowWithConversation(task!.room_id, task!.id, {
        content: t('workflow.startIntent', { title: task!.title }),
      }),
    onSuccess: (workflow) => {
      refreshWorkflow(workflow);
      toast.success(t('taskDetail.workflowStarted'));
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const approvePlan = useMutation({
    mutationFn: (workflowId: string) =>
      api.approveWorkflowPlanWithConversation(task!.room_id, workflowId, {
        content: t('workflow.approveIntent', { title: task!.title }),
      }),
    onSuccess: (workflow) => {
      refreshWorkflow(workflow);
      toast.success(t('taskDetail.planApproved'));
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const submitDecisions = useMutation({
    mutationFn: (input: { workflowId: string; answers: Array<{ decisionId: string; optionId: string }> }) =>
      api.submitWorkflowDecisions(input.workflowId, input.answers),
    onSuccess: (workflow) => {
      refreshWorkflow(workflow);
      toast.success(t('taskDetail.decisionSubmitted'));
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const retryWorkflow = useMutation({
    mutationFn: (workflowId: string) => api.retryWorkflowStep(workflowId),
    onSuccess: (workflow) => {
      refreshWorkflow(workflow);
      toast.success(t('taskDetail.workflowRetried'));
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const cancelWorkflow = useMutation({
    mutationFn: (workflowId: string) => api.cancelWorkflow(workflowId),
    onSuccess: (workflow) => {
      refreshWorkflow(workflow);
      toast.success(t('taskDetail.workflowCancelled'));
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
          </div>
        </section>

        <section className="inspector-section">
          <Label>{t('taskDetail.description')}</Label>
          <div className="glass-info-card min-h-[76px] whitespace-pre-wrap px-3 py-2.5 text-[13px] leading-relaxed">
            {task.description || t('taskDetail.noDescription')}
          </div>
        </section>

        <section className="inspector-section">
          <MemoryPanel
            projectId={projectId}
            roomId={task.room_id}
            roomAgents={agents}
            task={task}
            defaultScope="task"
            compact
          />
        </section>

        <section className="inspector-section">
          <div className="mb-2 flex items-center justify-between gap-3">
            <Label className="mb-0">{t('taskDetail.workflow')}</Label>
            {!activeWorkflow && (
              <Button size="sm" onClick={() => startWorkflow.mutate()} disabled={startWorkflow.isPending}>
                {startWorkflow.isPending ? t('taskDetail.starting') : t('taskDetail.startWorkflow')}
              </Button>
            )}
          </div>
          <WorkflowTimeline
            detail={workflowDetail as WorkflowDetail | null}
            agents={agents}
            busy={approvePlan.isPending || submitDecisions.isPending || retryWorkflow.isPending || cancelWorkflow.isPending}
            onApprove={() => displayWorkflow && approvePlan.mutate(displayWorkflow.id)}
            onSubmitDecisions={(answers) =>
              displayWorkflow && submitDecisions.mutate({ workflowId: displayWorkflow.id, answers })
            }
            onRetry={() => displayWorkflow && retryWorkflow.mutate(displayWorkflow.id)}
            onCancel={() => displayWorkflow && cancelWorkflow.mutate(displayWorkflow.id)}
          />
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
        {displayWorkflow && (
          <Button variant="secondary" onClick={() => retryWorkflow.mutate(displayWorkflow.id)} disabled={retryWorkflow.isPending}>
            <RotateCcw className="h-3.5 w-3.5" />
            {t('common.retry')}
          </Button>
        )}
        <Button
          variant="ghost"
          onClick={() => displayWorkflow && cancelWorkflow.mutate(displayWorkflow.id)}
          disabled={!displayWorkflow || cancelWorkflow.isPending}
        >
          <XCircle className="h-3.5 w-3.5" />
          {cancelWorkflow.isPending ? t('taskDetail.canceling') : t('common.cancel')}
        </Button>
        <Button variant="danger" onClick={onClose}>
          {t('common.close')}
        </Button>
      </footer>
    </aside>
  );
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
