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

test('extracts choice options from a fenced json block in agent message content', () => {
  const content = [
    '可以按下面方案继续。',
    '',
    '```json',
    JSON.stringify({
      choice_options: [
        {
          id: 'parallel_execution',
          title: '并行执行',
          summary: '拆成互不冲突的子任务并行处理。',
          benefits: ['更快拿到结果'],
          risks: ['需要统一收尾'],
          maturity: 'actionable',
          recommended: true,
        },
      ],
    }, null, 2),
    '```',
  ].join('\n');

  const options = getBrainstormingOptionsForMessage(createAgentMessage(content), { attachments: [] });

  assert.equal(options.length, 1);
  assert.equal(options[0]?.id, 'parallel_execution');
  assert.equal(options[0]?.title, '并行执行');
  assert.equal(options[0]?.recommended, true);
});

test('extracts choice options when the opening brace is glued to the json fence language', () => {
  const json = JSON.stringify({
    choice_options: [
      {
        id: 'continue_frontend_fix',
        title: '继续前端修复',
        summary: '补齐群聊消息里的结构化方案卡展示。',
        benefits: ['覆盖流式输出格式'],
        risks: ['仍依赖合法 JSON'],
        maturity: 'actionable',
      },
    ],
  }, null, 2);
  const content = `\`\`\`json${json.slice(0, 1)}\n${json.slice(2)}\n\`\`\``;

  const options = getBrainstormingOptionsForMessage(createAgentMessage(content), { attachments: [] });

  assert.equal(options.length, 1);
  assert.equal(options[0]?.id, 'continue_frontend_fix');
});

test('extracts choice options from superpowers fenced json evidence', () => {
  const content = [
    '已完成。',
    '',
    '```json',
    JSON.stringify({
      superpowers: {
        choice_options: [
          {
            id: 'review_then_finish',
            title: '审查后收尾',
            summary: '先完成代码审查，再进入完成分支阶段。',
            benefits: ['符合门禁'],
            risks: [],
            maturity: 'actionable',
          },
        ],
      },
    }, null, 2),
    '```',
  ].join('\n');

  const options = getBrainstormingOptionsForMessage(createAgentMessage(content), { attachments: [] });

  assert.equal(options.length, 1);
  assert.equal(options[0]?.id, 'review_then_finish');
});

test('does not extract choice options from non-final json examples in agent markdown', () => {
  const content = [
    '请在自然语言后追加类似下面的结构：',
    '',
    '```json',
    JSON.stringify({
      choice_options: [
        {
          id: 'example_only',
          title: '示例方案',
          summary: '这只是格式示例，不应出现可点击方案。',
          benefits: [],
          risks: [],
          maturity: 'actionable',
        },
      ],
    }, null, 2),
    '```',
    '',
    '上面的 JSON 只是文档示例。',
  ].join('\n');

  const options = getBrainstormingOptionsForMessage(createAgentMessage(content), { attachments: [] });

  assert.equal(options.length, 0);
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
