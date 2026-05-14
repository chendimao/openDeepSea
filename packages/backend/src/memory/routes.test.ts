import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-memory-routes-')), 'test.db');

const projectDir = join(tmpdir(), `openclaw-room-memory-routes-project-${Date.now()}`);
mkdirSync(projectDir, { recursive: true });

const { projectRepo } = await import('../repos/projects.js');
const { roomAgentRepo, roomRepo } = await import('../repos/rooms.js');
const { taskRepo } = await import('../repos/tasks.js');
const { router } = await import('../routes.js');

const express = (await import('express')).default;
const app = express();
app.use(express.json());
app.use('/api', router);

function createProjectPath(name: string): string {
  const path = `${projectDir}-${name}`;
  mkdirSync(path, { recursive: true });
  return path;
}

async function request(path: string, init: RequestInit = {}) {
  const server = app.listen(0);
  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    return await fetch(`http://127.0.0.1:${address.port}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function listMemories(projectId: string, query = ''): Promise<Array<{ id: string }>> {
  const res = await request(`/api/projects/${projectId}/memories${query}`);
  assert.equal(res.status, 200);
  return await res.json() as Array<{ id: string }>;
}

test('memory routes create, list, update, and delete project memory', async () => {
  const project = projectRepo.create({ name: 'API Memory', path: projectDir });
  const room = roomRepo.create({ project_id: project.id, name: 'API Room' });
  const task = taskRepo.create({ project_id: project.id, room_id: room.id, title: 'API task' });

  const createRes = await request(`/api/projects/${project.id}/memories`, {
    method: 'POST',
    body: JSON.stringify({
      scope: 'task',
      memory_type: 'decision',
      title: 'Remember API decision',
      content: 'The API exposes project-scoped memory CRUD.',
      room_id: room.id,
      task_id: task.id,
      pinned: true,
    }),
  });
  assert.equal(createRes.status, 201);
  const created = await createRes.json() as { id: string; title: string; pinned: 0 | 1 };
  assert.equal(created.title, 'Remember API decision');
  assert.equal(created.pinned, 1);

  const listRes = await request(`/api/projects/${project.id}/memories?roomId=${room.id}&taskId=${task.id}`);
  assert.equal(listRes.status, 200);
  const listed = await listRes.json() as Array<{ id: string }>;
  assert.deepEqual(listed.map((entry) => entry.id), [created.id]);

  const patchRes = await request(`/api/projects/${project.id}/memories/${created.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      memory_type: 'lesson',
      title: 'Remember API lesson',
      content: 'The API validates related project resources.',
      pinned: false,
    }),
  });
  assert.equal(patchRes.status, 200);
  const patched = await patchRes.json() as { memory_type: string; pinned: 0 | 1 };
  assert.equal(patched.memory_type, 'lesson');
  assert.equal(patched.pinned, 0);

  const deleteRes = await request(`/api/projects/${project.id}/memories/${created.id}`, { method: 'DELETE' });
  assert.equal(deleteRes.status, 204);
});

test('memory routes reject scope relations before creating memory', async () => {
  const project = projectRepo.create({ name: 'API Memory Scope', path: createProjectPath('scope') });
  const room = roomRepo.create({ project_id: project.id, name: 'Scope Room' });
  const agent = roomAgentRepo.add({ room_id: room.id, agent_id: 'codex', agent_name: 'Codex' });
  const task = taskRepo.create({ project_id: project.id, room_id: room.id, title: 'Scope task' });

  const invalidProject = await request(`/api/projects/${project.id}/memories`, {
    method: 'POST',
    body: JSON.stringify({
      scope: 'project',
      memory_type: 'fact',
      title: 'Invalid project',
      content: 'Project memory cannot include room_id.',
      room_id: room.id,
    }),
  });
  assert.equal(invalidProject.status, 400);
  assert.deepEqual(await listMemories(project.id), []);

  const invalidRoom = await request(`/api/projects/${project.id}/memories`, {
    method: 'POST',
    body: JSON.stringify({
      scope: 'room',
      memory_type: 'fact',
      title: 'Invalid room',
      content: 'Room memory cannot include agent id.',
      room_id: room.id,
      room_agent_id: agent.id,
    }),
  });
  assert.equal(invalidRoom.status, 400);
  assert.deepEqual(await listMemories(project.id), []);

  const invalidAgent = await request(`/api/projects/${project.id}/memories`, {
    method: 'POST',
    body: JSON.stringify({
      scope: 'agent',
      memory_type: 'preference',
      title: 'Invalid agent',
      content: 'Agent memory requires room_agent_id.',
      room_id: room.id,
    }),
  });
  assert.equal(invalidAgent.status, 400);
  assert.deepEqual(await listMemories(project.id), []);

  const invalidTask = await request(`/api/projects/${project.id}/memories`, {
    method: 'POST',
    body: JSON.stringify({
      scope: 'task',
      memory_type: 'task_summary',
      title: 'Invalid task',
      content: 'Task memory cannot include agent id.',
      room_id: room.id,
      room_agent_id: agent.id,
      task_id: task.id,
    }),
  });
  assert.equal(invalidTask.status, 400);
  assert.deepEqual(await listMemories(project.id), []);
});

test('memory routes reject agent and task room mismatches', async () => {
  const project = projectRepo.create({ name: 'API Memory Ownership', path: createProjectPath('ownership') });
  const firstRoom = roomRepo.create({ project_id: project.id, name: 'First Room' });
  const secondRoom = roomRepo.create({ project_id: project.id, name: 'Second Room' });
  const agent = roomAgentRepo.add({ room_id: firstRoom.id, agent_id: 'planner', agent_name: 'Planner' });
  const task = taskRepo.create({ project_id: project.id, room_id: firstRoom.id, title: 'Ownership task' });

  const agentMismatch = await request(`/api/projects/${project.id}/memories`, {
    method: 'POST',
    body: JSON.stringify({
      scope: 'agent',
      memory_type: 'preference',
      title: 'Agent mismatch',
      content: 'Agent room must match room_id when provided.',
      room_id: secondRoom.id,
      room_agent_id: agent.id,
    }),
  });
  assert.equal(agentMismatch.status, 400);
  assert.deepEqual(await listMemories(project.id), []);

  const taskMismatch = await request(`/api/projects/${project.id}/memories`, {
    method: 'POST',
    body: JSON.stringify({
      scope: 'task',
      memory_type: 'task_summary',
      title: 'Task mismatch',
      content: 'Task room must match room_id when provided.',
      room_id: secondRoom.id,
      task_id: task.id,
    }),
  });
  assert.equal(taskMismatch.status, 400);
  assert.deepEqual(await listMemories(project.id), []);
});

test('memory routes derive room ownership for agent and task scoped memories', async () => {
  const project = projectRepo.create({ name: 'API Memory Derived Room', path: createProjectPath('derived') });
  const room = roomRepo.create({ project_id: project.id, name: 'Derived Room' });
  const agent = roomAgentRepo.add({ room_id: room.id, agent_id: 'reviewer', agent_name: 'Reviewer' });
  const task = taskRepo.create({ project_id: project.id, room_id: room.id, title: 'Derived task' });

  const agentRes = await request(`/api/projects/${project.id}/memories`, {
    method: 'POST',
    body: JSON.stringify({
      scope: 'agent',
      memory_type: 'preference',
      title: 'Agent derived room',
      content: 'Agent scope can derive room_id from room_agent_id.',
      room_agent_id: agent.id,
    }),
  });
  assert.equal(agentRes.status, 201);
  const agentMemory = await agentRes.json() as { room_id: string };
  assert.equal(agentMemory.room_id, room.id);

  const taskRes = await request(`/api/projects/${project.id}/memories`, {
    method: 'POST',
    body: JSON.stringify({
      scope: 'task',
      memory_type: 'task_summary',
      title: 'Task derived room',
      content: 'Task scope can derive room_id from task_id.',
      task_id: task.id,
    }),
  });
  assert.equal(taskRes.status, 201);
  const taskMemory = await taskRes.json() as { room_id: string };
  assert.equal(taskMemory.room_id, room.id);
});

test('memory routes return stable errors for invalid filters and source conflicts', async () => {
  const firstProject = projectRepo.create({ name: 'API Memory Stable Error', path: createProjectPath('stable-error') });
  const secondProject = projectRepo.create({
    name: 'API Memory Other Stable Error',
    path: createProjectPath('stable-error-other'),
  });
  const firstRoom = roomRepo.create({ project_id: firstProject.id, name: 'Stable Error Room' });
  const secondRoom = roomRepo.create({ project_id: secondProject.id, name: 'Other Stable Error Room' });
  const task = taskRepo.create({ project_id: firstProject.id, room_id: firstRoom.id, title: 'Stable error task' });

  const invalidFilter = await request(`/api/projects/${firstProject.id}/memories?roomId=${secondRoom.id}`);
  assert.equal(invalidFilter.status, 400);
  assert.deepEqual(await invalidFilter.json(), { error: 'invalid memory filters' });

  const firstCreate = await request(`/api/projects/${firstProject.id}/memories`, {
    method: 'POST',
    body: JSON.stringify({
      scope: 'task',
      memory_type: 'task_summary',
      title: 'Stable conflict',
      content: 'First memory with source id.',
      task_id: task.id,
      source_type: 'workflow',
      source_id: 'workflow-duplicate',
    }),
  });
  assert.equal(firstCreate.status, 201);

  const conflict = await request(`/api/projects/${firstProject.id}/memories`, {
    method: 'POST',
    body: JSON.stringify({
      scope: 'task',
      memory_type: 'task_summary',
      title: 'Stable conflict again',
      content: 'Second memory with duplicate source id.',
      task_id: task.id,
      source_type: 'workflow',
      source_id: 'workflow-duplicate',
    }),
  });
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: 'memory source already exists' });
  assert.equal((await listMemories(firstProject.id, `?taskId=${task.id}`)).length, 1);
});

test('memory routes reject duplicate room message memories by source', async () => {
  const project = projectRepo.create({
    name: 'API Memory Room Message Conflict',
    path: createProjectPath('room-message-conflict'),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room Message Conflict Room' });

  const firstCreate = await request(`/api/projects/${project.id}/memories`, {
    method: 'POST',
    body: JSON.stringify({
      scope: 'room',
      memory_type: 'lesson',
      title: 'Message memory',
      content: 'Remember this room message once.',
      room_id: room.id,
      source_type: 'message',
      source_id: 'message-duplicate',
    }),
  });
  assert.equal(firstCreate.status, 201);

  const conflict = await request(`/api/projects/${project.id}/memories`, {
    method: 'POST',
    body: JSON.stringify({
      scope: 'room',
      memory_type: 'lesson',
      title: 'Message memory again',
      content: 'The same message should not create another memory.',
      room_id: room.id,
      source_type: 'message',
      source_id: 'message-duplicate',
    }),
  });
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: 'memory source already exists' });
  assert.equal((await listMemories(project.id, `?roomId=${room.id}`)).length, 1);
});

test('memory routes prevent cross-project scoped patch and delete', async () => {
  const firstProject = projectRepo.create({
    name: 'API Memory Scoped Mutation',
    path: createProjectPath('scoped-mutation'),
  });
  const secondProject = projectRepo.create({
    name: 'API Memory Other Scoped Mutation',
    path: createProjectPath('scoped-mutation-other'),
  });

  const createRes = await request(`/api/projects/${firstProject.id}/memories`, {
    method: 'POST',
    body: JSON.stringify({
      scope: 'project',
      memory_type: 'fact',
      title: 'Scoped memory',
      content: 'Only the owning project can update or delete this memory.',
    }),
  });
  assert.equal(createRes.status, 201);
  const created = await createRes.json() as { id: string };

  const crossPatch = await request(`/api/projects/${secondProject.id}/memories/${created.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      title: 'Cross project update',
    }),
  });
  assert.equal(crossPatch.status, 404);
  assert.deepEqual(await crossPatch.json(), { error: 'not found' });

  const ownerListAfterPatch = await listMemories(firstProject.id);
  assert.equal(ownerListAfterPatch[0]?.id, created.id);

  const crossDelete = await request(`/api/projects/${secondProject.id}/memories/${created.id}`, {
    method: 'DELETE',
  });
  assert.equal(crossDelete.status, 404);

  assert.equal((await listMemories(firstProject.id)).length, 1);

  const ownerPatch = await request(`/api/projects/${firstProject.id}/memories/${created.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      title: 'Owner update',
    }),
  });
  assert.equal(ownerPatch.status, 200);
  const patched = await ownerPatch.json() as { title: string };
  assert.equal(patched.title, 'Owner update');

  const ownerDelete = await request(`/api/projects/${firstProject.id}/memories/${created.id}`, {
    method: 'DELETE',
  });
  assert.equal(ownerDelete.status, 204);
  assert.deepEqual(await listMemories(firstProject.id), []);
});
