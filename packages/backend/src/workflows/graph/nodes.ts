import { serializeGraphState, type AgentWorkflowState } from './state.js';
import type { GraphTools } from './tools.js';
import { formatParsedPlanArtifact } from '../orchestrator.js';

export interface GraphRuntimeNodes {
  contextNode: (state: AgentWorkflowState) => Promise<AgentWorkflowState>;
  planningNode: (state: AgentWorkflowState) => Promise<AgentWorkflowState>;
  approvalNode: (state: AgentWorkflowState) => Promise<AgentWorkflowState>;
  dispatchNode: (state: AgentWorkflowState) => Promise<AgentWorkflowState>;
}

export function createGraphNodes(tools: GraphTools): GraphRuntimeNodes {
  return {
    async contextNode(state) {
      const context = tools.readWorkflowContext(state.workflowRunId);
      const step = tools.createGraphStep({
        workflow_run_id: context.run.id,
        task_id: context.task.id,
        stage: 'analysis',
        node_name: 'context',
        status: 'completed',
        sort_order: tools.nextStepSortOrder(context.run.id),
      });
      const nextState: AgentWorkflowState = {
        ...state,
        currentNode: 'context',
        currentStepId: step.id,
      };
      tools.updateGraphState(context.run.id, serializeGraphState(nextState));
      return nextState;
    },

    async planningNode(state) {
      const context = tools.readWorkflowContext(state.workflowRunId);
      const step = tools.createGraphStep({
        workflow_run_id: context.run.id,
        task_id: context.task.id,
        stage: 'planning',
        node_name: 'planning',
        status: 'running',
        sort_order: tools.nextStepSortOrder(context.run.id),
      });

      const plan = await tools.generatePlan({
        projectName: context.project.name,
        projectPath: context.project.path,
        room: context.room,
        task: context.task,
        agents: context.agents,
        memories: context.memories ? [context.memories] : [],
        recentMessages: context.recentMessages,
      });

      const output = formatParsedPlanArtifact(plan);
      tools.createArtifact({
        task_id: context.task.id,
        workflow_run_id: context.run.id,
        workflow_step_id: step.id,
        artifact_type: 'plan',
        title: '执行计划',
        content: output,
        metadata: plan as unknown as Record<string, unknown>,
      });
      tools.updateGraphStep(step.id, {
        status: 'completed',
        result: output,
      });

      const nextState: AgentWorkflowState = {
        ...state,
        plan,
        currentNode: 'planning',
        currentStepId: step.id,
      };
      tools.updateGraphState(context.run.id, serializeGraphState(nextState));
      return nextState;
    },

    async approvalNode(state) {
      const context = tools.readWorkflowContext(state.workflowRunId);
      const needsApproval = state.plan?.needsApproval ?? true;
      const nextState: AgentWorkflowState = {
        ...state,
        currentNode: 'approval',
        approval: needsApproval ? 'pending' : 'not_required',
        status: needsApproval ? 'awaiting_approval' : state.status,
      };
      tools.updateRun(context.run.id, {
        status: needsApproval ? 'awaiting_approval' : 'running',
      });
      tools.updateGraphState(context.run.id, serializeGraphState(nextState));
      return nextState;
    },

    async dispatchNode(state) {
      const context = tools.readWorkflowContext(state.workflowRunId);
      const nextState: AgentWorkflowState = {
        ...state,
        currentNode: 'dispatch',
      };
      tools.updateGraphState(context.run.id, serializeGraphState(nextState));
      return nextState;
    },
  };
}
