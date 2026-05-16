import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adapters } from './acp/index.js';
import { db } from './db.js';
import { agentRunRepo } from './repos/agent-runs.js';
import { memoryRepo } from './repos/memory.js';
import { messageRepo } from './repos/messages.js';
import { projectRepo } from './repos/projects.js';
import { roomAgentRepo, roomRepo } from './repos/rooms.js';
import { settingsRepo } from './repos/settings.js';
import { messageUploadDir } from './uploads.js';
import { buildPromptWithMessageAttachments, dispatchUserMessage } from './dispatcher.js';
import type { SessionAdapter } from './acp/types.js';
import type { Message, MessageMetadata } from './types.js';

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

test('dispatchUserMessage reports non-ACP agent as not executable without Gateway', async () => {
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
