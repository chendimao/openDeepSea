import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentTimelineEvent } from '../../lib/types';
import { buildAgentTimelineModel } from './model';

function event(overrides: Partial<AgentTimelineEvent>): AgentTimelineEvent {
  return {
    id: overrides.id ?? 'event-1',
    message_id: overrides.message_id ?? 'message-1',
    run_id: overrides.run_id ?? 'run-1',
    agent_id: overrides.agent_id ?? 'planner',
    seq: overrides.seq ?? 1,
    type: overrides.type ?? 'raw',
    status: overrides.status ?? 'completed',
    title: overrides.title ?? '原始事件',
    payload: overrides.payload ?? {},
    raw: overrides.raw,
    created_at: overrides.created_at ?? 1000,
  };
}

test('buildAgentTimelineModel 不展示 assistant_message 并保持可见计数准确', () => {
  const model = buildAgentTimelineModel([
    event({
      id: 'assistant-1',
      type: 'assistant_message',
      status: 'delta',
      title: '助手回复',
      payload: { text: 'hello' },
    }),
    event({
      id: 'thinking-1',
      seq: 2,
      type: 'thinking',
      status: 'delta',
      title: '思考过程',
      payload: { text: 'analyzing' },
    }),
  ]);

  assert.equal(model.visibleEvents.length, 1);
  assert.equal(model.visibleEvents[0]?.id, 'thinking-1');
  assert.equal(model.debugEvents.length, 0);
  assert.equal(model.visibleCount, 1);
});

test('buildAgentTimelineModel 将 available_commands_update 与 protocol.stderr 路由到 debugEvents', () => {
  const model = buildAgentTimelineModel([
    event({
      id: 'commands-1',
      type: 'raw',
      seq: 4,
      created_at: 1200,
      payload: { raw_type: 'available_commands_update' },
      raw: {
        method: 'session/update',
        params: { update: { sessionUpdate: 'available_commands_update' } },
      },
    }),
    event({
      id: 'stderr-1',
      type: 'raw',
      seq: 3,
      created_at: 1100,
      payload: { raw_type: 'protocol.stderr', text: 'permission denied' },
      raw: { method: 'protocol.stderr' },
    }),
    event({
      id: 'usage-1',
      type: 'raw',
      seq: 5,
      created_at: 1300,
      payload: { raw_type: 'usage_update' },
      raw: {
        method: 'session/update',
        params: { update: { sessionUpdate: 'usage_update' } },
      },
    }),
    event({
      id: 'thinking-2',
      type: 'thinking',
      seq: 2,
      created_at: 1000,
      payload: { text: 'visible' },
    }),
  ]);

  assert.equal(model.visibleEvents.length, 1);
  assert.equal(model.visibleEvents[0]?.id, 'thinking-2');
  assert.equal(model.debugEvents.length, 3);
  assert.equal(model.debugEvents[0]?.id, 'stderr-1');
  assert.equal(model.debugEvents[1]?.id, 'commands-1');
  assert.equal(model.debugEvents[2]?.id, 'usage-1');
});

test('buildAgentTimelineModel 生成 ACP thinking 流缺失诊断', () => {
  const model = buildAgentTimelineModel([
    event({
      id: 'message-1',
      type: 'assistant_message',
      status: 'delta',
      payload: { text: 'hello' },
      raw: {
        method: 'session/update',
        params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } } },
      },
    }),
    event({
      id: 'tool-1',
      type: 'tool_call',
      seq: 2,
      payload: { id: 'tool-1', name: 'Read' },
      raw: {
        method: 'session/update',
        params: { update: { sessionUpdate: 'tool_call', id: 'tool-1', title: 'Read package.json' } },
      },
    }),
  ]);

  assert.equal(model.visibleEvents.length, 1);
  assert.equal(model.diagnostics?.thoughtStreamStatus, 'missing');
  assert.match(model.diagnostics?.thoughtStreamMessage ?? '', /provider 没有返回 thinking/);
  assert.deepEqual(model.diagnostics?.protocolEventCounts, [
    { type: 'agent_message_chunk', count: 1 },
    { type: 'tool_call', count: 1 },
  ]);
});

test('buildAgentTimelineModel 识别已收到 agent_thought_chunk', () => {
  const model = buildAgentTimelineModel([
    event({
      id: 'thinking-raw-1',
      type: 'thinking',
      status: 'delta',
      payload: { text: '分析中' },
      raw: {
        method: 'session/update',
        params: { update: { sessionUpdate: 'agent_thought_chunk', delta: '分析中' } },
      },
    }),
  ]);

  assert.equal(model.diagnostics?.thoughtStreamStatus, 'received');
  assert.deepEqual(model.diagnostics?.protocolEventCounts, [
    { type: 'agent_thought_chunk', count: 1 },
  ]);
});

test('buildAgentTimelineModel 按 payload.id / payload.tool_call_id / payload.toolCallId 合并工具生命周期', () => {
  const model = buildAgentTimelineModel([
    event({
      id: 'tool-start',
      seq: 5,
      created_at: 1005,
      type: 'tool_call',
      status: 'started',
      title: '调用工具 Read package.json',
      payload: {
        id: 'tool-1',
        title: 'Read package.json',
        name: 'Read',
        kind: 'read',
        input: { path: 'package.json' },
      },
    }),
    event({
      id: 'tool-done',
      seq: 6,
      created_at: 1006,
      type: 'tool_result',
      status: 'completed',
      title: '工具结果 Read package.json',
      payload: {
        tool_call_id: 'tool-1',
        output: { ok: true },
      },
    }),
    event({
      id: 'tool-failed',
      seq: 7,
      created_at: 1007,
      type: 'tool_result',
      status: 'failed',
      title: '工具失败 Read package.json',
      payload: {
        toolCallId: 'tool-1',
        output: { ok: false, reason: 'permission denied' },
      },
    }),
  ]);

  assert.equal(model.visibleEvents.length, 1);
  const merged = model.visibleEvents[0];
  assert.equal(merged?.id, 'tool-start');
  assert.equal(merged?.type, 'tool_result');
  assert.equal(merged?.status, 'failed');
  assert.equal(merged?.title, '工具失败 Read package.json');
  assert.deepEqual(merged?.payload.input, { path: 'package.json' });
  assert.deepEqual(merged?.payload.output, { ok: false, reason: 'permission denied' });
  assert.equal(merged?.payload.title, 'Read package.json');
  assert.equal(merged?.payload.name, 'Read');
  assert.equal(merged?.payload.kind, 'read');
});

test('buildAgentTimelineModel 按 seq 与 created_at 稳定排序', () => {
  const model = buildAgentTimelineModel([
    event({
      id: 'same-seq-late',
      type: 'thinking',
      seq: 2,
      created_at: 200,
      payload: { text: 'late' },
    }),
    event({
      id: 'same-seq-early',
      type: 'thinking',
      seq: 2,
      created_at: 100,
      payload: { text: 'early' },
    }),
    event({
      id: 'same-time-a',
      type: 'thinking',
      seq: 3,
      created_at: 300,
      payload: { text: 'a' },
    }),
    event({
      id: 'same-time-b',
      type: 'thinking',
      seq: 3,
      created_at: 300,
      payload: { text: 'b' },
    }),
    event({
      id: 'first',
      type: 'thinking',
      seq: 1,
      created_at: 999,
      payload: { text: 'first' },
    }),
  ]);

  assert.deepEqual(
    model.visibleEvents.map((item) => item.id),
    ['first', 'same-seq-early', 'same-seq-late', 'same-time-a', 'same-time-b'],
  );
});
