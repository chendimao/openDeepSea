import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { api } from '../lib/api';
import type { SessionWorkspacePayload } from '../lib/types';
import { runSessionCommand, SessionWorkspacePage } from './SessionWorkspacePage';

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
  const originalSendSessionMessage = api.sendSessionMessage;
  let sentContent = '';
  api.sendSessionMessage = async (_sessionId, input) => {
    sentContent = input.content;
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
    const result = await runSessionCommand('/compact focus: 保留 UI 决策', createCommandPayload());
    assert.equal(sentContent, '/compact focus: 保留 UI 决策');
    assert.equal(result?.kind, 'compact');
    if (result?.kind === 'compact') assert.equal(result.compaction.focus_prompt, '保留 UI 决策');
  } finally {
    api.sendSessionMessage = originalSendSessionMessage;
  }
});

test('runSessionCommand treats empty history command as local no-op', async () => {
  const originalSendSessionMessage = api.sendSessionMessage;
  let sent = false;
  api.sendSessionMessage = async () => {
    sent = true;
    return { message: { id: 'message-1' } } as Awaited<ReturnType<typeof api.sendSessionMessage>>;
  };
  try {
    const result = await runSessionCommand('/history', createCommandPayload());
    assert.equal(result?.kind, 'noop');
    assert.equal(sent, false);
  } finally {
    api.sendSessionMessage = originalSendSessionMessage;
  }
});

function createCommandPayload(): SessionWorkspacePayload {
  return { activeSession: { session: { id: 'session-1' } } } as SessionWorkspacePayload;
}
