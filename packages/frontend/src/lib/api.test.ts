import assert from 'node:assert/strict';
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
