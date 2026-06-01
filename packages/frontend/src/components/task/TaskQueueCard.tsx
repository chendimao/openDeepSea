import type { Task } from '../../lib/types';
import { cn } from '../../lib/utils';

export interface TaskQueueCardProps {
  task: Task;
  selected: boolean;
  statusLabel: string;
  updatedLabel: string;
  onSelect: () => void;
}

export function TaskQueueCard({
  task,
  selected,
  statusLabel,
  updatedLabel,
  onSelect,
}: TaskQueueCardProps): JSX.Element {
  return (
    <article
      className={cn('task-card task-list-item task-queue-card', selected && 'is-selected')}
      data-active={selected ? 'true' : undefined}
    >
      <button type="button" onClick={onSelect} className="task-queue-row">
        <div className="task-queue-row-main">
          <h4>{task.title}</h4>
          <time>{updatedLabel}</time>
        </div>
        <div className="task-queue-row-meta">
          <span data-status={task.status}>{statusLabel}</span>
          <small>#{task.id.slice(0, 6)}</small>
        </div>
      </button>
    </article>
  );
}
