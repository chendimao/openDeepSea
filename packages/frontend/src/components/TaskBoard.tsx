import { AlertTriangle, ArrowRight, CheckCircle2, Circle, Eye, Loader2, Play } from 'lucide-react';
import type { RoomAgent, Task, WorkflowRun } from '../lib/types';
import { useI18n } from '../lib/i18n';
import { cn } from '../lib/utils';
import { AgentAvatar } from './AgentAvatar';
import { Button } from './ui/Button';

const TASK_COLUMNS: Task['status'][] = ['todo', 'in_progress', 'review', 'done', 'failed'];

const STATUS_ICON: Record<Task['status'], typeof Circle> = {
  todo: Circle,
  in_progress: Loader2,
  review: Eye,
  done: CheckCircle2,
  failed: AlertTriangle,
};

const NEXT_STATUS: Partial<Record<Task['status'], Task['status']>> = {
  todo: 'in_progress',
  in_progress: 'review',
  review: 'done',
};

const PRIORITY_TONE: Record<Task['priority'], string> = {
  low: 'text-[var(--color-muted)]',
  normal: 'text-[var(--color-fg-muted)]',
  high: 'text-[var(--color-warning)]',
  urgent: 'text-[var(--color-danger)]',
};

const ACTIVE_WORKFLOW_STATUSES = new Set<WorkflowRun['status']>([
  'draft',
  'running',
  'awaiting_decision',
  'awaiting_approval',
  'blocked',
]);

export function TaskBoard({
  tasks,
  agents,
  workflows,
  selectedTaskId,
  onSelectTask,
  onChangeStatus,
  onStartWorkflow,
  startingTaskId,
}: {
  tasks: Task[];
  agents: RoomAgent[];
  workflows?: WorkflowRun[];
  selectedTaskId?: string | null;
  onSelectTask: (task: Task) => void;
  onChangeStatus: (task: Task, status: Task['status']) => void;
  onStartWorkflow?: (task: Task) => void;
  startingTaskId?: string | null;
}) {
  const { t, taskStatusLabel } = useI18n();
  const agentMap = new Map(agents.map((agent) => [agent.id, agent]));
  const workflowByTaskId = createWorkflowByTaskId(workflows ?? []);
  const rootTasks = tasks.filter((task) => !task.parent_task_id);

  return (
    <aside className="workbench-panel task-board-panel">
      <header className="task-board-toolbar">
        <CheckCircle2 className="h-4 w-4 text-[var(--color-accent)]" strokeWidth={1.75} />
        <div className="font-display text-[13px] font-semibold">{t('taskBoard.title')}</div>
        <span className="ml-auto text-[11px] font-mono text-[var(--color-fg-muted)]">
          {rootTasks.length}
        </span>
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {TASK_COLUMNS.map((status) => {
          const columnTasks = rootTasks.filter((task) => task.status === status);
          const Icon = STATUS_ICON[status];
          if (status !== 'failed' && status !== 'done' && columnTasks.length === 0) return null;
          return (
            <section key={status} className="task-column">
              <div className="task-column-header">
                <Icon className="h-3.5 w-3.5 text-[var(--color-accent)]" strokeWidth={1.75} />
                <h3 className="font-display text-[12px] font-medium">{taskStatusLabel(status)}</h3>
                <span className="ml-auto text-[10.5px] font-mono text-[var(--color-muted)]">
                  {columnTasks.length}
                </span>
              </div>
              <div className="p-2 space-y-2">
                {columnTasks.length === 0 ? (
                  <div className="px-2 py-5 text-center text-[11.5px] text-[var(--color-muted)]">
                    {t('taskBoard.empty')}
                  </div>
                ) : (
                  columnTasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      agent={task.assigned_agent_id ? agentMap.get(task.assigned_agent_id) : undefined}
                      workflow={workflowByTaskId.get(task.id)}
                      selected={selectedTaskId === task.id}
                      onSelect={() => onSelectTask(task)}
                      onChangeStatus={(next) => onChangeStatus(task, next)}
                      onStartWorkflow={onStartWorkflow ? () => onStartWorkflow(task) : undefined}
                      startingWorkflow={startingTaskId === task.id}
                    />
                  ))
                )}
              </div>
            </section>
          );
        })}
      </div>
    </aside>
  );
}

function TaskCard({
  task,
  agent,
  workflow,
  selected,
  onSelect,
  onChangeStatus,
  onStartWorkflow,
  startingWorkflow,
}: {
  task: Task;
  agent?: RoomAgent;
  workflow?: WorkflowRun;
  selected?: boolean;
  onSelect: () => void;
  onChangeStatus: (status: Task['status']) => void;
  onStartWorkflow?: () => void;
  startingWorkflow?: boolean;
}) {
  const { formatRelativeTime, t, taskPriorityLabel, taskStatusLabel, workflowStatusLabel } = useI18n();
  const nextStatus = NEXT_STATUS[task.status];
  const hasActiveWorkflow = workflow ? ACTIVE_WORKFLOW_STATUSES.has(workflow.status) : false;
  const canStartWorkflow = !hasActiveWorkflow && task.status !== 'done';

  return (
    <article className={cn('task-card', selected && 'is-selected')}>
      <button type="button" onClick={onSelect} className="block w-full text-left">
        <div className="flex items-start gap-2">
          <h4 className="min-w-0 flex-1 font-display text-[12.5px] font-semibold leading-snug">
            {task.title}
          </h4>
          <span className={cn('text-[10px] font-mono flex-shrink-0', PRIORITY_TONE[task.priority])}>
            {taskPriorityLabel(task.priority)}
          </span>
        </div>
        {workflow && (
          <div className="mt-2 inline-flex max-w-full rounded-[5px] bg-white/52 px-1.5 py-0.5 text-[10px] font-mono text-[var(--color-accent)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.64)]">
            <span className="truncate">{workflowStatusLabel(workflow.status)}</span>
          </div>
        )}
        {task.description && (
          <p className="mt-1.5 line-clamp-2 text-[11.5px] leading-relaxed text-[var(--color-fg-muted)]">
            {task.description}
          </p>
        )}
        <div className="mt-3 flex items-center gap-2">
          {agent ? (
            <>
              <AgentAvatar name={agent.agent_name} size={20} active={!!agent.acp_enabled} />
              <span className="text-[11px] text-[var(--color-fg-muted)] truncate">
                {agent.agent_name}
              </span>
            </>
          ) : (
            <span className="text-[11px] text-[var(--color-muted)]">{t('common.unassigned')}</span>
          )}
          <span className="ml-auto text-[10px] font-mono text-[var(--color-muted)]">
            {formatRelativeTime(task.updated_at)}
          </span>
        </div>
      </button>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {canStartWorkflow && onStartWorkflow && (
          <Button
            size="sm"
            variant="secondary"
            onClick={onStartWorkflow}
            disabled={startingWorkflow}
            title={t('taskBoard.startWorkflow')}
            aria-label={t('taskBoard.startWorkflow')}
            className="w-7 px-0"
          >
            {startingWorkflow ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
          </Button>
        )}
        {nextStatus && (
          <Button size="sm" variant="secondary" onClick={() => onChangeStatus(nextStatus)}>
            <ArrowRight className="h-3.5 w-3.5" />
            {taskStatusLabel(nextStatus)}
          </Button>
        )}
        {task.status !== 'failed' && (
          <Button size="sm" variant="ghost" onClick={() => onChangeStatus('failed')}>
            {t('taskBoard.markFailed')}
          </Button>
        )}
      </div>
    </article>
  );
}

function createWorkflowByTaskId(workflows: WorkflowRun[]): Map<string, WorkflowRun> {
  const grouped = new Map<string, WorkflowRun[]>();
  for (const workflow of workflows) {
    grouped.set(workflow.task_id, [...(grouped.get(workflow.task_id) ?? []), workflow]);
  }

  const byTaskId = new Map<string, WorkflowRun>();
  for (const [taskId, taskWorkflows] of grouped) {
    const sorted = [...taskWorkflows].sort((a, b) => b.created_at - a.created_at);
    byTaskId.set(taskId, sorted.find((workflow) => ACTIVE_WORKFLOW_STATUSES.has(workflow.status)) ?? sorted[0]);
  }
  return byTaskId;
}
