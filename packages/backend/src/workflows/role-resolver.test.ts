import test from 'node:test';
import assert from 'node:assert/strict';
import type { RoomAgent, Task } from '../types.js';
import { resolveWorkflowExecutor, selectWorkflowAgentForRole } from './role-resolver.js';

test('selectWorkflowAgentForRole filters to ACP executable agents and prefers exact role', () => {
  const manualExecutor = agent({ id: 'manual', workflow_role: 'executor', acp_enabled: 0, acp_backend: null });
  const reviewer = agent({ id: 'reviewer', workflow_role: 'reviewer', capabilities: ['review'] });
  const executor = agent({ id: 'executor', workflow_role: 'executor', capabilities: ['backend'] });

  assert.equal(selectWorkflowAgentForRole('executor', [manualExecutor, reviewer, executor])?.id, 'executor');
});

test('selectWorkflowAgentForRole falls non-executor roles back to executable executor', () => {
  const executor = agent({ id: 'executor', workflow_role: 'executor' });

  assert.equal(selectWorkflowAgentForRole('reviewer', [executor])?.id, 'executor');
});

test('resolveWorkflowExecutor uses task scope to choose frontend or backend executor', () => {
  const frontend = agent({
    id: 'frontend',
    workflow_role: 'executor',
    capabilities: ['frontend', 'testing'],
  });
  const backend = agent({
    id: 'backend',
    workflow_role: 'executor',
    capabilities: ['backend', 'testing'],
  });

  assert.equal(
    resolveWorkflowExecutor([backend, frontend], task({
      title: '实现 RoomPage 前端交互',
      description: '修改 packages/frontend/src/pages/RoomPage.tsx',
    }))?.id,
    'frontend',
  );
  assert.equal(
    resolveWorkflowExecutor([frontend, backend], task({
      title: '实现 API 路由',
      description: '修改 packages/backend/src/routes.ts',
    }))?.id,
    'backend',
  );
});

test('resolveWorkflowExecutor honors assigned agent override only when executable', () => {
  const assigned = agent({ id: 'assigned', workflow_role: 'reviewer' });
  const disabledAssigned = agent({
    id: 'disabled-assigned',
    workflow_role: 'executor',
    acp_enabled: 0,
    acp_backend: null,
  });
  const fallback = agent({ id: 'fallback', workflow_role: 'executor' });

  assert.equal(resolveWorkflowExecutor([fallback, assigned], task({ assigned_agent_id: assigned.id }))?.id, 'assigned');
  assert.equal(
    resolveWorkflowExecutor([disabledAssigned, fallback], task({ assigned_agent_id: disabledAssigned.id })),
    null,
  );
});

function agent(patch: Partial<RoomAgent>): RoomAgent {
  return {
    id: patch.id ?? 'agent',
    room_id: patch.room_id ?? 'room',
    global_agent_id: patch.global_agent_id ?? null,
    agent_id: patch.agent_id ?? patch.id ?? 'agent',
    agent_name: patch.agent_name ?? patch.id ?? 'Agent',
    agent_role: patch.agent_role ?? null,
    preferred_user_name: patch.preferred_user_name ?? null,
    personality: patch.personality ?? null,
    rules: patch.rules ?? null,
    responsibilities: patch.responsibilities ?? null,
    workflow_role: patch.workflow_role ?? null,
    joined_at: patch.joined_at ?? 1,
    left_at: patch.left_at ?? null,
    acp_enabled: patch.acp_enabled ?? 1,
    acp_backend: patch.acp_backend === undefined ? 'codex' : patch.acp_backend,
    acp_session_id: patch.acp_session_id ?? null,
    acp_session_label: patch.acp_session_label ?? null,
    acp_permission_mode: patch.acp_permission_mode ?? 'bypass',
    acp_writable_dirs: patch.acp_writable_dirs ?? [],
    capabilities: patch.capabilities ?? [],
    default_runtime: patch.default_runtime ?? 'acp',
    memory_max_context_chars: patch.memory_max_context_chars ?? null,
  };
}

function task(patch: Partial<Task>): Task {
  return {
    id: patch.id ?? 'task',
    project_id: patch.project_id ?? 'project',
    room_id: patch.room_id ?? 'room',
    parent_task_id: patch.parent_task_id ?? null,
    title: patch.title ?? 'Task',
    description: patch.description ?? null,
    status: patch.status ?? 'todo',
    priority: patch.priority ?? 'normal',
    interaction_mode: patch.interaction_mode ?? 'auto_recommended',
    assigned_agent_id: patch.assigned_agent_id ?? null,
    source_message_id: patch.source_message_id ?? null,
    created_from: patch.created_from ?? 'manual',
    created_at: patch.created_at ?? 1,
    updated_at: patch.updated_at ?? 1,
    completed_at: patch.completed_at ?? null,
  };
}
