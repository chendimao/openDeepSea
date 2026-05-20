import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, History, Loader2, PlayCircle, RotateCcw } from 'lucide-react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import type { Skill, SkillRun, SkillRunStatus } from '../lib/types';
import { cn, truncate } from '../lib/utils';
import { Button } from './ui/Button';

export function SkillRunHistoryPanel({
  selectedSkillId,
  skills,
  onClearFilter,
}: {
  selectedSkillId: string | null;
  skills: Skill[];
  onClearFilter: () => void;
}): JSX.Element {
  const { formatRelativeTime, t } = useI18n();
  const runsQuery = useQuery({
    queryKey: ['skills', 'runs', selectedSkillId ?? 'all'],
    queryFn: () => api.listSkillRuns(selectedSkillId ? { skillId: selectedSkillId } : {}),
    refetchInterval: (query) => {
      const runs = query.state.data as SkillRun[] | undefined;
      return runs?.some((run) => run.status === 'queued' || run.status === 'running') ? 2000 : false;
    },
  });
  const skillNames = useMemo(
    () => new Map(skills.map((skill) => [skill.id, skill.name])),
    [skills],
  );
  const runs = runsQuery.data ?? [];
  const selectedSkillName = selectedSkillId ? skillNames.get(selectedSkillId) ?? selectedSkillId : null;

  return (
    <section className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-[var(--color-accent)]" strokeWidth={1.75} />
            <h4 className="text-[13px] font-semibold text-[var(--color-fg)]">
              {t('settings.skillsRunHistoryTitle')}
            </h4>
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-fg-muted)]">
            {selectedSkillName
              ? t('settings.skillsRunHistoryFiltered', { name: selectedSkillName })
              : t('settings.skillsRunHistoryDescription')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {selectedSkillId && (
            <Button type="button" size="sm" variant="ghost" onClick={onClearFilter}>
              {t('settings.skillsRunHistoryShowAll')}
            </Button>
          )}
          <Button type="button" size="sm" variant="ghost" onClick={() => runsQuery.refetch()} aria-label={t('common.refresh')}>
            <RotateCcw className={cn('h-3.5 w-3.5', runsQuery.isFetching && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {runsQuery.isLoading ? (
        <div className="flex min-h-[180px] items-center justify-center text-[12px] text-[var(--color-fg-muted)]">
          <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
          {t('common.loading')}
        </div>
      ) : runsQuery.isError ? (
        <div className="rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-surface)] p-4 text-[12px] text-[var(--color-fg-muted)]">
          <div className="font-medium text-[var(--color-danger)]">{t('settings.skillsRunHistoryLoadFailed')}</div>
          <div className="mt-1 break-words">{(runsQuery.error as Error).message}</div>
          <Button type="button" size="sm" variant="secondary" className="mt-3" onClick={() => runsQuery.refetch()}>
            <RotateCcw className="h-3.5 w-3.5" />
            {t('common.retry')}
          </Button>
        </div>
      ) : runs.length === 0 ? (
        <div className="rounded-md border border-dashed border-[var(--color-border)] p-4 text-[12px] text-[var(--color-fg-muted)]">
          {t('settings.skillsRunHistoryEmpty')}
        </div>
      ) : (
        <div className="max-h-[430px] space-y-2 overflow-y-auto pr-1">
          {runs.map((run) => (
            <RunHistoryItem
              key={run.id}
              run={run}
              skillName={skillNames.get(run.skill_id) ?? run.skill_id}
              relativeTime={formatRelativeTime(run.updated_at)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function RunHistoryItem({
  run,
  skillName,
  relativeTime,
}: {
  run: SkillRun;
  skillName: string;
  relativeTime: string;
}): JSX.Element {
  const { t } = useI18n();
  const output = summarizeRunOutput(run);

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5">
      <div className="flex items-start gap-2">
        <RunStatusIcon status={run.status} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-[12px] font-semibold text-[var(--color-fg)]">{skillName}</span>
            <span className={cn('font-mono text-[10px]', statusClass(run.status))}>
              {skillRunStatusLabel(run.status, t)}
            </span>
            <span className="rounded bg-[var(--color-surface-raised)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-fg-muted)]">
              {run.runtime}
            </span>
            <span className="font-mono text-[10px] text-[var(--color-fg-muted)]">
              {t('settings.skillsRunExitCode')}: {run.exit_code ?? t('common.none')}
            </span>
            <span className="font-mono text-[10px] text-[var(--color-fg-muted)]">
              {t('settings.skillsRunAllowedPaths')}: {run.allowed_paths_count}
            </span>
          </div>
          <div className="mt-1 font-mono text-[10.5px] text-[var(--color-muted)]">
            {relativeTime} / {run.invoked_by}
          </div>
          <div className="mt-2 grid gap-2 lg:grid-cols-3">
            <OutputSummary label={t('settings.skillsRunStdout')} value={output.stdout} />
            <OutputSummary label={t('settings.skillsRunStderr')} value={output.stderr} />
            <OutputSummary label={t('settings.skillsRunError')} value={output.error} tone={run.error ? 'danger' : 'muted'} />
          </div>
        </div>
      </div>
    </div>
  );
}

function OutputSummary({
  label,
  value,
  tone = 'muted',
}: {
  label: string;
  value: string;
  tone?: 'muted' | 'danger';
}): JSX.Element {
  return (
    <div className="min-w-0 rounded bg-[var(--color-surface-raised)] px-2 py-1.5">
      <div className="font-mono text-[10px] text-[var(--color-fg-muted)]">{label}</div>
      <div
        className={cn(
          'mt-1 min-h-4 break-words font-mono text-[10.5px] leading-relaxed',
          tone === 'danger' ? 'text-[var(--color-danger)]' : 'text-[var(--color-fg-muted)]',
        )}
      >
        {value}
      </div>
    </div>
  );
}

function summarizeRunOutput(run: SkillRun): { stdout: string; stderr: string; error: string } {
  return {
    stdout: summarizeText(run.stdout),
    stderr: summarizeText(run.stderr),
    error: summarizeText(run.error),
  };
}

function summarizeText(value: string | null): string {
  const normalized = value?.trim().replace(/\s+/g, ' ') ?? '';
  return normalized ? truncate(normalized, 160) : '-';
}

function RunStatusIcon({ status }: { status: SkillRunStatus }): JSX.Element {
  if (status === 'running' || status === 'queued') {
    return <Loader2 className="mt-0.5 h-3.5 w-3.5 animate-spin text-[var(--color-accent)]" />;
  }
  if (status === 'completed') {
    return <CircleCheck className="mt-0.5 h-3.5 w-3.5 text-[var(--color-success)]" />;
  }
  if (status === 'cancelled') {
    return <PlayCircle className="mt-0.5 h-3.5 w-3.5 text-[var(--color-muted)]" />;
  }
  return <CircleAlert className="mt-0.5 h-3.5 w-3.5 text-[var(--color-danger)]" />;
}

function statusClass(status: SkillRunStatus): string {
  if (status === 'running' || status === 'queued') return 'text-[var(--color-accent)]';
  if (status === 'completed') return 'text-[var(--color-success)]';
  if (status === 'cancelled') return 'text-[var(--color-fg-muted)]';
  return 'text-[var(--color-danger)]';
}

function skillRunStatusLabel(status: SkillRunStatus, t: ReturnType<typeof useI18n>['t']): string {
  const labels: Record<SkillRunStatus, string> = {
    queued: t('settings.skillsRunStatusQueued'),
    running: t('settings.skillsRunStatusRunning'),
    completed: t('settings.skillsRunStatusCompleted'),
    failed: t('settings.skillsRunStatusFailed'),
    cancelled: t('settings.skillsRunStatusCancelled'),
  };
  return labels[status];
}
