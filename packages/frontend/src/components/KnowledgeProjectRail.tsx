import {
  AlertCircle,
  CheckCircle2,
  CircleDot,
  Database,
  Filter,
  FolderKanban,
  Layers3,
  RefreshCcw,
} from 'lucide-react';
import type { ElementType } from 'react';
import {
  getKnowledgeSourceTypeDisplay,
  getKnowledgeStatusFilterOptions,
  getKnowledgeStatusDisplay,
  type KnowledgeLocale,
  type KnowledgeSourceFilters,
  type KnowledgeSourceStatus,
  type KnowledgeSourceType,
  type KnowledgeStats,
} from '../lib/knowledgeDisplay';
import { cn } from '../lib/utils';
import { Button } from './ui/Button';

export interface KnowledgeRailProject {
  id: string;
  name: string;
  path?: string | null;
  sourceCount?: number;
  readyCount?: number;
  failedCount?: number;
}

export interface KnowledgeRailRoom {
  id: string;
  name: string;
  sourceCount?: number;
}

export interface KnowledgeProjectRailProps {
  filters: KnowledgeSourceFilters;
  projects: KnowledgeRailProject[];
  rooms?: KnowledgeRailRoom[];
  stats?: KnowledgeStats;
  locale?: KnowledgeLocale;
  disabled?: boolean;
  onFiltersChange: (filters: KnowledgeSourceFilters) => void;
}

const statusIcons: Record<KnowledgeSourceStatus, ElementType> = {
  failed: AlertCircle,
  processing: RefreshCcw,
  pending: CircleDot,
  stale: AlertCircle,
  ready: CheckCircle2,
  disabled: CircleDot,
};

const sourceTypeOptions: Array<KnowledgeSourceType | ''> = [
  '',
  'resource_asset',
  'uploaded_file',
  'agent_document',
  'message',
  'task',
  'workspace_file',
  'workspace_doc',
  'web_page',
  'session_note',
  'url',
  'manual',
];

const statusOptions = getKnowledgeStatusFilterOptions();

export function KnowledgeProjectRail({
  filters,
  projects,
  rooms = [],
  stats,
  locale = 'zh',
  disabled = false,
  onFiltersChange,
}: KnowledgeProjectRailProps): JSX.Element {
  const activeProjectId = filters.projectId ?? '';
  const activeRoomId = filters.roomId ?? '';
  const activeStatus = filters.status ?? '';
  const activeSourceType = filters.sourceType ?? '';
  const emit = (patch: KnowledgeSourceFilters) => onFiltersChange({ ...filters, ...patch });

  return (
    <aside className="flex h-full min-w-[224px] max-w-[280px] flex-col rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
      <header className="border-b border-[var(--color-border)] px-3 py-3">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-popover-raised)] text-[var(--color-primary)]">
            <Database className="h-4 w-4" strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-[14px] font-semibold text-[var(--color-fg)]">
              {locale === 'zh' ? '知识库中心' : 'Knowledge hub'}
            </h2>
            <p className="truncate font-mono text-[10px] text-[var(--color-fg-muted)]">TACTICAL HUB</p>
          </div>
        </div>
      </header>

      {stats ? (
        <div className="grid grid-cols-3 gap-1.5 border-b border-[var(--color-border)] px-3 py-3">
          <RailMetric label={locale === 'zh' ? '资源' : 'Sources'} value={stats.total} />
          <RailMetric label={locale === 'zh' ? '索引' : 'Ready'} value={stats.ready} />
          <RailMetric label={locale === 'zh' ? '失败' : 'Failed'} value={stats.failed} />
        </div>
      ) : null}

      <div className="flex-1 overflow-auto px-2 py-3">
        <section>
          <RailSectionTitle icon={Layers3} label={locale === 'zh' ? '项目范围' : 'Project scope'} />
          <div className="mt-2 space-y-1">
            <RailProjectButton
              active={!activeProjectId}
              disabled={disabled}
              icon={Database}
              label={locale === 'zh' ? '所有项目' : 'All projects'}
              meta={stats ? String(stats.total) : undefined}
              onClick={() => emit({ projectId: '', roomId: '' })}
            />
            {projects.map((project) => (
              <RailProjectButton
                key={project.id}
                active={activeProjectId === project.id}
                disabled={disabled}
                icon={FolderKanban}
                label={project.name}
                description={project.path ?? undefined}
                meta={formatProjectMeta(project, locale)}
                danger={Boolean(project.failedCount)}
                onClick={() => emit({ projectId: project.id, roomId: '' })}
              />
            ))}
          </div>
        </section>

        <section className="mt-4">
          <RailSectionTitle icon={Filter} label={locale === 'zh' ? '结构化筛选' : 'Structured filters'} />
          <div className="mt-2 space-y-2">
            <label className="block">
              <span className="mb-1 block text-[11px] text-[var(--color-fg-muted)]">
                {locale === 'zh' ? '房间' : 'Room'}
              </span>
              <select
                className="h-8 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-popover)] px-2 text-[12px] text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)]"
                value={activeRoomId}
                disabled={disabled || !activeProjectId}
                aria-label={locale === 'zh' ? '房间筛选' : 'Room filter'}
                onChange={(event) => emit({ roomId: event.target.value })}
              >
                <option value="">{locale === 'zh' ? '全部房间' : 'All rooms'}</option>
                {rooms.map((room) => (
                  <option key={room.id} value={room.id}>
                    {room.sourceCount == null ? room.name : `${room.name} (${room.sourceCount})`}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="mb-1 block text-[11px] text-[var(--color-fg-muted)]">
                {locale === 'zh' ? '资源类型' : 'Source type'}
              </span>
              <select
                className="h-8 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-popover)] px-2 text-[12px] text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)]"
                value={activeSourceType}
                disabled={disabled}
                aria-label={locale === 'zh' ? '资源类型筛选' : 'Source type filter'}
                onChange={(event) => emit({ sourceType: event.target.value as KnowledgeSourceType | '' })}
              >
                {sourceTypeOptions.map((sourceType) => (
                  <option key={sourceType || 'all'} value={sourceType}>
                    {sourceType ? getKnowledgeSourceTypeDisplay(sourceType, locale).label : locale === 'zh' ? '全部类型' : 'All types'}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>

        <section className="mt-4">
          <RailSectionTitle icon={CircleDot} label={locale === 'zh' ? '处理状态' : 'Processing status'} />
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            {statusOptions.map((status) => (
              <RailStatusButton
                key={status || 'all'}
                status={status}
                active={activeStatus === status}
                disabled={disabled}
                locale={locale}
                onClick={() => emit({ status })}
              />
            ))}
          </div>
        </section>
      </div>

      <footer className="border-t border-[var(--color-border)] p-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full justify-center gap-2"
          aria-label={locale === 'zh' ? '清空知识库筛选' : 'Clear knowledge filters'}
          title={locale === 'zh' ? '清空知识库筛选' : 'Clear knowledge filters'}
          disabled={disabled}
          onClick={() => onFiltersChange({ keyword: filters.keyword ?? '' })}
        >
          <Filter className="h-4 w-4" strokeWidth={1.8} />
          <span className="truncate">{locale === 'zh' ? '清空筛选' : 'Clear filters'}</span>
        </Button>
      </footer>
    </aside>
  );
}

function RailMetric({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className="min-w-0 rounded-md border border-[var(--color-border)] bg-[var(--color-popover-raised)] px-2 py-1.5">
      <div className="truncate font-mono text-[12px] font-semibold text-[var(--color-fg)]">{value}</div>
      <div className="truncate text-[10px] text-[var(--color-fg-muted)]">{label}</div>
    </div>
  );
}

function RailSectionTitle({ icon: Icon, label }: { icon: ElementType; label: string }): JSX.Element {
  return (
    <div className="flex items-center gap-1.5 px-1 text-[11px] font-medium text-[var(--color-fg-muted)]">
      <Icon className="h-3.5 w-3.5" strokeWidth={1.8} />
      <span className="truncate">{label}</span>
    </div>
  );
}

function RailProjectButton({
  active,
  disabled,
  icon: Icon,
  label,
  description,
  meta,
  danger,
  onClick,
}: {
  active: boolean;
  disabled: boolean;
  icon: ElementType;
  label: string;
  description?: string;
  meta?: string;
  danger?: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={cn(
        'flex h-[44px] w-full min-w-0 items-center gap-2 rounded-md border px-2 text-left transition-colors',
        active
          ? 'border-[var(--color-border-strong)] bg-[rgba(37,99,235,0.09)] text-[var(--color-fg)]'
          : 'border-transparent text-[var(--color-fg-muted)] hover:border-[var(--color-border)] hover:bg-[var(--color-surface-raised)]',
      )}
      aria-label={label}
      aria-pressed={active}
      title={description ? `${label} · ${description}` : label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon className="h-4 w-4 shrink-0" strokeWidth={1.8} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] font-medium">{label}</span>
        {description ? <span className="block truncate font-mono text-[10px] opacity-80">{description}</span> : null}
      </span>
      {meta ? (
        <span className={cn(
          'shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[10px]',
          danger ? 'bg-[rgba(217,68,53,0.10)] text-[var(--color-danger)]' : 'bg-[var(--color-popover-raised)]',
        )}>
          {meta}
        </span>
      ) : null}
    </button>
  );
}

function RailStatusButton({
  status,
  active,
  disabled,
  locale,
  onClick,
}: {
  status: KnowledgeSourceStatus | '';
  active: boolean;
  disabled: boolean;
  locale: KnowledgeLocale;
  onClick: () => void;
}): JSX.Element {
  const label = status ? getKnowledgeStatusDisplay(status, locale).label : locale === 'zh' ? '全部' : 'All';
  const Icon = status ? statusIcons[status] : CircleDot;
  return (
    <button
      type="button"
      className={cn(
        'flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-md border px-2 text-[11px] transition-colors',
        active
          ? 'border-[var(--color-border-strong)] bg-[rgba(37,99,235,0.09)] text-[var(--color-primary)]'
          : 'border-[var(--color-border)] bg-[var(--color-popover)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-raised)]',
      )}
      aria-label={label}
      aria-pressed={active}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
      <span className="truncate">{label}</span>
    </button>
  );
}

function formatProjectMeta(project: KnowledgeRailProject, locale: KnowledgeLocale): string | undefined {
  if (project.failedCount) return locale === 'zh' ? `${project.failedCount} 失败` : `${project.failedCount} failed`;
  if (project.readyCount != null && project.sourceCount != null) return `${project.readyCount}/${project.sourceCount}`;
  if (project.sourceCount != null) return String(project.sourceCount);
  return undefined;
}
