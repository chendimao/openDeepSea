import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-session-routes-')), 'test.db');

const { projectRepo } = await import('./repos/projects.js');
const { roomRepo } = await import('./repos/rooms.js');
const { taskRepo } = await import('./repos/tasks.js');
const { sessionRepo, sessionMessageRepo, sessionRunRepo } = await import('./repos/sessions.js');
const { historyRecordRepo } = await import('./repos/history-records.js');
const { setSessionRuntimeAdapterForTest } = await import('./session-runtime.js');
const { router } = await import('./routes.js');
const express = (await import('express')).default;

const capturedPrompts: string[] = [];
const app = express();
app.use(express.json());
app.use('/api', router);

setSessionRuntimeAdapterForTest({
  backend: 'codex',
  listSessions: async () => [],
  invoke: async ({ prompt, onChunk, onSession }) => {
    capturedPrompts.push(prompt);
    onSession?.('route-test-acp-session');
    onChunk({ stream: 'stdout', channel: 'answer', text: 'ok' });
    return { exitCode: 0, sessionId: 'route-test-acp-session', stderr: '' };
  },
});

test('legacy HTTP session workspace route is removed', async () => {
  const project = projectRepo.create({
    name: 'removed workspace route project',
    path: mkdtempSync(join(tmpdir(), 'removed-session-workspace-route-')),
  });

  const res = await request(`/api/projects/${project.id}/session-workspace`);

  assert.equal(res.status, 404);
});

test('legacy HTTP session message route is removed', async () => {
  const project = projectRepo.create({
    name: 'removed message route project',
    path: mkdtempSync(join(tmpdir(), 'removed-session-message-route-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Removed Message Route',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });

  const res = await request(`/api/sessions/${session.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: 'should not work over http' }),
  });

  assert.equal(res.status, 404);
});

test('legacy HTTP session run control routes are removed', async () => {
  const project = projectRepo.create({
    name: 'removed run route project',
    path: mkdtempSync(join(tmpdir(), 'removed-session-run-route-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Removed Run Route',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });
  const run = sessionRunRepo.create({
    session_id: session.id,
    agent_id: 'planner',
    provider: 'codex',
    mode: 'code',
    status: 'running',
    prompt: 'long task',
    acp_session_id: 'removed-acp',
  });

  for (const suffix of ['cancel', 'retry', 'pause', 'resume']) {
    const res = await request(`/api/session-runs/${run.id}/${suffix}`, { method: 'POST' });
    assert.equal(res.status, 404);
  }
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

test('/context refreshes stale manifest after compact apply', async () => {
  const project = projectRepo.create({
    name: 'compact context refresh workspace',
    path: mkdtempSync(join(tmpdir(), 'session-compact-context-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Compact Context Session',
    workspace_path: project.path,
  });

  const firstContextRes = await request(`/api/sessions/${session.id}/context`);
  assert.equal(firstContextRes.status, 200);

  const previewRes = await request(`/api/sessions/${session.id}/compact/preview`, {
    method: 'POST',
    body: JSON.stringify({ focus: '保留 context 刷新证据' }),
  });
  assert.equal(previewRes.status, 201);
  const preview = await previewRes.json() as { id: string };

  const applyRes = await request(`/api/sessions/${session.id}/compact/apply`, {
    method: 'POST',
    body: JSON.stringify({
      compaction_id: preview.id,
      applied_summary: '已保留 context 刷新证据',
    }),
  });
  assert.equal(applyRes.status, 200);

  const refreshedContextRes = await request(`/api/sessions/${session.id}/context`);
  assert.equal(refreshedContextRes.status, 200);
  const context = await refreshedContextRes.json() as {
    sources: Array<{ source_type: string; source_ref: string | null; excerpt: string | null }>;
  };
  assert.ok(context.sources.some((source) =>
    source.source_type === 'compact' &&
    source.source_ref === preview.id &&
    source.excerpt?.includes('已保留 context 刷新证据')
  ));
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

  const newRes = await request(`/api/sessions/${session.id}/new`, {
    method: 'POST',
    body: JSON.stringify({ title: '完成第一段' }),
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

test('GET project history records filters by query status and mode', async () => {
  const project = projectRepo.create({
    name: 'history route filters',
    path: mkdtempSync(join(tmpdir(), 'session-history-route-filters-')),
  });
  const codeSession = sessionRepo.create({ project_id: project.id, title: 'Code Session' });
  const askSession = sessionRepo.create({ project_id: project.id, title: 'Ask Session' });
  historyRecordRepo.create({
    project_id: project.id,
    session_id: codeSession.id,
    title: '补齐后端接入',
    summary: '包含工具调用',
    status: 'archived',
    mode: 'code',
    started_at: 1,
    ended_at: 2,
    key_decisions: [],
    changed_files: [],
    verification_summary: null,
    commit_refs: [],
    resume_brief: '目标：补齐后端接入',
    compact_count: 0,
  });
  historyRecordRepo.create({
    project_id: project.id,
    session_id: askSession.id,
    title: '普通问答',
    summary: '无关内容',
    status: 'completed',
    mode: 'ask',
    started_at: 1,
    ended_at: 3,
    key_decisions: [],
    changed_files: [],
    verification_summary: null,
    commit_refs: [],
    resume_brief: '目标：普通问答',
    compact_count: 0,
  });

  const res = await request(`/api/projects/${project.id}/history-records?q=${encodeURIComponent('工具')}&status=archived&mode=code`);

  assert.equal(res.status, 200);
  const records = await res.json() as Array<{ title: string }>;
  assert.deepEqual(records.map((record) => record.title), ['补齐后端接入']);
});

test('PATCH session contract persists scope risks and acceptance criteria', async () => {
  const project = projectRepo.create({
    name: 'contract route',
    path: mkdtempSync(join(tmpdir(), 'session-contract-route-')),
  });
  const session = sessionRepo.create({ project_id: project.id, title: 'Contract Route' });

  const res = await request(`/api/sessions/${session.id}/contract`, {
    method: 'PATCH',
    body: JSON.stringify({
      scope: '只改后端接入',
      risks: ['重试可能重复执行'],
      acceptanceCriteria: ['页面不再显示 mock 数据'],
    }),
  });

  assert.equal(res.status, 200);
  const contract = await res.json() as { scope: string; risks: string[]; acceptanceCriteria: string[] };
  assert.equal(contract.scope, '只改后端接入');
  assert.deepEqual(contract.risks, ['重试可能重复执行']);
  assert.deepEqual(contract.acceptanceCriteria, ['页面不再显示 mock 数据']);
});

test('POST compact discard marks previewed compaction as discarded', async () => {
  const project = projectRepo.create({
    name: 'discard route',
    path: mkdtempSync(join(tmpdir(), 'session-discard-route-')),
  });
  const session = sessionRepo.create({ project_id: project.id, title: 'Discard Route' });
  const previewRes = await request(`/api/sessions/${session.id}/compact/preview`, { method: 'POST' });
  const preview = await previewRes.json() as { id: string };

  const discardRes = await request(`/api/sessions/${session.id}/compact/discard`, {
    method: 'POST',
    body: JSON.stringify({ compaction_id: preview.id }),
  });

  assert.equal(discardRes.status, 200);
  const discarded = await discardRes.json() as { status: string };
  assert.equal(discarded.status, 'discarded');
});
