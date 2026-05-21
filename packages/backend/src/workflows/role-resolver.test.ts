import test from 'node:test';
import assert from 'node:assert/strict';
import type { RoomAgent, Task } from '../types.js';
import { resolveWorkflowExecutor, selectWorkflowAgentForPlanTask, selectWorkflowAgentForRole } from './role-resolver.js';

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

test('selectWorkflowAgentForPlanTask prefers executor whose writable workspace matches scopeWrite', () => {
  const frontend = agent({
    id: 'frontend',
    workflow_role: 'executor',
    acp_permission_mode: 'workspace-write',
    capabilities: ['backend'],
    tool_policy: { allowed: ['read_files', 'write_files'] },
    workspace_policy: { read: ['.'], write: ['packages/frontend'] },
  });
  const backend = agent({
    id: 'backend',
    workflow_role: 'executor',
    acp_permission_mode: 'workspace-write',
    capabilities: ['frontend'],
    tool_policy: { allowed: ['read_files', 'write_files'] },
    workspace_policy: { read: ['.'], write: ['packages/backend'] },
  });

  const selected = selectWorkflowAgentForPlanTask('executor', [backend, frontend], {
    title: '修改 React 页面',
    description: '更新组件',
    scopeRead: ['packages/frontend/src/pages/RoomPage.tsx'],
    scopeWrite: ['packages/frontend/src/pages/RoomPage.tsx'],
  });

  assert.equal(selected?.id, 'frontend');
});

test('selectWorkflowAgentForRole allows read-only reviewer for review role', () => {
  const reviewer = agent({
    id: 'reviewer',
    workflow_role: 'reviewer',
    acp_permission_mode: 'read-only',
    workspace_policy: { read: ['.'], write: [] },
    tool_policy: { allowed: ['read_files'] },
  });

  assert.equal(selectWorkflowAgentForRole('reviewer', [reviewer])?.id, 'reviewer');
});

test('selectWorkflowAgentForPlanTask downgrades executor without write tools', () => {
  const noWriteTools = agent({
    id: 'no-write-tools',
    workflow_role: 'executor',
    capabilities: ['backend'],
    tool_policy: { allowed: ['read_files'] },
    workspace_policy: { read: ['.'], write: ['packages/backend'] },
  });
  const writable = agent({
    id: 'writable',
    workflow_role: 'executor',
    capabilities: ['backend'],
    tool_policy: { allowed: ['read_files', 'write_files'] },
    workspace_policy: { read: ['.'], write: ['packages/backend'] },
  });

  const selected = selectWorkflowAgentForPlanTask('executor', [noWriteTools, writable], {
    title: '修改 API 路由',
    description: '更新后端实现',
    scopeRead: ['packages/backend/src/routes.ts'],
    scopeWrite: ['packages/backend/src/routes.ts'],
  });

  assert.equal(selected?.id, 'writable');
});

test('selectWorkflowAgentForPlanTask treats root writable workspace as matching any project scope', () => {
  const rootWritable = agent({
    id: 'root-writable',
    workflow_role: 'executor',
    acp_permission_mode: 'workspace-write',
    capabilities: [],
    tool_policy: { allowed: ['read_files', 'write_files'] },
    workspace_policy: { read: ['.'], write: ['.'] },
  });
  const noWorkspace = agent({
    id: 'no-workspace',
    workflow_role: 'executor',
    capabilities: ['backend'],
    workspace_policy: { read: ['.'], write: [] },
  });

  const selected = selectWorkflowAgentForPlanTask('executor', [noWorkspace, rootWritable], {
    title: '修改 API 路由',
    description: '更新后端实现',
    scopeRead: ['packages/backend/src/routes.ts'],
    scopeWrite: ['packages/backend/src/routes.ts'],
  });

  assert.equal(selected?.id, 'root-writable');
});

test('selectWorkflowAgentForPlanTask treats root write scope as matching root writable workspace', () => {
  const rootWritable = agent({
    id: 'root-writable',
    workflow_role: 'executor',
    acp_permission_mode: 'workspace-write',
    capabilities: [],
    tool_policy: { allowed: ['read_files', 'write_files'] },
    workspace_policy: { read: ['.'], write: ['.'] },
  });
  const backendOnly = agent({
    id: 'backend-only',
    workflow_role: 'executor',
    acp_permission_mode: 'workspace-write',
    capabilities: ['backend'],
    tool_policy: { allowed: ['read_files', 'write_files'] },
    workspace_policy: { read: ['.'], write: ['packages/backend'] },
  });

  const selected = selectWorkflowAgentForPlanTask('executor', [backendOnly, rootWritable], {
    title: '修改项目根配置',
    description: '更新根目录配置',
    scopeRead: ['.'],
    scopeWrite: ['.'],
  });

  assert.equal(selected?.id, 'root-writable');
});

test('selectWorkflowAgentForPlanTask treats absolute project root scope as broad project write scope', () => {
  const backend = agent({
    id: 'backend',
    workflow_role: 'executor',
    acp_permission_mode: 'workspace-write',
    capabilities: ['backend'],
    tool_policy: { allowed: ['read_files', 'write_files'] },
    workspace_policy: { read: ['.'], write: ['packages/backend'] },
  });
  const frontend = agent({
    id: 'frontend',
    workflow_role: 'executor',
    acp_permission_mode: 'workspace-write',
    capabilities: ['frontend'],
    tool_policy: { allowed: ['read_files', 'write_files'] },
    workspace_policy: { read: ['.'], write: ['packages/frontend'] },
  });

  const selected = selectWorkflowAgentForPlanTask('executor', [frontend, backend], {
    title: '实现后端资源查询、筛选、搜索与详情能力',
    description: '在后端落地统一资源库能力',
    scopeRead: ['/Users/chendimao/WWW/openDeepSea'],
    scopeWrite: ['/Users/chendimao/WWW/openDeepSea'],
  });

  assert.equal(selected?.id, 'backend');
});

test('selectWorkflowAgentForPlanTask uses frontend domain when absolute project root scope is broad', () => {
  const backend = agent({
    id: 'backend',
    workflow_role: 'executor',
    acp_permission_mode: 'workspace-write',
    capabilities: ['backend'],
    tool_policy: { allowed: ['read_files', 'write_files'] },
    workspace_policy: { read: ['.'], write: ['packages/backend'] },
  });
  const frontend = agent({
    id: 'frontend',
    workflow_role: 'executor',
    acp_permission_mode: 'workspace-write',
    capabilities: ['frontend'],
    tool_policy: { allowed: ['read_files', 'write_files'] },
    workspace_policy: { read: ['.'], write: ['packages/frontend'] },
  });

  const selected = selectWorkflowAgentForPlanTask('executor', [backend, frontend], {
    title: '实现资源库列表 UI 的类型区分、筛选和搜索',
    description: '在前端资源库中展示不同资源类型和来源，并提供筛选入口。',
    scopeRead: ['/Users/chendimao/WWW/openDeepSea'],
    scopeWrite: ['/Users/chendimao/WWW/openDeepSea'],
  });

  assert.equal(selected?.id, 'frontend');
});

test('selectWorkflowAgentForPlanTask prioritizes workspace match over domain signals for write tasks', () => {
  const domainOnly = agent({
    id: 'domain-only',
    workflow_role: 'executor',
    acp_permission_mode: 'workspace-write',
    capabilities: ['backend'],
    tool_policy: { allowed: ['read_files', 'write_files'] },
    workspace_policy: { read: ['.'], write: ['packages/frontend'] },
  });
  const workspaceMatch = agent({
    id: 'workspace-match',
    workflow_role: 'executor',
    acp_permission_mode: 'workspace-write',
    capabilities: [],
    tool_policy: { allowed: ['read_files', 'write_files'] },
    workspace_policy: { read: ['.'], write: ['packages/backend'] },
  });

  const selected = selectWorkflowAgentForPlanTask('executor', [domainOnly, workspaceMatch], {
    title: '修改后端接口',
    description: '更新 Express route',
    scopeRead: ['packages/backend/src/routes.ts'],
    scopeWrite: ['packages/backend/src/routes.ts'],
  });

  assert.equal(selected?.id, 'workspace-match');
});

test('selectWorkflowAgentForPlanTask falls back to domain when scopeWrite contains non-path descriptions', () => {
  const backend = agent({
    id: 'backend',
    workflow_role: 'executor',
    acp_permission_mode: 'workspace-write',
    capabilities: ['backend', 'testing'],
    tool_policy: { allowed: ['read_files', 'write_files', 'run_shell'] },
    workspace_policy: { read: ['.'], write: ['packages/backend'] },
  });
  const frontend = agent({
    id: 'frontend',
    workflow_role: 'executor',
    acp_permission_mode: 'workspace-write',
    capabilities: ['frontend', 'testing'],
    tool_policy: { allowed: ['read_files', 'write_files', 'run_shell'] },
    workspace_policy: { read: ['.'], write: ['packages/frontend'] },
  });

  const selected = selectWorkflowAgentForPlanTask('executor', [backend, frontend], {
    title: '实现资源资产后端模型与接口',
    description: '在后端建立或扩展资源资产持久化能力，为文件管理页和自动归档流程提供统一查询、创建、删除、详情接口。',
    scopeRead: ['后端路由/API 层', '数据库访问层', '现有文件上传接口'],
    scopeWrite: ['资源资产表或现有表扩展', '资源列表接口', '资源详情接口', '资源删除接口', '资源创建/归档内部服务'],
  });

  assert.equal(selected?.id, 'backend');
});

test('selectWorkflowAgentForPlanTask selects technical writer for absolute docs markdown scope', () => {
  const backend = agent({
    id: 'backend',
    workflow_role: 'executor',
    acp_permission_mode: 'workspace-write',
    capabilities: ['backend', 'testing'],
    tool_policy: { allowed: ['read_files', 'write_files', 'run_shell'] },
    workspace_policy: { read: ['.'], write: ['packages/backend'] },
  });
  const writer = agent({
    id: 'writer',
    agent_id: 'technical-writer',
    agent_name: '技术写作者',
    workflow_role: 'executor',
    acp_permission_mode: 'workspace-write',
    capabilities: ['documentation', 'writing'],
    tool_policy: { allowed: ['read_files', 'write_files', 'run_shell'] },
    workspace_policy: { read: ['.'], write: ['docs'] },
  });

  const selected = selectWorkflowAgentForPlanTask('executor', [backend, writer], {
    title: '创建 Superpowers E2E 冒烟验证文档',
    description: '新增 Markdown 文档记录浏览器端到端测试、代码审查和验收结论。',
    scopeRead: ['/Users/chendimao/WWW/openDeepSea/docs/superpowers/verification/'],
    scopeWrite: ['/Users/chendimao/WWW/openDeepSea/docs/superpowers/verification/superpower-e2e-smoke.md'],
  });

  assert.equal(selected?.id, 'writer');
});

test('selectWorkflowAgentForPlanTask requires explicit write capability and non-read-only permission for write tasks', () => {
  const implicitToolPolicy = agent({
    id: 'implicit-tool-policy',
    workflow_role: 'executor',
    acp_permission_mode: 'workspace-write',
    tool_policy: null,
    workspace_policy: { read: ['.'], write: ['packages/backend'] },
  });
  const readOnly = agent({
    id: 'read-only',
    workflow_role: 'executor',
    acp_permission_mode: 'read-only',
    tool_policy: { allowed: ['read_files', 'write_files'] },
    workspace_policy: { read: ['.'], write: ['packages/backend'] },
  });
  const writable = agent({
    id: 'writable',
    workflow_role: 'executor',
    acp_permission_mode: 'workspace-write',
    tool_policy: { allowed: ['read_files', 'write_files'] },
    workspace_policy: { read: ['.'], write: ['packages/backend'] },
  });

  const selected = selectWorkflowAgentForPlanTask('executor', [implicitToolPolicy, readOnly, writable], {
    title: '修改 API 路由',
    description: '更新后端实现',
    scopeRead: ['packages/backend/src/routes.ts'],
    scopeWrite: ['packages/backend/src/routes.ts'],
  });

  assert.equal(selected?.id, 'writable');
});

test('selectWorkflowAgentForPlanTask returns null when write task has no writable executor', () => {
  const noWorkspace = agent({
    id: 'no-workspace',
    workflow_role: 'executor',
    acp_permission_mode: 'workspace-write',
    capabilities: ['backend'],
    tool_policy: { allowed: ['read_files', 'write_files'] },
    workspace_policy: { read: ['.'], write: [] },
  });
  const readOnly = agent({
    id: 'read-only',
    workflow_role: 'executor',
    acp_permission_mode: 'read-only',
    capabilities: ['backend'],
    tool_policy: { allowed: ['read_files', 'write_files'] },
    workspace_policy: { read: ['.'], write: ['packages/backend'] },
  });

  const selected = selectWorkflowAgentForPlanTask('executor', [noWorkspace, readOnly], {
    title: '修改 API 路由',
    description: '更新后端实现',
    scopeRead: ['packages/backend/src/routes.ts'],
    scopeWrite: ['packages/backend/src/routes.ts'],
  });

  assert.equal(selected, null);
});

test('selectWorkflowAgentForPlanTask requires writable workspace to cover every scopeWrite path', () => {
  const backendOnly = agent({
    id: 'backend-only',
    workflow_role: 'executor',
    acp_permission_mode: 'workspace-write',
    capabilities: ['backend'],
    tool_policy: { allowed: ['read_files', 'write_files'] },
    workspace_policy: { read: ['.'], write: ['packages/backend'] },
  });
  const fullStack = agent({
    id: 'full-stack',
    workflow_role: 'executor',
    acp_permission_mode: 'workspace-write',
    capabilities: ['backend', 'frontend'],
    tool_policy: { allowed: ['read_files', 'write_files'] },
    workspace_policy: { read: ['.'], write: ['packages/backend', 'packages/frontend'] },
  });

  const selected = selectWorkflowAgentForPlanTask('executor', [backendOnly, fullStack], {
    title: '修改前后端联动',
    description: '同时更新 API 和页面',
    scopeRead: ['packages/backend/src/routes.ts', 'packages/frontend/src/pages/RoomPage.tsx'],
    scopeWrite: ['packages/backend/src/routes.ts', 'packages/frontend/src/pages/RoomPage.tsx'],
  });

  assert.equal(selected?.id, 'full-stack');
});

test('selectWorkflowAgentForPlanTask rejects parent-directory path segments in scopeWrite matching', () => {
  const backendOnly = agent({
    id: 'backend-only',
    workflow_role: 'executor',
    acp_permission_mode: 'workspace-write',
    capabilities: ['backend'],
    tool_policy: { allowed: ['read_files', 'write_files'] },
    workspace_policy: { read: ['.'], write: ['packages/backend'] },
  });

  const selected = selectWorkflowAgentForPlanTask('executor', [backendOnly], {
    title: '修改伪装路径',
    description: '不能通过 .. 绕过 workspace',
    scopeRead: ['packages/backend/../frontend/src/pages/RoomPage.tsx'],
    scopeWrite: ['packages/backend/../frontend/src/pages/RoomPage.tsx'],
  });

  assert.equal(selected, null);
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
    runtime_backend: patch.runtime_backend ?? null,
    tool_policy: patch.tool_policy ?? null,
    workspace_policy: patch.workspace_policy ?? null,
    memory_scope: patch.memory_scope ?? null,
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
