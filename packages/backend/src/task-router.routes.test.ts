import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-task-router-routes-')), 'test.db');

const express = (await import('express')).default;
const { projectRepo } = await import('./repos/projects.js');
const { roomRepo } = await import('./repos/rooms.js');
const { taskRepo } = await import('./repos/tasks.js');
const { taskEventRepo } = await import('./repos/task-events.js');
const { wsHub } = await import('./ws-hub.js');
const { router, setMessageRouteDeps } = await import('./routes.js');

const dispatchCalls: Array<{
  roomId: string;
  userMessage: { id: string; content: string };
  mentionedAgentRoomIds?: string[];
}> = [];

setMessageRouteDeps({
  dispatchUserMessage: async (input) => {
    dispatchCalls.push(input);
  },
});

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

function resetDispatchCalls(): void {
  dispatchCalls.length = 0;
}

test('POST /rooms/:roomId/messages records task routing metadata and activity event', async () => {
  const project = projectRepo.create({
    name: 'Task Router Route',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-task-router-route-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const task = taskRepo.create({ project_id: project.id, room_id: room.id, title: '修复登录错误' });

  const res = await request(`/api/rooms/${room.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '登录错误还有一个边界要补' }),
  });

  assert.equal(res.status, 201);
  const message = await res.json() as { id: string; metadata: string | null };
  const metadata = JSON.parse(message.metadata ?? '{}') as {
    task_id?: string;
    route_result?: { action: string; taskId: string | null; reason: string };
  };
  assert.equal(metadata.task_id, task.id);
  assert.equal(metadata.route_result?.taskId, task.id);
  assert.equal(metadata.route_result?.action, 'append_to_task');

  const events = taskEventRepo.listByTask(task.id, { layer: 'activity' });
  const routeEvent = events.find((event) => event.type === 'message_routed');
  assert.ok(routeEvent);
  assert.equal(routeEvent.payload.message_id, message.id);
  assert.equal(routeEvent.payload.route_action, 'append_to_task');
});

test('POST /rooms/:roomId/messages broadcasts activation when explicit routing switches task', async () => {
  const project = projectRepo.create({
    name: 'Task Router Switch Route',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-task-router-switch-route-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const active = taskRepo.create({ project_id: project.id, room_id: room.id, title: '当前任务' });
  const explicit = taskRepo.create({ project_id: project.id, room_id: room.id, title: '切换目标' });
  const events = captureRoomEvents(room.id);

  try {
    const res = await request(`/api/rooms/${room.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        content: `请切到 #task:${explicit.id} 继续`,
        active_task_id: active.id,
      }),
    });

    assert.equal(res.status, 201);
    const message = await res.json() as { id: string; metadata: string | null };
    const metadata = JSON.parse(message.metadata ?? '{}') as {
      task_id?: string;
      route_result?: { action: string; taskId: string | null; reason: string };
    };
    assert.equal(metadata.task_id, explicit.id);
    assert.equal(metadata.route_result?.action, 'switch_task');
    assert.equal(
      events.some((event) =>
        event.type === 'task:activated' &&
        event.roomId === room.id &&
        event.taskId === explicit.id
      ),
      true,
    );

    const routeEvent = taskEventRepo.listByTask(explicit.id, { layer: 'activity' })
      .find((event) => event.type === 'message_routed');
    assert.equal(routeEvent?.payload.route_action, 'switch_task');
  } finally {
    events.restore();
  }
});

test('POST /rooms/:roomId/messages creates a task for clear create-task intent', async () => {
  const project = projectRepo.create({
    name: 'Task Router Create Route',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-task-router-create-route-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });

  const res = await request(`/api/rooms/${room.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '新建任务：整理发布说明' }),
  });

  assert.equal(res.status, 201);
  const message = await res.json() as { id: string; metadata: string | null };
  const metadata = JSON.parse(message.metadata ?? '{}') as {
    task_id?: string;
    route_result?: { action: string; taskId: string | null; reason: string };
  };
  assert.equal(metadata.route_result?.action, 'create_task');
  assert.ok(metadata.task_id);

  const tasks = taskRepo.listByRoom(room.id);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.id, metadata.task_id);
  assert.equal(tasks[0]?.title, '整理发布说明');
  assert.equal(tasks[0]?.source_message_id, message.id);
  assert.equal(tasks[0]?.created_from, 'chat_plan');

  const events = taskEventRepo.listByTask(tasks[0]!.id, { layer: 'activity' });
  assert.equal(events.some((event) => event.type === 'task_created'), true);
});

test('POST /rooms/:roomId/messages surfaces low-confidence routing decisions', async () => {
  resetDispatchCalls();
  const project = projectRepo.create({
    name: 'Task Router Ask User Route',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-task-router-ask-user-route-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  taskRepo.create({ project_id: project.id, room_id: room.id, title: '修复登录错误' });

  const res = await request(`/api/rooms/${room.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '这个事情还要再看一下' }),
  });

  assert.equal(res.status, 201);
  assert.equal(dispatchCalls.length, 0);
  const message = await res.json() as { metadata: string | null };
  const metadata = JSON.parse(message.metadata ?? '{}') as {
    route_result?: { action: string; taskId: string | null; reason: string };
  };
  assert.equal(metadata.route_result?.action, 'ask_user');
  assert.equal(metadata.route_result?.taskId, null);

  const systemMessages = await (await request(`/api/rooms/${room.id}/messages`)).json() as Array<{
    sender_type: string;
    layer?: string;
    metadata: string | null;
  }>;
  const routePrompt = systemMessages.find((item) => {
    const itemMetadata = JSON.parse(item.metadata ?? '{}') as { event_type?: string; route_action?: string };
    return item.sender_type === 'system' &&
      item.layer === 'activity' &&
      itemMetadata.event_type === 'message_route_uncertain' &&
      itemMetadata.route_action === 'ask_user';
  });
  assert.ok(routePrompt);
});

test('POST /rooms/:roomId/messages still dispatches ask_user messages with explicit mentions', async () => {
  resetDispatchCalls();
  const project = projectRepo.create({
    name: 'Task Router Ask User Mention Route',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-task-router-ask-user-mention-route-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });

  const res = await request(`/api/rooms/${room.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      content: '这个事情还要再看一下',
      mentions: ['room-agent-1'],
    }),
  });

  assert.equal(res.status, 201);
  assert.equal(dispatchCalls.length, 1);
  assert.equal(dispatchCalls[0]?.roomId, room.id);
  assert.deepEqual(dispatchCalls[0]?.mentionedAgentRoomIds, ['room-agent-1']);
});

test('POST /rooms/:roomId/messages ignores terminal active task when routing', async () => {
  resetDispatchCalls();
  const project = projectRepo.create({
    name: 'Task Router Terminal Active Route',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-task-router-terminal-active-route-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const failed = taskRepo.create({ project_id: project.id, room_id: room.id, title: '失败任务' });
  taskRepo.updateStatus(failed.id, 'failed');

  const res = await request(`/api/rooms/${room.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      content: '继续按刚才的方案实现',
      active_task_id: failed.id,
    }),
  });

  assert.equal(res.status, 201);
  assert.equal(dispatchCalls.length, 0);
  const message = await res.json() as { metadata: string | null };
  const metadata = JSON.parse(message.metadata ?? '{}') as {
    task_id?: string;
    route_result?: { action: string; taskId: string | null; reason: string };
  };
  assert.equal(metadata.task_id, undefined);
  assert.equal(metadata.route_result?.action, 'ask_user');
  assert.equal(metadata.route_result?.taskId, null);
  assert.equal(taskEventRepo.listByTask(failed.id).some((event) => event.type === 'message_routed'), false);
});

test('POST /rooms/:roomId/messages rejects explicit terminal task routing', async () => {
  resetDispatchCalls();
  const project = projectRepo.create({
    name: 'Task Router Explicit Terminal Route',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-task-router-explicit-terminal-route-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const done = taskRepo.create({ project_id: project.id, room_id: room.id, title: '已完成任务' });
  taskRepo.updateStatus(done.id, 'done');

  const res = await request(`/api/rooms/${room.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      content: `继续处理 #task:${done.id}`,
    }),
  });

  assert.equal(res.status, 201);
  assert.equal(dispatchCalls.length, 0);
  const message = await res.json() as { metadata: string | null };
  const metadata = JSON.parse(message.metadata ?? '{}') as {
    task_id?: string;
    route_result?: { action: string; taskId: string | null; reason: string };
  };
  assert.equal(metadata.task_id, undefined);
  assert.equal(metadata.route_result?.action, 'ask_user');
  assert.equal(metadata.route_result?.taskId, null);
  assert.match(metadata.route_result?.reason ?? '', /不可接收新消息/);
  assert.equal(taskEventRepo.listByTask(done.id).some((event) => event.type === 'message_routed'), false);
});

test('POST /rooms/:roomId/tasks/:taskId/activate broadcasts task activation', async () => {
  const project = projectRepo.create({
    name: 'Task Activate Route',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-task-activate-route-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const task = taskRepo.create({ project_id: project.id, room_id: room.id, title: 'Activated task' });
  const events = captureRoomEvents(room.id);

  try {
    const res = await request(`/api/rooms/${room.id}/tasks/${task.id}/activate`, { method: 'POST' });

    assert.equal(res.status, 200);
    const body = await res.json() as { taskId: string };
    assert.equal(body.taskId, task.id);
    assert.deepEqual(events.find((event) => event.type === 'task:activated'), {
      type: 'task:activated',
      roomId: room.id,
      taskId: task.id,
    });
  } finally {
    events.restore();
  }
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
