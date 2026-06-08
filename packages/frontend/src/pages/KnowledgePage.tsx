import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  Check,
  ChevronDown,
  Clock3,
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
  MoreHorizontal,
  MoreVertical,
  Plus,
  Presentation,
  RefreshCcw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Star,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import {
  filterKnowledgeSources,
  formatKnowledgeSize,
  getKnowledgeSourceTypeDisplay,
  sortKnowledgeSourcesByStatus,
  summarizeKnowledgeStats,
  type KnowledgeSource,
  type KnowledgeSourceFilters,
  type KnowledgeSourceType,
  type KnowledgeSourceStatus,
} from '../lib/knowledgeDisplay';

type IconComponent = LucideIcon;

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
  favorite?: boolean;
  pagesLabel: string;
  source?: KnowledgeSource;
}

const FALLBACK_STATS: KnowledgeDashboardStats = {
  total: 1248,
  ready: 1028,
  processing: 128,
  pending: 64,
  failed: 28,
  chunks: 8742,
  totalSize: 128_600_000_000,
};

const FALLBACK_ROWS: KnowledgeResourceRow[] = [
  {
    id: 'stitch-prd-v23',
    title: 'Ocean Platform 产品需求文档 v2.3',
    subtitle: '项目：Ocean Platform | 房间：产品组',
    fileName: 'PRD_v2.3.pdf',
    typeLabel: 'PDF',
    status: 'ready',
    statusLabel: '已完成',
    sizeLabel: '4.2 MB',
    updatedAt: '2025-06-07 14:30',
    compactUpdatedAt: '06-07 14:30',
    tags: ['产品', 'PRD'],
    icon: FileText,
    iconClassName: 'bg-red-50 border-red-100 text-red-500',
    typePillClassName: 'bg-red-50 text-red-500 border-red-100',
    statusPillClassName: 'bg-green-50 text-green-600 border-green-100',
    favorite: true,
    pagesLabel: '45 页',
  },
  {
    id: 'stitch-growth-report',
    title: '用户增长策略分析报告',
    subtitle: '项目：Ocean Platform | 房间：增长组',
    fileName: 'growth_strategy_report.docx',
    typeLabel: '文档',
    status: 'ready',
    statusLabel: '已完成',
    sizeLabel: '2.8 MB',
    updatedAt: '2025-06-07 11:20',
    compactUpdatedAt: '06-07 11:20',
    tags: ['分析', '增长'],
    icon: FileText,
    iconClassName: 'bg-blue-50 border-blue-100 text-blue-500',
    typePillClassName: 'bg-blue-50 text-blue-500 border-blue-100',
    statusPillClassName: 'bg-green-50 text-green-600 border-green-100',
    pagesLabel: '28 页',
  },
  {
    id: 'stitch-competitor-sheet',
    title: '竞品功能对比表.xlsx',
    subtitle: '项目：Ocean Platform | 房间：产品组',
    fileName: 'competitor_matrix.xlsx',
    typeLabel: '表格',
    status: 'processing',
    statusLabel: '处理中',
    sizeLabel: '856 KB',
    updatedAt: '2025-06-06 15:30',
    compactUpdatedAt: '06-06 15:30',
    tags: ['对比'],
    icon: FileSpreadsheet,
    iconClassName: 'bg-green-50 border-green-100 text-green-500',
    typePillClassName: 'bg-green-50 text-green-500 border-green-100',
    statusPillClassName: 'bg-blue-50 text-blue-500 border-blue-100',
    progress: 60,
    pagesLabel: '12 Sheet',
  },
];

const SOURCE_TYPE_FILTERS: Array<{ value: KnowledgeSourceType | ''; label: string }> = [
  { value: '', label: '全部' },
  { value: 'agent_document', label: '文档' },
  { value: 'uploaded_file', label: 'PDF' },
  { value: 'workspace_file', label: '表格' },
  { value: 'resource_asset', label: '图片' },
  { value: 'workspace_doc', label: '代码' },
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

export function KnowledgePage(): JSX.Element {
  const { projectId = '' } = useParams();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { locale, t } = useI18n();
  const [filters, setFilters] = useState<KnowledgeSourceFilters>(() => ({ projectId }));
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');

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

  const liveStats = useMemo(() => summarizeKnowledgeStats(
    filterKnowledgeSources(summarySources, {
      projectId: selectedProjectId,
      roomId: activeRoomId,
    }, locale),
  ), [activeRoomId, locale, selectedProjectId, summarySources]);

  const dashboardStats = useMemo<KnowledgeDashboardStats>(() => {
    if (summarySources.length === 0) return FALLBACK_STATS;
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
  }, [liveStats, summarySources.length]);

  const selectedProject = useMemo(
    () => projects.find((item) => item.id === selectedProjectId) ?? project ?? null,
    [project, projects, selectedProjectId],
  );
  const selectedRoom = useMemo(
    () => rooms.find((item) => item.id === activeRoomId) ?? null,
    [activeRoomId, rooms],
  );

  const rows = useMemo(() => {
    const liveRows = visibleSources.map(createKnowledgeRow);
    const hasActiveSearchFilter = Boolean(
      (filters.keyword ?? '').trim() ||
      filters.sourceType ||
      filters.status,
    );
    const shouldShowFallback = !hasActiveSearchFilter && !sourcesLoading && !sourcesIsError && sources.length === 0;
    const baseRows = shouldShowFallback ? FALLBACK_ROWS : liveRows;
    const keyword = (filters.keyword ?? '').trim().toLowerCase();
    if (!keyword) return baseRows;
    return baseRows.filter((row) => [
      row.title,
      row.subtitle,
      row.fileName,
      row.typeLabel,
      row.statusLabel,
      ...row.tags,
    ].some((value) => value.toLowerCase().includes(keyword)));
  }, [filters.keyword, sources.length, sourcesIsError, sourcesLoading, visibleSources]);

  const selectedRow = rows.find((row) => row.id === selectedSourceId) ?? rows[0] ?? null;
  const pathLabel = selectedProject
    ? `${selectedProject.name} · ${selectedProject.path}`
    : '所有项目 · Ocean Platform';

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
      toast.success('文件已上传', {
        description: `已上传 ${uploaded.length} 个文件，知识库索引会自动更新。`,
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
          selectedProjectLabel={pathLabel}
          selectedRoomLabel={selectedRoom?.name ?? ''}
          uploadPending={upload.isPending}
          onUpload={() => fileInputRef.current?.click()}
          onFiltersChange={replaceFilters}
          onPatchFilters={patchFilters}
        />

        <main className="knowledge-main knowledge-scrollbar">
          <div className="flex min-h-0 flex-1 flex-col p-4">
            <div className="mb-4 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <h1 className="m-0 text-[18px] font-bold leading-tight text-slate-950">全部资源</h1>
                <p className="mt-0.5 text-[11px] text-slate-400">管理和检索项目中的所有知识资源</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <div className="knowledge-action-group">
                  <button type="button">
                    批量操作
                    <ChevronDown className="h-2 w-2 text-slate-400" strokeWidth={2.4} />
                  </button>
                  <button type="button" onClick={() => void refetchSources()}>
                    <RefreshCcw className="h-3 w-3 text-slate-400" strokeWidth={2} />
                    重处理
                  </button>
                  <button type="button">
                    <FileOutput className="h-3 w-3 text-slate-400" strokeWidth={2} />
                    导出清单
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

            <div className="mb-3 space-y-2">
              <label className="knowledge-resource-search">
                <Search className="h-3 w-3 text-slate-400" strokeWidth={2.1} />
                <input
                  value={filters.keyword ?? ''}
                  onChange={(event) => setFilters((current) => ({ ...current, keyword: event.target.value }))}
                  placeholder="搜索文件名、内容、标签、摘要..."
                  aria-label="搜索知识资源"
                />
                <SlidersHorizontal className="h-3 w-3 cursor-pointer text-slate-400" strokeWidth={2.1} />
              </label>
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2 text-[11px]">
                  <FilterSelect
                    label="项目"
                    value={selectedProjectId}
                    options={[
                      { value: '', label: '全部' },
                      ...projects.map((item) => ({ value: item.id, label: item.name })),
                    ]}
                    onChange={(value) => replaceFilters({ ...activeFilters, projectId: value, roomId: '' })}
                  />
                  <FilterSelect
                    label="房间"
                    value={activeRoomId}
                    options={[
                      { value: '', label: '全部' },
                      ...rooms.map((room) => ({ value: room.id, label: room.name })),
                    ]}
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
                <button type="button" className="knowledge-sort-button">
                  最新上传
                  <ChevronDown className="h-2 w-2 text-slate-400" strokeWidth={2.4} />
                </button>
              </div>
            </div>

            <KnowledgeResourceTable
              rows={rows}
              selectedRowId={selectedRow?.id ?? ''}
              loading={sourcesLoading && rows.length === 0}
              error={sourcesIsError ? sourcesError : null}
              onSelect={(row) => setSelectedSourceId(row.id)}
            />
          </div>

          <KnowledgePagination total={dashboardStats.total} />
        </main>

        <KnowledgeDetailsPanel row={selectedRow} />
      </div>
    </div>
  );
}

function KnowledgeSidebar({
  stats,
  filters,
  selectedProjectLabel,
  selectedRoomLabel,
  uploadPending,
  onUpload,
  onFiltersChange,
  onPatchFilters,
}: {
  stats: KnowledgeDashboardStats;
  filters: KnowledgeSourceFilters;
  selectedProjectLabel: string;
  selectedRoomLabel: string;
  uploadPending: boolean;
  onUpload: () => void;
  onFiltersChange: (filters: KnowledgeSourceFilters) => void;
  onPatchFilters: (filters: KnowledgeSourceFilters) => void;
}): JSX.Element {
  return (
    <aside className="knowledge-sidebar knowledge-scrollbar">
      <div className="p-3">
        <h2 className="mb-3 text-[16px] font-bold text-slate-950">知识库</h2>
        <button
          type="button"
          className="knowledge-upload-button"
          disabled={uploadPending}
          onClick={onUpload}
        >
          <Plus className="h-3 w-3" strokeWidth={2.5} />
          {uploadPending ? '上传中' : '上传资源'}
        </button>
      </div>

      <div className="space-y-0.5 px-2">
        <SidebarPrimaryItem icon={FolderOpen} label="全部资源" count={formatCount(stats.total)} active onClick={() => onFiltersChange({ projectId: filters.projectId ?? '' })} />
        <SidebarPrimaryItem icon={Star} label="我的收藏" count="56" />
        <SidebarPrimaryItem icon={Clock3} label="最近使用" count={formatCount(Math.max(stats.processing, 128))} />
        <SidebarPrimaryItem icon={Trash2} label="回收站" count="8" />
      </div>

      <SidebarSection title="资源类型">
        <SidebarPrimaryItem icon={FileText} label="文档" count="528" compact onClick={() => onPatchFilters({ sourceType: 'agent_document' })} />
        <SidebarPrimaryItem icon={ImageIcon} label="图片" count="312" compact onClick={() => onPatchFilters({ sourceType: 'resource_asset' })} />
        <SidebarPrimaryItem icon={FileText} label="PDF" count="186" compact onClick={() => onPatchFilters({ sourceType: 'uploaded_file' })} />
        <SidebarPrimaryItem icon={FileSpreadsheet} label="表格" count="94" compact onClick={() => onPatchFilters({ sourceType: 'workspace_file' })} />
        <SidebarPrimaryItem icon={Presentation} label="演示" count="64" compact />
        <SidebarPrimaryItem icon={Code2} label="代码" count="34" compact onClick={() => onPatchFilters({ sourceType: 'workspace_doc' })} />
      </SidebarSection>

      <SidebarSection title="处理状态">
        <StatusSidebarItem colorClassName="bg-slate-300" label="全部" count={formatCount(stats.total)} onClick={() => onPatchFilters({ status: '' })} />
        <StatusSidebarItem colorClassName="bg-green-500" label="已完成" count={formatCount(stats.ready)} onClick={() => onPatchFilters({ status: 'ready' })} />
        <StatusSidebarItem colorClassName="bg-blue-500" label="处理中" count={formatCount(stats.processing)} onClick={() => onPatchFilters({ status: 'processing' })} />
      </SidebarSection>

      <div className="mt-auto border-t border-slate-200 bg-slate-50 p-4">
        <div className="mb-1.5 flex items-center justify-between text-[10px] font-bold uppercase text-slate-500">
          <span>存储空间</span>
          <Database className="h-3 w-3 text-slate-300" strokeWidth={2.2} />
        </div>
        <div className="mb-1.5 flex justify-between text-[11px]">
          <span className="font-medium text-slate-700">128.6 GB <span className="text-slate-400">/ 500 GB</span></span>
        </div>
        <div className="h-1 w-full overflow-hidden rounded-full bg-slate-200">
          <div className="h-full bg-[#004AC6]" style={{ width: '25%' }} />
        </div>
        <div className="mt-1 text-right text-[9px] text-slate-400">已使用 25%</div>
        <div className="mt-3 truncate text-[9px] leading-4 text-slate-400">{selectedProjectLabel}{selectedRoomLabel ? ` · ${selectedRoomLabel}` : ''}</div>
      </div>
    </aside>
  );
}

function SidebarSection({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <div className="mt-4">
      <div className="flex cursor-pointer items-center justify-between px-5 py-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
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
      className={[
        'knowledge-sidebar-item',
        active ? 'is-active' : '',
        compact ? 'is-compact' : '',
      ].filter(Boolean).join(' ')}
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
    {
      label: '资源总数',
      value: formatCount(stats.total),
      sub: stats.total === FALLBACK_STATS.total ? '较上周 +128' : `${formatCount(stats.chunks)} chunks`,
      tone: 'text-green-500',
      icon: FileText,
      iconNodeClassName: 'bg-blue-50 text-[#004AC6]',
    },
    {
      label: '已完成处理',
      value: formatCount(stats.ready),
      sub: `${formatPercent(stats.ready, total)}%`,
      tone: 'text-green-500',
      progress: 88,
      icon: Check,
      iconNodeClassName: 'text-green-500',
    },
    {
      label: '处理中',
      value: formatCount(stats.processing),
      sub: `${formatPercent(stats.processing, total)}%`,
      tone: 'text-blue-500',
      progress: 25,
      spin: true,
    },
    {
      label: '待处理',
      value: formatCount(stats.pending),
      sub: `${formatPercent(stats.pending, total)}%`,
      tone: 'text-orange-500',
      icon: Hourglass,
      iconNodeClassName: 'border-2 border-orange-200 bg-orange-50 text-orange-400',
    },
    {
      label: '处理失败',
      value: formatCount(stats.failed),
      sub: `${formatPercent(stats.failed, total)}%`,
      tone: 'text-red-500',
      icon: AlertCircle,
      iconNodeClassName: 'rounded-full border-2 border-red-100 bg-red-50 text-red-500',
    },
  ];

  return (
    <div className="mb-5 grid grid-cols-5 gap-3">
      {metrics.map((metric) => (
        <div key={metric.label} className="knowledge-stat-card">
          <div>
            <div className="mb-0.5 text-[10px] font-bold text-slate-500">{metric.label}</div>
            <div className="text-[20px] font-black leading-none text-slate-800">{metric.value}</div>
            <div className={`mt-1 text-[9px] font-bold ${metric.tone}`}>{metric.sub}</div>
          </div>
          {metric.progress ? (
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
      <span className="shrink-0 text-slate-400">{label}:</span>
      <label className="knowledge-filter-button">
        <select
          value={value}
          disabled={disabled}
          aria-label={`${label}筛选`}
          onChange={(event) => onChange(event.target.value)}
        >
          {options.map((option) => (
            <option key={`${label}-${option.value}`} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown className="h-2 w-2 shrink-0 text-slate-400" strokeWidth={2.4} />
      </label>
    </div>
  );
}

function KnowledgeResourceTable({
  rows,
  selectedRowId,
  loading,
  error,
  onSelect,
}: {
  rows: KnowledgeResourceRow[];
  selectedRowId: string;
  loading: boolean;
  error: unknown;
  onSelect: (row: KnowledgeResourceRow) => void;
}): JSX.Element {
  return (
    <div className="knowledge-table-wrap">
      <table className="w-full table-fixed text-left text-[12px]">
        <thead>
          <tr>
            <th className="w-10 px-4 py-2.5">
              <input className="h-3.5 w-3.5 rounded border-slate-300 text-[#004AC6]" type="checkbox" aria-label="选择全部资源" />
            </th>
            <th className="py-2.5">资源信息</th>
            <th className="w-16 px-3 py-2.5">类型</th>
            <th className="w-20 px-3 py-2.5">状态</th>
            <th className="w-20 px-3 py-2.5">大小</th>
            <th className="w-32 px-3 py-2.5">更新时间</th>
            <th className="w-32 px-3 py-2.5">标签</th>
            <th className="w-10 px-4" />
          </tr>
        </thead>
        <tbody>
          {error && rows.length === 0 ? (
            <tr>
              <td colSpan={8} className="px-4 py-6 text-center text-[12px] text-rose-500">
                知识库加载失败：{error instanceof Error ? error.message : '未知错误'}
              </td>
            </tr>
          ) : null}
          {!error && loading ? (
            <tr>
              <td colSpan={8} className="px-4 py-6 text-center text-[12px] text-slate-400">加载知识资源中...</td>
            </tr>
          ) : null}
          {!error && !loading && rows.length === 0 ? (
            <tr>
              <td colSpan={8} className="px-4 py-6 text-center text-[12px] text-slate-400">没有匹配的知识资源</td>
            </tr>
          ) : null}
          {rows.map((row) => {
            const selected = row.id === selectedRowId;
            return (
              <tr
                key={row.id}
                className={selected ? 'is-selected' : ''}
                onClick={() => onSelect(row)}
              >
                <td className="px-4 py-2.5">
                  <input
                    checked={selected}
                    readOnly
                    className="h-3.5 w-3.5 rounded border-slate-300 text-[#004AC6]"
                    type="checkbox"
                    aria-label={`选择 ${row.title}`}
                  />
                </td>
                <td className="py-2.5">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded border text-[16px] shadow-sm ${row.iconClassName}`}>
                      <row.icon className="h-4 w-4" strokeWidth={2} />
                    </span>
                    <span className="min-w-0">
                      <button type="button" className="block max-w-full truncate text-left font-bold text-slate-800">{row.title}</button>
                      <span className="block truncate text-[10px] text-slate-400">{row.subtitle}</span>
                    </span>
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  <span className={`knowledge-table-pill ${row.typePillClassName}`}>{row.typeLabel}</span>
                </td>
                <td className="px-3 py-2.5">
                  {row.progress ? (
                    <span className="flex w-16 flex-col gap-1">
                      <span className={`knowledge-table-pill text-center ${row.statusPillClassName}`}>{row.statusLabel}</span>
                      <span className="h-0.5 w-full overflow-hidden rounded-full bg-slate-100">
                        <i className="block h-full bg-blue-500" style={{ width: `${row.progress}%` }} />
                      </span>
                    </span>
                  ) : (
                    <span className={`knowledge-table-pill ${row.statusPillClassName}`}>{row.statusLabel}</span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-slate-500">{row.sizeLabel}</td>
                <td className="px-3 py-2.5 text-slate-500">{row.updatedAt}</td>
                <td className="px-3 py-2.5">
                  <div className="flex min-w-0 gap-1">
                    {row.tags.slice(0, 2).map((tag) => (
                      <span key={tag} className="truncate rounded bg-slate-100 px-1 py-0.5 text-[9px] text-slate-500">{tag}</span>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-2.5 text-slate-400">
                  <div className="flex items-center gap-2">
                    {row.favorite ? <Star className="h-3 w-3 fill-orange-400 text-orange-400" strokeWidth={1.8} /> : null}
                    <MoreVertical className="h-3 w-3" strokeWidth={2.2} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function KnowledgePagination({ total }: { total: number }): JSX.Element {
  return (
    <div className="knowledge-pagination">
      <div className="text-[11px] font-medium text-slate-400">共 {formatCount(total)} 项</div>
      <div className="flex items-center gap-3">
        <div className="knowledge-page-buttons">
          <button type="button" disabled>‹</button>
          <button type="button" className="is-active">1</button>
          <button type="button">2</button>
          <button type="button">3</button>
          <button type="button">4</button>
          <span>...</span>
          <button type="button">125</button>
          <button type="button">›</button>
        </div>
        <select className="rounded border-slate-200 py-0.5 pl-2 pr-6 text-[11px] focus:ring-blue-500" aria-label="分页条数">
          <option>10 条/页</option>
          <option>20 条/页</option>
        </select>
      </div>
    </div>
  );
}

function KnowledgeDetailsPanel({ row }: { row: KnowledgeResourceRow | null }): JSX.Element {
  const displayRow = row ?? FALLBACK_ROWS[0];
  const details = [
    ['文件名', displayRow.fileName],
    ['大小', displayRow.sizeLabel],
    ['页数', displayRow.pagesLabel],
    ['更新时间', displayRow.compactUpdatedAt],
  ];

  return (
    <aside className="knowledge-details">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-slate-200 p-3">
        <h2 className="text-[14px] font-bold text-slate-800">资源详情</h2>
        <button type="button" className="text-slate-400 hover:text-slate-600" aria-label="关闭资源详情">
          <X className="h-3.5 w-3.5" strokeWidth={2.2} />
        </button>
      </div>

      <div className="knowledge-details__body knowledge-scrollbar">
        <div className="flex items-start gap-3">
          <span className={`flex h-14 w-10 shrink-0 items-center justify-center rounded border text-[20px] shadow-sm ${displayRow.iconClassName}`}>
            <displayRow.icon className="h-5 w-5" strokeWidth={2} />
          </span>
          <div className="min-w-0">
            <div className="mb-0.5 flex items-center gap-1.5">
              <h3 className="truncate text-[13px] font-bold leading-tight text-slate-950">{displayRow.title}</h3>
              {displayRow.favorite ? <Star className="h-2.5 w-2.5 shrink-0 fill-orange-400 text-orange-400" strokeWidth={1.8} /> : null}
            </div>
            <div className="space-y-0.5 text-[10px] leading-relaxed text-slate-400">
              <div>{displayRow.typeLabel} · {displayRow.sizeLabel} · 2025-06-07</div>
              <div className="truncate">{displayRow.subtitle}</div>
            </div>
          </div>
        </div>

        <div className="knowledge-detail-tabs">
          {['概览', '预览', '解析', '摘要', '引用'].map((tab, index) => (
            <button key={tab} type="button" className={index === 0 ? 'is-active' : ''}>{tab}</button>
          ))}
        </div>

        <div className="rounded-lg bg-slate-50 p-3">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-tighter text-slate-700">处理状态</span>
            <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${displayRow.status === 'ready' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>
              {displayRow.statusLabel}
            </span>
          </div>
          <div className="relative flex items-center justify-between px-2">
            <div className="absolute left-4 right-4 top-1/2 z-0 h-0.5 -translate-y-1/2 bg-green-200" />
            {[
              [CloudUpload, '上传'],
              [Zap, '解析'],
              [Sparkles, '摘要'],
              [Check, '索引'],
            ].map(([Icon, label]) => (
              <div key={label as string} className="relative z-10 flex flex-col items-center gap-1">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-green-500 text-white">
                  <Icon className="h-2.5 w-2.5" strokeWidth={2.2} />
                </span>
                <span className="text-[8px] font-bold text-slate-500">{label as string}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <h4 className="text-[11px] font-bold uppercase tracking-tight text-slate-700">资源信息</h4>
          <div className="space-y-1.5 text-[11px]">
            {details.map(([label, value]) => (
              <div key={label} className="flex">
                <span className="w-16 shrink-0 text-slate-400">{label}</span>
                <span className={`min-w-0 flex-1 truncate text-slate-800 ${label === '更新时间' ? 'font-mono' : ''}`}>{value}</span>
              </div>
            ))}
          </div>
        </div>

        <div>
          <h4 className="mb-2 text-[11px] font-bold uppercase tracking-tight text-slate-700">标签</h4>
          <div className="flex flex-wrap gap-1">
            {Array.from(new Set([...displayRow.tags, '需求', 'PRD', '+3'])).slice(0, 4).map((tag) => (
              <span key={tag} className="rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium text-slate-500">{tag}</span>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-4 gap-1 border-t border-slate-200 pt-2 text-center">
          <DetailCounter label="引用" value={displayRow.source?.reference_count ?? 23} />
          <DetailCounter label="会话" value={12} />
          <DetailCounter label="任务" value={8} />
          <DetailCounter label="智体" value={5} />
        </div>
      </div>

      <div className="mt-auto flex shrink-0 flex-wrap gap-2 border-t border-slate-200 bg-white p-2.5">
        <button type="button" className="knowledge-detail-primary">
          <Eye className="h-2.5 w-2.5" strokeWidth={2.2} />
          预览
        </button>
        <button type="button" className="knowledge-detail-secondary">
          <Download className="h-2.5 w-2.5" strokeWidth={2.2} />
          下载
        </button>
        <div className="flex w-full gap-2">
          <button type="button" className="knowledge-detail-secondary">
            <Link2 className="h-2.5 w-2.5" strokeWidth={2.2} />
            引用
          </button>
          <button type="button" className="knowledge-detail-more" aria-label="更多资源操作">
            <MoreHorizontal className="h-2.5 w-2.5" strokeWidth={2.2} />
          </button>
        </div>
      </div>
    </aside>
  );
}

function DetailCounter({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div>
      <div className="text-[8px] font-bold uppercase text-slate-400">{label}</div>
      <div className="text-[14px] font-black text-slate-800">{value}</div>
    </div>
  );
}

function createKnowledgeRow(source: KnowledgeSource): KnowledgeResourceRow {
  const typeProfile = getTypeProfile(source);
  const statusProfile = getStatusProfile(source.status);
  const updatedAt = formatKnowledgeDateTime(source.updated_at);
  const compactUpdatedAt = formatKnowledgeCompactDateTime(source.updated_at);
  const tags = source.tags && source.tags.length > 0 ? source.tags : [typeProfile.label];

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
    progress: source.status === 'processing' ? 60 : undefined,
    favorite: (source.reference_count ?? 0) > 10,
    pagesLabel: source.chunk_count ? `${source.chunk_count} chunks` : '45 页',
    source,
  };
}

function getTypeProfile(source: KnowledgeSource): {
  label: string;
  icon: IconComponent;
  iconClassName: string;
  typePillClassName: string;
} {
  const title = source.title.toLowerCase();
  const mime = source.mime_type?.toLowerCase() ?? '';
  if (mime.includes('pdf') || title.endsWith('.pdf')) {
    return {
      label: 'PDF',
      icon: FileText,
      iconClassName: 'bg-red-50 border-red-100 text-red-500',
      typePillClassName: 'bg-red-50 text-red-500 border-red-100',
    };
  }
  if (mime.includes('spreadsheet') || title.endsWith('.xlsx') || title.endsWith('.csv')) {
    return {
      label: '表格',
      icon: FileSpreadsheet,
      iconClassName: 'bg-green-50 border-green-100 text-green-500',
      typePillClassName: 'bg-green-50 text-green-500 border-green-100',
    };
  }
  if (mime.includes('image')) {
    return {
      label: '图片',
      icon: ImageIcon,
      iconClassName: 'bg-purple-50 border-purple-100 text-purple-500',
      typePillClassName: 'bg-purple-50 text-purple-500 border-purple-100',
    };
  }
  if (source.source_type === 'workspace_doc' || title.endsWith('.ts') || title.endsWith('.tsx')) {
    return {
      label: '代码',
      icon: Code2,
      iconClassName: 'bg-slate-50 border-slate-200 text-slate-600',
      typePillClassName: 'bg-slate-50 text-slate-600 border-slate-200',
    };
  }
  return {
    label: getKnowledgeSourceTypeDisplay(source.source_type, 'zh').label.replace('上传文件', '文档'),
    icon: FileText,
    iconClassName: 'bg-blue-50 border-blue-100 text-blue-500',
    typePillClassName: 'bg-blue-50 text-blue-500 border-blue-100',
  };
}

function getStatusProfile(status: KnowledgeSourceStatus): {
  label: string;
  statusPillClassName: string;
} {
  switch (status) {
    case 'ready':
      return { label: '已完成', statusPillClassName: 'bg-green-50 text-green-600 border-green-100' };
    case 'processing':
      return { label: '处理中', statusPillClassName: 'bg-blue-50 text-blue-500 border-blue-100' };
    case 'pending':
      return { label: '待处理', statusPillClassName: 'bg-orange-50 text-orange-500 border-orange-100' };
    case 'failed':
      return { label: '失败', statusPillClassName: 'bg-red-50 text-red-500 border-red-100' };
    case 'stale':
      return { label: '已过期', statusPillClassName: 'bg-amber-50 text-amber-600 border-amber-100' };
    case 'disabled':
      return { label: '已禁用', statusPillClassName: 'bg-slate-100 text-slate-500 border-slate-200' };
    default:
      return { label: '未知', statusPillClassName: 'bg-slate-100 text-slate-500 border-slate-200' };
  }
}

function getStatusLabel(status: KnowledgeSourceStatus): string {
  return getStatusProfile(status).label;
}

function getKnowledgeFileName(source: KnowledgeSource): string {
  const metadataName = typeof source.metadata?.file_name === 'string' ? source.metadata.file_name : '';
  if (metadataName) return metadataName;
  if (source.title.includes('/')) return source.title.split('/').at(-1) ?? source.title;
  return source.title;
}

function formatKnowledgeDateTime(value: number | null | undefined): string {
  const date = coerceDate(value);
  if (!date) return '2025-06-07 14:30';
  return `${date.getFullYear()}-${padDate(date.getMonth() + 1)}-${padDate(date.getDate())} ${padDate(date.getHours())}:${padDate(date.getMinutes())}`;
}

function formatKnowledgeCompactDateTime(value: number | null | undefined): string {
  const date = coerceDate(value);
  if (!date) return '06-07 14:30';
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
