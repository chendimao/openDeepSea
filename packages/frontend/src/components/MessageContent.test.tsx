import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../lib/i18n';
import { MessageContent } from './MessageContent';

setupBrowserStubs();

test('renders json code fences as structured Chinese task readiness view', () => {
  const content = [
    '```json',
    JSON.stringify({
      task_readiness: {
        ready: true,
        confidence: 0.92,
        title: '按访问历史恢复侧栏最近群聊',
        description: '在侧边栏最近项目下方展示当前用户最近访问过的群聊。',
        missing_questions: [],
        recommended_mode: 'formal_workflow',
        execution_intent: 'implementation',
      },
    }, null, 2),
    '```',
  ].join('\n');

  const html = renderToStaticMarkup(
    <I18nProvider>
      <MessageContent content={content} />
    </I18nProvider>,
  );

  assert.match(html, /任务准备状态/);
  assert.match(html, /按访问历史恢复侧栏最近群聊/);
  assert.match(html, /置信度/);
  assert.match(html, /92%/);
  assert.match(html, /推荐模式/);
  assert.match(html, /正式工作流/);
  assert.doesNotMatch(html, /<small>task_readiness<\/small>/);
  assert.doesNotMatch(html, /<small>ready<\/small>/);
  assert.doesNotMatch(html, /<small>confidence<\/small>/);
});

test('keeps generic json string values faithful while translating semantic summary fields', () => {
  const content = [
    '```json',
    JSON.stringify({
      status: 'implementation',
      emptyValue: '',
      recommended_mode: 'formal_workflow',
    }, null, 2),
    '```',
  ].join('\n');

  const html = renderMessage(content);

  assert.match(html, /status/);
  assert.match(html, /implementation/);
  assert.match(html, /emptyValue/);
  assert.match(html, /recommended_mode/);
  assert.match(html, /formal_workflow/);
  assert.doesNotMatch(html, /正式工作流/);
});

test('only compact-renders short scalar json rows', () => {
  const html = renderMessage([
    '```json',
    JSON.stringify({
      ready: true,
      confidence: 0.92,
      shortLabel: 'ok',
      mediumChinese: '这是一个中等长度的中文字段值需要按长文本展示',
      longAscii: 'this value is long enough to stay in a block row instead of compact inline layout',
      nested: { child: true },
    }, null, 2),
    '```',
  ].join('\n'));

  assert.match(html, /json-tree-row is-compact[\s\S]*是否就绪/);
  assert.match(html, /json-tree-row is-compact[\s\S]*置信度/);
  assert.match(html, /json-tree-row is-compact[\s\S]*shortLabel/);
  assert.match(html, /json-tree-row is-long[\s\S]*mediumChinese/);
  assert.match(html, /json-tree-row is-long[\s\S]*longAscii/);
  assert.match(html, /json-tree-row is-nested[\s\S]*nested/);
});

test('renders planner decision json as a Chinese summary card', () => {
  const html = renderMessage([
    '```json',
    JSON.stringify({
      planner_decision: {
        mode: 'pause_after_suggestion',
        status: 'suggested',
        summary: '建议下一步对比 ACP 与 Codex CLI 的启动上下文和 skill 加载配置',
        next_steps: [
          { agent_id: 'runtime-inspector', goal: '检查 Codex CLI 是否加载 AGENTS.md、Superpowers skill 路径和 using-superpowers 启动规则' },
        ],
        awaiting_user_confirmation: true,
      },
    }, null, 2),
    '```',
  ].join('\n'));

  assert.match(html, /规划决策/);
  assert.match(html, /建议后暂停/);
  assert.match(html, /已建议/);
  assert.match(html, /等待确认/);
  assert.match(html, /下一步数量/);
  assert.match(html, /runtime-inspector/);
  assert.match(html, /检查 Codex CLI 是否加载/);
  assert.doesNotMatch(html, /<small>planner_decision<\/small>/);
});

test('recognizes application json fences with CRLF and metadata', () => {
  const content = '```application/json title="readiness"\r\n{"task_readiness":{"ready":true,"title":"CRLF JSON","confidence":1}}\r\n```';

  const html = renderMessage(content);

  assert.match(html, /任务准备状态/);
  assert.match(html, /CRLF JSON/);
});

test('falls back to code block for non-json and invalid json fences', () => {
  const nonJsonHtml = renderMessage('```ts\nconst mode = "implementation";\n```');
  const invalidJsonHtml = renderMessage('```json\n{"task_readiness":\n```');

  assert.match(nonJsonHtml, /code-block/);
  assert.match(nonJsonHtml, /const mode/);
  assert.doesNotMatch(nonJsonHtml, /任务准备状态/);
  assert.match(invalidJsonHtml, /code-block/);
  assert.match(invalidJsonHtml, /task_readiness/);
  assert.doesNotMatch(invalidJsonHtml, /任务准备状态/);
});

test('renders markdown source when controlled by message display mode', () => {
  const content = [
    '```json',
    JSON.stringify({ ready: true }, null, 2),
    '```',
  ].join('\n');

  const html = renderToStaticMarkup(
    <I18nProvider>
      <MessageContent content={content} mode="source" />
    </I18nProvider>,
  );

  assert.match(html, /code-block/);
  assert.match(html, /&quot;ready&quot;: true/);
  assert.doesNotMatch(html, /是否就绪/);
});

test('places streaming cursor inside the final markdown text block', () => {
  const html = renderToStaticMarkup(
    <I18nProvider>
      <MessageContent content={'优化 [ACP](https://example.com) 消息展示，并保持光标在流式文字后面'} streaming />
    </I18nProvider>,
  );

  assert.match(html, /<p><span>优化 <a href="https:\/\/example\.com" target="_blank" rel="noreferrer noopener">ACP<\/a> 消息展示，并保持光标在流式文字后面<span class="streaming-cursor"/);
  assert.doesNotMatch(html, /<\/p><span class="streaming-cursor"/);
});

test('places streaming cursor inside the final markdown list item', () => {
  const html = renderToStaticMarkup(
    <I18nProvider>
      <MessageContent content={'- 读取消息\n- 渲染 `ACP` 事件'} streaming />
    </I18nProvider>,
  );

  assert.match(html, /<li>渲染 <code>ACP<\/code> 事件<span class="streaming-cursor"/);
  assert.doesNotMatch(html, /<\/ul><span class="streaming-cursor"/);
});

test('keeps streaming inline-code text in plain layout to avoid markdown size flicker', () => {
  const html = renderToStaticMarkup(
    <I18nProvider>
      <MessageContent content={'正在修改 `AgentTimeline.tsx` 和 `index.css`'} streaming />
    </I18nProvider>,
  );

  assert.match(html, /whitespace-pre-wrap break-words/);
  assert.match(html, /正在修改 `AgentTimeline\.tsx` 和 `index\.css`/);
  assert.doesNotMatch(html, /markdown-preview/);
  assert.doesNotMatch(html, /<code>AgentTimeline\.tsx<\/code>/);
});

test('renders ACP transcript by interleaving assistant text and tool events', () => {
  const html = renderToStaticMarkup(
    <I18nProvider>
      <MessageContent
        content="最终正文不应在 transcript 模式重复展示"
        trace={{
          events: [
            {
              id: 'text-1',
              message_id: 'message-1',
              run_id: 'run-1',
              agent_id: 'planner',
              seq: 1,
              type: 'assistant_message',
              status: 'delta',
              title: '助手回复',
              payload: { text: '我会先读取本会话要求的工作流技能。' },
              created_at: 1000,
            },
            {
              id: 'read-1',
              message_id: 'message-1',
              run_id: 'run-1',
              agent_id: 'planner',
              seq: 2,
              type: 'tool_result',
              status: 'failed',
              title: '工具结果 Read',
              payload: { id: 'read-1', name: 'Read', input: '{"path":"/Users/chendimao/.codex/skills/using-superpowers/SKILL.md"}' },
              created_at: 1001,
            },
            {
              id: 'text-2',
              message_id: 'message-1',
              run_id: 'run-1',
              agent_id: 'planner',
              seq: 3,
              type: 'assistant_message',
              status: 'delta',
              title: '助手回复',
              payload: { text: '我切换到当前会话列出的可用技能路径读取。' },
              created_at: 1002,
            },
            {
              id: 'read-2',
              message_id: 'message-1',
              run_id: 'run-1',
              agent_id: 'planner',
              seq: 4,
              type: 'tool_result',
              status: 'completed',
              title: '工具结果 Read',
              payload: { id: 'read-2', name: 'Read', input: '{"path":"/Users/chendimao/.agents/skills/using-superpowers/SKILL.md"}' },
              created_at: 1003,
            },
          ],
        }}
      />
    </I18nProvider>,
  );

  assert.match(html, /agent-transcript/);
  assert.match(html, /我会先读取本会话要求的工作流技能/);
  assert.match(html, /Read · \/Users\/chendimao\/\.codex\/skills\/using-superpowers\/SKILL\.md/);
  assert.match(html, /失败/);
  assert.match(html, /我切换到当前会话列出的可用技能路径读取/);
  assert.match(html, /Read · \/Users\/chendimao\/\.agents\/skills\/using-superpowers\/SKILL\.md/);
  assert.match(html, /完成/);
  assert.doesNotMatch(html, /完整 ACP 轨迹/);
  assert.doesNotMatch(html, /最终正文不应在 transcript 模式重复展示/);
});

test('falls back to final content plus timeline when assistant_message events are absent', () => {
  const html = renderToStaticMarkup(
    <I18nProvider>
      <MessageContent
        content="这是 agent 正文"
        trace={{
          thinking: [{ text: '完整 thinking 原文' }],
          tool_calls: [
            {
              name: 'search_files',
              input: '{"pattern":"model settings"}',
              output: 'found SettingsDialogs.tsx',
            },
          ],
          commands: [
            {
              command: 'rg -n "model" packages/frontend/src',
              output: 'packages/frontend/src/lib/types.ts:1:model',
            },
          ],
        }}
      />
    </I18nProvider>,
  );

  assert.match(html, /这是 agent 正文/);
  assert.doesNotMatch(html, /agent-transcript/);
  assert.match(html, /ACP 执行过程/);
  assert.match(html, /Thinking/);
  assert.match(html, /Explored/);
  assert.match(html, /Ran/);
  assert.match(html, /完整 thinking 原文/);
  assert.match(html, /search_files/);
  assert.match(html, /输入/);
  assert.match(html, /输出/);
  assert.match(html, /rg -n &quot;model&quot; packages\/frontend\/src/);
});

test('falls back to final content when assistant_message trace has no readable text', () => {
  const html = renderToStaticMarkup(
    <I18nProvider>
      <MessageContent
        content="完整最终正文仍需展示"
        trace={{
          events: [
            {
              id: 'text-empty',
              message_id: 'message-1',
              run_id: 'run-1',
              agent_id: 'planner',
              seq: 1,
              type: 'assistant_message',
              status: 'delta',
              title: '助手回复',
              payload: { text: '' },
              created_at: 1000,
            },
            {
              id: 'tool-1',
              message_id: 'message-1',
              run_id: 'run-1',
              agent_id: 'planner',
              seq: 2,
              type: 'tool_result',
              status: 'completed',
              title: '工具结果 Read',
              payload: { id: 'read-1', name: 'Read', input: '{"path":"package.json"}' },
              created_at: 1001,
            },
          ],
        }}
      />
    </I18nProvider>,
  );

  assert.match(html, /完整最终正文仍需展示/);
  assert.doesNotMatch(html, /agent-transcript/);
  assert.match(html, /ACP 执行过程/);
  assert.match(html, /Read · package\.json/);
});

function renderMessage(content: string): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <MessageContent content={content} />
    </I18nProvider>,
  );
}

function setupBrowserStubs(): void {
  Object.assign(globalThis, { React });

  if (!('localStorage' in globalThis)) {
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: () => null,
        setItem: () => undefined,
      },
      configurable: true,
    });
  }

  if (!('document' in globalThis)) {
    Object.defineProperty(globalThis, 'document', {
      value: { documentElement: { lang: 'zh' } },
      configurable: true,
    });
  }
}
