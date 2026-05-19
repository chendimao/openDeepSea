import assert from 'node:assert/strict';
import test from 'node:test';
import { Download, Eye } from 'lucide-react';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../lib/i18n';
import { projectFileMatchesKeyword } from '../lib/projectFileDisplay';
import type { ProjectFile, ResourceDetail } from '../lib/types';
import { ProjectFilePreviewContent, ProjectFilePreviewState, ResourceDetailPreviewContent } from './ProjectFilePreviewDialog';
import { ProjectFileView } from './ProjectFileView';

const globalWithReact = globalThis as typeof globalThis & { React: typeof React };
globalWithReact.React = React;
setupBrowserStubs();

test('file view distinguishes uploaded files from agent documents', () => {
  const html = renderToStaticMarkup(
    <I18nProvider>
      <ProjectFileView
        files={[createUploadedFile(), createAgentDocument()]}
        mode="list"
        variant="library"
        getMeta={(file) => (
          <>
            <span>{file.mime_type}</span>
            <span>{file.size}</span>
          </>
        )}
        getActions={(file) => [
          {
            key: 'preview',
            label: file.source_type === 'agent_document' ? '查看 Markdown' : '预览',
            icon: <Eye />,
          },
          ...(file.source_type === 'uploaded_file'
            ? [{
              key: 'download',
              label: '下载',
              icon: <Download />,
              href: file.url,
              download: file.original_name,
            }]
            : []),
        ]}
      />
    </I18nProvider>,
  );

  assert.match(html, /上传文件/);
  assert.match(html, /智能体文档/);
  assert.match(html, /screen\.png/);
  assert.match(html, /执行总结\.md/);
  assert.match(html, /aria-label="查看 Markdown"/);
  assert.match(html, /aria-label="下载"/);
});

test('agent document preview renders markdown content without download action', () => {
  const html = renderToStaticMarkup(
    <I18nProvider>
      <ProjectFilePreviewContent
        file={createAgentDocument()}
        onLocateMessage={() => undefined}
      />
    </I18nProvider>,
  );

  assert.match(html, /智能体文档/);
  assert.match(html, /<h1>执行总结<\/h1>/);
  assert.match(html, /智能体：frontend-executor · 任务：task-1/);
  assert.match(html, /来源智能体/);
  assert.match(html, /frontend-executor/);
  assert.match(html, /定位消息/);
  assert.doesNotMatch(html, /download="执行总结\.md"/);
});

test('uploaded file preview keeps download action', () => {
  const html = renderToStaticMarkup(
    <I18nProvider>
      <ProjectFilePreviewContent
        file={createUploadedFile()}
      />
    </I18nProvider>,
  );

  assert.match(html, /上传文件/);
  assert.match(html, /上传者：大哥/);
  assert.match(html, /download="screen\.png"/);
  assert.match(html, /打开原文件/);
});

test('detail panel has clear loading and missing states', () => {
  const html = renderToStaticMarkup(
    <I18nProvider>
      <ProjectFilePreviewState
        title="正在读取资源详情…"
        description="资源不存在或已被移除"
        actionLabel="重试"
        onAction={() => undefined}
      />
    </I18nProvider>,
  );

  assert.match(html, /正在读取资源详情/);
  assert.match(html, /资源不存在或已被移除/);
  assert.match(html, /重试/);
});

test('resource detail content hides file actions for agent documents', () => {
  const html = renderToStaticMarkup(
    <I18nProvider>
      <ResourceDetailPreviewContent
        resource={createAgentDocumentResourceDetail()}
        fallbackFile={createAgentDocument()}
        onLocateMessage={() => undefined}
      />
    </I18nProvider>,
  );

  assert.match(html, /<h1>执行总结<\/h1>/);
  assert.match(html, /生成时间/);
  assert.match(html, /来源会话/);
  assert.doesNotMatch(html, /download="执行总结\.md"/);
  assert.doesNotMatch(html, /打开原文件/);
});

test('keyword search matches type and source fields', () => {
  const t = (key: string, params?: Record<string, string | number>) => {
    const messages: Record<string, string> = {
      'files.source.uploadedFile': '上传文件',
      'files.source.agentDocument': '智能体文档',
      'files.sourceSummary.uploadedBy': '上传者：{user}',
      'files.sourceSummary.uploadedByInRoom': '上传者：{user} · 来源群聊：{room}',
      'files.sourceSummary.uploadedInRoom': '上传来源：{room}',
      'files.sourceSummary.uploadedUnknown': '上传来源：未记录',
      'files.sourceSummary.agent': '智能体：{agent}',
      'files.sourceSummary.agentWithTask': '智能体：{agent} · 任务：{task}',
      'files.sourceSummary.agentWithRoom': '智能体：{agent} · 会话：{room}',
      'files.sourceSummary.task': '任务：{task}',
      'files.sourceSummary.room': '会话：{room}',
      'files.sourceSummary.agentUnknown': '智能体来源：未记录',
    };
    return (messages[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''));
  };

  assert.equal(projectFileMatchesKeyword(createAgentDocument(), '智能体文档', t), true);
  assert.equal(projectFileMatchesKeyword(createAgentDocument(), 'frontend-executor', t), true);
  assert.equal(projectFileMatchesKeyword(createUploadedFile(), '大哥', t), true);
  assert.equal(projectFileMatchesKeyword(createProjectFile({
    id: 'asset:room-only',
    source_type: 'agent_document',
    original_name: '会话记录.md',
    source_room_id: 'room-archive',
  }), 'room-archive', t), true);
});

function createUploadedFile(): ProjectFile {
  return createProjectFile({
    id: 'file-uploaded',
    source_type: 'uploaded_file',
    original_name: 'screen.png',
    stored_name: 'stored-screen.png',
    mime_type: 'image/png',
    size: 128,
    url: '/uploads/files/project-1/stored-screen.png',
    storage_path: '/tmp/stored-screen.png',
    uploaded_by_id: 'user',
    uploaded_by_name: '大哥',
  });
}

function createAgentDocument(): ProjectFile {
  return createProjectFile({
    id: 'asset:agent-doc',
    source_type: 'agent_document',
    original_name: '执行总结.md',
    stored_name: '执行总结.md',
    mime_type: 'text/markdown',
    size: 64,
    url: '',
    storage_path: '',
    uploaded_by_id: null,
    uploaded_by_name: null,
    source_message_id: 'message-1',
    source_room_id: 'room-1',
    source_agent_id: 'frontend-executor',
    source_task_id: 'task-1',
    content: '# 执行总结\n\n- 区分用户上传文件\n- 展示智能体文档',
    reference_count: 1,
    last_referenced_message_id: 'message-1',
    last_referenced_room_id: 'room-1',
    last_referenced_room_name: 'Current repo fixed workflow',
  });
}

function createAgentDocumentResourceDetail(): ResourceDetail {
  return {
    id: 'asset:agent-doc',
    project_id: 'project-1',
    asset_type: 'agent_document',
    resource_type: 'agent_document',
    group_key: 'agent_documents',
    title: '执行总结.md',
    name: '执行总结.md',
    content: '# 执行总结\n\n- 展示 Markdown 内容',
    mime_type: 'text/markdown',
    size: 64,
    url: null,
    file_id: null,
    source_message_id: 'message-1',
    source_room_id: 'room-1',
    source_agent_id: 'frontend-executor',
    source_task_id: 'task-1',
    source_display_name: '前端开发工程师',
    source_label: '智能体生成',
    source_context_id: 'task-1',
    source_context_name: '资源详情验收',
    source_context_type: 'task',
    source: {
      type: 'agent',
      label: '智能体生成',
      display_name: '前端开发工程师',
      agent_id: 'frontend-executor',
      user_id: null,
      message_id: 'message-1',
      room_id: 'room-1',
      task_id: 'task-1',
      context: {
        id: 'room-1',
        type: 'room',
        name: 'heartbeat workflow 验收 1779231401898',
      },
    },
    capabilities: {
      preview: true,
      download: false,
      markdown: true,
      delete: true,
    },
    preview_url: null,
    download_url: null,
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
  };
}

function createProjectFile(input: Partial<ProjectFile> & Pick<ProjectFile, 'id' | 'source_type' | 'original_name'>): ProjectFile {
  return {
    project_id: 'project-1',
    stored_name: input.original_name,
    mime_type: 'application/octet-stream',
    size: 0,
    url: '',
    storage_path: '',
    uploaded_by_id: null,
    uploaded_by_name: null,
    source_message_id: null,
    source_room_id: null,
    source_agent_id: null,
    source_task_id: null,
    content: null,
    created_at: 1,
    deleted_at: null,
    reference_count: 0,
    last_referenced_at: null,
    last_referenced_message_id: null,
    last_referenced_room_id: null,
    last_referenced_room_name: null,
    ...input,
  };
}

function setupBrowserStubs(): void {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => null,
      setItem: () => undefined,
    },
  });
}
