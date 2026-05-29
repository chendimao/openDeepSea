import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRun, Message } from '../lib/types';
import type { AgentTimelineEvent } from '../lib/types';
import { parseMessageMetadata } from '../lib/messageMetadata';
import {
  findPreviousUserMessage,
  shouldUseStreamingDisplayForMessage,
  upsertAgentRun,
} from './RoomPage';
import {
  applyMessageStreamBatch,
  applyMessageStreamUpdate,
  createDefaultReplyTarget,
  createPlannerDispatchInput,
  hasDispatchablePlannerSteps,
  createReplyTarget,
  mergeMessageStreamEvent,
  mergeMessageStreamTrace,
  mergeTimelineEventPayload,
  mergeTraceEvents,
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
  assert.equal(hasDispatchablePlannerSteps({
    mode: 'auto_continue',
    status: 'suggested',
    summary: '自动派发',
    next_steps: [{ agent_id: 'qa-tester', goal: '验证计数器页面' }],
    awaiting_user_confirmation: false,
  }), false);
  assert.equal(hasDispatchablePlannerSteps({
    mode: 'auto_continue',
    status: 'suggested',
    summary: '自动派发不应显示按钮',
    next_steps: [{ agent_id: 'qa-tester', goal: '验证计数器页面' }],
    awaiting_user_confirmation: true,
  }), false);
});

test('findPreviousUserMessage selects the user prompt before a failed agent response', () => {
  const messages = [
    createMessage({ id: 'user-old', sender_type: 'user', content: '旧问题' }),
    createMessage({ id: 'agent-old', sender_type: 'agent', content: '旧回复' }),
    createMessage({ id: 'user-latest', sender_type: 'user', content: '需要重试的问题' }),
    createMessage({ id: 'agent-failed', sender_type: 'agent', content: '' }),
  ];

  const retrySource = findPreviousUserMessage(messages, 3);

  assert.equal(retrySource?.id, 'user-latest');
});

test('findPreviousUserMessage ignores blank user messages', () => {
  const messages = [
    createMessage({ id: 'user-valid', sender_type: 'user', content: '有效问题' }),
    createMessage({ id: 'user-blank', sender_type: 'user', content: '   ' }),
    createMessage({ id: 'agent-failed', sender_type: 'agent', content: '' }),
  ];

  const retrySource = findPreviousUserMessage(messages, 2);

  assert.equal(retrySource?.id, 'user-valid');
});

test('shouldUseStreamingDisplayForMessage ignores local streaming state after terminal run', () => {
  const message = createMessage({
    id: 'agent-message',
    sender_type: 'agent',
    content: '后端完整正文',
  });

  assert.equal(
    shouldUseStreamingDisplayForMessage(message, createAgentRun({ status: 'completed' }), true),
    false,
  );
  assert.equal(
    shouldUseStreamingDisplayForMessage(message, createAgentRun({ status: 'running' }), false),
    true,
  );
  assert.equal(
    shouldUseStreamingDisplayForMessage(message, undefined, true),
    true,
  );
});

test('mergeTraceEvents merges duplicate event ids and appends streaming text fields', () => {
  const original: AgentTimelineEvent = {
    id: 'run-1:1',
    message_id: 'message-1',
    run_id: 'run-1',
    agent_id: 'planner',
    seq: 1,
    type: 'thinking',
    status: 'delta',
    title: '思考过程',
    payload: { text: 'abc', stdout: 'one', stderr: 'err' },
    created_at: 1000,
  };
  const incoming: AgentTimelineEvent = {
    ...original,
    payload: { text: 'abcd', stdout: 'one-two', stderr: 'err-two', output: 'done' },
    created_at: 1001,
  };

  const merged = mergeTraceEvents([original], [incoming]);

  assert.equal(merged[0]?.payload.text, 'abcd');
  assert.equal(merged[0]?.payload.stdout, 'one-two');
  assert.equal(merged[0]?.payload.stderr, 'err-two');
  assert.equal(merged[0]?.payload.output, 'done');
});

test('mergeTimelineEventPayload preserves structured fields while appending text-like values', () => {
  const payload = mergeTimelineEventPayload(
    { text: 'abc', output: '1', stdout: 'x', stderr: 'y', nested: { a: 1 } },
    { text: 'abcd', output: '12', stdout: 'xyz', stderr: 'yz', nested: { a: 2 } },
  );

  assert.equal(payload.text, 'abcd');
  assert.equal(payload.output, '12');
  assert.equal(payload.stdout, 'xyz');
  assert.equal(payload.stderr, 'yz');
  assert.deepEqual(payload.nested, { a: 2 });
});

test('mergeMessageStreamEvent appends trace events into message metadata', () => {
  const message = createMessage({
    id: 'agent-message',
    sender_type: 'agent',
    content: '正文',
    metadata: JSON.stringify({ trace: { thinking: [{ text: 'keep' }] } }),
  });
  const event: AgentTimelineEvent = {
    id: 'run-1:1',
    message_id: 'agent-message',
    run_id: 'run-1',
    agent_id: 'planner',
    seq: 1,
    type: 'plan_update',
    status: 'completed',
    title: '计划更新',
    payload: { status: 'completed', plan: [{ title: 'A' }] },
    created_at: 1000,
  };

  const merged = mergeMessageStreamEvent(message, event);
  const metadata = parseMessageMetadata(merged.metadata);

  assert.equal(metadata.trace?.thinking?.[0]?.text, 'keep');
  assert.equal(metadata.trace?.events?.[0]?.id, 'run-1:1');
});

test('applyMessageStreamUpdate inserts final message snapshot when placeholder is missing', () => {
  const finalMessage = createMessage({
    id: 'agent-message',
    sender_type: 'agent',
    content: '任务已经完成，前端现在应立即显示正文。',
    created_at: 2000,
    metadata: JSON.stringify({ trace: { events: [] } }),
  });

  const result = applyMessageStreamUpdate(undefined, {
    messageId: finalMessage.id,
    chunk: '',
    done: true,
    channel: 'answer',
    message: finalMessage,
  });

  assert.equal(result.matched, true);
  assert.equal(result.fullContent, finalMessage.content);
  assert.equal(result.messages?.length, 1);
  assert.equal(result.messages?.[0]?.content, finalMessage.content);
});

test('applyMessageStreamUpdate merges final message content and keeps streamed trace events', () => {
  const placeholder = createMessage({
    id: 'agent-message',
    sender_type: 'agent',
    content: '',
    metadata: JSON.stringify({
      trace: {
        events: [
          {
            id: 'run-1:1',
            message_id: 'agent-message',
            run_id: 'run-1',
            agent_id: 'planner',
            seq: 1,
            type: 'assistant_message',
            status: 'delta',
            title: '助手回复',
            payload: { text: '任务' },
            created_at: 1000,
          },
        ],
      },
    }),
  });
  const finalMessage = createMessage({
    id: 'agent-message',
    sender_type: 'agent',
    content: '任务已经完成。',
    metadata: JSON.stringify({
      trace: {
        events: [
          {
            id: 'run-1:2',
            message_id: 'agent-message',
            run_id: 'run-1',
            agent_id: 'planner',
            seq: 2,
            type: 'tool_result',
            status: 'completed',
            title: '工具结果',
            payload: { name: 'Read' },
            created_at: 1001,
          },
        ],
      },
    }),
  });

  const result = applyMessageStreamUpdate([placeholder], {
    messageId: finalMessage.id,
    chunk: '',
    done: true,
    channel: 'answer',
    message: finalMessage,
  });
  const metadata = parseMessageMetadata(result.messages?.[0]?.metadata ?? null);

  assert.equal(result.fullContent, '任务已经完成。');
  assert.equal(result.messages?.[0]?.content, '任务已经完成。');
  assert.deepEqual(metadata.trace?.events?.map((event) => event.id), ['run-1:1', 'run-1:2']);
});

test('applyMessageStreamBatch ignores stale stream updates after final snapshot', () => {
  const placeholder = createMessage({
    id: 'agent-message',
    sender_type: 'agent',
    content: '',
    metadata: JSON.stringify({ trace: { events: [] } }),
  });
  const finalMessage = createMessage({
    id: 'agent-message',
    sender_type: 'agent',
    content: '最终完整正文。',
    metadata: JSON.stringify({ trace: { events: [] } }),
  });

  const result = applyMessageStreamBatch([placeholder], [
    {
      messageId: 'agent-message',
      runId: 'run-1',
      chunk: '最终',
      done: false,
      channel: 'answer',
    },
    {
      messageId: 'agent-message',
      runId: 'run-1',
      chunk: '',
      done: true,
      channel: 'answer',
      message: finalMessage,
    },
    {
      messageId: 'agent-message',
      runId: 'run-1',
      chunk: '旧队列追加内容',
      done: false,
      channel: 'answer',
    },
  ]);

  assert.equal(result.messages?.[0]?.content, '最终完整正文。');
  assert.equal(result.finalizedMessageIds.has('agent-message'), true);
  assert.equal(result.finalizedRunIds.has('run-1'), true);
});

test('mergeMessageStreamTrace keeps legacy trace channels intact', () => {
  const message = createMessage({
    id: 'agent-message',
    sender_type: 'agent',
    content: '正文',
    metadata: JSON.stringify({ trace: { thinking: [{ text: 'keep' }] } }),
  });

  const merged = mergeMessageStreamTrace(message, 'thinking', '追加');
  const metadata = parseMessageMetadata(merged.metadata);

  assert.equal(metadata.trace?.thinking?.[0]?.text, 'keep追加');
});

test('upsertAgentRun does not regress a terminal run to running from a stale update', () => {
  const completed = createAgentRun({
    status: 'completed',
    updated_at: 2000,
    completed_at: 2000,
  });
  const staleRunning = createAgentRun({
    status: 'running',
    updated_at: 1500,
    completed_at: null,
  });

  const result = upsertAgentRun([completed], staleRunning);

  assert.equal(result[0]?.status, 'completed');
  assert.equal(result[0]?.updated_at, 2000);
});

test('upsertAgentRun keeps terminal status even if a later non-terminal snapshot arrives', () => {
  const completed = createAgentRun({
    status: 'completed',
    updated_at: 2000,
    completed_at: 2000,
  });
  const running = createAgentRun({
    status: 'running',
    updated_at: 2500,
    completed_at: null,
  });

  const result = upsertAgentRun([completed], running);

  assert.equal(result[0]?.status, 'completed');
  assert.equal(result[0]?.updated_at, 2000);
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

function createAgentRun(input: Partial<AgentRun> = {}): AgentRun {
  return {
    id: input.id ?? 'run-1',
    room_id: input.room_id ?? 'room-1',
    room_agent_id: input.room_agent_id ?? 'room-agent-1',
    agent_id: input.agent_id ?? 'planner',
    backend: input.backend ?? 'codex',
    status: input.status ?? 'running',
    session_key: input.session_key ?? null,
    acp_session_id: input.acp_session_id ?? null,
    task_id: input.task_id ?? null,
    workflow_run_id: input.workflow_run_id ?? null,
    workflow_step_id: input.workflow_step_id ?? null,
    workflow_stage: input.workflow_stage ?? null,
    prompt: input.prompt ?? 'prompt',
    stdout: input.stdout ?? '',
    stderr: input.stderr ?? '',
    activity_log: input.activity_log ?? '',
    error: input.error ?? null,
    started_at: input.started_at ?? 1000,
    updated_at: input.updated_at ?? 1000,
    completed_at: input.completed_at ?? null,
  };
}
