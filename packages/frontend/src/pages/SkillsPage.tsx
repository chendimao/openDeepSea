import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Database,
  Download,
  ExternalLink,
  FileCode2,
  GitBranch,
  Grid2X2,
  Layers3,
  Loader2,
  MoreVertical,
  PackagePlus,
  RefreshCcw,
  Search,
  Settings,
  Star,
  TerminalSquare,
  Trash2,
  User,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api } from '../lib/api';
import { TerminalPanel } from '../components/TerminalPanel';
import type {
  OnlineSkill,
  OnlineSkillView,
  PlatformSkill,
  PlatformSkillAggregate,
  PlatformSkillInstallMode,
  PlatformSkillProvider,
  PlatformSkillSummary,
} from '../lib/types';
import { cn } from '../lib/utils';
import './SkillsPage.css';

const PROVIDERS: PlatformSkillProvider[] = ['codex', 'claudecode', 'opencode'];

type MarketStatusFilter = 'all' | 'installed' | 'updates' | 'owned' | 'favorite';
type SourceFilter = PlatformSkillProvider | 'all';
type CategoryFilter = 'all' | 'system' | 'data' | 'dev' | 'design' | 'automation';

type SkillVisual = {
  category: Exclude<CategoryFilter, 'all'>;
  categoryLabel: string;
  tags: string[];
  accent: string;
  icon: LucideIcon;
  author: string;
  downloads: string;
  rating: string;
  updatedAt: string;
  official: boolean;
  favorite: boolean;
  owned: boolean;
  updateAvailable: boolean;
  actionState: 'installed' | 'install';
  detailDescription?: string;
  features: string[];
  permissions: string[];
  dependencies: string[];
  environments: string[];
};

type SkillRecord = {
  online: OnlineSkill;
  aggregate: PlatformSkillAggregate;
  visual: SkillVisual;
  installed: boolean;
  primaryProvider: PlatformSkillProvider;
  primarySkill: PlatformSkill | null;
};

const ONLINE_PAGE_SIZE = 30;

const FALLBACK_SKILLS: PlatformSkillAggregate[] = [
  createFallbackAggregate({
    name: 'file-system',
    displayName: 'file-system',
    description: '安全的文件系统操作，支持读取、写入、编辑和搜索文件',
    provider: 'claudecode',
    version: '2.3.1',
    installMode: 'copy',
    valid: true,
    lastModifiedAt: Date.parse('2025-06-01T08:00:00+08:00'),
  }),
  createFallbackAggregate({
    name: 'database-query',
    displayName: 'database-query',
    description: '执行数据库查询，支持多种数据库连接和操作',
    provider: 'codex',
    version: '1.8.0',
    installMode: 'unknown',
    valid: false,
    lastModifiedAt: Date.parse('2025-05-28T08:00:00+08:00'),
  }),
  createFallbackAggregate({
    name: 'git-operations',
    displayName: 'git-operations',
    description: 'Git 仓库操作，包括提交、分支管理、合并等',
    provider: 'opencode',
    version: '2.1.3',
    installMode: 'symlink',
    valid: true,
    lastModifiedAt: Date.parse('2025-05-30T08:00:00+08:00'),
  }),
];

const FALLBACK_METRICS = {
  total: 128,
  installed: 38,
  updates: 6,
  owned: 12,
  favorite: 8,
  issues: 0,
  providers: { codex: 46, claudecode: 42, opencode: 0 } satisfies Record<PlatformSkillProvider, number>,
  categories: { system: 12, data: 18, dev: 0, design: 0, automation: 0 } satisfies Record<Exclude<CategoryFilter, 'all'>, number>,
};

const SIDEBAR_PROVIDERS: PlatformSkillProvider[] = PROVIDERS;

const VISUAL_LIBRARY: Record<string, SkillVisual> = {
  'file-system': {
    category: 'system',
    categoryLabel: '文件操作',
    tags: ['文件操作'],
    accent: '#434654',
    icon: TerminalSquare,
    author: 'Anthropic',
    downloads: '12.4k',
    rating: '4.8',
    updatedAt: '2025-06-01',
    official: true,
    favorite: true,
    owned: false,
    updateAvailable: false,
    actionState: 'installed',
    detailDescription: '安全的文件系统操作，支持读取、写入、编辑和搜索文件。所有操作都在受控的工作目录内执行。',
    features: ['读取文件内容', '写入和编辑文件', '搜索文件和内容', '列出目录和文件', '支持多种编码格式'],
    permissions: ['读取文件', '写入文件', '创建目录', '删除文件'],
    dependencies: ['无外部依赖项'],
    environments: ['Claude Code', '桌面端', '服务器端'],
  },
  'database-query': {
    category: 'data',
    categoryLabel: '数据处理',
    tags: ['数据处理', '数据库'],
    accent: '#003594',
    icon: Database,
    author: 'OpenAI',
    downloads: '8.7k',
    rating: '4.6',
    updatedAt: '2025-05-28',
    official: true,
    favorite: false,
    owned: false,
    updateAvailable: true,
    actionState: 'install',
    features: ['执行参数化查询', '读取 schema 摘要', '导出查询结果', '限制危险写入', '记录查询证据'],
    permissions: ['读取数据库', '运行查询', '导出数据'],
    dependencies: ['sqlite3', 'pg'],
    environments: ['Codex', '本地工作区', '服务器端'],
  },
  'git-operations': {
    category: 'dev',
    categoryLabel: '开发工具',
    tags: ['开发工具', '版本控制'],
    accent: '#ff6b35',
    icon: GitBranch,
    author: 'OpenCode Team',
    downloads: '6.1k',
    rating: '4.7',
    updatedAt: '2025-05-30',
    official: true,
    favorite: false,
    owned: false,
    updateAvailable: false,
    actionState: 'install',
    features: ['查看工作区状态', '创建提交', '比较分支差异', '生成变更摘要', '检查冲突面'],
    permissions: ['读取 Git', '写入索引', '创建提交'],
    dependencies: ['git >= 2.40'],
    environments: ['OpenCode', 'Codex', '本地仓库'],
  },
  'frontend-design': {
    category: 'design',
    categoryLabel: '界面设计',
    tags: ['界面设计'],
    accent: '#7c3aed',
    icon: Layers3,
    author: 'OpenDeepSea',
    downloads: '4.9k',
    rating: '4.9',
    updatedAt: '2025-06-03',
    official: false,
    favorite: true,
    owned: true,
    updateAvailable: false,
    actionState: 'installed',
    features: ['页面结构规划', '视觉 token 对齐', '响应式检查', '截图回归', '可访问性审查'],
    permissions: ['读取源码', '写入前端文件', '启动浏览器'],
    dependencies: ['Playwright', 'Vite'],
    environments: ['Codex', 'React', '浏览器'],
  },
  'agent-browser': {
    category: 'automation',
    categoryLabel: '自动化',
    tags: ['自动化'],
    accent: '#0f766e',
    icon: Bot,
    author: 'OpenDeepSea',
    downloads: '3.8k',
    rating: '4.5',
    updatedAt: '2025-05-26',
    official: false,
    favorite: false,
    owned: true,
    updateAvailable: true,
    actionState: 'installed',
    features: ['打开网页', '填写表单', '截取屏幕', '抽取页面数据', '执行 smoke 检查'],
    permissions: ['启动浏览器', '访问网页', '保存截图'],
    dependencies: ['Playwright'],
    environments: ['Codex', 'Chromium', '本地调试'],
  },
};

const CATEGORY_LABELS: Record<CategoryFilter, string> = {
  all: '所有分类',
  system: '系统',
  data: '数据处理',
  dev: '开发工具',
  design: '界面设计',
  automation: '自动化',
};

const STATUS_LABELS: Record<MarketStatusFilter, string> = {
  all: '全部 Skills',
  installed: '已安装',
  updates: '可更新',
  owned: '我的 Skills',
  favorite: '收藏',
};

export function SkillsPage(): JSX.Element {
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<MarketStatusFilter>('all');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all');
  const [installedOnly, setInstalledOnly] = useState(false);
  const [onlineView, setOnlineView] = useState<OnlineSkillView>('all-time');
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [initialInstallCommand, setInitialInstallCommand] = useState<string | undefined>(undefined);
  const [installerOpen, setInstallerOpen] = useState(false);
  const trimmedSearchQuery = searchQuery.trim();

  const summariesQuery = useQuery({
    queryKey: ['platform-skills', 'platforms'],
    queryFn: api.listPlatformSkillSummaries,
  });
  const aggregatesQuery = useQuery({
    queryKey: ['platform-skills', 'aggregate'],
    queryFn: api.listPlatformSkillAggregates,
  });
  const onlineSkillsQuery = useQuery({
    queryKey: ['online-skills', trimmedSearchQuery ? 'search' : 'list', onlineView, trimmedSearchQuery, 0, ONLINE_PAGE_SIZE],
    queryFn: () => trimmedSearchQuery
      ? api.searchOnlineSkills({ q: trimmedSearchQuery, page: 0, limit: ONLINE_PAGE_SIZE })
      : api.listOnlineSkills({ view: onlineView, page: 0, limit: ONLINE_PAGE_SIZE }),
    retry: false,
  });
  const refreshPlatformSkills = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['platform-skills', 'platforms'] });
    void queryClient.invalidateQueries({ queryKey: ['platform-skills', 'aggregate'] });
    void queryClient.invalidateQueries({ queryKey: ['online-skills'] });
  }, [queryClient]);
  const refreshOnlineSkills = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['online-skills'] });
  }, [queryClient]);
  const summaries = summariesQuery.data ?? [];
  const aggregateByName = useMemo(() => {
    const byName = new Map<string, PlatformSkillAggregate>();
    for (const aggregate of aggregatesQuery.data ?? []) {
      byName.set(aggregate.name, aggregate);
      byName.set(aggregate.displayName, aggregate);
    }
    return byName;
  }, [aggregatesQuery.data]);
  const onlineSkills = onlineSkillsQuery.data?.skills ?? [];
  const records = useMemo(
    () => onlineSkills.map((skill) => toSkillRecord(skill, aggregateByName.get(skill.slug) ?? aggregateByName.get(skill.name))),
    [aggregateByName, onlineSkills],
  );
  const filteredRecords = useMemo(() => filterSkillRecords(records, {
    searchQuery,
    statusFilter,
    sourceFilter,
    categoryFilter,
    installedOnly,
  }), [categoryFilter, installedOnly, records, searchQuery, sourceFilter, statusFilter]);
  const selectedRecord = useMemo(
    () => filteredRecords.find((item) => item.online.id === selectedSkillId)
      ?? records.find((item) => item.online.id === selectedSkillId)
      ?? filteredRecords[0]
      ?? records[0]
      ?? null,
    [filteredRecords, records, selectedSkillId],
  );
  const liveMetrics = useMemo(() => getMetrics(records), [records]);
  const metrics = useMemo(() => ({
    ...liveMetrics,
    total: onlineSkillsQuery.data?.total ?? liveMetrics.total,
  }), [liveMetrics, onlineSkillsQuery.data?.total]);
  const loading = onlineSkillsQuery.isLoading && records.length === 0;
  const error = onlineSkillsQuery.error as Error | null;
  const openInstallerForRecord = useCallback((record?: SkillRecord | null) => {
    setInitialInstallCommand(record?.online.installCommand || undefined);
    setInstallerOpen(true);
  }, []);

  return (
    <div className="skills-command-center">
      <main className="skills-workspace">
        <SkillsSidebar
          activeStatus={statusFilter}
          metrics={metrics}
          sourceFilter={sourceFilter}
          categoryFilter={categoryFilter}
          summaries={summaries}
          onStatusChange={setStatusFilter}
          onSourceChange={setSourceFilter}
          onCategoryChange={setCategoryFilter}
          onOpenInstaller={() => openInstallerForRecord(selectedRecord)}
          onRefreshOnline={refreshOnlineSkills}
        />
        <SkillsMarketPanel
          records={filteredRecords}
          totalCount={metrics.total}
          loading={loading}
          error={error}
          selectedId={selectedRecord?.online.id ?? null}
          searchQuery={searchQuery}
          sourceFilter={sourceFilter}
          categoryFilter={categoryFilter}
          statusFilter={statusFilter}
          installedOnly={installedOnly}
          onlineView={onlineView}
          onSearchChange={setSearchQuery}
          onSourceChange={setSourceFilter}
          onCategoryChange={setCategoryFilter}
          onStatusChange={setStatusFilter}
          onInstalledOnlyChange={setInstalledOnly}
          onOnlineViewChange={setOnlineView}
          onSelect={setSelectedSkillId}
          onInstall={openInstallerForRecord}
        />
        <SkillDetailsPanel
          record={selectedRecord}
          summaries={summaries}
          onOpenInstaller={() => openInstallerForRecord(selectedRecord)}
        />
      </main>
      <SkillsStatusBar metrics={metrics} />
      {installerOpen ? (
        <SkillsInstallerDrawer
          initialInstallCommand={initialInstallCommand}
          onClose={() => setInstallerOpen(false)}
          onRefreshRequested={refreshPlatformSkills}
        />
      ) : null}
    </div>
  );
}

function SkillsSidebar({
  activeStatus,
  metrics,
  sourceFilter,
  categoryFilter,
  summaries,
  onStatusChange,
  onSourceChange,
  onCategoryChange,
  onOpenInstaller,
  onRefreshOnline,
}: {
  activeStatus: MarketStatusFilter;
  metrics: ReturnType<typeof getMetrics>;
  sourceFilter: SourceFilter;
  categoryFilter: CategoryFilter;
  summaries: PlatformSkillSummary[];
  onStatusChange: (status: MarketStatusFilter) => void;
  onSourceChange: (source: SourceFilter) => void;
  onCategoryChange: (category: CategoryFilter) => void;
  onOpenInstaller: () => void;
  onRefreshOnline: () => void;
}): JSX.Element {
  const sourceCounts = getSourceCounts(metrics, summaries);
  const categoryRows: Array<{ key: CategoryFilter; icon: LucideIcon; count: number }> = [
    { key: 'system', icon: Settings, count: metrics.categories.system },
    { key: 'data', icon: Database, count: metrics.categories.data },
  ];

  return (
    <aside className="skills-sidebar">
      <div className="skills-sidebar__scroll skills-scrollbar">
        <div className="skills-sidebar__head">
          <h2>Skills 管理</h2>
          <button type="button" aria-label="刷新在线 Skills" title="刷新在线 Skills" onClick={onRefreshOnline}>
            <RefreshCcw aria-hidden="true" />
          </button>
        </div>
        <button type="button" className="skills-install-button" onClick={onOpenInstaller}>
          <PackagePlus aria-hidden="true" />
          <span>安装终端</span>
          <TerminalSquare aria-hidden="true" />
        </button>
        <div className="skills-source-summary">
          <ExternalLink aria-hidden="true" />
          <span>
            <b>SkillsMP 在线源</b>
            <small>匿名 REST 搜索，无需认证配置</small>
          </span>
        </div>
        <nav className="skills-sidebar-nav" aria-label="Skills 状态">
          <SidebarButton icon={Layers3} label="全部 Skills" count={metrics.total} active={activeStatus === 'all'} onClick={() => onStatusChange('all')} />
          <SidebarButton icon={CheckCircle2} label="已安装" count={metrics.installed} active={activeStatus === 'installed'} onClick={() => onStatusChange('installed')} />
          <SidebarButton icon={RefreshCcw} label="可更新" count={metrics.updates} danger active={activeStatus === 'updates'} onClick={() => onStatusChange('updates')} />
          <SidebarButton icon={User} label="我的 Skills" count={metrics.owned} active={activeStatus === 'owned'} onClick={() => onStatusChange('owned')} />
          <SidebarButton icon={Star} label="收藏" count={metrics.favorite} active={activeStatus === 'favorite'} onClick={() => onStatusChange('favorite')} />
        </nav>
        <SidebarSection title="来源">
          {SIDEBAR_PROVIDERS.map((provider) => (
            <SidebarButton
              key={provider}
              icon={providerIcon(provider)}
              label={providerLabel(provider)}
              count={sourceCounts[provider]}
              active={sourceFilter === provider}
              onClick={() => onSourceChange(sourceFilter === provider ? 'all' : provider)}
            />
          ))}
        </SidebarSection>
        <SidebarSection title="分类">
          {categoryRows.map((item) => (
            <SidebarButton
              key={item.key}
              icon={item.icon}
              label={CATEGORY_LABELS[item.key]}
              count={item.count}
              active={categoryFilter === item.key}
              onClick={() => onCategoryChange(categoryFilter === item.key ? 'all' : item.key)}
            />
          ))}
        </SidebarSection>
      </div>
      <div className="skills-market-entry">
        <p>Skills 市场</p>
        <span>发现和安装更多优质 Skills</span>
        <button type="button">浏览市场 <ExternalLink aria-hidden="true" /></button>
      </div>
    </aside>
  );
}

function SkillsMarketPanel({
  records,
  totalCount,
  loading,
  error,
  selectedId,
  searchQuery,
  sourceFilter,
  categoryFilter,
  statusFilter,
  installedOnly,
  onlineView,
  onSearchChange,
  onSourceChange,
  onCategoryChange,
  onStatusChange,
  onInstalledOnlyChange,
  onOnlineViewChange,
  onSelect,
  onInstall,
}: {
  records: SkillRecord[];
  totalCount: number;
  loading: boolean;
  error: Error | null;
  selectedId: string | null;
  searchQuery: string;
  sourceFilter: SourceFilter;
  categoryFilter: CategoryFilter;
  statusFilter: MarketStatusFilter;
  installedOnly: boolean;
  onlineView: OnlineSkillView;
  onSearchChange: (value: string) => void;
  onSourceChange: (value: SourceFilter) => void;
  onCategoryChange: (value: CategoryFilter) => void;
  onStatusChange: (value: MarketStatusFilter) => void;
  onInstalledOnlyChange: (value: boolean) => void;
  onOnlineViewChange: (value: OnlineSkillView) => void;
  onSelect: (id: string) => void;
  onInstall: (record: SkillRecord) => void;
}): JSX.Element {
  return (
    <section className="skills-market-panel">
      <div className="skills-filterbar">
        <div className="skills-filterbar__left">
          <label className="skills-panel-search">
            <Search aria-hidden="true" />
            <input
              value={searchQuery}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="搜索 skills 名称、描述、作者..."
              aria-label="搜索 skills 名称、描述、作者"
            />
          </label>
          <DenseSelect label="所有来源" value={sourceFilter} onChange={(value) => onSourceChange(value as SourceFilter)}>
            <option value="all">所有来源</option>
            {PROVIDERS.map((provider) => <option key={provider} value={provider}>{providerLabel(provider)}</option>)}
          </DenseSelect>
          <DenseSelect label="所有分类" value={categoryFilter} onChange={(value) => onCategoryChange(value as CategoryFilter)}>
            {Object.entries(CATEGORY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </DenseSelect>
          <DenseSelect label="所有状态" value={statusFilter} onChange={(value) => onStatusChange(value as MarketStatusFilter)}>
            {Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </DenseSelect>
          <DenseSelect label="在线排序" value={onlineView} onChange={(value) => onOnlineViewChange(value as OnlineSkillView)}>
            <option value="all-time">Stars</option>
            <option value="trending">最近更新</option>
            <option value="hot">高星热度</option>
          </DenseSelect>
        </div>
        <div className="skills-filterbar__right">
          <label className="skills-switch-row">
            <span>仅显示已安装</span>
            <button
              type="button"
              role="switch"
              aria-checked={installedOnly}
              className="skills-switch"
              onClick={() => onInstalledOnlyChange(!installedOnly)}
            >
              <span />
            </button>
          </label>
          <span className="skills-filter-separator" />
          <DenseSelect label="推荐排序" value="recommended" onChange={() => undefined}>
            <option value="recommended">推荐排序</option>
            <option value="updated">最近更新</option>
            <option value="downloads">安装量</option>
          </DenseSelect>
          <button type="button" className="skills-grid-button" aria-label="网格视图"><Grid2X2 aria-hidden="true" /></button>
        </div>
      </div>
      <div className="skills-list skills-scrollbar">
        {loading ? <StateBox icon={Loader2} label="正在加载在线 skills" spinning /> : null}
        {error && records.length === 0 ? (
          <SkillsOnlineErrorState message={error.message} />
        ) : null}
        {!loading && !error && records.length === 0 ? <StateBox icon={Search} label="没有找到匹配的 Skills" /> : null}
        {records.length > 0 ? (
          <div className="skills-list__inner">
            {records.map((record) => (
              <SkillListItem
                key={record.online.id}
                record={record}
                selected={selectedId === record.online.id}
                onSelect={() => onSelect(record.online.id)}
                onInstall={() => onInstall(record)}
              />
            ))}
          </div>
        ) : null}
      </div>
      <SkillsPagination shown={records.length} total={totalCount} />
    </section>
  );
}

function SkillsOnlineErrorState({
  message,
}: {
  message: string;
}): JSX.Element {
  return (
    <div className="skills-online-error">
      <AlertTriangle aria-hidden="true" />
      <span>
        <b>{message}</b>
        <small>请检查网络连接，或稍后重试 SkillsMP 匿名搜索限流。</small>
      </span>
    </div>
  );
}

function SkillListItem({
  record,
  selected,
  onSelect,
  onInstall,
}: {
  record: SkillRecord;
  selected: boolean;
  onSelect: () => void;
  onInstall: () => void;
}): JSX.Element {
  const Icon = record.visual.icon;
  return (
    <div
      className={cn('skills-list-item', selected && 'is-selected')}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <span className="skills-list-item__icon" style={{ backgroundColor: record.visual.accent }}><Icon aria-hidden="true" /></span>
      <span className="skills-list-item__body">
        <span className="skills-list-item__titleline">
          <b>{record.aggregate.displayName}</b>
          <span className="skills-mono">{record.online.sourceType ?? 'online'}</span>
          {record.visual.official ? <span className="skills-official"><CheckCircle2 aria-hidden="true" />官方</span> : null}
        </span>
        <span className="skills-list-item__description">{record.aggregate.description ?? record.aggregate.name}</span>
        <span className="skills-tags">
          {record.visual.tags.slice(0, 2).map((tag) => <span key={tag}>{tag}</span>)}
          {!record.aggregate.valid ? <span className="is-warn">需要处理</span> : null}
        </span>
      </span>
      <span className="skills-list-item__meta">
        <MetricCell label="来源" value={providerLabel(record.primaryProvider)} provider={record.primaryProvider} />
        <MetricCell label="作者" value={record.visual.author} />
        <MetricCell label="热度" value={record.visual.downloads} mono />
        <MetricCell label="更新于" value={record.visual.updatedAt} mono />
      </span>
      <span className="skills-list-item__action">
        {record.visual.actionState === 'installed' ? (
          <span className="skills-installed-button"><Check aria-hidden="true" />已安装</span>
        ) : (
          <button
            type="button"
            className="skills-primary-button"
            disabled={!record.online.installCommand}
            onClick={(event) => {
              event.stopPropagation();
              onInstall();
            }}
          >
            终端安装
          </button>
        )}
        <MoreVertical aria-hidden="true" />
      </span>
    </div>
  );
}

function SkillDetailsPanel({
  record,
  summaries,
  onOpenInstaller,
}: {
  record: SkillRecord | null;
  summaries: PlatformSkillSummary[];
  onOpenInstaller: () => void;
}): JSX.Element {
  if (!record) {
    return <aside className="skills-detail-panel"><StateBox icon={Search} label="请选择一个 Skill" /></aside>;
  }

  const Icon = record.visual.icon;
  const sourceLabel = record.online.upstreamSource ?? record.online.sourceType ?? 'skillsmp.com';

  return (
    <aside className="skills-detail-panel">
      <div className="skills-detail-head">
        <button type="button" className="skills-detail-close" aria-label="关闭详情"><X aria-hidden="true" /></button>
        <div className="skills-detail-title">
          <span className="skills-detail-icon" style={{ backgroundColor: record.visual.accent }}><Icon aria-hidden="true" /></span>
          <span>
            <span className="skills-detail-name"><b>{record.aggregate.displayName}</b><small>{record.online.slug}</small></span>
            <span className="skills-detail-provider">
              <ProviderGlyph provider={record.primaryProvider} />
              <span>{sourceLabel}</span>
              <i>•</i>
              <span>{record.visual.author}</span>
            </span>
            <span className="skills-status-pill"><i />{record.installed ? '已安装' : '未安装'}</span>
          </span>
        </div>
        <div className="skills-detail-metrics">
          <DetailMetric label="热度" value={record.visual.downloads} />
          <DetailMetric label="评分" value={record.visual.rating} star />
          <DetailMetric label="更新于" value={record.visual.updatedAt} compact />
        </div>
        <p>{record.visual.detailDescription ?? record.aggregate.description ?? record.aggregate.name}</p>
        <div className="skills-detail-tags">
          <span>{record.visual.categoryLabel}</span>
          <span>{record.online.sourceType ?? 'online'}</span>
          <span>{record.online.auditStatus === 'available' ? '已审计' : '待审计'}</span>
        </div>
      </div>
      <div className="skills-detail-tabs">
        <button type="button" className="is-active">概览</button>
        <button type="button">功能</button>
        <button type="button">权限</button>
        <button type="button">配置</button>
        <button type="button">更新日志</button>
      </div>
      <div className="skills-detail-body skills-scrollbar">
        <DetailSection title="主要功能">
          <ul className="skills-check-list">
            {record.visual.features.map((feature) => <li key={feature}><CheckCircle2 aria-hidden="true" />{feature}</li>)}
          </ul>
        </DetailSection>
        <DetailSection title="权限要求">
          <div className="skills-permission-list">
            {record.visual.permissions.map((permission) => <span key={permission}><Check aria-hidden="true" />{permission}</span>)}
          </div>
        </DetailSection>
        <DetailSection title="支持的环境">
          <div className="skills-env-list">
            {getEnvironments(record, summaries).map((environment) => <span key={environment}>{environment}</span>)}
          </div>
        </DetailSection>
        <DetailSection title="依赖项">
          {record.visual.dependencies.length === 1 && record.visual.dependencies[0] === '无外部依赖项' ? (
            <p className="skills-detail-muted">无外部依赖项</p>
          ) : (
            <div className="skills-env-list">{record.visual.dependencies.map((item) => <span key={item}>{item}</span>)}</div>
          )}
        </DetailSection>
        <DetailSection title="安装证据">
          <div className="skills-evidence-list">
            {PROVIDERS.map((provider) => <InstallationEvidence key={provider} provider={provider} skill={record.aggregate.installations[provider]} />)}
          </div>
        </DetailSection>
      </div>
      <div className="skills-detail-footer">
        <div>
          <button type="button" disabled={!record.online.installCommand} onClick={onOpenInstaller}>终端安装</button>
          <button type="button" aria-label="删除 Skill"><Trash2 aria-hidden="true" /></button>
        </div>
        <p><CircleHelp aria-hidden="true" />遇到问题？<a href="#">查看文档 <ExternalLink aria-hidden="true" /></a></p>
      </div>
    </aside>
  );
}

function SkillsInstallerDrawer({
  initialInstallCommand,
  onClose,
  onRefreshRequested,
}: {
  initialInstallCommand?: string;
  onClose: () => void;
  onRefreshRequested: () => void;
}): JSX.Element {
  return (
    <div className="skills-terminal-backdrop" role="presentation">
      <aside className="skills-terminal-drawer" role="dialog" aria-modal="true" aria-label="Skills 安装终端">
        <TerminalPanel
          profile="skills_install"
          title="Skills 安装终端"
          initialInput={initialInstallCommand}
          className="skills-terminal-panel"
          onClose={onClose}
          onRefreshRequested={onRefreshRequested}
        />
      </aside>
    </div>
  );
}

function SkillsStatusBar({
  metrics,
}: {
  metrics: ReturnType<typeof getMetrics>;
}): JSX.Element {
  return (
    <footer className="skills-statusbar">
      <div>
        <span className="skills-health-dot" />
        <span>系统健康: 正常</span>
        <i />
        <span>延迟: <b>12ms</b></span>
        <span>错误率: <b>{metrics.issues > 0 ? '0.3%' : '0.0%'}</b></span>
      </div>
      <div>
        <span>在线源:</span>
        <b>skillsmp.com</b>
        <span className="skills-source-chip">匿名 REST</span>
        <span className="skills-source-meter"><i style={{ width: `${Math.min(100, Math.max(6, metrics.installed))}%` }} /></span>
        <b>{metrics.installed} 已安装</b>
        <button type="button"><Download aria-hidden="true" />导出</button>
      </div>
    </footer>
  );
}

function SidebarSection({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="skills-sidebar-section">
      <div><span>{title}</span><ChevronDown aria-hidden="true" /></div>
      <nav>{children}</nav>
    </section>
  );
}

function SidebarButton({
  icon: Icon,
  label,
  count,
  active,
  danger = false,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  count: number;
  active: boolean;
  danger?: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button type="button" className={cn('skills-sidebar-button', active && 'is-active')} onClick={onClick}>
      <span><Icon aria-hidden="true" />{label}</span>
      <b className={cn(danger && 'is-danger')}>{count}</b>
    </button>
  );
}

function DenseSelect({
  label,
  value,
  children,
  onChange,
}: {
  label: string;
  value: string;
  children: ReactNode;
  onChange: (value: string) => void;
}): JSX.Element {
  return (
    <label className="skills-select">
      <span className="sr-only">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>{children}</select>
    </label>
  );
}

function MetricCell({ label, value, provider, mono = false }: { label: string; value: string; provider?: PlatformSkillProvider; mono?: boolean }): JSX.Element {
  return (
    <span>
      <small>{label}</small>
      <b className={cn(mono && 'skills-mono')}>{provider ? <ProviderGlyph provider={provider} /> : null}{value}</b>
    </span>
  );
}

function ProviderGlyph({ provider }: { provider: PlatformSkillProvider }): JSX.Element {
  const Icon = providerIcon(provider);
  return <Icon aria-hidden="true" className={cn('skills-provider-glyph', `is-${provider}`)} />;
}

function DetailMetric({ label, value, star = false, compact = false }: { label: string; value: string; star?: boolean; compact?: boolean }): JSX.Element {
  return (
    <span>
      <small>{label}</small>
      <b className={cn('skills-mono', compact && 'is-compact')}>{value}{star ? <Star aria-hidden="true" /> : null}</b>
    </span>
  );
}

function DetailSection({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return <section className="skills-detail-section"><h4>{title}</h4>{children}</section>;
}

function InstallationEvidence({ provider, skill }: { provider: PlatformSkillProvider; skill?: PlatformSkill }): JSX.Element {
  return (
    <div className="skills-evidence-row">
      <span><ProviderGlyph provider={provider} />{providerLabel(provider)}</span>
      {skill ? (
        <b className={skill.valid ? 'is-valid' : 'is-invalid'}>{skill.valid ? '有效' : '异常'} · {installModeLabel(skill.installMode)}</b>
      ) : (
        <b>未安装</b>
      )}
    </div>
  );
}

function SkillsPagination({ shown, total }: { shown: number; total: number }): JSX.Element {
  return (
    <div className="skills-pagination">
      <span>共 <b className="skills-mono">{Math.max(total, shown)}</b> 个 Skills</span>
      <div>
        <button type="button" disabled aria-label="上一页"><ChevronLeft aria-hidden="true" /></button>
        <button type="button" className="is-active">1</button>
        <button type="button" disabled aria-label="下一页"><ChevronRight aria-hidden="true" /></button>
      </div>
      <select aria-label="每页数量" value={String(ONLINE_PAGE_SIZE)} onChange={() => undefined}>
        <option value={String(ONLINE_PAGE_SIZE)}>{ONLINE_PAGE_SIZE} 条/页</option>
      </select>
    </div>
  );
}

function StateBox({ icon: Icon, label, spinning = false }: { icon: LucideIcon; label: string; spinning?: boolean }): JSX.Element {
  return <div className="skills-state-box"><Icon className={spinning ? 'animate-spin' : undefined} aria-hidden="true" />{label}</div>;
}

function filterSkillRecords(records: SkillRecord[], filters: {
  searchQuery: string;
  statusFilter: MarketStatusFilter;
  sourceFilter: SourceFilter;
  categoryFilter: CategoryFilter;
  installedOnly: boolean;
}): SkillRecord[] {
  const query = filters.searchQuery.trim().toLowerCase();
  return records.filter((record) => {
    if (query) {
      const haystack = [
        record.aggregate.name,
        record.aggregate.displayName,
        record.aggregate.description ?? '',
        record.online.upstreamSource ?? '',
        record.visual.author,
        record.visual.categoryLabel,
        ...record.online.tags,
        ...record.aggregate.providers.map(providerLabel),
      ].join('\n').toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    if (filters.installedOnly && !record.installed) return false;
    if (filters.statusFilter === 'installed' && !record.installed) return false;
    if (filters.statusFilter === 'updates' && !record.visual.updateAvailable) return false;
    if (filters.statusFilter === 'owned' && !record.visual.owned) return false;
    if (filters.statusFilter === 'favorite' && !record.visual.favorite) return false;
    if (filters.sourceFilter !== 'all' && !record.aggregate.providers.includes(filters.sourceFilter)) return false;
    if (filters.categoryFilter !== 'all' && record.visual.category !== filters.categoryFilter) return false;
    return true;
  });
}

function toSkillRecord(online: OnlineSkill, localAggregate?: PlatformSkillAggregate): SkillRecord {
  const aggregate = localAggregate ?? createAggregateFromOnlineSkill(online);
  const primaryProvider = pickPrimaryProvider(aggregate);
  const primarySkill = aggregate.installations[primaryProvider] ?? null;
  const visual = getSkillVisual(online, aggregate, primaryProvider);
  return {
    online,
    aggregate,
    visual,
    installed: online.installedProviders.length > 0 || aggregate.providers.length > 0,
    primaryProvider,
    primarySkill,
  };
}

function getSkillVisual(online: OnlineSkill, aggregate: PlatformSkillAggregate, provider: PlatformSkillProvider): SkillVisual {
  const direct = VISUAL_LIBRARY[aggregate.name] ?? VISUAL_LIBRARY[aggregate.displayName];
  if (direct) {
    return {
      ...direct,
      author: online.author ?? direct.author,
      downloads: formatInstallCount(online.installs ?? online.stars) ?? direct.downloads,
      updatedAt: online.updatedAt ? formatDate(online.updatedAt) : direct.updatedAt,
      actionState: online.installedProviders.length > 0 ? 'installed' : 'install',
      tags: online.tags.length ? online.tags : direct.tags,
      environments: online.installedProviders.map(providerLabel),
    };
  }
  const category = inferCategory(aggregate);
  return {
    category,
    categoryLabel: CATEGORY_LABELS[category],
    tags: online.tags.length ? online.tags : [CATEGORY_LABELS[category]],
    accent: providerColor(provider),
    icon: inferIcon(category),
    author: online.author ?? online.upstreamSource ?? 'skillsmp.com',
    downloads: formatInstallCount(online.installs ?? online.stars) ?? '0',
    rating: online.stars === null ? '—' : String(online.stars),
    updatedAt: online.updatedAt ? formatDate(online.updatedAt) : '未知',
    official: online.sourceType === 'github' || online.upstreamSource?.includes('vercel') || aggregate.providers.length > 1,
    favorite: aggregate.name.length % 3 === 0,
    owned: Boolean(online.upstreamSource?.includes('opendeepsea') || aggregate.name.includes('superpowers') || aggregate.name.includes('design')),
    updateAvailable: false,
    actionState: online.installedProviders.length > 0 ? 'installed' : 'install',
    detailDescription: online.description ?? undefined,
    features: buildFeatureList(aggregate, category),
    permissions: buildPermissionList(category),
    dependencies: aggregate.installModes[provider] === 'symlink' ? ['本地软链接', '原始 skill 目录'] : ['通过 skills CLI 安装'],
    environments: online.installedProviders.map(providerLabel),
  };
}

function getMetrics(records: SkillRecord[]) {
  return records.reduce((acc, record) => {
    acc.total += 1;
    if (record.installed) acc.installed += 1;
    if (record.visual.updateAvailable) acc.updates += 1;
    if (record.visual.owned) acc.owned += 1;
    if (record.visual.favorite) acc.favorite += 1;
    if (!record.aggregate.valid || record.aggregate.issues.length > 0) acc.issues += 1;
    acc.categories[record.visual.category] += 1;
    record.aggregate.providers.forEach((provider) => { acc.providers[provider] += 1; });
    return acc;
  }, {
    total: 0,
    installed: 0,
    updates: 0,
    owned: 0,
    favorite: 0,
    issues: 0,
    providers: { codex: 0, claudecode: 0, opencode: 0 } as Record<PlatformSkillProvider, number>,
    categories: { system: 0, data: 0, dev: 0, design: 0, automation: 0 } as Record<Exclude<CategoryFilter, 'all'>, number>,
  });
}

function getSourceCounts(metrics: ReturnType<typeof getMetrics>, summaries: PlatformSkillSummary[]): Record<PlatformSkillProvider, number> {
  return PROVIDERS.reduce((acc, provider) => {
    acc[provider] = summaries.find((summary) => summary.provider === provider)?.installedCount ?? metrics.providers[provider];
    return acc;
  }, {} as Record<PlatformSkillProvider, number>);
}

function createAggregateFromOnlineSkill(skill: OnlineSkill): PlatformSkillAggregate {
  const providers = skill.installedProviders;
  return {
    name: skill.slug || skill.name,
    displayName: skill.displayName,
    description: skill.description,
    providers,
    missingProviders: PROVIDERS.filter((provider) => !providers.includes(provider)),
    installations: {},
    installModes: {},
    valid: true,
    issues: [],
    lastModifiedAt: skill.updatedAt,
  };
}

function createFallbackAggregate(input: {
  name: string;
  displayName: string;
  description: string;
  provider: PlatformSkillProvider;
  version: string;
  installMode: PlatformSkillInstallMode;
  valid: boolean;
  lastModifiedAt: number;
}): PlatformSkillAggregate {
  const skill: PlatformSkill = {
    provider: input.provider,
    name: input.name,
    description: input.description,
    path: `/Users/deepsea/.codex/skills/${input.name}`,
    manifestPath: `/Users/deepsea/.codex/skills/${input.name}/SKILL.md`,
    installMode: input.installMode,
    sourceLabel: providerLabel(input.provider),
    version: input.version,
    lastModifiedAt: input.lastModifiedAt,
    valid: input.valid,
    issues: input.valid ? [] : ['等待安装或版本校验'],
  };
  return {
    name: input.name,
    displayName: input.displayName,
    description: input.description,
    providers: [input.provider],
    missingProviders: PROVIDERS.filter((provider) => provider !== input.provider),
    installations: { [input.provider]: skill },
    installModes: { [input.provider]: input.installMode },
    valid: input.valid,
    issues: input.valid ? [] : [{ provider: input.provider, message: '等待安装或版本校验' }],
    lastModifiedAt: input.lastModifiedAt,
  };
}

function pickPrimaryProvider(aggregate: PlatformSkillAggregate): PlatformSkillProvider {
  return aggregate.providers[0] ?? PROVIDERS.find((provider) => aggregate.installations[provider]) ?? 'codex';
}

function inferCategory(aggregate: PlatformSkillAggregate): Exclude<CategoryFilter, 'all'> {
  const value = `${aggregate.name} ${aggregate.displayName} ${aggregate.description ?? ''}`.toLowerCase();
  if (value.includes('data') || value.includes('database') || value.includes('sql') || value.includes('memory')) return 'data';
  if (value.includes('git') || value.includes('test') || value.includes('debug') || value.includes('build')) return 'dev';
  if (value.includes('design') || value.includes('frontend') || value.includes('ui') || value.includes('visual')) return 'design';
  if (value.includes('browser') || value.includes('agent') || value.includes('automation')) return 'automation';
  return 'system';
}

function inferIcon(category: Exclude<CategoryFilter, 'all'>): LucideIcon {
  if (category === 'data') return Database;
  if (category === 'dev') return GitBranch;
  if (category === 'design') return Layers3;
  if (category === 'automation') return Bot;
  return FileCode2;
}

function providerIcon(provider: PlatformSkillProvider): LucideIcon {
  if (provider === 'codex') return Bot;
  if (provider === 'claudecode') return FileCode2;
  return GitBranch;
}

function providerColor(provider: PlatformSkillProvider): string {
  if (provider === 'codex') return '#006c49';
  if (provider === 'claudecode') return '#751f00';
  return '#003594';
}

function providerLabel(provider: PlatformSkillProvider): string {
  if (provider === 'codex') return 'Codex';
  if (provider === 'claudecode') return 'Claude Code';
  return 'OpenCode';
}

function installModeLabel(installMode: PlatformSkillInstallMode): string {
  if (installMode === 'copy') return '复制';
  if (installMode === 'symlink') return '软链接';
  return '未知';
}

function getEnvironments(record: SkillRecord, summaries: PlatformSkillSummary[]): string[] {
  const fromProviders = record.aggregate.providers.map((provider) => summaries.find((summary) => summary.provider === provider)?.label ?? providerLabel(provider));
  return Array.from(new Set([...fromProviders, ...record.visual.environments]));
}

function buildFeatureList(aggregate: PlatformSkillAggregate, category: Exclude<CategoryFilter, 'all'>): string[] {
  if (category === 'data') return ['读取结构化数据', '生成数据摘要', '校验输入边界', '导出分析证据'];
  if (category === 'dev') return ['读取项目上下文', '执行定向验证', '输出变更摘要', '记录任务证据'];
  if (category === 'design') return ['审查视觉层级', '还原设计系统', '生成响应式界面', '截图校验'];
  if (category === 'automation') return ['执行浏览器动作', '采集页面状态', '保存截图证据', '回放操作步骤'];
  return ['读取本地说明', '注入工作流约束', '提供命令入口', '保留运行证据'];
}

function buildPermissionList(category: Exclude<CategoryFilter, 'all'>): string[] {
  if (category === 'data') return ['读取数据', '运行查询', '导出结果'];
  if (category === 'dev') return ['读取源码', '运行命令', '写入文件'];
  if (category === 'design') return ['读取界面文件', '写入样式', '启动浏览器'];
  if (category === 'automation') return ['打开页面', '填写表单', '保存截图'];
  return ['读取 Skill', '加载说明', '调用工具'];
}

function formatDate(value: number): string {
  return new Date(value).toISOString().slice(0, 10);
}

function formatInstallCount(value: number | null): string | null {
  if (value === null) return null;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function pseudoVersion(name: string): string {
  return `${1 + name.length % 3}.${name.length % 9}.${name.charCodeAt(0) % 10}`;
}
