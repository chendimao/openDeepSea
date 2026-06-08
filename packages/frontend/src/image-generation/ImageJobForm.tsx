import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Image as ImageIcon, Send, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../components/ui/Button';
import { Input, Textarea } from '../components/ui/Input';
import { api } from '../lib/api';
import { cn } from '../lib/utils';
import type { ImageGenerationWorkflow, ImageJobCreateInput, ProjectFile } from '../lib/types';
import { PromptBankPanel } from './PromptBankPanel';
import { SourceImagePicker } from './SourceImagePicker';

export type ImageJobFormState = {
  workflow: ImageGenerationWorkflow;
  prompt: string;
  sourceFiles: ProjectFile[];
  count: number;
  quality: string;
  size: string;
};

type ImageJobFormViewProps = {
  projectId: string;
  state: ImageJobFormState;
  busy: boolean;
  error: string | null;
  onStateChange: (patch: Partial<ImageJobFormState>) => void;
  onSubmit: () => void;
};

const qualityOptions = ['auto', 'low', 'medium', 'high'];
const sizeOptions = ['auto', '1024x1024', '1024x1536', '1536x1024'];
export const IMAGE_GENERATION_MAX_COUNT = 6;

export function ImageJobForm({ projectId }: { projectId: string }): JSX.Element {
  const queryClient = useQueryClient();
  const [state, setState] = useState<ImageJobFormState>(() => createEmptyImageJobFormState());
  const [error, setError] = useState<string | null>(null);
  const createJob = useMutation({
    mutationFn: () => api.createImageJob(projectId, buildImageJobPayload(state)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['image-jobs', projectId] });
      await queryClient.invalidateQueries({ queryKey: ['image-job-groups', projectId] });
      setState((current) => ({ ...current, prompt: '', sourceFiles: current.workflow === 'generate' ? [] : current.sourceFiles }));
      setError(null);
      toast.success('图片任务已创建');
    },
    onError: (err) => setError((err as Error).message),
  });

  return (
    <ImageJobFormView
      projectId={projectId}
      state={state}
      busy={createJob.isPending}
      error={error}
      onStateChange={(patch) => {
        setState((current) => ({ ...current, ...patch }));
        setError(null);
      }}
      onSubmit={() => {
        if (!canSubmitImageJob(state)) {
          setError(state.workflow === 'image-to-image' && state.sourceFiles.length === 0
            ? '图生图需要至少选择一张源图'
            : '请填写提示词');
          return;
        }
        createJob.mutate();
      }}
    />
  );
}

export function ImageJobFormView({
  projectId,
  state,
  busy,
  error,
  onStateChange,
  onSubmit,
}: ImageJobFormViewProps): JSX.Element {
  const submitDisabled = busy || !canSubmitImageJob(state);

  return (
    <form
      className="space-y-3 border-t border-[var(--color-border)] pt-4"
      aria-label="图片生成表单"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-[12px] font-semibold">
            <Sparkles className="h-4 w-4 text-[var(--color-accent)]" aria-hidden="true" />
            <span>Prompt</span>
          </h3>
          <p className="mt-1 text-[11px] leading-snug text-[var(--color-fg-muted)]">
            文生图或基于源图生成变体
          </p>
        </div>
      </div>

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
        <span className="block text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
          Prompt
        </span>
        <Textarea
          value={state.prompt}
          onChange={(event) => onStateChange({ prompt: event.currentTarget.value })}
          placeholder="描述你想生成的画面"
        />
      </label>

      <PromptBankPanel
        projectId={projectId}
        currentPrompt={state.prompt}
        onInsertPrompt={(prompt) => onStateChange({ prompt })}
      />

      {state.workflow === 'image-to-image' && (
        <div className="space-y-1.5">
          <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
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
          <span className="block text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
            Count
          </span>
          <Input
            type="number"
            min={1}
            max={IMAGE_GENERATION_MAX_COUNT}
            value={state.count}
            onChange={(event) => onStateChange({ count: clampImageCount(Number(event.currentTarget.value)) })}
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block space-y-1.5">
            <span className="block text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
              Quality
            </span>
            <select
              className="h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[12px] text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)] focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--color-surface)]"
              value={state.quality}
              onChange={(event) => onStateChange({ quality: event.currentTarget.value })}
            >
              {qualityOptions.map((quality) => (
                <option key={quality} value={quality}>{quality}</option>
              ))}
            </select>
          </label>
          <label className="block space-y-1.5">
            <span className="block text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
              Size
            </span>
            <select
              className="h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[12px] text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)] focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--color-surface)]"
              value={state.size}
              onChange={(event) => onStateChange({ size: event.currentTarget.value })}
            >
              {sizeOptions.map((size) => (
                <option key={size} value={size}>{size}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {error && <div className="text-[12px] text-[var(--color-danger)]">{error}</div>}

      <Button type="submit" className="w-full" disabled={submitDisabled}>
        <Send className="h-3.5 w-3.5" aria-hidden="true" />
        生成图片
      </Button>
    </form>
  );
}

export function createEmptyImageJobFormState(): ImageJobFormState {
  return {
    workflow: 'generate',
    prompt: '',
    sourceFiles: [],
    count: 1,
    quality: 'auto',
    size: 'auto',
  };
}

export function buildImageJobPayload(state: ImageJobFormState): ImageJobCreateInput {
  const payload: ImageJobCreateInput = {
    workflow: state.workflow,
    prompt: state.prompt.trim(),
    count: state.count,
    quality: state.quality,
    size: state.size,
  };
  if (state.workflow === 'image-to-image') {
    payload.source_file_ids = state.sourceFiles.map((file) => normalizeSourceFileId(file.id));
  }
  return payload;
}

function normalizeSourceFileId(fileId: string): string {
  return fileId.startsWith('file:') ? fileId.slice('file:'.length) : fileId;
}

function canSubmitImageJob(state: ImageJobFormState): boolean {
  if (!state.prompt.trim()) return false;
  if (state.workflow === 'image-to-image' && state.sourceFiles.length === 0) return false;
  return true;
}

function clampImageCount(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(IMAGE_GENERATION_MAX_COUNT, Math.max(1, Math.round(value)));
}

function modeButtonClass(active: boolean): string {
  return cn(
    'inline-flex h-8 items-center justify-center gap-1.5 border px-2 text-[12px] font-medium transition-colors ease-ocean focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--color-surface)]',
    active
      ? 'border-[var(--color-accent)] bg-[var(--color-bg-soft)] text-[var(--color-fg)]'
      : 'border-[var(--color-border)] text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-soft)] hover:text-[var(--color-fg)]',
  );
}
