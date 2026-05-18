import { serializeGraphState, type AgentWorkflowState } from './state.js';
import type { GraphTools } from './tools.js';
import { getVerificationCwd, runVerificationCommand } from './verification.js';
import { buildTaskSummaryMemoryContent, formatParsedPlanArtifact } from '../orchestrator.js';
import { parseAcceptanceVerdict, parseReviewVerdict, type ParsedPlanTask } from '../plan-parser.js';
import { buildStagePrompt } from '../prompts.js';
import { resolveWorkflowExecutor } from '../role-resolver.js';
import { ensureWorkflowAgentsForRun } from '../agent-provisioning.js';
import type { RoomAgent, Task, TaskEventType, WorkflowContextEntryType, WorkflowContextSourceType } from '../../types.js';

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
  memoryNode: (state: AgentWorkflowState) => Promise<AgentWorkflowState>;
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
      recordEventSafely(tools, context, {
        eventType: 'workflow_stage_changed',
        workflowStepId: step.id,
        content: `工作流已读取任务「${context.task.title}」的上下文。`,
        metadata: { graph_node: 'context', workflow_stage: 'analysis' },
      });
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
      recordEventSafely(tools, context, {
        eventType: 'workflow_stage_changed',
        workflowStepId: step.id,
        content: `工作流进入 planning 阶段，正在为任务「${context.task.title}」生成计划。`,
        metadata: { graph_node: 'planning', workflow_stage: 'planning', status: 'running' },
      });

      const skillContext = await tools.buildSkillContext({
        runtimeScopes: ['planner', 'workflow'],
        projectId: context.project.id,
        roomId: context.room.id,
        message: [
          context.task.title,
          context.task.description ?? '',
          context.workflowContext,
          context.recentMessages.join('\n'),
        ].filter(Boolean).join('\n\n'),
      });
      const plan = await tools.generatePlan({
        projectName: context.project.name,
        projectPath: context.project.path,
        room: context.room,
        task: context.task,
        agents: context.agents,
        memories: context.memories ? [context.memories] : [],
        recentMessages: context.recentMessages,
      }, { skillContext });

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
      createContextEntrySafely(tools, context, {
        workflowStepId: step.id,
        sourceType: 'workflow_step',
        sourceId: step.id,
        entryType: 'summary',
        title: '规划摘要',
        content: [
          `目标：${plan.goal ?? plan.summary}`,
          `摘要：${plan.summary}`,
          `子任务数：${plan.tasks.length}`,
          plan.verification.length > 0 ? `验证：${plan.verification.join('; ')}` : '验证：未配置',
          `是否需要审批：${plan.needsApproval ? '是' : '否'}`,
        ].join('\n'),
        rawCharCount: output.length,
        metadata: {
          graph_node: 'planning',
          workflow_stage: 'planning',
          task_count: plan.tasks.length,
          needs_approval: plan.needsApproval,
        },
      });
      recordEventSafely(tools, context, {
        eventType: 'workflow_plan_ready',
        workflowStepId: step.id,
        content: `任务「${context.task.title}」的执行计划已生成。`,
        metadata: {
          graph_node: 'planning',
          workflow_stage: 'planning',
          task_count: plan.tasks.length,
          needs_approval: plan.needsApproval,
        },
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
      if (!state.plan) throw new Error('approval requires plan');
      const needsApproval = state.plan.needsApproval;
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
      recordEventSafely(tools, context, {
        eventType: 'workflow_stage_changed',
        content: needsApproval
          ? `任务「${context.task.title}」的计划等待批准。`
          : `任务「${context.task.title}」无需批准，继续进入分配阶段。`,
        metadata: {
          graph_node: 'approval',
          workflow_stage: 'planning',
          approval_status: needsApproval ? 'pending' : 'not_required',
        },
      });
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
      let assignmentAgents = context.agents;
      for (const [index, planTask] of state.plan.tasks.entries()) {
        let resolved = tools.selectAgentForPlanTask(planTask, assignmentAgents);
        if (!resolved && planTask.suggestedRole === 'executor') {
          const provisioning = ensureWorkflowAgentsForRun({
            roomId: context.room.id,
            agents: assignmentAgents,
            planTasks: [planTask],
          });
          assignmentAgents = provisioning.agents;
          broadcastJoinedAgents(tools, context.room.id, provisioning.joinedAgents);
          resolved = tools.selectAgentForPlanTask(planTask, assignmentAgents);
        }
        const assigned = selectAssignmentHintForPlanTask(state, index, assignmentAgents, tools, resolved)
          ?? resolved;
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
      createContextEntrySafely(tools, context, {
        workflowStepId: step.id,
        sourceType: 'artifact',
        sourceId: artifact.id,
        entryType: 'summary',
        title: '任务分配摘要',
        content: [
          artifactContent,
          `子任务：${childTaskIds.join(', ')}`,
        ].join('\n'),
        rawCharCount: artifactContent.length,
        metadata: {
          graph_node: 'dispatch',
          workflow_stage: 'assignment',
          child_task_ids: childTaskIds,
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
        metadata: {
          graph_node: 'dispatch',
          workflow_stage: 'assignment',
          child_task_ids: childTaskIds,
        },
      });
      recordEventSafely(tools, context, {
        eventType: 'workflow_stage_changed',
        workflowStepId: step.id,
        content: `任务「${context.task.title}」已完成分配，创建 ${childTaskIds.length} 个子任务。`,
        metadata: { graph_node: 'dispatch', workflow_stage: 'assignment', child_task_ids: childTaskIds },
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

      const orderedChildIds = state.childTaskIds.length > 0 ? state.childTaskIds : childTasks.map((item) => item.id);
      const plannedTaskIndex = orderedChildIds.indexOf(nextChild.id);
      const plannedTask = plannedTaskIndex >= 0
        ? state.plan?.tasks[plannedTaskIndex]
        : state.plan?.tasks.find((item) => item.title === nextChild.title);
      const scopeRead = plannedTask?.scopeRead ?? [];
      const scopeWrite = plannedTask?.scopeWrite ?? [];
      let executionAgents = context.agents;
      let executor = selectExecutorForPlannedChild(executionAgents, nextChild, plannedTask, tools);
      if (!executor && plannedTask) {
        const provisioning = ensureWorkflowAgentsForRun({
          roomId: context.room.id,
          agents: executionAgents,
          planTasks: [plannedTask],
        });
        executionAgents = provisioning.agents;
        broadcastJoinedAgents(tools, context.room.id, provisioning.joinedAgents);
        executor = selectExecutorForPlannedChild(executionAgents, nextChild, plannedTask, tools);
      }
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
        recordEventSafely(tools, context, {
          eventType: 'workflow_blocked',
          task: nextChild,
          content: `子任务「${nextChild.title}」没有可用执行智能体，工作流已阻塞。`,
          metadata: { graph_node: 'execute', workflow_stage: 'implementation', error },
        });
        return nextState;
      }

      const inProgressChild = nextChild.status === 'in_progress' ? nextChild : tools.updateTaskStatus(nextChild.id, 'in_progress');
      if (inProgressChild) {
        tools.broadcastTaskUpdated(inProgressChild);
      }

      const prompt = buildStagePrompt('implementation', {
        projectName: context.project.name,
        projectPath: context.project.path,
        room: context.room,
        task: nextChild,
        agents: executionAgents,
        workflowContext: context.workflowContext,
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
      recordEventSafely(tools, context, {
        eventType: 'workflow_stage_changed',
        task: nextChild,
        workflowStepId: step.id,
        content: `子任务「${nextChild.title}」进入 implementation 阶段。`,
        metadata: {
          graph_node: 'execute',
          workflow_stage: 'implementation',
          room_agent_id: executor.id,
        },
      });

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
        createContextEntrySafely(tools, context, {
          task: nextChild,
          workflowStepId: step.id,
          roomAgentId: executor.id,
          agentRunId: runResult.run.id,
          sourceType: 'agent_run',
          sourceId: `${runResult.run.id}:implementation-failed`,
          entryType: 'handoff',
          title: `执行失败：${nextChild.title}`,
          content: buildImplementationHandoff(nextChild, runResult.run.stdout || runResult.message.content, error),
          rawCharCount: (runResult.run.stdout || runResult.message.content).length,
          metadata: {
            graph_node: 'execute',
            workflow_stage: 'implementation',
            status: runResult.status,
            error,
          },
        });
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
        recordEventSafely(tools, context, {
          eventType: runResult.status === 'cancelled' ? 'workflow_cancelled' : 'workflow_blocked',
          task: nextChild,
          workflowStepId: step.id,
          content: runResult.status === 'cancelled'
            ? `子任务「${nextChild.title}」执行已取消。`
            : `子任务「${nextChild.title}」执行失败：${error}`,
          metadata: {
            graph_node: 'execute',
            workflow_stage: 'implementation',
            agent_run_id: runResult.run.id,
            error,
          },
        });
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
      createContextEntrySafely(tools, context, {
        task: nextChild,
        workflowStepId: step.id,
        roomAgentId: executor.id,
        agentRunId: runResult.run.id,
        sourceType: 'agent_run',
        sourceId: `${runResult.run.id}:implementation`,
        entryType: 'handoff',
        title: `执行交接：${nextChild.title}`,
        content: buildImplementationHandoff(nextChild, runResult.run.stdout || runResult.message.content),
        rawCharCount: (runResult.run.stdout || runResult.message.content).length,
        metadata: {
          graph_node: 'execute',
          workflow_stage: 'implementation',
          status: 'completed',
          result_message_id: runResult.message.id,
        },
      });

      const reviewedChild = tools.updateTaskStatus(nextChild.id, 'review');
      if (reviewedChild) tools.broadcastTaskUpdated(reviewedChild);
      recordEventSafely(tools, context, {
        eventType: 'workflow_stage_changed',
        task: nextChild,
        workflowStepId: step.id,
        content: `子任务「${nextChild.title}」的 implementation 阶段已完成，进入 review。`,
        metadata: {
          graph_node: 'execute',
          workflow_stage: 'implementation',
          agent_run_id: runResult.run.id,
          status: 'completed',
        },
      });

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
      let reviewAgents = context.agents;
      if (!hasExecutableWorkflowRole(reviewAgents, 'reviewer')) {
        const provisioning = ensureWorkflowAgentsForRun({
          roomId: context.room.id,
          agents: reviewAgents,
          roles: ['reviewer'],
        });
        reviewAgents = provisioning.agents;
        broadcastJoinedAgents(tools, context.room.id, provisioning.joinedAgents);
      }
      const reviewer = tools.selectAgentForRole('reviewer', reviewAgents)
        ?? tools.selectAgentForRole('executor', reviewAgents);
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
        recordEventSafely(tools, context, {
          eventType: 'workflow_blocked',
          content: `任务「${context.task.title}」没有可用审查智能体，工作流已阻塞。`,
          metadata: { graph_node: 'review', workflow_stage: 'code_review', error },
        });
        return nextState;
      }

      const prompt = buildStagePrompt('code_review', {
        projectName: context.project.name,
        projectPath: context.project.path,
        room: context.room,
        task: context.task,
        agents: reviewAgents,
        workflowContext: context.workflowContext,
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
      recordEventSafely(tools, context, {
        eventType: 'workflow_stage_changed',
        workflowStepId: step.id,
        content: `任务「${context.task.title}」进入 code_review 阶段。`,
        metadata: {
          graph_node: 'review',
          workflow_stage: 'code_review',
          room_agent_id: reviewer.id,
        },
      });
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
      createContextEntrySafely(tools, context, {
        workflowStepId: step.id,
        roomAgentId: reviewer.id,
        agentRunId: runResult.run.id,
        sourceType: 'agent_run',
        sourceId: `${runResult.run.id}:review-output`,
        entryType: 'summary',
        title: '代码审查输出摘要',
        content: buildFallbackSummary(output),
        rawCharCount: output.length,
        metadata: {
          graph_node: 'review',
          workflow_stage: 'code_review',
          result_message_id: runResult.message.id,
        },
      });

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
        recordEventSafely(tools, context, {
          eventType: runResult.status === 'cancelled' ? 'workflow_cancelled' : 'workflow_blocked',
          workflowStepId: step.id,
          content: runResult.status === 'cancelled'
            ? `任务「${context.task.title}」代码审查已取消。`
            : `任务「${context.task.title}」代码审查失败：${error}`,
          metadata: {
            graph_node: 'review',
            workflow_stage: 'code_review',
            agent_run_id: runResult.run.id,
            error,
          },
        });
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
        recordEventSafely(tools, context, {
          eventType: 'workflow_blocked',
          workflowStepId: step.id,
          content: `任务「${context.task.title}」代码审查结果无法解析，工作流已阻塞。`,
          metadata: { graph_node: 'review', workflow_stage: 'code_review', agent_run_id: runResult.run.id, error },
        });
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
      createContextEntrySafely(tools, context, {
        workflowStepId: step.id,
        roomAgentId: reviewer.id,
        agentRunId: runResult.run.id,
        sourceType: 'agent_run',
        sourceId: `${runResult.run.id}:review-verdict`,
        entryType: verdict.findings.length > 0 ? 'issue' : 'summary',
        title: `代码审查结论：${verdict.verdict}`,
        content: buildReviewContext(verdict),
        rawCharCount: output.length,
        metadata: {
          graph_node: 'review',
          workflow_stage: 'code_review',
          review_verdict: verdict.verdict,
          findings_count: verdict.findings.length,
        },
      });

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
        recordEventSafely(tools, context, {
          eventType: 'workflow_blocked',
          workflowStepId: step.id,
          content: `任务「${context.task.title}」代码审查未通过。`,
          metadata: {
            graph_node: 'review',
            workflow_stage: 'code_review',
            agent_run_id: runResult.run.id,
            review_verdict: verdict.verdict,
          },
        });
        return blockedState;
      }
      recordEventSafely(tools, context, {
        eventType: 'workflow_stage_changed',
        workflowStepId: step.id,
        content: verdict.verdict === 'changes_requested'
          ? `任务「${context.task.title}」代码审查要求修改。`
          : `任务「${context.task.title}」代码审查已通过。`,
        metadata: {
          graph_node: 'review',
          workflow_stage: 'code_review',
          agent_run_id: runResult.run.id,
          review_verdict: verdict.verdict,
          findings_count: verdict.findings.length,
        },
      });

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
        recordEventSafely(tools, context, {
          eventType: 'workflow_stage_changed',
          content: `任务「${context.task.title}」根据审查意见回到 implementation 阶段。`,
          metadata: {
            graph_node: 'repair_decision',
            workflow_stage: 'implementation',
            repair_attempts: nextState.repairAttempts,
          },
        });
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
      recordEventSafely(tools, context, {
        eventType: 'workflow_blocked',
        content: `任务「${context.task.title}」修复次数达到上限，工作流已阻塞。`,
        metadata: {
          graph_node: 'repair_decision',
          workflow_stage: 'code_review',
          repair_attempts: state.repairAttempts,
          error,
        },
      });
      return nextState;
    },

    async verifyNode(state) {
      const context = tools.readWorkflowContext(state.workflowRunId);
      const commands = state.plan?.verificationCommands?.length
        ? state.plan.verificationCommands
        : (state.plan?.verification ?? []).map((command) => ({ command, reason: '', required: true }));
      const step = tools.createGraphStep({
        workflow_run_id: context.run.id,
        task_id: context.task.id,
        stage: 'code_review',
        node_name: 'verify',
        status: 'running',
        prompt: commands.length > 0 ? commands.map((command) => command.command).join('\n') : 'no verification commands',
        sort_order: tools.nextStepSortOrder(context.run.id),
      });
      tools.broadcastStepCreated(context.room.id, step);
      recordEventSafely(tools, context, {
        eventType: 'workflow_stage_changed',
        workflowStepId: step.id,
        content: `任务「${context.task.title}」进入 verify 阶段。`,
        metadata: {
          graph_node: 'verify',
          workflow_stage: 'code_review',
          command_count: commands.length,
          status: 'running',
        },
      });

      const verificationCwd = getVerificationCwd();
      const results = commands.length > 0
        ? await Promise.all(commands.map(async (command) => runVerificationCommand(command.command, verificationCwd)))
        : [{
          command: '(none)',
          status: 'skipped' as const,
          exitCode: null,
          stdout: '',
          stderr: 'No verification commands configured',
        }];

      const failedRequired = results.find((result, index) => {
        if (commands.length === 0) return false;
        return commands[index]?.required !== false && result.status !== 'passed';
      });
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
      createContextEntrySafely(tools, context, {
        workflowStepId: step.id,
        sourceType: 'verification',
        sourceId: `${step.id}:verification`,
        entryType: 'verification',
        title: blocked ? '验证失败' : '验证结果',
        content: summary,
        rawCharCount: summary.length,
        metadata: {
          graph_node: 'verify',
          workflow_stage: 'code_review',
          results,
          status: blocked ? 'failed' : 'completed',
        },
      });

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
      recordEventSafely(tools, context, {
        eventType: blocked ? 'workflow_blocked' : 'workflow_stage_changed',
        workflowStepId: step.id,
        content: blocked
          ? `任务「${context.task.title}」验证失败：${failedRequired?.command}`
          : `任务「${context.task.title}」验证已完成。`,
        metadata: {
          graph_node: 'verify',
          workflow_stage: 'code_review',
          results_count: results.length,
          failed_command: failedRequired?.command,
          status: blocked ? 'failed' : 'completed',
        },
      });

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
      let acceptanceAgents = context.agents;
      if (!hasExecutableWorkflowRole(acceptanceAgents, 'acceptor')) {
        const provisioning = ensureWorkflowAgentsForRun({
          roomId: context.room.id,
          agents: acceptanceAgents,
          roles: ['acceptor'],
        });
        acceptanceAgents = provisioning.agents;
        broadcastJoinedAgents(tools, context.room.id, provisioning.joinedAgents);
      }
      const acceptor = tools.selectAgentForRole('acceptor', acceptanceAgents)
        ?? tools.selectAgentForRole('reviewer', acceptanceAgents);
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
        recordEventSafely(tools, context, {
          eventType: 'workflow_failed',
          content: `任务「${context.task.title}」没有可用验收智能体，工作流已失败。`,
          metadata: { graph_node: 'acceptance', workflow_stage: 'acceptance', error },
        });
        return nextState;
      }

      const prompt = buildStagePrompt('acceptance', {
        projectName: context.project.name,
        projectPath: context.project.path,
        room: context.room,
        task: context.task,
        agents: acceptanceAgents,
        workflowContext: context.workflowContext,
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
      recordEventSafely(tools, context, {
        eventType: 'workflow_stage_changed',
        workflowStepId: step.id,
        content: `任务「${context.task.title}」进入 acceptance 阶段。`,
        metadata: {
          graph_node: 'acceptance',
          workflow_stage: 'acceptance',
          room_agent_id: acceptor.id,
        },
      });
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
      createContextEntrySafely(tools, context, {
        workflowStepId: step.id,
        roomAgentId: acceptor.id,
        agentRunId: runResult.run.id,
        sourceType: 'agent_run',
        sourceId: `${runResult.run.id}:acceptance-output`,
        entryType: 'summary',
        title: '验收输出摘要',
        content: buildFallbackSummary(output),
        rawCharCount: output.length,
        metadata: {
          graph_node: 'acceptance',
          workflow_stage: 'acceptance',
          result_message_id: runResult.message.id,
        },
      });

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
        recordEventSafely(tools, context, {
          eventType: runResult.status === 'cancelled' ? 'workflow_cancelled' : 'workflow_failed',
          workflowStepId: step.id,
          content: runResult.status === 'cancelled'
            ? `任务「${context.task.title}」验收已取消。`
            : `任务「${context.task.title}」验收执行失败：${error}`,
          metadata: {
            graph_node: 'acceptance',
            workflow_stage: 'acceptance',
            agent_run_id: runResult.run.id,
            error,
          },
        });
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
        recordEventSafely(tools, context, {
          eventType: 'workflow_failed',
          workflowStepId: step.id,
          content: `任务「${context.task.title}」验收结果无法解析，工作流已失败。`,
          metadata: { graph_node: 'acceptance', workflow_stage: 'acceptance', agent_run_id: runResult.run.id, error },
        });
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
      createContextEntrySafely(tools, context, {
        workflowStepId: step.id,
        roomAgentId: acceptor.id,
        agentRunId: runResult.run.id,
        sourceType: 'agent_run',
        sourceId: `${runResult.run.id}:acceptance-verdict`,
        entryType: 'summary',
        title: `验收结论：${verdict.verdict}`,
        content: buildAcceptanceContext(verdict),
        rawCharCount: output.length,
        metadata: {
          graph_node: 'acceptance',
          workflow_stage: 'acceptance',
          acceptance_verdict: verdict.verdict,
        },
      });

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
        recordEventSafely(tools, context, {
          eventType: 'workflow_completed',
          workflowStepId: step.id,
          content: `任务「${context.task.title}」已通过验收。`,
          metadata: {
            graph_node: 'acceptance',
            workflow_stage: 'acceptance',
            agent_run_id: runResult.run.id,
            acceptance_verdict: verdict.verdict,
          },
        });
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
      recordEventSafely(tools, context, {
        eventType: 'workflow_failed',
        workflowStepId: step.id,
        content: `任务「${context.task.title}」验收未通过。`,
        metadata: {
          graph_node: 'acceptance',
          workflow_stage: 'acceptance',
          agent_run_id: runResult.run.id,
          acceptance_verdict: verdict.verdict,
        },
      });
      return failedState;
    },

    async memoryNode(state) {
      const context = tools.readWorkflowContext(state.workflowRunId);
      const acceptanceArtifact = [...tools.listArtifacts(context.run.id)]
        .reverse()
        .find((artifact) => artifact.artifact_type === 'acceptance');

      if (!acceptanceArtifact) {
        console.warn(`[graph-memory] skipped task summary: missing acceptance artifact for run ${context.run.id}`);
        recordEventSafely(tools, context, {
          eventType: 'workflow_memory_written',
          content: `任务「${context.task.title}」没有验收产物，跳过记忆写入。`,
          metadata: { graph_node: 'memory', workflow_stage: 'acceptance', status: 'skipped' },
        });
      } else {
        try {
          const verdict = parseAcceptanceVerdict(acceptanceArtifact.content);
          const taskSummary = buildTaskSummaryMemoryContent(context.task.title, verdict);
          const memory = tools.upsertTaskSummaryMemory({
            project_id: context.run.project_id,
            room_id: context.run.room_id,
            task_id: context.run.task_id,
            title: `任务完成：${context.task.title}`,
            content: taskSummary,
            source_id: context.run.id,
          });
          recordEventSafely(tools, context, {
            eventType: 'workflow_memory_written',
            content: `任务「${context.task.title}」的完成摘要已写入记忆。`,
            metadata: {
              graph_node: 'memory',
              workflow_stage: 'acceptance',
              memory_id: memory.id,
              memory_type: memory.memory_type,
            },
          });
          const autoDistillEnabled = tools.resolveRoomSettings(context.room.id)?.effective.auto_distill_enabled ?? true;
          if (autoDistillEnabled) {
            const skillContext = await tools.buildSkillContext({
              runtimeScopes: ['memory'],
              projectId: context.project.id,
              roomId: context.room.id,
              message: [
                context.task.title,
                taskSummary,
                acceptanceArtifact.content,
              ].join('\n\n'),
            });
            tools.distillTask({
              projectId: context.project.id,
              roomId: context.room.id,
              taskId: context.task.id,
              taskTitle: context.task.title,
              taskSummary,
              sourceId: context.run.id,
              skillContext,
            }).catch((err) => console.warn(`[distill] graph task distill error: ${(err as Error).message}`));
          }
        } catch (err) {
          console.warn(`[graph-memory] failed to parse/write task summary: ${(err as Error).message}`);
          recordEventSafely(tools, context, {
            eventType: 'workflow_memory_written',
            content: `任务「${context.task.title}」的记忆写入失败：${(err as Error).message}`,
            metadata: {
              graph_node: 'memory',
              workflow_stage: 'acceptance',
              status: 'failed',
              error: (err as Error).message,
            },
          });
        }
      }

      const updatedRun = tools.updateRun(context.run.id, {
        status: 'completed',
        current_stage: 'acceptance',
        error: null,
      });
      if (updatedRun) tools.broadcastWorkflowUpdated(updatedRun);

      const nextState: AgentWorkflowState = {
        ...state,
        currentNode: 'memory',
        status: 'completed',
        error: null,
      };
      tools.updateGraphState(context.run.id, serializeGraphState(nextState));
      return nextState;
    },
  };
}

function recordEventSafely(
  tools: GraphTools,
  context: {
    room: { id: string };
    task: Task;
    run: { id: string };
  },
  input: {
    eventType: TaskEventType;
    content: string;
    workflowStepId?: string | null;
    task?: Task;
    metadata?: Record<string, unknown>;
  },
): void {
  const eventTask = input.task ?? context.task;
  try {
    tools.recordWorkflowEvent({
      roomId: context.room.id,
      taskId: eventTask.id,
      taskTitle: eventTask.title,
      workflowRunId: context.run.id,
      workflowStepId: input.workflowStepId ?? null,
      eventType: input.eventType,
      content: input.content,
      metadata: input.metadata,
    });
  } catch (err) {
    console.warn(`[graph-events] failed to record ${input.eventType}: ${(err as Error).message}`);
  }
}

function createContextEntrySafely(
  tools: GraphTools,
  context: {
    room: { id: string };
    task: Task;
    run: { id: string };
  },
  input: {
    workflowStepId?: string | null;
    task?: Task;
    roomAgentId?: string | null;
    agentRunId?: string | null;
    sourceType: WorkflowContextSourceType;
    sourceId: string;
    entryType: WorkflowContextEntryType;
    title: string;
    content: string;
    rawCharCount?: number;
    metadata?: Record<string, unknown>;
  },
): void {
  const task = input.task ?? context.task;
  try {
    tools.createContextEntry({
      workflow_run_id: context.run.id,
      workflow_step_id: input.workflowStepId ?? null,
      task_id: task.id,
      room_agent_id: input.roomAgentId ?? null,
      agent_run_id: input.agentRunId ?? null,
      source_type: input.sourceType,
      source_id: input.sourceId,
      entry_type: input.entryType,
      title: input.title,
      content: input.content,
      raw_char_count: input.rawCharCount ?? input.content.length,
      metadata: {
        ...(input.metadata ?? {}),
        raw_refs: {
          workflow_step_id: input.workflowStepId ?? null,
          agent_run_id: input.agentRunId ?? null,
          source_type: input.sourceType,
          source_id: input.sourceId,
        },
      },
    });
  } catch (err) {
    console.warn(`[graph-context] failed to create ${input.entryType}: ${(err as Error).message}`);
    throw err;
  }
}

function selectAssignmentHintForPlanTask(
  state: AgentWorkflowState,
  planTaskIndex: number,
  agents: Parameters<GraphTools['selectAgentForPlanTask']>[1],
  tools: GraphTools,
  resolvedAgent: ReturnType<GraphTools['selectAgentForPlanTask']>,
) {
  const planTask = state.plan?.tasks[planTaskIndex];
  if (!planTask) return null;
  const sameRoleTaskCount = state.plan?.tasks.filter((task) =>
    task.suggestedRole === planTask.suggestedRole,
  ).length ?? 0;
  if (sameRoleTaskCount !== 1) return null;
  const hint = (state.supervisorAssignments ?? []).find((assignment) =>
    assignment.stage === 'implementation' && assignment.role === planTask.suggestedRole,
  );
  const hintedAgent = hint ? tools.selectAgentForSupervisorAssignment(hint, agents) : null;
  if (!hintedAgent) return null;
  const runtimeEligibleHint = tools.selectAgentForPlanTask(planTask, [hintedAgent]);
  if (!runtimeEligibleHint) return null;
  return planTaskHasDomainMismatch(planTask, runtimeEligibleHint, resolvedAgent) ? null : runtimeEligibleHint;
}

function selectExecutorForPlannedChild(
  agents: RoomAgent[],
  child: Task,
  planTask: ParsedPlanTask | undefined,
  tools: GraphTools,
): RoomAgent | null {
  if (!planTask) return resolveWorkflowExecutor(agents, child);
  if (!child.assigned_agent_id) return tools.selectAgentForPlanTask(planTask, agents);
  const assigned = agents.find((agent) => agent.id === child.assigned_agent_id) ?? null;
  if (!assigned) return null;
  return tools.selectAgentForPlanTask(planTask, [assigned]);
}

function hasExecutableWorkflowRole(agents: RoomAgent[], role: RoomAgent['workflow_role']): boolean {
  return agents.some((agent) =>
    agent.left_at === null &&
    agent.workflow_role === role &&
    agent.acp_enabled === 1 &&
    Boolean(agent.acp_backend),
  );
}

function broadcastJoinedAgents(tools: GraphTools, roomId: string, agents: RoomAgent[]): void {
  for (const agent of agents) {
    tools.broadcastAgentJoined(roomId, agent);
  }
}

type PlanTaskDomain = 'frontend' | 'backend' | null;

function planTaskHasDomainMismatch(
  planTask: ParsedPlanTask,
  hintedAgent: RoomAgent,
  resolvedAgent: RoomAgent | null,
): boolean {
  const domain = inferPlanTaskDomain(planTask);
  if (!domain) return false;
  if (agentMatchesDomain(hintedAgent, domain)) return false;
  return Boolean(resolvedAgent && agentMatchesDomain(resolvedAgent, domain));
}

function inferPlanTaskDomain(planTask: ParsedPlanTask): PlanTaskDomain {
  const text = [
    planTask.title,
    planTask.description,
    ...planTask.scopeRead,
    ...planTask.scopeWrite,
  ].join('\n').toLowerCase();
  const frontend = countDomainSignals(text, [
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
  const backend = countDomainSignals(text, [
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

function agentMatchesDomain(agent: RoomAgent, domain: Exclude<PlanTaskDomain, null>): boolean {
  const text = [
    agent.agent_id,
    agent.agent_name,
    agent.agent_role ?? '',
    agent.responsibilities ?? '',
    ...agent.capabilities,
  ].join(' ').toLowerCase();
  return text.includes(domain);
}

function countDomainSignals(text: string, signals: string[]): number {
  return signals.reduce((count, signal) => count + (text.includes(signal) ? 1 : 0), 0);
}

function buildImplementationHandoff(task: Task, output: string, error?: string | null): string {
  return [
    `子任务：${task.title}`,
    `状态：${error ? '失败' : '完成'}`,
    error ? `错误：${error}` : null,
    '',
    '交接摘要：',
    buildFallbackSummary(output),
  ].filter((line): line is string => line !== null).join('\n');
}

function buildReviewContext(verdict: ReturnType<typeof parseReviewVerdict>): string {
  return [
    `审查结论：${verdict.verdict}`,
    `风险等级：${verdict.riskLevel}`,
    '',
    '发现：',
    verdict.findings.length > 0 ? verdict.findings.map((item) => `- ${item}`).join('\n') : '- 无',
    '',
    '必须修复：',
    verdict.requiredFixes.length > 0 ? verdict.requiredFixes.map((item) => `- ${item}`).join('\n') : '- 无',
  ].join('\n');
}

function buildAcceptanceContext(verdict: ReturnType<typeof parseAcceptanceVerdict>): string {
  return [
    `验收结论：${verdict.verdict}`,
    verdict.notes.trim() ? `说明：${verdict.notes.trim()}` : null,
    '',
    '通过标准：',
    verdict.acceptedCriteria.length > 0 ? verdict.acceptedCriteria.map((item) => `- ${item}`).join('\n') : '- 无',
    '',
    '未通过标准：',
    verdict.failedCriteria.length > 0 ? verdict.failedCriteria.map((item) => `- ${item}`).join('\n') : '- 无',
  ].filter((line): line is string => line !== null).join('\n');
}

function buildFallbackSummary(output: string): string {
  const normalized = output.trim();
  if (!normalized) return '无输出。';
  const maxChars = 1800;
  if (normalized.length <= maxChars) return normalized;
  return [
    `原始输出较长，已压缩为引用摘要。`,
    `原始字符数：${normalized.length}`,
    '完整原始输出请查看引用的 agent run 或 workflow step。',
  ].join('\n');
}
