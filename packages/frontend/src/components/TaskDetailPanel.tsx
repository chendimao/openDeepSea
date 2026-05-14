import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import type { RoomAgent, Task, WorkflowDetail, WorkflowRun, WorkflowStatus } from '../lib/types';
import { TASK_INTERACTION_MODE_LABEL, TASK_PRIORITY_LABEL, TASK_STATUS_LABEL } from '../lib/types';
import { relativeTime } from '../lib/utils';
import { AgentAvatar } from './AgentAvatar';
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
  onClose,
}: {
  task: Task;
  agents: RoomAgent[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const assignedAgent = task.assigned_agent_id
    ? agents.find((agent) => agent.id === task.assigned_agent_id)
    : undefined;
  const { data: workflows = [] } = useQuery({
    queryKey: ['task-workflows', task.id],
    queryFn: () => api.listTaskWorkflows(task.id),
  });
  const activeWorkflow = workflows.find((workflow) => ACTIVE_WORKFLOW_STATUSES.has(workflow.status)) ?? null;
  const displayWorkflow = activeWorkflow ?? workflows[0] ?? null;
  const { data: workflowDetail = null } = useQuery({
    queryKey: ['workflow', displayWorkflow?.id],
    queryFn: () => api.getWorkflow(displayWorkflow!.id),
    enabled: !!displayWorkflow,
  });

  const refreshWorkflow = (workflow?: WorkflowRun) => {
    queryClient.invalidateQueries({ queryKey: ['task-workflows', task.id] });
    if (workflow?.id) queryClient.invalidateQueries({ queryKey: ['workflow', workflow.id] });
  };

  const update = useMutation({
    mutationFn: (patch: Partial<Pick<Task, 'status' | 'priority' | 'interaction_mode' | 'assigned_agent_id'>>) =>
      api.updateTask(task.id, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['room-tasks', task.room_id] });
      toast.success('任务已更新');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const startWorkflow = useMutation({
    mutationFn: () => api.startWorkflow(task.id),
    onSuccess: (workflow) => {
      refreshWorkflow(workflow);
      toast.success('开发闭环已启动');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const approvePlan = useMutation({
    mutationFn: (workflowId: string) => api.approveWorkflowPlan(workflowId),
    onSuccess: (workflow) => {
      refreshWorkflow(workflow);
      toast.success('计划已确认');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const submitDecisions = useMutation({
    mutationFn: (input: { workflowId: string; answers: Array<{ decisionId: string; optionId: string }> }) =>
      api.submitWorkflowDecisions(input.workflowId, input.answers),
    onSuccess: (workflow) => {
      refreshWorkflow(workflow);
      toast.success('决策已提交');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const retryWorkflow = useMutation({
    mutationFn: (workflowId: string) => api.retryWorkflowStep(workflowId),
    onSuccess: (workflow) => {
      refreshWorkflow(workflow);
      toast.success('已重试当前阶段');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const cancelWorkflow = useMutation({
    mutationFn: (workflowId: string) => api.cancelWorkflow(workflowId),
    onSuccess: (workflow) => {
      refreshWorkflow(workflow);
      toast.success('开发闭环已取消');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteTask(task.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['room-tasks', task.room_id] });
      toast.success('任务已删除');
      onClose();
    },
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <div className="absolute right-0 top-0 z-10 h-full w-[380px] surface-1 border-l border-[var(--color-border)] flex flex-col fade-up">
      <header className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2">
        <div className="min-w-0">
          <div className="font-display text-[14px] font-semibold truncate">{task.title}</div>
          <div className="text-[11px] font-mono text-[var(--color-fg-muted)]">
            {TASK_STATUS_LABEL[task.status]} · {TASK_PRIORITY_LABEL[task.priority]}
          </div>
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
          <Label>描述</Label>
          <div className="surface-2 rounded-lg px-3 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap min-h-[76px]">
            {task.description || '暂无描述'}
          </div>
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between gap-3">
            <Label className="mb-0">开发闭环</Label>
            {!activeWorkflow && (
              <Button size="sm" onClick={() => startWorkflow.mutate()} disabled={startWorkflow.isPending}>
                {startWorkflow.isPending ? '启动中…' : '启动闭环'}
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

        <section className="grid grid-cols-2 gap-3">
          <div>
            <Label>状态</Label>
            <select
              value={task.status}
              onChange={(e) => update.mutate({ status: e.target.value as Task['status'] })}
              className="surface-1 h-10 w-full rounded-lg px-3 text-[13px] outline-none focus:border-[var(--color-primary)] focus:glow-primary"
              disabled={update.isPending}
            >
              {(['todo', 'in_progress', 'review', 'done', 'failed'] as const).map((status) => (
                <option key={status} value={status}>
                  {TASK_STATUS_LABEL[status]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label>优先级</Label>
            <select
              value={task.priority}
              onChange={(e) => update.mutate({ priority: e.target.value as Task['priority'] })}
              className="surface-1 h-10 w-full rounded-lg px-3 text-[13px] outline-none focus:border-[var(--color-primary)] focus:glow-primary"
              disabled={update.isPending}
            >
              {(['low', 'normal', 'high', 'urgent'] as const).map((priority) => (
                <option key={priority} value={priority}>
                  {TASK_PRIORITY_LABEL[priority]}
                </option>
              ))}
            </select>
          </div>
        </section>

        <section>
          <Label>交互策略</Label>
          <select
            value={task.interaction_mode}
            onChange={(e) => update.mutate({ interaction_mode: e.target.value as Task['interaction_mode'] })}
            className="surface-1 h-10 w-full rounded-lg px-3 text-[13px] outline-none focus:border-[var(--color-primary)] focus:glow-primary"
            disabled={update.isPending}
          >
            {(['ask_user', 'auto_recommended'] as const).map((mode) => (
              <option key={mode} value={mode}>
                {TASK_INTERACTION_MODE_LABEL[mode]}
              </option>
            ))}
          </select>
        </section>

        <section>
          <Label>指派 Agent</Label>
          <select
            value={task.assigned_agent_id ?? ''}
            onChange={(e) => update.mutate({ assigned_agent_id: e.target.value || null })}
            className="surface-1 h-10 w-full rounded-lg px-3 text-[13px] outline-none focus:border-[var(--color-primary)] focus:glow-primary"
            disabled={update.isPending}
          >
            <option value="">未指派</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.agent_name}
              </option>
            ))}
          </select>
          {assignedAgent && (
            <div className="mt-3 surface-2 rounded-lg p-3 flex items-center gap-2">
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

        <section className="grid grid-cols-2 gap-3 text-[11px] font-mono text-[var(--color-fg-muted)]">
          <div className="surface-2 rounded-lg p-3">
            <div className="text-[var(--color-muted)] mb-1">创建</div>
            <div>{relativeTime(task.created_at)}</div>
          </div>
          <div className="surface-2 rounded-lg p-3">
            <div className="text-[var(--color-muted)] mb-1">完成</div>
            <div>{task.completed_at ? relativeTime(task.completed_at) : '未完成'}</div>
          </div>
        </section>
      </div>

      <footer className="px-4 py-3 border-t border-[var(--color-border)] flex justify-between gap-2">
        <Button variant="ghost" onClick={() => remove.mutate()} disabled={remove.isPending}>
          <Trash2 className="h-3.5 w-3.5" />
          {remove.isPending ? '删除中…' : '删除'}
        </Button>
        <Button variant="secondary" onClick={onClose}>
          关闭
        </Button>
      </footer>
    </div>
  );
}
