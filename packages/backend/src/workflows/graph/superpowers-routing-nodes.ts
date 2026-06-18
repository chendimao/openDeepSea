import type { WorkflowArtifactVersionType } from '../../types.js';
import {
  assignPlanTaskAgent,
  type AvailableWorkflowAgent,
} from '../agent-assignment.js';
import { inferTaskProfile } from '../task-profile.js';
import type { AgentWorkflowState, SuperpowersSelectedIntent } from './state.js';
export type SuperpowersRoutingPlannerStage =
  | 'intake'
  | 'answer'
  | 'analysis_plan'
  | 'lightweight_plan'
  | 'debug_plan'
  | 'review_plan';

export interface SuperpowersRoutingNodeTools {
  createArtifactVersionDraft(input: {
    workflow_run_id: string;
    artifact_type: WorkflowArtifactVersionType;
    title: string;
    content: string;
    structured_data: Record<string, unknown>;
    created_by_agent_id: string;
  }): { id: string };
  createAssistantMessage(input: {
    workflowRunId: string;
    content: string;
  }): { id: string };
  listAvailableWorkflowAgents?(): AvailableWorkflowAgent[];
  invokePlannerStage?(input: {
    stageId: SuperpowersRoutingPlannerStage;
    state: AgentWorkflowState;
    requiredFields: string[];
    fallbackEvidence: Record<string, unknown>;
  }): Promise<Record<string, unknown> | null>;
}

export function createSuperpowersRoutingNodes(tools: SuperpowersRoutingNodeTools) {
  return {
    async intake(state: AgentWorkflowState): Promise<AgentWorkflowState> {
      const fallbackIntent = inferStateIntent(state);
      const fallbackEvidence = {
        intent: fallbackIntent,
        confidence: fallbackIntent === 'answer' ? 0.7 : 0.6,
        reason: '根据用户消息和 session mode 生成初始路由。',
      };
      const evidence = await invokePlannerStageOrFallback(tools, {
        stageId: 'intake',
        state,
        requiredFields: ['intent', 'confidence', 'reason'],
        fallbackEvidence,
      });
      const plannerIntent = normalizeSelectedIntent(evidence.intent);
      const intent = reconcileExplicitGoalIntent(plannerIntent ?? fallbackIntent, state);
      const routingEvidence = {
        ...evidence,
        intent,
      };
      const artifact = tools.createArtifactVersionDraft({
        workflow_run_id: state.workflowRunId,
        artifact_type: 'intent_routing',
        title: 'Intent Routing',
        content: formatJson(routingEvidence),
        structured_data: routingEvidence,
        created_by_agent_id: 'planner',
      });
      return {
        ...state,
        currentNode: 'intake',
        activeSuperpowersStage: 'intake',
        selectedIntent: intent,
        routingArtifactVersionId: artifact.id,
        status: state.status === 'blocked' ? 'running' : state.status,
        error: state.status === 'blocked' ? null : state.error,
      };
    },

    async routeSkills(state: AgentWorkflowState): Promise<AgentWorkflowState> {
      const intent = inferStateIntent(state);
      return {
        ...state,
        currentNode: 'route_skills',
        activeSuperpowersStage: 'route_skills',
        selectedIntent: intent,
        selectedPath: selectedPathForIntent(intent),
      };
    },

    async answer(state: AgentWorkflowState): Promise<AgentWorkflowState> {
      const fallbackEvidence = {
        answer: `已通过 workflow-first answer 路径处理：${state.userGoal}`,
      };
      const evidence = await invokePlannerStageOrFallback(tools, {
        stageId: 'answer',
        state,
        requiredFields: ['answer'],
        fallbackEvidence,
      });
      const message = tools.createAssistantMessage({
        workflowRunId: state.workflowRunId,
        content: typeof evidence.answer === 'string' && evidence.answer.trim()
          ? evidence.answer.trim()
          : fallbackEvidence.answer,
      });
      return {
        ...state,
        currentNode: 'answer',
        activeSuperpowersStage: 'answer',
        activeAgentRunId: null,
        status: 'completed',
        error: null,
        agentEvents: [
          ...(state.agentEvents ?? []),
          {
            workflowRunId: state.workflowRunId,
            stepId: state.currentStepId ?? 'answer',
            agentRunId: message.id,
            type: 'completed',
            summary: 'Answer path completed',
            createdAt: Date.now(),
          },
        ],
      };
    },

    async analysisPlan(state: AgentWorkflowState): Promise<AgentWorkflowState> {
      const fallbackEvidence = {
        conclusion: '已进入只读分析路径。',
        evidence: [],
        risks: [],
        recommendations: [],
      };
      const evidence = await invokePlannerStageOrFallback(tools, {
        stageId: 'analysis_plan',
        state,
        requiredFields: ['conclusion'],
        fallbackEvidence,
      });
      const artifact = tools.createArtifactVersionDraft({
        workflow_run_id: state.workflowRunId,
        artifact_type: 'analysis',
        title: 'Analysis',
        content: formatJson(evidence),
        structured_data: evidence,
        created_by_agent_id: 'planner',
      });
      return {
        ...state,
        currentNode: 'analysis_plan',
        activeSuperpowersStage: 'analysis_plan',
        analysisArtifactVersionId: artifact.id,
        status: 'completed',
        error: null,
      };
    },

    async lightweightPlan(state: AgentWorkflowState): Promise<AgentWorkflowState> {
      const lightweightDefaults = inferLightweightPlanDefaults(state.userGoal);
      const fallbackPlan = buildSingleTaskPlan({
        goal: state.userGoal,
        summary: '轻量任务走最小执行计划，用户确认后进入执行。',
        taskTitle: '执行轻量任务',
        taskDescription: state.userGoal,
        verificationCommand: lightweightDefaults.verificationCommand,
        verificationReason: lightweightDefaults.verificationReason,
        scopeRead: lightweightDefaults.scopeRead,
        scopeWrite: lightweightDefaults.scopeWrite,
        needsApproval: false,
      });
      const plannerEvidence = await invokePlannerStageOrFallback(tools, {
        stageId: 'lightweight_plan',
        state,
        requiredFields: ['plan'],
        fallbackEvidence: { plan: fallbackPlan },
      });
      const plan = normalizePlannerPlan(plannerEvidence.plan) ?? fallbackPlan;
      const structuredData = {
        ...plan,
        skipFullSpecReason: '轻量任务走最小计划，但仍需用户确认。',
      };
      const artifact = tools.createArtifactVersionDraft({
        workflow_run_id: state.workflowRunId,
        artifact_type: 'lightweight_plan',
        title: 'Lightweight Plan',
        content: formatJson(structuredData),
        structured_data: structuredData,
        created_by_agent_id: 'planner',
      });
      return {
        ...state,
        currentNode: 'lightweight_plan',
        activeSuperpowersStage: 'lightweight_plan',
        draftPlanArtifactVersionId: null,
        approvedPlanArtifactVersionId: null,
        lightweightPlanArtifactVersionId: artifact.id,
        implementationPlanPath: `workflow-artifact:${artifact.id}`,
        planReviewVerdict: 'approved',
        plan,
        workflowPlan: null,
        approval: 'pending',
        status: 'awaiting_approval',
        error: 'Waiting for user confirmation of lightweight plan artifact',
      };
    },

    async debugPlan(state: AgentWorkflowState): Promise<AgentWorkflowState> {
      const fallbackPlan = buildSingleTaskPlan({
        goal: state.userGoal,
        summary: '系统化排查失败并修复根因。',
        taskTitle: '执行系统化调试',
        taskDescription: state.userGoal,
        verificationCommand: 'npm run build',
        verificationReason: 'post-debug verification',
        needsApproval: false,
      });
      const plannerEvidence = await invokePlannerStageOrFallback(tools, {
        stageId: 'debug_plan',
        state,
        requiredFields: ['plan'],
        fallbackEvidence: { plan: fallbackPlan },
      });
      const plan = normalizePlannerPlan(plannerEvidence.plan) ?? fallbackPlan;
      const structuredData = {
        ...plan,
        mode: 'debug',
        reproduction: [],
      };
      const artifact = tools.createArtifactVersionDraft({
        workflow_run_id: state.workflowRunId,
        artifact_type: 'plan',
        title: 'Debug Plan',
        content: formatJson(structuredData),
        structured_data: structuredData,
        created_by_agent_id: 'planner',
      });
      return {
        ...state,
        currentNode: 'debug_plan',
        activeSuperpowersStage: 'debug_plan',
        draftPlanArtifactVersionId: artifact.id,
        approvedPlanArtifactVersionId: null,
        plan,
        approval: 'pending',
        status: 'awaiting_approval',
        error: 'Waiting for user confirmation of debug plan artifact',
      };
    },

    async reviewPlan(state: AgentWorkflowState): Promise<AgentWorkflowState> {
      const fallbackEvidence = {
        goal: state.userGoal,
        mode: 'review_only',
        reviewScope: [],
        verificationRequired: false,
      };
      const structuredData = await invokePlannerStageOrFallback(tools, {
        stageId: 'review_plan',
        state,
        requiredFields: ['goal', 'mode'],
        fallbackEvidence,
      });
      const artifact = tools.createArtifactVersionDraft({
        workflow_run_id: state.workflowRunId,
        artifact_type: 'plan',
        title: 'Review Plan',
        content: formatJson(structuredData),
        structured_data: structuredData,
        created_by_agent_id: 'planner',
      });
      return {
        ...state,
        currentNode: 'review_plan',
        activeSuperpowersStage: 'review_plan',
        draftPlanArtifactVersionId: artifact.id,
      };
    },

    async agentAssignment(state: AgentWorkflowState): Promise<AgentWorkflowState> {
      const agents = tools.listAvailableWorkflowAgents?.() ?? [];
      const assignments = (state.plan?.tasks ?? []).map((task, index) => {
        const taskId = `task-${index + 1}`;
        const requiredCapabilities = inferCapabilities(task);
        const eligibleAgents = agents.filter((agent) => agentCanWriteTask(agent, task.scopeWrite));
        const hintedAgent = selectSupervisorHintedAgent({
          state,
          task,
          requiredCapabilities,
          agents: eligibleAgents,
        });
        const genericAgent = !hintedAgent && requiredCapabilities.length === 0
          ? selectGenericExecutorAgent(eligibleAgents)
          : null;
        const selectedAgent = hintedAgent ?? genericAgent;
        const result = selectedAgent
          ? {
            taskId,
            assignedAgentId: selectedAgent.roomAgentId ?? selectedAgent.id,
            fallbackAgentIds: [],
            fallbackReason: null,
            executionMode: task.scopeWrite.length > 1 ? 'serial' as const : 'parallel' as const,
            scopeWrite: [...task.scopeWrite],
          }
          : assignPlanTaskAgent({
            taskId,
            title: task.title,
            requiredCapabilities,
            scopeWrite: task.scopeWrite,
            agents: eligibleAgents,
          });
        return {
          taskId,
          taskTitle: task.title,
          role: task.suggestedRole,
          assignedAgentId: result.assignedAgentId,
          fallbackAgentIds: result.fallbackAgentIds,
          fallbackReason: result.fallbackReason,
          executionMode: result.executionMode,
          scopeRead: task.scopeRead,
          scopeWrite: result.scopeWrite,
        };
      });
      const missingExecutor = assignments.find((item) => item.role === 'executor' && !item.assignedAgentId);
      const structuredData = { assignments };
      const artifact = tools.createArtifactVersionDraft({
        workflow_run_id: state.workflowRunId,
        artifact_type: 'agent_assignment',
        title: 'Agent Assignment',
        content: formatJson(structuredData),
        structured_data: structuredData,
        created_by_agent_id: 'planner',
      });
      return {
        ...state,
        currentNode: 'agent_assignment',
        activeSuperpowersStage: 'agent_assignment',
        agentAssignmentArtifactVersionId: artifact.id,
        agentAssignments: assignments.map((item) => ({
          taskId: item.taskId,
          assignedAgentId: item.assignedAgentId,
          fallbackAgentIds: item.fallbackAgentIds,
          fallbackReason: item.fallbackReason,
          executionMode: item.executionMode,
          scopeRead: item.scopeRead,
          scopeWrite: item.scopeWrite,
        })),
        status: missingExecutor ? 'blocked' : state.status,
        error: missingExecutor ? 'needs_agent_assignment' : null,
      };
    },

    async passthrough(state: AgentWorkflowState, nodeName: string): Promise<AgentWorkflowState> {
      return {
        ...state,
        currentNode: nodeName as AgentWorkflowState['currentNode'],
        activeSuperpowersStage: nodeName,
      };
    },
  };
}

async function invokePlannerStageOrFallback(
  tools: SuperpowersRoutingNodeTools,
  input: {
    stageId: SuperpowersRoutingPlannerStage;
    state: AgentWorkflowState;
    requiredFields: string[];
    fallbackEvidence: Record<string, unknown>;
  },
): Promise<Record<string, unknown>> {
  if (!tools.invokePlannerStage) return input.fallbackEvidence;
  const evidence = await tools.invokePlannerStage(input);
  if (!evidence) return input.fallbackEvidence;
  const missing = input.requiredFields.filter((field) =>
    !Object.prototype.hasOwnProperty.call(evidence, field)
  );
  return missing.length === 0 ? evidence : input.fallbackEvidence;
}

export function parseRoutingPlannerEvidence(output: string): Record<string, unknown> | null {
  for (const candidate of extractRoutingJsonCandidates(output)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function normalizeSelectedIntent(value: unknown): SuperpowersSelectedIntent | null {
  if (
    value === 'answer' ||
    value === 'analysis_only' ||
    value === 'analysis' ||
    value === 'lightweight_task' ||
    value === 'standard_development' ||
    value === 'debug_plan' ||
    value === 'debug' ||
    value === 'review_only'
  ) {
    if (value === 'debug_plan') return 'debug';
    return value === 'analysis_only' ? 'analysis' : value;
  }
  return null;
}

function selectSupervisorHintedAgent(input: {
  state: AgentWorkflowState;
  task: NonNullable<AgentWorkflowState['plan']>['tasks'][number];
  requiredCapabilities: string[];
  agents: AvailableWorkflowAgent[];
}): AvailableWorkflowAgent | null {
  const sameRoleTaskCount = input.state.plan?.tasks.filter((task) =>
    task.suggestedRole === input.task.suggestedRole
  ).length ?? 0;
  if (sameRoleTaskCount !== 1) return null;
  const hint = (input.state.supervisorAssignments ?? []).find((assignment) =>
    assignment.stage === 'implementation' && assignment.role === input.task.suggestedRole
  );
  if (!hint) return null;
  const agent = input.agents.find((item) =>
    item.roomAgentId === hint.agentId ||
    item.id === hint.agentId
  ) ?? null;
  if (!agent || !isExecutableForRole(agent, input.task.suggestedRole)) return null;
  return agentCoversCapabilities(agent, input.requiredCapabilities) ? agent : null;
}

function selectGenericExecutorAgent(agents: AvailableWorkflowAgent[]): AvailableWorkflowAgent | null {
  return agents
    .filter((agent) => isExecutableForRole(agent, 'executor') && agent.fallback !== true)
    .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0))[0] ?? null;
}

function isExecutableForRole(agent: AvailableWorkflowAgent, role: string): boolean {
  return agent.available && agent.acpEnabled && agent.workflowRoles.includes(role);
}

function agentCanWriteTask(agent: AvailableWorkflowAgent, scopeWrite: string[]): boolean {
  const pathScopes = scopeWrite.map(normalizePathScope).filter((scope): scope is string => scope !== null);
  if (pathScopes.length === 0) return true;
  if (
    agent.acpPermissionMode === undefined &&
    agent.toolPolicyAllowed === undefined &&
    agent.workspaceWrite === undefined
  ) {
    return true;
  }
  if (agent.acpPermissionMode === 'read-only') return false;
  if (!(agent.toolPolicyAllowed ?? []).includes('write_files')) return false;
  const writableScopes = agent.workspaceWrite ?? [];
  if (writableScopes.length === 0) return false;
  return pathScopes.every((scope) =>
    writableScopes.some((writable) => pathMatchesScope(scope, writable))
  );
}

function agentCoversCapabilities(agent: AvailableWorkflowAgent, requiredCapabilities: string[]): boolean {
  if (requiredCapabilities.length === 0) return true;
  const text = [
    agent.id,
    agent.name,
    ...agent.capabilities,
  ].join(' ').toLowerCase();
  return requiredCapabilities.every((capability) => {
    const normalized = capability.toLowerCase();
    if (normalized === 'documentation') {
      return text.includes('documentation') || text.includes('document') || text.includes('writer') || text.includes('文档');
    }
    return text.includes(normalized);
  });
}

function inferCapabilities(task: {
  title: string;
  description: string;
  acceptance?: string[];
  scopeRead: string[];
  scopeWrite: string[];
}): string[] {
  return inferTaskProfile({
    title: task.title,
    description: task.description,
    scopeRead: task.scopeRead,
    scopeWrite: task.scopeWrite,
    acceptance: task.acceptance ?? [],
  }).requiredCapabilities.map(normalizeRequiredCapability);
}

function normalizeRequiredCapability(capability: string): string {
  if (capability === 'document') return 'documentation';
  return capability;
}

function normalizePathScope(scope: string): string | null {
  const trimmed = scope.trim();
  if (trimmed.length === 0) return null;
  if (trimmed === '.') return '';
  if (/^[a-z]+:\/\//iu.test(trimmed)) return null;
  return trimmed.replace(/\\/gu, '/').replace(/\/+/gu, '/').replace(/^\.\/+/u, '');
}

function pathMatchesScope(scope: string, writable: string): boolean {
  const normalizedWritable = normalizePathScope(writable);
  if (normalizedWritable === null || normalizedWritable === '') return true;
  return scope === normalizedWritable || scope.startsWith(`${normalizedWritable}/`);
}

function buildSingleTaskPlan(input: {
  goal: string;
  summary: string;
  taskTitle: string;
  taskDescription: string;
  verificationCommand: string;
  verificationReason: string;
  scopeRead?: string[];
  scopeWrite?: string[];
  needsApproval: boolean;
}): NonNullable<AgentWorkflowState['plan']> {
  return {
    goal: input.goal,
    summary: input.summary,
    assumptions: [],
    tasks: [{
      title: input.taskTitle,
      description: input.taskDescription,
      suggestedRole: 'executor',
      priority: 'normal',
      acceptance: ['完成用户请求并保持现有行为不回退。'],
      scopeRead: input.scopeRead ?? [],
      scopeWrite: input.scopeWrite ?? [],
      dependsOn: [],
    }],
    reviewFocus: [],
    verification: [input.verificationCommand],
    verificationCommands: [{
      command: input.verificationCommand,
      reason: input.verificationReason,
      required: true,
    }],
    risks: [],
    needsApproval: input.needsApproval,
  };
}

function normalizePlannerPlan(value: unknown): NonNullable<AgentWorkflowState['plan']> | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<NonNullable<AgentWorkflowState['plan']>>;
  if (typeof candidate.goal !== 'string' || typeof candidate.summary !== 'string') return null;
  if (!Array.isArray(candidate.tasks) || candidate.tasks.length === 0) return null;
  const tasks = candidate.tasks.map((task) => normalizePlannerTask(task)).filter((task): task is NonNullable<AgentWorkflowState['plan']>['tasks'][number] => task !== null);
  if (tasks.length === 0) return null;
  const verificationCommands = Array.isArray(candidate.verificationCommands)
    ? candidate.verificationCommands
      .map((command) => normalizeVerificationCommand(command))
      .filter((command): command is NonNullable<AgentWorkflowState['plan']>['verificationCommands'][number] => command !== null)
    : [];
  const verification = Array.isArray(candidate.verification)
    ? candidate.verification.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : verificationCommands.map((item) => item.command);
  return {
    goal: candidate.goal,
    summary: candidate.summary,
    assumptions: Array.isArray(candidate.assumptions) ? candidate.assumptions.filter(isNonEmptyString) : [],
    tasks,
    reviewFocus: Array.isArray(candidate.reviewFocus) ? candidate.reviewFocus.filter(isNonEmptyString) : [],
    verification,
    verificationCommands,
    risks: Array.isArray(candidate.risks) ? candidate.risks.filter(isNonEmptyString) : [],
    needsApproval: candidate.needsApproval === true,
  };
}

function normalizePlannerTask(value: unknown): NonNullable<AgentWorkflowState['plan']>['tasks'][number] | null {
  if (!value || typeof value !== 'object') return null;
  const task = value as Partial<NonNullable<AgentWorkflowState['plan']>['tasks'][number]>;
  if (typeof task.title !== 'string' || typeof task.description !== 'string') return null;
  return {
    title: task.title,
    description: task.description,
    suggestedRole: normalizePlannerTaskRole(task.suggestedRole),
    priority: task.priority === 'high' || task.priority === 'low' ? task.priority : 'normal',
    acceptance: Array.isArray(task.acceptance) ? task.acceptance.filter(isNonEmptyString) : [],
    scopeRead: Array.isArray(task.scopeRead) ? task.scopeRead.filter(isNonEmptyString) : [],
    scopeWrite: Array.isArray(task.scopeWrite) ? task.scopeWrite.filter(isNonEmptyString) : [],
    dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn.filter(isNonEmptyString) : [],
  };
}

function normalizeVerificationCommand(value: unknown): NonNullable<AgentWorkflowState['plan']>['verificationCommands'][number] | null {
  if (!value || typeof value !== 'object') return null;
  const command = value as Partial<NonNullable<AgentWorkflowState['plan']>['verificationCommands'][number]>;
  if (typeof command.command !== 'string' || command.command.trim().length === 0) return null;
  return {
    command: command.command,
    reason: typeof command.reason === 'string' && command.reason.trim().length > 0 ? command.reason : 'planner verification',
    required: command.required !== false,
  };
}

function normalizePlannerTaskRole(value: unknown): NonNullable<AgentWorkflowState['plan']>['tasks'][number]['suggestedRole'] {
  if (
    value === 'analyst' ||
    value === 'planner' ||
    value === 'coordinator' ||
    value === 'executor' ||
    value === 'reviewer' ||
    value === 'acceptor'
  ) {
    return value;
  }
  return 'executor';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function extractRoutingJsonCandidates(output: string): string[] {
  const candidates: string[] = [];
  const fenced = output.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
  for (const match of fenced) {
    if (match[1]?.trim()) candidates.push(match[1].trim());
  }
  const firstBrace = output.indexOf('{');
  const lastBrace = output.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(output.slice(firstBrace, lastBrace + 1));
  candidates.push(output.trim());
  return candidates;
}

function inferLightweightPlanDefaults(goal: string): {
  verificationCommand: string;
  verificationReason: string;
  scopeRead: string[];
  scopeWrite: string[];
} {
  const normalized = goal.toLowerCase();
  if (/readme|README|文档|docs?|documentation/u.test(goal)) {
    const scopeWrite = /readme/i.test(goal) ? ['README.md'] : ['docs/'];
    return {
      verificationCommand: 'git status --short',
      verificationReason: '确认文档轻量改动后的工作区状态',
      scopeRead: scopeWrite,
      scopeWrite,
    };
  }

  if (/文案|copy|label|按钮|标题/u.test(normalized)) {
    return {
      verificationCommand: 'npm run build',
      verificationReason: '验证轻量 UI 文案改动不会破坏构建',
      scopeRead: [],
      scopeWrite: [],
    };
  }

  return {
    verificationCommand: 'npm run build',
    verificationReason: 'TypeScript and bundle gate',
    scopeRead: [],
    scopeWrite: [],
  };
}

function inferStateIntent(state: AgentWorkflowState): SuperpowersSelectedIntent {
  return state.selectedIntent ?? inferIntentFromRiskAssessment(state) ?? inferIntentFromGoal(state.userGoal);
}

function inferIntentFromRiskAssessment(state: AgentWorkflowState): SuperpowersSelectedIntent | null {
  if (isAnalysisOnlyGoal(state.userGoal) && !isExplicitDebugCommandGoal(state.userGoal) && !isReviewOnlyGoal(state.userGoal)) {
    return 'analysis';
  }
  const taskKind = state.riskAssessment?.taskKind;
  if (taskKind === 'chat_answer') return 'answer';
  if (taskKind === 'brainstorming') return 'standard_development';
  if (taskKind === 'code_review') return 'review_only';
  if (taskKind === 'bug_fix') return 'debug';
  if (
    taskKind === 'frontend_change' ||
    taskKind === 'backend_change' ||
    taskKind === 'fullstack_change' ||
    taskKind === 'test_only' ||
    taskKind === 'docs_only' ||
    taskKind === 'ops_or_config'
  ) {
    return 'standard_development';
  }
  return null;
}

function inferIntentFromGoal(goal: string): SuperpowersSelectedIntent {
  if (/轻量|小改|文案|配置/u.test(goal)) return 'lightweight_task';
  if (isReviewOnlyGoal(goal)) return 'review_only';
  if (hasExplicitDebugGoal(goal)) return 'debug';
  if (isDirectAnswerGoal(goal)) return 'answer';
  if (/分析|解释|为什么|原因|架构/u.test(goal)) return 'analysis';
  if (/什么|吗|如何|怎么|\?|？/u.test(goal)) return 'answer';
  return 'standard_development';
}

function reconcileExplicitGoalIntent(
  intent: SuperpowersSelectedIntent,
  state: AgentWorkflowState,
): SuperpowersSelectedIntent {
  if (inferIntentFromRiskAssessment(state) === 'answer') return 'answer';
  const goal = state.userGoal;
  if (isReviewOnlyGoal(goal) && intent !== 'review_only') return 'review_only';
  if (isAnalysisOnlyGoal(goal) && !isExplicitDebugCommandGoal(goal) && intent !== 'review_only') return 'analysis';
  if (hasExplicitDebugGoal(goal) && (intent === 'analysis' || intent === 'answer')) return 'debug';
  if (intent === 'review_only' && isImplementationGoal(goal) && !isReviewOnlyGoal(goal)) return 'standard_development';
  if (intent === 'analysis' && isDirectAnswerGoal(goal)) return 'answer';
  return intent;
}

function isAnalysisOnlyGoal(goal: string): boolean {
  return /(?:只|仅).{0,12}(?:分析|排查|诊断|看原因|找原因)|(?:不要|不|无需).{0,8}(?:改代码|修改代码|修改|实现|修复|编辑|写文件|动代码)|只读分析/u.test(goal);
}

function isExplicitDebugCommandGoal(goal: string): boolean {
  return /debug|debug_plan|调试/u.test(goal);
}

function hasExplicitDebugGoal(goal: string): boolean {
  return /修复|bug|报错|失败|debug|debug_plan|调试|排查|诊断/u.test(goal);
}

function isDirectAnswerGoal(goal: string): boolean {
  if (!/为什么|原因|什么|是谁|用途|名称|叫什么|多少|何时|哪里|\?|？/u.test(goal)) return false;
  if (!/简短|一句话|只需|只需要|直接回答|只用/u.test(goal)) return false;
  return !/分析|排查|诊断|review|审查|比较|对比|方案/u.test(goal);
}

function isReviewOnlyGoal(goal: string): boolean {
  if (!/review|审查|代码审查|检查\s*(?:diff|代码|变更)|review\s*(?:diff|code|changes)/iu.test(goal)) return false;
  if (/只做.{0,12}(?:审查|review)|只(?:进行)?(?:代码)?审查|不要\s*(?:修改|更改|改动|编辑|实现)/iu.test(goal)) return true;
  const normalized = goal.replace(/不要\s*(?:修改|更改|改动|编辑|实现)/gu, '');
  return !isImplementationGoal(normalized);
}

function isImplementationGoal(goal: string): boolean {
  return /新增|创建|实现|开发|修改|更新|补充|修复|重构|测试|脚本|界面|功能|页面|使\s*.+通过|add|create|implement|develop|modify|update|fix|refactor|test|script|feature|page|ui/iu.test(goal);
}

function selectedPathForIntent(intent: SuperpowersSelectedIntent): string[] {
  if (intent === 'answer') return ['intake', 'route_skills', 'answer'];
  if (intent === 'analysis') return ['intake', 'route_skills', 'analysis_plan'];
  if (intent === 'lightweight_task') return ['intake', 'route_skills', 'lightweight_plan'];
  if (intent === 'debug') return ['intake', 'route_skills', 'debug_plan'];
  if (intent === 'review_only') return ['intake', 'route_skills', 'review_plan'];
  return ['intake', 'route_skills', 'brainstorming'];
}

function formatJson(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}
