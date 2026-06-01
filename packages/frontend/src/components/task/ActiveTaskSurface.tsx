import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Bot, Clock3, FileDiff, FileText, FolderOpen, Gauge, GitBranch, ListChecks, LocateFixed, MonitorPlay, Pencil, Radio, Search, ScrollText, XCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import type { MessageKey } from '../../lib/i18n';
import type { AgentRun, Message, MessageTrace, PlannerDecision, RoomAgent, Task, WorkflowRun } from '../../lib/types';
import { parseMessageMetadata } from '../../lib/messageMetadata';
import { createPlannerDispatchInput } from '../../pages/roomPageLogic';
import { AgentAvatar } from '../AgentAvatar';
import { AgentRunStatusCard } from '../AgentRunPanel';
import { AgentTimeline } from '../AgentTimeline';
import { pairRunsWithAgentMessages } from '../chat/chatMessageModel';
import { PlannerDecisionPanel } from '../chat/PlannerDecisionPanel';
import { selectTaskDetailEvents, type TaskLayerVisibility } from '../TaskDetailPanel';
import { TaskMetaCell, TaskResourceMetric, TaskWorkspacePanelTitle } from './TaskWorkspaceCards';
import {
  buildFileChanges,
  buildPlanSteps,
  buildToolCalls,
  taskEventTypeLabel,
  taskProgressPercent,
  type TaskWorkspacePlanStep,
  type TaskWorkspaceToolCall,
} from './taskWorkspaceModel';

type ActiveTaskTab = 'records' | 'plan' | 'runtime' | 'resources';

const TASK_WORKSPACE_TABS: Array<{ id: ActiveTaskTab; label: string }> = [
  { id: 'records', label: '记录' },
  { id: 'plan', label: '计划' },
  { id: 'runtime', label: '运行' },
  { id: 'resources', label: '资源' },
];

export interface ActiveTaskSurfaceProps {
  task: Task;
  assignedAgent?: RoomAgent;
  workflow?: WorkflowRun;
  layerVisibility: TaskLayerVisibility;
  taskEventsLoading: boolean;
  eventGroups: ReturnType<typeof selectTaskDetailEvents>;
  messages: Message[];
  agentRuns: AgentRun[];
  roomAgents: RoomAgent[];
  roomId: string;
  onLocateSourceMessage?: () => void;
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
  messages,
  agentRuns,
  roomAgents,
  roomId,
  onLocateSourceMessage,
  onClearActiveTask,
  formatRelativeTime,
  t,
  taskStatusLabel,
  taskPriorityLabel,
  interactionModeLabel,
}: ActiveTaskSurfaceProps): JSX.Element {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<ActiveTaskTab>('records');
  const progress = taskProgressPercent(task.status);
  const planSteps = buildPlanSteps(task, eventGroups.planEvents, t);
  const timelineEvents = eventGroups.timelineEvents.slice(0, 5);
  const fileChanges = buildFileChanges(eventGroups.diffEvents);
  const toolCalls = buildToolCalls(eventGroups.logEvents, eventGroups.timelineEvents);
  const displayToolCalls = completeToolCallPreview(toolCalls, task.created_at);
  const currentAgent = assignedAgent?.agent_name ?? t('common.unassigned');
  const currentStep = planSteps.find((step) => step.state === 'running') ?? planSteps[0];
  const taskMessages = useMemo(
    () => messages.filter((message) => messageBelongsToTask(message, task)),
    [messages, task],
  );
  const plannerRecords = useMemo(
    () => taskMessages
      .map((message) => {
        const metadata = parseMessageMetadata(message.metadata);
        return metadata.planner_decision ? { message, decision: metadata.planner_decision } : null;
      })
      .filter((record): record is { message: Message; decision: PlannerDecision } => Boolean(record)),
    [taskMessages],
  );
  const traceRecords = useMemo(
    () => taskMessages
      .map((message) => {
        const metadata = parseMessageMetadata(message.metadata);
        return hasMessageTraceEvents(metadata.trace) ? { message, trace: metadata.trace } : null;
      })
      .filter((record): record is { message: Message; trace: MessageTrace } => Boolean(record)),
    [taskMessages],
  );
  const taskAgentRuns = useMemo(
    () => {
      const runByMessageId = pairRunsWithAgentMessages(messages, agentRuns);
      const taskMessageIds = new Set(taskMessages.map((message) => message.id));
      const pairedRunIds = new Set(
        Array.from(taskMessageIds)
          .map((messageId) => runByMessageId.get(messageId)?.id)
          .filter((id): id is string => Boolean(id)),
      );
      return agentRuns.filter((run) =>
        run.task_id === task.id ||
        Boolean(workflow?.id && run.workflow_run_id === workflow.id) ||
        pairedRunIds.has(run.id)
      ).sort((a, b) => b.started_at - a.started_at);
    },
    [agentRuns, messages, task.id, taskMessages, workflow?.id],
  );
  const agentByRoomId = useMemo(
    () => new Map(roomAgents.map((agent) => [agent.id, agent])),
    [roomAgents],
  );
  const attachments = useMemo(
    () => taskMessages.flatMap((message) => parseMessageMetadata(message.metadata).attachments),
    [taskMessages],
  );
  const continuePlanner = useMutation({
    mutationFn: (input: { source_message_id: string; planner_decision: PlannerDecision }) =>
      api.dispatchPlannerDecision(roomId, input),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['messages', roomId] });
      queryClient.invalidateQueries({ queryKey: ['room-agents', roomId] });
      queryClient.invalidateQueries({ queryKey: ['agent-runs', roomId] });
      const addedCount = result.added_agents?.length ?? 0;
      const deferredCount = result.deferred_steps?.length ?? 0;
      toast.success(
        result.dispatched > 0
          ? addedCount > 0
            ? deferredCount > 0
              ? `已加入 ${addedCount} 个智能体，先派发 ${result.dispatched} 个，暂缓 ${deferredCount} 个后续步骤`
              : `已加入 ${addedCount} 个智能体并派发 ${result.dispatched} 个智能体`
            : deferredCount > 0
              ? `已先派发 ${result.dispatched} 个智能体，暂缓 ${deferredCount} 个后续步骤`
              : `已派发 ${result.dispatched} 个智能体`
          : '没有可派发的下一步',
      );
    },
    onError: (err) => toast.error((err as Error).message),
  });

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
            <span>
              <b>Progress</b>
              <strong>{progress}%</strong>
            </span>
            <div className="task-progress-track"><i style={{ width: `${progress}%` }} /></div>
          </div>
        </div>
      </header>

      <div className="active-task-tabs" role="tablist" aria-label="任务工作栏">
        {TASK_WORKSPACE_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            className={activeTab === tab.id ? 'is-active' : undefined}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="active-task-scroll task-workspace-canvas">
        {taskEventsLoading && (
          <div className="task-loading-strip">
            <Radio className="h-4 w-4 shrink-0 animate-pulse text-[var(--color-primary)]" strokeWidth={1.8} />
            <span>{t('taskDetail.executorsLoading')}</span>
          </div>
        )}

        {activeTab === 'records' && (
          <TaskRecordsTab
            plannerRecords={plannerRecords}
            traceRecords={traceRecords}
            agentRuns={taskAgentRuns}
            agentByRoomId={agentByRoomId}
            roomId={roomId}
            roomAgents={roomAgents}
            formatRelativeTime={formatRelativeTime}
            continuing={continuePlanner.isPending}
            onContinue={(message) => {
              const metadata = parseMessageMetadata(message.metadata);
              const input = createPlannerDispatchInput(message, metadata);
              if (!input) return;
              continuePlanner.mutate(input);
            }}
            emptyLabel={t('taskDetail.noEvents')}
          />
        )}

        {activeTab === 'plan' && (
        <section className="task-detail-card execution-plan-card task-tab-section">
          <TaskWorkspacePanelTitle icon={ListChecks} title="Execution Plan" subtitle={`${planSteps.length} steps`} />
          <div className="execution-step-list">
            {planSteps.map((step, index) => (
              <div key={`${step.title}:${index}`} className="execution-step" data-state={step.state}>
                <span className="execution-step-node">{index + 1}</span>
                <div className="min-w-0">
                  <strong>{step.title}</strong>
                  <small>{formatPlanStepMeta(step, formatRelativeTime)}</small>
                </div>
              </div>
            ))}
          </div>
        </section>
        )}

        {activeTab === 'runtime' && (
          <>
        <section className="task-detail-card realtime-status-card">
          <TaskWorkspacePanelTitle icon={Gauge} title="Realtime Status" subtitle={workflow?.status ?? taskStatusLabel(task.status)} />
          <div className="current-agent-row">
            {assignedAgent ? <AgentAvatar name={assignedAgent.agent_name} size={34} active={!!assignedAgent.acp_enabled} /> : <Bot className="h-7 w-7 text-[var(--color-muted)]" />}
            <div className="current-agent-copy">
              <div className="current-status-line">
                <span>Current Agent</span>
                <strong>{currentAgent}</strong>
              </div>
              <div className="current-status-line">
                <span>Current Step</span>
                <strong>{currentStep?.title ?? t('taskWorkspace.selectTaskDescription')}</strong>
              </div>
            </div>
            <i />
          </div>
          <div className="resource-metrics">
            <TaskResourceMetric label="Tokens" value={String(Math.max(0, eventGroups.visibleEvents.length * 418))} />
            <TaskResourceMetric label="Tool Calls" value={String(toolCalls.length)} />
            <TaskResourceMetric label="File Reads" value={String(eventGroups.timelineEvents.length)} />
            <TaskResourceMetric label="File Changes" value={String(fileChanges.length)} />
          </div>
        </section>

        <section className="task-detail-card timeline-card">
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
        </section>
          </>
        )}

        {activeTab === 'resources' && (
          <>
        <section className="task-detail-card file-changes-card">
          <TaskWorkspacePanelTitle icon={FileDiff} title="File Changes" subtitle={`${fileChanges.length} files`} />
          <div className="file-change-list">
            <div className="file-change-header" aria-hidden="true">
              <span>File</span>
              <strong>+</strong>
              <strong>-</strong>
            </div>
            {fileChanges.length > 0 ? fileChanges.map((file) => (
              <div key={file.name} className="file-change-row">
                <span>{file.name}</span>
                <strong className="text-[var(--color-success)]">+{file.added}</strong>
                <strong className="text-[var(--color-danger)]">-{file.removed}</strong>
              </div>
            )) : (
              <div className="file-change-empty">
                <div className="file-change-row is-empty">
                  <span>{layerVisibility.diff ? 'working-tree.diff' : 'diff-layer.hidden'}</span>
                  <strong className="text-[var(--color-success)]">+0</strong>
                  <strong className="text-[var(--color-danger)]">-0</strong>
                </div>
                <p>{layerVisibility.diff ? t('taskDetail.noDiffEvents') : t('taskDetail.diffHidden')}</p>
              </div>
            )}
          </div>
        </section>

        <section className="task-detail-card tool-calls-card">
          <TaskWorkspacePanelTitle
            icon={GitBranch}
            title="Tool Calls"
            subtitle={toolCalls.length > 0 ? `${toolCalls.length} recent` : 'preview'}
          />
          <div className="tool-call-strip">
            {displayToolCalls.map((tool) => {
              const ToolIcon = toolIconForName(tool.name);

              return (
                <div key={`${tool.name}:${tool.time}`} className="tool-call-card" data-status={tool.status} data-tool={tool.name}>
                  <ToolIcon className="h-4 w-4" strokeWidth={1.8} />
                  <strong>{tool.name}</strong>
                  <span>{tool.status}</span>
                  <time dateTime={new Date(tool.time).toISOString()}>{formatClockTime(tool.time)}</time>
                </div>
              );
            })}
          </div>
        </section>
        <section className="task-detail-card task-resources-card">
          <TaskWorkspacePanelTitle icon={FolderOpen} title="Resources" subtitle={`${attachments.length} items`} />
          <div className="task-resource-list">
            {attachments.length > 0 ? attachments.map((attachment) => (
              <div key={attachment.id} className="task-resource-row">
                <FileText className="h-3.5 w-3.5" />
                <span>{attachment.name}</span>
                <small>{attachment.mimeType ?? 'file'}</small>
              </div>
            )) : (
              <div className="workspace-empty-row">暂无任务资源。上传文件、生成文档或产生 diff 后会出现在这里。</div>
            )}
          </div>
        </section>
          </>
        )}
      </div>
    </>
  );
}

function TaskRecordsTab({
  plannerRecords,
  traceRecords,
  agentRuns,
  agentByRoomId,
  roomId,
  roomAgents,
  formatRelativeTime,
  continuing,
  onContinue,
  emptyLabel,
}: {
  plannerRecords: Array<{ message: Message; decision: PlannerDecision }>;
  traceRecords: Array<{ message: Message; trace: MessageTrace }>;
  agentRuns: AgentRun[];
  agentByRoomId: Map<string, RoomAgent>;
  roomId: string;
  roomAgents: RoomAgent[];
  formatRelativeTime: (timestamp: number) => string;
  continuing: boolean;
  onContinue: (message: Message) => void;
  emptyLabel: string;
}): JSX.Element {
  const hasRecords = plannerRecords.length > 0 || traceRecords.length > 0 || agentRuns.length > 0;
  const recordCount = plannerRecords.length + traceRecords.length + agentRuns.length;

  return (
    <section className="task-detail-card task-records-card task-tab-section">
      <TaskWorkspacePanelTitle icon={ScrollText} title="Records" subtitle={`${recordCount} items`} />
      <div className="task-record-list">
        {plannerRecords.map(({ message, decision }) => (
          <article key={message.id} className="task-record-item">
            <div className="task-record-item-header">
              <strong>规划决策</strong>
              <time>{formatRelativeTime(message.created_at)}</time>
            </div>
            <PlannerDecisionPanel
              decision={decision}
              roomAgents={roomAgents}
              continuing={continuing}
              onContinue={() => onContinue(message)}
            />
          </article>
        ))}
        {traceRecords.map(({ message, trace }) => (
          <article key={`trace:${message.id}`} className="task-record-item task-record-trace-item">
            <div className="task-record-item-header">
              <strong>ACP 流转记录</strong>
              <time>{formatRelativeTime(message.created_at)}</time>
            </div>
            <AgentTimeline trace={trace} roomId={roomId} />
          </article>
        ))}
        {agentRuns.map((run) => (
          <AgentRunStatusCard
            key={run.id}
            roomId={roomId}
            run={run}
            agent={agentByRoomId.get(run.room_agent_id)}
            compact
            defaultExpanded
          />
        ))}
        {!hasRecords && <div className="workspace-empty-row">{emptyLabel}</div>}
      </div>
    </section>
  );
}

function hasMessageTraceEvents(trace: MessageTrace | undefined): trace is MessageTrace {
  return Boolean(
    trace && (
      (trace.events?.length ?? 0) > 0 ||
      (trace.tool_calls?.length ?? 0) > 0 ||
      (trace.commands?.length ?? 0) > 0 ||
      (trace.thinking?.length ?? 0) > 0
    ),
  );
}

function messageBelongsToTask(message: Message, task: Task): boolean {
  const metadata = parseMessageMetadata(message.metadata);
  return metadata.task_id === task.id ||
    metadata.source_message_id === task.source_message_id ||
    message.id === task.source_message_id;
}

function formatClockTime(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function formatPlanStepMeta(
  step: TaskWorkspacePlanStep,
  formatRelativeTime: (timestamp: number) => string,
): string {
  const stateLabel = step.state === 'completed'
    ? 'Completed'
    : step.state === 'running'
      ? 'Running'
      : 'Waiting';
  return step.time ? `${stateLabel} · ${formatRelativeTime(step.time)}` : stateLabel;
}

function completeToolCallPreview(toolCalls: TaskWorkspaceToolCall[], fallbackTime: number): TaskWorkspaceToolCall[] {
  const canonicalNames = ['search_files', 'read_file', 'generate_preview'];
  const byName = new Map(toolCalls.map((tool) => [tool.name, tool]));
  const canonicalTools = canonicalNames.map((name) =>
    byName.get(name) ?? { name, status: 'waiting', time: fallbackTime }
  );
  const extras = toolCalls.filter((tool) => !canonicalNames.includes(tool.name));
  return [...canonicalTools, ...extras].slice(0, 3);
}

function toolIconForName(name: string): LucideIcon {
  if (name === 'read_file') {
    return FileText;
  }

  if (name === 'generate_preview') {
    return MonitorPlay;
  }

  return Search;
}
