import { Eye, FileText } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { MarkdownPreview, MessageContent, isMarkdownMessageContent } from '../components/MessageContent';

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
  displayMode,
  onDisplayModeChange,
}: {
  role: SessionMessageBubbleRole;
  content: string;
  previewContent?: string;
  timeLabel: string;
  statusLabel?: string | null;
  actions?: ReactNode;
  roleLabel?: string;
  displayMode?: SessionMessageDisplayMode;
  onDisplayModeChange?: (mode: SessionMessageDisplayMode) => void;
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
        {actions}
        <MarkdownDisplaySwitch content={content} mode={activeDisplayMode} onModeChange={setDisplayMode} />
      </header>
      <div className="deepsea-message-body">
        {previewContent && activeDisplayMode === 'preview' ? (
          <MarkdownPreview content={displayContent} />
        ) : (
          <MessageContent content={displayContent} mode={activeDisplayMode} suppressTraceEvents />
        )}
      </div>
    </article>
  );
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
