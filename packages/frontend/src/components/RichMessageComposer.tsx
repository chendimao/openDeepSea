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
const boundedMentionPattern = /@([\p{L}\p{N}_.-]+)([\s,.;:!?，。；：！？、])$/u;

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
    if (isBusy) {
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
  }, [isBusy]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    if (isBusy) setMentionQuery(null);
  }, [isBusy]);

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
    if (isBusy) return;

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
    if (!editor) return;

    normalizeBoundedMentionAtCursor(editor, agents);
    setHasContent(!!editor && readPlainText(editor).trim().length > 0);
    updateMentionQuery();
  };

  const handleSelectAgent = (agent: RoomAgent) => {
    if (isBusy) return;

    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return;

    insertMentionAtCurrentQuery(editor, range, agent);
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

    if (/^\/task\s+(.+)/.test(content) && attachmentsRef.current.length > 0) {
      toast.error('/task 命令不能携带附件，请先移除附件');
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
    if (isBusy) return;

    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;

    event.preventDefault();
    addFiles(files);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return;

    event.preventDefault();
    event.stopPropagation();

    if (isBusy) return;

    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) return;

    addFiles(files);
  };

  const sendDisabled = isBusy || (!hasContent && attachments.length === 0);

  return (
    <form className="relative" onSubmit={handleSubmit}>
      {mentionQuery !== null && !isBusy && (
        <AgentMentionMenu agents={agents} query={mentionQuery} onSelect={handleSelectAgent} />
      )}

      <div
        className="rich-composer-box composer-box"
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          event.stopPropagation();
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
              className="composer-action-button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isBusy}
              aria-label="选择附件"
              title="选择附件"
            >
              <Image className="h-4 w-4" strokeWidth={1.75} />
            </Button>
            <Button
              type="submit"
              size="sm"
              className="composer-action-button"
              disabled={sendDisabled}
              aria-label="发送消息"
            >
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

  return [createMentionElement(node.roomAgentId, node.agentName)];
}

function createMentionElement(roomAgentId: string, agentName: string): HTMLSpanElement {
  const token = document.createElement('span');
  token.className = 'composer-mention-token';
  token.contentEditable = 'false';
  token.dataset.roomAgentId = roomAgentId;
  token.dataset.agentName = agentName;
  token.textContent = `@${agentName}`;
  return token;
}

function readNodesFromEditor(editor: HTMLDivElement): ComposerNode[] {
  const nodes: ComposerNode[] = [];
  readChildNodes(editor, nodes, true);
  return nodes.length > 0 ? nodes : createEmptyComposerNodes();
}

function readChildNodes(parent: Node, nodes: ComposerNode[], appendBlockBreak: boolean) {
  parent.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      nodes.push({ type: 'text', text: child.textContent ?? '' });
      return;
    }

    if (!(child instanceof HTMLElement)) return;

    if (child.classList.contains('composer-mention-token')) {
      const roomAgentId = child.dataset.roomAgentId;
      const agentName = child.dataset.agentName;
      if (roomAgentId && agentName) {
        nodes.push({ type: 'mention', roomAgentId, agentName });
      }
      return;
    }

    if (child.tagName === 'BR') {
      nodes.push({ type: 'text', text: '\n' });
      return;
    }

    const isBlock = isBlockishElement(child);
    const lengthBefore = textLengthFromNodes(nodes);
    readChildNodes(child, nodes, isBlock);
    if (isBlock && appendBlockBreak && textLengthFromNodes(nodes) > lengthBefore) {
      nodes.push({ type: 'text', text: '\n' });
    }
  });
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

function insertMentionAtCurrentQuery(editor: HTMLDivElement, range: Range, agent: RoomAgent) {
  const match = getMentionQueryOffsets(editor, range);
  if (!match) return;

  replaceTextRangeWithMention(editor, match.start, match.end, agent);
}

function normalizeBoundedMentionAtCursor(editor: HTMLDivElement, agents: RoomAgent[]) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !editor.contains(selection.anchorNode)) return;

  const range = selection.getRangeAt(0);
  if (!range.collapsed) return;

  const cursorOffset = getLinearOffset(editor, range);
  const beforeCursor = getEditorLinearText(editor).slice(0, cursorOffset);
  const match = beforeCursor.match(boundedMentionPattern);
  if (!match || match.index === undefined) return;

  const normalized = normalizeTypedMentions([{ type: 'text', text: `@${match[1]}` }], agents);
  const mention = normalized.length === 1 && normalized[0].type === 'mention' ? normalized[0] : null;
  if (!mention) return;

  const delimiter = match[2];
  replaceTextRangeWithMention(editor, match.index, match.index + match[0].length, {
    id: mention.roomAgentId,
    agent_name: mention.agentName,
  }, delimiter);
}

function getMentionQueryOffsets(editor: HTMLDivElement, range: Range): { start: number; end: number } | null {
  const cursorOffset = getLinearOffset(editor, range);
  const textBeforeCursor = getEditorLinearText(editor).slice(0, cursorOffset);
  const match = textBeforeCursor.match(mentionQueryPattern);
  if (!match || match.index === undefined) return null;

  return {
    start: match.index,
    end: cursorOffset,
  };
}

function replaceTextRangeWithMention(
  editor: HTMLDivElement,
  start: number,
  end: number,
  agent: Pick<RoomAgent, 'id' | 'agent_name'>,
  trailingText = ' ',
) {
  const startPoint = mapLinearOffsetToDomPoint(editor, start);
  const endPoint = mapLinearOffsetToDomPoint(editor, end);
  if (!startPoint || !endPoint) return;

  const replaceRange = document.createRange();
  replaceRange.setStart(startPoint.node, startPoint.offset);
  replaceRange.setEnd(endPoint.node, endPoint.offset);
  replaceRange.deleteContents();

  const token = createMentionElement(agent.id, agent.agent_name);
  const trailing = document.createTextNode(trailingText);
  replaceRange.insertNode(trailing);
  replaceRange.insertNode(token);
  placeCursorAfter(trailing);
  editor.focus();
}

function placeCursorAfter(node: Node) {
  const range = document.createRange();
  range.setStartAfter(node);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function getLinearOffset(editor: HTMLDivElement, range: Range): number {
  const before = range.cloneRange();
  before.selectNodeContents(editor);
  before.setEnd(range.endContainer, range.endOffset);
  return before.toString().length;
}

function getEditorLinearText(editor: HTMLDivElement): string {
  const range = document.createRange();
  range.selectNodeContents(editor);
  return range.toString();
}

function mapLinearOffsetToDomPoint(editor: HTMLDivElement, targetOffset: number): { node: Node; offset: number } | null {
  const result = findDomPointForOffset(editor, targetOffset, { value: 0 });
  if (result) return result;

  return { node: editor, offset: editor.childNodes.length };
}

function findDomPointForOffset(
  parent: Node,
  targetOffset: number,
  currentOffset: { value: number },
): { node: Node; offset: number } | null {
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const length = child.textContent?.length ?? 0;
      if (targetOffset <= currentOffset.value + length) {
        return { node: child, offset: Math.max(0, targetOffset - currentOffset.value) };
      }
      currentOffset.value += length;
      continue;
    }

    if (!(child instanceof HTMLElement)) continue;

    if (child.classList.contains('composer-mention-token')) {
      const length = child.textContent?.length ?? 0;
      const parentNode = child.parentNode ?? parent;
      const chipIndex = getNodeIndex(child);

      if (targetOffset <= currentOffset.value) {
        return { node: parentNode, offset: chipIndex };
      }

      if (targetOffset < currentOffset.value + length) {
        const midpoint = currentOffset.value + length / 2;
        return { node: parentNode, offset: targetOffset < midpoint ? chipIndex : chipIndex + 1 };
      }

      if (targetOffset === currentOffset.value + length) {
        return { node: parentNode, offset: chipIndex + 1 };
      }

      currentOffset.value += length;
      continue;
    }

    if (child.tagName === 'BR') {
      if (targetOffset <= currentOffset.value + 1) {
        return { node: child.parentNode ?? parent, offset: getNodeIndex(child) };
      }
      currentOffset.value += 1;
      continue;
    }

    const nested = findDomPointForOffset(child, targetOffset, currentOffset);
    if (nested) return nested;
  }

  return null;
}

function isBlockishElement(element: HTMLElement): boolean {
  return [
    'ADDRESS',
    'ARTICLE',
    'ASIDE',
    'BLOCKQUOTE',
    'DIV',
    'FIGURE',
    'FOOTER',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'HEADER',
    'LI',
    'MAIN',
    'OL',
    'P',
    'PRE',
    'SECTION',
    'UL',
  ].includes(element.tagName);
}

function textLengthFromNodes(nodes: ComposerNode[]): number {
  return nodes.reduce((total, node) => total + (node.type === 'mention' ? node.agentName.length + 1 : node.text.length), 0);
}

function getNodeIndex(node: Node): number {
  let index = 0;
  let sibling = node.previousSibling;
  while (sibling) {
    index += 1;
    sibling = sibling.previousSibling;
  }
  return index;
}
