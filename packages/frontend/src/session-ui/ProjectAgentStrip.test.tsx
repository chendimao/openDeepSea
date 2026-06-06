import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../lib/i18n';
import type { Project, ProjectUsedAgentsPayload } from '../lib/types';
import { ProjectAgentStrip } from './ProjectAgentStrip';

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

test('ProjectAgentStrip renders planner and project room agents', () => {
  const project: Project = {
    id: 'project-1',
    name: 'Project One',
    path: '/tmp/project-one',
    description: null,
    pinned_at: null,
    sort_order: null,
    message_routing_mode: 'fallback_reply',
    fallback_agent_id: 'planner',
    created_at: 1,
    updated_at: 1,
  };
  const payload: ProjectUsedAgentsPayload = {
    planner: {
      kind: 'session_planner',
      agent_id: 'planner',
      name: 'Planner',
      effective_acp_backend: 'opencode',
      project_override_acp_backend: 'opencode',
      backend_source: 'project',
      runtime_profile: {
        permission_mode: 'read-only',
        runtime_backend: 'acp',
        tool_policy: { allowed: ['read_files'] },
        workspace_policy: { read: ['.'], write: [] },
        memory_scope: 'project',
      },
    },
    agents: [{
      kind: 'room_agent',
      global_agent_id: 'global-reviewer',
      agent_id: 'reviewer',
      name: 'Reviewer',
      acp_enabled: true,
      acp_backend: 'codex',
      room_bindings: [{
        room_id: 'room-1',
        room_name: 'Room One',
        room_agent_id: 'room-agent-1',
        acp_backend: 'codex',
        workflow_role: 'reviewer',
      }],
    }],
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(['project-used-agents', project.id], payload);

  const html = renderToStaticMarkup(
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <ProjectAgentStrip project={project} />
      </QueryClientProvider>
    </I18nProvider>,
  );

  assert.match(html, /项目智能体/);
  assert.match(html, /设置会话规划智能体/);
  assert.match(html, /Planner · OpenCode/);
  assert.match(html, /设置 Reviewer/);
});
