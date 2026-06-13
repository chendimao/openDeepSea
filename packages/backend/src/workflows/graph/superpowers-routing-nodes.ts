import type { WorkflowArtifactVersionType } from '../../types.js';
import {
  assignPlanTaskAgent,
  type AvailableWorkflowAgent,
} from '../agent-assignment.js';
import { inferTaskProfile } from '../task-profile.js';
import type { AgentWorkflowState, SuperpowersSelectedIntent } from './state.js';

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
}

export function createSuperpowersRoutingNodes(tools: SuperpowersRoutingNodeTools) {
  return {
    async intake(state: AgentWorkflowState): Promise<AgentWorkflowState> {
      const intent = state.selectedIntent ?? inferIntentFromGoal(state.userGoal);
      const evidence = {
        intent,
        confidence: intent === 'answer' ? 0.7 : 0.6,
        reason: '根据用户消息和 session mode 生成初始路由。',
      };
      const artifact = tools.createArtifactVersionDraft({
        workflow_run_id: state.workflowRunId,
        artifact_type: 'intent_routing',
        title: 'Intent Routing',
        content: formatJson(evidence),
        structured_data: evidence,
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
      const intent = state.selectedIntent ?? inferIntentFromGoal(state.userGoal);
      return {
        ...state,
        currentNode: 'route_skills',
        activeSuperpowersStage: 'route_skills',
        selectedIntent: intent,
        selectedPath: selectedPathForIntent(intent),
      };
    },

    async answer(state: AgentWorkflowState): Promise<AgentWorkflowState> {
      const message = tools.createAssistantMessage({
        workflowRunId: state.workflowRunId,
        content: `已通过 workflow-first answer 路径处理：${state.userGoal}`,
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
      const evidence = {
        conclusion: '已进入只读分析路径。',
        evidence: [],
        risks: [],
        recommendations: [],
      };
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
      const plan = buildSingleTaskPlan({
        goal: state.userGoal,
        summary: '轻量任务走最小执行计划，用户确认后进入执行。',
        taskTitle: '执行轻量任务',
        taskDescription: state.userGoal,
        verificationCommand: 'npm run build',
        verificationReason: 'TypeScript and bundle gate',
        needsApproval: false,
      });
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
        status: 'blocked',
        error: 'Superpowers dispatch requires approved plan artifact version',
      };
    },

    async debugPlan(state: AgentWorkflowState): Promise<AgentWorkflowState> {
      const plan = buildSingleTaskPlan({
        goal: state.userGoal,
        summary: '系统化排查失败并修复根因。',
        taskTitle: '执行系统化调试',
        taskDescription: state.userGoal,
        verificationCommand: 'npm run build',
        verificationReason: 'post-debug verification',
        needsApproval: false,
      });
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
        plan,
      };
    },

    async reviewPlan(state: AgentWorkflowState): Promise<AgentWorkflowState> {
      const structuredData = {
        goal: state.userGoal,
        mode: 'review_only',
        reviewScope: [],
        verificationRequired: false,
      };
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
      scopeRead: [],
      scopeWrite: [],
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

function inferIntentFromGoal(goal: string): SuperpowersSelectedIntent {
  if (/什么|吗|如何|怎么|\?|？/u.test(goal)) return 'answer';
  if (/review|审查|代码审查/u.test(goal)) return 'review_only';
  if (/修复|bug|报错|失败|debug|调试/u.test(goal)) return 'debug';
  if (/轻量|小改|文案|配置/u.test(goal)) return 'lightweight_task';
  if (/分析|解释|为什么|原因|架构/u.test(goal)) return 'analysis';
  return 'standard_development';
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
