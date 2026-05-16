import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

let tempRootDir: string;
let projectDir: string;

let db: typeof import('./db.js').db;
let createTaskWithConversation: typeof import('./task-conversation.js').createTaskWithConversation;
let createTaskCreationMemorySafely: typeof import('./task-conversation.js').createTaskCreationMemorySafely;
let recordTaskEvent: typeof import('./task-conversation.js').recordTaskEvent;
let memoryRepo: typeof import('./repos/memory.js').memoryRepo;

test.before(async () => {
  tempRootDir = await mkdtemp(join(tmpdir(), 'openclaw-room-task-conversation-'));
  projectDir = join(tempRootDir, 'project');
  await mkdir(projectDir, { recursive: true });
  process.env.OPENCLAW_ROOM_DB = join(tempRootDir, 'test.db');

  ({ db } = await import('./db.js'));
  ({ createTaskCreationMemorySafely, createTaskWithConversation, recordTaskEvent } = await import('./task-conversation.js'));
  ({ memoryRepo } = await import('./repos/memory.js'));
});

test.after(async () => {
  await rm(tempRootDir, { recursive: true, force: true });
});

function insertProjectAndRoom(): { projectId: string; roomId: string } {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const projectId = `project-${nonce}`;
  const roomId = `room-${nonce}`;
  const ts = Date.now();
  db.prepare(
    `INSERT INTO projects (id, name, path, description, message_routing_mode, fallback_agent_id, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 'mentions_only', NULL, ?, ?)`,
  ).run(projectId, projectId, join(projectDir, projectId), ts, ts);
  db.prepare(
    `INSERT INTO rooms (id, project_id, name, description, created_at)
     VALUES (?, ?, 'Room', NULL, ?)`,
  ).run(roomId, projectId, ts);
  return { projectId, roomId };
}

function insertStandaloneMessage(roomId: string): { id: string } {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const id = `msg-${nonce}`;
  db.prepare(
    `INSERT INTO messages (id, room_id, sender_type, sender_id, sender_name, content, message_type, metadata, created_at)
     VALUES (?, ?, 'user', 'user', 'You', 'existing message', 'text', NULL, ?)`,
  ).run(id, roomId, Date.now());
  return { id };
}

test('createTaskWithConversation creates user message, task, and system task event', () => {
  const { roomId } = insertProjectAndRoom();
  const result = createTaskWithConversation({
    roomId,
    origin: 'manual',
    actor: { sender_id: 'user', sender_name: 'You' },
    taskInput: { title: '修复登录错误', priority: 'high' },
  });

  assert.equal(result.userMessage?.content, '创建任务：修复登录错误');
  assert.equal(result.task.title, '修复登录错误');
  assert.equal(result.task.priority, 'high');
  assert.equal(result.task.created_from, 'manual');
  assert.equal(result.task.source_message_id, result.userMessage?.id ?? null);
  assert.equal(result.systemMessage.sender_type, 'system');
  assert.equal(result.systemMessage.message_type, 'system');

  const metadata = JSON.parse(result.systemMessage.metadata ?? '{}') as Record<string, unknown>;
  assert.equal(metadata.event_type, 'task_created');
  assert.equal(metadata.task_id, result.task.id);
  assert.equal(metadata.task_title, result.task.title);
  assert.equal(metadata.origin, 'manual');
});

test('createTaskWithConversation stores task creation memory with task background', () => {
  const { projectId, roomId } = insertProjectAndRoom();
  const source = insertStandaloneMessage(roomId);
  const result = createTaskWithConversation({
    roomId,
    origin: 'manual',
    sourceMessageId: source.id,
    taskInput: {
      title: '优化构建速度',
      description: '记录 Vite 大 chunk 警告并拆分依赖。',
      priority: 'high',
    },
  });

  const memories = memoryRepo.list({
    projectId,
    roomId,
    taskId: result.task.id,
  });
  const taskMemory = memories.find((memory) => memory.source_type === 'task' && memory.source_id === `created:${result.task.id}`);

  assert.ok(taskMemory);
  assert.equal(taskMemory.scope, 'task');
  assert.equal(taskMemory.memory_type, 'task_summary');
  assert.equal(taskMemory.title, '任务创建：优化构建速度');
  assert.match(taskMemory.content, /任务：优化构建速度/);
  assert.match(taskMemory.content, /描述：记录 Vite 大 chunk 警告并拆分依赖。/);
  assert.match(taskMemory.content, /来源：manual/);
  assert.match(taskMemory.content, /来源消息：existing message/);
});

test('createTaskWithConversation replays existing task for the same source message', () => {
  const { roomId } = insertProjectAndRoom();
  const source = insertStandaloneMessage(roomId);

  const first = createTaskWithConversation({
    roomId,
    origin: 'slash_command',
    sourceMessageId: source.id,
    taskInput: { title: '从命令创建任务' },
  });
  const taskCountAfterFirst = db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE room_id = ?').get(roomId) as {
    count: number;
  };
  const messageCountAfterFirst = db.prepare('SELECT COUNT(*) AS count FROM messages WHERE room_id = ?').get(roomId) as {
    count: number;
  };

  const replayed = createTaskWithConversation({
    roomId,
    origin: 'slash_command',
    sourceMessageId: source.id,
    taskInput: { title: '从命令创建任务' },
  });

  const taskCountAfterReplay = db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE room_id = ?').get(roomId) as {
    count: number;
  };
  const messageCountAfterReplay = db.prepare('SELECT COUNT(*) AS count FROM messages WHERE room_id = ?').get(roomId) as {
    count: number;
  };
  assert.equal(replayed.task.id, first.task.id);
  assert.equal(replayed.userMessage, null);
  assert.equal(replayed.systemMessage.id, first.systemMessage.id);
  assert.equal(taskCountAfterReplay.count, taskCountAfterFirst.count);
  assert.equal(messageCountAfterReplay.count, messageCountAfterFirst.count);
});

test('createTaskCreationMemorySafely ignores duplicate task creation memory source', () => {
  const { projectId, roomId } = insertProjectAndRoom();
  const taskId = 'duplicate-memory-task';
  const ts = Date.now();
  db.prepare(
    `INSERT INTO tasks (
      id, project_id, room_id, parent_task_id, title, description, status, priority,
      interaction_mode, assigned_agent_id, source_message_id, created_from, created_at, updated_at
    )
     VALUES (?, ?, ?, NULL, 'existing task', NULL, 'todo', 'normal', 'ask_user', NULL, NULL, 'manual', ?, ?)`,
  ).run(taskId, projectId, roomId, ts, ts);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as import('./types.js').Task;

  createTaskCreationMemorySafely({
    projectId,
    roomId,
    task,
    origin: 'manual',
    sourceMessageContent: 'first source message',
  });

  assert.doesNotThrow(() =>
    createTaskCreationMemorySafely({
      projectId,
      roomId,
      task,
      origin: 'manual',
      sourceMessageContent: 'duplicate source message',
    }),
  );
});

test('recordTaskEvent persists workflow metadata on a system message', () => {
  const { roomId } = insertProjectAndRoom();
  const task = createTaskWithConversation({
    roomId,
    origin: 'slash_command',
    taskInput: { title: '补充测试' },
  }).task;

  const message = recordTaskEvent({
    roomId,
    taskId: task.id,
    taskTitle: task.title,
    workflowRunId: 'workflow-1',
    workflowStepId: 'step-1',
    eventType: 'workflow_stage_changed',
    content: '任务进入分析阶段',
  });

  const metadata = JSON.parse(message.metadata ?? '{}') as Record<string, unknown>;
  assert.equal(metadata.task_id, task.id);
  assert.equal(metadata.workflow_run_id, 'workflow-1');
  assert.equal(metadata.workflow_step_id, 'step-1');
  assert.equal(metadata.event_type, 'workflow_stage_changed');
});

test('createTaskWithConversation rejects unknown source message', () => {
  const { roomId } = insertProjectAndRoom();
  assert.throws(
    () =>
      createTaskWithConversation({
        roomId,
        origin: 'manual',
        sourceMessageId: 'missing-message-id',
        taskInput: { title: '无效来源消息' },
      }),
    /source message not found/,
  );
});

test('createTaskWithConversation rejects source message from another room', () => {
  const { roomId } = insertProjectAndRoom();
  const { roomId: otherRoomId } = insertProjectAndRoom();
  const source = insertStandaloneMessage(otherRoomId);
  assert.throws(
    () =>
      createTaskWithConversation({
        roomId,
        origin: 'manual',
        sourceMessageId: source.id,
        taskInput: { title: '跨房间来源消息' },
      }),
    /source message room mismatch/,
  );
});

test('createTaskWithConversation rejects empty source message id', () => {
  const { roomId } = insertProjectAndRoom();
  assert.throws(
    () =>
      createTaskWithConversation({
        roomId,
        origin: 'manual',
        sourceMessageId: '   ',
        taskInput: { title: '空来源消息' },
      }),
    /source message id is empty/,
  );
});
