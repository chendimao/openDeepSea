import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildFileResourceActions, listResourceLibraryFiles } from './FilesPage';
import { I18nProvider, useI18n } from '../lib/i18n';
import { projectFileMatchesFilters } from '../lib/projectFileDisplay';
import type { ProjectFile, ResourceListItem } from '../lib/types';

const globalWithReact = globalThis as typeof globalThis & { React: typeof React };
globalWithReact.React = React;
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: () => null,
    setItem: () => undefined,
  },
  configurable: true,
});

test('resource library actions separate agent documents from uploaded files', () => {
  const t = (key: string) => translateFileMessage(key);
  const noop = () => undefined;
  const agentActions = buildFileResourceActions(createProjectFile({
    id: 'asset:agent-doc',
    source_type: 'agent_document',
    original_name: '执行总结.md',
  }), {
    t,
    isRemoving: false,
    onPreview: noop,
    onDelete: noop,
  });
  const uploadedActions = buildFileResourceActions(createProjectFile({
    id: 'file:uploaded',
    source_type: 'uploaded_file',
    original_name: 'screen.png',
    url: '/uploads/files/project-1/screen.png',
  }), {
    t,
    isRemoving: false,
    onPreview: noop,
    onDelete: noop,
  });

  assert.deepEqual(agentActions.map((action) => action.label), ['查看文档', '来源追踪', '删除文档']);
  assert.equal(agentActions.some((action) => action.key === 'download'), false);
  assert.deepEqual(uploadedActions.map((action) => action.label), ['预览', '下载', '删除文件']);
  assert.equal(uploadedActions.some((action) => action.key === 'source-trace'), false);
});

test('resource library copy keeps the navigation and empty state wording', () => {
  const html = renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(ResourceLibraryCopyProbe)),
  );

  assert.match(html, /资源库/);
  assert.match(html, /管理项目中的上传文件与智能体生成文档/);
  assert.match(html, /上传文件或保存智能体文档后会显示在这里/);
});

test('resource library type filter labels match first scope', () => {
  const html = renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(ResourceLibraryFilterCopyProbe)),
  );

  assert.match(html, /<option value="">全部<\/option>/);
  assert.match(html, /<option value="uploaded_file">上传文件<\/option>/);
  assert.match(html, /<option value="agent_document">智能体文档<\/option>/);
});

test('resource library type filters and keyword search compose across resource fields', () => {
  const t = (key: string, params?: Record<string, string | number>) => translateFileMessage(key, params);
  const files = [
    createUploadedFile({
      id: 'file:screen',
      original_name: 'screen.png',
      last_referenced_room_name: '功能开发',
      uploaded_by_name: '大哥',
    }),
    createAgentDocument({
      id: 'asset:summary',
      original_name: '执行总结.md',
      source_agent_id: 'frontend-executor',
      last_referenced_room_name: '功能开发',
    }),
    createAgentDocument({
      id: 'asset:backend',
      original_name: '后端归档.md',
      source_agent_id: 'backend-executor',
      last_referenced_room_name: '后端联调',
    }),
  ];

  assert.deepEqual(
    files.filter((file) => projectFileMatchesFilters(file, { keyword: '', sourceType: 'uploaded_file' }, t))
      .map((file) => file.id),
    ['file:screen'],
  );
  assert.deepEqual(
    files.filter((file) => projectFileMatchesFilters(file, { keyword: '', sourceType: 'agent_document' }, t))
      .map((file) => file.id),
    ['asset:summary', 'asset:backend'],
  );
  assert.deepEqual(
    files.filter((file) => projectFileMatchesFilters(file, { keyword: 'screen', sourceType: '' }, t))
      .map((file) => file.id),
    ['file:screen'],
  );
  assert.deepEqual(
    files.filter((file) => projectFileMatchesFilters(file, { keyword: '执行总结', sourceType: '' }, t))
      .map((file) => file.id),
    ['asset:summary'],
  );
  assert.deepEqual(
    files.filter((file) => projectFileMatchesFilters(file, { keyword: '功能开发', sourceType: 'agent_document' }, t))
      .map((file) => file.id),
    ['asset:summary'],
  );
  assert.deepEqual(
    files.filter((file) => projectFileMatchesFilters(file, { keyword: 'frontend-executor', sourceType: 'agent_document' }, t))
      .map((file) => file.id),
    ['asset:summary'],
  );
  assert.deepEqual(
    files.filter((file) => projectFileMatchesFilters(file, { keyword: 'frontend-executor', sourceType: 'uploaded_file' }, t)),
    [],
  );
});

test('resource library uses all-project file list when no project is selected', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify([
      createUploadedFile({
        id: 'file:uploaded',
        original_name: 'screen.png',
      }),
      createAgentDocument({
        id: 'asset:agent-doc',
        original_name: '执行总结.md',
      }),
    ]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const files = await listResourceLibraryFiles({});
    assert.equal(requestedUrl, '/api/files');
    assert.deepEqual(files.map((file) => file.source_type), ['uploaded_file', 'agent_document']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('resource library forwards type filter to all-project file list', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify([
      createAgentDocument({
        id: 'asset:agent-doc',
        original_name: '执行总结.md',
      }),
    ]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const files = await listResourceLibraryFiles({ sourceType: 'agent_document' });
    assert.equal(requestedUrl, '/api/files?sourceType=agent_document');
    assert.deepEqual(files.map((file) => file.source_type), ['agent_document']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('resource library uses unified resource list when a project is selected', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify([
      createResourceListItem({
        id: 'asset:agent-doc',
        resource_type: 'agent_document',
        asset_type: 'agent_document',
        name: '执行总结.md',
        title: '执行总结.md',
      }),
    ]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const files = await listResourceLibraryFiles({
      projectId: 'project-1',
      roomId: 'room-1',
      sourceType: 'agent_document',
    });
    assert.equal(requestedUrl, '/api/projects/project-1/resource-assets?roomId=room-1&resourceType=agent_document');
    assert.equal(files[0]?.source_type, 'agent_document');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function translateFileMessage(key: string, params?: Record<string, string | number>): string {
  const messages: Record<string, string> = {
    'files.source.all': '全部',
    'files.viewDocument': '查看文档',
    'files.preview': '预览',
    'files.viewDetails': '查看详情',
    'files.sourceTrace': '来源追踪',
    'files.download': '下载',
    'files.deleteDocument': '删除文档',
    'files.deleteFile': '删除文件',
    'files.source.uploadedFile': '上传文件',
    'files.source.agentDocument': '智能体文档',
    'files.source.unknown': '未知资源',
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
    'files.sourceSummary.unknown': '来源信息：未记录',
  };
  return (messages[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''));
}

function ResourceLibraryCopyProbe(): JSX.Element {
  const { t } = useI18n();
  return React.createElement(
    'div',
    null,
    React.createElement('h1', null, t('files.title')),
    React.createElement('p', null, t('files.subtitle')),
    React.createElement('div', null, t('files.libraryEmptyTitle')),
    React.createElement('div', null, t('files.libraryEmptyDescription')),
  );
}

function ResourceLibraryFilterCopyProbe(): JSX.Element {
  const { t } = useI18n();
  return React.createElement(
    'select',
    null,
    React.createElement('option', { value: '' }, t('files.source.all')),
    React.createElement('option', { value: 'uploaded_file' }, t('files.source.uploadedFile')),
    React.createElement('option', { value: 'agent_document' }, t('files.source.agentDocument')),
  );
}

function createUploadedFile(input: Partial<ProjectFile> & Pick<ProjectFile, 'id' | 'original_name'>): ProjectFile {
  return createProjectFile({
    source_type: 'uploaded_file',
    mime_type: 'image/png',
    url: `/uploads/${input.original_name}`,
    uploaded_by_id: 'user',
    uploaded_by_name: '大哥',
    ...input,
  });
}

function createAgentDocument(input: Partial<ProjectFile> & Pick<ProjectFile, 'id' | 'original_name'>): ProjectFile {
  return createProjectFile({
    source_type: 'agent_document',
    mime_type: 'text/markdown',
    source_message_id: 'message-1',
    source_room_id: 'room-1',
    source_agent_id: 'frontend-executor',
    content: '# 文档',
    ...input,
  });
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

function createResourceListItem(input: Partial<ResourceListItem>): ResourceListItem {
  return {
    id: 'resource-1',
    project_id: 'project-1',
    asset_type: 'agent_document',
    resource_type: 'agent_document',
    group_key: 'agent_documents',
    title: 'resource',
    name: 'resource',
    mime_type: null,
    size: null,
    url: null,
    file_id: null,
    source_message_id: null,
    source_room_id: null,
    source_agent_id: null,
    source_task_id: null,
    source_display_name: null,
    source_label: '智能体生成',
    source_context_id: null,
    source_context_name: null,
    source_context_type: null,
    source: {
      type: 'agent',
      label: '智能体生成',
      display_name: null,
      agent_id: null,
      user_id: null,
      message_id: null,
      room_id: null,
      task_id: null,
      context: null,
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
    ...input,
  };
}
