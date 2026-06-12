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

    async passthrough(state: AgentWorkflowState, nodeName: string): Promise<AgentWorkflowState> {
      return {
        ...state,
        currentNode: nodeName as AgentWorkflowState['currentNode'],
        activeSuperpowersStage: nodeName,
      };
    },
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
