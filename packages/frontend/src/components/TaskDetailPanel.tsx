import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Box, ChevronRight, RotateCcw, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import type { RoomAgent, Task, WorkflowDetail, WorkflowRun, WorkflowStatus } from '../lib/types';
import { TASK_INTERACTION_MODE_LABEL, TASK_PRIORITY_LABEL, TASK_STATUS_LABEL } from '../lib/types';
import { relativeTime } from '../lib/utils';
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
    queryClient.invalidateQueries({ queryKey: ['task-workflows', task.id] });
    if (workflow?.id) queryClient.invalidateQueries({ queryKey: ['workflow', workflow.id] });
  };

  const update = useMutation({
    mutationFn: (patch: Partial<Pick<Task, 'status' | 'priority' | 'interaction_mode' | 'assigned_agent_id'>>) =>
      api.updateTask(task!.id, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['room-tasks', task?.room_id] });
      toast.success('任务已更新');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const startWorkflow = useMutation({
    mutationFn: () => api.startWorkflow(task!.id),
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

  if (!task) {
    return (
      <aside className="inspector-panel">
        <header className="inspector-header">
          <div className="min-w-0">
            <div className="font-display text-[14px] font-semibold">Workflow Inspector</div>
            <div className="mt-1 text-[11px] font-mono text-[var(--color-fg-muted)]">等待任务选择</div>
          </div>
        </header>
        <div className="flex flex-1 items-center justify-center px-7 text-center">
          <div>
            <Box className="mx-auto h-8 w-8 text-[var(--color-muted)]" strokeWidth={1.6} />
            <div className="mt-3 font-display text-[13px] font-semibold">暂无任务</div>
            <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-fg-muted)]">
              创建或选择任务后，这里会显示开发闭环、计划和执行产物。
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
            <span>{TASK_STATUS_LABEL[task.status]}</span>
            <span>·</span>
            <span>{TASK_PRIORITY_LABEL[task.priority]}</span>
          </div>
        </div>
        <button
          onClick={onClose}
          aria-label="关闭"
          type="button"
          className="ml-auto rounded-md p-1 text-[var(--color-fg-muted)] transition-colors ease-ocean hover:bg-white/45 hover:text-[var(--color-fg)]"
        >
          <XCircle className="h-4 w-4" />
        </button>
      </header>

      <div className="inspector-content">
        <section className="inspector-section">
          <Label>基础信息</Label>
          <div className="glass-info-card space-y-3">
            <InfoRow label="任务编号" value={`#${task.id.slice(0, 6)}`} />
            <InfoRow label="状态" value={TASK_STATUS_LABEL[task.status]} />
            <InfoRow label="优先级" value={TASK_PRIORITY_LABEL[task.priority]} />
            <InfoRow label="指派人" value={assignedAgent?.agent_name ?? '未指派'} />
          </div>
        </section>

        <section className="inspector-section">
          <Label>描述</Label>
          <div className="glass-info-card min-h-[76px] whitespace-pre-wrap px-3 py-2.5 text-[13px] leading-relaxed">
            {task.description || '暂无描述'}
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

        <section className="inspector-section grid grid-cols-2 gap-3">
          <div>
            <Label>状态</Label>
            <select
              value={task.status}
              onChange={(e) => update.mutate({ status: e.target.value as Task['status'] })}
              className="glass-select"
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
              className="glass-select"
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

        <section className="inspector-section">
          <Label>交互策略</Label>
          <select
            value={task.interaction_mode}
            onChange={(e) => update.mutate({ interaction_mode: e.target.value as Task['interaction_mode'] })}
            className="glass-select"
            disabled={update.isPending}
          >
            {(['ask_user', 'auto_recommended'] as const).map((mode) => (
              <option key={mode} value={mode}>
                {TASK_INTERACTION_MODE_LABEL[mode]}
              </option>
            ))}
          </select>
        </section>

        <section className="inspector-section">
          <Label>指派 Agent</Label>
          <select
            value={task.assigned_agent_id ?? ''}
            onChange={(e) => update.mutate({ assigned_agent_id: e.target.value || null })}
            className="glass-select"
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
            <div className="text-[var(--color-muted)] mb-1">创建</div>
            <div>{relativeTime(task.created_at)}</div>
          </div>
          <div className="glass-info-card rounded-lg p-3">
            <div className="text-[var(--color-muted)] mb-1">完成</div>
            <div>{task.completed_at ? relativeTime(task.completed_at) : '未完成'}</div>
          </div>
        </section>
      </div>

      <footer className="inspector-footer">
        {displayWorkflow && (
          <Button variant="secondary" onClick={() => retryWorkflow.mutate(displayWorkflow.id)} disabled={retryWorkflow.isPending}>
            <RotateCcw className="h-3.5 w-3.5" />
            重试
          </Button>
        )}
        <Button
          variant="ghost"
          onClick={() => displayWorkflow && cancelWorkflow.mutate(displayWorkflow.id)}
          disabled={!displayWorkflow || cancelWorkflow.isPending}
        >
          <XCircle className="h-3.5 w-3.5" />
          {cancelWorkflow.isPending ? '取消中…' : '取消'}
        </Button>
        <Button variant="danger" onClick={onClose}>
          关闭
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
