import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-file-routes-')), 'test.db');

const { projectRepo } = await import('./repos/projects.js');
const { roomRepo } = await import('./repos/rooms.js');
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
  const projectPath = mkdtempSync(join(tmpdir(), `openclaw-room-file-routes-${name}-`));
  return projectRepo.create({ name, path: projectPath });
}

test('project file routes upload, list, and delete files', async () => {
  const project = createProject('project');
  const form = new FormData();
  form.append('files', new Blob(['hello'], { type: 'text/plain' }), 'notes.txt');
  form.append('uploaded_by_id', 'user');
  form.append('uploaded_by_name', 'You');

  const uploadRes = await request(`/api/projects/${project.id}/files`, {
    method: 'POST',
    body: form,
  });
  assert.equal(uploadRes.status, 201);
  const uploaded = await uploadRes.json() as Array<{ id: string; original_name: string; url: string; storage_path: string }>;
  assert.equal(uploaded.length, 1);
  const uploadedFile = uploaded[0];
  assert.ok(uploadedFile);
  assert.equal(uploadedFile.original_name, 'notes.txt');
  assert.match(uploadedFile.url, new RegExp(`^/uploads/files/${project.id}/`));
  await access(uploadedFile.storage_path, constants.F_OK);

  const listRes = await request(`/api/projects/${project.id}/files`);
  assert.equal(listRes.status, 200);
  const listed = await listRes.json() as Array<{ id: string; reference_count: number }>;
  assert.deepEqual(listed.map((file) => file.id), [uploadedFile.id]);
  const listedFile = listed[0];
  assert.ok(listedFile);
  assert.equal(listedFile.reference_count, 0);

  const deleteRes = await request(`/api/files/${uploadedFile.id}`, { method: 'DELETE' });
  assert.equal(deleteRes.status, 204);
  await assert.rejects(access(uploadedFile.storage_path, constants.F_OK));

  const afterDeleteRes = await request(`/api/projects/${project.id}/files`);
  assert.equal(afterDeleteRes.status, 200);
  assert.deepEqual(await afterDeleteRes.json(), []);
});

test('global file route lists all active files and filters by project or room', async () => {
  const project = createProject('global-project');
  const otherProject = createProject('global-other-project');
  const room = roomRepo.create({ project_id: project.id, name: 'Filter Room' });
  const secondRoom = roomRepo.create({ project_id: project.id, name: 'Second Filter Room' });
  const projectFile = fileRepo.create({
    project_id: project.id,
    original_name: 'project.txt',
    stored_name: 'project.txt',
    mime_type: 'text/plain',
    size: 128,
    url: `/uploads/files/${project.id}/project.txt`,
    storage_path: join(tmpdir(), 'project.txt'),
    uploaded_by_id: 'user',
    uploaded_by_name: 'You',
  });
  const roomFile = fileRepo.create({
    project_id: project.id,
    original_name: 'room.txt',
    stored_name: 'room.txt',
    mime_type: 'text/plain',
    size: 256,
    url: `/uploads/files/${project.id}/room.txt`,
    storage_path: join(tmpdir(), 'room.txt'),
    uploaded_by_id: 'user',
    uploaded_by_name: 'You',
  });
  const otherFile = fileRepo.create({
    project_id: otherProject.id,
    original_name: 'other.txt',
    stored_name: 'other.txt',
    mime_type: 'text/plain',
    size: 512,
    url: `/uploads/files/${otherProject.id}/other.txt`,
    storage_path: join(tmpdir(), 'other.txt'),
    uploaded_by_id: 'user',
    uploaded_by_name: 'You',
  });
  const message = messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: 'see file',
  });
  fileRepo.addMessageRefs({
    project_id: project.id,
    room_id: room.id,
    message_id: message.id,
    file_ids: [roomFile.id],
  });
  const secondRoomMessage = messageRepo.create({
    room_id: secondRoom.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: 'see same file elsewhere',
  });
  fileRepo.addMessageRefs({
    project_id: project.id,
    room_id: secondRoom.id,
    message_id: secondRoomMessage.id,
    file_ids: [roomFile.id],
  });

  const allRes = await request('/api/files');
  assert.equal(allRes.status, 200);
  const all = await allRes.json() as Array<{ id: string }>;
  assert.ok(all.some((file) => file.id === projectFile.id));
  assert.ok(all.some((file) => file.id === roomFile.id));
  assert.ok(all.some((file) => file.id === otherFile.id));

  const projectRes = await request(`/api/files?projectId=${project.id}`);
  assert.equal(projectRes.status, 200);
  const projectFiles = await projectRes.json() as Array<{ id: string }>;
  assert.deepEqual(new Set(projectFiles.map((file) => file.id)), new Set([projectFile.id, roomFile.id]));

  const roomRes = await request(`/api/files?projectId=${project.id}&roomId=${room.id}`);
  assert.equal(roomRes.status, 200);
  const roomFiles = await roomRes.json() as Array<{
    id: string;
    last_referenced_message_id: string | null;
    last_referenced_room_id: string | null;
  }>;
  assert.deepEqual(roomFiles.map((file) => file.id), [roomFile.id]);
  assert.equal(roomFiles[0]?.last_referenced_message_id, message.id);
  assert.equal(roomFiles[0]?.last_referenced_room_id, room.id);

  const invalidRes = await request(`/api/files?projectId=${otherProject.id}&roomId=${room.id}`);
  assert.equal(invalidRes.status, 400);
});

test('file routes return and filter user upload and agent document source types', async () => {
  const project = createProject('source-type-project');
  const room = roomRepo.create({ project_id: project.id, name: 'Source Room' });
  const message = messageRepo.create({
    room_id: room.id,
    sender_type: 'agent',
    sender_id: 'backend-executor',
    sender_name: '后端开发工程师',
    content: '# 冒烟验证\n\n结论。',
    message_type: 'agent_stream',
  });
  const upload = fileRepo.create({
    project_id: project.id,
    original_name: 'upload.txt',
    stored_name: 'upload.txt',
    mime_type: 'text/plain',
    size: 128,
    url: `/uploads/files/${project.id}/upload.txt`,
    storage_path: join(tmpdir(), 'upload.txt'),
    uploaded_by_id: 'user',
    uploaded_by_name: 'You',
  });
  const agentDocument = fileRepo.createAgentDocument({
    project_id: project.id,
    title: '冒烟验证.md',
    content: message.content,
    source_message_id: message.id,
    source_room_id: room.id,
    source_agent_id: 'backend-executor',
    source_task_id: null,
  });

  const projectRes = await request(`/api/projects/${project.id}/files`);
  assert.equal(projectRes.status, 200);
  const projectFiles = await projectRes.json() as Array<{ id: string; source_type: string }>;
  assert.equal(projectFiles.find((file) => file.id === upload.id)?.source_type, 'uploaded_file');
  assert.equal(projectFiles.find((file) => file.id === agentDocument.id)?.source_type, 'agent_document');

  const agentRes = await request(`/api/files?projectId=${project.id}&sourceType=agent_document`);
  assert.equal(agentRes.status, 200);
  const agentFiles = await agentRes.json() as Array<{
    id: string;
    source_type: string;
    source_message_id: string | null;
    source_room_id: string | null;
    source_agent_id: string | null;
  }>;
  assert.deepEqual(agentFiles.map((file) => file.id), [agentDocument.id]);
  assert.equal(agentFiles[0]?.source_type, 'agent_document');
  assert.equal(agentFiles[0]?.source_message_id, message.id);
  assert.equal(agentFiles[0]?.source_room_id, room.id);
  assert.equal(agentFiles[0]?.source_agent_id, 'backend-executor');

  const uploadedRes = await request(`/api/files?projectId=${project.id}&sourceType=uploaded_file`);
  assert.equal(uploadedRes.status, 200);
  const uploadedFiles = await uploadedRes.json() as Array<{ id: string; source_type: string }>;
  assert.deepEqual(uploadedFiles.map((file) => file.id), [upload.id]);

  const roomAgentRes = await request(
    `/api/projects/${project.id}/files?roomId=${room.id}&sourceType=agent_document`,
  );
  assert.equal(roomAgentRes.status, 200);
  const roomAgentFiles = await roomAgentRes.json() as Array<{ id: string; source_type: string }>;
  assert.deepEqual(roomAgentFiles.map((file) => file.id), [agentDocument.id]);

  const otherProject = createProject('source-type-other-project');
  const invalidRoomRes = await request(`/api/projects/${otherProject.id}/files?roomId=${room.id}`);
  assert.equal(invalidRoomRes.status, 400);

  const invalidSourceRes = await request(`/api/files?sourceType=message`);
  assert.equal(invalidSourceRes.status, 400);
});

test('message route accepts project file ids and records message refs', async () => {
  const project = createProject('message-project');
  const room = roomRepo.create({ project_id: project.id, name: 'File Room' });
  const file = fileRepo.create({
    project_id: project.id,
    original_name: 'brief.pdf',
    stored_name: 'stored.pdf',
    mime_type: 'application/pdf',
    size: 2048,
    url: `/uploads/files/${project.id}/stored.pdf`,
    storage_path: join(tmpdir(), 'stored.pdf'),
    uploaded_by_id: 'user',
    uploaded_by_name: 'You',
  });

  const messageRes = await request(`/api/rooms/${room.id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'read this', fileIds: [file.id] }),
  });
  assert.equal(messageRes.status, 201);
  const message = await messageRes.json() as { id: string; metadata: string };
  const metadata = JSON.parse(message.metadata) as { attachments: Array<{ fileId: string; name: string }> };
  const attachment = metadata.attachments[0];
  assert.ok(attachment);
  assert.equal(attachment.fileId, file.id);
  assert.equal(attachment.name, 'brief.pdf');

  const files = fileRepo.listByProject(project.id);
  const listedFile = files[0];
  assert.ok(listedFile);
  assert.equal(listedFile.reference_count, 1);
  assert.equal(listedFile.last_referenced_message_id, message.id);
  assert.equal(listedFile.last_referenced_room_id, room.id);
});

test('multipart message accepts image-only upload and records image metadata', async () => {
  const project = createProject('multipart-image-message');
  const room = roomRepo.create({ project_id: project.id, name: 'Image Room' });
  const form = new FormData();
  form.append('files', new Blob(['fake-png'], { type: 'image/png' }), 'screen.png');

  const messageRes = await request(`/api/rooms/${room.id}/messages`, {
    method: 'POST',
    body: form,
  });

  assert.equal(messageRes.status, 201);
  const message = await messageRes.json() as { id: string; content: string; metadata: string };
  assert.equal(message.content, '');

  const metadata = JSON.parse(message.metadata) as {
    attachments: Array<{ fileId: string; name: string; mimeType: string; isImage: boolean; url: string }>;
  };
  const attachment = metadata.attachments[0];
  assert.ok(attachment);
  assert.equal(attachment.name, 'screen.png');
  assert.equal(attachment.mimeType, 'image/png');
  assert.equal(attachment.isImage, true);
  assert.match(attachment.url, new RegExp(`^/uploads/files/${project.id}/`));

  const files = fileRepo.list({ projectId: project.id, roomId: room.id });
  assert.equal(files.length, 1);
  assert.equal(files[0]?.id, attachment.fileId);
  assert.equal(files[0]?.reference_count, 1);
});

test('multipart message accepts common mobile image MIME types', async () => {
  const project = createProject('multipart-mobile-image-message');
  const room = roomRepo.create({ project_id: project.id, name: 'Mobile Image Room' });
  const form = new FormData();
  form.append('files', new Blob(['fake-heic'], { type: 'image/heic' }), 'photo.heic');

  const messageRes = await request(`/api/rooms/${room.id}/messages`, {
    method: 'POST',
    body: form,
  });

  assert.equal(messageRes.status, 201);
  const message = await messageRes.json() as { metadata: string };
  const metadata = JSON.parse(message.metadata) as {
    attachments: Array<{ name: string; mimeType: string; isImage: boolean }>;
  };
  assert.equal(metadata.attachments[0]?.name, 'photo.heic');
  assert.equal(metadata.attachments[0]?.mimeType, 'image/heic');
  assert.equal(metadata.attachments[0]?.isImage, true);
});

test('delete project file marks historical message attachment snapshots deleted', async () => {
  const project = createProject('deleted-snapshot-project');
  const room = roomRepo.create({ project_id: project.id, name: 'File Room' });
  const file = fileRepo.create({
    project_id: project.id,
    original_name: 'notes.txt',
    stored_name: 'stored.txt',
    mime_type: 'text/plain',
    size: 128,
    url: `/uploads/files/${project.id}/stored.txt`,
    storage_path: join(tmpdir(), 'stored.txt'),
    uploaded_by_id: 'user',
    uploaded_by_name: 'You',
  });

  const messageRes = await request(`/api/rooms/${room.id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'keep snapshot', fileIds: [file.id] }),
  });
  assert.equal(messageRes.status, 201);
  const message = await messageRes.json() as { id: string };

  const deleteRes = await request(`/api/files/${file.id}`, { method: 'DELETE' });
  assert.equal(deleteRes.status, 204);

  const updatedMessage = messageRepo.get(message.id);
  assert.ok(updatedMessage?.metadata);
  const metadata = JSON.parse(updatedMessage.metadata) as { attachments: Array<{ fileId: string; deleted?: boolean }> };
  assert.equal(metadata.attachments[0]?.fileId, file.id);
  assert.equal(metadata.attachments[0]?.deleted, true);
});

test('message route rejects project file ids from another project', async () => {
  const project = createProject('valid-project');
  const otherProject = createProject('other-project');
  const room = roomRepo.create({ project_id: project.id, name: 'File Room' });
  const file = fileRepo.create({
    project_id: otherProject.id,
    original_name: 'foreign.pdf',
    stored_name: 'foreign.pdf',
    mime_type: 'application/pdf',
    size: 2048,
    url: `/uploads/files/${otherProject.id}/foreign.pdf`,
    storage_path: join(tmpdir(), 'foreign.pdf'),
    uploaded_by_id: 'user',
    uploaded_by_name: 'You',
  });

  const messageRes = await request(`/api/rooms/${room.id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'read this', fileIds: [file.id] }),
  });

  assert.equal(messageRes.status, 400);
});

test('multipart message rejects invalid project file ids without leaving uploaded file records', async () => {
  const project = createProject('multipart-invalid-fileids');
  const otherProject = createProject('multipart-invalid-fileids-other');
  const room = roomRepo.create({ project_id: project.id, name: 'File Room' });
  const otherFile = fileRepo.create({
    project_id: otherProject.id,
    original_name: 'foreign.pdf',
    stored_name: 'foreign.pdf',
    mime_type: 'application/pdf',
    size: 2048,
    url: `/uploads/files/${otherProject.id}/foreign.pdf`,
    storage_path: join(tmpdir(), 'foreign.pdf'),
    uploaded_by_id: 'user',
    uploaded_by_name: 'You',
  });
  const before = fileRepo.listByProject(project.id).length;
  const form = new FormData();
  form.append('content', 'upload plus invalid ref');
  form.append('fileIds', JSON.stringify([otherFile.id]));
  form.append('files', new Blob(['local'], { type: 'text/plain' }), 'local.txt');

  const messageRes = await request(`/api/rooms/${room.id}/messages`, {
    method: 'POST',
    body: form,
  });

  assert.equal(messageRes.status, 400);
  assert.equal(fileRepo.listByProject(project.id).length, before);
});
