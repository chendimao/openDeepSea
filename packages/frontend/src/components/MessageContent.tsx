import { useState } from 'react';
import { Check, Copy, Eye, FileText } from 'lucide-react';
import { useI18n } from '../lib/i18n';

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

export function MessageContent({
  content,
  streaming = false,
}: {
  content: string;
  streaming?: boolean;
}): JSX.Element {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [mode, setMode] = useState<'preview' | 'source'>('preview');
  const { t } = useI18n();
  const parts = parseMessage(content);
  const markdown = isMarkdownContent(content);
  const lastTextPartIndex = findLastTextPartIndex(parts);

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
      {markdown && (
        <div className="message-mode-switch" aria-label={t('message.markdownModeAria')}>
          <button
            type="button"
            onClick={() => setMode('preview')}
            className={mode === 'preview' ? 'is-active' : undefined}
            aria-pressed={mode === 'preview'}
          >
            <Eye className="h-3.5 w-3.5" />
            {t('message.preview')}
          </button>
          <button
            type="button"
            onClick={() => setMode('source')}
            className={mode === 'source' ? 'is-active' : undefined}
            aria-pressed={mode === 'source'}
          >
            <FileText className="h-3.5 w-3.5" />
            {t('message.source')}
          </button>
        </div>
      )}

      {markdown && mode === 'preview' ? (
        <MarkdownPreview content={content} streaming={streaming} />
      ) : (
        <>
          {parts.map((part, index) => {
            if (part.type === 'text') {
              if (!part.value) return null;
              return (
                <span key={`text-${index}`} className="whitespace-pre-wrap break-words">
                  {part.value}
                  {streaming && index === lastTextPartIndex && <StreamingCursor />}
                </span>
              );
            }

            const copied = copiedIndex === index;
            return (
              <CodeBlock
                key={`code-${index}`}
                language={part.language}
                value={part.value}
                copied={copied}
                onCopy={() => void copyCode(part.value, index)}
                copyLabel={t('message.copy')}
                copiedLabel={t('message.copied')}
              />
            );
          })}
          {streaming && lastTextPartIndex === -1 && <StreamingCursor />}
        </>
      )}
    </div>
  );
}

function findLastTextPartIndex(parts: MessagePart[]): number {
  for (let index = parts.length - 1; index >= 0; index--) {
    if (parts[index].type === 'text' && parts[index].value.length > 0) return index;
  }
  return -1;
}

function isMarkdownContent(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (fencePattern.test(trimmed)) {
    fencePattern.lastIndex = 0;
    return true;
  }
  fencePattern.lastIndex = 0;
  return /(^|\n)\s{0,3}#{1,6}\s+\S/.test(trimmed)
    || /(^|\n)\s{0,3}[-*+]\s+\S/.test(trimmed)
    || /(^|\n)\s{0,3}\d+\.\s+\S/.test(trimmed)
    || /(^|\n)\s{0,3}>\s+\S/.test(trimmed)
    || /(^|\n)\s{0,3}---+\s*$/.test(trimmed)
    || /\[[^\]]+\]\([^)]+\)/.test(trimmed)
    || /`[^`\n]+`/.test(trimmed)
    || /\*\*[^*\n]+\*\*/.test(trimmed);
}

function MarkdownPreview({ content, streaming }: { content: string; streaming: boolean }): JSX.Element {
  const { t } = useI18n();
  const parts = parseMessage(content);
  return (
    <div className="markdown-preview">
      {parts.map((part, index) => {
        if (part.type === 'code') {
          return (
            <CodeBlock
              key={`preview-code-${index}`}
              language={part.language}
              value={part.value}
              copied={false}
              onCopy={() => void navigator.clipboard.writeText(part.value)}
              copyLabel={t('message.copy')}
              copiedLabel={t('message.copied')}
            />
          );
        }
        return <MarkdownText key={`preview-text-${index}`} text={part.value} />;
      })}
      {streaming && <StreamingCursor />}
    </div>
  );
}

function StreamingCursor(): JSX.Element {
  return <span className="streaming-cursor" aria-hidden="true" />;
}

function MarkdownText({ text }: { text: string }): JSX.Element {
  const blocks = text.split(/\n{2,}/).filter((block) => block.trim().length > 0);
  return (
    <>
      {blocks.map((block, index) => renderMarkdownBlock(block, index))}
    </>
  );
}

function renderMarkdownBlock(block: string, index: number): JSX.Element {
  const trimmed = block.trim();
  const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
  if (heading) {
    const level = Math.min(heading[1].length, 3);
    const Tag = (`h${level}` as keyof JSX.IntrinsicElements);
    return <Tag key={index}>{renderInlineMarkdown(heading[2])}</Tag>;
  }

  if (/^>\s+/m.test(trimmed)) {
    return (
      <blockquote key={index}>
        {trimmed.replace(/^>\s?/gm, '')}
      </blockquote>
    );
  }

  const lines = trimmed.split('\n');
  if (lines.every((line) => /^\s*[-*+]\s+/.test(line))) {
    return (
      <ul key={index}>
        {lines.map((line, i) => (
          <li key={i}>{renderInlineMarkdown(line.replace(/^\s*[-*+]\s+/, ''))}</li>
        ))}
      </ul>
    );
  }

  if (lines.every((line) => /^\s*\d+\.\s+/.test(line))) {
    return (
      <ol key={index}>
        {lines.map((line, i) => (
          <li key={i}>{renderInlineMarkdown(line.replace(/^\s*\d+\.\s+/, ''))}</li>
        ))}
      </ol>
    );
  }

  if (/^-{3,}$/.test(trimmed)) {
    return <hr key={index} />;
  }

  return (
    <p key={index}>
      {lines.map((line, i) => (
        <span key={i}>
          {i > 0 && <br />}
          {renderInlineMarkdown(line)}
        </span>
      ))}
    </p>
  );
}

function renderInlineMarkdown(text: string): Array<string | JSX.Element> {
  const tokens: Array<string | JSX.Element> = [];
  const pattern = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) tokens.push(text.slice(lastIndex, match.index));
    if (match[2]) {
      tokens.push(<strong key={match.index}>{match[2]}</strong>);
    } else if (match[3]) {
      tokens.push(<code key={match.index}>{match[3]}</code>);
    } else if (match[4] && match[5]) {
      tokens.push(
        <a key={match.index} href={match[5]} target="_blank" rel="noreferrer">
          {match[4]}
        </a>,
      );
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) tokens.push(text.slice(lastIndex));
  return tokens;
}

function CodeBlock({
  language,
  value,
  copied,
  onCopy,
  copyLabel,
  copiedLabel,
}: {
  language: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
  copyLabel: string;
  copiedLabel: string;
}): JSX.Element {
  return (
    <div className="code-block">
      <div className="code-block-header">
        <span>{language}</span>
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-fg)] focus:outline-none focus:glow-accent ease-ocean transition-all"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? copiedLabel : copyLabel}
        </button>
      </div>
      <pre className="code-block-pre"><code>{value}</code></pre>
    </div>
  );
}
