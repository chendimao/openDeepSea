import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-collaboration-runner-')), 'test.db');

import type { CollaborationDecision } from './collaboration-decision.js';
import type { CollaborationAgentRunner } from './collaboration-runner.js';
import type { AgentRunStatus, Message, Room, RoomAgent } from './types.js';

const { runCollaborationStages } = await import('./collaboration-runner.js');
const { messageRepo } = await import('./repos/messages.js');
const { projectRepo } = await import('./repos/projects.js');
const { roomAgentRepo, roomRepo } = await import('./repos/rooms.js');

test('frontend collaboration runs executor before reviewer and records step outputs', async () => {
  const fixture = await createFixture('frontend');
  const calls: string[] = [];
  const prompts: Record<string, string> = {};
  const runAgent = createRunnerStub({
    calls,
    prompts,
    outputs: {
      'frontend-executor:execute': '前端实现完成，修改 RoomPage。',
    },
  });

  try {
    const result = await runCollaborationStages({
      runId: 'collab-frontend',
      projectPath: fixture.projectPath,
      roomId: fixture.room.id,
      sourceMessage: fixture.sourceMessage,
      decision: decisionWithStages('frontend', [
        { stage: 'execute', agentIds: ['frontend-executor'], parallel: false, goal: '实现前端' },
        { stage: 'review', agentIds: ['frontend-reviewer'], parallel: false, goal: '审查前端' },
      ]),
      runAgent,
    });

    assert.equal(result.status, 'completed');
    assert.deepEqual(calls, ['frontend-executor:execute', 'frontend-reviewer:review']);
    assert.equal(result.steps.length, 2);
    assert.equal(result.steps[0]?.agent_run_id, 'run-frontend-executor-execute');
    assert.equal(result.steps[0]?.result_message_id, 'msg-frontend-executor-execute');
    assert.equal(result.steps[0]?.result_content, '前端实现完成，修改 RoomPage。');
    assert.equal(result.steps[1]?.agent_run_id, 'run-frontend-reviewer-review');
    assert.equal(result.steps[1]?.result_message_id, 'msg-frontend-reviewer-review');
    assert.match(prompts['frontend-reviewer:review'] ?? '', /前端实现完成，修改 RoomPage。/);
  } finally {
    await fixture.cleanup();
  }
});

test('backend collaboration runs tester after executor', async () => {
  const fixture = await createFixture('backend');
  const calls: string[] = [];
  const runAgent = createRunnerStub({ calls });

  try {
    const result = await runCollaborationStages({
      runId: 'collab-backend',
      projectPath: fixture.projectPath,
      roomId: fixture.room.id,
      sourceMessage: fixture.sourceMessage,
      decision: decisionWithStages('backend', [
        { stage: 'execute', agentIds: ['backend-executor'], parallel: false, goal: '实现后端' },
        { stage: 'review', agentIds: ['backend-tester'], parallel: false, goal: '测试后端' },
      ]),
      runAgent,
    });

    assert.equal(result.status, 'completed');
    assert.deepEqual(calls, ['backend-executor:execute', 'backend-tester:review']);
    assert.equal(result.steps[1]?.agent_run_id, 'run-backend-tester-review');
    assert.equal(result.steps[1]?.result_message_id, 'msg-backend-tester-review');
  } finally {
    await fixture.cleanup();
  }
});

test('fullstack collaboration runs executors in parallel before review and test stages', async () => {
  const fixture = await createFixture('fullstack');
  const started: string[] = [];
  const release: Record<string, () => void> = {};
  const finished: string[] = [];
  const runAgent: CollaborationAgentRunner = async ({ agent, collaborationStage }) => {
    const key = `${agent.agent_id}:${collaborationStage}`;
    started.push(key);
    await new Promise<void>((resolve) => {
      release[key] = resolve;
    });
    finished.push(key);
    return fakeRunResult(agent, collaborationStage, 'completed');
  };

  try {
    const running = runCollaborationStages({
      runId: 'collab-fullstack',
      projectPath: fixture.projectPath,
      roomId: fixture.room.id,
      sourceMessage: fixture.sourceMessage,
      decision: decisionWithStages('fullstack', [
        {
          stage: 'execute',
          agentIds: ['frontend-executor', 'backend-executor'],
          parallel: true,
          goal: '实现前后端',
        },
        {
          stage: 'review',
          agentIds: ['frontend-reviewer', 'backend-tester'],
          parallel: true,
          goal: '审查并测试',
        },
      ]),
      runAgent,
    });

    await waitFor(() =>
      started.includes('frontend-executor:execute') &&
      started.includes('backend-executor:execute')
    );
    assert.deepEqual([...started].sort(), ['backend-executor:execute', 'frontend-executor:execute']);
    release['frontend-executor:execute']?.();
    await delay(10);
    assert.deepEqual([...started].sort(), ['backend-executor:execute', 'frontend-executor:execute']);
    release['backend-executor:execute']?.();

    await waitFor(() =>
      started.includes('frontend-reviewer:review') &&
      started.includes('backend-tester:review')
    );
    assert.ok(finished.includes('frontend-executor:execute'));
    assert.ok(finished.includes('backend-executor:execute'));
    release['frontend-reviewer:review']?.();
    release['backend-tester:review']?.();

    const result = await running;
    assert.equal(result.status, 'completed');
    assert.equal(result.steps.length, 4);
    assert.deepEqual(result.steps.map((step) => step.sort_order), [0, 1, 2, 3]);
  } finally {
    await fixture.cleanup();
  }
});

test('collaboration is blocked when a required stage fails and later stages are skipped', async () => {
  const fixture = await createFixture('blocked');
  const calls: string[] = [];
  const runAgent = createRunnerStub({
    calls,
    statuses: {
      'backend-executor:execute': 'failed',
    },
  });

  try {
    const result = await runCollaborationStages({
      runId: 'collab-blocked',
      projectPath: fixture.projectPath,
      roomId: fixture.room.id,
      sourceMessage: fixture.sourceMessage,
      decision: decisionWithStages('backend', [
        { stage: 'execute', agentIds: ['backend-executor'], parallel: false, goal: '实现后端' },
        { stage: 'review', agentIds: ['backend-tester'], parallel: false, goal: '测试后端' },
      ]),
      runAgent,
    });

    assert.equal(result.status, 'blocked');
    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0]?.status, 'failed');
    assert.match(result.error ?? '', /failed/);
    assert.deepEqual(calls, ['backend-executor:execute']);
  } finally {
    await fixture.cleanup();
  }
});

test('collaboration is blocked when decision has no executable stages', async () => {
  const fixture = await createFixture('empty-stages');
  const calls: string[] = [];
  const runAgent = createRunnerStub({ calls });

  try {
    const emptyStages = await runCollaborationStages({
      runId: 'collab-empty-stages',
      projectPath: fixture.projectPath,
      roomId: fixture.room.id,
      sourceMessage: fixture.sourceMessage,
      decision: decisionWithStages('unknown', []),
      runAgent,
    });
    assert.equal(emptyStages.status, 'blocked');
    assert.match(emptyStages.error ?? '', /no stages/);

    const emptyAgentIds = await runCollaborationStages({
      runId: 'collab-empty-agent-ids',
      projectPath: fixture.projectPath,
      roomId: fixture.room.id,
      sourceMessage: fixture.sourceMessage,
      decision: decisionWithStages('frontend', [
        { stage: 'execute', agentIds: [], parallel: false, goal: '无人执行' },
      ]),
      runAgent,
    });
    assert.equal(emptyAgentIds.status, 'blocked');
    assert.match(emptyAgentIds.error ?? '', /has no agents/);
    assert.deepEqual(calls, []);
  } finally {
    await fixture.cleanup();
  }
});

test('collaboration captures non-Error thrown values as readable step errors', async () => {
  const fixture = await createFixture('throw-string');
  const stringThrower: CollaborationAgentRunner = async () => {
    throw 'string failure';
  };
  const undefinedThrower: CollaborationAgentRunner = async () => {
    throw undefined;
  };

  try {
    const result = await runCollaborationStages({
      runId: 'collab-throw-string',
      projectPath: fixture.projectPath,
      roomId: fixture.room.id,
      sourceMessage: fixture.sourceMessage,
      decision: decisionWithStages('backend', [
        { stage: 'execute', agentIds: ['backend-executor'], parallel: false, goal: '实现后端' },
      ]),
      runAgent: stringThrower,
    });

    assert.equal(result.status, 'blocked');
    assert.equal(result.steps[0]?.error, 'string failure');

    const undefinedResult = await runCollaborationStages({
      runId: 'collab-throw-undefined',
      projectPath: fixture.projectPath,
      roomId: fixture.room.id,
      sourceMessage: fixture.sourceMessage,
      decision: decisionWithStages('backend', [
        { stage: 'execute', agentIds: ['backend-executor'], parallel: false, goal: '实现后端' },
      ]),
      runAgent: undefinedThrower,
    });
    assert.equal(undefinedResult.status, 'blocked');
    assert.equal(undefinedResult.steps[0]?.error, 'undefined');
  } finally {
    await fixture.cleanup();
  }
});

test('default runner persists collaboration context on agent_runs and keeps workflow fields empty', async () => {
  const fixture = await createFixture('default-runner');
  const originalAdapter = adapters.codex;
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      args.onChunk?.({ stream: 'stdout', text: 'agent result' });
      return { exitCode: 0, sessionId: null, stderr: '' };
    },
  };

  try {
    const result = await runCollaborationStages({
      runId: 'collab-default',
      projectPath: fixture.projectPath,
      roomId: fixture.room.id,
      sourceMessage: fixture.sourceMessage,
      decision: decisionWithStages('frontend', [
        { stage: 'execute', agentIds: ['frontend-executor'], parallel: false, goal: '实现前端' },
      ]),
    });

    const run = agentRunRepo.get(result.steps[0]?.agent_run_id ?? '');
    assert.equal(run?.task_id, null);
    assert.equal(run?.workflow_run_id, null);
    assert.equal(run?.workflow_step_id, null);
    assert.equal(run?.workflow_stage, null);
    assert.equal(run?.collaboration_run_id, 'collab-default');
    assert.equal(run?.collaboration_stage, 'execute');
  } finally {
    adapters.codex = originalAdapter;
    await fixture.cleanup();
  }
});

const { adapters } = await import('./acp/index.js');
const { agentRunRepo } = await import('./repos/agent-runs.js');

function createRunnerStub(args: {
  calls: string[];
  statuses?: Record<string, AgentRunStatus>;
  outputs?: Record<string, string>;
  prompts?: Record<string, string>;
}): CollaborationAgentRunner {
  return async ({ agent, collaborationStage, prompt }) => {
    const key = `${agent.agent_id}:${collaborationStage}`;
    args.calls.push(key);
    if (args.prompts) args.prompts[key] = prompt;
    return fakeRunResult(agent, collaborationStage, args.statuses?.[key] ?? 'completed', args.outputs?.[key]);
  };
}

function fakeRunResult(agent: RoomAgent, stage: string, status: AgentRunStatus, output = 'ok') {
  return {
    run: {
      id: `run-${agent.agent_id}-${stage}`,
      room_id: agent.room_id,
      room_agent_id: agent.id,
      agent_id: agent.agent_id,
      backend: 'codex' as const,
      status,
      session_key: null,
      acp_session_id: null,
      task_id: null,
      workflow_run_id: null,
      workflow_step_id: null,
      workflow_stage: null,
      collaboration_run_id: 'stub-collaboration',
      collaboration_stage: stage as never,
      prompt: '',
      stdout: status === 'completed' ? output : '',
      stderr: status === 'completed' ? '' : 'failed',
      activity_log: '',
      error: status === 'completed' ? null : 'failed',
      started_at: Date.now(),
      updated_at: Date.now(),
      completed_at: Date.now(),
    },
    message: createFakeMessage(agent, stage, output),
    status,
  };
}

function createFakeMessage(agent: RoomAgent, stage: string, output = 'ok'): Message {
  return {
    id: `msg-${agent.agent_id}-${stage}`,
    room_id: agent.room_id,
    sender_type: 'agent',
    sender_id: agent.agent_id,
    sender_name: agent.agent_name,
    content: output,
    message_type: 'agent_stream',
    metadata: null,
    created_at: Date.now(),
  };
}

async function createFixture(name: string): Promise<{
  projectPath: string;
  room: Room;
  sourceMessage: Message;
  cleanup: () => Promise<void>;
}> {
  const projectPath = await mkdtemp(join(tmpdir(), `openclaw-collaboration-${name}-`));
  const project = projectRepo.create({ name: `collaboration-${name}-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  for (const agentId of ['frontend-executor', 'frontend-reviewer', 'backend-executor', 'backend-tester']) {
    const agent = roomAgentRepo.add({ room_id: room.id, agent_id: agentId, agent_name: agentId });
    roomAgentRepo.setAcp(agent.id, {
      acp_enabled: true,
      acp_backend: 'codex',
      acp_session_id: null,
      acp_session_label: null,
      acp_permission_mode: 'bypass',
      acp_writable_dirs: [],
    });
  }
  const sourceMessage = messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: '请协作修复问题',
    message_type: 'text',
  });
  return {
    projectPath,
    room,
    sourceMessage,
    cleanup: () => rm(projectPath, { recursive: true, force: true }),
  };
}

function decisionWithStages(
  problemArea: CollaborationDecision['problemArea'],
  stages: CollaborationDecision['stages'],
): CollaborationDecision {
  return {
    intent: 'implementation',
    recommendedMode: 'formal_workflow',
    problemArea,
    summary: '需要协作实现',
    rationale: '测试决策',
    needsUserChoice: true,
    proposedAgents: {
      executors: ['frontend-executor', 'backend-executor'],
      reviewers: ['frontend-reviewer'],
      testers: ['backend-tester'],
      acceptors: [],
    },
    stages,
  };
}

async function waitFor(assertion: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (assertion()) return;
    await delay(10);
  }
  assert.ok(assertion(), 'condition did not become true before timeout');
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
