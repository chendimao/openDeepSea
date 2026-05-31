import type { MessageKey } from '../../lib/i18n';
import type { TaskEvent } from '../../lib/types';
import { taskEventTypeLabel } from './taskWorkspaceModel';

export interface TaskActivityFeedProps {
  events: TaskEvent[];
  emptyLabel: string;
  title: string;
  formatRelativeTime: (timestamp: number) => string;
  t: (key: MessageKey) => string;
}

export function TaskActivityFeed({
  events,
  emptyLabel,
  title,
  formatRelativeTime,
  t,
}: TaskActivityFeedProps): JSX.Element {
  return (
    <section className="task-activity-feed" aria-label={title}>
      <div className="task-activity-title">{title}</div>
      {events.length === 0 ? (
        <div className="task-activity-empty">{emptyLabel}</div>
      ) : (
        events.map((event) => (
          <div key={event.id} className="task-activity-row">
            <span className="task-event-dot" data-layer={event.layer} />
            <span className="min-w-0 flex-1 truncate">{taskEventTypeLabel(event.type, t)}</span>
            <span className="text-[10px] font-mono text-[var(--color-muted)]">
              {formatRelativeTime(event.created_at)}
            </span>
          </div>
        ))
      )}
    </section>
  );
}
