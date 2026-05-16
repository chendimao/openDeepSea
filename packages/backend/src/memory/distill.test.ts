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
const { distillFromConversation } = await import('./distill.js');

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
