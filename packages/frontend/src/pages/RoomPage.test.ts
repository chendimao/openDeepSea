import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../lib/types';
import { parseMessageMetadata } from '../lib/messageMetadata';
import {
  createDefaultReplyTarget,
  createPlannerDispatchInput,
  hasDispatchablePlannerSteps,
  createReplyTarget,
} from './roomPageLogic';

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

test('createReplyTarget keeps explicit reply metadata compact', () => {
  const target = createReplyTarget(
    createMessage({
      id: 'planner-message',
      sender_type: 'agent',
      content: '这是一段很长的 planner 建议，需要被压缩成引用摘要。'.repeat(8),
    }),
    true,
  );

  assert.equal(target.messageId, 'planner-message');
  assert.equal(target.senderName, '产品经理');
  assert.equal(target.explicit, true);
  assert.ok(target.excerpt.length <= 96);
});

test('room main path treats planner decision and trace as normal agent message metadata', () => {
  const message = createMessage({
    id: 'planner-message',
    sender_type: 'agent',
    content: '建议先让前端执行器检查设置页。',
    metadata: JSON.stringify({
      planner_decision: {
        mode: 'pause_after_suggestion',
        status: 'suggested',
        summary: '建议先验证模型配置与连接测试链路',
        next_steps: [{ agent_id: 'frontend-executor', goal: '检查设置页测试模型入口' }],
        awaiting_user_confirmation: true,
      },
      trace: {
        thinking: [{ text: '完整 thinking 原文' }],
        tool_calls: [{ name: 'search_files', input: '{"pattern":"settings"}' }],
      },
      task_readiness: {
        ready: true,
        confidence: 1,
        title: '历史兼容字段',
        description: 'Room 主路径不再消费此字段。',
        missing_questions: [],
        recommended_mode: 'formal_workflow',
      },
    }),
  });

  const metadata = parseMessageMetadata(message.metadata);

  assert.equal(message.sender_type, 'agent');
  assert.equal(metadata.planner_decision?.awaiting_user_confirmation, true);
  assert.equal(metadata.planner_decision?.next_steps[0]?.agent_id, 'frontend-executor');
  assert.equal(metadata.trace?.thinking?.[0]?.text, '完整 thinking 原文');
  assert.equal(metadata.trace?.tool_calls?.[0]?.name, 'search_files');
});

test('createPlannerDispatchInput targets the planner decision attached to the clicked message', () => {
  const message = createMessage({
    id: 'planner-message',
    sender_type: 'agent',
    content: '建议先检查运行上下文。',
    metadata: JSON.stringify({
      source_message_id: 'user-request',
      planner_decision: {
        mode: 'pause_after_suggestion',
        status: 'suggested',
        summary: '建议先检查运行上下文',
        next_steps: [{ agent_id: 'runtime-inspector', goal: '检查 Codex CLI 启动规则' }],
        awaiting_user_confirmation: true,
      },
    }),
  });

  const input = createPlannerDispatchInput(message);

  assert.equal(input?.source_message_id, 'user-request');
  assert.equal(input?.planner_decision.next_steps[0]?.agent_id, 'runtime-inspector');
});

test('createPlannerDispatchInput falls back to the clicked message id for legacy planner metadata', () => {
  const message = createMessage({
    id: 'planner-message',
    sender_type: 'agent',
    content: '建议继续。',
    metadata: JSON.stringify({
      planner_decision: {
        mode: 'pause_after_suggestion',
        status: 'suggested',
        summary: '建议继续',
        next_steps: [{ agent_id: 'planner', goal: '继续分析' }],
        awaiting_user_confirmation: true,
      },
    }),
  });

  const input = createPlannerDispatchInput(message);

  assert.equal(input?.source_message_id, 'planner-message');
});

test('hasDispatchablePlannerSteps only enables continue when planner has concrete next steps', () => {
  assert.equal(hasDispatchablePlannerSteps({
    mode: 'pause_after_suggestion',
    status: 'suggested',
    summary: '只是说明',
    next_steps: [],
    awaiting_user_confirmation: true,
  }), false);
  assert.equal(hasDispatchablePlannerSteps({
    mode: 'pause_after_suggestion',
    status: 'suggested',
    summary: '建议派发',
    next_steps: [{ agent_id: 'planner', goal: '继续分析' }],
    awaiting_user_confirmation: true,
  }), true);
});

function createMessage(input: Pick<Message, 'id' | 'sender_type' | 'content'> & {
  created_at?: number;
  metadata?: string | null;
}): Message {
  return {
    id: input.id,
    room_id: 'room-1',
    sender_type: input.sender_type,
    sender_id: input.sender_type === 'agent' ? 'planner' : 'user',
    sender_name: input.sender_type === 'agent' ? '产品经理' : 'You',
    content: input.content,
    message_type: input.sender_type === 'agent' ? 'agent_stream' : 'text',
    metadata: input.metadata ?? null,
    created_at: input.created_at ?? Date.now(),
  };
}
