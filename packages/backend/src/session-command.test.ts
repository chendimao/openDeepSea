import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSessionCommand } from './session-command.js';

test('parseSessionCommand treats normal text as message', () => {
  assert.deepEqual(parseSessionCommand('继续实现'), {
    kind: 'message',
    raw: '继续实现',
    body: '继续实现',
    args: {},
  });
});

test('parseSessionCommand parses compact focus argument', () => {
  const parsed = parseSessionCommand('/compact focus: 保留 UI 决策和未完成 bug');
  assert.equal(parsed.kind, 'compact');
  assert.equal(parsed.args.focus, '保留 UI 决策和未完成 bug');
});

test('parseSessionCommand parses flags and key:value syntax', () => {
  assert.deepEqual(parseSessionCommand('/new blank').args, { blank: true });
  assert.deepEqual(parseSessionCommand('/new title: 重构会话模型').args, { title: '重构会话模型' });
  assert.deepEqual(parseSessionCommand('/fork checkpoint:abc123').args, { checkpoint: 'abc123' });
});

test('parseSessionCommand preserves unknown slash command as message', () => {
  assert.deepEqual(parseSessionCommand('/unknown keep raw'), {
    kind: 'message',
    raw: '/unknown keep raw',
    body: '/unknown keep raw',
    args: {},
  });
});
