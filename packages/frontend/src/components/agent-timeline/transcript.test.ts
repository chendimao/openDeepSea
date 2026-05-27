import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAgentTranscript } from './transcript';
import type { AgentTimelineEvent } from '../../lib/types';

test('buildAgentTranscript interleaves assistant text and tool events by sequence', () => {
  const model = buildAgentTranscript({
    events: [
      event('text-1', 1, 'assistant_message', '助手回复', { text: '我会先读取技能。' }),
      event('tool-1', 2, 'tool_result', '工具结果 Read', {
        id: 'read-1',
        name: 'Read',
        input: '{"path":"/missing/SKILL.md"}',
      }, 'failed'),
      event('text-2', 3, 'assistant_message', '助手回复', { text: '我切换到可用路径读取。' }),
      event('tool-2', 4, 'tool_result', '工具结果 Read', {
        id: 'read-2',
        name: 'Read',
        input: '{"path":"/available/SKILL.md"}',
      }),
    ],
  });

  assert.ok(model);
  assert.deepEqual(model.items.map((item) => item.type), ['text', 'event', 'text', 'event']);
  assert.equal(model.items[0]?.type === 'text' ? model.items[0].text : '', '我会先读取技能。');
  assert.equal(model.items[1]?.type === 'event' ? model.items[1].event.status : null, 'failed');
  assert.equal(model.items[2]?.type === 'text' ? model.items[2].text : '', '我切换到可用路径读取。');
});

test('buildAgentTranscript merges consecutive assistant chunks and tool lifecycle updates', () => {
  const model = buildAgentTranscript({
    events: [
      event('text-1', 1, 'assistant_message', '助手回复', { text: '先读' }),
      event('text-2', 2, 'assistant_message', '助手回复', { text: '文件。' }),
      event('tool-call-1', 3, 'tool_call', '调用工具 Read', {
        id: 'read-1',
        name: 'Read',
        input: '{"path":"package.json"}',
      }, 'started'),
      event('tool-result-1', 4, 'tool_result', '工具结果 Read', {
        id: 'read-1',
        name: 'Read',
        output: 'ok',
      }),
    ],
  });

  assert.ok(model);
  assert.deepEqual(model.items.map((item) => item.type), ['text', 'event']);
  assert.equal(model.items[0]?.type === 'text' ? model.items[0].text : '', '先读文件。');
  assert.equal(model.items[1]?.type === 'event' ? model.items[1].event.status : null, 'completed');
  assert.equal(model.items[1]?.type === 'event' ? model.items[1].event.payload.output : null, 'ok');
});

test('buildAgentTranscript returns null when no assistant_message events are available', () => {
  const model = buildAgentTranscript({
    events: [
      event('tool-1', 1, 'tool_result', '工具结果 Read', { id: 'read-1', name: 'Read' }),
    ],
  });

  assert.equal(model, null);
});

test('buildAgentTranscript returns null when assistant_message chunks have no readable text', () => {
  const model = buildAgentTranscript({
    events: [
      event('text-1', 1, 'assistant_message', '助手回复', { text: '' }),
      event('tool-1', 2, 'tool_result', '工具结果 Read', { id: 'read-1', name: 'Read' }),
    ],
  });

  assert.equal(model, null);
});

function event(
  id: string,
  seq: number,
  type: AgentTimelineEvent['type'],
  title: string,
  payload: Record<string, unknown>,
  status: AgentTimelineEvent['status'] = 'completed',
): AgentTimelineEvent {
  return {
    id,
    message_id: 'message-1',
    run_id: 'run-1',
    agent_id: 'planner',
    seq,
    type,
    status,
    title,
    payload,
    created_at: 1000 + seq,
  };
}
