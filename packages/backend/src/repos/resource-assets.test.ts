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
  assert.equal(listed[0]?.source_display_name, '后端开发工程师');
  assert.equal(listed[0]?.source_label, '智能体生成');
  assert.equal(listed[0]?.source_context_id, task.id);
  assert.equal(listed[0]?.source_context_name, task.title);
  assert.equal(listed[0]?.source_context_type, 'task');
  assert.equal(listed[0]?.content, undefined);

  const detail = resourceAssetRepo.get(created.id);
  assert.equal(detail?.content, message.content);
  assert.equal(detail?.source_display_name, '后端开发工程师');
  assert.equal(detail?.source_label, '智能体生成');
  assert.equal(detail?.source_context_id, task.id);
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
    asset.title === 'screen.png' &&
    asset.source_display_name === 'You' &&
    asset.source_label === '用户上传',
  ));
  assert.equal(fileRepo.get(file.id)?.deleted_at, null);
});

test('resourceAssetRepo searches uploaded files and agent documents', () => {
  const project = createProject('search-assets');
  const room = roomRepo.create({ project_id: project.id, name: 'Search Room' });
  fileRepo.create({
    project_id: project.id,
    original_name: 'upload-search.txt',
    stored_name: 'stored.txt',
    mime_type: 'text/plain',
    size: 128,
    url: `/uploads/files/${project.id}/stored.txt`,
    storage_path: join(tmpdir(), 'stored.txt'),
    uploaded_by_id: null,
    uploaded_by_name: null,
  });
  const message = messageRepo.create({
    room_id: room.id,
    sender_type: 'agent',
    sender_id: 'backend-executor',
    sender_name: '后端开发工程师',
    content: '# 搜索文档\n\nMarkdown 内容。',
    message_type: 'agent_stream',
  });
  const document = resourceAssetRepo.create({
    project_id: project.id,
    asset_type: 'agent_document',
    title: '搜索文档',
    content: message.content,
    source_message_id: message.id,
    source_room_id: room.id,
    source_agent_id: 'backend-executor',
  });

  const uploadMatches = resourceAssetRepo.list({ projectId: project.id, query: 'upload-search' });
  assert.deepEqual(uploadMatches.map((asset) => asset.asset_type), ['uploaded_file']);

  const documentMatches = resourceAssetRepo.list({ projectId: project.id, query: 'Markdown 内容' });
  assert.deepEqual(documentMatches.map((asset) => asset.id), [document.id]);
});

test('resourceAssetRepo exposes unified list and typed details with capabilities', () => {
  const project = createProject('unified-resources');
  const room = roomRepo.create({ project_id: project.id, name: 'Unified Room' });
  const upload = fileRepo.create({
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
  const message = messageRepo.create({
    room_id: room.id,
    sender_type: 'agent',
    sender_id: 'backend-executor',
    sender_name: '后端开发工程师',
    content: '# 统一资源详情\n\nMarkdown 内容。',
    message_type: 'agent_stream',
  });
  const document = resourceAssetRepo.create({
    project_id: project.id,
    asset_type: 'agent_document',
    title: '统一资源详情.md',
    content: message.content,
    mime_type: 'text/markdown',
    source_message_id: message.id,
    source_room_id: room.id,
    source_agent_id: 'backend-executor',
  });

  const listed = resourceAssetRepo.listResources({ projectId: project.id });
  const uploadItem = listed.find((item) => item.id === `file:${upload.id}`);
  const documentItem = listed.find((item) => item.id === document.id);

  assert.equal(uploadItem?.name, 'screen.png');
  assert.equal(uploadItem?.resource_type, 'uploaded_file');
  assert.deepEqual(uploadItem?.capabilities, {
    preview: true,
    download: true,
    markdown: false,
    delete: false,
  });
  assert.deepEqual(uploadItem?.created_by, { id: 'user', name: 'You', type: 'user' });
  assert.deepEqual(uploadItem?.available_actions, ['preview', 'download']);
  assert.equal(uploadItem?.source.type, 'user_upload');
  assert.equal(uploadItem?.source.display_name, 'You');
  assert.equal(Object.hasOwn(uploadItem ?? {}, 'content'), false);

  assert.equal(documentItem?.name, '统一资源详情.md');
  assert.equal(documentItem?.resource_type, 'agent_document');
  assert.deepEqual(documentItem?.capabilities, {
    preview: true,
    download: false,
    markdown: true,
    delete: true,
  });
  assert.deepEqual(documentItem?.created_by, { id: 'backend-executor', name: '后端开发工程师', type: 'agent' });
  assert.deepEqual(documentItem?.available_actions, ['preview', 'view_markdown', 'delete']);
  assert.equal(documentItem?.source.type, 'agent');
  assert.equal(documentItem?.source.display_name, '后端开发工程师');
  assert.equal(documentItem?.source.context?.id, room.id);

  const uploadDetail = resourceAssetRepo.getResource(`file:${upload.id}`);
  assert.equal(uploadDetail?.resource_type, 'uploaded_file');
  assert.deepEqual(uploadDetail?.created_by, { id: 'user', name: 'You', type: 'user' });
  assert.deepEqual(uploadDetail?.available_actions, ['preview', 'download']);
  assert.equal(uploadDetail?.preview_url, upload.url);
  assert.equal(uploadDetail?.download_url, upload.url);
  assert.equal(uploadDetail?.content, null);

  const documentDetail = resourceAssetRepo.getResource(document.id);
  assert.equal(documentDetail?.resource_type, 'agent_document');
  assert.deepEqual(documentDetail?.created_by, { id: 'backend-executor', name: '后端开发工程师', type: 'agent' });
  assert.deepEqual(documentDetail?.available_actions, ['preview', 'view_markdown', 'delete']);
  assert.equal(documentDetail?.content, message.content);
  assert.equal(documentDetail?.preview_url, null);
  assert.equal(documentDetail?.download_url, null);
  assert.equal(documentDetail?.source.message_id, message.id);
});

test('resourceAssetRepo resolves project file list ids and hides deleted agent documents in detail', () => {
  const project = createProject('project-file-ids');
  const room = roomRepo.create({ project_id: project.id, name: 'Project File Room' });
  const upload = fileRepo.create({
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
  const message = messageRepo.create({
    room_id: room.id,
    sender_type: 'agent',
    sender_id: 'backend-executor',
    sender_name: '后端开发工程师',
    content: '# 可预览文档\n\nMarkdown 内容。',
    message_type: 'agent_stream',
  });
  const documentFile = fileRepo.createAgentDocument({
    project_id: project.id,
    title: '可预览文档.md',
    content: message.content,
    source_message_id: message.id,
    source_room_id: room.id,
    source_agent_id: 'backend-executor',
    source_task_id: null,
  });

  const uploadDetail = resourceAssetRepo.getResource(upload.id);
  assert.equal(uploadDetail?.id, `file:${upload.id}`);
  assert.equal(uploadDetail?.resource_type, 'uploaded_file');
  assert.equal(uploadDetail?.preview_url, upload.url);

  const documentDetail = resourceAssetRepo.getResource(documentFile.id);
  assert.equal(documentDetail?.id, documentFile.id.slice('asset:'.length));
  assert.equal(documentDetail?.resource_type, 'agent_document');
  assert.equal(documentDetail?.content, message.content);

  resourceAssetRepo.softDelete(documentFile.id);

  assert.equal(resourceAssetRepo.getResource(documentFile.id), undefined);
});

test('resourceAssetRepo keeps agent document registration idempotent by source message', () => {
  const project = createProject('idempotent-document');
  const room = roomRepo.create({ project_id: project.id, name: 'Idempotent Room' });
  const message = messageRepo.create({
    room_id: room.id,
    sender_type: 'agent',
    sender_id: 'backend-executor',
    sender_name: '后端开发工程师',
    content: '# 交付总结\n\n- 第一版',
    message_type: 'agent_stream',
  });

  const first = resourceAssetRepo.ensure({
    project_id: project.id,
    asset_type: 'agent_document',
    title: '交付总结',
    content: message.content,
    mime_type: 'text/markdown',
    source_message_id: message.id,
    source_room_id: room.id,
    source_agent_id: 'backend-executor',
    unique_source_message_id: message.id,
  });
  const second = resourceAssetRepo.ensure({
    project_id: project.id,
    asset_type: 'agent_document',
    title: '交付总结',
    content: `${message.content}\n\n- 第二版`,
    mime_type: 'text/markdown',
    source_message_id: message.id,
    source_room_id: room.id,
    source_agent_id: 'backend-executor',
    unique_source_message_id: message.id,
  });

  assert.equal(first.id, second.id);
  assert.equal(resourceAssetRepo.list({ projectId: project.id, assetType: 'agent_document' }).length, 1);
  assert.equal(resourceAssetRepo.get(first.id)?.content, message.content);
});
