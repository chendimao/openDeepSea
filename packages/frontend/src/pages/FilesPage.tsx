import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download, Eye, FileText, Filter, Image, Search, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { formatFileSize } from '../lib/composerModel';
import { useI18n } from '../lib/i18n';
import type { ProjectFile } from '../lib/types';
import { Button } from '../components/ui/Button';
import { Dialog, DialogContent } from '../components/ui/Dialog';
import { Input } from '../components/ui/Input';

export function FilesPage(): JSX.Element {
  const { projectId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const initialRoomId = searchParams.get('roomId') ?? '';
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { t, formatRelativeTime } = useI18n();
  const [query, setQuery] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState(projectId);
  const [selectedRoomId, setSelectedRoomId] = useState(initialRoomId);
  const [preview, setPreview] = useState<ProjectFile | null>(null);

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
  const { data: rooms = [] } = useQuery({
    queryKey: ['rooms', selectedProjectId],
    queryFn: () => api.listRooms(selectedProjectId),
    enabled: !!selectedProjectId,
  });
  const { data: files = [], isLoading } = useQuery({
    queryKey: ['files', selectedProjectId, selectedRoomId],
    queryFn: () => api.listFiles({
      projectId: selectedProjectId || undefined,
      roomId: selectedRoomId || undefined,
    }),
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

  const visibleFiles = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return files;
    return files.filter((file) =>
      file.original_name.toLocaleLowerCase().includes(needle) ||
      file.mime_type.toLocaleLowerCase().includes(needle) ||
      (projectNameById.get(file.project_id) ?? '').toLocaleLowerCase().includes(needle) ||
      (file.last_referenced_room_name ?? '').toLocaleLowerCase().includes(needle),
    );
  }, [files, projectNameById, query]);

  const totalSize = useMemo(
    () => files.reduce((sum, file) => sum + file.size, 0),
    [files],
  );

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
            <div className="files-empty">{t('files.loading')}</div>
          ) : visibleFiles.length === 0 ? (
            <div className="files-empty">{t('files.empty')}</div>
          ) : (
            visibleFiles.map((file) => (
              <article className="file-row" key={file.id}>
                <div className="file-row-icon">
                  {file.mime_type.startsWith('image/') ? (
                    <Image className="h-5 w-5" strokeWidth={1.7} />
                  ) : (
                    <FileText className="h-5 w-5" strokeWidth={1.7} />
                  )}
                </div>
                <div className="file-row-main">
                  <div className="file-row-name" title={file.original_name}>{file.original_name}</div>
                  <div className="file-row-meta">
                    <span>{projectNameById.get(file.project_id) ?? file.project_id}</span>
                    <span>{formatFileSize(file.size)}</span>
                    <span>{file.mime_type}</span>
                    <span>{formatRelativeTime(file.created_at)}</span>
                  </div>
                </div>
                <div className="file-row-refs">
                  <span>{t('files.referenceCount', { count: file.reference_count })}</span>
                  <span title={file.last_referenced_room_name ?? undefined}>
                    {file.last_referenced_room_name ?? t('files.neverReferenced')}
                  </span>
                </div>
                <div className="file-row-actions">
                  <button
                    type="button"
                    className="icon-glass-button"
                    aria-label={t('files.preview')}
                    title={t('files.preview')}
                    onClick={() => setPreview(file)}
                  >
                    <Eye className="h-4 w-4" strokeWidth={1.8} />
                  </button>
                  <a
                    href={file.url}
                    download={file.original_name}
                    className="icon-glass-button"
                    aria-label={t('files.download')}
                    title={t('files.download')}
                  >
                    <Download className="h-4 w-4" strokeWidth={1.8} />
                  </a>
                  <button
                    type="button"
                    className="icon-glass-button is-danger"
                    aria-label={t('files.delete')}
                    title={t('files.delete')}
                    disabled={remove.isPending}
                    onClick={() => handleDelete(file)}
                  >
                    <Trash2 className="h-4 w-4" strokeWidth={1.8} />
                  </button>
                </div>
              </article>
            ))
          )}
        </section>
      </main>

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
