import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAgentMessagePhases } from './phases';
import type { AgentTimelineEvent } from '../../lib/types';

test('buildAgentMessagePhases groups content and events into investigation changes verification summary', () => {
  const phases = buildAgentMessagePhases([
    '## 调查',
    '我检查了消息流。',
    '## 修改',
    '我调整了展示队列。',
    '## 验证',
    '测试和 build 已通过。',
    '## 总结',
    '问题来自前端渲染。',
  ].join('\n'), {
    events: [
      event('read-1', 'tool_result', '工具结果 Read', { name: 'Read', input: '{"path":"RoomPage.tsx"}' }),
      event('diff-1', 'file_diff', '修改文件 streamingDisplay.ts', { path: 'streamingDisplay.ts' }),
      event('run-1', 'command', '执行命令 npm run build', { command: 'npm run build' }),
    ],
  });

  assert.deepEqual(phases.map((phase) => phase.kind), ['investigation', 'changes', 'verification', 'summary']);
  assert.equal(phases[0]?.body, '我检查了消息流。');
  assert.equal(phases[0]?.events[0]?.id, 'read-1');
  assert.equal(phases[1]?.events[0]?.id, 'diff-1');
  assert.equal(phases[2]?.events[0]?.id, 'run-1');
  assert.equal(phases[3]?.body, '问题来自前端渲染。');
});

test('buildAgentMessagePhases keeps unstructured content in summary while grouping events', () => {
  const phases = buildAgentMessagePhases('我读取文件后完成了修改，并运行了测试。', {
    events: [
      event('read-1', 'tool_call', '调用工具 Read', { name: 'Read', input: '{"path":"package.json"}' }),
      event('edit-1', 'tool_result', '工具结果 apply_patch', { name: 'apply_patch' }),
      event('test-1', 'command', '执行命令 npm test', { command: 'npm test' }),
    ],
  });

  assert.deepEqual(phases.map((phase) => phase.kind), ['investigation', 'changes', 'verification', 'summary']);
  assert.equal(phases.find((phase) => phase.kind === 'summary')?.body, '我读取文件后完成了修改，并运行了测试。');
  assert.equal(phases.find((phase) => phase.kind === 'investigation')?.events[0]?.id, 'read-1');
  assert.equal(phases.find((phase) => phase.kind === 'changes')?.events[0]?.id, 'edit-1');
  assert.equal(phases.find((phase) => phase.kind === 'verification')?.events[0]?.id, 'test-1');
});

function event(
  id: string,
  type: AgentTimelineEvent['type'],
  title: string,
  payload: Record<string, unknown>,
): AgentTimelineEvent {
  return {
    id,
    message_id: 'message-1',
    run_id: 'run-1',
    agent_id: 'planner',
    seq: 1,
    type,
    status: 'completed',
    title,
    payload,
    created_at: 1000,
  };
}
