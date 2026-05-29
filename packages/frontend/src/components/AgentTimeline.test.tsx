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
  assert.match(html, /Explored/);
  assert.match(html, /Read · src\/app\.ts/);
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

test('AgentTimeline renders file diff summary fields with readable labels', () => {
  const html = renderToStaticMarkup(
    <I18nProvider>
      <AgentTimeline
        events={[
          {
            id: 'diff-1',
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
        ]}
      />
    </I18nProvider>,
  );

  assert.match(html, /src\/app\.ts/);
  assert.match(html, /新增行/);
  assert.match(html, /删除行/);
});

test('AgentTimeline renders transcript actions for tool, command, and diff events', () => {
  const html = renderToStaticMarkup(
    <I18nProvider>
      <AgentTimeline
        events={[
          {
            id: 'tool-1',
            message_id: 'message-1',
            run_id: 'run-1',
            agent_id: 'planner',
            seq: 1,
            type: 'tool_result',
            status: 'completed',
            title: '工具结果 Read',
            payload: {
              id: 'tool-1',
              name: 'Read',
              output: 'packages/frontend/src/components/AgentTimeline.tsx',
            },
            created_at: 1000,
          },
          {
            id: 'command-1',
            message_id: 'message-1',
            run_id: 'run-1',
            agent_id: 'planner',
            seq: 2,
            type: 'command',
            status: 'completed',
            title: '执行命令 npm run build',
            payload: { command: 'npm run build', output: 'built' },
            created_at: 1001,
          },
          {
            id: 'diff-1',
            message_id: 'message-1',
            run_id: 'run-1',
            agent_id: 'planner',
            seq: 3,
            type: 'file_diff',
            status: 'completed',
            title: '修改文件 src/app.ts',
            payload: { path: 'src/app.ts', patch: '-old\n+new', additions: 1, deletions: 1 },
            created_at: 1002,
          },
        ]}
      />
    </I18nProvider>,
  );

  assert.match(html, /Explored/);
  assert.match(html, /Ran/);
  assert.match(html, /Edited/);
  assert.match(html, /npm run build/);
  assert.match(html, /修改文件 src\/app\.ts · \+1 \/ -1/);
});

test('AgentTimeline merges tool lifecycle events into one transcript row', () => {
  const html = renderToStaticMarkup(
    <I18nProvider>
      <AgentTimeline
        events={[
          {
            id: 'run-1:1',
            message_id: 'message-1',
            run_id: 'run-1',
            agent_id: 'planner',
            seq: 1,
            type: 'tool_call',
            status: 'started',
            title: '调用工具 Read',
            payload: { id: 'tool-read-1', name: 'Read', input: '{"path":"package.json"}' },
            created_at: 1000,
          },
          {
            id: 'run-1:2',
            message_id: 'message-1',
            run_id: 'run-1',
            agent_id: 'planner',
            seq: 2,
            type: 'tool_result',
            status: 'completed',
            title: '工具结果 Read',
            payload: { id: 'tool-read-1', name: 'Read', output: '{"name":"openclaw-room"}' },
            created_at: 1001,
          },
        ]}
      />
    </I18nProvider>,
  );

  assert.match(html, /1 条事件/);
  assert.match(html, /Explored/);
  assert.match(html, /Read · package\.json/);
  assert.match(html, /openclaw-room/);
  assert.doesNotMatch(html, /2 条事件/);
});

test('AgentTimeline collapses all ACP event cards by default', () => {
  const html = renderToStaticMarkup(
    <I18nProvider>
      <AgentTimeline
        events={[
          {
            id: 'tool-1',
            message_id: 'message-1',
            run_id: 'run-1',
            agent_id: 'planner',
            seq: 1,
            type: 'tool_result',
            status: 'completed',
            title: '工具结果 Read package.json',
            payload: { id: 'tool-1', name: 'Read', output: { ok: true } },
            created_at: 1000,
          },
        ]}
      />
    </I18nProvider>,
  );

  assert.doesNotMatch(html, /<details[^>]*open/);
});

test('AgentTimeline renders lightweight tool detail placeholders without heavy payload content', () => {
  const html = renderToStaticMarkup(
    <I18nProvider>
      <AgentTimeline
        roomId="room-1"
        events={[
          {
            id: 'tool-1',
            message_id: 'message-1',
            run_id: 'run-1',
            agent_id: 'planner',
            seq: 1,
            type: 'tool_result',
            status: 'completed',
            title: '工具结果 Read',
            payload: {
              id: 'call-1',
              name: 'Read',
              path: 'packages/frontend/src/pages/RoomPage.tsx',
              detail_omitted: true,
              detail_event_id: 'tool-result-1',
            },
            created_at: 1000,
          },
        ]}
      />
    </I18nProvider>,
  );

  assert.match(html, /Explored/);
  assert.match(html, /Read · packages\/frontend\/src\/pages\/RoomPage\.tsx/);
  assert.match(html, /展开后加载完整详情/);
  assert.doesNotMatch(html, /文件正文/);
  assert.doesNotMatch(html, /输出/);
});

test('AgentTimeline renders concrete event time in timeline summaries', () => {
  const html = renderToStaticMarkup(
    <I18nProvider>
      <AgentTimeline
        events={[
          {
            id: 'tool-1',
            message_id: 'message-1',
            run_id: 'run-1',
            agent_id: 'planner',
            seq: 1,
            type: 'tool_result',
            status: 'completed',
            title: '工具结果 Read',
            payload: { id: 'call-1', name: 'Read' },
            created_at: Date.UTC(2026, 0, 1, 8, 9, 10),
          },
        ]}
      />
    </I18nProvider>,
  );

  assert.match(html, /agent-timeline-time/);
  assert.match(html, /08:09:10/);
});

test('AgentTimeline shows hidden debug monitor without raw events in visible count', () => {
  const html = renderToStaticMarkup(
    <I18nProvider>
      <AgentTimeline
        events={[
          {
            id: 'raw-1',
            message_id: 'message-1',
            run_id: 'run-1',
            agent_id: 'planner',
            seq: 1,
            type: 'raw',
            status: 'completed',
            title: '原始事件 available_commands_update',
            payload: { raw_type: 'available_commands_update' },
            raw: { method: 'session/update', params: { update: { sessionUpdate: 'available_commands_update' } } },
            created_at: 1000,
          },
        ]}
      />
    </I18nProvider>,
  );

  assert.match(html, /协议调试/);
  assert.match(html, /2 条隐藏事件/);
  assert.doesNotMatch(html, /ACP 执行过程/);
});

test('AgentTimeline renders protocol diagnostics when ACP omits thinking stream', () => {
  const html = renderToStaticMarkup(
    <I18nProvider>
      <AgentTimeline
        events={[
          {
            id: 'reply-1',
            message_id: 'message-1',
            run_id: 'run-1',
            agent_id: 'planner',
            seq: 1,
            type: 'assistant_message',
            status: 'delta',
            title: '助手回复',
            payload: { text: 'hello' },
            raw: {
              method: 'session/update',
              params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } } },
            },
            created_at: 1000,
          },
        ]}
      />
    </I18nProvider>,
  );

  assert.match(html, /协议调试/);
  assert.match(html, /thinking 未返回/);
  assert.match(html, /provider 没有返回 thinking/);
  assert.match(html, /agent_message_chunk/);
  assert.doesNotMatch(html, /助手回复/);
});

test('AgentTimeline marks protocol diagnostics counts as a fixed count list', () => {
  const longType = 'agent_extremely_long_protocol_event_name_that_should_not_overlap_count_column';
  const html = renderToStaticMarkup(
    <I18nProvider>
      <AgentTimeline
        events={[
          {
            id: 'long-protocol-1',
            message_id: 'message-1',
            run_id: 'run-1',
            agent_id: 'planner',
            seq: 1,
            type: 'raw',
            status: 'completed',
            title: `原始事件 ${longType}`,
            payload: { raw_type: longType },
            raw: { method: 'session/update', params: { update: { sessionUpdate: longType } } },
            created_at: 1000,
          },
        ]}
      />
    </I18nProvider>,
  );

  assert.match(html, /agent-timeline-protocol-counts/);
  assert.match(html, new RegExp(`title="${longType}"`));
  assert.match(html, />1 次</);
});

test('AgentTimeline hides assistant message stream chunks and renders translated structured fields', () => {
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

  assert.doesNotMatch(html, /协议回复片段/);
  assert.doesNotMatch(html, /助手回复/);
  assert.match(html, /1 条事件/);
  assert.match(html, /后端/);
  assert.match(html, /原因/);
  assert.match(html, /missing server/);
});

test('AgentTimeline returns null when only assistant message stream chunks exist', () => {
  const html = renderToStaticMarkup(
    <I18nProvider>
      <AgentTimeline
        events={[
          {
            id: 'run-1:1',
            message_id: 'message-1',
            run_id: 'run-1',
            agent_id: 'planner',
            seq: 1,
            type: 'assistant_message',
            status: 'delta',
            title: '助手回复',
            payload: { text: '只应显示在消息正文里' },
            created_at: 1000,
          },
        ]}
      />
    </I18nProvider>,
  );

  assert.equal(html, '');
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
