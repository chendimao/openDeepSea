import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Grid2X2, List, Search } from 'lucide-react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import type { ProjectFile } from '../lib/types';
import { formatFileSize } from '../lib/composerModel';
import { ProjectFileView, type ProjectFileViewMode } from './ProjectFileView';
import { Button } from './ui/Button';
import { Dialog, DialogContent, DialogTrigger } from './ui/Dialog';
import { Input } from './ui/Input';

interface FilePickerDialogProps {
  projectId: string;
  disabled?: boolean;
  selectedFileIds: string[];
  onSelect: (files: ProjectFile[]) => void;
  children: ReactNode;
}

export function FilePickerDialog({
  projectId,
  selectedFileIds,
  onSelect,
  children,
}: FilePickerDialogProps): JSX.Element {
  const { t, locale, formatRelativeTime } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const [viewMode, setViewMode] = useState<ProjectFileViewMode>('list');
  const selectedSet = useMemo(() => new Set(selectedFileIds), [selectedFileIds]);
  const { data: files = [], isLoading } = useQuery({
    queryKey: ['project-files', projectId, 'uploaded_file'],
    queryFn: () => api.listProjectFiles(projectId, { sourceType: 'uploaded_file' }),
    enabled: open && !!projectId,
  });

  const visibleFiles = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return files;
    return files.filter((file) => {
      return (
        file.original_name.toLocaleLowerCase().includes(needle) ||
        file.mime_type.toLocaleLowerCase().includes(needle)
      );
    });
  }, [files, query]);

  const pendingFiles = files.filter((file) => pendingIds.includes(file.id));
  const viewModeLabel = locale === 'zh' ? '展示模式' : 'View mode';
  const listViewLabel = locale === 'zh' ? '列表模式' : 'List view';
  const cardViewLabel = locale === 'zh' ? 'Card 模式' : 'Card view';

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          setPendingIds([]);
          setQuery('');
        }
      }}
    >
      <DialogTrigger asChild>
        {children}
      </DialogTrigger>
      <DialogContent
        className="file-picker-dialog"
        title={t('files.picker.title')}
        description={t('files.picker.description')}
      >
        <div className="file-picker-toolbar">
          <div className="file-picker-search">
            <Search className="h-4 w-4 text-[var(--color-muted)]" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('files.searchPlaceholder')}
              className="border-0 bg-transparent px-0 shadow-none focus:ring-0"
            />
          </div>
          <div className="file-view-toggle" aria-label={viewModeLabel}>
            <button
              type="button"
              className={viewMode === 'list' ? 'is-active' : ''}
              aria-label={listViewLabel}
              aria-pressed={viewMode === 'list'}
              title={listViewLabel}
              onClick={() => setViewMode('list')}
            >
              <List className="h-4 w-4" strokeWidth={1.8} />
            </button>
            <button
              type="button"
              className={viewMode === 'card' ? 'is-active' : ''}
              aria-label={cardViewLabel}
              aria-pressed={viewMode === 'card'}
              title={cardViewLabel}
              onClick={() => setViewMode('card')}
            >
              <Grid2X2 className="h-4 w-4" strokeWidth={1.8} />
            </button>
          </div>
        </div>

        <div className="file-picker-list" aria-label={t('files.picker.title')}>
          {isLoading ? (
            <div className="file-picker-empty">{t('files.loading')}</div>
          ) : visibleFiles.length === 0 ? (
            <div className="file-picker-empty">{t('files.empty')}</div>
          ) : (
            <ProjectFileView
              files={visibleFiles}
              mode={viewMode}
              variant="picker"
              isSelected={(file) => pendingIds.includes(file.id)}
              isDisabled={(file) => selectedSet.has(file.id)}
              onToggle={(file) => {
                if (selectedSet.has(file.id)) return;
                setPendingIds((current) =>
                  current.includes(file.id)
                    ? current.filter((id) => id !== file.id)
                    : [...current, file.id],
                );
              }}
              getMeta={(file) => (
                <>
                  <span>{formatFileSize(file.size)}</span>
                  <span>{file.mime_type}</span>
                  <span>{formatRelativeTime(file.created_at)}</span>
                </>
              )}
              getState={(file) => {
                const alreadySelected = selectedSet.has(file.id);
                const pending = pendingIds.includes(file.id);
                if (alreadySelected) return <span className="file-picker-state">{t('files.picker.added')}</span>;
                if (pending) return <Check className="h-4 w-4 text-[var(--color-primary)]" />;
                return null;
              }}
            />
          )}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            disabled={pendingFiles.length === 0}
            onClick={() => {
              onSelect(pendingFiles);
              setOpen(false);
              setPendingIds([]);
              setQuery('');
            }}
          >
            {t('files.picker.addSelected', { count: pendingFiles.length })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
