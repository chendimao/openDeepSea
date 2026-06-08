import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../lib/i18n';
import type { SessionMode, SessionWorkspacePayload } from '../lib/types';
import type { WsServerEvent } from '../lib/ws';
import {
  createProjectSessionAndSelect,
  getSnapshotNavigation,
  isCompactPreviewForActiveSession,
  projectSessionToActiveSummary,
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
  const sent: Array<{ sessionId: string; content: string; agentId?: string; mode?: string }> = [];
  const result = runSessionCommand('继续实现', createCommandPayload(), {
    sendMessage: (message) => sent.push(message),
    runCommand: () => undefined,
  });

  assert.equal(result, null);
  assert.deepEqual(sent, [{ sessionId: 'session-1', content: '继续实现', agentId: 'planner', mode: 'code' }]);
});

test('runSessionCommand forwards session file refs on normal messages', () => {
  const sent: Array<{
    sessionId: string;
    content: string;
    agentId?: string;
    mode?: string;
    workspaceFileRefs?: string[];
    libraryFileRefs?: string[];
  }> = [];
  const result = runSessionCommand({
    content: '继续实现',
    workspaceFileRefs: ['packages/frontend/src/session-ui/SessionShellView.tsx'],
    libraryFileRefs: ['asset:doc-1'],
  }, createCommandPayload(), {
    sendMessage: (message) => sent.push(message),
    runCommand: () => undefined,
  });

  assert.equal(result, null);
  assert.deepEqual(sent, [{
    sessionId: 'session-1',
    content: '继续实现',
    agentId: 'planner',
    mode: 'code',
    workspaceFileRefs: ['packages/frontend/src/session-ui/SessionShellView.tsx'],
    libraryFileRefs: ['asset:doc-1'],
  }]);
});

test('runSessionCommand does not attach refs to slash commands', () => {
  const commands: Array<{ sessionId: string; command: string }> = [];
  const result = runSessionCommand({
    content: '/compact',
    workspaceFileRefs: ['packages/frontend/src/session-ui/SessionShellView.tsx'],
    libraryFileRefs: ['asset:doc-1'],
  }, createCommandPayload(), {
    sendMessage: () => undefined,
    runCommand: (message) => commands.push(message),
  });

  assert.equal(result, null);
  assert.deepEqual(commands, [{ sessionId: 'session-1', command: '/compact' }]);
});

test('createProjectSessionAndSelect creates a project session and navigates to it', async () => {
  const created: Array<{
    projectId: string;
    input: { title?: string; mode?: SessionMode; provider?: string | null; model?: string | null };
  }> = [];
  const navigations: Array<{ to: string; replace?: boolean }> = [];
  const snapshots: Array<{ projectId: string; sessionId: string }> = [];
  const insertedSessionIds: string[] = [];

  await createProjectSessionAndSelect({
    targetProjectId: 'project-2',
    sourceSession: {
      id: 'session-1',
      mode: 'code',
      provider: 'codex',
      model: 'gpt-5.5',
    },
    navigationEnabled: true,
    createSession: async (projectId, input) => {
      created.push({ projectId, input });
      return createTestSession({ id: 'session-new', project_id: projectId, mode: input.mode ?? 'ask' });
    },
    navigate: (to, options) => navigations.push({ to, replace: options?.replace }),
    requestWorkspace: (input) => snapshots.push(input),
    onSessionCreated: (session) => insertedSessionIds.push(session.id),
  });

  assert.deepEqual(created, [{
    projectId: 'project-2',
    input: {
      title: 'New Session',
      mode: 'code',
      provider: 'codex',
      model: 'gpt-5.5',
    },
  }]);
  assert.deepEqual(insertedSessionIds, ['session-new']);
  assert.deepEqual(navigations, [{ to: '/projects/project-2/sessions/session-new', replace: undefined }]);
  assert.deepEqual(snapshots, [{ projectId: 'project-2', sessionId: 'session-new' }]);
});

test('createProjectSessionAndSelect requests the new snapshot when navigation is disabled', async () => {
  const navigations: Array<{ to: string; replace?: boolean }> = [];
  const snapshots: Array<{ projectId: string; sessionId: string }> = [];

  await createProjectSessionAndSelect({
    targetProjectId: 'project-3',
    sourceSession: {
      id: 'session-1',
      mode: 'review',
      provider: null,
      model: null,
    },
    navigationEnabled: false,
    createSession: async (projectId, input) => createTestSession({
      id: 'session-keep-alive',
      project_id: projectId,
      mode: input.mode ?? 'ask',
    }),
    navigate: (to, options) => navigations.push({ to, replace: options?.replace }),
    requestWorkspace: (input) => snapshots.push(input),
  });

  assert.deepEqual(navigations, []);
  assert.deepEqual(snapshots, [{ projectId: 'project-3', sessionId: 'session-keep-alive' }]);
});

test('projectSessionToActiveSummary creates a rail record under the target project', () => {
  const summary = projectSessionToActiveSummary({
    session: {
      id: 'session-new',
      project_id: 'project-1',
      title: 'New Session',
      current_goal: null,
      mode: 'code',
      phase: 'idle',
      status: 'active',
      provider: 'codex',
      model: 'gpt-5.5',
      workspace_path: '/workspace/opendeepsea',
      worktree_path: null,
      branch_name: null,
      forked_from_session_id: null,
      forked_from_history_record_id: null,
      latest_compaction_id: null,
      latest_context_manifest_id: null,
      pinned_at: null,
      last_viewed_at: null,
      closed_at: null,
      archived_at: null,
      created_at: 100,
      updated_at: 200,
    },
    project: {
      id: 'project-1',
      name: 'OpenDeepSea',
      path: '/workspace/opendeepsea',
    },
  });

  assert.deepEqual(summary, {
    id: 'session-new',
    project_id: 'project-1',
    project_name: 'OpenDeepSea',
    project_path: '/workspace/opendeepsea',
    title: 'New Session',
    status: 'active',
    phase: 'idle',
    provider: 'codex',
    model: 'gpt-5.5',
    pinned_at: null,
    updated_at: 200,
    unread_count: 0,
    active_run_count: 0,
    latest_event_summary: null,
  });
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

function createTestSession(input: {
  id: string;
  project_id: string;
  mode: SessionMode;
}) {
  return {
    id: input.id,
    project_id: input.project_id,
    title: 'New Session',
    current_goal: null,
    mode: input.mode,
    phase: 'idle',
    status: 'active',
    provider: null,
    model: null,
    workspace_path: '/workspace/project',
    worktree_path: null,
    branch_name: null,
    forked_from_session_id: null,
    forked_from_history_record_id: null,
    latest_compaction_id: null,
    latest_context_manifest_id: null,
    pinned_at: null,
    last_viewed_at: null,
    closed_at: null,
    archived_at: null,
    created_at: 100,
    updated_at: 100,
  } as const;
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
