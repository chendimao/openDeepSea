import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-distill-')), 'test.db');

const { memoryRepo } = await import('../repos/memory.js');
const { messageRepo } = await import('../repos/messages.js');
const { projectRepo } = await import('../repos/projects.js');
const { roomRepo } = await import('../repos/rooms.js');
const { taskRepo } = await import('../repos/tasks.js');
const { sanitizeModelErrorMessage } = await import('../chat-model.js');
const { distillFromConversation, distillFromTask } = await import('./distill.js');

test('distillFromConversation stores candidates from model text', async () => {
  const project = projectRepo.create({ name: 'Distill Memory', path: createProjectDir() });
  const room = roomRepo.create({ project_id: project.id, name: 'Distill Room' });
  messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: '以后所有提交说明都用中文动词开头。',
  });
  const reply = messageRepo.create({
    room_id: room.id,
    sender_type: 'agent',
    sender_id: 'pm',
    sender_name: '产品经理',
    content: '确认，后续提交说明会使用中文动词开头。',
  });

  await distillFromConversation({
    projectId: project.id,
    roomId: room.id,
    triggerMessageId: reply.id,
    modelInvoker: async (prompt) => {
      assert.match(prompt, /以后所有提交说明都用中文动词开头/);
      return JSON.stringify([
        { scope: 'room', memory_type: 'preference', title: '中文提交说明', content: '提交说明使用中文动词开头。' },
      ]);
    },
  });

  const memories = memoryRepo.list({ projectId: project.id, roomId: room.id });
  const created = memories.find((memory) => memory.title === '中文提交说明');
  assert.ok(created);
  assert.equal(created.scope, 'room');
  assert.equal(created.memory_type, 'preference');
  assert.equal(created.source_type, 'message');
  assert.equal(created.source_id, `${reply.id}#distill-1`);
});

test('distillFromConversation appends skill context after memory extraction rules', async () => {
  const project = projectRepo.create({ name: 'Distill Skill Context', path: createProjectDir() });
  const room = roomRepo.create({ project_id: project.id, name: 'Distill Skill Context Room' });
  messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: '请记住使用内置 skills。',
  });
  const reply = messageRepo.create({
    room_id: room.id,
    sender_type: 'agent',
    sender_id: 'assistant',
    sender_name: 'Assistant',
    content: '确认。',
  });
  let capturedPrompt = '';

  await distillFromConversation({
    projectId: project.id,
    roomId: room.id,
    triggerMessageId: reply.id,
    skillContext: 'OpenDeepSea active skills for this runtime:\nSkill: memory-skill',
    modelInvoker: async (prompt) => {
      capturedPrompt = prompt;
      return '[]';
    },
  });

  assert.match(capturedPrompt, /仅提取新的、有价值的信息/);
  assert.match(capturedPrompt, /Skill: memory-skill/);
  assert.ok(capturedPrompt.indexOf('仅提取新的、有价值的信息') < capturedPrompt.indexOf('Skill: memory-skill'));
});

test('distillFromConversation skips when model is not configured', async () => {
  const restoreEnv = clearModelEnv();
  const project = projectRepo.create({ name: 'Distill Missing Model', path: createProjectDir() });
  const room = roomRepo.create({ project_id: project.id, name: 'Distill Missing Model Room' });
  messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: 'Codex ACP 可以回复。',
  });
  const reply = messageRepo.create({
    room_id: room.id,
    sender_type: 'agent',
    sender_id: 'pm',
    sender_name: '产品经理',
    content: '确认，Codex ACP 已可用。',
  });

  try {
    await distillFromConversation({
      projectId: project.id,
      roomId: room.id,
      triggerMessageId: reply.id,
    });
  } finally {
    restoreEnv();
  }

  const memories = memoryRepo.list({ projectId: project.id, roomId: room.id });
  assert.equal(memories.length, 0);
});

test('distillFromTask stores candidates from model text', async () => {
  const { project, room, task } = createTaskDistillContext('Task Distill Stores');

  await distillFromTask({
    projectId: project.id,
    roomId: room.id,
    taskId: task.id,
    taskTitle: task.title,
    taskSummary: '验收通过，保留模型配置复用决策。',
    sourceId: 'workflow-task-distill-stores',
    modelInvoker: async (prompt) => {
      assert.match(prompt, /Task Distill Stores/);
      return JSON.stringify([
        { scope: 'project', memory_type: 'decision', title: '复用模型配置', content: '记忆蒸馏复用 LangChain planner 模型配置。' },
        { scope: 'room', memory_type: 'lesson', title: '任务蒸馏完成', content: '任务完成后可从完整对话提取经验。' },
      ]);
    },
  });

  const memories = memoryRepo.list({ projectId: project.id, roomId: room.id, taskId: task.id, includeArchived: true });
  const projectMemory = memories.find((memory) => memory.title === '复用模型配置');
  const taskMemory = memories.find((memory) => memory.title === '任务蒸馏完成');
  assert.ok(projectMemory);
  assert.equal(projectMemory.scope, 'project');
  assert.equal(projectMemory.room_id, null);
  assert.equal(projectMemory.task_id, null);
  assert.equal(projectMemory.source_id, 'workflow-task-distill-stores#distill-1');
  assert.ok(taskMemory);
  assert.equal(taskMemory.scope, 'task');
  assert.equal(taskMemory.room_id, room.id);
  assert.equal(taskMemory.task_id, task.id);
  assert.equal(taskMemory.source_id, 'workflow-task-distill-stores#distill-2');
});

test('distillFromTask appends skill context after task extraction rules', async () => {
  const { project, room, task } = createTaskDistillContext('Task Distill Skill Context');
  let capturedPrompt = '';

  await distillFromTask({
    projectId: project.id,
    roomId: room.id,
    taskId: task.id,
    taskTitle: task.title,
    taskSummary: '任务完成。',
    sourceId: 'workflow-task-distill-skill-context',
    skillContext: 'OpenDeepSea active skills for this runtime:\nSkill: task-memory-skill',
    modelInvoker: async (prompt) => {
      capturedPrompt = prompt;
      return '[]';
    },
  });

  assert.match(capturedPrompt, /提取架构决策/);
  assert.match(capturedPrompt, /Skill: task-memory-skill/);
  assert.ok(capturedPrompt.indexOf('提取架构决策') < capturedPrompt.indexOf('Skill: task-memory-skill'));
});

test('distillFromTask ignores malformed model JSON without writing memory', async () => {
  const { project, room, task } = createTaskDistillContext('Task Distill Bad JSON');

  await distillFromTask({
    projectId: project.id,
    roomId: room.id,
    taskId: task.id,
    taskTitle: task.title,
    taskSummary: '坏 JSON 不应写入。',
    sourceId: 'workflow-task-distill-bad-json',
    modelInvoker: async () => 'not json',
  });

  const memories = memoryRepo.list({ projectId: project.id, roomId: room.id, taskId: task.id, includeArchived: true });
  assert.equal(memories.length, 0);
});

test('distillFromTask skips duplicate source conflicts without throwing', async () => {
  const { project, room, task } = createTaskDistillContext('Task Distill Duplicate Source');
  const raw = JSON.stringify([
    { scope: 'room', memory_type: 'fact', title: '重复来源', content: '同一 workflow source 重放时跳过冲突。' },
  ]);
  const debugMessages: string[] = [];
  const originalDebug = console.debug;
  console.debug = (message?: unknown) => {
    debugMessages.push(String(message));
  };

  try {
    await distillFromTask({
      projectId: project.id,
      roomId: room.id,
      taskId: task.id,
      taskTitle: task.title,
      taskSummary: '第一次写入。',
      sourceId: 'workflow-task-distill-duplicate',
      modelInvoker: async () => raw,
    });
    await distillFromTask({
      projectId: project.id,
      roomId: room.id,
      taskId: task.id,
      taskTitle: task.title,
      taskSummary: '重放写入。',
      sourceId: 'workflow-task-distill-duplicate',
      modelInvoker: async () => raw,
    });
  } finally {
    console.debug = originalDebug;
  }

  const memories = memoryRepo.list({ projectId: project.id, roomId: room.id, taskId: task.id, includeArchived: true });
  assert.equal(memories.filter((memory) => memory.title === '重复来源').length, 1);
  assert.ok(debugMessages.some((message) => message.includes('duplicate memory source')));
  assert.doesNotMatch(debugMessages.join('\n'), /UNIQUE constraint|idx_memory|memory_entries/);
});

test('distillFromConversation warns non-source-conflict create errors with sanitized message', async () => {
  const { room } = createTaskDistillContext('Conversation Create Error');
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };

  try {
    await distillFromConversation({
      projectId: 'sk-invalid-project-secret123456',
      roomId: room.id,
      triggerMessageId: 'trigger-create-error',
      modelInvoker: async () => JSON.stringify([
        { scope: 'room', memory_type: 'fact', title: '不会写入', content: 'project 无效时应该 warning。' },
      ]),
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.ok(warnings.some((message) => message.includes('failed to store conversation candidate')));
  assert.doesNotMatch(warnings.join('\n'), /sk-invalid-project-secret/);
});

test('sanitizeModelErrorMessage redacts credentials from model errors', () => {
  const sanitized = sanitizeModelErrorMessage(
    new Error('Authorization: Bearer sk-live-secret1234567890 failed with api_key=sk-second-secret0987654321'),
  );

  assert.doesNotMatch(sanitized, /sk-live-secret/);
  assert.doesNotMatch(sanitized, /sk-second-secret/);
  assert.doesNotMatch(sanitized, /Bearer\s+\S+/);
  assert.doesNotMatch(sanitized, /api_key=/);
  assert.match(sanitized, /\[REDACTED_CREDENTIAL\]/);
});

function clearModelEnv(): () => void {
  const original = {
    LANGCHAIN_PLANNER_MODEL: process.env.LANGCHAIN_PLANNER_MODEL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  };
  delete process.env.LANGCHAIN_PLANNER_MODEL;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  return () => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function createProjectDir(): string {
  const path = join(tmpdir(), `openclaw-room-distill-project-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(path, { recursive: true });
  return path;
}

function createTaskDistillContext(name: string) {
  const project = projectRepo.create({ name, path: createProjectDir() });
  const room = roomRepo.create({ project_id: project.id, name: `${name} Room` });
  const task = taskRepo.create({
    project_id: project.id,
    room_id: room.id,
    title: name,
    description: 'Exercise task distill.',
  });
  messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: '请完成任务并总结经验。',
  });
  messageRepo.create({
    room_id: room.id,
    sender_type: 'agent',
    sender_id: 'executor',
    sender_name: 'Executor',
    content: '已完成实现，复用模型配置。',
  });
  messageRepo.create({
    room_id: room.id,
    sender_type: 'agent',
    sender_id: 'reviewer',
    sender_name: 'Reviewer',
    content: '验收通过，可以写入任务记忆。',
  });
  return { project, room, task };
}
