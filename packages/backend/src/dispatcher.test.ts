import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
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
const { taskRepo } = await import('./repos/tasks.js');
const { workflowRepo } = await import('./repos/workflows.js');
const { messageUploadDir } = await import('./uploads.js');
const { wsHub } = await import('./ws-hub.js');
const { buildAgentIdentityPrompt, buildPromptWithMessageAttachments, dispatchUserMessage, respondAsAgent } = await import('./dispatcher.js');
const { router } = await import('./routes.js');
const { setWorkflowConversationDeps } = await import('./workflows/conversation.js');
const express = (await import('express')).default;

const app = express();
app.use(express.json());
app.use('/api', router);

test.afterEach(() => {
  process.env.LANGGRAPH_WORKFLOW_ENABLED = '0';
  setWorkflowConversationDeps({});
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
    assert.match(messageRepo.listByRoom(room.id, 20).at(-1)?.content ?? '', /Planner 协作决策解析失败/);
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

test('planner fallback reply creates collaboration decision without dispatching other agents', async () => {
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
        text: JSON.stringify({
          intent: 'implementation',
          recommendedMode: 'formal_workflow',
          problemArea: 'frontend',
          summary: '修复群聊协作调度',
          rationale: '涉及代码修改，应由用户选择正式工作流或轻量协作。',
          needsUserChoice: true,
          proposedAgents: {
            executors: ['frontend-dev'],
            reviewers: ['reviewer'],
            testers: [],
            acceptors: [],
          },
          stages: [
            {
              stage: 'execute',
              agentIds: ['frontend-dev'],
              parallel: false,
              goal: '实现修复',
            },
            {
              stage: 'review',
              agentIds: ['reviewer'],
              parallel: false,
              goal: '审查修复',
            },
          ],
        }),
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
    assert.match(prompts[0] ?? '', /Return ONLY valid JSON/);
    assert.match(prompts[0] ?? '', /UNTRUSTED_USER_MESSAGE_BEGIN/);
    assert.ok(decisionMessage);
    assert.equal(
      messages.some((message) =>
        message.sender_id === 'planner' &&
        message.message_type === 'agent_stream' &&
        message.content.includes('"recommendedMode"')
      ),
      false,
    );
    const metadata = JSON.parse(decisionMessage.metadata ?? '{}') as MessageMetadata;
    assert.equal(metadata.source_message_id, userMessage.id);
    assert.equal(metadata.fallback_agent_id, 'planner');
    const decision = metadata.collaboration_decision as { recommendedMode?: unknown } | undefined;
    assert.equal(decision?.recommendedMode, 'formal_workflow');
  } finally {
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('message route handles /task command after persisting user message without ACP dispatch', async () => {
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
    assert.equal(calls.count, 0);

    const tasks = taskRepo.listByRoom(room.id);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.title, 'Fix command route');
    assert.equal(tasks[0]?.created_from, 'slash_command');
    assert.equal(tasks[0]?.source_message_id, userMessage.id);

    const messages = messageRepo.listByRoom(room.id, 20);
    assert.equal(messages[0]?.id, userMessage.id);
    assert.ok(messages.some((message) => {
      const metadata = message.metadata ? JSON.parse(message.metadata) as Record<string, unknown> : {};
      return metadata.event_type === 'task_created' && metadata.task_id === tasks[0]?.id;
    }));
  } finally {
    restore();
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('message route handles /start-task command after persisting user message without ACP dispatch', async () => {
  const { project, projectPath, room } = await createRoutedRoom('start-task-command');
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Start from slash',
  });
  const { restore, calls } = installCountingCodexAdapter();
  const enqueued: string[] = [];
  process.env.LANGGRAPH_WORKFLOW_ENABLED = '1';
  setWorkflowConversationDeps({
    enqueueGraphWorkflow: (runId) => {
      enqueued.push(runId);
    },
  });

  try {
    const res = await request(`/api/rooms/${room.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        content: `/start-task ${task.id}`,
        sender_id: 'user',
        sender_name: 'You',
      }),
    });

    assert.equal(res.status, 201);
    const userMessage = await res.json() as Message;
    await delay(30);
    assert.equal(calls.count, 0);

    const runs = workflowRepo.listByTask(task.id);
    assert.equal(runs.length, 1);
    assert.deepEqual(enqueued, [runs[0]?.id]);
    const messages = messageRepo.listByRoom(room.id, 20);
    assert.equal(messages[0]?.id, userMessage.id);
    assert.ok(messages.some((message) => {
      const metadata = message.metadata ? JSON.parse(message.metadata) as Record<string, unknown> : {};
      return (
        metadata.event_type === 'workflow_started' &&
        metadata.task_id === task.id &&
        metadata.workflow_source === 'chat_command' &&
        metadata.workflow_source_message_id === userMessage.id
      );
    }));
  } finally {
    restore();
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('message route handles Chinese start command after persisting user message without ACP dispatch', async () => {
  const { project, projectPath, room } = await createRoutedRoom('cn-start-task-command');
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Start from Chinese command',
  });
  const { restore, calls } = installCountingCodexAdapter();
  const enqueued: string[] = [];
  process.env.LANGGRAPH_WORKFLOW_ENABLED = '1';
  setWorkflowConversationDeps({
    enqueueGraphWorkflow: (runId) => {
      enqueued.push(runId);
    },
  });

  try {
    const res = await request(`/api/rooms/${room.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        content: `开始任务 #${task.id}`,
        sender_id: 'user',
        sender_name: 'You',
      }),
    });

    assert.equal(res.status, 201);
    const userMessage = await res.json() as Message;
    await delay(30);
    assert.equal(calls.count, 0);

    const runs = workflowRepo.listByTask(task.id);
    assert.equal(runs.length, 1);
    assert.deepEqual(enqueued, [runs[0]?.id]);
    assert.ok(messageRepo.listByRoom(room.id, 20).some((message) => {
      const metadata = message.metadata ? JSON.parse(message.metadata) as Record<string, unknown> : {};
      return (
        metadata.event_type === 'workflow_started' &&
        metadata.task_id === task.id &&
        metadata.workflow_source === 'chat_command' &&
        metadata.workflow_source_message_id === userMessage.id
      );
    }));
  } finally {
    restore();
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('message route returns JSON error when start command target is missing', async () => {
  const { projectPath, room } = await createRoutedRoom('start-task-command-missing');
  const { restore, calls } = installCountingCodexAdapter();
  process.env.LANGGRAPH_WORKFLOW_ENABLED = '1';

  try {
    const res = await request(`/api/rooms/${room.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        content: '/start-task missing-task',
        sender_id: 'user',
        sender_name: 'You',
      }),
    });

    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    assert.deepEqual(await res.json(), { error: 'task not found' });
    await delay(30);
    assert.equal(calls.count, 0);
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
      event.runId &&
      event.channel === 'answer' &&
      event.status === 'streaming'
    ));

    releaseInvoke();
    await running;

    const reply = messageRepo.listByRoom(room.id).find((item) => item.sender_id === acpAgent.agent_id);
    assert.equal(reply?.content, '第一段第二段');
    const run = agentRunRepo.listByRoom(room.id, 1)[0];
    assert.equal(run?.stdout, '第一段第二段');
    assert.equal(run?.stderr, '');
    assert.ok(events.some((event) =>
      event.type === 'message:stream' &&
      event.messageId === reply?.id &&
      event.done === true &&
      event.status === 'completed' &&
      event.chunk === ''
    ));
  } finally {
    events.restore();
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

test('dispatchUserMessage triggers model distill after completed ACP reply when enabled', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-acp-distill-test-'));
  const project = projectRepo.create({ name: `acp-distill-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
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

test('dispatchUserMessage replies with configured model when no agent target is available', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-model-chat-test-'));
  const project = projectRepo.create({ name: `model-chat-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
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
