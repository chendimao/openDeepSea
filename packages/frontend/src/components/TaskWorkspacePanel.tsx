import { CheckCircle2 } from 'lucide-react';
import type { MessageKey } from '../lib/i18n';
import type { AgentRun, Message, RoomAgent, Task, TaskEvent, WorkflowRun } from '../lib/types';
import { cn } from '../lib/utils';
import {
  selectTaskDetailEvents,
  type TaskLayerVisibility,
} from './TaskDetailPanel';
import { filterRootTasks, selectActivityEvents, type TaskStatusFilter } from './taskBoardLogic';
import { ActiveTaskSurface } from './task/ActiveTaskSurface';
import { TaskActivityFeed } from './task/TaskActivityFeed';
import { TaskQueueCard } from './task/TaskQueueCard';
import { TaskWorkspaceEmptyState } from './task/TaskWorkspaceEmptyState';

const TASK_STATUS_FILTERS: TaskStatusFilter[] = ['todo', 'in_progress', 'review', 'done', 'failed'];

export interface TaskWorkspacePanelProps {
  tasks: Task[];
  activeTask: Task | null;
  activeTaskId: string | null;
  statusFilters: TaskStatusFilter[];
  activityEvents: TaskEvent[];
  taskEvents: TaskEvent[];
  messages: Message[];
  agentRuns: AgentRun[];
  taskEventsLoading: boolean;
  agents: RoomAgent[];
  workflows: WorkflowRun[];
  layerVisibility: TaskLayerVisibility;
  onStatusFiltersChange: (filters: TaskStatusFilter[]) => void;
  onSelectTask: (task: Task) => void;
  onLocateSourceMessage: (messageId: string, task: Task) => void;
  onClearActiveTask: () => void;
  t: (key: MessageKey, values?: Record<string, string | number>) => string;
  formatRelativeTime: (timestamp: number) => string;
  taskStatusLabel: (status: Task['status']) => string;
  taskPriorityLabel: (priority: Task['priority']) => string;
  interactionModeLabel: (mode: Task['interaction_mode']) => string;
}

export function TaskWorkspacePanel({
  tasks,
  activeTask,
  activeTaskId,
  statusFilters,
  activityEvents,
  taskEvents,
  messages,
  agentRuns,
  taskEventsLoading,
  agents,
  workflows,
  layerVisibility,
  onStatusFiltersChange,
  onSelectTask,
  onLocateSourceMessage,
  onClearActiveTask,
  t,
  formatRelativeTime,
  taskStatusLabel,
  taskPriorityLabel,
  interactionModeLabel,
}: TaskWorkspacePanelProps): JSX.Element {
  const rootTasks = filterRootTasks(tasks, statusFilters);
  const visibleActivity = selectActivityEvents(activityEvents, 4);
  const agentMap = new Map(agents.map((agent) => [agent.id, agent]));
  const workflowByTaskId = createWorkflowByTaskId(workflows);
  const eventGroups = selectTaskDetailEvents(taskEvents, layerVisibility);

  const toggleFilter = (status: TaskStatusFilter): void => {
    const next = statusFilters.includes(status)
      ? statusFilters.filter((item) => item !== status)
      : [...statusFilters, status];
    onStatusFiltersChange(next);
  };

  return (
    <aside className="workbench-panel task-workspace-panel" data-testid="task-panel" aria-label={t('taskWorkspace.title')}>
      <header className="task-workspace-header">
        <CheckCircle2 className="h-4 w-4 text-[var(--color-accent)]" strokeWidth={1.75} />
        <div className="min-w-0">
          <div className="font-display text-[13px] font-semibold">{t('taskWorkspace.title')}</div>
          <div className="mt-0.5 truncate text-[10.5px] font-mono text-[var(--color-fg-muted)]">
            {activeTask ? `#${activeTask.id.slice(0, 6)} · ${activeTask.title}` : t('taskWorkspace.selectTaskTitle')}
          </div>
        </div>
        <span className="ml-auto text-[11px] font-mono text-[var(--color-fg-muted)]">
          {rootTasks.length}
        </span>
      </header>

      <div className="task-workspace-grid">
        <section className="task-queue-rail" aria-label={t('taskBoard.listTitle')}>
          <div className="task-board-filters" aria-label={t('taskBoard.filters')}>
            {TASK_STATUS_FILTERS.map((status) => (
              <button
                key={status}
                type="button"
                className={cn('task-filter-chip', statusFilters.includes(status) && 'is-active')}
                onClick={() => toggleFilter(status)}
              >
                {taskStatusLabel(status)}
              </button>
            ))}
          </div>
          <div className="task-list-scroll">
            {rootTasks.length === 0 ? (
              <div className="task-list-empty">
                {t('taskBoard.empty')}
              </div>
            ) : (
              rootTasks.map((task) => (
                <TaskQueueCard
                  key={task.id}
                  task={task}
                  selected={activeTaskId === task.id}
                  statusLabel={taskStatusLabel(task.status)}
                  updatedLabel={formatRelativeTime(task.updated_at)}
                  onSelect={() => onSelectTask(task)}
                />
              ))
            )}
          </div>
          <TaskActivityFeed
            events={visibleActivity}
            emptyLabel={t('taskBoard.noActivity')}
            title={t('taskBoard.activityFeed')}
            formatRelativeTime={formatRelativeTime}
            t={t}
          />
        </section>

        <section className="active-task-surface" aria-label={t('taskWorkspace.activeTask')}>
          {activeTask ? (
            <ActiveTaskSurface
              task={activeTask}
              assignedAgent={activeTask.assigned_agent_id ? agentMap.get(activeTask.assigned_agent_id) : undefined}
              workflow={workflowByTaskId.get(activeTask.id)}
              layerVisibility={layerVisibility}
              taskEventsLoading={taskEventsLoading}
              eventGroups={eventGroups}
              messages={messages}
              agentRuns={agentRuns}
              roomAgents={agents}
              roomId={activeTask.room_id}
              onLocateSourceMessage={
                activeTask.source_message_id
                  ? () => onLocateSourceMessage(activeTask.source_message_id!, activeTask)
                  : undefined
              }
              onClearActiveTask={onClearActiveTask}
              formatRelativeTime={formatRelativeTime}
              t={t}
              taskStatusLabel={taskStatusLabel}
              taskPriorityLabel={taskPriorityLabel}
              interactionModeLabel={interactionModeLabel}
            />
          ) : (
            <TaskWorkspaceEmptyState
              tasks={rootTasks}
              onSelectTask={onSelectTask}
              title={t('taskWorkspace.selectTaskTitle')}
              description={t('taskWorkspace.selectTaskDescription')}
            />
          )}
        </section>
      </div>
    </aside>
  );
}

function createWorkflowByTaskId(workflows: WorkflowRun[]): Map<string, WorkflowRun> {
  const byTaskId = new Map<string, WorkflowRun>();
  for (const workflow of workflows) {
    if (!workflow.task_id) continue;
    const existing = byTaskId.get(workflow.task_id);
    if (!existing || workflow.updated_at > existing.updated_at) {
      byTaskId.set(workflow.task_id, workflow);
    }
  }
  return byTaskId;
}
