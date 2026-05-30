import { useState } from 'react';
import { Download, FileText } from 'lucide-react';
import type { MessageAttachmentMetadata } from '../../lib/types';
import { useI18n } from '../../lib/i18n';
import { Dialog, DialogContent } from '../ui/Dialog';

export function MessageAttachments({ attachments }: { attachments: MessageAttachmentMetadata[] }): JSX.Element | null {
  const { t } = useI18n();
  const [preview, setPreview] = useState<MessageAttachmentMetadata | null>(null);
  if (attachments.length === 0) return null;

  return (
    <>
      <div className="message-attachments">
        {attachments.map((attachment) => {
          if (attachment.deleted) {
            return (
              <div key={attachment.id} className="message-attachment-card is-deleted">
                <span className="message-attachment-icon" aria-hidden="true">
                  <FileText className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-[12px] font-medium text-[var(--color-fg)]">{attachment.name}</span>
                  <span className="block truncate text-[10.5px] font-mono text-[var(--color-fg-muted)]">
                    {t('message.attachmentDeleted')}
                  </span>
                </span>
              </div>
            );
          }

          const content = (
            <>
              {attachment.isImage ? (
                <img src={attachment.url} alt={attachment.name} loading="lazy" />
              ) : (
                <span className="message-attachment-icon" aria-hidden="true">
                  <FileText className="h-4 w-4" />
                </span>
              )}
              <span className="min-w-0 flex-1 text-left">
                <span className="block truncate text-[12px] font-medium text-[var(--color-fg)]">{attachment.name}</span>
                <span className="block truncate text-[10.5px] font-mono text-[var(--color-fg-muted)]">
                  {formatAttachmentSize(attachment.size)} · {attachment.mimeType}
                </span>
              </span>
              <Download className="h-3.5 w-3.5 text-[var(--color-fg-muted)]" aria-hidden="true" />
            </>
          );

          return attachment.isImage ? (
            <button
              key={attachment.id}
              type="button"
              className="message-attachment-card is-image"
              onClick={() => setPreview(attachment)}
              aria-label={t('message.previewImage', { name: attachment.name })}
            >
              {content}
            </button>
          ) : (
            <a
              key={attachment.id}
              href={attachment.url}
              target="_blank"
              rel="noreferrer"
              className="message-attachment-card"
            >
              {content}
            </a>
          );
        })}
      </div>

      <Dialog open={!!preview} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="image-preview-dialog" title={preview?.name}>
          {preview && (
            <div className="image-preview-shell">
              <div className="image-preview-stage">
                <img src={preview.url} alt={preview.name} />
              </div>
              <div className="image-preview-footer">
                <span className="min-w-0 flex-1 truncate text-[11px] font-mono text-[var(--color-fg-muted)]">
                  {formatAttachmentSize(preview.size)} · {preview.mimeType}
                </span>
                <a href={preview.url} target="_blank" rel="noreferrer" className="image-preview-link">
                  {t('message.openOriginal')}
                </a>
                <a href={preview.url} download={preview.name} className="image-preview-link">
                  {t('message.download')}
                </a>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function formatAttachmentSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return '0 B';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size >= 10 * 1024 ? 0 : 1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
