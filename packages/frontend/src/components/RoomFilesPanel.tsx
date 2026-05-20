import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Crosshair, Download, Eye, Filter, Grid2X2, List, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { formatFileSize } from '../lib/composerModel';
import { useI18n } from '../lib/i18n';
import { getProjectFileSourceSummary, projectFileMatchesFilters } from '../lib/projectFileDisplay';
import type { ProjectFile } from '../lib/types';
import { ProjectFileView, type ProjectFileViewMode } from './ProjectFileView';
import { ProjectFilePreviewDialog } from './ProjectFilePreviewDialog';
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
  const [selectedSourceType, setSelectedSourceType] = useState<ProjectFile['source_type'] | ''>('');
  const [preview, setPreview] = useState<ProjectFile | null>(null);
  const [viewMode, setViewMode] = useState<ProjectFileViewMode>('list');
  const viewModeLabel = locale === 'zh' ? '展示模式' : 'View mode';
  const listViewLabel = locale === 'zh' ? '列表模式' : 'List view';
  const cardViewLabel = locale === 'zh' ? 'Card 模式' : 'Card view';
  const {
    data: files = [],
    error: filesError,
    isError: filesIsError,
    isLoading,
    refetch: refetchFiles,
  } = useQuery<ProjectFile[]>({
    queryKey: ['files', projectId, roomId, selectedSourceType],
    queryFn: () => api.listFiles({
      projectId,
      roomId,
      sourceType: selectedSourceType || undefined,
    }),
    enabled: !!projectId && !!roomId,
  });

  const visibleFiles = useMemo(() => {
    return files.filter((file) => projectFileMatchesFilters(file, {
      keyword: query,
      sourceType: selectedSourceType,
    }, t));
  }, [files, query, selectedSourceType, t]);

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
          <div className="files-filters is-compact" aria-label={t('files.filters')}>
            <Filter className="h-4 w-4 text-[var(--color-muted)]" />
            <select
              className="files-filter-select"
              value={selectedSourceType}
              aria-label={t('files.sourceFilter')}
              onChange={(event) => setSelectedSourceType(event.target.value as ProjectFile['source_type'] | '')}
            >
              <option value="">{t('files.source.all')}</option>
              <option value="uploaded_file">{t('files.source.uploadedFile')}</option>
              <option value="agent_document">{t('files.source.agentDocument')}</option>
            </select>
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
          <FilesState title={t('files.loading')} />
        ) : filesIsError ? (
          <FilesState
            title={t('files.loadErrorTitle')}
            description={filesError instanceof Error ? filesError.message : t('common.error')}
            actionLabel={t('common.retry')}
            onAction={() => void refetchFiles()}
          />
        ) : visibleFiles.length === 0 ? (
          <FilesState
            title={files.length === 0 && !query.trim() ? t('files.empty') : t('files.noResults')}
            description={files.length === 0 && !query.trim() ? undefined : t('files.noResultsDescription')}
          />
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
                <span title={getProjectFileSourceSummary(file, t)}>
                  {getProjectFileSourceSummary(file, t)}
                </span>
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
                  label: file.source_type === 'agent_document'
                    ? t('files.viewMarkdown')
                    : file.source_type === 'uploaded_file'
                      ? t('files.preview')
                      : t('files.viewDetails'),
                  icon: <Eye className="h-4 w-4" strokeWidth={1.8} />,
                  onClick: () => setPreview(file),
                },
                ...(file.source_type === 'uploaded_file' && file.url
                  ? [{
                    key: 'download',
                    label: t('files.download'),
                    icon: <Download className="h-4 w-4" strokeWidth={1.8} />,
                    href: file.url,
                    download: file.original_name,
                  }]
                  : []),
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

      <ProjectFilePreviewDialog
        file={preview}
        projectId={projectId}
        onOpenChange={(open) => !open && setPreview(null)}
        onLocateMessage={onLocateMessage}
      />
    </div>
  );
}

function FilesState({
  title,
  description,
  actionLabel,
  onAction,
}: {
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
}): JSX.Element {
  return (
    <div className="files-empty">
      <span className="files-empty-title">{title}</span>
      {description ? <span className="files-empty-description">{description}</span> : null}
      {actionLabel && onAction ? (
        <button type="button" className="image-preview-link" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}
