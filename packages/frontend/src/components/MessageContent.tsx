import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

type MessagePart =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string; language: string };

const fencePattern = /```(\w+)?\n([\s\S]*?)```/g;

function parseMessage(content: string): MessagePart[] {
  const parts: MessagePart[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fencePattern.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', value: content.slice(lastIndex, match.index) });
    }
    parts.push({
      type: 'code',
      language: match[1] || 'text',
      value: match[2] ?? '',
    });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    parts.push({ type: 'text', value: content.slice(lastIndex) });
  }

  return parts.length > 0 ? parts : [{ type: 'text', value: content }];
}

export function MessageContent({ content }: { content: string }): JSX.Element {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const parts = parseMessage(content);

  const copyCode = async (code: string, index: number) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedIndex(index);
      window.setTimeout(() => setCopiedIndex(null), 1200);
    } catch {
      setCopiedIndex(null);
    }
  };

  return (
    <div className="message-content">
      {parts.map((part, index) => {
        if (part.type === 'text') {
          if (!part.value) return null;
          return (
            <span key={`text-${index}`} className="whitespace-pre-wrap break-words">
              {part.value}
            </span>
          );
        }

        const copied = copiedIndex === index;
        return (
          <div key={`code-${index}`} className="code-block">
            <div className="code-block-header">
              <span>{part.language}</span>
              <button
                type="button"
                onClick={() => void copyCode(part.value, index)}
                className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-fg)] focus:outline-none focus:glow-accent ease-ocean transition-all"
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? '已复制' : '复制'}
              </button>
            </div>
            <pre className="code-block-pre"><code>{part.value}</code></pre>
          </div>
        );
      })}
    </div>
  );
}
