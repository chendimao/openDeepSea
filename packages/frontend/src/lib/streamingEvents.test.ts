import assert from 'node:assert/strict';
import test from 'node:test';
import { createStreamingEventTracker, shouldApplyStreamingEvent } from './streamingEvents';

test('重复的流式 chunk 只消费一次', () => {
  const tracker = createStreamingEventTracker();
  const event = {
    roomId: 'room-1',
    messageId: 'message-1',
    runId: 'run-1',
    chunk: '第一段',
    done: false,
    seq: 1,
    status: 'streaming' as const,
  };

  assert.equal(shouldApplyStreamingEvent(tracker, event), true);
  assert.equal(shouldApplyStreamingEvent(tracker, event), false);
});

test('同一 run 的相同文本在不同位置仍可继续消费', () => {
  const tracker = createStreamingEventTracker();

  assert.equal(shouldApplyStreamingEvent(tracker, {
    roomId: 'room-1',
    messageId: 'message-1',
    runId: 'run-1',
    chunk: '段落',
    done: false,
    seq: 1,
    status: 'streaming',
  }), true);
  assert.equal(shouldApplyStreamingEvent(tracker, {
    roomId: 'room-1',
    messageId: 'message-1',
    runId: 'run-1',
    chunk: '其他',
    done: false,
    seq: 2,
    status: 'streaming',
  }), true);
  assert.equal(shouldApplyStreamingEvent(tracker, {
    roomId: 'room-1',
    messageId: 'message-1',
    runId: 'run-1',
    chunk: '段落',
    done: false,
    seq: 3,
    status: 'streaming',
  }), true);
});

test('缺少 seq 的旧事件保持兼容并继续消费', () => {
  const tracker = createStreamingEventTracker();
  const event = {
    roomId: 'room-1',
    messageId: 'message-1',
    runId: 'run-1',
    chunk: '旧事件',
    done: false,
    status: 'streaming' as const,
  };

  assert.equal(shouldApplyStreamingEvent(tracker, event), true);
  assert.equal(shouldApplyStreamingEvent(tracker, event), true);
});

test('同一 run 的不同流式通道独立去重', () => {
  const tracker = createStreamingEventTracker();

  assert.equal(shouldApplyStreamingEvent(tracker, {
    roomId: 'room-1',
    messageId: 'message-1',
    runId: 'run-1',
    channel: 'event',
    chunk: '工具事件',
    done: false,
    seq: 50,
    status: 'streaming',
  }), true);
  assert.equal(shouldApplyStreamingEvent(tracker, {
    roomId: 'room-1',
    messageId: 'message-1',
    runId: 'run-1',
    channel: 'answer',
    chunk: '答案片段',
    done: false,
    seq: 10,
    status: 'streaming',
  }), true);
});
