import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw, Square, Timer, XCircle } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { api } from '../lib/api';
import { cn } from '../lib/utils';
import type { ImageGenerationJob, ImageJobListResponse } from '../lib/types';
import { useImageGenerationEvents, type ImageGenerationWsEvent } from './useImageGenerationEvents';

type ImageJobQueueViewProps = {
  jobs: ImageGenerationJob[];
  busyJobId: string | null;
  onRetry: (job: ImageGenerationJob) => void;
  onCancel: (job: ImageGenerationJob) => void;
};

export function ImageJobQueue({ projectId }: { projectId: string }): JSX.Element {
  const queryClient = useQueryClient();
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const queryKey = useMemo(() => ['image-jobs', projectId] as const, [projectId]);
  const { data } = useQuery({
    queryKey,
    queryFn: () => api.listImageJobs(projectId),
  });
  const updateJobCache = useCallback((event: ImageGenerationWsEvent) => {
    if ('job' in event) {
      queryClient.setQueryData<ImageJobListResponse>(queryKey, (current) => ({
        jobs: upsertJob(current?.jobs ?? [], event.job),
      }));
    }
    if (event.type === 'image_job:output_added' || event.type === 'image_job:completed') {
      void queryClient.invalidateQueries({ queryKey: ['image-job-details', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['image-gallery-resources', projectId] });
    }
  }, [projectId, queryClient, queryKey]);
  useImageGenerationEvents(projectId, updateJobCache);

  const cancelJob = useMutation({
    mutationFn: (job: ImageGenerationJob) => api.cancelImageJob(projectId, job.id),
    onMutate: (job) => setBusyJobId(job.id),
    onSuccess: ({ job }) => {
      queryClient.setQueryData<ImageJobListResponse>(queryKey, (current) => ({
        jobs: upsertJob(current?.jobs ?? [], job),
      }));
    },
    onSettled: () => setBusyJobId(null),
  });
  const retryJob = useMutation({
    mutationFn: (job: ImageGenerationJob) => api.retryImageJob(projectId, job.id),
    onMutate: (job) => setBusyJobId(job.id),
    onSuccess: ({ job }) => {
      queryClient.setQueryData<ImageJobListResponse>(queryKey, (current) => ({
        jobs: upsertJob(current?.jobs ?? [], job),
      }));
    },
    onSettled: () => setBusyJobId(null),
  });

  return (
    <ImageJobQueueView
      jobs={data?.jobs ?? []}
      busyJobId={busyJobId}
      onCancel={(job) => cancelJob.mutate(job)}
      onRetry={(job) => retryJob.mutate(job)}
    />
  );
}

export function ImageJobQueueView({ jobs, busyJobId, onRetry, onCancel }: ImageJobQueueViewProps): JSX.Element {
  if (jobs.length === 0) {
    return (
      <div className="rounded border border-dashed border-[var(--color-border)] px-3 py-6 text-center text-[12px] text-[var(--color-fg-muted)]">
        图片任务会在这里按状态排列
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {jobs.map((job) => (
        <article key={job.id} className="border border-[var(--color-border)] bg-[var(--color-bg-soft)] p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className={cn('h-2 w-2 rounded-full', statusDotClass(job.status))} aria-hidden="true" />
                <span className="text-[12px] font-semibold">{statusLabel(job.status)}</span>
              </div>
              <p className="mt-2 line-clamp-2 text-[12px] leading-relaxed text-[var(--color-fg-muted)]">
                {job.prompt}
              </p>
              <div className="mt-2 flex flex-wrap gap-2 font-mono text-[10px] uppercase text-[var(--color-fg-subtle)]">
                <span>{job.workflow}</span>
                <span>{job.count} image{job.count > 1 ? 's' : ''}</span>
                <span>{job.size}</span>
              </div>
            </div>
            <Timer className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--color-accent)]" aria-hidden="true" />
          </div>
          {job.error && (
            <div className="mt-2 flex items-start gap-1.5 text-[11px] text-[var(--color-danger)]">
              <XCircle className="mt-0.5 h-3 w-3 flex-shrink-0" aria-hidden="true" />
              <span className="line-clamp-2">{job.error}</span>
            </div>
          )}
          <div className="mt-3 flex gap-2">
            {job.status === 'failed' && (
              <Button type="button" size="sm" variant="secondary" disabled={busyJobId === job.id} onClick={() => onRetry(job)}>
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                重试失败任务
              </Button>
            )}
            {(job.status === 'queued' || job.status === 'running') && (
              <Button type="button" size="sm" variant="secondary" disabled={busyJobId === job.id} onClick={() => onCancel(job)}>
                <Square className="h-3.5 w-3.5" aria-hidden="true" />
                取消运行任务
              </Button>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}

function upsertJob(jobs: ImageGenerationJob[], job: ImageGenerationJob): ImageGenerationJob[] {
  const next = [job, ...jobs.filter((item) => item.id !== job.id)];
  return next.sort((a, b) => b.created_at - a.created_at);
}

function statusLabel(status: ImageGenerationJob['status']): string {
  const labels: Record<ImageGenerationJob['status'], string> = {
    queued: '排队中',
    running: '生成中',
    canceling: '取消中',
    completed: '已完成',
    failed: '失败',
    canceled: '已取消',
  };
  return labels[status];
}

function statusDotClass(status: ImageGenerationJob['status']): string {
  if (status === 'completed') return 'bg-[var(--color-success)]';
  if (status === 'failed' || status === 'canceled') return 'bg-[var(--color-danger)]';
  if (status === 'running' || status === 'queued' || status === 'canceling') return 'bg-[var(--color-accent)]';
  return 'bg-[var(--color-fg-subtle)]';
}
