import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-resource-assets-repo-')), 'test.db');

const { projectRepo } = await import('./projects.js');
const { roomRepo } = await import('./rooms.js');
const { taskRepo } = await import('./tasks.js');
const { fileRepo } = await import('./files.js');
const { messageRepo } = await import('./messages.js');
const { resourceAssetRepo } = await import('./resource-assets.js');

function createProject(name: string) {
  const projectPath = mkdtempSync(join(tmpdir(), `opendeepsea-resource-assets-repo-${name}-`));
  return projectRepo.create({ name, path: projectPath });
}

test('resourceAssetRepo creates and lists agent documents with source fields', () => {
  const project = createProject('agent-document');
  const room = roomRepo.create({ project_id: project.id, name: 'Document Room' });
  const task = taskRepo.create({
    project_id: project.id,
    room_id: room.id,
    title: 'Document task',
    description: 'Create a reusable document asset.',
  });
  const message = messageRepo.create({
    room_id: room.id,
    sender_type: 'agent',
    sender_id: 'backend-executor',
    sender_name: '后端开发工程师',
    content: '# 方案\n\n这是可归档的 Markdown 文档。',
    message_type: 'agent_stream',
  });

  const created = resourceAssetRepo.create({
    project_id: project.id,
    asset_type: 'agent_document',
    group_key: 'agent_documents',
    title: '方案文档',
    content: message.content,
    mime_type: 'text/markdown',
    source_message_id: message.id,
    source_room_id: room.id,
    source_agent_id: 'backend-executor',
    source_task_id: task.id,
    metadata: { summary: '方案' },
  });

  const listed = resourceAssetRepo.list({ projectId: project.id, assetType: 'agent_document', groupKey: 'agent_documents' });

  assert.deepEqual(listed.map((asset) => asset.id), [created.id]);
  assert.equal(listed[0]?.source_message_id, message.id);
  assert.equal(listed[0]?.source_room_id, room.id);
  assert.equal(listed[0]?.source_agent_id, 'backend-executor');
  assert.equal(listed[0]?.source_task_id, task.id);
  assert.equal(listed[0]?.content, undefined);

  const detail = resourceAssetRepo.get(created.id);
  assert.equal(detail?.content, message.content);
  assert.deepEqual(JSON.parse(detail?.metadata ?? '{}'), { summary: '方案' });
});

test('resourceAssetRepo soft deletes agent document without deleting source message', () => {
  const project = createProject('delete-document');
  const room = roomRepo.create({ project_id: project.id, name: 'Document Room' });
  const message = messageRepo.create({
    room_id: room.id,
    sender_type: 'agent',
    sender_id: 'planner',
    sender_name: 'Planner',
    content: '# keep source',
    message_type: 'agent_stream',
  });
  const created = resourceAssetRepo.create({
    project_id: project.id,
    asset_type: 'agent_document',
    group_key: 'agent_documents',
    title: 'Keep source',
    content: message.content,
    source_message_id: message.id,
    source_room_id: room.id,
    source_agent_id: 'planner',
  });

  const deleted = resourceAssetRepo.softDelete(created.id);

  assert.equal(deleted?.deleted_at !== null, true);
  assert.deepEqual(resourceAssetRepo.list({ projectId: project.id, assetType: 'agent_document' }), []);
  assert.ok(messageRepo.get(message.id));
});

test('resourceAssetRepo combines uploaded files into resource list', () => {
  const project = createProject('uploaded-file');
  const file = fileRepo.create({
    project_id: project.id,
    original_name: 'screen.png',
    stored_name: 'stored.png',
    mime_type: 'image/png',
    size: 128,
    url: `/uploads/files/${project.id}/stored.png`,
    storage_path: join(tmpdir(), 'stored.png'),
    uploaded_by_id: 'user',
    uploaded_by_name: 'You',
  });

  const listed = resourceAssetRepo.list({ projectId: project.id });

  assert.ok(listed.some((asset) =>
    asset.id === `file:${file.id}` &&
    asset.file_id === file.id &&
    asset.asset_type === 'uploaded_file' &&
    asset.group_key === 'uploaded_files' &&
    asset.title === 'screen.png',
  ));
  assert.equal(fileRepo.get(file.id)?.deleted_at, null);
});
