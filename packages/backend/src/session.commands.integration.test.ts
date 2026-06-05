import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-session-commands-')), 'test.db');

const { projectRepo } = await import('./repos/projects.js');
const { sessionRepo, sessionMessageRepo } = await import('./repos/sessions.js');
const { sessionCompactionRepo } = await import('./repos/session-compactions.js');
const { sessionContextRepo } = await import('./repos/session-context.js');
const { sessionEvidenceRepo } = await import('./repos/session-evidence.js');
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
    onSession?.('commands-test-acp-session');
    onChunk({ stream: 'stdout', channel: 'answer', text: 'ok' });
    return { exitCode: 0, sessionId: 'commands-test-acp-session', stderr: '' };
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

test('/new creates history record, archives source session and creates next session', async () => {
  const project = projectRepo.create({
    name: 'new command project',
    path: mkdtempSync(join(tmpdir(), 'session-command-new-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: '旧会话',
    current_goal: '完成命令闭环',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });
  sessionMessageRepo.create({
    session_id: session.id,
    role: 'user',
    sender_id: 'user',
    content: '第一段需求',
  });

  const res = await request(`/api/sessions/${session.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '/new title: 第一段完成' }),
  });

  assert.equal(res.status, 201);
  const payload = await res.json() as { activeSession: { session: { id: string } } };
  assert.notEqual(payload.activeSession.session.id, session.id);
  assert.equal(sessionRepo.get(session.id)?.status, 'archived');
  assert.equal(historyRecordRepo.getBySession(session.id)?.title, '第一段完成');
});

test('compact preview does not apply and compact apply updates latest compaction', async () => {
  const project = projectRepo.create({
    name: 'compact project',
    path: mkdtempSync(join(tmpdir(), 'session-command-compact-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Compact Session',
    provider: 'codex',
    workspace_path: project.path,
  });
  sessionMessageRepo.create({ session_id: session.id, role: 'user', sender_id: 'user', content: '保留这个决策' });

  const previewRes = await request(`/api/sessions/${session.id}/compact/preview`, {
    method: 'POST',
    body: JSON.stringify({ focus: '保留 UI 决策', strategy: 'focus' }),
  });
  assert.equal(previewRes.status, 201);
  const preview = await previewRes.json() as { id: string; status: string };
  assert.equal(preview.status, 'previewed');
  assert.equal(sessionRepo.get(session.id)?.latest_compaction_id, null);

  const applyRes = await request(`/api/sessions/${session.id}/compact/apply`, {
    method: 'POST',
    body: JSON.stringify({
      compaction_id: preview.id,
      applied_summary: '保留 UI 决策和 API contract',
      user_edited: true,
    }),
  });
  assert.equal(applyRes.status, 200);
  assert.equal(sessionRepo.get(session.id)?.latest_compaction_id, preview.id);
  assert.equal(sessionCompactionRepo.get(preview.id)?.user_edited, 1);
  assert.ok(sessionEvidenceRepo.listBySession(session.id).some((event) => event.event_type === 'compact'));
});

test('resume creates a new session with system resume brief message', async () => {
  const project = projectRepo.create({
    name: 'resume project',
    path: mkdtempSync(join(tmpdir(), 'session-command-resume-')),
  });
  const source = sessionRepo.create({ project_id: project.id, title: '源会话', mode: 'plan', workspace_path: project.path });
  const record = historyRecordRepo.create({
    project_id: project.id,
    session_id: source.id,
    title: '历史记录',
    summary: '已完成基础模型',
    status: 'archived',
    mode: 'plan',
    started_at: source.created_at,
    ended_at: Date.now(),
    key_decisions: [],
    changed_files: ['packages/backend/src/session.routes.ts'],
    commit_refs: [],
    resume_brief: '目标：继续模型切换\n未完成：接 UI',
    compact_count: 0,
  });

  const res = await request(`/api/history-records/${record.id}/resume`, { method: 'POST' });
  assert.equal(res.status, 201);
  const payload = await res.json() as { activeSession: { session: { id: string; current_goal: string } } };
  const messages = sessionMessageRepo.listBySession(payload.activeSession.session.id);
  assert.equal(payload.activeSession.session.current_goal, '继续模型切换');
  assert.equal(messages[0]?.role, 'system');
  assert.match(messages[0]?.content ?? '', /这是从历史记录恢复的新会话/);
});

test('fork records source relation and inherits latest applied compact as context', async () => {
  const project = projectRepo.create({
    name: 'fork project',
    path: mkdtempSync(join(tmpdir(), 'session-command-fork-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Source Session',
    provider: 'codex',
    model: 'gpt-test',
    workspace_path: project.path,
  });
  const compact = sessionCompactionRepo.createPreview({
    session_id: session.id,
    preview_summary: 'preview',
  });
  sessionCompactionRepo.apply(compact.id, { applied_summary: '继承这个 compact 摘要' });
  sessionRepo.update(session.id, { latest_compaction_id: compact.id });

  const res = await request(`/api/sessions/${session.id}/fork`, {
    method: 'POST',
    body: JSON.stringify({ title: 'Forked Session' }),
  });
  assert.equal(res.status, 201);
  const payload = await res.json() as { activeSession: { session: { id: string; forked_from_session_id: string; model: string } } };
  const fork = payload.activeSession.session;
  assert.equal(fork.forked_from_session_id, session.id);
  assert.equal(fork.model, 'gpt-test');
  assert.equal(sessionContextRepo.getLatestBySession(fork.id)?.sources[0]?.source_ref, compact.id);
});

test('checkpoint records git head, branch and diff summary from project path', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'session-command-checkpoint-'));
  execFileSync('git', ['init'], { cwd: projectPath });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectPath });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: projectPath });
  writeFileSync(join(projectPath, 'README.md'), 'initial\n');
  execFileSync('git', ['add', 'README.md'], { cwd: projectPath });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: projectPath });
  writeFileSync(join(projectPath, 'README.md'), 'initial\nchanged\n');

  const project = projectRepo.create({ name: 'checkpoint project', path: projectPath });
  const session = sessionRepo.create({ project_id: project.id, title: 'Checkpoint Session', workspace_path: projectPath });

  const res = await request(`/api/sessions/${session.id}/checkpoints`, {
    method: 'POST',
    body: JSON.stringify({ title: 'before commit', description: 'verify git snapshot' }),
  });
  assert.equal(res.status, 201);
  const checkpoint = await res.json() as {
    git_head: string | null;
    branch_name: string | null;
    diff_summary: string | null;
    evidence_event_id: string | null;
  };
  assert.match(checkpoint.git_head ?? '', /^[a-f0-9]{40}$/);
  assert.ok(checkpoint.branch_name);
  assert.match(checkpoint.diff_summary ?? '', /README.md/);
  assert.ok(checkpoint.evidence_event_id);
});

test('/status reads current git diff even when there is no file_diff evidence', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'session-command-status-'));
  execFileSync('git', ['init'], { cwd: projectPath });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectPath });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: projectPath });
  writeFileSync(join(projectPath, 'README.md'), 'initial\n');
  execFileSync('git', ['add', 'README.md'], { cwd: projectPath });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: projectPath });
  writeFileSync(join(projectPath, 'README.md'), 'initial\nchanged\n');

  const project = projectRepo.create({ name: 'status project', path: projectPath });
  const session = sessionRepo.create({ project_id: project.id, title: 'Status Session', workspace_path: projectPath });

  const res = await request(`/api/sessions/${session.id}/status`);
  assert.equal(res.status, 200);
  const status = await res.json() as {
    git: { changedFileCount: number; hasUncommittedDiff: boolean; conflictRisk: string };
  };
  assert.equal(status.git.hasUncommittedDiff, true);
  assert.equal(status.git.changedFileCount, 1);
  assert.equal(status.git.conflictRisk, 'low');
});
