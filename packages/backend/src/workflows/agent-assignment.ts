import { FULLSTACK_ENGINEER_AGENT_ID } from './fullstack-engineer.js';

export interface AvailableWorkflowAgent {
  id: string;
  roomAgentId?: string;
  name: string;
  provider: 'codex' | 'claudecode' | 'opencode';
  capabilities: string[];
  workflowRoles: string[];
  acpEnabled: boolean;
  acpPermissionMode?: string | null;
  toolPolicyAllowed?: string[];
  workspaceWrite?: string[];
  available: boolean;
  fallback?: boolean;
  priority?: number;
}

export interface AssignPlanTaskAgentInput {
  taskId: string;
  title: string;
  requiredCapabilities: string[];
  scopeWrite: string[];
  agents: AvailableWorkflowAgent[];
}

export interface PlanTaskAgentAssignment {
  taskId: string;
  assignedAgentId: string | null;
  fallbackAgentIds: string[];
  fallbackReason: string | null;
  executionMode: 'serial' | 'parallel' | 'hybrid';
  scopeWrite: string[];
}

export function assignPlanTaskAgent(input: AssignPlanTaskAgentInput): PlanTaskAgentAssignment {
  const candidates = input.agents.filter((agent) =>
    agent.available &&
    agent.acpEnabled &&
    agent.workflowRoles.includes('executor')
  );
  const fallbackAgentIds = candidates.filter((agent) => agent.fallback).map((agent) => agent.id);
  const specialists = candidates
    .filter((agent) => !isFallbackAgent(agent))
    .map((agent) => ({ agent, score: scoreAgent(agent, input.requiredCapabilities, input.title) }))
    .filter((item) => item.score > 0 && agentCoversCapabilities(item.agent, input.requiredCapabilities))
    .sort((left, right) => right.score - left.score || (right.agent.priority ?? 0) - (left.agent.priority ?? 0));

  const specialist = specialists[0]?.agent;
  if (specialist) {
    return {
      taskId: input.taskId,
      assignedAgentId: specialist.id,
      fallbackAgentIds,
      fallbackReason: null,
      executionMode: 'parallel',
      scopeWrite: [...input.scopeWrite],
    };
  }

  const fullstack = candidates.find((agent) => agent.id === FULLSTACK_ENGINEER_AGENT_ID)
    ?? candidates.find((agent) => agent.fallback);
  if (fullstack) {
    return {
      taskId: input.taskId,
      assignedAgentId: fullstack.id,
      fallbackAgentIds: fallbackAgentIds.includes(fullstack.id) ? fallbackAgentIds : [fullstack.id, ...fallbackAgentIds],
      fallbackReason: '未找到更匹配的专门子代理，使用全栈工程师兜底执行',
      executionMode: input.scopeWrite.length > 1 ? 'serial' : 'parallel',
      scopeWrite: [...input.scopeWrite],
    };
  }

  return {
    taskId: input.taskId,
    assignedAgentId: null,
    fallbackAgentIds: [],
    fallbackReason: '未找到可用执行智能体',
    executionMode: 'serial',
    scopeWrite: [...input.scopeWrite],
  };
}

function isFallbackAgent(agent: AvailableWorkflowAgent): boolean {
  return agent.fallback === true || agent.id === FULLSTACK_ENGINEER_AGENT_ID;
}

function scoreAgent(agent: AvailableWorkflowAgent, requiredCapabilities: string[], title: string): number {
  if (requiredCapabilities.length === 0) return 0;
  const haystack = new Set([
    ...agent.capabilities.map((item) => item.toLowerCase()),
    agent.id.toLowerCase(),
    agent.name.toLowerCase(),
  ]);
  let score = 0;
  for (const capability of requiredCapabilities) {
    if (haystack.has(capability.toLowerCase())) score += 5;
  }
  const lowerTitle = title.toLowerCase();
  for (const token of haystack) {
    if (token.length > 2 && lowerTitle.includes(token)) score += 1;
  }
  return score;
}

function agentCoversCapabilities(agent: AvailableWorkflowAgent, requiredCapabilities: string[]): boolean {
  if (requiredCapabilities.length === 0) return true;
  const haystack = new Set([
    ...agent.capabilities.map((item) => item.toLowerCase()),
    agent.id.toLowerCase(),
    agent.name.toLowerCase(),
  ]);
  return requiredCapabilities.every((capability) => haystack.has(capability.toLowerCase()));
}
