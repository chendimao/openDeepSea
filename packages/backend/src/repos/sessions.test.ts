import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-sessions-')), 'test.db');

const { db } = await import('../db.js');
const { projectRepo } = await import('./projects.js');
const { sessionRepo, sessionMessageRepo, sessionRunRepo, sessionPlanItemRepo } = await import('./sessions.js');
const { sessionEvidenceRepo } = await import('./session-evidence.js');
const { sessionContextRepo } = await import('./session-context.js');
const { sessionCompactionRepo } = await import('./session-compactions.js');
const { sessionCheckpointRepo } = await import('./session-checkpoints.js');

test('session schema creates all new tables', () => {
  const rows = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table'
      AND name IN (
        'sessions',
        'session_messages',
        'session_runs',
        'session_plan_items',
        'session_context_manifests',
        'session_context_sources',
        'session_compactions',
        'session_evidence_events',
        'session_checkpoints',
        'history_records'
      )
    ORDER BY name
  `).all() as Array<{ name: string }>;

  assert.deepEqual(rows.map((row) => row.name), [
    'history_records',
    'session_checkpoints',
    'session_compactions',
    'session_context_manifests',
    'session_context_sources',
    'session_evidence_events',
    'session_messages',
    'session_plan_items',
    'session_runs',
    'sessions',
  ]);
});

test('session schema creates the primary lookup indexes', () => {
  const rows = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'index'
      AND name IN (
        'idx_sessions_project_status_updated',
        'idx_session_messages_session',
        'idx_session_runs_session',
        'idx_session_evidence_session',
        'idx_history_project'
      )
    ORDER BY name
  `).all() as Array<{ name: string }>;

  assert.deepEqual(rows.map((row) => row.name), [
    'idx_history_project',
    'idx_session_evidence_session',
    'idx_session_messages_session',
    'idx_session_runs_session',
    'idx_sessions_project_status_updated',
  ]);
});

test('session repos create active session, message, run and evidence in order', () => {
  const project = projectRepo.create({
    name: 'session project',
    path: mkdtempSync(join(tmpdir(), 'session-project-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: '实现会话模型',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });
  const message = sessionMessageRepo.create({
    session_id: session.id,
    role: 'user',
    sender_id: 'user',
    content: '开始实现',
    metadata: { file_refs: ['packages/backend/src/db.ts'] },
  });
  const run = sessionRunRepo.create({
    session_id: session.id,
    provider: 'codex',
    mode: 'code',
    prompt: '开始实现',
  });

  sessionRunRepo.appendStdout(run.id, 'stdout chunk\n');
  sessionRunRepo.appendStderr(run.id, 'stderr chunk\n');
  sessionRunRepo.appendActivity(run.id, 'activity chunk\n');
  const completedRun = sessionRunRepo.updateStatus(run.id, 'completed', { acp_session_id: 'acp-1' });
  sessionEvidenceRepo.create({
    session_id: session.id,
    event_type: 'message',
    source_message_id: message.id,
    title: '用户请求',
    payload: { message_id: message.id },
  });
  sessionEvidenceRepo.create({
    session_id: session.id,
    event_type: 'status',
    source_run_id: run.id,
    title: '状态快照',
  });

  assert.equal(sessionRepo.get(session.id)?.title, '实现会话模型');
  assert.equal(sessionMessageRepo.listBySession(session.id).length, 1);
  assert.equal(sessionRunRepo.listBySession(session.id).length, 1);
  assert.match(completedRun?.stdout ?? '', /stdout chunk/);
  assert.match(completedRun?.stderr ?? '', /stderr chunk/);
  assert.match(completedRun?.activity_log ?? '', /activity chunk/);
  assert.equal(completedRun?.completed_at !== null, true);
  assert.deepEqual(sessionEvidenceRepo.listBySession(session.id).map((event) => event.seq), [1, 2]);
  assert.deepEqual(sessionEvidenceRepo.listBySession(session.id)[0]?.payload, { message_id: message.id });
});

test('session supporting repos normalize context, compaction, checkpoint and plan items', () => {
  const project = projectRepo.create({
    name: 'session support project',
    path: mkdtempSync(join(tmpdir(), 'session-support-project-')),
  });
  const session = sessionRepo.create({ project_id: project.id, title: '上下文治理', mode: 'plan' });
  const evidence = sessionEvidenceRepo.create({
    session_id: session.id,
    event_type: 'checkpoint',
    title: '检查点',
  });

  const planItems = sessionPlanItemRepo.upsertMany(session.id, [
    { id: 'plan-1', title: '写 schema', status: 'in_progress', priority: 1, evidence_event_id: evidence.id },
    { id: 'plan-2', title: '验证 build', status: 'pending', priority: 2 },
  ]);
  const manifest = sessionContextRepo.createManifest({
    session_id: session.id,
    total_token_estimate: 128,
    prompt_hash: 'hash-1',
    sources: [
      {
        source_type: 'agents',
        title: 'AGENTS.md',
        token_estimate: 64,
        reason: '规则来源',
        excerpt: '规则摘要',
        metadata: { origin: 'test' },
      },
    ],
  });
  const preview = sessionCompactionRepo.createPreview({
    session_id: session.id,
    strategy: 'focus',
    focus_prompt: '保留 UI 决策',
    preview_summary: '压缩预览',
    retained_refs: ['decision:1'],
    dropped_refs: ['log:1'],
    risk_notes: '可能丢弃重复日志',
  });
  const applied = sessionCompactionRepo.apply(preview.id, {
    applied_summary: '应用后的摘要',
    user_edited: true,
  });
  const checkpoint = sessionCheckpointRepo.create({
    session_id: session.id,
    title: '提交前',
    git_head: 'abc123',
    branch_name: 'feat/session',
    diff_summary: 'M packages/backend/src/db.ts',
    evidence_event_id: evidence.id,
  });

  assert.deepEqual(planItems.map((item) => item.title), ['写 schema', '验证 build']);
  assert.equal(manifest.sources[0]?.title, 'AGENTS.md');
  assert.equal(sessionContextRepo.getLatestBySession(session.id)?.total_token_estimate, 128);
  assert.equal(applied?.status, 'applied');
  assert.equal(applied?.user_edited, 1);
  assert.equal(checkpoint.git_head, 'abc123');
  assert.equal(sessionCheckpointRepo.listBySession(session.id).length, 1);
});
