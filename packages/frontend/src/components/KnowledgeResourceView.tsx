import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  Eye,
  FilePenLine,
  FileText,
  FileUp,
  FolderGit2,
  Globe,
  MessageSquareText,
  RefreshCcw,
  Search,
} from 'lucide-react';
import type { ElementType } from 'react';
import {
  formatKnowledgeSize,
  getKnowledgeSourceTypeDisplay,
  getKnowledgeStatusDisplay,
  type KnowledgeLocale,
  type KnowledgeSource,
  type KnowledgeSourceStatus,
  type KnowledgeSourceType,
  type KnowledgeTone,
} from '../lib/knowledgeDisplay';
import { cn } from '../lib/utils';
import { Button } from './ui/Button';

export type KnowledgeResourceViewMode = 'list' | 'grid';

export interface KnowledgeResourceViewProps {
  sources: KnowledgeSource[];
  viewMode?: KnowledgeResourceViewMode;
  selectedSourceId?: string | null;
  loading?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  locale?: KnowledgeLocale;
  onSelect?: (source: KnowledgeSource) => void;
  onPreview?: (source: KnowledgeSource) => void;
  onReprocess?: (source: KnowledgeSource) => void;
}

const sourceTypeIcons: Record<KnowledgeSourceType, ElementType> = {
  resource_asset: FileText,
  uploaded_file: FileUp,
  agent_document: FilePenLine,
  message: MessageSquareText,
  task: FileText,
  workspace_file: FileText,
  workspace_doc: FolderGit2,
  web_page: Globe,
  session_note: MessageSquareText,
  url: Globe,
  manual: FileText,
};

const statusIcons: Record<KnowledgeSourceStatus, ElementType> = {
  failed: AlertCircle,
  processing: Clock3,
  pending: Clock3,
  stale: AlertCircle,
  ready: CheckCircle2,
  disabled: AlertCircle,
};

const toneClasses: Record<KnowledgeTone, string> = {
  success: 'border-[rgba(15,159,110,0.22)] bg-[rgba(15,159,110,0.10)] text-[var(--color-success)]',
  info: 'border-[rgba(37,99,235,0.24)] bg-[rgba(37,99,235,0.10)] text-[var(--color-primary)]',
  warning: 'border-[rgba(245,158,11,0.28)] bg-[rgba(245,158,11,0.12)] text-[var(--color-warning)]',
  danger: 'border-[rgba(217,68,53,0.24)] bg-[rgba(217,68,53,0.10)] text-[var(--color-danger)]',
  muted: 'border-[var(--color-border)] bg-[var(--color-surface-raised)] text-[var(--color-fg-muted)]',
  neutral: 'border-[var(--color-border)] bg-[rgba(148,163,184,0.12)] text-[var(--color-fg-muted)]',
};

export function KnowledgeResourceView({
  sources,
  viewMode = 'list',
  selectedSourceId,
  loading = false,
  emptyTitle = '暂无知识资源',
  emptyDescription = '上传文件或保存智能体文档后会显示在这里。',
  locale = 'zh',
  onSelect,
  onPreview,
  onReprocess,
}: KnowledgeResourceViewProps): JSX.Element {
  if (loading) {
    return <KnowledgeResourceSkeleton viewMode={viewMode} />;
  }

  if (sources.length === 0) {
    return (
      <div className="flex min-h-[320px] flex-col items-center justify-center gap-3 rounded-md border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] px-6 text-center">
        <span className="flex h-9 w-9 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] text-[var(--color-fg-muted)]">
          <Search className="h-4 w-4" strokeWidth={1.8} />
        </span>
        <div className="max-w-[360px]">
          <div className="text-[14px] font-semibold text-[var(--color-fg)]">{emptyTitle}</div>
          <p className="mt-1 text-[12px] leading-5 text-[var(--color-fg-muted)]">{emptyDescription}</p>
        </div>
      </div>
    );
  }

  return (
    <section
      className={cn(
        'min-w-0',
        viewMode === 'grid'
          ? 'grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4'
          : 'overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]',
      )}
      aria-label={locale === 'zh' ? '知识资源列表' : 'Knowledge resources'}
    >
      {viewMode === 'list' ? (
        <div className="hidden grid-cols-[minmax(0,1.4fr)_140px_128px_120px_116px] items-center border-b border-[var(--color-border)] bg-[var(--color-popover-raised)] px-3 py-2 text-[11px] font-medium text-[var(--color-fg-muted)] md:grid">
          <span>{locale === 'zh' ? '资源' : 'Resource'}</span>
          <span>{locale === 'zh' ? '类型' : 'Type'}</span>
          <span>{locale === 'zh' ? '状态' : 'Status'}</span>
          <span>{locale === 'zh' ? '索引' : 'Index'}</span>
          <span className="text-right">{locale === 'zh' ? '操作' : 'Actions'}</span>
        </div>
      ) : null}
      <div className={viewMode === 'list' ? 'divide-y divide-[var(--color-border)]' : 'contents'}>
        {sources.map((source) => (
          <KnowledgeResourceItem
            key={source.id}
            source={source}
            viewMode={viewMode}
            selected={selectedSourceId === source.id}
            locale={locale}
            onSelect={onSelect}
            onPreview={onPreview}
            onReprocess={onReprocess}
          />
        ))}
      </div>
    </section>
  );
}

function KnowledgeResourceItem({
  source,
  viewMode,
  selected,
  locale,
  onSelect,
  onPreview,
  onReprocess,
}: {
  source: KnowledgeSource;
  viewMode: KnowledgeResourceViewMode;
  selected: boolean;
  locale: KnowledgeLocale;
  onSelect?: (source: KnowledgeSource) => void;
  onPreview?: (source: KnowledgeSource) => void;
  onReprocess?: (source: KnowledgeSource) => void;
}): JSX.Element {
  const typeDisplay = getKnowledgeSourceTypeDisplay(source.source_type, locale);
  const TypeIcon = sourceTypeIcons[source.source_type] ?? FileText;
  const selectLabel = locale === 'zh' ? `选择资源：${source.title}` : `Select resource: ${source.title}`;
  const previewLabel = locale === 'zh' ? `预览资源：${source.title}` : `Preview resource: ${source.title}`;
  const reprocessLabel = locale === 'zh' ? `重新处理：${source.title}` : `Reprocess: ${source.title}`;

  if (viewMode === 'grid') {
    return (
      <article className={cn(
        'min-w-0 rounded-md border bg-[var(--color-surface)] transition-colors',
        selected
          ? 'border-[var(--color-border-strong)] bg-[rgba(37,99,235,0.07)]'
          : 'border-[var(--color-border)] hover:border-[var(--color-border-strong)]',
      )}>
        <button
          type="button"
          className="flex min-h-[172px] w-full min-w-0 flex-col items-stretch gap-3 p-3 text-left"
          aria-label={selectLabel}
          aria-pressed={selected}
          title={source.title}
          onClick={() => onSelect?.(source)}
        >
          <span className="flex min-w-0 items-start gap-2">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-popover-raised)] text-[var(--color-primary)]">
              <TypeIcon className="h-4 w-4" strokeWidth={1.8} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold text-[var(--color-fg)]">{source.title}</span>
              <span className="mt-1 block truncate text-[11px] text-[var(--color-fg-muted)]">{source.project_name ?? source.project_id}</span>
            </span>
            <KnowledgeStatusPill status={source.status} locale={locale} />
          </span>
          <span className="line-clamp-2 min-h-[40px] text-[12px] leading-5 text-[var(--color-fg-muted)]">
            {source.summary || (locale === 'zh' ? '暂无摘要，等待解析产物写入。' : 'No summary yet.')}
          </span>
          <span className="mt-auto flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-[var(--color-fg-muted)]">
            <span className="rounded border border-[var(--color-border)] px-1.5 py-0.5">{typeDisplay.label}</span>
            <span className="font-mono">{formatKnowledgeSize(source.size)}</span>
            <span className="font-mono">{source.chunk_count ?? 0} chunks</span>
          </span>
        </button>
        <ResourceActionBar
          source={source}
          previewLabel={previewLabel}
          reprocessLabel={reprocessLabel}
          onPreview={onPreview}
          onReprocess={onReprocess}
        />
      </article>
    );
  }

  return (
    <article className={cn(
      'grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-3 py-2 transition-colors',
      selected ? 'bg-[rgba(37,99,235,0.07)]' : 'hover:bg-[var(--color-surface-raised)]',
    )}>
      <button
        type="button"
        className="grid min-w-0 grid-cols-1 items-center gap-2 text-left md:grid-cols-[minmax(0,1.4fr)_140px_128px_120px]"
        aria-label={selectLabel}
        aria-pressed={selected}
        title={source.title}
        onClick={() => onSelect?.(source)}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-popover-raised)] text-[var(--color-primary)]">
            <TypeIcon className="h-4 w-4" strokeWidth={1.8} />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-semibold text-[var(--color-fg)]">{source.title}</span>
            <span className="block truncate text-[11px] text-[var(--color-fg-muted)]">
              {source.summary || source.project_name || source.project_id}
            </span>
          </span>
        </span>
        <span className="hidden min-w-0 truncate text-[12px] text-[var(--color-fg-muted)] md:block">{typeDisplay.label}</span>
        <span className="hidden md:block">
          <KnowledgeStatusPill status={source.status} locale={locale} />
        </span>
        <span className="hidden min-w-0 font-mono text-[11px] text-[var(--color-fg-muted)] md:flex md:flex-col">
          <span>{source.chunk_count ?? 0} chunks</span>
          <span>{formatKnowledgeSize(source.size)}</span>
        </span>
      </button>
      <ResourceActionBar
        source={source}
        compact
        previewLabel={previewLabel}
        reprocessLabel={reprocessLabel}
        onPreview={onPreview}
        onReprocess={onReprocess}
      />
    </article>
  );
}

function KnowledgeStatusPill({
  status,
  locale,
}: {
  status: KnowledgeSourceStatus;
  locale: KnowledgeLocale;
}): JSX.Element {
  const display = getKnowledgeStatusDisplay(status, locale);
  const Icon = statusIcons[status];
  return (
    <span className={cn(
      'inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
      toneClasses[display.tone],
    )}>
      <Icon className="h-3 w-3 shrink-0" strokeWidth={1.8} />
      <span className="truncate">{display.label}</span>
    </span>
  );
}

function ResourceActionBar({
  source,
  compact = false,
  previewLabel,
  reprocessLabel,
  onPreview,
  onReprocess,
}: {
  source: KnowledgeSource;
  compact?: boolean;
  previewLabel: string;
  reprocessLabel: string;
  onPreview?: (source: KnowledgeSource) => void;
  onReprocess?: (source: KnowledgeSource) => void;
}): JSX.Element {
  return (
    <div className={cn(
      'flex shrink-0 items-center justify-end gap-1',
      compact ? 'w-[116px]' : 'border-t border-[var(--color-border)] px-3 py-2',
    )}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 w-7 px-0"
        aria-label={previewLabel}
        title={previewLabel}
        disabled={!onPreview}
        onClick={() => onPreview?.(source)}
      >
        <Eye className="h-4 w-4" strokeWidth={1.8} />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 w-7 px-0"
        aria-label={reprocessLabel}
        title={reprocessLabel}
        disabled={!onReprocess}
        onClick={() => onReprocess?.(source)}
      >
        <RefreshCcw className="h-4 w-4" strokeWidth={1.8} />
      </Button>
    </div>
  );
}

function KnowledgeResourceSkeleton({ viewMode }: { viewMode: KnowledgeResourceViewMode }): JSX.Element {
  const items = Array.from({ length: viewMode === 'grid' ? 8 : 6 }, (_, index) => index);
  return (
    <div className={cn(
      viewMode === 'grid'
        ? 'grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4'
        : 'overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]',
    )}>
      {items.map((item) => (
        <div
          key={item}
          className={cn(
            'border border-[var(--color-border)] bg-[var(--color-surface)]',
            viewMode === 'grid' ? 'h-[190px] rounded-md p-3' : 'h-[58px] border-x-0 border-t-0 px-3 py-2',
          )}
        >
          <div className="flex h-full items-center gap-3">
            <div className="h-8 w-8 shrink-0 rounded-md bg-[var(--color-popover-raised)]" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="h-3 w-2/3 rounded bg-[var(--color-popover-raised)]" />
              <div className="h-2.5 w-1/2 rounded bg-[var(--color-popover-raised)]" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
