import { CheckCircle2, ChevronDown, Copy, Eye, Loader2, PauseCircle, RotateCcw, Settings2, Sparkles, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useI18n } from '../lib/i18n';
import type { RoomAgent, TaskArtifact, WorkflowPlanJson, WorkflowPlanTaskJson, WorkflowStage, WorkflowStep } from '../lib/types';
import { cn } from '../lib/utils';

type TranslateFn = ReturnType<typeof useI18n>['t'];

export function WorkflowTaskFlow({
  plan,
  agents,
  steps,
  artifacts,
  compact = false,
}: {
  plan: WorkflowPlanJson;
  agents: RoomAgent[];
  steps: WorkflowStep[];
  artifacts: TaskArtifact[];
  compact?: boolean;
}) {
  const { t, workflowStageLabel } = useI18n();
  const flowEntries = useMemo(
    () => buildFlowEntries(plan, agents, steps, artifacts, workflowStageLabel, t),
    [agents, artifacts, plan, steps, t, workflowStageLabel],
  );
  const stagePanels = useMemo(() => buildStagePanels(flowEntries, t), [flowEntries, t]);
  const executorTaskCount = plan.tasks.filter((task) => task.role === 'executor').length;
  const recordCount = steps.length + artifacts.length;
  const progressStats = useMemo(() => buildProgressStats(flowEntries), [flowEntries]);
  const [selectedStageKey, setSelectedStageKey] = useState<FlowStagePanel['key']>('plan');
  const [selectedEntryKey, setSelectedEntryKey] = useState<string | null>(null);
  const activeStage = stagePanels.find((stage) => stage.key === selectedStageKey && stage.entries.length > 0)
    ?? stagePanels.find((stage) => stage.entries.length > 0)
    ?? stagePanels[0];
  const activeEntry = activeStage.entries.find((entry) => entry.key === selectedEntryKey)
    ?? activeStage.entries[0]
    ?? null;
  const activeStageStats = useMemo(() => buildProgressStats(activeStage.entries), [activeStage]);
  const activeEntryIndex = Math.max(activeStage.entries.findIndex((entry) => entry.key === activeEntry?.key), 0) + 1;
  void compact;

  return (
    <section className="workflow-flow-panel">
      <div className="workflow-flow-header">
        <div className="font-display text-[12.5px] font-semibold">{t('workflowPlan.taskFlowTitle')}</div>
        <div className="workflow-flow-summary">
          <span>{t('workflowPlan.taskFlowPlanItems', { count: executorTaskCount })}</span>
          <span>{t('workflowPlan.taskFlowRecords', { count: recordCount })}</span>
          <button className="workflow-flow-filter-button" type="button">
            {t('workflowPlan.taskFlowAllStatus')}
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button className="workflow-flow-icon-button" type="button" aria-label={t('workflowPlan.taskFlowViewOptions')}>
            <Settings2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {flowEntries.length > 0 ? (
        <>
        <div className="workflow-flow-top-row">
          <div className="workflow-flow-overview">
            {stagePanels.map((stage) => (
              <button
                key={stage.key}
                className={cn('workflow-flow-overview-step', `is-${stage.key}`, activeStage.key === stage.key && 'is-active')}
                type="button"
                onClick={() => {
                  setSelectedStageKey(stage.key);
                  setSelectedEntryKey(null);
                }}
              >
                <div className="workflow-flow-overview-icon">{stage.icon}</div>
                <div className="workflow-flow-overview-copy">
                  <div className="workflow-flow-overview-title">{stage.label}</div>
                  <div className="workflow-flow-overview-meta">
                    <span>{stage.completedCount}/{stage.entries.length}</span>
                    <b>{stage.percent}%</b>
                  </div>
                  <div className="workflow-flow-stage-bar" style={{ '--workflow-stage-progress': `${stage.percent}%` } as React.CSSProperties} />
                </div>
              </button>
            ))}
          </div>
          <div className="workflow-flow-progress-card">
            <div className="workflow-flow-progress-ring" style={{ '--workflow-progress': `${progressStats.percent}%` } as React.CSSProperties}>
              <span>{progressStats.percent}%</span>
            </div>
            <div className="workflow-flow-progress-copy">
              <div className="workflow-flow-progress-title">{t('workflowPlan.taskFlowOverallProgress')}</div>
              <div className="workflow-flow-progress-grid">
                <span className="is-completed">{t('workflowPlan.taskFlowCompleted')}</span><b>{progressStats.completed}</b>
                <span className="is-running">{t('workflowPlan.taskFlowRunning')}</span><b>{progressStats.running}</b>
                <span className="is-pending">{t('workflowPlan.taskFlowPending')}</span><b>{progressStats.pending}</b>
                <span className="is-blocked">{t('workflowPlan.taskFlowBlocked')}</span><b>{progressStats.blocked}</b>
              </div>
            </div>
          </div>
        </div>

        <div className="workflow-flow-detail-shell">
          <section className="workflow-flow-detail-panel">
            {activeEntry ? (
              <>
              <div className="workflow-flow-detail-head">
                <div className="workflow-flow-detail-title">
                  <span className="workflow-flow-detail-index">{activeEntryIndex}</span>
                  <span className="workflow-flow-detail-title-copy">
                    <b>{activeStage.label}</b>
                    <small>{activeEntry.shortTitle}</small>
                  </span>
                  <span className={cn('workflow-flow-status-pill', `is-${activeEntry.meta}`)}>{activeEntry.displayStatus}</span>
                </div>
                <div className="workflow-flow-detail-meta">
                  <span>{t('workflowPlan.taskFlowAssignee')}</span><b>{activeEntry.executorName}</b>
                  <span>{t('workflowPlan.taskFlowStartTime')}</span><b>{formatFlowTime(activeEntry.startedAt ?? activeEntry.sortKey)}</b>
                  <span>{t('workflowPlan.taskFlowDuration')}</span><b>{formatFlowDuration(activeEntry.startedAt, activeEntry.completedAt)}</b>
                </div>
              </div>

              <div className="workflow-flow-stat-grid">
                <FlowStatCard label={t('workflowPlan.taskFlowTotalTasks')} value={activeStage.entries.length} tone="neutral" />
                <FlowStatCard label={t('workflowPlan.taskFlowCompleted')} value={activeStageStats.completed} tone="success" />
                <FlowStatCard label={t('workflowPlan.taskFlowRunning')} value={activeStageStats.running} tone="primary" />
                <FlowStatCard label={t('workflowPlan.taskFlowPending')} value={activeStageStats.pending} tone="muted" />
                <FlowStatCard label={t('workflowPlan.taskFlowBlocked')} value={activeStageStats.blocked} tone="danger" />
                <FlowStatCard label={t('workflowPlan.taskFlowCompletionRate')} value={`${activeStage.percent}%`} tone="success" strong />
              </div>

              <div className="workflow-flow-section-title">{t('workflowPlan.taskFlowTaskList')}</div>
              <div className="workflow-flow-task-cards">
                {activeStage.entries.map((entry) => (
                  <div key={entry.key} className={cn('workflow-flow-task-card', `is-${entry.phase}`)}>
                    <div className="workflow-flow-task-card-main">
                      <CheckCircle2 className={cn('h-4 w-4', entry.meta === 'completed' ? 'text-[var(--color-primary)]' : 'text-[var(--color-muted)]')} />
                      <div className="workflow-flow-task-card-copy">
                        <div className="workflow-flow-task-card-title">{entry.taskName}</div>
                        <div className="workflow-flow-task-card-meta">
                          <span>{entry.phaseLabel}</span>
                          <span>{entry.executorName}</span>
                          <span>{formatFlowTime(entry.completedAt ?? entry.startedAt ?? entry.sortKey)}</span>
                        </div>
                      </div>
                      <span className={cn('workflow-flow-status-pill', `is-${entry.meta}`)}>{entry.displayStatus}</span>
                      <span className="workflow-flow-task-actions">
                        <Eye className="h-3.5 w-3.5" />
                        <Copy className="h-3.5 w-3.5" />
                      </span>
                    </div>
                    <div className="workflow-event-stack">
                      {entry.events.map((event) => (
                        <div key={event.key} className="workflow-event-item">
                          <span>{event.time}</span>
                          <CheckCircle2 className={cn('h-3.5 w-3.5', event.active ? 'text-[var(--color-primary)]' : 'text-[var(--color-success)]')} />
                          <span>{event.label}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              </>
            ) : (
              <div className="workflow-flow-empty">{t('workflowPlan.taskFlowEmpty')}</div>
            )}
          </section>
        </div>
        </>
      ) : (
        <div className="workflow-flow-empty">{t('workflowPlan.taskFlowEmpty')}</div>
      )}
    </section>
  );
}

interface FlowStagePanel {
  key: 'plan' | 'execution' | 'review' | 'done';
  label: string;
  caption: string;
  icon: React.ReactNode;
  percent: number;
  completedCount: number;
  entries: FlowEntry[];
}

interface FlowEntry {
  key: string;
  phase: 'plan' | 'execution' | 'review' | 'verification' | 'acceptance';
  phaseLabel: string;
  title: string;
  shortTitle: string;
  taskName: string;
  subtitle: string | null;
  meta: string;
  displayStatus: string;
  content: string | null;
  icon: React.ReactNode;
  executor: string;
  executorName: string;
  sortKey: number;
  startedAt: number | null;
  completedAt: number | null;
  events: FlowEvent[];
}

interface FlowEvent {
  key: string;
  time: string;
  label: string;
  active: boolean;
}

function FlowStatCard({
  label,
  value,
  tone,
  strong = false,
}: {
  label: string;
  value: string | number;
  tone: 'neutral' | 'success' | 'primary' | 'muted' | 'danger';
  strong?: boolean;
}) {
  return (
    <div className={cn('workflow-flow-stat-card', `is-${tone}`, strong && 'is-strong')}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function buildStagePanels(flowEntries: FlowEntry[], t: TranslateFn): FlowStagePanel[] {
  const panels = [
    {
      key: 'plan',
      label: `${t('workflowPlan.taskFlowPlanStage')} / ${t('workflowPlan.taskFlowAnalysisStage')}`,
      caption: t('workflowPlan.taskFlowPlanLaneCaption'),
      icon: <RotateCcw className="h-5 w-5 text-[var(--color-primary)]" />,
      entries: flowEntries.filter((entry) => entry.phase === 'plan'),
    },
    {
      key: 'execution',
      label: t('workflowPlan.taskFlowExecutionLane'),
      caption: t('workflowPlan.taskFlowExecutionLaneCaption'),
      icon: <CheckCircle2 className="h-5 w-5 text-[var(--color-success)]" />,
      entries: flowEntries.filter((entry) => entry.phase === 'execution'),
    },
    {
      key: 'review',
      label: t('workflowPlan.taskFlowReviewLane'),
      caption: t('workflowPlan.taskFlowReviewLaneCaption'),
      icon: <Sparkles className="h-5 w-5 text-[var(--color-warning)]" />,
      entries: flowEntries.filter((entry) =>
        entry.phase === 'review' || entry.phase === 'verification',
      ),
    },
    {
      key: 'done',
      label: t('workflowPlan.taskFlowDoneLane'),
      caption: t('workflowPlan.taskFlowDoneLaneCaption'),
      icon: <CheckCircle2 className="h-5 w-5 text-[var(--color-success)]" />,
      entries: flowEntries.filter((entry) => entry.phase === 'acceptance'),
    },
  ] satisfies Array<Omit<FlowStagePanel, 'percent' | 'completedCount'>>;

  return panels.map((panel) => ({
    ...panel,
    completedCount: getCompletedCount(panel.entries),
    percent: calculateEntryPercent(panel.entries),
  }));
}

function getCompletedCount(entries: FlowEntry[]): number {
  return entries.filter((entry) => entry.meta === 'completed').length;
}

function calculateEntryPercent(entries: FlowEntry[]): number {
  if (entries.length === 0) return 0;
  const completed = getCompletedCount(entries);
  return Math.round((completed / entries.length) * 100);
}

function buildProgressStats(entries: FlowEntry[]) {
  const completed = entries.filter((entry) => entry.meta === 'completed').length;
  const running = entries.filter((entry) => entry.meta === 'running').length;
  const blocked = entries.filter((entry) => entry.meta === 'blocked' || entry.meta === 'failed').length;
  const pending = Math.max(entries.length - completed - running - blocked, 0);
  const percent = entries.length > 0 ? Math.round((completed / entries.length) * 100) : 0;
  return { completed, running, pending, blocked, percent };
}

function buildFlowEntries(
  plan: WorkflowPlanJson,
  agents: RoomAgent[],
  steps: WorkflowStep[],
  artifacts: TaskArtifact[],
  workflowStageLabel: (stage: WorkflowStage) => string,
  t: TranslateFn,
): FlowEntry[] {
  const taskMap = new Map(plan.tasks.map((task) => [task.id, task]));
  const agentMap = new Map(agents.map((agent) => [agent.id, agent]));
  const entries: Array<FlowEntry & { sortKey: number; sequence: number }> = [];

  for (const [index, step] of steps.entries()) {
    const task = taskMap.get(step.task_id) ?? null;
    const sortKey = step.completed_at ?? step.started_at ?? step.updated_at ?? step.created_at ?? index;
    const executorId = step.assigned_room_agent_id ?? step.room_agent_id ?? task?.agent_id ?? 'codex';
    const baseEntry = createFlowEntryBase(step, task, executorId, agentMap, t);

    if (step.stage === 'implementation') {
      entries.push({
        key: `step:${step.id}`,
        phase: 'execution',
        phaseLabel: t('workflowPlan.taskFlowExecutionStage'),
        sortKey,
        sequence: index,
        title: task?.title ?? workflowStageLabel(step.stage),
        shortTitle: task?.title ?? workflowStageLabel(step.stage),
        taskName: task?.title ?? workflowStageLabel(step.stage),
        subtitle: step.node_name ? step.node_name : null,
        ...baseEntry,
        content: step.result || step.error || null,
        icon: step.status === 'completed'
          ? <CheckCircle2 className="h-3.5 w-3.5 text-[var(--color-success)]" />
          : step.status === 'running'
            ? <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--color-accent)]" />
            : <PauseCircle className="h-3.5 w-3.5 text-[var(--color-warning)]" />,
      });
      continue;
    }

    if (step.stage === 'code_review') {
      if (step.node_name === 'verify') {
        entries.push({
          key: `verify:${step.id}`,
          phase: 'verification',
          phaseLabel: t('workflowPlan.taskFlowVerification'),
          sortKey,
          sequence: index,
          title: t('workflowPlan.taskFlowVerification'),
          shortTitle: t('workflowPlan.taskFlowVerification'),
          taskName: task?.title ?? t('workflowPlan.taskFlowVerification'),
          subtitle: task?.title ?? workflowStageLabel(step.stage),
          ...baseEntry,
          content: step.result || step.error || null,
          icon: step.status === 'completed'
            ? <CheckCircle2 className="h-3.5 w-3.5 text-[var(--color-success)]" />
            : step.status === 'running'
              ? <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--color-accent)]" />
              : <PauseCircle className="h-3.5 w-3.5 text-[var(--color-warning)]" />,
        });
        continue;
      }

      const reviewedTask = findLatestImplementationTitleBefore(steps, sortKey, taskMap);
      entries.push({
        key: `review:${step.id}`,
        phase: 'review',
        phaseLabel: t('workflowPlan.taskFlowReviewStage'),
        sortKey,
        sequence: index,
        title: reviewedTask
          ? `${t('workflowPlan.taskFlowReviewTarget')} · ${reviewedTask}`
          : workflowStageLabel(step.stage),
        shortTitle: task?.title ?? t('workflowPlan.taskFlowReviewStage'),
        taskName: task?.title ?? reviewedTask ?? t('workflowPlan.taskFlowReviewStage'),
        subtitle: task?.title ?? null,
        ...baseEntry,
        content: step.result || step.error || null,
        icon: <Sparkles className="h-3.5 w-3.5 text-[var(--color-primary)]" />,
      });
      continue;
    }

    if (step.stage === 'acceptance') {
      const acceptanceTarget = findLatestImplementationTitleBefore(steps, sortKey, taskMap) ?? plan.workflow_name;
      entries.push({
        key: `acceptance:${step.id}`,
        phase: 'acceptance',
        phaseLabel: t('workflowPlan.taskFlowAcceptanceStage'),
        sortKey,
        sequence: index,
        title: `${t('workflowPlan.taskFlowAcceptanceTarget')} · ${acceptanceTarget}`,
        shortTitle: task?.title ?? t('workflowPlan.taskFlowAcceptanceStage'),
        taskName: task?.title ?? acceptanceTarget,
        subtitle: task?.title ?? null,
        ...baseEntry,
        content: step.result || step.error || null,
        icon: <CheckCircle2 className="h-3.5 w-3.5 text-[var(--color-success)]" />,
      });
      continue;
    }

    entries.push({
      key: `step:${step.id}`,
      phase: 'plan',
      phaseLabel: t('workflowPlan.taskFlowPlanStage'),
      sortKey,
      sequence: index,
      title: workflowStageLabel(step.stage),
      shortTitle: workflowStageLabel(step.stage),
      taskName: task?.title ?? workflowStageLabel(step.stage),
      subtitle: task?.title ?? null,
      ...baseEntry,
      content: step.result || step.error || null,
      icon: step.status === 'failed' || step.status === 'interrupted'
        ? <XCircle className="h-3.5 w-3.5 text-[var(--color-danger)]" />
        : <RotateCcw className="h-3.5 w-3.5 text-[var(--color-muted)]" />,
    });
  }

  for (const artifact of artifacts) {
    if (artifact.artifact_type !== 'review' && artifact.artifact_type !== 'acceptance') continue;
    const relatedStep = steps.find((step) => step.id === artifact.workflow_step_id);
    const artifactTask = taskMap.get(artifact.task_id);
    const executorId = relatedStep?.assigned_room_agent_id ?? relatedStep?.room_agent_id ?? artifactTask?.agent_id ?? 'codex';
    entries.push({
      key: `artifact:${artifact.id}`,
      phase: artifact.artifact_type === 'review' ? 'review' : 'acceptance',
      phaseLabel: artifact.artifact_type === 'review'
        ? t('workflowPlan.taskFlowReviewStage')
        : t('workflowPlan.taskFlowAcceptanceStage'),
      sortKey: artifact.created_at,
      sequence: steps.length + entries.length,
      title: artifact.title,
      shortTitle: artifact.title,
      taskName: artifactTask?.title ?? artifact.title,
      subtitle: relatedStep ? workflowStageLabel(relatedStep.stage) : null,
      meta: artifact.artifact_type,
      displayStatus: artifact.artifact_type === 'review'
        ? t('workflowPlan.taskFlowReviewStage')
        : t('workflowPlan.taskFlowAcceptanceStage'),
      content: artifact.content,
      executor: executorId,
      executorName: getAgentDisplayName(executorId, agentMap),
      startedAt: relatedStep?.started_at ?? artifact.created_at,
      completedAt: relatedStep?.completed_at ?? artifact.created_at,
      events: buildEntryEvents({
        key: `artifact:${artifact.id}`,
        startedAt: relatedStep?.started_at ?? artifact.created_at,
        completedAt: relatedStep?.completed_at ?? artifact.created_at,
        sortKey: artifact.created_at,
        status: 'completed',
        content: artifact.content,
      }, t),
      icon: <Sparkles className="h-3.5 w-3.5 text-[var(--color-accent)]" />,
    });
  }

  return entries.sort((a, b) => a.sortKey - b.sortKey || a.sequence - b.sequence);
}

function createFlowEntryBase(
  step: WorkflowStep,
  task: WorkflowPlanTaskJson | null,
  executorId: string,
  agentMap: Map<string, RoomAgent>,
  t: TranslateFn,
) {
  const sortKey = step.completed_at ?? step.started_at ?? step.updated_at ?? step.created_at;
  return {
    meta: step.status,
    displayStatus: getWorkflowStatusLabel(step.status, t),
    executor: executorId,
    executorName: getAgentDisplayName(executorId, agentMap, task),
    startedAt: step.started_at,
    completedAt: step.completed_at,
    events: buildEntryEvents({
      key: `step:${step.id}`,
      startedAt: step.started_at,
      completedAt: step.completed_at,
      sortKey,
      status: step.status,
      content: step.result || step.error || null,
    }, t),
  };
}

function getWorkflowStatusLabel(status: string, t: TranslateFn): string {
  switch (status) {
    case 'completed':
      return t('workflowPlan.status.completed');
    case 'running':
      return t('workflowPlan.status.running');
    case 'pending':
      return t('workflowPlan.status.pending');
    case 'blocked':
      return t('workflowPlan.status.blocked');
    case 'failed':
      return t('workflowPlan.status.failed');
    case 'skipped':
      return t('workflowPlan.status.skipped');
    default:
      return status;
  }
}

function getAgentDisplayName(
  agentId: string,
  agentMap: Map<string, RoomAgent>,
  task?: WorkflowPlanTaskJson | null,
): string {
  const agent = agentMap.get(agentId);
  return agent?.agent_name ?? agent?.preferred_user_name ?? agent?.workflow_role ?? task?.agent_id ?? shortAgentId(agentId);
}

function shortAgentId(agentId: string): string {
  if (!agentId) return '--';
  return agentId.length > 12 ? `${agentId.slice(0, 6)}...${agentId.slice(-4)}` : agentId;
}

function formatFlowTime(value: number | null): string {
  if (!value) return '--';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(value);
}

function formatFlowDuration(startedAt: number | null, completedAt: number | null): string {
  if (!startedAt || !completedAt || completedAt < startedAt) return '--';
  const seconds = Math.max(Math.round((completedAt - startedAt) / 1000), 1);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes === 0) return `${remainingSeconds}s`;
  return `${minutes}m ${remainingSeconds}s`;
}

function buildEntryEvents(
  entry: {
    key: string;
    startedAt: number | null;
    completedAt: number | null;
    sortKey: number;
    status: string;
    content: string | null;
  },
  t: TranslateFn,
): FlowEvent[] {
  const events: FlowEvent[] = [
    {
      key: `${entry.key}:created`,
      time: formatFlowTime(entry.sortKey),
      label: t('workflowPlan.taskFlowLogCreated'),
      active: false,
    },
  ];
  if (entry.startedAt) {
    events.push({
      key: `${entry.key}:started`,
      time: formatFlowTime(entry.startedAt),
      label: t('workflowPlan.taskFlowLogRunning'),
      active: entry.status === 'running',
    });
  }
  if (entry.content?.trim()) {
    events.push({
      key: `${entry.key}:result`,
      time: formatFlowTime(entry.completedAt ?? entry.startedAt ?? entry.sortKey),
      label: t('workflowPlan.taskFlowLogResult'),
      active: entry.status === 'running',
    });
  }
  if (entry.completedAt) {
    events.push({
      key: `${entry.key}:completed`,
      time: formatFlowTime(entry.completedAt),
      label: t('workflowPlan.taskFlowLogCompleted'),
      active: false,
    });
  }
  return events;
}

function findLatestImplementationTitleBefore(
  steps: WorkflowStep[],
  currentSortKey: number,
  taskMap: Map<string, WorkflowPlanTaskJson>,
): string | null {
  return steps
    .filter((step) => {
      if (step.stage !== 'implementation') return false;
      const sortKey = step.completed_at ?? step.started_at ?? step.updated_at ?? step.created_at ?? 0;
      return sortKey <= currentSortKey;
    })
    .sort((a, b) => {
      const left = a.completed_at ?? a.started_at ?? a.updated_at ?? a.created_at ?? 0;
      const right = b.completed_at ?? b.started_at ?? b.updated_at ?? b.created_at ?? 0;
      return right - left;
    })
    .map((step) => taskMap.get(step.task_id)?.title ?? step.task_id)[0] ?? null;
}
