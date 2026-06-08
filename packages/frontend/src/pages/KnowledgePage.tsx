import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Database, Grid2X2, List, RefreshCcw } from 'lucide-react';
import { toast } from 'sonner';
import { KnowledgeCommandBar } from '../components/KnowledgeCommandBar';
import { KnowledgeInspector } from '../components/KnowledgeInspector';
import { KnowledgeProjectRail, type KnowledgeRailProject, type KnowledgeRailRoom } from '../components/KnowledgeProjectRail';
import { KnowledgeResourceView, type KnowledgeResourceViewMode } from '../components/KnowledgeResourceView';
import { Button } from '../components/ui/Button';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import {
  filterKnowledgeSources,
  sortKnowledgeSourcesByStatus,
  summarizeKnowledgeStats,
  type KnowledgeSource,
  type KnowledgeSourceFilters,
} from '../lib/knowledgeDisplay';
import type { Project, Room } from '../lib/types';

export function KnowledgePage(): JSX.Element {
  const { projectId = '' } = useParams();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { locale, t } = useI18n();
  const [filters, setFilters] = useState<KnowledgeSourceFilters>(() => ({ projectId }));
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<KnowledgeResourceViewMode>('list');

  useEffect(() => {
    setFilters((current) => ({
      ...current,
      projectId,
      roomId: projectId ? current.roomId : '',
    }));
    setSelectedSourceId(null);
  }, [projectId]);

  useEffect(() => {
    document.title = `${locale === 'zh' ? '知识库' : 'Knowledge'} · ${t('app.name')}`;
  }, [locale, t]);

  const selectedProjectId = filters.projectId ?? '';
  const selectedRoomId = filters.roomId ?? '';

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
  const canLoadSources = !selectedProjectId || !selectedRoomId || roomsFetched;

  useEffect(() => {
    if (!selectedProjectId || !selectedRoomId || !roomsFetched) return;
    if (!activeRoomId) setFilters((current) => ({ ...current, roomId: '' }));
  }, [activeRoomId, roomsFetched, selectedProjectId, selectedRoomId]);

  const {
    data: summarySources = [],
    isLoading: summaryLoading,
  } = useQuery({
    queryKey: ['knowledge-sources', 'summary'],
    queryFn: () => api.listKnowledgeSources({ limit: 500 }),
  });

  const {
    data: sources = [],
    error: sourcesError,
    isError: sourcesIsError,
    isLoading: sourcesLoading,
    refetch: refetchSources,
  } = useQuery({
    queryKey: [
      'knowledge-sources',
      selectedProjectId,
      activeRoomId,
      filters.status ?? '',
      filters.sourceType ?? '',
    ],
    queryFn: () => api.listKnowledgeSources({
      projectId: selectedProjectId || undefined,
      roomId: activeRoomId || undefined,
      status: filters.status || undefined,
      sourceType: filters.sourceType || undefined,
      limit: 500,
    }),
    enabled: canLoadSources,
  });

  const activeFilters = useMemo<KnowledgeSourceFilters>(() => ({
    ...filters,
    roomId: activeRoomId,
  }), [activeRoomId, filters]);

  const visibleSources = useMemo(() => {
    return sortKnowledgeSourcesByStatus(
      filterKnowledgeSources(sources, activeFilters, locale),
    );
  }, [activeFilters, locale, sources]);

  const selectedSource = useMemo(() => {
    return visibleSources.find((source) => source.id === selectedSourceId) ?? null;
  }, [selectedSourceId, visibleSources]);

  const stats = useMemo(() => summarizeKnowledgeStats(
    filterKnowledgeSources(summarySources, {
      projectId: selectedProjectId,
      roomId: activeRoomId,
    }, locale),
  ), [activeRoomId, locale, selectedProjectId, summarySources]);

  const railProjects = useMemo(
    () => buildKnowledgeRailProjects(projects, summarySources),
    [projects, summarySources],
  );
  const railRooms = useMemo(
    () => buildKnowledgeRailRooms(rooms, summarySources, selectedProjectId),
    [rooms, selectedProjectId, summarySources],
  );
  const selectedProject = useMemo(
    () => projects.find((item) => item.id === selectedProjectId) ?? project ?? null,
    [project, projects, selectedProjectId],
  );
  const selectedRoom = useMemo(
    () => rooms.find((item) => item.id === activeRoomId) ?? null,
    [activeRoomId, rooms],
  );

  const upload = useMutation({
    mutationFn: (selectedFiles: File[]) => {
      if (!selectedProjectId) throw new Error(locale === 'zh' ? '请选择项目后再上传文件。' : 'Select a project before uploading files.');
      return api.uploadProjectFiles(selectedProjectId, selectedFiles);
    },
    onSuccess: async (uploaded) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['knowledge-sources'] }),
        queryClient.invalidateQueries({ queryKey: ['files'] }),
        queryClient.invalidateQueries({ queryKey: ['project-files', selectedProjectId] }),
      ]);
      toast.success(locale === 'zh' ? '文件已上传' : 'Files uploaded', {
        description: locale === 'zh'
          ? `已上传 ${uploaded.length} 个文件，知识库索引会自动更新。`
          : `${uploaded.length} file(s) uploaded. Knowledge indexing will update automatically.`,
      });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const replaceFilters = (nextFilters: KnowledgeSourceFilters) => {
    setFilters({
      ...nextFilters,
      roomId: nextFilters.projectId ? nextFilters.roomId ?? '' : '',
    });
    setSelectedSourceId(null);
  };

  const patchFilters = (nextFilters: KnowledgeSourceFilters) => {
    setFilters((current) => ({
      ...current,
      ...nextFilters,
      roomId: nextFilters.projectId === '' ? '' : nextFilters.roomId ?? current.roomId,
    }));
    setSelectedSourceId(null);
  };

  const emptyTitle = sources.length === 0 && !(filters.keyword ?? '').trim()
    ? locale === 'zh' ? '暂无知识资源' : 'No knowledge resources'
    : locale === 'zh' ? '没有匹配的知识资源' : 'No matching knowledge resources';
  const emptyDescription = sources.length === 0 && !(filters.keyword ?? '').trim()
    ? locale === 'zh' ? '上传项目文件或保存智能体文档后，资源会出现在知识库。' : 'Uploaded project files and saved agent documents appear here.'
    : locale === 'zh' ? '调整项目、房间、状态、类型或搜索词后重试。' : 'Adjust project, room, status, type, or search keyword.';

  return (
    <div className="files-page">
      <header className="workspace-toolbar">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to={projectId ? `/projects/${projectId}` : '/'}
            className="toolbar-back"
            aria-label={projectId ? (locale === 'zh' ? '返回项目' : 'Back to project') : t('shell.nav.development')}
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div className="min-w-0">
            <div className="font-display text-[15px] font-semibold leading-tight">
              {locale === 'zh' ? '知识库' : 'Knowledge'}
            </div>
            <div className="mt-1 hidden truncate font-mono text-[11px] text-[var(--color-fg-muted)] sm:block">
              {selectedProject ? `${selectedProject.name} · ${selectedProject.path}` : locale === 'zh' ? '所有项目' : 'All projects'}
              {selectedRoom ? ` · ${selectedRoom.name}` : ''}
            </div>
          </div>
        </div>

        <div className="files-summary" aria-label={locale === 'zh' ? '知识库摘要' : 'Knowledge summary'}>
          <span>{locale === 'zh' ? `${stats.total} 个资源` : `${stats.total} sources`}</span>
          <span>{locale === 'zh' ? `${stats.ready} 已提取` : `${stats.ready} ready`}</span>
          <span>{locale === 'zh' ? `${stats.chunks} chunks` : `${stats.chunks} chunks`}</span>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-3 lg:p-4">
        <section className="files-toolbar">
          <div className="min-w-0">
            <h1>{locale === 'zh' ? '知识库中心' : 'Knowledge hub'}</h1>
            <p>
              {locale === 'zh'
                ? '集中查看已索引的项目文件、智能体文档和会话知识，按项目、房间、状态和类型快速定位。'
                : 'Review indexed project files, agent documents, and session knowledge by project, room, status, and type.'}
            </p>
          </div>
          <div className="files-toolbar-actions">
            <div className="file-view-toggle" aria-label={locale === 'zh' ? '展示模式' : 'View mode'}>
              <button
                type="button"
                className={viewMode === 'list' ? 'is-active' : ''}
                aria-label={locale === 'zh' ? '列表模式' : 'List view'}
                aria-pressed={viewMode === 'list'}
                title={locale === 'zh' ? '列表模式' : 'List view'}
                onClick={() => setViewMode('list')}
              >
                <List className="h-4 w-4" strokeWidth={1.8} />
              </button>
              <button
                type="button"
                className={viewMode === 'grid' ? 'is-active' : ''}
                aria-label={locale === 'zh' ? '网格模式' : 'Grid view'}
                aria-pressed={viewMode === 'grid'}
                title={locale === 'zh' ? '网格模式' : 'Grid view'}
                onClick={() => setViewMode('grid')}
              >
                <Grid2X2 className="h-4 w-4" strokeWidth={1.8} />
              </button>
            </div>
            <Button
              type="button"
              variant="secondary"
              className="gap-2"
              disabled={sourcesLoading}
              onClick={() => void refetchSources()}
            >
              <RefreshCcw className="h-4 w-4" strokeWidth={1.8} />
              <span className="hidden sm:inline">{locale === 'zh' ? '刷新' : 'Refresh'}</span>
            </Button>
          </div>
        </section>

        <section className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-hidden xl:grid-cols-[260px_minmax(0,1fr)_320px]">
          <div className="hidden min-h-0 xl:block">
            <KnowledgeProjectRail
              filters={activeFilters}
              projects={railProjects}
              rooms={railRooms}
              stats={stats}
              locale={locale}
              disabled={summaryLoading}
              onFiltersChange={replaceFilters}
            />
          </div>

          <div className="flex min-h-0 min-w-0 flex-col gap-3 overflow-hidden">
            <div className="min-h-0 flex-1 overflow-auto pr-1">
              {sourcesIsError ? (
                <KnowledgeErrorState
                  title={locale === 'zh' ? '知识库加载失败' : 'Failed to load knowledge'}
                  description={sourcesError instanceof Error ? sourcesError.message : undefined}
                  retryLabel={locale === 'zh' ? '重试' : 'Retry'}
                  onRetry={() => void refetchSources()}
                />
              ) : (
                <KnowledgeResourceView
                  sources={visibleSources}
                  viewMode={viewMode}
                  selectedSourceId={selectedSourceId}
                  loading={sourcesLoading || !canLoadSources}
                  emptyTitle={emptyTitle}
                  emptyDescription={emptyDescription}
                  locale={locale}
                  onSelect={(source) => setSelectedSourceId(source.id)}
                />
              )}
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
            <KnowledgeCommandBar
              keyword={filters.keyword ?? ''}
              status={filters.status ?? ''}
              sourceType={filters.sourceType ?? ''}
              locale={locale}
              disabled={sourcesLoading}
              uploadDisabled={!selectedProjectId || upload.isPending}
              uploadLabel={!selectedProjectId
                ? locale === 'zh' ? '选择项目后上传' : 'Select project to upload'
                : upload.isPending
                  ? locale === 'zh' ? '上传中' : 'Uploading'
                  : locale === 'zh' ? '上传文件' : 'Upload files'}
              onKeywordChange={(keyword) => setFilters((current) => ({ ...current, keyword }))}
              onStatusChange={(status) => patchFilters({ status })}
              onSourceTypeChange={(sourceType) => patchFilters({ sourceType })}
              onUpload={() => fileInputRef.current?.click()}
            />
          </div>

          <div className="hidden min-h-0 xl:block">
            <KnowledgeInspector
              source={selectedSource}
              sources={visibleSources}
              stats={stats}
              locale={locale}
              loading={sourcesLoading}
            />
          </div>
        </section>
      </main>
    </div>
  );
}

function buildKnowledgeRailProjects(projects: Project[], sources: KnowledgeSource[]): KnowledgeRailProject[] {
  const statsByProject = sources.reduce((map, source) => {
    const stats = map.get(source.project_id) ?? { sourceCount: 0, readyCount: 0, failedCount: 0 };
    stats.sourceCount += 1;
    if (source.status === 'ready') stats.readyCount += 1;
    if (source.status === 'failed') stats.failedCount += 1;
    map.set(source.project_id, stats);
    return map;
  }, new Map<string, { sourceCount: number; readyCount: number; failedCount: number }>());

  return projects.map((project) => ({
    id: project.id,
    name: project.name,
    path: project.path,
    ...(statsByProject.get(project.id) ?? { sourceCount: 0, readyCount: 0, failedCount: 0 }),
  }));
}

function buildKnowledgeRailRooms(rooms: Room[], sources: KnowledgeSource[], projectId: string): KnowledgeRailRoom[] {
  const counts = sources.reduce((map, source) => {
    if (source.project_id !== projectId || !source.room_id) return map;
    map.set(source.room_id, (map.get(source.room_id) ?? 0) + 1);
    return map;
  }, new Map<string, number>());

  return rooms.map((room) => ({
    id: room.id,
    name: room.name,
    sourceCount: counts.get(room.id) ?? 0,
  }));
}

function KnowledgeErrorState({
  title,
  description,
  retryLabel,
  onRetry,
}: {
  title: string;
  description?: string;
  retryLabel: string;
  onRetry: () => void;
}): JSX.Element {
  return (
    <div className="flex min-h-[320px] flex-col items-center justify-center gap-3 rounded-md border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] px-6 text-center">
      <span className="flex h-9 w-9 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] text-[var(--color-primary)]">
        <Database className="h-4 w-4" strokeWidth={1.8} />
      </span>
      <div className="max-w-[360px]">
        <div className="text-[14px] font-semibold text-[var(--color-fg)]">{title}</div>
        {description ? <p className="mt-1 text-[12px] leading-5 text-[var(--color-fg-muted)]">{description}</p> : null}
      </div>
      <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
        {retryLabel}
      </Button>
    </div>
  );
}
