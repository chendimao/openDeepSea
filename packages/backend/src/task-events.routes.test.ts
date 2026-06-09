import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-task-events-routes-')), 'test.db');

const express = (await import('express')).default;
const { agentRepo } = await import('./repos/agents.js');
const { agentRunLinkRepo } = await import('./repos/agent-run-links.js');
const { agentRunRepo } = await import('./repos/agent-runs.js');
const { projectRepo } = await import('./repos/projects.js');
const { roomAgentRepo, roomRepo } = await import('./repos/rooms.js');
const { taskRepo } = await import('./repos/tasks.js');
const { taskEventRepo } = await import('./repos/task-events.js');
const { router } = await import('./routes.js');

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

test('GET /rooms/:roomId/task-events returns task event projections filtered by task and layer', async () => {
  const project = projectRepo.create({
    name: 'Task Events Route',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-task-events-route-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const firstTask = taskRepo.create({ project_id: project.id, room_id: room.id, title: 'First task' });
  const secondTask = taskRepo.create({ project_id: project.id, room_id: room.id, title: 'Second task' });
  const firstEvent = taskEventRepo.create({
    task_id: firstTask.id,
    room_id: room.id,
    type: 'task_created',
    layer: 'activity',
    payload: { task_title: firstTask.title },
  });
  taskEventRepo.create({
    task_id: firstTask.id,
    room_id: room.id,
    type: 'workflow_stage_changed',
    layer: 'timeline',
    payload: { stage: 'analysis' },
  });
  taskEventRepo.create({
    task_id: secondTask.id,
    room_id: room.id,
    type: 'task_created',
    layer: 'activity',
    payload: { task_title: secondTask.title },
  });

  const res = await request(`/api/rooms/${room.id}/task-events?taskId=${firstTask.id}&layer=activity`);

  assert.equal(res.status, 200);
  const body = await res.json() as { events: Array<{ id: string; task_id: string; layer: string; payload: unknown }> };
  assert.deepEqual(body.events.map((event) => event.id), [firstEvent.id]);
  assert.equal(body.events[0]?.task_id, firstTask.id);
  assert.equal(body.events[0]?.layer, 'activity');
  assert.deepEqual(body.events[0]?.payload, { task_title: firstTask.title });
});

test('GET /rooms/:roomId/task-events can include replayed task state for a task event stream', async () => {
  const project = projectRepo.create({
    name: 'Task Events Replay Route',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-task-events-replay-route-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const task = taskRepo.create({ project_id: project.id, room_id: room.id, title: 'Initial title' });
  taskEventRepo.create({
    task_id: task.id,
    room_id: room.id,
    type: 'task_created',
    layer: 'activity',
    payload: {
      title: 'Initial title',
      description: 'Original description',
      priority: 'normal',
      interaction_mode: 'ask_user',
      status: 'todo',
      created_from: 'manual',
    },
  });
  taskEventRepo.create({
    task_id: task.id,
    room_id: room.id,
    type: 'task_updated',
    layer: 'activity',
    payload: {
      changed_fields: ['title'],
      next_title: 'Replayed title',
    },
  });
  taskEventRepo.create({
    task_id: task.id,
    room_id: room.id,
    type: 'task_status_changed',
    layer: 'activity',
    payload: {
      previous_status: 'todo',
      next_status: 'review',
    },
  });

  const res = await request(`/api/rooms/${room.id}/task-events?taskId=${task.id}&replay=1`);

  assert.equal(res.status, 200);
  const body = await res.json() as {
    replay: {
      task_id: string;
      title: string;
      description: string;
      status: string;
      priority: string;
      deleted: boolean;
      last_seq: number;
    };
  };
  assert.equal(body.replay.task_id, task.id);
  assert.equal(body.replay.title, 'Replayed title');
  assert.equal(body.replay.description, 'Original description');
  assert.equal(body.replay.status, 'review');
  assert.equal(body.replay.priority, 'normal');
  assert.equal(body.replay.deleted, false);
  assert.equal(body.replay.last_seq, 3);
});

test('GET /rooms/:roomId/task-events does not duplicate persisted native subagent events', async () => {
  const project = projectRepo.create({
    name: 'Persisted Subagent Events Route',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-persisted-subagent-route-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const globalAgent = agentRepo.getByAgentId('backend-executor');
  assert.ok(globalAgent);
  const roomAgent = roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: globalAgent.id });
  const task = taskRepo.create({ project_id: project.id, room_id: room.id, title: 'Native subagent events' });
  const parentRun = agentRunRepo.create({
    room_id: room.id,
    room_agent_id: roomAgent.id,
    agent_id: roomAgent.agent_id,
    backend: roomAgent.acp_backend ?? 'codex',
    task_id: task.id,
    prompt: 'parent',
  });
  const childRun = agentRunRepo.create({
    room_id: room.id,
    room_agent_id: roomAgent.id,
    agent_id: roomAgent.agent_id,
    backend: roomAgent.acp_backend ?? 'codex',
    task_id: task.id,
    prompt: 'child',
  });
  const link = agentRunLinkRepo.create({
    room_id: room.id,
    task_id: task.id,
    parent_run_id: parentRun.id,
    child_run_id: childRun.id,
    relationship: 'subagent',
    role: 'implementer',
  });
  taskEventRepo.create({
    task_id: task.id,
    room_id: room.id,
    type: 'runtime_event',
    layer: 'runtime',
    source_run_id: parentRun.id,
    payload: {
      timeline_type: 'subagent_started',
      timeline_status: 'started',
      parent_run_id: link.parent_run_id,
      child_run_id: link.child_run_id,
      child_agent_id: childRun.agent_id,
      role: link.role,
      relationship: link.relationship,
    },
  });

  const res = await request(`/api/rooms/${room.id}/task-events?taskId=${task.id}&layer=runtime`);

  assert.equal(res.status, 200);
  const body = await res.json() as { events: Array<{ id: string; payload: Record<string, unknown> }> };
  const subagentStartedEvents = body.events.filter((event) => event.payload.timeline_type === 'subagent_started');
  assert.equal(subagentStartedEvents.length, 1);
  assert.doesNotMatch(subagentStartedEvents[0]?.id ?? '', /^subagent-link:/u);
});

test('GET /rooms/:roomId/task-events still projects legacy subagent run links without persisted events', async () => {
  const project = projectRepo.create({
    name: 'Legacy Subagent Link Route',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-legacy-subagent-route-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const globalAgent = agentRepo.getByAgentId('backend-executor');
  assert.ok(globalAgent);
  const roomAgent = roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: globalAgent.id });
  const task = taskRepo.create({ project_id: project.id, room_id: room.id, title: 'Legacy subagent link' });
  const parentRun = agentRunRepo.create({
    room_id: room.id,
    room_agent_id: roomAgent.id,
    agent_id: roomAgent.agent_id,
    backend: roomAgent.acp_backend ?? 'codex',
    task_id: task.id,
    prompt: 'parent',
  });
  const childRun = agentRunRepo.create({
    room_id: room.id,
    room_agent_id: roomAgent.id,
    agent_id: roomAgent.agent_id,
    backend: roomAgent.acp_backend ?? 'codex',
    task_id: task.id,
    prompt: 'child',
  });
  agentRunRepo.updateStatus(childRun.id, 'completed');
  agentRunLinkRepo.create({
    room_id: room.id,
    task_id: task.id,
    parent_run_id: parentRun.id,
    child_run_id: childRun.id,
    relationship: 'subagent',
    role: 'implementer',
  });

  const res = await request(`/api/rooms/${room.id}/task-events?taskId=${task.id}&layer=runtime`);

  assert.equal(res.status, 200);
  const body = await res.json() as { events: Array<{ id: string; payload: Record<string, unknown> }> };
  const subagentEvents = body.events.filter((event) => event.payload.timeline_type === 'subagent_completed');
  assert.equal(subagentEvents.length, 1);
  assert.match(subagentEvents[0]?.id ?? '', /^subagent-link:/u);
  assert.equal(subagentEvents[0]?.payload.child_run_id, childRun.id);
  assert.equal(subagentEvents[0]?.payload.timeline_status, 'completed');
});
