import { Annotation, END, MemorySaver, START, StateGraph } from '@langchain/langgraph';
import { agentRunRepo } from '../../repos/agent-runs.js';
import { projectRepo } from '../../repos/projects.js';
import { roomRepo } from '../../repos/rooms.js';
import { taskRepo } from '../../repos/tasks.js';
import { workflowRepo } from '../../repos/workflows.js';
import { runRegistry } from '../../run-registry.js';
import { recordTaskEvent } from '../../task-conversation.js';
import type { WorkflowRun } from '../../types.js';
import { createGraphNodes } from './nodes.js';
import { routeAfterApproval, routeAfterExecute, routeAfterRepairDecision, routeAfterReview } from './router.js';
import { emptyAgentWorkflowState, parseGraphState, serializeGraphState, type AgentWorkflowState } from './state.js';
import { createGraphTools, type GraphRuntimeDeps } from './tools.js';

const GraphState = Annotation.Root({
  workflowRunId: Annotation<string>(),
  projectId: Annotation<string>(),
  roomId: Annotation<string>(),
  taskId: Annotation<string>(),
  userGoal: Annotation<string>(),
  projectPath: Annotation<string>(),
  plan: Annotation<AgentWorkflowState['plan']>(),
  currentNode: Annotation<AgentWorkflowState['currentNode']>(),
  currentStepId: Annotation<string | null>(),
  activeAgentRunId: Annotation<string | null>(),
  childTaskIds: Annotation<string[]>(),
  reviewFindings: Annotation<string[]>(),
  reviewVerdict: Annotation<AgentWorkflowState['reviewVerdict']>(),
  verificationResults: Annotation<AgentWorkflowState['verificationResults']>(),
  repairAttempts: Annotation<number>(),
  approval: Annotation<AgentWorkflowState['approval']>(),
  status: Annotation<AgentWorkflowState['status']>(),
  error: Annotation<string | null>(),
});

function requireTaskContext(taskId: string) {
  const task = taskRepo.get(taskId);
  if (!task) throw new Error('task not found');
  const room = roomRepo.get(task.room_id);
  const project = projectRepo.get(task.project_id);
  if (!room || !project) throw new Error('workflow context is incomplete');
  return { task, room, project };
}

function buildRuntimeGraph(deps: GraphRuntimeDeps = {}) {
  const tools = createGraphTools(deps);
  const nodes = createGraphNodes(tools);

  return new StateGraph(GraphState)
    .addNode('context', nodes.contextNode)
    .addNode('planning', nodes.planningNode)
    .addNode('approval_gate', nodes.approvalNode)
    .addNode('dispatch', nodes.dispatchNode)
    .addNode('execute', nodes.executeNode)
    .addNode('review', nodes.reviewNode)
    .addNode('repair_decision', nodes.repairDecisionNode)
    .addNode('verify', nodes.verifyNode)
    .addNode('acceptance', nodes.acceptanceNode)
    .addNode('memory', nodes.memoryNode)
    .addEdge(START, 'context')
    .addEdge('context', 'planning')
    .addEdge('planning', 'approval_gate')
    .addConditionalEdges('approval_gate', routeAfterApproval)
    .addEdge('dispatch', 'execute')
    .addConditionalEdges('execute', routeAfterExecute)
    .addConditionalEdges('review', routeAfterReview)
    .addConditionalEdges('repair_decision', routeAfterRepairDecision)
    .addConditionalEdges('verify', (state) => {
      if (state.status === 'blocked' || state.status === 'cancelled' || state.status === 'failed') return END;
      return 'acceptance';
    })
    .addConditionalEdges('acceptance', (state) => {
      if (state.status === 'completed') return 'memory';
      return END;
    })
    .addEdge('memory', END)
    .compile({ checkpointer: new MemorySaver() });
}

export async function startGraphWorkflow(taskId: string, deps: GraphRuntimeDeps = {}): Promise<WorkflowRun> {
  const run = createGraphWorkflowRun(taskId);
  recordWorkflowStartedEvent(run);
  return continueGraphWorkflow(run.id, deps);
}

export function createGraphWorkflowRun(taskId: string): WorkflowRun {
  const { task, room, project } = requireTaskContext(taskId);
  const existing = workflowRepo.getActiveByTask(task.id);
  if (existing) throw new Error('task already has an active workflow');

  const pendingState = emptyAgentWorkflowState({
    workflowRunId: 'pending',
    projectId: project.id,
    roomId: room.id,
    taskId: task.id,
    userGoal: task.title,
    projectPath: project.path,
  });

  const run = workflowRepo.createRun({
    room_id: room.id,
    project_id: project.id,
    task_id: task.id,
    status: 'running',
    current_stage: 'planning',
    approval_required: true,
    graph_version: 'phase-b-v1',
    graph_state: serializeGraphState(pendingState),
  });

  const initialState: AgentWorkflowState = {
    ...pendingState,
    workflowRunId: run.id,
  };
  workflowRepo.updateGraphState(run.id, serializeGraphState(initialState));
  return workflowRepo.getRun(run.id) ?? run;
}

export function enqueueGraphWorkflow(runId: string, deps: GraphRuntimeDeps = {}): void {
  setImmediate(() => {
    void continueGraphWorkflow(runId, deps).catch((err) => {
      handleBackgroundGraphWorkflowError(runId, err);
    });
  });
}

export async function continueGraphWorkflow(runId: string, deps: GraphRuntimeDeps = {}): Promise<WorkflowRun> {
  let state: AgentWorkflowState | null = null;
  try {
    const run = requireGraphRun(runId);
    state = requireGraphStateOrBlock(run);
    const finalState = await resumeGraphWorkflowFromState(state, deps);
    workflowRepo.updateGraphState(run.id, serializeGraphState(finalState));
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const latest = workflowRepo.getRun(runId);
    const parsed = latest ? tryParseGraphState(latest) : null;
    const fallbackState = parsed?.ok ? parsed.state : null;
    const failedState = blockGraphWorkflowRun(runId, fallbackState ?? state, error);
    if (failedState) workflowRepo.updateGraphState(runId, serializeGraphState(failedState));
    const blocked = workflowRepo.getRun(runId);
    if (blocked) createGraphTools(deps).broadcastWorkflowUpdated(blocked);
    throw err;
  }

  const latest = workflowRepo.getRun(runId);
  if (!latest) throw new Error('workflow not found');
  return latest;
}

export function approveGraphWorkflowPlan(id: string, approvedBy = 'user'): WorkflowRun {
  const run = validateGraphWorkflowApproval(id);
  const state = requireGraphStateOrBlock(run);
  const approvedState: AgentWorkflowState = {
    ...state,
    approval: 'approved',
    status: 'running',
    error: null,
  };
  const updated = workflowRepo.updateRun(run.id, {
    status: 'running',
    approved_by: approvedBy,
    error: null,
  });
  if (!updated) throw new Error('workflow not found');
  workflowRepo.updateGraphState(run.id, serializeGraphState(approvedState));
  const task = taskRepo.get(run.task_id);
  if (task) {
    try {
      recordTaskEvent({
        roomId: run.room_id,
        taskId: task.id,
        taskTitle: task.title,
        workflowRunId: run.id,
        eventType: 'workflow_stage_changed',
        content: `已批准任务「${task.title}」的执行计划，继续分配和执行。`,
        metadata: {
          graph_node: 'approval',
          workflow_stage: 'planning',
          approval_status: 'accepted',
          approved_by: approvedBy,
        },
      });
    } catch (err) {
      console.warn(`[graph-runtime] failed to record approval event: ${(err as Error).message}`);
    }
  }
  return workflowRepo.getRun(run.id) ?? updated;
}

export function validateGraphWorkflowApproval(id: string): WorkflowRun {
  const run = requireGraphRun(id);
  if (run.status !== 'awaiting_approval') throw new Error('workflow is not awaiting approval');
  requireGraphStateOrBlock(run);
  return run;
}

export async function approveGraphWorkflow(
  id: string,
  approvedBy = 'user',
  deps: GraphRuntimeDeps = {},
): Promise<WorkflowRun> {
  const run = approveGraphWorkflowPlan(id, approvedBy);
  return continueGraphWorkflow(run.id, deps);
}

export async function retryGraphWorkflow(id: string, deps: GraphRuntimeDeps = {}): Promise<WorkflowRun> {
  const run = requireGraphRun(id);
  if (run.status === 'running' || run.status === 'awaiting_approval') {
    throw new Error('workflow is already running');
  }
  if (agentRunRepo.listActiveByWorkflow(run.id).length > 0) {
    throw new Error('workflow already has an active agent run');
  }
  const state = requireGraphStateOrBlock(run);
  const tools = createGraphTools(deps);
  const retryState: AgentWorkflowState = {
    ...state,
    currentNode: retryCurrentNode(state),
    currentStepId: null,
    status: 'running',
    error: null,
    activeAgentRunId: null,
  };
  for (const child of taskRepo.listChildren(run.task_id).filter((item) =>
    state.childTaskIds.includes(item.id) && (item.status === 'failed' || item.status === 'in_progress'),
  )) {
    const resetChild = taskRepo.updateStatus(child.id, 'todo');
    if (resetChild) tools.broadcastTaskUpdated(resetChild);
  }
  for (const step of workflowRepo.listSteps(run.id).filter((item) =>
    item.node_name && (item.status === 'running' || item.status === 'failed' || item.status === 'cancelled' || item.status === 'interrupted'),
  )) {
    workflowRepo.updateStep(step.id, {
      status: 'skipped',
      error: step.error ?? 'Superseded by retry',
    });
  }
  workflowRepo.updateRun(run.id, {
    status: 'running',
    error: null,
  });
  workflowRepo.updateGraphState(run.id, serializeGraphState(retryState));

  const finalState = await resumeGraphWorkflowFromState(retryState, deps);
  workflowRepo.updateGraphState(run.id, serializeGraphState(finalState));
  const latest = workflowRepo.getRun(run.id);
  if (!latest) throw new Error('workflow not found');
  return latest;
}

export async function cancelGraphWorkflow(id: string): Promise<WorkflowRun> {
  const run = requireGraphRun(id);
  const tools = createGraphTools();
  for (const agentRun of tools.listActiveAgentRunsByWorkflow(run.id)) {
    runRegistry.cancel(agentRun.id);
    const cancelledRun = agentRunRepo.updateStatus(agentRun.id, 'cancelled', { error: 'Workflow cancelled' });
    if (cancelledRun) tools.broadcastAgentRunUpdated(run.room_id, cancelledRun);
  }
  for (const step of workflowRepo.listSteps(run.id).filter((item) => item.status === 'running')) {
    const cancelledStep = workflowRepo.updateStep(step.id, {
      status: 'cancelled',
      error: 'Workflow cancelled',
    });
    if (cancelledStep) tools.broadcastStepUpdated(run.room_id, cancelledStep);
  }
  const updated = workflowRepo.updateRun(run.id, {
    status: 'cancelled',
    error: null,
  });
  if (!updated) throw new Error('workflow not found');
  const state = tryParseGraphState(run);
  if (state.ok && state.state) {
    workflowRepo.updateGraphState(run.id, serializeGraphState({
      ...state.state,
      status: 'cancelled',
      error: null,
    }));
  }
  const latest = workflowRepo.getRun(run.id);
  if (!latest) throw new Error('workflow not found');
  tools.broadcastWorkflowUpdated(latest);
  const task = taskRepo.get(latest.task_id);
  if (task) {
    try {
      recordTaskEvent({
        roomId: latest.room_id,
        taskId: task.id,
        taskTitle: task.title,
        workflowRunId: latest.id,
        eventType: 'workflow_cancelled',
        content: `任务「${task.title}」的工作流已取消。`,
        metadata: {
          graph_node: 'cancel',
          workflow_stage: latest.current_stage,
        },
      });
    } catch (err) {
      console.warn(`[graph-runtime] failed to record cancellation event: ${(err as Error).message}`);
    }
  }
  return latest;
}

function blockGraphWorkflowRun(
  runId: string,
  state: AgentWorkflowState | null,
  error: string,
): AgentWorkflowState | null {
  const run = workflowRepo.updateRun(runId, {
    status: 'blocked',
    error,
  });
  for (const step of workflowRepo.listSteps(runId).filter((item) => item.status === 'running')) {
    workflowRepo.updateStep(step.id, {
      status: 'failed',
      error,
    });
  }
  if (!state) return null;
  return {
    ...state,
    workflowRunId: run?.id ?? runId,
    status: 'blocked',
    error,
  };
}

function recordWorkflowStartedEvent(run: WorkflowRun): void {
  const task = taskRepo.get(run.task_id);
  if (!task) return;
  try {
    recordTaskEvent({
      roomId: run.room_id,
      taskId: task.id,
      taskTitle: task.title,
      workflowRunId: run.id,
      eventType: 'workflow_started',
      content: `工作流已启动，进入 ${run.current_stage ?? 'planning'} 阶段。`,
      metadata: {
        graph_node: 'start',
        workflow_stage: run.current_stage ?? 'planning',
      },
    });
  } catch (err) {
    console.warn(`[graph-runtime] failed to record workflow start: ${(err as Error).message}`);
  }
}

function handleBackgroundGraphWorkflowError(runId: string, err: unknown): void {
  const error = err instanceof Error ? err.message : String(err);
  const run = workflowRepo.getRun(runId);
  if (!run) return;
  const parsed = tryParseGraphState(run);
  const failedState = blockGraphWorkflowRun(runId, parsed.ok ? parsed.state : null, error);
  if (failedState) workflowRepo.updateGraphState(runId, serializeGraphState(failedState));

  const latest = workflowRepo.getRun(runId) ?? run;
  const task = taskRepo.get(latest.task_id);
  if (!task) return;
  try {
    recordTaskEvent({
      roomId: latest.room_id,
      taskId: task.id,
      taskTitle: task.title,
      workflowRunId: latest.id,
      eventType: 'workflow_failed',
      content: `工作流后台推进失败：${error}`,
    });
  } catch (recordErr) {
    console.warn(`[graph-runtime] failed to record background failure: ${(recordErr as Error).message}`);
  }
}

export function recoverGraphWorkflow(error: string): number {
  const tools = createGraphTools();
  let count = 0;
  for (const step of tools.listRunningSteps()) {
    const run = tools.getRun(step.workflow_run_id);
    if (!step.node_name && !run?.graph_version) continue;
    if (!run || run.status === 'cancelled' || run.status === 'completed') continue;

    for (const activeRun of tools.listActiveAgentRunsByWorkflow(run.id)) {
      const interruptedRun = tools.interruptAgentRun(activeRun.id, error);
      if (interruptedRun) tools.broadcastAgentRunUpdated(run.room_id, interruptedRun);
    }

    const interruptedStep = tools.updateGraphStep(step.id, { status: 'interrupted', error });
    if (interruptedStep) tools.broadcastStepUpdated(run.room_id, interruptedStep);

    const blockedRun = tools.updateRun(run.id, { status: 'blocked', error });
    try {
      const parsedState = tools.parseGraphState(run.graph_state);
      if (parsedState) {
        const nextState = {
          ...parsedState,
          currentNode: step.node_name ?? parsedState.currentNode,
          currentStepId: step.id,
          status: 'blocked' as const,
          error,
        };
        tools.updateGraphState(run.id, serializeGraphState(nextState));
      }
    } catch (err) {
      console.warn(`[graph-recovery] invalid graph_state for run ${run.id}: ${(err as Error).message}`);
    }

    if (blockedRun) tools.broadcastWorkflowUpdated(blockedRun);
    count += 1;
  }
  return count;
}

function requireGraphRun(id: string): WorkflowRun {
  const run = workflowRepo.getRun(id);
  if (!run) throw new Error('workflow not found');
  if (!run.graph_version) throw new Error('workflow is not a graph workflow');
  return run;
}

function requireGraphState(run: WorkflowRun): AgentWorkflowState {
  const state = parseGraphState(run.graph_state);
  if (!state) throw new Error('workflow has no graph state');
  return state;
}

function requireGraphStateOrBlock(run: WorkflowRun): AgentWorkflowState {
  const state = tryParseGraphState(run);
  if (!state.ok) {
    const error = `graph state is invalid: ${state.error}`;
    workflowRepo.updateRun(run.id, {
      status: 'blocked',
      error,
    });
    throw new Error(error);
  }
  if (!state.state) {
    const error = 'graph state is invalid: workflow has no graph state';
    workflowRepo.updateRun(run.id, {
      status: 'blocked',
      error,
    });
    throw new Error(error);
  }
  return state.state;
}

function tryParseGraphState(run: WorkflowRun): { ok: true; state: AgentWorkflowState | null } | { ok: false; error: string } {
  try {
    return { ok: true, state: parseGraphState(run.graph_state) };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function retryCurrentNode(state: AgentWorkflowState): AgentWorkflowState['currentNode'] {
  if (state.currentNode === 'execute') return 'dispatch';
  if (state.currentNode === 'review') return 'dispatch';
  if (state.currentNode === 'repair_decision') return 'review';
  if (state.currentNode === 'verify') return 'dispatch';
  if (state.currentNode === 'acceptance') return 'dispatch';
  return state.currentNode;
}

async function resumeGraphWorkflowFromState(
  state: AgentWorkflowState,
  deps: GraphRuntimeDeps,
): Promise<AgentWorkflowState> {
  const tools = createGraphTools(deps);
  const nodes = createGraphNodes(tools);
  let nextState = state;
  let nodeToRun = nextNodeAfter(null, nextState);

  for (let iteration = 0; iteration < 20; iteration += 1) {
    if (!nodeToRun || isTerminalResumeState(nextState)) {
      return nextState;
    }

    if (nodeToRun === 'context') {
      nextState = await nodes.contextNode(nextState);
    } else if (nodeToRun === 'planning') {
      nextState = await nodes.planningNode(nextState);
    } else if (nodeToRun === 'approval') {
      nextState = await nodes.approvalNode(nextState);
    } else if (nodeToRun === 'dispatch') {
      nextState = await nodes.dispatchNode(nextState);
    } else if (nodeToRun === 'execute') {
      nextState = await nodes.executeNode(nextState);
    } else if (nodeToRun === 'review') {
      nextState = await nodes.reviewNode(nextState);
    } else if (nodeToRun === 'repair_decision') {
      nextState = await nodes.repairDecisionNode(nextState);
    } else if (nodeToRun === 'verify') {
      nextState = await nodes.verifyNode(nextState);
    } else if (nodeToRun === 'acceptance') {
      nextState = await nodes.acceptanceNode(nextState);
    } else if (nodeToRun === 'memory') {
      nextState = await nodes.memoryNode(nextState);
    }
    nodeToRun = nextNodeAfter(nodeToRun, nextState);
  }

  throw new Error('graph retry exceeded resume limit');
}

function isTerminalResumeState(state: AgentWorkflowState): boolean {
  return (
    state.status === 'awaiting_approval' ||
    state.status === 'awaiting_decision' ||
    state.status === 'blocked' ||
    state.status === 'cancelled' ||
    state.status === 'failed'
  );
}

function nextNodeAfter(
  nodeJustRun: AgentWorkflowState['currentNode'] | null,
  state: AgentWorkflowState,
): AgentWorkflowState['currentNode'] | null {
  if (isTerminalResumeState(state)) return null;
  const node = nodeJustRun ?? state.currentNode;
  if (!node) return 'context';
  if (node === 'context') return 'planning';
  if (node === 'planning') return 'approval';
  if (node === 'approval') {
    const route = routeAfterApproval(state);
    return route === END ? null : route;
  }
  if (node === 'dispatch') return 'execute';
  if (node === 'execute') {
    const route = routeAfterExecute(state);
    return route === END ? null : route;
  }
  if (node === 'review') {
    const route = routeAfterReview(state);
    return route === END ? null : route;
  }
  if (node === 'repair_decision') {
    const route = routeAfterRepairDecision(state);
    return route === END ? null : route;
  }
  if (node === 'verify') return 'acceptance';
  if (node === 'acceptance') return state.status === 'completed' ? 'memory' : null;
  if (node === 'memory') return null;
  return null;
}
