import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-session-view-model-')), 'test.db');

const { projectRepo } = await import('./repos/projects.js');
const { sessionRepo, sessionRunRepo } = await import('./repos/sessions.js');
const { historyRecordRepo } = await import('./repos/history-records.js');
const { sessionEvidenceRepo } = await import('./repos/session-evidence.js');
const {
  buildSessionBottomStatus,
  buildSessionDiffRows,
  buildSessionProjectSwitcher,
  buildSessionToolRows,
} = await import('./session-workspace-view-model.js');

test('buildSessionProjectSwitcher uses real projects and recent session/history data', () => {
  const project = projectRepo.create({
    name: '真实项目',
    path: mkdtempSync(join(tmpdir(), 'session-switcher-project-')),
  });
  const session = sessionRepo.create({ project_id: project.id, title: '真实会话', workspace_path: project.path });
  historyRecordRepo.create({
    project_id: project.id,
    session_id: session.id,
    title: '历史记录',
    summary: '历史摘要',
    status: 'archived',
    mode: 'code',
    started_at: Date.now() - 1000,
    ended_at: Date.now(),
    key_decisions: [],
    changed_files: [],
    verification_summary: null,
    commit_refs: [],
    resume_brief: '目标：历史记录',
    compact_count: 0,
  });

  const switcher = buildSessionProjectSwitcher(project.id);

  assert.equal(switcher.activeProjectId, project.id);
  assert.equal(switcher.projects.some((item) => item.name === '真实项目'), true);
  assert.equal(switcher.projects.find((item) => item.id === project.id)?.recentSessions[0]?.title, '真实会话');
});

test('buildSessionToolRows maps evidence to stable display rows without fallback data', () => {
  const project = projectRepo.create({
    name: 'tool project',
    path: mkdtempSync(join(tmpdir(), 'session-tool-project-')),
  });
  const session = sessionRepo.create({ project_id: project.id, title: 'Tool Session' });
  const run = sessionRunRepo.create({
    session_id: session.id,
    provider: 'codex',
    mode: 'code',
    prompt: 'read file',
  });
  const event = sessionEvidenceRepo.create({
    session_id: session.id,
    event_type: 'file_read',
    source_run_id: run.id,
    title: 'Read file',
    summary: 'packages/frontend/src/session-ui/SessionShellView.tsx',
    payload: { path: 'packages/frontend/src/session-ui/SessionShellView.tsx' },
  });

  const rows = buildSessionToolRows([event]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.action, 'read');
  assert.equal(rows[0]?.target, 'packages/frontend/src/session-ui/SessionShellView.tsx');
  assert.equal(rows[0]?.eventId, event.id);
});

test('buildSessionDiffRows reads real git status and numstat', () => {
  const root = mkdtempSync(join(tmpdir(), 'session-diff-project-'));
  execFileSync('git', ['init'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  writeFileSync(join(root, 'tracked.txt'), 'one\n');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: root });
  writeFileSync(join(root, 'tracked.txt'), 'one\ntwo\n');
  writeFileSync(join(root, 'new.txt'), 'new\n');

  const rows = buildSessionDiffRows(root);

  assert.ok(rows.some((row) => row.path === 'tracked.txt' && row.status === 'modified'));
  assert.ok(rows.some((row) => row.path === 'new.txt' && row.status === 'untracked'));
});

test('buildSessionBottomStatus derives response and error metrics from runs', () => {
  const now = Date.now();
  const rows = buildSessionBottomStatus([
    { status: 'completed', started_at: now - 2000, completed_at: now - 1000, error: null } as never,
    { status: 'failed', started_at: now - 5000, completed_at: now - 4000, error: 'boom' } as never,
  ], []);

  assert.equal(rows.health, 'warning');
  assert.equal(rows.lastResponseMs, 1000);
  assert.equal(rows.errorRate, 0.5);
  assert.equal(rows.indexStatus, 'unknown');
});
