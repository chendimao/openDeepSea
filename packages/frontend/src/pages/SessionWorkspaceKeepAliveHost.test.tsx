import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../lib/i18n';
import { SessionWorkspaceKeepAliveHost } from './SessionWorkspaceKeepAliveHost';
import {
  getSessionWorkspaceRouteParams,
  isSessionWorkspacePath,
} from './sessionWorkspaceRoute';

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

test('isSessionWorkspacePath matches only new Session workspace routes', () => {
  assert.equal(isSessionWorkspacePath('/'), true);
  assert.equal(isSessionWorkspacePath('/projects/project-1'), true);
  assert.equal(isSessionWorkspacePath('/projects/project-1/'), true);
  assert.equal(isSessionWorkspacePath('/projects/project-1/sessions/session-1'), true);
  assert.equal(isSessionWorkspacePath('/projects/project-1/sessions/session-1/'), true);

  assert.equal(isSessionWorkspacePath('/chat'), false);
  assert.equal(isSessionWorkspacePath('/agents'), false);
  assert.equal(isSessionWorkspacePath('/skills'), false);
  assert.equal(isSessionWorkspacePath('/files'), false);
  assert.equal(isSessionWorkspacePath('/projects/project-1/files'), false);
  assert.equal(isSessionWorkspacePath('/projects/project-1/rooms/room-1'), false);
});

test('getSessionWorkspaceRouteParams extracts project and session params', () => {
  assert.deepEqual(getSessionWorkspaceRouteParams('/'), {
    active: true,
    projectId: '',
    sessionId: undefined,
  });
  assert.deepEqual(getSessionWorkspaceRouteParams('/projects/project-1'), {
    active: true,
    projectId: 'project-1',
    sessionId: undefined,
  });
  assert.deepEqual(getSessionWorkspaceRouteParams('/projects/project-1/sessions/session-1'), {
    active: true,
    projectId: 'project-1',
    sessionId: 'session-1',
  });
  assert.deepEqual(getSessionWorkspaceRouteParams('/files'), {
    active: false,
    projectId: '',
    sessionId: undefined,
  });
});

test('SessionWorkspaceKeepAliveHost is visible on Session workspace routes', () => {
  const html = renderKeepAliveHost('/projects/project-1/sessions/session-1');

  assert.match(html, /data-testid="session-workspace-keep-alive"/);
  assert.match(html, /data-active="true"/);
  assert.match(html, /加载 Session/);
});

test('SessionWorkspaceKeepAliveHost starts hidden on non-Session routes', () => {
  const html = renderKeepAliveHost('/files');

  assert.match(html, /data-testid="session-workspace-keep-alive"/);
  assert.match(html, /data-active="false"/);
  assert.doesNotMatch(html, /加载 Session/);
});

test('main route tree mounts Session keep-alive host outside ordinary routes', () => {
  const source = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8');

  assert.match(source, /<SessionWorkspaceKeepAliveHost \/>/);
  assert.doesNotMatch(source, /path="\/" element={<SessionWorkspacePage \/>}/);
  assert.doesNotMatch(source, /path="\/projects\/:projectId" element={<SessionWorkspacePage \/>}/);
  assert.doesNotMatch(source, /path="\/projects\/:projectId\/sessions\/:sessionId" element={<SessionWorkspacePage \/>}/);
});

test('SessionWorkspaceKeepAliveHost disables page navigation while hidden', () => {
  const source = readFileSync(new URL('./SessionWorkspaceKeepAliveHost.tsx', import.meta.url), 'utf8');

  assert.match(source, /lastSessionRoute/);
  assert.match(source, /navigationEnabled={active}/);
  assert.doesNotMatch(source, /route\.active && \(/);
});

test('SessionWorkspaceKeepAliveHost records concrete session routes for nav restore', () => {
  const source = readFileSync(new URL('./SessionWorkspaceKeepAliveHost.tsx', import.meta.url), 'utf8');

  assert.match(source, /rememberLastSessionWorkspaceRoute/);
});

function renderKeepAliveHost(initialEntry: string): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(['projects'], [{ id: 'project-1', name: 'Project 1' }]);

  return renderToStaticMarkup(
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <SessionWorkspaceKeepAliveHost />
        </MemoryRouter>
      </QueryClientProvider>
    </I18nProvider>,
  );
}
