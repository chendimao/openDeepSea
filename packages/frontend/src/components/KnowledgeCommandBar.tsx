import {
  AlertCircle,
  CheckCircle2,
  CircleDot,
  FilePenLine,
  FileText,
  FileUp,
  Filter,
  FolderGit2,
  Globe,
  MessageSquareText,
  Search,
  Upload,
} from 'lucide-react';
import type { ElementType } from 'react';
import {
  getKnowledgeSourceTypeDisplay,
  getKnowledgeStatusDisplay,
  type KnowledgeLocale,
  type KnowledgeSourceStatus,
  type KnowledgeSourceType,
} from '../lib/knowledgeDisplay';
import { cn } from '../lib/utils';
import { Button } from './ui/Button';
import { Input } from './ui/Input';

export interface KnowledgeCommandBarProps {
  keyword: string;
  status?: KnowledgeSourceStatus | '';
  sourceType?: KnowledgeSourceType | '';
  locale?: KnowledgeLocale;
  disabled?: boolean;
  uploadDisabled?: boolean;
  uploadLabel?: string;
  placeholder?: string;
  onKeywordChange: (keyword: string) => void;
  onStatusChange?: (status: KnowledgeSourceStatus | '') => void;
  onSourceTypeChange?: (sourceType: KnowledgeSourceType | '') => void;
  onUpload?: () => void;
}

const quickStatuses: Array<KnowledgeSourceStatus | ''> = ['', 'ready', 'processing', 'failed'];
const quickSourceTypes: Array<KnowledgeSourceType | ''> = ['', 'uploaded_file', 'agent_document', 'web_page'];

const statusIcons: Record<KnowledgeSourceStatus, ElementType> = {
  failed: AlertCircle,
  processing: CircleDot,
  pending: CircleDot,
  stale: AlertCircle,
  ready: CheckCircle2,
  disabled: CircleDot,
};

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

export function KnowledgeCommandBar({
  keyword,
  status = '',
  sourceType = '',
  locale = 'zh',
  disabled = false,
  uploadDisabled = false,
  uploadLabel,
  placeholder,
  onKeywordChange,
  onStatusChange,
  onSourceTypeChange,
  onUpload,
}: KnowledgeCommandBarProps): JSX.Element {
  const uploadText = uploadLabel ?? (locale === 'zh' ? '上传资源' : 'Upload resource');
  const searchPlaceholder = placeholder ?? (
    locale === 'zh'
      ? '搜索知识资源、标签或输入后续命令'
      : 'Search resources, tags, or later commands'
  );

  return (
    <div className="sticky bottom-3 z-10 mx-auto flex w-full max-w-5xl items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-popover)] p-2 shadow-[var(--shadow-command)]">
      <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2">
        <Search className="h-4 w-4 shrink-0 text-[var(--color-fg-muted)]" strokeWidth={1.8} />
        <Input
          value={keyword}
          disabled={disabled}
          placeholder={searchPlaceholder}
          aria-label={locale === 'zh' ? '搜索知识资源' : 'Search knowledge resources'}
          onChange={(event) => onKeywordChange(event.target.value)}
          className="h-8 border-0 bg-transparent px-0 py-0 shadow-none focus:ring-0"
        />
      </div>

      <div className="hidden shrink-0 items-center gap-1 lg:flex" aria-label={locale === 'zh' ? '状态快速筛选' : 'Status quick filters'}>
        {quickStatuses.map((nextStatus) => (
          <CommandFilterButton
            key={nextStatus || 'all-status'}
            active={status === nextStatus}
            disabled={disabled || !onStatusChange}
            label={nextStatus ? getKnowledgeStatusDisplay(nextStatus, locale).label : locale === 'zh' ? '全部状态' : 'All status'}
            icon={nextStatus ? statusIcons[nextStatus] : Filter}
            onClick={() => onStatusChange?.(nextStatus)}
          />
        ))}
      </div>

      <div className="hidden shrink-0 items-center gap-1 xl:flex" aria-label={locale === 'zh' ? '类型快速筛选' : 'Source type quick filters'}>
        {quickSourceTypes.map((nextSourceType) => (
          <CommandFilterButton
            key={nextSourceType || 'all-types'}
            active={sourceType === nextSourceType}
            disabled={disabled || !onSourceTypeChange}
            label={nextSourceType ? getKnowledgeSourceTypeDisplay(nextSourceType, locale).label : locale === 'zh' ? '全部类型' : 'All types'}
            icon={nextSourceType ? sourceTypeIcons[nextSourceType] : Filter}
            onClick={() => onSourceTypeChange?.(nextSourceType)}
          />
        ))}
      </div>

      <Button
        type="button"
        size="sm"
        className="shrink-0 gap-2"
        aria-label={uploadText}
        title={uploadText}
        disabled={disabled || uploadDisabled || !onUpload}
        onClick={onUpload}
      >
        <Upload className="h-4 w-4" strokeWidth={1.8} />
        <span className="hidden truncate sm:inline">{uploadText}</span>
      </Button>
    </div>
  );
}

function CommandFilterButton({
  active,
  disabled,
  label,
  icon: Icon,
  onClick,
}: {
  active: boolean;
  disabled: boolean;
  label: string;
  icon: ElementType;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={cn(
        'flex h-8 max-w-[116px] items-center gap-1.5 rounded-md border px-2 text-[11px] transition-colors',
        active
          ? 'border-[var(--color-border-strong)] bg-[rgba(37,99,235,0.09)] text-[var(--color-primary)]'
          : 'border-[var(--color-border)] bg-[var(--color-popover-raised)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-raised)]',
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
