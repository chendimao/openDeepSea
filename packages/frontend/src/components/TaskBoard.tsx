import { AlertTriangle, ArrowRight, CheckCircle2, Circle, Eye, Loader2 } from 'lucide-react';
import type { RoomAgent, Task } from '../lib/types';
import { TASK_PRIORITY_LABEL, TASK_STATUS_LABEL } from '../lib/types';
import { cn, relativeTime } from '../lib/utils';
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

export function TaskBoard({
  tasks,
  agents,
  onSelectTask,
  onChangeStatus,
}: {
  tasks: Task[];
  agents: RoomAgent[];
  onSelectTask: (task: Task) => void;
  onChangeStatus: (task: Task, status: Task['status']) => void;
}) {
  const agentMap = new Map(agents.map((agent) => [agent.id, agent]));
  const rootTasks = tasks.filter((task) => !task.parent_task_id);

  return (
    <aside className="w-[360px] max-lg:w-full max-lg:max-h-[42vh] flex-shrink-0 border-l max-lg:border-l-0 max-lg:border-t border-[var(--color-border)] bg-[var(--color-bg)] min-h-0 flex flex-col">
      <header className="h-12 px-4 border-b border-[var(--color-border)] flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4 text-[var(--color-accent)]" strokeWidth={1.75} />
        <div className="font-display text-[13px] font-semibold">任务看板</div>
        <span className="ml-auto text-[11px] font-mono text-[var(--color-fg-muted)]">
          {rootTasks.length}
        </span>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        {TASK_COLUMNS.map((status) => {
          const columnTasks = rootTasks.filter((task) => task.status === status);
          const Icon = STATUS_ICON[status];
          return (
            <section key={status} className="surface-1 rounded-lg">
              <div className="px-3 py-2 border-b border-[var(--color-border)] flex items-center gap-2">
                <Icon className="h-3.5 w-3.5 text-[var(--color-accent)]" strokeWidth={1.75} />
                <h3 className="font-display text-[12px] font-medium">{TASK_STATUS_LABEL[status]}</h3>
                <span className="ml-auto text-[10.5px] font-mono text-[var(--color-muted)]">
                  {columnTasks.length}
                </span>
              </div>
              <div className="p-2 space-y-2">
                {columnTasks.length === 0 ? (
                  <div className="px-2 py-5 text-center text-[11.5px] text-[var(--color-muted)]">
                    暂无任务
                  </div>
                ) : (
                  columnTasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      agent={task.assigned_agent_id ? agentMap.get(task.assigned_agent_id) : undefined}
                      onSelect={() => onSelectTask(task)}
                      onChangeStatus={(next) => onChangeStatus(task, next)}
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
  onSelect,
  onChangeStatus,
}: {
  task: Task;
  agent?: RoomAgent;
  onSelect: () => void;
  onChangeStatus: (status: Task['status']) => void;
}) {
  const nextStatus = NEXT_STATUS[task.status];

  return (
    <article className="surface-2 rounded-lg p-3 hover:border-[var(--color-border-strong)] ease-ocean transition-colors">
      <button type="button" onClick={onSelect} className="block w-full text-left">
        <div className="flex items-start gap-2">
          <h4 className="min-w-0 flex-1 font-display text-[12.5px] font-semibold leading-snug">
            {task.title}
          </h4>
          <span className={cn('text-[10px] font-mono flex-shrink-0', PRIORITY_TONE[task.priority])}>
            {TASK_PRIORITY_LABEL[task.priority]}
          </span>
        </div>
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
            <span className="text-[11px] text-[var(--color-muted)]">未指派</span>
          )}
          <span className="ml-auto text-[10px] font-mono text-[var(--color-muted)]">
            {relativeTime(task.updated_at)}
          </span>
        </div>
      </button>
      <div className="mt-3 flex items-center gap-2">
        {nextStatus && (
          <Button size="sm" variant="secondary" onClick={() => onChangeStatus(nextStatus)}>
            <ArrowRight className="h-3.5 w-3.5" />
            {TASK_STATUS_LABEL[nextStatus]}
          </Button>
        )}
        {task.status !== 'failed' && (
          <Button size="sm" variant="ghost" onClick={() => onChangeStatus('failed')}>
            标记失败
          </Button>
        )}
      </div>
    </article>
  );
}
