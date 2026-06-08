import {
  AlertCircle,
  Ban,
  CheckCircle2,
  Clock3,
  Eye,
  FileText,
  Quote,
  RefreshCcw,
  Tag,
  Trash2,
} from 'lucide-react';
import type { ElementType } from 'react';
import {
  formatKnowledgeSize,
  getKnowledgeSourceTypeDisplay,
  getKnowledgeStatusDisplay,
  summarizeKnowledgeStats,
  type KnowledgeLocale,
  type KnowledgeSource,
  type KnowledgeSourceStatus,
  type KnowledgeStats,
  type KnowledgeTone,
} from '../lib/knowledgeDisplay';
import { cn } from '../lib/utils';
import { Button } from './ui/Button';

export interface KnowledgeInspectorProps {
  source?: KnowledgeSource | null;
  sources?: KnowledgeSource[];
  stats?: KnowledgeStats;
  locale?: KnowledgeLocale;
  loading?: boolean;
  onPreview?: (source: KnowledgeSource) => void;
  onReference?: (source: KnowledgeSource) => void;
  onReprocess?: (source: KnowledgeSource) => void;
  onDisable?: (source: KnowledgeSource) => void;
  onDelete?: (source: KnowledgeSource) => void;
}

const statusIcons: Record<KnowledgeSourceStatus, ElementType> = {
  failed: AlertCircle,
  processing: Clock3,
  pending: Clock3,
  stale: AlertCircle,
  ready: CheckCircle2,
  disabled: Ban,
};

const toneClasses: Record<KnowledgeTone, string> = {
  success: 'border-[rgba(15,159,110,0.22)] bg-[rgba(15,159,110,0.10)] text-[var(--color-success)]',
  info: 'border-[rgba(37,99,235,0.24)] bg-[rgba(37,99,235,0.10)] text-[var(--color-primary)]',
  warning: 'border-[rgba(245,158,11,0.28)] bg-[rgba(245,158,11,0.12)] text-[var(--color-warning)]',
  danger: 'border-[rgba(217,68,53,0.24)] bg-[rgba(217,68,53,0.10)] text-[var(--color-danger)]',
  muted: 'border-[var(--color-border)] bg-[var(--color-surface-raised)] text-[var(--color-fg-muted)]',
  neutral: 'border-[var(--color-border)] bg-[rgba(148,163,184,0.12)] text-[var(--color-fg-muted)]',
};

export function KnowledgeInspector({
  source,
  sources = [],
  stats,
  locale = 'zh',
  loading = false,
  onPreview,
  onReference,
  onReprocess,
  onDisable,
  onDelete,
}: KnowledgeInspectorProps): JSX.Element {
  if (loading) {
    return <KnowledgeInspectorSkeleton />;
  }

  if (!source) {
    return (
      <aside className="flex h-full min-w-0 flex-col rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
        <InspectorHeader
          eyebrow={locale === 'zh' ? '知识库概览' : 'Knowledge overview'}
          title={locale === 'zh' ? '未选择资源' : 'No resource selected'}
          description={locale === 'zh' ? '选择中央列表中的资源查看摘要、chunk 和处理状态。' : 'Select a resource to inspect summary, chunks, and processing status.'}
        />
        <KnowledgeStatsOverview stats={stats ?? summarizeKnowledgeStats(sources)} locale={locale} />
      </aside>
    );
  }

  const statusDisplay = getKnowledgeStatusDisplay(source.status, locale);
  const StatusIcon = statusIcons[source.status];
  const typeDisplay = getKnowledgeSourceTypeDisplay(source.source_type, locale);
  const keyPoints = getMetadataKeyPoints(source);
  const metadataRows = getMetadataRows(source, locale);
  const previewLabel = locale === 'zh' ? '预览资源' : 'Preview resource';
  const referenceLabel = locale === 'zh' ? '引用到会话' : 'Reference in session';
  const reprocessLabel = locale === 'zh' ? '重新处理' : 'Reprocess';
  const disableLabel = locale === 'zh' ? '禁用检索' : 'Disable retrieval';
  const deleteLabel = locale === 'zh' ? '删除资源' : 'Delete resource';

  return (
    <aside className="flex h-full min-w-0 flex-col rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
      <InspectorHeader
        eyebrow={typeDisplay.label}
        title={source.title}
        description={source.project_name ?? source.project_id}
      />

      <div className="flex-1 overflow-auto px-4 pb-4">
        <section className="border-t border-[var(--color-border)] py-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className={cn(
              'inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
              toneClasses[statusDisplay.tone],
            )}>
              <StatusIcon className="h-3 w-3 shrink-0" strokeWidth={1.8} />
              <span className="truncate">{statusDisplay.label}</span>
            </span>
            {(source.tags ?? []).slice(0, 5).map((tag) => (
              <span
                key={tag}
                className="inline-flex max-w-[148px] items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-popover-raised)] px-2 py-0.5 text-[11px] text-[var(--color-fg-muted)]"
                title={tag}
              >
                <Tag className="h-3 w-3 shrink-0" strokeWidth={1.8} />
                <span className="truncate">{tag}</span>
              </span>
            ))}
          </div>
        </section>

        <section className="border-t border-[var(--color-border)] py-3">
          <h3 className="text-[12px] font-semibold text-[var(--color-fg)]">
            {locale === 'zh' ? '摘要' : 'Summary'}
          </h3>
          <p className="mt-2 text-[12px] leading-5 text-[var(--color-fg-muted)]">
            {source.summary || (locale === 'zh' ? '暂无摘要，等待知识提取完成。' : 'No summary generated yet.')}
          </p>
        </section>

        <section className="grid grid-cols-2 gap-2 border-t border-[var(--color-border)] py-3">
          <MetadataMetric label={locale === 'zh' ? 'Chunks' : 'Chunks'} value={String(source.chunk_count ?? 0)} />
          <MetadataMetric label={locale === 'zh' ? '大小' : 'Size'} value={formatKnowledgeSize(source.size)} />
          <MetadataMetric label={locale === 'zh' ? '引用' : 'Refs'} value={String(source.reference_count ?? 0)} />
          <MetadataMetric label={locale === 'zh' ? '房间' : 'Room'} value={source.room_name ?? source.room_id ?? '—'} />
        </section>

        {source.error ? (
          <section className="border-t border-[var(--color-border)] py-3">
            <h3 className="flex items-center gap-1.5 text-[12px] font-semibold text-[var(--color-danger)]">
              <AlertCircle className="h-4 w-4" strokeWidth={1.8} />
              {locale === 'zh' ? '解析错误' : 'Extraction error'}
            </h3>
            <p className="mt-2 max-h-28 overflow-auto rounded-md border border-[rgba(217,68,53,0.20)] bg-[rgba(217,68,53,0.08)] p-2 font-mono text-[11px] leading-5 text-[var(--color-danger)]">
              {source.error}
            </p>
          </section>
        ) : null}

        <section className="border-t border-[var(--color-border)] py-3">
          <h3 className="text-[12px] font-semibold text-[var(--color-fg)]">
            {locale === 'zh' ? '关键要点' : 'Key points'}
          </h3>
          {keyPoints.length > 0 ? (
            <ul className="mt-2 space-y-1.5">
              {keyPoints.map((point) => (
                <li key={point} className="flex min-w-0 gap-2 text-[12px] leading-5 text-[var(--color-fg-muted)]">
                  <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-[var(--color-primary)]" />
                  <span className="min-w-0 break-words">{point}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-[12px] text-[var(--color-fg-muted)]">
              {locale === 'zh' ? '暂无关键要点。' : 'No key points yet.'}
            </p>
          )}
        </section>

        <section className="border-t border-[var(--color-border)] py-3">
          <h3 className="text-[12px] font-semibold text-[var(--color-fg)]">
            {locale === 'zh' ? 'Metadata' : 'Metadata'}
          </h3>
          <dl className="mt-2 space-y-2">
            {metadataRows.map((row) => (
              <div key={row.label} className="grid grid-cols-[88px_minmax(0,1fr)] gap-2 text-[11px]">
                <dt className="text-[var(--color-fg-muted)]">{row.label}</dt>
                <dd className="min-w-0 truncate font-mono text-[var(--color-fg)]" title={row.value}>{row.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>

      <div className="border-t border-[var(--color-border)] p-3">
        <div className="grid grid-cols-2 gap-2">
          <InspectorActionButton
            label={previewLabel}
            controlLabel={getInspectorControlLabel(previewLabel, source.title, !onPreview, locale)}
            disabled={!onPreview}
            onClick={() => onPreview?.(source)}
            icon={Eye}
          />
          <InspectorActionButton
            label={referenceLabel}
            controlLabel={getInspectorControlLabel(referenceLabel, source.title, !onReference, locale)}
            disabled={!onReference}
            onClick={() => onReference?.(source)}
            icon={Quote}
          />
          <InspectorActionButton
            label={reprocessLabel}
            controlLabel={getInspectorControlLabel(reprocessLabel, source.title, !onReprocess, locale)}
            disabled={!onReprocess}
            onClick={() => onReprocess?.(source)}
            icon={RefreshCcw}
          />
          <InspectorActionButton
            label={disableLabel}
            controlLabel={getInspectorControlLabel(disableLabel, source.title, !onDisable, locale)}
            disabled={!onDisable}
            onClick={() => onDisable?.(source)}
            icon={Ban}
          />
        </div>
        <Button
          type="button"
          variant="danger"
          size="sm"
          className="mt-2 w-full justify-center gap-2"
          aria-label={getInspectorControlLabel(deleteLabel, source.title, !onDelete, locale)}
          title={getInspectorControlLabel(deleteLabel, source.title, !onDelete, locale)}
          disabled={!onDelete}
          onClick={() => onDelete?.(source)}
        >
          <Trash2 className="h-4 w-4" strokeWidth={1.8} />
          <span className="truncate">{deleteLabel}</span>
        </Button>
      </div>
    </aside>
  );
}

function InspectorHeader({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}): JSX.Element {
  return (
    <header className="min-w-0 px-4 py-3">
      <div className="truncate font-mono text-[11px] text-[var(--color-fg-muted)]">{eyebrow}</div>
      <h2 className="mt-1 truncate text-[15px] font-semibold text-[var(--color-fg)]" title={title}>{title}</h2>
      <p className="mt-1 truncate text-[12px] text-[var(--color-fg-muted)]" title={description}>{description}</p>
    </header>
  );
}

function KnowledgeStatsOverview({ stats, locale }: { stats: KnowledgeStats; locale: KnowledgeLocale }): JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-2 border-t border-[var(--color-border)] p-4">
      <MetadataMetric label={locale === 'zh' ? '资源' : 'Sources'} value={String(stats.total)} />
      <MetadataMetric label={locale === 'zh' ? '已提取' : 'Ready'} value={String(stats.ready)} />
      <MetadataMetric label={locale === 'zh' ? '处理中' : 'Processing'} value={String(stats.processing)} />
      <MetadataMetric label={locale === 'zh' ? '失败' : 'Failed'} value={String(stats.failed)} />
      <MetadataMetric label={locale === 'zh' ? 'Chunks' : 'Chunks'} value={String(stats.chunks)} />
      <MetadataMetric label={locale === 'zh' ? '总大小' : 'Total size'} value={formatKnowledgeSize(stats.totalSize)} />
    </div>
  );
}

function MetadataMetric({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="min-w-0 rounded-md border border-[var(--color-border)] bg-[var(--color-popover-raised)] px-2 py-2">
      <div className="truncate text-[11px] text-[var(--color-fg-muted)]">{label}</div>
      <div className="mt-1 truncate font-mono text-[12px] font-semibold text-[var(--color-fg)]" title={value}>{value}</div>
    </div>
  );
}

function InspectorActionButton({
  label,
  controlLabel,
  disabled,
  icon: Icon,
  onClick,
}: {
  label: string;
  controlLabel: string;
  disabled: boolean;
  icon: ElementType;
  onClick: () => void;
}): JSX.Element {
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      className="min-w-0 justify-start gap-2"
      aria-label={controlLabel}
      title={controlLabel}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon className="h-4 w-4 shrink-0" strokeWidth={1.8} />
      <span className="truncate">{label}</span>
    </Button>
  );
}

function getInspectorControlLabel(
  actionLabel: string,
  sourceTitle: string,
  disabled: boolean,
  locale: KnowledgeLocale,
): string {
  const baseLabel = locale === 'zh' ? `${actionLabel}：${sourceTitle}` : `${actionLabel}: ${sourceTitle}`;
  if (!disabled) return baseLabel;
  return locale === 'zh' ? `${baseLabel}（操作未接入）` : `${baseLabel} (action unavailable)`;
}

function KnowledgeInspectorSkeleton(): JSX.Element {
  return (
    <aside className="flex h-full min-w-0 flex-col rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="h-3 w-24 rounded bg-[var(--color-popover-raised)]" />
      <div className="mt-3 h-4 w-2/3 rounded bg-[var(--color-popover-raised)]" />
      <div className="mt-8 grid grid-cols-2 gap-2">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="h-14 rounded-md border border-[var(--color-border)] bg-[var(--color-popover-raised)]" />
        ))}
      </div>
    </aside>
  );
}

function getMetadataKeyPoints(source: KnowledgeSource): string[] {
  const points = source.metadata?.key_points;
  if (!Array.isArray(points)) return [];
  return points.filter((point): point is string => typeof point === 'string' && point.trim().length > 0);
}

function getMetadataRows(source: KnowledgeSource, locale: KnowledgeLocale): Array<{ label: string; value: string }> {
  return [
    { label: 'ID', value: source.id },
    { label: locale === 'zh' ? '来源' : 'Source', value: source.source_id ?? '—' },
    { label: locale === 'zh' ? 'MIME' : 'MIME', value: source.mime_type ?? '—' },
    { label: locale === 'zh' ? '解析器' : 'Parser', value: source.parser ?? stringMetadataValue(source.metadata?.parser) ?? '—' },
    { label: locale === 'zh' ? '版本' : 'Version', value: source.parser_version ?? stringMetadataValue(source.metadata?.parser_version) ?? '—' },
    { label: locale === 'zh' ? '内容类型' : 'Kind', value: stringMetadataValue(source.metadata?.content_kind) ?? '—' },
    { label: locale === 'zh' ? '更新' : 'Updated', value: formatKnowledgeTimestamp(source.updated_at, locale) },
    { label: locale === 'zh' ? '索引' : 'Indexed', value: formatKnowledgeTimestamp(source.last_processed_at, locale) },
  ];
}

function stringMetadataValue(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function formatKnowledgeTimestamp(value: number | null | undefined, locale: KnowledgeLocale): string {
  if (!value) return '—';
  const timestamp = value < 10_000_000_000 ? value * 1000 : value;
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}
