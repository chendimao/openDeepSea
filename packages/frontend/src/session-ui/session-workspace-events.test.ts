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
  assert.equal(next.activeSession.agentEvents[0]?.content, 'hello');
  assert.equal(next.activeSession.agentEvents[0]?.channel, 'answer');
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
  assert.equal(next.activeSession.agentEvents[0]?.content, '分析上下文');
  assert.equal(next.activeSession.agentEvents[0]?.channel, 'thinking');
});

test('applySessionWorkspaceEvent appends empty ACP agent events from stream envelope', () => {
  const payload = createPayload('session-current');
  const event: WsServerEvent = {
    type: 'session_run:stream',
    sessionId: 'session-current',
    agentId: 'planner',
    runId: 'run-1',
    seq: 3,
    channel: 'event',
    chunk: '',
    done: false,
    agentEvent: {
      id: 'agent-event-1',
      session_id: 'session-current',
      agent_id: 'planner',
      run_id: 'run-1',
      seq: 3,
      channel: 'event',
      event_type: 'tool_call',
      content: '',
      payload_json: JSON.stringify({ trace: { name: 'Read' } }),
      created_at: Date.now(),
    },
  };

  const next = applySessionWorkspaceEvent(payload, event);
  assert.equal(next.activeSession.runs[0]?.activity_log, '');
  assert.equal(next.activeSession.agentEvents[0]?.id, 'agent-event-1');
  assert.equal(next.activeSession.agentEvents[0]?.event_type, 'tool_call');
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

test('applySessionWorkspaceEvent applies active session title updates', () => {
  const payload = createPayload('session-current');
  payload.projectSwitcher.projects = [{
    id: 'project-1',
    name: 'Project',
    path: '/tmp/project',
    active: true,
    recentSessions: [{
      id: 'session-current',
      title: 'Session',
      status: 'active',
      updated_at: payload.activeSession.session.updated_at,
      href: '/projects/project-1/sessions/session-current',
      source: 'session',
    }],
  }];
  const event: WsServerEvent = {
    type: 'session:updated',
    sessionId: 'session-current',
    session: {
      ...payload.activeSession.session,
      title: '用户在当前会话第一次发送消息...',
      updated_at: Date.now() + 1000,
    },
  };

  const next = applySessionWorkspaceEvent(payload, event);

  assert.equal(next.activeSession.session.title, '用户在当前会话第一次发送消息...');
  assert.equal(next.projectSwitcher.projects[0]?.recentSessions[0]?.title, '用户在当前会话第一次发送消息...');
});

test('applySessionWorkspaceEvent replaces inspector rows from snapshot', () => {
  const payload = createPayload('session-current');
  const now = Date.now();
  const next = applySessionWorkspaceEvent(payload, {
    type: 'session_inspector:snapshot',
    sessionId: payload.activeSession.session.id,
    planItems: [{
      id: 'plan-real',
      session_id: payload.activeSession.session.id,
      parent_id: null,
      title: '真实计划项',
      description: null,
      status: 'in_progress',
      priority: 0,
      source: 'acp_plan_update',
      evidence_event_id: 'ev-plan',
      created_at: now,
      updated_at: now,
      completed_at: null,
    }],
    toolRows: [{
      id: 'tool-real',
      action: 'exec',
      label: 'exec_command',
      target: 'npm run build',
      status: 'completed',
      durationMs: null,
      severity: 'info',
      eventId: 'ev-tool',
      created_at: now,
    }],
    diffRows: [{
      path: 'packages/frontend/src/session-ui/SessionShellView.tsx',
      status: 'modified',
      additions: 4,
      deletions: 1,
      summary: 'apply_patch',
    }],
  });

  assert.equal(next.activeSession.planItems[0]?.title, '真实计划项');
  assert.equal(next.toolRows[0]?.target, 'npm run build');
  assert.equal(next.diffRows[0]?.summary, 'apply_patch');
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
        closed_at: null,
        pinned_at: null,
        last_viewed_at: null,
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
        runtime_profile_snapshot: null,
        started_at: now,
        updated_at: now,
        completed_at: null,
      }],
      agentEvents: [],
      planItems: [],
      compactions: [],
      checkpoints: [],
      evidence: [],
    },
    activeSessions: [],
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
