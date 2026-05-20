import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { api } from '../lib/api';
import { formatFileSize } from '../lib/composerModel';
import { useI18n } from '../lib/i18n';
import { getProjectFileSourceSummary, getProjectFileTypeLabel, getResourceDetailSourceSummary } from '../lib/projectFileDisplay';
import type { ProjectFile, ResourceDetail } from '../lib/types';
import { MarkdownPreview } from './MessageContent';
import { Dialog, DialogContent } from './ui/Dialog';

interface ProjectFilePreviewDialogProps {
  file: ProjectFile | null;
  projectId?: string;
  onOpenChange: (open: boolean) => void;
  onLocateMessage?: (messageId: string) => void;
}

export function ProjectFilePreviewDialog({
  file,
  projectId,
  onOpenChange,
  onLocateMessage,
}: ProjectFilePreviewDialogProps): JSX.Element {
  const { t } = useI18n();
  const {
    data: detail,
    error,
    isError,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ['resource-detail', file?.id, projectId ?? file?.project_id ?? ''],
    queryFn: () => api.getResourceDetail(file!.id, { projectId: projectId ?? file?.project_id }),
    enabled: !!file,
    retry: false,
  });

  return (
    <Dialog open={!!file} onOpenChange={onOpenChange}>
      <DialogContent className="file-preview-dialog" title={file?.original_name}>
        {file && (
          isLoading ? (
            <ProjectFilePreviewState title={t('files.detailLoading')} />
          ) : isError ? (
            <ProjectFilePreviewState
              title={isNotFoundError(error) ? t('files.detailNotFound') : t('files.detailLoadFailed')}
              description={error instanceof Error ? error.message : t('common.error')}
              actionLabel={t('common.retry')}
              onAction={() => void refetch()}
            />
          ) : detail ? (
            <ResourceDetailPreviewContent
              resource={detail}
              fallbackFile={file}
              onLocateMessage={onLocateMessage}
              onClose={() => onOpenChange(false)}
            />
          ) : (
            <ProjectFilePreviewState title={t('files.detailNotFound')} />
          )
        )}
      </DialogContent>
    </Dialog>
  );
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && (error.message.includes('404') || error.message.toLocaleLowerCase().includes('not found'));
}

export function ProjectFilePreviewState({
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
    <div className="file-preview-state">
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

export function ResourceDetailPreviewContent({
  resource,
  fallbackFile,
  onLocateMessage,
  onClose,
}: {
  resource: ResourceDetail;
  fallbackFile: ProjectFile;
  onLocateMessage?: (messageId: string) => void;
  onClose?: () => void;
}): JSX.Element {
  const { t, formatRelativeTime } = useI18n();
  const isAgentDocument = resource.resource_type === 'agent_document';
  const size = resource.size ?? fallbackFile.size;
  const mimeType = resource.mime_type ?? fallbackFile.mime_type;
  const sourceSummary = getResourceDetailSourceSummary(resource, t);

  return (
    <div className="file-preview-shell">
      {isAgentDocument ? (
        <ResourceSourceTrace
          title={t('files.detail.documentSourceTitle')}
          summary={sourceSummary}
          items={[
            resource.source.display_name ?? resource.source.agent_id ?? resource.source_agent_id,
            resource.source.context?.name ?? resource.source_context_name ?? resource.source_task_id ?? resource.source_room_id,
            formatRelativeTime(resource.created_at),
          ]}
        />
      ) : null}
      <ResourceDetailPreviewBody resource={resource} fallbackFile={fallbackFile} />
      <div className="file-preview-footer">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--color-fg-muted)]">
          {isAgentDocument ? t('files.source.agentDocument') : t('files.source.uploadedFile')}
          {' · '}
          {formatFileSize(size)} · {mimeType}
        </span>
        {resource.source.message_id && onLocateMessage ? (
          <button
            type="button"
            className="image-preview-link"
            onClick={() => {
              onLocateMessage(resource.source.message_id!);
              onClose?.();
            }}
          >
            {t('files.locateMessage')}
          </button>
        ) : null}
        {!isAgentDocument && resource.capabilities.preview && resource.preview_url ? (
          <a href={resource.preview_url} target="_blank" rel="noreferrer" className="image-preview-link">
            {t('files.openOriginal')}
          </a>
        ) : null}
        {!isAgentDocument && resource.capabilities.download && resource.download_url ? (
          <a href={resource.download_url} download={resource.name} className="image-preview-link">
            {t('files.download')}
          </a>
        ) : null}
      </div>
      <dl className="file-preview-details" aria-label={t('files.details')}>
        <div>
          <dt>{t('files.sourceFilter')}</dt>
          <dd>{isAgentDocument ? t('files.source.agentDocument') : t('files.source.uploadedFile')}</dd>
        </div>
        <div>
          <dt>{isAgentDocument ? t('files.detail.sourceAgent') : t('files.detail.uploadedBy')}</dt>
          <dd title={sourceSummary}>{sourceSummary}</dd>
        </div>
        <div>
          <dt>{isAgentDocument ? t('files.detail.generatedAt') : t('files.detail.createdAt')}</dt>
          <dd>{formatRelativeTime(resource.created_at)}</dd>
        </div>
        {resource.source.agent_id ? (
          <div>
            <dt>{t('files.detail.sourceAgent')}</dt>
            <dd>{resource.source.display_name ?? resource.source.agent_id}</dd>
          </div>
        ) : null}
        {resource.source.task_id ? (
          <div>
            <dt>{t('files.detail.sourceTask')}</dt>
            <dd>{resource.source.context?.type === 'task' ? resource.source.context.name ?? resource.source.task_id : resource.source.task_id}</dd>
          </div>
        ) : null}
        {resource.source.room_id ? (
          <div>
            <dt>{t('files.detail.sourceRoom')}</dt>
            <dd>{resource.source.context?.type === 'room' ? resource.source.context.name ?? resource.source.room_id : resource.source.room_id}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

function ResourceDetailPreviewBody({
  resource,
  fallbackFile,
}: {
  resource: ResourceDetail;
  fallbackFile: ProjectFile;
}): JSX.Element {
  const { t } = useI18n();

  if (resource.resource_type === 'agent_document') {
    const content = resource.content?.trim();
    return (
      <div className="file-preview-markdown">
        {content ? (
          <MarkdownPreview content={content} />
        ) : (
          <ProjectFilePreviewState title={t('files.documentEmpty')} />
        )}
      </div>
    );
  }

  const mimeType = resource.mime_type ?? fallbackFile.mime_type;
  const previewUrl = resource.preview_url ?? resource.url ?? fallbackFile.url;
  if (mimeType.startsWith('image/') && previewUrl) {
    return (
      <div className="file-preview-stage">
        <img src={previewUrl} alt={resource.name} />
      </div>
    );
  }

  if ((mimeType === 'application/pdf' || mimeType.startsWith('text/')) && previewUrl) {
    return <iframe className="file-preview-frame" src={previewUrl} title={resource.name} />;
  }

  return (
    <ProjectFilePreviewState
      title={t('files.previewUnavailable')}
      description={resource.download_url ? t('files.previewUnavailableDownloadHint') : undefined}
    />
  );
}

export function ProjectFilePreviewContent({
  file,
  onLocateMessage,
  onClose,
}: {
  file: ProjectFile;
  onLocateMessage?: (messageId: string) => void;
  onClose?: () => void;
}): JSX.Element {
  const { t, formatRelativeTime } = useI18n();
  const isAgentDocument = file.source_type === 'agent_document';
  const isUploadedFile = file.source_type === 'uploaded_file';
  const sourceSummary = getProjectFileSourceSummary(file, t);

  return (
    <div className="file-preview-shell">
      {isAgentDocument ? (
        <ResourceSourceTrace
          title={t('files.detail.documentSourceTitle')}
          summary={sourceSummary}
          items={[
            file.source_agent_id,
            file.last_referenced_room_name ?? file.source_task_id ?? file.source_room_id,
            formatRelativeTime(file.created_at),
          ]}
        />
      ) : null}
      <ProjectFilePreviewBody file={file} />
      <div className="file-preview-footer">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--color-fg-muted)]">
          {getProjectFileTypeLabel(file, t)}
          {' · '}
          {formatFileSize(file.size)} · {file.mime_type}
        </span>
        {file.source_message_id && onLocateMessage ? (
          <button
            type="button"
            className="image-preview-link"
            onClick={() => {
              onLocateMessage(file.source_message_id!);
              onClose?.();
            }}
          >
            {t('files.locateMessage')}
          </button>
        ) : null}
        {isUploadedFile && file.url ? (
          <a href={file.url} target="_blank" rel="noreferrer" className="image-preview-link">
            {t('files.openOriginal')}
          </a>
        ) : null}
        {isUploadedFile && file.url ? (
          <a href={file.url} download={file.original_name} className="image-preview-link">
            {t('files.download')}
          </a>
        ) : null}
      </div>
      <dl className="file-preview-details" aria-label={t('files.details')}>
        <div>
          <dt>{t('files.sourceFilter')}</dt>
          <dd>{getProjectFileTypeLabel(file, t)}</dd>
        </div>
        <div>
          <dt>{isAgentDocument ? t('files.detail.sourceAgent') : t('files.detail.uploadedBy')}</dt>
          <dd title={sourceSummary}>{sourceSummary}</dd>
        </div>
        <div>
          <dt>{t('files.detail.createdAt')}</dt>
          <dd>{formatRelativeTime(file.created_at)}</dd>
        </div>
        {file.uploaded_by_name ? (
          <div>
            <dt>{t('files.detail.uploadedBy')}</dt>
            <dd>{file.uploaded_by_name}</dd>
          </div>
        ) : null}
        {file.source_agent_id ? (
          <div>
            <dt>{t('files.detail.sourceAgent')}</dt>
            <dd>{file.source_agent_id}</dd>
          </div>
        ) : null}
        {file.source_task_id ? (
          <div>
            <dt>{t('files.detail.sourceTask')}</dt>
            <dd>{file.source_task_id}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

function ResourceSourceTrace({
  title,
  summary,
  items,
}: {
  title: string;
  summary: string;
  items: Array<string | null | undefined>;
}): JSX.Element {
  const visibleItems = items.filter((item): item is string => !!item);

  return (
    <section className="file-preview-source-trace" aria-label={title}>
      <span className="file-preview-source-title">{title}</span>
      <span className="file-preview-source-summary" title={summary}>{summary}</span>
      {visibleItems.length > 0 ? (
        <span className="file-preview-source-items">
          {visibleItems.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </span>
      ) : null}
    </section>
  );
}

function ProjectFilePreviewBody({ file }: { file: ProjectFile }): JSX.Element {
  const { t } = useI18n();

  if (file.source_type === 'agent_document') {
    const content = file.content?.trim();
    return (
      <div className="file-preview-markdown">
        {content ? (
          <MarkdownPreview content={content} />
        ) : (
          <div className="files-empty">{t('files.documentEmpty')}</div>
        )}
      </div>
    );
  }

  if (file.mime_type.startsWith('image/')) {
    return (
      <div className="file-preview-stage">
        <img src={file.url} alt={file.original_name} />
      </div>
    );
  }

  if (file.mime_type === 'application/pdf' || file.mime_type.startsWith('text/')) {
    return <iframe className="file-preview-frame" src={file.url} title={file.original_name} />;
  }

  return (
    <div className="files-empty">
      <Download className="h-4 w-4" strokeWidth={1.8} />
      {t('files.previewUnavailable')}
    </div>
  );
}
