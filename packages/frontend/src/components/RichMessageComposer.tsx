import { type DragEvent, type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Image, Paperclip, Send, X } from 'lucide-react';
import { toast } from 'sonner';
import type { PendingAttachment } from '../lib/composerModel';
import {
  findUniqueAgentMention,
  formatFileSize,
  validatePendingFiles,
} from '../lib/composerModel';
import { useI18n } from '../lib/i18n';
import type { RoomAgent } from '../lib/types';
import { PromptArea } from './prompt-area/prompt-area';
import { getChipsByTrigger, isSegmentsEmpty, segmentsToPlainText } from './prompt-area/segment-helpers';
import type { PromptAreaHandle, Segment, TriggerConfig, TriggerSuggestion } from './prompt-area/types';
import {
  PromptInputActions,
  PromptInputAttachmentShelf,
  PromptInputHint,
  PromptInputShell,
  PromptInputToolbar,
} from './ai-elements/PromptInput';
import { Button } from './ui/Button';

interface RichMessageComposerProps {
  agents: RoomAgent[];
  sending: boolean;
  disabled: boolean;
  placeholder: string;
  routingHint: string;
  resetKey: number;
  onSend: (input: { content: string; mentions?: string[]; files?: File[] }) => void;
}

interface AttachmentPreview extends PendingAttachment {
  previewUrl: string | null;
}

const AGENT_TRIGGER = '@';

export function RichMessageComposer({
  agents,
  sending,
  disabled,
  placeholder,
  routingHint,
  resetKey,
  onSend,
}: RichMessageComposerProps): JSX.Element {
  const promptAreaRef = useRef<PromptAreaHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef<AttachmentPreview[]>([]);
  const didMountRef = useRef(false);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [attachments, setAttachments] = useState<AttachmentPreview[]>([]);
  const { t } = useI18n();
  const isBusy = sending || disabled;
  const hasContent = !isSegmentsEmpty(segments);

  const agentTrigger = useMemo<TriggerConfig>(() => ({
    char: AGENT_TRIGGER,
    position: 'any',
    mode: 'dropdown',
    accessibilityLabel: t('mention.menuAria'),
    onSearch: (query) => searchAgents(agents, query),
    onSelect: (suggestion) => suggestion.label,
    emptyMessage: t('mention.empty'),
  }), [agents, t]);

  const revokeAttachment = (attachment: AttachmentPreview) => {
    if (attachment.previewUrl) {
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
      file,
      previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
    }));

    setAttachments((current) => {
      const next = [...current, ...nextAttachments];
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

    if (/^\/task\s+(.+)/.test(content) && attachmentsRef.current.length > 0) {
      toast.error(t('composer.taskNoAttachments'));
      return;
    }

    if (!content && attachmentsRef.current.length === 0) return;

    const mentionedRoomAgentIds = [
      ...getChipsByTrigger(segments, AGENT_TRIGGER).map((chip) => chip.value),
      ...findTypedMentionRoomAgentIds(content, agents),
    ]
      .filter((value, index, values) => values.indexOf(value) === index);

    onSend({
      content,
      mentions: mentionedRoomAgentIds.length > 0 ? mentionedRoomAgentIds : undefined,
      files: attachmentsRef.current.length > 0 ? attachmentsRef.current.map((attachment) => attachment.file) : undefined,
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
      onSubmit={handleSubmit}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        event.stopPropagation();
      }}
      onDrop={handleFileDrop}
    >
      <PromptInputShell>
        <PromptArea
          ref={promptAreaRef}
          value={segments}
          onChange={setSegments}
          triggers={[agentTrigger]}
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
                {attachment.previewUrl ? (
                  <img src={attachment.previewUrl} alt={attachment.file.name} />
                ) : (
                  <div className="composer-attachment-file">
                    <Paperclip className="h-4 w-4" strokeWidth={1.75} />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-medium text-[var(--color-fg)]">
                    {attachment.file.name}
                  </div>
                  <div className="text-[11px] text-[var(--color-muted)]">
                    {formatFileSize(attachment.file.size)}
                  </div>
                </div>
                <button
                  type="button"
                  className="composer-attachment-remove"
                  onClick={() => removeAttachment(attachment.id)}
                  aria-label={t('composer.removeAttachment', { name: attachment.file.name })}
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

function findTypedMentionRoomAgentIds(content: string, agents: RoomAgent[]): string[] {
  const ids: string[] = [];
  const mentionPattern = /@([\p{L}\p{N}_.-]+)/gu;

  for (const match of content.matchAll(mentionPattern)) {
    const agent = findUniqueAgentMention(match[1], agents);
    if (agent) ids.push(agent.id);
  }

  return ids;
}

function searchAgents(agents: RoomAgent[], query: string): TriggerSuggestion[] {
  const normalized = query.toLowerCase();
  return agents
    .filter((agent) => {
      const haystack = `${agent.agent_name} ${agent.agent_id}`.toLowerCase();
      return haystack.includes(normalized);
    })
    .slice(0, 6)
    .map((agent) => ({
      value: agent.id,
      label: agent.agent_name,
      data: agent,
    }));
}
