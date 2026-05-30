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

test('routeMessage uses active task when there is no explicit task reference', () => {
  const { project, room } = createRoomFixture();
  const active = taskRepo.create({ project_id: project.id, room_id: room.id, title: '激活任务' });

  const result = routeMessage({
    roomId: room.id,
    message: '继续按刚才的方案实现',
    activeTaskId: active.id,
  });

  assert.equal(result.taskId, active.id);
  assert.equal(result.action, 'append_to_task');
  assert.equal(result.confidence, 0.9);
  assert.match(result.reason, /激活任务/);
});

test('routeMessage does not append to terminal active tasks', () => {
  const { project, room } = createRoomFixture();
  const failed = taskRepo.create({ project_id: project.id, room_id: room.id, title: '失败任务' });
  taskRepo.updateStatus(failed.id, 'failed');

  const result = routeMessage({
    roomId: room.id,
    message: '继续按刚才的方案实现',
    activeTaskId: failed.id,
  });

  assert.equal(result.taskId, null);
  assert.equal(result.action, 'ask_user');
  assert.match(result.reason, /无法确定/);
});

test('routeMessage matches an open task by title tokens when no task is active', () => {
  const { project, room } = createRoomFixture();
  const matched = taskRepo.create({ project_id: project.id, room_id: room.id, title: '修复登录错误' });
  taskRepo.create({ project_id: project.id, room_id: room.id, title: '优化构建速度' });

  const result = routeMessage({
    roomId: room.id,
    message: '登录错误还有一个边界情况要补',
  });

  assert.equal(result.taskId, matched.id);
  assert.equal(result.action, 'append_to_task');
  assert.ok(result.confidence >= 0.65);
  assert.match(result.reason, /标题匹配/);
});

test('routeMessage asks user instead of guessing when confidence is low', () => {
  const { project, room } = createRoomFixture();
  taskRepo.create({ project_id: project.id, room_id: room.id, title: '修复登录错误' });

  const result = routeMessage({
    roomId: room.id,
    message: '帮我看一下这个问题',
  });

  assert.equal(result.taskId, null);
  assert.equal(result.action, 'ask_user');
  assert.equal(result.confidence, 0);
  assert.match(result.reason, /无法确定/);
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

test('routeMessage asks the user when create-task command has no title', () => {
  const { room } = createRoomFixture();

  const result = routeMessage({
    roomId: room.id,
    message: '新建任务：',
  });

  assert.equal(result.action, 'ask_user');
  assert.equal(result.taskId, null);
});
