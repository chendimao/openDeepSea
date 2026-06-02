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
  const actionEvent = events.find((event) =>
    event.payload.action === 'start_execution' &&
    event.payload.status === result.status
  );
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

  const result = await startTaskAction({
    roomId: room.id,
    taskId: task.id,
    action: 'start_execution',
  });

  assert.equal(result.status, 'blocked');
  assert.match(result.blocked_reason ?? '', /no executable reviewer agent available/u);
  const events = taskEventRepo.listByTask(task.id, { limit: 10 });
  assert.ok(events.some((event) =>
    event.payload.action === 'start_execution' &&
    event.payload.status === 'running'
  ));
  const blockedEvent = events.find((event) =>
    event.payload.action === 'start_execution' &&
    event.payload.status === 'blocked'
  );
  assert.equal(blockedEvent?.payload.event_message_id, result.message_id);
  assert.match(String(blockedEvent?.payload.blocked_reason ?? ''), /no executable reviewer agent available/u);
});

test('start_execution runs only locked roster stages and never adds planner requested agents mid-run', async () => {
  const project = projectRepo.create({
    name: '锁定编队禁止中途扩编',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-no-mid-agent-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const backend = agentRepo.getByAgentId('backend-executor');
  assert.ok(backend);
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: backend.id });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '实现搜索',
    description: '执行中不得新增 review-validator',
    priority: 'normal',
    interaction_mode: 'ask_user',
    assigned_agent_id: undefined,
    source_message_id: null,
    parent_task_id: undefined,
  });
  const calls: string[] = [];

  const result = await startTaskAction({
    roomId: room.id,
    taskId: task.id,
    action: 'start_execution',
    runAgent: async ({ agent, prompt }) => {
      calls.push(agent.agent_id);
      assert.match(prompt, /已锁定完整 roster/u);
      return {
        status: 'completed',
        content: agent.workflow_role === 'executor'
          ? '实现完成。```json\n{"task_execution":{"state":"ready_to_execute","status":"suggested","summary":"错误地新增验证智能体","next_steps":[{"agent_id":"review-validator","goal":"验证"}]}}\n```'
          : '阶段完成',
        error: null,
        runId: `run-${agent.agent_id}`,
      };
    },
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(calls, ['backend-executor', 'reviewer', 'acceptor']);
  assert.deepEqual(result.run_ids, ['run-backend-executor', 'run-reviewer', 'run-acceptor']);
  assert.equal(roomAgentRepo.listByRoom(room.id).some((agent) => agent.agent_id === 'review-validator'), false);
});

test('start_execution records failed event when a locked roster stage throws', async () => {
  const project = projectRepo.create({
    name: '固定编队失败事件',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-stage-throw-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const backend = agentRepo.getByAgentId('backend-executor');
  assert.ok(backend);
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: backend.id });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '阶段失败',
    description: 'runner 抛错时必须写 failed 事件',
    priority: 'normal',
    interaction_mode: 'ask_user',
    assigned_agent_id: undefined,
    source_message_id: null,
    parent_task_id: undefined,
  });
  const calls: string[] = [];

  const result = await startTaskAction({
    roomId: room.id,
    taskId: task.id,
    action: 'start_execution',
    runAgent: async ({ agent }) => {
      calls.push(agent.agent_id);
      if (agent.workflow_role === 'reviewer') {
        throw new Error('runner exploded');
      }
      return {
        status: 'completed',
        content: '执行阶段完成',
        error: null,
        runId: `run-${agent.agent_id}`,
      };
    },
  });

  assert.equal(result.status, 'failed');
  assert.deepEqual(calls, ['backend-executor', 'reviewer']);
  assert.deepEqual(result.run_ids, ['run-backend-executor']);
  const events = taskEventRepo.listByTask(task.id, { limit: 10 });
  const failedEvent = events.find((event) =>
    event.payload.action === 'start_execution' &&
    event.payload.status === 'failed'
  );
  assert.match(String(failedEvent?.payload.error ?? ''), /runner exploded/u);
  assert.equal(failedEvent?.payload.event_message_id, result.message_id);
});

test('start_execution blocks when a locked room agent is removed during execution', async () => {
  const project = projectRepo.create({
    name: '固定 room agent id',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-locked-room-agent-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const backend = agentRepo.getByAgentId('backend-executor');
  assert.ok(backend);
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: backend.id });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '执行中替换 reviewer',
    description: '启动后锁定成员不可用时必须阻塞',
    priority: 'normal',
    interaction_mode: 'ask_user',
    assigned_agent_id: undefined,
    source_message_id: null,
    parent_task_id: undefined,
  });
  const calls: string[] = [];

  const result = await startTaskAction({
    roomId: room.id,
    taskId: task.id,
    action: 'start_execution',
    runAgent: async ({ agent }) => {
      calls.push(agent.agent_id);
      if (agent.workflow_role === 'executor') {
        const lockedReviewer = roomAgentRepo.listByRoom(room.id).find((candidate) =>
          candidate.workflow_role === 'reviewer'
        );
        assert.ok(lockedReviewer);
        roomAgentRepo.remove(lockedReviewer.id);
      }
      return {
        status: 'completed',
        content: '执行阶段完成',
        error: null,
        runId: `run-${agent.id}`,
      };
    },
  });

  assert.equal(result.status, 'blocked');
  assert.deepEqual(calls, ['backend-executor']);
  assert.deepEqual(result.run_ids.length, 1);
  assert.match(result.blocked_reason ?? '', /locked roster agent unavailable: reviewer/u);
  const events = taskEventRepo.listByTask(task.id, { limit: 10 });
  const blockedEvent = events.find((event) =>
    event.payload.action === 'start_execution' &&
    event.payload.status === 'blocked'
  );
  assert.match(String(blockedEvent?.payload.blocked_reason ?? ''), /locked roster agent unavailable: reviewer/u);
});
