import {
  AlertTriangle,
  FileText,
  Hash,
  Image as ImageIcon,
  ImagePlus,
  Paperclip,
  SendHorizontal,
  X,
} from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { Dialog, DialogContent } from '../components/ui/Dialog';
import { MarkdownPreview } from '../components/MessageContent';
import { ImageGenerationDialog } from '../image-generation/ImageGenerationDialog';
import {
  buildAttachmentPreviewKind,
  buildSessionComposerSubmitFromText,
  formatComposerAttachmentMeta,
  getComposerAttachmentInteractionState,
  type ComposerAttachmentPreviewKind,
  type SessionComposerSubmit,
} from './session-file-composer-model';

const MAX_SESSION_ATTACHMENTS = 5;

type PendingSessionAttachment = {
  id: string;
  file: File;
  previewKind: ComposerAttachmentPreviewKind;
  objectUrl?: string;
};

type PreviewState =
  | { attachment: PendingSessionAttachment; content?: string; loading?: boolean; error?: string }
  | null;

export function SessionFileComposer({
  projectId,
  sessionId,
  onSendMessage,
}: {
  projectId: string;
  sessionId?: string;
  onSendMessage: (message: SessionComposerSubmit) => void;
}): JSX.Element {
  const [content, setContent] = useState('');
  const [attachments, setAttachments] = useState<PendingSessionAttachment[]>([]);
  const [preview, setPreview] = useState<PreviewState>(null);
  const [imageDialogOpen, setImageDialogOpen] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const attachmentsRef = useRef<PendingSessionAttachment[]>([]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => () => {
    for (const attachment of attachmentsRef.current) {
      if (attachment.objectUrl) URL.revokeObjectURL(attachment.objectUrl);
    }
  }, []);

  const canSubmit = !isUploading && (content.trim().length > 0 || attachments.length > 0);

  const addFiles = (files: File[]) => {
    if (files.length === 0) return;
    setError(null);
    const availableSlots = Math.max(0, MAX_SESSION_ATTACHMENTS - attachments.length);
    if (availableSlots === 0) {
      setError(`最多只能附加 ${MAX_SESSION_ATTACHMENTS} 个文件`);
      return;
    }
    const acceptedFiles = files.slice(0, availableSlots);
    if (acceptedFiles.length < files.length) {
      setError(`最多只能附加 ${MAX_SESSION_ATTACHMENTS} 个文件`);
    }
    setAttachments((current) => [
      ...current,
      ...acceptedFiles.map(createPendingAttachment),
    ]);
  };

  const removeAttachment = (attachment: PendingSessionAttachment) => {
    setAttachments((current) => current.filter((item) => item.id !== attachment.id));
    if (attachment.objectUrl) URL.revokeObjectURL(attachment.objectUrl);
    setPreview((current) => current?.attachment.id === attachment.id ? null : current);
  };

  const submit = async () => {
    if (!canSubmit) return;
    setError(null);
    setIsUploading(true);
    try {
      const uploadedFiles = attachments.length > 0
        ? await api.uploadProjectFiles(projectId, attachments.map((attachment) => attachment.file))
        : [];
      const message = buildSessionComposerSubmitFromText({ content, uploadedFiles });
      if (!message) return;
      onSendMessage(message);
      clearComposer();
    } catch (err) {
      setError(err instanceof Error ? err.message : '附件上传失败');
    } finally {
      setIsUploading(false);
    }
  };

  const clearComposer = () => {
    for (const attachment of attachments) {
      if (attachment.objectUrl) URL.revokeObjectURL(attachment.objectUrl);
    }
    setAttachments([]);
    setPreview(null);
    setContent('');
    textareaRef.current?.focus();
  };

  return (
    <>
      <form
        className="deepsea-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="deepsea-composer__field">
          {attachments.length > 0 && (
            <AttachmentStrip
              attachments={attachments}
              isUploading={isUploading}
              onPreview={setPreview}
              onRemove={removeAttachment}
            />
          )}
          <textarea
            ref={textareaRef}
            className="deepsea-composer__textarea"
            data-session-composer-textarea="true"
            value={content}
            rows={2}
            aria-label="命令输入"
            disabled={isUploading}
            placeholder="输入消息，粘贴文件会上传到项目文件库"
            onChange={(event) => setContent(event.currentTarget.value)}
            onPaste={(event) => {
              const files = filesFromClipboard(event.clipboardData);
              if (files.length === 0) return;
              const pastedText = event.clipboardData.getData('text/plain');
              event.preventDefault();
              if (pastedText) {
                const textarea = event.currentTarget;
                const selectionStart = textarea.selectionStart ?? textarea.value.length;
                const selectionEnd = textarea.selectionEnd ?? selectionStart;
                const nextContent = insertTextAtSelection(textarea.value, pastedText, selectionStart, selectionEnd);
                const nextCaret = selectionStart + pastedText.length;
                setContent(nextContent);
                queueMicrotask(() => {
                  textarea.selectionStart = nextCaret;
                  textarea.selectionEnd = nextCaret;
                });
              }
              addFiles(files);
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              void submit();
            }}
          />
          <div className="deepsea-composer__tools">
            <Paperclip aria-hidden="true" />
            <Hash aria-hidden="true" />
            <AlertTriangle aria-hidden="true" />
            <span className="deepsea-composer__upload-hint">
              {isUploading ? '上传中...' : '粘贴文件会上传到项目文件库'}
            </span>
            {sessionId && (
              <button
                type="button"
                className="deepsea-composer-tool-button"
                aria-label="生成图片"
                disabled={isUploading}
                onClick={() => setImageDialogOpen(true)}
              >
                <ImagePlus aria-hidden="true" />
              </button>
            )}
            <button type="submit" className="deepsea-send-button" aria-label="发送" disabled={!canSubmit}>
              <SendHorizontal aria-hidden="true" />
            </button>
          </div>
          {error && <p className="deepsea-composer__error">{error}</p>}
        </div>
        <AttachmentPreviewDialog preview={preview} onPreviewChange={setPreview} />
      </form>
      {sessionId && (
        <ImageGenerationDialog
          projectId={projectId}
          sessionId={sessionId}
          open={imageDialogOpen}
          onOpenChange={setImageDialogOpen}
        />
      )}
    </>
  );
}

function AttachmentStrip({
  attachments,
  isUploading,
  onPreview,
  onRemove,
}: {
  attachments: PendingSessionAttachment[];
  isUploading: boolean;
  onPreview: (preview: PreviewState) => void;
  onRemove: (attachment: PendingSessionAttachment) => void;
}): JSX.Element {
  const interaction = getComposerAttachmentInteractionState({ isUploading });
  return (
    <div className="deepsea-composer-attachments" role="list" aria-label="待发送附件">
      {attachments.map((attachment) => (
        <div
          key={attachment.id}
          className="deepsea-composer-attachment"
          role="listitem"
        >
          <button
            type="button"
            className="deepsea-composer-attachment__preview"
            disabled={!interaction.canPreview}
            onClick={() => onPreview({
              attachment,
              ...(attachment.previewKind === 'text' ? { loading: true } : {}),
            })}
          >
            <AttachmentThumb attachment={attachment} />
            <span className="deepsea-composer-attachment__body">
              <strong title={attachment.file.name}>{attachment.file.name}</strong>
              <small>{formatComposerAttachmentMeta(attachment.file)}</small>
            </span>
          </button>
          <button
            type="button"
            aria-label={`移除 ${attachment.file.name}`}
            className="deepsea-composer-attachment__remove"
            disabled={!interaction.canRemove}
            onClick={() => onRemove(attachment)}
          >
            <X aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}

function AttachmentThumb({ attachment }: { attachment: PendingSessionAttachment }): JSX.Element {
  if (attachment.previewKind === 'image' && attachment.objectUrl) {
    return <img className="deepsea-composer-attachment__image" src={attachment.objectUrl} alt="" />;
  }
  const Icon = attachment.previewKind === 'text' ? FileText : ImageIcon;
  return (
    <span className="deepsea-composer-attachment__icon">
      <Icon aria-hidden="true" />
    </span>
  );
}

function AttachmentPreviewDialog({
  preview,
  onPreviewChange,
}: {
  preview: PreviewState;
  onPreviewChange: (preview: PreviewState) => void;
}): JSX.Element {
  const attachment = preview?.attachment;

  useEffect(() => {
    if (!attachment || attachment.previewKind !== 'text' || !preview?.loading || preview.content) return;
    let cancelled = false;
    attachment.file.text()
      .then((content) => {
        if (!cancelled) onPreviewChange({ attachment, content });
      })
      .catch((err) => {
        if (!cancelled) onPreviewChange({ attachment, error: err instanceof Error ? err.message : '文本预览失败' });
      });
    return () => {
      cancelled = true;
    };
  }, [attachment, onPreviewChange, preview?.content, preview?.loading]);

  return (
    <Dialog open={!!attachment} onOpenChange={(open) => !open && onPreviewChange(null)}>
      <DialogContent className="deepsea-attachment-preview" title={attachment?.file.name}>
        {attachment && <AttachmentPreviewBody preview={preview} attachment={attachment} />}
      </DialogContent>
    </Dialog>
  );
}

function AttachmentPreviewBody({
  preview,
  attachment,
}: {
  preview: PreviewState;
  attachment: PendingSessionAttachment;
}): JSX.Element {
  if (attachment.previewKind === 'image' && attachment.objectUrl) {
    return (
      <div className="deepsea-attachment-preview__stage">
        <img src={attachment.objectUrl} alt={attachment.file.name} />
      </div>
    );
  }
  if (attachment.previewKind === 'text') {
    if (preview?.loading) return <div className="deepsea-attachment-preview__state">读取文本...</div>;
    if (preview?.error) return <div className="deepsea-attachment-preview__state">{preview.error}</div>;
    const content = preview?.content ?? '';
    return (
      <div className="deepsea-attachment-preview__text">
        {attachment.file.name.toLowerCase().endsWith('.md') ? (
          <MarkdownPreview content={content} />
        ) : (
          <pre>{content}</pre>
        )}
      </div>
    );
  }
  return <div className="deepsea-attachment-preview__state">该文件类型暂不支持发送前预览。</div>;
}

function createPendingAttachment(file: File): PendingSessionAttachment {
  const previewKind = buildAttachmentPreviewKind(file);
  return {
    id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2)}`,
    file,
    previewKind,
    ...(previewKind === 'image' ? { objectUrl: URL.createObjectURL(file) } : {}),
  };
}

function filesFromClipboard(data: DataTransfer): File[] {
  const files = Array.from(data.files ?? []);
  if (files.length > 0) return files;
  return Array.from(data.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

function insertTextAtSelection(value: string, text: string, selectionStart: number, selectionEnd: number): string {
  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.max(start, Math.min(selectionEnd, value.length));
  return `${value.slice(0, start)}${text}${value.slice(end)}`;
}
