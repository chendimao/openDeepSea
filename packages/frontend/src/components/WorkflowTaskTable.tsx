import { CheckCircle2, Circle, Loader2, PauseCircle, XCircle } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import type { RoomAgent, WorkflowPlanJson, WorkflowPlanTaskJson } from '../lib/types';
import { cn, truncate } from '../lib/utils';

export function WorkflowTaskTable({
  plan,
  agents,
}: {
  plan: WorkflowPlanJson;
  agents: RoomAgent[];
}) {
  const { t, workflowRoleLabel } = useI18n();
  const agentMap = new Map(agents.map((agent) => [agent.id, agent]));
  const titleMap = new Map(plan.tasks.map((task) => [task.id, task.title]));

  return (
    <div className="workflow-task-table-wrap" role="region" aria-label={t('workflowPlan.tableAria')}>
      <table className="workflow-task-table">
        <thead>
          <tr>
            <th>{t('workflowPlan.columnTask')}</th>
            <th>{t('workflowPlan.columnRole')}</th>
            <th>{t('workflowPlan.columnAgent')}</th>
            <th>{t('workflowPlan.columnMode')}</th>
            <th>{t('workflowPlan.columnDepends')}</th>
            <th>{t('workflowPlan.columnProgress')}</th>
          </tr>
        </thead>
        <tbody>
          {plan.tasks.map((task) => {
            const agentName = task.agent_id ? agentMap.get(task.agent_id)?.agent_name : null;
            return (
              <tr key={task.id}>
                <td>
                  <div className="flex min-w-[180px] items-start gap-2">
                    <TaskStatusIcon task={task} />
                    <div className="min-w-0">
                      <div className="truncate font-medium text-[var(--color-fg)]" title={task.title}>
                        {task.title}
                      </div>
                      {task.description && (
                        <div className="mt-0.5 line-clamp-2 text-[10.5px] leading-relaxed text-[var(--color-fg-muted)]">
                          {truncate(task.description, 110)}
                        </div>
                      )}
                    </div>
                  </div>
                </td>
                <td>{workflowRoleLabel(task.role)}</td>
                <td>
                  <span className="block max-w-[120px] truncate" title={agentName ?? t('workflowPlan.unassigned')}>
                    {agentName ?? t('workflowPlan.unassigned')}
                  </span>
                </td>
                <td>
                  <span className={cn('workflow-mode-pill', task.mode === 'parallel' ? 'is-parallel' : 'is-serial')}>
                    {t(`workflowPlan.mode.${task.mode}`)}
                  </span>
                </td>
                <td>
                  <span
                    className="block max-w-[160px] truncate"
                    title={
                      task.depends_on.length > 0
                        ? task.depends_on.map((id) => titleMap.get(id) ?? id).join(', ')
                        : t('workflowPlan.noDepends')
                    }
                  >
                    {task.depends_on.length > 0
                      ? task.depends_on.map((id) => titleMap.get(id) ?? id).join(', ')
                      : t('workflowPlan.noDepends')}
                  </span>
                </td>
                <td>
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-16 overflow-hidden rounded-full bg-[var(--color-surface-raised)]">
                      <div
                        className={cn(
                          'h-full rounded-full transition-[width] duration-300',
                          task.status === 'failed' || task.status === 'blocked'
                            ? 'bg-[var(--color-danger)]'
                            : 'bg-[var(--color-primary)]',
                        )}
                        style={{ width: `${task.progress}%` }}
                      />
                    </div>
                    <span className="w-8 text-right font-mono text-[10px] text-[var(--color-muted)]">
                      {task.progress}%
                    </span>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TaskStatusIcon({ task }: { task: WorkflowPlanTaskJson }) {
  if (task.status === 'running') return <Loader2 className="mt-0.5 h-3.5 w-3.5 animate-spin text-[var(--color-accent)]" />;
  if (task.status === 'completed') return <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 text-[var(--color-success)]" />;
  if (task.status === 'blocked') return <PauseCircle className="mt-0.5 h-3.5 w-3.5 text-[var(--color-warning)]" />;
  if (task.status === 'failed') return <XCircle className="mt-0.5 h-3.5 w-3.5 text-[var(--color-danger)]" />;
  return <Circle className="mt-0.5 h-3.5 w-3.5 text-[var(--color-muted)]" />;
}
