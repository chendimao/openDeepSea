import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Image as ImageIcon, ImagePlus, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../components/ui/Button';
import { Dialog, DialogContent } from '../components/ui/Dialog';
import { Input, Textarea } from '../components/ui/Input';
import { api } from '../lib/api';
import { cn } from '../lib/utils';
import type { ImageJobCreateInput } from '../lib/types';
import {
  buildImageJobPayload,
  createEmptyImageJobFormState,
  type ImageJobFormState,
} from './ImageJobForm';
import { SourceImagePicker } from './SourceImagePicker';

type ImageGenerationDialogViewProps = {
  projectId: string;
  state: ImageJobFormState;
  busy: boolean;
  error: string | null;
  onStateChange: (patch: Partial<ImageJobFormState>) => void;
  onSubmit: () => void;
};

const qualityOptions = ['auto', 'low', 'medium', 'high'];
const sizeOptions = ['auto', '1024x1024', '1024x1536', '1536x1024'];

export function ImageGenerationDialog({
  projectId,
  sessionId,
  open,
  onOpenChange,
}: {
  projectId: string;
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [state, setState] = useState<ImageJobFormState>(() => createSessionImageDialogState());
  const [error, setError] = useState<string | null>(null);
  const createJob = useMutation({
    mutationFn: () => api.createImageJob(projectId, buildSessionImageJobPayload(state, sessionId)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['image-jobs', projectId] });
      await queryClient.invalidateQueries({ queryKey: ['session-detail', sessionId] });
      setState(createSessionImageDialogState());
      setError(null);
      onOpenChange(false);
      toast.success('图片任务已创建');
    },
    onError: (err) => setError(err instanceof Error ? err.message : '图片任务创建失败'),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="生成图片"
        description="为当前 session 创建一个图片生成任务。"
        className="w-[min(92vw,640px)]"
      >
        <ImageGenerationDialogView
          projectId={projectId}
          state={state}
          busy={createJob.isPending}
          error={error}
          onStateChange={(patch) => {
            setState((current) => ({ ...current, ...patch }));
            setError(null);
          }}
          onSubmit={() => {
            if (!canSubmitSessionImageJob(state)) {
              setError(state.workflow === 'image-to-image' && state.sourceFiles.length === 0
                ? '图生图需要至少选择一张源图'
                : '请填写提示词');
              return;
            }
            createJob.mutate();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

export function ImageGenerationDialogView({
  projectId,
  state,
  busy,
  error,
  onStateChange,
  onSubmit,
}: ImageGenerationDialogViewProps): JSX.Element {
  const submitDisabled = busy || !canSubmitSessionImageJob(state);

  return (
    <form
      className="space-y-3"
      aria-label="会话图片生成表单"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="grid grid-cols-2 gap-2" aria-label="生成模式">
        <button
          type="button"
          className={modeButtonClass(state.workflow === 'generate')}
          aria-pressed={state.workflow === 'generate'}
          onClick={() => onStateChange({ workflow: 'generate', sourceFiles: [] })}
        >
          <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
          文生图
        </button>
        <button
          type="button"
          className={modeButtonClass(state.workflow === 'image-to-image')}
          aria-pressed={state.workflow === 'image-to-image'}
          onClick={() => onStateChange({ workflow: 'image-to-image' })}
        >
          <ImageIcon className="h-3.5 w-3.5" aria-hidden="true" />
          图生图
        </button>
      </div>

      <label className="block space-y-1.5">
        <span className="block text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
          Prompt
        </span>
        <Textarea
          value={state.prompt}
          onChange={(event) => onStateChange({ prompt: event.currentTarget.value })}
          placeholder="描述要生成的画面"
        />
      </label>

      {state.workflow === 'image-to-image' && (
        <div className="space-y-1.5">
          <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
            Source Images
          </div>
          <SourceImagePicker
            projectId={projectId}
            selectedFiles={state.sourceFiles}
            onChange={(sourceFiles) => onStateChange({ sourceFiles })}
          />
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-[96px_minmax(0,1fr)]">
        <label className="block space-y-1.5">
          <span className="block text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
            Count
          </span>
          <Input
            type="number"
            min={1}
            max={4}
            value={state.count}
            onChange={(event) => onStateChange({ count: clampImageCount(Number(event.currentTarget.value)) })}
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block space-y-1.5">
            <span className="block text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
              Quality
            </span>
            <select
              className="h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[12px] text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)]"
              value={state.quality}
              onChange={(event) => onStateChange({ quality: event.currentTarget.value })}
            >
              {qualityOptions.map((quality) => <option key={quality} value={quality}>{quality}</option>)}
            </select>
          </label>
          <label className="block space-y-1.5">
            <span className="block text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
              Size
            </span>
            <select
              className="h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[12px] text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)]"
              value={state.size}
              onChange={(event) => onStateChange({ size: event.currentTarget.value })}
            >
              {sizeOptions.map((size) => <option key={size} value={size}>{size}</option>)}
            </select>
          </label>
        </div>
      </div>

      {error && <div className="text-[12px] text-[var(--color-danger)]">{error}</div>}

      <div className="flex items-center justify-end gap-2">
        <Button type="submit" disabled={submitDisabled}>
          <ImagePlus className="h-3.5 w-3.5" aria-hidden="true" />
          生成图片
        </Button>
      </div>
    </form>
  );
}

export function createSessionImageDialogState(): ImageJobFormState {
  return createEmptyImageJobFormState();
}

export function buildSessionImageJobPayload(state: ImageJobFormState, sessionId: string): ImageJobCreateInput {
  return {
    ...buildImageJobPayload(state),
    session_id: sessionId,
  };
}

function canSubmitSessionImageJob(state: ImageJobFormState): boolean {
  if (!state.prompt.trim()) return false;
  if (state.workflow === 'image-to-image' && state.sourceFiles.length === 0) return false;
  return true;
}

function clampImageCount(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(4, Math.max(1, Math.round(value)));
}

function modeButtonClass(active: boolean): string {
  return cn(
    'inline-flex h-8 items-center justify-center gap-1.5 border px-2 text-[12px] font-medium transition-colors ease-ocean',
    active
      ? 'border-[var(--color-accent)] bg-[var(--color-bg-soft)] text-[var(--color-fg)]'
      : 'border-[var(--color-border)] text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-soft)] hover:text-[var(--color-fg)]',
  );
}
