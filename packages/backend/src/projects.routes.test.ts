import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-projects-routes-')), 'test.db');

const { projectRepo } = await import('./repos/projects.js');
const { roomAgentRepo, roomRepo } = await import('./repos/rooms.js');
const { taskRepo } = await import('./repos/tasks.js');
const { agentRunRepo } = await import('./repos/agent-runs.js');
const { workflowRepo } = await import('./repos/workflows.js');
const { settingsRepo } = await import('./repos/settings.js');
const { db } = await import('./db.js');
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
    return await fetch(`http://127.0.0.1:${address.port}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('delete project returns 404 for missing project', async () => {
  const res = await request('/api/projects/missing-project', { method: 'DELETE' });

  assert.equal(res.status, 404);
});

test('patch project supports pinned_at and rejects unknown fields', async () => {
  const { project } = createProjectFixture('patch-pinned');
  const pinnedAt = Date.now();
  const patchedRes = await request(`/api/projects/${project.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ pinned_at: pinnedAt }),
  });
  assert.equal(patchedRes.status, 200);
  const patched = await patchedRes.json() as { id: string; pinned_at: number | null };
  assert.equal(patched.id, project.id);
  assert.equal(patched.pinned_at, pinnedAt);

  const invalidRes = await request(`/api/projects/${project.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ unknown_field: true }),
  });
  assert.equal(invalidRes.status, 400);
});

test('reorder projects updates order and returns stats', async () => {
  const a = createProjectFixture('reorder-a').project;
  const b = createProjectFixture('reorder-b').project;
  const c = createProjectFixture('reorder-c').project;
  projectRepo.update(a.id, { pinned_at: 1 });
  projectRepo.update(b.id, { pinned_at: 2 });
  projectRepo.update(c.id, { pinned_at: null });

  const res = await request('/api/projects/reorder', {
    method: 'PUT',
    body: JSON.stringify({ ids: [b.id, a.id], pinned: true }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as Array<{ id: string; sort_order: number | null; stats: { rooms: number } }>;
  const bIndex = body.findIndex((item) => item.id === b.id);
  const aIndex = body.findIndex((item) => item.id === a.id);
  assert.ok(bIndex >= 0 && aIndex >= 0);
  assert.ok(bIndex < aIndex);
  const bRow = body.find((item) => item.id === b.id);
  const aRow = body.find((item) => item.id === a.id);
  assert.equal(bRow?.sort_order, 1);
  assert.equal(aRow?.sort_order, 2);
  assert.equal(typeof bRow?.stats.rooms, 'number');
});

test('delete project rejects active agent runs', async () => {
  const { project, room } = createProjectFixture('active-agent-run');
  const agent = roomAgentRepo.add({ room_id: room.id, agent_id: 'planner-delete-test', agent_name: 'Planner Delete Test' });
  agentRunRepo.create({
    room_id: room.id,
    room_agent_id: agent.id,
    agent_id: agent.agent_id,
    backend: 'codex',
    status: 'running',
    prompt: 'work',
  });

  const res = await request(`/api/projects/${project.id}`, { method: 'DELETE' });

  assert.equal(res.status, 409);
  const body = await res.json() as { error: string; active_agent_run_count: number; active_workflow_run_count: number };
  assert.equal(body.error, 'project has active runs');
  assert.equal(body.active_agent_run_count, 1);
  assert.equal(body.active_workflow_run_count, 0);
  assert.ok(projectRepo.get(project.id));
});

test('delete project rejects active workflow runs', async () => {
  const { project, room } = createProjectFixture('active-workflow-run');
  const task = taskRepo.create({ room_id: room.id, project_id: project.id, title: 'Workflow Task' });
  workflowRepo.createRun({
    room_id: room.id,
    project_id: project.id,
    task_id: task.id,
    status: 'awaiting_approval',
  });

  const res = await request(`/api/projects/${project.id}`, { method: 'DELETE' });

  assert.equal(res.status, 409);
  const body = await res.json() as { error: string; active_agent_run_count: number; active_workflow_run_count: number };
  assert.equal(body.error, 'project has active runs');
  assert.equal(body.active_agent_run_count, 0);
  assert.equal(body.active_workflow_run_count, 1);
  assert.ok(projectRepo.get(project.id));
});

test('delete project removes internal records and scoped settings only', async () => {
  const { project, room, projectPath } = createProjectFixture('delete-success');
  settingsRepo.updateProject(project.id, { auto_distill_enabled: false });
  settingsRepo.updateRoom(room.id, { auto_distill_enabled: true });

  const res = await request(`/api/projects/${project.id}`, { method: 'DELETE' });

  assert.equal(res.status, 204);
  assert.equal(projectRepo.get(project.id), undefined);
  assert.equal(roomRepo.get(room.id), undefined);
  assert.equal(settingsRepo.getProject(project.id), null);
  assert.equal(settingsRepo.getRoom(room.id), null);
  const settings = db.prepare('SELECT COUNT(*) AS count FROM settings WHERE scope_id IN (?, ?)').get(project.id, room.id) as { count: number };
  const projects = db.prepare('SELECT COUNT(*) AS count FROM projects WHERE path = ?').get(projectPath) as { count: number };
  assert.equal(settings.count, 0);
  assert.equal(projects.count, 0);
  assert.equal(projectPath.startsWith(tmpdir()), true);
});

function createProjectFixture(name: string) {
  const projectPath = mkdtempSync(join(tmpdir(), `openclaw-room-project-delete-${name}-`));
  const project = projectRepo.create({ name: `Project Delete ${name}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: `${name} Room` });
  return { project, room, projectPath };
}
