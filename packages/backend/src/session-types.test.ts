import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionWorkspacePayload } from './session-types.js';

test('SessionWorkspacePayload supports the initial workspace contract', () => {
  const payload = {
    project: {
      id: 'project-1',
      name: 'OpenClaw',
      path: '/tmp/openclaw',
      description: null,
      pinned_at: null,
      sort_order: null,
      message_routing_mode: 'fallback_reply',
      fallback_agent_id: null,
      created_at: 1,
      updated_at: 1,
    },
    activeSession: {
      session: {
        id: 'session-1',
        project_id: 'project-1',
        title: 'Session OS',
        current_goal: '实现会话系统',
        mode: 'code',
        phase: 'implementing',
        status: 'active',
        provider: 'codex',
        model: null,
        workspace_path: '/tmp/openclaw',
        worktree_path: null,
        branch_name: 'feat/session-os',
        forked_from_session_id: null,
        forked_from_history_record_id: null,
        latest_compaction_id: null,
        latest_context_manifest_id: null,
        created_at: 1,
        updated_at: 2,
        archived_at: null,
      },
      messages: [],
      runs: [],
      planItems: [],
      compactions: [],
      checkpoints: [],
      evidence: [],
    },
    historyRecords: [],
    status: {
      goal: '实现会话系统',
      mode: 'code',
      phase: 'implementing',
      status: 'active',
      context: {
        totalTokenEstimate: 0,
        latestCompactionId: null,
        retainedRecentMessages: 0,
        pressure: 'low',
      },
      git: {
        branchName: 'feat/session-os',
        changedFileCount: 0,
        hasUncommittedDiff: false,
        conflictRisk: 'none',
      },
      verification: {
        lastCommand: null,
        status: 'unknown',
        completedAt: null,
      },
      blocker: null,
      nextAction: {
        label: '继续会话',
        command: null,
        reason: '没有终态阻塞',
      },
      provider: {
        backend: 'codex',
        model: null,
        permissionMode: 'read-only',
      },
    },
    context: null,
    evidence: [],
  } satisfies SessionWorkspacePayload;

  assert.equal(payload.activeSession.session.mode, 'code');
  assert.equal(payload.status.context.pressure, 'low');
});
