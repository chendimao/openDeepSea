import { CheckCircle2 } from 'lucide-react';
import type { MessageKey } from '../lib/i18n';
import type { AgentRun, Message, RoomAgent, Task, TaskActionKind, TaskEvent, WorkflowRun } from '../lib/types';
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
import { createTaskActionStates } from './task/taskActionState';

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
  onStartTaskAction?: (task: Task, action: TaskActionKind) => void;
  onLocateSourceMessage: (messageId: string, task: Task) => void;
  onClearActiveTask: () => void;
  startingTaskActionKey?: string | null;
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
  onStartTaskAction,
  onLocateSourceMessage,
  onClearActiveTask,
  startingTaskActionKey,
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
  const activeTaskActionStates = activeTask
    ? createTaskActionStates(
      taskEvents.filter((event) => event.task_id === activeTask.id),
      startingTaskActionKey?.startsWith(`${activeTask.id}:`) ? startingTaskActionKey : null,
    )
    : {};

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
              tasks={tasks}
              roomId={activeTask.room_id}
              taskActionStates={activeTaskActionStates}
              onStartTaskAction={onStartTaskAction ? (action) => onStartTaskAction(activeTask, action) : undefined}
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
  const grouped = new Map<string, WorkflowRun[]>();
  for (const workflow of workflows) {
    if (!workflow.task_id) continue;
    grouped.set(workflow.task_id, [...(grouped.get(workflow.task_id) ?? []), workflow]);
  }

  const byTaskId = new Map<string, WorkflowRun>();
  for (const [taskId, taskWorkflows] of grouped) {
    const sorted = [...taskWorkflows].sort((a, b) => b.updated_at - a.updated_at);
    byTaskId.set(taskId, sorted.find((workflow) => isNonTerminalWorkflowStatus(workflow.status)) ?? sorted[0]);
  }
  return byTaskId;
}

function isNonTerminalWorkflowStatus(status: WorkflowRun['status']): boolean {
  return status !== 'completed' && status !== 'cancelled' && status !== 'failed';
}
