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

      {flowEntries.length > 0 ? (
        <div className="workflow-flow-board">
          <div className="workflow-flow-row">
            <div className="workflow-flow-lane-label">{t('workflowPlan.taskFlowPlanStage')}</div>
            <div className="workflow-flow-lane-track">
              {flowEntries
                .filter((entry) => entry.lane === 'plan')
                .map((entry) => <FlowEntryCard key={entry.key} entry={entry} compact={compact} />)}
            </div>
          </div>
          <div className="workflow-flow-row">
            <div className="workflow-flow-lane-label">{t('workflowPlan.taskFlowExecutionStage')}</div>
            <div className="workflow-flow-lane-track">
              {flowEntries
                .filter((entry) => entry.lane === 'execution')
                .map((entry) => <FlowEntryCard key={entry.key} entry={entry} compact={compact} />)}
            </div>
          </div>
          <div className="workflow-flow-row">
            <div className="workflow-flow-lane-label">{t('workflowPlan.taskFlowReviewStage')}</div>
            <div className="workflow-flow-lane-track">
              {flowEntries
                .filter((entry) => entry.lane === 'review')
                .map((entry) => <FlowEntryCard key={entry.key} entry={entry} compact={compact} />)}
            </div>
          </div>
          <div className="workflow-flow-row">
            <div className="workflow-flow-lane-label">{t('workflowPlan.taskFlowAcceptanceStage')}</div>
            <div className="workflow-flow-lane-track">
              {flowEntries
                .filter((entry) => entry.lane === 'acceptance')
                .map((entry) => <FlowEntryCard key={entry.key} entry={entry} compact={compact} />)}
            </div>
          </div>
        </div>
      ) : (
        <div className="workflow-flow-empty">{t('workflowPlan.taskFlowEmpty')}</div>
      )}
    </section>
  );
}

interface FlowEntry {
  key: string;
  lane: 'plan' | 'execution' | 'review' | 'acceptance';
  title: string;
  subtitle: string | null;
  meta: string;
  content: string | null;
  icon: React.ReactNode;
}

function FlowEntryCard({ entry, compact }: { entry: FlowEntry; compact: boolean }) {
  return (
    <article className={cn('workflow-flow-entry', entry.lane !== 'execution' && 'is-transition')}>
      <div className="workflow-flow-entry-top">
        <div className="workflow-flow-icon">{entry.icon}</div>
        <div className="min-w-0 flex-1">
          <div className="workflow-flow-entry-title">{entry.title}</div>
          {entry.subtitle && <div className="workflow-flow-entry-subtitle">{entry.subtitle}</div>}
        </div>
        <div className="workflow-flow-entry-meta">{entry.meta}</div>
      </div>
      {entry.content && (
        <div className="workflow-flow-entry-content">{truncate(entry.content, compact ? 260 : 420)}</div>
      )}
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
  const entries: Array<FlowEntry & { sortKey: number }> = [];

  for (const [index, step] of steps.entries()) {
    const task = taskMap.get(step.task_id) ?? null;
    const sortKey = step.completed_at ?? step.started_at ?? step.updated_at ?? step.created_at ?? index;
    if (step.stage === 'implementation') {
      entries.push({
        key: `step:${step.id}`,
        lane: 'execution',
        sortKey,
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
          lane: 'review',
          sortKey,
          title: `${workflowStageLabel(step.stage)} · ${t('workflowPlan.taskFlowVerification')}`,
          subtitle: task?.title ?? null,
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

      const reviewedTask = findReviewedTaskTitle(steps, index, taskMap);
      entries.push({
        key: `review:${step.id}`,
        lane: 'review',
        sortKey,
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
      const acceptanceTarget = findLatestImplementationTitle(steps, index, taskMap) ?? plan.workflow_name;
      entries.push({
        key: `acceptance:${step.id}`,
        lane: 'acceptance',
        sortKey,
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
      lane: 'plan',
      sortKey,
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
      lane: artifact.artifact_type === 'review' ? 'review' : 'acceptance',
      sortKey: artifact.created_at,
      title: artifact.title,
      subtitle: relatedStep ? workflowStageLabel(relatedStep.stage) : null,
      meta: artifact.artifact_type,
      content: artifact.content,
      icon: <Sparkles className="h-3.5 w-3.5 text-[var(--color-accent)]" />,
    });
  }

  return entries;
}

function findReviewedTaskTitle(
  steps: WorkflowStep[],
  currentIndex: number,
  taskMap: Map<string, WorkflowPlanTaskJson>,
): string | null {
  for (let i = currentIndex - 1; i >= 0; i -= 1) {
    const step = steps[i];
    if (step.stage !== 'implementation') continue;
    return taskMap.get(step.task_id)?.title ?? step.task_id;
  }
  return null;
}

function findLatestImplementationTitle(
  steps: WorkflowStep[],
  currentIndex: number,
  taskMap: Map<string, WorkflowPlanTaskJson>,
): string | null {
  for (let i = currentIndex - 1; i >= 0; i -= 1) {
    const step = steps[i];
    if (step.stage !== 'implementation') continue;
    return taskMap.get(step.task_id)?.title ?? step.task_id;
  }
  return null;
}
