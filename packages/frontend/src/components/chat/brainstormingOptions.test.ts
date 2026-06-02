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

test('parses recommendation, lightweight alternative, and non-recommended option from markdown', () => {
  const content = [
    '**头脑风暴方案**',
    '',
    '推荐方案：把 `@` 文件引用升级成“资源 + 工作区入口”的统一引用器。',
    '',
    '- 空查询时展示 workspace 根目录，比如 `docs/`、`packages/`、`README.md`',
    '- 搜索失败不要静默，至少显示“无法访问本地工作区”',
    '',
    '备选轻量方案：只修复 `@` 空查询不显示目录的问题。',
    '这能解决用户第一感知，但目录发送后仍不可用，容易产生第二个问题。',
    '',
    '不推荐方案：禁止目录出现在 `@` 搜索结果。',
    '这能避免下游不可用，但和用户“搜索文件夹”的目标相反。',
  ].join('\n');

  const options = getBrainstormingOptionsForMessage(createAgentMessage(content), { attachments: [] });

  assert.equal(options.length, 3);
  assert.equal(options[0]?.title, '推荐方案');
  assert.equal(options[0]?.maturity, 'boundary_needed');
  assert.equal(options[0]?.recommended, true);
  assert.equal(options[1]?.title, '备选轻量方案');
  assert.equal(options[1]?.maturity, 'actionable');
  assert.equal(options[2]?.title, '不推荐方案');
  assert.equal(options[2]?.maturity, 'exploratory');
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

test('stops parsing options at the next markdown section heading', () => {
  const content = [
    '**头脑风暴方案**',
    '',
    '推荐方案：统一资源入口。',
    '',
    '不推荐方案：禁止目录出现在搜索结果。',
    '',
    '**建议下一步**',
    '',
    '- 创建正式任务',
    '- 运行构建',
  ].join('\n');

  const options = getBrainstormingOptionsForMessage(createAgentMessage(content), { attachments: [] });

  assert.equal(options.length, 2);
  assert.equal(options[1]?.summary, '禁止目录出现在搜索结果。');
  assert.deepEqual(options[1]?.benefits, []);
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
