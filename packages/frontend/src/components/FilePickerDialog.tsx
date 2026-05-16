import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, FileText, Search } from 'lucide-react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import type { ProjectFile } from '../lib/types';
import { cn } from '../lib/utils';
import { formatFileSize } from '../lib/composerModel';
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
  disabled,
  selectedFileIds,
  onSelect,
  children,
}: FilePickerDialogProps): JSX.Element {
  const { t, formatRelativeTime } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const selectedSet = useMemo(() => new Set(selectedFileIds), [selectedFileIds]);
  const { data: files = [], isLoading } = useQuery({
    queryKey: ['project-files', projectId],
    queryFn: () => api.listProjectFiles(projectId),
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
      <DialogTrigger asChild disabled={disabled}>
        {children}
      </DialogTrigger>
      <DialogContent
        className="file-picker-dialog"
        title={t('files.picker.title')}
        description={t('files.picker.description')}
      >
        <div className="file-picker-search">
          <Search className="h-4 w-4 text-[var(--color-muted)]" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('files.searchPlaceholder')}
            className="border-0 bg-transparent px-0 shadow-none focus:ring-0"
          />
        </div>

        <div className="file-picker-list" role="listbox" aria-label={t('files.picker.title')}>
          {isLoading ? (
            <div className="file-picker-empty">{t('files.loading')}</div>
          ) : visibleFiles.length === 0 ? (
            <div className="file-picker-empty">{t('files.empty')}</div>
          ) : (
            visibleFiles.map((file) => {
              const alreadySelected = selectedSet.has(file.id);
              const pending = pendingIds.includes(file.id);
              return (
                <button
                  type="button"
                  key={file.id}
                  className={cn('file-picker-row', pending && 'is-selected')}
                  disabled={alreadySelected}
                  onClick={() => {
                    setPendingIds((current) =>
                      current.includes(file.id)
                        ? current.filter((id) => id !== file.id)
                        : [...current, file.id],
                    );
                  }}
                >
                  <span className="file-picker-icon">
                    <FileText className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-[12px] font-medium text-[var(--color-fg)]">
                      {file.original_name}
                    </span>
                    <span className="block truncate font-mono text-[10.5px] text-[var(--color-fg-muted)]">
                      {formatFileSize(file.size)} · {file.mime_type} · {formatRelativeTime(file.created_at)}
                    </span>
                  </span>
                  {alreadySelected ? (
                    <span className="file-picker-state">{t('files.picker.added')}</span>
                  ) : pending ? (
                    <Check className="h-4 w-4 text-[var(--color-primary)]" />
                  ) : null}
                </button>
              );
            })
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
