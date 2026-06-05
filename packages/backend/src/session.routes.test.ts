import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-session-routes-')), 'test.db');

const { projectRepo } = await import('./repos/projects.js');
const { roomRepo } = await import('./repos/rooms.js');
const { taskRepo } = await import('./repos/tasks.js');
const { sessionRepo, sessionMessageRepo } = await import('./repos/sessions.js');
const { historyRecordRepo } = await import('./repos/history-records.js');
const { setSessionRuntimeAdapterForTest } = await import('./session-runtime.js');
const { router } = await import('./routes.js');
const express = (await import('express')).default;

const app = express();
app.use(express.json());
app.use('/api', router);

setSessionRuntimeAdapterForTest({
  backend: 'codex',
  listSessions: async () => [],
  invoke: async ({ onChunk, onSession }) => {
    onSession?.('route-test-acp-session');
    onChunk({ stream: 'stdout', channel: 'answer', text: 'ok' });
    return { exitCode: 0, sessionId: 'route-test-acp-session', stderr: '' };
  },
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

test('GET project session workspace creates an active session without creating a room or task', async () => {
  const project = projectRepo.create({
    name: 'workspace',
    path: mkdtempSync(join(tmpdir(), 'session-workspace-')),
  });

  const res = await request(`/api/projects/${project.id}/session-workspace`);
  assert.equal(res.status, 200);
  const response = await res.json() as {
    project: { id: string };
    activeSession: { session: { id: string; status: string } };
    historyRecords: unknown[];
  };

  assert.equal(response.project.id, project.id);
  assert.equal(response.activeSession.session.status, 'active');
  assert.deepEqual(response.historyRecords, []);
  assert.deepEqual(roomRepo.listByProject(project.id), []);
  assert.deepEqual(taskRepo.listByProject(project.id), []);
});

test('POST session message records message and evidence without creating old task', async () => {
  const project = projectRepo.create({
    name: 'message workspace',
    path: mkdtempSync(join(tmpdir(), 'session-message-workspace-')),
  });
  const workspaceRes = await request(`/api/projects/${project.id}/session-workspace`);
  const workspace = await workspaceRes.json() as { activeSession: { session: { id: string } } };
  const sessionId = workspace.activeSession.session.id;

  const messageRes = await request(`/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '继续实现 Session API', mode: 'code' }),
  });

  assert.equal(messageRes.status, 202);
  const messageBody = await messageRes.json() as { message: { content: string } };
  assert.equal(messageBody.message.content, '继续实现 Session API');
  assert.equal(sessionRepo.get(sessionId)?.mode, 'code');
  assert.equal(sessionMessageRepo.listBySession(sessionId).length, 1);
  assert.deepEqual(taskRepo.listByProject(project.id), []);
});

test('session message slash commands return status and compact preview', async () => {
  const project = projectRepo.create({
    name: 'slash workspace',
    path: mkdtempSync(join(tmpdir(), 'session-slash-workspace-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Slash Session',
    mode: 'plan',
    workspace_path: project.path,
  });

  const statusRes = await request(`/api/sessions/${session.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '/status' }),
  });
  assert.equal(statusRes.status, 200);
  const status = await statusRes.json() as { mode: string; nextAction: { command: string | null } };
  assert.equal(status.mode, 'plan');
  assert.equal(status.nextAction.command, null);

  const compactRes = await request(`/api/sessions/${session.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '/compact focus: 保留 API 决策' }),
  });
  assert.equal(compactRes.status, 201);
  const compact = await compactRes.json() as { status: string; focus_prompt: string; preview_summary: string };
  assert.equal(compact.status, 'previewed');
  assert.equal(compact.focus_prompt, '保留 API 决策');
  assert.match(compact.preview_summary, /Focus：保留 API 决策/);
});

test('/new archives the source session into history and opens a new active session', async () => {
  const project = projectRepo.create({
    name: 'new workspace',
    path: mkdtempSync(join(tmpdir(), 'session-new-workspace-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: '旧会话',
    current_goal: '实现 /new',
    mode: 'code',
    workspace_path: project.path,
  });
  sessionMessageRepo.create({
    session_id: session.id,
    role: 'user',
    sender_id: 'user',
    content: '请实现 /new',
  });

  const newRes = await request(`/api/sessions/${session.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '/new title: 完成第一段' }),
  });

  assert.equal(newRes.status, 201);
  const payload = await newRes.json() as {
    activeSession: { session: { id: string; title: string; status: string } };
    historyRecords: Array<{ title: string; session_id: string }>;
  };
  assert.notEqual(payload.activeSession.session.id, session.id);
  assert.equal(payload.activeSession.session.status, 'active');
  assert.equal(sessionRepo.get(session.id)?.status, 'archived');
  assert.equal(historyRecordRepo.getBySession(session.id)?.title, '完成第一段');
  assert.equal(payload.historyRecords[0]?.session_id, session.id);
});
