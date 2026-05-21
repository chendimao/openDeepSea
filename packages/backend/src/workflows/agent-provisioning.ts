import type { ParsedPlanTask } from './plan-parser.js';
import { roomAgentRepo } from '../repos/rooms.js';
import type { RoomAgent, WorkflowRole } from '../types.js';

type TaskDomain = 'frontend' | 'backend' | 'documentation' | null;

interface WorkflowAgentProvisioningInput {
  roomId: string;
  agents: RoomAgent[];
  planTasks?: ParsedPlanTask[];
  roles?: WorkflowRole[];
}

interface WorkflowAgentProvisioningResult {
  agents: RoomAgent[];
  joinedAgents: RoomAgent[];
}

const ROLE_TEMPLATE_IDS: Partial<Record<WorkflowRole, string>> = {
  planner: 'planner',
  reviewer: 'reviewer',
  acceptor: 'acceptor',
};

export function ensureWorkflowAgentsForRun(input: WorkflowAgentProvisioningInput): WorkflowAgentProvisioningResult {
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
  const joinedAgents: RoomAgent[] = [];
  for (const templateId of templateIds) {
    if (hasBuiltInAgent(agents, templateId)) continue;
    const agent = roomAgentRepo.ensureBuiltInAgent(input.roomId, templateId);
    agents = replaceOrAppendAgent(agents, agent);
    joinedAgents.push(agent);
  }
  return { agents, joinedAgents };
}

export function ensureGlobalExecutorForRecovery(input: {
  roomId: string;
  context?: Record<string, unknown>;
  globalAgentTemplateId?: string | null;
}): RoomAgent {
  const templateId = input.globalAgentTemplateId?.trim() || templateIdForRecoveryContext(input.context ?? {});
  return roomAgentRepo.ensureBuiltInAgent(input.roomId, templateId);
}

function templateIdForPlanTask(task: ParsedPlanTask): string {
  const domain = inferTaskDomain(task);
  if (domain === 'frontend') return 'frontend-executor';
  if (domain === 'documentation') return 'technical-writer';
  return 'backend-executor';
}

function templateIdForRecoveryContext(context: Record<string, unknown>): string {
  const childTask = isRecord(context.childTask) ? context.childTask : {};
  const workflowStep = isRecord(context.workflowStep) ? context.workflowStep : {};
  const task: ParsedPlanTask = {
    title: stringValue(childTask.title),
    description: stringValue(childTask.description),
    priority: 'normal',
    suggestedRole: 'executor',
    scopeRead: stringArray(workflowStep.scopeRead),
    scopeWrite: stringArray(workflowStep.scopeWrite),
    acceptance: [],
    dependsOn: [],
  };
  return templateIdForPlanTask(task);
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
    'ui',
    'ux',
    '前端',
    '详情页',
    '详情弹窗',
    '搜索框',
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
  const documentation = countSignals(text, [
    'documentation',
    'document',
    'docs/',
    'docs\\',
    '.md',
    'markdown',
    'readme',
    '技术文档',
    '文档',
    '说明',
    '交付总结',
    '验证文档',
  ]);
  if (documentation > 0 && (documentation > frontend && documentation > backend || (frontend === 0 && backend === 0))) {
    return 'documentation';
  }
  if (frontend === 0 && backend === 0) return null;
  return frontend > backend ? 'frontend' : 'backend';
}

function countSignals(text: string, signals: string[]): number {
  return signals.reduce((count, signal) => count + (text.includes(signal) ? 1 : 0), 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
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
