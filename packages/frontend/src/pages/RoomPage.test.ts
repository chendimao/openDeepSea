import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../lib/types';
import {
  createDefaultReplyTarget,
  createWorkflowEventRenderStateMap,
  getTaskReadinessActionState,
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

test('analysis-only ready messages do not expose formal workflow start', () => {
  const state = getTaskReadinessActionState('analysis_only');

  assert.equal(state.canGenerateTask, false);
  assert.equal(state.primaryLabel, '继续沟通');
  assert.equal(state.description, '这是方案/分析输出，不会直接启动正式 workflow');
});

test('workflow task card render state dedupes events with the same workflow run', () => {
  const messages = [
    createMessage({ id: 'workflow-start', sender_type: 'system', content: '开始', created_at: 10, metadata: workflowMetadata('workflow-1', 'task-1', 'workflow_started') }),
    createMessage({ id: 'agent-note', sender_type: 'agent', content: '普通回复', created_at: 20 }),
    createMessage({ id: 'workflow-progress', sender_type: 'system', content: '执行中', created_at: 30, metadata: workflowMetadata('workflow-1', 'task-1', 'workflow_stage_changed') }),
    createMessage({ id: 'workflow-done', sender_type: 'system', content: '完成', created_at: 40, metadata: workflowMetadata('workflow-1', 'task-1', 'workflow_completed') }),
    createMessage({ id: 'workflow-task-2', sender_type: 'system', content: '第二个任务', created_at: 50, metadata: workflowMetadata('workflow-1', 'task-2', 'workflow_stage_changed') }),
  ];

  const renderState = createWorkflowEventRenderStateMap(messages);

  assert.equal(renderState.get('workflow-start')?.showTaskCard, true);
  assert.equal(renderState.get('workflow-start')?.key, 'workflow:workflow-1');
  assert.equal(renderState.get('workflow-progress')?.showTaskCard, false);
  assert.equal(renderState.get('workflow-done')?.showTaskCard, false);
  assert.equal(renderState.get('workflow-task-2')?.showTaskCard, false);
  assert.equal(renderState.has('agent-note'), false);
});

test('workflow task card render state keeps different workflow runs separate', () => {
  const messages = [
    createMessage({ id: 'workflow-a', sender_type: 'system', content: 'A', created_at: 10, metadata: workflowMetadata('workflow-a', 'task-1', 'workflow_started') }),
    createMessage({ id: 'workflow-b', sender_type: 'system', content: 'B', created_at: 20, metadata: workflowMetadata('workflow-b', 'task-1', 'workflow_started') }),
  ];

  const renderState = createWorkflowEventRenderStateMap(messages);

  assert.equal(renderState.get('workflow-a')?.showTaskCard, true);
  assert.equal(renderState.get('workflow-b')?.showTaskCard, true);
  assert.notEqual(renderState.get('workflow-a')?.key, renderState.get('workflow-b')?.key);
});

test('workflow task card render state falls back when workflow id is missing', () => {
  const messages = [
    createMessage({ id: 'task-only-start', sender_type: 'system', content: '开始', created_at: 10, metadata: workflowMetadata(undefined, 'task-only', 'workflow_started') }),
    createMessage({ id: 'task-only-done', sender_type: 'system', content: '完成', created_at: 20, metadata: workflowMetadata(undefined, 'task-only', 'workflow_completed') }),
  ];

  const renderState = createWorkflowEventRenderStateMap(messages);

  assert.equal(renderState.get('task-only-start')?.key, 'task:task-only');
  assert.equal(renderState.get('task-only-start')?.showTaskCard, true);
  assert.equal(renderState.get('task-only-done')?.showTaskCard, false);
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

function workflowMetadata(
  workflowRunId: string | undefined,
  taskId: string | undefined,
  eventType: string,
): string {
  return JSON.stringify({
    event_type: eventType,
    workflow_run_id: workflowRunId,
    task_id: taskId,
  });
}
