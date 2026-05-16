import { AlertTriangle, CheckCircle2, Circle, Loader2, PauseCircle, RotateCcw, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useI18n } from '../lib/i18n';
import type { RoomAgent, TaskArtifact, WorkflowDetail, WorkflowStep } from '../lib/types';
import { cn, truncate } from '../lib/utils';
import { Button } from './ui/Button';

export function WorkflowTimeline({
  detail,
  agents,
  onApprove,
  onSubmitDecisions,
  onRetry,
  onCancel,
  busy,
}: {
  detail: WorkflowDetail | null;
  agents: RoomAgent[];
  onApprove: () => void;
  onSubmitDecisions: (answers: Array<{ decisionId: string; optionId: string }>) => void;
  onRetry: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const { formatRelativeTime, t, workflowStageLabel, workflowStatusLabel } = useI18n();
  const decisionRequest = useMemo(() => (detail ? getLatestDecisionRequest(detail.artifacts) : null), [detail]);

  if (!detail) {
    return <div className="text-[12px] text-[var(--color-fg-muted)]">{t('workflow.notStarted')}</div>;
  }

  const agentMap = new Map(agents.map((agent) => [agent.id, agent]));
  const artifacts = [...detail.artifacts].reverse();
  const hasRetryableStep = detail.steps.some(
    (step) => step.status === 'failed' || step.status === 'cancelled' || step.status === 'interrupted',
  );
  const canRetry =
    detail.run.status === 'blocked' ||
    ((detail.run.status === 'failed' || detail.run.status === 'cancelled') && hasRetryableStep);

  return (
    <div className="space-y-3">
      <div className="workflow-stage-pills" aria-label={t('workflow.stagesAria')}>
        {(['analysis', 'planning', 'assignment', 'implementation', 'code_review', 'acceptance'] as const).map((stage) => (
          <span
            key={stage}
            className={cn(
              'stage-pill',
              detail.run.current_stage === stage && 'is-current',
              detail.steps.some((step) => step.stage === stage && step.status === 'completed') && 'is-done',
            )}
          >
            {workflowStageLabel(stage)}
          </span>
        ))}
      </div>

      <div className="glass-info-card p-3">
        <div className="flex items-center gap-2">
          <WorkflowStatusIcon status={detail.run.status} />
          <div className="font-display text-[12.5px] font-semibold">
            {workflowStatusLabel(detail.run.status)}
          </div>
          <span className="ml-auto text-[10.5px] font-mono text-[var(--color-muted)]">
            {formatRelativeTime(detail.run.updated_at)}
          </span>
        </div>
        {detail.run.error && (
          <div className="mt-2 break-words text-[11.5px] text-[var(--color-danger)]">
            {detail.run.error}
          </div>
        )}
      </div>

      <div className="workflow-timeline space-y-2">
        {detail.steps.map((step) => (
          <StepRow
            key={step.id}
            step={step}
            agentName={step.room_agent_id ? agentMap.get(step.room_agent_id)?.agent_name : undefined}
          />
        ))}
      </div>

      {artifacts.length > 0 && (
        <div className="space-y-2">
          {artifacts.map((artifact) => (
            <ArtifactPreview key={artifact.id} artifact={artifact} />
          ))}
        </div>
      )}

      {detail.run.status === 'awaiting_decision' && decisionRequest && (
        <DecisionRequestPanel request={decisionRequest} onSubmit={onSubmitDecisions} busy={busy} />
      )}

      <div className="flex flex-wrap gap-2">
        {detail.run.status === 'awaiting_approval' && (
          <Button size="sm" onClick={onApprove} disabled={busy}>
            <CheckCircle2 className="h-3.5 w-3.5" />
            {t('workflow.approvePlan')}
          </Button>
        )}
        {canRetry && (
          <Button size="sm" variant="secondary" onClick={onRetry} disabled={busy}>
            <RotateCcw className="h-3.5 w-3.5" />
            {t('common.retry')}
          </Button>
        )}
        {['running', 'awaiting_decision', 'awaiting_approval', 'blocked'].includes(detail.run.status) && (
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
            <XCircle className="h-3.5 w-3.5" />
            {t('common.cancel')}
          </Button>
        )}
      </div>
    </div>
  );
}

interface DecisionOption {
  id: string;
  label: string;
  description: string;
}

interface DecisionItem {
  id: string;
  question: string;
  reason: string;
  blocking: boolean;
  recommendedOptionId: string;
  options: DecisionOption[];
}

interface DecisionRequest {
  decisions: DecisionItem[];
}

function DecisionRequestPanel({
  request,
  onSubmit,
  busy,
}: {
  request: DecisionRequest;
  onSubmit: (answers: Array<{ decisionId: string; optionId: string }>) => void;
  busy: boolean;
}) {
  const { t } = useI18n();
  const [answers, setAnswers] = useState<Record<string, string>>(() =>
    Object.fromEntries(request.decisions.map((decision) => [decision.id, decision.recommendedOptionId])),
  );
  const complete = request.decisions.every((decision) => answers[decision.id]);

  return (
    <div className="surface-2 rounded-lg p-3">
      <div className="mb-3 flex items-center gap-2">
        <PauseCircle className="h-3.5 w-3.5 text-[var(--color-warning)]" />
        <div className="font-display text-[12.5px] font-semibold">{t('workflow.decisionsTitle')}</div>
      </div>
      <div className="space-y-4">
        {request.decisions.map((decision) => (
          <fieldset key={decision.id} className="space-y-2">
            <legend className="text-[12.5px] font-medium leading-relaxed">{decision.question}</legend>
            {decision.reason && (
              <div className="text-[11.5px] leading-relaxed text-[var(--color-fg-muted)]">{decision.reason}</div>
            )}
            <div className="space-y-2">
              {decision.options.map((option) => {
                const selected = answers[decision.id] === option.id;
                const recommended = decision.recommendedOptionId === option.id;
                return (
                  <label
                    key={option.id}
                    className={cn(
                      'flex cursor-pointer gap-2 rounded-md border px-3 py-2 ease-ocean',
                      selected
                        ? 'border-[var(--color-primary)] bg-[var(--color-primary-soft)]'
                        : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-border-strong)]',
                    )}
                  >
                    <input
                      type="radio"
                      name={decision.id}
                      value={option.id}
                      checked={selected}
                      onChange={() => setAnswers((prev) => ({ ...prev, [decision.id]: option.id }))}
                      className="mt-0.5"
                    />
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-1.5 text-[12px] font-medium">
                        {option.label}
                        {recommended && (
                          <span className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-fg-muted)]">
                            {t('workflow.recommended')}
                          </span>
                        )}
                      </span>
                      {option.description && (
                        <span className="mt-1 block text-[11.5px] leading-relaxed text-[var(--color-fg-muted)]">
                          {option.description}
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>
      <Button
        size="sm"
        className="mt-3"
        onClick={() =>
          onSubmit(request.decisions.map((decision) => ({ decisionId: decision.id, optionId: answers[decision.id] })))
        }
        disabled={busy || !complete}
      >
        <CheckCircle2 className="h-3.5 w-3.5" />
        {t('workflow.submitDecision')}
      </Button>
    </div>
  );
}

function getLatestDecisionRequest(artifacts: TaskArtifact[]): DecisionRequest | null {
  const artifact = [...artifacts].reverse().find((item) => item.artifact_type === 'decision_request');
  if (!artifact?.metadata) return null;
  try {
    const parsed = JSON.parse(artifact.metadata) as DecisionRequest;
    if (!Array.isArray(parsed.decisions)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function StepRow({ step, agentName }: { step: WorkflowStep; agentName?: string }) {
  const { t, workflowStageLabel } = useI18n();
  const scopeWrite = Array.isArray(step.scope_write) ? step.scope_write : [];
  const scopeWriteText = scopeWrite.join(', ');
  return (
    <div className={cn('workflow-step-card', (step.status === 'failed' || step.status === 'interrupted') && 'is-failed')}>
      <div className="flex items-center gap-2">
        <WorkflowStatusIcon status={step.status} />
        <div className="min-w-0 flex-1 truncate font-display text-[12px] font-medium">
          {workflowStageLabel(step.stage)}
        </div>
        <span className="max-w-[45%] shrink-0 truncate text-[10.5px] font-mono text-[var(--color-muted)]">
          {agentName ?? t('workflow.systemAgent')}
        </span>
      </div>
      {(step.node_name || scopeWrite.length > 0) && (
        <div className="mt-1 space-y-1">
          {step.node_name && (
            <div className="truncate font-mono text-[10.5px] text-[var(--color-fg-muted)]">
              {t('workflow.graphNode', { node: step.node_name })}
            </div>
          )}
          {scopeWrite.length > 0 && (
            <div className="truncate text-[10.5px] text-[var(--color-fg-muted)]" title={scopeWriteText}>
              {t('workflow.scopeWrite', { scope: scopeWriteText })}
            </div>
          )}
        </div>
      )}
      {step.result && (
        <div className="mt-2 text-[11.5px] leading-relaxed text-[var(--color-fg-muted)]">
          {truncate(step.result, 220)}
        </div>
      )}
      {step.error && (
        <div className="mt-2 break-words text-[11.5px] text-[var(--color-danger)]">
          {step.error}
        </div>
      )}
    </div>
  );
}

function ArtifactPreview({ artifact }: { artifact: TaskArtifact }) {
  return (
    <details className="disclosure-card">
      <summary className="cursor-pointer break-words font-display text-[12px] font-medium">
        {artifact.title}
      </summary>
      <pre className="mt-2 max-h-[220px] overflow-auto whitespace-pre-wrap break-words text-[11.5px] leading-relaxed text-[var(--color-fg-muted)]">
        {artifact.content}
      </pre>
    </details>
  );
}

function WorkflowStatusIcon({ status }: { status: string }) {
  if (status === 'running') return <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--color-accent)]" />;
  if (status === 'completed') return <CheckCircle2 className="h-3.5 w-3.5 text-[var(--color-success)]" />;
  if (status === 'awaiting_decision' || status === 'awaiting_approval')
    return <PauseCircle className="h-3.5 w-3.5 text-[var(--color-warning)]" />;
  if (status === 'blocked' || status === 'failed') return <AlertTriangle className="h-3.5 w-3.5 text-[var(--color-danger)]" />;
  if (status === 'cancelled' || status === 'interrupted') return <XCircle className="h-3.5 w-3.5 text-[var(--color-muted)]" />;
  return <Circle className={cn('h-3.5 w-3.5 text-[var(--color-muted)]')} />;
}
