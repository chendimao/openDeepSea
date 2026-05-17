import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMentionTokens, resolveMentionedAgentRoomIds } from './mentions.js';
import type { RoomAgent } from './types.js';

function agent(input: Partial<RoomAgent> & Pick<RoomAgent, 'id' | 'agent_id' | 'agent_name'>): RoomAgent {
  return {
    room_id: 'room-1',
    global_agent_id: null,
    agent_role: null,
    preferred_user_name: null,
    personality: null,
    rules: null,
    responsibilities: null,
    workflow_role: null,
    joined_at: 0,
    left_at: null,
    acp_enabled: 0,
    acp_backend: null,
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'bypass',
    acp_writable_dirs: [],
    capabilities: [],
    default_runtime: 'openclaw',
    memory_max_context_chars: null,
    ...input,
  };
}

test('extractMentionTokens supports Chinese agent names', () => {
  assert.deepEqual(extractMentionTokens('@智能体 帮我看一下'), ['智能体']);
});

test('resolveMentionedAgentRoomIds resolves Chinese names from content', () => {
  const ids = resolveMentionedAgentRoomIds({
    content: '请 @智能体 回复',
    agents: [agent({ id: 'room-agent-1', agent_id: 'coder', agent_name: '智能体' })],
  });

  assert.deepEqual(ids, ['room-agent-1']);
});

test('resolveMentionedAgentRoomIds merges explicit ids and parsed mentions', () => {
  const ids = resolveMentionedAgentRoomIds({
    content: '@planner please review',
    explicitRoomAgentIds: ['explicit-room-agent'],
    agents: [agent({ id: 'parsed-room-agent', agent_id: 'planner', agent_name: '规划师' })],
  });

  assert.deepEqual(ids, ['explicit-room-agent', 'parsed-room-agent']);
});
