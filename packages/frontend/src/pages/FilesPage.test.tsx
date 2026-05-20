import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { buildFileResourceActions } from './FilesPage';
import type { ProjectFile } from '../lib/types';

const globalWithReact = globalThis as typeof globalThis & { React: typeof React };
globalWithReact.React = React;

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

function translateFileMessage(key: string): string {
  const messages: Record<string, string> = {
    'files.viewDocument': '查看文档',
    'files.preview': '预览',
    'files.viewDetails': '查看详情',
    'files.sourceTrace': '来源追踪',
    'files.download': '下载',
    'files.deleteDocument': '删除文档',
    'files.deleteFile': '删除文件',
  };
  return messages[key] ?? key;
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
