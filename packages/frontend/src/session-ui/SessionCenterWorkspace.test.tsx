import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getSessionCenterWorkspacePaneForTabId, SessionCenterWorkspace } from './SessionCenterWorkspace';

const source = readFileSync(new URL('./SessionCenterWorkspace.tsx', import.meta.url), 'utf8');
const sessionOsCss = readFileSync(new URL('./session-os.css', import.meta.url), 'utf8');

test('SessionCenterWorkspace renders fixed transcript, file browser, and project terminal tabs', () => {
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
  assert.match(html, /项目终端/);
  assert.match(html, /data-test-transcript="true"/);
});

test('SessionCenterWorkspace maps center tabs to workspace panes', () => {
  assert.equal(getSessionCenterWorkspacePaneForTabId('session-transcript-tab'), 'transcript');
  assert.equal(getSessionCenterWorkspacePaneForTabId('session-file-browser-tab'), 'file-browser');
  assert.equal(getSessionCenterWorkspacePaneForTabId('session-project-terminal-tab'), 'project-terminal');
  assert.equal(getSessionCenterWorkspacePaneForTabId('unknown-tab'), null);
});

test('SessionCenterWorkspace wires project terminal through the project shell profile', () => {
  assert.match(source, /React\.lazy/);
  assert.match(source, /TerminalPanel/);
  assert.match(source, /profile="project_shell"/);
  assert.match(source, /projectId=\{projectId\}/);
  assert.match(source, /title="项目终端"/);
  assert.match(source, /enableRenderOnDemand:\s*true/);
});

test('session workspace styles make the project terminal fill the tab content', () => {
  assert.match(sessionOsCss, /deepsea-project-terminal/);
  assert.match(sessionOsCss, /deepsea-project-terminal-panel/);
  assert.match(sessionOsCss, /height:\s*100%/);
  assert.match(sessionOsCss, /min-height:\s*0/);
});
