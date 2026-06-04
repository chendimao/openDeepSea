import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { SessionAdapter } from './acp/types.js';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-agent-runs-routes-')), 'test.db');
process.env.OPENCLAW_ACP_MESSAGE_INTENT_CLASSIFIER = '0';
process.env.OPENCLAW_ACP_TASK_ANALYZER = '0';

const { adapters } = await import('./acp/index.js');
const express = (await import('express')).default;
const { agentRunRepo } = await import('./repos/agent-runs.js');
const { agentRepo } = await import('./repos/agents.js');
const { messageRepo } = await import('./repos/messages.js');
const { projectRepo } = await import('./repos/projects.js');
const { roomAgentRepo, roomRepo } = await import('./repos/rooms.js');
const { taskEventRepo } = await import('./repos/task-events.js');
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
    prompt: '原始用户需求ABC',
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
  const body = await res.json() as {
    retry_type: 'agent_run';
    run: { id: string; task_id: string | null; acp_session_id: string | null };
  };
  assert.equal(body.retry_type, 'agent_run');
  assert.notEqual(body.run.id, failed.id);
  assert.equal(body.run.task_id, task.id);
  assert.equal(body.run.acp_session_id, 'session-original');
  const capturedRetryInput = retryInputs[0];
  assert.ok(capturedRetryInput);
  assert.ok(capturedRetryInput.prompt.includes('请在当前 ACP 会话中继续原任务'));
  assert.equal(capturedRetryInput.prompt.includes('原始任务提示：'), false);
  assert.equal(capturedRetryInput.prompt.includes('原始用户需求ABC'), false);
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

test('POST /agent-runs/:id/retry rejects duplicate retry while the same task already has an active run', async () => {
  const project = projectRepo.create({
    name: 'Agent run duplicate retry',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-agent-run-duplicate-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = agentRepo.getByAgentId('planner');
  assert.ok(planner);
  const roomAgent = roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: planner.id });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '阻止重复重试',
  });
  const failed = agentRunRepo.create({
    room_id: room.id,
    room_agent_id: roomAgent.id,
    agent_id: 'planner',
    backend: 'codex',
    status: 'failed',
    acp_session_id: 'session-duplicate',
    task_id: task.id,
    prompt: '原始 prompt',
  });
  const active = agentRunRepo.create({
    room_id: room.id,
    room_agent_id: roomAgent.id,
    agent_id: 'planner',
    backend: 'codex',
    status: 'running',
    acp_session_id: 'session-duplicate',
    task_id: task.id,
    prompt: '正在重试',
  });

  const res = await request(`/api/agent-runs/${failed.id}/retry`, { method: 'POST' });

  assert.equal(res.status, 409);
  const body = await res.json() as { error: string; active_run_id?: string };
  assert.match(body.error, /already has an active retry/u);
  assert.equal(body.active_run_id, active.id);
});

test('POST /agent-runs/:id/retry rejects workflow-scoped runs instead of bypassing workflow state', async () => {
  const project = projectRepo.create({
    name: 'Agent run workflow retry',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-agent-run-workflow-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = agentRepo.getByAgentId('planner');
  assert.ok(planner);
  const roomAgent = roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: planner.id });
  const failed = agentRunRepo.create({
    room_id: room.id,
    room_agent_id: roomAgent.id,
    agent_id: 'planner',
    backend: 'codex',
    status: 'failed',
    acp_session_id: 'session-workflow',
    workflow_run_id: 'workflow-1',
    workflow_step_id: 'step-1',
    prompt: 'workflow prompt',
  });

  const res = await request(`/api/agent-runs/${failed.id}/retry`, { method: 'POST' });

  assert.equal(res.status, 409);
  const body = await res.json() as { error: string };
  assert.match(body.error, /workflow run retry/u);
});

test('POST /agent-runs/:id/retry resumes failed task action instead of re-prompting planner', async () => {
  const project = projectRepo.create({
    name: 'Agent run task action retry',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-agent-run-task-action-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = agentRepo.getByAgentId('planner');
  const executor = agentRepo.getByAgentId('frontend-executor');
  assert.ok(planner);
  assert.ok(executor);
  const plannerRoomAgent = roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: planner.id });
  const executorRoomAgent = roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: executor.id });
  roomAgentRepo.setAcp(plannerRoomAgent.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'bypass',
    acp_writable_dirs: [],
  });
  roomAgentRepo.setAcp(executorRoomAgent.id, {
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
    content: '修复 chip 点击变大',
    message_type: 'text',
  });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '修复 chip 点击变大',
    source_message_id: userMessage.id,
    created_from: 'chat_plan',
  });
  messageRepo.mergeMetadata(userMessage.id, { task_id: task.id });
  const failed = agentRunRepo.create({
    room_id: room.id,
    room_agent_id: plannerRoomAgent.id,
    agent_id: 'planner',
    backend: 'codex',
    status: 'failed',
    acp_session_id: 'session-task-action',
    task_id: task.id,
    prompt: 'route skills',
  });
  agentRunRepo.updateStatus(failed.id, 'failed', {
    stdout: [
      '```json',
      JSON.stringify({
        superpowers_routing: {
          next_action: 'systematic_debugging',
          required_skill: 'systematic-debugging',
          reason: '明确 bug，应直接调试',
          recommended_agent_id: 'frontend-executor',
          expected_evidence: ['定位根因并修复'],
          planning_required: false,
        },
      }),
      '```',
    ].join('\n'),
    error: 'ACP prompt timed out',
  });
  taskEventRepo.create({
    room_id: room.id,
    task_id: task.id,
    type: 'task_updated',
    layer: 'timeline',
    source_run_id: failed.id,
    payload: {
      task_action: 'route_skills',
      action: 'route_skills',
      task_action_status: 'failed',
      status: 'failed',
      run_id: failed.id,
      run_ids: [failed.id],
      error: 'ACP prompt timed out',
    },
  });
  let retryAgentRunCalled = false;
  setMessageRouteDeps({
    retryAgentRunOnce: async () => {
      retryAgentRunCalled = true;
      throw new Error('agent-message retry should not run for failed task actions');
    },
  });
  const originalAdapter = adapters.codex;
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      args.onChunk?.({
        stream: 'stdout',
        text: '执行者已从失败 task action 断点继续。\n```json\n{"superpowers":{"debuggingEvidence":"continued from recovered route"}}\n```',
      });
      return { exitCode: 0, sessionId: 'executor-session', stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    const res = await request(`/api/agent-runs/${failed.id}/retry`, { method: 'POST' });

    assert.equal(res.status, 202);
    const body = await res.json() as {
      retry_type: 'task_action';
      result: { action: string; status: string; run_ids: string[] };
    };
    assert.equal(retryAgentRunCalled, false);
    assert.equal(body.retry_type, 'task_action');
    assert.equal(body.result.action, 'auto_advance');
    assert.equal(body.result.status, 'completed');
    assert.equal(body.result.run_ids[0], failed.id);
    const events = taskEventRepo.listByTask(task.id, { layer: 'timeline', limit: 20 });
    assert.ok(events.some((event) =>
      event.payload.task_action === 'route_skills' &&
      event.payload.task_action_status === 'completed' &&
      event.payload.recovered_from_run_id === failed.id
    ));
    assert.ok(events.some((event) =>
      event.payload.task_action === 'auto_advance' &&
      event.payload.task_action_status === 'completed' &&
      event.payload.delegated_action === 'systematic_debugging'
    ));
  } finally {
    adapters.codex = originalAdapter;
  }
});

test('POST /agent-runs/:id/retry keeps non-routing task action failures on agent retry path', async () => {
  const project = projectRepo.create({
    name: 'Agent run phase retry',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-agent-run-phase-retry-project-')),
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
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '写计划失败重试',
  });
  const failed = agentRunRepo.create({
    room_id: room.id,
    room_agent_id: roomAgent.id,
    agent_id: 'planner',
    backend: 'codex',
    status: 'failed',
    acp_session_id: 'session-writing-plans',
    task_id: task.id,
    prompt: 'writing plans',
  });
  taskEventRepo.create({
    room_id: room.id,
    task_id: task.id,
    type: 'task_updated',
    layer: 'timeline',
    source_run_id: failed.id,
    payload: {
      task_action: 'writing_plans',
      action: 'writing_plans',
      task_action_status: 'failed',
      status: 'failed',
      run_id: failed.id,
      run_ids: [failed.id],
      error: 'plan failed',
    },
  });
  let retryAgentRunCalled = false;
  setMessageRouteDeps({
    retryAgentRunOnce: async (input) => {
      retryAgentRunCalled = true;
      const retry = agentRunRepo.updateStatus(
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
        { stdout: 'retry writing plan done' },
      );
      assert.ok(retry);
      return { run: retry };
    },
  });

  const res = await request(`/api/agent-runs/${failed.id}/retry`, { method: 'POST' });

  assert.equal(res.status, 202);
  const body = await res.json() as { retry_type: string; run?: { task_id: string | null } };
  assert.equal(retryAgentRunCalled, true);
  assert.equal(body.retry_type, 'agent_run');
  assert.equal(body.run?.task_id, task.id);
});
