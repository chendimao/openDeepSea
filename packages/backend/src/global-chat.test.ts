import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import express from 'express';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-global-chat-')), 'test.db');

const { globalChatRepo } = await import('./repos/global-chat.js');
const { memoryRepo } = await import('./repos/memory.js');
const { buildGlobalChatMessages, sendGlobalChatMessage } = await import('./global-chat.js');
const { router, setGlobalChatRouteDeps } = await import('./routes.js');

const app = express();
app.use(express.json());
app.use('/api', router);

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

test('global chat repo creates sessions and persists messages', () => {
  const session = globalChatRepo.createSession({ title: '全局问答' });
  const userMessage = globalChatRepo.createMessage({
    session_id: session.id,
    role: 'user',
    content: '现在系统配置是什么？',
    status: 'completed',
  });
  const assistantMessage = globalChatRepo.createMessage({
    session_id: session.id,
    role: 'assistant',
    content: '已配置模型。',
    status: 'completed',
    metadata: { memory_refs: [], config_refs: ['system_settings'] },
  });

  assert.equal(globalChatRepo.listSessions()[0]?.id, session.id);
  assert.deepEqual(globalChatRepo.listMessages(session.id).map((message) => message.id), [
    userMessage.id,
    assistantMessage.id,
  ]);
  assert.deepEqual(assistantMessage.metadata, { memory_refs: [], config_refs: ['system_settings'] });
});

test('global memories do not require a project and are returned for global chat context', () => {
  const memory = memoryRepo.create({
    scope: 'global',
    memory_type: 'preference',
    title: '偏好',
    content: '用户喜欢默认自动检索。',
    source_type: 'manual',
    pinned: true,
  });

  const context = memoryRepo.listForGlobalChatContext({ prompt: '检索偏好', limit: 10 });
  assert.equal(memory.project_id, null);
  assert.ok(context.some((entry) => entry.id === memory.id));
});

test('global chat message listing with a limit returns the most recent messages in chronological order', () => {
  const session = globalChatRepo.createSession({ title: '长会话' });
  for (let index = 1; index <= 25; index += 1) {
    globalChatRepo.createMessage({
      session_id: session.id,
      role: index % 2 === 0 ? 'assistant' : 'user',
      content: `message-${index}`,
      status: 'completed',
    });
  }

  assert.deepEqual(
    globalChatRepo.listMessages(session.id, { limit: 5 }).map((message) => message.content),
    ['message-21', 'message-22', 'message-23', 'message-24', 'message-25'],
  );
});

test('global chat prompt bounds memory and history content length', () => {
  const longMemory = 'M'.repeat(6000);
  const longHistory = 'H'.repeat(6000);
  const messages = buildGlobalChatMessages({
    userContent: '需要总结上下文',
    memories: [{
      id: 'memory-long',
      project_id: null,
      room_id: null,
      room_agent_id: null,
      task_id: null,
      scope: 'global',
      memory_type: 'fact',
      title: '长记忆',
      content: longMemory,
      source_type: 'manual',
      source_id: null,
      pinned: 0,
      archived: 0,
      created_at: 1,
      updated_at: 1,
    }],
    history: [{
      id: 'message-long',
      session_id: 'session-long',
      role: 'assistant',
      content: longHistory,
      status: 'completed',
      metadata: {},
      created_at: 1,
    }],
    settingsSummary: {
      model: 'gpt-4.1',
      baseURL: 'https://api.example/v1',
      apiKeySet: false,
      apiKeyPreview: null,
    },
  });

  const system = String(messages[0]?.content ?? '');
  const human = String(messages[1]?.content ?? '');
  assert.ok(system.length < 5000);
  assert.ok(human.length < 5000);
  assert.doesNotMatch(system, new RegExp(`M{${longMemory.length}}`));
  assert.doesNotMatch(human, new RegExp(`H{${longHistory.length}}`));
  assert.match(system, /截断/);
  assert.match(human, /截断/);
});

test('global chat sends messages with memory and redacted config context', async () => {
  const session = globalChatRepo.createSession({ title: '配置查询' });
  const memory = memoryRepo.create({
    scope: 'global',
    memory_type: 'preference',
    title: '检索偏好',
    content: '用户希望全局聊天默认自动检索。',
    source_type: 'manual',
    pinned: true,
  });

  let capturedSystem = '';
  const result = await sendGlobalChatMessage({
    sessionId: session.id,
    content: '我的检索偏好是什么？',
    invoker: {
      async invoke(messages: Array<SystemMessage | HumanMessage>) {
        capturedSystem = String(messages[0]?.content ?? '');
        return '你希望默认自动检索。';
      },
    },
    settingsSummary: {
      model: 'gpt-4.1',
      baseURL: 'https://api.example/v1',
      apiKeySet: true,
      apiKeyPreview: 'sk-...1234',
      rawApiKeyForTest: 'sk-should-not-leak',
    },
  });

  const messages = globalChatRepo.listMessages(session.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.role, 'user');
  assert.equal(messages[1]?.role, 'assistant');
  assert.equal(result.assistantMessage.content, '你希望默认自动检索。');
  assert.equal(result.assistantMessage.metadata.memory_refs?.[0]?.id, memory.id);
  assert.ok(result.assistantMessage.metadata.config_refs?.includes('system_settings'));
  assert.match(capturedSystem, /检索偏好/);
  assert.match(capturedSystem, /sk-\.\.\.1234/);
  assert.doesNotMatch(capturedSystem, /sk-should-not-leak/);
  assert.doesNotMatch(JSON.stringify(result.assistantMessage.metadata), /sk-should-not-leak/);
});

test('global chat routes create sessions, send messages, and save message as global memory', async () => {
  setGlobalChatRouteDeps({
    invoker: {
      async invoke() {
        return '路由回复';
      },
    },
    settingsSummary: {
      model: 'gpt-4.1',
      baseURL: 'https://api.example/v1',
      apiKeySet: true,
      apiKeyPreview: 'sk-...9999',
    },
  });

  try {
    const sessionRes = await request('/api/global-chat/sessions', {
      method: 'POST',
      body: JSON.stringify({ title: '路由会话' }),
    });
    assert.equal(sessionRes.status, 201);
    const session = await sessionRes.json() as { id: string; title: string };
    assert.equal(session.title, '路由会话');

    const messageRes = await request(`/api/global-chat/sessions/${session.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: '查询一下' }),
    });
    assert.equal(messageRes.status, 201);
    const sent = await messageRes.json() as {
      userMessage: { id: string; role: string };
      assistantMessage: { id: string; role: string; content: string };
    };
    assert.equal(sent.userMessage.role, 'user');
    assert.equal(sent.assistantMessage.role, 'assistant');
    assert.equal(sent.assistantMessage.content, '路由回复');

    const messagesRes = await request(`/api/global-chat/sessions/${session.id}/messages`);
    assert.equal(messagesRes.status, 200);
    const messages = await messagesRes.json() as Array<{ id: string }>;
    assert.equal(messages.length, 2);

    const memoryRes = await request(`/api/global-chat/messages/${sent.assistantMessage.id}/save-memory`, {
      method: 'POST',
      body: JSON.stringify({ memory_type: 'fact', title: '路由回复记忆' }),
    });
    assert.equal(memoryRes.status, 201);
    const memory = await memoryRes.json() as { id: string; scope: string; project_id: string | null; title: string };
    assert.equal(memory.scope, 'global');
    assert.equal(memory.project_id, null);
    assert.equal(memory.title, '路由回复记忆');

    const repeatedMemoryRes = await request(`/api/global-chat/messages/${sent.assistantMessage.id}/save-memory`, {
      method: 'POST',
      body: JSON.stringify({ memory_type: 'preference', title: '更新后的全局记忆' }),
    });
    assert.equal(repeatedMemoryRes.status, 201);
    const repeatedMemory = await repeatedMemoryRes.json() as { id: string; title: string };
    assert.equal(repeatedMemory.id, memory.id);
    assert.equal(repeatedMemory.title, '更新后的全局记忆');
  } finally {
    setGlobalChatRouteDeps({});
  }
});
