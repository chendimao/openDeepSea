import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-distill-')), 'test.db');

const projectDir = join(tmpdir(), `openclaw-room-distill-project-${Date.now()}`);
mkdirSync(projectDir, { recursive: true });

const { memoryRepo } = await import('../repos/memory.js');
const { messageRepo } = await import('../repos/messages.js');
const { projectRepo } = await import('../repos/projects.js');
const { roomRepo } = await import('../repos/rooms.js');
const { distillFromConversation } = await import('./distill.js');

test('distillFromConversation skips LLM memories while Task 1 has no model distill source', async () => {
  const project = projectRepo.create({ name: 'Distill Memory', path: projectDir });
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
  });

  const memories = memoryRepo.list({ projectId: project.id, roomId: room.id });
  assert.equal(memories.length, 0);
});
