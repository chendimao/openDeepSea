import type { PlannerDecision, RoomAgent } from '../../lib/types';
import { hasDispatchablePlannerSteps } from '../../pages/roomPageLogic';

interface PlannerDecisionPanelProps {
  decision: PlannerDecision;
  roomAgents: RoomAgent[];
  continuing: boolean;
  onContinue: () => void;
}

export function PlannerDecisionPanel({
  decision,
  roomAgents,
  continuing,
  onContinue,
}: PlannerDecisionPanelProps): JSX.Element {
  const activeAgentIds = new Set(roomAgents.filter((agent) => agent.left_at === null).map((agent) => agent.agent_id));
  const missingAgentIds = decision.next_steps
    .map((step) => step.agent_id)
    .filter((agentId) => !activeAgentIds.has(agentId));
  const canContinue = hasDispatchablePlannerSteps(decision);

  return (
    <section className="mt-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)]/55 px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="rounded-full bg-[var(--color-surface-raised)] px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-muted)]">
            Planner
          </span>
          <span className="rounded-full bg-[var(--color-surface-raised)] px-2 py-0.5 text-[10px] text-[var(--color-fg-muted)]">
            {formatPlannerMode(decision.mode)}
          </span>
          <span className="rounded-full bg-[var(--color-surface-raised)] px-2 py-0.5 text-[10px] text-[var(--color-fg-muted)]">
            {formatPlannerStatus(decision.status)}
          </span>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <span className="rounded-full bg-[var(--color-surface-raised)] px-2 py-0.5 font-mono text-[10px] text-[var(--color-fg-muted)]">
            {decision.next_steps.length} 步
          </span>
          <span className="rounded-full bg-[var(--color-surface-raised)] px-2 py-0.5 text-[10px] text-[var(--color-fg-muted)]">
            {decision.awaiting_user_confirmation ? '等待确认' : '无需确认'}
          </span>
        </div>
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-fg)]">{decision.summary}</p>
      {decision.next_steps.length > 0 && (
        <ol className="mt-2 grid gap-1.5">
          {decision.next_steps.map((step, index) => (
            <li
              key={`${step.agent_id}-${index}`}
              className="grid gap-1 rounded-md bg-[var(--color-surface-raised)]/60 px-2.5 py-2 text-[11.5px] text-[var(--color-fg-muted)] sm:grid-cols-[minmax(128px,0.32fr)_1fr] sm:items-start"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="font-mono text-[10px] text-[var(--color-muted)]">#{index + 1}</span>
                <span className="min-w-0 truncate font-mono text-[10.5px] text-[var(--color-fg)]" title={step.agent_id}>
                  {step.agent_id}
                </span>
              </div>
              <span className="min-w-0 leading-relaxed text-[var(--color-fg-muted)]">{step.goal}</span>
            </li>
          ))}
        </ol>
      )}
      {missingAgentIds.length > 0 && (
        <p className="mt-2 text-[11.5px] leading-relaxed text-[var(--color-fg-muted)]">
          缺席智能体：
          <span className="font-mono text-[var(--color-warning)]">{missingAgentIds.join(', ')}</span>。
          继续时会自动从全局智能体库查找并加入。
        </p>
      )}
      {decision.awaiting_user_confirmation && (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {canContinue ? (
            <button
              type="button"
              className="glass-button glass-button-primary"
              disabled={continuing}
              onClick={onContinue}
            >
              {continuing ? '继续中…' : '按建议继续'}
            </button>
          ) : (
            <span className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-[11.5px] text-[var(--color-fg-muted)]">
              当前建议没有可派发的下一步
            </span>
          )}
        </div>
      )}
    </section>
  );
}

function formatPlannerMode(mode: PlannerDecision['mode']): string {
  const labels: Record<PlannerDecision['mode'], string> = {
    pause_after_suggestion: '建议后暂停',
    auto_continue: '自动继续',
    dispatch_next: '继续派发',
  };
  return labels[mode] ?? mode;
}

function formatPlannerStatus(status: PlannerDecision['status']): string {
  const labels: Record<PlannerDecision['status'], string> = {
    suggested: '已建议',
    dispatching: '派发中',
    completed: '已完成',
    blocked: '已阻塞',
    needs_fix: '需修复',
  };
  return labels[status] ?? status;
}
