import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../lib/i18n';
import { AgentTimeline } from './AgentTimeline';

setupBrowserStubs();

test('AgentTimeline renders structured events as authoritative when legacy trace fields coexist', () => {
  const html = renderToStaticMarkup(
    <I18nProvider>
      <AgentTimeline
        trace={{
          thinking: [{ text: 'legacy thinking' }],
          events: [
            {
              id: 'run-1:1',
              message_id: 'message-1',
              run_id: 'run-1',
              agent_id: 'planner',
              seq: 1,
              type: 'file_diff',
              status: 'completed',
              title: '修改文件 src/app.ts',
              payload: { path: 'src/app.ts', patch: '-old\n+new', additions: 1, deletions: 1 },
              created_at: 1000,
            },
          ],
        }}
      />
    </I18nProvider>,
  );

  assert.match(html, /修改文件 src\/app\.ts/);
  assert.doesNotMatch(html, /legacy thinking/);
  assert.match(html, /agent-timeline/);
});

test('AgentTimeline falls back to legacy trace fields when structured events are absent', () => {
  const html = renderToStaticMarkup(
    <I18nProvider>
      <AgentTimeline
        trace={{
          thinking: [{ text: 'legacy thinking' }],
          tool_calls: [{ name: 'Read', input: '{"path":"src/app.ts"}' }],
        }}
      />
    </I18nProvider>,
  );

  assert.match(html, /legacy thinking/);
  assert.match(html, /调用工具 Read/);
});

test('AgentTimeline marks diff lines with add and remove classes', () => {
  const html = renderToStaticMarkup(
    <I18nProvider>
      <AgentTimeline
        events={[
          {
            id: 'run-1:2',
            message_id: 'message-1',
            run_id: 'run-1',
            agent_id: 'planner',
            seq: 2,
            type: 'file_diff',
            status: 'completed',
            title: '修改文件 src/app.ts',
            payload: { path: 'src/app.ts', patch: '-old\n+new', additions: 1, deletions: 1 },
            created_at: 1000,
          },
        ]}
      />
    </I18nProvider>,
  );

  assert.match(html, /diff-line is-removed/);
  assert.match(html, /diff-line is-added/);
});

test('AgentTimeline renders assistant messages and translated structured fields', () => {
  const html = renderToStaticMarkup(
    <I18nProvider>
      <AgentTimeline
        events={[
          {
            id: 'run-1:3',
            message_id: 'message-1',
            run_id: 'run-1',
            agent_id: 'planner',
            seq: 3,
            type: 'assistant_message',
            status: 'delta',
            title: '助手回复',
            payload: { text: '协议回复片段' },
            created_at: 1000,
          },
          {
            id: 'run-1:4',
            message_id: 'message-1',
            run_id: 'run-1',
            agent_id: 'planner',
            seq: 4,
            type: 'raw',
            status: 'completed',
            title: '原始事件 protocol_fallback',
            payload: { raw_type: 'protocol_fallback' },
            raw: { type: 'protocol_fallback', backend: 'codex', reason: 'missing server' },
            created_at: 1001,
          },
        ]}
      />
    </I18nProvider>,
  );

  assert.match(html, /协议回复片段/);
  assert.match(html, /回复/);
  assert.match(html, /后端/);
  assert.match(html, /原因/);
  assert.match(html, /missing server/);
});

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
