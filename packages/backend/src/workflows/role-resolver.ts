import type { RoomAgent, Task, WorkflowRole } from '../types.js';

interface WorkflowAgentSelectionContext {
  task?: Pick<Task, 'title' | 'description' | 'assigned_agent_id'> | null;
  scopeRead?: string[];
  scopeWrite?: string[];
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

  return rankByDomain(candidates, inferDomainHint(context))[0] ?? null;
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

export function isExecutableAgent(agent: RoomAgent): boolean {
  return agent.left_at === null && agent.acp_enabled === 1 && Boolean(agent.acp_backend);
}

function rankByDomain(agents: RoomAgent[], domain: DomainHint): RoomAgent[] {
  if (!domain) return agents;
  return [...agents].sort((a, b) => scoreDomain(b, domain) - scoreDomain(a, domain));
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
