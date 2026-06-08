import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Image as ImageIcon, Plus, X } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { api } from '../lib/api';
import type { ProjectFile } from '../lib/types';

export function SourceImagePicker({
  projectId,
  selectedFiles,
  onChange,
}: {
  projectId: string;
  selectedFiles: ProjectFile[];
  onChange: (files: ProjectFile[]) => void;
}): JSX.Element {
  const selectedIds = useMemo(() => new Set(selectedFiles.map((file) => file.id)), [selectedFiles]);
  const { data: files = [], isLoading } = useQuery({
    queryKey: ['image-generation-source-files', projectId],
    queryFn: () => api.listProjectFiles(projectId, { sourceType: 'uploaded_file' }),
  });
  const imageFiles = filterImageSourceFiles(files);
  const availableFiles = imageFiles.filter((file) => !selectedIds.has(file.id));
  const emptyMessage = imageFiles.length === 0 ? '项目里还没有可用图片' : '所有可用图片已选择';

  return (
    <div className="space-y-2">
      {selectedFiles.length > 0 && (
        <div className="grid grid-cols-2 gap-2" aria-label="已选源图">
          {selectedFiles.map((file) => (
            <div key={file.id} className="group relative aspect-square overflow-hidden border border-[var(--color-border)] bg-[var(--color-bg-soft)]">
              {file.url ? (
                <img src={file.url} alt={file.original_name} className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full items-center justify-center text-[var(--color-fg-subtle)]">
                  <ImageIcon className="h-5 w-5" aria-hidden="true" />
                </div>
              )}
              <button
                type="button"
                className="absolute right-1 top-1 inline-flex h-6 w-6 items-center justify-center rounded bg-[var(--color-panel)] text-[var(--color-fg-muted)] shadow-sm hover:text-[var(--color-fg)]"
                aria-label={`移除源图 ${file.original_name}`}
                onClick={() => onChange(selectedFiles.filter((item) => item.id !== file.id))}
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-1.5" aria-label="可选源图">
        {isLoading ? (
          <div className="border border-dashed border-[var(--color-border)] px-3 py-3 text-[12px] text-[var(--color-fg-muted)]">
            正在加载源图
          </div>
        ) : availableFiles.length === 0 ? (
          <div className="border border-dashed border-[var(--color-border)] px-3 py-3 text-[12px] text-[var(--color-fg-muted)]">
            {emptyMessage}
          </div>
        ) : (
          availableFiles.map((file) => (
            <button
              key={file.id}
              type="button"
              className="flex w-full items-center gap-2 border border-[var(--color-border)] bg-[var(--color-bg-soft)] px-2 py-2 text-left text-[12px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
              onClick={() => onChange([...selectedFiles, file])}
            >
              <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center overflow-hidden border border-[var(--color-border)] bg-[var(--color-panel)]">
                {file.url ? (
                  <img src={file.url} alt="" className="h-full w-full object-cover" />
                ) : (
                  <ImageIcon className="h-4 w-4" aria-hidden="true" />
                )}
              </span>
              <span className="min-w-0 flex-1 truncate">{file.original_name}</span>
              <Plus className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
            </button>
          ))
        )}
      </div>
    </div>
  );
}

export function filterImageSourceFiles(files: ProjectFile[]): ProjectFile[] {
  return files.filter((file) => file.mime_type.toLowerCase().startsWith('image/'));
}
