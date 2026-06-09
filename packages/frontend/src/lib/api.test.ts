import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { api, resourceListItemToProjectFile } from './api';
import type { ResourceListItem } from './types';

test('resource list adapter preserves uploaded file fields for library UI', () => {
  const file = resourceListItemToProjectFile(createResourceListItem({
    id: 'file:file-1',
    asset_type: 'uploaded_file',
    resource_type: 'uploaded_file',
    group_key: 'uploaded_files',
    title: 'screen.png',
    name: 'screen.png',
    mime_type: 'image/png',
    size: 128,
    url: '/uploads/files/project-1/screen.png',
    file_id: 'file-1',
    source_agent_id: 'user',
    source_display_name: '大哥',
    source_label: '用户上传',
    source: {
      type: 'user_upload',
      label: '用户上传',
      display_name: '大哥',
      agent_id: null,
      user_id: 'user',
      message_id: null,
      room_id: null,
      task_id: null,
      context: null,
    },
  }));

  assert.equal(file.id, 'file:file-1');
  assert.equal(file.source_type, 'uploaded_file');
  assert.equal(file.original_name, 'screen.png');
  assert.equal(file.mime_type, 'image/png');
  assert.equal(file.uploaded_by_name, '大哥');
  assert.equal(file.url, '/uploads/files/project-1/screen.png');
});

test('resource list adapter preserves uploaded file reference metadata', () => {
  const file = resourceListItemToProjectFile(createResourceListItem({
    id: 'file:file-1',
    asset_type: 'uploaded_file',
    resource_type: 'uploaded_file',
    group_key: 'uploaded_files',
    title: 'screen.png',
    name: 'screen.png',
    mime_type: 'image/png',
    size: 128,
    url: '/uploads/files/project-1/screen.png',
    file_id: 'file-1',
    source_agent_id: 'user',
    source_display_name: '大哥',
    source_context_id: 'room-1',
    source_context_name: '功能开发',
    source_context_type: 'room',
    source: {
      type: 'user_upload',
      label: '用户上传',
      display_name: '大哥',
      agent_id: null,
      user_id: 'user',
      message_id: null,
      room_id: 'room-1',
      task_id: null,
      context: {
        id: 'room-1',
        type: 'room',
        name: '功能开发',
      },
    },
    reference_count: 3,
    last_referenced_at: 123,
    last_referenced_message_id: 'message-3',
    last_referenced_room_id: 'room-1',
    last_referenced_room_name: '功能开发',
  }));

  assert.equal(file.reference_count, 3);
  assert.equal(file.last_referenced_at, 123);
  assert.equal(file.last_referenced_message_id, 'message-3');
  assert.equal(file.last_referenced_room_id, 'room-1');
  assert.equal(file.last_referenced_room_name, '功能开发');
  assert.equal(file.source_room_id, 'room-1');
});

test('resource list adapter preserves agent document source fields and old-data fallbacks', () => {
  const document = resourceListItemToProjectFile(createResourceListItem({
    id: 'asset-1',
    asset_type: 'agent_document',
    resource_type: 'agent_document',
    group_key: 'agent_documents',
    title: '执行总结.md',
    name: '执行总结.md',
    mime_type: null,
    size: null,
    url: null,
    source_message_id: 'message-1',
    source_room_id: 'room-1',
    source_agent_id: 'frontend-executor',
    source_task_id: 'task-1',
    source_context_id: 'room-1',
    source_context_name: '完整workflow修复验收',
    source_context_type: 'room',
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
        name: '完整workflow修复验收',
      },
    },
  }));

  assert.equal(document.source_type, 'agent_document');
  assert.equal(document.mime_type, 'text/markdown');
  assert.equal(document.size, 0);
  assert.equal(document.url, '');
  assert.equal(document.source_agent_id, 'frontend-executor');
  assert.equal(document.source_task_id, 'task-1');
  assert.equal(document.last_referenced_message_id, 'message-1');
  assert.equal(document.last_referenced_room_name, '完整workflow修复验收');
  assert.equal(document.reference_count, 1);
});

test('resource list adapter falls back for unknown resource types and missing source fields', () => {
  const unknown = resourceListItemToProjectFile(createResourceListItem({
    id: 'legacy-resource',
    asset_type: 'unknown',
    resource_type: 'legacy_type' as ResourceListItem['resource_type'],
    group_key: 'agent_documents',
    title: '',
    name: '',
    mime_type: null,
    size: null,
    url: null,
    source: {
      type: 'agent',
      label: '来源未记录',
      display_name: null,
      agent_id: null,
      user_id: null,
      message_id: null,
      room_id: null,
      task_id: null,
      context: null,
    },
  }));

  assert.equal(unknown.source_type, 'unknown');
  assert.equal(unknown.original_name, 'legacy-resource');
  assert.equal(unknown.mime_type, 'application/octet-stream');
  assert.equal(unknown.size, 0);
  assert.equal(unknown.url, '');
  assert.equal(unknown.reference_count, 0);
  assert.equal(unknown.last_referenced_message_id, null);
});

test('resource asset delete endpoint keeps encoded resource ids', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  let requestedMethod = '';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestedUrl = String(input);
    requestedMethod = init?.method ?? 'GET';
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  try {
    await api.deleteResourceAsset('asset:agent doc');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requestedUrl, '/api/resource-assets/asset%3Aagent%20doc');
  assert.equal(requestedMethod, 'DELETE');
});

test('listKnowledgeSources builds global knowledge query URL', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await api.listKnowledgeSources({
      projectId: 'project-1',
      roomId: 'room-1',
      status: 'ready',
      sourceType: 'agent_document',
      query: '部署 计划',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(
    requestedUrl,
    '/api/knowledge?projectId=project-1&roomId=room-1&status=ready&sourceType=agent_document&q=%E9%83%A8%E7%BD%B2+%E8%AE%A1%E5%88%92',
  );
});

test('knowledge detail API requests encoded source id', async () => {
  const requestedUrl = await captureApiRequest(
    () => api.getKnowledgeSource('source/id 1'),
    { id: 'source/id 1', project_id: 'p', source_type: 'uploaded_file', title: 'x', status: 'ready' },
  );

  assert.equal(requestedUrl, '/api/knowledge/sources/source%2Fid%201');
});

test('knowledge search API builds FTS query URL', async () => {
  const requestedUrl = await captureApiRequest(
    () => api.searchKnowledge({
      projectId: 'project-1',
      roomId: 'room-1',
      query: 'A12 验收',
      status: 'ready',
      sourceType: 'uploaded_file',
      limit: 10,
    }),
    [],
  );

  assert.equal(
    requestedUrl,
    '/api/knowledge/search?projectId=project-1&roomId=room-1&q=A12+%E9%AA%8C%E6%94%B6&status=ready&sourceType=uploaded_file&limit=10',
  );
});

test('knowledge Phase 4A APIs build query URLs and import payloads', async () => {
  const searchUrl = await captureApiRequest(
    () => api.searchKnowledge({ projectId: 'p1', query: 'A12', mode: 'hybrid' }),
    [],
  );
  assert.equal(searchUrl, '/api/knowledge/search?projectId=p1&q=A12&mode=hybrid');

  const insightsUrl = await captureApiRequest(
    () => api.getKnowledgeInsights({ projectId: 'p1', roomId: 'r1' }),
    {
      duplicates: { count: 0, source_ids: [] },
      stale: { count: 0, source_ids: [] },
      parser_incomplete: { count: 0, source_ids: [] },
      empty_index: { count: 0, source_ids: [] },
    },
  );
  assert.equal(insightsUrl, '/api/knowledge/insights?projectId=p1&roomId=r1');

  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body: string | null }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : null,
    });
    return new Response(JSON.stringify({ source: { id: 'source-1', status: 'ready' }, created: [], failed: [] }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await api.createManualKnowledge('p1', { title: 'Manual', content: 'A12', tags: ['manual'] });
    await api.createUrlKnowledge('p1', { url: 'https://example.com/a12', content: 'A12' });
    await api.importWorkspaceKnowledgeDocs('p1', { paths: ['docs/a12.md'], tags: ['docs'] });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requests, [
    {
      url: '/api/projects/p1/knowledge/manual',
      method: 'POST',
      body: JSON.stringify({ title: 'Manual', content: 'A12', tags: ['manual'] }),
    },
    {
      url: '/api/projects/p1/knowledge/url',
      method: 'POST',
      body: JSON.stringify({ url: 'https://example.com/a12', content: 'A12' }),
    },
    {
      url: '/api/projects/p1/knowledge/workspace-docs',
      method: 'POST',
      body: JSON.stringify({ paths: ['docs/a12.md'], tags: ['docs'] }),
    },
  ]);
});

test('session knowledge note API sends message save payload', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body: string | null }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : null,
    });
    return new Response(JSON.stringify({
      source: { id: 'source-1', project_id: 'project-1', source_type: 'session_note', title: '知识笔记', status: 'ready' },
      deduplicated: false,
      metadata: { decisions: [], constraints: [], risks: [], learnings: [] },
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await api.createSessionKnowledgeNote('session-1', { messageId: 'message-1' });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requests, [{
    url: '/api/sessions/session-1/knowledge-notes',
    method: 'POST',
    body: JSON.stringify({ messageId: 'message-1' }),
  }]);
});

test('knowledge chunks API builds filters', async () => {
  const requestedUrl = await captureApiRequest(
    () => api.listKnowledgeChunks('source/id 1', { enabled: 1, limit: 25, offset: 50 }),
    [],
  );

  assert.equal(
    requestedUrl,
    '/api/knowledge/sources/source%2Fid%201/chunks?enabled=1&limit=25&offset=50',
  );
});

test('knowledge action APIs send method and payload', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body: string | null }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : null,
    });
    return new Response(init?.method === 'DELETE' ? null : JSON.stringify({ id: 'source-1', status: 'ready' }), {
      status: init?.method === 'DELETE' ? 204 : 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await api.reprocessKnowledgeSource('source-1');
    await api.updateKnowledgeSource('source-1', {
      status: 'disabled',
      enabled: 0,
      metadataPatch: { decisions: ['采用 hybrid'] },
    });
    await api.deleteKnowledgeSource('source-1');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requests.map((request) => [request.url, request.method]), [
    ['/api/knowledge/sources/source-1/reprocess', 'POST'],
    ['/api/knowledge/sources/source-1', 'PATCH'],
    ['/api/knowledge/sources/source-1', 'DELETE'],
  ]);
  assert.equal(
    requests[1]?.body,
    JSON.stringify({ status: 'disabled', enabled: 0, metadataPatch: { decisions: ['采用 hybrid'] } }),
  );
});

test('workspace directory API requests encoded tree path', async () => {
  const requestedUrl = await captureApiRequest(
    () => api.listWorkspaceDirectory('project-1', 'src/app'),
    { path: 'src/app', entries: [] },
  );

  assert.equal(requestedUrl, '/api/projects/project-1/workspace/tree?path=src%2Fapp');
});

test('workspace file preview API requests encoded file path', async () => {
  const requestedUrl = await captureApiRequest(
    () => api.getWorkspaceFilePreview('project-1', 'src/App.tsx'),
    {
      path: 'src/App.tsx',
      size: 12,
      mimeType: 'text/plain',
      language: 'typescript',
      content: 'export {};\n',
      truncated: false,
    },
  );

  assert.equal(requestedUrl, '/api/projects/project-1/workspace/file?path=src%2FApp.tsx');
});

test('workspace blob API returns encoded local API URL', () => {
  assert.equal(
    api.getWorkspaceBlobUrl('project-1', 'public/logo.svg'),
    '/api/projects/project-1/workspace/blob?path=public%2Flogo.svg',
  );
});

test('workspace image blob API requests encoded file path', async () => {
  const requestedUrl = await captureApiRequest(
    () => api.getWorkspaceImageBlob('project-1', 'assets/photo.png'),
    'image bytes',
  );

  assert.equal(requestedUrl, '/api/projects/project-1/workspace/blob?path=assets%2Fphoto.png');
});

test('updateSession sends pinned_at patch payload', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  let requestedMethod = '';
  let requestedBody = '';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestedUrl = String(input);
    requestedMethod = init?.method ?? 'GET';
    requestedBody = String(init?.body ?? '');
    return new Response(JSON.stringify({
      id: 'session-1',
      project_id: 'project-1',
      title: 'Session',
      current_goal: null,
      mode: 'code',
      phase: 'idle',
      status: 'active',
      provider: 'codex',
      model: 'gpt-5.5',
      workspace_path: '/tmp/project',
      worktree_path: null,
      branch_name: null,
      forked_from_session_id: null,
      forked_from_history_record_id: null,
      latest_compaction_id: null,
      latest_context_manifest_id: null,
      closed_at: null,
      pinned_at: 123,
      last_viewed_at: null,
      created_at: 1,
      updated_at: 2,
      archived_at: null,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await api.updateSession('session-1', { pinned_at: 123 });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requestedUrl, '/api/sessions/session-1');
  assert.equal(requestedMethod, 'PATCH');
  assert.equal(requestedBody, JSON.stringify({ pinned_at: 123 }));
});

test('listRoomTaskEvents requests replay projection when enabled', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({
      events: [],
      replay: {
        task_id: 'task-1',
        room_id: 'room-1',
        title: 'Replayed task',
        description: null,
        status: 'review',
        priority: 'normal',
        interaction_mode: 'ask_user',
        assigned_agent_id: null,
        source_message_id: null,
        created_from: 'manual',
        deleted: false,
        created_event_id: 'event-1',
        last_event_id: 'event-3',
        last_seq: 3,
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const response = await api.listRoomTaskEvents('room-1', {
      taskId: 'task-1',
      layer: 'activity',
      limit: 20,
      replay: true,
    });

    assert.equal(
      requestedUrl,
      '/api/rooms/room-1/task-events?taskId=task-1&layer=activity&limit=20&replay=1',
    );
    assert.equal(response.replay?.title, 'Replayed task');
    assert.equal(response.replay?.last_seq, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('listTaskExecutors requests task-scoped executor sessions', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify([
      {
        id: 'executor-1',
        task_id: 'task-1',
        room_id: 'room-1',
        room_agent_id: 'agent-row-1',
        agent_id: 'codex',
        agent_name: 'Codex Agent',
        acp_backend: 'codex',
        acp_session_id: 'session-123456',
        status: 'running',
        acp_session_handoff_pending: 0,
        acp_session_handoff_reason: null,
        created_at: 1,
        updated_at: 2,
      },
    ]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const response = await api.listTaskExecutors('task-1');

    assert.equal(requestedUrl, '/api/tasks/task-1/executors');
    assert.equal(response[0]?.agent_name, 'Codex Agent');
    assert.equal(response[0]?.status, 'running');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('api exposes online skills helpers through workspaceRequest', async () => {
  const source = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');

  assert.match(source, /listOnlineSkills/);
  assert.match(source, /searchOnlineSkills/);
  assert.match(source, /getOnlineSkillAudit/);
  assert.match(source, /getOnlineSkillsTokenConfig/);
  assert.match(source, /updateOnlineSkillsTokenConfig/);
  assert.match(source, /workspaceRequest<OnlineSkillListResponse>\(`\/online-skills/);
  assert.match(source, /workspaceRequest<OnlineSkillsTokenConfig>\('\/online-skills\/config'/);

  const listUrl = await captureApiRequest(
    () => api.listOnlineSkills({ view: 'trending', page: 2, limit: 20 }),
    { skills: [], total: 0, page: 2, pages: 0, stale: false, updatedAt: 1 },
  );
  assert.equal(listUrl, '/api/online-skills?view=trending&page=2&limit=20');

  const searchUrl = await captureApiRequest(
    () => api.searchOnlineSkills({ q: 'browser', limit: 10 }),
    { skills: [], total: 0, page: 0, pages: 0, limit: 10, stale: false, updatedAt: 1 },
  );
  assert.equal(searchUrl, '/api/online-skills/search?q=browser&page=0&limit=10');

  const configUrl = await captureApiRequest(
    () => api.getOnlineSkillsTokenConfig(),
    {
      tokenConfigured: false,
      tokenPreview: null,
      source: 'none',
      storedTokenConfigured: false,
      storedTokenPreview: null,
      environmentTokenConfigured: false,
      environmentTokenPreview: null,
    },
  );
  assert.equal(configUrl, '/api/online-skills/config');
});

function createResourceListItem(input: Partial<ResourceListItem>): ResourceListItem {
  return {
    id: 'resource-1',
    project_id: 'project-1',
    asset_type: 'unknown',
    resource_type: 'unknown',
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
    source_label: '来源未记录',
    source_context_id: null,
    source_context_name: null,
    source_context_type: null,
    source: {
      type: 'agent',
      label: '来源未记录',
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
      markdown: false,
      delete: false,
    },
    preview_url: null,
    download_url: null,
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
    ...input,
  };
}

async function captureApiRequest<T>(call: () => Promise<T>, responseBody: unknown): Promise<string> {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await call();
    return requestedUrl;
  } finally {
    globalThis.fetch = originalFetch;
  }
}
