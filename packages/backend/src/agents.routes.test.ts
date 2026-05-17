import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-agent-routes-')), 'test.db');

const { projectRepo } = await import('./repos/projects.js');
const { roomRepo } = await import('./repos/rooms.js');
const { agentRepo } = await import('./repos/agents.js');
const { agentRunRepo } = await import('./repos/agent-runs.js');
const { taskRepo } = await import('./repos/tasks.js');
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

test('global agent routes create, list, update, protect referenced deletes, and delete unused agents', async () => {
  const createRes = await request('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      agent_id: 'frontend-lead',
      name: '前端执行官',
      description: '负责前端实现和验收。',
      preferred_user_name: '陈工',
      personality: '严谨、直接。',
      rules: '完成前必须验证。',
      responsibilities: '前端实现。',
      default_acp_backend: 'codex',
      default_acp_permission_mode: 'workspace-write',
    }),
  });
  assert.equal(createRes.status, 201);
  const created = await createRes.json() as { id: string; agent_id: string; reference_count: number };
  assert.equal(created.agent_id, 'frontend-lead');
  assert.equal(created.reference_count, 0);

  const listRes = await request('/api/agents');
  assert.equal(listRes.status, 200);
  const listed = await listRes.json() as Array<{ id: string; name: string }>;
  assert.ok(listed.some((agent) => agent.id === created.id && agent.name === '前端执行官'));

  const patchRes = await request(`/api/agents/${created.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      personality: '冷静、务实。',
      rules: '不要修改无关文件。',
    }),
  });
  assert.equal(patchRes.status, 200);
  const patched = await patchRes.json() as { personality: string; rules: string };
  assert.equal(patched.personality, '冷静、务实。');
  assert.equal(patched.rules, '不要修改无关文件。');

  const projectPath = mkdtempSync(join(tmpdir(), 'openclaw-room-agent-routes-project-'));
  const project = projectRepo.create({ name: 'Agent API Project', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Agent API Room' });

  const inviteRes = await request(`/api/rooms/${room.id}/agents`, {
    method: 'POST',
    body: JSON.stringify({ global_agent_id: created.id }),
  });
  assert.equal(inviteRes.status, 201);
  const roomAgent = await inviteRes.json() as {
    global_agent_id: string;
    agent_id: string;
    agent_name: string;
    personality: string;
    acp_backend: string;
  };
  assert.equal(roomAgent.global_agent_id, created.id);
  assert.equal(roomAgent.agent_id, 'frontend-lead');
  assert.equal(roomAgent.agent_name, '前端执行官');
  assert.equal(roomAgent.personality, '冷静、务实。');
  assert.equal(roomAgent.acp_backend, 'codex');

  const blockedDeleteRes = await request(`/api/agents/${created.id}`, { method: 'DELETE' });
  assert.equal(blockedDeleteRes.status, 409);
  const blocked = await blockedDeleteRes.json() as { error: string; references: Array<{ room_id: string; room_name: string }> };
  assert.equal(blocked.error, 'agent is in use');
  assert.deepEqual(blocked.references, [{ room_id: room.id, room_name: 'Agent API Room', active: 1 }]);

  const unusedRes = await request('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      agent_id: 'unused',
      name: 'Unused',
      default_acp_permission_mode: 'bypass',
    }),
  });
  assert.equal(unusedRes.status, 201);
  const unused = await unusedRes.json() as { id: string };

  const deleteUnusedRes = await request(`/api/agents/${unused.id}`, { method: 'DELETE' });
  assert.equal(deleteUnusedRes.status, 204);
});

test('manual room agent creation rejects unknown rooms without creating a global agent', async () => {
  const before = agentRepo.list().length;

  const inviteRes = await request('/api/rooms/missing-room/agents', {
    method: 'POST',
    body: JSON.stringify({
      agent_id: 'orphan-agent',
      agent_name: 'Orphan Agent',
      acp_backend: 'codex',
    }),
  });

  assert.equal(inviteRes.status, 404);
  assert.equal(agentRepo.list().length, before);
});

test('built-in global agents are listed, editable, restorable, and protected from deletes', async () => {
  const planner = agentRepo.getByAgentId('planner');
  assert.ok(planner);
  assert.equal(planner.is_builtin, 1);

  const patchRes = await request(`/api/agents/${planner.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      personality: '更偏向保守规划。',
      rules: '先拆解再执行。',
    }),
  });
  assert.equal(patchRes.status, 200);
  const patched = await patchRes.json() as { personality: string; rules: string; is_builtin: 0 | 1 };
  assert.equal(patched.is_builtin, 1);
  assert.equal(patched.personality, '更偏向保守规划。');
  assert.equal(patched.rules, '先拆解再执行。');

  const idPatchRes = await request(`/api/agents/${planner.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      agent_id: 'custom-planner',
    }),
  });
  assert.equal(idPatchRes.status, 400);
  assert.match(await idPatchRes.text(), /builtin agent id cannot be changed/);

  const deleteRes = await request(`/api/agents/${planner.id}`, { method: 'DELETE' });
  assert.equal(deleteRes.status, 409);
  const blocked = await deleteRes.json() as { error: string };
  assert.equal(blocked.error, 'builtin agent cannot be deleted');

  const restoreRes = await request(`/api/agents/${planner.id}/restore-defaults`, { method: 'POST' });
  assert.equal(restoreRes.status, 200);
  const restored = await restoreRes.json() as { personality: string; rules: string; is_builtin: 0 | 1 };
  assert.equal(restored.is_builtin, 1);
  assert.notEqual(restored.personality, '更偏向保守规划。');
  assert.notEqual(restored.rules, '先拆解再执行。');
});

test('room agents can be batch-added and already joined agents are reused', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'openclaw-room-agent-batch-project-'));
  const project = projectRepo.create({ name: 'Agent Batch Project', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Agent Batch Room' });
  const planner = agentRepo.getByAgentId('planner');
  const reviewer = agentRepo.getByAgentId('reviewer');
  assert.ok(planner);
  assert.ok(reviewer);

  const batchRes = await request(`/api/rooms/${room.id}/agents/batch`, {
    method: 'POST',
    body: JSON.stringify({ global_agent_ids: [planner.id, reviewer.id] }),
  });
  assert.equal(batchRes.status, 201);
  const batch = await batchRes.json() as Array<{ id: string; global_agent_id: string; agent_id: string }>;
  assert.equal(batch.length, 2);
  assert.deepEqual(batch.map((agent) => agent.agent_id).sort(), ['planner', 'reviewer']);

  const repeatRes = await request(`/api/rooms/${room.id}/agents/batch`, {
    method: 'POST',
    body: JSON.stringify({ global_agent_ids: [planner.id] }),
  });
  assert.equal(repeatRes.status, 201);
  const repeated = await repeatRes.json() as Array<{ id: string; agent_id: string }>;
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0]?.id, batch.find((agent) => agent.agent_id === 'planner')?.id);
});

test('removing room agents protects active runs and requires task handling for open tasks', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'openclaw-room-agent-remove-project-'));
  const project = projectRepo.create({ name: 'Agent Remove Project', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Agent Remove Room' });
  const planner = agentRepo.getByAgentId('planner');
  const reviewer = agentRepo.getByAgentId('reviewer');
  assert.ok(planner);
  assert.ok(reviewer);

  const plannerRes = await request(`/api/rooms/${room.id}/agents`, {
    method: 'POST',
    body: JSON.stringify({ global_agent_id: planner.id }),
  });
  assert.equal(plannerRes.status, 201);
  const plannerRoomAgent = await plannerRes.json() as { id: string; agent_id: string };

  const activeRun = agentRunRepo.create({
    room_id: room.id,
    room_agent_id: plannerRoomAgent.id,
    agent_id: plannerRoomAgent.agent_id,
    backend: 'codex',
    prompt: 'run',
  });

  const activeBlockedRes = await request(`/api/rooms/${room.id}/agents/${plannerRoomAgent.id}`, { method: 'DELETE' });
  assert.equal(activeBlockedRes.status, 409);
  const activeBlocked = await activeBlockedRes.json() as { error: string; active_run_count: number };
  assert.equal(activeBlocked.error, 'agent has active runs');
  assert.equal(activeBlocked.active_run_count, 1);

  agentRunRepo.updateStatus(activeRun.id, 'completed');
  const openTask = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Open assigned task',
    assigned_agent_id: plannerRoomAgent.id,
  });
  const doneTask = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Done assigned task',
    assigned_agent_id: plannerRoomAgent.id,
  });
  taskRepo.updateStatus(doneTask.id, 'done');

  const taskBlockedRes = await request(`/api/rooms/${room.id}/agents/${plannerRoomAgent.id}`, { method: 'DELETE' });
  assert.equal(taskBlockedRes.status, 409);
  const taskBlocked = await taskBlockedRes.json() as { error: string; open_task_count: number };
  assert.equal(taskBlocked.error, 'agent has open tasks');
  assert.equal(taskBlocked.open_task_count, 1);

  const unassignRes = await request(`/api/rooms/${room.id}/agents/${plannerRoomAgent.id}`, {
    method: 'DELETE',
    body: JSON.stringify({ task_action: 'unassign' }),
  });
  assert.equal(unassignRes.status, 204);
  assert.equal(taskRepo.get(openTask.id)?.assigned_agent_id, null);
  assert.equal(taskRepo.get(doneTask.id)?.assigned_agent_id, plannerRoomAgent.id);

  const listedAfterRemove = await request(`/api/rooms/${room.id}/agents`);
  assert.equal(listedAfterRemove.status, 200);
  const activeAgents = await listedAfterRemove.json() as Array<{ id: string }>;
  assert.equal(activeAgents.some((agent) => agent.id === plannerRoomAgent.id), false);

  const readdRes = await request(`/api/rooms/${room.id}/agents`, {
    method: 'POST',
    body: JSON.stringify({ global_agent_id: planner.id }),
  });
  assert.equal(readdRes.status, 201);
  const readded = await readdRes.json() as { id: string };
  assert.equal(readded.id, plannerRoomAgent.id);

  const reviewerRes = await request(`/api/rooms/${room.id}/agents`, {
    method: 'POST',
    body: JSON.stringify({ global_agent_id: reviewer.id }),
  });
  assert.equal(reviewerRes.status, 201);
  const reviewerRoomAgent = await reviewerRes.json() as { id: string };
  const transferTask = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Transfer assigned task',
    assigned_agent_id: plannerRoomAgent.id,
  });

  const transferRes = await request(`/api/rooms/${room.id}/agents/${plannerRoomAgent.id}`, {
    method: 'DELETE',
    body: JSON.stringify({ task_action: 'transfer', transfer_to_room_agent_id: reviewerRoomAgent.id }),
  });
  assert.equal(transferRes.status, 204);
  assert.equal(taskRepo.get(transferTask.id)?.assigned_agent_id, reviewerRoomAgent.id);
});
