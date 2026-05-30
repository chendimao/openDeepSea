import { motion } from 'framer-motion';
import { ArrowRight, Bot, CheckCircle2, CircleDot, Clock3, FileDiff, Gauge, GitBranch, ListChecks, LocateFixed, Pencil, Play, Radio, Search, XCircle } from 'lucide-react';
import type { MessageKey } from '../lib/i18n';
import type { MessageLayer, RoomAgent, Task, TaskEvent, TaskExecutorListItem, WorkflowRun } from '../lib/types';
import { cn } from '../lib/utils';
import { AgentAvatar } from './AgentAvatar';
import {
  selectTaskDetailEvents,
  TaskLayerToggles,
  type TaskLayerVisibility,
} from './TaskDetailPanel';
import { filterRootTasks, selectActivityEvents, type TaskStatusFilter } from './taskBoardLogic';
import { TaskMetaCell, TaskResourceMetric, TaskWorkspacePanelTitle } from './task/TaskWorkspaceCards';
import {
  buildFileChanges,
  buildPlanSteps,
  buildToolCalls,
  taskEventTypeLabel,
  taskProgressPercent,
} from './task/taskWorkspaceModel';
import { Button } from './ui/Button';

const TASK_STATUS_FILTERS: TaskStatusFilter[] = ['todo', 'in_progress', 'review', 'done', 'failed'];
const NEXT_STATUS: Partial<Record<Task['status'], Task['status']>> = {
  todo: 'in_progress',
  in_progress: 'review',
  review: 'done',
};
const ACTIVE_WORKFLOW_STATUSES = new Set<WorkflowRun['status']>([
  'draft',
  'running',
  'awaiting_decision',
  'awaiting_approval',
  'blocked',
]);

const PRIORITY_TONE: Record<Task['priority'], string> = {
  low: 'text-[var(--color-muted)]',
  normal: 'text-[var(--color-fg-muted)]',
  high: 'text-[var(--color-warning)]',
  urgent: 'text-[var(--color-danger)]',
};

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
                <QueueTaskCard
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

function QueueTaskCard({
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
}: {
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
}): JSX.Element {
  const nextStatus = NEXT_STATUS[task.status];
  const hasActiveWorkflow = workflow ? ACTIVE_WORKFLOW_STATUSES.has(workflow.status) : false;
  const canStartWorkflow = !hasActiveWorkflow && task.status !== 'done';
  const progress = taskProgressPercent(task.status);

  return (
    <motion.article
      className={cn('task-card task-list-item task-queue-card', selected && 'is-selected')}
      data-active={selected ? 'true' : undefined}
      whileHover={{ y: -2 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
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
          <span className={cn('text-[10px] font-mono flex-shrink-0', PRIORITY_TONE[task.priority])}>
            {priorityLabel}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="task-meta-pill">{statusLabel}</span>
          {workflow && (
            <span className="task-meta-pill text-[var(--color-accent)]">
              <span className="truncate">{workflowStatusLabel(workflow.status)}</span>
            </span>
          )}
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
            <span className="text-[11px] text-[var(--color-muted)]">{unassignedLabel}</span>
          )}
          <span className="ml-auto text-[10px] font-mono text-[var(--color-muted)]">
            {progress}%
          </span>
        </div>
        <div className="task-card-progress" aria-hidden="true">
          <i style={{ width: `${progress}%` }} />
        </div>
      </button>
      <div className="mt-3 flex flex-wrap items-center gap-2">
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
    </motion.article>
  );
}

function ActiveTaskSurface({
  task,
  assignedAgent,
  workflow,
  layerVisibility,
  taskEventsLoading,
  eventGroups,
  onChangeStatus,
  onStartWorkflow,
  onLocateSourceMessage,
  onLayerVisibilityChange,
  onClearActiveTask,
  formatRelativeTime,
  t,
  taskStatusLabel,
  taskPriorityLabel,
  interactionModeLabel,
}: {
  task: Task;
  assignedAgent?: RoomAgent;
  workflow?: WorkflowRun;
  layerVisibility: TaskLayerVisibility;
  taskEventsLoading: boolean;
  eventGroups: ReturnType<typeof selectTaskDetailEvents>;
  onChangeStatus: (status: Task['status']) => void;
  onStartWorkflow?: () => void;
  onLocateSourceMessage?: () => void;
  onLayerVisibilityChange: (layer: MessageLayer, visible: boolean) => void;
  onClearActiveTask: () => void;
  formatRelativeTime: (timestamp: number) => string;
  t: (key: MessageKey, values?: Record<string, string | number>) => string;
  taskStatusLabel: (status: Task['status']) => string;
  taskPriorityLabel: (priority: Task['priority']) => string;
  interactionModeLabel: (mode: Task['interaction_mode']) => string;
}): JSX.Element {
  const nextStatus = NEXT_STATUS[task.status];
  const hasActiveWorkflow = workflow ? ACTIVE_WORKFLOW_STATUSES.has(workflow.status) : false;
  const canStartWorkflow = !hasActiveWorkflow && task.status !== 'done';
  const progress = taskProgressPercent(task.status);
  const planSteps = buildPlanSteps(task, eventGroups.planEvents, t);
  const timelineEvents = eventGroups.timelineEvents.slice(0, 5);
  const fileChanges = buildFileChanges(eventGroups.diffEvents);
  const toolCalls = buildToolCalls(eventGroups.logEvents, eventGroups.timelineEvents);
  const currentAgent = assignedAgent?.agent_name ?? t('common.unassigned');
  const currentStep = planSteps.find((step) => step.state === 'running') ?? planSteps[0];

  return (
    <>
      <header className="active-task-header">
        <div className="active-task-breadcrumb">
          <button type="button" onClick={onClearActiveTask}>{t('taskWorkspace.title')}</button>
          <span>/</span>
          <strong>#{task.id.slice(0, 6)}</strong>
        </div>
        <div className="active-task-title-row">
          <div className="min-w-0">
            <h3>{task.title}</h3>
            <p>{task.description || t('taskDetail.noDescription')}</p>
          </div>
          <div className="active-task-header-actions">
            {onLocateSourceMessage && (
              <button type="button" onClick={onLocateSourceMessage} aria-label={t('taskBoard.locateSourceMessage')} title={t('taskBoard.locateSourceMessage')}>
                <LocateFixed className="h-4 w-4" />
              </button>
            )}
            <button type="button" aria-label={t('taskDetail.updated')} title={t('taskDetail.updated')}>
              <Pencil className="h-4 w-4" />
            </button>
            <button type="button" onClick={onClearActiveTask} aria-label={t('taskWorkspace.clearActiveTask')} title={t('taskWorkspace.clearActiveTask')}>
              <XCircle className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="active-task-meta-grid">
          <TaskMetaCell label="Status" value={taskStatusLabel(task.status)} />
          <TaskMetaCell label="Owner" value={currentAgent} />
          <TaskMetaCell label="Priority" value={taskPriorityLabel(task.priority)} />
          <TaskMetaCell label="ETA" value={workflow?.current_stage ?? interactionModeLabel(task.interaction_mode)} />
          <TaskMetaCell label="Create Time" value={formatRelativeTime(task.created_at)} />
          <div className="active-task-progress">
            <span>{progress}%</span>
            <div className="liquid-progress"><i style={{ width: `${progress}%` }} /></div>
          </div>
        </div>
      </header>

      <div className="active-task-actions">
        {onStartWorkflow && canStartWorkflow && (
          <Button size="sm" variant="secondary" onClick={onStartWorkflow}>
            <Play className="h-3.5 w-3.5" />
            {t('taskBoard.startWorkflow')}
          </Button>
        )}
        {nextStatus && (
          <Button size="sm" variant="secondary" onClick={() => onChangeStatus(nextStatus)}>
            <ArrowRight className="h-3.5 w-3.5" />
            {taskStatusLabel(nextStatus)}
          </Button>
        )}
        <TaskLayerToggles layerVisibility={layerVisibility} onChange={onLayerVisibilityChange} t={t} />
      </div>

      <div className="active-task-scroll task-workspace-canvas">
        {taskEventsLoading && (
          <div className="task-loading-strip">
            <Radio className="h-4 w-4 shrink-0 animate-pulse text-[var(--color-primary)]" strokeWidth={1.8} />
            <span>{t('taskDetail.executorsLoading')}</span>
          </div>
        )}

        <motion.section className="task-detail-card execution-plan-card" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} whileHover={{ y: -2 }} transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}>
          <TaskWorkspacePanelTitle icon={ListChecks} title="Execution Plan" subtitle={`${planSteps.length} steps`} />
          <div className="execution-step-list">
            {planSteps.map((step, index) => (
              <div key={`${step.title}:${index}`} className="execution-step" data-state={step.state}>
                <span className="execution-step-node">{index + 1}</span>
                <div className="min-w-0">
                  <strong>{step.title}</strong>
                  <small>{step.time ? formatRelativeTime(step.time) : step.state}</small>
                </div>
              </div>
            ))}
          </div>
        </motion.section>

        <motion.section className="task-detail-card realtime-status-card" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} whileHover={{ y: -2 }} transition={{ duration: 0.2, delay: 0.03, ease: [0.16, 1, 0.3, 1] }}>
          <TaskWorkspacePanelTitle icon={Gauge} title="Realtime Status" subtitle={workflow?.status ?? taskStatusLabel(task.status)} />
          <div className="current-agent-row">
            {assignedAgent ? <AgentAvatar name={assignedAgent.agent_name} size={34} active={!!assignedAgent.acp_enabled} /> : <Bot className="h-7 w-7 text-[var(--color-muted)]" />}
            <div className="min-w-0">
              <strong>{currentAgent}</strong>
              <span>{currentStep?.title ?? t('taskWorkspace.selectTaskDescription')}</span>
            </div>
            <i />
          </div>
          <div className="resource-metrics">
            <TaskResourceMetric label="Tokens" value={String(Math.max(0, eventGroups.visibleEvents.length * 418))} />
            <TaskResourceMetric label="Tool Calls" value={String(toolCalls.length)} />
            <TaskResourceMetric label="File Reads" value={String(eventGroups.timelineEvents.length)} />
            <TaskResourceMetric label="File Changes" value={String(fileChanges.length)} />
          </div>
        </motion.section>

        <motion.section className="task-detail-card timeline-card" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} whileHover={{ y: -2 }} transition={{ duration: 0.2, delay: 0.06, ease: [0.16, 1, 0.3, 1] }}>
          <TaskWorkspacePanelTitle icon={Clock3} title="Timeline" subtitle="Activity stream" />
          <div className="workspace-timeline-list">
            {(timelineEvents.length > 0 ? timelineEvents : eventGroups.visibleEvents.slice(0, 4)).map((event) => (
              <div key={event.id} className="workspace-timeline-row">
                <time>{formatRelativeTime(event.created_at)}</time>
                <span className="task-event-dot" data-layer={event.layer} />
                <strong>{taskEventTypeLabel(event.type, t)}</strong>
              </div>
            ))}
            {eventGroups.visibleEvents.length === 0 && (
              <div className="workspace-empty-row">{t('taskDetail.noEvents')}</div>
            )}
          </div>
        </motion.section>

        <motion.section className="task-detail-card file-changes-card" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} whileHover={{ y: -2 }} transition={{ duration: 0.2, delay: 0.09, ease: [0.16, 1, 0.3, 1] }}>
          <TaskWorkspacePanelTitle icon={FileDiff} title="File Changes" subtitle={`${fileChanges.length} files`} />
          <div className="file-change-list">
            {fileChanges.length > 0 ? fileChanges.map((file) => (
              <div key={file.name} className="file-change-row">
                <span>{file.name}</span>
                <strong className="text-[var(--color-success)]">+{file.added}</strong>
                <strong className="text-[var(--color-danger)]">-{file.removed}</strong>
              </div>
            )) : (
              <div className="workspace-empty-row">{layerVisibility.diff ? t('taskDetail.noDiffEvents') : t('taskDetail.diffHidden')}</div>
            )}
          </div>
        </motion.section>

        <motion.section className="task-detail-card tool-calls-card" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} whileHover={{ y: -2 }} transition={{ duration: 0.2, delay: 0.12, ease: [0.16, 1, 0.3, 1] }}>
          <TaskWorkspacePanelTitle icon={GitBranch} title="Tool Calls" subtitle={`${toolCalls.length} recent`} />
          <div className="tool-call-strip">
            {(toolCalls.length > 0 ? toolCalls : [{ name: 'search_files', status: 'waiting', time: task.created_at }, { name: 'read_file', status: 'waiting', time: task.created_at }, { name: 'generate_preview', status: 'waiting', time: task.created_at }]).map((tool) => (
              <div key={`${tool.name}:${tool.time}`} className="tool-call-card" data-status={tool.status}>
                <Search className="h-4 w-4" strokeWidth={1.8} />
                <strong>{tool.name}</strong>
                <span>{tool.status}</span>
                <time>{formatRelativeTime(tool.time)}</time>
              </div>
            ))}
          </div>
        </motion.section>
      </div>
    </>
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
            <div className="min-w-0">
              <strong>AI Agent</strong>
              <span>AI 正在生成 UI 预览...</span>
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
