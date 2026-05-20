import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
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
const { db, migrateUniqueAgentDocumentSourceMessage } = await import('../db.js');

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

  const listed = resourceAssetRepo.listResources({ projectId: project.id, assetType: 'agent_document', groupKey: 'agent_documents' });

  assert.deepEqual(listed.map((asset) => asset.id), [created.id]);
  assert.equal(listed[0]?.source_message_id, message.id);
  assert.equal(listed[0]?.source_room_id, room.id);
  assert.equal(listed[0]?.source_agent_id, 'backend-executor');
  assert.equal(listed[0]?.source_task_id, task.id);
  assert.equal(listed[0]?.source_display_name, '后端开发工程师');
  assert.equal(listed[0]?.source_label, '智能体生成');
  assert.equal(listed[0]?.source_summary, '智能体生成 · 后端开发工程师 · Document task');
  assert.equal(listed[0]?.source_context_id, task.id);
  assert.equal(listed[0]?.source_context_name, task.title);
  assert.equal(listed[0]?.source_context_type, 'task');
  assert.equal(listed[0]?.content, undefined);

  const detail = resourceAssetRepo.getResource(created.id);
  assert.equal(detail?.content, message.content);
  assert.equal(detail?.source_display_name, '后端开发工程师');
  assert.equal(detail?.source_label, '智能体生成');
  assert.equal(detail?.source_summary, '智能体生成 · 后端开发工程师 · Document task');
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

  const listed = resourceAssetRepo.listResources({ projectId: project.id });

  assert.ok(listed.some((asset) =>
    asset.id === `file:${file.id}` &&
    asset.file_id === file.id &&
    asset.asset_type === 'uploaded_file' &&
    asset.group_key === 'uploaded_files' &&
    asset.title === 'screen.png' &&
    asset.source_display_name === 'You' &&
    asset.source_label === '用户上传',
  ));
  assert.equal(listed.find((asset) => asset.id === `file:${file.id}`)?.source_summary, 'You');
  assert.equal(fileRepo.get(file.id)?.deleted_at, null);
});

test('resourceAssetRepo filters unified resources by room', () => {
  const project = createProject('resource-room-filter');
  const room = roomRepo.create({ project_id: project.id, name: 'Room Filter' });
  const otherRoom = roomRepo.create({ project_id: project.id, name: 'Other Room' });
  const targetFile = fileRepo.create({
    project_id: project.id,
    original_name: 'target.png',
    stored_name: 'target.png',
    mime_type: 'image/png',
    size: 128,
    url: `/uploads/files/${project.id}/target.png`,
    storage_path: join(tmpdir(), 'target.png'),
    uploaded_by_id: 'user',
    uploaded_by_name: 'You',
  });
  const otherFile = fileRepo.create({
    project_id: project.id,
    original_name: 'other.png',
    stored_name: 'other.png',
    mime_type: 'image/png',
    size: 128,
    url: `/uploads/files/${project.id}/other.png`,
    storage_path: join(tmpdir(), 'other.png'),
    uploaded_by_id: 'user',
    uploaded_by_name: 'You',
  });
  fileRepo.addMessageRefs({
    project_id: project.id,
    room_id: room.id,
    message_id: messageRepo.create({
      room_id: room.id,
      sender_type: 'user',
      sender_id: 'user',
      sender_name: 'You',
      content: 'room ref',
      message_type: 'text',
    }).id,
    file_ids: [targetFile.id],
  });
  fileRepo.addMessageRefs({
    project_id: project.id,
    room_id: otherRoom.id,
    message_id: messageRepo.create({
      room_id: otherRoom.id,
      sender_type: 'user',
      sender_id: 'user',
      sender_name: 'You',
      content: 'other room ref',
      message_type: 'text',
    }).id,
    file_ids: [otherFile.id],
  });
  const targetMessage = messageRepo.create({
    room_id: room.id,
    sender_type: 'agent',
    sender_id: 'backend-executor',
    sender_name: '后端开发工程师',
    content: '# Target document',
    message_type: 'agent_stream',
  });
  const targetDocument = resourceAssetRepo.create({
    project_id: project.id,
    asset_type: 'agent_document',
    title: 'target.md',
    content: targetMessage.content,
    source_message_id: targetMessage.id,
    source_room_id: room.id,
    source_agent_id: 'backend-executor',
  });
  const otherMessage = messageRepo.create({
    room_id: otherRoom.id,
    sender_type: 'agent',
    sender_id: 'planner',
    sender_name: 'Planner',
    content: '# Other document',
    message_type: 'agent_stream',
  });
  resourceAssetRepo.create({
    project_id: project.id,
    asset_type: 'agent_document',
    title: 'other.md',
    content: otherMessage.content,
    source_message_id: otherMessage.id,
    source_room_id: otherRoom.id,
    source_agent_id: 'planner',
  });

  const listed = resourceAssetRepo.listResources({ projectId: project.id, roomId: room.id });

  assert.deepEqual(new Set(listed.map((asset) => asset.id)), new Set([targetDocument.id, `file:${targetFile.id}`]));
  assert.equal(listed.some((asset) => asset.id === `file:${otherFile.id}`), false);
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

  const uploadMatches = resourceAssetRepo.listResources({ projectId: project.id, query: 'upload-search' });
  assert.deepEqual(uploadMatches.map((asset) => asset.asset_type), ['uploaded_file']);
  assert.equal(resourceAssetRepo.listResources({ projectId: project.id, query: '用户上传' }).some((asset) => asset.asset_type === 'uploaded_file'), true);

  const documentMatches = resourceAssetRepo.listResources({ projectId: project.id, query: 'Markdown 内容' });
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
  assert.equal(uploadItem?.source_summary, 'You');
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
  assert.equal(documentItem?.source_summary, '智能体生成 · 后端开发工程师 · Unified Room');
  assert.deepEqual(documentItem?.created_by, { id: 'backend-executor', name: '后端开发工程师', type: 'agent' });
  assert.deepEqual(documentItem?.available_actions, ['preview', 'view_markdown', 'delete']);
  assert.equal(documentItem?.source.type, 'agent');
  assert.equal(documentItem?.source.display_name, '后端开发工程师');
  assert.equal(documentItem?.source.context?.id, room.id);

  const uploadDetail = resourceAssetRepo.getResource(`file:${upload.id}`);
  assert.equal(uploadDetail?.resource_type, 'uploaded_file');
  assert.equal(uploadDetail?.source_summary, 'You');
  assert.deepEqual(uploadDetail?.created_by, { id: 'user', name: 'You', type: 'user' });
  assert.deepEqual(uploadDetail?.available_actions, ['preview', 'download']);
  assert.equal(uploadDetail?.preview_url, upload.url);
  assert.equal(uploadDetail?.download_url, upload.url);
  assert.equal(uploadDetail?.content, null);

  const documentDetail = resourceAssetRepo.getResource(document.id);
  assert.equal(documentDetail?.resource_type, 'agent_document');
  assert.equal(documentDetail?.source_summary, '智能体生成 · 后端开发工程师 · Unified Room');
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

test('resourceAssetRepo normalizes blank source message ids without deduping unrelated documents', () => {
  const project = createProject('blank-source-message');
  const room = roomRepo.create({ project_id: project.id, name: 'Blank Source Room' });

  const first = resourceAssetRepo.ensure({
    project_id: project.id,
    asset_type: 'agent_document',
    title: '空白来源 A',
    content: '# 空白来源 A',
    mime_type: 'text/markdown',
    source_message_id: '   ',
    source_room_id: room.id,
    source_agent_id: 'backend-executor',
    unique_source_message_id: '   ',
  });
  const second = resourceAssetRepo.ensure({
    project_id: project.id,
    asset_type: 'agent_document',
    title: '空白来源 B',
    content: '# 空白来源 B',
    mime_type: 'text/markdown',
    source_message_id: '',
    source_room_id: room.id,
    source_agent_id: 'backend-executor',
    unique_source_message_id: '',
  });

  assert.notEqual(second.id, first.id);
  const assets = resourceAssetRepo.list({ projectId: project.id, assetType: 'agent_document' });
  assert.equal(assets.length, 2);
  assert.deepEqual(assets.map((asset) => asset.source_message_id), [null, null]);
});

test('resourceAssetRepo falls back to the existing agent document when insert hits the unique source message guard', () => {
  const project = createProject('unique-guard-document');
  const room = roomRepo.create({ project_id: project.id, name: 'Unique Guard Room' });
  const message = messageRepo.create({
    room_id: room.id,
    sender_type: 'agent',
    sender_id: 'backend-executor',
    sender_name: '后端开发工程师',
    content: '# 唯一约束\n\n第一版',
    message_type: 'agent_stream',
  });

  const created = resourceAssetRepo.create({
    project_id: project.id,
    asset_type: 'agent_document',
    group_key: 'agent_documents',
    title: '唯一约束',
    content: message.content,
    mime_type: 'text/markdown',
    source_message_id: message.id,
    source_room_id: room.id,
    source_agent_id: 'backend-executor',
  });

  const fallback = resourceAssetRepo.ensure({
    project_id: project.id,
    asset_type: 'agent_document',
    title: '唯一约束',
    content: '# 唯一约束\n\n第二版',
    mime_type: 'text/markdown',
    source_message_id: message.id,
    source_room_id: room.id,
    source_agent_id: 'backend-executor',
    unique_source_message_id: message.id,
  });

  assert.equal(fallback.id, created.id);
  assert.equal(resourceAssetRepo.list({ projectId: project.id, assetType: 'agent_document' }).length, 1);
  assert.equal(resourceAssetRepo.get(created.id)?.content, message.content);
});

test('resourceAssetRepo migrates duplicate agent documents by source message when bootstrapping unique index support', () => {
  const migrationDbPath = join(mkdtempSync(join(tmpdir(), 'opendeepsea-resource-assets-migration-')), 'test.db');
  const migrationDb = new Database(migrationDbPath);
  migrationDb.pragma('journal_mode = WAL');
  migrationDb.pragma('foreign_keys = ON');
  migrationDb.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      description TEXT,
      message_routing_mode TEXT NOT NULL DEFAULT 'fallback_reply',
      fallback_agent_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE rooms (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      sender_type TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      sender_name TEXT,
      content TEXT NOT NULL,
      message_type TEXT NOT NULL DEFAULT 'text',
      metadata TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE files (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      url TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      uploaded_by_id TEXT,
      uploaded_by_name TEXT,
      created_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
    CREATE TABLE resource_assets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      asset_type TEXT NOT NULL,
      group_key TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT,
      mime_type TEXT,
      size INTEGER,
      url TEXT,
      file_id TEXT,
      source_message_id TEXT,
      source_room_id TEXT,
      source_agent_id TEXT,
      source_task_id TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
  `);

  const projectId = 'project-migration';
  const roomId = 'room-migration';
  const messageId = 'message-migration';
  const latestId = 'asset-newer';
  const olderId = 'asset-older';
  const blankId = 'asset-blank';
  const whitespaceId = 'asset-whitespace';
  const timestamp = Date.now();
  migrationDb.prepare('INSERT INTO projects VALUES (?, ?, ?, NULL, ?, NULL, ?, ?)')
    .run(projectId, 'Migration Project', '/tmp/project-migration', 'fallback_reply', timestamp - 1000, timestamp - 1000);
  migrationDb.prepare('INSERT INTO rooms VALUES (?, ?, ?, NULL, ?)')
    .run(roomId, projectId, 'Migration Room', timestamp - 900);
  migrationDb.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)')
    .run(messageId, roomId, 'agent', 'backend-executor', '后端开发工程师', '# 去重迁移\n\n保留最新版本', 'agent_stream', timestamp - 800);
  migrationDb.prepare(
    `INSERT INTO resource_assets (
      id, project_id, asset_type, group_key, title, content, mime_type, size, url, file_id,
      source_message_id, source_room_id, source_agent_id, source_task_id, metadata,
      created_at, updated_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    olderId,
    projectId,
    'agent_document',
    'agent_documents',
    '去重迁移',
    '# 去重迁移\n\n旧版',
    'text/markdown',
    12,
    null,
    null,
    messageId,
    roomId,
    'backend-executor',
    null,
    null,
    timestamp - 700,
    timestamp - 700,
  );
  migrationDb.prepare(
    `INSERT INTO resource_assets (
      id, project_id, asset_type, group_key, title, content, mime_type, size, url, file_id,
      source_message_id, source_room_id, source_agent_id, source_task_id, metadata,
      created_at, updated_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    latestId,
    projectId,
    'agent_document',
    'agent_documents',
    '去重迁移',
    '# 去重迁移\n\n保留最新版本',
    'text/markdown',
    18,
    null,
    null,
    messageId,
    roomId,
    'backend-executor',
    null,
    null,
    timestamp - 600,
    timestamp - 600,
  );
  migrationDb.prepare(
    `INSERT INTO resource_assets (
      id, project_id, asset_type, group_key, title, content, mime_type, size, url, file_id,
      source_message_id, source_room_id, source_agent_id, source_task_id, metadata,
      created_at, updated_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    blankId,
    projectId,
    'agent_document',
    'agent_documents',
    '空白来源',
    '# 空白来源',
    'text/markdown',
    12,
    null,
    null,
    '',
    roomId,
    'backend-executor',
    null,
    null,
    timestamp - 500,
    timestamp - 500,
  );
  migrationDb.prepare(
    `INSERT INTO resource_assets (
      id, project_id, asset_type, group_key, title, content, mime_type, size, url, file_id,
      source_message_id, source_room_id, source_agent_id, source_task_id, metadata,
      created_at, updated_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    whitespaceId,
    projectId,
    'agent_document',
    'agent_documents',
    '空白来源 2',
    '# 空白来源 2',
    'text/markdown',
    12,
    null,
    null,
    '   ',
    roomId,
    'backend-executor',
    null,
    null,
    timestamp - 400,
    timestamp - 400,
  );

  migrateUniqueAgentDocumentSourceMessage(migrationDb);

  const active = migrationDb.prepare(
    'SELECT id, deleted_at FROM resource_assets WHERE project_id = ? AND source_message_id = ? ORDER BY created_at DESC',
  ).all(projectId, messageId) as Array<{ id: string; deleted_at: number | null }>;
  assert.equal(active.length, 2);
  assert.equal(active[0]?.id, latestId);
  assert.equal(active[0]?.deleted_at, null);
  assert.equal(active[1]?.id, olderId);
  assert.equal(active[1]?.deleted_at !== null, true);
  const indexRow = migrationDb.prepare(
    "SELECT count(1) AS count FROM sqlite_master WHERE type = 'index' AND name = 'idx_resource_assets_unique_source_message'",
  ).get() as { count: number };
  assert.equal(indexRow.count, 1);
  const blankRows = migrationDb.prepare(
    'SELECT id, source_message_id, deleted_at FROM resource_assets WHERE id IN (?, ?) ORDER BY created_at ASC',
  ).all(blankId, whitespaceId) as Array<{ id: string; source_message_id: string | null; deleted_at: number | null }>;
  assert.deepEqual(blankRows.map((row) => row.id), [blankId, whitespaceId]);
  assert.deepEqual(blankRows.map((row) => row.source_message_id), [null, null]);
  assert.deepEqual(blankRows.map((row) => row.deleted_at), [null, null]);
});
