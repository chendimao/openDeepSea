import { type DragEvent, type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Files, Image, Paperclip, Send, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  MAX_MESSAGE_FILES,
  findUniqueAgentMention,
  formatFileSize,
  validatePendingFiles,
} from '../lib/composerModel';
import { useI18n } from '../lib/i18n';
import type { ProjectFile, RoomAgent } from '../lib/types';
import { FilePickerDialog } from './FilePickerDialog';
import { PromptArea } from './prompt-area/prompt-area';
import { getChipsByTrigger, isSegmentsEmpty, segmentsToPlainText } from './prompt-area/segment-helpers';
import type { PromptAreaHandle, Segment } from './prompt-area/types';
import { AGENT_TRIGGER, buildComposerTriggers } from './RichMessageComposer.triggers';
import {
  PromptInputActions,
  PromptInputAttachmentShelf,
  PromptInputHint,
  PromptInputShell,
  PromptInputToolbar,
} from './ai-elements/PromptInput';
import { Button } from './ui/Button';
import { getExplicitReplyToMessageId, type ComposerReplyTarget } from './RichMessageComposer.model';

interface RichMessageComposerProps {
  projectId: string;
  agents: RoomAgent[];
  sending: boolean;
  disabled: boolean;
  placeholder: string;
  routingHint: string;
  resetKey: number;
  replyTarget?: ComposerReplyTarget | null;
  onClearReplyTarget?: () => void;
  onSend: (input: {
    content: string;
    mentions?: string[];
    files?: File[];
    fileIds?: string[];
    replyToMessageId?: string;
  }) => void;
}

type ComposerAttachment =
  | { kind: 'local'; id: string; file: File; previewUrl: string | null }
  | { kind: 'project'; id: string; file: ProjectFile };

export function RichMessageComposer({
  projectId,
  agents,
  sending,
  disabled,
  placeholder,
  routingHint,
  resetKey,
  replyTarget,
  onClearReplyTarget,
  onSend,
}: RichMessageComposerProps): JSX.Element {
  const promptAreaRef = useRef<PromptAreaHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  const didMountRef = useRef(false);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const { t } = useI18n();
  const isBusy = sending || disabled;
  const hasContent = !isSegmentsEmpty(segments);

  const triggers = useMemo(() => buildComposerTriggers({
    agents,
    labels: {
      mentionMenuAria: t('mention.menuAria'),
      mentionEmpty: t('mention.empty'),
    },
  }), [agents, t]);

  const revokeAttachment = (attachment: ComposerAttachment) => {
    if (attachment.kind === 'local' && attachment.previewUrl) {
      URL.revokeObjectURL(attachment.previewUrl);
    }
  };

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    return () => {
      for (const attachment of attachmentsRef.current) {
        revokeAttachment(attachment);
      }
    };
  }, []);

  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }

    for (const attachment of attachmentsRef.current) {
      revokeAttachment(attachment);
    }
    attachmentsRef.current = [];
    setAttachments([]);
    setSegments([]);
    promptAreaRef.current?.clear();
  }, [resetKey]);

  const addFiles = (fileList: FileList | File[]) => {
    if (isBusy) return;

    const files = Array.from(fileList);
    if (files.length === 0) return;

    const error = validatePendingFiles(attachmentsRef.current.length, files, {
      maxFiles: (count) => t('composer.error.maxFiles', { count }),
      fileTooLarge: (name, size) => t('composer.error.fileTooLarge', { name, size }),
    });
    if (error) {
      toast.error(error);
      return;
    }

    const nextAttachments = files.map((file) => ({
      id: crypto.randomUUID(),
      kind: 'local' as const,
      file,
      previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
    }));

    setAttachments((current) => {
      const next = [...current, ...nextAttachments];
      attachmentsRef.current = next;
      return next;
    });
  };

  const addProjectFiles = (files: ProjectFile[]) => {
    if (isBusy || files.length === 0) return;

    const existingProjectIds = new Set(
      attachmentsRef.current
        .filter((attachment) => attachment.kind === 'project')
        .map((attachment) => attachment.file.id),
    );
    const nextFiles = files.filter((file) => !existingProjectIds.has(file.id));
    if (nextFiles.length === 0) return;

    if (attachmentsRef.current.length + nextFiles.length > MAX_MESSAGE_FILES) {
      toast.error(t('composer.error.maxFiles', { count: MAX_MESSAGE_FILES }));
      return;
    }

    setAttachments((current) => {
      const next = [
        ...current,
        ...nextFiles.map((file) => ({
          id: `project:${file.id}`,
          kind: 'project' as const,
          file,
        })),
      ];
      attachmentsRef.current = next;
      return next;
    });
  };

  const removeAttachment = (id: string) => {
    setAttachments((current) => {
      const target = current.find((attachment) => attachment.id === id);
      if (target) revokeAttachment(target);
      const next = current.filter((attachment) => attachment.id !== id);
      attachmentsRef.current = next;
      return next;
    });
  };

  const handleSubmit = (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (isBusy) return;

    const content = segmentsToPlainText(segments).trim();

    if (!content && attachmentsRef.current.length === 0) return;

    const mentionedRoomAgentIds = [
      ...getChipsByTrigger(segments, AGENT_TRIGGER).map((chip) => chip.value),
      ...findTypedMentionRoomAgentIds(content, agents),
    ]
      .filter((value, index, values) => values.indexOf(value) === index);

    const localFiles = attachmentsRef.current
      .filter((attachment): attachment is Extract<ComposerAttachment, { kind: 'local' }> => attachment.kind === 'local')
      .map((attachment) => attachment.file);
    const fileIds = attachmentsRef.current
      .filter((attachment): attachment is Extract<ComposerAttachment, { kind: 'project' }> => attachment.kind === 'project')
      .map((attachment) => attachment.file.id);

    onSend({
      content,
      mentions: mentionedRoomAgentIds.length > 0 ? mentionedRoomAgentIds : undefined,
      files: localFiles.length > 0 ? localFiles : undefined,
      fileIds: fileIds.length > 0 ? fileIds : undefined,
      replyToMessageId: getExplicitReplyToMessageId(replyTarget),
    });
  };

  const sendDisabled = isBusy || (!hasContent && attachments.length === 0);

  const handleFileDrop = (event: DragEvent<HTMLFormElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return;

    event.preventDefault();
    event.stopPropagation();
    if (isBusy) return;

    addFiles(Array.from(event.dataTransfer.files));
  };

  return (
    <form
      className="rich-composer-box relative"
      data-testid="chat-composer"
      onSubmit={handleSubmit}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        event.stopPropagation();
      }}
      onDrop={handleFileDrop}
    >
      {replyTarget && (
        <div className="composer-reply-preview">
          <ReplyPreviewLabel explicit={replyTarget.explicit} senderName={replyTarget.senderName} />
          <span className="composer-reply-excerpt">{replyTarget.excerpt}</span>
          {onClearReplyTarget && (
            <button
              type="button"
              className="composer-reply-clear"
              onClick={onClearReplyTarget}
              aria-label="取消引用"
              disabled={isBusy}
            >
              <X className="h-3.5 w-3.5" strokeWidth={1.9} />
            </button>
          )}
        </div>
      )}
      <PromptInputShell>
        <PromptArea
          ref={promptAreaRef}
          value={segments}
          onChange={setSegments}
          triggers={triggers}
          placeholder={placeholder}
          disabled={isBusy}
          minHeight={44}
          maxHeight={152}
          autoGrow
          markdown
          aria-label={placeholder}
          onSubmit={() => handleSubmit()}
          onImagePaste={(file) => addFiles([file])}
        />
        {attachments.length > 0 && (
          <PromptInputAttachmentShelf aria-label={t('composer.attachmentsAria')}>
            {attachments.map((attachment) => (
              <div className="composer-attachment" key={attachment.id}>
                {isAttachmentImage(attachment) ? (
                  <img src={getAttachmentPreviewUrl(attachment)} alt={getAttachmentName(attachment)} />
                ) : (
                  <div className="composer-attachment-file">
                    <Paperclip className="h-4 w-4" strokeWidth={1.75} />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-medium text-[var(--color-fg)]">
                    {getAttachmentName(attachment)}
                  </div>
                  <div className="text-[11px] text-[var(--color-muted)]">
                    {formatFileSize(getAttachmentSize(attachment))}
                  </div>
                </div>
                <button
                  type="button"
                  className="composer-attachment-remove"
                  onClick={() => removeAttachment(attachment.id)}
                  aria-label={t('composer.removeAttachment', { name: getAttachmentName(attachment) })}
                  disabled={isBusy}
                >
                  <X className="h-3.5 w-3.5" strokeWidth={1.9} />
                </button>
              </div>
            ))}
          </PromptInputAttachmentShelf>
        )}

        <PromptInputToolbar>
          <PromptInputHint>{routingHint}</PromptInputHint>
          <PromptInputActions>
          <input
            ref={fileInputRef}
            type="file"
            className="sr-only"
            multiple
            onChange={(event) => {
              if (event.currentTarget.files) addFiles(event.currentTarget.files);
              event.currentTarget.value = '';
            }}
            disabled={isBusy}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="composer-action-button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isBusy}
            aria-label={t('composer.selectAttachment')}
            title={t('composer.selectAttachment')}
          >
            <Image className="h-4 w-4" strokeWidth={1.75} />
          </Button>
          <FilePickerDialog
            projectId={projectId}
            selectedFileIds={attachments
              .filter((attachment) => attachment.kind === 'project')
              .map((attachment) => attachment.file.id)}
            disabled={isBusy}
            onSelect={addProjectFiles}
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="composer-action-button"
              disabled={isBusy}
              aria-label={t('composer.selectProjectFile')}
              title={t('composer.selectProjectFile')}
            >
              <Files className="h-4 w-4" strokeWidth={1.75} />
            </Button>
          </FilePickerDialog>
          <Button
            type="submit"
            size="sm"
            className="composer-action-button"
            disabled={sendDisabled}
            aria-label={t('composer.sendMessage')}
          >
            <Send className="h-4 w-4" strokeWidth={1.75} />
            {t('composer.send')}
          </Button>
          </PromptInputActions>
        </PromptInputToolbar>
      </PromptInputShell>
    </form>
  );
}

function ReplyPreviewLabel({ explicit, senderName }: { explicit: boolean; senderName: string }) {
  return (
    <span className="composer-reply-label">
      {explicit ? '回复' : '默认回复'} {senderName}
    </span>
  );
}

function getAttachmentName(attachment: ComposerAttachment): string {
  return attachment.kind === 'local' ? attachment.file.name : attachment.file.original_name;
}

function getAttachmentSize(attachment: ComposerAttachment): number {
  return attachment.kind === 'local' ? attachment.file.size : attachment.file.size;
}

function getAttachmentPreviewUrl(attachment: ComposerAttachment): string {
  return attachment.kind === 'local' ? attachment.previewUrl ?? '' : attachment.file.url;
}

function isAttachmentImage(attachment: ComposerAttachment): boolean {
  return attachment.kind === 'local'
    ? Boolean(attachment.previewUrl)
    : attachment.file.mime_type.startsWith('image/');
}

function findTypedMentionRoomAgentIds(content: string, agents: RoomAgent[]): string[] {
  const ids: string[] = [];
  const mentionPattern = /@([\p{L}\p{N}_.-]+)/gu;

  for (const match of content.matchAll(mentionPattern)) {
    const agent = findUniqueAgentMention(match[1], agents);
    if (agent) ids.push(agent.id);
  }

  return ids;
}
