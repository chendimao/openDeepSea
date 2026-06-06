import { agentRepo } from './repos/agents.js';
import { projectRepo } from './repos/projects.js';
import { settingsRepo } from './repos/settings.js';
import type {
  AcpBackend,
  AcpPermissionMode,
  Agent,
  AgentMemoryScope,
  AgentRuntimeBackend,
  AgentToolPolicy,
  AgentWorkspacePolicy,
} from './types.js';

export interface SessionPlannerRuntime {
  agent: Agent;
  agentId: 'planner';
  backend: AcpBackend;
  backendSource: 'project' | 'builtin';
  projectOverrideBackend: AcpBackend | null;
  permissionMode: AcpPermissionMode;
  runtimeBackend: AgentRuntimeBackend;
  toolPolicy: AgentToolPolicy;
  workspacePolicy: AgentWorkspacePolicy;
  memoryScope: AgentMemoryScope;
}

export function resolveSessionPlannerRuntime(projectId: string): SessionPlannerRuntime {
  const project = projectRepo.get(projectId);
  if (!project) throw new Error('project not found');

  const planner = agentRepo.getByBuiltinKey('planner') ?? agentRepo.getByAgentId('planner');
  if (!planner) throw new Error('system planner agent not found');
  if (!planner.default_acp_backend) throw new Error('system planner ACP backend is not configured');

  const resolution = settingsRepo.resolveForProject(project.id);
  const projectOverrideBackend = resolution?.effective.session_planner_acp_backend ?? null;
  const backend = projectOverrideBackend ?? planner.default_acp_backend;

  return {
    agent: planner,
    agentId: 'planner',
    backend,
    backendSource: projectOverrideBackend ? 'project' : 'builtin',
    projectOverrideBackend,
    permissionMode: planner.default_acp_permission_mode,
    runtimeBackend: planner.default_runtime_backend,
    toolPolicy: planner.default_tool_policy,
    workspacePolicy: planner.default_workspace_policy,
    memoryScope: planner.default_memory_scope,
  };
}

export function buildSessionPlannerRuntimeSnapshot(runtime: SessionPlannerRuntime): string {
  return JSON.stringify({
    agent_id: runtime.agentId,
    agent_global_id: runtime.agent.id,
    backend: runtime.backend,
    backend_source: runtime.backendSource,
    project_override_backend: runtime.projectOverrideBackend,
    permission_mode: runtime.permissionMode,
    runtime_backend: runtime.runtimeBackend,
    tool_policy: runtime.toolPolicy,
    workspace_policy: runtime.workspacePolicy,
    memory_scope: runtime.memoryScope,
  });
}
