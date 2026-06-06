import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { api } from '../lib/api';
import type { SessionWorkspacePayload } from '../lib/types';
import type { WsServerEvent } from '../lib/ws';
import { runSessionCommand, SessionWorkspacePage, shouldRefreshSessionWorkspace } from './SessionWorkspacePage';

const globalWithReact = globalThis as typeof globalThis & { React: typeof React };
globalWithReact.React = React;

test('project route renders Session shell loading state instead of old room UI', () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/projects/project-1']}>
        <Routes>
          <Route path="/projects/:projectId" element={<SessionWorkspacePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  assert.match(html, /session-shell/);
  assert.match(html, /加载 Session/);
  assert.doesNotMatch(html, /RoomWorkbench/);
  assert.doesNotMatch(html, /TaskWorkspacePanel/);
  assert.doesNotMatch(html, /chat-panel/);
});

test('runSessionCommand returns compact preview from slash compact response', async () => {
  const originalPreviewCompact = api.previewCompact;
  let sentFocus = '';
  api.previewCompact = async (_sessionId, input = {}) => {
    sentFocus = input.focus ?? '';
    return {
      id: 'compact-1',
      session_id: 'session-1',
      strategy: 'focus',
      focus_prompt: '保留 UI 决策',
      preview_summary: 'Focus：保留 UI 决策',
      applied_summary: null,
      retained_refs: '[]',
      dropped_refs: '[]',
      risk_notes: null,
      user_edited: 0,
      status: 'previewed',
      created_at: Date.now(),
      applied_at: null,
    };
  };
  try {
    const result = await runSessionCommand('/compact focus: 保留 UI 决策', createCommandPayload(), {
      sendMessage: () => undefined,
    });
    assert.equal(sentFocus, '保留 UI 决策');
    assert.equal(result?.kind, 'compact');
    if (result?.kind === 'compact') assert.equal(result.compaction.focus_prompt, '保留 UI 决策');
  } finally {
    api.previewCompact = originalPreviewCompact;
  }
});

test('runSessionCommand treats empty history command as local no-op', async () => {
  let sent = false;
  const result = await runSessionCommand('/history', createCommandPayload(), {
    sendMessage: () => {
      sent = true;
    },
  });
  assert.equal(result?.kind, 'noop');
  assert.equal(sent, false);
});

test('runSessionCommand sends normal messages through websocket callback', async () => {
  const sent: Array<{ sessionId: string; content: string; agentId?: string }> = [];
  const result = await runSessionCommand('继续实现', createCommandPayload(), {
    sendMessage: (message) => sent.push(message),
  });

  assert.equal(result, null);
  assert.deepEqual(sent, [{ sessionId: 'session-1', content: '继续实现', agentId: 'planner', mode: 'code' }]);
});

test('shouldRefreshSessionWorkspace skips unfinished stream events', () => {
  const event = {
    type: 'session_run:stream',
    sessionId: 'session-1',
    agentId: 'planner',
    runId: 'run-1',
    seq: 1,
    chunk: 'partial',
    channel: 'answer',
    done: false,
  } as WsServerEvent;

  assert.equal(shouldRefreshSessionWorkspace(event), false);
});

test('shouldRefreshSessionWorkspace does not refresh completed stream events', () => {
  const event = {
    type: 'session_run:stream',
    sessionId: 'session-1',
    agentId: 'planner',
    runId: 'run-1',
    seq: 2,
    chunk: '',
    channel: 'event',
    done: true,
  } as WsServerEvent;

  assert.equal(shouldRefreshSessionWorkspace(event), false);
});

test('shouldRefreshSessionWorkspace does not refresh session run updates', () => {
  const event = {
    type: 'session_run:updated',
    sessionId: 'session-1',
    run: { id: 'run-1' },
  } as WsServerEvent;

  assert.equal(shouldRefreshSessionWorkspace(event), false);
});

function createCommandPayload(): SessionWorkspacePayload {
  return { activeSession: { session: { id: 'session-1', mode: 'code' } } } as SessionWorkspacePayload;
}
