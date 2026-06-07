import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CornerDownLeft, Library, Plus, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { api } from '../lib/api';
import {
  buildPromptPresetPayload,
  createPromptPresetDraft,
  type PromptPresetDraft,
} from './imageGenerationModel';

interface PromptBankPanelProps {
  projectId: string;
  currentPrompt: string;
  onInsertPrompt: (prompt: string) => void;
}

export function PromptBankPanel({ projectId, currentPrompt, onInsertPrompt }: PromptBankPanelProps): JSX.Element {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<PromptPresetDraft>(() => createPromptPresetDraft(currentPrompt));
  const queryKey = useMemo(() => ['image-prompt-presets', projectId, query] as const, [projectId, query]);
  const { data: presets = [] } = useQuery({
    queryKey,
    queryFn: () => api.listImagePromptPresets(projectId, { q: query.trim() || undefined }),
  });
  const refreshPresets = async () => {
    await queryClient.invalidateQueries({ queryKey: ['image-prompt-presets', projectId] });
  };
  const createPreset = useMutation({
    mutationFn: () => api.createImagePromptPreset(projectId, buildPromptPresetPayload({
      title: draft.title,
      prompt: draft.prompt.trim() || currentPrompt,
    })),
    onSuccess: async () => {
      await refreshPresets();
      setDraft(createPromptPresetDraft(currentPrompt));
      toast.success('提示词已保存');
    },
    onError: (error) => toast.error((error as Error).message),
  });
  const deletePreset = useMutation({
    mutationFn: (presetId: string) => api.deleteImagePromptPreset(projectId, presetId),
    onSuccess: async () => {
      await refreshPresets();
      toast.success('提示词已删除');
    },
    onError: (error) => toast.error((error as Error).message),
  });
  const canSave = Boolean((draft.prompt.trim() || currentPrompt.trim()) && !createPreset.isPending);

  return (
    <div className="space-y-2 border border-[var(--color-border)] bg-[var(--color-bg-soft)] p-2" aria-label="提示词库">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-[12px] font-semibold">
          <Library className="h-3.5 w-3.5 text-[var(--color-accent)]" aria-hidden="true" />
          <span>提示词库</span>
        </div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={!canSave}
          onClick={() => createPreset.mutate()}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          保存
        </Button>
      </div>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Input
          value={draft.title}
          onChange={(event) => setDraft((current) => ({ ...current, title: event.currentTarget.value }))}
          placeholder="标题"
          aria-label="提示词标题"
        />
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-fg-subtle)]" aria-hidden="true" />
          <Input
            className="pl-7"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="搜索"
            aria-label="搜索提示词"
          />
        </div>
      </div>
      <textarea
        className="min-h-[64px] w-full resize-y border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-2 text-[12px] leading-relaxed text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)]"
        value={draft.prompt || currentPrompt}
        onChange={(event) => setDraft((current) => ({ ...current, prompt: event.currentTarget.value }))}
        placeholder="保存当前 prompt，或编辑后保存为模板"
        aria-label="提示词内容"
      />
      <div className="max-h-44 space-y-1 overflow-y-auto" aria-label="提示词预设列表">
        {presets.length === 0 ? (
          <div className="border border-dashed border-[var(--color-border)] px-2 py-3 text-center text-[11px] text-[var(--color-fg-muted)]">
            暂无匹配提示词
          </div>
        ) : presets.map((preset) => (
          <div key={preset.id} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 border border-[var(--color-border)] bg-[var(--color-panel)] p-2">
            <div className="min-w-0">
              <div className="truncate text-[11px] font-semibold text-[var(--color-fg)]">{preset.title}</div>
              <div className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-[var(--color-fg-muted)]">
                {preset.prompt}
              </div>
            </div>
            <Button type="button" size="sm" variant="secondary" onClick={() => onInsertPrompt(preset.prompt)}>
              <CornerDownLeft className="h-3.5 w-3.5" aria-hidden="true" />
              插入
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={deletePreset.isPending}
              aria-label={`删除提示词 ${preset.title}`}
              onClick={() => deletePreset.mutate(preset.id)}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
