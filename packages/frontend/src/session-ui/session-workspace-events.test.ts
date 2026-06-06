import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionWorkspacePayload } from '../lib/types';
import type { WsServerEvent } from '../lib/ws';
import { applySessionWorkspaceEvent } from './session-workspace-events';

test('applySessionWorkspaceEvent ignores events for another session', () => {
  const payload = createPayload('session-current');
  const event: WsServerEvent = {
    type: 'session_run:stream',
    sessionId: 'session-other',
    agentId: 'planner',
    runId: 'run-1',
    seq: 1,
    channel: 'answer',
    chunk: 'foreign',
    done: false,
  };

  assert.equal(applySessionWorkspaceEvent(payload, event), payload);
});

test('applySessionWorkspaceEvent appends answer chunks to matching run stdout', () => {
  const payload = createPayload('session-current');
  const event: WsServerEvent = {
    type: 'session_run:stream',
    sessionId: 'session-current',
    agentId: 'planner',
    runId: 'run-1',
    seq: 1,
    channel: 'answer',
    chunk: 'hello',
    done: false,
  };

  const next = applySessionWorkspaceEvent(payload, event);
  assert.equal(next.activeSession.runs[0]?.stdout, 'hello');
});

test('applySessionWorkspaceEvent appends thinking chunks to activity log', () => {
  const payload = createPayload('session-current');
  const event: WsServerEvent = {
    type: 'session_run:stream',
    sessionId: 'session-current',
    agentId: 'planner',
    runId: 'run-1',
    seq: 2,
    channel: 'thinking',
    chunk: '分析上下文',
    done: false,
  };

  const next = applySessionWorkspaceEvent(payload, event);
  assert.equal(next.activeSession.runs[0]?.activity_log, '分析上下文');
});

test('applySessionWorkspaceEvent does not duplicate messages or evidence', () => {
  const payload = createPayload('session-current');
  const now = Date.now();
  const message = {
    id: 'message-1',
    session_id: 'session-current',
    role: 'user',
    sender_id: 'user',
    sender_name: null,
    content: '继续',
    message_type: 'text',
    status: 'completed',
    metadata: null,
    created_at: now,
  } as const;
  const event: WsServerEvent = { type: 'session_message:new', sessionId: 'session-current', message };

  const once = applySessionWorkspaceEvent(payload, event);
  const twice = applySessionWorkspaceEvent(once, event);

  assert.equal(twice.activeSession.messages.length, 1);
});

function createPayload(sessionId: string): SessionWorkspacePayload {
  const now = Date.now();
  return {
    project: {
      id: 'project-1',
      name: 'Project',
      path: '/tmp/project',
      description: null,
      pinned_at: null,
      sort_order: null,
      message_routing_mode: 'mentions_only',
      fallback_agent_id: null,
      created_at: now,
      updated_at: now,
    },
    activeSession: {
      session: {
        id: sessionId,
        project_id: 'project-1',
        title: 'Session',
        current_goal: null,
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
        created_at: now,
        updated_at: now,
        archived_at: null,
      },
      messages: [],
      runs: [{
        id: 'run-1',
        session_id: sessionId,
        agent_id: 'planner',
        provider: 'codex',
        model: null,
        status: 'running',
        mode: 'code',
        phase: 'implementing',
        prompt: 'hidden prompt',
        stdout: '',
        stderr: '',
        activity_log: '',
        error: null,
        acp_session_id: null,
        started_at: now,
        updated_at: now,
        completed_at: null,
      }],
      planItems: [],
      compactions: [],
      checkpoints: [],
      evidence: [],
    },
    historyRecords: [],
    status: {
      status: 'active',
      phase: 'implementing',
      provider: { backend: 'codex', model: null },
      context: { pressure: 'low', usedTokens: 0, maxTokens: 1, sources: [] },
      activeRun: null,
      lastCheckpoint: null,
    },
    context: null,
    evidence: [],
    projectSwitcher: { activeProjectId: 'project-1', projects: [] },
    bottomStatus: { items: [] },
    contract: {
      sessionId,
      objective: 'Session',
      scope: null,
      risks: [],
      acceptanceCriteria: [],
      created_at: now,
      updated_at: now,
    },
    toolRows: [],
    diffRows: [],
    historyFilters: { q: '', status: 'all', mode: 'all' },
  } as unknown as SessionWorkspacePayload;
}
