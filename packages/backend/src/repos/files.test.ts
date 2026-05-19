import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-files-')), 'test.db');

const { projectRepo } = await import('./projects.js');
const { roomRepo } = await import('./rooms.js');
const { messageRepo } = await import('./messages.js');
const { fileRepo } = await import('./files.js');

function createProjectRoomMessage() {
  const projectPath = mkdtempSync(join(tmpdir(), 'openclaw-room-files-project-'));
  const project = projectRepo.create({ name: 'Files Project', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Files Room' });
  const message = messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: 'see file',
  });
  return { project, room, message };
}

test('fileRepo creates and lists active project files with reference summary', () => {
  const { project, room, message } = createProjectRoomMessage();
  const file = fileRepo.create({
    project_id: project.id,
    original_name: 'design.png',
    stored_name: 'stored.png',
    mime_type: 'image/png',
    size: 1234,
    url: `/uploads/files/${project.id}/stored.png`,
    storage_path: `/tmp/${project.id}/stored.png`,
    uploaded_by_id: 'user',
    uploaded_by_name: 'You',
  });

  fileRepo.addMessageRefs({
    project_id: project.id,
    room_id: room.id,
    message_id: message.id,
    file_ids: [file.id],
  });

  const files = fileRepo.listByProject(project.id);

  assert.equal(files.length, 1);
  const listedFile = files[0];
  assert.ok(listedFile);
  assert.equal(listedFile.id, file.id);
  assert.equal(listedFile.source_type, 'uploaded_file');
  assert.equal(listedFile.reference_count, 1);
  assert.equal(listedFile.last_referenced_room_id, room.id);
  assert.equal(listedFile.last_referenced_room_name, room.name);
  assert.equal(typeof listedFile.last_referenced_at, 'number');
});

test('fileRepo lists user uploads and agent markdown documents by source type', () => {
  const { project, room } = createProjectRoomMessage();
  const message = messageRepo.create({
    room_id: room.id,
    sender_type: 'agent',
    sender_id: 'backend-executor',
    sender_name: '后端开发工程师',
    content: '# 执行总结\n\n已完成。',
    message_type: 'agent_stream',
  });
  const uploadedFile = fileRepo.create({
    project_id: project.id,
    original_name: 'notes.txt',
    stored_name: 'stored.txt',
    mime_type: 'text/plain',
    size: 42,
    url: `/uploads/files/${project.id}/stored.txt`,
    storage_path: `/tmp/${project.id}/stored.txt`,
    uploaded_by_id: 'user',
    uploaded_by_name: 'You',
  });
  const agentDocument = fileRepo.createAgentDocument({
    project_id: project.id,
    title: '执行总结.md',
    content: '# 执行总结\n\n已完成。',
    source_message_id: message.id,
    source_room_id: room.id,
    source_agent_id: 'backend-executor',
    source_task_id: null,
  });

  const allFiles = fileRepo.list({ projectId: project.id });

  assert.deepEqual(new Set(allFiles.map((file) => file.source_type)), new Set(['uploaded_file', 'agent_document']));
  assert.equal(allFiles.find((file) => file.id === uploadedFile.id)?.source_type, 'uploaded_file');
  assert.equal(allFiles.find((file) => file.id === agentDocument.id)?.source_type, 'agent_document');

  const agentDocuments = fileRepo.list({ projectId: project.id, sourceType: 'agent_document' });
  assert.deepEqual(agentDocuments.map((file) => file.id), [agentDocument.id]);
  assert.equal(agentDocuments[0]?.source_message_id, message.id);
  assert.equal(agentDocuments[0]?.source_room_id, room.id);
  assert.equal(agentDocuments[0]?.source_agent_id, 'backend-executor');
  assert.equal(agentDocuments[0]?.source_display_name, '后端开发工程师');
  assert.equal(agentDocuments[0]?.source_label, '智能体生成');
  assert.equal(agentDocuments[0]?.source_context_id, room.id);
  assert.equal(agentDocuments[0]?.source_context_name, room.name);
  assert.equal(agentDocuments[0]?.source_context_type, 'room');
  assert.equal(agentDocuments[0]?.content, '# 执行总结\n\n已完成。');

  const uploads = fileRepo.list({ projectId: project.id, sourceType: 'uploaded_file' });
  assert.deepEqual(uploads.map((file) => file.id), [uploadedFile.id]);
  assert.equal(uploads[0]?.source_display_name, 'You');
  assert.equal(uploads[0]?.source_label, '用户上传');
});

test('fileRepo filters agent markdown documents by source room and exposes details', () => {
  const { project, room, message } = createProjectRoomMessage();
  const otherRoom = roomRepo.create({ project_id: project.id, name: 'Other Room' });
  const agentDocument = fileRepo.createAgentDocument({
    project_id: project.id,
    title: '房间总结.md',
    content: '# 房间总结',
    source_message_id: message.id,
    source_room_id: room.id,
    source_agent_id: 'backend-executor',
    source_task_id: null,
  });

  const roomDocuments = fileRepo.list({
    projectId: project.id,
    roomId: room.id,
    sourceType: 'agent_document',
  });
  const otherRoomDocuments = fileRepo.list({
    projectId: project.id,
    roomId: otherRoom.id,
    sourceType: 'agent_document',
  });
  const details = fileRepo.get(agentDocument.id);

  assert.deepEqual(roomDocuments.map((file) => file.id), [agentDocument.id]);
  assert.deepEqual(otherRoomDocuments, []);
  assert.equal(details?.source_type, 'agent_document');
  assert.equal(details?.content, '# 房间总结');
});

test('fileRepo searches uploads and agent documents across display and source fields', () => {
  const { project, room, message } = createProjectRoomMessage();
  const uploadedFile = fileRepo.create({
    project_id: project.id,
    original_name: 'handoff-notes.txt',
    stored_name: 'stored.txt',
    mime_type: 'text/plain',
    size: 42,
    url: `/uploads/files/${project.id}/stored.txt`,
    storage_path: `/tmp/${project.id}/stored.txt`,
    uploaded_by_id: null,
    uploaded_by_name: null,
  });
  const agentDocument = fileRepo.createAgentDocument({
    project_id: project.id,
    title: '冒烟验收报告.md',
    content: '# 冒烟验收报告\n\n搜索命中的 Markdown 内容。',
    source_message_id: message.id,
    source_room_id: room.id,
    source_agent_id: 'backend-executor',
    source_task_id: null,
  });

  const documentMatches = fileRepo.list({ projectId: project.id, query: '验收报告' });
  assert.deepEqual(documentMatches.map((file) => file.id), [agentDocument.id]);

  const uploadMatches = fileRepo.list({ projectId: project.id, query: 'handoff' });
  assert.deepEqual(uploadMatches.map((file) => file.id), [uploadedFile.id]);

  const sourceMatches = fileRepo.list({ projectId: project.id, query: 'backend-executor' });
  assert.deepEqual(sourceMatches.map((file) => file.id), [agentDocument.id]);

  const legacyUpload = fileRepo.get(uploadedFile.id);
  assert.equal(legacyUpload?.source_display_name, '用户上传');
  assert.equal(legacyUpload?.source_label, '用户上传');
  assert.equal(legacyUpload?.source_context_id, null);
});

test('fileRepo soft deletes project file and hides it from active list', () => {
  const { project } = createProjectRoomMessage();
  const file = fileRepo.create({
    project_id: project.id,
    original_name: 'notes.txt',
    stored_name: 'stored.txt',
    mime_type: 'text/plain',
    size: 42,
    url: `/uploads/files/${project.id}/stored.txt`,
    storage_path: `/tmp/${project.id}/stored.txt`,
    uploaded_by_id: null,
    uploaded_by_name: null,
  });

  const deleted = fileRepo.softDelete(file.id);

  assert.equal(deleted?.id, file.id);
  assert.equal(typeof deleted?.deleted_at, 'number');
  assert.equal(fileRepo.listByProject(project.id).length, 0);
});

test('fileRepo ignores duplicate refs for the same message and file', () => {
  const { project, room, message } = createProjectRoomMessage();
  const file = fileRepo.create({
    project_id: project.id,
    original_name: 'brief.pdf',
    stored_name: 'stored.pdf',
    mime_type: 'application/pdf',
    size: 2048,
    url: `/uploads/files/${project.id}/stored.pdf`,
    storage_path: `/tmp/${project.id}/stored.pdf`,
    uploaded_by_id: 'user',
    uploaded_by_name: 'You',
  });

  fileRepo.addMessageRefs({
    project_id: project.id,
    room_id: room.id,
    message_id: message.id,
    file_ids: [file.id, file.id],
  });

  const files = fileRepo.listByProject(project.id);

  assert.equal(files.length, 1);
  const listedFile = files[0];
  assert.ok(listedFile);
  assert.equal(listedFile.reference_count, 1);
});
