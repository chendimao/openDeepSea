import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, RotateCcw, Square, Timer, XCircle } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { api } from '../lib/api';
import { cn } from '../lib/utils';
import type { ImageGenerationJob, ImageGenerationOutput, ImageJobDetailResponse } from '../lib/types';
import { useImageGenerationEvents, type ImageGenerationWsEvent } from './useImageGenerationEvents';

type ImageJobStatusCardViewProps = {
  projectId: string;
  detail: ImageJobDetailResponse | null;
  busy: boolean;
  onCancel: () => void;
  onRetry: () => void;
};

export function ImageJobStatusCard({
  projectId,
  jobId,
}: {
  projectId: string;
  jobId: string;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [activeJobId, setActiveJobId] = useState(jobId);
  const [busy, setBusy] = useState(false);
  const queryKey = useMemo(() => ['image-job-detail', projectId, activeJobId] as const, [projectId, activeJobId]);
  const { data = null } = useQuery({
    queryKey,
    queryFn: () => api.getImageJob(projectId, activeJobId),
  });

  useEffect(() => {
    setActiveJobId(jobId);
  }, [jobId]);

  const refreshJob = useCallback((event: ImageGenerationWsEvent) => {
    if (getImageEventJobId(event) !== activeJobId) return;
    if (event.type === 'image_job:completed') {
      queryClient.setQueryData<ImageJobDetailResponse>(queryKey, (current) => ({
        job: event.job,
        outputs: event.outputs,
        source_images: current?.source_images ?? [],
      }));
      return;
    }
    if (event.type === 'image_job:output_added') {
      queryClient.setQueryData<ImageJobDetailResponse>(queryKey, (current) => {
        if (!current) return current;
        return {
          ...current,
          outputs: upsertOutput(current.outputs, event.output),
        };
      });
      return;
    }
    if ('job' in event) {
      queryClient.setQueryData<ImageJobDetailResponse>(queryKey, (current) => current
        ? { ...current, job: event.job }
        : current);
    }
  }, [activeJobId, queryClient, queryKey]);
  useImageGenerationEvents(projectId, refreshJob);

  const cancelJob = useMutation({
    mutationFn: () => api.cancelImageJob(projectId, activeJobId),
    onMutate: () => setBusy(true),
    onSuccess: ({ job }) => {
      queryClient.setQueryData<ImageJobDetailResponse>(queryKey, (current) => current
        ? { ...current, job }
        : current);
    },
    onSettled: () => setBusy(false),
  });
  const retryJob = useMutation({
    mutationFn: () => api.retryImageJob(projectId, activeJobId),
    onMutate: () => setBusy(true),
    onSuccess: async ({ job }) => {
      await queryClient.invalidateQueries({ queryKey: ['image-jobs', projectId] });
      setActiveJobId(job.id);
      queryClient.setQueryData<ImageJobDetailResponse>(['image-job-detail', projectId, job.id], {
        job,
        outputs: [],
        source_images: data?.source_images ?? [],
      });
    },
    onSettled: () => setBusy(false),
  });

  return (
    <ImageJobStatusCardView
      projectId={projectId}
      detail={data}
      busy={busy}
      onCancel={() => cancelJob.mutate()}
      onRetry={() => retryJob.mutate()}
    />
  );
}

export function ImageJobStatusCardView({
  projectId,
  detail,
  busy,
  onCancel,
  onRetry,
}: ImageJobStatusCardViewProps): JSX.Element {
  if (!detail) {
    return (
      <article className="mt-2 min-h-[150px] border border-dashed border-[var(--color-border)] bg-[var(--color-bg-soft)] p-3 text-[12px] text-[var(--color-fg-muted)]">
        图片任务状态加载中...
      </article>
    );
  }

  const { job, outputs } = detail;
  const canCancel = job.status === 'queued' || job.status === 'running';
  const canRetry = job.status === 'completed' || job.status === 'failed' || job.status === 'canceled';

  return (
    <article className="mt-2 min-h-[150px] border border-[var(--color-border)] bg-[var(--color-bg-soft)] p-3" aria-label="会话图片任务">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={cn('h-2 w-2 rounded-full', statusDotClass(job.status))} aria-hidden="true" />
            <span className="text-[12px] font-semibold text-[var(--color-fg)]">会话图片任务</span>
            <span className="text-[11px] text-[var(--color-fg-muted)]">{statusLabel(job.status)}</span>
          </div>
          <p className="mt-2 line-clamp-2 text-[12px] leading-relaxed text-[var(--color-fg-muted)]">
            {job.prompt}
          </p>
        </div>
        <a
          href={`/projects/${projectId}/images`}
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-[var(--color-accent)] hover:bg-[var(--color-surface-raised)]"
        >
          打开工作台
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </a>
      </div>

      {outputs.length > 0 ? (
        <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4" aria-label="生成图片">
          {outputs.map((output) => (
            <a
              key={output.id}
              href={output.url}
              target="_blank"
              rel="noreferrer"
              className="block aspect-square overflow-hidden border border-[var(--color-border)] bg-[var(--color-surface)]"
            >
              <img
                src={output.url}
                alt={output.name}
                width={output.width ?? undefined}
                height={output.height ?? undefined}
                loading="lazy"
                decoding="async"
                className="h-full w-full object-cover"
              />
            </a>
          ))}
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-2 text-[11px] text-[var(--color-fg-muted)]">
          <Timer className="h-3.5 w-3.5" aria-hidden="true" />
          {emptyOutputLabel(job.status)}
        </div>
      )}

      {job.error && (
        <div className="mt-2 flex items-start gap-1.5 text-[11px] text-[var(--color-danger)]">
          <XCircle className="mt-0.5 h-3 w-3 flex-shrink-0" aria-hidden="true" />
          <span className="line-clamp-2">{job.error}</span>
        </div>
      )}

      {(canCancel || canRetry) && (
        <div className="mt-3 flex flex-wrap gap-2">
          {canCancel && (
            <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={onCancel}>
              <Square className="h-3.5 w-3.5" aria-hidden="true" />
              取消
            </Button>
          )}
          {canRetry && (
            <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={onRetry}>
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              重试
            </Button>
          )}
        </div>
      )}
    </article>
  );
}

export function parseImageGenerationJobIdFromMetadata(metadata: string | null): string | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const value = (parsed as { image_generation_job_id?: unknown }).image_generation_job_id;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

function getImageEventJobId(event: ImageGenerationWsEvent): string | null {
  if ('job' in event) return event.job.id;
  return event.jobId;
}

function upsertOutput(outputs: ImageGenerationOutput[], output: ImageGenerationOutput): ImageGenerationOutput[] {
  return [...outputs.filter((item) => item.id !== output.id), output].sort((a, b) => a.slot - b.slot);
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

function emptyOutputLabel(status: ImageGenerationJob['status']): string {
  if (status === 'failed') return '未生成图片';
  if (status === 'canceled') return '任务已取消';
  if (status === 'completed') return '未返回图片';
  return '等待生成结果';
}
