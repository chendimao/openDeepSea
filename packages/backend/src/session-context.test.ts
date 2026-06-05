import assert from 'node:assert/strict';
import test from 'node:test';
import { buildContextManifestDraft } from './session-context.js';
import type { Session, SessionMessage } from './types.js';

test('buildContextManifestDraft includes non-empty sources with reasons and token estimates', () => {
  const session = createSession();
  const draft = buildContextManifestDraft({
    session,
    agentsText: 'AGENTS rules',
    rtkText: 'RTK rules',
    compactSummary: '已保留 UI 决策',
    historyBriefs: [{ id: 'history-1', title: '上一段', resume_brief: '继续 API 实现' }],
    recentMessages: [
      createMessage('m1', 'user', '第一条'),
      createMessage('m2', 'assistant', '第二条'),
    ],
    explicitFiles: [{ path: 'packages/backend/src/db.ts', excerpt: 'CREATE TABLE sessions' }],
    gitDiff: 'M packages/backend/src/db.ts',
  });

  assert.equal(draft.sources.length, 8);
  assert.equal(draft.totalTokenEstimate > 0, true);
  assert.deepEqual(draft.sources.map((source) => source.source_type), [
    'agents',
    'rtk',
    'compact',
    'history',
    'user_message',
    'user_message',
    'file',
    'diff',
  ]);
  assert.equal(draft.sources[0]?.reason, '项目与个人 agent 规则');
  assert.equal(draft.sources[0]?.content_hash.length, 64);
});

test('buildContextManifestDraft skips empty optional sources and keeps last 20 messages', () => {
  const messages = Array.from({ length: 25 }, (_, index) =>
    createMessage(`m${index}`, 'user', `message ${index}`),
  );
  const draft = buildContextManifestDraft({
    session: createSession(),
    agentsText: null,
    rtkText: '',
    compactSummary: null,
    historyBriefs: [],
    recentMessages: messages,
    explicitFiles: [],
    gitDiff: null,
  });

  assert.equal(draft.sources.length, 20);
  assert.equal(draft.sources[0]?.source_ref, 'm5');
  assert.equal(draft.sources[19]?.source_ref, 'm24');
});

function createSession(): Session {
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
  };
}

function createMessage(id: string, role: SessionMessage['role'], content: string): SessionMessage {
  return {
    id,
    session_id: 'session-1',
    role,
    sender_id: role,
    sender_name: null,
    content,
    message_type: 'text',
    status: 'completed',
    metadata: null,
    created_at: 1,
  };
}
