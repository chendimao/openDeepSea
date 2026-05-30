import { motion } from 'framer-motion';
import { ArrowRight, Bot, Clock3, FileDiff, Gauge, GitBranch, ListChecks, LocateFixed, Pencil, Play, Radio, Search, XCircle } from 'lucide-react';
import type { MessageKey } from '../../lib/i18n';
import type { MessageLayer, RoomAgent, Task, WorkflowRun } from '../../lib/types';
import { AgentAvatar } from '../AgentAvatar';
import {
  selectTaskDetailEvents,
  TaskLayerToggles,
  type TaskLayerVisibility,
} from '../TaskDetailPanel';
import { Button } from '../ui/Button';
import { TaskMetaCell, TaskResourceMetric, TaskWorkspacePanelTitle } from './TaskWorkspaceCards';
import {
  buildFileChanges,
  buildPlanSteps,
  buildToolCalls,
  taskEventTypeLabel,
  taskProgressPercent,
} from './taskWorkspaceModel';

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

export interface ActiveTaskSurfaceProps {
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
}

export function ActiveTaskSurface({
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
}: ActiveTaskSurfaceProps): JSX.Element {
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
                <time dateTime={new Date(event.created_at).toISOString()}>{formatClockTime(event.created_at)}</time>
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
                <time dateTime={new Date(tool.time).toISOString()}>{formatClockTime(tool.time)}</time>
              </div>
            ))}
          </div>
        </motion.section>
      </div>
    </>
  );
}

function formatClockTime(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}
