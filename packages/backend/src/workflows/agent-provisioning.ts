import type { ParsedPlanTask } from './plan-parser.js';
import { getBuiltInAgentTemplate } from '../crew-templates.js';
import { roomAgentRepo } from '../repos/rooms.js';
import type { RoomAgent, WorkflowRole } from '../types.js';
import { FULLSTACK_ENGINEER_AGENT_ID } from './fullstack-engineer.js';
import { assignPlanTaskAgent, type AvailableWorkflowAgent } from './agent-assignment.js';

type TaskDomain = 'frontend' | 'backend' | 'documentation' | 'fullstack' | null;

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
    for (const templateId of templateIdsForPlanTask(task)) {
      templateIds.add(templateId);
    }
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
  const requestedTemplateId = input.globalAgentTemplateId?.trim() || null;
  const templateId = requestedTemplateId && getBuiltInAgentTemplate(requestedTemplateId)
    ? requestedTemplateId
    : templateIdForRecoveryContext(input.context ?? {});
  return roomAgentRepo.ensureBuiltInAgent(input.roomId, templateId);
}

function templateIdsForPlanTask(task: ParsedPlanTask): string[] {
  const domain = inferTaskDomain(task);
  if (domain === 'fullstack') {
    return ['frontend-executor', 'backend-executor', FULLSTACK_ENGINEER_AGENT_ID];
  }
  const assignment = assignPlanTaskAgent({
    taskId: task.title,
    title: task.title,
    requiredCapabilities: requiredCapabilitiesForDomain(domain),
    scopeWrite: task.scopeWrite,
    agents: builtInExecutorCandidates(),
  });
  return [assignment.assignedAgentId ?? FULLSTACK_ENGINEER_AGENT_ID];
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
  return templateIdsForPlanTask(task)[0] ?? FULLSTACK_ENGINEER_AGENT_ID;
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
    'ppt',
    'presentation',
    'slide',
    'slides',
    'deck',
    'report',
    '技术文档',
    '文档',
    '说明文档',
    '演示文稿',
    '汇报',
    '报告',
    '交付总结',
    '验证文档',
  ]);
  if (documentation > 0 && (documentation > frontend && documentation > backend || (frontend === 0 && backend === 0))) {
    return 'documentation';
  }
  if (frontend > 0 && backend > 0) return 'fullstack';
  if (frontend === 0 && backend === 0) return null;
  return frontend > backend ? 'frontend' : 'backend';
}

function countSignals(text: string, signals: string[]): number {
  return signals.reduce((count, signal) => count + (hasSignal(text, signal) ? 1 : 0), 0);
}

function hasSignal(text: string, signal: string): boolean {
  if (signal === 'ui' || signal === 'ux') {
    return new RegExp(`(^|[^a-z0-9])${signal}([^a-z0-9]|$)`, 'iu').test(text);
  }
  return text.includes(signal);
}

function requiredCapabilitiesForDomain(domain: TaskDomain): string[] {
  if (domain === null || domain === 'fullstack') return [];
  return [domain];
}

function builtInExecutorCandidates(): AvailableWorkflowAgent[] {
  return [
    {
      id: 'frontend-executor',
      name: '前端执行者',
      provider: 'codex',
      capabilities: ['frontend', 'testing'],
      workflowRoles: ['executor'],
      acpEnabled: true,
      available: true,
      priority: 20,
    },
    {
      id: 'backend-executor',
      name: '后端执行者',
      provider: 'codex',
      capabilities: ['backend', 'testing'],
      workflowRoles: ['executor'],
      acpEnabled: true,
      available: true,
      priority: 20,
    },
    {
      id: 'technical-writer',
      name: '技术写作者',
      provider: 'codex',
      capabilities: ['documentation', 'writing'],
      workflowRoles: ['executor'],
      acpEnabled: true,
      available: true,
      priority: 20,
    },
    {
      id: FULLSTACK_ENGINEER_AGENT_ID,
      name: '全栈工程师',
      provider: 'codex',
      capabilities: ['frontend', 'backend', 'testing', 'integration'],
      workflowRoles: ['executor'],
      acpEnabled: true,
      available: true,
      fallback: true,
      priority: 0,
    },
  ];
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
