import type { RoomAgent, WorkflowRole } from '../../types.js';

export type CoordinatorTaskRole = Extract<WorkflowRole, 'executor' | 'reviewer' | 'acceptor'>;

export interface CoordinatorWorkflowTask {
  role: CoordinatorTaskRole;
  title: string;
  description: string;
  scope_read: string[];
  scope_write: string[];
  required_capabilities: string[];
}

export interface SelectCoordinatorAgentInput {
  task: CoordinatorWorkflowTask;
  agents: RoomAgent[];
}

export interface CoordinatorAgentSelection {
  agent: RoomAgent | null;
  templateId: string | null;
  assignmentReason: string;
}

export type SuperpowersAgentRole = 'implementer' | 'spec_reviewer' | 'code_quality_reviewer';

export interface SuperpowersAgentSelectionInput {
  role: SuperpowersAgentRole;
  agents: RoomAgent[];
  task?: CoordinatorWorkflowTask;
}

export interface SuperpowersAgentSelection extends CoordinatorAgentSelection {
  workflowRole: CoordinatorTaskRole;
  promptTemplateId: 'tdd-implementer' | 'spec-reviewer' | 'code-reviewer';
  metadata: {
    reviewStage?: 'spec_compliance_review' | 'code_quality_review';
  };
}

type TaskDomain = 'frontend' | 'backend' | null;

export function selectCoordinatorAgentForTask(input: SelectCoordinatorAgentInput): CoordinatorAgentSelection {
  const candidates = input.agents.filter((agent) => agentCanExecuteWorkflowTask(agent, input.task));
  if (candidates.length > 0) {
    const agent = rankAgents(candidates, input.task)[0] ?? null;
    if (agent) {
      return {
        agent,
        templateId: null,
        assignmentReason: buildSelectedAssignmentReason(agent, input.task),
      };
    }
  }

  const templateId = requiredTemplateIdForTask(input.task);
  return {
    agent: null,
    templateId,
    assignmentReason: `No matching in-room agent; suggest built-in template ${templateId}.`,
  };
}

export function requiredTemplateIdForTask(task: CoordinatorWorkflowTask): string {
  if (task.role === 'reviewer') return 'reviewer';
  if (task.role === 'acceptor') return 'acceptor';
  return inferTaskDomain(task) === 'frontend' ? 'frontend-executor' : 'backend-executor';
}

export function selectSuperpowersAgentForRole(input: SuperpowersAgentSelectionInput): SuperpowersAgentSelection {
  const workflowRole = superpowersWorkflowRole(input.role);
  const promptTemplateId = superpowersPromptTemplateId(input.role);
  const metadata = superpowersSelectionMetadata(input.role);
  const task = input.task ?? defaultSuperpowersTask(workflowRole);
  const selection = selectCoordinatorAgentForTask({
    task: {
      ...task,
      role: workflowRole,
    },
    agents: input.agents,
  });

  return {
    ...selection,
    workflowRole,
    promptTemplateId,
    metadata,
  };
}

export function agentCanExecuteWorkflowTask(agent: RoomAgent, task: CoordinatorWorkflowTask): boolean {
  if (agent.left_at !== null) return false;
  if (agent.acp_enabled !== 1 || !agent.acp_backend) return false;
  if (agent.workflow_role !== task.role) return false;
  if (!agentHasRequiredCapabilities(agent, task.required_capabilities)) return false;
  if (task.role !== 'executor') return true;
  return agentCanWriteTaskScope(agent, task.scope_write);
}

function rankAgents(agents: RoomAgent[], task: CoordinatorWorkflowTask): RoomAgent[] {
  const domain = inferTaskDomain(task);
  return [...agents].sort((a, b) => scoreAgent(b, task, domain) - scoreAgent(a, task, domain));
}

function scoreAgent(agent: RoomAgent, task: CoordinatorWorkflowTask, domain: TaskDomain): number {
  return (
    scoreCapability(agent, task.required_capabilities) * 20
    + (domain && agentMatchesDomain(agent, domain) ? 15 : 0)
    + (agentMatchesTemplate(agent, requiredTemplateIdForTask(task)) ? 10 : 0)
    + (agent.workspace_policy?.write.length ?? agent.acp_writable_dirs.length) * 2
  );
}

function buildSelectedAssignmentReason(agent: RoomAgent, task: CoordinatorWorkflowTask): string {
  const reasons = [
    `Selected in-room agent ${agent.agent_name || agent.agent_id}`,
    `workflow role ${task.role}`,
    'ACP enabled',
  ];
  if (task.role === 'executor' && task.scope_write.filter(isPathLikeScope).length > 0) {
    reasons.push('write boundary matched');
  }
  const domain = inferTaskDomain(task);
  if (domain && agentMatchesDomain(agent, domain)) {
    reasons.push(`${domain} capability matched`);
  }
  return `${reasons.join('; ')}.`;
}

function agentHasRequiredCapabilities(agent: RoomAgent, requiredCapabilities: string[]): boolean {
  const normalizedRequired = requiredCapabilities.map(normalizeText).filter(Boolean);
  if (normalizedRequired.length === 0) return true;
  const haystack = [
    agent.agent_id,
    agent.agent_name,
    agent.agent_role ?? '',
    agent.responsibilities ?? '',
    ...agent.capabilities,
  ].join(' ').toLowerCase();
  return normalizedRequired.every((capability) => haystack.includes(capability));
}

function scoreCapability(agent: RoomAgent, requiredCapabilities: string[]): number {
  if (requiredCapabilities.length === 0) return 0;
  const normalizedRequired = requiredCapabilities.map(normalizeText).filter(Boolean);
  if (normalizedRequired.length === 0) return 0;
  const haystack = [
    agent.agent_id,
    agent.agent_name,
    agent.agent_role ?? '',
    agent.responsibilities ?? '',
    ...agent.capabilities,
  ].join(' ').toLowerCase();
  return normalizedRequired.filter((capability) => haystack.includes(capability)).length / normalizedRequired.length;
}

function agentCanWriteTaskScope(agent: RoomAgent, scopeWrite: string[]): boolean {
  const pathScopeWrite = scopeWrite.filter(isPathLikeScope);
  if (pathScopeWrite.length === 0) return true;
  if (agent.acp_permission_mode === 'read-only') return false;
  if (!(agent.tool_policy?.allowed.includes('write_files') ?? false)) return false;
  const writableScopes = [
    ...(agent.workspace_policy?.write ?? []),
    ...agent.acp_writable_dirs,
  ];
  if (writableScopes.length === 0) return false;
  return pathScopeWrite.every((scope) =>
    writableScopes.some((writable) => pathMatchesScope(scope, writable)),
  );
}

function inferTaskDomain(task: CoordinatorWorkflowTask): TaskDomain {
  const text = [
    task.title,
    task.description,
    ...task.scope_read,
    ...task.scope_write,
    ...task.required_capabilities,
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

function agentMatchesDomain(agent: RoomAgent, domain: Exclude<TaskDomain, null>): boolean {
  const text = [
    agent.agent_id,
    agent.agent_name,
    agent.agent_role ?? '',
    agent.responsibilities ?? '',
    ...agent.capabilities,
  ].join(' ').toLowerCase();
  return text.includes(domain);
}

function agentMatchesTemplate(agent: RoomAgent, templateId: string): boolean {
  return agent.agent_id === templateId || agent.global_agent_id === templateId;
}

function pathMatchesScope(scope: string, writable: string): boolean {
  const normalizedScope = normalizePath(scope);
  const normalizedWritable = normalizePath(writable);
  if (normalizedScope === null || normalizedWritable === null) return false;
  if (!normalizedScope) return !normalizedWritable;
  if (!normalizedWritable) return true;
  return normalizedScope === normalizedWritable || normalizedScope.startsWith(`${normalizedWritable}/`);
}

function normalizePath(path: string): string | null {
  const trimmed = path.trim();
  if (trimmed.split(/[\\/]+/).includes('..')) return null;
  const normalized = trimmed.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '').toLowerCase();
  return normalized === '.' ? '' : normalized;
}

function isPathLikeScope(scope: string): boolean {
  const trimmed = scope.trim();
  if (!trimmed) return false;
  if (trimmed === '.' || trimmed.startsWith('./')) return true;
  if (trimmed === '..' || trimmed.startsWith('../')) return true;
  if (trimmed.startsWith('/') || /^[a-z]:[\\/]/i.test(trimmed)) return true;
  if (trimmed.includes('/') || trimmed.includes('\\')) return isAsciiPathCandidate(trimmed);
  return /^[\w.-]+\.[a-z0-9]+$/i.test(trimmed);
}

function isAsciiPathCandidate(scope: string): boolean {
  return /^[a-z0-9_./\\@+-]+$/i.test(scope);
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function superpowersWorkflowRole(role: SuperpowersAgentRole): CoordinatorTaskRole {
  return role === 'implementer' ? 'executor' : 'reviewer';
}

function superpowersPromptTemplateId(role: SuperpowersAgentRole): SuperpowersAgentSelection['promptTemplateId'] {
  if (role === 'implementer') return 'tdd-implementer';
  return role === 'spec_reviewer' ? 'spec-reviewer' : 'code-reviewer';
}

function superpowersSelectionMetadata(role: SuperpowersAgentRole): SuperpowersAgentSelection['metadata'] {
  if (role === 'spec_reviewer') return { reviewStage: 'spec_compliance_review' };
  if (role === 'code_quality_reviewer') return { reviewStage: 'code_quality_review' };
  return {};
}

function defaultSuperpowersTask(role: CoordinatorTaskRole): CoordinatorWorkflowTask {
  if (role === 'reviewer') {
    return {
      role,
      title: 'Superpowers review',
      description: 'Review implementation using normal room reviewer.',
      scope_read: ['.'],
      scope_write: [],
      required_capabilities: [],
    };
  }
  return {
    role,
    title: 'Superpowers TDD execute',
    description: 'Implement the current plan using normal room executor.',
    scope_read: ['.'],
    scope_write: ['.'],
    required_capabilities: [],
  };
}
