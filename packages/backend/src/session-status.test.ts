import assert from 'node:assert/strict';
import test from 'node:test';
import { buildStatusSnapshot } from './session-status.js';
import type { Session, SessionContextManifest, SessionEvidenceEvent } from './types.js';

test('buildStatusSnapshot reports context pressure, verification and provider state', () => {
  const session = createSession({ latest_compaction_id: 'compact-1', branch_name: 'feat/session' });
  const context = {
    id: 'manifest-1',
    session_id: session.id,
    run_id: null,
    total_token_estimate: 50_000,
    prompt_hash: null,
    created_at: 1,
    sources: [],
  } satisfies SessionContextManifest;
  const verification = createEvidence({
    event_type: 'build',
    title: 'npm run build',
    payload: { command: 'npm run build', status: 'passed' },
  });

  const snapshot = buildStatusSnapshot({
    session,
    context,
    latestVerification: verification,
    latestBlocker: null,
    changedFileCount: 2,
    permissionMode: 'workspace-write',
  });

  assert.equal(snapshot.context.pressure, 'medium');
  assert.equal(snapshot.context.latestCompactionId, 'compact-1');
  assert.equal(snapshot.git.hasUncommittedDiff, true);
  assert.equal(snapshot.verification.lastCommand, 'npm run build');
  assert.equal(snapshot.verification.status, 'passed');
  assert.equal(snapshot.provider.backend, 'codex');
});

test('buildStatusSnapshot surfaces blocker as next action', () => {
  const blocker = createEvidence({
    event_type: 'blocker',
    severity: 'warning',
    title: '等待确认',
    summary: '需要用户确认删除旧入口',
    payload: { required_action: '确认硬切换范围' },
  });

  const snapshot = buildStatusSnapshot({
    session: createSession({ worktree_path: '/tmp/worktree' }),
    context: null,
    latestVerification: null,
    latestBlocker: blocker,
    changedFileCount: 0,
    permissionMode: null,
  });

  assert.equal(snapshot.blocker?.reason, '需要用户确认删除旧入口');
  assert.equal(snapshot.blocker?.requiredAction, '确认硬切换范围');
  assert.equal(snapshot.nextAction.command, '/status');
  assert.equal(snapshot.git.conflictRisk, 'low');
});

function createSession(patch: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    project_id: 'project-1',
    title: 'Session OS',
    current_goal: '实现会话系统',
    mode: 'code',
    phase: 'implementing',
    status: 'active',
    provider: 'codex',
    model: null,
    workspace_path: '/tmp/project',
    worktree_path: null,
    branch_name: null,
    forked_from_session_id: null,
    forked_from_history_record_id: null,
    latest_compaction_id: null,
    latest_context_manifest_id: null,
    created_at: 1,
    updated_at: 2,
    archived_at: null,
    ...patch,
  };
}

function createEvidence(patch: Partial<SessionEvidenceEvent>): SessionEvidenceEvent {
  return {
    id: 'event-1',
    session_id: 'session-1',
    seq: 1,
    event_type: 'status',
    severity: 'info',
    source_run_id: null,
    source_message_id: null,
    title: '事件',
    summary: null,
    payload: {},
    created_at: 3,
    ...patch,
  };
}
