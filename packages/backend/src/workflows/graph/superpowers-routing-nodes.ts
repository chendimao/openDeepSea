import type { WorkflowArtifactVersionType } from '../../types.js';
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

    async passthrough(state: AgentWorkflowState, nodeName: string): Promise<AgentWorkflowState> {
      return {
        ...state,
        currentNode: nodeName as AgentWorkflowState['currentNode'],
        activeSuperpowersStage: nodeName,
      };
    },
  };
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
