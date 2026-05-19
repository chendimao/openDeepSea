import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../lib/types';
import { createDefaultReplyTarget, getTaskReadinessActionState } from './roomPageLogic';

test('createDefaultReplyTarget returns the latest non-streaming agent message', () => {
  const messages = [
    createMessage({ id: 'agent-complete', sender_type: 'agent', content: '已经完成的问题' }),
    createMessage({ id: 'user-latest', sender_type: 'user', content: '用户消息' }),
    createMessage({ id: 'agent-streaming', sender_type: 'agent', content: '正在输出中' }),
  ];

  const target = createDefaultReplyTarget(messages, new Set(['agent-streaming']));

  assert.equal(target?.messageId, 'agent-complete');
  assert.equal(target?.explicit, false);
});

test('createDefaultReplyTarget returns null when default reply is suppressed for the only agent message', () => {
  const messages = [
    createMessage({ id: 'agent-complete', sender_type: 'agent', content: '已经完成的问题' }),
    createMessage({ id: 'user-latest', sender_type: 'user', content: '新需求' }),
  ];

  const target = createDefaultReplyTarget(messages, new Set(['agent-complete']));

  assert.equal(target, null);
});

test('analysis-only ready messages do not expose formal workflow start', () => {
  const state = getTaskReadinessActionState('analysis_only');

  assert.equal(state.canGenerateTask, false);
  assert.equal(state.primaryLabel, '继续沟通');
  assert.equal(state.description, '这是方案/分析输出，不会直接启动正式 workflow');
});

function createMessage(input: Pick<Message, 'id' | 'sender_type' | 'content'>): Message {
  return {
    id: input.id,
    room_id: 'room-1',
    sender_type: input.sender_type,
    sender_id: input.sender_type === 'agent' ? 'planner' : 'user',
    sender_name: input.sender_type === 'agent' ? '产品经理' : 'You',
    content: input.content,
    message_type: input.sender_type === 'agent' ? 'agent_stream' : 'text',
    metadata: null,
    created_at: Date.now(),
  };
}
