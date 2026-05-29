import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-dispatch-')), 'test.db');

import type { SessionAdapter } from './acp/types.js';
import type { Message, MessageMetadata } from './types.js';

const { adapters } = await import('./acp/index.js');
const { agentRunRepo } = await import('./repos/agent-runs.js');
const { db } = await import('./db.js');
const { memoryRepo } = await import('./repos/memory.js');
const { messageRepo } = await import('./repos/messages.js');
const { agentRepo } = await import('./repos/agents.js');
const { projectRepo } = await import('./repos/projects.js');
const { roomAgentRepo, roomRepo } = await import('./repos/rooms.js');
const { settingsRepo } = await import('./repos/settings.js');
const { skillRepo } = await import('./skills/repo.js');
const { taskRepo } = await import('./repos/tasks.js');
const { taskEventRepo } = await import('./repos/task-events.js');
const { workflowRepo } = await import('./repos/workflows.js');
const { resourceAssetRepo } = await import('./repos/resource-assets.js');
const { messageUploadDir } = await import('./uploads.js');
const { wsHub } = await import('./ws-hub.js');
const {
  buildAgentIdentityPrompt,
  buildPromptWithMessageAttachments,
  dispatchUserMessage,
  runAgentOnce,
  respondAsAgent,
  setPlannerExecutionPlanInvokerForTest,
} = await import('./dispatcher.js');
const { router } = await import('./routes.js');
const { setWorkflowConversationDeps } = await import('./workflows/conversation.js');
const express = (await import('express')).default;

const app = express();
app.use(express.json());
app.use('/api', router);

test.afterEach(() => {
  process.env.LANGGRAPH_WORKFLOW_ENABLED = '0';
  setWorkflowConversationDeps({});
  setPlannerExecutionPlanInvokerForTest(undefined);
});

test('buildPromptWithMessageAttachments appends readable attachment context', () => {
  const message = createMessage({
    attachments: [
      {
        id: 'att-1',
        name: 'screen.png',
        mimeType: 'image/png',
        size: 576448,
        url: '/uploads/messages/stored.png',
        isImage: true,
      },
    ],
  });

  const prompt = buildPromptWithMessageAttachments('能识别当前对话的图片吗', message);

  assert.match(prompt, /能识别当前对话的图片吗/);
  assert.match(prompt, /消息附件：/);
  assert.match(prompt, /screen\.png/);
  assert.match(prompt, /mimeType=image\/png/);
  assert.match(prompt, /kind=image/);
  assert.match(prompt, new RegExp(`localPath=${escapeRegExp(messageUploadDir)}/stored\\.png`));
});

test('dispatchUserMessage reports non-ACP agent as not executable', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-no-gateway-test-'));
  const project = projectRepo.create({ name: `no-gateway-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const agent = roomAgentRepo.add({
    room_id: room.id,
    agent_id: 'legacy',
    agent_name: 'LegacyAgent',
  });
  const userMessage = messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: `@${agent.agent_name} hello`,
    message_type: 'text',
  });

  try {
    await dispatchUserMessage({
      roomId: room.id,
      userMessage,
      mentionedAgentRoomIds: [agent.id],
    });

    const messages = messageRepo.listByRoom(room.id, 20);
    assert.ok(
      messages.some((message) => message.content.includes('no ACP backend configured')),
      'expected readable system message for non-ACP agent',
    );
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('legacy fallback_route data is normalized to planner fallback reply during dispatch', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-legacy-fallback-route-'));
  const project = projectRepo.create({ name: `legacy-fallback-route-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room', ensureDefaultPlanner: false });
  const planner = roomAgentRepo.listByRoom(room.id).find((agent) => agent.agent_id === 'planner');
  assert.ok(planner);
  roomAgentRepo.setAcp(planner.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'bypass',
    acp_writable_dirs: [],
  });
  db.prepare('UPDATE settings SET message_routing_mode = ?, fallback_agent_id = NULL WHERE scope = ? AND scope_id = ?')
    .run('fallback_route', 'project', project.id);
  const userMessage = messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: '请先帮我拆解一下',
    message_type: 'text',
  });

  const originalAdapter = adapters.codex;
  let invokeCount = 0;
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      invokeCount += 1;
      args.onChunk?.({ stream: 'stdout', text: '收到，先规划。' });
      return { exitCode: 0, sessionId: null, stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    await dispatchUserMessage({ roomId: room.id, userMessage });

    const runs = agentRunRepo.listByRoom(room.id, 20);
    const resolution = settingsRepo.resolveForProject(project.id);
    assert.equal(invokeCount, 1);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.agent_id, 'planner');
    assert.equal(resolution?.effective.message_routing_mode, 'fallback_reply');
    assert.equal(resolution?.effective.fallback_agent_id, 'planner');
    assert.equal(
      messageRepo.listByRoom(room.id, 20).some((message) => {
        const metadata = message.metadata ? JSON.parse(message.metadata) as Record<string, unknown> : {};
        return metadata.event_type === 'collaboration_decision';
      }),
      false,
    );
    assert.ok(messageRepo.listByRoom(room.id, 20).some((message) =>
      message.sender_id === 'planner' &&
      message.message_type === 'agent_stream' &&
      message.content.includes('收到，先规划。'),
    ));
  } finally {
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('explicit mentions still dispatch directly to mentioned agent in fallback reply mode', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-fallback-reply-explicit-mention-'));
  const project = projectRepo.create({ name: `fallback-reply-explicit-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = roomAgentRepo.listByRoom(room.id).find((agent) => agent.agent_id === 'planner');
  const reviewer = roomAgentRepo.add({ room_id: room.id, agent_id: 'reviewer-explicit', agent_name: 'ReviewerExplicit' });
  assert.ok(planner);
  for (const agent of [planner, reviewer]) {
    roomAgentRepo.setAcp(agent.id, {
      acp_enabled: true,
      acp_backend: 'codex',
      acp_session_id: null,
      acp_session_label: null,
      acp_permission_mode: 'bypass',
      acp_writable_dirs: [],
    });
  }
  settingsRepo.updateProject(project.id, {
    message_routing_mode: 'fallback_reply',
    fallback_agent_id: planner.agent_id,
  });
  const userMessage = messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: `@${reviewer.agent_name} 请直接审查这个改动`,
    message_type: 'text',
  });

  const seenPrompts: string[] = [];
  const originalAdapter = adapters.codex;
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      seenPrompts.push(args.prompt);
      args.onChunk?.({ stream: 'stdout', text: '收到，开始审查。' });
      return { exitCode: 0, sessionId: null, stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    await dispatchUserMessage({
      roomId: room.id,
      userMessage,
      mentionedAgentRoomIds: [reviewer.id],
    });

    const runs = agentRunRepo.listByRoom(room.id, 20);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.agent_id, reviewer.agent_id);
    assert.equal(seenPrompts.length, 1);
    assert.doesNotMatch(seenPrompts[0] ?? '', /Return ONLY valid JSON/);
    assert.doesNotMatch(seenPrompts[0] ?? '', /UNTRUSTED_USER_MESSAGE_BEGIN/);
  } finally {
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('runAgentOnce broadcasts retrying status for ACP retry chunks and resumes running on session update', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-retry-status-'));
  const project = projectRepo.create({ name: `retry-status-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const agent = roomAgentRepo.add({ room_id: room.id, agent_id: 'executor', agent_name: 'Executor' });
  roomAgentRepo.setAcp(agent.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'bypass',
    acp_writable_dirs: [],
  });

  const sentEvents: string[] = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    send(payload: string) {
      sentEvents.push(payload);
    },
  };
  wsHub.subscribe(room.id, socket as never);

  const originalAdapter = adapters.codex;
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      args.onChunk?.({
        stream: 'stderr',
        channel: 'activity',
        text: '[ACP retry] Codex ACP stream disconnected before output, retrying 1/2 after 0ms.\n',
        rawType: 'protocol.retry',
      });
      args.onSession?.('retry-session-1');
      args.onChunk?.({ stream: 'stdout', text: 'retry recovered' });
      return { exitCode: 0, sessionId: 'retry-session-1', stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    const result = await runAgentOnce({
      roomId: room.id,
      agent: roomAgentRepo.get(agent.id)!,
      projectPath,
      prompt: 'hello',
    });

    const statuses = sentEvents
      .map((payload) => JSON.parse(payload) as { type: string; run?: { status?: string } })
      .filter((event) => event.type === 'agent_run:updated')
      .map((event) => event.run?.status)
      .filter(Boolean);
    const updatedRun = agentRunRepo.get(result.run.id);

    assert.equal(result.status, 'completed');
    const relevantStatuses = statuses.filter((status) => ['retrying', 'running', 'completed'].includes(status!));
    assert.equal(relevantStatuses[0], 'retrying');
    assert.ok(relevantStatuses.includes('running'));
    assert.equal(relevantStatuses.at(-1), 'completed');
    assert.match(updatedRun?.activity_log ?? '', /retrying 1\/2/);
    assert.equal(updatedRun?.stderr, '');
  } finally {
    wsHub.unsubscribe(room.id, socket as never);
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('runAgentOnce does not broadcast agent run updates for answer stdout chunks', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-stdout-status-'));
  const project = projectRepo.create({ name: `stdout-status-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const agent = roomAgentRepo.add({ room_id: room.id, agent_id: 'executor-stdout', agent_name: 'ExecutorStdout' });
  roomAgentRepo.setAcp(agent.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'bypass',
    acp_writable_dirs: [],
  });

  const sentEvents: string[] = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    send(payload: string) {
      sentEvents.push(payload);
    },
  };
  wsHub.subscribe(room.id, socket as never);

  const originalAdapter = adapters.codex;
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      args.onChunk?.({ stream: 'stdout', text: '第一段。' });
      args.onChunk?.({ stream: 'stdout', text: '第二段。' });
      return { exitCode: 0, sessionId: null, stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    const result = await runAgentOnce({
      roomId: room.id,
      agent: roomAgentRepo.get(agent.id)!,
      projectPath,
      prompt: 'hello',
    });

    const events = sentEvents.map((payload) => JSON.parse(payload) as {
      type: string;
      done?: boolean;
      run?: { status?: string };
    });
    const runUpdatedStatuses = events
      .filter((event) => event.type === 'agent_run:updated')
      .map((event) => event.run?.status)
      .filter(Boolean);
    const streamChunks = events.filter((event) => event.type === 'message:stream' && !event.done);

    assert.equal(result.status, 'completed');
    assert.deepEqual(runUpdatedStatuses, ['completed']);
    assert.equal(streamChunks.length, 2);
    assert.match(agentRunRepo.get(result.run.id)?.stdout ?? '', /第一段。第二段。/);
  } finally {
    wsHub.unsubscribe(room.id, socket as never);
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('planner fallback reply keeps executable requests in planner chat without collaboration decision', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-planner-decision-'));
  const project = projectRepo.create({ name: `planner-decision-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = roomAgentRepo.listByRoom(room.id).find((agent) => agent.agent_id === 'planner');
  const executor = roomAgentRepo.add({ room_id: room.id, agent_id: 'frontend-dev', agent_name: 'FrontendDev' });
  const reviewer = roomAgentRepo.add({ room_id: room.id, agent_id: 'reviewer', agent_name: 'Reviewer' });
  assert.ok(planner);
  const globalPlanner = agentRepo.getByBuiltinKey('planner') ?? agentRepo.getByAgentId('planner');
  assert.ok(globalPlanner);
  agentRepo.update(globalPlanner.id, {
    default_acp_backend: 'codex',
    default_acp_permission_mode: 'bypass',
  });
  for (const agent of [planner, executor, reviewer]) {
    roomAgentRepo.setAcp(agent.id, {
      acp_enabled: true,
      acp_backend: 'codex',
      acp_session_id: null,
      acp_session_label: null,
      acp_permission_mode: 'bypass',
      acp_writable_dirs: [],
    });
  }
  settingsRepo.updateProject(project.id, {
    message_routing_mode: 'fallback_reply',
    fallback_agent_id: planner.agent_id,
  });
  const userMessage = messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: '修复群聊协作同时启动所有智能体的问题',
    message_type: 'text',
  });

  const invokedAgents: string[] = [];
  const prompts: string[] = [];
  const originalAdapter = adapters.codex;
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      invokedAgents.push(planner.agent_id);
      prompts.push(args.prompt);
      args.onChunk?.({
        stream: 'stdout',
        text: [
          '实施目标：修复群聊执行型请求不再进入协作决策。',
          '实施范围：dispatcher fallback、planner 任务就绪输出、相关回归测试。',
          '验收标准：不生成 collaboration_decision，planner 消息带 formal_workflow 任务就绪元数据。',
          '下一步可以进入工程排期。',
        ].join('\n'),
      });
      return { exitCode: 0, sessionId: null, stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    await dispatchUserMessage({ roomId: room.id, userMessage });

    const runs = agentRunRepo.listByRoom(room.id, 20);
    const messages = messageRepo.listByRoom(room.id, 20);
    const decisionMessage = messages.find((message) => {
      const metadata = message.metadata ? JSON.parse(message.metadata) as Record<string, unknown> : {};
      return metadata.event_type === 'collaboration_decision';
    });
    assert.deepEqual(invokedAgents, ['planner']);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.agent_id, 'planner');
    assert.doesNotMatch(prompts[0] ?? '', /Return ONLY valid JSON/);
    assert.doesNotMatch(prompts[0] ?? '', /UNTRUSTED_USER_MESSAGE_BEGIN/);
    assert.equal(decisionMessage, undefined);
    assert.equal(
      messages.some((message) =>
        message.sender_id === 'planner' &&
        message.message_type === 'agent_stream' &&
        message.content.includes('实施目标')
      ),
      true,
    );
    const plannerMessage = messages.find((message) => message.sender_id === 'planner');
    assert.ok(plannerMessage);
    const metadata = JSON.parse(plannerMessage.metadata ?? '{}') as MessageMetadata;
    assert.equal(metadata.task_readiness?.ready, true);
    assert.equal(metadata.task_readiness?.recommended_mode, 'formal_workflow');
    assert.equal(metadata.task_readiness?.source_message_id, userMessage.id);
  } finally {
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('planner fallback reply keeps discussion messages in chat without collaboration decision', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-planner-discussion-'));
  const project = projectRepo.create({ name: `planner-discussion-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = roomAgentRepo.listByRoom(room.id).find((agent) => agent.agent_id === 'planner');
  assert.ok(planner);
  roomAgentRepo.setAcp(planner.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'bypass',
    acp_writable_dirs: [],
  });
  settingsRepo.updateProject(project.id, {
    message_routing_mode: 'fallback_reply',
    fallback_agent_id: planner.agent_id,
  });
  const userMessage = messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: '这种方式是否更加合理',
    message_type: 'text',
  });

  const prompts: string[] = [];
  const originalAdapter = adapters.codex;
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      prompts.push(args.prompt);
      args.onChunk?.({ stream: 'stdout', text: '是，这个触发时机更合理。' });
      return { exitCode: 0, sessionId: null, stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    await dispatchUserMessage({ roomId: room.id, userMessage });

    const runs = agentRunRepo.listByRoom(room.id, 20);
    const messages = messageRepo.listByRoom(room.id, 20);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.agent_id, 'planner');
    assert.equal(prompts.length, 1);
    assert.doesNotMatch(prompts[0] ?? '', /Return ONLY valid JSON/);
    assert.doesNotMatch(prompts[0] ?? '', /UNTRUSTED_USER_MESSAGE_BEGIN/);
    assert.equal(
      messages.some((message) => {
        const metadata = message.metadata ? JSON.parse(message.metadata) as Record<string, unknown> : {};
        return metadata.event_type === 'collaboration_decision';
      }),
      false,
    );
    assert.ok(messages.some((message) =>
      message.sender_id === 'planner' &&
      message.message_type === 'agent_stream' &&
      message.content.includes('触发时机更合理'),
    ));
  } finally {
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('dispatchUserMessage includes reply target context in agent prompt', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-reply-context-'));
  const project = projectRepo.create({ name: `reply-context-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = roomAgentRepo.listByRoom(room.id).find((agent) => agent.agent_id === 'planner');
  assert.ok(planner);
  roomAgentRepo.setAcp(planner.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'bypass',
    acp_writable_dirs: [],
  });
  settingsRepo.updateProject(project.id, {
    message_routing_mode: 'fallback_reply',
    fallback_agent_id: planner.agent_id,
  });
  const sourceMessage = messageRepo.create({
    room_id: room.id,
    sender_type: 'agent',
    sender_id: 'planner',
    sender_name: '产品经理',
    content: '你希望按钮点击后是哪一种行为？\n1. 直接发送用户选择消息\n2. 只填入输入框',
    message_type: 'agent_stream',
  });
  const userMessage = messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: '我选 1',
    message_type: 'text',
    metadata: {
      reply_to: {
        message_id: sourceMessage.id,
        sender_type: sourceMessage.sender_type,
        sender_id: sourceMessage.sender_id,
        sender_name: sourceMessage.sender_name,
        excerpt: sourceMessage.content.slice(0, 80),
      },
    },
  });

  const prompts: string[] = [];
  const originalAdapter = adapters.codex;
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      prompts.push(args.prompt);
      args.onChunk?.({ stream: 'stdout', text: '收到，按方案 1 继续。' });
      return { exitCode: 0, sessionId: null, stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    await dispatchUserMessage({ roomId: room.id, userMessage });

    assert.equal(prompts.length, 1);
    assert.match(prompts[0] ?? '', /正在回复的消息：/);
    assert.match(prompts[0] ?? '', /message_id:/);
    assert.match(prompts[0] ?? '', /产品经理/);
    assert.match(prompts[0] ?? '', /你希望按钮点击后是哪一种行为/);
    assert.match(prompts[0] ?? '', /当前用户请求：\n我选 1/);
  } finally {
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('dispatchUserMessage expands reply context from the referenced message body', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-reply-full-context-'));
  const project = projectRepo.create({ name: `reply-full-context-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = roomAgentRepo.listByRoom(room.id).find((agent) => agent.agent_id === 'planner');
  assert.ok(planner);
  roomAgentRepo.setAcp(planner.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'bypass',
    acp_writable_dirs: [],
  });
  settingsRepo.updateProject(project.id, {
    message_routing_mode: 'fallback_reply',
    fallback_agent_id: planner.agent_id,
  });
  const longPrefix = '这是一段很长的需求分析说明。'.repeat(30);
  const sourceMessage = messageRepo.create({
    room_id: room.id,
    sender_type: 'agent',
    sender_id: 'planner',
    sender_name: '产品经理',
    content: `${longPrefix}\n你希望按钮点击后是哪一种行为？\n1. 直接发送用户选择消息\n2. 只填入输入框`,
    message_type: 'agent_stream',
  });
  const userMessage = messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: '我选 1',
    message_type: 'text',
    metadata: {
      reply_to: {
        message_id: sourceMessage.id,
        sender_type: sourceMessage.sender_type,
        sender_id: sourceMessage.sender_id,
        sender_name: sourceMessage.sender_name,
        excerpt: sourceMessage.content.slice(0, 80),
      },
    },
  });

  const prompts: string[] = [];
  const originalAdapter = adapters.codex;
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      prompts.push(args.prompt);
      args.onChunk?.({ stream: 'stdout', text: '收到，按方案 1 继续。' });
      return { exitCode: 0, sessionId: null, stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    await dispatchUserMessage({ roomId: room.id, userMessage });

    assert.equal(prompts.length, 1);
    assert.match(prompts[0] ?? '', /正在回复的消息：/);
    assert.match(prompts[0] ?? '', /正文：/);
    assert.match(prompts[0] ?? '', /1\. 直接发送用户选择消息/);
  } finally {
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('planner fallback reply keeps repair discussion messages in chat without collaboration decision', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-planner-repair-discussion-'));
  const project = projectRepo.create({ name: `planner-repair-discussion-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = roomAgentRepo.listByRoom(room.id).find((agent) => agent.agent_id === 'planner');
  assert.ok(planner);
  roomAgentRepo.setAcp(planner.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'bypass',
    acp_writable_dirs: [],
  });
  settingsRepo.updateProject(project.id, {
    message_routing_mode: 'fallback_reply',
    fallback_agent_id: planner.agent_id,
  });
  const userMessage = messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: '这个修复方案是否合理',
    message_type: 'text',
  });

  const prompts: string[] = [];
  const originalAdapter = adapters.codex;
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      prompts.push(args.prompt);
      args.onChunk?.({ stream: 'stdout', text: '这个修复方案整体合理。' });
      return { exitCode: 0, sessionId: null, stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    await dispatchUserMessage({ roomId: room.id, userMessage });

    const messages = messageRepo.listByRoom(room.id, 20);
    assert.doesNotMatch(prompts[0] ?? '', /Return ONLY valid JSON/);
    assert.doesNotMatch(prompts[0] ?? '', /UNTRUSTED_USER_MESSAGE_BEGIN/);
    assert.equal(
      messages.some((message) => {
        const metadata = message.metadata ? JSON.parse(message.metadata) as Record<string, unknown> : {};
        return metadata.event_type === 'collaboration_decision';
      }),
      false,
    );
  } finally {
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('planner fallback reply keeps execution confirmations in planner chat without collaboration decision', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-planner-confirm-execution-'));
  const project = projectRepo.create({ name: `planner-confirm-execution-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = roomAgentRepo.listByRoom(room.id).find((agent) => agent.agent_id === 'planner');
  assert.ok(planner);
  roomAgentRepo.setAcp(planner.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'bypass',
    acp_writable_dirs: [],
  });
  settingsRepo.updateProject(project.id, {
    message_routing_mode: 'fallback_reply',
    fallback_agent_id: planner.agent_id,
  });
  const userMessage = messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: '按这个方案开始执行',
    message_type: 'text',
  });

  const prompts: string[] = [];
  const originalAdapter = adapters.codex;
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      prompts.push(args.prompt);
      args.onChunk?.({
        stream: 'stdout',
        text: [
          '实施目标：按已确认方案进入正式 workflow。',
          '实施范围：沿用现有任务创建与 workflow 启动链路。',
          '验收标准：planner 回复不生成协作决策卡片，并可被提升为正式 workflow。',
          '下一步可以进入工程排期。',
        ].join('\n'),
      });
      return { exitCode: 0, sessionId: null, stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    await dispatchUserMessage({ roomId: room.id, userMessage });

    const messages = messageRepo.listByRoom(room.id, 20);
    assert.doesNotMatch(prompts[0] ?? '', /Return ONLY valid JSON/);
    assert.doesNotMatch(prompts[0] ?? '', /UNTRUSTED_USER_MESSAGE_BEGIN/);
    assert.equal(messages.some((message) => {
      const metadata = message.metadata ? JSON.parse(message.metadata) as Record<string, unknown> : {};
      return metadata.event_type === 'collaboration_decision';
    }), false);
    const plannerMessage = messages.find((message) => message.sender_id === 'planner');
    assert.ok(plannerMessage);
    const metadata = JSON.parse(plannerMessage.metadata ?? '{}') as MessageMetadata;
    assert.equal(metadata.task_readiness?.ready, true);
    assert.equal(metadata.task_readiness?.recommended_mode, 'formal_workflow');
    assert.equal(metadata.task_readiness?.source_message_id, userMessage.id);
  } finally {
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('planner completed reply marks task readiness when it contains enough implementation details', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-task-readiness-'));
  const project = projectRepo.create({ name: `task-readiness-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = roomAgentRepo.listByRoom(room.id).find((agent) => agent.agent_id === 'planner');
  assert.ok(planner);
  roomAgentRepo.setAcp(planner.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'read-only',
    acp_writable_dirs: [],
  });
  settingsRepo.updateProject(project.id, {
    message_routing_mode: 'fallback_reply',
    fallback_agent_id: 'planner',
  });
  const userMessage = messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: '设计改进方案',
  });
  const originalAdapter = adapters.codex;
  adapters.codex = {
    ...originalAdapter,
    async invoke({ onChunk }) {
      onChunk?.({
        stream: 'stdout',
        text: [
          '已锁定实施目标：收口 ACP 权限派生。',
          '实施范围：后端派生逻辑、API 保存逻辑、前端权限配置展示。',
          '验收标准：只读智能体无法写文件，后端智能体不能写前端目录。',
          '下一步可以进入工程排期。',
        ].join('\n'),
      });
      return { exitCode: 0, sessionId: null, stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    await dispatchUserMessage({ roomId: room.id, userMessage });

    const plannerMessage = messageRepo.listByRoom(room.id, 20).find((message) => message.sender_id === 'planner');
    assert.ok(plannerMessage);
    const metadata = JSON.parse(plannerMessage.metadata ?? '{}') as Record<string, unknown>;
    const readiness = metadata.task_readiness as Record<string, unknown> | undefined;
    assert.equal(readiness?.ready, true);
    assert.equal(readiness?.recommended_mode, 'formal_workflow');
    assert.equal(readiness?.execution_intent, 'implementation');
    assert.equal(readiness?.source_message_id, userMessage.id);
    assert.match(String(readiness?.title), /收口 ACP 权限派生/);
  } finally {
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('planner completed reply reads structured task readiness json from markdown output', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-task-readiness-json-'));
  const project = projectRepo.create({ name: `task-readiness-json-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = roomAgentRepo.listByRoom(room.id).find((agent) => agent.agent_id === 'planner');
  assert.ok(planner);
  roomAgentRepo.setAcp(planner.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'read-only',
    acp_writable_dirs: [],
  });
  settingsRepo.updateProject(project.id, {
    message_routing_mode: 'fallback_reply',
    fallback_agent_id: 'planner',
  });
  const userMessage = messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: '生成任务',
  });
  const originalAdapter = adapters.codex;
  adapters.codex = {
    ...originalAdapter,
    async invoke({ onChunk }) {
      onChunk?.({
        stream: 'stdout',
        text: [
          '大哥，建议生成这个任务：',
          '',
          '**任务标题**',
          '压缩群聊任务卡片宽度与表格间距',
          '',
          '**目标**',
          '让群聊中的 workflow 任务卡片最大宽度不超过普通聊天消息气泡。',
          '',
          '```json',
          JSON.stringify({
            task_readiness: {
              ready: true,
              confidence: 0.91,
              title: '压缩群聊任务卡片宽度与表格间距',
              description: '调整群聊任务卡片宽度、表格缩进与移动端滚动表现，并运行构建验证。',
              missing_questions: [],
              recommended_mode: 'formal_workflow',
              execution_intent: 'implementation',
            },
          }, null, 2),
          '```',
        ].join('\n'),
      });
      return { exitCode: 0, sessionId: null, stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    await dispatchUserMessage({ roomId: room.id, userMessage });

    const plannerMessage = messageRepo.listByRoom(room.id, 20).find((message) => message.sender_id === 'planner');
    assert.ok(plannerMessage);
    const metadata = JSON.parse(plannerMessage.metadata ?? '{}') as Record<string, unknown>;
    const readiness = metadata.task_readiness as Record<string, unknown> | undefined;
    assert.equal(readiness?.ready, true);
    assert.equal(readiness?.recommended_mode, 'formal_workflow');
    assert.equal(readiness?.execution_intent, 'implementation');
    assert.equal(readiness?.source_message_id, userMessage.id);
    assert.equal(readiness?.title, '压缩群聊任务卡片宽度与表格间距');
  } finally {
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('planner completed reply marks analysis-only readiness without formal workflow recommendation', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-analysis-readiness-'));
  const project = projectRepo.create({ name: `analysis-readiness-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = roomAgentRepo.listByRoom(room.id).find((agent) => agent.agent_id === 'planner');
  assert.ok(planner);
  roomAgentRepo.setAcp(planner.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'read-only',
    acp_writable_dirs: [],
  });
  settingsRepo.updateProject(project.id, {
    message_routing_mode: 'fallback_reply',
    fallback_agent_id: 'planner',
  });
  const userMessage = messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: '先生成修复方案，不要实现',
  });
  const originalAdapter = adapters.codex;
  adapters.codex = {
    ...originalAdapter,
    async invoke({ onChunk }) {
      onChunk?.({
        stream: 'stdout',
        text: [
          '本轮只做方案设计，不进入实现。',
          '实施目标：明确只读分析任务与实现任务的分流规则。',
          '验收标准：输出目标、边界、风险和验证方式。',
          '后续如确认，再进入工程排期。',
        ].join('\n'),
      });
      return { exitCode: 0, sessionId: null, stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    await dispatchUserMessage({ roomId: room.id, userMessage });
    const plannerMessage = messageRepo.listByRoom(room.id, 20).find((message) => message.sender_id === 'planner');
    assert.ok(plannerMessage);
    const metadata = JSON.parse(plannerMessage.metadata ?? '{}') as Record<string, unknown>;
    const readiness = metadata.task_readiness as Record<string, unknown> | undefined;
    assert.equal(readiness?.ready, true);
    assert.equal(readiness?.execution_intent, 'analysis_only');
    assert.equal(readiness?.recommended_mode, 'chat_collaboration');
    assert.equal(readiness?.source_message_id, userMessage.id);
  } finally {
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('message route treats /task content as plain chat and still dispatches ACP reply', async () => {
  const { projectPath, room } = await createRoutedRoom('task-command');
  const { restore, calls } = installCountingCodexAdapter();

  try {
    const res = await request(`/api/rooms/${room.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        content: '/task Fix command route',
        sender_id: 'user',
        sender_name: 'You',
      }),
    });

    assert.equal(res.status, 201);
    const userMessage = await res.json() as Message;
    assert.equal(userMessage.content, '/task Fix command route');
    await delay(30);
    assert.equal(calls.count, 1);
    assert.equal(taskRepo.listByRoom(room.id).length, 0);

    const messages = messageRepo.listByRoom(room.id, 20);
    assert.equal(messages[0]?.id, userMessage.id);
    assert.equal(messages.some((message) => {
      const metadata = message.metadata ? JSON.parse(message.metadata) as Record<string, unknown> : {};
      return metadata.event_type === 'task_created';
    }), false);
  } finally {
    restore();
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('message route persists reply target metadata', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-message-reply-route-'));
  const project = projectRepo.create({ name: `message-reply-route-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  settingsRepo.updateProject(project.id, {
    message_routing_mode: 'mentions_only',
    fallback_agent_id: null,
  });
  const sourceMessage = messageRepo.create({
    room_id: room.id,
    sender_type: 'agent',
    sender_id: 'planner',
    sender_name: '产品经理',
    content: '这个按钮点击后，你希望它直接发送用户选择消息吗？',
    message_type: 'agent_stream',
  });

  try {
    const response = await request(`/api/rooms/${room.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        content: '确定，直接发送',
        reply_to_message_id: sourceMessage.id,
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const payload = await response.json() as Message | { error?: unknown };
    assert.equal(response.status, 201, JSON.stringify(payload));
    const message = payload as Message;
    const metadata = JSON.parse(message.metadata ?? '{}') as MessageMetadata;
    assert.equal(metadata.reply_to?.message_id, sourceMessage.id);
    assert.equal(metadata.reply_to?.sender_name, '产品经理');
    assert.match(metadata.reply_to?.excerpt ?? '', /直接发送用户选择消息/);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('message route returns JSON 400 when reply target is outside the room', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-message-reply-invalid-'));
  const project = projectRepo.create({ name: `message-reply-invalid-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const otherRoom = roomRepo.create({ project_id: project.id, name: 'Other Room' });
  settingsRepo.updateProject(project.id, {
    message_routing_mode: 'mentions_only',
    fallback_agent_id: null,
  });
  const sourceMessage = messageRepo.create({
    room_id: otherRoom.id,
    sender_type: 'agent',
    sender_id: 'planner',
    sender_name: '产品经理',
    content: '其它房间消息',
    message_type: 'agent_stream',
  });

  try {
    const response = await request(`/api/rooms/${room.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        content: '确定',
        reply_to_message_id: sourceMessage.id,
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const payload = await response.json() as { error?: unknown };
    assert.equal(response.status, 400);
    assert.equal(payload.error, 'reply_to_message_id not found in room');
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('message route treats /start-task content as plain chat and does not start workflow', async () => {
  const { projectPath, room } = await createRoutedRoom('start-task-command');
  const { restore, calls } = installCountingCodexAdapter();

  try {
    const res = await request(`/api/rooms/${room.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        content: '/start-task task-123',
        sender_id: 'user',
        sender_name: 'You',
      }),
    });

    assert.equal(res.status, 201);
    const userMessage = await res.json() as Message;
    await delay(30);
    assert.equal(calls.count, 1);
    assert.equal(workflowRepo.listByTask('task-123').length, 0);
    const messages = messageRepo.listByRoom(room.id, 20);
    assert.equal(messages[0]?.id, userMessage.id);
    assert.equal(messages.some((message) => {
      const metadata = message.metadata ? JSON.parse(message.metadata) as Record<string, unknown> : {};
      return metadata.event_type === 'workflow_started';
    }), false);
  } finally {
    restore();
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('message route treats Chinese start command as plain chat and does not start workflow', async () => {
  const { projectPath, room } = await createRoutedRoom('cn-start-task-command');
  const { restore, calls } = installCountingCodexAdapter();

  try {
    const res = await request(`/api/rooms/${room.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        content: '开始任务 #task-123',
        sender_id: 'user',
        sender_name: 'You',
      }),
    });

    assert.equal(res.status, 201);
    const userMessage = await res.json() as Message;
    await delay(30);
    assert.equal(calls.count, 1);
    assert.equal(workflowRepo.listByTask('task-123').length, 0);
    assert.equal(messageRepo.listByRoom(room.id, 20).some((message) => {
      const metadata = message.metadata ? JSON.parse(message.metadata) as Record<string, unknown> : {};
      return metadata.event_type === 'workflow_started';
    }), false);
    assert.equal(userMessage.content, '开始任务 #task-123');
  } finally {
    restore();
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('message route no longer errors on missing /start-task target and treats it as chat', async () => {
  const { projectPath, room } = await createRoutedRoom('start-task-command-missing');
  const { restore, calls } = installCountingCodexAdapter();

  try {
    const res = await request(`/api/rooms/${room.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        content: '/start-task missing-task',
        sender_id: 'user',
        sender_name: 'You',
      }),
    });

    assert.equal(res.status, 201);
    const userMessage = await res.json() as Message;
    await delay(30);
    assert.equal(calls.count, 1);
    assert.equal(userMessage.content, '/start-task missing-task');
    assert.equal(messageRepo.listByRoom(room.id, 20).filter((message) => message.sender_type === 'user').length, 1);
  } finally {
    restore();
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('buildPromptWithMessageAttachments marks unsafe attachment paths unavailable', () => {
  const message = createMessage({
    attachments: [
      {
        id: 'att-1',
        name: 'secret.png',
        mimeType: 'image/png',
        size: 1,
        url: '/uploads/messages/../secret.png',
        isImage: true,
      },
    ],
  });

  const prompt = buildPromptWithMessageAttachments('', message);

  assert.match(prompt, /用户发送了一条仅包含附件的消息。/);
  assert.match(prompt, /localPath=unavailable/);
  assert.doesNotMatch(prompt, /\.\.\/secret/);
});

test('buildPromptWithMessageAttachments resolves project file attachment paths', () => {
  const message = createMessage({
    attachments: [
      {
        id: 'file-1',
        fileId: 'file-1',
        name: 'brief.pdf',
        mimeType: 'application/pdf',
        size: 12,
        url: '/uploads/files/project-1/stored.pdf',
        isImage: false,
      },
    ],
  });

  const prompt = buildPromptWithMessageAttachments('read this', message);

  assert.match(prompt, /brief\.pdf/);
  assert.match(prompt, /localPath=.*uploads.*files.*project-1.*stored\.pdf/);
});

test('buildAgentIdentityPrompt renders global personality and rules before the user prompt', () => {
  const globalAgent = agentRepo.create({
    agent_id: 'frontend-lead',
    name: '前端执行官',
    preferred_user_name: '陈工',
    personality: '严谨、直接。',
    responsibilities: '前端实现和 UI 验收。',
    rules: '完成前必须验证。',
    default_acp_backend: 'codex',
  });
  const projectPath = mkdtempSync(join(tmpdir(), 'openclaw-room-identity-prompt-'));
  const project = projectRepo.create({ name: `identity-prompt-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Identity Room' });
  const roomAgent = roomAgentRepo.addFromGlobalAgent({
    room_id: room.id,
    global_agent_id: globalAgent.id,
  });

  const prompt = buildAgentIdentityPrompt(roomAgent, '请实现页面');

  assert.match(prompt, /你的智能体身份：/);
  assert.match(prompt, /名称：前端执行官/);
  assert.match(prompt, /用户称呼：陈工/);
  assert.match(prompt, /性格：严谨、直接。/);
  assert.match(prompt, /主要工作：前端实现和 UI 验收。/);
  assert.match(prompt, /必须遵守的规则：\n完成前必须验证。/);
  assert.match(prompt, /当前用户请求：\n请实现页面/);
});

test('built-in planner identity does not convert executable feature requests into analysis-only work', () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'openclaw-room-planner-identity-'));
  const project = projectRepo.create({ name: `planner-identity-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Planner Identity Room' });
  const planner = roomAgentRepo.listByRoom(room.id).find((agent) => agent.agent_id === 'planner');
  assert.ok(planner);

  const prompt = buildAgentIdentityPrompt(
    planner,
    '细化文件管理功能 ，比如有些是用户上传的文件，有些是智能体生成的md文档',
  );

  assert.match(prompt, /不亲自修改代码/);
  assert.match(prompt, /不得把任务改写成“只做分析\/不进入实现”/);
  assert.match(prompt, /可进入 workflow 的执行计划/);
  assert.match(prompt, /任务生成结构化输出规则/);
  assert.match(prompt, /"task_readiness"/);
  assert.match(prompt, /"recommended_mode": "formal_workflow"/);
  assert.match(prompt, /当前用户请求：\n细化文件管理功能/);
});

test('dispatchUserMessage passes uploaded image paths to ACP adapters', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-dispatch-test-'));
  const project = projectRepo.create({ name: `dispatch-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const agent = roomAgentRepo.add({ room_id: room.id, agent_id: 'codex-agent', agent_name: 'CodexAgent' });
  roomAgentRepo.setAcp(agent.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'bypass',
    acp_writable_dirs: [],
  });
  settingsRepo.updateProject(project.id, {
    message_routing_mode: 'fallback_reply',
    fallback_agent_id: 'codex-agent',
  });

  const captured: { imagePaths?: string[] } = {};
  const originalAdapter = adapters.codex;
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      captured.imagePaths = args.imagePaths;
      return { exitCode: 1, sessionId: null, stderr: 'stubbed failure' };
    },
  } satisfies SessionAdapter;

  try {
    const message = messageRepo.create({
      room_id: room.id,
      sender_type: 'user',
      sender_id: 'user',
      sender_name: 'You',
      content: '看这张图',
      message_type: 'text',
      metadata: {
        attachments: [
          {
            id: 'att-1',
            name: 'screen.png',
            mimeType: 'image/png',
            size: 128,
            url: '/uploads/messages/stored.png',
            isImage: true,
          },
        ],
      },
    });

    await dispatchUserMessage({ roomId: room.id, userMessage: message });

    assert.deepEqual(captured.imagePaths, [join(messageUploadDir, 'stored.png')]);
  } finally {
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('dispatchUserMessage marks empty successful ACP output as failed', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-empty-acp-test-'));
  const project = projectRepo.create({ name: `empty-acp-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const agent = roomAgentRepo.add({ room_id: room.id, agent_id: 'opencode-agent', agent_name: 'OpenCodeAgent' });
  roomAgentRepo.setAcp(agent.id, {
    acp_enabled: true,
    acp_backend: 'opencode',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'bypass',
    acp_writable_dirs: [],
  });
  settingsRepo.updateProject(project.id, {
    message_routing_mode: 'fallback_reply',
    fallback_agent_id: 'opencode-agent',
  });

  const originalAdapter = adapters.opencode;
  adapters.opencode = {
    ...originalAdapter,
    async invoke() {
      return { exitCode: 0, sessionId: null, stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    const message = messageRepo.create({
      room_id: room.id,
      sender_type: 'user',
      sender_id: 'user',
      sender_name: 'You',
      content: 'hi',
      message_type: 'text',
    });

    await dispatchUserMessage({ roomId: room.id, userMessage: message });

    const [run] = agentRunRepo.listByRoom(room.id, 1);
    const agentMessages = messageRepo.listByRoom(room.id).filter((item) => item.sender_type === 'agent');

    assert.ok(run);
    assert.equal(run.status, 'failed');
    assert.match(run.error ?? '', /completed without output/i);
    assert.match(run.stderr, /completed without output/i);
    assert.match(agentMessages.at(-1)?.content ?? '', /opencode error.*completed without output/i);
  } finally {
    adapters.opencode = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('respondAsAgent preserves writable dirs when ACP session id changes', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-session-preserve-dirs-'));
  const writeDir = join(projectPath, 'packages/backend');
  await mkdir(writeDir, { recursive: true });
  const project = projectRepo.create({ name: `session-preserve-dirs-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const agent = roomAgentRepo.add({ room_id: room.id, agent_id: 'session-agent', agent_name: 'SessionAgent' });
  const acpAgent = roomAgentRepo.setAcp(agent.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: 'old-session',
    acp_session_label: null,
    acp_permission_mode: 'workspace-write',
    acp_writable_dirs: [writeDir],
  });
  assert.ok(acpAgent);

  const originalAdapter = adapters.codex;
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      args.onChunk({ stream: 'stdout', text: 'session updated' });
      return { exitCode: 0, sessionId: 'new-session', stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    await respondAsAgent({
      agent: acpAgent,
      projectPath,
      roomId: room.id,
      prompt: '更新 session',
    });

    const updated = roomAgentRepo.get(agent.id);
    assert.equal(updated?.acp_session_id, 'new-session');
    assert.equal(updated?.acp_permission_mode, 'workspace-write');
    assert.deepEqual(updated?.acp_writable_dirs, [writeDir]);
  } finally {
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('respondAsAgent passes handoff context when agent starts first ACP session', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-first-handoff-'));
  const project = projectRepo.create({ name: `first-handoff-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room', ensureDefaultPlanner: false });
  const agent = roomAgentRepo.add({ room_id: room.id, agent_id: 'planner', agent_name: '规划师' });
  const acpAgent = roomAgentRepo.setAcp(agent.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
  });
  assert.ok(acpAgent);
  messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: '帮我在侧边栏添加一个测试菜单，内容是一个计数器',
    message_type: 'text',
  });

  const originalAdapter = adapters.codex;
  let capturedHandoff: string | null | undefined;
  let capturedHandoffMode: string | undefined;
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      capturedHandoff = args.sessionHandoff;
      capturedHandoffMode = args.sessionHandoffMode;
      args.onChunk({ stream: 'stdout', text: '开始处理。' });
      return { exitCode: 0, sessionId: 'first-session', stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    await respondAsAgent({
      agent: acpAgent,
      projectPath,
      roomId: room.id,
      prompt: '继续',
    });

    assert.match(capturedHandoff ?? '', /新会话接续上下文/);
    assert.match(capturedHandoff ?? '', /帮我在侧边栏添加一个测试菜单/);
    assert.match(capturedHandoff ?? '', /首次 session/);
    assert.equal(capturedHandoffMode, 'new_session');
  } finally {
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('respondAsAgent prepares resume-unavailable handoff without forcing normal resume', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-resume-unavailable-handoff-'));
  const project = projectRepo.create({ name: `resume-unavailable-handoff-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room', ensureDefaultPlanner: false });
  const agent = roomAgentRepo.add({ room_id: room.id, agent_id: 'planner', agent_name: '规划师' });
  const acpAgent = roomAgentRepo.setAcp(agent.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: 'old-session',
    acp_session_label: null,
  });
  assert.ok(acpAgent);
  messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: '继续刚才的实现',
    message_type: 'text',
  });

  const originalAdapter = adapters.codex;
  let capturedHandoff: string | null | undefined;
  let capturedHandoffMode: string | undefined;
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      capturedHandoff = args.sessionHandoff;
      capturedHandoffMode = args.sessionHandoffMode;
      args.onChunk({ stream: 'stdout', text: '继续处理。' });
      return { exitCode: 0, sessionId: args.sessionId, stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    await respondAsAgent({
      agent: acpAgent,
      projectPath,
      roomId: room.id,
      prompt: '继续',
    });

    assert.match(capturedHandoff ?? '', /provider 不支持 resume 后新建 session/);
    assert.equal(capturedHandoffMode, 'new_session');
  } finally {
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('respondAsAgent clears pending handoff after passing it to the next ACP turn', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-pending-handoff-clear-'));
  const project = projectRepo.create({ name: `pending-handoff-clear-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room', ensureDefaultPlanner: false });
  const agent = roomAgentRepo.add({ room_id: room.id, agent_id: 'planner', agent_name: '规划师' });
  let acpAgent = roomAgentRepo.setAcp(agent.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: 'fresh-session-after-reset',
    acp_session_label: null,
  });
  assert.ok(acpAgent);
  acpAgent = roomAgentRepo.setAcpSessionHandoffPending(
    acpAgent.id,
    true,
    'automatic_rotation_after_events',
  );
  assert.ok(acpAgent);
  agentRunRepo.create({
    room_id: room.id,
    room_agent_id: acpAgent.id,
    agent_id: acpAgent.agent_id,
    backend: 'codex',
    acp_session_id: 'old-session',
    prompt: '上一轮 prompt',
  });

  const originalAdapter = adapters.codex;
  let capturedSessionId: string | null | undefined;
  let capturedHandoff: string | null | undefined;
  let capturedHandoffMode: string | undefined;
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      capturedSessionId = args.sessionId;
      capturedHandoff = args.sessionHandoff;
      capturedHandoffMode = args.sessionHandoffMode;
      args.onChunk({ stream: 'stdout', text: '继续完成。' });
      return { exitCode: 0, sessionId: args.sessionId, stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    await respondAsAgent({
      agent: acpAgent,
      projectPath,
      roomId: room.id,
      prompt: '继续',
    });

    const updated = roomAgentRepo.get(acpAgent.id);
    assert.equal(capturedSessionId, 'fresh-session-after-reset');
    assert.match(capturedHandoff ?? '', /事件流出后自动轮换 session/);
    assert.equal(capturedHandoffMode, 'force');
    assert.equal(updated?.acp_session_handoff_pending, 0);
    assert.equal(updated?.acp_session_handoff_reason, null);
  } finally {
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('respondAsAgent stores pending handoff after evented ACP session rotation', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-pending-handoff-store-'));
  const project = projectRepo.create({ name: `pending-handoff-store-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room', ensureDefaultPlanner: false });
  const agent = roomAgentRepo.add({ room_id: room.id, agent_id: 'planner', agent_name: '规划师' });
  const acpAgent = roomAgentRepo.setAcp(agent.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: 'old-session',
    acp_session_label: null,
  });
  assert.ok(acpAgent);

  const originalAdapter = adapters.codex;
  adapters.codex = {
    ...originalAdapter,
    async invoke() {
      return {
        exitCode: 1,
        sessionId: 'fresh-session-after-reset',
        stderr: 'system-role history is not supported',
        sessionHandoffPending: true,
        sessionHandoffReason: 'automatic_rotation_after_events',
      };
    },
  } satisfies SessionAdapter;

  try {
    await respondAsAgent({
      agent: acpAgent,
      projectPath,
      roomId: room.id,
      prompt: '继续',
    });

    const updated = roomAgentRepo.get(acpAgent.id);
    assert.equal(updated?.acp_session_id, 'fresh-session-after-reset');
    assert.equal(updated?.acp_session_handoff_pending, 1);
    assert.equal(updated?.acp_session_handoff_reason, 'automatic_rotation_after_events');
  } finally {
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('respondAsAgent persists legacy raw patch event as timeline event metadata', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-raw-event-test-'));
  const project = projectRepo.create({ name: `raw-event-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const agent = roomAgentRepo.add({ room_id: room.id, agent_id: 'event-agent', agent_name: 'EventAgent' });
  const acpAgent = roomAgentRepo.setAcp(agent.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'bypass',
    acp_writable_dirs: [],
  });
  assert.ok(acpAgent);

  const events = captureRoomEvents(room.id);
  const originalAdapter = adapters.codex;
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      args.onChunk({
        stream: 'stdout',
        channel: 'event',
        text: '',
        rawEvent: {
          type: 'patch',
          payload: {
            path: 'src/app.ts',
            patch: '-old\n+new',
          },
        },
      });
      args.onChunk({ stream: 'stdout', text: '已完成修改' });
      return { exitCode: 0, sessionId: null, stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    await respondAsAgent({
      agent: acpAgent,
      projectPath,
      roomId: room.id,
      prompt: '应用补丁',
    });

    const reply = messageRepo.listByRoom(room.id).find((item) => item.sender_id === acpAgent.agent_id);
    assert.ok(reply);
    const metadata = JSON.parse(reply.metadata ?? '{}') as MessageMetadata;
    assert.equal(metadata.trace?.events?.[0]?.type, 'file_diff');
    assert.equal(metadata.trace?.events?.[0]?.payload.path, 'src/app.ts');
    assert.equal(metadata.trace?.events?.[0]?.payload.patch, '-old\n+new');
    assert.ok(events.some((event) =>
      event.type === 'message:stream' &&
      event.channel === 'event' &&
      event.done === false &&
      event.event?.type === 'file_diff' &&
      event.event.payload.path === 'src/app.ts'
    ));
  } finally {
    events.restore();
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('respondAsAgent appends and broadcasts stdout chunks before ACP invoke resolves', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-true-stream-test-'));
  const project = projectRepo.create({ name: `true-stream-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const agent = roomAgentRepo.add({ room_id: room.id, agent_id: 'stream-agent', agent_name: 'StreamAgent' });
  const acpAgent = roomAgentRepo.setAcp(agent.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'bypass',
    acp_writable_dirs: [],
  });
  assert.ok(acpAgent);

  const events = captureRoomEvents(room.id);
  const originalAdapter = adapters.codex;
  let releaseInvoke!: () => void;
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      args.onChunk({
        stream: 'stdout',
        channel: 'thinking',
        text: '先分析需求',
        trace: { kind: 'thinking', text: '先分析需求' },
      });
      args.onChunk({
        stream: 'stdout',
        channel: 'tool',
        text: 'Read dispatcher.ts',
        trace: { kind: 'tool', name: 'Read', input: '{"path":"dispatcher.ts"}' },
      });
      args.onChunk({ stream: 'stdout', text: '第一段' });
      await new Promise<void>((resolve) => {
        releaseInvoke = resolve;
      });
      args.onChunk({ stream: 'stdout', text: '第二段' });
      return { exitCode: 0, sessionId: null, stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    let finished = false;
    const running = respondAsAgent({
      agent: acpAgent,
      projectPath,
      roomId: room.id,
      prompt: '请真流式回复',
    }).then(() => {
      finished = true;
    });

    await waitFor(() => messageRepo.listByRoom(room.id).some((item) => item.content === '第一段'));
    assert.equal(finished, false, 'agent response should still be waiting for ACP process completion');
    assert.equal(
      messageRepo.listByRoom(room.id).find((item) => item.sender_id === acpAgent.agent_id)?.content,
      '第一段',
    );
    assert.ok(events.some((event) =>
      event.type === 'message:stream' &&
      event.chunk === '第一段' &&
      event.done === false &&
      typeof event.seq === 'number' &&
      event.runId &&
      event.channel === 'answer' &&
      event.status === 'streaming'
    ));
    assert.ok(events.some((event) =>
      event.type === 'message:stream' &&
      event.channel === 'event' &&
      event.done === false &&
      event.event?.type === 'thinking' &&
      event.event.payload.text === '先分析需求'
    ));
    assert.ok(events.some((event) =>
      event.type === 'message:stream' &&
      event.channel === 'event' &&
      event.done === false &&
      event.event?.type === 'tool_call' &&
      event.event.payload.name === 'Read'
    ));

    releaseInvoke();
    await running;

    const reply = messageRepo.listByRoom(room.id).find((item) => item.sender_id === acpAgent.agent_id);
    assert.equal(reply?.content, '第一段第二段');
    const run = agentRunRepo.listByRoom(room.id, 1)[0];
    assert.equal(run?.stdout, '第一段第二段');
    assert.equal(run?.stderr, '');
    const metadata = JSON.parse(reply?.metadata ?? '{}') as MessageMetadata;
    assert.ok(Array.isArray(metadata.trace?.events));
    assert.ok(metadata.trace?.events?.some((event) => event.type === 'thinking'));
    assert.ok(metadata.trace?.events?.some((event) => event.type === 'tool_call'));
    assert.ok(events.some((event) =>
      event.type === 'message:stream' &&
      event.messageId === reply?.id &&
      event.done === true &&
      typeof event.seq === 'number' &&
      event.seq > 1 &&
      event.status === 'completed' &&
      event.chunk === ''
    ));
  } finally {
    events.restore();
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('respondAsAgent batches tiny stdout chunks before broadcasting answer stream', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-stream-batch-test-'));
  const project = projectRepo.create({ name: `stream-batch-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const agent = roomAgentRepo.add({ room_id: room.id, agent_id: 'batch-agent', agent_name: 'BatchAgent' });
  const acpAgent = roomAgentRepo.setAcp(agent.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'bypass',
    acp_writable_dirs: [],
  });
  assert.ok(acpAgent);

  const events = captureRoomEvents(room.id);
  const originalAdapter = adapters.codex;
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      for (const chunk of ['群', '聊', '页', '现', '在', '应', '该', '更', '快']) {
        args.onChunk({ stream: 'stdout', text: chunk });
      }
      return { exitCode: 0, sessionId: null, stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    await respondAsAgent({
      agent: acpAgent,
      projectPath,
      roomId: room.id,
      prompt: '请快速回复',
    });

    const reply = messageRepo.listByRoom(room.id).find((item) => item.sender_id === acpAgent.agent_id);
    assert.equal(reply?.content, '群聊页现在应该更快');
    const answerStreamEvents = events.filter((event): event is Extract<CapturedRoomEvent, { type: 'message:stream' }> =>
      event.type === 'message:stream' && event.channel === 'answer' && !event.done
    );
    assert.deepEqual(
      answerStreamEvents.map((event) => event.chunk),
      ['群聊页现在应该更快'],
    );
  } finally {
    events.restore();
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('respondAsAgent flushes answer stream at sentence boundaries', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-stream-sentence-test-'));
  const project = projectRepo.create({ name: `stream-sentence-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const agent = roomAgentRepo.add({ room_id: room.id, agent_id: 'sentence-agent', agent_name: 'SentenceAgent' });
  const acpAgent = roomAgentRepo.setAcp(agent.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'bypass',
    acp_writable_dirs: [],
  });
  assert.ok(acpAgent);

  const events = captureRoomEvents(room.id);
  const originalAdapter = adapters.codex;
  let releaseInvoke!: () => void;
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      for (const chunk of ['这', '是', '前', '半', '句']) {
        args.onChunk({ stream: 'stdout', text: chunk });
      }
      await new Promise<void>((resolve) => {
        releaseInvoke = resolve;
      });
      args.onChunk({ stream: 'stdout', text: '。' });
      return { exitCode: 0, sessionId: null, stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    const running = respondAsAgent({
      agent: acpAgent,
      projectPath,
      roomId: room.id,
      prompt: '请按句子回复',
    });

    await waitFor(() => releaseInvoke !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(
      events.some((event) => event.type === 'message:stream' && event.channel === 'answer' && !event.done),
      false,
    );

    releaseInvoke();
    await running;

    const answerStreamEvents = events.filter((event): event is Extract<CapturedRoomEvent, { type: 'message:stream' }> =>
      event.type === 'message:stream' && event.channel === 'answer' && !event.done
    );
    assert.deepEqual(
      answerStreamEvents.map((event) => event.chunk),
      ['这是前半句。'],
    );
  } finally {
    events.restore();
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('respondAsAgent passes resolved workspace writable dirs and runtime prompt to ACP adapter', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-runtime-profile-test-'));
  const project = projectRepo.create({ name: `runtime-profile-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const global = agentRepo.getByAgentId('backend-executor');
  assert.ok(global);
  const agent = roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: global.id });

  const originalAdapter = adapters.codex;
  let capturedWritableDirs: string[] | null | undefined;
  let capturedPermissionMode: string | null | undefined;
  let capturedPrompt = '';
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      capturedWritableDirs = args.acpWritableDirs;
      capturedPermissionMode = args.acpPermissionMode;
      capturedPrompt = args.prompt;
      args.onChunk({ stream: 'stdout', text: 'done' });
      return { exitCode: 0, sessionId: null, stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    await respondAsAgent({
      agent,
      projectPath,
      roomId: room.id,
      prompt: '修改后端',
    });

    assert.deepEqual(capturedWritableDirs, [projectPath]);
    assert.equal(capturedPermissionMode, 'workspace-write');
    assert.match(capturedPrompt, /智能体运行边界：/);
    assert.match(capturedPrompt, new RegExp(`可写目录：.*${escapeRegExp(projectPath)}`));
  } finally {
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('respondAsAgent uses provider-owned Superpowers by default for ordinary ACP planner chats', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-superpowers-bootstrap-test-'));
  const project = projectRepo.create({ name: `superpowers-bootstrap-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = roomAgentRepo.listByRoom(room.id).find((agent) => agent.agent_id === 'planner');
  assert.ok(planner);

  const originalAdapter = adapters.codex;
  let capturedPrompt = '';
  let capturedEnvOverrides: Record<string, string> | undefined;
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      capturedPrompt = args.prompt;
      capturedEnvOverrides = args.envOverrides;
      args.onChunk({ stream: 'stdout', text: 'done' });
      return { exitCode: 0, sessionId: null, stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    await respondAsAgent({
      agent: planner,
      projectPath,
      roomId: room.id,
      prompt: 'hi',
    });

    assert.doesNotMatch(capturedPrompt, /<EXTREMELY_IMPORTANT>/);
    assert.doesNotMatch(capturedPrompt, /You have superpowers\./);
    assert.doesNotMatch(capturedPrompt, /superpowers:using-superpowers/);
    assert.equal(capturedEnvOverrides?.OPENCLAW_SUPERPOWERS_BOOTSTRAP_OWNER, 'provider');
    assert.equal(capturedEnvOverrides?.OPENDEEPSEA_SUPERPOWERS_BOOTSTRAP_OWNER, 'provider');
    assert.equal(capturedEnvOverrides?.SUPERPOWERS_BOOTSTRAP_DISABLED, undefined);

    const run = agentRunRepo.listByRoom(room.id, 1)[0];
    assert.equal(run?.workflow_run_id, null);
    assert.equal(run?.superpowers_bootstrap_owner, 'provider');
    assert.equal(run?.superpowers_bootstrap_injected, 0);
    assert.equal(run?.superpowers_bootstrap_skill, null);
    assert.equal(run?.superpowers_bootstrap_skip_reason, 'provider_owner');
    assert.doesNotMatch(run?.prompt ?? '', /superpowers:using-superpowers/);
  } finally {
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('respondAsAgent injects project-builtin brainstorming for project-owned planner chats', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-superpowers-project-skills-'));
  const project = projectRepo.create({ name: `superpowers-project-skills-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  settingsRepo.updateRoom(room.id, { superpowers_bootstrap_owner: 'project' });
  const planner = roomAgentRepo.listByRoom(room.id).find((agent) => agent.agent_id === 'planner');
  assert.ok(planner);

  const originalAdapter = adapters.codex;
  let capturedPrompt = '';
  let capturedEnvOverrides: Record<string, string> | undefined;
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      capturedPrompt = args.prompt;
      capturedEnvOverrides = args.envOverrides;
      args.onChunk({ stream: 'stdout', text: 'done' });
      return { exitCode: 0, sessionId: null, stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    await respondAsAgent({
      agent: planner,
      projectPath,
      roomId: room.id,
      prompt: '浏览器流程测试 2026-05-28 08:45：我想新增一个很小的设置项，请先按 using-superpowers 判断是否需要进入 workflow，并做简短 brainstorming 澄清，不要修改代码。',
    });

    assert.match(capturedPrompt, /OpenDeepSea project-owned Superpowers skills are loaded below/);
    assert.match(capturedPrompt, /Skill: superpowers:brainstorming/);
    assert.match(capturedPrompt, /Source: project-builtin/);
    assert.match(capturedPrompt, /packages\/backend\/src\/project-superpowers\/skills\/brainstorming\/SKILL\.md/);
    assert.match(capturedPrompt, /Do not read or invoke same-name skills from external personal\/plugin directories/);
    assert.equal(capturedEnvOverrides?.SUPERPOWERS_BOOTSTRAP_DISABLED, '1');

    const run = agentRunRepo.listByRoom(room.id, 1)[0];
    assert.match(run?.prompt ?? '', /Skill: superpowers:brainstorming/);
  } finally {
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('respondAsAgent skips project bootstrap when settings owner is provider', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-superpowers-provider-owner-'));
  const project = projectRepo.create({ name: `superpowers-provider-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  settingsRepo.updateRoom(room.id, { superpowers_bootstrap_owner: 'provider' });
  const planner = roomAgentRepo.listByRoom(room.id).find((agent) => agent.agent_id === 'planner');
  assert.ok(planner);

  const originalAdapter = adapters.codex;
  let capturedPrompt = '';
  let capturedEnvOverrides: Record<string, string> | undefined;
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      capturedPrompt = args.prompt;
      capturedEnvOverrides = args.envOverrides;
      args.onChunk({ stream: 'stdout', text: 'done' });
      return { exitCode: 0, sessionId: null, stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    await respondAsAgent({
      agent: planner,
      projectPath,
      roomId: room.id,
      prompt: 'hi',
    });

    assert.doesNotMatch(capturedPrompt, /You have superpowers\./);
    assert.equal(capturedEnvOverrides?.OPENCLAW_SUPERPOWERS_BOOTSTRAP_OWNER, 'provider');
    assert.equal(capturedEnvOverrides?.OPENDEEPSEA_SUPERPOWERS_BOOTSTRAP_OWNER, 'provider');
    assert.equal(capturedEnvOverrides?.SUPERPOWERS_BOOTSTRAP_DISABLED, undefined);
    const run = agentRunRepo.listByRoom(room.id, 1)[0];
    assert.equal(run?.superpowers_bootstrap_owner, 'provider');
    assert.equal(run?.superpowers_bootstrap_injected, 0);
    assert.equal(run?.superpowers_bootstrap_skip_reason, 'provider_owner');
  } finally {
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('respondAsAgent disables provider superpowers bootstrap during workflow runs', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-superpowers-workflow-provider-'));
  const project = projectRepo.create({ name: `superpowers-workflow-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  settingsRepo.updateRoom(room.id, { superpowers_bootstrap_owner: 'provider' });
  const planner = roomAgentRepo.listByRoom(room.id).find((agent) => agent.agent_id === 'planner');
  assert.ok(planner);

  const originalAdapter = adapters.codex;
  let capturedPrompt = '';
  let capturedEnvOverrides: Record<string, string> | undefined;
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      capturedPrompt = args.prompt;
      capturedEnvOverrides = args.envOverrides;
      args.onChunk({ stream: 'stdout', text: 'done' });
      return { exitCode: 0, sessionId: null, stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    await respondAsAgent({
      agent: planner,
      projectPath,
      roomId: room.id,
      workflowRunId: 'workflow-1',
      prompt: '执行 workflow 步骤',
    });

    assert.doesNotMatch(capturedPrompt, /You have superpowers\./);
    assert.equal(capturedEnvOverrides?.OPENCLAW_SUPERPOWERS_BOOTSTRAP_OWNER, 'provider');
    assert.equal(capturedEnvOverrides?.OPENDEEPSEA_SUPERPOWERS_BOOTSTRAP_OWNER, 'provider');
    assert.equal(capturedEnvOverrides?.SUPERPOWERS_BOOTSTRAP_DISABLED, '1');
    const run = agentRunRepo.listByRoom(room.id, 1)[0];
    assert.equal(run?.superpowers_bootstrap_owner, 'provider');
    assert.equal(run?.superpowers_bootstrap_injected, 0);
    assert.equal(run?.superpowers_bootstrap_skip_reason, 'workflow_run');
  } finally {
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('planner dispatch auto-adds matching global agent before dispatching', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-planner-global-agent-'));
  const project = projectRepo.create({ name: `planner-global-agent-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const globalAgent = agentRepo.create({
    agent_id: `runtime-inspector-${Date.now()}`,
    name: 'Runtime Inspector',
    description: '检查 ACP 运行上下文',
    default_acp_backend: 'codex',
    default_acp_permission_mode: 'read-only',
  });
  const sourceMessage = messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: '检查 Codex 上下文',
    message_type: 'text',
  });

  const originalAdapter = adapters.codex;
  let capturedPrompt: string | undefined;
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      capturedPrompt = args.prompt;
      args.onChunk({ stream: 'stdout', text: '运行上下文正常' });
      return { exitCode: 0, sessionId: null, stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    const beforeAgents = new Set(roomAgentRepo.listByRoom(room.id).map((agent) => agent.agent_id));
    const response = await request(`/api/rooms/${room.id}/planner/dispatch`, {
      method: 'POST',
      body: JSON.stringify({
        source_message_id: sourceMessage.id,
        planner_decision: {
          mode: 'pause_after_suggestion',
          status: 'suggested',
          summary: '建议检查运行上下文',
          next_steps: [{ agent_id: globalAgent.agent_id, goal: '检查 Codex CLI 启动规则' }],
          awaiting_user_confirmation: true,
        },
      }),
    });
    const body = await response.json() as {
      dispatched?: number;
      added_agents?: Array<{ agent_id: string; agent_name: string }>;
    };

    assert.equal(response.status, 200);
    assert.equal(body.dispatched, 1);
    assert.deepEqual(body.added_agents, [{ agent_id: globalAgent.agent_id, agent_name: 'Runtime Inspector' }]);
    assert.ok(roomAgentRepo.listByRoom(room.id).some((agent) => agent.agent_id === globalAgent.agent_id));
    assert.equal(agentRunRepo.listByRoom(room.id, 20).some((run) => run.agent_id === globalAgent.agent_id), true);
    assert.match(capturedPrompt ?? '', /检查 Codex CLI 启动规则/);
  } finally {
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('planner dispatch falls back to best global agent search for unknown suggested id', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-planner-global-search-'));
  const project = projectRepo.create({ name: `planner-global-search-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const sourceMessage = messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: '检查 Codex 上下文',
    message_type: 'text',
  });

  const originalAdapter = adapters.codex;
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      args.onChunk({ stream: 'stdout', text: '已检查运行上下文' });
      return { exitCode: 0, sessionId: null, stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    const beforeAgents = new Set(roomAgentRepo.listByRoom(room.id).map((agent) => agent.agent_id));
    const response = await request(`/api/rooms/${room.id}/planner/dispatch`, {
      method: 'POST',
      body: JSON.stringify({
        source_message_id: sourceMessage.id,
        planner_decision: {
          mode: 'pause_after_suggestion',
          status: 'suggested',
          summary: '建议检查运行上下文',
          next_steps: [{ agent_id: 'runtime-inspector', goal: '检查 Codex CLI 启动规则' }],
          awaiting_user_confirmation: true,
        },
      }),
    });
    const body = await response.json() as {
      dispatched?: number;
      added_agents?: Array<{ agent_id: string; agent_name: string }>;
    };

    assert.equal(response.status, 200);
    assert.equal(body.dispatched, 1);
    assert.equal(body.added_agents?.length, 1);
    assert.deepEqual(body.added_agents, [{ agent_id: 'computer-assistant', agent_name: '电脑助手' }]);
    assert.ok(!beforeAgents.has(body.added_agents?.[0]?.agent_id ?? ''));
    assert.ok(roomAgentRepo.listByRoom(room.id).some((agent) => agent.agent_id === body.added_agents?.[0]?.agent_id));
    assert.equal(agentRunRepo.listByRoom(room.id, 20).some((run) => run.agent_id === body.added_agents?.[0]?.agent_id), true);
  } finally {
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('planner dispatch maps unknown frontend reviewer request to reviewer agent', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-planner-reviewer-alias-'));
  const project = projectRepo.create({ name: `planner-reviewer-alias-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const sourceMessage = messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: '侧边栏添加一个测试菜单，菜单内容为一个计数器',
    message_type: 'text',
  });

  const originalAdapter = adapters.codex;
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      args.onChunk({ stream: 'stdout', text: '已审查前端改动。' });
      return { exitCode: 0, sessionId: null, stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    const response = await request(`/api/rooms/${room.id}/planner/dispatch`, {
      method: 'POST',
      body: JSON.stringify({
        source_message_id: sourceMessage.id,
        planner_decision: {
          mode: 'pause_after_suggestion',
          status: 'suggested',
          summary: '审查前端改动',
          next_steps: [
            { agent_id: 'frontend-reviewer', goal: '审查前端计数器页面、侧边栏入口、i18n 和可访问性' },
          ],
          awaiting_user_confirmation: true,
        },
      }),
    });
    const body = await response.json() as {
      dispatched?: number;
      added_agents?: Array<{ agent_id: string; agent_name: string }>;
    };
    const runs = agentRunRepo.listByRoom(room.id, 20);

    assert.equal(response.status, 200);
    assert.equal(body.dispatched, 1);
    assert.deepEqual(body.added_agents, [{ agent_id: 'reviewer', agent_name: '审查员' }]);
    assert.equal(runs.some((run) => run.agent_id === 'reviewer'), true);
    assert.equal(runs.some((run) => run.agent_id === 'frontend-executor'), false);
  } finally {
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('planner dispatch maps unknown frontend tester request to qa tester agent', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-planner-tester-alias-'));
  const project = projectRepo.create({ name: `planner-tester-alias-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const sourceMessage = messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: '侧边栏添加一个测试菜单，菜单内容为一个计数器',
    message_type: 'text',
  });

  const originalAdapter = adapters.codex;
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      args.onChunk({ stream: 'stdout', text: '已验证前端改动。' });
      return { exitCode: 0, sessionId: null, stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    const response = await request(`/api/rooms/${room.id}/planner/dispatch`, {
      method: 'POST',
      body: JSON.stringify({
        source_message_id: sourceMessage.id,
        planner_decision: {
          mode: 'pause_after_suggestion',
          status: 'suggested',
          summary: '验证前端改动',
          next_steps: [
            { agent_id: 'frontend-tester', goal: '验证前端计数器页面、侧边栏入口和交互路径' },
          ],
          awaiting_user_confirmation: true,
        },
      }),
    });
    const body = await response.json() as {
      dispatched?: number;
      added_agents?: Array<{ agent_id: string; agent_name: string }>;
    };
    const runs = agentRunRepo.listByRoom(room.id, 20);

    assert.equal(response.status, 200);
    assert.equal(body.dispatched, 1);
    assert.deepEqual(body.added_agents, [{ agent_id: 'qa-tester', agent_name: '测试工程师' }]);
    assert.equal(runs.some((run) => run.agent_id === 'qa-tester'), true);
    assert.equal(runs.some((run) => run.agent_id === 'frontend-executor'), false);
  } finally {
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('planner dispatch defers review steps until execution result returns to planner', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-planner-serial-dispatch-'));
  const project = projectRepo.create({ name: `planner-serial-dispatch-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const frontend = agentRepo.getByAgentId('frontend-executor');
  const qa = agentRepo.getByAgentId('qa-tester');
  assert.ok(frontend);
  assert.ok(qa);
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: frontend.id });
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: qa.id });
  const sourceMessage = messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: '在侧边栏添加一个测试菜单，内容为一个计数器',
    message_type: 'text',
  });

  const originalAdapter = adapters.codex;
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      if (args.prompt.includes('本轮派发的智能体已经完成')) {
        args.onChunk({ stream: 'stdout', text: '规划师收到前端结果，下一步再安排测试工程师。' });
      } else if (args.prompt.includes('新增“测试”菜单')) {
        args.onChunk({ stream: 'stdout', text: '前端开发完成：已新增测试菜单和计数器页面。' });
      } else {
        args.onChunk({ stream: 'stdout', text: 'unexpected' });
      }
      return { exitCode: 0, sessionId: null, stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    let plannerInputSeen = false;
    setPlannerExecutionPlanInvokerForTest({
      async invoke(input) {
        plannerInputSeen = input.targets.length === 2 &&
          input.targets[0]?.step.agent_id === 'frontend-executor' &&
          input.targets[1]?.step.agent_id === 'qa-tester' &&
          input.sourceMessage?.content.includes('计数器') === true;
        return {
          mode: 'serial',
          dispatch_step_indexes: [0],
          deferred_step_indexes: [1],
          rationale: '测试依赖前端开发结果，必须串行。',
        };
      },
    });
    const response = await request(`/api/rooms/${room.id}/planner/dispatch`, {
      method: 'POST',
      body: JSON.stringify({
        source_message_id: sourceMessage.id,
        planner_decision: {
          mode: 'pause_after_suggestion',
          status: 'suggested',
          summary: '先开发再测试',
          next_steps: [
            { agent_id: 'frontend-executor', goal: '在真实仓库中定位侧边栏配置，新增“测试”菜单及计数器页面' },
            { agent_id: 'qa-tester', goal: '验证侧边栏入口展示、页面跳转和计数器交互是否正常' },
          ],
          awaiting_user_confirmation: true,
        },
      }),
    });
    const body = await response.json() as { dispatched?: number; deferred_steps?: Array<{ agent_id: string; goal: string }> };
    const runs = agentRunRepo.listByRoom(room.id, 20);

    assert.equal(response.status, 200);
    assert.equal(plannerInputSeen, true);
    assert.equal(body.dispatched, 1);
    assert.deepEqual(body.deferred_steps?.map((step) => step.agent_id), ['qa-tester']);
    assert.equal(runs.some((run) => run.agent_id === 'frontend-executor'), true);
    assert.equal(runs.some((run) => run.agent_id === 'qa-tester'), false);
    assert.equal(
      agentRunRepo.listByRoom(room.id, 20).some((run) =>
        run.agent_id === 'planner' &&
        run.prompt.includes('暂缓的后续步骤') &&
        run.prompt.includes('qa-tester') &&
        run.stdout.includes('规划师收到前端结果'),
      ),
      true,
    );
  } finally {
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('planner follow-up auto continues suggested next steps after dispatched agent completes', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-planner-followup-auto-'));
  const project = projectRepo.create({ name: `planner-followup-auto-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const frontend = agentRepo.getByAgentId('frontend-executor');
  const qa = agentRepo.getByAgentId('qa-tester');
  assert.ok(frontend);
  assert.ok(qa);
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: frontend.id });
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: qa.id });
  const sourceMessage = messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: '侧边栏添加一个测试菜单，页面内容为一个计数器',
    message_type: 'text',
  });

  const originalAdapter = adapters.codex;
  const events = captureRoomEvents(room.id);
  const plannerFollowupPrompts: string[] = [];
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      if (args.prompt.includes('本轮派发的智能体已经完成')) {
        plannerFollowupPrompts.push(args.prompt);
        const isAfterQa = args.prompt.includes('已执行智能体：测试工程师') || args.prompt.includes('(qa-tester)');
        args.onChunk({
          stream: 'stdout',
          text: isAfterQa
            ? [
                '测试已完成，任务可以收口。',
                '',
                '```json',
                JSON.stringify({
                  planner_decision: {
                    mode: 'pause_after_suggestion',
                    status: 'completed',
                    summary: '测试工程师已验证计数器菜单，暂无后续派发',
                    next_steps: [],
                    awaiting_user_confirmation: false,
                  },
                }),
                '```',
              ].join('\n')
            : [
                '前端执行者已完成实现，下一步自动交给测试工程师验证。',
                '',
                '```json',
                JSON.stringify({
                  planner_decision: {
                    mode: 'pause_after_suggestion',
                    status: 'suggested',
                    summary: '派发测试工程师验证计数器菜单',
                    next_steps: [
                      { agent_id: 'qa-tester', goal: '验证侧边栏测试菜单、/test 路由和计数器交互' },
                    ],
                    awaiting_user_confirmation: true,
                  },
                }),
                '```',
              ].join('\n'),
        });
      } else if (args.prompt.includes('名称：测试工程师')) {
        args.onChunk({ stream: 'stdout', text: '测试工程师完成：侧边栏入口、/test 路由和计数器交互正常。' });
      } else {
        args.onChunk({ stream: 'stdout', text: '前端执行者完成：已新增测试菜单和计数器页面。' });
      }
      return { exitCode: 0, sessionId: null, stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    const response = await request(`/api/rooms/${room.id}/planner/dispatch`, {
      method: 'POST',
      body: JSON.stringify({
        source_message_id: sourceMessage.id,
        planner_decision: {
          mode: 'pause_after_suggestion',
          status: 'suggested',
          summary: '派发前端执行者实现测试菜单',
          next_steps: [
            { agent_id: 'frontend-executor', goal: '新增侧边栏测试菜单、/test 路由和计数器页面' },
          ],
          awaiting_user_confirmation: true,
        },
      }),
    });
    const body = await response.json() as { dispatched?: number; deferred_steps?: Array<{ agent_id: string }> };
    const runs = agentRunRepo.listByRoom(room.id, 20);
    const plannerReply = messageRepo.listByRoom(room.id, 20)
      .find((message) => message.sender_id === 'planner' && message.content.includes('派发测试工程师验证计数器菜单'));

    assert.equal(response.status, 200);
    assert.equal(body.dispatched, 1);
    assert.deepEqual(body.deferred_steps, []);
    assert.equal(plannerFollowupPrompts.length, 2);
    assert.equal(runs.some((run) => run.agent_id === 'frontend-executor'), true);
    assert.equal(runs.some((run) => run.agent_id === 'qa-tester'), true);
    assert.ok(plannerReply);
    const metadata = JSON.parse(plannerReply.metadata ?? '{}') as MessageMetadata;
    assert.equal(metadata.planner_decision?.mode, 'auto_continue');
    assert.equal(metadata.planner_decision?.awaiting_user_confirmation, false);
    assert.equal(metadata.planner_decision?.next_steps[0]?.agent_id, 'qa-tester');

    const plannerDoneIndex = events.findIndex((event) =>
      event.type === 'message:stream' &&
      event.done === true &&
      event.messageId === plannerReply.id &&
      event.message?.metadata?.includes('"auto_continue"') === true
    );
    const qaRunCreatedIndex = events.findIndex((event) =>
      event.type === 'agent_run:created' &&
      event.run.agent_id === 'qa-tester'
    );
    assert.ok(plannerDoneIndex >= 0, 'expected planner final message snapshot with auto_continue metadata');
    assert.ok(qaRunCreatedIndex >= 0, 'expected auto-continued qa-tester run to be created');
    assert.ok(
      plannerDoneIndex < qaRunCreatedIndex,
      'planner final message snapshot should reach clients before auto-continued agent starts',
    );
  } finally {
    events.restore();
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('planner follow-up blocks auto continue when suggested agent cannot be dispatched', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-planner-followup-auto-failure-'));
  const project = projectRepo.create({ name: `planner-followup-auto-failure-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const frontend = agentRepo.getByAgentId('frontend-executor');
  assert.ok(frontend);
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: frontend.id });
  const sourceMessage = messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: '先实现页面，然后继续给不存在的智能体',
    message_type: 'text',
  });

  const originalAdapter = adapters.codex;
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      if (args.prompt.includes('本轮派发的智能体已经完成')) {
        args.onChunk({
          stream: 'stdout',
          text: [
            '前端已完成，继续派发给不存在的智能体。',
            '',
            '```json',
            JSON.stringify({
              planner_decision: {
                mode: 'pause_after_suggestion',
                status: 'suggested',
                summary: '继续派发不存在的智能体',
                next_steps: [
                  { agent_id: 'ghost-worker-z', goal: '处理未定义步骤' },
                ],
                awaiting_user_confirmation: true,
              },
            }),
            '```',
          ].join('\n'),
        });
      } else {
        args.onChunk({ stream: 'stdout', text: '前端执行者完成：页面已实现。' });
      }
      return { exitCode: 0, sessionId: null, stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    const response = await request(`/api/rooms/${room.id}/planner/dispatch`, {
      method: 'POST',
      body: JSON.stringify({
        source_message_id: sourceMessage.id,
        planner_decision: {
          mode: 'pause_after_suggestion',
          status: 'suggested',
          summary: '派发前端执行者',
          next_steps: [
            { agent_id: 'frontend-executor', goal: '实现页面' },
          ],
          awaiting_user_confirmation: true,
        },
      }),
    });
    const messages = messageRepo.listByRoom(room.id, 50);
    const plannerReply = messages
      .find((message) => message.sender_id === 'planner' && message.content.includes('继续派发不存在的智能体'));
    const systemMessage = messages
      .find((message) => message.sender_type === 'system' && message.content.includes('Planner auto-continue failed'));

    assert.equal(response.status, 200);
    assert.ok(plannerReply);
    const metadata = JSON.parse(plannerReply.metadata ?? '{}') as MessageMetadata;
    assert.equal(metadata.planner_decision?.mode, 'auto_continue');
    assert.equal(metadata.planner_decision?.status, 'blocked');
    assert.equal(metadata.planner_decision?.awaiting_user_confirmation, false);
    assert.equal(metadata.planner_decision?.next_steps.length, 0);
    assert.match(metadata.planner_decision?.summary ?? '', /ghost-worker-z/);
    assert.ok(systemMessage);
  } finally {
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('planner follow-up blocks instead of showing continue button when auto continue depth limit is reached', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-planner-followup-auto-depth-'));
  const project = projectRepo.create({ name: `planner-followup-auto-depth-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const frontend = agentRepo.getByAgentId('frontend-executor');
  const qa = agentRepo.getByAgentId('qa-tester');
  assert.ok(frontend);
  assert.ok(qa);
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: frontend.id });
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: qa.id });
  const sourceMessage = messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: '持续验证直到达到自动续派发上限',
    message_type: 'text',
  });

  const originalAdapter = adapters.codex;
  const plannerFollowupPrompts: string[] = [];
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      if (args.prompt.includes('本轮派发的智能体已经完成')) {
        plannerFollowupPrompts.push(args.prompt);
        args.onChunk({
          stream: 'stdout',
          text: [
            `第 ${plannerFollowupPrompts.length} 轮继续派发测试。`,
            '',
            '```json',
            JSON.stringify({
              planner_decision: {
                mode: 'pause_after_suggestion',
                status: 'suggested',
                summary: `第 ${plannerFollowupPrompts.length} 轮继续测试`,
                next_steps: [
                  { agent_id: 'qa-tester', goal: `继续验证第 ${plannerFollowupPrompts.length} 轮` },
                ],
                awaiting_user_confirmation: true,
              },
            }),
            '```',
          ].join('\n'),
        });
      } else if (args.prompt.includes('名称：测试工程师')) {
        args.onChunk({ stream: 'stdout', text: '测试工程师完成一轮验证。' });
      } else {
        args.onChunk({ stream: 'stdout', text: '前端执行者完成初始实现。' });
      }
      return { exitCode: 0, sessionId: null, stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    const response = await request(`/api/rooms/${room.id}/planner/dispatch`, {
      method: 'POST',
      body: JSON.stringify({
        source_message_id: sourceMessage.id,
        planner_decision: {
          mode: 'pause_after_suggestion',
          status: 'suggested',
          summary: '派发前端执行者',
          next_steps: [
            { agent_id: 'frontend-executor', goal: '实现初始页面' },
          ],
          awaiting_user_confirmation: true,
        },
      }),
    });
    const runs = agentRunRepo.listByRoom(room.id, 100);
    const plannerReplies = messageRepo.listByRoom(room.id, 100)
      .filter((message) => message.sender_id === 'planner');
    const latestPlannerReply = plannerReplies[plannerReplies.length - 1];

    assert.equal(response.status, 200);
    assert.equal(plannerFollowupPrompts.length, 6);
    assert.equal(runs.filter((run) => run.agent_id === 'qa-tester').length, 5);
    assert.ok(latestPlannerReply);
    const metadata = JSON.parse(latestPlannerReply.metadata ?? '{}') as MessageMetadata;
    assert.equal(metadata.planner_decision?.mode, 'auto_continue');
    assert.equal(metadata.planner_decision?.status, 'blocked');
    assert.equal(metadata.planner_decision?.awaiting_user_confirmation, false);
    assert.equal(metadata.planner_decision?.next_steps.length, 0);
    assert.match(metadata.planner_decision?.summary ?? '', /自动续派发已达到上限/);
  } finally {
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('planner dispatch reports completed agent results back to planner even without deferred steps', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-planner-followup-all-agents-'));
  const project = projectRepo.create({ name: `planner-followup-all-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const backend = agentRepo.getByAgentId('backend-executor');
  assert.ok(backend);
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: backend.id });
  const sourceMessage = messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: '修复规划师 ACP 保存后刷新回退的问题',
    message_type: 'text',
  });

  const originalAdapter = adapters.codex;
  const plannerFollowupPrompts: string[] = [];
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      if (args.prompt.includes('本轮派发的智能体已经完成')) {
        plannerFollowupPrompts.push(args.prompt);
        args.onChunk({
          stream: 'stdout',
          text: [
            '我已收到执行结果，任务完成。',
            '',
            '```json',
            JSON.stringify({
              planner_decision: {
                mode: 'pause_after_suggestion',
                status: 'completed',
                summary: '后端执行者已完成修复，暂无后续派发',
                next_steps: [],
                awaiting_user_confirmation: false,
              },
            }),
            '```',
          ].join('\n'),
        });
      } else {
        args.onChunk({ stream: 'stdout', text: '后端执行者完成：已修复保存后刷新回退问题。' });
      }
      return { exitCode: 0, sessionId: null, stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    const response = await request(`/api/rooms/${room.id}/planner/dispatch`, {
      method: 'POST',
      body: JSON.stringify({
        source_message_id: sourceMessage.id,
        planner_decision: {
          mode: 'pause_after_suggestion',
          status: 'suggested',
          summary: '派发后端执行者修复 ACP 保存回退',
          next_steps: [
            { agent_id: 'backend-executor', goal: '修复规划师 ACP 保存后刷新回退的问题，并补充回归测试' },
          ],
          awaiting_user_confirmation: true,
        },
      }),
    });
    const body = await response.json() as { dispatched?: number; deferred_steps?: Array<{ agent_id: string }> };
    const runs = agentRunRepo.listByRoom(room.id, 20);
    const plannerReply = messageRepo.listByRoom(room.id, 20)
      .find((message) => message.sender_id === 'planner' && message.content.includes('后端执行者已完成修复'));

    assert.equal(response.status, 200);
    assert.equal(body.dispatched, 1);
    assert.deepEqual(body.deferred_steps, []);
    assert.equal(runs.some((run) => run.agent_id === 'backend-executor'), true);
    assert.equal(runs.some((run) => run.agent_id === 'planner'), true);
    assert.equal(plannerFollowupPrompts.length, 1);
    assert.match(plannerFollowupPrompts[0] ?? '', /本轮派发的智能体已经完成/);
    assert.match(plannerFollowupPrompts[0] ?? '', /后端执行者完成：已修复保存后刷新回退问题/);
    assert.ok(plannerReply);
    const metadata = JSON.parse(plannerReply.metadata ?? '{}') as MessageMetadata;
    assert.equal(metadata.planner_decision?.status, 'completed');
  } finally {
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('planner dispatch reports failed agent status and error back to planner', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-planner-followup-failed-agent-'));
  const project = projectRepo.create({ name: `planner-followup-failed-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const backend = agentRepo.getByAgentId('backend-executor');
  assert.ok(backend);
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: backend.id });
  const sourceMessage = messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: '修复后端接口',
    message_type: 'text',
  });

  const originalAdapter = adapters.codex;
  const plannerFollowupPrompts: string[] = [];
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      if (args.prompt.includes('本轮派发的智能体已经完成')) {
        plannerFollowupPrompts.push(args.prompt);
        args.onChunk({
          stream: 'stdout',
          text: [
            '执行失败，需要阻塞。',
            '',
            '```json',
            JSON.stringify({
              planner_decision: {
                mode: 'pause_after_suggestion',
                status: 'blocked',
                summary: '后端执行失败，需要重新处理',
                next_steps: [],
                awaiting_user_confirmation: true,
              },
            }),
            '```',
          ].join('\n'),
        });
        return { exitCode: 0, sessionId: null, stderr: '' };
      }
      args.onChunk({ stream: 'stdout', text: '已尝试修改接口。' });
      args.onChunk({ stream: 'stderr', text: 'TypeScript compilation failed' });
      return { exitCode: 1, sessionId: null, stderr: 'TypeScript compilation failed' };
    },
  } satisfies SessionAdapter;

  try {
    const response = await request(`/api/rooms/${room.id}/planner/dispatch`, {
      method: 'POST',
      body: JSON.stringify({
        source_message_id: sourceMessage.id,
        planner_decision: {
          mode: 'pause_after_suggestion',
          status: 'suggested',
          summary: '派发后端执行者修复接口',
          next_steps: [
            { agent_id: 'backend-executor', goal: '修复后端接口并运行 TypeScript 编译' },
          ],
          awaiting_user_confirmation: true,
        },
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(plannerFollowupPrompts.length, 1);
    assert.match(plannerFollowupPrompts[0] ?? '', /状态：failed/);
    assert.match(plannerFollowupPrompts[0] ?? '', /错误：TypeScript compilation failed/);
    assert.match(plannerFollowupPrompts[0] ?? '', /返回摘要：已尝试修改接口/);
  } finally {
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('planner dispatch reports missing room and global agents instead of accepting without work', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-planner-missing-agent-'));
  const project = projectRepo.create({ name: `planner-missing-agent-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const missingAgentId = `unmapped-specialist-${Date.now()}`;
  const sourceMessage = messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: '检查 Codex 上下文',
    message_type: 'text',
  });

  try {
    const response = await request(`/api/rooms/${room.id}/planner/dispatch`, {
      method: 'POST',
      body: JSON.stringify({
        source_message_id: sourceMessage.id,
        planner_decision: {
          mode: 'pause_after_suggestion',
          status: 'suggested',
          summary: '建议执行无法匹配的专业任务',
          next_steps: [{ agent_id: missingAgentId, goal: '分析深海声呐样本的鲸类迁徙模式' }],
          awaiting_user_confirmation: true,
        },
      }),
    });
    const body = await response.json() as { error?: unknown };

    assert.equal(response.status, 400);
    assert.match(JSON.stringify(body.error), new RegExp(missingAgentId));
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('respondAsAgent forces read-only and empty writable dirs for reviewer runtime profile', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-runtime-readonly-test-'));
  const project = projectRepo.create({ name: `runtime-readonly-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const global = agentRepo.getByAgentId('reviewer');
  assert.ok(global);
  const agent = roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: global.id });

  const originalAdapter = adapters.codex;
  let capturedWritableDirs: string[] | null | undefined;
  let capturedPermissionMode: string | null | undefined;
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      capturedWritableDirs = args.acpWritableDirs;
      capturedPermissionMode = args.acpPermissionMode;
      args.onChunk({ stream: 'stdout', text: 'reviewed' });
      return { exitCode: 0, sessionId: null, stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    await respondAsAgent({
      agent,
      projectPath,
      roomId: room.id,
      prompt: '审查后端',
    });

    assert.deepEqual(capturedWritableDirs, []);
    assert.equal(capturedPermissionMode, 'read-only');
  } finally {
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('respondAsAgent marks final stream event failed without mixing stderr into message content', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-stream-error-test-'));
  const project = projectRepo.create({ name: `stream-error-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const agent = roomAgentRepo.add({ room_id: room.id, agent_id: 'stream-error-agent', agent_name: 'StreamErrorAgent' });
  const acpAgent = roomAgentRepo.setAcp(agent.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'bypass',
    acp_writable_dirs: [],
  });
  assert.ok(acpAgent);

  const events = captureRoomEvents(room.id);
  const originalAdapter = adapters.codex;
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      args.onChunk({ stream: 'stdout', text: 'partial answer' });
      args.onChunk({ stream: 'stderr', text: 'cli exploded' });
      return { exitCode: 1, sessionId: null, stderr: 'cli exploded' };
    },
  } satisfies SessionAdapter;

  try {
    await respondAsAgent({
      agent: acpAgent,
      projectPath,
      roomId: room.id,
      prompt: '请失败',
    });

    const reply = messageRepo.listByRoom(room.id).find((item) => item.sender_id === acpAgent.agent_id);
    const run = agentRunRepo.listByRoom(room.id, 1)[0];
    assert.equal(reply?.content, 'partial answer');
    assert.equal(run?.status, 'failed');
    assert.equal(run?.stdout, 'partial answer');
    assert.equal(run?.stderr, 'cli exploded');
    assert.ok(events.some((event) =>
      event.type === 'message:stream' &&
      event.messageId === reply?.id &&
      event.done === true &&
      event.status === 'failed' &&
      event.error === 'cli exploded'
    ));
  } finally {
    events.restore();
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('respondAsAgent annotates explicit planner decision even when ACP prompt times out after output', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-planner-timeout-decision-'));
  const project = projectRepo.create({ name: `planner-timeout-decision-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = roomAgentRepo.listByRoom(room.id).find((agent) => agent.agent_id === 'planner');
  assert.ok(planner);
  const acpPlanner = roomAgentRepo.setAcp(planner.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'read-only',
    acp_writable_dirs: [],
  });
  assert.ok(acpPlanner);
  const originalAdapter = adapters.codex;
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      args.onChunk({
        stream: 'stdout',
        text: [
          '建议交给前端执行。',
          '',
          '```json',
          JSON.stringify({
            planner_decision: {
              mode: 'pause_after_suggestion',
              status: 'suggested',
              summary: '修复协议调试重叠',
              next_steps: [
                { agent_id: 'frontend-executor', goal: '修复 AgentTimeline 协议调试计数布局' },
              ],
              awaiting_user_confirmation: true,
            },
          }),
          '```',
        ].join('\n'),
      });
      return { exitCode: -1, sessionId: null, stderr: 'ACP prompt timed out' };
    },
  } satisfies SessionAdapter;

  try {
    await respondAsAgent({
      agent: acpPlanner,
      projectPath,
      roomId: room.id,
      prompt: '请规划',
    });

    const reply = messageRepo.listByRoom(room.id).find((item) => item.sender_id === 'planner');
    assert.ok(reply);
    const metadata = JSON.parse(reply.metadata ?? '{}') as MessageMetadata;
    assert.equal(metadata.planner_decision?.summary, '修复协议调试重叠');
    assert.equal(metadata.planner_decision?.next_steps[0]?.agent_id, 'frontend-executor');
    assert.equal(agentRunRepo.listByRoom(room.id, 1)[0]?.status, 'failed');
  } finally {
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('message list refreshes stale planner metadata from explicit decision content', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-planner-late-decision-'));
  const project = projectRepo.create({ name: `planner-late-decision-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const userMessage = messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: '侧边栏添加一个测试菜单，菜单内容为一个计数器',
    message_type: 'text',
  });
  const plannerReply = messageRepo.create({
    room_id: room.id,
    sender_type: 'agent',
    sender_id: 'planner',
    sender_name: '规划师',
    content: [
      '建议交给前端执行。',
      '',
      '```json',
      JSON.stringify({
        planner_decision: {
          mode: 'pause_after_suggestion',
          status: 'suggested',
          summary: '实现测试计数器菜单',
          next_steps: [
            { agent_id: 'frontend-executor', goal: '新增测试菜单和计数器页面' },
          ],
          awaiting_user_confirmation: true,
        },
      }),
      '```',
    ].join('\n'),
    message_type: 'agent_stream',
    metadata: {
      planner_decision: {
        mode: 'pause_after_suggestion',
        status: 'suggested',
        summary: '建议交给前端执行。',
        next_steps: [],
        awaiting_user_confirmation: true,
      },
      source_message_id: userMessage.id,
    },
  });

  try {
    const response = await request(`/api/rooms/${room.id}/messages`);
    assert.equal(response.status, 200);
    const body = await response.json() as Message[];
    const reply = body.find((item) => item.id === plannerReply.id);
    assert.ok(reply);

    const metadata = JSON.parse(reply.metadata ?? '{}') as MessageMetadata;
    assert.equal(metadata.planner_decision?.summary, '实现测试计数器菜单');
    assert.equal(metadata.planner_decision?.next_steps.length, 1);
    assert.equal(metadata.planner_decision?.next_steps[0]?.agent_id, 'frontend-executor');

    const persisted = messageRepo.get(plannerReply.id);
    assert.ok(persisted);
    const persistedMetadata = JSON.parse(persisted.metadata ?? '{}') as MessageMetadata;
    assert.equal(persistedMetadata.planner_decision?.next_steps[0]?.agent_id, 'frontend-executor');
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('message list preserves auto-continue planner metadata normalized after follow-up dispatch', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-planner-auto-decision-'));
  const project = projectRepo.create({ name: `planner-auto-decision-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const userMessage = messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: '侧边栏添加一个测试菜单，菜单内容为一个计数器',
    message_type: 'text',
  });
  const plannerReply = messageRepo.create({
    room_id: room.id,
    sender_type: 'agent',
    sender_id: 'planner',
    sender_name: '规划师',
    content: [
      '前端执行完成，继续派发测试。',
      '',
      '```json',
      JSON.stringify({
        planner_decision: {
          mode: 'pause_after_suggestion',
          status: 'suggested',
          summary: '派发测试工程师验证计数器菜单',
          next_steps: [
            { agent_id: 'qa-tester', goal: '验证侧边栏测试菜单、/test 路由和计数器交互' },
          ],
          awaiting_user_confirmation: true,
        },
      }),
      '```',
    ].join('\n'),
    message_type: 'agent_stream',
    metadata: {
      planner_decision: {
        mode: 'auto_continue',
        status: 'suggested',
        summary: '派发测试工程师验证计数器菜单',
        next_steps: [
          { agent_id: 'qa-tester', goal: '验证侧边栏测试菜单、/test 路由和计数器交互' },
        ],
        awaiting_user_confirmation: false,
      },
      source_message_id: userMessage.id,
    },
  });

  try {
    const messages = messageRepo.listByRoom(room.id, 20);
    const reply = messages.find((item) => item.id === plannerReply.id);
    assert.ok(reply);
    const metadata = JSON.parse(reply.metadata ?? '{}') as MessageMetadata;
    assert.equal(metadata.planner_decision?.mode, 'auto_continue');
    assert.equal(metadata.planner_decision?.awaiting_user_confirmation, false);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('respondAsAgent does not annotate failed planner plain text as dispatchable decision', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-planner-timeout-plain-'));
  const project = projectRepo.create({ name: `planner-timeout-plain-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = roomAgentRepo.listByRoom(room.id).find((agent) => agent.agent_id === 'planner');
  assert.ok(planner);
  const acpPlanner = roomAgentRepo.setAcp(planner.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'read-only',
    acp_writable_dirs: [],
  });
  assert.ok(acpPlanner);

  const originalAdapter = adapters.codex;
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      args.onChunk({ stream: 'stdout', text: '我还在分析，尚未形成下一步。' });
      return { exitCode: -1, sessionId: null, stderr: 'ACP prompt timed out' };
    },
  } satisfies SessionAdapter;

  try {
    await respondAsAgent({
      agent: acpPlanner,
      projectPath,
      roomId: room.id,
      prompt: '请规划',
    });

    const reply = messageRepo.listByRoom(room.id).find((item) => item.sender_id === 'planner');
    assert.ok(reply);
    const metadata = JSON.parse(reply.metadata ?? '{}') as MessageMetadata;
    assert.equal(metadata.planner_decision, undefined);
  } finally {
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('dispatchUserMessage triggers model distill after completed ACP reply when enabled', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-acp-distill-test-'));
  const skillPath = await mkdtemp(join(tmpdir(), 'openclaw-room-memory-skill-dir-'));
  await mkdir(skillPath, { recursive: true });
  await writeFile(join(skillPath, 'SKILL.md'), [
    '---',
    'name: memory-runtime-skill',
    'description: Runtime memory skill',
    '---',
    'Capture memory using runtime memory guidance.',
  ].join('\n'));
  const project = projectRepo.create({ name: `acp-distill-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const skill = skillRepo.createSkill({
    id: `skill-memory-${Date.now()}`,
    name: 'memory-runtime-skill',
    description: 'Runtime memory skill',
    source_type: 'manual',
    install_path: skillPath,
    runtime_scopes: ['memory'],
    trigger_mode: 'always_for_scope',
    trigger_keywords: [],
    priority: 10,
  });
  skillRepo.upsertBinding({
    id: `binding-memory-${Date.now()}`,
    skill_id: skill.id,
    scope: 'room',
    scope_id: room.id,
    enabled: true,
  });
  const agent = roomAgentRepo.add({ room_id: room.id, agent_id: 'codex-distill', agent_name: 'CodexDistill' });
  roomAgentRepo.setAcp(agent.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'bypass',
    acp_writable_dirs: [],
  });
  settingsRepo.updateProject(project.id, {
    message_routing_mode: 'fallback_reply',
    fallback_agent_id: agent.agent_id,
    auto_distill_enabled: true,
  });

  const originalAdapter = adapters.codex;
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      args.onChunk?.({ stream: 'stdout', text: 'Codex ACP 可以回复。' });
      return { exitCode: 0, sessionId: null, stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    const message = messageRepo.create({
      room_id: room.id,
      sender_type: 'user',
      sender_id: 'user',
      sender_name: 'You',
      content: '请确认 Codex ACP 是否可用。',
      message_type: 'text',
    });

    await dispatchUserMessage({
      roomId: room.id,
      userMessage: message,
      distillModelInvoker: async (prompt) => {
        assert.match(prompt, /Codex ACP 可以回复/);
        assert.match(prompt, /OpenDeepSea active skills for this runtime/);
        assert.match(prompt, /Skill: memory-runtime-skill/);
        return JSON.stringify([
          { scope: 'room', memory_type: 'fact', title: 'ACP 可用', content: 'Codex ACP 可以回复。' },
        ]);
      },
    });
    await waitFor(() => memoryRepo.list({ projectId: project.id, roomId: room.id }).length > 0);

    const memories = memoryRepo.list({ projectId: project.id, roomId: room.id });
    const agentReply = messageRepo.listByRoom(room.id).find((item) => item.sender_id === agent.agent_id);
    assert.ok(agentReply);
    assert.ok(
      memories.some((item) => item.source_id?.startsWith(`${agentReply.id}#distill-`)),
      'expected distill memory to use final agent reply as triggerMessageId',
    );
  } finally {
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
    await rm(skillPath, { recursive: true, force: true });
  }
});

test('dispatchUserMessage does not let disabled or missing model distill block ACP reply', async () => {
  const restoreModelEnv = clearModelEnv();
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-acp-no-distill-test-'));
  const project = projectRepo.create({ name: `acp-no-distill-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const disabledAgent = roomAgentRepo.add({ room_id: room.id, agent_id: 'disabled-distill', agent_name: 'DisabledDistill' });
  const missingModelAgent = roomAgentRepo.add({ room_id: room.id, agent_id: 'missing-model-distill', agent_name: 'MissingModelDistill' });
  for (const agent of [disabledAgent, missingModelAgent]) {
    roomAgentRepo.setAcp(agent.id, {
      acp_enabled: true,
      acp_backend: 'codex',
      acp_session_id: null,
      acp_session_label: null,
      acp_permission_mode: 'bypass',
      acp_writable_dirs: [],
    });
  }
  const originalAdapter = adapters.codex;
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      args.onChunk?.({ stream: 'stdout', text: 'ACP reply completed.' });
      return { exitCode: 0, sessionId: null, stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    settingsRepo.updateProject(project.id, {
      message_routing_mode: 'fallback_reply',
      fallback_agent_id: disabledAgent.agent_id,
      auto_distill_enabled: false,
    });
    const disabledMessage = messageRepo.create({
      room_id: room.id,
      sender_type: 'user',
      sender_id: 'user',
      sender_name: 'You',
      content: 'disabled distill should still reply',
      message_type: 'text',
    });

    await dispatchUserMessage({ roomId: room.id, userMessage: disabledMessage });

    const repliesAfterDisabled = messageRepo.listByRoom(room.id).filter((item) => item.sender_id === disabledAgent.agent_id);
    assert.equal(repliesAfterDisabled.at(-1)?.content, 'ACP reply completed.');
    assert.equal(memoryRepo.list({ projectId: project.id, roomId: room.id }).length, 0);

    settingsRepo.updateProject(project.id, {
      message_routing_mode: 'fallback_reply',
      fallback_agent_id: missingModelAgent.agent_id,
      auto_distill_enabled: true,
    });
    settingsRepo.updateSystem({
      langchain_planner_model: null,
      openai_api_key: null,
      openai_base_url: null,
    });
    const missingModelMessage = messageRepo.create({
      room_id: room.id,
      sender_type: 'user',
      sender_id: 'user',
      sender_name: 'You',
      content: 'missing model distill should still reply',
      message_type: 'text',
    });

    await dispatchUserMessage({ roomId: room.id, userMessage: missingModelMessage });

    const repliesAfterMissingModel = messageRepo.listByRoom(room.id)
      .filter((item) => item.sender_id === missingModelAgent.agent_id);
    assert.equal(repliesAfterMissingModel.at(-1)?.content, 'ACP reply completed.');
    assert.equal(memoryRepo.list({ projectId: project.id, roomId: room.id }).length, 0);
  } finally {
    adapters.codex = originalAdapter;
    restoreModelEnv();
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('respondAsAgent registers completed agent markdown as resource asset', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-agent-document-test-'));
  const project = projectRepo.create({ name: `agent-document-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const global = agentRepo.getByAgentId('backend-executor');
  assert.ok(global);
  const agent = roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: global.id });

  const originalAdapter = adapters.codex;
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      args.onChunk?.({
        stream: 'stdout',
        text: [
          '# 交付总结',
          '',
          '## 背景',
          '',
          '本次实现补充了智能体生成 Markdown 文档的资源登记链路。',
          '',
          '## 结果',
          '',
          '- 智能体完成回复后自动登记为资源库文档',
          '- 上传文件仍然保留原有预览和下载能力',
          '- 资源列表可以统一展示类型与来源',
          '',
          '## 验收点',
          '',
          '1. 文档资源可追溯到生成消息',
          '2. 资源类型与来源字段完整',
          '3. 重复登记保持幂等',
          '',
          '## 说明',
          '',
          '这份文档用于验证资源登记链路的完整性，内容长度需要超过自动归档阈值，',
          '因此这里补充更完整的文档说明，确保分类器会将其识别为正式的 Markdown 文档。',
          '',
          '## 细节',
          '',
          '本次改动会将完成态的智能体 Markdown 回复登记到资源库中，并保留来源消息、',
          '来源房间、来源智能体和来源任务等追踪字段，以便后续在资源列表和详情页统一展示。',
          '',
          '资源登记应保持幂等：同一来源消息重复完成时，只保留一条 canonical 记录，避免资源库中出现重复文档。',
          '',
          '## 延伸说明',
          '',
          '这次回归测试的目标不是验证分类器的边界，而是验证完成态的资源登记链路是否真的能把',
          '合格的 Markdown 回复写入 `resource_assets`。为了覆盖真实场景，这里额外补充一段较长的说明，',
          '模拟智能体在交付总结中通常会包含的背景、方案、结果和验证内容。只有当内容足够完整时，',
          '分类器才会把它判定为可自动归档的文档资源，随后 dispatcher 才会调用资源登记逻辑。',
          '',
          '在项目实际运行中，这类输出往往包含多段标题、列表、验证结果和来源追踪信息，因此这里的测试',
          '样本也需要尽量贴近真实产物，而不是仅靠一两句简短回复。这样才能确保我们修复的是资源生成链路，',
          '而不是误把短回复、日志片段或临时说明登记成资源库文档。',
          '',
          '## 验证',
          '',
          '- backend build 通过',
          '- 定向测试通过',
        ].join('\n'),
      });
      return { exitCode: 0, sessionId: null, stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    await respondAsAgent({
      agent,
      projectPath,
      roomId: room.id,
      prompt: '请生成交付总结文档',
    });

    const resources = resourceAssetRepo.list({ projectId: project.id, assetType: 'agent_document' });
    assert.equal(resources.length, 1);
    assert.equal(resources[0]?.title, '交付总结');
    const agentMessage = messageRepo.listByRoom(room.id).find((item) => item.sender_id === agent.agent_id);
    assert.ok(agentMessage);
    assert.equal(resources[0]?.source_message_id, agentMessage.id);
    assert.equal(resources[0]?.source_room_id, room.id);
    assert.equal(resources[0]?.source_agent_id, agent.agent_id);
  } finally {
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('respondAsAgent does not register short do_not_archive replies as resource assets', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-agent-document-skip-test-'));
  const project = projectRepo.create({ name: `agent-document-skip-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const global = agentRepo.getByAgentId('backend-executor');
  assert.ok(global);
  const agent = roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: global.id });

  const originalAdapter = adapters.codex;
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      args.onChunk?.({
        stream: 'stdout',
        text: '收到，已处理。',
      });
      return { exitCode: 0, sessionId: null, stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    await respondAsAgent({
      agent,
      projectPath,
      roomId: room.id,
      prompt: '请简单回复确认',
    });

    const resources = resourceAssetRepo.list({ projectId: project.id, assetType: 'agent_document' });
    assert.equal(resources.length, 0);
  } finally {
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('respondAsAgent registers structured markdown documents into resource assets', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-agent-document-resource-test-'));
  const project = projectRepo.create({ name: `agent-document-resource-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const global = agentRepo.getByAgentId('backend-executor');
  assert.ok(global);
  const agent = roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: global.id });

  const originalAdapter = adapters.codex;
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      args.onChunk?.({
        stream: 'stdout',
        text: [
          '# 智能体生成资源库方案文档',
          '',
          '## 目标',
          '',
          '- 说明资源库需要识别智能体 Markdown 文档。',
          '- 说明资源库需要保留来源信息。',
          '- 说明资源记录不能被误标记为用户上传文件。',
          '',
          '## 背景',
          '',
          '本次冒烟验证要求把完成态智能体 Markdown 文档稳定进入资源库，',
          '同时保持消息流和任务流不受影响。',
          '',
          '## 验证方式',
          '',
          '- 后端 build 通过',
          '- 定向测试通过',
          '- 冒烟验收覆盖资源列表和详情读取。',
          '- 资源列表可见文档记录',
          '- 详情页可读取 Markdown 内容',
          '- 文档类型必须保持 agent_document。',
          '',
          '## 说明',
          '',
          '这份内容长度足够长，并且具备清晰的 Markdown 结构，用来模拟真实的智能体交付文档。',
          '它应当在完成后被登记为资源资产，而不是仅停留在消息记录或临时产物中。',
          '资源记录必须保留类型、来源和内容，以便后续列表与详情页统一展示。',
          '如果这条链路失效，前端资源库只能看到用户上传文件，无法呈现智能体生成的复用材料。',
          '这会让文档详情页缺少 Markdown 内容，也会让来源追踪无法判断文档来自哪个智能体消息。',
          '',
          '## 附加说明',
          '',
          '为了覆盖回归风险，这里额外补足多句说明，确保分类器不会因为内容过短而直接排除。',
          '资源登记链路应当复用既有的统一资源接口，不改变用户上传文件的预览和下载行为。',
          '本方案文档强调最小改动：只补齐完成态智能体 Markdown 文档进入资源库的链路。',
          '用户上传文件仍然来自 files 表，智能体文档仍然来自 resource_assets 表，二者不能混淆。',
          '后续 UI 可以依据 resource_type、source_summary 和 available_actions 展示不同操作。',
        ].join('\n'),
      });
      return { exitCode: 0, sessionId: null, stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    await respondAsAgent({
      agent,
      projectPath,
      roomId: room.id,
      prompt: '请生成文档并归档',
    });

    const resources = resourceAssetRepo.listResources({ projectId: project.id, assetType: 'agent_document' });
    assert.equal(resources.length, 1);
    assert.equal(resources[0]?.resource_type, 'agent_document');
    assert.equal(resources[0]?.source.type, 'agent');
    assert.equal(resources[0]?.source_summary.includes('智能体生成'), true);
    const resourceDetail = resources[0] ? resourceAssetRepo.getResource(resources[0].id) : undefined;
    assert.equal(resourceDetail?.resource_type, 'agent_document');
    assert.match(resourceDetail?.content ?? '', /智能体生成资源库方案文档/);
  } finally {
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('dispatchUserMessage replies with configured model when fallback reply has no agent target', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-model-chat-test-'));
  const project = projectRepo.create({ name: `model-chat-${Date.now()}`, path: projectPath });
  projectRepo.updateRouting(project.id, { message_routing_mode: 'fallback_reply', fallback_agent_id: 'missing-planner' });
  const room = roomRepo.create({ project_id: project.id, name: 'Room', ensureDefaultPlanner: false });
  settingsRepo.updateRoom(room.id, {
    message_routing_mode: 'fallback_reply',
    fallback_agent_id: 'missing-planner',
  });
  const message = messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: '你好，给我一句回复',
    message_type: 'text',
  });

  try {
    await dispatchUserMessage({
      roomId: room.id,
      userMessage: message,
      modelChatInvoker: {
        async invoke(messages) {
          assert.equal(messages.length, 2);
          return '模型回复成功';
        },
      },
    });

    const messages = messageRepo.listByRoom(room.id);
    const modelReply = messages.find((item) => item.sender_id === 'model-chat');
    assert.ok(modelReply);
    assert.equal(modelReply.sender_type, 'agent');
    assert.equal(modelReply.sender_name, 'Model Chat');
    assert.equal(modelReply.content, '模型回复成功');
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('dispatchUserMessage stays silent in mentions-only mode without mentions', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-mentions-only-silent-'));
  const project = projectRepo.create({ name: `mentions-only-silent-${Date.now()}`, path: projectPath });
  projectRepo.updateRouting(project.id, { message_routing_mode: 'mentions_only', fallback_agent_id: null });
  const room = roomRepo.create({ project_id: project.id, name: 'Room', ensureDefaultPlanner: false });
  settingsRepo.updateRoom(room.id, {
    message_routing_mode: 'mentions_only',
    fallback_agent_id: null,
  });
  const message = messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: '无 @ 时不要回复',
    message_type: 'text',
  });
  let invoked = false;

  try {
    await dispatchUserMessage({
      roomId: room.id,
      userMessage: message,
      modelChatInvoker: {
        async invoke() {
          invoked = true;
          return '不应该出现';
        },
      },
    });

    assert.equal(invoked, false);
    const messages = messageRepo.listByRoom(room.id);
    assert.equal(messages.some((item) => item.sender_id === 'model-chat'), false);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('dispatchUserMessage binds routed task context to agent run and task event projections', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-task-trace-projection-'));
  const project = projectRepo.create({ name: `task-trace-projection-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room', ensureDefaultPlanner: false });
  const global = agentRepo.getByAgentId('backend-executor');
  assert.ok(global);
  const agent = roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: global.id });
  roomAgentRepo.setAcp(agent.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'read-only',
    acp_writable_dirs: [],
  });
  settingsRepo.updateProject(project.id, {
    message_routing_mode: 'fallback_reply',
    fallback_agent_id: agent.agent_id,
  });
  const task = taskRepo.create({ project_id: project.id, room_id: room.id, title: 'Trace projection task' });
  const userMessage = messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: '执行并记录 trace',
    metadata: { task_id: task.id },
  });
  const originalAdapter = adapters.codex;
  adapters.codex = {
    ...originalAdapter,
    async invoke({ onChunk }) {
      onChunk({
        stream: 'stdout',
        text: '读取文件',
        channel: 'tool',
        trace: { kind: 'tool', name: 'read_file', input: 'README.md', output: 'ok' },
      });
      onChunk({
        stream: 'stdout',
        text: '修改 src/index.ts',
        channel: 'event',
        event: {
          id: 'pending:diff',
          message_id: 'pending',
          run_id: 'pending',
          agent_id: 'pending',
          seq: 0,
          type: 'file_diff',
          status: 'completed',
          title: '修改 src/index.ts',
          payload: { path: 'src/index.ts', additions: 2, deletions: 1, diff: '@@ change' },
          created_at: Date.now(),
        },
      });
      onChunk({ stream: 'stdout', text: '完成。' });
      return { exitCode: 0, sessionId: null, stderr: '' };
    },
  } satisfies SessionAdapter;
  const roomEvents = captureRoomEvents(room.id);

  try {
    await dispatchUserMessage({ roomId: room.id, userMessage });

    const run = agentRunRepo.listByRoom(room.id, 10).find((item) => item.agent_id === agent.agent_id);
    assert.ok(run);
    assert.equal(run.task_id, task.id);

    const agentMessage = messageRepo.listByRoom(room.id, 20).find((item) => item.sender_id === agent.agent_id);
    assert.ok(agentMessage);
    const metadata = JSON.parse(agentMessage.metadata ?? '{}') as MessageMetadata;
    assert.equal(metadata.task_id, task.id);
    assert.equal(metadata.trace?.events?.some((event) => event.type === 'file_diff'), true);

    const events = taskEventRepo.listByTask(task.id);
    assert.equal(events.some((event) => event.type === 'runtime_event' && event.layer === 'runtime'), true);
    const diffEvent = events.find((event) => event.type === 'diff_detected' && event.layer === 'diff');
    assert.ok(diffEvent);
    assert.equal(diffEvent.payload.path, 'src/index.ts');
    assert.equal(diffEvent.source_run_id, run.id);
    assert.equal(
      roomEvents.some((event) => event.type === 'task_event:new' && event.event.type === 'runtime_event'),
      true,
    );
    assert.equal(
      roomEvents.some((event) => event.type === 'task_event:new' && event.event.type === 'diff_detected'),
      true,
    );
  } finally {
    roomEvents.restore();
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('dispatchUserMessage passes model_chat skill context to configured model fallback', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-model-chat-skill-runtime-'));
  const skillPath = await mkdtemp(join(tmpdir(), 'openclaw-room-model-chat-skill-dir-'));
  await mkdir(skillPath, { recursive: true });
  await writeFile(join(skillPath, 'SKILL.md'), [
    '---',
    'name: model-chat-runtime-skill',
    'description: Runtime model chat skill',
    '---',
    'Reply with runtime model chat guidance.',
  ].join('\n'));
  const project = projectRepo.create({ name: `model-chat-runtime-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  settingsRepo.updateRoom(room.id, {
    message_routing_mode: 'fallback_reply',
    fallback_agent_id: 'missing-planner',
  });
  const skill = skillRepo.createSkill({
    id: `skill-model-chat-${Date.now()}`,
    name: 'model-chat-runtime-skill',
    description: 'Runtime model chat skill',
    source_type: 'manual',
    install_path: skillPath,
    runtime_scopes: ['model_chat'],
    trigger_mode: 'always_for_scope',
    trigger_keywords: [],
    priority: 10,
  });
  skillRepo.upsertBinding({
    id: `binding-model-chat-${Date.now()}`,
    skill_id: skill.id,
    scope: 'room',
    scope_id: room.id,
    enabled: true,
  });
  const message = messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: '请调用模型聊天技能',
    message_type: 'text',
  });
  let capturedSystem = '';

  try {
    await dispatchUserMessage({
      roomId: room.id,
      userMessage: message,
      modelChatInvoker: {
        async invoke(messages) {
          capturedSystem = String(messages[0]?.content);
          return '模型技能回复成功';
        },
      },
    });

    assert.match(capturedSystem, /OpenDeepSea active skills for this runtime/);
    assert.match(capturedSystem, /Skill: model-chat-runtime-skill/);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
    await rm(skillPath, { recursive: true, force: true });
  }
});

test('buildModelChatMessages appends skill context after base rules', async () => {
  const { buildModelChatMessages } = await import('./chat-model.js');
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-model-chat-skill-test-'));
  const project = projectRepo.create({ name: 'Model Chat Skill', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Skill Room' });
  const userMessage = messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: '请按 skill 回复',
    message_type: 'text',
  });

  try {
    const [systemMessage] = buildModelChatMessages({
      project,
      room,
      userMessage,
      recentMessages: [userMessage],
    }, {
      skillContext: 'OpenDeepSea active skills for this runtime:\nSkill: model-chat-skill',
    });

    const systemContent = String(systemMessage?.content);
    assert.match(systemContent, /不要声称已经修改文件/);
    assert.match(systemContent, /Skill: model-chat-skill/);
    assert.ok(systemContent.indexOf('不要声称已经修改文件') < systemContent.indexOf('Skill: model-chat-skill'));
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

function createMessage(metadata: MessageMetadata): Message {
  return {
    id: 'msg-1',
    room_id: 'room-1',
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: 'hello',
    message_type: 'text',
    metadata: JSON.stringify(metadata),
    created_at: Date.now(),
  };
}

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

async function createRoutedRoom(name: string) {
  const projectPath = await mkdtemp(join(tmpdir(), `openclaw-room-${name}-`));
  const project = projectRepo.create({ name: `${name}-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const agent = roomAgentRepo.add({ room_id: room.id, agent_id: `${name}-agent`, agent_name: 'CommandAgent' });
  roomAgentRepo.setAcp(agent.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'bypass',
    acp_writable_dirs: [],
  });
  settingsRepo.updateProject(project.id, {
    message_routing_mode: 'fallback_reply',
    fallback_agent_id: agent.agent_id,
  });
  return { project, projectPath, room, agent };
}

function installCountingCodexAdapter(): { calls: { count: number }; restore: () => void } {
  const calls = { count: 0 };
  const originalAdapter = adapters.codex;
  adapters.codex = {
    ...originalAdapter,
    async invoke() {
      calls.count += 1;
      return { exitCode: 0, sessionId: null, stdout: 'unexpected ACP dispatch', stderr: '' };
    },
  } satisfies SessionAdapter;
  return {
    calls,
    restore: () => {
      adapters.codex = originalAdapter;
    },
  };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function waitFor(assertion: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(assertion(), 'condition did not become true before timeout');
}

type CapturedRoomEvent = Parameters<typeof wsHub.broadcast>[1];

function captureRoomEvents(roomId: string): CapturedRoomEvent[] & { restore: () => void } {
  const original = wsHub.broadcast.bind(wsHub);
  const events: CapturedRoomEvent[] = [];
  wsHub.broadcast = ((targetRoomId: string, event: CapturedRoomEvent) => {
    if (targetRoomId === roomId) events.push(event);
    original(targetRoomId, event);
  }) as typeof wsHub.broadcast;
  return Object.assign(events, {
    restore: () => {
      wsHub.broadcast = original as typeof wsHub.broadcast;
    },
  });
}

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
