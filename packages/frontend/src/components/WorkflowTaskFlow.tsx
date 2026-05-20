import { CheckCircle2, Loader2, PauseCircle, RotateCcw, Sparkles, XCircle } from 'lucide-react';
import { useMemo } from 'react';
import { useI18n } from '../lib/i18n';
import type { TaskArtifact, WorkflowPlanJson, WorkflowPlanTaskJson, WorkflowStage, WorkflowStep } from '../lib/types';
import { cn, truncate } from '../lib/utils';

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
  const executorTaskCount = plan.tasks.filter((task) => task.role === 'executor').length;
  const recordCount = steps.length + artifacts.length;

  return (
    <section className="workflow-flow-panel">
      <div className="workflow-flow-header">
        <div className="font-display text-[12.5px] font-semibold">{t('workflowPlan.taskFlowTitle')}</div>
        <div className="workflow-flow-summary">
          <span>{t('workflowPlan.taskFlowPlanItems', { count: executorTaskCount })}</span>
          <span>{t('workflowPlan.taskFlowRecords', { count: recordCount })}</span>
        </div>
      </div>
      <div className="workflow-flow-phase-strip" aria-hidden="true">
        <span>{t('workflowPlan.taskFlowPlanStage')}</span>
        <span>{t('workflowPlan.taskFlowExecutionStage')}</span>
        <span>{t('workflowPlan.taskFlowReviewStage')}</span>
        <span>{t('workflowPlan.taskFlowVerification')}</span>
        <span>{t('workflowPlan.taskFlowAcceptanceStage')}</span>
      </div>

      {flowEntries.length > 0 ? (
        <div className="workflow-flow-board" aria-label={t('workflowPlan.taskFlowTitle')}>
          {flowEntries.map((entry, index) => (
            <FlowEntryCard
              key={entry.key}
              entry={entry}
              compact={compact}
              isFirst={index === 0}
              isLast={index === flowEntries.length - 1}
            />
          ))}
        </div>
      ) : (
        <div className="workflow-flow-empty">{t('workflowPlan.taskFlowEmpty')}</div>
      )}
    </section>
  );
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
  isFirst,
  isLast,
}: {
  entry: FlowEntry;
  compact: boolean;
  isFirst: boolean;
  isLast: boolean;
}) {
  return (
    <article
      className={cn(
        'workflow-flow-entry',
        `is-${entry.phase}`,
        isFirst && 'is-first',
        isLast && 'is-last',
      )}
    >
      <div className="workflow-flow-node">
        <div className="workflow-flow-node-line" aria-hidden="true" />
        <div className="workflow-flow-icon" aria-hidden="true">{entry.icon}</div>
      </div>
      <div className="workflow-flow-entry-body">
        <div className="workflow-flow-entry-phase">{entry.phaseLabel}</div>
        <div className="workflow-flow-entry-top">
        <div className="min-w-0 flex-1">
          <div className="workflow-flow-entry-title">{entry.title}</div>
          {entry.subtitle && <div className="workflow-flow-entry-subtitle">{entry.subtitle}</div>}
        </div>
        <div className="workflow-flow-entry-meta">{entry.meta}</div>
      </div>
      {entry.content && (
        <div className="workflow-flow-entry-content">{truncate(entry.content, compact ? 260 : 420)}</div>
      )}
      </div>
    </article>
  );
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
