import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download, Eye, Filter, Grid2X2, List, Search, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { formatFileSize } from '../lib/composerModel';
import { useI18n } from '../lib/i18n';
import { getProjectFileSourceSummary, projectFileMatchesKeyword } from '../lib/projectFileDisplay';
import type { ProjectFile } from '../lib/types';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { ProjectFileView, type ProjectFileViewMode } from '../components/ProjectFileView';
import { ProjectFilePreviewDialog } from '../components/ProjectFilePreviewDialog';

export function FilesPage(): JSX.Element {
  const { projectId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const roomIdFromUrl = searchParams.get('roomId') ?? '';
  const initialRoomId = projectId ? roomIdFromUrl : '';
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { t, locale, formatRelativeTime } = useI18n();
  const [query, setQuery] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState(projectId);
  const [selectedRoomId, setSelectedRoomId] = useState(initialRoomId);
  const [selectedSourceType, setSelectedSourceType] = useState<ProjectFile['source_type'] | ''>('');
  const [preview, setPreview] = useState<ProjectFile | null>(null);
  const [viewMode, setViewMode] = useState<ProjectFileViewMode>('list');

  useEffect(() => {
    setSelectedProjectId(projectId);
    setSelectedRoomId(initialRoomId);
  }, [initialRoomId, projectId]);

  const { data: projects = [] } = useQuery({
    queryKey: ['projects'],
    queryFn: api.listProjects,
  });
  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.getProject(projectId),
    enabled: !!projectId,
  });
  const { data: rooms = [], isFetched: roomsFetched } = useQuery({
    queryKey: ['rooms', selectedProjectId],
    queryFn: () => api.listRooms(selectedProjectId),
    enabled: !!selectedProjectId,
  });
  const activeRoomId = useMemo(() => {
    if (!selectedProjectId || !selectedRoomId) return '';
    return rooms.some((room) => room.id === selectedRoomId) ? selectedRoomId : '';
  }, [rooms, selectedProjectId, selectedRoomId]);
  const canLoadFiles = !selectedProjectId || !selectedRoomId || roomsFetched;
  const {
    data: files = [],
    error: filesError,
    isError: filesIsError,
    isLoading,
    refetch: refetchFiles,
  } = useQuery({
    queryKey: ['files', selectedProjectId, activeRoomId, selectedSourceType],
    queryFn: () => api.listFiles({
      projectId: selectedProjectId || undefined,
      roomId: activeRoomId || undefined,
      sourceType: selectedSourceType || undefined,
    }),
    enabled: canLoadFiles,
  });
  const selectedProject = useMemo(
    () => projects.find((item) => item.id === selectedProjectId) ?? project ?? null,
    [project, projects, selectedProjectId],
  );
  const selectedRoom = useMemo(
    () => rooms.find((item) => item.id === selectedRoomId) ?? null,
    [rooms, selectedRoomId],
  );
  const projectNameById = useMemo(
    () => new Map(projects.map((item) => [item.id, item.name])),
    [projects],
  );
  const viewModeLabel = locale === 'zh' ? '展示模式' : 'View mode';
  const listViewLabel = locale === 'zh' ? '列表模式' : 'List view';
  const cardViewLabel = locale === 'zh' ? 'Card 模式' : 'Card view';
  const visibleFiles = useMemo(() => {
    return files.filter((file) => projectFileMatchesKeyword(file, query, t, [
      projectNameById.get(file.project_id),
    ]));
  }, [files, projectNameById, query, t]);

  const totalSize = useMemo(
    () => files.reduce((sum, file) => sum + file.size, 0),
    [files],
  );

  useEffect(() => {
    if (!selectedProjectId || !selectedRoomId || !roomsFetched) return;
    if (!activeRoomId) setSelectedRoomId('');
  }, [activeRoomId, roomsFetched, selectedProjectId, selectedRoomId]);

  const upload = useMutation({
    mutationFn: (selectedFiles: File[]) => {
      if (!selectedProjectId) throw new Error(t('files.selectProjectForUpload'));
      return api.uploadProjectFiles(selectedProjectId, selectedFiles);
    },
    onSuccess: (uploaded) => {
      queryClient.invalidateQueries({ queryKey: ['files'] });
      queryClient.invalidateQueries({ queryKey: ['project-files', selectedProjectId] });
      toast.success(t('files.uploaded', { count: uploaded.length }));
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const remove = useMutation({
    mutationFn: (fileId: string) => api.deleteProjectFile(fileId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['files'] });
      queryClient.invalidateQueries({ queryKey: ['project-files'] });
      toast.success(t('files.deleted'));
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const handleDelete = (file: ProjectFile) => {
    if (!window.confirm(t('files.deleteConfirm', { name: file.original_name }))) return;
    remove.mutate(file.id);
  };

  return (
    <div className="files-page">
      <header className="workspace-toolbar">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to={projectId ? `/projects/${projectId}` : '/'}
            className="toolbar-back"
            aria-label={projectId ? t('room.backToProject') : t('shell.nav.development')}
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div className="min-w-0">
            <div className="font-display text-[15px] font-semibold leading-tight">{t('files.title')}</div>
            <div className="mt-1 hidden truncate font-mono text-[11px] text-[var(--color-fg-muted)] sm:block">
              {selectedProject
                ? `${selectedProject.name} · ${selectedProject.path}`
                : t('files.allProjects')}
              {selectedRoom ? ` · ${selectedRoom.name}` : ''}
            </div>
          </div>
        </div>

        <div className="files-summary" aria-label={t('files.summary')}>
          <span>{t('files.count', { count: files.length })}</span>
          <span>{t('files.totalSize', { size: formatFileSize(totalSize) })}</span>
        </div>
      </header>

      <main className="files-main">
        <section className="files-toolbar">
          <div>
            <h1>{t('files.title')}</h1>
            <p>{t('files.subtitle')}</p>
          </div>
          <div className="files-toolbar-actions">
            <div className="files-filters" aria-label={t('files.filters')}>
              <Filter className="h-4 w-4 text-[var(--color-muted)]" />
              <select
                className="files-filter-select"
                value={selectedProjectId}
                aria-label={t('files.projectFilter')}
                onChange={(event) => {
                  setSelectedProjectId(event.target.value);
                  setSelectedRoomId('');
                }}
              >
                <option value="">{t('files.allProjects')}</option>
                {projects.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <select
                className="files-filter-select"
                value={selectedRoomId}
                aria-label={t('files.roomFilter')}
                disabled={!selectedProjectId}
                onChange={(event) => setSelectedRoomId(event.target.value)}
              >
                <option value="">{t('files.allRooms')}</option>
                {rooms.map((room) => (
                  <option key={room.id} value={room.id}>
                    {room.name}
                  </option>
                ))}
              </select>
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
            <input
              ref={fileInputRef}
              type="file"
              className="sr-only"
              multiple
              disabled={upload.isPending}
              onChange={(event) => {
                const selectedFiles = event.currentTarget.files ? Array.from(event.currentTarget.files) : [];
                if (selectedFiles.length > 0) upload.mutate(selectedFiles);
                event.currentTarget.value = '';
              }}
            />
            <Button
              type="button"
              className="gap-2"
              disabled={upload.isPending || !selectedProjectId}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="h-4 w-4" strokeWidth={1.75} />
              {upload.isPending ? t('files.uploading') : t('files.upload')}
            </Button>
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
                  <span>{projectNameById.get(file.project_id) ?? file.project_id}</span>
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
              getActions={(file) => [
                {
                  key: 'preview',
                  label: file.source_type === 'agent_document' ? t('files.viewMarkdown') : t('files.preview'),
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
                {
                  key: 'delete',
                  label: t('files.delete'),
                  icon: <Trash2 className="h-4 w-4" strokeWidth={1.8} />,
                  danger: true,
                  disabled: remove.isPending,
                  onClick: () => handleDelete(file),
                },
              ]}
            />
          )}
        </section>
      </main>

      <ProjectFilePreviewDialog
        file={preview}
        projectId={preview?.project_id}
        onOpenChange={(open) => !open && setPreview(null)}
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
