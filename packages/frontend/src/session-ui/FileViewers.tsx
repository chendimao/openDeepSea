import Editor, { type Monaco } from '@monaco-editor/react';
import { useQuery } from '@tanstack/react-query';
import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, RefreshCcw, Search, X } from 'lucide-react';
import { api } from '../lib/api';
import type { WorkspaceFilePreview } from '../lib/types';
import type { WorkspaceFileTab } from './workspace-file-model';

function languageForMonaco(preview: WorkspaceFilePreview, tab: WorkspaceFileTab): string {
  return preview.language ?? tab.language ?? 'plaintext';
}

export function FileViewer({ projectId, tab }: { projectId: string; tab: WorkspaceFileTab }): JSX.Element {
  if (tab.viewerKind === 'text') return <MonacoTextViewer projectId={projectId} tab={tab} />;
  if (tab.viewerKind === 'image') return <ImageViewer projectId={projectId} tab={tab} />;
  return <UnsupportedViewer tab={tab} />;
}

function MonacoTextViewer({ projectId, tab }: { projectId: string; tab: WorkspaceFileTab }): JSX.Element {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['workspace-file-preview', projectId, tab.path],
    queryFn: () => api.getWorkspaceFilePreview(projectId, tab.path),
  });

  if (isLoading) return <FileViewerState>正在加载文件...</FileViewerState>;
  if (isError) {
    return (
      <FileViewerError
        title="文件无法预览"
        description={error instanceof Error ? error.message : '读取文件失败'}
        onRetry={() => void refetch()}
      />
    );
  }
  if (!data) return <FileViewerState>没有文件内容。</FileViewerState>;

  return (
    <div className="deepsea-monaco-viewer">
      <Editor
        height="100%"
        path={tab.path}
        language={languageForMonaco(data, tab)}
        value={data.content}
        theme="deepsea-command-light"
        loading={<CodePreviewFallback content={data.content} />}
        beforeMount={defineDeepseaCommandLightTheme}
        options={{
          readOnly: true,
          minimap: { enabled: false },
          fontFamily: '"JetBrains Mono", "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          fontSize: 13,
          lineHeight: 20,
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          automaticLayout: true,
          renderLineHighlight: 'line',
          overviewRulerBorder: false,
          glyphMargin: false,
          folding: false,
          lineDecorationsWidth: 0,
          lineNumbersMinChars: 3,
          padding: { top: 14, bottom: 14 },
        }}
      />
      <div className="deepsea-file-find-widget" aria-hidden="true">
        <div className="deepsea-file-find-widget__field">
          <Search />
          <span>watch</span>
          <small>Aa</small>
          <small>ab</small>
          <small>*</small>
        </div>
        <div className="deepsea-file-find-widget__meta">
          <span>1 of 1</span>
          <div>
            <ChevronUp />
            <ChevronDown />
            <X />
          </div>
        </div>
      </div>
      {data.truncated ? (
        <div className="deepsea-file-viewer-badge" title="文件内容已按预览上限截断">
          truncated
        </div>
      ) : null}
    </div>
  );
}

function defineDeepseaCommandLightTheme(monaco: Monaco): void {
  monaco.editor.defineTheme('deepsea-command-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '64748B', fontStyle: 'italic' },
      { token: 'keyword', foreground: '003594', fontStyle: 'bold' },
      { token: 'number', foreground: '1B55D0' },
      { token: 'string', foreground: '006C49' },
      { token: 'type', foreground: '751F00' },
      { token: 'delimiter', foreground: '737685' },
      { token: 'operator', foreground: '737685' },
    ],
    colors: {
      'editor.background': '#eef3f9',
      'editor.foreground': '#191c1e',
      'editorGutter.background': '#edf2f8',
      'editorLineNumber.foreground': '#a6b0bf',
      'editorLineNumber.activeForeground': '#64748b',
      'editor.lineHighlightBackground': '#e4ecf7',
      'editor.lineHighlightBorder': '#d8e5f5',
      'editor.selectionBackground': '#b8c8ff66',
      'editor.inactiveSelectionBackground': '#dbe1ff66',
      'editorCursor.foreground': '#004ac6',
      'editorWhitespace.foreground': '#c3c6d6',
    },
  });
}

function CodePreviewFallback({ content }: { content: string }): JSX.Element {
  const lines = content.split('\n');
  return (
    <div className="deepsea-code-fallback" aria-label="文件内容预览">
      <div className="deepsea-code-fallback__gutter" aria-hidden="true">
        {lines.map((_, index) => <span key={index}>{index + 1}</span>)}
      </div>
      <pre className="deepsea-code-fallback__content">
        {lines.map((line, index) => (
          <code key={index}>{renderHighlightedLine(line) || ' '}</code>
        ))}
      </pre>
    </div>
  );
}

function renderHighlightedLine(line: string): React.ReactNode {
  const tokenPattern = /("(?:\\.|[^"\\])*"|"[^"]*"|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?|[{}[\],:])/gu;
  const segments: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(line)) !== null) {
    const token = match[0];
    if (match.index > lastIndex) segments.push(line.slice(lastIndex, match.index));
    segments.push(
      <span key={`${match.index}-${token}`} className={classNameForCodeToken(line, token, match.index)}>
        {token}
      </span>,
    );
    lastIndex = match.index + token.length;
  }

  if (lastIndex < line.length) segments.push(line.slice(lastIndex));
  return segments;
}

function classNameForCodeToken(line: string, token: string, index: number): string {
  if (/^"(?:\\.|[^"\\])*"$/u.test(token)) {
    return line.slice(index + token.length).trimStart().startsWith(':')
      ? 'deepsea-code-token-key'
      : 'deepsea-code-token-string';
  }
  if (/^(?:true|false|null)$/u.test(token)) return 'deepsea-code-token-bool';
  if (/^-?\d/u.test(token)) return 'deepsea-code-token-number';
  return 'deepsea-code-token-punctuation';
}

function ImageViewer({ projectId, tab }: { projectId: string; tab: WorkspaceFileTab }): JSX.Element {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['workspace-image-blob', projectId, tab.path],
    queryFn: () => api.getWorkspaceImageBlob(projectId, tab.path),
  });
  const imageUrl = useObjectUrl(data ?? null);

  if (isLoading) return <FileViewerState>正在加载图片...</FileViewerState>;
  if (isError) {
    return (
      <FileViewerError
        title="图片无法预览"
        description={error instanceof Error ? error.message : '读取图片失败'}
        onRetry={() => void refetch()}
      />
    );
  }
  if (!imageUrl) return <FileViewerState>没有图片内容。</FileViewerState>;

  return (
    <div className="deepsea-image-viewer">
      <img src={imageUrl} alt={tab.name} />
    </div>
  );
}

function UnsupportedViewer({ tab }: { tab: WorkspaceFileTab }): JSX.Element {
  return (
    <FileViewerState>
      <strong>当前文件暂不支持预览</strong>
      <span>{tab.name}</span>
      <small>{tab.mimeType ?? 'unknown type'}</small>
    </FileViewerState>
  );
}

function FileViewerError({
  title,
  description,
  onRetry,
}: {
  title: string;
  description: string;
  onRetry: () => void;
}): JSX.Element {
  return (
    <FileViewerState>
      <strong>{title}</strong>
      <span>{description}</span>
      <button type="button" onClick={onRetry}>
        <RefreshCcw aria-hidden="true" />
        重试
      </button>
    </FileViewerState>
  );
}

function FileViewerState({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="deepsea-file-viewer-state">{children}</div>;
}

function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return undefined;
    }
    const nextUrl = URL.createObjectURL(blob);
    setUrl(nextUrl);
    return () => {
      URL.revokeObjectURL(nextUrl);
    };
  }, [blob]);

  return url;
}
