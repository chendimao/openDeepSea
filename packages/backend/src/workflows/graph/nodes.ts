import { serializeGraphState, type AgentWorkflowState } from './state.js';
import type { GraphTools } from './tools.js';
import { formatParsedPlanArtifact } from '../orchestrator.js';
import { buildStagePrompt } from '../prompts.js';

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

      const existingStep = tools.listSteps(context.run.id)
        .find((step) => step.node_name === 'dispatch' && step.status === 'completed');
      const existingChildTaskIds = state.childTaskIds.length > 0
        ? state.childTaskIds
        : tools.listChildTasks(context.task.id).map((task) => task.id);
      if (existingStep || existingChildTaskIds.length > 0) {
        const updatedRun = tools.updateRun(context.run.id, {
          status: 'running',
          current_stage: 'implementation',
          error: null,
        });
        if (updatedRun) tools.broadcastWorkflowUpdated(updatedRun);
        const nextState: AgentWorkflowState = {
          ...state,
          currentNode: 'dispatch',
          currentStepId: existingStep?.id ?? state.currentStepId,
          childTaskIds: existingChildTaskIds,
        };
        tools.updateGraphState(context.run.id, serializeGraphState(nextState));
        return nextState;
      }

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
      tools.broadcastStepCreated(context.room.id, step);

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
      const artifact = tools.createArtifact({
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
      tools.broadcastArtifactCreated(context.room.id, artifact);
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
      const updatedRun = tools.updateRun(context.run.id, {
        status: 'running',
        current_stage: 'implementation',
        error: null,
      });
      if (updatedRun) tools.broadcastWorkflowUpdated(updatedRun);

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
      const childTasks = tools.listChildTasks(context.task.id);
      const pendingChildren = state.childTaskIds
        .map((id) => childTasks.find((task) => task.id === id))
        .filter((task): task is NonNullable<typeof task> => Boolean(task));
      const nextChild = [...pendingChildren, ...childTasks]
        .find((child) => child.status === 'todo' || child.status === 'in_progress');
      if (!nextChild) {
        const nextState: AgentWorkflowState = {
          ...state,
          currentNode: 'execute',
        };
        tools.updateGraphState(context.run.id, serializeGraphState(nextState));
        return nextState;
      }

      const executor = nextChild.assigned_agent_id
        ? context.agents.find((agent) => agent.id === nextChild.assigned_agent_id) ?? null
        : tools.selectAgentForRole('executor', context.agents);
      if (!executor) {
        const error = 'No executor available for implementation';
        const updatedRun = tools.updateRun(context.run.id, {
          status: 'blocked',
          current_stage: 'implementation',
          error,
        });
        if (updatedRun) tools.broadcastWorkflowUpdated(updatedRun);
        const nextState: AgentWorkflowState = {
          ...state,
          currentNode: 'execute',
          status: 'blocked',
          error,
        };
        tools.updateGraphState(context.run.id, serializeGraphState(nextState));
        return nextState;
      }

      const inProgressChild = nextChild.status === 'in_progress' ? nextChild : tools.updateTaskStatus(nextChild.id, 'in_progress');
      if (inProgressChild) {
        tools.broadcastTaskUpdated(inProgressChild);
      }

      const orderedChildIds = state.childTaskIds.length > 0 ? state.childTaskIds : childTasks.map((item) => item.id);
      const plannedTaskIndex = orderedChildIds.indexOf(nextChild.id);
      const plannedTask = plannedTaskIndex >= 0
        ? state.plan?.tasks[plannedTaskIndex]
        : state.plan?.tasks.find((item) => item.title === nextChild.title);
      const scopeRead = plannedTask?.scopeRead ?? [];
      const scopeWrite = plannedTask?.scopeWrite ?? [];
      const prompt = buildStagePrompt('implementation', {
        projectName: context.project.name,
        projectPath: context.project.path,
        room: context.room,
        task: nextChild,
        agents: context.agents,
        artifacts: context.artifacts,
        childTasks,
        memoryContext: context.memories,
      });
      const step = tools.createGraphStep({
        workflow_run_id: context.run.id,
        task_id: nextChild.id,
        stage: 'implementation',
        node_name: 'execute',
        status: 'running',
        room_agent_id: executor.id,
        assigned_room_agent_id: nextChild.assigned_agent_id ?? executor.id,
        scope_read: scopeRead,
        scope_write: scopeWrite,
        prompt,
        sort_order: tools.nextStepSortOrder(context.run.id),
      });
      tools.broadcastStepCreated(context.room.id, step);

      const updatedRun = tools.updateRun(context.run.id, {
        status: 'running',
        current_stage: 'implementation',
        error: null,
      });
      if (updatedRun) tools.broadcastWorkflowUpdated(updatedRun);

      const runResult = await tools.runAcpAgent({
        agent: executor,
        projectPath: context.project.path,
        roomId: context.room.id,
        prompt,
        taskId: nextChild.id,
        workflowRunId: context.run.id,
        workflowStepId: step.id,
        workflowStage: 'implementation',
      });

      const completedStep = tools.updateGraphStep(step.id, {
        status: 'completed',
        agent_run_id: runResult.run.id,
        result: runResult.run.stdout || runResult.message.content,
        result_message_id: runResult.message.id,
        error: runResult.run.error,
      });
      if (completedStep) tools.broadcastStepUpdated(context.room.id, completedStep);

      const reviewedChild = tools.updateTaskStatus(nextChild.id, 'review');
      if (reviewedChild) tools.broadcastTaskUpdated(reviewedChild);

      const nextState: AgentWorkflowState = {
        ...state,
        currentNode: 'execute',
        currentStepId: step.id,
        activeAgentRunId: runResult.run.id,
        error: null,
      };
      tools.updateGraphState(context.run.id, serializeGraphState(nextState));
      return nextState;
    },
  };
}
