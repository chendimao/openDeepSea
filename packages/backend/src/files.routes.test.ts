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
  const message = await messageRes.json() as { metadata: string };
  const metadata = JSON.parse(message.metadata) as { attachments: Array<{ fileId: string; name: string }> };
  const attachment = metadata.attachments[0];
  assert.ok(attachment);
  assert.equal(attachment.fileId, file.id);
  assert.equal(attachment.name, 'brief.pdf');

  const files = fileRepo.listByProject(project.id);
  const listedFile = files[0];
  assert.ok(listedFile);
  assert.equal(listedFile.reference_count, 1);
  assert.equal(listedFile.last_referenced_room_id, room.id);
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
