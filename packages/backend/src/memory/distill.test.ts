import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-distill-')), 'test.db');

const projectDir = join(tmpdir(), `openclaw-room-distill-project-${Date.now()}`);
mkdirSync(projectDir, { recursive: true });

const { gatewayClient } = await import('../openclaw/gateway.js');
const { memoryRepo } = await import('../repos/memory.js');
const { messageRepo } = await import('../repos/messages.js');
const { projectRepo } = await import('../repos/projects.js');
const { roomRepo } = await import('../repos/rooms.js');
const { distillFromConversation } = await import('./distill.js');

test('distillFromConversation stores candidates from gateway final text', async () => {
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

  const original = {
    connect: gatewayClient.connect.bind(gatewayClient),
    listAgents: gatewayClient.listAgents.bind(gatewayClient),
    spawnSession: gatewayClient.spawnSession.bind(gatewayClient),
    sendToAgent: gatewayClient.sendToAgent.bind(gatewayClient),
    onEvent: gatewayClient.onEvent.bind(gatewayClient),
  };
  let handler: ((event: { event: string; payload: unknown }) => void) | null = null;

  gatewayClient.connect = async () => {};
  gatewayClient.listAgents = async () => [{ id: 'distiller', name: 'Distiller' }];
  gatewayClient.spawnSession = async () => ({});
  gatewayClient.onEvent = (nextHandler) => {
    handler = nextHandler;
    return () => {
      handler = null;
    };
  };
  gatewayClient.sendToAgent = async () => {
    queueMicrotask(() => {
      handler?.({
        event: 'chat',
        payload: {
          sessionKey: `system:distill:room-${room.id}`,
          runId: 'run-1',
          state: 'final',
          text: JSON.stringify([
            {
              scope: 'project',
              memory_type: 'preference',
              title: '提交说明偏好',
              content: '用户希望所有提交说明都用中文动词开头。',
            },
          ]),
        },
      });
    });
    return { runId: 'run-1', status: 'running' };
  };

  try {
    await distillFromConversation({
      projectId: project.id,
      roomId: room.id,
      triggerMessageId: reply.id,
    });
  } finally {
    gatewayClient.connect = original.connect;
    gatewayClient.listAgents = original.listAgents;
    gatewayClient.spawnSession = original.spawnSession;
    gatewayClient.sendToAgent = original.sendToAgent;
    gatewayClient.onEvent = original.onEvent;
  }

  const memories = memoryRepo.list({ projectId: project.id, roomId: room.id });
  assert.equal(memories.length, 1);
  assert.equal(memories[0]?.scope, 'project');
  assert.equal(memories[0]?.memory_type, 'preference');
  assert.equal(memories[0]?.title, '提交说明偏好');
  assert.equal(memories[0]?.source_type, 'message');
  assert.equal(memories[0]?.source_id, reply.id);
});
