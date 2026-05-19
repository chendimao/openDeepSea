import { Download } from 'lucide-react';
import { formatFileSize } from '../lib/composerModel';
import { useI18n } from '../lib/i18n';
import type { ProjectFile } from '../lib/types';
import { MarkdownPreview } from './MessageContent';
import { Dialog, DialogContent } from './ui/Dialog';

interface ProjectFilePreviewDialogProps {
  file: ProjectFile | null;
  onOpenChange: (open: boolean) => void;
  onLocateMessage?: (messageId: string) => void;
}

export function ProjectFilePreviewDialog({
  file,
  onOpenChange,
  onLocateMessage,
}: ProjectFilePreviewDialogProps): JSX.Element {
  return (
    <Dialog open={!!file} onOpenChange={onOpenChange}>
      <DialogContent className="file-preview-dialog" title={file?.original_name}>
        {file && (
          <ProjectFilePreviewContent
            file={file}
            onLocateMessage={onLocateMessage}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
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

  return (
    <div className="file-preview-shell">
      <ProjectFilePreviewBody file={file} />
      <div className="file-preview-footer">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--color-fg-muted)]">
          {file.source_type === 'agent_document'
            ? t('files.source.agentDocument')
            : t('files.source.uploadedFile')}
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
        {file.url ? (
          <a href={file.url} target="_blank" rel="noreferrer" className="image-preview-link">
            {t('files.openOriginal')}
          </a>
        ) : null}
        {file.url && file.source_type === 'uploaded_file' ? (
          <a href={file.url} download={file.original_name} className="image-preview-link">
            {t('files.download')}
          </a>
        ) : null}
      </div>
      <dl className="file-preview-details" aria-label={t('files.details')}>
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
