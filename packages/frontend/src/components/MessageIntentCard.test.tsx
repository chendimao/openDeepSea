import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageIntentCard } from './MessageIntentCard';

test('high confidence intent shows auto-recognized summary without confirmation actions', () => {
  const html = renderToStaticMarkup(
    <MessageIntentCard
      intentResult={{
        intent: 'workflow',
        confidence: 0.92,
        reason: '用户明确要求进入正式工作流',
        suggestedAction: 'start_workflow',
        source: 'classifier',
        signals: ['workflow', 'formal'],
      }}
      onChooseIntent={() => undefined}
    />,
  );

  assert.match(html, /已自动识别/);
  assert.match(html, /workflow/);
  assert.match(html, /92%/);
  assert.doesNotMatch(html, /需要确认/);
  assert.doesNotMatch(html, /按 Brainstorming 继续/);
});

test('low confidence intent shows confirmation actions and only first 3 signals', () => {
  const html = renderToStaticMarkup(
    <MessageIntentCard
      intentResult={{
        intent: 'chat',
        confidence: 0.58,
        reason: '上下文不足以稳定判断消息类型',
        suggestedAction: 'ask_user',
        source: 'classifier',
        signals: ['signal-a', 'signal-b', 'signal-c', 'signal-d'],
      }}
      onChooseIntent={() => undefined}
    />,
  );

  assert.match(html, /需要确认/);
  assert.equal((html.match(/type="button"/g) ?? []).length, 5);
  assert.match(html, /按 Brainstorming 继续/);
  assert.match(html, /改为普通聊天/);
  assert.match(html, /改为轻量任务/);
  assert.match(html, /进入 Debugger/);
  assert.match(html, /进入 Workflow/);
  assert.match(html, /signal-a/);
  assert.match(html, /signal-b/);
  assert.match(html, /signal-c/);
  assert.doesNotMatch(html, /signal-d/);
});
