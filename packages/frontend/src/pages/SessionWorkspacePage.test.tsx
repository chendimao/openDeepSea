import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionWorkspacePayload } from '../lib/types';
import type { WsServerEvent } from '../lib/ws';
import {
  getSnapshotNavigation,
  runSessionCommand,
  SessionWorkspacePage,
  shouldRefreshSessionWorkspace,
} from './SessionWorkspacePage';

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

test('runSessionCommand sends slash commands through websocket callback', () => {
  const commands: Array<{ sessionId: string; command: string }> = [];
  const result = runSessionCommand('/compact focus: 保留 UI 决策', createCommandPayload(), {
    sendMessage: () => undefined,
    runCommand: (message) => commands.push(message),
  });

  assert.equal(result, null);
  assert.deepEqual(commands, [{ sessionId: 'session-1', command: '/compact focus: 保留 UI 决策' }]);
});

test('runSessionCommand treats empty history command as local no-op', () => {
  let sent = false;
  const result = runSessionCommand('/history', createCommandPayload(), {
    sendMessage: () => {
      sent = true;
    },
    runCommand: () => {
      sent = true;
    },
  });
  assert.equal(result?.kind, 'noop');
  assert.equal(sent, false);
});

test('runSessionCommand sends normal messages through websocket callback', () => {
  const sent: Array<{ sessionId: string; content: string; agentId?: string }> = [];
  const result = runSessionCommand('继续实现', createCommandPayload(), {
    sendMessage: (message) => sent.push(message),
    runCommand: () => undefined,
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

test('getSnapshotNavigation replaces project route with active session route', () => {
  assert.deepEqual(getSnapshotNavigation('project-1', 'session-2', undefined), {
    to: '/projects/project-1/sessions/session-2',
    replace: true,
  });
});

test('getSnapshotNavigation pushes when websocket command switches sessions', () => {
  assert.deepEqual(getSnapshotNavigation('project-1', 'session-2', 'session-1'), {
    to: '/projects/project-1/sessions/session-2',
    replace: false,
  });
  assert.equal(getSnapshotNavigation('project-1', 'session-1', 'session-1'), null);
});

function createCommandPayload(): SessionWorkspacePayload {
  return { activeSession: { session: { id: 'session-1', mode: 'code' } } } as SessionWorkspacePayload;
}
