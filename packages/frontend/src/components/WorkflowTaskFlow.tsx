import { CheckCircle2, Copy, Eye, Flag, Loader2, PauseCircle, RotateCcw, Sparkles, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../lib/i18n';
import type { Message, RoomAgent, TaskArtifact, WorkflowPlanJson, WorkflowPlanTaskJson, WorkflowStage, WorkflowStep } from '../lib/types';
import { cn } from '../lib/utils';
import { Dialog, DialogContent } from './ui/Dialog';

type TranslateFn = ReturnType<typeof useI18n>['t'];

export function WorkflowTaskFlow({
  plan,
  agents,
  steps,
  artifacts,
  eventMessages = [],
  childTaskPlanIndexes = {},
  compact = false,
}: {
  plan: WorkflowPlanJson;
  agents: RoomAgent[];
  steps: WorkflowStep[];
  artifacts: TaskArtifact[];
  eventMessages?: Message[];
  childTaskPlanIndexes?: Record<string, number>;
  compact?: boolean;
}) {
  const { t, workflowStageLabel } = useI18n();
  const flowEntries = useMemo(
    () => buildFlowEntries(plan, agents, steps, artifacts, workflowStageLabel, t, childTaskPlanIndexes),
    [agents, artifacts, childTaskPlanIndexes, plan, steps, t, workflowStageLabel],
  );
  const stagePanels = useMemo(() => buildStagePanels(flowEntries, t), [flowEntries, t]);
  const executorTaskCount = plan.tasks.filter((task) => task.role === 'executor').length;
  const recordCount = steps.length + artifacts.length;
  const timelineEvents = useMemo(
    () => buildTimelineEvents(flowEntries, eventMessages),
    [eventMessages, flowEntries],
  );
  const firstPopulatedStageKey = stagePanels.find((stage) => stage.entries.length > 0)?.key ?? null;
  const [selectedStageKey, setSelectedStageKey] = useState<FlowStagePanel['key'] | null>(null);
  const [selectedEntryKey, setSelectedEntryKey] = useState<string | null>(null);
  const [detailEntry, setDetailEntry] = useState<FlowEntry | null>(null);
  const activeStage = stagePanels.find((stage) => stage.key === selectedStageKey && (selectedStageKey !== null || stage.entries.length > 0))
    ?? (selectedStageKey === null ? stagePanels.find((stage) => stage.key === firstPopulatedStageKey) : null)
    ?? stagePanels.find((stage) => stage.entries.length > 0)
    ?? stagePanels[0];
  const selectedEntry = flowEntries.find((entry) => entry.key === selectedEntryKey) ?? null;
  const activeEntry = selectedEntry && stageKeyForPhase(selectedEntry.phase) === activeStage.key
    ? selectedEntry
    : (activeStage.entries[0] ?? null);
  const activeStageStats = useMemo(() => buildProgressStats(activeStage.entries), [activeStage]);
  const activeEntryIndex = activeEntry ? flowEntries.findIndex((entry) => entry.key === activeEntry.key) + 1 : 0;
  useEffect(() => {
    if (selectedStageKey !== null) return;
    if (firstPopulatedStageKey === null) return;
    setSelectedStageKey(firstPopulatedStageKey);
  }, [firstPopulatedStageKey, selectedStageKey]);
  void compact;

  return (
    <section className="workflow-flow-panel">
      {flowEntries.length > 0 ? (
        <div className="workflow-flow-layout">
          <aside className="workflow-flow-sidebar">
            <div className="workflow-flow-sidebar-title">
              <b>{activeStage.label}</b>
              <span>{activeStage.completedCount}/{activeStage.entries.length || 0}</span>
            </div>
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
                <div className="workflow-flow-overview-icon">{stage.index}</div>
                <div className="workflow-flow-overview-copy">
                  <div className="workflow-flow-overview-title">
                    <span className="workflow-flow-stage-name"><span className="workflow-flow-stage-symbol">{stage.icon}</span>{stage.label}</span>
                    <span className={cn('workflow-flow-status-pill', stage.percent === 100 ? 'is-completed' : stage.entries.length > 0 ? 'is-running' : 'is-pending')}>
                      {stage.percent === 100 ? t('workflowPlan.status.completed') : stage.entries.length > 0 ? t('workflowPlan.status.running') : t('workflowPlan.status.pending')}
                    </span>
                  </div>
                  <div className="workflow-flow-stage-bar" style={{ '--workflow-stage-progress': `${stage.percent}%` } as React.CSSProperties} />
                </div>
                <span className="workflow-flow-stage-arrow">›</span>
              </button>
            ))}
            <div className="workflow-flow-sidebar-foot">
              <span>{t('workflowPlan.taskFlowPlanItems', { count: executorTaskCount })}</span>
              <span>{t('workflowPlan.taskFlowRecords', { count: recordCount })}</span>
            </div>
          </aside>

          <section className="workflow-flow-detail-panel">
            {activeEntry ? (
              <>
              <div className="workflow-flow-detail-head">
                <div className="workflow-flow-detail-title">
                  <span className="workflow-flow-detail-index">{activeEntryIndex}</span>
                  <span className="workflow-flow-detail-title-copy">
                    <b>{activeStage.label}</b>
                    <small>{activeEntry.title}</small>
                  </span>
                  <span className={cn('workflow-flow-status-pill', `is-${activeEntry.meta}`)}>{activeEntry.displayStatus}</span>
                  <span className="workflow-flow-detail-spark"><Sparkles className="h-3.5 w-3.5" /></span>
                </div>
                <div className="workflow-flow-detail-meta">
                  <span>{t('workflowPlan.taskFlowAssignee')}</span><b>{activeEntry.executorName}</b>
                  <span>{t('workflowPlan.taskFlowStartTime')}</span><b>{formatFlowTime(activeEntry.startedAt ?? activeEntry.sortKey)}</b>
                  <span>{t('workflowPlan.taskFlowDuration')}</span><b>{formatFlowDuration(activeEntry.startedAt, activeEntry.completedAt)}</b>
                </div>
              </div>

              <div className="workflow-flow-stat-grid">
                <FlowStatCard icon={<Flag className="h-3.5 w-3.5" />} label={t('workflowPlan.taskFlowTotalTasks')} value={activeStage.entries.length} tone="neutral" />
                <FlowStatCard icon={<CheckCircle2 className="h-3.5 w-3.5" />} label={t('workflowPlan.taskFlowCompleted')} value={activeStageStats.completed} tone="success" />
                <FlowStatCard icon={<Loader2 className="h-3.5 w-3.5" />} label={t('workflowPlan.taskFlowRunning')} value={activeStageStats.running} tone="primary" />
                <FlowStatCard icon={<PauseCircle className="h-3.5 w-3.5" />} label={t('workflowPlan.taskFlowPending')} value={activeStageStats.pending} tone="muted" />
                <FlowStatCard icon={<XCircle className="h-3.5 w-3.5" />} label={t('workflowPlan.taskFlowBlocked')} value={activeStageStats.blocked} tone="danger" />
                <FlowStatCard icon={<CheckCircle2 className="h-3.5 w-3.5" />} label={t('workflowPlan.taskFlowCompletionRate')} value={`${activeStage.percent}%`} tone="success" strong />
              </div>

              <div className="workflow-flow-section-title">{t('workflowPlan.taskFlowTaskList')}</div>
              <div className="workflow-flow-task-cards">
                {flowEntries.map((entry) => (
                  <div
                    key={entry.key}
                    className={cn('workflow-flow-task-card', `is-${entry.phase}`, activeEntry.key === entry.key && 'is-selected')}
                  >
                    <button
                      className="workflow-flow-task-card-main"
                      type="button"
                      onClick={() => {
                        setSelectedStageKey(stageKeyForPhase(entry.phase));
                        setSelectedEntryKey(entry.key);
                      }}
                    >
                      <CheckCircle2 className={cn('h-4 w-4', entry.meta === 'completed' ? 'text-[var(--color-primary)]' : 'text-[var(--color-muted)]')} />
                      <div className="workflow-flow-task-card-copy">
                        <div className="workflow-flow-task-card-title">{entry.title}</div>
                        <div className="workflow-flow-task-card-meta">
                          <span>{entry.executorName}</span>
                          <span>{formatFlowTime(entry.completedAt ?? entry.startedAt ?? entry.sortKey)}</span>
                        </div>
                      </div>
                      <span className={cn('workflow-flow-status-pill', `is-${entry.meta}`)}>{entry.displayStatus}</span>
                    </button>
                    <span className="workflow-flow-task-actions">
                      <button
                        type="button"
                        className="workflow-flow-task-action-button"
                        aria-label={t('workflowPlan.viewTaskDetail', { title: entry.title })}
                        title={t('workflowPlan.viewDetail')}
                        onClick={() => setDetailEntry(entry)}
                      >
                        <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="workflow-flow-task-action-button"
                        aria-label={t('message.copy')}
                        title={t('message.copy')}
                        onClick={() => copyFlowEntry(entry, t)}
                      >
                        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </span>
                  </div>
                ))}
              </div>

              <div className="workflow-flow-section-title">{t('workflowPlan.taskFlowExecutionLog')}</div>
              <div className="workflow-event-stack">
                {timelineEvents.map((event) => (
                  <div key={event.key} className="workflow-event-item">
                    <span>{event.time}</span>
                    <CheckCircle2 className={cn('h-3.5 w-3.5', event.active ? 'text-[var(--color-primary)]' : 'text-[var(--color-success)]')} />
                    <span>{event.label}</span>
                  </div>
                ))}
              </div>
              </>
            ) : (
              <div className="workflow-flow-empty">{t('workflowPlan.taskFlowEmpty')}</div>
            )}
          </section>
        </div>
      ) : (
        <div className="workflow-flow-empty">{t('workflowPlan.taskFlowEmpty')}</div>
      )}
      <Dialog open={Boolean(detailEntry)} onOpenChange={(open) => !open && setDetailEntry(null)}>
        <DialogContent
          className="workflow-task-detail-dialog"
          title={detailEntry?.title ?? t('workflowPlan.detailTitle')}
          description={detailEntry ? t('workflowPlan.detailDescription') : undefined}
        >
          {detailEntry && <WorkflowFlowEntryDetail entry={detailEntry} />}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function WorkflowFlowEntryDetail({ entry }: { entry: FlowEntry }) {
  const { t } = useI18n();
  return (
    <div className="workflow-task-detail-content">
      <dl className="workflow-task-detail-grid">
        <DetailField label={t('workflowPlan.detailStatus')} value={entry.displayStatus} />
        <DetailField label={t('workflowPlan.taskFlowAssignee')} value={entry.executorName} />
        <DetailField label={t('workflowPlan.taskFlowStartTime')} value={formatFlowTime(entry.startedAt ?? entry.sortKey)} />
        <DetailField label={t('workflowPlan.taskFlowDuration')} value={formatFlowDuration(entry.startedAt, entry.completedAt)} />
      </dl>
      <DetailSection label={t('workflowPlan.taskFlowTaskContent')}>{getFlowEntryContent(entry, t)}</DetailSection>
      <DetailList label={t('workflowPlan.taskFlowExecutionLog')} items={entry.events.map((event) => `${event.time} ${event.label}`)} />
    </div>
  );
}

function copyFlowEntry(entry: FlowEntry, t: TranslateFn): void {
  const text = [
    entry.title,
    entry.subtitle,
    getFlowEntryContent(entry, t),
    ...entry.events.map((event) => `${event.time} ${event.label}`),
  ].filter((item): item is string => Boolean(item?.trim())).join('\n');
  void navigator.clipboard?.writeText(text);
}

function getFlowEntryContent(entry: FlowEntry, t: TranslateFn): string {
  const content = entry.content?.trim();
  if (content) return content;
  if (entry.phase === 'execution') return entry.taskName;
  return entry.subtitle ?? t('workflowPlan.taskFlowNoIndependentOutput');
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function DetailSection({ label, children }: { label: string; children: string }) {
  return (
    <section className="workflow-task-detail-section">
      <h4>{label}</h4>
      <p>{children}</p>
    </section>
  );
}

function DetailList({ label, items }: { label: string; items: string[] }) {
  return (
    <section className="workflow-task-detail-section">
      <h4>{label}</h4>
      {items.length > 0 ? (
        <ul>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : (
        <p>--</p>
      )}
    </section>
  );
}

interface FlowStagePanel {
  key: 'plan' | 'execution' | 'review' | 'done';
  index: number;
  label: string;
  caption: string;
  icon: React.ReactNode;
  percent: number;
  completedCount: number;
  executorName: string;
  updatedAt: number | null;
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
  sortKey: number;
  active: boolean;
}

function FlowStatCard({
  icon,
  label,
  value,
  tone,
  strong = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  tone: 'neutral' | 'success' | 'primary' | 'muted' | 'danger';
  strong?: boolean;
}) {
  return (
    <div className={cn('workflow-flow-stat-card', `is-${tone}`, strong && 'is-strong')}>
      <span className="workflow-flow-stat-icon">{icon}</span>
      <span className="workflow-flow-stat-label">{label}</span>
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
  ] satisfies Array<Omit<FlowStagePanel, 'index' | 'percent' | 'completedCount' | 'executorName' | 'updatedAt'>>;

  return panels.map((panel) => ({
    ...panel,
    index: panels.findIndex((item) => item.key === panel.key) + 1,
    completedCount: getCompletedCount(panel.entries),
    executorName: getStageExecutorName(panel.entries),
    updatedAt: getLatestEntryTime(panel.entries),
    percent: calculateEntryPercent(panel.entries),
  }));
}

const SUPERPOWERS_STAGE_LABELS: Partial<Record<string, string>> = {
  brainstorming: '头脑风暴',
  spec_review: '设计审查',
  worktree: 'Git Worktree',
  writing_plans: '编写计划',
  plan_review: '计划审查',
  tdd_execute: 'TDD 执行',
  spec_compliance_review: '规格符合审查',
  code_quality_review: '代码质量审查',
  finish_branch: '分支收口',
};

function formatWorkflowNodeLabel(step: WorkflowStep, workflowStageLabel: (stage: WorkflowStage) => string): string {
  return step.node_name && step.node_name in SUPERPOWERS_STAGE_LABELS
    ? SUPERPOWERS_STAGE_LABELS[step.node_name]!
    : workflowStageLabel(step.stage);
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

function buildTimelineEvents(entries: FlowEntry[], eventMessages: Message[]): FlowEvent[] {
  const seen = new Set<string>();
  return [
    ...entries.flatMap((entry) => entry.events),
    ...eventMessages.map((message) => ({
      key: `message:${message.id}`,
      time: formatFlowTime(message.created_at),
      sortKey: message.created_at,
      label: message.content,
      active: false,
    })),
  ]
    .filter((event) => event.label.trim().length > 0)
    .filter((event) => {
      const key = `${event.time}:${event.label}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.sortKey - b.sortKey || a.key.localeCompare(b.key));
}

function getStageExecutorName(entries: FlowEntry[]): string {
  return entries.find((entry) => entry.executorName && entry.executorName !== '--')?.executorName ?? '--';
}

function getLatestEntryTime(entries: FlowEntry[]): number | null {
  return entries.reduce<number | null>((latest, entry) => {
    const value = entry.completedAt ?? entry.startedAt ?? entry.sortKey;
    return latest === null || value > latest ? value : latest;
  }, null);
}

function buildFlowEntries(
  plan: WorkflowPlanJson,
  agents: RoomAgent[],
  steps: WorkflowStep[],
  artifacts: TaskArtifact[],
  workflowStageLabel: (stage: WorkflowStage) => string,
  t: TranslateFn,
  childTaskPlanIndexes: Record<string, number> = {},
): FlowEntry[] {
  const taskMap = new Map(plan.tasks.map((task) => [task.id, task]));
  const agentMap = new Map(agents.map((agent) => [agent.id, agent]));
  const taskIndexMap = new Map(plan.tasks.map((task, index) => [task.id, index]));
  const entries: Array<FlowEntry & { sortKey: number; sequence: number }> = [];
  const planningStep = findRepresentativeStep(steps, ['planning', 'writing_plans']);
  const planningSortKey = planningStep?.completed_at ?? planningStep?.started_at ?? planningStep?.updated_at ?? planningStep?.created_at ?? 0;
  const planningExecutorId = planningStep?.assigned_room_agent_id ?? planningStep?.room_agent_id ?? plan.tasks.find((task) => task.role === 'planner')?.agent_id ?? 'codex';

  entries.push({
    key: 'plan:task-planning',
    phase: 'plan',
    phaseLabel: t('workflowPlan.taskFlowPlanStage'),
    sortKey: planningSortKey,
    sequence: 0,
    title: t('workflowPlan.taskFlowPlanningTask'),
    shortTitle: t('workflowPlan.taskFlowPlanningTask'),
    taskName: t('workflowPlan.taskFlowPlanningTask'),
    subtitle: plan.workflow_name || plan.goal,
    meta: planningStep?.status ?? 'completed',
    displayStatus: getWorkflowStatusLabel(planningStep?.status ?? 'completed', t),
    content: planningStep?.result || planningStep?.error || plan.summary || plan.goal || null,
    executor: planningExecutorId,
    executorName: getAgentDisplayName(planningExecutorId, agentMap),
    startedAt: planningStep?.started_at ?? null,
    completedAt: planningStep?.completed_at ?? null,
    events: buildPlanningEvents(plan, steps, t),
    icon: planningStep?.status === 'failed' || planningStep?.status === 'interrupted'
      ? <XCircle className="h-3.5 w-3.5 text-[var(--color-danger)]" />
      : <RotateCcw className="h-3.5 w-3.5 text-[var(--color-muted)]" />,
  });

  for (const [index, task] of plan.tasks.entries()) {
    if (task.role === 'planner') continue;
    const taskSteps = steps.filter((step) => isStepForPlanTask(step, task, index, taskIndexMap, childTaskPlanIndexes));
    const latestStep = findLatestStep(taskSteps);
    const sortKey = latestStep?.completed_at ?? latestStep?.started_at ?? latestStep?.updated_at ?? latestStep?.created_at ?? index + 1;
    const executorId = latestStep?.assigned_room_agent_id ?? latestStep?.room_agent_id ?? task.agent_id ?? 'codex';
    const phase = flowPhaseForTask(task);
    entries.push({
      key: `task:${task.id}`,
      phase,
      phaseLabel: phaseLabelForTask(task, t),
      sortKey,
      sequence: index + 1,
      title: flowTitleForTask(task, plan, taskMap, t),
      shortTitle: task.title,
      taskName: task.title,
      subtitle: task.description || null,
      meta: latestStep?.status ?? task.status,
      displayStatus: getWorkflowStatusLabel(latestStep?.status ?? task.status, t),
      content: latestStep?.result || latestStep?.error || task.description || null,
      executor: executorId,
      executorName: getAgentDisplayName(executorId, agentMap, task),
      startedAt: latestStep?.started_at ?? null,
      completedAt: latestStep?.completed_at ?? null,
      events: buildTaskEvents(task, taskSteps, t),
      icon: iconForTask(task, latestStep?.status ?? task.status),
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
      sequence: steps.length + entries.length + 1,
      title: artifact.title,
      shortTitle: artifact.title,
      taskName: artifactTask?.title ?? artifact.title,
      subtitle: relatedStep ? formatWorkflowNodeLabel(relatedStep, workflowStageLabel) : null,
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

function findRepresentativeStep(steps: WorkflowStep[], nodeNames: string[]): WorkflowStep | null {
  return [...steps]
    .filter((step) => step.node_name && nodeNames.includes(step.node_name))
    .sort((a, b) => {
      const left = a.completed_at ?? a.started_at ?? a.updated_at ?? a.created_at ?? 0;
      const right = b.completed_at ?? b.started_at ?? b.updated_at ?? b.created_at ?? 0;
      return right - left;
    })[0] ?? null;
}

function findLatestStep(steps: WorkflowStep[]): WorkflowStep | null {
  return [...steps].sort((a, b) => {
    const left = a.completed_at ?? a.started_at ?? a.updated_at ?? a.created_at ?? 0;
    const right = b.completed_at ?? b.started_at ?? b.updated_at ?? b.created_at ?? 0;
    return right - left;
  })[0] ?? null;
}

function isStepForPlanTask(
  step: WorkflowStep,
  task: WorkflowPlanTaskJson,
  taskIndex: number,
  taskIndexMap: Map<string, number>,
  childTaskPlanIndexes: Record<string, number>,
): boolean {
  if (step.task_id === task.id) return true;
  const mappedIndex = childTaskPlanIndexes[step.task_id];
  if (mappedIndex !== undefined) return mappedIndex === taskIndex;
  const directIndex = taskIndexMap.get(step.task_id);
  return directIndex !== undefined && directIndex === taskIndex;
}

function flowPhaseForTask(task: WorkflowPlanTaskJson): FlowEntry['phase'] {
  if (task.role === 'reviewer') return 'review';
  if (task.role === 'acceptor') return 'acceptance';
  if (task.role === 'planner') return 'plan';
  return 'execution';
}

function phaseLabelForTask(task: WorkflowPlanTaskJson, t: TranslateFn): string {
  switch (flowPhaseForTask(task)) {
    case 'review':
      return t('workflowPlan.taskFlowReviewStage');
    case 'acceptance':
      return t('workflowPlan.taskFlowAcceptanceStage');
    case 'plan':
      return t('workflowPlan.taskFlowPlanStage');
    case 'verification':
      return t('workflowPlan.taskFlowVerification');
    case 'execution':
      return t('workflowPlan.taskFlowExecutionStage');
  }
}

function flowTitleForTask(
  task: WorkflowPlanTaskJson,
  plan: WorkflowPlanJson,
  taskMap: Map<string, WorkflowPlanTaskJson>,
  t: TranslateFn,
): string {
  if (task.role === 'reviewer') {
    const target = task.depends_on.map((id) => taskMap.get(id)?.title).find(Boolean);
    return target ? `${t('workflowPlan.taskFlowReviewTarget')} · ${target}` : task.title;
  }
  if (task.role === 'acceptor') {
    const target = task.depends_on.map((id) => taskMap.get(id)?.title).find(Boolean) ?? plan.workflow_name;
    return target ? `${t('workflowPlan.taskFlowAcceptanceTarget')} · ${target}` : task.title;
  }
  return task.title;
}

function iconForTask(task: WorkflowPlanTaskJson, status: string): React.ReactNode {
  if (status === 'failed' || status === 'blocked') return <XCircle className="h-3.5 w-3.5 text-[var(--color-danger)]" />;
  if (status === 'running') return <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--color-accent)]" />;
  if (task.role === 'reviewer') return <Sparkles className="h-3.5 w-3.5 text-[var(--color-primary)]" />;
  if (task.role === 'acceptor' || status === 'completed') return <CheckCircle2 className="h-3.5 w-3.5 text-[var(--color-success)]" />;
  return <PauseCircle className="h-3.5 w-3.5 text-[var(--color-warning)]" />;
}

function buildPlanningEvents(plan: WorkflowPlanJson, steps: WorkflowStep[], t: TranslateFn): FlowEvent[] {
  const stepEvents = steps
    .filter((step) => step.stage === 'analysis' || step.stage === 'planning' || step.stage === 'assignment')
    .flatMap((step) => buildWorkflowStepLogEvents(step, t));
  return stepEvents.length > 0
    ? stepEvents
    : [{
      key: 'plan:created',
      time: formatFlowTime(0),
      sortKey: 0,
      label: plan.summary || plan.goal || t('workflowPlan.taskFlowPlanningTask'),
      active: false,
    }];
}

function buildTaskEvents(task: WorkflowPlanTaskJson, steps: WorkflowStep[], t: TranslateFn): FlowEvent[] {
  const stepEvents = steps.flatMap((step) => buildWorkflowStepLogEvents(step, t));
  if (stepEvents.length > 0) return stepEvents;
  return [{
    key: `task:${task.id}:created`,
    time: formatFlowTime(0),
    sortKey: 0,
    label: t('workflowPlan.taskFlowLogCreated'),
    active: task.status === 'running',
  }];
}

function buildWorkflowStepLogEvents(step: WorkflowStep, t: TranslateFn): FlowEvent[] {
  const sortKey = step.completed_at ?? step.started_at ?? step.updated_at ?? step.created_at;
  const label = step.error?.trim()
    || formatStepLogResult(step.result, t)
    || step.prompt?.trim()
    || t('workflowPlan.taskFlowLogCreated');
  return [{
    key: `step-log:${step.id}`,
    time: formatFlowTime(sortKey),
    sortKey,
    label,
    active: step.status === 'running',
  }];
}

function stageKeyForPhase(phase: FlowEntry['phase']): FlowStagePanel['key'] {
  if (phase === 'execution') return 'execution';
  if (phase === 'review' || phase === 'verification') return 'review';
  if (phase === 'acceptance') return 'done';
  return 'plan';
}

function formatStepLogResult(result: string | null, t: TranslateFn): string | null {
  const trimmed = result?.trim();
  if (!trimmed) return null;
  return trimmed.length > 80 ? t('workflowPlan.taskFlowLogResult') : trimmed;
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
      sortKey: entry.sortKey,
      label: t('workflowPlan.taskFlowLogCreated'),
      active: false,
    },
  ];
  if (entry.startedAt) {
    events.push({
      key: `${entry.key}:started`,
      time: formatFlowTime(entry.startedAt),
      sortKey: entry.startedAt,
      label: t('workflowPlan.taskFlowLogRunning'),
      active: entry.status === 'running',
    });
  }
  if (entry.content?.trim()) {
    events.push({
      key: `${entry.key}:result`,
      time: formatFlowTime(entry.completedAt ?? entry.startedAt ?? entry.sortKey),
      sortKey: entry.completedAt ?? entry.startedAt ?? entry.sortKey,
      label: t('workflowPlan.taskFlowLogResult'),
      active: entry.status === 'running',
    });
  }
  if (entry.completedAt) {
    events.push({
      key: `${entry.key}:completed`,
      time: formatFlowTime(entry.completedAt),
      sortKey: entry.completedAt,
      label: t('workflowPlan.taskFlowLogCompleted'),
      active: false,
    });
  }
  return events;
}
