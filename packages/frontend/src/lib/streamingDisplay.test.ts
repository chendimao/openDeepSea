import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyStreamingChunk,
  createStreamingDisplayState,
  enqueueStreamingChunk,
  flushStreamingDisplay,
  resolveStreamingDisplayContent,
  shouldRetainStreamingDisplayState,
  tickStreamingDisplay,
} from './streamingDisplay.js';

test('普通中文文本立即追加到显示内容', () => {
  const state = enqueueStreamingChunk(createStreamingDisplayState(), '你好世界');
  assert.equal(state.displayed, '你好世界');
  assert.deepEqual(state.queue, []);
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

test('多行普通回复仍归类为自然语言', () => {
  const chunk = [
    '分析边界建议先收敛到一个重点，否则会太散。',
    '架构概览：项目结构、模块职责、启动方式',
    '前后端链路：页面、API、WebSocket、数据流',
    '推荐先建立整体地图，再深入上传与消息机制。',
  ].join('\n');
  assert.equal(classifyStreamingChunk('', chunk), 'typewriter');
});

test('较长的普通自然语言回复立即追加到显示内容', () => {
  const chunk = [
    '分析边界建议先收敛到一个重点，否则分析当前项目会太散。',
    '可以先建立整体地图，再深入当前记忆里提到的上传与消息机制。',
    '这个回复包含多句中文说明，但不是代码块、命令输出、diff 或 stdout 日志。',
    '因此它应该按后端收到的内容立即显示，而不是因为前端队列再次限速。',
    '这样用户能看到更接近真实后端流速的输出节奏。',
    '如果用户看到的是整段突然出现，就说明前端分类规则把普通说明文字误当成了日志或大块输出。',
    '这里需要保留自然语言分类，只让真正的代码、日志和命令输出走结构化判断。',
  ].join('\n').repeat(2);
  assert.ok(chunk.length > 240);
  assert.equal(classifyStreamingChunk('', chunk), 'typewriter');
  const state = enqueueStreamingChunk(createStreamingDisplayState(), chunk);
  assert.equal(state.displayed, chunk);
  assert.deepEqual(state.queue, []);
});

test('tick 会清空历史队列并释放全部内容', () => {
  const state = {
    displayed: '',
    queue: ['abcd', 'efgh', 'ijkl'],
  };
  const next = tickStreamingDisplay(state);
  assert.equal(next.displayed, 'abcdefghijkl');
  assert.deepEqual(next.queue, []);
});

test('done 后 flush 到真实完整内容', () => {
  const state = enqueueStreamingChunk(createStreamingDisplayState(), '你好');
  const flushed = flushStreamingDisplay(state, '你好，完整内容');
  assert.equal(flushed.displayed, '你好，完整内容');
  assert.deepEqual(flushed.queue, []);
});

test('显示内容使用已追加的本地显示状态', () => {
  const state = enqueueStreamingChunk(createStreamingDisplayState('截图确认'), '重叠点');

  assert.equal(resolveStreamingDisplayContent(state, '截图确认重叠点'), '截图确认重叠点');
});

test('已提交内容补齐本地前缀时优先显示完整内容', () => {
  const state = createStreamingDisplayState('最终回复还差');

  assert.equal(resolveStreamingDisplayContent(state, '最终回复还差几个字符'), '最终回复还差几个字符');
});

test('显示内容在本地状态和已提交内容分叉时选择更长内容防止回退', () => {
  const state = createStreamingDisplayState('截图确认重叠点');

  assert.equal(resolveStreamingDisplayContent(state, '截图确认其他内容'), '截图确认其他内容');
});

test('队列清空但未完成时保留已展示内容等待下一块 chunk', () => {
  const drained = tickUntilDrained(enqueueStreamingChunk(createStreamingDisplayState(), '第一块'));
  assert.equal(drained.displayed, '第一块');
  assert.deepEqual(drained.queue, []);
  assert.equal(shouldRetainStreamingDisplayState(drained, false), true);
  assert.equal(shouldRetainStreamingDisplayState(drained, true), false);
});

function tickUntilDrained(state: ReturnType<typeof createStreamingDisplayState>) {
  let current = state;
  while (current.queue.length > 0) {
    current = tickStreamingDisplay(current);
  }
  return current;
}
