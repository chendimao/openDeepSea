import { ArrowRight, Bot, CheckCircle2, CircleDot, Clock3, FileDiff, Gauge, GitBranch, ListChecks, Search } from 'lucide-react';
import type { MessageKey } from '../lib/i18n';
import type { MessageLayer, RoomAgent, Task, TaskEvent, TaskExecutorListItem, WorkflowRun } from '../lib/types';
import { cn } from '../lib/utils';
import {
  selectTaskDetailEvents,
  type TaskLayerVisibility,
} from './TaskDetailPanel';
import { filterRootTasks, selectActivityEvents, type TaskStatusFilter } from './taskBoardLogic';
import { ActiveTaskSurface } from './task/ActiveTaskSurface';
import { TaskQueueCard } from './task/TaskQueueCard';
import { TaskResourceMetric, TaskWorkspacePanelTitle } from './task/TaskWorkspaceCards';
import {
  taskEventTypeLabel,
} from './task/taskWorkspaceModel';

const TASK_STATUS_FILTERS: TaskStatusFilter[] = ['todo', 'in_progress', 'review', 'done', 'failed'];

export interface TaskWorkspacePanelProps {
  tasks: Task[];
  activeTask: Task | null;
  activeTaskId: string | null;
  statusFilters: TaskStatusFilter[];
  activityEvents: TaskEvent[];
  taskEvents: TaskEvent[];
  taskEventsLoading: boolean;
  executors: TaskExecutorListItem[];
  executorsLoading: boolean;
  agents: RoomAgent[];
  workflows: WorkflowRun[];
  layerVisibility: TaskLayerVisibility;
  startingTaskId?: string | null;
  onStatusFiltersChange: (filters: TaskStatusFilter[]) => void;
  onSelectTask: (task: Task) => void;
  onChangeStatus: (task: Task, status: Task['status']) => void;
  onStartWorkflow?: (task: Task) => void;
  onLocateSourceMessage: (messageId: string, task: Task) => void;
  onLayerVisibilityChange: (layer: MessageLayer, visible: boolean) => void;
  onClearActiveTask: () => void;
  t: (key: MessageKey, values?: Record<string, string | number>) => string;
  formatRelativeTime: (timestamp: number) => string;
  taskStatusLabel: (status: Task['status']) => string;
  taskPriorityLabel: (priority: Task['priority']) => string;
  interactionModeLabel: (mode: Task['interaction_mode']) => string;
  workflowStatusLabel: (status: WorkflowRun['status']) => string;
}

export function TaskWorkspacePanel({
  tasks,
  activeTask,
  activeTaskId,
  statusFilters,
  activityEvents,
  taskEvents,
  taskEventsLoading,
  agents,
  workflows,
  layerVisibility,
  startingTaskId,
  onStatusFiltersChange,
  onSelectTask,
  onChangeStatus,
  onStartWorkflow,
  onLocateSourceMessage,
  onLayerVisibilityChange,
  onClearActiveTask,
  t,
  formatRelativeTime,
  taskStatusLabel,
  taskPriorityLabel,
  interactionModeLabel,
  workflowStatusLabel,
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
              <div className="px-4 py-10 text-center text-[12px] text-[var(--color-muted)]">
                {t('taskBoard.empty')}
              </div>
            ) : (
              rootTasks.map((task) => (
                <TaskQueueCard
                  key={task.id}
                  task={task}
                  agent={task.assigned_agent_id ? agentMap.get(task.assigned_agent_id) : undefined}
                  workflow={workflowByTaskId.get(task.id)}
                  selected={activeTaskId === task.id}
                  statusLabel={taskStatusLabel(task.status)}
                  priorityLabel={taskPriorityLabel(task.priority)}
                  workflowStatusLabel={workflowStatusLabel}
                  nextStatusLabel={(status) => taskStatusLabel(status)}
                  updatedLabel={formatRelativeTime(task.updated_at)}
                  unassignedLabel={t('common.unassigned')}
                  markFailedLabel={t('taskBoard.markFailed')}
                  startWorkflowLabel={t('taskBoard.startWorkflow')}
                  locateSourceLabel={t('taskBoard.locateSourceMessage')}
                  onSelect={() => onSelectTask(task)}
                  onChangeStatus={(next) => onChangeStatus(task, next)}
                  onStartWorkflow={onStartWorkflow ? () => onStartWorkflow(task) : undefined}
                  onLocateSourceMessage={
                    task.source_message_id
                      ? () => onLocateSourceMessage(task.source_message_id!, task)
                      : undefined
                  }
                  startingWorkflow={startingTaskId === task.id}
                />
              ))
            )}
          </div>
          <ActivityFeed
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
              onChangeStatus={(status) => onChangeStatus(activeTask, status)}
              onStartWorkflow={onStartWorkflow ? () => onStartWorkflow(activeTask) : undefined}
              onLocateSourceMessage={
                activeTask.source_message_id
                  ? () => onLocateSourceMessage(activeTask.source_message_id!, activeTask)
                  : undefined
              }
              onLayerVisibilityChange={onLayerVisibilityChange}
              onClearActiveTask={onClearActiveTask}
              formatRelativeTime={formatRelativeTime}
              t={t}
              taskStatusLabel={taskStatusLabel}
              taskPriorityLabel={taskPriorityLabel}
              interactionModeLabel={interactionModeLabel}
            />
          ) : (
            <TaskSelectionEmptyState
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

function TaskSelectionEmptyState({
  tasks,
  onSelectTask,
  title,
  description,
}: {
  tasks: Task[];
  onSelectTask: (task: Task) => void;
  title: string;
  description: string;
}): JSX.Element {
  return (
    <div className="task-workspace-empty">
      <div className="task-workspace-empty-copy">
        <CircleDot className="h-7 w-7 text-[var(--color-muted)]" strokeWidth={1.7} />
        <div className="mt-3 font-display text-[14px] font-semibold">{title}</div>
        <p className="mt-1 max-w-[32ch] text-[12px] leading-relaxed text-[var(--color-fg-muted)]">{description}</p>
      </div>
      <div className="task-workspace-empty-preview" aria-hidden="true">
        <div className="task-detail-card execution-plan-card">
          <TaskWorkspacePanelTitle icon={ListChecks} title="Execution Plan" subtitle="3 steps" />
          <div className="execution-step-list">
            {[
              ['分析需求与上下文', 'completed'],
              ['生成 UI 预览', 'running'],
              ['等待验证', 'waiting'],
            ].map(([label, state], index) => (
              <div key={label} className="execution-step" data-state={state}>
                <span className="execution-step-node">{index + 1}</span>
                <div className="min-w-0">
                  <strong>{label}</strong>
                  <small>{state}</small>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="task-detail-card realtime-status-card">
          <TaskWorkspacePanelTitle icon={Gauge} title="Realtime Status" subtitle="waiting" />
          <div className="current-agent-row">
            <Bot className="h-7 w-7 text-[var(--color-muted)]" />
            <div className="current-agent-copy">
              <div className="current-status-line">
                <span>Current Agent</span>
                <strong>AI Agent</strong>
              </div>
              <div className="current-status-line">
                <span>Current Step</span>
                <strong>AI 正在生成 UI 预览...</strong>
              </div>
            </div>
            <i />
          </div>
          <div className="resource-metrics">
            <TaskResourceMetric label="Tokens" value="0" />
            <TaskResourceMetric label="Tool Calls" value="0" />
            <TaskResourceMetric label="File Reads" value="0" />
            <TaskResourceMetric label="File Changes" value="0" />
          </div>
        </div>
        <div className="task-detail-card timeline-card">
          <TaskWorkspacePanelTitle icon={Clock3} title="Timeline" subtitle="Activity stream" />
          <div className="workspace-timeline-list">
            {[
              ['21:42:13', '任务启动'],
              ['21:42:18', '分析需求'],
              ['21:42:25', '收集资料'],
            ].map(([time, label]) => (
              <div key={`${time}:${label}`} className="workspace-timeline-row">
                <time>{time}</time>
                <span className="task-event-dot" data-layer="timeline" />
                <strong>{label}</strong>
              </div>
            ))}
          </div>
        </div>
        <div className="task-detail-card file-changes-card">
          <TaskWorkspacePanelTitle icon={FileDiff} title="File Changes" subtitle="0 files" />
          <div className="file-change-list">
            <div className="file-change-header" aria-hidden="true">
              <span>File</span>
              <strong>+</strong>
              <strong>-</strong>
            </div>
            <div className="file-change-row is-empty">
              <span>preview.diff</span>
              <strong className="text-[var(--color-success)]">+0</strong>
              <strong className="text-[var(--color-danger)]">-0</strong>
            </div>
          </div>
        </div>
        <div className="task-detail-card tool-calls-card">
          <TaskWorkspacePanelTitle icon={GitBranch} title="Tool Calls" subtitle="preview" />
          <div className="tool-call-strip">
            {['search_files', 'read_file', 'generate_preview'].map((tool) => (
              <div key={tool} className="tool-call-card" data-status="waiting">
                <Search className="h-4 w-4" strokeWidth={1.8} />
                <strong>{tool}</strong>
                <span>waiting</span>
                <time>--:--</time>
              </div>
            ))}
          </div>
        </div>
      </div>
      {tasks.length > 0 && (
        <div className="mt-4 w-full space-y-2">
          {tasks.slice(0, 3).map((task) => (
            <button key={task.id} type="button" className="task-workspace-suggestion" onClick={() => onSelectTask(task)}>
              <span className="truncate">{task.title}</span>
              <ArrowRight className="h-3.5 w-3.5 shrink-0" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ActivityFeed({
  events,
  emptyLabel,
  title,
  formatRelativeTime,
  t,
}: {
  events: TaskEvent[];
  emptyLabel: string;
  title: string;
  formatRelativeTime: (timestamp: number) => string;
  t: (key: MessageKey) => string;
}): JSX.Element {
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
