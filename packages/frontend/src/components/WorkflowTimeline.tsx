import { AlertTriangle, CheckCircle2, Circle, Loader2, PauseCircle, RotateCcw, XCircle } from 'lucide-react';
import type { RoomAgent, TaskArtifact, WorkflowDetail, WorkflowStep } from '../lib/types';
import { WORKFLOW_STAGE_LABEL, WORKFLOW_STATUS_LABEL } from '../lib/types';
import { cn, relativeTime, truncate } from '../lib/utils';
import { Button } from './ui/Button';

export function WorkflowTimeline({
  detail,
  agents,
  onApprove,
  onRetry,
  onCancel,
  busy,
}: {
  detail: WorkflowDetail | null;
  agents: RoomAgent[];
  onApprove: () => void;
  onRetry: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  if (!detail) {
    return <div className="text-[12px] text-[var(--color-fg-muted)]">尚未启动开发闭环</div>;
  }

  const agentMap = new Map(agents.map((agent) => [agent.id, agent]));
  const artifacts = [...detail.artifacts].reverse();
  const hasRetryableStep = detail.steps.some((step) => step.status === 'failed' || step.status === 'cancelled');
  const canRetry =
    detail.run.status === 'blocked' ||
    ((detail.run.status === 'failed' || detail.run.status === 'cancelled') && hasRetryableStep);

  return (
    <div className="space-y-3">
      <div className="surface-2 rounded-lg p-3">
        <div className="flex items-center gap-2">
          <WorkflowStatusIcon status={detail.run.status} />
          <div className="font-display text-[12.5px] font-semibold">
            {WORKFLOW_STATUS_LABEL[detail.run.status]}
          </div>
          <span className="ml-auto text-[10.5px] font-mono text-[var(--color-muted)]">
            {relativeTime(detail.run.updated_at)}
          </span>
        </div>
        {detail.run.error && (
          <div className="mt-2 break-words text-[11.5px] text-[var(--color-danger)]">
            {detail.run.error}
          </div>
        )}
      </div>

      <div className="space-y-2">
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

      <div className="flex flex-wrap gap-2">
        {detail.run.status === 'awaiting_approval' && (
          <Button size="sm" onClick={onApprove} disabled={busy}>
            <CheckCircle2 className="h-3.5 w-3.5" />
            确认计划
          </Button>
        )}
        {canRetry && (
          <Button size="sm" variant="secondary" onClick={onRetry} disabled={busy}>
            <RotateCcw className="h-3.5 w-3.5" />
            重试
          </Button>
        )}
        {['running', 'awaiting_approval', 'blocked'].includes(detail.run.status) && (
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
            <XCircle className="h-3.5 w-3.5" />
            取消
          </Button>
        )}
      </div>
    </div>
  );
}

function StepRow({ step, agentName }: { step: WorkflowStep; agentName?: string }) {
  return (
    <div className="surface-2 rounded-lg p-3">
      <div className="flex items-center gap-2">
        <WorkflowStatusIcon status={step.status} />
        <div className="min-w-0 flex-1 truncate font-display text-[12px] font-medium">
          {WORKFLOW_STAGE_LABEL[step.stage]}
        </div>
        <span className="max-w-[45%] shrink-0 truncate text-[10.5px] font-mono text-[var(--color-muted)]">
          {agentName ?? '系统'}
        </span>
      </div>
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
    <details className="surface-2 rounded-lg p-3">
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
  if (status === 'awaiting_approval') return <PauseCircle className="h-3.5 w-3.5 text-[var(--color-warning)]" />;
  if (status === 'blocked' || status === 'failed') return <AlertTriangle className="h-3.5 w-3.5 text-[var(--color-danger)]" />;
  if (status === 'cancelled') return <XCircle className="h-3.5 w-3.5 text-[var(--color-muted)]" />;
  return <Circle className={cn('h-3.5 w-3.5 text-[var(--color-muted)]')} />;
}
