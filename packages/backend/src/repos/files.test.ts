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
  assert.equal(listedFile.reference_count, 1);
  assert.equal(listedFile.last_referenced_room_id, room.id);
  assert.equal(listedFile.last_referenced_room_name, room.name);
  assert.equal(typeof listedFile.last_referenced_at, 'number');
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
