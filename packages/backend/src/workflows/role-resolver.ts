import type { RoomAgent, Task, WorkflowRole } from '../types.js';

interface WorkflowAgentSelectionContext {
  task?: Pick<Task, 'title' | 'description' | 'assigned_agent_id'> | null;
  scopeRead?: string[];
  scopeWrite?: string[];
}

export interface WorkflowPlanTaskSelectionContext {
  title: string;
  description: string;
  scopeRead: string[];
  scopeWrite: string[];
}

type DomainHint = 'frontend' | 'backend' | null;

export function selectWorkflowAgentForRole(
  role: WorkflowRole,
  agents: RoomAgent[],
  context: WorkflowAgentSelectionContext = {},
): RoomAgent | null {
  const executableAgents = agents.filter(isExecutableAgent);
  const exact = executableAgents.filter((agent) => agent.workflow_role === role);
  const candidates = exact.length > 0
    ? exact
    : role !== 'executor'
      ? executableAgents.filter((agent) => agent.workflow_role === 'executor')
      : [];
  if (candidates.length === 0) return null;

  return rankCandidates(candidates, role, context)[0] ?? null;
}

export function resolveWorkflowExecutor(
  agents: RoomAgent[],
  task: Pick<Task, 'title' | 'description' | 'assigned_agent_id'>,
): RoomAgent | null {
  if (task.assigned_agent_id) {
    const assigned = agents.find((agent) => agent.id === task.assigned_agent_id) ?? null;
    return assigned && isExecutableAgent(assigned) ? assigned : null;
  }
  return selectWorkflowAgentForRole('executor', agents, { task });
}

export function selectWorkflowAgentForPlanTask(
  role: WorkflowRole,
  agents: RoomAgent[],
  planTask: WorkflowPlanTaskSelectionContext,
): RoomAgent | null {
  return selectWorkflowAgentForRole(role, agents, {
    task: {
      title: planTask.title,
      description: planTask.description,
      assigned_agent_id: null,
    },
    scopeRead: planTask.scopeRead,
    scopeWrite: planTask.scopeWrite,
  });
}

export function isExecutableAgent(agent: RoomAgent): boolean {
  return agent.left_at === null && agent.acp_enabled === 1 && Boolean(agent.acp_backend);
}

function rankCandidates(
  agents: RoomAgent[],
  role: WorkflowRole,
  context: WorkflowAgentSelectionContext,
): RoomAgent[] {
  const scopeWrite = context.scopeWrite ?? [];
  if (role === 'executor' && scopeWrite.length > 0) {
    const writableMatches = agents.filter((agent) =>
      scoreWorkspaceWrite(agent, scopeWrite) > 0 && scoreExecutableRuntime(agent, role, true) > 0,
    );
    agents = writableMatches;
  }
  const domain = inferDomainHint(context);
  return [...agents].sort((a, b) => scoreAgent(b, role, context, domain) - scoreAgent(a, role, context, domain));
}

function scoreAgent(
  agent: RoomAgent,
  role: WorkflowRole,
  context: WorkflowAgentSelectionContext,
  domain: DomainHint,
): number {
  const scopeWrite = context.scopeWrite ?? [];
  const writeMatch = scoreWorkspaceWrite(agent, scopeWrite);
  const writeRequired = role === 'executor' && scopeWrite.length > 0;
  const executableRuntime = scoreExecutableRuntime(agent, role, writeRequired);
  return (
    (agent.workflow_role === role ? 100 : 0)
    + scoreCapability(agent, domain) * 20
    + writeMatch * 30
    + (domain ? scoreDomain(agent, domain) * 10 : 0)
    + executableRuntime * 50
  );
}

function scoreCapability(agent: RoomAgent, domain: DomainHint): number {
  if (!domain) return 0;
  return agent.capabilities.some((capability) => capability.toLowerCase().includes(domain)) ? 1 : 0;
}

function scoreExecutableRuntime(agent: RoomAgent, role: WorkflowRole, writeRequired: boolean): number {
  if (role === 'reviewer' || role === 'acceptor') return 1;
  if (!writeRequired) return 1;
  const hasWriteTool = agent.tool_policy?.allowed.includes('write_files') ?? false;
  const hasWritableWorkspace = (agent.workspace_policy?.write.length ?? 0) > 0;
  const hasWritePermission = agent.acp_permission_mode !== 'read-only';
  return hasWriteTool && hasWritableWorkspace && hasWritePermission ? 1 : 0;
}

function scoreWorkspaceWrite(agent: RoomAgent, scopeWrite: string[]): number {
  if (scopeWrite.length === 0) return 0;
  const writableScopes = agent.workspace_policy?.write ?? [];
  if (writableScopes.length === 0) return 0;
  return scopeWrite.every((scope) => writableScopes.some((writable) => pathMatchesScope(scope, writable))) ? 1 : 0;
}

function pathMatchesScope(scope: string, writable: string): boolean {
  const normalizedScope = normalizePath(scope);
  const normalizedWritable = normalizePath(writable);
  if (normalizedScope === null || normalizedWritable === null) return false;
  if (!normalizedScope) return !normalizedWritable;
  if (!normalizedWritable) return true;
  return normalizedScope === normalizedWritable || normalizedScope.startsWith(`${normalizedWritable}/`);
}

function scoreDomain(agent: RoomAgent, domain: Exclude<DomainHint, null>): number {
  const haystack = [
    agent.agent_id,
    agent.agent_name,
    agent.agent_role ?? '',
    agent.responsibilities ?? '',
    ...agent.capabilities,
  ].join(' ').toLowerCase();
  return haystack.includes(domain) ? 1 : 0;
}

function inferDomainHint(context: WorkflowAgentSelectionContext): DomainHint {
  const text = [
    context.task?.title ?? '',
    context.task?.description ?? '',
    ...(context.scopeRead ?? []),
    ...(context.scopeWrite ?? []),
  ].join('\n').toLowerCase();

  const frontendScore = countSignals(text, [
    'frontend',
    'front-end',
    'react',
    'tsx',
    'jsx',
    'vite',
    'tailwind',
    'packages/frontend',
    'src/pages',
    'src/components',
    '前端',
    '界面',
    '页面',
    '组件',
    '交互',
  ]);
  const backendScore = countSignals(text, [
    'backend',
    'back-end',
    'express',
    'sqlite',
    'api',
    'route',
    'routes',
    'repo',
    'repos',
    'database',
    'packages/backend',
    '后端',
    '接口',
    '数据库',
    '路由',
    '仓储',
  ]);

  if (frontendScore === 0 && backendScore === 0) return null;
  return frontendScore > backendScore ? 'frontend' : 'backend';
}

function countSignals(text: string, signals: string[]): number {
  return signals.reduce((count, signal) => count + (text.includes(signal) ? 1 : 0), 0);
}

function normalizePath(path: string): string | null {
  const trimmed = path.trim();
  if (trimmed.split(/[\\/]+/).includes('..')) return null;
  const normalized = trimmed.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '').toLowerCase();
  return normalized === '.' ? '' : normalized;
}
