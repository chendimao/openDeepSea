import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-task-router-')), 'test.db');

const { projectRepo } = await import('./repos/projects.js');
const { roomRepo } = await import('./repos/rooms.js');
const { taskRepo } = await import('./repos/tasks.js');
const { extractCreateTaskTitle, routeMessage } = await import('./task-router.js');

function createRoomFixture() {
  const project = projectRepo.create({
    name: `router-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-router-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  return { project, room };
}

test('routeMessage prefers explicit task id references over active task', () => {
  const { project, room } = createRoomFixture();
  const explicit = taskRepo.create({ project_id: project.id, room_id: room.id, title: '显式任务' });
  const active = taskRepo.create({ project_id: project.id, room_id: room.id, title: '激活任务' });

  const result = routeMessage({
    roomId: room.id,
    message: `继续处理 @task:${explicit.id}`,
    activeTaskId: active.id,
  });

  assert.equal(result.taskId, explicit.id);
  assert.equal(result.action, 'append_to_task');
  assert.equal(result.confidence, 1);
  assert.match(result.reason, /显式/);
});

test('routeMessage supports explicit hash task prefixes', () => {
  const { project, room } = createRoomFixture();
  const explicit = taskRepo.create({ project_id: project.id, room_id: room.id, title: '显式任务' });

  const result = routeMessage({
    roomId: room.id,
    message: `#${explicit.id.slice(0, 8)} 继续`,
  });

  assert.equal(result.taskId, explicit.id);
  assert.equal(result.action, 'append_to_task');
  assert.equal(result.confidence, 1);
  assert.match(result.reason, /显式/);
});

test('routeMessage ignores active task when there is no explicit task reference', () => {
  const { project, room } = createRoomFixture();
  const active = taskRepo.create({ project_id: project.id, room_id: room.id, title: '激活任务' });

  const result = routeMessage({
    roomId: room.id,
    message: '继续按刚才的方案实现',
    activeTaskId: active.id,
  });

  assert.equal(result.taskId, null);
  assert.equal(result.action, 'reply_in_chat');
  assert.equal(result.confidence, 0);
  assert.match(result.reason, /全局聊天/);
});

test('routeMessage ignores terminal active tasks', () => {
  const { project, room } = createRoomFixture();
  const failed = taskRepo.create({ project_id: project.id, room_id: room.id, title: '失败任务' });
  taskRepo.updateStatus(failed.id, 'failed');

  const result = routeMessage({
    roomId: room.id,
    message: '继续按刚才的方案实现',
    activeTaskId: failed.id,
  });

  assert.equal(result.taskId, null);
  assert.equal(result.action, 'reply_in_chat');
  assert.match(result.reason, /全局聊天/);
});

test('routeMessage does not append to explicit terminal task references', () => {
  const { project, room } = createRoomFixture();
  const done = taskRepo.create({ project_id: project.id, room_id: room.id, title: '已完成任务' });
  taskRepo.updateStatus(done.id, 'done');

  const result = routeMessage({
    roomId: room.id,
    message: `继续补充 #task:${done.id}`,
  });

  assert.equal(result.taskId, null);
  assert.equal(result.action, 'ask_user');
  assert.equal(result.confidence, 0);
  assert.match(result.reason, /不可接收新消息/);
});

test('routeMessage does not infer task routing from title tokens', () => {
  const { project, room } = createRoomFixture();
  taskRepo.create({ project_id: project.id, room_id: room.id, title: '修复登录错误' });
  taskRepo.create({ project_id: project.id, room_id: room.id, title: '优化构建速度' });

  const result = routeMessage({
    roomId: room.id,
    message: '登录错误还有一个边界情况要补',
  });

  assert.equal(result.taskId, null);
  assert.equal(result.action, 'reply_in_chat');
  assert.equal(result.confidence, 0);
  assert.match(result.reason, /全局聊天/);
});

test('routeMessage keeps ordinary chat global instead of asking user', () => {
  const { project, room } = createRoomFixture();
  taskRepo.create({ project_id: project.id, room_id: room.id, title: '修复登录错误' });

  const result = routeMessage({
    roomId: room.id,
    message: '帮我看一下这个问题',
  });

  assert.equal(result.taskId, null);
  assert.equal(result.action, 'reply_in_chat');
  assert.equal(result.confidence, 0);
  assert.match(result.reason, /全局聊天/);
});

test('routeMessage creates a task for clear standalone work when no task matches', () => {
  const { room } = createRoomFixture();

  const result = routeMessage({
    roomId: room.id,
    message: '新建任务：整理发布说明',
  });

  assert.equal(result.taskId, null);
  assert.equal(result.action, 'create_task');
  assert.ok(result.confidence >= 0.75);
  assert.match(result.reason, /新任务/);
});

test('extractCreateTaskTitle parses slash and Chinese create-task commands', () => {
  assert.equal(extractCreateTaskTitle('新建任务：整理发布说明'), '整理发布说明');
  assert.equal(extractCreateTaskTitle('/task Fix release notes'), 'Fix release notes');
  assert.equal(extractCreateTaskTitle('帮我看一下'), null);
});

test('extractCreateTaskTitle uses the first content line for multiline create-task messages', () => {
  assert.equal(
    extractCreateTaskTitle('新建任务：浏览器闭环测试\n目标：验证任务状态流转'),
    '浏览器闭环测试',
  );
  assert.equal(
    extractCreateTaskTitle('/task Browser smoke\nGoal: verify task routing'),
    'Browser smoke',
  );
});

test('routeMessage asks the user when create-task command has no title', () => {
  const { room } = createRoomFixture();

  const result = routeMessage({
    roomId: room.id,
    message: '新建任务：',
  });

  assert.equal(result.action, 'ask_user');
  assert.equal(result.taskId, null);
});
