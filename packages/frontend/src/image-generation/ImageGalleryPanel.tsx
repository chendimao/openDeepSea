import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Download, Image as ImageIcon, Tags, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../components/ui/Button';
import { api } from '../lib/api';
import type { ImageGenerationOutput, ImageJobDetailResponse, ImageJobGroup, ProjectFile } from '../lib/types';
import { ImageLineagePanel } from './ImageLineagePanel';

export type GalleryItem = {
  id: string;
  title: string;
  url: string;
  href: string;
  label: string;
  width?: number | null;
  height?: number | null;
  outputId: string | null;
};

export function ImageGalleryPanel({ projectId }: { projectId: string }): JSX.Element {
  const queryClient = useQueryClient();
  const [selectedOutputIds, setSelectedOutputIds] = useState<string[]>([]);
  const { data: jobsResponse } = useQuery({
    queryKey: ['image-jobs', projectId],
    queryFn: () => api.listImageJobs(projectId),
  });
  const completedJobIds = useMemo(
    () => (jobsResponse?.jobs ?? []).filter((job) => job.status === 'completed').map((job) => job.id),
    [jobsResponse?.jobs],
  );
  const { data: details = [] } = useQuery({
    queryKey: ['image-job-details', projectId, completedJobIds],
    queryFn: () => Promise.all(completedJobIds.map((jobId) => api.getImageJob(projectId, jobId))),
    enabled: completedJobIds.length > 0,
  });
  const { data: resources = [] } = useQuery({
    queryKey: ['image-gallery-resources', projectId],
    queryFn: () => api.listResourceFiles(projectId, { sourceType: 'uploaded_file' }),
  });
  const { data: promptGroups = [] } = useQuery({
    queryKey: ['image-job-groups', projectId, 'prompt'],
    queryFn: () => api.listImageJobGroups(projectId, 'prompt'),
  });
  const items = buildGalleryItems(projectId, details, resources);
  const selectedOutputIdSet = useMemo(() => new Set(selectedOutputIds), [selectedOutputIds]);
  const deleteOutputs = useMutation({
    mutationFn: () => api.deleteImageOutputs(projectId, selectedOutputIds),
    onSuccess: async () => {
      setSelectedOutputIds([]);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['image-job-details', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['image-gallery-resources', projectId] }),
      ]);
      toast.success('已删除所选图片');
    },
    onError: (error) => toast.error((error as Error).message),
  });
  const downloadManifest = useMutation({
    mutationFn: () => api.downloadImageOutputManifest(projectId, selectedOutputIds),
    onSuccess: (manifest) => {
      downloadJsonManifest(`opendeepsea-images-${projectId}.json`, manifest);
      toast.success('下载清单已生成');
    },
    onError: (error) => toast.error((error as Error).message),
  });

  if (items.length === 0) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4" aria-label="项目图库占位">
        {Array.from({ length: 8 }, (_, index) => (
          <div
            key={index}
            className="aspect-square border border-dashed border-[var(--color-border)] bg-[var(--color-bg-soft)]"
            aria-hidden="true"
          />
        ))}
      </div>
    );
  }

  return (
    <div>
      <ImagePromptGroupStrip groups={promptGroups} />
      <ImageLineagePanel details={details} />
      <ImageBatchToolbar
        selectedCount={selectedOutputIds.length}
        busy={deleteOutputs.isPending || downloadManifest.isPending}
        onDelete={() => {
          if (!window.confirm(`删除所选 ${selectedOutputIds.length} 张图片？此操作会从项目文件库移除这些图片。`)) return;
          deleteOutputs.mutate();
        }}
        onDownload={() => downloadManifest.mutate()}
        onClear={() => setSelectedOutputIds([])}
      />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
        {items.map((item) => (
          <GalleryTile
            key={item.id}
            item={item}
            selected={Boolean(item.outputId && selectedOutputIdSet.has(item.outputId))}
            onToggle={() => {
              if (!item.outputId) return;
              setSelectedOutputIds((current) =>
                current.includes(item.outputId!)
                  ? current.filter((outputId) => outputId !== item.outputId)
                  : [...current, item.outputId!],
              );
            }}
          />
        ))}
      </div>
    </div>
  );
}

function ImageBatchToolbar(input: {
  selectedCount: number;
  busy: boolean;
  onDelete: () => void;
  onDownload: () => void;
  onClear: () => void;
}): JSX.Element | null {
  if (input.selectedCount === 0) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 border border-[var(--color-border)] bg-[var(--color-bg-soft)] p-2" aria-label="图片批量操作">
      <span className="mr-auto text-[11px] text-[var(--color-fg-muted)]">已选择 {input.selectedCount} 张</span>
      <Button type="button" size="sm" variant="secondary" disabled={input.busy} onClick={input.onDownload}>
        <Download className="h-3.5 w-3.5" aria-hidden="true" />
        下载清单
      </Button>
      <Button type="button" size="sm" variant="danger" disabled={input.busy} onClick={input.onDelete}>
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
        删除所选
      </Button>
      <Button type="button" size="sm" variant="ghost" disabled={input.busy} onClick={input.onClear}>
        <X className="h-3.5 w-3.5" aria-hidden="true" />
        清空
      </Button>
    </div>
  );
}

function GalleryTile(input: {
  item: GalleryItem;
  selected: boolean;
  onToggle: () => void;
}): JSX.Element {
  const { item, selected, onToggle } = input;
  return (
    <article className="group relative">
      {item.outputId && (
        <button
          type="button"
          className="absolute left-2 top-2 z-10 flex h-7 w-7 items-center justify-center border border-[var(--color-border)] bg-[var(--color-panel)] text-[var(--color-fg-muted)] shadow-sm transition-colors hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--color-panel)]"
          aria-label={selected ? `取消选择 ${item.title}` : `选择 ${item.title}`}
          aria-pressed={selected}
          onClick={onToggle}
        >
          {selected ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : null}
        </button>
      )}
      <a href={item.href} className="block">
        <span className="block aspect-square overflow-hidden border border-[var(--color-border)] bg-[var(--color-bg-soft)]">
          {item.url ? (
            <img
              src={item.url}
              alt={item.title}
              width={item.width ?? undefined}
              height={item.height ?? undefined}
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
            />
          ) : (
            <span className="flex h-full items-center justify-center text-[var(--color-fg-subtle)]">
              <ImageIcon className="h-6 w-6" aria-hidden="true" />
            </span>
          )}
        </span>
        <span className="mt-1 block truncate text-[11px] text-[var(--color-fg-muted)]">{item.label}</span>
      </a>
    </article>
  );
}

function ImagePromptGroupStrip({ groups }: { groups: ImageJobGroup[] }): JSX.Element | null {
  if (groups.length === 0) return null;
  return (
    <section aria-label="提示词分组" className="mb-4 border-b border-[var(--color-border)] pb-4">
      <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold">
        <Tags className="h-3.5 w-3.5 text-[var(--color-accent)]" aria-hidden="true" />
        <span>提示词分组</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {groups.slice(0, 8).map((group) => (
          <span
            key={group.key}
            className="inline-flex max-w-full items-center gap-2 border border-[var(--color-border)] bg-[var(--color-bg-soft)] px-2 py-1 text-[11px]"
          >
            <span className="max-w-[180px] truncate">{group.label}</span>
            <span className="font-mono text-[10px] text-[var(--color-fg-subtle)]">{group.count}</span>
          </span>
        ))}
      </div>
    </section>
  );
}

export function buildGalleryItems(
  projectId: string,
  details: ImageJobDetailResponse[],
  resources: ProjectFile[],
): GalleryItem[] {
  const outputItems = details.flatMap((detail) => detail.outputs.map((output) => outputToGalleryItem(projectId, output)));
  const outputFileIds = new Set(
    details.flatMap((detail) => detail.outputs.map((output) => normalizeFileId(output.file_id))),
  );
  const resourceItems = resources
    .filter((file) => file.mime_type.toLowerCase().startsWith('image/'))
    .filter((file) => !outputFileIds.has(normalizeFileId(file.id)))
    .map((file) => resourceToGalleryItem(projectId, file));
  return [...outputItems, ...resourceItems];
}

function normalizeFileId(fileId: string): string {
  return fileId.startsWith('file:') ? fileId.slice('file:'.length) : fileId;
}

function outputToGalleryItem(projectId: string, output: ImageGenerationOutput): GalleryItem {
  return {
    id: `output:${output.id}`,
    title: output.name,
    url: output.url,
    href: `/projects/${projectId}/files`,
    label: output.name,
    width: output.width,
    height: output.height,
    outputId: output.id,
  };
}

function resourceToGalleryItem(projectId: string, file: ProjectFile): GalleryItem {
  return {
    id: `file:${file.id}`,
    title: file.original_name,
    url: file.url,
    href: `/projects/${projectId}/files`,
    label: file.original_name,
    width: null,
    height: null,
    outputId: null,
  };
}

function downloadJsonManifest(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
