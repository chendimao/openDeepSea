import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-collaboration-routes-')), 'test.db');
process.env.LANGGRAPH_WORKFLOW_ENABLED = '1';

const { messageRepo } = await import('./repos/messages.js');
const { projectRepo } = await import('./repos/projects.js');
const { roomAgentRepo, roomRepo } = await import('./repos/rooms.js');
const { taskRepo } = await import('./repos/tasks.js');
const { workflowRepo } = await import('./repos/workflows.js');
const { setCollaborationRouteDeps, router } = await import('./routes.js');
const { setWorkflowConversationDeps } = await import('./workflows/conversation.js');
const express = (await import('express')).default;

const app = express();
app.use(express.json());
app.use('/api', router);

test.afterEach(() => {
  setCollaborationRouteDeps({});
  setWorkflowConversationDeps({});
  process.env.LANGGRAPH_WORKFLOW_ENABLED = '1';
});

test('POST /rooms/:roomId/collaborations is disabled in pure ACP mode', async () => {
  const { room, message, decision } = createCollaborationFixture('create-collaboration');

  const res = await request(`/api/rooms/${room.id}/collaborations`, {
    method: 'POST',
    body: JSON.stringify({
      source_message_id: message.id,
      decision,
    }),
  });

  assert.equal(res.status, 410);
  const body = await res.json() as { error: string };
  assert.match(body.error, /collaborations route is disabled/i);
});

test('POST /rooms/:roomId/messages/:messageId/promote-to-workflow is disabled in pure ACP mode', async () => {
  const { room, message } = createCollaborationFixture('promote');

  const res = await request(`/api/rooms/${room.id}/messages/${message.id}/promote-to-workflow`, {
    method: 'POST',
  });

  assert.equal(res.status, 410);
  const body = await res.json() as { error: string };
  assert.match(body.error, /workflow promotion is disabled/i);
});

test('promote-to-workflow returns 404 when source message does not exist', async () => {
  const { room } = createCollaborationFixture('missing-source-message');

  const res = await request(`/api/rooms/${room.id}/messages/missing-message/promote-to-workflow`, {
    method: 'POST',
  });

  assert.equal(res.status, 410);
});

test('POST /rooms/:roomId/collaborations returns 404 when source message does not exist', async () => {
  const { room, decision } = createCollaborationFixture('missing-collaboration-source');

  const res = await request(`/api/rooms/${room.id}/collaborations`, {
    method: 'POST',
    body: JSON.stringify({
      source_message_id: 'missing-message',
      decision,
    }),
  });

  assert.equal(res.status, 410);
});

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

function createCollaborationFixture(name: string) {
  const projectPath = join(tmpdir(), `openclaw-collaboration-routes-${name}-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: `Collaboration Routes ${name}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: `${name} room` });
  const executor = roomAgentRepo.add({
    room_id: room.id,
    agent_id: `executor-${name}`,
    agent_name: `Executor ${name}`,
    agent_role: 'executor',
  });
  const reviewer = roomAgentRepo.add({
    room_id: room.id,
    agent_id: `reviewer-${name}`,
    agent_name: `Reviewer ${name}`,
    agent_role: 'reviewer',
  });
  const message = messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: '实现用户选择接口',
  });
  const decision = {
    intent: 'implementation' as const,
    recommendedMode: 'formal_workflow' as const,
    problemArea: 'backend' as const,
    summary: '实现用户选择接口',
    rationale: '需要落地后端路由和测试',
    needsUserChoice: true,
    proposedAgents: {
      executors: [executor.agent_id],
      reviewers: [reviewer.agent_id],
      testers: [],
      acceptors: [],
    },
    stages: [
      {
        stage: 'execute' as const,
        agentIds: [executor.agent_id],
        parallel: false,
        goal: '实现接口',
      },
      {
        stage: 'review' as const,
        agentIds: [reviewer.agent_id],
        parallel: false,
        goal: '审查结果',
      },
    ],
  };
  return { project, room, executor, reviewer, message, decision };
}
