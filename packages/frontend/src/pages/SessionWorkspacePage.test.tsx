import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionWorkspacePage } from './SessionWorkspacePage';

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
