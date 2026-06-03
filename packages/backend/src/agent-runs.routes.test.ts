import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-agent-runs-routes-')), 'test.db');
process.env.OPENCLAW_ACP_MESSAGE_INTENT_CLASSIFIER = '0';
process.env.OPENCLAW_ACP_TASK_ANALYZER = '0';

const express = (await import('express')).default;
const { agentRunRepo } = await import('./repos/agent-runs.js');
const { agentRepo } = await import('./repos/agents.js');
const { messageRepo } = await import('./repos/messages.js');
const { projectRepo } = await import('./repos/projects.js');
const { roomAgentRepo, roomRepo } = await import('./repos/rooms.js');
const { taskRepo } = await import('./repos/tasks.js');
const { router, setMessageRouteDeps } = await import('./routes.js');

const app = express();
app.use(express.json());
app.use('/api', router);

test.afterEach(() => {
  setMessageRouteDeps({});
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

test('POST /agent-runs/:id/retry reruns the failed run without creating a new user message or task', async () => {
  const project = projectRepo.create({
    name: 'Agent run retry',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-agent-run-retry-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = agentRepo.getByAgentId('planner');
  assert.ok(planner);
  const roomAgent = roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: planner.id });
  roomAgentRepo.setAcp(roomAgent.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'bypass',
    acp_writable_dirs: [],
  });
  const userMessage = messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: '创建任务：修复重试',
    message_type: 'text',
  });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '修复重试',
    source_message_id: userMessage.id,
    created_from: 'chat_plan',
  });
  const failed = agentRunRepo.create({
    room_id: room.id,
    room_agent_id: roomAgent.id,
    agent_id: 'planner',
    backend: 'codex',
    status: 'failed',
    acp_session_id: 'session-original',
    task_id: task.id,
    prompt: '继续原任务',
  });
  const userMessagesBefore = messageRepo.listByRoom(room.id).filter((message) => message.sender_type === 'user').length;
  const taskCountBefore = taskRepo.listByRoom(room.id).length;

  const retryInputs: Array<{
    prompt: string;
    taskId?: string | null;
    acpSessionIdOverride?: string | null;
    sourceMessageId?: string | null;
  }> = [];
  setMessageRouteDeps({
    retryAgentRunOnce: async (input) => {
      retryInputs.push({
        prompt: input.prompt,
        taskId: input.taskId,
        acpSessionIdOverride: input.acpSessionIdOverride,
        sourceMessageId: input.sourceMessageId,
      });
      const run = agentRunRepo.updateStatus(
        agentRunRepo.create({
          room_id: input.roomId,
          room_agent_id: input.agent.id,
          agent_id: input.agent.agent_id,
          backend: 'codex',
          status: 'running',
          acp_session_id: input.acpSessionIdOverride,
          task_id: input.taskId,
          prompt: input.prompt,
        }).id,
        'completed',
        { stdout: 'retry done' },
      );
      assert.ok(run);
      const message = messageRepo.create({
        room_id: input.roomId,
        sender_type: 'agent',
        sender_id: input.agent.agent_id,
        sender_name: input.agent.agent_name,
        content: 'retry done',
        message_type: 'agent_stream',
      });
      return { run, message, status: 'completed' };
    },
  });

  const res = await request(`/api/agent-runs/${failed.id}/retry`, { method: 'POST' });

  assert.equal(res.status, 202);
  const body = await res.json() as { id: string; task_id: string | null; acp_session_id: string | null };
  assert.notEqual(body.id, failed.id);
  assert.equal(body.task_id, task.id);
  assert.equal(body.acp_session_id, 'session-original');
  const capturedRetryInput = retryInputs[0];
  assert.ok(capturedRetryInput);
  assert.ok(capturedRetryInput.prompt.includes('请在当前 ACP 会话中继续原任务'));
  assert.ok(capturedRetryInput.prompt.includes('原始任务提示：'));
  assert.ok(capturedRetryInput.prompt.includes('继续原任务'));
  assert.deepEqual({
    taskId: capturedRetryInput.taskId,
    acpSessionIdOverride: capturedRetryInput.acpSessionIdOverride,
    sourceMessageId: capturedRetryInput.sourceMessageId,
  }, {
    taskId: task.id,
    acpSessionIdOverride: 'session-original',
    sourceMessageId: userMessage.id,
  });
  const userMessagesAfter = messageRepo.listByRoom(room.id).filter((message) => message.sender_type === 'user').length;
  assert.equal(userMessagesAfter, userMessagesBefore);
  assert.equal(taskRepo.listByRoom(room.id).length, taskCountBefore);
});
