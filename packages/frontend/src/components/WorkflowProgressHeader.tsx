import { CheckCircle2, GitBranch, Loader2 } from 'lucide-react';
import type { WorkflowPlanJson } from '../lib/types';

export function WorkflowProgressHeader({ plan }: { plan: WorkflowPlanJson }) {
  const total = plan.tasks.length;
  const completed = plan.tasks.filter((task) => task.status === 'completed').length;
  const running = plan.tasks.filter((task) => task.status === 'running').length;
  const progress = total > 0 ? Math.round(plan.tasks.reduce((sum, task) => sum + task.progress, 0) / total) : 0;

  return (
    <div className="workflow-plan-header">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <GitBranch className="h-3.5 w-3.5 shrink-0 text-[var(--color-primary)]" />
          <div className="truncate font-display text-[12.5px] font-semibold">{plan.workflow_name}</div>
        </div>
        <div className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-[var(--color-fg-muted)]">
          {plan.summary || plan.goal}
        </div>
      </div>
      <div className="workflow-plan-progress" aria-label={`workflow progress ${progress}%`}>
        <div className="flex items-center justify-between gap-3 text-[10.5px] font-mono text-[var(--color-muted)]">
          <span>{progress}%</span>
          <span className="inline-flex items-center gap-1">
            {running > 0 ? (
              <Loader2 className="h-3 w-3 animate-spin text-[var(--color-accent)]" />
            ) : (
              <CheckCircle2 className="h-3 w-3 text-[var(--color-success)]" />
            )}
            {completed}/{total}
          </span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--color-surface-raised)]">
          <div
            className="h-full rounded-full bg-[var(--color-primary)] transition-[width] duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
    </div>
  );
}
