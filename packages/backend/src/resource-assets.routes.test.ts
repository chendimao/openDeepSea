import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-resource-assets-routes-')), 'test.db');

const { projectRepo } = await import('./repos/projects.js');
const { roomRepo } = await import('./repos/rooms.js');
const { taskRepo } = await import('./repos/tasks.js');
const { fileRepo } = await import('./repos/files.js');
const { messageRepo } = await import('./repos/messages.js');
const { router } = await import('./routes.js');
const express = (await import('express')).default;

const app = express();
app.use(express.json());
app.use('/api', router);

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const server = app.listen(0);
  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    return await fetch(`http://127.0.0.1:${address.port}${path}`, init);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function createProject(name: string) {
  const projectPath = mkdtempSync(join(tmpdir(), `opendeepsea-resource-assets-${name}-`));
  return projectRepo.create({ name, path: projectPath });
}

test('resource asset routes create, list, filter, detail, and delete agent documents without deleting source message', async () => {
  const project = createProject('agent-document');
  const room = roomRepo.create({ project_id: project.id, name: 'Document Room' });
  const task = taskRepo.create({
    project_id: project.id,
    room_id: room.id,
    title: 'Document task',
    description: 'Create a reusable document asset.',
    priority: 'normal',
    interaction_mode: 'ask_user',
    created_from: 'manual',
  });
  const message = messageRepo.create({
    room_id: room.id,
    sender_type: 'agent',
    sender_id: 'backend-executor',
    sender_name: '后端开发工程师',
    content: '# 方案\n\n这是可归档的 Markdown 文档。',
    message_type: 'agent_stream',
  });

  const createRes = await request(`/api/projects/${project.id}/resource-assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
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
    }),
  });
  assert.equal(createRes.status, 201);
  const created = await createRes.json() as {
    id: string;
    asset_type: string;
    group_key: string;
    source_message_id: string;
    source_room_id: string;
    source_agent_id: string;
    source_task_id: string;
  };
  assert.equal(created.asset_type, 'agent_document');
  assert.equal(created.group_key, 'agent_documents');
  assert.equal(created.source_message_id, message.id);
  assert.equal(created.source_room_id, room.id);
  assert.equal(created.source_agent_id, 'backend-executor');
  assert.equal(created.source_task_id, task.id);

  const listRes = await request(`/api/projects/${project.id}/resource-assets?assetType=agent_document&groupKey=agent_documents`);
  assert.equal(listRes.status, 200);
  const list = await listRes.json() as Array<{ id: string; title: string; content?: string }>;
  assert.deepEqual(list.map((item) => item.id), [created.id]);
  assert.equal(list[0]?.title, '方案文档');
  assert.equal(Object.hasOwn(list[0] ?? {}, 'content'), false);

  const detailRes = await request(`/api/resource-assets/${created.id}`);
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json() as { id: string; content: string; metadata: string | null };
  assert.equal(detail.id, created.id);
  assert.equal(detail.content, message.content);
  assert.deepEqual(JSON.parse(detail.metadata ?? '{}'), { summary: '方案' });

  const deleteRes = await request(`/api/resource-assets/${created.id}`, { method: 'DELETE' });
  assert.equal(deleteRes.status, 204);
  assert.ok(messageRepo.get(message.id), 'source message should remain after deleting resource asset');

  const afterDeleteRes = await request(`/api/projects/${project.id}/resource-assets?assetType=agent_document`);
  assert.equal(afterDeleteRes.status, 200);
  assert.deepEqual(await afterDeleteRes.json(), []);
});

test('resource asset list includes uploaded files without breaking existing file records', async () => {
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

  const listRes = await request(`/api/projects/${project.id}/resource-assets`);
  assert.equal(listRes.status, 200);
  const assets = await listRes.json() as Array<{
    id: string;
    asset_type: string;
    group_key: string;
    file_id?: string;
    title: string;
  }>;

  assert.ok(assets.some((asset) =>
    asset.id === `file:${file.id}` &&
    asset.file_id === file.id &&
    asset.asset_type === 'uploaded_file' &&
    asset.group_key === 'uploaded_files' &&
    asset.title === 'screen.png',
  ));
  assert.equal(fileRepo.get(file.id)?.deleted_at, null);
});

test('resource asset routes reject source fields outside the project boundary', async () => {
  const project = createProject('valid-boundary');
  const otherProject = createProject('invalid-boundary');
  const otherRoom = roomRepo.create({ project_id: otherProject.id, name: 'Other Room' });
  const otherMessage = messageRepo.create({
    room_id: otherRoom.id,
    sender_type: 'agent',
    sender_id: 'planner',
    sender_name: 'Planner',
    content: '# other',
    message_type: 'agent_stream',
  });

  const createRes = await request(`/api/projects/${project.id}/resource-assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      asset_type: 'agent_document',
      title: 'Invalid source',
      content: '# invalid',
      source_message_id: otherMessage.id,
      source_room_id: otherRoom.id,
      source_agent_id: 'planner',
    }),
  });

  assert.equal(createRes.status, 400);
});
