import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Image as ImageIcon } from 'lucide-react';
import { api } from '../lib/api';
import type { ImageGenerationOutput, ImageJobDetailResponse, ProjectFile } from '../lib/types';
import { ImageLineagePanel } from './ImageLineagePanel';

export type GalleryItem = {
  id: string;
  title: string;
  url: string;
  href: string;
  label: string;
};

export function ImageGalleryPanel({ projectId }: { projectId: string }): JSX.Element {
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
  const items = buildGalleryItems(projectId, details, resources);

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
      <ImageLineagePanel details={details} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
        {items.map((item) => (
          <a key={item.id} href={item.href} className="group block">
            <span className="block aspect-square overflow-hidden border border-[var(--color-border)] bg-[var(--color-bg-soft)]">
              {item.url ? (
                <img src={item.url} alt={item.title} className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]" />
              ) : (
                <span className="flex h-full items-center justify-center text-[var(--color-fg-subtle)]">
                  <ImageIcon className="h-6 w-6" aria-hidden="true" />
                </span>
              )}
            </span>
            <span className="mt-1 block truncate text-[11px] text-[var(--color-fg-muted)]">{item.label}</span>
          </a>
        ))}
      </div>
    </div>
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
  };
}

function resourceToGalleryItem(projectId: string, file: ProjectFile): GalleryItem {
  return {
    id: `file:${file.id}`,
    title: file.original_name,
    url: file.url,
    href: `/projects/${projectId}/files`,
    label: file.original_name,
  };
}
