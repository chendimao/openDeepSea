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
  assert.match(html, /原文/);
  assert.doesNotMatch(html, /<small>task_readiness<\/small>/);
});

test('keeps generic json string values faithful while translating semantic summary fields', () => {
  const content = [
    '```json',
    JSON.stringify({
      status: 'implementation',
      emptyValue: '',
      task_readiness: {
        ready: true,
        confidence: 0.92,
        title: '保留原始枚举值',
        missing_questions: [],
        recommended_mode: 'formal_workflow',
        execution_intent: 'implementation',
      },
    }, null, 2),
    '```',
  ].join('\n');

  const html = renderMessage(content);

  assert.match(html, /status/);
  assert.match(html, /implementation/);
  assert.match(html, /emptyValue/);
  assert.match(html, /正式工作流/);
  assert.match(html, /执行意图/);
  assert.match(html, /实现/);
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
