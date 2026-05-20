import { CheckCircle2, Circle, Info, Loader2, PauseCircle, SkipForward, XCircle } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../lib/i18n';
import type { RoomAgent, WorkflowPlanJson, WorkflowPlanTaskJson } from '../lib/types';
import { cn, truncate } from '../lib/utils';
import { Button } from './ui/Button';
import { Dialog, DialogContent } from './ui/Dialog';

export function WorkflowTaskTable({
  plan,
  agents,
  availableTaskIds = [],
  compact = false,
}: {
  plan: WorkflowPlanJson;
  agents: RoomAgent[];
  availableTaskIds?: string[];
  compact?: boolean;
}) {
  const { t, workflowRoleLabel } = useI18n();
  const [detailTask, setDetailTask] = useState<WorkflowPlanTaskJson | null>(null);
  const agentMap = new Map(agents.map((agent) => [agent.id, agent]));
  const titleMap = new Map(plan.tasks.map((task) => [task.id, task.title]));
  const executableTasks = plan.tasks.filter((task) =>
    task.role === 'executor' && (availableTaskIds.length === 0 || availableTaskIds.includes(task.id)),
  );

  return (
    <>
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
              {compact && <th>{t('workflowPlan.columnAction')}</th>}
            </tr>
          </thead>
          <tbody>
            {executableTasks.map((task) => {
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
                              : task.status === 'skipped'
                                ? 'bg-[var(--color-muted)]'
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
                  {compact && (
                    <td className="workflow-task-action-cell">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="workflow-task-detail-button"
                        aria-label={t('workflowPlan.viewTaskDetail', { title: task.title })}
                        title={t('workflowPlan.viewDetail')}
                        onClick={() => setDetailTask(task)}
                      >
                        <Info className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>{t('workflowPlan.viewDetail')}</span>
                      </Button>
                    </td>
                  )}
                </tr>
              );
            })}
            {executableTasks.length === 0 && (
              <tr>
                <td colSpan={compact ? 7 : 6} className="workflow-task-empty-cell">
                  {t('workflowPlan.noResult')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={Boolean(detailTask)} onOpenChange={(open) => !open && setDetailTask(null)}>
        <DialogContent
          className="workflow-task-detail-dialog"
          title={detailTask?.title ?? t('workflowPlan.detailTitle')}
          description={detailTask ? t('workflowPlan.detailDescription') : undefined}
        >
          {detailTask && (
            <WorkflowTaskDetailContent
              task={detailTask}
              agentName={
                detailTask.agent_id ? agentMap.get(detailTask.agent_id)?.agent_name ?? detailTask.agent_id : null
              }
              dependencies={detailTask.depends_on.map((id) => titleMap.get(id) ?? id).filter((item) => item.trim())}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function WorkflowTaskDetailContent({
  task,
  agentName,
  dependencies,
}: {
  task: WorkflowPlanTaskJson;
  agentName: string | null;
  dependencies: string[];
}) {
  const { t, workflowRoleLabel } = useI18n();
  const emptyText = t('common.none');
  const description = task.description.trim() || emptyText;
  const resultRefs = task.result_refs.filter((item) => item.trim().length > 0);

  return (
    <div className="workflow-task-detail-content">
      <dl className="workflow-task-detail-grid">
        <DetailField label={t('workflowPlan.detailStatus')} value={t(`workflowPlan.status.${task.status}`)} />
        <DetailField label={t('workflowPlan.columnRole')} value={workflowRoleLabel(task.role)} />
        <DetailField label={t('workflowPlan.columnAgent')} value={agentName ?? t('workflowPlan.unassigned')} />
        <DetailField label={t('workflowPlan.columnMode')} value={t(`workflowPlan.mode.${task.mode}`)} />
        <DetailField label={t('workflowPlan.columnProgress')} value={`${task.progress}%`} />
        <DetailField label={t('workflowPlan.detailTaskId')} value={task.id} />
      </dl>

      <DetailSection label={t('workflowPlan.detailDescriptionText')}>{description}</DetailSection>

      <DetailSection label={t('workflowPlan.detailAcceptance')}>
        {t('workflowPlan.detailAcceptanceEmpty')}
      </DetailSection>

      <DetailList
        label={t('workflowPlan.columnDepends')}
        emptyText={t('workflowPlan.noDepends')}
        items={dependencies}
      />

      <DetailList
        label={t('workflowPlan.detailResultRefs')}
        emptyText={t('workflowPlan.noResult')}
        items={resultRefs}
      />
    </div>
  );
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

function DetailList({ label, emptyText, items }: { label: string; emptyText: string; items: string[] }) {
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
        <p>{emptyText}</p>
      )}
    </section>
  );
}

function TaskStatusIcon({ task }: { task: WorkflowPlanTaskJson }) {
  if (task.status === 'running') return <Loader2 className="mt-0.5 h-3.5 w-3.5 animate-spin text-[var(--color-accent)]" />;
  if (task.status === 'completed') return <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 text-[var(--color-success)]" />;
  if (task.status === 'blocked') return <PauseCircle className="mt-0.5 h-3.5 w-3.5 text-[var(--color-warning)]" />;
  if (task.status === 'failed') return <XCircle className="mt-0.5 h-3.5 w-3.5 text-[var(--color-danger)]" />;
  if (task.status === 'skipped') return <SkipForward className="mt-0.5 h-3.5 w-3.5 text-[var(--color-muted)]" />;
  return <Circle className="mt-0.5 h-3.5 w-3.5 text-[var(--color-muted)]" />;
}
