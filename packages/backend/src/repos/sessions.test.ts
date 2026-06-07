import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-sessions-')), 'test.db');

const { db } = await import('../db.js');
const { projectRepo } = await import('./projects.js');
const {
  sessionRepo,
  sessionMessageRepo,
  sessionRunRepo,
  sessionPlanItemRepo,
  sessionAgentRuntimeRepo,
} = await import('./sessions.js');
const { sessionEvidenceRepo } = await import('./session-evidence.js');
const { sessionContextRepo } = await import('./session-context.js');
const { sessionCompactionRepo } = await import('./session-compactions.js');
const { sessionCheckpointRepo } = await import('./session-checkpoints.js');
const { sessionTokenUsageRepo } = await import('./session-token-usage.js');

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
        'session_token_usage',
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
    'session_token_usage',
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
        'idx_session_token_usage_session',
        'idx_session_token_usage_run',
        'idx_history_project'
      )
    ORDER BY name
  `).all() as Array<{ name: string }>;

  assert.deepEqual(rows.map((row) => row.name), [
    'idx_history_project',
    'idx_session_evidence_session',
    'idx_session_messages_session',
    'idx_session_runs_session',
    'idx_session_token_usage_run',
    'idx_session_token_usage_session',
    'idx_sessions_project_status_updated',
  ]);
});

test('sessionTokenUsageRepo summarizes latest token usage snapshot per run', () => {
  const project = projectRepo.create({
    name: 'Token Usage Project',
    path: mkdtempSync(join(tmpdir(), 'token-usage-project-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Token Usage Session',
  });
  const firstRun = sessionRunRepo.create({
    session_id: session.id,
    provider: 'codex',
    model: 'gpt-5.5',
    mode: 'code',
    prompt: 'first',
  });
  const secondRun = sessionRunRepo.create({
    session_id: session.id,
    provider: 'codex',
    model: 'gpt-5.5',
    mode: 'code',
    prompt: 'second',
  });

  sessionTokenUsageRepo.create({
    session_id: session.id,
    run_id: firstRun.id,
    agent_id: 'planner',
    provider: 'codex',
    model: 'gpt-5.5',
    input_tokens: 100,
    output_tokens: 20,
    total_tokens: 120,
    source: 'provider_usage',
    raw_payload: { usage: 'first partial' },
  });
  sessionTokenUsageRepo.create({
    session_id: session.id,
    run_id: firstRun.id,
    agent_id: 'planner',
    provider: 'codex',
    model: 'gpt-5.5',
    input_tokens: 150,
    output_tokens: 30,
    total_tokens: 180,
    source: 'provider_usage',
    is_final: true,
    raw_payload: { usage: 'first final' },
  });
  sessionTokenUsageRepo.create({
    session_id: session.id,
    run_id: secondRun.id,
    agent_id: 'planner',
    provider: 'codex',
    model: 'gpt-5.5',
    input_tokens: 70,
    output_tokens: 25,
    total_tokens: 95,
    source: 'provider_usage',
    is_final: true,
    raw_payload: { usage: 'second final' },
  });

  const summary = sessionTokenUsageRepo.summarizeBySession(session.id);

  assert.deepEqual(summary, {
    input: 220,
    output: 55,
    total: 275,
  });
  sessionRepo.close(session.id);
});

test('session schema creates agent runtime and event tables', () => {
  const tables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table'
      AND name IN ('session_agent_runtimes', 'session_agent_events')
    ORDER BY name
  `).all() as Array<{ name: string }>;

  assert.deepEqual(tables.map((row) => row.name), [
    'session_agent_events',
    'session_agent_runtimes',
  ]);

  const runColumns = db.prepare('PRAGMA table_info(session_runs)').all() as Array<{ name: string }>;
  assert.ok(runColumns.some((column) => column.name === 'agent_id'));
});

test('session schema includes active workspace columns', () => {
  const columns = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;

  assert.ok(columns.some((column) => column.name === 'closed_at'));
  assert.ok(columns.some((column) => column.name === 'pinned_at'));
  assert.ok(columns.some((column) => column.name === 'last_viewed_at'));
});

test('sessionRepo active workspace list includes unclosed sessions across projects and excludes closed sessions', () => {
  const projectA = projectRepo.create({
    name: 'Active A',
    path: mkdtempSync(join(tmpdir(), 'active-a-')),
  });
  const projectB = projectRepo.create({
    name: 'Active B',
    path: mkdtempSync(join(tmpdir(), 'active-b-')),
  });
  const first = sessionRepo.create({
    project_id: projectA.id,
    title: 'First',
  });
  const second = sessionRepo.create({
    project_id: projectB.id,
    title: 'Second',
  });

  sessionRepo.close(first.id);

  const sessions = sessionRepo.listActiveWorkspaceSessions();

  assert.deepEqual(sessions.map((session) => session.id), [second.id]);
  assert.equal(sessionRepo.get(first.id)?.closed_at !== null, true);
});

test('sessionRepo active workspace list excludes archived sessions', () => {
  const project = projectRepo.create({
    name: 'Archived Active',
    path: mkdtempSync(join(tmpdir(), 'active-archived-')),
  });
  const archived = sessionRepo.create({
    project_id: project.id,
    title: 'Archived',
  });
  const active = sessionRepo.create({
    project_id: project.id,
    title: 'Still Active',
  });

  sessionRepo.update(archived.id, { status: 'archived', phase: 'archived', archived_at: 1 });

  const sessions = sessionRepo.listActiveWorkspaceSessions();

  assert.equal(sessions.some((session) => session.id === active.id), true);
  assert.equal(sessions.some((session) => session.id === archived.id), false);
  assert.equal(sessionRepo.get(archived.id)?.status, 'archived');
  assert.equal(sessionRepo.get(archived.id)?.closed_at, null);
  assert.equal(sessionRepo.get(archived.id)?.archived_at !== null, true);
});

test('sessionRepo pins active workspace sessions ahead of recent unpinned sessions', () => {
  const project = projectRepo.create({
    name: 'Pinned Active',
    path: mkdtempSync(join(tmpdir(), 'active-pinned-')),
  });
  const normal = sessionRepo.create({
    project_id: project.id,
    title: 'Normal',
  });
  const pinned = sessionRepo.create({
    project_id: project.id,
    title: 'Pinned',
  });

  sessionRepo.pin(pinned.id);

  const sessions = sessionRepo.listActiveWorkspaceSessions();

  assert.equal(sessions[0]?.id, pinned.id);
  assert.ok(sessions.some((session) => session.id === normal.id));
  assert.equal(sessionRepo.get(pinned.id)?.pinned_at !== null, true);
});

test('sessionRepo touchViewed updates last viewed without closing the session', () => {
  const project = projectRepo.create({
    name: 'Viewed Active',
    path: mkdtempSync(join(tmpdir(), 'active-viewed-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Viewed',
  });

  sessionRepo.touchViewed(session.id);

  const viewed = sessionRepo.get(session.id);
  assert.equal(viewed?.closed_at, null);
  assert.equal(viewed?.last_viewed_at !== null, true);
});

test('sessionRepo touchViewed does not reorder the active workspace list', () => {
  const project = projectRepo.create({
    name: 'Viewed Stable Active',
    path: mkdtempSync(join(tmpdir(), 'active-viewed-stable-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Viewed Stable',
  });
  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(1, session.id);
  const before = sessionRepo.get(session.id);

  sessionRepo.touchViewed(session.id);

  const viewed = sessionRepo.get(session.id);
  assert.equal(viewed?.closed_at, null);
  assert.equal(viewed?.last_viewed_at !== null, true);
  assert.equal(viewed?.updated_at, before?.updated_at);
});

test('session agent runtime repo stores provider session per agent', () => {
  const project = projectRepo.create({
    name: 'agent runtime project',
    path: mkdtempSync(join(tmpdir(), 'session-agent-runtime-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Agent Runtime',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });

  const runtime = sessionAgentRuntimeRepo.upsert({
    session_id: session.id,
    agent_id: 'planner',
    provider: 'codex',
    model: 'gpt-test',
    provider_session_id: 'acp-session-1',
    status: 'running',
  });

  assert.equal(runtime.agent_id, 'planner');
  assert.equal(runtime.provider_session_id, 'acp-session-1');

  const next = sessionAgentRuntimeRepo.upsert({
    session_id: session.id,
    agent_id: 'planner',
    provider: 'codex',
    model: 'gpt-test',
    provider_session_id: 'acp-session-2',
    status: 'idle',
  });

  assert.equal(next.id, runtime.id);
  assert.equal(sessionAgentRuntimeRepo.getByAgent(session.id, 'planner', 'codex')?.provider_session_id, 'acp-session-2');
});

test('session run repo finds reusable acp session by session agent and provider', () => {
  const project = projectRepo.create({
    name: 'run reuse project',
    path: mkdtempSync(join(tmpdir(), 'session-run-reuse-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Run Reuse',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });

  sessionRunRepo.create({
    session_id: session.id,
    agent_id: 'planner',
    provider: 'codex',
    mode: 'code',
    prompt: 'first',
    acp_session_id: 'acp-first',
  });
  sessionRunRepo.create({
    session_id: session.id,
    agent_id: 'reviewer',
    provider: 'codex',
    mode: 'code',
    prompt: 'review',
    acp_session_id: 'acp-reviewer',
  });

  assert.equal(sessionRunRepo.findReusableAcpSessionId({
    session_id: session.id,
    agent_id: 'planner',
    provider: 'codex',
  }), 'acp-first');
  assert.equal(sessionRunRepo.findReusableAcpSessionId({
    session_id: session.id,
    agent_id: 'reviewer',
    provider: 'codex',
  }), 'acp-reviewer');
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
