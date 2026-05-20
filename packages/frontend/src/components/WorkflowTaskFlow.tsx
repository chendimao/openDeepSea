import { CheckCircle2, ChevronDown, Loader2, MoreHorizontal, PauseCircle, RotateCcw, Settings2, Sparkles, XCircle } from 'lucide-react';
import { useMemo } from 'react';
import { useI18n } from '../lib/i18n';
import type { TaskArtifact, WorkflowPlanJson, WorkflowPlanTaskJson, WorkflowStage, WorkflowStep } from '../lib/types';
import { cn } from '../lib/utils';

type TranslateFn = ReturnType<typeof useI18n>['t'];

export function WorkflowTaskFlow({
  plan,
  steps,
  artifacts,
  compact = false,
}: {
  plan: WorkflowPlanJson;
  steps: WorkflowStep[];
  artifacts: TaskArtifact[];
  compact?: boolean;
}) {
  const { t, workflowStageLabel } = useI18n();
  const flowEntries = useMemo(
    () => buildFlowEntries(plan, steps, artifacts, workflowStageLabel, t),
    [artifacts, plan, steps, t, workflowStageLabel],
  );
  const stagePanels = useMemo(() => buildStagePanels(flowEntries, t), [flowEntries, t]);
  const executorTaskCount = plan.tasks.filter((task) => task.role === 'executor').length;
  const recordCount = steps.length + artifacts.length;
  const progressStats = useMemo(() => buildProgressStats(flowEntries), [flowEntries]);

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
        <div className="workflow-flow-overview">
          {stagePanels.map((stage) => (
            <div key={stage.key} className={cn('workflow-flow-overview-step', `is-${stage.key}`)}>
              <div className="workflow-flow-overview-icon">{stage.icon}</div>
              <div className="workflow-flow-overview-copy">
                <div className="workflow-flow-overview-title">{stage.label}</div>
                <div className="workflow-flow-overview-meta">
                  <span className="workflow-flow-stage-count">{stage.entries.length}</span>
                  <span>{stage.percent}%</span>
                </div>
              </div>
            </div>
          ))}
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
        <div className="workflow-flow-kanban" aria-label={t('workflowPlan.taskFlowTitle')}>
          {stagePanels.map((stage) => (
            <section key={stage.key} className={cn('workflow-flow-kanban-column', `is-${stage.key}`)}>
              <div className="workflow-flow-kanban-head">
                <div className="workflow-flow-kanban-title">
                  <span className="workflow-flow-stage-dot" />
                  <span>{stage.label}</span>
                  <span className="workflow-flow-stage-count">{stage.entries.length}</span>
                </div>
              </div>
              <div className="workflow-flow-kanban-list">
                {stage.entries.length > 0 ? stage.entries.map((entry) => (
                  <FlowEntryCard key={entry.key} entry={entry} compact={compact} />
                )) : (
                  <div className="workflow-flow-lane-empty">{t('workflowPlan.taskFlowEmpty')}</div>
                )}
              </div>
            </section>
          ))}
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
  entries: FlowEntry[];
}

interface FlowEntry {
  key: string;
  phase: 'plan' | 'execution' | 'review' | 'verification' | 'acceptance';
  phaseLabel: string;
  title: string;
  subtitle: string | null;
  meta: string;
  content: string | null;
  icon: React.ReactNode;
}

function FlowEntryCard({
  entry,
  compact,
}: {
  entry: FlowEntry;
  compact: boolean;
}) {
  return (
    <article
      className={cn(
        'workflow-flow-entry',
        `is-${entry.phase}`,
      )}
    >
      <div className="workflow-flow-icon" aria-hidden="true">{entry.icon}</div>
      <div className="workflow-flow-entry-body">
        <div className="workflow-flow-entry-role">{entry.phaseLabel}</div>
        <div className="workflow-flow-entry-title">{entry.title}</div>
        {entry.subtitle && <div className="workflow-flow-entry-subtitle">{entry.subtitle}</div>}
        <div className="workflow-flow-entry-top">
          <span className={cn('workflow-flow-status-pill', `is-${entry.meta}`)}>{entry.meta}</span>
          <button className="workflow-flow-row-menu" type="button" aria-label={entry.title}>
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </article>
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
  ] satisfies Array<Omit<FlowStagePanel, 'percent'>>;

  return panels.map((panel) => ({
    ...panel,
    percent: calculateEntryPercent(panel.entries),
  }));
}

function calculateEntryPercent(entries: FlowEntry[]): number {
  if (entries.length === 0) return 0;
  const completed = entries.filter((entry) => entry.meta === 'completed').length;
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
  steps: WorkflowStep[],
  artifacts: TaskArtifact[],
  workflowStageLabel: (stage: WorkflowStage) => string,
  t: TranslateFn,
): FlowEntry[] {
  const taskMap = new Map(plan.tasks.map((task) => [task.id, task]));
  const entries: Array<FlowEntry & { sortKey: number; sequence: number }> = [];

  for (const [index, step] of steps.entries()) {
    const task = taskMap.get(step.task_id) ?? null;
    const sortKey = step.completed_at ?? step.started_at ?? step.updated_at ?? step.created_at ?? index;
    if (step.stage === 'implementation') {
      entries.push({
        key: `step:${step.id}`,
        phase: 'execution',
        phaseLabel: t('workflowPlan.taskFlowExecutionStage'),
        sortKey,
        sequence: index,
        title: `${workflowStageLabel(step.stage)} · ${task?.title ?? step.task_id}`,
        subtitle: step.node_name ? step.node_name : null,
        meta: step.status,
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
          subtitle: task?.title ?? workflowStageLabel(step.stage),
          meta: step.status,
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
        subtitle: task?.title ?? null,
        meta: step.status,
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
        subtitle: task?.title ?? null,
        meta: step.status,
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
      subtitle: task?.title ?? null,
      meta: step.status,
      content: step.result || step.error || null,
      icon: step.status === 'failed' || step.status === 'interrupted'
        ? <XCircle className="h-3.5 w-3.5 text-[var(--color-danger)]" />
        : <RotateCcw className="h-3.5 w-3.5 text-[var(--color-muted)]" />,
    });
  }

  for (const artifact of artifacts) {
    if (artifact.artifact_type !== 'review' && artifact.artifact_type !== 'acceptance') continue;
    const relatedStep = steps.find((step) => step.id === artifact.workflow_step_id);
    entries.push({
      key: `artifact:${artifact.id}`,
      phase: artifact.artifact_type === 'review' ? 'review' : 'acceptance',
      phaseLabel: artifact.artifact_type === 'review'
        ? t('workflowPlan.taskFlowReviewStage')
        : t('workflowPlan.taskFlowAcceptanceStage'),
      sortKey: artifact.created_at,
      sequence: steps.length + entries.length,
      title: artifact.title,
      subtitle: relatedStep ? workflowStageLabel(relatedStep.stage) : null,
      meta: artifact.artifact_type,
      content: artifact.content,
      icon: <Sparkles className="h-3.5 w-3.5 text-[var(--color-accent)]" />,
    });
  }

  return entries.sort((a, b) => a.sortKey - b.sortKey || a.sequence - b.sequence);
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
