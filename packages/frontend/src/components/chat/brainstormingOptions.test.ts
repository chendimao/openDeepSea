import assert from 'node:assert/strict';
import test from 'node:test';
import { getBrainstormingOptionsForMessage } from './brainstormingOptions';
import type { Message, MessageMetadata } from '../../lib/types';

test('uses structured brainstorming options when metadata is present', () => {
  const metadata: MessageMetadata = {
    attachments: [],
    brainstorming_options: [
      {
        id: 'structured',
        title: '推荐方案',
        summary: '结构化方案',
        benefits: ['稳定'],
        risks: [],
        maturity: 'actionable',
        recommended: true,
      },
    ],
  };

  const options = getBrainstormingOptionsForMessage(createAgentMessage('普通正文'), metadata);

  assert.equal(options.length, 1);
  assert.equal(options[0]?.id, 'structured');
});

test('uses generic choice options before legacy brainstorming options', () => {
  const metadata: MessageMetadata = {
    attachments: [],
    choice_options: [
      {
        id: 'generic',
        title: '方案 A',
        summary: '通用选择方案',
        benefits: [],
        risks: [],
        maturity: 'boundary_needed',
      },
    ],
    brainstorming_options: [
      {
        id: 'legacy',
        title: '推荐方案',
        summary: '旧字段方案',
        benefits: [],
        risks: [],
        maturity: 'actionable',
      },
    ],
  };

  const options = getBrainstormingOptionsForMessage(createAgentMessage('普通正文'), metadata);

  assert.equal(options.length, 1);
  assert.equal(options[0]?.id, 'generic');
});

test('does not infer options from markdown headings without structured metadata', () => {
  const content = [
    '推荐方案：把 `@` 文件引用升级成统一引用器。',
    '备选方案：只修复空查询。',
  ].join('\n');

  const options = getBrainstormingOptionsForMessage(createAgentMessage(content), { attachments: [] });

  assert.equal(options.length, 0);
});

test('does not parse ordinary markdown lists as brainstorming options', () => {
  const content = [
    '**可能原因**',
    '',
    '- 单独输入 @ 不会显示 docs',
    '- workspace search 失败会被吞掉',
  ].join('\n');

  const options = getBrainstormingOptionsForMessage(createAgentMessage(content), { attachments: [] });

  assert.equal(options.length, 0);
});

test('does not parse user messages as brainstorming options', () => {
  const options = getBrainstormingOptionsForMessage(
    { ...createAgentMessage('推荐方案：普通正文'), sender_type: 'user' },
    { attachments: [] },
  );

  assert.equal(options.length, 0);
});

function createAgentMessage(content: string): Message {
  return {
    id: 'message-1',
    room_id: 'room-1',
    sender_type: 'agent',
    sender_id: 'planner',
    sender_name: '规划师',
    content,
    message_type: 'agent_stream',
    metadata: null,
    created_at: 1000,
  };
}
