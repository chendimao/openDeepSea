import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Ban, CircleAlert, CircleCheck, LoaderCircle, Terminal } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import type { AgentRun, RoomAgent } from '../lib/types';
import { AGENT_RUN_STATUS_LABEL } from '../lib/types';
import { cn, relativeTime, truncate } from '../lib/utils';
import { Button } from './ui/Button';

export function AgentRunStatusCard({
  roomId,
  run,
  agent,
  compact = false,
}: {
  roomId: string;
  run: AgentRun;
  agent?: RoomAgent;
  compact?: boolean;
}) {
  const queryClient = useQueryClient();
  const cancel = useMutation({
    mutationFn: (id: string) => api.cancelAgentRun(id),
    onSuccess: (run) => {
      queryClient.setQueryData<AgentRun[] | undefined>(['agent-runs', roomId], (prev) =>
        upsertRun(prev, run),
      );
      toast.success('执行已取消');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const hasDiagnostics = Boolean(run.stderr || run.error);

  return (
    <section
      className={cn(
        'rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]',
        compact ? 'px-3 py-2' : 'px-3 py-2.5',
      )}
    >
      <div className="flex items-start gap-2">
        <RunStatusIcon status={run.status} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-display text-[12px] font-semibold text-[var(--color-fg)]">
              执行状态
            </span>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-[var(--color-border)] text-[var(--color-fg-muted)]">
              {run.backend}
            </span>
            <span className={cn('text-[10px] font-mono', statusClass(run.status))}>
              {AGENT_RUN_STATUS_LABEL[run.status]}
            </span>
          </div>
          <div className="mt-1 text-[11px] text-[var(--color-fg-muted)] truncate">
            {truncate(run.prompt, 120)}
          </div>
          <div className="mt-1 font-mono text-[10.5px] text-[var(--color-muted)]">
            {agent?.agent_name ?? run.agent_id} · {relativeTime(run.started_at)}
            {run.acp_session_id ? ` · session ${truncate(run.acp_session_id, 12)}` : ''}
          </div>
        </div>
        {run.status === 'running' && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => cancel.mutate(run.id)}
            disabled={cancel.isPending}
            aria-label="取消执行"
            title="取消执行"
          >
            <Ban className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {hasDiagnostics && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] font-mono text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]">
            stderr / error
          </summary>
          <pre className="mt-2 max-h-[120px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--color-code-bg)] px-2.5 py-2 text-[11px] leading-relaxed text-[var(--color-fg-muted)]">
            {[run.error, run.stderr].filter(Boolean).join('\n')}
          </pre>
        </details>
      )}
    </section>
  );
}

function upsertRun(prev: AgentRun[] | undefined, run: AgentRun): AgentRun[] {
  const list = prev ?? [];
  const next = [run, ...list.filter((item) => item.id !== run.id)];
  return next.sort((a, b) => b.started_at - a.started_at).slice(0, 50);
}

function RunStatusIcon({ status }: { status: AgentRun['status'] }) {
  if (status === 'running') {
    return <LoaderCircle className="mt-0.5 h-3.5 w-3.5 animate-spin text-[var(--color-accent)]" />;
  }
  if (status === 'completed') {
    return <CircleCheck className="mt-0.5 h-3.5 w-3.5 text-[var(--color-success)]" />;
  }
  return <CircleAlert className="mt-0.5 h-3.5 w-3.5 text-[var(--color-danger)]" />;
}

function statusClass(status: AgentRun['status']): string {
  if (status === 'running') return 'text-[var(--color-accent)]';
  if (status === 'completed') return 'text-[var(--color-success)]';
  if (status === 'cancelled') return 'text-[var(--color-fg-muted)]';
  return 'text-[var(--color-danger)]';
}
