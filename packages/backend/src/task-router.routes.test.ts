import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-task-router-routes-')), 'test.db');
process.env.LANGGRAPH_WORKFLOW_ENABLED = '1';
process.env.OPENCLAW_ACP_MESSAGE_INTENT_CLASSIFIER = '0';

const express = (await import('express')).default;
const { projectRepo } = await import('./repos/projects.js');
const { roomRepo } = await import('./repos/rooms.js');
const { taskRepo } = await import('./repos/tasks.js');
const { taskEventRepo } = await import('./repos/task-events.js');
const { workflowRepo } = await import('./repos/workflows.js');
const { wsHub } = await import('./ws-hub.js');
const { router, setMessageRouteDeps } = await import('./routes.js');
const { setWorkflowConversationDeps } = await import('./workflows/conversation.js');

const dispatchCalls: Array<{
  roomId: string;
  userMessage: { id: string; content: string };
  mentionedAgentRoomIds?: string[];
}> = [];

function installDefaultDeps(): void {
  setMessageRouteDeps({
    dispatchUserMessage: async (input) => {
      dispatchCalls.push(input);
    },
  });
  setWorkflowConversationDeps({
    enqueueGraphWorkflow: () => undefined,
  });
  process.env.LANGGRAPH_WORKFLOW_ENABLED = '1';
}

installDefaultDeps();

test.afterEach(() => {
  installDefaultDeps();
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

test('POST /rooms/:roomId/messages keeps title-like messages in global chat', async () => {
  const project = projectRepo.create({
    name: 'Task Router Route',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-task-router-route-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const task = taskRepo.create({ project_id: project.id, room_id: room.id, title: '同步侧栏文案' });

  const res = await request(`/api/rooms/${room.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '同步侧栏文案这里还有一个想法' }),
  });

  assert.equal(res.status, 201);
  const message = await res.json() as { id: string; metadata: string | null };
  const metadata = JSON.parse(message.metadata ?? '{}') as {
    task_id?: string;
    route_result?: { action: string; taskId: string | null; reason: string };
  };
  assert.equal(metadata.task_id, undefined);
  assert.equal(metadata.route_result?.taskId, null);
  assert.equal(metadata.route_result?.action, 'reply_in_chat');

  const events = taskEventRepo.listByTask(task.id, { layer: 'activity' });
  const routeEvent = events.find((event) => event.type === 'message_routed');
  assert.equal(routeEvent, undefined);
});

test('POST /rooms/:roomId/messages records explicit task routing without switching selection', async () => {
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
    assert.equal(metadata.route_result?.action, 'append_to_task');
    assert.equal(
      events.some((event) =>
        event.type === 'task:activated' &&
        event.roomId === room.id &&
        event.taskId === explicit.id
      ),
      false,
    );

    const routeEvent = taskEventRepo.listByTask(explicit.id, { layer: 'activity' })
      .find((event) => event.type === 'message_routed');
    assert.equal(routeEvent?.payload.route_action, 'append_to_task');
  } finally {
    events.restore();
  }
});

test('POST /rooms/:roomId/messages creates a task for clear create-task intent', async () => {
  resetDispatchCalls();
  const project = projectRepo.create({
    name: 'Task Router Create Route',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-task-router-create-route-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const events = captureRoomEvents(room.id);

  try {
    const res = await request(`/api/rooms/${room.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: '新建任务：整理发布说明' }),
    });

    assert.equal(res.status, 201);
    assert.equal(dispatchCalls.length, 1);
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

    const taskEvents = taskEventRepo.listByTask(tasks[0]!.id, { layer: 'activity' });
    assert.equal(taskEvents.some((event) => event.type === 'task_created'), true);
    assert.equal(
      events.some((event) =>
        event.type === 'task:activated' &&
        event.roomId === room.id &&
        event.taskId === tasks[0]!.id
      ),
      true,
    );
    const messageSnapshot = events.find(
      (event): event is Extract<import('./types.js').WsServerEvent, { type: 'message:stream' }> =>
        event.type === 'message:stream' && event.messageId === message.id,
    );
    assert.ok(messageSnapshot);
    assert.equal(messageSnapshot.done, true);
    assert.ok(messageSnapshot.message?.metadata);
    const snapshotMetadata = JSON.parse(messageSnapshot.message!.metadata ?? '{}') as { task_id?: string };
    assert.equal(snapshotMetadata.task_id, tasks[0]!.id);
  } finally {
    events.restore();
  }
});

test('POST /rooms/:roomId/messages keeps ordinary low-confidence chat global', async () => {
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
  assert.equal(dispatchCalls.length, 1);
  const message = await res.json() as { metadata: string | null };
  const metadata = JSON.parse(message.metadata ?? '{}') as {
    route_result?: { action: string; taskId: string | null; reason: string };
  };
  assert.equal(metadata.route_result?.action, 'reply_in_chat');
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
  assert.equal(routePrompt, undefined);
});

test('POST /rooms/:roomId/messages records chat intent without creating task', async () => {
  resetDispatchCalls();
  const project = projectRepo.create({
    name: 'Message Intent Chat Route',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-message-intent-chat-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });

  const res = await request(`/api/rooms/${room.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '解释一下这个架构为什么要分 M1-M4' }),
  });

  assert.equal(res.status, 201);
  assert.equal(dispatchCalls.length, 1);
  const message = await res.json() as { id: string; metadata: string | null };
  const metadata = JSON.parse(message.metadata ?? '{}') as {
    intent_result?: { intent: string; suggestedAction: string };
  };
  assert.equal(metadata.intent_result?.intent, 'chat');
  assert.equal(metadata.intent_result?.suggestedAction, 'reply_in_chat');
  assert.equal(taskRepo.listByRoom(room.id).length, 0);

  const systemMessages = await (await request(`/api/rooms/${room.id}/messages`)).json() as Array<{
    sender_type: string;
    layer?: string;
    metadata: string | null;
  }>;
  const routePrompt = systemMessages.find((item) => {
    const itemMetadata = JSON.parse(item.metadata ?? '{}') as { event_type?: string; message_id?: string };
    return item.sender_type === 'system' &&
      item.layer === 'activity' &&
      itemMetadata.event_type === 'message_route_uncertain' &&
      itemMetadata.message_id === message.id;
  });
  assert.equal(routePrompt, undefined);
});

test('POST /rooms/:roomId/messages creates task for high-confidence light task intent', async () => {
  resetDispatchCalls();
  const project = projectRepo.create({
    name: 'Message Intent Light Task Route',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-message-intent-light-task-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });

  const res = await request(`/api/rooms/${room.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '临时插入一点修改，把默认主题改成极简风' }),
  });

  assert.equal(res.status, 201);
  assert.equal(dispatchCalls.length, 1);
  const message = await res.json() as { id: string; metadata: string | null };
  const metadata = JSON.parse(message.metadata ?? '{}') as {
    task_id?: string;
    intent_result?: { intent: string; suggestedAction: string };
    route_result?: { action: string; taskId: string | null };
  };
  assert.equal(metadata.intent_result?.intent, 'light_task');
  assert.equal(metadata.intent_result?.suggestedAction, 'create_light_task');
  assert.equal(metadata.route_result?.action, 'create_task');
  assert.ok(metadata.task_id);

  const tasks = taskRepo.listByRoom(room.id);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.source_message_id, message.id);
  assert.equal(tasks[0]?.interaction_mode, 'ask_user');
  assert.equal(workflowRepo.listByTask(tasks[0]!.id).length, 0);
});

test('POST /rooms/:roomId/messages creates new workflow task for high-confidence intent even with active task', async () => {
  resetDispatchCalls();
  const project = projectRepo.create({
    name: 'Message Intent Active Task Override Route',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-message-intent-active-task-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const active = taskRepo.create({
    project_id: project.id,
    room_id: room.id,
    title: '当前轻量任务',
    interaction_mode: 'ask_user',
  });

  const res = await request(`/api/rooms/${room.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      content: '为什么页面中没有任何变化，帮我找根因',
      active_task_id: active.id,
    }),
  });

  assert.equal(res.status, 201);
  assert.equal(dispatchCalls.length, 1);
  const message = await res.json() as { id: string; metadata: string | null };
  const metadata = JSON.parse(message.metadata ?? '{}') as {
    task_id?: string;
    intent_result?: { intent: string; suggestedAction: string };
    route_result?: { action: string; taskId: string | null; reason_code?: string };
  };
  assert.equal(metadata.intent_result?.intent, 'debugger');
  assert.equal(metadata.intent_result?.suggestedAction, 'start_debugger');
  assert.equal(metadata.route_result?.action, 'create_task');
  assert.equal(metadata.route_result?.reason_code, 'create_task_intent');
  assert.notEqual(metadata.task_id, active.id);

  const tasks = taskRepo.listByRoom(room.id);
  assert.equal(tasks.length, 2);
  const created = tasks.find((task) => task.id === metadata.task_id);
  assert.ok(created);
  assert.equal(created.interaction_mode, 'auto_recommended');
  assert.equal(created.source_message_id, message.id);
  assert.equal(workflowRepo.listByTask(created.id).length, 1);
  assert.equal(taskEventRepo.listByTask(active.id).some((event) => event.type === 'message_routed'), false);
});

for (const scenario of [
  {
    name: 'debugger',
    content: '为什么页面中没有任何变化，帮我找根因',
    suggestedAction: 'start_debugger',
    executionIntent: 'debug_fix',
  },
  {
    name: 'brainstorming',
    content: '头脑风暴，将左侧任务栏和右侧任务详情合并在一起',
    suggestedAction: 'start_brainstorming',
    executionIntent: 'planning_only',
  },
  {
    name: 'workflow',
    content: '实现消息意图自动路由，需要完整闭环，完成后浏览器实际测试、代码审查并提交',
    suggestedAction: 'start_workflow',
    executionIntent: 'implementation',
  },
] as const) {
  test(`POST /rooms/:roomId/messages creates auto-start workflow task for ${scenario.name} intent`, async () => {
    resetDispatchCalls();
    const project = projectRepo.create({
      name: `Message Intent ${scenario.name} Route`,
      path: mkdtempSync(join(tmpdir(), `openclaw-room-message-intent-${scenario.name}-`)),
    });
    const room = roomRepo.create({ project_id: project.id, name: 'Room' });
    const events = captureRoomEvents(room.id);

    try {
      const res = await request(`/api/rooms/${room.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: scenario.content }),
      });

      assert.equal(res.status, 201);
      assert.equal(dispatchCalls.length, 1);
      const message = await res.json() as { id: string; metadata: string | null };
      const metadata = JSON.parse(message.metadata ?? '{}') as {
        task_id?: string;
        intent_result?: { intent: string; suggestedAction: string };
        route_result?: { action: string; taskId: string | null };
      };
      assert.equal(metadata.intent_result?.intent, scenario.name);
      assert.equal(metadata.intent_result?.suggestedAction, scenario.suggestedAction);
      assert.equal(metadata.route_result?.action, 'create_task');
      assert.ok(metadata.task_id);

      const tasks = taskRepo.listByRoom(room.id);
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0]?.id, metadata.task_id);
      assert.equal(tasks[0]?.source_message_id, message.id);
      assert.equal(tasks[0]?.interaction_mode, 'auto_recommended');
      assert.match(tasks[0]?.description ?? '', new RegExp(`消息模式：${scenario.name}`, 'u'));
      assert.match(tasks[0]?.description ?? '', new RegExp(`任务意图：${scenario.executionIntent}`, 'u'));

      const runs = workflowRepo.listByTask(tasks[0]!.id);
      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.status, 'running');
      const workflowStarted = taskEventRepo.listByTask(tasks[0]!.id, { layer: 'timeline' })
        .find((event) => event.type === 'workflow_started');
      assert.ok(workflowStarted);
      assert.equal(workflowStarted.payload.workflow_source, 'auto_start');
      assert.equal(workflowStarted.payload.workflow_source_message_id, message.id);
      assert.equal(
        events.some((event) =>
          event.type === 'workflow:created' &&
          event.roomId === room.id &&
          event.workflow.id === runs[0]?.id
        ),
        true,
      );
    } finally {
      events.restore();
    }
  });
}

test('POST /rooms/:roomId/messages records low-confidence intent activity', async () => {
  resetDispatchCalls();
  const project = projectRepo.create({
    name: 'Message Intent Low Confidence Route',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-message-intent-low-confidence-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });

  const res = await request(`/api/rooms/${room.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '这个事情再处理一下' }),
  });

  assert.equal(res.status, 201);
  const message = await res.json() as { id: string; metadata: string | null };
  const metadata = JSON.parse(message.metadata ?? '{}') as {
    intent_result?: { intent: string; suggestedAction: string };
  };
  assert.equal(metadata.intent_result?.suggestedAction, 'ask_user');

  const systemMessages = await (await request(`/api/rooms/${room.id}/messages`)).json() as Array<{
    sender_type: string;
    layer?: string;
    content: string;
    metadata: string | null;
  }>;
  const intentPrompt = systemMessages.find((item) => {
    const itemMetadata = JSON.parse(item.metadata ?? '{}') as { event_type?: string; message_id?: string };
    return item.sender_type === 'system' &&
      item.layer === 'activity' &&
      itemMetadata.event_type === 'message_intent_uncertain' &&
      itemMetadata.message_id === message.id;
  });
  assert.ok(intentPrompt);
  assert.match(intentPrompt.content, /无法确定消息类型/);
});

test('POST /rooms/:roomId/messages can use injected classifier for ambiguous intent', async () => {
  setMessageRouteDeps({
    dispatchUserMessage: async (input) => {
      dispatchCalls.push(input);
    },
    intentClassifier: async () => JSON.stringify({
      intent: 'workflow',
      confidence: 0.9,
      reason: '只读 classifier 根据上下文判断为正式 workflow',
      source: 'classifier',
      suggestedAction: 'start_workflow',
      signals: ['上下文', '正式 workflow'],
    }),
  });
  resetDispatchCalls();
  const project = projectRepo.create({
    name: 'Message Intent Classifier Route',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-message-intent-classifier-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });

  const res = await request(`/api/rooms/${room.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '这个事情再处理一下' }),
  });

  assert.equal(res.status, 201);
  const message = await res.json() as { metadata: string | null };
  const metadata = JSON.parse(message.metadata ?? '{}') as {
    intent_result?: { intent: string; source: string };
    route_result?: { action: string };
  };
  assert.equal(metadata.intent_result?.intent, 'workflow');
  assert.equal(metadata.intent_result?.source, 'classifier');
  assert.equal(metadata.route_result?.action, 'create_task');
});

test('POST /rooms/:roomId/messages still dispatches global chat messages with explicit mentions', async () => {
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

test('POST /rooms/:roomId/messages ignores active task when routing', async () => {
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
  assert.equal(dispatchCalls.length, 1);
  const message = await res.json() as { metadata: string | null };
  const metadata = JSON.parse(message.metadata ?? '{}') as {
    task_id?: string;
    route_result?: { action: string; taskId: string | null; reason: string };
  };
  assert.equal(metadata.task_id, undefined);
  assert.equal(metadata.route_result?.action, 'reply_in_chat');
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
  assert.equal(dispatchCalls.length, 1);
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

test('POST /rooms/:roomId/messages keeps explicit terminal task guardrail for high-confidence intent', async () => {
  resetDispatchCalls();
  const project = projectRepo.create({
    name: 'Task Router Explicit Terminal Intent Route',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-task-router-explicit-terminal-intent-route-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const done = taskRepo.create({ project_id: project.id, room_id: room.id, title: '已完成任务' });
  taskRepo.updateStatus(done.id, 'done');

  const res = await request(`/api/rooms/${room.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      content: `继续处理 #task:${done.id}，这个报错需要 debug 找根因`,
    }),
  });

  assert.equal(res.status, 201);
  assert.equal(dispatchCalls.length, 1);
  const message = await res.json() as { metadata: string | null };
  const metadata = JSON.parse(message.metadata ?? '{}') as {
    task_id?: string;
    intent_result?: { intent: string; suggestedAction: string };
    route_result?: { action: string; taskId: string | null; reason: string; reason_code?: string };
  };
  assert.equal(metadata.intent_result?.intent, 'debugger');
  assert.equal(metadata.intent_result?.suggestedAction, 'start_debugger');
  assert.equal(metadata.task_id, undefined);
  assert.equal(metadata.route_result?.action, 'ask_user');
  assert.equal(metadata.route_result?.taskId, null);
  assert.equal(metadata.route_result?.reason_code, 'explicit_task_terminal');
  assert.match(metadata.route_result?.reason ?? '', /不可接收新消息/);
  assert.equal(taskRepo.listByRoom(room.id).length, 1);
  assert.equal(workflowRepo.listByRoom(room.id).length, 0);
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
