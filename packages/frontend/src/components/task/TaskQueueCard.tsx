import { ArrowRight, LocateFixed, Play } from 'lucide-react';
import type { RoomAgent, Task, WorkflowRun } from '../../lib/types';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';
import { taskProgressPercent } from './taskWorkspaceModel';

const QUEUE_NEXT_STATUS: Partial<Record<Task['status'], Task['status']>> = {
  todo: 'in_progress',
  in_progress: 'review',
  review: 'done',
};

const QUEUE_ACTIVE_WORKFLOW_STATUSES = new Set<WorkflowRun['status']>([
  'draft',
  'running',
  'awaiting_decision',
  'awaiting_approval',
  'blocked',
]);

const QUEUE_PRIORITY_TONE: Record<Task['priority'], string> = {
  low: 'text-[var(--color-muted)]',
  normal: 'text-[var(--color-fg-muted)]',
  high: 'text-[var(--color-warning)]',
  urgent: 'text-[var(--color-danger)]',
};

export interface TaskQueueCardProps {
  task: Task;
  agent?: RoomAgent;
  workflow?: WorkflowRun;
  selected: boolean;
  statusLabel: string;
  priorityLabel: string;
  workflowStatusLabel: (status: WorkflowRun['status']) => string;
  nextStatusLabel: (status: Task['status']) => string;
  updatedLabel: string;
  unassignedLabel: string;
  markFailedLabel: string;
  startWorkflowLabel: string;
  locateSourceLabel: string;
  onSelect: () => void;
  onChangeStatus: (status: Task['status']) => void;
  onStartWorkflow?: () => void;
  onLocateSourceMessage?: () => void;
  startingWorkflow?: boolean;
}

export function TaskQueueCard({
  task,
  agent,
  workflow,
  selected,
  statusLabel,
  priorityLabel,
  workflowStatusLabel,
  nextStatusLabel,
  updatedLabel,
  unassignedLabel,
  markFailedLabel,
  startWorkflowLabel,
  locateSourceLabel,
  onSelect,
  onChangeStatus,
  onStartWorkflow,
  onLocateSourceMessage,
  startingWorkflow,
}: TaskQueueCardProps): JSX.Element {
  const nextStatus = QUEUE_NEXT_STATUS[task.status];
  const hasActiveWorkflow = workflow ? QUEUE_ACTIVE_WORKFLOW_STATUSES.has(workflow.status) : false;
  const canStartWorkflow = !hasActiveWorkflow && task.status !== 'done';
  const progress = taskProgressPercent(task.status);

  return (
    <article
      className={cn('task-card task-list-item task-queue-card', selected && 'is-selected')}
      data-active={selected ? 'true' : undefined}
    >
      <button type="button" onClick={onSelect} className="block w-full text-left">
        <div className="task-card-kicker">
          <span>#{task.id.slice(0, 6)}</span>
          <time>{updatedLabel}</time>
        </div>
        <div className="flex items-start gap-2">
          <h4 className="min-w-0 flex-1 font-display text-[12.5px] font-semibold leading-snug">
            {task.title}
          </h4>
          <span className={cn('text-[10px] font-mono flex-shrink-0', QUEUE_PRIORITY_TONE[task.priority])}>
            {priorityLabel}
          </span>
        </div>
        {task.description && (
          <p className="mt-1.5 line-clamp-2 text-[11.5px] leading-relaxed text-[var(--color-fg-muted)]">
            {task.description}
          </p>
        )}
        <div className="task-card-meta-grid">
          <TaskQueueMeta label="Status" value={statusLabel} />
          <TaskQueueMeta label="Owner" value={agent?.agent_name ?? unassignedLabel} />
          <TaskQueueMeta label="Priority" value={priorityLabel} valueClassName={QUEUE_PRIORITY_TONE[task.priority]} />
          <TaskQueueMeta label="Time" value={updatedLabel} />
        </div>
        {workflow && (
          <div className="task-card-workflow-pill">
            <span>Workflow</span>
            <strong>{workflowStatusLabel(workflow.status)}</strong>
          </div>
        )}
        <div className="task-card-progress-label">
          <span>Progress</span>
          <strong>{progress}%</strong>
        </div>
        <div className="task-card-progress" aria-hidden="true">
          <i style={{ width: `${progress}%` }} />
        </div>
      </button>
      <div className="task-card-actions">
        {canStartWorkflow && onStartWorkflow && (
          <Button size="sm" variant="secondary" onClick={onStartWorkflow} disabled={startingWorkflow} title={startWorkflowLabel} aria-label={startWorkflowLabel} className="w-7 px-0">
            <Play className={cn('h-3.5 w-3.5', startingWorkflow && 'animate-spin')} />
          </Button>
        )}
        {onLocateSourceMessage && (
          <Button size="sm" variant="secondary" onClick={onLocateSourceMessage} title={locateSourceLabel} aria-label={locateSourceLabel} className="w-7 px-0">
            <LocateFixed className="h-3.5 w-3.5" />
          </Button>
        )}
        {nextStatus && (
          <Button size="sm" variant="secondary" onClick={() => onChangeStatus(nextStatus)}>
            <ArrowRight className="h-3.5 w-3.5" />
            {nextStatusLabel(nextStatus)}
          </Button>
        )}
        {task.status !== 'failed' && (
          <Button size="sm" variant="ghost" onClick={() => onChangeStatus('failed')}>
            {markFailedLabel}
          </Button>
        )}
      </div>
    </article>
  );
}

function TaskQueueMeta({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: string;
  valueClassName?: string;
}): JSX.Element {
  return (
    <div className="task-card-meta-item">
      <span>{label}</span>
      <strong className={valueClassName}>{value}</strong>
    </div>
  );
}
