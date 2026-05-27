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
      <MessageContent content={'优化 `ACP` 消息展示，并保持光标在流式文字后面'} streaming />
    </I18nProvider>,
  );

  assert.match(html, /<p><span>优化 <code>ACP<\/code> 消息展示，并保持光标在流式文字后面<span class="streaming-cursor"/);
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

test('renders thinking and tool trace panels collapsed by default', () => {
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

  assert.match(html, /ACP 执行过程/);
  assert.match(html, /思考/);
  assert.match(html, /工具/);
  assert.match(html, /命令/);
  assert.match(html, /完整 thinking 原文/);
  assert.match(html, /search_files/);
  assert.match(html, /输入/);
  assert.match(html, /输出/);
  assert.match(html, /rg -n &quot;model&quot; packages\/frontend\/src/);
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
