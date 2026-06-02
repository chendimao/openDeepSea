import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-task-actions-')), 'test.db');

const { agentRepo } = await import('./repos/agents.js');
const { messageRepo } = await import('./repos/messages.js');
const { projectRepo } = await import('./repos/projects.js');
const { roomAgentRepo, roomRepo } = await import('./repos/rooms.js');
const { taskEventRepo } = await import('./repos/task-events.js');
const { taskRepo } = await import('./repos/tasks.js');
const { startTaskAction } = await import('./task-actions.js');

test('start_execution action creates a locked roster with executor reviewer and acceptor', async () => {
  const project = projectRepo.create({
    name: '四入口固定编队',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-fixed-roster-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const backend = agentRepo.getByAgentId('backend-executor');
  assert.ok(backend);
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: backend.id });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '修复后端搜索',
    description: '实现 @docs/super 子目录搜索',
    priority: 'normal',
    interaction_mode: 'ask_user',
    assigned_agent_id: undefined,
    source_message_id: null,
    parent_task_id: undefined,
  });

  const result = await startTaskAction({
    roomId: room.id,
    taskId: task.id,
    action: 'start_execution',
    senderId: 'user',
    senderName: 'You',
    runAgent: async () => ({ status: 'completed', content: '完成', error: null }),
  });

  assert.equal(result.action, 'start_execution');
  assert.notEqual(result.status, 'blocked');
  assert.equal(result.workflow?.locked, true);
  assert.deepEqual(result.workflow?.agents.map((agent) => agent.role).sort(), ['acceptor', 'executor', 'reviewer']);
  assert.deepEqual(result.workflow?.stages.map((stage) => stage.id), ['execute', 'review', 'acceptance']);
  assert.ok(result.message_id);
  const message = messageRepo.get(result.message_id);
  assert.equal(message?.layer, 'timeline');
  const events = taskEventRepo.listByTask(task.id, { limit: 5 });
  const actionEvent = events.find((event) => event.payload.action === 'start_execution');
  assert.equal(actionEvent?.payload.event_message_id, result.message_id);
  assert.equal(actionEvent?.payload.task_title, task.title);
});

test('start_execution does not use a disabled reviewer in locked roster', async () => {
  const project = projectRepo.create({
    name: '禁用审查员',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-disabled-reviewer-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const backend = agentRepo.getByAgentId('backend-executor');
  const reviewer = agentRepo.getByAgentId('reviewer');
  assert.ok(backend);
  assert.ok(reviewer);
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: backend.id });
  const reviewerRoomAgent = roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: reviewer.id });
  roomAgentRepo.setAcp(reviewerRoomAgent.id, {
    acp_enabled: false,
    acp_backend: null,
    acp_session_id: null,
    acp_session_label: null,
  });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '需要审查',
    description: '禁用 reviewer 不能进入 roster',
    priority: 'normal',
    interaction_mode: 'ask_user',
    source_message_id: null,
  });

  await assert.rejects(
    () => startTaskAction({
      roomId: room.id,
      taskId: task.id,
      action: 'start_execution',
    }),
    /no executable reviewer agent available/u,
  );
});
