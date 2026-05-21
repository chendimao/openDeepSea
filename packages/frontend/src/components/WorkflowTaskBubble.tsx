import { useMemo } from 'react';
import type {
  Message,
  RoomAgent,
  SuperpowersFinishBranchDecisionValue,
  SuperpowersGraphStateSummary,
  TaskArtifact,
  WorkflowDetail,
  WorkflowPlanJson,
  WorkflowPlanTaskJson,
  WorkflowStage,
  WorkflowStep,
} from '../lib/types';
import { WorkflowAgentTabs } from './WorkflowAgentTabs';
import { WorkflowProgressHeader } from './WorkflowProgressHeader';
import { WorkflowTaskTable } from './WorkflowTaskTable';
import { WorkflowTaskFlow } from './WorkflowTaskFlow';

export function WorkflowTaskBubble({
  detail,
  agents,
  eventMessages = [],
  compact = false,
}: {
  detail: WorkflowDetail;
  agents: RoomAgent[];
  eventMessages?: Message[];
  compact?: boolean;
}) {
  const workflowPlan = useMemo(() => getWorkflowPlan(detail), [detail]);
  const superpowersSummary = useMemo(() => parseSuperpowersSummaryFromGraphState(detail.run.graph_state), [detail.run.graph_state]);
  const childTaskPlanIndexes = useMemo(() => parseChildTaskPlanIndexesFromGraphState(detail.run.graph_state), [detail.run.graph_state]);

  if (!workflowPlan && !superpowersSummary) {
    return null;
  }

  return (
    <div className="workflow-task-bubble" data-source={compact ? 'chat' : 'timeline'}>
      <div className="workflow-task-bubble-main">
        {!compact && workflowPlan && <WorkflowProgressHeader plan={workflowPlan} />}
        {superpowersSummary && <SuperpowersGateSummary summary={superpowersSummary} compact={compact} />}
        {workflowPlan && (
          <div className="workflow-task-bubble-lanes">
            {!compact && (
              <WorkflowTaskTable
                plan={workflowPlan}
                agents={agents}
                compact={compact}
                availableTaskIds={getExecutableTaskIds(workflowPlan)}
              />
            )}
            <WorkflowTaskFlow
              plan={workflowPlan}
              agents={agents}
              steps={detail.steps}
              artifacts={detail.artifacts}
              eventMessages={eventMessages}
              childTaskPlanIndexes={childTaskPlanIndexes}
              compact={compact}
            />
          </div>
        )}
      </div>
      {workflowPlan && (
        <div className="workflow-task-bubble-side">
          <WorkflowAgentTabs
            plan={workflowPlan}
            agents={agents}
            artifacts={detail.artifacts}
            steps={detail.steps}
            compact={compact}
          />
        </div>
      )}
    </div>
  );
}

function SuperpowersGateSummary({
  summary,
  compact,
}: {
  summary: SuperpowersGraphStateSummary;
  compact: boolean;
}): JSX.Element {
  const findings = [
    ...(summary.specComplianceReview?.findings ?? []),
    ...(summary.codeQualityReview?.findings ?? []),
  ];
  const verificationEvidence = summary.verificationEvidence ?? [];
  const tddCount = summary.tddEvidence?.length ?? 0;
  const finishDecision = summary.finishBranchDecision?.decision ?? null;
  const visibleFindings = findings.slice(0, 2);

  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[12px] text-[var(--color-fg-muted)]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-[var(--color-fg)]">当前门禁</span>
        <span className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2 py-0.5 text-[11px] font-semibold text-[var(--color-primary)]">
          {formatSuperpowersPhase(summary.superpowersPhase)}
        </span>
        {summary.designDocPath && (
          <span className="min-w-0 truncate font-mono text-[11px] text-[var(--color-fg-muted)]">
            {summary.designDocPath}
          </span>
        )}
      </div>
      <div className="mt-2 grid gap-1.5 sm:grid-cols-4">
        <SuperpowersMetric label="TDD 证据" value={`${tddCount}`} />
        <SuperpowersMetric label="审查发现" value={`${findings.length}`} tone={findings.length > 0 ? 'warning' : 'default'} />
        <SuperpowersMetric label="验证证据" value={formatVerificationEvidence(verificationEvidence)} />
        <SuperpowersMetric label="分支收口" value={finishDecision ? formatFinishBranchDecision(finishDecision) : '--'} />
      </div>
      {visibleFindings.length > 0 && (
        <div className={compact ? 'sr-only' : 'mt-2 grid gap-1'}>
          {visibleFindings.map((finding, index) => (
            <div key={`${index}:${finding}`} className={compact ? undefined : 'truncate rounded-md bg-[var(--color-surface-raised)] px-2 py-1'}>
              {finding}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function SuperpowersMetric({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'warning';
}): JSX.Element {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2 py-1">
      <div className="text-[10.5px] text-[var(--color-fg-muted)]">{label}</div>
      <div className={tone === 'warning' ? 'mt-0.5 truncate font-semibold text-[var(--color-warning)]' : 'mt-0.5 truncate font-semibold text-[var(--color-fg)]'}>
        {value}
      </div>
    </div>
  );
}

function getWorkflowPlan(detail: WorkflowDetail): WorkflowPlanJson | null {
  const statePlan = parseWorkflowPlanFromGraphState(detail.run.graph_state);
  if (statePlan) return statePlan;

  const artifactPlan = parseWorkflowPlanFromArtifacts(detail.artifacts);
  return artifactPlan;
}

function parseWorkflowPlanFromGraphState(raw: string | null): WorkflowPlanJson | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { workflowPlan?: unknown };
    return isWorkflowPlanJson(parsed.workflowPlan) ? parsed.workflowPlan : null;
  } catch {
    return null;
  }
}

function parseChildTaskPlanIndexesFromGraphState(raw: string | null): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as { childTaskPlanIndexes?: unknown };
    if (!parsed.childTaskPlanIndexes || typeof parsed.childTaskPlanIndexes !== 'object' || Array.isArray(parsed.childTaskPlanIndexes)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed.childTaskPlanIndexes)
        .filter((entry): entry is [string, number] =>
          typeof entry[0] === 'string' &&
          Number.isInteger(entry[1]) &&
          entry[1] >= 0,
        ),
    );
  } catch {
    return {};
  }
}

function parseSuperpowersSummaryFromGraphState(raw: string | null): SuperpowersGraphStateSummary | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SuperpowersGraphStateSummary> & { runtimeProfile?: unknown };
    if (parsed.runtimeProfile !== 'superpowers') return null;
    if (!isSuperpowersGraphStateSummary(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isSuperpowersGraphStateSummary(value: unknown): value is SuperpowersGraphStateSummary {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as SuperpowersGraphStateSummary;
  return (
    (candidate.superpowersPhase === undefined || candidate.superpowersPhase === null || typeof candidate.superpowersPhase === 'string') &&
    (candidate.designDocPath === undefined || candidate.designDocPath === null || typeof candidate.designDocPath === 'string') &&
    (candidate.tddEvidence === undefined || Array.isArray(candidate.tddEvidence)) &&
    (candidate.specComplianceReview === undefined || candidate.specComplianceReview === null || isSuperpowersReview(candidate.specComplianceReview)) &&
    (candidate.codeQualityReview === undefined || candidate.codeQualityReview === null || isSuperpowersReview(candidate.codeQualityReview)) &&
    (candidate.verificationEvidence === undefined || Array.isArray(candidate.verificationEvidence)) &&
    (candidate.finishBranchDecision === undefined || candidate.finishBranchDecision === null || isFinishBranchDecision(candidate.finishBranchDecision))
  );
}

function isSuperpowersReview(value: unknown): value is NonNullable<SuperpowersGraphStateSummary['specComplianceReview']> {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as NonNullable<SuperpowersGraphStateSummary['specComplianceReview']>;
  return (
    typeof candidate.verdict === 'string' &&
    Array.isArray(candidate.findings) &&
    (candidate.reviewedAt === null || typeof candidate.reviewedAt === 'string')
  );
}

function isFinishBranchDecision(value: unknown): value is NonNullable<SuperpowersGraphStateSummary['finishBranchDecision']> {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as NonNullable<SuperpowersGraphStateSummary['finishBranchDecision']>;
  return (
    typeof candidate.decision === 'string' &&
    Array.isArray(candidate.options) &&
    typeof candidate.reason === 'string' &&
    (candidate.decidedAt === null || typeof candidate.decidedAt === 'string')
  );
}

function parseWorkflowPlanFromArtifacts(artifacts: TaskArtifact[]): WorkflowPlanJson | null {
  const planArtifact = [...artifacts].reverse().find((artifact) => artifact.artifact_type === 'plan' && artifact.metadata);
  if (!planArtifact?.metadata) return null;

  try {
    const metadata = JSON.parse(planArtifact.metadata) as { workflow_plan_json?: unknown };
    return isWorkflowPlanJson(metadata.workflow_plan_json) ? metadata.workflow_plan_json : null;
  } catch {
    return null;
  }
}

function isWorkflowPlanJson(value: unknown): value is WorkflowPlanJson {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as WorkflowPlanJson;
  return (
    typeof candidate.workflow_name === 'string' &&
    typeof candidate.source_message_id === 'string' &&
    typeof candidate.goal === 'string' &&
    typeof candidate.summary === 'string' &&
    Array.isArray(candidate.tasks) &&
    candidate.tasks.every((task) => {
      return (
        task &&
        typeof task === 'object' &&
        typeof task.id === 'string' &&
        typeof task.title === 'string' &&
        typeof task.description === 'string' &&
        ['planner', 'executor', 'reviewer', 'acceptor'].includes(task.role) &&
        (typeof task.agent_id === 'string' || task.agent_id === null) &&
        (task.mode === 'parallel' || task.mode === 'serial') &&
        Array.isArray(task.depends_on) &&
        ['pending', 'running', 'completed', 'blocked', 'failed', 'skipped'].includes(task.status) &&
        typeof task.progress === 'number' &&
        Array.isArray(task.result_refs)
      );
    })
  );
}

function getExecutableTaskIds(plan: WorkflowPlanJson): string[] {
  return plan.tasks
    .filter((task) => task.role === 'executor')
    .map((task) => task.id);
}

function formatSuperpowersPhase(phase: string | null | undefined): string {
  switch (phase) {
    case 'brainstorming':
      return 'Brainstorming';
    case 'spec_review':
      return 'Spec Review';
    case 'worktree':
      return 'Worktree';
    case 'writing_plans':
      return 'Writing Plans';
    case 'plan_review':
      return 'Plan Review';
    case 'tdd_execute':
      return 'TDD 执行';
    case 'spec_compliance_review':
      return '规格符合审查';
    case 'code_quality_review':
      return '代码质量审查';
    case 'finish_branch':
      return '分支收口';
    default:
      return phase || '--';
  }
}

function formatVerificationEvidence(evidence: NonNullable<SuperpowersGraphStateSummary['verificationEvidence']>): string {
  if (evidence.length === 0) return '0';
  const passed = evidence.filter((item) => item.status === 'passed' && item.fresh).length;
  return `${passed}/${evidence.length}`;
}

function formatFinishBranchDecision(decision: SuperpowersFinishBranchDecisionValue): string {
  switch (decision) {
    case 'merge_local':
      return '本地合并';
    case 'create_pr':
      return '创建 PR';
    case 'keep_branch':
      return '保留分支';
    case 'discard_work':
      return '丢弃工作';
  }
}
