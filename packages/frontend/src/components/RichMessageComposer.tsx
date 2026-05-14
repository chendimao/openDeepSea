import {
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Image, Paperclip, Send, X } from 'lucide-react';
import { toast } from 'sonner';
import type { ComposerNode, PendingAttachment } from '../lib/composerModel';
import {
  createEmptyComposerNodes,
  formatFileSize,
  normalizeTypedMentions,
  serializeComposerNodes,
  validatePendingFiles,
} from '../lib/composerModel';
import type { RoomAgent } from '../lib/types';
import { AgentMentionMenu } from './AgentMentionMenu';
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

const mentionQueryPattern = /@([\p{L}\p{N}_.-]*)$/u;

export function RichMessageComposer({
  agents,
  sending,
  disabled,
  placeholder,
  routingHint,
  resetKey,
  onSend,
}: RichMessageComposerProps): JSX.Element {
  const editorRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef<AttachmentPreview[]>([]);
  const didMountRef = useRef(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<AttachmentPreview[]>([]);
  const [hasContent, setHasContent] = useState(false);
  const isBusy = sending || disabled;

  const revokeAttachment = (attachment: AttachmentPreview) => {
    if (attachment.previewUrl) {
      URL.revokeObjectURL(attachment.previewUrl);
    }
  };

  const renderNodes = useCallback((nodes: ComposerNode[]) => {
    const editor = editorRef.current;
    if (!editor) return;

    const domNodes = nodes.flatMap((node) => renderNode(node));
    editor.replaceChildren(...domNodes);
    setHasContent(readPlainText(editor).trim().length > 0);
  }, []);

  const normalizeEditor = useCallback((): ComposerNode[] => {
    const editor = editorRef.current;
    if (!editor) return createEmptyComposerNodes();

    const nodes = normalizeTypedMentions(readNodesFromEditor(editor), agents);
    renderNodes(nodes);
    return nodes;
  }, [agents, renderNodes]);

  const updateMentionQuery = useCallback(() => {
    if (sending) {
      setMentionQuery(null);
      return;
    }

    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0 || !editor.contains(selection.anchorNode)) {
      setMentionQuery(null);
      return;
    }

    const textBeforeCursor = getTextBeforeCursor(editor, selection.getRangeAt(0));
    const match = textBeforeCursor.match(mentionQueryPattern);
    setMentionQuery(match ? match[1] : null);
  }, [sending]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    if (sending) setMentionQuery(null);
  }, [sending]);

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
    setMentionQuery(null);
    renderNodes(createEmptyComposerNodes());
  }, [renderNodes, resetKey]);

  const addFiles = (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    if (files.length === 0) return;

    const error = validatePendingFiles(attachmentsRef.current.length, files);
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

  const handleInput = () => {
    const editor = editorRef.current;
    setHasContent(!!editor && readPlainText(editor).trim().length > 0);
    updateMentionQuery();
  };

  const handleSelectAgent = (agent: RoomAgent) => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return;

    replaceMentionQueryWithText(editor, range, agent);
    renderNodes(normalizeTypedMentions(readNodesFromEditor(editor), agents));
    placeCursorAtEnd(editor);
    setMentionQuery(null);
    setHasContent(readPlainText(editor).trim().length > 0);
  };

  const handleSubmit = (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (isBusy) return;

    setMentionQuery(null);
    const nodes = normalizeEditor();
    const serialized = serializeComposerNodes(nodes);
    const content = serialized.content.trim();

    if (content.startsWith('/task') && attachmentsRef.current.length > 0) {
      toast.error('/task 消息暂不支持附件');
      return;
    }

    if (!content && attachmentsRef.current.length === 0) return;

    onSend({
      content,
      mentions: serialized.roomAgentIds.length > 0 ? serialized.roomAgentIds : undefined,
      files: attachmentsRef.current.length > 0 ? attachmentsRef.current.map((attachment) => attachment.file) : undefined,
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && mentionQuery !== null) {
      event.preventDefault();
      setMentionQuery(null);
      return;
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSubmit();
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;

    event.preventDefault();
    addFiles(files);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) return;

    event.preventDefault();
    addFiles(files);
  };

  const sendDisabled = isBusy || (!hasContent && attachments.length === 0);

  return (
    <form className="relative" onSubmit={handleSubmit}>
      {mentionQuery !== null && !sending && (
        <AgentMentionMenu agents={agents} query={mentionQuery} onSelect={handleSelectAgent} />
      )}

      <div
        className="rich-composer-box composer-box"
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) event.preventDefault();
        }}
        onDrop={handleDrop}
      >
        <div
          ref={editorRef}
          aria-label={placeholder}
          className="rich-composer-editor"
          contentEditable={!isBusy}
          data-placeholder={placeholder}
          onBlur={() => {
            normalizeEditor();
            setMentionQuery(null);
          }}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onSelect={updateMentionQuery}
          role="textbox"
          suppressContentEditableWarning
        />

        {attachments.length > 0 && (
          <div className="composer-attachments" aria-label="待发送附件">
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
                  aria-label={`移除 ${attachment.file.name}`}
                  disabled={isBusy}
                >
                  <X className="h-3.5 w-3.5" strokeWidth={1.9} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 truncate text-[11.5px] text-[var(--color-fg-muted)]">
            {routingHint}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
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
              onClick={() => fileInputRef.current?.click()}
              disabled={isBusy}
              aria-label="选择附件"
              title="选择附件"
            >
              <Image className="h-4 w-4" strokeWidth={1.75} />
            </Button>
            <Button type="submit" size="sm" disabled={sendDisabled} aria-label="发送消息">
              <Send className="h-4 w-4" strokeWidth={1.75} />
              发送
            </Button>
          </div>
        </div>
      </div>
    </form>
  );
}

function renderNode(node: ComposerNode): Node[] {
  if (node.type === 'text') {
    return node.text ? [document.createTextNode(node.text)] : [];
  }

  const token = document.createElement('span');
  token.className = 'composer-mention-token';
  token.contentEditable = 'false';
  token.dataset.roomAgentId = node.roomAgentId;
  token.dataset.agentName = node.agentName;
  token.textContent = `@${node.agentName}`;
  return [token];
}

function readNodesFromEditor(editor: HTMLDivElement): ComposerNode[] {
  const nodes: ComposerNode[] = [];

  editor.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      nodes.push({ type: 'text', text: child.textContent ?? '' });
      return;
    }

    if (child instanceof HTMLElement && child.classList.contains('composer-mention-token')) {
      const roomAgentId = child.dataset.roomAgentId;
      const agentName = child.dataset.agentName;
      if (roomAgentId && agentName) {
        nodes.push({ type: 'mention', roomAgentId, agentName });
        return;
      }
    }

    nodes.push({ type: 'text', text: child.textContent ?? '' });
  });

  return nodes.length > 0 ? nodes : createEmptyComposerNodes();
}

function readPlainText(editor: HTMLDivElement): string {
  return readNodesFromEditor(editor)
    .map((node) => (node.type === 'mention' ? `@${node.agentName}` : node.text))
    .join('');
}

function getTextBeforeCursor(editor: HTMLDivElement, range: Range): string {
  const before = range.cloneRange();
  before.selectNodeContents(editor);
  before.setEnd(range.endContainer, range.endOffset);
  return before.toString();
}

function replaceMentionQueryWithText(editor: HTMLDivElement, range: Range, agent: RoomAgent) {
  const textBeforeCursor = getTextBeforeCursor(editor, range);
  const match = textBeforeCursor.match(mentionQueryPattern);
  if (!match) return;

  const tokenLength = match[0].length;
  const replaceRange = range.cloneRange();
  let startNode: Node = range.endContainer;
  let startOffset = range.endOffset;

  while (tokenLength > startOffset && startNode.previousSibling) {
    startNode = startNode.previousSibling;
    startOffset += startNode.textContent?.length ?? 0;
  }

  replaceRange.setStart(startNode, Math.max(0, startOffset - tokenLength));
  replaceRange.deleteContents();
  replaceRange.insertNode(document.createTextNode(`@${agent.agent_name} `));
}

function placeCursorAtEnd(editor: HTMLDivElement) {
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  editor.focus();
}
