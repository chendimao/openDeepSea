import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-tasks-routes-')), 'test.db');

const express = (await import('express')).default;
const { projectRepo } = await import('./repos/projects.js');
const { roomRepo } = await import('./repos/rooms.js');
const { roomAgentRepo } = await import('./repos/rooms.js');
const { taskRepo } = await import('./repos/tasks.js');
const { taskEventRepo } = await import('./repos/task-events.js');
const { taskExecutorRepo } = await import('./repos/task-executors.js');
const { agentRunRepo } = await import('./repos/agent-runs.js');
const { agentRunLinkRepo } = await import('./repos/agent-run-links.js');
const { wsHub } = await import('./ws-hub.js');
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

test('task CRUD routes list, create, update, and delete room tasks', async () => {
  const project = projectRepo.create({
    name: 'Tasks Route',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-tasks-route-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const existing = taskRepo.create({ project_id: project.id, room_id: room.id, title: 'Existing task' });

  const listBefore = await request(`/api/rooms/${room.id}/tasks`);
  assert.equal(listBefore.status, 200);
  const beforeBody = await listBefore.json() as Array<{ id: string }>;
  assert.deepEqual(beforeBody.map((task) => task.id), [existing.id]);

  const createRes = await request(`/api/rooms/${room.id}/tasks`, {
    method: 'POST',
    body: JSON.stringify({ title: 'Created task', priority: 'high' }),
  });
  assert.equal(createRes.status, 201);
  const created = await createRes.json() as { id: string; title: string; priority: string };
  assert.equal(created.title, 'Created task');
  assert.equal(created.priority, 'high');
  assert.equal(
    taskEventRepo.listByTask(created.id).some((event) => event.type === 'task_created' && event.layer === 'activity'),
    true,
  );

  const updateRes = await request(`/api/tasks/${created.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'in_progress', priority: 'urgent' }),
  });
  assert.equal(updateRes.status, 200);
  const updated = await updateRes.json() as { status: string; priority: string };
  assert.equal(updated.status, 'in_progress');
  assert.equal(updated.priority, 'urgent');
  const updatedEvents = taskEventRepo.listByTask(created.id);
  assert.equal(
    updatedEvents.some((event) => event.type === 'task_status_changed' && event.layer === 'activity'),
    true,
  );
  assert.equal(
    updatedEvents.some((event) => event.type === 'task_updated' && event.layer === 'activity'),
    true,
  );

  const deleteRes = await request(`/api/tasks/${created.id}`, { method: 'DELETE' });
  assert.equal(deleteRes.status, 204);
  assert.equal(taskRepo.get(created.id), undefined);
});

test('task delete route hides task while preserving append-only task event history', async () => {
  const project = projectRepo.create({
    name: 'Tasks Delete Event History Route',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-tasks-delete-history-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });

  const createRes = await request(`/api/rooms/${room.id}/tasks`, {
    method: 'POST',
    body: JSON.stringify({ title: 'Delete history task' }),
  });
  assert.equal(createRes.status, 201);
  const created = await createRes.json() as { id: string };
  const beforeDeleteEvents = taskEventRepo.listByTask(created.id);
  assert.equal(beforeDeleteEvents.some((event) => event.type === 'task_created'), true);
  const events = captureRoomEvents(room.id);

  try {
    const deleteRes = await request(`/api/tasks/${created.id}`, { method: 'DELETE' });
    assert.equal(deleteRes.status, 204);
  } finally {
    events.restore();
  }

  const listAfterDelete = await request(`/api/rooms/${room.id}/tasks`);
  assert.equal(listAfterDelete.status, 200);
  const visibleTasks = await listAfterDelete.json() as Array<{ id: string }>;
  assert.equal(visibleTasks.some((task) => task.id === created.id), false);

  const afterDeleteEvents = taskEventRepo.listByTask(created.id);
  assert.equal(afterDeleteEvents.some((event) => event.type === 'task_created'), true);
  assert.equal(afterDeleteEvents.some((event) => event.type === 'task_deleted'), true);
  assert.equal(
    events.some((event) => event.type === 'task_event:new' && event.event.type === 'task_deleted'),
    true,
  );
});

test('room task list marks task done when auto advance completed terminal action historically', async () => {
  const project = projectRepo.create({
    name: 'Tasks Auto Advance Reconcile Route',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-tasks-auto-advance-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const task = taskRepo.create({
    project_id: project.id,
    room_id: room.id,
    title: '历史自动推进完成任务',
  });
  const debuggingTask = taskRepo.create({
    project_id: project.id,
    room_id: room.id,
    title: '历史调试自动推进完成任务',
  });
  taskEventRepo.create({
    room_id: room.id,
    task_id: task.id,
    type: 'task_updated',
    layer: 'timeline',
    payload: {
      action: 'auto_advance',
      status: 'completed',
      task_action: 'auto_advance',
      task_action_status: 'completed',
      delegated_action: 'subagent_execution',
    },
  });
  taskEventRepo.create({
    room_id: room.id,
    task_id: debuggingTask.id,
    type: 'task_updated',
    layer: 'timeline',
    payload: {
      action: 'auto_advance',
      status: 'completed',
      task_action: 'auto_advance',
      task_action_status: 'completed',
      delegated_action: 'systematic_debugging',
    },
  });
  const events = captureRoomEvents(room.id);

  let listRes: Response;
  try {
    listRes = await request(`/api/rooms/${room.id}/tasks`);
  } finally {
    events.restore();
  }

  assert.equal(listRes.status, 200);
  const body = await listRes.json() as Array<{ id: string; status: string; completed_at: number | null }>;
  const reconciled = body.find((item) => item.id === task.id);
  assert.ok(reconciled);
  assert.equal(reconciled.status, 'done');
  assert.equal(typeof reconciled.completed_at, 'number');
  assert.equal(taskRepo.get(task.id)?.status, 'done');
  const reconciledDebugging = body.find((item) => item.id === debuggingTask.id);
  assert.ok(reconciledDebugging);
  assert.equal(reconciledDebugging.status, 'done');
  assert.equal(taskRepo.get(debuggingTask.id)?.status, 'done');
  assert.equal(
    taskEventRepo.listByTask(task.id).some((event) =>
      event.type === 'task_status_changed' &&
      event.payload.completed_by_task_action === 'auto_advance' &&
      event.payload.delegated_action === 'subagent_execution'
    ),
    true,
  );
  assert.equal(
    taskEventRepo.listByTask(debuggingTask.id).some((event) =>
      event.type === 'task_status_changed' &&
      event.payload.delegated_action === 'systematic_debugging'
    ),
    true,
  );
  assert.equal(
    events.filter((event) => event.type === 'task:updated').length,
    2,
  );
});

test('task patch route rejects unsupported fields instead of ignoring them', async () => {
  const project = projectRepo.create({
    name: 'Tasks Patch Validation Route',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-tasks-patch-validation-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const task = taskRepo.create({ project_id: project.id, room_id: room.id, title: 'Patch target' });

  const res = await request(`/api/tasks/${task.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ parent_task_id: 'ignored-parent-id' }),
  });

  assert.equal(res.status, 400);
  const unchanged = taskRepo.get(task.id);
  assert.equal(unchanged?.parent_task_id, null);
});

test('task events include subagent run links as runtime events', async () => {
  const project = projectRepo.create({
    name: 'Task Subagent Link Route',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-task-subagent-link-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const task = taskRepo.create({ project_id: project.id, room_id: room.id, title: 'Subagent visible task' });
  const parentRoomAgent = roomAgentRepo.add({
    room_id: room.id,
    agent_id: 'frontend-executor',
    agent_name: 'Frontend Executor',
  });
  const childRoomAgent = roomAgentRepo.add({
    room_id: room.id,
    agent_id: 'reviewer',
    agent_name: 'Reviewer',
  });
  const parent = agentRunRepo.create({
    room_id: room.id,
    room_agent_id: parentRoomAgent.id,
    agent_id: 'frontend-executor',
    backend: 'codex',
    prompt: 'parent',
    task_id: task.id,
  });
  const child = agentRunRepo.create({
    room_id: room.id,
    room_agent_id: childRoomAgent.id,
    agent_id: 'reviewer',
    backend: 'codex',
    prompt: 'review',
    task_id: task.id,
  });
  agentRunLinkRepo.create({
    room_id: room.id,
    task_id: task.id,
    parent_run_id: parent.id,
    child_run_id: child.id,
    relationship: 'subagent',
    role: 'spec_reviewer',
  });

  const res = await request(`/api/rooms/${room.id}/task-events?taskId=${task.id}&layer=runtime`);

  assert.equal(res.status, 200);
  const body = await res.json() as {
    events: Array<{ type: string; layer: string; payload: Record<string, unknown> }>;
  };
  assert.equal(
    body.events.some((event) =>
      event.type === 'runtime_event' &&
      event.layer === 'runtime' &&
      event.payload.timeline_type === 'subagent_started' &&
      event.payload.child_run_id === child.id &&
      event.payload.role === 'spec_reviewer'
    ),
    true,
  );
});

test('task executors route lists task-scoped executor sessions', async () => {
  const project = projectRepo.create({
    name: 'Task Executors Route',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-task-executors-route-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const agent = roomAgentRepo.add({ room_id: room.id, agent_id: 'codex', agent_name: 'Codex Agent' });
  const task = taskRepo.create({ project_id: project.id, room_id: room.id, title: 'Executor visible task' });
  taskExecutorRepo.ensure({
    task_id: task.id,
    room_id: room.id,
    room_agent_id: agent.id,
    agent_id: agent.agent_id,
    acp_session_id: 'task-session',
  });

  const res = await request(`/api/tasks/${task.id}/executors`);

  assert.equal(res.status, 200);
  const body = await res.json() as Array<{
    task_id: string;
    room_agent_id: string;
    agent_name: string;
    acp_session_id: string;
    status: string;
  }>;
  assert.equal(body.length, 1);
  assert.equal(body[0]?.task_id, task.id);
  assert.equal(body[0]?.room_agent_id, agent.id);
  assert.equal(body[0]?.agent_name, 'Codex Agent');
  assert.equal(body[0]?.acp_session_id, 'task-session');
  assert.equal(body[0]?.status, 'idle');
});

test('conversation task route creates task and system event', async () => {
  const project = projectRepo.create({
    name: 'Tasks Conversation Route',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-tasks-conversation-route-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });

  const res = await request(`/api/rooms/${room.id}/tasks/conversation`, {
    method: 'POST',
    body: JSON.stringify({ title: 'Conversation task', origin: 'manual' }),
  });

  assert.equal(res.status, 201);
  const body = await res.json() as { task: { title: string }; systemMessage: { metadata: string | null } };
  assert.equal(body.task.title, 'Conversation task');
  const metadata = JSON.parse(body.systemMessage.metadata ?? '{}') as { event_type?: string };
  assert.equal(metadata.event_type, 'task_created');
});

function captureRoomEvents(roomId: string): import('./types.js').WsServerEvent[] & { restore: () => void } {
  const original = wsHub.broadcast.bind(wsHub);
  const events: import('./types.js').WsServerEvent[] & { restore: () => void } = [] as never;
  wsHub.broadcast = ((targetRoomId, event) => {
    if (targetRoomId === roomId) events.push(event);
    return original(targetRoomId, event);
  }) as typeof wsHub.broadcast;
  events.restore = () => {
    wsHub.broadcast = original as typeof wsHub.broadcast;
  };
  return events;
}
