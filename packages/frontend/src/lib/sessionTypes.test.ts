import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionWorkspacePayload, StatusSnapshot } from './types';

test('session workspace payload keeps active session, history and inspector data together', () => {
  const status: StatusSnapshot = {
    goal: '实现 SessionOS',
    mode: 'code',
    phase: 'implementing',
    status: 'active',
    context: {
      totalTokenEstimate: 1200,
      latestCompactionId: null,
      retainedRecentMessages: 20,
      pressure: 'low',
    },
    git: {
      branchName: 'feat/session-os',
      changedFileCount: 2,
      hasUncommittedDiff: true,
      conflictRisk: 'low',
    },
    verification: {
      lastCommand: 'npm run build',
      status: 'passed',
      completedAt: 1,
    },
    blocker: null,
    nextAction: {
      label: '继续会话',
      command: null,
      reason: '没有终态阻塞',
    },
    provider: {
      backend: 'codex',
      model: 'gpt-test',
      permissionMode: 'workspace-write',
    },
  };
  const payload = {
    project: {
      id: 'project-1',
      name: 'OpenClaw',
      path: '/workspace',
      description: null,
      message_routing_mode: 'mentions_only',
      fallback_agent_id: null,
      created_at: 1,
      updated_at: 1,
    },
    activeSession: {
      session: {
        id: 'session-1',
        project_id: 'project-1',
        title: 'SessionOS',
        current_goal: '实现 SessionOS',
        mode: 'code',
        phase: 'implementing',
        status: 'active',
        provider: 'codex',
        model: 'gpt-test',
        workspace_path: '/workspace',
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
    status,
    context: null,
    evidence: [],
    projectSwitcher: {
      activeProjectId: 'project-1',
      projects: [{
        id: 'project-1',
        name: 'OpenClaw',
        path: '/workspace',
        active: true,
        recentSessions: [],
      }],
    },
    bottomStatus: {
      health: 'ok',
      healthLabel: '良好',
      indexStatus: 'unknown',
      indexLabel: '未接入索引',
      lastResponseMs: null,
      errorRate: 0,
      networkLatencyMs: null,
      tokenUsage: null,
    },
    contract: {
      sessionId: 'session-1',
      objective: '实现 SessionOS',
      scope: null,
      risks: [],
      acceptanceCriteria: [],
      updated_at: 1,
    },
    toolRows: [],
    diffRows: [],
    historyFilters: {
      q: '',
      status: 'all',
      mode: 'all',
    },
  } satisfies SessionWorkspacePayload;

  assert.equal(payload.activeSession.session.mode, 'code');
  assert.equal(payload.status.git.changedFileCount, 2);
  assert.equal(payload.projectSwitcher.projects[0]?.active, true);
  assert.equal(payload.contract.objective, '实现 SessionOS');
  assert.deepEqual(payload.toolRows, []);
  assert.deepEqual(payload.diffRows, []);
});
