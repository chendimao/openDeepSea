import { serializeGraphState, type AgentWorkflowState } from './state.js';
import type { GraphTools } from './tools.js';
import { formatParsedPlanArtifact } from '../orchestrator.js';

export interface GraphRuntimeNodes {
  contextNode: (state: AgentWorkflowState) => Promise<AgentWorkflowState>;
  planningNode: (state: AgentWorkflowState) => Promise<AgentWorkflowState>;
  approvalNode: (state: AgentWorkflowState) => Promise<AgentWorkflowState>;
  dispatchNode: (state: AgentWorkflowState) => Promise<AgentWorkflowState>;
  executeNode: (state: AgentWorkflowState) => Promise<AgentWorkflowState>;
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
      if (!state.plan) throw new Error('dispatch requires plan');

      const scopeRead = Array.from(new Set(state.plan.tasks.flatMap((item) => item.scopeRead)));
      const scopeWrite = Array.from(new Set(state.plan.tasks.flatMap((item) => item.scopeWrite)));
      const step = tools.createGraphStep({
        workflow_run_id: context.run.id,
        task_id: context.task.id,
        stage: 'assignment',
        node_name: 'dispatch',
        status: 'completed',
        scope_read: scopeRead,
        scope_write: scopeWrite,
        sort_order: tools.nextStepSortOrder(context.run.id),
      });

      const childTaskIds: string[] = [];
      for (const planTask of state.plan.tasks) {
        const assigned = tools.selectAgentForRole(planTask.suggestedRole, context.agents);
        const child = tools.createChildTask({
          room_id: context.task.room_id,
          project_id: context.task.project_id,
          parent_task_id: context.task.id,
          title: planTask.title,
          description: `${planTask.description}\n\n验收点：\n${planTask.acceptance.map((point) => `- ${point}`).join('\n')}`,
          priority: planTask.priority,
          assigned_agent_id: assigned?.id,
          created_from: 'workflow_assignment',
        });
        childTaskIds.push(child.id);
        tools.broadcastTaskCreated(child);
      }

      const artifactContent = `已根据计划创建 ${childTaskIds.length} 个子任务。`;
      tools.createArtifact({
        task_id: context.task.id,
        workflow_run_id: context.run.id,
        workflow_step_id: step.id,
        artifact_type: 'assignment',
        title: '任务分配',
        content: artifactContent,
        metadata: {
          taskCount: childTaskIds.length,
          childTaskIds,
        },
      });
      tools.recordWorkflowEvent({
        roomId: context.room.id,
        taskId: context.task.id,
        taskTitle: context.task.title,
        workflowRunId: context.run.id,
        workflowStepId: step.id,
        eventType: 'workflow_assignment_created',
        origin: 'workflow_assignment',
        content: `已根据计划为任务「${context.task.title}」创建 ${childTaskIds.length} 个子任务。`,
      });
      tools.updateRun(context.run.id, {
        status: 'running',
        current_stage: 'implementation',
        error: null,
      });

      const nextState: AgentWorkflowState = {
        ...state,
        currentNode: 'dispatch',
        currentStepId: step.id,
        childTaskIds,
      };
      tools.updateGraphState(context.run.id, serializeGraphState(nextState));
      return nextState;
    },

    async executeNode(state) {
      const context = tools.readWorkflowContext(state.workflowRunId);
      const nextState: AgentWorkflowState = {
        ...state,
        currentNode: 'execute',
      };
      tools.updateGraphState(context.run.id, serializeGraphState(nextState));
      return nextState;
    },
  };
}
