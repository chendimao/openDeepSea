import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionWorkspacePayload } from '../lib/types';
import { InspectorPanel } from './InspectorPanel';

test('InspectorPanel renders status tab and tab labels', () => {
  const html = renderToStaticMarkup(<InspectorPanel payload={createPayload()} onCommand={() => undefined} />);

  assert.match(html, /Session Inspector/);
  assert.match(html, /Status/);
  assert.match(html, /Context/);
  assert.match(html, /Evidence/);
  assert.match(html, /Files/);
  assert.match(html, /Provider/);
  assert.match(html, /上下文压力低/);
});

function createPayload(): SessionWorkspacePayload {
  const now = Date.now();
  return {
    project: {
      id: 'project-1',
      name: 'OpenClaw',
      path: '/workspace',
      description: null,
      message_routing_mode: 'mentions_only',
      fallback_agent_id: null,
      created_at: now,
      updated_at: now,
    },
    activeSession: {
      session: {
        id: 'session-1',
        project_id: 'project-1',
        title: 'Inspector Session',
        current_goal: '检查 Inspector',
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
        created_at: now,
        updated_at: now,
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
      goal: '检查 Inspector',
      mode: 'code',
      phase: 'implementing',
      status: 'active',
      context: {
        totalTokenEstimate: 1000,
        latestCompactionId: null,
        retainedRecentMessages: 20,
        pressure: 'low',
      },
      git: {
        branchName: 'feat/session-os',
        changedFileCount: 1,
        hasUncommittedDiff: true,
        conflictRisk: 'low',
      },
      verification: {
        lastCommand: 'npm run build',
        status: 'passed',
        completedAt: now,
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
    },
    context: null,
    evidence: [],
    projectSwitcher: {
      activeProjectId: 'project-1',
      projects: [
        {
          id: 'project-1',
          name: 'OpenClaw',
          path: '/workspace',
          active: true,
          recentSessions: [
            {
              id: 'session-1',
              title: 'Inspector Session',
              status: 'active',
              updated_at: now,
              href: '/projects/project-1/sessions/session-1',
              source: 'session',
            },
          ],
        },
      ],
    },
    bottomStatus: {
      health: 'ok',
      healthLabel: 'Ready',
      indexStatus: 'unknown',
      indexLabel: 'Index unknown',
      lastResponseMs: null,
      errorRate: null,
      networkLatencyMs: null,
      tokenUsage: null,
    },
    contract: {
      sessionId: 'session-1',
      objective: '检查 Inspector',
      scope: null,
      risks: [],
      acceptanceCriteria: [],
      updated_at: now,
    },
    toolRows: [],
    diffRows: [],
    historyFilters: {
      q: '',
      status: 'all',
      mode: 'all',
    },
  };
}
