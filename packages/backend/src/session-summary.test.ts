import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHistorySummary, truncateLine } from './session-summary.js';

test('buildHistorySummary builds deterministic title, summary and resume brief', () => {
  const result = buildHistorySummary({
    goal: '实现会话系统',
    messages: [
      { role: 'system', content: '系统消息' },
      { role: 'user', content: '请把群聊改成 Session OS' },
    ],
    changedFiles: ['packages/backend/src/db.ts', 'packages/backend/src/session-types.ts'],
    verificationSummary: 'npm run build passed',
  });

  assert.equal(result.title, '实现会话系统');
  assert.match(result.summary, /请把群聊改成 Session OS/);
  assert.match(result.summary, /变更文件：packages\/backend\/src\/db\.ts/);
  assert.match(result.resumeBrief, /目标：实现会话系统/);
  assert.match(result.resumeBrief, /未完成：请先运行 \/status 对齐当前状态。/);
});

test('buildHistorySummary falls back to first user message and truncates long lines', () => {
  const result = buildHistorySummary({
    goal: null,
    messages: [{ role: 'user', content: 'a'.repeat(120) }],
    changedFiles: [],
    verificationSummary: null,
  });

  assert.equal(result.title.length <= 60, true);
  assert.match(result.title, /…$/);
  assert.match(result.summary, /变更文件：无/);
  assert.match(result.summary, /最近验证：未知/);
});

test('truncateLine compacts whitespace before truncating', () => {
  assert.equal(truncateLine('  hello\n   world  ', 20), 'hello world');
  assert.equal(truncateLine('abcdef', 4), 'abc…');
});
