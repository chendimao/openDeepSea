import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyStreamingChunk,
  createStreamingDisplayState,
  enqueueStreamingChunk,
  flushStreamingDisplay,
  tickStreamingDisplay,
} from './streamingDisplay.js';

test('普通中文文本进入逐字队列', () => {
  const state = enqueueStreamingChunk(createStreamingDisplayState(), '你好世界');
  assert.equal(state.displayed, '');
  assert.deepEqual(state.queue, ['你', '好', '世', '界']);
});

test('代码块内 chunk 块级追加', () => {
  const state = enqueueStreamingChunk(
    createStreamingDisplayState('```ts\n'),
    'const a = 1;\n',
  );
  assert.equal(state.displayed, '```ts\nconst a = 1;\n');
  assert.deepEqual(state.queue, []);
});

test('多行日志块级追加', () => {
  const chunk = 'stdout line 1\nstdout line 2\nstdout line 3\nstdout line 4\n';
  assert.equal(classifyStreamingChunk('', chunk), 'block');
});

test('tick 会释放队列并保留剩余内容', () => {
  const state = enqueueStreamingChunk(createStreamingDisplayState(), 'abcdef');
  const next = tickStreamingDisplay(state);
  assert.ok(next.displayed.length > 0);
  assert.ok(next.queue.length < 6);
});

test('done 后 flush 到真实完整内容', () => {
  const state = enqueueStreamingChunk(createStreamingDisplayState(), '你好');
  const flushed = flushStreamingDisplay(state, '你好，完整内容');
  assert.equal(flushed.displayed, '你好，完整内容');
  assert.deepEqual(flushed.queue, []);
});
