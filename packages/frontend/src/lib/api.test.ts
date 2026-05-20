import assert from 'node:assert/strict';
import test from 'node:test';
import { resourceListItemToProjectFile } from './api';
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
