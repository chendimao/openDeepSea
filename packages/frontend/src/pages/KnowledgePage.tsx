import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  Check,
  ChevronDown,
  CloudUpload,
  Code2,
  Database,
  Download,
  Eye,
  FileOutput,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Grid2X2,
  Hourglass,
  Image as ImageIcon,
  Link2,
  List,
  MoreVertical,
  Plus,
  RefreshCcw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { ProjectFilePreviewDialog } from '../components/ProjectFilePreviewDialog';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import {
  filterKnowledgeSources,
  formatKnowledgeSize,
  getKnowledgeRetrievalModeDisplay,
  getKnowledgeSourceTypeDisplay,
  sortKnowledgeSourcesByStatus,
  summarizeKnowledgeInsights,
  summarizeKnowledgeStats,
  type KnowledgeChunk,
  type KnowledgeExtraction,
  type KnowledgeImportResult,
  type KnowledgeInsightsSummary,
  type KnowledgeLocale,
  type KnowledgeMetadataPatch,
  type KnowledgeRetrievalMode,
  type KnowledgeSearchResult,
  type KnowledgeSource,
  type KnowledgeSourceDetail,
  type KnowledgeSourceFilters,
  type KnowledgeSourceStatus,
  type KnowledgeSourceType,
  type WorkspaceKnowledgeImportResult,
} from '../lib/knowledgeDisplay';
import type { ProjectFile, ResourceType } from '../lib/types';

type IconComponent = LucideIcon;
type DetailTab = 'overview' | 'preview' | 'extraction' | 'summary' | 'chunks' | 'refs';
type KnowledgeImportKind = 'manual' | 'url' | 'workspace';
type KnowledgeFactField = keyof KnowledgeMetadataPatch;

interface KnowledgeImportFormState {
  manualTitle: string;
  manualContent: string;
  manualTags: string;
  url: string;
  urlTitle: string;
  urlContent: string;
  urlTags: string;
  workspacePaths: string;
  workspaceTags: string;
}

interface KnowledgeDashboardStats {
  total: number;
  ready: number;
  processing: number;
  pending: number;
  failed: number;
  chunks: number;
  totalSize: number;
}

interface KnowledgeResourceRow {
  id: string;
  title: string;
  subtitle: string;
  fileName: string;
  typeLabel: string;
  status: KnowledgeSourceStatus;
  statusLabel: string;
  sizeLabel: string;
  updatedAt: string;
  compactUpdatedAt: string;
  tags: string[];
  icon: IconComponent;
  iconClassName: string;
  typePillClassName: string;
  statusPillClassName: string;
  progress?: number;
  pagesLabel: string;
  source: KnowledgeSource;
}

const SOURCE_TYPE_FILTERS: Array<{ value: KnowledgeSourceType | ''; label: string }> = [
  { value: '', label: '全部' },
  { value: 'agent_document', label: '智能体文档' },
  { value: 'uploaded_file', label: '上传文件' },
  { value: 'resource_asset', label: '资源资产' },
  { value: 'workspace_file', label: '工作区文件' },
  { value: 'workspace_doc', label: '工作区文档' },
  { value: 'web_page', label: '网页导入' },
  { value: 'url', label: 'URL 导入' },
  { value: 'manual', label: '手动条目' },
];

const STATUS_FILTERS: Array<{ value: KnowledgeSourceStatus | ''; label: string }> = [
  { value: '', label: '全部' },
  { value: 'ready', label: '已完成' },
  { value: 'processing', label: '处理中' },
  { value: 'pending', label: '待处理' },
  { value: 'failed', label: '失败' },
  { value: 'stale', label: '已过期' },
  { value: 'disabled', label: '已禁用' },
];

const DETAIL_TABS: Array<{ value: DetailTab; label: string }> = [
  { value: 'overview', label: '概览' },
  { value: 'preview', label: '预览' },
  { value: 'extraction', label: '解析' },
  { value: 'summary', label: '摘要' },
  { value: 'chunks', label: 'Chunks' },
  { value: 'refs', label: '引用' },
];

const RETRIEVAL_MODE_OPTIONS: Array<{ value: KnowledgeRetrievalMode; fallbackLabel: string }> = [
  { value: 'keyword', fallbackLabel: '关键词' },
  { value: 'vector_preview', fallbackLabel: '向量预览' },
  { value: 'hybrid', fallbackLabel: '混合' },
];

const KNOWLEDGE_FACT_FIELDS: Array<{ key: KnowledgeFactField; label: string; placeholder: string }> = [
  { key: 'key_points', label: '关键点', placeholder: '每行一个关键事实' },
  { key: 'decisions', label: '决策', placeholder: '每行一个已确认决策' },
  { key: 'constraints', label: '约束', placeholder: '每行一个约束条件' },
  { key: 'risks', label: '风险', placeholder: '每行一个风险或缺口' },
  { key: 'learnings', label: '经验', placeholder: '每行一个可复用经验' },
];

const EMPTY_IMPORT_FORM: KnowledgeImportFormState = {
  manualTitle: '',
  manualContent: '',
  manualTags: '',
  url: '',
  urlTitle: '',
  urlContent: '',
  urlTags: '',
  workspacePaths: '',
  workspaceTags: '',
};

export function KnowledgePage(): JSX.Element {
  const { projectId = '' } = useParams();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { locale, t } = useI18n();
  const [filters, setFilters] = useState<KnowledgeSourceFilters>(() => ({ projectId }));
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
  const [activeDetailTab, setActiveDetailTab] = useState<DetailTab>('overview');
  const [previewFile, setPreviewFile] = useState<ProjectFile | null>(null);
  const [retrievalMode, setRetrievalMode] = useState<KnowledgeRetrievalMode>('keyword');
  const [importDialog, setImportDialog] = useState<KnowledgeImportKind | null>(null);
  const [importForm, setImportForm] = useState<KnowledgeImportFormState>(EMPTY_IMPORT_FORM);
  const [metadataDraft, setMetadataDraft] = useState<Record<KnowledgeFactField, string>>(() => buildMetadataDraft(null));

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
  const keyword = (filters.keyword ?? '').trim();

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

  const { data: summarySources = [] } = useQuery({
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
    queryKey: ['knowledge-sources', selectedProjectId, activeRoomId, filters.status ?? '', filters.sourceType ?? ''],
    queryFn: () => api.listKnowledgeSources({
      projectId: selectedProjectId || undefined,
      roomId: activeRoomId || undefined,
      status: filters.status || undefined,
      sourceType: filters.sourceType || undefined,
      limit: 500,
    }),
    enabled: canLoadSources,
  });

  const shouldSearchKnowledge = Boolean(selectedProjectId && keyword);
  const { data: searchResults = [], isLoading: searchLoading } = useQuery({
    queryKey: ['knowledge-search', selectedProjectId, activeRoomId, filters.status ?? '', filters.sourceType ?? '', keyword, retrievalMode],
    queryFn: () => api.searchKnowledge({
      projectId: selectedProjectId,
      roomId: activeRoomId || undefined,
      status: filters.status || undefined,
      sourceType: filters.sourceType || undefined,
      query: keyword,
      mode: retrievalMode,
      limit: 50,
    }),
    enabled: shouldSearchKnowledge,
  });
  const { data: insights } = useQuery({
    queryKey: ['knowledge-insights', selectedProjectId, activeRoomId],
    queryFn: () => api.getKnowledgeInsights({ projectId: selectedProjectId, roomId: activeRoomId || undefined }),
    enabled: Boolean(selectedProjectId),
  });
  const insightSummary = useMemo(() => summarizeKnowledgeInsights(insights, locale), [insights, locale]);

  const searchSourceIds = useMemo(
    () => new Set(searchResults.map((result) => result.source_id)),
    [searchResults],
  );
  const activeFilters = useMemo<KnowledgeSourceFilters>(() => ({ ...filters, roomId: activeRoomId }), [activeRoomId, filters]);

  const visibleSources = useMemo(() => {
    const withoutKeyword = { ...activeFilters, keyword: '' };
    const base = filterKnowledgeSources(sources, withoutKeyword, locale);
    const filtered = keyword
      ? base.filter((source) => {
        const localMatch = filterKnowledgeSources([source], { keyword }, locale).length > 0;
        return localMatch || searchSourceIds.has(source.id);
      })
      : base;
    return sortKnowledgeSourcesByStatus(filtered);
  }, [activeFilters, keyword, locale, searchSourceIds, sources]);

  const liveStats = useMemo(() => summarizeKnowledgeStats(
    filterKnowledgeSources(summarySources, {
      projectId: selectedProjectId,
      roomId: activeRoomId,
    }, locale),
  ), [activeRoomId, locale, selectedProjectId, summarySources]);

  const dashboardStats = useMemo<KnowledgeDashboardStats>(() => {
    const pending = Math.max(0, liveStats.total - liveStats.ready - liveStats.processing - liveStats.failed);
    return {
      total: liveStats.total,
      ready: liveStats.ready,
      processing: liveStats.processing,
      pending,
      failed: liveStats.failed,
      chunks: liveStats.chunks,
      totalSize: liveStats.totalSize,
    };
  }, [liveStats]);

  const selectedProject = useMemo(
    () => projects.find((item) => item.id === selectedProjectId) ?? project ?? null,
    [project, projects, selectedProjectId],
  );
  const selectedRoom = useMemo(() => rooms.find((item) => item.id === activeRoomId) ?? null, [activeRoomId, rooms]);

  const sourceTypeCounts = useMemo(() => {
    const counts = new Map<KnowledgeSourceType, number>();
    for (const source of filterKnowledgeSources(summarySources, {
      projectId: selectedProjectId,
      roomId: activeRoomId,
    }, locale)) {
      counts.set(source.source_type, (counts.get(source.source_type) ?? 0) + 1);
    }
    return counts;
  }, [activeRoomId, locale, selectedProjectId, summarySources]);

  const rows = useMemo(() => visibleSources.map(createKnowledgeRow), [visibleSources]);
  const selectedRow = rows.find((row) => row.id === selectedSourceId) ?? null;
  const selectedSourceIdForQuery = selectedRow?.source.id ?? null;
  const selectedSearchResults = useMemo(
    () => searchResults.filter((result) => result.source_id === selectedSourceIdForQuery),
    [searchResults, selectedSourceIdForQuery],
  );
  const pathLabel = selectedProject ? `${selectedProject.name} · ${selectedProject.path}` : '所有项目';

  useEffect(() => {
    if (!selectedSourceId) return;
    if (!rows.some((row) => row.id === selectedSourceId)) setSelectedSourceId(null);
  }, [rows, selectedSourceId]);

  const { data: selectedDetail } = useQuery({
    queryKey: ['knowledge-source', selectedSourceIdForQuery],
    queryFn: () => api.getKnowledgeSource(selectedSourceIdForQuery!),
    enabled: !!selectedSourceIdForQuery,
  });
  const { data: selectedExtraction } = useQuery({
    queryKey: ['knowledge-extraction', selectedSourceIdForQuery],
    queryFn: () => api.getKnowledgeExtraction(selectedSourceIdForQuery!),
    enabled: !!selectedSourceIdForQuery && activeDetailTab === 'extraction',
    retry: false,
  });
  const { data: selectedChunks = [] } = useQuery({
    queryKey: ['knowledge-chunks', selectedSourceIdForQuery],
    queryFn: () => api.listKnowledgeChunks(selectedSourceIdForQuery!, { limit: 200 }),
    enabled: !!selectedSourceIdForQuery && activeDetailTab === 'chunks',
  });

  useEffect(() => {
    setMetadataDraft(buildMetadataDraft((selectedDetail ?? selectedRow?.source)?.metadata ?? null));
  }, [selectedDetail, selectedRow?.source]);

  const upload = useMutation({
    mutationFn: (selectedFiles: File[]) => {
      if (!selectedProjectId) throw new Error(locale === 'zh' ? '请选择项目后再上传文件。' : 'Select a project before uploading files.');
      return api.uploadProjectFiles(selectedProjectId, selectedFiles);
    },
    onSuccess: async (uploaded) => {
      await invalidateKnowledgeQueries(queryClient, selectedProjectId);
      toast.success('文件已上传', {
        description: `已上传 ${uploaded.length} 个文件，知识库索引会自动更新。`,
      });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const reprocess = useMutation({
    mutationFn: (sourceId: string) => api.reprocessKnowledgeSource(sourceId),
    onSuccess: async () => {
      await invalidateKnowledgeQueries(queryClient, selectedProjectId);
      toast.success('已重新处理知识资源');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const updateStatus = useMutation({
    mutationFn: (source: KnowledgeSource) => api.updateKnowledgeSource(source.id, {
      status: source.status === 'disabled' ? 'ready' : 'disabled',
    }),
    onSuccess: async (source) => {
      await invalidateKnowledgeQueries(queryClient, selectedProjectId);
      toast.success(source.status === 'disabled' ? '已禁用检索' : '已恢复检索');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const createImport = useMutation<KnowledgeImportResult | WorkspaceKnowledgeImportResult, Error, KnowledgeImportKind>({
    mutationFn: (kind: KnowledgeImportKind) => {
      if (!selectedProjectId) throw new Error('请选择项目后再导入知识。');
      const roomId = activeRoomId || undefined;
      if (kind === 'manual') {
        return api.createManualKnowledge(selectedProjectId, {
          title: importForm.manualTitle,
          content: importForm.manualContent,
          tags: parseTagInput(importForm.manualTags),
          roomId,
        });
      }
      if (kind === 'url') {
        return api.createUrlKnowledge(selectedProjectId, {
          url: importForm.url,
          title: importForm.urlTitle || undefined,
          content: importForm.urlContent || undefined,
          tags: parseTagInput(importForm.urlTags),
          roomId,
        });
      }
      return api.importWorkspaceKnowledgeDocs(selectedProjectId, {
        paths: parseMultilineInput(importForm.workspacePaths),
        tags: parseTagInput(importForm.workspaceTags),
        roomId,
      });
    },
    onSuccess: async () => {
      await invalidateKnowledgeQueries(queryClient, selectedProjectId);
      setImportDialog(null);
      toast.success('已导入知识资源');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const saveMetadata = useMutation({
    mutationFn: (sourceId: string) => api.updateKnowledgeSource(sourceId, {
      metadataPatch: buildMetadataPatch(metadataDraft),
    }),
    onSuccess: async () => {
      await invalidateKnowledgeQueries(queryClient, selectedProjectId);
      toast.success('知识沉淀已保存');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const removeSource = useMutation({
    mutationFn: (sourceId: string) => api.deleteKnowledgeSource(sourceId),
    onSuccess: async () => {
      setSelectedSourceId(null);
      await invalidateKnowledgeQueries(queryClient, selectedProjectId);
      toast.success('已删除知识库记录');
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

  const openPreview = (detail?: KnowledgeSourceDetail) => {
    const file = detail ? knowledgeDetailToPreviewFile(detail) : null;
    if (!file) {
      toast.error('该资源没有可预览的原始文件');
      return;
    }
    setPreviewFile(file);
  };

  return (
    <div className="knowledge-command-page">
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

      <div className="knowledge-workbench">
        <KnowledgeSidebar
          stats={dashboardStats}
          filters={activeFilters}
          sourceTypeCounts={sourceTypeCounts}
          selectedProjectLabel={pathLabel}
          selectedRoomLabel={selectedRoom?.name ?? ''}
          uploadPending={upload.isPending}
          onUpload={() => fileInputRef.current?.click()}
          onFiltersChange={replaceFilters}
          onPatchFilters={patchFilters}
        />

        <main className="knowledge-main knowledge-scrollbar">
          <div className="knowledge-main-shell flex min-h-0 flex-1 flex-col p-4">
            <div className="knowledge-main-header mb-4 flex items-center justify-between gap-4">
              <div className="knowledge-main-title min-w-0">
                <h1 className="m-0 text-[18px] font-bold leading-tight text-slate-950">全部资源</h1>
                <p className="mt-0.5 text-[11px] text-slate-500">管理和检索项目中的所有知识资源</p>
              </div>
              <div className="knowledge-main-actions flex shrink-0 items-center gap-2">
                <div className="knowledge-action-group">
                  <button type="button" onClick={() => void refetchSources()}>
                    <RefreshCcw className="h-3 w-3 text-slate-500" strokeWidth={2} />
                    刷新
                  </button>
                  <button type="button" disabled={rows.length === 0} onClick={() => exportKnowledgeRows(rows)}>
                    <FileOutput className="h-3 w-3 text-slate-500" strokeWidth={2} />
                    导出清单
                  </button>
                  <button type="button" disabled={!selectedProjectId} onClick={() => setImportDialog('manual')}>
                    <Plus className="h-3 w-3 text-slate-500" strokeWidth={2} />
                    手动
                  </button>
                  <button type="button" disabled={!selectedProjectId} onClick={() => setImportDialog('url')}>
                    <Link2 className="h-3 w-3 text-slate-500" strokeWidth={2} />
                    URL
                  </button>
                  <button type="button" disabled={!selectedProjectId} onClick={() => setImportDialog('workspace')}>
                    <FolderOpen className="h-3 w-3 text-slate-500" strokeWidth={2} />
                    工作区
                  </button>
                </div>
                <div className="knowledge-view-toggle" aria-label="展示模式">
                  <button
                    type="button"
                    className={viewMode === 'list' ? 'is-active' : ''}
                    aria-label="列表模式"
                    aria-pressed={viewMode === 'list'}
                    onClick={() => setViewMode('list')}
                  >
                    <List className="h-3 w-3" strokeWidth={2.2} />
                  </button>
                  <button
                    type="button"
                    className={viewMode === 'grid' ? 'is-active' : ''}
                    aria-label="网格模式"
                    aria-pressed={viewMode === 'grid'}
                    onClick={() => setViewMode('grid')}
                  >
                    <Grid2X2 className="h-3 w-3" strokeWidth={2.2} />
                  </button>
                </div>
              </div>
            </div>

            <KnowledgeStatsCards stats={dashboardStats} />

            <KnowledgeInsightsStrip summary={insightSummary} onSelectSource={(sourceId) => setSelectedSourceId(sourceId)} />

            <div className="mb-3 space-y-2">
              <label className="knowledge-resource-search">
                <Search className="h-3 w-3 text-slate-500" strokeWidth={2.1} />
                <input
                  value={filters.keyword ?? ''}
                  onChange={(event) => setFilters((current) => ({ ...current, keyword: event.target.value }))}
                  placeholder="搜索文件名、内容、标签、摘要..."
                  aria-label="搜索知识资源"
                />
                <SlidersHorizontal className="h-3 w-3 text-slate-500" strokeWidth={2.1} />
              </label>
              <KnowledgeRetrievalModeControl mode={retrievalMode} locale={locale} onChange={setRetrievalMode} />
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11px]">
                  <FilterSelect
                    label="项目"
                    value={selectedProjectId}
                    options={[{ value: '', label: '全部' }, ...projects.map((item) => ({ value: item.id, label: item.name }))]}
                    onChange={(value) => replaceFilters({ ...activeFilters, projectId: value, roomId: '' })}
                  />
                  <FilterSelect
                    label="房间"
                    value={activeRoomId}
                    options={[{ value: '', label: '全部' }, ...rooms.map((room) => ({ value: room.id, label: room.name }))]}
                    disabled={!selectedProjectId || rooms.length === 0}
                    onChange={(value) => patchFilters({ roomId: value })}
                  />
                  <FilterSelect
                    label="类型"
                    value={filters.sourceType ?? ''}
                    options={SOURCE_TYPE_FILTERS}
                    onChange={(value) => patchFilters({ sourceType: value as KnowledgeSourceType | '' })}
                  />
                  <FilterSelect
                    label="状态"
                    value={filters.status ?? ''}
                    options={STATUS_FILTERS}
                    onChange={(value) => patchFilters({ status: value as KnowledgeSourceStatus | '' })}
                  />
                </div>
                <span className="knowledge-sort-button">
                  状态优先
                  <ChevronDown className="h-2 w-2 text-slate-500" strokeWidth={2.4} />
                </span>
              </div>
            </div>

            {importDialog ? (
              <KnowledgeImportPanel
                kind={importDialog}
                form={importForm}
                pending={createImport.isPending}
                onKindChange={setImportDialog}
                onChange={(patch) => setImportForm((current) => ({ ...current, ...patch }))}
                onCancel={() => setImportDialog(null)}
                onSubmit={() => createImport.mutate(importDialog)}
              />
            ) : null}

            {shouldSearchKnowledge ? <SearchResultSummary loading={searchLoading} results={searchResults} /> : null}

            <KnowledgeResourceTable
              rows={rows}
              selectedRowId={selectedRow?.id ?? ''}
              loading={sourcesLoading && rows.length === 0}
              error={sourcesIsError ? sourcesError : null}
              viewMode={viewMode}
              onSelect={(row) => {
                setSelectedSourceId(row.id);
                setActiveDetailTab('overview');
              }}
            />
          </div>

          <KnowledgePagination total={rows.length} />
        </main>

        <KnowledgeDetailsPanel
          row={selectedRow}
          detail={selectedDetail}
          extraction={selectedExtraction}
          chunks={selectedChunks}
          rankingResults={selectedSearchResults}
          activeTab={activeDetailTab}
          actionPending={reprocess.isPending || updateStatus.isPending || removeSource.isPending}
          metadataDraft={metadataDraft}
          metadataSaving={saveMetadata.isPending}
          onTabChange={setActiveDetailTab}
          onClose={() => setSelectedSourceId(null)}
          onPreview={() => openPreview(selectedDetail)}
          onCopyReference={(source) => void copyKnowledgeReference(source)}
          onToggleDisabled={(source) => updateStatus.mutate(source)}
          onReprocess={(sourceId) => reprocess.mutate(sourceId)}
          onMetadataDraftChange={(field, value) => setMetadataDraft((current) => ({ ...current, [field]: value }))}
          onSaveMetadata={(sourceId) => saveMetadata.mutate(sourceId)}
          onDelete={(sourceId) => {
            if (window.confirm('删除该知识库记录？原始文件会保留。')) removeSource.mutate(sourceId);
          }}
        />
      </div>

      <ProjectFilePreviewDialog
        file={previewFile}
        projectId={previewFile?.project_id}
        onOpenChange={(open) => {
          if (!open) setPreviewFile(null);
        }}
      />
    </div>
  );
}

function KnowledgeSidebar({
  stats,
  filters,
  sourceTypeCounts,
  selectedProjectLabel,
  selectedRoomLabel,
  uploadPending,
  onUpload,
  onFiltersChange,
  onPatchFilters,
}: {
  stats: KnowledgeDashboardStats;
  filters: KnowledgeSourceFilters;
  sourceTypeCounts: Map<KnowledgeSourceType, number>;
  selectedProjectLabel: string;
  selectedRoomLabel: string;
  uploadPending: boolean;
  onUpload: () => void;
  onFiltersChange: (filters: KnowledgeSourceFilters) => void;
  onPatchFilters: (filters: KnowledgeSourceFilters) => void;
}): JSX.Element {
  const storagePercent = stats.totalSize > 0 ? 100 : 0;
  return (
    <aside className="knowledge-sidebar knowledge-scrollbar">
      <div className="p-3">
        <h2 className="mb-3 text-[16px] font-bold text-slate-950">知识库</h2>
        <button type="button" className="knowledge-upload-button" disabled={uploadPending} onClick={onUpload}>
          <Plus className="h-3 w-3" strokeWidth={2.5} />
          {uploadPending ? '上传中' : '上传资源'}
        </button>
      </div>

      <div className="space-y-0.5 px-2">
        <SidebarPrimaryItem icon={FolderOpen} label="全部资源" count={formatCount(stats.total)} active onClick={() => onFiltersChange({ projectId: filters.projectId ?? '' })} />
      </div>

      <SidebarSection title="资源类型">
        {SOURCE_TYPE_FILTERS.filter((item) => item.value).map((item) => {
          const type = item.value as KnowledgeSourceType;
          const count = sourceTypeCounts.get(type) ?? 0;
          if (count === 0) return null;
          const Icon = getSidebarTypeIcon(type);
          return (
            <SidebarPrimaryItem
              key={type}
              icon={Icon}
              label={item.label}
              count={formatCount(count)}
              compact
              onClick={() => onPatchFilters({ sourceType: type })}
            />
          );
        })}
      </SidebarSection>

      <SidebarSection title="处理状态">
        <StatusSidebarItem colorClassName="bg-slate-300" label="全部" count={formatCount(stats.total)} onClick={() => onPatchFilters({ status: '' })} />
        <StatusSidebarItem colorClassName="bg-green-500" label="已完成" count={formatCount(stats.ready)} onClick={() => onPatchFilters({ status: 'ready' })} />
        <StatusSidebarItem colorClassName="bg-blue-500" label="处理中" count={formatCount(stats.processing)} onClick={() => onPatchFilters({ status: 'processing' })} />
        <StatusSidebarItem colorClassName="bg-red-500" label="失败" count={formatCount(stats.failed)} onClick={() => onPatchFilters({ status: 'failed' })} />
      </SidebarSection>

      <div className="mt-auto border-t border-slate-200 bg-slate-50 p-4">
        <div className="mb-1.5 flex items-center justify-between text-[10px] font-bold uppercase text-slate-600">
          <span>资料体积</span>
          <Database className="h-3 w-3 text-slate-400" strokeWidth={2.2} />
        </div>
        <div className="mb-1.5 flex justify-between text-[11px]">
          <span className="font-medium text-slate-700">{formatKnowledgeSize(stats.totalSize)}</span>
        </div>
        <div className="h-1 w-full overflow-hidden rounded-full bg-slate-200">
          <div className="h-full bg-[#004AC6]" style={{ width: `${storagePercent}%` }} />
        </div>
        <div className="mt-1 text-right text-[9px] text-slate-500">{formatCount(stats.chunks)} chunks</div>
        <div className="mt-3 truncate text-[9px] leading-4 text-slate-500">{selectedProjectLabel}{selectedRoomLabel ? ` · ${selectedRoomLabel}` : ''}</div>
      </div>
    </aside>
  );
}

function SidebarSection({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <div className="mt-4">
      <div className="flex cursor-pointer items-center justify-between px-5 py-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">
        {title}
        <ChevronDown className="h-2.5 w-2.5 rotate-180" strokeWidth={2.4} />
      </div>
      <div className="space-y-0.5 px-2">{children}</div>
    </div>
  );
}

function SidebarPrimaryItem({
  icon: Icon,
  label,
  count,
  active = false,
  compact = false,
  onClick,
}: {
  icon: IconComponent;
  label: string;
  count: string;
  active?: boolean;
  compact?: boolean;
  onClick?: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={['knowledge-sidebar-item', active ? 'is-active' : '', compact ? 'is-compact' : ''].filter(Boolean).join(' ')}
      onClick={onClick}
    >
      <span>
        <Icon className="h-3 w-3" strokeWidth={1.9} />
        {label}
      </span>
      <small>{count}</small>
    </button>
  );
}

function StatusSidebarItem({
  colorClassName,
  label,
  count,
  onClick,
}: {
  colorClassName: string;
  label: string;
  count: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button type="button" className="knowledge-sidebar-status" onClick={onClick}>
      <span>
        <i className={colorClassName} />
        {label}
      </span>
      <small>{count}</small>
    </button>
  );
}

function KnowledgeStatsCards({ stats }: { stats: KnowledgeDashboardStats }): JSX.Element {
  const total = Math.max(stats.total, 1);
  const metrics = [
    { label: '资源总数', value: formatCount(stats.total), sub: `${formatCount(stats.chunks)} chunks`, tone: 'text-slate-600', icon: FileText, iconNodeClassName: 'bg-blue-50 text-[#004AC6]' },
    { label: '已完成处理', value: formatCount(stats.ready), sub: `${formatPercent(stats.ready, total)}%`, tone: 'text-green-600', progress: formatPercentNumber(stats.ready, total), icon: Check },
    { label: '处理中', value: formatCount(stats.processing), sub: `${formatPercent(stats.processing, total)}%`, tone: 'text-blue-600', progress: formatPercentNumber(stats.processing, total), spin: stats.processing > 0 },
    { label: '待处理', value: formatCount(stats.pending), sub: `${formatPercent(stats.pending, total)}%`, tone: 'text-orange-600', icon: Hourglass, iconNodeClassName: 'border-2 border-orange-200 bg-orange-50 text-orange-500' },
    { label: '处理失败', value: formatCount(stats.failed), sub: `${formatPercent(stats.failed, total)}%`, tone: 'text-red-600', icon: AlertCircle, iconNodeClassName: 'rounded-full border-2 border-red-100 bg-red-50 text-red-500' },
  ];

  return (
    <div className="mb-5 grid grid-cols-5 gap-3">
      {metrics.map((metric) => (
        <div key={metric.label} className="knowledge-stat-card">
          <div>
            <div className="mb-0.5 text-[10px] font-bold text-slate-600">{metric.label}</div>
            <div className="text-[20px] font-black leading-none text-slate-800">{metric.value}</div>
            <div className={`mt-1 text-[9px] font-bold ${metric.tone}`}>{metric.sub}</div>
          </div>
          {metric.progress !== undefined ? (
            <div className="relative flex h-8 w-8 items-center justify-center">
              <svg className={`absolute inset-0 h-full w-full ${metric.spin ? 'animate-spin' : '-rotate-90'}`} viewBox="0 0 32 32" aria-hidden="true">
                <circle cx="16" cy="16" r="14" fill="none" stroke={metric.spin ? '#eff6ff' : '#f0fdf4'} strokeWidth="3" />
                <circle cx="16" cy="16" r="14" fill="none" stroke={metric.spin ? '#3b82f6' : '#22c55e'} strokeDasharray={`${metric.progress} 100`} strokeWidth="3" />
              </svg>
              {metric.icon ? <metric.icon className="h-3 w-3 text-green-500" strokeWidth={2.3} /> : null}
            </div>
          ) : (
            <span className={`flex h-8 w-8 items-center justify-center rounded ${metric.iconNodeClassName ?? ''}`}>
              {metric.icon ? <metric.icon className="h-[18px] w-[18px]" strokeWidth={2} /> : null}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  disabled = false,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  onChange: (value: string) => void;
}): JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 text-slate-500">{label}:</span>
      <label className="knowledge-filter-button">
        <select value={value} disabled={disabled} aria-label={`${label}筛选`} onChange={(event) => onChange(event.target.value)}>
          {options.map((option) => <option key={`${label}-${option.value}`} value={option.value}>{option.label}</option>)}
        </select>
        <ChevronDown className="h-2 w-2 shrink-0 text-slate-500" strokeWidth={2.4} />
      </label>
    </div>
  );
}

function KnowledgeRetrievalModeControl({
  mode,
  locale,
  onChange,
}: {
  mode: KnowledgeRetrievalMode;
  locale: KnowledgeLocale;
  onChange: (mode: KnowledgeRetrievalMode) => void;
}): JSX.Element {
  return (
    <div className="knowledge-mode-toggle" aria-label="检索模式">
      {RETRIEVAL_MODE_OPTIONS.map((option) => {
        const display = getKnowledgeRetrievalModeDisplay(option.value, locale);
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={mode === option.value}
            title={display.description}
            className={mode === option.value ? 'is-active' : ''}
            onClick={() => onChange(option.value)}
          >
            {display.label || option.fallbackLabel}
          </button>
        );
      })}
    </div>
  );
}

function KnowledgeInsightsStrip({
  summary,
  onSelectSource,
}: {
  summary: KnowledgeInsightsSummary;
  onSelectSource: (sourceId: string) => void;
}): JSX.Element | null {
  if (summary.items.length === 0) return null;
  return (
    <div className="knowledge-insights-strip" aria-label="知识治理信号">
      <span className="knowledge-insights-strip__summary">治理信号 {summary.totalIssues}</span>
      {summary.items.map((item) => (
        <button
          key={item.key}
          type="button"
          className={`knowledge-insight-chip is-${item.tone}`}
          onClick={() => {
            const firstSourceId = item.sourceIds[0];
            if (firstSourceId) onSelectSource(firstSourceId);
          }}
        >
          {item.label}
          <strong>{item.count}</strong>
        </button>
      ))}
    </div>
  );
}

function KnowledgeImportPanel({
  kind,
  form,
  pending,
  onKindChange,
  onChange,
  onCancel,
  onSubmit,
}: {
  kind: KnowledgeImportKind;
  form: KnowledgeImportFormState;
  pending: boolean;
  onKindChange: (kind: KnowledgeImportKind) => void;
  onChange: (patch: Partial<KnowledgeImportFormState>) => void;
  onCancel: () => void;
  onSubmit: () => void;
}): JSX.Element {
  return (
    <form
      className="knowledge-import-panel"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="knowledge-import-panel__tabs">
        {([
          ['manual', '手动条目'],
          ['url', 'URL'],
          ['workspace', '工作区文档'],
        ] as Array<[KnowledgeImportKind, string]>).map(([value, label]) => (
          <button key={value} type="button" className={kind === value ? 'is-active' : ''} onClick={() => onKindChange(value)}>
            {label}
          </button>
        ))}
      </div>

      {kind === 'manual' ? (
        <div className="knowledge-import-panel__grid">
          <label>
            <span>标题</span>
            <input value={form.manualTitle} onChange={(event) => onChange({ manualTitle: event.target.value })} placeholder="例如：A12 验收规范" />
          </label>
          <label>
            <span>标签</span>
            <input value={form.manualTags} onChange={(event) => onChange({ manualTags: event.target.value })} placeholder="规范, 验收" />
          </label>
          <label className="is-wide">
            <span>内容</span>
            <textarea value={form.manualContent} onChange={(event) => onChange({ manualContent: event.target.value })} placeholder="输入要沉淀到知识库的文本" rows={4} />
          </label>
        </div>
      ) : null}

      {kind === 'url' ? (
        <div className="knowledge-import-panel__grid">
          <label>
            <span>URL</span>
            <input value={form.url} onChange={(event) => onChange({ url: event.target.value })} placeholder="https://example.com/spec" />
          </label>
          <label>
            <span>标题</span>
            <input value={form.urlTitle} onChange={(event) => onChange({ urlTitle: event.target.value })} placeholder="可选" />
          </label>
          <label className="is-wide">
            <span>内容</span>
            <textarea value={form.urlContent} onChange={(event) => onChange({ urlContent: event.target.value })} placeholder="可选；留空则创建待刷新 URL 记录" rows={3} />
          </label>
          <label className="is-wide">
            <span>标签</span>
            <input value={form.urlTags} onChange={(event) => onChange({ urlTags: event.target.value })} placeholder="url, 调研" />
          </label>
        </div>
      ) : null}

      {kind === 'workspace' ? (
        <div className="knowledge-import-panel__grid">
          <label className="is-wide">
            <span>路径</span>
            <textarea value={form.workspacePaths} onChange={(event) => onChange({ workspacePaths: event.target.value })} placeholder="docs/spec.md&#10;packages/frontend/src/pages/KnowledgePage.tsx" rows={3} />
          </label>
          <label className="is-wide">
            <span>标签</span>
            <input value={form.workspaceTags} onChange={(event) => onChange({ workspaceTags: event.target.value })} placeholder="工作区, 文档" />
          </label>
        </div>
      ) : null}

      <div className="knowledge-import-panel__actions">
        <button type="button" onClick={onCancel}>取消</button>
        <button type="submit" disabled={pending}>{pending ? '导入中' : '导入知识'}</button>
      </div>
    </form>
  );
}

function SearchResultSummary({ loading, results }: { loading: boolean; results: KnowledgeSearchResult[] }): JSX.Element {
  return (
    <div className="mb-2 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
      {loading ? '全文检索中...' : `全文检索命中 ${results.length} 个 chunk`}
      {results.length > 0 ? <div className="mt-1 line-clamp-2 text-[10px] text-slate-500">{sanitizeSnippet(results[0]?.snippet ?? results[0]?.content ?? '')}</div> : null}
    </div>
  );
}

function KnowledgeResourceTable({
  rows,
  selectedRowId,
  loading,
  error,
  viewMode,
  onSelect,
}: {
  rows: KnowledgeResourceRow[];
  selectedRowId: string;
  loading: boolean;
  error: unknown;
  viewMode: 'list' | 'grid';
  onSelect: (row: KnowledgeResourceRow) => void;
}): JSX.Element {
  if (viewMode === 'grid') {
    return (
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        <KnowledgeResourceStates rows={rows} loading={loading} error={error} mobile />
        {rows.map((row) => (
          <button key={row.id} type="button" className={['min-w-0 rounded border bg-white p-3 text-left transition-colors hover:border-blue-200 hover:bg-blue-50/20', row.id === selectedRowId ? 'border-blue-200 bg-blue-50/50' : 'border-slate-200'].join(' ')} onClick={() => onSelect(row)}>
            <ResourceCell row={row} />
            <div className="mt-3 flex items-center justify-between gap-2">
              <span className={`knowledge-table-pill ${row.statusPillClassName}`}>{row.statusLabel}</span>
              <span className="font-mono text-[11px] text-slate-500">{row.pagesLabel}</span>
            </div>
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="knowledge-table-wrap">
      <table className="w-full table-fixed text-left text-[12px]">
        <thead>
          <tr>
            <th className="w-10 px-4 py-2.5">
              <input className="h-3.5 w-3.5 rounded border-slate-300 text-[#004AC6]" type="checkbox" aria-label="选择全部资源" />
            </th>
            <th className="py-2.5">资源信息</th>
            <th className="w-20 px-3 py-2.5">类型</th>
            <th className="w-20 px-3 py-2.5">状态</th>
            <th className="w-20 px-3 py-2.5">大小</th>
            <th className="w-32 px-3 py-2.5">更新时间</th>
            <th className="w-32 px-3 py-2.5">标签</th>
            <th className="w-10 px-4" />
          </tr>
        </thead>
        <tbody>
          <KnowledgeResourceStates rows={rows} loading={loading} error={error} />
          {rows.map((row) => {
            const selected = row.id === selectedRowId;
            return (
              <tr key={row.id} className={selected ? 'is-selected' : ''} onClick={() => onSelect(row)}>
                <td className="px-4 py-2.5">
                  <input checked={selected} readOnly className="h-3.5 w-3.5 rounded border-slate-300 text-[#004AC6]" type="checkbox" aria-label={`选择 ${row.title}`} />
                </td>
                <td className="py-2.5"><ResourceCell row={row} /></td>
                <td className="px-3 py-2.5"><span className={`knowledge-table-pill ${row.typePillClassName}`}>{row.typeLabel}</span></td>
                <td className="px-3 py-2.5"><span className={`knowledge-table-pill ${row.statusPillClassName}`}>{row.statusLabel}</span></td>
                <td className="px-3 py-2.5 text-slate-600">{row.sizeLabel}</td>
                <td className="px-3 py-2.5 text-slate-600">{row.updatedAt}</td>
                <td className="px-3 py-2.5">
                  <div className="flex min-w-0 gap-1">
                    {row.tags.slice(0, 2).map((tag) => <span key={tag} className="truncate rounded bg-slate-100 px-1 py-0.5 text-[9px] text-slate-600">{tag}</span>)}
                  </div>
                </td>
                <td className="px-4 py-2.5 text-slate-500"><MoreVertical className="h-3 w-3" strokeWidth={2.2} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="knowledge-mobile-list">
        <KnowledgeResourceStates rows={rows} loading={loading} error={error} mobile />
        {rows.map((row) => (
          <button key={row.id} type="button" className={['knowledge-mobile-card', row.id === selectedRowId ? 'is-selected' : ''].join(' ')} onClick={() => onSelect(row)}>
            <span className="knowledge-mobile-card__title">{row.title}</span>
            <span className="knowledge-mobile-card__meta">{row.typeLabel} · {row.statusLabel} · {row.sizeLabel}</span>
            <span className="knowledge-mobile-card__meta">{row.tags.slice(0, 3).join(' · ') || '暂无标签'}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function KnowledgeResourceStates({ rows, loading, error, mobile = false }: { rows: KnowledgeResourceRow[]; loading: boolean; error: unknown; mobile?: boolean }): JSX.Element | null {
  const className = mobile ? 'block px-4 py-6 text-center text-[12px]' : 'px-4 py-6 text-center text-[12px]';
  if (error && rows.length === 0) {
    const content = <span className="text-rose-600">知识库加载失败：{error instanceof Error ? error.message : '未知错误'}</span>;
    return mobile ? <div className={className}>{content}</div> : <tr><td colSpan={8} className={className}>{content}</td></tr>;
  }
  if (!error && loading) {
    const content = <span className="text-slate-500">加载知识资源中...</span>;
    return mobile ? <div className={className}>{content}</div> : <tr><td colSpan={8} className={className}>{content}</td></tr>;
  }
  if (!error && !loading && rows.length === 0) {
    const content = <span className="text-slate-500">没有匹配的知识资源</span>;
    return mobile ? <div className={className}>{content}</div> : <tr><td colSpan={8} className={className}>{content}</td></tr>;
  }
  return null;
}

function ResourceCell({ row }: { row: KnowledgeResourceRow }): JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded border text-[16px] shadow-sm ${row.iconClassName}`}>
        <row.icon className="h-4 w-4" strokeWidth={2} />
      </span>
      <span className="min-w-0">
        <span className="block max-w-full truncate text-left font-bold text-slate-800">{row.title}</span>
        <span className="block truncate text-[10px] text-slate-500">{row.subtitle}</span>
      </span>
    </div>
  );
}

function KnowledgePagination({ total }: { total: number }): JSX.Element {
  return (
    <div className="knowledge-pagination">
      <div className="text-[11px] font-medium text-slate-500">共 {formatCount(total)} 项</div>
      <div className="text-[11px] text-slate-500">当前最多显示 500 项</div>
    </div>
  );
}

function KnowledgeDetailsPanel({
  row,
  detail,
  extraction,
  chunks,
  rankingResults,
  activeTab,
  actionPending,
  metadataDraft,
  metadataSaving,
  onTabChange,
  onClose,
  onPreview,
  onCopyReference,
  onToggleDisabled,
  onReprocess,
  onMetadataDraftChange,
  onSaveMetadata,
  onDelete,
}: {
  row: KnowledgeResourceRow | null;
  detail?: KnowledgeSourceDetail;
  extraction?: KnowledgeExtraction;
  chunks: KnowledgeChunk[];
  rankingResults: KnowledgeSearchResult[];
  activeTab: DetailTab;
  actionPending: boolean;
  metadataDraft: Record<KnowledgeFactField, string>;
  metadataSaving: boolean;
  onTabChange: (tab: DetailTab) => void;
  onClose: () => void;
  onPreview: () => void;
  onCopyReference: (source: KnowledgeSource) => void;
  onToggleDisabled: (source: KnowledgeSource) => void;
  onReprocess: (sourceId: string) => void;
  onMetadataDraftChange: (field: KnowledgeFactField, value: string) => void;
  onSaveMetadata: (sourceId: string) => void;
  onDelete: (sourceId: string) => void;
}): JSX.Element {
  const source = detail ?? row?.source ?? null;
  const previewFile = detail ? knowledgeDetailToPreviewFile(detail) : null;

  return (
    <aside className="knowledge-details">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-slate-200 p-3">
        <h2 className="text-[14px] font-bold text-slate-800">资源详情</h2>
        <button type="button" className="text-slate-500 hover:text-slate-700" aria-label="关闭资源详情" onClick={onClose}>
          <X className="h-3.5 w-3.5" strokeWidth={2.2} />
        </button>
      </div>

      {row && source ? (
        <>
          <div className="knowledge-details__body knowledge-scrollbar">
            <div className="flex items-start gap-3">
              <span className={`flex h-14 w-10 shrink-0 items-center justify-center rounded border text-[20px] shadow-sm ${row.iconClassName}`}>
                <row.icon className="h-5 w-5" strokeWidth={2} />
              </span>
              <div className="min-w-0">
                <h3 className="truncate text-[13px] font-bold leading-tight text-slate-950">{row.title}</h3>
                <div className="mt-1 space-y-0.5 text-[10px] leading-relaxed text-slate-500">
                  <div>{row.typeLabel} · {row.sizeLabel} · {row.compactUpdatedAt}</div>
                  <div className="truncate">{row.subtitle}</div>
                </div>
              </div>
            </div>

            <div className="knowledge-detail-tabs">
              {DETAIL_TABS.map((tab) => (
                <button key={tab.value} type="button" className={activeTab === tab.value ? 'is-active' : ''} onClick={() => onTabChange(tab.value)}>
                  {tab.label}
                </button>
              ))}
            </div>

            <KnowledgeDetailTabContent
              tab={activeTab}
              row={row}
              source={source}
              detail={detail}
              extraction={extraction}
              chunks={chunks}
              rankingResults={rankingResults}
              previewFile={previewFile}
              metadataDraft={metadataDraft}
              metadataSaving={metadataSaving}
              onMetadataDraftChange={onMetadataDraftChange}
              onSaveMetadata={onSaveMetadata}
            />
          </div>

          <div className="mt-auto flex shrink-0 flex-wrap gap-2 border-t border-slate-200 bg-white p-2.5">
            <button type="button" className="knowledge-detail-primary" disabled={!previewFile || !detail?.capabilities?.preview} onClick={onPreview}>
              <Eye className="h-2.5 w-2.5" strokeWidth={2.2} />
              预览
            </button>
            <a className="knowledge-detail-secondary" href={detail?.original_file?.url || undefined} download={detail?.original_file?.name} aria-disabled={!detail?.capabilities?.download} tabIndex={detail?.capabilities?.download ? undefined : -1} onClick={(event) => { if (!detail?.capabilities?.download) event.preventDefault(); }}>
              <Download className="h-2.5 w-2.5" strokeWidth={2.2} />
              下载
            </a>
            <button type="button" className="knowledge-detail-secondary" disabled={actionPending} onClick={() => onCopyReference(source)}>
              <Link2 className="h-2.5 w-2.5" strokeWidth={2.2} />
              引用
            </button>
            <button type="button" className="knowledge-detail-secondary" disabled={actionPending} onClick={() => onToggleDisabled(source)}>
              <Link2 className="h-2.5 w-2.5" strokeWidth={2.2} />
              {source.status === 'disabled' ? '恢复检索' : '禁用检索'}
            </button>
            <button type="button" className="knowledge-detail-secondary" disabled={actionPending || !detail?.capabilities?.reprocess} onClick={() => onReprocess(source.id)}>
              <RefreshCcw className="h-2.5 w-2.5" strokeWidth={2.2} />
              重新处理
            </button>
            <button type="button" className="knowledge-detail-more is-danger" disabled={actionPending} aria-label="删除知识资源" onClick={() => onDelete(source.id)}>
              <Trash2 className="h-2.5 w-2.5" strokeWidth={2.2} />
            </button>
          </div>
        </>
      ) : (
        <div className="knowledge-details__body knowledge-scrollbar">
          <div className="rounded border border-dashed border-slate-200 bg-slate-50 p-4 text-[12px] leading-5 text-slate-500">
            选择一条知识资源查看解析、chunks 和引用信息。
          </div>
        </div>
      )}
    </aside>
  );
}

function KnowledgeDetailTabContent({
  tab,
  row,
  source,
  detail,
  extraction,
  chunks,
  rankingResults,
  previewFile,
  metadataDraft,
  metadataSaving,
  onMetadataDraftChange,
  onSaveMetadata,
}: {
  tab: DetailTab;
  row: KnowledgeResourceRow;
  source: KnowledgeSource;
  detail?: KnowledgeSourceDetail;
  extraction?: KnowledgeExtraction;
  chunks: KnowledgeChunk[];
  rankingResults: KnowledgeSearchResult[];
  previewFile: ProjectFile | null;
  metadataDraft: Record<KnowledgeFactField, string>;
  metadataSaving: boolean;
  onMetadataDraftChange: (field: KnowledgeFactField, value: string) => void;
  onSaveMetadata: (sourceId: string) => void;
}): JSX.Element {
  if (tab === 'extraction') {
    return (
      <DetailSection title="解析文本">
        {extraction ? (
          <>
            <div className="mb-2 flex items-center justify-between text-[10px] text-slate-500">
              <span>{formatCount(extraction.returned_char_count)} / {formatCount(extraction.original_char_count)} chars</span>
              <span>{extraction.truncated ? '已截断' : '完整返回'}</span>
            </div>
            <pre className="knowledge-detail-pre">{extraction.markdown || extraction.plain_text}</pre>
          </>
        ) : <EmptyDetailText text="暂无 extraction 记录。" />}
      </DetailSection>
    );
  }

  if (tab === 'chunks') {
    return (
      <DetailSection title="Chunks">
        {chunks.length > 0 ? (
          <div className="space-y-2">
            {chunks.map((chunk) => (
              <div key={chunk.id} className="rounded border border-slate-200 bg-white p-2">
                <div className="mb-1 flex items-center justify-between gap-2 text-[10px] text-slate-500">
                  <span className="font-mono">#{chunk.chunk_index} · {chunk.chunk_type}</span>
                  <span>{chunk.enabled ? 'enabled' : 'disabled'}</span>
                </div>
                {chunk.heading ? <div className="mb-1 text-[11px] font-bold text-slate-700">{chunk.heading}</div> : null}
                <p className="line-clamp-5 whitespace-pre-wrap text-[11px] leading-5 text-slate-600">{chunk.content}</p>
              </div>
            ))}
          </div>
        ) : <EmptyDetailText text="暂无 chunk 记录。" />}
      </DetailSection>
    );
  }

  if (tab === 'summary') {
    return <DetailSection title="摘要"><p className="whitespace-pre-wrap text-[12px] leading-5 text-slate-600">{source.summary || '暂无摘要。'}</p></DetailSection>;
  }

  if (tab === 'preview') {
    return (
      <DetailSection title="原始资源">
        {previewFile ? (
          <div className="space-y-1.5 text-[11px]">
            <DetailRow label="文件名" value={previewFile.original_name} />
            <DetailRow label="类型" value={previewFile.source_type} />
            <DetailRow label="URL" value={previewFile.url || '(none)'} />
          </div>
        ) : <EmptyDetailText text="该资源没有可预览的原始文件。" />}
      </DetailSection>
    );
  }

  if (tab === 'refs') {
    return (
      <DetailSection title="引用">
        <div className="grid grid-cols-3 gap-1 text-center">
          <DetailCounter label="引用" value={source.reference_count ?? 0} />
          <DetailCounter label="Chunks" value={source.chunk_count ?? 0} />
          <DetailCounter label="Extraction" value={detail?.latest_extraction_id ? 1 : 0} />
        </div>
        <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-2 font-mono text-[11px] text-slate-600">knowledge:{source.id}</div>
      </DetailSection>
    );
  }

  return (
    <>
      <div className="rounded-lg bg-slate-50 p-3">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-[11px] font-bold uppercase tracking-tighter text-slate-700">处理状态</span>
          <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${source.status === 'ready' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>{row.statusLabel}</span>
        </div>
        <div className="relative flex items-center justify-between px-2">
          <div className="absolute left-4 right-4 top-1/2 z-0 h-0.5 -translate-y-1/2 bg-green-200" />
          {[[CloudUpload, '上传'], [Zap, '解析'], [Sparkles, '摘要'], [Check, '索引']].map(([Icon, label]) => (
            <div key={label as string} className="relative z-10 flex flex-col items-center gap-1">
              <span className={`flex h-5 w-5 items-center justify-center rounded-full ${source.status === 'failed' ? 'bg-slate-300' : 'bg-green-500'} text-white`}>
                <Icon className="h-2.5 w-2.5" strokeWidth={2.2} />
              </span>
              <span className="text-[8px] font-bold text-slate-600">{label as string}</span>
            </div>
          ))}
        </div>
      </div>

      <DetailSection title="资源信息">
        <div className="space-y-1.5 text-[11px]">
          <DetailRow label="文件名" value={row.fileName} />
          <DetailRow label="大小" value={row.sizeLabel} />
          <DetailRow label="Chunks" value={row.pagesLabel} />
          <DetailRow label="更新时间" value={row.compactUpdatedAt} mono />
          <DetailRow label="Parser" value={source.parser ?? '(none)'} mono />
          <DetailRow label="解析状态" value={formatParserStatus(source.metadata?.parser_status)} />
          <DetailRow label="Sidecar" value={source.metadata?.requires_sidecar ? '需要' : '不需要'} />
        </div>
      </DetailSection>

      <ParserWarnings metadata={source.metadata ?? null} />

      <KnowledgeRankingSignals results={rankingResults} />

      <KnowledgeGovernanceEditor
        sourceId={source.id}
        draft={metadataDraft}
        saving={metadataSaving}
        onChange={onMetadataDraftChange}
        onSave={onSaveMetadata}
      />

      <DetailSection title="标签">
        <div className="flex flex-wrap gap-1">
          {row.tags.length > 0 ? row.tags.map((tag) => <span key={tag} className="rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium text-slate-600">{tag}</span>) : <EmptyDetailText text="暂无标签。" />}
        </div>
      </DetailSection>
    </>
  );
}

function DetailSection({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <div className="space-y-2">
      <h4 className="text-[11px] font-bold uppercase tracking-tight text-slate-700">{title}</h4>
      {children}
    </div>
  );
}

function DetailRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): JSX.Element {
  return (
    <div className="flex">
      <span className="w-16 shrink-0 text-slate-500">{label}</span>
      <span className={`min-w-0 flex-1 truncate text-slate-800 ${mono ? 'font-mono' : ''}`} title={value}>{value}</span>
    </div>
  );
}

function EmptyDetailText({ text }: { text: string }): JSX.Element {
  return <p className="text-[12px] leading-5 text-slate-500">{text}</p>;
}

function DetailCounter({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div>
      <div className="text-[8px] font-bold uppercase text-slate-500">{label}</div>
      <div className="text-[14px] font-black text-slate-800">{formatCount(value)}</div>
    </div>
  );
}

function ParserWarnings({ metadata }: { metadata: KnowledgeSource['metadata'] | null }): JSX.Element | null {
  const warnings = Array.isArray(metadata?.parser_warnings)
    ? metadata.parser_warnings.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  if (warnings.length === 0) return null;
  return (
    <DetailSection title="解析提示">
      <div className="space-y-1">
        {warnings.map((warning) => (
          <div key={warning} className="rounded border border-amber-100 bg-amber-50 px-2 py-1 text-[11px] leading-5 text-amber-800">
            {warning}
          </div>
        ))}
      </div>
    </DetailSection>
  );
}

function KnowledgeRankingSignals({ results }: { results: KnowledgeSearchResult[] }): JSX.Element | null {
  const ranking = results.find((result) => result.ranking)?.ranking;
  if (!ranking) return null;
  return (
    <DetailSection title="Ranking">
      <div className="knowledge-ranking-grid">
        <RankingChip label="final" value={ranking.finalScore} />
        <RankingChip label="keyword" value={ranking.keywordScore} />
        <RankingChip label="vector" value={ranking.vectorScore} />
        <RankingChip label="recency" value={ranking.recencyBoost} />
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {ranking.titleMatch ? <span className="knowledge-ranking-flag">title</span> : null}
        {ranking.tagMatch ? <span className="knowledge-ranking-flag">tag</span> : null}
        {ranking.summaryMatch ? <span className="knowledge-ranking-flag">summary</span> : null}
      </div>
    </DetailSection>
  );
}

function RankingChip({ label, value }: { label: string; value: number | undefined }): JSX.Element {
  return (
    <span className="knowledge-ranking-chip">
      <small>{label}</small>
      <strong>{formatRankingValue(value)}</strong>
    </span>
  );
}

function KnowledgeGovernanceEditor({
  sourceId,
  draft,
  saving,
  onChange,
  onSave,
}: {
  sourceId: string;
  draft: Record<KnowledgeFactField, string>;
  saving: boolean;
  onChange: (field: KnowledgeFactField, value: string) => void;
  onSave: (sourceId: string) => void;
}): JSX.Element {
  return (
    <DetailSection title="知识沉淀">
      <div className="knowledge-governance-grid">
        {KNOWLEDGE_FACT_FIELDS.map((field) => (
          <label key={field.key} className="knowledge-governance-field">
            <span>{field.label}</span>
            <textarea
              value={draft[field.key]}
              rows={2}
              placeholder={field.placeholder}
              onChange={(event) => onChange(field.key, event.target.value)}
            />
          </label>
        ))}
      </div>
      <button type="button" className="knowledge-governance-save" disabled={saving} onClick={() => onSave(sourceId)}>
        {saving ? '保存中' : '保存沉淀'}
      </button>
    </DetailSection>
  );
}

function createKnowledgeRow(source: KnowledgeSource): KnowledgeResourceRow {
  const typeProfile = getTypeProfile(source);
  const statusProfile = getStatusProfile(source.status);
  const updatedAt = formatKnowledgeDateTime(source.updated_at);
  const compactUpdatedAt = formatKnowledgeCompactDateTime(source.updated_at);
  const tags = source.tags && source.tags.length > 0 ? source.tags : [];

  return {
    id: source.id,
    title: source.title,
    subtitle: `项目：${source.project_name ?? source.project_id} | 房间：${source.room_name ?? source.room_id ?? '未归档'}`,
    fileName: getKnowledgeFileName(source),
    typeLabel: typeProfile.label,
    status: source.status,
    statusLabel: statusProfile.label,
    sizeLabel: formatKnowledgeSize(source.size),
    updatedAt,
    compactUpdatedAt,
    tags,
    icon: typeProfile.icon,
    iconClassName: typeProfile.iconClassName,
    typePillClassName: typeProfile.typePillClassName,
    statusPillClassName: statusProfile.statusPillClassName,
    progress: getProcessingProgress(source.status),
    pagesLabel: `${source.chunk_count ?? 0} chunks`,
    source,
  };
}

function getTypeProfile(source: KnowledgeSource): { label: string; icon: IconComponent; iconClassName: string; typePillClassName: string } {
  const title = source.title.toLowerCase();
  const mime = source.mime_type?.toLowerCase() ?? '';
  if (mime.includes('pdf') || title.endsWith('.pdf')) return { label: 'PDF', icon: FileText, iconClassName: 'bg-red-50 border-red-100 text-red-500', typePillClassName: 'bg-red-50 text-red-500 border-red-100' };
  if (mime.includes('spreadsheet') || title.endsWith('.xlsx') || title.endsWith('.csv')) return { label: '表格', icon: FileSpreadsheet, iconClassName: 'bg-green-50 border-green-100 text-green-500', typePillClassName: 'bg-green-50 text-green-500 border-green-100' };
  if (mime.includes('image')) return { label: '图片', icon: ImageIcon, iconClassName: 'bg-purple-50 border-purple-100 text-purple-500', typePillClassName: 'bg-purple-50 text-purple-500 border-purple-100' };
  if (source.source_type === 'workspace_doc' || title.endsWith('.ts') || title.endsWith('.tsx')) return { label: '代码', icon: Code2, iconClassName: 'bg-slate-50 border-slate-200 text-slate-600', typePillClassName: 'bg-slate-50 text-slate-600 border-slate-200' };
  return { label: getKnowledgeSourceTypeDisplay(source.source_type, 'zh').label, icon: FileText, iconClassName: 'bg-blue-50 border-blue-100 text-blue-500', typePillClassName: 'bg-blue-50 text-blue-500 border-blue-100' };
}

function getStatusProfile(status: KnowledgeSourceStatus): { label: string; statusPillClassName: string } {
  switch (status) {
    case 'ready':
      return { label: '已完成', statusPillClassName: 'bg-green-50 text-green-700 border-green-100' };
    case 'processing':
      return { label: '处理中', statusPillClassName: 'bg-blue-50 text-blue-600 border-blue-100' };
    case 'pending':
      return { label: '待处理', statusPillClassName: 'bg-orange-50 text-orange-600 border-orange-100' };
    case 'failed':
      return { label: '失败', statusPillClassName: 'bg-red-50 text-red-600 border-red-100' };
    case 'stale':
      return { label: '已过期', statusPillClassName: 'bg-amber-50 text-amber-700 border-amber-100' };
    case 'disabled':
      return { label: '已禁用', statusPillClassName: 'bg-slate-100 text-slate-600 border-slate-200' };
    default:
      return { label: '未知', statusPillClassName: 'bg-slate-100 text-slate-600 border-slate-200' };
  }
}

function getSidebarTypeIcon(sourceType: KnowledgeSourceType): IconComponent {
  switch (sourceType) {
    case 'uploaded_file':
      return FileText;
    case 'resource_asset':
      return ImageIcon;
    case 'workspace_file':
      return FileSpreadsheet;
    case 'workspace_doc':
      return Code2;
    default:
      return FileText;
  }
}

function getProcessingProgress(status: KnowledgeSourceStatus): number | undefined {
  if (status === 'processing') return 60;
  if (status === 'pending') return 20;
  return undefined;
}

function getKnowledgeFileName(source: KnowledgeSource): string {
  const metadataName = typeof source.metadata?.file_name === 'string' ? source.metadata.file_name : '';
  if (metadataName) return metadataName;
  if (source.title.includes('/')) return source.title.split('/').at(-1) ?? source.title;
  return source.title;
}

function formatKnowledgeDateTime(value: number | null | undefined): string {
  const date = coerceDate(value);
  if (!date) return '未记录';
  return `${date.getFullYear()}-${padDate(date.getMonth() + 1)}-${padDate(date.getDate())} ${padDate(date.getHours())}:${padDate(date.getMinutes())}`;
}

function formatKnowledgeCompactDateTime(value: number | null | undefined): string {
  const date = coerceDate(value);
  if (!date) return '未记录';
  return `${padDate(date.getMonth() + 1)}-${padDate(date.getDate())} ${padDate(date.getHours())}:${padDate(date.getMinutes())}`;
}

function coerceDate(value: number | null | undefined): Date | null {
  if (!value) return null;
  const timestamp = value < 10_000_000_000 ? value * 1000 : value;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
}

function padDate(value: number): string {
  return String(value).padStart(2, '0');
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatPercent(value: number, total: number): string {
  return ((value / total) * 100).toFixed(1);
}

function formatPercentNumber(value: number, total: number): number {
  return Math.max(0, Math.min(100, Number(formatPercent(value, total))));
}

function sanitizeSnippet(value: string): string {
  return value.replace(/<\/?mark>/g, '').trim();
}

function parseTagInput(value: string): string[] | undefined {
  const tags = value
    .split(/[,\n，]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12);
  return tags.length > 0 ? tags : undefined;
}

function parseMultilineInput(value: string): string[] {
  return value
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildMetadataDraft(metadata: KnowledgeSource['metadata'] | null | undefined): Record<KnowledgeFactField, string> {
  return Object.fromEntries(KNOWLEDGE_FACT_FIELDS.map((field) => [
    field.key,
    Array.isArray(metadata?.[field.key])
      ? (metadata[field.key] as unknown[]).filter((item): item is string => typeof item === 'string').join('\n')
      : '',
  ])) as Record<KnowledgeFactField, string>;
}

function buildMetadataPatch(draft: Record<KnowledgeFactField, string>): KnowledgeMetadataPatch {
  return Object.fromEntries(KNOWLEDGE_FACT_FIELDS.map((field) => [
    field.key,
    parseMultilineInput(draft[field.key]),
  ])) as KnowledgeMetadataPatch;
}

function formatParserStatus(value: unknown): string {
  switch (value) {
    case 'complete':
      return 'complete';
    case 'partial':
      return 'partial';
    case 'metadata_only':
      return 'metadata_only';
    case 'requires_sidecar':
      return 'requires_sidecar';
    case 'failed':
      return 'failed';
    default:
      return '(none)';
  }
}

function formatRankingValue(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '0';
  return value.toFixed(value >= 10 ? 1 : 3).replace(/\.?0+$/, '');
}

async function copyKnowledgeReference(source: KnowledgeSource): Promise<void> {
  await navigator.clipboard.writeText(`knowledge:${source.id}`);
  toast.success('已复制知识引用 ID', { description: `knowledge:${source.id}` });
}

function knowledgeDetailToPreviewFile(detail: KnowledgeSourceDetail): ProjectFile | null {
  const file = detail.original_file;
  if (!file) return null;
  const sourceType: ResourceType = file.source_type === 'agent_document'
    ? 'agent_document'
    : file.source_type === 'uploaded_file'
      ? 'uploaded_file'
      : 'unknown';
  return {
    id: file.id,
    project_id: detail.project_id,
    source_type: sourceType,
    original_name: file.name,
    stored_name: file.name,
    mime_type: detail.mime_type ?? 'application/octet-stream',
    size: detail.size ?? 0,
    url: file.url,
    storage_path: file.storage_path,
    uploaded_by_id: null,
    uploaded_by_name: null,
    source_message_id: null,
    source_room_id: detail.room_id ?? null,
    source_agent_id: null,
    source_task_id: null,
    content: null,
    created_at: detail.created_at ?? Date.now(),
    deleted_at: null,
    reference_count: detail.reference_count ?? 0,
    last_referenced_at: null,
    last_referenced_message_id: null,
    last_referenced_room_id: detail.room_id ?? null,
    last_referenced_room_name: detail.room_name ?? null,
  };
}

async function invalidateKnowledgeQueries(queryClient: ReturnType<typeof useQueryClient>, projectId: string): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['knowledge-sources'] }),
    queryClient.invalidateQueries({ queryKey: ['knowledge-source'] }),
    queryClient.invalidateQueries({ queryKey: ['knowledge-extraction'] }),
    queryClient.invalidateQueries({ queryKey: ['knowledge-chunks'] }),
    queryClient.invalidateQueries({ queryKey: ['knowledge-search'] }),
    queryClient.invalidateQueries({ queryKey: ['knowledge-insights'] }),
    queryClient.invalidateQueries({ queryKey: ['files'] }),
    queryClient.invalidateQueries({ queryKey: ['project-files', projectId] }),
  ]);
}

function exportKnowledgeRows(rows: KnowledgeResourceRow[]): void {
  const header = ['title', 'type', 'status', 'size', 'updated_at', 'tags', 'source_id'];
  const body = rows.map((row) => [
    row.title,
    row.typeLabel,
    row.statusLabel,
    row.sizeLabel,
    row.updatedAt,
    row.tags.join('|'),
    row.source.id,
  ]);
  const csv = [header, ...body]
    .map((line) => line.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(','))
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `knowledge-sources-${Date.now()}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
