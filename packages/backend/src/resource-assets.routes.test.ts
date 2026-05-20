import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { IncomingMessage, ServerResponse, type OutgoingHttpHeaders } from 'node:http';
import { Duplex } from 'node:stream';

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

class InMemorySocket extends Duplex {
  _read(): void {}

  _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    callback();
  }
}

function toResponseHeaders(headers: OutgoingHttpHeaders): Headers {
  const responseHeaders = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) responseHeaders.append(name, item);
    } else {
      responseHeaders.set(name, String(value));
    }
  }
  return responseHeaders;
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const serializedRequest = new Request(`http://127.0.0.1${path}`, init);
  const body = init.body === undefined || init.body === null
    ? null
    : Buffer.from(await serializedRequest.arrayBuffer());
  const socket = new InMemorySocket();
  const req = new IncomingMessage(socket as unknown as import('node:net').Socket);
  req.method = init.method ?? 'GET';
  req.url = path;
  req.headers = Object.fromEntries(serializedRequest.headers);
  req.httpVersion = '1.1';
  req.httpVersionMajor = 1;
  req.httpVersionMinor = 1;
  if (body) {
    req.headers['content-length'] = String(body.byteLength);
  }

  const res = new ServerResponse(req);
  res.assignSocket(socket as unknown as import('node:net').Socket);

  const chunks: Buffer[] = [];
  res.write = ((chunk: unknown, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    if (chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : undefined));
    }
    if (typeof encoding === 'function') encoding();
    if (callback) callback();
    return true;
  }) as typeof res.write;
  res.end = ((chunk?: unknown, encoding?: BufferEncoding | (() => void), callback?: () => void) => {
    if (chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : undefined));
    }
    if (typeof encoding === 'function') encoding();
    if (callback) callback();
    res.emit('finish');
    res.emit('close');
    return res;
  }) as typeof res.end;

  const responsePromise = new Promise<Response>((resolve, reject) => {
    res.once('finish', () => {
      const responseBody = res.statusCode === 204 || res.statusCode === 304 ? null : Buffer.concat(chunks);
      resolve(new Response(responseBody, {
        status: res.statusCode,
        headers: toResponseHeaders(res.getHeaders()),
      }));
    });
    (app as unknown as { handle: (...args: unknown[]) => void }).handle(req, res, (error: unknown) => {
      if (error) reject(error);
    });
  });

  if (body) {
    req.push(body);
  }
  req.push(null);
  req.complete = true;

  return responsePromise;
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
  const list = await listRes.json() as Array<{
    id: string;
    title: string;
    content?: string;
    source_display_name: string | null;
    source_label: string;
    source_summary: string;
    source_context_id: string | null;
    source_context_name: string | null;
    source_context_type: string | null;
  }>;
  assert.deepEqual(list.map((item) => item.id), [created.id]);
  assert.equal(list[0]?.title, '方案文档');
  assert.equal(list[0]?.source_display_name, '后端开发工程师');
  assert.equal(list[0]?.source_label, '智能体生成');
  assert.equal(list[0]?.source_summary, '智能体生成 · 后端开发工程师 · Document task');
  assert.equal(list[0]?.source_context_id, task.id);
  assert.equal(list[0]?.source_context_name, task.title);
  assert.equal(list[0]?.source_context_type, 'task');
  assert.equal(Object.hasOwn(list[0] ?? {}, 'content'), false);

  const detailRes = await request(`/api/resource-assets/${created.id}`);
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json() as {
    id: string;
    content: string;
    metadata: string | null;
    source_display_name: string | null;
    source_label: string;
    source_summary: string;
    source_context_id: string | null;
  };
  assert.equal(detail.id, created.id);
  assert.equal(detail.content, message.content);
  assert.equal(detail.source_display_name, '后端开发工程师');
  assert.equal(detail.source_label, '智能体生成');
  assert.equal(detail.source_summary, '智能体生成 · 后端开发工程师 · Document task');
  assert.equal(detail.source_context_id, task.id);
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
    source_display_name: string | null;
    source_label: string;
    source_summary: string;
  }>;

  assert.ok(assets.some((asset) =>
    asset.id === `file:${file.id}` &&
    asset.file_id === file.id &&
    asset.asset_type === 'uploaded_file' &&
    asset.group_key === 'uploaded_files' &&
    asset.title === 'screen.png' &&
    asset.source_display_name === 'You' &&
    asset.source_label === '用户上传',
  ));
  assert.equal(assets.find((asset) => asset.id === `file:${file.id}`)?.source_summary, 'You');
  assert.equal(fileRepo.get(file.id)?.deleted_at, null);
});

test('resource asset list filters unified resources by room boundary', async () => {
  const project = createProject('room-filter');
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
      content: 'target ref',
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
      content: 'other ref',
      message_type: 'text',
    }).id,
    file_ids: [otherFile.id],
  });
  const targetMessage = messageRepo.create({
    room_id: room.id,
    sender_type: 'agent',
    sender_id: 'backend-executor',
    sender_name: '后端开发工程师',
    content: '# target',
    message_type: 'agent_stream',
  });
  const documentRes = await request(`/api/projects/${project.id}/resource-assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      asset_type: 'agent_document',
      title: 'target.md',
      content: targetMessage.content,
      source_message_id: targetMessage.id,
      source_room_id: room.id,
      source_agent_id: 'backend-executor',
    }),
  });
  assert.equal(documentRes.status, 201);
  const document = await documentRes.json() as { id: string };
  const otherMessage = messageRepo.create({
    room_id: otherRoom.id,
    sender_type: 'agent',
    sender_id: 'planner',
    sender_name: 'Planner',
    content: '# other',
    message_type: 'agent_stream',
  });
  const otherDocumentRes = await request(`/api/projects/${project.id}/resource-assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      asset_type: 'agent_document',
      title: 'other.md',
      content: otherMessage.content,
      source_message_id: otherMessage.id,
      source_room_id: otherRoom.id,
      source_agent_id: 'planner',
    }),
  });
  assert.equal(otherDocumentRes.status, 201);

  const listRes = await request(`/api/projects/${project.id}/resource-assets?roomId=${room.id}`);
  assert.equal(listRes.status, 200);
  const assets = await listRes.json() as Array<{ id: string }>;

  assert.deepEqual(new Set(assets.map((asset) => asset.id)), new Set([document.id, `file:${targetFile.id}`]));
  assert.equal(assets.some((asset) => asset.id === `file:${otherFile.id}`), false);
});

test('resource asset list rejects room filters outside the project boundary', async () => {
  const project = createProject('room-filter-boundary');
  const otherProject = createProject('room-filter-boundary-other');
  const otherRoom = roomRepo.create({ project_id: otherProject.id, name: 'Other Room' });

  const missingRes = await request(`/api/projects/${project.id}/resource-assets?roomId=missing-room`);
  assert.equal(missingRes.status, 404);

  const crossProjectRes = await request(`/api/projects/${project.id}/resource-assets?roomId=${otherRoom.id}`);
  assert.equal(crossProjectRes.status, 400);
});

test('resource asset routes search mixed resource types and reject empty search', async () => {
  const project = createProject('search-assets');
  const room = roomRepo.create({ project_id: project.id, name: 'Search Room' });
  fileRepo.create({
    project_id: project.id,
    original_name: 'smoke-upload.txt',
    stored_name: 'smoke-upload.txt',
    mime_type: 'text/plain',
    size: 128,
    url: `/uploads/files/${project.id}/smoke-upload.txt`,
    storage_path: join(tmpdir(), 'smoke-upload.txt'),
    uploaded_by_id: null,
    uploaded_by_name: null,
  });
  const message = messageRepo.create({
    room_id: room.id,
    sender_type: 'agent',
    sender_id: 'backend-executor',
    sender_name: '后端开发工程师',
    content: '# 图片冒烟验证\n\nMarkdown 详情正文。',
    message_type: 'agent_stream',
  });

  const createRes = await request(`/api/projects/${project.id}/resource-assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      asset_type: 'agent_document',
      title: '图片冒烟验证',
      content: message.content,
      mime_type: 'text/markdown',
      source_message_id: message.id,
      source_room_id: room.id,
      source_agent_id: 'backend-executor',
    }),
  });
  assert.equal(createRes.status, 201);
  const created = await createRes.json() as { id: string };

  const documentRes = await request(`/api/projects/${project.id}/resource-assets?q=${encodeURIComponent('图片冒烟')}`);
  assert.equal(documentRes.status, 200);
  const documents = await documentRes.json() as Array<{ id: string; asset_type: string }>;
  assert.deepEqual(documents.map((asset) => asset.id), [created.id]);

  const uploadRes = await request(`/api/projects/${project.id}/resource-assets?q=smoke-upload`);
  assert.equal(uploadRes.status, 200);
  const uploads = await uploadRes.json() as Array<{ asset_type: string; source_display_name: string | null }>;
  assert.deepEqual(uploads.map((asset) => asset.asset_type), ['uploaded_file']);
  assert.equal(uploads[0]?.source_display_name, '用户上传');

  const sourceRes = await request(`/api/projects/${project.id}/resource-assets?q=${encodeURIComponent(room.name)}`);
  assert.equal(sourceRes.status, 200);
  const sourceMatches = await sourceRes.json() as Array<{ id: string; resource_type: string }>;
  assert.deepEqual(
    sourceMatches.map((asset) => ({ id: asset.id, resource_type: asset.resource_type })),
    [{ id: created.id, resource_type: 'agent_document' }],
  );

  const invalidSearchRes = await request(`/api/projects/${project.id}/resource-assets?q=${encodeURIComponent('   ')}`);
  assert.equal(invalidSearchRes.status, 400);
});

test('resource asset routes return unified list and typed detail contracts', async () => {
  const project = createProject('unified-contract');
  const otherProject = createProject('unified-contract-other');
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
  const createRes = await request(`/api/projects/${project.id}/resource-assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      asset_type: 'agent_document',
      title: '统一资源详情.md',
      content: message.content,
      mime_type: 'text/markdown',
      source_message_id: message.id,
      source_room_id: room.id,
      source_agent_id: 'backend-executor',
    }),
  });
  assert.equal(createRes.status, 201);
  const document = await createRes.json() as { id: string };

  const listRes = await request(`/api/projects/${project.id}/resource-assets`);
  assert.equal(listRes.status, 200);
  const listed = await listRes.json() as Array<{
    id: string;
    name: string;
    resource_type: string;
    created_by: { id: string | null; name: string | null; type: string };
    source: { type: string; display_name: string | null; context: { id: string; type: string; name: string | null } | null };
    source_summary: string;
    capabilities: { preview: boolean; download: boolean; markdown: boolean; delete: boolean };
    available_actions: string[];
    content?: string;
  }>;
  const uploadItem = listed.find((item) => item.id === `file:${upload.id}`);
  const documentItem = listed.find((item) => item.id === document.id);

  assert.equal(uploadItem?.name, 'screen.png');
  assert.equal(uploadItem?.resource_type, 'uploaded_file');
  assert.deepEqual(uploadItem?.capabilities, { preview: true, download: true, markdown: false, delete: false });
  assert.deepEqual(uploadItem?.available_actions, ['preview', 'download']);
  assert.deepEqual(uploadItem?.created_by, { id: 'user', name: 'You', type: 'user' });
  assert.equal(uploadItem?.source_summary, 'You');
  assert.equal(uploadItem?.source.type, 'user_upload');
  assert.equal(uploadItem?.source.display_name, 'You');
  assert.equal(Object.hasOwn(uploadItem ?? {}, 'content'), false);

  assert.equal(documentItem?.name, '统一资源详情.md');
  assert.equal(documentItem?.resource_type, 'agent_document');
  assert.deepEqual(documentItem?.capabilities, { preview: true, download: false, markdown: true, delete: true });
  assert.deepEqual(documentItem?.available_actions, ['preview', 'view_markdown', 'delete']);
  assert.deepEqual(documentItem?.created_by, { id: 'backend-executor', name: '后端开发工程师', type: 'agent' });
  assert.equal(documentItem?.source_summary, '智能体生成 · 后端开发工程师 · Unified Room');
  assert.equal(documentItem?.source.type, 'agent');
  assert.equal(documentItem?.source.display_name, '后端开发工程师');
  assert.equal(documentItem?.source.context?.id, room.id);
  assert.equal(documentItem?.source.context?.name, room.name);

  const resourceTypeRes = await request(`/api/projects/${project.id}/resource-assets?resourceType=agent_document`);
  assert.equal(resourceTypeRes.status, 200);
  const resourceTypeAssets = await resourceTypeRes.json() as Array<{ resource_type: string }>;
  assert.deepEqual(resourceTypeAssets.map((asset) => asset.resource_type), ['agent_document']);

  const typeRes = await request(`/api/projects/${project.id}/resource-assets?type=uploaded_file`);
  assert.equal(typeRes.status, 200);
  const typeAssets = await typeRes.json() as Array<{ resource_type: string }>;
  assert.deepEqual(typeAssets.map((asset) => asset.resource_type), ['uploaded_file']);

  const conflictRes = await request(`/api/projects/${project.id}/resource-assets?assetType=uploaded_file&resourceType=agent_document`);
  assert.equal(conflictRes.status, 400);

  const uploadDetailRes = await request(`/api/resource-assets/file:${upload.id}?projectId=${project.id}`);
  assert.equal(uploadDetailRes.status, 200);
  const uploadDetail = await uploadDetailRes.json() as {
    resource_type: string;
    created_by: { id: string | null; name: string | null; type: string };
    available_actions: string[];
    source_summary: string;
    preview_url: string | null;
    download_url: string | null;
    content: string | null;
  };
  assert.equal(uploadDetail.resource_type, 'uploaded_file');
  assert.equal(uploadDetail.source_summary, 'You');
  assert.deepEqual(uploadDetail.created_by, { id: 'user', name: 'You', type: 'user' });
  assert.deepEqual(uploadDetail.available_actions, ['preview', 'download']);
  assert.equal(uploadDetail.preview_url, upload.url);
  assert.equal(uploadDetail.download_url, upload.url);
  assert.equal(uploadDetail.content, null);

  const documentDetailRes = await request(`/api/resource-assets/${document.id}?projectId=${project.id}`);
  assert.equal(documentDetailRes.status, 200);
  const documentDetail = await documentDetailRes.json() as {
    resource_type: string;
    created_by: { id: string | null; name: string | null; type: string };
    available_actions: string[];
    source_summary: string;
    content: string | null;
    preview_url: string | null;
    source: { message_id: string | null };
  };
  assert.equal(documentDetail.resource_type, 'agent_document');
  assert.equal(documentDetail.source_summary, '智能体生成 · 后端开发工程师 · Unified Room');
  assert.deepEqual(documentDetail.created_by, { id: 'backend-executor', name: '后端开发工程师', type: 'agent' });
  assert.deepEqual(documentDetail.available_actions, ['preview', 'view_markdown', 'delete']);
  assert.equal(documentDetail.content, message.content);
  assert.equal(documentDetail.preview_url, null);
  assert.equal(documentDetail.source.message_id, message.id);

  const missingRes = await request('/api/resource-assets/missing');
  assert.equal(missingRes.status, 404);

  const forbiddenRes = await request(`/api/resource-assets/${document.id}?projectId=${otherProject.id}`);
  assert.equal(forbiddenRes.status, 403);
});

test('resource asset detail route accepts project file list ids and hides deleted agent documents', async () => {
  const project = createProject('list-id-detail');
  const room = roomRepo.create({ project_id: project.id, name: 'List Id Room' });
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
    content: '# 列表 ID 详情\n\nMarkdown 内容。',
    message_type: 'agent_stream',
  });
  const documentFile = fileRepo.createAgentDocument({
    project_id: project.id,
    title: '列表 ID 详情.md',
    content: message.content,
    source_message_id: message.id,
    source_room_id: room.id,
    source_agent_id: 'backend-executor',
    source_task_id: null,
  });

  const uploadDetailRes = await request(`/api/resource-assets/${upload.id}?projectId=${project.id}`);
  assert.equal(uploadDetailRes.status, 200);
  const uploadDetail = await uploadDetailRes.json() as { id: string; resource_type: string; preview_url: string | null };
  assert.equal(uploadDetail.id, `file:${upload.id}`);
  assert.equal(uploadDetail.resource_type, 'uploaded_file');
  assert.equal(uploadDetail.preview_url, upload.url);

  const documentDetailRes = await request(`/api/resource-assets/${documentFile.id}?projectId=${project.id}`);
  assert.equal(documentDetailRes.status, 200);
  const documentDetail = await documentDetailRes.json() as { id: string; resource_type: string; content: string | null };
  assert.equal(documentDetail.id, documentFile.id.slice('asset:'.length));
  assert.equal(documentDetail.resource_type, 'agent_document');
  assert.equal(documentDetail.content, message.content);

  const deleteRes = await request(`/api/resource-assets/${documentFile.id}`, { method: 'DELETE' });
  assert.equal(deleteRes.status, 204);

  const afterDeleteDetailRes = await request(`/api/resource-assets/${documentFile.id}?projectId=${project.id}`);
  assert.equal(afterDeleteDetailRes.status, 404);
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

test('resource asset routes return complete resource payload when repeated agent document registration is deduped', async () => {
  const project = createProject('dedupe-response');
  const room = roomRepo.create({ project_id: project.id, name: 'Dedupe Response Room' });
  const message = messageRepo.create({
    room_id: room.id,
    sender_type: 'agent',
    sender_id: 'backend-executor',
    sender_name: '后端开发工程师',
    content: '# 重复注册\n\n保持完整来源字段。',
    message_type: 'agent_stream',
  });

  const firstRes = await request(`/api/projects/${project.id}/resource-assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      asset_type: 'agent_document',
      title: '重复注册',
      content: message.content,
      mime_type: 'text/markdown',
      source_message_id: message.id,
      source_room_id: room.id,
      source_agent_id: 'backend-executor',
    }),
  });
  assert.equal(firstRes.status, 201);
  const first = await firstRes.json() as {
    id: string;
    created_by: { id: string | null; name: string | null; type: string };
    source: { display_name: string | null; message_id: string | null };
  };
  assert.deepEqual(first.created_by, { id: 'backend-executor', name: '后端开发工程师', type: 'agent' });
  assert.equal(first.source.display_name, '后端开发工程师');
  assert.equal(first.source.message_id, message.id);

  const secondRes = await request(`/api/projects/${project.id}/resource-assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      asset_type: 'agent_document',
      title: '重复注册',
      content: `${message.content}\n\n- 重放`,
      mime_type: 'text/markdown',
      source_message_id: message.id,
      source_room_id: room.id,
      source_agent_id: 'backend-executor',
    }),
  });
  assert.equal(secondRes.status, 201);
  const second = await secondRes.json() as {
    id: string;
    created_by: { id: string | null; name: string | null; type: string };
    source: { display_name: string | null; message_id: string | null };
  };
  assert.equal(second.id, first.id);
  assert.deepEqual(second.created_by, { id: 'backend-executor', name: '后端开发工程师', type: 'agent' });
  assert.equal(second.source.display_name, '后端开发工程师');
  assert.equal(second.source.message_id, message.id);
});

test('resource asset routes normalize blank source message ids without deduping agent documents', async () => {
  const project = createProject('blank-source-route');
  const room = roomRepo.create({ project_id: project.id, name: 'Blank Source Route Room' });

  const firstRes = await request(`/api/projects/${project.id}/resource-assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      asset_type: 'agent_document',
      title: '空白来源 A',
      content: '# 空白来源 A',
      mime_type: 'text/markdown',
      source_message_id: '   ',
      source_room_id: room.id,
      source_agent_id: 'backend-executor',
    }),
  });
  assert.equal(firstRes.status, 201);
  const first = await firstRes.json() as { id: string; source_message_id: string | null; source: { message_id: string | null } };
  assert.equal(first.source_message_id, null);
  assert.equal(first.source.message_id, null);

  const secondRes = await request(`/api/projects/${project.id}/resource-assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      asset_type: 'agent_document',
      title: '空白来源 B',
      content: '# 空白来源 B',
      mime_type: 'text/markdown',
      source_message_id: '',
      source_room_id: room.id,
      source_agent_id: 'backend-executor',
    }),
  });
  assert.equal(secondRes.status, 201);
  const second = await secondRes.json() as { id: string; source_message_id: string | null; source: { message_id: string | null } };
  assert.notEqual(second.id, first.id);
  assert.equal(second.source_message_id, null);
  assert.equal(second.source.message_id, null);
});
