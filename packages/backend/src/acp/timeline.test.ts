import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTimelineEvent,
  normalizeTimelineEventFromTrace,
  normalizeRawTimelineEvent,
} from './timeline.js';

test('normalizeTimelineEventFromTrace maps thinking trace to timeline event', () => {
  const event = normalizeTimelineEventFromTrace({
    messageId: 'msg-1',
    runId: 'run-1',
    agentId: 'planner',
    seq: 1,
    channel: 'thinking',
    text: '先读取 dispatcher.ts',
    trace: { kind: 'thinking', text: '先读取 dispatcher.ts' },
  });

  assert.equal(event.type, 'thinking');
  assert.equal(event.status, 'delta');
  assert.equal(event.title, '思考过程');
  assert.equal(event.payload.text, '先读取 dispatcher.ts');
  assert.equal(event.message_id, 'msg-1');
  assert.equal(event.run_id, 'run-1');
  assert.equal(event.agent_id, 'planner');
});

test('normalizeTimelineEventFromTrace maps tool trace to tool_call event', () => {
  const event = normalizeTimelineEventFromTrace({
    messageId: 'msg-1',
    runId: 'run-1',
    agentId: 'executor',
    seq: 2,
    channel: 'tool',
    text: 'Read {"file":"src/app.ts"}',
    trace: { kind: 'tool', name: 'Read', input: '{"file":"src/app.ts"}' },
  });

  assert.equal(event.type, 'tool_call');
  assert.equal(event.status, 'completed');
  assert.equal(event.title, '调用工具 Read');
  assert.equal(event.payload.name, 'Read');
  assert.equal(event.payload.input, '{"file":"src/app.ts"}');
});

test('normalizeRawTimelineEvent keeps unknown provider events as raw', () => {
  const event = normalizeRawTimelineEvent({
    messageId: 'msg-1',
    runId: 'run-1',
    agentId: 'executor',
    seq: 3,
    provider: 'codex',
    rawType: 'unknown.event',
    raw: { type: 'unknown.event', value: 1 },
  });

  assert.equal(event.type, 'raw');
  assert.equal(event.status, 'completed');
  assert.equal(event.title, '原始事件 unknown.event');
  assert.deepEqual(event.raw, { type: 'unknown.event', value: 1 });
});

test('createTimelineEvent creates stable payload and raw fields', () => {
  const event = createTimelineEvent({
    messageId: 'msg-1',
    runId: 'run-1',
    agentId: 'executor',
    seq: 4,
    type: 'file_diff',
    status: 'completed',
    title: '修改文件 src/app.ts',
    payload: {
      path: 'src/app.ts',
      patch: '-old\n+new',
      additions: 1,
      deletions: 1,
    },
    raw: { type: 'patch' },
  });

  assert.equal(event.id, 'run-1:4');
  assert.equal(event.type, 'file_diff');
  assert.equal(event.payload.path, 'src/app.ts');
  assert.equal(event.raw?.type, 'patch');
});
