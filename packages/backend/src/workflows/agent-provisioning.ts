import type { ParsedPlanTask } from './plan-parser.js';
import { roomAgentRepo } from '../repos/rooms.js';
import type { RoomAgent, WorkflowRole } from '../types.js';

type TaskDomain = 'frontend' | 'backend' | null;

interface WorkflowAgentProvisioningInput {
  roomId: string;
  agents: RoomAgent[];
  planTasks?: ParsedPlanTask[];
  roles?: WorkflowRole[];
}

const ROLE_TEMPLATE_IDS: Partial<Record<WorkflowRole, string>> = {
  planner: 'planner',
  reviewer: 'reviewer',
  acceptor: 'acceptor',
};

export function ensureWorkflowAgentsForRun(input: WorkflowAgentProvisioningInput): RoomAgent[] {
  const templateIds = new Set<string>();
  for (const role of input.roles ?? []) {
    const templateId = ROLE_TEMPLATE_IDS[role];
    if (templateId) templateIds.add(templateId);
  }
  for (const task of input.planTasks ?? []) {
    if (task.suggestedRole !== 'executor') continue;
    templateIds.add(templateIdForPlanTask(task));
  }

  let agents = input.agents;
  for (const templateId of templateIds) {
    if (hasBuiltInAgent(agents, templateId)) continue;
    const agent = roomAgentRepo.ensureBuiltInAgent(input.roomId, templateId);
    agents = replaceOrAppendAgent(agents, agent);
  }
  return agents;
}

function templateIdForPlanTask(task: ParsedPlanTask): string {
  return inferTaskDomain(task) === 'frontend' ? 'frontend-executor' : 'backend-executor';
}

function inferTaskDomain(task: ParsedPlanTask): TaskDomain {
  const text = [
    task.title,
    task.description,
    ...task.scopeRead,
    ...task.scopeWrite,
  ].join('\n').toLowerCase();
  const frontend = countSignals(text, [
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
  const backend = countSignals(text, [
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
  if (frontend === 0 && backend === 0) return null;
  return frontend > backend ? 'frontend' : 'backend';
}

function countSignals(text: string, signals: string[]): number {
  return signals.reduce((count, signal) => count + (text.includes(signal) ? 1 : 0), 0);
}

function hasBuiltInAgent(agents: RoomAgent[], templateId: string): boolean {
  return agents.some((agent) => agent.left_at === null && agent.agent_id === templateId);
}

function replaceOrAppendAgent(agents: RoomAgent[], agent: RoomAgent): RoomAgent[] {
  const index = agents.findIndex((item) => item.id === agent.id || item.agent_id === agent.agent_id);
  if (index < 0) return [...agents, agent];
  const next = [...agents];
  next[index] = agent;
  return next;
}
