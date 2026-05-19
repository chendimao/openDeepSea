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

test('POST /rooms/:roomId/collaborations creates a collaboration run and triggers execution', async () => {
  const { project, room, message, decision } = createCollaborationFixture('create-collaboration');
  const calls: unknown[] = [];
  setCollaborationRouteDeps({
    runCollaborationStages: async (input) => {
      calls.push(input);
      return {
        id: input.runId,
        room_id: input.roomId,
        source_message_id: input.sourceMessage.id,
        status: 'completed',
        steps: [],
        error: null,
        started_at: Date.now(),
        completed_at: Date.now(),
      };
    },
  });

  const res = await request(`/api/rooms/${room.id}/collaborations`, {
    method: 'POST',
    body: JSON.stringify({
      source_message_id: message.id,
      decision,
    }),
  });

  assert.equal(res.status, 202);
  const body = await res.json() as {
    run: { id: string; room_id: string; source_message_id: string; status: string };
  };
  assert.equal(body.run.room_id, room.id);
  assert.equal(body.run.source_message_id, message.id);
  assert.equal(body.run.status, 'running');
  assert.equal(calls.length, 1);
  const call = calls[0] as {
    runId: string;
    projectPath: string;
    roomId: string;
    sourceMessage: { id: string };
    decision: typeof decision;
  };
  assert.equal(call.runId, body.run.id);
  assert.equal(call.projectPath, project.path);
  assert.equal(call.roomId, room.id);
  assert.equal(call.sourceMessage.id, message.id);
  assert.deepEqual(call.decision, decision);
});

test('POST /rooms/:roomId/collaborations is idempotent for the same source message', async () => {
  const { room, message, decision } = createCollaborationFixture('collaboration-idempotent');
  const calls: unknown[] = [];
  setCollaborationRouteDeps({
    runCollaborationStages: async (input) => {
      calls.push(input);
      return {
        id: input.runId,
        room_id: input.roomId,
        source_message_id: input.sourceMessage.id,
        status: 'completed',
        steps: [],
        error: null,
        started_at: Date.now(),
        completed_at: Date.now(),
      };
    },
  });

  const first = await request(`/api/rooms/${room.id}/collaborations`, {
    method: 'POST',
    body: JSON.stringify({
      source_message_id: message.id,
      decision,
    }),
  });
  const second = await request(`/api/rooms/${room.id}/collaborations`, {
    method: 'POST',
    body: JSON.stringify({
      source_message_id: message.id,
      decision,
    }),
  });

  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  const firstBody = await first.json() as {
    run: { id: string; room_id: string; source_message_id: string; status: string };
  };
  const secondBody = await second.json() as {
    run: { id: string; room_id: string; source_message_id: string; status: string };
  };
  assert.equal(secondBody.run.id, firstBody.run.id);
  assert.equal(secondBody.run.source_message_id, message.id);
  assert.equal(calls.length, 1);
});

test('POST /rooms/:roomId/messages/:messageId/promote-to-workflow creates a task and starts workflow', async () => {
  const { room, message } = createCollaborationFixture('promote');
  const enqueued: string[] = [];
  setWorkflowConversationDeps({
    enqueueGraphWorkflow: (runId) => {
      enqueued.push(runId);
    },
  });

  const res = await request(`/api/rooms/${room.id}/messages/${message.id}/promote-to-workflow`, {
    method: 'POST',
  });

  assert.equal(res.status, 202);
  const body = await res.json() as {
    task: { id: string; source_message_id: string; created_from: string; interaction_mode: string };
    workflow: { id: string; task_id: string; graph_version: string };
  };
  assert.equal(body.task.source_message_id, message.id);
  assert.equal(body.task.created_from, 'chat_plan');
  assert.equal(body.task.interaction_mode, 'ask_user');
  assert.equal(body.workflow.task_id, body.task.id);
  assert.equal(body.workflow.graph_version, 'phase-b-v1');
  assert.deepEqual(enqueued, [body.workflow.id]);

  const task = taskRepo.get(body.task.id);
  assert.equal(task?.title, '实现用户选择接口');
  assert.equal(task?.description, message.content);
  assert.equal(workflowRepo.getRun(body.workflow.id)?.task_id, body.task.id);
});

test('promote-to-workflow returns 404 when source message does not exist', async () => {
  const { room } = createCollaborationFixture('missing-source-message');

  const res = await request(`/api/rooms/${room.id}/messages/missing-message/promote-to-workflow`, {
    method: 'POST',
  });

  assert.equal(res.status, 404);
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

  assert.equal(res.status, 404);
});

test('promote-to-workflow is idempotent for the same source message', async () => {
  const { room, message } = createCollaborationFixture('promote-idempotent');
  const enqueued: string[] = [];
  setWorkflowConversationDeps({
    enqueueGraphWorkflow: (runId) => {
      enqueued.push(runId);
    },
  });

  const first = await request(`/api/rooms/${room.id}/messages/${message.id}/promote-to-workflow`, {
    method: 'POST',
  });
  const second = await request(`/api/rooms/${room.id}/messages/${message.id}/promote-to-workflow`, {
    method: 'POST',
  });

  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  const firstBody = await first.json() as { task: { id: string }; workflow: { id: string } };
  const secondBody = await second.json() as { task: { id: string }; workflow: { id: string } };
  assert.equal(secondBody.task.id, firstBody.task.id);
  assert.equal(secondBody.workflow.id, firstBody.workflow.id);
  assert.equal(taskRepo.listByRoom(room.id).length, 1);
  assert.equal(workflowRepo.listByTask(firstBody.task.id).length, 1);
  assert.deepEqual(enqueued, [firstBody.workflow.id]);
});

test('promote-to-workflow uses original user message as task source and keeps planner background', async () => {
  const { room } = createCollaborationFixture('promote-readiness');
  const original = messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: '实现 ACP 权限派生，自动把业务权限同步到 Codex 权限。',
    message_type: 'text',
  });
  const message = messageRepo.create({
    room_id: room.id,
    sender_type: 'agent',
    sender_id: 'planner',
    sender_name: '产品经理',
    content: '完整方案正文',
    message_type: 'agent_stream',
    metadata: {
      task_readiness: {
        ready: true,
        confidence: 0.9,
        title: '收口 ACP 权限派生',
        description: '以业务权限为主配置源，自动派生 ACP/Codex 权限。',
        missing_questions: [],
        recommended_mode: 'formal_workflow',
        source_message_id: original.id,
      },
    },
  });
  setWorkflowConversationDeps({
    enqueueGraphWorkflow: () => undefined,
  });

  const res = await request(`/api/rooms/${room.id}/messages/${message.id}/promote-to-workflow`, {
    method: 'POST',
  });

  assert.equal(res.status, 202);
  const body = await res.json() as { task: { id: string; source_message_id: string; title: string; description: string } };
  assert.equal(body.task.source_message_id, original.id);
  assert.equal(body.task.title, '实现 ACP 权限派生，自动把业务权限同步到 Codex 权限。');
  assert.match(body.task.description, /实现 ACP 权限派生/);
  assert.match(body.task.description, /产品经理方案背景/);
  assert.match(body.task.description, /以业务权限为主配置源/);
});

test('promote-to-workflow rejects analysis-only readiness without original user source', async () => {
  const { room } = createCollaborationFixture('promote-readiness-intent');
  const message = messageRepo.create({
    room_id: room.id,
    sender_type: 'agent',
    sender_id: 'planner',
    sender_name: '产品经理',
    content: '完整方案正文',
    message_type: 'agent_stream',
    metadata: {
      task_readiness: {
        ready: true,
        confidence: 0.82,
        title: '自动归档规则方案',
        description: '只做产品规则设计，不进入实现。',
        missing_questions: [],
        recommended_mode: 'chat_collaboration',
        execution_intent: 'analysis_only',
      },
    },
  });
  setWorkflowConversationDeps({
    enqueueGraphWorkflow: () => undefined,
  });

  const res = await request(`/api/rooms/${room.id}/messages/${message.id}/promote-to-workflow`, {
    method: 'POST',
  });

  assert.equal(res.status, 400);
  const body = await res.json() as { error: string };
  assert.match(body.error, /analysis-only readiness cannot be promoted/);
});

test('promote-to-workflow keeps analysis-only planner wording out of executable task description', async () => {
  const { room } = createCollaborationFixture('promote-analysis-source');
  const original = messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: '实现自动归档规则，覆盖用户上传文件和智能体生成文档。',
    message_type: 'text',
  });
  const message = messageRepo.create({
    room_id: room.id,
    sender_type: 'agent',
    sender_id: 'planner',
    sender_name: '产品经理',
    content: '本轮只做产品规则设计，不进入实现。',
    message_type: 'agent_stream',
    metadata: {
      task_readiness: {
        ready: true,
        confidence: 0.82,
        title: '自动归档规则方案',
        description: '只做产品规则设计，不进入实现。',
        missing_questions: [],
        recommended_mode: 'chat_collaboration',
        execution_intent: 'analysis_only',
        source_message_id: original.id,
      },
    },
  });
  setWorkflowConversationDeps({
    enqueueGraphWorkflow: () => undefined,
  });

  const res = await request(`/api/rooms/${room.id}/messages/${message.id}/promote-to-workflow`, {
    method: 'POST',
  });

  assert.equal(res.status, 202);
  const body = await res.json() as { task: { source_message_id: string; title: string; description: string } };
  assert.equal(body.task.source_message_id, original.id);
  assert.equal(body.task.title, '实现自动归档规则，覆盖用户上传文件和智能体生成文档。');
  assert.match(body.task.description, /实现自动归档规则/);
  assert.doesNotMatch(body.task.description, /不进入实现/);
  assert.doesNotMatch(body.task.description, /任务意图：analysis_only/);
});

test('promote-to-workflow refreshes replayed source task with latest planner background', async () => {
  const { room } = createCollaborationFixture('promote-refresh-background');
  const original = messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: '细化文件管理功能，区分用户上传文件和智能体生成 md 文档。',
    message_type: 'text',
  });
  const oldTask = taskRepo.create({
    room_id: room.id,
    project_id: room.project_id,
    title: '旧文件管理任务',
    description: '旧描述，没有产品经理方案背景。',
    source_message_id: original.id,
    created_from: 'chat_plan',
  });
  const oldEvent = messageRepo.create({
    room_id: room.id,
    sender_type: 'system',
    sender_id: 'system',
    sender_name: 'System',
    content: '任务已创建',
    message_type: 'system',
    metadata: {
      event_type: 'task_created',
      task_id: oldTask.id,
    },
  });
  assert.ok(oldEvent.id);
  const plannerMessage = messageRepo.create({
    room_id: room.id,
    sender_type: 'agent',
    sender_id: 'planner',
    sender_name: '产品经理',
    content: '实施计划：补充后端来源字段，改造前端文件列表。\n验收标准：文件列表显示来源。',
    message_type: 'agent_stream',
    metadata: {
      task_readiness: {
        ready: true,
        confidence: 0.82,
        title: '文件管理来源细化',
        description: '实施计划：补充后端来源字段，改造前端文件列表。\n验收标准：文件列表显示来源。',
        missing_questions: [],
        recommended_mode: 'formal_workflow',
        execution_intent: 'implementation',
        source_message_id: original.id,
      },
    },
  });
  setWorkflowConversationDeps({
    enqueueGraphWorkflow: () => undefined,
  });

  const res = await request(`/api/rooms/${room.id}/messages/${plannerMessage.id}/promote-to-workflow`, {
    method: 'POST',
  });

  assert.equal(res.status, 202);
  const body = await res.json() as { task: { id: string; description: string }; workflow: { task_id: string } };
  assert.equal(body.task.id, oldTask.id);
  assert.equal(body.workflow.task_id, oldTask.id);
  assert.match(body.task.description, /产品经理方案背景/);
  assert.match(body.task.description, /补充后端来源字段/);
  assert.equal(taskRepo.get(oldTask.id)?.description, body.task.description);
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
