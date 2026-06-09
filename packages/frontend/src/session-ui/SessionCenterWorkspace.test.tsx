import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getSessionCenterWorkspacePaneForTabId, SessionCenterWorkspace } from './SessionCenterWorkspace';

test('SessionCenterWorkspace renders fixed transcript and file browser tabs', () => {
  const queryClient = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <SessionCenterWorkspace
        projectId="project-1"
        workspaceRootPath="/workspace/project-1"
        transcript={<div data-test-transcript="true">Transcript</div>}
      />
    </QueryClientProvider>,
  );

  assert.match(html, /对话记录/);
  assert.match(html, /文件浏览器/);
  assert.match(html, /data-test-transcript="true"/);
});

test('SessionCenterWorkspace maps center tabs to workspace panes', () => {
  assert.equal(getSessionCenterWorkspacePaneForTabId('session-transcript-tab'), 'transcript');
  assert.equal(getSessionCenterWorkspacePaneForTabId('session-file-browser-tab'), 'file-browser');
  assert.equal(getSessionCenterWorkspacePaneForTabId('unknown-tab'), null);
});
