import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RoomAgent } from '../../types.js';
import {
  agentCanExecuteWorkflowTask,
  requiredTemplateIdForTask,
  selectCoordinatorAgentForTask,
  type CoordinatorWorkflowTask,
} from './coordinator-agents.js';

describe('coordinator agent matching', () => {
  it('prefers an in-room agent that satisfies workflow role, ACP, and write boundary', () => {
    const task = workflowTask({
      role: 'executor',
      title: '实现前端文件列表',
      scope_write: ['packages/frontend/src/pages/RoomPage.tsx'],
      required_capabilities: ['frontend'],
    });
    const noWrite = roomAgent({
      id: 'agent-no-write',
      agent_id: 'backend-executor',
      agent_name: 'Backend Executor',
      capabilities: ['backend'],
      workspace_policy: { read: ['.'], write: ['packages/backend'] },
    });
    const frontend = roomAgent({
      id: 'agent-frontend',
      agent_id: 'frontend-executor',
      agent_name: 'Frontend Executor',
      capabilities: ['frontend', 'react'],
      workspace_policy: { read: ['.'], write: ['packages/frontend'] },
    });

    const result = selectCoordinatorAgentForTask({ task, agents: [noWrite, frontend] });

    assert.equal(result.agent?.id, 'agent-frontend');
    assert.equal(result.templateId, null);
    assert.match(result.assignmentReason, /workflow role/i);
    assert.match(result.assignmentReason, /write boundary/i);
  });

  it('returns built-in template id suggestions when the room has no matching agent', () => {
    assert.equal(requiredTemplateIdForTask(workflowTask({
      role: 'executor',
      title: '实现 React 文件管理页面',
      scope_write: ['packages/frontend/src/components/FileManager.tsx'],
    })), 'frontend-executor');
    assert.equal(requiredTemplateIdForTask(workflowTask({
      role: 'executor',
      title: '实现文件 API',
      scope_write: ['packages/backend/src/routes.ts'],
    })), 'backend-executor');
    assert.equal(requiredTemplateIdForTask(workflowTask({
      role: 'reviewer',
      title: '审查实现结果',
    })), 'reviewer');
    assert.equal(requiredTemplateIdForTask(workflowTask({
      role: 'acceptor',
      title: '验收功能',
    })), 'acceptor');

    const result = selectCoordinatorAgentForTask({
      task: workflowTask({
        role: 'executor',
        title: '实现后端文件仓储',
        scope_write: ['packages/backend/src/repos/files.ts'],
      }),
      agents: [],
    });

    assert.equal(result.agent, null);
    assert.equal(result.templateId, 'backend-executor');
    assert.match(result.assignmentReason, /suggest/i);
  });

  it('does not select agents without write permission, enabled ACP, or matching workflow role', () => {
    const task = workflowTask({
      role: 'executor',
      title: '实现后端上传接口',
      scope_write: ['packages/backend/src/routes.ts'],
    });
    const readOnly = roomAgent({
      id: 'agent-read-only',
      agent_id: 'backend-read-only',
      acp_permission_mode: 'read-only',
      workspace_policy: { read: ['.'], write: ['packages/backend'] },
    });
    const acpDisabled = roomAgent({
      id: 'agent-acp-disabled',
      agent_id: 'backend-disabled',
      acp_enabled: 0,
      workspace_policy: { read: ['.'], write: ['packages/backend'] },
    });
    const wrongRole = roomAgent({
      id: 'agent-reviewer',
      agent_id: 'reviewer',
      workflow_role: 'reviewer',
      workspace_policy: { read: ['.'], write: ['packages/backend'] },
    });

    assert.equal(agentCanExecuteWorkflowTask(readOnly, task), false);
    assert.equal(agentCanExecuteWorkflowTask(acpDisabled, task), false);
    assert.equal(agentCanExecuteWorkflowTask(wrongRole, task), false);

    const result = selectCoordinatorAgentForTask({ task, agents: [readOnly, acpDisabled, wrongRole] });

    assert.equal(result.agent, null);
    assert.equal(result.templateId, 'backend-executor');
  });

  it('returns an assignmentReason when an agent is selected', () => {
    const task = workflowTask({
      role: 'reviewer',
      title: '代码审查',
      description: '审查实现是否满足计划。',
    });
    const reviewer = roomAgent({
      id: 'agent-reviewer',
      agent_id: 'reviewer',
      workflow_role: 'reviewer',
      capabilities: ['review'],
      workspace_policy: { read: ['.'], write: [] },
      tool_policy: { allowed: ['read_files'] },
      acp_permission_mode: 'read-only',
    });

    const result = selectCoordinatorAgentForTask({ task, agents: [reviewer] });

    assert.equal(result.agent?.id, 'agent-reviewer');
    assert.equal(result.templateId, null);
    assert.equal(typeof result.assignmentReason, 'string');
    assert.ok(result.assignmentReason.length > 0);
  });
});

function workflowTask(overrides: Partial<CoordinatorWorkflowTask>): CoordinatorWorkflowTask {
  return {
    role: 'executor',
    title: '实现任务',
    description: '',
    scope_read: [],
    scope_write: [],
    required_capabilities: [],
    ...overrides,
  };
}

function roomAgent(overrides: Partial<RoomAgent>): RoomAgent {
  return {
    id: 'agent-1',
    room_id: 'room-1',
    global_agent_id: null,
    agent_id: 'backend-executor',
    agent_name: 'Backend Executor',
    agent_role: null,
    preferred_user_name: null,
    personality: null,
    rules: null,
    responsibilities: null,
    workflow_role: 'executor',
    joined_at: 1,
    left_at: null,
    acp_enabled: 1,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'workspace-write',
    acp_writable_dirs: [],
    capabilities: ['backend'],
    default_runtime: 'acp',
    runtime_backend: 'acp',
    tool_policy: { allowed: ['read_files', 'write_files'] },
    workspace_policy: { read: ['.'], write: ['packages/backend'] },
    memory_scope: 'project',
    memory_max_context_chars: null,
    ...overrides,
  };
}
