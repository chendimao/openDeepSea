import { Eye, FileText, Image as ImageIcon, Paperclip } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import {
  MarkdownPreview,
  MessageContent,
  isMarkdownMessageContent,
  type WorkspaceFileOpenHandler,
} from '../components/MessageContent';
import { Dialog, DialogContent } from '../components/ui/Dialog';
import { formatFileSize } from '../lib/composerModel';
import type { MessageAttachmentMetadata } from '../lib/types';

export type SessionMessageBubbleRole = 'user' | 'assistant' | 'system';
export type SessionMessageDisplayMode = 'preview' | 'source';

export function SessionMessageBubble({
  role,
  content,
  previewContent,
  timeLabel,
  statusLabel,
  actions,
  roleLabel,
  attachments = [],
  displayMode,
  onDisplayModeChange,
  onOpenWorkspaceFile,
  structuredContent,
}: {
  role: SessionMessageBubbleRole;
  content: string;
  previewContent?: string;
  timeLabel: string;
  statusLabel?: string | null;
  actions?: ReactNode;
  roleLabel?: string;
  attachments?: MessageAttachmentMetadata[];
  displayMode?: SessionMessageDisplayMode;
  onDisplayModeChange?: (mode: SessionMessageDisplayMode) => void;
  onOpenWorkspaceFile?: WorkspaceFileOpenHandler;
  structuredContent?: ReactNode;
}): JSX.Element {
  const [localDisplayMode, setLocalDisplayMode] = useState<SessionMessageDisplayMode>('preview');
  const activeDisplayMode = displayMode ?? localDisplayMode;
  const setDisplayMode = onDisplayModeChange ?? setLocalDisplayMode;
  const displayContent = activeDisplayMode === 'source' ? content : previewContent ?? content;
  const label = roleLabel ?? (role === 'assistant' ? 'ASSISTANT' : role.toUpperCase());

  return (
    <article className="deepsea-message" data-role={role}>
      <header>
        <span>{label}</span>
        <time className="deepsea-mono">{timeLabel}</time>
        {statusLabel && <strong>{statusLabel}</strong>}
        <div className="deepsea-message-tools">
          {actions}
          <MarkdownDisplaySwitch content={content} mode={activeDisplayMode} onModeChange={setDisplayMode} />
        </div>
      </header>
      <div className="deepsea-message-body">
        {structuredContent && activeDisplayMode === 'preview' ? (
          structuredContent
        ) : previewContent && activeDisplayMode === 'preview' ? (
          <MarkdownPreview content={displayContent} onOpenWorkspaceFile={onOpenWorkspaceFile} />
        ) : (
          <MessageContent
            content={displayContent}
            mode={activeDisplayMode}
            suppressTraceEvents
            onOpenWorkspaceFile={activeDisplayMode === 'preview' ? onOpenWorkspaceFile : undefined}
          />
        )}
        <SessionMessageAttachments attachments={attachments} />
      </div>
    </article>
  );
}

function SessionMessageAttachments({
  attachments,
}: {
  attachments: MessageAttachmentMetadata[];
}): JSX.Element | null {
  const [previewAttachment, setPreviewAttachment] = useState<MessageAttachmentMetadata | null>(null);
  if (attachments.length === 0) return null;
  return (
    <>
      <div className="deepsea-message-attachments" aria-label="消息附件">
        {attachments.map((attachment) => {
          if (attachment.deleted) {
            return (
              <span
                key={attachment.id}
                className="deepsea-message-attachment"
                data-deleted="true"
              >
                <SessionMessageAttachmentContent attachment={attachment} />
              </span>
            );
          }
          if (attachment.isImage) {
            return (
              <button
                key={attachment.id}
                type="button"
                className="deepsea-message-attachment"
                aria-label={`预览图片附件：${attachment.name}`}
                onClick={() => setPreviewAttachment(attachment)}
              >
                <SessionMessageAttachmentContent attachment={attachment} />
              </button>
            );
          }
          return (
            <a
              key={attachment.id}
              className="deepsea-message-attachment"
              href={attachment.url}
              target="_blank"
              rel="noreferrer"
            >
              <SessionMessageAttachmentContent attachment={attachment} />
            </a>
          );
        })}
      </div>
      <Dialog open={!!previewAttachment} onOpenChange={(open) => !open && setPreviewAttachment(null)}>
        <DialogContent className="deepsea-message-image-preview" title={previewAttachment?.name}>
          {previewAttachment && (
            <div className="deepsea-message-image-preview__stage">
              <img src={previewAttachment.url} alt={previewAttachment.name} />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function SessionMessageAttachmentContent({
  attachment,
}: {
  attachment: MessageAttachmentMetadata;
}): JSX.Element {
  return (
    <>
      <span className="deepsea-message-attachment__thumb">
        {attachment.isImage && !attachment.deleted ? (
          <img src={attachment.url} alt="" />
        ) : attachment.isImage ? (
          <ImageIcon aria-hidden="true" />
        ) : (
          <Paperclip aria-hidden="true" />
        )}
      </span>
      <span className="deepsea-message-attachment__body">
        <strong title={attachment.name}>{attachment.name}</strong>
        <small>{formatSessionAttachmentMeta(attachment)}</small>
      </span>
    </>
  );
}

function formatSessionAttachmentMeta(attachment: MessageAttachmentMetadata): string {
  return [
    attachment.deleted ? '已删除' : null,
    formatFileSize(attachment.size),
    attachment.mimeType,
  ].filter(Boolean).join(' · ');
}

export function MarkdownDisplaySwitch({
  content,
  mode,
  onModeChange,
}: {
  content: string;
  mode: SessionMessageDisplayMode;
  onModeChange: (mode: SessionMessageDisplayMode) => void;
}): JSX.Element | null {
  if (!isMarkdownMessageContent(content)) return null;
  return (
    <div className="deepsea-markdown-switch" aria-label="Markdown 显示模式">
      <button
        type="button"
        className={mode === 'preview' ? 'is-active' : undefined}
        aria-label="预览"
        aria-pressed={mode === 'preview'}
        onClick={() => onModeChange('preview')}
      >
        <Eye aria-hidden="true" />
        <span>预览</span>
      </button>
      <button
        type="button"
        className={mode === 'source' ? 'is-active' : undefined}
        aria-label="源码"
        aria-pressed={mode === 'source'}
        onClick={() => onModeChange('source')}
      >
        <FileText aria-hidden="true" />
        <span>源码</span>
      </button>
    </div>
  );
}
