import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-active-sessions-')), 'test.db');

const { db } = await import('./db.js');
const { projectRepo } = await import('./repos/projects.js');
const { sessionRepo, sessionRunRepo } = await import('./repos/sessions.js');
const { sessionEvidenceRepo } = await import('./repos/session-evidence.js');
const { buildActiveSessionSummaries } = await import('./session-active-view-model.js');

test('buildActiveSessionSummaries includes active sessions across projects with project and run metadata', () => {
  const projectA = projectRepo.create({
    name: 'Project A',
    path: mkdtempSync(join(tmpdir(), 'active-summary-a-')),
  });
  const projectB = projectRepo.create({
    name: 'Project B',
    path: mkdtempSync(join(tmpdir(), 'active-summary-b-')),
  });
  const sessionA = sessionRepo.create({
    project_id: projectA.id,
    title: '实现活跃面板',
    mode: 'code',
    provider: 'codex',
    model: 'gpt-5.3-codex',
    workspace_path: projectA.path,
  });
  const sessionB = sessionRepo.create({
    project_id: projectB.id,
    title: '修复构建',
    workspace_path: projectB.path,
  });

  sessionRunRepo.create({
    session_id: sessionA.id,
    provider: 'codex',
    model: 'gpt-5.3-codex',
    mode: 'code',
    status: 'running',
    prompt: '继续实现',
  });
  sessionEvidenceRepo.create({
    session_id: sessionA.id,
    event_type: 'status',
    title: '正在实现活跃面板',
    summary: '左侧面板已进入实现阶段',
  });
  sessionRepo.close(sessionB.id);

  const summaries = buildActiveSessionSummaries();

  assert.deepEqual(summaries.map((summary) => summary.id), [sessionA.id]);
  assert.equal(summaries[0]?.project_id, projectA.id);
  assert.equal(summaries[0]?.project_name, 'Project A');
  assert.equal(summaries[0]?.project_path, projectA.path);
  assert.equal(summaries[0]?.active_run_count, 1);
  assert.equal(summaries[0]?.latest_event_summary, '左侧面板已进入实现阶段');
});

test('buildActiveSessionSummaries excludes archived sessions even when they are not closed', () => {
  const project = projectRepo.create({
    name: 'Archived Project',
    path: mkdtempSync(join(tmpdir(), 'active-summary-archived-')),
  });
  const archived = sessionRepo.create({
    project_id: project.id,
    title: '已归档但未关闭',
    workspace_path: project.path,
  });
  const active = sessionRepo.create({
    project_id: project.id,
    title: '继续开发',
    workspace_path: project.path,
  });

  sessionRepo.update(archived.id, { status: 'archived', phase: 'archived', archived_at: 1 });

  const summaries = buildActiveSessionSummaries();

  assert.equal(summaries.some((summary) => summary.id === active.id), true);
  assert.equal(summaries.some((summary) => summary.id === archived.id), false);
  assert.equal(sessionRepo.get(archived.id)?.closed_at, null);
});

test('buildActiveSessionSummaries orders pinned sessions before recent unpinned sessions', () => {
  const project = projectRepo.create({
    name: 'Pinned Project',
    path: mkdtempSync(join(tmpdir(), 'active-summary-pinned-')),
  });
  const normal = sessionRepo.create({
    project_id: project.id,
    title: '普通会话',
    workspace_path: project.path,
  });
  const pinned = sessionRepo.create({
    project_id: project.id,
    title: '置顶会话',
    workspace_path: project.path,
  });

  sessionRepo.pin(pinned.id);

  const summaries = buildActiveSessionSummaries();

  assert.equal(summaries[0]?.id, pinned.id);
  assert.ok(summaries.some((summary) => summary.id === normal.id));
  assert.equal(summaries[0]?.pinned_at !== null, true);
});

test('buildActiveSessionSummaries exposes created and last viewed timestamps for sidebar sorting', () => {
  const project = projectRepo.create({
    name: 'Sidebar Sort Project',
    path: mkdtempSync(join(tmpdir(), 'active-summary-sidebar-sort-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: '侧栏排序会话',
    workspace_path: project.path,
  });

  db.prepare('UPDATE sessions SET created_at = ?, updated_at = ?, last_viewed_at = ? WHERE id = ?')
    .run(1_000, 2_000, 3_000, session.id);
  const viewed = sessionRepo.get(session.id);

  const summaries = buildActiveSessionSummaries();
  const summary = summaries.find((item) => item.id === session.id);

  assert.ok(summary);
  assert.equal(summary.created_at, viewed?.created_at);
  assert.equal(summary.last_viewed_at, viewed?.last_viewed_at);
  assert.equal(summary.updated_at, viewed?.updated_at);
});
