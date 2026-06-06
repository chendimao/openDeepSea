import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../lib/i18n';
import type { SessionWorkspacePayload } from '../lib/types';
import type { WsServerEvent } from '../lib/ws';
import {
  getSnapshotNavigation,
  isCompactPreviewForActiveSession,
  runSessionCommand,
  SessionWorkspacePage,
  shouldRefreshSessionWorkspace,
} from './SessionWorkspacePage';

const globalWithReact = globalThis as typeof globalThis & { React: typeof React };
globalWithReact.React = React;

Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  },
  configurable: true,
});

test('project route renders Session shell loading state', () => {
  const html = renderSessionWorkspace('/projects/project-1', '/projects/:projectId');

  assert.match(html, /session-shell/);
  assert.match(html, /加载 Session/);
});

test('SessionWorkspacePage can render from keep-alive host route params', () => {
  const html = renderSessionWorkspaceWithProps({
    projectId: 'project-1',
    sessionId: 'session-1',
  });

  assert.match(html, /session-shell/);
  assert.match(html, /加载 Session/);
});

test('SessionWorkspacePage exposes override props for keep-alive host params', () => {
  const source = readFileSync(new URL('./SessionWorkspacePage.tsx', import.meta.url), 'utf8');

  assert.match(source, /type SessionWorkspacePageProps =/);
  assert.match(source, /projectIdOverride\?: string/);
  assert.match(source, /sessionIdOverride\?: string/);
  assert.match(source, /navigationEnabled\?: boolean/);
  assert.match(source, /if \(!navigationEnabled\) return/);
  assert.match(source, /if \(!navigationEnabled \|\| event\.key !== 'Escape'\) return/);
});

test('root session route shows project onboarding when no projects exist', () => {
  const html = renderSessionWorkspace('/', '/', { projects: [] });

  assert.match(html, /先添加一个项目/);
  assert.match(html, /会话需要绑定到本地项目/);
  assert.match(html, /新建项目/);
  assert.doesNotMatch(html, /加载 Session/);
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

test('getSnapshotNavigation skips navigation when keep-alive page is hidden', () => {
  assert.equal(getSnapshotNavigation('project-1', 'session-2', undefined, false), null);
  assert.equal(getSnapshotNavigation('project-1', 'session-2', 'session-1', false), null);
});

test('getSnapshotNavigation pushes when websocket command switches sessions', () => {
  assert.deepEqual(getSnapshotNavigation('project-1', 'session-2', 'session-1'), {
    to: '/projects/project-1/sessions/session-2',
    replace: false,
  });
  assert.equal(getSnapshotNavigation('project-1', 'session-1', 'session-1'), null);
});

test('isCompactPreviewForActiveSession ignores previews from inactive sessions', () => {
  const sameSession = isCompactPreviewForActiveSession('session-1', {
    type: 'session_compact:preview',
    sessionId: 'session-1',
    compaction: { id: 'compact-1' },
  } as Extract<WsServerEvent, { type: 'session_compact:preview' }>);
  const otherSession = isCompactPreviewForActiveSession('session-1', {
    type: 'session_compact:preview',
    sessionId: 'session-2',
    compaction: { id: 'compact-2' },
  } as Extract<WsServerEvent, { type: 'session_compact:preview' }>);

  assert.equal(sameSession, true);
  assert.equal(otherSession, false);
});

function createCommandPayload(): SessionWorkspacePayload {
  return { activeSession: { session: { id: 'session-1', mode: 'code' } } } as SessionWorkspacePayload;
}

function renderSessionWorkspace(
  initialEntry: string,
  routePath: string,
  input: { projects?: unknown[] } = {},
): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (input.projects) queryClient.setQueryData(['projects'], input.projects);

  return renderToStaticMarkup(
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route path={routePath} element={<SessionWorkspacePage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

function renderSessionWorkspaceWithProps(input: { projectId: string; sessionId?: string }): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(['projects'], [{ id: input.projectId, name: 'Project 1' }]);

  return renderToStaticMarkup(
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/files']}>
          <SessionWorkspacePage
            projectIdOverride={input.projectId}
            sessionIdOverride={input.sessionId}
          />
        </MemoryRouter>
      </QueryClientProvider>
    </I18nProvider>,
  );
}
