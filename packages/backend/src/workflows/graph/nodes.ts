import { serializeGraphState, type AgentWorkflowState } from './state.js';
import type { GraphTools } from './tools.js';
import { runVerificationCommand } from './verification.js';
import { formatParsedPlanArtifact } from '../orchestrator.js';
import { parseAcceptanceVerdict, parseReviewVerdict } from '../plan-parser.js';
import { buildStagePrompt } from '../prompts.js';

export interface GraphRuntimeNodes {
  contextNode: (state: AgentWorkflowState) => Promise<AgentWorkflowState>;
  planningNode: (state: AgentWorkflowState) => Promise<AgentWorkflowState>;
  approvalNode: (state: AgentWorkflowState) => Promise<AgentWorkflowState>;
  dispatchNode: (state: AgentWorkflowState) => Promise<AgentWorkflowState>;
  executeNode: (state: AgentWorkflowState) => Promise<AgentWorkflowState>;
  reviewNode: (state: AgentWorkflowState) => Promise<AgentWorkflowState>;
  repairDecisionNode: (state: AgentWorkflowState) => Promise<AgentWorkflowState>;
  verifyNode: (state: AgentWorkflowState) => Promise<AgentWorkflowState>;
  acceptanceNode: (state: AgentWorkflowState) => Promise<AgentWorkflowState>;
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
      const executionCandidates = state.childTaskIds.length > 0 ? pendingChildren : childTasks;
      const nextChild = executionCandidates
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

      if (runResult.status !== 'completed') {
        const error = runResult.run.error ?? (runResult.status === 'cancelled' ? 'Agent run cancelled' : 'Agent run failed');
        const failedStep = tools.updateGraphStep(step.id, {
          status: runResult.status === 'cancelled' ? 'cancelled' : 'failed',
          agent_run_id: runResult.run.id,
          result: runResult.run.stdout || runResult.message.content,
          result_message_id: runResult.message.id,
          error,
        });
        if (failedStep) tools.broadcastStepUpdated(context.room.id, failedStep);
        const failedChild = tools.updateTaskStatus(nextChild.id, 'failed');
        if (failedChild) tools.broadcastTaskUpdated(failedChild);
        const blockedRun = tools.updateRun(context.run.id, {
          status: runResult.status === 'cancelled' ? 'cancelled' : 'blocked',
          current_stage: 'implementation',
          error,
        });
        if (blockedRun) tools.broadcastWorkflowUpdated(blockedRun);
        const nextState: AgentWorkflowState = {
          ...state,
          currentNode: 'execute',
          currentStepId: step.id,
          activeAgentRunId: runResult.run.id,
          status: runResult.status === 'cancelled' ? 'cancelled' : 'blocked',
          error,
        };
        tools.updateGraphState(context.run.id, serializeGraphState(nextState));
        return nextState;
      }

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

    async reviewNode(state) {
      const context = tools.readWorkflowContext(state.workflowRunId);
      const reviewer = tools.selectAgentForRole('reviewer', context.agents)
        ?? tools.selectAgentForRole('executor', context.agents);
      if (!reviewer) {
        const error = 'No reviewer available for code review';
        const updatedRun = tools.updateRun(context.run.id, {
          status: 'blocked',
          error,
        });
        if (updatedRun) tools.broadcastWorkflowUpdated(updatedRun);
        const nextState: AgentWorkflowState = {
          ...state,
          currentNode: 'review',
          status: 'blocked',
          error,
        };
        tools.updateGraphState(context.run.id, serializeGraphState(nextState));
        return nextState;
      }

      const prompt = buildStagePrompt('code_review', {
        projectName: context.project.name,
        projectPath: context.project.path,
        room: context.room,
        task: context.task,
        agents: context.agents,
        artifacts: context.artifacts,
        childTasks: tools.listChildTasks(context.task.id),
        memoryContext: context.memories,
      });
      const step = tools.createGraphStep({
        workflow_run_id: context.run.id,
        task_id: context.task.id,
        stage: 'code_review',
        node_name: 'review',
        status: 'running',
        room_agent_id: reviewer.id,
        assigned_room_agent_id: reviewer.id,
        prompt,
        sort_order: tools.nextStepSortOrder(context.run.id),
      });
      tools.broadcastStepCreated(context.room.id, step);
      const updatedRun = tools.updateRun(context.run.id, {
        status: 'running',
        error: null,
      });
      if (updatedRun) tools.broadcastWorkflowUpdated(updatedRun);

      const runResult = await tools.runAcpAgent({
        agent: reviewer,
        projectPath: context.project.path,
        roomId: context.room.id,
        prompt,
        taskId: context.task.id,
        workflowRunId: context.run.id,
        workflowStepId: step.id,
        workflowStage: 'code_review',
      });
      const output = runResult.run.stdout || runResult.message.content;
      const artifact = tools.createArtifact({
        task_id: context.task.id,
        workflow_run_id: context.run.id,
        workflow_step_id: step.id,
        artifact_type: 'review',
        title: '代码审查',
        content: output,
      });
      tools.broadcastArtifactCreated(context.room.id, artifact);

      if (runResult.status !== 'completed') {
        const error = runResult.run.error ?? (runResult.status === 'cancelled' ? 'Agent run cancelled' : 'Code review failed');
        const failedStep = tools.updateGraphStep(step.id, {
          status: runResult.status === 'cancelled' ? 'cancelled' : 'failed',
          agent_run_id: runResult.run.id,
          result: output,
          result_message_id: runResult.message.id,
          error,
        });
        if (failedStep) tools.broadcastStepUpdated(context.room.id, failedStep);
        const blockedRun = tools.updateRun(context.run.id, {
          status: runResult.status === 'cancelled' ? 'cancelled' : 'blocked',
          error,
        });
        if (blockedRun) tools.broadcastWorkflowUpdated(blockedRun);
        const nextState: AgentWorkflowState = {
          ...state,
          currentNode: 'review',
          currentStepId: step.id,
          activeAgentRunId: runResult.run.id,
          status: runResult.status === 'cancelled' ? 'cancelled' : 'blocked',
          error,
        };
        tools.updateGraphState(context.run.id, serializeGraphState(nextState));
        return nextState;
      }

      let verdict: ReturnType<typeof parseReviewVerdict>;
      try {
        verdict = parseReviewVerdict(output);
      } catch (err) {
        const error = `Code review output is not valid JSON verdict: ${(err as Error).message}`;
        const failedStep = tools.updateGraphStep(step.id, {
          status: 'failed',
          agent_run_id: runResult.run.id,
          result: output,
          result_message_id: runResult.message.id,
          error,
        });
        if (failedStep) tools.broadcastStepUpdated(context.room.id, failedStep);
        const blockedRun = tools.updateRun(context.run.id, {
          status: 'blocked',
          error,
        });
        if (blockedRun) tools.broadcastWorkflowUpdated(blockedRun);
        const nextState: AgentWorkflowState = {
          ...state,
          currentNode: 'review',
          currentStepId: step.id,
          activeAgentRunId: runResult.run.id,
          status: 'blocked',
          error,
        };
        tools.updateGraphState(context.run.id, serializeGraphState(nextState));
        return nextState;
      }

      const finalStatus = verdict.verdict === 'failed' ? 'failed' : 'completed';
      const finalError = verdict.verdict === 'failed' ? 'Code review failed' : null;
      const completedStep = tools.updateGraphStep(step.id, {
        status: finalStatus,
        agent_run_id: runResult.run.id,
        result: output,
        result_message_id: runResult.message.id,
        error: finalError,
      });
      if (completedStep) tools.broadcastStepUpdated(context.room.id, completedStep);

      if (verdict.verdict === 'failed') {
        const blockedRun = tools.updateRun(context.run.id, {
          status: 'blocked',
          error: 'Code review failed',
        });
        if (blockedRun) tools.broadcastWorkflowUpdated(blockedRun);
        const blockedState: AgentWorkflowState = {
          ...state,
          currentNode: 'review',
          currentStepId: step.id,
          activeAgentRunId: runResult.run.id,
          reviewFindings: verdict.findings,
          reviewVerdict: 'failed',
          status: 'blocked',
          error: 'Code review failed',
        };
        tools.updateGraphState(context.run.id, serializeGraphState(blockedState));
        return blockedState;
      }

      const nextState: AgentWorkflowState = {
        ...state,
        currentNode: 'review',
        currentStepId: step.id,
        activeAgentRunId: runResult.run.id,
        reviewFindings: verdict.findings,
        reviewVerdict: verdict.verdict,
        error: verdict.verdict === 'changes_requested' ? 'Code review requested changes' : null,
      };
      tools.updateGraphState(context.run.id, serializeGraphState(nextState));
      return nextState;
    },

    async repairDecisionNode(state) {
      const context = tools.readWorkflowContext(state.workflowRunId);
      if (state.repairAttempts < 2) {
        for (const child of tools.listChildTasks(context.task.id).filter((item) =>
          state.childTaskIds.includes(item.id) && item.status === 'review',
        )) {
          const resetChild = tools.updateTaskStatus(child.id, 'todo');
          if (resetChild) tools.broadcastTaskUpdated(resetChild);
        }
        const nextState: AgentWorkflowState = {
          ...state,
          currentNode: 'execute',
          repairAttempts: state.repairAttempts + 1,
          reviewVerdict: null,
          error: null,
        };
        tools.updateGraphState(context.run.id, serializeGraphState(nextState));
        return nextState;
      }

      const error = 'Code review requested changes after max repair attempts';
      const updatedRun = tools.updateRun(context.run.id, {
        status: 'blocked',
        error,
      });
      if (updatedRun) tools.broadcastWorkflowUpdated(updatedRun);
      const nextState: AgentWorkflowState = {
        ...state,
        currentNode: 'repair_decision',
        status: 'blocked',
        error,
      };
      tools.updateGraphState(context.run.id, serializeGraphState(nextState));
      return nextState;
    },

    async verifyNode(state) {
      const context = tools.readWorkflowContext(state.workflowRunId);
      const commands = state.plan?.verification ?? [];
      const step = tools.createGraphStep({
        workflow_run_id: context.run.id,
        task_id: context.task.id,
        stage: 'code_review',
        node_name: 'verify',
        status: 'running',
        prompt: commands.length > 0 ? commands.join('\n') : 'no verification commands',
        sort_order: tools.nextStepSortOrder(context.run.id),
      });
      tools.broadcastStepCreated(context.room.id, step);

      const results = commands.length > 0
        ? await Promise.all(commands.map(async (command) => runVerificationCommand(command, context.project.path)))
        : [{
          command: '(none)',
          status: 'skipped' as const,
          exitCode: null,
          stdout: '',
          stderr: 'No verification commands configured',
        }];

      const failedRequired = results.find((result) => result.status !== 'passed');
      const blocked = Boolean(failedRequired);
      const summary = results.map((result) => (
        `- ${result.command}: ${result.status} (exitCode=${result.exitCode ?? 'null'})`
      )).join('\n');

      const artifact = tools.createArtifact({
        task_id: context.task.id,
        workflow_run_id: context.run.id,
        workflow_step_id: step.id,
        artifact_type: 'implementation_summary',
        title: '验证结果',
        content: summary,
        metadata: {
          results,
        },
      });
      tools.broadcastArtifactCreated(context.room.id, artifact);

      const updatedStep = tools.updateGraphStep(step.id, {
        status: blocked ? 'failed' : 'completed',
        result: summary,
        error: blocked ? `Verification failed: ${failedRequired?.command}` : null,
      });
      if (updatedStep) tools.broadcastStepUpdated(context.room.id, updatedStep);

      if (blocked) {
        const updatedRun = tools.updateRun(context.run.id, {
          status: 'blocked',
          error: `Verification failed: ${failedRequired?.command}`,
        });
        if (updatedRun) tools.broadcastWorkflowUpdated(updatedRun);
      }

      const nextState: AgentWorkflowState = {
        ...state,
        currentNode: 'verify',
        currentStepId: step.id,
        verificationResults: results,
        status: blocked ? 'blocked' : state.status,
        error: blocked ? `Verification failed: ${failedRequired?.command}` : null,
      };
      tools.updateGraphState(context.run.id, serializeGraphState(nextState));
      return nextState;
    },

    async acceptanceNode(state) {
      const context = tools.readWorkflowContext(state.workflowRunId);
      const acceptor = tools.selectAgentForRole('acceptor', context.agents)
        ?? tools.selectAgentForRole('reviewer', context.agents);
      if (!acceptor) {
        const error = 'No acceptor available for acceptance';
        const updatedRun = tools.updateRun(context.run.id, {
          status: 'failed',
          current_stage: 'acceptance',
          error,
        });
        if (updatedRun) tools.broadcastWorkflowUpdated(updatedRun);
        const nextState: AgentWorkflowState = {
          ...state,
          currentNode: 'acceptance',
          status: 'failed',
          error,
        };
        tools.updateGraphState(context.run.id, serializeGraphState(nextState));
        return nextState;
      }

      const prompt = buildStagePrompt('acceptance', {
        projectName: context.project.name,
        projectPath: context.project.path,
        room: context.room,
        task: context.task,
        agents: context.agents,
        artifacts: context.artifacts,
        childTasks: tools.listChildTasks(context.task.id),
        memoryContext: context.memories,
      });
      const step = tools.createGraphStep({
        workflow_run_id: context.run.id,
        task_id: context.task.id,
        stage: 'acceptance',
        node_name: 'acceptance',
        status: 'running',
        room_agent_id: acceptor.id,
        assigned_room_agent_id: acceptor.id,
        prompt,
        sort_order: tools.nextStepSortOrder(context.run.id),
      });
      tools.broadcastStepCreated(context.room.id, step);
      const updatedRun = tools.updateRun(context.run.id, {
        status: 'running',
        current_stage: 'acceptance',
        error: null,
      });
      if (updatedRun) tools.broadcastWorkflowUpdated(updatedRun);

      const runResult = await tools.runAcpAgent({
        agent: acceptor,
        projectPath: context.project.path,
        roomId: context.room.id,
        prompt,
        taskId: context.task.id,
        workflowRunId: context.run.id,
        workflowStepId: step.id,
        workflowStage: 'acceptance',
      });
      const output = runResult.run.stdout || runResult.message.content;
      const artifact = tools.createArtifact({
        task_id: context.task.id,
        workflow_run_id: context.run.id,
        workflow_step_id: step.id,
        artifact_type: 'acceptance',
        title: '功能验收',
        content: output,
      });
      tools.broadcastArtifactCreated(context.room.id, artifact);

      if (runResult.status !== 'completed') {
        const error = runResult.run.error ?? (runResult.status === 'cancelled' ? 'Agent run cancelled' : 'Acceptance failed');
        const failedStep = tools.updateGraphStep(step.id, {
          status: runResult.status === 'cancelled' ? 'cancelled' : 'failed',
          agent_run_id: runResult.run.id,
          result: output,
          result_message_id: runResult.message.id,
          error,
        });
        if (failedStep) tools.broadcastStepUpdated(context.room.id, failedStep);
        const failedParent = tools.updateTaskStatus(context.task.id, 'failed');
        if (failedParent) tools.broadcastTaskUpdated(failedParent);
        const failedRun = tools.updateRun(context.run.id, {
          status: runResult.status === 'cancelled' ? 'cancelled' : 'failed',
          current_stage: 'acceptance',
          error,
        });
        if (failedRun) tools.broadcastWorkflowUpdated(failedRun);
        const failedState: AgentWorkflowState = {
          ...state,
          currentNode: 'acceptance',
          currentStepId: step.id,
          activeAgentRunId: runResult.run.id,
          status: runResult.status === 'cancelled' ? 'cancelled' : 'failed',
          error,
        };
        tools.updateGraphState(context.run.id, serializeGraphState(failedState));
        return failedState;
      }

      let verdict: ReturnType<typeof parseAcceptanceVerdict>;
      try {
        verdict = parseAcceptanceVerdict(output);
      } catch (err) {
        const error = `Acceptance output is not valid JSON verdict: ${(err as Error).message}`;
        const failedStep = tools.updateGraphStep(step.id, {
          status: 'failed',
          agent_run_id: runResult.run.id,
          result: output,
          result_message_id: runResult.message.id,
          error,
        });
        if (failedStep) tools.broadcastStepUpdated(context.room.id, failedStep);
        const failedParent = tools.updateTaskStatus(context.task.id, 'failed');
        if (failedParent) tools.broadcastTaskUpdated(failedParent);
        const failedRun = tools.updateRun(context.run.id, {
          status: 'failed',
          current_stage: 'acceptance',
          error,
        });
        if (failedRun) tools.broadcastWorkflowUpdated(failedRun);
        const failedState: AgentWorkflowState = {
          ...state,
          currentNode: 'acceptance',
          currentStepId: step.id,
          activeAgentRunId: runResult.run.id,
          status: 'failed',
          error,
        };
        tools.updateGraphState(context.run.id, serializeGraphState(failedState));
        return failedState;
      }

      const completedStep = tools.updateGraphStep(step.id, {
        status: verdict.verdict === 'pass' ? 'completed' : 'failed',
        agent_run_id: runResult.run.id,
        result: output,
        result_message_id: runResult.message.id,
        error: verdict.verdict === 'pass' ? null : 'Acceptance failed',
      });
      if (completedStep) tools.broadcastStepUpdated(context.room.id, completedStep);

      if (verdict.verdict === 'pass') {
        for (const child of tools.listChildTasks(context.task.id).filter((item) => item.status === 'review')) {
          const updatedChild = tools.updateTaskStatus(child.id, 'done');
          if (updatedChild) tools.broadcastTaskUpdated(updatedChild);
        }
        const doneParent = tools.updateTaskStatus(context.task.id, 'done');
        if (doneParent) tools.broadcastTaskUpdated(doneParent);
        const doneRun = tools.updateRun(context.run.id, {
          status: 'completed',
          current_stage: 'acceptance',
          error: null,
        });
        if (doneRun) tools.broadcastWorkflowUpdated(doneRun);
        const nextState: AgentWorkflowState = {
          ...state,
          currentNode: 'acceptance',
          currentStepId: step.id,
          activeAgentRunId: runResult.run.id,
          status: 'completed',
          error: null,
        };
        tools.updateGraphState(context.run.id, serializeGraphState(nextState));
        return nextState;
      }

      const failedParent = tools.updateTaskStatus(context.task.id, 'failed');
      if (failedParent) tools.broadcastTaskUpdated(failedParent);
      const failedRun = tools.updateRun(context.run.id, {
        status: 'failed',
        current_stage: 'acceptance',
        error: 'Acceptance failed',
      });
      if (failedRun) tools.broadcastWorkflowUpdated(failedRun);
      const failedState: AgentWorkflowState = {
        ...state,
        currentNode: 'acceptance',
        currentStepId: step.id,
        activeAgentRunId: runResult.run.id,
        status: 'failed',
        error: 'Acceptance failed',
      };
      tools.updateGraphState(context.run.id, serializeGraphState(failedState));
      return failedState;
    },
  };
}
