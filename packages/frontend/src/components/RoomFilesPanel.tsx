import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Crosshair, Download, Eye, Grid2X2, List, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { formatFileSize } from '../lib/composerModel';
import { useI18n } from '../lib/i18n';
import type { ProjectFile } from '../lib/types';
import { ProjectFileView, type ProjectFileViewMode } from './ProjectFileView';
import { Dialog, DialogContent } from './ui/Dialog';
import { Input } from './ui/Input';

interface RoomFilesPanelProps {
  projectId: string;
  roomId: string;
  onLocateMessage: (messageId: string) => void;
}

export function RoomFilesPanel({ projectId, roomId, onLocateMessage }: RoomFilesPanelProps): JSX.Element {
  const queryClient = useQueryClient();
  const { t, locale, formatRelativeTime } = useI18n();
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState<ProjectFile | null>(null);
  const [viewMode, setViewMode] = useState<ProjectFileViewMode>('list');
  const viewModeLabel = locale === 'zh' ? '展示模式' : 'View mode';
  const listViewLabel = locale === 'zh' ? '列表模式' : 'List view';
  const cardViewLabel = locale === 'zh' ? 'Card 模式' : 'Card view';

  const { data: files = [], isLoading } = useQuery<ProjectFile[]>({
    queryKey: ['files', projectId, roomId],
    queryFn: () => api.listFiles({ projectId, roomId }),
    enabled: !!projectId && !!roomId,
  });

  const visibleFiles = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return files;
    return files.filter((file) =>
      file.original_name.toLocaleLowerCase().includes(needle) ||
      file.mime_type.toLocaleLowerCase().includes(needle) ||
      (file.last_referenced_room_name ?? '').toLocaleLowerCase().includes(needle),
    );
  }, [files, query]);

  const totalSize = useMemo(
    () => files.reduce((sum, file) => sum + file.size, 0),
    [files],
  );

  const remove = useMutation({
    mutationFn: (fileId: string) => api.deleteProjectFile(fileId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['files'] });
      queryClient.invalidateQueries({ queryKey: ['files', projectId, roomId] });
      queryClient.invalidateQueries({ queryKey: ['project-files', projectId] });
      queryClient.invalidateQueries({ queryKey: ['messages', roomId] });
      toast.success(t('files.deleted'));
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const handleDelete = (file: ProjectFile) => {
    if (!window.confirm(t('files.deleteConfirm', { name: file.original_name }))) return;
    remove.mutate(file.id);
  };

  return (
    <div className="room-files-panel">
      <section className="files-toolbar">
        <div>
          <h1>{t('room.filesTitle')}</h1>
          <p>{t('room.filesSubtitle')}</p>
        </div>
        <div className="files-toolbar-actions">
          <div className="files-summary" aria-label={t('files.summary')}>
            <span>{t('files.count', { count: files.length })}</span>
            <span>{t('files.totalSize', { size: formatFileSize(totalSize) })}</span>
          </div>
          <div className="files-search">
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
      </section>

      <section className="files-list" aria-label={t('files.title')}>
        {isLoading ? (
          <div className="files-empty">{t('files.loading')}</div>
        ) : visibleFiles.length === 0 ? (
          <div className="files-empty">{t('files.empty')}</div>
        ) : (
          <ProjectFileView
            files={visibleFiles}
            mode={viewMode}
            variant="library"
            getMeta={(file) => (
              <>
                <span>{formatFileSize(file.size)}</span>
                <span>{file.mime_type}</span>
                <span>{formatRelativeTime(file.created_at)}</span>
              </>
            )}
            getSecondaryMeta={(file) => (
              <>
                <span>{t('files.referenceCount', { count: file.reference_count })}</span>
                <span title={file.last_referenced_room_name ?? undefined}>
                  {file.last_referenced_room_name ?? t('files.neverReferenced')}
                </span>
              </>
            )}
            getActions={(file) => {
              const messageId = file.last_referenced_message_id;
              return [
                {
                  key: 'preview',
                  label: t('files.preview'),
                  icon: <Eye className="h-4 w-4" strokeWidth={1.8} />,
                  onClick: () => setPreview(file),
                },
                {
                  key: 'download',
                  label: t('files.download'),
                  icon: <Download className="h-4 w-4" strokeWidth={1.8} />,
                  href: file.url,
                  download: file.original_name,
                },
                ...(messageId
                  ? [{
                    key: 'locate-message',
                    label: t('files.locateMessage'),
                    icon: <Crosshair className="h-4 w-4" strokeWidth={1.8} />,
                    onClick: () => onLocateMessage(messageId),
                  }]
                  : []),
                {
                  key: 'delete',
                  label: t('files.delete'),
                  icon: <Trash2 className="h-4 w-4" strokeWidth={1.8} />,
                  danger: true,
                  disabled: remove.isPending,
                  onClick: () => handleDelete(file),
                },
              ];
            }}
          />
        )}
      </section>

      <Dialog open={!!preview} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="file-preview-dialog" title={preview?.original_name}>
          {preview && (
            <div className="file-preview-shell">
              {preview.mime_type.startsWith('image/') ? (
                <div className="file-preview-stage">
                  <img src={preview.url} alt={preview.original_name} />
                </div>
              ) : preview.mime_type === 'application/pdf' ? (
                <iframe className="file-preview-frame" src={preview.url} title={preview.original_name} />
              ) : preview.mime_type.startsWith('text/') ? (
                <iframe className="file-preview-frame" src={preview.url} title={preview.original_name} />
              ) : (
                <div className="files-empty">{t('files.previewUnavailable')}</div>
              )}
              <div className="file-preview-footer">
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--color-fg-muted)]">
                  {formatFileSize(preview.size)} · {preview.mime_type}
                </span>
                <a href={preview.url} target="_blank" rel="noreferrer" className="image-preview-link">
                  {t('files.openOriginal')}
                </a>
                <a href={preview.url} download={preview.original_name} className="image-preview-link">
                  {t('files.download')}
                </a>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
