import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-session-title-')), 'test.db');

const { projectRepo } = await import('./repos/projects.js');
const { sessionMessageRepo, sessionRepo } = await import('./repos/sessions.js');
const { buildSessionTitleFromMessage, dispatchSessionUserMessage } = await import('./session-message-dispatch.js');
const { setSessionRuntimeAdapterForTest } = await import('./session-runtime.js');

afterEach(() => {
  setSessionRuntimeAdapterForTest(undefined);
});

test('dispatchSessionUserMessage renames a default empty session from the first user message', async () => {
  const project = projectRepo.create({
    name: 'Session Title',
    path: mkdtempSync(join(tmpdir(), 'session-title-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    provider: 'codex',
    workspace_path: project.path,
  });
  setSessionRuntimeAdapterForTest(createNoopAdapter());

  dispatchSessionUserMessage({
    sessionId: session.id,
    content: '用户在当前会话第一次发送消息的时候，要同时修改当前会话名称，要显示简略的，避免超长溢出',
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  const updated = sessionRepo.get(session.id);
  assert.notEqual(updated?.title, 'New Session');
  assert.match(updated?.title ?? '', /^用户在当前会话第一次发送消息/);
  assert.ok((updated?.title.length ?? 0) <= 28);
});

test('dispatchSessionUserMessage keeps explicit and non-empty session titles', async () => {
  const project = projectRepo.create({
    name: 'Session Title Keep',
    path: mkdtempSync(join(tmpdir(), 'session-title-keep-')),
  });
  const explicit = sessionRepo.create({
    project_id: project.id,
    title: '手动命名的会话',
    provider: 'codex',
    workspace_path: project.path,
  });
  const nonEmptyDefault = sessionRepo.create({
    project_id: project.id,
    provider: 'codex',
    workspace_path: project.path,
  });
  sessionMessageRepo.create({
    session_id: nonEmptyDefault.id,
    role: 'user',
    sender_id: 'user',
    content: '第一条消息',
  });
  setSessionRuntimeAdapterForTest(createNoopAdapter());

  dispatchSessionUserMessage({ sessionId: explicit.id, content: '这个内容不应该覆盖已有标题' });
  dispatchSessionUserMessage({ sessionId: nonEmptyDefault.id, content: '第二条消息不应该重新命名' });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(sessionRepo.get(explicit.id)?.title, '手动命名的会话');
  assert.equal(sessionRepo.get(nonEmptyDefault.id)?.title, 'New Session');
});

test('buildSessionTitleFromMessage preserves ordinary leading numbers', () => {
  assert.equal(buildSessionTitleFromMessage('2026 roadmap 排期'), '2026 roadmap 排期');
  assert.equal(buildSessionTitleFromMessage('1. 修复会话标题'), '修复会话标题');
});

function createNoopAdapter() {
  return {
    backend: 'codex' as const,
    listSessions: async () => [],
    invoke: async () => ({ exitCode: 0, sessionId: 'codex-session', stderr: '' }),
  };
}
