import Editor from '@monaco-editor/react';
import { useQuery } from '@tanstack/react-query';
import React, { useEffect, useState } from 'react';
import { RefreshCcw } from 'lucide-react';
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
        theme="vs-dark"
        options={{
          readOnly: true,
          minimap: { enabled: false },
          fontSize: 12,
          lineHeight: 18,
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          automaticLayout: true,
          renderLineHighlight: 'line',
        }}
      />
      {data.truncated ? (
        <div className="deepsea-file-viewer-badge" title="文件内容已按预览上限截断">
          truncated
        </div>
      ) : null}
    </div>
  );
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
